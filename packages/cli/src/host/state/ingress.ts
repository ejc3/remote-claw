import {
  A1_BROKER_GENERATION_FRAME_CAP,
  A1_INGRESS_ASSEMBLY_DEADLINE_MS,
  A1_INGRESS_LOOKAHEAD_MAX_BYTES,
  A1_INGRESS_LOOKAHEAD_MAX_FRAMES,
  A1_INGRESS_MAX_CANDIDATES_PER_RESULT,
  A1_INGRESS_MAX_OPENED_PART_BYTES,
  A1_INGRESS_MAX_PARTS,
  A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE,
  A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE,
  A1_INGRESS_SCHEDULER_CONCURRENCY,
  type A1Direction,
  type A1RecordKind,
} from "@remote-claw/clawsec";
import {
  BROKER_ROUTE_KINDS,
  type BrokerRouteId,
  type BrokerRouteStoreInstanceId,
  parseBrokerRouteId,
  parseBrokerRouteStoreInstanceId,
} from "./broker-route.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type LogicalChatId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
} from "./ids.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
  parseNullable,
  parsePositiveSafeInteger,
} from "./validation.js";

export {
  A1_INGRESS_ASSEMBLY_DEADLINE_MS,
  A1_INGRESS_LOOKAHEAD_MAX_BYTES,
  A1_INGRESS_LOOKAHEAD_MAX_FRAMES,
  A1_INGRESS_MAX_CANDIDATES_PER_RESULT,
  A1_INGRESS_MAX_OPENED_PART_BYTES,
  A1_INGRESS_MAX_PARTS,
  A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE,
  A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE,
  A1_INGRESS_SCHEDULER_CONCURRENCY,
};

export const BROKER_ROUTE_RUNTIME_STATES = Object.freeze([
  "current",
  "quarantined",
  "closed",
] as const);
export const BROKER_GENERATION_OBSERVATION_STATES = Object.freeze(["open", "sealed"] as const);
export const AUTHENTICATED_POSITION_CLASSIFICATIONS = Object.freeze([
  "pending_validation",
  "inbound_ingress",
  "known_host_output",
  "unknown_outbound",
  "invalid",
] as const);
export const INGRESS_CURSOR_DISPOSITIONS = Object.freeze(["blocked", "advanceable"] as const);
export const BROKER_ROUTE_GAP_REASONS = Object.freeze([
  "manifest_equivocation",
  "position_equivocation",
  "transport_collision",
  "semantic_collision",
  "unknown_outbound",
  "invalid_frame",
  "storage_quota",
  "outer_page_invalid",
] as const);
export const BROKER_ROUTE_GAP_STATES = Object.freeze(["open", "resolved"] as const);
export const AUTHENTICATED_INGRESS_RESULT_STATES = Object.freeze([
  "assembling",
  "awaiting_order",
  "quarantined_incomplete",
  "quarantined_collision",
] as const);
export const INGRESS_CANDIDATE_STATES = Object.freeze([
  "assembling",
  "complete",
  "expired",
  "collision",
] as const);
export const INGRESS_OBSERVATION_DISPOSITIONS = Object.freeze([
  "new_part",
  "exact_duplicate_part",
  "exact_transport_retry",
  "completed_exact_replay",
  "collision",
  "invalid_payload",
  "late_after_tombstone",
] as const);
export const CHANNEL_POSITION_RECOVERY_DECISIONS = Object.freeze([
  "discard_and_close_source",
  "proved_safe_discard",
] as const);

export type BrokerRouteRuntimeState = (typeof BROKER_ROUTE_RUNTIME_STATES)[number];
export type BrokerRouteGapReason = (typeof BROKER_ROUTE_GAP_REASONS)[number];
export type IngressCursorDisposition = (typeof INGRESS_CURSOR_DISPOSITIONS)[number];

export type BrokerRouteActorScope =
  | Readonly<{
      brokerRouteId: BrokerRouteId;
      collaborationServerId: CollaborationServerId;
      routeKind: "scope_bus" | "server_control";
      logicalChatId: null;
    }>
  | Readonly<{
      brokerRouteId: BrokerRouteId;
      collaborationServerId: CollaborationServerId;
      routeKind: "chat";
      logicalChatId: LogicalChatId;
    }>;

type ScopedIngressRecord<T extends object> = BrokerRouteActorScope & Readonly<T>;

const SCOPE_KEYS = [
  "brokerRouteId",
  "collaborationServerId",
  "routeKind",
  "logicalChatId",
] as const;

export function parseBrokerRouteActorScope(
  value: unknown,
  field = "brokerRouteActorScope",
): BrokerRouteActorScope {
  const row = parseExactRecord(value, SCOPE_KEYS, field);
  const routeKind = parseEnum(row.routeKind, BROKER_ROUTE_KINDS, `${field}.routeKind`);
  const common = {
    brokerRouteId: parseBrokerRouteId(row.brokerRouteId, `${field}.brokerRouteId`),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      `${field}.collaborationServerId`,
    ),
  };
  if (routeKind === "chat") {
    return frozen({
      ...common,
      routeKind,
      logicalChatId: parseA1CanonicalId("logicalChat", row.logicalChatId, `${field}.logicalChatId`),
    });
  }
  if (row.logicalChatId !== null) {
    parseLiteral(row.logicalChatId, null as never, `${field}.logicalChatId`);
  }
  return frozen({ ...common, routeKind, logicalChatId: null });
}

function scopeFromRow(
  row: Readonly<Record<string, unknown>>,
  field: string,
): BrokerRouteActorScope {
  return parseBrokerRouteActorScope(
    {
      brokerRouteId: row.brokerRouteId,
      collaborationServerId: row.collaborationServerId,
      routeKind: row.routeKind,
      logicalChatId: row.logicalChatId,
    },
    field,
  );
}

function bounded(value: unknown, maximum: number, field: string): number {
  const parsed = parseNonNegativeSafeInteger(value, field);
  if (parsed > maximum) throw new RangeError(`${field} exceeds ${maximum}`);
  return parsed;
}

function nullableSafeId(value: unknown, field: string): A1SafeId | null {
  return parseNullable(value, parseA1SafeId, field);
}

function nullableDigest(value: unknown, field: string): A1Digest | null {
  return parseNullable(value, parseA1Digest, field);
}

function nullableTime(value: unknown, field: string): number | null {
  return parseNullable(value, parseNonNegativeSafeInteger, field);
}

function positionId(value: unknown, field: string): A1SafeId {
  const id = parseA1SafeId(value, field);
  if (!id.startsWith("rcp_") || id.length !== 47) throw new RangeError(`${field} is not rcp_*`);
  return id;
}

function observationId(value: unknown, field: string): A1SafeId {
  const id = parseA1SafeId(value, field);
  if (!id.startsWith("rio_") || id.length !== 47) throw new RangeError(`${field} is not rio_*`);
  return id;
}

function resultId(value: unknown, field: string): A1SafeId {
  const id = parseA1SafeId(value, field);
  if (!id.startsWith("rrs_") || id.length !== 47) throw new RangeError(`${field} is not rrs_*`);
  return id;
}

function namespaceId(value: unknown, field: string): A1SafeId {
  const id = parseA1SafeId(value, field);
  if (!id.startsWith("wns_") || id.length !== 47) throw new RangeError(`${field} is not wns_*`);
  return id;
}

function deliveryAttemptId(value: unknown, field: string): A1SafeId {
  const id = parseA1SafeId(value, field);
  if (id.length !== 26 || !/^rda_[A-Za-z0-9_-]{22}$/.test(id)) {
    throw new RangeError(`${field} must be an rda_ identifier with a 16-byte base64url body`);
  }
  return id;
}

function protectedHandle(value: unknown, field: string): ProtectedHandleId {
  return parseA1CanonicalId("protectedHandle", value, field);
}

const RUNTIME_KEYS = [
  ...SCOPE_KEYS,
  "machineIdentityId",
  "state",
  "currentChannelGeneration",
  "activeGapCount",
  "updatedAtMs",
] as const;
export type BrokerRouteRuntimeStatusRecord = ScopedIngressRecord<{
  readonly machineIdentityId: string;
  readonly state: BrokerRouteRuntimeState;
  readonly currentChannelGeneration: number;
  readonly activeGapCount: number;
  readonly updatedAtMs: number;
}>;
export function parseBrokerRouteRuntimeStatusRecord(
  value: unknown,
): BrokerRouteRuntimeStatusRecord {
  const row = parseExactRecord(value, RUNTIME_KEYS, "brokerRouteRuntimeStatus");
  return frozen({
    ...scopeFromRow(row, "brokerRouteRuntimeStatus.scope"),
    machineIdentityId: parseMachineIdentityId(row.machineIdentityId),
    state: parseEnum(row.state, BROKER_ROUTE_RUNTIME_STATES, "brokerRouteRuntimeStatus.state"),
    currentChannelGeneration: parseNonNegativeSafeInteger(
      row.currentChannelGeneration,
      "brokerRouteRuntimeStatus.currentChannelGeneration",
    ),
    activeGapCount: parseNonNegativeSafeInteger(
      row.activeGapCount,
      "brokerRouteRuntimeStatus.activeGapCount",
    ),
    updatedAtMs: parseNonNegativeSafeInteger(
      row.updatedAtMs,
      "brokerRouteRuntimeStatus.updatedAtMs",
    ),
  });
}

const GENERATION_KEYS = [
  ...SCOPE_KEYS,
  "channelGeneration",
  "state",
  "observedNextFrameIndex",
  "frameCount",
  "nextGeneration",
  "manifestDigest",
  "firstObservedAtMs",
  "lastObservedAtMs",
] as const;
export type BrokerChannelGenerationObservationRecord = ScopedIngressRecord<{
  readonly channelGeneration: number;
  readonly state: "open" | "sealed";
  readonly observedNextFrameIndex: number;
  readonly frameCount: number | null;
  readonly nextGeneration: number | null;
  readonly manifestDigest: A1Digest | null;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
}>;
export function parseBrokerChannelGenerationObservationRecord(
  value: unknown,
): BrokerChannelGenerationObservationRecord {
  const row = parseExactRecord(value, GENERATION_KEYS, "brokerGenerationObservation");
  const channelGeneration = parseNonNegativeSafeInteger(
    row.channelGeneration,
    "brokerGenerationObservation.channelGeneration",
  );
  const state = parseEnum(
    row.state,
    BROKER_GENERATION_OBSERVATION_STATES,
    "brokerGenerationObservation.state",
  );
  const observedNextFrameIndex = bounded(
    row.observedNextFrameIndex,
    A1_BROKER_GENERATION_FRAME_CAP,
    "brokerGenerationObservation.observedNextFrameIndex",
  );
  const frameCount = parseNullable(
    row.frameCount,
    (input, field) => bounded(input, A1_BROKER_GENERATION_FRAME_CAP, field),
    "brokerGenerationObservation.frameCount",
  );
  const nextGeneration = parseNullable(
    row.nextGeneration,
    parseNonNegativeSafeInteger,
    "brokerGenerationObservation.nextGeneration",
  );
  const manifestDigest = nullableDigest(
    row.manifestDigest,
    "brokerGenerationObservation.manifestDigest",
  );
  if (
    (state === "open" &&
      (frameCount !== null || nextGeneration !== null || manifestDigest !== null)) ||
    (state === "sealed" &&
      (frameCount === null ||
        nextGeneration !== channelGeneration + 1 ||
        manifestDigest === null ||
        observedNextFrameIndex !== frameCount))
  ) {
    throw new RangeError("brokerGenerationObservation has an invalid open/sealed tuple");
  }
  const firstObservedAtMs = parseNonNegativeSafeInteger(
    row.firstObservedAtMs,
    "brokerGenerationObservation.firstObservedAtMs",
  );
  const lastObservedAtMs = parseNonNegativeSafeInteger(
    row.lastObservedAtMs,
    "brokerGenerationObservation.lastObservedAtMs",
  );
  if (lastObservedAtMs < firstObservedAtMs) throw new RangeError("generation time reversed");
  return frozen({
    ...scopeFromRow(row, "brokerGenerationObservation.scope"),
    channelGeneration,
    state,
    observedNextFrameIndex,
    frameCount,
    nextGeneration,
    manifestDigest,
    firstObservedAtMs,
    lastObservedAtMs,
  });
}

const FETCH_CURSOR_KEYS = [
  "brokerRouteId",
  "nextGeneration",
  "nextFrameIndex",
  "revision",
  "updatedAtMs",
] as const;
export interface BrokerRouteFetchCursorRecord {
  readonly brokerRouteId: BrokerRouteId;
  readonly nextGeneration: number;
  readonly nextFrameIndex: number;
  readonly revision: number;
  readonly updatedAtMs: number;
}
export function parseBrokerRouteFetchCursorRecord(value: unknown): BrokerRouteFetchCursorRecord {
  const row = parseExactRecord(value, FETCH_CURSOR_KEYS, "brokerRouteFetchCursor");
  return frozen({
    brokerRouteId: parseBrokerRouteId(row.brokerRouteId),
    nextGeneration: parseNonNegativeSafeInteger(row.nextGeneration, "fetchCursor.nextGeneration"),
    nextFrameIndex: bounded(
      row.nextFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP,
      "fetchCursor.nextFrameIndex",
    ),
    revision: parseNonNegativeSafeInteger(row.revision, "fetchCursor.revision"),
    updatedAtMs: parseNonNegativeSafeInteger(row.updatedAtMs, "fetchCursor.updatedAtMs"),
  });
}

const SEMANTIC_CURSOR_KEYS = [
  "brokerRouteId",
  "nextGeneration",
  "nextFrameIndex",
  "contiguousThroughGeneration",
  "contiguousThroughFrameIndex",
  "revision",
  "updatedAtMs",
] as const;
export interface BrokerRouteSemanticCursorRecord extends BrokerRouteFetchCursorRecord {
  readonly contiguousThroughGeneration: number | null;
  readonly contiguousThroughFrameIndex: number | null;
}
export function parseBrokerRouteSemanticCursorRecord(
  value: unknown,
): BrokerRouteSemanticCursorRecord {
  const row = parseExactRecord(value, SEMANTIC_CURSOR_KEYS, "brokerRouteSemanticCursor");
  const contiguousThroughGeneration = parseNullable(
    row.contiguousThroughGeneration,
    parseNonNegativeSafeInteger,
    "semanticCursor.contiguousThroughGeneration",
  );
  const contiguousThroughFrameIndex = parseNullable(
    row.contiguousThroughFrameIndex,
    (input, field) => bounded(input, A1_BROKER_GENERATION_FRAME_CAP - 1, field),
    "semanticCursor.contiguousThroughFrameIndex",
  );
  if ((contiguousThroughGeneration === null) !== (contiguousThroughFrameIndex === null)) {
    throw new RangeError("semantic cursor contiguous fields must be null together");
  }
  return frozen({
    brokerRouteId: parseBrokerRouteId(row.brokerRouteId),
    nextGeneration: parseNonNegativeSafeInteger(
      row.nextGeneration,
      "semanticCursor.nextGeneration",
    ),
    nextFrameIndex: bounded(
      row.nextFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP,
      "semanticCursor.nextFrameIndex",
    ),
    contiguousThroughGeneration,
    contiguousThroughFrameIndex,
    revision: parseNonNegativeSafeInteger(row.revision, "semanticCursor.revision"),
    updatedAtMs: parseNonNegativeSafeInteger(row.updatedAtMs, "semanticCursor.updatedAtMs"),
  });
}

const GAP_KEYS = [
  "gapId",
  ...SCOPE_KEYS,
  "reason",
  "channelPositionObservationId",
  "channelGeneration",
  "manifestEquivocationId",
  "transportKeyCollisionId",
  "stableSemanticResultId",
  "evidenceRef",
  "evidenceDigest",
  "state",
  "openedAtMs",
  "resolvedAtMs",
  "recoveryId",
] as const;
export type BrokerRouteGapRecord = ScopedIngressRecord<{
  readonly gapId: A1SafeId;
  readonly reason: BrokerRouteGapReason;
  readonly channelPositionObservationId: A1SafeId | null;
  readonly channelGeneration: number | null;
  readonly manifestEquivocationId: A1SafeId | null;
  readonly transportKeyCollisionId: A1SafeId | null;
  readonly stableSemanticResultId: A1SafeId | null;
  readonly evidenceRef: ProtectedHandleId;
  readonly evidenceDigest: A1Digest;
  readonly state: "open" | "resolved";
  readonly openedAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly recoveryId: A1SafeId | null;
}>;
export function parseBrokerRouteGapRecord(value: unknown): BrokerRouteGapRecord {
  const row = parseExactRecord(value, GAP_KEYS, "brokerRouteGap");
  const state = parseEnum(row.state, BROKER_ROUTE_GAP_STATES, "brokerRouteGap.state");
  const resolvedAtMs = nullableTime(row.resolvedAtMs, "brokerRouteGap.resolvedAtMs");
  const recoveryId = nullableSafeId(row.recoveryId, "brokerRouteGap.recoveryId");
  if ((state === "open") !== (resolvedAtMs === null && recoveryId === null)) {
    throw new RangeError("brokerRouteGap resolution tuple is invalid");
  }
  const reason = parseEnum(row.reason, BROKER_ROUTE_GAP_REASONS, "brokerRouteGap.reason");
  const targetPosition =
    row.channelPositionObservationId === null
      ? null
      : positionId(row.channelPositionObservationId, "brokerRouteGap.channelPositionObservationId");
  const targetGeneration = parseNullable(
    row.channelGeneration,
    parseNonNegativeSafeInteger,
    "brokerRouteGap.channelGeneration",
  );
  const targetManifest = nullableSafeId(
    row.manifestEquivocationId,
    "brokerRouteGap.manifestEquivocationId",
  );
  const targetTransport = nullableSafeId(
    row.transportKeyCollisionId,
    "brokerRouteGap.transportKeyCollisionId",
  );
  const targetResult =
    row.stableSemanticResultId === null
      ? null
      : resultId(row.stableSemanticResultId, "brokerRouteGap.stableSemanticResultId");
  const validTarget =
    (reason === "manifest_equivocation" &&
      targetPosition === null &&
      targetGeneration !== null &&
      targetManifest !== null &&
      targetTransport === null &&
      targetResult === null) ||
    ((reason === "position_equivocation" ||
      reason === "unknown_outbound" ||
      reason === "invalid_frame") &&
      targetPosition !== null &&
      targetGeneration === null &&
      targetManifest === null &&
      targetTransport === null &&
      targetResult === null) ||
    (reason === "transport_collision" &&
      targetPosition === null &&
      targetGeneration === null &&
      targetManifest === null &&
      targetTransport !== null &&
      targetResult === null) ||
    (reason === "semantic_collision" &&
      targetPosition === null &&
      targetGeneration === null &&
      targetManifest === null &&
      targetTransport === null &&
      targetResult !== null) ||
    ((reason === "storage_quota" || reason === "outer_page_invalid") &&
      targetPosition === null &&
      targetGeneration === null &&
      targetManifest === null &&
      targetTransport === null &&
      targetResult === null);
  if (!validTarget) throw new RangeError("brokerRouteGap target tuple is invalid for its reason");
  return frozen({
    gapId: parseA1SafeId(row.gapId, "brokerRouteGap.gapId"),
    ...scopeFromRow(row, "brokerRouteGap.scope"),
    reason,
    channelPositionObservationId: targetPosition,
    channelGeneration: targetGeneration,
    manifestEquivocationId: targetManifest,
    transportKeyCollisionId: targetTransport,
    stableSemanticResultId: targetResult,
    evidenceRef: protectedHandle(row.evidenceRef, "brokerRouteGap.evidenceRef"),
    evidenceDigest: parseA1Digest(row.evidenceDigest, "brokerRouteGap.evidenceDigest"),
    state,
    openedAtMs: parseNonNegativeSafeInteger(row.openedAtMs, "brokerRouteGap.openedAtMs"),
    resolvedAtMs,
    recoveryId,
  });
}

const POSITION_KEYS = [
  "channelPositionObservationId",
  ...SCOPE_KEYS,
  "channelGeneration",
  "frameIndex",
  "claimedDeliveryAttemptId",
  "claimedPart",
  "claimedTransportFrameDigest",
  "receivedFrameRef",
  "receivedFrameDigest",
  "receivedFrameByteLength",
  "normalizedTransportFrameDigest",
  "frameIdentityId",
  "frameCollaborationServerId",
  "frameLogicalChatId",
  "direction",
  "recordKind",
  "sequence",
  "messageId",
  "deliveryAttemptId",
  "clientMessageId",
  "keyEpoch",
  "part",
  "parts",
  "serverKeyGeneration",
  "hostSignerIdentityKeyId",
  "hostScopeCertificateId",
  "hostSignatureSequence",
  "stableLogicalHeaderDigest",
  "classification",
  "validationFailureCode",
  "ingressObservationId",
  "cursorDisposition",
  "recoveryId",
  "gapId",
  "observedAtMs",
  "classifiedAtMs",
] as const;
export type AuthenticatedChannelPositionRecord = ScopedIngressRecord<{
  readonly channelPositionObservationId: A1SafeId;
  readonly channelGeneration: number;
  readonly frameIndex: number;
  readonly claimedDeliveryAttemptId: A1SafeId;
  readonly claimedPart: number;
  readonly claimedTransportFrameDigest: A1Digest;
  readonly receivedFrameRef: ProtectedHandleId;
  readonly receivedFrameDigest: A1Digest;
  readonly receivedFrameByteLength: number;
  readonly normalizedTransportFrameDigest: A1Digest | null;
  readonly frameIdentityId: string | null;
  readonly frameCollaborationServerId: CollaborationServerId | null;
  readonly frameLogicalChatId: LogicalChatId | null;
  readonly direction: A1Direction | null;
  readonly recordKind: A1RecordKind | null;
  readonly sequence: number | null;
  readonly messageId: A1SafeId | null;
  readonly deliveryAttemptId: A1SafeId | null;
  readonly clientMessageId: A1SafeId | null;
  readonly keyEpoch: 0 | null;
  readonly part: number | null;
  readonly parts: number | null;
  readonly serverKeyGeneration: number | null;
  readonly hostSignerIdentityKeyId: A1SafeId | null;
  readonly hostScopeCertificateId: A1SafeId | null;
  readonly hostSignatureSequence: number | null;
  readonly stableLogicalHeaderDigest: A1Digest | null;
  readonly classification: (typeof AUTHENTICATED_POSITION_CLASSIFICATIONS)[number];
  readonly validationFailureCode: A1SafeId | null;
  readonly ingressObservationId: A1SafeId | null;
  readonly cursorDisposition: IngressCursorDisposition;
  readonly recoveryId: A1SafeId | null;
  readonly gapId: A1SafeId | null;
  readonly observedAtMs: number;
  readonly classifiedAtMs: number | null;
}>;

const DIRECTIONS = Object.freeze(["in", "out"] as const);
const RECORD_KINDS = Object.freeze([
  "user",
  "assistant",
  "assistant_sub",
  "assistant_thinking",
  "assistant_thinking_sub",
  "result",
  "system",
  "status",
  "rate_limit",
  "can_use_tool",
  "tool_use",
  "tool_result",
  "task",
  "permission_request",
  "catch_up",
  "permission",
  "interrupt",
  "set_mode",
  "set_model",
  "command",
  "end",
  "attachment",
  "accepted",
  "session_announce",
  "permission_resolved",
  "action_result",
  "new_chat",
  "chat_creation_result",
] as const satisfies readonly A1RecordKind[]);

export function parseAuthenticatedChannelPositionRecord(
  value: unknown,
): AuthenticatedChannelPositionRecord {
  const row = parseExactRecord(value, POSITION_KEYS, "authenticatedChannelPosition");
  const normalizedTransportFrameDigest = nullableDigest(
    row.normalizedTransportFrameDigest,
    "position.normalizedTransportFrameDigest",
  );
  const parsedRequired = [
    row.frameIdentityId,
    row.frameCollaborationServerId,
    row.direction,
    row.recordKind,
    row.messageId,
    row.deliveryAttemptId,
    row.keyEpoch,
    row.part,
    row.parts,
    row.stableLogicalHeaderDigest,
  ];
  if (normalizedTransportFrameDigest === null && parsedRequired.some((entry) => entry !== null)) {
    throw new RangeError("unparsed position cannot retain parsed header fields");
  }
  if (normalizedTransportFrameDigest !== null && parsedRequired.some((entry) => entry === null)) {
    throw new RangeError("parsed position must retain its complete required header");
  }
  const classification = parseEnum(
    row.classification,
    AUTHENTICATED_POSITION_CLASSIFICATIONS,
    "position.classification",
  );
  const cursorDisposition = parseEnum(
    row.cursorDisposition,
    INGRESS_CURSOR_DISPOSITIONS,
    "position.cursorDisposition",
  );
  const validationFailureCode = nullableSafeId(
    row.validationFailureCode,
    "position.validationFailureCode",
  );
  const parsedIngressObservationId =
    row.ingressObservationId === null
      ? null
      : observationId(row.ingressObservationId, "position.ingressObservationId");
  const recoveryId = nullableSafeId(row.recoveryId, "position.recoveryId");
  const gapId = nullableSafeId(row.gapId, "position.gapId");
  const classifiedAtMs = nullableTime(row.classifiedAtMs, "position.classifiedAtMs");
  const hasParsed = normalizedTransportFrameDigest !== null;
  if (
    (classification === "pending_validation" &&
      (hasParsed ||
        cursorDisposition !== "blocked" ||
        validationFailureCode !== null ||
        parsedIngressObservationId !== null ||
        recoveryId !== null ||
        gapId !== null ||
        classifiedAtMs !== null)) ||
    (classification === "inbound_ingress" &&
      (!hasParsed ||
        validationFailureCode !== null ||
        parsedIngressObservationId === null ||
        classifiedAtMs === null ||
        (gapId === null && recoveryId !== null) ||
        (gapId !== null &&
          ((recoveryId === null &&
            cursorDisposition !== "blocked" &&
            cursorDisposition !== "advanceable") ||
            (recoveryId !== null && cursorDisposition !== "advanceable"))))) ||
    (classification === "known_host_output" &&
      (!hasParsed ||
        cursorDisposition !== "advanceable" ||
        validationFailureCode !== null ||
        parsedIngressObservationId !== null ||
        gapId !== null ||
        recoveryId !== null ||
        classifiedAtMs === null)) ||
    (classification === "invalid" &&
      (cursorDisposition !== "advanceable" ||
        validationFailureCode === null ||
        parsedIngressObservationId !== null ||
        gapId === null ||
        classifiedAtMs === null)) ||
    (classification === "unknown_outbound" &&
      (!hasParsed ||
        validationFailureCode !== null ||
        parsedIngressObservationId !== null ||
        gapId === null ||
        (recoveryId === null && cursorDisposition !== "blocked") ||
        (recoveryId !== null && cursorDisposition !== "advanceable") ||
        classifiedAtMs === null))
  ) {
    throw new RangeError("authenticated position classification tuple is invalid");
  }
  return frozen({
    channelPositionObservationId: positionId(
      row.channelPositionObservationId,
      "position.channelPositionObservationId",
    ),
    ...scopeFromRow(row, "position.scope"),
    channelGeneration: parseNonNegativeSafeInteger(
      row.channelGeneration,
      "position.channelGeneration",
    ),
    frameIndex: bounded(row.frameIndex, A1_BROKER_GENERATION_FRAME_CAP - 1, "position.frameIndex"),
    claimedDeliveryAttemptId: deliveryAttemptId(
      row.claimedDeliveryAttemptId,
      "position.claimedDeliveryAttemptId",
    ),
    claimedPart: bounded(row.claimedPart, A1_INGRESS_MAX_PARTS - 1, "position.claimedPart"),
    claimedTransportFrameDigest: parseA1Digest(
      row.claimedTransportFrameDigest,
      "position.claimedTransportFrameDigest",
    ),
    receivedFrameRef: protectedHandle(row.receivedFrameRef, "position.receivedFrameRef"),
    receivedFrameDigest: parseA1Digest(row.receivedFrameDigest, "position.receivedFrameDigest"),
    receivedFrameByteLength: bounded(
      row.receivedFrameByteLength,
      4_450_000,
      "position.receivedFrameByteLength",
    ),
    normalizedTransportFrameDigest,
    frameIdentityId: parseNullable(
      row.frameIdentityId,
      parseMachineIdentityId,
      "position.frameIdentityId",
    ),
    frameCollaborationServerId: parseNullable(
      row.frameCollaborationServerId,
      (input, field) => parseA1CanonicalId("collaborationServer", input, field),
      "position.frameCollaborationServerId",
    ),
    frameLogicalChatId: parseNullable(
      row.frameLogicalChatId,
      (input, field) => parseA1CanonicalId("logicalChat", input, field),
      "position.frameLogicalChatId",
    ),
    direction: parseNullable(
      row.direction,
      (input, field) => parseEnum(input, DIRECTIONS, field),
      "position.direction",
    ),
    recordKind: parseNullable(
      row.recordKind,
      (input, field) => parseEnum(input, RECORD_KINDS, field),
      "position.recordKind",
    ),
    sequence: nullableTime(row.sequence, "position.sequence"),
    messageId: nullableSafeId(row.messageId, "position.messageId"),
    deliveryAttemptId: parseNullable(
      row.deliveryAttemptId,
      deliveryAttemptId,
      "position.deliveryAttemptId",
    ),
    clientMessageId: nullableSafeId(row.clientMessageId, "position.clientMessageId"),
    keyEpoch: row.keyEpoch === null ? null : parseLiteral(row.keyEpoch, 0, "position.keyEpoch"),
    part: parseNullable(
      row.part,
      (input, field) => bounded(input, A1_INGRESS_MAX_PARTS - 1, field),
      "position.part",
    ),
    parts: parseNullable(
      row.parts,
      (input, field) => {
        const parsed = parsePositiveSafeInteger(input, field);
        if (parsed > A1_INGRESS_MAX_PARTS) throw new RangeError(`${field} exceeds max parts`);
        return parsed;
      },
      "position.parts",
    ),
    serverKeyGeneration: nullableTime(row.serverKeyGeneration, "position.serverKeyGeneration"),
    hostSignerIdentityKeyId: nullableSafeId(
      row.hostSignerIdentityKeyId,
      "position.hostSignerIdentityKeyId",
    ),
    hostScopeCertificateId: nullableSafeId(
      row.hostScopeCertificateId,
      "position.hostScopeCertificateId",
    ),
    hostSignatureSequence: nullableTime(
      row.hostSignatureSequence,
      "position.hostSignatureSequence",
    ),
    stableLogicalHeaderDigest: nullableDigest(
      row.stableLogicalHeaderDigest,
      "position.stableLogicalHeaderDigest",
    ),
    classification,
    validationFailureCode,
    ingressObservationId: parsedIngressObservationId,
    cursorDisposition,
    recoveryId,
    gapId,
    observedAtMs: parseNonNegativeSafeInteger(row.observedAtMs, "position.observedAtMs"),
    classifiedAtMs,
  });
}

export type ChannelPositionEquivocationRecord = ScopedIngressRecord<{
  readonly positionEquivocationId: A1SafeId;
  readonly channelPositionObservationId: A1SafeId;
  readonly acceptedFrameDigest: A1Digest;
  readonly conflictingFrameDigest: A1Digest;
  readonly conflictingFrameRef: ProtectedHandleId;
  readonly observedAtMs: number;
}>;
const POSITION_EQUIVOCATION_KEYS = [
  "positionEquivocationId",
  "channelPositionObservationId",
  ...SCOPE_KEYS,
  "acceptedFrameDigest",
  "conflictingFrameDigest",
  "conflictingFrameRef",
  "observedAtMs",
] as const;
export function parseChannelPositionEquivocationRecord(
  value: unknown,
): ChannelPositionEquivocationRecord {
  const row = parseExactRecord(value, POSITION_EQUIVOCATION_KEYS, "positionEquivocation");
  return frozen({
    positionEquivocationId: parseA1SafeId(row.positionEquivocationId),
    channelPositionObservationId: positionId(
      row.channelPositionObservationId,
      "positionEquivocation.positionId",
    ),
    ...scopeFromRow(row, "positionEquivocation.scope"),
    acceptedFrameDigest: parseA1Digest(row.acceptedFrameDigest),
    conflictingFrameDigest: parseA1Digest(row.conflictingFrameDigest),
    conflictingFrameRef: protectedHandle(row.conflictingFrameRef, "positionEquivocation.ref"),
    observedAtMs: parseNonNegativeSafeInteger(
      row.observedAtMs,
      "positionEquivocation.observedAtMs",
    ),
  });
}

export type BrokerChannelManifestEquivocationRecord = ScopedIngressRecord<{
  readonly manifestEquivocationId: A1SafeId;
  readonly channelGeneration: number;
  readonly acceptedManifestDigest: A1Digest | null;
  readonly conflictingManifestDigest: A1Digest | null;
  readonly conflictingFrameCount: number | null;
  readonly conflictingNextGeneration: number | null;
  readonly conflictingState: "open" | "sealed";
  readonly conflictingObservationDigest: A1Digest;
  readonly evidenceRef: ProtectedHandleId;
  readonly evidenceDigest: A1Digest;
  readonly observedAtMs: number;
}>;
const MANIFEST_EQUIVOCATION_KEYS = [
  "manifestEquivocationId",
  ...SCOPE_KEYS,
  "channelGeneration",
  "acceptedManifestDigest",
  "conflictingManifestDigest",
  "conflictingFrameCount",
  "conflictingNextGeneration",
  "conflictingState",
  "conflictingObservationDigest",
  "evidenceRef",
  "evidenceDigest",
  "observedAtMs",
] as const;
export function parseBrokerChannelManifestEquivocationRecord(
  value: unknown,
): BrokerChannelManifestEquivocationRecord {
  const row = parseExactRecord(value, MANIFEST_EQUIVOCATION_KEYS, "manifestEquivocation");
  return frozen({
    manifestEquivocationId: parseA1SafeId(row.manifestEquivocationId),
    ...scopeFromRow(row, "manifestEquivocation.scope"),
    channelGeneration: parseNonNegativeSafeInteger(
      row.channelGeneration,
      "manifestEquivocation.generation",
    ),
    acceptedManifestDigest: nullableDigest(
      row.acceptedManifestDigest,
      "manifestEquivocation.acceptedDigest",
    ),
    conflictingManifestDigest: nullableDigest(
      row.conflictingManifestDigest,
      "manifestEquivocation.conflictingDigest",
    ),
    conflictingFrameCount: parseNullable(
      row.conflictingFrameCount,
      (input, field) => bounded(input, A1_BROKER_GENERATION_FRAME_CAP, field),
      "manifestEquivocation.frameCount",
    ),
    conflictingNextGeneration: parseNullable(
      row.conflictingNextGeneration,
      parseNonNegativeSafeInteger,
      "manifestEquivocation.nextGeneration",
    ),
    conflictingState: parseEnum(
      row.conflictingState,
      BROKER_GENERATION_OBSERVATION_STATES,
      "manifestEquivocation.state",
    ),
    conflictingObservationDigest: parseA1Digest(row.conflictingObservationDigest),
    evidenceRef: protectedHandle(row.evidenceRef, "manifestEquivocation.evidenceRef"),
    evidenceDigest: parseA1Digest(row.evidenceDigest),
    observedAtMs: parseNonNegativeSafeInteger(
      row.observedAtMs,
      "manifestEquivocation.observedAtMs",
    ),
  });
}

export type BrokerTransportKeyCollisionRecord = ScopedIngressRecord<{
  readonly transportKeyCollisionId: A1SafeId;
  readonly deliveryAttemptId: A1SafeId;
  readonly part: number;
  readonly originalChannelGeneration: number;
  readonly originalFrameIndex: number;
  readonly originalTransportFrameDigest: A1Digest;
  readonly conflictingTransportFrameDigest: A1Digest;
  readonly conflictingFrameDigest: A1Digest;
  readonly conflictingFrameRef: ProtectedHandleId;
  readonly observedAtMs: number;
}>;
const TRANSPORT_COLLISION_KEYS = [
  "transportKeyCollisionId",
  ...SCOPE_KEYS,
  "deliveryAttemptId",
  "part",
  "originalChannelGeneration",
  "originalFrameIndex",
  "originalTransportFrameDigest",
  "conflictingTransportFrameDigest",
  "conflictingFrameDigest",
  "conflictingFrameRef",
  "observedAtMs",
] as const;
export function parseBrokerTransportKeyCollisionRecord(
  value: unknown,
): BrokerTransportKeyCollisionRecord {
  const row = parseExactRecord(value, TRANSPORT_COLLISION_KEYS, "transportCollision");
  return frozen({
    transportKeyCollisionId: parseA1SafeId(row.transportKeyCollisionId),
    ...scopeFromRow(row, "transportCollision.scope"),
    deliveryAttemptId: deliveryAttemptId(row.deliveryAttemptId, "transportCollision.attemptId"),
    part: bounded(row.part, A1_INGRESS_MAX_PARTS - 1, "transportCollision.part"),
    originalChannelGeneration: parseNonNegativeSafeInteger(
      row.originalChannelGeneration,
      "transportCollision.generation",
    ),
    originalFrameIndex: bounded(
      row.originalFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "transportCollision.frameIndex",
    ),
    originalTransportFrameDigest: parseA1Digest(row.originalTransportFrameDigest),
    conflictingTransportFrameDigest: parseA1Digest(row.conflictingTransportFrameDigest),
    conflictingFrameDigest: parseA1Digest(row.conflictingFrameDigest),
    conflictingFrameRef: protectedHandle(row.conflictingFrameRef, "transportCollision.ref"),
    observedAtMs: parseNonNegativeSafeInteger(row.observedAtMs, "transportCollision.observedAtMs"),
  });
}

export type ChannelPositionRecoveryRecord = ScopedIngressRecord<{
  readonly recoveryId: A1SafeId;
  readonly gapId: A1SafeId;
  readonly reason: BrokerRouteGapReason;
  readonly decision: (typeof CHANNEL_POSITION_RECOVERY_DECISIONS)[number];
  readonly evidenceRef: ProtectedHandleId;
  readonly evidenceDigest: A1Digest;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly decidedAtMs: number;
}>;
const RECOVERY_KEYS = [
  "recoveryId",
  "gapId",
  ...SCOPE_KEYS,
  "reason",
  "decision",
  "evidenceRef",
  "evidenceDigest",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "decidedAtMs",
] as const;
export function parseChannelPositionRecoveryRecord(value: unknown): ChannelPositionRecoveryRecord {
  const row = parseExactRecord(value, RECOVERY_KEYS, "channelPositionRecovery");
  return frozen({
    recoveryId: parseA1SafeId(row.recoveryId),
    gapId: parseA1SafeId(row.gapId),
    ...scopeFromRow(row, "channelPositionRecovery.scope"),
    reason: parseEnum(row.reason, BROKER_ROUTE_GAP_REASONS, "channelPositionRecovery.reason"),
    decision: parseEnum(
      row.decision,
      CHANNEL_POSITION_RECOVERY_DECISIONS,
      "channelPositionRecovery.decision",
    ),
    evidenceRef: protectedHandle(row.evidenceRef, "channelPositionRecovery.evidenceRef"),
    evidenceDigest: parseA1Digest(row.evidenceDigest),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "channelPositionRecovery.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "channelPositionRecovery.epoch",
    ),
    decidedAtMs: parseNonNegativeSafeInteger(
      row.decidedAtMs,
      "channelPositionRecovery.decidedAtMs",
    ),
  });
}

export type AuthenticatedIngressResultRecord = ScopedIngressRecord<{
  readonly stableSemanticResultId: A1SafeId;
  readonly sourceEventNamespaceId: A1SafeId;
  readonly messageId: A1SafeId;
  readonly recordKind: A1RecordKind;
  readonly clientMessageId: A1SafeId | null;
  readonly expectedParts: number;
  readonly sourcePayloadSchemaId: string | null;
  readonly canonicalMessageDigest: A1Digest | null;
  readonly sourceEventFingerprintSchemaId: string | null;
  readonly sourceEventFingerprint: A1Digest | null;
  readonly acceptedDeliveryAttemptId: A1SafeId | null;
  readonly firstIngressGeneration: number;
  readonly firstIngressFrameIndex: number;
  readonly lastObservedIngressGeneration: number;
  readonly lastObservedIngressFrameIndex: number;
  readonly assemblyDeadlineMs: number;
  readonly state: (typeof AUTHENTICATED_INGRESS_RESULT_STATES)[number];
  readonly collisionAtMs: number | null;
  readonly terminalAtMs: number | null;
}>;
const RESULT_KEYS = [
  "stableSemanticResultId",
  ...SCOPE_KEYS,
  "sourceEventNamespaceId",
  "messageId",
  "recordKind",
  "clientMessageId",
  "expectedParts",
  "sourcePayloadSchemaId",
  "canonicalMessageDigest",
  "sourceEventFingerprintSchemaId",
  "sourceEventFingerprint",
  "acceptedDeliveryAttemptId",
  "firstIngressGeneration",
  "firstIngressFrameIndex",
  "lastObservedIngressGeneration",
  "lastObservedIngressFrameIndex",
  "assemblyDeadlineMs",
  "state",
  "collisionAtMs",
  "terminalAtMs",
] as const;
export function parseAuthenticatedIngressResultRecord(
  value: unknown,
): AuthenticatedIngressResultRecord {
  const row = parseExactRecord(value, RESULT_KEYS, "authenticatedIngressResult");
  const state = parseEnum(
    row.state,
    AUTHENTICATED_INGRESS_RESULT_STATES,
    "authenticatedIngressResult.state",
  );
  const sourcePayloadSchemaId = parseNullable(
    row.sourcePayloadSchemaId,
    parseNonEmptyString,
    "authenticatedIngressResult.payloadSchema",
  );
  const canonicalMessageDigest = nullableDigest(
    row.canonicalMessageDigest,
    "authenticatedIngressResult.messageDigest",
  );
  const sourceEventFingerprintSchemaId = parseNullable(
    row.sourceEventFingerprintSchemaId,
    parseNonEmptyString,
    "authenticatedIngressResult.fingerprintSchema",
  );
  const sourceEventFingerprint = nullableDigest(
    row.sourceEventFingerprint,
    "authenticatedIngressResult.fingerprint",
  );
  const acceptedDeliveryAttemptId =
    row.acceptedDeliveryAttemptId === null
      ? null
      : deliveryAttemptId(
          row.acceptedDeliveryAttemptId,
          "authenticatedIngressResult.acceptedDeliveryAttemptId",
        );
  const completeTuple = [
    sourcePayloadSchemaId,
    canonicalMessageDigest,
    sourceEventFingerprintSchemaId,
    sourceEventFingerprint,
    acceptedDeliveryAttemptId,
  ];
  const hasCompleteTuple = completeTuple.every((entry) => entry !== null);
  const hasNullTuple = completeTuple.every((entry) => entry === null);
  const collisionAtMs = nullableTime(row.collisionAtMs, "authenticatedIngressResult.collisionAtMs");
  const terminalAtMs = nullableTime(row.terminalAtMs, "authenticatedIngressResult.terminalAtMs");
  const scope = scopeFromRow(row, "authenticatedIngressResult.scope");
  const recordKind = parseEnum(
    row.recordKind,
    RECORD_KINDS,
    "authenticatedIngressResult.recordKind",
  );
  const clientMessageId = nullableSafeId(
    row.clientMessageId,
    "authenticatedIngressResult.clientMessageId",
  );
  if (
    (state === "awaiting_order" && !hasCompleteTuple) ||
    ((state === "assembling" || state === "quarantined_incomplete") && !hasNullTuple) ||
    (state === "quarantined_collision" && !hasCompleteTuple && !hasNullTuple)
  ) {
    throw new RangeError("authenticated ingress result completion tuple is invalid");
  }
  if (
    sourceEventFingerprintSchemaId !== null &&
    sourceEventFingerprintSchemaId !== "remote-claw/a1/source-event-fingerprint/v1"
  ) {
    throw new RangeError("authenticated ingress result fingerprint schema is not selected");
  }
  if (
    scope.routeKind === "scope_bus" ||
    (scope.routeKind === "chat" && recordKind !== "user") ||
    (scope.routeKind === "server_control" && recordKind !== "new_chat") ||
    clientMessageId === null
  ) {
    throw new RangeError("authenticated ingress result route/header tuple is invalid");
  }
  if (
    ((state === "assembling" || state === "awaiting_order") &&
      (collisionAtMs !== null || terminalAtMs !== null)) ||
    (state === "quarantined_incomplete" && (collisionAtMs !== null || terminalAtMs === null)) ||
    (state === "quarantined_collision" && (collisionAtMs === null || terminalAtMs === null))
  ) {
    throw new RangeError("authenticated ingress result terminal timestamp tuple is invalid");
  }
  return frozen({
    stableSemanticResultId: resultId(row.stableSemanticResultId, "authenticatedIngressResult.id"),
    ...scope,
    sourceEventNamespaceId: namespaceId(
      row.sourceEventNamespaceId,
      "authenticatedIngressResult.namespaceId",
    ),
    messageId: parseA1SafeId(row.messageId, "authenticatedIngressResult.messageId"),
    recordKind,
    clientMessageId,
    expectedParts: (() => {
      const parsed = parsePositiveSafeInteger(
        row.expectedParts,
        "authenticatedIngressResult.parts",
      );
      if (parsed > A1_INGRESS_MAX_PARTS) throw new RangeError("result parts exceeds limit");
      return parsed;
    })(),
    sourcePayloadSchemaId,
    canonicalMessageDigest,
    sourceEventFingerprintSchemaId,
    sourceEventFingerprint,
    acceptedDeliveryAttemptId,
    firstIngressGeneration: parseNonNegativeSafeInteger(
      row.firstIngressGeneration,
      "authenticatedIngressResult.firstGeneration",
    ),
    firstIngressFrameIndex: bounded(
      row.firstIngressFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "authenticatedIngressResult.firstFrameIndex",
    ),
    lastObservedIngressGeneration: parseNonNegativeSafeInteger(
      row.lastObservedIngressGeneration,
      "authenticatedIngressResult.lastGeneration",
    ),
    lastObservedIngressFrameIndex: bounded(
      row.lastObservedIngressFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "authenticatedIngressResult.lastFrameIndex",
    ),
    assemblyDeadlineMs: parseNonNegativeSafeInteger(
      row.assemblyDeadlineMs,
      "authenticatedIngressResult.deadline",
    ),
    state,
    collisionAtMs,
    terminalAtMs,
  });
}

export type IngressTransportAttemptRecord = ScopedIngressRecord<{
  readonly deliveryAttemptId: A1SafeId;
  readonly sourceEventNamespaceId: A1SafeId;
  readonly stableSemanticResultId: A1SafeId;
  readonly messageId: A1SafeId;
  readonly recordKind: A1RecordKind;
  readonly clientMessageId: A1SafeId | null;
  readonly stableLogicalHeaderDigest: A1Digest;
  readonly expectedParts: number;
  readonly bindingDisposition: "exact" | "collision";
  readonly collisionGapId: A1SafeId | null;
  readonly candidateRequiredResultId: A1SafeId | null;
}>;
const ATTEMPT_KEYS = [
  ...SCOPE_KEYS,
  "deliveryAttemptId",
  "sourceEventNamespaceId",
  "stableSemanticResultId",
  "messageId",
  "recordKind",
  "clientMessageId",
  "stableLogicalHeaderDigest",
  "expectedParts",
  "bindingDisposition",
  "collisionGapId",
  "candidateRequiredResultId",
] as const;
export function parseIngressTransportAttemptRecord(value: unknown): IngressTransportAttemptRecord {
  const row = parseExactRecord(value, ATTEMPT_KEYS, "ingressTransportAttempt");
  const bindingDisposition = parseEnum(
    row.bindingDisposition,
    ["exact", "collision"] as const,
    "ingressTransportAttempt.bindingDisposition",
  );
  const collisionGapId = nullableSafeId(
    row.collisionGapId,
    "ingressTransportAttempt.collisionGapId",
  );
  const candidateRequiredResultId = nullableSafeId(
    row.candidateRequiredResultId,
    "ingressTransportAttempt.candidateRequiredResultId",
  );
  if (
    (bindingDisposition === "exact" &&
      (collisionGapId !== null || candidateRequiredResultId !== row.stableSemanticResultId)) ||
    (bindingDisposition === "collision" &&
      (collisionGapId === null || candidateRequiredResultId !== null))
  ) {
    throw new RangeError("transport-attempt collision binding tuple is invalid");
  }
  return frozen({
    ...scopeFromRow(row, "ingressTransportAttempt.scope"),
    deliveryAttemptId: deliveryAttemptId(
      row.deliveryAttemptId,
      "ingressTransportAttempt.attemptId",
    ),
    sourceEventNamespaceId: namespaceId(
      row.sourceEventNamespaceId,
      "ingressTransportAttempt.namespace",
    ),
    stableSemanticResultId: resultId(row.stableSemanticResultId, "ingressTransportAttempt.result"),
    messageId: parseA1SafeId(row.messageId),
    recordKind: parseEnum(row.recordKind, RECORD_KINDS, "ingressTransportAttempt.recordKind"),
    clientMessageId: nullableSafeId(row.clientMessageId, "ingressTransportAttempt.clientMessageId"),
    stableLogicalHeaderDigest: parseA1Digest(row.stableLogicalHeaderDigest),
    expectedParts: (() => {
      const parsed = parsePositiveSafeInteger(row.expectedParts, "ingressTransportAttempt.parts");
      if (parsed > A1_INGRESS_MAX_PARTS) throw new RangeError("attempt parts exceeds limit");
      return parsed;
    })(),
    bindingDisposition,
    collisionGapId,
    candidateRequiredResultId,
  });
}

export type IngressDeliveryCandidateRecord = ScopedIngressRecord<{
  readonly stableSemanticResultId: A1SafeId;
  readonly deliveryAttemptId: A1SafeId;
  readonly expectedParts: number;
  readonly receivedParts: number;
  readonly plaintextByteCount: number;
  readonly firstIngressGeneration: number;
  readonly firstIngressFrameIndex: number;
  readonly lastObservedIngressGeneration: number;
  readonly lastObservedIngressFrameIndex: number;
  readonly state: (typeof INGRESS_CANDIDATE_STATES)[number];
}>;
const CANDIDATE_KEYS = [
  "stableSemanticResultId",
  "deliveryAttemptId",
  ...SCOPE_KEYS,
  "expectedParts",
  "receivedParts",
  "plaintextByteCount",
  "firstIngressGeneration",
  "firstIngressFrameIndex",
  "lastObservedIngressGeneration",
  "lastObservedIngressFrameIndex",
  "state",
] as const;
export function parseIngressDeliveryCandidateRecord(
  value: unknown,
): IngressDeliveryCandidateRecord {
  const row = parseExactRecord(value, CANDIDATE_KEYS, "ingressCandidate");
  const expectedParts = parsePositiveSafeInteger(
    row.expectedParts,
    "ingressCandidate.expectedParts",
  );
  if (expectedParts > A1_INGRESS_MAX_PARTS) throw new RangeError("candidate parts exceeds limit");
  const receivedParts = bounded(row.receivedParts, expectedParts, "ingressCandidate.receivedParts");
  const state = parseEnum(row.state, INGRESS_CANDIDATE_STATES, "ingressCandidate.state");
  if (
    (state === "complete" && receivedParts !== expectedParts) ||
    (state === "assembling" && receivedParts === expectedParts)
  ) {
    throw new RangeError("candidate completion does not match received part count");
  }
  return frozen({
    stableSemanticResultId: resultId(row.stableSemanticResultId, "ingressCandidate.result"),
    deliveryAttemptId: deliveryAttemptId(row.deliveryAttemptId, "ingressCandidate.attemptId"),
    ...scopeFromRow(row, "ingressCandidate.scope"),
    expectedParts,
    receivedParts,
    plaintextByteCount: bounded(
      row.plaintextByteCount,
      A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES,
      "ingressCandidate.plaintextByteCount",
    ),
    firstIngressGeneration: parseNonNegativeSafeInteger(
      row.firstIngressGeneration,
      "ingressCandidate.firstGen",
    ),
    firstIngressFrameIndex: bounded(
      row.firstIngressFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "ingressCandidate.firstIndex",
    ),
    lastObservedIngressGeneration: parseNonNegativeSafeInteger(
      row.lastObservedIngressGeneration,
      "ingressCandidate.lastGen",
    ),
    lastObservedIngressFrameIndex: bounded(
      row.lastObservedIngressFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "ingressCandidate.lastIndex",
    ),
    state,
  });
}

export type AuthenticatedIngressPartRecord = ScopedIngressRecord<{
  readonly stableSemanticResultId: A1SafeId;
  readonly deliveryAttemptId: A1SafeId;
  readonly part: number;
  readonly parts: number;
  readonly authenticatedPartDigest: A1Digest;
  readonly plaintextPartRef: ProtectedHandleId;
  readonly plaintextPartDigest: A1Digest;
  readonly plaintextPartByteLength: number;
  readonly firstIngressGeneration: number;
  readonly firstIngressFrameIndex: number;
}>;
const PART_KEYS = [
  "stableSemanticResultId",
  "deliveryAttemptId",
  "part",
  ...SCOPE_KEYS,
  "parts",
  "authenticatedPartDigest",
  "plaintextPartRef",
  "plaintextPartDigest",
  "plaintextPartByteLength",
  "firstIngressGeneration",
  "firstIngressFrameIndex",
] as const;
export function parseAuthenticatedIngressPartRecord(
  value: unknown,
): AuthenticatedIngressPartRecord {
  const row = parseExactRecord(value, PART_KEYS, "authenticatedIngressPart");
  const parts = parsePositiveSafeInteger(row.parts, "authenticatedIngressPart.parts");
  if (parts > A1_INGRESS_MAX_PARTS) throw new RangeError("part count exceeds limit");
  return frozen({
    stableSemanticResultId: resultId(row.stableSemanticResultId, "authenticatedIngressPart.result"),
    deliveryAttemptId: deliveryAttemptId(
      row.deliveryAttemptId,
      "authenticatedIngressPart.attemptId",
    ),
    part: bounded(row.part, parts - 1, "authenticatedIngressPart.part"),
    ...scopeFromRow(row, "authenticatedIngressPart.scope"),
    parts,
    authenticatedPartDigest: parseA1Digest(row.authenticatedPartDigest),
    plaintextPartRef: protectedHandle(row.plaintextPartRef, "authenticatedIngressPart.ref"),
    plaintextPartDigest: parseA1Digest(row.plaintextPartDigest),
    plaintextPartByteLength: bounded(
      row.plaintextPartByteLength,
      A1_INGRESS_MAX_OPENED_PART_BYTES,
      "authenticatedIngressPart.byteLength",
    ),
    firstIngressGeneration: parseNonNegativeSafeInteger(
      row.firstIngressGeneration,
      "authenticatedIngressPart.firstGen",
    ),
    firstIngressFrameIndex: bounded(
      row.firstIngressFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "authenticatedIngressPart.firstIndex",
    ),
  });
}

export type AuthenticatedIngressObservationRecord = ScopedIngressRecord<{
  readonly ingressObservationId: A1SafeId;
  readonly channelPositionObservationId: A1SafeId;
  readonly stableSemanticResultId: A1SafeId;
  readonly deliveryAttemptId: A1SafeId;
  readonly channelGeneration: number;
  readonly frameIndex: number;
  readonly part: number;
  readonly parts: number;
  readonly authenticatedPartDigest: A1Digest;
  readonly plaintextEvidenceRef: ProtectedHandleId;
  readonly plaintextEvidenceDigest: A1Digest;
  readonly plaintextEvidenceByteLength: number;
  readonly disposition: (typeof INGRESS_OBSERVATION_DISPOSITIONS)[number];
  readonly cursorDisposition: IngressCursorDisposition;
  readonly gapId: A1SafeId | null;
  readonly recoveryId: A1SafeId | null;
}>;
const OBSERVATION_KEYS = [
  "ingressObservationId",
  "channelPositionObservationId",
  "stableSemanticResultId",
  "deliveryAttemptId",
  ...SCOPE_KEYS,
  "channelGeneration",
  "frameIndex",
  "part",
  "parts",
  "authenticatedPartDigest",
  "plaintextEvidenceRef",
  "plaintextEvidenceDigest",
  "plaintextEvidenceByteLength",
  "disposition",
  "cursorDisposition",
  "gapId",
  "recoveryId",
] as const;
export function parseAuthenticatedIngressObservationRecord(
  value: unknown,
): AuthenticatedIngressObservationRecord {
  const row = parseExactRecord(value, OBSERVATION_KEYS, "authenticatedIngressObservation");
  const parts = parsePositiveSafeInteger(row.parts, "ingressObservation.parts");
  if (parts > A1_INGRESS_MAX_PARTS) throw new RangeError("observation parts exceeds limit");
  const disposition = parseEnum(
    row.disposition,
    INGRESS_OBSERVATION_DISPOSITIONS,
    "ingressObservation.disposition",
  );
  const cursorDisposition = parseEnum(
    row.cursorDisposition,
    INGRESS_CURSOR_DISPOSITIONS,
    "ingressObservation.cursorDisposition",
  );
  const gapId = nullableSafeId(row.gapId, "ingressObservation.gapId");
  const recoveryId = nullableSafeId(row.recoveryId, "ingressObservation.recoveryId");
  if (
    (disposition === "collision" &&
      (gapId === null ||
        (recoveryId === null
          ? cursorDisposition !== "blocked"
          : cursorDisposition !== "advanceable"))) ||
    (disposition === "invalid_payload" &&
      (gapId === null || recoveryId !== null || cursorDisposition !== "advanceable")) ||
    (disposition === "late_after_tombstone" &&
      !(
        (cursorDisposition === "advanceable" && gapId === null && recoveryId === null) ||
        (cursorDisposition === "blocked" && gapId !== null && recoveryId === null) ||
        (cursorDisposition === "advanceable" && gapId !== null && recoveryId !== null)
      )) ||
    (!["collision", "invalid_payload", "late_after_tombstone"].includes(disposition) &&
      !(
        (gapId === null && recoveryId === null) ||
        (gapId === null && recoveryId !== null && cursorDisposition === "advanceable")
      ))
  ) {
    throw new RangeError("authenticated ingress observation disposition tuple is invalid");
  }
  return frozen({
    ingressObservationId: observationId(row.ingressObservationId, "ingressObservation.id"),
    channelPositionObservationId: positionId(
      row.channelPositionObservationId,
      "ingressObservation.positionId",
    ),
    stableSemanticResultId: resultId(row.stableSemanticResultId, "ingressObservation.resultId"),
    deliveryAttemptId: deliveryAttemptId(row.deliveryAttemptId, "ingressObservation.attemptId"),
    ...scopeFromRow(row, "ingressObservation.scope"),
    channelGeneration: parseNonNegativeSafeInteger(
      row.channelGeneration,
      "ingressObservation.generation",
    ),
    frameIndex: bounded(
      row.frameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "ingressObservation.frameIndex",
    ),
    part: bounded(row.part, parts - 1, "ingressObservation.part"),
    parts,
    authenticatedPartDigest: parseA1Digest(row.authenticatedPartDigest),
    plaintextEvidenceRef: protectedHandle(
      row.plaintextEvidenceRef,
      "ingressObservation.plaintextEvidenceRef",
    ),
    plaintextEvidenceDigest: parseA1Digest(
      row.plaintextEvidenceDigest,
      "ingressObservation.plaintextEvidenceDigest",
    ),
    plaintextEvidenceByteLength: bounded(
      row.plaintextEvidenceByteLength,
      A1_INGRESS_MAX_OPENED_PART_BYTES,
      "ingressObservation.plaintextEvidenceByteLength",
    ),
    disposition,
    cursorDisposition,
    gapId,
    recoveryId,
  });
}

export type BrokerRouteActorRecord = ScopedIngressRecord<{
  readonly revision: number;
  readonly claimToken: A1SafeId | null;
  readonly coordinatorLeaseId: CoordinatorLeaseId | null;
  readonly coordinatorEpoch: number | null;
  readonly claimedAtMs: number | null;
  readonly lastOperationId: A1SafeId | null;
  readonly lastOperationKind: A1SafeId | null;
  readonly lastOperationDigest: A1Digest | null;
  readonly updatedAtMs: number;
}>;
const ACTOR_KEYS = [
  ...SCOPE_KEYS,
  "revision",
  "claimToken",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "claimedAtMs",
  "lastOperationId",
  "lastOperationKind",
  "lastOperationDigest",
  "updatedAtMs",
] as const;
export function parseBrokerRouteActorRecord(value: unknown): BrokerRouteActorRecord {
  const row = parseExactRecord(value, ACTOR_KEYS, "brokerRouteActor");
  const claimToken = nullableSafeId(row.claimToken, "brokerRouteActor.claimToken");
  const coordinatorLeaseId = parseNullable(
    row.coordinatorLeaseId,
    (input, field) => parseA1CanonicalId("coordinatorLease", input, field),
    "brokerRouteActor.coordinatorLeaseId",
  );
  const coordinatorEpoch = parseNullable(
    row.coordinatorEpoch,
    parsePositiveSafeInteger,
    "brokerRouteActor.coordinatorEpoch",
  );
  const claimedAtMs = nullableTime(row.claimedAtMs, "brokerRouteActor.claimedAtMs");
  if (
    (claimToken === null) !==
    (coordinatorLeaseId === null && coordinatorEpoch === null && claimedAtMs === null)
  ) {
    throw new RangeError("broker route actor claim tuple must be null or present together");
  }
  const lastOperationId = nullableSafeId(row.lastOperationId, "brokerRouteActor.lastOperationId");
  const lastOperationKind = nullableSafeId(
    row.lastOperationKind,
    "brokerRouteActor.lastOperationKind",
  );
  const lastOperationDigest = nullableDigest(
    row.lastOperationDigest,
    "brokerRouteActor.lastOperationDigest",
  );
  if ((lastOperationId === null) !== (lastOperationKind === null && lastOperationDigest === null)) {
    throw new RangeError("broker route actor operation tuple must be null or present together");
  }
  return frozen({
    ...scopeFromRow(row, "brokerRouteActor.scope"),
    revision: parseNonNegativeSafeInteger(row.revision, "brokerRouteActor.revision"),
    claimToken,
    coordinatorLeaseId,
    coordinatorEpoch,
    claimedAtMs,
    lastOperationId,
    lastOperationKind,
    lastOperationDigest,
    updatedAtMs: parseNonNegativeSafeInteger(row.updatedAtMs, "brokerRouteActor.updatedAtMs"),
  });
}

export type BrokerReadPageObservationRecord = ScopedIngressRecord<{
  readonly readPageObservationId: A1SafeId;
  readonly routeStoreInstanceId: BrokerRouteStoreInstanceId;
  readonly requestedGeneration: number;
  readonly requestedFrameIndex: number;
  readonly nextGeneration: number;
  readonly nextFrameIndex: number;
  readonly generationState: "open" | "sealed";
  readonly generationFrameCount: number | null;
  readonly generationNextGeneration: number | null;
  readonly generationManifestDigest: A1Digest | null;
  readonly observedNextFrameIndex: number;
  readonly frameCountInPage: number;
  readonly frameClaimsDigest: A1Digest;
  readonly atLiveTail: boolean;
  readonly operationId: A1SafeId;
  readonly evidenceRef: ProtectedHandleId;
  readonly evidenceDigest: A1Digest;
  readonly observedAtMs: number;
}>;

const READ_PAGE_OBSERVATION_KEYS = [
  "readPageObservationId",
  ...SCOPE_KEYS,
  "routeStoreInstanceId",
  "requestedGeneration",
  "requestedFrameIndex",
  "nextGeneration",
  "nextFrameIndex",
  "generationState",
  "generationFrameCount",
  "generationNextGeneration",
  "generationManifestDigest",
  "observedNextFrameIndex",
  "frameCountInPage",
  "frameClaimsDigest",
  "atLiveTail",
  "operationId",
  "evidenceRef",
  "evidenceDigest",
  "observedAtMs",
] as const;

export function parseBrokerReadPageObservationRecord(
  value: unknown,
): BrokerReadPageObservationRecord {
  const row = parseExactRecord(value, READ_PAGE_OBSERVATION_KEYS, "brokerReadPageObservation");
  const generationState = parseEnum(
    row.generationState,
    BROKER_GENERATION_OBSERVATION_STATES,
    "brokerReadPageObservation.generationState",
  );
  const generationFrameCount = parseNullable(
    row.generationFrameCount,
    (entry, field) => bounded(entry, A1_BROKER_GENERATION_FRAME_CAP, field),
    "brokerReadPageObservation.generationFrameCount",
  );
  const generationNextGeneration = parseNullable(
    row.generationNextGeneration,
    parsePositiveSafeInteger,
    "brokerReadPageObservation.generationNextGeneration",
  );
  const generationManifestDigest = nullableDigest(
    row.generationManifestDigest,
    "brokerReadPageObservation.generationManifestDigest",
  );
  if (
    (generationState === "open" &&
      (generationFrameCount !== null ||
        generationNextGeneration !== null ||
        generationManifestDigest !== null)) ||
    (generationState === "sealed" &&
      (generationFrameCount === null ||
        generationNextGeneration === null ||
        generationManifestDigest === null))
  ) {
    throw new RangeError("broker read-page generation tuple is invalid");
  }
  if (row.atLiveTail !== 0 && row.atLiveTail !== 1) {
    throw new RangeError("broker read-page live-tail flag must be 0 or 1");
  }
  return frozen({
    readPageObservationId: parseA1SafeId(row.readPageObservationId),
    ...scopeFromRow(row, "brokerReadPageObservation.scope"),
    routeStoreInstanceId: parseBrokerRouteStoreInstanceId(row.routeStoreInstanceId),
    requestedGeneration: parseNonNegativeSafeInteger(
      row.requestedGeneration,
      "brokerReadPageObservation.requestedGeneration",
    ),
    requestedFrameIndex: bounded(
      row.requestedFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP,
      "brokerReadPageObservation.requestedFrameIndex",
    ),
    nextGeneration: parseNonNegativeSafeInteger(
      row.nextGeneration,
      "brokerReadPageObservation.nextGeneration",
    ),
    nextFrameIndex: bounded(
      row.nextFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP,
      "brokerReadPageObservation.nextFrameIndex",
    ),
    generationState,
    generationFrameCount,
    generationNextGeneration,
    generationManifestDigest,
    observedNextFrameIndex: bounded(
      row.observedNextFrameIndex,
      A1_BROKER_GENERATION_FRAME_CAP,
      "brokerReadPageObservation.observedNextFrameIndex",
    ),
    frameCountInPage: bounded(
      row.frameCountInPage,
      64,
      "brokerReadPageObservation.frameCountInPage",
    ),
    frameClaimsDigest: parseA1Digest(row.frameClaimsDigest),
    atLiveTail: row.atLiveTail === 1,
    operationId: parseA1SafeId(row.operationId),
    evidenceRef: protectedHandle(row.evidenceRef, "brokerReadPageObservation.evidenceRef"),
    evidenceDigest: parseA1Digest(row.evidenceDigest),
    observedAtMs: parseNonNegativeSafeInteger(
      row.observedAtMs,
      "brokerReadPageObservation.observedAtMs",
    ),
  });
}

export type BrokerReadPageFrameEvidenceRecord = ScopedIngressRecord<{
  readonly readPageObservationId: A1SafeId;
  readonly ordinal: number;
  readonly channelPositionObservationId: A1SafeId;
  readonly channelGeneration: number;
  readonly frameIndex: number;
  readonly claimedDeliveryAttemptId: A1SafeId;
  readonly claimedPart: number;
  readonly claimedTransportFrameDigest: A1Digest;
  readonly receivedFrameRef: ProtectedHandleId;
  readonly receivedFrameDigest: A1Digest;
  readonly receivedFrameByteLength: number;
}>;

const READ_PAGE_FRAME_EVIDENCE_KEYS = [
  "readPageObservationId",
  "ordinal",
  ...SCOPE_KEYS,
  "channelPositionObservationId",
  "channelGeneration",
  "frameIndex",
  "claimedDeliveryAttemptId",
  "claimedPart",
  "claimedTransportFrameDigest",
  "receivedFrameRef",
  "receivedFrameDigest",
  "receivedFrameByteLength",
] as const;

export function parseBrokerReadPageFrameEvidenceRecord(
  value: unknown,
): BrokerReadPageFrameEvidenceRecord {
  const row = parseExactRecord(value, READ_PAGE_FRAME_EVIDENCE_KEYS, "brokerReadPageFrameEvidence");
  return frozen({
    readPageObservationId: parseA1SafeId(row.readPageObservationId),
    ordinal: bounded(row.ordinal, 63, "brokerReadPageFrameEvidence.ordinal"),
    ...scopeFromRow(row, "brokerReadPageFrameEvidence.scope"),
    channelPositionObservationId: positionId(
      row.channelPositionObservationId,
      "brokerReadPageFrameEvidence.positionId",
    ),
    channelGeneration: parseNonNegativeSafeInteger(
      row.channelGeneration,
      "brokerReadPageFrameEvidence.generation",
    ),
    frameIndex: bounded(
      row.frameIndex,
      A1_BROKER_GENERATION_FRAME_CAP - 1,
      "brokerReadPageFrameEvidence.frameIndex",
    ),
    claimedDeliveryAttemptId: deliveryAttemptId(
      row.claimedDeliveryAttemptId,
      "brokerReadPageFrameEvidence.attemptId",
    ),
    claimedPart: bounded(
      row.claimedPart,
      A1_INGRESS_MAX_PARTS - 1,
      "brokerReadPageFrameEvidence.part",
    ),
    claimedTransportFrameDigest: parseA1Digest(row.claimedTransportFrameDigest),
    receivedFrameRef: protectedHandle(row.receivedFrameRef, "brokerReadPageFrameEvidence.ref"),
    receivedFrameDigest: parseA1Digest(row.receivedFrameDigest),
    receivedFrameByteLength: bounded(
      row.receivedFrameByteLength,
      4_450_000,
      "brokerReadPageFrameEvidence.byteLength",
    ),
  });
}

export interface IngressRepositorySnapshot {
  readonly runtimeStatuses: readonly BrokerRouteRuntimeStatusRecord[];
  readonly generationObservations: readonly BrokerChannelGenerationObservationRecord[];
  readonly fetchCursors: readonly BrokerRouteFetchCursorRecord[];
  readonly semanticCursors: readonly BrokerRouteSemanticCursorRecord[];
  readonly gaps: readonly BrokerRouteGapRecord[];
  readonly positions: readonly AuthenticatedChannelPositionRecord[];
  readonly positionEquivocations: readonly ChannelPositionEquivocationRecord[];
  readonly manifestEquivocations: readonly BrokerChannelManifestEquivocationRecord[];
  readonly transportCollisions: readonly BrokerTransportKeyCollisionRecord[];
  readonly recoveries: readonly ChannelPositionRecoveryRecord[];
  readonly results: readonly AuthenticatedIngressResultRecord[];
  readonly attempts: readonly IngressTransportAttemptRecord[];
  readonly candidates: readonly IngressDeliveryCandidateRecord[];
  readonly parts: readonly AuthenticatedIngressPartRecord[];
  readonly observations: readonly AuthenticatedIngressObservationRecord[];
  readonly actors: readonly BrokerRouteActorRecord[];
  readonly readPageObservations: readonly BrokerReadPageObservationRecord[];
  readonly readPageFrameEvidence: readonly BrokerReadPageFrameEvidenceRecord[];
}

void A1_INGRESS_ASSEMBLY_DEADLINE_MS;
