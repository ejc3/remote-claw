import { createHash, createPublicKey, randomBytes as secureRandomBytes, verify } from "node:crypto";
import {
  A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID,
  A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
  A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
  A1_COMMAND_DECISION_POLICY_ID,
  A1_COMMAND_RESULT_SCHEMA_ID,
  A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
  type A1CanonicalCommandRecord,
  type A1CanonicalCommandResultPayload,
  type A1CommandDecisionEvidence,
  type A1IngressCommandSource,
  type A1UnsupportedRecognizedCommandPayload,
  base64urlDecode,
  base64urlEncode,
  canonicalA1CollaborationCommandIdPreimage,
  canonicalA1CommandDecisionEvidence,
  canonicalA1CommandPayload,
  canonicalA1CommandRecord,
  canonicalA1CommandResultPayload,
  canonicalA1CommandSourceIdentity,
  canonicalA1ResultDeliveryIdPreimage,
  canonicalA1SignedCommandResult,
  canonicalA1StoredSemanticResultPreimage,
  encodeA1RejectedActionResultPayloadV1Bytes,
  encodeA1RejectedChatCreationResultPayloadV1Bytes,
  selectA1CompletionObservation,
} from "@remote-claw/clawsec";
import { createProtectedArtifactTransactionOperations } from "./artifacts.js";
import {
  A1_COMMAND_SOURCE_KIND,
  type A1IngressAdjudicationRecord,
  type CollaborationCommandCompoundSigningGroupRecord,
  type CollaborationCommandRecord,
  type CollaborationCommandResultPreparationRecord,
  type CommandReadyEntryRecord,
  deriveCollaborationCommandCompoundSigningGroupId,
  deriveCollaborationCommandResultId,
  deriveCollaborationCommandResultPreparationId,
  parseA1IngressAdjudicationRecord,
  parseCollaborationCommandCompoundSigningGroupRecord,
  parseCollaborationCommandRecord,
  parseCollaborationCommandResultPreparationRecord,
  parseCommandReadyEntryRecord,
} from "./command-adjudication.js";
import {
  type A1IngressResultDeliveryRecord,
  type A1IngressTerminalResultRecord,
  type A1SemanticResultPayloadSchemaId,
  type A1SemanticResultRecordKind,
  type CollaborationCommandResultRecord,
  parseA1IngressResultDeliveryRecord,
  parseA1IngressTerminalResultRecord,
  parseCollaborationCommandResultRecord,
} from "./command-result-finalization.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type Ed25519PublicKey,
  type Ed25519Signature,
  HostStateContractError,
  type LogicalChatId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseEd25519Signature,
  parseMachineIdentityId,
} from "./ids.js";
import { ProtectedByteSnapshot } from "./protected.js";
import { type CoordinatorLeaseFence, parseCoordinatorLeaseFence } from "./records.js";
import type {
  HostStateRepositorySqlTransaction,
  HostStateRepositorySqlValue,
  HostStateRepositoryTransactionExecutor,
} from "./repository.js";
import {
  parseServerSignatureReservationRecord,
  parseServerSignedRecordAcceptanceRecord,
  type ServerSignatureReservationRecord,
  type ServerSignedRecordAcceptanceRecord,
} from "./server-signing.js";
import {
  frozen,
  parseExactRecord,
  parseNonNegativeSafeInteger,
  type UnknownRecord,
} from "./validation.js";

const COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE =
  "collaboration_command_result_preparation" as const;

export interface CommandAdjudicationRepositoryOptions {
  readonly nowMs?: () => number;
  readonly randomBytes?: (byteLength: number) => Uint8Array;
}

export interface MaterializeReadyA1IngressCommandRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly stableSemanticResultId: A1SafeId;
  readonly expectedReadyAtJournalSeq: number;
}

export interface ReserveRejectedCommandDecisionRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly expectedCommandId: A1SafeId;
  readonly expectedCommandSeq: number;
  readonly expectedSignerSequence: number;
  readonly expectedSigningLeaseId: A1SafeId;
}

export interface BindRejectedCommandResultPreparationRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly commandResultPreparationId: A1SafeId;
}

export interface StoreSignedRejectedCommandResultPreparationRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly commandResultPreparationId: A1SafeId;
  readonly signature: Ed25519Signature;
}

export interface FinalizeSignedRejectedCommandResultRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly expectedCommandId: A1SafeId;
  readonly expectedCommandResultId: A1SafeId;
  readonly expectedCommandResultPreparationId: A1SafeId;
  readonly expectedSignedRecordDigest: A1Digest;
  readonly expectedAcceptedAtJournalSeq: number;
}

export interface AbortRejectedCommandResultPreparationRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly commandResultPreparationId: A1SafeId;
}

export interface ReserveReplacementRejectedCommandResultPreparationRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly expectedPriorPreparationId: A1SafeId;
  readonly expectedSignerSequence: number;
  readonly expectedSigningLeaseId: A1SafeId;
}

export interface ReadyA1IngressCommandResult {
  readonly readyEntry: CommandReadyEntryRecord;
  readonly adjudication: A1IngressAdjudicationRecord;
  readonly command: CollaborationCommandRecord;
  readonly replayed: boolean;
}

export interface RejectedCommandDecisionResult {
  readonly adjudication: A1IngressAdjudicationRecord;
  readonly command: CollaborationCommandRecord;
  readonly preparation: CollaborationCommandResultPreparationRecord;
  readonly signingGroup: CollaborationCommandCompoundSigningGroupRecord;
  readonly signatureReservation: ServerSignatureReservationRecord;
  readonly canonicalPayload: ProtectedByteSnapshot;
  readonly replayed: boolean;
}

export interface RejectedCommandPreparationMutationResult {
  readonly preparation: CollaborationCommandResultPreparationRecord;
  readonly signingGroup: CollaborationCommandCompoundSigningGroupRecord;
  readonly signatureReservation: ServerSignatureReservationRecord;
  readonly replayed: boolean;
}

export interface FinalizedRejectedCommandResult {
  readonly command: CollaborationCommandRecord;
  readonly adjudication: A1IngressAdjudicationRecord;
  readonly commonResult: CollaborationCommandResultRecord;
  readonly signerAcceptance: ServerSignedRecordAcceptanceRecord;
  readonly terminalResult: A1IngressTerminalResultRecord;
  readonly resultDelivery: A1IngressResultDeliveryRecord;
  readonly replayed: boolean;
}

export interface CommandAdjudicationState {
  readonly readyEntry: CommandReadyEntryRecord;
  readonly adjudication: A1IngressAdjudicationRecord;
  readonly command: CollaborationCommandRecord;
  readonly preparation: CollaborationCommandResultPreparationRecord | null;
  readonly signingGroup: CollaborationCommandCompoundSigningGroupRecord | null;
  readonly signatureReservation: ServerSignatureReservationRecord | null;
}

export interface CommandAdjudicationRepositoryOperations {
  materializeReadyIngressCommand(
    request: MaterializeReadyA1IngressCommandRequest,
  ): ReadyA1IngressCommandResult;
  reconcileReadyIngressCommand(
    request: MaterializeReadyA1IngressCommandRequest,
  ): ReadyA1IngressCommandResult | null;
  reserveRejectedDecision(
    request: ReserveRejectedCommandDecisionRequest,
  ): RejectedCommandDecisionResult;
  reconcileRejectedDecision(
    request: ReserveRejectedCommandDecisionRequest,
  ): RejectedCommandDecisionResult | null;
  bindRejectedResultPreparation(
    request: BindRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult;
  reconcileRejectedResultPreparationBinding(
    request: BindRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult | null;
  storeSignedRejectedResultPreparation(
    request: StoreSignedRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult;
  reconcileSignedRejectedResultPreparation(
    request: StoreSignedRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult | null;
  finalizeSignedRejectedCommandResult(
    request: FinalizeSignedRejectedCommandResultRequest,
  ): FinalizedRejectedCommandResult;
  reconcileFinalizedRejectedCommandResult(
    request: FinalizeSignedRejectedCommandResultRequest,
  ): FinalizedRejectedCommandResult | null;
  abortRejectedResultPreparation(
    request: AbortRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult;
  reconcileAbortedRejectedResultPreparation(
    request: AbortRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult | null;
  reserveReplacementRejectedResultPreparation(
    request: ReserveReplacementRejectedCommandResultPreparationRequest,
  ): RejectedCommandDecisionResult;
  reconcileReplacementRejectedResultPreparation(
    request: ReserveReplacementRejectedCommandResultPreparationRequest,
  ): RejectedCommandDecisionResult | null;
  readState(stableSemanticResultId: A1SafeId): CommandAdjudicationState | null;
}

export class CommandAdjudicationRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`command adjudication repository conflict: ${message}`);
    this.name = "CommandAdjudicationRepositoryConflictError";
  }
}

export class CommandAdjudicationStaleCoordinatorError extends Error {
  constructor() {
    super("command adjudication repository stale coordinator: coordinator fence is not current");
    this.name = "CommandAdjudicationStaleCoordinatorError";
  }
}

export class CommandAdjudicationRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`command adjudication repository persistence failed: ${message}`, options);
    this.name = "CommandAdjudicationRepositoryPersistenceError";
  }
}

interface ParsedReadyRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly stableSemanticResultId: A1SafeId;
  readonly expectedReadyAtJournalSeq: number;
}

function semanticResultId(value: unknown, field: string): A1SafeId {
  const parsed = parseA1SafeId(value, field);
  if (!parsed.startsWith("rrs_") || parsed.length !== 47) {
    throw new HostStateContractError(`${field} must use the rrs_ SHA-256 namespace`);
  }
  return parsed;
}

function commandId(value: unknown, field: string): A1SafeId {
  const parsed = parseA1SafeId(value, field);
  if (!parsed.startsWith("rcm_") || parsed.length !== 47) {
    throw new HostStateContractError(`${field} must use the rcm_ SHA-256 namespace`);
  }
  return parsed;
}

function preparationId(value: unknown, field: string): A1SafeId {
  const parsed = parseA1SafeId(value, field);
  if (!parsed.startsWith("crp_") || parsed.length !== 47) {
    throw new HostStateContractError(`${field} must use the crp_ SHA-256 namespace`);
  }
  return parsed;
}

function prefixedRepositoryId(value: unknown, prefix: string, field: string): A1SafeId {
  const parsed = parseA1SafeId(value, field);
  if (!parsed.startsWith(prefix) || parsed.length !== prefix.length + 43) {
    throw new HostStateContractError(`${field} must use the ${prefix} SHA-256 namespace`);
  }
  return parsed;
}

function parseReadyRequest(value: unknown): ParsedReadyRequest {
  const row = parseExactRecord(
    value,
    ["fence", "stableSemanticResultId", "expectedReadyAtJournalSeq"] as const,
    "materializeReadyIngressCommand",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    stableSemanticResultId: semanticResultId(
      row.stableSemanticResultId,
      "materializeReadyIngressCommand.stableSemanticResultId",
    ),
    expectedReadyAtJournalSeq: parseNonNegativeSafeInteger(
      row.expectedReadyAtJournalSeq,
      "materializeReadyIngressCommand.expectedReadyAtJournalSeq",
    ),
  });
}

function parseReserveDecisionRequest(value: unknown): ReserveRejectedCommandDecisionRequest {
  const row = parseExactRecord(
    value,
    [
      "fence",
      "expectedCommandId",
      "expectedCommandSeq",
      "expectedSignerSequence",
      "expectedSigningLeaseId",
    ] as const,
    "reserveRejectedDecision",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    expectedCommandId: commandId(row.expectedCommandId, "reserveRejectedDecision.commandId"),
    expectedCommandSeq: parseNonNegativeSafeInteger(
      row.expectedCommandSeq,
      "reserveRejectedDecision.expectedCommandSeq",
    ),
    expectedSignerSequence: parseNonNegativeSafeInteger(
      row.expectedSignerSequence,
      "reserveRejectedDecision.expectedSignerSequence",
    ),
    expectedSigningLeaseId: parseA1SafeId(
      row.expectedSigningLeaseId,
      "reserveRejectedDecision.expectedSigningLeaseId",
    ),
  });
}

function parseBindRequest(value: unknown): BindRejectedCommandResultPreparationRequest {
  const row = parseExactRecord(
    value,
    ["fence", "commandResultPreparationId"] as const,
    "bindRejectedResultPreparation",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    commandResultPreparationId: preparationId(
      row.commandResultPreparationId,
      "bindRejectedResultPreparation.commandResultPreparationId",
    ),
  });
}

function parseStoreSignedRequest(
  value: unknown,
): StoreSignedRejectedCommandResultPreparationRequest {
  const row = parseExactRecord(
    value,
    ["fence", "commandResultPreparationId", "signature"] as const,
    "storeSignedRejectedResultPreparation",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    commandResultPreparationId: preparationId(
      row.commandResultPreparationId,
      "storeSignedRejectedResultPreparation.commandResultPreparationId",
    ),
    signature: parseEd25519Signature(
      row.signature,
      "storeSignedRejectedResultPreparation.signature",
    ),
  });
}

function parseFinalizeRequest(value: unknown): FinalizeSignedRejectedCommandResultRequest {
  const row = parseExactRecord(
    value,
    [
      "fence",
      "expectedCommandId",
      "expectedCommandResultId",
      "expectedCommandResultPreparationId",
      "expectedSignedRecordDigest",
      "expectedAcceptedAtJournalSeq",
    ] as const,
    "finalizeSignedRejectedCommandResult",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    expectedCommandId: commandId(
      row.expectedCommandId,
      "finalizeSignedRejectedCommandResult.expectedCommandId",
    ),
    expectedCommandResultId: prefixedRepositoryId(
      row.expectedCommandResultId,
      "ccr_",
      "finalizeSignedRejectedCommandResult.expectedCommandResultId",
    ),
    expectedCommandResultPreparationId: preparationId(
      row.expectedCommandResultPreparationId,
      "finalizeSignedRejectedCommandResult.expectedCommandResultPreparationId",
    ),
    expectedSignedRecordDigest: parseA1Digest(
      row.expectedSignedRecordDigest,
      "finalizeSignedRejectedCommandResult.expectedSignedRecordDigest",
    ),
    expectedAcceptedAtJournalSeq: parseNonNegativeSafeInteger(
      row.expectedAcceptedAtJournalSeq,
      "finalizeSignedRejectedCommandResult.expectedAcceptedAtJournalSeq",
    ),
  });
}

function parseAbortRequest(value: unknown): AbortRejectedCommandResultPreparationRequest {
  const row = parseExactRecord(
    value,
    ["fence", "commandResultPreparationId"] as const,
    "abortRejectedResultPreparation",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    commandResultPreparationId: preparationId(
      row.commandResultPreparationId,
      "abortRejectedResultPreparation.commandResultPreparationId",
    ),
  });
}

function parseReplacementRequest(
  value: unknown,
): ReserveReplacementRejectedCommandResultPreparationRequest {
  const row = parseExactRecord(
    value,
    [
      "fence",
      "expectedPriorPreparationId",
      "expectedSignerSequence",
      "expectedSigningLeaseId",
    ] as const,
    "reserveReplacementRejectedResultPreparation",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    expectedPriorPreparationId: preparationId(
      row.expectedPriorPreparationId,
      "reserveReplacementRejectedResultPreparation.expectedPriorPreparationId",
    ),
    expectedSignerSequence: parseNonNegativeSafeInteger(
      row.expectedSignerSequence,
      "reserveReplacementRejectedResultPreparation.expectedSignerSequence",
    ),
    expectedSigningLeaseId: parseA1SafeId(
      row.expectedSigningLeaseId,
      "reserveReplacementRejectedResultPreparation.expectedSigningLeaseId",
    ),
  });
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
      error instanceof CommandAdjudicationRepositoryConflictError ||
      error instanceof CommandAdjudicationStaleCoordinatorError ||
      error instanceof CommandAdjudicationRepositoryPersistenceError ||
      error instanceof HostStateContractError
    ) {
      throw error;
    }
    throw new CommandAdjudicationRepositoryPersistenceError("SQL read did not complete", {
      cause: error,
    });
  }
}

function sqlAll(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): unknown[] {
  try {
    if (transaction.all === undefined) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "SQL transaction does not support inventory reads",
      );
    }
    return Array.from(transaction.all(sql, parameters));
  } catch (error) {
    if (
      error instanceof CommandAdjudicationRepositoryConflictError ||
      error instanceof CommandAdjudicationStaleCoordinatorError ||
      error instanceof CommandAdjudicationRepositoryPersistenceError ||
      error instanceof HostStateContractError
    ) {
      throw error;
    }
    throw new CommandAdjudicationRepositoryPersistenceError("SQL read did not complete", {
      cause: error,
    });
  }
}

function sqlRun(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
): number {
  try {
    const changes = transaction.run(sql, parameters).changes;
    const numeric = typeof changes === "bigint" ? Number(changes) : changes;
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "SQL write returned an invalid change count",
      );
    }
    return numeric;
  } catch (error) {
    if (
      error instanceof CommandAdjudicationRepositoryConflictError ||
      error instanceof CommandAdjudicationStaleCoordinatorError ||
      error instanceof CommandAdjudicationRepositoryPersistenceError ||
      error instanceof HostStateContractError
    ) {
      throw error;
    }
    throw new CommandAdjudicationRepositoryPersistenceError("SQL write did not complete", {
      cause: error,
    });
  }
}

function runExactlyOne(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
  operation: string,
): void {
  if (sqlRun(transaction, sql, parameters) !== 1) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      `${operation} did not affect exactly one row`,
    );
  }
}

function rawRow(value: unknown, keys: readonly string[], field: string): UnknownRecord {
  try {
    return parseExactRecord(value, keys, field);
  } catch (error) {
    throw new CommandAdjudicationRepositoryPersistenceError(`${field} row is absent or invalid`, {
      cause: error,
    });
  }
}

function digestBytes(bytes: Uint8Array): A1Digest {
  return parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
}

function allocateA1DeliveryAttemptId(
  randomBytes: ((byteLength: number) => Uint8Array) | undefined,
): A1SafeId {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from((randomBytes ?? secureRandomBytes)(16));
  } catch {
    throw new HostStateContractError(
      "command adjudication randomBytes failed to allocate a delivery attempt",
    );
  }
  try {
    if (bytes.byteLength !== 16) {
      throw new HostStateContractError(
        "command adjudication randomBytes must return exactly the requested byte length",
      );
    }
    return parseA1SafeId(`rda_${base64urlEncode(bytes)}`, "resultDelivery.deliveryAttemptId");
  } finally {
    bytes.fill(0);
  }
}

function artifactTransaction(transaction: HostStateRepositorySqlTransaction) {
  return {
    get: (sql: string, parameters: readonly HostStateRepositorySqlValue[]) =>
      transaction.get(sql, parameters),
    run: (sql: string, parameters: readonly HostStateRepositorySqlValue[]) => ({
      changes: sqlRun(transaction, sql, parameters),
    }),
  };
}

const READY_ROW_KEYS = [
  "collaboration_server_id",
  "ready_at_journal_seq",
  "command_id",
  "stable_semantic_result_id",
  "coordinator_lease_id",
  "coordinator_epoch",
  "ready_at_ms",
] as const;

function readyFromRow(value: unknown): CommandReadyEntryRecord {
  const row = rawRow(value, READY_ROW_KEYS, "commandReadyEntry");
  return parseCommandReadyEntryRecord({
    collaborationServerId: row.collaboration_server_id,
    readyAtJournalSeq: row.ready_at_journal_seq,
    commandId: row.command_id,
    stableSemanticResultId: row.stable_semantic_result_id,
    coordinatorLeaseId: row.coordinator_lease_id,
    coordinatorEpoch: row.coordinator_epoch,
    readyAtMs: row.ready_at_ms,
  });
}

const ADJUDICATION_ROW_KEYS = [
  "stable_semantic_result_id",
  "collaboration_server_id",
  "command_id",
  "ready_at_journal_seq",
  "command_seq",
  "disposition",
  "command_result_id",
  "command_result_preparation_id",
  "state",
  "decided_at_ms",
] as const;

function adjudicationFromRow(value: unknown): A1IngressAdjudicationRecord {
  const row = rawRow(value, ADJUDICATION_ROW_KEYS, "a1IngressAdjudication");
  return parseA1IngressAdjudicationRecord({
    stableSemanticResultId: row.stable_semantic_result_id,
    collaborationServerId: row.collaboration_server_id,
    commandId: row.command_id,
    readyAtJournalSeq: row.ready_at_journal_seq,
    commandSeq: row.command_seq,
    disposition: row.disposition,
    commandResultId: row.command_result_id,
    commandResultPreparationId: row.command_result_preparation_id,
    state: row.state,
    decidedAtMs: row.decided_at_ms,
  });
}

const COMMAND_ROW_KEYS = [
  "command_id",
  "collaboration_server_id",
  "scope_kind",
  "logical_chat_id",
  "target_logical_chat_id",
  "source_kind",
  "source_ref",
  "source_event_namespace_id",
  "source_event_id",
  "source_command_identity_digest",
  "canonical_source_event_digest",
  "mutation_family",
  "canonical_command_payload_schema_id",
  "canonical_command_payload_ref",
  "canonical_command_payload_digest",
  "pre_decision_normalization_evidence_schema_id",
  "pre_decision_normalization_evidence_ref",
  "pre_decision_normalization_evidence_digest",
  "ready_at_journal_seq",
  "command_seq",
  "disposition",
  "admitted_target_kind",
  "selected_executor_evidence_schema_id",
  "selected_executor_evidence_ref",
  "selected_executor_evidence_digest",
  "target_capability_snapshot_id",
  "target_capability_family_digest",
  "current_command_result_id",
  "decision_evidence_schema_id",
  "decision_evidence_ref",
  "decision_evidence_digest",
  "canonical_command_record_digest",
  "coordinator_lease_id",
  "coordinator_epoch",
  "decision_coordinator_lease_id",
  "decision_coordinator_epoch",
  "created_at_ms",
  "decided_at_ms",
  "state",
] as const;

function commandFromRow(value: unknown): CollaborationCommandRecord {
  const row = rawRow(value, COMMAND_ROW_KEYS, "collaborationCommand");
  return parseCollaborationCommandRecord({
    commandId: row.command_id,
    collaborationServerId: row.collaboration_server_id,
    scopeKind: row.scope_kind,
    logicalChatId: row.logical_chat_id,
    targetLogicalChatId: row.target_logical_chat_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    sourceEventNamespaceId: row.source_event_namespace_id,
    sourceEventId: row.source_event_id,
    sourceCommandIdentityDigest: row.source_command_identity_digest,
    canonicalSourceEventDigest: row.canonical_source_event_digest,
    mutationFamily: row.mutation_family,
    canonicalCommandPayloadSchemaId: row.canonical_command_payload_schema_id,
    canonicalCommandPayloadRef: row.canonical_command_payload_ref,
    canonicalCommandPayloadDigest: row.canonical_command_payload_digest,
    preDecisionNormalizationEvidenceSchemaId: row.pre_decision_normalization_evidence_schema_id,
    preDecisionNormalizationEvidenceRef: row.pre_decision_normalization_evidence_ref,
    preDecisionNormalizationEvidenceDigest: row.pre_decision_normalization_evidence_digest,
    readyAtJournalSeq: row.ready_at_journal_seq,
    commandSeq: row.command_seq,
    disposition: row.disposition,
    admittedTargetKind: row.admitted_target_kind,
    selectedExecutorEvidenceSchemaId: row.selected_executor_evidence_schema_id,
    selectedExecutorEvidenceRef: row.selected_executor_evidence_ref,
    selectedExecutorEvidenceDigest: row.selected_executor_evidence_digest,
    targetCapabilitySnapshotId: row.target_capability_snapshot_id,
    targetCapabilityFamilyDigest: row.target_capability_family_digest,
    currentCommandResultId: row.current_command_result_id,
    decisionEvidenceSchemaId: row.decision_evidence_schema_id,
    decisionEvidenceRef: row.decision_evidence_ref,
    decisionEvidenceDigest: row.decision_evidence_digest,
    canonicalCommandRecordDigest: row.canonical_command_record_digest,
    coordinatorLeaseId: row.coordinator_lease_id,
    coordinatorEpoch: row.coordinator_epoch,
    decisionCoordinatorLeaseId: row.decision_coordinator_lease_id,
    decisionCoordinatorEpoch: row.decision_coordinator_epoch,
    createdAtMs: row.created_at_ms,
    decidedAtMs: row.decided_at_ms,
    state: row.state,
  });
}

const PREPARATION_ROW_KEYS = [
  "command_result_preparation_id",
  "command_result_id",
  "collaboration_server_id",
  "command_id",
  "canonical_command_record_digest",
  "result_version",
  "preparation_generation",
  "supersedes_preparation_ref",
  "canonical_payload_ref",
  "canonical_payload_digest",
  "signer_sequence",
  "signing_lease_id",
  "compound_signing_group_id",
  "required_finalization_artifact_kind",
  "current_finalization_artifact_preparation_ref",
  "prepared_at_ms",
  "bound_at_ms",
  "signed_at_ms",
  "aborted_at_ms",
  "state",
] as const;

function preparationFromRow(value: unknown): CollaborationCommandResultPreparationRecord {
  const row = rawRow(value, PREPARATION_ROW_KEYS, "commandResultPreparation");
  return parseCollaborationCommandResultPreparationRecord({
    commandResultPreparationId: row.command_result_preparation_id,
    commandResultId: row.command_result_id,
    collaborationServerId: row.collaboration_server_id,
    commandId: row.command_id,
    canonicalCommandRecordDigest: row.canonical_command_record_digest,
    resultVersion: row.result_version,
    preparationGeneration: row.preparation_generation,
    supersedesPreparationRef: row.supersedes_preparation_ref,
    canonicalPayloadRef: row.canonical_payload_ref,
    canonicalPayloadDigest: row.canonical_payload_digest,
    signerSequence: row.signer_sequence,
    signingLeaseId: row.signing_lease_id,
    compoundSigningGroupId: row.compound_signing_group_id,
    requiredFinalizationArtifactKind: row.required_finalization_artifact_kind,
    currentFinalizationArtifactPreparationRef: row.current_finalization_artifact_preparation_ref,
    preparedAtMs: row.prepared_at_ms,
    boundAtMs: row.bound_at_ms,
    signedAtMs: row.signed_at_ms,
    abortedAtMs: row.aborted_at_ms,
    state: row.state,
  });
}

const GROUP_ROW_KEYS = [
  "compound_signing_group_id",
  "collaboration_server_id",
  "command_id",
  "command_result_id",
  "preparation_generation",
  "signing_lease_id",
  "result_preparation_ref",
  "required_finalization_artifact_kind",
  "secondary_preparation_ref",
  "reserved_at_ms",
  "result_signed_at_ms",
  "both_signed_at_ms",
  "finalized_at_ms",
  "aborted_at_ms",
  "state",
] as const;

function groupFromRow(value: unknown): CollaborationCommandCompoundSigningGroupRecord {
  const row = rawRow(value, GROUP_ROW_KEYS, "commandCompoundSigningGroup");
  return parseCollaborationCommandCompoundSigningGroupRecord({
    compoundSigningGroupId: row.compound_signing_group_id,
    collaborationServerId: row.collaboration_server_id,
    commandId: row.command_id,
    commandResultId: row.command_result_id,
    preparationGeneration: row.preparation_generation,
    signingLeaseId: row.signing_lease_id,
    resultPreparationRef: row.result_preparation_ref,
    requiredFinalizationArtifactKind: row.required_finalization_artifact_kind,
    secondaryPreparationRef: row.secondary_preparation_ref,
    reservedAtMs: row.reserved_at_ms,
    resultSignedAtMs: row.result_signed_at_ms,
    bothSignedAtMs: row.both_signed_at_ms,
    finalizedAtMs: row.finalized_at_ms,
    abortedAtMs: row.aborted_at_ms,
    state: row.state,
  });
}

const RESERVATION_ROW_KEYS = [
  "collaboration_server_id",
  "signer_sequence",
  "signing_lease_id",
  "signing_lease_kind",
  "purpose",
  "canonical_payload_schema_id",
  "canonical_payload_ref",
  "canonical_payload_digest",
  "signed_record_digest",
  "signature",
  "signed_artifact_type",
  "signed_artifact_id",
  "reserved_at_ms",
  "bound_at_ms",
  "signed_at_ms",
  "aborted_at_ms",
  "state",
] as const;

function reservationFromRow(value: unknown): ServerSignatureReservationRecord {
  const row = rawRow(value, RESERVATION_ROW_KEYS, "serverSignatureReservation");
  return parseServerSignatureReservationRecord({
    collaborationServerId: row.collaboration_server_id,
    signerSequence: row.signer_sequence,
    signingLeaseId: row.signing_lease_id,
    signingLeaseKind: row.signing_lease_kind,
    purpose: row.purpose,
    canonicalPayloadSchemaId: row.canonical_payload_schema_id,
    canonicalPayloadRef: row.canonical_payload_ref,
    canonicalPayloadDigest: row.canonical_payload_digest,
    signedRecordDigest: row.signed_record_digest,
    signature: row.signature,
    signedArtifactType: row.signed_artifact_type,
    signedArtifactId: row.signed_artifact_id,
    reservedAtMs: row.reserved_at_ms,
    boundAtMs: row.bound_at_ms,
    signedAtMs: row.signed_at_ms,
    abortedAtMs: row.aborted_at_ms,
    state: row.state,
  });
}

const ACCEPTANCE_ROW_KEYS = [
  "collaboration_server_id",
  "accepted_at_journal_seq",
  "signed_record_digest",
  "signer_identity_key_id",
  "signer_key_generation",
  "signer_scope_certificate_id",
  "signer_sequence",
  "accepted_at_ms",
  "historical_reattestation_id",
] as const;

function acceptanceFromRow(value: unknown): ServerSignedRecordAcceptanceRecord {
  const row = rawRow(value, ACCEPTANCE_ROW_KEYS, "serverSignedRecordAcceptance");
  return parseServerSignedRecordAcceptanceRecord({
    collaborationServerId: row.collaboration_server_id,
    acceptedAtJournalSeq: row.accepted_at_journal_seq,
    signedRecordDigest: row.signed_record_digest,
    signerIdentityKeyId: row.signer_identity_key_id,
    signerKeyGeneration: row.signer_key_generation,
    signerScopeCertificateId: row.signer_scope_certificate_id,
    signerSequence: row.signer_sequence,
    acceptedAtMs: row.accepted_at_ms,
    historicalReattestationId: row.historical_reattestation_id,
  });
}

const COMMON_RESULT_ROW_KEYS = [
  "command_result_id",
  "collaboration_server_id",
  "command_id",
  "canonical_command_record_digest",
  "result_version",
  "supersedes_command_result_id",
  "source_kind",
  "source_ref",
  "scope_kind",
  "logical_chat_id",
  "target_logical_chat_id",
  "command_seq",
  "disposition",
  "canonical_payload_schema_id",
  "canonical_payload_ref",
  "canonical_payload_digest",
  "command_result_preparation_id",
  "compound_signing_group_id",
  "signer_sequence",
  "server_key_generation",
  "signer_identity_key_id",
  "signer_scope_certificate_id",
  "signature_algorithm",
  "signature",
  "signed_record_digest",
  "accepted_at_journal_seq",
  "created_at_ms",
  "finalized_at_ms",
] as const;

function commonResultFromRow(value: unknown): CollaborationCommandResultRecord {
  const row = rawRow(value, COMMON_RESULT_ROW_KEYS, "collaborationCommandResult");
  return parseCollaborationCommandResultRecord({
    commandResultId: row.command_result_id,
    collaborationServerId: row.collaboration_server_id,
    commandId: row.command_id,
    canonicalCommandRecordDigest: row.canonical_command_record_digest,
    resultVersion: row.result_version,
    supersedesCommandResultId: row.supersedes_command_result_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    scopeKind: row.scope_kind,
    logicalChatId: row.logical_chat_id,
    targetLogicalChatId: row.target_logical_chat_id,
    commandSeq: row.command_seq,
    disposition: row.disposition,
    canonicalPayloadSchemaId: row.canonical_payload_schema_id,
    canonicalPayloadRef: row.canonical_payload_ref,
    canonicalPayloadDigest: row.canonical_payload_digest,
    commandResultPreparationId: row.command_result_preparation_id,
    compoundSigningGroupId: row.compound_signing_group_id,
    signerSequence: row.signer_sequence,
    serverKeyGeneration: row.server_key_generation,
    signerIdentityKeyId: row.signer_identity_key_id,
    signerScopeCertificateId: row.signer_scope_certificate_id,
    signatureAlgorithm: row.signature_algorithm,
    signature: row.signature,
    signedRecordDigest: row.signed_record_digest,
    acceptedAtJournalSeq: row.accepted_at_journal_seq,
    createdAtMs: row.created_at_ms,
    finalizedAtMs: row.finalized_at_ms,
  });
}

const TERMINAL_RESULT_ROW_KEYS = [
  "stable_semantic_result_id",
  "collaboration_server_id",
  "broker_route_id",
  "command_id",
  "command_result_id",
  "accepted_ingress_delivery_attempt_id",
  "trigger_ingress_observation_id",
  "initial_result_delivery_id",
  "semantic_result_record_kind",
  "semantic_result_payload_schema_id",
  "semantic_result_payload_ref",
  "semantic_result_payload_artifact_digest",
  "stored_semantic_result_digest",
  "adjudication_state",
  "finalization_coordinator_lease_id",
  "finalization_coordinator_epoch",
  "terminal_at_ms",
] as const;

function terminalResultFromRow(value: unknown): A1IngressTerminalResultRecord {
  const row = rawRow(value, TERMINAL_RESULT_ROW_KEYS, "a1IngressTerminalResult");
  return parseA1IngressTerminalResultRecord({
    stableSemanticResultId: row.stable_semantic_result_id,
    collaborationServerId: row.collaboration_server_id,
    brokerRouteId: row.broker_route_id,
    commandId: row.command_id,
    commandResultId: row.command_result_id,
    acceptedIngressDeliveryAttemptId: row.accepted_ingress_delivery_attempt_id,
    triggerIngressObservationId: row.trigger_ingress_observation_id,
    initialResultDeliveryId: row.initial_result_delivery_id,
    semanticResultRecordKind: row.semantic_result_record_kind,
    semanticResultPayloadSchemaId: row.semantic_result_payload_schema_id,
    semanticResultPayloadRef: row.semantic_result_payload_ref,
    semanticResultPayloadArtifactDigest: row.semantic_result_payload_artifact_digest,
    storedSemanticResultDigest: row.stored_semantic_result_digest,
    adjudicationState: row.adjudication_state,
    finalizationCoordinatorLeaseId: row.finalization_coordinator_lease_id,
    finalizationCoordinatorEpoch: row.finalization_coordinator_epoch,
    terminalAtMs: row.terminal_at_ms,
  });
}

const RESULT_DELIVERY_ROW_KEYS = [
  "result_delivery_id",
  "stable_semantic_result_id",
  "source_kind",
  "source_ref",
  "command_result_id",
  "trigger_ingress_observation_id",
  "broker_route_id",
  "target_kind",
  "target_ref",
  "delivery_attempt_id",
  "semantic_result_record_kind",
  "semantic_result_payload_schema_id",
  "semantic_result_payload_ref",
  "semantic_result_payload_artifact_digest",
  "stored_semantic_result_digest",
  "state",
  "created_at_ms",
] as const;

function resultDeliveryFromRow(value: unknown): A1IngressResultDeliveryRecord {
  const row = rawRow(value, RESULT_DELIVERY_ROW_KEYS, "a1IngressResultDelivery");
  return parseA1IngressResultDeliveryRecord({
    resultDeliveryId: row.result_delivery_id,
    stableSemanticResultId: row.stable_semantic_result_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    commandResultId: row.command_result_id,
    triggerIngressObservationId: row.trigger_ingress_observation_id,
    brokerRouteId: row.broker_route_id,
    targetKind: row.target_kind,
    targetRef: row.target_ref,
    deliveryAttemptId: row.delivery_attempt_id,
    semanticResultRecordKind: row.semantic_result_record_kind,
    semanticResultPayloadSchemaId: row.semantic_result_payload_schema_id,
    semanticResultPayloadRef: row.semantic_result_payload_ref,
    semanticResultPayloadArtifactDigest: row.semantic_result_payload_artifact_digest,
    storedSemanticResultDigest: row.stored_semantic_result_digest,
    state: row.state,
    createdAtMs: row.created_at_ms,
  });
}

interface CurrentAuthority {
  readonly collaborationServerId: CollaborationServerId;
  readonly machineIdentityId: string;
  readonly currentIdentityKeyId: A1SafeId;
  readonly currentKeyGeneration: number;
  readonly currentScopeCertificateId: A1SafeId;
  readonly nextJournalOffset: number;
  readonly nextCommandSeq: number;
  readonly nextServerSignatureSeq: number;
  readonly heartbeatDeadlineMs: number;
  readonly nowMs: number;
}

function requireCurrentAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  fence: CoordinatorLeaseFence,
  nowMs: () => number,
): CurrentAuthority {
  const wallTime = parseNonNegativeSafeInteger(nowMs(), "commandAdjudication.nowMs");
  const value = sqlGet(
    transaction,
    `SELECT server.collaboration_server_id, server.machine_identity_id,
            server.current_identity_key_id, server.current_key_generation,
            server.current_scope_certificate_id, server.next_journal_offset,
            server.next_command_seq, server.next_server_signature_seq,
            server.state AS server_state,
            coordinator.state AS coordinator_state,
            coordinator.released_at_ms, coordinator.acquired_at_ms,
            coordinator.heartbeat_deadline_ms
       FROM collaboration_servers AS server
       JOIN coordinator_leases AS coordinator
         ON coordinator.coordinator_lease_id = server.current_coordinator_lease_id
        AND coordinator.collaboration_server_id = server.collaboration_server_id
        AND coordinator.coordinator_epoch = server.current_coordinator_epoch
      WHERE server.collaboration_server_id = ?
        AND server.current_coordinator_lease_id = ?
        AND server.current_coordinator_epoch = ?
      LIMIT 1`,
    [fence.collaborationServerId, fence.coordinatorLeaseId, fence.coordinatorEpoch],
  );
  if (value === undefined) throw new CommandAdjudicationStaleCoordinatorError();
  const row = rawRow(
    value,
    [
      "collaboration_server_id",
      "machine_identity_id",
      "current_identity_key_id",
      "current_key_generation",
      "current_scope_certificate_id",
      "next_journal_offset",
      "next_command_seq",
      "next_server_signature_seq",
      "server_state",
      "coordinator_state",
      "released_at_ms",
      "acquired_at_ms",
      "heartbeat_deadline_ms",
    ],
    "commandAdjudicationAuthority",
  );
  const acquiredAtMs = parseNonNegativeSafeInteger(
    row.acquired_at_ms,
    "commandAdjudicationAuthority.acquiredAtMs",
  );
  const heartbeatDeadlineMs = parseNonNegativeSafeInteger(
    row.heartbeat_deadline_ms,
    "commandAdjudicationAuthority.heartbeatDeadlineMs",
  );
  if (
    row.server_state !== "current" ||
    row.coordinator_state !== "current" ||
    row.released_at_ms !== null ||
    Math.max(wallTime, acquiredAtMs) >= heartbeatDeadlineMs
  ) {
    throw new CommandAdjudicationStaleCoordinatorError();
  }
  const storedMachineIdentityId = parseMachineIdentityId(row.machine_identity_id);
  if (storedMachineIdentityId !== machineIdentityId) {
    throw new CommandAdjudicationRepositoryConflictError(
      "collaboration server belongs to another machine",
    );
  }
  if (row.current_identity_key_id === null || row.current_scope_certificate_id === null) {
    throw new CommandAdjudicationRepositoryConflictError(
      "collaboration server has no current signing identity",
    );
  }
  return frozen({
    collaborationServerId: parseA1CanonicalId("collaborationServer", row.collaboration_server_id),
    machineIdentityId: storedMachineIdentityId,
    currentIdentityKeyId: parseA1SafeId(row.current_identity_key_id),
    currentKeyGeneration: parseNonNegativeSafeInteger(
      row.current_key_generation,
      "commandAdjudicationAuthority.currentKeyGeneration",
    ),
    currentScopeCertificateId: parseA1SafeId(row.current_scope_certificate_id),
    nextJournalOffset: parseNonNegativeSafeInteger(
      row.next_journal_offset,
      "commandAdjudicationAuthority.nextJournalOffset",
    ),
    nextCommandSeq: parseNonNegativeSafeInteger(
      row.next_command_seq,
      "commandAdjudicationAuthority.nextCommandSeq",
    ),
    nextServerSignatureSeq: parseNonNegativeSafeInteger(
      row.next_server_signature_seq,
      "commandAdjudicationAuthority.nextServerSignatureSeq",
    ),
    heartbeatDeadlineMs,
    nowMs: Math.max(wallTime, acquiredAtMs),
  });
}

interface AwaitingIngressResult {
  readonly stableSemanticResultId: A1SafeId;
  readonly brokerRouteId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly scopeKind: "server_control" | "chat";
  readonly logicalChatId: LogicalChatId | null;
  readonly sourceEventNamespaceId: A1SafeId;
  readonly messageId: A1SafeId;
  readonly recordKind: "user" | "new_chat";
  readonly acceptedDeliveryAttemptId: A1SafeId;
  readonly sourcePayloadSchemaId: string;
  readonly canonicalMessageDigest: A1Digest;
  readonly sourceEventFingerprint: A1Digest;
  readonly firstIngressGeneration: number;
  readonly firstIngressFrameIndex: number;
}

function awaitingIngressFromRow(value: unknown): AwaitingIngressResult {
  const row = rawRow(
    value,
    [
      "stable_semantic_result_id",
      "broker_route_id",
      "collaboration_server_id",
      "route_kind",
      "logical_chat_id",
      "source_event_namespace_id",
      "message_id",
      "record_kind",
      "accepted_delivery_attempt_id",
      "source_payload_schema_id",
      "canonical_message_digest",
      "source_event_fingerprint",
      "first_ingress_generation",
      "first_ingress_frame_index",
      "state",
    ],
    "awaitingIngressResult",
  );
  if (row.state !== "awaiting_order") {
    throw new CommandAdjudicationRepositoryConflictError("ingress result is not awaiting order");
  }
  const scopeKind =
    row.route_kind === "chat"
      ? "chat"
      : row.route_kind === "server_control"
        ? "server_control"
        : null;
  if (scopeKind === null || (scopeKind === "chat") !== (row.logical_chat_id !== null)) {
    throw new CommandAdjudicationRepositoryPersistenceError("ingress result scope is invalid");
  }
  if (row.record_kind !== "user" && row.record_kind !== "new_chat") {
    throw new CommandAdjudicationRepositoryPersistenceError("ingress result kind is unsupported");
  }
  if (
    (scopeKind === "chat" && row.record_kind !== "user") ||
    (scopeKind === "server_control" && row.record_kind !== "new_chat")
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "ingress result kind does not match its scope",
    );
  }
  return frozen({
    stableSemanticResultId: semanticResultId(row.stable_semantic_result_id, "ingressResult.id"),
    brokerRouteId: parseA1SafeId(row.broker_route_id, "ingressResult.brokerRouteId"),
    collaborationServerId: parseA1CanonicalId("collaborationServer", row.collaboration_server_id),
    scopeKind,
    logicalChatId:
      row.logical_chat_id === null ? null : parseA1CanonicalId("logicalChat", row.logical_chat_id),
    sourceEventNamespaceId: parseA1SafeId(row.source_event_namespace_id),
    messageId: parseA1SafeId(row.message_id),
    recordKind: row.record_kind,
    acceptedDeliveryAttemptId: parseA1SafeId(row.accepted_delivery_attempt_id),
    sourcePayloadSchemaId: String(row.source_payload_schema_id),
    canonicalMessageDigest: parseA1Digest(row.canonical_message_digest),
    sourceEventFingerprint: parseA1Digest(row.source_event_fingerprint),
    firstIngressGeneration: parseNonNegativeSafeInteger(
      row.first_ingress_generation,
      "ingressResult.firstIngressGeneration",
    ),
    firstIngressFrameIndex: parseNonNegativeSafeInteger(
      row.first_ingress_frame_index,
      "ingressResult.firstIngressFrameIndex",
    ),
  });
}

function findAwaitingIngress(
  transaction: HostStateRepositorySqlTransaction,
  stableSemanticResultId: A1SafeId,
): AwaitingIngressResult | null {
  const row = sqlGet(
    transaction,
    `SELECT stable_semantic_result_id, broker_route_id, collaboration_server_id,
            route_kind, logical_chat_id, source_event_namespace_id, message_id,
            record_kind, accepted_delivery_attempt_id, source_payload_schema_id,
            canonical_message_digest, source_event_fingerprint,
            first_ingress_generation, first_ingress_frame_index, state
       FROM authenticated_ingress_results
      WHERE stable_semantic_result_id = ? LIMIT 1`,
    [stableSemanticResultId],
  );
  return row === undefined ? null : awaitingIngressFromRow(row);
}

interface FinalizationIngress {
  readonly stableSemanticResultId: A1SafeId;
  readonly brokerRouteId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly scopeKind: "server_control" | "chat";
  readonly logicalChatId: LogicalChatId | null;
  readonly sourceEventNamespaceId: A1SafeId;
  readonly messageId: A1SafeId;
  readonly recordKind: "user" | "new_chat";
  readonly acceptedDeliveryAttemptId: A1SafeId;
  readonly expectedParts: number;
  readonly sourcePayloadSchemaId: string;
  readonly canonicalMessageDigest: A1Digest;
  readonly sourceEventFingerprint: A1Digest;
  readonly firstIngressGeneration: number;
  readonly firstIngressFrameIndex: number;
  readonly state: "awaiting_order" | "quarantined_collision";
}

function finalizationIngressFromRow(value: unknown): FinalizationIngress {
  const row = rawRow(
    value,
    [
      "stable_semantic_result_id",
      "broker_route_id",
      "collaboration_server_id",
      "route_kind",
      "logical_chat_id",
      "source_event_namespace_id",
      "message_id",
      "record_kind",
      "accepted_delivery_attempt_id",
      "expected_parts",
      "source_payload_schema_id",
      "canonical_message_digest",
      "source_event_fingerprint",
      "first_ingress_generation",
      "first_ingress_frame_index",
      "state",
    ],
    "finalizationIngressResult",
  );
  if (row.state !== "awaiting_order" && row.state !== "quarantined_collision") {
    throw new CommandAdjudicationRepositoryConflictError(
      "signed command source is no longer retained in a finalizable ingress state",
    );
  }
  if (row.accepted_delivery_attempt_id === null) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "signed command source lost its accepted delivery attempt",
    );
  }
  const scopeKind =
    row.route_kind === "server_control"
      ? "server_control"
      : row.route_kind === "chat"
        ? "chat"
        : null;
  const recordKind =
    row.record_kind === "new_chat" ? "new_chat" : row.record_kind === "user" ? "user" : null;
  if (
    scopeKind === null ||
    recordKind === null ||
    (scopeKind === "server_control" &&
      (row.logical_chat_id !== null || recordKind !== "new_chat")) ||
    (scopeKind === "chat" && (row.logical_chat_id === null || recordKind !== "user"))
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "signed command source scope or record kind is invalid",
    );
  }
  return frozen({
    stableSemanticResultId: semanticResultId(
      row.stable_semantic_result_id,
      "finalizationIngressResult.stableSemanticResultId",
    ),
    brokerRouteId: prefixedRepositoryId(
      row.broker_route_id,
      "rcr_",
      "finalizationIngressResult.brokerRouteId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaboration_server_id,
      "finalizationIngressResult.collaborationServerId",
    ),
    scopeKind,
    logicalChatId:
      row.logical_chat_id === null
        ? null
        : parseA1CanonicalId(
            "logicalChat",
            row.logical_chat_id,
            "finalizationIngressResult.logicalChatId",
          ),
    sourceEventNamespaceId: parseA1SafeId(
      row.source_event_namespace_id,
      "finalizationIngressResult.sourceEventNamespaceId",
    ),
    messageId: parseA1SafeId(row.message_id, "finalizationIngressResult.messageId"),
    recordKind,
    acceptedDeliveryAttemptId: parseA1SafeId(
      row.accepted_delivery_attempt_id,
      "finalizationIngressResult.acceptedDeliveryAttemptId",
    ),
    expectedParts: parseNonNegativeSafeInteger(
      row.expected_parts,
      "finalizationIngressResult.expectedParts",
    ),
    sourcePayloadSchemaId: String(row.source_payload_schema_id),
    canonicalMessageDigest: parseA1Digest(
      row.canonical_message_digest,
      "finalizationIngressResult.canonicalMessageDigest",
    ),
    sourceEventFingerprint: parseA1Digest(
      row.source_event_fingerprint,
      "finalizationIngressResult.sourceEventFingerprint",
    ),
    firstIngressGeneration: parseNonNegativeSafeInteger(
      row.first_ingress_generation,
      "finalizationIngressResult.firstIngressGeneration",
    ),
    firstIngressFrameIndex: parseNonNegativeSafeInteger(
      row.first_ingress_frame_index,
      "finalizationIngressResult.firstIngressFrameIndex",
    ),
    state: row.state,
  });
}

function findFinalizationIngress(
  transaction: HostStateRepositorySqlTransaction,
  stableSemanticResultId: A1SafeId,
): FinalizationIngress | null {
  const value = sqlGet(
    transaction,
    `SELECT stable_semantic_result_id, broker_route_id, collaboration_server_id,
            route_kind, logical_chat_id, source_event_namespace_id, message_id,
            record_kind, accepted_delivery_attempt_id, expected_parts,
            source_payload_schema_id, canonical_message_digest,
            source_event_fingerprint, first_ingress_generation,
            first_ingress_frame_index, state
       FROM authenticated_ingress_results
      WHERE stable_semantic_result_id = ? LIMIT 1`,
    [stableSemanticResultId],
  );
  return value === undefined ? null : finalizationIngressFromRow(value);
}

interface CompletionSelection {
  readonly triggerIngressObservationId: A1SafeId;
  readonly terminalGeneration: number;
  readonly terminalFrameIndex: number;
}

function selectCompletionObservation(
  transaction: HostStateRepositorySqlTransaction,
  ingress: FinalizationIngress,
): CompletionSelection {
  const candidate = rawRow(
    sqlGet(
      transaction,
      `SELECT expected_parts, received_parts, state
         FROM ingress_delivery_candidates
        WHERE broker_route_id = ? AND stable_semantic_result_id = ?
          AND delivery_attempt_id = ? LIMIT 1`,
      [ingress.brokerRouteId, ingress.stableSemanticResultId, ingress.acceptedDeliveryAttemptId],
    ),
    ["expected_parts", "received_parts", "state"],
    "acceptedIngressCandidate",
  );
  if (
    candidate.state !== "complete" ||
    candidate.expected_parts !== ingress.expectedParts ||
    candidate.received_parts !== ingress.expectedParts
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "accepted ingress candidate is not exactly complete",
    );
  }
  const observations = sqlAll(
    transaction,
    `SELECT observation.ingress_observation_id, observation.delivery_attempt_id,
            observation.channel_generation, observation.frame_index,
            observation.part, observation.parts, observation.disposition
       FROM authenticated_ingress_observations AS observation
       JOIN authenticated_ingress_parts AS part
         ON part.broker_route_id = observation.broker_route_id
        AND part.stable_semantic_result_id = observation.stable_semantic_result_id
        AND part.delivery_attempt_id = observation.delivery_attempt_id
        AND part.part = observation.part
        AND part.parts = observation.parts
        AND part.first_ingress_generation = observation.channel_generation
        AND part.first_ingress_frame_index = observation.frame_index
      WHERE observation.broker_route_id = ?
        AND observation.stable_semantic_result_id = ?
        AND observation.delivery_attempt_id = ?
        AND observation.disposition = 'new_part'
      ORDER BY observation.part`,
    [ingress.brokerRouteId, ingress.stableSemanticResultId, ingress.acceptedDeliveryAttemptId],
  );
  const selected = selectA1CompletionObservation({
    acceptedDeliveryAttemptId: ingress.acceptedDeliveryAttemptId,
    expectedParts: ingress.expectedParts,
    observations: observations.map((value) => {
      const row = rawRow(
        value,
        [
          "ingress_observation_id",
          "delivery_attempt_id",
          "channel_generation",
          "frame_index",
          "part",
          "parts",
          "disposition",
        ],
        "acceptedIngressCompletionObservation",
      );
      if (row.disposition !== "new_part") {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "accepted completion observation is not a newly retained part",
        );
      }
      return {
        ingressObservationId: String(row.ingress_observation_id),
        deliveryAttemptId: String(row.delivery_attempt_id),
        cursor: {
          version: 1,
          channelGeneration: parseNonNegativeSafeInteger(
            row.channel_generation,
            "acceptedIngressCompletionObservation.channelGeneration",
          ),
          frameIndex: parseNonNegativeSafeInteger(
            row.frame_index,
            "acceptedIngressCompletionObservation.frameIndex",
          ),
        },
        part: parseNonNegativeSafeInteger(row.part, "acceptedIngressCompletionObservation.part"),
        parts: parseNonNegativeSafeInteger(row.parts, "acceptedIngressCompletionObservation.parts"),
        disposition: "new_part",
      } as const;
    }),
  });
  return frozen({
    triggerIngressObservationId: prefixedRepositoryId(
      selected.triggerIngressObservationId,
      "rio_",
      "completionSelection.triggerIngressObservationId",
    ),
    terminalGeneration: selected.terminalIngressCursor.channelGeneration,
    terminalFrameIndex: selected.terminalIngressCursor.frameIndex,
  });
}

function assertRouteHeadEligible(
  transaction: HostStateRepositorySqlTransaction,
  ingress: AwaitingIngressResult,
): number {
  const runtime = sqlGet(
    transaction,
    `SELECT state, active_gap_count, updated_at_ms FROM broker_route_runtime_status
      WHERE broker_route_id = ? LIMIT 1`,
    [ingress.brokerRouteId],
  );
  const runtimeRow = rawRow(
    runtime,
    ["state", "active_gap_count", "updated_at_ms"],
    "brokerRouteRuntimeStatus",
  );
  if (runtimeRow.state !== "current" || runtimeRow.active_gap_count !== 0) {
    throw new CommandAdjudicationRepositoryConflictError(
      "broker route is not eligible for semantic ordering",
    );
  }
  const head = sqlGet(
    transaction,
    `SELECT stable_semantic_result_id
       FROM authenticated_ingress_results
      WHERE broker_route_id = ? AND state IN ('assembling', 'awaiting_order')
        AND NOT EXISTS (
          SELECT 1 FROM a1_ingress_adjudications AS adjudication
          WHERE adjudication.stable_semantic_result_id =
            authenticated_ingress_results.stable_semantic_result_id
        )
      ORDER BY first_ingress_generation, first_ingress_frame_index,
               stable_semantic_result_id LIMIT 1`,
    [ingress.brokerRouteId],
  );
  const row = rawRow(head, ["stable_semantic_result_id"], "routeSemanticHead");
  if (row.stable_semantic_result_id !== ingress.stableSemanticResultId) {
    throw new CommandAdjudicationRepositoryConflictError(
      "ingress result is not the earliest unblocked route result",
    );
  }
  return parseNonNegativeSafeInteger(
    runtimeRow.updated_at_ms,
    "brokerRouteRuntimeStatus.updatedAtMs",
  );
}

interface CommonCommandPayload {
  readonly mutationFamily: "user_text" | "new_chat";
  readonly schemaId: typeof A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID;
  readonly bytes: Uint8Array;
  readonly digest: A1Digest;
}

function commonPayloadForRejectedIngress(ingress: AwaitingIngressResult): CommonCommandPayload {
  const mutationFamily = ingress.recordKind === "user" ? "user_text" : "new_chat";
  const payload: A1UnsupportedRecognizedCommandPayload = {
    schemaVersion: 1,
    canonicalCommandPayloadSchemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
    normalizedMutationFamily: mutationFamily,
    sourcePayloadSchemaId: ingress.sourcePayloadSchemaId,
    sourcePayloadDigest: ingress.canonicalMessageDigest,
    sourceEventFingerprint: ingress.sourceEventFingerprint,
  };
  const bytes = canonicalA1CommandPayload(payload);
  return frozen({
    mutationFamily,
    schemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
    bytes,
    digest: digestBytes(bytes),
  });
}

function deriveSourceCommandIdentityDigest(
  machineIdentityId: string,
  ingress: AwaitingIngressResult,
): A1Digest {
  const source: A1IngressCommandSource =
    ingress.scopeKind === "server_control"
      ? {
          sourceKind: "a1_ingress",
          identityId: Buffer.from(machineIdentityId, "hex"),
          collaborationServerId: ingress.collaborationServerId,
          scopeKind: "server_control",
          logicalChatId: null,
          sourceEventNamespaceId: ingress.sourceEventNamespaceId,
          sourceEventId: ingress.messageId,
        }
      : {
          sourceKind: "a1_ingress",
          identityId: Buffer.from(machineIdentityId, "hex"),
          collaborationServerId: ingress.collaborationServerId,
          scopeKind: "chat",
          logicalChatId: ingress.logicalChatId as LogicalChatId,
          sourceEventNamespaceId: ingress.sourceEventNamespaceId,
          sourceEventId: ingress.messageId,
        };
  const bytes = canonicalA1CommandSourceIdentity(source);
  try {
    return digestBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

function deriveCommandId(
  collaborationServerId: CollaborationServerId,
  sourceCommandIdentityDigest: A1Digest,
): A1SafeId {
  const bytes = canonicalA1CollaborationCommandIdPreimage({
    collaborationServerId,
    sourceKind: A1_COMMAND_SOURCE_KIND,
    sourceCommandIdentityDigest,
  });
  try {
    return commandId(`rcm_${createHash("sha256").update(bytes).digest("base64url")}`, "commandId");
  } finally {
    bytes.fill(0);
  }
}

function rejectedDecisionEvidence(command: CollaborationCommandRecord): A1CommandDecisionEvidence {
  return {
    schemaVersion: 1,
    decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    commandId: command.commandId,
    collaborationServerId: command.collaborationServerId,
    scopeKind: command.scopeKind,
    projectTargetSelectorMappingId: null,
    projectTargetSelectorMappingGeneration: null,
    projectTargetDigest: null,
    selectedTargetKind: null,
    selectedExecutorEvidenceSchemaId: null,
    selectedExecutorEvidenceRef: null,
    selectedExecutorEvidenceDigest: null,
    targetCapabilitySnapshotId: null,
    targetCapabilityFamilyDigest: null,
    decisionPolicyId: A1_COMMAND_DECISION_POLICY_ID,
  };
}

function commandContractRecord(
  command: CollaborationCommandRecord,
  commandSeq: number,
  disposition: "rejected",
  decisionEvidenceDigest: A1Digest,
): A1CanonicalCommandRecord {
  return {
    commandId: command.commandId,
    collaborationServerId: command.collaborationServerId,
    scopeKind: command.scopeKind,
    logicalChatId: command.logicalChatId,
    targetLogicalChatId: command.targetLogicalChatId,
    sourceKind: command.sourceKind,
    sourceRef: command.sourceRef,
    sourceEventNamespaceId: command.sourceEventNamespaceId,
    sourceEventId: command.sourceEventId,
    sourceCommandIdentityDigest: command.sourceCommandIdentityDigest,
    canonicalSourceEventDigest: null,
    mutationFamily: command.mutationFamily,
    canonicalCommandPayloadSchemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
    canonicalCommandPayloadDigest: command.canonicalCommandPayloadDigest,
    preDecisionNormalizationEvidenceSchemaId: null,
    preDecisionNormalizationEvidenceDigest: null,
    readyAtJournalSeq: command.readyAtJournalSeq,
    commandSeq,
    disposition,
    admittedTargetKind: command.admittedTargetKind,
    targetCapabilitySnapshotId: command.targetCapabilitySnapshotId,
    targetCapabilityFamilyDigest: command.targetCapabilityFamilyDigest,
    decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    decisionEvidenceDigest,
  };
}

interface CanonicalResultPayloadInput {
  readonly commandResultId: A1SafeId;
  readonly command: CollaborationCommandRecord;
  readonly createdAtMs: number;
  readonly signerSequence: number;
  readonly serverKeyGeneration: number;
  readonly signerIdentityKeyId: A1SafeId;
  readonly signerScopeCertificateId: A1SafeId;
}

function resultPayloadContract(
  input: CanonicalResultPayloadInput,
): A1CanonicalCommandResultPayload {
  const command = input.command;
  if (
    command.canonicalCommandRecordDigest === null ||
    command.commandSeq === null ||
    command.disposition === null
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "cannot prepare a result for an unordered command",
    );
  }
  return {
    canonicalPayloadSchemaId: A1_COMMAND_RESULT_SCHEMA_ID,
    commandResultId: input.commandResultId,
    collaborationServerId: command.collaborationServerId,
    commandId: command.commandId,
    canonicalCommandRecordDigest: command.canonicalCommandRecordDigest,
    resultVersion: 1,
    supersedesCommandResultId: null,
    sourceKind: command.sourceKind,
    sourceRef: command.sourceRef,
    scopeKind: command.scopeKind,
    logicalChatId: command.logicalChatId,
    targetLogicalChatId: command.targetLogicalChatId,
    commandSeq: command.commandSeq,
    disposition: command.disposition,
    createdAtMs: input.createdAtMs,
    signerSequence: input.signerSequence,
    serverKeyGeneration: input.serverKeyGeneration,
    signerIdentityKeyId: input.signerIdentityKeyId,
    signerScopeCertificateId: input.signerScopeCertificateId,
    signatureAlgorithm: "Ed25519",
  };
}

function signedResultDigest(
  canonicalPayloadDigest: A1Digest,
  signerIdentityKeyId: A1SafeId,
  serverKeyGeneration: number,
  signerSequence: number,
  signature: Ed25519Signature,
): A1Digest {
  const bytes = canonicalA1SignedCommandResult({
    canonicalPayloadDigest,
    signerIdentityKeyId,
    serverKeyGeneration,
    signerSequence,
    signature,
  });
  try {
    return digestBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

interface PreparedSemanticResult {
  readonly recordKind: A1SemanticResultRecordKind;
  readonly payloadSchemaId: A1SemanticResultPayloadSchemaId;
  readonly payloadBytes: Uint8Array;
  readonly payloadArtifactDigest: A1Digest;
  readonly storedSemanticResultDigest: A1Digest;
}

function prepareRejectedSemanticResult(
  ingress: FinalizationIngress,
  command: CollaborationCommandRecord,
): PreparedSemanticResult {
  if (
    command.commandSeq === null ||
    command.disposition !== "rejected" ||
    command.sourceRef !== ingress.stableSemanticResultId ||
    command.sourceEventId !== ingress.messageId ||
    command.scopeKind !== ingress.scopeKind ||
    command.logicalChatId !== ingress.logicalChatId
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "signed rejected command no longer matches its retained ingress source",
    );
  }
  const recordKind: A1SemanticResultRecordKind =
    ingress.recordKind === "new_chat" ? "chat_creation_result" : "action_result";
  const payloadSchemaId: A1SemanticResultPayloadSchemaId =
    recordKind === "chat_creation_result"
      ? A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID
      : A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID;
  const payloadBytes =
    recordKind === "chat_creation_result"
      ? encodeA1RejectedChatCreationResultPayloadV1Bytes({
          v: 1,
          resultId: ingress.stableSemanticResultId,
          sourceMsgId: ingress.messageId,
          decision: "rejected",
          targetLogicalChatId: null,
          commandSeq: command.commandSeq,
        })
      : encodeA1RejectedActionResultPayloadV1Bytes({
          v: 1,
          resultId: ingress.stableSemanticResultId,
          sourceMsgId: ingress.messageId,
          sourceRecordKind: ingress.recordKind,
          decision: "rejected",
          commandSeq: command.commandSeq,
        });
  const storedDigestPreimage = canonicalA1StoredSemanticResultPreimage({
    storedSemanticResultSchemaId: payloadSchemaId,
    exactCompactUtf8Payload: payloadBytes,
  });
  try {
    return frozen({
      recordKind,
      payloadSchemaId,
      payloadBytes,
      payloadArtifactDigest: digestBytes(payloadBytes),
      storedSemanticResultDigest: digestBytes(storedDigestPreimage),
    });
  } finally {
    storedDigestPreimage.fill(0);
  }
}

function deriveResultDeliveryId(
  stableSemanticResultId: A1SafeId,
  triggerIngressObservationId: A1SafeId,
): A1SafeId {
  const preimage = canonicalA1ResultDeliveryIdPreimage({
    ingressResultId: stableSemanticResultId,
    triggerIngressObservationId,
  });
  try {
    return prefixedRepositoryId(
      `rrd_${createHash("sha256").update(preimage).digest("base64url")}`,
      "rrd_",
      "resultDelivery.resultDeliveryId",
    );
  } finally {
    preimage.fill(0);
  }
}

function findReadyEntry(
  transaction: HostStateRepositorySqlTransaction,
  stableSemanticResultId: A1SafeId,
): CommandReadyEntryRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${READY_ROW_KEYS.join(", ")} FROM command_ready_entries
      WHERE stable_semantic_result_id = ? LIMIT 1`,
    [stableSemanticResultId],
  );
  return value === undefined ? null : readyFromRow(value);
}

function findAdjudication(
  transaction: HostStateRepositorySqlTransaction,
  stableSemanticResultId: A1SafeId,
): A1IngressAdjudicationRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${ADJUDICATION_ROW_KEYS.join(", ")} FROM a1_ingress_adjudications
      WHERE stable_semantic_result_id = ? LIMIT 1`,
    [stableSemanticResultId],
  );
  return value === undefined ? null : adjudicationFromRow(value);
}

function findCommand(
  transaction: HostStateRepositorySqlTransaction,
  selectedCommandId: A1SafeId,
): CollaborationCommandRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${COMMAND_ROW_KEYS.join(", ")} FROM collaboration_commands
      WHERE command_id = ? LIMIT 1`,
    [selectedCommandId],
  );
  return value === undefined ? null : commandFromRow(value);
}

function findPreparation(
  transaction: HostStateRepositorySqlTransaction,
  commandResultPreparationId: A1SafeId,
): CollaborationCommandResultPreparationRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${PREPARATION_ROW_KEYS.join(", ")}
       FROM collaboration_command_result_preparations
      WHERE command_result_preparation_id = ? LIMIT 1`,
    [commandResultPreparationId],
  );
  return value === undefined ? null : preparationFromRow(value);
}

function findGroup(
  transaction: HostStateRepositorySqlTransaction,
  compoundSigningGroupId: A1SafeId,
): CollaborationCommandCompoundSigningGroupRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${GROUP_ROW_KEYS.join(", ")}
       FROM collaboration_command_compound_signing_groups
      WHERE compound_signing_group_id = ? LIMIT 1`,
    [compoundSigningGroupId],
  );
  return value === undefined ? null : groupFromRow(value);
}

function findReservation(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  signerSequence: number,
): ServerSignatureReservationRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${RESERVATION_ROW_KEYS.join(", ")} FROM server_signature_reservations
      WHERE collaboration_server_id = ? AND signer_sequence = ? LIMIT 1`,
    [collaborationServerId, signerSequence],
  );
  return value === undefined ? null : reservationFromRow(value);
}

function findAcceptanceBySignerSequence(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  signerSequence: number,
): ServerSignedRecordAcceptanceRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${ACCEPTANCE_ROW_KEYS.join(", ")} FROM server_signed_record_acceptances
      WHERE collaboration_server_id = ? AND signer_sequence = ? LIMIT 1`,
    [collaborationServerId, signerSequence],
  );
  return value === undefined ? null : acceptanceFromRow(value);
}

function findCommonResult(
  transaction: HostStateRepositorySqlTransaction,
  commandResultId: A1SafeId,
): CollaborationCommandResultRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${COMMON_RESULT_ROW_KEYS.join(", ")} FROM collaboration_command_results
      WHERE command_result_id = ? LIMIT 1`,
    [commandResultId],
  );
  return value === undefined ? null : commonResultFromRow(value);
}

function findTerminalResult(
  transaction: HostStateRepositorySqlTransaction,
  stableSemanticResultId: A1SafeId,
): A1IngressTerminalResultRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${TERMINAL_RESULT_ROW_KEYS.join(", ")} FROM a1_ingress_terminal_results
      WHERE stable_semantic_result_id = ? LIMIT 1`,
    [stableSemanticResultId],
  );
  return value === undefined ? null : terminalResultFromRow(value);
}

function findResultDelivery(
  transaction: HostStateRepositorySqlTransaction,
  resultDeliveryId: A1SafeId,
): A1IngressResultDeliveryRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${RESULT_DELIVERY_ROW_KEYS.join(", ")} FROM a1_ingress_result_deliveries
      WHERE result_delivery_id = ? LIMIT 1`,
    [resultDeliveryId],
  );
  return value === undefined ? null : resultDeliveryFromRow(value);
}

function findResultDeliveryByCommandResult(
  transaction: HostStateRepositorySqlTransaction,
  commandResultId: A1SafeId,
): A1IngressResultDeliveryRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${RESULT_DELIVERY_ROW_KEYS.join(", ")} FROM a1_ingress_result_deliveries
      WHERE command_result_id = ? LIMIT 1`,
    [commandResultId],
  );
  return value === undefined ? null : resultDeliveryFromRow(value);
}

function putCanonicalArtifact(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  schemaId: string,
  digest: A1Digest,
  bytes: Uint8Array,
  randomBytes: ((byteLength: number) => Uint8Array) | undefined,
  nowMs: number,
): A1SafeId {
  const snapshot = ProtectedByteSnapshot.from(bytes);
  try {
    const result = createProtectedArtifactTransactionOperations(artifactTransaction(transaction), {
      ...(randomBytes === undefined ? {} : { randomBytes }),
      nowMs: () => nowMs,
    }).putArtifact({
      scopeKind: "collaboration_server",
      scopeId: collaborationServerId,
      artifactSchemaId: schemaId,
      artifactDigest: digest,
      artifactBytes: snapshot,
    });
    return result.artifactRef.protectedHandleId;
  } finally {
    snapshot.destroy();
  }
}

function readCanonicalArtifact(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  artifactRef: A1SafeId,
  schemaId: string,
  digest: A1Digest,
): ProtectedByteSnapshot {
  return createProtectedArtifactTransactionOperations(
    artifactTransaction(transaction),
  ).readVerifiedArtifact({
    scopeKind: "collaboration_server",
    scopeId: collaborationServerId,
    artifactRef: {
      protectedHandleId: parseA1CanonicalId("protectedHandle", artifactRef),
      kind: "artifact",
    },
    artifactSchemaId: schemaId,
    expectedArtifactDigest: digest,
  }).artifactBytes;
}

function equalSnapshot(snapshot: ProtectedByteSnapshot, expected: Uint8Array): boolean {
  const actual = snapshot.copyBytes();
  try {
    return actual.byteLength === expected.byteLength && Buffer.compare(actual, expected) === 0;
  } finally {
    actual.fill(0);
  }
}

function assertExactReadyGraph(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: ParsedReadyRequest,
  replayed: boolean,
): ReadyA1IngressCommandResult | null {
  const adjudication = findAdjudication(transaction, request.stableSemanticResultId);
  if (adjudication === null) return null;
  const readyEntry = findReadyEntry(transaction, request.stableSemanticResultId);
  const command = findCommand(transaction, adjudication.commandId);
  const ingress = findAwaitingIngress(transaction, request.stableSemanticResultId);
  if (readyEntry === null || command === null || ingress === null) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "materialized A1 command graph is partial",
    );
  }
  const payload = commonPayloadForRejectedIngress(ingress);
  const sourceDigest = deriveSourceCommandIdentityDigest(machineIdentityId, ingress);
  const expectedCommandId = deriveCommandId(ingress.collaborationServerId, sourceDigest);
  const exact =
    request.expectedReadyAtJournalSeq === adjudication.readyAtJournalSeq &&
    readyEntry.collaborationServerId === ingress.collaborationServerId &&
    adjudication.collaborationServerId === ingress.collaborationServerId &&
    command.collaborationServerId === ingress.collaborationServerId &&
    readyEntry.readyAtJournalSeq === adjudication.readyAtJournalSeq &&
    command.readyAtJournalSeq === adjudication.readyAtJournalSeq &&
    readyEntry.commandId === adjudication.commandId &&
    readyEntry.stableSemanticResultId === adjudication.stableSemanticResultId &&
    command.commandId === expectedCommandId &&
    command.sourceRef === ingress.stableSemanticResultId &&
    command.sourceEventNamespaceId === ingress.sourceEventNamespaceId &&
    command.sourceEventId === ingress.messageId &&
    command.sourceCommandIdentityDigest === sourceDigest &&
    command.scopeKind === ingress.scopeKind &&
    command.logicalChatId === ingress.logicalChatId &&
    command.targetLogicalChatId === ingress.logicalChatId &&
    command.mutationFamily === payload.mutationFamily &&
    command.canonicalCommandPayloadSchemaId === payload.schemaId &&
    command.canonicalCommandPayloadDigest === payload.digest &&
    readyEntry.coordinatorLeaseId === command.coordinatorLeaseId &&
    readyEntry.coordinatorEpoch === command.coordinatorEpoch &&
    readyEntry.readyAtMs === command.createdAtMs;
  if (!exact) {
    payload.bytes.fill(0);
    throw new CommandAdjudicationRepositoryConflictError(
      "existing ready graph does not match the requested source snapshot",
    );
  }
  const snapshot = readCanonicalArtifact(
    transaction,
    command.collaborationServerId,
    command.canonicalCommandPayloadRef,
    payload.schemaId,
    payload.digest,
  );
  try {
    if (!equalSnapshot(snapshot, payload.bytes)) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "canonical command payload does not match retained ingress evidence",
      );
    }
  } finally {
    snapshot.destroy();
    payload.bytes.fill(0);
  }
  return frozen({ readyEntry, adjudication, command, replayed });
}

interface CurrentSigningLease {
  readonly signingLeaseId: A1SafeId;
  readonly identityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly scopeCertificateId: A1SafeId;
  readonly acquiredAtMs: number;
}

function requireCurrentSigningLease(
  transaction: HostStateRepositorySqlTransaction,
  authority: CurrentAuthority,
): CurrentSigningLease {
  const value = sqlGet(
    transaction,
    `SELECT signing_lease_id, identity_key_id, key_generation,
            scope_certificate_id, acquired_at_ms
       FROM server_signing_leases
      WHERE collaboration_server_id = ? AND state = 'current'
        AND identity_key_id = ? AND key_generation = ?
        AND scope_certificate_id = ? LIMIT 1`,
    [
      authority.collaborationServerId,
      authority.currentIdentityKeyId,
      authority.currentKeyGeneration,
      authority.currentScopeCertificateId,
    ],
  );
  const row = rawRow(
    value,
    [
      "signing_lease_id",
      "identity_key_id",
      "key_generation",
      "scope_certificate_id",
      "acquired_at_ms",
    ],
    "currentCommandSigningLease",
  );
  return frozen({
    signingLeaseId: parseA1SafeId(row.signing_lease_id),
    identityKeyId: parseA1SafeId(row.identity_key_id),
    keyGeneration: parseNonNegativeSafeInteger(
      row.key_generation,
      "currentCommandSigningLease.keyGeneration",
    ),
    scopeCertificateId: parseA1SafeId(row.scope_certificate_id),
    acquiredAtMs: parseNonNegativeSafeInteger(
      row.acquired_at_ms,
      "currentCommandSigningLease.acquiredAtMs",
    ),
  });
}

function exactDecisionResult(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: ReserveRejectedCommandDecisionRequest,
  replayed: boolean,
): RejectedCommandDecisionResult | null {
  const command = findCommand(transaction, request.expectedCommandId);
  if (command === null || command.state === "awaiting_order") return null;
  const adjudication = findAdjudication(transaction, command.sourceRef);
  if (
    adjudication === null ||
    adjudication.state !== "deciding" ||
    adjudication.commandSeq !== request.expectedCommandSeq ||
    adjudication.commandResultPreparationId === null ||
    command.commandSeq !== request.expectedCommandSeq ||
    command.disposition !== "rejected"
  ) {
    throw new CommandAdjudicationRepositoryConflictError(
      "existing decision does not match the requested command sequence",
    );
  }
  const preparation = findPreparation(transaction, adjudication.commandResultPreparationId);
  if (preparation === null) {
    throw new CommandAdjudicationRepositoryPersistenceError("decision preparation is absent");
  }
  const signingGroup = findGroup(transaction, preparation.compoundSigningGroupId);
  const signatureReservation = findReservation(
    transaction,
    preparation.collaborationServerId,
    preparation.signerSequence,
  );
  if (
    signingGroup === null ||
    signatureReservation === null ||
    preparation.signerSequence !== request.expectedSignerSequence ||
    preparation.signingLeaseId !== request.expectedSigningLeaseId ||
    signingGroup.resultPreparationRef !== preparation.commandResultPreparationId ||
    signatureReservation.purpose !== "collaboration_command_result"
  ) {
    throw new CommandAdjudicationRepositoryConflictError(
      "existing decision signer graph does not match the requested reservation",
    );
  }
  const ready = assertExactReadyGraph(
    transaction,
    machineIdentityId,
    {
      fence: request.fence,
      stableSemanticResultId: command.sourceRef,
      expectedReadyAtJournalSeq: command.readyAtJournalSeq,
    },
    true,
  );
  if (ready === null) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "decided command lost its exact ready graph",
    );
  }
  if (
    command.decisionEvidenceRef === null ||
    command.decisionEvidenceDigest === null ||
    command.canonicalCommandRecordDigest === null ||
    adjudication.commandResultId === null
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "decided command evidence tuple is partial",
    );
  }
  const expectedEvidence = canonicalA1CommandDecisionEvidence(rejectedDecisionEvidence(command));
  const evidenceSnapshot = readCanonicalArtifact(
    transaction,
    command.collaborationServerId,
    command.decisionEvidenceRef,
    A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    command.decisionEvidenceDigest,
  );
  try {
    if (
      digestBytes(expectedEvidence) !== command.decisionEvidenceDigest ||
      !equalSnapshot(evidenceSnapshot, expectedEvidence)
    ) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "rejected decision evidence does not recompute",
      );
    }
  } finally {
    expectedEvidence.fill(0);
    evidenceSnapshot.destroy();
  }
  const commandBytes = canonicalA1CommandRecord(
    commandContractRecord(
      command,
      request.expectedCommandSeq,
      "rejected",
      command.decisionEvidenceDigest,
    ),
  );
  try {
    if (digestBytes(commandBytes) !== command.canonicalCommandRecordDigest) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "canonical rejected command record does not recompute",
      );
    }
  } finally {
    commandBytes.fill(0);
  }
  const expectedResultId = deriveCollaborationCommandResultId(
    command.collaborationServerId,
    command.commandId,
  );
  const signingIdentity = {
    collaborationServerId: command.collaborationServerId,
    commandId: command.commandId,
    commandResultId: expectedResultId,
    preparationGeneration: preparation.preparationGeneration,
  } as const;
  if (
    adjudication.commandResultId !== expectedResultId ||
    preparation.commandResultId !== expectedResultId ||
    preparation.commandResultPreparationId !==
      deriveCollaborationCommandResultPreparationId(signingIdentity) ||
    signingGroup.compoundSigningGroupId !==
      deriveCollaborationCommandCompoundSigningGroupId(signingIdentity)
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "command result and preparation identities do not recompute",
    );
  }
  const expectedReservationState = preparation.state;
  const expectedGroupState =
    preparation.state === "signed"
      ? "result_signed"
      : preparation.state === "aborted"
        ? "aborted"
        : "reserved";
  if (
    signatureReservation.state !== expectedReservationState ||
    signingGroup.state !== expectedGroupState ||
    (preparation.state === "bound" || preparation.state === "signed"
      ? signatureReservation.canonicalPayloadSchemaId !== A1_COMMAND_RESULT_SCHEMA_ID ||
        signatureReservation.canonicalPayloadRef !== preparation.canonicalPayloadRef ||
        signatureReservation.canonicalPayloadDigest !== preparation.canonicalPayloadDigest ||
        signatureReservation.signedArtifactType !== COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE ||
        signatureReservation.signedArtifactId !== preparation.commandResultPreparationId
      : false)
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "command result preparation lifecycle graph is inconsistent",
    );
  }
  const signer = requireCommandSignerEvidence(transaction, preparation);
  const canonicalPayload = assertExactResultPayload(transaction, preparation, signer);
  if (preparation.state === "signed") {
    try {
      if (
        signatureReservation.signature === null ||
        signatureReservation.signedRecordDigest === null
      ) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "signed result reservation is partial",
        );
      }
      verifyCommandResultSignature(
        signer.publicKey,
        canonicalPayload,
        signatureReservation.signature,
      );
      if (
        signedResultDigest(
          preparation.canonicalPayloadDigest,
          signer.identityKeyId,
          signer.keyGeneration,
          preparation.signerSequence,
          signatureReservation.signature,
        ) !== signatureReservation.signedRecordDigest
      ) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "signed command-result digest does not recompute",
        );
      }
    } catch (error) {
      canonicalPayload.destroy();
      throw error;
    }
  }
  return frozen({
    adjudication,
    command,
    preparation,
    signingGroup,
    signatureReservation,
    canonicalPayload,
    replayed,
  });
}

function exactPreparationMutationResult(
  transaction: HostStateRepositorySqlTransaction,
  commandResultPreparationId: A1SafeId,
  _acceptedStates: readonly CollaborationCommandResultPreparationRecord["state"][],
  replayed: boolean,
): RejectedCommandPreparationMutationResult | null {
  const preparation = findPreparation(transaction, commandResultPreparationId);
  if (preparation === null) return null;
  const signingGroup = findGroup(transaction, preparation.compoundSigningGroupId);
  const signatureReservation = findReservation(
    transaction,
    preparation.collaborationServerId,
    preparation.signerSequence,
  );
  if (
    signingGroup === null ||
    signatureReservation === null ||
    signingGroup.resultPreparationRef !== preparation.commandResultPreparationId ||
    signingGroup.commandResultId !== preparation.commandResultId ||
    signingGroup.commandId !== preparation.commandId ||
    signingGroup.preparationGeneration !== preparation.preparationGeneration ||
    signingGroup.signingLeaseId !== preparation.signingLeaseId ||
    signatureReservation.signingLeaseId !== preparation.signingLeaseId ||
    signatureReservation.purpose !== "collaboration_command_result"
  ) {
    throw new CommandAdjudicationRepositoryConflictError(
      "result preparation graph does not match the requested generation",
    );
  }
  const expectedReservationState = preparation.state;
  const expectedGroupState =
    preparation.state === "signed"
      ? "result_signed"
      : preparation.state === "aborted"
        ? "aborted"
        : "reserved";
  const reservationMustBeBound = preparation.boundAtMs !== null;
  if (
    signatureReservation.state !== expectedReservationState ||
    signingGroup.state !== expectedGroupState ||
    signatureReservation.reservedAtMs !== preparation.preparedAtMs ||
    signingGroup.reservedAtMs !== preparation.preparedAtMs ||
    signatureReservation.boundAtMs !== preparation.boundAtMs ||
    signatureReservation.signedAtMs !== preparation.signedAtMs ||
    signingGroup.resultSignedAtMs !== preparation.signedAtMs ||
    signatureReservation.abortedAtMs !== preparation.abortedAtMs ||
    signingGroup.abortedAtMs !== preparation.abortedAtMs ||
    (reservationMustBeBound
      ? signatureReservation.canonicalPayloadSchemaId !== A1_COMMAND_RESULT_SCHEMA_ID ||
        signatureReservation.canonicalPayloadRef !== preparation.canonicalPayloadRef ||
        signatureReservation.canonicalPayloadDigest !== preparation.canonicalPayloadDigest ||
        signatureReservation.signedArtifactType !== COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE ||
        signatureReservation.signedArtifactId !== preparation.commandResultPreparationId
      : signatureReservation.canonicalPayloadSchemaId !== null ||
        signatureReservation.canonicalPayloadRef !== null ||
        signatureReservation.canonicalPayloadDigest !== null ||
        signatureReservation.signedArtifactType !== null ||
        signatureReservation.signedArtifactId !== null)
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "result preparation lifecycle graph is inconsistent",
    );
  }
  return frozen({ preparation, signingGroup, signatureReservation, replayed });
}

interface CommandSignerEvidence {
  readonly publicKey: Ed25519PublicKey;
  readonly identityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly scopeCertificateId: A1SafeId;
}

function requireCommandSignerEvidence(
  transaction: HostStateRepositorySqlTransaction,
  preparation: CollaborationCommandResultPreparationRecord,
): CommandSignerEvidence {
  const value = sqlGet(
    transaction,
    `SELECT identity_key.identity_key_id, identity_key.key_generation,
            identity_key.public_key, signing_lease.scope_certificate_id
       FROM server_signing_leases AS signing_lease
       JOIN server_identity_keys AS identity_key
         ON identity_key.collaboration_server_id = signing_lease.collaboration_server_id
        AND identity_key.identity_key_id = signing_lease.identity_key_id
        AND identity_key.key_generation = signing_lease.key_generation
      WHERE signing_lease.signing_lease_id = ?
        AND signing_lease.collaboration_server_id = ?
        AND identity_key.state = 'current' LIMIT 1`,
    [preparation.signingLeaseId, preparation.collaborationServerId],
  );
  const row = rawRow(
    value,
    ["identity_key_id", "key_generation", "public_key", "scope_certificate_id"],
    "commandSignerEvidence",
  );
  return frozen({
    publicKey: parseEd25519PublicKey(row.public_key, "commandSignerEvidence.publicKey"),
    identityKeyId: parseA1SafeId(row.identity_key_id, "commandSignerEvidence.identityKeyId"),
    keyGeneration: parseNonNegativeSafeInteger(
      row.key_generation,
      "commandSignerEvidence.keyGeneration",
    ),
    scopeCertificateId: parseA1SafeId(
      row.scope_certificate_id,
      "commandSignerEvidence.scopeCertificateId",
    ),
  });
}

function assertExactResultPayload(
  transaction: HostStateRepositorySqlTransaction,
  preparation: CollaborationCommandResultPreparationRecord,
  signer: CommandSignerEvidence,
): ProtectedByteSnapshot {
  const command = findCommand(transaction, preparation.commandId);
  if (
    command === null ||
    (command.state !== "decision_reserved" && command.state !== "decided") ||
    command.canonicalCommandRecordDigest !== preparation.canonicalCommandRecordDigest
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "result preparation lost its frozen command decision",
    );
  }
  const expectedPayload = resultPayloadContract({
    commandResultId: preparation.commandResultId,
    command,
    createdAtMs: preparation.preparedAtMs,
    signerSequence: preparation.signerSequence,
    serverKeyGeneration: signer.keyGeneration,
    signerIdentityKeyId: signer.identityKeyId,
    signerScopeCertificateId: signer.scopeCertificateId,
  });
  const expectedBytes = canonicalA1CommandResultPayload(expectedPayload);
  const expectedDigest = digestBytes(expectedBytes);
  const snapshot = readCanonicalArtifact(
    transaction,
    preparation.collaborationServerId,
    preparation.canonicalPayloadRef,
    A1_COMMAND_RESULT_SCHEMA_ID,
    preparation.canonicalPayloadDigest,
  );
  try {
    if (
      expectedDigest !== preparation.canonicalPayloadDigest ||
      !equalSnapshot(snapshot, expectedBytes)
    ) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "result payload does not recompute from the frozen command and signer",
      );
    }
    return snapshot;
  } catch (error) {
    snapshot.destroy();
    throw error;
  } finally {
    expectedBytes.fill(0);
  }
}

function verifyCommandResultSignature(
  publicKey: Ed25519PublicKey,
  payload: ProtectedByteSnapshot,
  signature: Ed25519Signature,
): void {
  const payloadBytes = payload.copyBytes();
  const signatureBytes = base64urlDecode(signature);
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    });
    if (!verify(null, payloadBytes, key, signatureBytes)) {
      throw new CommandAdjudicationRepositoryConflictError(
        "command-result signature does not verify under the reserved server key",
      );
    }
  } catch (error) {
    if (error instanceof CommandAdjudicationRepositoryConflictError) throw error;
    throw new CommandAdjudicationRepositoryConflictError(
      "command-result signature could not be verified under the reserved server key",
    );
  } finally {
    payloadBytes.fill(0);
    signatureBytes.fill(0);
  }
}

interface SignedFinalizationSource {
  readonly command: CollaborationCommandRecord;
  readonly adjudication: A1IngressAdjudicationRecord;
  readonly ingress: FinalizationIngress;
  readonly preparation: CollaborationCommandResultPreparationRecord;
  readonly signingGroup: CollaborationCommandCompoundSigningGroupRecord;
  readonly signatureReservation: ServerSignatureReservationRecord;
  readonly signer: CommandSignerEvidence;
}

function requireSignedFinalizationSource(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: FinalizeSignedRejectedCommandResultRequest,
): SignedFinalizationSource {
  const command = findCommand(transaction, request.expectedCommandId);
  if (command === null) {
    throw new CommandAdjudicationRepositoryConflictError("finalization command is unknown");
  }
  if (
    (command.state !== "decision_reserved" && command.state !== "decided") ||
    command.disposition !== "rejected" ||
    command.commandSeq === null ||
    command.canonicalCommandRecordDigest === null ||
    command.decisionEvidenceRef === null ||
    command.decisionEvidenceDigest === null ||
    (command.state === "decision_reserved" && command.currentCommandResultId !== null) ||
    (command.state === "decided" &&
      command.currentCommandResultId !== request.expectedCommandResultId)
  ) {
    throw new CommandAdjudicationRepositoryConflictError(
      "finalization command is not the exact frozen rejected decision",
    );
  }
  const expectedResultId = deriveCollaborationCommandResultId(
    command.collaborationServerId,
    command.commandId,
  );
  if (expectedResultId !== request.expectedCommandResultId) {
    throw new CommandAdjudicationRepositoryConflictError(
      "finalization command result identity does not recompute",
    );
  }
  const adjudication = findAdjudication(transaction, command.sourceRef);
  if (
    adjudication === null ||
    (adjudication.state !== "deciding" && adjudication.state !== "terminal") ||
    adjudication.commandId !== command.commandId ||
    adjudication.commandSeq !== command.commandSeq ||
    adjudication.disposition !== "rejected" ||
    adjudication.commandResultId !== expectedResultId ||
    adjudication.commandResultPreparationId !== request.expectedCommandResultPreparationId ||
    (command.state === "decision_reserved") !== (adjudication.state === "deciding")
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "finalization command and ingress adjudication lifecycle are inconsistent",
    );
  }
  const ingress = findFinalizationIngress(transaction, command.sourceRef);
  if (
    ingress === null ||
    ingress.collaborationServerId !== command.collaborationServerId ||
    ingress.scopeKind !== command.scopeKind ||
    ingress.logicalChatId !== command.logicalChatId ||
    ingress.sourceEventNamespaceId !== command.sourceEventNamespaceId ||
    ingress.messageId !== command.sourceEventId ||
    command.targetLogicalChatId !== ingress.logicalChatId
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "finalization command lost its exact retained ingress source",
    );
  }
  const retainedIngress: AwaitingIngressResult = frozen({
    stableSemanticResultId: ingress.stableSemanticResultId,
    brokerRouteId: ingress.brokerRouteId,
    collaborationServerId: ingress.collaborationServerId,
    scopeKind: ingress.scopeKind,
    logicalChatId: ingress.logicalChatId,
    sourceEventNamespaceId: ingress.sourceEventNamespaceId,
    messageId: ingress.messageId,
    recordKind: ingress.recordKind,
    acceptedDeliveryAttemptId: ingress.acceptedDeliveryAttemptId,
    sourcePayloadSchemaId: ingress.sourcePayloadSchemaId,
    canonicalMessageDigest: ingress.canonicalMessageDigest,
    sourceEventFingerprint: ingress.sourceEventFingerprint,
    firstIngressGeneration: ingress.firstIngressGeneration,
    firstIngressFrameIndex: ingress.firstIngressFrameIndex,
  });
  const expectedCommandPayload = commonPayloadForRejectedIngress(retainedIngress);
  const expectedSourceDigest = deriveSourceCommandIdentityDigest(
    machineIdentityId,
    retainedIngress,
  );
  const expectedCommandId = deriveCommandId(command.collaborationServerId, expectedSourceDigest);
  const commandPayload = readCanonicalArtifact(
    transaction,
    command.collaborationServerId,
    command.canonicalCommandPayloadRef,
    expectedCommandPayload.schemaId,
    expectedCommandPayload.digest,
  );
  try {
    if (
      command.commandId !== expectedCommandId ||
      command.sourceCommandIdentityDigest !== expectedSourceDigest ||
      command.mutationFamily !== expectedCommandPayload.mutationFamily ||
      command.canonicalCommandPayloadSchemaId !== expectedCommandPayload.schemaId ||
      command.canonicalCommandPayloadDigest !== expectedCommandPayload.digest ||
      !equalSnapshot(commandPayload, expectedCommandPayload.bytes)
    ) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "finalization command does not recompute from retained ingress evidence",
      );
    }
  } finally {
    commandPayload.destroy();
    expectedCommandPayload.bytes.fill(0);
  }
  const decisionEvidenceBytes = canonicalA1CommandDecisionEvidence(
    rejectedDecisionEvidence(command),
  );
  const decisionEvidence = readCanonicalArtifact(
    transaction,
    command.collaborationServerId,
    command.decisionEvidenceRef,
    A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    command.decisionEvidenceDigest,
  );
  try {
    if (
      digestBytes(decisionEvidenceBytes) !== command.decisionEvidenceDigest ||
      !equalSnapshot(decisionEvidence, decisionEvidenceBytes)
    ) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "finalization decision evidence does not recompute",
      );
    }
  } finally {
    decisionEvidence.destroy();
    decisionEvidenceBytes.fill(0);
  }
  const commandRecordBytes = canonicalA1CommandRecord(
    commandContractRecord(command, command.commandSeq, "rejected", command.decisionEvidenceDigest),
  );
  try {
    if (digestBytes(commandRecordBytes) !== command.canonicalCommandRecordDigest) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "finalization canonical command record does not recompute",
      );
    }
  } finally {
    commandRecordBytes.fill(0);
  }
  const preparation = findPreparation(transaction, request.expectedCommandResultPreparationId);
  if (
    preparation === null ||
    preparation.state !== "signed" ||
    preparation.commandId !== command.commandId ||
    preparation.commandResultId !== expectedResultId ||
    preparation.canonicalCommandRecordDigest !== command.canonicalCommandRecordDigest
  ) {
    throw new CommandAdjudicationRepositoryConflictError(
      "finalization requires the exact signed command-result preparation",
    );
  }
  const signingGroup = findGroup(transaction, preparation.compoundSigningGroupId);
  const signatureReservation = findReservation(
    transaction,
    preparation.collaborationServerId,
    preparation.signerSequence,
  );
  if (
    signingGroup === null ||
    signatureReservation === null ||
    signingGroup.state !== "result_signed" ||
    signingGroup.resultPreparationRef !== preparation.commandResultPreparationId ||
    signingGroup.commandResultId !== preparation.commandResultId ||
    signingGroup.commandId !== preparation.commandId ||
    signingGroup.signingLeaseId !== preparation.signingLeaseId ||
    signatureReservation.state !== "signed" ||
    signatureReservation.signingLeaseId !== preparation.signingLeaseId ||
    signatureReservation.purpose !== "collaboration_command_result" ||
    signatureReservation.canonicalPayloadSchemaId !== A1_COMMAND_RESULT_SCHEMA_ID ||
    signatureReservation.canonicalPayloadRef !== preparation.canonicalPayloadRef ||
    signatureReservation.canonicalPayloadDigest !== preparation.canonicalPayloadDigest ||
    signatureReservation.signedArtifactType !== COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE ||
    signatureReservation.signedArtifactId !== preparation.commandResultPreparationId ||
    signatureReservation.signature === null ||
    signatureReservation.signedRecordDigest !== request.expectedSignedRecordDigest
  ) {
    throw new CommandAdjudicationRepositoryConflictError(
      "finalization signed reservation graph does not match the request",
    );
  }
  const signer = requireCommandSignerEvidence(transaction, preparation);
  const canonicalPayload = assertExactResultPayload(transaction, preparation, signer);
  try {
    verifyCommandResultSignature(
      signer.publicKey,
      canonicalPayload,
      signatureReservation.signature,
    );
  } finally {
    canonicalPayload.destroy();
  }
  if (
    signedResultDigest(
      preparation.canonicalPayloadDigest,
      signer.identityKeyId,
      signer.keyGeneration,
      preparation.signerSequence,
      signatureReservation.signature,
    ) !== request.expectedSignedRecordDigest
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "finalization signed command-result digest does not recompute",
    );
  }
  return frozen({
    command,
    adjudication,
    ingress,
    preparation,
    signingGroup,
    signatureReservation,
    signer,
  });
}

function assertExactFinalizedRejectedResult(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: FinalizeSignedRejectedCommandResultRequest,
  replayed: boolean,
): FinalizedRejectedCommandResult | null {
  const commonResult = findCommonResult(transaction, request.expectedCommandResultId);
  if (commonResult === null) {
    const command = findCommand(transaction, request.expectedCommandId);
    if (command === null) return null;
    const adjudication = findAdjudication(transaction, command.sourceRef);
    const preparation = findPreparation(transaction, request.expectedCommandResultPreparationId);
    const acceptance =
      preparation === null
        ? null
        : findAcceptanceBySignerSequence(
            transaction,
            preparation.collaborationServerId,
            preparation.signerSequence,
          );
    const terminalResult = findTerminalResult(transaction, command.sourceRef);
    const delivery = findResultDeliveryByCommandResult(
      transaction,
      request.expectedCommandResultId,
    );
    if (
      command.state === "decided" ||
      adjudication?.state === "terminal" ||
      acceptance !== null ||
      terminalResult !== null ||
      delivery !== null
    ) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "finalized rejected command-result graph is partial",
      );
    }
    return null;
  }
  const source = requireSignedFinalizationSource(transaction, machineIdentityId, request);
  const signerAcceptance = findAcceptanceBySignerSequence(
    transaction,
    source.preparation.collaborationServerId,
    source.preparation.signerSequence,
  );
  const terminalResult = findTerminalResult(transaction, source.ingress.stableSemanticResultId);
  if (signerAcceptance === null || terminalResult === null) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "finalized rejected command-result graph is partial",
    );
  }
  const resultDelivery = findResultDelivery(transaction, terminalResult.initialResultDeliveryId);
  if (resultDelivery === null) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "finalized rejected command-result delivery is absent",
    );
  }
  if (
    source.command.state !== "decided" ||
    source.command.currentCommandResultId !== commonResult.commandResultId ||
    source.adjudication.state !== "terminal" ||
    commonResult.commandResultId !== request.expectedCommandResultId ||
    commonResult.commandId !== request.expectedCommandId ||
    commonResult.commandResultPreparationId !== request.expectedCommandResultPreparationId ||
    commonResult.collaborationServerId !== source.command.collaborationServerId ||
    commonResult.canonicalCommandRecordDigest !== source.command.canonicalCommandRecordDigest ||
    commonResult.sourceRef !== source.command.sourceRef ||
    commonResult.scopeKind !== source.command.scopeKind ||
    commonResult.logicalChatId !== source.command.logicalChatId ||
    commonResult.targetLogicalChatId !== source.command.targetLogicalChatId ||
    commonResult.commandSeq !== source.command.commandSeq ||
    commonResult.canonicalPayloadRef !== source.preparation.canonicalPayloadRef ||
    commonResult.canonicalPayloadDigest !== source.preparation.canonicalPayloadDigest ||
    commonResult.compoundSigningGroupId !== source.preparation.compoundSigningGroupId ||
    commonResult.signerSequence !== source.preparation.signerSequence ||
    commonResult.serverKeyGeneration !== source.signer.keyGeneration ||
    commonResult.signerIdentityKeyId !== source.signer.identityKeyId ||
    commonResult.signerScopeCertificateId !== source.signer.scopeCertificateId ||
    commonResult.signature !== source.signatureReservation.signature ||
    commonResult.signedRecordDigest !== request.expectedSignedRecordDigest ||
    commonResult.acceptedAtJournalSeq !== request.expectedAcceptedAtJournalSeq ||
    commonResult.createdAtMs !== source.preparation.preparedAtMs ||
    commonResult.finalizedAtMs !== terminalResult.terminalAtMs ||
    signerAcceptance.collaborationServerId !== source.command.collaborationServerId ||
    signerAcceptance.acceptedAtJournalSeq !== request.expectedAcceptedAtJournalSeq ||
    signerAcceptance.signedRecordDigest !== request.expectedSignedRecordDigest ||
    signerAcceptance.signerIdentityKeyId !== source.signer.identityKeyId ||
    signerAcceptance.signerKeyGeneration !== source.signer.keyGeneration ||
    signerAcceptance.signerScopeCertificateId !== source.signer.scopeCertificateId ||
    signerAcceptance.signerSequence !== source.preparation.signerSequence ||
    signerAcceptance.historicalReattestationId !== null ||
    signerAcceptance.acceptedAtMs !== terminalResult.terminalAtMs
  ) {
    throw new CommandAdjudicationRepositoryConflictError(
      "finalized common result or signer acceptance does not exactly match the request",
    );
  }
  const acceptancePrefix = rawRow(
    sqlGet(
      transaction,
      `SELECT COUNT(*) AS accepted_count,
              MIN(accepted_at_journal_seq) AS minimum_seq
         FROM server_signed_record_acceptances
        WHERE collaboration_server_id = ? AND accepted_at_journal_seq <= ?`,
      [source.command.collaborationServerId, request.expectedAcceptedAtJournalSeq],
    ),
    ["accepted_count", "minimum_seq"],
    "signedRecordAcceptancePrefix",
  );
  if (
    acceptancePrefix.accepted_count !== request.expectedAcceptedAtJournalSeq + 1 ||
    acceptancePrefix.minimum_seq !== 0
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "signed-record acceptance journal is not a dense zero-based prefix",
    );
  }
  const completion = selectCompletionObservation(transaction, source.ingress);
  const expectedResultDeliveryId = deriveResultDeliveryId(
    source.ingress.stableSemanticResultId,
    completion.triggerIngressObservationId,
  );
  if (
    terminalResult.stableSemanticResultId !== source.ingress.stableSemanticResultId ||
    terminalResult.collaborationServerId !== source.command.collaborationServerId ||
    terminalResult.brokerRouteId !== source.ingress.brokerRouteId ||
    terminalResult.commandId !== source.command.commandId ||
    terminalResult.commandResultId !== commonResult.commandResultId ||
    terminalResult.acceptedIngressDeliveryAttemptId !== source.ingress.acceptedDeliveryAttemptId ||
    terminalResult.triggerIngressObservationId !== completion.triggerIngressObservationId ||
    terminalResult.initialResultDeliveryId !== expectedResultDeliveryId ||
    resultDelivery.resultDeliveryId !== expectedResultDeliveryId ||
    resultDelivery.stableSemanticResultId !== source.ingress.stableSemanticResultId ||
    resultDelivery.sourceRef !== source.ingress.stableSemanticResultId ||
    resultDelivery.commandResultId !== commonResult.commandResultId ||
    resultDelivery.triggerIngressObservationId !== completion.triggerIngressObservationId ||
    resultDelivery.brokerRouteId !== source.ingress.brokerRouteId ||
    resultDelivery.targetRef !== source.ingress.brokerRouteId ||
    resultDelivery.createdAtMs !== terminalResult.terminalAtMs
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "finalized terminal result or delivery identity does not recompute",
    );
  }
  const coordinator = rawRow(
    sqlGet(
      transaction,
      `SELECT acquired_at_ms, heartbeat_deadline_ms, released_at_ms
         FROM coordinator_leases
        WHERE coordinator_lease_id = ? AND collaboration_server_id = ?
          AND coordinator_epoch = ? LIMIT 1`,
      [
        terminalResult.finalizationCoordinatorLeaseId,
        terminalResult.collaborationServerId,
        terminalResult.finalizationCoordinatorEpoch,
      ],
    ),
    ["acquired_at_ms", "heartbeat_deadline_ms", "released_at_ms"],
    "finalizationCoordinatorEvidence",
  );
  const acquiredAtMs = parseNonNegativeSafeInteger(
    coordinator.acquired_at_ms,
    "finalizationCoordinatorEvidence.acquiredAtMs",
  );
  const heartbeatDeadlineMs = parseNonNegativeSafeInteger(
    coordinator.heartbeat_deadline_ms,
    "finalizationCoordinatorEvidence.heartbeatDeadlineMs",
  );
  const releasedAtMs =
    coordinator.released_at_ms === null
      ? null
      : parseNonNegativeSafeInteger(
          coordinator.released_at_ms,
          "finalizationCoordinatorEvidence.releasedAtMs",
        );
  if (
    terminalResult.terminalAtMs < acquiredAtMs ||
    terminalResult.terminalAtMs >= heartbeatDeadlineMs ||
    (releasedAtMs !== null && terminalResult.terminalAtMs > releasedAtMs)
  ) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "terminal result does not retain a valid finalization coordinator fence",
    );
  }
  const semantic = prepareRejectedSemanticResult(source.ingress, source.command);
  const semanticPayload = readCanonicalArtifact(
    transaction,
    source.command.collaborationServerId,
    terminalResult.semanticResultPayloadRef,
    semantic.payloadSchemaId,
    semantic.payloadArtifactDigest,
  );
  try {
    if (
      terminalResult.semanticResultRecordKind !== semantic.recordKind ||
      terminalResult.semanticResultPayloadSchemaId !== semantic.payloadSchemaId ||
      terminalResult.semanticResultPayloadArtifactDigest !== semantic.payloadArtifactDigest ||
      terminalResult.storedSemanticResultDigest !== semantic.storedSemanticResultDigest ||
      resultDelivery.semanticResultRecordKind !== semantic.recordKind ||
      resultDelivery.semanticResultPayloadSchemaId !== semantic.payloadSchemaId ||
      resultDelivery.semanticResultPayloadRef !== terminalResult.semanticResultPayloadRef ||
      resultDelivery.semanticResultPayloadArtifactDigest !== semantic.payloadArtifactDigest ||
      resultDelivery.storedSemanticResultDigest !== semantic.storedSemanticResultDigest ||
      !equalSnapshot(semanticPayload, semantic.payloadBytes)
    ) {
      throw new CommandAdjudicationRepositoryPersistenceError(
        "terminal A1 semantic result payload does not exactly recompute",
      );
    }
  } finally {
    semanticPayload.destroy();
    semantic.payloadBytes.fill(0);
  }
  return frozen({
    command: source.command,
    adjudication: source.adjudication,
    commonResult,
    signerAcceptance,
    terminalResult,
    resultDelivery,
    replayed,
  });
}

function exactReplacementResult(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: ReserveReplacementRejectedCommandResultPreparationRequest,
  replayed: boolean,
): RejectedCommandDecisionResult | null {
  const prior = findPreparation(transaction, request.expectedPriorPreparationId);
  if (prior === null) return null;
  const command = findCommand(transaction, prior.commandId);
  if (command === null || command.commandSeq === null) {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "replacement preparation lost its frozen command",
    );
  }
  const adjudication = findAdjudication(transaction, command.sourceRef);
  if (adjudication === null || adjudication.state !== "deciding") {
    throw new CommandAdjudicationRepositoryPersistenceError(
      "replacement preparation lost its deciding ingress sidecar",
    );
  }
  if (adjudication.commandResultPreparationId === prior.commandResultPreparationId) return null;
  const expectedIdentity = {
    collaborationServerId: prior.collaborationServerId,
    commandId: prior.commandId,
    commandResultId: prior.commandResultId,
    preparationGeneration: prior.preparationGeneration + 1,
  } as const;
  const expectedPreparationId = deriveCollaborationCommandResultPreparationId(expectedIdentity);
  if (adjudication.commandResultPreparationId !== expectedPreparationId) {
    throw new CommandAdjudicationRepositoryConflictError(
      "deciding sidecar points to another replacement generation",
    );
  }
  return exactDecisionResult(
    transaction,
    machineIdentityId,
    {
      fence: request.fence,
      expectedCommandId: prior.commandId,
      expectedCommandSeq: command.commandSeq,
      expectedSignerSequence: request.expectedSignerSequence,
      expectedSigningLeaseId: request.expectedSigningLeaseId,
    },
    replayed,
  );
}

class BoundCommandAdjudicationRepository implements CommandAdjudicationRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #nowMs: () => number;
  readonly #randomBytes: ((byteLength: number) => Uint8Array) | undefined;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    options: CommandAdjudicationRepositoryOptions = {},
  ) {
    if (
      typeof executor !== "object" ||
      executor === null ||
      typeof executor.transaction !== "function"
    ) {
      throw new HostStateContractError(
        "command adjudication repository executor must provide transaction",
      );
    }
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#nowMs = options.nowMs ?? Date.now;
    this.#randomBytes = options.randomBytes;
  }

  materializeReadyIngressCommand(
    requestValue: MaterializeReadyA1IngressCommandRequest,
  ): ReadyA1IngressCommandResult {
    const request = parseReadyRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const authority = requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        request.fence,
        this.#nowMs,
      );
      const replay = assertExactReadyGraph(transaction, this.#machineIdentityId, request, true);
      if (replay !== null) return replay;
      if (request.expectedReadyAtJournalSeq !== authority.nextJournalOffset) {
        throw new CommandAdjudicationRepositoryConflictError(
          "ready journal sequence compare-and-swap failed",
        );
      }
      const ingress = findAwaitingIngress(transaction, request.stableSemanticResultId);
      if (ingress === null || ingress.collaborationServerId !== authority.collaborationServerId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "awaiting ingress source is absent from the fenced server",
        );
      }
      const routeUpdatedAtMs = assertRouteHeadEligible(transaction, ingress);
      const createdAtMs = Math.max(authority.nowMs, routeUpdatedAtMs);
      if (createdAtMs >= authority.heartbeatDeadlineMs) {
        throw new CommandAdjudicationStaleCoordinatorError();
      }
      const payload = commonPayloadForRejectedIngress(ingress);
      const sourceDigest = deriveSourceCommandIdentityDigest(this.#machineIdentityId, ingress);
      const selectedCommandId = deriveCommandId(ingress.collaborationServerId, sourceDigest);
      let payloadRef: A1SafeId;
      try {
        payloadRef = putCanonicalArtifact(
          transaction,
          ingress.collaborationServerId,
          payload.schemaId,
          payload.digest,
          payload.bytes,
          this.#randomBytes,
          createdAtMs,
        );
      } finally {
        payload.bytes.fill(0);
      }
      const targetLogicalChatId = ingress.scopeKind === "chat" ? ingress.logicalChatId : null;
      runExactlyOne(
        transaction,
        `INSERT INTO collaboration_commands (
          command_id, collaboration_server_id, scope_kind, logical_chat_id,
          target_logical_chat_id, source_kind, source_ref,
          source_event_namespace_id, source_event_id, source_command_identity_digest,
          canonical_source_event_digest, mutation_family,
          canonical_command_payload_schema_id, canonical_command_payload_ref,
          canonical_command_payload_digest,
          pre_decision_normalization_evidence_schema_id,
          pre_decision_normalization_evidence_ref,
          pre_decision_normalization_evidence_digest, ready_at_journal_seq,
          command_seq, disposition, admitted_target_kind,
          project_target_selector_mapping_id, project_target_selector_mapping_generation,
          project_target_digest, selected_executor_evidence_schema_id,
          selected_executor_evidence_ref, selected_executor_evidence_digest,
          target_capability_snapshot_id, target_capability_family_digest,
          current_command_result_id, decision_evidence_schema_id,
          decision_evidence_ref, decision_evidence_digest,
          canonical_command_record_digest, coordinator_lease_id, coordinator_epoch,
          decision_coordinator_lease_id, decision_coordinator_epoch,
          created_at_ms, decided_at_ms, state
        ) VALUES (?, ?, ?, ?, ?, 'a1_ingress', ?, ?, ?, ?, NULL, ?, ?, ?, ?,
                  NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL,
                  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                  ?, ?, NULL, NULL, ?, NULL, 'awaiting_order')`,
        [
          selectedCommandId,
          ingress.collaborationServerId,
          ingress.scopeKind,
          ingress.logicalChatId,
          targetLogicalChatId,
          ingress.stableSemanticResultId,
          ingress.sourceEventNamespaceId,
          ingress.messageId,
          sourceDigest,
          payload.mutationFamily,
          payload.schemaId,
          payloadRef,
          payload.digest,
          request.expectedReadyAtJournalSeq,
          request.fence.coordinatorLeaseId,
          request.fence.coordinatorEpoch,
          createdAtMs,
        ],
        "collaboration command insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO command_ready_entries (
          collaboration_server_id, ready_at_journal_seq, command_id,
          stable_semantic_result_id, coordinator_lease_id, coordinator_epoch, ready_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          ingress.collaborationServerId,
          request.expectedReadyAtJournalSeq,
          selectedCommandId,
          ingress.stableSemanticResultId,
          request.fence.coordinatorLeaseId,
          request.fence.coordinatorEpoch,
          createdAtMs,
        ],
        "command ready insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO a1_ingress_adjudications (
          stable_semantic_result_id, collaboration_server_id, command_id,
          ready_at_journal_seq, command_seq, disposition, command_result_id,
          command_result_preparation_id, viewer_projection_seq, decided_at_ms,
          terminal_at_ms, state
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'awaiting_order')`,
        [
          ingress.stableSemanticResultId,
          ingress.collaborationServerId,
          selectedCommandId,
          request.expectedReadyAtJournalSeq,
        ],
        "A1 ingress adjudication insert",
      );
      const landed = assertExactReadyGraph(transaction, this.#machineIdentityId, request, false);
      if (landed === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "ready graph disappeared in its transaction",
        );
      }
      return landed;
    });
  }

  reconcileReadyIngressCommand(
    requestValue: MaterializeReadyA1IngressCommandRequest,
  ): ReadyA1IngressCommandResult | null {
    const request = parseReadyRequest(requestValue);
    return this.#executor.transaction((transaction) =>
      assertExactReadyGraph(transaction, this.#machineIdentityId, request, true),
    );
  }

  reserveRejectedDecision(
    requestValue: ReserveRejectedCommandDecisionRequest,
  ): RejectedCommandDecisionResult {
    const request = parseReserveDecisionRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const authority = requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        request.fence,
        this.#nowMs,
      );
      const replay = exactDecisionResult(transaction, this.#machineIdentityId, request, true);
      if (replay !== null) return replay;
      if (
        authority.nextCommandSeq !== request.expectedCommandSeq ||
        authority.nextServerSignatureSeq !== request.expectedSignerSequence
      ) {
        throw new CommandAdjudicationRepositoryConflictError(
          "command or signer sequence compare-and-swap failed",
        );
      }
      const lease = requireCurrentSigningLease(transaction, authority);
      if (lease.signingLeaseId !== request.expectedSigningLeaseId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "requested signer lease is not the current lease",
        );
      }
      const headValue = sqlGet(
        transaction,
        `SELECT command_id FROM collaboration_commands
          WHERE collaboration_server_id = ? AND state = 'awaiting_order'
          ORDER BY ready_at_journal_seq, command_id LIMIT 1`,
        [authority.collaborationServerId],
      );
      const head = rawRow(headValue, ["command_id"], "globalCommandHead");
      if (head.command_id !== request.expectedCommandId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "requested command is not the server-wide ready-order head",
        );
      }
      const command = findCommand(transaction, request.expectedCommandId);
      if (command === null || command.state !== "awaiting_order") {
        throw new CommandAdjudicationRepositoryConflictError("command is not awaiting order");
      }
      const ingress = findAwaitingIngress(transaction, command.sourceRef);
      if (ingress === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "ready command lost its retained ingress source",
        );
      }
      const runtime = rawRow(
        sqlGet(
          transaction,
          `SELECT state, active_gap_count, updated_at_ms
             FROM broker_route_runtime_status WHERE broker_route_id = ? LIMIT 1`,
          [ingress.brokerRouteId],
        ),
        ["state", "active_gap_count", "updated_at_ms"],
        "decisionRouteStatus",
      );
      if (runtime.state !== "current" || runtime.active_gap_count !== 0) {
        throw new CommandAdjudicationRepositoryConflictError(
          "command source route is blocked by an active gap",
        );
      }
      const decidedAtMs = Math.max(
        authority.nowMs,
        lease.acquiredAtMs,
        command.createdAtMs,
        parseNonNegativeSafeInteger(runtime.updated_at_ms, "decisionRouteStatus.updatedAtMs"),
      );
      if (decidedAtMs >= authority.heartbeatDeadlineMs) {
        throw new CommandAdjudicationStaleCoordinatorError();
      }
      const evidenceValue = rejectedDecisionEvidence(command);
      const evidenceBytes = canonicalA1CommandDecisionEvidence(evidenceValue);
      const evidenceDigest = digestBytes(evidenceBytes);
      let evidenceRef: A1SafeId;
      try {
        evidenceRef = putCanonicalArtifact(
          transaction,
          command.collaborationServerId,
          A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
          evidenceDigest,
          evidenceBytes,
          this.#randomBytes,
          decidedAtMs,
        );
      } finally {
        evidenceBytes.fill(0);
      }
      const canonicalCommandRecordDigest = digestBytes(
        canonicalA1CommandRecord(
          commandContractRecord(command, request.expectedCommandSeq, "rejected", evidenceDigest),
        ),
      );
      const decisionCommand = parseCollaborationCommandRecord({
        ...command,
        commandSeq: request.expectedCommandSeq,
        disposition: "rejected",
        decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
        decisionEvidenceRef: evidenceRef,
        decisionEvidenceDigest: evidenceDigest,
        canonicalCommandRecordDigest,
        decisionCoordinatorLeaseId: request.fence.coordinatorLeaseId,
        decisionCoordinatorEpoch: request.fence.coordinatorEpoch,
        decidedAtMs,
        state: "decision_reserved",
      });
      const commandResultId = deriveCollaborationCommandResultId(
        command.collaborationServerId,
        command.commandId,
      );
      const identity = {
        collaborationServerId: command.collaborationServerId,
        commandId: command.commandId,
        commandResultId,
        preparationGeneration: 1,
      } as const;
      const preparationIdValue = deriveCollaborationCommandResultPreparationId(identity);
      const groupIdValue = deriveCollaborationCommandCompoundSigningGroupId(identity);
      const payloadValue = resultPayloadContract({
        commandResultId,
        command: decisionCommand,
        createdAtMs: decidedAtMs,
        signerSequence: request.expectedSignerSequence,
        serverKeyGeneration: lease.keyGeneration,
        signerIdentityKeyId: lease.identityKeyId,
        signerScopeCertificateId: lease.scopeCertificateId,
      });
      const resultBytes = canonicalA1CommandResultPayload(payloadValue);
      const resultDigest = digestBytes(resultBytes);
      let resultRef: A1SafeId;
      try {
        resultRef = putCanonicalArtifact(
          transaction,
          command.collaborationServerId,
          A1_COMMAND_RESULT_SCHEMA_ID,
          resultDigest,
          resultBytes,
          this.#randomBytes,
          decidedAtMs,
        );
      } finally {
        resultBytes.fill(0);
      }
      runExactlyOne(
        transaction,
        `INSERT INTO server_signature_reservations (
          collaboration_server_id, signer_sequence, signing_lease_id,
          signing_lease_kind, purpose, canonical_payload_schema_id,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state
        ) VALUES (?, ?, ?, 'current', 'collaboration_command_result',
                  NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, 'reserved')`,
        [
          command.collaborationServerId,
          request.expectedSignerSequence,
          lease.signingLeaseId,
          decidedAtMs,
        ],
        "command-result signature reservation insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO collaboration_command_compound_signing_groups (
          compound_signing_group_id, collaboration_server_id, command_id,
          command_result_id, preparation_generation, signing_lease_id,
          result_preparation_ref, required_finalization_artifact_kind,
          secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
          both_signed_at_ms, finalized_at_ms, aborted_at_ms, state
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 'none', NULL, ?, NULL, NULL, NULL, NULL, 'reserved')`,
        [
          groupIdValue,
          command.collaborationServerId,
          command.commandId,
          commandResultId,
          lease.signingLeaseId,
          preparationIdValue,
          decidedAtMs,
        ],
        "command signing group insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO collaboration_command_result_preparations (
          command_result_preparation_id, command_result_id, collaboration_server_id,
          command_id, canonical_command_record_digest, result_version,
          preparation_generation, supersedes_preparation_ref, canonical_payload_ref,
          canonical_payload_digest, signer_sequence, signing_lease_id,
          compound_signing_group_id, required_finalization_artifact_kind,
          current_finalization_artifact_preparation_ref, prepared_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state
        ) VALUES (?, ?, ?, ?, ?, 1, 1, NULL, ?, ?, ?, ?, ?, 'none', NULL, ?,
                  NULL, NULL, NULL, 'reserved')`,
        [
          preparationIdValue,
          commandResultId,
          command.collaborationServerId,
          command.commandId,
          decisionCommand.canonicalCommandRecordDigest,
          resultRef,
          resultDigest,
          request.expectedSignerSequence,
          lease.signingLeaseId,
          groupIdValue,
          decidedAtMs,
        ],
        "command result preparation insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_commands
            SET command_seq = ?, disposition = 'rejected',
                decision_evidence_schema_id = ?, decision_evidence_ref = ?,
                decision_evidence_digest = ?, canonical_command_record_digest = ?,
                decision_coordinator_lease_id = ?, decision_coordinator_epoch = ?,
                decided_at_ms = ?, state = 'decision_reserved'
          WHERE command_id = ? AND state = 'awaiting_order'`,
        [
          request.expectedCommandSeq,
          A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
          evidenceRef,
          evidenceDigest,
          decisionCommand.canonicalCommandRecordDigest,
          request.fence.coordinatorLeaseId,
          request.fence.coordinatorEpoch,
          decidedAtMs,
          command.commandId,
        ],
        "collaboration command rejected decision",
      );
      runExactlyOne(
        transaction,
        `UPDATE a1_ingress_adjudications
            SET command_seq = ?, disposition = 'rejected', command_result_id = ?,
                command_result_preparation_id = ?, decided_at_ms = ?, state = 'deciding'
          WHERE stable_semantic_result_id = ? AND state = 'awaiting_order'`,
        [
          request.expectedCommandSeq,
          commandResultId,
          preparationIdValue,
          decidedAtMs,
          command.sourceRef,
        ],
        "A1 ingress rejected decision",
      );
      const landed = exactDecisionResult(transaction, this.#machineIdentityId, request, false);
      if (landed === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "rejected decision disappeared in its transaction",
        );
      }
      return landed;
    });
  }

  reconcileRejectedDecision(
    requestValue: ReserveRejectedCommandDecisionRequest,
  ): RejectedCommandDecisionResult | null {
    const request = parseReserveDecisionRequest(requestValue);
    return this.#executor.transaction((transaction) =>
      exactDecisionResult(transaction, this.#machineIdentityId, request, true),
    );
  }

  bindRejectedResultPreparation(
    requestValue: BindRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult {
    const request = parseBindRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const authority = requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        request.fence,
        this.#nowMs,
      );
      const graph = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["reserved", "bound", "signed"],
        false,
      );
      if (graph === null) {
        throw new CommandAdjudicationRepositoryConflictError("result preparation is unknown");
      }
      if (graph.preparation.collaborationServerId !== authority.collaborationServerId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "result preparation belongs to another server",
        );
      }
      if (graph.preparation.state === "aborted") {
        throw new CommandAdjudicationRepositoryConflictError(
          "aborted result preparation cannot be bound",
        );
      }
      if (graph.preparation.state !== "reserved") {
        return frozen({ ...graph, replayed: true });
      }
      if (graph.signatureReservation.state !== "reserved") {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "reserved preparation has a non-reserved signature reservation",
        );
      }
      const boundAtMs = Math.max(authority.nowMs, graph.preparation.preparedAtMs);
      if (boundAtMs >= authority.heartbeatDeadlineMs) {
        throw new CommandAdjudicationStaleCoordinatorError();
      }
      runExactlyOne(
        transaction,
        `UPDATE server_signature_reservations
            SET canonical_payload_schema_id = ?, canonical_payload_ref = ?,
                canonical_payload_digest = ?, signed_artifact_type = ?,
                signed_artifact_id = ?, bound_at_ms = ?, state = 'bound'
          WHERE collaboration_server_id = ? AND signer_sequence = ?
            AND signing_lease_id = ? AND state = 'reserved'`,
        [
          A1_COMMAND_RESULT_SCHEMA_ID,
          graph.preparation.canonicalPayloadRef,
          graph.preparation.canonicalPayloadDigest,
          COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE,
          graph.preparation.commandResultPreparationId,
          boundAtMs,
          graph.preparation.collaborationServerId,
          graph.preparation.signerSequence,
          graph.preparation.signingLeaseId,
        ],
        "command-result signature reservation bind",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_command_result_preparations
            SET bound_at_ms = ?, state = 'bound'
          WHERE command_result_preparation_id = ? AND state = 'reserved'`,
        [boundAtMs, graph.preparation.commandResultPreparationId],
        "command result preparation bind",
      );
      const landed = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["bound"],
        false,
      );
      if (landed === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "bound result preparation disappeared in its transaction",
        );
      }
      return landed;
    });
  }

  reconcileRejectedResultPreparationBinding(
    requestValue: BindRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult | null {
    const request = parseBindRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const result = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["bound", "signed"],
        true,
      );
      if (result === null) return null;
      if (result.preparation.state === "reserved") return null;
      if (
        (result.preparation.state !== "bound" && result.preparation.state !== "signed") ||
        result.signatureReservation.state !==
          (result.preparation.state === "signed" ? "signed" : "bound") ||
        result.signatureReservation.signedArtifactType !==
          COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE ||
        result.signatureReservation.signedArtifactId !==
          result.preparation.commandResultPreparationId
      ) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "bound preparation has an inconsistent signature reservation",
        );
      }
      return result;
    });
  }

  storeSignedRejectedResultPreparation(
    requestValue: StoreSignedRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult {
    const request = parseStoreSignedRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const authority = requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        request.fence,
        this.#nowMs,
      );
      const graph = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["bound", "signed"],
        false,
      );
      if (graph === null) {
        throw new CommandAdjudicationRepositoryConflictError("bound result preparation is unknown");
      }
      if (graph.preparation.collaborationServerId !== authority.collaborationServerId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "result preparation belongs to another server",
        );
      }
      if (graph.preparation.state === "signed") {
        if (
          graph.signatureReservation.signature !== request.signature ||
          graph.signatureReservation.state !== "signed" ||
          graph.signingGroup.state !== "result_signed"
        ) {
          throw new CommandAdjudicationRepositoryConflictError(
            "existing signed preparation does not match the supplied signature",
          );
        }
        return frozen({ ...graph, replayed: true });
      }
      if (
        graph.signatureReservation.state !== "bound" ||
        graph.signingGroup.state !== "reserved" ||
        graph.signatureReservation.canonicalPayloadDigest !==
          graph.preparation.canonicalPayloadDigest ||
        graph.signatureReservation.signedArtifactType !==
          COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE ||
        graph.signatureReservation.signedArtifactId !== graph.preparation.commandResultPreparationId
      ) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "bound preparation signer graph is inconsistent",
        );
      }
      const signer = requireCommandSignerEvidence(transaction, graph.preparation);
      const payload = assertExactResultPayload(transaction, graph.preparation, signer);
      try {
        verifyCommandResultSignature(signer.publicKey, payload, request.signature);
      } finally {
        payload.destroy();
      }
      const signedAtMs = Math.max(
        authority.nowMs,
        graph.preparation.boundAtMs ?? graph.preparation.preparedAtMs,
      );
      if (signedAtMs >= authority.heartbeatDeadlineMs) {
        throw new CommandAdjudicationStaleCoordinatorError();
      }
      const signedDigest = signedResultDigest(
        graph.preparation.canonicalPayloadDigest,
        signer.identityKeyId,
        signer.keyGeneration,
        graph.preparation.signerSequence,
        request.signature,
      );
      runExactlyOne(
        transaction,
        `UPDATE server_signature_reservations
            SET signed_record_digest = ?, signature = ?, signed_at_ms = ?, state = 'signed'
          WHERE collaboration_server_id = ? AND signer_sequence = ?
            AND signing_lease_id = ? AND state = 'bound'`,
        [
          signedDigest,
          request.signature,
          signedAtMs,
          graph.preparation.collaborationServerId,
          graph.preparation.signerSequence,
          graph.preparation.signingLeaseId,
        ],
        "command-result signature reservation sign",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_command_result_preparations
            SET signed_at_ms = ?, state = 'signed'
          WHERE command_result_preparation_id = ? AND state = 'bound'`,
        [signedAtMs, graph.preparation.commandResultPreparationId],
        "command result preparation sign",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_command_compound_signing_groups
            SET result_signed_at_ms = ?, state = 'result_signed'
          WHERE compound_signing_group_id = ? AND state = 'reserved'`,
        [signedAtMs, graph.signingGroup.compoundSigningGroupId],
        "command signing group result sign",
      );
      const landed = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["signed"],
        false,
      );
      if (landed === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "signed result preparation disappeared in its transaction",
        );
      }
      return landed;
    });
  }

  reconcileSignedRejectedResultPreparation(
    requestValue: StoreSignedRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult | null {
    const request = parseStoreSignedRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const result = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["signed"],
        true,
      );
      if (result === null) return null;
      if (result.preparation.state === "reserved" || result.preparation.state === "bound") {
        return null;
      }
      if (
        result.preparation.state !== "signed" ||
        result.signatureReservation.state !== "signed" ||
        result.signatureReservation.signature !== request.signature ||
        result.signingGroup.state !== "result_signed"
      ) {
        throw new CommandAdjudicationRepositoryConflictError(
          "signed preparation does not match the supplied signature",
        );
      }
      return result;
    });
  }

  finalizeSignedRejectedCommandResult(
    requestValue: FinalizeSignedRejectedCommandResultRequest,
  ): FinalizedRejectedCommandResult {
    const request = parseFinalizeRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const authority = requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        request.fence,
        this.#nowMs,
      );
      const replay = assertExactFinalizedRejectedResult(
        transaction,
        this.#machineIdentityId,
        request,
        true,
      );
      if (replay !== null) return replay;
      const source = requireSignedFinalizationSource(transaction, this.#machineIdentityId, request);
      if (source.command.collaborationServerId !== authority.collaborationServerId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "finalization command belongs to another fenced server",
        );
      }
      const nextAcceptance = rawRow(
        sqlGet(
          transaction,
          `SELECT COALESCE(MAX(accepted_at_journal_seq) + 1, 0) AS next_seq
             FROM server_signed_record_acceptances
            WHERE collaboration_server_id = ?`,
          [authority.collaborationServerId],
        ),
        ["next_seq"],
        "nextSignedRecordAcceptance",
      );
      if (
        parseNonNegativeSafeInteger(
          nextAcceptance.next_seq,
          "nextSignedRecordAcceptance.nextSeq",
        ) !== request.expectedAcceptedAtJournalSeq
      ) {
        throw new CommandAdjudicationRepositoryConflictError(
          "signed-record acceptance journal sequence compare-and-swap failed",
        );
      }
      if (
        source.preparation.signedAtMs === null ||
        source.signatureReservation.signedAtMs === null
      ) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "signed finalization source has no signing timestamp",
        );
      }
      const terminalAtMs = Math.max(
        authority.nowMs,
        source.preparation.signedAtMs,
        source.signatureReservation.signedAtMs,
        source.command.decidedAtMs ?? source.command.createdAtMs,
      );
      if (terminalAtMs >= authority.heartbeatDeadlineMs) {
        throw new CommandAdjudicationStaleCoordinatorError();
      }
      const completion = selectCompletionObservation(transaction, source.ingress);
      const resultDeliveryId = deriveResultDeliveryId(
        source.ingress.stableSemanticResultId,
        completion.triggerIngressObservationId,
      );
      const semantic = prepareRejectedSemanticResult(source.ingress, source.command);
      let semanticPayloadRef: A1SafeId;
      try {
        semanticPayloadRef = putCanonicalArtifact(
          transaction,
          source.command.collaborationServerId,
          semantic.payloadSchemaId,
          semantic.payloadArtifactDigest,
          semantic.payloadBytes,
          this.#randomBytes,
          terminalAtMs,
        );
      } finally {
        semantic.payloadBytes.fill(0);
      }
      const deliveryAttemptId = allocateA1DeliveryAttemptId(this.#randomBytes);
      runExactlyOne(
        transaction,
        `INSERT INTO collaboration_command_results (
          command_result_id, collaboration_server_id, command_id,
          canonical_command_record_digest, result_version,
          supersedes_command_result_id, source_kind, source_ref, scope_kind,
          logical_chat_id, target_logical_chat_id, command_seq, disposition,
          canonical_payload_schema_id, canonical_payload_ref,
          canonical_payload_digest, command_result_preparation_id,
          compound_signing_group_id, signer_sequence, server_key_generation,
          signer_identity_key_id, signer_scope_certificate_id,
          signature_algorithm, signature, signed_record_digest,
          accepted_at_journal_seq, created_at_ms, finalized_at_ms
        ) VALUES (?, ?, ?, ?, 1, NULL, 'a1_ingress', ?, ?, ?, ?, ?, 'rejected',
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ed25519', ?, ?, ?, ?, ?)`,
        [
          request.expectedCommandResultId,
          source.command.collaborationServerId,
          source.command.commandId,
          source.command.canonicalCommandRecordDigest,
          source.command.sourceRef,
          source.command.scopeKind,
          source.command.logicalChatId,
          source.command.targetLogicalChatId,
          source.command.commandSeq,
          A1_COMMAND_RESULT_SCHEMA_ID,
          source.preparation.canonicalPayloadRef,
          source.preparation.canonicalPayloadDigest,
          source.preparation.commandResultPreparationId,
          source.preparation.compoundSigningGroupId,
          source.preparation.signerSequence,
          source.signer.keyGeneration,
          source.signer.identityKeyId,
          source.signer.scopeCertificateId,
          source.signatureReservation.signature,
          request.expectedSignedRecordDigest,
          request.expectedAcceptedAtJournalSeq,
          source.preparation.preparedAtMs,
          terminalAtMs,
        ],
        "collaboration command result insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO a1_ingress_terminal_results (
          stable_semantic_result_id, collaboration_server_id, broker_route_id,
          command_id, command_result_id, accepted_ingress_delivery_attempt_id,
          trigger_ingress_observation_id, initial_result_delivery_id,
          semantic_result_record_kind, semantic_result_payload_schema_id,
          semantic_result_payload_ref, semantic_result_payload_artifact_digest,
          stored_semantic_result_digest, finalization_coordinator_lease_id,
          finalization_coordinator_epoch, adjudication_state, terminal_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'terminal', ?)`,
        [
          source.ingress.stableSemanticResultId,
          source.command.collaborationServerId,
          source.ingress.brokerRouteId,
          source.command.commandId,
          request.expectedCommandResultId,
          source.ingress.acceptedDeliveryAttemptId,
          completion.triggerIngressObservationId,
          resultDeliveryId,
          semantic.recordKind,
          semantic.payloadSchemaId,
          semanticPayloadRef,
          semantic.payloadArtifactDigest,
          semantic.storedSemanticResultDigest,
          request.fence.coordinatorLeaseId,
          request.fence.coordinatorEpoch,
          terminalAtMs,
        ],
        "A1 ingress terminal result insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO a1_ingress_result_deliveries (
          result_delivery_id, stable_semantic_result_id, source_kind, source_ref,
          command_result_id, trigger_ingress_observation_id, broker_route_id,
          target_kind, target_ref, delivery_attempt_id,
          semantic_result_record_kind, semantic_result_payload_schema_id,
          semantic_result_payload_ref, semantic_result_payload_artifact_digest,
          stored_semantic_result_digest, state, created_at_ms
        ) VALUES (?, ?, 'a1_ingress', ?, ?, ?, ?, 'a1_broker', ?, ?, ?, ?, ?, ?, ?,
                  'pending_seal', ?)`,
        [
          resultDeliveryId,
          source.ingress.stableSemanticResultId,
          source.ingress.stableSemanticResultId,
          request.expectedCommandResultId,
          completion.triggerIngressObservationId,
          source.ingress.brokerRouteId,
          source.ingress.brokerRouteId,
          deliveryAttemptId,
          semantic.recordKind,
          semantic.payloadSchemaId,
          semanticPayloadRef,
          semantic.payloadArtifactDigest,
          semantic.storedSemanticResultDigest,
          terminalAtMs,
        ],
        "A1 ingress pending-seal result delivery insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO server_signed_record_acceptances (
          collaboration_server_id, accepted_at_journal_seq, signed_record_digest,
          signer_identity_key_id, signer_key_generation,
          signer_scope_certificate_id, signer_sequence, accepted_at_ms,
          historical_reattestation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          source.command.collaborationServerId,
          request.expectedAcceptedAtJournalSeq,
          request.expectedSignedRecordDigest,
          source.signer.identityKeyId,
          source.signer.keyGeneration,
          source.signer.scopeCertificateId,
          source.preparation.signerSequence,
          terminalAtMs,
        ],
        "command-result signer acceptance insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE a1_ingress_adjudications
            SET terminal_at_ms = ?, state = 'terminal'
          WHERE stable_semantic_result_id = ? AND state = 'deciding'
            AND command_id = ? AND command_result_id = ?
            AND command_result_preparation_id = ?`,
        [
          terminalAtMs,
          source.ingress.stableSemanticResultId,
          source.command.commandId,
          request.expectedCommandResultId,
          request.expectedCommandResultPreparationId,
        ],
        "A1 ingress adjudication terminalization",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_commands
            SET current_command_result_id = ?, state = 'decided'
          WHERE command_id = ? AND collaboration_server_id = ?
            AND state = 'decision_reserved' AND current_command_result_id IS NULL`,
        [
          request.expectedCommandResultId,
          source.command.commandId,
          source.command.collaborationServerId,
        ],
        "collaboration command final result",
      );
      const landed = assertExactFinalizedRejectedResult(
        transaction,
        this.#machineIdentityId,
        request,
        false,
      );
      if (landed === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "finalized rejected command-result graph disappeared in its transaction",
        );
      }
      return landed;
    });
  }

  reconcileFinalizedRejectedCommandResult(
    requestValue: FinalizeSignedRejectedCommandResultRequest,
  ): FinalizedRejectedCommandResult | null {
    const request = parseFinalizeRequest(requestValue);
    return this.#executor.transaction((transaction) =>
      assertExactFinalizedRejectedResult(transaction, this.#machineIdentityId, request, true),
    );
  }

  abortRejectedResultPreparation(
    requestValue: AbortRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult {
    const request = parseAbortRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const authority = requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        request.fence,
        this.#nowMs,
      );
      const graph = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["reserved", "bound", "aborted"],
        false,
      );
      if (graph === null) {
        throw new CommandAdjudicationRepositoryConflictError(
          "abort target result preparation is unknown",
        );
      }
      if (graph.preparation.collaborationServerId !== authority.collaborationServerId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "abort target belongs to another server",
        );
      }
      if (graph.preparation.state === "aborted") {
        if (
          graph.signatureReservation.state !== "aborted" ||
          graph.signingGroup.state !== "aborted"
        ) {
          throw new CommandAdjudicationRepositoryPersistenceError(
            "aborted preparation graph is partial",
          );
        }
        return frozen({ ...graph, replayed: true });
      }
      if (
        graph.signatureReservation.state !== graph.preparation.state ||
        graph.signingGroup.state !== "reserved"
      ) {
        throw new CommandAdjudicationRepositoryConflictError(
          "only an exact reserved or bound preparation can be aborted",
        );
      }
      const abortedAtMs = Math.max(
        authority.nowMs,
        graph.preparation.boundAtMs ?? graph.preparation.preparedAtMs,
      );
      if (abortedAtMs >= authority.heartbeatDeadlineMs) {
        throw new CommandAdjudicationStaleCoordinatorError();
      }
      runExactlyOne(
        transaction,
        `UPDATE server_signature_reservations
            SET aborted_at_ms = ?, state = 'aborted'
          WHERE collaboration_server_id = ? AND signer_sequence = ?
            AND signing_lease_id = ? AND state = ?`,
        [
          abortedAtMs,
          graph.preparation.collaborationServerId,
          graph.preparation.signerSequence,
          graph.preparation.signingLeaseId,
          graph.preparation.state,
        ],
        "command-result signature reservation abort",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_command_result_preparations
            SET aborted_at_ms = ?, state = 'aborted'
          WHERE command_result_preparation_id = ? AND state = ?`,
        [abortedAtMs, graph.preparation.commandResultPreparationId, graph.preparation.state],
        "command result preparation abort",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_command_compound_signing_groups
            SET aborted_at_ms = ?, state = 'aborted'
          WHERE compound_signing_group_id = ? AND state = 'reserved'`,
        [abortedAtMs, graph.signingGroup.compoundSigningGroupId],
        "command signing group abort",
      );
      const landed = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["aborted"],
        false,
      );
      if (landed === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "aborted preparation disappeared in its transaction",
        );
      }
      return landed;
    });
  }

  reconcileAbortedRejectedResultPreparation(
    requestValue: AbortRejectedCommandResultPreparationRequest,
  ): RejectedCommandPreparationMutationResult | null {
    const request = parseAbortRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const result = exactPreparationMutationResult(
        transaction,
        request.commandResultPreparationId,
        ["aborted"],
        true,
      );
      if (result === null) return null;
      if (result.preparation.state === "reserved" || result.preparation.state === "bound") {
        return null;
      }
      if (
        result.preparation.state !== "aborted" ||
        result.signatureReservation.state !== "aborted" ||
        result.signingGroup.state !== "aborted"
      ) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "aborted preparation graph is partial",
        );
      }
      return result;
    });
  }

  reserveReplacementRejectedResultPreparation(
    requestValue: ReserveReplacementRejectedCommandResultPreparationRequest,
  ): RejectedCommandDecisionResult {
    const request = parseReplacementRequest(requestValue);
    return this.#executor.transaction((transaction) => {
      const authority = requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        request.fence,
        this.#nowMs,
      );
      const replay = exactReplacementResult(transaction, this.#machineIdentityId, request, true);
      if (replay !== null) return replay;
      if (authority.nextServerSignatureSeq !== request.expectedSignerSequence) {
        throw new CommandAdjudicationRepositoryConflictError(
          "replacement signer sequence compare-and-swap failed",
        );
      }
      const lease = requireCurrentSigningLease(transaction, authority);
      if (lease.signingLeaseId !== request.expectedSigningLeaseId) {
        throw new CommandAdjudicationRepositoryConflictError(
          "replacement signer lease is not current",
        );
      }
      const priorGraph = exactPreparationMutationResult(
        transaction,
        request.expectedPriorPreparationId,
        ["aborted"],
        false,
      );
      if (
        priorGraph === null ||
        priorGraph.signatureReservation.state !== "aborted" ||
        priorGraph.signingGroup.state !== "aborted"
      ) {
        throw new CommandAdjudicationRepositoryConflictError(
          "replacement requires the exact prior aborted generation",
        );
      }
      const command = findCommand(transaction, priorGraph.preparation.commandId);
      const adjudication =
        command === null ? null : findAdjudication(transaction, command.sourceRef);
      if (
        command === null ||
        command.state !== "decision_reserved" ||
        command.commandSeq === null ||
        command.disposition !== "rejected" ||
        command.canonicalCommandRecordDigest !==
          priorGraph.preparation.canonicalCommandRecordDigest ||
        adjudication === null ||
        adjudication.state !== "deciding" ||
        adjudication.commandResultId !== priorGraph.preparation.commandResultId ||
        adjudication.commandResultPreparationId !==
          priorGraph.preparation.commandResultPreparationId
      ) {
        throw new CommandAdjudicationRepositoryConflictError(
          "replacement command decision or sidecar pointer is not exact",
        );
      }
      const preparationGeneration = priorGraph.preparation.preparationGeneration + 1;
      if (!Number.isSafeInteger(preparationGeneration)) {
        throw new CommandAdjudicationRepositoryConflictError(
          "result preparation generation is exhausted",
        );
      }
      const priorAbortedAtMs =
        priorGraph.preparation.abortedAtMs ?? priorGraph.preparation.preparedAtMs;
      if (priorAbortedAtMs >= Number.MAX_SAFE_INTEGER) {
        throw new CommandAdjudicationRepositoryConflictError(
          "replacement preparation timestamp is exhausted",
        );
      }
      const preparedAtMs = Math.max(
        authority.nowMs,
        lease.acquiredAtMs,
        command.decidedAtMs ?? command.createdAtMs,
        priorAbortedAtMs + 1,
      );
      if (preparedAtMs >= authority.heartbeatDeadlineMs) {
        throw new CommandAdjudicationStaleCoordinatorError();
      }
      const identity = {
        collaborationServerId: command.collaborationServerId,
        commandId: command.commandId,
        commandResultId: priorGraph.preparation.commandResultId,
        preparationGeneration,
      } as const;
      const replacementPreparationId = deriveCollaborationCommandResultPreparationId(identity);
      const replacementGroupId = deriveCollaborationCommandCompoundSigningGroupId(identity);
      const payloadValue = resultPayloadContract({
        commandResultId: priorGraph.preparation.commandResultId,
        command,
        createdAtMs: preparedAtMs,
        signerSequence: request.expectedSignerSequence,
        serverKeyGeneration: lease.keyGeneration,
        signerIdentityKeyId: lease.identityKeyId,
        signerScopeCertificateId: lease.scopeCertificateId,
      });
      const payloadBytes = canonicalA1CommandResultPayload(payloadValue);
      const payloadDigest = digestBytes(payloadBytes);
      let payloadRef: A1SafeId;
      try {
        payloadRef = putCanonicalArtifact(
          transaction,
          command.collaborationServerId,
          A1_COMMAND_RESULT_SCHEMA_ID,
          payloadDigest,
          payloadBytes,
          this.#randomBytes,
          preparedAtMs,
        );
      } finally {
        payloadBytes.fill(0);
      }
      runExactlyOne(
        transaction,
        `INSERT INTO server_signature_reservations (
          collaboration_server_id, signer_sequence, signing_lease_id,
          signing_lease_kind, purpose, canonical_payload_schema_id,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state
        ) VALUES (?, ?, ?, 'current', 'collaboration_command_result',
                  NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, 'reserved')`,
        [
          command.collaborationServerId,
          request.expectedSignerSequence,
          lease.signingLeaseId,
          preparedAtMs,
        ],
        "replacement command-result signature reservation insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO collaboration_command_compound_signing_groups (
          compound_signing_group_id, collaboration_server_id, command_id,
          command_result_id, preparation_generation, signing_lease_id,
          result_preparation_ref, required_finalization_artifact_kind,
          secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
          both_signed_at_ms, finalized_at_ms, aborted_at_ms, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NULL, ?, NULL, NULL, NULL, NULL, 'reserved')`,
        [
          replacementGroupId,
          command.collaborationServerId,
          command.commandId,
          priorGraph.preparation.commandResultId,
          preparationGeneration,
          lease.signingLeaseId,
          replacementPreparationId,
          preparedAtMs,
        ],
        "replacement command signing group insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO collaboration_command_result_preparations (
          command_result_preparation_id, command_result_id, collaboration_server_id,
          command_id, canonical_command_record_digest, result_version,
          preparation_generation, supersedes_preparation_ref, canonical_payload_ref,
          canonical_payload_digest, signer_sequence, signing_lease_id,
          compound_signing_group_id, required_finalization_artifact_kind,
          current_finalization_artifact_preparation_ref, prepared_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'none', NULL, ?,
                  NULL, NULL, NULL, 'reserved')`,
        [
          replacementPreparationId,
          priorGraph.preparation.commandResultId,
          command.collaborationServerId,
          command.commandId,
          priorGraph.preparation.canonicalCommandRecordDigest,
          preparationGeneration,
          priorGraph.preparation.commandResultPreparationId,
          payloadRef,
          payloadDigest,
          request.expectedSignerSequence,
          lease.signingLeaseId,
          replacementGroupId,
          preparedAtMs,
        ],
        "replacement command result preparation insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE a1_ingress_adjudications
            SET command_result_preparation_id = ?
          WHERE stable_semantic_result_id = ? AND state = 'deciding'
            AND command_result_preparation_id = ?`,
        [
          replacementPreparationId,
          command.sourceRef,
          priorGraph.preparation.commandResultPreparationId,
        ],
        "replacement A1 ingress preparation pointer",
      );
      const landed = exactReplacementResult(transaction, this.#machineIdentityId, request, false);
      if (landed === null) {
        throw new CommandAdjudicationRepositoryPersistenceError(
          "replacement preparation disappeared in its transaction",
        );
      }
      return landed;
    });
  }

  reconcileReplacementRejectedResultPreparation(
    requestValue: ReserveReplacementRejectedCommandResultPreparationRequest,
  ): RejectedCommandDecisionResult | null {
    const request = parseReplacementRequest(requestValue);
    return this.#executor.transaction((transaction) =>
      exactReplacementResult(transaction, this.#machineIdentityId, request, true),
    );
  }

  readState(stableSemanticResultIdValue: A1SafeId): CommandAdjudicationState | null {
    const stableSemanticResultId = semanticResultId(
      stableSemanticResultIdValue,
      "commandAdjudication.readState.stableSemanticResultId",
    );
    return this.#executor.transaction((transaction) => {
      const adjudication = findAdjudication(transaction, stableSemanticResultId);
      if (adjudication === null) return null;
      const readyEntry = findReadyEntry(transaction, stableSemanticResultId);
      const command = findCommand(transaction, adjudication.commandId);
      if (readyEntry === null || command === null) {
        throw new CommandAdjudicationRepositoryPersistenceError("command state graph is partial");
      }
      const preparation =
        adjudication.commandResultPreparationId === null
          ? null
          : findPreparation(transaction, adjudication.commandResultPreparationId);
      const signingGroup =
        preparation === null ? null : findGroup(transaction, preparation.compoundSigningGroupId);
      const signatureReservation =
        preparation === null
          ? null
          : findReservation(
              transaction,
              preparation.collaborationServerId,
              preparation.signerSequence,
            );
      if (
        (adjudication.state === "awaiting_order" &&
          (preparation !== null || signingGroup !== null || signatureReservation !== null)) ||
        (adjudication.state !== "awaiting_order" &&
          (preparation === null || signingGroup === null || signatureReservation === null))
      ) {
        throw new CommandAdjudicationRepositoryPersistenceError("command state graph is partial");
      }
      return frozen({
        readyEntry,
        adjudication,
        command,
        preparation,
        signingGroup,
        signatureReservation,
      });
    });
  }
}

/** Bind direct-only A1.7b1 operations to an already active host-state transaction. */
export function createCommandAdjudicationRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  options: CommandAdjudicationRepositoryOptions = {},
): CommandAdjudicationRepositoryOperations {
  return new BoundCommandAdjudicationRepository(
    { transaction: (operation) => operation(transaction) },
    machineIdentityId,
    options,
  );
}

/** Direct-only constructor exposed by the closed SQLite facade but not invoked by production flow. */
export function createCommandAdjudicationRepositoryOperations(
  executor: HostStateRepositoryTransactionExecutor,
  machineIdentityId: string,
  options: CommandAdjudicationRepositoryOptions = {},
): CommandAdjudicationRepositoryOperations {
  return new BoundCommandAdjudicationRepository(executor, machineIdentityId, options);
}
