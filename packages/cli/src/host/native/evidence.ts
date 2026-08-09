import { createHash } from "node:crypto";
import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  canonicalByteSnapshot,
  timingSafeEqual,
} from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type ProjectId,
  type ProjectTargetSelectorMappingId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "../state/ids.js";
import { ProtectedByteSnapshot } from "../state/protected.js";
import { parseNativeEngineDescriptor } from "../state/records.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonEmptyString,
  parsePositiveSafeInteger,
  reject,
} from "../state/validation.js";
import type {
  NativeConversationCapabilities,
  NativeConversationRef,
  NativeEngineDescriptor,
} from "./adapter.js";

export const NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID =
  "remote-claw/native-engine-descriptor/v1" as const;
export const DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID =
  "remote-claw/durable-project-selection/v1" as const;
export const NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID =
  "remote-claw/native-conversation-ref/v1" as const;
export const NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID =
  "remote-claw/native-conversation-capabilities/v1" as const;
export const NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID =
  "remote-claw/native-registration-metadata-evidence/v1" as const;

export type NativeEvidenceSchemaId =
  | typeof NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID
  | typeof DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID
  | typeof NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID
  | typeof NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID
  | typeof NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID;

export type DurableProjectSelection =
  | Readonly<{
      kind: "first_bootstrap";
      collaborationServerId: CollaborationServerId;
      workspaceSelectorId: A1SafeId;
      terminalDescriptor: NativeEngineDescriptor;
      targetDigest: A1Digest;
    }>
  | Readonly<{
      kind: "existing_mapping";
      collaborationServerId: CollaborationServerId;
      projectId: ProjectId;
      workspaceSelectorId: A1SafeId;
      projectTargetSelectorMappingId: ProjectTargetSelectorMappingId;
      mappingGeneration: number;
      targetDigest: A1Digest;
    }>;

export interface NativeRegistrationMetadataInput {
  readonly metadataSchemaId: string;
  readonly metadataBytes: Uint8Array;
}

export interface NativeRegistrationMetadataEvidenceValue {
  readonly metadataSchemaId: string;
  readonly metadataBytes: ProtectedByteSnapshot;
}

export interface CanonicalNativeEvidence<TSchemaId extends NativeEvidenceSchemaId, TValue> {
  readonly canonicalSchemaId: TSchemaId;
  readonly canonicalBytes: ProtectedByteSnapshot;
  readonly canonicalDigest: A1Digest;
  readonly value: TValue;
}

const FIRST_BOOTSTRAP_SELECTION_KEYS = [
  "kind",
  "collaborationServerId",
  "workspaceSelectorId",
  "terminalDescriptor",
  "targetDigest",
] as const;

const EXISTING_MAPPING_SELECTION_KEYS = [
  "kind",
  "collaborationServerId",
  "projectId",
  "workspaceSelectorId",
  "projectTargetSelectorMappingId",
  "mappingGeneration",
  "targetDigest",
] as const;

const NATIVE_CONVERSATION_REF_KEYS = [
  "descriptor",
  "runtimeId",
  "conversationId",
  "incarnation",
] as const;

const NATIVE_CONVERSATION_CAPABILITIES_KEYS = [
  "version",
  "mutationAdmission",
  "history",
  "deliveryEvidence",
  "liveReattach",
] as const;

const NATIVE_REGISTRATION_METADATA_KEYS = ["metadataSchemaId", "metadataBytes"] as const;

function contractBytes(value: unknown, field: string): Uint8Array<ArrayBuffer> {
  try {
    return canonicalByteSnapshot(value as Uint8Array);
  } catch {
    reject(field, "must be a genuine Uint8Array");
  }
}

function protectedBytes(value: unknown, field: string): ProtectedByteSnapshot {
  try {
    return ProtectedByteSnapshot.from(value as Uint8Array);
  } catch {
    reject(field, "must be a genuine Uint8Array");
  }
}

function parseUnionKind(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) {
    reject(field, "must be an object");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  } catch {
    reject(field, "could not be inspected safely");
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    reject(`${field}.kind`, "must be an own data property");
  }
  return descriptor.value as unknown;
}

export function parseNativeEngineDescriptorEvidenceValue(value: unknown): NativeEngineDescriptor {
  return parseNativeEngineDescriptor(value, "nativeEngineDescriptorEvidence.value");
}

export function parseDurableProjectSelectionEvidenceValue(value: unknown): DurableProjectSelection {
  const kind = parseUnionKind(value, "durableProjectSelection");
  if (kind === "first_bootstrap") {
    const row = parseExactRecord(value, FIRST_BOOTSTRAP_SELECTION_KEYS, "durableProjectSelection");
    return frozen({
      kind: parseLiteral(row.kind, "first_bootstrap", "durableProjectSelection.kind"),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        row.collaborationServerId,
        "durableProjectSelection.collaborationServerId",
      ),
      workspaceSelectorId: parseA1SafeId(
        row.workspaceSelectorId,
        "durableProjectSelection.workspaceSelectorId",
      ),
      terminalDescriptor: parseNativeEngineDescriptor(
        row.terminalDescriptor,
        "durableProjectSelection.terminalDescriptor",
      ),
      targetDigest: parseA1Digest(row.targetDigest, "durableProjectSelection.targetDigest"),
    });
  }
  if (kind === "existing_mapping") {
    const row = parseExactRecord(value, EXISTING_MAPPING_SELECTION_KEYS, "durableProjectSelection");
    return frozen({
      kind: parseLiteral(row.kind, "existing_mapping", "durableProjectSelection.kind"),
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        row.collaborationServerId,
        "durableProjectSelection.collaborationServerId",
      ),
      projectId: parseA1CanonicalId("project", row.projectId, "durableProjectSelection.projectId"),
      workspaceSelectorId: parseA1SafeId(
        row.workspaceSelectorId,
        "durableProjectSelection.workspaceSelectorId",
      ),
      projectTargetSelectorMappingId: parseA1CanonicalId(
        "projectTargetSelectorMapping",
        row.projectTargetSelectorMappingId,
        "durableProjectSelection.projectTargetSelectorMappingId",
      ),
      mappingGeneration: parsePositiveSafeInteger(
        row.mappingGeneration,
        "durableProjectSelection.mappingGeneration",
      ),
      targetDigest: parseA1Digest(row.targetDigest, "durableProjectSelection.targetDigest"),
    });
  }
  reject("durableProjectSelection.kind", "is not a selected value");
}

export function parseNativeConversationRefEvidenceValue(value: unknown): NativeConversationRef {
  const row = parseExactRecord(
    value,
    NATIVE_CONVERSATION_REF_KEYS,
    "nativeConversationRefEvidence",
  );
  return frozen({
    descriptor: parseNativeEngineDescriptor(
      row.descriptor,
      "nativeConversationRefEvidence.descriptor",
    ),
    runtimeId: parseA1CanonicalId(
      "nativeRuntime",
      row.runtimeId,
      "nativeConversationRefEvidence.runtimeId",
    ),
    conversationId: parseA1SafeId(
      row.conversationId,
      "nativeConversationRefEvidence.conversationId",
    ),
    incarnation: parsePositiveSafeInteger(
      row.incarnation,
      "nativeConversationRefEvidence.incarnation",
    ),
  });
}

export function parseNativeConversationCapabilitiesEvidenceValue(
  value: unknown,
): NativeConversationCapabilities {
  const row = parseExactRecord(
    value,
    NATIVE_CONVERSATION_CAPABILITIES_KEYS,
    "nativeConversationCapabilitiesEvidence",
  );
  if (typeof row.liveReattach !== "boolean") {
    reject("nativeConversationCapabilitiesEvidence.liveReattach", "must be a boolean");
  }
  return frozen({
    version: parseLiteral(row.version, 1, "nativeConversationCapabilitiesEvidence.version"),
    mutationAdmission: parseEnum(
      row.mutationAdmission,
      ["structured", "mixed", "post_hoc"] as const,
      "nativeConversationCapabilitiesEvidence.mutationAdmission",
    ),
    history: parseEnum(
      row.history,
      ["none", "partial", "complete"] as const,
      "nativeConversationCapabilitiesEvidence.history",
    ),
    deliveryEvidence: parseEnum(
      row.deliveryEvidence,
      ["structured_receipt", "native_observation", "best_effort"] as const,
      "nativeConversationCapabilitiesEvidence.deliveryEvidence",
    ),
    liveReattach: row.liveReattach,
  });
}

export function parseNativeRegistrationMetadataEvidenceValue(
  value: unknown,
): NativeRegistrationMetadataEvidenceValue {
  const row = parseExactRecord(
    value,
    NATIVE_REGISTRATION_METADATA_KEYS,
    "nativeRegistrationMetadataEvidence",
  );
  return frozen({
    metadataSchemaId: parseNonEmptyString(
      row.metadataSchemaId,
      "nativeRegistrationMetadataEvidence.metadataSchemaId",
    ),
    metadataBytes: protectedBytes(
      row.metadataBytes,
      "nativeRegistrationMetadataEvidence.metadataBytes",
    ),
  });
}

class CanonicalEvidenceReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;
  #offset = 0;

  constructor(value: Uint8Array, field: string) {
    this.#bytes = contractBytes(value, field);
  }

  bytes(field: string, expectedLength?: number): Uint8Array<ArrayBuffer> {
    if (this.#bytes.byteLength - this.#offset < 4) {
      reject(field, "has a truncated canonical length prefix");
    }
    const length = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#offset,
      4,
    ).getUint32(0, false);
    this.#offset += 4;
    if (length > this.#bytes.byteLength - this.#offset) {
      reject(field, "has a truncated canonical byte field");
    }
    if (expectedLength !== undefined && length !== expectedLength) {
      reject(field, `must contain exactly ${expectedLength} canonical bytes`);
    }
    const result = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  str(field: string): string {
    const bytes = this.bytes(field);
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      reject(field, "must contain canonical UTF-8");
    }
    return parseNonEmptyString(value, field);
  }

  uint(field: string): number {
    const bytes = this.bytes(field, 8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      0,
      false,
    );
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      reject(field, "must be a non-negative safe integer");
    }
    return Number(value);
  }

  digest(field: string): A1Digest {
    return parseA1Digest(base64urlEncode(this.bytes(field, 32)), field);
  }

  schema(expected: NativeEvidenceSchemaId, field: string): void {
    if (this.str(field) !== expected) {
      reject(field, `must equal ${JSON.stringify(expected)}`);
    }
  }

  finish(field: string): void {
    if (this.#offset !== this.#bytes.byteLength) {
      reject(field, "must not contain trailing canonical data");
    }
  }
}

function encodeDescriptor(value: NativeEngineDescriptor): Uint8Array<ArrayBuffer> {
  const writer = new CanonicalWriter();
  writer.str(NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID);
  writer.str(value.product);
  writer.str(value.access);
  return canonicalByteSnapshot(writer.finish());
}

function decodeDescriptor(bytes: Uint8Array): NativeEngineDescriptor {
  const reader = new CanonicalEvidenceReader(bytes, "nativeEngineDescriptorEvidence.bytes");
  reader.schema(
    NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
    "nativeEngineDescriptorEvidence.canonicalSchemaId",
  );
  const value = parseNativeEngineDescriptor(
    {
      product: reader.str("nativeEngineDescriptorEvidence.product"),
      access: reader.str("nativeEngineDescriptorEvidence.access"),
    },
    "nativeEngineDescriptorEvidence.value",
  );
  reader.finish("nativeEngineDescriptorEvidence.bytes");
  return value;
}

function writeDigest(writer: CanonicalWriter, value: A1Digest): void {
  writer.bytes(base64urlDecode(value));
}

function encodeProjectSelection(value: DurableProjectSelection): Uint8Array<ArrayBuffer> {
  const writer = new CanonicalWriter();
  writer.str(DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID);
  writer.str(value.kind);
  writer.str(value.collaborationServerId);
  if (value.kind === "first_bootstrap") {
    writer.str(value.workspaceSelectorId);
    writer.bytes(encodeDescriptor(value.terminalDescriptor));
  } else {
    writer.str(value.projectId);
    writer.str(value.workspaceSelectorId);
    writer.str(value.projectTargetSelectorMappingId);
    writer.uint(value.mappingGeneration);
  }
  writeDigest(writer, value.targetDigest);
  return canonicalByteSnapshot(writer.finish());
}

function decodeProjectSelection(bytes: Uint8Array): DurableProjectSelection {
  const reader = new CanonicalEvidenceReader(bytes, "durableProjectSelectionEvidence.bytes");
  reader.schema(
    DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
    "durableProjectSelectionEvidence.canonicalSchemaId",
  );
  const kind = reader.str("durableProjectSelectionEvidence.kind");
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    reader.str("durableProjectSelectionEvidence.collaborationServerId"),
    "durableProjectSelectionEvidence.collaborationServerId",
  );
  let value: DurableProjectSelection;
  if (kind === "first_bootstrap") {
    value = frozen({
      kind,
      collaborationServerId,
      workspaceSelectorId: parseA1SafeId(
        reader.str("durableProjectSelectionEvidence.workspaceSelectorId"),
        "durableProjectSelectionEvidence.workspaceSelectorId",
      ),
      terminalDescriptor: decodeDescriptor(
        reader.bytes("durableProjectSelectionEvidence.terminalDescriptor"),
      ),
      targetDigest: reader.digest("durableProjectSelectionEvidence.targetDigest"),
    });
  } else if (kind === "existing_mapping") {
    value = frozen({
      kind,
      collaborationServerId,
      projectId: parseA1CanonicalId(
        "project",
        reader.str("durableProjectSelectionEvidence.projectId"),
        "durableProjectSelectionEvidence.projectId",
      ),
      workspaceSelectorId: parseA1SafeId(
        reader.str("durableProjectSelectionEvidence.workspaceSelectorId"),
        "durableProjectSelectionEvidence.workspaceSelectorId",
      ),
      projectTargetSelectorMappingId: parseA1CanonicalId(
        "projectTargetSelectorMapping",
        reader.str("durableProjectSelectionEvidence.projectTargetSelectorMappingId"),
        "durableProjectSelectionEvidence.projectTargetSelectorMappingId",
      ),
      mappingGeneration: parsePositiveSafeInteger(
        reader.uint("durableProjectSelectionEvidence.mappingGeneration"),
        "durableProjectSelectionEvidence.mappingGeneration",
      ),
      targetDigest: reader.digest("durableProjectSelectionEvidence.targetDigest"),
    });
  } else {
    reject("durableProjectSelectionEvidence.kind", "is not a selected value");
  }
  reader.finish("durableProjectSelectionEvidence.bytes");
  return value;
}

function encodeNativeConversationRef(value: NativeConversationRef): Uint8Array<ArrayBuffer> {
  const writer = new CanonicalWriter();
  writer.str(NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID);
  writer.bytes(encodeDescriptor(value.descriptor));
  writer.str(value.runtimeId);
  writer.uint(value.incarnation);
  writer.str(value.conversationId);
  return canonicalByteSnapshot(writer.finish());
}

function decodeNativeConversationRef(bytes: Uint8Array): NativeConversationRef {
  const reader = new CanonicalEvidenceReader(bytes, "nativeConversationRefEvidence.bytes");
  reader.schema(
    NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
    "nativeConversationRefEvidence.canonicalSchemaId",
  );
  const value = parseNativeConversationRefEvidenceValue({
    descriptor: decodeDescriptor(reader.bytes("nativeConversationRefEvidence.descriptor")),
    runtimeId: reader.str("nativeConversationRefEvidence.runtimeId"),
    incarnation: reader.uint("nativeConversationRefEvidence.incarnation"),
    conversationId: reader.str("nativeConversationRefEvidence.conversationId"),
  });
  reader.finish("nativeConversationRefEvidence.bytes");
  return value;
}

function encodeCapabilities(value: NativeConversationCapabilities): Uint8Array<ArrayBuffer> {
  const writer = new CanonicalWriter();
  writer.str(NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID);
  writer.uint(value.version);
  writer.str(value.mutationAdmission);
  writer.str(value.history);
  writer.str(value.deliveryEvidence);
  writer.uint(value.liveReattach ? 1 : 0);
  return canonicalByteSnapshot(writer.finish());
}

function decodeCapabilities(bytes: Uint8Array): NativeConversationCapabilities {
  const reader = new CanonicalEvidenceReader(bytes, "nativeConversationCapabilitiesEvidence.bytes");
  reader.schema(
    NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
    "nativeConversationCapabilitiesEvidence.canonicalSchemaId",
  );
  const version = reader.uint("nativeConversationCapabilitiesEvidence.version");
  const mutationAdmission = reader.str("nativeConversationCapabilitiesEvidence.mutationAdmission");
  const history = reader.str("nativeConversationCapabilitiesEvidence.history");
  const deliveryEvidence = reader.str("nativeConversationCapabilitiesEvidence.deliveryEvidence");
  const liveReattach = reader.uint("nativeConversationCapabilitiesEvidence.liveReattach");
  if (liveReattach !== 0 && liveReattach !== 1) {
    reject(
      "nativeConversationCapabilitiesEvidence.liveReattach",
      "must be canonically encoded as zero or one",
    );
  }
  const value = parseNativeConversationCapabilitiesEvidenceValue({
    version,
    mutationAdmission,
    history,
    deliveryEvidence,
    liveReattach: liveReattach === 1,
  });
  reader.finish("nativeConversationCapabilitiesEvidence.bytes");
  return value;
}

function encodeMetadata(value: NativeRegistrationMetadataEvidenceValue): Uint8Array<ArrayBuffer> {
  const writer = new CanonicalWriter();
  writer.str(NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID);
  writer.str(value.metadataSchemaId);
  writer.bytes(value.metadataBytes.copyBytes());
  return canonicalByteSnapshot(writer.finish());
}

function decodeMetadata(
  bytes: Uint8Array,
  expectedMetadataSchemaId: string,
): NativeRegistrationMetadataEvidenceValue {
  const reader = new CanonicalEvidenceReader(bytes, "nativeRegistrationMetadataEvidence.bytes");
  reader.schema(
    NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
    "nativeRegistrationMetadataEvidence.canonicalSchemaId",
  );
  const metadataSchemaId = reader.str("nativeRegistrationMetadataEvidence.metadataSchemaId");
  if (metadataSchemaId !== expectedMetadataSchemaId) {
    reject(
      "nativeRegistrationMetadataEvidence.metadataSchemaId",
      `must equal ${JSON.stringify(expectedMetadataSchemaId)}`,
    );
  }
  const value = frozen({
    metadataSchemaId,
    metadataBytes: ProtectedByteSnapshot.from(
      reader.bytes("nativeRegistrationMetadataEvidence.metadataBytes"),
    ),
  });
  reader.finish("nativeRegistrationMetadataEvidence.bytes");
  return value;
}

export function digestCanonicalNativeEvidence(canonicalBytes: Uint8Array): A1Digest {
  const bytes = contractBytes(canonicalBytes, "canonicalNativeEvidence.bytes");
  return parseA1Digest(base64urlEncode(createHash("sha256").update(bytes).digest()));
}

function parseCanonicalEvidenceBytes<TValue>(
  canonicalBytes: Uint8Array,
  decode: (input: Uint8Array<ArrayBuffer>) => TValue,
  encode: (input: TValue) => Uint8Array<ArrayBuffer>,
  field: string,
): TValue {
  const bytes = contractBytes(canonicalBytes, `${field}.canonicalBytes`);
  const value = decode(bytes);
  if (!timingSafeEqual(bytes, encode(value))) {
    reject(`${field}.canonicalBytes`, "must use the selected canonical encoding");
  }
  return value;
}

export function parseCanonicalNativeEngineDescriptorEvidence(
  canonicalBytes: Uint8Array,
): NativeEngineDescriptor {
  return parseCanonicalEvidenceBytes(
    canonicalBytes,
    decodeDescriptor,
    encodeDescriptor,
    "nativeEngineDescriptorEvidence",
  );
}

export function parseCanonicalDurableProjectSelectionEvidence(
  canonicalBytes: Uint8Array,
): DurableProjectSelection {
  return parseCanonicalEvidenceBytes(
    canonicalBytes,
    decodeProjectSelection,
    encodeProjectSelection,
    "durableProjectSelectionEvidence",
  );
}

export function parseCanonicalNativeConversationRefEvidence(
  canonicalBytes: Uint8Array,
): NativeConversationRef {
  return parseCanonicalEvidenceBytes(
    canonicalBytes,
    decodeNativeConversationRef,
    encodeNativeConversationRef,
    "nativeConversationRefEvidence",
  );
}

export function parseCanonicalNativeConversationCapabilitiesEvidence(
  canonicalBytes: Uint8Array,
): NativeConversationCapabilities {
  return parseCanonicalEvidenceBytes(
    canonicalBytes,
    decodeCapabilities,
    encodeCapabilities,
    "nativeConversationCapabilitiesEvidence",
  );
}

export function parseCanonicalNativeRegistrationMetadataEvidence(
  canonicalBytes: Uint8Array,
  expectedMetadataSchemaId: unknown,
): NativeRegistrationMetadataEvidenceValue {
  const schemaId = parseNonEmptyString(
    expectedMetadataSchemaId,
    "nativeRegistrationMetadataEvidence.expectedMetadataSchemaId",
  );
  return parseCanonicalEvidenceBytes(
    canonicalBytes,
    (bytes) => decodeMetadata(bytes, schemaId),
    encodeMetadata,
    "nativeRegistrationMetadataEvidence",
  );
}

function evidenceResult<TSchemaId extends NativeEvidenceSchemaId, TValue>(
  canonicalSchemaId: TSchemaId,
  canonicalBytes: Uint8Array,
  canonicalDigestValue: A1Digest,
  value: TValue,
): CanonicalNativeEvidence<TSchemaId, TValue> {
  return frozen({
    canonicalSchemaId,
    canonicalBytes: ProtectedByteSnapshot.from(canonicalBytes),
    canonicalDigest: canonicalDigestValue,
    value,
  });
}

function createEvidence<TSchemaId extends NativeEvidenceSchemaId, TValue>(
  schemaId: TSchemaId,
  value: TValue,
  encode: (input: TValue) => Uint8Array<ArrayBuffer>,
): CanonicalNativeEvidence<TSchemaId, TValue> {
  const bytes = encode(value);
  return evidenceResult(schemaId, bytes, digestCanonicalNativeEvidence(bytes), value);
}

function verifyEvidence<TSchemaId extends NativeEvidenceSchemaId, TValue>(
  schemaId: TSchemaId,
  encoded: Uint8Array,
  expectedDigest: unknown,
  decode: (input: Uint8Array<ArrayBuffer>) => TValue,
  encode: (input: TValue) => Uint8Array<ArrayBuffer>,
  field: string,
): CanonicalNativeEvidence<TSchemaId, TValue> {
  const bytes = contractBytes(encoded, `${field}.canonicalBytes`);
  const value = parseCanonicalEvidenceBytes(bytes, decode, encode, field);
  const expected = parseA1Digest(expectedDigest, `${field}.expectedDigest`);
  const digest = digestCanonicalNativeEvidence(bytes);
  if (digest !== expected) {
    reject(`${field}.expectedDigest`, "does not match the canonical evidence bytes");
  }
  return evidenceResult(schemaId, bytes, digest, value);
}

export function createNativeEngineDescriptorEvidence(
  value: unknown,
): CanonicalNativeEvidence<
  typeof NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
  NativeEngineDescriptor
> {
  return createEvidence(
    NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
    parseNativeEngineDescriptorEvidenceValue(value),
    encodeDescriptor,
  );
}

export function verifyNativeEngineDescriptorEvidence(
  canonicalBytes: Uint8Array,
  expectedDigest: unknown,
): CanonicalNativeEvidence<
  typeof NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
  NativeEngineDescriptor
> {
  return verifyEvidence(
    NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
    canonicalBytes,
    expectedDigest,
    decodeDescriptor,
    encodeDescriptor,
    "nativeEngineDescriptorEvidence",
  );
}

export function createDurableProjectSelectionEvidence(
  value: unknown,
): CanonicalNativeEvidence<
  typeof DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
  DurableProjectSelection
> {
  return createEvidence(
    DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
    parseDurableProjectSelectionEvidenceValue(value),
    encodeProjectSelection,
  );
}

export function verifyDurableProjectSelectionEvidence(
  canonicalBytes: Uint8Array,
  expectedDigest: unknown,
): CanonicalNativeEvidence<
  typeof DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
  DurableProjectSelection
> {
  return verifyEvidence(
    DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
    canonicalBytes,
    expectedDigest,
    decodeProjectSelection,
    encodeProjectSelection,
    "durableProjectSelectionEvidence",
  );
}

export function createNativeConversationRefEvidence(
  value: unknown,
): CanonicalNativeEvidence<
  typeof NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
  NativeConversationRef
> {
  return createEvidence(
    NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
    parseNativeConversationRefEvidenceValue(value),
    encodeNativeConversationRef,
  );
}

export function verifyNativeConversationRefEvidence(
  canonicalBytes: Uint8Array,
  expectedDigest: unknown,
): CanonicalNativeEvidence<
  typeof NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
  NativeConversationRef
> {
  return verifyEvidence(
    NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
    canonicalBytes,
    expectedDigest,
    decodeNativeConversationRef,
    encodeNativeConversationRef,
    "nativeConversationRefEvidence",
  );
}

export function createNativeConversationCapabilitiesEvidence(
  value: unknown,
): CanonicalNativeEvidence<
  typeof NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
  NativeConversationCapabilities
> {
  return createEvidence(
    NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
    parseNativeConversationCapabilitiesEvidenceValue(value),
    encodeCapabilities,
  );
}

export function verifyNativeConversationCapabilitiesEvidence(
  canonicalBytes: Uint8Array,
  expectedDigest: unknown,
): CanonicalNativeEvidence<
  typeof NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
  NativeConversationCapabilities
> {
  return verifyEvidence(
    NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
    canonicalBytes,
    expectedDigest,
    decodeCapabilities,
    encodeCapabilities,
    "nativeConversationCapabilitiesEvidence",
  );
}

export function createNativeRegistrationMetadataEvidence(
  value: NativeRegistrationMetadataInput,
): CanonicalNativeEvidence<
  typeof NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
  NativeRegistrationMetadataEvidenceValue
> {
  return createEvidence(
    NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
    parseNativeRegistrationMetadataEvidenceValue(value),
    encodeMetadata,
  );
}

export function verifyNativeRegistrationMetadataEvidence(
  canonicalBytes: Uint8Array,
  expectedDigest: unknown,
  expectedMetadataSchemaId: unknown,
): CanonicalNativeEvidence<
  typeof NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
  NativeRegistrationMetadataEvidenceValue
> {
  const schemaId = parseNonEmptyString(
    expectedMetadataSchemaId,
    "nativeRegistrationMetadataEvidence.expectedMetadataSchemaId",
  );
  return verifyEvidence(
    NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
    canonicalBytes,
    expectedDigest,
    (bytes) => decodeMetadata(bytes, schemaId),
    encodeMetadata,
    "nativeRegistrationMetadataEvidence",
  );
}
