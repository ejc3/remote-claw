// Browser-safe selected-A1 semantic-result byte contracts.
//
// This module deliberately owns no persistence, signing, cursor advancement, outbox execution, or
// broker behavior. It freezes only the exact rejected-result payloads and identities consumed by
// the dormant A1 result finalizer.

import { type BrokerChannelCursorV1, parseBrokerChannelCursorV1 } from "./a1-broker.js";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { sha256 } from "./bytes.js";
import { CanonicalWriter, canonicalByteSnapshot } from "./canonical.js";

export const A1_PROJECTION_ACCEPTED_PAYLOAD_SCHEMA_ID =
  "remote-claw/a1-projection-accepted/v1" as const;
export const A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID = "remote-claw/a1-action-result/v1" as const;
export const A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID =
  "remote-claw/a1-chat-creation-result/v1" as const;
export const A1_STORED_SEMANTIC_RESULT_DOMAIN = "remote-claw/a1/stored-semantic-result/v1" as const;
export const A1_RESULT_DELIVERY_ID_DOMAIN = "remote-claw/a1/result-delivery/v1" as const;

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const MAX_SAFE_ID_BYTES = 128;
const DIGEST_BYTES = 32;
const DELIVERY_ATTEMPT_BYTES = 16;

export type A1StoredSemanticResultSchemaId =
  | typeof A1_PROJECTION_ACCEPTED_PAYLOAD_SCHEMA_ID
  | typeof A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID
  | typeof A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID;

export type A1ResultContractErrorReason =
  | "invalid-record"
  | "invalid-field"
  | "bad-length"
  | "non-canonical"
  | "identity-mismatch"
  | "incomplete-candidate";

export class A1ResultContractError extends Error {
  readonly reason: A1ResultContractErrorReason;

  constructor(reason: A1ResultContractErrorReason, message: string) {
    super(`A1 result contract rejected: ${message}`);
    this.name = "A1ResultContractError";
    this.reason = reason;
  }

  static is(error: unknown): error is A1ResultContractError {
    return error instanceof A1ResultContractError;
  }
}

function reject(reason: A1ResultContractErrorReason, message: string): never {
  throw new A1ResultContractError(reason, message);
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  field: string,
): { readonly [P in K[number]]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject("invalid-record", `${field} must be a plain object`);
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return reject("invalid-record", `${field} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return reject("invalid-record", `${field} must be a plain object`);
  }
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return reject("invalid-record", `${field} must contain exactly ${keys.join(", ")}`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return reject("invalid-record", `${field}.${key} could not be inspected safely`);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return reject("invalid-record", `${field}.${key} must be an own data property`);
    }
    snapshot[key] = descriptor.value as unknown;
  }
  return snapshot as { readonly [P in K[number]]: unknown };
}

function canonicalBase64url(value: string, expectedBytes: number, field: string): string {
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value);
  } catch {
    return reject("invalid-field", `${field} must use canonical unpadded base64url`);
  }
  if (decoded.byteLength !== expectedBytes || base64urlEncode(decoded) !== value) {
    return reject(
      "invalid-field",
      `${field} must use canonical unpadded base64url of ${expectedBytes} bytes`,
    );
  }
  return value;
}

function safeId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SAFE_ID_BYTES ||
    !SAFE_ID.test(value)
  ) {
    return reject("invalid-field", `${field} must be 1-128 ASCII bytes matching [A-Za-z0-9._:-]+`);
  }
  return value;
}

function canonicalId(value: unknown, prefix: "rrs_" | "rio_" | "rrd_", field: string): string {
  const parsed = safeId(value, field);
  if (!parsed.startsWith(prefix)) {
    return reject("invalid-field", `${field} must use the ${prefix} namespace`);
  }
  canonicalBase64url(parsed.slice(prefix.length), DIGEST_BYTES, field);
  return parsed;
}

function deliveryAttemptId(value: unknown, field: string): string {
  const parsed = safeId(value, field);
  if (!parsed.startsWith("rda_")) {
    return reject("invalid-field", `${field} must use the rda_ namespace`);
  }
  canonicalBase64url(parsed.slice(4), DELIVERY_ATTEMPT_BYTES, field);
  return parsed;
}

function safeUint(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return reject("invalid-field", `${field} must be a non-negative safe integer`);
  }
  return value;
}

function storedSchemaId(value: unknown, field: string): A1StoredSemanticResultSchemaId {
  if (
    value !== A1_PROJECTION_ACCEPTED_PAYLOAD_SCHEMA_ID &&
    value !== A1_ACTION_RESULT_PAYLOAD_SCHEMA_ID &&
    value !== A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID
  ) {
    return reject("invalid-field", `${field} must be a selected A1 semantic-result schema ID`);
  }
  return value;
}

function boundedUtf8(raw: string | Uint8Array, field: string): { text: string; bytes: Uint8Array } {
  let bytes: Uint8Array;
  let text: string;
  if (typeof raw === "string") {
    text = raw;
    bytes = new TextEncoder().encode(raw);
  } else {
    try {
      bytes = canonicalByteSnapshot(raw);
    } catch {
      return reject("invalid-field", `${field} must be a string or Uint8Array`);
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      bytes.fill(0);
      return reject("invalid-field", `${field} must be well-formed UTF-8`);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) {
    bytes.fill(0);
    return reject("non-canonical", `${field} must not begin with a UTF-8 BOM`);
  }
  return { text, bytes };
}

function jsonValue(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return reject("invalid-record", `${field} must be valid JSON`);
  }
}

export interface A1RejectedActionResultPayloadV1 {
  readonly v: 1;
  readonly resultId: string;
  readonly sourceMsgId: string;
  readonly sourceRecordKind: "user";
  readonly decision: "rejected";
  readonly commandSeq: number;
}

export interface A1RejectedChatCreationResultPayloadV1 {
  readonly v: 1;
  readonly resultId: string;
  readonly sourceMsgId: string;
  readonly decision: "rejected";
  readonly targetLogicalChatId: null;
  readonly commandSeq: number;
}

function parseActionCanonicalValue(value: unknown): A1RejectedActionResultPayloadV1 {
  const row = exactRecord(
    value,
    ["v", "resultId", "sourceMsgId", "sourceRecordKind", "decision", "commandSeq"] as const,
    "actionResultPayload",
  );
  if (row.v !== 1) return reject("invalid-field", "actionResultPayload.v must be exactly 1");
  if (row.decision !== "rejected") {
    return reject("invalid-field", "actionResultPayload.decision must be rejected");
  }
  if (row.sourceRecordKind !== "user") {
    return reject("invalid-field", "actionResultPayload.sourceRecordKind must be user");
  }
  return Object.freeze({
    v: 1,
    resultId: canonicalId(row.resultId, "rrs_", "actionResultPayload.resultId"),
    sourceMsgId: safeId(row.sourceMsgId, "actionResultPayload.sourceMsgId"),
    sourceRecordKind: "user",
    decision: "rejected",
    commandSeq: safeUint(row.commandSeq, "actionResultPayload.commandSeq"),
  });
}

function parseActionWireValue(value: unknown): A1RejectedActionResultPayloadV1 {
  const row = exactRecord(
    value,
    ["v", "result_id", "source_msg_id", "source_record_kind", "decision", "command_seq"] as const,
    "actionResultPayload",
  );
  return parseActionCanonicalValue({
    v: row.v,
    resultId: row.result_id,
    sourceMsgId: row.source_msg_id,
    sourceRecordKind: row.source_record_kind,
    decision: row.decision,
    commandSeq: row.command_seq,
  });
}

function encodeActionValue(value: A1RejectedActionResultPayloadV1): string {
  return `{"v":1,"result_id":"${value.resultId}","source_msg_id":"${value.sourceMsgId}","source_record_kind":"${value.sourceRecordKind}","decision":"rejected","command_seq":${value.commandSeq}}`;
}

export function encodeA1RejectedActionResultPayloadV1(value: unknown): string {
  return encodeActionValue(parseActionCanonicalValue(value));
}

export function encodeA1RejectedActionResultPayloadV1Bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeA1RejectedActionResultPayloadV1(value));
}

export function parseA1RejectedActionResultPayloadV1(
  raw: string | Uint8Array,
): A1RejectedActionResultPayloadV1 {
  const source = boundedUtf8(raw, "actionResultPayload");
  try {
    const parsed = parseActionWireValue(jsonValue(source.text, "actionResultPayload"));
    if (encodeActionValue(parsed) !== source.text) {
      return reject(
        "non-canonical",
        "actionResultPayload must use exact compact JSON with keys v,result_id,source_msg_id,source_record_kind,decision,command_seq in that order",
      );
    }
    return parsed;
  } finally {
    source.bytes.fill(0);
  }
}

function parseChatCreationCanonicalValue(value: unknown): A1RejectedChatCreationResultPayloadV1 {
  const row = exactRecord(
    value,
    ["v", "resultId", "sourceMsgId", "decision", "targetLogicalChatId", "commandSeq"] as const,
    "chatCreationResultPayload",
  );
  if (row.v !== 1) {
    return reject("invalid-field", "chatCreationResultPayload.v must be exactly 1");
  }
  if (row.decision !== "rejected") {
    return reject("invalid-field", "chatCreationResultPayload.decision must be rejected");
  }
  if (row.targetLogicalChatId !== null) {
    return reject(
      "invalid-field",
      "chatCreationResultPayload.targetLogicalChatId must be null for rejection",
    );
  }
  return Object.freeze({
    v: 1,
    resultId: canonicalId(row.resultId, "rrs_", "chatCreationResultPayload.resultId"),
    sourceMsgId: safeId(row.sourceMsgId, "chatCreationResultPayload.sourceMsgId"),
    decision: "rejected",
    targetLogicalChatId: null,
    commandSeq: safeUint(row.commandSeq, "chatCreationResultPayload.commandSeq"),
  });
}

function parseChatCreationWireValue(value: unknown): A1RejectedChatCreationResultPayloadV1 {
  const row = exactRecord(
    value,
    [
      "v",
      "result_id",
      "source_msg_id",
      "decision",
      "target_logical_chat_id",
      "command_seq",
    ] as const,
    "chatCreationResultPayload",
  );
  return parseChatCreationCanonicalValue({
    v: row.v,
    resultId: row.result_id,
    sourceMsgId: row.source_msg_id,
    decision: row.decision,
    targetLogicalChatId: row.target_logical_chat_id,
    commandSeq: row.command_seq,
  });
}

function encodeChatCreationValue(value: A1RejectedChatCreationResultPayloadV1): string {
  return `{"v":1,"result_id":"${value.resultId}","source_msg_id":"${value.sourceMsgId}","decision":"rejected","target_logical_chat_id":null,"command_seq":${value.commandSeq}}`;
}

export function encodeA1RejectedChatCreationResultPayloadV1(value: unknown): string {
  return encodeChatCreationValue(parseChatCreationCanonicalValue(value));
}

export function encodeA1RejectedChatCreationResultPayloadV1Bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeA1RejectedChatCreationResultPayloadV1(value));
}

export function parseA1RejectedChatCreationResultPayloadV1(
  raw: string | Uint8Array,
): A1RejectedChatCreationResultPayloadV1 {
  const source = boundedUtf8(raw, "chatCreationResultPayload");
  try {
    const parsed = parseChatCreationWireValue(jsonValue(source.text, "chatCreationResultPayload"));
    if (encodeChatCreationValue(parsed) !== source.text) {
      return reject(
        "non-canonical",
        "chatCreationResultPayload must use exact compact JSON with keys v,result_id,source_msg_id,decision,target_logical_chat_id,command_seq in that order",
      );
    }
    return parsed;
  } finally {
    source.bytes.fill(0);
  }
}

export interface A1StoredSemanticResultDigestInput {
  readonly storedSemanticResultSchemaId: A1StoredSemanticResultSchemaId;
  readonly exactCompactUtf8Payload: Uint8Array;
}

function parseStoredSemanticResultDigestInput(value: unknown): A1StoredSemanticResultDigestInput {
  const row = exactRecord(
    value,
    ["storedSemanticResultSchemaId", "exactCompactUtf8Payload"] as const,
    "storedSemanticResult",
  );
  let payload: Uint8Array;
  if (!(row.exactCompactUtf8Payload instanceof Uint8Array)) {
    return reject(
      "invalid-field",
      "storedSemanticResult.exactCompactUtf8Payload must be a Uint8Array",
    );
  }
  try {
    payload = canonicalByteSnapshot(row.exactCompactUtf8Payload);
  } catch {
    return reject(
      "invalid-field",
      "storedSemanticResult.exactCompactUtf8Payload must be a Uint8Array",
    );
  }
  return Object.freeze({
    storedSemanticResultSchemaId: storedSchemaId(
      row.storedSemanticResultSchemaId,
      "storedSemanticResult.storedSemanticResultSchemaId",
    ),
    exactCompactUtf8Payload: payload,
  });
}

export function canonicalA1StoredSemanticResultPreimage(value: unknown): Uint8Array {
  const selected = parseStoredSemanticResultDigestInput(value);
  const writer = new CanonicalWriter();
  try {
    writer.str(A1_STORED_SEMANTIC_RESULT_DOMAIN);
    writer.str(selected.storedSemanticResultSchemaId);
    writer.bytes(selected.exactCompactUtf8Payload);
    return writer.finish();
  } finally {
    selected.exactCompactUtf8Payload.fill(0);
  }
}

export async function a1StoredSemanticResultDigest(value: unknown): Promise<string> {
  const preimage = canonicalA1StoredSemanticResultPreimage(value);
  try {
    return base64urlEncode(await sha256(preimage));
  } finally {
    preimage.fill(0);
  }
}

export interface A1IngressResultIdentity {
  readonly ingressResultId: string;
  readonly stableSemanticResultId: string;
}

export function parseA1IngressResultIdentity(value: unknown): A1IngressResultIdentity {
  const row = exactRecord(
    value,
    ["ingressResultId", "stableSemanticResultId"] as const,
    "ingressResultIdentity",
  );
  const ingressResultId = canonicalId(
    row.ingressResultId,
    "rrs_",
    "ingressResultIdentity.ingressResultId",
  );
  const stableSemanticResultId = canonicalId(
    row.stableSemanticResultId,
    "rrs_",
    "ingressResultIdentity.stableSemanticResultId",
  );
  if (ingressResultId !== stableSemanticResultId) {
    return reject(
      "identity-mismatch",
      "selected A1 ingressResultId must equal stableSemanticResultId",
    );
  }
  return Object.freeze({ ingressResultId, stableSemanticResultId });
}

export interface A1ResultDeliveryIdentityInput {
  readonly ingressResultId: string;
  readonly triggerIngressObservationId: string;
}

function parseResultDeliveryIdentity(value: unknown): A1ResultDeliveryIdentityInput {
  const row = exactRecord(
    value,
    ["ingressResultId", "triggerIngressObservationId"] as const,
    "resultDeliveryIdentity",
  );
  return Object.freeze({
    ingressResultId: canonicalId(
      row.ingressResultId,
      "rrs_",
      "resultDeliveryIdentity.ingressResultId",
    ),
    triggerIngressObservationId: canonicalId(
      row.triggerIngressObservationId,
      "rio_",
      "resultDeliveryIdentity.triggerIngressObservationId",
    ),
  });
}

export function canonicalA1ResultDeliveryIdPreimage(value: unknown): Uint8Array {
  const selected = parseResultDeliveryIdentity(value);
  const writer = new CanonicalWriter();
  writer.str(A1_RESULT_DELIVERY_ID_DOMAIN);
  writer.str(selected.ingressResultId);
  writer.str(selected.triggerIngressObservationId);
  return writer.finish();
}

export async function deriveA1ResultDeliveryId(value: unknown): Promise<string> {
  const preimage = canonicalA1ResultDeliveryIdPreimage(value);
  try {
    return `rrd_${base64urlEncode(await sha256(preimage))}`;
  } finally {
    preimage.fill(0);
  }
}

export interface A1CompletionObservation {
  readonly ingressObservationId: string;
  readonly deliveryAttemptId: string;
  readonly cursor: BrokerChannelCursorV1;
  readonly part: number;
  readonly parts: number;
  readonly disposition: "new_part";
}

export interface A1CompletionObservationSelectionInput {
  readonly acceptedDeliveryAttemptId: string;
  readonly expectedParts: number;
  readonly observations: readonly A1CompletionObservation[];
}

export interface A1CompletionObservationSelection {
  readonly triggerIngressObservationId: string;
  readonly terminalIngressCursor: BrokerChannelCursorV1;
}

function compareCursors(left: BrokerChannelCursorV1, right: BrokerChannelCursorV1): number {
  if (left.channelGeneration !== right.channelGeneration) {
    return left.channelGeneration < right.channelGeneration ? -1 : 1;
  }
  if (left.frameIndex === right.frameIndex) return 0;
  return left.frameIndex < right.frameIndex ? -1 : 1;
}

/** Select the last route-ordered newly accepted part of the complete accepted candidate. */
export function selectA1CompletionObservation(
  value: A1CompletionObservationSelectionInput,
): A1CompletionObservationSelection {
  const attemptId = deliveryAttemptId(
    value.acceptedDeliveryAttemptId,
    "completionSelection.acceptedDeliveryAttemptId",
  );
  const expectedParts = safeUint(value.expectedParts, "completionSelection.expectedParts");
  if (expectedParts < 1 || expectedParts > 32) {
    return reject("bad-length", "completionSelection.expectedParts must be between 1 and 32");
  }
  if (!Array.isArray(value.observations)) {
    return reject("invalid-field", "completionSelection.observations must be an array");
  }
  const seenParts = new Set<number>();
  let selected: A1CompletionObservation | null = null;
  for (const raw of value.observations) {
    const row = exactRecord(
      raw,
      [
        "ingressObservationId",
        "deliveryAttemptId",
        "cursor",
        "part",
        "parts",
        "disposition",
      ] as const,
      "completionSelection.observation",
    );
    if (row.disposition !== "new_part") {
      return reject("invalid-field", "completion observations must have disposition new_part");
    }
    const observationAttempt = deliveryAttemptId(
      row.deliveryAttemptId,
      "completionSelection.observation.deliveryAttemptId",
    );
    if (observationAttempt !== attemptId) {
      continue;
    }
    const part = safeUint(row.part, "completionSelection.observation.part");
    const parts = safeUint(row.parts, "completionSelection.observation.parts");
    if (parts !== expectedParts || part >= expectedParts) {
      return reject("invalid-field", "completion observation part coordinates are inconsistent");
    }
    if (seenParts.has(part)) {
      return reject("invalid-field", "accepted candidate has duplicate new_part observations");
    }
    seenParts.add(part);
    let cursor: BrokerChannelCursorV1;
    try {
      cursor = parseBrokerChannelCursorV1(row.cursor);
    } catch {
      return reject("invalid-field", "completion observation cursor is invalid");
    }
    const observation: A1CompletionObservation = Object.freeze({
      ingressObservationId: canonicalId(
        row.ingressObservationId,
        "rio_",
        "completionSelection.observation.ingressObservationId",
      ),
      deliveryAttemptId: observationAttempt,
      cursor,
      part,
      parts,
      disposition: "new_part",
    });
    if (selected === null || compareCursors(selected.cursor, cursor) < 0) selected = observation;
  }
  if (selected === null || seenParts.size !== expectedParts) {
    return reject(
      "incomplete-candidate",
      "accepted candidate must have exactly one new_part observation for every expected part",
    );
  }
  return Object.freeze({
    triggerIngressObservationId: selected.ingressObservationId,
    terminalIngressCursor: selected.cursor,
  });
}
