import { createHash } from "node:crypto";
import { base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type LogicalChatId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
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
} from "./validation.js";

export const A1_COMMAND_SOURCE_KIND = "a1_ingress" as const;
export const A1_COMMAND_RESULT_VERSION = 1 as const;
export const A1_COMMAND_RESULT_SCHEMA_ID = "remote-claw/collaboration-command-result/v1" as const;
export const A1_COMMAND_SIGNING_GROUP_ID_DOMAIN =
  "remote-claw/collaboration-command-signing-group/v1" as const;
export const A1_COMMAND_RESULT_PREPARATION_ID_DOMAIN =
  "remote-claw/collaboration-command-result-preparation/v1" as const;
export const A1_COMMAND_RESULT_ID_DOMAIN =
  "remote-claw/collaboration-command-result-id/v1" as const;

export const COLLABORATION_COMMAND_DISPOSITIONS = Object.freeze([
  "admitted",
  "queued",
  "rejected",
] as const);
export const COLLABORATION_COMMAND_TARGET_KINDS = Object.freeze([
  "native_binding",
  "native_server",
  "nested_management",
  "nested_chat_edge",
] as const);
export const COLLABORATION_COMMAND_STATES = Object.freeze([
  "awaiting_order",
  "decision_reserved",
  "decided",
] as const);
export const A1_INGRESS_ADJUDICATION_STATES = Object.freeze([
  "awaiting_order",
  "deciding",
  "terminal",
] as const);
export const COMMAND_RESULT_PREPARATION_STATES = Object.freeze([
  "reserved",
  "bound",
  "signed",
  "aborted",
] as const);
export const COMMAND_COMPOUND_SIGNING_GROUP_STATES = Object.freeze([
  "reserved",
  "result_signed",
  "both_signed",
  "finalized",
  "aborted",
] as const);

export type CollaborationCommandDisposition = (typeof COLLABORATION_COMMAND_DISPOSITIONS)[number];
export type CollaborationCommandTargetKind = (typeof COLLABORATION_COMMAND_TARGET_KINDS)[number];
export type CollaborationCommandState = (typeof COLLABORATION_COMMAND_STATES)[number];

function prefixedDigestId(prefix: "csg_" | "crp_", bytes: Uint8Array, field: string): A1SafeId {
  try {
    return parseA1SafeId(
      `${prefix}${base64urlEncode(createHash("sha256").update(bytes).digest())}`,
      field,
    );
  } finally {
    bytes.fill(0);
  }
}

function canonicalServerId(value: unknown, field: string): CollaborationServerId {
  return parseA1CanonicalId("collaborationServer", value, field);
}

function canonicalChatId(value: unknown, field: string): LogicalChatId {
  return parseA1CanonicalId("logicalChat", value, field);
}

function canonicalCoordinatorLeaseId(value: unknown, field: string): CoordinatorLeaseId {
  return parseA1CanonicalId("coordinatorLease", value, field);
}

function canonicalProtectedHandleId(value: unknown, field: string): ProtectedHandleId {
  return parseA1CanonicalId("protectedHandle", value, field);
}

function prefixedId(
  value: unknown,
  prefix: "rrs_" | "rcm_" | "ccr_" | "csg_" | "crp_",
  field: string,
): A1SafeId {
  const parsed = parseA1SafeId(value, field);
  if (!parsed.startsWith(prefix) || parsed.length !== prefix.length + 43) {
    throw new RangeError(`${field} must be a ${prefix} identifier with a SHA-256 body`);
  }
  return parsed;
}

function nullableDigest(value: unknown, field: string): A1Digest | null {
  return parseNullable(value, parseA1Digest, field);
}

function nullableSafeId(value: unknown, field: string): A1SafeId | null {
  return parseNullable(value, parseA1SafeId, field);
}

function nullableProtectedHandle(value: unknown, field: string): ProtectedHandleId | null {
  return parseNullable(value, canonicalProtectedHandleId, field);
}

function allNull(values: readonly unknown[]): boolean {
  return values.every((value) => value === null);
}

function allPresent(values: readonly unknown[]): boolean {
  return values.every((value) => value !== null);
}

export interface CommandReadyEntryRecord {
  readonly collaborationServerId: CollaborationServerId;
  readonly readyAtJournalSeq: number;
  readonly commandId: A1SafeId;
  readonly stableSemanticResultId: A1SafeId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly readyAtMs: number;
}

const COMMAND_READY_ENTRY_KEYS = [
  "collaborationServerId",
  "readyAtJournalSeq",
  "commandId",
  "stableSemanticResultId",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "readyAtMs",
] as const;

export function parseCommandReadyEntryRecord(value: unknown): CommandReadyEntryRecord {
  const row = parseExactRecord(value, COMMAND_READY_ENTRY_KEYS, "commandReadyEntry");
  return frozen({
    collaborationServerId: canonicalServerId(
      row.collaborationServerId,
      "commandReadyEntry.collaborationServerId",
    ),
    readyAtJournalSeq: parseNonNegativeSafeInteger(
      row.readyAtJournalSeq,
      "commandReadyEntry.readyAtJournalSeq",
    ),
    commandId: prefixedId(row.commandId, "rcm_", "commandReadyEntry.commandId"),
    stableSemanticResultId: prefixedId(
      row.stableSemanticResultId,
      "rrs_",
      "commandReadyEntry.stableSemanticResultId",
    ),
    coordinatorLeaseId: canonicalCoordinatorLeaseId(
      row.coordinatorLeaseId,
      "commandReadyEntry.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "commandReadyEntry.coordinatorEpoch",
    ),
    readyAtMs: parseNonNegativeSafeInteger(row.readyAtMs, "commandReadyEntry.readyAtMs"),
  });
}

export interface A1IngressAdjudicationRecord {
  readonly stableSemanticResultId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly commandId: A1SafeId;
  readonly readyAtJournalSeq: number;
  readonly commandSeq: number | null;
  readonly disposition: CollaborationCommandDisposition | null;
  readonly commandResultId: A1SafeId | null;
  readonly commandResultPreparationId: A1SafeId | null;
  readonly state: (typeof A1_INGRESS_ADJUDICATION_STATES)[number];
  readonly decidedAtMs: number | null;
}

const A1_INGRESS_ADJUDICATION_KEYS = [
  "stableSemanticResultId",
  "collaborationServerId",
  "commandId",
  "readyAtJournalSeq",
  "commandSeq",
  "disposition",
  "commandResultId",
  "commandResultPreparationId",
  "state",
  "decidedAtMs",
] as const;

export function parseA1IngressAdjudicationRecord(value: unknown): A1IngressAdjudicationRecord {
  const row = parseExactRecord(value, A1_INGRESS_ADJUDICATION_KEYS, "a1IngressAdjudication");
  const state = parseEnum(row.state, A1_INGRESS_ADJUDICATION_STATES, "a1IngressAdjudication.state");
  const commandSeq = parseNullable(
    row.commandSeq,
    parseNonNegativeSafeInteger,
    "a1IngressAdjudication.commandSeq",
  );
  const disposition = parseNullable(
    row.disposition,
    (input, field) => parseEnum(input, COLLABORATION_COMMAND_DISPOSITIONS, field),
    "a1IngressAdjudication.disposition",
  );
  const commandResultId =
    row.commandResultId === null
      ? null
      : prefixedId(row.commandResultId, "ccr_", "a1IngressAdjudication.commandResultId");
  const commandResultPreparationId =
    row.commandResultPreparationId === null
      ? null
      : prefixedId(
          row.commandResultPreparationId,
          "crp_",
          "a1IngressAdjudication.commandResultPreparationId",
        );
  const decidedAtMs = parseNullable(
    row.decidedAtMs,
    parseNonNegativeSafeInteger,
    "a1IngressAdjudication.decidedAtMs",
  );
  const decision = [
    commandSeq,
    disposition,
    commandResultId,
    commandResultPreparationId,
    decidedAtMs,
  ];
  if (
    (state === "awaiting_order" && !allNull(decision)) ||
    (state !== "awaiting_order" && !allPresent(decision))
  ) {
    throw new RangeError("a1IngressAdjudication lifecycle tuple is invalid");
  }
  return frozen({
    stableSemanticResultId: prefixedId(
      row.stableSemanticResultId,
      "rrs_",
      "a1IngressAdjudication.stableSemanticResultId",
    ),
    collaborationServerId: canonicalServerId(
      row.collaborationServerId,
      "a1IngressAdjudication.collaborationServerId",
    ),
    commandId: prefixedId(row.commandId, "rcm_", "a1IngressAdjudication.commandId"),
    readyAtJournalSeq: parseNonNegativeSafeInteger(
      row.readyAtJournalSeq,
      "a1IngressAdjudication.readyAtJournalSeq",
    ),
    commandSeq,
    disposition,
    commandResultId,
    commandResultPreparationId,
    state,
    decidedAtMs,
  });
}

export interface CollaborationCommandRecord {
  readonly commandId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly scopeKind: "server_control" | "chat";
  readonly logicalChatId: LogicalChatId | null;
  readonly targetLogicalChatId: LogicalChatId | null;
  readonly sourceKind: typeof A1_COMMAND_SOURCE_KIND;
  readonly sourceRef: A1SafeId;
  readonly sourceEventNamespaceId: A1SafeId;
  readonly sourceEventId: A1SafeId;
  readonly sourceCommandIdentityDigest: A1Digest;
  readonly canonicalSourceEventDigest: null;
  readonly mutationFamily: "new_chat" | "user_text";
  readonly canonicalCommandPayloadSchemaId: string;
  readonly canonicalCommandPayloadRef: ProtectedHandleId;
  readonly canonicalCommandPayloadDigest: A1Digest;
  readonly preDecisionNormalizationEvidenceSchemaId: string | null;
  readonly preDecisionNormalizationEvidenceRef: ProtectedHandleId | null;
  readonly preDecisionNormalizationEvidenceDigest: A1Digest | null;
  readonly readyAtJournalSeq: number;
  readonly commandSeq: number | null;
  readonly disposition: CollaborationCommandDisposition | null;
  readonly admittedTargetKind: CollaborationCommandTargetKind | null;
  readonly selectedExecutorEvidenceSchemaId: string | null;
  readonly selectedExecutorEvidenceRef: ProtectedHandleId | null;
  readonly selectedExecutorEvidenceDigest: A1Digest | null;
  readonly targetCapabilitySnapshotId: A1SafeId | null;
  readonly targetCapabilityFamilyDigest: A1Digest | null;
  readonly currentCommandResultId: A1SafeId | null;
  readonly decisionEvidenceSchemaId: string | null;
  readonly decisionEvidenceRef: ProtectedHandleId | null;
  readonly decisionEvidenceDigest: A1Digest | null;
  readonly canonicalCommandRecordDigest: A1Digest | null;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly decisionCoordinatorLeaseId: CoordinatorLeaseId | null;
  readonly decisionCoordinatorEpoch: number | null;
  readonly createdAtMs: number;
  readonly decidedAtMs: number | null;
  readonly state: CollaborationCommandState;
}

const COLLABORATION_COMMAND_KEYS = [
  "commandId",
  "collaborationServerId",
  "scopeKind",
  "logicalChatId",
  "targetLogicalChatId",
  "sourceKind",
  "sourceRef",
  "sourceEventNamespaceId",
  "sourceEventId",
  "sourceCommandIdentityDigest",
  "canonicalSourceEventDigest",
  "mutationFamily",
  "canonicalCommandPayloadSchemaId",
  "canonicalCommandPayloadRef",
  "canonicalCommandPayloadDigest",
  "preDecisionNormalizationEvidenceSchemaId",
  "preDecisionNormalizationEvidenceRef",
  "preDecisionNormalizationEvidenceDigest",
  "readyAtJournalSeq",
  "commandSeq",
  "disposition",
  "admittedTargetKind",
  "selectedExecutorEvidenceSchemaId",
  "selectedExecutorEvidenceRef",
  "selectedExecutorEvidenceDigest",
  "targetCapabilitySnapshotId",
  "targetCapabilityFamilyDigest",
  "currentCommandResultId",
  "decisionEvidenceSchemaId",
  "decisionEvidenceRef",
  "decisionEvidenceDigest",
  "canonicalCommandRecordDigest",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "decisionCoordinatorLeaseId",
  "decisionCoordinatorEpoch",
  "createdAtMs",
  "decidedAtMs",
  "state",
] as const;

export function parseCollaborationCommandRecord(value: unknown): CollaborationCommandRecord {
  const row = parseExactRecord(value, COLLABORATION_COMMAND_KEYS, "collaborationCommand");
  const scopeKind = parseEnum(
    row.scopeKind,
    ["server_control", "chat"] as const,
    "collaborationCommand.scopeKind",
  );
  const logicalChatId = parseNullable(
    row.logicalChatId,
    canonicalChatId,
    "collaborationCommand.logicalChatId",
  );
  const targetLogicalChatId = parseNullable(
    row.targetLogicalChatId,
    canonicalChatId,
    "collaborationCommand.targetLogicalChatId",
  );
  const mutationFamily = parseEnum(
    row.mutationFamily,
    ["new_chat", "user_text"] as const,
    "collaborationCommand.mutationFamily",
  );
  if (
    (scopeKind === "chat" &&
      (logicalChatId === null ||
        targetLogicalChatId !== logicalChatId ||
        mutationFamily !== "user_text")) ||
    (scopeKind === "server_control" && (logicalChatId !== null || mutationFamily !== "new_chat"))
  ) {
    throw new RangeError("collaborationCommand scope, target, and mutation family do not agree");
  }
  const sourceKind = parseLiteral(
    row.sourceKind,
    A1_COMMAND_SOURCE_KIND,
    "collaborationCommand.sourceKind",
  );
  if (row.canonicalSourceEventDigest !== null) {
    throw new RangeError(
      "collaborationCommand canonicalSourceEventDigest must be null for A1 ingress",
    );
  }
  const normalizationSchema = parseNullable(
    row.preDecisionNormalizationEvidenceSchemaId,
    parseNonEmptyString,
    "collaborationCommand.preDecisionNormalizationEvidenceSchemaId",
  );
  const normalizationRef = nullableProtectedHandle(
    row.preDecisionNormalizationEvidenceRef,
    "collaborationCommand.preDecisionNormalizationEvidenceRef",
  );
  const normalizationDigest = nullableDigest(
    row.preDecisionNormalizationEvidenceDigest,
    "collaborationCommand.preDecisionNormalizationEvidenceDigest",
  );
  if (
    !allNull([normalizationSchema, normalizationRef, normalizationDigest]) &&
    !allPresent([normalizationSchema, normalizationRef, normalizationDigest])
  ) {
    throw new RangeError("collaborationCommand normalization evidence tuple is partial");
  }
  const state = parseEnum(row.state, COLLABORATION_COMMAND_STATES, "collaborationCommand.state");
  const commandSeq = parseNullable(
    row.commandSeq,
    parseNonNegativeSafeInteger,
    "collaborationCommand.commandSeq",
  );
  const disposition = parseNullable(
    row.disposition,
    (input, field) => parseEnum(input, COLLABORATION_COMMAND_DISPOSITIONS, field),
    "collaborationCommand.disposition",
  );
  if (
    scopeKind === "server_control" &&
    targetLogicalChatId !== null &&
    disposition !== "admitted"
  ) {
    throw new RangeError(
      "collaborationCommand server-control target requires an admitted decision",
    );
  }
  const admittedTargetKind = parseNullable(
    row.admittedTargetKind,
    (input, field) => parseEnum(input, COLLABORATION_COMMAND_TARGET_KINDS, field),
    "collaborationCommand.admittedTargetKind",
  );
  const executorSchema = parseNullable(
    row.selectedExecutorEvidenceSchemaId,
    parseNonEmptyString,
    "collaborationCommand.selectedExecutorEvidenceSchemaId",
  );
  const executorRef = nullableProtectedHandle(
    row.selectedExecutorEvidenceRef,
    "collaborationCommand.selectedExecutorEvidenceRef",
  );
  const executorDigest = nullableDigest(
    row.selectedExecutorEvidenceDigest,
    "collaborationCommand.selectedExecutorEvidenceDigest",
  );
  const capabilitySnapshotId = nullableSafeId(
    row.targetCapabilitySnapshotId,
    "collaborationCommand.targetCapabilitySnapshotId",
  );
  const capabilityDigest = nullableDigest(
    row.targetCapabilityFamilyDigest,
    "collaborationCommand.targetCapabilityFamilyDigest",
  );
  const decisionSchema = parseNullable(
    row.decisionEvidenceSchemaId,
    parseNonEmptyString,
    "collaborationCommand.decisionEvidenceSchemaId",
  );
  const decisionRef = nullableProtectedHandle(
    row.decisionEvidenceRef,
    "collaborationCommand.decisionEvidenceRef",
  );
  const decisionDigest = nullableDigest(
    row.decisionEvidenceDigest,
    "collaborationCommand.decisionEvidenceDigest",
  );
  const canonicalRecordDigest = nullableDigest(
    row.canonicalCommandRecordDigest,
    "collaborationCommand.canonicalCommandRecordDigest",
  );
  const decidedAtMs = parseNullable(
    row.decidedAtMs,
    parseNonNegativeSafeInteger,
    "collaborationCommand.decidedAtMs",
  );
  const createdAtMs = parseNonNegativeSafeInteger(
    row.createdAtMs,
    "collaborationCommand.createdAtMs",
  );
  if (decidedAtMs !== null && decidedAtMs < createdAtMs) {
    throw new RangeError("collaborationCommand decision predates command creation");
  }
  const decisionCoordinatorLeaseId = parseNullable(
    row.decisionCoordinatorLeaseId,
    canonicalCoordinatorLeaseId,
    "collaborationCommand.decisionCoordinatorLeaseId",
  );
  const decisionCoordinatorEpoch = parseNullable(
    row.decisionCoordinatorEpoch,
    parsePositiveSafeInteger,
    "collaborationCommand.decisionCoordinatorEpoch",
  );
  const decisionFields = [
    commandSeq,
    disposition,
    decisionSchema,
    decisionRef,
    decisionDigest,
    canonicalRecordDigest,
    decisionCoordinatorLeaseId,
    decisionCoordinatorEpoch,
    decidedAtMs,
  ];
  if (
    (state === "awaiting_order" && !allNull(decisionFields)) ||
    (state !== "awaiting_order" && !allPresent(decisionFields))
  ) {
    throw new RangeError("collaborationCommand decision lifecycle tuple is invalid");
  }
  const selectedFields = [
    admittedTargetKind,
    executorSchema,
    executorRef,
    executorDigest,
    capabilitySnapshotId,
    capabilityDigest,
  ];
  if (disposition === "admitted" ? !allPresent(selectedFields) : !allNull(selectedFields)) {
    throw new RangeError("collaborationCommand selected executor tuple is invalid");
  }
  const currentCommandResultId =
    row.currentCommandResultId === null
      ? null
      : prefixedId(
          row.currentCommandResultId,
          "ccr_",
          "collaborationCommand.currentCommandResultId",
        );
  if (state !== "decided" && currentCommandResultId !== null) {
    throw new RangeError("collaborationCommand current result is premature");
  }
  return frozen({
    commandId: prefixedId(row.commandId, "rcm_", "collaborationCommand.commandId"),
    collaborationServerId: canonicalServerId(
      row.collaborationServerId,
      "collaborationCommand.collaborationServerId",
    ),
    scopeKind,
    logicalChatId,
    targetLogicalChatId,
    sourceKind,
    sourceRef: prefixedId(row.sourceRef, "rrs_", "collaborationCommand.sourceRef"),
    sourceEventNamespaceId: parseA1SafeId(
      row.sourceEventNamespaceId,
      "collaborationCommand.sourceEventNamespaceId",
    ),
    sourceEventId: parseA1SafeId(row.sourceEventId, "collaborationCommand.sourceEventId"),
    sourceCommandIdentityDigest: parseA1Digest(
      row.sourceCommandIdentityDigest,
      "collaborationCommand.sourceCommandIdentityDigest",
    ),
    canonicalSourceEventDigest: null,
    mutationFamily,
    canonicalCommandPayloadSchemaId: parseNonEmptyString(
      row.canonicalCommandPayloadSchemaId,
      "collaborationCommand.canonicalCommandPayloadSchemaId",
    ),
    canonicalCommandPayloadRef: canonicalProtectedHandleId(
      row.canonicalCommandPayloadRef,
      "collaborationCommand.canonicalCommandPayloadRef",
    ),
    canonicalCommandPayloadDigest: parseA1Digest(
      row.canonicalCommandPayloadDigest,
      "collaborationCommand.canonicalCommandPayloadDigest",
    ),
    preDecisionNormalizationEvidenceSchemaId: normalizationSchema,
    preDecisionNormalizationEvidenceRef: normalizationRef,
    preDecisionNormalizationEvidenceDigest: normalizationDigest,
    readyAtJournalSeq: parseNonNegativeSafeInteger(
      row.readyAtJournalSeq,
      "collaborationCommand.readyAtJournalSeq",
    ),
    commandSeq,
    disposition,
    admittedTargetKind,
    selectedExecutorEvidenceSchemaId: executorSchema,
    selectedExecutorEvidenceRef: executorRef,
    selectedExecutorEvidenceDigest: executorDigest,
    targetCapabilitySnapshotId: capabilitySnapshotId,
    targetCapabilityFamilyDigest: capabilityDigest,
    currentCommandResultId,
    decisionEvidenceSchemaId: decisionSchema,
    decisionEvidenceRef: decisionRef,
    decisionEvidenceDigest: decisionDigest,
    canonicalCommandRecordDigest: canonicalRecordDigest,
    coordinatorLeaseId: canonicalCoordinatorLeaseId(
      row.coordinatorLeaseId,
      "collaborationCommand.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "collaborationCommand.coordinatorEpoch",
    ),
    decisionCoordinatorLeaseId,
    decisionCoordinatorEpoch,
    createdAtMs,
    decidedAtMs,
    state,
  });
}

export interface CollaborationCommandResultPreparationRecord {
  readonly commandResultPreparationId: A1SafeId;
  readonly commandResultId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly commandId: A1SafeId;
  readonly canonicalCommandRecordDigest: A1Digest;
  readonly resultVersion: typeof A1_COMMAND_RESULT_VERSION;
  readonly preparationGeneration: number;
  readonly supersedesPreparationRef: A1SafeId | null;
  readonly canonicalPayloadRef: ProtectedHandleId;
  readonly canonicalPayloadDigest: A1Digest;
  readonly signerSequence: number;
  readonly signingLeaseId: A1SafeId;
  readonly compoundSigningGroupId: A1SafeId;
  readonly requiredFinalizationArtifactKind: "none";
  readonly currentFinalizationArtifactPreparationRef: null;
  readonly preparedAtMs: number;
  readonly boundAtMs: number | null;
  readonly signedAtMs: number | null;
  readonly abortedAtMs: number | null;
  readonly state: (typeof COMMAND_RESULT_PREPARATION_STATES)[number];
}

const COMMAND_RESULT_PREPARATION_KEYS = [
  "commandResultPreparationId",
  "commandResultId",
  "collaborationServerId",
  "commandId",
  "canonicalCommandRecordDigest",
  "resultVersion",
  "preparationGeneration",
  "supersedesPreparationRef",
  "canonicalPayloadRef",
  "canonicalPayloadDigest",
  "signerSequence",
  "signingLeaseId",
  "compoundSigningGroupId",
  "requiredFinalizationArtifactKind",
  "currentFinalizationArtifactPreparationRef",
  "preparedAtMs",
  "boundAtMs",
  "signedAtMs",
  "abortedAtMs",
  "state",
] as const;

export function parseCollaborationCommandResultPreparationRecord(
  value: unknown,
): CollaborationCommandResultPreparationRecord {
  const row = parseExactRecord(
    value,
    COMMAND_RESULT_PREPARATION_KEYS,
    "collaborationCommandResultPreparation",
  );
  const state = parseEnum(
    row.state,
    COMMAND_RESULT_PREPARATION_STATES,
    "collaborationCommandResultPreparation.state",
  );
  const preparedAtMs = parseNonNegativeSafeInteger(
    row.preparedAtMs,
    "collaborationCommandResultPreparation.preparedAtMs",
  );
  const boundAtMs = parseNullable(
    row.boundAtMs,
    parseNonNegativeSafeInteger,
    "collaborationCommandResultPreparation.boundAtMs",
  );
  const signedAtMs = parseNullable(
    row.signedAtMs,
    parseNonNegativeSafeInteger,
    "collaborationCommandResultPreparation.signedAtMs",
  );
  const abortedAtMs = parseNullable(
    row.abortedAtMs,
    parseNonNegativeSafeInteger,
    "collaborationCommandResultPreparation.abortedAtMs",
  );
  if (
    (state === "reserved" && !allNull([boundAtMs, signedAtMs, abortedAtMs])) ||
    (state === "bound" && (boundAtMs === null || signedAtMs !== null || abortedAtMs !== null)) ||
    (state === "signed" && (boundAtMs === null || signedAtMs === null || abortedAtMs !== null)) ||
    (state === "aborted" && (signedAtMs !== null || abortedAtMs === null)) ||
    (boundAtMs !== null && boundAtMs < preparedAtMs) ||
    (signedAtMs !== null && signedAtMs < (boundAtMs ?? preparedAtMs)) ||
    (abortedAtMs !== null && abortedAtMs < (boundAtMs ?? preparedAtMs))
  ) {
    throw new RangeError("collaborationCommandResultPreparation lifecycle tuple is invalid");
  }
  if (row.currentFinalizationArtifactPreparationRef !== null) {
    throw new RangeError(
      "collaborationCommandResultPreparation current finalization artifact must be null in v10",
    );
  }
  return frozen({
    commandResultPreparationId: prefixedId(
      row.commandResultPreparationId,
      "crp_",
      "collaborationCommandResultPreparation.commandResultPreparationId",
    ),
    commandResultId: prefixedId(
      row.commandResultId,
      "ccr_",
      "collaborationCommandResultPreparation.commandResultId",
    ),
    collaborationServerId: canonicalServerId(
      row.collaborationServerId,
      "collaborationCommandResultPreparation.collaborationServerId",
    ),
    commandId: prefixedId(row.commandId, "rcm_", "collaborationCommandResultPreparation.commandId"),
    canonicalCommandRecordDigest: parseA1Digest(
      row.canonicalCommandRecordDigest,
      "collaborationCommandResultPreparation.canonicalCommandRecordDigest",
    ),
    resultVersion: parseLiteral(
      row.resultVersion,
      A1_COMMAND_RESULT_VERSION,
      "collaborationCommandResultPreparation.resultVersion",
    ),
    preparationGeneration: parsePositiveSafeInteger(
      row.preparationGeneration,
      "collaborationCommandResultPreparation.preparationGeneration",
    ),
    supersedesPreparationRef:
      row.supersedesPreparationRef === null
        ? null
        : prefixedId(
            row.supersedesPreparationRef,
            "crp_",
            "collaborationCommandResultPreparation.supersedesPreparationRef",
          ),
    canonicalPayloadRef: canonicalProtectedHandleId(
      row.canonicalPayloadRef,
      "collaborationCommandResultPreparation.canonicalPayloadRef",
    ),
    canonicalPayloadDigest: parseA1Digest(
      row.canonicalPayloadDigest,
      "collaborationCommandResultPreparation.canonicalPayloadDigest",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "collaborationCommandResultPreparation.signerSequence",
    ),
    signingLeaseId: parseA1SafeId(
      row.signingLeaseId,
      "collaborationCommandResultPreparation.signingLeaseId",
    ),
    compoundSigningGroupId: prefixedId(
      row.compoundSigningGroupId,
      "csg_",
      "collaborationCommandResultPreparation.compoundSigningGroupId",
    ),
    requiredFinalizationArtifactKind: parseLiteral(
      row.requiredFinalizationArtifactKind,
      "none",
      "collaborationCommandResultPreparation.requiredFinalizationArtifactKind",
    ),
    currentFinalizationArtifactPreparationRef: null,
    preparedAtMs,
    boundAtMs,
    signedAtMs,
    abortedAtMs,
    state,
  });
}

export interface CollaborationCommandCompoundSigningGroupRecord {
  readonly compoundSigningGroupId: A1SafeId;
  readonly collaborationServerId: CollaborationServerId;
  readonly commandId: A1SafeId;
  readonly commandResultId: A1SafeId;
  readonly preparationGeneration: number;
  readonly signingLeaseId: A1SafeId;
  readonly resultPreparationRef: A1SafeId;
  readonly requiredFinalizationArtifactKind: "none";
  readonly secondaryPreparationRef: null;
  readonly reservedAtMs: number;
  readonly resultSignedAtMs: number | null;
  readonly bothSignedAtMs: null;
  readonly finalizedAtMs: null;
  readonly abortedAtMs: number | null;
  readonly state: (typeof COMMAND_COMPOUND_SIGNING_GROUP_STATES)[number];
}

const COMMAND_COMPOUND_SIGNING_GROUP_KEYS = [
  "compoundSigningGroupId",
  "collaborationServerId",
  "commandId",
  "commandResultId",
  "preparationGeneration",
  "signingLeaseId",
  "resultPreparationRef",
  "requiredFinalizationArtifactKind",
  "secondaryPreparationRef",
  "reservedAtMs",
  "resultSignedAtMs",
  "bothSignedAtMs",
  "finalizedAtMs",
  "abortedAtMs",
  "state",
] as const;

export function parseCollaborationCommandCompoundSigningGroupRecord(
  value: unknown,
): CollaborationCommandCompoundSigningGroupRecord {
  const row = parseExactRecord(
    value,
    COMMAND_COMPOUND_SIGNING_GROUP_KEYS,
    "collaborationCommandCompoundSigningGroup",
  );
  const state = parseEnum(
    row.state,
    COMMAND_COMPOUND_SIGNING_GROUP_STATES,
    "collaborationCommandCompoundSigningGroup.state",
  );
  if (
    row.secondaryPreparationRef !== null ||
    row.bothSignedAtMs !== null ||
    row.finalizedAtMs !== null
  ) {
    throw new RangeError(
      "collaborationCommandCompoundSigningGroup exceeds the v10 none-only boundary",
    );
  }
  const reservedAtMs = parseNonNegativeSafeInteger(
    row.reservedAtMs,
    "collaborationCommandCompoundSigningGroup.reservedAtMs",
  );
  const resultSignedAtMs = parseNullable(
    row.resultSignedAtMs,
    parseNonNegativeSafeInteger,
    "collaborationCommandCompoundSigningGroup.resultSignedAtMs",
  );
  const abortedAtMs = parseNullable(
    row.abortedAtMs,
    parseNonNegativeSafeInteger,
    "collaborationCommandCompoundSigningGroup.abortedAtMs",
  );
  if (
    (state === "reserved" && !allNull([resultSignedAtMs, abortedAtMs])) ||
    (state === "result_signed" && (resultSignedAtMs === null || abortedAtMs !== null)) ||
    (state === "aborted" && (resultSignedAtMs !== null || abortedAtMs === null)) ||
    state === "both_signed" ||
    state === "finalized" ||
    (resultSignedAtMs !== null && resultSignedAtMs < reservedAtMs) ||
    (abortedAtMs !== null && abortedAtMs < reservedAtMs)
  ) {
    throw new RangeError("collaborationCommandCompoundSigningGroup lifecycle tuple is invalid");
  }
  return frozen({
    compoundSigningGroupId: prefixedId(
      row.compoundSigningGroupId,
      "csg_",
      "collaborationCommandCompoundSigningGroup.compoundSigningGroupId",
    ),
    collaborationServerId: canonicalServerId(
      row.collaborationServerId,
      "collaborationCommandCompoundSigningGroup.collaborationServerId",
    ),
    commandId: prefixedId(
      row.commandId,
      "rcm_",
      "collaborationCommandCompoundSigningGroup.commandId",
    ),
    commandResultId: prefixedId(
      row.commandResultId,
      "ccr_",
      "collaborationCommandCompoundSigningGroup.commandResultId",
    ),
    preparationGeneration: parsePositiveSafeInteger(
      row.preparationGeneration,
      "collaborationCommandCompoundSigningGroup.preparationGeneration",
    ),
    signingLeaseId: parseA1SafeId(
      row.signingLeaseId,
      "collaborationCommandCompoundSigningGroup.signingLeaseId",
    ),
    resultPreparationRef: prefixedId(
      row.resultPreparationRef,
      "crp_",
      "collaborationCommandCompoundSigningGroup.resultPreparationRef",
    ),
    requiredFinalizationArtifactKind: parseLiteral(
      row.requiredFinalizationArtifactKind,
      "none",
      "collaborationCommandCompoundSigningGroup.requiredFinalizationArtifactKind",
    ),
    secondaryPreparationRef: null,
    reservedAtMs,
    resultSignedAtMs,
    bothSignedAtMs: null,
    finalizedAtMs: null,
    abortedAtMs,
    state,
  });
}

export interface CommandSigningIdentity {
  readonly collaborationServerId: CollaborationServerId;
  readonly commandId: A1SafeId;
  readonly commandResultId: A1SafeId;
  readonly preparationGeneration: number;
}

function parseCommandSigningIdentity(value: unknown): CommandSigningIdentity {
  const row = parseExactRecord(
    value,
    ["collaborationServerId", "commandId", "commandResultId", "preparationGeneration"] as const,
    "commandSigningIdentity",
  );
  return frozen({
    collaborationServerId: canonicalServerId(
      row.collaborationServerId,
      "commandSigningIdentity.collaborationServerId",
    ),
    commandId: prefixedId(row.commandId, "rcm_", "commandSigningIdentity.commandId"),
    commandResultId: prefixedId(
      row.commandResultId,
      "ccr_",
      "commandSigningIdentity.commandResultId",
    ),
    preparationGeneration: parsePositiveSafeInteger(
      row.preparationGeneration,
      "commandSigningIdentity.preparationGeneration",
    ),
  });
}

export function deriveCollaborationCommandCompoundSigningGroupId(
  value: CommandSigningIdentity,
): A1SafeId {
  const parsed = parseCommandSigningIdentity(value);
  const writer = new CanonicalWriter();
  writer.str(A1_COMMAND_SIGNING_GROUP_ID_DOMAIN);
  writer.str(parsed.collaborationServerId);
  writer.str(parsed.commandId);
  writer.str(parsed.commandResultId);
  writer.uint(parsed.preparationGeneration);
  return prefixedDigestId("csg_", writer.finish(), "compoundSigningGroupId");
}

export function deriveCollaborationCommandResultPreparationId(
  value: CommandSigningIdentity,
): A1SafeId {
  const parsed = parseCommandSigningIdentity(value);
  const writer = new CanonicalWriter();
  writer.str(A1_COMMAND_RESULT_PREPARATION_ID_DOMAIN);
  writer.str(parsed.collaborationServerId);
  writer.str(parsed.commandId);
  writer.str(parsed.commandResultId);
  writer.uint(A1_COMMAND_RESULT_VERSION);
  writer.uint(parsed.preparationGeneration);
  return prefixedDigestId("crp_", writer.finish(), "commandResultPreparationId");
}

export function deriveCollaborationCommandResultId(
  collaborationServerIdInput: CollaborationServerId,
  commandIdInput: A1SafeId,
): A1SafeId {
  const collaborationServerId = canonicalServerId(
    collaborationServerIdInput,
    "commandResultId.collaborationServerId",
  );
  const commandId = prefixedId(commandIdInput, "rcm_", "commandResultId.commandId");
  const writer = new CanonicalWriter();
  writer.str(A1_COMMAND_RESULT_ID_DOMAIN);
  writer.str(collaborationServerId);
  writer.str(commandId);
  writer.uint(A1_COMMAND_RESULT_VERSION);
  const bytes = writer.finish();
  try {
    return parseA1SafeId(
      `ccr_${base64urlEncode(createHash("sha256").update(bytes).digest())}`,
      "commandResultId",
    );
  } finally {
    bytes.fill(0);
  }
}
