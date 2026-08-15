import { createHash, timingSafeEqual } from "node:crypto";
import { base64urlDecode, base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import type { NativeEngineDescriptor } from "../native/adapter.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type Ed25519Signature,
  HostStateContractError,
  type InwardEdgeId,
  type LogicalChatId,
  type NativeBindingId,
  type NativeConversationLeaseId,
  type NativeRuntimeId,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519Signature,
  parseMachineIdentityId,
} from "./ids.js";
import { parseNativeEngineDescriptor } from "./records.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonNegativeSafeInteger,
  parseNullable,
  parsePositiveSafeInteger,
  reject,
} from "./validation.js";

export const NATIVE_BINDING_EVIDENCE_SCHEMA_ID = "remote-claw/native-binding-evidence/v1" as const;
export const NATIVE_ROOT_CERTIFICATE_SCHEMA_ID = "remote-claw/native-root-certificate/v1" as const;
export const NATIVE_ROOT_SIGNED_RECORD_SCHEMA_ID =
  "remote-claw/native-root-certificate-signed/v1" as const;
export const NATIVE_ROOT_ACTIVATION_OPERATION_SCHEMA_ID =
  "remote-claw/native-root-activation/v1" as const;
export const NATIVE_ROOT_CERTIFICATE_ID_DOMAIN =
  "remote-claw/native-root-certificate-id/v1" as const;
export const NATIVE_ROOT_MAX_TTL_MS = 300_000;

export interface NativeBindingEvidenceInput {
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly nativeBindingId: NativeBindingId;
  readonly descriptor: NativeEngineDescriptor;
  readonly nativeConversationId: A1SafeId;
  readonly attachmentLeaseId: A1SafeId;
}

export interface NativeRootCertificate {
  readonly schemaVersion: 1;
  readonly canonicalPayloadSchemaId: typeof NATIVE_ROOT_CERTIFICATE_SCHEMA_ID;
  readonly rootPathCertificateId: A1SafeId;
  readonly kind: "native-root";
  readonly terminalNativeBindingId: NativeBindingId;
  readonly terminalServerId: CollaborationServerId;
  readonly terminalLogicalChatId: LogicalChatId;
  readonly terminalTopologyGeneration: number;
  readonly nativeBindingEvidenceDigest: A1Digest;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly signatureAlgorithm: "Ed25519";
  readonly canonicalPayloadDigestAlgorithm: "SHA-256";
  readonly canonicalPayloadDigest: A1Digest;
  readonly signature: Ed25519Signature;
}

export type NativeRootCanonicalPayloadInput = Omit<
  NativeRootCertificate,
  "canonicalPayloadDigest" | "signature"
>;

export const NATIVE_ROOT_ACTIVATION_KINDS = Object.freeze(["activate", "renew"] as const);
export type NativeRootActivationKind = (typeof NATIVE_ROOT_ACTIVATION_KINDS)[number];

/**
 * Durable two-stage terminal-root activation intent/fact.
 *
 * The immutable preparation identity is covered by `operationDigest`. Finalization may only add the
 * accepted signed-record digest and commit time while advancing `prepared` to `committed`.
 */
export interface NativeRootActivationOperationRecord {
  readonly operationId: A1SafeId;
  readonly operationSchemaId: typeof NATIVE_ROOT_ACTIVATION_OPERATION_SCHEMA_ID;
  readonly operationDigest: A1Digest;
  readonly kind: NativeRootActivationKind;
  readonly rootPathCertificateId: A1SafeId;
  readonly expectedPriorRootPathCertificateId: A1SafeId | null;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly inwardEdgeId: InwardEdgeId;
  readonly terminalTopologyGeneration: number;
  readonly nativeBindingId: NativeBindingId;
  readonly runtimeId: NativeRuntimeId;
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
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly runtimeOwnerIdentityKeyId: A1SafeId;
  readonly runtimeOwnerKeyGeneration: number;
  readonly signerSequence: number;
  readonly nativeBindingEvidenceDigest: A1Digest;
  readonly canonicalPayloadRef: ProtectedHandleId;
  readonly canonicalPayloadDigest: A1Digest;
  readonly signedRecordDigest: A1Digest | null;
  readonly preparedAtMs: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly committedAtMs: number | null;
  readonly state: "prepared" | "committed";
}

export type NativeRootActivationPreparationInput = Omit<
  NativeRootActivationOperationRecord,
  "operationDigest" | "signedRecordDigest" | "committedAtMs" | "state"
>;

const NATIVE_ROOT_CERTIFICATE_KEYS = [
  "schemaVersion",
  "canonicalPayloadSchemaId",
  "rootPathCertificateId",
  "kind",
  "terminalNativeBindingId",
  "terminalServerId",
  "terminalLogicalChatId",
  "terminalTopologyGeneration",
  "nativeBindingEvidenceDigest",
  "runtimeOwnerIdentityKeyId",
  "runtimeOwnerKeyGeneration",
  "signerSequence",
  "issuedAtMs",
  "expiresAtMs",
  "signatureAlgorithm",
  "canonicalPayloadDigestAlgorithm",
  "canonicalPayloadDigest",
  "signature",
] as const;

const NATIVE_ROOT_CANONICAL_PAYLOAD_KEYS = NATIVE_ROOT_CERTIFICATE_KEYS.slice(0, -2);

function validateRootLifetime(issuedAtMs: number, expiresAtMs: number, field: string): void {
  if (expiresAtMs <= issuedAtMs) reject(field, "must be after issuedAtMs");
  if (expiresAtMs - issuedAtMs > NATIVE_ROOT_MAX_TTL_MS) {
    reject(field, `must be at most ${NATIVE_ROOT_MAX_TTL_MS}ms after issuedAtMs`);
  }
}

export function parseNativeRootCanonicalPayloadInput(
  value: unknown,
): NativeRootCanonicalPayloadInput {
  const row = parseExactRecord(
    value,
    NATIVE_ROOT_CANONICAL_PAYLOAD_KEYS,
    "nativeRootCanonicalPayload",
  );
  const issuedAtMs = parseNonNegativeSafeInteger(
    row.issuedAtMs,
    "nativeRootCanonicalPayload.issuedAtMs",
  );
  const expiresAtMs = parseNonNegativeSafeInteger(
    row.expiresAtMs,
    "nativeRootCanonicalPayload.expiresAtMs",
  );
  validateRootLifetime(issuedAtMs, expiresAtMs, "nativeRootCanonicalPayload.expiresAtMs");
  return frozen({
    schemaVersion: parseLiteral(row.schemaVersion, 1, "nativeRootCanonicalPayload.schemaVersion"),
    canonicalPayloadSchemaId: parseLiteral(
      row.canonicalPayloadSchemaId,
      NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
      "nativeRootCanonicalPayload.canonicalPayloadSchemaId",
    ),
    rootPathCertificateId: parseA1SafeId(
      row.rootPathCertificateId,
      "nativeRootCanonicalPayload.rootPathCertificateId",
    ),
    kind: parseLiteral(row.kind, "native-root", "nativeRootCanonicalPayload.kind"),
    terminalNativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.terminalNativeBindingId,
      "nativeRootCanonicalPayload.terminalNativeBindingId",
    ),
    terminalServerId: parseA1CanonicalId(
      "collaborationServer",
      row.terminalServerId,
      "nativeRootCanonicalPayload.terminalServerId",
    ),
    terminalLogicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.terminalLogicalChatId,
      "nativeRootCanonicalPayload.terminalLogicalChatId",
    ),
    terminalTopologyGeneration: parsePositiveSafeInteger(
      row.terminalTopologyGeneration,
      "nativeRootCanonicalPayload.terminalTopologyGeneration",
    ),
    nativeBindingEvidenceDigest: parseA1Digest(
      row.nativeBindingEvidenceDigest,
      "nativeRootCanonicalPayload.nativeBindingEvidenceDigest",
    ),
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      "nativeRootCanonicalPayload.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: parsePositiveSafeInteger(
      row.runtimeOwnerKeyGeneration,
      "nativeRootCanonicalPayload.runtimeOwnerKeyGeneration",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "nativeRootCanonicalPayload.signerSequence",
    ),
    issuedAtMs,
    expiresAtMs,
    signatureAlgorithm: parseLiteral(
      row.signatureAlgorithm,
      "Ed25519",
      "nativeRootCanonicalPayload.signatureAlgorithm",
    ),
    canonicalPayloadDigestAlgorithm: parseLiteral(
      row.canonicalPayloadDigestAlgorithm,
      "SHA-256",
      "nativeRootCanonicalPayload.canonicalPayloadDigestAlgorithm",
    ),
  });
}

export function parseNativeRootCertificate(value: unknown): NativeRootCertificate {
  const row = parseExactRecord(value, NATIVE_ROOT_CERTIFICATE_KEYS, "nativeRootCertificate");
  const payload = parseNativeRootCanonicalPayloadInput(
    Object.fromEntries(NATIVE_ROOT_CANONICAL_PAYLOAD_KEYS.map((key) => [key, row[key]])),
  );
  return frozen({
    ...payload,
    canonicalPayloadDigest: parseA1Digest(
      row.canonicalPayloadDigest,
      "nativeRootCertificate.canonicalPayloadDigest",
    ),
    signature: parseEd25519Signature(row.signature, "nativeRootCertificate.signature"),
  });
}

const NATIVE_ROOT_ACTIVATION_OPERATION_KEYS = [
  "operationId",
  "operationSchemaId",
  "operationDigest",
  "kind",
  "rootPathCertificateId",
  "expectedPriorRootPathCertificateId",
  "collaborationServerId",
  "logicalChatId",
  "inwardEdgeId",
  "terminalTopologyGeneration",
  "nativeBindingId",
  "runtimeId",
  "nativeIncarnation",
  "nativeBindingIncarnationId",
  "attachmentId",
  "attachmentLeaseId",
  "transportEpoch",
  "nativeConversationLeaseId",
  "nativeConversationLeaseGeneration",
  "nativeRegistrationPublicationId",
  "publicationGeneration",
  "bindingGateGeneration",
  "runtimeOwnerServiceLeaseId",
  "runtimeOwnerServiceEpoch",
  "coordinatorLeaseId",
  "coordinatorEpoch",
  "runtimeOwnerIdentityKeyId",
  "runtimeOwnerKeyGeneration",
  "signerSequence",
  "nativeBindingEvidenceDigest",
  "canonicalPayloadRef",
  "canonicalPayloadDigest",
  "signedRecordDigest",
  "preparedAtMs",
  "issuedAtMs",
  "expiresAtMs",
  "committedAtMs",
  "state",
] as const;

const NATIVE_ROOT_ACTIVATION_PREPARATION_KEYS = NATIVE_ROOT_ACTIVATION_OPERATION_KEYS.filter(
  (key) =>
    key !== "operationDigest" &&
    key !== "signedRecordDigest" &&
    key !== "committedAtMs" &&
    key !== "state",
);

export function parseNativeRootActivationPreparationInput(
  value: unknown,
): NativeRootActivationPreparationInput {
  const row = parseExactRecord(
    value,
    NATIVE_ROOT_ACTIVATION_PREPARATION_KEYS,
    "nativeRootActivationPreparation",
  );
  const parsed = parseNativeRootActivationOperationRecord({
    ...row,
    operationDigest: base64urlEncode(new Uint8Array(32)),
    signedRecordDigest: null,
    committedAtMs: null,
    state: "prepared",
  });
  return frozen(
    Object.fromEntries(
      NATIVE_ROOT_ACTIVATION_PREPARATION_KEYS.map((key) => [key, parsed[key]]),
    ) as unknown as NativeRootActivationPreparationInput,
  );
}

export function parseNativeRootActivationOperationRecord(
  value: unknown,
): NativeRootActivationOperationRecord {
  const row = parseExactRecord(
    value,
    NATIVE_ROOT_ACTIVATION_OPERATION_KEYS,
    "nativeRootActivationOperation",
  );
  const operationId = parseA1SafeId(row.operationId, "nativeRootActivationOperation.operationId");
  const kind = parseEnum(
    row.kind,
    NATIVE_ROOT_ACTIVATION_KINDS,
    "nativeRootActivationOperation.kind",
  );
  const rootPathCertificateId = parseA1SafeId(
    row.rootPathCertificateId,
    "nativeRootActivationOperation.rootPathCertificateId",
  );
  const expectedPriorRootPathCertificateId = parseNullable(
    row.expectedPriorRootPathCertificateId,
    parseA1SafeId,
    "nativeRootActivationOperation.expectedPriorRootPathCertificateId",
  );
  if ((kind === "activate") !== (expectedPriorRootPathCertificateId === null)) {
    reject(
      "nativeRootActivationOperation.expectedPriorRootPathCertificateId",
      `must be ${kind === "activate" ? "null for activation" : "present for renewal"}`,
    );
  }
  if (expectedPriorRootPathCertificateId === rootPathCertificateId) {
    reject(
      "nativeRootActivationOperation.expectedPriorRootPathCertificateId",
      "must differ from rootPathCertificateId",
    );
  }
  const preparedAtMs = parseNonNegativeSafeInteger(
    row.preparedAtMs,
    "nativeRootActivationOperation.preparedAtMs",
  );
  const issuedAtMs = parseNonNegativeSafeInteger(
    row.issuedAtMs,
    "nativeRootActivationOperation.issuedAtMs",
  );
  const expiresAtMs = parseNonNegativeSafeInteger(
    row.expiresAtMs,
    "nativeRootActivationOperation.expiresAtMs",
  );
  if (issuedAtMs < preparedAtMs) {
    reject("nativeRootActivationOperation.issuedAtMs", "must not precede preparation");
  }
  validateRootLifetime(issuedAtMs, expiresAtMs, "nativeRootActivationOperation.expiresAtMs");
  const state = parseEnum(
    row.state,
    ["prepared", "committed"] as const,
    "nativeRootActivationOperation.state",
  );
  const signedRecordDigest = parseNullable(
    row.signedRecordDigest,
    parseA1Digest,
    "nativeRootActivationOperation.signedRecordDigest",
  );
  const committedAtMs = parseNullable(
    row.committedAtMs,
    parseNonNegativeSafeInteger,
    "nativeRootActivationOperation.committedAtMs",
  );
  if (state === "prepared" && (signedRecordDigest !== null || committedAtMs !== null)) {
    reject(
      "nativeRootActivationOperation.finalization",
      "must be absent while the operation is prepared",
    );
  }
  if (
    state === "committed" &&
    (signedRecordDigest === null ||
      committedAtMs === null ||
      committedAtMs < issuedAtMs ||
      committedAtMs >= expiresAtMs)
  ) {
    reject(
      "nativeRootActivationOperation.finalization",
      "must contain a signed-record digest and commit from issuedAtMs through before expiry",
    );
  }
  return frozen({
    operationId,
    operationSchemaId: parseLiteral(
      row.operationSchemaId,
      NATIVE_ROOT_ACTIVATION_OPERATION_SCHEMA_ID,
      "nativeRootActivationOperation.operationSchemaId",
    ),
    operationDigest: parseA1Digest(
      row.operationDigest,
      "nativeRootActivationOperation.operationDigest",
    ),
    kind,
    rootPathCertificateId,
    expectedPriorRootPathCertificateId,
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "nativeRootActivationOperation.collaborationServerId",
    ),
    logicalChatId: parseA1CanonicalId(
      "logicalChat",
      row.logicalChatId,
      "nativeRootActivationOperation.logicalChatId",
    ),
    inwardEdgeId: parseA1CanonicalId(
      "inwardEdge",
      row.inwardEdgeId,
      "nativeRootActivationOperation.inwardEdgeId",
    ),
    terminalTopologyGeneration: parsePositiveSafeInteger(
      row.terminalTopologyGeneration,
      "nativeRootActivationOperation.terminalTopologyGeneration",
    ),
    nativeBindingId: parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "nativeRootActivationOperation.nativeBindingId",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeRootActivationOperation.runtimeId",
    ),
    nativeIncarnation: parsePositiveSafeInteger(
      row.nativeIncarnation,
      "nativeRootActivationOperation.nativeIncarnation",
    ),
    nativeBindingIncarnationId: parseA1SafeId(
      row.nativeBindingIncarnationId,
      "nativeRootActivationOperation.nativeBindingIncarnationId",
    ),
    attachmentId: parseA1SafeId(row.attachmentId, "nativeRootActivationOperation.attachmentId"),
    attachmentLeaseId: parseA1SafeId(
      row.attachmentLeaseId,
      "nativeRootActivationOperation.attachmentLeaseId",
    ),
    transportEpoch: parsePositiveSafeInteger(
      row.transportEpoch,
      "nativeRootActivationOperation.transportEpoch",
    ),
    nativeConversationLeaseId: parseA1CanonicalId(
      "nativeConversationLease",
      row.nativeConversationLeaseId,
      "nativeRootActivationOperation.nativeConversationLeaseId",
    ),
    nativeConversationLeaseGeneration: parsePositiveSafeInteger(
      row.nativeConversationLeaseGeneration,
      "nativeRootActivationOperation.nativeConversationLeaseGeneration",
    ),
    nativeRegistrationPublicationId: parseA1SafeId(
      row.nativeRegistrationPublicationId,
      "nativeRootActivationOperation.nativeRegistrationPublicationId",
    ),
    publicationGeneration: parsePositiveSafeInteger(
      row.publicationGeneration,
      "nativeRootActivationOperation.publicationGeneration",
    ),
    bindingGateGeneration: parsePositiveSafeInteger(
      row.bindingGateGeneration,
      "nativeRootActivationOperation.bindingGateGeneration",
    ),
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      "nativeRootActivationOperation.runtimeOwnerServiceLeaseId",
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      "nativeRootActivationOperation.runtimeOwnerServiceEpoch",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "nativeRootActivationOperation.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "nativeRootActivationOperation.coordinatorEpoch",
    ),
    runtimeOwnerIdentityKeyId: parseA1SafeId(
      row.runtimeOwnerIdentityKeyId,
      "nativeRootActivationOperation.runtimeOwnerIdentityKeyId",
    ),
    runtimeOwnerKeyGeneration: parsePositiveSafeInteger(
      row.runtimeOwnerKeyGeneration,
      "nativeRootActivationOperation.runtimeOwnerKeyGeneration",
    ),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "nativeRootActivationOperation.signerSequence",
    ),
    nativeBindingEvidenceDigest: parseA1Digest(
      row.nativeBindingEvidenceDigest,
      "nativeRootActivationOperation.nativeBindingEvidenceDigest",
    ),
    canonicalPayloadRef: parseA1CanonicalId(
      "protectedHandle",
      row.canonicalPayloadRef,
      "nativeRootActivationOperation.canonicalPayloadRef",
    ),
    canonicalPayloadDigest: parseA1Digest(
      row.canonicalPayloadDigest,
      "nativeRootActivationOperation.canonicalPayloadDigest",
    ),
    signedRecordDigest,
    preparedAtMs,
    issuedAtMs,
    expiresAtMs,
    committedAtMs,
    state,
  });
}

function sha256Bytes(value: Uint8Array): Uint8Array {
  return createHash("sha256").update(value).digest();
}

function digest(writer: CanonicalWriter): A1Digest {
  return parseA1Digest(base64urlEncode(sha256Bytes(writer.finish())));
}

function writeDigest(writer: CanonicalWriter, value: A1Digest): void {
  writer.bytes(base64urlDecode(value));
}

function equalDigest(left: A1Digest, right: A1Digest): boolean {
  return timingSafeEqual(base64urlDecode(left), base64urlDecode(right));
}

/** Exact A1 native binding evidence digest frozen by the architecture. */
export function nativeBindingEvidenceDigest(value: NativeBindingEvidenceInput): A1Digest {
  const runtimeId = parseA1CanonicalId(
    "nativeRuntime",
    value.runtimeId,
    "nativeBindingEvidence.runtimeId",
  );
  const nativeIncarnation = parsePositiveSafeInteger(
    value.nativeIncarnation,
    "nativeBindingEvidence.nativeIncarnation",
  );
  const nativeBindingId = parseA1CanonicalId(
    "nativeBinding",
    value.nativeBindingId,
    "nativeBindingEvidence.nativeBindingId",
  );
  const descriptor = parseNativeEngineDescriptor(
    value.descriptor,
    "nativeBindingEvidence.descriptor",
  );
  const nativeConversationId = parseA1SafeId(
    value.nativeConversationId,
    "nativeBindingEvidence.nativeConversationId",
  );
  const attachmentLeaseId = parseA1SafeId(
    value.attachmentLeaseId,
    "nativeBindingEvidence.attachmentLeaseId",
  );
  const writer = new CanonicalWriter();
  writer.str(NATIVE_BINDING_EVIDENCE_SCHEMA_ID);
  writer.str(runtimeId);
  writer.uint(nativeIncarnation);
  writer.str(nativeBindingId);
  writer.str(descriptor.product);
  writer.str(descriptor.access);
  writer.str(nativeConversationId);
  writer.str(attachmentLeaseId);
  return digest(writer);
}

/** Exact canonical bytes signed by the runtime owner for a terminal native root. */
export function canonicalNativeRootPayload(value: NativeRootCanonicalPayloadInput): Uint8Array {
  const record = parseNativeRootCanonicalPayloadInput(value);
  const writer = new CanonicalWriter();
  writer.str(record.canonicalPayloadSchemaId);
  writer.uint(record.schemaVersion);
  writer.str(record.rootPathCertificateId);
  writer.str(record.kind);
  writer.str(record.terminalNativeBindingId);
  writer.str(record.terminalServerId);
  writer.str(record.terminalLogicalChatId);
  writer.uint(record.terminalTopologyGeneration);
  writeDigest(writer, record.nativeBindingEvidenceDigest);
  writer.str(record.runtimeOwnerIdentityKeyId);
  writer.uint(record.runtimeOwnerKeyGeneration);
  writer.uint(record.signerSequence);
  writer.uint(record.issuedAtMs);
  writer.uint(record.expiresAtMs);
  writer.str(record.signatureAlgorithm);
  writer.str(record.canonicalPayloadDigestAlgorithm);
  return writer.finish();
}

export function nativeRootCanonicalPayloadDigest(value: NativeRootCanonicalPayloadInput): A1Digest {
  return parseA1Digest(base64urlEncode(sha256Bytes(canonicalNativeRootPayload(value))));
}

/** Digest used by the runtime-owner acceptance ledger for the complete signed certificate. */
export function nativeRootSignedRecordDigest(value: NativeRootCertificate): A1Digest {
  const record = parseNativeRootCertificate(value);
  verifyNativeRootCanonicalPayloadDigest(record);
  const writer = new CanonicalWriter();
  writer.str(NATIVE_ROOT_SIGNED_RECORD_SCHEMA_ID);
  writeDigest(writer, record.canonicalPayloadDigest);
  writer.str(record.runtimeOwnerIdentityKeyId);
  writer.uint(record.runtimeOwnerKeyGeneration);
  writer.uint(record.signerSequence);
  writer.bytes(base64urlDecode(record.signature));
  return digest(writer);
}

export function verifyNativeRootCanonicalPayloadDigest(value: NativeRootCertificate): void {
  const record = parseNativeRootCertificate(value);
  const computed = nativeRootCanonicalPayloadDigest(
    Object.fromEntries(
      NATIVE_ROOT_CANONICAL_PAYLOAD_KEYS.map((key) => [key, record[key]]),
    ) as unknown as NativeRootCanonicalPayloadInput,
  );
  if (!equalDigest(computed, record.canonicalPayloadDigest)) {
    throw new HostStateContractError(
      "nativeRootCertificate.canonicalPayloadDigest does not match its payload",
    );
  }
}

/** Immutable activation preparation digest. Finalization fields are deliberately excluded. */
export function nativeRootActivationOperationDigest(
  value: NativeRootActivationPreparationInput,
): A1Digest {
  const record = parseNativeRootActivationPreparationInput(value);
  const writer = new CanonicalWriter();
  writer.str(record.operationSchemaId);
  writer.str(record.operationId);
  writer.str(record.kind);
  writer.str(record.rootPathCertificateId);
  writer.optionalStr(record.expectedPriorRootPathCertificateId);
  writer.str(record.collaborationServerId);
  writer.str(record.logicalChatId);
  writer.str(record.inwardEdgeId);
  writer.uint(record.terminalTopologyGeneration);
  writer.str(record.nativeBindingId);
  writer.str(record.runtimeId);
  writer.uint(record.nativeIncarnation);
  writer.str(record.nativeBindingIncarnationId);
  writer.str(record.attachmentId);
  writer.str(record.attachmentLeaseId);
  writer.uint(record.transportEpoch);
  writer.str(record.nativeConversationLeaseId);
  writer.uint(record.nativeConversationLeaseGeneration);
  writer.str(record.nativeRegistrationPublicationId);
  writer.uint(record.publicationGeneration);
  writer.uint(record.bindingGateGeneration);
  writer.str(record.runtimeOwnerServiceLeaseId);
  writer.uint(record.runtimeOwnerServiceEpoch);
  writer.str(record.coordinatorLeaseId);
  writer.uint(record.coordinatorEpoch);
  writer.str(record.runtimeOwnerIdentityKeyId);
  writer.uint(record.runtimeOwnerKeyGeneration);
  writer.uint(record.signerSequence);
  writeDigest(writer, record.nativeBindingEvidenceDigest);
  writer.str(record.canonicalPayloadRef);
  writeDigest(writer, record.canonicalPayloadDigest);
  writer.uint(record.preparedAtMs);
  writer.uint(record.issuedAtMs);
  writer.uint(record.expiresAtMs);
  return digest(writer);
}

export function verifyNativeRootActivationOperationDigest(
  value: NativeRootActivationOperationRecord,
): void {
  const record = parseNativeRootActivationOperationRecord(value);
  const computed = nativeRootActivationOperationDigest(
    Object.fromEntries(
      NATIVE_ROOT_ACTIVATION_PREPARATION_KEYS.map((key) => [key, record[key]]),
    ) as unknown as NativeRootActivationPreparationInput,
  );
  if (!equalDigest(computed, record.operationDigest)) {
    throw new HostStateContractError(
      "nativeRootActivationOperation.operationDigest does not match its preparation",
    );
  }
}

export interface NativeRootCertificateIdInput {
  readonly machineIdentityId: string;
  readonly collaborationServerId: CollaborationServerId;
  readonly logicalChatId: LogicalChatId;
  readonly operationId: A1SafeId;
}

function derivedIdDigest(value: NativeRootCertificateIdInput): Uint8Array {
  const machineIdentityId = parseMachineIdentityId(value.machineIdentityId);
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    value.collaborationServerId,
    "nativeRootId.collaborationServerId",
  );
  const logicalChatId = parseA1CanonicalId(
    "logicalChat",
    value.logicalChatId,
    "nativeRootId.logicalChatId",
  );
  const operationId = parseA1SafeId(value.operationId, "nativeRootId.operationId");
  const writer = new CanonicalWriter();
  writer.str(NATIVE_ROOT_CERTIFICATE_ID_DOMAIN);
  writer.str(machineIdentityId);
  writer.str(collaborationServerId);
  writer.str(logicalChatId);
  writer.str(operationId);
  return sha256Bytes(writer.finish());
}

/** Retry-stable, machine/server/chat-scoped safe ID. `nrpc_` is not a canonical ID namespace. */
export function nativeRootCertificateId(value: NativeRootCertificateIdInput): A1SafeId {
  return parseA1SafeId(
    `nrpc_${base64urlEncode(derivedIdDigest(value))}`,
    "nativeRootCertificateId",
  );
}
