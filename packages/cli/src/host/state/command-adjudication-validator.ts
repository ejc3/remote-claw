import { createHash, createPublicKey, verify } from "node:crypto";
import {
  A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
  A1_COMMAND_DECISION_POLICY_ID,
  A1_COMMAND_RESULT_SCHEMA_ID,
  A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_OPENCODE_PRE_DECISION_NORMALIZATION_SCHEMA_ID,
  A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID,
  type A1CanonicalCommandRecord,
  type A1CanonicalCommandResultPayload,
  type A1CommandDecisionEvidence,
  type A1IngressCommandSource,
  type A1UnsupportedRecognizedCommandPayload,
  base64urlDecode,
  canonicalA1CollaborationCommandIdPreimage,
  canonicalA1CommandDecisionEvidence,
  canonicalA1CommandPayload,
  canonicalA1CommandRecord,
  canonicalA1CommandResultPayload,
  canonicalA1CommandSourceIdentity,
  canonicalA1SignedCommandResult,
} from "@remote-claw/clawsec";
import {
  A1_COMMAND_RESULT_VERSION,
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
import { CommandAdjudicationRepositoryPersistenceError } from "./command-adjudication-repository.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type Ed25519PublicKey,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseMachineIdentityId,
} from "./ids.js";
import { ProtectedByteSnapshot } from "./protected.js";
import type {
  HostStateRepositorySqlTransaction,
  HostStateRepositorySqlValue,
} from "./repository.js";
import {
  parseServerSignatureReservationRecord,
  type ServerSignatureReservationRecord,
} from "./server-signing.js";
import {
  parseExactRecord,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
  type UnknownRecord,
} from "./validation.js";

type MachineIdentityId = ReturnType<typeof parseMachineIdentityId>;

const COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE =
  "collaboration_command_result_preparation" as const;
const SOURCE_FINGERPRINT_SCHEMA_ID = "remote-claw/a1/source-event-fingerprint/v1" as const;

function fail(message: string, cause?: unknown): never {
  throw new CommandAdjudicationRepositoryPersistenceError(message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function snapshotAssert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function sqlAll(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): readonly unknown[] {
  if (transaction.all === undefined) fail("snapshot multi-row SQL reads are unavailable");
  try {
    return transaction.all(sql, parameters);
  } catch (error) {
    if (error instanceof CommandAdjudicationRepositoryPersistenceError) throw error;
    return fail("snapshot SQL read did not complete", error);
  }
}

function row(value: unknown, keys: readonly string[], field: string): UnknownRecord {
  try {
    return parseExactRecord(value, keys, field);
  } catch (error) {
    return fail(`${field} row is invalid`, error);
  }
}

function parsed<T>(context: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandAdjudicationRepositoryPersistenceError) throw error;
    return fail(`${context} is invalid`, error);
  }
}

function digestBytes(bytes: Uint8Array): A1Digest {
  return parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
}

function digestCanonical(operation: () => Uint8Array): A1Digest {
  const bytes = operation();
  try {
    return digestBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

const READY_KEYS = [
  "collaboration_server_id",
  "ready_at_journal_seq",
  "command_id",
  "stable_semantic_result_id",
  "coordinator_lease_id",
  "coordinator_epoch",
  "ready_at_ms",
] as const;

function readyFromRow(value: unknown): CommandReadyEntryRecord {
  const record = row(value, READY_KEYS, "commandReadyEntrySnapshot");
  return parsed("command ready entry", () =>
    parseCommandReadyEntryRecord({
      collaborationServerId: record.collaboration_server_id,
      readyAtJournalSeq: record.ready_at_journal_seq,
      commandId: record.command_id,
      stableSemanticResultId: record.stable_semantic_result_id,
      coordinatorLeaseId: record.coordinator_lease_id,
      coordinatorEpoch: record.coordinator_epoch,
      readyAtMs: record.ready_at_ms,
    }),
  );
}

const ADJUDICATION_KEYS = [
  "stable_semantic_result_id",
  "collaboration_server_id",
  "command_id",
  "ready_at_journal_seq",
  "command_seq",
  "disposition",
  "command_result_id",
  "command_result_preparation_id",
  "viewer_projection_seq",
  "decided_at_ms",
  "terminal_at_ms",
  "state",
] as const;

function adjudicationFromRow(value: unknown): A1IngressAdjudicationRecord {
  const record = row(value, ADJUDICATION_KEYS, "a1IngressAdjudicationSnapshot");
  snapshotAssert(
    record.viewer_projection_seq === null && record.terminal_at_ms === null,
    "A1 ingress adjudication crossed the schema-v10 terminal boundary",
  );
  return parsed("A1 ingress adjudication", () =>
    parseA1IngressAdjudicationRecord({
      stableSemanticResultId: record.stable_semantic_result_id,
      collaborationServerId: record.collaboration_server_id,
      commandId: record.command_id,
      readyAtJournalSeq: record.ready_at_journal_seq,
      commandSeq: record.command_seq,
      disposition: record.disposition,
      commandResultId: record.command_result_id,
      commandResultPreparationId: record.command_result_preparation_id,
      decidedAtMs: record.decided_at_ms,
      state: record.state,
    }),
  );
}

const COMMAND_KEYS = [
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
  "project_target_selector_mapping_id",
  "project_target_selector_mapping_generation",
  "project_target_digest",
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
  const record = row(value, COMMAND_KEYS, "collaborationCommandSnapshot");
  snapshotAssert(
    record.project_target_selector_mapping_id === null &&
      record.project_target_selector_mapping_generation === null &&
      record.project_target_digest === null,
    "collaboration command contains unreachable project-target evidence",
  );
  return parsed("collaboration command", () =>
    parseCollaborationCommandRecord({
      commandId: record.command_id,
      collaborationServerId: record.collaboration_server_id,
      scopeKind: record.scope_kind,
      logicalChatId: record.logical_chat_id,
      targetLogicalChatId: record.target_logical_chat_id,
      sourceKind: record.source_kind,
      sourceRef: record.source_ref,
      sourceEventNamespaceId: record.source_event_namespace_id,
      sourceEventId: record.source_event_id,
      sourceCommandIdentityDigest: record.source_command_identity_digest,
      canonicalSourceEventDigest: record.canonical_source_event_digest,
      mutationFamily: record.mutation_family,
      canonicalCommandPayloadSchemaId: record.canonical_command_payload_schema_id,
      canonicalCommandPayloadRef: record.canonical_command_payload_ref,
      canonicalCommandPayloadDigest: record.canonical_command_payload_digest,
      preDecisionNormalizationEvidenceSchemaId:
        record.pre_decision_normalization_evidence_schema_id,
      preDecisionNormalizationEvidenceRef: record.pre_decision_normalization_evidence_ref,
      preDecisionNormalizationEvidenceDigest: record.pre_decision_normalization_evidence_digest,
      readyAtJournalSeq: record.ready_at_journal_seq,
      commandSeq: record.command_seq,
      disposition: record.disposition,
      admittedTargetKind: record.admitted_target_kind,
      selectedExecutorEvidenceSchemaId: record.selected_executor_evidence_schema_id,
      selectedExecutorEvidenceRef: record.selected_executor_evidence_ref,
      selectedExecutorEvidenceDigest: record.selected_executor_evidence_digest,
      targetCapabilitySnapshotId: record.target_capability_snapshot_id,
      targetCapabilityFamilyDigest: record.target_capability_family_digest,
      currentCommandResultId: record.current_command_result_id,
      decisionEvidenceSchemaId: record.decision_evidence_schema_id,
      decisionEvidenceRef: record.decision_evidence_ref,
      decisionEvidenceDigest: record.decision_evidence_digest,
      canonicalCommandRecordDigest: record.canonical_command_record_digest,
      coordinatorLeaseId: record.coordinator_lease_id,
      coordinatorEpoch: record.coordinator_epoch,
      decisionCoordinatorLeaseId: record.decision_coordinator_lease_id,
      decisionCoordinatorEpoch: record.decision_coordinator_epoch,
      createdAtMs: record.created_at_ms,
      decidedAtMs: record.decided_at_ms,
      state: record.state,
    }),
  );
}

const PREPARATION_KEYS = [
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
  const record = row(value, PREPARATION_KEYS, "commandResultPreparationSnapshot");
  return parsed("command result preparation", () =>
    parseCollaborationCommandResultPreparationRecord({
      commandResultPreparationId: record.command_result_preparation_id,
      commandResultId: record.command_result_id,
      collaborationServerId: record.collaboration_server_id,
      commandId: record.command_id,
      canonicalCommandRecordDigest: record.canonical_command_record_digest,
      resultVersion: record.result_version,
      preparationGeneration: record.preparation_generation,
      supersedesPreparationRef: record.supersedes_preparation_ref,
      canonicalPayloadRef: record.canonical_payload_ref,
      canonicalPayloadDigest: record.canonical_payload_digest,
      signerSequence: record.signer_sequence,
      signingLeaseId: record.signing_lease_id,
      compoundSigningGroupId: record.compound_signing_group_id,
      requiredFinalizationArtifactKind: record.required_finalization_artifact_kind,
      currentFinalizationArtifactPreparationRef:
        record.current_finalization_artifact_preparation_ref,
      preparedAtMs: record.prepared_at_ms,
      boundAtMs: record.bound_at_ms,
      signedAtMs: record.signed_at_ms,
      abortedAtMs: record.aborted_at_ms,
      state: record.state,
    }),
  );
}

const GROUP_KEYS = [
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
  const record = row(value, GROUP_KEYS, "commandSigningGroupSnapshot");
  return parsed("command signing group", () =>
    parseCollaborationCommandCompoundSigningGroupRecord({
      compoundSigningGroupId: record.compound_signing_group_id,
      collaborationServerId: record.collaboration_server_id,
      commandId: record.command_id,
      commandResultId: record.command_result_id,
      preparationGeneration: record.preparation_generation,
      signingLeaseId: record.signing_lease_id,
      resultPreparationRef: record.result_preparation_ref,
      requiredFinalizationArtifactKind: record.required_finalization_artifact_kind,
      secondaryPreparationRef: record.secondary_preparation_ref,
      reservedAtMs: record.reserved_at_ms,
      resultSignedAtMs: record.result_signed_at_ms,
      bothSignedAtMs: record.both_signed_at_ms,
      finalizedAtMs: record.finalized_at_ms,
      abortedAtMs: record.aborted_at_ms,
      state: record.state,
    }),
  );
}

const RESERVATION_KEYS = [
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
  const record = row(value, RESERVATION_KEYS, "commandSignatureReservationSnapshot");
  return parsed("command signature reservation", () =>
    parseServerSignatureReservationRecord({
      collaborationServerId: record.collaboration_server_id,
      signerSequence: record.signer_sequence,
      signingLeaseId: record.signing_lease_id,
      signingLeaseKind: record.signing_lease_kind,
      purpose: record.purpose,
      canonicalPayloadSchemaId: record.canonical_payload_schema_id,
      canonicalPayloadRef: record.canonical_payload_ref,
      canonicalPayloadDigest: record.canonical_payload_digest,
      signedRecordDigest: record.signed_record_digest,
      signature: record.signature,
      signedArtifactType: record.signed_artifact_type,
      signedArtifactId: record.signed_artifact_id,
      reservedAtMs: record.reserved_at_ms,
      boundAtMs: record.bound_at_ms,
      signedAtMs: record.signed_at_ms,
      abortedAtMs: record.aborted_at_ms,
      state: record.state,
    }),
  );
}

interface ServerSnapshot {
  readonly collaborationServerId: CollaborationServerId;
  readonly machineIdentityId: MachineIdentityId;
  readonly nextJournalOffset: number;
  readonly nextCommandSeq: number;
  readonly nextServerSignatureSeq: number;
}

interface CoordinatorSnapshot {
  readonly collaborationServerId: CollaborationServerId;
  readonly coordinatorLeaseId: string;
  readonly coordinatorEpoch: number;
  readonly acquiredAtMs: number;
  readonly heartbeatDeadlineMs: number;
  readonly releasedAtMs: number | null;
}

interface IngressSnapshot {
  readonly stableSemanticResultId: A1SafeId;
  readonly brokerRouteId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly routeKind: "server_control" | "chat";
  readonly logicalChatId: string | null;
  readonly sourceEventNamespaceId: A1SafeId;
  readonly messageId: A1SafeId;
  readonly recordKind: "user" | "new_chat";
  readonly sourcePayloadSchemaId: string;
  readonly canonicalMessageDigest: A1Digest;
  readonly sourceEventFingerprint: A1Digest;
  readonly state: string;
}

interface SigningLeaseSnapshot {
  readonly signingLeaseId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly identityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly scopeCertificateId: A1SafeId;
  readonly coordinatorLeaseId: string;
  readonly coordinatorEpoch: number;
  readonly acquiredAtMs: number;
  readonly drainingAtMs: number | null;
  readonly supersededAtMs: number | null;
  readonly closedAtMs: number | null;
  readonly state: "current" | "draining" | "superseded" | "closed";
}

interface SigningKeySnapshot {
  readonly identityKeyId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly keyGeneration: number;
  readonly publicKey: Ed25519PublicKey;
}

interface ScopeCertificateSnapshot {
  readonly scopeCertificateId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly subjectIdentityKeyId: A1SafeId;
  readonly subjectPublicKey: Ed25519PublicKey;
  readonly keyGeneration: number;
}

interface ArtifactSnapshot {
  readonly protectedHandleId: string;
  readonly scopeId: CollaborationServerId;
  readonly schemaId: string;
  readonly digest: A1Digest;
  readonly createdAtMs: number;
  readonly bytes: ProtectedByteSnapshot;
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const selected = key(value);
    snapshotAssert(!result.has(selected), `${context} identity is duplicated`);
    result.set(selected, value);
  }
  return result;
}

function coordinatorKey(serverId: string, leaseId: string, epoch: number): string {
  return `${serverId}\u0000${leaseId}\u0000${String(epoch)}`;
}

function reservationKey(serverId: string, sequence: number): string {
  return `${serverId}\u0000${String(sequence)}`;
}

function generationKey(serverId: string, resultId: string, generation: number): string {
  return `${serverId}\u0000${resultId}\u0000${String(generation)}`;
}

function intervalContains(
  intervals: readonly (readonly [number, number])[],
  observedAtMs: number,
): boolean {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const interval = intervals[middle];
    if (interval === undefined) return false;
    if (observedAtMs <= interval[0]) high = middle - 1;
    else if (observedAtMs >= interval[1]) low = middle + 1;
    else return true;
  }
  return false;
}

function assertObservedWithinCoordinator(
  coordinators: ReadonlyMap<string, CoordinatorSnapshot>,
  serverId: CollaborationServerId,
  leaseId: string,
  epoch: number,
  observedAtMs: number,
  context: string,
): void {
  const lease = coordinators.get(coordinatorKey(serverId, leaseId, epoch));
  snapshotAssert(lease !== undefined, `${context} has no exact coordinator history`);
  snapshotAssert(
    lease.acquiredAtMs <= observedAtMs &&
      observedAtMs < lease.heartbeatDeadlineMs &&
      (lease.releasedAtMs === null || observedAtMs <= lease.releasedAtMs),
    `${context} lies outside its coordinator lifetime`,
  );
}

function coordinatorHistoryContains(
  history: readonly CoordinatorSnapshot[],
  observedAtMs: number,
): boolean {
  let low = 0;
  let high = history.length - 1;
  let selected: CoordinatorSnapshot | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = history[middle];
    if (candidate === undefined) return false;
    if (candidate.acquiredAtMs <= observedAtMs) {
      selected = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return (
    selected !== undefined &&
    observedAtMs < selected.heartbeatDeadlineMs &&
    (selected.releasedAtMs === null || observedAtMs <= selected.releasedAtMs)
  );
}

function assertArtifact(
  artifacts: ReadonlyMap<string, ArtifactSnapshot>,
  claimed: Set<string>,
  expected: Readonly<{
    ref: string;
    serverId: CollaborationServerId;
    schemaId: string;
    digest: A1Digest;
    createdAtMs: number;
    bytes: Uint8Array;
  }>,
  context: string,
): void {
  const artifact = artifacts.get(expected.ref);
  snapshotAssert(artifact !== undefined, `${context} artifact is absent`);
  snapshotAssert(!claimed.has(expected.ref), `${context} artifact is referenced more than once`);
  claimed.add(expected.ref);
  snapshotAssert(
    artifact.scopeId === expected.serverId &&
      artifact.schemaId === expected.schemaId &&
      artifact.digest === expected.digest &&
      artifact.createdAtMs === expected.createdAtMs &&
      digestBytes(expected.bytes) === expected.digest,
    `${context} artifact coordinates or digest are inconsistent`,
  );
  const actual = artifact.bytes.copyBytes();
  try {
    snapshotAssert(
      actual.byteLength === expected.bytes.byteLength &&
        Buffer.compare(actual, expected.bytes) === 0,
      `${context} artifact bytes are noncanonical`,
    );
  } finally {
    actual.fill(0);
  }
}

function commandPayload(ingress: IngressSnapshot): A1UnsupportedRecognizedCommandPayload {
  return {
    schemaVersion: 1,
    canonicalCommandPayloadSchemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
    normalizedMutationFamily: ingress.recordKind === "user" ? "user_text" : "new_chat",
    sourcePayloadSchemaId: ingress.sourcePayloadSchemaId,
    sourcePayloadDigest: ingress.canonicalMessageDigest,
    sourceEventFingerprint: ingress.sourceEventFingerprint,
  };
}

function sourceIdentity(
  machineIdentityId: MachineIdentityId,
  ingress: IngressSnapshot,
): A1IngressCommandSource {
  const identityId = Buffer.from(machineIdentityId, "hex");
  if (ingress.routeKind === "server_control") {
    return {
      sourceKind: "a1_ingress",
      identityId,
      collaborationServerId: ingress.collaborationServerId,
      scopeKind: "server_control",
      logicalChatId: null,
      sourceEventNamespaceId: ingress.sourceEventNamespaceId,
      sourceEventId: ingress.messageId,
    };
  }
  return {
    sourceKind: "a1_ingress",
    identityId,
    collaborationServerId: ingress.collaborationServerId,
    scopeKind: "chat",
    logicalChatId: ingress.logicalChatId as string,
    sourceEventNamespaceId: ingress.sourceEventNamespaceId,
    sourceEventId: ingress.messageId,
  };
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

function canonicalCommandRecord(command: CollaborationCommandRecord): A1CanonicalCommandRecord {
  snapshotAssert(
    command.commandSeq !== null &&
      command.decisionEvidenceDigest !== null &&
      command.disposition === "rejected",
    "ordered command has no frozen rejected decision",
  );
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
    commandSeq: command.commandSeq,
    disposition: "rejected",
    admittedTargetKind: null,
    targetCapabilitySnapshotId: null,
    targetCapabilityFamilyDigest: null,
    decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    decisionEvidenceDigest: command.decisionEvidenceDigest,
  };
}

function canonicalResultPayload(
  preparation: CollaborationCommandResultPreparationRecord,
  command: CollaborationCommandRecord,
  signer: SigningLeaseSnapshot,
): A1CanonicalCommandResultPayload {
  snapshotAssert(
    command.commandSeq !== null && command.disposition !== null,
    "result command is unordered",
  );
  return {
    canonicalPayloadSchemaId: A1_COMMAND_RESULT_SCHEMA_ID,
    commandResultId: preparation.commandResultId,
    collaborationServerId: command.collaborationServerId,
    commandId: command.commandId,
    canonicalCommandRecordDigest: preparation.canonicalCommandRecordDigest,
    resultVersion: A1_COMMAND_RESULT_VERSION,
    supersedesCommandResultId: null,
    sourceKind: command.sourceKind,
    sourceRef: command.sourceRef,
    scopeKind: command.scopeKind,
    logicalChatId: command.logicalChatId,
    targetLogicalChatId: command.targetLogicalChatId,
    commandSeq: command.commandSeq,
    disposition: command.disposition,
    createdAtMs: preparation.preparedAtMs,
    signerSequence: preparation.signerSequence,
    serverKeyGeneration: signer.keyGeneration,
    signerIdentityKeyId: signer.identityKeyId,
    signerScopeCertificateId: signer.scopeCertificateId,
    signatureAlgorithm: "Ed25519",
  };
}

function parseServers(transaction: HostStateRepositorySqlTransaction): readonly ServerSnapshot[] {
  return sqlAll(
    transaction,
    `SELECT collaboration_server_id, machine_identity_id, next_journal_offset,
            next_command_seq, next_server_signature_seq
       FROM collaboration_servers ORDER BY collaboration_server_id`,
  ).map((value) => {
    const record = row(
      value,
      [
        "collaboration_server_id",
        "machine_identity_id",
        "next_journal_offset",
        "next_command_seq",
        "next_server_signature_seq",
      ] as const,
      "commandServerSnapshot",
    );
    return Object.freeze({
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        record.collaboration_server_id,
      ),
      machineIdentityId: parseMachineIdentityId(record.machine_identity_id),
      nextJournalOffset: parseNonNegativeSafeInteger(
        record.next_journal_offset,
        "commandServerSnapshot.nextJournalOffset",
      ),
      nextCommandSeq: parseNonNegativeSafeInteger(
        record.next_command_seq,
        "commandServerSnapshot.nextCommandSeq",
      ),
      nextServerSignatureSeq: parseNonNegativeSafeInteger(
        record.next_server_signature_seq,
        "commandServerSnapshot.nextServerSignatureSeq",
      ),
    });
  });
}

function parseCoordinators(
  transaction: HostStateRepositorySqlTransaction,
): readonly CoordinatorSnapshot[] {
  return sqlAll(
    transaction,
    `SELECT collaboration_server_id, coordinator_lease_id, coordinator_epoch,
            acquired_at_ms, heartbeat_deadline_ms, released_at_ms
       FROM coordinator_leases ORDER BY collaboration_server_id, coordinator_epoch`,
  ).map((value) => {
    const record = row(
      value,
      [
        "collaboration_server_id",
        "coordinator_lease_id",
        "coordinator_epoch",
        "acquired_at_ms",
        "heartbeat_deadline_ms",
        "released_at_ms",
      ] as const,
      "commandCoordinatorSnapshot",
    );
    return Object.freeze({
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        record.collaboration_server_id,
      ),
      coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", record.coordinator_lease_id),
      coordinatorEpoch: parsePositiveSafeInteger(
        record.coordinator_epoch,
        "commandCoordinatorSnapshot.coordinatorEpoch",
      ),
      acquiredAtMs: parseNonNegativeSafeInteger(
        record.acquired_at_ms,
        "commandCoordinatorSnapshot.acquiredAtMs",
      ),
      heartbeatDeadlineMs: parseNonNegativeSafeInteger(
        record.heartbeat_deadline_ms,
        "commandCoordinatorSnapshot.heartbeatDeadlineMs",
      ),
      releasedAtMs:
        record.released_at_ms === null
          ? null
          : parseNonNegativeSafeInteger(
              record.released_at_ms,
              "commandCoordinatorSnapshot.releasedAtMs",
            ),
    });
  });
}

function parseIngress(transaction: HostStateRepositorySqlTransaction): readonly IngressSnapshot[] {
  return sqlAll(
    transaction,
    `SELECT stable_semantic_result_id, broker_route_id, collaboration_server_id,
            route_kind, logical_chat_id, source_event_namespace_id, message_id,
            record_kind, accepted_delivery_attempt_id, source_payload_schema_id,
            canonical_message_digest, source_event_fingerprint_schema_id,
            source_event_fingerprint, state
       FROM authenticated_ingress_results
      WHERE EXISTS (
        SELECT 1 FROM a1_ingress_adjudications AS adjudication
         WHERE adjudication.stable_semantic_result_id =
               authenticated_ingress_results.stable_semantic_result_id
      )
      ORDER BY stable_semantic_result_id`,
  ).map((value) => {
    const record = row(
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
        "source_event_fingerprint_schema_id",
        "source_event_fingerprint",
        "state",
      ] as const,
      "commandIngressSourceSnapshot",
    );
    snapshotAssert(
      record.state === "awaiting_order" &&
        record.accepted_delivery_attempt_id !== null &&
        record.source_payload_schema_id !== null &&
        record.canonical_message_digest !== null &&
        record.source_event_fingerprint_schema_id === SOURCE_FINGERPRINT_SCHEMA_ID &&
        record.source_event_fingerprint !== null,
      "adjudicated A1 ingress source is not the frozen accepted awaiting-order tuple",
    );
    const routeKind = record.route_kind;
    const recordKind = record.record_kind;
    snapshotAssert(
      (routeKind === "server_control" &&
        record.logical_chat_id === null &&
        recordKind === "new_chat") ||
        (routeKind === "chat" && record.logical_chat_id !== null && recordKind === "user"),
      "adjudicated A1 ingress scope and record kind are inconsistent",
    );
    return Object.freeze({
      stableSemanticResultId: parseA1SafeId(record.stable_semantic_result_id),
      brokerRouteId: parseA1SafeId(record.broker_route_id),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        record.collaboration_server_id,
      ),
      routeKind: routeKind as "server_control" | "chat",
      logicalChatId:
        record.logical_chat_id === null
          ? null
          : parseA1CanonicalId("logicalChat", record.logical_chat_id),
      sourceEventNamespaceId: parseA1SafeId(record.source_event_namespace_id),
      messageId: parseA1SafeId(record.message_id),
      recordKind: recordKind as "user" | "new_chat",
      sourcePayloadSchemaId: String(record.source_payload_schema_id),
      canonicalMessageDigest: parseA1Digest(record.canonical_message_digest),
      sourceEventFingerprint: parseA1Digest(record.source_event_fingerprint),
      state: record.state,
    });
  });
}

function parseSigningLeases(
  transaction: HostStateRepositorySqlTransaction,
): readonly SigningLeaseSnapshot[] {
  return sqlAll(
    transaction,
    `SELECT signing_lease_id, collaboration_server_id, identity_key_id,
            key_generation, scope_certificate_id, coordinator_lease_id,
            coordinator_epoch, acquired_at_ms, draining_at_ms,
            superseded_at_ms, closed_at_ms, state
       FROM server_signing_leases ORDER BY collaboration_server_id, acquired_at_ms`,
  ).map((value) => {
    const record = row(
      value,
      [
        "signing_lease_id",
        "collaboration_server_id",
        "identity_key_id",
        "key_generation",
        "scope_certificate_id",
        "coordinator_lease_id",
        "coordinator_epoch",
        "acquired_at_ms",
        "draining_at_ms",
        "superseded_at_ms",
        "closed_at_ms",
        "state",
      ] as const,
      "commandSigningLeaseSnapshot",
    );
    return Object.freeze({
      signingLeaseId: parseA1SafeId(record.signing_lease_id),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        record.collaboration_server_id,
      ),
      identityKeyId: parseA1SafeId(record.identity_key_id),
      keyGeneration: parsePositiveSafeInteger(
        record.key_generation,
        "commandSigningLeaseSnapshot.keyGeneration",
      ),
      scopeCertificateId: parseA1SafeId(record.scope_certificate_id),
      coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", record.coordinator_lease_id),
      coordinatorEpoch: parsePositiveSafeInteger(
        record.coordinator_epoch,
        "commandSigningLeaseSnapshot.coordinatorEpoch",
      ),
      acquiredAtMs: parseNonNegativeSafeInteger(
        record.acquired_at_ms,
        "commandSigningLeaseSnapshot.acquiredAtMs",
      ),
      drainingAtMs:
        record.draining_at_ms === null
          ? null
          : parseNonNegativeSafeInteger(
              record.draining_at_ms,
              "commandSigningLeaseSnapshot.drainingAtMs",
            ),
      supersededAtMs:
        record.superseded_at_ms === null
          ? null
          : parseNonNegativeSafeInteger(
              record.superseded_at_ms,
              "commandSigningLeaseSnapshot.supersededAtMs",
            ),
      closedAtMs:
        record.closed_at_ms === null
          ? null
          : parseNonNegativeSafeInteger(
              record.closed_at_ms,
              "commandSigningLeaseSnapshot.closedAtMs",
            ),
      state: parsed("command signing lease state", () => {
        if (
          record.state !== "current" &&
          record.state !== "draining" &&
          record.state !== "superseded" &&
          record.state !== "closed"
        ) {
          fail("command signing lease state is unsupported");
        }
        return record.state;
      }),
    });
  });
}

function parseSigningKeys(
  transaction: HostStateRepositorySqlTransaction,
): readonly SigningKeySnapshot[] {
  return sqlAll(
    transaction,
    `SELECT collaboration_server_id, identity_key_id, key_generation, public_key
       FROM server_identity_keys ORDER BY collaboration_server_id, key_generation`,
  ).map((value) => {
    const record = row(
      value,
      ["collaboration_server_id", "identity_key_id", "key_generation", "public_key"] as const,
      "commandSigningKeySnapshot",
    );
    return Object.freeze({
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        record.collaboration_server_id,
      ),
      identityKeyId: parseA1SafeId(record.identity_key_id),
      keyGeneration: parsePositiveSafeInteger(
        record.key_generation,
        "commandSigningKeySnapshot.keyGeneration",
      ),
      publicKey: parseEd25519PublicKey(record.public_key),
    });
  });
}

function parseScopeCertificates(
  transaction: HostStateRepositorySqlTransaction,
): readonly ScopeCertificateSnapshot[] {
  return sqlAll(
    transaction,
    `SELECT scope_certificate_id, collaboration_server_id, subject_identity_key_id,
            subject_public_key, key_generation
       FROM server_scope_certificates ORDER BY collaboration_server_id, key_generation`,
  ).map((value) => {
    const record = row(
      value,
      [
        "scope_certificate_id",
        "collaboration_server_id",
        "subject_identity_key_id",
        "subject_public_key",
        "key_generation",
      ] as const,
      "commandScopeCertificateSnapshot",
    );
    return Object.freeze({
      scopeCertificateId: parseA1SafeId(record.scope_certificate_id),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        record.collaboration_server_id,
      ),
      subjectIdentityKeyId: parseA1SafeId(record.subject_identity_key_id),
      subjectPublicKey: parseEd25519PublicKey(record.subject_public_key),
      keyGeneration: parsePositiveSafeInteger(
        record.key_generation,
        "commandScopeCertificateSnapshot.keyGeneration",
      ),
    });
  });
}

const KNOWN_ARTIFACT_SCHEMAS = Object.freeze([
  A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
  A1_OPENCODE_PRE_DECISION_NORMALIZATION_SCHEMA_ID,
  A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
  A1_COMMAND_RESULT_SCHEMA_ID,
] as const);

function parseArtifacts(
  transaction: HostStateRepositorySqlTransaction,
): readonly ArtifactSnapshot[] {
  const placeholders = KNOWN_ARTIFACT_SCHEMAS.map(() => "?").join(", ");
  const values = sqlAll(
    transaction,
    `SELECT protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
            artifact_digest, byte_length, artifact_bytes, created_at_ms
       FROM protected_artifacts WHERE artifact_schema_id IN (${placeholders})
      ORDER BY protected_handle_id`,
    KNOWN_ARTIFACT_SCHEMAS,
  );
  const snapshots: ArtifactSnapshot[] = [];
  try {
    for (const value of values) {
      const record = row(
        value,
        [
          "protected_handle_id",
          "kind",
          "scope_kind",
          "scope_id",
          "artifact_schema_id",
          "artifact_digest",
          "byte_length",
          "artifact_bytes",
          "created_at_ms",
        ] as const,
        "commandArtifactSnapshot",
      );
      snapshotAssert(
        record.kind === "artifact" && record.scope_kind === "collaboration_server",
        "known command artifact has the wrong kind or scope kind",
      );
      snapshotAssert(
        record.artifact_bytes instanceof Uint8Array,
        "known command artifact is not bytes",
      );
      const byteLength = parseNonNegativeSafeInteger(
        record.byte_length,
        "commandArtifactSnapshot.byteLength",
      );
      snapshotAssert(
        record.artifact_bytes.byteLength === byteLength,
        "command artifact length is invalid",
      );
      let bytes: ProtectedByteSnapshot | undefined;
      try {
        bytes = ProtectedByteSnapshot.from(record.artifact_bytes);
        const digest = parseA1Digest(record.artifact_digest);
        const actual = bytes.copyBytes();
        try {
          snapshotAssert(
            digestBytes(actual) === digest,
            "known command artifact digest is invalid",
          );
        } finally {
          actual.fill(0);
        }
        snapshots.push(
          Object.freeze({
            protectedHandleId: parseA1CanonicalId("protectedHandle", record.protected_handle_id),
            scopeId: parseA1CanonicalId("collaborationServer", record.scope_id),
            schemaId: String(record.artifact_schema_id),
            digest,
            createdAtMs: parseNonNegativeSafeInteger(
              record.created_at_ms,
              "commandArtifactSnapshot.createdAtMs",
            ),
            bytes,
          }),
        );
        bytes = undefined;
      } finally {
        bytes?.destroy();
        record.artifact_bytes.fill(0);
      }
    }
    return snapshots;
  } catch (error) {
    for (const snapshot of snapshots) snapshot.bytes.destroy();
    throw error;
  } finally {
    for (const value of values) {
      if (typeof value !== "object" || value === null) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, "artifact_bytes");
      if (
        descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.value instanceof Uint8Array
      ) {
        descriptor.value.fill(0);
      }
    }
  }
}

/** Validate the complete dormant schema-v10 common-command graph in one read snapshot. */
export function validateCommandAdjudicationRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  schemaVersion: number,
): void {
  if (schemaVersion < 10) return;
  const expectedMachineId = parseMachineIdentityId(machineIdentityId);
  const artifacts: ArtifactSnapshot[] = [];
  try {
    const readyEntries = sqlAll(
      transaction,
      `SELECT ${READY_KEYS.join(", ")} FROM command_ready_entries
       ORDER BY collaboration_server_id, ready_at_journal_seq`,
    ).map(readyFromRow);
    const adjudications = sqlAll(
      transaction,
      `SELECT ${ADJUDICATION_KEYS.join(", ")} FROM a1_ingress_adjudications
       ORDER BY collaboration_server_id, ready_at_journal_seq`,
    ).map(adjudicationFromRow);
    const commands = sqlAll(
      transaction,
      `SELECT ${COMMAND_KEYS.join(", ")} FROM collaboration_commands
       ORDER BY collaboration_server_id, ready_at_journal_seq, command_id`,
    ).map(commandFromRow);
    const groups = sqlAll(
      transaction,
      `SELECT ${GROUP_KEYS.join(", ")}
         FROM collaboration_command_compound_signing_groups
        ORDER BY collaboration_server_id, command_result_id, preparation_generation`,
    ).map(groupFromRow);
    const preparations = sqlAll(
      transaction,
      `SELECT ${PREPARATION_KEYS.join(", ")}
         FROM collaboration_command_result_preparations
        ORDER BY collaboration_server_id, command_result_id, preparation_generation`,
    ).map(preparationFromRow);

    const servers = parseServers(transaction);
    const coordinators = parseCoordinators(transaction);
    const ingressSources = parseIngress(transaction);
    const signingLeases = parseSigningLeases(transaction);
    const signingKeys = parseSigningKeys(transaction);
    const scopeCertificates = parseScopeCertificates(transaction);
    artifacts.push(...parseArtifacts(transaction));
    const allReservations = sqlAll(
      transaction,
      `SELECT ${RESERVATION_KEYS.join(", ")} FROM server_signature_reservations
       ORDER BY collaboration_server_id, signer_sequence`,
    ).map(reservationFromRow);

    const routeRows = sqlAll(
      transaction,
      `SELECT runtime.broker_route_id, runtime.collaboration_server_id, runtime.route_kind,
              runtime.logical_chat_id, runtime.machine_identity_id, runtime.state,
              runtime.active_gap_count, runtime.updated_at_ms,
              route.created_at_ms AS route_created_at_ms
         FROM broker_route_runtime_status AS runtime
         JOIN broker_routes AS route ON route.broker_route_id = runtime.broker_route_id
        WHERE EXISTS (
          SELECT 1 FROM authenticated_ingress_results AS ingress
           WHERE ingress.broker_route_id = runtime.broker_route_id
             AND EXISTS (
               SELECT 1 FROM a1_ingress_adjudications AS adjudication
                WHERE adjudication.stable_semantic_result_id =
                      ingress.stable_semantic_result_id
             )
        ) ORDER BY runtime.broker_route_id`,
    );
    const routeScopes = new Map<
      string,
      Readonly<{
        serverId: string;
        routeKind: unknown;
        logicalChatId: unknown;
        machineId: unknown;
        state: unknown;
        activeGapCount: number;
        updatedAtMs: number;
        createdAtMs: number;
      }>
    >();
    for (const value of routeRows) {
      const record = row(
        value,
        [
          "broker_route_id",
          "collaboration_server_id",
          "route_kind",
          "logical_chat_id",
          "machine_identity_id",
          "state",
          "active_gap_count",
          "updated_at_ms",
          "route_created_at_ms",
        ] as const,
        "commandRouteScopeSnapshot",
      );
      const routeId = parseA1SafeId(record.broker_route_id);
      snapshotAssert(!routeScopes.has(routeId), "command source route scope is duplicated");
      routeScopes.set(
        routeId,
        Object.freeze({
          serverId: parseA1CanonicalId("collaborationServer", record.collaboration_server_id),
          routeKind: record.route_kind,
          logicalChatId: record.logical_chat_id,
          machineId: parseMachineIdentityId(record.machine_identity_id),
          state: record.state,
          activeGapCount: parseNonNegativeSafeInteger(
            record.active_gap_count,
            "commandRouteScopeSnapshot.activeGapCount",
          ),
          updatedAtMs: parseNonNegativeSafeInteger(
            record.updated_at_ms,
            "commandRouteScopeSnapshot.updatedAtMs",
          ),
          createdAtMs: parseNonNegativeSafeInteger(
            record.route_created_at_ms,
            "commandRouteScopeSnapshot.createdAtMs",
          ),
        }),
      );
    }

    const routeHistoryByRoute = new Map<
      string,
      Array<
        Readonly<{
          resultId: A1SafeId;
          generation: number;
          frameIndex: number;
        }>
      >
    >();
    for (const value of sqlAll(
      transaction,
      `SELECT stable_semantic_result_id, broker_route_id, first_ingress_generation,
              first_ingress_frame_index
         FROM authenticated_ingress_results
        WHERE state IN ('assembling', 'awaiting_order')
          AND broker_route_id IN (
            SELECT ingress.broker_route_id
              FROM authenticated_ingress_results AS ingress
              JOIN a1_ingress_adjudications AS adjudication
                ON adjudication.stable_semantic_result_id = ingress.stable_semantic_result_id
          )
        ORDER BY broker_route_id, first_ingress_generation,
                 first_ingress_frame_index, stable_semantic_result_id`,
    )) {
      const record = row(
        value,
        [
          "stable_semantic_result_id",
          "broker_route_id",
          "first_ingress_generation",
          "first_ingress_frame_index",
        ] as const,
        "commandRouteHeadHistorySnapshot",
      );
      const routeId = parseA1SafeId(record.broker_route_id);
      const history = routeHistoryByRoute.get(routeId) ?? [];
      history.push(
        Object.freeze({
          resultId: parseA1SafeId(record.stable_semantic_result_id),
          generation: parseNonNegativeSafeInteger(
            record.first_ingress_generation,
            "commandRouteHeadHistorySnapshot.generation",
          ),
          frameIndex: parseNonNegativeSafeInteger(
            record.first_ingress_frame_index,
            "commandRouteHeadHistorySnapshot.frameIndex",
          ),
        }),
      );
      routeHistoryByRoute.set(routeId, history);
    }

    const gapIntervalsByRoute = new Map<string, Array<readonly [number, number]>>();
    for (const value of sqlAll(
      transaction,
      `SELECT broker_route_id, opened_at_ms, resolved_at_ms
         FROM broker_route_gaps
        WHERE broker_route_id IN (
          SELECT ingress.broker_route_id
            FROM authenticated_ingress_results AS ingress
            JOIN a1_ingress_adjudications AS adjudication
              ON adjudication.stable_semantic_result_id = ingress.stable_semantic_result_id
        ) ORDER BY broker_route_id, opened_at_ms`,
    )) {
      const record = row(
        value,
        ["broker_route_id", "opened_at_ms", "resolved_at_ms"] as const,
        "commandRouteGapSnapshot",
      );
      const routeId = parseA1SafeId(record.broker_route_id);
      const openedAtMs = parseNonNegativeSafeInteger(
        record.opened_at_ms,
        "commandRouteGapSnapshot.openedAtMs",
      );
      const resolvedAtMs =
        record.resolved_at_ms === null
          ? Number.POSITIVE_INFINITY
          : parseNonNegativeSafeInteger(
              record.resolved_at_ms,
              "commandRouteGapSnapshot.resolvedAtMs",
            );
      snapshotAssert(resolvedAtMs >= openedAtMs, "command source route gap interval is invalid");
      const intervals = gapIntervalsByRoute.get(routeId) ?? [];
      const prior = intervals.at(-1);
      if (prior !== undefined && openedAtMs < prior[1]) {
        intervals[intervals.length - 1] = [prior[0], Math.max(prior[1], resolvedAtMs)] as const;
      } else {
        intervals.push([openedAtMs, resolvedAtMs] as const);
      }
      gapIntervalsByRoute.set(routeId, intervals);
    }

    snapshotAssert(
      readyEntries.length === adjudications.length && readyEntries.length === commands.length,
      "ready entry, A1 sidecar, and command inventories are not one-to-one",
    );
    snapshotAssert(
      groups.length === preparations.length,
      "signing group/preparation graph is partial",
    );

    const serversById = uniqueMap(
      servers,
      (server) => server.collaborationServerId,
      "collaboration server",
    );
    for (const server of servers) {
      snapshotAssert(
        server.machineIdentityId === expectedMachineId,
        "collaboration server belongs to another machine identity",
      );
    }
    const coordinatorsByKey = uniqueMap(
      coordinators,
      (coordinator) =>
        coordinatorKey(
          coordinator.collaborationServerId,
          coordinator.coordinatorLeaseId,
          coordinator.coordinatorEpoch,
        ),
      "coordinator lifetime",
    );
    const coordinatorHistoryByServer = new Map<string, CoordinatorSnapshot[]>();
    for (const coordinator of coordinators) {
      const history = coordinatorHistoryByServer.get(coordinator.collaborationServerId) ?? [];
      history.push(coordinator);
      coordinatorHistoryByServer.set(coordinator.collaborationServerId, history);
    }
    for (const history of coordinatorHistoryByServer.values()) {
      history.sort(
        (left, right) =>
          left.acquiredAtMs - right.acquiredAtMs || left.coordinatorEpoch - right.coordinatorEpoch,
      );
    }
    const ingressById = uniqueMap(
      ingressSources,
      (ingress) => ingress.stableSemanticResultId,
      "A1 ingress source",
    );
    const leasesById = uniqueMap(
      signingLeases,
      (lease) => lease.signingLeaseId,
      "server signing lease",
    );
    const keysByCoordinate = uniqueMap(
      signingKeys,
      (key) =>
        `${key.collaborationServerId}\u0000${key.identityKeyId}\u0000${String(key.keyGeneration)}`,
      "server signing key",
    );
    const certificatesByCoordinate = uniqueMap(
      scopeCertificates,
      (certificate) =>
        `${certificate.collaborationServerId}\u0000${certificate.scopeCertificateId}`,
      "server scope certificate",
    );
    const artifactsById = uniqueMap(
      artifacts,
      (artifact) => artifact.protectedHandleId,
      "known command artifact",
    );
    const readyByCommand = uniqueMap(
      readyEntries,
      (entry) => entry.commandId,
      "command ready entry",
    );
    const readyBySource = uniqueMap(
      readyEntries,
      (entry) => entry.stableSemanticResultId,
      "command ready source",
    );
    const adjudicationByCommand = uniqueMap(
      adjudications,
      (entry) => entry.commandId,
      "A1 adjudication command",
    );
    const adjudicationBySource = uniqueMap(
      adjudications,
      (entry) => entry.stableSemanticResultId,
      "A1 adjudication source",
    );
    for (const history of routeHistoryByRoute.values()) {
      let foundUnadjudicated = false;
      for (const result of history) {
        const adjudicated = adjudicationBySource.has(result.resultId);
        snapshotAssert(
          !adjudicated || !foundUnadjudicated,
          "materialized command bypassed an earlier unadjudicated route head",
        );
        if (!adjudicated) foundUnadjudicated = true;
      }
    }
    const commandsById = uniqueMap(
      commands,
      (command) => command.commandId,
      "collaboration command",
    );
    const preparationsById = uniqueMap(
      preparations,
      (preparation) => preparation.commandResultPreparationId,
      "command result preparation",
    );
    const preparationsByGeneration = uniqueMap(
      preparations,
      (preparation) =>
        generationKey(
          preparation.collaborationServerId,
          preparation.commandResultId,
          preparation.preparationGeneration,
        ),
      "command result preparation generation",
    );
    const groupsById = uniqueMap(groups, (group) => group.compoundSigningGroupId, "signing group");
    const reservationsByCoordinate = uniqueMap(
      allReservations,
      (reservation) =>
        reservationKey(reservation.collaborationServerId, reservation.signerSequence),
      "server signature reservation",
    );
    const commandReservations = allReservations.filter(
      (reservation) => reservation.purpose === "collaboration_command_result",
    );
    snapshotAssert(
      commandReservations.length === preparations.length,
      "command-result reservations are not one-to-one with preparations",
    );
    const reservationSequencesByServer = new Map<string, number[]>();
    for (const reservation of allReservations) {
      const sequences = reservationSequencesByServer.get(reservation.collaborationServerId) ?? [];
      sequences.push(reservation.signerSequence);
      reservationSequencesByServer.set(reservation.collaborationServerId, sequences);
    }
    const readyOffsetsByServer = new Map<string, number[]>();
    for (const entry of readyEntries) {
      const offsets = readyOffsetsByServer.get(entry.collaborationServerId) ?? [];
      offsets.push(entry.readyAtJournalSeq);
      readyOffsetsByServer.set(entry.collaborationServerId, offsets);
    }
    const preparationsByCommand = new Map<string, CollaborationCommandResultPreparationRecord[]>();
    const preparationChains = new Map<string, CollaborationCommandResultPreparationRecord[]>();
    for (const preparation of preparations) {
      const commandPreparations = preparationsByCommand.get(preparation.commandId) ?? [];
      commandPreparations.push(preparation);
      preparationsByCommand.set(preparation.commandId, commandPreparations);
      const key = `${preparation.collaborationServerId}\u0000${preparation.commandResultId}`;
      const chain = preparationChains.get(key) ?? [];
      chain.push(preparation);
      preparationChains.set(key, chain);
    }

    const acceptedCommandRows = sqlAll(
      transaction,
      `SELECT acceptance.signer_sequence
         FROM server_signed_record_acceptances AS acceptance
         JOIN server_signature_reservations AS reservation
           ON reservation.collaboration_server_id = acceptance.collaboration_server_id
          AND reservation.signer_sequence = acceptance.signer_sequence
        WHERE reservation.purpose = 'collaboration_command_result' LIMIT 1`,
    );
    snapshotAssert(
      acceptedCommandRows.length === 0,
      "schema-v10 command result has crossed into signed-record acceptance",
    );

    for (const server of servers) {
      const sequences = reservationSequencesByServer.get(server.collaborationServerId) ?? [];
      sequences.sort((left, right) => left - right);
      snapshotAssert(
        sequences.length === server.nextServerSignatureSeq &&
          sequences.every((sequence, index) => sequence === index),
        "server signature counter is high, low, or gapped",
      );
    }

    const controlJournalRows = sqlAll(
      transaction,
      `SELECT collaboration_server_id, journal_offset FROM control_journal_entries
       ORDER BY collaboration_server_id, journal_offset`,
    );
    const journalByServer = new Map<string, number[]>();
    for (const value of controlJournalRows) {
      const record = row(
        value,
        ["collaboration_server_id", "journal_offset"] as const,
        "commandControlJournalSnapshot",
      );
      const serverId = parseA1CanonicalId("collaborationServer", record.collaboration_server_id);
      const offsets = journalByServer.get(serverId) ?? [];
      offsets.push(
        parseNonNegativeSafeInteger(record.journal_offset, "commandControlJournalSnapshot.offset"),
      );
      journalByServer.set(serverId, offsets);
    }
    for (const server of servers) {
      const offsets = [
        ...(journalByServer.get(server.collaborationServerId) ?? []),
        ...(readyOffsetsByServer.get(server.collaborationServerId) ?? []),
      ].sort((left, right) => left - right);
      snapshotAssert(
        offsets.length === server.nextJournalOffset &&
          offsets.every((offset, index) => offset === index),
        "combined control/command-ready journal is high, low, duplicated, or gapped",
      );
    }

    const claimedArtifacts = new Set<string>();
    const claimedGroups = new Set<string>();
    const claimedPreparations = new Set<string>();
    const claimedCommandReservations = new Set<string>();
    const activeGroupServers = new Set<string>();
    const activeGroupResults = new Set<string>();
    const commandsByServer = new Map<string, CollaborationCommandRecord[]>();

    for (const command of commands) {
      const server = serversById.get(command.collaborationServerId);
      const ready = readyByCommand.get(command.commandId);
      const adjudication = adjudicationByCommand.get(command.commandId);
      const ingress = ingressById.get(command.sourceRef);
      snapshotAssert(server !== undefined, "command collaboration server is absent");
      snapshotAssert(
        ready !== undefined &&
          adjudication !== undefined &&
          ingress !== undefined &&
          readyBySource.get(command.sourceRef) === ready &&
          adjudicationBySource.get(command.sourceRef) === adjudication,
        "command ready/source/sidecar graph is partial or swapped",
      );
      snapshotAssert(
        ready.collaborationServerId === command.collaborationServerId &&
          ready.commandId === command.commandId &&
          ready.stableSemanticResultId === command.sourceRef &&
          ready.readyAtJournalSeq === command.readyAtJournalSeq &&
          ready.coordinatorLeaseId === command.coordinatorLeaseId &&
          ready.coordinatorEpoch === command.coordinatorEpoch &&
          ready.readyAtMs === command.createdAtMs &&
          adjudication.collaborationServerId === command.collaborationServerId &&
          adjudication.commandId === command.commandId &&
          adjudication.stableSemanticResultId === command.sourceRef &&
          adjudication.readyAtJournalSeq === command.readyAtJournalSeq,
        "command ready provenance is not one exact atomic observation",
      );
      assertObservedWithinCoordinator(
        coordinatorsByKey,
        command.collaborationServerId,
        command.coordinatorLeaseId,
        command.coordinatorEpoch,
        command.createdAtMs,
        "command creation",
      );
      const route = routeScopes.get(ingress.brokerRouteId);
      snapshotAssert(
        ingress.collaborationServerId === command.collaborationServerId &&
          ingress.routeKind === command.scopeKind &&
          ingress.logicalChatId === command.logicalChatId &&
          command.mutationFamily === (ingress.recordKind === "user" ? "user_text" : "new_chat") &&
          (command.scopeKind === "chat"
            ? command.targetLogicalChatId === command.logicalChatId
            : command.targetLogicalChatId === null) &&
          ingress.sourceEventNamespaceId === command.sourceEventNamespaceId &&
          ingress.messageId === command.sourceEventId &&
          route?.serverId === command.collaborationServerId &&
          route.routeKind === command.scopeKind &&
          route.logicalChatId === command.logicalChatId &&
          route.machineId === expectedMachineId &&
          route.createdAtMs <= command.createdAtMs,
        "command source machine/server/route scope is inconsistent",
      );
      snapshotAssert(
        !intervalContains(
          gapIntervalsByRoute.get(ingress.brokerRouteId) ?? [],
          command.createdAtMs,
        ),
        "command creation was observed inside an open source-route gap interval",
      );
      if (route.state === "closed") {
        snapshotAssert(
          command.createdAtMs <= route.updatedAtMs &&
            (command.decidedAtMs === null || command.decidedAtMs <= route.updatedAtMs),
          "command lifecycle postdates the closed source route",
        );
      }

      const source = sourceIdentity(expectedMachineId, ingress);
      const identityBytes = source.identityId;
      let sourceDigest: A1Digest;
      try {
        sourceDigest = digestCanonical(() => canonicalA1CommandSourceIdentity(source));
      } finally {
        identityBytes.fill(0);
      }
      const commandIdBytes = canonicalA1CollaborationCommandIdPreimage({
        collaborationServerId: command.collaborationServerId,
        sourceKind: "a1_ingress",
        sourceCommandIdentityDigest: sourceDigest,
      });
      let expectedCommandId: string;
      try {
        expectedCommandId = `rcm_${createHash("sha256").update(commandIdBytes).digest("base64url")}`;
      } finally {
        commandIdBytes.fill(0);
      }
      snapshotAssert(
        command.sourceCommandIdentityDigest === sourceDigest &&
          command.commandId === expectedCommandId,
        "command source identity digest or command ID is noncanonical",
      );
      snapshotAssert(
        command.canonicalCommandPayloadSchemaId ===
          A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID &&
          command.preDecisionNormalizationEvidenceSchemaId === null &&
          command.preDecisionNormalizationEvidenceRef === null &&
          command.preDecisionNormalizationEvidenceDigest === null,
        "command uses a payload or normalization surface unreachable in schema v10",
      );
      const payloadBytes = canonicalA1CommandPayload(commandPayload(ingress));
      try {
        assertArtifact(
          artifactsById,
          claimedArtifacts,
          {
            ref: command.canonicalCommandPayloadRef,
            serverId: command.collaborationServerId,
            schemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
            digest: command.canonicalCommandPayloadDigest,
            createdAtMs: command.createdAtMs,
            bytes: payloadBytes,
          },
          "canonical command payload",
        );
      } finally {
        payloadBytes.fill(0);
      }

      const serverCommands = commandsByServer.get(command.collaborationServerId) ?? [];
      serverCommands.push(command);
      commandsByServer.set(command.collaborationServerId, serverCommands);

      if (command.state === "awaiting_order") {
        snapshotAssert(
          adjudication.state === "awaiting_order" && !preparationsByCommand.has(command.commandId),
          "awaiting command has premature decision artifacts",
        );
        continue;
      }
      snapshotAssert(
        command.state !== "decided",
        "schema-v10 command reached a final result state",
      );
      snapshotAssert(
        command.disposition === "rejected" &&
          adjudication.state === "deciding" &&
          adjudication.commandSeq === command.commandSeq &&
          adjudication.disposition === command.disposition &&
          adjudication.commandResultId !== null &&
          adjudication.commandResultPreparationId !== null &&
          adjudication.decidedAtMs === command.decidedAtMs &&
          command.decidedAtMs !== null &&
          command.decisionCoordinatorLeaseId !== null &&
          command.decisionCoordinatorEpoch !== null &&
          command.currentCommandResultId === null,
        "reserved command decision and A1 sidecar are inconsistent",
      );
      assertObservedWithinCoordinator(
        coordinatorsByKey,
        command.collaborationServerId,
        command.decisionCoordinatorLeaseId,
        command.decisionCoordinatorEpoch,
        command.decidedAtMs,
        "command decision",
      );
      snapshotAssert(
        !intervalContains(
          gapIntervalsByRoute.get(ingress.brokerRouteId) ?? [],
          command.decidedAtMs,
        ),
        "command decision was observed inside an open source-route gap interval",
      );
      const evidenceBytes = canonicalA1CommandDecisionEvidence(rejectedDecisionEvidence(command));
      try {
        snapshotAssert(
          command.decisionEvidenceSchemaId === A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID &&
            command.decisionEvidenceRef !== null &&
            command.decisionEvidenceDigest !== null,
          "rejected command decision evidence is partial",
        );
        assertArtifact(
          artifactsById,
          claimedArtifacts,
          {
            ref: command.decisionEvidenceRef,
            serverId: command.collaborationServerId,
            schemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
            digest: command.decisionEvidenceDigest,
            createdAtMs: command.decidedAtMs,
            bytes: evidenceBytes,
          },
          "command decision evidence",
        );
      } finally {
        evidenceBytes.fill(0);
      }
      snapshotAssert(
        command.canonicalCommandRecordDigest ===
          digestCanonical(() => canonicalA1CommandRecord(canonicalCommandRecord(command))),
        "canonical command record digest does not recompute",
      );
      const expectedResultId = deriveCollaborationCommandResultId(
        command.collaborationServerId,
        command.commandId,
      );
      snapshotAssert(
        adjudication.commandResultId === expectedResultId,
        "command result ID does not recompute from the frozen command",
      );

      const chain =
        preparationChains.get(`${command.collaborationServerId}\u0000${expectedResultId}`) ?? [];
      chain.sort((left, right) => left.preparationGeneration - right.preparationGeneration);
      snapshotAssert(chain.length > 0, "reserved command has no result preparation chain");
      const latest = chain.at(-1) as CollaborationCommandResultPreparationRecord;
      snapshotAssert(
        latest.commandResultPreparationId === adjudication.commandResultPreparationId,
        "A1 sidecar does not point to the latest preparation generation",
      );
      for (const [index, preparation] of chain.entries()) {
        const generation = index + 1;
        const prior = chain[index - 1];
        const group = groupsById.get(preparation.compoundSigningGroupId);
        const reservation = reservationsByCoordinate.get(
          reservationKey(preparation.collaborationServerId, preparation.signerSequence),
        );
        snapshotAssert(
          preparation.preparationGeneration === generation &&
            preparation.commandId === command.commandId &&
            preparation.commandResultId === expectedResultId &&
            preparation.canonicalCommandRecordDigest === command.canonicalCommandRecordDigest &&
            preparation.commandResultPreparationId ===
              deriveCollaborationCommandResultPreparationId({
                collaborationServerId: command.collaborationServerId,
                commandId: command.commandId,
                commandResultId: expectedResultId,
                preparationGeneration: generation,
              }) &&
            preparation.supersedesPreparationRef === (prior?.commandResultPreparationId ?? null) &&
            group !== undefined &&
            group.compoundSigningGroupId ===
              deriveCollaborationCommandCompoundSigningGroupId({
                collaborationServerId: command.collaborationServerId,
                commandId: command.commandId,
                commandResultId: expectedResultId,
                preparationGeneration: generation,
              }) &&
            group.collaborationServerId === preparation.collaborationServerId &&
            group.commandId === preparation.commandId &&
            group.commandResultId === preparation.commandResultId &&
            group.preparationGeneration === preparation.preparationGeneration &&
            group.signingLeaseId === preparation.signingLeaseId &&
            group.resultPreparationRef === preparation.commandResultPreparationId &&
            reservation !== undefined,
          "result preparation generation graph is noncanonical",
        );
        claimedPreparations.add(preparation.commandResultPreparationId);
        claimedGroups.add(group.compoundSigningGroupId);
        claimedCommandReservations.add(
          reservationKey(reservation.collaborationServerId, reservation.signerSequence),
        );
        snapshotAssert(
          (generation === 1 && preparation.preparedAtMs === command.decidedAtMs) ||
            (generation > 1 &&
              prior !== undefined &&
              prior.state === "aborted" &&
              prior.abortedAtMs !== null &&
              preparation.preparedAtMs > prior.abortedAtMs),
          "result preparation generation timestamps or supersession are invalid",
        );
        if (generation < chain.length) {
          snapshotAssert(preparation.state === "aborted", "superseded preparation is not aborted");
        }
        if (group.state !== "aborted") {
          const activeResultKey = `${group.collaborationServerId}\u0000${group.commandResultId}`;
          snapshotAssert(
            !activeGroupServers.has(group.collaborationServerId) &&
              !activeGroupResults.has(activeResultKey),
            "schema-v10 command signer has more than one active group",
          );
          activeGroupServers.add(group.collaborationServerId);
          activeGroupResults.add(activeResultKey);
        }
        if (prior !== undefined) {
          snapshotAssert(
            preparation.signerSequence > prior.signerSequence,
            "replacement signer sequence does not advance its prior generation",
          );
        }

        const signingLease = leasesById.get(preparation.signingLeaseId);
        snapshotAssert(
          signingLease !== undefined &&
            signingLease.collaborationServerId === preparation.collaborationServerId &&
            signingLease.acquiredAtMs <= preparation.preparedAtMs,
          "result preparation has no exact historical signing lease",
        );
        const leaseAuthorityEnd = Math.min(
          signingLease.drainingAtMs ?? Number.POSITIVE_INFINITY,
          signingLease.supersededAtMs ?? Number.POSITIVE_INFINITY,
          signingLease.closedAtMs ?? Number.POSITIVE_INFINITY,
        );
        snapshotAssert(
          preparation.preparedAtMs <= leaseAuthorityEnd,
          "result reservation postdates its signing lease authority",
        );
        if (generation === 1) {
          snapshotAssert(
            signingLease.coordinatorLeaseId === command.decisionCoordinatorLeaseId &&
              signingLease.coordinatorEpoch === command.decisionCoordinatorEpoch,
            "generation-one signer and command decision fences do not match",
          );
        }
        assertObservedWithinCoordinator(
          coordinatorsByKey,
          preparation.collaborationServerId,
          signingLease.coordinatorLeaseId,
          signingLease.coordinatorEpoch,
          preparation.preparedAtMs,
          "result signer reservation",
        );
        for (const [label, observedAtMs] of [
          ["bind", preparation.boundAtMs],
          ["sign", preparation.signedAtMs],
        ] as const) {
          if (observedAtMs === null) continue;
          snapshotAssert(
            observedAtMs <= leaseAuthorityEnd,
            `result preparation ${label} postdates its signing lease authority`,
          );
          assertObservedWithinCoordinator(
            coordinatorsByKey,
            preparation.collaborationServerId,
            signingLease.coordinatorLeaseId,
            signingLease.coordinatorEpoch,
            observedAtMs,
            `result preparation ${label}`,
          );
        }
        if (preparation.abortedAtMs !== null) {
          snapshotAssert(
            coordinatorHistoryContains(
              coordinatorHistoryByServer.get(preparation.collaborationServerId) ?? [],
              preparation.abortedAtMs,
            ),
            "result preparation abort lies outside server coordinator authority",
          );
        }
        const signingKey = keysByCoordinate.get(
          `${signingLease.collaborationServerId}\u0000${signingLease.identityKeyId}\u0000${String(signingLease.keyGeneration)}`,
        );
        snapshotAssert(signingKey !== undefined, "result preparation signer key is absent");
        const scopeCertificate = certificatesByCoordinate.get(
          `${signingLease.collaborationServerId}\u0000${signingLease.scopeCertificateId}`,
        );
        snapshotAssert(
          scopeCertificate !== undefined &&
            scopeCertificate.subjectIdentityKeyId === signingKey.identityKeyId &&
            scopeCertificate.keyGeneration === signingKey.keyGeneration &&
            scopeCertificate.subjectPublicKey === signingKey.publicKey,
          "result preparation signing lease, key, and scope certificate are inconsistent",
        );

        const resultPayload = canonicalResultPayload(preparation, command, signingLease);
        const resultBytes = canonicalA1CommandResultPayload(resultPayload);
        try {
          assertArtifact(
            artifactsById,
            claimedArtifacts,
            {
              ref: preparation.canonicalPayloadRef,
              serverId: preparation.collaborationServerId,
              schemaId: A1_COMMAND_RESULT_SCHEMA_ID,
              digest: preparation.canonicalPayloadDigest,
              createdAtMs: preparation.preparedAtMs,
              bytes: resultBytes,
            },
            "canonical command result payload",
          );
          validatePreparationLifecycle(preparation, group, reservation, signingKey, resultBytes);
        } finally {
          resultBytes.fill(0);
        }
      }
    }

    for (const server of servers) {
      const serverCommands = commandsByServer.get(server.collaborationServerId) ?? [];
      snapshotAssert(
        serverCommands.length <= 256,
        "collaboration server unresolved command limit exceeded",
      );
      serverCommands.sort(
        (left, right) =>
          left.readyAtJournalSeq - right.readyAtJournalSeq ||
          left.commandId.localeCompare(right.commandId),
      );
      const ordered = serverCommands.filter((command) => command.commandSeq !== null);
      snapshotAssert(
        ordered.length === server.nextCommandSeq &&
          ordered.every(
            (command, index) => command.commandSeq === index && serverCommands[index] === command,
          ),
        "server command sequence is high, low, gapped, or violates global ready order",
      );
    }

    snapshotAssert(
      claimedPreparations.size === preparationsById.size &&
        claimedGroups.size === groupsById.size &&
        claimedCommandReservations.size === commandReservations.length,
      "known schema-v10 signing artifact is orphaned",
    );
    snapshotAssert(
      claimedArtifacts.size === artifactsById.size,
      "known schema-v10 protected artifact is orphaned",
    );
    snapshotAssert(
      readyByCommand.size === commandsById.size &&
        readyBySource.size === ingressById.size &&
        adjudicationBySource.size === ingressById.size &&
        preparationsByGeneration.size === preparations.length,
      "schema-v10 command graph contains an orphan or duplicate edge",
    );
  } catch (error) {
    if (error instanceof CommandAdjudicationRepositoryPersistenceError) throw error;
    fail("command adjudication snapshot is invalid", error);
  } finally {
    for (const artifact of artifacts) artifact.bytes.destroy();
  }
}

function validatePreparationLifecycle(
  preparation: CollaborationCommandResultPreparationRecord,
  group: CollaborationCommandCompoundSigningGroupRecord,
  reservation: ServerSignatureReservationRecord,
  signingKey: SigningKeySnapshot,
  canonicalPayloadBytes: Uint8Array,
): void {
  snapshotAssert(
    reservation.collaborationServerId === preparation.collaborationServerId &&
      reservation.signerSequence === preparation.signerSequence &&
      reservation.signingLeaseId === preparation.signingLeaseId &&
      reservation.signingLeaseKind === "current" &&
      reservation.purpose === "collaboration_command_result" &&
      reservation.reservedAtMs === preparation.preparedAtMs &&
      group.reservedAtMs === preparation.preparedAtMs,
    "result preparation reservation coordinates are inconsistent",
  );
  const boundTupleIsNull =
    reservation.canonicalPayloadSchemaId === null &&
    reservation.canonicalPayloadRef === null &&
    reservation.canonicalPayloadDigest === null &&
    reservation.signedArtifactType === null &&
    reservation.signedArtifactId === null &&
    reservation.boundAtMs === null;
  const boundTupleIsExact =
    reservation.canonicalPayloadSchemaId === A1_COMMAND_RESULT_SCHEMA_ID &&
    reservation.canonicalPayloadRef === preparation.canonicalPayloadRef &&
    reservation.canonicalPayloadDigest === preparation.canonicalPayloadDigest &&
    reservation.signedArtifactType === COMMAND_RESULT_PREPARATION_ARTIFACT_TYPE &&
    reservation.signedArtifactId === preparation.commandResultPreparationId &&
    reservation.boundAtMs === preparation.boundAtMs &&
    preparation.boundAtMs !== null;
  const unsigned =
    reservation.signedRecordDigest === null &&
    reservation.signature === null &&
    reservation.signedAtMs === null;

  if (preparation.state === "reserved") {
    snapshotAssert(
      group.state === "reserved" &&
        reservation.state === "reserved" &&
        boundTupleIsNull &&
        unsigned &&
        reservation.abortedAtMs === null,
      "reserved command result preparation graph is inconsistent",
    );
    return;
  }
  if (preparation.state === "bound") {
    snapshotAssert(
      group.state === "reserved" &&
        reservation.state === "bound" &&
        boundTupleIsExact &&
        unsigned &&
        reservation.abortedAtMs === null,
      "bound command result preparation graph is inconsistent",
    );
    return;
  }
  if (preparation.state === "aborted") {
    snapshotAssert(
      group.state === "aborted" &&
        reservation.state === "aborted" &&
        group.abortedAtMs === preparation.abortedAtMs &&
        reservation.abortedAtMs === preparation.abortedAtMs &&
        unsigned &&
        (preparation.boundAtMs === null ? boundTupleIsNull : boundTupleIsExact),
      "aborted command result preparation graph is inconsistent",
    );
    return;
  }
  snapshotAssert(
    preparation.state === "signed" &&
      group.state === "result_signed" &&
      reservation.state === "signed" &&
      boundTupleIsExact &&
      preparation.signedAtMs !== null &&
      group.resultSignedAtMs === preparation.signedAtMs &&
      reservation.signedAtMs === preparation.signedAtMs &&
      reservation.signature !== null &&
      reservation.signedRecordDigest !== null &&
      reservation.abortedAtMs === null,
    "signed command result preparation graph is inconsistent",
  );
  const signatureBytes = base64urlDecode(reservation.signature);
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: signingKey.publicKey },
      format: "jwk",
    });
    snapshotAssert(
      verify(null, canonicalPayloadBytes, key, signatureBytes),
      "command result signature does not verify under the reserved key",
    );
  } finally {
    signatureBytes.fill(0);
  }
  snapshotAssert(
    reservation.signedRecordDigest ===
      digestCanonical(() =>
        canonicalA1SignedCommandResult({
          canonicalPayloadDigest: preparation.canonicalPayloadDigest,
          signerIdentityKeyId: signingKey.identityKeyId,
          serverKeyGeneration: signingKey.keyGeneration,
          signerSequence: preparation.signerSequence,
          signature: reservation.signature,
        }),
      ),
    "signed command result digest does not recompute",
  );
}
