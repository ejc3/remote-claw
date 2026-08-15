import {
  A1BrokerContractError,
  A1WireError,
  assertA1FrameMatchesRoute,
  parseA1BrokerCanonicalFrameV1,
} from "@remote-claw/clawsec";
import {
  A1_RELAY_BODY_BYTES_CAP,
  A1_RELAY_CIPHERTEXT_BYTES_CAP,
  A1BrokerError,
} from "../../../../lib/broker/a1-contract";
import {
  a1Error,
  a1Json,
  admitA1Request,
  readBoundedBody,
  requireJsonContentType,
  routeFromRelayFrame,
} from "../../../../lib/broker/a1-http";
import { getA1SqliteBackend } from "../../../../lib/broker/a1-sqlite";

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  try {
    const identityId = await admitA1Request(req, true);
    requireJsonContentType(req);
    const raw = await readBoundedBody(req, A1_RELAY_BODY_BYTES_CAP);
    let inspected: Awaited<ReturnType<typeof parseA1BrokerCanonicalFrameV1>>;
    try {
      inspected = await parseA1BrokerCanonicalFrameV1(raw);
    } catch (error) {
      if (A1WireError.is(error) || A1BrokerContractError.is(error)) {
        const status = A1BrokerContractError.is(error) && error.reason === "bad-length" ? 413 : 400;
        throw new A1BrokerError(status === 413 ? "frame_too_large" : "invalid_request", status);
      }
      throw error;
    }
    const { frame } = inspected;
    if (frame.ct.length >= A1_RELAY_CIPHERTEXT_BYTES_CAP) {
      throw new A1BrokerError("frame_too_large", 413);
    }
    const selected = await routeFromRelayFrame(req, identityId, frame);
    try {
      assertA1FrameMatchesRoute(frame, selected.route.route);
    } catch (error) {
      if (A1WireError.is(error)) throw new A1BrokerError("route_auth_mismatch", 403);
      throw error;
    }
    const result = await getA1SqliteBackend().relay({
      route: selected.route,
      expectedRouteStoreInstanceId: selected.expectedRouteStoreInstanceId,
      frame,
    });
    if (result.kind === "collision") {
      return a1Json(
        {
          v: 1,
          error: "transport_collision",
          broker_route_id: result.brokerRouteId,
          route_store_instance_id: result.routeStoreInstanceId,
          delivery_attempt_id: result.deliveryAttemptId,
          part: result.part,
          original_cursor: result.originalCursor,
          original_transport_frame_digest: result.originalTransportFrameDigest,
          first_conflicting_transport_frame_digest: result.firstConflictingTransportFrameDigest,
          conflicting_transport_frame_digest: result.conflictingTransportFrameDigest,
        },
        409,
      );
    }
    return a1Json({
      v: 1,
      disposition: result.disposition,
      broker_route_id: result.brokerRouteId,
      route_store_instance_id: result.routeStoreInstanceId,
      cursor: result.cursor,
      transport_frame_digest: result.transportFrameDigest,
    });
  } catch (error) {
    return a1Error(error);
  }
}
