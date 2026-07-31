import type { NativeEngineDescriptor } from "../native/adapter.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type LogicalChatId,
  type NativeBindingId,
  type NativeConversationLeaseId,
  type ProjectId,
  type ProjectTargetSelectorMappingId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
  type RegistrationAttemptId,
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
  reject,
} from "./validation.js";

export interface CollaborationServerRecord {
  readonly collaborationServerId: CollaborationServerId;
  readonly machineIdentityId: string;
  readonly currentKeyGeneration: number;
  readonly currentIdentityKeyId: A1SafeId | null;
  readonly currentScopeCertificateId: A1SafeId | null;
  readonly currentCoordinatorEpoch: number;
  readonly currentCoordinatorLeaseId: CoordinatorLeaseId | null;
  readonly nextJournalOffset: number;
  readonly nextServerSignatureSeq: number;
  readonly nextCommandSeq: number;
  readonly createdAtMs: number;
  readonly state: "installing" | "current" | "repairing" | "closed";
}

export interface HostStateProfileRecord {
  readonly stateProfileId: "default";
  readonly machineIdentityId: string;
  readonly defaultCollaborationServerId: CollaborationServerId;
  readonly createdAtMs: number;
}

export interface ProjectRecord {
  readonly projectId: ProjectId;
  readonly collaborationServerId: CollaborationServerId;
  readonly projectAllocationIntentId: A1SafeId;
  readonly projectAllocationIntentSchemaId: "remote-claw/project-allocation-intent/v1";
  readonly projectAllocationIntentDigest: A1Digest;
  readonly allocationKind: "first_bootstrap" | "explicit_new_project";
  readonly initialWorkspaceSelectorId: A1SafeId;
  readonly initialTargetDigest: A1Digest;
  readonly initialProjectTargetSelectorMappingId: ProjectTargetSelectorMappingId;
  readonly createdAtMs: number;
  readonly state: "current" | "closed";
}

export interface CoordinatorLeaseRecord {
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly collaborationServerId: CollaborationServerId;
  readonly coordinatorEpoch: number;
  readonly ownerInstanceId: A1SafeId;
  readonly acquiredAtMs: number;
  readonly heartbeatDeadlineMs: number;
  readonly releasedAtMs: number | null;
  readonly state: "current" | "expired" | "released" | "superseded";
}

export interface CoordinatorLeaseFence {
  readonly collaborationServerId: CollaborationServerId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
}

export interface NativeRegistrationIntentRecord {
  readonly registrationAttemptId: RegistrationAttemptId;
  readonly collaborationServerId: CollaborationServerId;
  readonly nativeBindingId: NativeBindingId;
  readonly canonicalIntentSchemaId: "remote-claw/native-registration-intent/v1";
  readonly descriptorRef: A1SafeId;
  readonly descriptorDigest: A1Digest;
  readonly projectRef: A1SafeId;
  readonly projectDigest: A1Digest;
  readonly expectedNativeRefDigest: A1Digest | null;
  readonly initialPhase: "starting" | "recovering";
  readonly metadataSchemaId: string;
  readonly metadataRef: A1SafeId;
  readonly metadataDigest: A1Digest;
  readonly capabilitiesRef: A1SafeId | null;
  readonly capabilitiesDigest: A1Digest | null;
  readonly canonicalIntentDigest: A1Digest;
  readonly createdAtMs: number;
}

export interface NativeConversationLeaseRecord {
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly collaborationServerId: CollaborationServerId;
  readonly nativeBindingId: NativeBindingId;
  readonly registrationAttemptId: RegistrationAttemptId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly protectedPortHandleId: ProtectedHandleId;
  readonly acquiredAtMs: number;
  readonly closedAtMs: number | null;
  readonly state: "starting" | "recovering" | "ready" | "draining" | "closed";
}

export interface LocalArtifactRecord {
  readonly artifactId: A1SafeId;
  readonly artifactKind: string;
  readonly canonicalSchemaId: string;
  readonly digestAlgorithm: "SHA-256";
  readonly artifactDigest: A1Digest;
  readonly byteLength: number;
  readonly protectedStorageHandleId: ProtectedHandleId;
  readonly createdAtMs: number;
}

export type ProjectTarget =
  | Readonly<{
      kind: "terminal_native";
      descriptor: NativeEngineDescriptor;
      terminalProjectRef: A1SafeId;
      nativeWorkspaceBindingId: A1SafeId | null;
    }>
  | Readonly<{
      kind: "nested_server";
      nestedServerManagementBindingId: A1SafeId;
      targetServerId: CollaborationServerId;
      targetProjectId: ProjectId;
      targetWorkspaceSelectorId: A1SafeId;
    }>;

export interface ProjectTargetSelectorMappingRecord {
  readonly projectTargetSelectorMappingId: ProjectTargetSelectorMappingId;
  readonly collaborationServerId: CollaborationServerId;
  readonly projectId: ProjectId;
  readonly workspaceSelectorId: A1SafeId;
  readonly target: ProjectTarget;
  readonly targetDigest: A1Digest;
  readonly mappingGeneration: number;
  readonly evidenceRef: A1SafeId;
  readonly state: "current" | "superseded" | "closed";
}

export interface LogicalChatRecord {
  readonly logicalChatId: LogicalChatId;
  readonly collaborationServerId: CollaborationServerId;
  readonly projectId: ProjectId;
  readonly state: "recovering" | "ready" | "quarantined" | "closed";
  readonly topologyGeneration: number;
  readonly currentInwardEdgeId: A1SafeId | null;
  readonly currentNativeBindingId: NativeBindingId | null;
  readonly parentChatId: LogicalChatId | null;
  readonly nextViewerProjectionSeq: number;
}

export interface NativeBindingRecord {
  readonly nativeBindingId: NativeBindingId;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly descriptor: NativeEngineDescriptor;
  readonly projectId: ProjectId;
  readonly semanticConversationId: A1SafeId | null;
  readonly currentBindingIncarnationId: A1SafeId | null;
  readonly state: "starting" | "current" | "superseded" | "closed";
}

const SERVER_KEYS = [
  "collaborationServerId",
  "machineIdentityId",
  "currentKeyGeneration",
  "currentIdentityKeyId",
  "currentScopeCertificateId",
  "currentCoordinatorEpoch",
  "currentCoordinatorLeaseId",
  "nextJournalOffset",
  "nextServerSignatureSeq",
  "nextCommandSeq",
  "createdAtMs",
  "state",
] as const;

export function parseCollaborationServerRecord(value: unknown): CollaborationServerRecord {
  const row = parseExactRecord(value, SERVER_KEYS, "collaborationServer");
  const currentKeyGeneration = parseNonNegativeSafeInteger(
    row.currentKeyGeneration,
    "collaborationServer.currentKeyGeneration",
  );
  const currentIdentityKeyId = parseNullable(
    row.currentIdentityKeyId,
    parseA1SafeId,
    "collaborationServer.currentIdentityKeyId",
  );
  const currentScopeCertificateId = parseNullable(
    row.currentScopeCertificateId,
    parseA1SafeId,
    "collaborationServer.currentScopeCertificateId",
  );
  if (
    (currentIdentityKeyId === null) !== (currentScopeCertificateId === null) ||
    (currentKeyGeneration === 0) !== (currentIdentityKeyId === null)
  ) {
    reject(
      "collaborationServer.currentKey",
      "generation and identity/certificate pointers must be all absent at generation zero or all present",
    );
  }
  const currentCoordinatorEpoch = parseNonNegativeSafeInteger(
    row.currentCoordinatorEpoch,
    "collaborationServer.currentCoordinatorEpoch",
  );
  const currentCoordinatorLeaseId = parseNullable(
    row.currentCoordinatorLeaseId,
    (_value, field) => parseA1CanonicalId("coordinatorLease", _value, field),
    "collaborationServer.currentCoordinatorLeaseId",
  );
  if (currentCoordinatorEpoch === 0 && currentCoordinatorLeaseId !== null) {
    reject(
      "collaborationServer.currentCoordinatorLeaseId",
      "must be null before the first coordinator epoch",
    );
  }
  const state = parseEnum(
    row.state,
    ["installing", "current", "repairing", "closed"] as const,
    "collaborationServer.state",
  );
  if (state === "installing" && currentKeyGeneration !== 0) {
    reject(
      "collaborationServer.currentKey",
      "must remain at generation zero with null pointers while the server is installing",
    );
  }
  if (state === "current" && currentIdentityKeyId === null) {
    reject("collaborationServer.currentKey", "must be installed before the server becomes current");
  }
  return frozen({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "collaborationServer.collaborationServerId",
    ),
    machineIdentityId: parseMachineIdentityId(
      row.machineIdentityId,
      "collaborationServer.machineIdentityId",
    ),
    currentKeyGeneration,
    currentIdentityKeyId,
    currentScopeCertificateId,
    currentCoordinatorEpoch,
    currentCoordinatorLeaseId,
    nextJournalOffset: parseNonNegativeSafeInteger(
      row.nextJournalOffset,
      "collaborationServer.nextJournalOffset",
    ),
    nextServerSignatureSeq: parseNonNegativeSafeInteger(
      row.nextServerSignatureSeq,
      "collaborationServer.nextServerSignatureSeq",
    ),
    nextCommandSeq: parseNonNegativeSafeInteger(
      row.nextCommandSeq,
      "collaborationServer.nextCommandSeq",
    ),
    createdAtMs: parseNonNegativeSafeInteger(row.createdAtMs, "collaborationServer.createdAtMs"),
    state,
  });
}

const PROFILE_KEYS = [
  "stateProfileId",
  "machineIdentityId",
  "defaultCollaborationServerId",
  "createdAtMs",
] as const;

export function parseHostStateProfileRecord(value: unknown): HostStateProfileRecord {
  const row = parseExactRecord(value, PROFILE_KEYS, "hostStateProfile");
  return frozen({
    stateProfileId: parseLiteral(row.stateProfileId, "default", "hostStateProfile.stateProfileId"),
    machineIdentityId: parseMachineIdentityId(
      row.machineIdentityId,
      "hostStateProfile.machineIdentityId",
    ),
    defaultCollaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.defaultCollaborationServerId,
      "hostStateProfile.defaultCollaborationServerId",
    ),
    createdAtMs: parseNonNegativeSafeInteger(row.createdAtMs, "hostStateProfile.createdAtMs"),
  });
}

const PROJECT_KEYS = [
  "projectId",
  "collaborationServerId",
  "projectAllocationIntentId",
  "projectAllocationIntentSchemaId",
  "projectAllocationIntentDigest",
  "allocationKind",
  "initialWorkspaceSelectorId",
  "initialTargetDigest",
  "initialProjectTargetSelectorMappingId",
  "createdAtMs",
  "state",
] as const;

export function parseProjectRecord(value: unknown): ProjectRecord {
  const row = parseExactRecord(value, PROJECT_KEYS, "project");
  const allocationKind = parseEnum(
    row.allocationKind,
    ["first_bootstrap", "explicit_new_project"] as const,
    "project.allocationKind",
  );
  const projectAllocationIntentId =
    allocationKind === "first_bootstrap"
      ? parseA1CanonicalId(
          "registrationAttempt",
          row.projectAllocationIntentId,
          "project.projectAllocationIntentId",
        )
      : parseA1SafeId(row.projectAllocationIntentId, "project.projectAllocationIntentId");
  return frozen({
    projectId: parseA1CanonicalId("project", row.projectId, "project.projectId"),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "project.collaborationServerId",
    ),
    projectAllocationIntentId,
    projectAllocationIntentSchemaId: parseLiteral(
      row.projectAllocationIntentSchemaId,
      "remote-claw/project-allocation-intent/v1",
      "project.projectAllocationIntentSchemaId",
    ),
    projectAllocationIntentDigest: parseA1Digest(
      row.projectAllocationIntentDigest,
      "project.projectAllocationIntentDigest",
    ),
    allocationKind,
    initialWorkspaceSelectorId: parseA1SafeId(
      row.initialWorkspaceSelectorId,
      "project.initialWorkspaceSelectorId",
    ),
    initialTargetDigest: parseA1Digest(row.initialTargetDigest, "project.initialTargetDigest"),
    initialProjectTargetSelectorMappingId: parseA1CanonicalId(
      "projectTargetSelectorMapping",
      row.initialProjectTargetSelectorMappingId,
      "project.initialProjectTargetSelectorMappingId",
    ),
    createdAtMs: parseNonNegativeSafeInteger(row.createdAtMs, "project.createdAtMs"),
    state: parseEnum(row.state, ["current", "closed"] as const, "project.state"),
  });
}

const COORDINATOR_LEASE_KEYS = [
  "coordinatorLeaseId",
  "collaborationServerId",
  "coordinatorEpoch",
  "ownerInstanceId",
  "acquiredAtMs",
  "heartbeatDeadlineMs",
  "releasedAtMs",
  "state",
] as const;

export function parseCoordinatorLeaseRecord(value: unknown): CoordinatorLeaseRecord {
  const row = parseExactRecord(value, COORDINATOR_LEASE_KEYS, "coordinatorLease");
  const acquiredAtMs = parseNonNegativeSafeInteger(
    row.acquiredAtMs,
    "coordinatorLease.acquiredAtMs",
  );
  const heartbeatDeadlineMs = parseNonNegativeSafeInteger(
    row.heartbeatDeadlineMs,
    "coordinatorLease.heartbeatDeadlineMs",
  );
  const releasedAtMs = parseNullable(
    row.releasedAtMs,
    parseNonNegativeSafeInteger,
    "coordinatorLease.releasedAtMs",
  );
  const state = parseEnum(
    row.state,
    ["current", "expired", "released", "superseded"] as const,
    "coordinatorLease.state",
  );
  if (heartbeatDeadlineMs < acquiredAtMs) {
    reject("coordinatorLease.heartbeatDeadlineMs", "must not precede acquisition");
  }
  if (releasedAtMs !== null && releasedAtMs < acquiredAtMs) {
    reject("coordinatorLease.releasedAtMs", "must not precede acquisition");
  }
  if (state === "current" && releasedAtMs !== null) {
    reject("coordinatorLease.releasedAtMs", "must be null while the lease is current");
  }
  if (state === "released" && releasedAtMs === null) {
    reject("coordinatorLease.releasedAtMs", "must be present for a released lease");
  }
  return frozen({
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "coordinatorLease.coordinatorLeaseId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "coordinatorLease.collaborationServerId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "coordinatorLease.coordinatorEpoch",
    ),
    ownerInstanceId: parseA1SafeId(row.ownerInstanceId, "coordinatorLease.ownerInstanceId"),
    acquiredAtMs,
    heartbeatDeadlineMs,
    releasedAtMs,
    state,
  });
}

const COORDINATOR_FENCE_KEYS = [
  "collaborationServerId",
  "coordinatorLeaseId",
  "coordinatorEpoch",
] as const;

export function parseCoordinatorLeaseFence(value: unknown): CoordinatorLeaseFence {
  const fence = parseExactRecord(value, COORDINATOR_FENCE_KEYS, "coordinatorFence");
  return frozen({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      fence.collaborationServerId,
      "coordinatorFence.collaborationServerId",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      fence.coordinatorLeaseId,
      "coordinatorFence.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      fence.coordinatorEpoch,
      "coordinatorFence.coordinatorEpoch",
    ),
  });
}

const REGISTRATION_INTENT_KEYS = [
  "registrationAttemptId",
  "collaborationServerId",
  "nativeBindingId",
  "canonicalIntentSchemaId",
  "descriptorRef",
  "descriptorDigest",
  "projectRef",
  "projectDigest",
  "expectedNativeRefDigest",
  "initialPhase",
  "metadataSchemaId",
  "metadataRef",
  "metadataDigest",
  "capabilitiesRef",
  "capabilitiesDigest",
  "canonicalIntentDigest",
  "createdAtMs",
] as const;

export function parseNativeRegistrationIntentRecord(
  value: unknown,
): NativeRegistrationIntentRecord {
  const row = parseExactRecord(value, REGISTRATION_INTENT_KEYS, "nativeRegistrationIntent");
  const capabilitiesRef = parseNullable(
    row.capabilitiesRef,
    parseA1SafeId,
    "nativeRegistrationIntent.capabilitiesRef",
  );
  const capabilitiesDigest = parseNullable(
    row.capabilitiesDigest,
    parseA1Digest,
    "nativeRegistrationIntent.capabilitiesDigest",
  );
  if ((capabilitiesRef === null) !== (capabilitiesDigest === null)) {
    reject(
      "nativeRegistrationIntent.capabilities",
      "reference and digest must either both be null or both be present",
    );
  }
  return frozen({
    registrationAttemptId: parseA1CanonicalId(
      "registrationAttempt",
      row.registrationAttemptId,
      "nativeRegistrationIntent.registrationAttemptId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeRegistrationIntent.collaborationServerId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeRegistrationIntent.nativeBindingId",
    ),
    canonicalIntentSchemaId: parseLiteral(
      row.canonicalIntentSchemaId,
      "remote-claw/native-registration-intent/v1",
      "nativeRegistrationIntent.canonicalIntentSchemaId",
    ),
    descriptorRef: parseA1SafeId(row.descriptorRef, "nativeRegistrationIntent.descriptorRef"),
    descriptorDigest: parseA1Digest(
      row.descriptorDigest,
      "nativeRegistrationIntent.descriptorDigest",
    ),
    projectRef: parseA1SafeId(row.projectRef, "nativeRegistrationIntent.projectRef"),
    projectDigest: parseA1Digest(row.projectDigest, "nativeRegistrationIntent.projectDigest"),
    expectedNativeRefDigest: parseNullable(
      row.expectedNativeRefDigest,
      parseA1Digest,
      "nativeRegistrationIntent.expectedNativeRefDigest",
    ),
    initialPhase: parseEnum(
      row.initialPhase,
      ["starting", "recovering"] as const,
      "nativeRegistrationIntent.initialPhase",
    ),
    metadataSchemaId: parseNonEmptyString(
      row.metadataSchemaId,
      "nativeRegistrationIntent.metadataSchemaId",
    ),
    metadataRef: parseA1SafeId(row.metadataRef, "nativeRegistrationIntent.metadataRef"),
    metadataDigest: parseA1Digest(row.metadataDigest, "nativeRegistrationIntent.metadataDigest"),
    capabilitiesRef,
    capabilitiesDigest,
    canonicalIntentDigest: parseA1Digest(
      row.canonicalIntentDigest,
      "nativeRegistrationIntent.canonicalIntentDigest",
    ),
    createdAtMs: parseNonNegativeSafeInteger(
      row.createdAtMs,
      "nativeRegistrationIntent.createdAtMs",
    ),
  });
}

const NATIVE_LEASE_KEYS = [
  "nativeConversationLeaseId",
  "collaborationServerId",
  "nativeBindingId",
  "registrationAttemptId",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "protectedPortHandleId",
  "acquiredAtMs",
  "closedAtMs",
  "state",
] as const;

export function parseNativeConversationLeaseRecord(value: unknown): NativeConversationLeaseRecord {
  const row = parseExactRecord(value, NATIVE_LEASE_KEYS, "nativeConversationLease");
  const acquiredAtMs = parseNonNegativeSafeInteger(
    row.acquiredAtMs,
    "nativeConversationLease.acquiredAtMs",
  );
  const closedAtMs = parseNullable(
    row.closedAtMs,
    parseNonNegativeSafeInteger,
    "nativeConversationLease.closedAtMs",
  );
  const state = parseEnum(
    row.state,
    ["starting", "recovering", "ready", "draining", "closed"] as const,
    "nativeConversationLease.state",
  );
  if (closedAtMs !== null && closedAtMs < acquiredAtMs) {
    reject("nativeConversationLease.closedAtMs", "must not precede acquisition");
  }
  if ((state === "closed") !== (closedAtMs !== null)) {
    reject(
      "nativeConversationLease.closedAtMs",
      "must be present exactly when the lease is closed",
    );
  }
  return frozen({
    nativeConversationLeaseId: parseA1CanonicalId(
      "nativeConversationLease",
      row.nativeConversationLeaseId,
      "nativeConversationLease.nativeConversationLeaseId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeConversationLease.collaborationServerId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeConversationLease.nativeBindingId",
    ),
    registrationAttemptId: parseA1CanonicalId(
      "registrationAttempt",
      row.registrationAttemptId,
      "nativeConversationLease.registrationAttemptId",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "nativeConversationLease.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "nativeConversationLease.coordinatorEpoch",
    ),
    protectedPortHandleId: parseA1CanonicalId(
      "protectedHandle",
      row.protectedPortHandleId,
      "nativeConversationLease.protectedPortHandleId",
    ),
    acquiredAtMs,
    closedAtMs,
    state,
  });
}

const LOCAL_ARTIFACT_KEYS = [
  "artifactId",
  "artifactKind",
  "canonicalSchemaId",
  "digestAlgorithm",
  "artifactDigest",
  "byteLength",
  "protectedStorageHandleId",
  "createdAtMs",
] as const;

export function parseLocalArtifactRecord(value: unknown): LocalArtifactRecord {
  const row = parseExactRecord(value, LOCAL_ARTIFACT_KEYS, "localArtifact");
  return frozen({
    artifactId: parseA1SafeId(row.artifactId, "localArtifact.artifactId"),
    artifactKind: parseNonEmptyString(row.artifactKind, "localArtifact.artifactKind"),
    canonicalSchemaId: parseNonEmptyString(
      row.canonicalSchemaId,
      "localArtifact.canonicalSchemaId",
    ),
    digestAlgorithm: parseLiteral(row.digestAlgorithm, "SHA-256", "localArtifact.digestAlgorithm"),
    artifactDigest: parseA1Digest(row.artifactDigest, "localArtifact.artifactDigest"),
    byteLength: parseNonNegativeSafeInteger(row.byteLength, "localArtifact.byteLength"),
    protectedStorageHandleId: parseA1CanonicalId(
      "protectedHandle",
      row.protectedStorageHandleId,
      "localArtifact.protectedStorageHandleId",
    ),
    createdAtMs: parseNonNegativeSafeInteger(row.createdAtMs, "localArtifact.createdAtMs"),
  });
}

const TERMINAL_TARGET_KEYS = [
  "kind",
  "descriptor",
  "terminalProjectRef",
  "nativeWorkspaceBindingId",
] as const;
const NESTED_TARGET_KEYS = [
  "kind",
  "nestedServerManagementBindingId",
  "targetServerId",
  "targetProjectId",
  "targetWorkspaceSelectorId",
] as const;

export function parseProjectTarget(value: unknown, field = "projectTarget"): ProjectTarget {
  if (typeof value !== "object" || value === null) {
    reject(field, "must be an object");
  }
  let isArray: boolean;
  let kindDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  } catch {
    reject(field, "could not be inspected safely");
  }
  if (isArray) {
    reject(field, "must be an object");
  }
  if (kindDescriptor === undefined || !Object.hasOwn(kindDescriptor, "value")) {
    reject(`${field}.kind`, "must be an own data property");
  }
  const kind = kindDescriptor.value as unknown;
  if (kind === "terminal_native") {
    const row = parseExactRecord(value, TERMINAL_TARGET_KEYS, field);
    return frozen({
      kind: parseLiteral(row.kind, "terminal_native", `${field}.kind`),
      descriptor: parseNativeEngineDescriptor(row.descriptor, `${field}.descriptor`),
      terminalProjectRef: parseA1SafeId(row.terminalProjectRef, `${field}.terminalProjectRef`),
      nativeWorkspaceBindingId: parseNullable(
        row.nativeWorkspaceBindingId,
        parseA1SafeId,
        `${field}.nativeWorkspaceBindingId`,
      ),
    });
  }
  if (kind === "nested_server") {
    const row = parseExactRecord(value, NESTED_TARGET_KEYS, field);
    return frozen({
      kind: parseLiteral(row.kind, "nested_server", `${field}.kind`),
      nestedServerManagementBindingId: parseA1SafeId(
        row.nestedServerManagementBindingId,
        `${field}.nestedServerManagementBindingId`,
      ),
      targetServerId: parseA1CanonicalId(
        "collaborationServer",
        row.targetServerId,
        `${field}.targetServerId`,
      ),
      targetProjectId: parseA1CanonicalId(
        "project",
        row.targetProjectId,
        `${field}.targetProjectId`,
      ),
      targetWorkspaceSelectorId: parseA1SafeId(
        row.targetWorkspaceSelectorId,
        `${field}.targetWorkspaceSelectorId`,
      ),
    });
  }
  reject(`${field}.kind`, "is not a selected value");
}

const PROJECT_TARGET_MAPPING_KEYS = [
  "projectTargetSelectorMappingId",
  "collaborationServerId",
  "projectId",
  "workspaceSelectorId",
  "target",
  "targetDigest",
  "mappingGeneration",
  "evidenceRef",
  "state",
] as const;

export function parseProjectTargetSelectorMappingRecord(
  value: unknown,
): ProjectTargetSelectorMappingRecord {
  const row = parseExactRecord(value, PROJECT_TARGET_MAPPING_KEYS, "projectTargetSelectorMapping");
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    row.collaborationServerId,
    "projectTargetSelectorMapping.collaborationServerId",
  );
  const target = parseProjectTarget(row.target, "projectTargetSelectorMapping.target");
  if (target.kind === "nested_server" && target.targetServerId === collaborationServerId) {
    reject(
      "projectTargetSelectorMapping.target.targetServerId",
      "must not create an immediate collaboration-server cycle",
    );
  }
  return frozen({
    projectTargetSelectorMappingId: parseA1CanonicalId(
      "projectTargetSelectorMapping",
      row.projectTargetSelectorMappingId,
      "projectTargetSelectorMapping.projectTargetSelectorMappingId",
    ),
    collaborationServerId,
    projectId: parseA1CanonicalId(
      "project",
      row.projectId,
      "projectTargetSelectorMapping.projectId",
    ),
    workspaceSelectorId: parseA1SafeId(
      row.workspaceSelectorId,
      "projectTargetSelectorMapping.workspaceSelectorId",
    ),
    target,
    targetDigest: parseA1Digest(row.targetDigest, "projectTargetSelectorMapping.targetDigest"),
    mappingGeneration: parsePositiveSafeInteger(
      row.mappingGeneration,
      "projectTargetSelectorMapping.mappingGeneration",
    ),
    evidenceRef: parseA1SafeId(row.evidenceRef, "projectTargetSelectorMapping.evidenceRef"),
    state: parseEnum(
      row.state,
      ["current", "superseded", "closed"] as const,
      "projectTargetSelectorMapping.state",
    ),
  });
}

const LOGICAL_CHAT_KEYS = [
  "logicalChatId",
  "collaborationServerId",
  "projectId",
  "state",
  "topologyGeneration",
  "currentInwardEdgeId",
  "currentNativeBindingId",
  "parentChatId",
  "nextViewerProjectionSeq",
] as const;

export function parseLogicalChatRecord(value: unknown): LogicalChatRecord {
  const row = parseExactRecord(value, LOGICAL_CHAT_KEYS, "logicalChat");
  const logicalChatId = parseA1CanonicalId(
    "logicalChat",
    row.logicalChatId,
    "logicalChat.logicalChatId",
  );
  const state = parseEnum(
    row.state,
    ["recovering", "ready", "quarantined", "closed"] as const,
    "logicalChat.state",
  );
  const currentInwardEdgeId = parseNullable(
    row.currentInwardEdgeId,
    parseA1SafeId,
    "logicalChat.currentInwardEdgeId",
  );
  const currentNativeBindingId = parseNullable(
    row.currentNativeBindingId,
    (_value, field) => parseA1CanonicalId("nativeBinding", _value, field),
    "logicalChat.currentNativeBindingId",
  );
  const parentChatId = parseNullable(
    row.parentChatId,
    (_value, field) => parseA1CanonicalId("logicalChat", _value, field),
    "logicalChat.parentChatId",
  );
  if (parentChatId === logicalChatId) {
    reject("logicalChat.parentChatId", "must name a different logical chat");
  }
  if (state === "ready" && currentInwardEdgeId === null) {
    reject("logicalChat.currentInwardEdgeId", "must be present before the chat becomes ready");
  }
  if (currentNativeBindingId !== null && currentInwardEdgeId === null) {
    reject(
      "logicalChat.currentNativeBindingId",
      "cannot be current without its terminal inward edge",
    );
  }
  return frozen({
    logicalChatId,
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "logicalChat.collaborationServerId",
    ),
    projectId: parseA1CanonicalId("project", row.projectId, "logicalChat.projectId"),
    state,
    topologyGeneration: parseNonNegativeSafeInteger(
      row.topologyGeneration,
      "logicalChat.topologyGeneration",
    ),
    currentInwardEdgeId,
    currentNativeBindingId,
    parentChatId,
    nextViewerProjectionSeq: parseNonNegativeSafeInteger(
      row.nextViewerProjectionSeq,
      "logicalChat.nextViewerProjectionSeq",
    ),
  });
}

export function parseNativeEngineDescriptor(
  value: unknown,
  field = "nativeEngineDescriptor",
): NativeEngineDescriptor {
  const row = parseExactRecord(value, ["product", "access"], field);
  const valid =
    (row.product === "claude-code" && (row.access === "native-rc" || row.access === "tmux")) ||
    (row.product === "codex" && row.access === "app-server") ||
    (row.product === "opencode" && row.access === "server");
  if (!valid) reject(field, "has an unsupported product/access combination");
  return frozen({
    product: row.product,
    access: row.access,
  } as NativeEngineDescriptor);
}

const NATIVE_BINDING_KEYS = [
  "nativeBindingId",
  "collaborationServerId",
  "logicalChatId",
  "descriptor",
  "projectId",
  "semanticConversationId",
  "currentBindingIncarnationId",
  "state",
] as const;

export function parseNativeBindingRecord(value: unknown): NativeBindingRecord {
  const row = parseExactRecord(value, NATIVE_BINDING_KEYS, "nativeBinding");
  const semanticConversationId = parseNullable(
    row.semanticConversationId,
    parseA1SafeId,
    "nativeBinding.semanticConversationId",
  );
  const currentBindingIncarnationId = parseNullable(
    row.currentBindingIncarnationId,
    parseA1SafeId,
    "nativeBinding.currentBindingIncarnationId",
  );
  const state = parseEnum(
    row.state,
    ["starting", "current", "superseded", "closed"] as const,
    "nativeBinding.state",
  );
  if ((semanticConversationId === null) !== (currentBindingIncarnationId === null)) {
    reject(
      "nativeBinding.nativeIdentity",
      "semantic conversation and incarnation must be resolved together",
    );
  }
  if (state === "starting" && semanticConversationId !== null) {
    reject("nativeBinding.nativeIdentity", "must remain unresolved while the binding is starting");
  }
  if (state === "current" && semanticConversationId === null) {
    reject("nativeBinding.nativeIdentity", "must be resolved before the binding is current");
  }
  return frozen({
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeBinding.nativeBindingId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeBinding.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeBinding.logicalChatId",
    ),
    descriptor: parseNativeEngineDescriptor(row.descriptor, "nativeBinding.descriptor"),
    projectId: parseA1CanonicalId("project", row.projectId, "nativeBinding.projectId"),
    semanticConversationId,
    currentBindingIncarnationId,
    state,
  });
}
