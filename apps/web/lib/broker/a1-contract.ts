import {
  A1_BROKER_CIPHERTEXT_LIMIT_BYTES,
  A1_BROKER_GENERATION_FRAME_CAP,
  A1_BROKER_MAX_RAW_FRAME_BYTES,
  A1_BROKER_MAX_READ_ENCODED_BYTES,
  A1_BROKER_MAX_READ_FRAMES,
  type A1BrokerRoute,
  type A1EncryptedFrameV2,
  type A1RouteKind,
  SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
} from "@remote-claw/clawsec";

/** The only backend capability vector selected A1 accepts. Keep this byte-for-byte aligned with the
 * host-side `BrokerBackendCapabilitiesV1` contract. A partial vector is not an A1 backend. */
export const A1_BROKER_CAPABILITIES = SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1;

export const A1_BROKER_CAPABILITIES_DIGEST = "pxq9w0eeR1rKMUyVw5p5Sgl6VU1jdEHAPYlrS93Cbdo" as const;
export const A1_CAPABILITIES_DIGEST_HEADER = "x-remote-claw-a1-capabilities-digest" as const;
export const A1_ROUTE_KIND_HEADER = "x-remote-claw-a1-route-kind" as const;
export const A1_ROUTE_TOKEN_HEADER = "x-remote-claw-a1-route-token" as const;
export const A1_ROUTE_STORE_INSTANCE_HEADER = "x-remote-claw-a1-route-store-instance-id" as const;

export const A1_ROUTE_FRAME_CAP = A1_BROKER_GENERATION_FRAME_CAP;
export const A1_MAX_ROUTES_PER_IDENTITY = 4096;
export const A1_MAX_SUBSCRIBE_FRAMES = A1_BROKER_MAX_READ_FRAMES;
export const A1_SUBSCRIBE_FRAME_BYTES_CAP = A1_BROKER_MAX_READ_ENCODED_BYTES;
export const A1_RELAY_BODY_BYTES_CAP = A1_BROKER_MAX_RAW_FRAME_BYTES;
export const A1_RELAY_CIPHERTEXT_BYTES_CAP = A1_BROKER_CIPHERTEXT_LIMIT_BYTES;
export const A1_CONTROL_BODY_BYTES_CAP = 8192;

export type A1ErrorCode =
  | "invalid_request"
  | "backend_selector_required"
  | "unauthorized"
  | "route_auth_mismatch"
  | "route_not_found"
  | "route_coordinate_collision"
  | "route_store_mismatch"
  | "broker_capabilities_mismatch"
  | "generation_mismatch"
  | "transport_collision"
  | "frame_too_large"
  | "unsupported_media_type"
  | "invalid_read_position"
  | "a1_backend_unsupported"
  | "counter_exhausted"
  | "broker_failure";

// Next may load route handlers through separate server bundles while the backend itself is shared on
// globalThis. Symbol.for keeps typed backend failures recognizable across those bundle/class copies.
const A1_BROKER_ERROR_BRAND = Symbol.for("remote-claw.a1-broker-error.v1");

export class A1BrokerError extends Error {
  readonly code: Exclude<A1ErrorCode, "transport_collision">;
  readonly status: number;

  constructor(code: Exclude<A1ErrorCode, "transport_collision">, status: number) {
    super(code);
    this.name = "A1BrokerError";
    this.code = code;
    this.status = status;
    Object.defineProperty(this, A1_BROKER_ERROR_BRAND, { value: true });
  }

  static is(error: unknown): error is A1BrokerError {
    return (
      error instanceof A1BrokerError ||
      (typeof error === "object" &&
        error !== null &&
        (error as Record<PropertyKey, unknown>)[A1_BROKER_ERROR_BRAND] === true)
    );
  }
}

export interface A1ChannelCursorV1 {
  readonly version: 1;
  readonly channel_generation: number;
  readonly frame_index: number;
}

export interface A1ReadPositionV1 {
  readonly version: 1;
  readonly channel_generation: number;
  readonly next_frame_index: number;
}

export type A1GenerationDescriptor =
  | {
      readonly channel_generation: number;
      readonly state: "open";
      readonly frame_count: null;
      readonly next_generation: null;
      readonly manifest_digest: null;
      readonly next_frame_index: number;
    }
  | {
      readonly channel_generation: number;
      readonly state: "sealed";
      readonly frame_count: number;
      readonly next_generation: number;
      readonly manifest_digest: string;
      readonly next_frame_index: number;
    };

export interface A1RouteCoordinates {
  readonly brokerRouteId: string;
  readonly identityIdHex: string;
  readonly route: A1BrokerRoute;
  readonly routeKind: A1RouteKind;
  readonly collaborationServerId: string;
  readonly logicalChatId: string | null;
  readonly routeToken: string;
}

export interface A1OpenRouteResult {
  readonly disposition: "created" | "existing";
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly genesis: A1GenerationDescriptor;
  readonly generation: A1GenerationDescriptor;
  readonly observedNextFrameIndex: number;
}

export interface A1RelayStoredResult {
  readonly kind: "stored";
  readonly disposition: "inserted" | "exact_retry";
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly cursor: A1ChannelCursorV1;
  readonly transportFrameDigest: string;
}

export interface A1RelayCollisionResult {
  readonly kind: "collision";
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly deliveryAttemptId: string;
  readonly part: number;
  readonly originalCursor: A1ChannelCursorV1;
  readonly originalTransportFrameDigest: string;
  readonly firstConflictingTransportFrameDigest: string;
  readonly conflictingTransportFrameDigest: string;
}

export type A1RelayResult = A1RelayStoredResult | A1RelayCollisionResult;

export interface A1SubscribeFrame {
  readonly cursor: A1ChannelCursorV1;
  readonly delivery_attempt_id: string;
  readonly part: number;
  readonly transport_frame_digest: string;
  readonly frame: string;
}

export interface A1SubscribeResult {
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly generation: A1GenerationDescriptor;
  readonly frames: readonly A1SubscribeFrame[];
  readonly nextPosition: A1ReadPositionV1;
  readonly observedNextFrameIndex: number;
  readonly atLiveTail: boolean;
}

export interface A1RelayInput {
  readonly route: A1RouteCoordinates;
  readonly expectedRouteStoreInstanceId: string;
  readonly frame: A1EncryptedFrameV2;
}
