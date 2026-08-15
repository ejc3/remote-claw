import { createPublicKey, verify as verifySignature } from "node:crypto";
import { base64urlDecode, timingSafeEqual } from "@remote-claw/clawsec";
import { createProtectedArtifactTransactionOperations } from "./artifacts.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type Ed25519Signature,
  HostStateContractError,
  type NativeConversationLeaseId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519Signature,
  parseMachineIdentityId,
} from "./ids.js";
import {
  canonicalNativeRootPayload,
  NATIVE_ROOT_ACTIVATION_OPERATION_SCHEMA_ID,
  NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
  NATIVE_ROOT_MAX_TTL_MS,
  type NativeRootActivationKind,
  type NativeRootActivationOperationRecord,
  type NativeRootActivationPreparationInput,
  type NativeRootCanonicalPayloadInput,
  type NativeRootCertificate,
  nativeBindingEvidenceDigest,
  nativeRootActivationOperationDigest,
  nativeRootCanonicalPayloadDigest,
  nativeRootCertificateId,
  nativeRootSignedRecordDigest,
  parseNativeRootActivationOperationRecord,
  parseNativeRootCertificate,
  verifyNativeRootActivationOperationDigest,
  verifyNativeRootCanonicalPayloadDigest,
} from "./native-root.js";
import { ProtectedByteSnapshot } from "./protected.js";
import type {
  CoordinatorLeaseFence,
  NativeConversationLeaseRecord,
  NativeRegistrationPublicationRecord,
} from "./records.js";
import {
  createNativeRegistrationRepositoryTransactionOperations,
  type NativeRegistrationInventory,
} from "./registration-repository.js";
import {
  createHostStateRepositoryTransactionOperations,
  type HostStateRepositorySqlRunResult,
  type HostStateRepositorySqlTransaction,
  type HostStateRepositorySqlValue,
  type HostStateRepositoryTransactionExecutor,
  type TerminalChatReservationResult,
} from "./repository.js";
import type {
  NativeBindingIncarnationRecord,
  NativeBindingRuntimeGateRecord,
  NativeRuntimeIncarnationRecord,
  NativeRuntimeRecord,
  NativeTransportAttachmentRecord,
  NativeTransportLeaseRecord,
  RuntimeOwnerAssignmentRecord,
  RuntimeOwnerIdentityKeyRecord,
  RuntimeOwnerSignatureReservationRecord,
} from "./runtime.js";
import {
  createRuntimeOwnerRepositoryTransactionOperations,
  finalizeRuntimeOwnerNativeRootSignatureInTransaction,
  type RuntimeOwnerInventory,
  type RuntimeOwnerPrivateKeyEnvelopeRecord,
  type RuntimeOwnerServiceFence,
} from "./runtime-repository.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
} from "./validation.js";

export interface TerminalRootRepositoryOptions {
  readonly randomBytes?: (byteLength: number) => Uint8Array;
  readonly nowMs?: () => number;
}

export interface PrepareNativeRootRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operationId: A1SafeId;
  readonly kind: NativeRootActivationKind;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly expectedPriorRootPathCertificateId: A1SafeId | null;
  readonly ttlMs: number;
}

export interface FinalizeNativeRootRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operationId: A1SafeId;
  readonly signature: Ed25519Signature;
}

export interface StoredNativeRootCertificate {
  readonly activationOperationId: A1SafeId;
  readonly signedRecordDigest: A1Digest;
  readonly committedAtMs: number;
  readonly certificate: NativeRootCertificate;
}

export interface NativeRootPreparationResult {
  readonly operation: NativeRootActivationOperationRecord;
  readonly canonicalPayload: ProtectedByteSnapshot;
  readonly identityKey: RuntimeOwnerIdentityKeyRecord;
  readonly privateKey: RuntimeOwnerPrivateKeyEnvelopeRecord;
  readonly signatureReservation: RuntimeOwnerSignatureReservationRecord;
  readonly replayed: boolean;
}

export interface NativeRootActivationResult {
  readonly operation: NativeRootActivationOperationRecord;
  readonly storedCertificate: StoredNativeRootCertificate;
  readonly replayed: boolean;
}

export interface NativeRootOperationReconciliation {
  readonly operation: NativeRootActivationOperationRecord;
  readonly storedCertificate: StoredNativeRootCertificate | null;
}

export interface TerminalRootInventory {
  readonly operations: readonly NativeRootActivationOperationRecord[];
  readonly certificates: readonly StoredNativeRootCertificate[];
}

export interface TerminalRootRepositoryOperations {
  prepare(request: PrepareNativeRootRequest): NativeRootPreparationResult;
  finalize(request: FinalizeNativeRootRequest): NativeRootActivationResult;
  reconcileOperation(request: PrepareNativeRootRequest): NativeRootOperationReconciliation | null;
  readOperation(operationId: A1SafeId): NativeRootActivationOperationRecord | null;
  readCertificate(rootPathCertificateId: A1SafeId): StoredNativeRootCertificate | null;
  readCurrentCertificate(
    collaborationServerId: CollaborationServerId,
    nativeConversationLeaseId: NativeConversationLeaseId,
  ): StoredNativeRootCertificate | null;
  readInventory(): TerminalRootInventory;
}

export class TerminalRootRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`terminal root repository conflict: ${message}`);
    this.name = "TerminalRootRepositoryConflictError";
  }
}

export class TerminalRootStaleOwnerError extends Error {
  constructor() {
    super("terminal root repository stale owner: service fence is not current and unexpired");
    this.name = "TerminalRootStaleOwnerError";
  }
}

export class TerminalRootStaleCoordinatorError extends Error {
  constructor() {
    super("terminal root repository stale coordinator: lease fence is not current and unexpired");
    this.name = "TerminalRootStaleCoordinatorError";
  }
}

export class TerminalRootRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`terminal root repository persistence failed: ${message}`, options);
    this.name = "TerminalRootRepositoryPersistenceError";
  }
}

const OWNER_FENCE_KEYS = [
  "runtimeOwnerServiceLeaseId",
  "runtimeOwnerServiceEpoch",
  "ownerInstanceId",
  "ownerProcessStartIdentitySchemaId",
  "ownerProcessStartIdentityRef",
  "ownerProcessStartIdentityDigest",
] as const;

const COORDINATOR_FENCE_KEYS = [
  "collaborationServerId",
  "coordinatorLeaseId",
  "coordinatorEpoch",
] as const;

const PREPARE_KEYS = [
  "fence",
  "coordinatorFence",
  "operationId",
  "kind",
  "nativeConversationLeaseId",
  "expectedPriorRootPathCertificateId",
  "ttlMs",
] as const;

const FINALIZE_KEYS = ["fence", "coordinatorFence", "operationId", "signature"] as const;

function parseOwnerFence(value: unknown, field: string): RuntimeOwnerServiceFence {
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

function parseCoordinatorFence(value: unknown, field: string): CoordinatorLeaseFence {
  const row = parseExactRecord(value, COORDINATOR_FENCE_KEYS, field);
  return frozen({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      `${field}.collaborationServerId`,
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      `${field}.coordinatorLeaseId`,
    ),
    coordinatorEpoch: parsePositiveSafeInteger(row.coordinatorEpoch, `${field}.coordinatorEpoch`),
  });
}

function parseNullableSafeId(value: unknown, field: string): A1SafeId | null {
  return value === null ? null : parseA1SafeId(value, field);
}

function parsePrepareRequest(value: unknown): PrepareNativeRootRequest {
  const row = parseExactRecord(value, PREPARE_KEYS, "prepareNativeRoot");
  const kind = parseEnum(row.kind, ["activate", "renew"] as const, "prepareNativeRoot.kind");
  const expectedPriorRootPathCertificateId = parseNullableSafeId(
    row.expectedPriorRootPathCertificateId,
    "prepareNativeRoot.expectedPriorRootPathCertificateId",
  );
  if ((kind === "activate") !== (expectedPriorRootPathCertificateId === null)) {
    throw new HostStateContractError(
      "prepareNativeRoot.expectedPriorRootPathCertificateId must be null exactly for activation",
    );
  }
  const ttlMs = parsePositiveSafeInteger(row.ttlMs, "prepareNativeRoot.ttlMs");
  if (ttlMs > NATIVE_ROOT_MAX_TTL_MS) {
    throw new HostStateContractError(
      `prepareNativeRoot.ttlMs must be at most ${NATIVE_ROOT_MAX_TTL_MS}`,
    );
  }
  return frozen({
    fence: parseOwnerFence(row.fence, "prepareNativeRoot.fence"),
    coordinatorFence: parseCoordinatorFence(
      row.coordinatorFence,
      "prepareNativeRoot.coordinatorFence",
    ),
    operationId: parseA1SafeId(row.operationId, "prepareNativeRoot.operationId"),
    kind,
    nativeConversationLeaseId: parseA1CanonicalId(
      "nativeConversationLease",
      row.nativeConversationLeaseId,
      "prepareNativeRoot.nativeConversationLeaseId",
    ),
    expectedPriorRootPathCertificateId,
    ttlMs,
  });
}

function parseFinalizeRequest(value: unknown): FinalizeNativeRootRequest {
  const row = parseExactRecord(value, FINALIZE_KEYS, "finalizeNativeRoot");
  return frozen({
    fence: parseOwnerFence(row.fence, "finalizeNativeRoot.fence"),
    coordinatorFence: parseCoordinatorFence(
      row.coordinatorFence,
      "finalizeNativeRoot.coordinatorFence",
    ),
    operationId: parseA1SafeId(row.operationId, "finalizeNativeRoot.operationId"),
    signature: parseEd25519Signature(row.signature, "finalizeNativeRoot.signature"),
  });
}

function sameDigest(left: A1Digest, right: A1Digest): boolean {
  return timingSafeEqual(base64urlDecode(left), base64urlDecode(right));
}

function checkedAdd(left: number, right: number, field: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new TerminalRootRepositoryConflictError(`${field} is exhausted`);
  }
  return value;
}

function currentTime(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HostStateContractError("terminalRoot.nowMs must return a non-negative safe integer");
  }
  return value;
}

function sqlGet(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
): unknown {
  try {
    return transaction.get(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof TerminalRootRepositoryConflictError ||
      error instanceof TerminalRootStaleOwnerError ||
      error instanceof TerminalRootStaleCoordinatorError ||
      error instanceof TerminalRootRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new TerminalRootRepositoryPersistenceError("read operation did not complete", {
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
    if (typeof transaction.all !== "function") {
      throw new TerminalRootRepositoryPersistenceError("multi-row read is unavailable");
    }
    const rows = transaction.all(sql, parameters);
    if (!Array.isArray(rows)) {
      throw new TerminalRootRepositoryPersistenceError("multi-row read returned a non-array");
    }
    return rows;
  } catch (error) {
    if (error instanceof TerminalRootRepositoryPersistenceError) throw error;
    throw new TerminalRootRepositoryPersistenceError("multi-row read did not complete", {
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
      error instanceof TerminalRootRepositoryConflictError ||
      error instanceof TerminalRootStaleOwnerError ||
      error instanceof TerminalRootStaleCoordinatorError ||
      error instanceof TerminalRootRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new TerminalRootRepositoryPersistenceError("write operation did not complete", {
      cause: error,
    });
  }
}

function runExactlyOne(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
  field: string,
): void {
  if (sqlRun(transaction, sql, parameters).changes !== 1) {
    throw new TerminalRootRepositoryPersistenceError(`${field} did not affect exactly one row`);
  }
}

function artifactTransaction(transaction: HostStateRepositorySqlTransaction) {
  return {
    get: (sql: string, parameters: readonly HostStateRepositorySqlValue[]) =>
      transaction.get(sql, parameters),
    run: (sql: string, parameters: readonly HostStateRepositorySqlValue[]) => {
      const changes = transaction.run(sql, parameters).changes;
      const numeric = typeof changes === "bigint" ? Number(changes) : changes;
      if (!Number.isSafeInteger(numeric) || numeric < 0) {
        throw new TerminalRootRepositoryPersistenceError(
          "protected artifact write returned an invalid change count",
        );
      }
      return { changes: numeric };
    },
  };
}

type RawRow = Readonly<Record<string, unknown>>;

function rawRow<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  field: string,
): { readonly [P in K[number]]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TerminalRootRepositoryPersistenceError(`${field} row is absent or invalid`);
  }
  const row = value as RawRow;
  const result = Object.create(null) as Record<string, unknown>;
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error(`${key} is absent`);
      }
      result[key] = descriptor.value;
    }
  } catch (error) {
    throw new TerminalRootRepositoryPersistenceError(`${field} row is invalid`, { cause: error });
  }
  return result as { readonly [P in K[number]]: unknown };
}

const OPERATION_ROW_KEYS = [
  "operation_id",
  "operation_schema_id",
  "operation_digest",
  "kind",
  "root_path_certificate_id",
  "expected_prior_root_path_certificate_id",
  "collaboration_server_id",
  "logical_chat_id",
  "inward_edge_id",
  "terminal_topology_generation",
  "native_binding_id",
  "runtime_id",
  "native_incarnation",
  "native_binding_incarnation_id",
  "attachment_id",
  "attachment_lease_id",
  "transport_epoch",
  "native_conversation_lease_id",
  "native_conversation_lease_generation",
  "native_registration_publication_id",
  "publication_generation",
  "binding_gate_generation",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "coordinator_lease_id",
  "coordinator_epoch",
  "runtime_owner_identity_key_id",
  "runtime_owner_key_generation",
  "signer_sequence",
  "native_binding_evidence_digest",
  "canonical_payload_ref",
  "canonical_payload_digest",
  "signed_record_digest",
  "prepared_at_ms",
  "issued_at_ms",
  "expires_at_ms",
  "committed_at_ms",
  "state",
] as const;

const CERTIFICATE_ROW_KEYS = [
  "activation_operation_id",
  "signed_record_digest",
  "committed_at_ms",
  "schema_version",
  "canonical_payload_schema_id",
  "root_path_certificate_id",
  "kind",
  "terminal_native_binding_id",
  "terminal_server_id",
  "terminal_logical_chat_id",
  "terminal_topology_generation",
  "native_binding_evidence_digest",
  "runtime_owner_identity_key_id",
  "runtime_owner_key_generation",
  "signer_sequence",
  "issued_at_ms",
  "expires_at_ms",
  "signature_algorithm",
  "canonical_payload_digest_algorithm",
  "canonical_payload_digest",
  "signature",
] as const;

const CERTIFICATE_LINK_ROW_KEYS = [
  "root_path_certificate_id",
  "activation_operation_digest",
  "expected_prior_root_path_certificate_id",
  "runtime_id",
  "native_incarnation",
  "native_binding_incarnation_id",
  "attachment_id",
  "attachment_lease_id",
  "transport_epoch",
  "native_conversation_lease_id",
  "native_conversation_lease_generation",
  "native_registration_publication_id",
  "publication_generation",
  "binding_gate_generation",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "coordinator_lease_id",
  "coordinator_epoch",
  "canonical_payload_ref",
  "state",
] as const;

interface NativeRootCertificatePersistenceLink {
  readonly rootPathCertificateId: A1SafeId;
  readonly activationOperationDigest: A1Digest;
  readonly expectedPriorRootPathCertificateId: A1SafeId | null;
  readonly runtimeId: A1SafeId;
  readonly nativeIncarnation: number;
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly attachmentId: A1SafeId;
  readonly attachmentLeaseId: A1SafeId;
  readonly transportEpoch: number;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly nativeConversationLeaseGeneration: number;
  readonly nativeRegistrationPublicationId: A1SafeId;
  readonly publicationGeneration: number;
  readonly bindingGateGeneration: number;
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly coordinatorLeaseId: A1SafeId;
  readonly coordinatorEpoch: number;
  readonly canonicalPayloadRef: A1SafeId;
}

function selectColumns(keys: readonly string[]): string {
  return keys.join(", ");
}

function operationFromRow(value: unknown): NativeRootActivationOperationRecord {
  const row = rawRow(value, OPERATION_ROW_KEYS, "nativeRootActivationOperation");
  try {
    const parsed = parseNativeRootActivationOperationRecord({
      operationId: row.operation_id,
      operationSchemaId: row.operation_schema_id,
      operationDigest: row.operation_digest,
      kind: row.kind,
      rootPathCertificateId: row.root_path_certificate_id,
      expectedPriorRootPathCertificateId: row.expected_prior_root_path_certificate_id,
      collaborationServerId: row.collaboration_server_id,
      logicalChatId: row.logical_chat_id,
      inwardEdgeId: row.inward_edge_id,
      terminalTopologyGeneration: row.terminal_topology_generation,
      nativeBindingId: row.native_binding_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      nativeBindingIncarnationId: row.native_binding_incarnation_id,
      attachmentId: row.attachment_id,
      attachmentLeaseId: row.attachment_lease_id,
      transportEpoch: row.transport_epoch,
      nativeConversationLeaseId: row.native_conversation_lease_id,
      nativeConversationLeaseGeneration: row.native_conversation_lease_generation,
      nativeRegistrationPublicationId: row.native_registration_publication_id,
      publicationGeneration: row.publication_generation,
      bindingGateGeneration: row.binding_gate_generation,
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      coordinatorLeaseId: row.coordinator_lease_id,
      coordinatorEpoch: row.coordinator_epoch,
      runtimeOwnerIdentityKeyId: row.runtime_owner_identity_key_id,
      runtimeOwnerKeyGeneration: row.runtime_owner_key_generation,
      signerSequence: row.signer_sequence,
      nativeBindingEvidenceDigest: row.native_binding_evidence_digest,
      canonicalPayloadRef: row.canonical_payload_ref,
      canonicalPayloadDigest: row.canonical_payload_digest,
      signedRecordDigest: row.signed_record_digest,
      preparedAtMs: row.prepared_at_ms,
      issuedAtMs: row.issued_at_ms,
      expiresAtMs: row.expires_at_ms,
      committedAtMs: row.committed_at_ms,
      state: row.state,
    });
    verifyNativeRootActivationOperationDigest(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof TerminalRootRepositoryPersistenceError) throw error;
    throw new TerminalRootRepositoryPersistenceError(
      "native-root activation operation row is invalid",
      { cause: error },
    );
  }
}

function certificateFromRow(value: unknown): StoredNativeRootCertificate {
  const row = rawRow(value, CERTIFICATE_ROW_KEYS, "nativeRootCertificate");
  try {
    const certificate = parseNativeRootCertificate({
      schemaVersion: row.schema_version,
      canonicalPayloadSchemaId: row.canonical_payload_schema_id,
      rootPathCertificateId: row.root_path_certificate_id,
      kind: row.kind,
      terminalNativeBindingId: row.terminal_native_binding_id,
      terminalServerId: row.terminal_server_id,
      terminalLogicalChatId: row.terminal_logical_chat_id,
      terminalTopologyGeneration: row.terminal_topology_generation,
      nativeBindingEvidenceDigest: row.native_binding_evidence_digest,
      runtimeOwnerIdentityKeyId: row.runtime_owner_identity_key_id,
      runtimeOwnerKeyGeneration: row.runtime_owner_key_generation,
      signerSequence: row.signer_sequence,
      issuedAtMs: row.issued_at_ms,
      expiresAtMs: row.expires_at_ms,
      signatureAlgorithm: row.signature_algorithm,
      canonicalPayloadDigestAlgorithm: row.canonical_payload_digest_algorithm,
      canonicalPayloadDigest: row.canonical_payload_digest,
      signature: row.signature,
    });
    verifyNativeRootCanonicalPayloadDigest(certificate);
    const signedRecordDigest = parseA1Digest(
      row.signed_record_digest,
      "nativeRootCertificate.signedRecordDigest",
    );
    if (!sameDigest(signedRecordDigest, nativeRootSignedRecordDigest(certificate))) {
      throw new HostStateContractError(
        "nativeRootCertificate.signedRecordDigest does not match its signature",
      );
    }
    return frozen({
      activationOperationId: parseA1SafeId(
        row.activation_operation_id,
        "nativeRootCertificate.activationOperationId",
      ),
      signedRecordDigest,
      committedAtMs: parseNonNegativeSafeInteger(
        row.committed_at_ms,
        "nativeRootCertificate.committedAtMs",
      ),
      certificate,
    });
  } catch (error) {
    if (error instanceof TerminalRootRepositoryPersistenceError) throw error;
    throw new TerminalRootRepositoryPersistenceError("native-root certificate row is invalid", {
      cause: error,
    });
  }
}

function certificateLinkFromRow(value: unknown): NativeRootCertificatePersistenceLink {
  const row = rawRow(value, CERTIFICATE_LINK_ROW_KEYS, "nativeRootCertificateLink");
  try {
    if (row.state !== "activated") {
      throw new HostStateContractError("nativeRootCertificate.state must be activated");
    }
    return frozen({
      rootPathCertificateId: parseA1SafeId(
        row.root_path_certificate_id,
        "nativeRootCertificateLink.rootPathCertificateId",
      ),
      activationOperationDigest: parseA1Digest(
        row.activation_operation_digest,
        "nativeRootCertificateLink.activationOperationDigest",
      ),
      expectedPriorRootPathCertificateId: parseNullableSafeId(
        row.expected_prior_root_path_certificate_id,
        "nativeRootCertificateLink.expectedPriorRootPathCertificateId",
      ),
      runtimeId: parseA1CanonicalId(
        "nativeRuntime",
        row.runtime_id,
        "nativeRootCertificateLink.runtimeId",
      ),
      nativeIncarnation: parsePositiveSafeInteger(
        row.native_incarnation,
        "nativeRootCertificateLink.nativeIncarnation",
      ),
      nativeBindingIncarnationId: parseA1SafeId(
        row.native_binding_incarnation_id,
        "nativeRootCertificateLink.nativeBindingIncarnationId",
      ),
      attachmentId: parseA1SafeId(row.attachment_id, "nativeRootCertificateLink.attachmentId"),
      attachmentLeaseId: parseA1SafeId(
        row.attachment_lease_id,
        "nativeRootCertificateLink.attachmentLeaseId",
      ),
      transportEpoch: parsePositiveSafeInteger(
        row.transport_epoch,
        "nativeRootCertificateLink.transportEpoch",
      ),
      nativeConversationLeaseId: parseA1CanonicalId(
        "nativeConversationLease",
        row.native_conversation_lease_id,
        "nativeRootCertificateLink.nativeConversationLeaseId",
      ),
      nativeConversationLeaseGeneration: parsePositiveSafeInteger(
        row.native_conversation_lease_generation,
        "nativeRootCertificateLink.nativeConversationLeaseGeneration",
      ),
      nativeRegistrationPublicationId: parseA1SafeId(
        row.native_registration_publication_id,
        "nativeRootCertificateLink.nativeRegistrationPublicationId",
      ),
      publicationGeneration: parsePositiveSafeInteger(
        row.publication_generation,
        "nativeRootCertificateLink.publicationGeneration",
      ),
      bindingGateGeneration: parsePositiveSafeInteger(
        row.binding_gate_generation,
        "nativeRootCertificateLink.bindingGateGeneration",
      ),
      runtimeOwnerServiceLeaseId: parseA1SafeId(
        row.runtime_owner_service_lease_id,
        "nativeRootCertificateLink.runtimeOwnerServiceLeaseId",
      ),
      runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
        row.runtime_owner_service_epoch,
        "nativeRootCertificateLink.runtimeOwnerServiceEpoch",
      ),
      coordinatorLeaseId: parseA1CanonicalId(
        "coordinatorLease",
        row.coordinator_lease_id,
        "nativeRootCertificateLink.coordinatorLeaseId",
      ),
      coordinatorEpoch: parsePositiveSafeInteger(
        row.coordinator_epoch,
        "nativeRootCertificateLink.coordinatorEpoch",
      ),
      canonicalPayloadRef: parseA1CanonicalId(
        "protectedHandle",
        row.canonical_payload_ref,
        "nativeRootCertificateLink.canonicalPayloadRef",
      ),
    });
  } catch (error) {
    throw new TerminalRootRepositoryPersistenceError(
      "native-root certificate persistence linkage is invalid",
      { cause: error },
    );
  }
}

function findOperation(
  transaction: HostStateRepositorySqlTransaction,
  operationId: A1SafeId,
): NativeRootActivationOperationRecord | null {
  const value = sqlGet(
    transaction,
    `SELECT ${selectColumns(OPERATION_ROW_KEYS)} FROM native_root_activation_operations
      WHERE operation_id = ? LIMIT 1`,
    [operationId],
  );
  return value === undefined ? null : operationFromRow(value);
}

function findCertificate(
  transaction: HostStateRepositorySqlTransaction,
  rootPathCertificateId: A1SafeId,
): StoredNativeRootCertificate | null {
  const value = sqlGet(
    transaction,
    `SELECT ${selectColumns(CERTIFICATE_ROW_KEYS)} FROM native_root_certificates
      WHERE root_path_certificate_id = ? LIMIT 1`,
    [rootPathCertificateId],
  );
  return value === undefined ? null : certificateFromRow(value);
}

function findCertificateByOperation(
  transaction: HostStateRepositorySqlTransaction,
  operationId: A1SafeId,
): StoredNativeRootCertificate | null {
  const value = sqlGet(
    transaction,
    `SELECT ${selectColumns(CERTIFICATE_ROW_KEYS)} FROM native_root_certificates
      WHERE activation_operation_id = ? LIMIT 1`,
    [operationId],
  );
  return value === undefined ? null : certificateFromRow(value);
}

function readInventoryTransaction(
  transaction: HostStateRepositorySqlTransaction,
): TerminalRootInventory {
  return frozen({
    operations: frozen(
      sqlAll(
        transaction,
        `SELECT ${selectColumns(OPERATION_ROW_KEYS)} FROM native_root_activation_operations
          ORDER BY collaboration_server_id, logical_chat_id, prepared_at_ms, operation_id`,
      ).map(operationFromRow),
    ),
    certificates: frozen(
      sqlAll(
        transaction,
        `SELECT ${selectColumns(CERTIFICATE_ROW_KEYS)} FROM native_root_certificates
          ORDER BY terminal_server_id, terminal_logical_chat_id, issued_at_ms,
                   root_path_certificate_id`,
      ).map(certificateFromRow),
    ),
  });
}

interface CurrentRootGraph {
  readonly lease: NativeConversationLeaseRecord;
  readonly publication: NativeRegistrationPublicationRecord;
  readonly reservation: TerminalChatReservationResult;
  readonly runtime: NativeRuntimeRecord;
  readonly incarnation: NativeRuntimeIncarnationRecord;
  readonly assignment: RuntimeOwnerAssignmentRecord;
  readonly identityKey: RuntimeOwnerIdentityKeyRecord;
  readonly privateKey: RuntimeOwnerPrivateKeyEnvelopeRecord;
  readonly bindingIncarnation: NativeBindingIncarnationRecord;
  readonly attachment: NativeTransportAttachmentRecord;
  readonly attachmentLease: NativeTransportLeaseRecord;
  readonly gate: NativeBindingRuntimeGateRecord;
}

function sameOwnerFence(
  fence: RuntimeOwnerServiceFence,
  leaseId: A1SafeId,
  epoch: number,
): boolean {
  return fence.runtimeOwnerServiceLeaseId === leaseId && fence.runtimeOwnerServiceEpoch === epoch;
}

function sameCoordinatorFence(
  fence: CoordinatorLeaseFence,
  collaborationServerId: CollaborationServerId,
  leaseId: A1SafeId,
  epoch: number,
): boolean {
  return (
    fence.collaborationServerId === collaborationServerId &&
    fence.coordinatorLeaseId === leaseId &&
    fence.coordinatorEpoch === epoch
  );
}

function requireCurrentAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  fence: RuntimeOwnerServiceFence,
  coordinatorFence: CoordinatorLeaseFence,
  nowMs: number,
): void {
  const ownerValue = sqlGet(
    transaction,
    `SELECT s.current_runtime_owner_service_lease_id,
              s.current_runtime_owner_service_epoch,
              l.owner_instance_id, l.owner_process_start_identity_schema_id,
              l.owner_process_start_identity_ref, l.owner_process_start_identity_digest,
              l.acquired_at_ms, l.heartbeat_deadline_ms, l.released_at_ms, l.state
         FROM runtime_owner_state AS s
         LEFT JOIN runtime_owner_service_leases AS l
           ON l.runtime_owner_service_lease_id = s.current_runtime_owner_service_lease_id
          AND l.runtime_owner_service_epoch = s.current_runtime_owner_service_epoch
        WHERE s.machine_identity_id = ? LIMIT 1`,
    [machineIdentityId],
  );
  if (ownerValue === undefined) throw new TerminalRootStaleOwnerError();
  const owner = rawRow(
    ownerValue,
    [
      "current_runtime_owner_service_lease_id",
      "current_runtime_owner_service_epoch",
      "owner_instance_id",
      "owner_process_start_identity_schema_id",
      "owner_process_start_identity_ref",
      "owner_process_start_identity_digest",
      "acquired_at_ms",
      "heartbeat_deadline_ms",
      "released_at_ms",
      "state",
    ] as const,
    "terminalRootCurrentOwner",
  );
  if (
    owner.current_runtime_owner_service_lease_id !== fence.runtimeOwnerServiceLeaseId ||
    owner.current_runtime_owner_service_epoch !== fence.runtimeOwnerServiceEpoch ||
    owner.owner_instance_id !== fence.ownerInstanceId ||
    owner.owner_process_start_identity_schema_id !== fence.ownerProcessStartIdentitySchemaId ||
    owner.owner_process_start_identity_ref !== fence.ownerProcessStartIdentityRef ||
    owner.owner_process_start_identity_digest !== fence.ownerProcessStartIdentityDigest ||
    owner.state !== "current" ||
    owner.released_at_ms !== null ||
    typeof owner.acquired_at_ms !== "number" ||
    typeof owner.heartbeat_deadline_ms !== "number" ||
    nowMs < owner.acquired_at_ms ||
    nowMs >= owner.heartbeat_deadline_ms
  ) {
    throw new TerminalRootStaleOwnerError();
  }

  const coordinatorValue = sqlGet(
    transaction,
    `SELECT s.current_coordinator_lease_id, s.current_coordinator_epoch,
              l.acquired_at_ms, l.heartbeat_deadline_ms, l.released_at_ms, l.state
         FROM collaboration_servers AS s
         LEFT JOIN coordinator_leases AS l
           ON l.collaboration_server_id = s.collaboration_server_id
          AND l.coordinator_lease_id = s.current_coordinator_lease_id
          AND l.coordinator_epoch = s.current_coordinator_epoch
        WHERE s.collaboration_server_id = ? LIMIT 1`,
    [coordinatorFence.collaborationServerId],
  );
  if (coordinatorValue === undefined) throw new TerminalRootStaleCoordinatorError();
  const coordinator = rawRow(
    coordinatorValue,
    [
      "current_coordinator_lease_id",
      "current_coordinator_epoch",
      "acquired_at_ms",
      "heartbeat_deadline_ms",
      "released_at_ms",
      "state",
    ] as const,
    "terminalRootCurrentCoordinator",
  );
  if (
    coordinator.current_coordinator_lease_id !== coordinatorFence.coordinatorLeaseId ||
    coordinator.current_coordinator_epoch !== coordinatorFence.coordinatorEpoch ||
    coordinator.state !== "current" ||
    coordinator.released_at_ms !== null ||
    typeof coordinator.acquired_at_ms !== "number" ||
    typeof coordinator.heartbeat_deadline_ms !== "number" ||
    nowMs < coordinator.acquired_at_ms ||
    nowMs >= coordinator.heartbeat_deadline_ms
  ) {
    throw new TerminalRootStaleCoordinatorError();
  }
}

function findCurrentPublication(
  inventory: NativeRegistrationInventory,
  lease: NativeConversationLeaseRecord,
): NativeRegistrationPublicationRecord | undefined {
  return inventory.publications.find(
    (publication) =>
      publication.nativeRegistrationPublicationId === lease.currentPublicationId &&
      publication.nativeConversationLeaseId === lease.nativeConversationLeaseId &&
      publication.state === "current",
  );
}

function loadCurrentRootGraph(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  nativeConversationLeaseId: NativeConversationLeaseId,
  fence: RuntimeOwnerServiceFence,
  coordinatorFence: CoordinatorLeaseFence,
): CurrentRootGraph {
  const registration = createNativeRegistrationRepositoryTransactionOperations(
    transaction,
    machineIdentityId,
  );
  const records = createHostStateRepositoryTransactionOperations(transaction, machineIdentityId);
  const runtimeOwner = createRuntimeOwnerRepositoryTransactionOperations(
    transaction,
    machineIdentityId,
  );
  const lease = registration.readLease(nativeConversationLeaseId);
  if (lease === null) {
    throw new TerminalRootRepositoryConflictError("native conversation lease is unknown");
  }
  if (
    lease.state !== "ready" ||
    lease.nativeBindingIncarnationId === null ||
    lease.attachmentLeaseId === null ||
    lease.currentPublicationId === null
  ) {
    throw new TerminalRootRepositoryConflictError(
      "native conversation lease is not a bound, published, ready lease",
    );
  }
  if (!sameOwnerFence(fence, lease.runtimeOwnerServiceLeaseId, lease.runtimeOwnerServiceEpoch)) {
    throw new TerminalRootStaleOwnerError();
  }
  if (
    !sameCoordinatorFence(
      coordinatorFence,
      lease.collaborationServerId,
      lease.coordinatorLeaseId,
      lease.coordinatorEpoch,
    )
  ) {
    throw new TerminalRootStaleCoordinatorError();
  }
  const registrationInventory = registration.readInventory();
  const publication = findCurrentPublication(registrationInventory, lease);
  if (
    publication === undefined ||
    publication.nativeBindingId !== lease.nativeBindingId ||
    publication.runtimeId !== lease.runtimeId ||
    publication.nativeIncarnation !== lease.nativeIncarnation ||
    publication.nativeBindingIncarnationId !== lease.nativeBindingIncarnationId ||
    publication.attachmentLeaseId !== lease.attachmentLeaseId
  ) {
    throw new TerminalRootRepositoryPersistenceError(
      "current registration publication does not close its lease graph",
    );
  }
  const reservation = records.readTerminalReservation(
    lease.collaborationServerId,
    lease.registrationAttemptId,
  );
  if (
    reservation === null ||
    reservation.chat.logicalChatId !== lease.logicalChatId ||
    reservation.binding.nativeBindingId !== lease.nativeBindingId ||
    reservation.binding.state !== "current" ||
    reservation.binding.semanticConversationId === null ||
    reservation.chat.currentNativeBindingId !== lease.nativeBindingId ||
    reservation.chat.currentInwardEdgeId !== reservation.edge.inwardEdgeId ||
    reservation.chat.topologyGeneration <= 0 ||
    reservation.edge.targetKind !== "native-harness" ||
    reservation.edge.targetNativeBindingId !== lease.nativeBindingId ||
    reservation.edge.currentConnectionEpoch !== 0 ||
    reservation.edge.currentLiveLeaseId !== null ||
    reservation.edge.currentCapabilitySnapshotId !== null
  ) {
    throw new TerminalRootRepositoryPersistenceError(
      "terminal reservation does not close its current native binding and edge",
    );
  }

  const inventory: RuntimeOwnerInventory = runtimeOwner.readInventory();
  const runtime = inventory.runtimes.find((value) => value.runtimeId === lease.runtimeId);
  const incarnation = inventory.incarnations.find(
    (value) =>
      value.runtimeId === lease.runtimeId && value.nativeIncarnation === lease.nativeIncarnation,
  );
  const assignment = inventory.assignments.find(
    (value) => value.runtimeOwnerAssignmentId === runtime?.currentRuntimeOwnerAssignmentId,
  );
  const bindingIncarnation = inventory.bindingIncarnations.find(
    (value) => value.nativeBindingIncarnationId === lease.nativeBindingIncarnationId,
  );
  const attachmentLease = inventory.attachmentLeases.find(
    (value) => value.attachmentLeaseId === lease.attachmentLeaseId,
  );
  const attachment = inventory.attachments.find(
    (value) => value.attachmentId === attachmentLease?.attachmentId,
  );
  const gate = inventory.gates.find((value) => value.nativeBindingId === lease.nativeBindingId);
  const identityKey = inventory.identityKeys.find(
    (value) => value.runtimeId === lease.runtimeId && value.state === "current",
  );
  const privateKey = inventory.privateKeys.find(
    (value) =>
      value.runtimeId === lease.runtimeId &&
      value.runtimeOwnerIdentityKeyId === identityKey?.runtimeOwnerIdentityKeyId &&
      value.keyGeneration === identityKey?.keyGeneration,
  );
  if (
    runtime === undefined ||
    incarnation === undefined ||
    assignment === undefined ||
    bindingIncarnation === undefined ||
    attachment === undefined ||
    attachmentLease === undefined ||
    gate === undefined ||
    identityKey === undefined ||
    privateKey === undefined ||
    runtime.state !== "current" ||
    runtime.currentNativeIncarnation !== lease.nativeIncarnation ||
    incarnation.state !== "current" ||
    assignment.runtimeId !== lease.runtimeId ||
    assignment.nativeIncarnation !== lease.nativeIncarnation ||
    !sameOwnerFence(
      fence,
      assignment.runtimeOwnerServiceLeaseId,
      assignment.runtimeOwnerServiceEpoch,
    ) ||
    bindingIncarnation.state !== "current" ||
    bindingIncarnation.nativeBindingId !== lease.nativeBindingId ||
    bindingIncarnation.runtimeId !== lease.runtimeId ||
    bindingIncarnation.nativeIncarnation !== lease.nativeIncarnation ||
    bindingIncarnation.semanticConversationId !== reservation.binding.semanticConversationId ||
    attachment.state !== "current" ||
    attachment.nativeBindingId !== lease.nativeBindingId ||
    attachment.currentAttachmentLeaseId !== lease.attachmentLeaseId ||
    attachmentLease.state !== "current" ||
    attachmentLease.nativeBindingIncarnationId !== lease.nativeBindingIncarnationId ||
    attachmentLease.runtimeId !== lease.runtimeId ||
    attachmentLease.nativeIncarnation !== lease.nativeIncarnation ||
    !sameOwnerFence(
      fence,
      attachmentLease.runtimeOwnerServiceLeaseId,
      attachmentLease.runtimeOwnerServiceEpoch,
    ) ||
    !sameCoordinatorFence(
      coordinatorFence,
      lease.collaborationServerId,
      attachmentLease.coordinatorLeaseId,
      attachmentLease.coordinatorEpoch,
    ) ||
    gate.phase !== "ready" ||
    gate.nativeBindingIncarnationId !== lease.nativeBindingIncarnationId ||
    gate.currentAttachmentLeaseId !== lease.attachmentLeaseId ||
    identityKey.signingKeyRef === null ||
    privateKey.state !== "current" ||
    privateKey.signingKeyRef.protectedHandleId !== identityKey.signingKeyRef.protectedHandleId
  ) {
    throw new TerminalRootRepositoryConflictError(
      "terminal root prerequisites are not mutually current under the supplied fences",
    );
  }
  return frozen({
    lease,
    publication,
    reservation,
    runtime,
    incarnation,
    assignment,
    identityKey,
    privateKey,
    bindingIncarnation,
    attachment,
    attachmentLease,
    gate,
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function payloadInputFromOperation(
  operation: NativeRootActivationOperationRecord,
): NativeRootCanonicalPayloadInput {
  return frozen({
    schemaVersion: 1,
    canonicalPayloadSchemaId: NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
    rootPathCertificateId: operation.rootPathCertificateId,
    kind: "native-root",
    terminalNativeBindingId: operation.nativeBindingId,
    terminalServerId: operation.collaborationServerId,
    terminalLogicalChatId: operation.logicalChatId,
    terminalTopologyGeneration: operation.terminalTopologyGeneration,
    nativeBindingEvidenceDigest: operation.nativeBindingEvidenceDigest,
    runtimeOwnerIdentityKeyId: operation.runtimeOwnerIdentityKeyId,
    runtimeOwnerKeyGeneration: operation.runtimeOwnerKeyGeneration,
    signerSequence: operation.signerSequence,
    issuedAtMs: operation.issuedAtMs,
    expiresAtMs: operation.expiresAtMs,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
  });
}

function bindingEvidenceForGraph(graph: CurrentRootGraph): A1Digest {
  const nativeConversationId = graph.reservation.binding.semanticConversationId;
  if (nativeConversationId === null) {
    throw new TerminalRootRepositoryPersistenceError(
      "current binding has no semantic conversation identity",
    );
  }
  return nativeBindingEvidenceDigest({
    runtimeId: graph.runtime.runtimeId,
    nativeIncarnation: graph.incarnation.nativeIncarnation,
    nativeBindingId: graph.reservation.binding.nativeBindingId,
    descriptor: graph.reservation.binding.descriptor,
    nativeConversationId,
    attachmentLeaseId: graph.attachmentLease.attachmentLeaseId,
  });
}

function assertPrepareRequestMatchesOperation(
  machineIdentityId: string,
  request: PrepareNativeRootRequest,
  operation: NativeRootActivationOperationRecord,
): void {
  if (
    operation.operationId !== request.operationId ||
    operation.operationSchemaId !== NATIVE_ROOT_ACTIVATION_OPERATION_SCHEMA_ID ||
    operation.kind !== request.kind ||
    operation.rootPathCertificateId !==
      nativeRootCertificateId({
        machineIdentityId,
        collaborationServerId: operation.collaborationServerId,
        logicalChatId: operation.logicalChatId,
        operationId: request.operationId,
      }) ||
    operation.expectedPriorRootPathCertificateId !== request.expectedPriorRootPathCertificateId ||
    operation.nativeConversationLeaseId !== request.nativeConversationLeaseId ||
    operation.runtimeOwnerServiceLeaseId !== request.fence.runtimeOwnerServiceLeaseId ||
    operation.runtimeOwnerServiceEpoch !== request.fence.runtimeOwnerServiceEpoch ||
    operation.collaborationServerId !== request.coordinatorFence.collaborationServerId ||
    operation.coordinatorLeaseId !== request.coordinatorFence.coordinatorLeaseId ||
    operation.coordinatorEpoch !== request.coordinatorFence.coordinatorEpoch ||
    operation.expiresAtMs - operation.issuedAtMs !== request.ttlMs
  ) {
    throw new TerminalRootRepositoryConflictError("activation operation request collided");
  }
}

function assertOperationMatchesGraph(
  operation: NativeRootActivationOperationRecord,
  graph: CurrentRootGraph,
): void {
  const evidenceDigest = bindingEvidenceForGraph(graph);
  if (
    operation.collaborationServerId !== graph.lease.collaborationServerId ||
    operation.logicalChatId !== graph.lease.logicalChatId ||
    operation.inwardEdgeId !== graph.reservation.edge.inwardEdgeId ||
    operation.terminalTopologyGeneration !== graph.reservation.chat.topologyGeneration ||
    operation.nativeBindingId !== graph.lease.nativeBindingId ||
    operation.runtimeId !== graph.lease.runtimeId ||
    operation.nativeIncarnation !== graph.lease.nativeIncarnation ||
    operation.nativeBindingIncarnationId !== graph.bindingIncarnation.nativeBindingIncarnationId ||
    operation.attachmentId !== graph.attachment.attachmentId ||
    operation.attachmentLeaseId !== graph.attachmentLease.attachmentLeaseId ||
    operation.transportEpoch !== graph.attachmentLease.transportEpoch ||
    operation.nativeConversationLeaseId !== graph.lease.nativeConversationLeaseId ||
    operation.nativeConversationLeaseGeneration !== graph.lease.leaseGeneration ||
    operation.nativeRegistrationPublicationId !==
      graph.publication.nativeRegistrationPublicationId ||
    operation.publicationGeneration !== graph.publication.publicationGeneration ||
    operation.bindingGateGeneration !== graph.gate.gateGeneration ||
    operation.runtimeOwnerServiceLeaseId !== graph.lease.runtimeOwnerServiceLeaseId ||
    operation.runtimeOwnerServiceEpoch !== graph.lease.runtimeOwnerServiceEpoch ||
    operation.coordinatorLeaseId !== graph.lease.coordinatorLeaseId ||
    operation.coordinatorEpoch !== graph.lease.coordinatorEpoch ||
    operation.runtimeOwnerIdentityKeyId !== graph.identityKey.runtimeOwnerIdentityKeyId ||
    operation.runtimeOwnerKeyGeneration !== graph.identityKey.keyGeneration ||
    !sameDigest(operation.nativeBindingEvidenceDigest, evidenceDigest)
  ) {
    throw new TerminalRootRepositoryConflictError(
      "activation operation no longer matches the current registration graph",
    );
  }
  const payload = payloadInputFromOperation(operation);
  if (!sameDigest(operation.canonicalPayloadDigest, nativeRootCanonicalPayloadDigest(payload))) {
    throw new TerminalRootRepositoryPersistenceError(
      "activation operation canonical payload digest is inconsistent",
    );
  }
}

function findLatestCertificateForChat(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  logicalChatId: A1SafeId,
): StoredNativeRootCertificate | null {
  const value = sqlGet(
    transaction,
    `SELECT ${selectColumns(CERTIFICATE_ROW_KEYS)} FROM native_root_certificates AS certificate
      WHERE certificate.terminal_server_id = ? AND certificate.terminal_logical_chat_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM native_root_activation_operations AS successor
          WHERE successor.expected_prior_root_path_certificate_id =
            certificate.root_path_certificate_id
            AND successor.state = 'committed'
        )
      LIMIT 1`,
    [collaborationServerId, logicalChatId],
  );
  return value === undefined ? null : certificateFromRow(value);
}

function assertRequestedLineage(
  transaction: HostStateRepositorySqlTransaction,
  request: PrepareNativeRootRequest,
  graph: CurrentRootGraph,
): void {
  const latest = findLatestCertificateForChat(
    transaction,
    graph.lease.collaborationServerId,
    graph.lease.logicalChatId,
  );
  if (request.kind === "activate") {
    if (
      latest !== null ||
      graph.reservation.chat.state !== "recovering" ||
      graph.reservation.edge.state !== "installing" ||
      graph.reservation.edge.rootPathCertificateId !== null
    ) {
      throw new TerminalRootRepositoryConflictError(
        "initial activation requires an unrooted recovering terminal graph with no history",
      );
    }
    return;
  }
  if (
    latest === null ||
    latest.certificate.rootPathCertificateId !== request.expectedPriorRootPathCertificateId ||
    latest.certificate.terminalServerId !== graph.lease.collaborationServerId ||
    latest.certificate.terminalLogicalChatId !== graph.lease.logicalChatId ||
    latest.certificate.terminalNativeBindingId !== graph.lease.nativeBindingId
  ) {
    throw new TerminalRootRepositoryConflictError(
      "renewal does not name the exact latest terminal-root certificate",
    );
  }
  const rooted =
    graph.reservation.chat.state === "ready" &&
    graph.reservation.edge.state === "current" &&
    graph.reservation.edge.rootPathCertificateId === request.expectedPriorRootPathCertificateId;
  const demoted =
    graph.reservation.chat.state === "recovering" &&
    graph.reservation.edge.state === "installing" &&
    graph.reservation.edge.rootPathCertificateId === null;
  if (!rooted && !demoted) {
    throw new TerminalRootRepositoryConflictError(
      "renewal requires the latest rooted graph or its exact demoted form",
    );
  }
}

function readPayloadArtifact(
  transaction: HostStateRepositorySqlTransaction,
  operation: NativeRootActivationOperationRecord,
): ProtectedByteSnapshot {
  try {
    const result = createProtectedArtifactTransactionOperations(
      artifactTransaction(transaction),
    ).readVerifiedArtifact({
      scopeKind: "native_binding",
      scopeId: operation.nativeBindingId,
      artifactRef: frozen({
        protectedHandleId: operation.canonicalPayloadRef,
        kind: "artifact" as const,
      }),
      artifactSchemaId: NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
      expectedArtifactDigest: operation.canonicalPayloadDigest,
    });
    const actual = result.artifactBytes.copyBytes();
    const expected = canonicalNativeRootPayload(payloadInputFromOperation(operation));
    try {
      if (!sameBytes(actual, expected)) {
        throw new TerminalRootRepositoryPersistenceError(
          "native-root payload artifact does not contain the canonical operation payload",
        );
      }
    } finally {
      actual.fill(0);
      expected.fill(0);
    }
    return result.artifactBytes;
  } catch (error) {
    if (error instanceof TerminalRootRepositoryPersistenceError) throw error;
    throw new TerminalRootRepositoryPersistenceError(
      "native-root payload artifact could not be verified",
      { cause: error },
    );
  }
}

interface RuntimeOwnerSignatureEvidenceIndex {
  readonly identityKeys: ReadonlyMap<string, RuntimeOwnerIdentityKeyRecord>;
  readonly privateKeys: ReadonlyMap<string, RuntimeOwnerPrivateKeyEnvelopeRecord>;
  readonly reservations: ReadonlyMap<string, RuntimeOwnerSignatureReservationRecord>;
}

function runtimeOwnerKeyTuple(
  runtimeId: string,
  runtimeOwnerIdentityKeyId: string,
  keyGeneration: number,
): string {
  return `${runtimeId}\u0000${runtimeOwnerIdentityKeyId}\u0000${keyGeneration}`;
}

function runtimeOwnerSignerTuple(
  runtimeId: string,
  runtimeOwnerIdentityKeyId: string,
  keyGeneration: number,
  signerSequence: number,
): string {
  return `${runtimeOwnerKeyTuple(
    runtimeId,
    runtimeOwnerIdentityKeyId,
    keyGeneration,
  )}\u0000${signerSequence}`;
}

function indexRuntimeOwnerSignatureEvidence(
  inventory: RuntimeOwnerInventory,
): RuntimeOwnerSignatureEvidenceIndex {
  const identityKeys = new Map<string, RuntimeOwnerIdentityKeyRecord>();
  const privateKeys = new Map<string, RuntimeOwnerPrivateKeyEnvelopeRecord>();
  const reservations = new Map<string, RuntimeOwnerSignatureReservationRecord>();
  for (const identityKey of inventory.identityKeys) {
    const key = runtimeOwnerKeyTuple(
      identityKey.runtimeId,
      identityKey.runtimeOwnerIdentityKeyId,
      identityKey.keyGeneration,
    );
    if (identityKeys.has(key)) {
      throw new TerminalRootRepositoryPersistenceError(
        "runtime-owner identity-key evidence has a duplicate tuple",
      );
    }
    identityKeys.set(key, identityKey);
  }
  for (const privateKey of inventory.privateKeys) {
    const key = runtimeOwnerKeyTuple(
      privateKey.runtimeId,
      privateKey.runtimeOwnerIdentityKeyId,
      privateKey.keyGeneration,
    );
    if (privateKeys.has(key)) {
      throw new TerminalRootRepositoryPersistenceError(
        "runtime-owner private-key evidence has a duplicate tuple",
      );
    }
    privateKeys.set(key, privateKey);
  }
  for (const reservation of inventory.signatureReservations) {
    const key = runtimeOwnerSignerTuple(
      reservation.runtimeId,
      reservation.runtimeOwnerIdentityKeyId,
      reservation.runtimeOwnerKeyGeneration,
      reservation.signerSequence,
    );
    if (reservations.has(key)) {
      throw new TerminalRootRepositoryPersistenceError(
        "runtime-owner signature evidence has a duplicate tuple",
      );
    }
    reservations.set(key, reservation);
  }
  return frozen({ identityKeys, privateKeys, reservations });
}

function signatureEvidenceForOperation(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  operation: NativeRootActivationOperationRecord,
  indexed?: RuntimeOwnerSignatureEvidenceIndex,
): Readonly<{
  identityKey: RuntimeOwnerIdentityKeyRecord;
  privateKey: RuntimeOwnerPrivateKeyEnvelopeRecord;
  reservation: RuntimeOwnerSignatureReservationRecord;
}> {
  const evidence =
    indexed ??
    indexRuntimeOwnerSignatureEvidence(
      createRuntimeOwnerRepositoryTransactionOperations(
        transaction,
        machineIdentityId,
      ).readInventory(),
    );
  const identityKey = evidence.identityKeys.get(
    runtimeOwnerKeyTuple(
      operation.runtimeId,
      operation.runtimeOwnerIdentityKeyId,
      operation.runtimeOwnerKeyGeneration,
    ),
  );
  const privateKey = evidence.privateKeys.get(
    runtimeOwnerKeyTuple(
      operation.runtimeId,
      operation.runtimeOwnerIdentityKeyId,
      operation.runtimeOwnerKeyGeneration,
    ),
  );
  const reservation = evidence.reservations.get(
    runtimeOwnerSignerTuple(
      operation.runtimeId,
      operation.runtimeOwnerIdentityKeyId,
      operation.runtimeOwnerKeyGeneration,
      operation.signerSequence,
    ),
  );
  if (
    identityKey === undefined ||
    privateKey === undefined ||
    reservation === undefined ||
    reservation.purpose !== "native_root" ||
    reservation.canonicalPayloadSchemaId !== NATIVE_ROOT_CERTIFICATE_SCHEMA_ID ||
    reservation.canonicalPayloadRef !== operation.canonicalPayloadRef ||
    reservation.canonicalPayloadDigest === null ||
    !sameDigest(reservation.canonicalPayloadDigest, operation.canonicalPayloadDigest) ||
    (operation.state === "prepared" && reservation.state !== "bound") ||
    (operation.state === "committed" && reservation.state !== "signed")
  ) {
    throw new TerminalRootRepositoryPersistenceError(
      "activation operation does not close its signer reservation and key evidence",
    );
  }
  return frozen({ identityKey, privateKey, reservation });
}

function assertEd25519Signature(
  publicKey: RuntimeOwnerIdentityKeyRecord["publicKey"],
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
    if (!verifySignature(null, payloadBytes, key, signatureBytes)) {
      throw new TerminalRootRepositoryConflictError(
        "native-root signature does not verify under the reserved runtime-owner key",
      );
    }
  } catch (error) {
    if (error instanceof TerminalRootRepositoryConflictError) throw error;
    throw new TerminalRootRepositoryConflictError(
      "native-root signature could not be verified under the reserved runtime-owner key",
    );
  } finally {
    payloadBytes.fill(0);
    signatureBytes.fill(0);
  }
}

class BoundTerminalRootRepository implements TerminalRootRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #nowMs: () => number;
  readonly #randomBytes: ((byteLength: number) => Uint8Array) | undefined;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    options: TerminalRootRepositoryOptions = {},
  ) {
    if (
      typeof executor !== "object" ||
      executor === null ||
      typeof executor.transaction !== "function"
    ) {
      throw new HostStateContractError(
        "terminal-root repository executor must provide transaction",
      );
    }
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#nowMs = options.nowMs ?? Date.now;
    this.#randomBytes = options.randomBytes;
  }

  prepare(request: PrepareNativeRootRequest): NativeRootPreparationResult {
    const parsed = parsePrepareRequest(request);
    return this.#executor.transaction((transaction) => {
      const nowMs = currentTime(this.#nowMs);
      requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        nowMs,
      );
      const replay = findOperation(transaction, parsed.operationId);
      if (replay !== null) {
        assertPrepareRequestMatchesOperation(this.#machineIdentityId, parsed, replay);
        if (replay.state === "prepared") {
          if (nowMs >= replay.expiresAtMs) {
            throw new TerminalRootRepositoryConflictError(
              "prepared activation operation has expired",
            );
          }
          const graph = loadCurrentRootGraph(
            transaction,
            this.#machineIdentityId,
            parsed.nativeConversationLeaseId,
            parsed.fence,
            parsed.coordinatorFence,
          );
          assertOperationMatchesGraph(replay, graph);
          assertRequestedLineage(transaction, parsed, graph);
        }
        const evidence = signatureEvidenceForOperation(
          transaction,
          this.#machineIdentityId,
          replay,
        );
        return frozen({
          operation: replay,
          canonicalPayload: readPayloadArtifact(transaction, replay),
          identityKey: evidence.identityKey,
          privateKey: evidence.privateKey,
          signatureReservation: evidence.reservation,
          replayed: true,
        });
      }

      const graph = loadCurrentRootGraph(
        transaction,
        this.#machineIdentityId,
        parsed.nativeConversationLeaseId,
        parsed.fence,
        parsed.coordinatorFence,
      );
      assertRequestedLineage(transaction, parsed, graph);
      if (
        graph.identityKey.state !== "current" ||
        graph.identityKey.signingKeyRef === null ||
        graph.privateKey.state !== "current" ||
        graph.privateKey.destroyedAtMs !== null
      ) {
        throw new TerminalRootRepositoryConflictError(
          "runtime-owner identity key is not available for native-root signing",
        );
      }
      const runtimeOwner = createRuntimeOwnerRepositoryTransactionOperations(
        transaction,
        this.#machineIdentityId,
        this.#nowMs,
      );
      const reserved = runtimeOwner.reserveSignature({
        fence: parsed.fence,
        runtimeId: graph.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: graph.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: graph.identityKey.keyGeneration,
        expectedSignerSequence: graph.identityKey.nextSignerSequence,
        purpose: "native_root",
      }).reservation;
      const rootPathCertificateId = nativeRootCertificateId({
        machineIdentityId: this.#machineIdentityId,
        collaborationServerId: graph.lease.collaborationServerId,
        logicalChatId: graph.lease.logicalChatId,
        operationId: parsed.operationId,
      });
      const expiresAtMs = checkedAdd(nowMs, parsed.ttlMs, "native-root expiry");
      const payloadInput: NativeRootCanonicalPayloadInput = frozen({
        schemaVersion: 1,
        canonicalPayloadSchemaId: NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
        rootPathCertificateId,
        kind: "native-root",
        terminalNativeBindingId: graph.lease.nativeBindingId,
        terminalServerId: graph.lease.collaborationServerId,
        terminalLogicalChatId: graph.lease.logicalChatId,
        terminalTopologyGeneration: graph.reservation.chat.topologyGeneration,
        nativeBindingEvidenceDigest: bindingEvidenceForGraph(graph),
        runtimeOwnerIdentityKeyId: graph.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: graph.identityKey.keyGeneration,
        signerSequence: reserved.signerSequence,
        issuedAtMs: nowMs,
        expiresAtMs,
        signatureAlgorithm: "Ed25519",
        canonicalPayloadDigestAlgorithm: "SHA-256",
      });
      const payloadBytes = canonicalNativeRootPayload(payloadInput);
      const canonicalPayload = ProtectedByteSnapshot.from(payloadBytes);
      payloadBytes.fill(0);
      const canonicalPayloadDigest = nativeRootCanonicalPayloadDigest(payloadInput);
      const artifact = createProtectedArtifactTransactionOperations(
        artifactTransaction(transaction),
        {
          ...(this.#randomBytes === undefined ? {} : { randomBytes: this.#randomBytes }),
          nowMs: this.#nowMs,
        },
      ).putArtifact({
        scopeKind: "native_binding",
        scopeId: graph.lease.nativeBindingId,
        artifactSchemaId: NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
        artifactDigest: canonicalPayloadDigest,
        artifactBytes: canonicalPayload,
      });
      const bound = runtimeOwner.bindSignature({
        fence: parsed.fence,
        runtimeId: graph.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: graph.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: graph.identityKey.keyGeneration,
        signerSequence: reserved.signerSequence,
        canonicalPayloadSchemaId: NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
        canonicalPayloadRef: artifact.artifactRef.protectedHandleId,
        canonicalPayloadDigest,
      }).reservation;
      const preparation: NativeRootActivationPreparationInput = frozen({
        operationId: parsed.operationId,
        operationSchemaId: NATIVE_ROOT_ACTIVATION_OPERATION_SCHEMA_ID,
        kind: parsed.kind,
        rootPathCertificateId,
        expectedPriorRootPathCertificateId: parsed.expectedPriorRootPathCertificateId,
        collaborationServerId: graph.lease.collaborationServerId,
        logicalChatId: graph.lease.logicalChatId,
        inwardEdgeId: graph.reservation.edge.inwardEdgeId,
        terminalTopologyGeneration: graph.reservation.chat.topologyGeneration,
        nativeBindingId: graph.lease.nativeBindingId,
        runtimeId: graph.runtime.runtimeId,
        nativeIncarnation: graph.incarnation.nativeIncarnation,
        nativeBindingIncarnationId: graph.bindingIncarnation.nativeBindingIncarnationId,
        attachmentId: graph.attachment.attachmentId,
        attachmentLeaseId: graph.attachmentLease.attachmentLeaseId,
        transportEpoch: graph.attachmentLease.transportEpoch,
        nativeConversationLeaseId: graph.lease.nativeConversationLeaseId,
        nativeConversationLeaseGeneration: graph.lease.leaseGeneration,
        nativeRegistrationPublicationId: graph.publication.nativeRegistrationPublicationId,
        publicationGeneration: graph.publication.publicationGeneration,
        bindingGateGeneration: graph.gate.gateGeneration,
        runtimeOwnerServiceLeaseId: graph.lease.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: graph.lease.runtimeOwnerServiceEpoch,
        coordinatorLeaseId: graph.lease.coordinatorLeaseId,
        coordinatorEpoch: graph.lease.coordinatorEpoch,
        runtimeOwnerIdentityKeyId: graph.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: graph.identityKey.keyGeneration,
        signerSequence: reserved.signerSequence,
        nativeBindingEvidenceDigest: payloadInput.nativeBindingEvidenceDigest,
        canonicalPayloadRef: artifact.artifactRef.protectedHandleId,
        canonicalPayloadDigest,
        preparedAtMs: nowMs,
        issuedAtMs: nowMs,
        expiresAtMs,
      });
      const operation = parseNativeRootActivationOperationRecord({
        ...preparation,
        operationDigest: nativeRootActivationOperationDigest(preparation),
        signedRecordDigest: null,
        committedAtMs: null,
        state: "prepared",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO native_root_activation_operations (
          operation_id, operation_schema_id, operation_digest, kind,
          root_path_certificate_id, expected_prior_root_path_certificate_id,
          collaboration_server_id, logical_chat_id, inward_edge_id,
          terminal_topology_generation, native_binding_id, runtime_id, native_incarnation,
          native_binding_incarnation_id, attachment_id, attachment_lease_id, transport_epoch,
          native_conversation_lease_id, native_conversation_lease_generation,
          native_registration_publication_id, publication_generation, binding_gate_generation,
          runtime_owner_service_lease_id, runtime_owner_service_epoch,
          coordinator_lease_id, coordinator_epoch, runtime_owner_identity_key_id,
          runtime_owner_key_generation, signer_sequence, native_binding_evidence_digest,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          prepared_at_ms, issued_at_ms, expires_at_ms, committed_at_ms, state
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'prepared'
        )`,
        [
          operation.operationId,
          operation.operationSchemaId,
          operation.operationDigest,
          operation.kind,
          operation.rootPathCertificateId,
          operation.expectedPriorRootPathCertificateId,
          operation.collaborationServerId,
          operation.logicalChatId,
          operation.inwardEdgeId,
          operation.terminalTopologyGeneration,
          operation.nativeBindingId,
          operation.runtimeId,
          operation.nativeIncarnation,
          operation.nativeBindingIncarnationId,
          operation.attachmentId,
          operation.attachmentLeaseId,
          operation.transportEpoch,
          operation.nativeConversationLeaseId,
          operation.nativeConversationLeaseGeneration,
          operation.nativeRegistrationPublicationId,
          operation.publicationGeneration,
          operation.bindingGateGeneration,
          operation.runtimeOwnerServiceLeaseId,
          operation.runtimeOwnerServiceEpoch,
          operation.coordinatorLeaseId,
          operation.coordinatorEpoch,
          operation.runtimeOwnerIdentityKeyId,
          operation.runtimeOwnerKeyGeneration,
          operation.signerSequence,
          operation.nativeBindingEvidenceDigest,
          operation.canonicalPayloadRef,
          operation.canonicalPayloadDigest,
          operation.preparedAtMs,
          operation.issuedAtMs,
          operation.expiresAtMs,
        ],
        "native-root activation preparation insert",
      );
      return frozen({
        operation,
        canonicalPayload,
        identityKey: graph.identityKey,
        privateKey: graph.privateKey,
        signatureReservation: bound,
        replayed: false,
      });
    });
  }

  finalize(request: FinalizeNativeRootRequest): NativeRootActivationResult {
    const parsed = parseFinalizeRequest(request);
    return this.#executor.transaction((transaction) => {
      const nowMs = currentTime(this.#nowMs);
      requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        nowMs,
      );
      const operation = findOperation(transaction, parsed.operationId);
      if (operation === null) {
        throw new TerminalRootRepositoryConflictError("activation operation is unknown");
      }
      if (
        operation.runtimeOwnerServiceLeaseId !== parsed.fence.runtimeOwnerServiceLeaseId ||
        operation.runtimeOwnerServiceEpoch !== parsed.fence.runtimeOwnerServiceEpoch ||
        operation.collaborationServerId !== parsed.coordinatorFence.collaborationServerId ||
        operation.coordinatorLeaseId !== parsed.coordinatorFence.coordinatorLeaseId ||
        operation.coordinatorEpoch !== parsed.coordinatorFence.coordinatorEpoch
      ) {
        throw new TerminalRootRepositoryConflictError("activation finalization fence collided");
      }
      if (operation.state === "committed") {
        const storedCertificate = findCertificateByOperation(transaction, operation.operationId);
        if (
          storedCertificate === null ||
          storedCertificate.certificate.signature !== parsed.signature
        ) {
          throw new TerminalRootRepositoryConflictError("activation finalization replay collided");
        }
        return frozen({ operation, storedCertificate, replayed: true });
      }
      if (nowMs >= operation.expiresAtMs) {
        throw new TerminalRootRepositoryConflictError("activation operation has expired");
      }
      const graph = loadCurrentRootGraph(
        transaction,
        this.#machineIdentityId,
        operation.nativeConversationLeaseId,
        parsed.fence,
        parsed.coordinatorFence,
      );
      assertOperationMatchesGraph(operation, graph);
      assertRequestedLineage(
        transaction,
        frozen({
          fence: parsed.fence,
          coordinatorFence: parsed.coordinatorFence,
          operationId: operation.operationId,
          kind: operation.kind,
          nativeConversationLeaseId: operation.nativeConversationLeaseId,
          expectedPriorRootPathCertificateId: operation.expectedPriorRootPathCertificateId,
          ttlMs: operation.expiresAtMs - operation.issuedAtMs,
        }),
        graph,
      );
      const evidence = signatureEvidenceForOperation(
        transaction,
        this.#machineIdentityId,
        operation,
      );
      if (
        evidence.identityKey.state !== "current" ||
        evidence.privateKey.state !== "current" ||
        evidence.privateKey.destroyedAtMs !== null
      ) {
        throw new TerminalRootRepositoryConflictError(
          "reserved runtime-owner identity key is no longer current",
        );
      }
      const canonicalPayload = readPayloadArtifact(transaction, operation);
      assertEd25519Signature(evidence.identityKey.publicKey, canonicalPayload, parsed.signature);
      const certificate = parseNativeRootCertificate({
        ...payloadInputFromOperation(operation),
        canonicalPayloadDigest: operation.canonicalPayloadDigest,
        signature: parsed.signature,
      });
      const signedRecordDigest = nativeRootSignedRecordDigest(certificate);
      const signatureFinalization = finalizeRuntimeOwnerNativeRootSignatureInTransaction(
        transaction,
        this.#machineIdentityId,
        operation.operationId,
        {
          fence: parsed.fence,
          runtimeId: operation.runtimeId,
          runtimeOwnerIdentityKeyId: operation.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: operation.runtimeOwnerKeyGeneration,
          signerSequence: operation.signerSequence,
          signedRecordDigest,
          signature: parsed.signature,
          signedArtifactId: operation.rootPathCertificateId,
        },
        this.#nowMs,
      );
      const { acceptance } = signatureFinalization;
      requireCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        acceptance.acceptedAtMs,
      );
      if (
        acceptance.acceptedAtMs < operation.issuedAtMs ||
        acceptance.acceptedAtMs >= operation.expiresAtMs
      ) {
        throw new TerminalRootRepositoryConflictError(
          "native-root signature acceptance is outside the certificate validity interval",
        );
      }
      runExactlyOne(
        transaction,
        `INSERT INTO native_root_certificates (
          root_path_certificate_id, activation_operation_id, activation_operation_digest,
          expected_prior_root_path_certificate_id, schema_version,
          canonical_payload_schema_id, kind, terminal_native_binding_id, terminal_server_id,
          terminal_logical_chat_id, terminal_topology_generation,
          native_binding_evidence_digest, runtime_id, native_incarnation,
          native_binding_incarnation_id, attachment_id, attachment_lease_id, transport_epoch,
          native_conversation_lease_id, native_conversation_lease_generation,
          native_registration_publication_id, publication_generation, binding_gate_generation,
          runtime_owner_service_lease_id, runtime_owner_service_epoch,
          coordinator_lease_id, coordinator_epoch, runtime_owner_identity_key_id,
          runtime_owner_key_generation, signer_sequence, issued_at_ms, expires_at_ms,
          signature_algorithm, canonical_payload_digest_algorithm, canonical_payload_ref,
          canonical_payload_digest, signed_record_digest, signature, committed_at_ms, state
        ) VALUES (
          ?, ?, ?, ?, 1, ?, 'native-root', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ed25519', 'SHA-256', ?, ?, ?, ?, ?, 'activated'
        )`,
        [
          certificate.rootPathCertificateId,
          operation.operationId,
          operation.operationDigest,
          operation.expectedPriorRootPathCertificateId,
          certificate.canonicalPayloadSchemaId,
          certificate.terminalNativeBindingId,
          certificate.terminalServerId,
          certificate.terminalLogicalChatId,
          certificate.terminalTopologyGeneration,
          certificate.nativeBindingEvidenceDigest,
          operation.runtimeId,
          operation.nativeIncarnation,
          operation.nativeBindingIncarnationId,
          operation.attachmentId,
          operation.attachmentLeaseId,
          operation.transportEpoch,
          operation.nativeConversationLeaseId,
          operation.nativeConversationLeaseGeneration,
          operation.nativeRegistrationPublicationId,
          operation.publicationGeneration,
          operation.bindingGateGeneration,
          operation.runtimeOwnerServiceLeaseId,
          operation.runtimeOwnerServiceEpoch,
          operation.coordinatorLeaseId,
          operation.coordinatorEpoch,
          certificate.runtimeOwnerIdentityKeyId,
          certificate.runtimeOwnerKeyGeneration,
          certificate.signerSequence,
          certificate.issuedAtMs,
          certificate.expiresAtMs,
          operation.canonicalPayloadRef,
          certificate.canonicalPayloadDigest,
          signedRecordDigest,
          certificate.signature,
          acceptance.acceptedAtMs,
        ],
        "native-root certificate activation insert",
      );
      const committedOperation = findOperation(transaction, operation.operationId);
      const storedCertificate = findCertificateByOperation(transaction, operation.operationId);
      if (
        committedOperation === null ||
        committedOperation.state !== "committed" ||
        storedCertificate === null ||
        committedOperation.signedRecordDigest === null ||
        !sameDigest(committedOperation.signedRecordDigest, signedRecordDigest) ||
        committedOperation.committedAtMs !== acceptance.acceptedAtMs
      ) {
        throw new TerminalRootRepositoryPersistenceError(
          "native-root certificate finalizer did not close the activation graph",
        );
      }
      return frozen({ operation: committedOperation, storedCertificate, replayed: false });
    });
  }

  reconcileOperation(request: PrepareNativeRootRequest): NativeRootOperationReconciliation | null {
    const parsed = parsePrepareRequest(request);
    return this.#executor.transaction((transaction) => {
      const operation = findOperation(transaction, parsed.operationId);
      if (operation === null) return null;
      assertPrepareRequestMatchesOperation(this.#machineIdentityId, parsed, operation);
      const storedCertificate = findCertificateByOperation(transaction, operation.operationId);
      if ((operation.state === "committed") !== (storedCertificate !== null)) {
        throw new TerminalRootRepositoryPersistenceError(
          "activation operation and certificate finalization are incomplete",
        );
      }
      readPayloadArtifact(transaction, operation);
      signatureEvidenceForOperation(transaction, this.#machineIdentityId, operation);
      return frozen({ operation, storedCertificate });
    });
  }

  readOperation(operationId: A1SafeId): NativeRootActivationOperationRecord | null {
    const parsed = parseA1SafeId(operationId, "terminalRoot.readOperation.operationId");
    return this.#executor.transaction((transaction) => findOperation(transaction, parsed));
  }

  readCertificate(rootPathCertificateId: A1SafeId): StoredNativeRootCertificate | null {
    const parsed = parseA1SafeId(
      rootPathCertificateId,
      "terminalRoot.readCertificate.rootPathCertificateId",
    );
    return this.#executor.transaction((transaction) => findCertificate(transaction, parsed));
  }

  readCurrentCertificate(
    collaborationServerId: CollaborationServerId,
    nativeConversationLeaseId: NativeConversationLeaseId,
  ): StoredNativeRootCertificate | null {
    const serverId = parseA1CanonicalId(
      "collaborationServer",
      collaborationServerId,
      "terminalRoot.readCurrentCertificate.collaborationServerId",
    );
    const leaseId = parseA1CanonicalId(
      "nativeConversationLease",
      nativeConversationLeaseId,
      "terminalRoot.readCurrentCertificate.nativeConversationLeaseId",
    );
    return this.#executor.transaction((transaction) => {
      const value = sqlGet(
        transaction,
        `SELECT ${CERTIFICATE_ROW_KEYS.map((column) => `certificate.${column}`).join(", ")}
           FROM native_root_certificates AS certificate
           JOIN native_root_activation_operations AS operation
             ON operation.operation_id = certificate.activation_operation_id
           JOIN inward_collaboration_edges AS edge
             ON edge.inward_edge_id = operation.inward_edge_id
            AND edge.represented_server_id = operation.collaboration_server_id
            AND edge.represented_logical_chat_id = operation.logical_chat_id
          WHERE operation.collaboration_server_id = ?
            AND operation.native_conversation_lease_id = ?
            AND edge.state = 'current'
            AND edge.root_path_certificate_id = certificate.root_path_certificate_id
          LIMIT 1`,
        [serverId, leaseId],
      );
      return value === undefined ? null : certificateFromRow(value);
    });
  }

  readInventory(): TerminalRootInventory {
    return this.#executor.transaction(readInventoryTransaction);
  }
}

/** Bind terminal-root operations to an already-active atomic host-state transaction. */
export function createTerminalRootRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  options: TerminalRootRepositoryOptions = {},
): TerminalRootRepositoryOperations {
  return new BoundTerminalRootRepository(
    { transaction: (operation) => operation(transaction) },
    machineIdentityId,
    options,
  );
}

/** Internal constructor used by the secure SQLite kernel; raw SQL never escapes. */
export function createTerminalRootRepositoryOperations(
  executor: HostStateRepositoryTransactionExecutor,
  machineIdentityId: string,
  options: TerminalRootRepositoryOptions = {},
): TerminalRootRepositoryOperations {
  return new BoundTerminalRootRepository(executor, machineIdentityId, options);
}

function snapshotAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TerminalRootRepositoryPersistenceError(message);
}

function findCertificateLink(
  transaction: HostStateRepositorySqlTransaction,
  rootPathCertificateId: A1SafeId,
): NativeRootCertificatePersistenceLink {
  return certificateLinkFromRow(
    sqlGet(
      transaction,
      `SELECT ${selectColumns(CERTIFICATE_LINK_ROW_KEYS)} FROM native_root_certificates
        WHERE root_path_certificate_id = ? LIMIT 1`,
      [rootPathCertificateId],
    ),
  );
}

function assertHistoricalAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  operation: NativeRootActivationOperationRecord,
  eventAtMs: number,
  field: string,
): void {
  const owner = rawRow(
    sqlGet(
      transaction,
      `SELECT machine_identity_id, acquired_at_ms, heartbeat_deadline_ms, released_at_ms
         FROM runtime_owner_service_leases
        WHERE runtime_owner_service_lease_id = ? AND runtime_owner_service_epoch = ?
        LIMIT 1`,
      [operation.runtimeOwnerServiceLeaseId, operation.runtimeOwnerServiceEpoch],
    ),
    ["machine_identity_id", "acquired_at_ms", "heartbeat_deadline_ms", "released_at_ms"] as const,
    `${field}.ownerLease`,
  );
  snapshotAssert(
    owner.machine_identity_id === machineIdentityId &&
      typeof owner.acquired_at_ms === "number" &&
      typeof owner.heartbeat_deadline_ms === "number" &&
      eventAtMs >= owner.acquired_at_ms &&
      eventAtMs < owner.heartbeat_deadline_ms &&
      (owner.released_at_ms === null ||
        (typeof owner.released_at_ms === "number" && eventAtMs <= owner.released_at_ms)),
    `${field} is outside its runtime-owner service lease lifetime`,
  );
  const coordinator = rawRow(
    sqlGet(
      transaction,
      `SELECT acquired_at_ms, heartbeat_deadline_ms, released_at_ms
         FROM coordinator_leases
        WHERE collaboration_server_id = ? AND coordinator_lease_id = ?
          AND coordinator_epoch = ? LIMIT 1`,
      [operation.collaborationServerId, operation.coordinatorLeaseId, operation.coordinatorEpoch],
    ),
    ["acquired_at_ms", "heartbeat_deadline_ms", "released_at_ms"] as const,
    `${field}.coordinatorLease`,
  );
  snapshotAssert(
    typeof coordinator.acquired_at_ms === "number" &&
      typeof coordinator.heartbeat_deadline_ms === "number" &&
      eventAtMs >= coordinator.acquired_at_ms &&
      eventAtMs < coordinator.heartbeat_deadline_ms &&
      (coordinator.released_at_ms === null ||
        (typeof coordinator.released_at_ms === "number" &&
          eventAtMs <= coordinator.released_at_ms)),
    `${field} is outside its coordinator lease lifetime`,
  );
  const assignment = rawRow(
    sqlGet(
      transaction,
      `SELECT selected.runtime_owner_service_lease_id, selected.runtime_owner_service_epoch
         FROM runtime_owner_assignments AS selected
        WHERE selected.runtime_id = ? AND selected.native_incarnation = ?
          AND selected.runtime_owner_service_lease_id = ?
          AND selected.runtime_owner_service_epoch = ?
          AND selected.assigned_at_ms <= ?
          AND NOT EXISTS (
            SELECT 1 FROM runtime_owner_assignments AS later
            WHERE later.runtime_id = selected.runtime_id
              AND later.native_incarnation = selected.native_incarnation
              AND later.assignment_generation > selected.assignment_generation
              AND later.assigned_at_ms < ?
          )
        ORDER BY selected.assignment_generation DESC LIMIT 1`,
      [
        operation.runtimeId,
        operation.nativeIncarnation,
        operation.runtimeOwnerServiceLeaseId,
        operation.runtimeOwnerServiceEpoch,
        eventAtMs,
        eventAtMs,
      ],
    ),
    ["runtime_owner_service_lease_id", "runtime_owner_service_epoch"] as const,
    `${field}.runtimeOwnerAssignment`,
  );
  snapshotAssert(
    assignment.runtime_owner_service_lease_id === operation.runtimeOwnerServiceLeaseId &&
      assignment.runtime_owner_service_epoch === operation.runtimeOwnerServiceEpoch,
    `${field} does not use the runtime incarnation's active owner assignment`,
  );
}

function assertHistoricalRegistrationGraph(
  transaction: HostStateRepositorySqlTransaction,
  operation: NativeRootActivationOperationRecord,
  eventAtMs: number,
  field: string,
): void {
  const processLease = rawRow(
    sqlGet(
      transaction,
      `SELECT collaboration_server_id, logical_chat_id, native_binding_id, runtime_id,
              native_incarnation, native_binding_incarnation_id, attachment_lease_id,
              runtime_owner_service_lease_id, runtime_owner_service_epoch,
              coordinator_lease_id, coordinator_epoch, lease_generation,
              current_publication_id, acquired_at_ms, closed_at_ms
         FROM native_conversation_leases
        WHERE native_conversation_lease_id = ? LIMIT 1`,
      [operation.nativeConversationLeaseId],
    ),
    [
      "collaboration_server_id",
      "logical_chat_id",
      "native_binding_id",
      "runtime_id",
      "native_incarnation",
      "native_binding_incarnation_id",
      "attachment_lease_id",
      "runtime_owner_service_lease_id",
      "runtime_owner_service_epoch",
      "coordinator_lease_id",
      "coordinator_epoch",
      "lease_generation",
      "current_publication_id",
      "acquired_at_ms",
      "closed_at_ms",
    ] as const,
    `${field}.nativeConversationLease`,
  );
  snapshotAssert(
    processLease.collaboration_server_id === operation.collaborationServerId &&
      processLease.logical_chat_id === operation.logicalChatId &&
      processLease.native_binding_id === operation.nativeBindingId &&
      processLease.runtime_id === operation.runtimeId &&
      processLease.native_incarnation === operation.nativeIncarnation &&
      processLease.native_binding_incarnation_id === operation.nativeBindingIncarnationId &&
      processLease.attachment_lease_id === operation.attachmentLeaseId &&
      processLease.runtime_owner_service_lease_id === operation.runtimeOwnerServiceLeaseId &&
      processLease.runtime_owner_service_epoch === operation.runtimeOwnerServiceEpoch &&
      processLease.coordinator_lease_id === operation.coordinatorLeaseId &&
      processLease.coordinator_epoch === operation.coordinatorEpoch &&
      processLease.lease_generation === operation.nativeConversationLeaseGeneration &&
      typeof processLease.acquired_at_ms === "number" &&
      eventAtMs >= processLease.acquired_at_ms &&
      (processLease.closed_at_ms === null ||
        (typeof processLease.closed_at_ms === "number" && eventAtMs <= processLease.closed_at_ms)),
    `${field} does not close its historical native-conversation lease`,
  );
  const registrationOperation = rawRow(
    sqlGet(
      transaction,
      `SELECT kind, operation_sequence
         FROM native_registration_operations
        WHERE native_conversation_lease_id = ?
          AND (committed_at_ms < ? OR (committed_at_ms = ? AND kind = 'ready'))
        ORDER BY committed_at_ms DESC, operation_sequence DESC LIMIT 1`,
      [operation.nativeConversationLeaseId, eventAtMs, eventAtMs],
    ),
    ["kind", "operation_sequence"] as const,
    `${field}.registrationOperation`,
  );
  snapshotAssert(
    registrationOperation.kind === "ready",
    `${field} was not recorded while the native-conversation lease was ready`,
  );
  const publication = rawRow(
    sqlGet(
      transaction,
      `SELECT native_conversation_lease_id, native_binding_id, runtime_id,
              native_incarnation, native_binding_incarnation_id, attachment_lease_id,
              publication_generation, published_at_ms
         FROM native_registration_publications
        WHERE native_registration_publication_id = ? LIMIT 1`,
      [operation.nativeRegistrationPublicationId],
    ),
    [
      "native_conversation_lease_id",
      "native_binding_id",
      "runtime_id",
      "native_incarnation",
      "native_binding_incarnation_id",
      "attachment_lease_id",
      "publication_generation",
      "published_at_ms",
    ] as const,
    `${field}.publication`,
  );
  snapshotAssert(
    publication.native_conversation_lease_id === operation.nativeConversationLeaseId &&
      publication.native_binding_id === operation.nativeBindingId &&
      publication.runtime_id === operation.runtimeId &&
      publication.native_incarnation === operation.nativeIncarnation &&
      publication.native_binding_incarnation_id === operation.nativeBindingIncarnationId &&
      publication.attachment_lease_id === operation.attachmentLeaseId &&
      publication.publication_generation === operation.publicationGeneration &&
      typeof publication.published_at_ms === "number" &&
      publication.published_at_ms <= eventAtMs,
    `${field} does not close its immutable registration publication`,
  );
  const transportLease = rawRow(
    sqlGet(
      transaction,
      `SELECT attachment_id, native_binding_incarnation_id, runtime_id, native_incarnation,
              runtime_owner_service_lease_id, runtime_owner_service_epoch,
              coordinator_lease_id, coordinator_epoch, transport_epoch,
              acquired_at_ms, released_at_ms
         FROM native_transport_leases WHERE attachment_lease_id = ? LIMIT 1`,
      [operation.attachmentLeaseId],
    ),
    [
      "attachment_id",
      "native_binding_incarnation_id",
      "runtime_id",
      "native_incarnation",
      "runtime_owner_service_lease_id",
      "runtime_owner_service_epoch",
      "coordinator_lease_id",
      "coordinator_epoch",
      "transport_epoch",
      "acquired_at_ms",
      "released_at_ms",
    ] as const,
    `${field}.attachmentLease`,
  );
  snapshotAssert(
    transportLease.attachment_id === operation.attachmentId &&
      transportLease.native_binding_incarnation_id === operation.nativeBindingIncarnationId &&
      transportLease.runtime_id === operation.runtimeId &&
      transportLease.native_incarnation === operation.nativeIncarnation &&
      transportLease.runtime_owner_service_lease_id === operation.runtimeOwnerServiceLeaseId &&
      transportLease.runtime_owner_service_epoch === operation.runtimeOwnerServiceEpoch &&
      transportLease.coordinator_lease_id === operation.coordinatorLeaseId &&
      transportLease.coordinator_epoch === operation.coordinatorEpoch &&
      transportLease.transport_epoch === operation.transportEpoch &&
      typeof transportLease.acquired_at_ms === "number" &&
      eventAtMs >= transportLease.acquired_at_ms &&
      (transportLease.released_at_ms === null ||
        (typeof transportLease.released_at_ms === "number" &&
          eventAtMs <= transportLease.released_at_ms)),
    `${field} does not close its historical attachment lease`,
  );
}

function assertCertificateMatchesOperation(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  operation: NativeRootActivationOperationRecord,
  stored: StoredNativeRootCertificate,
  signatureEvidence: RuntimeOwnerSignatureEvidenceIndex,
): void {
  const link = findCertificateLink(transaction, stored.certificate.rootPathCertificateId);
  const certificate = stored.certificate;
  snapshotAssert(
    stored.activationOperationId === operation.operationId &&
      certificate.rootPathCertificateId === operation.rootPathCertificateId &&
      sameDigest(link.activationOperationDigest, operation.operationDigest) &&
      link.expectedPriorRootPathCertificateId === operation.expectedPriorRootPathCertificateId &&
      certificate.terminalServerId === operation.collaborationServerId &&
      certificate.terminalLogicalChatId === operation.logicalChatId &&
      certificate.terminalNativeBindingId === operation.nativeBindingId &&
      certificate.terminalTopologyGeneration === operation.terminalTopologyGeneration &&
      sameDigest(certificate.nativeBindingEvidenceDigest, operation.nativeBindingEvidenceDigest) &&
      link.runtimeId === operation.runtimeId &&
      link.nativeIncarnation === operation.nativeIncarnation &&
      link.nativeBindingIncarnationId === operation.nativeBindingIncarnationId &&
      link.attachmentId === operation.attachmentId &&
      link.attachmentLeaseId === operation.attachmentLeaseId &&
      link.transportEpoch === operation.transportEpoch &&
      link.nativeConversationLeaseId === operation.nativeConversationLeaseId &&
      link.nativeConversationLeaseGeneration === operation.nativeConversationLeaseGeneration &&
      link.nativeRegistrationPublicationId === operation.nativeRegistrationPublicationId &&
      link.publicationGeneration === operation.publicationGeneration &&
      link.bindingGateGeneration === operation.bindingGateGeneration &&
      link.runtimeOwnerServiceLeaseId === operation.runtimeOwnerServiceLeaseId &&
      link.runtimeOwnerServiceEpoch === operation.runtimeOwnerServiceEpoch &&
      link.coordinatorLeaseId === operation.coordinatorLeaseId &&
      link.coordinatorEpoch === operation.coordinatorEpoch &&
      link.canonicalPayloadRef === operation.canonicalPayloadRef &&
      certificate.runtimeOwnerIdentityKeyId === operation.runtimeOwnerIdentityKeyId &&
      certificate.runtimeOwnerKeyGeneration === operation.runtimeOwnerKeyGeneration &&
      certificate.signerSequence === operation.signerSequence &&
      certificate.issuedAtMs === operation.issuedAtMs &&
      certificate.expiresAtMs === operation.expiresAtMs &&
      sameDigest(certificate.canonicalPayloadDigest, operation.canonicalPayloadDigest) &&
      operation.state === "committed" &&
      operation.signedRecordDigest !== null &&
      operation.committedAtMs === stored.committedAtMs &&
      sameDigest(operation.signedRecordDigest, stored.signedRecordDigest),
    `certificate ${certificate.rootPathCertificateId} does not exactly close its activation operation`,
  );
  const evidence = signatureEvidenceForOperation(
    transaction,
    machineIdentityId,
    operation,
    signatureEvidence,
  );
  snapshotAssert(
    evidence.reservation.signedRecordDigest !== null &&
      sameDigest(evidence.reservation.signedRecordDigest, stored.signedRecordDigest) &&
      evidence.reservation.signature === certificate.signature &&
      evidence.reservation.signedArtifactId === certificate.rootPathCertificateId,
    `certificate ${certificate.rootPathCertificateId} does not exactly bind its signed reservation`,
  );
  assertEd25519Signature(
    evidence.identityKey.publicKey,
    readPayloadArtifact(transaction, operation),
    certificate.signature,
  );
  const acceptance = rawRow(
    sqlGet(
      transaction,
      `SELECT signed_record_digest, accepted_at_ms
         FROM runtime_owner_signed_record_acceptances
        WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
          AND runtime_owner_key_generation = ? AND signer_sequence = ? LIMIT 1`,
      [
        operation.runtimeId,
        operation.runtimeOwnerIdentityKeyId,
        operation.runtimeOwnerKeyGeneration,
        operation.signerSequence,
      ],
    ),
    ["signed_record_digest", "accepted_at_ms"] as const,
    `certificate ${certificate.rootPathCertificateId}.acceptance`,
  );
  snapshotAssert(
    acceptance.signed_record_digest === stored.signedRecordDigest &&
      acceptance.accepted_at_ms === stored.committedAtMs,
    `certificate ${certificate.rootPathCertificateId} does not exactly bind its acceptance time`,
  );
}

/** Validate the complete schema-v6 terminal-root ledger in one coherent read snapshot. */
export function validateTerminalRootRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
): void {
  const machineId = parseMachineIdentityId(machineIdentityId);
  snapshotAssert(
    sqlGet(
      transaction,
      `SELECT 1
         FROM runtime_owner_identity_keys AS identity_key
         LEFT JOIN native_root_signature_activation_fences AS fence
           ON fence.runtime_id = identity_key.runtime_id
          AND fence.runtime_owner_identity_key_id =
            identity_key.runtime_owner_identity_key_id
          AND fence.runtime_owner_key_generation = identity_key.key_generation
        WHERE fence.runtime_id IS NULL
           OR fence.first_eligible_signer_sequence > identity_key.next_signer_sequence
        LIMIT 1`,
      [],
    ) === undefined,
    "runtime-owner identity keys do not have complete native-root activation fences",
  );
  const inventory = readInventoryTransaction(transaction);
  const operationsById = new Map(
    inventory.operations.map((operation) => [operation.operationId, operation] as const),
  );
  const certificatesByOperation = new Map(
    inventory.certificates.map(
      (certificate) => [certificate.activationOperationId, certificate] as const,
    ),
  );
  snapshotAssert(
    operationsById.size === inventory.operations.length &&
      certificatesByOperation.size === inventory.certificates.length,
    "terminal-root operation or certificate identities are duplicated",
  );
  const signatureEvidence = indexRuntimeOwnerSignatureEvidence(
    createRuntimeOwnerRepositoryTransactionOperations(transaction, machineId).readInventory(),
  );

  const committedByRoot = new Map<string, NativeRootActivationOperationRecord>();
  const successorByPrior = new Map<string, NativeRootActivationOperationRecord>();
  for (const operation of inventory.operations) {
    snapshotAssert(
      operation.rootPathCertificateId ===
        nativeRootCertificateId({
          machineIdentityId: machineId,
          collaborationServerId: operation.collaborationServerId,
          logicalChatId: operation.logicalChatId,
          operationId: operation.operationId,
        }),
      `operation ${operation.operationId} has a noncanonical root certificate ID`,
    );
    const activationFence = rawRow(
      sqlGet(
        transaction,
        `SELECT first_eligible_signer_sequence
           FROM native_root_signature_activation_fences
          WHERE runtime_id = ? AND runtime_owner_identity_key_id = ?
            AND runtime_owner_key_generation = ? LIMIT 1`,
        [
          operation.runtimeId,
          operation.runtimeOwnerIdentityKeyId,
          operation.runtimeOwnerKeyGeneration,
        ],
      ),
      ["first_eligible_signer_sequence"] as const,
      `operation ${operation.operationId}.activationFence`,
    );
    snapshotAssert(
      typeof activationFence.first_eligible_signer_sequence === "number" &&
        operation.signerSequence >= activationFence.first_eligible_signer_sequence,
      `operation ${operation.operationId} uses an ineligible pre-v6 signer sequence`,
    );
    readPayloadArtifact(transaction, operation);
    signatureEvidenceForOperation(transaction, machineId, operation, signatureEvidence);
    assertHistoricalAuthority(
      transaction,
      machineId,
      operation,
      operation.preparedAtMs,
      `operation ${operation.operationId}.preparation`,
    );
    assertHistoricalRegistrationGraph(
      transaction,
      operation,
      operation.preparedAtMs,
      `operation ${operation.operationId}.preparation`,
    );
    const stored = certificatesByOperation.get(operation.operationId) ?? null;
    snapshotAssert(
      (operation.state === "committed") === (stored !== null),
      `operation ${operation.operationId} has an incomplete certificate finalization`,
    );
    if (stored === null) continue;
    assertHistoricalAuthority(
      transaction,
      machineId,
      operation,
      stored.committedAtMs,
      `operation ${operation.operationId}.commit`,
    );
    assertHistoricalRegistrationGraph(
      transaction,
      operation,
      stored.committedAtMs,
      `operation ${operation.operationId}.commit`,
    );
    assertCertificateMatchesOperation(transaction, machineId, operation, stored, signatureEvidence);
    committedByRoot.set(operation.rootPathCertificateId, operation);
    if (operation.expectedPriorRootPathCertificateId !== null) {
      snapshotAssert(
        !successorByPrior.has(operation.expectedPriorRootPathCertificateId),
        `root ${operation.expectedPriorRootPathCertificateId} has multiple successors`,
      );
      successorByPrior.set(operation.expectedPriorRootPathCertificateId, operation);
    }
  }

  const committedByChat = new Map<string, NativeRootActivationOperationRecord[]>();
  for (const operation of committedByRoot.values()) {
    const key = `${operation.collaborationServerId}\u0000${operation.logicalChatId}`;
    const group = committedByChat.get(key) ?? [];
    group.push(operation);
    committedByChat.set(key, group);
  }
  for (const group of committedByChat.values()) {
    const heads = group.filter((operation) => operation.kind === "activate");
    snapshotAssert(
      heads.length === 1,
      "terminal-root history must have exactly one activation head",
    );
    const visited = new Set<string>();
    let cursor: NativeRootActivationOperationRecord | undefined = heads[0];
    while (cursor !== undefined) {
      snapshotAssert(
        !visited.has(cursor.rootPathCertificateId),
        `terminal-root history contains a cycle at ${cursor.rootPathCertificateId}`,
      );
      visited.add(cursor.rootPathCertificateId);
      const successor = successorByPrior.get(cursor.rootPathCertificateId);
      if (successor !== undefined) {
        snapshotAssert(
          successor.collaborationServerId === cursor.collaborationServerId &&
            successor.logicalChatId === cursor.logicalChatId,
          `root ${cursor.rootPathCertificateId} has a cross-chat successor`,
        );
      }
      cursor = successor;
    }
    snapshotAssert(
      visited.size === group.length,
      "terminal-root history is disconnected from its activation head",
    );
  }

  const earliestCommittedAtByChat = new Map<string, number>();
  for (const operation of committedByRoot.values()) {
    if (operation.committedAtMs === null) continue;
    const key = `${operation.collaborationServerId}\u0000${operation.logicalChatId}`;
    const earliest = earliestCommittedAtByChat.get(key);
    if (earliest === undefined || operation.committedAtMs < earliest) {
      earliestCommittedAtByChat.set(key, operation.committedAtMs);
    }
  }
  for (const operation of inventory.operations) {
    if (operation.kind === "activate") {
      const earliestCommittedAtMs = earliestCommittedAtByChat.get(
        `${operation.collaborationServerId}\u0000${operation.logicalChatId}`,
      );
      snapshotAssert(
        earliestCommittedAtMs === undefined || earliestCommittedAtMs >= operation.preparedAtMs,
        `activation ${operation.rootPathCertificateId} was prepared after rooted history existed`,
      );
      continue;
    }
    const prior =
      operation.expectedPriorRootPathCertificateId === null
        ? undefined
        : committedByRoot.get(operation.expectedPriorRootPathCertificateId);
    snapshotAssert(
      prior !== undefined &&
        prior.collaborationServerId === operation.collaborationServerId &&
        prior.logicalChatId === operation.logicalChatId &&
        prior.nativeBindingId === operation.nativeBindingId &&
        prior.terminalTopologyGeneration === operation.terminalTopologyGeneration &&
        prior.committedAtMs !== null &&
        prior.committedAtMs <= operation.preparedAtMs,
      `renewal ${operation.rootPathCertificateId} has an invalid predecessor`,
    );
    const earlierSuccessor =
      operation.expectedPriorRootPathCertificateId === null
        ? undefined
        : successorByPrior.get(operation.expectedPriorRootPathCertificateId);
    snapshotAssert(
      earlierSuccessor === undefined ||
        earlierSuccessor.operationId === operation.operationId ||
        earlierSuccessor.committedAtMs === null ||
        earlierSuccessor.committedAtMs >= operation.preparedAtMs,
      `renewal ${operation.rootPathCertificateId} was prepared after its predecessor had a successor`,
    );
  }

  const rootedRows = sqlAll(
    transaction,
    `SELECT edge.root_path_certificate_id, edge.represented_server_id,
            edge.represented_logical_chat_id, edge.target_native_binding_id,
            edge.state AS edge_state, chat.state AS chat_state
       FROM inward_collaboration_edges AS edge
       JOIN logical_chats AS chat
         ON chat.collaboration_server_id = edge.represented_server_id
        AND chat.logical_chat_id = edge.represented_logical_chat_id
      WHERE edge.target_kind = 'native-harness'
        AND (edge.root_path_certificate_id IS NOT NULL OR edge.state = 'current')`,
  );
  for (const value of rootedRows) {
    const row = rawRow(
      value,
      [
        "root_path_certificate_id",
        "represented_server_id",
        "represented_logical_chat_id",
        "target_native_binding_id",
        "edge_state",
        "chat_state",
      ] as const,
      "rootedTerminalEdge",
    );
    const rootId = parseA1SafeId(row.root_path_certificate_id, "rootedTerminalEdge.rootId");
    const operation = committedByRoot.get(rootId);
    snapshotAssert(
      operation !== undefined &&
        operation.collaborationServerId === row.represented_server_id &&
        operation.logicalChatId === row.represented_logical_chat_id &&
        operation.nativeBindingId === row.target_native_binding_id &&
        row.edge_state === "current" &&
        row.chat_state === "ready" &&
        !successorByPrior.has(rootId),
      `current terminal root ${rootId} is not the exact latest committed certificate`,
    );
  }

  for (const operation of committedByRoot.values()) {
    if (successorByPrior.has(operation.rootPathCertificateId)) continue;
    const graph = rawRow(
      sqlGet(
        transaction,
        `SELECT chat.state AS chat_state, edge.state AS edge_state,
                edge.root_path_certificate_id
           FROM logical_chats AS chat
           JOIN inward_collaboration_edges AS edge
             ON edge.represented_server_id = chat.collaboration_server_id
            AND edge.represented_logical_chat_id = chat.logical_chat_id
            AND edge.inward_edge_id = chat.current_inward_edge_id
          WHERE chat.collaboration_server_id = ? AND chat.logical_chat_id = ? LIMIT 1`,
        [operation.collaborationServerId, operation.logicalChatId],
      ),
      ["chat_state", "edge_state", "root_path_certificate_id"] as const,
      `latestRoot.${operation.rootPathCertificateId}`,
    );
    const installed =
      graph.chat_state === "ready" &&
      graph.edge_state === "current" &&
      graph.root_path_certificate_id === operation.rootPathCertificateId;
    const demoted =
      graph.chat_state === "recovering" &&
      graph.edge_state === "installing" &&
      graph.root_path_certificate_id === null;
    snapshotAssert(
      installed || demoted,
      `latest root ${operation.rootPathCertificateId} is neither installed nor exactly demoted`,
    );
  }
}
