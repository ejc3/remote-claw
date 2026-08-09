import type { NativeEngineDescriptor } from "../native/adapter.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type Ed25519PublicKey,
  type Ed25519Signature,
  type InwardEdgeId,
  type LogicalChatId,
  type NativeBindingId,
  type NativeRuntimeId,
  type ProjectId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseEd25519Signature,
  parseMachineIdentityId,
  parseWardenLaunchNonce,
  type WardenLaunchNonce,
} from "./ids.js";
import { type ProtectedHandleRef, parseProtectedHandleRef } from "./protected.js";
import { parseNativeEngineDescriptor } from "./records.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
  parseNullable,
  parsePositiveSafeInteger,
  reject,
} from "./validation.js";

/**
 * Host-wide ownership of protected runtime state. This epoch is deliberately
 * distinct from every collaboration-server coordinator epoch.
 */
export interface RuntimeOwnerServiceLeaseRecord {
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly machineIdentityId: string;
  readonly runtimeOwnerServiceEpoch: number;
  readonly ownerInstanceId: A1SafeId;
  readonly ownerProcessStartIdentitySchemaId: string;
  readonly ownerProcessStartIdentityRef: A1SafeId;
  readonly ownerProcessStartIdentityDigest: A1Digest;
  readonly acquiredAtMs: number;
  readonly heartbeatDeadlineMs: number;
  readonly releasedAtMs: number | null;
  readonly state: "current" | "expired" | "released" | "superseded";
}

/**
 * Stable root of one supervised native-runtime lineage. The runtime ID is
 * derived once from the founding launch nonce/start identity; successor
 * incarnations advance the pointer without changing that root identity.
 */
export interface NativeRuntimeRecord {
  readonly runtimeId: NativeRuntimeId;
  readonly descriptor: NativeEngineDescriptor;
  readonly wardenLaunchNonce: WardenLaunchNonce;
  readonly initialStartIdentitySchemaId: string;
  readonly initialStartIdentityRef: A1SafeId;
  readonly initialStartIdentityDigest: A1Digest;
  readonly currentNativeIncarnation: number | null;
  readonly currentRuntimeOwnerAssignmentId: A1SafeId | null;
  readonly createdAtMs: number;
  readonly closedAtMs: number | null;
  readonly state: "current" | "closed";
}

/**
 * Provider-neutral process/daemon incarnation. Inference request namespaces
 * live in InferenceRuntimeBindingRecord rather than making every runtime an
 * inference connector.
 */
export interface NativeRuntimeIncarnationRecord {
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly descriptor: NativeEngineDescriptor;
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly startIdentitySchemaId: string;
  readonly startIdentityRef: A1SafeId;
  readonly startIdentityDigest: A1Digest;
  readonly startedAtMs: number;
  readonly closedAtMs: number | null;
  readonly state: "starting" | "current" | "draining" | "closed";
}

/**
 * Append-only owner assignment for one runtime incarnation. Takeover appends
 * a successor instead of rewriting the incarnation's creation owner.
 */
export interface RuntimeOwnerAssignmentRecord {
  readonly runtimeOwnerAssignmentId: A1SafeId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly assignmentGeneration: number;
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly assignedAtMs: number;
  readonly supersedesRuntimeOwnerAssignmentId: A1SafeId | null;
  readonly reason: "creation" | "takeover";
  readonly assignmentEvidenceSchemaId: string;
  readonly assignmentEvidenceRef: A1SafeId;
  readonly assignmentEvidenceDigest: A1Digest;
}

/**
 * Positive containment of one exact native incarnation. This is separate from
 * the successor incarnation so a failed or retried replacement cannot make a
 * merely fenced predecessor look unable to mutate.
 */
export interface NativeRuntimeContainmentRecord {
  readonly nativeRuntimeContainmentId: A1SafeId;
  readonly runtimeId: NativeRuntimeId;
  readonly predecessorNativeIncarnation: number;
  readonly successorNativeIncarnation: number | null;
  readonly kind: "replacement" | "termination";
  readonly evidenceSchemaId: string;
  readonly evidenceRef: A1SafeId;
  readonly evidenceDigest: A1Digest;
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly containedAtMs: number;
}

export interface LocalNativeConversationRecord {
  readonly localNativeConversationId: A1SafeId;
  readonly descriptor: NativeEngineDescriptor;
  readonly projectId: ProjectId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly semanticConversationId: A1SafeId | null;
  readonly parentLocalNativeConversationId: A1SafeId | null;
  readonly state: "unbound" | "open" | "closed";
}

export interface LocalNativeConversationTransitionRecord {
  readonly localTransitionId: A1SafeId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly localTransitionSeq: number;
  readonly kind: "discover" | "new" | "clear" | "fork" | "switch" | "archive" | "unarchive";
  readonly sourceLocalNativeConversationId: A1SafeId | null;
  readonly targetLocalNativeConversationId: A1SafeId;
  readonly observedSemanticConversationId: A1SafeId | null;
  readonly nativeEvidenceSchemaId: string;
  readonly nativeEvidenceRef: A1SafeId;
  readonly nativeEvidenceDigest: A1Digest;
  readonly observedAtMs: number;
}

export interface RuntimeOwnerIdentityKeyRecord {
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly keyGeneration: number;
  readonly algorithm: "Ed25519";
  readonly publicKey: Ed25519PublicKey;
  readonly signingKeyRef: ProtectedHandleRef<"signing_key"> | null;
  readonly nextSignerSequence: number;
  readonly localTrustEvidenceRef: A1SafeId;
  readonly localTrustEvidenceDigest: A1Digest;
  readonly state: "current" | "retired" | "revoked";
}

export const RUNTIME_OWNER_SIGNATURE_PURPOSES = Object.freeze([
  "native_root",
  "listener_registration_attestation",
  "runtime_isolation_attestation",
  "native_capability_snapshot",
  "native_tui_policy_snapshot",
  "opencode_native_store_attachment_attestation",
  "opencode_native_store_predecessor_stop_fence",
  "opencode_native_store_successor_exclusive_open",
] as const);

export type RuntimeOwnerSignaturePurpose = (typeof RUNTIME_OWNER_SIGNATURE_PURPOSES)[number];

export const RUNTIME_OWNER_SIGNATURE_SCHEMAS = Object.freeze({
  native_root: "remote-claw/native-root-certificate/v1",
  listener_registration_attestation: "remote-claw/native-listener-registration-attestation/v1",
  runtime_isolation_attestation: "remote-claw/native-runtime-isolation-attestation/v1",
  native_capability_snapshot: "remote-claw/native-capability-snapshot-attestation/v1",
  native_tui_policy_snapshot: "remote-claw/native-tui-policy-snapshot-attestation/v1",
  opencode_native_store_attachment_attestation:
    "remote-claw/opencode-native-store-attachment-attestation/v1",
  opencode_native_store_predecessor_stop_fence:
    "remote-claw/opencode-native-store-predecessor-stop-fence/v1",
  opencode_native_store_successor_exclusive_open:
    "remote-claw/opencode-native-store-successor-exclusive-open/v1",
} as const satisfies Readonly<Record<RuntimeOwnerSignaturePurpose, string>>);

export type RuntimeOwnerSignatureSchemaId =
  (typeof RUNTIME_OWNER_SIGNATURE_SCHEMAS)[RuntimeOwnerSignaturePurpose];

export interface RuntimeOwnerSignatureReservationRecord {
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly purpose: RuntimeOwnerSignaturePurpose;
  readonly canonicalPayloadSchemaId: RuntimeOwnerSignatureSchemaId | null;
  readonly canonicalPayloadRef: A1SafeId | null;
  readonly canonicalPayloadDigest: A1Digest | null;
  readonly signedRecordDigest: A1Digest | null;
  readonly signature: Ed25519Signature | null;
  readonly signedArtifactId: A1SafeId | null;
  readonly state: "reserved" | "bound" | "signed" | "aborted";
}

export interface RuntimeOwnerSignedRecordAcceptanceRecord {
  readonly runtimeId: NativeRuntimeId;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly signedRecordDigest: A1Digest;
  readonly acceptedAtMs: number;
}

export interface InferenceRuntimeBindingRecord {
  readonly inferenceRuntimeBindingId: A1SafeId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly facadeProtocolSchemaId: string;
  readonly nativeRequestNamespaceId: A1SafeId;
  readonly nativeRequestIdExtractionSchemaId: string;
  readonly nativeRequestIdUniquenessProofRef: A1SafeId;
  readonly nativeRequestIdUniquenessProofDigest: A1Digest;
  readonly canonicalProviderRequestSchemaId: string;
  readonly currentInferenceLeaseId: A1SafeId | null;
  readonly state: "current" | "superseded" | "closed";
}

/** The exact durable join from one chat binding to one native incarnation. */
export interface NativeBindingIncarnationRecord {
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly nativeBindingId: NativeBindingId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly semanticConversationId: A1SafeId;
  readonly createdAtMs: number;
  readonly closedAtMs: number | null;
  readonly state: "current" | "superseded" | "closed";
}

export interface NativeTransportAttachmentRecord {
  readonly attachmentId: A1SafeId;
  readonly nativeBindingId: NativeBindingId;
  readonly kind: "claude-inner-rc" | "app-server" | "server" | "tmux";
  readonly transportId: A1SafeId;
  readonly generation: number;
  readonly currentAttachmentLeaseId: A1SafeId | null;
  readonly resourceOwnership: "dedicated_runtime" | "shared_runtime";
  readonly createdAtMs: number;
  readonly closedAtMs: number | null;
  readonly state: "current" | "superseded" | "closed";
}

export interface NativeTransportLeaseRecord {
  readonly attachmentLeaseId: A1SafeId;
  readonly attachmentId: A1SafeId;
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly transportEpoch: number;
  readonly currentCapabilitySnapshotId: A1SafeId | null;
  readonly currentNativeClientIngressLeaseId: A1SafeId | null;
  readonly acquiredAtMs: number;
  readonly releasedAtMs: number | null;
  readonly state: "current" | "superseded" | "closed";
}

export interface NativeBindingRuntimeGateRecord {
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly nativeBindingId: NativeBindingId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly attachmentId: A1SafeId;
  readonly currentAttachmentLeaseId: A1SafeId | null;
  readonly phase: "starting" | "recovering" | "ready" | "draining" | "closed";
  readonly disconnectPolicy: "detach" | "terminate_when_idle";
  readonly gateGeneration: number;
  readonly updatedAtMs: number;
}

export interface InwardCollaborationEdgeRecord {
  readonly inwardEdgeId: InwardEdgeId;
  readonly representedServerId: CollaborationServerId;
  readonly representedLogicalChatId: LogicalChatId;
  readonly targetKind: "native-harness" | "remote-claw-server";
  readonly targetServerId: CollaborationServerId | null;
  readonly targetLogicalChatId: LogicalChatId | null;
  readonly targetNativeBindingId: NativeBindingId | null;
  readonly rootPathCertificateId: A1SafeId | null;
  readonly currentConnectionEpoch: number;
  readonly currentLiveLeaseId: A1SafeId | null;
  readonly currentCapabilitySnapshotId: A1SafeId | null;
  readonly state: "installing" | "installed" | "current" | "superseded" | "closed";
}

const RUNTIME_OWNER_LEASE_KEYS = [
  "runtimeOwnerServiceLeaseId",
  "machineIdentityId",
  "runtimeOwnerServiceEpoch",
  "ownerInstanceId",
  "ownerProcessStartIdentitySchemaId",
  "ownerProcessStartIdentityRef",
  "ownerProcessStartIdentityDigest",
  "acquiredAtMs",
  "heartbeatDeadlineMs",
  "releasedAtMs",
  "state",
] as const;

export function parseRuntimeOwnerServiceLeaseRecord(
  value: unknown,
): RuntimeOwnerServiceLeaseRecord {
  const row = parseExactRecord(value, RUNTIME_OWNER_LEASE_KEYS, "runtimeOwnerServiceLease");
  const acquiredAtMs = parseNonNegativeSafeInteger(
    row.acquiredAtMs,
    "runtimeOwnerServiceLease.acquiredAtMs",
  );
  const heartbeatDeadlineMs = parseNonNegativeSafeInteger(
    row.heartbeatDeadlineMs,
    "runtimeOwnerServiceLease.heartbeatDeadlineMs",
  );
  const releasedAtMs = parseNullable(
    row.releasedAtMs,
    parseNonNegativeSafeInteger,
    "runtimeOwnerServiceLease.releasedAtMs",
  );
  const state = parseEnum(
    row.state,
    ["current", "expired", "released", "superseded"] as const,
    "runtimeOwnerServiceLease.state",
  );
  if (heartbeatDeadlineMs <= acquiredAtMs) {
    reject("runtimeOwnerServiceLease.heartbeatDeadlineMs", "must be after acquisition");
  }
  if (releasedAtMs !== null && releasedAtMs < acquiredAtMs) {
    reject("runtimeOwnerServiceLease.releasedAtMs", "must not precede acquisition");
  }
  if (state !== "released" && releasedAtMs !== null) {
    reject("runtimeOwnerServiceLease.releasedAtMs", `must be null while the lease is ${state}`);
  }
  if (state === "released" && releasedAtMs === null) {
    reject("runtimeOwnerServiceLease.releasedAtMs", "must be present for a released lease");
  }
  if (releasedAtMs !== null && releasedAtMs >= heartbeatDeadlineMs) {
    reject("runtimeOwnerServiceLease.releasedAtMs", "must precede lease expiry");
  }
  return frozen({
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      "runtimeOwnerServiceLease.runtimeOwnerServiceLeaseId",
    ),
    machineIdentityId: parseMachineIdentityId(
      row.machineIdentityId,
      "runtimeOwnerServiceLease.machineIdentityId",
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      "runtimeOwnerServiceLease.runtimeOwnerServiceEpoch",
    ),
    ownerInstanceId: parseA1SafeId(row.ownerInstanceId, "runtimeOwnerServiceLease.ownerInstanceId"),
    ownerProcessStartIdentitySchemaId: parseNonEmptyString(
      row.ownerProcessStartIdentitySchemaId,
      "runtimeOwnerServiceLease.ownerProcessStartIdentitySchemaId",
    ),
    ownerProcessStartIdentityRef: parseA1SafeId(
      row.ownerProcessStartIdentityRef,
      "runtimeOwnerServiceLease.ownerProcessStartIdentityRef",
    ),
    ownerProcessStartIdentityDigest: parseA1Digest(
      row.ownerProcessStartIdentityDigest,
      "runtimeOwnerServiceLease.ownerProcessStartIdentityDigest",
    ),
    acquiredAtMs,
    heartbeatDeadlineMs,
    releasedAtMs,
    state,
  });
}

const NATIVE_RUNTIME_KEYS = [
  "runtimeId",
  "descriptor",
  "wardenLaunchNonce",
  "initialStartIdentitySchemaId",
  "initialStartIdentityRef",
  "initialStartIdentityDigest",
  "currentNativeIncarnation",
  "currentRuntimeOwnerAssignmentId",
  "createdAtMs",
  "closedAtMs",
  "state",
] as const;

export function parseNativeRuntimeRecord(value: unknown): NativeRuntimeRecord {
  const row = parseExactRecord(value, NATIVE_RUNTIME_KEYS, "nativeRuntime");
  const state = parseEnum(row.state, ["current", "closed"] as const, "nativeRuntime.state");
  const currentNativeIncarnation = parseNullable(
    row.currentNativeIncarnation,
    parsePositiveSafeInteger,
    "nativeRuntime.currentNativeIncarnation",
  );
  const currentRuntimeOwnerAssignmentId = parseNullable(
    row.currentRuntimeOwnerAssignmentId,
    parseA1SafeId,
    "nativeRuntime.currentRuntimeOwnerAssignmentId",
  );
  const createdAtMs = parseNonNegativeSafeInteger(row.createdAtMs, "nativeRuntime.createdAtMs");
  const closedAtMs = parseNullable(
    row.closedAtMs,
    parseNonNegativeSafeInteger,
    "nativeRuntime.closedAtMs",
  );
  if ((currentNativeIncarnation === null) !== (currentRuntimeOwnerAssignmentId === null)) {
    reject(
      "nativeRuntime.currentOwnership",
      "incarnation and owner-assignment pointers must either both be null or both be present",
    );
  }
  if (state === "current" && currentNativeIncarnation === null) {
    reject("nativeRuntime.currentOwnership", "must be present while the runtime is current");
  }
  if (state === "closed" && currentNativeIncarnation !== null) {
    reject("nativeRuntime.currentOwnership", "must be null after the runtime is closed");
  }
  if ((state === "closed") !== (closedAtMs !== null)) {
    reject("nativeRuntime.closedAtMs", "must be present exactly when the runtime is closed");
  }
  if (closedAtMs !== null && closedAtMs < createdAtMs) {
    reject("nativeRuntime.closedAtMs", "must not precede creation");
  }
  return frozen({
    runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, "nativeRuntime.runtimeId"),
    descriptor: parseNativeEngineDescriptor(row.descriptor, "nativeRuntime.descriptor"),
    wardenLaunchNonce: parseWardenLaunchNonce(
      row.wardenLaunchNonce,
      "nativeRuntime.wardenLaunchNonce",
    ),
    initialStartIdentitySchemaId: parseNonEmptyString(
      row.initialStartIdentitySchemaId,
      "nativeRuntime.initialStartIdentitySchemaId",
    ),
    initialStartIdentityRef: parseA1SafeId(
      row.initialStartIdentityRef,
      "nativeRuntime.initialStartIdentityRef",
    ),
    initialStartIdentityDigest: parseA1Digest(
      row.initialStartIdentityDigest,
      "nativeRuntime.initialStartIdentityDigest",
    ),
    currentNativeIncarnation,
    currentRuntimeOwnerAssignmentId,
    createdAtMs,
    closedAtMs,
    state,
  });
}

const RUNTIME_INCARNATION_KEYS = [
  "runtimeId",
  "nativeIncarnation",
  "descriptor",
  "runtimeOwnerServiceLeaseId",
  "runtimeOwnerServiceEpoch",
  "startIdentitySchemaId",
  "startIdentityRef",
  "startIdentityDigest",
  "startedAtMs",
  "closedAtMs",
  "state",
] as const;

export function parseNativeRuntimeIncarnationRecord(
  value: unknown,
): NativeRuntimeIncarnationRecord {
  const row = parseExactRecord(value, RUNTIME_INCARNATION_KEYS, "nativeRuntimeIncarnation");
  const startedAtMs = parseNonNegativeSafeInteger(
    row.startedAtMs,
    "nativeRuntimeIncarnation.startedAtMs",
  );
  const closedAtMs = parseNullable(
    row.closedAtMs,
    parseNonNegativeSafeInteger,
    "nativeRuntimeIncarnation.closedAtMs",
  );
  const state = parseEnum(
    row.state,
    ["starting", "current", "draining", "closed"] as const,
    "nativeRuntimeIncarnation.state",
  );
  if (closedAtMs !== null && closedAtMs < startedAtMs) {
    reject("nativeRuntimeIncarnation.closedAtMs", "must not precede start");
  }
  if ((state === "closed") !== (closedAtMs !== null)) {
    reject(
      "nativeRuntimeIncarnation.closedAtMs",
      "must be present exactly when the incarnation is closed",
    );
  }
  return frozen({
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeRuntimeIncarnation.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "nativeRuntimeIncarnation.nativeIncarnation",
    ),
    descriptor: parseNativeEngineDescriptor(row.descriptor, "nativeRuntimeIncarnation.descriptor"),
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      "nativeRuntimeIncarnation.runtimeOwnerServiceLeaseId",
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      "nativeRuntimeIncarnation.runtimeOwnerServiceEpoch",
    ),
    startIdentitySchemaId: parseNonEmptyString(
      row.startIdentitySchemaId,
      "nativeRuntimeIncarnation.startIdentitySchemaId",
    ),
    startIdentityRef: parseA1SafeId(
      row.startIdentityRef,
      "nativeRuntimeIncarnation.startIdentityRef",
    ),
    startIdentityDigest: parseA1Digest(
      row.startIdentityDigest,
      "nativeRuntimeIncarnation.startIdentityDigest",
    ),
    startedAtMs,
    closedAtMs,
    state,
  });
}

const RUNTIME_OWNER_ASSIGNMENT_KEYS = [
  "runtimeOwnerAssignmentId",
  "runtimeId",
  "nativeIncarnation",
  "assignmentGeneration",
  "runtimeOwnerServiceLeaseId",
  "runtimeOwnerServiceEpoch",
  "assignedAtMs",
  "supersedesRuntimeOwnerAssignmentId",
  "reason",
  "assignmentEvidenceSchemaId",
  "assignmentEvidenceRef",
  "assignmentEvidenceDigest",
] as const;

export function parseRuntimeOwnerAssignmentRecord(value: unknown): RuntimeOwnerAssignmentRecord {
  const row = parseExactRecord(value, RUNTIME_OWNER_ASSIGNMENT_KEYS, "runtimeOwnerAssignment");
  const assignmentGeneration = parsePositiveSafeInteger(
    row.assignmentGeneration,
    "runtimeOwnerAssignment.assignmentGeneration",
  );
  const supersedesRuntimeOwnerAssignmentId = parseNullable(
    row.supersedesRuntimeOwnerAssignmentId,
    parseA1SafeId,
    "runtimeOwnerAssignment.supersedesRuntimeOwnerAssignmentId",
  );
  const reason = parseEnum(
    row.reason,
    ["creation", "takeover"] as const,
    "runtimeOwnerAssignment.reason",
  );
  if (
    assignmentGeneration === 1
      ? supersedesRuntimeOwnerAssignmentId !== null || reason !== "creation"
      : supersedesRuntimeOwnerAssignmentId === null || reason !== "takeover"
  ) {
    reject(
      "runtimeOwnerAssignment.lineage",
      "generation one must be creation with no predecessor and later generations must be takeover with one predecessor",
    );
  }
  const runtimeOwnerAssignmentId = parseA1SafeId(
    row.runtimeOwnerAssignmentId,
    "runtimeOwnerAssignment.runtimeOwnerAssignmentId",
  );
  if (runtimeOwnerAssignmentId === supersedesRuntimeOwnerAssignmentId) {
    reject(
      "runtimeOwnerAssignment.supersedesRuntimeOwnerAssignmentId",
      "must not reference the assignment itself",
    );
  }
  return frozen({
    runtimeOwnerAssignmentId,
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "runtimeOwnerAssignment.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "runtimeOwnerAssignment.nativeIncarnation",
    ),
    assignmentGeneration,
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      "runtimeOwnerAssignment.runtimeOwnerServiceLeaseId",
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      "runtimeOwnerAssignment.runtimeOwnerServiceEpoch",
    ),
    assignedAtMs: parseNonNegativeSafeInteger(
      row.assignedAtMs,
      "runtimeOwnerAssignment.assignedAtMs",
    ),
    supersedesRuntimeOwnerAssignmentId,
    reason,
    assignmentEvidenceSchemaId: parseNonEmptyString(
      row.assignmentEvidenceSchemaId,
      "runtimeOwnerAssignment.assignmentEvidenceSchemaId",
    ),
    assignmentEvidenceRef: parseA1SafeId(
      row.assignmentEvidenceRef,
      "runtimeOwnerAssignment.assignmentEvidenceRef",
    ),
    assignmentEvidenceDigest: parseA1Digest(
      row.assignmentEvidenceDigest,
      "runtimeOwnerAssignment.assignmentEvidenceDigest",
    ),
  });
}

const NATIVE_RUNTIME_CONTAINMENT_KEYS = [
  "nativeRuntimeContainmentId",
  "runtimeId",
  "predecessorNativeIncarnation",
  "successorNativeIncarnation",
  "kind",
  "evidenceSchemaId",
  "evidenceRef",
  "evidenceDigest",
  "runtimeOwnerServiceLeaseId",
  "runtimeOwnerServiceEpoch",
  "containedAtMs",
] as const;

export function parseNativeRuntimeContainmentRecord(
  value: unknown,
): NativeRuntimeContainmentRecord {
  const row = parseExactRecord(value, NATIVE_RUNTIME_CONTAINMENT_KEYS, "nativeRuntimeContainment");
  const predecessorNativeIncarnation = parsePositiveSafeInteger(
    row.predecessorNativeIncarnation,
    "nativeRuntimeContainment.predecessorNativeIncarnation",
  );
  const successorNativeIncarnation = parseNullable(
    row.successorNativeIncarnation,
    parsePositiveSafeInteger,
    "nativeRuntimeContainment.successorNativeIncarnation",
  );
  const kind = parseEnum(
    row.kind,
    ["replacement", "termination"] as const,
    "nativeRuntimeContainment.kind",
  );
  if (
    kind === "replacement"
      ? successorNativeIncarnation !== predecessorNativeIncarnation + 1
      : successorNativeIncarnation !== null
  ) {
    reject(
      "nativeRuntimeContainment.successorNativeIncarnation",
      kind === "replacement"
        ? "must be exactly one greater than the predecessor for replacement"
        : "must be null for termination",
    );
  }
  return frozen({
    nativeRuntimeContainmentId: parseA1SafeId(
      row.nativeRuntimeContainmentId,
      "nativeRuntimeContainment.nativeRuntimeContainmentId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeRuntimeContainment.runtimeId",
    ),
    predecessorNativeIncarnation,
    successorNativeIncarnation,
    kind,
    evidenceSchemaId: parseNonEmptyString(
      row.evidenceSchemaId,
      "nativeRuntimeContainment.evidenceSchemaId",
    ),
    evidenceRef: parseA1SafeId(row.evidenceRef, "nativeRuntimeContainment.evidenceRef"),
    evidenceDigest: parseA1Digest(row.evidenceDigest, "nativeRuntimeContainment.evidenceDigest"),
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      "nativeRuntimeContainment.runtimeOwnerServiceLeaseId",
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      "nativeRuntimeContainment.runtimeOwnerServiceEpoch",
    ),
    containedAtMs: parseNonNegativeSafeInteger(
      row.containedAtMs,
      "nativeRuntimeContainment.containedAtMs",
    ),
  });
}

const LOCAL_NATIVE_CONVERSATION_KEYS = [
  "localNativeConversationId",
  "descriptor",
  "projectId",
  "runtimeId",
  "nativeIncarnation",
  "semanticConversationId",
  "parentLocalNativeConversationId",
  "state",
] as const;

export function parseLocalNativeConversationRecord(value: unknown): LocalNativeConversationRecord {
  const row = parseExactRecord(value, LOCAL_NATIVE_CONVERSATION_KEYS, "localNativeConversation");
  const localNativeConversationId = parseA1SafeId(
    row.localNativeConversationId,
    "localNativeConversation.localNativeConversationId",
  );
  const parentLocalNativeConversationId = parseNullable(
    row.parentLocalNativeConversationId,
    parseA1SafeId,
    "localNativeConversation.parentLocalNativeConversationId",
  );
  if (localNativeConversationId === parentLocalNativeConversationId) {
    reject(
      "localNativeConversation.parentLocalNativeConversationId",
      "must not reference the conversation itself",
    );
  }
  return frozen({
    localNativeConversationId,
    descriptor: parseNativeEngineDescriptor(row.descriptor, "localNativeConversation.descriptor"),
    projectId: parseA1CanonicalId("project", row.projectId, "localNativeConversation.projectId"),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "localNativeConversation.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "localNativeConversation.nativeIncarnation",
    ),
    semanticConversationId: parseNullable(
      row.semanticConversationId,
      parseA1SafeId,
      "localNativeConversation.semanticConversationId",
    ),
    parentLocalNativeConversationId,
    state: parseEnum(
      row.state,
      ["unbound", "open", "closed"] as const,
      "localNativeConversation.state",
    ),
  });
}

const LOCAL_NATIVE_CONVERSATION_TRANSITION_KEYS = [
  "localTransitionId",
  "runtimeId",
  "nativeIncarnation",
  "localTransitionSeq",
  "kind",
  "sourceLocalNativeConversationId",
  "targetLocalNativeConversationId",
  "observedSemanticConversationId",
  "nativeEvidenceSchemaId",
  "nativeEvidenceRef",
  "nativeEvidenceDigest",
  "observedAtMs",
] as const;

export function parseLocalNativeConversationTransitionRecord(
  value: unknown,
): LocalNativeConversationTransitionRecord {
  const row = parseExactRecord(
    value,
    LOCAL_NATIVE_CONVERSATION_TRANSITION_KEYS,
    "localNativeConversationTransition",
  );
  const kind = parseEnum(
    row.kind,
    ["discover", "new", "clear", "fork", "switch", "archive", "unarchive"] as const,
    "localNativeConversationTransition.kind",
  );
  const sourceLocalNativeConversationId = parseNullable(
    row.sourceLocalNativeConversationId,
    parseA1SafeId,
    "localNativeConversationTransition.sourceLocalNativeConversationId",
  );
  const targetLocalNativeConversationId = parseA1SafeId(
    row.targetLocalNativeConversationId,
    "localNativeConversationTransition.targetLocalNativeConversationId",
  );
  if ((kind === "discover" || kind === "new") && sourceLocalNativeConversationId !== null) {
    reject(
      "localNativeConversationTransition.sourceLocalNativeConversationId",
      `must be null for ${kind}`,
    );
  }
  if (
    (kind === "clear" || kind === "fork" || kind === "switch") &&
    (sourceLocalNativeConversationId === null ||
      sourceLocalNativeConversationId === targetLocalNativeConversationId)
  ) {
    reject(
      "localNativeConversationTransition.sourceLocalNativeConversationId",
      `must name a distinct source for ${kind}`,
    );
  }
  if (
    (kind === "archive" || kind === "unarchive") &&
    sourceLocalNativeConversationId !== targetLocalNativeConversationId
  ) {
    reject(
      "localNativeConversationTransition.sourceLocalNativeConversationId",
      `must equal the target for ${kind}`,
    );
  }
  return frozen({
    localTransitionId: parseA1SafeId(
      row.localTransitionId,
      "localNativeConversationTransition.localTransitionId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "localNativeConversationTransition.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "localNativeConversationTransition.nativeIncarnation",
    ),
    localTransitionSeq: parsePositiveSafeInteger(
      row.localTransitionSeq,
      "localNativeConversationTransition.localTransitionSeq",
    ),
    kind,
    sourceLocalNativeConversationId,
    targetLocalNativeConversationId,
    observedSemanticConversationId: parseNullable(
      row.observedSemanticConversationId,
      parseA1SafeId,
      "localNativeConversationTransition.observedSemanticConversationId",
    ),
    nativeEvidenceSchemaId: parseNonEmptyString(
      row.nativeEvidenceSchemaId,
      "localNativeConversationTransition.nativeEvidenceSchemaId",
    ),
    nativeEvidenceRef: parseA1SafeId(
      row.nativeEvidenceRef,
      "localNativeConversationTransition.nativeEvidenceRef",
    ),
    nativeEvidenceDigest: parseA1Digest(
      row.nativeEvidenceDigest,
      "localNativeConversationTransition.nativeEvidenceDigest",
    ),
    observedAtMs: parseNonNegativeSafeInteger(
      row.observedAtMs,
      "localNativeConversationTransition.observedAtMs",
    ),
  });
}

const RUNTIME_OWNER_IDENTITY_KEY_KEYS = [
  "runtimeId",
  "runtimeOwnerIdentityKeyId",
  "keyGeneration",
  "algorithm",
  "publicKey",
  "signingKeyRef",
  "nextSignerSequence",
  "localTrustEvidenceRef",
  "localTrustEvidenceDigest",
  "state",
] as const;

function parseNullableSigningKeyRef(
  value: unknown,
  field: string,
): ProtectedHandleRef<"signing_key"> | null {
  if (value === null) return null;
  const ref = parseProtectedHandleRef(value);
  if (ref.kind !== "signing_key") {
    reject(field, "must reference a protected signing_key handle");
  }
  return ref;
}

export function parseRuntimeOwnerIdentityKeyRecord(value: unknown): RuntimeOwnerIdentityKeyRecord {
  const row = parseExactRecord(value, RUNTIME_OWNER_IDENTITY_KEY_KEYS, "runtimeOwnerIdentityKey");
  const state = parseEnum(
    row.state,
    ["current", "retired", "revoked"] as const,
    "runtimeOwnerIdentityKey.state",
  );
  const signingKeyRef = parseNullableSigningKeyRef(
    row.signingKeyRef,
    "runtimeOwnerIdentityKey.signingKeyRef",
  );
  if ((state === "current") !== (signingKeyRef !== null)) {
    reject(
      "runtimeOwnerIdentityKey.signingKeyRef",
      "must be present exactly while the key is current",
    );
  }
  return frozen({
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "runtimeOwnerIdentityKey.runtimeId",
    ),
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      "runtimeOwnerIdentityKey.runtimeOwnerIdentityKeyId",
    ),
    keyGeneration: parsePositiveSafeInteger(
      row.keyGeneration,
      "runtimeOwnerIdentityKey.keyGeneration",
    ),
    algorithm: parseEnum(row.algorithm, ["Ed25519"] as const, "runtimeOwnerIdentityKey.algorithm"),
    publicKey: parseEd25519PublicKey(row.publicKey, "runtimeOwnerIdentityKey.publicKey"),
    signingKeyRef,
    nextSignerSequence: parseNonNegativeSafeInteger(
      row.nextSignerSequence,
      "runtimeOwnerIdentityKey.nextSignerSequence",
    ),
    localTrustEvidenceRef: parseA1SafeId(
      row.localTrustEvidenceRef,
      "runtimeOwnerIdentityKey.localTrustEvidenceRef",
    ),
    localTrustEvidenceDigest: parseA1Digest(
      row.localTrustEvidenceDigest,
      "runtimeOwnerIdentityKey.localTrustEvidenceDigest",
    ),
    state,
  });
}

const RUNTIME_OWNER_SIGNATURE_RESERVATION_KEYS = [
  "runtimeId",
  "runtimeOwnerIdentityKeyId",
  "runtimeOwnerKeyGeneration",
  "signerSequence",
  "purpose",
  "canonicalPayloadSchemaId",
  "canonicalPayloadRef",
  "canonicalPayloadDigest",
  "signedRecordDigest",
  "signature",
  "signedArtifactId",
  "state",
] as const;

export function parseRuntimeOwnerSignatureReservationRecord(
  value: unknown,
): RuntimeOwnerSignatureReservationRecord {
  const row = parseExactRecord(
    value,
    RUNTIME_OWNER_SIGNATURE_RESERVATION_KEYS,
    "runtimeOwnerSignatureReservation",
  );
  const purpose = parseEnum(
    row.purpose,
    RUNTIME_OWNER_SIGNATURE_PURPOSES,
    "runtimeOwnerSignatureReservation.purpose",
  );
  const state = parseEnum(
    row.state,
    ["reserved", "bound", "signed", "aborted"] as const,
    "runtimeOwnerSignatureReservation.state",
  );
  const canonicalPayloadSchemaId = parseNullable(
    row.canonicalPayloadSchemaId,
    parseNonEmptyString,
    "runtimeOwnerSignatureReservation.canonicalPayloadSchemaId",
  ) as RuntimeOwnerSignatureSchemaId | null;
  const canonicalPayloadRef = parseNullable(
    row.canonicalPayloadRef,
    parseA1SafeId,
    "runtimeOwnerSignatureReservation.canonicalPayloadRef",
  );
  const canonicalPayloadDigest = parseNullable(
    row.canonicalPayloadDigest,
    parseA1Digest,
    "runtimeOwnerSignatureReservation.canonicalPayloadDigest",
  );
  const signedRecordDigest = parseNullable(
    row.signedRecordDigest,
    parseA1Digest,
    "runtimeOwnerSignatureReservation.signedRecordDigest",
  );
  const signature = parseNullable(
    row.signature,
    parseEd25519Signature,
    "runtimeOwnerSignatureReservation.signature",
  );
  const signedArtifactId = parseNullable(
    row.signedArtifactId,
    parseA1SafeId,
    "runtimeOwnerSignatureReservation.signedArtifactId",
  );
  const hasBoundPayload =
    canonicalPayloadSchemaId !== null &&
    canonicalPayloadRef !== null &&
    canonicalPayloadDigest !== null;
  const hasSignedOutput =
    signedRecordDigest !== null && signature !== null && signedArtifactId !== null;
  const hasPartialBoundPayload =
    !hasBoundPayload &&
    (canonicalPayloadSchemaId !== null ||
      canonicalPayloadRef !== null ||
      canonicalPayloadDigest !== null);
  const hasPartialSignedOutput =
    !hasSignedOutput &&
    (signedRecordDigest !== null || signature !== null || signedArtifactId !== null);
  if (hasPartialBoundPayload || hasPartialSignedOutput) {
    reject(
      "runtimeOwnerSignatureReservation.payload",
      "bound payload and signed output fields must each be all null or all present",
    );
  }
  if ((state === "reserved" || state === "aborted") && (hasBoundPayload || hasSignedOutput)) {
    reject(
      "runtimeOwnerSignatureReservation.payload",
      `must remain unbound while the reservation is ${state}`,
    );
  }
  if (state === "bound" && (!hasBoundPayload || hasSignedOutput)) {
    reject(
      "runtimeOwnerSignatureReservation.payload",
      "must contain only the bound payload while the reservation is bound",
    );
  }
  if (state === "signed" && (!hasBoundPayload || !hasSignedOutput)) {
    reject(
      "runtimeOwnerSignatureReservation.payload",
      "must contain the bound payload and signed output while the reservation is signed",
    );
  }
  if (
    canonicalPayloadSchemaId !== null &&
    canonicalPayloadSchemaId !== RUNTIME_OWNER_SIGNATURE_SCHEMAS[purpose]
  ) {
    reject(
      "runtimeOwnerSignatureReservation.canonicalPayloadSchemaId",
      "must match the selected signature purpose",
    );
  }
  return frozen({
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "runtimeOwnerSignatureReservation.runtimeId",
    ),
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      "runtimeOwnerSignatureReservation.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: parsePositiveSafeInteger(
      row.runtimeOwnerKeyGeneration,
      "runtimeOwnerSignatureReservation.runtimeOwnerKeyGeneration",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "runtimeOwnerSignatureReservation.signerSequence",
    ),
    purpose,
    canonicalPayloadSchemaId,
    canonicalPayloadRef,
    canonicalPayloadDigest,
    signedRecordDigest,
    signature,
    signedArtifactId,
    state,
  });
}

const RUNTIME_OWNER_SIGNED_ACCEPTANCE_KEYS = [
  "runtimeId",
  "runtimeOwnerIdentityKeyId",
  "runtimeOwnerKeyGeneration",
  "signerSequence",
  "signedRecordDigest",
  "acceptedAtMs",
] as const;

export function parseRuntimeOwnerSignedRecordAcceptanceRecord(
  value: unknown,
): RuntimeOwnerSignedRecordAcceptanceRecord {
  const row = parseExactRecord(
    value,
    RUNTIME_OWNER_SIGNED_ACCEPTANCE_KEYS,
    "runtimeOwnerSignedRecordAcceptance",
  );
  return frozen({
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "runtimeOwnerSignedRecordAcceptance.runtimeId",
    ),
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      "runtimeOwnerSignedRecordAcceptance.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: parsePositiveSafeInteger(
      row.runtimeOwnerKeyGeneration,
      "runtimeOwnerSignedRecordAcceptance.runtimeOwnerKeyGeneration",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "runtimeOwnerSignedRecordAcceptance.signerSequence",
    ),
    signedRecordDigest: parseA1Digest(
      row.signedRecordDigest,
      "runtimeOwnerSignedRecordAcceptance.signedRecordDigest",
    ),
    acceptedAtMs: parseNonNegativeSafeInteger(
      row.acceptedAtMs,
      "runtimeOwnerSignedRecordAcceptance.acceptedAtMs",
    ),
  });
}

const INFERENCE_RUNTIME_BINDING_KEYS = [
  "inferenceRuntimeBindingId",
  "runtimeId",
  "nativeIncarnation",
  "facadeProtocolSchemaId",
  "nativeRequestNamespaceId",
  "nativeRequestIdExtractionSchemaId",
  "nativeRequestIdUniquenessProofRef",
  "nativeRequestIdUniquenessProofDigest",
  "canonicalProviderRequestSchemaId",
  "currentInferenceLeaseId",
  "state",
] as const;

export function parseInferenceRuntimeBindingRecord(value: unknown): InferenceRuntimeBindingRecord {
  const row = parseExactRecord(value, INFERENCE_RUNTIME_BINDING_KEYS, "inferenceRuntimeBinding");
  return frozen({
    inferenceRuntimeBindingId: parseA1SafeId(
      row.inferenceRuntimeBindingId,
      "inferenceRuntimeBinding.inferenceRuntimeBindingId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "inferenceRuntimeBinding.runtimeId",
    ),
    nativeIncarnation: parseNonNegativeSafeInteger(
      row.nativeIncarnation,
      "inferenceRuntimeBinding.nativeIncarnation",
    ),
    facadeProtocolSchemaId: parseNonEmptyString(
      row.facadeProtocolSchemaId,
      "inferenceRuntimeBinding.facadeProtocolSchemaId",
    ),
    nativeRequestNamespaceId: parseA1SafeId(
      row.nativeRequestNamespaceId,
      "inferenceRuntimeBinding.nativeRequestNamespaceId",
    ),
    nativeRequestIdExtractionSchemaId: parseNonEmptyString(
      row.nativeRequestIdExtractionSchemaId,
      "inferenceRuntimeBinding.nativeRequestIdExtractionSchemaId",
    ),
    nativeRequestIdUniquenessProofRef: parseA1SafeId(
      row.nativeRequestIdUniquenessProofRef,
      "inferenceRuntimeBinding.nativeRequestIdUniquenessProofRef",
    ),
    nativeRequestIdUniquenessProofDigest: parseA1Digest(
      row.nativeRequestIdUniquenessProofDigest,
      "inferenceRuntimeBinding.nativeRequestIdUniquenessProofDigest",
    ),
    canonicalProviderRequestSchemaId: parseNonEmptyString(
      row.canonicalProviderRequestSchemaId,
      "inferenceRuntimeBinding.canonicalProviderRequestSchemaId",
    ),
    currentInferenceLeaseId: parseNullable(
      row.currentInferenceLeaseId,
      parseA1SafeId,
      "inferenceRuntimeBinding.currentInferenceLeaseId",
    ),
    state: parseEnum(
      row.state,
      ["current", "superseded", "closed"] as const,
      "inferenceRuntimeBinding.state",
    ),
  });
}

const BINDING_INCARNATION_KEYS = [
  "nativeBindingIncarnationId",
  "collaborationServerId",
  "logicalChatId",
  "nativeBindingId",
  "runtimeId",
  "nativeIncarnation",
  "semanticConversationId",
  "createdAtMs",
  "closedAtMs",
  "state",
] as const;

export function parseNativeBindingIncarnationRecord(
  value: unknown,
): NativeBindingIncarnationRecord {
  const row = parseExactRecord(value, BINDING_INCARNATION_KEYS, "nativeBindingIncarnation");
  const createdAtMs = parseNonNegativeSafeInteger(
    row.createdAtMs,
    "nativeBindingIncarnation.createdAtMs",
  );
  const closedAtMs = parseNullable(
    row.closedAtMs,
    parseNonNegativeSafeInteger,
    "nativeBindingIncarnation.closedAtMs",
  );
  const state = parseEnum(
    row.state,
    ["current", "superseded", "closed"] as const,
    "nativeBindingIncarnation.state",
  );
  if (closedAtMs !== null && closedAtMs < createdAtMs) {
    reject("nativeBindingIncarnation.closedAtMs", "must not precede creation");
  }
  if ((state === "closed") !== (closedAtMs !== null)) {
    reject(
      "nativeBindingIncarnation.closedAtMs",
      "must be present exactly when the binding incarnation is closed",
    );
  }
  return frozen({
    nativeBindingIncarnationId: parseA1SafeId(
      row.nativeBindingIncarnationId,
      "nativeBindingIncarnation.nativeBindingIncarnationId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeBindingIncarnation.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeBindingIncarnation.logicalChatId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeBindingIncarnation.nativeBindingId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeBindingIncarnation.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "nativeBindingIncarnation.nativeIncarnation",
    ),
    semanticConversationId: parseA1SafeId(
      row.semanticConversationId,
      "nativeBindingIncarnation.semanticConversationId",
    ),
    createdAtMs,
    closedAtMs,
    state,
  });
}

const TRANSPORT_ATTACHMENT_KEYS = [
  "attachmentId",
  "nativeBindingId",
  "kind",
  "transportId",
  "generation",
  "currentAttachmentLeaseId",
  "resourceOwnership",
  "createdAtMs",
  "closedAtMs",
  "state",
] as const;

export function parseNativeTransportAttachmentRecord(
  value: unknown,
): NativeTransportAttachmentRecord {
  const row = parseExactRecord(value, TRANSPORT_ATTACHMENT_KEYS, "nativeTransportAttachment");
  const state = parseEnum(
    row.state,
    ["current", "superseded", "closed"] as const,
    "nativeTransportAttachment.state",
  );
  const currentAttachmentLeaseId = parseNullable(
    row.currentAttachmentLeaseId,
    parseA1SafeId,
    "nativeTransportAttachment.currentAttachmentLeaseId",
  );
  const createdAtMs = parseNonNegativeSafeInteger(
    row.createdAtMs,
    "nativeTransportAttachment.createdAtMs",
  );
  const closedAtMs = parseNullable(
    row.closedAtMs,
    parseNonNegativeSafeInteger,
    "nativeTransportAttachment.closedAtMs",
  );
  if (state !== "current" && currentAttachmentLeaseId !== null) {
    reject(
      "nativeTransportAttachment.currentAttachmentLeaseId",
      `must be null while the attachment is ${state}`,
    );
  }
  if ((state === "closed") !== (closedAtMs !== null)) {
    reject(
      "nativeTransportAttachment.closedAtMs",
      "must be present exactly when the attachment is closed",
    );
  }
  if (closedAtMs !== null && closedAtMs < createdAtMs) {
    reject("nativeTransportAttachment.closedAtMs", "must not precede creation");
  }
  return frozen({
    attachmentId: parseA1SafeId(row.attachmentId, "nativeTransportAttachment.attachmentId"),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeTransportAttachment.nativeBindingId",
    ),
    kind: parseEnum(
      row.kind,
      ["claude-inner-rc", "app-server", "server", "tmux"] as const,
      "nativeTransportAttachment.kind",
    ),
    transportId: parseA1SafeId(row.transportId, "nativeTransportAttachment.transportId"),
    generation: parsePositiveSafeInteger(row.generation, "nativeTransportAttachment.generation"),
    currentAttachmentLeaseId,
    resourceOwnership: parseEnum(
      row.resourceOwnership,
      ["dedicated_runtime", "shared_runtime"] as const,
      "nativeTransportAttachment.resourceOwnership",
    ),
    createdAtMs,
    closedAtMs,
    state,
  });
}

const TRANSPORT_LEASE_KEYS = [
  "attachmentLeaseId",
  "attachmentId",
  "nativeBindingIncarnationId",
  "runtimeId",
  "nativeIncarnation",
  "runtimeOwnerServiceLeaseId",
  "runtimeOwnerServiceEpoch",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "transportEpoch",
  "currentCapabilitySnapshotId",
  "currentNativeClientIngressLeaseId",
  "acquiredAtMs",
  "releasedAtMs",
  "state",
] as const;

export function parseNativeTransportLeaseRecord(value: unknown): NativeTransportLeaseRecord {
  const row = parseExactRecord(value, TRANSPORT_LEASE_KEYS, "nativeTransportLease");
  const state = parseEnum(
    row.state,
    ["current", "superseded", "closed"] as const,
    "nativeTransportLease.state",
  );
  const acquiredAtMs = parseNonNegativeSafeInteger(
    row.acquiredAtMs,
    "nativeTransportLease.acquiredAtMs",
  );
  const releasedAtMs = parseNullable(
    row.releasedAtMs,
    parseNonNegativeSafeInteger,
    "nativeTransportLease.releasedAtMs",
  );
  if ((state === "current") !== (releasedAtMs === null)) {
    reject("nativeTransportLease.releasedAtMs", "must be null exactly while the lease is current");
  }
  if (releasedAtMs !== null && releasedAtMs < acquiredAtMs) {
    reject("nativeTransportLease.releasedAtMs", "must not precede acquisition");
  }
  return frozen({
    attachmentLeaseId: parseA1SafeId(
      row.attachmentLeaseId,
      "nativeTransportLease.attachmentLeaseId",
    ),
    attachmentId: parseA1SafeId(row.attachmentId, "nativeTransportLease.attachmentId"),
    nativeBindingIncarnationId: parseA1SafeId(
      row.nativeBindingIncarnationId,
      "nativeTransportLease.nativeBindingIncarnationId",
    ),
    runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, "nativeTransportLease.runtimeId"),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "nativeTransportLease.nativeIncarnation",
    ),
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      "nativeTransportLease.runtimeOwnerServiceLeaseId",
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      "nativeTransportLease.runtimeOwnerServiceEpoch",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "nativeTransportLease.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "nativeTransportLease.coordinatorEpoch",
    ),
    transportEpoch: parsePositiveSafeInteger(
      row.transportEpoch,
      "nativeTransportLease.transportEpoch",
    ),
    currentCapabilitySnapshotId: parseNullable(
      row.currentCapabilitySnapshotId,
      parseA1SafeId,
      "nativeTransportLease.currentCapabilitySnapshotId",
    ),
    currentNativeClientIngressLeaseId: parseNullable(
      row.currentNativeClientIngressLeaseId,
      parseA1SafeId,
      "nativeTransportLease.currentNativeClientIngressLeaseId",
    ),
    acquiredAtMs,
    releasedAtMs,
    state,
  });
}

const NATIVE_BINDING_RUNTIME_GATE_KEYS = [
  "collaborationServerId",
  "logicalChatId",
  "nativeBindingId",
  "runtimeId",
  "nativeIncarnation",
  "nativeBindingIncarnationId",
  "attachmentId",
  "currentAttachmentLeaseId",
  "phase",
  "disconnectPolicy",
  "gateGeneration",
  "updatedAtMs",
] as const;

export function parseNativeBindingRuntimeGateRecord(
  value: unknown,
): NativeBindingRuntimeGateRecord {
  const row = parseExactRecord(value, NATIVE_BINDING_RUNTIME_GATE_KEYS, "nativeBindingRuntimeGate");
  const phase = parseEnum(
    row.phase,
    ["starting", "recovering", "ready", "draining", "closed"] as const,
    "nativeBindingRuntimeGate.phase",
  );
  const currentAttachmentLeaseId = parseNullable(
    row.currentAttachmentLeaseId,
    parseA1SafeId,
    "nativeBindingRuntimeGate.currentAttachmentLeaseId",
  );
  if (phase === "ready" && currentAttachmentLeaseId === null) {
    reject(
      "nativeBindingRuntimeGate.currentAttachmentLeaseId",
      "must be present while the gate is ready",
    );
  }
  if (phase === "closed" && currentAttachmentLeaseId !== null) {
    reject(
      "nativeBindingRuntimeGate.currentAttachmentLeaseId",
      "must be null while the gate is closed",
    );
  }
  return frozen({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeBindingRuntimeGate.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeBindingRuntimeGate.logicalChatId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeBindingRuntimeGate.nativeBindingId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeBindingRuntimeGate.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "nativeBindingRuntimeGate.nativeIncarnation",
    ),
    nativeBindingIncarnationId: parseA1SafeId(
      row.nativeBindingIncarnationId,
      "nativeBindingRuntimeGate.nativeBindingIncarnationId",
    ),
    attachmentId: parseA1SafeId(row.attachmentId, "nativeBindingRuntimeGate.attachmentId"),
    currentAttachmentLeaseId,
    phase,
    disconnectPolicy: parseEnum(
      row.disconnectPolicy,
      ["detach", "terminate_when_idle"] as const,
      "nativeBindingRuntimeGate.disconnectPolicy",
    ),
    gateGeneration: parsePositiveSafeInteger(
      row.gateGeneration,
      "nativeBindingRuntimeGate.gateGeneration",
    ),
    updatedAtMs: parseNonNegativeSafeInteger(
      row.updatedAtMs,
      "nativeBindingRuntimeGate.updatedAtMs",
    ),
  });
}

const INWARD_EDGE_KEYS = [
  "inwardEdgeId",
  "representedServerId",
  "representedLogicalChatId",
  "targetKind",
  "targetServerId",
  "targetLogicalChatId",
  "targetNativeBindingId",
  "rootPathCertificateId",
  "currentConnectionEpoch",
  "currentLiveLeaseId",
  "currentCapabilitySnapshotId",
  "state",
] as const;

export function parseInwardCollaborationEdgeRecord(value: unknown): InwardCollaborationEdgeRecord {
  const row = parseExactRecord(value, INWARD_EDGE_KEYS, "inwardCollaborationEdge");
  const representedServerId = parseA1CanonicalId(
    "collaborationServer",
    row.representedServerId,
    "inwardCollaborationEdge.representedServerId",
  );
  const targetKind = parseEnum(
    row.targetKind,
    ["native-harness", "remote-claw-server"] as const,
    "inwardCollaborationEdge.targetKind",
  );
  const targetServerId = parseNullable(
    row.targetServerId,
    (_value, field) => parseA1CanonicalId("collaborationServer", _value, field),
    "inwardCollaborationEdge.targetServerId",
  );
  const targetLogicalChatId = parseNullable(
    row.targetLogicalChatId,
    (_value, field) => parseA1CanonicalId("logicalChat", _value, field),
    "inwardCollaborationEdge.targetLogicalChatId",
  );
  const targetNativeBindingId = parseNullable(
    row.targetNativeBindingId,
    (_value, field) => parseA1CanonicalId("nativeBinding", _value, field),
    "inwardCollaborationEdge.targetNativeBindingId",
  );
  if (
    targetKind === "native-harness"
      ? targetNativeBindingId === null || targetServerId !== null || targetLogicalChatId !== null
      : targetNativeBindingId !== null || targetServerId === null || targetLogicalChatId === null
  ) {
    reject(
      "inwardCollaborationEdge.target",
      "must contain exactly the identifiers selected by targetKind",
    );
  }
  if (targetKind === "remote-claw-server" && targetServerId === representedServerId) {
    reject(
      "inwardCollaborationEdge.targetServerId",
      "must not create an immediate collaboration-server cycle",
    );
  }
  const state = parseEnum(
    row.state,
    ["installing", "installed", "current", "superseded", "closed"] as const,
    "inwardCollaborationEdge.state",
  );
  const rootPathCertificateId = parseNullable(
    row.rootPathCertificateId,
    parseA1SafeId,
    "inwardCollaborationEdge.rootPathCertificateId",
  );
  if ((state === "installing") !== (rootPathCertificateId === null)) {
    reject(
      "inwardCollaborationEdge.rootPathCertificateId",
      "must be null only while the edge is installing",
    );
  }
  const currentConnectionEpoch = parseNonNegativeSafeInteger(
    row.currentConnectionEpoch,
    "inwardCollaborationEdge.currentConnectionEpoch",
  );
  const currentLiveLeaseId = parseNullable(
    row.currentLiveLeaseId,
    parseA1SafeId,
    "inwardCollaborationEdge.currentLiveLeaseId",
  );
  const currentCapabilitySnapshotId = parseNullable(
    row.currentCapabilitySnapshotId,
    parseA1SafeId,
    "inwardCollaborationEdge.currentCapabilitySnapshotId",
  );
  if (
    state === "installing" &&
    (currentConnectionEpoch !== 0 ||
      currentLiveLeaseId !== null ||
      currentCapabilitySnapshotId !== null)
  ) {
    reject(
      "inwardCollaborationEdge.currentConnection",
      "must remain at epoch zero with null live-lease and capability pointers while installing",
    );
  }
  if (
    targetKind === "native-harness" &&
    (currentConnectionEpoch !== 0 ||
      currentLiveLeaseId !== null ||
      currentCapabilitySnapshotId !== null)
  ) {
    reject(
      "inwardCollaborationEdge.currentConnection",
      "native-harness edges do not use the remote-server live connection",
    );
  }
  if (targetKind === "remote-claw-server") {
    if ((currentLiveLeaseId === null) !== (currentCapabilitySnapshotId === null)) {
      reject(
        "inwardCollaborationEdge.currentConnection",
        "live lease and capability snapshot must either both be null or both be present",
      );
    }
    if (currentLiveLeaseId !== null && currentConnectionEpoch === 0) {
      reject(
        "inwardCollaborationEdge.currentConnectionEpoch",
        "must be positive when a live lease is installed",
      );
    }
    if (state === "current" && currentLiveLeaseId === null) {
      reject(
        "inwardCollaborationEdge.currentConnection",
        "must be installed before the edge becomes current",
      );
    }
  }
  return frozen({
    inwardEdgeId: parseA1CanonicalId(
      "inwardEdge",
      row.inwardEdgeId,
      "inwardCollaborationEdge.inwardEdgeId",
    ),
    representedServerId,
    representedLogicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.representedLogicalChatId,
      "inwardCollaborationEdge.representedLogicalChatId",
    ),
    targetKind,
    targetServerId,
    targetLogicalChatId,
    targetNativeBindingId,
    rootPathCertificateId,
    currentConnectionEpoch,
    currentLiveLeaseId,
    currentCapabilitySnapshotId,
    state,
  });
}
