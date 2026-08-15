import {
  A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID,
  A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
  base64urlDecode,
  base64urlEncode,
} from "@remote-claw/clawsec";
import { A1_COMMAND_RESULT_SCHEMA_ID, A1_COMMAND_RESULT_VERSION } from "./command-adjudication.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type Ed25519Signature,
  type LogicalChatId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519Signature,
} from "./ids.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
} from "./validation.js";

export type A1SemanticResultRecordKind = "action_result" | "chat_creation_result";
export type A1SemanticResultPayloadSchemaId =
  | typeof A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID
  | typeof A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID;

function prefixedId(value: unknown, prefix: string, field: string): A1SafeId {
  const parsed = parseA1SafeId(value, field);
  if (!parsed.startsWith(prefix) || parsed.length !== prefix.length + 43) {
    throw new RangeError(`${field} must be a ${prefix} identifier with a SHA-256 body`);
  }
  let body: Uint8Array;
  try {
    body = base64urlDecode(parsed.slice(prefix.length));
  } catch {
    throw new RangeError(`${field} must have a canonical unpadded base64url body`);
  }
  try {
    if (body.byteLength !== 32 || base64urlEncode(body) !== parsed.slice(prefix.length)) {
      throw new RangeError(`${field} must have a canonical 32-byte base64url body`);
    }
  } finally {
    body.fill(0);
  }
  return parsed;
}

function randomAttemptId(value: unknown, field: string): A1SafeId {
  const parsed = parseA1SafeId(value, field);
  if (!parsed.startsWith("rda_") || parsed.length !== 26) {
    throw new RangeError(`${field} must be an rda_ identifier with a 128-bit body`);
  }
  let body: Uint8Array;
  try {
    body = base64urlDecode(parsed.slice(4));
  } catch {
    throw new RangeError(`${field} must have a canonical unpadded base64url body`);
  }
  try {
    if (body.byteLength !== 16 || base64urlEncode(body) !== parsed.slice(4)) {
      throw new RangeError(`${field} must have a canonical 16-byte base64url body`);
    }
  } finally {
    body.fill(0);
  }
  return parsed;
}

function semanticTuple(
  kindValue: unknown,
  schemaValue: unknown,
  field: string,
): Readonly<{
  kind: A1SemanticResultRecordKind;
  schemaId: A1SemanticResultPayloadSchemaId;
}> {
  const kind = parseEnum(
    kindValue,
    ["action_result", "chat_creation_result"] as const,
    `${field}.recordKind`,
  );
  const schemaId = parseEnum(
    schemaValue,
    [A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID, A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID] as const,
    `${field}.payloadSchemaId`,
  );
  if ((kind === "action_result") !== (schemaId === A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID)) {
    throw new RangeError(`${field} semantic record kind and payload schema do not match`);
  }
  return frozen({ kind, schemaId });
}

export interface CollaborationCommandResultRecord {
  readonly commandResultId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly commandId: A1SafeId;
  readonly canonicalCommandRecordDigest: A1Digest;
  readonly resultVersion: typeof A1_COMMAND_RESULT_VERSION;
  readonly supersedesCommandResultId: null;
  readonly sourceKind: "a1_ingress";
  readonly sourceRef: A1SafeId;
  readonly scopeKind: "server_control" | "chat";
  readonly logicalChatId: LogicalChatId | null;
  readonly targetLogicalChatId: LogicalChatId | null;
  readonly commandSeq: number;
  readonly disposition: "rejected";
  readonly canonicalPayloadSchemaId: typeof A1_COMMAND_RESULT_SCHEMA_ID;
  readonly canonicalPayloadRef: ProtectedHandleId;
  readonly canonicalPayloadDigest: A1Digest;
  readonly commandResultPreparationId: A1SafeId;
  readonly compoundSigningGroupId: A1SafeId;
  readonly signerSequence: number;
  readonly serverKeyGeneration: number;
  readonly signerIdentityKeyId: A1SafeId;
  readonly signerScopeCertificateId: A1SafeId;
  readonly signatureAlgorithm: "Ed25519";
  readonly signature: Ed25519Signature;
  readonly signedRecordDigest: A1Digest;
  readonly acceptedAtJournalSeq: number;
  readonly createdAtMs: number;
  readonly finalizedAtMs: number;
}

const COMMAND_RESULT_KEYS = [
  "commandResultId",
  "collaborationServerId",
  "commandId",
  "canonicalCommandRecordDigest",
  "resultVersion",
  "supersedesCommandResultId",
  "sourceKind",
  "sourceRef",
  "scopeKind",
  "logicalChatId",
  "targetLogicalChatId",
  "commandSeq",
  "disposition",
  "canonicalPayloadSchemaId",
  "canonicalPayloadRef",
  "canonicalPayloadDigest",
  "commandResultPreparationId",
  "compoundSigningGroupId",
  "signerSequence",
  "serverKeyGeneration",
  "signerIdentityKeyId",
  "signerScopeCertificateId",
  "signatureAlgorithm",
  "signature",
  "signedRecordDigest",
  "acceptedAtJournalSeq",
  "createdAtMs",
  "finalizedAtMs",
] as const;

export function parseCollaborationCommandResultRecord(
  value: unknown,
): CollaborationCommandResultRecord {
  const row = parseExactRecord(value, COMMAND_RESULT_KEYS, "collaborationCommandResult");
  const scopeKind = parseEnum(
    row.scopeKind,
    ["server_control", "chat"] as const,
    "collaborationCommandResult.scopeKind",
  );
  const logicalChatId =
    row.logicalChatId === null
      ? null
      : parseA1CanonicalId(
          "logicalChat",
          row.logicalChatId,
          "collaborationCommandResult.logicalChatId",
        );
  const targetLogicalChatId =
    row.targetLogicalChatId === null
      ? null
      : parseA1CanonicalId(
          "logicalChat",
          row.targetLogicalChatId,
          "collaborationCommandResult.targetLogicalChatId",
        );
  if (
    (scopeKind === "server_control" && (logicalChatId !== null || targetLogicalChatId !== null)) ||
    (scopeKind === "chat" && (logicalChatId === null || targetLogicalChatId !== logicalChatId))
  ) {
    throw new RangeError("collaborationCommandResult scope tuple is invalid");
  }
  const createdAtMs = parseNonNegativeSafeInteger(
    row.createdAtMs,
    "collaborationCommandResult.createdAtMs",
  );
  const finalizedAtMs = parseNonNegativeSafeInteger(
    row.finalizedAtMs,
    "collaborationCommandResult.finalizedAtMs",
  );
  if (finalizedAtMs < createdAtMs) {
    throw new RangeError("collaborationCommandResult finalization predates creation");
  }
  if (row.supersedesCommandResultId !== null) {
    throw new RangeError("collaborationCommandResult cannot supersede another result in A1.8a0");
  }
  return frozen({
    commandResultId: prefixedId(
      row.commandResultId,
      "ccr_",
      "collaborationCommandResult.commandResultId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "collaborationCommandResult.collaborationServerId",
    ),
    commandId: prefixedId(row.commandId, "rcm_", "collaborationCommandResult.commandId"),
    canonicalCommandRecordDigest: parseA1Digest(
      row.canonicalCommandRecordDigest,
      "collaborationCommandResult.canonicalCommandRecordDigest",
    ),
    resultVersion: parseLiteral(
      row.resultVersion,
      A1_COMMAND_RESULT_VERSION,
      "collaborationCommandResult.resultVersion",
    ),
    supersedesCommandResultId: null,
    sourceKind: parseLiteral(row.sourceKind, "a1_ingress", "collaborationCommandResult.sourceKind"),
    sourceRef: prefixedId(row.sourceRef, "rrs_", "collaborationCommandResult.sourceRef"),
    scopeKind,
    logicalChatId,
    targetLogicalChatId,
    commandSeq: parseNonNegativeSafeInteger(
      row.commandSeq,
      "collaborationCommandResult.commandSeq",
    ),
    disposition: parseLiteral(
      row.disposition,
      "rejected",
      "collaborationCommandResult.disposition",
    ),
    canonicalPayloadSchemaId: parseLiteral(
      row.canonicalPayloadSchemaId,
      A1_COMMAND_RESULT_SCHEMA_ID,
      "collaborationCommandResult.canonicalPayloadSchemaId",
    ),
    canonicalPayloadRef: parseA1CanonicalId(
      "protectedHandle",
      row.canonicalPayloadRef,
      "collaborationCommandResult.canonicalPayloadRef",
    ),
    canonicalPayloadDigest: parseA1Digest(
      row.canonicalPayloadDigest,
      "collaborationCommandResult.canonicalPayloadDigest",
    ),
    commandResultPreparationId: prefixedId(
      row.commandResultPreparationId,
      "crp_",
      "collaborationCommandResult.commandResultPreparationId",
    ),
    compoundSigningGroupId: prefixedId(
      row.compoundSigningGroupId,
      "csg_",
      "collaborationCommandResult.compoundSigningGroupId",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "collaborationCommandResult.signerSequence",
    ),
    serverKeyGeneration: parsePositiveSafeInteger(
      row.serverKeyGeneration,
      "collaborationCommandResult.serverKeyGeneration",
    ),
    signerIdentityKeyId: parseA1SafeId(
      row.signerIdentityKeyId,
      "collaborationCommandResult.signerIdentityKeyId",
    ),
    signerScopeCertificateId: parseA1SafeId(
      row.signerScopeCertificateId,
      "collaborationCommandResult.signerScopeCertificateId",
    ),
    signatureAlgorithm: parseLiteral(
      row.signatureAlgorithm,
      "Ed25519",
      "collaborationCommandResult.signatureAlgorithm",
    ),
    signature: parseEd25519Signature(row.signature, "collaborationCommandResult.signature"),
    signedRecordDigest: parseA1Digest(
      row.signedRecordDigest,
      "collaborationCommandResult.signedRecordDigest",
    ),
    acceptedAtJournalSeq: parseNonNegativeSafeInteger(
      row.acceptedAtJournalSeq,
      "collaborationCommandResult.acceptedAtJournalSeq",
    ),
    createdAtMs,
    finalizedAtMs,
  });
}

export interface A1IngressTerminalResultRecord {
  readonly stableSemanticResultId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly brokerRouteId: A1SafeId;
  readonly commandId: A1SafeId;
  readonly commandResultId: A1SafeId;
  readonly acceptedIngressDeliveryAttemptId: A1SafeId;
  readonly triggerIngressObservationId: A1SafeId;
  readonly initialResultDeliveryId: A1SafeId;
  readonly semanticResultRecordKind: A1SemanticResultRecordKind;
  readonly semanticResultPayloadSchemaId: A1SemanticResultPayloadSchemaId;
  readonly semanticResultPayloadRef: ProtectedHandleId;
  readonly semanticResultPayloadArtifactDigest: A1Digest;
  readonly storedSemanticResultDigest: A1Digest;
  readonly adjudicationState: "terminal";
  readonly finalizationCoordinatorLeaseId: CoordinatorLeaseId;
  readonly finalizationCoordinatorEpoch: number;
  readonly terminalAtMs: number;
}

const TERMINAL_RESULT_KEYS = [
  "stableSemanticResultId",
  "collaborationServerId",
  "brokerRouteId",
  "commandId",
  "commandResultId",
  "acceptedIngressDeliveryAttemptId",
  "triggerIngressObservationId",
  "initialResultDeliveryId",
  "semanticResultRecordKind",
  "semanticResultPayloadSchemaId",
  "semanticResultPayloadRef",
  "semanticResultPayloadArtifactDigest",
  "storedSemanticResultDigest",
  "adjudicationState",
  "finalizationCoordinatorLeaseId",
  "finalizationCoordinatorEpoch",
  "terminalAtMs",
] as const;

export function parseA1IngressTerminalResultRecord(value: unknown): A1IngressTerminalResultRecord {
  const row = parseExactRecord(value, TERMINAL_RESULT_KEYS, "a1IngressTerminalResult");
  const semantic = semanticTuple(
    row.semanticResultRecordKind,
    row.semanticResultPayloadSchemaId,
    "a1IngressTerminalResult",
  );
  return frozen({
    stableSemanticResultId: prefixedId(
      row.stableSemanticResultId,
      "rrs_",
      "a1IngressTerminalResult.stableSemanticResultId",
    ),
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "a1IngressTerminalResult.collaborationServerId",
    ),
    brokerRouteId: prefixedId(row.brokerRouteId, "rcr_", "a1IngressTerminalResult.brokerRouteId"),
    commandId: prefixedId(row.commandId, "rcm_", "a1IngressTerminalResult.commandId"),
    commandResultId: prefixedId(
      row.commandResultId,
      "ccr_",
      "a1IngressTerminalResult.commandResultId",
    ),
    acceptedIngressDeliveryAttemptId: randomAttemptId(
      row.acceptedIngressDeliveryAttemptId,
      "a1IngressTerminalResult.acceptedIngressDeliveryAttemptId",
    ),
    triggerIngressObservationId: prefixedId(
      row.triggerIngressObservationId,
      "rio_",
      "a1IngressTerminalResult.triggerIngressObservationId",
    ),
    initialResultDeliveryId: prefixedId(
      row.initialResultDeliveryId,
      "rrd_",
      "a1IngressTerminalResult.initialResultDeliveryId",
    ),
    semanticResultRecordKind: semantic.kind,
    semanticResultPayloadSchemaId: semantic.schemaId,
    semanticResultPayloadRef: parseA1CanonicalId(
      "protectedHandle",
      row.semanticResultPayloadRef,
      "a1IngressTerminalResult.semanticResultPayloadRef",
    ),
    semanticResultPayloadArtifactDigest: parseA1Digest(
      row.semanticResultPayloadArtifactDigest,
      "a1IngressTerminalResult.semanticResultPayloadArtifactDigest",
    ),
    storedSemanticResultDigest: parseA1Digest(
      row.storedSemanticResultDigest,
      "a1IngressTerminalResult.storedSemanticResultDigest",
    ),
    adjudicationState: parseLiteral(
      row.adjudicationState,
      "terminal",
      "a1IngressTerminalResult.adjudicationState",
    ),
    finalizationCoordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.finalizationCoordinatorLeaseId,
      "a1IngressTerminalResult.finalizationCoordinatorLeaseId",
    ),
    finalizationCoordinatorEpoch: parsePositiveSafeInteger(
      row.finalizationCoordinatorEpoch,
      "a1IngressTerminalResult.finalizationCoordinatorEpoch",
    ),
    terminalAtMs: parseNonNegativeSafeInteger(
      row.terminalAtMs,
      "a1IngressTerminalResult.terminalAtMs",
    ),
  });
}

export interface A1IngressResultDeliveryRecord {
  readonly resultDeliveryId: A1SafeId;
  readonly stableSemanticResultId: A1SafeId;
  readonly sourceKind: "a1_ingress";
  readonly sourceRef: A1SafeId;
  readonly commandResultId: A1SafeId;
  readonly triggerIngressObservationId: A1SafeId;
  readonly brokerRouteId: A1SafeId;
  readonly targetKind: "a1_broker";
  readonly targetRef: A1SafeId;
  readonly deliveryAttemptId: A1SafeId;
  readonly semanticResultRecordKind: A1SemanticResultRecordKind;
  readonly semanticResultPayloadSchemaId: A1SemanticResultPayloadSchemaId;
  readonly semanticResultPayloadRef: ProtectedHandleId;
  readonly semanticResultPayloadArtifactDigest: A1Digest;
  readonly storedSemanticResultDigest: A1Digest;
  readonly state: "pending_seal";
  readonly createdAtMs: number;
}

const RESULT_DELIVERY_KEYS = [
  "resultDeliveryId",
  "stableSemanticResultId",
  "sourceKind",
  "sourceRef",
  "commandResultId",
  "triggerIngressObservationId",
  "brokerRouteId",
  "targetKind",
  "targetRef",
  "deliveryAttemptId",
  "semanticResultRecordKind",
  "semanticResultPayloadSchemaId",
  "semanticResultPayloadRef",
  "semanticResultPayloadArtifactDigest",
  "storedSemanticResultDigest",
  "state",
  "createdAtMs",
] as const;

export function parseA1IngressResultDeliveryRecord(value: unknown): A1IngressResultDeliveryRecord {
  const row = parseExactRecord(value, RESULT_DELIVERY_KEYS, "a1IngressResultDelivery");
  const semantic = semanticTuple(
    row.semanticResultRecordKind,
    row.semanticResultPayloadSchemaId,
    "a1IngressResultDelivery",
  );
  const stableSemanticResultId = prefixedId(
    row.stableSemanticResultId,
    "rrs_",
    "a1IngressResultDelivery.stableSemanticResultId",
  );
  const sourceRef = prefixedId(row.sourceRef, "rrs_", "a1IngressResultDelivery.sourceRef");
  const brokerRouteId = prefixedId(
    row.brokerRouteId,
    "rcr_",
    "a1IngressResultDelivery.brokerRouteId",
  );
  const targetRef = prefixedId(row.targetRef, "rcr_", "a1IngressResultDelivery.targetRef");
  if (sourceRef !== stableSemanticResultId || targetRef !== brokerRouteId) {
    throw new RangeError("a1IngressResultDelivery source or target binding is inconsistent");
  }
  return frozen({
    resultDeliveryId: prefixedId(
      row.resultDeliveryId,
      "rrd_",
      "a1IngressResultDelivery.resultDeliveryId",
    ),
    stableSemanticResultId,
    sourceKind: parseLiteral(row.sourceKind, "a1_ingress", "a1IngressResultDelivery.sourceKind"),
    sourceRef,
    commandResultId: prefixedId(
      row.commandResultId,
      "ccr_",
      "a1IngressResultDelivery.commandResultId",
    ),
    triggerIngressObservationId: prefixedId(
      row.triggerIngressObservationId,
      "rio_",
      "a1IngressResultDelivery.triggerIngressObservationId",
    ),
    brokerRouteId,
    targetKind: parseLiteral(row.targetKind, "a1_broker", "a1IngressResultDelivery.targetKind"),
    targetRef,
    deliveryAttemptId: randomAttemptId(
      row.deliveryAttemptId,
      "a1IngressResultDelivery.deliveryAttemptId",
    ),
    semanticResultRecordKind: semantic.kind,
    semanticResultPayloadSchemaId: semantic.schemaId,
    semanticResultPayloadRef: parseA1CanonicalId(
      "protectedHandle",
      row.semanticResultPayloadRef,
      "a1IngressResultDelivery.semanticResultPayloadRef",
    ),
    semanticResultPayloadArtifactDigest: parseA1Digest(
      row.semanticResultPayloadArtifactDigest,
      "a1IngressResultDelivery.semanticResultPayloadArtifactDigest",
    ),
    storedSemanticResultDigest: parseA1Digest(
      row.storedSemanticResultDigest,
      "a1IngressResultDelivery.storedSemanticResultDigest",
    ),
    state: parseLiteral(row.state, "pending_seal", "a1IngressResultDelivery.state"),
    createdAtMs: parseNonNegativeSafeInteger(
      row.createdAtMs,
      "a1IngressResultDelivery.createdAtMs",
    ),
  });
}
