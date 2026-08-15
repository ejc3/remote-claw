import { A1_CONTROL_BODY_BYTES_CAP } from "../../../../lib/broker/a1-contract";
import {
  a1Error,
  a1GenerationJson,
  a1Json,
  admitA1Request,
  parseSubscribeRequest,
  readBoundedBody,
  requireJsonContentType,
} from "../../../../lib/broker/a1-http";
import { getA1SqliteBackend } from "../../../../lib/broker/a1-sqlite";

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  try {
    const identityId = await admitA1Request(req, true);
    requireJsonContentType(req);
    const raw = await readBoundedBody(req, A1_CONTROL_BODY_BYTES_CAP);
    const parsed = await parseSubscribeRequest(raw, identityId);
    const result = await getA1SqliteBackend().subscribe(
      parsed.route,
      parsed.expectedRouteStoreInstanceId,
      parsed.position,
      parsed.maxFrames,
    );
    return a1Json({
      v: 1,
      broker_route_id: result.brokerRouteId,
      route_store_instance_id: result.routeStoreInstanceId,
      generation: a1GenerationJson(result.generation),
      frames: result.frames,
      next_position: result.nextPosition,
      observed_next_frame_index: result.observedNextFrameIndex,
      at_live_tail: result.atLiveTail,
    });
  } catch (error) {
    return a1Error(error);
  }
}
