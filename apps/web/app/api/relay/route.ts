import { decodeFrame, encodeFrame, timingSafeEqual, WireError } from "@remote-claw/clawsec";
import { AuthError, identityFromRequest } from "../../../lib/auth";
import { backendSelector, getBackend, isRequestableBackend } from "../../../lib/broker";
import { isClose, PublishCollisionError, PublishConflictError } from "../../../lib/broker/backend";
import { ChannelStorageLossError } from "../../../lib/broker/sqlite-multi";
import { channelToken } from "../../../lib/channel";
import { json } from "../../../lib/http";

// §3.2 POST /api/relay — publish ONE ciphertext frame. Resume-or-start the channel (bus, or
// per-session with ?session=<sid>) and deliver the frame via the selected backend. Gated by Bearer
// auth_token; ciphertext only — the broker validates the §8 envelope SHAPE but never decrypts it.
export const maxDuration = 60;

// Vercel serverless functions reject a request body over ~4.5 MB at the platform EDGE
// (FUNCTION_PAYLOAD_TOO_LARGE) before the function ever runs — and on the client that platform
// rejection surfaces as a generic fetch failure ("Load failed" on WebKit), not a readable 413. So a
// 17 MiB app-level cap was a fiction on Vercel: oversize frames died confusingly upstream of us. Cap so
// the SERIALIZED body stays under the platform limit, making an oversize frame a deterministic 413 from
// THIS route (a real, mappable error) instead. The cap is on `frame.ct` DECODED bytes, but the wire
// body carries ct as base64url (≈ 4/3×) plus a small JSON envelope, so the body ≈ ct.length × 4/3. At
// 3.3 MB decoded that's a ~4.4 MB body — under the platform limit — while still admitting every
// legitimate frame: both the host's outbound messages AND the viewer's inbound attachments are chunked
// to ≤3 MB plaintext per frame (postMessage) ⇒ ~3,000,016-byte ct, under this cap. (A higher cap like
// 4.4 MB decoded would be a ~5.9 MB body — over the edge limit — so the 413 would never fire for the very
// range it targets.)
export const MAX_RELAY_CIPHERTEXT_BYTES = 3_300_000;

const BUS_RECORD_KINDS = new Set(["session_announce", "session_terminal"]);

/** The broker cannot inspect terminal plaintext, but it can pin every AAD-authenticated clear header
 * field. That leaves exactly one canonical terminal operation per (identity, session): the body is
 * specified by the producer contract as the exact UTF-8 bytes `{"v":1}` sealed under K_meta. */
function terminalHeaderIsCanonical(frame: ReturnType<typeof decodeFrame>): boolean {
  return (
    frame.v === 1 &&
    frame.sessionId.length > 0 &&
    frame.dir === "out" &&
    frame.seq === null &&
    frame.msgId === `terminal-${frame.sessionId}` &&
    frame.clientMsgId === undefined &&
    frame.keyEpoch === 0 &&
    frame.part === 0 &&
    frame.parts === 1
  );
}

export async function POST(req: Request): Promise<Response> {
  let identityId: Uint8Array;
  try {
    identityId = await identityFromRequest(req);
  } catch (e) {
    if (AuthError.is(e)) return json({ error: e.message }, e.status);
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  let frame: ReturnType<typeof decodeFrame>;
  try {
    frame = decodeFrame(body);
  } catch (e) {
    if (WireError.is(e)) return json({ error: e.message }, 400);
    throw e;
  }
  if (frame.ct.length >= MAX_RELAY_CIPHERTEXT_BYTES) {
    return json({ error: "frame ciphertext exceeds the relay size cap" }, 413);
  }
  // Generation-race guard: the sqlite channel's `gen` bumps only when a backend caller publishes the
  // internal `__close` sentinel and a later publish reopens the token. The public relay route must
  // never accept that sentinel, so a host restart's maxSeq/frameCount/subscribe window cannot cross
  // a close+reopen on this HTTP surface.
  if (isClose(frame as unknown as { __close: true })) {
    return json({ error: "close sentinel is not accepted by /api/relay" }, 400);
  }

  // The frame must claim the AUTHENTICATED identity — a bearer for identity A can't publish a frame
  // labelled identity B (constant-time, though both ids are public — keeps the path uniform).
  if (!timingSafeEqual(frame.identityId, identityId)) {
    return json({ error: "frame identity_id does not match the bearer" }, 403);
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session"); // null -> the identity bus
  // A per-session publish must name the same session inside the frame (no cross-session smuggling).
  if (sessionId !== null && frame.sessionId !== sessionId) {
    return json({ error: "frame session_id does not match ?session" }, 400);
  }
  // The identity BUS carries ONLY the two presence-lifecycle records (§6A) — keep high-volume
  // turn/content frames on per-session streams, else they'd burn the bus run's event cap (§12).
  // record_kind and the terminal's canonical operation coordinates are AAD-bound clear header fields,
  // so the broker can enforce this without reading the ciphertext.
  if (sessionId === null && !BUS_RECORD_KINDS.has(frame.recordKind)) {
    return json(
      {
        error:
          "the bus accepts only session_announce or session_terminal frames; use ?session for the rest",
      },
      400,
    );
  }
  if (sessionId !== null && BUS_RECORD_KINDS.has(frame.recordKind)) {
    return json({ error: "presence lifecycle frames must use the identity bus" }, 400);
  }
  if (frame.recordKind === "session_terminal" && !terminalHeaderIsCanonical(frame)) {
    return json({ error: "session_terminal header is not canonical" }, 400);
  }

  let token: string;
  try {
    token = channelToken(identityId, sessionId);
  } catch (e) {
    // sessionToken rejects an empty/control-char session id.
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }

  // Per-request backend selection: the `x-broker-backend` header (API calls) or `?backend=` query
  // param (browser URLs) — same meaning; unset code fallback is vercel, while supported production
  // configures sqlite. Resolve before publishing so a bad name is a clean 400, not a 500, and the
  // publish try below only owns the publish itself.
  const requested = backendSelector(req, url);
  if (requested !== null && !isRequestableBackend(requested)) {
    return json({ error: `backend "${requested}" is not selectable on this deployment` }, 400);
  }
  const backend = await getBackend(requested);

  // Resume-or-start the channel and deliver the frame. VercelBackend emits PublishConflictError only
  // for Workflow's typed HookNotFound race after resolution (concurrent close/replacement) -> 409,
  // and the client may re-post the same frame. SQLite emits PublishCollisionError when the coordinate
  // exists with changed bytes -> hard 422. Serialization, event-store, queue, and other publish failures
  // propagate -> 500 rather than being mislabeled as a retryable channel race.
  let result: { created: boolean; channelId: string };
  try {
    result = await backend.publish(token, encodeFrame(frame));
  } catch (e) {
    if (e instanceof ChannelStorageLossError) {
      // This stable, content-free disposition is the only permanent-loss signal the host treats as
      // fatal for identity presence. Never include the token, database name, or provider response.
      return json(
        {
          ok: false,
          code: "channel_storage_lost",
          error: "permanent channel storage loss",
        },
        410,
      );
    }
    if (PublishCollisionError.is(e)) {
      // A changed replay is a hard semantic collision, never the retryable channel-turnover 409.
      return json({ ok: false, error: e.message }, 422);
    }
    if (PublishConflictError.is(e)) {
      return json({ ok: false, error: String((e as Error)?.message ?? e) }, 409);
    }
    throw e;
  }
  return json({
    ok: true,
    channel: sessionId === null ? "bus" : "session",
    runId: result.channelId,
    created: result.created,
  });
}
