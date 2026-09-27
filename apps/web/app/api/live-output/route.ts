import { decodeFrame, encodeFrame, timingSafeEqual } from "@remote-claw/clawsec";
import {
  isLiveHeader,
  LIVE_OUTPUT_PLAINTEXT_LIMIT,
  LIVE_OUTPUT_WIRE_LIMIT,
  readLiveBody,
} from "@remote-claw/cli/broker";
import { AuthError, identityFromRequest } from "../../../lib/auth";
import { backendSelector, getBackend, isRequestableBackend } from "../../../lib/broker";
import { PublishCollisionError } from "../../../lib/broker/backend";
import { channelToken } from "../../../lib/channel";

export const dynamic = "force-dynamic";
export const maxDuration = 10;
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "cdn-cache-control": "no-store" },
  });

/** Bearer is identity admission, NOT a host-only credential. Preview data grants no authority. */
async function handle(req: Request, write: boolean): Promise<Response> {
  try {
    const identity = await identityFromRequest(req);
    const url = new URL(req.url);
    const session = url.searchParams.get("session");
    if (!session) return reply({ error: "session required" }, 400);
    let token: string;
    try {
      token = channelToken(identity, session);
    } catch {
      return reply({ error: "invalid session" }, 400);
    }
    const selected = backendSelector(req, url);
    if (selected !== null && !isRequestableBackend(selected))
      return reply({ error: "invalid backend" }, 400);
    const backend = await getBackend(selected);
    if (!backend.putLiveOutput || !backend.getLiveOutput)
      return reply({ error: "unsupported" }, 501);
    if (!write) return reply({ frame: await backend.getLiveOutput(token) });
    let frame: ReturnType<typeof decodeFrame>;
    try {
      const text = await readLiveBody(req.body);
      if (text === null) return reply({ error: "preview too large" }, 413);
      frame = decodeFrame(JSON.parse(text));
    } catch {
      return reply({ error: "invalid preview" }, 400);
    }
    if (!timingSafeEqual(frame.identityId, identity))
      return reply({ error: "identity mismatch" }, 403);
    if (frame.sessionId !== session || !isLiveHeader(frame))
      return reply({ error: "invalid preview" }, 400);
    if (
      frame.ct.length > LIVE_OUTPUT_PLAINTEXT_LIMIT + 16 ||
      new TextEncoder().encode(JSON.stringify(encodeFrame(frame))).length > LIVE_OUTPUT_WIRE_LIMIT
    )
      return reply({ error: "preview too large" }, 413);
    return reply({ stored: await backend.putLiveOutput(token, encodeFrame(frame)) });
  } catch (error) {
    if (AuthError.is(error)) return reply({ error: error.message }, error.status);
    if (PublishCollisionError.is(error)) return reply({ error: "preview collision" }, 422);
    return reply({ error: "preview unavailable" }, 503);
  }
}
export const GET = (req: Request) => handle(req, false);
export const PUT = (req: Request) => handle(req, true);
