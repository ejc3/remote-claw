import { createHash } from "node:crypto";
import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  timingSafeEqual,
} from "@remote-claw/clawsec";
import {
  DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
  type DurableProjectSelection,
  NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
  NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
  NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
  NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
  verifyDurableProjectSelectionEvidence,
  verifyNativeConversationCapabilitiesEvidence,
  verifyNativeConversationRefEvidence,
  verifyNativeEngineDescriptorEvidence,
  verifyNativeRegistrationMetadataEvidence,
} from "../native/evidence.js";
import { createProtectedArtifactTransactionOperations } from "./artifacts.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  HostStateContractError,
  type NativeBindingId,
  type NativeConversationLeaseId,
  type NativeRuntimeId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
  type RegistrationAttemptId,
} from "./ids.js";
import {
  type CoordinatorLeaseFence,
  NATIVE_REGISTRATION_CAPABILITIES_SCHEMA_ID,
  type NativeConversationLeaseRecord,
  type NativeRegistrationOperationKind,
  type NativeRegistrationOperationRecord,
  type NativeRegistrationPublicationRecord,
  parseCoordinatorLeaseFence,
  parseNativeConversationLeaseRecord,
  parseNativeRegistrationOperationRecord,
  parseNativeRegistrationPublicationRecord,
} from "./records.js";

export type { NativeRegistrationOperationKind } from "./records.js";

import type {
  HostStateRepositorySqlTransaction,
  HostStateRepositorySqlValue,
  HostStateRepositoryTransactionExecutor,
} from "./repository.js";
import type {
  RuntimeOwnerOperationEvidence,
  RuntimeOwnerServiceFence,
} from "./runtime-repository.js";
import {
  frozen,
  parseExactRecord,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
  parseNullable,
  parsePositiveSafeInteger,
  type UnknownRecord,
} from "./validation.js";

export interface NativeRegistrationRepositoryOptions {
  readonly nowMs?: () => number;
}

export const NATIVE_REGISTRATION_OPERATION_SCHEMA_IDS = Object.freeze({
  open: "remote-claw/native-registration-open/v1",
  bind: "remote-claw/native-registration-bind/v1",
  publish: "remote-claw/native-registration-publish/v1",
  ready: "remote-claw/native-registration-ready/v1",
  recover: "remote-claw/native-registration-recover/v1",
  drain: "remote-claw/native-registration-drain/v1",
  close: "remote-claw/native-registration-close/v1",
  reattach: "remote-claw/native-registration-reattach/v1",
} as const);

export interface OpenNativeConversationLeaseRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly registrationAttemptId: RegistrationAttemptId;
  readonly nativeBindingId: NativeBindingId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly protectedPortHandleId: ProtectedHandleId;
}

export interface BindNativeConversationLeaseRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly nativeBindingIncarnationId: A1SafeId;
  readonly attachmentLeaseId: A1SafeId;
}

export interface PublishNativeRegistrationRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly nativeRegistrationPublicationId: A1SafeId;
  readonly publicationGeneration: number;
  readonly metadataSchemaId: string;
  readonly metadataRef: ProtectedHandleId;
  readonly metadataDigest: A1Digest;
  readonly capabilitiesRef: ProtectedHandleId;
  readonly capabilitiesDigest: A1Digest;
}

export interface TransitionNativeConversationLeaseRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly expectedGateGeneration: number;
}

export interface ReadyNativeConversationLeaseRequest
  extends TransitionNativeConversationLeaseRequest {
  readonly expectedPublicationId: A1SafeId;
}

export interface CloseNativeConversationLeaseRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly expectedGateGeneration: number | null;
}

export interface ReattachNativeConversationLeaseRequest {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
  /** Required when the predecessor is still open; proves its forced close. */
  readonly predecessorCloseOperation: RuntimeOwnerOperationEvidence;
  readonly operation: RuntimeOwnerOperationEvidence;
  readonly predecessorNativeConversationLeaseId: NativeConversationLeaseId;
  readonly nativeConversationLeaseId: NativeConversationLeaseId;
  readonly protectedPortHandleId: ProtectedHandleId;
  /** Must be present exactly when a bound predecessor's owner/coordinator fence changed. */
  readonly successorAttachmentLeaseId: A1SafeId | null;
  readonly expectedGateGeneration: number | null;
}

export interface NativeRegistrationOperationInputByKind {
  readonly open: Omit<OpenNativeConversationLeaseRequest, "operation">;
  readonly bind: Omit<BindNativeConversationLeaseRequest, "operation">;
  readonly publish: Omit<PublishNativeRegistrationRequest, "operation">;
  readonly ready: Omit<ReadyNativeConversationLeaseRequest, "operation">;
  readonly recover: Omit<TransitionNativeConversationLeaseRequest, "operation">;
  readonly drain: Omit<TransitionNativeConversationLeaseRequest, "operation">;
  readonly close: Omit<CloseNativeConversationLeaseRequest, "operation">;
  readonly reattach: Omit<ReattachNativeConversationLeaseRequest, "operation">;
}

export interface NativeRegistrationOperationRequestByKind {
  readonly open: OpenNativeConversationLeaseRequest;
  readonly bind: BindNativeConversationLeaseRequest;
  readonly publish: PublishNativeRegistrationRequest;
  readonly ready: ReadyNativeConversationLeaseRequest;
  readonly recover: TransitionNativeConversationLeaseRequest;
  readonly drain: TransitionNativeConversationLeaseRequest;
  readonly close: CloseNativeConversationLeaseRequest;
  readonly reattach: ReattachNativeConversationLeaseRequest;
}

export interface NativeConversationLeaseMutationResult {
  readonly lease: NativeConversationLeaseRecord;
  readonly operation: NativeRegistrationOperationRecord;
  readonly replayed: boolean;
}

export interface PublishNativeRegistrationResult extends NativeConversationLeaseMutationResult {
  readonly publication: NativeRegistrationPublicationRecord;
}

export interface ReattachNativeConversationLeaseResult
  extends NativeConversationLeaseMutationResult {
  readonly predecessor: NativeConversationLeaseRecord;
  readonly predecessorCloseOperation: NativeRegistrationOperationRecord;
  readonly attachmentLeaseId: A1SafeId | null;
}

export interface NativeRegistrationInventory {
  readonly leases: readonly NativeConversationLeaseRecord[];
  readonly publications: readonly NativeRegistrationPublicationRecord[];
  readonly operations: readonly NativeRegistrationOperationRecord[];
}

export interface NativeRegistrationOperationReconciliation {
  readonly operation: NativeRegistrationOperationRecord;
  readonly lease: NativeConversationLeaseRecord;
  /** Resulting gate generation for an operation that advances the gate; otherwise null. */
  readonly gateGeneration: number | null;
}

export interface NativeRegistrationRepositoryOperations {
  open(request: OpenNativeConversationLeaseRequest): NativeConversationLeaseMutationResult;
  bind(request: BindNativeConversationLeaseRequest): NativeConversationLeaseMutationResult;
  publish(request: PublishNativeRegistrationRequest): PublishNativeRegistrationResult;
  ready(request: ReadyNativeConversationLeaseRequest): NativeConversationLeaseMutationResult;
  recover(request: TransitionNativeConversationLeaseRequest): NativeConversationLeaseMutationResult;
  drain(request: TransitionNativeConversationLeaseRequest): NativeConversationLeaseMutationResult;
  close(request: CloseNativeConversationLeaseRequest): NativeConversationLeaseMutationResult;
  reattach(request: ReattachNativeConversationLeaseRequest): ReattachNativeConversationLeaseResult;
  reconcileOperation<K extends NativeRegistrationOperationKind>(
    kind: K,
    request: NativeRegistrationOperationRequestByKind[K],
  ): NativeRegistrationOperationReconciliation | null;
  readLease(
    nativeConversationLeaseId: NativeConversationLeaseId,
  ): NativeConversationLeaseRecord | null;
  readOperation(operationId: A1SafeId): NativeRegistrationOperationRecord | null;
  readInventory(): NativeRegistrationInventory;
}

export class NativeRegistrationRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`native registration repository conflict: ${message}`);
    this.name = "NativeRegistrationRepositoryConflictError";
  }
}

export class NativeRegistrationStaleOwnerError extends Error {
  constructor() {
    super("native registration repository stale owner: service fence is not current and unexpired");
    this.name = "NativeRegistrationStaleOwnerError";
  }
}

export class NativeRegistrationStaleCoordinatorError extends Error {
  constructor() {
    super(
      "native registration repository stale coordinator: lease fence is not current and unexpired",
    );
    this.name = "NativeRegistrationStaleCoordinatorError";
  }
}

export class NativeRegistrationRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`native registration repository persistence failed: ${message}`, options);
    this.name = "NativeRegistrationRepositoryPersistenceError";
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
const OPEN_KEYS = [
  "fence",
  "coordinatorFence",
  "operation",
  "nativeConversationLeaseId",
  "registrationAttemptId",
  "nativeBindingId",
  "runtimeId",
  "nativeIncarnation",
  "protectedPortHandleId",
] as const;
const BIND_KEYS = [
  "fence",
  "coordinatorFence",
  "operation",
  "nativeConversationLeaseId",
  "nativeBindingIncarnationId",
  "attachmentLeaseId",
] as const;
const PUBLISH_KEYS = [
  "fence",
  "coordinatorFence",
  "operation",
  "nativeConversationLeaseId",
  "nativeRegistrationPublicationId",
  "publicationGeneration",
  "metadataSchemaId",
  "metadataRef",
  "metadataDigest",
  "capabilitiesRef",
  "capabilitiesDigest",
] as const;
const TRANSITION_KEYS = [
  "fence",
  "coordinatorFence",
  "operation",
  "nativeConversationLeaseId",
  "expectedGateGeneration",
] as const;
const READY_KEYS = [...TRANSITION_KEYS, "expectedPublicationId"] as const;
const REATTACH_KEYS = [
  "fence",
  "coordinatorFence",
  "predecessorCloseOperation",
  "operation",
  "predecessorNativeConversationLeaseId",
  "nativeConversationLeaseId",
  "protectedPortHandleId",
  "successorAttachmentLeaseId",
  "expectedGateGeneration",
] as const;

function parseOperation(value: unknown, field: string): RuntimeOwnerOperationEvidence {
  const row = parseExactRecord(value, OPERATION_KEYS, field);
  return frozen({
    operationId: parseA1SafeId(row.operationId, `${field}.operationId`),
    operationSchemaId: parseNonEmptyString(row.operationSchemaId, `${field}.operationSchemaId`),
    operationDigest: parseA1Digest(row.operationDigest, `${field}.operationDigest`),
  });
}

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

function parseCommonLeaseId(value: unknown, field: string): NativeConversationLeaseId {
  return parseA1CanonicalId("nativeConversationLease", value, field);
}

function parseOpenRequest(value: unknown): OpenNativeConversationLeaseRequest {
  const row = parseExactRecord(value, OPEN_KEYS, "nativeRegistration.open");
  return frozen({
    fence: parseOwnerFence(row.fence, "nativeRegistration.open.fence"),
    coordinatorFence: parseCoordinatorLeaseFence(row.coordinatorFence),
    operation: parseOperation(row.operation, "nativeRegistration.open.operation"),
    nativeConversationLeaseId: parseCommonLeaseId(
      row.nativeConversationLeaseId,
      "nativeRegistration.open.nativeConversationLeaseId",
    ),
    registrationAttemptId: parseA1CanonicalId(
      "registrationAttempt",
      row.registrationAttemptId,
      "nativeRegistration.open.registrationAttemptId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeRegistration.open.nativeBindingId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeRegistration.open.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "nativeRegistration.open.nativeIncarnation",
    ),
    protectedPortHandleId: parseA1CanonicalId(
      "protectedHandle",
      row.protectedPortHandleId,
      "nativeRegistration.open.protectedPortHandleId",
    ),
  });
}

function parseBindRequest(value: unknown): BindNativeConversationLeaseRequest {
  const row = parseExactRecord(value, BIND_KEYS, "nativeRegistration.bind");
  return frozen({
    fence: parseOwnerFence(row.fence, "nativeRegistration.bind.fence"),
    coordinatorFence: parseCoordinatorLeaseFence(row.coordinatorFence),
    operation: parseOperation(row.operation, "nativeRegistration.bind.operation"),
    nativeConversationLeaseId: parseCommonLeaseId(
      row.nativeConversationLeaseId,
      "nativeRegistration.bind.nativeConversationLeaseId",
    ),
    nativeBindingIncarnationId: parseA1SafeId(
      row.nativeBindingIncarnationId,
      "nativeRegistration.bind.nativeBindingIncarnationId",
    ),
    attachmentLeaseId: parseA1SafeId(
      row.attachmentLeaseId,
      "nativeRegistration.bind.attachmentLeaseId",
    ),
  });
}

function parsePublishRequest(value: unknown): PublishNativeRegistrationRequest {
  const row = parseExactRecord(value, PUBLISH_KEYS, "nativeRegistration.publish");
  return frozen({
    fence: parseOwnerFence(row.fence, "nativeRegistration.publish.fence"),
    coordinatorFence: parseCoordinatorLeaseFence(row.coordinatorFence),
    operation: parseOperation(row.operation, "nativeRegistration.publish.operation"),
    nativeConversationLeaseId: parseCommonLeaseId(
      row.nativeConversationLeaseId,
      "nativeRegistration.publish.nativeConversationLeaseId",
    ),
    nativeRegistrationPublicationId: parseA1SafeId(
      row.nativeRegistrationPublicationId,
      "nativeRegistration.publish.nativeRegistrationPublicationId",
    ),
    publicationGeneration: parsePositiveSafeInteger(
      row.publicationGeneration,
      "nativeRegistration.publish.publicationGeneration",
    ),
    metadataSchemaId: parseNonEmptyString(
      row.metadataSchemaId,
      "nativeRegistration.publish.metadataSchemaId",
    ),
    metadataRef: parseA1CanonicalId(
      "protectedHandle",
      row.metadataRef,
      "nativeRegistration.publish.metadataRef",
    ),
    metadataDigest: parseA1Digest(row.metadataDigest, "nativeRegistration.publish.metadataDigest"),
    capabilitiesRef: parseA1CanonicalId(
      "protectedHandle",
      row.capabilitiesRef,
      "nativeRegistration.publish.capabilitiesRef",
    ),
    capabilitiesDigest: parseA1Digest(
      row.capabilitiesDigest,
      "nativeRegistration.publish.capabilitiesDigest",
    ),
  });
}

function parseTransitionRequest(
  value: unknown,
  field: string,
): TransitionNativeConversationLeaseRequest {
  const row = parseExactRecord(value, TRANSITION_KEYS, field);
  return frozen({
    fence: parseOwnerFence(row.fence, `${field}.fence`),
    coordinatorFence: parseCoordinatorLeaseFence(row.coordinatorFence),
    operation: parseOperation(row.operation, `${field}.operation`),
    nativeConversationLeaseId: parseCommonLeaseId(
      row.nativeConversationLeaseId,
      `${field}.nativeConversationLeaseId`,
    ),
    expectedGateGeneration: parsePositiveSafeInteger(
      row.expectedGateGeneration,
      `${field}.expectedGateGeneration`,
    ),
  });
}

function parseReadyRequest(value: unknown): ReadyNativeConversationLeaseRequest {
  const row = parseExactRecord(value, READY_KEYS, "nativeRegistration.ready");
  const common = parseTransitionRequest(
    {
      fence: row.fence,
      coordinatorFence: row.coordinatorFence,
      operation: row.operation,
      nativeConversationLeaseId: row.nativeConversationLeaseId,
      expectedGateGeneration: row.expectedGateGeneration,
    },
    "nativeRegistration.ready",
  );
  return frozen({
    ...common,
    expectedPublicationId: parseA1SafeId(
      row.expectedPublicationId,
      "nativeRegistration.ready.expectedPublicationId",
    ),
  });
}

function parseCloseRequest(value: unknown): CloseNativeConversationLeaseRequest {
  const row = parseExactRecord(value, TRANSITION_KEYS, "nativeRegistration.close");
  return frozen({
    fence: parseOwnerFence(row.fence, "nativeRegistration.close.fence"),
    coordinatorFence: parseCoordinatorLeaseFence(row.coordinatorFence),
    operation: parseOperation(row.operation, "nativeRegistration.close.operation"),
    nativeConversationLeaseId: parseCommonLeaseId(
      row.nativeConversationLeaseId,
      "nativeRegistration.close.nativeConversationLeaseId",
    ),
    expectedGateGeneration: parseNullable(
      row.expectedGateGeneration,
      parsePositiveSafeInteger,
      "nativeRegistration.close.expectedGateGeneration",
    ),
  });
}

function parseReattachRequest(value: unknown): ReattachNativeConversationLeaseRequest {
  const row = parseExactRecord(value, REATTACH_KEYS, "nativeRegistration.reattach");
  return frozen({
    fence: parseOwnerFence(row.fence, "nativeRegistration.reattach.fence"),
    coordinatorFence: parseCoordinatorLeaseFence(row.coordinatorFence),
    predecessorCloseOperation: parseOperation(
      row.predecessorCloseOperation,
      "nativeRegistration.reattach.predecessorCloseOperation",
    ),
    operation: parseOperation(row.operation, "nativeRegistration.reattach.operation"),
    predecessorNativeConversationLeaseId: parseCommonLeaseId(
      row.predecessorNativeConversationLeaseId,
      "nativeRegistration.reattach.predecessorNativeConversationLeaseId",
    ),
    nativeConversationLeaseId: parseCommonLeaseId(
      row.nativeConversationLeaseId,
      "nativeRegistration.reattach.nativeConversationLeaseId",
    ),
    protectedPortHandleId: parseA1CanonicalId(
      "protectedHandle",
      row.protectedPortHandleId,
      "nativeRegistration.reattach.protectedPortHandleId",
    ),
    successorAttachmentLeaseId: parseNullable(
      row.successorAttachmentLeaseId,
      parseA1SafeId,
      "nativeRegistration.reattach.successorAttachmentLeaseId",
    ),
    expectedGateGeneration: parseNullable(
      row.expectedGateGeneration,
      parsePositiveSafeInteger,
      "nativeRegistration.reattach.expectedGateGeneration",
    ),
  });
}

function parseRegistrationOperationRequest<K extends NativeRegistrationOperationKind>(
  kind: K,
  value: unknown,
): NativeRegistrationOperationRequestByKind[K] {
  let parsed:
    | OpenNativeConversationLeaseRequest
    | BindNativeConversationLeaseRequest
    | PublishNativeRegistrationRequest
    | ReadyNativeConversationLeaseRequest
    | TransitionNativeConversationLeaseRequest
    | CloseNativeConversationLeaseRequest
    | ReattachNativeConversationLeaseRequest;
  switch (kind) {
    case "open":
      parsed = parseOpenRequest(value);
      break;
    case "bind":
      parsed = parseBindRequest(value);
      break;
    case "publish":
      parsed = parsePublishRequest(value);
      break;
    case "ready":
      parsed = parseReadyRequest(value);
      break;
    case "recover":
      parsed = parseTransitionRequest(value, "nativeRegistration.reconcile.recover");
      break;
    case "drain":
      parsed = parseTransitionRequest(value, "nativeRegistration.reconcile.drain");
      break;
    case "close":
      parsed = parseCloseRequest(value);
      break;
    case "reattach":
      parsed = parseReattachRequest(value);
      break;
  }
  return parsed as NativeRegistrationOperationRequestByKind[K];
}

function writeDigest(writer: CanonicalWriter, value: A1Digest): void {
  writer.bytes(base64urlDecode(value));
}

function writeOwnerFence(writer: CanonicalWriter, fence: RuntimeOwnerServiceFence): void {
  writer.str(fence.runtimeOwnerServiceLeaseId);
  writer.uint(fence.runtimeOwnerServiceEpoch);
  writer.str(fence.ownerInstanceId);
  writer.str(fence.ownerProcessStartIdentitySchemaId);
  writer.str(fence.ownerProcessStartIdentityRef);
  writeDigest(writer, fence.ownerProcessStartIdentityDigest);
}

function writeCoordinatorFence(writer: CanonicalWriter, fence: CoordinatorLeaseFence): void {
  writer.str(fence.collaborationServerId);
  writer.str(fence.coordinatorLeaseId);
  writer.uint(fence.coordinatorEpoch);
}

function writeEmbeddedOperation(
  writer: CanonicalWriter,
  operation: RuntimeOwnerOperationEvidence,
): void {
  writer.str(operation.operationId);
  writer.str(operation.operationSchemaId);
  writeDigest(writer, operation.operationDigest);
}

function canonicalRegistrationOperationDigest<K extends NativeRegistrationOperationKind>(
  kind: K,
  operationId: A1SafeId,
  request: NativeRegistrationOperationInputByKind[K],
): A1Digest {
  const writer = new CanonicalWriter();
  writer.str(NATIVE_REGISTRATION_OPERATION_SCHEMA_IDS[kind]);
  writer.str(operationId);
  writeOwnerFence(writer, request.fence);
  writeCoordinatorFence(writer, request.coordinatorFence);
  switch (kind) {
    case "open": {
      const value = request as NativeRegistrationOperationInputByKind["open"];
      writer.str(value.nativeConversationLeaseId);
      writer.str(value.registrationAttemptId);
      writer.str(value.nativeBindingId);
      writer.str(value.runtimeId);
      writer.uint(value.nativeIncarnation);
      writer.str(value.protectedPortHandleId);
      break;
    }
    case "bind": {
      const value = request as NativeRegistrationOperationInputByKind["bind"];
      writer.str(value.nativeConversationLeaseId);
      writer.str(value.nativeBindingIncarnationId);
      writer.str(value.attachmentLeaseId);
      break;
    }
    case "publish": {
      const value = request as NativeRegistrationOperationInputByKind["publish"];
      writer.str(value.nativeConversationLeaseId);
      writer.str(value.nativeRegistrationPublicationId);
      writer.uint(value.publicationGeneration);
      writer.str(value.metadataSchemaId);
      writer.str(value.metadataRef);
      writeDigest(writer, value.metadataDigest);
      writer.str(value.capabilitiesRef);
      writeDigest(writer, value.capabilitiesDigest);
      break;
    }
    case "ready": {
      const value = request as NativeRegistrationOperationInputByKind["ready"];
      writer.str(value.nativeConversationLeaseId);
      writer.uint(value.expectedGateGeneration);
      writer.str(value.expectedPublicationId);
      break;
    }
    case "recover":
    case "drain": {
      const value = request as NativeRegistrationOperationInputByKind["recover"];
      writer.str(value.nativeConversationLeaseId);
      writer.uint(value.expectedGateGeneration);
      break;
    }
    case "close": {
      const value = request as NativeRegistrationOperationInputByKind["close"];
      writer.str(value.nativeConversationLeaseId);
      if (value.expectedGateGeneration === null) {
        writer.optionalBytes(null);
      } else {
        const nested = new CanonicalWriter();
        nested.uint(value.expectedGateGeneration);
        writer.optionalBytes(nested.finish());
      }
      break;
    }
    case "reattach": {
      const value = request as NativeRegistrationOperationInputByKind["reattach"];
      writeEmbeddedOperation(writer, value.predecessorCloseOperation);
      writer.str(value.predecessorNativeConversationLeaseId);
      writer.str(value.nativeConversationLeaseId);
      writer.str(value.protectedPortHandleId);
      writer.optionalStr(value.successorAttachmentLeaseId);
      if (value.expectedGateGeneration === null) {
        writer.optionalBytes(null);
      } else {
        const nested = new CanonicalWriter();
        nested.uint(value.expectedGateGeneration);
        writer.optionalBytes(nested.finish());
      }
      break;
    }
  }
  return parseA1Digest(base64urlEncode(createHash("sha256").update(writer.finish()).digest()));
}

export function createNativeRegistrationOperationEvidence<
  K extends NativeRegistrationOperationKind,
>(
  kind: K,
  operationId: A1SafeId,
  request: NativeRegistrationOperationInputByKind[K],
): RuntimeOwnerOperationEvidence {
  const parsedOperationId = parseA1SafeId(
    operationId,
    "createNativeRegistrationOperationEvidence.operationId",
  );
  return frozen({
    operationId: parsedOperationId,
    operationSchemaId: NATIVE_REGISTRATION_OPERATION_SCHEMA_IDS[kind],
    operationDigest: canonicalRegistrationOperationDigest(kind, parsedOperationId, request),
  });
}

function withoutOperation<T extends { readonly operation: RuntimeOwnerOperationEvidence }>(
  request: T,
): Omit<T, "operation"> {
  const { operation: _operation, ...input } = request;
  return input;
}

function verifyRegistrationOperationContract<K extends NativeRegistrationOperationKind>(
  kind: K,
  request: NativeRegistrationOperationInputByKind[K] & {
    readonly operation: RuntimeOwnerOperationEvidence;
  },
): void {
  const expectedSchemaId = NATIVE_REGISTRATION_OPERATION_SCHEMA_IDS[kind];
  const expectedDigest = canonicalRegistrationOperationDigest(
    kind,
    request.operation.operationId,
    withoutOperation(request) as unknown as NativeRegistrationOperationInputByKind[K],
  );
  if (
    request.operation.operationSchemaId !== expectedSchemaId ||
    !sameDigest(request.operation.operationDigest, expectedDigest)
  ) {
    throw new HostStateContractError(
      `nativeRegistration.${kind}.operation must bind every request field using ${expectedSchemaId}`,
    );
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
      error instanceof NativeRegistrationRepositoryConflictError ||
      error instanceof NativeRegistrationStaleOwnerError ||
      error instanceof NativeRegistrationStaleCoordinatorError ||
      error instanceof NativeRegistrationRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new NativeRegistrationRepositoryPersistenceError("read operation did not complete", {
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
      throw new NativeRegistrationRepositoryPersistenceError(
        "inventory requires a multi-row SQL transaction",
      );
    }
    const rows = transaction.all(sql, parameters);
    if (!Array.isArray(rows)) {
      throw new NativeRegistrationRepositoryPersistenceError("multi-row read returned a non-array");
    }
    return rows;
  } catch (error) {
    if (error instanceof NativeRegistrationRepositoryPersistenceError) throw error;
    throw new NativeRegistrationRepositoryPersistenceError("multi-row read did not complete", {
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
      throw new NativeRegistrationRepositoryPersistenceError(
        "write returned an invalid change count",
      );
    }
    return numeric;
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof NativeRegistrationRepositoryConflictError ||
      error instanceof NativeRegistrationStaleOwnerError ||
      error instanceof NativeRegistrationStaleCoordinatorError ||
      error instanceof NativeRegistrationRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new NativeRegistrationRepositoryPersistenceError("write operation did not complete", {
      cause: error,
    });
  }
}

function runExactlyOne(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
  effect: string,
): void {
  if (sqlRun(transaction, sql, parameters) !== 1) {
    throw new NativeRegistrationRepositoryPersistenceError(
      `${effect} did not change exactly one row`,
    );
  }
}

function rawRow(value: unknown, keys: readonly string[], field: string): UnknownRecord {
  try {
    return parseExactRecord(value, keys, field);
  } catch (error) {
    throw new NativeRegistrationRepositoryPersistenceError(`${field} row is invalid`, {
      cause: error,
    });
  }
}

function persisted<T>(field: string, parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof NativeRegistrationRepositoryPersistenceError) throw error;
    throw new NativeRegistrationRepositoryPersistenceError(`${field} row is invalid`, {
      cause: error,
    });
  }
}

function sameDigest(left: A1Digest, right: A1Digest): boolean {
  return timingSafeEqual(base64urlDecode(left), base64urlDecode(right));
}

function checkedIncrement(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new NativeRegistrationRepositoryConflictError(`${field} is exhausted`);
  }
  return value + 1;
}

function trustedNow(nowMs: () => number): number {
  return parseNonNegativeSafeInteger(nowMs(), "nativeRegistration.nowMs");
}

const LEASE_ROW_KEYS = [
  "native_conversation_lease_id",
  "collaboration_server_id",
  "logical_chat_id",
  "native_binding_id",
  "registration_attempt_id",
  "runtime_id",
  "native_incarnation",
  "native_binding_incarnation_id",
  "attachment_lease_id",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "coordinator_lease_id",
  "coordinator_epoch",
  "protected_port_handle_id",
  "lease_generation",
  "supersedes_native_conversation_lease_id",
  "current_publication_id",
  "next_operation_sequence",
  "acquired_at_ms",
  "updated_at_ms",
  "closed_at_ms",
  "state",
] as const;

const PUBLICATION_ROW_KEYS = [
  "native_registration_publication_id",
  "native_conversation_lease_id",
  "native_binding_id",
  "runtime_id",
  "native_incarnation",
  "native_binding_incarnation_id",
  "attachment_lease_id",
  "publication_generation",
  "metadata_schema_id",
  "metadata_ref",
  "metadata_digest",
  "capabilities_schema_id",
  "capabilities_ref",
  "capabilities_digest",
  "published_at_ms",
  "state",
] as const;

const REGISTRATION_OPERATION_ROW_KEYS = [
  "operation_id",
  "operation_sequence",
  "kind",
  "operation_schema_id",
  "operation_digest",
  "native_conversation_lease_id",
  "native_binding_id",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "coordinator_lease_id",
  "coordinator_epoch",
  "committed_at_ms",
] as const;

function leaseFromRow(value: unknown): NativeConversationLeaseRecord {
  const row = rawRow(value, LEASE_ROW_KEYS, "nativeConversationLease");
  return persisted("nativeConversationLease", () =>
    parseNativeConversationLeaseRecord({
      nativeConversationLeaseId: row.native_conversation_lease_id,
      collaborationServerId: row.collaboration_server_id,
      logicalChatId: row.logical_chat_id,
      nativeBindingId: row.native_binding_id,
      registrationAttemptId: row.registration_attempt_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      nativeBindingIncarnationId: row.native_binding_incarnation_id,
      attachmentLeaseId: row.attachment_lease_id,
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      coordinatorLeaseId: row.coordinator_lease_id,
      coordinatorEpoch: row.coordinator_epoch,
      protectedPortHandleId: row.protected_port_handle_id,
      leaseGeneration: row.lease_generation,
      supersedesNativeConversationLeaseId: row.supersedes_native_conversation_lease_id,
      currentPublicationId: row.current_publication_id,
      nextOperationSequence: row.next_operation_sequence,
      acquiredAtMs: row.acquired_at_ms,
      updatedAtMs: row.updated_at_ms,
      closedAtMs: row.closed_at_ms,
      state: row.state,
    }),
  );
}

function publicationFromRow(value: unknown): NativeRegistrationPublicationRecord {
  const row = rawRow(value, PUBLICATION_ROW_KEYS, "nativeRegistrationPublication");
  return persisted("nativeRegistrationPublication", () =>
    parseNativeRegistrationPublicationRecord({
      nativeRegistrationPublicationId: row.native_registration_publication_id,
      nativeConversationLeaseId: row.native_conversation_lease_id,
      nativeBindingId: row.native_binding_id,
      runtimeId: row.runtime_id,
      nativeIncarnation: row.native_incarnation,
      nativeBindingIncarnationId: row.native_binding_incarnation_id,
      attachmentLeaseId: row.attachment_lease_id,
      publicationGeneration: row.publication_generation,
      metadataSchemaId: row.metadata_schema_id,
      metadataRef: row.metadata_ref,
      metadataDigest: row.metadata_digest,
      capabilitiesSchemaId: row.capabilities_schema_id,
      capabilitiesRef: row.capabilities_ref,
      capabilitiesDigest: row.capabilities_digest,
      publishedAtMs: row.published_at_ms,
      state: row.state,
    }),
  );
}

function operationFromRow(value: unknown): NativeRegistrationOperationRecord {
  const row = rawRow(value, REGISTRATION_OPERATION_ROW_KEYS, "nativeRegistrationOperation");
  return persisted("nativeRegistrationOperation", () =>
    parseNativeRegistrationOperationRecord({
      operationId: row.operation_id,
      operationSequence: row.operation_sequence,
      kind: row.kind,
      operationSchemaId: row.operation_schema_id,
      operationDigest: row.operation_digest,
      nativeConversationLeaseId: row.native_conversation_lease_id,
      nativeBindingId: row.native_binding_id,
      runtimeOwnerServiceLeaseId: row.runtime_owner_service_lease_id,
      runtimeOwnerServiceEpoch: row.runtime_owner_service_epoch,
      coordinatorLeaseId: row.coordinator_lease_id,
      coordinatorEpoch: row.coordinator_epoch,
      committedAtMs: row.committed_at_ms,
    }),
  );
}

function selectColumns(columns: readonly string[]): string {
  return columns.join(", ");
}

const SELECT_LEASE = `SELECT ${selectColumns(LEASE_ROW_KEYS)} FROM native_conversation_leases
WHERE native_conversation_lease_id = ? LIMIT 1`;
const SELECT_PUBLICATION = `SELECT ${selectColumns(PUBLICATION_ROW_KEYS)}
FROM native_registration_publications WHERE native_registration_publication_id = ? LIMIT 1`;
const SELECT_OPERATION = `SELECT ${selectColumns(REGISTRATION_OPERATION_ROW_KEYS)}
FROM native_registration_operations WHERE operation_id = ? LIMIT 1`;

function findLease(
  transaction: HostStateRepositorySqlTransaction,
  id: NativeConversationLeaseId,
): NativeConversationLeaseRecord | null {
  const row = sqlGet(transaction, SELECT_LEASE, [id]);
  return row === undefined ? null : leaseFromRow(row);
}

function findPublication(
  transaction: HostStateRepositorySqlTransaction,
  id: A1SafeId,
): NativeRegistrationPublicationRecord | null {
  const row = sqlGet(transaction, SELECT_PUBLICATION, [id]);
  return row === undefined ? null : publicationFromRow(row);
}

function retainedPublicationAllowsLiveReattach(
  transaction: HostStateRepositorySqlTransaction,
  lease: NativeConversationLeaseRecord,
): boolean | null {
  if (lease.currentPublicationId === null) return null;
  const publication = findPublication(transaction, lease.currentPublicationId);
  if (
    publication === null ||
    publication.nativeConversationLeaseId !== lease.nativeConversationLeaseId ||
    publication.nativeBindingId !== lease.nativeBindingId ||
    publication.runtimeId !== lease.runtimeId ||
    publication.nativeIncarnation !== lease.nativeIncarnation ||
    publication.nativeBindingIncarnationId !== lease.nativeBindingIncarnationId ||
    publication.attachmentLeaseId !== lease.attachmentLeaseId ||
    publication.state !== (lease.state === "closed" ? "superseded" : "current")
  ) {
    throw new NativeRegistrationRepositoryPersistenceError(
      "retained publication does not match its conversation lease",
    );
  }
  try {
    return verifyNativeConversationCapabilitiesEvidence(
      readArtifact(
        transaction,
        "native_binding",
        lease.nativeBindingId,
        publication.capabilitiesRef,
        NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
        publication.capabilitiesDigest,
      ),
      publication.capabilitiesDigest,
    ).value.liveReattach;
  } catch (error) {
    if (error instanceof NativeRegistrationRepositoryPersistenceError) throw error;
    throw new NativeRegistrationRepositoryPersistenceError(
      "retained publication capabilities evidence is invalid",
      { cause: error },
    );
  }
}

function findOperation(
  transaction: HostStateRepositorySqlTransaction,
  id: A1SafeId,
): NativeRegistrationOperationRecord | null {
  const row = sqlGet(transaction, SELECT_OPERATION, [id]);
  return row === undefined ? null : operationFromRow(row);
}

function assertCallablePortHandleAvailable(
  transaction: HostStateRepositorySqlTransaction,
  protectedPortHandleId: ProtectedHandleId,
): void {
  const occupied = sqlGet(
    transaction,
    `SELECT protected_handle_id FROM protected_artifacts WHERE protected_handle_id = ?
     UNION ALL
     SELECT protected_handle_id FROM runtime_owner_private_keys WHERE protected_handle_id = ?
     UNION ALL
     SELECT protected_port_handle_id AS protected_handle_id
       FROM native_conversation_leases WHERE protected_port_handle_id = ?
     LIMIT 1`,
    [protectedPortHandleId, protectedPortHandleId, protectedPortHandleId],
  );
  if (occupied !== undefined) {
    throw new NativeRegistrationRepositoryConflictError(
      "callable-port protected handle is already allocated",
    );
  }
}

interface ReservationGraph {
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: NativeConversationLeaseRecord["logicalChatId"];
  readonly nativeBindingId: NativeBindingId;
  readonly registrationAttemptId: RegistrationAttemptId;
  readonly descriptor: Readonly<{ product: string; access: string }>;
  readonly projectId: A1SafeId;
  readonly projectAllocationKind: string;
  readonly projectAllocationIntentId: A1SafeId;
  readonly projectInitialWorkspaceSelectorId: A1SafeId;
  readonly projectInitialTargetDigest: A1Digest;
  readonly workspaceSelectorId: A1SafeId;
  readonly mappingId: A1SafeId;
  readonly mappingGeneration: number;
  readonly mappingTargetDigest: A1Digest;
  readonly mappingState: string;
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
  readonly bindingState: string;
  readonly bindingSemanticConversationId: A1SafeId | null;
  readonly bindingIncarnationId: A1SafeId | null;
  readonly inwardEdgeId: A1SafeId;
  readonly chatState: "recovering" | "ready";
  readonly edgeState: "installing" | "current";
  readonly rootPathCertificateId: A1SafeId | null;
}

const RESERVATION_KEYS = [
  "collaboration_server_id",
  "logical_chat_id",
  "native_binding_id",
  "registration_attempt_id",
  "descriptor_product",
  "descriptor_access",
  "project_id",
  "allocation_kind",
  "project_allocation_intent_id",
  "initial_workspace_selector_id",
  "initial_target_digest",
  "workspace_selector_id",
  "project_target_selector_mapping_id",
  "mapping_generation",
  "mapping_target_digest",
  "mapping_state",
  "descriptor_ref",
  "descriptor_digest",
  "project_ref",
  "project_digest",
  "expected_native_ref_digest",
  "initial_phase",
  "metadata_schema_id",
  "metadata_ref",
  "metadata_digest",
  "capabilities_ref",
  "capabilities_digest",
  "binding_state",
  "semantic_conversation_id",
  "current_binding_incarnation_id",
  "inward_edge_id",
  "chat_state",
  "edge_state",
  "root_path_certificate_id",
] as const;

function loadReservation(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  registrationAttemptId: RegistrationAttemptId,
  bindingId: NativeBindingId,
  allowRootedTerminal = true,
): ReservationGraph {
  const value = sqlGet(
    transaction,
    `SELECT b.collaboration_server_id, b.logical_chat_id, b.native_binding_id,
            i.registration_attempt_id, b.descriptor_product, b.descriptor_access, b.project_id,
            p.allocation_kind, p.project_allocation_intent_id,
            p.initial_workspace_selector_id, p.initial_target_digest,
            m.workspace_selector_id, m.project_target_selector_mapping_id,
            m.mapping_generation, m.target_digest AS mapping_target_digest, m.state AS mapping_state,
            i.descriptor_ref, i.descriptor_digest, i.project_ref, i.project_digest,
            i.expected_native_ref_digest, i.initial_phase, i.metadata_schema_id,
            i.metadata_ref, i.metadata_digest, i.capabilities_ref, i.capabilities_digest,
            b.state AS binding_state, b.semantic_conversation_id,
            b.current_binding_incarnation_id, c.state AS chat_state, e.state AS edge_state,
            e.inward_edge_id, e.root_path_certificate_id
       FROM native_registration_intents AS i
       JOIN native_bindings AS b
         ON b.collaboration_server_id = i.collaboration_server_id
        AND b.native_binding_id = i.native_binding_id
       JOIN logical_chats AS c
         ON c.collaboration_server_id = b.collaboration_server_id
        AND c.logical_chat_id = b.logical_chat_id
        AND c.current_native_binding_id = b.native_binding_id
       JOIN projects AS p
         ON p.collaboration_server_id = b.collaboration_server_id
        AND p.project_id = b.project_id
       JOIN project_target_selector_mappings AS m
         ON m.collaboration_server_id = c.collaboration_server_id
        AND m.project_id = c.project_id
        AND m.project_target_selector_mapping_id = c.project_target_selector_mapping_id
       JOIN inward_collaboration_edges AS e
         ON e.inward_edge_id = c.current_inward_edge_id
        AND e.represented_server_id = c.collaboration_server_id
        AND e.represented_logical_chat_id = c.logical_chat_id
        AND e.target_native_binding_id = b.native_binding_id
      WHERE i.collaboration_server_id = ? AND i.registration_attempt_id = ?
        AND i.native_binding_id = ? LIMIT 1`,
    [serverId, registrationAttemptId, bindingId],
  );
  if (value === undefined) {
    throw new NativeRegistrationRepositoryConflictError("A1.2 terminal reservation is unknown");
  }
  const row = rawRow(value, RESERVATION_KEYS, "nativeRegistrationReservation");
  return persisted("nativeRegistrationReservation", () => {
    const rootPathCertificateId = parseNullable(
      row.root_path_certificate_id,
      parseA1SafeId,
      "nativeRegistrationReservation.rootPathCertificateId",
    );
    const terminalIsInstalling =
      row.chat_state === "recovering" &&
      row.edge_state === "installing" &&
      rootPathCertificateId === null;
    const terminalIsRooted =
      allowRootedTerminal &&
      row.binding_state === "current" &&
      row.semantic_conversation_id !== null &&
      row.current_binding_incarnation_id !== null &&
      row.chat_state === "ready" &&
      row.edge_state === "current" &&
      rootPathCertificateId !== null;
    if (
      (!terminalIsInstalling && !terminalIsRooted) ||
      (row.mapping_state !== "current" && row.mapping_state !== "superseded")
    ) {
      throw new NativeRegistrationRepositoryPersistenceError(
        "terminal reservation graph is neither installing nor exactly rooted",
      );
    }
    const capabilitiesRef = parseNullable(
      row.capabilities_ref,
      parseA1SafeId,
      "nativeRegistrationReservation.capabilitiesRef",
    );
    const capabilitiesDigest = parseNullable(
      row.capabilities_digest,
      parseA1Digest,
      "nativeRegistrationReservation.capabilitiesDigest",
    );
    if ((capabilitiesRef === null) !== (capabilitiesDigest === null)) {
      throw new NativeRegistrationRepositoryPersistenceError(
        "A1.2 capability evidence pair is incomplete",
      );
    }
    const phase = row.initial_phase;
    if (phase !== "starting" && phase !== "recovering") {
      throw new HostStateContractError("reservation initial phase is invalid");
    }
    return frozen({
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        row.collaboration_server_id,
        "nativeRegistrationReservation.collaborationServerId",
      ),
      logicalChatId: parseA1CanonicalId(
        "logicalChat",
        row.logical_chat_id,
        "nativeRegistrationReservation.logicalChatId",
      ),
      nativeBindingId: parseA1CanonicalId(
        "nativeBinding",
        row.native_binding_id,
        "nativeRegistrationReservation.nativeBindingId",
      ),
      registrationAttemptId: parseA1CanonicalId(
        "registrationAttempt",
        row.registration_attempt_id,
        "nativeRegistrationReservation.registrationAttemptId",
      ),
      descriptor: frozen({
        product: parseNonEmptyString(row.descriptor_product, "reservation.descriptor.product"),
        access: parseNonEmptyString(row.descriptor_access, "reservation.descriptor.access"),
      }),
      projectId: parseA1CanonicalId("project", row.project_id, "reservation.projectId"),
      projectAllocationKind: parseNonEmptyString(row.allocation_kind, "reservation.allocationKind"),
      projectAllocationIntentId: parseA1SafeId(
        row.project_allocation_intent_id,
        "reservation.projectAllocationIntentId",
      ),
      projectInitialWorkspaceSelectorId: parseA1SafeId(
        row.initial_workspace_selector_id,
        "reservation.initialWorkspaceSelectorId",
      ),
      projectInitialTargetDigest: parseA1Digest(
        row.initial_target_digest,
        "reservation.initialTargetDigest",
      ),
      workspaceSelectorId: parseA1SafeId(
        row.workspace_selector_id,
        "reservation.workspaceSelectorId",
      ),
      mappingId: parseA1CanonicalId(
        "projectTargetSelectorMapping",
        row.project_target_selector_mapping_id,
        "reservation.mappingId",
      ),
      mappingGeneration: parsePositiveSafeInteger(
        row.mapping_generation,
        "reservation.mappingGeneration",
      ),
      mappingTargetDigest: parseA1Digest(
        row.mapping_target_digest,
        "reservation.mappingTargetDigest",
      ),
      mappingState: parseNonEmptyString(row.mapping_state, "reservation.mappingState"),
      descriptorRef: parseA1SafeId(row.descriptor_ref, "reservation.descriptorRef"),
      descriptorDigest: parseA1Digest(row.descriptor_digest, "reservation.descriptorDigest"),
      projectRef: parseA1SafeId(row.project_ref, "reservation.projectRef"),
      projectDigest: parseA1Digest(row.project_digest, "reservation.projectDigest"),
      expectedNativeRefDigest: parseNullable(
        row.expected_native_ref_digest,
        parseA1Digest,
        "reservation.expectedNativeRefDigest",
      ),
      initialPhase: phase,
      metadataSchemaId: parseNonEmptyString(row.metadata_schema_id, "reservation.metadataSchemaId"),
      metadataRef: parseA1SafeId(row.metadata_ref, "reservation.metadataRef"),
      metadataDigest: parseA1Digest(row.metadata_digest, "reservation.metadataDigest"),
      capabilitiesRef,
      capabilitiesDigest,
      bindingState: parseNonEmptyString(row.binding_state, "reservation.bindingState"),
      bindingSemanticConversationId: parseNullable(
        row.semantic_conversation_id,
        parseA1SafeId,
        "reservation.semanticConversationId",
      ),
      bindingIncarnationId: parseNullable(
        row.current_binding_incarnation_id,
        parseA1SafeId,
        "reservation.currentBindingIncarnationId",
      ),
      inwardEdgeId: parseA1CanonicalId(
        "inwardEdge",
        row.inward_edge_id,
        "reservation.inwardEdgeId",
      ),
      chatState: terminalIsRooted ? "ready" : "recovering",
      edgeState: terminalIsRooted ? "current" : "installing",
      rootPathCertificateId,
    });
  });
}

function demoteRootedTerminalReservation(
  transaction: HostStateRepositorySqlTransaction,
  graph: ReservationGraph,
): void {
  if (graph.rootPathCertificateId === null) return;
  if (graph.chatState !== "ready" || graph.edgeState !== "current") {
    throw new NativeRegistrationRepositoryPersistenceError(
      "rooted terminal reservation has an invalid lifecycle state",
    );
  }
  runExactlyOne(
    transaction,
    `UPDATE inward_collaboration_edges
        SET state = 'installing', root_path_certificate_id = NULL
      WHERE inward_edge_id = ? AND represented_server_id = ?
        AND represented_logical_chat_id = ? AND target_kind = 'native-harness'
        AND target_native_binding_id = ? AND state = 'current'
        AND root_path_certificate_id = ?`,
    [
      graph.inwardEdgeId,
      graph.collaborationServerId,
      graph.logicalChatId,
      graph.nativeBindingId,
      graph.rootPathCertificateId,
    ],
    "native root edge demotion",
  );
  runExactlyOne(
    transaction,
    `UPDATE logical_chats SET state = 'recovering'
      WHERE collaboration_server_id = ? AND logical_chat_id = ?
        AND current_inward_edge_id = ? AND current_native_binding_id = ?
        AND state = 'ready'`,
    [graph.collaborationServerId, graph.logicalChatId, graph.inwardEdgeId, graph.nativeBindingId],
    "native root chat demotion",
  );
}

function readArtifact(
  transaction: HostStateRepositorySqlTransaction,
  scopeKind: "collaboration_server",
  scopeId: CollaborationServerId,
  ref: A1SafeId,
  schemaId: string,
  digest: A1Digest,
  classification?: "persisted" | "request",
): Uint8Array<ArrayBuffer>;
function readArtifact(
  transaction: HostStateRepositorySqlTransaction,
  scopeKind: "runtime",
  scopeId: NativeRuntimeId,
  ref: A1SafeId,
  schemaId: string,
  digest: A1Digest,
  classification?: "persisted" | "request",
): Uint8Array<ArrayBuffer>;
function readArtifact(
  transaction: HostStateRepositorySqlTransaction,
  scopeKind: "native_binding",
  scopeId: NativeBindingId,
  ref: A1SafeId,
  schemaId: string,
  digest: A1Digest,
  classification?: "persisted" | "request",
): Uint8Array<ArrayBuffer>;
function readArtifact(
  transaction: HostStateRepositorySqlTransaction,
  scopeKind: "collaboration_server" | "runtime" | "native_binding",
  scopeId: CollaborationServerId | NativeRuntimeId | NativeBindingId,
  ref: A1SafeId,
  schemaId: string,
  digest: A1Digest,
  classification: "persisted" | "request" = "persisted",
): Uint8Array<ArrayBuffer> {
  try {
    const protectedHandleId = parseA1CanonicalId("protectedHandle", ref, "nativeEvidence.ref");
    const artifacts = createProtectedArtifactTransactionOperations({
      get: (sql, parameters) => transaction.get(sql, parameters),
      run: (sql, parameters) => {
        const changes = transaction.run(sql, parameters).changes;
        const numeric = typeof changes === "bigint" ? Number(changes) : changes;
        if (!Number.isSafeInteger(numeric) || numeric < 0) {
          throw new NativeRegistrationRepositoryPersistenceError(
            "protected artifact write returned an invalid change count",
          );
        }
        return { changes: numeric };
      },
    });
    const common = {
      artifactRef: { protectedHandleId, kind: "artifact" as const },
      artifactSchemaId: schemaId,
      expectedArtifactDigest: digest,
    };
    switch (scopeKind) {
      case "collaboration_server":
        return artifacts
          .readVerifiedArtifact({
            ...common,
            scopeKind,
            scopeId: parseA1CanonicalId("collaborationServer", scopeId),
          })
          .artifactBytes.copyBytes();
      case "runtime":
        return artifacts
          .readVerifiedArtifact({
            ...common,
            scopeKind,
            scopeId: parseA1CanonicalId("nativeRuntime", scopeId),
          })
          .artifactBytes.copyBytes();
      case "native_binding":
        return artifacts
          .readVerifiedArtifact({
            ...common,
            scopeKind,
            scopeId: parseA1CanonicalId("nativeBinding", scopeId),
          })
          .artifactBytes.copyBytes();
    }
  } catch (error) {
    const message = `protected ${scopeKind} evidence could not be verified${
      error instanceof Error ? `: ${error.message}` : ""
    }`;
    if (classification === "request") {
      throw new NativeRegistrationRepositoryConflictError(message);
    }
    throw new NativeRegistrationRepositoryPersistenceError(message, { cause: error });
  }
}

function sameDescriptor(
  left: Readonly<{ product: string; access: string }>,
  right: Readonly<{ product: string; access: string }>,
): boolean {
  return left.product === right.product && left.access === right.access;
}

function projectSelectionMatches(
  selection: DurableProjectSelection,
  graph: ReservationGraph,
): boolean {
  if (selection.collaborationServerId !== graph.collaborationServerId) return false;
  if (selection.kind === "first_bootstrap") {
    return (
      graph.projectAllocationKind === "first_bootstrap" &&
      graph.projectAllocationIntentId === graph.registrationAttemptId &&
      selection.workspaceSelectorId === graph.projectInitialWorkspaceSelectorId &&
      selection.workspaceSelectorId === graph.workspaceSelectorId &&
      sameDescriptor(selection.terminalDescriptor, graph.descriptor) &&
      sameDigest(selection.targetDigest, graph.projectInitialTargetDigest) &&
      sameDigest(selection.targetDigest, graph.mappingTargetDigest)
    );
  }
  return (
    selection.projectId === graph.projectId &&
    selection.workspaceSelectorId === graph.workspaceSelectorId &&
    selection.projectTargetSelectorMappingId === graph.mappingId &&
    selection.mappingGeneration === graph.mappingGeneration &&
    sameDigest(selection.targetDigest, graph.mappingTargetDigest)
  );
}

function verifyReservationEvidence(
  transaction: HostStateRepositorySqlTransaction,
  graph: ReservationGraph,
): void {
  try {
    const descriptor = verifyNativeEngineDescriptorEvidence(
      readArtifact(
        transaction,
        "collaboration_server",
        graph.collaborationServerId,
        graph.descriptorRef,
        NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
        graph.descriptorDigest,
      ),
      graph.descriptorDigest,
    ).value;
    if (!sameDescriptor(descriptor, graph.descriptor)) {
      throw new NativeRegistrationRepositoryPersistenceError(
        "descriptor evidence does not select the reserved binding descriptor",
      );
    }
    const project = verifyDurableProjectSelectionEvidence(
      readArtifact(
        transaction,
        "collaboration_server",
        graph.collaborationServerId,
        graph.projectRef,
        DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
        graph.projectDigest,
      ),
      graph.projectDigest,
    ).value;
    if (!projectSelectionMatches(project, graph)) {
      throw new NativeRegistrationRepositoryPersistenceError(
        "project evidence does not select the exact reserved project and mapping",
      );
    }
    verifyNativeRegistrationMetadataEvidence(
      readArtifact(
        transaction,
        "collaboration_server",
        graph.collaborationServerId,
        graph.metadataRef,
        NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
        graph.metadataDigest,
      ),
      graph.metadataDigest,
      graph.metadataSchemaId,
    );
    if (graph.capabilitiesRef !== null && graph.capabilitiesDigest !== null) {
      verifyNativeConversationCapabilitiesEvidence(
        readArtifact(
          transaction,
          "collaboration_server",
          graph.collaborationServerId,
          graph.capabilitiesRef,
          NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
          graph.capabilitiesDigest,
        ),
        graph.capabilitiesDigest,
      );
    }
  } catch (error) {
    if (error instanceof NativeRegistrationRepositoryPersistenceError) throw error;
    throw new NativeRegistrationRepositoryPersistenceError(
      `A1.2 registration evidence is invalid${error instanceof Error ? `: ${error.message}` : ""}`,
      { cause: error },
    );
  }
}

interface CurrentAuthority {
  readonly nowMs: number;
  readonly nextRuntimeOwnerJournalOffset: number;
}

function assertCurrentAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  fence: RuntimeOwnerServiceFence,
  coordinatorFence: CoordinatorLeaseFence,
  nowMs: () => number,
): CurrentAuthority {
  const now = trustedNow(nowMs);
  const ownerKeys = [
    "machine_identity_id",
    "current_runtime_owner_service_lease_id",
    "current_runtime_owner_service_epoch",
    "next_journal_offset",
    "lease_machine_identity_id",
    "lease_epoch",
    "owner_instance_id",
    "owner_process_start_identity_schema_id",
    "owner_process_start_identity_ref",
    "owner_process_start_identity_digest",
    "acquired_at_ms",
    "heartbeat_deadline_ms",
    "released_at_ms",
    "lease_state",
  ] as const;
  const ownerValue = sqlGet(
    transaction,
    `SELECT o.machine_identity_id, o.current_runtime_owner_service_lease_id,
            o.current_runtime_owner_service_epoch, o.next_journal_offset,
            l.machine_identity_id AS lease_machine_identity_id,
            l.runtime_owner_service_epoch AS lease_epoch, l.owner_instance_id,
            l.owner_process_start_identity_schema_id, l.owner_process_start_identity_ref,
            l.owner_process_start_identity_digest, l.acquired_at_ms,
            l.heartbeat_deadline_ms, l.released_at_ms, l.state AS lease_state
       FROM runtime_owner_state AS o
       LEFT JOIN runtime_owner_service_leases AS l
         ON l.runtime_owner_service_lease_id = o.current_runtime_owner_service_lease_id
        AND l.runtime_owner_service_epoch = o.current_runtime_owner_service_epoch
      WHERE o.singleton = 1 LIMIT 1`,
  );
  if (ownerValue === undefined) throw new NativeRegistrationStaleOwnerError();
  const owner = rawRow(ownerValue, ownerKeys, "nativeRegistrationOwnerFence");
  if (
    owner.machine_identity_id !== machineIdentityId ||
    owner.lease_machine_identity_id !== machineIdentityId ||
    owner.current_runtime_owner_service_lease_id !== fence.runtimeOwnerServiceLeaseId ||
    owner.current_runtime_owner_service_epoch !== fence.runtimeOwnerServiceEpoch ||
    owner.lease_epoch !== fence.runtimeOwnerServiceEpoch ||
    owner.owner_instance_id !== fence.ownerInstanceId ||
    owner.owner_process_start_identity_schema_id !== fence.ownerProcessStartIdentitySchemaId ||
    owner.owner_process_start_identity_ref !== fence.ownerProcessStartIdentityRef ||
    owner.owner_process_start_identity_digest !== fence.ownerProcessStartIdentityDigest ||
    owner.lease_state !== "current" ||
    owner.released_at_ms !== null ||
    typeof owner.acquired_at_ms !== "number" ||
    typeof owner.heartbeat_deadline_ms !== "number" ||
    now < owner.acquired_at_ms ||
    now >= owner.heartbeat_deadline_ms
  ) {
    throw new NativeRegistrationStaleOwnerError();
  }
  const coordinatorKeys = [
    "current_coordinator_lease_id",
    "current_coordinator_epoch",
    "lease_epoch",
    "acquired_at_ms",
    "heartbeat_deadline_ms",
    "released_at_ms",
    "lease_state",
    "server_state",
  ] as const;
  const coordinatorValue = sqlGet(
    transaction,
    `SELECT s.current_coordinator_lease_id, s.current_coordinator_epoch,
            l.coordinator_epoch AS lease_epoch, l.acquired_at_ms,
            l.heartbeat_deadline_ms, l.released_at_ms, l.state AS lease_state,
            s.state AS server_state
       FROM collaboration_servers AS s
       LEFT JOIN coordinator_leases AS l
         ON l.collaboration_server_id = s.collaboration_server_id
        AND l.coordinator_lease_id = s.current_coordinator_lease_id
        AND l.coordinator_epoch = s.current_coordinator_epoch
      WHERE s.collaboration_server_id = ? LIMIT 1`,
    [coordinatorFence.collaborationServerId],
  );
  if (coordinatorValue === undefined) throw new NativeRegistrationStaleCoordinatorError();
  const coordinator = rawRow(
    coordinatorValue,
    coordinatorKeys,
    "nativeRegistrationCoordinatorFence",
  );
  if (
    coordinator.current_coordinator_lease_id !== coordinatorFence.coordinatorLeaseId ||
    coordinator.current_coordinator_epoch !== coordinatorFence.coordinatorEpoch ||
    coordinator.lease_epoch !== coordinatorFence.coordinatorEpoch ||
    coordinator.lease_state !== "current" ||
    coordinator.server_state === "closed" ||
    coordinator.released_at_ms !== null ||
    typeof coordinator.acquired_at_ms !== "number" ||
    typeof coordinator.heartbeat_deadline_ms !== "number" ||
    now < coordinator.acquired_at_ms ||
    now >= coordinator.heartbeat_deadline_ms
  ) {
    throw new NativeRegistrationStaleCoordinatorError();
  }
  return frozen({
    nowMs: now,
    nextRuntimeOwnerJournalOffset: parseNonNegativeSafeInteger(
      owner.next_journal_offset,
      "nativeRegistrationOwnerFence.nextJournalOffset",
    ),
  });
}

function assertRuntimeAssigned(
  transaction: HostStateRepositorySqlTransaction,
  runtimeId: NativeRuntimeId,
  nativeIncarnation: number,
  descriptor: Readonly<{ product: string; access: string }>,
  fence: RuntimeOwnerServiceFence,
): void {
  const keys = [
    "runtime_state",
    "current_native_incarnation",
    "descriptor_product",
    "descriptor_access",
    "incarnation_state",
    "assignment_runtime_id",
    "assignment_incarnation",
    "runtime_owner_service_lease_id",
    "runtime_owner_service_epoch",
  ] as const;
  const value = sqlGet(
    transaction,
    `SELECT r.state AS runtime_state, r.current_native_incarnation,
            r.descriptor_product, r.descriptor_access, i.state AS incarnation_state,
            a.runtime_id AS assignment_runtime_id,
            a.native_incarnation AS assignment_incarnation,
            a.runtime_owner_service_lease_id, a.runtime_owner_service_epoch
       FROM native_runtimes AS r
       JOIN native_runtime_incarnations AS i
         ON i.runtime_id = r.runtime_id
        AND i.native_incarnation = r.current_native_incarnation
       JOIN runtime_owner_assignments AS a
         ON a.runtime_owner_assignment_id = r.current_runtime_owner_assignment_id
      WHERE r.runtime_id = ? LIMIT 1`,
    [runtimeId],
  );
  if (value === undefined) {
    throw new NativeRegistrationRepositoryConflictError("native runtime is unknown");
  }
  const row = rawRow(value, keys, "nativeRegistrationRuntimeAssignment");
  if (
    row.runtime_state !== "current" ||
    row.current_native_incarnation !== nativeIncarnation ||
    row.descriptor_product !== descriptor.product ||
    row.descriptor_access !== descriptor.access ||
    row.incarnation_state === "closed" ||
    row.assignment_runtime_id !== runtimeId ||
    row.assignment_incarnation !== nativeIncarnation ||
    row.runtime_owner_service_lease_id !== fence.runtimeOwnerServiceLeaseId ||
    row.runtime_owner_service_epoch !== fence.runtimeOwnerServiceEpoch
  ) {
    throw new NativeRegistrationRepositoryConflictError(
      "native runtime is not the exact current incarnation assigned to this owner",
    );
  }
}

function leaseFenceMatches(
  lease: NativeConversationLeaseRecord,
  fence: RuntimeOwnerServiceFence,
  coordinatorFence: CoordinatorLeaseFence,
): boolean {
  return (
    lease.runtimeOwnerServiceLeaseId === fence.runtimeOwnerServiceLeaseId &&
    lease.runtimeOwnerServiceEpoch === fence.runtimeOwnerServiceEpoch &&
    lease.collaborationServerId === coordinatorFence.collaborationServerId &&
    lease.coordinatorLeaseId === coordinatorFence.coordinatorLeaseId &&
    lease.coordinatorEpoch === coordinatorFence.coordinatorEpoch
  );
}

function assertExactOperation(
  stored: NativeRegistrationOperationRecord,
  expected: RuntimeOwnerOperationEvidence,
  kind: NativeRegistrationOperationKind,
  leaseId: NativeConversationLeaseId,
  bindingId: NativeBindingId,
  fence?: RuntimeOwnerServiceFence,
  coordinatorFence?: CoordinatorLeaseFence,
): void {
  if (
    stored.kind !== kind ||
    stored.nativeConversationLeaseId !== leaseId ||
    stored.nativeBindingId !== bindingId ||
    stored.operationSchemaId !== expected.operationSchemaId ||
    !sameDigest(stored.operationDigest, expected.operationDigest) ||
    (fence !== undefined &&
      (stored.runtimeOwnerServiceLeaseId !== fence.runtimeOwnerServiceLeaseId ||
        stored.runtimeOwnerServiceEpoch !== fence.runtimeOwnerServiceEpoch)) ||
    (coordinatorFence !== undefined &&
      (stored.coordinatorLeaseId !== coordinatorFence.coordinatorLeaseId ||
        stored.coordinatorEpoch !== coordinatorFence.coordinatorEpoch))
  ) {
    throw new NativeRegistrationRepositoryConflictError(
      "operation ID collided with another registration effect",
    );
  }
}

function appendOperation(
  transaction: HostStateRepositorySqlTransaction,
  lease: NativeConversationLeaseRecord,
  operation: RuntimeOwnerOperationEvidence,
  kind: NativeRegistrationOperationKind,
  nowMs: number,
  fence: RuntimeOwnerServiceFence,
  coordinatorFence: CoordinatorLeaseFence,
): NativeRegistrationOperationRecord {
  if (lease.nextOperationSequence >= Number.MAX_SAFE_INTEGER) {
    throw new NativeRegistrationRepositoryConflictError(
      "native conversation operation sequence is exhausted",
    );
  }
  const entry = parseNativeRegistrationOperationRecord({
    operationId: operation.operationId,
    operationSequence: lease.nextOperationSequence,
    kind,
    operationSchemaId: operation.operationSchemaId,
    operationDigest: operation.operationDigest,
    nativeConversationLeaseId: lease.nativeConversationLeaseId,
    nativeBindingId: lease.nativeBindingId,
    runtimeOwnerServiceLeaseId: fence.runtimeOwnerServiceLeaseId,
    runtimeOwnerServiceEpoch: fence.runtimeOwnerServiceEpoch,
    coordinatorLeaseId: coordinatorFence.coordinatorLeaseId,
    coordinatorEpoch: coordinatorFence.coordinatorEpoch,
    committedAtMs: nowMs,
  });
  runExactlyOne(
    transaction,
    `INSERT INTO native_registration_operations (
       operation_id, operation_sequence, kind, operation_schema_id, operation_digest,
       native_conversation_lease_id, native_binding_id,
       runtime_owner_service_lease_id, runtime_owner_service_epoch,
       coordinator_lease_id, coordinator_epoch, committed_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.operationId,
      entry.operationSequence,
      entry.kind,
      entry.operationSchemaId,
      entry.operationDigest,
      entry.nativeConversationLeaseId,
      entry.nativeBindingId,
      entry.runtimeOwnerServiceLeaseId,
      entry.runtimeOwnerServiceEpoch,
      entry.coordinatorLeaseId,
      entry.coordinatorEpoch,
      entry.committedAtMs,
    ],
    "native registration operation append",
  );
  return entry;
}

function appendRuntimeAttachmentJournal(
  transaction: HostStateRepositorySqlTransaction,
  journalOffset: number,
  kind: "attachment_lease_acquired" | "attachment_detached",
  attachmentLeaseId: A1SafeId,
  operation: RuntimeOwnerOperationEvidence,
  fence: RuntimeOwnerServiceFence,
  committedAtMs: number,
): void {
  runExactlyOne(
    transaction,
    `INSERT INTO runtime_owner_journal_entries (
       journal_offset, entry_kind, subject_kind, subject_id,
       operation_id, operation_schema_id, operation_digest,
       runtime_owner_service_lease_id, runtime_owner_service_epoch, committed_at_ms
     ) VALUES (?, ?, 'native_transport_lease', ?, ?, ?, ?, ?, ?, ?)`,
    [
      journalOffset,
      kind,
      attachmentLeaseId,
      operation.operationId,
      operation.operationSchemaId,
      operation.operationDigest,
      fence.runtimeOwnerServiceLeaseId,
      fence.runtimeOwnerServiceEpoch,
      committedAtMs,
    ],
    `runtime-owner ${kind} journal append`,
  );
}

interface BoundGraph {
  readonly semanticConversationId: A1SafeId;
  readonly attachmentId: A1SafeId;
  readonly attachmentLeaseId: A1SafeId;
  readonly transportEpoch: number;
  readonly gateGeneration: number;
  readonly gatePhase: string;
}

const BOUND_GRAPH_KEYS = [
  "semantic_conversation_id",
  "attachment_id",
  "attachment_lease_id",
  "transport_epoch",
  "gate_generation",
  "gate_phase",
  "gate_current_attachment_lease_id",
  "binding_incarnation_state",
  "attachment_state",
  "attachment_current_lease_id",
  "attachment_lease_state",
  "attachment_lease_released_at_ms",
  "runtime_owner_service_lease_id",
  "runtime_owner_service_epoch",
  "coordinator_lease_id",
  "coordinator_epoch",
  "local_descriptor_product",
  "local_descriptor_access",
  "local_project_id",
  "local_state",
  "native_evidence_ref",
  "native_evidence_schema_id",
  "native_evidence_digest",
] as const;

function loadBoundGraph(
  transaction: HostStateRepositorySqlTransaction,
  lease: NativeConversationLeaseRecord,
  bindingIncarnationId: A1SafeId,
  attachmentLeaseId: A1SafeId,
  graph: ReservationGraph,
  classification: "selection" | "persisted" = "persisted",
  lifecycle: "current" | "historical" = "current",
): BoundGraph {
  const value = sqlGet(
    transaction,
    `SELECT bi.semantic_conversation_id, tl.attachment_id, tl.attachment_lease_id,
            tl.transport_epoch, g.gate_generation, g.phase AS gate_phase,
            g.current_attachment_lease_id AS gate_current_attachment_lease_id,
            bi.state AS binding_incarnation_state, a.state AS attachment_state,
            a.current_attachment_lease_id AS attachment_current_lease_id,
            tl.state AS attachment_lease_state,
            tl.released_at_ms AS attachment_lease_released_at_ms,
            tl.runtime_owner_service_lease_id,
            tl.runtime_owner_service_epoch, tl.coordinator_lease_id, tl.coordinator_epoch,
            lc.descriptor_product AS local_descriptor_product,
            lc.descriptor_access AS local_descriptor_access, lc.project_id AS local_project_id,
            lc.state AS local_state, t.native_evidence_ref, t.native_evidence_schema_id,
            t.native_evidence_digest
       FROM native_binding_incarnations AS bi
       JOIN native_transport_leases AS tl
         ON tl.native_binding_incarnation_id = bi.native_binding_incarnation_id
        AND tl.runtime_id = bi.runtime_id AND tl.native_incarnation = bi.native_incarnation
       JOIN native_transport_attachments AS a
         ON a.attachment_id = tl.attachment_id AND a.native_binding_id = bi.native_binding_id
       JOIN binding_lifecycle_gates AS g
         ON g.native_binding_id = bi.native_binding_id
        AND g.native_binding_incarnation_id = bi.native_binding_incarnation_id
       JOIN local_native_conversations AS lc
         ON lc.runtime_id = bi.runtime_id AND lc.native_incarnation = bi.native_incarnation
        AND lc.semantic_conversation_id = bi.semantic_conversation_id
       JOIN local_native_conversation_transitions AS t
         ON t.runtime_id = lc.runtime_id AND t.native_incarnation = lc.native_incarnation
        AND t.target_local_native_conversation_id = lc.local_native_conversation_id
        AND t.kind IN ('discover', 'new')
      WHERE bi.native_binding_incarnation_id = ?
        AND bi.collaboration_server_id = ? AND bi.logical_chat_id = ?
        AND bi.native_binding_id = ? AND bi.runtime_id = ? AND bi.native_incarnation = ?
        AND tl.attachment_lease_id = ?
      ORDER BY t.local_transition_seq ASC LIMIT 1`,
    [
      bindingIncarnationId,
      lease.collaborationServerId,
      lease.logicalChatId,
      lease.nativeBindingId,
      lease.runtimeId,
      lease.nativeIncarnation,
      attachmentLeaseId,
    ],
  );
  if (value === undefined) {
    const message = "prepared binding, attachment, or semantic conversation graph is unknown";
    if (classification === "selection") {
      throw new NativeRegistrationRepositoryConflictError(message);
    }
    throw new NativeRegistrationRepositoryPersistenceError(message);
  }
  const row = rawRow(value, BOUND_GRAPH_KEYS, "nativeRegistrationBoundGraph");
  return persisted("nativeRegistrationBoundGraph", () => {
    const semanticConversationId = parseA1SafeId(
      row.semantic_conversation_id,
      "nativeRegistrationBoundGraph.semanticConversationId",
    );
    const nativeEvidenceRef = parseA1SafeId(
      row.native_evidence_ref,
      "nativeRegistrationBoundGraph.nativeEvidenceRef",
    );
    const nativeEvidenceDigest = parseA1Digest(
      row.native_evidence_digest,
      "nativeRegistrationBoundGraph.nativeEvidenceDigest",
    );
    const currentTransport =
      row.attachment_state === "current" &&
      row.attachment_current_lease_id === attachmentLeaseId &&
      row.attachment_lease_state === "current" &&
      row.attachment_lease_released_at_ms === null &&
      row.gate_current_attachment_lease_id === attachmentLeaseId;
    const historicalTransport =
      lifecycle === "historical" &&
      row.attachment_state === "current" &&
      (((row.attachment_lease_state === "superseded" || row.attachment_lease_state === "closed") &&
        typeof row.attachment_lease_released_at_ms === "number") ||
        currentTransport);
    if (
      row.binding_incarnation_state !== "current" ||
      (lifecycle === "current" ? !currentTransport : !historicalTransport) ||
      row.runtime_owner_service_lease_id !== lease.runtimeOwnerServiceLeaseId ||
      row.runtime_owner_service_epoch !== lease.runtimeOwnerServiceEpoch ||
      row.coordinator_lease_id !== lease.coordinatorLeaseId ||
      row.coordinator_epoch !== lease.coordinatorEpoch ||
      row.local_descriptor_product !== graph.descriptor.product ||
      row.local_descriptor_access !== graph.descriptor.access ||
      row.local_project_id !== graph.projectId ||
      row.local_state !== "open" ||
      row.native_evidence_schema_id !== NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID
    ) {
      const message = "prepared runtime graph is not exact, current, and fence-bound";
      if (classification === "selection") {
        throw new NativeRegistrationRepositoryConflictError(message);
      }
      throw new NativeRegistrationRepositoryPersistenceError(message);
    }
    let nativeRef: ReturnType<typeof verifyNativeConversationRefEvidence>["value"];
    try {
      nativeRef = verifyNativeConversationRefEvidence(
        readArtifact(
          transaction,
          "runtime",
          lease.runtimeId,
          nativeEvidenceRef,
          NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
          nativeEvidenceDigest,
        ),
        nativeEvidenceDigest,
      ).value;
    } catch (error) {
      if (error instanceof NativeRegistrationRepositoryPersistenceError) throw error;
      throw new NativeRegistrationRepositoryPersistenceError(
        "native conversation evidence is invalid",
        { cause: error },
      );
    }
    if (
      !sameDescriptor(nativeRef.descriptor, graph.descriptor) ||
      nativeRef.runtimeId !== lease.runtimeId ||
      nativeRef.incarnation !== lease.nativeIncarnation ||
      nativeRef.conversationId !== semanticConversationId ||
      (graph.expectedNativeRefDigest !== null &&
        !sameDigest(graph.expectedNativeRefDigest, nativeEvidenceDigest))
    ) {
      const message = "native conversation evidence does not resolve the reserved binding";
      if (classification === "selection") {
        throw new NativeRegistrationRepositoryConflictError(message);
      }
      throw new NativeRegistrationRepositoryPersistenceError(message);
    }
    return frozen({
      semanticConversationId,
      attachmentId: parseA1SafeId(row.attachment_id, "nativeRegistrationBoundGraph.attachmentId"),
      attachmentLeaseId: parseA1SafeId(
        row.attachment_lease_id,
        "nativeRegistrationBoundGraph.attachmentLeaseId",
      ),
      transportEpoch: parsePositiveSafeInteger(
        row.transport_epoch,
        "nativeRegistrationBoundGraph.transportEpoch",
      ),
      gateGeneration: parsePositiveSafeInteger(
        row.gate_generation,
        "nativeRegistrationBoundGraph.gateGeneration",
      ),
      gatePhase: parseNonEmptyString(row.gate_phase, "nativeRegistrationBoundGraph.gatePhase"),
    });
  });
}

function requireLeaseForMutation(
  transaction: HostStateRepositorySqlTransaction,
  leaseId: NativeConversationLeaseId,
  fence: RuntimeOwnerServiceFence,
  coordinatorFence: CoordinatorLeaseFence,
  nowMs: number,
): Readonly<{ lease: NativeConversationLeaseRecord; nowMs: number; graph: ReservationGraph }> {
  const lease = findLease(transaction, leaseId);
  if (lease === null || lease.state === "closed") {
    throw new NativeRegistrationRepositoryConflictError("native conversation lease is not open");
  }
  if (!leaseFenceMatches(lease, fence, coordinatorFence)) {
    throw new NativeRegistrationRepositoryConflictError(
      "native conversation lease belongs to another owner or coordinator epoch",
    );
  }
  const graph = loadReservation(
    transaction,
    lease.collaborationServerId,
    lease.registrationAttemptId,
    lease.nativeBindingId,
  );
  verifyReservationEvidence(transaction, graph);
  assertRuntimeAssigned(
    transaction,
    lease.runtimeId,
    lease.nativeIncarnation,
    graph.descriptor,
    fence,
  );
  return frozen({ lease, nowMs, graph });
}

function updatedLease(
  lease: NativeConversationLeaseRecord,
  changes: Partial<NativeConversationLeaseRecord>,
): NativeConversationLeaseRecord {
  return parseNativeConversationLeaseRecord({
    ...lease,
    nextOperationSequence: checkedIncrement(
      lease.nextOperationSequence,
      "native conversation operation sequence",
    ),
    ...changes,
  });
}

function leaseTransitionAllowed(
  from: NativeConversationLeaseRecord["state"],
  to: "ready" | "recovering" | "draining",
): boolean {
  switch (from) {
    case "starting":
      return to === "ready" || to === "recovering" || to === "draining";
    case "recovering":
      return to === "ready" || to === "draining";
    case "ready":
      return to === "recovering" || to === "draining";
    case "draining":
      return to === "recovering";
    case "closed":
      return false;
  }
}

class BoundNativeRegistrationRepository implements NativeRegistrationRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #nowMs: () => number;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    options: NativeRegistrationRepositoryOptions = {},
  ) {
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(
      machineIdentityId,
      "nativeRegistrationRepository.machineIdentityId",
    );
    this.#nowMs = options.nowMs ?? Date.now;
  }

  open(request: OpenNativeConversationLeaseRequest): NativeConversationLeaseMutationResult {
    const parsed = parseOpenRequest(request);
    verifyRegistrationOperationContract("open", parsed);
    return this.#executor.transaction((transaction) => {
      const authority = assertCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        this.#nowMs,
      );
      const replay = findOperation(transaction, parsed.operation.operationId);
      if (replay !== null) {
        assertExactOperation(
          replay,
          parsed.operation,
          "open",
          parsed.nativeConversationLeaseId,
          parsed.nativeBindingId,
          parsed.fence,
          parsed.coordinatorFence,
        );
        const lease = findLease(transaction, parsed.nativeConversationLeaseId);
        if (
          lease === null ||
          lease.registrationAttemptId !== parsed.registrationAttemptId ||
          lease.runtimeId !== parsed.runtimeId ||
          lease.nativeIncarnation !== parsed.nativeIncarnation ||
          lease.protectedPortHandleId !== parsed.protectedPortHandleId ||
          !leaseFenceMatches(lease, parsed.fence, parsed.coordinatorFence) ||
          lease.leaseGeneration !== 1 ||
          lease.supersedesNativeConversationLeaseId !== null
        ) {
          throw new NativeRegistrationRepositoryConflictError(
            "open operation replay graph collided",
          );
        }
        return frozen({ lease, operation: replay, replayed: true });
      }
      if (findLease(transaction, parsed.nativeConversationLeaseId) !== null) {
        throw new NativeRegistrationRepositoryConflictError("conversation lease ID is occupied");
      }
      const graph = loadReservation(
        transaction,
        parsed.coordinatorFence.collaborationServerId,
        parsed.registrationAttemptId,
        parsed.nativeBindingId,
      );
      if (
        graph.bindingState !== "starting" ||
        graph.bindingSemanticConversationId !== null ||
        graph.bindingIncarnationId !== null
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "first lease requires the exact dormant A1.2 native binding",
        );
      }
      verifyReservationEvidence(transaction, graph);
      if (
        sqlGet(
          transaction,
          `SELECT native_conversation_lease_id FROM native_conversation_leases
            WHERE collaboration_server_id = ? AND native_binding_id = ? LIMIT 1`,
          [graph.collaborationServerId, graph.nativeBindingId],
        ) !== undefined
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "native binding already has a conversation lease lineage",
        );
      }
      assertRuntimeAssigned(
        transaction,
        parsed.runtimeId,
        parsed.nativeIncarnation,
        graph.descriptor,
        parsed.fence,
      );
      assertCallablePortHandleAvailable(transaction, parsed.protectedPortHandleId);
      const lease = parseNativeConversationLeaseRecord({
        nativeConversationLeaseId: parsed.nativeConversationLeaseId,
        collaborationServerId: graph.collaborationServerId,
        logicalChatId: graph.logicalChatId,
        nativeBindingId: graph.nativeBindingId,
        registrationAttemptId: graph.registrationAttemptId,
        runtimeId: parsed.runtimeId,
        nativeIncarnation: parsed.nativeIncarnation,
        nativeBindingIncarnationId: null,
        attachmentLeaseId: null,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        coordinatorLeaseId: parsed.coordinatorFence.coordinatorLeaseId,
        coordinatorEpoch: parsed.coordinatorFence.coordinatorEpoch,
        protectedPortHandleId: parsed.protectedPortHandleId,
        leaseGeneration: 1,
        supersedesNativeConversationLeaseId: null,
        currentPublicationId: null,
        nextOperationSequence: 1,
        acquiredAtMs: authority.nowMs,
        updatedAtMs: authority.nowMs,
        closedAtMs: null,
        state: graph.initialPhase,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO native_conversation_leases (
           native_conversation_lease_id, collaboration_server_id, logical_chat_id,
           native_binding_id, registration_attempt_id, runtime_id, native_incarnation,
           native_binding_incarnation_id, attachment_lease_id,
           runtime_owner_service_lease_id, runtime_owner_service_epoch,
           coordinator_lease_id, coordinator_epoch, protected_port_handle_id,
           lease_generation, supersedes_native_conversation_lease_id,
           current_publication_id, next_operation_sequence, acquired_at_ms,
           updated_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, NULL, NULL, 1, ?, ?, NULL, ?)`,
        [
          lease.nativeConversationLeaseId,
          lease.collaborationServerId,
          lease.logicalChatId,
          lease.nativeBindingId,
          lease.registrationAttemptId,
          lease.runtimeId,
          lease.nativeIncarnation,
          lease.runtimeOwnerServiceLeaseId,
          lease.runtimeOwnerServiceEpoch,
          lease.coordinatorLeaseId,
          lease.coordinatorEpoch,
          lease.protectedPortHandleId,
          lease.acquiredAtMs,
          lease.updatedAtMs,
          lease.state,
        ],
        "native conversation lease open",
      );
      const operation = appendOperation(
        transaction,
        lease,
        parsed.operation,
        "open",
        authority.nowMs,
        parsed.fence,
        parsed.coordinatorFence,
      );
      return frozen({
        lease: updatedLease(lease, {}),
        operation,
        replayed: false,
      });
    });
  }

  bind(request: BindNativeConversationLeaseRequest): NativeConversationLeaseMutationResult {
    const parsed = parseBindRequest(request);
    verifyRegistrationOperationContract("bind", parsed);
    return this.#executor.transaction((transaction) => {
      const authority = assertCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        this.#nowMs,
      );
      const replay = findOperation(transaction, parsed.operation.operationId);
      if (replay !== null) {
        const lease = findLease(transaction, replay.nativeConversationLeaseId);
        if (lease === null) {
          throw new NativeRegistrationRepositoryPersistenceError("bind replay lease is absent");
        }
        assertExactOperation(
          replay,
          parsed.operation,
          "bind",
          parsed.nativeConversationLeaseId,
          lease.nativeBindingId,
          parsed.fence,
          parsed.coordinatorFence,
        );
        if (
          lease.nativeBindingIncarnationId !== parsed.nativeBindingIncarnationId ||
          lease.attachmentLeaseId !== parsed.attachmentLeaseId
        ) {
          throw new NativeRegistrationRepositoryConflictError(
            "bind operation replay graph collided",
          );
        }
        return frozen({ lease, operation: replay, replayed: true });
      }
      const current = requireLeaseForMutation(
        transaction,
        parsed.nativeConversationLeaseId,
        parsed.fence,
        parsed.coordinatorFence,
        authority.nowMs,
      );
      if (
        current.lease.nativeBindingIncarnationId !== null ||
        current.lease.attachmentLeaseId !== null
      ) {
        throw new NativeRegistrationRepositoryConflictError("conversation lease is already bound");
      }
      const bound = loadBoundGraph(
        transaction,
        current.lease,
        parsed.nativeBindingIncarnationId,
        parsed.attachmentLeaseId,
        current.graph,
        "selection",
      );
      if (bound.gatePhase !== current.lease.state) {
        throw new NativeRegistrationRepositoryConflictError(
          "prepared lifecycle gate does not match the registration phase",
        );
      }
      const operation = appendOperation(
        transaction,
        current.lease,
        parsed.operation,
        "bind",
        current.nowMs,
        parsed.fence,
        parsed.coordinatorFence,
      );
      runExactlyOne(
        transaction,
        `UPDATE native_conversation_leases
            SET native_binding_incarnation_id = ?, attachment_lease_id = ?, updated_at_ms = ?
          WHERE native_conversation_lease_id = ?
            AND native_binding_incarnation_id IS NULL AND attachment_lease_id IS NULL
            AND state <> 'closed'`,
        [
          parsed.nativeBindingIncarnationId,
          parsed.attachmentLeaseId,
          current.nowMs,
          current.lease.nativeConversationLeaseId,
        ],
        "native conversation lease bind",
      );
      return frozen({
        lease: updatedLease(current.lease, {
          nativeBindingIncarnationId: parsed.nativeBindingIncarnationId,
          attachmentLeaseId: parsed.attachmentLeaseId,
          updatedAtMs: current.nowMs,
        }),
        operation,
        replayed: false,
      });
    });
  }

  publish(request: PublishNativeRegistrationRequest): PublishNativeRegistrationResult {
    const parsed = parsePublishRequest(request);
    verifyRegistrationOperationContract("publish", parsed);
    return this.#executor.transaction((transaction) => {
      const authority = assertCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        this.#nowMs,
      );
      const replay = findOperation(transaction, parsed.operation.operationId);
      if (replay !== null) {
        const lease = findLease(transaction, replay.nativeConversationLeaseId);
        if (lease === null) {
          throw new NativeRegistrationRepositoryPersistenceError("publish replay lease is absent");
        }
        assertExactOperation(
          replay,
          parsed.operation,
          "publish",
          parsed.nativeConversationLeaseId,
          lease.nativeBindingId,
          parsed.fence,
          parsed.coordinatorFence,
        );
        const publication = findPublication(transaction, parsed.nativeRegistrationPublicationId);
        if (publication === null) {
          throw new NativeRegistrationRepositoryPersistenceError(
            "publish replay publication is absent",
          );
        }
        if (
          publication.nativeConversationLeaseId !== lease.nativeConversationLeaseId ||
          publication.publicationGeneration !== parsed.publicationGeneration ||
          publication.metadataSchemaId !== parsed.metadataSchemaId ||
          publication.metadataRef !== parsed.metadataRef ||
          !sameDigest(publication.metadataDigest, parsed.metadataDigest) ||
          publication.capabilitiesRef !== parsed.capabilitiesRef ||
          !sameDigest(publication.capabilitiesDigest, parsed.capabilitiesDigest) ||
          lease.currentPublicationId !== publication.nativeRegistrationPublicationId
        ) {
          throw new NativeRegistrationRepositoryConflictError(
            "publish operation replay graph collided",
          );
        }
        return frozen({ lease, publication, operation: replay, replayed: true });
      }
      const current = requireLeaseForMutation(
        transaction,
        parsed.nativeConversationLeaseId,
        parsed.fence,
        parsed.coordinatorFence,
        authority.nowMs,
      );
      const bindingIncarnationId = current.lease.nativeBindingIncarnationId;
      const attachmentLeaseId = current.lease.attachmentLeaseId;
      if (bindingIncarnationId === null || attachmentLeaseId === null) {
        throw new NativeRegistrationRepositoryConflictError("publication requires a bound lease");
      }
      loadBoundGraph(
        transaction,
        current.lease,
        bindingIncarnationId,
        attachmentLeaseId,
        current.graph,
      );
      if (parsed.metadataSchemaId !== current.graph.metadataSchemaId) {
        throw new NativeRegistrationRepositoryConflictError(
          "published metadata schema does not match the registration intent",
        );
      }
      if (!sameDigest(parsed.metadataDigest, current.graph.metadataDigest)) {
        throw new NativeRegistrationRepositoryConflictError(
          "published metadata does not equal the A1.2 registration intent",
        );
      }
      if (
        current.graph.capabilitiesDigest !== null &&
        !sameDigest(parsed.capabilitiesDigest, current.graph.capabilitiesDigest)
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "published capabilities do not equal the A1.2 registration intent",
        );
      }
      try {
        verifyNativeRegistrationMetadataEvidence(
          readArtifact(
            transaction,
            "native_binding",
            current.lease.nativeBindingId,
            parsed.metadataRef,
            NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
            parsed.metadataDigest,
            "request",
          ),
          parsed.metadataDigest,
          parsed.metadataSchemaId,
        );
        verifyNativeConversationCapabilitiesEvidence(
          readArtifact(
            transaction,
            "native_binding",
            current.lease.nativeBindingId,
            parsed.capabilitiesRef,
            NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
            parsed.capabilitiesDigest,
            "request",
          ),
          parsed.capabilitiesDigest,
        );
      } catch (error) {
        if (error instanceof NativeRegistrationRepositoryConflictError) throw error;
        throw new NativeRegistrationRepositoryConflictError("published evidence is invalid");
      }
      const existingPublication =
        current.lease.currentPublicationId === null
          ? null
          : findPublication(transaction, current.lease.currentPublicationId);
      const expectedGeneration =
        existingPublication === null
          ? 1
          : checkedIncrement(existingPublication.publicationGeneration, "publication generation");
      if (
        parsed.publicationGeneration !== expectedGeneration ||
        (existingPublication !== null && existingPublication.state !== "current") ||
        findPublication(transaction, parsed.nativeRegistrationPublicationId) !== null
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "publication ID or generation is not the exact successor",
        );
      }
      const publication = parseNativeRegistrationPublicationRecord({
        nativeRegistrationPublicationId: parsed.nativeRegistrationPublicationId,
        nativeConversationLeaseId: current.lease.nativeConversationLeaseId,
        nativeBindingId: current.lease.nativeBindingId,
        runtimeId: current.lease.runtimeId,
        nativeIncarnation: current.lease.nativeIncarnation,
        nativeBindingIncarnationId: bindingIncarnationId,
        attachmentLeaseId,
        publicationGeneration: parsed.publicationGeneration,
        metadataSchemaId: parsed.metadataSchemaId,
        metadataRef: parsed.metadataRef,
        metadataDigest: parsed.metadataDigest,
        capabilitiesSchemaId: NATIVE_REGISTRATION_CAPABILITIES_SCHEMA_ID,
        capabilitiesRef: parsed.capabilitiesRef,
        capabilitiesDigest: parsed.capabilitiesDigest,
        publishedAtMs: current.nowMs,
        state: "current",
      });
      const operation = appendOperation(
        transaction,
        current.lease,
        parsed.operation,
        "publish",
        current.nowMs,
        parsed.fence,
        parsed.coordinatorFence,
      );
      if (existingPublication !== null) {
        runExactlyOne(
          transaction,
          `UPDATE native_registration_publications SET state = 'superseded'
            WHERE native_registration_publication_id = ? AND state = 'current'`,
          [existingPublication.nativeRegistrationPublicationId],
          "native registration publication supersede",
        );
      }
      runExactlyOne(
        transaction,
        `INSERT INTO native_registration_publications (
           native_registration_publication_id, native_conversation_lease_id,
           native_binding_id, runtime_id, native_incarnation,
           native_binding_incarnation_id, attachment_lease_id, publication_generation,
           metadata_schema_id, metadata_ref, metadata_digest, capabilities_schema_id,
           capabilities_ref, capabilities_digest, published_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current')`,
        [
          publication.nativeRegistrationPublicationId,
          publication.nativeConversationLeaseId,
          publication.nativeBindingId,
          publication.runtimeId,
          publication.nativeIncarnation,
          publication.nativeBindingIncarnationId,
          publication.attachmentLeaseId,
          publication.publicationGeneration,
          publication.metadataSchemaId,
          publication.metadataRef,
          publication.metadataDigest,
          publication.capabilitiesSchemaId,
          publication.capabilitiesRef,
          publication.capabilitiesDigest,
          publication.publishedAtMs,
        ],
        "native registration publication insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_conversation_leases
            SET current_publication_id = ?, updated_at_ms = ?
          WHERE native_conversation_lease_id = ? AND state <> 'closed'
            AND current_publication_id IS ?`,
        [
          publication.nativeRegistrationPublicationId,
          current.nowMs,
          current.lease.nativeConversationLeaseId,
          existingPublication?.nativeRegistrationPublicationId ?? null,
        ],
        "native conversation publication pointer",
      );
      return frozen({
        lease: updatedLease(current.lease, {
          currentPublicationId: publication.nativeRegistrationPublicationId,
          updatedAtMs: current.nowMs,
        }),
        publication,
        operation,
        replayed: false,
      });
    });
  }

  ready(request: ReadyNativeConversationLeaseRequest): NativeConversationLeaseMutationResult {
    const parsed = parseReadyRequest(request);
    verifyRegistrationOperationContract("ready", parsed);
    return this.#transition(parsed, "ready", "ready");
  }

  recover(
    request: TransitionNativeConversationLeaseRequest,
  ): NativeConversationLeaseMutationResult {
    const parsed = parseTransitionRequest(request, "nativeRegistration.recover");
    verifyRegistrationOperationContract("recover", parsed);
    return this.#transition(parsed, "recover", "recovering");
  }

  drain(request: TransitionNativeConversationLeaseRequest): NativeConversationLeaseMutationResult {
    const parsed = parseTransitionRequest(request, "nativeRegistration.drain");
    verifyRegistrationOperationContract("drain", parsed);
    return this.#transition(parsed, "drain", "draining");
  }

  #transition(
    parsed: TransitionNativeConversationLeaseRequest | ReadyNativeConversationLeaseRequest,
    kind: "ready" | "recover" | "drain",
    targetState: "ready" | "recovering" | "draining",
  ): NativeConversationLeaseMutationResult {
    return this.#executor.transaction((transaction) => {
      const authority = assertCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        this.#nowMs,
      );
      const replay = findOperation(transaction, parsed.operation.operationId);
      if (replay !== null) {
        const lease = findLease(transaction, replay.nativeConversationLeaseId);
        if (lease === null) {
          throw new NativeRegistrationRepositoryPersistenceError(
            "transition replay lease is absent",
          );
        }
        assertExactOperation(
          replay,
          parsed.operation,
          kind,
          parsed.nativeConversationLeaseId,
          lease.nativeBindingId,
          parsed.fence,
          parsed.coordinatorFence,
        );
        if (lease.state !== targetState) {
          throw new NativeRegistrationRepositoryConflictError(
            "transition operation replay state collided",
          );
        }
        return frozen({ lease, operation: replay, replayed: true });
      }
      const current = requireLeaseForMutation(
        transaction,
        parsed.nativeConversationLeaseId,
        parsed.fence,
        parsed.coordinatorFence,
        authority.nowMs,
      );
      const bindingIncarnationId = current.lease.nativeBindingIncarnationId;
      const attachmentLeaseId = current.lease.attachmentLeaseId;
      if (bindingIncarnationId === null || attachmentLeaseId === null) {
        throw new NativeRegistrationRepositoryConflictError(
          "lifecycle transition requires a bound lease",
        );
      }
      const bound = loadBoundGraph(
        transaction,
        current.lease,
        bindingIncarnationId,
        attachmentLeaseId,
        current.graph,
      );
      if (bound.gateGeneration !== parsed.expectedGateGeneration) {
        throw new NativeRegistrationRepositoryConflictError(
          "binding lifecycle gate compare-and-swap failed",
        );
      }
      if (
        bound.gatePhase !== current.lease.state ||
        !leaseTransitionAllowed(current.lease.state, targetState)
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "requested lease/gate lifecycle transition is not allowed",
        );
      }
      if (kind === "ready") {
        const ready = parsed as ReadyNativeConversationLeaseRequest;
        if (
          current.lease.currentPublicationId !== ready.expectedPublicationId ||
          findPublication(transaction, ready.expectedPublicationId)?.state !== "current"
        ) {
          throw new NativeRegistrationRepositoryConflictError(
            "ready requires the exact current post-setup publication",
          );
        }
      }
      const operation = appendOperation(
        transaction,
        current.lease,
        parsed.operation,
        kind,
        current.nowMs,
        parsed.fence,
        parsed.coordinatorFence,
      );
      if (kind === "ready") {
        runExactlyOne(
          transaction,
          `UPDATE native_runtime_incarnations SET state = 'current'
            WHERE runtime_id = ? AND native_incarnation = ? AND state IN ('starting', 'current')`,
          [current.lease.runtimeId, current.lease.nativeIncarnation],
          "native runtime incarnation activate",
        );
        runExactlyOne(
          transaction,
          `UPDATE native_bindings
              SET semantic_conversation_id = ?, current_binding_incarnation_id = ?, state = 'current'
            WHERE native_binding_id = ? AND collaboration_server_id = ? AND logical_chat_id = ?
              AND (
                (state = 'starting' AND semantic_conversation_id IS NULL
                  AND current_binding_incarnation_id IS NULL)
                OR (state = 'current' AND semantic_conversation_id = ?
                  AND current_binding_incarnation_id = ?)
              )`,
          [
            bound.semanticConversationId,
            bindingIncarnationId,
            current.lease.nativeBindingId,
            current.lease.collaborationServerId,
            current.lease.logicalChatId,
            bound.semanticConversationId,
            bindingIncarnationId,
          ],
          "native binding activate",
        );
      }
      const nextGateGeneration = checkedIncrement(bound.gateGeneration, "binding gate generation");
      runExactlyOne(
        transaction,
        `UPDATE binding_lifecycle_gates
            SET phase = ?, gate_generation = ?, updated_at_ms = ?
          WHERE native_binding_id = ? AND gate_generation = ?
            AND native_binding_incarnation_id = ? AND current_attachment_lease_id = ?`,
        [
          targetState,
          nextGateGeneration,
          current.nowMs,
          current.lease.nativeBindingId,
          bound.gateGeneration,
          bindingIncarnationId,
          attachmentLeaseId,
        ],
        "binding lifecycle transition",
      );
      runExactlyOne(
        transaction,
        `UPDATE native_conversation_leases SET state = ?, updated_at_ms = ?
          WHERE native_conversation_lease_id = ? AND state = ?`,
        [targetState, current.nowMs, current.lease.nativeConversationLeaseId, current.lease.state],
        "native conversation lifecycle transition",
      );
      if (kind !== "ready") {
        demoteRootedTerminalReservation(transaction, current.graph);
      }
      return frozen({
        lease: updatedLease(current.lease, { state: targetState, updatedAtMs: current.nowMs }),
        operation,
        replayed: false,
      });
    });
  }

  close(request: CloseNativeConversationLeaseRequest): NativeConversationLeaseMutationResult {
    const parsed = parseCloseRequest(request);
    verifyRegistrationOperationContract("close", parsed);
    return this.#executor.transaction((transaction) => {
      const authority = assertCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        this.#nowMs,
      );
      const replay = findOperation(transaction, parsed.operation.operationId);
      if (replay !== null) {
        const lease = findLease(transaction, replay.nativeConversationLeaseId);
        if (lease === null) {
          throw new NativeRegistrationRepositoryPersistenceError("close replay lease is absent");
        }
        assertExactOperation(
          replay,
          parsed.operation,
          "close",
          parsed.nativeConversationLeaseId,
          lease.nativeBindingId,
          parsed.fence,
          parsed.coordinatorFence,
        );
        if (lease.state !== "closed") {
          throw new NativeRegistrationRepositoryPersistenceError("close replay lease remains open");
        }
        return frozen({ lease, operation: replay, replayed: true });
      }
      const current = requireLeaseForMutation(
        transaction,
        parsed.nativeConversationLeaseId,
        parsed.fence,
        parsed.coordinatorFence,
        authority.nowMs,
      );
      let bound: BoundGraph | null = null;
      if (
        current.lease.nativeBindingIncarnationId !== null &&
        current.lease.attachmentLeaseId !== null
      ) {
        bound = loadBoundGraph(
          transaction,
          current.lease,
          current.lease.nativeBindingIncarnationId,
          current.lease.attachmentLeaseId,
          current.graph,
        );
        if (bound.gateGeneration !== parsed.expectedGateGeneration) {
          throw new NativeRegistrationRepositoryConflictError(
            "binding lifecycle gate compare-and-swap failed",
          );
        }
      }
      if (
        (bound === null && parsed.expectedGateGeneration !== null) ||
        (bound !== null && parsed.expectedGateGeneration === null) ||
        (bound !== null && bound.gatePhase !== current.lease.state)
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "close request does not match the lease lifecycle gate",
        );
      }
      const operation = appendOperation(
        transaction,
        current.lease,
        parsed.operation,
        "close",
        current.nowMs,
        parsed.fence,
        parsed.coordinatorFence,
      );
      runExactlyOne(
        transaction,
        `UPDATE native_conversation_leases
            SET state = 'closed', updated_at_ms = ?, closed_at_ms = ?
          WHERE native_conversation_lease_id = ? AND state <> 'closed'`,
        [current.nowMs, current.nowMs, current.lease.nativeConversationLeaseId],
        "native conversation lease close",
      );
      if (current.lease.currentPublicationId !== null) {
        runExactlyOne(
          transaction,
          `UPDATE native_registration_publications SET state = 'superseded'
            WHERE native_registration_publication_id = ? AND state = 'current'`,
          [current.lease.currentPublicationId],
          "closed lease publication supersede",
        );
      }
      if (bound !== null) {
        runExactlyOne(
          transaction,
          `UPDATE binding_lifecycle_gates
              SET phase = 'recovering', gate_generation = ?, updated_at_ms = ?
            WHERE native_binding_id = ? AND gate_generation = ?
              AND current_attachment_lease_id = ?`,
          [
            checkedIncrement(bound.gateGeneration, "binding gate generation"),
            current.nowMs,
            current.lease.nativeBindingId,
            bound.gateGeneration,
            current.lease.attachmentLeaseId,
          ],
          "closed lease recovery gate",
        );
      }
      demoteRootedTerminalReservation(transaction, current.graph);
      return frozen({
        lease: updatedLease(current.lease, {
          state: "closed",
          updatedAtMs: current.nowMs,
          closedAtMs: current.nowMs,
        }),
        operation,
        replayed: false,
      });
    });
  }

  reattach(request: ReattachNativeConversationLeaseRequest): ReattachNativeConversationLeaseResult {
    const parsed = parseReattachRequest(request);
    verifyRegistrationOperationContract("reattach", parsed);
    return this.#executor.transaction((transaction) => {
      const authority = assertCurrentAuthority(
        transaction,
        this.#machineIdentityId,
        parsed.fence,
        parsed.coordinatorFence,
        this.#nowMs,
      );
      const replay = findOperation(transaction, parsed.operation.operationId);
      if (replay !== null) {
        const lease = findLease(transaction, replay.nativeConversationLeaseId);
        if (lease === null) {
          throw new NativeRegistrationRepositoryPersistenceError(
            "reattach replay successor lease is absent",
          );
        }
        assertExactOperation(
          replay,
          parsed.operation,
          "reattach",
          parsed.nativeConversationLeaseId,
          lease.nativeBindingId,
          parsed.fence,
          parsed.coordinatorFence,
        );
        const predecessorLeaseId = lease.supersedesNativeConversationLeaseId;
        const predecessor =
          predecessorLeaseId === null ? null : findLease(transaction, predecessorLeaseId);
        const closeOperation = findOperation(
          transaction,
          parsed.predecessorCloseOperation.operationId,
        );
        if (predecessor === null || closeOperation === null) {
          throw new NativeRegistrationRepositoryPersistenceError("reattach replay graph is absent");
        }
        assertExactOperation(
          closeOperation,
          parsed.predecessorCloseOperation,
          "close",
          predecessor.nativeConversationLeaseId,
          predecessor.nativeBindingId,
        );
        if (
          predecessor.nativeConversationLeaseId !== parsed.predecessorNativeConversationLeaseId ||
          predecessor.state !== "closed" ||
          lease.supersedesNativeConversationLeaseId !== predecessor.nativeConversationLeaseId ||
          lease.protectedPortHandleId !== parsed.protectedPortHandleId ||
          lease.attachmentLeaseId !==
            (parsed.successorAttachmentLeaseId ?? predecessor.attachmentLeaseId) ||
          !leaseFenceMatches(lease, parsed.fence, parsed.coordinatorFence)
        ) {
          throw new NativeRegistrationRepositoryConflictError(
            "reattach operation replay graph collided",
          );
        }
        if (retainedPublicationAllowsLiveReattach(transaction, predecessor) === false) {
          throw new NativeRegistrationRepositoryConflictError(
            "retained publication does not allow live reattach",
          );
        }
        return frozen({
          predecessor,
          predecessorCloseOperation: closeOperation,
          lease,
          operation: replay,
          attachmentLeaseId: lease.attachmentLeaseId,
          replayed: true,
        });
      }
      if (
        parsed.operation.operationId === parsed.predecessorCloseOperation.operationId ||
        findLease(transaction, parsed.nativeConversationLeaseId) !== null
      ) {
        throw new NativeRegistrationRepositoryConflictError("reattach identities are occupied");
      }
      const predecessor = findLease(transaction, parsed.predecessorNativeConversationLeaseId);
      if (predecessor === null) {
        throw new NativeRegistrationRepositoryConflictError("reattach predecessor is unknown");
      }
      const successorGeneration = checkedIncrement(
        predecessor.leaseGeneration,
        "conversation lease generation",
      );
      if (
        sqlGet(
          transaction,
          `SELECT native_conversation_lease_id FROM native_conversation_leases
            WHERE supersedes_native_conversation_lease_id = ?
               OR (collaboration_server_id = ? AND native_binding_id = ?
                   AND lease_generation = ?)
               OR (collaboration_server_id = ? AND native_binding_id = ?
                   AND state <> 'closed' AND native_conversation_lease_id <> ?)
            LIMIT 1`,
          [
            predecessor.nativeConversationLeaseId,
            predecessor.collaborationServerId,
            predecessor.nativeBindingId,
            successorGeneration,
            predecessor.collaborationServerId,
            predecessor.nativeBindingId,
            predecessor.nativeConversationLeaseId,
          ],
        ) !== undefined
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "reattach predecessor is not the unclaimed lease-lineage tail",
        );
      }
      const graph = loadReservation(
        transaction,
        predecessor.collaborationServerId,
        predecessor.registrationAttemptId,
        predecessor.nativeBindingId,
      );
      verifyReservationEvidence(transaction, graph);
      assertRuntimeAssigned(
        transaction,
        predecessor.runtimeId,
        predecessor.nativeIncarnation,
        graph.descriptor,
        parsed.fence,
      );
      if (predecessor.collaborationServerId !== parsed.coordinatorFence.collaborationServerId) {
        throw new NativeRegistrationRepositoryConflictError(
          "reattach crosses collaboration servers",
        );
      }
      const predecessorWasClosed = predecessor.state === "closed";
      let closeOperation = findOperation(transaction, parsed.predecessorCloseOperation.operationId);
      if (predecessorWasClosed) {
        if (closeOperation === null) {
          throw new NativeRegistrationRepositoryConflictError(
            "closed predecessor lacks the selected close operation",
          );
        }
        assertExactOperation(
          closeOperation,
          parsed.predecessorCloseOperation,
          "close",
          predecessor.nativeConversationLeaseId,
          predecessor.nativeBindingId,
        );
        if (closeOperation.operationSequence !== predecessor.nextOperationSequence - 1) {
          throw new NativeRegistrationRepositoryPersistenceError(
            "closed predecessor final operation is not its selected close",
          );
        }
      } else {
        if (closeOperation !== null) {
          throw new NativeRegistrationRepositoryConflictError(
            "predecessor close operation ID is occupied",
          );
        }
        verifyRegistrationOperationContract("close", {
          fence: parsed.fence,
          coordinatorFence: parsed.coordinatorFence,
          operation: parsed.predecessorCloseOperation,
          nativeConversationLeaseId: parsed.predecessorNativeConversationLeaseId,
          expectedGateGeneration: parsed.expectedGateGeneration,
        });
      }
      const bound =
        predecessor.nativeBindingIncarnationId === null || predecessor.attachmentLeaseId === null
          ? null
          : loadBoundGraph(
              transaction,
              predecessor,
              predecessor.nativeBindingIncarnationId,
              predecessor.attachmentLeaseId,
              graph,
            );
      if (
        (bound === null) !== (parsed.expectedGateGeneration === null) ||
        (bound !== null && bound.gateGeneration !== parsed.expectedGateGeneration)
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "reattach lifecycle gate compare-and-swap failed",
        );
      }
      if (retainedPublicationAllowsLiveReattach(transaction, predecessor) === false) {
        throw new NativeRegistrationRepositoryConflictError(
          "retained publication does not allow live reattach",
        );
      }
      const fenceChanged = !leaseFenceMatches(predecessor, parsed.fence, parsed.coordinatorFence);
      if (
        bound !== null &&
        ((fenceChanged && parsed.successorAttachmentLeaseId === null) ||
          (!fenceChanged && parsed.successorAttachmentLeaseId !== null))
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "successor transport lease must be supplied exactly when attachment fences change",
        );
      }
      if (bound === null && parsed.successorAttachmentLeaseId !== null) {
        throw new NativeRegistrationRepositoryConflictError(
          "an unbound predecessor cannot rotate an attachment lease",
        );
      }
      assertCallablePortHandleAvailable(transaction, parsed.protectedPortHandleId);
      if (
        bound !== null &&
        parsed.successorAttachmentLeaseId !== null &&
        authority.nextRuntimeOwnerJournalOffset > Number.MAX_SAFE_INTEGER - 2
      ) {
        throw new NativeRegistrationRepositoryConflictError(
          "runtime-owner journal lacks capacity for transport reattachment",
        );
      }
      if (bound !== null && parsed.successorAttachmentLeaseId !== null) {
        const journalCollision = sqlGet(
          transaction,
          `SELECT operation_id FROM runtime_owner_journal_entries
            WHERE operation_id IN (?, ?) LIMIT 1`,
          [parsed.predecessorCloseOperation.operationId, parsed.operation.operationId],
        );
        if (journalCollision !== undefined) {
          throw new NativeRegistrationRepositoryConflictError(
            "reattach runtime-owner journal operation ID is occupied",
          );
        }
        if (
          sqlGet(
            transaction,
            "SELECT attachment_lease_id FROM native_transport_leases WHERE attachment_lease_id = ? LIMIT 1",
            [parsed.successorAttachmentLeaseId],
          ) !== undefined
        ) {
          throw new NativeRegistrationRepositoryConflictError(
            "successor attachment lease ID is occupied",
          );
        }
      }
      if (!predecessorWasClosed) {
        closeOperation = appendOperation(
          transaction,
          predecessor,
          parsed.predecessorCloseOperation,
          "close",
          authority.nowMs,
          parsed.fence,
          parsed.coordinatorFence,
        );
        runExactlyOne(
          transaction,
          `UPDATE native_conversation_leases
              SET state = 'closed', updated_at_ms = ?, closed_at_ms = ?
            WHERE native_conversation_lease_id = ? AND state <> 'closed'`,
          [authority.nowMs, authority.nowMs, predecessor.nativeConversationLeaseId],
          "reattach predecessor close",
        );
        if (predecessor.currentPublicationId !== null) {
          runExactlyOne(
            transaction,
            `UPDATE native_registration_publications SET state = 'superseded'
              WHERE native_registration_publication_id = ? AND state = 'current'`,
            [predecessor.currentPublicationId],
            "reattach predecessor publication supersede",
          );
        }
      }
      if (closeOperation === null) {
        throw new NativeRegistrationRepositoryPersistenceError(
          "reattach predecessor close operation was not retained",
        );
      }
      let attachmentLeaseId = predecessor.attachmentLeaseId;
      if (bound !== null && parsed.successorAttachmentLeaseId !== null) {
        const successorId = parsed.successorAttachmentLeaseId;
        runExactlyOne(
          transaction,
          `UPDATE native_transport_leases
              SET released_at_ms = ?, state = 'superseded'
            WHERE attachment_lease_id = ? AND state = 'current' AND released_at_ms IS NULL`,
          [authority.nowMs, predecessor.attachmentLeaseId],
          "predecessor transport lease supersede",
        );
        appendRuntimeAttachmentJournal(
          transaction,
          authority.nextRuntimeOwnerJournalOffset,
          "attachment_detached",
          bound.attachmentLeaseId,
          parsed.predecessorCloseOperation,
          parsed.fence,
          authority.nowMs,
        );
        runExactlyOne(
          transaction,
          `UPDATE native_transport_attachments SET current_attachment_lease_id = NULL
            WHERE attachment_id = ? AND current_attachment_lease_id = ? AND state = 'current'`,
          [bound.attachmentId, bound.attachmentLeaseId],
          "transport attachment predecessor release",
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
            successorId,
            bound.attachmentId,
            predecessor.nativeBindingIncarnationId,
            predecessor.runtimeId,
            predecessor.nativeIncarnation,
            parsed.fence.runtimeOwnerServiceLeaseId,
            parsed.fence.runtimeOwnerServiceEpoch,
            parsed.coordinatorFence.coordinatorLeaseId,
            parsed.coordinatorFence.coordinatorEpoch,
            checkedIncrement(bound.transportEpoch, "transport epoch"),
            authority.nowMs,
          ],
          "successor transport lease acquire",
        );
        appendRuntimeAttachmentJournal(
          transaction,
          checkedIncrement(authority.nextRuntimeOwnerJournalOffset, "runtime-owner journal offset"),
          "attachment_lease_acquired",
          successorId,
          parsed.operation,
          parsed.fence,
          authority.nowMs,
        );
        runExactlyOne(
          transaction,
          `UPDATE native_transport_attachments SET current_attachment_lease_id = ?
            WHERE attachment_id = ? AND current_attachment_lease_id IS NULL AND state = 'current'`,
          [successorId, bound.attachmentId],
          "transport attachment successor acquire",
        );
        attachmentLeaseId = successorId;
      }
      if (bound !== null) {
        runExactlyOne(
          transaction,
          `UPDATE binding_lifecycle_gates
              SET current_attachment_lease_id = ?, phase = 'recovering',
                  gate_generation = ?, updated_at_ms = ?
            WHERE native_binding_id = ? AND gate_generation = ?`,
          [
            attachmentLeaseId,
            checkedIncrement(bound.gateGeneration, "binding gate generation"),
            authority.nowMs,
            predecessor.nativeBindingId,
            bound.gateGeneration,
          ],
          "reattach recovery gate",
        );
      }
      const lease = parseNativeConversationLeaseRecord({
        nativeConversationLeaseId: parsed.nativeConversationLeaseId,
        collaborationServerId: predecessor.collaborationServerId,
        logicalChatId: predecessor.logicalChatId,
        nativeBindingId: predecessor.nativeBindingId,
        registrationAttemptId: predecessor.registrationAttemptId,
        runtimeId: predecessor.runtimeId,
        nativeIncarnation: predecessor.nativeIncarnation,
        nativeBindingIncarnationId: predecessor.nativeBindingIncarnationId,
        attachmentLeaseId,
        runtimeOwnerServiceLeaseId: parsed.fence.runtimeOwnerServiceLeaseId,
        runtimeOwnerServiceEpoch: parsed.fence.runtimeOwnerServiceEpoch,
        coordinatorLeaseId: parsed.coordinatorFence.coordinatorLeaseId,
        coordinatorEpoch: parsed.coordinatorFence.coordinatorEpoch,
        protectedPortHandleId: parsed.protectedPortHandleId,
        leaseGeneration: successorGeneration,
        supersedesNativeConversationLeaseId: predecessor.nativeConversationLeaseId,
        currentPublicationId: null,
        nextOperationSequence: 1,
        acquiredAtMs: authority.nowMs,
        updatedAtMs: authority.nowMs,
        closedAtMs: null,
        state: "recovering",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO native_conversation_leases (
           native_conversation_lease_id, collaboration_server_id, logical_chat_id,
           native_binding_id, registration_attempt_id, runtime_id, native_incarnation,
           native_binding_incarnation_id, attachment_lease_id,
           runtime_owner_service_lease_id, runtime_owner_service_epoch,
           coordinator_lease_id, coordinator_epoch, protected_port_handle_id,
           lease_generation, supersedes_native_conversation_lease_id,
           current_publication_id, next_operation_sequence, acquired_at_ms,
           updated_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL, 'recovering')`,
        [
          lease.nativeConversationLeaseId,
          lease.collaborationServerId,
          lease.logicalChatId,
          lease.nativeBindingId,
          lease.registrationAttemptId,
          lease.runtimeId,
          lease.nativeIncarnation,
          lease.nativeBindingIncarnationId,
          lease.attachmentLeaseId,
          lease.runtimeOwnerServiceLeaseId,
          lease.runtimeOwnerServiceEpoch,
          lease.coordinatorLeaseId,
          lease.coordinatorEpoch,
          lease.protectedPortHandleId,
          lease.leaseGeneration,
          lease.supersedesNativeConversationLeaseId,
          lease.acquiredAtMs,
          lease.updatedAtMs,
        ],
        "native conversation lease reattach",
      );
      const operation = appendOperation(
        transaction,
        lease,
        parsed.operation,
        "reattach",
        authority.nowMs,
        parsed.fence,
        parsed.coordinatorFence,
      );
      demoteRootedTerminalReservation(transaction, graph);
      return frozen({
        predecessor: parseNativeConversationLeaseRecord({
          ...predecessor,
          nextOperationSequence:
            predecessor.state === "closed"
              ? predecessor.nextOperationSequence
              : checkedIncrement(
                  predecessor.nextOperationSequence,
                  "predecessor operation sequence",
                ),
          state: "closed",
          updatedAtMs: predecessor.state === "closed" ? predecessor.updatedAtMs : authority.nowMs,
          closedAtMs: predecessor.state === "closed" ? predecessor.closedAtMs : authority.nowMs,
        }),
        predecessorCloseOperation: closeOperation,
        lease: updatedLease(lease, {}),
        operation,
        attachmentLeaseId,
        replayed: false,
      });
    });
  }

  reconcileOperation<K extends NativeRegistrationOperationKind>(
    kind: K,
    request: NativeRegistrationOperationRequestByKind[K],
  ): NativeRegistrationOperationReconciliation | null {
    const parsed = parseRegistrationOperationRequest(kind, request);
    verifyRegistrationOperationContract(
      kind,
      parsed as NativeRegistrationOperationInputByKind[K] & {
        readonly operation: RuntimeOwnerOperationEvidence;
      },
    );
    return this.#executor.transaction((transaction) => {
      validateNativeRegistrationRepositorySnapshot(transaction, this.#machineIdentityId, 6);
      const operation = findOperation(transaction, parsed.operation.operationId);
      if (operation === null) return null;
      const lease = findLease(transaction, operation.nativeConversationLeaseId);
      if (lease === null) {
        throw new NativeRegistrationRepositoryPersistenceError(
          "reconciled operation lease is absent",
        );
      }
      assertExactOperation(
        operation,
        parsed.operation,
        kind,
        parsed.nativeConversationLeaseId,
        lease.nativeBindingId,
        parsed.fence,
        parsed.coordinatorFence,
      );
      let gateGeneration: number | null = null;
      if (
        kind === "ready" ||
        kind === "recover" ||
        kind === "drain" ||
        kind === "close" ||
        kind === "reattach"
      ) {
        const expectedGateGeneration = (
          parsed as
            | TransitionNativeConversationLeaseRequest
            | CloseNativeConversationLeaseRequest
            | ReattachNativeConversationLeaseRequest
        ).expectedGateGeneration;
        gateGeneration =
          expectedGateGeneration === null
            ? null
            : checkedIncrement(expectedGateGeneration, "reconciled gate generation");
      }
      return frozen({ operation, lease, gateGeneration });
    });
  }

  readLease(
    nativeConversationLeaseId: NativeConversationLeaseId,
  ): NativeConversationLeaseRecord | null {
    const id = parseCommonLeaseId(nativeConversationLeaseId, "nativeRegistration.readLease.id");
    return this.#executor.transaction((transaction) => findLease(transaction, id));
  }

  readOperation(operationId: A1SafeId): NativeRegistrationOperationRecord | null {
    const id = parseA1SafeId(operationId, "nativeRegistration.readOperation.id");
    return this.#executor.transaction((transaction) => findOperation(transaction, id));
  }

  readInventory(): NativeRegistrationInventory {
    return this.#executor.transaction((transaction) => readInventoryTransaction(transaction));
  }
}

function readInventoryTransaction(
  transaction: HostStateRepositorySqlTransaction,
): NativeRegistrationInventory {
  return frozen({
    leases: frozen(
      sqlAll(
        transaction,
        `SELECT ${selectColumns(LEASE_ROW_KEYS)} FROM native_conversation_leases
          ORDER BY collaboration_server_id, native_binding_id, lease_generation`,
      ).map(leaseFromRow),
    ),
    publications: frozen(
      sqlAll(
        transaction,
        `SELECT ${selectColumns(PUBLICATION_ROW_KEYS)} FROM native_registration_publications
          ORDER BY native_conversation_lease_id, publication_generation`,
      ).map(publicationFromRow),
    ),
    operations: frozen(
      sqlAll(
        transaction,
        `SELECT ${selectColumns(REGISTRATION_OPERATION_ROW_KEYS)} FROM native_registration_operations
          ORDER BY native_conversation_lease_id, operation_sequence`,
      ).map(operationFromRow),
    ),
  });
}

function snapshotAssert(condition: boolean, message: string): asserts condition {
  if (!condition)
    throw new NativeRegistrationRepositoryPersistenceError(`snapshot invalid: ${message}`);
}

interface SnapshotRegistrationAuthority {
  readonly fence: RuntimeOwnerServiceFence;
  readonly coordinatorFence: CoordinatorLeaseFence;
}

function loadSnapshotRegistrationAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  collaborationServerId: CollaborationServerId,
  runtimeOwnerServiceLeaseId: A1SafeId,
  runtimeOwnerServiceEpoch: number,
  coordinatorLeaseId: A1SafeId,
  coordinatorEpoch: number,
  committedAtMs: number,
  subject: string,
): SnapshotRegistrationAuthority {
  const keys = [
    "owner_machine_identity_id",
    "owner_instance_id",
    "owner_process_start_identity_schema_id",
    "owner_process_start_identity_ref",
    "owner_process_start_identity_digest",
    "owner_acquired_at_ms",
    "owner_heartbeat_deadline_ms",
    "owner_released_at_ms",
    "owner_state",
    "coordinator_collaboration_server_id",
    "coordinator_acquired_at_ms",
    "coordinator_heartbeat_deadline_ms",
    "coordinator_released_at_ms",
    "coordinator_state",
  ] as const;
  const value = sqlGet(
    transaction,
    `SELECT l.machine_identity_id AS owner_machine_identity_id, l.owner_instance_id,
            l.owner_process_start_identity_schema_id,
            l.owner_process_start_identity_ref, l.owner_process_start_identity_digest,
            l.acquired_at_ms AS owner_acquired_at_ms,
            l.heartbeat_deadline_ms AS owner_heartbeat_deadline_ms,
            l.released_at_ms AS owner_released_at_ms, l.state AS owner_state,
            c.collaboration_server_id AS coordinator_collaboration_server_id,
            c.acquired_at_ms AS coordinator_acquired_at_ms,
            c.heartbeat_deadline_ms AS coordinator_heartbeat_deadline_ms,
            c.released_at_ms AS coordinator_released_at_ms,
            c.state AS coordinator_state
       FROM runtime_owner_service_leases AS l
       JOIN coordinator_leases AS c
         ON c.collaboration_server_id = ? AND c.coordinator_lease_id = ?
        AND c.coordinator_epoch = ?
      WHERE l.runtime_owner_service_lease_id = ?
        AND l.runtime_owner_service_epoch = ? LIMIT 1`,
    [
      collaborationServerId,
      coordinatorLeaseId,
      coordinatorEpoch,
      runtimeOwnerServiceLeaseId,
      runtimeOwnerServiceEpoch,
    ],
  );
  const row = rawRow(value, keys, "nativeRegistrationSnapshotHistoricalAuthority");
  const ownerReleasedAtMs = row.owner_released_at_ms;
  const coordinatorReleasedAtMs = row.coordinator_released_at_ms;
  snapshotAssert(
    row.owner_machine_identity_id === machineIdentityId &&
      row.coordinator_collaboration_server_id === collaborationServerId &&
      typeof row.owner_acquired_at_ms === "number" &&
      typeof row.owner_heartbeat_deadline_ms === "number" &&
      committedAtMs >= row.owner_acquired_at_ms &&
      committedAtMs < row.owner_heartbeat_deadline_ms &&
      ((row.owner_state === "released" &&
        typeof ownerReleasedAtMs === "number" &&
        committedAtMs <= ownerReleasedAtMs) ||
        (row.owner_state !== "released" && ownerReleasedAtMs === null)) &&
      typeof row.coordinator_acquired_at_ms === "number" &&
      typeof row.coordinator_heartbeat_deadline_ms === "number" &&
      committedAtMs >= row.coordinator_acquired_at_ms &&
      committedAtMs < row.coordinator_heartbeat_deadline_ms &&
      ((row.coordinator_state === "released" &&
        typeof coordinatorReleasedAtMs === "number" &&
        committedAtMs <= coordinatorReleasedAtMs) ||
        (row.coordinator_state !== "released" && coordinatorReleasedAtMs === null)),
    `${subject} was not committed under exact live historical authority`,
  );
  return frozen({
    fence: frozen({
      runtimeOwnerServiceLeaseId,
      runtimeOwnerServiceEpoch,
      ownerInstanceId: parseA1SafeId(
        row.owner_instance_id,
        "nativeRegistrationSnapshotHistoricalAuthority.ownerInstanceId",
      ),
      ownerProcessStartIdentitySchemaId: parseNonEmptyString(
        row.owner_process_start_identity_schema_id,
        "nativeRegistrationSnapshotHistoricalAuthority.ownerProcessStartIdentitySchemaId",
      ),
      ownerProcessStartIdentityRef: parseA1SafeId(
        row.owner_process_start_identity_ref,
        "nativeRegistrationSnapshotHistoricalAuthority.ownerProcessStartIdentityRef",
      ),
      ownerProcessStartIdentityDigest: parseA1Digest(
        row.owner_process_start_identity_digest,
        "nativeRegistrationSnapshotHistoricalAuthority.ownerProcessStartIdentityDigest",
      ),
    }),
    coordinatorFence: frozen({
      collaborationServerId,
      coordinatorLeaseId: parseA1CanonicalId(
        "coordinatorLease",
        coordinatorLeaseId,
        "nativeRegistrationSnapshotHistoricalAuthority.coordinatorLeaseId",
      ),
      coordinatorEpoch,
    }),
  });
}

function snapshotAssertOperationContract<K extends NativeRegistrationOperationKind>(
  operation: NativeRegistrationOperationRecord,
  kind: K,
  input: NativeRegistrationOperationInputByKind[K],
): void {
  snapshotAssert(
    operation.kind === kind &&
      operation.operationSchemaId === NATIVE_REGISTRATION_OPERATION_SCHEMA_IDS[kind] &&
      sameDigest(
        operation.operationDigest,
        canonicalRegistrationOperationDigest(kind, operation.operationId, input),
      ),
    `operation ${operation.operationId} does not commit its exact ${kind} fact`,
  );
}

function operationEvidenceFromRecord(
  operation: NativeRegistrationOperationRecord,
): RuntimeOwnerOperationEvidence {
  return frozen({
    operationId: operation.operationId,
    operationSchemaId: operation.operationSchemaId,
    operationDigest: operation.operationDigest,
  });
}

function registrationOperationFenceMatchesLease(
  operation: NativeRegistrationOperationRecord,
  lease: NativeConversationLeaseRecord,
): boolean {
  return (
    operation.runtimeOwnerServiceLeaseId === lease.runtimeOwnerServiceLeaseId &&
    operation.runtimeOwnerServiceEpoch === lease.runtimeOwnerServiceEpoch &&
    operation.coordinatorLeaseId === lease.coordinatorLeaseId &&
    operation.coordinatorEpoch === lease.coordinatorEpoch
  );
}

function registrationLeaseFencesMatch(
  left: NativeConversationLeaseRecord,
  right: NativeConversationLeaseRecord,
): boolean {
  return (
    left.runtimeOwnerServiceLeaseId === right.runtimeOwnerServiceLeaseId &&
    left.runtimeOwnerServiceEpoch === right.runtimeOwnerServiceEpoch &&
    left.coordinatorLeaseId === right.coordinatorLeaseId &&
    left.coordinatorEpoch === right.coordinatorEpoch
  );
}

function validateExactNativeRegistrationOperationClosure(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  inventory: NativeRegistrationInventory,
  leasesById: ReadonlyMap<string, NativeConversationLeaseRecord>,
  publicationsByLease: ReadonlyMap<string, readonly NativeRegistrationPublicationRecord[]>,
  operationsByLease: ReadonlyMap<string, readonly NativeRegistrationOperationRecord[]>,
): void {
  const successorsByPredecessor = new Map<string, NativeConversationLeaseRecord>();
  for (const lease of inventory.leases) {
    if (lease.supersedesNativeConversationLeaseId !== null) {
      snapshotAssert(
        !successorsByPredecessor.has(lease.supersedesNativeConversationLeaseId),
        `lease ${lease.supersedesNativeConversationLeaseId} has multiple successors`,
      );
      successorsByPredecessor.set(lease.supersedesNativeConversationLeaseId, lease);
    }
  }
  const projectedGateByBinding = new Map<string, number | null>();
  const projectedBoundByBinding = new Map<string, boolean>();
  const latestByBinding = new Map<string, NativeConversationLeaseRecord>();
  for (const lease of inventory.leases) {
    const graph = loadReservation(
      transaction,
      lease.collaborationServerId,
      lease.registrationAttemptId,
      lease.nativeBindingId,
    );
    const operations = operationsByLease.get(lease.nativeConversationLeaseId) ?? [];
    const publications = publicationsByLease.get(lease.nativeConversationLeaseId) ?? [];
    const opening = operations[0];
    snapshotAssert(opening !== undefined, `lease ${lease.nativeConversationLeaseId} has no ledger`);
    let previousOperationAtMs = lease.acquiredAtMs;
    for (const operation of operations) {
      snapshotAssert(
        operation.committedAtMs >= previousOperationAtMs &&
          operation.committedAtMs <= lease.updatedAtMs,
        `operation ${operation.operationId} is outside its lease update timeline`,
      );
      previousOperationAtMs = operation.committedAtMs;
      loadSnapshotRegistrationAuthority(
        transaction,
        machineIdentityId,
        lease.collaborationServerId,
        operation.runtimeOwnerServiceLeaseId,
        operation.runtimeOwnerServiceEpoch,
        operation.coordinatorLeaseId,
        operation.coordinatorEpoch,
        operation.committedAtMs,
        `operation ${operation.operationId}`,
      );
      const successor = successorsByPredecessor.get(lease.nativeConversationLeaseId);
      snapshotAssert(
        operation.kind === "close"
          ? registrationOperationFenceMatchesLease(operation, lease) ||
              (successor !== undefined &&
                registrationOperationFenceMatchesLease(operation, successor) &&
                operation.committedAtMs === successor.acquiredAtMs)
          : registrationOperationFenceMatchesLease(operation, lease),
        `operation ${operation.operationId} has an invalid author fence tuple`,
      );
    }
    snapshotAssert(
      operations.at(-1)?.committedAtMs === lease.updatedAtMs,
      `lease ${lease.nativeConversationLeaseId} update root is not its final operation`,
    );

    const openingAuthority = loadSnapshotRegistrationAuthority(
      transaction,
      machineIdentityId,
      lease.collaborationServerId,
      opening.runtimeOwnerServiceLeaseId,
      opening.runtimeOwnerServiceEpoch,
      opening.coordinatorLeaseId,
      opening.coordinatorEpoch,
      opening.committedAtMs,
      `opening operation ${opening.operationId}`,
    );
    snapshotAssert(
      opening.committedAtMs === lease.acquiredAtMs,
      `lease ${lease.nativeConversationLeaseId} opening time is not exact`,
    );
    let projectedBound: boolean;
    let projectedGate: number | null;
    let projectedState: NativeConversationLeaseRecord["state"];
    if (lease.leaseGeneration === 1) {
      projectedBound = false;
      projectedGate = null;
      projectedState = graph.initialPhase;
      snapshotAssertOperationContract(opening, "open", {
        fence: openingAuthority.fence,
        coordinatorFence: openingAuthority.coordinatorFence,
        nativeConversationLeaseId: lease.nativeConversationLeaseId,
        registrationAttemptId: lease.registrationAttemptId,
        nativeBindingId: lease.nativeBindingId,
        runtimeId: lease.runtimeId,
        nativeIncarnation: lease.nativeIncarnation,
        protectedPortHandleId: lease.protectedPortHandleId,
      });
    } else {
      const predecessor =
        lease.supersedesNativeConversationLeaseId === null
          ? undefined
          : leasesById.get(lease.supersedesNativeConversationLeaseId);
      snapshotAssert(
        predecessor !== undefined,
        `lease ${lease.nativeConversationLeaseId} reattach predecessor is absent`,
      );
      const predecessorOperations =
        operationsByLease.get(predecessor.nativeConversationLeaseId) ?? [];
      const predecessorClose = predecessorOperations.at(-1);
      snapshotAssert(
        predecessorClose?.kind === "close",
        `lease ${lease.nativeConversationLeaseId} predecessor close proof is absent`,
      );
      projectedBound = projectedBoundByBinding.get(lease.nativeBindingId) ?? false;
      projectedGate = projectedGateByBinding.get(lease.nativeBindingId) ?? null;
      const inferredSuccessorAttachmentLeaseId =
        lease.attachmentLeaseId === predecessor.attachmentLeaseId ? null : lease.attachmentLeaseId;
      const fencesChanged = !registrationLeaseFencesMatch(lease, predecessor);
      snapshotAssert(
        projectedBound === (lease.nativeBindingIncarnationId !== null) &&
          (projectedBound
            ? fencesChanged === (inferredSuccessorAttachmentLeaseId !== null)
            : inferredSuccessorAttachmentLeaseId === null),
        `lease ${lease.nativeConversationLeaseId} reattach transport/fence projection is invalid`,
      );
      const baseInput = {
        fence: openingAuthority.fence,
        coordinatorFence: openingAuthority.coordinatorFence,
        predecessorCloseOperation: operationEvidenceFromRecord(predecessorClose),
        predecessorNativeConversationLeaseId: predecessor.nativeConversationLeaseId,
        nativeConversationLeaseId: lease.nativeConversationLeaseId,
        protectedPortHandleId: lease.protectedPortHandleId,
        successorAttachmentLeaseId: inferredSuccessorAttachmentLeaseId,
      };
      const regularInput = { ...baseInput, expectedGateGeneration: projectedGate };
      const regularMatches =
        opening.kind === "reattach" &&
        opening.operationSchemaId === NATIVE_REGISTRATION_OPERATION_SCHEMA_IDS.reattach &&
        sameDigest(
          opening.operationDigest,
          canonicalRegistrationOperationDigest("reattach", opening.operationId, regularInput),
        );
      let expectedGateGeneration = projectedGate;
      if (!regularMatches && projectedGate !== null && projectedGate > 1) {
        const forcedGateGeneration = projectedGate - 1;
        const forcedInput = { ...baseInput, expectedGateGeneration: forcedGateGeneration };
        snapshotAssert(
          opening.kind === "reattach" &&
            opening.operationSchemaId === NATIVE_REGISTRATION_OPERATION_SCHEMA_IDS.reattach &&
            sameDigest(
              opening.operationDigest,
              canonicalRegistrationOperationDigest("reattach", opening.operationId, forcedInput),
            ) &&
            predecessorClose.committedAtMs === opening.committedAtMs &&
            predecessor.closedAtMs === lease.acquiredAtMs,
          `operation ${opening.operationId} is not an exact regular or forced-close reattach`,
        );
        expectedGateGeneration = forcedGateGeneration;
      } else {
        snapshotAssert(
          regularMatches,
          `operation ${opening.operationId} does not commit its exact reattach fact`,
        );
      }
      if (inferredSuccessorAttachmentLeaseId !== null) {
        const journalKeys = [
          "journal_offset",
          "entry_kind",
          "subject_id",
          "operation_id",
          "operation_schema_id",
          "operation_digest",
          "runtime_owner_service_lease_id",
          "runtime_owner_service_epoch",
          "committed_at_ms",
        ] as const;
        const detached = rawRow(
          sqlGet(
            transaction,
            `SELECT journal_offset, entry_kind, subject_id, operation_id,
                    operation_schema_id, operation_digest,
                    runtime_owner_service_lease_id, runtime_owner_service_epoch,
                    committed_at_ms
               FROM runtime_owner_journal_entries
              WHERE entry_kind = 'attachment_detached' AND subject_id = ? LIMIT 1`,
            [predecessor.attachmentLeaseId],
          ),
          journalKeys,
          "nativeRegistrationSnapshotReattachDetachJournal",
        );
        const acquired = rawRow(
          sqlGet(
            transaction,
            `SELECT journal_offset, entry_kind, subject_id, operation_id,
                    operation_schema_id, operation_digest,
                    runtime_owner_service_lease_id, runtime_owner_service_epoch,
                    committed_at_ms
               FROM runtime_owner_journal_entries
              WHERE entry_kind = 'attachment_lease_acquired' AND subject_id = ? LIMIT 1`,
            [inferredSuccessorAttachmentLeaseId],
          ),
          journalKeys,
          "nativeRegistrationSnapshotReattachAcquireJournal",
        );
        snapshotAssert(
          typeof detached.journal_offset === "number" &&
            typeof acquired.journal_offset === "number" &&
            detached.journal_offset < acquired.journal_offset &&
            detached.entry_kind === "attachment_detached" &&
            detached.subject_id === predecessor.attachmentLeaseId &&
            detached.operation_id === predecessorClose.operationId &&
            detached.operation_schema_id === predecessorClose.operationSchemaId &&
            detached.operation_digest === predecessorClose.operationDigest &&
            detached.runtime_owner_service_lease_id === lease.runtimeOwnerServiceLeaseId &&
            detached.runtime_owner_service_epoch === lease.runtimeOwnerServiceEpoch &&
            detached.committed_at_ms === lease.acquiredAtMs &&
            acquired.entry_kind === "attachment_lease_acquired" &&
            acquired.subject_id === inferredSuccessorAttachmentLeaseId &&
            acquired.operation_id === opening.operationId &&
            acquired.operation_schema_id === opening.operationSchemaId &&
            acquired.operation_digest === opening.operationDigest &&
            acquired.runtime_owner_service_lease_id === lease.runtimeOwnerServiceLeaseId &&
            acquired.runtime_owner_service_epoch === lease.runtimeOwnerServiceEpoch &&
            acquired.committed_at_ms === lease.acquiredAtMs,
          `lease ${lease.nativeConversationLeaseId} runtime reattach journals are not exact and ordered`,
        );
      }
      projectedState = "recovering";
      if (expectedGateGeneration !== null) {
        projectedGate = expectedGateGeneration + 1;
      }
    }

    let publicationIndex = 0;
    let activePublicationId: A1SafeId | null = null;
    let sawBind = false;
    let closed = false;
    for (const operation of operations.slice(1)) {
      const authority = loadSnapshotRegistrationAuthority(
        transaction,
        machineIdentityId,
        lease.collaborationServerId,
        operation.runtimeOwnerServiceLeaseId,
        operation.runtimeOwnerServiceEpoch,
        operation.coordinatorLeaseId,
        operation.coordinatorEpoch,
        operation.committedAtMs,
        `operation ${operation.operationId}`,
      );
      snapshotAssert(!closed, `lease ${lease.nativeConversationLeaseId} mutates after close`);
      switch (operation.kind) {
        case "bind": {
          snapshotAssert(
            !projectedBound &&
              !sawBind &&
              lease.nativeBindingIncarnationId !== null &&
              lease.attachmentLeaseId !== null,
            `operation ${operation.operationId} is not the unique binding fact`,
          );
          snapshotAssertOperationContract(operation, "bind", {
            fence: authority.fence,
            coordinatorFence: authority.coordinatorFence,
            nativeConversationLeaseId: lease.nativeConversationLeaseId,
            nativeBindingIncarnationId: lease.nativeBindingIncarnationId,
            attachmentLeaseId: lease.attachmentLeaseId,
          });
          projectedBound = true;
          projectedGate = 1;
          sawBind = true;
          break;
        }
        case "publish": {
          const publication = publications[publicationIndex];
          snapshotAssert(
            projectedBound &&
              publication !== undefined &&
              publication.publishedAtMs === operation.committedAtMs,
            `operation ${operation.operationId} has no exact publication fact`,
          );
          snapshotAssertOperationContract(operation, "publish", {
            fence: authority.fence,
            coordinatorFence: authority.coordinatorFence,
            nativeConversationLeaseId: lease.nativeConversationLeaseId,
            nativeRegistrationPublicationId: publication.nativeRegistrationPublicationId,
            publicationGeneration: publication.publicationGeneration,
            metadataSchemaId: publication.metadataSchemaId,
            metadataRef: publication.metadataRef,
            metadataDigest: publication.metadataDigest,
            capabilitiesRef: publication.capabilitiesRef,
            capabilitiesDigest: publication.capabilitiesDigest,
          });
          activePublicationId = publication.nativeRegistrationPublicationId;
          publicationIndex += 1;
          break;
        }
        case "ready":
        case "recover":
        case "drain": {
          snapshotAssert(
            projectedBound && projectedGate !== null,
            `operation ${operation.operationId} transitions an unbound lease`,
          );
          const targetState =
            operation.kind === "ready"
              ? "ready"
              : operation.kind === "recover"
                ? "recovering"
                : "draining";
          snapshotAssert(
            leaseTransitionAllowed(projectedState, targetState),
            `operation ${operation.operationId} is an illegal lifecycle edge`,
          );
          if (operation.kind === "ready") {
            snapshotAssert(
              activePublicationId !== null,
              `operation ${operation.operationId} readies without a publication`,
            );
            snapshotAssertOperationContract(operation, "ready", {
              fence: authority.fence,
              coordinatorFence: authority.coordinatorFence,
              nativeConversationLeaseId: lease.nativeConversationLeaseId,
              expectedGateGeneration: projectedGate,
              expectedPublicationId: activePublicationId,
            });
          } else {
            snapshotAssertOperationContract(operation, operation.kind, {
              fence: authority.fence,
              coordinatorFence: authority.coordinatorFence,
              nativeConversationLeaseId: lease.nativeConversationLeaseId,
              expectedGateGeneration: projectedGate,
            });
          }
          projectedGate += 1;
          projectedState = targetState;
          break;
        }
        case "close": {
          snapshotAssertOperationContract(operation, "close", {
            fence: authority.fence,
            coordinatorFence: authority.coordinatorFence,
            nativeConversationLeaseId: lease.nativeConversationLeaseId,
            expectedGateGeneration: projectedBound ? projectedGate : null,
          });
          if (projectedGate !== null) projectedGate += 1;
          projectedState = "closed";
          closed = true;
          break;
        }
        case "open":
        case "reattach":
          snapshotAssert(false, `operation ${operation.operationId} repeats lease opening`);
      }
    }
    snapshotAssert(
      publicationIndex === publications.length,
      `lease ${lease.nativeConversationLeaseId} has an unreachable publication row`,
    );
    snapshotAssert(
      projectedState === lease.state &&
        projectedBound === (lease.nativeBindingIncarnationId !== null) &&
        lease.currentPublicationId === activePublicationId,
      `lease ${lease.nativeConversationLeaseId} facts do not match its exact operation projection`,
    );
    for (const [index, publication] of publications.entries()) {
      const shouldBeCurrent = lease.state !== "closed" && index === publications.length - 1;
      snapshotAssert(
        publication.state === (shouldBeCurrent ? "current" : "superseded") &&
          publication.metadataSchemaId === graph.metadataSchemaId &&
          sameDigest(publication.metadataDigest, graph.metadataDigest) &&
          (graph.capabilitiesDigest === null ||
            sameDigest(publication.capabilitiesDigest, graph.capabilitiesDigest)),
        `publication ${publication.nativeRegistrationPublicationId} is not exact A1.2 intent evidence`,
      );
    }
    projectedBoundByBinding.set(lease.nativeBindingId, projectedBound);
    projectedGateByBinding.set(lease.nativeBindingId, projectedGate);
    latestByBinding.set(lease.nativeBindingId, lease);
  }
  for (const [bindingId, latest] of latestByBinding) {
    const projectedBound = projectedBoundByBinding.get(bindingId) ?? false;
    const projectedGate = projectedGateByBinding.get(bindingId) ?? null;
    if (!projectedBound) {
      snapshotAssert(
        projectedGate === null &&
          latest.nativeBindingIncarnationId === null &&
          latest.attachmentLeaseId === null,
        `binding ${bindingId} has an unclosed projected binding edge`,
      );
      continue;
    }
    const value = sqlGet(
      transaction,
      `SELECT gate_generation, phase, native_binding_incarnation_id,
              current_attachment_lease_id
         FROM binding_lifecycle_gates WHERE native_binding_id = ? LIMIT 1`,
      [bindingId],
    );
    const row = rawRow(
      value,
      [
        "gate_generation",
        "phase",
        "native_binding_incarnation_id",
        "current_attachment_lease_id",
      ] as const,
      "nativeRegistrationSnapshotProjectedGate",
    );
    snapshotAssert(
      row.gate_generation === projectedGate &&
        row.phase === (latest.state === "closed" ? "recovering" : latest.state) &&
        row.native_binding_incarnation_id === latest.nativeBindingIncarnationId &&
        row.current_attachment_lease_id === latest.attachmentLeaseId,
      `binding ${bindingId} lifecycle gate does not close its operation projection`,
    );
  }
}

/**
 * Semantic validator for the complete A1.4 durable-registration subgraph.
 * It validates every historical fence at commit time while retaining a stale latest open lease as
 * recoverable crash evidence. Ephemeral callable-port liveness is intentionally outside this store.
 */
export function validateNativeRegistrationRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  schemaVersion = 5,
): void {
  const machine = parseMachineIdentityId(
    machineIdentityId,
    "validateNativeRegistrationRepositorySnapshot.machineIdentityId",
  );
  const allowRootedTerminal = schemaVersion >= 6;
  const inventory = readInventoryTransaction(transaction);
  const leasesById = new Map(
    inventory.leases.map((lease) => [lease.nativeConversationLeaseId, lease] as const),
  );
  const publicationsByLease = new Map<string, NativeRegistrationPublicationRecord[]>();
  const operationsByLease = new Map<string, NativeRegistrationOperationRecord[]>();
  for (const publication of inventory.publications) {
    const group = publicationsByLease.get(publication.nativeConversationLeaseId) ?? [];
    group.push(publication);
    publicationsByLease.set(publication.nativeConversationLeaseId, group);
    snapshotAssert(
      leasesById.has(publication.nativeConversationLeaseId),
      `publication ${publication.nativeRegistrationPublicationId} has no lease`,
    );
  }
  for (const operation of inventory.operations) {
    const group = operationsByLease.get(operation.nativeConversationLeaseId) ?? [];
    group.push(operation);
    operationsByLease.set(operation.nativeConversationLeaseId, group);
    snapshotAssert(
      leasesById.has(operation.nativeConversationLeaseId),
      `operation ${operation.operationId} has no lease`,
    );
  }
  const latestByBinding = new Map<string, NativeConversationLeaseRecord>();
  for (const lease of inventory.leases) {
    const graph = loadReservation(
      transaction,
      lease.collaborationServerId,
      lease.registrationAttemptId,
      lease.nativeBindingId,
      allowRootedTerminal,
    );
    verifyReservationEvidence(transaction, graph);
    snapshotAssert(
      graph.logicalChatId === lease.logicalChatId,
      `lease ${lease.nativeConversationLeaseId} does not match its reservation chat`,
    );
    loadSnapshotRegistrationAuthority(
      transaction,
      machine,
      lease.collaborationServerId,
      lease.runtimeOwnerServiceLeaseId,
      lease.runtimeOwnerServiceEpoch,
      lease.coordinatorLeaseId,
      lease.coordinatorEpoch,
      lease.acquiredAtMs,
      `lease ${lease.nativeConversationLeaseId}`,
    );
    const operations = operationsByLease.get(lease.nativeConversationLeaseId) ?? [];
    snapshotAssert(
      operations.length === lease.nextOperationSequence - 1,
      `lease ${lease.nativeConversationLeaseId} operation root is not contiguous`,
    );
    for (const [index, operation] of operations.entries()) {
      snapshotAssert(
        operation.operationSequence === index + 1 &&
          operation.nativeBindingId === lease.nativeBindingId &&
          operation.committedAtMs >= lease.acquiredAtMs,
        `lease ${lease.nativeConversationLeaseId} operation sequence is invalid`,
      );
    }
    snapshotAssert(
      operations[0]?.kind === (lease.leaseGeneration === 1 ? "open" : "reattach"),
      `lease ${lease.nativeConversationLeaseId} has no exact opening operation`,
    );
    snapshotAssert(
      (lease.state === "closed") === (operations.at(-1)?.kind === "close"),
      `lease ${lease.nativeConversationLeaseId} close ledger disagrees with lifecycle`,
    );
    const publications = publicationsByLease.get(lease.nativeConversationLeaseId) ?? [];
    for (const [index, publication] of publications.entries()) {
      snapshotAssert(
        publication.publicationGeneration === index + 1 &&
          publication.nativeBindingId === lease.nativeBindingId &&
          publication.runtimeId === lease.runtimeId &&
          publication.nativeIncarnation === lease.nativeIncarnation &&
          publication.nativeBindingIncarnationId === lease.nativeBindingIncarnationId &&
          publication.attachmentLeaseId === lease.attachmentLeaseId,
        `lease ${lease.nativeConversationLeaseId} publication graph is invalid`,
      );
      try {
        verifyNativeRegistrationMetadataEvidence(
          readArtifact(
            transaction,
            "native_binding",
            lease.nativeBindingId,
            publication.metadataRef,
            NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
            publication.metadataDigest,
          ),
          publication.metadataDigest,
          publication.metadataSchemaId,
        );
        verifyNativeConversationCapabilitiesEvidence(
          readArtifact(
            transaction,
            "native_binding",
            lease.nativeBindingId,
            publication.capabilitiesRef,
            NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
            publication.capabilitiesDigest,
          ),
          publication.capabilitiesDigest,
        );
      } catch (error) {
        throw new NativeRegistrationRepositoryPersistenceError(
          `snapshot invalid: publication ${publication.nativeRegistrationPublicationId} evidence failed`,
          { cause: error },
        );
      }
    }
    const currentPublication = publications.find(({ state }) => state === "current") ?? null;
    snapshotAssert(
      lease.state === "closed"
        ? currentPublication === null
        : lease.currentPublicationId ===
            (currentPublication?.nativeRegistrationPublicationId ?? null),
      `lease ${lease.nativeConversationLeaseId} publication pointer is not exact`,
    );
    if (lease.leaseGeneration === 1) {
      snapshotAssert(
        lease.supersedesNativeConversationLeaseId === null,
        `founding lease ${lease.nativeConversationLeaseId} has a predecessor`,
      );
    } else {
      const predecessor =
        lease.supersedesNativeConversationLeaseId === null
          ? undefined
          : leasesById.get(lease.supersedesNativeConversationLeaseId);
      snapshotAssert(
        predecessor !== undefined &&
          predecessor.state === "closed" &&
          predecessor.collaborationServerId === lease.collaborationServerId &&
          predecessor.logicalChatId === lease.logicalChatId &&
          predecessor.nativeBindingId === lease.nativeBindingId &&
          predecessor.registrationAttemptId === lease.registrationAttemptId &&
          predecessor.runtimeId === lease.runtimeId &&
          predecessor.nativeIncarnation === lease.nativeIncarnation &&
          predecessor.nativeBindingIncarnationId === lease.nativeBindingIncarnationId &&
          predecessor.leaseGeneration + 1 === lease.leaseGeneration &&
          predecessor.closedAtMs !== null &&
          predecessor.closedAtMs <= lease.acquiredAtMs,
        `lease ${lease.nativeConversationLeaseId} predecessor chain is invalid`,
      );
      snapshotAssert(
        retainedPublicationAllowsLiveReattach(transaction, predecessor) !== false,
        `lease ${lease.nativeConversationLeaseId} reattached without retained capability`,
      );
    }
    if (lease.nativeBindingIncarnationId !== null && lease.attachmentLeaseId !== null) {
      loadBoundGraph(
        transaction,
        lease,
        lease.nativeBindingIncarnationId,
        lease.attachmentLeaseId,
        graph,
        "persisted",
        lease.state === "closed" ? "historical" : "current",
      );
    }
    const priorLatest = latestByBinding.get(lease.nativeBindingId);
    snapshotAssert(
      priorLatest === undefined || priorLatest.leaseGeneration < lease.leaseGeneration,
      `binding ${lease.nativeBindingId} lease generations are not ordered`,
    );
    latestByBinding.set(lease.nativeBindingId, lease);
  }
  validateExactNativeRegistrationOperationClosure(
    transaction,
    machine,
    inventory,
    leasesById,
    publicationsByLease,
    operationsByLease,
  );
  const activatedBindings = sqlAll(
    transaction,
    `SELECT native_binding_id FROM native_bindings WHERE state = 'current'
      ORDER BY native_binding_id`,
  );
  for (const value of activatedBindings) {
    const row = rawRow(value, ["native_binding_id"] as const, "activatedNativeBinding");
    const bindingId = parseA1CanonicalId(
      "nativeBinding",
      row.native_binding_id,
      "activatedNativeBinding.nativeBindingId",
    );
    const latest = latestByBinding.get(bindingId);
    snapshotAssert(
      latest !== undefined &&
        latest.nativeBindingIncarnationId !== null &&
        latest.attachmentLeaseId !== null,
      `activated binding ${bindingId} has no durable registration lease closure`,
    );
  }
}

export function createNativeRegistrationRepositoryOperations(
  executor: HostStateRepositoryTransactionExecutor,
  machineIdentityId: string,
  options: NativeRegistrationRepositoryOptions = {},
): NativeRegistrationRepositoryOperations {
  return new BoundNativeRegistrationRepository(executor, machineIdentityId, options);
}

export function createNativeRegistrationRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  options: NativeRegistrationRepositoryOptions = {},
): NativeRegistrationRepositoryOperations {
  return new BoundNativeRegistrationRepository(
    { transaction: (operation) => operation(transaction) },
    machineIdentityId,
    options,
  );
}
