import { AuthError, identityFromRequest } from "../../../lib/auth";
import { backendSelector, getBackend, isRequestableBackend } from "../../../lib/broker";
import { hasDurableRecovery } from "../../../lib/broker/backend";
import { channelToken } from "../../../lib/channel";
import { json } from "../../../lib/http";

// §6B GET /api/frame-count — the current publish-order stream length for this channel (per-session
// with ?session=<sid>, else the bus), or null. Unlike /api/seq, this cursor counts every durable frame
// row, so a restarted host can subscribe from this `startIndex` and skip all pre-incarnation inbound
// actions without confusing transcript seq with broker stream offsets.
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
  const durable = hasDurableRecovery(backend);
  const frameCount = durable ? await backend.frameCount(token) : null;
  return json({ frameCount, durable });
}
