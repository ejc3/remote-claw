import { decodeFrame, encodeFrame, timingSafeEqual, WireError } from "@remote-claw/clawsec";
import { AuthError, identityFromRequest } from "../../../lib/auth";
import { backendSelector, getBackend, isRequestableBackend } from "../../../lib/broker";
import { isClose, PublishConflictError } from "../../../lib/broker/backend";
import { channelToken } from "../../../lib/channel";
import { json } from "../../../lib/http";

// §3.2 POST /api/relay — publish ONE ciphertext frame. Resume-or-start the channel (bus, or
// per-session with ?session=<sid>) and deliver the frame via the selected backend. Gated by Bearer
// auth_token; ciphertext only — the broker validates the §8 envelope SHAPE but never decrypts it.
export const maxDuration = 60;

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
  // Generation-race guard: Turso channel `gen` bumps only when a backend caller publishes the
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
  // The identity BUS carries ONLY session_announce broadcasts (§6A) — keep high-volume turn/content
  // frames on per-session streams, else they'd burn the bus run's event cap (§12). record_kind is in
  // the cleartext header, so the broker can enforce this without reading the ciphertext.
  if (sessionId === null && frame.recordKind !== "session_announce") {
    return json(
      { error: "the bus accepts only session_announce frames; use ?session for the rest" },
      400,
    );
  }

  let token: string;
  try {
    token = channelToken(identityId, sessionId);
  } catch (e) {
    // sessionToken rejects an empty/control-char session id.
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }

  // Per-request backend selection: the `x-broker-backend` header (API calls) or `?backend=` query
  // param (browser URLs) — same meaning; default vercel. Resolve before publishing so a bad name is a
  // clean 400, not a 500, and the publish try below only owns the publish itself.
  const requested = backendSelector(req, url);
  if (requested !== null && !isRequestableBackend(requested)) {
    return json({ error: `backend "${requested}" is not selectable on this deployment` }, 400);
  }
  const backend = await getBackend(requested);

  // Resume-or-start the channel and deliver the frame. A PublishConflictError means the channel
  // disposed between resolve and deliver (a concurrent __close or cap-roll) -> 409, and the client
  // re-posts the same frame (a dropped delivery would strand a subscriber's ordered stream on a gap).
  // Any OTHER failure (the channel never came up) propagates -> 500, so the client fails fast on a
  // hard outage instead of retry-looping it (the host only retries 409).
  let result: { created: boolean; channelId: string };
  try {
    result = await backend.publish(token, encodeFrame(frame));
  } catch (e) {
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
