import { createHash } from "node:crypto";
import { base64urlDecode, base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import type { NativeEngineDescriptor } from "../native/adapter.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type Ed25519PublicKey,
  type Ed25519Signature,
  HostStateContractError,
  type LogicalChatId,
  type NativeBindingId,
  type NativeRuntimeId,
  type ProjectId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseEd25519Signature,
  parseMachineIdentityId,
  parseWardenLaunchNonce,
  type WardenLaunchNonce,
} from "./ids.js";
import {
  ProtectedByteSnapshot,
  type ProtectedHandleRef,
  parseProtectedHandleRef,
} from "./protected.js";
import {
  type CoordinatorLeaseFence,
  type CoordinatorLeaseRecord,
  parseCoordinatorLeaseFence,
  parseCoordinatorLeaseRecord,
} from "./records.js";
import type {
  HostStateRepositorySqlTransaction,
  HostStateRepositorySqlValue,
  HostStateRepositoryTransactionExecutor,
} from "./repository.js";
import {
  type LocalNativeConversationRecord,
  type LocalNativeConversationTransitionRecord,
  type NativeBindingIncarnationRecord,
  type NativeBindingRuntimeGateRecord,
  type NativeRuntimeContainmentRecord,
  type NativeRuntimeIncarnationRecord,
  type NativeRuntimeRecord,
  type NativeTransportAttachmentRecord,
  type NativeTransportLeaseRecord,
  parseLocalNativeConversationRecord,
  parseLocalNativeConversationTransitionRecord,
  parseNativeBindingIncarnationRecord,
  parseNativeBindingRuntimeGateRecord,
  parseNativeRuntimeContainmentRecord,
  parseNativeRuntimeIncarnationRecord,
  parseNativeRuntimeRecord,
  parseNativeTransportAttachmentRecord,
  parseNativeTransportLeaseRecord,
  parseRuntimeOwnerAssignmentRecord,
  parseRuntimeOwnerIdentityKeyRecord,
  parseRuntimeOwnerServiceLeaseRecord,
  parseRuntimeOwnerSignatureReservationRecord,
  parseRuntimeOwnerSignedRecordAcceptanceRecord,
  RUNTIME_OWNER_SIGNATURE_PURPOSES,
  type RuntimeOwnerAssignmentRecord,
  type RuntimeOwnerIdentityKeyRecord,
  type RuntimeOwnerServiceLeaseRecord,
  type RuntimeOwnerSignaturePurpose,
  type RuntimeOwnerSignatureReservationRecord,
  type RuntimeOwnerSignatureSchemaId,
  type RuntimeOwnerSignedRecordAcceptanceRecord,
} from "./runtime.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
  parseNullable,
  parsePositiveSafeInteger,
  reject,
  type UnknownRecord,
} from "./validation.js";

export const RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID =
  "remote-claw/runtime-owner-key-wrap/aes-256-gcm/v1" as const;

export const RUNTIME_OWNER_JOURNAL_ENTRY_KINDS = Object.freeze([
  "service_lease_acquired",
  "service_lease_released",
  "runtime_registered",
  "runtime_reassigned",
  "runtime_replaced",
  "runtime_terminated",
  "runtime_key_rotated",
  "local_conversation_transitioned",
  "binding_incarnation_prepared",
  "attachment_lease_acquired",
  "attachment_detached",
] as const);

export type RuntimeOwnerJournalEntryKind = (typeof RUNTIME_OWNER_JOURNAL_ENTRY_KINDS)[number];

export const RUNTIME_OWNER_JOURNAL_SUBJECT_KINDS = Object.freeze([
  "service_lease",
  "native_runtime",
  "runtime_owner_identity_key",
  "local_native_transition",
  "native_binding_incarnation",
  "native_transport_lease",
] as const);

export type RuntimeOwnerJournalSubjectKind = (typeof RUNTIME_OWNER_JOURNAL_SUBJECT_KINDS)[number];

export interface RuntimeOwnerOperationEvidence {
  readonly operationId: A1SafeId;
  readonly operationSchemaId: string;
  readonly operationDigest: A1Digest;
}

/** Every mutating call after acquisition presents the exact process identity. */
export interface RuntimeOwnerServiceFence {
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly ownerInstanceId: A1SafeId;
  readonly ownerProcessStartIdentitySchemaId: string;
  readonly ownerProcessStartIdentityRef: A1SafeId;
  readonly ownerProcessStartIdentityDigest: A1Digest;
}

export interface RuntimeOwnerJournalEntry {
  readonly journalOffset: number;
  readonly entryKind: RuntimeOwnerJournalEntryKind;
  readonly subjectKind: RuntimeOwnerJournalSubjectKind;
  readonly subjectId: A1SafeId;
  readonly operationId: A1SafeId;
  readonly operationSchemaId: string;
  readonly operationDigest: A1Digest;
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly committedAtMs: number;
}

export interface RuntimeOwnerStateRecord {
  readonly machineIdentityId: string;
  readonly currentRuntimeOwnerServiceEpoch: number;
  readonly currentRuntimeOwnerServiceLeaseId: A1SafeId | null;
  readonly nextJournalOffset: number;
  readonly createdAtMs: number;
}

/** Ciphertext-only durable custody envelope; this type can never hold plaintext PKCS#8. */
export interface RuntimeOwnerPrivateKeyEnvelopeRecord {
  readonly signingKeyRef: ProtectedHandleRef<"signing_key">;
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly wrappingSchemaId: typeof RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID;
  readonly wrapNonce: ProtectedByteSnapshot;
  readonly wrappedPkcs8: ProtectedByteSnapshot;
  readonly authTag: ProtectedByteSnapshot;
  readonly pkcs8Digest: A1Digest;
  readonly createdAtMs: number;
  readonly destroyedAtMs: number | null;
  readonly state: "current" | "destroyed";
}

export interface RuntimeOwnerKeyMaterialInput {
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly publicKey: Ed25519PublicKey;
  readonly signingKeyRef: ProtectedHandleRef<"signing_key">;
  readonly localTrustEvidenceRef: A1SafeId;
  readonly localTrustEvidenceDigest: A1Digest;
  readonly wrapNonce: ProtectedByteSnapshot;
  readonly wrappedPkcs8: ProtectedByteSnapshot;
  readonly authTag: ProtectedByteSnapshot;
  readonly pkcs8Digest: A1Digest;
}

export interface AcquireRuntimeOwnerServiceLeaseRequest {
  readonly candidateLeaseId: A1SafeId;
  readonly ownerInstanceId: A1SafeId;
  readonly ownerProcessStartIdentitySchemaId: string;
  readonly ownerProcessStartIdentityRef: A1SafeId;
  readonly ownerProcessStartIdentityDigest: A1Digest;
  readonly expectedCurrentLeaseId: A1SafeId | null;
  readonly expectedRuntimeOwnerServiceEpoch: number;
  readonly leaseDurationMs: number;
  readonly operation: RuntimeOwnerOperationEvidence;
}

export interface AcquireRuntimeOwnerServiceLeaseResult {
  readonly lease: RuntimeOwnerServiceLeaseRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
  readonly isCurrent: boolean;
  readonly unexpired: boolean;
}

export interface RenewRuntimeOwnerServiceLeaseRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly expectedHeartbeatDeadlineMs: number;
  readonly newHeartbeatDeadlineMs: number;
}

export interface RenewRuntimeOwnerServiceLeaseResult {
  readonly lease: RuntimeOwnerServiceLeaseRecord;
  readonly replayed: boolean;
}

export interface ReleaseRuntimeOwnerServiceLeaseRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly operation: RuntimeOwnerOperationEvidence;
}

export interface ReleaseRuntimeOwnerServiceLeaseResult {
  readonly lease: RuntimeOwnerServiceLeaseRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface RegisterInitialRuntimeRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly runtimeId: NativeRuntimeId;
  readonly descriptor: NativeEngineDescriptor;
  readonly wardenLaunchNonce: WardenLaunchNonce;
  readonly startIdentitySchemaId: string;
  readonly startIdentityRef: A1SafeId;
  readonly startIdentityDigest: A1Digest;
  readonly runtimeOwnerAssignmentId: A1SafeId;
  readonly key: RuntimeOwnerKeyMaterialInput;
}

export interface RuntimeRegistrationResult {
  readonly runtime: NativeRuntimeRecord;
  readonly incarnation: NativeRuntimeIncarnationRecord;
  readonly assignment: RuntimeOwnerAssignmentRecord;
  readonly identityKey: RuntimeOwnerIdentityKeyRecord;
  readonly privateKey: RuntimeOwnerPrivateKeyEnvelopeRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface ReassignRuntimeOwnerRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly expectedRuntimeOwnerAssignmentId: A1SafeId;
  readonly runtimeOwnerAssignmentId: A1SafeId;
  readonly reattachmentEvidenceSchemaId: string;
  readonly reattachmentEvidenceRef: A1SafeId;
  readonly reattachmentEvidenceDigest: A1Digest;
}

export interface ReassignRuntimeOwnerResult {
  readonly runtime: NativeRuntimeRecord;
  readonly incarnation: NativeRuntimeIncarnationRecord;
  readonly previousAssignment: RuntimeOwnerAssignmentRecord;
  readonly assignment: RuntimeOwnerAssignmentRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface ReplaceRuntimeIncarnationRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly runtimeId: NativeRuntimeId;
  readonly predecessorNativeIncarnation: number;
  readonly expectedRuntimeOwnerAssignmentId: A1SafeId;
  readonly containmentId: A1SafeId;
  readonly containmentEvidenceSchemaId: string;
  readonly containmentEvidenceRef: A1SafeId;
  readonly containmentEvidenceDigest: A1Digest;
  readonly successorStartIdentitySchemaId: string;
  readonly successorStartIdentityRef: A1SafeId;
  readonly successorStartIdentityDigest: A1Digest;
  readonly successorRuntimeOwnerAssignmentId: A1SafeId;
}

export interface ReplaceRuntimeIncarnationResult {
  readonly runtime: NativeRuntimeRecord;
  readonly predecessor: NativeRuntimeIncarnationRecord;
  readonly successor: NativeRuntimeIncarnationRecord;
  readonly containment: NativeRuntimeContainmentRecord;
  readonly assignment: RuntimeOwnerAssignmentRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface TerminateRuntimeRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly runtimeId: NativeRuntimeId;
  readonly predecessorNativeIncarnation: number;
  readonly expectedRuntimeOwnerAssignmentId: A1SafeId;
  readonly containmentId: A1SafeId;
  readonly containmentEvidenceSchemaId: string;
  readonly containmentEvidenceRef: A1SafeId;
  readonly containmentEvidenceDigest: A1Digest;
}

export interface TerminateRuntimeResult {
  readonly runtime: NativeRuntimeRecord;
  readonly predecessor: NativeRuntimeIncarnationRecord;
  readonly containment: NativeRuntimeContainmentRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface LocalConversationTargetInput {
  readonly localNativeConversationId: A1SafeId;
  readonly descriptor: NativeEngineDescriptor;
  readonly projectId: ProjectId;
  readonly semanticConversationId: A1SafeId | null;
  readonly parentLocalNativeConversationId: A1SafeId | null;
  readonly state: "unbound" | "open" | "closed";
}

export interface AppendLocalNativeConversationTransitionRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly localTransitionId: A1SafeId;
  readonly kind: LocalNativeConversationTransitionRecord["kind"];
  readonly sourceLocalNativeConversationId: A1SafeId | null;
  readonly target: LocalConversationTargetInput;
  readonly observedSemanticConversationId: A1SafeId | null;
  readonly nativeEvidenceSchemaId: string;
  readonly nativeEvidenceRef: A1SafeId;
  readonly nativeEvidenceDigest: A1Digest;
}

export interface AppendLocalNativeConversationTransitionResult {
  readonly conversation: LocalNativeConversationRecord;
  readonly transition: LocalNativeConversationTransitionRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface PrepareNativeBindingRuntimeRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly bindingOperation: RuntimeOwnerOperationEvidence;
  readonly attachmentOperation: RuntimeOwnerOperationEvidence;
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly nativeBindingId: NativeBindingId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly semanticConversationId: A1SafeId;
  readonly attachmentId: A1SafeId;
  readonly attachmentKind: NativeTransportAttachmentRecord["kind"];
  readonly transportId: A1SafeId;
  readonly attachmentGeneration: number;
  readonly attachmentLeaseId: A1SafeId;
  readonly transportEpoch: number;
  readonly resourceOwnership: NativeTransportAttachmentRecord["resourceOwnership"];
  readonly phase: "starting" | "recovering";
  readonly disconnectPolicy: NativeBindingRuntimeGateRecord["disconnectPolicy"];
}

export interface PrepareNativeBindingRuntimeResult {
  readonly bindingIncarnation: NativeBindingIncarnationRecord;
  readonly attachment: NativeTransportAttachmentRecord;
  readonly attachmentLease: NativeTransportLeaseRecord;
  readonly gate: NativeBindingRuntimeGateRecord;
  readonly bindingJournalEntry: RuntimeOwnerJournalEntry;
  readonly attachmentJournalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface DetachNativeBindingRuntimeRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly nativeBindingId: NativeBindingId;
  readonly attachmentLeaseId: A1SafeId;
  readonly expectedGateGeneration: number;
}

export interface DetachNativeBindingRuntimeResult {
  readonly runtime: NativeRuntimeRecord;
  readonly bindingIncarnation: NativeBindingIncarnationRecord;
  readonly attachment: NativeTransportAttachmentRecord;
  readonly attachmentLease: NativeTransportLeaseRecord;
  readonly gate: NativeBindingRuntimeGateRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface RotateRuntimeOwnerKeyRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly runtimeId: NativeRuntimeId;
  readonly expectedRuntimeOwnerIdentityKeyId: A1SafeId;
  readonly expectedKeyGeneration: number;
  readonly key: RuntimeOwnerKeyMaterialInput;
}

export interface RotateRuntimeOwnerKeyResult {
  readonly previousIdentityKey: RuntimeOwnerIdentityKeyRecord;
  readonly previousPrivateKey: RuntimeOwnerPrivateKeyEnvelopeRecord;
  readonly identityKey: RuntimeOwnerIdentityKeyRecord;
  readonly privateKey: RuntimeOwnerPrivateKeyEnvelopeRecord;
  readonly journalEntry: RuntimeOwnerJournalEntry;
  readonly replayed: boolean;
}

export interface ReserveRuntimeOwnerSignatureRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly expectedSignerSequence: number;
  readonly purpose: RuntimeOwnerSignaturePurpose;
}

export interface BindRuntimeOwnerSignatureRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly canonicalPayloadSchemaId: RuntimeOwnerSignatureSchemaId;
  readonly canonicalPayloadRef: A1SafeId;
  readonly canonicalPayloadDigest: A1Digest;
}

export interface StoreRuntimeOwnerSignatureRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly signedRecordDigest: A1Digest;
  readonly signature: Ed25519Signature;
  readonly signedArtifactId: A1SafeId;
}

export interface AcceptRuntimeOwnerSignedRecordRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly signedRecordDigest: A1Digest;
}

export interface AbortRuntimeOwnerSignatureRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
}

export interface RuntimeOwnerSignatureMutationResult {
  readonly reservation: RuntimeOwnerSignatureReservationRecord;
  readonly replayed: boolean;
}

export interface RuntimeOwnerSignedRecordAcceptanceResult {
  readonly acceptance: RuntimeOwnerSignedRecordAcceptanceRecord;
  readonly replayed: boolean;
}

/**
 * Internal result for the terminal-root repository's transaction-local finalizer.
 * This surface is deliberately not part of RuntimeOwnerRepositoryOperations.
 */
export interface RuntimeOwnerNativeRootSignatureFinalizationResult {
  readonly reservation: RuntimeOwnerSignatureReservationRecord;
  readonly acceptance: RuntimeOwnerSignedRecordAcceptanceRecord;
}

export interface RuntimeOwnerInventory {
  readonly state: RuntimeOwnerStateRecord;
  readonly serviceLeases: readonly RuntimeOwnerServiceLeaseRecord[];
  readonly journal: readonly RuntimeOwnerJournalEntry[];
  readonly runtimes: readonly NativeRuntimeRecord[];
  readonly incarnations: readonly NativeRuntimeIncarnationRecord[];
  readonly assignments: readonly RuntimeOwnerAssignmentRecord[];
  readonly containments: readonly NativeRuntimeContainmentRecord[];
  readonly identityKeys: readonly RuntimeOwnerIdentityKeyRecord[];
  readonly privateKeys: readonly RuntimeOwnerPrivateKeyEnvelopeRecord[];
  readonly signatureReservations: readonly RuntimeOwnerSignatureReservationRecord[];
  readonly signedRecordAcceptances: readonly RuntimeOwnerSignedRecordAcceptanceRecord[];
  readonly conversations: readonly LocalNativeConversationRecord[];
  readonly transitions: readonly LocalNativeConversationTransitionRecord[];
  readonly bindingIncarnations: readonly NativeBindingIncarnationRecord[];
  readonly attachments: readonly NativeTransportAttachmentRecord[];
  readonly attachmentLeases: readonly NativeTransportLeaseRecord[];
  readonly gates: readonly NativeBindingRuntimeGateRecord[];
}

export interface RuntimeOwnerRepositoryOperations {
  acquireServiceLease(
    request: AcquireRuntimeOwnerServiceLeaseRequest,
  ): AcquireRuntimeOwnerServiceLeaseResult;
  reconcileServiceLeaseAcquisition(
    request: AcquireRuntimeOwnerServiceLeaseRequest,
  ): AcquireRuntimeOwnerServiceLeaseResult | null;
  renewServiceLease(
    request: RenewRuntimeOwnerServiceLeaseRequest,
  ): RenewRuntimeOwnerServiceLeaseResult;
  releaseServiceLease(
    request: ReleaseRuntimeOwnerServiceLeaseRequest,
  ): ReleaseRuntimeOwnerServiceLeaseResult;
  reconcileServiceLeaseRelease(
    request: ReleaseRuntimeOwnerServiceLeaseRequest,
  ): ReleaseRuntimeOwnerServiceLeaseResult | null;
  registerInitialRuntime(request: RegisterInitialRuntimeRequest): RuntimeRegistrationResult;
  reassignRuntimeOwner(request: ReassignRuntimeOwnerRequest): ReassignRuntimeOwnerResult;
  replaceRuntimeIncarnation(
    request: ReplaceRuntimeIncarnationRequest,
  ): ReplaceRuntimeIncarnationResult;
  terminateRuntime(request: TerminateRuntimeRequest): TerminateRuntimeResult;
  appendLocalConversationTransition(
    request: AppendLocalNativeConversationTransitionRequest,
  ): AppendLocalNativeConversationTransitionResult;
  prepareBindingRuntime(
    request: PrepareNativeBindingRuntimeRequest,
  ): PrepareNativeBindingRuntimeResult;
  detachBindingRuntime(
    request: DetachNativeBindingRuntimeRequest,
  ): DetachNativeBindingRuntimeResult;
  rotateIdentityKey(request: RotateRuntimeOwnerKeyRequest): RotateRuntimeOwnerKeyResult;
  reserveSignature(
    request: ReserveRuntimeOwnerSignatureRequest,
  ): RuntimeOwnerSignatureMutationResult;
  bindSignature(request: BindRuntimeOwnerSignatureRequest): RuntimeOwnerSignatureMutationResult;
  storeSignedRecord(
    request: StoreRuntimeOwnerSignatureRequest,
  ): RuntimeOwnerSignatureMutationResult;
  acceptSignedRecord(
    request: AcceptRuntimeOwnerSignedRecordRequest,
  ): RuntimeOwnerSignedRecordAcceptanceResult;
  abortSignature(request: AbortRuntimeOwnerSignatureRequest): RuntimeOwnerSignatureMutationResult;
  readOperation(operationId: A1SafeId): RuntimeOwnerJournalEntry | null;
  readRuntime(runtimeId: NativeRuntimeId): RuntimeRegistrationResult | null;
  readInventory(): RuntimeOwnerInventory;
}

export class RuntimeOwnerRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`runtime owner repository conflict: ${message}`);
    this.name = "RuntimeOwnerRepositoryConflictError";
  }
}

export class RuntimeOwnerStaleOwnerError extends Error {
  constructor(message = "runtime-owner service fence is not current and unexpired") {
    super(`runtime owner repository stale owner: ${message}`);
    this.name = "RuntimeOwnerStaleOwnerError";
  }
}

export class RuntimeOwnerRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`runtime owner repository persistence failed: ${message}`, options);
    this.name = "RuntimeOwnerRepositoryPersistenceError";
  }
}

const OPERATION_KEYS = ["operationId", "operationSchemaId", "operationDigest"] as const;
const OWNER_FENCE_KEYS = [
  "runtimeOwnerServiceLeaseId",
  "runtimeOwnerServiceEpoch",
  "ownerInstanceId",
  "ownerProcessStartIdentitySchemaId",
  "ownerProcessStartIdentityRef",
  "ownerProcessStartIdentityDigest",
] as const;

function parseOperation(value: unknown, field = "operation"): RuntimeOwnerOperationEvidence {
  const row = parseExactRecord(value, OPERATION_KEYS, field);
  return frozen({
    operationId: parseA1SafeId(row.operationId, `${field}.operationId`),
    operationSchemaId: parseNonEmptyString(row.operationSchemaId, `${field}.operationSchemaId`),
    operationDigest: parseA1Digest(row.operationDigest, `${field}.operationDigest`),
  });
}

function parseOwnerFence(value: unknown, field = "fence"): RuntimeOwnerServiceFence {
  const row = parseExactRecord(value, OWNER_FENCE_KEYS, field);
  return frozen({
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      `${field}.runtimeOwnerServiceLeaseId`,
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      `${field}.runtimeOwnerServiceEpoch`,
    ),
    ownerInstanceId: parseA1SafeId(row.ownerInstanceId, `${field}.ownerInstanceId`),
    ownerProcessStartIdentitySchemaId: parseNonEmptyString(
      row.ownerProcessStartIdentitySchemaId,
      `${field}.ownerProcessStartIdentitySchemaId`,
    ),
    ownerProcessStartIdentityRef: parseA1SafeId(
      row.ownerProcessStartIdentityRef,
      `${field}.ownerProcessStartIdentityRef`,
    ),
    ownerProcessStartIdentityDigest: parseA1Digest(
      row.ownerProcessStartIdentityDigest,
      `${field}.ownerProcessStartIdentityDigest`,
    ),
  });
}

function parseSigningKeyRef(value: unknown, field: string): ProtectedHandleRef<"signing_key"> {
  const parsed = parseProtectedHandleRef(value);
  if (parsed.kind !== "signing_key") reject(field, "must reference a protected signing_key handle");
  return parsed;
}

function requireSnapshot(
  value: unknown,
  byteLength: number | null,
  field: string,
): ProtectedByteSnapshot {
  if (!(value instanceof ProtectedByteSnapshot)) reject(field, "must be a protected byte snapshot");
  if (byteLength !== null && value.byteLength !== byteLength) {
    reject(field, `must contain exactly ${byteLength} bytes`);
  }
  if (byteLength === null && (value.byteLength < 1 || value.byteLength > 1024)) {
    reject(field, "must contain between 1 and 1024 bytes");
  }
  return value;
}

const KEY_INPUT_KEYS = [
  "runtimeOwnerIdentityKeyId",
  "publicKey",
  "signingKeyRef",
  "localTrustEvidenceRef",
  "localTrustEvidenceDigest",
  "wrapNonce",
  "wrappedPkcs8",
  "authTag",
  "pkcs8Digest",
] as const;

function parseKeyInput(value: unknown, field = "key"): RuntimeOwnerKeyMaterialInput {
  const row = parseExactRecord(value, KEY_INPUT_KEYS, field);
  return frozen({
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      `${field}.runtimeOwnerIdentityKeyId`,
    ),
    publicKey: parseEd25519PublicKey(row.publicKey, `${field}.publicKey`),
    signingKeyRef: parseSigningKeyRef(row.signingKeyRef, `${field}.signingKeyRef`),
    localTrustEvidenceRef: parseA1SafeId(
      row.localTrustEvidenceRef,
      `${field}.localTrustEvidenceRef`,
    ),
    localTrustEvidenceDigest: parseA1Digest(
      row.localTrustEvidenceDigest,
      `${field}.localTrustEvidenceDigest`,
    ),
    wrapNonce: requireSnapshot(row.wrapNonce, 12, `${field}.wrapNonce`),
    wrappedPkcs8: requireSnapshot(row.wrappedPkcs8, null, `${field}.wrappedPkcs8`),
    authTag: requireSnapshot(row.authTag, 16, `${field}.authTag`),
    pkcs8Digest: parseA1Digest(row.pkcs8Digest, `${field}.pkcs8Digest`),
  });
}

function trustedNow(nowMs: () => number): number {
  return parseNonNegativeSafeInteger(nowMs(), "runtimeOwnerRepository.nowMs");
}

function checkedIncrement(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RuntimeOwnerRepositoryConflictError(`${field} is exhausted`);
  }
  return value + 1;
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
      error instanceof RuntimeOwnerRepositoryConflictError ||
      error instanceof RuntimeOwnerStaleOwnerError ||
      error instanceof RuntimeOwnerRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new RuntimeOwnerRepositoryPersistenceError("read operation did not complete", {
      cause: error,
    });
  }
}

function assertNoRetainedRegistrationForBindingGraph(
  transaction: HostStateRepositorySqlTransaction,
  nativeBindingIncarnationId: A1SafeId,
  attachmentLeaseId: A1SafeId,
): void {
  const retained = sqlGet(
    transaction,
    `SELECT native_conversation_lease_id
       FROM native_conversation_leases
      WHERE native_binding_incarnation_id = ? OR attachment_lease_id = ?
      LIMIT 1`,
    [nativeBindingIncarnationId, attachmentLeaseId],
  );
  if (retained !== undefined) {
    throw new RuntimeOwnerRepositoryConflictError(
      "binding graph is retained by native registration lineage",
    );
  }
}

function assertNoRetainedRegistrationForRuntimeIncarnation(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  nativeIncarnation: number,
): void {
  const retained = sqlGet(
    transaction,
    `SELECT native_conversation_lease_id
       FROM native_conversation_leases
      WHERE runtime_id = ? AND native_incarnation = ?
      LIMIT 1`,
    [runtimeId, nativeIncarnation],
  );
  if (retained !== undefined) {
    throw new RuntimeOwnerRepositoryConflictError(
      "runtime incarnation is retained by native registration lineage",
    );
  }
}

function assertNoRetainedRegistrationForSemanticConversation(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  nativeIncarnation: number,
  semanticConversationId: A1SafeId | null,
): void {
  if (semanticConversationId === null) return;
  const retained = sqlGet(
    transaction,
    `SELECT lease.native_conversation_lease_id
       FROM native_conversation_leases AS lease
       JOIN native_binding_incarnations AS binding
         ON binding.native_binding_incarnation_id = lease.native_binding_incarnation_id
      WHERE binding.runtime_id = ? AND binding.native_incarnation = ?
        AND binding.semantic_conversation_id = ?
      LIMIT 1`,
    [runtimeId, nativeIncarnation, semanticConversationId],
  );
  if (retained !== undefined) {
    throw new RuntimeOwnerRepositoryConflictError(
      "semantic conversation is retained by native registration lineage",
    );
  }
}

function sqlAll(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): readonly unknown[] {
  try {
    if (transaction.all === undefined) {
      throw new RuntimeOwnerRepositoryPersistenceError(
        "runtime-owner inventory requires a multi-row SQL transaction",
      );
    }
    const result = transaction.all(sql, parameters);
    if (!Array.isArray(result)) {
      throw new RuntimeOwnerRepositoryPersistenceError(
        "multi-row read returned a non-array result",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RuntimeOwnerRepositoryPersistenceError) throw error;
    throw new RuntimeOwnerRepositoryPersistenceError("multi-row read did not complete", {
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
      throw new RuntimeOwnerRepositoryPersistenceError("write returned an invalid change count");
    }
    return numeric;
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof RuntimeOwnerRepositoryConflictError ||
      error instanceof RuntimeOwnerStaleOwnerError ||
      error instanceof RuntimeOwnerRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new RuntimeOwnerRepositoryPersistenceError("write operation did not complete", {
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
    throw new RuntimeOwnerRepositoryPersistenceError(`${operation} did not change exactly one row`);
  }
}

function rawRow(value: unknown, keys: readonly string[], field: string): UnknownRecord {
  try {
    return parseExactRecord(value, keys, field);
  } catch (error) {
    throw new RuntimeOwnerRepositoryPersistenceError(`${field} row is invalid`, { cause: error });
  }
}

function selectColumns(columns: readonly string[]): string {
  return columns.join(", ");
}

function sameDigest(left: A1Digest, right: A1Digest): boolean {
  const leftBytes = Buffer.from(base64urlDecode(left));
  const rightBytes = Buffer.from(base64urlDecode(right));
  return leftBytes.equals(rightBytes);
}

function sameDescriptor(left: NativeEngineDescriptor, right: NativeEngineDescriptor): boolean {
  return left.product === right.product && left.access === right.access;
}

function sameBytes(left: ProtectedByteSnapshot, right: ProtectedByteSnapshot): boolean {
  return Buffer.from(left.copyBytes()).equals(Buffer.from(right.copyBytes()));
}

function syncNativeRuntimeId(
  wardenLaunchNonce: WardenLaunchNonce,
  startIdentitySchemaId: string,
  startIdentityDigest: A1Digest,
): NativeRuntimeId {
  const writer = new CanonicalWriter();
  writer.str("remote-claw/native-runtime-id/v1");
  writer.bytes(base64urlDecode(wardenLaunchNonce));
  writer.str(startIdentitySchemaId);
  writer.bytes(base64urlDecode(startIdentityDigest));
  const digest = createHash("sha256").update(writer.finish()).digest();
  return parseA1CanonicalId("nativeRuntime", `rcrt_${base64urlEncode(digest)}`);
}

function persisted<T>(field: string, parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof RuntimeOwnerRepositoryPersistenceError) throw error;
    throw new RuntimeOwnerRepositoryPersistenceError(`${field} row is invalid`, { cause: error });
  }
}

const OWNER_STATE_ROW_KEYS = [
  "singleton",
  "machine_identity_id",
  "current_runtime_owner_service_epoch",
  "current_runtime_owner_service_lease_id",
  "next_journal_offset",
  "created_at_ms",
] as const;

function ownerStateFromRow(value: unknown): RuntimeOwnerStateRecord {
  const row = rawRow(value, OWNER_STATE_ROW_KEYS, "runtimeOwnerState");
  return persisted("runtimeOwnerState", () => {
    parseLiteral(row.singleton, 1, "runtimeOwnerState.singleton");
    return frozen({
      machineIdentityId: parseMachineIdentityId(
        row.machine_identity_id,
        "runtimeOwnerState.machineIdentityId",
      ),
      currentRuntimeOwnerServiceEpoch: parseNonNegativeSafeInteger(
        row.current_runtime_owner_service_epoch,
        "runtimeOwnerState.currentRuntimeOwnerServiceEpoch",
      ),
      currentRuntimeOwnerServiceLeaseId: parseNullable(
        row.current_runtime_owner_service_lease_id,
        parseA1SafeId,
        "runtimeOwnerState.currentRuntimeOwnerServiceLeaseId",
      ),
      nextJournalOffset: parseNonNegativeSafeInteger(
        row.next_journal_offset,
        "runtimeOwnerState.nextJournalOffset",
      ),
      createdAtMs: parseNonNegativeSafeInteger(row.created_at_ms, "runtimeOwnerState.createdAtMs"),
    });
  });
}

const SERVICE_LEASE_ROW_KEYS = [
  "runtime_owner_service_lease_id",
  "machine_identity_id",
  "runtime_owner_service_epoch",
  "owner_instance_id",
  "owner_process_start_identity_schema_id",
  "owner_process_start_identity_ref",
  "owner_process_start_identity_digest",
  "acquired_at_ms",
  "initial_heartbeat_deadline_ms",
  "heartbeat_deadline_ms",
  "released_at_ms",
  "state",
] as const;

interface StoredServiceLease {
  readonly lease: RuntimeOwnerServiceLeaseRecord;
  readonly initialHeartbeatDeadlineMs: number;
}

function storedServiceLeaseFromRow(value: unknown): StoredServiceLease {
  const row = rawRow(value, SERVICE_LEASE_ROW_KEYS, "runtimeOwnerServiceLease");
  return persisted("runtimeOwnerServiceLease", () => {
    const lease = parseRuntimeOwnerServiceLeaseRecord({
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      machineIdentityId: row.machine_identity_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      ownerInstanceId: row.owner_instance_id,
      ownerProcessStartIdentitySchemaId: row.owner_process_start_identity_schema_id,
      ownerProcessStartIdentityRef: row.owner_process_start_identity_ref,
      ownerProcessStartIdentityDigest: row.owner_process_start_identity_digest,
      acquiredAtMs: row.acquired_at_ms,
      heartbeatDeadlineMs: row.heartbeat_deadline_ms,
      releasedAtMs: row.released_at_ms,
      state: row.state,
    });
    const initialHeartbeatDeadlineMs = parseNonNegativeSafeInteger(
      row.initial_heartbeat_deadline_ms,
      "runtimeOwnerServiceLease.initialHeartbeatDeadlineMs",
    );
    if (
      initialHeartbeatDeadlineMs <= lease.acquiredAtMs ||
      initialHeartbeatDeadlineMs > lease.heartbeatDeadlineMs
    ) {
      throw new RuntimeOwnerRepositoryPersistenceError(
        "runtime-owner initial heartbeat deadline is invalid",
      );
    }
    return frozen({ lease, initialHeartbeatDeadlineMs });
  });
}

const OWNER_JOURNAL_ROW_KEYS = [
  "journal_offset",
  "entry_kind",
  "subject_kind",
  "subject_id",
  "operation_id",
  "operation_schema_id",
  "operation_digest",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "committed_at_ms",
] as const;

function journalFromRow(value: unknown): RuntimeOwnerJournalEntry {
  const row = rawRow(value, OWNER_JOURNAL_ROW_KEYS, "runtimeOwnerJournalEntry");
  return persisted("runtimeOwnerJournalEntry", () =>
    frozen({
      journalOffset: parseNonNegativeSafeInteger(
        row.journal_offset,
        "runtimeOwnerJournalEntry.journalOffset",
      ),
      entryKind: parseEnum(
        row.entry_kind,
        RUNTIME_OWNER_JOURNAL_ENTRY_KINDS,
        "runtimeOwnerJournalEntry.entryKind",
      ),
      subjectKind: parseEnum(
        row.subject_kind,
        RUNTIME_OWNER_JOURNAL_SUBJECT_KINDS,
        "runtimeOwnerJournalEntry.subjectKind",
      ),
      subjectId: parseA1SafeId(row.subject_id, "runtimeOwnerJournalEntry.subjectId"),
      operationId: parseA1SafeId(row.operation_id, "runtimeOwnerJournalEntry.operationId"),
      operationSchemaId: parseNonEmptyString(
        row.operation_schema_id,
        "runtimeOwnerJournalEntry.operationSchemaId",
      ),
      operationDigest: parseA1Digest(
        row.operation_digest,
        "runtimeOwnerJournalEntry.operationDigest",
      ),
      runtimeOwnerServiceLeaseId: parseA1SafeId(
        row.runtime_owner_service_lease_id,
        "runtimeOwnerJournalEntry.runtimeOwnerServiceLeaseId",
      ),
      runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
        row.runtime_owner_service_epoch,
        "runtimeOwnerJournalEntry.runtimeOwnerServiceEpoch",
      ),
      committedAtMs: parseNonNegativeSafeInteger(
        row.committed_at_ms,
        "runtimeOwnerJournalEntry.committedAtMs",
      ),
    }),
  );
}

const RUNTIME_ROW_KEYS = [
  "runtime_id",
  "descriptor_product",
  "descriptor_access",
  "warden_launch_nonce",
  "initial_start_identity_schema_id",
  "initial_start_identity_ref",
  "initial_start_identity_digest",
  "current_native_incarnation",
  "current_runtime_owner_assignment_id",
  "next_local_transition_seq",
  "created_at_ms",
  "closed_at_ms",
  "state",
] as const;

interface StoredRuntime {
  readonly runtime: NativeRuntimeRecord;
  readonly nextLocalTransitionSeq: number;
}

function storedRuntimeFromRow(value: unknown): StoredRuntime {
  const row = rawRow(value, RUNTIME_ROW_KEYS, "nativeRuntime");
  return persisted("nativeRuntime", () =>
    frozen({
      runtime: parseNativeRuntimeRecord({
        runtimeId: row.runtime_id,
        descriptor: { product: row.descriptor_product, access: row.descriptor_access },
        wardenLaunchNonce: row.warden_launch_nonce,
        initialStartIdentitySchemaId: row.initial_start_identity_schema_id,
        initialStartIdentityRef: row.initial_start_identity_ref,
        initialStartIdentityDigest: row.initial_start_identity_digest,
        currentNativeIncarnation: row.current_native_incarnation,
        currentRuntimeOwnerAssignmentId: row.current_runtime_owner_assignment_id,
        createdAtMs: row.created_at_ms,
        closedAtMs: row.closed_at_ms,
        state: row.state,
      }),
      nextLocalTransitionSeq: parsePositiveSafeInteger(
        row.next_local_transition_seq,
        "nativeRuntime.nextLocalTransitionSeq",
      ),
    }),
  );
}

const INCARNATION_ROW_KEYS = [
  "runtime_id",
  "native_incarnation",
  "descriptor_product",
  "descriptor_access",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "start_identity_schema_id",
  "start_identity_ref",
  "start_identity_digest",
  "started_at_ms",
  "closed_at_ms",
  "state",
] as const;

function incarnationFromRow(value: unknown): NativeRuntimeIncarnationRecord {
  const row = rawRow(value, INCARNATION_ROW_KEYS, "nativeRuntimeIncarnation");
  return persisted("nativeRuntimeIncarnation", () =>
    parseNativeRuntimeIncarnationRecord({
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      descriptor: { product: row.descriptor_product, access: row.descriptor_access },
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      startIdentitySchemaId: row.start_identity_schema_id,
      startIdentityRef: row.start_identity_ref,
      startIdentityDigest: row.start_identity_digest,
      startedAtMs: row.started_at_ms,
      closedAtMs: row.closed_at_ms,
      state: row.state,
    }),
  );
}

const ASSIGNMENT_ROW_KEYS = [
  "runtime_owner_assignment_id",
  "runtime_id",
  "native_incarnation",
  "assignment_generation",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "assigned_at_ms",
  "assignment_evidence_schema_id",
  "assignment_evidence_ref",
  "assignment_evidence_digest",
  "supersedes_runtime_owner_assignment_id",
  "reason",
] as const;

function assignmentFromRow(value: unknown): RuntimeOwnerAssignmentRecord {
  const row = rawRow(value, ASSIGNMENT_ROW_KEYS, "runtimeOwnerAssignment");
  return persisted("runtimeOwnerAssignment", () =>
    parseRuntimeOwnerAssignmentRecord({
      runtimeOwnerAssignmentId: row.runtime_owner_assignment_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      assignmentGeneration: row.assignment_generation,
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      assignedAtMs: row.assigned_at_ms,
      assignmentEvidenceSchemaId: row.assignment_evidence_schema_id,
      assignmentEvidenceRef: row.assignment_evidence_ref,
      assignmentEvidenceDigest: row.assignment_evidence_digest,
      supersedesRuntimeOwnerAssignmentId: row.supersedes_runtime_owner_assignment_id,
      reason: row.reason,
    }),
  );
}

const CONTAINMENT_ROW_KEYS = [
  "native_runtime_containment_id",
  "runtime_id",
  "predecessor_native_incarnation",
  "successor_native_incarnation",
  "kind",
  "evidence_schema_id",
  "evidence_ref",
  "evidence_digest",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "contained_at_ms",
] as const;

function containmentFromRow(value: unknown): NativeRuntimeContainmentRecord {
  const row = rawRow(value, CONTAINMENT_ROW_KEYS, "nativeRuntimeContainment");
  return persisted("nativeRuntimeContainment", () =>
    parseNativeRuntimeContainmentRecord({
      nativeRuntimeContainmentId: row.native_runtime_containment_id,
      runtimeId: row.runtime_id,
      predecessorNativeIncarnation: row.predecessor_native_incarnation,
      successorNativeIncarnation: row.successor_native_incarnation,
      kind: row.kind,
      evidenceSchemaId: row.evidence_schema_id,
      evidenceRef: row.evidence_ref,
      evidenceDigest: row.evidence_digest,
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      containedAtMs: row.contained_at_ms,
    }),
  );
}

const IDENTITY_KEY_ROW_KEYS = [
  "runtime_owner_identity_key_id",
  "runtime_id",
  "key_generation",
  "algorithm",
  "public_key",
  "signing_key_protected_handle_id",
  "next_signer_sequence",
  "local_trust_evidence_ref",
  "local_trust_evidence_digest",
  "state",
] as const;

function identityKeyFromRow(value: unknown): RuntimeOwnerIdentityKeyRecord {
  const row = rawRow(value, IDENTITY_KEY_ROW_KEYS, "runtimeOwnerIdentityKey");
  return persisted("runtimeOwnerIdentityKey", () =>
    parseRuntimeOwnerIdentityKeyRecord({
      runtimeId: row.runtime_id,
      runtimeOwnerIdentityKeyId: row.runtime_owner_identity_key_id,
      keyGeneration: row.key_generation,
      algorithm: row.algorithm,
      publicKey: row.public_key,
      signingKeyRef:
        row.signing_key_protected_handle_id === null
          ? null
          : { protectedHandleId: row.signing_key_protected_handle_id, kind: "signing_key" },
      nextSignerSequence: row.next_signer_sequence,
      localTrustEvidenceRef: row.local_trust_evidence_ref,
      localTrustEvidenceDigest: row.local_trust_evidence_digest,
      state: row.state,
    }),
  );
}

const PRIVATE_KEY_ROW_KEYS = [
  "protected_handle_id",
  "runtime_id",
  "runtime_owner_identity_key_id",
  "key_generation",
  "wrapping_schema_id",
  "wrap_nonce",
  "wrapped_pkcs8",
  "auth_tag",
  "pkcs8_digest",
  "created_at_ms",
  "destroyed_at_ms",
  "state",
] as const;

function blobSnapshot(
  value: unknown,
  expected: number | null,
  field: string,
): ProtectedByteSnapshot {
  if (!(value instanceof Uint8Array)) {
    throw new RuntimeOwnerRepositoryPersistenceError(`${field} must be a byte array`);
  }
  if (
    (expected !== null && value.byteLength !== expected) ||
    (expected === null && (value.byteLength < 1 || value.byteLength > 1024))
  ) {
    throw new RuntimeOwnerRepositoryPersistenceError(`${field} has an invalid byte length`);
  }
  return ProtectedByteSnapshot.from(value);
}

function privateKeyFromRow(value: unknown): RuntimeOwnerPrivateKeyEnvelopeRecord {
  const row = rawRow(value, PRIVATE_KEY_ROW_KEYS, "runtimeOwnerPrivateKey");
  return persisted("runtimeOwnerPrivateKey", () => {
    const state = parseEnum(
      row.state,
      ["current", "destroyed"] as const,
      "runtimeOwnerPrivateKey.state",
    );
    const createdAtMs = parseNonNegativeSafeInteger(
      row.created_at_ms,
      "runtimeOwnerPrivateKey.createdAtMs",
    );
    const destroyedAtMs = parseNullable(
      row.destroyed_at_ms,
      parseNonNegativeSafeInteger,
      "runtimeOwnerPrivateKey.destroyedAtMs",
    );
    if ((state === "destroyed") !== (destroyedAtMs !== null)) {
      throw new RuntimeOwnerRepositoryPersistenceError(
        "runtime-owner private-key destruction lifecycle is invalid",
      );
    }
    if (destroyedAtMs !== null && destroyedAtMs < createdAtMs) {
      throw new RuntimeOwnerRepositoryPersistenceError(
        "runtime-owner private-key destruction precedes creation",
      );
    }
    const protectedHandleId = parseA1CanonicalId(
      "protectedHandle",
      row.protected_handle_id,
      "runtimeOwnerPrivateKey.protectedHandleId",
    );
    return frozen({
      signingKeyRef: frozen({ protectedHandleId, kind: "signing_key" }),
      runtimeId: parseA1CanonicalId(
        "nativeRuntime",
        row.runtime_id,
        "runtimeOwnerPrivateKey.runtimeId",
      ),
      runtimeOwnerIdentityKeyId: parseA1SafeId(
        row.runtime_owner_identity_key_id,
        "runtimeOwnerPrivateKey.runtimeOwnerIdentityKeyId",
      ),
      keyGeneration: parsePositiveSafeInteger(
        row.key_generation,
        "runtimeOwnerPrivateKey.keyGeneration",
      ),
      wrappingSchemaId: parseLiteral(
        row.wrapping_schema_id,
        RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
        "runtimeOwnerPrivateKey.wrappingSchemaId",
      ),
      wrapNonce: blobSnapshot(row.wrap_nonce, 12, "runtimeOwnerPrivateKey.wrapNonce"),
      wrappedPkcs8: blobSnapshot(row.wrapped_pkcs8, null, "runtimeOwnerPrivateKey.wrappedPkcs8"),
      authTag: blobSnapshot(row.auth_tag, 16, "runtimeOwnerPrivateKey.authTag"),
      pkcs8Digest: parseA1Digest(row.pkcs8_digest, "runtimeOwnerPrivateKey.pkcs8Digest"),
      createdAtMs,
      destroyedAtMs,
      state,
    });
  });
}

const SIGNATURE_ROW_KEYS = [
  "runtime_id",
  "runtime_owner_identity_key_id",
  "runtime_owner_key_generation",
  "signer_sequence",
  "purpose",
  "canonical_payload_schema_id",
  "canonical_payload_ref",
  "canonical_payload_digest",
  "signed_record_digest",
  "signature",
  "signed_artifact_id",
  "state",
] as const;

function signatureReservationFromRow(value: unknown): RuntimeOwnerSignatureReservationRecord {
  const row = rawRow(value, SIGNATURE_ROW_KEYS, "runtimeOwnerSignatureReservation");
  return persisted("runtimeOwnerSignatureReservation", () =>
    parseRuntimeOwnerSignatureReservationRecord({
      runtimeId: row.runtime_id,
      runtimeOwnerIdentityKeyId: row.runtime_owner_identity_key_id,
      runtimeOwnerKeyGeneration: row.runtime_owner_key_generation,
      signerSequence: row.signer_sequence,
      purpose: row.purpose,
      canonicalPayloadSchemaId: row.canonical_payload_schema_id,
      canonicalPayloadRef: row.canonical_payload_ref,
      canonicalPayloadDigest: row.canonical_payload_digest,
      signedRecordDigest: row.signed_record_digest,
      signature: row.signature,
      signedArtifactId: row.signed_artifact_id,
      state: row.state,
    }),
  );
}

const ACCEPTANCE_ROW_KEYS = [
  "runtime_id",
  "runtime_owner_identity_key_id",
  "runtime_owner_key_generation",
  "signer_sequence",
  "signed_record_digest",
  "accepted_at_ms",
] as const;

function acceptanceFromRow(value: unknown): RuntimeOwnerSignedRecordAcceptanceRecord {
  const row = rawRow(value, ACCEPTANCE_ROW_KEYS, "runtimeOwnerSignedRecordAcceptance");
  return persisted("runtimeOwnerSignedRecordAcceptance", () =>
    parseRuntimeOwnerSignedRecordAcceptanceRecord({
      runtimeId: row.runtime_id,
      runtimeOwnerIdentityKeyId: row.runtime_owner_identity_key_id,
      runtimeOwnerKeyGeneration: row.runtime_owner_key_generation,
      signerSequence: row.signer_sequence,
      signedRecordDigest: row.signed_record_digest,
      acceptedAtMs: row.accepted_at_ms,
    }),
  );
}

const CONVERSATION_ROW_KEYS = [
  "local_native_conversation_id",
  "descriptor_product",
  "descriptor_access",
  "project_id",
  "runtime_id",
  "native_incarnation",
  "semantic_conversation_id",
  "parent_local_native_conversation_id",
  "state",
] as const;

function conversationFromRow(value: unknown): LocalNativeConversationRecord {
  const row = rawRow(value, CONVERSATION_ROW_KEYS, "localNativeConversation");
  return persisted("localNativeConversation", () =>
    parseLocalNativeConversationRecord({
      localNativeConversationId: row.local_native_conversation_id,
      descriptor: { product: row.descriptor_product, access: row.descriptor_access },
      projectId: row.project_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      semanticConversationId: row.semantic_conversation_id,
      parentLocalNativeConversationId: row.parent_local_native_conversation_id,
      state: row.state,
    }),
  );
}

const TRANSITION_ROW_KEYS = [
  "local_transition_id",
  "runtime_id",
  "native_incarnation",
  "local_transition_seq",
  "kind",
  "source_local_native_conversation_id",
  "target_local_native_conversation_id",
  "observed_semantic_conversation_id",
  "native_evidence_ref",
  "native_evidence_schema_id",
  "native_evidence_digest",
  "observed_at_ms",
] as const;

function transitionFromRow(value: unknown): LocalNativeConversationTransitionRecord {
  const row = rawRow(value, TRANSITION_ROW_KEYS, "localNativeConversationTransition");
  return persisted("localNativeConversationTransition", () =>
    parseLocalNativeConversationTransitionRecord({
      localTransitionId: row.local_transition_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      localTransitionSeq: row.local_transition_seq,
      kind: row.kind,
      sourceLocalNativeConversationId: row.source_local_native_conversation_id,
      targetLocalNativeConversationId: row.target_local_native_conversation_id,
      observedSemanticConversationId: row.observed_semantic_conversation_id,
      nativeEvidenceSchemaId: row.native_evidence_schema_id,
      nativeEvidenceRef: row.native_evidence_ref,
      nativeEvidenceDigest: row.native_evidence_digest,
      observedAtMs: row.observed_at_ms,
    }),
  );
}

const BINDING_INCARNATION_ROW_KEYS = [
  "native_binding_incarnation_id",
  "collaboration_server_id",
  "logical_chat_id",
  "native_binding_id",
  "runtime_id",
  "native_incarnation",
  "semantic_conversation_id",
  "created_at_ms",
  "closed_at_ms",
  "state",
] as const;

function bindingIncarnationFromRow(value: unknown): NativeBindingIncarnationRecord {
  const row = rawRow(value, BINDING_INCARNATION_ROW_KEYS, "nativeBindingIncarnation");
  return persisted("nativeBindingIncarnation", () =>
    parseNativeBindingIncarnationRecord({
      nativeBindingIncarnationId: row.native_binding_incarnation_id,
      collaborationServerId: row.collaboration_server_id,
      logicalChatId: row.logical_chat_id,
      nativeBindingId: row.native_binding_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      semanticConversationId: row.semantic_conversation_id,
      createdAtMs: row.created_at_ms,
      closedAtMs: row.closed_at_ms,
      state: row.state,
    }),
  );
}

const ATTACHMENT_ROW_KEYS = [
  "attachment_id",
  "native_binding_id",
  "kind",
  "transport_id",
  "generation",
  "current_attachment_lease_id",
  "resource_ownership",
  "created_at_ms",
  "closed_at_ms",
  "state",
] as const;

function attachmentFromRow(value: unknown): NativeTransportAttachmentRecord {
  const row = rawRow(value, ATTACHMENT_ROW_KEYS, "nativeTransportAttachment");
  return persisted("nativeTransportAttachment", () =>
    parseNativeTransportAttachmentRecord({
      attachmentId: row.attachment_id,
      nativeBindingId: row.native_binding_id,
      kind: row.kind,
      transportId: row.transport_id,
      generation: row.generation,
      currentAttachmentLeaseId: row.current_attachment_lease_id,
      resourceOwnership: row.resource_ownership,
      createdAtMs: row.created_at_ms,
      closedAtMs: row.closed_at_ms,
      state: row.state,
    }),
  );
}

const ATTACHMENT_LEASE_ROW_KEYS = [
  "attachment_lease_id",
  "attachment_id",
  "native_binding_incarnation_id",
  "runtime_id",
  "native_incarnation",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "coordinator_lease_id",
  "coordinator_epoch",
  "transport_epoch",
  "current_capability_snapshot_id",
  "current_native_client_ingress_lease_id",
  "acquired_at_ms",
  "released_at_ms",
  "state",
] as const;

function attachmentLeaseFromRow(value: unknown): NativeTransportLeaseRecord {
  const row = rawRow(value, ATTACHMENT_LEASE_ROW_KEYS, "nativeTransportLease");
  return persisted("nativeTransportLease", () =>
    parseNativeTransportLeaseRecord({
      attachmentLeaseId: row.attachment_lease_id,
      attachmentId: row.attachment_id,
      nativeBindingIncarnationId: row.native_binding_incarnation_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      coordinatorLeaseId: row.coordinator_lease_id,
      coordinatorEpoch: row.coordinator_epoch,
      transportEpoch: row.transport_epoch,
      currentCapabilitySnapshotId: row.current_capability_snapshot_id,
      currentNativeClientIngressLeaseId: row.current_native_client_ingress_lease_id,
      acquiredAtMs: row.acquired_at_ms,
      releasedAtMs: row.released_at_ms,
      state: row.state,
    }),
  );
}

const GATE_ROW_KEYS = [
  "collaboration_server_id",
  "logical_chat_id",
  "native_binding_id",
  "runtime_id",
  "native_incarnation",
  "native_binding_incarnation_id",
  "attachment_id",
  "current_attachment_lease_id",
  "phase",
  "disconnect_policy",
  "gate_generation",
  "updated_at_ms",
] as const;

function gateFromRow(value: unknown): NativeBindingRuntimeGateRecord {
  const row = rawRow(value, GATE_ROW_KEYS, "nativeBindingRuntimeGate");
  return persisted("nativeBindingRuntimeGate", () =>
    parseNativeBindingRuntimeGateRecord({
      collaborationServerId: row.collaboration_server_id,
      logicalChatId: row.logical_chat_id,
      nativeBindingId: row.native_binding_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      nativeBindingIncarnationId: row.native_binding_incarnation_id,
      attachmentId: row.attachment_id,
      currentAttachmentLeaseId: row.current_attachment_lease_id,
      phase: row.phase,
      disconnectPolicy: row.disconnect_policy,
      gateGeneration: row.gate_generation,
      updatedAtMs: row.updated_at_ms,
    }),
  );
}

const SELECT_OWNER_STATE = `SELECT ${selectColumns(OWNER_STATE_ROW_KEYS)}
FROM runtime_owner_state WHERE singleton = 1 LIMIT 1`;
const SELECT_SERVICE_LEASE = `SELECT ${selectColumns(SERVICE_LEASE_ROW_KEYS)}
FROM runtime_owner_service_leases WHERE runtime_owner_service_lease_id = ? LIMIT 1`;
const SELECT_JOURNAL_OPERATION = `SELECT ${selectColumns(OWNER_JOURNAL_ROW_KEYS)}
FROM runtime_owner_journal_entries WHERE operation_id = ? LIMIT 1`;
const SELECT_RUNTIME = `SELECT ${selectColumns(RUNTIME_ROW_KEYS)}
FROM native_runtimes WHERE runtime_id = ? LIMIT 1`;
const SELECT_INCARNATION = `SELECT ${selectColumns(INCARNATION_ROW_KEYS)}
FROM native_runtime_incarnations WHERE runtime_id = ? AND native_incarnation = ? LIMIT 1`;
const SELECT_ASSIGNMENT = `SELECT ${selectColumns(ASSIGNMENT_ROW_KEYS)}
FROM runtime_owner_assignments WHERE runtime_owner_assignment_id = ? LIMIT 1`;
const SELECT_CONTAINMENT = `SELECT ${selectColumns(CONTAINMENT_ROW_KEYS)}
FROM native_runtime_containments WHERE native_runtime_containment_id = ? LIMIT 1`;
const SELECT_IDENTITY_KEY = `SELECT ${selectColumns(IDENTITY_KEY_ROW_KEYS)}
FROM runtime_owner_identity_keys WHERE runtime_owner_identity_key_id = ? LIMIT 1`;
const SELECT_PRIVATE_KEY = `SELECT ${selectColumns(PRIVATE_KEY_ROW_KEYS)}
FROM runtime_owner_private_keys WHERE protected_handle_id = ? LIMIT 1`;
const SELECT_SIGNATURE = `SELECT ${selectColumns(SIGNATURE_ROW_KEYS)}
FROM runtime_owner_signature_reservations
WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
  AND runtime_owner_key_generation = ? AND signer_sequence = ? LIMIT 1`;
const SELECT_ACCEPTANCE = `SELECT ${selectColumns(ACCEPTANCE_ROW_KEYS)}
FROM runtime_owner_signed_record_acceptances
WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
  AND runtime_owner_key_generation = ? AND signer_sequence = ? LIMIT 1`;
const SELECT_CONVERSATION = `SELECT ${selectColumns(CONVERSATION_ROW_KEYS)}
FROM local_native_conversations WHERE local_native_conversation_id = ? LIMIT 1`;
const SELECT_TRANSITION = `SELECT ${selectColumns(TRANSITION_ROW_KEYS)}
FROM local_native_conversation_transitions WHERE local_transition_id = ? LIMIT 1`;
const SELECT_BINDING_INCARNATION = `SELECT ${selectColumns(BINDING_INCARNATION_ROW_KEYS)}
FROM native_binding_incarnations WHERE native_binding_incarnation_id = ? LIMIT 1`;
const SELECT_ATTACHMENT = `SELECT ${selectColumns(ATTACHMENT_ROW_KEYS)}
FROM native_transport_attachments WHERE attachment_id = ? LIMIT 1`;
const SELECT_ATTACHMENT_LEASE = `SELECT ${selectColumns(ATTACHMENT_LEASE_ROW_KEYS)}
FROM native_transport_leases WHERE attachment_lease_id = ? LIMIT 1`;
const SELECT_GATE = `SELECT ${selectColumns(GATE_ROW_KEYS)}
FROM binding_lifecycle_gates WHERE native_binding_id = ? LIMIT 1`;

function findOwnerState(transaction: HostStateRepositorySqlTransaction): RuntimeOwnerStateRecord {
  const row = sqlGet(transaction, SELECT_OWNER_STATE);
  if (row === undefined) {
    throw new RuntimeOwnerRepositoryPersistenceError("runtime-owner singleton is missing");
  }
  return ownerStateFromRow(row);
}

function findServiceLease(
  transaction: HostStateRepositorySqlTransaction,
  leaseId: A1SafeId,
): StoredServiceLease | null {
  const row = sqlGet(transaction, SELECT_SERVICE_LEASE, [leaseId]);
  return row === undefined ? null : storedServiceLeaseFromRow(row);
}

function findOperation(
  transaction: HostStateRepositorySqlTransaction,
  operationId: A1SafeId,
): RuntimeOwnerJournalEntry | null {
  const row = sqlGet(transaction, SELECT_JOURNAL_OPERATION, [operationId]);
  return row === undefined ? null : journalFromRow(row);
}

function findRuntime(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
): StoredRuntime | null {
  const row = sqlGet(transaction, SELECT_RUNTIME, [runtimeId]);
  return row === undefined ? null : storedRuntimeFromRow(row);
}

function findIncarnation(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  nativeIncarnation: number,
): NativeRuntimeIncarnationRecord | null {
  const row = sqlGet(transaction, SELECT_INCARNATION, [runtimeId, nativeIncarnation]);
  return row === undefined ? null : incarnationFromRow(row);
}

function findAssignment(
  transaction: HostStateRepositorySqlTransaction,
  assignmentId: A1SafeId,
): RuntimeOwnerAssignmentRecord | null {
  const row = sqlGet(transaction, SELECT_ASSIGNMENT, [assignmentId]);
  return row === undefined ? null : assignmentFromRow(row);
}

function runtimeIsAssignedToFence(
  transaction: HostStateRepositorySqlTransaction,
  storedRuntime: StoredRuntime | null,
  fence: RuntimeOwnerServiceFence,
): boolean {
  if (
    storedRuntime === null ||
    storedRuntime.runtime.state !== "current" ||
    storedRuntime.runtime.currentRuntimeOwnerAssignmentId === null
  ) {
    return false;
  }
  const assignment = findAssignment(
    transaction,
    storedRuntime.runtime.currentRuntimeOwnerAssignmentId,
  );
  return (
    assignment !== null &&
    assignment.runtimeId === storedRuntime.runtime.runtimeId &&
    assignment.nativeIncarnation === storedRuntime.runtime.currentNativeIncarnation &&
    assignment.runtimeOwnerServiceLeaseId === fence.runtimeOwnerServiceLeaseId &&
    assignment.runtimeOwnerServiceEpoch === fence.runtimeOwnerServiceEpoch
  );
}

function findContainment(
  transaction: HostStateRepositorySqlTransaction,
  containmentId: A1SafeId,
): NativeRuntimeContainmentRecord | null {
  const row = sqlGet(transaction, SELECT_CONTAINMENT, [containmentId]);
  return row === undefined ? null : containmentFromRow(row);
}

function findIdentityKey(
  transaction: HostStateRepositorySqlTransaction,
  identityKeyId: A1SafeId,
): RuntimeOwnerIdentityKeyRecord | null {
  const row = sqlGet(transaction, SELECT_IDENTITY_KEY, [identityKeyId]);
  return row === undefined ? null : identityKeyFromRow(row);
}

function findPrivateKey(
  transaction: HostStateRepositorySqlTransaction,
  protectedHandleId: ProtectedHandleId,
): RuntimeOwnerPrivateKeyEnvelopeRecord | null {
  const row = sqlGet(transaction, SELECT_PRIVATE_KEY, [protectedHandleId]);
  return row === undefined ? null : privateKeyFromRow(row);
}

function findSignature(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  identityKeyId: A1SafeId,
  keyGeneration: number,
  signerSequence: number,
): RuntimeOwnerSignatureReservationRecord | null {
  const row = sqlGet(transaction, SELECT_SIGNATURE, [
    runtimeId,
    identityKeyId,
    keyGeneration,
    signerSequence,
  ]);
  return row === undefined ? null : signatureReservationFromRow(row);
}

function findAcceptance(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  identityKeyId: A1SafeId,
  keyGeneration: number,
  signerSequence: number,
): RuntimeOwnerSignedRecordAcceptanceRecord | null {
  const row = sqlGet(transaction, SELECT_ACCEPTANCE, [
    runtimeId,
    identityKeyId,
    keyGeneration,
    signerSequence,
  ]);
  return row === undefined ? null : acceptanceFromRow(row);
}

const TERMINAL_ROOT_SIGNATURE_FINALIZATION_CAPABILITY = Symbol(
  "terminal-root-signature-finalization",
);

interface TerminalRootSignatureFinalizationScope {
  readonly capability: typeof TERMINAL_ROOT_SIGNATURE_FINALIZATION_CAPABILITY;
  readonly activationOperationId: A1SafeId;
}

interface AttachedNativeRootActivationOperation {
  readonly operationId: A1SafeId;
  readonly rootPathCertificateId: A1SafeId;
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly state: "prepared" | "committed";
}

function hostStateSchemaVersion(transaction: HostStateRepositorySqlTransaction): number {
  const row = sqlGet(
    transaction,
    "SELECT schema_version FROM host_state_metadata WHERE singleton = 1",
  );
  if (row === undefined) {
    throw new RuntimeOwnerRepositoryPersistenceError("host-state metadata is missing");
  }
  const parsed = rawRow(row, ["schema_version"], "hostStateMetadata");
  return persisted("hostStateMetadata", () =>
    parsePositiveSafeInteger(parsed.schema_version, "hostStateMetadata.schemaVersion"),
  );
}

function findAttachedNativeRootActivationOperation(
  transaction: HostStateRepositorySqlTransaction,
  reservation: RuntimeOwnerSignatureReservationRecord,
): AttachedNativeRootActivationOperation | null {
  if (reservation.purpose !== "native_root" || hostStateSchemaVersion(transaction) < 6) {
    return null;
  }
  const value = sqlGet(
    transaction,
    `SELECT operation_id, root_path_certificate_id,
            runtime_owner_service_lease_id, runtime_owner_service_epoch, state
       FROM native_root_activation_operations
      WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
        AND runtime_owner_key_generation = ? AND signer_sequence = ?
      LIMIT 1`,
    [
      reservation.runtimeId,
      reservation.runtimeOwnerIdentityKeyId,
      reservation.runtimeOwnerKeyGeneration,
      reservation.signerSequence,
    ],
  );
  if (value === undefined) return null;
  const row = rawRow(
    value,
    [
      "operation_id",
      "root_path_certificate_id",
      "runtime_owner_service_lease_id",
      "runtime_owner_service_epoch",
      "state",
    ],
    "nativeRootActivationOperation",
  );
  return persisted("nativeRootActivationOperation", () =>
    frozen({
      operationId: parseA1SafeId(row.operation_id, "nativeRootActivationOperation.operationId"),
      rootPathCertificateId: parseA1SafeId(
        row.root_path_certificate_id,
        "nativeRootActivationOperation.rootPathCertificateId",
      ),
      runtimeOwnerServiceLeaseId: parseA1SafeId(
        row.runtime_owner_service_lease_id,
        "nativeRootActivationOperation.runtimeOwnerServiceLeaseId",
      ),
      runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
        row.runtime_owner_service_epoch,
        "nativeRootActivationOperation.runtimeOwnerServiceEpoch",
      ),
      state: parseEnum(
        row.state,
        ["prepared", "committed"] as const,
        "nativeRootActivationOperation.state",
      ),
    }),
  );
}

function assertSignedRecordMutationBoundary(
  transaction: HostStateRepositorySqlTransaction,
  reservation: RuntimeOwnerSignatureReservationRecord,
  finalizationScope: TerminalRootSignatureFinalizationScope | null,
  fence: RuntimeOwnerServiceFence,
  signedArtifactId?: A1SafeId,
): void {
  const attached = findAttachedNativeRootActivationOperation(transaction, reservation);
  if (finalizationScope === null) {
    if (attached !== null) {
      throw new RuntimeOwnerRepositoryConflictError(
        "terminal-root signature evidence is owned by its closed finalizer",
      );
    }
    return;
  }
  if (
    finalizationScope.capability !== TERMINAL_ROOT_SIGNATURE_FINALIZATION_CAPABILITY ||
    attached === null ||
    attached.operationId !== finalizationScope.activationOperationId ||
    attached.state !== "prepared" ||
    attached.runtimeOwnerServiceLeaseId !== fence.runtimeOwnerServiceLeaseId ||
    attached.runtimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch ||
    (signedArtifactId !== undefined && attached.rootPathCertificateId !== signedArtifactId)
  ) {
    throw new RuntimeOwnerRepositoryConflictError(
      "terminal-root signature finalization scope does not match its prepared operation",
    );
  }
}

function findConversation(
  transaction: HostStateRepositorySqlTransaction,
  conversationId: A1SafeId,
): LocalNativeConversationRecord | null {
  const row = sqlGet(transaction, SELECT_CONVERSATION, [conversationId]);
  return row === undefined ? null : conversationFromRow(row);
}

function findTransition(
  transaction: HostStateRepositorySqlTransaction,
  transitionId: A1SafeId,
): LocalNativeConversationTransitionRecord | null {
  const row = sqlGet(transaction, SELECT_TRANSITION, [transitionId]);
  return row === undefined ? null : transitionFromRow(row);
}

function findBindingIncarnation(
  transaction: HostStateRepositorySqlTransaction,
  bindingIncarnationId: A1SafeId,
): NativeBindingIncarnationRecord | null {
  const row = sqlGet(transaction, SELECT_BINDING_INCARNATION, [bindingIncarnationId]);
  return row === undefined ? null : bindingIncarnationFromRow(row);
}

function findAttachment(
  transaction: HostStateRepositorySqlTransaction,
  attachmentId: A1SafeId,
): NativeTransportAttachmentRecord | null {
  const row = sqlGet(transaction, SELECT_ATTACHMENT, [attachmentId]);
  return row === undefined ? null : attachmentFromRow(row);
}

function findAttachmentLease(
  transaction: HostStateRepositorySqlTransaction,
  attachmentLeaseId: A1SafeId,
): NativeTransportLeaseRecord | null {
  const row = sqlGet(transaction, SELECT_ATTACHMENT_LEASE, [attachmentLeaseId]);
  return row === undefined ? null : attachmentLeaseFromRow(row);
}

function findGate(
  transaction: HostStateRepositorySqlTransaction,
  bindingId: NativeBindingId,
): NativeBindingRuntimeGateRecord | null {
  const row = sqlGet(transaction, SELECT_GATE, [bindingId]);
  return row === undefined ? null : gateFromRow(row);
}

interface CurrentOwnerState {
  readonly owner: RuntimeOwnerStateRecord;
  readonly lease: RuntimeOwnerServiceLeaseRecord;
  readonly nowMs: number;
}

function assertCurrentOwner(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  fence: RuntimeOwnerServiceFence,
  nowMs: () => number,
): CurrentOwnerState {
  const now = trustedNow(nowMs);
  const owner = findOwnerState(transaction);
  if (
    owner.machineIdentityId !== machineIdentityId ||
    owner.currentRuntimeOwnerServiceLeaseId !== fence.runtimeOwnerServiceLeaseId ||
    owner.currentRuntimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch
  ) {
    throw new RuntimeOwnerStaleOwnerError();
  }
  const stored = findServiceLease(transaction, fence.runtimeOwnerServiceLeaseId);
  const lease = stored?.lease ?? null;
  if (
    lease === null ||
    lease.machineIdentityId !== machineIdentityId ||
    lease.runtimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch ||
    lease.ownerInstanceId !== fence.ownerInstanceId ||
    lease.ownerProcessStartIdentitySchemaId !== fence.ownerProcessStartIdentitySchemaId ||
    lease.ownerProcessStartIdentityRef !== fence.ownerProcessStartIdentityRef ||
    !sameDigest(lease.ownerProcessStartIdentityDigest, fence.ownerProcessStartIdentityDigest) ||
    lease.state !== "current" ||
    lease.releasedAtMs !== null ||
    now < lease.acquiredAtMs ||
    now >= lease.heartbeatDeadlineMs
  ) {
    throw new RuntimeOwnerStaleOwnerError();
  }
  return frozen({ owner, lease, nowMs: now });
}

function assertCurrentCoordinator(
  transaction: HostStateRepositorySqlTransaction,
  fence: CoordinatorLeaseFence,
  nowMs: number,
): void {
  const keys = [
    "server_state",
    "current_coordinator_lease_id",
    "current_coordinator_epoch",
    "lease_epoch",
    "acquired_at_ms",
    "heartbeat_deadline_ms",
    "released_at_ms",
    "lease_state",
  ] as const;
  const value = sqlGet(
    transaction,
    `SELECT s.state AS server_state,
            s.current_coordinator_lease_id,
            s.current_coordinator_epoch,
            l.coordinator_epoch AS lease_epoch,
            l.acquired_at_ms,
            l.heartbeat_deadline_ms,
            l.released_at_ms,
            l.state AS lease_state
     FROM collaboration_servers AS s
     LEFT JOIN coordinator_leases AS l
       ON l.collaboration_server_id = s.collaboration_server_id
      AND l.coordinator_lease_id = ?
     WHERE s.collaboration_server_id = ? LIMIT 1`,
    [fence.coordinatorLeaseId, fence.collaborationServerId],
  );
  if (value === undefined) {
    throw new RuntimeOwnerRepositoryConflictError("collaboration server is unknown");
  }
  const row = rawRow(value, keys, "runtimeOwnerCoordinatorFence");
  if (
    row.server_state === "closed" ||
    row.current_coordinator_lease_id !== fence.coordinatorLeaseId ||
    row.current_coordinator_epoch !== fence.coordinatorEpoch ||
    row.lease_epoch !== fence.coordinatorEpoch ||
    row.lease_state !== "current" ||
    row.released_at_ms !== null ||
    !Number.isSafeInteger(row.acquired_at_ms) ||
    !Number.isSafeInteger(row.heartbeat_deadline_ms) ||
    nowMs < (row.acquired_at_ms as number) ||
    nowMs >= (row.heartbeat_deadline_ms as number)
  ) {
    throw new RuntimeOwnerRepositoryConflictError("coordinator lease fence is stale or expired");
  }
}

function assertExactOperation(
  entry: RuntimeOwnerJournalEntry,
  operation: RuntimeOwnerOperationEvidence,
  entryKind: RuntimeOwnerJournalEntryKind,
  subjectKind: RuntimeOwnerJournalSubjectKind,
  subjectId: A1SafeId,
): void {
  if (
    entry.entryKind !== entryKind ||
    entry.subjectKind !== subjectKind ||
    entry.subjectId !== subjectId ||
    entry.operationSchemaId !== operation.operationSchemaId ||
    !sameDigest(entry.operationDigest, operation.operationDigest)
  ) {
    throw new RuntimeOwnerRepositoryConflictError("operation ID collided with another effect");
  }
}

function appendJournal(
  transaction: HostStateRepositorySqlTransaction,
  owner: RuntimeOwnerStateRecord,
  fence: RuntimeOwnerServiceFence,
  nowMs: number,
  operation: RuntimeOwnerOperationEvidence,
  entryKind: RuntimeOwnerJournalEntryKind,
  subjectKind: RuntimeOwnerJournalSubjectKind,
  subjectId: A1SafeId,
): RuntimeOwnerJournalEntry {
  if (owner.nextJournalOffset >= Number.MAX_SAFE_INTEGER) {
    throw new RuntimeOwnerRepositoryConflictError("runtime-owner journal offset is exhausted");
  }
  const entry = frozen({
    journalOffset: owner.nextJournalOffset,
    entryKind,
    subjectKind,
    subjectId,
    operationId: operation.operationId,
    operationSchemaId: operation.operationSchemaId,
    operationDigest: operation.operationDigest,
    runtimeOwnerServiceLeaseId: fence.runtimeOwnerServiceLeaseId,
    runtimeOwnerServiceEpoch: fence.runtimeOwnerServiceEpoch,
    committedAtMs: nowMs,
  });
  runExactlyOne(
    transaction,
    `INSERT INTO runtime_owner_journal_entries (
       journal_offset, entry_kind, subject_kind, subject_id,
       operation_id, operation_schema_id, operation_digest,
       runtime_owner_service_lease_id, runtime_owner_service_epoch, committed_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.journalOffset,
      entry.entryKind,
      entry.subjectKind,
      entry.subjectId,
      entry.operationId,
      entry.operationSchemaId,
      entry.operationDigest,
      entry.runtimeOwnerServiceLeaseId,
      entry.runtimeOwnerServiceEpoch,
      entry.committedAtMs,
    ],
    "runtime-owner journal append",
  );
  return entry;
}

function readInventoryTransaction(
  transaction: HostStateRepositorySqlTransaction,
): RuntimeOwnerInventory {
  const state = findOwnerState(transaction);
  const serviceLeases = sqlAll(
    transaction,
    `SELECT ${selectColumns(SERVICE_LEASE_ROW_KEYS)} FROM runtime_owner_service_leases
     ORDER BY runtime_owner_service_epoch`,
  ).map((row) => storedServiceLeaseFromRow(row).lease);
  const journal = sqlAll(
    transaction,
    `SELECT ${selectColumns(OWNER_JOURNAL_ROW_KEYS)} FROM runtime_owner_journal_entries
     ORDER BY journal_offset`,
  ).map(journalFromRow);
  const storedRuntimes = sqlAll(
    transaction,
    `SELECT ${selectColumns(RUNTIME_ROW_KEYS)} FROM native_runtimes ORDER BY runtime_id`,
  ).map(storedRuntimeFromRow);
  const incarnations = sqlAll(
    transaction,
    `SELECT ${selectColumns(INCARNATION_ROW_KEYS)} FROM native_runtime_incarnations
     ORDER BY runtime_id, native_incarnation`,
  ).map(incarnationFromRow);
  const assignments = sqlAll(
    transaction,
    `SELECT ${selectColumns(ASSIGNMENT_ROW_KEYS)} FROM runtime_owner_assignments
     ORDER BY runtime_id, native_incarnation, assignment_generation`,
  ).map(assignmentFromRow);
  const containments = sqlAll(
    transaction,
    `SELECT ${selectColumns(CONTAINMENT_ROW_KEYS)} FROM native_runtime_containments
     ORDER BY runtime_id, predecessor_native_incarnation`,
  ).map(containmentFromRow);
  const identityKeys = sqlAll(
    transaction,
    `SELECT ${selectColumns(IDENTITY_KEY_ROW_KEYS)} FROM runtime_owner_identity_keys
     ORDER BY runtime_id, key_generation`,
  ).map(identityKeyFromRow);
  const privateKeys = sqlAll(
    transaction,
    `SELECT ${selectColumns(PRIVATE_KEY_ROW_KEYS)} FROM runtime_owner_private_keys
     ORDER BY runtime_id, key_generation`,
  ).map(privateKeyFromRow);
  const signatureReservations = sqlAll(
    transaction,
    `SELECT ${selectColumns(SIGNATURE_ROW_KEYS)} FROM runtime_owner_signature_reservations
     ORDER BY runtime_id, runtime_owner_key_generation, signer_sequence`,
  ).map(signatureReservationFromRow);
  const signedRecordAcceptances = sqlAll(
    transaction,
    `SELECT ${selectColumns(ACCEPTANCE_ROW_KEYS)} FROM runtime_owner_signed_record_acceptances
     ORDER BY runtime_id, runtime_owner_key_generation, signer_sequence`,
  ).map(acceptanceFromRow);
  const conversations = sqlAll(
    transaction,
    `SELECT ${selectColumns(CONVERSATION_ROW_KEYS)} FROM local_native_conversations
     ORDER BY runtime_id, native_incarnation, local_native_conversation_id`,
  ).map(conversationFromRow);
  const transitions = sqlAll(
    transaction,
    `SELECT ${selectColumns(TRANSITION_ROW_KEYS)} FROM local_native_conversation_transitions
     ORDER BY runtime_id, native_incarnation, local_transition_seq`,
  ).map(transitionFromRow);
  const bindingIncarnations = sqlAll(
    transaction,
    `SELECT ${selectColumns(BINDING_INCARNATION_ROW_KEYS)} FROM native_binding_incarnations
     ORDER BY collaboration_server_id, native_binding_id, created_at_ms`,
  ).map(bindingIncarnationFromRow);
  const attachments = sqlAll(
    transaction,
    `SELECT ${selectColumns(ATTACHMENT_ROW_KEYS)} FROM native_transport_attachments
     ORDER BY native_binding_id, generation`,
  ).map(attachmentFromRow);
  const attachmentLeases = sqlAll(
    transaction,
    `SELECT ${selectColumns(ATTACHMENT_LEASE_ROW_KEYS)} FROM native_transport_leases
     ORDER BY attachment_id, transport_epoch`,
  ).map(attachmentLeaseFromRow);
  const gates = sqlAll(
    transaction,
    `SELECT ${selectColumns(GATE_ROW_KEYS)} FROM binding_lifecycle_gates
     ORDER BY collaboration_server_id, native_binding_id`,
  ).map(gateFromRow);
  return frozen({
    state,
    serviceLeases: frozen(serviceLeases),
    journal: frozen(journal),
    runtimes: frozen(storedRuntimes.map(({ runtime }) => runtime)),
    incarnations: frozen(incarnations),
    assignments: frozen(assignments),
    containments: frozen(containments),
    identityKeys: frozen(identityKeys),
    privateKeys: frozen(privateKeys),
    signatureReservations: frozen(signatureReservations),
    signedRecordAcceptances: frozen(signedRecordAcceptances),
    conversations: frozen(conversations),
    transitions: frozen(transitions),
    bindingIncarnations: frozen(bindingIncarnations),
    attachments: frozen(attachments),
    attachmentLeases: frozen(attachmentLeases),
    gates: frozen(gates),
  });
}

function snapshotFailure(message: string): never {
  throw new RuntimeOwnerRepositoryPersistenceError(`runtime-owner snapshot is invalid: ${message}`);
}

function snapshotAssert(condition: unknown, message: string): asserts condition {
  if (!condition) snapshotFailure(message);
}

function compositeKey(...parts: readonly (number | string)[]): string {
  return JSON.stringify(parts);
}

function countJournalEntries(
  journal: readonly RuntimeOwnerJournalEntry[],
  entryKind: RuntimeOwnerJournalEntryKind,
  subjectId: string,
): number {
  return journal.filter((entry) => entry.entryKind === entryKind && entry.subjectId === subjectId)
    .length;
}

function assertJournalCount(
  journal: readonly RuntimeOwnerJournalEntry[],
  entryKind: RuntimeOwnerJournalEntryKind,
  subjectId: string,
  expected: number,
): void {
  snapshotAssert(
    countJournalEntries(journal, entryKind, subjectId) === expected,
    `${entryKind} journal coverage for ${subjectId} is not exactly ${expected}`,
  );
}

interface SnapshotNativeBinding {
  readonly nativeBindingId: NativeBindingId;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly descriptor: NativeEngineDescriptor;
  readonly projectId: ProjectId;
  readonly semanticConversationId: A1SafeId | null;
  readonly currentBindingIncarnationId: A1SafeId | null;
  readonly state: "starting" | "current" | "superseded" | "closed";
}

interface SnapshotTerminalRootState {
  readonly nativeBindingId: NativeBindingId;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly chatState: "recovering" | "ready";
  readonly edgeState: "installing" | "current";
  readonly rootPathCertificateId: A1SafeId | null;
}

const SNAPSHOT_NATIVE_BINDING_ROW_KEYS = [
  "native_binding_id",
  "collaboration_server_id",
  "logical_chat_id",
  "descriptor_product",
  "descriptor_access",
  "project_id",
  "semantic_conversation_id",
  "current_binding_incarnation_id",
  "state",
] as const;

const SNAPSHOT_TERMINAL_ROOT_ROW_KEYS = [
  "native_binding_id",
  "collaboration_server_id",
  "logical_chat_id",
  "chat_state",
  "edge_state",
  "root_path_certificate_id",
] as const;

const SNAPSHOT_COORDINATOR_LEASE_ROW_KEYS = [
  "coordinator_lease_id",
  "collaboration_server_id",
  "coordinator_epoch",
  "owner_instance_id",
  "acquired_at_ms",
  "heartbeat_deadline_ms",
  "released_at_ms",
  "state",
] as const;

function snapshotCoordinatorLeaseFromRow(value: unknown): CoordinatorLeaseRecord {
  const row = rawRow(value, SNAPSHOT_COORDINATOR_LEASE_ROW_KEYS, "snapshotCoordinatorLease");
  return persisted("snapshotCoordinatorLease", () =>
    parseCoordinatorLeaseRecord({
      coordinatorLeaseId: row.coordinator_lease_id,
      collaborationServerId: row.collaboration_server_id,
      coordinatorEpoch: row.coordinator_epoch,
      ownerInstanceId: row.owner_instance_id,
      acquiredAtMs: row.acquired_at_ms,
      heartbeatDeadlineMs: row.heartbeat_deadline_ms,
      releasedAtMs: row.released_at_ms,
      state: row.state,
    }),
  );
}

function snapshotNativeBindingFromRow(value: unknown): SnapshotNativeBinding {
  const row = rawRow(value, SNAPSHOT_NATIVE_BINDING_ROW_KEYS, "snapshotNativeBinding");
  return persisted("snapshotNativeBinding", () =>
    frozen({
      nativeBindingId: parseA1CanonicalId(
        "nativeBinding",
        row.native_binding_id,
        "snapshotNativeBinding.nativeBindingId",
      ),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        row.collaboration_server_id,
        "snapshotNativeBinding.collaborationServerId",
      ),
      logicalChatId: parseA1CanonicalId(
        "logicalChat",
        row.logical_chat_id,
        "snapshotNativeBinding.logicalChatId",
      ),
      descriptor: frozen({
        product: parseEnum(
          row.descriptor_product,
          ["claude-code", "codex", "opencode"] as const,
          "snapshotNativeBinding.descriptor.product",
        ),
        access: parseEnum(
          row.descriptor_access,
          ["native-rc", "app-server", "server", "tmux"] as const,
          "snapshotNativeBinding.descriptor.access",
        ),
      }) as NativeEngineDescriptor,
      projectId: parseA1CanonicalId("project", row.project_id, "snapshotNativeBinding.projectId"),
      semanticConversationId: parseNullable(
        row.semantic_conversation_id,
        parseA1SafeId,
        "snapshotNativeBinding.semanticConversationId",
      ),
      currentBindingIncarnationId: parseNullable(
        row.current_binding_incarnation_id,
        parseA1SafeId,
        "snapshotNativeBinding.currentBindingIncarnationId",
      ),
      state: parseEnum(
        row.state,
        ["starting", "current", "superseded", "closed"] as const,
        "snapshotNativeBinding.state",
      ),
    }),
  );
}

function snapshotTerminalRootStateFromRow(value: unknown): SnapshotTerminalRootState {
  const row = rawRow(value, SNAPSHOT_TERMINAL_ROOT_ROW_KEYS, "snapshotTerminalRoot");
  return persisted("snapshotTerminalRoot", () =>
    frozen({
      nativeBindingId: parseA1CanonicalId(
        "nativeBinding",
        row.native_binding_id,
        "snapshotTerminalRoot.nativeBindingId",
      ),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        row.collaboration_server_id,
        "snapshotTerminalRoot.collaborationServerId",
      ),
      logicalChatId: parseA1CanonicalId(
        "logicalChat",
        row.logical_chat_id,
        "snapshotTerminalRoot.logicalChatId",
      ),
      chatState: parseEnum(
        row.chat_state,
        ["recovering", "ready"] as const,
        "snapshotTerminalRoot.chatState",
      ),
      edgeState: parseEnum(
        row.edge_state,
        ["installing", "current"] as const,
        "snapshotTerminalRoot.edgeState",
      ),
      rootPathCertificateId: parseNullable(
        row.root_path_certificate_id,
        parseA1SafeId,
        "snapshotTerminalRoot.rootPathCertificateId",
      ),
    }),
  );
}

function assertServiceLeaseReference(
  leasesById: ReadonlyMap<string, RuntimeOwnerServiceLeaseRecord>,
  leaseId: A1SafeId,
  epoch: number,
  eventAtMs: number,
  context: string,
): void {
  const lease = leasesById.get(leaseId);
  snapshotAssert(lease !== undefined, `${context} references an unknown service lease`);
  snapshotAssert(lease.runtimeOwnerServiceEpoch === epoch, `${context} service epoch mismatches`);
  const withinUpperBound =
    lease.releasedAtMs === null
      ? eventAtMs < lease.heartbeatDeadlineMs
      : eventAtMs <= lease.releasedAtMs;
  snapshotAssert(
    lease.acquiredAtMs <= eventAtMs && withinUpperBound,
    `${context} is outside its service-lease lifetime`,
  );
}

function assertCoordinatorLeaseReference(
  leasesById: ReadonlyMap<string, CoordinatorLeaseRecord>,
  collaborationServerId: CollaborationServerId,
  leaseId: A1SafeId,
  epoch: number,
  eventAtMs: number,
  context: string,
): void {
  const lease = leasesById.get(leaseId);
  snapshotAssert(lease !== undefined, `${context} references an unknown coordinator lease`);
  snapshotAssert(
    lease.collaborationServerId === collaborationServerId,
    `${context} coordinator lease escapes its collaboration-server scope`,
  );
  snapshotAssert(lease.coordinatorEpoch === epoch, `${context} coordinator epoch mismatches`);
  const withinUpperBound =
    lease.releasedAtMs === null
      ? eventAtMs < lease.heartbeatDeadlineMs
      : eventAtMs <= lease.releasedAtMs;
  snapshotAssert(
    lease.acquiredAtMs <= eventAtMs && withinUpperBound,
    `${context} is outside its coordinator-lease lifetime`,
  );
}

function claimJournalFact(
  journal: readonly RuntimeOwnerJournalEntry[],
  claimedOffsets: Set<number>,
  expected: Readonly<{
    entryKind: RuntimeOwnerJournalEntryKind;
    subjectId: A1SafeId;
    committedAtMs: number;
    runtimeOwnerServiceLeaseId?: A1SafeId;
    runtimeOwnerServiceEpoch?: number;
  }>,
  context: string,
): RuntimeOwnerJournalEntry {
  const matches = journal.filter(
    (entry) =>
      !claimedOffsets.has(entry.journalOffset) &&
      entry.entryKind === expected.entryKind &&
      entry.subjectId === expected.subjectId &&
      entry.committedAtMs === expected.committedAtMs &&
      (expected.runtimeOwnerServiceLeaseId === undefined ||
        entry.runtimeOwnerServiceLeaseId === expected.runtimeOwnerServiceLeaseId) &&
      (expected.runtimeOwnerServiceEpoch === undefined ||
        entry.runtimeOwnerServiceEpoch === expected.runtimeOwnerServiceEpoch),
  );
  snapshotAssert(matches.length > 0, `${context} has no exact journal fact`);
  const entry = matches[0];
  snapshotAssert(entry !== undefined, `${context} journal fact is absent`);
  claimedOffsets.add(entry.journalOffset);
  return entry;
}

/**
 * Validate the complete schema-v4 runtime-owner graph inside the caller's
 * synchronous read transaction. The returned inventory is safe to publish
 * only after this function has accepted every root, history, fence and edge.
 */
export function validateRuntimeOwnerRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  schemaVersion = 4,
): RuntimeOwnerInventory {
  const expectedMachineIdentityId = parseMachineIdentityId(
    machineIdentityId,
    "validateRuntimeOwnerRepositorySnapshot.machineIdentityId",
  );
  const inventory = readInventoryTransaction(transaction);
  const allowNativeRegistration = schemaVersion >= 5;
  const allowTerminalRoot = schemaVersion >= 6;
  snapshotAssert(
    inventory.state.machineIdentityId === expectedMachineIdentityId,
    "machine identity does not match the repository scope",
  );

  const storedServiceLeases = sqlAll(
    transaction,
    `SELECT ${selectColumns(SERVICE_LEASE_ROW_KEYS)} FROM runtime_owner_service_leases
     ORDER BY runtime_owner_service_epoch`,
  ).map(storedServiceLeaseFromRow);
  const storedRuntimes = sqlAll(
    transaction,
    `SELECT ${selectColumns(RUNTIME_ROW_KEYS)} FROM native_runtimes ORDER BY runtime_id`,
  ).map(storedRuntimeFromRow);
  const nativeBindings = sqlAll(
    transaction,
    `SELECT ${selectColumns(SNAPSHOT_NATIVE_BINDING_ROW_KEYS)} FROM native_bindings
     ORDER BY native_binding_id`,
  ).map(snapshotNativeBindingFromRow);
  const terminalRootStates = sqlAll(
    transaction,
    `SELECT b.native_binding_id, b.collaboration_server_id, b.logical_chat_id,
            chat.state AS chat_state, edge.state AS edge_state,
            edge.root_path_certificate_id
       FROM native_bindings AS b
       JOIN logical_chats AS chat
         ON chat.collaboration_server_id = b.collaboration_server_id
        AND chat.logical_chat_id = b.logical_chat_id
        AND chat.current_native_binding_id = b.native_binding_id
       JOIN inward_collaboration_edges AS edge
         ON edge.inward_edge_id = chat.current_inward_edge_id
        AND edge.represented_server_id = chat.collaboration_server_id
        AND edge.represented_logical_chat_id = chat.logical_chat_id
        AND edge.target_kind = 'native-harness'
        AND edge.target_native_binding_id = b.native_binding_id
      ORDER BY b.native_binding_id`,
  ).map(snapshotTerminalRootStateFromRow);
  snapshotAssert(
    terminalRootStates.length === nativeBindings.length,
    "native bindings do not each have one exact terminal edge",
  );
  const terminalRootByBindingId = new Map(
    terminalRootStates.map((state) => [state.nativeBindingId, state] as const),
  );
  for (const binding of nativeBindings) {
    const terminal = terminalRootByBindingId.get(binding.nativeBindingId);
    const terminalIsInstalling =
      terminal?.collaborationServerId === binding.collaborationServerId &&
      terminal.logicalChatId === binding.logicalChatId &&
      terminal.chatState === "recovering" &&
      terminal.edgeState === "installing" &&
      terminal.rootPathCertificateId === null;
    const terminalIsRooted =
      allowTerminalRoot &&
      binding.state === "current" &&
      binding.semanticConversationId !== null &&
      binding.currentBindingIncarnationId !== null &&
      terminal?.collaborationServerId === binding.collaborationServerId &&
      terminal.logicalChatId === binding.logicalChatId &&
      terminal.chatState === "ready" &&
      terminal.edgeState === "current" &&
      terminal.rootPathCertificateId !== null;
    snapshotAssert(
      terminalIsInstalling || terminalIsRooted,
      "terminal binding graph is neither installing nor exactly rooted for this schema",
    );
  }
  const coordinatorLeases = sqlAll(
    transaction,
    `SELECT ${selectColumns(SNAPSHOT_COORDINATOR_LEASE_ROW_KEYS)} FROM coordinator_leases
     ORDER BY collaboration_server_id, coordinator_epoch`,
  ).map(snapshotCoordinatorLeaseFromRow);
  const coordinatorLeasesById = new Map<string, CoordinatorLeaseRecord>();
  for (const lease of coordinatorLeases) {
    snapshotAssert(
      !coordinatorLeasesById.has(lease.coordinatorLeaseId),
      "coordinator lease ID is duplicated",
    );
    coordinatorLeasesById.set(lease.coordinatorLeaseId, lease);
  }
  const projectRows = sqlAll(
    transaction,
    "SELECT project_id, state FROM projects ORDER BY project_id",
  );
  const projectStates = new Map<string, string>();
  for (const value of projectRows) {
    const row = rawRow(value, ["project_id", "state"] as const, "snapshotProject");
    const projectId = parseA1CanonicalId("project", row.project_id, "snapshotProject.projectId");
    const state = parseEnum(row.state, ["current", "closed"] as const, "snapshotProject.state");
    projectStates.set(projectId, state);
  }
  const claimedJournalOffsets = new Set<number>();

  snapshotAssert(
    inventory.state.nextJournalOffset === inventory.journal.length,
    "journal root does not equal the durable journal length",
  );
  const operationIds = new Set<string>();
  const leasesById = new Map<string, RuntimeOwnerServiceLeaseRecord>();
  const leasesByEpoch = new Map<number, RuntimeOwnerServiceLeaseRecord>();
  let previousLeaseLastJournalOffset: number | undefined;
  for (const [index, stored] of storedServiceLeases.entries()) {
    const lease = stored.lease;
    snapshotAssert(
      lease.machineIdentityId === expectedMachineIdentityId,
      "service lease escapes the machine scope",
    );
    snapshotAssert(
      lease.runtimeOwnerServiceEpoch === index + 1,
      "service lease epochs are not contiguous",
    );
    snapshotAssert(
      !leasesById.has(lease.runtimeOwnerServiceLeaseId),
      "service lease ID is duplicated",
    );
    leasesById.set(lease.runtimeOwnerServiceLeaseId, lease);
    leasesByEpoch.set(lease.runtimeOwnerServiceEpoch, lease);
    assertJournalCount(
      inventory.journal,
      "service_lease_acquired",
      lease.runtimeOwnerServiceLeaseId,
      1,
    );
    const acquisitionEntry = claimJournalFact(
      inventory.journal,
      claimedJournalOffsets,
      {
        entryKind: "service_lease_acquired",
        subjectId: lease.runtimeOwnerServiceLeaseId,
        committedAtMs: lease.acquiredAtMs,
        runtimeOwnerServiceLeaseId: lease.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: lease.runtimeOwnerServiceEpoch,
      },
      `service lease ${lease.runtimeOwnerServiceLeaseId} acquisition`,
    );
    snapshotAssert(
      previousLeaseLastJournalOffset === undefined ||
        acquisitionEntry.journalOffset > previousLeaseLastJournalOffset,
      "service lease acquisition does not follow every predecessor-epoch journal effect",
    );
    const laterLeaseEntries = inventory.journal.filter(
      (entry) =>
        entry.runtimeOwnerServiceLeaseId === lease.runtimeOwnerServiceLeaseId &&
        entry.entryKind !== "service_lease_acquired",
    );
    snapshotAssert(
      laterLeaseEntries.every((entry) => entry.journalOffset > acquisitionEntry.journalOffset),
      "service lease journal effects precede their acquisition",
    );
    if (lease.state === "released") {
      const releasedAtMs = lease.releasedAtMs;
      snapshotAssert(releasedAtMs !== null, "released service lease has no release time");
      assertJournalCount(
        inventory.journal,
        "service_lease_released",
        lease.runtimeOwnerServiceLeaseId,
        1,
      );
      const releaseEntry = claimJournalFact(
        inventory.journal,
        claimedJournalOffsets,
        {
          entryKind: "service_lease_released",
          subjectId: lease.runtimeOwnerServiceLeaseId,
          committedAtMs: releasedAtMs,
          runtimeOwnerServiceLeaseId: lease.runtimeOwnerServiceLeaseId,
          runtimeOwnerServiceEpoch: lease.runtimeOwnerServiceEpoch,
        },
        `service lease ${lease.runtimeOwnerServiceLeaseId} release`,
      );
      snapshotAssert(
        laterLeaseEntries.every(
          (entry) =>
            entry.entryKind === "service_lease_released" ||
            entry.journalOffset < releaseEntry.journalOffset,
        ),
        "service lease release is not the final exact journal effect",
      );
    } else {
      assertJournalCount(
        inventory.journal,
        "service_lease_released",
        lease.runtimeOwnerServiceLeaseId,
        0,
      );
    }
    if (index > 0) {
      const predecessor = storedServiceLeases[index - 1];
      snapshotAssert(predecessor !== undefined, "service lease predecessor is missing");
      const earliestSuccessorAt =
        predecessor.lease.releasedAtMs ?? predecessor.lease.heartbeatDeadlineMs;
      snapshotAssert(
        lease.acquiredAtMs >= earliestSuccessorAt,
        "service lease successor predates predecessor release/deadline",
      );
    }
    previousLeaseLastJournalOffset = laterLeaseEntries.reduce(
      (maximum, entry) => Math.max(maximum, entry.journalOffset),
      acquisitionEntry.journalOffset,
    );
  }
  snapshotAssert(
    inventory.state.currentRuntimeOwnerServiceEpoch === storedServiceLeases.length,
    "service owner epoch does not equal the durable lease history",
  );
  if (inventory.state.currentRuntimeOwnerServiceLeaseId === null) {
    if (inventory.state.currentRuntimeOwnerServiceEpoch > 0) {
      const predecessor = leasesByEpoch.get(inventory.state.currentRuntimeOwnerServiceEpoch);
      snapshotAssert(
        predecessor?.state === "released" && predecessor.releasedAtMs !== null,
        "null service-owner pointer does not name a released final epoch",
      );
    }
  } else {
    const currentLease = leasesById.get(inventory.state.currentRuntimeOwnerServiceLeaseId);
    snapshotAssert(
      currentLease !== undefined &&
        currentLease.runtimeOwnerServiceEpoch === inventory.state.currentRuntimeOwnerServiceEpoch &&
        currentLease.state === "current" &&
        currentLease.releasedAtMs === null,
      "current service-owner pointer does not name the exact live lease",
    );
  }

  const runtimeIds = new Set<string>(inventory.runtimes.map(({ runtimeId }) => runtimeId));
  const identityKeyIds = new Set<string>(
    inventory.identityKeys.map(({ runtimeOwnerIdentityKeyId }) => runtimeOwnerIdentityKeyId),
  );
  const transitionIds = new Set<string>(
    inventory.transitions.map(({ localTransitionId }) => localTransitionId),
  );
  const bindingIncarnationIds = new Set<string>(
    inventory.bindingIncarnations.map(
      ({ nativeBindingIncarnationId }) => nativeBindingIncarnationId,
    ),
  );
  const attachmentLeaseIds = new Set<string>(
    inventory.attachmentLeases.map(({ attachmentLeaseId }) => attachmentLeaseId),
  );
  for (const [index, entry] of inventory.journal.entries()) {
    snapshotAssert(entry.journalOffset === index, "journal offsets are not contiguous from zero");
    snapshotAssert(!operationIds.has(entry.operationId), "journal operation ID is duplicated");
    operationIds.add(entry.operationId);
    assertServiceLeaseReference(
      leasesById,
      entry.runtimeOwnerServiceLeaseId,
      entry.runtimeOwnerServiceEpoch,
      entry.committedAtMs,
      `journal entry ${entry.operationId}`,
    );
    const subjectIsPresent =
      (entry.subjectKind === "service_lease" && leasesById.has(entry.subjectId)) ||
      (entry.subjectKind === "native_runtime" && runtimeIds.has(entry.subjectId)) ||
      (entry.subjectKind === "runtime_owner_identity_key" && identityKeyIds.has(entry.subjectId)) ||
      (entry.subjectKind === "local_native_transition" && transitionIds.has(entry.subjectId)) ||
      (entry.subjectKind === "native_binding_incarnation" &&
        bindingIncarnationIds.has(entry.subjectId)) ||
      (entry.subjectKind === "native_transport_lease" && attachmentLeaseIds.has(entry.subjectId));
    snapshotAssert(subjectIsPresent, `journal subject ${entry.subjectId} is absent`);
    const kindMatchesSubject =
      ((entry.entryKind === "service_lease_acquired" ||
        entry.entryKind === "service_lease_released") &&
        entry.subjectKind === "service_lease") ||
      ((entry.entryKind === "runtime_registered" ||
        entry.entryKind === "runtime_reassigned" ||
        entry.entryKind === "runtime_replaced" ||
        entry.entryKind === "runtime_terminated") &&
        entry.subjectKind === "native_runtime") ||
      (entry.entryKind === "runtime_key_rotated" &&
        entry.subjectKind === "runtime_owner_identity_key") ||
      (entry.entryKind === "local_conversation_transitioned" &&
        entry.subjectKind === "local_native_transition") ||
      (entry.entryKind === "binding_incarnation_prepared" &&
        entry.subjectKind === "native_binding_incarnation") ||
      ((entry.entryKind === "attachment_lease_acquired" ||
        entry.entryKind === "attachment_detached") &&
        entry.subjectKind === "native_transport_lease");
    snapshotAssert(kindMatchesSubject, `journal kind/subject mismatch at offset ${index}`);
  }

  const incarnationsByRuntime = new Map<string, NativeRuntimeIncarnationRecord[]>();
  for (const incarnation of inventory.incarnations) {
    const group = incarnationsByRuntime.get(incarnation.runtimeId) ?? [];
    group.push(incarnation);
    incarnationsByRuntime.set(incarnation.runtimeId, group);
    assertServiceLeaseReference(
      leasesById,
      incarnation.runtimeOwnerServiceLeaseId,
      incarnation.runtimeOwnerServiceEpoch,
      incarnation.startedAtMs,
      `runtime incarnation ${incarnation.runtimeId}/${incarnation.nativeIncarnation}`,
    );
  }
  const assignmentsByIncarnation = new Map<string, RuntimeOwnerAssignmentRecord[]>();
  for (const assignment of inventory.assignments) {
    const key = compositeKey(assignment.runtimeId, assignment.nativeIncarnation);
    const group = assignmentsByIncarnation.get(key) ?? [];
    group.push(assignment);
    assignmentsByIncarnation.set(key, group);
    assertServiceLeaseReference(
      leasesById,
      assignment.runtimeOwnerServiceLeaseId,
      assignment.runtimeOwnerServiceEpoch,
      assignment.assignedAtMs,
      `runtime-owner assignment ${assignment.runtimeOwnerAssignmentId}`,
    );
  }
  const containmentsByPredecessor = new Map<string, NativeRuntimeContainmentRecord>();
  for (const containment of inventory.containments) {
    const key = compositeKey(containment.runtimeId, containment.predecessorNativeIncarnation);
    snapshotAssert(
      !containmentsByPredecessor.has(key),
      "runtime incarnation has multiple containments",
    );
    containmentsByPredecessor.set(key, containment);
    assertServiceLeaseReference(
      leasesById,
      containment.runtimeOwnerServiceLeaseId,
      containment.runtimeOwnerServiceEpoch,
      containment.containedAtMs,
      `runtime containment ${containment.nativeRuntimeContainmentId}`,
    );
  }
  const assignmentActivationOffsets = new Map<string, number>();
  const incarnationContainmentOffsets = new Map<string, number>();

  for (const storedRuntime of storedRuntimes) {
    const runtime = storedRuntime.runtime;
    snapshotAssert(
      syncNativeRuntimeId(
        runtime.wardenLaunchNonce,
        runtime.initialStartIdentitySchemaId,
        runtime.initialStartIdentityDigest,
      ) === runtime.runtimeId,
      `runtime ${runtime.runtimeId} does not match its deterministic launch identity`,
    );
    assertJournalCount(inventory.journal, "runtime_registered", runtime.runtimeId, 1);
    const incarnations = incarnationsByRuntime.get(runtime.runtimeId) ?? [];
    snapshotAssert(incarnations.length > 0, `runtime ${runtime.runtimeId} has no incarnation`);
    const foundingIncarnation = incarnations[0];
    snapshotAssert(
      foundingIncarnation !== undefined &&
        foundingIncarnation.nativeIncarnation === 1 &&
        foundingIncarnation.startIdentitySchemaId === runtime.initialStartIdentitySchemaId &&
        foundingIncarnation.startIdentityRef === runtime.initialStartIdentityRef &&
        sameDigest(foundingIncarnation.startIdentityDigest, runtime.initialStartIdentityDigest) &&
        foundingIncarnation.startedAtMs === runtime.createdAtMs,
      `runtime ${runtime.runtimeId} root is not bound to its founding incarnation`,
    );
    for (const [index, incarnation] of incarnations.entries()) {
      const expectedIncarnation = index + 1;
      snapshotAssert(
        incarnation.nativeIncarnation === expectedIncarnation,
        `runtime ${runtime.runtimeId} incarnation history is not contiguous`,
      );
      snapshotAssert(
        sameDescriptor(incarnation.descriptor, runtime.descriptor),
        `runtime ${runtime.runtimeId} incarnation descriptor drifted`,
      );
      const assignments =
        assignmentsByIncarnation.get(compositeKey(runtime.runtimeId, expectedIncarnation)) ?? [];
      snapshotAssert(assignments.length > 0, "native incarnation has no owner assignment");
      for (const [assignmentIndex, assignment] of assignments.entries()) {
        const generation = assignmentIndex + 1;
        snapshotAssert(
          assignment.assignmentGeneration === generation,
          "runtime-owner assignment generations are not contiguous",
        );
        if (generation === 1) {
          snapshotAssert(
            assignment.reason === "creation" &&
              assignment.supersedesRuntimeOwnerAssignmentId === null &&
              assignment.assignmentEvidenceSchemaId === incarnation.startIdentitySchemaId &&
              assignment.assignmentEvidenceRef === incarnation.startIdentityRef &&
              sameDigest(assignment.assignmentEvidenceDigest, incarnation.startIdentityDigest),
            "creation assignment is not bound to incarnation start evidence",
          );
          let activationEntry: RuntimeOwnerJournalEntry;
          if (expectedIncarnation === 1) {
            snapshotAssert(
              assignment.assignedAtMs === runtime.createdAtMs &&
                assignment.runtimeOwnerServiceLeaseId ===
                  foundingIncarnation.runtimeOwnerServiceLeaseId &&
                assignment.runtimeOwnerServiceEpoch ===
                  foundingIncarnation.runtimeOwnerServiceEpoch,
              "founding assignment does not share its runtime creation fence/time",
            );
            activationEntry = claimJournalFact(
              inventory.journal,
              claimedJournalOffsets,
              {
                entryKind: "runtime_registered",
                subjectId: runtime.runtimeId,
                committedAtMs: runtime.createdAtMs,
                runtimeOwnerServiceLeaseId: assignment.runtimeOwnerServiceLeaseId,
                runtimeOwnerServiceEpoch: assignment.runtimeOwnerServiceEpoch,
              },
              `runtime ${runtime.runtimeId} registration`,
            );
          } else {
            const predecessorContainment = containmentsByPredecessor.get(
              compositeKey(runtime.runtimeId, expectedIncarnation - 1),
            );
            snapshotAssert(
              predecessorContainment?.kind === "replacement" &&
                predecessorContainment.successorNativeIncarnation === expectedIncarnation &&
                assignment.assignedAtMs === predecessorContainment.containedAtMs &&
                assignment.runtimeOwnerServiceLeaseId ===
                  predecessorContainment.runtimeOwnerServiceLeaseId &&
                assignment.runtimeOwnerServiceEpoch ===
                  predecessorContainment.runtimeOwnerServiceEpoch,
              "replacement assignment does not share its containment fence/time",
            );
            activationEntry = claimJournalFact(
              inventory.journal,
              claimedJournalOffsets,
              {
                entryKind: "runtime_replaced",
                subjectId: runtime.runtimeId,
                committedAtMs: predecessorContainment.containedAtMs,
                runtimeOwnerServiceLeaseId: predecessorContainment.runtimeOwnerServiceLeaseId,
                runtimeOwnerServiceEpoch: predecessorContainment.runtimeOwnerServiceEpoch,
              },
              `runtime ${runtime.runtimeId} replacement ${expectedIncarnation}`,
            );
          }
          assignmentActivationOffsets.set(
            assignment.runtimeOwnerAssignmentId,
            activationEntry.journalOffset,
          );
          if (expectedIncarnation > 1) {
            incarnationContainmentOffsets.set(
              compositeKey(runtime.runtimeId, expectedIncarnation - 1),
              activationEntry.journalOffset,
            );
          }
        } else {
          const predecessor = assignments[assignmentIndex - 1];
          snapshotAssert(predecessor !== undefined, "takeover assignment predecessor is absent");
          snapshotAssert(
            assignment.reason === "takeover" &&
              assignment.supersedesRuntimeOwnerAssignmentId ===
                predecessor.runtimeOwnerAssignmentId &&
              assignment.runtimeOwnerServiceEpoch > predecessor.runtimeOwnerServiceEpoch &&
              assignment.assignedAtMs >= predecessor.assignedAtMs,
            "takeover assignment does not extend its exact predecessor",
          );
          const reassignmentEntry = claimJournalFact(
            inventory.journal,
            claimedJournalOffsets,
            {
              entryKind: "runtime_reassigned",
              subjectId: runtime.runtimeId,
              committedAtMs: assignment.assignedAtMs,
              runtimeOwnerServiceLeaseId: assignment.runtimeOwnerServiceLeaseId,
              runtimeOwnerServiceEpoch: assignment.runtimeOwnerServiceEpoch,
            },
            `runtime ${runtime.runtimeId} reassignment ${generation}`,
          );
          assignmentActivationOffsets.set(
            assignment.runtimeOwnerAssignmentId,
            reassignmentEntry.journalOffset,
          );
        }
        const activationOffset = assignmentActivationOffsets.get(
          assignment.runtimeOwnerAssignmentId,
        );
        const predecessorAssignment = assignments[assignmentIndex - 1];
        const predecessorActivationOffset =
          predecessorAssignment === undefined
            ? undefined
            : assignmentActivationOffsets.get(predecessorAssignment.runtimeOwnerAssignmentId);
        snapshotAssert(
          activationOffset !== undefined &&
            (assignmentIndex === 0 ||
              (predecessorActivationOffset !== undefined &&
                activationOffset > predecessorActivationOffset)),
          "runtime-owner assignment activation order does not follow its generation",
        );
      }
      const containment = containmentsByPredecessor.get(
        compositeKey(runtime.runtimeId, expectedIncarnation),
      );
      const latestAssignment = assignments.at(-1);
      if (index < incarnations.length - 1) {
        const successor = incarnations[index + 1];
        snapshotAssert(successor !== undefined, "replacement successor is absent");
        snapshotAssert(
          containment?.kind === "replacement" &&
            containment.successorNativeIncarnation === successor.nativeIncarnation &&
            incarnation.state === "closed" &&
            incarnation.closedAtMs === containment.containedAtMs &&
            successor.startedAtMs === containment.containedAtMs &&
            latestAssignment !== undefined &&
            containment.runtimeOwnerServiceLeaseId ===
              latestAssignment.runtimeOwnerServiceLeaseId &&
            containment.runtimeOwnerServiceEpoch === latestAssignment.runtimeOwnerServiceEpoch,
          "replacement containment does not join exact predecessor/successor lifecycles",
        );
      } else if (runtime.state === "closed") {
        snapshotAssert(
          containment?.kind === "termination" &&
            containment.successorNativeIncarnation === null &&
            incarnation.state === "closed" &&
            incarnation.closedAtMs === containment.containedAtMs &&
            runtime.closedAtMs === containment.containedAtMs &&
            latestAssignment !== undefined &&
            containment.runtimeOwnerServiceLeaseId ===
              latestAssignment.runtimeOwnerServiceLeaseId &&
            containment.runtimeOwnerServiceEpoch === latestAssignment.runtimeOwnerServiceEpoch,
          "termination containment does not close the runtime and final incarnation atomically",
        );
        const terminationEntry = claimJournalFact(
          inventory.journal,
          claimedJournalOffsets,
          {
            entryKind: "runtime_terminated",
            subjectId: runtime.runtimeId,
            committedAtMs: containment.containedAtMs,
            runtimeOwnerServiceLeaseId: containment.runtimeOwnerServiceLeaseId,
            runtimeOwnerServiceEpoch: containment.runtimeOwnerServiceEpoch,
          },
          `runtime ${runtime.runtimeId} termination`,
        );
        incarnationContainmentOffsets.set(
          compositeKey(runtime.runtimeId, expectedIncarnation),
          terminationEntry.journalOffset,
        );
      } else {
        snapshotAssert(containment === undefined, "current final incarnation is already contained");
        snapshotAssert(
          runtime.currentNativeIncarnation === incarnation.nativeIncarnation &&
            incarnation.state !== "closed",
          "current runtime does not point to its open final incarnation",
        );
        const assignments = assignmentsByIncarnation.get(
          compositeKey(runtime.runtimeId, incarnation.nativeIncarnation),
        );
        const currentAssignment = assignments?.at(-1);
        snapshotAssert(
          currentAssignment !== undefined &&
            runtime.currentRuntimeOwnerAssignmentId === currentAssignment.runtimeOwnerAssignmentId,
          "current runtime does not point to the latest assignment",
        );
      }
    }
    snapshotAssert(
      storedRuntime.nextLocalTransitionSeq ===
        inventory.transitions.filter(({ runtimeId }) => runtimeId === runtime.runtimeId).length + 1,
      `runtime ${runtime.runtimeId} local transition root is not contiguous`,
    );
    assertJournalCount(
      inventory.journal,
      "runtime_replaced",
      runtime.runtimeId,
      inventory.containments.filter(
        (record) => record.runtimeId === runtime.runtimeId && record.kind === "replacement",
      ).length,
    );
    assertJournalCount(
      inventory.journal,
      "runtime_terminated",
      runtime.runtimeId,
      runtime.state === "closed" ? 1 : 0,
    );
    assertJournalCount(
      inventory.journal,
      "runtime_reassigned",
      runtime.runtimeId,
      inventory.assignments.filter(
        (record) => record.runtimeId === runtime.runtimeId && record.reason === "takeover",
      ).length,
    );
  }

  for (const assignment of inventory.assignments) {
    const activationOffset = assignmentActivationOffsets.get(assignment.runtimeOwnerAssignmentId);
    const containmentOffset = incarnationContainmentOffsets.get(
      compositeKey(assignment.runtimeId, assignment.nativeIncarnation),
    );
    snapshotAssert(
      activationOffset !== undefined &&
        (containmentOffset === undefined || activationOffset < containmentOffset),
      "runtime-owner assignment activates outside its incarnation lifetime",
    );
  }

  const assertJournalUsesActiveAssignment = (
    runtimeId: NativeRuntimeId,
    nativeIncarnation: number | undefined,
    entry: RuntimeOwnerJournalEntry,
    context: string,
  ): RuntimeOwnerAssignmentRecord => {
    const assignment = inventory.assignments
      .filter(
        (candidate) =>
          candidate.runtimeId === runtimeId &&
          (nativeIncarnation === undefined || candidate.nativeIncarnation === nativeIncarnation) &&
          (assignmentActivationOffsets.get(candidate.runtimeOwnerAssignmentId) ??
            Number.MAX_SAFE_INTEGER) <= entry.journalOffset &&
          (incarnationContainmentOffsets.get(
            compositeKey(candidate.runtimeId, candidate.nativeIncarnation),
          ) ?? Number.MAX_SAFE_INTEGER) > entry.journalOffset,
      )
      .sort((left, right) => {
        const offsetDifference =
          (assignmentActivationOffsets.get(left.runtimeOwnerAssignmentId) ?? -1) -
          (assignmentActivationOffsets.get(right.runtimeOwnerAssignmentId) ?? -1);
        return offsetDifference !== 0
          ? offsetDifference
          : left.assignmentGeneration - right.assignmentGeneration;
      })
      .at(-1);
    snapshotAssert(assignment !== undefined, `${context} has no active runtime-owner assignment`);
    snapshotAssert(
      entry.runtimeOwnerServiceLeaseId === assignment.runtimeOwnerServiceLeaseId &&
        entry.runtimeOwnerServiceEpoch === assignment.runtimeOwnerServiceEpoch,
      `${context} journal fence does not match its active runtime assignment`,
    );
    return assignment;
  };

  const keysByRuntime = new Map<string, RuntimeOwnerIdentityKeyRecord[]>();
  const privateKeysByTuple = new Map<string, RuntimeOwnerPrivateKeyEnvelopeRecord>();
  const privateHandleIds = new Set<string>();
  for (const privateKey of inventory.privateKeys) {
    const tuple = compositeKey(
      privateKey.runtimeId,
      privateKey.runtimeOwnerIdentityKeyId,
      privateKey.keyGeneration,
    );
    snapshotAssert(!privateKeysByTuple.has(tuple), "identity key has multiple custody envelopes");
    privateKeysByTuple.set(tuple, privateKey);
    privateHandleIds.add(privateKey.signingKeyRef.protectedHandleId);
  }
  const protectedArtifactRows = sqlAll(
    transaction,
    "SELECT protected_handle_id FROM protected_artifacts ORDER BY protected_handle_id",
  );
  for (const value of protectedArtifactRows) {
    const row = rawRow(value, ["protected_handle_id"] as const, "snapshotProtectedArtifact");
    const protectedHandleId = parseA1CanonicalId(
      "protectedHandle",
      row.protected_handle_id,
      "snapshotProtectedArtifact.protectedHandleId",
    );
    snapshotAssert(
      !privateHandleIds.has(protectedHandleId),
      `protected handle ${protectedHandleId} aliases signing-key and artifact custody`,
    );
  }
  for (const identityKey of inventory.identityKeys) {
    const group = keysByRuntime.get(identityKey.runtimeId) ?? [];
    group.push(identityKey);
    keysByRuntime.set(identityKey.runtimeId, group);
    const privateKey = privateKeysByTuple.get(
      compositeKey(
        identityKey.runtimeId,
        identityKey.runtimeOwnerIdentityKeyId,
        identityKey.keyGeneration,
      ),
    );
    snapshotAssert(privateKey !== undefined, "identity key has no exact custody envelope");
    snapshotAssert(
      identityKey.state === "current"
        ? identityKey.signingKeyRef?.protectedHandleId ===
            privateKey.signingKeyRef.protectedHandleId && privateKey.state === "current"
        : identityKey.signingKeyRef === null && privateKey.state === "destroyed",
      "identity-key and private-key custody lifecycles diverge",
    );
  }
  for (const runtime of inventory.runtimes) {
    const keys = keysByRuntime.get(runtime.runtimeId) ?? [];
    snapshotAssert(keys.length > 0, `runtime ${runtime.runtimeId} has no identity key`);
    let previousRotationJournalOffset: number | undefined;
    for (const [index, key] of keys.entries()) {
      snapshotAssert(
        key.keyGeneration === index + 1,
        "identity-key generations are not contiguous",
      );
      assertJournalCount(
        inventory.journal,
        "runtime_key_rotated",
        key.runtimeOwnerIdentityKeyId,
        key.keyGeneration === 1 ? 0 : 1,
      );
      if (key.keyGeneration > 1) {
        const privateKey = privateKeysByTuple.get(
          compositeKey(key.runtimeId, key.runtimeOwnerIdentityKeyId, key.keyGeneration),
        );
        snapshotAssert(privateKey !== undefined, "rotated key custody envelope is absent");
        const predecessorKey = keys[index - 1];
        const predecessorPrivateKey =
          predecessorKey === undefined
            ? undefined
            : privateKeysByTuple.get(
                compositeKey(
                  predecessorKey.runtimeId,
                  predecessorKey.runtimeOwnerIdentityKeyId,
                  predecessorKey.keyGeneration,
                ),
              );
        snapshotAssert(
          predecessorKey?.state === "retired" &&
            predecessorPrivateKey?.state === "destroyed" &&
            predecessorPrivateKey.destroyedAtMs === privateKey.createdAtMs,
          "runtime key rotation does not retire and destroy its exact predecessor atomically",
        );
        const rotationEntry = claimJournalFact(
          inventory.journal,
          claimedJournalOffsets,
          {
            entryKind: "runtime_key_rotated",
            subjectId: key.runtimeOwnerIdentityKeyId,
            committedAtMs: privateKey.createdAtMs,
          },
          `runtime identity key ${key.runtimeOwnerIdentityKeyId} rotation`,
        );
        snapshotAssert(
          previousRotationJournalOffset === undefined ||
            rotationEntry.journalOffset > previousRotationJournalOffset,
          "runtime key-rotation journal order does not follow its key generation",
        );
        previousRotationJournalOffset = rotationEntry.journalOffset;
        assertJournalUsesActiveAssignment(
          key.runtimeId,
          undefined,
          rotationEntry,
          "runtime key rotation",
        );
      } else {
        const privateKey = privateKeysByTuple.get(
          compositeKey(key.runtimeId, key.runtimeOwnerIdentityKeyId, key.keyGeneration),
        );
        snapshotAssert(
          privateKey?.createdAtMs === runtime.createdAtMs,
          "founding runtime identity key does not share the runtime registration time",
        );
      }
    }
    snapshotAssert(
      keys.filter(({ state }) => state === "current").length === 1 &&
        keys.at(-1)?.state === "current",
      `runtime ${runtime.runtimeId} does not have exactly one current identity key`,
    );
  }

  const reservationsByKey = new Map<string, RuntimeOwnerSignatureReservationRecord[]>();
  for (const reservation of inventory.signatureReservations) {
    const keyTuple = compositeKey(
      reservation.runtimeId,
      reservation.runtimeOwnerIdentityKeyId,
      reservation.runtimeOwnerKeyGeneration,
    );
    const group = reservationsByKey.get(keyTuple) ?? [];
    group.push(reservation);
    reservationsByKey.set(keyTuple, group);
  }
  for (const identityKey of inventory.identityKeys) {
    const keyTuple = compositeKey(
      identityKey.runtimeId,
      identityKey.runtimeOwnerIdentityKeyId,
      identityKey.keyGeneration,
    );
    const reservations = reservationsByKey.get(keyTuple) ?? [];
    snapshotAssert(
      identityKey.nextSignerSequence === reservations.length,
      "identity-key signer counter does not equal its durable reservation prefix",
    );
    for (const [index, reservation] of reservations.entries()) {
      snapshotAssert(
        reservation.signerSequence === index,
        "signature reservations are not contiguous",
      );
    }
  }
  const acceptanceDigests = new Set<string>();
  for (const acceptance of inventory.signedRecordAcceptances) {
    const reservation = inventory.signatureReservations.find(
      (candidate) =>
        candidate.runtimeId === acceptance.runtimeId &&
        candidate.runtimeOwnerIdentityKeyId === acceptance.runtimeOwnerIdentityKeyId &&
        candidate.runtimeOwnerKeyGeneration === acceptance.runtimeOwnerKeyGeneration &&
        candidate.signerSequence === acceptance.signerSequence,
    );
    snapshotAssert(
      reservation?.state === "signed" &&
        reservation.signedRecordDigest !== null &&
        sameDigest(reservation.signedRecordDigest, acceptance.signedRecordDigest),
      "signed-record acceptance does not bind an exact signed reservation",
    );
    snapshotAssert(
      !acceptanceDigests.has(acceptance.signedRecordDigest),
      "signed record digest is accepted more than once",
    );
    acceptanceDigests.add(acceptance.signedRecordDigest);
  }

  const incarnationKeys = new Set(
    inventory.incarnations.map(({ runtimeId, nativeIncarnation }) =>
      compositeKey(runtimeId, nativeIncarnation),
    ),
  );
  const conversationsById = new Map(
    inventory.conversations.map((conversation) => [
      conversation.localNativeConversationId,
      conversation,
    ]),
  );
  for (const conversation of inventory.conversations) {
    snapshotAssert(
      incarnationKeys.has(compositeKey(conversation.runtimeId, conversation.nativeIncarnation)),
      "local conversation references an absent native incarnation",
    );
    const runtime = inventory.runtimes.find(
      ({ runtimeId }) => runtimeId === conversation.runtimeId,
    );
    snapshotAssert(
      runtime !== undefined && sameDescriptor(runtime.descriptor, conversation.descriptor),
      "local conversation descriptor does not match its runtime",
    );
    const projectState = projectStates.get(conversation.projectId);
    snapshotAssert(
      projectState !== undefined,
      "local conversation references an absent A1.2 project",
    );
    snapshotAssert(
      conversation.state === "closed" || projectState === "current",
      "live local conversation references a closed A1.2 project",
    );
    if (conversation.parentLocalNativeConversationId !== null) {
      const parent = conversationsById.get(conversation.parentLocalNativeConversationId);
      snapshotAssert(
        parent !== undefined &&
          parent.runtimeId === conversation.runtimeId &&
          parent.nativeIncarnation === conversation.nativeIncarnation,
        "local conversation parent escapes its runtime incarnation",
      );
    }
  }
  for (const conversation of inventory.conversations) {
    const visited = new Set<string>([conversation.localNativeConversationId]);
    let cursor = conversation;
    while (cursor.parentLocalNativeConversationId !== null) {
      snapshotAssert(
        !visited.has(cursor.parentLocalNativeConversationId),
        "local conversation parent lineage contains a cycle",
      );
      visited.add(cursor.parentLocalNativeConversationId);
      const parent = conversationsById.get(cursor.parentLocalNativeConversationId);
      snapshotAssert(parent !== undefined, "local conversation parent is absent");
      cursor = parent;
    }
  }
  const transitionSequenceByRuntime = new Map<string, number>();
  const transitionJournalOffsetByRuntime = new Map<string, number>();
  const createdConversationIds = new Set<string>();
  const projectedConversationStates = new Map<string, LocalNativeConversationRecord["state"]>();
  for (const transition of inventory.transitions) {
    const expectedSequence = (transitionSequenceByRuntime.get(transition.runtimeId) ?? 0) + 1;
    snapshotAssert(
      transition.localTransitionSeq === expectedSequence,
      `runtime ${transition.runtimeId} transition history is not contiguous`,
    );
    transitionSequenceByRuntime.set(transition.runtimeId, expectedSequence);
    const target = conversationsById.get(transition.targetLocalNativeConversationId);
    const source =
      transition.sourceLocalNativeConversationId === null
        ? null
        : conversationsById.get(transition.sourceLocalNativeConversationId);
    snapshotAssert(
      target !== undefined &&
        target.runtimeId === transition.runtimeId &&
        target.nativeIncarnation === transition.nativeIncarnation,
      "local transition target escapes its runtime incarnation",
    );
    snapshotAssert(
      transition.sourceLocalNativeConversationId === null ||
        (source !== undefined &&
          source !== null &&
          source.runtimeId === transition.runtimeId &&
          source.nativeIncarnation === transition.nativeIncarnation),
      "local transition source escapes its runtime incarnation",
    );
    snapshotAssert(
      transition.observedSemanticConversationId === null ||
        target.semanticConversationId === transition.observedSemanticConversationId,
      "local transition semantic observation does not match its target",
    );
    const createsTarget =
      transition.kind === "discover" ||
      transition.kind === "new" ||
      transition.kind === "clear" ||
      transition.kind === "fork";
    snapshotAssert(
      transition.sourceLocalNativeConversationId === null ||
        createdConversationIds.has(transition.sourceLocalNativeConversationId),
      "local transition source was not introduced by an earlier transition",
    );
    snapshotAssert(
      createsTarget
        ? !createdConversationIds.has(transition.targetLocalNativeConversationId)
        : createdConversationIds.has(transition.targetLocalNativeConversationId),
      "local transition target creation history is inconsistent",
    );
    if (createsTarget) createdConversationIds.add(transition.targetLocalNativeConversationId);
    if (transition.kind === "fork") {
      snapshotAssert(
        transition.sourceLocalNativeConversationId !== null &&
          target.parentLocalNativeConversationId === transition.sourceLocalNativeConversationId,
        "fork transition does not bind the target parent to its exact source",
      );
    } else if (createsTarget) {
      snapshotAssert(
        target.parentLocalNativeConversationId === null,
        "non-fork conversation creation invents parent lineage",
      );
    }
    if (transition.kind === "clear" && transition.sourceLocalNativeConversationId !== null) {
      projectedConversationStates.set(transition.sourceLocalNativeConversationId, "closed");
    } else if (transition.kind === "archive") {
      projectedConversationStates.set(transition.targetLocalNativeConversationId, "closed");
    } else if (transition.kind === "unarchive") {
      projectedConversationStates.set(transition.targetLocalNativeConversationId, "open");
    }
    assertJournalCount(
      inventory.journal,
      "local_conversation_transitioned",
      transition.localTransitionId,
      1,
    );
    const transitionEntry = claimJournalFact(
      inventory.journal,
      claimedJournalOffsets,
      {
        entryKind: "local_conversation_transitioned",
        subjectId: transition.localTransitionId,
        committedAtMs: transition.observedAtMs,
      },
      `local transition ${transition.localTransitionId}`,
    );
    const previousTransitionOffset = transitionJournalOffsetByRuntime.get(transition.runtimeId);
    snapshotAssert(
      previousTransitionOffset === undefined ||
        transitionEntry.journalOffset > previousTransitionOffset,
      "local transition journal order does not follow its runtime sequence",
    );
    transitionJournalOffsetByRuntime.set(transition.runtimeId, transitionEntry.journalOffset);
    assertJournalUsesActiveAssignment(
      transition.runtimeId,
      transition.nativeIncarnation,
      transitionEntry,
      `local transition ${transition.localTransitionId}`,
    );
  }
  for (const conversation of inventory.conversations) {
    snapshotAssert(
      createdConversationIds.has(conversation.localNativeConversationId),
      "local conversation has no exact creating transition",
    );
    const projectedState = projectedConversationStates.get(conversation.localNativeConversationId);
    snapshotAssert(
      projectedState === undefined || projectedState === conversation.state,
      "local conversation state does not match its transition history",
    );
  }

  const bindingsById = new Map(nativeBindings.map((binding) => [binding.nativeBindingId, binding]));
  const bindingIncarnationsById = new Map(
    inventory.bindingIncarnations.map((record) => [record.nativeBindingIncarnationId, record]),
  );
  const attachmentsById = new Map(
    inventory.attachments.map((record) => [record.attachmentId, record]),
  );
  const attachmentLeasesById = new Map(
    inventory.attachmentLeases.map((record) => [record.attachmentLeaseId, record]),
  );
  const gatesByBindingId = new Map(
    inventory.gates.map((record) => [record.nativeBindingId, record]),
  );
  const attachmentAcquisitionJournalOffsets = new Map<string, number>();
  for (const bindingIncarnation of inventory.bindingIncarnations) {
    const binding = bindingsById.get(bindingIncarnation.nativeBindingId);
    const exactLeases = inventory.attachmentLeases.filter(
      ({ nativeBindingIncarnationId }) =>
        nativeBindingIncarnationId === bindingIncarnation.nativeBindingIncarnationId,
    );
    const exactLease = exactLeases[0];
    const exactAttachment =
      exactLease === undefined ? undefined : attachmentsById.get(exactLease.attachmentId);
    const exactGate = gatesByBindingId.get(bindingIncarnation.nativeBindingId);
    const bindingRootIsDormant =
      binding?.state === "starting" &&
      binding.semanticConversationId === null &&
      binding.currentBindingIncarnationId === null;
    const bindingRootIsActivated =
      allowNativeRegistration &&
      binding?.state === "current" &&
      binding.semanticConversationId === bindingIncarnation.semanticConversationId &&
      binding.currentBindingIncarnationId === bindingIncarnation.nativeBindingIncarnationId;
    snapshotAssert(
      binding !== undefined &&
        binding.collaborationServerId === bindingIncarnation.collaborationServerId &&
        binding.logicalChatId === bindingIncarnation.logicalChatId &&
        (bindingRootIsDormant || bindingRootIsActivated),
      "A1.3 binding incarnation changes or escapes its dormant A1.2 binding root",
    );
    snapshotAssert(
      (allowNativeRegistration ? exactLeases.length >= 1 : exactLeases.length === 1) &&
        exactLease !== undefined &&
        exactLeases.every(({ attachmentId }) => attachmentId === exactLease.attachmentId) &&
        exactAttachment?.nativeBindingId === bindingIncarnation.nativeBindingId &&
        exactGate?.nativeBindingIncarnationId === bindingIncarnation.nativeBindingIncarnationId &&
        exactGate.attachmentId === exactAttachment.attachmentId,
      "binding incarnation does not have one exact attachment/lease/gate graph",
    );
    assertJournalCount(
      inventory.journal,
      "binding_incarnation_prepared",
      bindingIncarnation.nativeBindingIncarnationId,
      1,
    );
    snapshotAssert(exactLease !== undefined, "binding incarnation attachment lease is absent");
    const bindingEntry = claimJournalFact(
      inventory.journal,
      claimedJournalOffsets,
      {
        entryKind: "binding_incarnation_prepared",
        subjectId: bindingIncarnation.nativeBindingIncarnationId,
        committedAtMs: bindingIncarnation.createdAtMs,
      },
      `binding incarnation ${bindingIncarnation.nativeBindingIncarnationId}`,
    );
    const attachmentEntry = claimJournalFact(
      inventory.journal,
      claimedJournalOffsets,
      {
        entryKind: "attachment_lease_acquired",
        subjectId: exactLease.attachmentLeaseId,
        committedAtMs: exactLease.acquiredAtMs,
        runtimeOwnerServiceLeaseId: exactLease.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: exactLease.runtimeOwnerServiceEpoch,
      },
      `attachment lease ${exactLease.attachmentLeaseId} acquisition`,
    );
    attachmentAcquisitionJournalOffsets.set(
      exactLease.attachmentLeaseId,
      attachmentEntry.journalOffset,
    );
    if (allowNativeRegistration) {
      let previousAcquisitionOffset = attachmentEntry.journalOffset;
      for (const successorLease of exactLeases.slice(1)) {
        const successorEntry = claimJournalFact(
          inventory.journal,
          claimedJournalOffsets,
          {
            entryKind: "attachment_lease_acquired",
            subjectId: successorLease.attachmentLeaseId,
            committedAtMs: successorLease.acquiredAtMs,
            runtimeOwnerServiceLeaseId: successorLease.runtimeOwnerServiceLeaseId,
            runtimeOwnerServiceEpoch: successorLease.runtimeOwnerServiceEpoch,
          },
          `attachment lease ${successorLease.attachmentLeaseId} reacquisition`,
        );
        snapshotAssert(
          successorEntry.journalOffset > previousAcquisitionOffset,
          "transport lease reacquisition does not follow its predecessor",
        );
        assertJournalUsesActiveAssignment(
          successorLease.runtimeId,
          successorLease.nativeIncarnation,
          successorEntry,
          `attachment lease ${successorLease.attachmentLeaseId} reacquisition`,
        );
        attachmentAcquisitionJournalOffsets.set(
          successorLease.attachmentLeaseId,
          successorEntry.journalOffset,
        );
        previousAcquisitionOffset = successorEntry.journalOffset;
      }
    }
    snapshotAssert(
      bindingIncarnation.createdAtMs === exactLease.acquiredAtMs &&
        exactAttachment?.createdAtMs === bindingIncarnation.createdAtMs &&
        bindingEntry.runtimeOwnerServiceLeaseId === attachmentEntry.runtimeOwnerServiceLeaseId &&
        bindingEntry.runtimeOwnerServiceEpoch === attachmentEntry.runtimeOwnerServiceEpoch &&
        bindingEntry.journalOffset < attachmentEntry.journalOffset,
      "binding preparation journals do not share one ordered owner fence/time",
    );
    assertJournalUsesActiveAssignment(
      bindingIncarnation.runtimeId,
      bindingIncarnation.nativeIncarnation,
      bindingEntry,
      `binding incarnation ${bindingIncarnation.nativeBindingIncarnationId}`,
    );
    assertJournalUsesActiveAssignment(
      bindingIncarnation.runtimeId,
      bindingIncarnation.nativeIncarnation,
      attachmentEntry,
      `attachment lease ${exactLease.attachmentLeaseId} acquisition`,
    );
  }
  for (const attachment of inventory.attachments) {
    snapshotAssert(
      bindingsById.has(attachment.nativeBindingId),
      "attachment has no native binding",
    );
    const leases = inventory.attachmentLeases.filter(
      ({ attachmentId }) => attachmentId === attachment.attachmentId,
    );
    snapshotAssert(leases.length > 0, "attachment has no lease history");
    for (const [index, lease] of leases.entries()) {
      snapshotAssert(
        lease.transportEpoch === index + 1,
        "transport lease epochs are not contiguous",
      );
      if (index > 0) {
        const predecessor = leases[index - 1];
        snapshotAssert(
          predecessor !== undefined &&
            predecessor.releasedAtMs !== null &&
            lease.acquiredAtMs >= predecessor.releasedAtMs,
          "transport lease successor predates predecessor release",
        );
      }
    }
    const currentLease = leases.find(({ state }) => state === "current");
    snapshotAssert(
      attachment.state === "current"
        ? currentLease !== undefined &&
            attachment.currentAttachmentLeaseId === currentLease.attachmentLeaseId
        : currentLease === undefined && attachment.currentAttachmentLeaseId === null,
      "attachment current-lease pointer does not match lease history",
    );
  }
  for (const lease of inventory.attachmentLeases) {
    const bindingIncarnation = bindingIncarnationsById.get(lease.nativeBindingIncarnationId);
    snapshotAssert(
      attachmentsById.has(lease.attachmentId) &&
        bindingIncarnation !== undefined &&
        bindingIncarnation.runtimeId === lease.runtimeId &&
        bindingIncarnation.nativeIncarnation === lease.nativeIncarnation,
      "transport lease graph is not closed",
    );
    assertServiceLeaseReference(
      leasesById,
      lease.runtimeOwnerServiceLeaseId,
      lease.runtimeOwnerServiceEpoch,
      lease.acquiredAtMs,
      `transport lease ${lease.attachmentLeaseId}`,
    );
    assertCoordinatorLeaseReference(
      coordinatorLeasesById,
      bindingIncarnation.collaborationServerId,
      lease.coordinatorLeaseId,
      lease.coordinatorEpoch,
      lease.acquiredAtMs,
      `transport lease ${lease.attachmentLeaseId}`,
    );
    assertJournalCount(inventory.journal, "attachment_lease_acquired", lease.attachmentLeaseId, 1);
    assertJournalCount(
      inventory.journal,
      "attachment_detached",
      lease.attachmentLeaseId,
      lease.state === "current" ? 0 : 1,
    );
    if (lease.state !== "current") {
      snapshotAssert(
        lease.releasedAtMs !== null,
        "non-current transport lease has no release time",
      );
      const detachEntry = claimJournalFact(
        inventory.journal,
        claimedJournalOffsets,
        {
          entryKind: "attachment_detached",
          subjectId: lease.attachmentLeaseId,
          committedAtMs: lease.releasedAtMs,
        },
        `attachment lease ${lease.attachmentLeaseId} detach`,
      );
      const acquisitionJournalOffset = attachmentAcquisitionJournalOffsets.get(
        lease.attachmentLeaseId,
      );
      snapshotAssert(
        acquisitionJournalOffset !== undefined &&
          detachEntry.journalOffset > acquisitionJournalOffset,
        "transport lease detach journal does not follow its acquisition",
      );
      if (lease.state === "superseded") {
        const successor = inventory.attachmentLeases.find(
          (candidate) =>
            candidate.attachmentId === lease.attachmentId &&
            candidate.transportEpoch === lease.transportEpoch + 1,
        );
        const successorAcquisitionOffset =
          successor === undefined
            ? undefined
            : attachmentAcquisitionJournalOffsets.get(successor.attachmentLeaseId);
        snapshotAssert(
          successor !== undefined &&
            successorAcquisitionOffset !== undefined &&
            successorAcquisitionOffset > detachEntry.journalOffset,
          "transport lease successor acquisition does not follow predecessor detach",
        );
      }
      assertJournalUsesActiveAssignment(
        lease.runtimeId,
        lease.nativeIncarnation,
        detachEntry,
        `attachment lease ${lease.attachmentLeaseId} detach`,
      );
    }
  }
  for (const gate of inventory.gates) {
    const binding = bindingsById.get(gate.nativeBindingId);
    const bindingIncarnation = bindingIncarnationsById.get(gate.nativeBindingIncarnationId);
    const attachment = attachmentsById.get(gate.attachmentId);
    const gateLeases = inventory.attachmentLeases.filter(
      ({ nativeBindingIncarnationId }) =>
        nativeBindingIncarnationId === gate.nativeBindingIncarnationId,
    );
    const gateLease = gateLeases.at(-1);
    snapshotAssert(
      binding !== undefined &&
        binding.collaborationServerId === gate.collaborationServerId &&
        binding.logicalChatId === gate.logicalChatId &&
        bindingIncarnation !== undefined &&
        bindingIncarnation.nativeBindingId === gate.nativeBindingId &&
        bindingIncarnation.runtimeId === gate.runtimeId &&
        bindingIncarnation.nativeIncarnation === gate.nativeIncarnation &&
        attachment?.nativeBindingId === gate.nativeBindingId,
      "binding lifecycle gate graph is not closed",
    );
    snapshotAssert(
      allowNativeRegistration ||
        gate.phase === "starting" ||
        gate.phase === "recovering" ||
        gate.phase === "closed",
      "A1.3 snapshot contains an A1.4-ready/draining binding gate",
    );
    if (gate.phase === "closed") {
      snapshotAssert(
        gate.currentAttachmentLeaseId === null &&
          bindingIncarnation.state === "closed" &&
          attachment.state === "closed" &&
          (allowNativeRegistration ? gateLeases.length >= 1 : gateLeases.length === 1) &&
          gateLease?.state === "closed" &&
          gateLeases.slice(0, -1).every(({ state }) => state !== "current") &&
          gateLease.releasedAtMs !== null &&
          bindingIncarnation.closedAtMs === gateLease.releasedAtMs &&
          attachment.closedAtMs === gateLease.releasedAtMs &&
          gate.updatedAtMs === gateLease.releasedAtMs,
        "closed binding gate leaves a collaborator resource live",
      );
    } else {
      const lease =
        gate.currentAttachmentLeaseId === null
          ? undefined
          : attachmentLeasesById.get(gate.currentAttachmentLeaseId);
      snapshotAssert(
        lease?.state === "current" &&
          lease.attachmentId === gate.attachmentId &&
          lease.nativeBindingIncarnationId === gate.nativeBindingIncarnationId &&
          bindingIncarnation.state === "current" &&
          attachment.state === "current" &&
          (allowNativeRegistration ? gateLeases.length >= 1 : gateLeases.length === 1) &&
          (allowNativeRegistration
            ? gate.updatedAtMs >= bindingIncarnation.createdAtMs &&
              gate.updatedAtMs >= lease.acquiredAtMs
            : gate.updatedAtMs === bindingIncarnation.createdAtMs) &&
          attachment.createdAtMs === bindingIncarnation.createdAtMs &&
          (allowNativeRegistration
            ? lease.acquiredAtMs >= bindingIncarnation.createdAtMs
            : lease.acquiredAtMs === bindingIncarnation.createdAtMs),
        "live binding gate does not point through an exact live transport graph",
      );
    }
  }
  snapshotAssert(
    claimedJournalOffsets.size === inventory.journal.length,
    "runtime-owner journal contains an unbound durable effect",
  );
  for (const bindingIncarnation of inventory.bindingIncarnations) {
    snapshotAssert(
      gatesByBindingId.has(bindingIncarnation.nativeBindingId),
      "binding incarnation has no lifecycle gate",
    );
  }
  for (const runtime of inventory.runtimes) {
    if (runtime.state === "closed") {
      snapshotAssert(
        !inventory.gates.some(
          (gate) => gate.runtimeId === runtime.runtimeId && gate.phase !== "closed",
        ),
        "closed runtime retains a live binding gate",
      );
    }
  }

  return inventory;
}

const ACQUIRE_KEYS = [
  "candidateLeaseId",
  "ownerInstanceId",
  "ownerProcessStartIdentitySchemaId",
  "ownerProcessStartIdentityRef",
  "ownerProcessStartIdentityDigest",
  "expectedCurrentLeaseId",
  "expectedRuntimeOwnerServiceEpoch",
  "leaseDurationMs",
  "operation",
] as const;

function parseAcquireRequest(value: unknown): AcquireRuntimeOwnerServiceLeaseRequest {
  const row = parseExactRecord(value, ACQUIRE_KEYS, "acquireRuntimeOwnerServiceLease");
  return frozen({
    candidateLeaseId: parseA1SafeId(
      row.candidateLeaseId,
      "acquireRuntimeOwnerServiceLease.candidateLeaseId",
    ),
    ownerInstanceId: parseA1SafeId(
      row.ownerInstanceId,
      "acquireRuntimeOwnerServiceLease.ownerInstanceId",
    ),
    ownerProcessStartIdentitySchemaId: parseNonEmptyString(
      row.ownerProcessStartIdentitySchemaId,
      "acquireRuntimeOwnerServiceLease.ownerProcessStartIdentitySchemaId",
    ),
    ownerProcessStartIdentityRef: parseA1SafeId(
      row.ownerProcessStartIdentityRef,
      "acquireRuntimeOwnerServiceLease.ownerProcessStartIdentityRef",
    ),
    ownerProcessStartIdentityDigest: parseA1Digest(
      row.ownerProcessStartIdentityDigest,
      "acquireRuntimeOwnerServiceLease.ownerProcessStartIdentityDigest",
    ),
    expectedCurrentLeaseId: parseNullable(
      row.expectedCurrentLeaseId,
      parseA1SafeId,
      "acquireRuntimeOwnerServiceLease.expectedCurrentLeaseId",
    ),
    expectedRuntimeOwnerServiceEpoch: parseNonNegativeSafeInteger(
      row.expectedRuntimeOwnerServiceEpoch,
      "acquireRuntimeOwnerServiceLease.expectedRuntimeOwnerServiceEpoch",
    ),
    leaseDurationMs: parsePositiveSafeInteger(
      row.leaseDurationMs,
      "acquireRuntimeOwnerServiceLease.leaseDurationMs",
    ),
    operation: parseOperation(row.operation, "acquireRuntimeOwnerServiceLease.operation"),
  });
}

const RENEW_KEYS = ["fence", "expectedHeartbeatDeadlineMs", "newHeartbeatDeadlineMs"] as const;

function parseRenewRequest(value: unknown): RenewRuntimeOwnerServiceLeaseRequest {
  const row = parseExactRecord(value, RENEW_KEYS, "renewRuntimeOwnerServiceLease");
  const expectedHeartbeatDeadlineMs = parseNonNegativeSafeInteger(
    row.expectedHeartbeatDeadlineMs,
    "renewRuntimeOwnerServiceLease.expectedHeartbeatDeadlineMs",
  );
  const newHeartbeatDeadlineMs = parseNonNegativeSafeInteger(
    row.newHeartbeatDeadlineMs,
    "renewRuntimeOwnerServiceLease.newHeartbeatDeadlineMs",
  );
  if (newHeartbeatDeadlineMs <= expectedHeartbeatDeadlineMs) {
    reject(
      "renewRuntimeOwnerServiceLease.newHeartbeatDeadlineMs",
      "must strictly extend the expected deadline",
    );
  }
  return frozen({
    fence: parseOwnerFence(row.fence, "renewRuntimeOwnerServiceLease.fence"),
    expectedHeartbeatDeadlineMs,
    newHeartbeatDeadlineMs,
  });
}

const RELEASE_KEYS = ["fence", "operation"] as const;

function parseReleaseRequest(value: unknown): ReleaseRuntimeOwnerServiceLeaseRequest {
  const row = parseExactRecord(value, RELEASE_KEYS, "releaseRuntimeOwnerServiceLease");
  return frozen({
    fence: parseOwnerFence(row.fence, "releaseRuntimeOwnerServiceLease.fence"),
    operation: parseOperation(row.operation, "releaseRuntimeOwnerServiceLease.operation"),
  });
}

const REGISTER_RUNTIME_KEYS = [
  "fence",
  "operation",
  "runtimeId",
  "descriptor",
  "wardenLaunchNonce",
  "startIdentitySchemaId",
  "startIdentityRef",
  "startIdentityDigest",
  "runtimeOwnerAssignmentId",
  "key",
] as const;

function parseDescriptor(value: unknown, field: string): NativeEngineDescriptor {
  const row = parseExactRecord(value, ["product", "access"] as const, field);
  const product = parseEnum(
    row.product,
    ["claude-code", "codex", "opencode"] as const,
    `${field}.product`,
  );
  const access = parseEnum(
    row.access,
    ["native-rc", "app-server", "server", "tmux"] as const,
    `${field}.access`,
  );
  if (
    !(
      (product === "claude-code" && (access === "native-rc" || access === "tmux")) ||
      (product === "codex" && access === "app-server") ||
      (product === "opencode" && access === "server")
    )
  ) {
    reject(field, "is not a supported native engine descriptor");
  }
  return frozen({ product, access }) as NativeEngineDescriptor;
}

function parseRegisterRequest(value: unknown): RegisterInitialRuntimeRequest {
  const row = parseExactRecord(value, REGISTER_RUNTIME_KEYS, "registerInitialRuntime");
  return frozen({
    fence: parseOwnerFence(row.fence, "registerInitialRuntime.fence"),
    operation: parseOperation(row.operation, "registerInitialRuntime.operation"),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "registerInitialRuntime.runtimeId",
    ),
    descriptor: parseDescriptor(row.descriptor, "registerInitialRuntime.descriptor"),
    wardenLaunchNonce: parseWardenLaunchNonce(
      row.wardenLaunchNonce,
      "registerInitialRuntime.wardenLaunchNonce",
    ),
    startIdentitySchemaId: parseNonEmptyString(
      row.startIdentitySchemaId,
      "registerInitialRuntime.startIdentitySchemaId",
    ),
    startIdentityRef: parseA1SafeId(
      row.startIdentityRef,
      "registerInitialRuntime.startIdentityRef",
    ),
    startIdentityDigest: parseA1Digest(
      row.startIdentityDigest,
      "registerInitialRuntime.startIdentityDigest",
    ),
    runtimeOwnerAssignmentId: parseA1SafeId(
      row.runtimeOwnerAssignmentId,
      "registerInitialRuntime.runtimeOwnerAssignmentId",
    ),
    key: parseKeyInput(row.key, "registerInitialRuntime.key"),
  });
}

const REASSIGN_KEYS = [
  "fence",
  "operation",
  "runtimeId",
  "nativeIncarnation",
  "expectedRuntimeOwnerAssignmentId",
  "runtimeOwnerAssignmentId",
  "reattachmentEvidenceSchemaId",
  "reattachmentEvidenceRef",
  "reattachmentEvidenceDigest",
] as const;

function parseReassignRequest(value: unknown): ReassignRuntimeOwnerRequest {
  const row = parseExactRecord(value, REASSIGN_KEYS, "reassignRuntimeOwner");
  return frozen({
    fence: parseOwnerFence(row.fence, "reassignRuntimeOwner.fence"),
    operation: parseOperation(row.operation, "reassignRuntimeOwner.operation"),
    runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, "reassignRuntimeOwner.runtimeId"),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "reassignRuntimeOwner.nativeIncarnation",
    ),
    expectedRuntimeOwnerAssignmentId: parseA1SafeId(
      row.expectedRuntimeOwnerAssignmentId,
      "reassignRuntimeOwner.expectedRuntimeOwnerAssignmentId",
    ),
    runtimeOwnerAssignmentId: parseA1SafeId(
      row.runtimeOwnerAssignmentId,
      "reassignRuntimeOwner.runtimeOwnerAssignmentId",
    ),
    reattachmentEvidenceSchemaId: parseNonEmptyString(
      row.reattachmentEvidenceSchemaId,
      "reassignRuntimeOwner.reattachmentEvidenceSchemaId",
    ),
    reattachmentEvidenceRef: parseA1SafeId(
      row.reattachmentEvidenceRef,
      "reassignRuntimeOwner.reattachmentEvidenceRef",
    ),
    reattachmentEvidenceDigest: parseA1Digest(
      row.reattachmentEvidenceDigest,
      "reassignRuntimeOwner.reattachmentEvidenceDigest",
    ),
  });
}

const REPLACE_KEYS = [
  "fence",
  "operation",
  "runtimeId",
  "predecessorNativeIncarnation",
  "expectedRuntimeOwnerAssignmentId",
  "containmentId",
  "containmentEvidenceSchemaId",
  "containmentEvidenceRef",
  "containmentEvidenceDigest",
  "successorStartIdentitySchemaId",
  "successorStartIdentityRef",
  "successorStartIdentityDigest",
  "successorRuntimeOwnerAssignmentId",
] as const;

function parseReplaceRequest(value: unknown): ReplaceRuntimeIncarnationRequest {
  const row = parseExactRecord(value, REPLACE_KEYS, "replaceRuntimeIncarnation");
  return frozen({
    fence: parseOwnerFence(row.fence, "replaceRuntimeIncarnation.fence"),
    operation: parseOperation(row.operation, "replaceRuntimeIncarnation.operation"),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "replaceRuntimeIncarnation.runtimeId",
    ),
    predecessorNativeIncarnation: parsePositiveSafeInteger(
      row.predecessorNativeIncarnation,
      "replaceRuntimeIncarnation.predecessorNativeIncarnation",
    ),
    expectedRuntimeOwnerAssignmentId: parseA1SafeId(
      row.expectedRuntimeOwnerAssignmentId,
      "replaceRuntimeIncarnation.expectedRuntimeOwnerAssignmentId",
    ),
    containmentId: parseA1SafeId(row.containmentId, "replaceRuntimeIncarnation.containmentId"),
    containmentEvidenceSchemaId: parseNonEmptyString(
      row.containmentEvidenceSchemaId,
      "replaceRuntimeIncarnation.containmentEvidenceSchemaId",
    ),
    containmentEvidenceRef: parseA1SafeId(
      row.containmentEvidenceRef,
      "replaceRuntimeIncarnation.containmentEvidenceRef",
    ),
    containmentEvidenceDigest: parseA1Digest(
      row.containmentEvidenceDigest,
      "replaceRuntimeIncarnation.containmentEvidenceDigest",
    ),
    successorStartIdentitySchemaId: parseNonEmptyString(
      row.successorStartIdentitySchemaId,
      "replaceRuntimeIncarnation.successorStartIdentitySchemaId",
    ),
    successorStartIdentityRef: parseA1SafeId(
      row.successorStartIdentityRef,
      "replaceRuntimeIncarnation.successorStartIdentityRef",
    ),
    successorStartIdentityDigest: parseA1Digest(
      row.successorStartIdentityDigest,
      "replaceRuntimeIncarnation.successorStartIdentityDigest",
    ),
    successorRuntimeOwnerAssignmentId: parseA1SafeId(
      row.successorRuntimeOwnerAssignmentId,
      "replaceRuntimeIncarnation.successorRuntimeOwnerAssignmentId",
    ),
  });
}

const TERMINATE_KEYS = [
  "fence",
  "operation",
  "runtimeId",
  "predecessorNativeIncarnation",
  "expectedRuntimeOwnerAssignmentId",
  "containmentId",
  "containmentEvidenceSchemaId",
  "containmentEvidenceRef",
  "containmentEvidenceDigest",
] as const;

function parseTerminateRequest(value: unknown): TerminateRuntimeRequest {
  const row = parseExactRecord(value, TERMINATE_KEYS, "terminateRuntime");
  return frozen({
    fence: parseOwnerFence(row.fence, "terminateRuntime.fence"),
    operation: parseOperation(row.operation, "terminateRuntime.operation"),
    runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, "terminateRuntime.runtimeId"),
    predecessorNativeIncarnation: parsePositiveSafeInteger(
      row.predecessorNativeIncarnation,
      "terminateRuntime.predecessorNativeIncarnation",
    ),
    expectedRuntimeOwnerAssignmentId: parseA1SafeId(
      row.expectedRuntimeOwnerAssignmentId,
      "terminateRuntime.expectedRuntimeOwnerAssignmentId",
    ),
    containmentId: parseA1SafeId(row.containmentId, "terminateRuntime.containmentId"),
    containmentEvidenceSchemaId: parseNonEmptyString(
      row.containmentEvidenceSchemaId,
      "terminateRuntime.containmentEvidenceSchemaId",
    ),
    containmentEvidenceRef: parseA1SafeId(
      row.containmentEvidenceRef,
      "terminateRuntime.containmentEvidenceRef",
    ),
    containmentEvidenceDigest: parseA1Digest(
      row.containmentEvidenceDigest,
      "terminateRuntime.containmentEvidenceDigest",
    ),
  });
}

const TARGET_KEYS = [
  "localNativeConversationId",
  "descriptor",
  "projectId",
  "semanticConversationId",
  "parentLocalNativeConversationId",
  "state",
] as const;

function parseConversationTarget(value: unknown): LocalConversationTargetInput {
  const row = parseExactRecord(value, TARGET_KEYS, "localConversationTransition.target");
  const localNativeConversationId = parseA1SafeId(
    row.localNativeConversationId,
    "localConversationTransition.target.localNativeConversationId",
  );
  const parentLocalNativeConversationId = parseNullable(
    row.parentLocalNativeConversationId,
    parseA1SafeId,
    "localConversationTransition.target.parentLocalNativeConversationId",
  );
  if (localNativeConversationId === parentLocalNativeConversationId) {
    reject(
      "localConversationTransition.target.parentLocalNativeConversationId",
      "must not reference the target itself",
    );
  }
  return frozen({
    localNativeConversationId,
    descriptor: parseDescriptor(row.descriptor, "localConversationTransition.target.descriptor"),
    projectId: parseA1CanonicalId(
      "project",
      row.projectId,
      "localConversationTransition.target.projectId",
    ),
    semanticConversationId: parseNullable(
      row.semanticConversationId,
      parseA1SafeId,
      "localConversationTransition.target.semanticConversationId",
    ),
    parentLocalNativeConversationId,
    state: parseEnum(
      row.state,
      ["unbound", "open", "closed"] as const,
      "localConversationTransition.target.state",
    ),
  });
}

const LOCAL_TRANSITION_KEYS = [
  "fence",
  "operation",
  "runtimeId",
  "nativeIncarnation",
  "localTransitionId",
  "kind",
  "sourceLocalNativeConversationId",
  "target",
  "observedSemanticConversationId",
  "nativeEvidenceSchemaId",
  "nativeEvidenceRef",
  "nativeEvidenceDigest",
] as const;

function parseLocalTransitionRequest(
  value: unknown,
): AppendLocalNativeConversationTransitionRequest {
  const row = parseExactRecord(value, LOCAL_TRANSITION_KEYS, "localConversationTransition");
  return frozen({
    fence: parseOwnerFence(row.fence, "localConversationTransition.fence"),
    operation: parseOperation(row.operation, "localConversationTransition.operation"),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "localConversationTransition.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "localConversationTransition.nativeIncarnation",
    ),
    localTransitionId: parseA1SafeId(
      row.localTransitionId,
      "localConversationTransition.localTransitionId",
    ),
    kind: parseEnum(
      row.kind,
      ["discover", "new", "clear", "fork", "switch", "archive", "unarchive"] as const,
      "localConversationTransition.kind",
    ),
    sourceLocalNativeConversationId: parseNullable(
      row.sourceLocalNativeConversationId,
      parseA1SafeId,
      "localConversationTransition.sourceLocalNativeConversationId",
    ),
    target: parseConversationTarget(row.target),
    observedSemanticConversationId: parseNullable(
      row.observedSemanticConversationId,
      parseA1SafeId,
      "localConversationTransition.observedSemanticConversationId",
    ),
    nativeEvidenceSchemaId: parseNonEmptyString(
      row.nativeEvidenceSchemaId,
      "localConversationTransition.nativeEvidenceSchemaId",
    ),
    nativeEvidenceRef: parseA1SafeId(
      row.nativeEvidenceRef,
      "localConversationTransition.nativeEvidenceRef",
    ),
    nativeEvidenceDigest: parseA1Digest(
      row.nativeEvidenceDigest,
      "localConversationTransition.nativeEvidenceDigest",
    ),
  });
}

const PREPARE_BINDING_KEYS = [
  "fence",
  "coordinatorFence",
  "bindingOperation",
  "attachmentOperation",
  "nativeBindingIncarnationId",
  "collaborationServerId",
  "logicalChatId",
  "nativeBindingId",
  "runtimeId",
  "nativeIncarnation",
  "semanticConversationId",
  "attachmentId",
  "attachmentKind",
  "transportId",
  "attachmentGeneration",
  "attachmentLeaseId",
  "transportEpoch",
  "resourceOwnership",
  "phase",
  "disconnectPolicy",
] as const;

function parsePrepareBindingRequest(value: unknown): PrepareNativeBindingRuntimeRequest {
  const row = parseExactRecord(value, PREPARE_BINDING_KEYS, "prepareNativeBindingRuntime");
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    row.collaborationServerId,
    "prepareNativeBindingRuntime.collaborationServerId",
  );
  const coordinatorFence = parseCoordinatorLeaseFence(row.coordinatorFence);
  if (coordinatorFence.collaborationServerId !== collaborationServerId) {
    reject(
      "prepareNativeBindingRuntime.coordinatorFence.collaborationServerId",
      "must match the binding collaboration server",
    );
  }
  const bindingOperation = parseOperation(
    row.bindingOperation,
    "prepareNativeBindingRuntime.bindingOperation",
  );
  const attachmentOperation = parseOperation(
    row.attachmentOperation,
    "prepareNativeBindingRuntime.attachmentOperation",
  );
  if (bindingOperation.operationId === attachmentOperation.operationId) {
    reject(
      "prepareNativeBindingRuntime.attachmentOperation.operationId",
      "must be distinct from the binding operation ID",
    );
  }
  return frozen({
    fence: parseOwnerFence(row.fence, "prepareNativeBindingRuntime.fence"),
    coordinatorFence,
    bindingOperation,
    attachmentOperation,
    nativeBindingIncarnationId: parseA1SafeId(
      row.nativeBindingIncarnationId,
      "prepareNativeBindingRuntime.nativeBindingIncarnationId",
    ),
    collaborationServerId,
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "prepareNativeBindingRuntime.logicalChatId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "prepareNativeBindingRuntime.nativeBindingId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "prepareNativeBindingRuntime.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "prepareNativeBindingRuntime.nativeIncarnation",
    ),
    semanticConversationId: parseA1SafeId(
      row.semanticConversationId,
      "prepareNativeBindingRuntime.semanticConversationId",
    ),
    attachmentId: parseA1SafeId(row.attachmentId, "prepareNativeBindingRuntime.attachmentId"),
    attachmentKind: parseEnum(
      row.attachmentKind,
      ["claude-inner-rc", "app-server", "server", "tmux"] as const,
      "prepareNativeBindingRuntime.attachmentKind",
    ),
    transportId: parseA1SafeId(row.transportId, "prepareNativeBindingRuntime.transportId"),
    attachmentGeneration: parsePositiveSafeInteger(
      row.attachmentGeneration,
      "prepareNativeBindingRuntime.attachmentGeneration",
    ),
    attachmentLeaseId: parseA1SafeId(
      row.attachmentLeaseId,
      "prepareNativeBindingRuntime.attachmentLeaseId",
    ),
    transportEpoch: parsePositiveSafeInteger(
      row.transportEpoch,
      "prepareNativeBindingRuntime.transportEpoch",
    ),
    resourceOwnership: parseEnum(
      row.resourceOwnership,
      ["dedicated_runtime", "shared_runtime"] as const,
      "prepareNativeBindingRuntime.resourceOwnership",
    ),
    phase: parseEnum(
      row.phase,
      ["starting", "recovering"] as const,
      "prepareNativeBindingRuntime.phase",
    ),
    disconnectPolicy: parseEnum(
      row.disconnectPolicy,
      ["detach", "terminate_when_idle"] as const,
      "prepareNativeBindingRuntime.disconnectPolicy",
    ),
  });
}

const DETACH_KEYS = [
  "fence",
  "coordinatorFence",
  "operation",
  "nativeBindingId",
  "attachmentLeaseId",
  "expectedGateGeneration",
] as const;

function parseDetachRequest(value: unknown): DetachNativeBindingRuntimeRequest {
  const row = parseExactRecord(value, DETACH_KEYS, "detachNativeBindingRuntime");
  return frozen({
    fence: parseOwnerFence(row.fence, "detachNativeBindingRuntime.fence"),
    coordinatorFence: parseCoordinatorLeaseFence(row.coordinatorFence),
    operation: parseOperation(row.operation, "detachNativeBindingRuntime.operation"),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "detachNativeBindingRuntime.nativeBindingId",
    ),
    attachmentLeaseId: parseA1SafeId(
      row.attachmentLeaseId,
      "detachNativeBindingRuntime.attachmentLeaseId",
    ),
    expectedGateGeneration: parsePositiveSafeInteger(
      row.expectedGateGeneration,
      "detachNativeBindingRuntime.expectedGateGeneration",
    ),
  });
}

const ROTATE_KEYS = [
  "fence",
  "operation",
  "runtimeId",
  "expectedRuntimeOwnerIdentityKeyId",
  "expectedKeyGeneration",
  "key",
] as const;

function parseRotateRequest(value: unknown): RotateRuntimeOwnerKeyRequest {
  const row = parseExactRecord(value, ROTATE_KEYS, "rotateRuntimeOwnerKey");
  return frozen({
    fence: parseOwnerFence(row.fence, "rotateRuntimeOwnerKey.fence"),
    operation: parseOperation(row.operation, "rotateRuntimeOwnerKey.operation"),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "rotateRuntimeOwnerKey.runtimeId",
    ),
    expectedRuntimeOwnerIdentityKeyId: parseA1SafeId(
      row.expectedRuntimeOwnerIdentityKeyId,
      "rotateRuntimeOwnerKey.expectedRuntimeOwnerIdentityKeyId",
    ),
    expectedKeyGeneration: parsePositiveSafeInteger(
      row.expectedKeyGeneration,
      "rotateRuntimeOwnerKey.expectedKeyGeneration",
    ),
    key: parseKeyInput(row.key, "rotateRuntimeOwnerKey.key"),
  });
}

const SIGNATURE_SCOPE_KEYS = [
  "fence",
  "runtimeId",
  "runtimeOwnerIdentityKeyId",
  "runtimeOwnerKeyGeneration",
  "signerSequence",
] as const;

interface ParsedSignatureScope {
  readonly fence: RuntimeOwnerServiceFence;
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
}

function parseSignatureScope(row: UnknownRecord, field: string): ParsedSignatureScope {
  return frozen({
    fence: parseOwnerFence(row.fence, `${field}.fence`),
    runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, `${field}.runtimeId`),
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      `${field}.runtimeOwnerIdentityKeyId`,
    ),
    runtimeOwnerKeyGeneration: parsePositiveSafeInteger(
      row.runtimeOwnerKeyGeneration,
      `${field}.runtimeOwnerKeyGeneration`,
    ),
    signerSequence: parseNonNegativeSafeInteger(row.signerSequence, `${field}.signerSequence`),
  });
}

const RESERVE_SIGNATURE_KEYS = [
  "fence",
  "runtimeId",
  "runtimeOwnerIdentityKeyId",
  "runtimeOwnerKeyGeneration",
  "expectedSignerSequence",
  "purpose",
] as const;

function parseReserveSignatureRequest(value: unknown): ReserveRuntimeOwnerSignatureRequest {
  const row = parseExactRecord(value, RESERVE_SIGNATURE_KEYS, "reserveRuntimeOwnerSignature");
  return frozen({
    fence: parseOwnerFence(row.fence, "reserveRuntimeOwnerSignature.fence"),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "reserveRuntimeOwnerSignature.runtimeId",
    ),
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      "reserveRuntimeOwnerSignature.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: parsePositiveSafeInteger(
      row.runtimeOwnerKeyGeneration,
      "reserveRuntimeOwnerSignature.runtimeOwnerKeyGeneration",
    ),
    expectedSignerSequence: parseNonNegativeSafeInteger(
      row.expectedSignerSequence,
      "reserveRuntimeOwnerSignature.expectedSignerSequence",
    ),
    purpose: parseEnum(
      row.purpose,
      RUNTIME_OWNER_SIGNATURE_PURPOSES,
      "reserveRuntimeOwnerSignature.purpose",
    ),
  });
}

const BIND_SIGNATURE_KEYS = [
  ...SIGNATURE_SCOPE_KEYS,
  "canonicalPayloadSchemaId",
  "canonicalPayloadRef",
  "canonicalPayloadDigest",
] as const;

function parseBindSignatureRequest(value: unknown): BindRuntimeOwnerSignatureRequest {
  const row = parseExactRecord(value, BIND_SIGNATURE_KEYS, "bindRuntimeOwnerSignature");
  return frozen({
    ...parseSignatureScope(row, "bindRuntimeOwnerSignature"),
    canonicalPayloadSchemaId: parseNonEmptyString(
      row.canonicalPayloadSchemaId,
      "bindRuntimeOwnerSignature.canonicalPayloadSchemaId",
    ) as RuntimeOwnerSignatureSchemaId,
    canonicalPayloadRef: parseA1SafeId(
      row.canonicalPayloadRef,
      "bindRuntimeOwnerSignature.canonicalPayloadRef",
    ),
    canonicalPayloadDigest: parseA1Digest(
      row.canonicalPayloadDigest,
      "bindRuntimeOwnerSignature.canonicalPayloadDigest",
    ),
  });
}

const STORE_SIGNATURE_KEYS = [
  ...SIGNATURE_SCOPE_KEYS,
  "signedRecordDigest",
  "signature",
  "signedArtifactId",
] as const;

function parseStoreSignatureRequest(value: unknown): StoreRuntimeOwnerSignatureRequest {
  const row = parseExactRecord(value, STORE_SIGNATURE_KEYS, "storeRuntimeOwnerSignature");
  return frozen({
    ...parseSignatureScope(row, "storeRuntimeOwnerSignature"),
    signedRecordDigest: parseA1Digest(
      row.signedRecordDigest,
      "storeRuntimeOwnerSignature.signedRecordDigest",
    ),
    signature: parseEd25519Signature(row.signature, "storeRuntimeOwnerSignature.signature"),
    signedArtifactId: parseA1SafeId(
      row.signedArtifactId,
      "storeRuntimeOwnerSignature.signedArtifactId",
    ),
  });
}

const ACCEPT_SIGNATURE_KEYS = [...SIGNATURE_SCOPE_KEYS, "signedRecordDigest"] as const;

function parseAcceptSignatureRequest(value: unknown): AcceptRuntimeOwnerSignedRecordRequest {
  const row = parseExactRecord(value, ACCEPT_SIGNATURE_KEYS, "acceptRuntimeOwnerSignedRecord");
  return frozen({
    ...parseSignatureScope(row, "acceptRuntimeOwnerSignedRecord"),
    signedRecordDigest: parseA1Digest(
      row.signedRecordDigest,
      "acceptRuntimeOwnerSignedRecord.signedRecordDigest",
    ),
  });
}

function parseAbortSignatureRequest(value: unknown): AbortRuntimeOwnerSignatureRequest {
  const row = parseExactRecord(value, SIGNATURE_SCOPE_KEYS, "abortRuntimeOwnerSignature");
  return parseSignatureScope(row, "abortRuntimeOwnerSignature");
}

function checkedAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result <= left) {
    throw new RuntimeOwnerRepositoryConflictError(`${field} is exhausted`);
  }
  return result;
}

function expectedLeaseEpoch(request: AcquireRuntimeOwnerServiceLeaseRequest): number {
  return checkedIncrement(request.expectedRuntimeOwnerServiceEpoch, "runtime-owner service epoch");
}

function assertAcquisitionMatches(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: AcquireRuntimeOwnerServiceLeaseRequest,
  stored: StoredServiceLease,
): void {
  const lease = stored.lease;
  if (
    lease.machineIdentityId !== machineIdentityId ||
    lease.runtimeOwnerServiceLeaseId !== request.candidateLeaseId ||
    lease.runtimeOwnerServiceEpoch !== expectedLeaseEpoch(request) ||
    lease.ownerInstanceId !== request.ownerInstanceId ||
    lease.ownerProcessStartIdentitySchemaId !== request.ownerProcessStartIdentitySchemaId ||
    lease.ownerProcessStartIdentityRef !== request.ownerProcessStartIdentityRef ||
    !sameDigest(lease.ownerProcessStartIdentityDigest, request.ownerProcessStartIdentityDigest) ||
    stored.initialHeartbeatDeadlineMs - lease.acquiredAtMs !== request.leaseDurationMs
  ) {
    throw new RuntimeOwnerRepositoryConflictError("service-lease acquisition intent collided");
  }
  if (request.expectedCurrentLeaseId !== null) {
    const predecessor =
      findServiceLease(transaction, request.expectedCurrentLeaseId)?.lease ?? null;
    if (
      predecessor === null ||
      predecessor.machineIdentityId !== machineIdentityId ||
      predecessor.runtimeOwnerServiceEpoch !== request.expectedRuntimeOwnerServiceEpoch ||
      lease.acquiredAtMs < predecessor.heartbeatDeadlineMs
    ) {
      throw new RuntimeOwnerRepositoryConflictError(
        "service-lease takeover predecessor does not match",
      );
    }
    return;
  }
  if (request.expectedRuntimeOwnerServiceEpoch > 0) {
    const row = sqlGet(
      transaction,
      `SELECT ${selectColumns(SERVICE_LEASE_ROW_KEYS)} FROM runtime_owner_service_leases
       WHERE machine_identity_id = ? AND runtime_owner_service_epoch = ? LIMIT 1`,
      [machineIdentityId, request.expectedRuntimeOwnerServiceEpoch],
    );
    const predecessor = row === undefined ? null : storedServiceLeaseFromRow(row).lease;
    if (
      predecessor === null ||
      predecessor.state !== "released" ||
      predecessor.releasedAtMs === null ||
      lease.acquiredAtMs < predecessor.releasedAtMs
    ) {
      throw new RuntimeOwnerRepositoryConflictError(
        "null-pointer service-lease predecessor does not match",
      );
    }
  }
}

function acquisitionResult(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: AcquireRuntimeOwnerServiceLeaseRequest,
  stored: StoredServiceLease,
  nowMs: number,
  replayed: boolean,
): AcquireRuntimeOwnerServiceLeaseResult {
  assertAcquisitionMatches(transaction, machineIdentityId, request, stored);
  const journalEntry = findOperation(transaction, request.operation.operationId);
  if (journalEntry === null) {
    throw new RuntimeOwnerRepositoryPersistenceError(
      "service-lease acquisition has no journal entry",
    );
  }
  assertExactOperation(
    journalEntry,
    request.operation,
    "service_lease_acquired",
    "service_lease",
    request.candidateLeaseId,
  );
  if (
    journalEntry.runtimeOwnerServiceLeaseId !== stored.lease.runtimeOwnerServiceLeaseId ||
    journalEntry.runtimeOwnerServiceEpoch !== stored.lease.runtimeOwnerServiceEpoch
  ) {
    throw new RuntimeOwnerRepositoryPersistenceError(
      "service-lease acquisition journal fence is invalid",
    );
  }
  const owner = findOwnerState(transaction);
  const isCurrent =
    owner.currentRuntimeOwnerServiceLeaseId === stored.lease.runtimeOwnerServiceLeaseId &&
    owner.currentRuntimeOwnerServiceEpoch === stored.lease.runtimeOwnerServiceEpoch &&
    stored.lease.state === "current" &&
    stored.lease.releasedAtMs === null;
  return frozen({
    lease: stored.lease,
    journalEntry,
    replayed,
    isCurrent,
    unexpired:
      stored.lease.state === "current" &&
      stored.lease.releasedAtMs === null &&
      stored.lease.acquiredAtMs <= nowMs &&
      nowMs < stored.lease.heartbeatDeadlineMs,
  });
}

function assertSigningHandleAvailable(
  transaction: HostStateRepositorySqlTransaction,
  protectedHandleId: ProtectedHandleId,
): void {
  if (
    sqlGet(
      transaction,
      `SELECT protected_handle_id FROM protected_artifacts
       WHERE protected_handle_id = ? LIMIT 1`,
      [protectedHandleId],
    ) !== undefined ||
    sqlGet(
      transaction,
      `SELECT protected_handle_id FROM runtime_owner_private_keys
       WHERE protected_handle_id = ? LIMIT 1`,
      [protectedHandleId],
    ) !== undefined
  ) {
    throw new RuntimeOwnerRepositoryConflictError("protected signing-key handle is occupied");
  }
}

function insertIdentityKeyAndEnvelope(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  keyGeneration: number,
  key: RuntimeOwnerKeyMaterialInput,
  createdAtMs: number,
): Readonly<{
  identityKey: RuntimeOwnerIdentityKeyRecord;
  privateKey: RuntimeOwnerPrivateKeyEnvelopeRecord;
}> {
  assertSigningHandleAvailable(transaction, key.signingKeyRef.protectedHandleId);
  const identityKey = parseRuntimeOwnerIdentityKeyRecord({
    runtimeId,
    runtimeOwnerIdentityKeyId: key.runtimeOwnerIdentityKeyId,
    keyGeneration,
    algorithm: "Ed25519",
    publicKey: key.publicKey,
    signingKeyRef: key.signingKeyRef,
    nextSignerSequence: 0,
    localTrustEvidenceRef: key.localTrustEvidenceRef,
    localTrustEvidenceDigest: key.localTrustEvidenceDigest,
    state: "current",
  });
  const privateKey = frozen({
    signingKeyRef: key.signingKeyRef,
    runtimeId,
    runtimeOwnerIdentityKeyId: key.runtimeOwnerIdentityKeyId,
    keyGeneration,
    wrappingSchemaId: RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
    wrapNonce: key.wrapNonce,
    wrappedPkcs8: key.wrappedPkcs8,
    authTag: key.authTag,
    pkcs8Digest: key.pkcs8Digest,
    createdAtMs,
    destroyedAtMs: null,
    state: "current" as const,
  });
  runExactlyOne(
    transaction,
    `INSERT INTO runtime_owner_identity_keys (
       runtime_owner_identity_key_id, runtime_id, key_generation, algorithm, public_key,
       signing_key_protected_handle_id, next_signer_sequence,
       local_trust_evidence_ref, local_trust_evidence_digest, state
     ) VALUES (?, ?, ?, 'Ed25519', ?, ?, 0, ?, ?, 'current')`,
    [
      identityKey.runtimeOwnerIdentityKeyId,
      identityKey.runtimeId,
      identityKey.keyGeneration,
      identityKey.publicKey,
      identityKey.signingKeyRef?.protectedHandleId ?? null,
      identityKey.localTrustEvidenceRef,
      identityKey.localTrustEvidenceDigest,
    ],
    "runtime-owner identity-key insert",
  );
  runExactlyOne(
    transaction,
    `INSERT INTO runtime_owner_private_keys (
       protected_handle_id, runtime_id, runtime_owner_identity_key_id, key_generation,
       wrapping_schema_id, wrap_nonce, wrapped_pkcs8, auth_tag, pkcs8_digest,
       created_at_ms, destroyed_at_ms, state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'current')`,
    [
      privateKey.signingKeyRef.protectedHandleId,
      privateKey.runtimeId,
      privateKey.runtimeOwnerIdentityKeyId,
      privateKey.keyGeneration,
      privateKey.wrappingSchemaId,
      privateKey.wrapNonce.copyBytes(),
      privateKey.wrappedPkcs8.copyBytes(),
      privateKey.authTag.copyBytes(),
      privateKey.pkcs8Digest,
      privateKey.createdAtMs,
    ],
    "runtime-owner private-key insert",
  );
  return frozen({ identityKey, privateKey });
}

function loadRegistrationResult(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  operationId: A1SafeId,
  replayed: boolean,
): RuntimeRegistrationResult | null {
  const storedRuntime = findRuntime(transaction, runtimeId);
  if (storedRuntime === null) return null;
  const incarnation = findIncarnation(transaction, runtimeId, 1);
  const assignmentRow = sqlGet(
    transaction,
    `SELECT ${selectColumns(ASSIGNMENT_ROW_KEYS)} FROM runtime_owner_assignments
     WHERE runtime_id = ? AND native_incarnation = 1 AND assignment_generation = 1 LIMIT 1`,
    [runtimeId],
  );
  const identityKeyRow = sqlGet(
    transaction,
    `SELECT ${selectColumns(IDENTITY_KEY_ROW_KEYS)} FROM runtime_owner_identity_keys
     WHERE runtime_id = ? AND key_generation = 1 LIMIT 1`,
    [runtimeId],
  );
  const assignment = assignmentRow === undefined ? null : assignmentFromRow(assignmentRow);
  const identityKey = identityKeyRow === undefined ? null : identityKeyFromRow(identityKeyRow);
  const privateKeyRow =
    identityKey === null
      ? undefined
      : sqlGet(
          transaction,
          `SELECT ${selectColumns(PRIVATE_KEY_ROW_KEYS)} FROM runtime_owner_private_keys
           WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
             AND key_generation = 1 LIMIT 1`,
          [runtimeId, identityKey.runtimeOwnerIdentityKeyId],
        );
  const privateKey = privateKeyRow === undefined ? null : privateKeyFromRow(privateKeyRow);
  const journalEntry = findOperation(transaction, operationId);
  if (
    incarnation === null ||
    assignment === null ||
    identityKey === null ||
    privateKey === null ||
    journalEntry === null
  ) {
    throw new RuntimeOwnerRepositoryPersistenceError("runtime registration graph is incomplete");
  }
  return frozen({
    runtime: storedRuntime.runtime,
    incarnation,
    assignment,
    identityKey,
    privateKey,
    journalEntry,
    replayed,
  });
}

function registrationMatches(
  result: RuntimeRegistrationResult,
  request: RegisterInitialRuntimeRequest,
): boolean {
  return (
    result.runtime.runtimeId === request.runtimeId &&
    sameDescriptor(result.runtime.descriptor, request.descriptor) &&
    result.runtime.wardenLaunchNonce === request.wardenLaunchNonce &&
    result.runtime.initialStartIdentitySchemaId === request.startIdentitySchemaId &&
    result.runtime.initialStartIdentityRef === request.startIdentityRef &&
    sameDigest(result.runtime.initialStartIdentityDigest, request.startIdentityDigest) &&
    result.incarnation.nativeIncarnation === 1 &&
    result.incarnation.startIdentitySchemaId === request.startIdentitySchemaId &&
    result.incarnation.startIdentityRef === request.startIdentityRef &&
    sameDigest(result.incarnation.startIdentityDigest, request.startIdentityDigest) &&
    result.assignment.runtimeOwnerAssignmentId === request.runtimeOwnerAssignmentId &&
    result.assignment.assignmentEvidenceSchemaId === request.startIdentitySchemaId &&
    result.assignment.assignmentEvidenceRef === request.startIdentityRef &&
    sameDigest(result.assignment.assignmentEvidenceDigest, request.startIdentityDigest) &&
    result.identityKey.runtimeOwnerIdentityKeyId === request.key.runtimeOwnerIdentityKeyId &&
    result.identityKey.publicKey === request.key.publicKey &&
    result.privateKey.signingKeyRef.protectedHandleId ===
      request.key.signingKeyRef.protectedHandleId &&
    result.identityKey.localTrustEvidenceRef === request.key.localTrustEvidenceRef &&
    sameDigest(result.identityKey.localTrustEvidenceDigest, request.key.localTrustEvidenceDigest) &&
    sameBytes(result.privateKey.wrapNonce, request.key.wrapNonce) &&
    sameBytes(result.privateKey.wrappedPkcs8, request.key.wrappedPkcs8) &&
    sameBytes(result.privateKey.authTag, request.key.authTag) &&
    sameDigest(result.privateKey.pkcs8Digest, request.key.pkcs8Digest)
  );
}

class RuntimeOwnerRepository implements RuntimeOwnerRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #nowMs: () => number;
  readonly #terminalRootFinalizationScope: TerminalRootSignatureFinalizationScope | null;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    nowMs: () => number = Date.now,
    terminalRootFinalizationScope: TerminalRootSignatureFinalizationScope | null = null,
  ) {
    if (
      typeof executor !== "object" ||
      executor === null ||
      typeof executor.transaction !== "function"
    ) {
      throw new HostStateContractError(
        "runtime-owner repository executor must provide transaction",
      );
    }
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#nowMs = nowMs;
    this.#terminalRootFinalizationScope = terminalRootFinalizationScope;
  }

  acquireServiceLease(
    request: AcquireRuntimeOwnerServiceLeaseRequest,
  ): AcquireRuntimeOwnerServiceLeaseResult {
    const parsed = parseAcquireRequest(request);
    return this.#executor.transaction((transaction) => {
      const now = trustedNow(this.#nowMs);
      const existing = findServiceLease(transaction, parsed.candidateLeaseId);
      if (existing !== null) {
        return acquisitionResult(transaction, this.#machineIdentityId, parsed, existing, now, true);
      }
      const occupiedOperation = findOperation(transaction, parsed.operation.operationId);
      if (occupiedOperation !== null) {
        throw new RuntimeOwnerRepositoryConflictError("acquisition operation ID is occupied");
      }
      const owner = findOwnerState(transaction);
      if (
        owner.machineIdentityId !== this.#machineIdentityId ||
        owner.currentRuntimeOwnerServiceEpoch !== parsed.expectedRuntimeOwnerServiceEpoch ||
        owner.currentRuntimeOwnerServiceLeaseId !== parsed.expectedCurrentLeaseId
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "runtime-owner service pointer compare-and-swap failed",
        );
      }
      if (parsed.expectedCurrentLeaseId !== null) {
        const predecessor = findServiceLease(transaction, parsed.expectedCurrentLeaseId)?.lease;
        if (
          predecessor === undefined ||
          predecessor.machineIdentityId !== this.#machineIdentityId ||
          predecessor.runtimeOwnerServiceEpoch !== parsed.expectedRuntimeOwnerServiceEpoch ||
          now < predecessor.acquiredAtMs ||
          now < predecessor.heartbeatDeadlineMs
        ) {
          throw new RuntimeOwnerRepositoryConflictError(
            "the current runtime owner is not positively expired",
          );
        }
      } else if (parsed.expectedRuntimeOwnerServiceEpoch > 0) {
        const predecessorRow = sqlGet(
          transaction,
          `SELECT ${selectColumns(SERVICE_LEASE_ROW_KEYS)} FROM runtime_owner_service_leases
           WHERE machine_identity_id = ? AND runtime_owner_service_epoch = ? LIMIT 1`,
          [this.#machineIdentityId, parsed.expectedRuntimeOwnerServiceEpoch],
        );
        const predecessor =
          predecessorRow === undefined ? null : storedServiceLeaseFromRow(predecessorRow).lease;
        if (
          predecessor === null ||
          predecessor.state !== "released" ||
          predecessor.releasedAtMs === null ||
          now < predecessor.releasedAtMs
        ) {
          throw new RuntimeOwnerRepositoryConflictError(
            "released predecessor is missing or clock moved backwards",
          );
        }
      }
      const epoch = expectedLeaseEpoch(parsed);
      const deadline = checkedAdd(now, parsed.leaseDurationMs, "service-lease deadline");
      const lease = parseRuntimeOwnerServiceLeaseRecord({
        runtimeOwnerServiceLeaseId: parsed.candidateLeaseId,
        machineIdentityId: this.#machineIdentityId,
        runtimeOwnerServiceEpoch: epoch,
        ownerInstanceId: parsed.ownerInstanceId,
        ownerProcessStartIdentitySchemaId: parsed.ownerProcessStartIdentitySchemaId,
        ownerProcessStartIdentityRef: parsed.ownerProcessStartIdentityRef,
        ownerProcessStartIdentityDigest: parsed.ownerProcessStartIdentityDigest,
        acquiredAtMs: now,
        heartbeatDeadlineMs: deadline,
        releasedAtMs: null,
        state: "current",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO runtime_owner_service_leases (
           runtime_owner_service_lease_id, machine_identity_id, runtime_owner_service_epoch,
           owner_instance_id, owner_process_start_identity_schema_id,
           owner_process_start_identity_ref, owner_process_start_identity_digest,
           acquired_at_ms, initial_heartbeat_deadline_ms, heartbeat_deadline_ms,
           released_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'current')`,
        [
          lease.runtimeOwnerServiceLeaseId,
          lease.machineIdentityId,
          lease.runtimeOwnerServiceEpoch,
          lease.ownerInstanceId,
          lease.ownerProcessStartIdentitySchemaId,
          lease.ownerProcessStartIdentityRef,
          lease.ownerProcessStartIdentityDigest,
          lease.acquiredAtMs,
          lease.heartbeatDeadlineMs,
          lease.heartbeatDeadlineMs,
        ],
        "runtime-owner service-lease insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_state
         SET current_runtime_owner_service_epoch = ?,
             current_runtime_owner_service_lease_id = ?
         WHERE singleton = 1 AND machine_identity_id = ?
           AND current_runtime_owner_service_epoch = ?
           AND current_runtime_owner_service_lease_id IS ?`,
        [
          epoch,
          lease.runtimeOwnerServiceLeaseId,
          this.#machineIdentityId,
          parsed.expectedRuntimeOwnerServiceEpoch,
          parsed.expectedCurrentLeaseId,
        ],
        "runtime-owner service pointer compare-and-swap",
      );
      const newFence = frozen({
        runtimeOwnerServiceLeaseId: lease.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: lease.runtimeOwnerServiceEpoch,
        ownerInstanceId: lease.ownerInstanceId,
        ownerProcessStartIdentitySchemaId: lease.ownerProcessStartIdentitySchemaId,
        ownerProcessStartIdentityRef: lease.ownerProcessStartIdentityRef,
        ownerProcessStartIdentityDigest: lease.ownerProcessStartIdentityDigest,
      });
      const journalEntry = appendJournal(
        transaction,
        owner,
        newFence,
        now,
        parsed.operation,
        "service_lease_acquired",
        "service_lease",
        lease.runtimeOwnerServiceLeaseId,
      );
      return frozen({
        lease,
        journalEntry,
        replayed: false,
        isCurrent: true,
        unexpired: true,
      });
    });
  }

  rotateIdentityKey(request: RotateRuntimeOwnerKeyRequest): RotateRuntimeOwnerKeyResult {
    const parsed = parseRotateRequest(request);
    return this.#executor.transaction((transaction) => {
      const replayEntry = findOperation(transaction, parsed.operation.operationId);
      const nextGeneration = checkedIncrement(
        parsed.expectedKeyGeneration,
        "runtime-owner key generation",
      );
      if (replayEntry !== null) {
        assertExactOperation(
          replayEntry,
          parsed.operation,
          "runtime_key_rotated",
          "runtime_owner_identity_key",
          parsed.key.runtimeOwnerIdentityKeyId,
        );
        const previousIdentityKey = findIdentityKey(
          transaction,
          parsed.expectedRuntimeOwnerIdentityKeyId,
        );
        const identityKey = findIdentityKey(transaction, parsed.key.runtimeOwnerIdentityKeyId);
        const previousPrivateKeyRow = sqlGet(
          transaction,
          `SELECT ${selectColumns(PRIVATE_KEY_ROW_KEYS)} FROM runtime_owner_private_keys
           WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
             AND key_generation = ? LIMIT 1`,
          [
            parsed.runtimeId,
            parsed.expectedRuntimeOwnerIdentityKeyId,
            parsed.expectedKeyGeneration,
          ],
        );
        const privateKey = findPrivateKey(transaction, parsed.key.signingKeyRef.protectedHandleId);
        if (
          previousIdentityKey === null ||
          identityKey === null ||
          previousPrivateKeyRow === undefined ||
          privateKey === null ||
          previousIdentityKey.state !== "retired" ||
          identityKey.runtimeId !== parsed.runtimeId ||
          identityKey.keyGeneration !== nextGeneration ||
          identityKey.publicKey !== parsed.key.publicKey ||
          identityKey.signingKeyRef?.protectedHandleId !==
            parsed.key.signingKeyRef.protectedHandleId ||
          identityKey.localTrustEvidenceRef !== parsed.key.localTrustEvidenceRef ||
          !sameDigest(identityKey.localTrustEvidenceDigest, parsed.key.localTrustEvidenceDigest) ||
          privateKey.runtimeOwnerIdentityKeyId !== parsed.key.runtimeOwnerIdentityKeyId ||
          !sameBytes(privateKey.wrapNonce, parsed.key.wrapNonce) ||
          !sameBytes(privateKey.wrappedPkcs8, parsed.key.wrappedPkcs8) ||
          !sameBytes(privateKey.authTag, parsed.key.authTag) ||
          !sameDigest(privateKey.pkcs8Digest, parsed.key.pkcs8Digest)
        ) {
          throw new RuntimeOwnerRepositoryConflictError("identity-key rotation intent collided");
        }
        return frozen({
          previousIdentityKey,
          previousPrivateKey: privateKeyFromRow(previousPrivateKeyRow),
          identityKey,
          privateKey,
          journalEntry: replayEntry,
          replayed: true,
        });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      const storedRuntime = findRuntime(transaction, parsed.runtimeId);
      const previousIdentityKey = findIdentityKey(
        transaction,
        parsed.expectedRuntimeOwnerIdentityKeyId,
      );
      if (
        storedRuntime === null ||
        storedRuntime.runtime.state !== "current" ||
        !runtimeIsAssignedToFence(transaction, storedRuntime, parsed.fence) ||
        previousIdentityKey === null ||
        previousIdentityKey.runtimeId !== parsed.runtimeId ||
        previousIdentityKey.keyGeneration !== parsed.expectedKeyGeneration ||
        previousIdentityKey.state !== "current" ||
        previousIdentityKey.signingKeyRef === null
      ) {
        throw new RuntimeOwnerRepositoryConflictError("current identity-key fence does not match");
      }
      const previousPrivateKey = findPrivateKey(
        transaction,
        previousIdentityKey.signingKeyRef.protectedHandleId,
      );
      if (previousPrivateKey === null || previousPrivateKey.state !== "current") {
        throw new RuntimeOwnerRepositoryPersistenceError(
          "current identity key has no current custody envelope",
        );
      }
      if (
        sqlGet(
          transaction,
          `SELECT signer_sequence FROM runtime_owner_signature_reservations
           WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
             AND runtime_owner_key_generation = ? AND state IN ('reserved', 'bound') LIMIT 1`,
          [
            parsed.runtimeId,
            parsed.expectedRuntimeOwnerIdentityKeyId,
            parsed.expectedKeyGeneration,
          ],
        ) !== undefined
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "identity key has an unfinished signature reservation",
        );
      }
      if (findIdentityKey(transaction, parsed.key.runtimeOwnerIdentityKeyId) !== null) {
        throw new RuntimeOwnerRepositoryConflictError("successor identity-key ID is occupied");
      }
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_private_keys
         SET destroyed_at_ms = ?, state = 'destroyed'
         WHERE protected_handle_id = ? AND runtime_id = ?
           AND runtime_owner_identity_key_id = ? AND key_generation = ?
           AND state = 'current' AND destroyed_at_ms IS NULL`,
        [
          current.nowMs,
          previousPrivateKey.signingKeyRef.protectedHandleId,
          parsed.runtimeId,
          previousIdentityKey.runtimeOwnerIdentityKeyId,
          previousIdentityKey.keyGeneration,
        ],
        "previous runtime-owner private-key destruction",
      );
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_identity_keys
         SET signing_key_protected_handle_id = NULL, state = 'retired'
         WHERE runtime_owner_identity_key_id = ? AND runtime_id = ?
           AND key_generation = ? AND state = 'current'
           AND signing_key_protected_handle_id = ?`,
        [
          previousIdentityKey.runtimeOwnerIdentityKeyId,
          parsed.runtimeId,
          parsed.expectedKeyGeneration,
          previousIdentityKey.signingKeyRef.protectedHandleId,
        ],
        "previous runtime-owner identity-key retirement",
      );
      const { identityKey, privateKey } = insertIdentityKeyAndEnvelope(
        transaction,
        parsed.runtimeId,
        nextGeneration,
        parsed.key,
        current.nowMs,
      );
      const retiredIdentityKey = parseRuntimeOwnerIdentityKeyRecord({
        ...previousIdentityKey,
        signingKeyRef: null,
        state: "retired",
      });
      const destroyedPrivateKey = frozen({
        ...previousPrivateKey,
        destroyedAtMs: current.nowMs,
        state: "destroyed" as const,
      });
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "runtime_key_rotated",
        "runtime_owner_identity_key",
        identityKey.runtimeOwnerIdentityKeyId,
      );
      return frozen({
        previousIdentityKey: retiredIdentityKey,
        previousPrivateKey: destroyedPrivateKey,
        identityKey,
        privateKey,
        journalEntry,
        replayed: false,
      });
    });
  }

  reserveSignature(
    request: ReserveRuntimeOwnerSignatureRequest,
  ): RuntimeOwnerSignatureMutationResult {
    const parsed = parseReserveSignatureRequest(request);
    return this.#executor.transaction((transaction) => {
      assertCurrentOwner(transaction, this.#machineIdentityId, parsed.fence, this.#nowMs);
      const existing = findSignature(
        transaction,
        parsed.runtimeId,
        parsed.runtimeOwnerIdentityKeyId,
        parsed.runtimeOwnerKeyGeneration,
        parsed.expectedSignerSequence,
      );
      if (existing !== null) {
        if (existing.purpose !== parsed.purpose) {
          throw new RuntimeOwnerRepositoryConflictError("signer sequence intent collided");
        }
        return frozen({ reservation: existing, replayed: true });
      }
      const identityKey = findIdentityKey(transaction, parsed.runtimeOwnerIdentityKeyId);
      const storedRuntime = findRuntime(transaction, parsed.runtimeId);
      if (
        !runtimeIsAssignedToFence(transaction, storedRuntime, parsed.fence) ||
        identityKey === null ||
        identityKey.runtimeId !== parsed.runtimeId ||
        identityKey.keyGeneration !== parsed.runtimeOwnerKeyGeneration ||
        identityKey.state !== "current" ||
        identityKey.signingKeyRef === null ||
        identityKey.nextSignerSequence !== parsed.expectedSignerSequence
      ) {
        throw new RuntimeOwnerRepositoryConflictError("current signing-key counter fence failed");
      }
      if (parsed.expectedSignerSequence >= Number.MAX_SAFE_INTEGER) {
        throw new RuntimeOwnerRepositoryConflictError("signer sequence is exhausted");
      }
      const reservation = parseRuntimeOwnerSignatureReservationRecord({
        runtimeId: parsed.runtimeId,
        runtimeOwnerIdentityKeyId: parsed.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: parsed.runtimeOwnerKeyGeneration,
        signerSequence: parsed.expectedSignerSequence,
        purpose: parsed.purpose,
        canonicalPayloadSchemaId: null,
        canonicalPayloadRef: null,
        canonicalPayloadDigest: null,
        signedRecordDigest: null,
        signature: null,
        signedArtifactId: null,
        state: "reserved",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO runtime_owner_signature_reservations (
           runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
           signer_sequence, purpose, canonical_payload_schema_id, canonical_payload_ref,
           canonical_payload_digest, signed_record_digest, signature, signed_artifact_id, state
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'reserved')`,
        [
          reservation.runtimeId,
          reservation.runtimeOwnerIdentityKeyId,
          reservation.runtimeOwnerKeyGeneration,
          reservation.signerSequence,
          reservation.purpose,
        ],
        "runtime-owner signature reservation insert",
      );
      return frozen({ reservation, replayed: false });
    });
  }

  bindSignature(request: BindRuntimeOwnerSignatureRequest): RuntimeOwnerSignatureMutationResult {
    const parsed = parseBindSignatureRequest(request);
    return this.#executor.transaction((transaction) => {
      assertCurrentOwner(transaction, this.#machineIdentityId, parsed.fence, this.#nowMs);
      if (
        !runtimeIsAssignedToFence(
          transaction,
          findRuntime(transaction, parsed.runtimeId),
          parsed.fence,
        )
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "signature runtime is not assigned to the current owner",
        );
      }
      const existing = findSignature(
        transaction,
        parsed.runtimeId,
        parsed.runtimeOwnerIdentityKeyId,
        parsed.runtimeOwnerKeyGeneration,
        parsed.signerSequence,
      );
      if (existing === null) {
        throw new RuntimeOwnerRepositoryConflictError("signature reservation is unknown");
      }
      if (existing.state === "bound" || existing.state === "signed") {
        if (
          existing.canonicalPayloadSchemaId !== parsed.canonicalPayloadSchemaId ||
          existing.canonicalPayloadRef !== parsed.canonicalPayloadRef ||
          existing.canonicalPayloadDigest === null ||
          !sameDigest(existing.canonicalPayloadDigest, parsed.canonicalPayloadDigest)
        ) {
          throw new RuntimeOwnerRepositoryConflictError("bound signature payload collided");
        }
        return frozen({ reservation: existing, replayed: true });
      }
      if (existing.state !== "reserved") {
        throw new RuntimeOwnerRepositoryConflictError("signature reservation is not bindable");
      }
      const bound = parseRuntimeOwnerSignatureReservationRecord({
        ...existing,
        canonicalPayloadSchemaId: parsed.canonicalPayloadSchemaId,
        canonicalPayloadRef: parsed.canonicalPayloadRef,
        canonicalPayloadDigest: parsed.canonicalPayloadDigest,
        state: "bound",
      });
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_signature_reservations
         SET canonical_payload_schema_id = ?, canonical_payload_ref = ?,
             canonical_payload_digest = ?, state = 'bound'
         WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
           AND runtime_owner_key_generation = ? AND signer_sequence = ?
           AND state = 'reserved'`,
        [
          bound.canonicalPayloadSchemaId,
          bound.canonicalPayloadRef,
          bound.canonicalPayloadDigest,
          bound.runtimeId,
          bound.runtimeOwnerIdentityKeyId,
          bound.runtimeOwnerKeyGeneration,
          bound.signerSequence,
        ],
        "runtime-owner signature payload bind",
      );
      return frozen({ reservation: bound, replayed: false });
    });
  }

  storeSignedRecord(
    request: StoreRuntimeOwnerSignatureRequest,
  ): RuntimeOwnerSignatureMutationResult {
    const parsed = parseStoreSignatureRequest(request);
    return this.#executor.transaction((transaction) => {
      assertCurrentOwner(transaction, this.#machineIdentityId, parsed.fence, this.#nowMs);
      if (
        !runtimeIsAssignedToFence(
          transaction,
          findRuntime(transaction, parsed.runtimeId),
          parsed.fence,
        )
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "signature runtime is not assigned to the current owner",
        );
      }
      const existing = findSignature(
        transaction,
        parsed.runtimeId,
        parsed.runtimeOwnerIdentityKeyId,
        parsed.runtimeOwnerKeyGeneration,
        parsed.signerSequence,
      );
      if (existing === null) {
        throw new RuntimeOwnerRepositoryConflictError("signature reservation is unknown");
      }
      assertSignedRecordMutationBoundary(
        transaction,
        existing,
        this.#terminalRootFinalizationScope,
        parsed.fence,
        parsed.signedArtifactId,
      );
      if (existing.state === "signed") {
        if (
          existing.signedRecordDigest === null ||
          !sameDigest(existing.signedRecordDigest, parsed.signedRecordDigest) ||
          existing.signature !== parsed.signature ||
          existing.signedArtifactId !== parsed.signedArtifactId
        ) {
          throw new RuntimeOwnerRepositoryConflictError("signed record facts collided");
        }
        return frozen({ reservation: existing, replayed: true });
      }
      if (existing.state !== "bound") {
        throw new RuntimeOwnerRepositoryConflictError("signature reservation is not bound");
      }
      const duplicateSignedRecord = sqlGet(
        transaction,
        `SELECT runtime_id, runtime_owner_identity_key_id,
                runtime_owner_key_generation, signer_sequence
         FROM runtime_owner_signature_reservations
         WHERE signed_record_digest = ? LIMIT 1`,
        [parsed.signedRecordDigest],
      );
      if (duplicateSignedRecord !== undefined) {
        throw new RuntimeOwnerRepositoryConflictError(
          "signed record digest is already stored under another signer tuple",
        );
      }
      const signed = parseRuntimeOwnerSignatureReservationRecord({
        ...existing,
        signedRecordDigest: parsed.signedRecordDigest,
        signature: parsed.signature,
        signedArtifactId: parsed.signedArtifactId,
        state: "signed",
      });
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_signature_reservations
         SET signed_record_digest = ?, signature = ?, signed_artifact_id = ?, state = 'signed'
         WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
           AND runtime_owner_key_generation = ? AND signer_sequence = ? AND state = 'bound'`,
        [
          signed.signedRecordDigest,
          signed.signature,
          signed.signedArtifactId,
          signed.runtimeId,
          signed.runtimeOwnerIdentityKeyId,
          signed.runtimeOwnerKeyGeneration,
          signed.signerSequence,
        ],
        "runtime-owner signed-record store",
      );
      return frozen({ reservation: signed, replayed: false });
    });
  }

  acceptSignedRecord(
    request: AcceptRuntimeOwnerSignedRecordRequest,
  ): RuntimeOwnerSignedRecordAcceptanceResult {
    const parsed = parseAcceptSignatureRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      if (
        !runtimeIsAssignedToFence(
          transaction,
          findRuntime(transaction, parsed.runtimeId),
          parsed.fence,
        )
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "signature runtime is not assigned to the current owner",
        );
      }
      const reservation = findSignature(
        transaction,
        parsed.runtimeId,
        parsed.runtimeOwnerIdentityKeyId,
        parsed.runtimeOwnerKeyGeneration,
        parsed.signerSequence,
      );
      if (reservation === null) {
        throw new RuntimeOwnerRepositoryConflictError("signature reservation is unknown");
      }
      assertSignedRecordMutationBoundary(
        transaction,
        reservation,
        this.#terminalRootFinalizationScope,
        parsed.fence,
      );
      const existing = findAcceptance(
        transaction,
        parsed.runtimeId,
        parsed.runtimeOwnerIdentityKeyId,
        parsed.runtimeOwnerKeyGeneration,
        parsed.signerSequence,
      );
      if (existing !== null) {
        if (!sameDigest(existing.signedRecordDigest, parsed.signedRecordDigest)) {
          throw new RuntimeOwnerRepositoryConflictError("signed-record acceptance collided");
        }
        return frozen({ acceptance: existing, replayed: true });
      }
      const duplicateDigest = sqlGet(
        transaction,
        `SELECT signer_sequence FROM runtime_owner_signed_record_acceptances
         WHERE signed_record_digest = ? LIMIT 1`,
        [parsed.signedRecordDigest],
      );
      if (duplicateDigest !== undefined) {
        throw new RuntimeOwnerRepositoryConflictError(
          "signed record digest is already accepted under another signer tuple",
        );
      }
      if (
        reservation.state !== "signed" ||
        reservation.signedRecordDigest === null ||
        !sameDigest(reservation.signedRecordDigest, parsed.signedRecordDigest)
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "signed-record reservation does not match acceptance",
        );
      }
      const acceptance = parseRuntimeOwnerSignedRecordAcceptanceRecord({
        runtimeId: parsed.runtimeId,
        runtimeOwnerIdentityKeyId: parsed.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: parsed.runtimeOwnerKeyGeneration,
        signerSequence: parsed.signerSequence,
        signedRecordDigest: parsed.signedRecordDigest,
        acceptedAtMs: current.nowMs,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO runtime_owner_signed_record_acceptances (
           runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
           signer_sequence, signed_record_digest, accepted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          acceptance.runtimeId,
          acceptance.runtimeOwnerIdentityKeyId,
          acceptance.runtimeOwnerKeyGeneration,
          acceptance.signerSequence,
          acceptance.signedRecordDigest,
          acceptance.acceptedAtMs,
        ],
        "runtime-owner signed-record acceptance",
      );
      return frozen({ acceptance, replayed: false });
    });
  }

  abortSignature(request: AbortRuntimeOwnerSignatureRequest): RuntimeOwnerSignatureMutationResult {
    const parsed = parseAbortSignatureRequest(request);
    return this.#executor.transaction((transaction) => {
      assertCurrentOwner(transaction, this.#machineIdentityId, parsed.fence, this.#nowMs);
      if (
        !runtimeIsAssignedToFence(
          transaction,
          findRuntime(transaction, parsed.runtimeId),
          parsed.fence,
        )
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "signature runtime is not assigned to the current owner",
        );
      }
      const existing = findSignature(
        transaction,
        parsed.runtimeId,
        parsed.runtimeOwnerIdentityKeyId,
        parsed.runtimeOwnerKeyGeneration,
        parsed.signerSequence,
      );
      if (existing === null) {
        throw new RuntimeOwnerRepositoryConflictError("signature reservation is unknown");
      }
      assertSignedRecordMutationBoundary(
        transaction,
        existing,
        this.#terminalRootFinalizationScope,
        parsed.fence,
      );
      if (existing.state === "aborted") {
        return frozen({ reservation: existing, replayed: true });
      }
      if (existing.state !== "reserved") {
        throw new RuntimeOwnerRepositoryConflictError("only an unbound reservation can be aborted");
      }
      const aborted = parseRuntimeOwnerSignatureReservationRecord({
        ...existing,
        state: "aborted",
      });
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_signature_reservations SET state = 'aborted'
         WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
           AND runtime_owner_key_generation = ? AND signer_sequence = ?
           AND state = 'reserved'`,
        [
          parsed.runtimeId,
          parsed.runtimeOwnerIdentityKeyId,
          parsed.runtimeOwnerKeyGeneration,
          parsed.signerSequence,
        ],
        "runtime-owner signature reservation abort",
      );
      return frozen({ reservation: aborted, replayed: false });
    });
  }

  readOperation(operationId: A1SafeId): RuntimeOwnerJournalEntry | null {
    const parsed = parseA1SafeId(operationId, "runtimeOwnerRepository.readOperation.operationId");
    return this.#executor.transaction((transaction) => findOperation(transaction, parsed));
  }

  readRuntime(runtimeId: NativeRuntimeId): RuntimeRegistrationResult | null {
    const parsed = parseA1CanonicalId(
      "nativeRuntime",
      runtimeId,
      "runtimeOwnerRepository.readRuntime.runtimeId",
    );
    return this.#executor.transaction((transaction) => {
      const journalRow = sqlGet(
        transaction,
        `SELECT ${selectColumns(OWNER_JOURNAL_ROW_KEYS)} FROM runtime_owner_journal_entries
         WHERE entry_kind = 'runtime_registered' AND subject_id = ? LIMIT 1`,
        [parsed],
      );
      if (journalRow === undefined) {
        if (findRuntime(transaction, parsed) !== null) {
          throw new RuntimeOwnerRepositoryPersistenceError(
            "native runtime has no registration journal entry",
          );
        }
        return null;
      }
      const entry = journalFromRow(journalRow);
      return loadRegistrationResult(transaction, parsed, entry.operationId, true);
    });
  }

  readInventory(): RuntimeOwnerInventory {
    return this.#executor.transaction((transaction) => readInventoryTransaction(transaction));
  }

  prepareBindingRuntime(
    request: PrepareNativeBindingRuntimeRequest,
  ): PrepareNativeBindingRuntimeResult {
    const parsed = parsePrepareBindingRequest(request);
    return this.#executor.transaction((transaction) => {
      const bindingEntry = findOperation(transaction, parsed.bindingOperation.operationId);
      const attachmentEntry = findOperation(transaction, parsed.attachmentOperation.operationId);
      if (bindingEntry !== null || attachmentEntry !== null) {
        if (bindingEntry === null || attachmentEntry === null) {
          throw new RuntimeOwnerRepositoryPersistenceError(
            "prepared binding transaction has only one journal entry",
          );
        }
        assertExactOperation(
          bindingEntry,
          parsed.bindingOperation,
          "binding_incarnation_prepared",
          "native_binding_incarnation",
          parsed.nativeBindingIncarnationId,
        );
        assertExactOperation(
          attachmentEntry,
          parsed.attachmentOperation,
          "attachment_lease_acquired",
          "native_transport_lease",
          parsed.attachmentLeaseId,
        );
        const bindingIncarnation = findBindingIncarnation(
          transaction,
          parsed.nativeBindingIncarnationId,
        );
        const attachment = findAttachment(transaction, parsed.attachmentId);
        const attachmentLease = findAttachmentLease(transaction, parsed.attachmentLeaseId);
        const gate = findGate(transaction, parsed.nativeBindingId);
        if (
          bindingIncarnation === null ||
          attachment === null ||
          attachmentLease === null ||
          gate === null ||
          bindingIncarnation.collaborationServerId !== parsed.collaborationServerId ||
          bindingIncarnation.logicalChatId !== parsed.logicalChatId ||
          bindingIncarnation.nativeBindingId !== parsed.nativeBindingId ||
          bindingIncarnation.runtimeId !== parsed.runtimeId ||
          bindingIncarnation.nativeIncarnation !== parsed.nativeIncarnation ||
          bindingIncarnation.semanticConversationId !== parsed.semanticConversationId ||
          attachment.nativeBindingId !== parsed.nativeBindingId ||
          attachment.kind !== parsed.attachmentKind ||
          attachment.transportId !== parsed.transportId ||
          attachment.generation !== parsed.attachmentGeneration ||
          attachment.resourceOwnership !== parsed.resourceOwnership ||
          attachmentLease.attachmentId !== parsed.attachmentId ||
          attachmentLease.transportEpoch !== parsed.transportEpoch ||
          gate.nativeBindingIncarnationId !== parsed.nativeBindingIncarnationId ||
          gate.phase !== parsed.phase ||
          gate.disconnectPolicy !== parsed.disconnectPolicy
        ) {
          throw new RuntimeOwnerRepositoryConflictError("prepared binding runtime intent collided");
        }
        return frozen({
          bindingIncarnation,
          attachment,
          attachmentLease,
          gate,
          bindingJournalEntry: bindingEntry,
          attachmentJournalEntry: attachmentEntry,
          replayed: true,
        });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      assertCurrentCoordinator(transaction, parsed.coordinatorFence, current.nowMs);
      const storedRuntime = findRuntime(transaction, parsed.runtimeId);
      const incarnation = findIncarnation(transaction, parsed.runtimeId, parsed.nativeIncarnation);
      const assignment =
        storedRuntime?.runtime.currentRuntimeOwnerAssignmentId === null || storedRuntime === null
          ? null
          : findAssignment(transaction, storedRuntime.runtime.currentRuntimeOwnerAssignmentId);
      if (
        storedRuntime === null ||
        storedRuntime.runtime.state !== "current" ||
        storedRuntime.runtime.currentNativeIncarnation !== parsed.nativeIncarnation ||
        incarnation === null ||
        incarnation.state === "closed" ||
        assignment === null ||
        assignment.runtimeOwnerServiceLeaseId !== parsed.fence.runtimeOwnerServiceLeaseId ||
        assignment.runtimeOwnerServiceEpoch !== parsed.fence.runtimeOwnerServiceEpoch
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "binding runtime is not assigned to the current owner",
        );
      }
      const bindingKeys = [
        "collaboration_server_id",
        "logical_chat_id",
        "native_binding_id",
        "descriptor_product",
        "descriptor_access",
        "project_id",
        "semantic_conversation_id",
        "current_binding_incarnation_id",
        "state",
      ] as const;
      const bindingValue = sqlGet(
        transaction,
        `SELECT ${selectColumns(bindingKeys)} FROM native_bindings
         WHERE collaboration_server_id = ? AND logical_chat_id = ?
           AND native_binding_id = ? LIMIT 1`,
        [parsed.collaborationServerId, parsed.logicalChatId, parsed.nativeBindingId],
      );
      if (bindingValue === undefined) {
        throw new RuntimeOwnerRepositoryConflictError("native binding is unknown");
      }
      const binding = rawRow(bindingValue, bindingKeys, "preparedNativeBinding");
      if (
        binding.descriptor_product !== storedRuntime.runtime.descriptor.product ||
        binding.descriptor_access !== storedRuntime.runtime.descriptor.access ||
        binding.semantic_conversation_id !== null ||
        binding.current_binding_incarnation_id !== null ||
        binding.state !== "starting"
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "A1.2 native binding is not dormant and unactivated",
        );
      }
      const conversationValue = sqlGet(
        transaction,
        `SELECT local_native_conversation_id, descriptor_product, descriptor_access,
                project_id, state
         FROM local_native_conversations
         WHERE runtime_id = ? AND native_incarnation = ?
           AND semantic_conversation_id = ? LIMIT 1`,
        [parsed.runtimeId, parsed.nativeIncarnation, parsed.semanticConversationId],
      );
      if (conversationValue === undefined) {
        throw new RuntimeOwnerRepositoryConflictError(
          "binding semantic conversation is not in the runtime-local registry",
        );
      }
      const conversation = rawRow(
        conversationValue,
        [
          "local_native_conversation_id",
          "descriptor_product",
          "descriptor_access",
          "project_id",
          "state",
        ] as const,
        "preparedLocalNativeConversation",
      );
      if (
        conversation.descriptor_product !== binding.descriptor_product ||
        conversation.descriptor_access !== binding.descriptor_access ||
        conversation.project_id !== binding.project_id ||
        conversation.state !== "open"
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "binding semantic conversation does not match the binding project and descriptor",
        );
      }
      const expectedAttachmentKind =
        storedRuntime.runtime.descriptor.product === "claude-code"
          ? storedRuntime.runtime.descriptor.access === "tmux"
            ? "tmux"
            : "claude-inner-rc"
          : storedRuntime.runtime.descriptor.product === "codex"
            ? "app-server"
            : "server";
      if (parsed.attachmentKind !== expectedAttachmentKind) {
        throw new RuntimeOwnerRepositoryConflictError(
          "transport attachment kind does not match the runtime descriptor",
        );
      }
      if (
        findBindingIncarnation(transaction, parsed.nativeBindingIncarnationId) !== null ||
        findAttachment(transaction, parsed.attachmentId) !== null ||
        findAttachmentLease(transaction, parsed.attachmentLeaseId) !== null
      ) {
        throw new RuntimeOwnerRepositoryConflictError("binding runtime identity is occupied");
      }
      const previousAttachmentValue = sqlGet(
        transaction,
        `SELECT ${selectColumns(ATTACHMENT_ROW_KEYS)} FROM native_transport_attachments
         WHERE native_binding_id = ? ORDER BY generation DESC LIMIT 1`,
        [parsed.nativeBindingId],
      );
      const previousAttachment =
        previousAttachmentValue === undefined ? null : attachmentFromRow(previousAttachmentValue);
      const expectedAttachmentGeneration =
        previousAttachment === null
          ? 1
          : checkedIncrement(previousAttachment.generation, "attachment generation");
      if (
        parsed.attachmentGeneration !== expectedAttachmentGeneration ||
        (previousAttachment !== null && previousAttachment.state !== "closed") ||
        parsed.transportEpoch !== 1
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "attachment generation or initial transport epoch is not the next value",
        );
      }
      const previousGate = findGate(transaction, parsed.nativeBindingId);
      if (previousGate !== null && previousGate.phase !== "closed") {
        throw new RuntimeOwnerRepositoryConflictError("binding already has a live lifecycle gate");
      }
      const gateGeneration =
        previousGate === null
          ? 1
          : checkedIncrement(previousGate.gateGeneration, "binding gate generation");
      const bindingIncarnation = parseNativeBindingIncarnationRecord({
        nativeBindingIncarnationId: parsed.nativeBindingIncarnationId,
        collaborationServerId: parsed.collaborationServerId,
        logicalChatId: parsed.logicalChatId,
        nativeBindingId: parsed.nativeBindingId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: parsed.nativeIncarnation,
        semanticConversationId: parsed.semanticConversationId,
        createdAtMs: current.nowMs,
        closedAtMs: null,
        state: "current",
      });
      const attachment = parseNativeTransportAttachmentRecord({
        attachmentId: parsed.attachmentId,
        nativeBindingId: parsed.nativeBindingId,
        kind: parsed.attachmentKind,
        transportId: parsed.transportId,
        generation: parsed.attachmentGeneration,
        currentAttachmentLeaseId: parsed.attachmentLeaseId,
        resourceOwnership: parsed.resourceOwnership,
        createdAtMs: current.nowMs,
        closedAtMs: null,
        state: "current",
      });
      const attachmentLease = parseNativeTransportLeaseRecord({
        attachmentLeaseId: parsed.attachmentLeaseId,
        attachmentId: parsed.attachmentId,
        nativeBindingIncarnationId: parsed.nativeBindingIncarnationId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: parsed.nativeIncarnation,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        coordinatorLeaseId: parsed.coordinatorFence.coordinatorLeaseId,
        coordinatorEpoch: parsed.coordinatorFence.coordinatorEpoch,
        transportEpoch: parsed.transportEpoch,
        currentCapabilitySnapshotId: null,
        currentNativeClientIngressLeaseId: null,
        acquiredAtMs: current.nowMs,
        releasedAtMs: null,
        state: "current",
      });
      const gate = parseNativeBindingRuntimeGateRecord({
        collaborationServerId: parsed.collaborationServerId,
        logicalChatId: parsed.logicalChatId,
        nativeBindingId: parsed.nativeBindingId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: parsed.nativeIncarnation,
        nativeBindingIncarnationId: parsed.nativeBindingIncarnationId,
        attachmentId: parsed.attachmentId,
        currentAttachmentLeaseId: parsed.attachmentLeaseId,
        phase: parsed.phase,
        disconnectPolicy: parsed.disconnectPolicy,
        gateGeneration,
        updatedAtMs: current.nowMs,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO native_binding_incarnations (
           native_binding_incarnation_id, collaboration_server_id, logical_chat_id,
           native_binding_id, runtime_id, native_incarnation, semantic_conversation_id,
           created_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'current')`,
        [
          bindingIncarnation.nativeBindingIncarnationId,
          bindingIncarnation.collaborationServerId,
          bindingIncarnation.logicalChatId,
          bindingIncarnation.nativeBindingId,
          bindingIncarnation.runtimeId,
          bindingIncarnation.nativeIncarnation,
          bindingIncarnation.semanticConversationId,
          bindingIncarnation.createdAtMs,
        ],
        "native binding incarnation prepare",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO native_transport_attachments (
           attachment_id, native_binding_id, kind, transport_id, generation,
           current_attachment_lease_id, resource_ownership,
           created_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'current')`,
        [
          attachment.attachmentId,
          attachment.nativeBindingId,
          attachment.kind,
          attachment.transportId,
          attachment.generation,
          attachment.currentAttachmentLeaseId,
          attachment.resourceOwnership,
          attachment.createdAtMs,
        ],
        "native transport attachment prepare",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO native_transport_leases (
           attachment_lease_id, attachment_id, native_binding_incarnation_id,
           runtime_id, native_incarnation, runtime_owner_service_lease_id,
           runtime_owner_service_epoch, coordinator_lease_id, coordinator_epoch,
           transport_epoch, current_capability_snapshot_id,
           current_native_client_ingress_lease_id, acquired_at_ms, released_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 'current')`,
        [
          attachmentLease.attachmentLeaseId,
          attachmentLease.attachmentId,
          attachmentLease.nativeBindingIncarnationId,
          attachmentLease.runtimeId,
          attachmentLease.nativeIncarnation,
          attachmentLease.runtimeOwnerServiceLeaseId,
          attachmentLease.runtimeOwnerServiceEpoch,
          attachmentLease.coordinatorLeaseId,
          attachmentLease.coordinatorEpoch,
          attachmentLease.transportEpoch,
          attachmentLease.acquiredAtMs,
        ],
        "native transport lease acquire",
      );
      if (previousGate === null) {
        runExactlyOne(
          transaction,
          `INSERT INTO binding_lifecycle_gates (
             native_binding_id, collaboration_server_id, logical_chat_id, runtime_id,
             native_incarnation, native_binding_incarnation_id, attachment_id,
             current_attachment_lease_id, phase, disconnect_policy,
             gate_generation, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gate.nativeBindingId,
            gate.collaborationServerId,
            gate.logicalChatId,
            gate.runtimeId,
            gate.nativeIncarnation,
            gate.nativeBindingIncarnationId,
            gate.attachmentId,
            gate.currentAttachmentLeaseId,
            gate.phase,
            gate.disconnectPolicy,
            gate.gateGeneration,
            gate.updatedAtMs,
          ],
          "binding lifecycle gate prepare",
        );
      } else {
        runExactlyOne(
          transaction,
          `UPDATE binding_lifecycle_gates
           SET runtime_id = ?, native_incarnation = ?, native_binding_incarnation_id = ?,
               attachment_id = ?, current_attachment_lease_id = ?, phase = ?,
               disconnect_policy = ?, gate_generation = ?, updated_at_ms = ?
           WHERE native_binding_id = ? AND phase = 'closed' AND gate_generation = ?`,
          [
            gate.runtimeId,
            gate.nativeIncarnation,
            gate.nativeBindingIncarnationId,
            gate.attachmentId,
            gate.currentAttachmentLeaseId,
            gate.phase,
            gate.disconnectPolicy,
            gate.gateGeneration,
            gate.updatedAtMs,
            gate.nativeBindingId,
            previousGate.gateGeneration,
          ],
          "binding lifecycle gate recovery prepare",
        );
      }
      const bindingJournalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.bindingOperation,
        "binding_incarnation_prepared",
        "native_binding_incarnation",
        parsed.nativeBindingIncarnationId,
      );
      const attachmentJournalEntry = appendJournal(
        transaction,
        findOwnerState(transaction),
        parsed.fence,
        current.nowMs,
        parsed.attachmentOperation,
        "attachment_lease_acquired",
        "native_transport_lease",
        parsed.attachmentLeaseId,
      );
      return frozen({
        bindingIncarnation,
        attachment,
        attachmentLease,
        gate,
        bindingJournalEntry,
        attachmentJournalEntry,
        replayed: false,
      });
    });
  }

  detachBindingRuntime(
    request: DetachNativeBindingRuntimeRequest,
  ): DetachNativeBindingRuntimeResult {
    const parsed = parseDetachRequest(request);
    return this.#executor.transaction((transaction) => {
      const replayEntry = findOperation(transaction, parsed.operation.operationId);
      const existingLease = findAttachmentLease(transaction, parsed.attachmentLeaseId);
      if (replayEntry !== null) {
        assertExactOperation(
          replayEntry,
          parsed.operation,
          "attachment_detached",
          "native_transport_lease",
          parsed.attachmentLeaseId,
        );
        if (existingLease === null || existingLease.state === "current") {
          throw new RuntimeOwnerRepositoryPersistenceError("detached lease is still current");
        }
        const bindingIncarnation = findBindingIncarnation(
          transaction,
          existingLease.nativeBindingIncarnationId,
        );
        const attachment = findAttachment(transaction, existingLease.attachmentId);
        const gate = findGate(transaction, parsed.nativeBindingId);
        const storedRuntime = findRuntime(transaction, existingLease.runtimeId);
        if (
          bindingIncarnation === null ||
          attachment === null ||
          gate === null ||
          storedRuntime === null ||
          gate.phase !== "closed" ||
          gate.currentAttachmentLeaseId !== null ||
          gate.gateGeneration !== parsed.expectedGateGeneration + 1 ||
          attachment.state !== "closed" ||
          bindingIncarnation.state !== "closed"
        ) {
          throw new RuntimeOwnerRepositoryPersistenceError("detached binding graph is incomplete");
        }
        return frozen({
          runtime: storedRuntime.runtime,
          bindingIncarnation,
          attachment,
          attachmentLease: existingLease,
          gate,
          journalEntry: replayEntry,
          replayed: true,
        });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      assertCurrentCoordinator(transaction, parsed.coordinatorFence, current.nowMs);
      const gate = findGate(transaction, parsed.nativeBindingId);
      if (
        gate === null ||
        gate.gateGeneration !== parsed.expectedGateGeneration ||
        gate.currentAttachmentLeaseId !== parsed.attachmentLeaseId ||
        gate.collaborationServerId !== parsed.coordinatorFence.collaborationServerId ||
        (gate.phase !== "starting" && gate.phase !== "recovering")
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "binding detach lifecycle gate compare-and-swap failed",
        );
      }
      const attachmentLease = existingLease;
      const attachment = findAttachment(transaction, gate.attachmentId);
      const bindingIncarnation = findBindingIncarnation(
        transaction,
        gate.nativeBindingIncarnationId,
      );
      const storedRuntime = findRuntime(transaction, gate.runtimeId);
      if (
        attachmentLease === null ||
        attachmentLease.state !== "current" ||
        attachmentLease.attachmentId !== gate.attachmentId ||
        attachmentLease.nativeBindingIncarnationId !== gate.nativeBindingIncarnationId ||
        attachmentLease.runtimeOwnerServiceLeaseId !== parsed.fence.runtimeOwnerServiceLeaseId ||
        attachmentLease.runtimeOwnerServiceEpoch !== parsed.fence.runtimeOwnerServiceEpoch ||
        attachmentLease.coordinatorLeaseId !== parsed.coordinatorFence.coordinatorLeaseId ||
        attachmentLease.coordinatorEpoch !== parsed.coordinatorFence.coordinatorEpoch ||
        attachment === null ||
        attachment.state !== "current" ||
        attachment.currentAttachmentLeaseId !== parsed.attachmentLeaseId ||
        bindingIncarnation === null ||
        bindingIncarnation.state !== "current" ||
        storedRuntime === null ||
        storedRuntime.runtime.state !== "current"
      ) {
        throw new RuntimeOwnerRepositoryConflictError("binding detach graph is not current");
      }
      assertNoRetainedRegistrationForBindingGraph(
        transaction,
        bindingIncarnation.nativeBindingIncarnationId,
        attachmentLease.attachmentLeaseId,
      );
      runExactlyOne(
        transaction,
        `UPDATE native_transport_leases
         SET released_at_ms = ?, state = 'closed'
         WHERE attachment_lease_id = ? AND state = 'current' AND released_at_ms IS NULL
           AND runtime_owner_service_lease_id = ? AND runtime_owner_service_epoch = ?
           AND coordinator_lease_id = ? AND coordinator_epoch = ?`,
        [
          current.nowMs,
          parsed.attachmentLeaseId,
          parsed.fence.runtimeOwnerServiceLeaseId,
          parsed.fence.runtimeOwnerServiceEpoch,
          parsed.coordinatorFence.coordinatorLeaseId,
          parsed.coordinatorFence.coordinatorEpoch,
        ],
        "native transport lease detach",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_transport_attachments
         SET current_attachment_lease_id = NULL, closed_at_ms = ?, state = 'closed'
         WHERE attachment_id = ? AND native_binding_id = ?
           AND current_attachment_lease_id = ? AND state = 'current'`,
        [current.nowMs, attachment.attachmentId, parsed.nativeBindingId, parsed.attachmentLeaseId],
        "native transport attachment detach",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_binding_incarnations
         SET closed_at_ms = ?, state = 'closed'
         WHERE native_binding_incarnation_id = ? AND state = 'current'`,
        [current.nowMs, bindingIncarnation.nativeBindingIncarnationId],
        "native binding incarnation detach",
      );
      const nextGateGeneration = checkedIncrement(gate.gateGeneration, "binding gate generation");
      runExactlyOne(
        transaction,
        `UPDATE binding_lifecycle_gates
         SET current_attachment_lease_id = NULL, phase = 'closed',
             gate_generation = ?, updated_at_ms = ?
         WHERE native_binding_id = ? AND gate_generation = ?
           AND current_attachment_lease_id = ? AND phase IN ('starting', 'recovering')`,
        [
          nextGateGeneration,
          current.nowMs,
          parsed.nativeBindingId,
          gate.gateGeneration,
          parsed.attachmentLeaseId,
        ],
        "binding lifecycle gate detach",
      );
      const closedLease = parseNativeTransportLeaseRecord({
        ...attachmentLease,
        releasedAtMs: current.nowMs,
        state: "closed",
      });
      const closedAttachment = parseNativeTransportAttachmentRecord({
        ...attachment,
        currentAttachmentLeaseId: null,
        closedAtMs: current.nowMs,
        state: "closed",
      });
      const closedBinding = parseNativeBindingIncarnationRecord({
        ...bindingIncarnation,
        closedAtMs: current.nowMs,
        state: "closed",
      });
      const closedGate = parseNativeBindingRuntimeGateRecord({
        ...gate,
        currentAttachmentLeaseId: null,
        phase: "closed",
        gateGeneration: nextGateGeneration,
        updatedAtMs: current.nowMs,
      });
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "attachment_detached",
        "native_transport_lease",
        parsed.attachmentLeaseId,
      );
      const reloadedRuntime = findRuntime(transaction, gate.runtimeId);
      if (
        reloadedRuntime === null ||
        reloadedRuntime.runtime.currentNativeIncarnation !==
          storedRuntime.runtime.currentNativeIncarnation ||
        reloadedRuntime.runtime.currentRuntimeOwnerAssignmentId !==
          storedRuntime.runtime.currentRuntimeOwnerAssignmentId ||
        reloadedRuntime.runtime.state !== "current"
      ) {
        throw new RuntimeOwnerRepositoryPersistenceError("detach changed native runtime ownership");
      }
      return frozen({
        runtime: reloadedRuntime.runtime,
        bindingIncarnation: closedBinding,
        attachment: closedAttachment,
        attachmentLease: closedLease,
        gate: closedGate,
        journalEntry,
        replayed: false,
      });
    });
  }

  terminateRuntime(request: TerminateRuntimeRequest): TerminateRuntimeResult {
    const parsed = parseTerminateRequest(request);
    return this.#executor.transaction((transaction) => {
      const replayEntry = findOperation(transaction, parsed.operation.operationId);
      if (replayEntry !== null) {
        assertExactOperation(
          replayEntry,
          parsed.operation,
          "runtime_terminated",
          "native_runtime",
          parsed.runtimeId,
        );
        const storedRuntime = findRuntime(transaction, parsed.runtimeId);
        const predecessor = findIncarnation(
          transaction,
          parsed.runtimeId,
          parsed.predecessorNativeIncarnation,
        );
        const containment = findContainment(transaction, parsed.containmentId);
        if (
          storedRuntime === null ||
          storedRuntime.runtime.state !== "closed" ||
          predecessor === null ||
          containment === null ||
          containment.kind !== "termination" ||
          containment.runtimeId !== parsed.runtimeId ||
          containment.predecessorNativeIncarnation !== parsed.predecessorNativeIncarnation ||
          containment.evidenceSchemaId !== parsed.containmentEvidenceSchemaId ||
          containment.evidenceRef !== parsed.containmentEvidenceRef ||
          !sameDigest(containment.evidenceDigest, parsed.containmentEvidenceDigest)
        ) {
          throw new RuntimeOwnerRepositoryConflictError("runtime termination intent collided");
        }
        return frozen({
          runtime: storedRuntime.runtime,
          predecessor,
          containment,
          journalEntry: replayEntry,
          replayed: true,
        });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      const storedRuntime = findRuntime(transaction, parsed.runtimeId);
      const predecessor = findIncarnation(
        transaction,
        parsed.runtimeId,
        parsed.predecessorNativeIncarnation,
      );
      if (
        storedRuntime === null ||
        storedRuntime.runtime.state !== "current" ||
        !runtimeIsAssignedToFence(transaction, storedRuntime, parsed.fence) ||
        storedRuntime.runtime.currentNativeIncarnation !== parsed.predecessorNativeIncarnation ||
        storedRuntime.runtime.currentRuntimeOwnerAssignmentId !==
          parsed.expectedRuntimeOwnerAssignmentId ||
        predecessor === null ||
        predecessor.state === "closed"
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "runtime termination predecessor is not current",
        );
      }
      assertNoRetainedRegistrationForRuntimeIncarnation(
        transaction,
        parsed.runtimeId,
        parsed.predecessorNativeIncarnation,
      );
      const liveGate = sqlGet(
        transaction,
        `SELECT native_binding_id FROM binding_lifecycle_gates
         WHERE runtime_id = ? AND native_incarnation = ? AND phase <> 'closed' LIMIT 1`,
        [parsed.runtimeId, parsed.predecessorNativeIncarnation],
      );
      if (liveGate !== undefined) {
        throw new RuntimeOwnerRepositoryConflictError(
          "runtime termination requires zero live binding gates",
        );
      }
      if (findContainment(transaction, parsed.containmentId) !== null) {
        throw new RuntimeOwnerRepositoryConflictError("runtime containment ID is occupied");
      }
      const containment = parseNativeRuntimeContainmentRecord({
        nativeRuntimeContainmentId: parsed.containmentId,
        runtimeId: parsed.runtimeId,
        predecessorNativeIncarnation: parsed.predecessorNativeIncarnation,
        successorNativeIncarnation: null,
        kind: "termination",
        evidenceSchemaId: parsed.containmentEvidenceSchemaId,
        evidenceRef: parsed.containmentEvidenceRef,
        evidenceDigest: parsed.containmentEvidenceDigest,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        containedAtMs: current.nowMs,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO native_runtime_containments (
           native_runtime_containment_id, runtime_id, predecessor_native_incarnation,
           successor_native_incarnation, kind, evidence_schema_id,
           evidence_ref, evidence_digest,
           runtime_owner_service_lease_id, runtime_owner_service_epoch, contained_at_ms
         ) VALUES (?, ?, ?, NULL, 'termination', ?, ?, ?, ?, ?, ?)`,
        [
          containment.nativeRuntimeContainmentId,
          containment.runtimeId,
          containment.predecessorNativeIncarnation,
          containment.evidenceSchemaId,
          containment.evidenceRef,
          containment.evidenceDigest,
          containment.runtimeOwnerServiceLeaseId,
          containment.runtimeOwnerServiceEpoch,
          containment.containedAtMs,
        ],
        "native runtime termination containment insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_runtime_incarnations
         SET closed_at_ms = ?, state = 'closed'
         WHERE runtime_id = ? AND native_incarnation = ?
           AND state <> 'closed' AND closed_at_ms IS NULL`,
        [current.nowMs, parsed.runtimeId, parsed.predecessorNativeIncarnation],
        "terminated native incarnation close",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_runtimes
         SET current_native_incarnation = NULL,
             current_runtime_owner_assignment_id = NULL,
             closed_at_ms = ?, state = 'closed'
         WHERE runtime_id = ? AND state = 'current'
           AND current_native_incarnation = ?
           AND current_runtime_owner_assignment_id = ?`,
        [
          current.nowMs,
          parsed.runtimeId,
          parsed.predecessorNativeIncarnation,
          parsed.expectedRuntimeOwnerAssignmentId,
        ],
        "native runtime termination compare-and-swap",
      );
      const runtime = parseNativeRuntimeRecord({
        ...storedRuntime.runtime,
        currentNativeIncarnation: null,
        currentRuntimeOwnerAssignmentId: null,
        closedAtMs: current.nowMs,
        state: "closed",
      });
      const closedPredecessor = parseNativeRuntimeIncarnationRecord({
        ...predecessor,
        closedAtMs: current.nowMs,
        state: "closed",
      });
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "runtime_terminated",
        "native_runtime",
        parsed.runtimeId,
      );
      return frozen({
        runtime,
        predecessor: closedPredecessor,
        containment,
        journalEntry,
        replayed: false,
      });
    });
  }

  appendLocalConversationTransition(
    request: AppendLocalNativeConversationTransitionRequest,
  ): AppendLocalNativeConversationTransitionResult {
    const parsed = parseLocalTransitionRequest(request);
    return this.#executor.transaction((transaction) => {
      const replayEntry = findOperation(transaction, parsed.operation.operationId);
      if (replayEntry !== null) {
        assertExactOperation(
          replayEntry,
          parsed.operation,
          "local_conversation_transitioned",
          "local_native_transition",
          parsed.localTransitionId,
        );
        const transition = findTransition(transaction, parsed.localTransitionId);
        const conversation = findConversation(transaction, parsed.target.localNativeConversationId);
        if (
          transition === null ||
          conversation === null ||
          transition.runtimeId !== parsed.runtimeId ||
          transition.nativeIncarnation !== parsed.nativeIncarnation ||
          transition.kind !== parsed.kind ||
          transition.sourceLocalNativeConversationId !== parsed.sourceLocalNativeConversationId ||
          transition.targetLocalNativeConversationId !== parsed.target.localNativeConversationId ||
          transition.observedSemanticConversationId !== parsed.observedSemanticConversationId ||
          transition.nativeEvidenceSchemaId !== parsed.nativeEvidenceSchemaId ||
          transition.nativeEvidenceRef !== parsed.nativeEvidenceRef ||
          !sameDigest(transition.nativeEvidenceDigest, parsed.nativeEvidenceDigest) ||
          !sameDescriptor(conversation.descriptor, parsed.target.descriptor) ||
          conversation.projectId !== parsed.target.projectId ||
          conversation.runtimeId !== parsed.runtimeId ||
          conversation.nativeIncarnation !== parsed.nativeIncarnation ||
          conversation.semanticConversationId !== parsed.target.semanticConversationId ||
          conversation.parentLocalNativeConversationId !==
            parsed.target.parentLocalNativeConversationId ||
          conversation.state !== parsed.target.state
        ) {
          throw new RuntimeOwnerRepositoryConflictError(
            "local conversation transition intent collided",
          );
        }
        return frozen({ conversation, transition, journalEntry: replayEntry, replayed: true });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      const storedRuntime = findRuntime(transaction, parsed.runtimeId);
      const incarnation = findIncarnation(transaction, parsed.runtimeId, parsed.nativeIncarnation);
      if (
        storedRuntime === null ||
        storedRuntime.runtime.state !== "current" ||
        storedRuntime.runtime.currentNativeIncarnation !== parsed.nativeIncarnation ||
        !runtimeIsAssignedToFence(transaction, storedRuntime, parsed.fence) ||
        incarnation === null ||
        incarnation.state === "closed" ||
        !sameDescriptor(storedRuntime.runtime.descriptor, parsed.target.descriptor)
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "local transition runtime/incarnation is not current",
        );
      }
      if (
        sqlGet(
          transaction,
          `SELECT project_id FROM projects WHERE project_id = ? AND state = 'current' LIMIT 1`,
          [parsed.target.projectId],
        ) === undefined
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "local conversation requires an existing current A1.2 project",
        );
      }
      if (storedRuntime.nextLocalTransitionSeq >= Number.MAX_SAFE_INTEGER) {
        throw new RuntimeOwnerRepositoryConflictError("local transition sequence is exhausted");
      }
      const source =
        parsed.sourceLocalNativeConversationId === null
          ? null
          : findConversation(transaction, parsed.sourceLocalNativeConversationId);
      const existingTarget = findConversation(transaction, parsed.target.localNativeConversationId);
      const createsTarget =
        parsed.kind === "discover" ||
        parsed.kind === "new" ||
        parsed.kind === "clear" ||
        parsed.kind === "fork";
      if (createsTarget && existingTarget !== null) {
        throw new RuntimeOwnerRepositoryConflictError("local conversation target is occupied");
      }
      if (
        (parsed.kind === "clear" ||
          parsed.kind === "fork" ||
          parsed.kind === "switch" ||
          parsed.kind === "archive" ||
          parsed.kind === "unarchive") &&
        (source === null ||
          source.runtimeId !== parsed.runtimeId ||
          source.nativeIncarnation !== parsed.nativeIncarnation)
      ) {
        throw new RuntimeOwnerRepositoryConflictError("local transition source is unknown");
      }
      if (
        createsTarget &&
        parsed.target.parentLocalNativeConversationId !==
          (parsed.kind === "fork" ? parsed.sourceLocalNativeConversationId : null)
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          parsed.kind === "fork"
            ? "fork target parent must equal the exact source conversation"
            : "only a fork target may carry parent lineage",
        );
      }
      if (parsed.kind === "clear") {
        assertNoRetainedRegistrationForSemanticConversation(
          transaction,
          parsed.runtimeId,
          parsed.nativeIncarnation,
          source?.semanticConversationId ?? null,
        );
      } else if (parsed.kind === "archive") {
        assertNoRetainedRegistrationForSemanticConversation(
          transaction,
          parsed.runtimeId,
          parsed.nativeIncarnation,
          existingTarget?.semanticConversationId ?? null,
        );
      }
      let conversation: LocalNativeConversationRecord;
      if (createsTarget) {
        conversation = parseLocalNativeConversationRecord({
          ...parsed.target,
          runtimeId: parsed.runtimeId,
          nativeIncarnation: parsed.nativeIncarnation,
        });
        runExactlyOne(
          transaction,
          `INSERT INTO local_native_conversations (
             local_native_conversation_id, descriptor_product, descriptor_access,
             project_id, runtime_id, native_incarnation, semantic_conversation_id,
             parent_local_native_conversation_id, state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            conversation.localNativeConversationId,
            conversation.descriptor.product,
            conversation.descriptor.access,
            conversation.projectId,
            conversation.runtimeId,
            conversation.nativeIncarnation,
            conversation.semanticConversationId,
            conversation.parentLocalNativeConversationId,
            conversation.state,
          ],
          "local native conversation insert",
        );
        if (parsed.kind === "clear" && source !== null && source.state !== "closed") {
          runExactlyOne(
            transaction,
            `UPDATE local_native_conversations SET state = 'closed'
             WHERE local_native_conversation_id = ? AND runtime_id = ?
               AND native_incarnation = ? AND state <> 'closed'`,
            [source.localNativeConversationId, source.runtimeId, source.nativeIncarnation],
            "cleared local conversation close",
          );
        }
      } else {
        if (
          existingTarget === null ||
          !sameDescriptor(existingTarget.descriptor, parsed.target.descriptor) ||
          existingTarget.projectId !== parsed.target.projectId ||
          existingTarget.runtimeId !== parsed.runtimeId ||
          existingTarget.nativeIncarnation !== parsed.nativeIncarnation ||
          existingTarget.semanticConversationId !== parsed.target.semanticConversationId ||
          existingTarget.parentLocalNativeConversationId !==
            parsed.target.parentLocalNativeConversationId
        ) {
          throw new RuntimeOwnerRepositoryConflictError("local conversation target does not match");
        }
        if (parsed.kind === "archive" || parsed.kind === "unarchive") {
          const expectedState = parsed.kind === "archive" ? "closed" : "open";
          if (parsed.target.state !== expectedState) {
            throw new RuntimeOwnerRepositoryConflictError(
              `local ${parsed.kind} target state must be ${expectedState}`,
            );
          }
          if (existingTarget.state !== expectedState) {
            runExactlyOne(
              transaction,
              `UPDATE local_native_conversations SET state = ?
               WHERE local_native_conversation_id = ? AND runtime_id = ?
                 AND native_incarnation = ? AND state = ?`,
              [
                expectedState,
                existingTarget.localNativeConversationId,
                existingTarget.runtimeId,
                existingTarget.nativeIncarnation,
                parsed.kind === "archive" ? "open" : "closed",
              ],
              `local conversation ${parsed.kind}`,
            );
          }
          conversation = parseLocalNativeConversationRecord({
            ...existingTarget,
            state: expectedState,
          });
        } else {
          if (existingTarget.state !== parsed.target.state) {
            throw new RuntimeOwnerRepositoryConflictError(
              "switched local conversation state does not match",
            );
          }
          conversation = existingTarget;
        }
      }
      if (
        parsed.observedSemanticConversationId !== null &&
        conversation.semanticConversationId !== parsed.observedSemanticConversationId
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "observed semantic conversation does not match the target",
        );
      }
      const transition = parseLocalNativeConversationTransitionRecord({
        localTransitionId: parsed.localTransitionId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: parsed.nativeIncarnation,
        localTransitionSeq: storedRuntime.nextLocalTransitionSeq,
        kind: parsed.kind,
        sourceLocalNativeConversationId: parsed.sourceLocalNativeConversationId,
        targetLocalNativeConversationId: parsed.target.localNativeConversationId,
        observedSemanticConversationId: parsed.observedSemanticConversationId,
        nativeEvidenceSchemaId: parsed.nativeEvidenceSchemaId,
        nativeEvidenceRef: parsed.nativeEvidenceRef,
        nativeEvidenceDigest: parsed.nativeEvidenceDigest,
        observedAtMs: current.nowMs,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO local_native_conversation_transitions (
           local_transition_id, runtime_id, native_incarnation, local_transition_seq,
           kind, source_local_native_conversation_id, target_local_native_conversation_id,
           observed_semantic_conversation_id, native_evidence_ref,
           native_evidence_schema_id, native_evidence_digest, observed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transition.localTransitionId,
          transition.runtimeId,
          transition.nativeIncarnation,
          transition.localTransitionSeq,
          transition.kind,
          transition.sourceLocalNativeConversationId,
          transition.targetLocalNativeConversationId,
          transition.observedSemanticConversationId,
          transition.nativeEvidenceRef,
          transition.nativeEvidenceSchemaId,
          transition.nativeEvidenceDigest,
          transition.observedAtMs,
        ],
        "local native transition insert",
      );
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "local_conversation_transitioned",
        "local_native_transition",
        parsed.localTransitionId,
      );
      return frozen({ conversation, transition, journalEntry, replayed: false });
    });
  }

  reconcileServiceLeaseAcquisition(
    request: AcquireRuntimeOwnerServiceLeaseRequest,
  ): AcquireRuntimeOwnerServiceLeaseResult | null {
    const parsed = parseAcquireRequest(request);
    return this.#executor.transaction((transaction) => {
      const stored = findServiceLease(transaction, parsed.candidateLeaseId);
      if (stored === null) return null;
      return acquisitionResult(
        transaction,
        this.#machineIdentityId,
        parsed,
        stored,
        trustedNow(this.#nowMs),
        true,
      );
    });
  }

  renewServiceLease(
    request: RenewRuntimeOwnerServiceLeaseRequest,
  ): RenewRuntimeOwnerServiceLeaseResult {
    const parsed = parseRenewRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      if (parsed.newHeartbeatDeadlineMs <= current.nowMs) {
        throw new RuntimeOwnerRepositoryConflictError("renewed deadline is not in the future");
      }
      if (current.lease.heartbeatDeadlineMs === parsed.newHeartbeatDeadlineMs) {
        return frozen({ lease: current.lease, replayed: true });
      }
      if (current.lease.heartbeatDeadlineMs !== parsed.expectedHeartbeatDeadlineMs) {
        throw new RuntimeOwnerRepositoryConflictError("heartbeat compare-and-swap failed");
      }
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_service_leases
         SET heartbeat_deadline_ms = ?
         WHERE runtime_owner_service_lease_id = ? AND machine_identity_id = ?
           AND runtime_owner_service_epoch = ? AND owner_instance_id = ?
           AND owner_process_start_identity_schema_id = ?
           AND owner_process_start_identity_ref = ?
           AND owner_process_start_identity_digest = ?
           AND heartbeat_deadline_ms = ? AND state = 'current' AND released_at_ms IS NULL`,
        [
          parsed.newHeartbeatDeadlineMs,
          parsed.fence.runtimeOwnerServiceLeaseId,
          this.#machineIdentityId,
          parsed.fence.runtimeOwnerServiceEpoch,
          parsed.fence.ownerInstanceId,
          parsed.fence.ownerProcessStartIdentitySchemaId,
          parsed.fence.ownerProcessStartIdentityRef,
          parsed.fence.ownerProcessStartIdentityDigest,
          parsed.expectedHeartbeatDeadlineMs,
        ],
        "runtime-owner heartbeat compare-and-swap",
      );
      return frozen({
        lease: parseRuntimeOwnerServiceLeaseRecord({
          ...current.lease,
          heartbeatDeadlineMs: parsed.newHeartbeatDeadlineMs,
        }),
        replayed: false,
      });
    });
  }

  releaseServiceLease(
    request: ReleaseRuntimeOwnerServiceLeaseRequest,
  ): ReleaseRuntimeOwnerServiceLeaseResult {
    const parsed = parseReleaseRequest(request);
    return this.#executor.transaction((transaction) => {
      const existingEntry = findOperation(transaction, parsed.operation.operationId);
      if (existingEntry !== null) {
        assertExactOperation(
          existingEntry,
          parsed.operation,
          "service_lease_released",
          "service_lease",
          parsed.fence.runtimeOwnerServiceLeaseId,
        );
        const lease = findServiceLease(transaction, parsed.fence.runtimeOwnerServiceLeaseId)?.lease;
        if (lease === undefined || lease.state !== "released") {
          throw new RuntimeOwnerRepositoryPersistenceError(
            "service-lease release journal has no released lease",
          );
        }
        return frozen({ lease, journalEntry: existingEntry, replayed: true });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      const released = parseRuntimeOwnerServiceLeaseRecord({
        ...current.lease,
        releasedAtMs: current.nowMs,
        state: "released",
      });
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_service_leases
         SET released_at_ms = ?, state = 'released'
         WHERE runtime_owner_service_lease_id = ? AND machine_identity_id = ?
           AND runtime_owner_service_epoch = ? AND owner_instance_id = ?
           AND owner_process_start_identity_schema_id = ?
           AND owner_process_start_identity_ref = ?
           AND owner_process_start_identity_digest = ?
           AND state = 'current' AND released_at_ms IS NULL`,
        [
          current.nowMs,
          parsed.fence.runtimeOwnerServiceLeaseId,
          this.#machineIdentityId,
          parsed.fence.runtimeOwnerServiceEpoch,
          parsed.fence.ownerInstanceId,
          parsed.fence.ownerProcessStartIdentitySchemaId,
          parsed.fence.ownerProcessStartIdentityRef,
          parsed.fence.ownerProcessStartIdentityDigest,
        ],
        "runtime-owner service-lease release",
      );
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "service_lease_released",
        "service_lease",
        parsed.fence.runtimeOwnerServiceLeaseId,
      );
      runExactlyOne(
        transaction,
        `UPDATE runtime_owner_state
         SET current_runtime_owner_service_lease_id = NULL
         WHERE singleton = 1 AND machine_identity_id = ?
           AND current_runtime_owner_service_epoch = ?
           AND current_runtime_owner_service_lease_id = ?`,
        [
          this.#machineIdentityId,
          parsed.fence.runtimeOwnerServiceEpoch,
          parsed.fence.runtimeOwnerServiceLeaseId,
        ],
        "runtime-owner released pointer clear",
      );
      return frozen({ lease: released, journalEntry, replayed: false });
    });
  }

  reconcileServiceLeaseRelease(
    request: ReleaseRuntimeOwnerServiceLeaseRequest,
  ): ReleaseRuntimeOwnerServiceLeaseResult | null {
    const parsed = parseReleaseRequest(request);
    return this.#executor.transaction((transaction) => {
      const entry = findOperation(transaction, parsed.operation.operationId);
      if (entry === null) return null;
      assertExactOperation(
        entry,
        parsed.operation,
        "service_lease_released",
        "service_lease",
        parsed.fence.runtimeOwnerServiceLeaseId,
      );
      const lease = findServiceLease(transaction, parsed.fence.runtimeOwnerServiceLeaseId)?.lease;
      if (lease === undefined || lease.state !== "released") {
        throw new RuntimeOwnerRepositoryPersistenceError("reconciled release is incomplete");
      }
      const owner = findOwnerState(transaction);
      if (
        owner.currentRuntimeOwnerServiceEpoch === parsed.fence.runtimeOwnerServiceEpoch &&
        owner.currentRuntimeOwnerServiceLeaseId !== null
      ) {
        throw new RuntimeOwnerRepositoryPersistenceError("released owner pointer was not cleared");
      }
      return frozen({ lease, journalEntry: entry, replayed: true });
    });
  }

  registerInitialRuntime(request: RegisterInitialRuntimeRequest): RuntimeRegistrationResult {
    const parsed = parseRegisterRequest(request);
    return this.#executor.transaction((transaction) => {
      const existingEntry = findOperation(transaction, parsed.operation.operationId);
      if (existingEntry !== null) {
        assertExactOperation(
          existingEntry,
          parsed.operation,
          "runtime_registered",
          "native_runtime",
          parsed.runtimeId,
        );
        const result = loadRegistrationResult(
          transaction,
          parsed.runtimeId,
          parsed.operation.operationId,
          true,
        );
        if (result === null || !registrationMatches(result, parsed)) {
          throw new RuntimeOwnerRepositoryConflictError("runtime registration intent collided");
        }
        return result;
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      const derivedRuntimeId = syncNativeRuntimeId(
        parsed.wardenLaunchNonce,
        parsed.startIdentitySchemaId,
        parsed.startIdentityDigest,
      );
      if (derivedRuntimeId !== parsed.runtimeId) {
        throw new RuntimeOwnerRepositoryConflictError(
          "runtime ID does not match the founding launch identity",
        );
      }
      if (
        findRuntime(transaction, parsed.runtimeId) !== null ||
        findAssignment(transaction, parsed.runtimeOwnerAssignmentId) !== null ||
        findIdentityKey(transaction, parsed.key.runtimeOwnerIdentityKeyId) !== null
      ) {
        throw new RuntimeOwnerRepositoryConflictError("runtime registration identity is occupied");
      }
      const runtime = parseNativeRuntimeRecord({
        runtimeId: parsed.runtimeId,
        descriptor: parsed.descriptor,
        wardenLaunchNonce: parsed.wardenLaunchNonce,
        initialStartIdentitySchemaId: parsed.startIdentitySchemaId,
        initialStartIdentityRef: parsed.startIdentityRef,
        initialStartIdentityDigest: parsed.startIdentityDigest,
        currentNativeIncarnation: 1,
        currentRuntimeOwnerAssignmentId: parsed.runtimeOwnerAssignmentId,
        createdAtMs: current.nowMs,
        closedAtMs: null,
        state: "current",
      });
      const incarnation = parseNativeRuntimeIncarnationRecord({
        runtimeId: parsed.runtimeId,
        nativeIncarnation: 1,
        descriptor: parsed.descriptor,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        startIdentitySchemaId: parsed.startIdentitySchemaId,
        startIdentityRef: parsed.startIdentityRef,
        startIdentityDigest: parsed.startIdentityDigest,
        startedAtMs: current.nowMs,
        closedAtMs: null,
        state: "starting",
      });
      const assignment = parseRuntimeOwnerAssignmentRecord({
        runtimeOwnerAssignmentId: parsed.runtimeOwnerAssignmentId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: 1,
        assignmentGeneration: 1,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        assignedAtMs: current.nowMs,
        supersedesRuntimeOwnerAssignmentId: null,
        reason: "creation",
        assignmentEvidenceSchemaId: parsed.startIdentitySchemaId,
        assignmentEvidenceRef: parsed.startIdentityRef,
        assignmentEvidenceDigest: parsed.startIdentityDigest,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO native_runtimes (
           runtime_id, descriptor_product, descriptor_access, warden_launch_nonce,
           initial_start_identity_schema_id, initial_start_identity_ref,
           initial_start_identity_digest, current_native_incarnation,
           current_runtime_owner_assignment_id, next_local_transition_seq,
           created_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, NULL, 'current')`,
        [
          runtime.runtimeId,
          runtime.descriptor.product,
          runtime.descriptor.access,
          runtime.wardenLaunchNonce,
          runtime.initialStartIdentitySchemaId,
          runtime.initialStartIdentityRef,
          runtime.initialStartIdentityDigest,
          assignment.runtimeOwnerAssignmentId,
          runtime.createdAtMs,
        ],
        "native runtime root insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO native_runtime_incarnations (
           runtime_id, native_incarnation, descriptor_product, descriptor_access,
           runtime_owner_service_lease_id, runtime_owner_service_epoch,
           start_identity_schema_id, start_identity_ref, start_identity_digest,
           started_at_ms, closed_at_ms, state
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'starting')`,
        [
          incarnation.runtimeId,
          incarnation.descriptor.product,
          incarnation.descriptor.access,
          incarnation.runtimeOwnerServiceLeaseId,
          incarnation.runtimeOwnerServiceEpoch,
          incarnation.startIdentitySchemaId,
          incarnation.startIdentityRef,
          incarnation.startIdentityDigest,
          incarnation.startedAtMs,
        ],
        "native runtime incarnation insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO runtime_owner_assignments (
           runtime_owner_assignment_id, runtime_id, native_incarnation,
           assignment_generation, runtime_owner_service_lease_id,
           runtime_owner_service_epoch, assigned_at_ms,
           assignment_evidence_schema_id, assignment_evidence_ref,
           assignment_evidence_digest, supersedes_runtime_owner_assignment_id, reason
         ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, NULL, 'creation')`,
        [
          assignment.runtimeOwnerAssignmentId,
          assignment.runtimeId,
          assignment.runtimeOwnerServiceLeaseId,
          assignment.runtimeOwnerServiceEpoch,
          assignment.assignedAtMs,
          assignment.assignmentEvidenceSchemaId,
          assignment.assignmentEvidenceRef,
          assignment.assignmentEvidenceDigest,
        ],
        "runtime-owner assignment insert",
      );
      const { identityKey, privateKey } = insertIdentityKeyAndEnvelope(
        transaction,
        parsed.runtimeId,
        1,
        parsed.key,
        current.nowMs,
      );
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "runtime_registered",
        "native_runtime",
        parsed.runtimeId,
      );
      return frozen({
        runtime,
        incarnation,
        assignment,
        identityKey,
        privateKey,
        journalEntry,
        replayed: false,
      });
    });
  }

  reassignRuntimeOwner(request: ReassignRuntimeOwnerRequest): ReassignRuntimeOwnerResult {
    const parsed = parseReassignRequest(request);
    return this.#executor.transaction((transaction) => {
      const replayEntry = findOperation(transaction, parsed.operation.operationId);
      if (replayEntry !== null) {
        assertExactOperation(
          replayEntry,
          parsed.operation,
          "runtime_reassigned",
          "native_runtime",
          parsed.runtimeId,
        );
        const storedRuntime = findRuntime(transaction, parsed.runtimeId);
        const incarnation = findIncarnation(
          transaction,
          parsed.runtimeId,
          parsed.nativeIncarnation,
        );
        const previousAssignment = findAssignment(
          transaction,
          parsed.expectedRuntimeOwnerAssignmentId,
        );
        const assignment = findAssignment(transaction, parsed.runtimeOwnerAssignmentId);
        if (
          storedRuntime === null ||
          incarnation === null ||
          previousAssignment === null ||
          assignment === null ||
          assignment.runtimeId !== parsed.runtimeId ||
          assignment.nativeIncarnation !== parsed.nativeIncarnation ||
          assignment.supersedesRuntimeOwnerAssignmentId !==
            parsed.expectedRuntimeOwnerAssignmentId ||
          assignment.assignmentEvidenceSchemaId !== parsed.reattachmentEvidenceSchemaId ||
          assignment.assignmentEvidenceRef !== parsed.reattachmentEvidenceRef ||
          !sameDigest(assignment.assignmentEvidenceDigest, parsed.reattachmentEvidenceDigest)
        ) {
          throw new RuntimeOwnerRepositoryConflictError("runtime reassignment intent collided");
        }
        return frozen({
          runtime: storedRuntime.runtime,
          incarnation,
          previousAssignment,
          assignment,
          journalEntry: replayEntry,
          replayed: true,
        });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      const storedRuntime = findRuntime(transaction, parsed.runtimeId);
      const incarnation = findIncarnation(transaction, parsed.runtimeId, parsed.nativeIncarnation);
      const previousAssignment = findAssignment(
        transaction,
        parsed.expectedRuntimeOwnerAssignmentId,
      );
      if (
        storedRuntime === null ||
        storedRuntime.runtime.state !== "current" ||
        storedRuntime.runtime.currentNativeIncarnation !== parsed.nativeIncarnation ||
        storedRuntime.runtime.currentRuntimeOwnerAssignmentId !==
          parsed.expectedRuntimeOwnerAssignmentId ||
        incarnation === null ||
        incarnation.state === "closed" ||
        previousAssignment === null ||
        previousAssignment.runtimeId !== parsed.runtimeId ||
        previousAssignment.nativeIncarnation !== parsed.nativeIncarnation ||
        parsed.fence.runtimeOwnerServiceEpoch <= previousAssignment.runtimeOwnerServiceEpoch
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "runtime reassignment predecessor is not current or the owner epoch did not advance",
        );
      }
      if (findAssignment(transaction, parsed.runtimeOwnerAssignmentId) !== null) {
        throw new RuntimeOwnerRepositoryConflictError("runtime assignment ID is occupied");
      }
      const assignment = parseRuntimeOwnerAssignmentRecord({
        runtimeOwnerAssignmentId: parsed.runtimeOwnerAssignmentId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: parsed.nativeIncarnation,
        assignmentGeneration: checkedIncrement(
          previousAssignment.assignmentGeneration,
          "runtime assignment generation",
        ),
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        assignedAtMs: current.nowMs,
        supersedesRuntimeOwnerAssignmentId: previousAssignment.runtimeOwnerAssignmentId,
        reason: "takeover",
        assignmentEvidenceSchemaId: parsed.reattachmentEvidenceSchemaId,
        assignmentEvidenceRef: parsed.reattachmentEvidenceRef,
        assignmentEvidenceDigest: parsed.reattachmentEvidenceDigest,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO runtime_owner_assignments (
           runtime_owner_assignment_id, runtime_id, native_incarnation,
           assignment_generation, runtime_owner_service_lease_id,
           runtime_owner_service_epoch, assigned_at_ms,
           assignment_evidence_schema_id, assignment_evidence_ref,
           assignment_evidence_digest, supersedes_runtime_owner_assignment_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'takeover')`,
        [
          assignment.runtimeOwnerAssignmentId,
          assignment.runtimeId,
          assignment.nativeIncarnation,
          assignment.assignmentGeneration,
          assignment.runtimeOwnerServiceLeaseId,
          assignment.runtimeOwnerServiceEpoch,
          assignment.assignedAtMs,
          assignment.assignmentEvidenceSchemaId,
          assignment.assignmentEvidenceRef,
          assignment.assignmentEvidenceDigest,
          assignment.supersedesRuntimeOwnerAssignmentId,
        ],
        "runtime-owner reassignment insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_runtimes
         SET current_runtime_owner_assignment_id = ?
         WHERE runtime_id = ? AND state = 'current'
           AND current_native_incarnation = ?
           AND current_runtime_owner_assignment_id = ?`,
        [
          assignment.runtimeOwnerAssignmentId,
          parsed.runtimeId,
          parsed.nativeIncarnation,
          parsed.expectedRuntimeOwnerAssignmentId,
        ],
        "runtime-owner assignment pointer compare-and-swap",
      );
      const runtime = parseNativeRuntimeRecord({
        ...storedRuntime.runtime,
        currentRuntimeOwnerAssignmentId: assignment.runtimeOwnerAssignmentId,
      });
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "runtime_reassigned",
        "native_runtime",
        parsed.runtimeId,
      );
      return frozen({
        runtime,
        incarnation,
        previousAssignment,
        assignment,
        journalEntry,
        replayed: false,
      });
    });
  }

  replaceRuntimeIncarnation(
    request: ReplaceRuntimeIncarnationRequest,
  ): ReplaceRuntimeIncarnationResult {
    const parsed = parseReplaceRequest(request);
    return this.#executor.transaction((transaction) => {
      const successorNativeIncarnation = checkedIncrement(
        parsed.predecessorNativeIncarnation,
        "native incarnation",
      );
      const replayEntry = findOperation(transaction, parsed.operation.operationId);
      if (replayEntry !== null) {
        assertExactOperation(
          replayEntry,
          parsed.operation,
          "runtime_replaced",
          "native_runtime",
          parsed.runtimeId,
        );
        const storedRuntime = findRuntime(transaction, parsed.runtimeId);
        const predecessor = findIncarnation(
          transaction,
          parsed.runtimeId,
          parsed.predecessorNativeIncarnation,
        );
        const successor = findIncarnation(
          transaction,
          parsed.runtimeId,
          successorNativeIncarnation,
        );
        const containment = findContainment(transaction, parsed.containmentId);
        const assignment = findAssignment(transaction, parsed.successorRuntimeOwnerAssignmentId);
        if (
          storedRuntime === null ||
          predecessor === null ||
          successor === null ||
          containment === null ||
          assignment === null ||
          containment.runtimeId !== parsed.runtimeId ||
          containment.predecessorNativeIncarnation !== parsed.predecessorNativeIncarnation ||
          containment.successorNativeIncarnation !== successorNativeIncarnation ||
          containment.kind !== "replacement" ||
          containment.evidenceSchemaId !== parsed.containmentEvidenceSchemaId ||
          containment.evidenceRef !== parsed.containmentEvidenceRef ||
          !sameDigest(containment.evidenceDigest, parsed.containmentEvidenceDigest) ||
          successor.startIdentitySchemaId !== parsed.successorStartIdentitySchemaId ||
          successor.startIdentityRef !== parsed.successorStartIdentityRef ||
          !sameDigest(successor.startIdentityDigest, parsed.successorStartIdentityDigest)
        ) {
          throw new RuntimeOwnerRepositoryConflictError("runtime replacement intent collided");
        }
        return frozen({
          runtime: storedRuntime.runtime,
          predecessor,
          successor,
          containment,
          assignment,
          journalEntry: replayEntry,
          replayed: true,
        });
      }
      const current = assertCurrentOwner(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        this.#nowMs,
      );
      const storedRuntime = findRuntime(transaction, parsed.runtimeId);
      const predecessor = findIncarnation(
        transaction,
        parsed.runtimeId,
        parsed.predecessorNativeIncarnation,
      );
      if (
        storedRuntime === null ||
        storedRuntime.runtime.state !== "current" ||
        !runtimeIsAssignedToFence(transaction, storedRuntime, parsed.fence) ||
        storedRuntime.runtime.currentNativeIncarnation !== parsed.predecessorNativeIncarnation ||
        storedRuntime.runtime.currentRuntimeOwnerAssignmentId !==
          parsed.expectedRuntimeOwnerAssignmentId ||
        predecessor === null ||
        predecessor.state === "closed"
      ) {
        throw new RuntimeOwnerRepositoryConflictError(
          "runtime replacement predecessor is not current",
        );
      }
      assertNoRetainedRegistrationForRuntimeIncarnation(
        transaction,
        parsed.runtimeId,
        parsed.predecessorNativeIncarnation,
      );
      const liveGate = sqlGet(
        transaction,
        `SELECT native_binding_id FROM binding_lifecycle_gates
         WHERE runtime_id = ? AND native_incarnation = ? AND phase <> 'closed' LIMIT 1`,
        [parsed.runtimeId, parsed.predecessorNativeIncarnation],
      );
      if (liveGate !== undefined) {
        throw new RuntimeOwnerRepositoryConflictError(
          "runtime replacement requires every predecessor binding gate detached",
        );
      }
      if (
        findContainment(transaction, parsed.containmentId) !== null ||
        findIncarnation(transaction, parsed.runtimeId, successorNativeIncarnation) !== null ||
        findAssignment(transaction, parsed.successorRuntimeOwnerAssignmentId) !== null
      ) {
        throw new RuntimeOwnerRepositoryConflictError("runtime replacement identity is occupied");
      }
      const successor = parseNativeRuntimeIncarnationRecord({
        runtimeId: parsed.runtimeId,
        nativeIncarnation: successorNativeIncarnation,
        descriptor: storedRuntime.runtime.descriptor,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        startIdentitySchemaId: parsed.successorStartIdentitySchemaId,
        startIdentityRef: parsed.successorStartIdentityRef,
        startIdentityDigest: parsed.successorStartIdentityDigest,
        startedAtMs: current.nowMs,
        closedAtMs: null,
        state: "starting",
      });
      const containment = parseNativeRuntimeContainmentRecord({
        nativeRuntimeContainmentId: parsed.containmentId,
        runtimeId: parsed.runtimeId,
        predecessorNativeIncarnation: parsed.predecessorNativeIncarnation,
        successorNativeIncarnation,
        kind: "replacement",
        evidenceSchemaId: parsed.containmentEvidenceSchemaId,
        evidenceRef: parsed.containmentEvidenceRef,
        evidenceDigest: parsed.containmentEvidenceDigest,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        containedAtMs: current.nowMs,
      });
      const assignment = parseRuntimeOwnerAssignmentRecord({
        runtimeOwnerAssignmentId: parsed.successorRuntimeOwnerAssignmentId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: successorNativeIncarnation,
        assignmentGeneration: 1,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        assignedAtMs: current.nowMs,
        supersedesRuntimeOwnerAssignmentId: null,
        reason: "creation",
        assignmentEvidenceSchemaId: parsed.successorStartIdentitySchemaId,
        assignmentEvidenceRef: parsed.successorStartIdentityRef,
        assignmentEvidenceDigest: parsed.successorStartIdentityDigest,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO native_runtime_containments (
           native_runtime_containment_id, runtime_id, predecessor_native_incarnation,
           successor_native_incarnation, kind, evidence_schema_id,
           evidence_ref, evidence_digest,
           runtime_owner_service_lease_id, runtime_owner_service_epoch, contained_at_ms
         ) VALUES (?, ?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?)`,
        [
          containment.nativeRuntimeContainmentId,
          containment.runtimeId,
          containment.predecessorNativeIncarnation,
          containment.successorNativeIncarnation,
          containment.evidenceSchemaId,
          containment.evidenceRef,
          containment.evidenceDigest,
          containment.runtimeOwnerServiceLeaseId,
          containment.runtimeOwnerServiceEpoch,
          containment.containedAtMs,
        ],
        "native runtime containment insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_runtime_incarnations
         SET closed_at_ms = ?, state = 'closed'
         WHERE runtime_id = ? AND native_incarnation = ?
           AND state <> 'closed' AND closed_at_ms IS NULL`,
        [current.nowMs, parsed.runtimeId, parsed.predecessorNativeIncarnation],
        "predecessor native incarnation containment close",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO native_runtime_incarnations (
           runtime_id, native_incarnation, descriptor_product, descriptor_access,
           runtime_owner_service_lease_id, runtime_owner_service_epoch,
           start_identity_schema_id, start_identity_ref, start_identity_digest,
           started_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'starting')`,
        [
          successor.runtimeId,
          successor.nativeIncarnation,
          successor.descriptor.product,
          successor.descriptor.access,
          successor.runtimeOwnerServiceLeaseId,
          successor.runtimeOwnerServiceEpoch,
          successor.startIdentitySchemaId,
          successor.startIdentityRef,
          successor.startIdentityDigest,
          successor.startedAtMs,
        ],
        "successor native incarnation insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO runtime_owner_assignments (
           runtime_owner_assignment_id, runtime_id, native_incarnation,
           assignment_generation, runtime_owner_service_lease_id,
           runtime_owner_service_epoch, assigned_at_ms,
           assignment_evidence_schema_id, assignment_evidence_ref,
           assignment_evidence_digest, supersedes_runtime_owner_assignment_id, reason
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, 'creation')`,
        [
          assignment.runtimeOwnerAssignmentId,
          assignment.runtimeId,
          assignment.nativeIncarnation,
          assignment.runtimeOwnerServiceLeaseId,
          assignment.runtimeOwnerServiceEpoch,
          assignment.assignedAtMs,
          assignment.assignmentEvidenceSchemaId,
          assignment.assignmentEvidenceRef,
          assignment.assignmentEvidenceDigest,
        ],
        "successor runtime-owner assignment insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_runtimes
         SET current_native_incarnation = ?, current_runtime_owner_assignment_id = ?
         WHERE runtime_id = ? AND state = 'current'
           AND current_native_incarnation = ?
           AND current_runtime_owner_assignment_id = ?`,
        [
          successorNativeIncarnation,
          assignment.runtimeOwnerAssignmentId,
          parsed.runtimeId,
          parsed.predecessorNativeIncarnation,
          parsed.expectedRuntimeOwnerAssignmentId,
        ],
        "native runtime replacement pointer compare-and-swap",
      );
      const runtime = parseNativeRuntimeRecord({
        ...storedRuntime.runtime,
        currentNativeIncarnation: successorNativeIncarnation,
        currentRuntimeOwnerAssignmentId: assignment.runtimeOwnerAssignmentId,
      });
      const closedPredecessor = parseNativeRuntimeIncarnationRecord({
        ...predecessor,
        closedAtMs: current.nowMs,
        state: "closed",
      });
      const journalEntry = appendJournal(
        transaction,
        current.owner,
        parsed.fence,
        current.nowMs,
        parsed.operation,
        "runtime_replaced",
        "native_runtime",
        parsed.runtimeId,
      );
      return frozen({
        runtime,
        predecessor: closedPredecessor,
        successor,
        containment,
        assignment,
        journalEntry,
        replayed: false,
      });
    });
  }
}

/** Bind the high-level runtime-owner repository to an existing synchronous transaction. */
export function createRuntimeOwnerRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  nowMs: () => number = Date.now,
): RuntimeOwnerRepositoryOperations {
  return new RuntimeOwnerRepository(
    {
      transaction: <T>(operation: (active: HostStateRepositorySqlTransaction) => T): T =>
        operation(transaction),
    },
    machineIdentityId,
    nowMs,
  );
}

/**
 * @internal Closed transaction-local bridge used only after terminal-root proof and
 * signature verification. Public runtime-owner operations never receive the capability.
 */
export function finalizeRuntimeOwnerNativeRootSignatureInTransaction(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  activationOperationId: A1SafeId,
  request: StoreRuntimeOwnerSignatureRequest,
  nowMs: () => number = Date.now,
): RuntimeOwnerNativeRootSignatureFinalizationResult {
  const operationId = parseA1SafeId(
    activationOperationId,
    "runtimeOwnerNativeRootFinalization.activationOperationId",
  );
  const repository = new RuntimeOwnerRepository(
    {
      transaction: <T>(operation: (active: HostStateRepositorySqlTransaction) => T): T =>
        operation(transaction),
    },
    machineIdentityId,
    nowMs,
    frozen({
      capability: TERMINAL_ROOT_SIGNATURE_FINALIZATION_CAPABILITY,
      activationOperationId: operationId,
    }),
  );
  const reservation = repository.storeSignedRecord(request).reservation;
  const acceptance = repository.acceptSignedRecord({
    fence: request.fence,
    runtimeId: request.runtimeId,
    runtimeOwnerIdentityKeyId: request.runtimeOwnerIdentityKeyId,
    runtimeOwnerKeyGeneration: request.runtimeOwnerKeyGeneration,
    signerSequence: request.signerSequence,
    signedRecordDigest: request.signedRecordDigest,
  }).acceptance;
  return frozen({ reservation, acceptance });
}

/** Internal dormant-library constructor; no SQL or repository options escape this surface. */
export function createRuntimeOwnerRepositoryOperations(
  executor: HostStateRepositoryTransactionExecutor,
  machineIdentityId: string,
): RuntimeOwnerRepositoryOperations {
  return new RuntimeOwnerRepository(executor, machineIdentityId);
}
