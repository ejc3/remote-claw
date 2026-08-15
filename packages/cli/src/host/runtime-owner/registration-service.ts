import { createHash, randomBytes } from "node:crypto";
import { base64urlDecode, base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import type {
  NativeConversationCapabilities,
  NativeConversationRef,
  NativeEngineDescriptor,
} from "../native/adapter.js";
import {
  createDurableProjectSelectionEvidence,
  createNativeConversationCapabilitiesEvidence,
  createNativeConversationRefEvidence,
  createNativeEngineDescriptorEvidence,
  createNativeRegistrationMetadataEvidence,
  DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
  NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
  NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
  NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
  NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
} from "../native/evidence.js";
import { nativeRuntimeId, projectTargetDigest } from "../state/digests.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type Ed25519Signature,
  type NativeBindingId,
  type NativeConversationLeaseId,
  type NativeRuntimeId,
  type ProjectId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseEd25519Signature,
  parseWardenLaunchNonce,
  type RegistrationAttemptId,
} from "../state/ids.js";
import type {
  CoordinatorLeaseFence,
  NativeConversationLeaseRecord,
  ProjectTarget,
} from "../state/records.js";
import type {
  ReassignRuntimeOwnerRequest,
  RegisterInitialRuntimeRequest,
  RuntimeOwnerOperationEvidence,
  RuntimeOwnerServiceFence,
  RuntimeRegistrationResult,
} from "../state/runtime-repository.js";
import {
  createNativeRegistrationOperationEvidence,
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  NATIVE_ROOT_MAX_TTL_MS,
  type NativeRegistrationOperationInputByKind,
  NativeRegistrationRepositoryConflictError,
} from "../state/sqlite.js";
import {
  RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
  type WrappedRuntimeOwnerPrivateKey,
} from "./key-custody.js";
import {
  encodeRuntimeOwnerRpcCanonicalJson,
  type RuntimeOwnerRpcCallablePortRef,
  type RuntimeOwnerRpcJsonValue,
} from "./protocol.js";
import type {
  RuntimeOwnerCollaboratorDetachContext,
  RuntimeOwnerOperationContext,
  RuntimeOwnerOperationDefinition,
} from "./service.js";

const MAX_METADATA_BYTES = 512 * 1024;
const MAX_SCHEMA_ID_BYTES = 256;
const MAX_DURABLE_PORT_HANDLE_ATTEMPTS = 8;
const REGISTRATION_PROBE_OPERATION_SCHEMA_ID =
  "remote-claw/native-registration-port-probe/v1" as const;
const REGISTRATION_PROBE_RESULT_SCHEMA_ID =
  "remote-claw/native-registration-port-probe-result/v1" as const;
const INTERNAL_OPERATION_SCHEMA_PREFIX = "remote-claw/native-registration-orchestration";
const NATIVE_ROOT_PROBE_EVIDENCE_SCHEMA_ID =
  "remote-claw/native-root-port-probe-evidence/v1" as const;

type UnknownRecord = Record<string, unknown>;

export interface NativeRegistrationDatabaseAccess {
  use<T>(operation: (database: HostStateDatabase) => T): T;
  reopenAfterUnknownCommit(): void;
}

export interface NativeRegistrationCoordinatorAuthority {
  readonly fence: CoordinatorLeaseFence;
  assertCurrent(): CoordinatorLeaseFence;
}

export interface NativeRegistrationOrchestratorOptions {
  readonly database: NativeRegistrationDatabaseAccess;
  readonly coordinator: NativeRegistrationCoordinatorAuthority;
  /** Trusted server-side measurement/setup authority. Untrusted RPC JSON is only its selector. */
  readonly adapter: NativeRegistrationAdapter;
}

export interface NativeRegistrationOrchestrator {
  readonly operations: readonly RuntimeOwnerOperationDefinition[];
  readonly onCollaboratorDetach: (context: RuntimeOwnerCollaboratorDetachContext) => Promise<void>;
}

export interface NativeRegistrationAdapterContext {
  readonly connectionId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

/**
 * Provider-neutral trusted seam. A real implementation must measure these values from the owned
 * native process/server. The RPC collaborator may provide an opaque selector but cannot attest its
 * own process start, runtime, project, or conversation identity.
 */
export interface NativeRegistrationAdapter {
  measureOpen(
    selector: RuntimeOwnerRpcJsonValue,
    context: NativeRegistrationAdapterContext,
  ): ParsedNativeRegistrationOpenMeasurement | Promise<ParsedNativeRegistrationOpenMeasurement>;
  measurePublication(
    selector: RuntimeOwnerRpcJsonValue,
    context: NativeRegistrationAdapterContext,
  ): NativeRegistrationPublicationMeasurement | Promise<NativeRegistrationPublicationMeasurement>;
  measureBinding(
    selector: RuntimeOwnerRpcJsonValue,
    proof: Readonly<{
      resultSchemaId: string;
      resultRef: A1SafeId;
      resultDigest: A1Digest;
    }>,
    context: NativeRegistrationAdapterContext,
  ): NativeRegistrationBindingMeasurement | Promise<NativeRegistrationBindingMeasurement>;
  measureReattach(
    selector: RuntimeOwnerRpcJsonValue,
    predecessor: Readonly<{
      nativeConversationLeaseId: NativeConversationLeaseId;
      nativeBindingId: NativeBindingId;
      runtimeId: NativeRuntimeId;
      nativeIncarnation: number;
      leaseGeneration: number;
    }>,
    context: NativeRegistrationAdapterContext,
  ): NativeRegistrationReattachMeasurement | Promise<NativeRegistrationReattachMeasurement>;
}

export interface ParsedNativeRegistrationOpenMeasurement {
  readonly registrationAttemptId: string;
  readonly descriptor: RuntimeOwnerRpcJsonValue;
  readonly initialPhase: "starting" | "recovering";
  readonly expectedNativeRef: NativeConversationRef | null;
  readonly selection: RuntimeOwnerRpcJsonValue;
  readonly metadata: Readonly<{ schemaId: string; bytes: string }>;
  readonly runtime: RuntimeOwnerRpcJsonValue;
  readonly binding: RuntimeOwnerRpcJsonValue;
  readonly nativeConversationLeaseId: string;
}

export interface NativeRegistrationBindingMeasurement {
  readonly nativeRef: NativeConversationRef;
  readonly localTransitionId: string;
  readonly localNativeConversationId: string;
  readonly parentLocalNativeConversationId: string | null;
}

export interface NativeRegistrationReattachMeasurement {
  readonly nativeConversationLeaseId: string;
  readonly successorAttachmentLeaseId: string | null;
  /** Required only when recovering an unbound predecessor; measured setup for its successor. */
  readonly successorBinding: RuntimeOwnerRpcJsonValue | null;
  readonly expectedRuntimeOwnerAssignmentId: string | null;
  readonly runtimeOwnerAssignmentId: string | null;
  readonly reattachmentEvidenceSchemaId: string | null;
  readonly reattachmentEvidenceRef: string | null;
  readonly reattachmentEvidenceDigest: string | null;
}

export interface NativeRegistrationPublicationMeasurement {
  readonly metadataSchemaId: string;
  readonly metadataBytes: Uint8Array;
  readonly capabilities: NativeConversationCapabilities;
}

export class NativeRegistrationOrchestrationError extends Error {
  readonly code:
    | "INVALID_REQUEST"
    | "STALE_AUTHORITY"
    | "LIVE_PORT_UNAVAILABLE"
    | "COMMIT_NOT_RECONCILED"
    | "RESULT_MISMATCH";

  constructor(
    code:
      | "INVALID_REQUEST"
      | "STALE_AUTHORITY"
      | "LIVE_PORT_UNAVAILABLE"
      | "COMMIT_NOT_RECONCILED"
      | "RESULT_MISMATCH",
    options?: ErrorOptions,
  ) {
    super("native registration orchestration failed", options);
    this.name = "NativeRegistrationOrchestrationError";
    this.code = code;
  }
}

function invalidRequest(): never {
  throw new NativeRegistrationOrchestrationError("INVALID_REQUEST");
}

function exactRecord(value: unknown, keys: readonly string[]): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidRequest();
  let prototype: object | null;
  let ownKeys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    invalidRequest();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    invalidRequest();
  }
  const result = Object.create(null) as UnknownRecord;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      invalidRequest();
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) invalidRequest();
    result[key] = descriptor.value;
  }
  return result;
}

function nullableSafeId(value: unknown): A1SafeId | null {
  if (value === null) return null;
  try {
    return parseA1SafeId(value);
  } catch {
    invalidRequest();
  }
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidRequest();
  return value as number;
}

function boundedSchemaId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidRequest();
  if (new TextEncoder().encode(value).byteLength > MAX_SCHEMA_ID_BYTES) invalidRequest();
  return value;
}

function boundedBase64url(value: unknown, maximumBytes = MAX_METADATA_BYTES): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil((maximumBytes * 4) / 3) + 2) {
    invalidRequest();
  }
  try {
    const decoded = base64urlDecode(value);
    if (decoded.byteLength > maximumBytes || base64urlEncode(decoded) !== value) invalidRequest();
    return Uint8Array.from(decoded);
  } catch (error) {
    if (error instanceof NativeRegistrationOrchestrationError) throw error;
    invalidRequest();
  }
}

function descriptor(value: unknown): NativeEngineDescriptor {
  try {
    return createNativeEngineDescriptorEvidence(value).value;
  } catch {
    invalidRequest();
  }
}

function capabilities(value: unknown): NativeConversationCapabilities {
  try {
    return createNativeConversationCapabilitiesEvidence(value).value;
  } catch {
    invalidRequest();
  }
}

function digest(value: unknown): A1Digest {
  try {
    return parseA1Digest(value);
  } catch {
    invalidRequest();
  }
}

function safeId(value: unknown): A1SafeId {
  try {
    return parseA1SafeId(value);
  } catch {
    invalidRequest();
  }
}

function canonicalId<K extends Parameters<typeof parseA1CanonicalId>[0]>(
  kind: K,
  value: unknown,
): ReturnType<typeof parseA1CanonicalId<K>> {
  try {
    return parseA1CanonicalId(kind, value);
  } catch {
    invalidRequest();
  }
}

function sameDescriptor(left: NativeEngineDescriptor, right: NativeEngineDescriptor): boolean {
  return left.product === right.product && left.access === right.access;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function isDurableCallablePortHandleCollision(error: unknown): boolean {
  return (
    error instanceof NativeRegistrationRepositoryConflictError &&
    error.message ===
      "native registration repository conflict: callable-port protected handle is already allocated"
  );
}

function ownerFence(context: RuntimeOwnerOperationContext): RuntimeOwnerServiceFence {
  const lease = context.assertCurrent();
  return Object.freeze({
    runtimeOwnerServiceLeaseId: parseA1SafeId(lease.runtimeOwnerServiceLeaseId),
    runtimeOwnerServiceEpoch: lease.runtimeOwnerServiceEpoch,
    ownerInstanceId: parseA1SafeId(lease.ownerInstanceId),
    ownerProcessStartIdentitySchemaId: lease.ownerStartIdentitySchemaId,
    ownerProcessStartIdentityRef: parseA1SafeId(lease.ownerStartIdentityRef),
    ownerProcessStartIdentityDigest: parseA1Digest(lease.ownerStartIdentityDigest),
  });
}

function internalOperation(
  outerOperationId: A1SafeId,
  stage: string,
  value: RuntimeOwnerRpcJsonValue,
): RuntimeOwnerOperationEvidence {
  const schemaId = `${INTERNAL_OPERATION_SCHEMA_PREFIX}-${stage}/v1`;
  const idWriter = new CanonicalWriter();
  idWriter.str(schemaId);
  idWriter.str(outerOperationId);
  const operationId = parseA1SafeId(
    `a14op_${base64urlEncode(createHash("sha256").update(idWriter.finish()).digest())}`,
  );
  const digestWriter = new CanonicalWriter();
  digestWriter.str(schemaId);
  digestWriter.str(operationId);
  digestWriter.bytes(encodeRuntimeOwnerRpcCanonicalJson(value));
  return Object.freeze({
    operationId,
    operationSchemaId: schemaId,
    operationDigest: parseA1Digest(
      base64urlEncode(createHash("sha256").update(digestWriter.finish()).digest()),
    ),
  });
}

function nativeRootProofOperation(
  outerOperationId: A1SafeId,
  serviceNonce: string,
  selector: RuntimeOwnerRpcJsonValue,
): RuntimeOwnerOperationEvidence {
  const idWriter = new CanonicalWriter();
  idWriter.str(NATIVE_ROOT_PROBE_EVIDENCE_SCHEMA_ID);
  idWriter.str(outerOperationId);
  idWriter.str(serviceNonce);
  const operationId = parseA1SafeId(
    `a15proof_${base64urlEncode(createHash("sha256").update(idWriter.finish()).digest())}`,
  );
  const digestWriter = new CanonicalWriter();
  digestWriter.str(NATIVE_ROOT_PROBE_EVIDENCE_SCHEMA_ID);
  digestWriter.str(operationId);
  digestWriter.bytes(encodeRuntimeOwnerRpcCanonicalJson(selector));
  return Object.freeze({
    operationId,
    operationSchemaId: NATIVE_ROOT_PROBE_EVIDENCE_SCHEMA_ID,
    operationDigest: parseA1Digest(
      base64urlEncode(createHash("sha256").update(digestWriter.finish()).digest()),
    ),
  });
}

function registrationOperation<K extends keyof NativeRegistrationOperationInputByKind>(
  kind: K,
  outerOperationId: A1SafeId,
  input: NativeRegistrationOperationInputByKind[K],
): RuntimeOwnerOperationEvidence {
  return createNativeRegistrationOperationEvidence(
    kind,
    internalOperation(outerOperationId, `ledger-${kind}`, outerOperationId).operationId,
    input,
  );
}

function response(value: Record<string, RuntimeOwnerRpcJsonValue>): RuntimeOwnerRpcJsonValue {
  return Object.freeze(value);
}

type NativeRootPreparation = ReturnType<HostStateDatabase["terminalRoot"]["prepare"]>;

function nativeRootCustodyEnvelope(
  preparation: NativeRootPreparation,
): WrappedRuntimeOwnerPrivateKey {
  const { identityKey, privateKey } = preparation;
  if (
    identityKey.algorithm !== "Ed25519" ||
    identityKey.signingKeyRef === null ||
    identityKey.signingKeyRef.protectedHandleId !== privateKey.signingKeyRef.protectedHandleId ||
    identityKey.runtimeId !== privateKey.runtimeId ||
    identityKey.runtimeOwnerIdentityKeyId !== privateKey.runtimeOwnerIdentityKeyId ||
    identityKey.keyGeneration !== privateKey.keyGeneration ||
    privateKey.wrappingSchemaId !== RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID ||
    privateKey.state !== "current" ||
    privateKey.destroyedAtMs !== null
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  return Object.freeze({
    wrappingSchemaId: RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
    binding: Object.freeze({
      runtimeId: identityKey.runtimeId,
      runtimeOwnerIdentityKeyId: identityKey.runtimeOwnerIdentityKeyId,
      keyGeneration: identityKey.keyGeneration,
      publicKey: identityKey.publicKey,
    }),
    wrapNonce: privateKey.wrapNonce,
    wrappedPkcs8: privateKey.wrappedPkcs8,
    authTag: privateKey.authTag,
    pkcs8Digest: privateKey.pkcs8Digest,
  });
}

function signNativeRootPreparation(
  preparation: NativeRootPreparation,
  context: RuntimeOwnerOperationContext,
): Ed25519Signature {
  const signature = context.custodySigner.sign(
    nativeRootCustodyEnvelope(preparation),
    preparation.canonicalPayload,
  );
  const bytes = signature.copyBytes();
  try {
    return parseEd25519Signature(base64urlEncode(bytes));
  } finally {
    bytes.fill(0);
  }
}

function nativeRootResponse(
  result: ReturnType<HostStateDatabase["terminalRoot"]["finalize"]>,
  livenessVerified: boolean,
): RuntimeOwnerRpcJsonValue {
  return response({
    nativeConversationLeaseId: result.operation.nativeConversationLeaseId,
    rootPathCertificateId: result.operation.rootPathCertificateId,
    state: result.operation.state,
    committedAtMs: result.storedCertificate.committedAtMs,
    expiresAtMs: result.storedCertificate.certificate.expiresAtMs,
    replayed: result.replayed,
    livenessVerified,
  });
}

function reconciledNativeRootResponse(
  result: NonNullable<ReturnType<HostStateDatabase["terminalRoot"]["reconcileOperation"]>>,
): RuntimeOwnerRpcJsonValue {
  const storedCertificate = result.storedCertificate;
  if (result.operation.state !== "committed" || storedCertificate === null) {
    throw new NativeRegistrationOrchestrationError("COMMIT_NOT_RECONCILED");
  }
  return response({
    nativeConversationLeaseId: result.operation.nativeConversationLeaseId,
    rootPathCertificateId: result.operation.rootPathCertificateId,
    state: result.operation.state,
    committedAtMs: storedCertificate.committedAtMs,
    expiresAtMs: storedCertificate.certificate.expiresAtMs,
    replayed: true,
    // A durable historical replay proves the activation fact, not present callable-port liveness.
    livenessVerified: false,
  });
}

interface LivePort {
  readonly connectionId: string;
  readonly leaseId: NativeConversationLeaseId;
  readonly nativeBindingId: NativeBindingId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly attachmentLeaseId: A1SafeId;
  readonly portGeneration: number;
  readonly callablePortRef: RuntimeOwnerRpcCallablePortRef;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly reattachReplay?: Readonly<{
    readonly outerOperationId: A1SafeId;
    readonly selector: RuntimeOwnerRpcJsonValue;
    readonly request: Parameters<HostStateDatabase["registration"]["reattach"]>[0];
  }>;
}

interface OpenSelectionFirst {
  readonly kind: "first_bootstrap";
  readonly workspaceSelectorId: A1SafeId;
  readonly terminalProjectRef: A1SafeId;
  readonly mappingEvidenceRef: A1SafeId;
}

interface OpenSelectionExisting {
  readonly kind: "existing_mapping";
  readonly projectId: ProjectId;
  readonly workspaceSelectorId: A1SafeId;
  readonly projectTargetSelectorMappingId: ReturnType<
    typeof parseA1CanonicalId<"projectTargetSelectorMapping">
  >;
  readonly mappingGeneration: number;
  readonly targetDigest: A1Digest;
  readonly parentChatId: ReturnType<typeof parseA1CanonicalId<"logicalChat">> | null;
}

type OpenSelection = OpenSelectionFirst | OpenSelectionExisting;

interface ParsedOpenPayload {
  readonly canonicalPayload: RuntimeOwnerRpcJsonValue;
  readonly operationId: A1SafeId;
  readonly registrationAttemptId: RegistrationAttemptId;
  readonly descriptor: NativeEngineDescriptor;
  readonly initialPhase: "starting" | "recovering";
  readonly expectedNativeRef: NativeConversationRef | null;
  readonly expectedNativeRefDigest: A1Digest | null;
  readonly selection: OpenSelection;
  readonly metadataSchemaId: string;
  readonly metadataBytes: Uint8Array;
  readonly runtime: Readonly<{
    runtimeId: NativeRuntimeId;
    nativeIncarnation: number;
    wardenLaunchNonce: ReturnType<typeof parseWardenLaunchNonce>;
    startIdentitySchemaId: string;
    startIdentityRef: A1SafeId;
    startIdentityDigest: A1Digest;
    runtimeOwnerAssignmentId: A1SafeId;
    expectedRuntimeOwnerAssignmentId: A1SafeId | null;
    reattachmentEvidenceSchemaId: string | null;
    reattachmentEvidenceRef: A1SafeId | null;
    reattachmentEvidenceDigest: A1Digest | null;
    signingKeyRef: ReturnType<typeof parseA1CanonicalId<"protectedHandle">>;
    localTrustEvidenceRef: A1SafeId;
    localTrustEvidenceDigest: A1Digest;
  }>;
  readonly binding: Readonly<{
    nativeBindingIncarnationId: A1SafeId;
    attachmentId: A1SafeId;
    attachmentKind: "claude-inner-rc" | "app-server" | "server" | "tmux";
    transportId: A1SafeId;
    attachmentGeneration: number;
    attachmentLeaseId: A1SafeId;
    transportEpoch: number;
    resourceOwnership: "dedicated_runtime" | "shared_runtime";
    disconnectPolicy: "detach" | "terminate_when_idle";
  }>;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
}

function parseSelection(value: unknown): OpenSelection {
  if (typeof value !== "object" || value === null) invalidRequest();
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (kindDescriptor === undefined || !Object.hasOwn(kindDescriptor, "value")) invalidRequest();
  if (kindDescriptor.value === "first_bootstrap") {
    const row = exactRecord(value, [
      "kind",
      "mappingEvidenceRef",
      "terminalProjectRef",
      "workspaceSelectorId",
    ]);
    return Object.freeze({
      kind: "first_bootstrap",
      workspaceSelectorId: safeId(row.workspaceSelectorId),
      terminalProjectRef: safeId(row.terminalProjectRef),
      mappingEvidenceRef: safeId(row.mappingEvidenceRef),
    });
  }
  if (kindDescriptor.value === "existing_mapping") {
    const row = exactRecord(value, [
      "kind",
      "mappingGeneration",
      "parentChatId",
      "projectId",
      "projectTargetSelectorMappingId",
      "targetDigest",
      "workspaceSelectorId",
    ]);
    return Object.freeze({
      kind: "existing_mapping",
      projectId: canonicalId("project", row.projectId),
      workspaceSelectorId: safeId(row.workspaceSelectorId),
      projectTargetSelectorMappingId: canonicalId(
        "projectTargetSelectorMapping",
        row.projectTargetSelectorMappingId,
      ),
      mappingGeneration: positiveInteger(row.mappingGeneration),
      targetDigest: digest(row.targetDigest),
      parentChatId: row.parentChatId === null ? null : canonicalId("logicalChat", row.parentChatId),
    });
  }
  invalidRequest();
}

function parseRuntime(value: unknown): ParsedOpenPayload["runtime"] {
  const row = exactRecord(value, [
    "expectedRuntimeOwnerAssignmentId",
    "localTrustEvidenceDigest",
    "localTrustEvidenceRef",
    "reattachmentEvidenceDigest",
    "reattachmentEvidenceRef",
    "reattachmentEvidenceSchemaId",
    "runtimeId",
    "nativeIncarnation",
    "runtimeOwnerAssignmentId",
    "signingKeyRef",
    "startIdentityDigest",
    "startIdentityRef",
    "startIdentitySchemaId",
    "wardenLaunchNonce",
  ]);
  let wardenLaunchNonce: ReturnType<typeof parseWardenLaunchNonce>;
  try {
    wardenLaunchNonce = parseWardenLaunchNonce(row.wardenLaunchNonce);
  } catch {
    invalidRequest();
  }
  const expectedRuntimeOwnerAssignmentId = nullableSafeId(row.expectedRuntimeOwnerAssignmentId);
  const reattachmentEvidenceSchemaId =
    row.reattachmentEvidenceSchemaId === null
      ? null
      : boundedSchemaId(row.reattachmentEvidenceSchemaId);
  const reattachmentEvidenceRef = nullableSafeId(row.reattachmentEvidenceRef);
  const reattachmentEvidenceDigest =
    row.reattachmentEvidenceDigest === null ? null : digest(row.reattachmentEvidenceDigest);
  if (
    (expectedRuntimeOwnerAssignmentId === null) !== (reattachmentEvidenceSchemaId === null) ||
    (reattachmentEvidenceSchemaId === null) !== (reattachmentEvidenceRef === null) ||
    (reattachmentEvidenceRef === null) !== (reattachmentEvidenceDigest === null)
  ) {
    invalidRequest();
  }
  return Object.freeze({
    runtimeId: canonicalId("nativeRuntime", row.runtimeId),
    nativeIncarnation: positiveInteger(row.nativeIncarnation),
    wardenLaunchNonce,
    startIdentitySchemaId: boundedSchemaId(row.startIdentitySchemaId),
    startIdentityRef: safeId(row.startIdentityRef),
    startIdentityDigest: digest(row.startIdentityDigest),
    runtimeOwnerAssignmentId: safeId(row.runtimeOwnerAssignmentId),
    expectedRuntimeOwnerAssignmentId,
    reattachmentEvidenceSchemaId,
    reattachmentEvidenceRef,
    reattachmentEvidenceDigest,
    signingKeyRef: canonicalId("protectedHandle", row.signingKeyRef),
    localTrustEvidenceRef: safeId(row.localTrustEvidenceRef),
    localTrustEvidenceDigest: digest(row.localTrustEvidenceDigest),
  });
}

function parseBinding(value: unknown): ParsedOpenPayload["binding"] {
  const row = exactRecord(value, [
    "attachmentGeneration",
    "attachmentId",
    "attachmentKind",
    "attachmentLeaseId",
    "disconnectPolicy",
    "nativeBindingIncarnationId",
    "resourceOwnership",
    "transportEpoch",
    "transportId",
  ]);
  if (
    row.attachmentKind !== "claude-inner-rc" &&
    row.attachmentKind !== "app-server" &&
    row.attachmentKind !== "server" &&
    row.attachmentKind !== "tmux"
  ) {
    invalidRequest();
  }
  if (row.resourceOwnership !== "dedicated_runtime" && row.resourceOwnership !== "shared_runtime") {
    invalidRequest();
  }
  if (row.disconnectPolicy !== "detach" && row.disconnectPolicy !== "terminate_when_idle") {
    invalidRequest();
  }
  return Object.freeze({
    nativeBindingIncarnationId: safeId(row.nativeBindingIncarnationId),
    attachmentId: safeId(row.attachmentId),
    attachmentKind: row.attachmentKind,
    transportId: safeId(row.transportId),
    attachmentGeneration: positiveInteger(row.attachmentGeneration),
    attachmentLeaseId: safeId(row.attachmentLeaseId),
    transportEpoch: positiveInteger(row.transportEpoch),
    resourceOwnership: row.resourceOwnership,
    disconnectPolicy: row.disconnectPolicy,
  });
}

function parseOpenPayload(value: RuntimeOwnerRpcJsonValue): ParsedOpenPayload {
  const row = exactRecord(value, [
    "binding",
    "descriptor",
    "expectedNativeRef",
    "initialPhase",
    "metadata",
    "nativeConversationLeaseId",
    "operationId",
    "registrationAttemptId",
    "runtime",
    "selection",
  ]);
  const parsedDescriptor = descriptor(row.descriptor);
  if (row.initialPhase !== "starting" && row.initialPhase !== "recovering") invalidRequest();
  const metadata = exactRecord(row.metadata, ["bytes", "schemaId"]);
  let expectedNativeRef: ReturnType<typeof createNativeConversationRefEvidence> | null = null;
  if (row.expectedNativeRef !== null) {
    try {
      expectedNativeRef = createNativeConversationRefEvidence(row.expectedNativeRef);
    } catch {
      invalidRequest();
    }
  }
  return Object.freeze({
    canonicalPayload: value,
    operationId: safeId(row.operationId),
    registrationAttemptId: canonicalId("registrationAttempt", row.registrationAttemptId),
    descriptor: parsedDescriptor,
    initialPhase: row.initialPhase,
    expectedNativeRef: expectedNativeRef?.value ?? null,
    expectedNativeRefDigest: expectedNativeRef?.canonicalDigest ?? null,
    selection: parseSelection(row.selection),
    metadataSchemaId: boundedSchemaId(metadata.schemaId),
    metadataBytes: boundedBase64url(metadata.bytes),
    runtime: parseRuntime(row.runtime),
    binding: parseBinding(row.binding),
    nativeConversationLeaseId: canonicalId(
      "nativeConversationLease",
      row.nativeConversationLeaseId,
    ),
  });
}

interface ParsedLeaseOperation {
  readonly canonicalPayload: RuntimeOwnerRpcJsonValue;
  readonly operationId: A1SafeId;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
}

interface ParsedNativeRootActivation {
  readonly operationId: A1SafeId;
  readonly kind: "activate" | "renew";
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly expectedPriorRootPathCertificateId: A1SafeId | null;
  readonly ttlMs: number;
}

function parseNativeRootActivation(value: RuntimeOwnerRpcJsonValue): ParsedNativeRootActivation {
  const row = exactRecord(value, [
    "expectedPriorRootPathCertificateId",
    "kind",
    "nativeConversationLeaseId",
    "operationId",
    "ttlMs",
  ]);
  if (row.kind !== "activate" && row.kind !== "renew") invalidRequest();
  const expectedPriorRootPathCertificateId = nullableSafeId(row.expectedPriorRootPathCertificateId);
  if ((row.kind === "activate") !== (expectedPriorRootPathCertificateId === null)) {
    invalidRequest();
  }
  const ttlMs = positiveInteger(row.ttlMs);
  if (ttlMs > NATIVE_ROOT_MAX_TTL_MS) invalidRequest();
  return Object.freeze({
    operationId: safeId(row.operationId),
    kind: row.kind,
    nativeConversationLeaseId: canonicalId(
      "nativeConversationLease",
      row.nativeConversationLeaseId,
    ),
    expectedPriorRootPathCertificateId,
    ttlMs,
  });
}

function parseLeaseOperation(
  value: RuntimeOwnerRpcJsonValue,
  extraKeys: readonly string[] = [],
): ParsedLeaseOperation & UnknownRecord {
  const row = exactRecord(value, ["nativeConversationLeaseId", "operationId", ...extraKeys]);
  return Object.freeze({
    ...row,
    canonicalPayload: value,
    operationId: safeId(row.operationId),
    nativeConversationLeaseId: canonicalId(
      "nativeConversationLease",
      row.nativeConversationLeaseId,
    ),
  });
}

interface OpenCandidate extends LivePort {
  readonly setup: Readonly<{
    readonly descriptor: NativeEngineDescriptor;
    readonly initialPhase: "starting" | "recovering";
    readonly binding: ParsedOpenPayload["binding"];
    readonly expectedNativeRefDigest: A1Digest | null;
  }>;
  readonly open: ParsedOpenPayload;
  readonly projectId: ProjectId;
  readonly logicalChatId: ReturnType<typeof parseA1CanonicalId<"logicalChat">>;
}

interface ReattachedOpenCandidate extends LivePort {
  readonly setup: OpenCandidate["setup"];
  readonly projectId: ProjectId;
  readonly logicalChatId: ReturnType<typeof parseA1CanonicalId<"logicalChat">>;
}

type BindingCandidate = OpenCandidate | ReattachedOpenCandidate;

function isBindingCandidate(candidate: LivePort): candidate is BindingCandidate {
  return "setup" in candidate && "projectId" in candidate && "logicalChatId" in candidate;
}

function parseAdapterEnvelope(value: RuntimeOwnerRpcJsonValue): Readonly<{
  operationId: A1SafeId;
  adapterRequest: RuntimeOwnerRpcJsonValue;
}> {
  const row = exactRecord(value, ["adapterRequest", "operationId"]);
  encodeRuntimeOwnerRpcCanonicalJson(row.adapterRequest);
  return Object.freeze({
    operationId: safeId(row.operationId),
    adapterRequest: row.adapterRequest as RuntimeOwnerRpcJsonValue,
  });
}

function adapterContext(context: RuntimeOwnerOperationContext): NativeRegistrationAdapterContext {
  return Object.freeze({
    connectionId: context.connectionId,
    requestId: context.requestId,
    signal: context.signal,
  });
}

function assertLivePort(
  candidate: LivePort | undefined,
  context: RuntimeOwnerOperationContext,
  coordinatorFence: CoordinatorLeaseFence,
): LivePort {
  const fence = ownerFence(context);
  if (
    candidate === undefined ||
    candidate.connectionId !== context.connectionId ||
    candidate.coordinatorFence.collaborationServerId !== coordinatorFence.collaborationServerId ||
    candidate.coordinatorFence.coordinatorLeaseId !== coordinatorFence.coordinatorLeaseId ||
    candidate.coordinatorFence.coordinatorEpoch !== coordinatorFence.coordinatorEpoch ||
    context.lease.runtimeOwnerServiceLeaseId !== fence.runtimeOwnerServiceLeaseId ||
    context.lease.runtimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch
  ) {
    throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
  }
  return candidate;
}

function gateGenerationFor(
  database: HostStateDatabase,
  nativeBindingId: NativeBindingId,
  attachmentLeaseId: A1SafeId,
): number {
  const gate = database.runtimeOwner
    .readInventory()
    .gates.find(
      (candidate) =>
        candidate.nativeBindingId === nativeBindingId &&
        candidate.currentAttachmentLeaseId === attachmentLeaseId,
    );
  if (gate === undefined) throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  return gate.gateGeneration;
}

function readCurrentRuntime(
  database: HostStateDatabase,
  runtimeId: NativeRuntimeId,
): RuntimeRegistrationResult | null {
  const founding = database.runtimeOwner.readRuntime(runtimeId);
  if (founding === null) return null;
  const inventory = database.runtimeOwner.readInventory();
  const runtime = inventory.runtimes.find((candidate) => candidate.runtimeId === runtimeId);
  const incarnation = inventory.incarnations.find(
    (candidate) =>
      candidate.runtimeId === runtimeId &&
      candidate.nativeIncarnation === runtime?.currentNativeIncarnation,
  );
  const assignment = inventory.assignments.find(
    (candidate) => candidate.runtimeOwnerAssignmentId === runtime?.currentRuntimeOwnerAssignmentId,
  );
  if (runtime === undefined || incarnation === undefined || assignment === undefined) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  return Object.freeze({ ...founding, runtime, incarnation, assignment });
}

class BoundNativeRegistrationOrchestrator implements NativeRegistrationOrchestrator {
  readonly operations: readonly RuntimeOwnerOperationDefinition[];
  readonly #database: NativeRegistrationDatabaseAccess;
  readonly #coordinator: NativeRegistrationCoordinatorAuthority;
  readonly #adapter: NativeRegistrationAdapter;
  readonly #candidates = new Map<string, LivePort>();

  constructor(options: NativeRegistrationOrchestratorOptions) {
    this.#database = options.database;
    this.#coordinator = options.coordinator;
    this.#adapter = options.adapter;
    this.operations = Object.freeze([
      this.#definition("native.registration.open", (payload, context) =>
        this.#open(payload, context),
      ),
      this.#definition("native.registration.bind", (payload, context) =>
        this.#bind(payload, context),
      ),
      this.#definition("native.registration.publish", (payload, context) =>
        this.#publish(payload, context),
      ),
      this.#definition("native.registration.ready", (payload, context) =>
        this.#ready(payload, context),
      ),
      this.#definition("native.registration.recover", (payload, context) =>
        this.#transition("recover", payload, context),
      ),
      this.#definition("native.registration.drain", (payload, context) =>
        this.#transition("drain", payload, context),
      ),
      this.#definition("native.registration.close", (payload, context) =>
        this.#close(payload, context),
      ),
      this.#definition("native.registration.reattach", (payload, context) =>
        this.#reattach(payload, context),
      ),
      this.#definition("native.root.activate", (payload, context) =>
        this.#activateNativeRoot(payload, context),
      ),
    ]);
    this.onCollaboratorDetach = this.onCollaboratorDetach.bind(this);
    Object.freeze(this.operations);
  }

  #definition(
    name: RuntimeOwnerOperationDefinition["name"],
    execute: RuntimeOwnerOperationDefinition["execute"],
  ): RuntimeOwnerOperationDefinition {
    return Object.freeze({ name, execute });
  }

  async #open(
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const envelope = parseAdapterEnvelope(value);
    const measured = await this.#adapter.measureOpen(
      envelope.adapterRequest,
      adapterContext(context),
    );
    if (context.signal.aborted) {
      throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
    }
    const payload = await validateOpenMeasurement(envelope.operationId, measured);
    const coordinatorFence = currentCoordinator(this.#coordinator);
    const fence = ownerFence(context);
    const prior = this.#candidates.get(payload.nativeConversationLeaseId);
    if (prior !== undefined) {
      const live = assertLivePort(prior, context, coordinatorFence);
      if (
        !("open" in live) ||
        !sameBytes(
          encodeRuntimeOwnerRpcCanonicalJson((live as OpenCandidate).open.canonicalPayload),
          encodeRuntimeOwnerRpcCanonicalJson(payload.canonicalPayload),
        )
      ) {
        throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
      }
      const exact = live as OpenCandidate;
      const input: NativeRegistrationOperationInputByKind["open"] = Object.freeze({
        fence,
        coordinatorFence,
        nativeConversationLeaseId: payload.nativeConversationLeaseId,
        registrationAttemptId: payload.registrationAttemptId,
        nativeBindingId: exact.nativeBindingId,
        runtimeId: exact.runtimeId,
        nativeIncarnation: exact.nativeIncarnation,
        protectedPortHandleId: exact.callablePortRef.protectedHandleId,
      });
      const replay = this.#database.use((current) =>
        current.registration.open({
          ...input,
          operation: registrationOperation("open", payload.operationId, input),
        }),
      );
      return response({
        nativeConversationLeaseId: payload.nativeConversationLeaseId,
        nativeBindingId: exact.nativeBindingId,
        logicalChatId: exact.logicalChatId,
        projectId: exact.projectId,
        callablePortRef: exact.callablePortRef,
        state: replay.lease.state,
        replayed: true,
      });
    }
    const foundation = await prepareOpenFoundation(
      this.#database,
      coordinatorFence,
      fence,
      context,
      payload,
    );
    let callablePortRef: RuntimeOwnerRpcCallablePortRef | undefined;
    let committedCandidate: OpenCandidate | undefined;
    try {
      let opened: ReturnType<HostStateDatabase["registration"]["open"]> | undefined;
      for (let attempt = 0; attempt < MAX_DURABLE_PORT_HANDLE_ATTEMPTS; attempt++) {
        callablePortRef = context.callablePort.register({
          nativeBindingId: foundation.nativeBindingId,
          runtimeId: payload.runtime.runtimeId,
          nativeIncarnation: payload.runtime.nativeIncarnation,
          attachmentLeaseId: payload.binding.attachmentLeaseId,
          coordinatorFence,
          portGeneration: 1,
        });
        const exactInput: NativeRegistrationOperationInputByKind["open"] = Object.freeze({
          fence,
          coordinatorFence,
          nativeConversationLeaseId: payload.nativeConversationLeaseId,
          registrationAttemptId: payload.registrationAttemptId,
          nativeBindingId: foundation.nativeBindingId,
          runtimeId: payload.runtime.runtimeId,
          nativeIncarnation: payload.runtime.nativeIncarnation,
          protectedPortHandleId: callablePortRef.protectedHandleId,
        });
        const request = Object.freeze({
          ...exactInput,
          operation: registrationOperation("open", payload.operationId, exactInput),
        });
        try {
          try {
            opened = this.#database.use((current) => current.registration.open(request));
          } catch (error) {
            opened = reconcileUnknownCommit(this.#database, error, () => {
              const reconciled = this.#database.use((current) =>
                current.registration.reconcileOperation("open", request),
              );
              return reconciled === null
                ? null
                : Object.freeze({
                    lease: reconciled.lease,
                    operation: reconciled.operation,
                    replayed: true,
                  });
            });
          }
          break;
        } catch (error) {
          if (
            !isDurableCallablePortHandleCollision(error) ||
            attempt + 1 === MAX_DURABLE_PORT_HANDLE_ATTEMPTS
          ) {
            throw error;
          }
          context.callablePort.unregister(callablePortRef);
          callablePortRef = undefined;
        }
      }
      if (opened === undefined || callablePortRef === undefined) {
        throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
      }
      const candidate = Object.freeze({
        connectionId: context.connectionId,
        leaseId: payload.nativeConversationLeaseId,
        nativeBindingId: foundation.nativeBindingId,
        runtimeId: payload.runtime.runtimeId,
        nativeIncarnation: payload.runtime.nativeIncarnation,
        attachmentLeaseId: payload.binding.attachmentLeaseId,
        portGeneration: 1,
        callablePortRef,
        coordinatorFence,
        setup: Object.freeze({
          descriptor: payload.descriptor,
          initialPhase: payload.initialPhase,
          binding: payload.binding,
          expectedNativeRefDigest: payload.expectedNativeRefDigest,
        }),
        open: payload,
        projectId: foundation.projectId,
        logicalChatId: foundation.logicalChatId,
      });
      this.#candidates.set(payload.nativeConversationLeaseId, candidate);
      committedCandidate = candidate;
      if (
        context.signal.aborted ||
        opened.lease.protectedPortHandleId !== callablePortRef.protectedHandleId ||
        opened.lease.state !== payload.initialPhase
      ) {
        throw new NativeRegistrationOrchestrationError(
          context.signal.aborted ? "LIVE_PORT_UNAVAILABLE" : "RESULT_MISMATCH",
        );
      }
      return response({
        nativeConversationLeaseId: payload.nativeConversationLeaseId,
        nativeBindingId: foundation.nativeBindingId,
        logicalChatId: foundation.logicalChatId,
        projectId: foundation.projectId,
        callablePortRef,
        state: opened.lease.state,
        replayed: opened.replayed,
      });
    } catch (error) {
      let safeToUnregister = committedCandidate === undefined;
      if (committedCandidate !== undefined) {
        const closeInput: NativeRegistrationOperationInputByKind["close"] = Object.freeze({
          fence,
          coordinatorFence,
          nativeConversationLeaseId: payload.nativeConversationLeaseId,
          expectedGateGeneration: null,
        });
        const cleanupId = internalOperation(
          payload.operationId,
          "open-abort-close",
          payload.nativeConversationLeaseId,
        ).operationId;
        const closeRequest = Object.freeze({
          ...closeInput,
          operation: createNativeRegistrationOperationEvidence("close", cleanupId, closeInput),
        });
        try {
          this.#database.use((current) => current.registration.close(closeRequest));
          this.#candidates.delete(payload.nativeConversationLeaseId);
          safeToUnregister = true;
        } catch {
          // Keep both map and live registry authority so connection detach can finish the close.
        }
      }
      if (callablePortRef !== undefined && safeToUnregister) {
        try {
          context.callablePort.unregister(callablePortRef);
        } catch {
          // Preserve the durable registration error; detach remains the final cleanup authority.
        }
      }
      throw error;
    }
  }

  async #invokeProof(
    candidate: LivePort,
    operationId: A1SafeId,
    selector: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
    exactEvidence?: RuntimeOwnerOperationEvidence,
  ) {
    const evidence = exactEvidence ?? internalOperation(operationId, "port-proof", selector);
    const result = await context.callablePort.invoke({
      nativeIncarnation: candidate.nativeIncarnation,
      attachmentLeaseId: candidate.attachmentLeaseId,
      portGeneration: candidate.portGeneration,
      request: {
        scopeKind: "native_binding",
        scopeId: candidate.nativeBindingId,
        callablePortRef: candidate.callablePortRef,
        providerCredential: null,
        nativeBindingId: candidate.nativeBindingId,
        runtimeId: candidate.runtimeId,
        fence: candidate.coordinatorFence,
        operationSchemaId: REGISTRATION_PROBE_OPERATION_SCHEMA_ID,
        operationRef: evidence.operationId,
        operationDigest: evidence.operationDigest,
      },
    });
    if (result.resultSchemaId !== REGISTRATION_PROBE_RESULT_SCHEMA_ID) {
      throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
    }
    return result;
  }

  async #activateNativeRoot(
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const parsed = parseNativeRootActivation(value);
    const coordinatorFence = currentCoordinator(this.#coordinator);
    const fence = ownerFence(context);
    const request = Object.freeze({
      fence,
      coordinatorFence,
      operationId: parsed.operationId,
      kind: parsed.kind,
      nativeConversationLeaseId: parsed.nativeConversationLeaseId,
      expectedPriorRootPathCertificateId: parsed.expectedPriorRootPathCertificateId,
      ttlMs: parsed.ttlMs,
    });

    // A completed request is a durable fact. Return it before asking for a fresh port proof, and
    // explicitly avoid presenting that historical replay as evidence of current native liveness.
    const historical = this.#database.use((current) =>
      current.terminalRoot.reconcileOperation(request),
    );
    if (historical !== null && historical.storedCertificate !== null) {
      return reconciledNativeRootResponse(historical);
    }

    const candidate = assertLivePort(
      this.#candidates.get(parsed.nativeConversationLeaseId),
      context,
      coordinatorFence,
    );
    let preparation: NativeRootPreparation;
    try {
      preparation = this.#database.use((current) => current.terminalRoot.prepare(request));
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      this.#database.reopenAfterUnknownCommit();
      const reconciled = this.#database.use((current) =>
        current.terminalRoot.reconcileOperation(request),
      );
      if (reconciled === null) {
        throw new NativeRegistrationOrchestrationError("COMMIT_NOT_RECONCILED", {
          cause: error,
        });
      }
      if (reconciled.storedCertificate !== null) {
        return reconciledNativeRootResponse(reconciled);
      }
      // Reconciliation proved the exact preparation committed. This replay only materializes its
      // already-bound protected payload and custody envelope; it cannot reserve or write anew.
      try {
        preparation = this.#database.use((current) => current.terminalRoot.prepare(request));
      } catch (replayError) {
        if (!(replayError instanceof HostStateCommitOutcomeUnknownError)) throw replayError;
        this.#database.reopenAfterUnknownCommit();
        const replayReconciliation = this.#database.use((current) =>
          current.terminalRoot.reconcileOperation(request),
        );
        if (replayReconciliation !== null && replayReconciliation.storedCertificate !== null) {
          return reconciledNativeRootResponse(replayReconciliation);
        }
        throw new NativeRegistrationOrchestrationError("COMMIT_NOT_RECONCILED", {
          cause: replayError,
        });
      }
    }
    if (
      preparation.operation.state !== "prepared" ||
      preparation.operation.nativeConversationLeaseId !== parsed.nativeConversationLeaseId ||
      preparation.operation.nativeBindingId !== candidate.nativeBindingId ||
      preparation.operation.runtimeId !== candidate.runtimeId ||
      preparation.operation.nativeIncarnation !== candidate.nativeIncarnation ||
      preparation.operation.attachmentLeaseId !== candidate.attachmentLeaseId ||
      preparation.operation.nativeConversationLeaseGeneration !== candidate.portGeneration ||
      preparation.operation.runtimeOwnerServiceLeaseId !== fence.runtimeOwnerServiceLeaseId ||
      preparation.operation.runtimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch ||
      preparation.operation.coordinatorLeaseId !== coordinatorFence.coordinatorLeaseId ||
      preparation.operation.coordinatorEpoch !== coordinatorFence.coordinatorEpoch
    ) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
    if (context.signal.aborted) {
      throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
    }
    const signature = signNativeRootPreparation(preparation, context);
    const nonceBytes = randomBytes(32);
    const serviceNonce = base64urlEncode(nonceBytes);
    nonceBytes.fill(0);
    const proofSelector = Object.freeze({
      phase: "native-root-finalize",
      connectionId: context.connectionId,
      nativeConversationLeaseId: parsed.nativeConversationLeaseId,
      nativeBindingId: candidate.nativeBindingId,
      runtimeId: candidate.runtimeId,
      nativeIncarnation: candidate.nativeIncarnation,
      attachmentLeaseId: candidate.attachmentLeaseId,
      portGeneration: candidate.portGeneration,
      activationOperationId: preparation.operation.operationId,
      activationOperationDigest: preparation.operation.operationDigest,
      rootPathCertificateId: preparation.operation.rootPathCertificateId,
      serviceNonce,
    });
    await this.#invokeProof(
      candidate,
      parsed.operationId,
      proofSelector,
      context,
      nativeRootProofOperation(parsed.operationId, serviceNonce, proofSelector),
    );
    if (context.signal.aborted) {
      throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
    }

    // No await is permitted between this last reverse proof/fence check and SQLite finalization.
    const finalCoordinatorFence = currentCoordinator(this.#coordinator);
    const finalCandidate = assertLivePort(
      this.#candidates.get(parsed.nativeConversationLeaseId),
      context,
      finalCoordinatorFence,
    );
    const finalFence = ownerFence(context);
    if (
      finalFence.runtimeOwnerServiceLeaseId !== fence.runtimeOwnerServiceLeaseId ||
      finalFence.runtimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch ||
      finalCoordinatorFence.collaborationServerId !== coordinatorFence.collaborationServerId ||
      finalCoordinatorFence.coordinatorLeaseId !== coordinatorFence.coordinatorLeaseId ||
      finalCoordinatorFence.coordinatorEpoch !== coordinatorFence.coordinatorEpoch ||
      finalCandidate.nativeBindingId !== candidate.nativeBindingId ||
      finalCandidate.runtimeId !== candidate.runtimeId ||
      finalCandidate.nativeIncarnation !== candidate.nativeIncarnation ||
      finalCandidate.attachmentLeaseId !== candidate.attachmentLeaseId ||
      finalCandidate.portGeneration !== candidate.portGeneration ||
      finalCandidate.callablePortRef.protectedHandleId !==
        candidate.callablePortRef.protectedHandleId
    ) {
      throw new NativeRegistrationOrchestrationError("STALE_AUTHORITY");
    }
    try {
      const activated = this.#database.use((current) =>
        current.terminalRoot.finalize({
          fence: finalFence,
          coordinatorFence: finalCoordinatorFence,
          operationId: parsed.operationId,
          signature,
        }),
      );
      return nativeRootResponse(activated, true);
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      this.#database.reopenAfterUnknownCommit();
      const reconciled = this.#database.use((current) =>
        current.terminalRoot.reconcileOperation(request),
      );
      if (
        reconciled === null ||
        reconciled.storedCertificate === null ||
        reconciled.storedCertificate.certificate.signature !== signature
      ) {
        throw new NativeRegistrationOrchestrationError("COMMIT_NOT_RECONCILED", {
          cause: error,
        });
      }
      return reconciledNativeRootResponse(reconciled);
    }
  }

  async #bind(
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const row = exactRecord(value, ["adapterRequest", "nativeConversationLeaseId", "operationId"]);
    const operationId = safeId(row.operationId);
    const leaseId = canonicalId("nativeConversationLease", row.nativeConversationLeaseId);
    const selector = row.adapterRequest as RuntimeOwnerRpcJsonValue;
    encodeRuntimeOwnerRpcCanonicalJson(selector);
    const coordinatorFence = currentCoordinator(this.#coordinator);
    const live = assertLivePort(this.#candidates.get(leaseId), context, coordinatorFence);
    if (!isBindingCandidate(live)) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
    const candidate = live;
    const fence = ownerFence(context);
    const bindInput: NativeRegistrationOperationInputByKind["bind"] = Object.freeze({
      fence,
      coordinatorFence,
      nativeConversationLeaseId: leaseId,
      nativeBindingIncarnationId: candidate.setup.binding.nativeBindingIncarnationId,
      attachmentLeaseId: candidate.attachmentLeaseId,
    });
    const bindRequest = Object.freeze({
      ...bindInput,
      operation: registrationOperation("bind", operationId, bindInput),
    });
    const proof = await this.#invokeProof(candidate, operationId, selector, context);
    const measured = await this.#adapter.measureBinding(
      selector,
      {
        resultSchemaId: proof.resultSchemaId,
        resultRef: proof.resultRef,
        resultDigest: proof.resultDigest,
      },
      adapterContext(context),
    );
    let nativeRef: ReturnType<typeof createNativeConversationRefEvidence>;
    try {
      nativeRef = createNativeConversationRefEvidence(measured.nativeRef);
    } catch {
      invalidRequest();
    }
    if (
      !sameDescriptor(nativeRef.value.descriptor, candidate.setup.descriptor) ||
      nativeRef.value.runtimeId !== candidate.runtimeId ||
      nativeRef.value.incarnation !== candidate.nativeIncarnation ||
      (candidate.setup.expectedNativeRefDigest !== null &&
        candidate.setup.expectedNativeRefDigest !== nativeRef.canonicalDigest)
    ) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
    const semanticConversationId = safeId(nativeRef.value.conversationId);
    const localTransitionId = safeId(measured.localTransitionId);
    const localNativeConversationId = safeId(measured.localNativeConversationId);
    const parentLocalNativeConversationId = nullableSafeId(
      measured.parentLocalNativeConversationId,
    );
    const measuredBinding = Object.freeze({
      selector,
      nativeRef: Object.freeze({
        descriptor: nativeRef.value.descriptor,
        runtimeId: candidate.runtimeId,
        conversationId: semanticConversationId,
        incarnation: candidate.nativeIncarnation,
      }),
      localTransitionId,
      localNativeConversationId,
      parentLocalNativeConversationId,
      setup: Object.freeze({
        descriptor: candidate.setup.descriptor,
        initialPhase: candidate.setup.initialPhase,
        binding: candidate.setup.binding,
        expectedNativeRefDigest: candidate.setup.expectedNativeRefDigest,
        projectId: candidate.projectId,
        logicalChatId: candidate.logicalChatId,
      }),
    }) as RuntimeOwnerRpcJsonValue;
    const localOperation = internalOperation(operationId, "local", measuredBinding);
    const bindingOperation = internalOperation(operationId, "binding", measuredBinding);
    const attachmentOperation = internalOperation(operationId, "attachment", measuredBinding);
    const reconciledBind = this.#database.use((current) =>
      current.registration.reconcileOperation("bind", bindRequest),
    );
    if (reconciledBind !== null) {
      const inventory = this.#database.use((current) => current.runtimeOwner.readInventory());
      const exactOperations = [
        [localOperation, localTransitionId],
        [bindingOperation, candidate.setup.binding.nativeBindingIncarnationId],
        [attachmentOperation, candidate.attachmentLeaseId],
      ] as const;
      for (const [expected, subjectId] of exactOperations) {
        const landed = inventory.journal.find(
          (entry) => entry.operationId === expected.operationId,
        );
        if (
          landed === undefined ||
          landed.subjectId !== subjectId ||
          landed.operationSchemaId !== expected.operationSchemaId ||
          landed.operationDigest !== expected.operationDigest
        ) {
          throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
        }
      }
      const conversation = inventory.conversations.find(
        (entry) => entry.localNativeConversationId === localNativeConversationId,
      );
      if (
        conversation === undefined ||
        conversation.runtimeId !== candidate.runtimeId ||
        conversation.nativeIncarnation !== candidate.nativeIncarnation ||
        conversation.projectId !== candidate.projectId ||
        conversation.semanticConversationId !== semanticConversationId ||
        conversation.parentLocalNativeConversationId !== parentLocalNativeConversationId ||
        !sameDescriptor(conversation.descriptor, candidate.setup.descriptor)
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      return response({
        nativeConversationLeaseId: leaseId,
        gateGeneration: this.#database.use((current) =>
          gateGenerationFor(current, candidate.nativeBindingId, candidate.attachmentLeaseId),
        ),
        state: reconciledBind.lease.state,
        replayed: true,
      });
    }
    const mutate = () =>
      this.#database.use((current) =>
        current.transaction((transaction) => {
          const artifact = transaction.putArtifact({
            scopeKind: "runtime",
            scopeId: candidate.runtimeId,
            artifactSchemaId: NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
            artifactDigest: nativeRef.canonicalDigest,
            artifactBytes: nativeRef.canonicalBytes,
          });
          transaction.runtimeOwner.appendLocalConversationTransition({
            fence,
            operation: localOperation,
            runtimeId: candidate.runtimeId,
            nativeIncarnation: candidate.nativeIncarnation,
            localTransitionId,
            kind: "discover",
            sourceLocalNativeConversationId: null,
            target: {
              localNativeConversationId,
              descriptor: candidate.setup.descriptor,
              projectId: candidate.projectId,
              semanticConversationId,
              parentLocalNativeConversationId,
              state: "open",
            },
            observedSemanticConversationId: semanticConversationId,
            nativeEvidenceSchemaId: NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
            nativeEvidenceRef: artifact.artifactRef.protectedHandleId,
            nativeEvidenceDigest: artifact.artifactDigest,
          });
          const prepared = transaction.runtimeOwner.prepareBindingRuntime({
            fence,
            coordinatorFence,
            bindingOperation,
            attachmentOperation,
            nativeBindingIncarnationId: candidate.setup.binding.nativeBindingIncarnationId,
            collaborationServerId: coordinatorFence.collaborationServerId,
            logicalChatId: candidate.logicalChatId,
            nativeBindingId: candidate.nativeBindingId,
            runtimeId: candidate.runtimeId,
            nativeIncarnation: candidate.nativeIncarnation,
            semanticConversationId,
            attachmentId: candidate.setup.binding.attachmentId,
            attachmentKind: candidate.setup.binding.attachmentKind,
            transportId: candidate.setup.binding.transportId,
            attachmentGeneration: candidate.setup.binding.attachmentGeneration,
            attachmentLeaseId: candidate.attachmentLeaseId,
            transportEpoch: candidate.setup.binding.transportEpoch,
            resourceOwnership: candidate.setup.binding.resourceOwnership,
            phase: candidate.setup.initialPhase,
            disconnectPolicy: candidate.setup.binding.disconnectPolicy,
          });
          const bound = transaction.registration.bind(bindRequest);
          return Object.freeze({ prepared, bound });
        }),
      );
    let result: ReturnType<typeof mutate>;
    try {
      result = mutate();
    } catch (error) {
      result = reconcileUnknownCommit(this.#database, error, () => {
        const reconciled = this.#database.use((current) =>
          current.registration.reconcileOperation("bind", bindRequest),
        );
        if (reconciled === null) return null;
        const journal = this.#database.use(
          (current) => current.runtimeOwner.readInventory().journal,
        );
        for (const [expected, subjectId] of [
          [localOperation, localTransitionId],
          [bindingOperation, candidate.setup.binding.nativeBindingIncarnationId],
          [attachmentOperation, candidate.attachmentLeaseId],
        ] as const) {
          const landed = journal.find((entry) => entry.operationId === expected.operationId);
          if (
            landed === undefined ||
            landed.subjectId !== subjectId ||
            landed.operationSchemaId !== expected.operationSchemaId ||
            landed.operationDigest !== expected.operationDigest
          ) {
            throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
          }
        }
        const gateGeneration = this.#database.use((current) =>
          gateGenerationFor(current, candidate.nativeBindingId, candidate.attachmentLeaseId),
        );
        return Object.freeze({
          bound: Object.freeze({
            lease: reconciled.lease,
            operation: reconciled.operation,
            replayed: true,
          }),
          prepared: Object.freeze({ gate: Object.freeze({ gateGeneration }) }),
        }) as ReturnType<typeof mutate>;
      });
    }
    return response({
      nativeConversationLeaseId: leaseId,
      gateGeneration: result.prepared.gate.gateGeneration,
      state: result.bound.lease.state,
      replayed: result.bound.replayed,
    });
  }

  async #publish(
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const row = exactRecord(value, [
      "adapterRequest",
      "nativeConversationLeaseId",
      "nativeRegistrationPublicationId",
      "operationId",
      "publicationGeneration",
    ]);
    const operationId = safeId(row.operationId);
    const leaseId = canonicalId("nativeConversationLease", row.nativeConversationLeaseId);
    const publicationId = safeId(row.nativeRegistrationPublicationId);
    const publicationGeneration = positiveInteger(row.publicationGeneration);
    const selector = row.adapterRequest as RuntimeOwnerRpcJsonValue;
    encodeRuntimeOwnerRpcCanonicalJson(selector);
    const coordinatorFence = currentCoordinator(this.#coordinator);
    const candidate = assertLivePort(this.#candidates.get(leaseId), context, coordinatorFence);
    const fence = ownerFence(context);
    const measured = await this.#adapter.measurePublication(selector, adapterContext(context));
    let metadata: ReturnType<typeof createNativeRegistrationMetadataEvidence>;
    let publishedCapabilities: ReturnType<typeof createNativeConversationCapabilitiesEvidence>;
    try {
      metadata = createNativeRegistrationMetadataEvidence({
        metadataSchemaId: boundedSchemaId(measured.metadataSchemaId),
        metadataBytes: Uint8Array.from(measured.metadataBytes),
      });
      if (metadata.value.metadataBytes.byteLength > MAX_METADATA_BYTES) invalidRequest();
      publishedCapabilities = createNativeConversationCapabilitiesEvidence(
        capabilities(measured.capabilities),
      );
    } catch (error) {
      if (error instanceof NativeRegistrationOrchestrationError) throw error;
      invalidRequest();
    }
    const inputWithoutRefs = Object.freeze({
      fence,
      coordinatorFence,
      nativeConversationLeaseId: leaseId,
      nativeRegistrationPublicationId: publicationId,
      publicationGeneration,
      metadataSchemaId: metadata.value.metadataSchemaId,
    });
    const expectedOperationId = internalOperation(
      operationId,
      "ledger-publish",
      operationId,
    ).operationId;
    const existingPublication = this.#database.use((current) => {
      const operation = current.registration.readOperation(expectedOperationId);
      if (operation === null) return null;
      const publication = current.registration
        .readInventory()
        .publications.find(
          (candidatePublication) =>
            candidatePublication.nativeRegistrationPublicationId === publicationId,
        );
      if (
        publication === undefined ||
        publication.nativeConversationLeaseId !== leaseId ||
        publication.publicationGeneration !== publicationGeneration ||
        publication.metadataSchemaId !== metadata.value.metadataSchemaId ||
        publication.metadataDigest !== metadata.canonicalDigest ||
        publication.capabilitiesDigest !== publishedCapabilities.canonicalDigest
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      const input: NativeRegistrationOperationInputByKind["publish"] = Object.freeze({
        ...inputWithoutRefs,
        metadataRef: publication.metadataRef,
        metadataDigest: publication.metadataDigest,
        capabilitiesRef: publication.capabilitiesRef,
        capabilitiesDigest: publication.capabilitiesDigest,
      });
      return current.registration.publish({
        ...input,
        operation: createNativeRegistrationOperationEvidence("publish", expectedOperationId, input),
      });
    });
    if (existingPublication !== null) {
      return response({
        nativeConversationLeaseId: leaseId,
        nativeRegistrationPublicationId: publicationId,
        publicationGeneration,
        state: existingPublication.lease.state,
        replayed: true,
      });
    }
    const mutate = () =>
      this.#database.use((current) =>
        current.transaction((transaction) => {
          const metadataArtifact = transaction.putArtifact({
            scopeKind: "native_binding",
            scopeId: candidate.nativeBindingId,
            artifactSchemaId: NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
            artifactDigest: metadata.canonicalDigest,
            artifactBytes: metadata.canonicalBytes,
          });
          const capabilitiesArtifact = transaction.putArtifact({
            scopeKind: "native_binding",
            scopeId: candidate.nativeBindingId,
            artifactSchemaId: NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
            artifactDigest: publishedCapabilities.canonicalDigest,
            artifactBytes: publishedCapabilities.canonicalBytes,
          });
          const input: NativeRegistrationOperationInputByKind["publish"] = Object.freeze({
            ...inputWithoutRefs,
            metadataRef: metadataArtifact.artifactRef.protectedHandleId,
            metadataDigest: metadataArtifact.artifactDigest,
            capabilitiesRef: capabilitiesArtifact.artifactRef.protectedHandleId,
            capabilitiesDigest: capabilitiesArtifact.artifactDigest,
          });
          return transaction.registration.publish({
            ...input,
            operation: registrationOperation("publish", operationId, input),
          });
        }),
      );
    try {
      const published = mutate();
      return response({
        nativeConversationLeaseId: leaseId,
        nativeRegistrationPublicationId: published.publication.nativeRegistrationPublicationId,
        publicationGeneration: published.publication.publicationGeneration,
        state: published.lease.state,
        replayed: published.replayed,
      });
    } catch (error) {
      // Artifact handles are allocated inside the unknown transaction, so the final publication
      // operation is the request-bound reconciliation marker. We never mint replacement artifacts.
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      this.#database.reopenAfterUnknownCommit();
      const publication = this.#database.use((current) => {
        const found = current.registration
          .readInventory()
          .publications.find(
            (candidatePublication) =>
              candidatePublication.nativeRegistrationPublicationId === publicationId &&
              candidatePublication.nativeConversationLeaseId === leaseId &&
              candidatePublication.publicationGeneration === publicationGeneration &&
              candidatePublication.metadataDigest === metadata.canonicalDigest &&
              candidatePublication.capabilitiesDigest === publishedCapabilities.canonicalDigest,
          );
        if (found === undefined) return undefined;
        const exactInput: NativeRegistrationOperationInputByKind["publish"] = Object.freeze({
          ...inputWithoutRefs,
          metadataRef: found.metadataRef,
          metadataDigest: found.metadataDigest,
          capabilitiesRef: found.capabilitiesRef,
          capabilitiesDigest: found.capabilitiesDigest,
        });
        const expected = createNativeRegistrationOperationEvidence(
          "publish",
          expectedOperationId,
          exactInput,
        );
        const operation = current.registration.readOperation(expectedOperationId);
        if (
          operation === null ||
          operation.kind !== "publish" ||
          operation.nativeConversationLeaseId !== leaseId ||
          operation.nativeBindingId !== candidate.nativeBindingId ||
          operation.operationSchemaId !== expected.operationSchemaId ||
          operation.operationDigest !== expected.operationDigest ||
          operation.runtimeOwnerServiceLeaseId !== fence.runtimeOwnerServiceLeaseId ||
          operation.runtimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch ||
          operation.coordinatorLeaseId !== coordinatorFence.coordinatorLeaseId ||
          operation.coordinatorEpoch !== coordinatorFence.coordinatorEpoch
        ) {
          throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
        }
        return found;
      });
      if (publication === undefined) {
        throw new NativeRegistrationOrchestrationError("COMMIT_NOT_RECONCILED", { cause: error });
      }
      const lease = this.#database.use((current) => current.registration.readLease(leaseId));
      if (lease === null || lease.currentPublicationId !== publicationId) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      return response({
        nativeConversationLeaseId: leaseId,
        nativeRegistrationPublicationId: publicationId,
        publicationGeneration,
        state: lease.state,
        replayed: true,
      });
    }
  }

  async #ready(
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const parsed = parseLeaseOperation(value, ["expectedGateGeneration", "expectedPublicationId"]);
    const gateGeneration = positiveInteger(parsed.expectedGateGeneration);
    const publicationId = safeId(parsed.expectedPublicationId);
    const coordinatorFence = currentCoordinator(this.#coordinator);
    const candidate = assertLivePort(
      this.#candidates.get(parsed.nativeConversationLeaseId),
      context,
      coordinatorFence,
    );
    const fence = ownerFence(context);
    const proofSelector = Object.freeze({
      phase: "ready",
      nativeConversationLeaseId: parsed.nativeConversationLeaseId,
      expectedPublicationId: publicationId,
    });
    const input: NativeRegistrationOperationInputByKind["ready"] = Object.freeze({
      fence,
      coordinatorFence,
      nativeConversationLeaseId: parsed.nativeConversationLeaseId,
      expectedGateGeneration: gateGeneration,
      expectedPublicationId: publicationId,
    });
    const request = Object.freeze({
      ...input,
      operation: registrationOperation("ready", parsed.operationId, input),
    });
    const historical = this.#database.use((current) =>
      current.registration.reconcileOperation("ready", request),
    );
    if (historical !== null) {
      const actualGateGeneration = this.#database.use((current) =>
        gateGenerationFor(current, candidate.nativeBindingId, candidate.attachmentLeaseId),
      );
      if (historical.lease.state === "ready") {
        await this.#invokeProof(
          candidate as OpenCandidate,
          parsed.operationId,
          proofSelector,
          context,
        );
      }
      return response({
        nativeConversationLeaseId: parsed.nativeConversationLeaseId,
        state: historical.lease.state,
        gateGeneration: actualGateGeneration,
        replayed: true,
      });
    }
    await this.#invokeProof(candidate as OpenCandidate, parsed.operationId, proofSelector, context);
    let ready: ReturnType<HostStateDatabase["registration"]["ready"]>;
    try {
      ready = this.#database.use((current) => current.registration.ready(request));
    } catch (error) {
      ready = reconcileUnknownCommit(this.#database, error, () => {
        const reconciled = this.#database.use((current) =>
          current.registration.reconcileOperation("ready", request),
        );
        return reconciled === null
          ? null
          : Object.freeze({
              lease: reconciled.lease,
              operation: reconciled.operation,
              replayed: true,
            });
      });
    }
    try {
      await this.#invokeProof(
        candidate as OpenCandidate,
        parsed.operationId,
        proofSelector,
        context,
      );
    } catch (error) {
      const recoverInput: NativeRegistrationOperationInputByKind["recover"] = Object.freeze({
        fence,
        coordinatorFence,
        nativeConversationLeaseId: parsed.nativeConversationLeaseId,
        expectedGateGeneration: gateGeneration + 1,
      });
      const recoveryOuterOperationId = internalOperation(
        parsed.operationId,
        "post-ready-recover",
        parsed.nativeConversationLeaseId,
      ).operationId;
      const recoverRequest = Object.freeze({
        ...recoverInput,
        operation: registrationOperation("recover", recoveryOuterOperationId, recoverInput),
      });
      try {
        this.#database.use((current) => current.registration.recover(recoverRequest));
      } catch (recoveryError) {
        reconcileUnknownCommit(this.#database, recoveryError, () => {
          const reconciled = this.#database.use((current) =>
            current.registration.reconcileOperation("recover", recoverRequest),
          );
          return reconciled === null
            ? null
            : Object.freeze({
                lease: reconciled.lease,
                operation: reconciled.operation,
                replayed: true,
              });
        });
      }
      throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE", { cause: error });
    }
    const actualGateGeneration = this.#database.use((current) =>
      gateGenerationFor(current, candidate.nativeBindingId, candidate.attachmentLeaseId),
    );
    return response({
      nativeConversationLeaseId: parsed.nativeConversationLeaseId,
      state: ready.lease.state,
      gateGeneration: actualGateGeneration,
      replayed: ready.replayed,
    });
  }

  #transition(
    kind: "recover" | "drain",
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const parsed = parseLeaseOperation(value, ["expectedGateGeneration"]);
    const expectedGateGeneration = positiveInteger(parsed.expectedGateGeneration);
    const coordinatorFence = currentCoordinator(this.#coordinator);
    assertLivePort(
      this.#candidates.get(parsed.nativeConversationLeaseId),
      context,
      coordinatorFence,
    );
    const fence = ownerFence(context);
    const input = Object.freeze({
      fence,
      coordinatorFence,
      nativeConversationLeaseId: parsed.nativeConversationLeaseId,
      expectedGateGeneration,
    });
    const request = Object.freeze({
      ...input,
      operation: registrationOperation(kind, parsed.operationId, input),
    });
    let result: ReturnType<HostStateDatabase["registration"]["recover"]>;
    try {
      result = this.#database.use((current) => current.registration[kind](request));
    } catch (error) {
      result = reconcileUnknownCommit(this.#database, error, () => {
        const reconciled = this.#database.use((current) =>
          current.registration.reconcileOperation(kind, request),
        );
        return reconciled === null
          ? null
          : Object.freeze({
              lease: reconciled.lease,
              operation: reconciled.operation,
              replayed: true,
            });
      });
    }
    return Promise.resolve(
      response({
        nativeConversationLeaseId: parsed.nativeConversationLeaseId,
        state: result.lease.state,
        gateGeneration: expectedGateGeneration + 1,
        replayed: result.replayed,
      }),
    );
  }

  #close(
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const parsed = parseLeaseOperation(value, ["expectedGateGeneration"]);
    const expectedGateGeneration =
      parsed.expectedGateGeneration === null
        ? null
        : positiveInteger(parsed.expectedGateGeneration);
    const expectedOperationId = internalOperation(
      parsed.operationId,
      "ledger-close",
      parsed.operationId,
    ).operationId;
    const historical = this.#database.use((current) => {
      const operation = current.registration.readOperation(expectedOperationId);
      if (operation === null) return null;
      const lease = current.registration.readLease(parsed.nativeConversationLeaseId);
      if (lease === null || lease.state !== "closed" || operation.kind !== "close") {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      const owner = current.runtimeOwner
        .readInventory()
        .serviceLeases.find(
          (candidateOwner) =>
            candidateOwner.runtimeOwnerServiceLeaseId === operation.runtimeOwnerServiceLeaseId &&
            candidateOwner.runtimeOwnerServiceEpoch === operation.runtimeOwnerServiceEpoch,
        );
      if (owner === undefined) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      const historicalInput: NativeRegistrationOperationInputByKind["close"] = Object.freeze({
        fence: {
          runtimeOwnerServiceLeaseId: operation.runtimeOwnerServiceLeaseId,
          runtimeOwnerServiceEpoch: operation.runtimeOwnerServiceEpoch,
          ownerInstanceId: owner.ownerInstanceId,
          ownerProcessStartIdentitySchemaId: owner.ownerProcessStartIdentitySchemaId,
          ownerProcessStartIdentityRef: owner.ownerProcessStartIdentityRef,
          ownerProcessStartIdentityDigest: owner.ownerProcessStartIdentityDigest,
        },
        coordinatorFence: {
          collaborationServerId: lease.collaborationServerId,
          coordinatorLeaseId: operation.coordinatorLeaseId,
          coordinatorEpoch: operation.coordinatorEpoch,
        },
        nativeConversationLeaseId: parsed.nativeConversationLeaseId,
        expectedGateGeneration,
      });
      const expected = createNativeRegistrationOperationEvidence(
        "close",
        expectedOperationId,
        historicalInput,
      );
      if (
        operation.nativeConversationLeaseId !== parsed.nativeConversationLeaseId ||
        operation.nativeBindingId !== lease.nativeBindingId ||
        operation.operationSchemaId !== expected.operationSchemaId ||
        operation.operationDigest !== expected.operationDigest
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      return lease;
    });
    if (historical !== null) {
      this.#candidates.delete(parsed.nativeConversationLeaseId);
      return Promise.resolve(
        response({
          nativeConversationLeaseId: parsed.nativeConversationLeaseId,
          state: historical.state,
          replayed: true,
        }),
      );
    }
    const coordinatorFence = currentCoordinator(this.#coordinator);
    const candidate = assertLivePort(
      this.#candidates.get(parsed.nativeConversationLeaseId),
      context,
      coordinatorFence,
    );
    const fence = ownerFence(context);
    const input: NativeRegistrationOperationInputByKind["close"] = Object.freeze({
      fence,
      coordinatorFence,
      nativeConversationLeaseId: parsed.nativeConversationLeaseId,
      expectedGateGeneration,
    });
    const request = Object.freeze({
      ...input,
      operation: registrationOperation("close", parsed.operationId, input),
    });
    let result: ReturnType<HostStateDatabase["registration"]["close"]>;
    try {
      result = this.#database.use((current) => current.registration.close(request));
    } catch (error) {
      result = reconcileUnknownCommit(this.#database, error, () => {
        const reconciled = this.#database.use((current) =>
          current.registration.reconcileOperation("close", request),
        );
        return reconciled === null
          ? null
          : Object.freeze({
              lease: reconciled.lease,
              operation: reconciled.operation,
              replayed: true,
            });
      });
    }
    this.#candidates.delete(parsed.nativeConversationLeaseId);
    try {
      context.callablePort.unregister(candidate.callablePortRef);
    } catch {
      // Durable close is authoritative; the RPC connection registry drops the handle on detach.
    }
    return Promise.resolve(
      response({
        nativeConversationLeaseId: parsed.nativeConversationLeaseId,
        state: result.lease.state,
        replayed: result.replayed,
      }),
    );
  }

  async #reattach(
    value: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const row = exactRecord(value, [
      "adapterRequest",
      "operationId",
      "predecessorNativeConversationLeaseId",
    ]);
    const operationId = safeId(row.operationId);
    const selector = row.adapterRequest as RuntimeOwnerRpcJsonValue;
    encodeRuntimeOwnerRpcCanonicalJson(selector);
    const predecessorId = canonicalId(
      "nativeConversationLease",
      row.predecessorNativeConversationLeaseId,
    );
    const predecessor = this.#database.use((current) =>
      current.registration.readLease(predecessorId),
    );
    if (predecessor === null) throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    const measured = await this.#adapter.measureReattach(
      selector,
      {
        nativeConversationLeaseId: predecessor.nativeConversationLeaseId,
        nativeBindingId: predecessor.nativeBindingId,
        runtimeId: predecessor.runtimeId,
        nativeIncarnation: predecessor.nativeIncarnation,
        leaseGeneration: predecessor.leaseGeneration,
      },
      adapterContext(context),
    );
    const successorId = canonicalId("nativeConversationLease", measured.nativeConversationLeaseId);
    const successorAttachmentLeaseId = nullableSafeId(measured.successorAttachmentLeaseId);
    const successorBinding =
      measured.successorBinding === null ? null : parseBinding(measured.successorBinding);
    const portGeneration = predecessor.leaseGeneration + 1;
    const coordinatorFence = currentCoordinator(this.#coordinator);
    const fence = ownerFence(context);
    const expectedRuntimeOwnerAssignmentId = nullableSafeId(
      measured.expectedRuntimeOwnerAssignmentId,
    );
    const runtimeOwnerAssignmentId = nullableSafeId(measured.runtimeOwnerAssignmentId);
    const reattachmentEvidenceSchemaId =
      measured.reattachmentEvidenceSchemaId === null
        ? null
        : boundedSchemaId(measured.reattachmentEvidenceSchemaId);
    const reattachmentEvidenceRef = nullableSafeId(measured.reattachmentEvidenceRef);
    const reattachmentEvidenceDigest =
      measured.reattachmentEvidenceDigest === null
        ? null
        : digest(measured.reattachmentEvidenceDigest);
    if (
      (expectedRuntimeOwnerAssignmentId === null) !== (runtimeOwnerAssignmentId === null) ||
      (runtimeOwnerAssignmentId === null) !== (reattachmentEvidenceSchemaId === null) ||
      (reattachmentEvidenceSchemaId === null) !== (reattachmentEvidenceRef === null) ||
      (reattachmentEvidenceRef === null) !== (reattachmentEvidenceDigest === null)
    ) {
      invalidRequest();
    }
    const predecessorIsUnbound =
      predecessor.nativeBindingIncarnationId === null && predecessor.attachmentLeaseId === null;
    if (
      predecessorIsUnbound !==
        (predecessor.nativeBindingIncarnationId === null ||
          predecessor.attachmentLeaseId === null) ||
      (predecessorIsUnbound &&
        (successorAttachmentLeaseId !== null || successorBinding === null)) ||
      (!predecessorIsUnbound && successorBinding !== null)
    ) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
    const runtime = this.#database.use((current) =>
      readCurrentRuntime(current, predecessor.runtimeId),
    );
    if (
      runtime === null ||
      runtime.runtime.currentNativeIncarnation !== predecessor.nativeIncarnation
    ) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
    const assignmentAlreadyCurrent =
      runtime.assignment.runtimeOwnerServiceLeaseId === fence.runtimeOwnerServiceLeaseId &&
      runtime.assignment.runtimeOwnerServiceEpoch === fence.runtimeOwnerServiceEpoch;
    let runtimeReassignRequest: ReassignRuntimeOwnerRequest | null = null;
    if (assignmentAlreadyCurrent) {
      const expectedOperation = internalOperation(operationId, "runtime-reattach", selector);
      const landed = this.#database.use((current) =>
        current.runtimeOwner.readOperation(expectedOperation.operationId),
      );
      if (landed === null) {
        if (
          expectedRuntimeOwnerAssignmentId !== null ||
          runtimeOwnerAssignmentId !== null ||
          reattachmentEvidenceSchemaId !== null ||
          reattachmentEvidenceRef !== null ||
          reattachmentEvidenceDigest !== null
        ) {
          throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
        }
      } else if (
        expectedRuntimeOwnerAssignmentId === null ||
        runtimeOwnerAssignmentId === null ||
        reattachmentEvidenceSchemaId === null ||
        reattachmentEvidenceRef === null ||
        reattachmentEvidenceDigest === null ||
        landed.operationSchemaId !== expectedOperation.operationSchemaId ||
        landed.operationDigest !== expectedOperation.operationDigest ||
        runtimeOwnerAssignmentId !== runtime.assignment.runtimeOwnerAssignmentId ||
        runtime.assignment.supersedesRuntimeOwnerAssignmentId !==
          expectedRuntimeOwnerAssignmentId ||
        runtime.assignment.assignmentEvidenceSchemaId !== reattachmentEvidenceSchemaId ||
        runtime.assignment.assignmentEvidenceRef !== reattachmentEvidenceRef ||
        runtime.assignment.assignmentEvidenceDigest !== reattachmentEvidenceDigest
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
    } else {
      if (
        expectedRuntimeOwnerAssignmentId !== runtime.assignment.runtimeOwnerAssignmentId ||
        runtimeOwnerAssignmentId === null ||
        reattachmentEvidenceSchemaId === null ||
        reattachmentEvidenceRef === null ||
        reattachmentEvidenceDigest === null
      ) {
        invalidRequest();
      }
      runtimeReassignRequest = Object.freeze({
        fence,
        operation: internalOperation(operationId, "runtime-reattach", selector),
        runtimeId: predecessor.runtimeId,
        nativeIncarnation: predecessor.nativeIncarnation,
        expectedRuntimeOwnerAssignmentId,
        runtimeOwnerAssignmentId,
        reattachmentEvidenceSchemaId,
        reattachmentEvidenceRef,
        reattachmentEvidenceDigest,
      });
    }
    const prior = this.#candidates.get(successorId);
    if (prior !== undefined) {
      const live = assertLivePort(prior, context, coordinatorFence);
      if (
        successorBinding !== null &&
        (!isBindingCandidate(live) ||
          !sameBytes(
            encodeRuntimeOwnerRpcCanonicalJson(live.setup.binding),
            encodeRuntimeOwnerRpcCanonicalJson(successorBinding),
          ))
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      const replay = live.reattachReplay;
      if (
        replay === undefined ||
        replay.outerOperationId !== operationId ||
        replay.request.successorAttachmentLeaseId !== successorAttachmentLeaseId ||
        !sameBytes(
          encodeRuntimeOwnerRpcCanonicalJson(replay.selector),
          encodeRuntimeOwnerRpcCanonicalJson(selector),
        )
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      const reconciled = this.#database.use((current) =>
        current.registration.reconcileOperation("reattach", replay.request),
      );
      const successor = reconciled?.lease ?? null;
      const expectedDurableAttachmentLeaseId =
        successorAttachmentLeaseId ?? predecessor.attachmentLeaseId;
      const expectedLiveAttachmentLeaseId =
        successorBinding?.attachmentLeaseId ?? expectedDurableAttachmentLeaseId;
      if (
        successor === null ||
        successor.supersedesNativeConversationLeaseId !== predecessorId ||
        successor.protectedPortHandleId !== live.callablePortRef.protectedHandleId ||
        successor.attachmentLeaseId !== expectedDurableAttachmentLeaseId ||
        live.attachmentLeaseId !== expectedLiveAttachmentLeaseId ||
        successor.leaseGeneration !== portGeneration ||
        live.portGeneration !== portGeneration ||
        successor.nativeConversationLeaseId !== successorId
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
      return response({
        predecessorNativeConversationLeaseId: predecessorId,
        nativeConversationLeaseId: successorId,
        callablePortRef: live.callablePortRef,
        portGeneration,
        state: successor.state,
        replayed: true,
      });
    }
    const expectedGateGeneration =
      predecessor.attachmentLeaseId === null
        ? null
        : this.#database.use((current) =>
            gateGenerationFor(
              current,
              predecessor.nativeBindingId,
              predecessor.attachmentLeaseId as A1SafeId,
            ),
          );
    const attachmentLeaseId =
      successorBinding?.attachmentLeaseId ??
      successorAttachmentLeaseId ??
      predecessor.attachmentLeaseId;
    if (attachmentLeaseId === null) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
    const recoveredFoundation =
      successorBinding === null
        ? null
        : this.#database.use((current) => {
            const reservation = current.records.readTerminalReservation(
              predecessor.collaborationServerId,
              predecessor.registrationAttemptId,
            );
            if (
              reservation === null ||
              reservation.binding.nativeBindingId !== predecessor.nativeBindingId ||
              reservation.chat.logicalChatId !== predecessor.logicalChatId ||
              !sameDescriptor(reservation.binding.descriptor, runtime.runtime.descriptor)
            ) {
              throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
            }
            return Object.freeze({
              descriptor: runtime.runtime.descriptor,
              initialPhase: "recovering" as const,
              binding: successorBinding,
              expectedNativeRefDigest: reservation.registrationIntent.expectedNativeRefDigest,
              projectId: reservation.project.projectId,
              logicalChatId: reservation.chat.logicalChatId,
            });
          });
    const closeInput: NativeRegistrationOperationInputByKind["close"] = Object.freeze({
      fence,
      coordinatorFence,
      nativeConversationLeaseId: predecessorId,
      expectedGateGeneration,
    });
    const predecessorCloseOperation =
      predecessor.state === "closed"
        ? this.#database.use((current) => {
            const stored = current.registration
              .readInventory()
              .operations.filter(
                (candidateOperation) =>
                  candidateOperation.nativeConversationLeaseId === predecessorId &&
                  candidateOperation.kind === "close",
              )
              .sort((left, right) => right.operationSequence - left.operationSequence)[0];
            if (stored === undefined) {
              throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
            }
            return Object.freeze({
              operationId: stored.operationId,
              operationSchemaId: stored.operationSchemaId,
              operationDigest: stored.operationDigest,
            });
          })
        : registrationOperation(
            "close",
            internalOperation(operationId, "reattach-close", operationId).operationId,
            closeInput,
          );
    let callablePortRef: RuntimeOwnerRpcCallablePortRef | undefined;
    try {
      let result:
        | Readonly<{ readonly lease: NativeConversationLeaseRecord; readonly replayed: boolean }>
        | undefined;
      let committedRequest:
        | Parameters<HostStateDatabase["registration"]["reattach"]>[0]
        | undefined;
      for (let attempt = 0; attempt < MAX_DURABLE_PORT_HANDLE_ATTEMPTS; attempt++) {
        callablePortRef = context.callablePort.register({
          nativeBindingId: predecessor.nativeBindingId,
          runtimeId: predecessor.runtimeId,
          nativeIncarnation: predecessor.nativeIncarnation,
          attachmentLeaseId,
          coordinatorFence,
          portGeneration,
        });
        const input: NativeRegistrationOperationInputByKind["reattach"] = Object.freeze({
          fence,
          coordinatorFence,
          predecessorCloseOperation,
          predecessorNativeConversationLeaseId: predecessorId,
          nativeConversationLeaseId: successorId,
          protectedPortHandleId: callablePortRef.protectedHandleId,
          successorAttachmentLeaseId,
          expectedGateGeneration,
        });
        const request = Object.freeze({
          ...input,
          operation: registrationOperation("reattach", operationId, input),
        });
        try {
          try {
            result = this.#database.use((current) =>
              current.transaction((transaction) => {
                if (runtimeReassignRequest !== null) {
                  transaction.runtimeOwner.reassignRuntimeOwner(runtimeReassignRequest);
                }
                return transaction.registration.reattach(request);
              }),
            );
          } catch (error) {
            result = reconcileUnknownCommit(this.#database, error, () => {
              const reconciled = this.#database.use((current) =>
                current.registration.reconcileOperation("reattach", request),
              );
              return reconciled === null
                ? null
                : Object.freeze({
                    lease: reconciled.lease,
                    replayed: true,
                  });
            });
          }
          committedRequest = request;
          break;
        } catch (error) {
          if (
            !isDurableCallablePortHandleCollision(error) ||
            attempt + 1 === MAX_DURABLE_PORT_HANDLE_ATTEMPTS
          ) {
            throw error;
          }
          context.callablePort.unregister(callablePortRef);
          callablePortRef = undefined;
        }
      }
      if (result === undefined || callablePortRef === undefined || committedRequest === undefined) {
        throw new NativeRegistrationOrchestrationError("LIVE_PORT_UNAVAILABLE");
      }
      const livePort = Object.freeze({
        connectionId: context.connectionId,
        leaseId: successorId,
        nativeBindingId: predecessor.nativeBindingId,
        runtimeId: predecessor.runtimeId,
        nativeIncarnation: predecessor.nativeIncarnation,
        attachmentLeaseId,
        portGeneration,
        callablePortRef,
        coordinatorFence,
        reattachReplay: Object.freeze({
          outerOperationId: operationId,
          selector,
          request: committedRequest,
        }),
      });
      const candidate: LivePort =
        recoveredFoundation === null
          ? livePort
          : Object.freeze({
              ...livePort,
              setup: Object.freeze({
                descriptor: recoveredFoundation.descriptor,
                initialPhase: recoveredFoundation.initialPhase,
                binding: recoveredFoundation.binding,
                expectedNativeRefDigest: recoveredFoundation.expectedNativeRefDigest,
              }),
              projectId: recoveredFoundation.projectId,
              logicalChatId: recoveredFoundation.logicalChatId,
            });
      this.#candidates.delete(predecessorId);
      this.#candidates.set(successorId, candidate);
      return response({
        predecessorNativeConversationLeaseId: predecessorId,
        nativeConversationLeaseId: successorId,
        callablePortRef,
        portGeneration,
        state: result.lease.state,
        replayed: result.replayed,
      });
    } catch (error) {
      if (callablePortRef !== undefined) {
        try {
          context.callablePort.unregister(callablePortRef);
        } catch {
          // Connection detach performs final in-memory cleanup.
        }
      }
      throw error;
    }
  }

  async onCollaboratorDetach(context: RuntimeOwnerCollaboratorDetachContext): Promise<void> {
    const currentFence: RuntimeOwnerServiceFence = Object.freeze({
      runtimeOwnerServiceLeaseId: parseA1SafeId(context.assertCurrent().runtimeOwnerServiceLeaseId),
      runtimeOwnerServiceEpoch: context.lease.runtimeOwnerServiceEpoch,
      ownerInstanceId: parseA1SafeId(context.lease.ownerInstanceId),
      ownerProcessStartIdentitySchemaId: context.lease.ownerStartIdentitySchemaId,
      ownerProcessStartIdentityRef: parseA1SafeId(context.lease.ownerStartIdentityRef),
      ownerProcessStartIdentityDigest: parseA1Digest(context.lease.ownerStartIdentityDigest),
    });
    for (const entry of context.callablePorts) {
      const candidate =
        this.#candidates.get(entry.nativeBindingId) ??
        [...this.#candidates.values()].find(
          (value) =>
            value.callablePortRef.protectedHandleId === entry.callablePortRef.protectedHandleId,
        );
      if (candidate === undefined) continue;
      const lease = this.#database.use((current) =>
        current.registration.readLease(candidate.leaseId),
      );
      if (
        lease === null ||
        lease.state === "closed" ||
        lease.protectedPortHandleId !== entry.callablePortRef.protectedHandleId ||
        lease.runtimeOwnerServiceLeaseId !== entry.ownerFence.runtimeOwnerServiceLeaseId ||
        lease.runtimeOwnerServiceEpoch !== entry.ownerFence.runtimeOwnerServiceEpoch ||
        lease.coordinatorLeaseId !== entry.coordinatorFence.coordinatorLeaseId ||
        lease.coordinatorEpoch !== entry.coordinatorFence.coordinatorEpoch
      ) {
        continue;
      }
      const expectedGateGeneration =
        lease.attachmentLeaseId === null
          ? null
          : this.#database.use((current) =>
              gateGenerationFor(
                current,
                lease.nativeBindingId,
                lease.attachmentLeaseId as A1SafeId,
              ),
            );
      const closeInput: NativeRegistrationOperationInputByKind["close"] = Object.freeze({
        fence: currentFence,
        coordinatorFence: entry.coordinatorFence,
        nativeConversationLeaseId: lease.nativeConversationLeaseId,
        expectedGateGeneration,
      });
      const closeId = internalOperation(
        parseA1SafeId(entry.callablePortRef.protectedHandleId),
        "detach-close",
        lease.nativeConversationLeaseId,
      ).operationId;
      const request = Object.freeze({
        ...closeInput,
        operation: createNativeRegistrationOperationEvidence("close", closeId, closeInput),
      });
      try {
        this.#database.use((current) => current.registration.close(request));
      } catch (error) {
        reconcileUnknownCommit(this.#database, error, () => {
          const reconciled = this.#database.use((current) =>
            current.registration.reconcileOperation("close", request),
          );
          return reconciled === null
            ? null
            : Object.freeze({
                lease: reconciled.lease,
                operation: reconciled.operation,
                replayed: true,
              });
        });
      }
      this.#candidates.delete(candidate.leaseId);
    }
  }
}

export function createNativeRegistrationOrchestrator(
  options: NativeRegistrationOrchestratorOptions,
): NativeRegistrationOrchestrator {
  if (
    typeof options.adapter?.measureOpen !== "function" ||
    typeof options.adapter.measureBinding !== "function" ||
    typeof options.adapter.measureReattach !== "function" ||
    typeof options.adapter.measurePublication !== "function"
  ) {
    throw new NativeRegistrationOrchestrationError("INVALID_REQUEST");
  }
  return Object.freeze(new BoundNativeRegistrationOrchestrator(options));
}

interface OpenFoundation {
  readonly nativeBindingId: NativeBindingId;
  readonly logicalChatId: ReturnType<typeof parseA1CanonicalId<"logicalChat">>;
  readonly projectId: ProjectId;
}

function foundingRuntimePayload(payload: ParsedOpenPayload): RuntimeOwnerRpcJsonValue {
  return Object.freeze({
    descriptor: payload.descriptor,
    runtime: Object.freeze({
      runtimeId: payload.runtime.runtimeId,
      nativeIncarnation: payload.runtime.nativeIncarnation,
      wardenLaunchNonce: payload.runtime.wardenLaunchNonce,
      startIdentitySchemaId: payload.runtime.startIdentitySchemaId,
      startIdentityRef: payload.runtime.startIdentityRef,
      startIdentityDigest: payload.runtime.startIdentityDigest,
      runtimeOwnerAssignmentId:
        payload.runtime.expectedRuntimeOwnerAssignmentId ??
        payload.runtime.runtimeOwnerAssignmentId,
      signingKeyRef: payload.runtime.signingKeyRef,
      localTrustEvidenceRef: payload.runtime.localTrustEvidenceRef,
      localTrustEvidenceDigest: payload.runtime.localTrustEvidenceDigest,
    }),
  });
}

function runtimeReassignmentPayload(payload: ParsedOpenPayload): RuntimeOwnerRpcJsonValue {
  return Object.freeze({
    runtimeId: payload.runtime.runtimeId,
    nativeIncarnation: payload.runtime.nativeIncarnation,
    expectedRuntimeOwnerAssignmentId: payload.runtime.expectedRuntimeOwnerAssignmentId,
    runtimeOwnerAssignmentId: payload.runtime.runtimeOwnerAssignmentId,
    reattachmentEvidenceSchemaId: payload.runtime.reattachmentEvidenceSchemaId,
    reattachmentEvidenceRef: payload.runtime.reattachmentEvidenceRef,
    reattachmentEvidenceDigest: payload.runtime.reattachmentEvidenceDigest,
  });
}

function assertRuntimeOperationMarker(
  database: HostStateDatabase,
  operation: RuntimeOwnerOperationEvidence,
  expected: boolean,
): void {
  const landed = database.runtimeOwner.readOperation(operation.operationId);
  if (
    (landed === null) !== !expected ||
    (landed !== null &&
      (landed.operationSchemaId !== operation.operationSchemaId ||
        landed.operationDigest !== operation.operationDigest))
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
}

function reconcileUnknownCommit<T>(
  database: NativeRegistrationDatabaseAccess,
  error: unknown,
  reconcile: () => T | null,
): T {
  if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
  database.reopenAfterUnknownCommit();
  const result = reconcile();
  if (result === null) {
    throw new NativeRegistrationOrchestrationError("COMMIT_NOT_RECONCILED", { cause: error });
  }
  return result;
}

function currentCoordinator(
  authority: NativeRegistrationCoordinatorAuthority,
): CoordinatorLeaseFence {
  let fence: CoordinatorLeaseFence;
  try {
    fence = authority.assertCurrent();
  } catch (error) {
    throw new NativeRegistrationOrchestrationError("STALE_AUTHORITY", { cause: error });
  }
  if (
    fence.collaborationServerId !== authority.fence.collaborationServerId ||
    fence.coordinatorLeaseId !== authority.fence.coordinatorLeaseId ||
    fence.coordinatorEpoch !== authority.fence.coordinatorEpoch
  ) {
    throw new NativeRegistrationOrchestrationError("STALE_AUTHORITY");
  }
  return fence;
}

function existingFoundation(
  database: HostStateDatabase,
  payload: ParsedOpenPayload,
  collaborationServerId: CollaborationServerId,
  evidence: Readonly<{
    descriptorDigest: A1Digest;
    projectDigest: A1Digest;
    metadataDigest: A1Digest;
    targetDigest: A1Digest;
    runtimeCreateOperation: RuntimeOwnerOperationEvidence;
    runtimeReassignOperation: RuntimeOwnerOperationEvidence;
  }>,
): OpenFoundation | null {
  const reservation = database.records.readTerminalReservation(
    collaborationServerId,
    payload.registrationAttemptId,
  );
  if (reservation === null) return null;
  if (
    !sameDescriptor(reservation.binding.descriptor, payload.descriptor) ||
    reservation.registrationIntent.expectedNativeRefDigest !== payload.expectedNativeRefDigest ||
    reservation.registrationIntent.initialPhase !== payload.initialPhase ||
    reservation.registrationIntent.metadataSchemaId !== payload.metadataSchemaId ||
    reservation.registrationIntent.descriptorDigest !== evidence.descriptorDigest ||
    reservation.registrationIntent.projectDigest !== evidence.projectDigest ||
    reservation.registrationIntent.metadataDigest !== evidence.metadataDigest ||
    reservation.mapping.workspaceSelectorId !== payload.selection.workspaceSelectorId ||
    reservation.chat.parentChatId !==
      (payload.selection.kind === "existing_mapping" ? payload.selection.parentChatId : null) ||
    reservation.mapping.targetDigest !== evidence.targetDigest ||
    reservation.project.projectId !==
      (payload.selection.kind === "existing_mapping"
        ? payload.selection.projectId
        : reservation.project.projectId)
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  if (
    payload.selection.kind === "existing_mapping" &&
    (reservation.mapping.projectTargetSelectorMappingId !==
      payload.selection.projectTargetSelectorMappingId ||
      reservation.mapping.mappingGeneration !== payload.selection.mappingGeneration)
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  if (
    payload.selection.kind === "first_bootstrap" &&
    reservation.mapping.evidenceRef !== payload.selection.mappingEvidenceRef
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  database.readVerifiedArtifact({
    scopeKind: "collaboration_server",
    scopeId: collaborationServerId,
    artifactRef: {
      protectedHandleId: parseA1CanonicalId(
        "protectedHandle",
        reservation.registrationIntent.descriptorRef,
      ),
      kind: "artifact",
    },
    artifactSchemaId: NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
    expectedArtifactDigest: evidence.descriptorDigest,
  });
  database.readVerifiedArtifact({
    scopeKind: "collaboration_server",
    scopeId: collaborationServerId,
    artifactRef: {
      protectedHandleId: parseA1CanonicalId(
        "protectedHandle",
        reservation.registrationIntent.projectRef,
      ),
      kind: "artifact",
    },
    artifactSchemaId: DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
    expectedArtifactDigest: evidence.projectDigest,
  });
  database.readVerifiedArtifact({
    scopeKind: "collaboration_server",
    scopeId: collaborationServerId,
    artifactRef: {
      protectedHandleId: parseA1CanonicalId(
        "protectedHandle",
        reservation.registrationIntent.metadataRef,
      ),
      kind: "artifact",
    },
    artifactSchemaId: NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
    expectedArtifactDigest: evidence.metadataDigest,
  });
  const runtime = readCurrentRuntime(database, payload.runtime.runtimeId);
  if (
    runtime === null ||
    runtime.runtime.wardenLaunchNonce !== payload.runtime.wardenLaunchNonce ||
    runtime.runtime.initialStartIdentitySchemaId !== payload.runtime.startIdentitySchemaId ||
    runtime.runtime.initialStartIdentityRef !== payload.runtime.startIdentityRef ||
    runtime.runtime.initialStartIdentityDigest !== payload.runtime.startIdentityDigest ||
    runtime.runtime.currentNativeIncarnation !== payload.runtime.nativeIncarnation ||
    !sameDescriptor(runtime.runtime.descriptor, payload.descriptor) ||
    runtime.incarnation.nativeIncarnation !== payload.runtime.nativeIncarnation ||
    runtime.incarnation.startIdentitySchemaId !== payload.runtime.startIdentitySchemaId ||
    runtime.incarnation.startIdentityRef !== payload.runtime.startIdentityRef ||
    runtime.incarnation.startIdentityDigest !== payload.runtime.startIdentityDigest ||
    !sameDescriptor(runtime.incarnation.descriptor, payload.descriptor) ||
    (runtime.assignment.runtimeOwnerAssignmentId !== payload.runtime.runtimeOwnerAssignmentId &&
      runtime.assignment.runtimeOwnerAssignmentId !==
        payload.runtime.expectedRuntimeOwnerAssignmentId) ||
    runtime.identityKey.signingKeyRef?.protectedHandleId !== payload.runtime.signingKeyRef ||
    runtime.identityKey.localTrustEvidenceRef !== payload.runtime.localTrustEvidenceRef ||
    runtime.identityKey.localTrustEvidenceDigest !== payload.runtime.localTrustEvidenceDigest
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  if (
    runtime.journalEntry.entryKind !== "runtime_registered" ||
    runtime.journalEntry.subjectKind !== "native_runtime" ||
    runtime.journalEntry.subjectId !== payload.runtime.runtimeId
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  const createdByThisOpen =
    runtime.journalEntry.operationId === evidence.runtimeCreateOperation.operationId;
  if (
    createdByThisOpen &&
    (runtime.journalEntry.operationSchemaId !== evidence.runtimeCreateOperation.operationSchemaId ||
      runtime.journalEntry.operationDigest !== evidence.runtimeCreateOperation.operationDigest)
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  }
  const assignmentIsSuccessor =
    runtime.assignment.runtimeOwnerAssignmentId === payload.runtime.runtimeOwnerAssignmentId;
  if (payload.runtime.expectedRuntimeOwnerAssignmentId === null) {
    assertRuntimeOperationMarker(database, evidence.runtimeReassignOperation, false);
    if (
      !assignmentIsSuccessor ||
      (createdByThisOpen &&
        (runtime.assignment.supersedesRuntimeOwnerAssignmentId !== null ||
          runtime.assignment.assignmentEvidenceSchemaId !== payload.runtime.startIdentitySchemaId ||
          runtime.assignment.assignmentEvidenceRef !== payload.runtime.startIdentityRef ||
          runtime.assignment.assignmentEvidenceDigest !== payload.runtime.startIdentityDigest))
    ) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
  } else if (assignmentIsSuccessor) {
    assertRuntimeOperationMarker(database, evidence.runtimeReassignOperation, true);
    if (
      runtime.assignment.supersedesRuntimeOwnerAssignmentId !==
        payload.runtime.expectedRuntimeOwnerAssignmentId ||
      runtime.assignment.assignmentEvidenceSchemaId !==
        payload.runtime.reattachmentEvidenceSchemaId ||
      runtime.assignment.assignmentEvidenceRef !== payload.runtime.reattachmentEvidenceRef ||
      runtime.assignment.assignmentEvidenceDigest !== payload.runtime.reattachmentEvidenceDigest
    ) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
  } else if (
    runtime.assignment.runtimeOwnerAssignmentId !== payload.runtime.expectedRuntimeOwnerAssignmentId
  ) {
    throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
  } else {
    assertRuntimeOperationMarker(database, evidence.runtimeReassignOperation, false);
  }
  return Object.freeze({
    nativeBindingId: reservation.binding.nativeBindingId,
    logicalChatId: reservation.chat.logicalChatId,
    projectId: reservation.project.projectId,
  });
}

async function prepareOpenFoundation(
  database: NativeRegistrationDatabaseAccess,
  coordinatorFence: CoordinatorLeaseFence,
  fence: RuntimeOwnerServiceFence,
  context: RuntimeOwnerOperationContext,
  payload: ParsedOpenPayload,
): Promise<OpenFoundation> {
  const descriptorEvidence = createNativeEngineDescriptorEvidence(payload.descriptor);
  const metadataEvidence = createNativeRegistrationMetadataEvidence({
    metadataSchemaId: payload.metadataSchemaId,
    metadataBytes: payload.metadataBytes,
  });
  const terminalTarget =
    payload.selection.kind === "first_bootstrap"
      ? ({
          kind: "terminal_native",
          descriptor: payload.descriptor,
          terminalProjectRef: payload.selection.terminalProjectRef,
          nativeWorkspaceBindingId: null,
        } as const)
      : null;
  const targetDigest =
    payload.selection.kind === "existing_mapping"
      ? payload.selection.targetDigest
      : await projectTargetDigest(
          terminalTarget as Extract<ProjectTarget, { readonly kind: "terminal_native" }>,
        );
  const projectEvidence = createDurableProjectSelectionEvidence(
    payload.selection.kind === "first_bootstrap"
      ? {
          kind: "first_bootstrap",
          collaborationServerId: coordinatorFence.collaborationServerId,
          workspaceSelectorId: payload.selection.workspaceSelectorId,
          terminalDescriptor: payload.descriptor,
          targetDigest,
        }
      : {
          kind: "existing_mapping",
          collaborationServerId: coordinatorFence.collaborationServerId,
          projectId: payload.selection.projectId,
          workspaceSelectorId: payload.selection.workspaceSelectorId,
          projectTargetSelectorMappingId: payload.selection.projectTargetSelectorMappingId,
          mappingGeneration: payload.selection.mappingGeneration,
          targetDigest,
        },
  );
  const runtimeCreateOperation = internalOperation(
    payload.operationId,
    "runtime-create",
    foundingRuntimePayload(payload),
  );
  const runtimeReassignOperation = internalOperation(
    payload.operationId,
    "runtime-reassign",
    runtimeReassignmentPayload(payload),
  );
  const retainedEvidence = Object.freeze({
    descriptorDigest: descriptorEvidence.canonicalDigest,
    projectDigest: projectEvidence.canonicalDigest,
    metadataDigest: metadataEvidence.canonicalDigest,
    targetDigest,
    runtimeCreateOperation,
    runtimeReassignOperation,
  });
  database.use((current) =>
    existingFoundation(current, payload, coordinatorFence.collaborationServerId, retainedEvidence),
  );
  const existing = database.use((current) =>
    readCurrentRuntime(current, payload.runtime.runtimeId),
  );
  let initialRequest: RegisterInitialRuntimeRequest | null = null;
  let reassignRequest: ReassignRuntimeOwnerRequest | null = null;
  if (existing === null) {
    if (
      payload.runtime.nativeIncarnation !== 1 ||
      payload.runtime.expectedRuntimeOwnerAssignmentId !== null
    ) {
      invalidRequest();
    }
    const wrapped = context.custodySigner.generateIdentityKey(payload.runtime.runtimeId, 1);
    initialRequest = Object.freeze({
      fence,
      operation: runtimeCreateOperation,
      runtimeId: payload.runtime.runtimeId,
      descriptor: payload.descriptor,
      wardenLaunchNonce: payload.runtime.wardenLaunchNonce,
      startIdentitySchemaId: payload.runtime.startIdentitySchemaId,
      startIdentityRef: payload.runtime.startIdentityRef,
      startIdentityDigest: payload.runtime.startIdentityDigest,
      runtimeOwnerAssignmentId: payload.runtime.runtimeOwnerAssignmentId,
      key: Object.freeze({
        runtimeOwnerIdentityKeyId: wrapped.binding.runtimeOwnerIdentityKeyId,
        publicKey: parseEd25519PublicKey(wrapped.binding.publicKey),
        signingKeyRef: Object.freeze({
          protectedHandleId: payload.runtime.signingKeyRef,
          kind: "signing_key",
        }),
        localTrustEvidenceRef: payload.runtime.localTrustEvidenceRef,
        localTrustEvidenceDigest: payload.runtime.localTrustEvidenceDigest,
        wrapNonce: wrapped.wrapNonce,
        wrappedPkcs8: wrapped.wrappedPkcs8,
        authTag: wrapped.authTag,
        pkcs8Digest: wrapped.pkcs8Digest,
      }),
    });
  } else {
    if (
      existing.runtime.state !== "current" ||
      existing.runtime.wardenLaunchNonce !== payload.runtime.wardenLaunchNonce ||
      existing.runtime.initialStartIdentitySchemaId !== payload.runtime.startIdentitySchemaId ||
      existing.runtime.initialStartIdentityRef !== payload.runtime.startIdentityRef ||
      existing.runtime.initialStartIdentityDigest !== payload.runtime.startIdentityDigest ||
      existing.runtime.currentNativeIncarnation !== payload.runtime.nativeIncarnation ||
      !sameDescriptor(existing.runtime.descriptor, payload.descriptor) ||
      existing.incarnation.startIdentitySchemaId !== payload.runtime.startIdentitySchemaId ||
      existing.incarnation.startIdentityRef !== payload.runtime.startIdentityRef ||
      existing.incarnation.startIdentityDigest !== payload.runtime.startIdentityDigest ||
      !sameDescriptor(existing.incarnation.descriptor, payload.descriptor) ||
      existing.identityKey.signingKeyRef?.protectedHandleId !== payload.runtime.signingKeyRef ||
      existing.identityKey.localTrustEvidenceRef !== payload.runtime.localTrustEvidenceRef ||
      existing.identityKey.localTrustEvidenceDigest !== payload.runtime.localTrustEvidenceDigest
    ) {
      throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
    }
    const owned =
      existing.assignment.runtimeOwnerServiceLeaseId === fence.runtimeOwnerServiceLeaseId &&
      existing.assignment.runtimeOwnerServiceEpoch === fence.runtimeOwnerServiceEpoch;
    if (owned) {
      database.use((current) =>
        assertRuntimeOperationMarker(
          current,
          runtimeReassignOperation,
          payload.runtime.expectedRuntimeOwnerAssignmentId !== null,
        ),
      );
      if (
        payload.runtime.runtimeOwnerAssignmentId !== existing.assignment.runtimeOwnerAssignmentId
      ) {
        invalidRequest();
      }
      if (
        payload.runtime.expectedRuntimeOwnerAssignmentId !== null &&
        (existing.assignment.supersedesRuntimeOwnerAssignmentId !==
          payload.runtime.expectedRuntimeOwnerAssignmentId ||
          existing.assignment.assignmentEvidenceSchemaId !==
            payload.runtime.reattachmentEvidenceSchemaId ||
          existing.assignment.assignmentEvidenceRef !== payload.runtime.reattachmentEvidenceRef ||
          existing.assignment.assignmentEvidenceDigest !==
            payload.runtime.reattachmentEvidenceDigest)
      ) {
        throw new NativeRegistrationOrchestrationError("RESULT_MISMATCH");
      }
    } else {
      database.use((current) =>
        assertRuntimeOperationMarker(current, runtimeReassignOperation, false),
      );
      if (
        payload.runtime.expectedRuntimeOwnerAssignmentId !==
          existing.assignment.runtimeOwnerAssignmentId ||
        payload.runtime.reattachmentEvidenceSchemaId === null ||
        payload.runtime.reattachmentEvidenceRef === null ||
        payload.runtime.reattachmentEvidenceDigest === null
      ) {
        invalidRequest();
      }
      reassignRequest = Object.freeze({
        fence,
        operation: runtimeReassignOperation,
        runtimeId: payload.runtime.runtimeId,
        nativeIncarnation: payload.runtime.nativeIncarnation,
        expectedRuntimeOwnerAssignmentId: existing.assignment.runtimeOwnerAssignmentId,
        runtimeOwnerAssignmentId: payload.runtime.runtimeOwnerAssignmentId,
        reattachmentEvidenceSchemaId: payload.runtime.reattachmentEvidenceSchemaId,
        reattachmentEvidenceRef: payload.runtime.reattachmentEvidenceRef,
        reattachmentEvidenceDigest: payload.runtime.reattachmentEvidenceDigest,
      });
    }
  }

  const mutate = (): OpenFoundation =>
    database.use((current) =>
      current.transaction((transaction) => {
        let reservation = transaction.records.readTerminalReservation(
          coordinatorFence.collaborationServerId,
          payload.registrationAttemptId,
        );
        if (reservation === null) {
          const descriptorArtifact = transaction.putArtifact({
            scopeKind: "collaboration_server",
            scopeId: coordinatorFence.collaborationServerId,
            artifactSchemaId: NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
            artifactDigest: descriptorEvidence.canonicalDigest,
            artifactBytes: descriptorEvidence.canonicalBytes,
          });
          const projectArtifact = transaction.putArtifact({
            scopeKind: "collaboration_server",
            scopeId: coordinatorFence.collaborationServerId,
            artifactSchemaId: DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
            artifactDigest: projectEvidence.canonicalDigest,
            artifactBytes: projectEvidence.canonicalBytes,
          });
          const metadataArtifact = transaction.putArtifact({
            scopeKind: "collaboration_server",
            scopeId: coordinatorFence.collaborationServerId,
            artifactSchemaId: NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
            artifactDigest: metadataEvidence.canonicalDigest,
            artifactBytes: metadataEvidence.canonicalBytes,
          });
          const registration = Object.freeze({
            registrationAttemptId: payload.registrationAttemptId,
            descriptor: payload.descriptor,
            descriptorRef: descriptorArtifact.artifactRef.protectedHandleId,
            descriptorDigest: descriptorArtifact.artifactDigest,
            projectRef: projectArtifact.artifactRef.protectedHandleId,
            projectDigest: projectArtifact.artifactDigest,
            expectedNativeRefDigest: payload.expectedNativeRefDigest,
            initialPhase: payload.initialPhase,
            metadataSchemaId: payload.metadataSchemaId,
            metadataRef: metadataArtifact.artifactRef.protectedHandleId,
            metadataDigest: metadataArtifact.artifactDigest,
            capabilitiesRef: null,
            capabilitiesDigest: null,
          });
          reservation =
            payload.selection.kind === "first_bootstrap"
              ? transaction.records.reserveFirstTerminalChat({
                  fence: coordinatorFence,
                  workspaceSelectorId: payload.selection.workspaceSelectorId,
                  terminalTarget: terminalTarget as Extract<
                    ProjectTarget,
                    { readonly kind: "terminal_native" }
                  >,
                  mappingEvidenceRef: payload.selection.mappingEvidenceRef,
                  registration,
                })
              : transaction.records.reserveAdditionalTerminalChat({
                  fence: coordinatorFence,
                  mappingFence: {
                    projectId: payload.selection.projectId,
                    workspaceSelectorId: payload.selection.workspaceSelectorId,
                    projectTargetSelectorMappingId:
                      payload.selection.projectTargetSelectorMappingId,
                    mappingGeneration: payload.selection.mappingGeneration,
                    targetDigest,
                  },
                  parentChatId: payload.selection.parentChatId,
                  registration,
                });
        }
        if (initialRequest !== null)
          transaction.runtimeOwner.registerInitialRuntime(initialRequest);
        else if (reassignRequest !== null)
          transaction.runtimeOwner.reassignRuntimeOwner(reassignRequest);
        return Object.freeze({
          nativeBindingId: reservation.binding.nativeBindingId,
          logicalChatId: reservation.chat.logicalChatId,
          projectId: reservation.project.projectId,
        });
      }),
    );
  try {
    return mutate();
  } catch (error) {
    return reconcileUnknownCommit(database, error, () =>
      database.use((current) =>
        existingFoundation(
          current,
          payload,
          coordinatorFence.collaborationServerId,
          retainedEvidence,
        ),
      ),
    );
  }
}

async function validateOpenMeasurement(
  operationId: A1SafeId,
  measured: ParsedNativeRegistrationOpenMeasurement,
): Promise<ParsedOpenPayload> {
  const synthetic = Object.freeze({
    operationId,
    registrationAttemptId: measured.registrationAttemptId,
    descriptor: measured.descriptor,
    initialPhase: measured.initialPhase,
    expectedNativeRef: measured.expectedNativeRef,
    selection: measured.selection,
    metadata: measured.metadata,
    runtime: measured.runtime,
    binding: measured.binding,
    nativeConversationLeaseId: measured.nativeConversationLeaseId,
  }) as RuntimeOwnerRpcJsonValue;
  const parsed = parseOpenPayload(synthetic);
  const expectedRuntimeId = await nativeRuntimeId({
    wardenLaunchNonce: parsed.runtime.wardenLaunchNonce,
    startIdentitySchemaId: parsed.runtime.startIdentitySchemaId,
    startIdentityDigest: parsed.runtime.startIdentityDigest,
  });
  if (expectedRuntimeId !== parsed.runtime.runtimeId) invalidRequest();
  if (
    parsed.expectedNativeRef !== null &&
    (!sameDescriptor(parsed.expectedNativeRef.descriptor, parsed.descriptor) ||
      parsed.expectedNativeRef.runtimeId !== parsed.runtime.runtimeId ||
      parsed.expectedNativeRef.incarnation !== parsed.runtime.nativeIncarnation)
  ) {
    invalidRequest();
  }
  return parsed;
}
