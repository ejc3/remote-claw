import { decodeFrame, encodeFrame, timingSafeEqual, WireError } from "@remote-claw/clawsec";
import { resumeHook } from "workflow/api";
import { AuthError, identityFromRequest } from "../../../lib/auth";
import { channelToken, ensureChannel } from "../../../lib/channel";
import { json } from "../../../lib/http";

// §3.2 POST /api/relay — publish ONE ciphertext frame. Resume-or-start the channel run (bus, or
// per-session with ?session=<sid>) and resumeHook(token, frame). Gated by Bearer auth_token;
// ciphertext only — the broker validates the §8 envelope SHAPE but never decrypts it.
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

  const { runId, created } = await ensureChannel(token);
  // The run can complete/dispose between ensureChannel resolving and this resume (a concurrent
  // __close or cap-roll) -> resumeHook throws. Report 409, not 500; the client retries.
  try {
    await resumeHook(token, encodeFrame(frame));
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e), runId, created }, 409);
  }
  return json({ ok: true, channel: sessionId === null ? "bus" : "session", runId, created });
}
