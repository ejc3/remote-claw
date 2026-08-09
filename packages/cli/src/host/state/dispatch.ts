import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  sha256,
  timingSafeEqual,
} from "@remote-claw/clawsec";
import type { NativeConversationRef, NativeEngineDescriptor } from "../native/adapter.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type DispatchAuthorization,
  HostStateContractError,
  type InwardEdgeId,
  type LogicalChatId,
  type NativeBindingId,
  type NativeDeliveryAttemptId,
  type NativeRuntimeId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseDispatchAuthorization,
} from "./ids.js";
import { type ProtectedHandleRef, parseProtectedHandleRef } from "./protected.js";
import { parseNativeEngineDescriptor } from "./records.js";
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

export interface A1NativeConversationRef extends NativeConversationRef {
  readonly descriptor: NativeEngineDescriptor;
  readonly runtimeId: NativeRuntimeId;
  readonly conversationId: A1SafeId;
  readonly incarnation: number;
}

export interface A1NativeMutationFence {
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly nativeBindingId: NativeBindingId;
  readonly inwardEdgeId: InwardEdgeId;
  readonly topologyGeneration: number;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly attemptId: NativeDeliveryAttemptId;
  readonly nativeRef: A1NativeConversationRef;
  readonly attachmentLeaseId: A1SafeId;
  readonly capabilitySnapshotId: A1SafeId;
}

export interface PreparedNativeMutation {
  readonly attemptId: NativeDeliveryAttemptId;
  readonly dispatchAuthorizationHandle: DispatchAuthorization;
  readonly canonicalDispatchDigest: A1Digest;
  readonly fence: A1NativeMutationFence;
  readonly canonicalRequestSchemaId: string;
  readonly canonicalRequestRef: A1SafeId;
  readonly canonicalRequestDigest: A1Digest;
}

/**
 * Raw-free correlation data retained across restart for both first-dispatch and
 * evidence-only reconciliation receipts.
 */
export interface NativeDispatchReceiptExpectation {
  readonly attemptId: NativeDeliveryAttemptId;
  readonly canonicalDispatchDigest: A1Digest;
}

export interface NativeDispatchReceipt {
  readonly attemptId: NativeDeliveryAttemptId;
  readonly canonicalDispatchDigest: A1Digest;
  readonly dispatchState:
    | "started"
    | "transport_receipt"
    | "native_observed"
    | "completed"
    | "outcome_unknown";
  readonly nativeReceiptRef: A1SafeId | null;
  readonly nativeReceiptDigest: A1Digest | null;
}

export interface NativeReconciliationEvidence {
  readonly attemptId: NativeDeliveryAttemptId;
  readonly nativeEvidenceSchemaId: string;
  readonly nativeEvidenceRef: A1SafeId;
  readonly nativeEvidenceDigest: A1Digest;
}

/** First-send capability. It is intentionally separate from evidence-only reconciliation. */
export interface NativeFirstDispatchCapability {
  dispatch(prepared: PreparedNativeMutation): Promise<NativeDispatchReceipt>;
}

/** Evidence-only capability. Implementations of this interface have no native-send method. */
export interface NativeReconciliationCapability {
  reconcile(evidence: NativeReconciliationEvidence): Promise<NativeDispatchReceipt>;
}

export const NATIVE_BINDING_MUTATION_FAMILIES = Object.freeze([
  "user_text",
  "steer_text",
  "blank_submit",
  "attachment",
  "clear",
  "interrupt",
  "compact",
  "permission_answer",
  "question_answer",
  "set_model",
  "set_mode",
  "end",
  "fork",
  "archive",
  "unarchive",
  "revert",
  "unrevert",
  "shell",
  "session_command",
  "message_mutation",
  "part_mutation",
  "share",
  "rename",
  "delete",
] as const);

export type NativeBindingMutationFamily = (typeof NATIVE_BINDING_MUTATION_FAMILIES)[number];

export interface NativeDeliveryAttemptRecord {
  readonly nativeDeliveryAttemptId: NativeDeliveryAttemptId;
  readonly commandId: A1SafeId;
  readonly admittingCommandResultId: A1SafeId;
  readonly admittingCommandResultSignedRecordDigest: A1Digest;
  readonly canonicalCommandRecordDigest: A1Digest;
  readonly decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  readonly decisionEvidenceDigest: A1Digest;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly nativeBindingId: NativeBindingId;
  readonly descriptor: NativeEngineDescriptor;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly nativeConversationId: A1SafeId;
  readonly attachmentLeaseId: A1SafeId;
  readonly nativeClientIngressLeaseId: A1SafeId;
  readonly capabilitySnapshotId: A1SafeId;
  readonly capabilitySnapshotAttestationDigest: A1Digest;
  readonly capabilityFamilyDigest: A1Digest;
  readonly mutationFamily: NativeBindingMutationFamily;
  readonly canonicalCommandPayloadSchemaId: string;
  readonly canonicalCommandPayloadDigest: A1Digest;
  readonly nativeRequestTranslatorDigest: A1Digest;
  readonly nativeActionId: A1SafeId | null;
  readonly nativeMethod: string;
  readonly nativeRouteSchemaId: string;
  readonly canonicalRequestSchemaId: string;
  readonly canonicalRequestRef: A1SafeId;
  readonly canonicalRequestDigest: A1Digest;
  readonly nativeRequestTranslationSchemaId: "remote-claw/native-request-translation/v1";
  readonly nativeRequestTranslationRef: A1SafeId;
  readonly nativeRequestTranslationDigest: A1Digest;
  readonly nativeTargetPathDigest: A1Digest;
  readonly positiveReadBackSchemaId: string;
  readonly expectedNativePartCount: number | null;
  readonly expectedNativePartFingerprintSchemaId: string | null;
  readonly expectedNativePartFingerprintVectorRef: A1SafeId | null;
  readonly expectedNativePartFingerprintVectorDigest: A1Digest | null;
  readonly state:
    | "prepared"
    | "claimed"
    | "started"
    | "transport_receipt"
    | "native_observed"
    | "completed"
    | "rejected"
    | "quarantined"
    | "outcome_unknown";
  readonly claimedByCoordinatorEpoch: number | null;
  readonly transportReceiptRef: A1SafeId | null;
  readonly nativeReadBackEvidenceRef: A1SafeId | null;
  readonly nativeReadBackEvidenceDigest: A1Digest | null;
  readonly outcomeEvidenceSchemaId: string | null;
  readonly outcomeEvidenceRef: A1SafeId | null;
  readonly outcomeEvidenceDigest: A1Digest | null;
}

export interface NativeCommandEffectGateRecord {
  readonly commandId: A1SafeId;
  readonly admittingCommandResultId: A1SafeId;
  readonly admittingCommandResultSignedRecordDigest: A1Digest;
  readonly canonicalCommandRecordDigest: A1Digest;
  readonly decisionEvidenceSchemaId: "remote-claw/collaboration-command-decision-evidence/v1";
  readonly decisionEvidenceDigest: A1Digest;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly state: "never_started" | "started" | "completed" | "quarantined" | "outcome_unknown";
  readonly startedAttemptId: NativeDeliveryAttemptId | null;
  readonly outcomeEvidenceSchemaId: string | null;
  readonly outcomeEvidenceRef: A1SafeId | null;
  readonly outcomeEvidenceDigest: A1Digest | null;
}

export interface NativeFrontDoorDispatchRecord {
  readonly nativeDeliveryAttemptId: NativeDeliveryAttemptId;
  readonly nativeClientIngressLeaseId: A1SafeId;
  readonly nativeTargetPathDigest: A1Digest;
  readonly canonicalRequestDigest: A1Digest;
  readonly nativeRequestTranslationDigest: A1Digest;
  readonly dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
  readonly canonicalDispatchDigest: A1Digest;
  readonly dispatchState:
    | "not_started"
    | "started"
    | "completed"
    | "quarantined"
    | "outcome_unknown";
  readonly dispatchStartedAtMs: number | null;
  readonly nativeReceiptRef: A1SafeId | null;
  readonly outcomeEvidenceSchemaId: string | null;
  readonly outcomeEvidenceRef: A1SafeId | null;
  readonly outcomeEvidenceDigest: A1Digest | null;
}

const NATIVE_REF_KEYS = ["descriptor", "runtimeId", "conversationId", "incarnation"] as const;

export function parseA1NativeConversationRef(
  value: unknown,
  field = "nativeRef",
): A1NativeConversationRef {
  const row = parseExactRecord(value, NATIVE_REF_KEYS, field);
  return frozen({
    descriptor: parseNativeEngineDescriptor(row.descriptor, `${field}.descriptor`),
    runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, `${field}.runtimeId`),
    conversationId: parseA1SafeId(row.conversationId, `${field}.conversationId`),
    incarnation: parseNonNegativeSafeInteger(row.incarnation, `${field}.incarnation`),
  });
}

const FENCE_KEYS = [
  "collaborationServerId",
  "logicalChatId",
  "nativeBindingId",
  "inwardEdgeId",
  "topologyGeneration",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "attemptId",
  "nativeRef",
  "attachmentLeaseId",
  "capabilitySnapshotId",
] as const;

export function parseA1NativeMutationFence(value: unknown): A1NativeMutationFence {
  const row = parseExactRecord(value, FENCE_KEYS, "nativeMutationFence");
  return frozen({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeMutationFence.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeMutationFence.logicalChatId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeMutationFence.nativeBindingId",
    ),
    inwardEdgeId: parseA1CanonicalId(
      "inwardEdge",
      row.inwardEdgeId,
      "nativeMutationFence.inwardEdgeId",
    ),
    topologyGeneration: parsePositiveSafeInteger(
      row.topologyGeneration,
      "nativeMutationFence.topologyGeneration",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "nativeMutationFence.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "nativeMutationFence.coordinatorEpoch",
    ),
    attemptId: parseA1CanonicalId(
      "nativeDeliveryAttempt",
      row.attemptId,
      "nativeMutationFence.attemptId",
    ),
    nativeRef: parseA1NativeConversationRef(row.nativeRef, "nativeMutationFence.nativeRef"),
    attachmentLeaseId: parseA1SafeId(
      row.attachmentLeaseId,
      "nativeMutationFence.attachmentLeaseId",
    ),
    capabilitySnapshotId: parseA1SafeId(
      row.capabilitySnapshotId,
      "nativeMutationFence.capabilitySnapshotId",
    ),
  });
}

const PREPARED_KEYS = [
  "attemptId",
  "dispatchAuthorizationHandle",
  "canonicalDispatchDigest",
  "fence",
  "canonicalRequestSchemaId",
  "canonicalRequestRef",
  "canonicalRequestDigest",
] as const;

export function parsePreparedNativeMutation(value: unknown): PreparedNativeMutation {
  const row = parseExactRecord(value, PREPARED_KEYS, "preparedNativeMutation");
  const attemptId = parseA1CanonicalId(
    "nativeDeliveryAttempt",
    row.attemptId,
    "preparedNativeMutation.attemptId",
  );
  const fence = parseA1NativeMutationFence(row.fence);
  if (fence.attemptId !== attemptId) {
    reject("preparedNativeMutation.fence.attemptId", "must match the prepared attempt");
  }
  return frozen({
    attemptId,
    dispatchAuthorizationHandle: parseDispatchAuthorization(
      row.dispatchAuthorizationHandle,
      "preparedNativeMutation.dispatchAuthorizationHandle",
    ),
    canonicalDispatchDigest: parseA1Digest(
      row.canonicalDispatchDigest,
      "preparedNativeMutation.canonicalDispatchDigest",
    ),
    fence,
    canonicalRequestSchemaId: parseNonEmptyString(
      row.canonicalRequestSchemaId,
      "preparedNativeMutation.canonicalRequestSchemaId",
    ),
    canonicalRequestRef: parseA1SafeId(
      row.canonicalRequestRef,
      "preparedNativeMutation.canonicalRequestRef",
    ),
    canonicalRequestDigest: parseA1Digest(
      row.canonicalRequestDigest,
      "preparedNativeMutation.canonicalRequestDigest",
    ),
  });
}

const RECEIPT_KEYS = [
  "attemptId",
  "canonicalDispatchDigest",
  "dispatchState",
  "nativeReceiptRef",
  "nativeReceiptDigest",
] as const;

export function parseNativeDispatchReceipt(value: unknown): NativeDispatchReceipt {
  const row = parseExactRecord(value, RECEIPT_KEYS, "nativeDispatchReceipt");
  const dispatchState = parseEnum(
    row.dispatchState,
    ["started", "transport_receipt", "native_observed", "completed", "outcome_unknown"] as const,
    "nativeDispatchReceipt.dispatchState",
  );
  const nativeReceiptRef = parseNullable(
    row.nativeReceiptRef,
    parseA1SafeId,
    "nativeDispatchReceipt.nativeReceiptRef",
  );
  const nativeReceiptDigest = parseNullable(
    row.nativeReceiptDigest,
    parseA1Digest,
    "nativeDispatchReceipt.nativeReceiptDigest",
  );
  if ((nativeReceiptRef === null) !== (nativeReceiptDigest === null)) {
    reject(
      "nativeDispatchReceipt.nativeReceipt",
      "reference and digest must either both be null or both be present",
    );
  }
  const hasNativeReceipt = nativeReceiptRef !== null;
  switch (dispatchState) {
    case "started":
      if (hasNativeReceipt) {
        reject(
          "nativeDispatchReceipt.nativeReceipt",
          "must be null before a transport or native receipt is recorded",
        );
      }
      break;
    case "transport_receipt":
    case "native_observed":
    case "completed":
      if (!hasNativeReceipt) {
        reject(
          "nativeDispatchReceipt.nativeReceipt",
          `must be present for dispatch state ${JSON.stringify(dispatchState)}`,
        );
      }
      break;
    case "outcome_unknown":
      // The atomic pair may be absent when uncertainty begins before any
      // receipt, or present when a prior receipt is the last proved progress.
      break;
  }
  return frozen({
    attemptId: parseA1CanonicalId(
      "nativeDeliveryAttempt",
      row.attemptId,
      "nativeDispatchReceipt.attemptId",
    ),
    canonicalDispatchDigest: parseA1Digest(
      row.canonicalDispatchDigest,
      "nativeDispatchReceipt.canonicalDispatchDigest",
    ),
    dispatchState,
    nativeReceiptRef,
    nativeReceiptDigest,
  });
}

const RECEIPT_EXPECTATION_KEYS = ["attemptId", "canonicalDispatchDigest"] as const;

export function parseNativeDispatchReceiptExpectation(
  value: unknown,
): NativeDispatchReceiptExpectation {
  const row = parseExactRecord(value, RECEIPT_EXPECTATION_KEYS, "nativeDispatchReceiptExpectation");
  return frozen({
    attemptId: parseA1CanonicalId(
      "nativeDeliveryAttempt",
      row.attemptId,
      "nativeDispatchReceiptExpectation.attemptId",
    ),
    canonicalDispatchDigest: parseA1Digest(
      row.canonicalDispatchDigest,
      "nativeDispatchReceiptExpectation.canonicalDispatchDigest",
    ),
  });
}

export function assertDispatchReceiptMatches(
  expectation: NativeDispatchReceiptExpectation,
  receipt: NativeDispatchReceipt,
): void {
  const parsedExpectation = parseNativeDispatchReceiptExpectation(expectation);
  const parsedReceipt = parseNativeDispatchReceipt(receipt);
  const attemptMatches = parsedExpectation.attemptId === parsedReceipt.attemptId;
  const dispatchMatches = timingSafeEqual(
    base64urlDecode(parsedExpectation.canonicalDispatchDigest),
    base64urlDecode(parsedReceipt.canonicalDispatchDigest),
  );
  if (!attemptMatches || !dispatchMatches) {
    throw new HostStateContractError(
      "nativeDispatchReceipt does not match the expected attempt and dispatch digest",
    );
  }
}

const RECONCILIATION_KEYS = [
  "attemptId",
  "nativeEvidenceSchemaId",
  "nativeEvidenceRef",
  "nativeEvidenceDigest",
] as const;

export function parseNativeReconciliationEvidence(value: unknown): NativeReconciliationEvidence {
  const row = parseExactRecord(value, RECONCILIATION_KEYS, "nativeReconciliationEvidence");
  return frozen({
    attemptId: parseA1CanonicalId(
      "nativeDeliveryAttempt",
      row.attemptId,
      "nativeReconciliationEvidence.attemptId",
    ),
    nativeEvidenceSchemaId: parseNonEmptyString(
      row.nativeEvidenceSchemaId,
      "nativeReconciliationEvidence.nativeEvidenceSchemaId",
    ),
    nativeEvidenceRef: parseA1SafeId(
      row.nativeEvidenceRef,
      "nativeReconciliationEvidence.nativeEvidenceRef",
    ),
    nativeEvidenceDigest: parseA1Digest(
      row.nativeEvidenceDigest,
      "nativeReconciliationEvidence.nativeEvidenceDigest",
    ),
  });
}

const DELIVERY_KEYS = [
  "nativeDeliveryAttemptId",
  "commandId",
  "admittingCommandResultId",
  "admittingCommandResultSignedRecordDigest",
  "canonicalCommandRecordDigest",
  "decisionEvidenceSchemaId",
  "decisionEvidenceDigest",
  "collaborationServerId",
  "logicalChatId",
  "nativeBindingId",
  "descriptor",
  "runtimeId",
  "nativeIncarnation",
  "nativeConversationId",
  "attachmentLeaseId",
  "nativeClientIngressLeaseId",
  "capabilitySnapshotId",
  "capabilitySnapshotAttestationDigest",
  "capabilityFamilyDigest",
  "mutationFamily",
  "canonicalCommandPayloadSchemaId",
  "canonicalCommandPayloadDigest",
  "nativeRequestTranslatorDigest",
  "nativeActionId",
  "nativeMethod",
  "nativeRouteSchemaId",
  "canonicalRequestSchemaId",
  "canonicalRequestRef",
  "canonicalRequestDigest",
  "nativeRequestTranslationSchemaId",
  "nativeRequestTranslationRef",
  "nativeRequestTranslationDigest",
  "nativeTargetPathDigest",
  "positiveReadBackSchemaId",
  "expectedNativePartCount",
  "expectedNativePartFingerprintSchemaId",
  "expectedNativePartFingerprintVectorRef",
  "expectedNativePartFingerprintVectorDigest",
  "state",
  "claimedByCoordinatorEpoch",
  "transportReceiptRef",
  "nativeReadBackEvidenceRef",
  "nativeReadBackEvidenceDigest",
  "outcomeEvidenceSchemaId",
  "outcomeEvidenceRef",
  "outcomeEvidenceDigest",
] as const;

const OPENCODE_USER_TEXT_READ_BACK_SCHEMA_ID = "remote-claw/opencode-user-text-read-back/v1";
const OPENCODE_EXPECTED_USER_PART_VECTOR_SCHEMA_ID =
  "remote-claw/opencode-expected-user-part-vector/v1";
const OPENCODE_MESSAGE_ID_PREFIX = "msg_";

function assertOpenCodeCallerMessageId(value: A1SafeId | null): asserts value is A1SafeId {
  if (value === null || !value.startsWith(OPENCODE_MESSAGE_ID_PREFIX)) {
    reject(
      "nativeDeliveryAttempt.nativeActionId",
      "must be a caller-allocated msg_ identifier for OpenCode user_text",
    );
  }
  const encoded = value.slice(OPENCODE_MESSAGE_ID_PREFIX.length);
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(encoded);
  } catch {
    reject(
      "nativeDeliveryAttempt.nativeActionId",
      "must be msg_ plus canonical unpadded base64url of exactly 16 bytes",
    );
  }
  if (decoded.length !== 16 || base64urlEncode(decoded) !== encoded) {
    reject(
      "nativeDeliveryAttempt.nativeActionId",
      "must be msg_ plus canonical unpadded base64url of exactly 16 bytes",
    );
  }
}

function parseEvidenceTriple(
  row: Record<string, unknown>,
  keyPrefix: string,
  fieldPrefix: string,
): readonly [string | null, A1SafeId | null, A1Digest | null] {
  const schema = parseNullable(
    row[`${keyPrefix}SchemaId`],
    parseNonEmptyString,
    `${fieldPrefix}SchemaId`,
  );
  const ref = parseNullable(row[`${keyPrefix}Ref`], parseA1SafeId, `${fieldPrefix}Ref`);
  const digest = parseNullable(row[`${keyPrefix}Digest`], parseA1Digest, `${fieldPrefix}Digest`);
  if (!((schema === null && ref === null && digest === null) || (schema && ref && digest))) {
    reject(fieldPrefix, "schema, reference, and digest must be all null or all present");
  }
  return [schema, ref, digest] as const;
}

export function parseNativeDeliveryAttemptRecord(value: unknown): NativeDeliveryAttemptRecord {
  const row = parseExactRecord(value, DELIVERY_KEYS, "nativeDeliveryAttempt");
  const descriptor = parseNativeEngineDescriptor(
    row.descriptor,
    "nativeDeliveryAttempt.descriptor",
  );
  const mutationFamily = parseEnum(
    row.mutationFamily,
    NATIVE_BINDING_MUTATION_FAMILIES,
    "nativeDeliveryAttempt.mutationFamily",
  );
  const nativeActionId = parseNullable(
    row.nativeActionId,
    parseA1SafeId,
    "nativeDeliveryAttempt.nativeActionId",
  );
  const positiveReadBackSchemaId = parseNonEmptyString(
    row.positiveReadBackSchemaId,
    "nativeDeliveryAttempt.positiveReadBackSchemaId",
  );
  const expectedNativePartCount = parseNullable(
    row.expectedNativePartCount,
    parsePositiveSafeInteger,
    "nativeDeliveryAttempt.expectedNativePartCount",
  );
  const expectedNativePartFingerprintSchemaId = parseNullable(
    row.expectedNativePartFingerprintSchemaId,
    parseNonEmptyString,
    "nativeDeliveryAttempt.expectedNativePartFingerprintSchemaId",
  );
  const expectedNativePartFingerprintVectorRef = parseNullable(
    row.expectedNativePartFingerprintVectorRef,
    parseA1SafeId,
    "nativeDeliveryAttempt.expectedNativePartFingerprintVectorRef",
  );
  const expectedNativePartFingerprintVectorDigest = parseNullable(
    row.expectedNativePartFingerprintVectorDigest,
    parseA1Digest,
    "nativeDeliveryAttempt.expectedNativePartFingerprintVectorDigest",
  );
  const expectedPartFields = [
    expectedNativePartCount,
    expectedNativePartFingerprintSchemaId,
    expectedNativePartFingerprintVectorRef,
    expectedNativePartFingerprintVectorDigest,
  ];
  const expectedPartsAllNull = expectedPartFields.every((field) => field === null);
  const expectedPartsAllPresent = expectedPartFields.every((field) => field !== null);
  if (!expectedPartsAllNull && !expectedPartsAllPresent) {
    reject(
      "nativeDeliveryAttempt.expectedNativeParts",
      "count, schema, vector reference, and vector digest must be all null or all present",
    );
  }
  if (descriptor.product === "opencode" && mutationFamily === "user_text") {
    assertOpenCodeCallerMessageId(nativeActionId);
    if (expectedNativePartCount !== 1) {
      reject(
        "nativeDeliveryAttempt.expectedNativePartCount",
        "must equal 1 for OpenCode user_text",
      );
    }
    if (expectedNativePartFingerprintSchemaId !== OPENCODE_EXPECTED_USER_PART_VECTOR_SCHEMA_ID) {
      reject(
        "nativeDeliveryAttempt.expectedNativePartFingerprintSchemaId",
        `must equal ${JSON.stringify(OPENCODE_EXPECTED_USER_PART_VECTOR_SCHEMA_ID)} for OpenCode user_text`,
      );
    }
    if (positiveReadBackSchemaId !== OPENCODE_USER_TEXT_READ_BACK_SCHEMA_ID) {
      reject(
        "nativeDeliveryAttempt.positiveReadBackSchemaId",
        `must equal ${JSON.stringify(OPENCODE_USER_TEXT_READ_BACK_SCHEMA_ID)} for OpenCode user_text`,
      );
    }
  }
  const nativeReadBackEvidenceRef = parseNullable(
    row.nativeReadBackEvidenceRef,
    parseA1SafeId,
    "nativeDeliveryAttempt.nativeReadBackEvidenceRef",
  );
  const nativeReadBackEvidenceDigest = parseNullable(
    row.nativeReadBackEvidenceDigest,
    parseA1Digest,
    "nativeDeliveryAttempt.nativeReadBackEvidenceDigest",
  );
  if ((nativeReadBackEvidenceRef === null) !== (nativeReadBackEvidenceDigest === null)) {
    reject(
      "nativeDeliveryAttempt.nativeReadBackEvidence",
      "reference and digest must either both be null or both be present",
    );
  }
  const [outcomeEvidenceSchemaId, outcomeEvidenceRef, outcomeEvidenceDigest] = parseEvidenceTriple(
    row,
    "outcomeEvidence",
    "nativeDeliveryAttempt.outcomeEvidence",
  );
  const state = parseEnum(
    row.state,
    [
      "prepared",
      "claimed",
      "started",
      "transport_receipt",
      "native_observed",
      "completed",
      "rejected",
      "quarantined",
      "outcome_unknown",
    ] as const,
    "nativeDeliveryAttempt.state",
  );
  const claimedByCoordinatorEpoch = parseNullable(
    row.claimedByCoordinatorEpoch,
    parsePositiveSafeInteger,
    "nativeDeliveryAttempt.claimedByCoordinatorEpoch",
  );
  const transportReceiptRef = parseNullable(
    row.transportReceiptRef,
    parseA1SafeId,
    "nativeDeliveryAttempt.transportReceiptRef",
  );
  const hasReadBack = nativeReadBackEvidenceRef !== null;
  const hasOutcomeEvidence = outcomeEvidenceSchemaId !== null;
  if (
    state === "prepared" &&
    (claimedByCoordinatorEpoch !== null ||
      transportReceiptRef !== null ||
      hasReadBack ||
      hasOutcomeEvidence)
  ) {
    reject("nativeDeliveryAttempt.state", "prepared rows cannot contain delivery evidence");
  }
  if (
    state === "claimed" &&
    (claimedByCoordinatorEpoch === null ||
      transportReceiptRef !== null ||
      hasReadBack ||
      hasOutcomeEvidence)
  ) {
    reject(
      "nativeDeliveryAttempt.state",
      "claimed rows require their epoch and cannot contain delivery evidence",
    );
  }
  if (
    (state === "started" ||
      state === "transport_receipt" ||
      state === "native_observed" ||
      state === "completed" ||
      state === "rejected" ||
      state === "outcome_unknown") &&
    claimedByCoordinatorEpoch === null
  ) {
    reject(
      "nativeDeliveryAttempt.claimedByCoordinatorEpoch",
      "must identify the claiming epoch after native dispatch starts",
    );
  }
  if (state === "started" && (transportReceiptRef !== null || hasReadBack || hasOutcomeEvidence)) {
    reject("nativeDeliveryAttempt.state", "started rows cannot contain later delivery evidence");
  }
  if (state === "transport_receipt" && transportReceiptRef === null) {
    reject(
      "nativeDeliveryAttempt.transportReceiptRef",
      "must be present once a transport receipt is recorded",
    );
  }
  if (state === "transport_receipt" && (hasReadBack || hasOutcomeEvidence)) {
    reject(
      "nativeDeliveryAttempt.state",
      "transport-receipt rows cannot contain later read-back or outcome evidence",
    );
  }
  if ((state === "native_observed" || state === "completed") && !hasReadBack) {
    reject(
      "nativeDeliveryAttempt.nativeReadBackEvidence",
      "must be present once native application is observed",
    );
  }
  if ((state === "native_observed" || state === "completed") && hasOutcomeEvidence) {
    reject(
      "nativeDeliveryAttempt.outcomeEvidence",
      "must be null for a positive native observation",
    );
  }
  if (state === "rejected" && hasReadBack) {
    reject(
      "nativeDeliveryAttempt.nativeReadBackEvidence",
      "must be null for a proved negative native outcome",
    );
  }
  if (
    (state === "rejected" || state === "quarantined" || state === "outcome_unknown") &&
    !hasOutcomeEvidence
  ) {
    reject(
      "nativeDeliveryAttempt.outcomeEvidence",
      "must be present for a terminal negative or uncertain outcome",
    );
  }
  if (state === "quarantined" && (transportReceiptRef !== null || hasReadBack)) {
    reject(
      "nativeDeliveryAttempt.state",
      "quarantined rows cannot contain transport or native read-back evidence",
    );
  }

  return frozen({
    nativeDeliveryAttemptId: parseA1CanonicalId(
      "nativeDeliveryAttempt",
      row.nativeDeliveryAttemptId,
      "nativeDeliveryAttempt.nativeDeliveryAttemptId",
    ),
    commandId: parseA1SafeId(row.commandId, "nativeDeliveryAttempt.commandId"),
    admittingCommandResultId: parseA1SafeId(
      row.admittingCommandResultId,
      "nativeDeliveryAttempt.admittingCommandResultId",
    ),
    admittingCommandResultSignedRecordDigest: parseA1Digest(
      row.admittingCommandResultSignedRecordDigest,
      "nativeDeliveryAttempt.admittingCommandResultSignedRecordDigest",
    ),
    canonicalCommandRecordDigest: parseA1Digest(
      row.canonicalCommandRecordDigest,
      "nativeDeliveryAttempt.canonicalCommandRecordDigest",
    ),
    decisionEvidenceSchemaId: parseLiteral(
      row.decisionEvidenceSchemaId,
      "remote-claw/collaboration-command-decision-evidence/v1",
      "nativeDeliveryAttempt.decisionEvidenceSchemaId",
    ),
    decisionEvidenceDigest: parseA1Digest(
      row.decisionEvidenceDigest,
      "nativeDeliveryAttempt.decisionEvidenceDigest",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeDeliveryAttempt.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeDeliveryAttempt.logicalChatId",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeDeliveryAttempt.nativeBindingId",
    ),
    descriptor,
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeDeliveryAttempt.runtimeId",
    ),
    nativeIncarnation: parseNonNegativeSafeInteger(
      row.nativeIncarnation,
      "nativeDeliveryAttempt.nativeIncarnation",
    ),
    nativeConversationId: parseA1SafeId(
      row.nativeConversationId,
      "nativeDeliveryAttempt.nativeConversationId",
    ),
    attachmentLeaseId: parseA1SafeId(
      row.attachmentLeaseId,
      "nativeDeliveryAttempt.attachmentLeaseId",
    ),
    nativeClientIngressLeaseId: parseA1SafeId(
      row.nativeClientIngressLeaseId,
      "nativeDeliveryAttempt.nativeClientIngressLeaseId",
    ),
    capabilitySnapshotId: parseA1SafeId(
      row.capabilitySnapshotId,
      "nativeDeliveryAttempt.capabilitySnapshotId",
    ),
    capabilitySnapshotAttestationDigest: parseA1Digest(
      row.capabilitySnapshotAttestationDigest,
      "nativeDeliveryAttempt.capabilitySnapshotAttestationDigest",
    ),
    capabilityFamilyDigest: parseA1Digest(
      row.capabilityFamilyDigest,
      "nativeDeliveryAttempt.capabilityFamilyDigest",
    ),
    mutationFamily,
    canonicalCommandPayloadSchemaId: parseNonEmptyString(
      row.canonicalCommandPayloadSchemaId,
      "nativeDeliveryAttempt.canonicalCommandPayloadSchemaId",
    ),
    canonicalCommandPayloadDigest: parseA1Digest(
      row.canonicalCommandPayloadDigest,
      "nativeDeliveryAttempt.canonicalCommandPayloadDigest",
    ),
    nativeRequestTranslatorDigest: parseA1Digest(
      row.nativeRequestTranslatorDigest,
      "nativeDeliveryAttempt.nativeRequestTranslatorDigest",
    ),
    nativeActionId,
    nativeMethod: parseNonEmptyString(row.nativeMethod, "nativeDeliveryAttempt.nativeMethod"),
    nativeRouteSchemaId: parseNonEmptyString(
      row.nativeRouteSchemaId,
      "nativeDeliveryAttempt.nativeRouteSchemaId",
    ),
    canonicalRequestSchemaId: parseNonEmptyString(
      row.canonicalRequestSchemaId,
      "nativeDeliveryAttempt.canonicalRequestSchemaId",
    ),
    canonicalRequestRef: parseA1SafeId(
      row.canonicalRequestRef,
      "nativeDeliveryAttempt.canonicalRequestRef",
    ),
    canonicalRequestDigest: parseA1Digest(
      row.canonicalRequestDigest,
      "nativeDeliveryAttempt.canonicalRequestDigest",
    ),
    nativeRequestTranslationSchemaId: parseLiteral(
      row.nativeRequestTranslationSchemaId,
      "remote-claw/native-request-translation/v1",
      "nativeDeliveryAttempt.nativeRequestTranslationSchemaId",
    ),
    nativeRequestTranslationRef: parseA1SafeId(
      row.nativeRequestTranslationRef,
      "nativeDeliveryAttempt.nativeRequestTranslationRef",
    ),
    nativeRequestTranslationDigest: parseA1Digest(
      row.nativeRequestTranslationDigest,
      "nativeDeliveryAttempt.nativeRequestTranslationDigest",
    ),
    nativeTargetPathDigest: parseA1Digest(
      row.nativeTargetPathDigest,
      "nativeDeliveryAttempt.nativeTargetPathDigest",
    ),
    positiveReadBackSchemaId,
    expectedNativePartCount,
    expectedNativePartFingerprintSchemaId,
    expectedNativePartFingerprintVectorRef,
    expectedNativePartFingerprintVectorDigest,
    state,
    claimedByCoordinatorEpoch,
    transportReceiptRef,
    nativeReadBackEvidenceRef,
    nativeReadBackEvidenceDigest,
    outcomeEvidenceSchemaId,
    outcomeEvidenceRef,
    outcomeEvidenceDigest,
  });
}

const GATE_KEYS = [
  "commandId",
  "admittingCommandResultId",
  "admittingCommandResultSignedRecordDigest",
  "canonicalCommandRecordDigest",
  "decisionEvidenceSchemaId",
  "decisionEvidenceDigest",
  "collaborationServerId",
  "logicalChatId",
  "state",
  "startedAttemptId",
  "outcomeEvidenceSchemaId",
  "outcomeEvidenceRef",
  "outcomeEvidenceDigest",
] as const;

export function parseNativeCommandEffectGateRecord(value: unknown): NativeCommandEffectGateRecord {
  const row = parseExactRecord(value, GATE_KEYS, "nativeCommandEffectGate");
  const state = parseEnum(
    row.state,
    ["never_started", "started", "completed", "quarantined", "outcome_unknown"] as const,
    "nativeCommandEffectGate.state",
  );
  const startedAttemptId = parseNullable(
    row.startedAttemptId,
    (_value, field) => parseA1CanonicalId("nativeDeliveryAttempt", _value, field),
    "nativeCommandEffectGate.startedAttemptId",
  );
  if ((state === "never_started" || state === "quarantined") && startedAttemptId !== null) {
    reject(
      "nativeCommandEffectGate.startedAttemptId",
      "must be null when native start never occurred",
    );
  }
  if (
    (state === "started" || state === "completed" || state === "outcome_unknown") &&
    startedAttemptId === null
  ) {
    reject("nativeCommandEffectGate.startedAttemptId", "must identify the started attempt");
  }
  const [outcomeEvidenceSchemaId, outcomeEvidenceRef, outcomeEvidenceDigest] = parseEvidenceTriple(
    row,
    "outcomeEvidence",
    "nativeCommandEffectGate.outcomeEvidence",
  );
  const hasOutcomeEvidence = outcomeEvidenceSchemaId !== null;
  if (
    (state === "never_started" || state === "started" || state === "completed") &&
    hasOutcomeEvidence
  ) {
    reject("nativeCommandEffectGate.outcomeEvidence", "must be null for ordinary progress states");
  }
  if ((state === "quarantined" || state === "outcome_unknown") && !hasOutcomeEvidence) {
    reject(
      "nativeCommandEffectGate.outcomeEvidence",
      "must be present for a quarantined or uncertain outcome",
    );
  }
  return frozen({
    commandId: parseA1SafeId(row.commandId, "nativeCommandEffectGate.commandId"),
    admittingCommandResultId: parseA1SafeId(
      row.admittingCommandResultId,
      "nativeCommandEffectGate.admittingCommandResultId",
    ),
    admittingCommandResultSignedRecordDigest: parseA1Digest(
      row.admittingCommandResultSignedRecordDigest,
      "nativeCommandEffectGate.admittingCommandResultSignedRecordDigest",
    ),
    canonicalCommandRecordDigest: parseA1Digest(
      row.canonicalCommandRecordDigest,
      "nativeCommandEffectGate.canonicalCommandRecordDigest",
    ),
    decisionEvidenceSchemaId: parseLiteral(
      row.decisionEvidenceSchemaId,
      "remote-claw/collaboration-command-decision-evidence/v1",
      "nativeCommandEffectGate.decisionEvidenceSchemaId",
    ),
    decisionEvidenceDigest: parseA1Digest(
      row.decisionEvidenceDigest,
      "nativeCommandEffectGate.decisionEvidenceDigest",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeCommandEffectGate.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeCommandEffectGate.logicalChatId",
    ),
    state,
    startedAttemptId,
    outcomeEvidenceSchemaId,
    outcomeEvidenceRef,
    outcomeEvidenceDigest,
  });
}

const FRONT_DOOR_KEYS = [
  "nativeDeliveryAttemptId",
  "nativeClientIngressLeaseId",
  "nativeTargetPathDigest",
  "canonicalRequestDigest",
  "nativeRequestTranslationDigest",
  "dispatchAuthorizationRef",
  "canonicalDispatchDigest",
  "dispatchState",
  "dispatchStartedAtMs",
  "nativeReceiptRef",
  "outcomeEvidenceSchemaId",
  "outcomeEvidenceRef",
  "outcomeEvidenceDigest",
] as const;

export function parseNativeFrontDoorDispatchRecord(value: unknown): NativeFrontDoorDispatchRecord {
  const row = parseExactRecord(value, FRONT_DOOR_KEYS, "nativeFrontDoorDispatch");
  const dispatchAuthorizationRef = parseProtectedHandleRef(row.dispatchAuthorizationRef);
  if (dispatchAuthorizationRef.kind !== "dispatch_authorization") {
    reject(
      "nativeFrontDoorDispatch.dispatchAuthorizationRef.kind",
      'must equal "dispatch_authorization"',
    );
  }
  const dispatchState = parseEnum(
    row.dispatchState,
    ["not_started", "started", "completed", "quarantined", "outcome_unknown"] as const,
    "nativeFrontDoorDispatch.dispatchState",
  );
  const dispatchStartedAtMs = parseNullable(
    row.dispatchStartedAtMs,
    parseNonNegativeSafeInteger,
    "nativeFrontDoorDispatch.dispatchStartedAtMs",
  );
  if (dispatchState === "not_started" && dispatchStartedAtMs !== null) {
    reject("nativeFrontDoorDispatch.dispatchStartedAtMs", "must be null before dispatch");
  }
  if (
    (dispatchState === "started" ||
      dispatchState === "completed" ||
      dispatchState === "outcome_unknown") &&
    dispatchStartedAtMs === null
  ) {
    reject("nativeFrontDoorDispatch.dispatchStartedAtMs", "must be present after dispatch starts");
  }
  if (dispatchState === "quarantined" && dispatchStartedAtMs !== null) {
    reject(
      "nativeFrontDoorDispatch.dispatchStartedAtMs",
      "must be null when dispatch was quarantined before start",
    );
  }
  const [outcomeEvidenceSchemaId, outcomeEvidenceRef, outcomeEvidenceDigest] = parseEvidenceTriple(
    row,
    "outcomeEvidence",
    "nativeFrontDoorDispatch.outcomeEvidence",
  );
  const nativeReceiptRef = parseNullable(
    row.nativeReceiptRef,
    parseA1SafeId,
    "nativeFrontDoorDispatch.nativeReceiptRef",
  );
  const hasOutcomeEvidence = outcomeEvidenceSchemaId !== null;
  if (dispatchState === "not_started" && (nativeReceiptRef !== null || hasOutcomeEvidence)) {
    reject(
      "nativeFrontDoorDispatch.dispatchState",
      "not-started rows cannot contain native or outcome evidence",
    );
  }
  if ((dispatchState === "started" || dispatchState === "completed") && hasOutcomeEvidence) {
    reject("nativeFrontDoorDispatch.outcomeEvidence", "must be null for a positive dispatch state");
  }
  if (dispatchState === "started" && nativeReceiptRef !== null) {
    reject("nativeFrontDoorDispatch.nativeReceiptRef", "must be null until dispatch is completed");
  }
  if (dispatchState === "completed" && nativeReceiptRef === null) {
    reject(
      "nativeFrontDoorDispatch.nativeReceiptRef",
      "must be present when dispatch is completed",
    );
  }
  if (
    (dispatchState === "quarantined" || dispatchState === "outcome_unknown") &&
    !hasOutcomeEvidence
  ) {
    reject(
      "nativeFrontDoorDispatch.outcomeEvidence",
      "must be present for a quarantined or uncertain outcome",
    );
  }
  if (dispatchState === "quarantined" && nativeReceiptRef !== null) {
    reject(
      "nativeFrontDoorDispatch.nativeReceiptRef",
      "must be null when dispatch was quarantined before start",
    );
  }
  return frozen({
    nativeDeliveryAttemptId: parseA1CanonicalId(
      "nativeDeliveryAttempt",
      row.nativeDeliveryAttemptId,
      "nativeFrontDoorDispatch.nativeDeliveryAttemptId",
    ),
    nativeClientIngressLeaseId: parseA1SafeId(
      row.nativeClientIngressLeaseId,
      "nativeFrontDoorDispatch.nativeClientIngressLeaseId",
    ),
    nativeTargetPathDigest: parseA1Digest(
      row.nativeTargetPathDigest,
      "nativeFrontDoorDispatch.nativeTargetPathDigest",
    ),
    canonicalRequestDigest: parseA1Digest(
      row.canonicalRequestDigest,
      "nativeFrontDoorDispatch.canonicalRequestDigest",
    ),
    nativeRequestTranslationDigest: parseA1Digest(
      row.nativeRequestTranslationDigest,
      "nativeFrontDoorDispatch.nativeRequestTranslationDigest",
    ),
    dispatchAuthorizationRef,
    canonicalDispatchDigest: parseA1Digest(
      row.canonicalDispatchDigest,
      "nativeFrontDoorDispatch.canonicalDispatchDigest",
    ),
    dispatchState,
    dispatchStartedAtMs,
    nativeReceiptRef,
    outcomeEvidenceSchemaId,
    outcomeEvidenceRef,
    outcomeEvidenceDigest,
  });
}

export async function nativeFrontDoorDispatchDigest(
  record: Pick<
    NativeFrontDoorDispatchRecord,
    | "nativeDeliveryAttemptId"
    | "nativeClientIngressLeaseId"
    | "nativeTargetPathDigest"
    | "canonicalRequestDigest"
    | "nativeRequestTranslationDigest"
    | "dispatchAuthorizationRef"
  >,
): Promise<A1Digest> {
  const nativeDeliveryAttemptId = parseA1CanonicalId(
    "nativeDeliveryAttempt",
    record.nativeDeliveryAttemptId,
    "nativeFrontDoorDispatch.nativeDeliveryAttemptId",
  );
  const nativeClientIngressLeaseId = parseA1SafeId(
    record.nativeClientIngressLeaseId,
    "nativeFrontDoorDispatch.nativeClientIngressLeaseId",
  );
  const nativeTargetPathDigest = parseA1Digest(
    record.nativeTargetPathDigest,
    "nativeFrontDoorDispatch.nativeTargetPathDigest",
  );
  const canonicalRequestDigest = parseA1Digest(
    record.canonicalRequestDigest,
    "nativeFrontDoorDispatch.canonicalRequestDigest",
  );
  const nativeRequestTranslationDigest = parseA1Digest(
    record.nativeRequestTranslationDigest,
    "nativeFrontDoorDispatch.nativeRequestTranslationDigest",
  );
  const dispatchAuthorizationRef = parseProtectedHandleRef(record.dispatchAuthorizationRef);
  if (dispatchAuthorizationRef.kind !== "dispatch_authorization") {
    reject(
      "nativeFrontDoorDispatch.dispatchAuthorizationRef.kind",
      'must equal "dispatch_authorization"',
    );
  }
  const writer = new CanonicalWriter();
  writer.str("remote-claw/native-front-door-dispatch/v1");
  writer.str(nativeDeliveryAttemptId);
  writer.str(nativeClientIngressLeaseId);
  writer.bytes(base64urlDecode(nativeTargetPathDigest));
  writer.bytes(base64urlDecode(canonicalRequestDigest));
  writer.bytes(base64urlDecode(nativeRequestTranslationDigest));
  writer.str(dispatchAuthorizationRef.protectedHandleId);
  writer.str(dispatchAuthorizationRef.kind);
  return parseA1Digest(base64urlEncode(await sha256(writer.finish())));
}

export async function verifyNativeFrontDoorDispatchDigest(
  record: NativeFrontDoorDispatchRecord,
): Promise<void> {
  const parsed = parseNativeFrontDoorDispatchRecord(record);
  const computed = await nativeFrontDoorDispatchDigest(parsed);
  if (
    !timingSafeEqual(base64urlDecode(computed), base64urlDecode(parsed.canonicalDispatchDigest))
  ) {
    throw new HostStateContractError(
      "nativeFrontDoorDispatch.canonicalDispatchDigest does not match its row",
    );
  }
}

/** Exact deterministic attempt ID for one admitted command/binding/incarnation tuple. */
export async function nativeDeliveryAttemptId(
  record: Pick<NativeDeliveryAttemptRecord, "commandId" | "nativeBindingId" | "nativeIncarnation">,
): Promise<NativeDeliveryAttemptId> {
  const commandId = parseA1SafeId(record.commandId, "nativeDeliveryAttempt.commandId");
  const nativeBindingId = parseA1CanonicalId(
    "nativeBinding",
    record.nativeBindingId,
    "nativeDeliveryAttempt.nativeBindingId",
  );
  const nativeIncarnation = parseNonNegativeSafeInteger(
    record.nativeIncarnation,
    "nativeDeliveryAttempt.nativeIncarnation",
  );
  const writer = new CanonicalWriter();
  writer.str("remote-claw/native-delivery-attempt-id/v1");
  writer.str(commandId);
  writer.str(nativeBindingId);
  writer.uint(nativeIncarnation);
  return parseA1CanonicalId(
    "nativeDeliveryAttempt",
    `nat_${base64urlEncode(await sha256(writer.finish()))}`,
  );
}

export async function verifyNativeDeliveryAttemptId(
  record: NativeDeliveryAttemptRecord,
): Promise<void> {
  const parsed = parseNativeDeliveryAttemptRecord(record);
  const computed = await nativeDeliveryAttemptId(parsed);
  if (computed !== parsed.nativeDeliveryAttemptId) {
    throw new HostStateContractError(
      "nativeDeliveryAttempt.nativeDeliveryAttemptId does not match its row",
    );
  }
}
