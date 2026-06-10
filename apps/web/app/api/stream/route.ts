import { AuthError, identityFromRequest } from "../../../lib/auth";
import { backendSelector, getBackend, isRequestableBackend } from "../../../lib/broker";
import { channelToken } from "../../../lib/channel";
import { json, sseEmptyResponse, sseResponse } from "../../../lib/http";

// §3.2 GET /api/stream — subscribe to a channel as Server-Sent Events. Resolves the derived token
// (bus, or per-session with ?session=<sid>) to its run's durable out-stream and pipes frames back;
// resume by ?startIndex (negative = recent window, §6B). HookNotFound ⇒ nothing connected ⇒ a 200
// empty event-stream, so an offline/absent identity is indistinguishable from a silent one.
export const maxDuration = 300;

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

  // parseInt("abc") is NaN, and getReadable({startIndex: NaN}) is invalid — reject up front.
  const startIndexParam = url.searchParams.get("startIndex");
  let startIndex: number | undefined;
  if (startIndexParam !== null) {
    startIndex = Number.parseInt(startIndexParam, 10);
    if (Number.isNaN(startIndex)) return json({ error: "startIndex must be an integer" }, 400);
  }

  let token: string;
  try {
    token = channelToken(identityId, sessionId);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }

  // Per-request backend selection: the `x-broker-backend` header or `?backend=` (default vercel). The
  // publish for this channel must name the SAME backend — the client sends the selector on both.
  const requested = backendSelector(req, url);
  if (requested !== null && !isRequestableBackend(requested)) {
    return json({ error: `backend "${requested}" is not selectable on this deployment` }, 400);
  }

  const backend = await getBackend(requested);
  const stream = await backend.subscribe(token, startIndex);
  if (stream === null) return sseEmptyResponse();
  return sseResponse(stream);
}
