import {
  A1_BROKER_CAPABILITIES_DIGEST,
  A1_CONTROL_BODY_BYTES_CAP,
} from "../../../../../lib/broker/a1-contract";
import {
  a1Error,
  a1GenerationJson,
  a1Json,
  admitA1Request,
  parseRouteRequest,
  readBoundedBody,
  requireJsonContentType,
} from "../../../../../lib/broker/a1-http";
import { getA1SqliteBackend } from "../../../../../lib/broker/a1-sqlite";

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  try {
    const identityId = await admitA1Request(req, true);
    requireJsonContentType(req);
    const raw = await readBoundedBody(req, A1_CONTROL_BODY_BYTES_CAP);
    const parsed = await parseRouteRequest(raw, identityId);
    const result = await getA1SqliteBackend().openRoute(
      parsed.route,
      parsed.expectedRouteStoreInstanceId,
    );
    return a1Json({
      v: 1,
      disposition: result.disposition,
      broker_route_id: result.brokerRouteId,
      route_store_instance_id: result.routeStoreInstanceId,
      broker_backend_capabilities_digest: A1_BROKER_CAPABILITIES_DIGEST,
      genesis: a1GenerationJson(result.genesis),
      current_generation: a1GenerationJson(result.generation),
      observed_next_frame_index: result.observedNextFrameIndex,
    });
  } catch (error) {
    return a1Error(error);
  }
}
