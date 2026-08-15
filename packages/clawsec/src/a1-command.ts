// Browser-safe A1 common-command byte contracts.
//
// This module deliberately owns no persistence, command ordering, signing-key custody, output,
// dispatch, or effect behavior. It only freezes the canonical values that those later layers store
// and sign.

import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { sha256 } from "./bytes.js";
import { CanonicalWriter, canonicalByteSnapshot } from "./canonical.js";

export const A1_COMMAND_SOURCE_INGRESS_DOMAIN = "remote-claw/command-source/a1/v1" as const;
export const A1_COMMAND_SOURCE_OUTSIDE_DOMAIN = "remote-claw/command-source/outside/v1" as const;
export const A1_COLLABORATION_COMMAND_ID_DOMAIN = "remote-claw/collaboration-command/v1" as const;
export const A1_COLLABORATION_COMMAND_RECORD_DOMAIN =
  "remote-claw/collaboration-command-record/v1" as const;

export const A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID =
  "remote-claw/command-payload/user-text/v1" as const;
export const A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID =
  "remote-claw/command-payload/new-chat/v1" as const;
export const A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID =
  "remote-claw/command-payload/attachment/v1" as const;
export const A1_ATTACHMENT_ITEM_SCHEMA_ID =
  "remote-claw/command-payload/attachment-item/v1" as const;
export const A1_ATTACHMENT_ITEM_VECTOR_DOMAIN =
  "remote-claw/command-payload/attachment-item-vector/v1" as const;
export const A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID =
  "remote-claw/command-payload/unsupported-recognized/v1" as const;

export const A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID =
  "remote-claw/collaboration-command-decision-evidence/v1" as const;
export const A1_COMMAND_DECISION_POLICY_ID = "remote-claw/common-adjudication-policy/v1" as const;
export const A1_OPENCODE_PRE_DECISION_NORMALIZATION_SCHEMA_ID =
  "remote-claw/opencode-pre-decision-normalization/v1" as const;
export const A1_NATIVE_SERVER_EXECUTOR_EVIDENCE_SCHEMA_ID =
  "remote-claw/executor-evidence/native-server/v1" as const;
export const A1_NATIVE_BINDING_EXECUTOR_EVIDENCE_SCHEMA_ID =
  "remote-claw/executor-evidence/native-binding/v1" as const;
export const A1_NESTED_MANAGEMENT_EXECUTOR_EVIDENCE_SCHEMA_ID =
  "remote-claw/executor-evidence/nested-management/v1" as const;
export const A1_NESTED_CHAT_EDGE_EXECUTOR_EVIDENCE_SCHEMA_ID =
  "remote-claw/executor-evidence/nested-chat-edge/v1" as const;

export const A1_COMMAND_RESULT_ID_DOMAIN =
  "remote-claw/collaboration-command-result-id/v1" as const;
export const A1_COMMAND_RESULT_SCHEMA_ID = "remote-claw/collaboration-command-result/v1" as const;
export const A1_SIGNED_COMMAND_RESULT_DOMAIN =
  "remote-claw/collaboration-command-result-signed/v1" as const;
export const A1_COMMAND_SIGNING_GROUP_ID_DOMAIN =
  "remote-claw/collaboration-command-signing-group/v1" as const;
export const A1_COMMAND_RESULT_PREPARATION_ID_DOMAIN =
  "remote-claw/collaboration-command-result-preparation/v1" as const;

export const A1_COMMAND_MAX_USER_TEXT_BYTES = 48 * 1024 * 1024;
export const A1_COMMAND_MAX_ATTACHMENT_ITEMS = 24;
export const A1_COMMAND_MAX_ATTACHMENT_ITEM_BYTES = 12 * 1024 * 1024;
export const A1_COMMAND_MAX_ATTACHMENT_TOTAL_BYTES = 36 * 1024 * 1024;
export const A1_COMMAND_MAX_ATTACHMENT_FILENAME_BYTES = 255;
export const A1_COMMAND_MAX_ATTACHMENT_CAPTION_BYTES = 16 * 1024;

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const SCHEMA_ID = /^[A-Za-z0-9._:/-]+$/;
const MAX_SAFE_ID_BYTES = 128;
const MAX_SCHEMA_ID_BYTES = 1024;
const RANDOM_ID_BYTES = 16;
const DIGEST_BYTES = 32;
const SIGNATURE_BYTES = 64;
const IDENTITY_ID_BYTES = 16;

export type A1CommandContractErrorReason =
  | "invalid-record"
  | "invalid-field"
  | "bad-length"
  | "digest-mismatch"
  | "scope-mismatch";

export class A1CommandContractError extends Error {
  readonly reason: A1CommandContractErrorReason;

  constructor(reason: A1CommandContractErrorReason, message: string) {
    super(`A1 command contract rejected: ${message}`);
    this.name = "A1CommandContractError";
    this.reason = reason;
  }

  static is(error: unknown): error is A1CommandContractError {
    return error instanceof A1CommandContractError;
  }
}

function reject(reason: A1CommandContractErrorReason, message: string): never {
  throw new A1CommandContractError(reason, message);
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

function exactArray(value: unknown, field: string, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value)) return reject("invalid-record", `${field} must be an array`);
  if (value.length > maximumLength) {
    return reject("bad-length", `${field} must not exceed ${maximumLength} entries`);
  }
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return reject("invalid-record", `${field} could not be inspected safely`);
  }
  if (
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length),
    )
  ) {
    return reject("invalid-record", `${field} must not contain extra properties`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return reject("invalid-record", `${field}[${index}] could not be inspected safely`);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return reject("invalid-record", `${field}[${index}] must be an own data property`);
    }
    snapshot.push(descriptor.value as unknown);
  }
  return snapshot;
}

function literal<const T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    return reject("invalid-field", `${field} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function safeUint(value: unknown, field: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    Object.is(value, -0)
  ) {
    const qualifier = minimum === 0 ? "non-negative" : `at least ${minimum}`;
    return reject("invalid-field", `${field} must be a safe integer ${qualifier}`);
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

function schemaId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SCHEMA_ID_BYTES ||
    !SCHEMA_ID.test(value)
  ) {
    return reject(
      "invalid-field",
      `${field} must be 1-1024 ASCII bytes matching [A-Za-z0-9._:/-]+`,
    );
  }
  return value;
}

function canonicalBase64url(value: unknown, expectedBytes: number, field: string): string {
  if (typeof value !== "string") {
    return reject("invalid-field", `${field} must be a string`);
  }
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

function canonicalId(value: unknown, prefix: string, bytes: number, field: string): string {
  const parsed = safeId(value, field);
  if (!parsed.startsWith(prefix)) {
    return reject("invalid-field", `${field} must use the ${prefix} namespace`);
  }
  canonicalBase64url(parsed.slice(prefix.length), bytes, field);
  return parsed;
}

function digest(value: unknown, field: string): string {
  return canonicalBase64url(value, DIGEST_BYTES, field);
}

function optionalDigest(value: unknown, field: string): string | null {
  return value === null ? null : digest(value, field);
}

function signature(value: unknown, field: string): string {
  return canonicalBase64url(value, SIGNATURE_BYTES, field);
}

function unicodeScalarString(value: unknown, field: string): string {
  if (typeof value !== "string") return reject("invalid-field", `${field} must be a string`);
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        return reject("invalid-field", `${field} must contain only Unicode scalar values`);
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return reject("invalid-field", `${field} must contain only Unicode scalar values`);
    }
  }
  return value;
}

function boundedScalarString(value: unknown, field: string, maximumBytes: number): string {
  const parsed = unicodeScalarString(value, field);
  if (new TextEncoder().encode(parsed).byteLength > maximumBytes) {
    return reject("bad-length", `${field} must not exceed ${maximumBytes} UTF-8 bytes`);
  }
  return parsed;
}

function snapshotIdentity(value: unknown, field: string): Uint8Array {
  let identity: Uint8Array;
  try {
    identity = canonicalByteSnapshot(value as Uint8Array);
  } catch {
    return reject("invalid-field", `${field} must be a Uint8Array`);
  }
  if (identity.byteLength !== IDENTITY_ID_BYTES) {
    return reject("bad-length", `${field} must be exactly ${IDENTITY_ID_BYTES} bytes`);
  }
  return identity;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function writeOptionalDigest(writer: CanonicalWriter, value: string | null): void {
  writer.optionalBytes(value === null ? null : base64urlDecode(value));
}

async function sha256Base64url(bytes: Uint8Array): Promise<string> {
  try {
    return base64urlEncode(await sha256(bytes));
  } finally {
    bytes.fill(0);
  }
}

export type A1CommandScopeKind = "server_control" | "chat";
export type A1CommandSourceKind = "a1_ingress" | "official_client" | "automation" | "nested_server";
export type A1CommandDisposition = "admitted" | "queued" | "rejected";
export type A1AdmittedTargetKind =
  | "native_server"
  | "native_binding"
  | "nested_management"
  | "nested_chat_edge";
export type A1NativeMutationFamily =
  | "user_text"
  | "steer_text"
  | "blank_submit"
  | "attachment"
  | "new_chat"
  | "clear"
  | "interrupt"
  | "compact"
  | "permission_answer"
  | "question_answer"
  | "set_model"
  | "set_mode"
  | "end"
  | "fork"
  | "archive"
  | "unarchive"
  | "revert"
  | "unrevert"
  | "shell"
  | "session_command"
  | "message_mutation"
  | "part_mutation"
  | "share"
  | "rename"
  | "delete";

const MUTATION_FAMILIES = new Set<A1NativeMutationFamily>([
  "user_text",
  "steer_text",
  "blank_submit",
  "attachment",
  "new_chat",
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
]);

function mutationFamily(value: unknown, field: string): A1NativeMutationFamily {
  if (typeof value !== "string" || !MUTATION_FAMILIES.has(value as A1NativeMutationFamily)) {
    return reject("invalid-field", `${field} must be a selected native mutation family`);
  }
  return value as A1NativeMutationFamily;
}

export interface A1UserTextCommandPayload {
  readonly schemaVersion: 1;
  readonly canonicalCommandPayloadSchemaId: typeof A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID;
  readonly text: string;
}

export interface A1NewChatCommandPayload {
  readonly schemaVersion: 1;
  readonly canonicalCommandPayloadSchemaId: typeof A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID;
  readonly creationIntent: "first_bootstrap" | "new_chat";
  readonly projectId: string;
  readonly workspaceSelectorId: string;
}

export interface A1AttachmentCommandPayload {
  readonly schemaVersion: 1;
  readonly canonicalCommandPayloadSchemaId: typeof A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID;
  readonly caption: string | null;
  /** Durable ref to the contiguous item manifest; deliberately excluded from canonical bytes. */
  readonly itemVectorRef: string;
  readonly itemCount: number;
  readonly itemVectorDigest: string;
}

export interface A1UnsupportedRecognizedCommandPayload {
  readonly schemaVersion: 1;
  readonly canonicalCommandPayloadSchemaId: typeof A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID;
  readonly normalizedMutationFamily: A1NativeMutationFamily;
  readonly sourcePayloadSchemaId: string;
  readonly sourcePayloadDigest: string;
  readonly sourceEventFingerprint: string;
}

export type A1CommandPayload =
  | A1UserTextCommandPayload
  | A1NewChatCommandPayload
  | A1AttachmentCommandPayload
  | A1UnsupportedRecognizedCommandPayload;

export type A1CanonicalAttachmentMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

export interface A1CanonicalAttachmentItemRecord {
  readonly schemaVersion: 1;
  readonly canonicalItemSchemaId: typeof A1_ATTACHMENT_ITEM_SCHEMA_ID;
  readonly itemIndex: number;
  readonly clientFileName: string;
  readonly mediaType: A1CanonicalAttachmentMediaType;
  readonly contentLength: number;
  /** Durable ref to the exact decoded content; deliberately excluded from canonical bytes. */
  readonly contentRef: string;
  readonly contentDigest: string;
  readonly canonicalItemDigest: string;
}

function parseUserTextPayload(value: unknown): A1UserTextCommandPayload {
  const row = exactRecord(
    value,
    ["schemaVersion", "canonicalCommandPayloadSchemaId", "text"] as const,
    "commandPayload",
  );
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "commandPayload.schemaVersion"),
    canonicalCommandPayloadSchemaId: literal(
      row.canonicalCommandPayloadSchemaId,
      A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID,
      "commandPayload.canonicalCommandPayloadSchemaId",
    ),
    text: boundedScalarString(row.text, "commandPayload.text", A1_COMMAND_MAX_USER_TEXT_BYTES),
  });
}

function parseNewChatPayload(value: unknown): A1NewChatCommandPayload {
  const row = exactRecord(
    value,
    [
      "schemaVersion",
      "canonicalCommandPayloadSchemaId",
      "creationIntent",
      "projectId",
      "workspaceSelectorId",
    ] as const,
    "commandPayload",
  );
  if (row.creationIntent !== "first_bootstrap" && row.creationIntent !== "new_chat") {
    return reject(
      "invalid-field",
      "commandPayload.creationIntent must be first_bootstrap or new_chat",
    );
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "commandPayload.schemaVersion"),
    canonicalCommandPayloadSchemaId: literal(
      row.canonicalCommandPayloadSchemaId,
      A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID,
      "commandPayload.canonicalCommandPayloadSchemaId",
    ),
    creationIntent: row.creationIntent,
    projectId: safeId(row.projectId, "commandPayload.projectId"),
    workspaceSelectorId: safeId(row.workspaceSelectorId, "commandPayload.workspaceSelectorId"),
  });
}

function parseAttachmentPayload(value: unknown): A1AttachmentCommandPayload {
  const row = exactRecord(
    value,
    [
      "schemaVersion",
      "canonicalCommandPayloadSchemaId",
      "caption",
      "itemVectorRef",
      "itemCount",
      "itemVectorDigest",
    ] as const,
    "commandPayload",
  );
  const itemCount = safeUint(row.itemCount, "commandPayload.itemCount", 1);
  if (itemCount > A1_COMMAND_MAX_ATTACHMENT_ITEMS) {
    return reject(
      "bad-length",
      `commandPayload.itemCount must not exceed ${A1_COMMAND_MAX_ATTACHMENT_ITEMS}`,
    );
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "commandPayload.schemaVersion"),
    canonicalCommandPayloadSchemaId: literal(
      row.canonicalCommandPayloadSchemaId,
      A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID,
      "commandPayload.canonicalCommandPayloadSchemaId",
    ),
    caption:
      row.caption === null
        ? null
        : boundedScalarString(
            row.caption,
            "commandPayload.caption",
            A1_COMMAND_MAX_ATTACHMENT_CAPTION_BYTES,
          ),
    itemVectorRef: safeId(row.itemVectorRef, "commandPayload.itemVectorRef"),
    itemCount,
    itemVectorDigest: digest(row.itemVectorDigest, "commandPayload.itemVectorDigest"),
  });
}

function parseUnsupportedPayload(value: unknown): A1UnsupportedRecognizedCommandPayload {
  const row = exactRecord(
    value,
    [
      "schemaVersion",
      "canonicalCommandPayloadSchemaId",
      "normalizedMutationFamily",
      "sourcePayloadSchemaId",
      "sourcePayloadDigest",
      "sourceEventFingerprint",
    ] as const,
    "commandPayload",
  );
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "commandPayload.schemaVersion"),
    canonicalCommandPayloadSchemaId: literal(
      row.canonicalCommandPayloadSchemaId,
      A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
      "commandPayload.canonicalCommandPayloadSchemaId",
    ),
    normalizedMutationFamily: mutationFamily(
      row.normalizedMutationFamily,
      "commandPayload.normalizedMutationFamily",
    ),
    sourcePayloadSchemaId: schemaId(
      row.sourcePayloadSchemaId,
      "commandPayload.sourcePayloadSchemaId",
    ),
    sourcePayloadDigest: digest(row.sourcePayloadDigest, "commandPayload.sourcePayloadDigest"),
    sourceEventFingerprint: digest(
      row.sourceEventFingerprint,
      "commandPayload.sourceEventFingerprint",
    ),
  });
}

export function parseA1CommandPayload(value: unknown): A1CommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject("invalid-record", "commandPayload must be a plain object");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "canonicalCommandPayloadSchemaId");
  } catch {
    return reject("invalid-record", "commandPayload could not be inspected safely");
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return reject(
      "invalid-record",
      "commandPayload.canonicalCommandPayloadSchemaId must be an own data property",
    );
  }
  switch (descriptor.value) {
    case A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID:
      return parseUserTextPayload(value);
    case A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID:
      return parseNewChatPayload(value);
    case A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID:
      return parseAttachmentPayload(value);
    case A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID:
      return parseUnsupportedPayload(value);
    default:
      return reject("invalid-field", "commandPayload has an unsupported schema ID");
  }
}

/** Exact common payload bytes; durable refs are intentionally not signed as locators. */
export function canonicalA1CommandPayload(value: unknown): Uint8Array {
  const payload = parseA1CommandPayload(value);
  const writer = new CanonicalWriter();
  writer.str(payload.canonicalCommandPayloadSchemaId);
  writer.uint(payload.schemaVersion);
  switch (payload.canonicalCommandPayloadSchemaId) {
    case A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID:
      writer.str(payload.text);
      break;
    case A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID:
      writer.str(payload.creationIntent);
      writer.str(payload.projectId);
      writer.str(payload.workspaceSelectorId);
      break;
    case A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID:
      writer.optionalStr(payload.caption);
      writer.uint(payload.itemCount);
      writer.bytes(base64urlDecode(payload.itemVectorDigest));
      break;
    case A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID:
      writer.str(payload.normalizedMutationFamily);
      writer.str(payload.sourcePayloadSchemaId);
      writer.bytes(base64urlDecode(payload.sourcePayloadDigest));
      writer.bytes(base64urlDecode(payload.sourceEventFingerprint));
      break;
  }
  return writer.finish();
}

export async function a1CommandPayloadDigest(value: unknown): Promise<string> {
  return sha256Base64url(canonicalA1CommandPayload(value));
}

function attachmentFileName(value: unknown, field: string): string {
  const parsed = boundedScalarString(value, field, A1_COMMAND_MAX_ATTACHMENT_FILENAME_BYTES);
  if (new TextEncoder().encode(parsed).byteLength === 0) {
    return reject("bad-length", `${field} must contain at least one UTF-8 byte`);
  }
  for (const character of parsed) {
    const codePoint = character.codePointAt(0) as number;
    if (
      character === "/" ||
      character === "\\" ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return reject("invalid-field", `${field} must not contain controls, slash, or backslash`);
    }
  }
  return parsed;
}

function attachmentMediaType(value: unknown, field: string): A1CanonicalAttachmentMediaType {
  if (
    value !== "image/jpeg" &&
    value !== "image/png" &&
    value !== "image/webp" &&
    value !== "image/gif"
  ) {
    return reject("invalid-field", `${field} must be a selected attachment media type`);
  }
  return value;
}

export function parseA1CanonicalAttachmentItemRecord(
  value: unknown,
): A1CanonicalAttachmentItemRecord {
  const row = exactRecord(
    value,
    [
      "schemaVersion",
      "canonicalItemSchemaId",
      "itemIndex",
      "clientFileName",
      "mediaType",
      "contentLength",
      "contentRef",
      "contentDigest",
      "canonicalItemDigest",
    ] as const,
    "attachmentItem",
  );
  const contentLength = safeUint(row.contentLength, "attachmentItem.contentLength");
  if (contentLength > A1_COMMAND_MAX_ATTACHMENT_ITEM_BYTES) {
    return reject(
      "bad-length",
      `attachmentItem.contentLength must not exceed ${A1_COMMAND_MAX_ATTACHMENT_ITEM_BYTES}`,
    );
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "attachmentItem.schemaVersion"),
    canonicalItemSchemaId: literal(
      row.canonicalItemSchemaId,
      A1_ATTACHMENT_ITEM_SCHEMA_ID,
      "attachmentItem.canonicalItemSchemaId",
    ),
    itemIndex: safeUint(row.itemIndex, "attachmentItem.itemIndex"),
    clientFileName: attachmentFileName(row.clientFileName, "attachmentItem.clientFileName"),
    mediaType: attachmentMediaType(row.mediaType, "attachmentItem.mediaType"),
    contentLength,
    contentRef: safeId(row.contentRef, "attachmentItem.contentRef"),
    contentDigest: digest(row.contentDigest, "attachmentItem.contentDigest"),
    canonicalItemDigest: digest(row.canonicalItemDigest, "attachmentItem.canonicalItemDigest"),
  });
}

/** Exact attachment-item bytes. The local content ref and stored digest field are not encoded. */
export function canonicalA1AttachmentItem(value: unknown): Uint8Array {
  const item = parseA1CanonicalAttachmentItemRecord(value);
  const writer = new CanonicalWriter();
  writer.str(item.canonicalItemSchemaId);
  writer.uint(item.schemaVersion);
  writer.uint(item.itemIndex);
  writer.str(item.clientFileName);
  writer.str(item.mediaType);
  writer.uint(item.contentLength);
  writer.bytes(base64urlDecode(item.contentDigest));
  return writer.finish();
}

export async function a1CanonicalAttachmentItemDigest(value: unknown): Promise<string> {
  return sha256Base64url(canonicalA1AttachmentItem(value));
}

export async function assertA1CanonicalAttachmentItemDigest(value: unknown): Promise<void> {
  const item = parseA1CanonicalAttachmentItemRecord(value);
  if ((await a1CanonicalAttachmentItemDigest(item)) !== item.canonicalItemDigest) {
    return reject("digest-mismatch", "attachmentItem.canonicalItemDigest does not recompute");
  }
}

/**
 * Recompute the digest of a bounded, contiguous attachment manifest.
 *
 * This validates retained item references and digests. The persistence layer must additionally
 * resolve each `contentRef` and prove that its bytes match `contentLength` and `contentDigest`.
 */
export async function a1AttachmentItemVectorDigest(value: unknown): Promise<string> {
  const rows = exactArray(value, "attachmentItems", A1_COMMAND_MAX_ATTACHMENT_ITEMS);
  if (rows.length === 0) {
    return reject("bad-length", "attachmentItems must contain at least one item");
  }
  const items: A1CanonicalAttachmentItemRecord[] = [];
  let totalBytes = 0;
  for (let index = 0; index < rows.length; index++) {
    const item = parseA1CanonicalAttachmentItemRecord(rows[index]);
    if (item.itemIndex !== index) {
      return reject(
        "invalid-field",
        "attachmentItems must use contiguous itemIndex order from zero",
      );
    }
    totalBytes += item.contentLength;
    if (totalBytes > A1_COMMAND_MAX_ATTACHMENT_TOTAL_BYTES) {
      return reject(
        "bad-length",
        `attachmentItems must not exceed ${A1_COMMAND_MAX_ATTACHMENT_TOTAL_BYTES} total bytes`,
      );
    }
    await assertA1CanonicalAttachmentItemDigest(item);
    items.push(item);
  }
  const writer = new CanonicalWriter();
  writer.str(A1_ATTACHMENT_ITEM_VECTOR_DOMAIN);
  writer.uint(items.length);
  for (const item of items) writer.bytes(base64urlDecode(item.canonicalItemDigest));
  return sha256Base64url(writer.finish());
}

export async function assertA1AttachmentCommandPayloadManifest(
  payloadValue: unknown,
  itemValues: unknown,
): Promise<void> {
  const payload = parseAttachmentPayload(payloadValue);
  const items = exactArray(itemValues, "attachmentItems", A1_COMMAND_MAX_ATTACHMENT_ITEMS);
  if (items.length !== payload.itemCount) {
    return reject("digest-mismatch", "attachment payload itemCount does not match its manifest");
  }
  if ((await a1AttachmentItemVectorDigest(items)) !== payload.itemVectorDigest) {
    return reject(
      "digest-mismatch",
      "attachment payload itemVectorDigest does not match its manifest",
    );
  }
}

export type A1IngressCommandSource =
  | {
      readonly sourceKind: "a1_ingress";
      readonly identityId: Uint8Array;
      readonly collaborationServerId: string;
      readonly scopeKind: "server_control";
      readonly logicalChatId: null;
      readonly sourceEventNamespaceId: string;
      readonly sourceEventId: string;
    }
  | {
      readonly sourceKind: "a1_ingress";
      readonly identityId: Uint8Array;
      readonly collaborationServerId: string;
      readonly scopeKind: "chat";
      readonly logicalChatId: string;
      readonly sourceEventNamespaceId: string;
      readonly sourceEventId: string;
    };

export interface A1OutsideCommandSource {
  readonly sourceKind: "official_client" | "automation" | "nested_server";
  readonly collaborationServerId: string;
  readonly scopeKind: A1CommandScopeKind;
  readonly logicalChatId: string | null;
  readonly outsideBindingId: string;
  readonly sourceEventNamespaceId: string;
  readonly sourceEventId: string;
  readonly canonicalSourceEventDigest: string;
}

export type A1CommandSource = A1IngressCommandSource | A1OutsideCommandSource;

function sourceKind(value: unknown, field: string): A1CommandSourceKind {
  if (
    value !== "a1_ingress" &&
    value !== "official_client" &&
    value !== "automation" &&
    value !== "nested_server"
  ) {
    return reject("invalid-field", `${field} must be a selected command source kind`);
  }
  return value;
}

function scopeKind(value: unknown, field: string): A1CommandScopeKind {
  if (value !== "server_control" && value !== "chat") {
    return reject("invalid-field", `${field} must be server_control or chat`);
  }
  return value;
}

export function parseA1CommandSource(value: unknown): A1CommandSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject("invalid-record", "commandSource must be a plain object");
  }
  let sourceKindDescriptor: PropertyDescriptor | undefined;
  try {
    sourceKindDescriptor = Object.getOwnPropertyDescriptor(value, "sourceKind");
  } catch {
    return reject("invalid-record", "commandSource could not be inspected safely");
  }
  if (sourceKindDescriptor === undefined || !Object.hasOwn(sourceKindDescriptor, "value")) {
    return reject("invalid-record", "commandSource.sourceKind must be an own data property");
  }
  const selectedKind = sourceKind(sourceKindDescriptor.value, "commandSource.sourceKind");
  if (selectedKind === "a1_ingress") {
    const row = exactRecord(
      value,
      [
        "sourceKind",
        "identityId",
        "collaborationServerId",
        "scopeKind",
        "logicalChatId",
        "sourceEventNamespaceId",
        "sourceEventId",
      ] as const,
      "commandSource",
    );
    const selectedScope = scopeKind(row.scopeKind, "commandSource.scopeKind");
    const logicalChatId =
      row.logicalChatId === null
        ? null
        : canonicalId(row.logicalChatId, "rcl_", RANDOM_ID_BYTES, "commandSource.logicalChatId");
    if (
      (selectedScope === "server_control" && logicalChatId !== null) ||
      (selectedScope === "chat" && logicalChatId === null)
    ) {
      return reject("scope-mismatch", "commandSource logical chat does not match its scope");
    }
    const common = {
      sourceKind: "a1_ingress" as const,
      identityId: snapshotIdentity(row.identityId, "commandSource.identityId"),
      collaborationServerId: canonicalId(
        row.collaborationServerId,
        "rcs_",
        RANDOM_ID_BYTES,
        "commandSource.collaborationServerId",
      ),
      sourceEventNamespaceId: canonicalId(
        row.sourceEventNamespaceId,
        "wns_",
        DIGEST_BYTES,
        "commandSource.sourceEventNamespaceId",
      ),
      sourceEventId: safeId(row.sourceEventId, "commandSource.sourceEventId"),
    };
    return selectedScope === "server_control"
      ? freeze({ ...common, scopeKind: "server_control", logicalChatId: null })
      : freeze({ ...common, scopeKind: "chat", logicalChatId: logicalChatId as string });
  }
  const row = exactRecord(
    value,
    [
      "sourceKind",
      "collaborationServerId",
      "scopeKind",
      "logicalChatId",
      "outsideBindingId",
      "sourceEventNamespaceId",
      "sourceEventId",
      "canonicalSourceEventDigest",
    ] as const,
    "commandSource",
  );
  const selectedScope = scopeKind(row.scopeKind, "commandSource.scopeKind");
  const logicalChatId =
    row.logicalChatId === null
      ? null
      : canonicalId(row.logicalChatId, "rcl_", RANDOM_ID_BYTES, "commandSource.logicalChatId");
  if (
    (selectedScope === "server_control" && logicalChatId !== null) ||
    (selectedScope === "chat" && logicalChatId === null)
  ) {
    return reject("scope-mismatch", "commandSource logical chat does not match its scope");
  }
  return freeze({
    sourceKind: selectedKind,
    collaborationServerId: canonicalId(
      row.collaborationServerId,
      "rcs_",
      RANDOM_ID_BYTES,
      "commandSource.collaborationServerId",
    ),
    scopeKind: selectedScope,
    logicalChatId,
    outsideBindingId: safeId(row.outsideBindingId, "commandSource.outsideBindingId"),
    sourceEventNamespaceId: safeId(
      row.sourceEventNamespaceId,
      "commandSource.sourceEventNamespaceId",
    ),
    sourceEventId: safeId(row.sourceEventId, "commandSource.sourceEventId"),
    canonicalSourceEventDigest: digest(
      row.canonicalSourceEventDigest,
      "commandSource.canonicalSourceEventDigest",
    ),
  });
}

export function canonicalA1CommandSourceIdentity(value: unknown): Uint8Array {
  const source = parseA1CommandSource(value);
  const writer = new CanonicalWriter();
  if (source.sourceKind === "a1_ingress") {
    writer.str(A1_COMMAND_SOURCE_INGRESS_DOMAIN);
    writer.bytes(source.identityId);
    writer.str(source.collaborationServerId);
    writer.str(source.scopeKind);
    writer.optionalStr(source.logicalChatId);
    writer.str(source.sourceEventNamespaceId);
    writer.str(source.sourceEventId);
  } else {
    writer.str(A1_COMMAND_SOURCE_OUTSIDE_DOMAIN);
    writer.str(source.collaborationServerId);
    writer.str(source.scopeKind);
    writer.optionalStr(source.logicalChatId);
    writer.str(source.outsideBindingId);
    writer.str(source.sourceEventNamespaceId);
    writer.str(source.sourceEventId);
    writer.bytes(base64urlDecode(source.canonicalSourceEventDigest));
  }
  return writer.finish();
}

export async function a1SourceCommandIdentityDigest(value: unknown): Promise<string> {
  return sha256Base64url(canonicalA1CommandSourceIdentity(value));
}

export interface A1CollaborationCommandIdInput {
  readonly collaborationServerId: string;
  readonly sourceKind: A1CommandSourceKind;
  readonly sourceCommandIdentityDigest: string;
}

export function canonicalA1CollaborationCommandIdPreimage(value: unknown): Uint8Array {
  const row = exactRecord(
    value,
    ["collaborationServerId", "sourceKind", "sourceCommandIdentityDigest"] as const,
    "commandIdInput",
  );
  const writer = new CanonicalWriter();
  writer.str(A1_COLLABORATION_COMMAND_ID_DOMAIN);
  writer.str(
    canonicalId(
      row.collaborationServerId,
      "rcs_",
      RANDOM_ID_BYTES,
      "commandIdInput.collaborationServerId",
    ),
  );
  writer.str(sourceKind(row.sourceKind, "commandIdInput.sourceKind"));
  writer.bytes(base64urlDecode(digest(row.sourceCommandIdentityDigest, "commandIdInput.digest")));
  return writer.finish();
}

export async function deriveA1CollaborationCommandId(value: unknown): Promise<string> {
  return `rcm_${await sha256Base64url(canonicalA1CollaborationCommandIdPreimage(value))}`;
}

export type A1ExecutorEvidenceSchemaId =
  | typeof A1_NATIVE_SERVER_EXECUTOR_EVIDENCE_SCHEMA_ID
  | typeof A1_NATIVE_BINDING_EXECUTOR_EVIDENCE_SCHEMA_ID
  | typeof A1_NESTED_MANAGEMENT_EXECUTOR_EVIDENCE_SCHEMA_ID
  | typeof A1_NESTED_CHAT_EDGE_EXECUTOR_EVIDENCE_SCHEMA_ID;

export interface A1CommandDecisionEvidence {
  readonly schemaVersion: 1;
  readonly decisionEvidenceSchemaId: typeof A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID;
  readonly commandId: string;
  readonly collaborationServerId: string;
  readonly scopeKind: A1CommandScopeKind;
  readonly projectTargetSelectorMappingId: string | null;
  readonly projectTargetSelectorMappingGeneration: number | null;
  readonly projectTargetDigest: string | null;
  readonly selectedTargetKind: A1AdmittedTargetKind | null;
  readonly selectedExecutorEvidenceSchemaId: A1ExecutorEvidenceSchemaId | null;
  /** Durable resolver ref; deliberately excluded from the canonical bytes. */
  readonly selectedExecutorEvidenceRef: string | null;
  readonly selectedExecutorEvidenceDigest: string | null;
  readonly targetCapabilitySnapshotId: string | null;
  readonly targetCapabilityFamilyDigest: string | null;
  readonly decisionPolicyId: typeof A1_COMMAND_DECISION_POLICY_ID;
}

function admittedTargetKind(value: unknown, field: string): A1AdmittedTargetKind {
  if (
    value !== "native_server" &&
    value !== "native_binding" &&
    value !== "nested_management" &&
    value !== "nested_chat_edge"
  ) {
    return reject("invalid-field", `${field} must be a selected admitted target kind`);
  }
  return value;
}

function executorEvidenceSchemaId(value: unknown, field: string): A1ExecutorEvidenceSchemaId {
  if (
    value !== A1_NATIVE_SERVER_EXECUTOR_EVIDENCE_SCHEMA_ID &&
    value !== A1_NATIVE_BINDING_EXECUTOR_EVIDENCE_SCHEMA_ID &&
    value !== A1_NESTED_MANAGEMENT_EXECUTOR_EVIDENCE_SCHEMA_ID &&
    value !== A1_NESTED_CHAT_EDGE_EXECUTOR_EVIDENCE_SCHEMA_ID
  ) {
    return reject("invalid-field", `${field} must be a selected executor-evidence schema ID`);
  }
  return value;
}

function expectedExecutorSchema(target: A1AdmittedTargetKind): A1ExecutorEvidenceSchemaId {
  switch (target) {
    case "native_server":
      return A1_NATIVE_SERVER_EXECUTOR_EVIDENCE_SCHEMA_ID;
    case "native_binding":
      return A1_NATIVE_BINDING_EXECUTOR_EVIDENCE_SCHEMA_ID;
    case "nested_management":
      return A1_NESTED_MANAGEMENT_EXECUTOR_EVIDENCE_SCHEMA_ID;
    case "nested_chat_edge":
      return A1_NESTED_CHAT_EDGE_EXECUTOR_EVIDENCE_SCHEMA_ID;
  }
}

export function parseA1CommandDecisionEvidence(value: unknown): A1CommandDecisionEvidence {
  const row = exactRecord(
    value,
    [
      "schemaVersion",
      "decisionEvidenceSchemaId",
      "commandId",
      "collaborationServerId",
      "scopeKind",
      "projectTargetSelectorMappingId",
      "projectTargetSelectorMappingGeneration",
      "projectTargetDigest",
      "selectedTargetKind",
      "selectedExecutorEvidenceSchemaId",
      "selectedExecutorEvidenceRef",
      "selectedExecutorEvidenceDigest",
      "targetCapabilitySnapshotId",
      "targetCapabilityFamilyDigest",
      "decisionPolicyId",
    ] as const,
    "decisionEvidence",
  );
  const selectedScope = scopeKind(row.scopeKind, "decisionEvidence.scopeKind");
  const mappingId =
    row.projectTargetSelectorMappingId === null
      ? null
      : safeId(
          row.projectTargetSelectorMappingId,
          "decisionEvidence.projectTargetSelectorMappingId",
        );
  const mappingGeneration =
    row.projectTargetSelectorMappingGeneration === null
      ? null
      : safeUint(
          row.projectTargetSelectorMappingGeneration,
          "decisionEvidence.projectTargetSelectorMappingGeneration",
          1,
        );
  const projectDigest = optionalDigest(
    row.projectTargetDigest,
    "decisionEvidence.projectTargetDigest",
  );
  const mappingPresence = [mappingId, mappingGeneration, projectDigest].filter(
    (part) => part !== null,
  ).length;
  if (mappingPresence !== 0 && mappingPresence !== 3) {
    return reject(
      "scope-mismatch",
      "decisionEvidence project mapping fields must be all null or all set",
    );
  }
  if (selectedScope === "chat" && mappingPresence !== 0) {
    return reject("scope-mismatch", "chat decision evidence cannot carry project mapping fields");
  }

  const target =
    row.selectedTargetKind === null
      ? null
      : admittedTargetKind(row.selectedTargetKind, "decisionEvidence.selectedTargetKind");
  const executorSchema =
    row.selectedExecutorEvidenceSchemaId === null
      ? null
      : executorEvidenceSchemaId(
          row.selectedExecutorEvidenceSchemaId,
          "decisionEvidence.selectedExecutorEvidenceSchemaId",
        );
  const executorRef =
    row.selectedExecutorEvidenceRef === null
      ? null
      : safeId(row.selectedExecutorEvidenceRef, "decisionEvidence.selectedExecutorEvidenceRef");
  const executorDigest = optionalDigest(
    row.selectedExecutorEvidenceDigest,
    "decisionEvidence.selectedExecutorEvidenceDigest",
  );
  const capabilityId =
    row.targetCapabilitySnapshotId === null
      ? null
      : safeId(row.targetCapabilitySnapshotId, "decisionEvidence.targetCapabilitySnapshotId");
  const capabilityDigest = optionalDigest(
    row.targetCapabilityFamilyDigest,
    "decisionEvidence.targetCapabilityFamilyDigest",
  );
  const executorPresence = [
    executorSchema,
    executorRef,
    executorDigest,
    capabilityId,
    capabilityDigest,
  ].filter((part) => part !== null).length;
  if (target === null ? executorPresence !== 0 : executorPresence !== 5) {
    return reject(
      "scope-mismatch",
      "decisionEvidence selected target, executor evidence, and capability must be all null or all set",
    );
  }
  if (target !== null && executorSchema !== expectedExecutorSchema(target)) {
    return reject("scope-mismatch", "decisionEvidence target does not match executor schema");
  }
  if (selectedScope === "server_control" && target !== null && mappingPresence !== 3) {
    return reject(
      "scope-mismatch",
      "admitted server-control decision evidence requires the exact project mapping tuple",
    );
  }
  if (
    target !== null &&
    ((selectedScope === "server_control" &&
      target !== "native_server" &&
      target !== "nested_management") ||
      (selectedScope === "chat" && target !== "native_binding" && target !== "nested_chat_edge"))
  ) {
    return reject("scope-mismatch", "decisionEvidence target does not match command scope");
  }

  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "decisionEvidence.schemaVersion"),
    decisionEvidenceSchemaId: literal(
      row.decisionEvidenceSchemaId,
      A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
      "decisionEvidence.decisionEvidenceSchemaId",
    ),
    commandId: canonicalId(row.commandId, "rcm_", DIGEST_BYTES, "decisionEvidence.commandId"),
    collaborationServerId: canonicalId(
      row.collaborationServerId,
      "rcs_",
      RANDOM_ID_BYTES,
      "decisionEvidence.collaborationServerId",
    ),
    scopeKind: selectedScope,
    projectTargetSelectorMappingId: mappingId,
    projectTargetSelectorMappingGeneration: mappingGeneration,
    projectTargetDigest: projectDigest,
    selectedTargetKind: target,
    selectedExecutorEvidenceSchemaId: executorSchema,
    selectedExecutorEvidenceRef: executorRef,
    selectedExecutorEvidenceDigest: executorDigest,
    targetCapabilitySnapshotId: capabilityId,
    targetCapabilityFamilyDigest: capabilityDigest,
    decisionPolicyId: literal(
      row.decisionPolicyId,
      A1_COMMAND_DECISION_POLICY_ID,
      "decisionEvidence.decisionPolicyId",
    ),
  });
}

export function canonicalA1CommandDecisionEvidence(value: unknown): Uint8Array {
  const evidence = parseA1CommandDecisionEvidence(value);
  const writer = new CanonicalWriter();
  writer.str(evidence.decisionEvidenceSchemaId);
  writer.uint(evidence.schemaVersion);
  writer.str(evidence.commandId);
  writer.str(evidence.collaborationServerId);
  writer.str(evidence.scopeKind);
  writer.optionalStr(evidence.projectTargetSelectorMappingId);
  writer.optionalUint(evidence.projectTargetSelectorMappingGeneration);
  writeOptionalDigest(writer, evidence.projectTargetDigest);
  writer.optionalStr(evidence.selectedTargetKind);
  writer.optionalStr(evidence.selectedExecutorEvidenceSchemaId);
  writeOptionalDigest(writer, evidence.selectedExecutorEvidenceDigest);
  writer.optionalStr(evidence.targetCapabilitySnapshotId);
  writeOptionalDigest(writer, evidence.targetCapabilityFamilyDigest);
  writer.str(evidence.decisionPolicyId);
  return writer.finish();
}

export async function a1CommandDecisionEvidenceDigest(value: unknown): Promise<string> {
  return sha256Base64url(canonicalA1CommandDecisionEvidence(value));
}

export type A1CommandPayloadSchemaId =
  | typeof A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID
  | typeof A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID
  | typeof A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID
  | typeof A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID;

export interface A1CanonicalCommandRecord {
  readonly commandId: string;
  readonly collaborationServerId: string;
  readonly scopeKind: A1CommandScopeKind;
  readonly logicalChatId: string | null;
  readonly targetLogicalChatId: string | null;
  readonly sourceKind: A1CommandSourceKind;
  readonly sourceRef: string;
  readonly sourceEventNamespaceId: string;
  readonly sourceEventId: string;
  readonly sourceCommandIdentityDigest: string;
  readonly canonicalSourceEventDigest: string | null;
  readonly mutationFamily: A1NativeMutationFamily;
  readonly canonicalCommandPayloadSchemaId: A1CommandPayloadSchemaId;
  readonly canonicalCommandPayloadDigest: string;
  readonly preDecisionNormalizationEvidenceSchemaId:
    | typeof A1_OPENCODE_PRE_DECISION_NORMALIZATION_SCHEMA_ID
    | null;
  readonly preDecisionNormalizationEvidenceDigest: string | null;
  readonly readyAtJournalSeq: number;
  readonly commandSeq: number;
  readonly disposition: A1CommandDisposition;
  readonly admittedTargetKind: A1AdmittedTargetKind | null;
  readonly targetCapabilitySnapshotId: string | null;
  readonly targetCapabilityFamilyDigest: string | null;
  readonly decisionEvidenceSchemaId: typeof A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID;
  readonly decisionEvidenceDigest: string;
}

function commandPayloadSchemaId(value: unknown, field: string): A1CommandPayloadSchemaId {
  if (
    value !== A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID &&
    value !== A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID &&
    value !== A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID &&
    value !== A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID
  ) {
    return reject("invalid-field", `${field} must be a selected common command payload schema`);
  }
  return value;
}

function disposition(value: unknown, field: string): A1CommandDisposition {
  if (value !== "admitted" && value !== "queued" && value !== "rejected") {
    return reject("invalid-field", `${field} must be admitted, queued, or rejected`);
  }
  return value;
}

export function parseA1CanonicalCommandRecord(value: unknown): A1CanonicalCommandRecord {
  const row = exactRecord(
    value,
    [
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
      "canonicalCommandPayloadDigest",
      "preDecisionNormalizationEvidenceSchemaId",
      "preDecisionNormalizationEvidenceDigest",
      "readyAtJournalSeq",
      "commandSeq",
      "disposition",
      "admittedTargetKind",
      "targetCapabilitySnapshotId",
      "targetCapabilityFamilyDigest",
      "decisionEvidenceSchemaId",
      "decisionEvidenceDigest",
    ] as const,
    "commandRecord",
  );
  const selectedScope = scopeKind(row.scopeKind, "commandRecord.scopeKind");
  const logicalChatId =
    row.logicalChatId === null
      ? null
      : canonicalId(row.logicalChatId, "rcl_", RANDOM_ID_BYTES, "commandRecord.logicalChatId");
  const targetLogicalChatId =
    row.targetLogicalChatId === null
      ? null
      : canonicalId(
          row.targetLogicalChatId,
          "rcl_",
          RANDOM_ID_BYTES,
          "commandRecord.targetLogicalChatId",
        );
  const selectedSourceKind = sourceKind(row.sourceKind, "commandRecord.sourceKind");
  const selectedMutationFamily = mutationFamily(row.mutationFamily, "commandRecord.mutationFamily");
  const selectedPayloadSchema = commandPayloadSchemaId(
    row.canonicalCommandPayloadSchemaId,
    "commandRecord.canonicalCommandPayloadSchemaId",
  );
  if (
    (selectedPayloadSchema === A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID &&
      selectedMutationFamily !== "user_text") ||
    (selectedPayloadSchema === A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID &&
      selectedMutationFamily !== "new_chat") ||
    (selectedPayloadSchema === A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID &&
      selectedMutationFamily !== "attachment")
  ) {
    return reject(
      "scope-mismatch",
      "commandRecord mutation family does not match its payload schema",
    );
  }

  const selectedDisposition = disposition(row.disposition, "commandRecord.disposition");
  const targetKind =
    row.admittedTargetKind === null
      ? null
      : admittedTargetKind(row.admittedTargetKind, "commandRecord.admittedTargetKind");
  const capabilityId =
    row.targetCapabilitySnapshotId === null
      ? null
      : safeId(row.targetCapabilitySnapshotId, "commandRecord.targetCapabilitySnapshotId");
  const capabilityDigest = optionalDigest(
    row.targetCapabilityFamilyDigest,
    "commandRecord.targetCapabilityFamilyDigest",
  );
  const targetPresence = [targetKind, capabilityId, capabilityDigest].filter(
    (part) => part !== null,
  ).length;
  if (selectedDisposition === "admitted" ? targetPresence !== 3 : targetPresence !== 0) {
    return reject(
      "scope-mismatch",
      "commandRecord admission target and capability must be all set only for admitted commands",
    );
  }

  if (selectedScope === "chat") {
    if (
      logicalChatId === null ||
      targetLogicalChatId !== logicalChatId ||
      selectedMutationFamily === "new_chat" ||
      (targetKind !== null && targetKind !== "native_binding" && targetKind !== "nested_chat_edge")
    ) {
      return reject("scope-mismatch", "commandRecord chat scope is inconsistent");
    }
  } else if (
    logicalChatId !== null ||
    selectedMutationFamily !== "new_chat" ||
    (selectedPayloadSchema !== A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID &&
      selectedPayloadSchema !== A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID) ||
    selectedDisposition === "queued" ||
    (selectedDisposition === "admitted"
      ? targetLogicalChatId === null
      : targetLogicalChatId !== null) ||
    (targetKind !== null && targetKind !== "native_server" && targetKind !== "nested_management")
  ) {
    return reject("scope-mismatch", "commandRecord server-control scope is inconsistent");
  }

  const canonicalSourceEventDigest = optionalDigest(
    row.canonicalSourceEventDigest,
    "commandRecord.canonicalSourceEventDigest",
  );
  if (
    (selectedSourceKind === "a1_ingress" && canonicalSourceEventDigest !== null) ||
    (selectedSourceKind !== "a1_ingress" && canonicalSourceEventDigest === null)
  ) {
    return reject(
      "scope-mismatch",
      "commandRecord canonicalSourceEventDigest must be null exactly for a1_ingress",
    );
  }
  const sourceRef =
    selectedSourceKind === "a1_ingress"
      ? canonicalId(row.sourceRef, "rrs_", DIGEST_BYTES, "commandRecord.sourceRef")
      : safeId(row.sourceRef, "commandRecord.sourceRef");
  const sourceEventNamespaceId =
    selectedSourceKind === "a1_ingress"
      ? canonicalId(
          row.sourceEventNamespaceId,
          "wns_",
          DIGEST_BYTES,
          "commandRecord.sourceEventNamespaceId",
        )
      : safeId(row.sourceEventNamespaceId, "commandRecord.sourceEventNamespaceId");

  const preDecisionSchema =
    row.preDecisionNormalizationEvidenceSchemaId === null
      ? null
      : literal(
          row.preDecisionNormalizationEvidenceSchemaId,
          A1_OPENCODE_PRE_DECISION_NORMALIZATION_SCHEMA_ID,
          "commandRecord.preDecisionNormalizationEvidenceSchemaId",
        );
  const preDecisionDigest = optionalDigest(
    row.preDecisionNormalizationEvidenceDigest,
    "commandRecord.preDecisionNormalizationEvidenceDigest",
  );
  if ((preDecisionSchema === null) !== (preDecisionDigest === null)) {
    return reject(
      "scope-mismatch",
      "commandRecord pre-decision evidence schema and digest must be both null or both set",
    );
  }

  return freeze({
    commandId: canonicalId(row.commandId, "rcm_", DIGEST_BYTES, "commandRecord.commandId"),
    collaborationServerId: canonicalId(
      row.collaborationServerId,
      "rcs_",
      RANDOM_ID_BYTES,
      "commandRecord.collaborationServerId",
    ),
    scopeKind: selectedScope,
    logicalChatId,
    targetLogicalChatId,
    sourceKind: selectedSourceKind,
    sourceRef,
    sourceEventNamespaceId,
    sourceEventId: safeId(row.sourceEventId, "commandRecord.sourceEventId"),
    sourceCommandIdentityDigest: digest(
      row.sourceCommandIdentityDigest,
      "commandRecord.sourceCommandIdentityDigest",
    ),
    canonicalSourceEventDigest,
    mutationFamily: selectedMutationFamily,
    canonicalCommandPayloadSchemaId: selectedPayloadSchema,
    canonicalCommandPayloadDigest: digest(
      row.canonicalCommandPayloadDigest,
      "commandRecord.canonicalCommandPayloadDigest",
    ),
    preDecisionNormalizationEvidenceSchemaId: preDecisionSchema,
    preDecisionNormalizationEvidenceDigest: preDecisionDigest,
    readyAtJournalSeq: safeUint(row.readyAtJournalSeq, "commandRecord.readyAtJournalSeq"),
    commandSeq: safeUint(row.commandSeq, "commandRecord.commandSeq"),
    disposition: selectedDisposition,
    admittedTargetKind: targetKind,
    targetCapabilitySnapshotId: capabilityId,
    targetCapabilityFamilyDigest: capabilityDigest,
    decisionEvidenceSchemaId: literal(
      row.decisionEvidenceSchemaId,
      A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
      "commandRecord.decisionEvidenceSchemaId",
    ),
    decisionEvidenceDigest: digest(
      row.decisionEvidenceDigest,
      "commandRecord.decisionEvidenceDigest",
    ),
  });
}

export function canonicalA1CommandRecord(value: unknown): Uint8Array {
  const command = parseA1CanonicalCommandRecord(value);
  const writer = new CanonicalWriter();
  writer.str(A1_COLLABORATION_COMMAND_RECORD_DOMAIN);
  writer.str(command.commandId);
  writer.str(command.collaborationServerId);
  writer.str(command.scopeKind);
  writer.optionalStr(command.logicalChatId);
  writer.optionalStr(command.targetLogicalChatId);
  writer.str(command.sourceKind);
  writer.str(command.sourceRef);
  writer.str(command.sourceEventNamespaceId);
  writer.str(command.sourceEventId);
  writer.bytes(base64urlDecode(command.sourceCommandIdentityDigest));
  writeOptionalDigest(writer, command.canonicalSourceEventDigest);
  writer.str(command.mutationFamily);
  writer.str(command.canonicalCommandPayloadSchemaId);
  writer.bytes(base64urlDecode(command.canonicalCommandPayloadDigest));
  writer.optionalStr(command.preDecisionNormalizationEvidenceSchemaId);
  writeOptionalDigest(writer, command.preDecisionNormalizationEvidenceDigest);
  writer.uint(command.readyAtJournalSeq);
  writer.uint(command.commandSeq);
  writer.str(command.disposition);
  writer.optionalStr(command.admittedTargetKind);
  writer.optionalStr(command.targetCapabilitySnapshotId);
  writeOptionalDigest(writer, command.targetCapabilityFamilyDigest);
  writer.str(command.decisionEvidenceSchemaId);
  writer.bytes(base64urlDecode(command.decisionEvidenceDigest));
  return writer.finish();
}

export async function a1CanonicalCommandRecordDigest(value: unknown): Promise<string> {
  return sha256Base64url(canonicalA1CommandRecord(value));
}

/** Resolve and verify the ref-bearing common payload before ordering or semantic reopen. */
export async function assertA1CommandPayloadBinding(
  commandValue: unknown,
  payloadValue: unknown,
): Promise<void> {
  const command = parseA1CanonicalCommandRecord(commandValue);
  const payload = parseA1CommandPayload(payloadValue);
  if (payload.canonicalCommandPayloadSchemaId !== command.canonicalCommandPayloadSchemaId) {
    return reject(
      "scope-mismatch",
      "commandRecord payload schema does not match its resolved payload",
    );
  }
  if ((await a1CommandPayloadDigest(payload)) !== command.canonicalCommandPayloadDigest) {
    return reject(
      "digest-mismatch",
      "commandRecord payload digest does not match its resolved payload",
    );
  }
  const payloadMutationFamily: A1NativeMutationFamily =
    payload.canonicalCommandPayloadSchemaId === A1_USER_TEXT_COMMAND_PAYLOAD_SCHEMA_ID
      ? "user_text"
      : payload.canonicalCommandPayloadSchemaId === A1_NEW_CHAT_COMMAND_PAYLOAD_SCHEMA_ID
        ? "new_chat"
        : payload.canonicalCommandPayloadSchemaId === A1_ATTACHMENT_COMMAND_PAYLOAD_SCHEMA_ID
          ? "attachment"
          : payload.normalizedMutationFamily;
  if (payloadMutationFamily !== command.mutationFamily) {
    return reject(
      "scope-mismatch",
      "commandRecord mutation family does not match its resolved payload",
    );
  }
}

export async function assertA1CanonicalCommandId(value: unknown): Promise<void> {
  const command = parseA1CanonicalCommandRecord(value);
  const expected = await deriveA1CollaborationCommandId({
    collaborationServerId: command.collaborationServerId,
    sourceKind: command.sourceKind,
    sourceCommandIdentityDigest: command.sourceCommandIdentityDigest,
  });
  if (expected !== command.commandId) {
    return reject("digest-mismatch", "commandRecord.commandId does not recompute");
  }
}

export interface A1CommandResultIdentityInput {
  readonly collaborationServerId: string;
  readonly commandId: string;
}

export function canonicalA1CommandResultIdPreimage(value: unknown): Uint8Array {
  const row = exactRecord(
    value,
    ["collaborationServerId", "commandId"] as const,
    "commandResultIdInput",
  );
  const writer = new CanonicalWriter();
  writer.str(A1_COMMAND_RESULT_ID_DOMAIN);
  writer.str(
    canonicalId(
      row.collaborationServerId,
      "rcs_",
      RANDOM_ID_BYTES,
      "commandResultIdInput.collaborationServerId",
    ),
  );
  writer.str(canonicalId(row.commandId, "rcm_", DIGEST_BYTES, "commandResultIdInput.commandId"));
  writer.uint(1);
  return writer.finish();
}

export async function deriveA1CommandResultId(value: unknown): Promise<string> {
  return `ccr_${await sha256Base64url(canonicalA1CommandResultIdPreimage(value))}`;
}

export interface A1CommandSigningGroupIdentityInput extends A1CommandResultIdentityInput {
  readonly commandResultId: string;
  readonly preparationGeneration: number;
}

function parseSigningGroupIdentity(value: unknown): A1CommandSigningGroupIdentityInput {
  const row = exactRecord(
    value,
    ["collaborationServerId", "commandId", "commandResultId", "preparationGeneration"] as const,
    "signingGroupIdInput",
  );
  return freeze({
    collaborationServerId: canonicalId(
      row.collaborationServerId,
      "rcs_",
      RANDOM_ID_BYTES,
      "signingGroupIdInput.collaborationServerId",
    ),
    commandId: canonicalId(row.commandId, "rcm_", DIGEST_BYTES, "signingGroupIdInput.commandId"),
    commandResultId: canonicalId(
      row.commandResultId,
      "ccr_",
      DIGEST_BYTES,
      "signingGroupIdInput.commandResultId",
    ),
    preparationGeneration: safeUint(
      row.preparationGeneration,
      "signingGroupIdInput.preparationGeneration",
      1,
    ),
  });
}

export function canonicalA1CommandSigningGroupIdPreimage(value: unknown): Uint8Array {
  const input = parseSigningGroupIdentity(value);
  const writer = new CanonicalWriter();
  writer.str(A1_COMMAND_SIGNING_GROUP_ID_DOMAIN);
  writer.str(input.collaborationServerId);
  writer.str(input.commandId);
  writer.str(input.commandResultId);
  writer.uint(input.preparationGeneration);
  return writer.finish();
}

export async function deriveA1CommandSigningGroupId(value: unknown): Promise<string> {
  return `csg_${await sha256Base64url(canonicalA1CommandSigningGroupIdPreimage(value))}`;
}

export function canonicalA1CommandResultPreparationIdPreimage(value: unknown): Uint8Array {
  const input = parseSigningGroupIdentity(value);
  const writer = new CanonicalWriter();
  writer.str(A1_COMMAND_RESULT_PREPARATION_ID_DOMAIN);
  writer.str(input.collaborationServerId);
  writer.str(input.commandId);
  writer.str(input.commandResultId);
  writer.uint(1);
  writer.uint(input.preparationGeneration);
  return writer.finish();
}

export async function deriveA1CommandResultPreparationId(value: unknown): Promise<string> {
  return `crp_${await sha256Base64url(canonicalA1CommandResultPreparationIdPreimage(value))}`;
}

export interface A1CanonicalCommandResultPayload {
  readonly canonicalPayloadSchemaId: typeof A1_COMMAND_RESULT_SCHEMA_ID;
  readonly commandResultId: string;
  readonly collaborationServerId: string;
  readonly commandId: string;
  readonly canonicalCommandRecordDigest: string;
  readonly resultVersion: 1;
  readonly supersedesCommandResultId: null;
  readonly sourceKind: A1CommandSourceKind;
  readonly sourceRef: string;
  readonly scopeKind: A1CommandScopeKind;
  readonly logicalChatId: string | null;
  readonly targetLogicalChatId: string | null;
  readonly commandSeq: number;
  readonly disposition: A1CommandDisposition;
  readonly createdAtMs: number;
  readonly signerSequence: number;
  readonly serverKeyGeneration: number;
  readonly signerIdentityKeyId: string;
  readonly signerScopeCertificateId: string;
  readonly signatureAlgorithm: "Ed25519";
}

export function parseA1CanonicalCommandResultPayload(
  value: unknown,
): A1CanonicalCommandResultPayload {
  const row = exactRecord(
    value,
    [
      "canonicalPayloadSchemaId",
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
      "createdAtMs",
      "signerSequence",
      "serverKeyGeneration",
      "signerIdentityKeyId",
      "signerScopeCertificateId",
      "signatureAlgorithm",
    ] as const,
    "commandResultPayload",
  );
  const selectedSourceKind = sourceKind(row.sourceKind, "commandResultPayload.sourceKind");
  const selectedScope = scopeKind(row.scopeKind, "commandResultPayload.scopeKind");
  const logicalChatId =
    row.logicalChatId === null
      ? null
      : canonicalId(
          row.logicalChatId,
          "rcl_",
          RANDOM_ID_BYTES,
          "commandResultPayload.logicalChatId",
        );
  const targetLogicalChatId =
    row.targetLogicalChatId === null
      ? null
      : canonicalId(
          row.targetLogicalChatId,
          "rcl_",
          RANDOM_ID_BYTES,
          "commandResultPayload.targetLogicalChatId",
        );
  const selectedDisposition = disposition(row.disposition, "commandResultPayload.disposition");
  if (row.supersedesCommandResultId !== null) {
    return reject(
      "invalid-field",
      "commandResultPayload.supersedesCommandResultId must be null for result version one",
    );
  }
  if (selectedScope === "chat") {
    if (logicalChatId === null || targetLogicalChatId !== logicalChatId) {
      return reject("scope-mismatch", "commandResultPayload chat scope is inconsistent");
    }
  } else if (
    logicalChatId !== null ||
    selectedDisposition === "queued" ||
    (selectedDisposition === "admitted"
      ? targetLogicalChatId === null
      : targetLogicalChatId !== null)
  ) {
    return reject("scope-mismatch", "commandResultPayload server-control scope is inconsistent");
  }
  return freeze({
    canonicalPayloadSchemaId: literal(
      row.canonicalPayloadSchemaId,
      A1_COMMAND_RESULT_SCHEMA_ID,
      "commandResultPayload.canonicalPayloadSchemaId",
    ),
    commandResultId: canonicalId(
      row.commandResultId,
      "ccr_",
      DIGEST_BYTES,
      "commandResultPayload.commandResultId",
    ),
    collaborationServerId: canonicalId(
      row.collaborationServerId,
      "rcs_",
      RANDOM_ID_BYTES,
      "commandResultPayload.collaborationServerId",
    ),
    commandId: canonicalId(row.commandId, "rcm_", DIGEST_BYTES, "commandResultPayload.commandId"),
    canonicalCommandRecordDigest: digest(
      row.canonicalCommandRecordDigest,
      "commandResultPayload.canonicalCommandRecordDigest",
    ),
    resultVersion: literal(row.resultVersion, 1, "commandResultPayload.resultVersion"),
    supersedesCommandResultId: null,
    sourceKind: selectedSourceKind,
    sourceRef:
      selectedSourceKind === "a1_ingress"
        ? canonicalId(row.sourceRef, "rrs_", DIGEST_BYTES, "commandResultPayload.sourceRef")
        : safeId(row.sourceRef, "commandResultPayload.sourceRef"),
    scopeKind: selectedScope,
    logicalChatId,
    targetLogicalChatId,
    commandSeq: safeUint(row.commandSeq, "commandResultPayload.commandSeq"),
    disposition: selectedDisposition,
    createdAtMs: safeUint(row.createdAtMs, "commandResultPayload.createdAtMs"),
    signerSequence: safeUint(row.signerSequence, "commandResultPayload.signerSequence"),
    serverKeyGeneration: safeUint(
      row.serverKeyGeneration,
      "commandResultPayload.serverKeyGeneration",
      1,
    ),
    signerIdentityKeyId: safeId(
      row.signerIdentityKeyId,
      "commandResultPayload.signerIdentityKeyId",
    ),
    signerScopeCertificateId: safeId(
      row.signerScopeCertificateId,
      "commandResultPayload.signerScopeCertificateId",
    ),
    signatureAlgorithm: literal(
      row.signatureAlgorithm,
      "Ed25519",
      "commandResultPayload.signatureAlgorithm",
    ),
  });
}

export function canonicalA1CommandResultPayload(value: unknown): Uint8Array {
  const result = parseA1CanonicalCommandResultPayload(value);
  const writer = new CanonicalWriter();
  writer.str(result.canonicalPayloadSchemaId);
  writer.str(result.commandResultId);
  writer.str(result.collaborationServerId);
  writer.str(result.commandId);
  writer.bytes(base64urlDecode(result.canonicalCommandRecordDigest));
  writer.uint(result.resultVersion);
  writer.optionalStr(result.supersedesCommandResultId);
  writer.str(result.sourceKind);
  writer.str(result.sourceRef);
  writer.str(result.scopeKind);
  writer.optionalStr(result.logicalChatId);
  writer.optionalStr(result.targetLogicalChatId);
  writer.uint(result.commandSeq);
  writer.str(result.disposition);
  writer.uint(result.createdAtMs);
  writer.uint(result.signerSequence);
  writer.uint(result.serverKeyGeneration);
  writer.str(result.signerIdentityKeyId);
  writer.str(result.signerScopeCertificateId);
  writer.str(result.signatureAlgorithm);
  return writer.finish();
}

export async function a1CanonicalCommandResultPayloadDigest(value: unknown): Promise<string> {
  return sha256Base64url(canonicalA1CommandResultPayload(value));
}

export async function assertA1CommandResultId(value: unknown): Promise<void> {
  const result = parseA1CanonicalCommandResultPayload(value);
  const expected = await deriveA1CommandResultId({
    collaborationServerId: result.collaborationServerId,
    commandId: result.commandId,
  });
  if (expected !== result.commandResultId) {
    return reject("digest-mismatch", "commandResultPayload.commandResultId does not recompute");
  }
}

export interface A1SignedCommandResultInput {
  readonly canonicalPayloadDigest: string;
  readonly signerIdentityKeyId: string;
  readonly serverKeyGeneration: number;
  readonly signerSequence: number;
  readonly signature: string;
}

export function parseA1SignedCommandResultInput(value: unknown): A1SignedCommandResultInput {
  const row = exactRecord(
    value,
    [
      "canonicalPayloadDigest",
      "signerIdentityKeyId",
      "serverKeyGeneration",
      "signerSequence",
      "signature",
    ] as const,
    "signedCommandResult",
  );
  return freeze({
    canonicalPayloadDigest: digest(
      row.canonicalPayloadDigest,
      "signedCommandResult.canonicalPayloadDigest",
    ),
    signerIdentityKeyId: safeId(row.signerIdentityKeyId, "signedCommandResult.signerIdentityKeyId"),
    serverKeyGeneration: safeUint(
      row.serverKeyGeneration,
      "signedCommandResult.serverKeyGeneration",
      1,
    ),
    signerSequence: safeUint(row.signerSequence, "signedCommandResult.signerSequence"),
    signature: signature(row.signature, "signedCommandResult.signature"),
  });
}

export function canonicalA1SignedCommandResult(value: unknown): Uint8Array {
  const signed = parseA1SignedCommandResultInput(value);
  const writer = new CanonicalWriter();
  writer.str(A1_SIGNED_COMMAND_RESULT_DOMAIN);
  writer.bytes(base64urlDecode(signed.canonicalPayloadDigest));
  writer.str(signed.signerIdentityKeyId);
  writer.uint(signed.serverKeyGeneration);
  writer.uint(signed.signerSequence);
  writer.bytes(base64urlDecode(signed.signature));
  return writer.finish();
}

export async function a1SignedCommandResultDigest(value: unknown): Promise<string> {
  return sha256Base64url(canonicalA1SignedCommandResult(value));
}
