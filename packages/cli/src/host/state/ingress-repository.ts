import { createHash } from "node:crypto";
import {
  A1_BROKER_MAX_READ_FRAMES,
  A1_INGRESS_ASSEMBLY_DEADLINE_MS,
  A1_INGRESS_LOOKAHEAD_MAX_BYTES,
  A1_INGRESS_LOOKAHEAD_MAX_FRAMES,
  A1_INGRESS_MAX_CANDIDATES_PER_RESULT,
  A1_INGRESS_MAX_OPENED_PART_BYTES,
  A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY,
  A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE,
  A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE,
  type A1FrameHeaderV2,
  assertA1FrameMatchesRoute,
  type BrokerChannelCursorV1,
  type BrokerChannelGenerationRecordV1,
  type BrokerReadPositionV1,
  CanonicalWriter,
  canonicalA1Aad,
  canonicalA1BrokerGenerationManifestV1,
  canonicalA1ChannelPositionObservationPreimage,
  canonicalA1IngressObservationPreimage,
  canonicalA1IngressSourceEventFingerprintPreimage,
  canonicalA1IngressStableLogicalHeader,
  canonicalA1StableLogicalHeader,
  canonicalA1StableSemanticResultPreimage,
  canonicalA1WebSourceNamespacePreimage,
  normalizedA1TransportFrameBytes,
  parseA1EncryptedFrameV2,
  parseBrokerChannelCursorV1,
  parseBrokerReadPositionV1,
  parseSelectedA1InboundPayload,
} from "@remote-claw/clawsec";
import {
  type BrokerRouteId,
  type BrokerRouteStoreInstanceId,
  parseBrokerRouteId,
  parseBrokerRouteStoreInstanceId,
} from "./broker-route.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  HostStateContractError,
  type LogicalChatId,
  type ProtectedHandleId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
} from "./ids.js";
import {
  type AuthenticatedChannelPositionRecord,
  type AuthenticatedIngressObservationRecord,
  type AuthenticatedIngressPartRecord,
  type AuthenticatedIngressResultRecord,
  type BrokerChannelGenerationObservationRecord,
  type BrokerChannelManifestEquivocationRecord,
  type BrokerReadPageFrameEvidenceRecord,
  type BrokerReadPageObservationRecord,
  type BrokerRouteFetchCursorRecord,
  type BrokerRouteGapRecord,
  type BrokerRouteRuntimeStatusRecord,
  type BrokerRouteSemanticCursorRecord,
  type BrokerTransportKeyCollisionRecord,
  type ChannelPositionEquivocationRecord,
  type ChannelPositionRecoveryRecord,
  type IngressDeliveryCandidateRecord,
  type IngressRepositorySnapshot,
  type IngressTransportAttemptRecord,
  parseAuthenticatedChannelPositionRecord,
  parseAuthenticatedIngressObservationRecord,
  parseAuthenticatedIngressPartRecord,
  parseAuthenticatedIngressResultRecord,
  parseBrokerChannelGenerationObservationRecord,
  parseBrokerChannelManifestEquivocationRecord,
  parseBrokerReadPageFrameEvidenceRecord,
  parseBrokerReadPageObservationRecord,
  parseBrokerRouteActorRecord,
  parseBrokerRouteFetchCursorRecord,
  parseBrokerRouteGapRecord,
  parseBrokerRouteRuntimeStatusRecord,
  parseBrokerRouteSemanticCursorRecord,
  parseBrokerTransportKeyCollisionRecord,
  parseChannelPositionEquivocationRecord,
  parseChannelPositionRecoveryRecord,
  parseIngressDeliveryCandidateRecord,
  parseIngressTransportAttemptRecord,
  type BrokerRouteActorRecord as StoredBrokerRouteActorRecord,
} from "./ingress.js";
import {
  type CoordinatorLeaseFence,
  type CoordinatorLeaseRecord,
  parseCoordinatorLeaseRecord,
} from "./records.js";
import type {
  HostStateRepositorySqlRunResult,
  HostStateRepositorySqlTransaction,
  HostStateRepositorySqlValue,
  HostStateRepositoryTransactionExecutor,
} from "./repository.js";

export const A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID = "remote-claw/a1/received-frame/v1" as const;
export const A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID =
  "remote-claw/a1/opened-plaintext-part/v1" as const;
export const A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID =
  "remote-claw/a1/ingress-gap-evidence/v1" as const;
export const A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID =
  "remote-claw/a1/read-page-evidence/v1" as const;
export const A1_INGRESS_SOURCE_EVENT_FINGERPRINT_SCHEMA_ID =
  "remote-claw/a1/source-event-fingerprint/v1" as const;

// Data admission deliberately leaves a bounded slice of each hard retained-byte ceiling for the
// audit proof that explains why admission stopped. Audit mutations still preflight the hard cap;
// they can never make a successfully committed database fail its secure-reopen quota check.
const A1_INGRESS_AUDIT_RESERVE_BYTES_PER_ROUTE = 1024 * 1024;
const A1_INGRESS_AUDIT_RESERVE_BYTES_PER_IDENTITY = 16 * 1024 * 1024;
const A1_INGRESS_AUDIT_RESERVE_BYTES_GLOBAL = 64 * 1024 * 1024;

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

export interface IngressMutationCoordinate {
  readonly scope: BrokerRouteActorScope;
  readonly fence: CoordinatorLeaseFence;
  readonly actorClaimToken: A1SafeId;
  readonly expectedActorRevision: number;
  readonly operationId: A1SafeId;
  readonly observedAtMs: number;
}

export interface ClaimIngressRouteActorRequest {
  readonly scope: BrokerRouteActorScope;
  readonly fence: CoordinatorLeaseFence;
  readonly claimToken: A1SafeId;
  readonly expectedActorRevision: number;
  readonly operationId: A1SafeId;
  readonly observedAtMs: number;
}

export interface IngressRouteActorRecord {
  readonly scope: BrokerRouteActorScope;
  readonly revision: number;
  readonly claimToken: A1SafeId | null;
  readonly coordinatorLeaseId: string | null;
  readonly coordinatorEpoch: number | null;
  readonly claimedAtMs: number | null;
  readonly lastOperationId: A1SafeId | null;
  readonly lastOperationKind: string | null;
  readonly lastOperationDigest: A1Digest | null;
  readonly updatedAtMs: number;
}

export interface StageIngressFrameEvidence {
  readonly cursor: BrokerChannelCursorV1;
  readonly channelPositionObservationId: A1SafeId;
  /** Broker-authenticated outer claims; inner parsing is deliberately later. */
  readonly claimedDeliveryAttemptId: A1SafeId;
  readonly claimedPart: number;
  readonly claimedTransportFrameDigest: A1Digest;
  readonly receivedFrameRef: ProtectedHandleId;
  readonly receivedFrameDigest: A1Digest;
  readonly receivedFrameByteLength: number;
}

export interface StageIngressReadPageRequest extends IngressMutationCoordinate {
  readonly requestedPosition: BrokerReadPositionV1;
  readonly generation: BrokerChannelGenerationRecordV1;
  readonly observedNextFrameIndex: number;
  readonly frames: readonly StageIngressFrameEvidence[];
  readonly nextPosition: BrokerReadPositionV1;
  readonly atLiveTail: boolean;
  /** Exact protected outer evidence, also used for manifest-equivocation retention. */
  readonly pageEvidenceRef: ProtectedHandleId;
  readonly pageEvidenceDigest: A1Digest;
}

export interface LatchOuterPageGapRequest extends IngressMutationCoordinate {
  readonly evidenceRef: ProtectedHandleId;
  readonly evidenceDigest: A1Digest;
  readonly failureCode: A1SafeId;
}

export interface LatchIngressStorageQuotaGapRequest extends IngressMutationCoordinate {
  readonly evidenceRef: ProtectedHandleId;
  readonly evidenceDigest: A1Digest;
}

export interface ParsedIngressPositionEvidence {
  readonly channelPositionObservationId: A1SafeId;
  readonly normalizedTransportFrameDigest: A1Digest;
  readonly header: A1FrameHeaderV2;
}

export interface ClassifyInvalidIngressPositionRequest extends IngressMutationCoordinate {
  readonly channelPositionObservationId: A1SafeId;
  readonly parsed: ParsedIngressPositionEvidence | null;
  readonly validationFailureCode: A1SafeId;
  readonly gapEvidenceRef: ProtectedHandleId;
  readonly gapEvidenceDigest: A1Digest;
}

export interface ClassifyUnknownOutboundPositionRequest extends IngressMutationCoordinate {
  readonly parsed: ParsedIngressPositionEvidence;
  readonly gapEvidenceRef: ProtectedHandleId;
  readonly gapEvidenceDigest: A1Digest;
}

export interface ClassifyInboundPartRequest extends IngressMutationCoordinate {
  readonly parsed: ParsedIngressPositionEvidence;
  readonly sourceEventNamespaceId: A1SafeId;
  readonly stableSemanticResultId: A1SafeId;
  readonly ingressObservationId: A1SafeId;
  readonly plaintextPartRef: ProtectedHandleId;
  readonly plaintextPartDigest: A1Digest;
  readonly plaintextPartByteLength: number;
  readonly authenticatedPartDigest: A1Digest;
}

export interface ExpireIngressResultRequest extends IngressMutationCoordinate {
  readonly stableSemanticResultId: A1SafeId;
  readonly expectedAssemblyDeadlineMs: number;
}

export interface RecoverIngressGapRequest extends IngressMutationCoordinate {
  readonly gapId: A1SafeId;
  readonly recoveryId: A1SafeId;
  readonly decision: "discard_and_close_source" | "proved_safe_discard";
  readonly evidenceRef: ProtectedHandleId;
  readonly evidenceDigest: A1Digest;
}

export interface RecomputeIngressSemanticCursorRequest extends IngressMutationCoordinate {}

export interface IngressMutationResult {
  readonly actor: IngressRouteActorRecord;
  readonly replayed: boolean;
}

export interface IngressPartClassificationResult extends IngressMutationResult {
  readonly candidateState: "assembling" | "complete" | "expired" | "collision";
  readonly resultState:
    | "assembling"
    | "awaiting_order"
    | "quarantined_incomplete"
    | "quarantined_collision";
  readonly stableSemanticResultId: A1SafeId;
  readonly sourcePayloadSchemaId: string | null;
  readonly canonicalMessageDigest: A1Digest | null;
  readonly sourceEventFingerprint: A1Digest | null;
}

export interface PendingIngressPosition {
  readonly channelPositionObservationId: A1SafeId;
  readonly cursor: BrokerChannelCursorV1;
  readonly receivedFrameRef: ProtectedHandleId;
  readonly receivedFrameDigest: A1Digest;
  readonly receivedFrameByteLength: number;
  readonly claimedDeliveryAttemptId: A1SafeId;
  readonly claimedPart: number;
  readonly claimedTransportFrameDigest: A1Digest;
}

/** Bounded route-lane admission state used by the hot actor loop. */
export interface IngressRouteHead {
  readonly routeStoreInstanceId: BrokerRouteStoreInstanceId;
  readonly actor: StoredBrokerRouteActorRecord;
  readonly runtime: BrokerRouteRuntimeStatusRecord;
  readonly currentGeneration: BrokerChannelGenerationObservationRecord;
  readonly fetchCursor: BrokerRouteFetchCursorRecord;
  readonly semanticCursor: BrokerRouteSemanticCursorRecord;
  readonly hasOpenGaps: boolean;
  readonly hasOpenStorageQuotaGap: boolean;
}

/** The only result fields needed by the actor's bounded expiry loop. */
export interface DueAssemblingIngressResult {
  readonly stableSemanticResultId: A1SafeId;
  readonly assemblyDeadlineMs: number;
}

/** Durable semantic outcome reconstructed after an outcome-unknown classification COMMIT. */
export type IngressPositionClassification = Omit<
  IngressPartClassificationResult,
  "actor" | "replayed"
>;

export interface IngressRouteState {
  readonly actor: StoredBrokerRouteActorRecord;
  readonly runtime: BrokerRouteRuntimeStatusRecord;
  readonly generationObservations: readonly BrokerChannelGenerationObservationRecord[];
  readonly fetchCursor: BrokerRouteFetchCursorRecord;
  readonly semanticCursor: BrokerRouteSemanticCursorRecord;
  readonly gaps: readonly BrokerRouteGapRecord[];
  readonly positions: readonly AuthenticatedChannelPositionRecord[];
  readonly results: readonly AuthenticatedIngressResultRecord[];
  readonly attempts: readonly IngressTransportAttemptRecord[];
  readonly candidates: readonly IngressDeliveryCandidateRecord[];
  readonly parts: readonly AuthenticatedIngressPartRecord[];
  readonly observations: readonly AuthenticatedIngressObservationRecord[];
  readonly readPageObservations: readonly BrokerReadPageObservationRecord[];
  readonly readPageFrameEvidence: readonly BrokerReadPageFrameEvidenceRecord[];
}

export interface IngressRepositoryOperations {
  /** Diagnostic full-history inventory; actor hot paths must use the bounded reads below. */
  readRouteState(brokerRouteId: BrokerRouteId): IngressRouteState | null;
  readRouteHead(brokerRouteId: BrokerRouteId): IngressRouteHead | null;
  readNextDueAssemblingResult(
    brokerRouteId: BrokerRouteId,
    dueAtOrBeforeMs: number,
  ): DueAssemblingIngressResult | null;
  readPositionClassification(
    brokerRouteId: BrokerRouteId,
    ingressObservationId: A1SafeId,
  ): IngressPositionClassification | null;
  readPendingPositions(
    brokerRouteId: BrokerRouteId,
    limit?: number,
  ): readonly PendingIngressPosition[];
  claimRouteActor(request: ClaimIngressRouteActorRequest): IngressMutationResult;
  reconcileRouteActorClaim(request: ClaimIngressRouteActorRequest): IngressMutationResult | null;
  releaseRouteActor(request: IngressMutationCoordinate): IngressMutationResult;
  reconcileRouteActorRelease(request: IngressMutationCoordinate): IngressMutationResult | null;
  latchOuterPageGap(request: LatchOuterPageGapRequest): IngressMutationResult;
  reconcileOuterPageGap(request: LatchOuterPageGapRequest): IngressMutationResult | null;
  latchStorageQuotaGap(request: LatchIngressStorageQuotaGapRequest): IngressMutationResult;
  reconcileStorageQuotaGap(
    request: LatchIngressStorageQuotaGapRequest,
  ): IngressMutationResult | null;
  stageReadPage(request: StageIngressReadPageRequest): IngressMutationResult;
  reconcileStageReadPage(request: StageIngressReadPageRequest): IngressMutationResult | null;
  classifyInvalidPosition(request: ClassifyInvalidIngressPositionRequest): IngressMutationResult;
  classifyUnknownOutboundPosition(
    request: ClassifyUnknownOutboundPositionRequest,
  ): IngressMutationResult;
  classifyInboundPart(request: ClassifyInboundPartRequest): IngressPartClassificationResult;
  reconcilePositionClassification(
    request:
      | ClassifyInvalidIngressPositionRequest
      | ClassifyUnknownOutboundPositionRequest
      | ClassifyInboundPartRequest,
  ): IngressMutationResult | null;
  expireResult(request: ExpireIngressResultRequest): IngressMutationResult;
  reconcileResultExpiry(request: ExpireIngressResultRequest): IngressMutationResult | null;
  recoverGap(request: RecoverIngressGapRequest): IngressMutationResult;
  reconcileGapRecovery(request: RecoverIngressGapRequest): IngressMutationResult | null;
  recomputeSemanticCursor(request: RecomputeIngressSemanticCursorRequest): IngressMutationResult;
  reconcileSemanticCursorRecompute(
    request: RecomputeIngressSemanticCursorRequest,
  ): IngressMutationResult | null;
}

export class IngressRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`ingress repository conflict: ${message}`);
    this.name = "IngressRepositoryConflictError";
  }
}

export class IngressRepositoryStaleCoordinatorError extends Error {
  constructor(message = "coordinator fence or actor revision is stale") {
    super(`ingress repository stale coordinator: ${message}`);
    this.name = "IngressRepositoryStaleCoordinatorError";
  }
}

export class IngressRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`ingress repository persistence failed: ${message}`, options);
    this.name = "IngressRepositoryPersistenceError";
  }
}

export class IngressRepositoryQuotaError extends Error {
  readonly retrySafe = false;

  constructor() {
    super("ingress repository quota: total retained ingress artifact limit would be exceeded");
    this.name = "IngressRepositoryQuotaError";
  }
}

function sqlGet(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): unknown {
  try {
    return transaction.get(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof IngressRepositoryConflictError ||
      error instanceof IngressRepositoryStaleCoordinatorError ||
      error instanceof IngressRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new IngressRepositoryPersistenceError("read operation did not complete", {
      cause: error,
    });
  }
}

function sqlAll(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): readonly unknown[] {
  try {
    if (transaction.all === undefined) {
      throw new IngressRepositoryPersistenceError("inventory reads require multi-row SQL");
    }
    return transaction.all(sql, parameters);
  } catch (error) {
    if (error instanceof IngressRepositoryPersistenceError) throw error;
    throw new IngressRepositoryPersistenceError("multi-row read did not complete", {
      cause: error,
    });
  }
}

function sqlRun(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
): HostStateRepositorySqlRunResult {
  try {
    return transaction.run(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof IngressRepositoryConflictError ||
      error instanceof IngressRepositoryStaleCoordinatorError ||
      error instanceof IngressRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new IngressRepositoryPersistenceError("write operation did not complete", {
      cause: error,
    });
  }
}

function digest(bytes: Uint8Array): A1Digest {
  return parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
}

function prefixedDigest(prefix: string, bytes: Uint8Array): A1SafeId {
  return parseA1SafeId(`${prefix}${digest(bytes)}`);
}

// Keep these synchronous equivalents beside repository persistence. They independently recompute the
// browser-safe pure IDs without introducing WebCrypto awaits inside a SQLite transaction.
function expectedPositionId(routeId: BrokerRouteId, cursor: BrokerChannelCursorV1): A1SafeId {
  return prefixedDigest("rcp_", canonicalA1ChannelPositionObservationPreimage(routeId, cursor));
}

function expectedObservationId(positionId: A1SafeId): A1SafeId {
  return prefixedDigest("rio_", canonicalA1IngressObservationPreimage(positionId));
}

function expectedNamespaceId(machineIdentityId: string, scope: BrokerRouteActorScope): A1SafeId {
  const identity = parseMachineIdentityId(machineIdentityId);
  if (scope.routeKind === "scope_bus") {
    throw new HostStateContractError("scope-bus routes have no semantic ingress namespace");
  }
  const route =
    scope.routeKind === "chat"
      ? {
          routeKind: "chat" as const,
          identityId: Uint8Array.from(Buffer.from(identity, "hex")),
          collaborationServerId: scope.collaborationServerId,
          logicalChatId: scope.logicalChatId,
        }
      : {
          routeKind: "server_control" as const,
          identityId: Uint8Array.from(Buffer.from(identity, "hex")),
          collaborationServerId: scope.collaborationServerId,
          logicalChatId: null,
        };
  return prefixedDigest("wns_", canonicalA1WebSourceNamespacePreimage(route));
}

function expectedResultId(
  machineIdentityId: string,
  scope: BrokerRouteActorScope,
  namespaceId: A1SafeId,
  msgId: string,
): A1SafeId {
  const identity = parseMachineIdentityId(machineIdentityId);
  if (scope.routeKind === "scope_bus") {
    throw new HostStateContractError("scope-bus routes have no semantic ingress result");
  }
  const route =
    scope.routeKind === "chat"
      ? {
          routeKind: "chat" as const,
          identityId: Uint8Array.from(Buffer.from(identity, "hex")),
          collaborationServerId: scope.collaborationServerId,
          logicalChatId: scope.logicalChatId,
        }
      : {
          routeKind: "server_control" as const,
          identityId: Uint8Array.from(Buffer.from(identity, "hex")),
          collaborationServerId: scope.collaborationServerId,
          logicalChatId: null,
        };
  return prefixedDigest("rrs_", canonicalA1StableSemanticResultPreimage(route, namespaceId, msgId));
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function mappedRow(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IngressRepositoryPersistenceError(`${field} row is not an object`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) result[snakeToCamel(key)] = entry;
  return result;
}

function oneMapped(
  transaction: HostStateRepositorySqlTransaction,
  table: string,
  routeId: BrokerRouteId,
): Record<string, unknown> | null {
  const value = sqlGet(transaction, `SELECT * FROM ${table} WHERE broker_route_id = ? LIMIT 1`, [
    routeId,
  ]);
  return value === undefined ? null : mappedRow(value, table);
}

function allMapped(
  transaction: HostStateRepositorySqlTransaction,
  table: string,
  routeId?: BrokerRouteId,
  orderBy = "broker_route_id",
): readonly Record<string, unknown>[] {
  const rows =
    routeId === undefined
      ? sqlAll(transaction, `SELECT * FROM ${table} ORDER BY ${orderBy}`)
      : sqlAll(
          transaction,
          `SELECT * FROM ${table} WHERE broker_route_id = ? ORDER BY ${orderBy}`,
          [routeId],
        );
  return Object.freeze(rows.map((row) => mappedRow(row, table)));
}

function asPublicActor(actor: StoredBrokerRouteActorRecord): IngressRouteActorRecord {
  return Object.freeze({
    scope: Object.freeze({
      brokerRouteId: actor.brokerRouteId,
      collaborationServerId: actor.collaborationServerId,
      routeKind: actor.routeKind,
      logicalChatId: actor.logicalChatId,
    }) as BrokerRouteActorScope,
    revision: actor.revision,
    claimToken: actor.claimToken,
    coordinatorLeaseId: actor.coordinatorLeaseId,
    coordinatorEpoch: actor.coordinatorEpoch,
    claimedAtMs: actor.claimedAtMs,
    lastOperationId: actor.lastOperationId,
    lastOperationKind: actor.lastOperationKind,
    lastOperationDigest: actor.lastOperationDigest,
    updatedAtMs: actor.updatedAtMs,
  });
}

function readStoredActor(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
): StoredBrokerRouteActorRecord {
  const row = oneMapped(transaction, "broker_route_actors", routeId);
  if (row === null) throw new IngressRepositoryConflictError("broker route is not initialized");
  try {
    return parseBrokerRouteActorRecord(row);
  } catch (error) {
    throw new IngressRepositoryPersistenceError("broker route actor row is invalid", {
      cause: error,
    });
  }
}

function sameScope(left: BrokerRouteActorScope, right: BrokerRouteActorScope): boolean {
  return (
    left.brokerRouteId === right.brokerRouteId &&
    left.collaborationServerId === right.collaborationServerId &&
    left.routeKind === right.routeKind &&
    left.logicalChatId === right.logicalChatId
  );
}

function operationDigest(kind: string, payload: unknown): A1Digest {
  // Callers never supply this digest. Repository-owned normalization deliberately omits randomized
  // protected-handle IDs; artifact byte digests/lengths and all semantic coordinates remain bound.
  const json = JSON.stringify(payload, (_key, value: unknown) =>
    value instanceof Uint8Array ? Buffer.from(value).toString("base64url") : value,
  );
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/ingress-operation/v1");
  writer.str(kind);
  writer.str(json);
  return digest(writer.finish());
}

interface AuthorityRequest {
  readonly scope: BrokerRouteActorScope;
  readonly fence: CoordinatorLeaseFence;
  readonly observedAtMs: number;
}

function assertAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: AuthorityRequest,
  nowMs: () => number,
): void {
  const wallNow = nowMs();
  const retainedActor = sqlGet(
    transaction,
    `SELECT actor.updated_at_ms,
            runtime.updated_at_ms AS runtime_updated_at_ms
       FROM broker_route_actors AS actor
       JOIN broker_route_runtime_status AS runtime
         ON runtime.broker_route_id=actor.broker_route_id
      WHERE actor.broker_route_id=? LIMIT 1`,
    [request.scope.brokerRouteId],
  );
  const durableNow =
    retainedActor === undefined
      ? 0
      : Math.max(
          Number(mappedRow(retainedActor, "ingressAuthorityRuntime").updatedAtMs),
          Number(mappedRow(retainedActor, "ingressAuthorityRuntime").runtimeUpdatedAtMs),
        );
  const now = Math.max(wallNow, durableNow);
  if (
    !Number.isSafeInteger(wallNow) ||
    wallNow < 0 ||
    !Number.isSafeInteger(durableNow) ||
    durableNow < 0 ||
    !Number.isSafeInteger(request.observedAtMs) ||
    request.observedAtMs < 0 ||
    request.observedAtMs > now ||
    request.fence.collaborationServerId !== request.scope.collaborationServerId
  ) {
    throw new IngressRepositoryStaleCoordinatorError();
  }
  const value = sqlGet(
    transaction,
    `SELECT route.machine_identity_id, route.collaboration_server_id, route.route_kind,
            route.logical_chat_id, server.state AS server_state,
            server.current_coordinator_lease_id, server.current_coordinator_epoch,
            lease.state AS lease_state, lease.acquired_at_ms, lease.heartbeat_deadline_ms,
            lease.released_at_ms
       FROM broker_routes AS route
       JOIN collaboration_servers AS server
         ON server.collaboration_server_id = route.collaboration_server_id
       JOIN coordinator_leases AS lease
         ON lease.coordinator_lease_id = ?
        AND lease.collaboration_server_id = server.collaboration_server_id
        AND lease.coordinator_epoch = ?
      WHERE route.broker_route_id = ? LIMIT 1`,
    [request.fence.coordinatorLeaseId, request.fence.coordinatorEpoch, request.scope.brokerRouteId],
  );
  if (value === undefined) throw new IngressRepositoryStaleCoordinatorError();
  const row = mappedRow(value, "ingressAuthority");
  if (
    row.machineIdentityId !== machineIdentityId ||
    row.collaborationServerId !== request.scope.collaborationServerId ||
    row.routeKind !== request.scope.routeKind ||
    row.logicalChatId !== request.scope.logicalChatId ||
    row.serverState === "closed" ||
    row.currentCoordinatorLeaseId !== request.fence.coordinatorLeaseId ||
    row.currentCoordinatorEpoch !== request.fence.coordinatorEpoch ||
    row.leaseState !== "current" ||
    row.releasedAtMs !== null ||
    typeof row.acquiredAtMs !== "number" ||
    typeof row.heartbeatDeadlineMs !== "number" ||
    now < row.acquiredAtMs ||
    now >= row.heartbeatDeadlineMs ||
    request.observedAtMs < row.acquiredAtMs ||
    request.observedAtMs >= row.heartbeatDeadlineMs
  ) {
    throw new IngressRepositoryStaleCoordinatorError();
  }
}

function verifyArtifact(
  transaction: HostStateRepositorySqlTransaction,
  ref: ProtectedHandleId,
  scopeId: CollaborationServerId,
  schemaId: string,
  expectedDigest: A1Digest,
  expectedLength?: number,
): Uint8Array {
  const value = sqlGet(
    transaction,
    `SELECT kind, scope_kind, scope_id, artifact_schema_id, artifact_digest,
            byte_length, artifact_bytes
       FROM protected_artifacts WHERE protected_handle_id = ? LIMIT 1`,
    [ref],
  );
  if (value === undefined)
    throw new HostStateContractError("ingress artifact could not be verified");
  const row = mappedRow(value, "ingressArtifact");
  if (!(row.artifactBytes instanceof Uint8Array)) {
    throw new IngressRepositoryPersistenceError("ingress artifact bytes are invalid");
  }
  try {
    const computed = digest(row.artifactBytes);
    if (
      row.kind !== "artifact" ||
      row.scopeKind !== "collaboration_server" ||
      row.scopeId !== scopeId ||
      row.artifactSchemaId !== schemaId ||
      row.artifactDigest !== expectedDigest ||
      computed !== expectedDigest ||
      row.byteLength !== row.artifactBytes.byteLength ||
      (expectedLength !== undefined && row.byteLength !== expectedLength)
    ) {
      throw new HostStateContractError("ingress artifact could not be verified");
    }
    return new Uint8Array(row.artifactBytes);
  } finally {
    row.artifactBytes.fill(0);
  }
}

function verifyArtifactAndScrub(
  transaction: HostStateRepositorySqlTransaction,
  ref: ProtectedHandleId,
  scopeId: CollaborationServerId,
  schemaId: string,
  expectedDigest: A1Digest,
  expectedLength?: number,
): void {
  const bytes = verifyArtifact(transaction, ref, scopeId, schemaId, expectedDigest, expectedLength);
  bytes.fill(0);
}

function verifyCanonicalGapEvidence(
  transaction: HostStateRepositorySqlTransaction,
  ref: ProtectedHandleId,
  scope: BrokerRouteActorScope,
  expectedDigest: A1Digest,
  expectedFailureCode: A1SafeId | null,
  expectedPositionId: A1SafeId | null,
  requestedPosition: "null" | "present",
): void {
  const bytes = verifyArtifact(
    transaction,
    ref,
    scope.collaborationServerId,
    A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
    expectedDigest,
  );
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("gap evidence is not an object");
    }
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row);
    const expectedKeys = [
      "v",
      "broker_route_id",
      "failure_code",
      "channel_position_observation_id",
      "requested_position",
    ];
    const parsedFailureCode = parseA1SafeId(row.failure_code);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      row.v !== 1 ||
      row.broker_route_id !== scope.brokerRouteId ||
      (expectedFailureCode !== null && parsedFailureCode !== expectedFailureCode) ||
      (row.channel_position_observation_id === null
        ? null
        : parseA1SafeId(row.channel_position_observation_id)) !== expectedPositionId
    ) {
      throw new TypeError("gap evidence tuple is inconsistent");
    }
    const parsedRequestedPosition =
      row.requested_position === null ? null : parseBrokerReadPositionV1(row.requested_position);
    if (
      (requestedPosition === "null" && parsedRequestedPosition !== null) ||
      (requestedPosition === "present" && parsedRequestedPosition === null)
    ) {
      throw new TypeError("gap evidence requested position is inconsistent");
    }
    const canonical = JSON.stringify({
      v: 1,
      broker_route_id: scope.brokerRouteId,
      failure_code: parsedFailureCode,
      channel_position_observation_id: expectedPositionId,
      requested_position: parsedRequestedPosition,
    });
    if (text !== canonical) throw new TypeError("gap evidence is not canonical");
  } catch {
    throw new HostStateContractError("retained gap evidence is not canonical");
  } finally {
    bytes.fill(0);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

type InspectedStagedPosition = Readonly<{
  row: Record<string, unknown>;
  routeMatches: boolean;
  brokerClaimsMatch: boolean;
}>;

/**
 * Reconstruct the authenticated cleartext header from the retained first bytes. Caller-supplied
 * parsing/decryption evidence is deliberately never treated as authority by the persistence layer.
 */
function inspectStagedPosition(
  transaction: HostStateRepositorySqlTransaction,
  scope: BrokerRouteActorScope,
  machineIdentityId: string,
  parsed: ParsedIngressPositionEvidence,
): InspectedStagedPosition {
  const value = sqlGet(
    transaction,
    `SELECT * FROM authenticated_channel_positions
      WHERE channel_position_observation_id = ? AND broker_route_id = ? LIMIT 1`,
    [parsed.channelPositionObservationId, scope.brokerRouteId],
  );
  if (value === undefined) throw new IngressRepositoryConflictError("position is not staged");
  const row = mappedRow(value, "inspectedPosition");
  const raw = verifyArtifact(
    transaction,
    row.receivedFrameRef as ProtectedHandleId,
    scope.collaborationServerId,
    A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
    parseA1Digest(row.receivedFrameDigest),
    Number(row.receivedFrameByteLength),
  );
  let normalized: Uint8Array | null = null;
  let retainedHeader: Uint8Array | null = null;
  let suppliedHeader: Uint8Array | null = null;
  try {
    const frame = parseA1EncryptedFrameV2(raw);
    normalized = normalizedA1TransportFrameBytes(frame);
    const normalizedDigest = digest(normalized);
    retainedHeader = canonicalA1Aad(frame);
    suppliedHeader = canonicalA1Aad(parsed.header);
    if (
      normalizedDigest !== parsed.normalizedTransportFrameDigest ||
      !equalBytes(retainedHeader, suppliedHeader)
    ) {
      throw new HostStateContractError(
        "parsed position evidence does not match the retained raw frame",
      );
    }
    let routeMatches = true;
    try {
      const route =
        scope.routeKind === "chat"
          ? {
              routeKind: "chat" as const,
              identityId: Uint8Array.from(
                Buffer.from(parseMachineIdentityId(machineIdentityId), "hex"),
              ),
              collaborationServerId: scope.collaborationServerId,
              logicalChatId: scope.logicalChatId,
            }
          : {
              routeKind: scope.routeKind,
              identityId: Uint8Array.from(
                Buffer.from(parseMachineIdentityId(machineIdentityId), "hex"),
              ),
              collaborationServerId: scope.collaborationServerId,
              logicalChatId: null,
            };
      assertA1FrameMatchesRoute(frame, route);
    } catch {
      routeMatches = false;
    }
    return Object.freeze({
      row,
      routeMatches,
      brokerClaimsMatch:
        row.claimedDeliveryAttemptId === frame.deliveryAttemptId &&
        row.claimedPart === frame.part &&
        row.claimedTransportFrameDigest === normalizedDigest,
    });
  } catch (error) {
    if (error instanceof HostStateContractError) throw error;
    throw new HostStateContractError(
      `retained raw frame does not support supplied parsed evidence: ${
        error instanceof Error ? error.message : "invalid frame"
      }`,
    );
  } finally {
    raw.fill(0);
    normalized?.fill(0);
    retainedHeader?.fill(0);
    suppliedHeader?.fill(0);
  }
}

function checkReplay(
  actor: StoredBrokerRouteActorRecord,
  operationId: A1SafeId,
  kind: string,
  computedDigest: A1Digest,
): boolean {
  if (actor.lastOperationId !== operationId) return false;
  if (actor.lastOperationKind !== kind || actor.lastOperationDigest !== computedDigest) {
    throw new IngressRepositoryConflictError("operation identity already names different evidence");
  }
  return true;
}

function assertClaimedMutation(
  actor: StoredBrokerRouteActorRecord,
  request: IngressMutationCoordinate,
): void {
  if (
    !sameScope(
      {
        brokerRouteId: actor.brokerRouteId,
        collaborationServerId: actor.collaborationServerId,
        routeKind: actor.routeKind,
        logicalChatId: actor.logicalChatId,
      } as BrokerRouteActorScope,
      request.scope,
    ) ||
    actor.revision !== request.expectedActorRevision ||
    actor.claimToken !== request.actorClaimToken ||
    actor.coordinatorLeaseId !== request.fence.coordinatorLeaseId ||
    actor.coordinatorEpoch !== request.fence.coordinatorEpoch
  ) {
    throw new IngressRepositoryStaleCoordinatorError();
  }
}

function bumpActor(
  transaction: HostStateRepositorySqlTransaction,
  actor: StoredBrokerRouteActorRecord,
  kind: string,
  operationId: A1SafeId,
  computedDigest: A1Digest,
  observedAtMs: number,
  release = false,
): StoredBrokerRouteActorRecord {
  if (actor.revision >= Number.MAX_SAFE_INTEGER - 1) {
    throw new IngressRepositoryConflictError("broker route actor revision is exhausted");
  }
  const result = sqlRun(
    transaction,
    `UPDATE broker_route_actors
        SET revision = revision + 1,
            claim_token = CASE WHEN ? = 1 THEN NULL ELSE claim_token END,
            coordinator_lease_id = CASE WHEN ? = 1 THEN NULL ELSE coordinator_lease_id END,
            coordinator_epoch = CASE WHEN ? = 1 THEN NULL ELSE coordinator_epoch END,
            claimed_at_ms = CASE WHEN ? = 1 THEN NULL ELSE claimed_at_ms END,
            last_operation_id = ?, last_operation_kind = ?, last_operation_digest = ?,
            updated_at_ms = ?
      WHERE broker_route_id = ? AND revision = ?`,
    [
      release ? 1 : 0,
      release ? 1 : 0,
      release ? 1 : 0,
      release ? 1 : 0,
      operationId,
      kind,
      computedDigest,
      observedAtMs,
      actor.brokerRouteId,
      actor.revision,
    ],
  );
  if (Number(result.changes) !== 1) throw new IngressRepositoryStaleCoordinatorError();
  return readStoredActor(transaction, actor.brokerRouteId);
}

function mutationResult(
  actor: StoredBrokerRouteActorRecord,
  replayed: boolean,
): IngressMutationResult {
  return Object.freeze({ actor: asPublicActor(actor), replayed });
}

function mutationDigestFields(request: IngressMutationCoordinate): Record<string, unknown> {
  return {
    scope: request.scope,
    fence: request.fence,
    actorClaimToken: request.actorClaimToken,
    expectedActorRevision: request.expectedActorRevision,
    operationId: request.operationId,
    observedAtMs: request.observedAtMs,
  };
}

function mutationRequestDigest(kind: string, request: IngressMutationCoordinate): A1Digest {
  return operationDigest(kind, mutationDigestFields(request));
}

function stageOperationDigest(request: StageIngressReadPageRequest): A1Digest {
  return operationDigest("stage_page", {
    ...mutationDigestFields(request),
    requestedPosition: request.requestedPosition,
    generation: request.generation,
    observedNextFrameIndex: request.observedNextFrameIndex,
    frames: request.frames.map((frame) => ({
      cursor: frame.cursor,
      channelPositionObservationId: frame.channelPositionObservationId,
      claimedDeliveryAttemptId: frame.claimedDeliveryAttemptId,
      claimedPart: frame.claimedPart,
      claimedTransportFrameDigest: frame.claimedTransportFrameDigest,
      receivedFrameDigest: frame.receivedFrameDigest,
      receivedFrameByteLength: frame.receivedFrameByteLength,
    })),
    nextPosition: request.nextPosition,
    atLiveTail: request.atLiveTail,
    pageEvidenceDigest: request.pageEvidenceDigest,
  });
}

function classificationDigest(
  classification: "invalid" | "unknown_outbound" | "inbound",
  request:
    | ClassifyInvalidIngressPositionRequest
    | ClassifyUnknownOutboundPositionRequest
    | ClassifyInboundPartRequest,
): A1Digest {
  const artifact =
    "plaintextPartDigest" in request
      ? {
          plaintextPartDigest: request.plaintextPartDigest,
          plaintextPartByteLength: request.plaintextPartByteLength,
          authenticatedPartDigest: request.authenticatedPartDigest,
          sourceEventNamespaceId: request.sourceEventNamespaceId,
          stableSemanticResultId: request.stableSemanticResultId,
          ingressObservationId: request.ingressObservationId,
        }
      : {
          gapEvidenceDigest: request.gapEvidenceDigest,
          validationFailureCode:
            "validationFailureCode" in request ? request.validationFailureCode : null,
        };
  return operationDigest(`classify_${classification}`, {
    ...mutationDigestFields(request),
    parsed: request.parsed,
    ...artifact,
  });
}

const POST_HEADER_INVALID_FAILURE_CODES = new Set<A1SafeId>([
  parseA1SafeId("aead_authentication_failed"),
  parseA1SafeId("invalid_plaintext_part"),
  parseA1SafeId("opened_part_too_large"),
  parseA1SafeId("invalid_selected_payload"),
]);

function readRouteHeadTransaction(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
): IngressRouteHead | null {
  const runtimeRow = oneMapped(transaction, "broker_route_runtime_status", routeId);
  if (runtimeRow === null) return null;
  try {
    const runtime = parseBrokerRouteRuntimeStatusRecord(runtimeRow);
    const routeValue = sqlGet(
      transaction,
      `SELECT broker_route_store_instance_id FROM broker_routes
        WHERE broker_route_id=? LIMIT 1`,
      [routeId],
    );
    if (routeValue === undefined) {
      throw new IngressRepositoryPersistenceError("route head is missing its route-store pin");
    }
    const generationValue = sqlGet(
      transaction,
      `SELECT * FROM broker_channel_generation_observations
        WHERE broker_route_id=? AND channel_generation=? LIMIT 1`,
      [routeId, runtime.currentChannelGeneration],
    );
    if (generationValue === undefined) {
      throw new IngressRepositoryPersistenceError(
        "route head is missing its current generation observation",
      );
    }
    const gapValue = mappedRow(
      sqlGet(
        transaction,
        `SELECT EXISTS (
           SELECT 1 FROM broker_route_gaps WHERE broker_route_id=? AND state='open'
         ) AS has_open_gaps,
         EXISTS (
           SELECT 1 FROM broker_route_gaps
            WHERE broker_route_id=? AND state='open' AND reason='storage_quota'
         ) AS has_open_storage_quota_gap`,
        [routeId, routeId],
      ),
      "routeHeadGapFlags",
    );
    if (
      (gapValue.hasOpenGaps !== 0 && gapValue.hasOpenGaps !== 1) ||
      (gapValue.hasOpenStorageQuotaGap !== 0 && gapValue.hasOpenStorageQuotaGap !== 1) ||
      (gapValue.hasOpenStorageQuotaGap === 1 && gapValue.hasOpenGaps !== 1)
    ) {
      throw new IngressRepositoryPersistenceError("route head gap flags are invalid");
    }
    return Object.freeze({
      routeStoreInstanceId: parseBrokerRouteStoreInstanceId(
        mappedRow(routeValue, "routeHeadStore").brokerRouteStoreInstanceId,
      ),
      actor: parseBrokerRouteActorRecord(oneMapped(transaction, "broker_route_actors", routeId)),
      runtime,
      currentGeneration: parseBrokerChannelGenerationObservationRecord(
        mappedRow(generationValue, "routeHeadGeneration"),
      ),
      fetchCursor: parseBrokerRouteFetchCursorRecord(
        oneMapped(transaction, "broker_route_fetch_cursors", routeId),
      ),
      semanticCursor: parseBrokerRouteSemanticCursorRecord(
        oneMapped(transaction, "broker_route_semantic_cursors", routeId),
      ),
      hasOpenGaps: gapValue.hasOpenGaps === 1,
      hasOpenStorageQuotaGap: gapValue.hasOpenStorageQuotaGap === 1,
    });
  } catch (error) {
    if (error instanceof IngressRepositoryPersistenceError) throw error;
    throw new IngressRepositoryPersistenceError("route ingress head is invalid", { cause: error });
  }
}

function readNextDueAssemblingResultTransaction(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
  dueAtOrBeforeMs: number,
): DueAssemblingIngressResult | null {
  const value = sqlGet(
    transaction,
    `SELECT * FROM authenticated_ingress_results
      WHERE broker_route_id=? AND state='assembling' AND assembly_deadline_ms<=?
      ORDER BY assembly_deadline_ms, stable_semantic_result_id LIMIT 1`,
    [routeId, dueAtOrBeforeMs],
  );
  if (value === undefined) return null;
  try {
    const result = parseAuthenticatedIngressResultRecord(
      mappedRow(value, "nextDueAssemblingResult"),
    );
    return Object.freeze({
      stableSemanticResultId: result.stableSemanticResultId,
      assemblyDeadlineMs: result.assemblyDeadlineMs,
    });
  } catch (error) {
    throw new IngressRepositoryPersistenceError("due ingress result is invalid", { cause: error });
  }
}

function readPositionClassificationTransaction(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
  ingressObservationId: A1SafeId,
): IngressPositionClassification | null {
  const observationValue = sqlGet(
    transaction,
    `SELECT * FROM authenticated_ingress_observations
      WHERE broker_route_id=? AND ingress_observation_id=? LIMIT 1`,
    [routeId, ingressObservationId],
  );
  if (observationValue === undefined) return null;
  try {
    const observation = parseAuthenticatedIngressObservationRecord(
      mappedRow(observationValue, "positionClassificationObservation"),
    );
    const resultValue = sqlGet(
      transaction,
      `SELECT * FROM authenticated_ingress_results
        WHERE broker_route_id=? AND stable_semantic_result_id=? LIMIT 1`,
      [routeId, observation.stableSemanticResultId],
    );
    if (resultValue === undefined) {
      throw new IngressRepositoryPersistenceError(
        "position classification is missing its semantic result",
      );
    }
    const result = parseAuthenticatedIngressResultRecord(
      mappedRow(resultValue, "positionClassificationResult"),
    );
    const candidateValue = sqlGet(
      transaction,
      `SELECT * FROM ingress_delivery_candidates
        WHERE broker_route_id=? AND stable_semantic_result_id=? AND delivery_attempt_id=? LIMIT 1`,
      [routeId, observation.stableSemanticResultId, observation.deliveryAttemptId],
    );
    const candidateState =
      candidateValue === undefined
        ? observation.disposition === "collision"
          ? "collision"
          : observation.disposition === "late_after_tombstone"
            ? result.state === "quarantined_incomplete"
              ? "expired"
              : "collision"
            : null
        : parseIngressDeliveryCandidateRecord(
            mappedRow(candidateValue, "positionClassificationCandidate"),
          ).state;
    if (candidateState === null) {
      throw new IngressRepositoryPersistenceError(
        "position classification is missing its delivery candidate",
      );
    }
    return Object.freeze({
      candidateState,
      resultState: result.state,
      stableSemanticResultId: result.stableSemanticResultId,
      sourcePayloadSchemaId: result.sourcePayloadSchemaId,
      canonicalMessageDigest: result.canonicalMessageDigest,
      sourceEventFingerprint: result.sourceEventFingerprint,
    });
  } catch (error) {
    if (error instanceof IngressRepositoryPersistenceError) throw error;
    throw new IngressRepositoryPersistenceError("position classification is invalid", {
      cause: error,
    });
  }
}

function readRouteStateTransaction(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
): IngressRouteState | null {
  const runtimeRow = oneMapped(transaction, "broker_route_runtime_status", routeId);
  if (runtimeRow === null) return null;
  try {
    const actor = parseBrokerRouteActorRecord(
      oneMapped(transaction, "broker_route_actors", routeId),
    );
    const fetchCursor = parseBrokerRouteFetchCursorRecord(
      oneMapped(transaction, "broker_route_fetch_cursors", routeId),
    );
    const semanticCursor = parseBrokerRouteSemanticCursorRecord(
      oneMapped(transaction, "broker_route_semantic_cursors", routeId),
    );
    return Object.freeze({
      actor,
      runtime: parseBrokerRouteRuntimeStatusRecord(runtimeRow),
      generationObservations: Object.freeze(
        allMapped(
          transaction,
          "broker_channel_generation_observations",
          routeId,
          "channel_generation",
        ).map(parseBrokerChannelGenerationObservationRecord),
      ),
      fetchCursor,
      semanticCursor,
      gaps: Object.freeze(
        allMapped(transaction, "broker_route_gaps", routeId, "opened_at_ms, gap_id").map(
          parseBrokerRouteGapRecord,
        ),
      ),
      positions: Object.freeze(
        allMapped(
          transaction,
          "authenticated_channel_positions",
          routeId,
          "channel_generation, frame_index",
        ).map(parseAuthenticatedChannelPositionRecord),
      ),
      results: Object.freeze(
        allMapped(
          transaction,
          "authenticated_ingress_results",
          routeId,
          "first_ingress_generation, first_ingress_frame_index, stable_semantic_result_id",
        ).map(parseAuthenticatedIngressResultRecord),
      ),
      attempts: Object.freeze(
        allMapped(transaction, "ingress_transport_attempts", routeId, "delivery_attempt_id").map(
          parseIngressTransportAttemptRecord,
        ),
      ),
      candidates: Object.freeze(
        allMapped(
          transaction,
          "ingress_delivery_candidates",
          routeId,
          "first_ingress_generation, first_ingress_frame_index, delivery_attempt_id",
        ).map(parseIngressDeliveryCandidateRecord),
      ),
      parts: Object.freeze(
        allMapped(
          transaction,
          "authenticated_ingress_parts",
          routeId,
          "stable_semantic_result_id, delivery_attempt_id, part",
        ).map(parseAuthenticatedIngressPartRecord),
      ),
      observations: Object.freeze(
        allMapped(
          transaction,
          "authenticated_ingress_observations",
          routeId,
          "channel_generation, frame_index",
        ).map(parseAuthenticatedIngressObservationRecord),
      ),
      readPageObservations: Object.freeze(
        allMapped(
          transaction,
          "broker_read_page_observations",
          routeId,
          "observed_at_ms, read_page_observation_id",
        ).map(parseBrokerReadPageObservationRecord),
      ),
      readPageFrameEvidence: Object.freeze(
        allMapped(
          transaction,
          "broker_read_page_frame_evidence",
          routeId,
          "read_page_observation_id, ordinal",
        ).map(parseBrokerReadPageFrameEvidenceRecord),
      ),
    });
  } catch (error) {
    if (error instanceof IngressRepositoryPersistenceError) throw error;
    throw new IngressRepositoryPersistenceError("route ingress state is invalid", { cause: error });
  }
}

function deterministicEvidenceId(prefix: string, ...fields: readonly string[]): A1SafeId {
  const writer = new CanonicalWriter();
  writer.str(`remote-claw/a1/${prefix}/v1`);
  for (const field of fields) writer.str(field);
  return prefixedDigest("rie_", writer.finish());
}

function manifestObservationDigest(request: StageIngressReadPageRequest): A1Digest {
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/generation-observation/v1");
  writer.str(request.scope.brokerRouteId);
  writer.uint(request.generation.channelGeneration);
  writer.str(request.generation.state);
  writer.uint(request.observedNextFrameIndex);
  writer.optionalUint(request.generation.frameCount);
  writer.optionalUint(request.generation.nextGeneration);
  writer.optionalStr(request.generation.manifestDigest);
  return digest(writer.finish());
}

function frameClaimsDigest(request: StageIngressReadPageRequest): A1Digest {
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/read-page-frame-claims/v1");
  writer.uint(request.frames.length);
  for (const frame of request.frames) {
    writer.uint(frame.cursor.channelGeneration);
    writer.uint(frame.cursor.frameIndex);
    writer.str(frame.channelPositionObservationId);
    writer.str(frame.claimedDeliveryAttemptId);
    writer.uint(frame.claimedPart);
    writer.str(frame.claimedTransportFrameDigest);
    writer.str(frame.receivedFrameDigest);
    writer.uint(frame.receivedFrameByteLength);
  }
  return digest(writer.finish());
}

function insertReadPageObservation(
  transaction: HostStateRepositorySqlTransaction,
  request: StageIngressReadPageRequest,
): A1SafeId {
  const routeValue = sqlGet(
    transaction,
    `SELECT broker_route_store_instance_id FROM broker_routes WHERE broker_route_id=? LIMIT 1`,
    [request.scope.brokerRouteId],
  );
  if (routeValue === undefined) throw new IngressRepositoryConflictError("page route is absent");
  const routeStoreInstanceId = String(
    mappedRow(routeValue, "pageObservationRoute").brokerRouteStoreInstanceId,
  );
  const id = deterministicEvidenceId(
    "read-page-observation",
    request.scope.brokerRouteId,
    request.operationId,
    request.pageEvidenceDigest,
  );
  sqlRun(
    transaction,
    `INSERT INTO broker_read_page_observations (
       read_page_observation_id, broker_route_id, collaboration_server_id, route_kind,
       logical_chat_id, route_store_instance_id, requested_generation, requested_frame_index, next_generation,
       next_frame_index, generation_state, generation_frame_count,
       generation_next_generation, generation_manifest_digest, observed_next_frame_index,
       frame_count_in_page, frame_claims_digest, at_live_tail, operation_id,
       evidence_ref, evidence_digest, observed_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      routeStoreInstanceId,
      request.requestedPosition.channelGeneration,
      request.requestedPosition.nextFrameIndex,
      request.nextPosition.channelGeneration,
      request.nextPosition.nextFrameIndex,
      request.generation.state,
      request.generation.frameCount,
      request.generation.nextGeneration,
      request.generation.manifestDigest,
      request.observedNextFrameIndex,
      request.frames.length,
      frameClaimsDigest(request),
      request.atLiveTail ? 1 : 0,
      request.operationId,
      request.pageEvidenceRef,
      request.pageEvidenceDigest,
      request.observedAtMs,
    ],
  );
  return id;
}

function insertReadPageFrameEvidence(
  transaction: HostStateRepositorySqlTransaction,
  request: StageIngressReadPageRequest,
  readPageObservationId: A1SafeId,
): void {
  request.frames.forEach((frame, ordinal) => {
    sqlRun(
      transaction,
      `INSERT INTO broker_read_page_frame_evidence (
         read_page_observation_id, ordinal, broker_route_id, collaboration_server_id,
         route_kind, logical_chat_id, channel_position_observation_id,
         channel_generation, frame_index, claimed_delivery_attempt_id, claimed_part,
         claimed_transport_frame_digest, received_frame_ref, received_frame_digest,
         received_frame_byte_length
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        readPageObservationId,
        ordinal,
        request.scope.brokerRouteId,
        request.scope.collaborationServerId,
        request.scope.routeKind,
        request.scope.logicalChatId,
        frame.channelPositionObservationId,
        frame.cursor.channelGeneration,
        frame.cursor.frameIndex,
        frame.claimedDeliveryAttemptId,
        frame.claimedPart,
        frame.claimedTransportFrameDigest,
        frame.receivedFrameRef,
        frame.receivedFrameDigest,
        frame.receivedFrameByteLength,
      ],
    );
  });
}

function latchManifestEquivocation(
  transaction: HostStateRepositorySqlTransaction,
  request: StageIngressReadPageRequest,
  acceptedManifestDigest: A1Digest | null,
  readPageObservationId: A1SafeId,
): void {
  const conflictingObservationDigest = manifestObservationDigest(request);
  const id = deterministicEvidenceId(
    "manifest-equivocation",
    request.scope.brokerRouteId,
    String(request.generation.channelGeneration),
    acceptedManifestDigest ?? "open",
    conflictingObservationDigest,
  );
  const existing = sqlGet(
    transaction,
    `SELECT accepted_manifest_digest, conflicting_manifest_digest,
            conflicting_frame_count, conflicting_next_generation, conflicting_state,
            conflicting_observation_digest
       FROM broker_channel_manifest_equivocations
      WHERE manifest_equivocation_id=? LIMIT 1`,
    [id],
  );
  if (existing === undefined) {
    sqlRun(
      transaction,
      `INSERT INTO broker_channel_manifest_equivocations (
       manifest_equivocation_id, broker_route_id, collaboration_server_id, route_kind,
       logical_chat_id, channel_generation, accepted_manifest_digest,
       conflicting_manifest_digest, conflicting_frame_count, conflicting_next_generation,
       conflicting_state, conflicting_observation_digest, evidence_ref, evidence_digest,
       observed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        request.scope.brokerRouteId,
        request.scope.collaborationServerId,
        request.scope.routeKind,
        request.scope.logicalChatId,
        request.generation.channelGeneration,
        acceptedManifestDigest,
        request.generation.manifestDigest,
        request.generation.frameCount,
        request.generation.nextGeneration,
        request.generation.state,
        conflictingObservationDigest,
        request.pageEvidenceRef,
        request.pageEvidenceDigest,
        request.observedAtMs,
      ],
    );
  } else {
    const retained = mappedRow(existing, "manifestEquivocationReplay");
    if (
      retained.acceptedManifestDigest !== acceptedManifestDigest ||
      retained.conflictingManifestDigest !== request.generation.manifestDigest ||
      retained.conflictingFrameCount !== request.generation.frameCount ||
      retained.conflictingNextGeneration !== request.generation.nextGeneration ||
      retained.conflictingState !== request.generation.state ||
      retained.conflictingObservationDigest !== conflictingObservationDigest
    ) {
      throw new IngressRepositoryConflictError(
        "manifest equivocation identity conflicts with retained evidence",
      );
    }
  }
  insertGap(
    transaction,
    request.scope,
    "manifest_equivocation",
    deterministicEvidenceId("manifest-gap-occurrence", id, readPageObservationId),
    request.pageEvidenceRef,
    request.pageEvidenceDigest,
    request.observedAtMs,
    { generation: request.generation.channelGeneration, manifestId: id },
  );
}

function latchPositionEquivocation(
  transaction: HostStateRepositorySqlTransaction,
  request: StageIngressReadPageRequest,
  frame: StageIngressFrameEvidence,
  acceptedFrameDigest: A1Digest,
  readPageObservationId: A1SafeId,
): void {
  const id = deterministicEvidenceId(
    "position-equivocation",
    request.scope.brokerRouteId,
    frame.channelPositionObservationId,
    acceptedFrameDigest,
    frame.receivedFrameDigest,
  );
  const existing = sqlGet(
    transaction,
    `SELECT accepted_frame_digest, conflicting_frame_digest
       FROM channel_position_equivocations WHERE position_equivocation_id=? LIMIT 1`,
    [id],
  );
  if (existing === undefined) {
    sqlRun(
      transaction,
      `INSERT INTO channel_position_equivocations (
       position_equivocation_id, channel_position_observation_id, broker_route_id,
       collaboration_server_id, route_kind, logical_chat_id, accepted_frame_digest,
       conflicting_frame_digest, conflicting_frame_ref, observed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        frame.channelPositionObservationId,
        request.scope.brokerRouteId,
        request.scope.collaborationServerId,
        request.scope.routeKind,
        request.scope.logicalChatId,
        acceptedFrameDigest,
        frame.receivedFrameDigest,
        frame.receivedFrameRef,
        request.observedAtMs,
      ],
    );
  } else {
    const retained = mappedRow(existing, "positionEquivocationReplay");
    if (
      retained.acceptedFrameDigest !== acceptedFrameDigest ||
      retained.conflictingFrameDigest !== frame.receivedFrameDigest
    ) {
      throw new IngressRepositoryConflictError(
        "position equivocation identity conflicts with retained evidence",
      );
    }
  }
  insertGap(
    transaction,
    request.scope,
    "position_equivocation",
    deterministicEvidenceId("position-gap-occurrence", id, readPageObservationId),
    frame.receivedFrameRef,
    frame.receivedFrameDigest,
    request.observedAtMs,
    { positionId: frame.channelPositionObservationId },
  );
}

function insertGap(
  transaction: HostStateRepositorySqlTransaction,
  scope: BrokerRouteActorScope,
  reason: string,
  identity: A1SafeId,
  evidenceRef: ProtectedHandleId,
  evidenceDigest: A1Digest,
  observedAtMs: number,
  targets: Readonly<{
    positionId?: A1SafeId;
    generation?: number;
    manifestId?: A1SafeId;
    transportId?: A1SafeId;
    resultId?: A1SafeId;
  }> = {},
): A1SafeId {
  const gapId = deterministicEvidenceId("gap", scope.brokerRouteId, reason, identity);
  sqlRun(
    transaction,
    `INSERT OR IGNORE INTO broker_route_gaps (
       gap_id, broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
       reason, channel_position_observation_id, channel_generation,
       manifest_equivocation_id, transport_key_collision_id, stable_semantic_result_id,
       evidence_ref, evidence_digest, state, opened_at_ms, resolved_at_ms, recovery_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL)`,
    [
      gapId,
      scope.brokerRouteId,
      scope.collaborationServerId,
      scope.routeKind,
      scope.logicalChatId,
      reason,
      targets.positionId ?? null,
      targets.generation ?? null,
      targets.manifestId ?? null,
      targets.transportId ?? null,
      targets.resultId ?? null,
      evidenceRef,
      evidenceDigest,
      observedAtMs,
    ],
  );
  return gapId;
}

function retainedIngressBytes(transaction: HostStateRepositorySqlTransaction): {
  readonly global: number;
  readonly byIdentity: ReadonlyMap<string, number>;
  readonly byRoute: ReadonlyMap<string, number>;
  readonly unresolvedByRoute: ReadonlyMap<string, number>;
} {
  const byIdentity = new Map<string, number>();
  const byRoute = new Map<string, number>();
  const unresolvedByRoute = new Map<string, number>();
  let global = 0;
  for (const value of sqlAll(
    transaction,
    `WITH ingress_refs(broker_route_id, protected_handle_id, generation, frame_index) AS (
       SELECT broker_route_id, received_frame_ref, channel_generation, frame_index
         FROM authenticated_channel_positions
       UNION
       SELECT broker_route_id, evidence_ref, requested_generation, requested_frame_index
         FROM broker_read_page_observations
       UNION
       SELECT broker_route_id, received_frame_ref, channel_generation, frame_index
         FROM broker_read_page_frame_evidence
       UNION
       SELECT broker_route_id, evidence_ref, NULL, NULL FROM broker_route_gaps
       UNION
       SELECT broker_route_id, conflicting_frame_ref, NULL, NULL
         FROM channel_position_equivocations
       UNION
       SELECT broker_route_id, evidence_ref, NULL, NULL
         FROM broker_channel_manifest_equivocations
       UNION
       SELECT broker_route_id, conflicting_frame_ref, NULL, NULL
         FROM broker_transport_key_collisions
       UNION
       SELECT broker_route_id, evidence_ref, NULL, NULL FROM channel_position_recoveries
       UNION
       SELECT broker_route_id, plaintext_part_ref, first_ingress_generation,
              first_ingress_frame_index
         FROM authenticated_ingress_parts
       UNION
       SELECT broker_route_id, plaintext_evidence_ref, channel_generation, frame_index
         FROM authenticated_ingress_observations
     ), unique_refs AS (
       SELECT broker_route_id, protected_handle_id, min(generation) AS generation,
              min(frame_index) AS frame_index
         FROM ingress_refs GROUP BY broker_route_id, protected_handle_id
     )
     SELECT refs.broker_route_id, route.machine_identity_id, artifact.byte_length AS bytes,
            CASE WHEN refs.generation IS NOT NULL
                  AND (refs.generation > semantic.next_generation
                    OR (refs.generation = semantic.next_generation
                      AND refs.frame_index >= semantic.next_frame_index))
                 THEN 1 ELSE 0 END AS unresolved
       FROM unique_refs AS refs
       JOIN protected_artifacts AS artifact
         ON artifact.protected_handle_id = refs.protected_handle_id
       JOIN broker_routes AS route USING (broker_route_id)
       JOIN broker_route_semantic_cursors AS semantic USING (broker_route_id)`,
  )) {
    const row = mappedRow(value, "ingressByteCount");
    const bytes = Number(row.bytes);
    const routeId = String(row.brokerRouteId);
    const identity = String(row.machineIdentityId);
    global += bytes;
    byRoute.set(routeId, (byRoute.get(routeId) ?? 0) + bytes);
    byIdentity.set(identity, (byIdentity.get(identity) ?? 0) + bytes);
    if (row.unresolved === 1) {
      unresolvedByRoute.set(routeId, (unresolvedByRoute.get(routeId) ?? 0) + bytes);
    }
  }
  return { global, byIdentity, byRoute, unresolvedByRoute };
}

function assertIngressAuditEvidenceQuota(
  transaction: HostStateRepositorySqlTransaction,
  scope: BrokerRouteActorScope,
  evidenceRef: ProtectedHandleId,
): void {
  rejectCrossRouteIngressArtifactReuse(transaction, scope.brokerRouteId, evidenceRef);
  const routeValue = sqlGet(
    transaction,
    `SELECT machine_identity_id FROM broker_routes WHERE broker_route_id=? LIMIT 1`,
    [scope.brokerRouteId],
  );
  if (routeValue === undefined) {
    throw new IngressRepositoryConflictError("audit evidence route is absent");
  }
  const identityId = String(mappedRow(routeValue, "auditEvidenceRoute").machineIdentityId);
  const addedBytes = ingressArtifactIsReferencedByRoute(
    transaction,
    scope.brokerRouteId,
    evidenceRef,
  )
    ? 0
    : artifactByteLength(transaction, evidenceRef);
  const retained = retainedIngressBytes(transaction);
  if (
    addedBytes > A1_INGRESS_AUDIT_RESERVE_BYTES_PER_ROUTE ||
    addedBytes > A1_INGRESS_AUDIT_RESERVE_BYTES_PER_IDENTITY ||
    addedBytes > A1_INGRESS_AUDIT_RESERVE_BYTES_GLOBAL ||
    (retained.byRoute.get(scope.brokerRouteId) ?? 0) + addedBytes >
      A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE ||
    (retained.byIdentity.get(identityId) ?? 0) + addedBytes >
      A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY ||
    retained.global + addedBytes > A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL
  ) {
    throw new IngressRepositoryQuotaError();
  }
}

const INGRESS_ARTIFACT_ROUTE_REFERENCES_SQL = `
  SELECT broker_route_id, received_frame_ref AS ref FROM authenticated_channel_positions
  UNION SELECT broker_route_id, evidence_ref FROM broker_read_page_observations
  UNION SELECT broker_route_id, received_frame_ref FROM broker_read_page_frame_evidence
  UNION SELECT broker_route_id, evidence_ref FROM broker_route_gaps
  UNION SELECT broker_route_id, conflicting_frame_ref FROM channel_position_equivocations
  UNION SELECT broker_route_id, evidence_ref FROM broker_channel_manifest_equivocations
  UNION SELECT broker_route_id, conflicting_frame_ref FROM broker_transport_key_collisions
  UNION SELECT broker_route_id, evidence_ref FROM channel_position_recoveries
  UNION SELECT broker_route_id, plaintext_part_ref FROM authenticated_ingress_parts
  UNION SELECT broker_route_id, plaintext_evidence_ref FROM authenticated_ingress_observations`;

function ingressArtifactIsReferencedByRoute(
  transaction: HostStateRepositorySqlTransaction,
  brokerRouteId: BrokerRouteId,
  ref: ProtectedHandleId,
): boolean {
  return (
    sqlGet(
      transaction,
      `SELECT 1 FROM (
         ${INGRESS_ARTIFACT_ROUTE_REFERENCES_SQL}
       ) WHERE broker_route_id=? AND ref=? LIMIT 1`,
      [brokerRouteId, ref],
    ) !== undefined
  );
}

function rejectCrossRouteIngressArtifactReuse(
  transaction: HostStateRepositorySqlTransaction,
  brokerRouteId: BrokerRouteId,
  ref: ProtectedHandleId,
): void {
  if (
    sqlGet(
      transaction,
      `SELECT 1 FROM (
         ${INGRESS_ARTIFACT_ROUTE_REFERENCES_SQL}
       ) WHERE broker_route_id<>? AND ref=? LIMIT 1`,
      [brokerRouteId, ref],
    ) !== undefined
  ) {
    throw new HostStateContractError("ingress artifacts cannot be shared across broker routes");
  }
}

function artifactByteLength(
  transaction: HostStateRepositorySqlTransaction,
  ref: ProtectedHandleId,
): number {
  const value = sqlGet(
    transaction,
    `SELECT byte_length FROM protected_artifacts WHERE protected_handle_id=? LIMIT 1`,
    [ref],
  );
  if (value === undefined) throw new HostStateContractError("ingress artifact is absent");
  return Number(mappedRow(value, "ingressArtifactLength").byteLength);
}

function verifyReadPageEvidence(
  transaction: HostStateRepositorySqlTransaction,
  request: StageIngressReadPageRequest,
): void {
  const bytes = verifyArtifact(
    transaction,
    request.pageEvidenceRef,
    request.scope.collaborationServerId,
    A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
    request.pageEvidenceDigest,
  );
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("page evidence is not an object");
    }
    const row = value as Record<string, unknown>;
    const keys = [
      "v",
      "broker_route_id",
      "route_store_instance_id",
      "requested_position",
      "generation",
      "observed_next_frame_index",
      "frames",
      "next_position",
      "at_live_tail",
    ];
    if (
      Object.keys(row).length !== keys.length ||
      keys.some((key, index) => Object.keys(row)[index] !== key) ||
      typeof row.route_store_instance_id !== "string" ||
      !/^rbsi_[A-Za-z0-9_-]{22}$/.test(row.route_store_instance_id)
    ) {
      throw new TypeError("page evidence has a non-canonical outer shape");
    }
    const routeValue = sqlGet(
      transaction,
      `SELECT broker_route_store_instance_id FROM broker_routes
        WHERE broker_route_id=? LIMIT 1`,
      [request.scope.brokerRouteId],
    );
    if (routeValue === undefined) throw new TypeError("page route is absent");
    const routeStoreInstanceId = String(
      mappedRow(routeValue, "pageEvidenceRoute").brokerRouteStoreInstanceId,
    );
    if (row.route_store_instance_id !== routeStoreInstanceId) {
      throw new TypeError("page evidence belongs to another route-store instance");
    }
    const expected = {
      v: 1,
      broker_route_id: request.scope.brokerRouteId,
      route_store_instance_id: routeStoreInstanceId,
      requested_position: request.requestedPosition,
      generation: request.generation,
      observed_next_frame_index: request.observedNextFrameIndex,
      frames: request.frames.map((frame) => ({
        cursor: frame.cursor,
        delivery_attempt_id: frame.claimedDeliveryAttemptId,
        part: frame.claimedPart,
        transport_frame_digest: frame.claimedTransportFrameDigest,
        raw_frame_digest: frame.receivedFrameDigest,
      })),
      next_position: request.nextPosition,
      at_live_tail: request.atLiveTail,
    };
    const canonical = JSON.stringify(expected);
    if (text !== canonical) {
      throw new TypeError("page evidence does not encode the supplied exact page");
    }
  } catch (error) {
    throw new HostStateContractError(
      `retained page evidence is invalid: ${
        error instanceof Error ? error.message : "invalid encoding"
      }`,
    );
  } finally {
    bytes.fill(0);
  }
}

function stagePageTransaction(
  transaction: HostStateRepositorySqlTransaction,
  request: StageIngressReadPageRequest,
  machineIdentityId: string,
): void {
  const requestedPosition = parseBrokerReadPositionV1(request.requestedPosition);
  const nextPosition = parseBrokerReadPositionV1(request.nextPosition);
  const generationKeys = [
    "schemaVersion",
    "brokerRouteId",
    "channelGeneration",
    "state",
    "frameCount",
    "nextGeneration",
    "manifestDigest",
  ];
  if (
    Object.keys(request.generation).length !== generationKeys.length ||
    generationKeys.some((key, index) => Object.keys(request.generation)[index] !== key) ||
    request.generation.schemaVersion !== 1 ||
    request.frames.length > A1_BROKER_MAX_READ_FRAMES ||
    request.frames.length > A1_INGRESS_LOOKAHEAD_MAX_FRAMES ||
    request.generation.brokerRouteId !== request.scope.brokerRouteId ||
    request.requestedPosition.channelGeneration !== request.generation.channelGeneration
  ) {
    throw new HostStateContractError("stageReadPage does not match the selected bounded page");
  }
  if (
    !Number.isSafeInteger(request.observedNextFrameIndex) ||
    request.observedNextFrameIndex < 0 ||
    request.observedNextFrameIndex > 4_096 ||
    request.generation.channelGeneration !== requestedPosition.channelGeneration ||
    request.generation.channelGeneration < 0 ||
    !Number.isSafeInteger(request.generation.channelGeneration) ||
    (request.generation.state === "sealed" &&
      (request.generation.nextGeneration !== request.generation.channelGeneration + 1 ||
        request.generation.frameCount === null ||
        request.generation.frameCount < 0 ||
        request.generation.frameCount > 4_096 ||
        request.generation.manifestDigest === null ||
        digest(
          canonicalA1BrokerGenerationManifestV1({
            brokerRouteId: request.scope.brokerRouteId,
            channelGeneration: request.generation.channelGeneration,
            frameCount: request.generation.frameCount,
            nextGeneration: request.generation.nextGeneration,
            state: "sealed",
          }),
        ) !== request.generation.manifestDigest)) ||
    (request.generation.state === "open" &&
      (request.generation.frameCount !== null ||
        request.generation.nextGeneration !== null ||
        request.generation.manifestDigest !== null))
  ) {
    throw new HostStateContractError("stageReadPage generation evidence is invalid");
  }
  void nextPosition;
  verifyReadPageEvidence(transaction, request);
  rejectCrossRouteIngressArtifactReuse(
    transaction,
    request.scope.brokerRouteId,
    request.pageEvidenceRef,
  );
  const fetch = oneMapped(transaction, "broker_route_fetch_cursors", request.scope.brokerRouteId);
  if (
    fetch === null ||
    fetch.nextGeneration !== request.requestedPosition.channelGeneration ||
    fetch.nextFrameIndex !== request.requestedPosition.nextFrameIndex
  ) {
    throw new IngressRepositoryConflictError("page does not begin at the durable fetch head");
  }
  const prospectiveRefs = new Map<ProtectedHandleId, number>();
  if (
    !ingressArtifactIsReferencedByRoute(
      transaction,
      request.scope.brokerRouteId,
      request.pageEvidenceRef,
    )
  ) {
    prospectiveRefs.set(
      request.pageEvidenceRef,
      artifactByteLength(transaction, request.pageEvidenceRef),
    );
  }
  const existingPositions = new Map<
    string,
    Readonly<{
      receivedFrameDigest: A1Digest;
      receivedFrameByteLength: number;
      claimedDeliveryAttemptId: A1SafeId;
      claimedPart: number;
      claimedTransportFrameDigest: A1Digest;
    }>
  >();
  for (let index = 0; index < request.frames.length; index++) {
    const frame = request.frames[index];
    if (frame === undefined) continue;
    const parsedCursor = parseBrokerChannelCursorV1(frame.cursor);
    const expectedIndex = requestedPosition.nextFrameIndex + index;
    if (
      parsedCursor.channelGeneration !== request.generation.channelGeneration ||
      parsedCursor.frameIndex !== expectedIndex ||
      frame.receivedFrameByteLength < 0 ||
      !Number.isSafeInteger(frame.receivedFrameByteLength) ||
      frame.receivedFrameByteLength > 4_450_000 ||
      frame.claimedPart < 0 ||
      !Number.isSafeInteger(frame.claimedPart) ||
      frame.claimedPart >= 32 ||
      !/^rda_[A-Za-z0-9_-]{22}$/.test(parseA1SafeId(frame.claimedDeliveryAttemptId)) ||
      parseA1Digest(frame.claimedTransportFrameDigest) !== frame.claimedTransportFrameDigest ||
      parseA1Digest(frame.receivedFrameDigest) !== frame.receivedFrameDigest ||
      expectedPositionId(request.scope.brokerRouteId, parsedCursor) !==
        frame.channelPositionObservationId
    ) {
      throw new HostStateContractError("stageReadPage frames are not a contiguous exact page");
    }
    verifyArtifactAndScrub(
      transaction,
      frame.receivedFrameRef,
      request.scope.collaborationServerId,
      A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
      frame.receivedFrameDigest,
      frame.receivedFrameByteLength,
    );
    rejectCrossRouteIngressArtifactReuse(
      transaction,
      request.scope.brokerRouteId,
      frame.receivedFrameRef,
    );
    const existing = sqlGet(
      transaction,
      `SELECT received_frame_digest, received_frame_byte_length,
              claimed_delivery_attempt_id, claimed_part, claimed_transport_frame_digest
         FROM authenticated_channel_positions
        WHERE broker_route_id = ? AND channel_generation = ? AND frame_index = ? LIMIT 1`,
      [request.scope.brokerRouteId, frame.cursor.channelGeneration, frame.cursor.frameIndex],
    );
    if (
      !ingressArtifactIsReferencedByRoute(
        transaction,
        request.scope.brokerRouteId,
        frame.receivedFrameRef,
      )
    ) {
      prospectiveRefs.set(frame.receivedFrameRef, frame.receivedFrameByteLength);
    }
    if (existing !== undefined) {
      const row = mappedRow(existing, "existingPositionPreflight");
      existingPositions.set(
        `${frame.cursor.channelGeneration}:${frame.cursor.frameIndex}`,
        Object.freeze({
          receivedFrameDigest: parseA1Digest(row.receivedFrameDigest),
          receivedFrameByteLength: Number(row.receivedFrameByteLength),
          claimedDeliveryAttemptId: parseA1SafeId(row.claimedDeliveryAttemptId),
          claimedPart: Number(row.claimedPart),
          claimedTransportFrameDigest: parseA1Digest(row.claimedTransportFrameDigest),
        }),
      );
    }
  }
  const consumedIndex = request.requestedPosition.nextFrameIndex + request.frames.length;
  const expectedNext =
    request.generation.state === "sealed" && consumedIndex === request.generation.frameCount
      ? {
          channelGeneration: request.generation.nextGeneration,
          nextFrameIndex: 0,
        }
      : {
          channelGeneration: request.generation.channelGeneration,
          nextFrameIndex: consumedIndex,
        };
  if (
    request.observedNextFrameIndex < consumedIndex ||
    (request.frames.length === 0 && consumedIndex < request.observedNextFrameIndex) ||
    (request.generation.state === "sealed" &&
      request.observedNextFrameIndex !== request.generation.frameCount) ||
    request.nextPosition.channelGeneration !== expectedNext.channelGeneration ||
    request.nextPosition.nextFrameIndex !== expectedNext.nextFrameIndex ||
    request.atLiveTail !==
      (request.generation.state === "open" && consumedIndex === request.observedNextFrameIndex)
  ) {
    throw new HostStateContractError("stageReadPage cursor/manifest page shape is inconsistent");
  }
  const retained = retainedIngressBytes(transaction);
  const addedBytes = [...prospectiveRefs.values()].reduce((sum, bytes) => sum + bytes, 0);
  const routeBytes = retained.byRoute.get(request.scope.brokerRouteId) ?? 0;
  const identityBytes = retained.byIdentity.get(machineIdentityId) ?? 0;
  const lookaheadBytes = retained.unresolvedByRoute.get(request.scope.brokerRouteId) ?? 0;
  const unresolvedPositionCount = Number(
    mappedRow(
      sqlGet(
        transaction,
        `SELECT count(*) AS count
           FROM authenticated_channel_positions AS position
           JOIN broker_route_semantic_cursors AS semantic USING (broker_route_id)
          WHERE position.broker_route_id=?
            AND (position.channel_generation > semantic.next_generation
              OR (position.channel_generation = semantic.next_generation
                AND position.frame_index >= semantic.next_frame_index))`,
        [request.scope.brokerRouteId],
      ),
      "unresolvedPositionCount",
    ).count,
  );
  const newPositionCount = request.frames.length - existingPositions.size;
  if (
    routeBytes + addedBytes >
      A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE -
        A1_INGRESS_AUDIT_RESERVE_BYTES_PER_ROUTE ||
    identityBytes + addedBytes >
      A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY -
        A1_INGRESS_AUDIT_RESERVE_BYTES_PER_IDENTITY ||
    retained.global + addedBytes >
      A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL - A1_INGRESS_AUDIT_RESERVE_BYTES_GLOBAL ||
    lookaheadBytes + addedBytes > A1_INGRESS_LOOKAHEAD_MAX_BYTES ||
    unresolvedPositionCount + newPositionCount > A1_INGRESS_LOOKAHEAD_MAX_FRAMES
  ) {
    throw new IngressRepositoryQuotaError();
  }
  const readPageObservationId = insertReadPageObservation(transaction, request);
  insertReadPageFrameEvidence(transaction, request, readPageObservationId);
  const existingGeneration = sqlGet(
    transaction,
    `SELECT state, observed_next_frame_index, frame_count, next_generation, manifest_digest,
            last_observed_at_ms
       FROM broker_channel_generation_observations
      WHERE broker_route_id = ? AND channel_generation = ? LIMIT 1`,
    [request.scope.brokerRouteId, request.generation.channelGeneration],
  );
  if (existingGeneration === undefined) {
    sqlRun(
      transaction,
      `INSERT INTO broker_channel_generation_observations (
       broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
       channel_generation, state, observed_next_frame_index, frame_count,
       next_generation, manifest_digest, first_observed_at_ms, last_observed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.scope.brokerRouteId,
        request.scope.collaborationServerId,
        request.scope.routeKind,
        request.scope.logicalChatId,
        request.generation.channelGeneration,
        request.generation.state,
        request.observedNextFrameIndex,
        request.generation.frameCount,
        request.generation.nextGeneration,
        request.generation.manifestDigest,
        request.observedAtMs,
        request.observedAtMs,
      ],
    );
  } else {
    const row = mappedRow(existingGeneration, "generationObservation");
    const exactSealed =
      row.state === "sealed" &&
      request.generation.state === "sealed" &&
      row.state === request.generation.state &&
      row.frameCount === request.generation.frameCount &&
      row.nextGeneration === request.generation.nextGeneration &&
      row.manifestDigest === request.generation.manifestDigest;
    const canObserveOpen =
      row.state === "open" &&
      request.generation.state === "open" &&
      Number(row.observedNextFrameIndex) <= request.observedNextFrameIndex;
    const canSeal =
      row.state === "open" &&
      request.generation.state === "sealed" &&
      Number(row.observedNextFrameIndex) <= request.generation.frameCount;
    if (request.observedAtMs < Number(row.lastObservedAtMs)) {
      throw new IngressRepositoryConflictError("page clock precedes retained generation evidence");
    }
    if (!exactSealed && !canObserveOpen && !canSeal) {
      latchManifestEquivocation(
        transaction,
        request,
        row.manifestDigest === null ? null : parseA1Digest(row.manifestDigest),
        readPageObservationId,
      );
      return;
    }
    sqlRun(
      transaction,
      `UPDATE broker_channel_generation_observations
          SET state = ?, observed_next_frame_index = ?, frame_count = ?, next_generation = ?,
              manifest_digest = ?, last_observed_at_ms = ?
        WHERE broker_route_id = ? AND channel_generation = ?`,
      [
        request.generation.state,
        Math.max(Number(row.observedNextFrameIndex), request.observedNextFrameIndex),
        request.generation.frameCount,
        request.generation.nextGeneration,
        request.generation.manifestDigest,
        request.observedAtMs,
        request.scope.brokerRouteId,
        request.generation.channelGeneration,
      ],
    );
  }
  for (const frame of request.frames) {
    const existing = existingPositions.get(
      `${frame.cursor.channelGeneration}:${frame.cursor.frameIndex}`,
    );
    if (existing !== undefined) {
      if (existing.receivedFrameDigest !== frame.receivedFrameDigest) {
        latchPositionEquivocation(
          transaction,
          request,
          frame,
          existing.receivedFrameDigest,
          readPageObservationId,
        );
        return;
      }
      if (
        existing.receivedFrameByteLength !== frame.receivedFrameByteLength ||
        existing.claimedDeliveryAttemptId !== frame.claimedDeliveryAttemptId ||
        existing.claimedPart !== frame.claimedPart ||
        existing.claimedTransportFrameDigest !== frame.claimedTransportFrameDigest
      ) {
        insertGap(
          transaction,
          request.scope,
          "outer_page_invalid",
          deterministicEvidenceId(
            "outer-claim-equivocation",
            request.scope.brokerRouteId,
            frame.channelPositionObservationId,
            frame.claimedDeliveryAttemptId,
            String(frame.claimedPart),
            frame.claimedTransportFrameDigest,
            readPageObservationId,
          ),
          request.pageEvidenceRef,
          request.pageEvidenceDigest,
          request.observedAtMs,
        );
        return;
      }
      continue;
    }
    sqlRun(
      transaction,
      `INSERT INTO authenticated_channel_positions (
       channel_position_observation_id, broker_route_id, collaboration_server_id,
       route_kind, logical_chat_id, channel_generation, frame_index,
       claimed_delivery_attempt_id, claimed_part, claimed_transport_frame_digest,
       received_frame_ref, received_frame_digest, received_frame_byte_length,
       normalized_transport_frame_digest, frame_identity_id, frame_collaboration_server_id,
       frame_logical_chat_id, direction, record_kind, sequence, message_id,
       delivery_attempt_id, client_message_id, key_epoch, part, parts,
       server_key_generation, host_signer_identity_key_id, host_scope_certificate_id,
       host_signature_sequence, stable_logical_header_digest, classification,
       validation_failure_code, ingress_observation_id, cursor_disposition,
       recovery_id, gap_id, observed_at_ms, classified_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
                 'pending_validation',NULL,NULL,'blocked',NULL,NULL,?,NULL)`,
      [
        frame.channelPositionObservationId,
        request.scope.brokerRouteId,
        request.scope.collaborationServerId,
        request.scope.routeKind,
        request.scope.logicalChatId,
        frame.cursor.channelGeneration,
        frame.cursor.frameIndex,
        frame.claimedDeliveryAttemptId,
        frame.claimedPart,
        frame.claimedTransportFrameDigest,
        frame.receivedFrameRef,
        frame.receivedFrameDigest,
        frame.receivedFrameByteLength,
        request.observedAtMs,
      ],
    );
  }
  const advanced = sqlRun(
    transaction,
    `UPDATE broker_route_fetch_cursors SET next_generation = ?, next_frame_index = ?,
            revision = revision + 1, updated_at_ms = ?
      WHERE broker_route_id = ? AND next_generation = ? AND next_frame_index = ?`,
    [
      request.nextPosition.channelGeneration,
      request.nextPosition.nextFrameIndex,
      request.observedAtMs,
      request.scope.brokerRouteId,
      request.requestedPosition.channelGeneration,
      request.requestedPosition.nextFrameIndex,
    ],
  );
  if (Number(advanced.changes) !== 1) {
    throw new IngressRepositoryConflictError("fetch cursor compare-and-swap failed");
  }
}

function parsedHeaderColumns(
  parsed: ParsedIngressPositionEvidence,
): readonly HostStateRepositorySqlValue[] {
  const header = parsed.header;
  return [
    parsed.normalizedTransportFrameDigest,
    Buffer.from(header.identityId).toString("hex"),
    header.collaborationServerId,
    header.logicalChatId,
    header.dir,
    header.recordKind,
    header.seq,
    header.msgId,
    header.deliveryAttemptId,
    header.clientMsgId,
    header.keyEpoch,
    header.part,
    header.parts,
    header.serverKeyGeneration,
    header.hostSignerIdentityKeyId,
    header.hostScopeCertificateId,
    header.hostSignatureSequence,
    digest(
      (() => {
        const writer = new CanonicalWriter();
        writer.str("remote-claw/a1/attempt-header/v1");
        writer.bytes(canonicalA1StableLogicalHeader(header));
        return writer.finish();
      })(),
    ),
  ];
}

function classifyTerminalPositionTransaction(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInvalidIngressPositionRequest | ClassifyUnknownOutboundPositionRequest,
  classification: "invalid" | "unknown_outbound",
  machineIdentityId: string,
): void {
  const positionId =
    "channelPositionObservationId" in request
      ? request.channelPositionObservationId
      : request.parsed.channelPositionObservationId;
  if (request.parsed !== null && request.parsed.channelPositionObservationId !== positionId) {
    throw new HostStateContractError("terminal classification position identity is inconsistent");
  }
  const value = sqlGet(
    transaction,
    `SELECT * FROM authenticated_channel_positions
      WHERE channel_position_observation_id=? AND broker_route_id=? LIMIT 1`,
    [positionId, request.scope.brokerRouteId],
  );
  if (value === undefined) throw new IngressRepositoryConflictError("position is not staged");
  const retainedPosition = mappedRow(value, "terminalPosition");
  if (retainedPosition.classification !== "pending_validation") {
    throw new IngressRepositoryConflictError("position is already classified");
  }
  if (request.observedAtMs < Number(retainedPosition.observedAtMs)) {
    throw new IngressRepositoryConflictError("classification clock precedes staged evidence");
  }

  if (request.parsed === null) {
    const raw = verifyArtifact(
      transaction,
      retainedPosition.receivedFrameRef as ProtectedHandleId,
      request.scope.collaborationServerId,
      A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
      parseA1Digest(retainedPosition.receivedFrameDigest),
      Number(retainedPosition.receivedFrameByteLength),
    );
    let parsedSuccessfully = false;
    try {
      parseA1EncryptedFrameV2(raw);
      parsedSuccessfully = true;
    } catch {
      // A strict parse failure is the durable reason a null parsed tuple is admissible.
    } finally {
      raw.fill(0);
    }
    if (parsedSuccessfully) {
      throw new HostStateContractError(
        "a valid retained frame cannot be classified invalid without parsed evidence",
      );
    }
  } else {
    const inspected = inspectStagedPosition(
      transaction,
      request.scope,
      machineIdentityId,
      request.parsed,
    );
    const header = request.parsed.header;
    const selectedInbound =
      inspected.routeMatches &&
      inspected.brokerClaimsMatch &&
      header.dir === "in" &&
      ((request.scope.routeKind === "chat" && header.recordKind === "user") ||
        (request.scope.routeKind === "server_control" && header.recordKind === "new_chat"));
    const selectedOutbound =
      inspected.routeMatches && inspected.brokerClaimsMatch && header.dir === "out";
    if (classification === "unknown_outbound") {
      if (!selectedOutbound) {
        throw new HostStateContractError(
          "unknown outbound classification is not proved by retained route-bound outer evidence",
        );
      }
    } else if (
      selectedOutbound ||
      (selectedInbound &&
        !(
          "validationFailureCode" in request &&
          POST_HEADER_INVALID_FAILURE_CODES.has(request.validationFailureCode)
        ))
    ) {
      throw new HostStateContractError(
        "selected retained ingress/outbound evidence cannot be terminalized as invalid",
      );
    }
  }

  verifyCanonicalGapEvidence(
    transaction,
    request.gapEvidenceRef,
    request.scope,
    request.gapEvidenceDigest,
    classification === "invalid"
      ? (request as ClassifyInvalidIngressPositionRequest).validationFailureCode
      : parseA1SafeId("unknown_outbound"),
    positionId,
    "null",
  );
  assertIngressAuditEvidenceQuota(transaction, request.scope, request.gapEvidenceRef);
  const gapId = insertGap(
    transaction,
    request.scope,
    classification === "invalid" ? "invalid_frame" : "unknown_outbound",
    positionId,
    request.gapEvidenceRef,
    request.gapEvidenceDigest,
    request.observedAtMs,
    { positionId },
  );
  const parsedValues =
    request.parsed === null
      ? ([
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ] as const)
      : parsedHeaderColumns(request.parsed);
  const result = sqlRun(
    transaction,
    `UPDATE authenticated_channel_positions SET
       normalized_transport_frame_digest=?, frame_identity_id=?,
       frame_collaboration_server_id=?, frame_logical_chat_id=?, direction=?, record_kind=?,
       sequence=?, message_id=?, delivery_attempt_id=?, client_message_id=?, key_epoch=?,
       part=?, parts=?, server_key_generation=?, host_signer_identity_key_id=?,
       host_scope_certificate_id=?, host_signature_sequence=?, stable_logical_header_digest=?,
       classification=?, validation_failure_code=?, ingress_observation_id=NULL,
       cursor_disposition=?, gap_id=?, classified_at_ms=?
     WHERE channel_position_observation_id=? AND classification='pending_validation'`,
    [
      ...parsedValues,
      classification,
      classification === "invalid" && "validationFailureCode" in request
        ? request.validationFailureCode
        : null,
      classification === "invalid" ? "advanceable" : "blocked",
      gapId,
      request.observedAtMs,
      positionId,
    ],
  );
  if (Number(result.changes) !== 1) {
    throw new IngressRepositoryConflictError("position classification compare-and-swap failed");
  }
}

function readPlaintextParts(
  transaction: HostStateRepositorySqlTransaction,
  resultId: A1SafeId,
  attemptId: A1SafeId,
): readonly Uint8Array[] {
  const parts: Uint8Array[] = [];
  try {
    const rows = sqlAll(
      transaction,
      `SELECT p.part, p.plaintext_part_ref, p.plaintext_part_digest,
              p.plaintext_part_byte_length, p.collaboration_server_id
         FROM authenticated_ingress_parts AS p
        WHERE p.stable_semantic_result_id = ? AND p.delivery_attempt_id = ?
        ORDER BY p.part`,
      [resultId, attemptId],
    );
    for (let index = 0; index < rows.length; index++) {
      const value = rows[index];
      const row = mappedRow(value, "plaintextPart");
      if (row.part !== index)
        throw new IngressRepositoryPersistenceError("part vector is not contiguous");
      parts.push(
        verifyArtifact(
          transaction,
          row.plaintextPartRef as ProtectedHandleId,
          row.collaborationServerId as CollaborationServerId,
          A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
          parseA1Digest(row.plaintextPartDigest),
          Number(row.plaintextPartByteLength),
        ),
      );
    }
    return Object.freeze(parts);
  } catch (error) {
    for (const part of parts) part.fill(0);
    throw error;
  }
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (length > A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES) {
    throw new IngressRepositoryConflictError("reassembled plaintext exceeds the selected bound");
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function canonicalPartDigest(header: A1FrameHeaderV2, plaintext: Uint8Array): A1Digest {
  const writer = new CanonicalWriter();
  let canonicalHeader: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    writer.str("remote-claw/a1/stable-part/v1");
    canonicalHeader = canonicalA1IngressStableLogicalHeader(header);
    writer.bytes(canonicalHeader);
    writer.uint(header.part);
    writer.uint(header.parts);
    writer.bytes(plaintext);
    preimage = writer.finish();
    return digest(preimage);
  } finally {
    canonicalHeader?.fill(0);
    preimage?.fill(0);
    writer.destroy();
  }
}

function canonicalMessageDigest(header: A1FrameHeaderV2, plaintext: Uint8Array): A1Digest {
  const writer = new CanonicalWriter();
  let canonicalHeader: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    writer.str("remote-claw/a1/logical-message/v1");
    canonicalHeader = canonicalA1IngressStableLogicalHeader(header);
    writer.bytes(canonicalHeader);
    writer.uint(header.parts);
    writer.bytes(plaintext);
    preimage = writer.finish();
    return digest(preimage);
  } finally {
    canonicalHeader?.fill(0);
    preimage?.fill(0);
    writer.destroy();
  }
}

function insertIngressObservation(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  binding: Readonly<{
    stableSemanticResultId: A1SafeId;
    deliveryAttemptId: A1SafeId;
    disposition: AuthenticatedIngressObservationRecord["disposition"];
    cursorDisposition: "blocked" | "advanceable";
    gapId: A1SafeId | null;
    generation: number;
    frameIndex: number;
  }>,
): void {
  const header = request.parsed.header;
  sqlRun(
    transaction,
    `INSERT INTO authenticated_ingress_observations (
     ingress_observation_id, channel_position_observation_id, stable_semantic_result_id,
     delivery_attempt_id, broker_route_id, collaboration_server_id, route_kind,
     logical_chat_id, channel_generation, frame_index, part, parts,
     authenticated_part_digest, plaintext_evidence_ref, plaintext_evidence_digest,
     plaintext_evidence_byte_length, disposition, cursor_disposition, gap_id, recovery_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      request.ingressObservationId,
      request.parsed.channelPositionObservationId,
      binding.stableSemanticResultId,
      binding.deliveryAttemptId,
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      binding.generation,
      binding.frameIndex,
      header.part,
      header.parts,
      request.authenticatedPartDigest,
      request.plaintextPartRef,
      request.plaintextPartDigest,
      request.plaintextPartByteLength,
      binding.disposition,
      binding.cursorDisposition,
      binding.gapId,
    ],
  );
  const updated = sqlRun(
    transaction,
    `UPDATE authenticated_channel_positions SET
       normalized_transport_frame_digest=?, frame_identity_id=?, frame_collaboration_server_id=?,
       frame_logical_chat_id=?, direction=?, record_kind=?, sequence=?, message_id=?,
       delivery_attempt_id=?, client_message_id=?, key_epoch=?, part=?, parts=?,
       server_key_generation=?, host_signer_identity_key_id=?, host_scope_certificate_id=?,
       host_signature_sequence=?, stable_logical_header_digest=?, classification='inbound_ingress',
       ingress_observation_id=?, cursor_disposition=?, gap_id=?, classified_at_ms=?
     WHERE channel_position_observation_id=? AND classification='pending_validation'`,
    [
      ...parsedHeaderColumns(request.parsed),
      request.ingressObservationId,
      binding.cursorDisposition,
      binding.gapId,
      request.observedAtMs,
      request.parsed.channelPositionObservationId,
    ],
  );
  if (Number(updated.changes) !== 1) {
    throw new IngressRepositoryConflictError("position classification compare-and-swap failed");
  }
}

function openSemanticGap(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  position: Record<string, unknown>,
  identity: A1SafeId,
  resultId: A1SafeId,
): A1SafeId {
  return insertGap(
    transaction,
    request.scope,
    "semantic_collision",
    deterministicEvidenceId(
      "semantic-gap-position",
      identity,
      request.parsed.channelPositionObservationId,
    ),
    position.receivedFrameRef as ProtectedHandleId,
    parseA1Digest(position.receivedFrameDigest),
    request.observedAtMs,
    { resultId },
  );
}

function openInvalidPayloadGap(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  position: Record<string, unknown>,
): A1SafeId {
  return insertGap(
    transaction,
    request.scope,
    "invalid_frame",
    request.parsed.channelPositionObservationId,
    position.receivedFrameRef as ProtectedHandleId,
    parseA1Digest(position.receivedFrameDigest),
    request.observedAtMs,
    { positionId: request.parsed.channelPositionObservationId },
  );
}

function openTransportCollision(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  position: Record<string, unknown>,
  original: Readonly<{
    channelGeneration: number;
    frameIndex: number;
    transportFrameDigest: A1Digest;
  }>,
): Readonly<{ collisionId: A1SafeId; gapId: A1SafeId }> {
  const header = request.parsed.header;
  const collisionId = deterministicEvidenceId(
    "transport-collision",
    request.scope.brokerRouteId,
    header.deliveryAttemptId,
    String(header.part),
    original.transportFrameDigest,
    request.parsed.normalizedTransportFrameDigest,
  );
  sqlRun(
    transaction,
    `INSERT OR IGNORE INTO broker_transport_key_collisions (
       transport_key_collision_id, broker_route_id, collaboration_server_id, route_kind,
       logical_chat_id, delivery_attempt_id, part, original_channel_generation,
       original_frame_index, original_transport_frame_digest,
       conflicting_transport_frame_digest, conflicting_frame_digest,
       conflicting_frame_ref, observed_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      collisionId,
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      header.deliveryAttemptId,
      header.part,
      original.channelGeneration,
      original.frameIndex,
      original.transportFrameDigest,
      request.parsed.normalizedTransportFrameDigest,
      parseA1Digest(position.receivedFrameDigest),
      position.receivedFrameRef as ProtectedHandleId,
      request.observedAtMs,
    ],
  );
  return Object.freeze({
    collisionId,
    gapId: insertGap(
      transaction,
      request.scope,
      "transport_collision",
      deterministicEvidenceId(
        "transport-gap-position",
        collisionId,
        request.parsed.channelPositionObservationId,
      ),
      position.receivedFrameRef as ProtectedHandleId,
      parseA1Digest(position.receivedFrameDigest),
      request.observedAtMs,
      { transportId: collisionId },
    ),
  });
}

function readFirstTransportKeyPosition(
  transaction: HostStateRepositorySqlTransaction,
  brokerRouteId: BrokerRouteId,
  deliveryAttemptId: A1SafeId,
  part: number,
): Readonly<{
  channelGeneration: number;
  frameIndex: number;
  transportFrameDigest: A1Digest;
}> | null {
  const value = sqlGet(
    transaction,
    `SELECT channel_generation, frame_index, normalized_transport_frame_digest
       FROM authenticated_channel_positions
      WHERE broker_route_id=? AND delivery_attempt_id=? AND part=?
        AND normalized_transport_frame_digest IS NOT NULL
      ORDER BY channel_generation, frame_index LIMIT 1`,
    [brokerRouteId, deliveryAttemptId, part],
  );
  if (value === undefined) return null;
  const row = mappedRow(value, "firstTransportKeyPosition");
  return Object.freeze({
    channelGeneration: Number(row.channelGeneration),
    frameIndex: Number(row.frameIndex),
    transportFrameDigest: parseA1Digest(row.normalizedTransportFrameDigest),
  });
}

function updateResultAsPrecompletionCollision(
  transaction: HostStateRepositorySqlTransaction,
  resultId: A1SafeId,
  observedAtMs: number,
): void {
  sqlRun(
    transaction,
    `UPDATE authenticated_ingress_results
        SET state='quarantined_collision', collision_at_ms=?, terminal_at_ms=?
      WHERE stable_semantic_result_id=?
        AND state IN ('assembling', 'awaiting_order')
        AND NOT (
          state='awaiting_order'
          AND EXISTS (
            SELECT 1 FROM a1_ingress_adjudications adjudication
             WHERE adjudication.stable_semantic_result_id=
               authenticated_ingress_results.stable_semantic_result_id
          )
        )`,
    [observedAtMs, observedAtMs, resultId],
  );
}

function readClassificationState(
  transaction: HostStateRepositorySqlTransaction,
  resultId: A1SafeId,
  attemptId: A1SafeId,
): Omit<IngressPartClassificationResult, "actor" | "replayed"> {
  const result = mappedRow(
    sqlGet(
      transaction,
      `SELECT state, source_payload_schema_id, canonical_message_digest,
              source_event_fingerprint
         FROM authenticated_ingress_results
        WHERE stable_semantic_result_id=? LIMIT 1`,
      [resultId],
    ),
    "classificationResult",
  );
  const candidate = mappedRow(
    sqlGet(
      transaction,
      `SELECT state FROM ingress_delivery_candidates
        WHERE stable_semantic_result_id=? AND delivery_attempt_id=? LIMIT 1`,
      [resultId, attemptId],
    ),
    "classificationCandidate",
  );
  return Object.freeze({
    candidateState: candidate.state as IngressPartClassificationResult["candidateState"],
    resultState: result.state as IngressPartClassificationResult["resultState"],
    stableSemanticResultId: resultId,
    sourcePayloadSchemaId:
      result.sourcePayloadSchemaId === null ? null : String(result.sourcePayloadSchemaId),
    canonicalMessageDigest:
      result.canonicalMessageDigest === null ? null : parseA1Digest(result.canonicalMessageDigest),
    sourceEventFingerprint:
      result.sourceEventFingerprint === null ? null : parseA1Digest(result.sourceEventFingerprint),
  });
}

function readStandaloneClassificationState(
  transaction: HostStateRepositorySqlTransaction,
  resultId: A1SafeId,
  candidateState: IngressPartClassificationResult["candidateState"],
): Omit<IngressPartClassificationResult, "actor" | "replayed"> {
  const result = mappedRow(
    sqlGet(
      transaction,
      `SELECT state, source_payload_schema_id, canonical_message_digest,
              source_event_fingerprint
         FROM authenticated_ingress_results
        WHERE stable_semantic_result_id=? LIMIT 1`,
      [resultId],
    ),
    "standaloneClassificationResult",
  );
  return Object.freeze({
    candidateState,
    resultState: result.state as IngressPartClassificationResult["resultState"],
    stableSemanticResultId: resultId,
    sourcePayloadSchemaId:
      result.sourcePayloadSchemaId === null ? null : String(result.sourcePayloadSchemaId),
    canonicalMessageDigest:
      result.canonicalMessageDigest === null ? null : parseA1Digest(result.canonicalMessageDigest),
    sourceEventFingerprint:
      result.sourceEventFingerprint === null ? null : parseA1Digest(result.sourceEventFingerprint),
  });
}

function insertExactAttempt(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  stableHeaderDigest: A1Digest,
): void {
  const header = request.parsed.header;
  sqlRun(
    transaction,
    `INSERT INTO ingress_transport_attempts (
       broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
       delivery_attempt_id, source_event_namespace_id, stable_semantic_result_id,
       message_id, record_kind, client_message_id, stable_logical_header_digest, expected_parts,
       binding_disposition, collision_gap_id, candidate_required_result_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', NULL, ?)`,
    [
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      header.deliveryAttemptId,
      request.sourceEventNamespaceId,
      request.stableSemanticResultId,
      header.msgId,
      header.recordKind,
      header.clientMsgId,
      stableHeaderDigest,
      header.parts,
      request.stableSemanticResultId,
    ],
  );
}

function insertCandidate(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  generation: number,
  frameIndex: number,
  state: "assembling" | "collision" = "assembling",
): void {
  sqlRun(
    transaction,
    `INSERT INTO ingress_delivery_candidates (
       stable_semantic_result_id, delivery_attempt_id, broker_route_id, collaboration_server_id,
       route_kind, logical_chat_id, expected_parts, received_parts, plaintext_byte_count,
       first_ingress_generation, first_ingress_frame_index, last_observed_ingress_generation,
       last_observed_ingress_frame_index, state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    [
      request.stableSemanticResultId,
      request.parsed.header.deliveryAttemptId,
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      request.parsed.header.parts,
      generation,
      frameIndex,
      generation,
      frameIndex,
      state,
    ],
  );
}

function insertSemanticCollisionAttempt(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  stableHeaderDigest: A1Digest,
  gapId: A1SafeId,
  generation: number,
  frameIndex: number,
): void {
  const header = request.parsed.header;
  sqlRun(
    transaction,
    `INSERT INTO ingress_transport_attempts (
       broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
       delivery_attempt_id, source_event_namespace_id, stable_semantic_result_id,
       message_id, record_kind, client_message_id, stable_logical_header_digest, expected_parts,
       binding_disposition, collision_gap_id, candidate_required_result_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collision', ?, NULL)`,
    [
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      header.deliveryAttemptId,
      request.sourceEventNamespaceId,
      request.stableSemanticResultId,
      header.msgId,
      header.recordKind,
      header.clientMsgId,
      stableHeaderDigest,
      header.parts,
      gapId,
    ],
  );
  void generation;
  void frameIndex;
}

function insertPart(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  generation: number,
  frameIndex: number,
): void {
  const header = request.parsed.header;
  sqlRun(
    transaction,
    `INSERT INTO authenticated_ingress_parts (
       stable_semantic_result_id, delivery_attempt_id, part, broker_route_id,
       collaboration_server_id, route_kind, logical_chat_id, parts,
       authenticated_part_digest, plaintext_part_ref, plaintext_part_digest,
       plaintext_part_byte_length, first_ingress_generation, first_ingress_frame_index
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.stableSemanticResultId,
      header.deliveryAttemptId,
      header.part,
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      header.parts,
      request.authenticatedPartDigest,
      request.plaintextPartRef,
      request.plaintextPartDigest,
      request.plaintextPartByteLength,
      generation,
      frameIndex,
    ],
  );
}

function completeCandidatePositions(
  transaction: HostStateRepositorySqlTransaction,
  resultId: A1SafeId,
  attemptId: A1SafeId,
): void {
  sqlRun(
    transaction,
    `UPDATE authenticated_ingress_observations SET cursor_disposition='advanceable'
      WHERE stable_semantic_result_id=? AND delivery_attempt_id=?
        AND gap_id IS NULL AND cursor_disposition='blocked'`,
    [resultId, attemptId],
  );
  sqlRun(
    transaction,
    `UPDATE authenticated_channel_positions SET cursor_disposition='advanceable'
      WHERE ingress_observation_id IN (
        SELECT ingress_observation_id FROM authenticated_ingress_observations
         WHERE stable_semantic_result_id=? AND delivery_attempt_id=? AND gap_id IS NULL
      ) AND cursor_disposition='blocked'`,
    [resultId, attemptId],
  );
}

function advanceGaplessResultPositions(
  transaction: HostStateRepositorySqlTransaction,
  resultId: A1SafeId,
): void {
  sqlRun(
    transaction,
    `UPDATE authenticated_ingress_observations SET cursor_disposition='advanceable'
      WHERE stable_semantic_result_id=? AND gap_id IS NULL
        AND cursor_disposition='blocked'`,
    [resultId],
  );
  sqlRun(
    transaction,
    `UPDATE authenticated_channel_positions SET cursor_disposition='advanceable'
      WHERE ingress_observation_id IN (
        SELECT ingress_observation_id FROM authenticated_ingress_observations
         WHERE stable_semantic_result_id=? AND gap_id IS NULL
      ) AND cursor_disposition='blocked'`,
    [resultId],
  );
}

function sameAttemptBinding(
  row: Record<string, unknown>,
  request: ClassifyInboundPartRequest,
  stableHeaderDigest: A1Digest,
): boolean {
  const header = request.parsed.header;
  return (
    row.stableSemanticResultId === request.stableSemanticResultId &&
    row.sourceEventNamespaceId === request.sourceEventNamespaceId &&
    row.messageId === header.msgId &&
    row.recordKind === header.recordKind &&
    row.clientMessageId === header.clientMsgId &&
    row.stableLogicalHeaderDigest === stableHeaderDigest &&
    row.expectedParts === header.parts &&
    row.bindingDisposition === "exact"
  );
}

function sameResultBinding(
  row: Record<string, unknown>,
  request: ClassifyInboundPartRequest,
): boolean {
  const header = request.parsed.header;
  return (
    row.sourceEventNamespaceId === request.sourceEventNamespaceId &&
    row.messageId === header.msgId &&
    row.recordKind === header.recordKind &&
    row.clientMessageId === header.clientMsgId &&
    row.expectedParts === header.parts
  );
}

function partDigestVector(
  transaction: HostStateRepositorySqlTransaction,
  resultId: A1SafeId,
  attemptId: A1SafeId,
): readonly string[] {
  return Object.freeze(
    sqlAll(
      transaction,
      `SELECT part, parts, authenticated_part_digest FROM authenticated_ingress_parts
        WHERE stable_semantic_result_id=? AND delivery_attempt_id=? ORDER BY part`,
      [resultId, attemptId],
    ).map((value, index) => {
      const row = mappedRow(value, "partDigestVector");
      if (Number(row.part) !== index) {
        throw new IngressRepositoryPersistenceError(
          "accepted part digest vector is not contiguous",
        );
      }
      return `${row.part}:${row.parts}:${row.authenticatedPartDigest}`;
    }),
  );
}

function equalStringVectors(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function classifyInboundPartTransaction(
  transaction: HostStateRepositorySqlTransaction,
  request: ClassifyInboundPartRequest,
  machineIdentityId: string,
  nowMs: number,
): Omit<IngressPartClassificationResult, "actor" | "replayed"> {
  const header = request.parsed.header;
  if (
    request.scope.routeKind === "scope_bus" ||
    header.dir !== "in" ||
    (request.scope.routeKind === "chat" && header.recordKind !== "user") ||
    (request.scope.routeKind === "server_control" && header.recordKind !== "new_chat") ||
    expectedNamespaceId(machineIdentityId, request.scope) !== request.sourceEventNamespaceId ||
    expectedResultId(
      machineIdentityId,
      request.scope,
      request.sourceEventNamespaceId,
      header.msgId,
    ) !== request.stableSemanticResultId ||
    expectedObservationId(request.parsed.channelPositionObservationId) !==
      request.ingressObservationId
  ) {
    throw new HostStateContractError("inbound classification derived identities do not match");
  }
  const inspected = inspectStagedPosition(
    transaction,
    request.scope,
    machineIdentityId,
    request.parsed,
  );
  const position = inspected.row;
  if (position.classification !== "pending_validation") {
    throw new IngressRepositoryConflictError("position is already classified");
  }
  if (
    request.observedAtMs < Number(position.observedAtMs) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    throw new IngressRepositoryConflictError("classification timestamp is outside durable time");
  }
  if (!inspected.routeMatches || !inspected.brokerClaimsMatch) {
    throw new HostStateContractError(
      "inbound classification conflicts with retained route or authenticated outer claims",
    );
  }
  const plaintext = verifyArtifact(
    transaction,
    request.plaintextPartRef,
    request.scope.collaborationServerId,
    A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
    request.plaintextPartDigest,
    request.plaintextPartByteLength,
  );
  try {
    if (
      plaintext.byteLength > A1_INGRESS_MAX_OPENED_PART_BYTES ||
      canonicalPartDigest(header, plaintext) !== request.authenticatedPartDigest
    ) {
      throw new HostStateContractError("inbound plaintext part digest does not recompute");
    }
    const generation = Number(position.channelGeneration);
    const frameIndex = Number(position.frameIndex);
    const attemptId = parseA1SafeId(header.deliveryAttemptId);
    const stableHeaderDigest = parsedHeaderColumns(request.parsed).at(-1) as A1Digest;
    const resultValue = sqlGet(
      transaction,
      `SELECT * FROM authenticated_ingress_results
        WHERE stable_semantic_result_id=? LIMIT 1`,
      [request.stableSemanticResultId],
    );
    const existingAttemptValue = sqlGet(
      transaction,
      `SELECT * FROM ingress_transport_attempts
        WHERE broker_route_id=? AND delivery_attempt_id=? LIMIT 1`,
      [request.scope.brokerRouteId, attemptId],
    );
    const firstTransportPosition = readFirstTransportKeyPosition(
      transaction,
      request.scope.brokerRouteId,
      attemptId,
      header.part,
    );
    const retained = retainedIngressBytes(transaction);
    rejectCrossRouteIngressArtifactReuse(
      transaction,
      request.scope.brokerRouteId,
      request.plaintextPartRef,
    );
    const refAlreadyRetainedByRoute = sqlGet(
      transaction,
      `SELECT 1 FROM authenticated_ingress_parts
        WHERE broker_route_id=? AND plaintext_part_ref=?
       UNION SELECT 1 FROM authenticated_ingress_observations
        WHERE broker_route_id=? AND plaintext_evidence_ref=?
       LIMIT 1`,
      [
        request.scope.brokerRouteId,
        request.plaintextPartRef,
        request.scope.brokerRouteId,
        request.plaintextPartRef,
      ],
    );
    const prospectivePlaintextBytes =
      refAlreadyRetainedByRoute === undefined ? plaintext.byteLength : 0;
    if (
      (retained.byRoute.get(request.scope.brokerRouteId) ?? 0) + prospectivePlaintextBytes >
        A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE -
          A1_INGRESS_AUDIT_RESERVE_BYTES_PER_ROUTE ||
      (retained.byIdentity.get(machineIdentityId) ?? 0) + prospectivePlaintextBytes >
        A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY -
          A1_INGRESS_AUDIT_RESERVE_BYTES_PER_IDENTITY ||
      retained.global + prospectivePlaintextBytes >
        A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL - A1_INGRESS_AUDIT_RESERVE_BYTES_GLOBAL
    ) {
      throw new IngressRepositoryQuotaError();
    }

    if (existingAttemptValue !== undefined) {
      const existingAttempt = mappedRow(existingAttemptValue, "existingAttempt");
      const boundResultId = parseA1SafeId(existingAttempt.stableSemanticResultId);
      if (
        firstTransportPosition !== null &&
        firstTransportPosition.transportFrameDigest !==
          request.parsed.normalizedTransportFrameDigest
      ) {
        const collision = openTransportCollision(
          transaction,
          request,
          position,
          firstTransportPosition,
        );
        sqlRun(
          transaction,
          `UPDATE ingress_delivery_candidates SET state='collision'
            WHERE stable_semantic_result_id=? AND delivery_attempt_id=?
              AND state='assembling'`,
          [boundResultId, attemptId],
        );
        updateResultAsPrecompletionCollision(transaction, boundResultId, request.observedAtMs);
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: boundResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId: collision.gapId,
          generation,
          frameIndex,
        });
        return existingAttempt.bindingDisposition === "exact"
          ? readClassificationState(transaction, boundResultId, attemptId)
          : readStandaloneClassificationState(transaction, boundResultId, "collision");
      }
      if (existingAttempt.bindingDisposition === "collision") {
        const gapId = openSemanticGap(transaction, request, position, attemptId, boundResultId);
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: boundResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId,
          generation,
          frameIndex,
        });
        return readStandaloneClassificationState(transaction, boundResultId, "collision");
      }
      if (!sameAttemptBinding(existingAttempt, request, stableHeaderDigest)) {
        const gapId = openSemanticGap(transaction, request, position, attemptId, boundResultId);
        sqlRun(
          transaction,
          `UPDATE ingress_delivery_candidates SET state='collision'
            WHERE stable_semantic_result_id=? AND delivery_attempt_id=?
              AND state='assembling'`,
          [boundResultId, attemptId],
        );
        updateResultAsPrecompletionCollision(transaction, boundResultId, request.observedAtMs);
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: boundResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId,
          generation,
          frameIndex,
        });
        return readClassificationState(transaction, boundResultId, attemptId);
      }
    }

    if (resultValue !== undefined) {
      const existingResult = mappedRow(resultValue, "existingSemanticResult");
      if (
        existingAttemptValue === undefined &&
        firstTransportPosition !== null &&
        firstTransportPosition.transportFrameDigest !==
          request.parsed.normalizedTransportFrameDigest
      ) {
        const collision = openTransportCollision(
          transaction,
          request,
          position,
          firstTransportPosition,
        );
        updateResultAsPrecompletionCollision(
          transaction,
          request.stableSemanticResultId,
          request.observedAtMs,
        );
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId: collision.gapId,
          generation,
          frameIndex,
        });
        return readStandaloneClassificationState(
          transaction,
          request.stableSemanticResultId,
          "collision",
        );
      }
      if (
        existingResult.state === "quarantined_incomplete" ||
        existingResult.state === "quarantined_collision"
      ) {
        const gapId =
          existingResult.state === "quarantined_collision"
            ? openSemanticGap(
                transaction,
                request,
                position,
                attemptId,
                request.stableSemanticResultId,
              )
            : null;
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "late_after_tombstone",
          cursorDisposition:
            existingResult.state === "quarantined_incomplete" ? "advanceable" : "blocked",
          gapId,
          generation,
          frameIndex,
        });
        return readStandaloneClassificationState(
          transaction,
          request.stableSemanticResultId,
          existingResult.state === "quarantined_incomplete" ? "expired" : "collision",
        );
      }
      if (!sameResultBinding(existingResult, request)) {
        const gapId = openSemanticGap(
          transaction,
          request,
          position,
          attemptId,
          request.stableSemanticResultId,
        );
        if (existingAttemptValue === undefined) {
          insertSemanticCollisionAttempt(
            transaction,
            request,
            stableHeaderDigest,
            gapId,
            generation,
            frameIndex,
          );
        }
        updateResultAsPrecompletionCollision(
          transaction,
          request.stableSemanticResultId,
          request.observedAtMs,
        );
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId,
          generation,
          frameIndex,
        });
        return readStandaloneClassificationState(
          transaction,
          request.stableSemanticResultId,
          "collision",
        );
      }
    }

    if (resultValue === undefined) {
      if (request.observedAtMs > Number.MAX_SAFE_INTEGER - A1_INGRESS_ASSEMBLY_DEADLINE_MS) {
        throw new IngressRepositoryConflictError("assembly deadline counter is exhausted");
      }
      const unresolved = mappedRow(
        sqlGet(
          transaction,
          `SELECT count(*) AS count FROM authenticated_ingress_results
            WHERE broker_route_id=? AND state='assembling'`,
          [request.scope.brokerRouteId],
        ),
        "unresolvedResultCount",
      );
      if (Number(unresolved.count) >= A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE) {
        throw new IngressRepositoryQuotaError();
      }
      sqlRun(
        transaction,
        `INSERT INTO authenticated_ingress_results (
           stable_semantic_result_id, broker_route_id, collaboration_server_id, route_kind,
           logical_chat_id, source_event_namespace_id, message_id, record_kind, client_message_id,
           expected_parts, source_payload_schema_id, canonical_message_digest,
           source_event_fingerprint_schema_id, source_event_fingerprint,
           accepted_delivery_attempt_id, first_ingress_generation, first_ingress_frame_index,
           last_observed_ingress_generation, last_observed_ingress_frame_index,
           assembly_deadline_ms, state, collision_at_ms, terminal_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL,
                   ?, ?, ?, ?, ?, 'assembling', NULL, NULL)`,
        [
          request.stableSemanticResultId,
          request.scope.brokerRouteId,
          request.scope.collaborationServerId,
          request.scope.routeKind,
          request.scope.logicalChatId,
          request.sourceEventNamespaceId,
          header.msgId,
          header.recordKind,
          header.clientMsgId,
          header.parts,
          generation,
          frameIndex,
          generation,
          frameIndex,
          request.observedAtMs + A1_INGRESS_ASSEMBLY_DEADLINE_MS,
        ],
      );
    }

    if (existingAttemptValue === undefined) {
      if (
        firstTransportPosition !== null &&
        firstTransportPosition.transportFrameDigest !==
          request.parsed.normalizedTransportFrameDigest
      ) {
        const collision = openTransportCollision(
          transaction,
          request,
          position,
          firstTransportPosition,
        );
        updateResultAsPrecompletionCollision(
          transaction,
          request.stableSemanticResultId,
          request.observedAtMs,
        );
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId: collision.gapId,
          generation,
          frameIndex,
        });
        return readStandaloneClassificationState(
          transaction,
          request.stableSemanticResultId,
          "collision",
        );
      }
    }

    if (existingAttemptValue === undefined) {
      const candidates = mappedRow(
        sqlGet(
          transaction,
          `SELECT count(*) AS count FROM ingress_delivery_candidates
            WHERE stable_semantic_result_id=?`,
          [request.stableSemanticResultId],
        ),
        "candidateCount",
      );
      if (Number(candidates.count) >= A1_INGRESS_MAX_CANDIDATES_PER_RESULT) {
        const gapId = openSemanticGap(
          transaction,
          request,
          position,
          attemptId,
          request.stableSemanticResultId,
        );
        updateResultAsPrecompletionCollision(
          transaction,
          request.stableSemanticResultId,
          request.observedAtMs,
        );
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId,
          generation,
          frameIndex,
        });
        return readStandaloneClassificationState(
          transaction,
          request.stableSemanticResultId,
          "collision",
        );
      }
      insertExactAttempt(transaction, request, stableHeaderDigest);
      insertCandidate(transaction, request, generation, frameIndex);
    }

    const candidate = mappedRow(
      sqlGet(
        transaction,
        `SELECT * FROM ingress_delivery_candidates
          WHERE stable_semantic_result_id=? AND delivery_attempt_id=? LIMIT 1`,
        [request.stableSemanticResultId, attemptId],
      ),
      "deliveryCandidate",
    );
    if (candidate.state === "expired" || candidate.state === "collision") {
      const gapId =
        candidate.state === "expired"
          ? openInvalidPayloadGap(transaction, request, position)
          : openSemanticGap(
              transaction,
              request,
              position,
              attemptId,
              request.stableSemanticResultId,
            );
      if (candidate.state === "collision") {
        updateResultAsPrecompletionCollision(
          transaction,
          request.stableSemanticResultId,
          request.observedAtMs,
        );
      }
      insertIngressObservation(transaction, request, {
        stableSemanticResultId: request.stableSemanticResultId,
        deliveryAttemptId: attemptId,
        disposition: candidate.state === "expired" ? "invalid_payload" : "collision",
        cursorDisposition: candidate.state === "expired" ? "advanceable" : "blocked",
        gapId,
        generation,
        frameIndex,
      });
      return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
    }
    const partValue = sqlGet(
      transaction,
      `SELECT * FROM authenticated_ingress_parts
        WHERE stable_semantic_result_id=? AND delivery_attempt_id=? AND part=? LIMIT 1`,
      [request.stableSemanticResultId, attemptId, header.part],
    );
    if (partValue !== undefined) {
      const retainedPart = mappedRow(partValue, "retainedPart");
      const originalValue = sqlGet(
        transaction,
        `SELECT channel_generation, frame_index, normalized_transport_frame_digest
           FROM authenticated_channel_positions
          WHERE broker_route_id=? AND delivery_attempt_id=? AND part=?
            AND normalized_transport_frame_digest IS NOT NULL
          ORDER BY channel_generation, frame_index LIMIT 1`,
        [request.scope.brokerRouteId, attemptId, header.part],
      );
      if (originalValue === undefined) {
        throw new IngressRepositoryPersistenceError("retained part lacks its first position");
      }
      const original = mappedRow(originalValue, "originalPartPosition");
      const originalTransportDigest = parseA1Digest(original.normalizedTransportFrameDigest);
      if (
        originalTransportDigest !== request.parsed.normalizedTransportFrameDigest ||
        retainedPart.authenticatedPartDigest !== request.authenticatedPartDigest
      ) {
        if (originalTransportDigest === request.parsed.normalizedTransportFrameDigest) {
          const gapId = openSemanticGap(
            transaction,
            request,
            position,
            attemptId,
            request.stableSemanticResultId,
          );
          sqlRun(
            transaction,
            `UPDATE ingress_delivery_candidates SET state='collision'
              WHERE stable_semantic_result_id=? AND delivery_attempt_id=?
                AND state <> 'complete'`,
            [request.stableSemanticResultId, attemptId],
          );
          updateResultAsPrecompletionCollision(
            transaction,
            request.stableSemanticResultId,
            request.observedAtMs,
          );
          insertIngressObservation(transaction, request, {
            stableSemanticResultId: request.stableSemanticResultId,
            deliveryAttemptId: attemptId,
            disposition: "collision",
            cursorDisposition: "blocked",
            gapId,
            generation,
            frameIndex,
          });
          return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
        }
        const collision = openTransportCollision(transaction, request, position, {
          channelGeneration: Number(original.channelGeneration),
          frameIndex: Number(original.frameIndex),
          transportFrameDigest: originalTransportDigest,
        });
        sqlRun(
          transaction,
          `UPDATE ingress_delivery_candidates SET state='collision'
            WHERE stable_semantic_result_id=? AND delivery_attempt_id=?
              AND state <> 'complete'`,
          [request.stableSemanticResultId, attemptId],
        );
        updateResultAsPrecompletionCollision(
          transaction,
          request.stableSemanticResultId,
          request.observedAtMs,
        );
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "collision",
          cursorDisposition: "blocked",
          gapId: collision.gapId,
          generation,
          frameIndex,
        });
        return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
      }
      const terminal =
        candidate.state === "complete" ||
        mappedRow(
          sqlGet(
            transaction,
            `SELECT state FROM authenticated_ingress_results
              WHERE stable_semantic_result_id=? LIMIT 1`,
            [request.stableSemanticResultId],
          ),
          "retryResult",
        ).state === "awaiting_order";
      insertIngressObservation(transaction, request, {
        stableSemanticResultId: request.stableSemanticResultId,
        deliveryAttemptId: attemptId,
        disposition: "exact_transport_retry",
        cursorDisposition: terminal ? "advanceable" : "blocked",
        gapId: null,
        generation,
        frameIndex,
      });
      return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
    }

    const semanticBytes = mappedRow(
      sqlGet(
        transaction,
        `SELECT coalesce(sum(plaintext_byte_count), 0) AS bytes
           FROM ingress_delivery_candidates WHERE stable_semantic_result_id=?`,
        [request.stableSemanticResultId],
      ),
      "semanticCandidateBytes",
    );
    const conflictingCoordinate = sqlGet(
      transaction,
      `SELECT authenticated_part_digest FROM authenticated_ingress_parts
        WHERE stable_semantic_result_id=? AND delivery_attempt_id<>? AND part=? LIMIT 1`,
      [request.stableSemanticResultId, attemptId, header.part],
    );
    if (
      conflictingCoordinate !== undefined &&
      mappedRow(conflictingCoordinate, "semanticCoordinate").authenticatedPartDigest !==
        request.authenticatedPartDigest
    ) {
      const gapId = openSemanticGap(
        transaction,
        request,
        position,
        attemptId,
        request.stableSemanticResultId,
      );
      sqlRun(
        transaction,
        `UPDATE ingress_delivery_candidates SET state='collision'
          WHERE stable_semantic_result_id=? AND delivery_attempt_id=?`,
        [request.stableSemanticResultId, attemptId],
      );
      updateResultAsPrecompletionCollision(
        transaction,
        request.stableSemanticResultId,
        request.observedAtMs,
      );
      insertIngressObservation(transaction, request, {
        stableSemanticResultId: request.stableSemanticResultId,
        deliveryAttemptId: attemptId,
        disposition: "collision",
        cursorDisposition: "blocked",
        gapId,
        generation,
        frameIndex,
      });
      return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
    }
    if (
      Number(candidate.plaintextByteCount) >
        A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES - request.plaintextPartByteLength ||
      Number(semanticBytes.bytes) >
        A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES - request.plaintextPartByteLength
    ) {
      const gapId = openInvalidPayloadGap(transaction, request, position);
      sqlRun(
        transaction,
        `UPDATE ingress_delivery_candidates SET state='expired'
          WHERE stable_semantic_result_id=? AND delivery_attempt_id=?`,
        [request.stableSemanticResultId, attemptId],
      );
      const terminalized = sqlRun(
        transaction,
        `UPDATE authenticated_ingress_results
            SET state='quarantined_incomplete', terminal_at_ms=?
          WHERE stable_semantic_result_id=? AND state='assembling'`,
        [request.observedAtMs, request.stableSemanticResultId],
      );
      insertIngressObservation(transaction, request, {
        stableSemanticResultId: request.stableSemanticResultId,
        deliveryAttemptId: attemptId,
        disposition: "invalid_payload",
        cursorDisposition: "advanceable",
        gapId,
        generation,
        frameIndex,
      });
      if (Number(terminalized.changes) === 1) {
        advanceGaplessResultPositions(transaction, request.stableSemanticResultId);
      }
      return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
    }

    insertPart(transaction, request, generation, frameIndex);
    const completesCandidate =
      Number(candidate.receivedParts) + 1 === Number(candidate.expectedParts);
    if (!completesCandidate) {
      sqlRun(
        transaction,
        `UPDATE ingress_delivery_candidates
            SET received_parts=received_parts+1,
                plaintext_byte_count=plaintext_byte_count+?
          WHERE stable_semantic_result_id=? AND delivery_attempt_id=? AND state='assembling'`,
        [request.plaintextPartByteLength, request.stableSemanticResultId, attemptId],
      );
      insertIngressObservation(transaction, request, {
        stableSemanticResultId: request.stableSemanticResultId,
        deliveryAttemptId: attemptId,
        disposition: "new_part",
        cursorDisposition: "blocked",
        gapId: null,
        generation,
        frameIndex,
      });
      return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
    }

    const partBuffers = readPlaintextParts(transaction, request.stableSemanticResultId, attemptId);
    let complete: Uint8Array | null = null;
    let canonicalPayload: Uint8Array | null = null;
    try {
      complete = concatParts(partBuffers);
      let selected: ReturnType<typeof parseSelectedA1InboundPayload>;
      try {
        selected = parseSelectedA1InboundPayload(header, complete);
        canonicalPayload = selected.canonicalBytes;
      } catch {
        const gapId = openInvalidPayloadGap(transaction, request, position);
        sqlRun(
          transaction,
          `UPDATE ingress_delivery_candidates
              SET received_parts=received_parts+1,
                  plaintext_byte_count=plaintext_byte_count+?, state='expired'
            WHERE stable_semantic_result_id=? AND delivery_attempt_id=?`,
          [request.plaintextPartByteLength, request.stableSemanticResultId, attemptId],
        );
        const terminalized = sqlRun(
          transaction,
          `UPDATE authenticated_ingress_results
              SET state='quarantined_incomplete', terminal_at_ms=?
            WHERE stable_semantic_result_id=? AND state='assembling'`,
          [request.observedAtMs, request.stableSemanticResultId],
        );
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "invalid_payload",
          cursorDisposition: "advanceable",
          gapId,
          generation,
          frameIndex,
        });
        if (Number(terminalized.changes) === 1) {
          advanceGaplessResultPositions(transaction, request.stableSemanticResultId);
        }
        return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
      }
      const messageDigest = canonicalMessageDigest(header, complete);
      const fingerprint = digest(
        canonicalA1IngressSourceEventFingerprintPreimage(
          request.scope.brokerRouteId,
          request.sourceEventNamespaceId,
          header.msgId,
          messageDigest,
        ),
      );
      const durableResult = mappedRow(
        sqlGet(
          transaction,
          `SELECT * FROM authenticated_ingress_results
            WHERE stable_semantic_result_id=? LIMIT 1`,
          [request.stableSemanticResultId],
        ),
        "completionResult",
      );
      const acceptedAttemptId =
        durableResult.acceptedDeliveryAttemptId === null
          ? null
          : parseA1SafeId(durableResult.acceptedDeliveryAttemptId);
      if (acceptedAttemptId !== null) {
        const exactReplay =
          durableResult.sourcePayloadSchemaId === selected.sourcePayloadSchemaId &&
          durableResult.canonicalMessageDigest === messageDigest &&
          durableResult.sourceEventFingerprint === fingerprint &&
          equalStringVectors(
            partDigestVector(transaction, request.stableSemanticResultId, acceptedAttemptId),
            partDigestVector(transaction, request.stableSemanticResultId, attemptId),
          );
        if (!exactReplay) {
          const gapId = openSemanticGap(
            transaction,
            request,
            position,
            attemptId,
            request.stableSemanticResultId,
          );
          sqlRun(
            transaction,
            `UPDATE ingress_delivery_candidates
                SET received_parts=received_parts+1,
                    plaintext_byte_count=plaintext_byte_count+?, state='collision'
              WHERE stable_semantic_result_id=? AND delivery_attempt_id=?`,
            [request.plaintextPartByteLength, request.stableSemanticResultId, attemptId],
          );
          updateResultAsPrecompletionCollision(
            transaction,
            request.stableSemanticResultId,
            request.observedAtMs,
          );
          insertIngressObservation(transaction, request, {
            stableSemanticResultId: request.stableSemanticResultId,
            deliveryAttemptId: attemptId,
            disposition: "collision",
            cursorDisposition: "blocked",
            gapId,
            generation,
            frameIndex,
          });
          return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
        }
        sqlRun(
          transaction,
          `UPDATE ingress_delivery_candidates
              SET received_parts=received_parts+1,
                  plaintext_byte_count=plaintext_byte_count+?, state='complete'
            WHERE stable_semantic_result_id=? AND delivery_attempt_id=?`,
          [request.plaintextPartByteLength, request.stableSemanticResultId, attemptId],
        );
        insertIngressObservation(transaction, request, {
          stableSemanticResultId: request.stableSemanticResultId,
          deliveryAttemptId: attemptId,
          disposition: "completed_exact_replay",
          cursorDisposition: "advanceable",
          gapId: null,
          generation,
          frameIndex,
        });
        completeCandidatePositions(transaction, request.stableSemanticResultId, attemptId);
        return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
      }

      sqlRun(
        transaction,
        `UPDATE ingress_delivery_candidates
            SET received_parts=received_parts+1,
                plaintext_byte_count=plaintext_byte_count+?, state='complete'
          WHERE stable_semantic_result_id=? AND delivery_attempt_id=?`,
        [request.plaintextPartByteLength, request.stableSemanticResultId, attemptId],
      );
      sqlRun(
        transaction,
        `UPDATE authenticated_ingress_results
            SET state='awaiting_order', source_payload_schema_id=?,
                canonical_message_digest=?, source_event_fingerprint_schema_id=?,
                source_event_fingerprint=?, accepted_delivery_attempt_id=?
          WHERE stable_semantic_result_id=? AND state='assembling'
            AND canonical_message_digest IS NULL`,
        [
          selected.sourcePayloadSchemaId,
          messageDigest,
          A1_INGRESS_SOURCE_EVENT_FINGERPRINT_SCHEMA_ID,
          fingerprint,
          attemptId,
          request.stableSemanticResultId,
        ],
      );
      insertIngressObservation(transaction, request, {
        stableSemanticResultId: request.stableSemanticResultId,
        deliveryAttemptId: attemptId,
        disposition: "new_part",
        cursorDisposition: "advanceable",
        gapId: null,
        generation,
        frameIndex,
      });
      completeCandidatePositions(transaction, request.stableSemanticResultId, attemptId);
      return readClassificationState(transaction, request.stableSemanticResultId, attemptId);
    } finally {
      canonicalPayload?.fill(0);
      complete?.fill(0);
      for (const part of partBuffers) part.fill(0);
    }
  } finally {
    plaintext.fill(0);
  }
}

function expireResultTransaction(
  transaction: HostStateRepositorySqlTransaction,
  request: ExpireIngressResultRequest,
  nowMs: number,
): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new IngressRepositoryConflictError("expiry wall clock is invalid");
  }
  if (request.observedAtMs < request.expectedAssemblyDeadlineMs) {
    throw new IngressRepositoryConflictError("assembly deadline has not elapsed");
  }
  const changed = sqlRun(
    transaction,
    `UPDATE authenticated_ingress_results SET state='quarantined_incomplete',
            terminal_at_ms=? WHERE stable_semantic_result_id=? AND broker_route_id=?
            AND state='assembling' AND assembly_deadline_ms=?`,
    [
      request.observedAtMs,
      request.stableSemanticResultId,
      request.scope.brokerRouteId,
      request.expectedAssemblyDeadlineMs,
    ],
  );
  if (Number(changed.changes) !== 1) {
    throw new IngressRepositoryConflictError("assembling result expiry compare-and-swap failed");
  }
  sqlRun(
    transaction,
    `UPDATE ingress_delivery_candidates SET state='expired'
      WHERE stable_semantic_result_id=? AND state='assembling'`,
    [request.stableSemanticResultId],
  );
  advanceGaplessResultPositions(transaction, request.stableSemanticResultId);
}

function recoverGapTransaction(
  transaction: HostStateRepositorySqlTransaction,
  request: RecoverIngressGapRequest,
): void {
  verifyArtifactAndScrub(
    transaction,
    request.evidenceRef,
    request.scope.collaborationServerId,
    A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
    request.evidenceDigest,
  );
  assertIngressAuditEvidenceQuota(transaction, request.scope, request.evidenceRef);
  const value = sqlGet(
    transaction,
    `SELECT reason, channel_position_observation_id, stable_semantic_result_id, state
       FROM broker_route_gaps
      WHERE gap_id=? AND broker_route_id=? LIMIT 1`,
    [request.gapId, request.scope.brokerRouteId],
  );
  if (value === undefined || mappedRow(value, "gap").state !== "open") {
    throw new IngressRepositoryConflictError("gap is not open");
  }
  const gap = mappedRow(value, "gap");
  if (request.decision === "discard_and_close_source") {
    const count = mappedRow(
      sqlGet(
        transaction,
        `SELECT COUNT(*) AS open_gap_count FROM broker_route_gaps
          WHERE broker_route_id=? AND state='open'`,
        [request.scope.brokerRouteId],
      ),
      "openGapCount",
    );
    if (Number(count.openGapCount) !== 1) {
      throw new IngressRepositoryConflictError(
        "discard-and-close requires the target to be the route's sole open gap",
      );
    }
  }
  sqlRun(
    transaction,
    `INSERT INTO channel_position_recoveries (
     recovery_id, gap_id, broker_route_id, collaboration_server_id, route_kind,
     logical_chat_id, reason, decision, evidence_ref, evidence_digest,
     coordinator_lease_id, coordinator_epoch, decided_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.recoveryId,
      request.gapId,
      request.scope.brokerRouteId,
      request.scope.collaborationServerId,
      request.scope.routeKind,
      request.scope.logicalChatId,
      String(gap.reason),
      request.decision,
      request.evidenceRef,
      request.evidenceDigest,
      request.fence.coordinatorLeaseId,
      request.fence.coordinatorEpoch,
      request.observedAtMs,
    ],
  );
  sqlRun(
    transaction,
    `UPDATE broker_route_gaps SET state='resolved', resolved_at_ms=?, recovery_id=?
      WHERE gap_id=? AND state='open'`,
    [request.observedAtMs, request.recoveryId, request.gapId],
  );
  const collisionResultId =
    gap.reason === "semantic_collision" && typeof gap.stableSemanticResultId === "string"
      ? parseA1SafeId(gap.stableSemanticResultId)
      : gap.reason === "transport_collision"
        ? parseA1SafeId(
            mappedRow(
              sqlGet(
                transaction,
                `SELECT stable_semantic_result_id FROM authenticated_ingress_observations
                  WHERE gap_id=? LIMIT 1`,
                [request.gapId],
              ),
              "recoveredTransportCollisionObservation",
            ).stableSemanticResultId,
          )
        : null;
  const precompletionCollision =
    collisionResultId !== null &&
    mappedRow(
      sqlGet(
        transaction,
        `SELECT accepted_delivery_attempt_id FROM authenticated_ingress_results
          WHERE stable_semantic_result_id=? LIMIT 1`,
        [collisionResultId],
      ),
      "recoveredCollisionResult",
    ).acceptedDeliveryAttemptId === null;
  if (precompletionCollision) {
    advanceGaplessResultPositions(transaction, collisionResultId);
    sqlRun(
      transaction,
      `UPDATE authenticated_ingress_observations
          SET cursor_disposition='advanceable', recovery_id=?
        WHERE gap_id=? AND cursor_disposition='blocked'`,
      [request.recoveryId, request.gapId],
    );
    sqlRun(
      transaction,
      `UPDATE authenticated_channel_positions
          SET cursor_disposition='advanceable', recovery_id=?
        WHERE gap_id=? AND cursor_disposition='blocked'`,
      [request.recoveryId, request.gapId],
    );
  } else {
    sqlRun(
      transaction,
      `UPDATE authenticated_ingress_observations
          SET cursor_disposition='advanceable', recovery_id=?
        WHERE gap_id=? AND cursor_disposition='blocked'`,
      [request.recoveryId, request.gapId],
    );
    sqlRun(
      transaction,
      `UPDATE authenticated_channel_positions
          SET cursor_disposition='advanceable', recovery_id=?
        WHERE gap_id=? AND cursor_disposition='blocked'`,
      [request.recoveryId, request.gapId],
    );
  }
  if (
    gap.reason !== "position_equivocation" &&
    typeof gap.channelPositionObservationId === "string"
  ) {
    sqlRun(
      transaction,
      `UPDATE authenticated_channel_positions SET cursor_disposition='advanceable', recovery_id=?
        WHERE channel_position_observation_id=? AND recovery_id IS NULL
          AND cursor_disposition='blocked'`,
      [request.recoveryId, gap.channelPositionObservationId],
    );
  }
  if (request.decision === "discard_and_close_source") {
    const closed = sqlRun(
      transaction,
      `UPDATE broker_route_runtime_status
          SET state='closed', updated_at_ms=max(updated_at_ms, ?)
        WHERE broker_route_id=? AND state='current' AND active_gap_count=0`,
      [request.observedAtMs, request.scope.brokerRouteId],
    );
    if (Number(closed.changes) !== 1) {
      throw new IngressRepositoryConflictError(
        "discard-and-close did not reach an exact gap-free route state",
      );
    }
  }
}

function recomputeSemanticCursorTransaction(
  transaction: HostStateRepositorySqlTransaction,
  scope: BrokerRouteActorScope,
  observedAtMs: number,
): void {
  for (let steps = 0; steps < A1_INGRESS_LOOKAHEAD_MAX_FRAMES; steps++) {
    const cursor = oneMapped(transaction, "broker_route_semantic_cursors", scope.brokerRouteId);
    if (cursor === null) throw new IngressRepositoryConflictError("semantic cursor is absent");
    const generation = Number(cursor.nextGeneration);
    const frameIndex = Number(cursor.nextFrameIndex);
    const generationValue = sqlGet(
      transaction,
      `SELECT state, observed_next_frame_index, frame_count, next_generation
         FROM broker_channel_generation_observations
        WHERE broker_route_id=? AND channel_generation=? LIMIT 1`,
      [scope.brokerRouteId, generation],
    );
    if (generationValue === undefined) return;
    const manifest = mappedRow(generationValue, "semanticGeneration");
    if (frameIndex >= Number(manifest.observedNextFrameIndex)) {
      if (manifest.state !== "sealed" || frameIndex !== Number(manifest.frameCount)) return;
      sqlRun(
        transaction,
        `UPDATE broker_route_semantic_cursors
            SET next_generation=?, next_frame_index=0, revision=revision+1, updated_at_ms=?
          WHERE broker_route_id=? AND next_generation=? AND next_frame_index=?`,
        [
          Number(manifest.nextGeneration),
          observedAtMs,
          scope.brokerRouteId,
          generation,
          frameIndex,
        ],
      );
      continue;
    }
    const positionValue = sqlGet(
      transaction,
      `SELECT cursor_disposition FROM authenticated_channel_positions
        WHERE broker_route_id=? AND channel_generation=? AND frame_index=? LIMIT 1`,
      [scope.brokerRouteId, generation, frameIndex],
    );
    if (
      positionValue === undefined ||
      mappedRow(positionValue, "semanticPosition").cursorDisposition !== "advanceable"
    ) {
      return;
    }
    sqlRun(
      transaction,
      `UPDATE broker_route_semantic_cursors
          SET next_frame_index=next_frame_index+1,
              contiguous_through_generation=?, contiguous_through_frame_index=?,
              revision=revision+1, updated_at_ms=?
        WHERE broker_route_id=? AND next_generation=? AND next_frame_index=?`,
      [generation, frameIndex, observedAtMs, scope.brokerRouteId, generation, frameIndex],
    );
  }
}

class BoundIngressRepository implements IngressRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #nowMs: () => number;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    nowMs: () => number = Date.now,
  ) {
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#nowMs = nowMs;
    Object.freeze(this);
  }

  readRouteState(brokerRouteId: BrokerRouteId): IngressRouteState | null {
    const routeId = parseBrokerRouteId(brokerRouteId);
    return this.#executor.transaction((transaction) =>
      readRouteStateTransaction(transaction, routeId),
    );
  }
  readRouteHead(brokerRouteId: BrokerRouteId): IngressRouteHead | null {
    const routeId = parseBrokerRouteId(brokerRouteId);
    return this.#executor.transaction((transaction) =>
      readRouteHeadTransaction(transaction, routeId),
    );
  }
  readNextDueAssemblingResult(
    brokerRouteId: BrokerRouteId,
    dueAtOrBeforeMs: number,
  ): DueAssemblingIngressResult | null {
    const routeId = parseBrokerRouteId(brokerRouteId);
    if (!Number.isSafeInteger(dueAtOrBeforeMs) || dueAtOrBeforeMs < 0) {
      throw new HostStateContractError(
        "readNextDueAssemblingResult.dueAtOrBeforeMs must be a non-negative safe integer",
      );
    }
    return this.#executor.transaction((transaction) =>
      readNextDueAssemblingResultTransaction(transaction, routeId, dueAtOrBeforeMs),
    );
  }
  readPositionClassification(
    brokerRouteId: BrokerRouteId,
    ingressObservationId: A1SafeId,
  ): IngressPositionClassification | null {
    const routeId = parseBrokerRouteId(brokerRouteId);
    const observationId = parseA1SafeId(
      ingressObservationId,
      "readPositionClassification.ingressObservationId",
    );
    return this.#executor.transaction((transaction) =>
      readPositionClassificationTransaction(transaction, routeId, observationId),
    );
  }
  readPendingPositions(
    brokerRouteId: BrokerRouteId,
    limit = A1_BROKER_MAX_READ_FRAMES,
  ): readonly PendingIngressPosition[] {
    const routeId = parseBrokerRouteId(brokerRouteId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > A1_BROKER_MAX_READ_FRAMES) {
      throw new HostStateContractError(
        `readPendingPositions.limit must be from 1 through ${A1_BROKER_MAX_READ_FRAMES}`,
      );
    }
    return this.#executor.transaction((transaction) =>
      Object.freeze(
        sqlAll(
          transaction,
          `SELECT channel_position_observation_id, channel_generation, frame_index,
                  received_frame_ref, received_frame_digest, received_frame_byte_length,
                  claimed_delivery_attempt_id, claimed_part, claimed_transport_frame_digest
             FROM authenticated_channel_positions
            WHERE broker_route_id = ? AND classification = 'pending_validation'
            ORDER BY channel_generation, frame_index LIMIT ?`,
          [routeId, limit],
        ).map((value): PendingIngressPosition => {
          const row = mappedRow(value, "pendingPosition");
          return Object.freeze({
            channelPositionObservationId: parseA1SafeId(row.channelPositionObservationId),
            cursor: Object.freeze({
              version: 1 as const,
              channelGeneration: Number(row.channelGeneration),
              frameIndex: Number(row.frameIndex),
            }),
            receivedFrameRef: row.receivedFrameRef as ProtectedHandleId,
            receivedFrameDigest: parseA1Digest(row.receivedFrameDigest),
            receivedFrameByteLength: Number(row.receivedFrameByteLength),
            claimedDeliveryAttemptId: parseA1SafeId(row.claimedDeliveryAttemptId),
            claimedPart: Number(row.claimedPart),
            claimedTransportFrameDigest: parseA1Digest(row.claimedTransportFrameDigest),
          });
        }),
      ),
    );
  }
  claimRouteActor(request: ClaimIngressRouteActorRequest): IngressMutationResult {
    const computed = operationDigest("claim", {
      scope: request.scope,
      fence: request.fence,
      claimToken: request.claimToken,
      expectedActorRevision: request.expectedActorRevision,
      observedAtMs: request.observedAtMs,
    });
    return this.#executor.transaction((transaction) => {
      assertAuthority(transaction, this.#machineIdentityId, request, this.#nowMs);
      const actor = readStoredActor(transaction, request.scope.brokerRouteId);
      if (checkReplay(actor, request.operationId, "claim", computed)) {
        return mutationResult(actor, true);
      }
      if (actor.revision !== request.expectedActorRevision) {
        throw new IngressRepositoryStaleCoordinatorError();
      }
      if (actor.revision >= Number.MAX_SAFE_INTEGER - 1) {
        throw new IngressRepositoryConflictError("broker route actor revision is exhausted");
      }
      const result = sqlRun(
        transaction,
        `UPDATE broker_route_actors SET revision = revision + 1, claim_token = ?,
                coordinator_lease_id = ?, coordinator_epoch = ?, claimed_at_ms = ?,
                last_operation_id = ?, last_operation_kind = 'claim',
                last_operation_digest = ?, updated_at_ms = ?
          WHERE broker_route_id = ? AND revision = ?`,
        [
          request.claimToken,
          request.fence.coordinatorLeaseId,
          request.fence.coordinatorEpoch,
          request.observedAtMs,
          request.operationId,
          computed,
          request.observedAtMs,
          request.scope.brokerRouteId,
          request.expectedActorRevision,
        ],
      );
      if (Number(result.changes) !== 1) throw new IngressRepositoryStaleCoordinatorError();
      return mutationResult(readStoredActor(transaction, request.scope.brokerRouteId), false);
    });
  }
  reconcileRouteActorClaim(request: ClaimIngressRouteActorRequest): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "claim",
      operationDigest("claim", {
        scope: request.scope,
        fence: request.fence,
        claimToken: request.claimToken,
        expectedActorRevision: request.expectedActorRevision,
        observedAtMs: request.observedAtMs,
      }),
    );
  }
  releaseRouteActor(request: IngressMutationCoordinate): IngressMutationResult {
    const computed = mutationRequestDigest("release", request);
    return this.#mutate(request, "release", computed, (transaction, actor) =>
      mutationResult(
        bumpActor(
          transaction,
          actor,
          "release",
          request.operationId,
          computed,
          request.observedAtMs,
          true,
        ),
        false,
      ),
    );
  }
  reconcileRouteActorRelease(request: IngressMutationCoordinate): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "release",
      mutationRequestDigest("release", request),
    );
  }
  latchOuterPageGap(request: LatchOuterPageGapRequest): IngressMutationResult {
    const computed = operationDigest("outer_page_gap", {
      ...mutationDigestFields(request),
      failureCode: request.failureCode,
      evidenceDigest: request.evidenceDigest,
    });
    return this.#mutate(request, "outer_page_gap", computed, (transaction, actor) => {
      verifyCanonicalGapEvidence(
        transaction,
        request.evidenceRef,
        request.scope,
        request.evidenceDigest,
        request.failureCode,
        null,
        "present",
      );
      assertIngressAuditEvidenceQuota(transaction, request.scope, request.evidenceRef);
      insertGap(
        transaction,
        request.scope,
        "outer_page_invalid",
        request.operationId,
        request.evidenceRef,
        request.evidenceDigest,
        request.observedAtMs,
      );
      return mutationResult(
        bumpActor(
          transaction,
          actor,
          "outer_page_gap",
          request.operationId,
          computed,
          request.observedAtMs,
        ),
        false,
      );
    });
  }
  reconcileOuterPageGap(request: LatchOuterPageGapRequest): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "outer_page_gap",
      operationDigest("outer_page_gap", {
        ...mutationDigestFields(request),
        failureCode: request.failureCode,
        evidenceDigest: request.evidenceDigest,
      }),
    );
  }
  latchStorageQuotaGap(request: LatchIngressStorageQuotaGapRequest): IngressMutationResult {
    const computed = operationDigest("storage_quota_gap", {
      ...mutationDigestFields(request),
      evidenceDigest: request.evidenceDigest,
    });
    return this.#mutate(request, "storage_quota_gap", computed, (transaction, actor) => {
      verifyCanonicalGapEvidence(
        transaction,
        request.evidenceRef,
        request.scope,
        request.evidenceDigest,
        parseA1SafeId("storage_quota"),
        null,
        "null",
      );
      assertIngressAuditEvidenceQuota(transaction, request.scope, request.evidenceRef);
      insertGap(
        transaction,
        request.scope,
        "storage_quota",
        request.operationId,
        request.evidenceRef,
        request.evidenceDigest,
        request.observedAtMs,
      );
      return mutationResult(
        bumpActor(
          transaction,
          actor,
          "storage_quota_gap",
          request.operationId,
          computed,
          request.observedAtMs,
        ),
        false,
      );
    });
  }
  reconcileStorageQuotaGap(
    request: LatchIngressStorageQuotaGapRequest,
  ): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "storage_quota_gap",
      operationDigest("storage_quota_gap", {
        ...mutationDigestFields(request),
        evidenceDigest: request.evidenceDigest,
      }),
    );
  }
  stageReadPage(request: StageIngressReadPageRequest): IngressMutationResult {
    const computed = stageOperationDigest(request);
    return this.#mutate(request, "stage_page", computed, (transaction, actor) => {
      stagePageTransaction(transaction, request, this.#machineIdentityId);
      return mutationResult(
        bumpActor(
          transaction,
          actor,
          "stage_page",
          request.operationId,
          computed,
          request.observedAtMs,
        ),
        false,
      );
    });
  }
  reconcileStageReadPage(request: StageIngressReadPageRequest): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "stage_page",
      stageOperationDigest(request),
    );
  }
  classifyInvalidPosition(request: ClassifyInvalidIngressPositionRequest): IngressMutationResult {
    return this.#classifyTerminal(request, "invalid");
  }
  classifyUnknownOutboundPosition(
    request: ClassifyUnknownOutboundPositionRequest,
  ): IngressMutationResult {
    return this.#classifyTerminal(request, "unknown_outbound");
  }
  classifyInboundPart(request: ClassifyInboundPartRequest): IngressPartClassificationResult {
    const computed = classificationDigest("inbound", request);
    return this.#executor.transaction((transaction) => {
      assertAuthority(transaction, this.#machineIdentityId, request, this.#nowMs);
      const actor = readStoredActor(transaction, request.scope.brokerRouteId);
      if (checkReplay(actor, request.operationId, "classify_inbound", computed)) {
        const result = mappedRow(
          sqlGet(
            transaction,
            `SELECT state, source_payload_schema_id, canonical_message_digest,
                    source_event_fingerprint
               FROM authenticated_ingress_results
              WHERE stable_semantic_result_id=? LIMIT 1`,
            [request.stableSemanticResultId],
          ),
          "replayedClassificationResult",
        );
        const candidateValue = sqlGet(
          transaction,
          `SELECT state FROM ingress_delivery_candidates
            WHERE stable_semantic_result_id=? AND delivery_attempt_id=? LIMIT 1`,
          [request.stableSemanticResultId, request.parsed.header.deliveryAttemptId],
        );
        const observation = mappedRow(
          sqlGet(
            transaction,
            `SELECT disposition FROM authenticated_ingress_observations
              WHERE ingress_observation_id=? LIMIT 1`,
            [request.ingressObservationId],
          ),
          "replayedClassificationObservation",
        );
        const candidateState =
          candidateValue === undefined
            ? observation.disposition === "late_after_tombstone" &&
              result.state === "quarantined_incomplete"
              ? "expired"
              : "collision"
            : mappedRow(candidateValue, "replayedClassificationCandidate").state;
        return Object.freeze({
          candidateState: candidateState as IngressPartClassificationResult["candidateState"],
          resultState: result.state as IngressPartClassificationResult["resultState"],
          stableSemanticResultId: request.stableSemanticResultId,
          sourcePayloadSchemaId:
            result.sourcePayloadSchemaId === null ? null : String(result.sourcePayloadSchemaId),
          canonicalMessageDigest:
            result.canonicalMessageDigest === null
              ? null
              : parseA1Digest(result.canonicalMessageDigest),
          sourceEventFingerprint:
            result.sourceEventFingerprint === null
              ? null
              : parseA1Digest(result.sourceEventFingerprint),
          actor: asPublicActor(actor),
          replayed: true,
        });
      }
      assertClaimedMutation(actor, request);
      const result = classifyInboundPartTransaction(
        transaction,
        request,
        this.#machineIdentityId,
        this.#nowMs(),
      );
      const updated = bumpActor(
        transaction,
        actor,
        "classify_inbound",
        request.operationId,
        computed,
        request.observedAtMs,
      );
      return Object.freeze({ ...result, actor: asPublicActor(updated), replayed: false });
    });
  }
  reconcilePositionClassification(
    request:
      | ClassifyInvalidIngressPositionRequest
      | ClassifyUnknownOutboundPositionRequest
      | ClassifyInboundPartRequest,
  ): IngressMutationResult | null {
    const [kind, computed] =
      "plaintextPartRef" in request
        ? ["classify_inbound", classificationDigest("inbound", request)]
        : "validationFailureCode" in request
          ? ["classify_invalid", classificationDigest("invalid", request)]
          : ["classify_unknown", classificationDigest("unknown_outbound", request)];
    return this.#reconcile(request.scope, request.operationId, kind, computed);
  }
  expireResult(request: ExpireIngressResultRequest): IngressMutationResult {
    const computed = operationDigest("expire_result", {
      ...mutationDigestFields(request),
      resultId: request.stableSemanticResultId,
      deadline: request.expectedAssemblyDeadlineMs,
    });
    return this.#mutate(request, "expire_result", computed, (transaction, actor) => {
      expireResultTransaction(transaction, request, this.#nowMs());
      return mutationResult(
        bumpActor(
          transaction,
          actor,
          "expire_result",
          request.operationId,
          computed,
          request.observedAtMs,
        ),
        false,
      );
    });
  }
  reconcileResultExpiry(request: ExpireIngressResultRequest): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "expire_result",
      operationDigest("expire_result", {
        ...mutationDigestFields(request),
        resultId: request.stableSemanticResultId,
        deadline: request.expectedAssemblyDeadlineMs,
      }),
    );
  }
  recoverGap(request: RecoverIngressGapRequest): IngressMutationResult {
    const computed = operationDigest("recover_gap", {
      ...mutationDigestFields(request),
      gapId: request.gapId,
      recoveryId: request.recoveryId,
      decision: request.decision,
      evidenceDigest: request.evidenceDigest,
    });
    return this.#mutate(request, "recover_gap", computed, (transaction, actor) => {
      recoverGapTransaction(transaction, request);
      return mutationResult(
        bumpActor(
          transaction,
          actor,
          "recover_gap",
          request.operationId,
          computed,
          request.observedAtMs,
        ),
        false,
      );
    });
  }
  reconcileGapRecovery(request: RecoverIngressGapRequest): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "recover_gap",
      operationDigest("recover_gap", {
        ...mutationDigestFields(request),
        gapId: request.gapId,
        recoveryId: request.recoveryId,
        decision: request.decision,
        evidenceDigest: request.evidenceDigest,
      }),
    );
  }
  recomputeSemanticCursor(request: RecomputeIngressSemanticCursorRequest): IngressMutationResult {
    const computed = mutationRequestDigest("recompute_cursor", request);
    return this.#mutate(request, "recompute_cursor", computed, (transaction, actor) => {
      recomputeSemanticCursorTransaction(transaction, request.scope, request.observedAtMs);
      return mutationResult(
        bumpActor(
          transaction,
          actor,
          "recompute_cursor",
          request.operationId,
          computed,
          request.observedAtMs,
        ),
        false,
      );
    });
  }
  reconcileSemanticCursorRecompute(
    request: RecomputeIngressSemanticCursorRequest,
  ): IngressMutationResult | null {
    return this.#reconcile(
      request.scope,
      request.operationId,
      "recompute_cursor",
      mutationRequestDigest("recompute_cursor", request),
    );
  }

  #mutate<T>(
    request: IngressMutationCoordinate,
    kind: string,
    computed: A1Digest,
    operation: (
      transaction: HostStateRepositorySqlTransaction,
      actor: StoredBrokerRouteActorRecord,
    ) => T,
  ): T {
    return this.#executor.transaction((transaction) => {
      assertAuthority(transaction, this.#machineIdentityId, request, this.#nowMs);
      const actor = readStoredActor(transaction, request.scope.brokerRouteId);
      if (checkReplay(actor, request.operationId, kind, computed)) {
        return mutationResult(actor, true) as T;
      }
      assertClaimedMutation(actor, request);
      return operation(transaction, actor);
    });
  }

  #reconcile(
    scope: BrokerRouteActorScope,
    operationId: A1SafeId,
    kind: string,
    computed: A1Digest,
  ): IngressMutationResult | null {
    return this.#executor.transaction((transaction) => {
      const actor = readStoredActor(transaction, scope.brokerRouteId);
      return checkReplay(actor, operationId, kind, computed) ? mutationResult(actor, true) : null;
    });
  }

  #classifyTerminal(
    request: ClassifyInvalidIngressPositionRequest | ClassifyUnknownOutboundPositionRequest,
    classification: "invalid" | "unknown_outbound",
  ): IngressMutationResult {
    const kind = classification === "invalid" ? "classify_invalid" : "classify_unknown";
    const computed = classificationDigest(classification, request);
    return this.#mutate(request, kind, computed, (transaction, actor) => {
      classifyTerminalPositionTransaction(
        transaction,
        request,
        classification,
        this.#machineIdentityId,
      );
      return mutationResult(
        bumpActor(transaction, actor, kind, request.operationId, computed, request.observedAtMs),
        false,
      );
    });
  }
}

export function createIngressRepositoryOperations(
  executor: HostStateRepositoryTransactionExecutor,
  machineIdentityId: string,
): IngressRepositoryOperations {
  return new BoundIngressRepository(executor, machineIdentityId);
}

export function createIngressRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
): IngressRepositoryOperations {
  return new BoundIngressRepository(
    { transaction: (operation) => operation(transaction) },
    machineIdentityId,
  );
}

export function validateIngressRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  schemaVersion: number,
): void {
  if (schemaVersion < 8) return;
  try {
    const identity = parseMachineIdentityId(machineIdentityId);
    const routeScopes = new Map<
      string,
      Readonly<{
        scope: BrokerRouteActorScope;
        routeStoreInstanceId: string;
        genesisGeneration: number;
        createdAtMs: number;
      }>
    >();
    for (const value of sqlAll(
      transaction,
      `SELECT broker_route_id, broker_route_store_instance_id, genesis_generation,
              machine_identity_id, created_at_ms,
              collaboration_server_id, route_kind, logical_chat_id
         FROM broker_routes ORDER BY broker_route_id`,
    )) {
      const row = mappedRow(value, "brokerRoute");
      if (row.machineIdentityId !== identity) {
        throw new IngressRepositoryPersistenceError("broker route belongs to another identity");
      }
      const scope = {
        brokerRouteId: parseBrokerRouteId(row.brokerRouteId),
        collaborationServerId: row.collaborationServerId as CollaborationServerId,
        routeKind: row.routeKind,
        logicalChatId: row.logicalChatId,
      } as BrokerRouteActorScope;
      if (routeScopes.has(scope.brokerRouteId)) {
        throw new IngressRepositoryPersistenceError("broker route identity is duplicated");
      }
      routeScopes.set(
        scope.brokerRouteId,
        Object.freeze({
          scope,
          routeStoreInstanceId: String(row.brokerRouteStoreInstanceId),
          genesisGeneration: Number(row.genesisGeneration),
          createdAtMs: Number(row.createdAtMs),
        }),
      );
    }

    const snapshot: IngressRepositorySnapshot = Object.freeze({
      runtimeStatuses: allMapped(transaction, "broker_route_runtime_status").map(
        parseBrokerRouteRuntimeStatusRecord,
      ),
      generationObservations: allMapped(
        transaction,
        "broker_channel_generation_observations",
        undefined,
        "broker_route_id, channel_generation",
      ).map(parseBrokerChannelGenerationObservationRecord),
      fetchCursors: allMapped(transaction, "broker_route_fetch_cursors").map(
        parseBrokerRouteFetchCursorRecord,
      ),
      semanticCursors: allMapped(transaction, "broker_route_semantic_cursors").map(
        parseBrokerRouteSemanticCursorRecord,
      ),
      actors: allMapped(transaction, "broker_route_actors").map(parseBrokerRouteActorRecord),
      gaps: allMapped(transaction, "broker_route_gaps").map(parseBrokerRouteGapRecord),
      positions: allMapped(
        transaction,
        "authenticated_channel_positions",
        undefined,
        "broker_route_id, channel_generation, frame_index",
      ).map(parseAuthenticatedChannelPositionRecord),
      positionEquivocations: allMapped(transaction, "channel_position_equivocations").map(
        parseChannelPositionEquivocationRecord,
      ),
      manifestEquivocations: allMapped(transaction, "broker_channel_manifest_equivocations").map(
        parseBrokerChannelManifestEquivocationRecord,
      ),
      transportCollisions: allMapped(transaction, "broker_transport_key_collisions").map(
        parseBrokerTransportKeyCollisionRecord,
      ),
      recoveries: allMapped(transaction, "channel_position_recoveries").map(
        parseChannelPositionRecoveryRecord,
      ),
      results: allMapped(transaction, "authenticated_ingress_results").map(
        parseAuthenticatedIngressResultRecord,
      ),
      attempts: allMapped(transaction, "ingress_transport_attempts").map(
        parseIngressTransportAttemptRecord,
      ),
      candidates: allMapped(transaction, "ingress_delivery_candidates").map(
        parseIngressDeliveryCandidateRecord,
      ),
      parts: allMapped(
        transaction,
        "authenticated_ingress_parts",
        undefined,
        "stable_semantic_result_id, delivery_attempt_id, part",
      ).map(parseAuthenticatedIngressPartRecord),
      observations: allMapped(transaction, "authenticated_ingress_observations").map(
        parseAuthenticatedIngressObservationRecord,
      ),
      readPageObservations: allMapped(
        transaction,
        "broker_read_page_observations",
        undefined,
        "broker_route_id, observed_at_ms, requested_generation, requested_frame_index, read_page_observation_id",
      ).map(parseBrokerReadPageObservationRecord),
      readPageFrameEvidence: allMapped(
        transaction,
        "broker_read_page_frame_evidence",
        undefined,
        "read_page_observation_id, ordinal",
      ).map(parseBrokerReadPageFrameEvidenceRecord),
    });

    const exactScope = (record: {
      readonly brokerRouteId: BrokerRouteId;
      readonly collaborationServerId: CollaborationServerId;
      readonly routeKind: string;
      readonly logicalChatId: LogicalChatId | null;
    }): void => {
      const route = routeScopes.get(record.brokerRouteId)?.scope;
      if (
        route === undefined ||
        route.collaborationServerId !== record.collaborationServerId ||
        route.routeKind !== record.routeKind ||
        route.logicalChatId !== record.logicalChatId
      ) {
        throw new IngressRepositoryPersistenceError("ingress record route scope is inconsistent");
      }
    };
    for (const records of [
      snapshot.runtimeStatuses,
      snapshot.generationObservations,
      snapshot.actors,
      snapshot.gaps,
      snapshot.positions,
      snapshot.positionEquivocations,
      snapshot.manifestEquivocations,
      snapshot.transportCollisions,
      snapshot.recoveries,
      snapshot.results,
      snapshot.attempts,
      snapshot.candidates,
      snapshot.parts,
      snapshot.observations,
      snapshot.readPageObservations,
      snapshot.readPageFrameEvidence,
    ]) {
      for (const record of records) exactScope(record);
    }
    if (
      snapshot.runtimeStatuses.length !== routeScopes.size ||
      snapshot.fetchCursors.length !== routeScopes.size ||
      snapshot.semanticCursors.length !== routeScopes.size ||
      snapshot.actors.length !== routeScopes.size
    ) {
      throw new IngressRepositoryPersistenceError(
        "every broker route requires one exact ingress seed row",
      );
    }

    const putUnique = <T>(map: Map<string, T>, key: string, value: T, field: string): void => {
      if (map.has(key)) throw new IngressRepositoryPersistenceError(`${field} is duplicated`);
      map.set(key, value);
    };
    const pairKey = (left: string, right: string): string => `${left}\u0000${right}`;
    const partKey = (resultId: string, attemptId: string, part: number): string =>
      `${resultId}\u0000${attemptId}\u0000${part}`;
    const cursorKey = (routeId: string, generation: number, frameIndex: number): string =>
      `${routeId}\u0000${generation}\u0000${frameIndex}`;
    const cursorBounds = (
      records: readonly Readonly<{ channelGeneration: number; frameIndex: number }>[],
    ): Readonly<{
      firstGeneration: number;
      firstIndex: number;
      lastGeneration: number;
      lastIndex: number;
    }> => {
      if (records.length === 0) {
        throw new IngressRepositoryPersistenceError("cursor-bound evidence is absent");
      }
      let firstGeneration = Number.MAX_SAFE_INTEGER;
      let firstIndex = Number.MAX_SAFE_INTEGER;
      let lastGeneration = -1;
      let lastIndex = -1;
      for (const record of records) {
        if (
          record.channelGeneration < firstGeneration ||
          (record.channelGeneration === firstGeneration && record.frameIndex < firstIndex)
        ) {
          firstGeneration = record.channelGeneration;
          firstIndex = record.frameIndex;
        }
        if (
          record.channelGeneration > lastGeneration ||
          (record.channelGeneration === lastGeneration && record.frameIndex > lastIndex)
        ) {
          lastGeneration = record.channelGeneration;
          lastIndex = record.frameIndex;
        }
      }
      return { firstGeneration, firstIndex, lastGeneration, lastIndex };
    };
    const runtimeByRoute = new Map<string, BrokerRouteRuntimeStatusRecord>();
    const generationByKey = new Map<string, BrokerChannelGenerationObservationRecord>();
    const fetchByRoute = new Map<string, BrokerRouteFetchCursorRecord>();
    const semanticByRoute = new Map<string, BrokerRouteSemanticCursorRecord>();
    const gapById = new Map<string, BrokerRouteGapRecord>();
    const positionEquivocationById = new Map<string, ChannelPositionEquivocationRecord>();
    const positionEquivocationByDigest = new Map<string, ChannelPositionEquivocationRecord>();
    const manifestEquivocationById = new Map<string, BrokerChannelManifestEquivocationRecord>();
    const manifestEquivocationByObservation = new Map<
      string,
      BrokerChannelManifestEquivocationRecord
    >();
    const transportCollisionById = new Map<string, BrokerTransportKeyCollisionRecord>();
    const positionById = new Map<string, AuthenticatedChannelPositionRecord>();
    const positionByCursor = new Map<string, AuthenticatedChannelPositionRecord>();
    const firstTransportPositionByKey = new Map<string, AuthenticatedChannelPositionRecord>();
    const resultById = new Map<string, AuthenticatedIngressResultRecord>();
    const attemptByKey = new Map<string, IngressTransportAttemptRecord>();
    const candidateByKey = new Map<string, IngressDeliveryCandidateRecord>();
    const partByKey = new Map<string, AuthenticatedIngressPartRecord>();
    const partsByCandidate = new Map<string, AuthenticatedIngressPartRecord[]>();
    const partDigestsByResultCoordinate = new Map<string, Set<string>>();
    const observationById = new Map<string, AuthenticatedIngressObservationRecord>();
    const observationByPosition = new Map<string, AuthenticatedIngressObservationRecord>();
    const observationsByResult = new Map<string, AuthenticatedIngressObservationRecord[]>();
    const observationsByCandidate = new Map<string, AuthenticatedIngressObservationRecord[]>();
    const observationsByGap = new Map<string, AuthenticatedIngressObservationRecord[]>();
    const pageById = new Map<string, BrokerReadPageObservationRecord>();
    const pagesByEvidenceRef = new Map<string, BrokerReadPageObservationRecord[]>();
    const pageByManifestEvidence = new Map<string, BrokerReadPageObservationRecord>();
    const pagesByRoute = new Map<string, BrokerReadPageObservationRecord[]>();
    const acceptedPageTransition = new Map<string, BrokerReadPageObservationRecord>();
    const acceptedPageTransitionCountByRoute = new Map<string, number>();
    const successfulReadPageCountByRoute = new Map<string, number>();
    const successfulReadPageUpdatedAtByRoute = new Map<string, number>();
    const acceptedGenerationEvidence = new Map<
      string,
      {
        maxOpenTail: number;
        lastObservedAtMs: number;
        firstSealedAtMs: number | null;
        lastOpenAtMs: number | null;
      }
    >();
    const pageFrames = new Map<string, BrokerReadPageFrameEvidenceRecord[]>();
    const priorOpenTailByPage = new Map<string, number>();
    const witnessedPositionEvidence = new Set<string>();
    const witnessedPositionEquivocations = new Set<string>();
    const witnessedPositionEquivocationFirstEvidence = new Set<string>();
    const positionOccurrenceGap = new Map<
      string,
      Readonly<{
        equivocationId: A1SafeId;
        evidenceRef: ProtectedHandleId;
        evidenceDigest: A1Digest;
        observedAtMs: number;
      }>
    >();
    const manifestOccurrenceGap = new Map<
      string,
      Readonly<{
        equivocationId: A1SafeId;
        evidenceRef: ProtectedHandleId;
        evidenceDigest: A1Digest;
        observedAtMs: number;
      }>
    >();
    const outerOccurrenceGap = new Map<
      string,
      Readonly<{
        evidenceRef: ProtectedHandleId;
        evidenceDigest: A1Digest;
        observedAtMs: number;
      }>
    >();
    const recoveryByGap = new Map<string, ChannelPositionRecoveryRecord>();
    const actorByRoute = new Map<string, StoredBrokerRouteActorRecord>();
    const leaseByFence = new Map<string, CoordinatorLeaseRecord>();
    const maxLeaseDeadlineByServer = new Map<string, number>();
    const outerPageGapDigests = new Set<string>();
    const generationCountByRoute = new Map<string, number>();
    const gapsByTransportCollision = new Map<string, BrokerRouteGapRecord[]>();
    for (const record of snapshot.runtimeStatuses)
      putUnique(runtimeByRoute, record.brokerRouteId, record, "runtime status");
    for (const record of snapshot.generationObservations) {
      putUnique(
        generationByKey,
        pairKey(record.brokerRouteId, String(record.channelGeneration)),
        record,
        "generation observation",
      );
      generationCountByRoute.set(
        record.brokerRouteId,
        (generationCountByRoute.get(record.brokerRouteId) ?? 0) + 1,
      );
    }
    for (const record of snapshot.fetchCursors) {
      if (!routeScopes.has(record.brokerRouteId)) {
        throw new IngressRepositoryPersistenceError("fetch cursor route is absent");
      }
      putUnique(fetchByRoute, record.brokerRouteId, record, "fetch cursor");
    }
    for (const record of snapshot.semanticCursors) {
      if (!routeScopes.has(record.brokerRouteId)) {
        throw new IngressRepositoryPersistenceError("semantic cursor route is absent");
      }
      putUnique(semanticByRoute, record.brokerRouteId, record, "semantic cursor");
    }
    for (const record of snapshot.gaps) {
      putUnique(gapById, record.gapId, record, "route gap");
      if (record.transportKeyCollisionId !== null) {
        const list = gapsByTransportCollision.get(record.transportKeyCollisionId) ?? [];
        list.push(record);
        gapsByTransportCollision.set(record.transportKeyCollisionId, list);
      }
    }
    for (const record of snapshot.positionEquivocations) {
      putUnique(
        positionEquivocationById,
        record.positionEquivocationId,
        record,
        "position equivocation",
      );
      putUnique(
        positionEquivocationByDigest,
        `${record.brokerRouteId}\u0000${record.channelPositionObservationId}\u0000${record.conflictingFrameDigest}`,
        record,
        "position equivocation digest",
      );
    }
    for (const record of snapshot.manifestEquivocations) {
      putUnique(
        manifestEquivocationById,
        record.manifestEquivocationId,
        record,
        "manifest equivocation",
      );
      putUnique(
        manifestEquivocationByObservation,
        `${record.brokerRouteId}\u0000${record.channelGeneration}\u0000${record.conflictingObservationDigest}`,
        record,
        "manifest equivocation observation",
      );
    }
    for (const record of snapshot.transportCollisions)
      putUnique(
        transportCollisionById,
        record.transportKeyCollisionId,
        record,
        "transport collision",
      );
    for (const record of snapshot.positions) {
      putUnique(positionById, record.channelPositionObservationId, record, "channel position");
      putUnique(
        positionByCursor,
        cursorKey(record.brokerRouteId, record.channelGeneration, record.frameIndex),
        record,
        "channel cursor",
      );
      if (
        record.deliveryAttemptId !== null &&
        record.part !== null &&
        record.normalizedTransportFrameDigest !== null
      ) {
        const key = `${record.brokerRouteId}\u0000${record.deliveryAttemptId}\u0000${record.part}`;
        const prior = firstTransportPositionByKey.get(key);
        if (
          prior === undefined ||
          record.channelGeneration < prior.channelGeneration ||
          (record.channelGeneration === prior.channelGeneration &&
            record.frameIndex < prior.frameIndex)
        ) {
          firstTransportPositionByKey.set(key, record);
        }
      }
    }
    for (const record of snapshot.results)
      putUnique(resultById, record.stableSemanticResultId, record, "semantic result");
    for (const record of snapshot.attempts)
      putUnique(
        attemptByKey,
        pairKey(record.brokerRouteId, record.deliveryAttemptId),
        record,
        "transport attempt",
      );
    for (const record of snapshot.candidates) {
      putUnique(
        candidateByKey,
        pairKey(record.stableSemanticResultId, record.deliveryAttemptId),
        record,
        "delivery candidate",
      );
    }
    for (const record of snapshot.parts) {
      putUnique(
        partByKey,
        partKey(record.stableSemanticResultId, record.deliveryAttemptId, record.part),
        record,
        "ingress part",
      );
      const key = pairKey(record.stableSemanticResultId, record.deliveryAttemptId);
      const list = partsByCandidate.get(key) ?? [];
      list.push(record);
      partsByCandidate.set(key, list);
      const coordinateKey = pairKey(record.stableSemanticResultId, String(record.part));
      const coordinateDigests = partDigestsByResultCoordinate.get(coordinateKey) ?? new Set();
      coordinateDigests.add(record.authenticatedPartDigest);
      partDigestsByResultCoordinate.set(coordinateKey, coordinateDigests);
    }
    for (const record of snapshot.observations) {
      putUnique(observationById, record.ingressObservationId, record, "ingress observation");
      putUnique(
        observationByPosition,
        record.channelPositionObservationId,
        record,
        "position observation",
      );
      const resultList = observationsByResult.get(record.stableSemanticResultId) ?? [];
      resultList.push(record);
      observationsByResult.set(record.stableSemanticResultId, resultList);
      const candidateKey = pairKey(record.stableSemanticResultId, record.deliveryAttemptId);
      const candidateList = observationsByCandidate.get(candidateKey) ?? [];
      candidateList.push(record);
      observationsByCandidate.set(candidateKey, candidateList);
      if (record.gapId !== null) {
        const gapObservations = observationsByGap.get(record.gapId) ?? [];
        gapObservations.push(record);
        observationsByGap.set(record.gapId, gapObservations);
      }
    }
    for (const record of snapshot.readPageObservations) {
      putUnique(pageById, record.readPageObservationId, record, "read-page observation");
      const evidencePages = pagesByEvidenceRef.get(record.evidenceRef) ?? [];
      evidencePages.push(record);
      pagesByEvidenceRef.set(record.evidenceRef, evidencePages);
      const manifestEvidenceKey = `${record.brokerRouteId}\u0000${record.requestedGeneration}\u0000${record.evidenceRef}\u0000${record.evidenceDigest}\u0000${record.observedAtMs}`;
      if (!pageByManifestEvidence.has(manifestEvidenceKey)) {
        pageByManifestEvidence.set(manifestEvidenceKey, record);
      }
      const list = pagesByRoute.get(record.brokerRouteId) ?? [];
      list.push(record);
      pagesByRoute.set(record.brokerRouteId, list);
    }
    for (const record of snapshot.readPageFrameEvidence) {
      const list = pageFrames.get(record.readPageObservationId) ?? [];
      list.push(record);
      pageFrames.set(record.readPageObservationId, list);
    }
    const manifestConflictByPageId = new Map<
      string,
      Readonly<{
        equivocation: BrokerChannelManifestEquivocationRecord;
        gapId: A1SafeId;
      }>
    >();
    for (const page of snapshot.readPageObservations) {
      const writer = new CanonicalWriter();
      let preimage: Uint8Array | null = null;
      try {
        writer.str("remote-claw/a1/generation-observation/v1");
        writer.str(page.brokerRouteId);
        writer.uint(page.requestedGeneration);
        writer.str(page.generationState);
        writer.uint(page.observedNextFrameIndex);
        writer.optionalUint(page.generationFrameCount);
        writer.optionalUint(page.generationNextGeneration);
        writer.optionalStr(page.generationManifestDigest);
        preimage = writer.finish();
        const equivocation = manifestEquivocationByObservation.get(
          `${page.brokerRouteId}\u0000${page.requestedGeneration}\u0000${digest(preimage)}`,
        );
        if (equivocation !== undefined) {
          const gapId = deterministicEvidenceId(
            "gap",
            page.brokerRouteId,
            "manifest_equivocation",
            deterministicEvidenceId(
              "manifest-gap-occurrence",
              equivocation.manifestEquivocationId,
              page.readPageObservationId,
            ),
          );
          const gap = gapById.get(gapId);
          if (
            gap?.reason === "manifest_equivocation" &&
            gap.manifestEquivocationId === equivocation.manifestEquivocationId &&
            gap.evidenceRef === page.evidenceRef &&
            gap.evidenceDigest === page.evidenceDigest
          ) {
            manifestConflictByPageId.set(
              page.readPageObservationId,
              Object.freeze({ equivocation, gapId }),
            );
          }
        }
      } finally {
        preimage?.fill(0);
        writer.destroy();
      }
    }
    for (const routePages of pagesByRoute.values()) {
      const priorTailByGeneration = new Map<number, number>();
      let index = 0;
      while (index < routePages.length) {
        const observedAtMs = routePages[index]?.observedAtMs;
        let groupEnd = index;
        const groupMaxByGeneration = new Map<number, number>();
        while (
          groupEnd < routePages.length &&
          routePages[groupEnd]?.observedAtMs === observedAtMs
        ) {
          const page = routePages[groupEnd];
          if (page !== undefined) {
            priorOpenTailByPage.set(
              page.readPageObservationId,
              priorTailByGeneration.get(page.requestedGeneration) ?? 0,
            );
          }
          if (
            page !== undefined &&
            page.generationState === "open" &&
            !manifestConflictByPageId.has(page.readPageObservationId)
          ) {
            groupMaxByGeneration.set(
              page.requestedGeneration,
              Math.max(
                groupMaxByGeneration.get(page.requestedGeneration) ?? 0,
                page.observedNextFrameIndex,
              ),
            );
          }
          groupEnd++;
        }
        for (const [generation, tail] of groupMaxByGeneration) {
          priorTailByGeneration.set(
            generation,
            Math.max(priorTailByGeneration.get(generation) ?? 0, tail),
          );
        }
        index = groupEnd;
      }
    }
    for (const record of snapshot.recoveries)
      putUnique(recoveryByGap, record.gapId, record, "gap recovery");
    for (const record of snapshot.actors)
      putUnique(actorByRoute, record.brokerRouteId, record, "route actor");
    for (const gap of snapshot.gaps) {
      if (gap.reason === "outer_page_invalid") {
        outerPageGapDigests.add(`${gap.brokerRouteId}\u0000${gap.evidenceDigest}`);
      }
    }
    for (const record of sqlAll(
      transaction,
      `SELECT coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, heartbeat_deadline_ms, released_at_ms, state
         FROM coordinator_leases ORDER BY collaboration_server_id, coordinator_epoch`,
    ).map((value) => parseCoordinatorLeaseRecord(mappedRow(value, "coordinatorLease")))) {
      putUnique(
        leaseByFence,
        `${record.collaborationServerId}\u0000${record.coordinatorLeaseId}\u0000${record.coordinatorEpoch}`,
        record,
        "coordinator lease fence",
      );
      maxLeaseDeadlineByServer.set(
        record.collaborationServerId,
        Math.max(
          maxLeaseDeadlineByServer.get(record.collaborationServerId) ?? 0,
          record.heartbeatDeadlineMs,
        ),
      );
    }

    const referencedArtifacts = new Set<string>();
    const artifactRoute = new Map<string, string>();
    const verifyAllowedArtifact = (
      ref: ProtectedHandleId,
      scopeId: CollaborationServerId,
      routeId: BrokerRouteId,
      digestValue: A1Digest,
      schemas: readonly string[],
      byteLength?: number,
    ): Uint8Array => {
      const metadataValue = sqlGet(
        transaction,
        `SELECT artifact_schema_id FROM protected_artifacts
          WHERE protected_handle_id=? LIMIT 1`,
        [ref],
      );
      if (metadataValue === undefined) {
        throw new IngressRepositoryPersistenceError("referenced ingress artifact is absent");
      }
      const schema = String(mappedRow(metadataValue, "ingressArtifactSchema").artifactSchemaId);
      if (!schemas.includes(schema)) {
        throw new IngressRepositoryPersistenceError("ingress artifact schema is inconsistent");
      }
      const priorRoute = artifactRoute.get(ref);
      if (priorRoute !== undefined && priorRoute !== routeId) {
        throw new IngressRepositoryPersistenceError(
          "protected ingress artifact is referenced across broker routes",
        );
      }
      artifactRoute.set(ref, routeId);
      referencedArtifacts.add(ref);
      return verifyArtifact(transaction, ref, scopeId, schema, digestValue, byteLength);
    };
    const verifyAndScrub = (
      ref: ProtectedHandleId,
      scopeId: CollaborationServerId,
      routeId: BrokerRouteId,
      digestValue: A1Digest,
      schemas: readonly string[],
      byteLength?: number,
    ): void => {
      const bytes = verifyAllowedArtifact(ref, scopeId, routeId, digestValue, schemas, byteLength);
      bytes.fill(0);
    };

    const positionHeader = (position: AuthenticatedChannelPositionRecord): A1FrameHeaderV2 => {
      if (
        position.frameIdentityId === null ||
        position.frameCollaborationServerId === null ||
        position.direction === null ||
        position.recordKind === null ||
        position.messageId === null ||
        position.deliveryAttemptId === null ||
        position.keyEpoch === null ||
        position.part === null ||
        position.parts === null
      ) {
        throw new IngressRepositoryPersistenceError("classified position header is incomplete");
      }
      return {
        v: 2,
        identityId: Uint8Array.from(Buffer.from(position.frameIdentityId, "hex")),
        collaborationServerId: position.frameCollaborationServerId,
        logicalChatId: position.frameLogicalChatId,
        dir: position.direction,
        recordKind: position.recordKind,
        seq: position.sequence,
        msgId: position.messageId,
        deliveryAttemptId: position.deliveryAttemptId,
        clientMsgId: position.clientMessageId,
        keyEpoch: position.keyEpoch,
        part: position.part,
        parts: position.parts,
        serverKeyGeneration: position.serverKeyGeneration,
        hostSignerIdentityKeyId: position.hostSignerIdentityKeyId,
        hostScopeCertificateId: position.hostScopeCertificateId,
        hostSignatureSequence: position.hostSignatureSequence,
      };
    };

    for (const [routeId, route] of routeScopes) {
      const runtime = runtimeByRoute.get(routeId);
      const fetch = fetchByRoute.get(routeId);
      const semantic = semanticByRoute.get(routeId);
      if (
        runtime === undefined ||
        fetch === undefined ||
        semantic === undefined ||
        generationByKey.get(pairKey(routeId, String(route.genesisGeneration))) === undefined ||
        generationByKey.get(pairKey(routeId, String(runtime.currentChannelGeneration))) ===
          undefined ||
        generationByKey.get(pairKey(routeId, String(fetch.nextGeneration))) === undefined ||
        generationByKey.get(pairKey(routeId, String(semantic.nextGeneration))) === undefined
      ) {
        throw new IngressRepositoryPersistenceError(
          "route ingress seed/generation closure is absent",
        );
      }
    }
    for (const generation of snapshot.generationObservations) {
      if (generation.state === "sealed") {
        const manifest = canonicalA1BrokerGenerationManifestV1({
          brokerRouteId: generation.brokerRouteId,
          channelGeneration: generation.channelGeneration,
          frameCount: generation.frameCount as number,
          nextGeneration: generation.nextGeneration as number,
          state: "sealed",
        });
        try {
          if (digest(manifest) !== generation.manifestDigest) {
            throw new IngressRepositoryPersistenceError(
              "sealed generation manifest digest does not recompute",
            );
          }
        } finally {
          manifest.fill(0);
        }
      }
    }

    const walkCursor = (
      routeId: string,
      targetGeneration: number,
      targetFrameIndex: number,
    ): ReadonlySet<string> => {
      const route = routeScopes.get(routeId);
      if (route === undefined) {
        throw new IngressRepositoryPersistenceError("cursor route is absent");
      }
      let generation = route.genesisGeneration;
      let frameIndex = 0;
      let steps = 0;
      const visited = new Set<string>();
      while (generation !== targetGeneration || frameIndex !== targetFrameIndex) {
        if (
          steps++ >
          snapshot.readPageObservations.length + snapshot.generationObservations.length
        ) {
          throw new IngressRepositoryPersistenceError("fetch cursor transition graph cycles");
        }
        const page = acceptedPageTransition.get(cursorKey(routeId, generation, frameIndex));
        if (page === undefined) {
          throw new IngressRepositoryPersistenceError(
            "fetch cursor is not reachable through exact accepted read pages",
          );
        }
        if (visited.has(page.readPageObservationId)) {
          throw new IngressRepositoryPersistenceError("fetch cursor transition graph cycles");
        }
        visited.add(page.readPageObservationId);
        generation = page.nextGeneration;
        frameIndex = page.nextFrameIndex;
      }
      return visited;
    };
    const validateRouteCursors = (): void => {
      for (const [routeId, route] of routeScopes) {
        const runtime = runtimeByRoute.get(routeId) as BrokerRouteRuntimeStatusRecord;
        let expectedGeneration = route.genesisGeneration;
        for (;;) {
          const generation = generationByKey.get(pairKey(routeId, String(expectedGeneration)));
          if (generation === undefined) {
            throw new IngressRepositoryPersistenceError("generation chain contains a hole");
          }
          if (generation.state === "open") break;
          if (generation.nextGeneration !== expectedGeneration + 1) {
            throw new IngressRepositoryPersistenceError("sealed generation successor is invalid");
          }
          expectedGeneration = generation.nextGeneration;
        }
        if (
          expectedGeneration !== runtime.currentChannelGeneration ||
          generationCountByRoute.get(routeId) !== expectedGeneration - route.genesisGeneration + 1
        ) {
          throw new IngressRepositoryPersistenceError(
            "generation observations are not the exact genesis-to-current chain",
          );
        }
        const fetch = fetchByRoute.get(routeId) as BrokerRouteFetchCursorRecord;
        const visitedFetchPages = walkCursor(routeId, fetch.nextGeneration, fetch.nextFrameIndex);
        const successfulPageCount = successfulReadPageCountByRoute.get(routeId) ?? 0;
        const expectedFetchUpdatedAtMs = Math.max(
          route.createdAtMs,
          successfulReadPageUpdatedAtByRoute.get(routeId) ?? route.createdAtMs,
        );
        if (
          fetch.revision !== successfulPageCount ||
          fetch.updatedAtMs !== expectedFetchUpdatedAtMs ||
          visitedFetchPages.size !== (acceptedPageTransitionCountByRoute.get(routeId) ?? 0)
        ) {
          throw new IngressRepositoryPersistenceError(
            "fetch cursor revision or timestamp does not close over successful read pages",
          );
        }

        const semantic = semanticByRoute.get(routeId) as BrokerRouteSemanticCursorRecord;
        let semanticGeneration = route.genesisGeneration;
        let semanticFrameIndex = 0;
        let throughGeneration: number | null = null;
        let throughFrameIndex: number | null = null;
        let semanticSteps = 0;
        let semanticEnabledAtMs = route.createdAtMs;
        while (
          semanticGeneration !== semantic.nextGeneration ||
          semanticFrameIndex !== semantic.nextFrameIndex
        ) {
          if (
            semanticSteps++ >
            snapshot.positions.length + snapshot.generationObservations.length
          ) {
            throw new IngressRepositoryPersistenceError("semantic cursor prefix cycles");
          }
          const generation = generationByKey.get(pairKey(routeId, String(semanticGeneration)));
          if (generation === undefined) {
            throw new IngressRepositoryPersistenceError(
              "semantic cursor prefix leaves the generation chain",
            );
          }
          const position = positionByCursor.get(
            cursorKey(routeId, semanticGeneration, semanticFrameIndex),
          );
          if (position?.cursorDisposition === "advanceable") {
            semanticEnabledAtMs = Math.max(
              semanticEnabledAtMs,
              position.classifiedAtMs ?? position.observedAtMs,
            );
            throughGeneration = semanticGeneration;
            throughFrameIndex = semanticFrameIndex;
            semanticFrameIndex++;
            continue;
          }
          if (generation.state === "sealed" && semanticFrameIndex === generation.frameCount) {
            semanticEnabledAtMs = Math.max(
              semanticEnabledAtMs,
              acceptedGenerationEvidence.get(pairKey(routeId, String(semanticGeneration)))
                ?.firstSealedAtMs ?? generation.lastObservedAtMs,
            );
            semanticGeneration = generation.nextGeneration as number;
            semanticFrameIndex = 0;
            continue;
          }
          throw new IngressRepositoryPersistenceError(
            "semantic cursor skips an absent or blocked physical position",
          );
        }
        if (
          semantic.contiguousThroughGeneration !== throughGeneration ||
          semantic.contiguousThroughFrameIndex !== throughFrameIndex ||
          semantic.revision !== semanticSteps ||
          (semantic.revision === 0
            ? semantic.updatedAtMs !== route.createdAtMs
            : semantic.updatedAtMs < semanticEnabledAtMs) ||
          semantic.updatedAtMs >
            (actorByRoute.get(routeId)?.updatedAtMs ?? Number.NEGATIVE_INFINITY) ||
          semantic.nextGeneration > fetch.nextGeneration ||
          (semantic.nextGeneration === fetch.nextGeneration &&
            semantic.nextFrameIndex > fetch.nextFrameIndex)
        ) {
          throw new IngressRepositoryPersistenceError(
            "semantic cursor does not equal the independently recomputed contiguous prefix",
          );
        }
      }
    };

    for (const position of snapshot.positions) {
      if (
        expectedPositionId(position.brokerRouteId, {
          version: 1,
          channelGeneration: position.channelGeneration,
          frameIndex: position.frameIndex,
        }) !== position.channelPositionObservationId ||
        (position.classifiedAtMs !== null && position.classifiedAtMs < position.observedAtMs)
      ) {
        throw new IngressRepositoryPersistenceError("channel-position identity does not recompute");
      }
      const raw = verifyAllowedArtifact(
        position.receivedFrameRef,
        position.collaborationServerId,
        position.brokerRouteId,
        position.receivedFrameDigest,
        [A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID],
        position.receivedFrameByteLength,
      );
      let normalized: Uint8Array | null = null;
      try {
        if (position.classification === "known_host_output") {
          throw new IngressRepositoryPersistenceError(
            "known host output cannot be proved before the A1.8 output ledger",
          );
        }
        if (position.normalizedTransportFrameDigest !== null) {
          const frame = parseA1EncryptedFrameV2(raw);
          normalized = normalizedA1TransportFrameBytes(frame);
          const header = positionHeader(position);
          const columns = parsedHeaderColumns({
            channelPositionObservationId: position.channelPositionObservationId,
            normalizedTransportFrameDigest: position.normalizedTransportFrameDigest,
            header,
          });
          const retainedColumns = [
            position.normalizedTransportFrameDigest,
            position.frameIdentityId,
            position.frameCollaborationServerId,
            position.frameLogicalChatId,
            position.direction,
            position.recordKind,
            position.sequence,
            position.messageId,
            position.deliveryAttemptId,
            position.clientMessageId,
            position.keyEpoch,
            position.part,
            position.parts,
            position.serverKeyGeneration,
            position.hostSignerIdentityKeyId,
            position.hostScopeCertificateId,
            position.hostSignatureSequence,
            position.stableLogicalHeaderDigest,
          ];
          let routeMatches = true;
          try {
            assertA1FrameMatchesRoute(
              frame,
              position.routeKind === "chat"
                ? {
                    routeKind: "chat",
                    identityId: Uint8Array.from(Buffer.from(identity, "hex")),
                    collaborationServerId: position.collaborationServerId,
                    logicalChatId: position.logicalChatId as LogicalChatId,
                  }
                : {
                    routeKind: position.routeKind,
                    identityId: Uint8Array.from(Buffer.from(identity, "hex")),
                    collaborationServerId: position.collaborationServerId,
                    logicalChatId: null,
                  },
            );
          } catch {
            routeMatches = false;
          }
          const brokerClaimsMatch =
            position.claimedDeliveryAttemptId === frame.deliveryAttemptId &&
            position.claimedPart === frame.part &&
            position.claimedTransportFrameDigest === position.normalizedTransportFrameDigest;
          const exactRouteAndClaims = routeMatches && brokerClaimsMatch;
          const selectedInbound =
            exactRouteAndClaims &&
            frame.dir === "in" &&
            ((position.routeKind === "chat" && frame.recordKind === "user") ||
              (position.routeKind === "server_control" && frame.recordKind === "new_chat"));
          const selectedOutbound = exactRouteAndClaims && frame.dir === "out";
          const permitsInvalidClassification =
            position.classification === "invalid" &&
            !selectedOutbound &&
            (!selectedInbound ||
              (position.validationFailureCode !== null &&
                POST_HEADER_INVALID_FAILURE_CODES.has(position.validationFailureCode)));
          const classificationMatchesRetainedFrame =
            position.classification === "invalid"
              ? permitsInvalidClassification
              : position.classification === "unknown_outbound"
                ? selectedOutbound
                : position.classification === "inbound_ingress"
                  ? selectedInbound
                  : false;
          if (
            digest(normalized) !== position.normalizedTransportFrameDigest ||
            columns.some((entry, index) => entry !== retainedColumns[index]) ||
            !classificationMatchesRetainedFrame
          ) {
            throw new IngressRepositoryPersistenceError(
              "classified position does not match its retained raw frame",
            );
          }
        } else if (position.classification === "invalid") {
          let parsedSuccessfully = false;
          try {
            parseA1EncryptedFrameV2(raw);
            parsedSuccessfully = true;
          } catch {
            // Exact durable null-parsed invalid evidence requires a strict wire parse failure.
          }
          if (parsedSuccessfully) {
            throw new IngressRepositoryPersistenceError(
              "null-parsed invalid position retains a valid encrypted frame",
            );
          }
        }
      } finally {
        normalized?.fill(0);
        raw.fill(0);
      }
    }

    for (const observation of snapshot.observations) {
      const position = positionById.get(observation.channelPositionObservationId);
      const result = resultById.get(observation.stableSemanticResultId);
      const attempt = attemptByKey.get(
        pairKey(observation.brokerRouteId, observation.deliveryAttemptId),
      );
      const candidate = candidateByKey.get(
        pairKey(observation.stableSemanticResultId, observation.deliveryAttemptId),
      );
      const retainedPart = partByKey.get(
        partKey(
          observation.stableSemanticResultId,
          observation.deliveryAttemptId,
          observation.part,
        ),
      );
      const requiresRetainedPart = [
        "new_part",
        "exact_duplicate_part",
        "exact_transport_retry",
        "completed_exact_replay",
      ].includes(observation.disposition);
      const exactResultHeader =
        result !== undefined &&
        position !== undefined &&
        position.messageId === result.messageId &&
        position.recordKind === result.recordKind &&
        position.clientMessageId === result.clientMessageId &&
        position.parts === result.expectedParts;
      const semanticResultIdentityExact =
        result !== undefined &&
        position !== undefined &&
        position.messageId !== null &&
        position.messageId === result.messageId &&
        expectedResultId(
          identity,
          routeScopes.get(result.brokerRouteId)?.scope as BrokerRouteActorScope,
          result.sourceEventNamespaceId,
          position.messageId,
        ) === result.stableSemanticResultId;
      if (
        position === undefined ||
        result === undefined ||
        expectedObservationId(position.channelPositionObservationId) !==
          observation.ingressObservationId ||
        position.ingressObservationId !== observation.ingressObservationId ||
        position.classification !== "inbound_ingress" ||
        position.channelGeneration !== observation.channelGeneration ||
        position.frameIndex !== observation.frameIndex ||
        position.deliveryAttemptId !== observation.deliveryAttemptId ||
        position.part !== observation.part ||
        position.parts !== observation.parts ||
        position.cursorDisposition !== observation.cursorDisposition ||
        position.gapId !== observation.gapId ||
        position.recoveryId !== observation.recoveryId ||
        (!["collision", "late_after_tombstone"].includes(observation.disposition) &&
          !exactResultHeader) ||
        (observation.disposition === "late_after_tombstone" &&
          (!semanticResultIdentityExact ||
            !["quarantined_incomplete", "quarantined_collision"].includes(result.state))) ||
        (attempt !== undefined &&
          (observation.disposition !== "collision" || attempt.bindingDisposition === "collision") &&
          position.stableLogicalHeaderDigest !== attempt.stableLogicalHeaderDigest) ||
        (requiresRetainedPart &&
          (attempt?.bindingDisposition !== "exact" ||
            candidate === undefined ||
            retainedPart === undefined ||
            retainedPart.parts !== observation.parts ||
            retainedPart.authenticatedPartDigest !== observation.authenticatedPartDigest))
      ) {
        throw new IngressRepositoryPersistenceError(
          "ingress observation does not close over its exact position",
        );
      }
      const plaintextEvidence = verifyAllowedArtifact(
        observation.plaintextEvidenceRef,
        observation.collaborationServerId,
        observation.brokerRouteId,
        observation.plaintextEvidenceDigest,
        [A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID],
        observation.plaintextEvidenceByteLength,
      );
      try {
        if (
          position.normalizedTransportFrameDigest !== null &&
          canonicalPartDigest(positionHeader(position), plaintextEvidence) !==
            observation.authenticatedPartDigest
        ) {
          throw new IngressRepositoryPersistenceError(
            "ingress observation authenticated plaintext digest does not recompute",
          );
        }
      } finally {
        plaintextEvidence.fill(0);
      }
    }

    for (const attempt of snapshot.attempts) {
      const result = resultById.get(attempt.stableSemanticResultId);
      const exactBinding =
        result !== undefined &&
        attempt.sourceEventNamespaceId === result.sourceEventNamespaceId &&
        attempt.messageId === result.messageId &&
        attempt.recordKind === result.recordKind &&
        attempt.clientMessageId === result.clientMessageId &&
        attempt.expectedParts === result.expectedParts;
      const collisionGap =
        attempt.collisionGapId === null ? undefined : gapById.get(attempt.collisionGapId);
      const collisionWitness = (
        observationsByCandidate.get(
          pairKey(attempt.stableSemanticResultId, attempt.deliveryAttemptId),
        ) ?? []
      ).some((observation) => {
        const position = positionById.get(observation.channelPositionObservationId);
        return (
          observation.disposition === "collision" &&
          observation.gapId === attempt.collisionGapId &&
          position?.deliveryAttemptId === attempt.deliveryAttemptId &&
          position.stableLogicalHeaderDigest === attempt.stableLogicalHeaderDigest
        );
      });
      if (
        result === undefined ||
        (attempt.bindingDisposition === "exact" &&
          (!exactBinding ||
            attempt.candidateRequiredResultId !== attempt.stableSemanticResultId ||
            !candidateByKey.has(
              pairKey(attempt.stableSemanticResultId, attempt.deliveryAttemptId),
            ))) ||
        (attempt.bindingDisposition === "collision" &&
          (exactBinding ||
            attempt.candidateRequiredResultId !== null ||
            collisionGap?.reason !== "semantic_collision" ||
            collisionGap.stableSemanticResultId !== attempt.stableSemanticResultId ||
            !collisionWitness))
      ) {
        throw new IngressRepositoryPersistenceError(
          "transport attempt does not close over its immutable semantic binding",
        );
      }
    }

    const partObservation = new Map<string, AuthenticatedIngressObservationRecord>();
    const observationByPartCursor = new Map<string, AuthenticatedIngressObservationRecord>();
    const semanticPartCoordinate = new Map<
      string,
      Readonly<{ parts: number; authenticatedPartDigest: A1Digest }>
    >();
    for (const observation of snapshot.observations) {
      if (
        observation.disposition === "new_part" ||
        observation.disposition === "completed_exact_replay" ||
        observation.disposition === "invalid_payload"
      ) {
        putUnique(
          observationByPartCursor,
          `${partKey(
            observation.stableSemanticResultId,
            observation.deliveryAttemptId,
            observation.part,
          )}\u0000${observation.channelGeneration}\u0000${observation.frameIndex}`,
          observation,
          "ingress part cursor observation",
        );
      }
    }
    for (const part of snapshot.parts) {
      const attempt = attemptByKey.get(pairKey(part.brokerRouteId, part.deliveryAttemptId));
      const result = resultById.get(part.stableSemanticResultId);
      const candidate = candidateByKey.get(
        pairKey(part.stableSemanticResultId, part.deliveryAttemptId),
      );
      const retainedPartKey = partKey(
        part.stableSemanticResultId,
        part.deliveryAttemptId,
        part.part,
      );
      const observation = observationByPartCursor.get(
        `${retainedPartKey}\u0000${part.firstIngressGeneration}\u0000${part.firstIngressFrameIndex}`,
      );
      const position =
        observation === undefined
          ? undefined
          : positionById.get(observation.channelPositionObservationId);
      const coordinateKey = pairKey(part.stableSemanticResultId, String(part.part));
      const priorCoordinate = semanticPartCoordinate.get(coordinateKey);
      if (
        attempt === undefined ||
        attempt.bindingDisposition !== "exact" ||
        result === undefined ||
        candidate === undefined ||
        observation === undefined ||
        position === undefined ||
        observation.authenticatedPartDigest !== part.authenticatedPartDigest ||
        observation.plaintextEvidenceRef !== part.plaintextPartRef ||
        part.firstIngressGeneration !== observation.channelGeneration ||
        part.firstIngressFrameIndex !== observation.frameIndex ||
        part.parts !== result.expectedParts ||
        candidate.expectedParts !== result.expectedParts ||
        position.messageId !== result.messageId ||
        position.recordKind !== result.recordKind ||
        position.clientMessageId !== result.clientMessageId ||
        position.parts !== result.expectedParts ||
        position.stableLogicalHeaderDigest !== attempt.stableLogicalHeaderDigest ||
        (priorCoordinate !== undefined &&
          (priorCoordinate.parts !== part.parts ||
            priorCoordinate.authenticatedPartDigest !== part.authenticatedPartDigest))
      ) {
        throw new IngressRepositoryPersistenceError(
          "retained ingress part does not close over first authenticated evidence",
        );
      }
      semanticPartCoordinate.set(
        coordinateKey,
        Object.freeze({
          parts: part.parts,
          authenticatedPartDigest: part.authenticatedPartDigest,
        }),
      );
      partObservation.set(retainedPartKey, observation);
      const bytes = verifyAllowedArtifact(
        part.plaintextPartRef,
        part.collaborationServerId,
        part.brokerRouteId,
        part.plaintextPartDigest,
        [A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID],
        part.plaintextPartByteLength,
      );
      try {
        if (canonicalPartDigest(positionHeader(position), bytes) !== part.authenticatedPartDigest) {
          throw new IngressRepositoryPersistenceError(
            "authenticated plaintext-part digest does not recompute",
          );
        }
      } finally {
        bytes.fill(0);
      }
    }

    const candidateCountByResult = new Map<string, number>();
    const plaintextBytesByResult = new Map<string, number>();
    const allCandidatesExpiredByResult = new Map<string, boolean>();
    for (const candidate of snapshot.candidates) {
      const attempt = attemptByKey.get(
        pairKey(candidate.brokerRouteId, candidate.deliveryAttemptId),
      );
      const result = resultById.get(candidate.stableSemanticResultId);
      const parts =
        partsByCandidate.get(
          pairKey(candidate.stableSemanticResultId, candidate.deliveryAttemptId),
        ) ?? [];
      const bytes = parts.reduce((sum, part) => sum + part.plaintextPartByteLength, 0);
      const candidateCount =
        (candidateCountByResult.get(candidate.stableSemanticResultId) ?? 0) + 1;
      const resultPlaintextBytes =
        (plaintextBytesByResult.get(candidate.stableSemanticResultId) ?? 0) + bytes;
      candidateCountByResult.set(candidate.stableSemanticResultId, candidateCount);
      plaintextBytesByResult.set(candidate.stableSemanticResultId, resultPlaintextBytes);
      allCandidatesExpiredByResult.set(
        candidate.stableSemanticResultId,
        (allCandidatesExpiredByResult.get(candidate.stableSemanticResultId) ?? true) &&
          candidate.state === "expired",
      );
      const bounds = cursorBounds(
        observationsByCandidate.get(
          pairKey(candidate.stableSemanticResultId, candidate.deliveryAttemptId),
        ) ?? [],
      );
      const candidateObservations =
        observationsByCandidate.get(
          pairKey(candidate.stableSemanticResultId, candidate.deliveryAttemptId),
        ) ?? [];
      if (
        attempt === undefined ||
        attempt.stableSemanticResultId !== candidate.stableSemanticResultId ||
        candidate.receivedParts !== parts.length ||
        candidate.plaintextByteCount !== bytes ||
        candidate.firstIngressGeneration !== bounds.firstGeneration ||
        candidate.firstIngressFrameIndex !== bounds.firstIndex ||
        candidate.lastObservedIngressGeneration !== bounds.lastGeneration ||
        candidate.lastObservedIngressFrameIndex !== bounds.lastIndex ||
        (candidate.state === "complete" && parts.length !== candidate.expectedParts) ||
        (candidate.state === "complete" &&
          (result?.acceptedDeliveryAttemptId === null ||
            !["awaiting_order", "quarantined_collision"].includes(result?.state ?? ""))) ||
        (candidate.state === "complete" &&
          result?.acceptedDeliveryAttemptId !== candidate.deliveryAttemptId &&
          !candidateObservations.some(
            (observation) => observation.disposition === "completed_exact_replay",
          )) ||
        candidateCount > A1_INGRESS_MAX_CANDIDATES_PER_RESULT ||
        resultPlaintextBytes > A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES
      ) {
        throw new IngressRepositoryPersistenceError(
          "delivery-candidate part counters do not close",
        );
      }
    }

    const collisionObservationProvesConflict = (
      observation: AuthenticatedIngressObservationRecord,
    ): boolean => {
      if (observation.disposition !== "collision" || observation.gapId === null) return false;
      const gap = gapById.get(observation.gapId);
      const position = positionById.get(observation.channelPositionObservationId);
      const result = resultById.get(observation.stableSemanticResultId);
      if (gap === undefined || position === undefined || result === undefined) return false;
      if (gap.reason === "transport_collision" && gap.transportKeyCollisionId !== null) {
        return transportCollisionById.has(gap.transportKeyCollisionId);
      }
      if (gap.reason !== "semantic_collision") return false;
      const attempt = attemptByKey.get(
        pairKey(observation.brokerRouteId, observation.deliveryAttemptId),
      );
      const resultBindingDiffers =
        position.recordKind !== result.recordKind ||
        position.clientMessageId !== result.clientMessageId ||
        position.parts !== result.expectedParts;
      const attemptBindingDiffers =
        attempt?.bindingDisposition === "collision" ||
        (attempt !== undefined &&
          position.stableLogicalHeaderDigest !== attempt.stableLogicalHeaderDigest);
      const coordinateDigests = partDigestsByResultCoordinate.get(
        pairKey(observation.stableSemanticResultId, String(observation.part)),
      );
      const coordinateDiffers =
        coordinateDigests !== undefined &&
        [...coordinateDigests].some(
          (partDigest) => partDigest !== observation.authenticatedPartDigest,
        );
      const candidateCapReached =
        !candidateByKey.has(
          pairKey(observation.stableSemanticResultId, observation.deliveryAttemptId),
        ) &&
        (candidateCountByResult.get(observation.stableSemanticResultId) ?? 0) >=
          A1_INGRESS_MAX_CANDIDATES_PER_RESULT;
      return (
        resultBindingDiffers || attemptBindingDiffers || coordinateDiffers || candidateCapReached
      );
    };
    const invalidPayloadObservationProvesTerminal = (
      observation: AuthenticatedIngressObservationRecord,
    ): boolean => {
      if (observation.disposition !== "invalid_payload") return false;
      const position = positionById.get(observation.channelPositionObservationId);
      const candidate = candidateByKey.get(
        pairKey(observation.stableSemanticResultId, observation.deliveryAttemptId),
      );
      if (position === undefined || candidate?.state !== "expired") return false;
      const retainedPart = partByKey.get(
        partKey(
          observation.stableSemanticResultId,
          observation.deliveryAttemptId,
          observation.part,
        ),
      );
      const prospectiveBytes =
        retainedPart === undefined ? observation.plaintextEvidenceByteLength : 0;
      if (
        candidate.plaintextByteCount >
          A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES - prospectiveBytes ||
        (plaintextBytesByResult.get(observation.stableSemanticResultId) ?? 0) >
          A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES - prospectiveBytes
      ) {
        return true;
      }
      const parts = [
        ...(partsByCandidate.get(
          pairKey(observation.stableSemanticResultId, observation.deliveryAttemptId),
        ) ?? []),
      ].sort((left, right) => left.part - right.part);
      if (
        parts.length !== candidate.expectedParts ||
        parts.some((part, index) => part.part !== index)
      ) {
        return false;
      }
      const buffers: Uint8Array[] = [];
      let complete: Uint8Array | null = null;
      let selectedBytes: Uint8Array | null = null;
      try {
        for (const part of parts) {
          buffers.push(
            verifyAllowedArtifact(
              part.plaintextPartRef,
              part.collaborationServerId,
              part.brokerRouteId,
              part.plaintextPartDigest,
              [A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID],
              part.plaintextPartByteLength,
            ),
          );
        }
        complete = concatParts(buffers);
        try {
          selectedBytes = parseSelectedA1InboundPayload(
            positionHeader(position),
            complete,
          ).canonicalBytes;
          return false;
        } catch {
          return true;
        }
      } finally {
        selectedBytes?.fill(0);
        complete?.fill(0);
        for (const buffer of buffers) buffer.fill(0);
      }
    };

    const assemblingResultsByRoute = new Map<string, number>();
    for (const result of snapshot.results) {
      if (result.state === "assembling") {
        const count = (assemblingResultsByRoute.get(result.brokerRouteId) ?? 0) + 1;
        assemblingResultsByRoute.set(result.brokerRouteId, count);
        if (count > A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE) {
          throw new IngressRepositoryPersistenceError(
            "route retains too many unresolved semantic results",
          );
        }
      }
      const resultObservations = observationsByResult.get(result.stableSemanticResultId) ?? [];
      const bounds = cursorBounds(resultObservations);
      let firstClassificationAtMs: number | null = null;
      for (const observation of resultObservations) {
        const classifiedAtMs = positionById.get(
          observation.channelPositionObservationId,
        )?.classifiedAtMs;
        if (
          classifiedAtMs !== null &&
          classifiedAtMs !== undefined &&
          (firstClassificationAtMs === null || classifiedAtMs < firstClassificationAtMs)
        ) {
          firstClassificationAtMs = classifiedAtMs;
        }
      }
      const collisionTerminalWitness = resultObservations.some(
        (observation) =>
          positionById.get(observation.channelPositionObservationId)?.classifiedAtMs ===
            result.terminalAtMs && collisionObservationProvesConflict(observation),
      );
      const invalidPayloadTerminalWitness = resultObservations.some(
        (observation) =>
          positionById.get(observation.channelPositionObservationId)?.classifiedAtMs ===
            result.terminalAtMs && invalidPayloadObservationProvesTerminal(observation),
      );
      const expiryTerminalWitness =
        result.terminalAtMs !== null &&
        result.terminalAtMs >= result.assemblyDeadlineMs &&
        (candidateCountByResult.get(result.stableSemanticResultId) ?? 0) > 0 &&
        allCandidatesExpiredByResult.get(result.stableSemanticResultId) === true;
      if (
        expectedNamespaceId(
          identity,
          routeScopes.get(result.brokerRouteId)?.scope as BrokerRouteActorScope,
        ) !== result.sourceEventNamespaceId ||
        expectedResultId(
          identity,
          routeScopes.get(result.brokerRouteId)?.scope as BrokerRouteActorScope,
          result.sourceEventNamespaceId,
          result.messageId,
        ) !== result.stableSemanticResultId ||
        result.firstIngressGeneration !== bounds.firstGeneration ||
        result.firstIngressFrameIndex !== bounds.firstIndex ||
        result.lastObservedIngressGeneration !== bounds.lastGeneration ||
        result.lastObservedIngressFrameIndex !== bounds.lastIndex ||
        firstClassificationAtMs === null ||
        firstClassificationAtMs > Number.MAX_SAFE_INTEGER - A1_INGRESS_ASSEMBLY_DEADLINE_MS ||
        result.assemblyDeadlineMs !== firstClassificationAtMs + A1_INGRESS_ASSEMBLY_DEADLINE_MS ||
        (result.state === "quarantined_collision" &&
          (result.collisionAtMs !== result.terminalAtMs || !collisionTerminalWitness)) ||
        (result.state === "quarantined_incomplete" &&
          !invalidPayloadTerminalWitness &&
          !expiryTerminalWitness)
      ) {
        throw new IngressRepositoryPersistenceError("semantic result identity does not recompute");
      }
      if (result.acceptedDeliveryAttemptId === null) continue;
      const candidate = candidateByKey.get(
        pairKey(result.stableSemanticResultId, result.acceptedDeliveryAttemptId),
      );
      const acceptedParts = [
        ...(partsByCandidate.get(
          pairKey(result.stableSemanticResultId, result.acceptedDeliveryAttemptId),
        ) ?? []),
      ].sort((left, right) => left.part - right.part);
      if (
        candidate === undefined ||
        candidate.state !== "complete" ||
        acceptedParts.length !== result.expectedParts ||
        acceptedParts.some((part, index) => part.part !== index)
      ) {
        throw new IngressRepositoryPersistenceError(
          "accepted semantic result lacks its exact complete candidate vector",
        );
      }
      const buffers: Uint8Array[] = [];
      let complete: Uint8Array | null = null;
      let canonicalPayload: Uint8Array | null = null;
      let acceptedStableHeader: Uint8Array | null = null;
      try {
        for (const part of acceptedParts) {
          buffers.push(
            verifyAllowedArtifact(
              part.plaintextPartRef,
              part.collaborationServerId,
              part.brokerRouteId,
              part.plaintextPartDigest,
              [A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID],
              part.plaintextPartByteLength,
            ),
          );
          const partEvidence = partObservation.get(
            partKey(part.stableSemanticResultId, part.deliveryAttemptId, part.part),
          );
          const partPosition =
            partEvidence === undefined
              ? undefined
              : positionById.get(partEvidence.channelPositionObservationId);
          if (partPosition === undefined) {
            throw new IngressRepositoryPersistenceError(
              "accepted candidate part lacks its exact position header",
            );
          }
          const canonicalHeader = canonicalA1IngressStableLogicalHeader(
            positionHeader(partPosition),
          );
          try {
            if (acceptedStableHeader === null) {
              acceptedStableHeader = canonicalHeader.slice();
            } else if (!Buffer.from(acceptedStableHeader).equals(Buffer.from(canonicalHeader))) {
              throw new IngressRepositoryPersistenceError(
                "accepted candidate vector mixes stable logical headers",
              );
            }
          } finally {
            canonicalHeader.fill(0);
          }
        }
        complete = concatParts(buffers);
        const firstPart = acceptedParts[0];
        const firstObservation =
          firstPart === undefined
            ? undefined
            : partObservation.get(
                partKey(
                  firstPart.stableSemanticResultId,
                  firstPart.deliveryAttemptId,
                  firstPart.part,
                ),
              );
        const firstPosition =
          firstObservation === undefined
            ? undefined
            : positionById.get(firstObservation.channelPositionObservationId);
        if (firstPosition === undefined) {
          throw new IngressRepositoryPersistenceError("accepted result has no first position");
        }
        const header = positionHeader(firstPosition);
        const selected = parseSelectedA1InboundPayload(header, complete);
        canonicalPayload = selected.canonicalBytes;
        const messageDigest = canonicalMessageDigest(header, complete);
        const fingerprint = digest(
          canonicalA1IngressSourceEventFingerprintPreimage(
            result.brokerRouteId,
            result.sourceEventNamespaceId,
            result.messageId,
            messageDigest,
          ),
        );
        if (
          result.sourcePayloadSchemaId !== selected.sourcePayloadSchemaId ||
          result.canonicalMessageDigest !== messageDigest ||
          result.sourceEventFingerprintSchemaId !== A1_INGRESS_SOURCE_EVENT_FINGERPRINT_SCHEMA_ID ||
          result.sourceEventFingerprint !== fingerprint
        ) {
          throw new IngressRepositoryPersistenceError(
            "accepted semantic result digest or fingerprint does not recompute",
          );
        }
      } finally {
        acceptedStableHeader?.fill(0);
        canonicalPayload?.fill(0);
        complete?.fill(0);
        for (const buffer of buffers) buffer.fill(0);
      }
    }

    for (const page of snapshot.readPageObservations) {
      const route = routeScopes.get(page.brokerRouteId);
      const frames = (pageFrames.get(page.readPageObservationId) ?? []).sort(
        (left, right) => left.ordinal - right.ordinal,
      );
      const consumedFrameIndex = page.requestedFrameIndex + page.frameCountInPage;
      const crossesSealedGeneration =
        page.generationState === "sealed" && consumedFrameIndex === page.generationFrameCount;
      const expectedNextGeneration = crossesSealedGeneration
        ? (page.generationNextGeneration as number)
        : page.requestedGeneration;
      const expectedNextFrameIndex = crossesSealedGeneration ? 0 : consumedFrameIndex;
      if (
        route === undefined ||
        page.readPageObservationId !==
          deterministicEvidenceId(
            "read-page-observation",
            page.brokerRouteId,
            page.operationId,
            page.evidenceDigest,
          ) ||
        (page.frameCountInPage === 0 && page.requestedFrameIndex < page.observedNextFrameIndex) ||
        page.observedNextFrameIndex < consumedFrameIndex ||
        (page.generationState === "sealed" &&
          page.observedNextFrameIndex !== page.generationFrameCount) ||
        page.nextGeneration !== expectedNextGeneration ||
        page.nextFrameIndex !== expectedNextFrameIndex ||
        page.atLiveTail !==
          (page.generationState === "open" && consumedFrameIndex === page.observedNextFrameIndex) ||
        page.routeStoreInstanceId !== route.routeStoreInstanceId ||
        frames.length !== page.frameCountInPage ||
        frames.some(
          (frame, index) =>
            frame.ordinal !== index ||
            frame.brokerRouteId !== page.brokerRouteId ||
            frame.channelGeneration !== page.requestedGeneration ||
            frame.frameIndex !== page.requestedFrameIndex + index ||
            expectedPositionId(page.brokerRouteId, {
              version: 1,
              channelGeneration: frame.channelGeneration,
              frameIndex: frame.frameIndex,
            }) !== frame.channelPositionObservationId,
        )
      ) {
        throw new IngressRepositoryPersistenceError("read-page frame evidence is not closed");
      }
      const claimsWriter = new CanonicalWriter();
      let claimsPreimage: Uint8Array | null = null;
      try {
        claimsWriter.str("remote-claw/a1/read-page-frame-claims/v1");
        claimsWriter.uint(frames.length);
        for (const frame of frames) {
          claimsWriter.uint(frame.channelGeneration);
          claimsWriter.uint(frame.frameIndex);
          claimsWriter.str(frame.channelPositionObservationId);
          claimsWriter.str(frame.claimedDeliveryAttemptId);
          claimsWriter.uint(frame.claimedPart);
          claimsWriter.str(frame.claimedTransportFrameDigest);
          claimsWriter.str(frame.receivedFrameDigest);
          claimsWriter.uint(frame.receivedFrameByteLength);
        }
        claimsPreimage = claimsWriter.finish();
        if (digest(claimsPreimage) !== page.frameClaimsDigest) {
          throw new IngressRepositoryPersistenceError(
            "read-page frame-claims digest does not recompute",
          );
        }
      } finally {
        claimsPreimage?.fill(0);
        claimsWriter.destroy();
      }
      const pageBytes = verifyAllowedArtifact(
        page.evidenceRef,
        page.collaborationServerId,
        page.brokerRouteId,
        page.evidenceDigest,
        [A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID],
      );
      try {
        const expectedPage = JSON.stringify({
          v: 1,
          broker_route_id: page.brokerRouteId,
          route_store_instance_id: page.routeStoreInstanceId,
          requested_position: {
            version: 1,
            channelGeneration: page.requestedGeneration,
            nextFrameIndex: page.requestedFrameIndex,
          },
          generation: {
            schemaVersion: 1,
            brokerRouteId: page.brokerRouteId,
            channelGeneration: page.requestedGeneration,
            state: page.generationState,
            frameCount: page.generationFrameCount,
            nextGeneration: page.generationNextGeneration,
            manifestDigest: page.generationManifestDigest,
          },
          observed_next_frame_index: page.observedNextFrameIndex,
          frames: frames.map((frame) => ({
            cursor: {
              version: 1,
              channelGeneration: frame.channelGeneration,
              frameIndex: frame.frameIndex,
            },
            delivery_attempt_id: frame.claimedDeliveryAttemptId,
            part: frame.claimedPart,
            transport_frame_digest: frame.claimedTransportFrameDigest,
            raw_frame_digest: frame.receivedFrameDigest,
          })),
          next_position: {
            version: 1,
            channelGeneration: page.nextGeneration,
            nextFrameIndex: page.nextFrameIndex,
          },
          at_live_tail: page.atLiveTail,
        });
        const retainedPage = new TextDecoder("utf-8", { fatal: true }).decode(pageBytes);
        if (retainedPage !== expectedPage) {
          throw new IngressRepositoryPersistenceError(
            "read-page artifact does not encode its exact retained observation",
          );
        }
      } finally {
        pageBytes.fill(0);
      }
      const retainedGeneration = generationByKey.get(
        pairKey(page.brokerRouteId, String(page.requestedGeneration)),
      );
      const manifestConflictOccurrence = manifestConflictByPageId.get(page.readPageObservationId);
      const manifestOccurrenceGapId = manifestConflictOccurrence?.gapId ?? null;
      const manifestConflict = manifestConflictOccurrence?.equivocation;
      if (manifestConflict !== undefined) {
        manifestOccurrenceGap.set(
          manifestOccurrenceGapId as A1SafeId,
          Object.freeze({
            equivocationId: manifestConflict.manifestEquivocationId,
            evidenceRef: page.evidenceRef,
            evidenceDigest: page.evidenceDigest,
            observedAtMs: page.observedAtMs,
          }),
        );
      }
      const exactSealedGeneration =
        retainedGeneration !== undefined &&
        page.generationState === "sealed" &&
        retainedGeneration.state === "sealed" &&
        retainedGeneration.observedNextFrameIndex >= page.observedNextFrameIndex &&
        retainedGeneration.frameCount === page.generationFrameCount &&
        retainedGeneration.nextGeneration === page.generationNextGeneration &&
        retainedGeneration.manifestDigest === page.generationManifestDigest;
      const historicalOpenGeneration =
        retainedGeneration !== undefined &&
        page.generationState === "open" &&
        page.generationFrameCount === null &&
        page.generationNextGeneration === null &&
        page.generationManifestDigest === null &&
        page.observedAtMs >= retainedGeneration.firstObservedAtMs &&
        page.observedAtMs <= retainedGeneration.lastObservedAtMs &&
        page.observedNextFrameIndex <= retainedGeneration.observedNextFrameIndex &&
        (retainedGeneration.state === "open" ||
          page.observedNextFrameIndex <= (retainedGeneration.frameCount as number));
      const priorOpenTail = priorOpenTailByPage.get(page.readPageObservationId) ?? 0;
      const conflictsPriorOpenTail =
        (page.generationState === "open" && page.observedNextFrameIndex < priorOpenTail) ||
        (page.generationState === "sealed" &&
          page.generationFrameCount !== null &&
          page.generationFrameCount < priorOpenTail);
      if (
        (manifestConflict === undefined && conflictsPriorOpenTail) ||
        (manifestConflict?.acceptedManifestDigest === null &&
          priorOpenTail > 0 &&
          !conflictsPriorOpenTail)
      ) {
        throw new IngressRepositoryPersistenceError(
          "read-page manifest disposition conflicts with the prior open high-water",
        );
      }
      const generationAccepted =
        manifestConflict === undefined && (exactSealedGeneration || historicalOpenGeneration);
      if (!generationAccepted && manifestConflict === undefined) {
        throw new IngressRepositoryPersistenceError(
          "read-page generation is neither historical accepted evidence nor exact equivocation",
        );
      }
      if (generationAccepted) {
        const key = pairKey(page.brokerRouteId, String(page.requestedGeneration));
        const evidence = acceptedGenerationEvidence.get(key) ?? {
          maxOpenTail: 0,
          lastObservedAtMs: 0,
          firstSealedAtMs: null,
          lastOpenAtMs: null,
        };
        evidence.lastObservedAtMs = Math.max(evidence.lastObservedAtMs, page.observedAtMs);
        if (page.generationState === "open") {
          evidence.maxOpenTail = Math.max(evidence.maxOpenTail, page.observedNextFrameIndex);
          evidence.lastOpenAtMs = Math.max(evidence.lastOpenAtMs ?? 0, page.observedAtMs);
        } else {
          evidence.firstSealedAtMs = Math.min(
            evidence.firstSealedAtMs ?? Number.MAX_SAFE_INTEGER,
            page.observedAtMs,
          );
        }
        acceptedGenerationEvidence.set(key, evidence);
      }
      let firstConflict = frames.length;
      if (!generationAccepted) continue;
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index];
        if (frame === undefined) continue;
        const position = positionById.get(frame.channelPositionObservationId);
        const exactPosition =
          position !== undefined &&
          position.brokerRouteId === frame.brokerRouteId &&
          position.channelGeneration === frame.channelGeneration &&
          position.frameIndex === frame.frameIndex &&
          position.receivedFrameDigest === frame.receivedFrameDigest &&
          position.receivedFrameByteLength === frame.receivedFrameByteLength &&
          position.claimedDeliveryAttemptId === frame.claimedDeliveryAttemptId &&
          position.claimedPart === frame.claimedPart &&
          position.claimedTransportFrameDigest === frame.claimedTransportFrameDigest;
        if (
          exactPosition &&
          position.receivedFrameRef === frame.receivedFrameRef &&
          position.observedAtMs === page.observedAtMs
        ) {
          witnessedPositionEvidence.add(position.channelPositionObservationId);
        }
        if (!exactPosition) {
          firstConflict = index;
          const rawEquivocation = positionEquivocationByDigest.get(
            `${page.brokerRouteId}\u0000${frame.channelPositionObservationId}\u0000${frame.receivedFrameDigest}`,
          );
          if (rawEquivocation !== undefined) {
            const occurrenceGapId = deterministicEvidenceId(
              "gap",
              page.brokerRouteId,
              "position_equivocation",
              deterministicEvidenceId(
                "position-gap-occurrence",
                rawEquivocation.positionEquivocationId,
                page.readPageObservationId,
              ),
            );
            const occurrenceGap = gapById.get(occurrenceGapId);
            if (
              occurrenceGap?.reason !== "position_equivocation" ||
              occurrenceGap.channelPositionObservationId !== frame.channelPositionObservationId ||
              occurrenceGap.evidenceRef !== frame.receivedFrameRef ||
              occurrenceGap.evidenceDigest !== frame.receivedFrameDigest
            ) {
              throw new IngressRepositoryPersistenceError(
                "position conflict page lacks its exact occurrence gap",
              );
            }
            witnessedPositionEquivocations.add(rawEquivocation.positionEquivocationId);
            if (
              rawEquivocation.conflictingFrameRef === frame.receivedFrameRef &&
              rawEquivocation.observedAtMs === page.observedAtMs
            ) {
              witnessedPositionEquivocationFirstEvidence.add(
                rawEquivocation.positionEquivocationId,
              );
            }
            positionOccurrenceGap.set(
              occurrenceGapId,
              Object.freeze({
                equivocationId: rawEquivocation.positionEquivocationId,
                evidenceRef: frame.receivedFrameRef,
                evidenceDigest: frame.receivedFrameDigest,
                observedAtMs: page.observedAtMs,
              }),
            );
          }
          const outerClaimGap = outerPageGapDigests.has(
            `${page.brokerRouteId}\u0000${page.evidenceDigest}`,
          );
          if (
            position !== undefined &&
            position.receivedFrameDigest === frame.receivedFrameDigest &&
            (position.receivedFrameByteLength !== frame.receivedFrameByteLength ||
              position.claimedDeliveryAttemptId !== frame.claimedDeliveryAttemptId ||
              position.claimedPart !== frame.claimedPart ||
              position.claimedTransportFrameDigest !== frame.claimedTransportFrameDigest)
          ) {
            const occurrenceGapId = deterministicEvidenceId(
              "gap",
              page.brokerRouteId,
              "outer_page_invalid",
              deterministicEvidenceId(
                "outer-claim-equivocation",
                page.brokerRouteId,
                frame.channelPositionObservationId,
                frame.claimedDeliveryAttemptId,
                String(frame.claimedPart),
                frame.claimedTransportFrameDigest,
                page.readPageObservationId,
              ),
            );
            const occurrenceGap = gapById.get(occurrenceGapId);
            if (
              occurrenceGap?.reason !== "outer_page_invalid" ||
              occurrenceGap.evidenceRef !== page.evidenceRef ||
              occurrenceGap.evidenceDigest !== page.evidenceDigest
            ) {
              throw new IngressRepositoryPersistenceError(
                "outer-claim conflict page lacks its exact occurrence gap",
              );
            }
            outerOccurrenceGap.set(
              occurrenceGapId,
              Object.freeze({
                evidenceRef: page.evidenceRef,
                evidenceDigest: page.evidenceDigest,
                observedAtMs: page.observedAtMs,
              }),
            );
          }
          if (rawEquivocation === undefined && !outerClaimGap && generationAccepted) {
            throw new IngressRepositoryPersistenceError(
              "read-page first conflicting child lacks exact retained conflict evidence",
            );
          }
          break;
        }
      }
      if (generationAccepted && firstConflict === frames.length) {
        successfulReadPageCountByRoute.set(
          page.brokerRouteId,
          (successfulReadPageCountByRoute.get(page.brokerRouteId) ?? 0) + 1,
        );
        successfulReadPageUpdatedAtByRoute.set(
          page.brokerRouteId,
          Math.max(
            successfulReadPageUpdatedAtByRoute.get(page.brokerRouteId) ?? 0,
            page.observedAtMs,
          ),
        );
      }
      if (
        generationAccepted &&
        firstConflict === frames.length &&
        !(page.generationState === "open" && page.frameCountInPage === 0)
      ) {
        const key = cursorKey(
          page.brokerRouteId,
          page.requestedGeneration,
          page.requestedFrameIndex,
        );
        if (acceptedPageTransition.has(key)) {
          throw new IngressRepositoryPersistenceError(
            "accepted fetch transition has ambiguous read-page evidence",
          );
        }
        acceptedPageTransition.set(key, page);
        acceptedPageTransitionCountByRoute.set(
          page.brokerRouteId,
          (acceptedPageTransitionCountByRoute.get(page.brokerRouteId) ?? 0) + 1,
        );
      }
    }
    for (const [routeId, route] of routeScopes) {
      let generationNumber = route.genesisGeneration;
      let seededAtMs = route.createdAtMs;
      for (;;) {
        const generation = generationByKey.get(pairKey(routeId, String(generationNumber)));
        if (generation === undefined) {
          throw new IngressRepositoryPersistenceError("generation evidence chain is absent");
        }
        const evidence = acceptedGenerationEvidence.get(pairKey(routeId, String(generationNumber)));
        const expectedLastObservedAtMs = Math.max(
          seededAtMs,
          evidence?.lastObservedAtMs ?? seededAtMs,
        );
        const sealedAtMs = evidence?.firstSealedAtMs ?? null;
        if (
          generation.firstObservedAtMs !== seededAtMs ||
          generation.lastObservedAtMs !== expectedLastObservedAtMs ||
          (generation.state === "open" &&
            (sealedAtMs !== null ||
              generation.observedNextFrameIndex !== (evidence?.maxOpenTail ?? 0))) ||
          (generation.state === "sealed" &&
            (sealedAtMs === null ||
              generation.observedNextFrameIndex !== generation.frameCount ||
              (evidence?.maxOpenTail ?? 0) > (generation.frameCount as number) ||
              (evidence?.lastOpenAtMs ?? 0) > sealedAtMs))
        ) {
          throw new IngressRepositoryPersistenceError(
            "generation head is not exactly reconstructed from accepted read pages",
          );
        }
        if (generation.state === "open") break;
        seededAtMs = sealedAtMs as number;
        generationNumber = generation.nextGeneration as number;
      }
    }
    validateRouteCursors();
    for (const position of snapshot.positions) {
      if (!witnessedPositionEvidence.has(position.channelPositionObservationId)) {
        throw new IngressRepositoryPersistenceError(
          "channel position lacks its exact first read-page evidence reference",
        );
      }
    }
    for (const frame of snapshot.readPageFrameEvidence) {
      verifyAndScrub(
        frame.receivedFrameRef,
        frame.collaborationServerId,
        frame.brokerRouteId,
        frame.receivedFrameDigest,
        [A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID],
        frame.receivedFrameByteLength,
      );
    }
    for (const equivocation of snapshot.positionEquivocations) {
      const position = positionById.get(equivocation.channelPositionObservationId);
      const expectedId = deterministicEvidenceId(
        "position-equivocation",
        equivocation.brokerRouteId,
        equivocation.channelPositionObservationId,
        equivocation.acceptedFrameDigest,
        equivocation.conflictingFrameDigest,
      );
      if (
        position === undefined ||
        position.receivedFrameDigest !== equivocation.acceptedFrameDigest ||
        equivocation.acceptedFrameDigest === equivocation.conflictingFrameDigest ||
        expectedId !== equivocation.positionEquivocationId
      ) {
        throw new IngressRepositoryPersistenceError("position equivocation is not exact");
      }
      if (!witnessedPositionEquivocations.has(equivocation.positionEquivocationId)) {
        throw new IngressRepositoryPersistenceError(
          "position equivocation lacks an exact retained read-page witness",
        );
      }
      if (!witnessedPositionEquivocationFirstEvidence.has(equivocation.positionEquivocationId)) {
        throw new IngressRepositoryPersistenceError(
          "position equivocation lacks its exact immutable first evidence occurrence",
        );
      }
      verifyAndScrub(
        equivocation.conflictingFrameRef,
        equivocation.collaborationServerId,
        equivocation.brokerRouteId,
        equivocation.conflictingFrameDigest,
        [A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID],
      );
    }
    for (const equivocation of snapshot.manifestEquivocations) {
      const retainedGeneration = generationByKey.get(
        pairKey(equivocation.brokerRouteId, String(equivocation.channelGeneration)),
      );
      const page = pageByManifestEvidence.get(
        `${equivocation.brokerRouteId}\u0000${equivocation.channelGeneration}\u0000${equivocation.evidenceRef}\u0000${equivocation.evidenceDigest}\u0000${equivocation.observedAtMs}`,
      );
      const writer = new CanonicalWriter();
      let observationPreimage: Uint8Array | null = null;
      try {
        writer.str("remote-claw/a1/generation-observation/v1");
        writer.str(equivocation.brokerRouteId);
        writer.uint(equivocation.channelGeneration);
        writer.str(equivocation.conflictingState);
        writer.uint(page?.observedNextFrameIndex ?? 0);
        writer.optionalUint(equivocation.conflictingFrameCount);
        writer.optionalUint(equivocation.conflictingNextGeneration);
        writer.optionalStr(equivocation.conflictingManifestDigest);
        observationPreimage = writer.finish();
        const observationDigest = digest(observationPreimage);
        const expectedId = deterministicEvidenceId(
          "manifest-equivocation",
          equivocation.brokerRouteId,
          String(equivocation.channelGeneration),
          equivocation.acceptedManifestDigest ?? "open",
          observationDigest,
        );
        if (
          page === undefined ||
          retainedGeneration === undefined ||
          observationDigest !== equivocation.conflictingObservationDigest ||
          expectedId !== equivocation.manifestEquivocationId ||
          page.generationState !== equivocation.conflictingState ||
          page.generationFrameCount !== equivocation.conflictingFrameCount ||
          page.generationNextGeneration !== equivocation.conflictingNextGeneration ||
          page.generationManifestDigest !== equivocation.conflictingManifestDigest ||
          (equivocation.acceptedManifestDigest !== null
            ? retainedGeneration.manifestDigest !== equivocation.acceptedManifestDigest
            : !(
                (equivocation.conflictingState === "open" &&
                  (page?.observedNextFrameIndex ?? Number.MAX_SAFE_INTEGER) <
                    retainedGeneration.observedNextFrameIndex) ||
                (equivocation.conflictingState === "sealed" &&
                  equivocation.conflictingFrameCount !== null &&
                  equivocation.conflictingFrameCount < retainedGeneration.observedNextFrameIndex)
              ))
        ) {
          throw new IngressRepositoryPersistenceError(
            "manifest equivocation identity or conflicting observation does not recompute",
          );
        }
      } finally {
        observationPreimage?.fill(0);
        writer.destroy();
      }
      verifyAndScrub(
        equivocation.evidenceRef,
        equivocation.collaborationServerId,
        equivocation.brokerRouteId,
        equivocation.evidenceDigest,
        [A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID],
      );
    }
    for (const collision of snapshot.transportCollisions) {
      const original = positionByCursor.get(
        cursorKey(
          collision.brokerRouteId,
          collision.originalChannelGeneration,
          collision.originalFrameIndex,
        ),
      );
      const expectedCollisionId = deterministicEvidenceId(
        "transport-collision",
        collision.brokerRouteId,
        collision.deliveryAttemptId,
        String(collision.part),
        collision.originalTransportFrameDigest,
        collision.conflictingTransportFrameDigest,
      );
      const firstTransportPosition = firstTransportPositionByKey.get(
        `${collision.brokerRouteId}\u0000${collision.deliveryAttemptId}\u0000${collision.part}`,
      );
      if (
        original === undefined ||
        firstTransportPosition !== original ||
        original.deliveryAttemptId !== collision.deliveryAttemptId ||
        original.part !== collision.part ||
        original.normalizedTransportFrameDigest !== collision.originalTransportFrameDigest ||
        collision.originalTransportFrameDigest === collision.conflictingTransportFrameDigest ||
        expectedCollisionId !== collision.transportKeyCollisionId
      ) {
        throw new IngressRepositoryPersistenceError("transport collision origin is not exact");
      }
      const conflictingRaw = verifyAllowedArtifact(
        collision.conflictingFrameRef,
        collision.collaborationServerId,
        collision.brokerRouteId,
        collision.conflictingFrameDigest,
        [A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID],
      );
      let conflictingNormalized: Uint8Array | null = null;
      try {
        const conflictingFrame = parseA1EncryptedFrameV2(conflictingRaw);
        conflictingNormalized = normalizedA1TransportFrameBytes(conflictingFrame);
        const collisionGaps = gapsByTransportCollision.get(collision.transportKeyCollisionId) ?? [];
        const collisionOccurrenceExact = collisionGaps.some((gap) => {
          const observations = observationsByGap.get(gap.gapId) ?? [];
          return observations.some((observation) => {
            const position = positionById.get(observation.channelPositionObservationId);
            return (
              observation.disposition === "collision" &&
              observation.deliveryAttemptId === collision.deliveryAttemptId &&
              observation.part === collision.part &&
              position?.receivedFrameRef === collision.conflictingFrameRef &&
              position.receivedFrameDigest === collision.conflictingFrameDigest &&
              position.classifiedAtMs === collision.observedAtMs &&
              gap.openedAtMs === collision.observedAtMs &&
              gap.evidenceRef === position.receivedFrameRef &&
              gap.evidenceDigest === position.receivedFrameDigest
            );
          });
        });
        let conflictingRouteMatches = true;
        try {
          const scope = routeScopes.get(collision.brokerRouteId)?.scope;
          if (scope === undefined) throw new Error("collision route is absent");
          assertA1FrameMatchesRoute(
            conflictingFrame,
            scope.routeKind === "chat"
              ? {
                  routeKind: "chat",
                  identityId: Uint8Array.from(Buffer.from(identity, "hex")),
                  collaborationServerId: scope.collaborationServerId,
                  logicalChatId: scope.logicalChatId,
                }
              : {
                  routeKind: scope.routeKind,
                  identityId: Uint8Array.from(Buffer.from(identity, "hex")),
                  collaborationServerId: scope.collaborationServerId,
                  logicalChatId: null,
                },
          );
        } catch {
          conflictingRouteMatches = false;
        }
        if (
          digest(conflictingNormalized) !== collision.conflictingTransportFrameDigest ||
          conflictingFrame.deliveryAttemptId !== collision.deliveryAttemptId ||
          conflictingFrame.part !== collision.part ||
          !conflictingRouteMatches ||
          !collisionOccurrenceExact
        ) {
          throw new IngressRepositoryPersistenceError(
            "transport collision conflicting frame does not recompute",
          );
        }
      } finally {
        conflictingNormalized?.fill(0);
        conflictingRaw.fill(0);
      }
    }
    for (const recovery of snapshot.recoveries) {
      const gap = gapById.get(recovery.gapId);
      const lease = leaseByFence.get(
        `${recovery.collaborationServerId}\u0000${recovery.coordinatorLeaseId}\u0000${recovery.coordinatorEpoch}`,
      );
      const actor = actorByRoute.get(recovery.brokerRouteId);
      const actorWasRecoveryFence =
        actor !== undefined &&
        actor.claimedAtMs !== null &&
        actor.claimedAtMs <= recovery.decidedAtMs &&
        actor.updatedAtMs >= recovery.decidedAtMs &&
        actor.coordinatorLeaseId === recovery.coordinatorLeaseId &&
        actor.coordinatorEpoch === recovery.coordinatorEpoch;
      const actorIsLaterEvidence =
        actor !== undefined &&
        actor.updatedAtMs >= recovery.decidedAtMs &&
        (actor.claimedAtMs === null ||
          actor.claimedAtMs > recovery.decidedAtMs ||
          (actor.coordinatorEpoch ?? 0) > recovery.coordinatorEpoch);
      if (
        gap === undefined ||
        gap.state !== "resolved" ||
        gap.recoveryId !== recovery.recoveryId ||
        gap.reason !== recovery.reason ||
        gap.resolvedAtMs !== recovery.decidedAtMs ||
        gap.openedAtMs > recovery.decidedAtMs ||
        lease === undefined ||
        lease.acquiredAtMs > recovery.decidedAtMs ||
        recovery.decidedAtMs >= lease.heartbeatDeadlineMs ||
        (lease.releasedAtMs !== null && recovery.decidedAtMs >= lease.releasedAtMs) ||
        (!actorWasRecoveryFence && !actorIsLaterEvidence) ||
        (recovery.decision === "discard_and_close_source" &&
          runtimeByRoute.get(recovery.brokerRouteId)?.state !== "closed")
      ) {
        throw new IngressRepositoryPersistenceError("gap recovery is not exact");
      }
      verifyAndScrub(
        recovery.evidenceRef,
        recovery.collaborationServerId,
        recovery.brokerRouteId,
        recovery.evidenceDigest,
        [A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID],
      );
    }
    const openGaps = new Map<string, number>();
    const targetedPositionEquivocations = new Set<string>();
    const targetedManifestEquivocations = new Set<string>();
    const targetedTransportCollisions = new Set<string>();
    for (const gap of snapshot.gaps) {
      const positionOccurrence = positionOccurrenceGap.get(gap.gapId);
      const manifestOccurrence = manifestOccurrenceGap.get(gap.gapId);
      const outerOccurrence = outerOccurrenceGap.get(gap.gapId);
      const manifestEquivocation =
        gap.manifestEquivocationId === null
          ? undefined
          : manifestEquivocationById.get(gap.manifestEquivocationId);
      const transportCollision =
        gap.transportKeyCollisionId === null
          ? undefined
          : transportCollisionById.get(gap.transportKeyCollisionId);
      const gapObservations = observationsByGap.get(gap.gapId) ?? [];
      const durableActor = actorByRoute.get(gap.brokerRouteId);
      const exactGapObservation = gapObservations.length === 1 ? gapObservations[0] : undefined;
      const exactGapPosition =
        exactGapObservation === undefined
          ? undefined
          : positionById.get(exactGapObservation.channelPositionObservationId);
      const directlyTargetedPosition =
        gap.channelPositionObservationId === null
          ? undefined
          : positionById.get(gap.channelPositionObservationId);
      const terminalGapExpectedId =
        (gap.reason === "unknown_outbound" || gap.reason === "invalid_frame") &&
        gap.channelPositionObservationId !== null
          ? deterministicEvidenceId(
              "gap",
              gap.brokerRouteId,
              gap.reason,
              gap.channelPositionObservationId,
            )
          : null;
      const terminalGapPositionExact =
        directlyTargetedPosition !== undefined &&
        directlyTargetedPosition.brokerRouteId === gap.brokerRouteId &&
        directlyTargetedPosition.gapId === gap.gapId &&
        directlyTargetedPosition.classifiedAtMs === gap.openedAtMs &&
        (gap.reason === "unknown_outbound"
          ? directlyTargetedPosition.classification === "unknown_outbound" &&
            exactGapObservation === undefined &&
            (gap.state === "open"
              ? directlyTargetedPosition.cursorDisposition === "blocked" &&
                directlyTargetedPosition.recoveryId === null
              : directlyTargetedPosition.cursorDisposition === "advanceable" &&
                directlyTargetedPosition.recoveryId === gap.recoveryId)
          : gap.reason === "invalid_frame" &&
            ((directlyTargetedPosition.classification === "invalid" &&
              exactGapObservation === undefined &&
              directlyTargetedPosition.cursorDisposition === "advanceable" &&
              directlyTargetedPosition.recoveryId === null) ||
              (directlyTargetedPosition.classification === "inbound_ingress" &&
                exactGapObservation?.disposition === "invalid_payload" &&
                exactGapObservation.gapId === gap.gapId &&
                exactGapObservation.cursorDisposition === "advanceable" &&
                exactGapObservation.recoveryId === null &&
                gap.evidenceRef === directlyTargetedPosition.receivedFrameRef &&
                gap.evidenceDigest === directlyTargetedPosition.receivedFrameDigest)));
      const targetExact =
        (gap.reason === "position_equivocation" &&
          positionOccurrence !== undefined &&
          positionOccurrence.observedAtMs === gap.openedAtMs &&
          positionEquivocationById.get(positionOccurrence.equivocationId)?.observedAtMs ===
            gap.openedAtMs &&
          positionOccurrence.evidenceRef === gap.evidenceRef &&
          positionOccurrence.evidenceDigest === gap.evidenceDigest &&
          positionEquivocationById.get(positionOccurrence.equivocationId)
            ?.channelPositionObservationId === gap.channelPositionObservationId) ||
        (gap.reason === "manifest_equivocation" &&
          manifestOccurrence !== undefined &&
          manifestOccurrence.observedAtMs === gap.openedAtMs &&
          manifestEquivocation?.observedAtMs === gap.openedAtMs &&
          manifestOccurrence.equivocationId === gap.manifestEquivocationId &&
          manifestOccurrence.evidenceRef === gap.evidenceRef &&
          manifestOccurrence.evidenceDigest === gap.evidenceDigest &&
          manifestEquivocation?.channelGeneration === gap.channelGeneration &&
          manifestEquivocation.conflictingObservationDigest ===
            manifestEquivocationById.get(manifestOccurrence.equivocationId)
              ?.conflictingObservationDigest) ||
        (gap.reason === "transport_collision" &&
          transportCollision?.brokerRouteId === gap.brokerRouteId &&
          transportCollision.conflictingFrameDigest === gap.evidenceDigest &&
          exactGapPosition?.classifiedAtMs === gap.openedAtMs &&
          exactGapPosition?.receivedFrameRef === gap.evidenceRef &&
          exactGapPosition.receivedFrameDigest === gap.evidenceDigest) ||
        (gap.reason === "semantic_collision" &&
          gap.stableSemanticResultId !== null &&
          resultById.get(gap.stableSemanticResultId)?.brokerRouteId === gap.brokerRouteId &&
          exactGapObservation?.stableSemanticResultId === gap.stableSemanticResultId &&
          exactGapPosition?.classifiedAtMs === gap.openedAtMs &&
          exactGapPosition?.receivedFrameRef === gap.evidenceRef &&
          exactGapPosition.receivedFrameDigest === gap.evidenceDigest) ||
        ((gap.reason === "unknown_outbound" || gap.reason === "invalid_frame") &&
          terminalGapPositionExact) ||
        gap.reason === "storage_quota" ||
        (gap.reason === "outer_page_invalid" &&
          ((outerOccurrence?.evidenceRef === gap.evidenceRef &&
            outerOccurrence.evidenceDigest === gap.evidenceDigest &&
            outerOccurrence.observedAtMs === gap.openedAtMs) ||
            pagesByEvidenceRef.get(gap.evidenceRef) === undefined));
      const expectedGapId =
        gap.reason === "position_equivocation" && positionOccurrence !== undefined
          ? gap.gapId
          : gap.reason === "manifest_equivocation" && manifestOccurrence !== undefined
            ? gap.gapId
            : gap.reason === "outer_page_invalid" && outerOccurrence !== undefined
              ? gap.gapId
              : gap.reason === "transport_collision" &&
                  transportCollision !== undefined &&
                  exactGapObservation !== undefined
                ? deterministicEvidenceId(
                    "gap",
                    gap.brokerRouteId,
                    gap.reason,
                    deterministicEvidenceId(
                      "transport-gap-position",
                      transportCollision.transportKeyCollisionId,
                      exactGapObservation.channelPositionObservationId,
                    ),
                  )
                : gap.reason === "semantic_collision" && exactGapObservation !== undefined
                  ? deterministicEvidenceId(
                      "gap",
                      gap.brokerRouteId,
                      gap.reason,
                      deterministicEvidenceId(
                        "semantic-gap-position",
                        exactGapObservation.deliveryAttemptId,
                        exactGapObservation.channelPositionObservationId,
                      ),
                    )
                  : terminalGapExpectedId !== null
                    ? terminalGapExpectedId
                    : null;
      if (
        !targetExact ||
        durableActor === undefined ||
        gap.openedAtMs > durableActor.updatedAtMs ||
        (gap.resolvedAtMs !== null && gap.resolvedAtMs > durableActor.updatedAtMs)
      ) {
        throw new IngressRepositoryPersistenceError("route gap target closure is invalid");
      }
      if (expectedGapId !== null && expectedGapId !== gap.gapId) {
        throw new IngressRepositoryPersistenceError("route gap identity does not recompute");
      }
      if (gap.manifestEquivocationId !== null)
        targetedManifestEquivocations.add(gap.manifestEquivocationId);
      if (gap.transportKeyCollisionId !== null)
        targetedTransportCollisions.add(gap.transportKeyCollisionId);
      if (gap.reason === "position_equivocation") {
        if (positionOccurrence !== undefined)
          targetedPositionEquivocations.add(positionOccurrence.equivocationId);
      }
      const schemas =
        gap.reason === "manifest_equivocation"
          ? [A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID]
          : gap.reason === "invalid_frame"
            ? [A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID, A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID]
            : gap.reason === "outer_page_invalid"
              ? [
                  A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
                  A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
                ]
              : gap.reason === "semantic_collision" ||
                  gap.reason === "position_equivocation" ||
                  gap.reason === "transport_collision"
                ? [A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID]
                : [A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID];
      const artifactMetadata = sqlGet(
        transaction,
        `SELECT artifact_schema_id FROM protected_artifacts
          WHERE protected_handle_id=? LIMIT 1`,
        [gap.evidenceRef],
      );
      const artifactSchema =
        artifactMetadata === undefined
          ? null
          : String(mappedRow(artifactMetadata, "gapArtifactSchema").artifactSchemaId);
      const routeScope = routeScopes.get(gap.brokerRouteId)?.scope;
      if (
        routeScope !== undefined &&
        artifactSchema === A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID
      ) {
        if (gap.reason === "unknown_outbound" && directlyTargetedPosition !== undefined) {
          verifyCanonicalGapEvidence(
            transaction,
            gap.evidenceRef,
            routeScope,
            gap.evidenceDigest,
            parseA1SafeId("unknown_outbound"),
            directlyTargetedPosition.channelPositionObservationId,
            "null",
          );
        } else if (
          gap.reason === "invalid_frame" &&
          directlyTargetedPosition?.classification === "invalid" &&
          directlyTargetedPosition.validationFailureCode !== null
        ) {
          verifyCanonicalGapEvidence(
            transaction,
            gap.evidenceRef,
            routeScope,
            gap.evidenceDigest,
            directlyTargetedPosition.validationFailureCode,
            directlyTargetedPosition.channelPositionObservationId,
            "null",
          );
        } else if (gap.reason === "storage_quota") {
          verifyCanonicalGapEvidence(
            transaction,
            gap.evidenceRef,
            routeScope,
            gap.evidenceDigest,
            parseA1SafeId("storage_quota"),
            null,
            "null",
          );
        } else if (gap.reason === "outer_page_invalid") {
          verifyCanonicalGapEvidence(
            transaction,
            gap.evidenceRef,
            routeScope,
            gap.evidenceDigest,
            null,
            null,
            "present",
          );
        }
      }
      verifyAndScrub(
        gap.evidenceRef,
        gap.collaborationServerId,
        gap.brokerRouteId,
        gap.evidenceDigest,
        schemas,
      );
      if (gap.state === "open") {
        openGaps.set(gap.brokerRouteId, (openGaps.get(gap.brokerRouteId) ?? 0) + 1);
      } else if (recoveryByGap.get(gap.gapId)?.recoveryId !== gap.recoveryId) {
        throw new IngressRepositoryPersistenceError("resolved gap lacks its unique recovery");
      }
    }
    if (
      targetedPositionEquivocations.size !== snapshot.positionEquivocations.length ||
      targetedManifestEquivocations.size !== snapshot.manifestEquivocations.length ||
      targetedTransportCollisions.size !== snapshot.transportCollisions.length
    ) {
      throw new IngressRepositoryPersistenceError(
        "equivocation/collision evidence lacks its exact durable gap",
      );
    }
    const expectedRuntimeUpdatedAt = new Map<string, number>();
    for (const [routeId, route] of routeScopes) {
      expectedRuntimeUpdatedAt.set(routeId, route.createdAtMs);
    }
    for (const generation of snapshot.generationObservations) {
      if (
        generation.channelGeneration !==
        routeScopes.get(generation.brokerRouteId)?.genesisGeneration
      ) {
        expectedRuntimeUpdatedAt.set(
          generation.brokerRouteId,
          Math.max(
            expectedRuntimeUpdatedAt.get(generation.brokerRouteId) ?? 0,
            generation.firstObservedAtMs,
          ),
        );
      }
    }
    for (const gap of snapshot.gaps) {
      expectedRuntimeUpdatedAt.set(
        gap.brokerRouteId,
        Math.max(
          expectedRuntimeUpdatedAt.get(gap.brokerRouteId) ?? 0,
          gap.openedAtMs,
          gap.resolvedAtMs ?? 0,
        ),
      );
    }
    for (const runtime of snapshot.runtimeStatuses) {
      const count = openGaps.get(runtime.brokerRouteId) ?? 0;
      const route = routeScopes.get(runtime.brokerRouteId);
      if (
        route === undefined ||
        runtime.activeGapCount !== count ||
        runtime.updatedAtMs !== expectedRuntimeUpdatedAt.get(runtime.brokerRouteId) ||
        (count > 0 && runtime.state !== "quarantined") ||
        (count === 0 && runtime.state === "quarantined")
      ) {
        throw new IngressRepositoryPersistenceError("runtime active-gap closure is inconsistent");
      }
    }

    const actorOperationKinds = new Set([
      "claim",
      "release",
      "outer_page_gap",
      "storage_quota_gap",
      "stage_page",
      "classify_invalid",
      "classify_unknown",
      "classify_inbound",
      "expire_result",
      "recover_gap",
      "recompute_cursor",
    ]);
    const latestMutationAtByRoute = new Map<string, number>();
    for (const [routeId, route] of routeScopes) {
      latestMutationAtByRoute.set(routeId, route.createdAtMs);
    }
    const retainMutationTime = (routeId: string, ...times: readonly (number | null)[]): void => {
      latestMutationAtByRoute.set(
        routeId,
        Math.max(latestMutationAtByRoute.get(routeId) ?? 0, ...times.map((time) => time ?? 0)),
      );
    };
    for (const page of snapshot.readPageObservations)
      retainMutationTime(page.brokerRouteId, page.observedAtMs);
    for (const position of snapshot.positions)
      retainMutationTime(position.brokerRouteId, position.observedAtMs, position.classifiedAtMs);
    for (const gap of snapshot.gaps)
      retainMutationTime(gap.brokerRouteId, gap.openedAtMs, gap.resolvedAtMs);
    for (const recovery of snapshot.recoveries)
      retainMutationTime(recovery.brokerRouteId, recovery.decidedAtMs);
    for (const result of snapshot.results)
      retainMutationTime(result.brokerRouteId, result.collisionAtMs, result.terminalAtMs);
    for (const runtime of snapshot.runtimeStatuses)
      retainMutationTime(runtime.brokerRouteId, runtime.updatedAtMs);
    for (const fetch of snapshot.fetchCursors)
      retainMutationTime(fetch.brokerRouteId, fetch.updatedAtMs);
    for (const semantic of snapshot.semanticCursors)
      retainMutationTime(semantic.brokerRouteId, semantic.updatedAtMs);
    for (const actor of snapshot.actors) {
      const route = routeScopes.get(actor.brokerRouteId);
      const isInitial = actor.revision === 0;
      const isReleased = actor.lastOperationKind === "release";
      const isClaimed = actor.claimToken !== null;
      const lease =
        actor.coordinatorLeaseId === null || actor.coordinatorEpoch === null
          ? undefined
          : leaseByFence.get(
              `${actor.collaborationServerId}\u0000${actor.coordinatorLeaseId}\u0000${actor.coordinatorEpoch}`,
            );
      const exactClaimDigest =
        actor.lastOperationKind === "claim" &&
        actor.claimToken !== null &&
        actor.coordinatorLeaseId !== null &&
        actor.coordinatorEpoch !== null
          ? operationDigest("claim", {
              scope: route?.scope,
              fence: {
                collaborationServerId: actor.collaborationServerId,
                coordinatorLeaseId: actor.coordinatorLeaseId,
                coordinatorEpoch: actor.coordinatorEpoch,
              },
              claimToken: actor.claimToken,
              expectedActorRevision: actor.revision - 1,
              observedAtMs: actor.updatedAtMs,
            })
          : null;
      if (
        route === undefined ||
        actor.revision >= Number.MAX_SAFE_INTEGER - 1 ||
        actor.updatedAtMs < (latestMutationAtByRoute.get(actor.brokerRouteId) ?? 0) ||
        (isInitial &&
          (actor.updatedAtMs !== route.createdAtMs ||
            actor.lastOperationId !== null ||
            actor.lastOperationKind !== null ||
            actor.lastOperationDigest !== null ||
            isClaimed)) ||
        (!isInitial &&
          (actor.lastOperationId === null ||
            actor.lastOperationKind === null ||
            actor.lastOperationDigest === null ||
            !actorOperationKinds.has(actor.lastOperationKind))) ||
        isClaimed !== (!isInitial && !isReleased) ||
        (isReleased && actor.revision < 2) ||
        (isClaimed && actor.lastOperationKind !== "claim" && actor.revision < 2) ||
        (isClaimed &&
          (lease === undefined ||
            actor.claimedAtMs === null ||
            lease.acquiredAtMs > actor.claimedAtMs ||
            actor.claimedAtMs > actor.updatedAtMs ||
            actor.updatedAtMs >= lease.heartbeatDeadlineMs)) ||
        (!isClaimed &&
          !isInitial &&
          actor.updatedAtMs >= (maxLeaseDeadlineByServer.get(actor.collaborationServerId) ?? 0)) ||
        (actor.lastOperationKind === "claim" &&
          (actor.claimedAtMs !== actor.updatedAtMs ||
            exactClaimDigest !== actor.lastOperationDigest))
      ) {
        throw new IngressRepositoryPersistenceError(
          "broker route actor head is not structurally or chronologically closed",
        );
      }
    }

    for (const value of sqlAll(
      transaction,
      `SELECT protected_handle_id FROM protected_artifacts
        WHERE artifact_schema_id IN (?, ?, ?, ?)`,
      [
        A1_INGRESS_RAW_FRAME_ARTIFACT_SCHEMA_ID,
        A1_INGRESS_PLAINTEXT_PART_ARTIFACT_SCHEMA_ID,
        A1_INGRESS_GAP_EVIDENCE_ARTIFACT_SCHEMA_ID,
        A1_INGRESS_READ_PAGE_EVIDENCE_ARTIFACT_SCHEMA_ID,
      ],
    )) {
      const ref = String(mappedRow(value, "retainedIngressArtifact").protectedHandleId);
      if (!referencedArtifacts.has(ref)) {
        throw new IngressRepositoryPersistenceError("unreferenced protected ingress artifact");
      }
    }
    const retained = retainedIngressBytes(transaction);
    const unresolvedPositionsByRoute = new Map<string, number>();
    for (const position of snapshot.positions) {
      const semantic = semanticByRoute.get(position.brokerRouteId);
      if (semantic === undefined) {
        throw new IngressRepositoryPersistenceError("position route semantic cursor is absent");
      }
      if (
        position.channelGeneration > semantic.nextGeneration ||
        (position.channelGeneration === semantic.nextGeneration &&
          position.frameIndex >= semantic.nextFrameIndex)
      ) {
        const count = (unresolvedPositionsByRoute.get(position.brokerRouteId) ?? 0) + 1;
        unresolvedPositionsByRoute.set(position.brokerRouteId, count);
        if (count > A1_INGRESS_LOOKAHEAD_MAX_FRAMES) {
          throw new IngressRepositoryPersistenceError(
            "route retains too many unresolved physical positions",
          );
        }
      }
    }
    if (
      retained.global > A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL ||
      [...retained.byRoute.values()].some(
        (bytes) => bytes > A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE,
      ) ||
      [...retained.byIdentity.values()].some(
        (bytes) => bytes > A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY,
      ) ||
      [...retained.unresolvedByRoute.values()].some(
        (bytes) => bytes > A1_INGRESS_LOOKAHEAD_MAX_BYTES,
      )
    ) {
      throw new IngressRepositoryPersistenceError("retained ingress quota closure is invalid");
    }
  } catch (error) {
    if (error instanceof IngressRepositoryPersistenceError) throw error;
    throw new IngressRepositoryPersistenceError("ingress snapshot is invalid", { cause: error });
  }
}
