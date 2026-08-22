import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  canonicalByteLength,
  canonicalByteSnapshot,
  sha256,
} from "@remote-claw/clawsec";
import { MAX_PROTECTED_ARTIFACT_BYTES } from "./artifacts.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  HostStateContractError,
  type LogicalChatId,
  type NativeBindingCapabilitySnapshotId,
  type NativeBindingId,
  type NativeCapabilitySnapshotAttestationId,
  type NativeConversationLeaseId,
  type NativeListenerRegistrationAttestationId,
  type NativeRuntimeId,
  type NativeRuntimeIsolationAttestationId,
  type NativeWorkspaceBindingId,
  type ProjectId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "./ids.js";
import {
  nativeBindingCapabilitySnapshotId,
  nativeCapabilitySnapshotAttestationId,
  nativeListenerRegistrationAttestationId,
  nativeRuntimeIsolationAttestationId,
} from "./native-binding-authority.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseNonEmptyString,
  parseNullable,
  parsePositiveSafeInteger,
  snapshotExactArray,
} from "./validation.js";

export const NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID =
  "remote-claw/native-workspace-binding-input/v1" as const;
export const NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID =
  "remote-claw/native-listener-evidence-input-vector/v1" as const;
export const NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID =
  "remote-claw/native-isolation-evidence-input-vector/v1" as const;
export const NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID =
  "remote-claw/native-binding-capability-input-vector/v1" as const;

export const NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID =
  "remote-claw/posix-absolute-directory-normalization/v1" as const;
export const NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID =
  "remote-claw/linux-no-follow-filesystem-identity/v1" as const;
export const NATIVE_LISTENER_ROUTE_RESOLUTION_SCHEMA_ID =
  "remote-claw/native-listener-route-resolution/v1" as const;
export const NATIVE_EXACT_PROCESS_SOCKET_POLICY_SCHEMA_ID =
  "remote-claw/exact-process-socket-policy/v1" as const;
export const OPENCODE_SLASH_COMMAND_NORMALIZATION_SCHEMA_ID =
  "remote-claw/opencode-slash-command-normalization/v1" as const;

export const MAX_NATIVE_EVIDENCE_PARENT_BYTES = 65_536;

type NativeEvidenceArtifactSpec = Readonly<{
  artifactSchemaId: string;
  maxByteLength: number;
  scopeKind: "runtime" | "native_binding";
}>;

function spec<
  const SchemaId extends string,
  const ScopeKind extends NativeEvidenceArtifactSpec["scopeKind"],
  const MaxByteLength extends number = 16_777_216,
>(
  artifactSchemaId: SchemaId,
  scopeKind: ScopeKind,
  maxByteLength: MaxByteLength = MAX_PROTECTED_ARTIFACT_BYTES as MaxByteLength,
): Readonly<{
  artifactSchemaId: SchemaId;
  maxByteLength: MaxByteLength;
  scopeKind: ScopeKind;
}> {
  return Object.freeze({ artifactSchemaId, maxByteLength, scopeKind });
}

/**
 * Closed E1a vocabulary. The schema IDs reserve canonical child roles; their
 * collector-backed bytes do not become authority until the later E1b gate.
 */
export const NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS = Object.freeze({
  "parent.workspace_input": spec(
    NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
    "runtime",
    MAX_NATIVE_EVIDENCE_PARENT_BYTES,
  ),
  "parent.listener_input": spec(
    NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
    "runtime",
    MAX_NATIVE_EVIDENCE_PARENT_BYTES,
  ),
  "parent.isolation_input": spec(
    NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
    "runtime",
    MAX_NATIVE_EVIDENCE_PARENT_BYTES,
  ),
  "parent.capability_input": spec(
    NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID,
    "native_binding",
    MAX_NATIVE_EVIDENCE_PARENT_BYTES,
  ),
  "workspace.canonical_directory": spec(
    "remote-claw/posix-canonical-directory-evidence/v1",
    "runtime",
    16_384,
  ),
  "workspace.filesystem_identity": spec(
    "remote-claw/linux-no-follow-filesystem-identity/v1",
    "runtime",
    65_536,
  ),
  "workspace.allowed_root": spec(
    "remote-claw/linux-allowed-root-ancestry/v1",
    "runtime",
    1_048_576,
  ),
  "workspace.mount_namespace": spec(
    "remote-claw/linux-mount-namespace-identity/v1",
    "runtime",
    65_536,
  ),
  "listener.native_executable": spec(
    "remote-claw/native-executable-chunk-manifest/v1",
    "runtime",
    MAX_NATIVE_EVIDENCE_PARENT_BYTES,
  ),
  "listener.front_door_executable": spec(
    "remote-claw/front-door-executable-chunk-manifest/v1",
    "runtime",
    MAX_NATIVE_EVIDENCE_PARENT_BYTES,
  ),
  "listener.front_door_build_manifest": spec(
    "remote-claw/front-door-build-closure-manifest/v1",
    "runtime",
  ),
  "listener.generated_surface": spec("remote-claw/native-generated-openapi-surface/v1", "runtime"),
  "listener.build_route_registry": spec(
    "remote-claw/native-listener-build-route-registry/v1",
    "runtime",
  ),
  "listener.measured_dispatch_table": spec(
    "remote-claw/native-listener-measured-dispatch-table/v1",
    "runtime",
  ),
  "isolation.raw_listener_socket": spec(
    "remote-claw/linux-raw-listener-socket-identity/v1",
    "runtime",
    65_536,
  ),
  "isolation.raw_listener_peer_vector": spec(
    "remote-claw/native-runtime-isolation-peer-vector/v1",
    "runtime",
  ),
  "isolation.exact_process_socket_policy": spec(
    "remote-claw/linux-exact-process-socket-policy-evidence/v1",
    "runtime",
  ),
  "isolation.tool_namespace_policy": spec(
    "remote-claw/linux-tool-namespace-policy-evidence/v1",
    "runtime",
  ),
  "isolation.provider_facade_allowed_process": spec(
    "remote-claw/native-runtime-isolation-provider-peer/v1",
    "runtime",
    1_048_576,
  ),
  "isolation.provider_facade_policy": spec(
    "remote-claw/linux-provider-facade-policy-evidence/v1",
    "runtime",
  ),
  "isolation.network_namespace": spec(
    "remote-claw/linux-network-namespace-identity/v1",
    "runtime",
    65_536,
  ),
  "isolation.mount_namespace": spec(
    "remote-claw/linux-mount-namespace-identity/v1",
    "runtime",
    65_536,
  ),
  "capability.native_surface": spec(
    "remote-claw/native-surface-schema-artifact/v1",
    "native_binding",
  ),
  "capability.listener_route_manifest": spec(
    "remote-claw/native-listener-route-manifest-artifact/v1",
    "native_binding",
  ),
  "capability.operation_classification_vector": spec(
    "remote-claw/native-operation-classification-vector/v1",
    "native_binding",
  ),
  "capability.family_capability_vector": spec(
    "remote-claw/native-mutation-family-vector/v1",
    "native_binding",
    1_048_576,
  ),
  "capability.slash_normalizer_implementation": spec(
    "remote-claw/opencode-slash-normalizer-implementation/v1",
    "native_binding",
  ),
  "capability.slash_command_table": spec(
    "remote-claw/opencode-slash-command-table/v1",
    "native_binding",
    65_536,
  ),
  "capability.request_translator_implementation": spec(
    "remote-claw/native-request-translator-implementation/v1",
    "native_binding",
  ),
  "capability.request_translator_build_manifest": spec(
    "remote-claw/native-request-translator-build-manifest/v1",
    "native_binding",
  ),
  "capability.translation_injectivity_proof": spec(
    "remote-claw/native-request-translation-injectivity-proof/v1",
    "native_binding",
  ),
  "capability.user_text_family_evidence": spec(
    "remote-claw/native-user-text-family-evidence/v1",
    "native_binding",
  ),
} as const satisfies Readonly<Record<string, NativeEvidenceArtifactSpec>>);

export type NativeBindingAuthorityArtifactRole =
  keyof typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS;
export type NativeBindingAuthorityArtifactSchemaId =
  (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)[NativeBindingAuthorityArtifactRole]["artifactSchemaId"];

type NativeEvidenceArtifactCommitmentForRole<Role extends NativeBindingAuthorityArtifactRole> =
  Readonly<{
    readonly role: Role;
    readonly artifactSchemaId: (typeof NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)[Role]["artifactSchemaId"];
    readonly artifactDigest: A1Digest;
    readonly byteLength: number;
  }>;

export type NativeEvidenceArtifactCommitmentV1<
  Role extends NativeBindingAuthorityArtifactRole = NativeBindingAuthorityArtifactRole,
> = Role extends NativeBindingAuthorityArtifactRole
  ? NativeEvidenceArtifactCommitmentForRole<Role>
  : never;

const WORKSPACE_ARTIFACT_ROLES = Object.freeze([
  "workspace.canonical_directory",
  "workspace.filesystem_identity",
  "workspace.allowed_root",
  "workspace.mount_namespace",
] as const satisfies readonly NativeBindingAuthorityArtifactRole[]);

const LISTENER_ARTIFACT_ROLES = Object.freeze([
  "listener.native_executable",
  "listener.front_door_executable",
  "listener.front_door_build_manifest",
  "listener.generated_surface",
  "listener.build_route_registry",
  "listener.measured_dispatch_table",
] as const satisfies readonly NativeBindingAuthorityArtifactRole[]);

const ISOLATION_ARTIFACT_ROLES = Object.freeze([
  "isolation.raw_listener_socket",
  "isolation.raw_listener_peer_vector",
  "isolation.exact_process_socket_policy",
  "isolation.tool_namespace_policy",
  "isolation.provider_facade_allowed_process",
  "isolation.provider_facade_policy",
  "isolation.network_namespace",
  "isolation.mount_namespace",
] as const satisfies readonly NativeBindingAuthorityArtifactRole[]);

const CAPABILITY_ARTIFACT_ROLES = Object.freeze([
  "capability.native_surface",
  "capability.listener_route_manifest",
  "capability.operation_classification_vector",
  "capability.family_capability_vector",
  "capability.slash_normalizer_implementation",
  "capability.slash_command_table",
  "capability.request_translator_implementation",
  "capability.request_translator_build_manifest",
  "capability.translation_injectivity_proof",
  "capability.user_text_family_evidence",
] as const satisfies readonly NativeBindingAuthorityArtifactRole[]);

type FixedCommitments<R extends readonly NativeBindingAuthorityArtifactRole[]> = Readonly<{
  [K in keyof R]: R[K] extends NativeBindingAuthorityArtifactRole
    ? NativeEvidenceArtifactCommitmentV1<R[K]>
    : never;
}>;

export interface NativeWorkspaceBindingInputV1 {
  readonly schemaVersion: 1;
  readonly schemaId: typeof NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID;
  readonly nativeWorkspaceBindingId: NativeWorkspaceBindingId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly projectId: ProjectId;
  readonly nativeWorkspaceId: A1SafeId | null;
  readonly directoryNormalizationSchemaId: typeof NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID;
  readonly filesystemIdentitySchemaId: typeof NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID;
  readonly workspaceGeneration: number;
  readonly artifacts: FixedCommitments<typeof WORKSPACE_ARTIFACT_ROLES>;
}

export interface NativeListenerEvidenceInputVectorV1 {
  readonly schemaVersion: 1;
  readonly schemaId: typeof NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID;
  readonly nativeListenerRegistrationAttestationId: NativeListenerRegistrationAttestationId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly descriptor: Readonly<{ product: "opencode"; access: "server" }>;
  readonly engineVersion: string;
  readonly surfaceSchemaKind: "openapi";
  readonly routeResolutionSchemaId: typeof NATIVE_LISTENER_ROUTE_RESOLUTION_SCHEMA_ID;
  readonly artifacts: FixedCommitments<typeof LISTENER_ARTIFACT_ROLES>;
}

export interface NativeIsolationEvidenceInputVectorV1 {
  readonly schemaVersion: 1;
  readonly schemaId: typeof NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID;
  readonly runtimeIsolationAttestationId: NativeRuntimeIsolationAttestationId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly descriptor: Readonly<{ product: "opencode"; access: "server" }>;
  readonly nativeListenerRegistrationAttestationId: NativeListenerRegistrationAttestationId;
  readonly listenerSignedRecordDigest: A1Digest;
  readonly processIdentityPolicySchemaId: typeof NATIVE_EXACT_PROCESS_SOCKET_POLICY_SCHEMA_ID;
  readonly artifacts: FixedCommitments<typeof ISOLATION_ARTIFACT_ROLES>;
}

export interface NativeBindingCapabilityInputVectorV1 {
  readonly schemaVersion: 1;
  readonly schemaId: typeof NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID;
  readonly capabilitySnapshotId: NativeBindingCapabilitySnapshotId;
  readonly capabilitySnapshotAttestationId: NativeCapabilitySnapshotAttestationId;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly nativeBindingId: NativeBindingId;
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly nativeRegistrationPublicationId: A1SafeId;
  readonly nativeConversationId: A1SafeId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly projectId: ProjectId;
  readonly attachmentId: A1SafeId;
  readonly attachmentLeaseId: A1SafeId;
  readonly nativeWorkspaceBindingId: NativeWorkspaceBindingId;
  readonly canonicalDirectoryPathDigest: A1Digest;
  readonly nativeWorkspaceBindingDigest: A1Digest;
  readonly capabilityGeneration: number;
  readonly descriptor: Readonly<{ product: "opencode"; access: "server" }>;
  readonly engineVersion: string;
  readonly nativeSurfaceSchemaId: string;
  readonly nativeListenerRegistrationAttestationId: NativeListenerRegistrationAttestationId;
  readonly listenerSignedRecordDigest: A1Digest;
  readonly runtimeIsolationAttestationId: NativeRuntimeIsolationAttestationId;
  readonly isolationSignedRecordDigest: A1Digest;
  readonly slashCommandNormalizationSchemaId: typeof OPENCODE_SLASH_COMMAND_NORMALIZATION_SCHEMA_ID;
  readonly verifiedAtMs: number;
  readonly artifacts: FixedCommitments<typeof CAPABILITY_ARTIFACT_ROLES>;
}

function reject(field: string, requirement: string): never {
  throw new HostStateContractError(`${field} ${requirement}`);
}

function parseBoundedString(value: unknown, field: string, maxUtf8Bytes: number): string {
  const parsed = parseNonEmptyString(value, field);
  if (new TextEncoder().encode(parsed).byteLength > maxUtf8Bytes) {
    reject(field, `must be at most ${maxUtf8Bytes} UTF-8 bytes`);
  }
  return parsed;
}

export function parseNativeEvidenceArtifactCommitment<
  const ExpectedRole extends NativeBindingAuthorityArtifactRole,
>(
  value: unknown,
  expectedRole: ExpectedRole,
  field?: string,
): NativeEvidenceArtifactCommitmentV1<ExpectedRole>;
export function parseNativeEvidenceArtifactCommitment(
  value: unknown,
  expectedRole?: undefined,
  field?: string,
): NativeEvidenceArtifactCommitmentV1;
export function parseNativeEvidenceArtifactCommitment(
  value: unknown,
  expectedRole?: NativeBindingAuthorityArtifactRole,
  field = "nativeEvidenceArtifactCommitment",
): NativeEvidenceArtifactCommitmentV1 {
  const row = parseExactRecord(
    value,
    ["role", "artifactSchemaId", "artifactDigest", "byteLength"],
    field,
  );
  const role = parseEnum(
    row.role,
    Object.keys(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS) as NativeBindingAuthorityArtifactRole[],
    `${field}.role`,
  );
  if (expectedRole !== undefined && role !== expectedRole) {
    reject(`${field}.role`, `must equal ${expectedRole}`);
  }
  const selected = NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS[role];
  if (row.artifactSchemaId !== selected.artifactSchemaId) {
    reject(`${field}.artifactSchemaId`, `must equal ${selected.artifactSchemaId}`);
  }
  const byteLength = parsePositiveSafeInteger(row.byteLength, `${field}.byteLength`);
  if (byteLength > selected.maxByteLength) {
    reject(`${field}.byteLength`, `must be at most ${selected.maxByteLength}`);
  }
  return frozen({
    role,
    artifactSchemaId: selected.artifactSchemaId,
    artifactDigest: parseA1Digest(row.artifactDigest, `${field}.artifactDigest`),
    byteLength,
  }) as NativeEvidenceArtifactCommitmentV1;
}

function parseFixedCommitments<R extends readonly NativeBindingAuthorityArtifactRole[]>(
  value: unknown,
  roles: R,
  field: string,
): FixedCommitments<R> {
  const commitments = snapshotExactArray(value, roles.length, field);
  return Object.freeze(
    roles.map((role, index) =>
      parseNativeEvidenceArtifactCommitment(commitments[index], role, `${field}[${index}]`),
    ),
  ) as FixedCommitments<R>;
}

function parseSelectedDescriptor(
  value: unknown,
  field: string,
): Readonly<{
  product: "opencode";
  access: "server";
}> {
  const row = parseExactRecord(value, ["product", "access"], field);
  if (row.product !== "opencode" || row.access !== "server") {
    reject(field, 'must equal {product:"opencode",access:"server"}');
  }
  return frozen({ product: "opencode", access: "server" });
}

export function parseNativeWorkspaceBindingInput(value: unknown): NativeWorkspaceBindingInputV1 {
  const row = parseExactRecord(
    value,
    [
      "schemaVersion",
      "schemaId",
      "nativeWorkspaceBindingId",
      "runtimeId",
      "nativeIncarnation",
      "projectId",
      "nativeWorkspaceId",
      "directoryNormalizationSchemaId",
      "filesystemIdentitySchemaId",
      "workspaceGeneration",
      "artifacts",
    ],
    "nativeWorkspaceBindingInput",
  );
  if (row.schemaVersion !== 1) reject("nativeWorkspaceBindingInput.schemaVersion", "must equal 1");
  if (row.schemaId !== NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID) {
    reject(
      "nativeWorkspaceBindingInput.schemaId",
      `must equal ${NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID}`,
    );
  }
  if (row.directoryNormalizationSchemaId !== NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID) {
    reject(
      "nativeWorkspaceBindingInput.directoryNormalizationSchemaId",
      `must equal ${NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID}`,
    );
  }
  if (row.filesystemIdentitySchemaId !== NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID) {
    reject(
      "nativeWorkspaceBindingInput.filesystemIdentitySchemaId",
      `must equal ${NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID}`,
    );
  }
  return frozen({
    schemaVersion: 1,
    schemaId: NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
    nativeWorkspaceBindingId: parseA1CanonicalId(
      "nativeWorkspaceBinding",
      row.nativeWorkspaceBindingId,
      "nativeWorkspaceBindingInput.nativeWorkspaceBindingId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeWorkspaceBindingInput.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "nativeWorkspaceBindingInput.nativeIncarnation",
    ),
    projectId: parseA1CanonicalId(
      "project",
      row.projectId,
      "nativeWorkspaceBindingInput.projectId",
    ),
    nativeWorkspaceId: parseNullable(
      row.nativeWorkspaceId,
      parseA1SafeId,
      "nativeWorkspaceBindingInput.nativeWorkspaceId",
    ),
    directoryNormalizationSchemaId: NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
    filesystemIdentitySchemaId: NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID,
    workspaceGeneration: parsePositiveSafeInteger(
      row.workspaceGeneration,
      "nativeWorkspaceBindingInput.workspaceGeneration",
    ),
    artifacts: parseFixedCommitments(
      row.artifacts,
      WORKSPACE_ARTIFACT_ROLES,
      "nativeWorkspaceBindingInput.artifacts",
    ),
  });
}

export async function parseNativeListenerEvidenceInputVector(
  value: unknown,
): Promise<NativeListenerEvidenceInputVectorV1> {
  const row = parseExactRecord(
    value,
    [
      "schemaVersion",
      "schemaId",
      "nativeListenerRegistrationAttestationId",
      "runtimeId",
      "nativeIncarnation",
      "runtimeOwnerIdentityKeyId",
      "runtimeOwnerKeyGeneration",
      "descriptor",
      "engineVersion",
      "surfaceSchemaKind",
      "routeResolutionSchemaId",
      "artifacts",
    ],
    "nativeListenerEvidenceInputVector",
  );
  if (row.schemaVersion !== 1) {
    reject("nativeListenerEvidenceInputVector.schemaVersion", "must equal 1");
  }
  if (row.schemaId !== NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID) {
    reject(
      "nativeListenerEvidenceInputVector.schemaId",
      `must equal ${NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID}`,
    );
  }
  if (row.surfaceSchemaKind !== "openapi") {
    reject("nativeListenerEvidenceInputVector.surfaceSchemaKind", "must equal openapi");
  }
  if (row.routeResolutionSchemaId !== NATIVE_LISTENER_ROUTE_RESOLUTION_SCHEMA_ID) {
    reject(
      "nativeListenerEvidenceInputVector.routeResolutionSchemaId",
      `must equal ${NATIVE_LISTENER_ROUTE_RESOLUTION_SCHEMA_ID}`,
    );
  }
  const runtimeId = parseA1CanonicalId(
    "nativeRuntime",
    row.runtimeId,
    "nativeListenerEvidenceInputVector.runtimeId",
  );
  const nativeIncarnation = parsePositiveSafeInteger(
    row.nativeIncarnation,
    "nativeListenerEvidenceInputVector.nativeIncarnation",
  );
  const runtimeOwnerKeyGeneration = parsePositiveSafeInteger(
    row.runtimeOwnerKeyGeneration,
    "nativeListenerEvidenceInputVector.runtimeOwnerKeyGeneration",
  );
  const runtimeOwnerIdentityKeyId = parseA1SafeId(
    row.runtimeOwnerIdentityKeyId,
    "nativeListenerEvidenceInputVector.runtimeOwnerIdentityKeyId",
  );
  const descriptor = parseSelectedDescriptor(
    row.descriptor,
    "nativeListenerEvidenceInputVector.descriptor",
  );
  const engineVersion = parseBoundedString(
    row.engineVersion,
    "nativeListenerEvidenceInputVector.engineVersion",
    256,
  );
  const artifacts = parseFixedCommitments(
    row.artifacts,
    LISTENER_ARTIFACT_ROLES,
    "nativeListenerEvidenceInputVector.artifacts",
  );
  const expectedId = await nativeListenerRegistrationAttestationId({
    runtimeId,
    nativeIncarnation,
    runtimeOwnerKeyGeneration,
  });
  const actualId = parseA1CanonicalId(
    "nativeListenerRegistrationAttestation",
    row.nativeListenerRegistrationAttestationId,
    "nativeListenerEvidenceInputVector.nativeListenerRegistrationAttestationId",
  );
  if (actualId !== expectedId) {
    reject(
      "nativeListenerEvidenceInputVector.nativeListenerRegistrationAttestationId",
      "must match its runtime/incarnation/key-generation derivation",
    );
  }
  return frozen({
    schemaVersion: 1,
    schemaId: NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
    nativeListenerRegistrationAttestationId: actualId,
    runtimeId,
    nativeIncarnation,
    runtimeOwnerIdentityKeyId,
    runtimeOwnerKeyGeneration,
    descriptor,
    engineVersion,
    surfaceSchemaKind: "openapi",
    routeResolutionSchemaId: NATIVE_LISTENER_ROUTE_RESOLUTION_SCHEMA_ID,
    artifacts,
  });
}

export async function parseNativeIsolationEvidenceInputVector(
  value: unknown,
): Promise<NativeIsolationEvidenceInputVectorV1> {
  const row = parseExactRecord(
    value,
    [
      "schemaVersion",
      "schemaId",
      "runtimeIsolationAttestationId",
      "runtimeId",
      "nativeIncarnation",
      "runtimeOwnerIdentityKeyId",
      "runtimeOwnerKeyGeneration",
      "descriptor",
      "nativeListenerRegistrationAttestationId",
      "listenerSignedRecordDigest",
      "processIdentityPolicySchemaId",
      "artifacts",
    ],
    "nativeIsolationEvidenceInputVector",
  );
  if (row.schemaVersion !== 1) {
    reject("nativeIsolationEvidenceInputVector.schemaVersion", "must equal 1");
  }
  if (row.schemaId !== NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID) {
    reject(
      "nativeIsolationEvidenceInputVector.schemaId",
      `must equal ${NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID}`,
    );
  }
  if (row.processIdentityPolicySchemaId !== NATIVE_EXACT_PROCESS_SOCKET_POLICY_SCHEMA_ID) {
    reject(
      "nativeIsolationEvidenceInputVector.processIdentityPolicySchemaId",
      `must equal ${NATIVE_EXACT_PROCESS_SOCKET_POLICY_SCHEMA_ID}`,
    );
  }
  const runtimeId = parseA1CanonicalId(
    "nativeRuntime",
    row.runtimeId,
    "nativeIsolationEvidenceInputVector.runtimeId",
  );
  const nativeIncarnation = parsePositiveSafeInteger(
    row.nativeIncarnation,
    "nativeIsolationEvidenceInputVector.nativeIncarnation",
  );
  const runtimeOwnerKeyGeneration = parsePositiveSafeInteger(
    row.runtimeOwnerKeyGeneration,
    "nativeIsolationEvidenceInputVector.runtimeOwnerKeyGeneration",
  );
  const runtimeOwnerIdentityKeyId = parseA1SafeId(
    row.runtimeOwnerIdentityKeyId,
    "nativeIsolationEvidenceInputVector.runtimeOwnerIdentityKeyId",
  );
  const descriptor = parseSelectedDescriptor(
    row.descriptor,
    "nativeIsolationEvidenceInputVector.descriptor",
  );
  const artifacts = parseFixedCommitments(
    row.artifacts,
    ISOLATION_ARTIFACT_ROLES,
    "nativeIsolationEvidenceInputVector.artifacts",
  );
  const expectedIsolationId = await nativeRuntimeIsolationAttestationId({
    runtimeId,
    nativeIncarnation,
    runtimeOwnerKeyGeneration,
  });
  const isolationId = parseA1CanonicalId(
    "nativeRuntimeIsolationAttestation",
    row.runtimeIsolationAttestationId,
    "nativeIsolationEvidenceInputVector.runtimeIsolationAttestationId",
  );
  if (isolationId !== expectedIsolationId) {
    reject(
      "nativeIsolationEvidenceInputVector.runtimeIsolationAttestationId",
      "must match its runtime/incarnation/key-generation derivation",
    );
  }
  const expectedListenerId = await nativeListenerRegistrationAttestationId({
    runtimeId,
    nativeIncarnation,
    runtimeOwnerKeyGeneration,
  });
  const listenerId = parseA1CanonicalId(
    "nativeListenerRegistrationAttestation",
    row.nativeListenerRegistrationAttestationId,
    "nativeIsolationEvidenceInputVector.nativeListenerRegistrationAttestationId",
  );
  if (listenerId !== expectedListenerId) {
    reject(
      "nativeIsolationEvidenceInputVector.nativeListenerRegistrationAttestationId",
      "must match the same runtime/incarnation/key-generation derivation",
    );
  }
  return frozen({
    schemaVersion: 1,
    schemaId: NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
    runtimeIsolationAttestationId: isolationId,
    runtimeId,
    nativeIncarnation,
    runtimeOwnerIdentityKeyId,
    runtimeOwnerKeyGeneration,
    descriptor,
    nativeListenerRegistrationAttestationId: listenerId,
    listenerSignedRecordDigest: parseA1Digest(
      row.listenerSignedRecordDigest,
      "nativeIsolationEvidenceInputVector.listenerSignedRecordDigest",
    ),
    processIdentityPolicySchemaId: NATIVE_EXACT_PROCESS_SOCKET_POLICY_SCHEMA_ID,
    artifacts,
  });
}

export async function parseNativeBindingCapabilityInputVector(
  value: unknown,
): Promise<NativeBindingCapabilityInputVectorV1> {
  const row = parseExactRecord(
    value,
    [
      "schemaVersion",
      "schemaId",
      "capabilitySnapshotId",
      "capabilitySnapshotAttestationId",
      "collaborationServerId",
      "logicalChatId",
      "nativeBindingId",
      "nativeBindingIncarnationId",
      "nativeConversationLeaseId",
      "nativeRegistrationPublicationId",
      "nativeConversationId",
      "runtimeId",
      "nativeIncarnation",
      "runtimeOwnerIdentityKeyId",
      "runtimeOwnerKeyGeneration",
      "projectId",
      "attachmentId",
      "attachmentLeaseId",
      "nativeWorkspaceBindingId",
      "canonicalDirectoryPathDigest",
      "nativeWorkspaceBindingDigest",
      "capabilityGeneration",
      "descriptor",
      "engineVersion",
      "nativeSurfaceSchemaId",
      "nativeListenerRegistrationAttestationId",
      "listenerSignedRecordDigest",
      "runtimeIsolationAttestationId",
      "isolationSignedRecordDigest",
      "slashCommandNormalizationSchemaId",
      "verifiedAtMs",
      "artifacts",
    ],
    "nativeBindingCapabilityInputVector",
  );
  if (row.schemaVersion !== 1) {
    reject("nativeBindingCapabilityInputVector.schemaVersion", "must equal 1");
  }
  if (row.schemaId !== NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID) {
    reject(
      "nativeBindingCapabilityInputVector.schemaId",
      `must equal ${NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID}`,
    );
  }
  if (row.slashCommandNormalizationSchemaId !== OPENCODE_SLASH_COMMAND_NORMALIZATION_SCHEMA_ID) {
    reject(
      "nativeBindingCapabilityInputVector.slashCommandNormalizationSchemaId",
      `must equal ${OPENCODE_SLASH_COMMAND_NORMALIZATION_SCHEMA_ID}`,
    );
  }
  const runtimeId = parseA1CanonicalId(
    "nativeRuntime",
    row.runtimeId,
    "nativeBindingCapabilityInputVector.runtimeId",
  );
  const nativeIncarnation = parsePositiveSafeInteger(
    row.nativeIncarnation,
    "nativeBindingCapabilityInputVector.nativeIncarnation",
  );
  const runtimeOwnerKeyGeneration = parsePositiveSafeInteger(
    row.runtimeOwnerKeyGeneration,
    "nativeBindingCapabilityInputVector.runtimeOwnerKeyGeneration",
  );
  const capabilityGeneration = parsePositiveSafeInteger(
    row.capabilityGeneration,
    "nativeBindingCapabilityInputVector.capabilityGeneration",
  );
  const attachmentLeaseId = parseA1SafeId(
    row.attachmentLeaseId,
    "nativeBindingCapabilityInputVector.attachmentLeaseId",
  );
  const descriptor = parseSelectedDescriptor(
    row.descriptor,
    "nativeBindingCapabilityInputVector.descriptor",
  );
  const artifacts = parseFixedCommitments(
    row.artifacts,
    CAPABILITY_ARTIFACT_ROLES,
    "nativeBindingCapabilityInputVector.artifacts",
  );
  const expectedSnapshotId = await nativeBindingCapabilitySnapshotId({
    attachmentLeaseId,
    capabilityGeneration,
  });
  const snapshotId = parseA1CanonicalId(
    "nativeBindingCapabilitySnapshot",
    row.capabilitySnapshotId,
    "nativeBindingCapabilityInputVector.capabilitySnapshotId",
  );
  if (snapshotId !== expectedSnapshotId) {
    reject(
      "nativeBindingCapabilityInputVector.capabilitySnapshotId",
      "must match its attachment-lease/capability-generation derivation",
    );
  }
  const expectedSnapshotAttestationId = await nativeCapabilitySnapshotAttestationId({
    capabilitySnapshotId: snapshotId,
  });
  const snapshotAttestationId = parseA1CanonicalId(
    "nativeCapabilitySnapshotAttestation",
    row.capabilitySnapshotAttestationId,
    "nativeBindingCapabilityInputVector.capabilitySnapshotAttestationId",
  );
  if (snapshotAttestationId !== expectedSnapshotAttestationId) {
    reject(
      "nativeBindingCapabilityInputVector.capabilitySnapshotAttestationId",
      "must match its capability-snapshot derivation",
    );
  }
  const expectedListenerId = await nativeListenerRegistrationAttestationId({
    runtimeId,
    nativeIncarnation,
    runtimeOwnerKeyGeneration,
  });
  const listenerId = parseA1CanonicalId(
    "nativeListenerRegistrationAttestation",
    row.nativeListenerRegistrationAttestationId,
    "nativeBindingCapabilityInputVector.nativeListenerRegistrationAttestationId",
  );
  if (listenerId !== expectedListenerId) {
    reject(
      "nativeBindingCapabilityInputVector.nativeListenerRegistrationAttestationId",
      "must match the same runtime/incarnation/key-generation derivation",
    );
  }
  const expectedIsolationId = await nativeRuntimeIsolationAttestationId({
    runtimeId,
    nativeIncarnation,
    runtimeOwnerKeyGeneration,
  });
  const isolationId = parseA1CanonicalId(
    "nativeRuntimeIsolationAttestation",
    row.runtimeIsolationAttestationId,
    "nativeBindingCapabilityInputVector.runtimeIsolationAttestationId",
  );
  if (isolationId !== expectedIsolationId) {
    reject(
      "nativeBindingCapabilityInputVector.runtimeIsolationAttestationId",
      "must match the same runtime/incarnation/key-generation derivation",
    );
  }
  return frozen({
    schemaVersion: 1,
    schemaId: NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID,
    capabilitySnapshotId: snapshotId,
    capabilitySnapshotAttestationId: snapshotAttestationId,
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeBindingCapabilityInputVector.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeBindingCapabilityInputVector.logicalChatId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeBindingCapabilityInputVector.nativeBindingId",
    ),
    nativeBindingIncarnationId: parseA1SafeId(
      row.nativeBindingIncarnationId,
      "nativeBindingCapabilityInputVector.nativeBindingIncarnationId",
    ),
    nativeConversationLeaseId: parseA1CanonicalId(
      "nativeConversationLease",
      row.nativeConversationLeaseId,
      "nativeBindingCapabilityInputVector.nativeConversationLeaseId",
    ),
    nativeRegistrationPublicationId: parseA1SafeId(
      row.nativeRegistrationPublicationId,
      "nativeBindingCapabilityInputVector.nativeRegistrationPublicationId",
    ),
    nativeConversationId: parseA1SafeId(
      row.nativeConversationId,
      "nativeBindingCapabilityInputVector.nativeConversationId",
    ),
    runtimeId,
    nativeIncarnation,
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      "nativeBindingCapabilityInputVector.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration,
    projectId: parseA1CanonicalId(
      "project",
      row.projectId,
      "nativeBindingCapabilityInputVector.projectId",
    ),
    attachmentId: parseA1SafeId(
      row.attachmentId,
      "nativeBindingCapabilityInputVector.attachmentId",
    ),
    attachmentLeaseId,
    nativeWorkspaceBindingId: parseA1CanonicalId(
      "nativeWorkspaceBinding",
      row.nativeWorkspaceBindingId,
      "nativeBindingCapabilityInputVector.nativeWorkspaceBindingId",
    ),
    canonicalDirectoryPathDigest: parseA1Digest(
      row.canonicalDirectoryPathDigest,
      "nativeBindingCapabilityInputVector.canonicalDirectoryPathDigest",
    ),
    nativeWorkspaceBindingDigest: parseA1Digest(
      row.nativeWorkspaceBindingDigest,
      "nativeBindingCapabilityInputVector.nativeWorkspaceBindingDigest",
    ),
    capabilityGeneration,
    descriptor,
    engineVersion: parseBoundedString(
      row.engineVersion,
      "nativeBindingCapabilityInputVector.engineVersion",
      256,
    ),
    nativeSurfaceSchemaId: parseBoundedString(
      row.nativeSurfaceSchemaId,
      "nativeBindingCapabilityInputVector.nativeSurfaceSchemaId",
      1024,
    ),
    nativeListenerRegistrationAttestationId: listenerId,
    listenerSignedRecordDigest: parseA1Digest(
      row.listenerSignedRecordDigest,
      "nativeBindingCapabilityInputVector.listenerSignedRecordDigest",
    ),
    runtimeIsolationAttestationId: isolationId,
    isolationSignedRecordDigest: parseA1Digest(
      row.isolationSignedRecordDigest,
      "nativeBindingCapabilityInputVector.isolationSignedRecordDigest",
    ),
    slashCommandNormalizationSchemaId: OPENCODE_SLASH_COMMAND_NORMALIZATION_SCHEMA_ID,
    verifiedAtMs: parsePositiveSafeInteger(
      row.verifiedAtMs,
      "nativeBindingCapabilityInputVector.verifiedAtMs",
    ),
    artifacts,
  });
}

function writeCommitment(writer: CanonicalWriter, commitment: NativeEvidenceArtifactCommitmentV1) {
  writer.str(commitment.role);
  writer.str(commitment.artifactSchemaId);
  writer.bytes(base64urlDecode(commitment.artifactDigest));
  writer.uint(commitment.byteLength);
}

function writeCommitments(
  writer: CanonicalWriter,
  commitments: readonly NativeEvidenceArtifactCommitmentV1[],
): void {
  writer.uint(commitments.length);
  for (const commitment of commitments) writeCommitment(writer, commitment);
}

export function encodeNativeWorkspaceBindingInput(value: unknown): Uint8Array {
  const input = parseNativeWorkspaceBindingInput(value);
  const writer = new CanonicalWriter();
  writer.str(input.schemaId);
  writer.uint(input.schemaVersion);
  writer.str(input.nativeWorkspaceBindingId);
  writer.str(input.runtimeId);
  writer.uint(input.nativeIncarnation);
  writer.str(input.projectId);
  writer.optionalStr(input.nativeWorkspaceId);
  writer.str(input.directoryNormalizationSchemaId);
  writer.str(input.filesystemIdentitySchemaId);
  writer.uint(input.workspaceGeneration);
  writeCommitments(writer, input.artifacts);
  return writer.finish();
}

export async function encodeNativeListenerEvidenceInputVector(value: unknown): Promise<Uint8Array> {
  const input = await parseNativeListenerEvidenceInputVector(value);
  const writer = new CanonicalWriter();
  writer.str(input.schemaId);
  writer.uint(input.schemaVersion);
  writer.str(input.nativeListenerRegistrationAttestationId);
  writer.str(input.runtimeId);
  writer.uint(input.nativeIncarnation);
  writer.str(input.runtimeOwnerIdentityKeyId);
  writer.uint(input.runtimeOwnerKeyGeneration);
  writer.str(input.descriptor.product);
  writer.str(input.descriptor.access);
  writer.str(input.engineVersion);
  writer.str(input.surfaceSchemaKind);
  writer.str(input.routeResolutionSchemaId);
  writeCommitments(writer, input.artifacts);
  return writer.finish();
}

export async function encodeNativeIsolationEvidenceInputVector(
  value: unknown,
): Promise<Uint8Array> {
  const input = await parseNativeIsolationEvidenceInputVector(value);
  const writer = new CanonicalWriter();
  writer.str(input.schemaId);
  writer.uint(input.schemaVersion);
  writer.str(input.runtimeIsolationAttestationId);
  writer.str(input.runtimeId);
  writer.uint(input.nativeIncarnation);
  writer.str(input.runtimeOwnerIdentityKeyId);
  writer.uint(input.runtimeOwnerKeyGeneration);
  writer.str(input.descriptor.product);
  writer.str(input.descriptor.access);
  writer.str(input.nativeListenerRegistrationAttestationId);
  writer.bytes(base64urlDecode(input.listenerSignedRecordDigest));
  writer.str(input.processIdentityPolicySchemaId);
  writeCommitments(writer, input.artifacts);
  return writer.finish();
}

export async function encodeNativeBindingCapabilityInputVector(
  value: unknown,
): Promise<Uint8Array> {
  const input = await parseNativeBindingCapabilityInputVector(value);
  const writer = new CanonicalWriter();
  writer.str(input.schemaId);
  writer.uint(input.schemaVersion);
  writer.str(input.capabilitySnapshotId);
  writer.str(input.capabilitySnapshotAttestationId);
  writer.str(input.collaborationServerId);
  writer.str(input.logicalChatId);
  writer.str(input.nativeBindingId);
  writer.str(input.nativeBindingIncarnationId);
  writer.str(input.nativeConversationLeaseId);
  writer.str(input.nativeRegistrationPublicationId);
  writer.str(input.nativeConversationId);
  writer.str(input.runtimeId);
  writer.uint(input.nativeIncarnation);
  writer.str(input.runtimeOwnerIdentityKeyId);
  writer.uint(input.runtimeOwnerKeyGeneration);
  writer.str(input.projectId);
  writer.str(input.attachmentId);
  writer.str(input.attachmentLeaseId);
  writer.str(input.nativeWorkspaceBindingId);
  writer.bytes(base64urlDecode(input.canonicalDirectoryPathDigest));
  writer.bytes(base64urlDecode(input.nativeWorkspaceBindingDigest));
  writer.uint(input.capabilityGeneration);
  writer.str(input.descriptor.product);
  writer.str(input.descriptor.access);
  writer.str(input.engineVersion);
  writer.str(input.nativeSurfaceSchemaId);
  writer.str(input.nativeListenerRegistrationAttestationId);
  writer.bytes(base64urlDecode(input.listenerSignedRecordDigest));
  writer.str(input.runtimeIsolationAttestationId);
  writer.bytes(base64urlDecode(input.isolationSignedRecordDigest));
  writer.str(input.slashCommandNormalizationSchemaId);
  writer.uint(input.verifiedAtMs);
  writeCommitments(writer, input.artifacts);
  return writer.finish();
}

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ENCODER = new TextEncoder();

class StrictCanonicalReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;
  #offset = 0;

  constructor(value: Uint8Array, field: string) {
    const sourceByteLength = canonicalByteLength(value);
    if (sourceByteLength === 0 || sourceByteLength > MAX_NATIVE_EVIDENCE_PARENT_BYTES) {
      reject(field, `must contain 1..${MAX_NATIVE_EVIDENCE_PARENT_BYTES} canonical bytes`);
    }
    this.#bytes = canonicalByteSnapshot(value);
    const snapshotByteLength = canonicalByteLength(this.#bytes);
    if (snapshotByteLength === 0 || snapshotByteLength > MAX_NATIVE_EVIDENCE_PARENT_BYTES) {
      reject(field, `must contain 1..${MAX_NATIVE_EVIDENCE_PARENT_BYTES} canonical bytes`);
    }
  }

  #readRaw(length: number, field: string): Uint8Array<ArrayBuffer> {
    if (length < 0 || this.#offset + length > this.#bytes.byteLength) {
      reject(field, "is truncated");
    }
    const result = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  bytes(field: string, exactLength?: number): Uint8Array<ArrayBuffer> {
    const prefix = this.#readRaw(4, `${field}.length`);
    const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(
      0,
      false,
    );
    if (exactLength !== undefined && length !== exactLength) {
      reject(field, `must contain exactly ${exactLength} bytes`);
    }
    return this.#readRaw(length, field);
  }

  str(field: string): string {
    const bytes = this.bytes(field);
    let result: string;
    try {
      result = DECODER.decode(bytes);
    } catch {
      reject(field, "must contain canonical UTF-8");
    }
    const roundTrip = ENCODER.encode(result);
    if (
      roundTrip.byteLength !== bytes.byteLength ||
      roundTrip.some((byte, index) => byte !== bytes[index])
    ) {
      reject(field, "must contain canonical UTF-8");
    }
    return result;
  }

  uint(field: string): number {
    const bytes = this.bytes(field, 8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      0,
      false,
    );
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) reject(field, "must be a safe integer");
    return Number(value);
  }

  optionalStr(field: string): string | null {
    const present = this.#readRaw(1, `${field}.presence`)[0];
    if (present === 0) return null;
    if (present !== 1) reject(`${field}.presence`, "must equal 0 or 1");
    return this.str(field);
  }

  finish(field: string): void {
    if (this.#offset !== this.#bytes.byteLength) reject(field, "must not contain trailing bytes");
  }
}

function readCommitment<const Role extends NativeBindingAuthorityArtifactRole>(
  reader: StrictCanonicalReader,
  expectedRole: Role,
  field: string,
): NativeEvidenceArtifactCommitmentV1<Role> {
  return parseNativeEvidenceArtifactCommitment(
    {
      role: reader.str(`${field}.role`),
      artifactSchemaId: reader.str(`${field}.artifactSchemaId`),
      artifactDigest: base64urlEncode(reader.bytes(`${field}.artifactDigest`, 32)),
      byteLength: reader.uint(`${field}.byteLength`),
    },
    expectedRole,
    field,
  );
}

function readCommitments<R extends readonly NativeBindingAuthorityArtifactRole[]>(
  reader: StrictCanonicalReader,
  roles: R,
  field: string,
): FixedCommitments<R> {
  const count = reader.uint(`${field}.count`);
  if (count !== roles.length) reject(`${field}.count`, `must equal ${roles.length}`);
  return Object.freeze(
    roles.map((role, index) => readCommitment(reader, role, `${field}[${index}]`)),
  ) as FixedCommitments<R>;
}

export function decodeNativeWorkspaceBindingInput(
  value: Uint8Array,
): NativeWorkspaceBindingInputV1 {
  const reader = new StrictCanonicalReader(value, "nativeWorkspaceBindingInputBytes");
  const result = parseNativeWorkspaceBindingInput({
    schemaId: reader.str("nativeWorkspaceBindingInput.schemaId"),
    schemaVersion: reader.uint("nativeWorkspaceBindingInput.schemaVersion"),
    nativeWorkspaceBindingId: reader.str("nativeWorkspaceBindingInput.nativeWorkspaceBindingId"),
    runtimeId: reader.str("nativeWorkspaceBindingInput.runtimeId"),
    nativeIncarnation: reader.uint("nativeWorkspaceBindingInput.nativeIncarnation"),
    projectId: reader.str("nativeWorkspaceBindingInput.projectId"),
    nativeWorkspaceId: reader.optionalStr("nativeWorkspaceBindingInput.nativeWorkspaceId"),
    directoryNormalizationSchemaId: reader.str(
      "nativeWorkspaceBindingInput.directoryNormalizationSchemaId",
    ),
    filesystemIdentitySchemaId: reader.str(
      "nativeWorkspaceBindingInput.filesystemIdentitySchemaId",
    ),
    workspaceGeneration: reader.uint("nativeWorkspaceBindingInput.workspaceGeneration"),
    artifacts: readCommitments(
      reader,
      WORKSPACE_ARTIFACT_ROLES,
      "nativeWorkspaceBindingInput.artifacts",
    ),
  });
  reader.finish("nativeWorkspaceBindingInputBytes");
  return result;
}

export async function decodeNativeListenerEvidenceInputVector(
  value: Uint8Array,
): Promise<NativeListenerEvidenceInputVectorV1> {
  const reader = new StrictCanonicalReader(value, "nativeListenerEvidenceInputVectorBytes");
  const result = await parseNativeListenerEvidenceInputVector({
    schemaId: reader.str("nativeListenerEvidenceInputVector.schemaId"),
    schemaVersion: reader.uint("nativeListenerEvidenceInputVector.schemaVersion"),
    nativeListenerRegistrationAttestationId: reader.str(
      "nativeListenerEvidenceInputVector.nativeListenerRegistrationAttestationId",
    ),
    runtimeId: reader.str("nativeListenerEvidenceInputVector.runtimeId"),
    nativeIncarnation: reader.uint("nativeListenerEvidenceInputVector.nativeIncarnation"),
    runtimeOwnerIdentityKeyId: reader.str(
      "nativeListenerEvidenceInputVector.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: reader.uint(
      "nativeListenerEvidenceInputVector.runtimeOwnerKeyGeneration",
    ),
    descriptor: {
      product: reader.str("nativeListenerEvidenceInputVector.descriptor.product"),
      access: reader.str("nativeListenerEvidenceInputVector.descriptor.access"),
    },
    engineVersion: reader.str("nativeListenerEvidenceInputVector.engineVersion"),
    surfaceSchemaKind: reader.str("nativeListenerEvidenceInputVector.surfaceSchemaKind"),
    routeResolutionSchemaId: reader.str(
      "nativeListenerEvidenceInputVector.routeResolutionSchemaId",
    ),
    artifacts: readCommitments(
      reader,
      LISTENER_ARTIFACT_ROLES,
      "nativeListenerEvidenceInputVector.artifacts",
    ),
  });
  reader.finish("nativeListenerEvidenceInputVectorBytes");
  return result;
}

export async function decodeNativeIsolationEvidenceInputVector(
  value: Uint8Array,
): Promise<NativeIsolationEvidenceInputVectorV1> {
  const reader = new StrictCanonicalReader(value, "nativeIsolationEvidenceInputVectorBytes");
  const result = await parseNativeIsolationEvidenceInputVector({
    schemaId: reader.str("nativeIsolationEvidenceInputVector.schemaId"),
    schemaVersion: reader.uint("nativeIsolationEvidenceInputVector.schemaVersion"),
    runtimeIsolationAttestationId: reader.str(
      "nativeIsolationEvidenceInputVector.runtimeIsolationAttestationId",
    ),
    runtimeId: reader.str("nativeIsolationEvidenceInputVector.runtimeId"),
    nativeIncarnation: reader.uint("nativeIsolationEvidenceInputVector.nativeIncarnation"),
    runtimeOwnerIdentityKeyId: reader.str(
      "nativeIsolationEvidenceInputVector.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: reader.uint(
      "nativeIsolationEvidenceInputVector.runtimeOwnerKeyGeneration",
    ),
    descriptor: {
      product: reader.str("nativeIsolationEvidenceInputVector.descriptor.product"),
      access: reader.str("nativeIsolationEvidenceInputVector.descriptor.access"),
    },
    nativeListenerRegistrationAttestationId: reader.str(
      "nativeIsolationEvidenceInputVector.nativeListenerRegistrationAttestationId",
    ),
    listenerSignedRecordDigest: base64urlEncode(
      reader.bytes("nativeIsolationEvidenceInputVector.listenerSignedRecordDigest", 32),
    ),
    processIdentityPolicySchemaId: reader.str(
      "nativeIsolationEvidenceInputVector.processIdentityPolicySchemaId",
    ),
    artifacts: readCommitments(
      reader,
      ISOLATION_ARTIFACT_ROLES,
      "nativeIsolationEvidenceInputVector.artifacts",
    ),
  });
  reader.finish("nativeIsolationEvidenceInputVectorBytes");
  return result;
}

export async function decodeNativeBindingCapabilityInputVector(
  value: Uint8Array,
): Promise<NativeBindingCapabilityInputVectorV1> {
  const reader = new StrictCanonicalReader(value, "nativeBindingCapabilityInputVectorBytes");
  const result = await parseNativeBindingCapabilityInputVector({
    schemaId: reader.str("nativeBindingCapabilityInputVector.schemaId"),
    schemaVersion: reader.uint("nativeBindingCapabilityInputVector.schemaVersion"),
    capabilitySnapshotId: reader.str("nativeBindingCapabilityInputVector.capabilitySnapshotId"),
    capabilitySnapshotAttestationId: reader.str(
      "nativeBindingCapabilityInputVector.capabilitySnapshotAttestationId",
    ),
    collaborationServerId: reader.str("nativeBindingCapabilityInputVector.collaborationServerId"),
    logicalChatId: reader.str("nativeBindingCapabilityInputVector.logicalChatId"),
    nativeBindingId: reader.str("nativeBindingCapabilityInputVector.nativeBindingId"),
    nativeBindingIncarnationId: reader.str(
      "nativeBindingCapabilityInputVector.nativeBindingIncarnationId",
    ),
    nativeConversationLeaseId: reader.str(
      "nativeBindingCapabilityInputVector.nativeConversationLeaseId",
    ),
    nativeRegistrationPublicationId: reader.str(
      "nativeBindingCapabilityInputVector.nativeRegistrationPublicationId",
    ),
    nativeConversationId: reader.str("nativeBindingCapabilityInputVector.nativeConversationId"),
    runtimeId: reader.str("nativeBindingCapabilityInputVector.runtimeId"),
    nativeIncarnation: reader.uint("nativeBindingCapabilityInputVector.nativeIncarnation"),
    runtimeOwnerIdentityKeyId: reader.str(
      "nativeBindingCapabilityInputVector.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: reader.uint(
      "nativeBindingCapabilityInputVector.runtimeOwnerKeyGeneration",
    ),
    projectId: reader.str("nativeBindingCapabilityInputVector.projectId"),
    attachmentId: reader.str("nativeBindingCapabilityInputVector.attachmentId"),
    attachmentLeaseId: reader.str("nativeBindingCapabilityInputVector.attachmentLeaseId"),
    nativeWorkspaceBindingId: reader.str(
      "nativeBindingCapabilityInputVector.nativeWorkspaceBindingId",
    ),
    canonicalDirectoryPathDigest: base64urlEncode(
      reader.bytes("nativeBindingCapabilityInputVector.canonicalDirectoryPathDigest", 32),
    ),
    nativeWorkspaceBindingDigest: base64urlEncode(
      reader.bytes("nativeBindingCapabilityInputVector.nativeWorkspaceBindingDigest", 32),
    ),
    capabilityGeneration: reader.uint("nativeBindingCapabilityInputVector.capabilityGeneration"),
    descriptor: {
      product: reader.str("nativeBindingCapabilityInputVector.descriptor.product"),
      access: reader.str("nativeBindingCapabilityInputVector.descriptor.access"),
    },
    engineVersion: reader.str("nativeBindingCapabilityInputVector.engineVersion"),
    nativeSurfaceSchemaId: reader.str("nativeBindingCapabilityInputVector.nativeSurfaceSchemaId"),
    nativeListenerRegistrationAttestationId: reader.str(
      "nativeBindingCapabilityInputVector.nativeListenerRegistrationAttestationId",
    ),
    listenerSignedRecordDigest: base64urlEncode(
      reader.bytes("nativeBindingCapabilityInputVector.listenerSignedRecordDigest", 32),
    ),
    runtimeIsolationAttestationId: reader.str(
      "nativeBindingCapabilityInputVector.runtimeIsolationAttestationId",
    ),
    isolationSignedRecordDigest: base64urlEncode(
      reader.bytes("nativeBindingCapabilityInputVector.isolationSignedRecordDigest", 32),
    ),
    slashCommandNormalizationSchemaId: reader.str(
      "nativeBindingCapabilityInputVector.slashCommandNormalizationSchemaId",
    ),
    verifiedAtMs: reader.uint("nativeBindingCapabilityInputVector.verifiedAtMs"),
    artifacts: readCommitments(
      reader,
      CAPABILITY_ARTIFACT_ROLES,
      "nativeBindingCapabilityInputVector.artifacts",
    ),
  });
  reader.finish("nativeBindingCapabilityInputVectorBytes");
  return result;
}

export async function nativeBindingAuthorityArtifactDigest(value: Uint8Array): Promise<A1Digest> {
  const sourceByteLength = canonicalByteLength(value);
  if (sourceByteLength === 0 || sourceByteLength > MAX_PROTECTED_ARTIFACT_BYTES) {
    reject(
      "nativeBindingAuthorityArtifact",
      `must contain 1..${MAX_PROTECTED_ARTIFACT_BYTES} bytes`,
    );
  }
  const snapshot = canonicalByteSnapshot(value);
  const snapshotByteLength = canonicalByteLength(snapshot);
  if (snapshotByteLength === 0 || snapshotByteLength > MAX_PROTECTED_ARTIFACT_BYTES) {
    reject(
      "nativeBindingAuthorityArtifact",
      `must contain 1..${MAX_PROTECTED_ARTIFACT_BYTES} bytes`,
    );
  }
  return parseA1Digest(base64urlEncode(await sha256(snapshot)));
}
