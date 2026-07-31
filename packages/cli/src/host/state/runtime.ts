import type { NativeEngineDescriptor } from "../native/adapter.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type LogicalChatId,
  type NativeBindingId,
  type NativeRuntimeId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
} from "./ids.js";
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
  readonly acquiredAtMs: number;
  readonly heartbeatDeadlineMs: number;
  readonly releasedAtMs: number | null;
  readonly state: "current" | "expired" | "released" | "superseded";
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
  readonly state: "current" | "superseded" | "closed";
}

export interface NativeTransportLeaseRecord {
  readonly attachmentLeaseId: A1SafeId;
  readonly attachmentId: A1SafeId;
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly transportEpoch: number;
  readonly currentCapabilitySnapshotId: A1SafeId | null;
  readonly currentNativeClientIngressLeaseId: A1SafeId | null;
  readonly state: "current" | "superseded" | "closed";
}

export interface InwardCollaborationEdgeRecord {
  readonly inwardEdgeId: A1SafeId;
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
  if (heartbeatDeadlineMs < acquiredAtMs) {
    reject("runtimeOwnerServiceLease.heartbeatDeadlineMs", "must not precede acquisition");
  }
  if (releasedAtMs !== null && releasedAtMs < acquiredAtMs) {
    reject("runtimeOwnerServiceLease.releasedAtMs", "must not precede acquisition");
  }
  if (state === "current" && releasedAtMs !== null) {
    reject("runtimeOwnerServiceLease.releasedAtMs", "must be null while the lease is current");
  }
  if (state === "released" && releasedAtMs === null) {
    reject("runtimeOwnerServiceLease.releasedAtMs", "must be present for a released lease");
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
    acquiredAtMs,
    heartbeatDeadlineMs,
    releasedAtMs,
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
    nativeIncarnation: parseNonNegativeSafeInteger(
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
    nativeIncarnation: parseNonNegativeSafeInteger(
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
  "state",
] as const;

export function parseNativeTransportAttachmentRecord(
  value: unknown,
): NativeTransportAttachmentRecord {
  const row = parseExactRecord(value, TRANSPORT_ATTACHMENT_KEYS, "nativeTransportAttachment");
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
    state: parseEnum(
      row.state,
      ["current", "superseded", "closed"] as const,
      "nativeTransportAttachment.state",
    ),
  });
}

const TRANSPORT_LEASE_KEYS = [
  "attachmentLeaseId",
  "attachmentId",
  "nativeBindingIncarnationId",
  "runtimeId",
  "nativeIncarnation",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "transportEpoch",
  "currentCapabilitySnapshotId",
  "currentNativeClientIngressLeaseId",
  "state",
] as const;

export function parseNativeTransportLeaseRecord(value: unknown): NativeTransportLeaseRecord {
  const row = parseExactRecord(value, TRANSPORT_LEASE_KEYS, "nativeTransportLease");
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
    nativeIncarnation: parseNonNegativeSafeInteger(
      row.nativeIncarnation,
      "nativeTransportLease.nativeIncarnation",
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
    state: parseEnum(
      row.state,
      ["current", "superseded", "closed"] as const,
      "nativeTransportLease.state",
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
    inwardEdgeId: parseA1SafeId(row.inwardEdgeId, "inwardCollaborationEdge.inwardEdgeId"),
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
