import { AuthError, identityFromRequest } from "../../../lib/auth";
import { backendSelector, getBackend, isRequestableBackend } from "../../../lib/broker";
import { channelToken } from "../../../lib/channel";
import { json } from "../../../lib/http";

// §6B GET /api/seq — the highest transcript `seq` the durable log holds for this channel (per-session
// with ?session=<sid>, else the bus), or null. A host that RESTARTS a session resumes `seq = max + 1`
// so its new frames don't collide with the durable ones (#36); it holds NO store creds, so the broker
// reads MAX(seq) — a §8 CLEARTEXT routing column — and never decrypts. Backends with no durable log
// (no maxSeq) return null ⇒ the host starts fresh at 0 (their old frames have rolled off). Like the
// other routes, the per-request backend selector must be one this deployment allows.
export async function GET(req: Request): Promise<Response> {
  let identityId: Uint8Array;
  try {
    identityId = await identityFromRequest(req);
  } catch (e) {
    if (AuthError.is(e)) return json({ error: e.message }, e.status);
    throw e;
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session"); // null -> the identity bus

  let token: string;
  try {
    token = channelToken(identityId, sessionId);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }

  const requested = backendSelector(req, url);
  if (requested !== null && !isRequestableBackend(requested)) {
    return json({ error: `backend "${requested}" is not selectable on this deployment` }, 400);
  }

  const backend = await getBackend(requested);
  const durable = Boolean(backend.maxSeq);
  const maxSeq = backend.maxSeq ? await backend.maxSeq(token) : null;
  return json({ maxSeq, durable });
}
