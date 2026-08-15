// Browser-safe selected-A1 durable-ingress byte contracts.
//
// This module deliberately owns no database, scheduler, actor, signing, or dispatch behavior. It
// freezes the route-scoped identities, physical-position ordering, bounded plaintext contract, and
// the two source payload schemas recognized by the first A1.7 slice.

import {
  A1_BROKER_GENERATION_FRAME_CAP,
  A1_BROKER_MAX_PARTS,
  type BrokerChannelCursorV1,
  parseBrokerChannelCursorV1,
} from "./a1-broker.js";
import {
  type A1BrokerRoute,
  type A1FrameHeaderV2,
  a1AttemptHeaderDigest,
  a1AuthenticatedPartDigest,
  a1CanonicalMessageDigest,
  canonicalA1BrokerRouteIdPreimage,
  canonicalA1StableLogicalHeader,
} from "./a1-wire.js";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { sha256 } from "./bytes.js";
import { CanonicalWriter, canonicalByteSnapshot } from "./canonical.js";

export const A1_INGRESS_USER_PAYLOAD_SCHEMA_ID = "remote-claw/a1-ingress-user/v1" as const;
export const A1_INGRESS_NEW_CHAT_PAYLOAD_SCHEMA_ID = "remote-claw/a1-ingress-new-chat/v1" as const;

export const A1_INGRESS_MAX_PARTS = A1_BROKER_MAX_PARTS;
export const A1_INGRESS_MAX_CANDIDATES_PER_RESULT = 4;
export const A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES = 48 * 1024 * 1024;
export const A1_INGRESS_MAX_OPENED_PART_BYTES = 3_299_983;
export const A1_INGRESS_ASSEMBLY_DEADLINE_MS = 300_000;
export const A1_INGRESS_LOOKAHEAD_MAX_FRAMES = 1_024;
export const A1_INGRESS_LOOKAHEAD_MAX_BYTES = 64 * 1024 * 1024;
export const A1_INGRESS_MAX_UNRESOLVED_RESULTS_PER_ROUTE = 256;
export const A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_ROUTE = 512 * 1024 * 1024;
export const A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_PER_IDENTITY = 2 * 1024 * 1024 * 1024;
export const A1_INGRESS_MAX_RETAINED_PLAINTEXT_BYTES_GLOBAL = 4 * 1024 * 1024 * 1024;
export const A1_INGRESS_SCHEDULER_CONCURRENCY = 8;

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const MAX_SAFE_ID_BYTES = 128;
const DIGEST_BYTES = 32;

export type A1IngressContractErrorReason =
  | "invalid-record"
  | "invalid-field"
  | "bad-length"
  | "non-canonical"
  | "route-mismatch"
  | "unsupported-record-kind"
  | "counter-exhausted";

export class A1IngressContractError extends Error {
  readonly reason: A1IngressContractErrorReason;

  constructor(reason: A1IngressContractErrorReason, message: string) {
    super(`A1 ingress contract rejected: ${message}`);
    this.name = "A1IngressContractError";
    this.reason = reason;
  }

  static is(error: unknown): error is A1IngressContractError {
    return error instanceof A1IngressContractError;
  }
}

function reject(reason: A1IngressContractErrorReason, message: string): never {
  throw new A1IngressContractError(reason, message);
}

export type A1IngressRoute =
  | {
      readonly routeKind: "server_control";
      readonly identityId: Uint8Array;
      readonly collaborationServerId: string;
      readonly logicalChatId: null;
    }
  | {
      readonly routeKind: "chat";
      readonly identityId: Uint8Array;
      readonly collaborationServerId: string;
      readonly logicalChatId: string;
    };

function snapshotIngressRoute(route: A1IngressRoute): A1IngressRoute {
  if (typeof route !== "object" || route === null) {
    return reject("invalid-record", "route must be an object");
  }
  let identityId: Uint8Array;
  try {
    identityId = canonicalByteSnapshot(route.identityId);
  } catch {
    return reject("invalid-field", "route.identityId must be a Uint8Array");
  }
  const candidate = {
    routeKind: route.routeKind,
    identityId,
    collaborationServerId: route.collaborationServerId,
    logicalChatId: route.logicalChatId,
  } as A1BrokerRoute;
  try {
    // Reuse the selected wire contract for the exact identity/server/chat validation rules.
    canonicalA1BrokerRouteIdPreimage(candidate);
  } catch (error) {
    return reject(
      "invalid-field",
      error instanceof Error ? error.message : "route does not match the A1 wire contract",
    );
  }
  if (candidate.routeKind !== "server_control" && candidate.routeKind !== "chat") {
    return reject("invalid-field", "ingress route must be server_control or chat");
  }
  if (candidate.routeKind === "server_control") {
    return Object.freeze({
      routeKind: "server_control",
      identityId,
      collaborationServerId: candidate.collaborationServerId,
      logicalChatId: null,
    });
  }
  if (candidate.logicalChatId === null) {
    return reject("invalid-field", "chat ingress route requires logicalChatId");
  }
  return Object.freeze({
    routeKind: "chat",
    identityId,
    collaborationServerId: candidate.collaborationServerId,
    logicalChatId: candidate.logicalChatId,
  });
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

function canonicalId(
  value: unknown,
  prefix: "rcr_" | "wns_" | "rrs_" | "rcp_" | "rio_",
  field: string,
): string {
  const parsed = safeId(value, field);
  if (!parsed.startsWith(prefix)) {
    return reject("invalid-field", `${field} must use the ${prefix} namespace`);
  }
  canonicalBase64url(parsed.slice(prefix.length), DIGEST_BYTES, field);
  return parsed;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string") return reject("invalid-field", `${field} must be a string`);
  return canonicalBase64url(value, DIGEST_BYTES, field);
}

async function prefixedDigest(prefix: "wns_" | "rrs_" | "rcp_" | "rio_", bytes: Uint8Array) {
  return `${prefix}${base64urlEncode(await sha256(bytes))}`;
}

/** Exact preimage for the immutable shared-web source namespace of one ingress route. */
export function canonicalA1WebSourceNamespacePreimage(route: A1IngressRoute): Uint8Array {
  const selected = snapshotIngressRoute(route);
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/web-source-namespace/v1");
  writer.bytes(selected.identityId);
  writer.str(selected.collaborationServerId);
  writer.str(selected.routeKind);
  writer.optionalStr(selected.logicalChatId);
  return writer.finish();
}

/** Route-lifetime namespace; it does not change across reconnect or broker generation rollover. */
export async function deriveA1WebSourceNamespaceId(route: A1IngressRoute): Promise<string> {
  return prefixedDigest("wns_", canonicalA1WebSourceNamespacePreimage(route));
}

/** Fail closed when a stored/caller-supplied namespace was derived for another route. */
export async function assertA1WebSourceNamespaceId(
  route: A1IngressRoute,
  sourceEventNamespaceId: string,
): Promise<void> {
  canonicalId(sourceEventNamespaceId, "wns_", "sourceEventNamespaceId");
  if ((await deriveA1WebSourceNamespaceId(route)) !== sourceEventNamespaceId) {
    reject("route-mismatch", "sourceEventNamespaceId was derived for another ingress route");
  }
}

/** Exact stable semantic-result preimage. Callers must bind the namespace to the same route. */
export function canonicalA1StableSemanticResultPreimage(
  route: A1IngressRoute,
  sourceEventNamespaceId: string,
  msgId: string,
): Uint8Array {
  const selected = snapshotIngressRoute(route);
  const namespace = canonicalId(sourceEventNamespaceId, "wns_", "sourceEventNamespaceId");
  const message = safeId(msgId, "msgId");
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/semantic-result/v1");
  writer.bytes(selected.identityId);
  writer.str(selected.collaborationServerId);
  writer.str(selected.routeKind);
  writer.optionalStr(selected.logicalChatId);
  writer.str(namespace);
  writer.str(message);
  return writer.finish();
}

/** Stable `rrs_*` used by the ingress row, result-frame msg_id, and result payload. */
export async function deriveA1StableSemanticResultId(
  route: A1IngressRoute,
  sourceEventNamespaceId: string,
  msgId: string,
): Promise<string> {
  const selected = snapshotIngressRoute(route);
  await assertA1WebSourceNamespaceId(selected, sourceEventNamespaceId);
  return prefixedDigest(
    "rrs_",
    canonicalA1StableSemanticResultPreimage(selected, sourceEventNamespaceId, msgId),
  );
}

/** Exact preimage for one broker-authenticated physical frame position. */
export function canonicalA1ChannelPositionObservationPreimage(
  brokerRouteId: string,
  cursor: BrokerChannelCursorV1,
): Uint8Array {
  const route = canonicalId(brokerRouteId, "rcr_", "brokerRouteId");
  const position = parseBrokerChannelCursorV1(cursor);
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/channel-position/v1");
  writer.str(route);
  writer.uint(position.channelGeneration);
  writer.uint(position.frameIndex);
  return writer.finish();
}

export async function deriveA1ChannelPositionObservationId(
  brokerRouteId: string,
  cursor: BrokerChannelCursorV1,
): Promise<string> {
  return prefixedDigest(
    "rcp_",
    canonicalA1ChannelPositionObservationPreimage(brokerRouteId, cursor),
  );
}

/** Exact preimage for the semantic-ingress observation attached to one authenticated position. */
export function canonicalA1IngressObservationPreimage(
  channelPositionObservationId: string,
): Uint8Array {
  const position = canonicalId(
    channelPositionObservationId,
    "rcp_",
    "channelPositionObservationId",
  );
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/ingress-observation/v1");
  writer.str(position);
  return writer.finish();
}

export async function deriveA1IngressObservationId(
  channelPositionObservationId: string,
): Promise<string> {
  return prefixedDigest(
    "rio_",
    canonicalA1IngressObservationPreimage(channelPositionObservationId),
  );
}

/** Lexicographic route-local order by `(channelGeneration, frameIndex)`. */
export function compareA1BrokerChannelCursors(
  left: BrokerChannelCursorV1,
  right: BrokerChannelCursorV1,
): -1 | 0 | 1 {
  const a = parseBrokerChannelCursorV1(left);
  const b = parseBrokerChannelCursorV1(right);
  if (a.channelGeneration !== b.channelGeneration) {
    return a.channelGeneration < b.channelGeneration ? -1 : 1;
  }
  if (a.frameIndex === b.frameIndex) return 0;
  return a.frameIndex < b.frameIndex ? -1 : 1;
}

function sealedFrameCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > A1_BROKER_GENERATION_FRAME_CAP) {
    return reject(
      "invalid-field",
      `sealedFrameCount must be an integer from 1 through ${A1_BROKER_GENERATION_FRAME_CAP}`,
    );
  }
  return value;
}

/**
 * Immediate cursor successor under a proved sealed generation manifest.
 *
 * Empty generations are traversed from their manifests/read positions; they are not invented from a
 * physical frame cursor. An open generation likewise supplies no successor beyond its observed tail.
 */
export function successorA1BrokerChannelCursor(
  cursor: BrokerChannelCursorV1,
  currentSealedFrameCount: number,
): BrokerChannelCursorV1 {
  const current = parseBrokerChannelCursorV1(cursor);
  const count = sealedFrameCount(currentSealedFrameCount);
  if (current.frameIndex >= count) {
    return reject("invalid-field", "cursor is outside the proved sealed generation frameCount");
  }
  if (current.frameIndex + 1 < count) {
    return Object.freeze({
      version: 1,
      channelGeneration: current.channelGeneration,
      frameIndex: current.frameIndex + 1,
    });
  }
  if (current.channelGeneration === Number.MAX_SAFE_INTEGER) {
    return reject("counter-exhausted", "channel generation has no safe-integer successor");
  }
  return Object.freeze({
    version: 1,
    channelGeneration: current.channelGeneration + 1,
    frameIndex: 0,
  });
}

export function isA1BrokerChannelCursorSuccessor(
  previous: BrokerChannelCursorV1,
  candidate: BrokerChannelCursorV1,
  previousSealedFrameCount: number,
): boolean {
  const expected = successorA1BrokerChannelCursor(previous, previousSealedFrameCount);
  return compareA1BrokerChannelCursors(expected, candidate) === 0;
}

function assertInboundSemanticHeader(header: A1FrameHeaderV2): A1FrameHeaderV2 {
  // The wire helper validates and snapshots every stable field. The returned bytes are deliberately
  // discarded here; the wrapped digest helpers call it again with the same synchronous input.
  let canonicalHeader: Uint8Array | undefined;
  try {
    canonicalHeader = canonicalA1StableLogicalHeader(header);
  } catch (error) {
    return reject(
      "invalid-field",
      error instanceof Error ? error.message : "header does not match the A1 wire contract",
    );
  } finally {
    canonicalHeader?.fill(0);
  }
  if (header.dir !== "in") return reject("invalid-field", "ingress header must be inbound");
  if (header.parts > A1_INGRESS_MAX_PARTS) {
    return reject("bad-length", `ingress header parts must not exceed ${A1_INGRESS_MAX_PARTS}`);
  }
  if (header.recordKind === "session_announce" || header.recordKind === "chat_creation_result") {
    return reject("invalid-field", "outbound-only record kind cannot enter semantic ingress");
  }
  return header;
}

/** Canonical stable logical header bytes, with A1.7 ingress direction/part bounds applied. */
export function canonicalA1IngressStableLogicalHeader(header: A1FrameHeaderV2): Uint8Array {
  return canonicalA1StableLogicalHeader(assertInboundSemanticHeader(header));
}

/** Digest of the stable attempt header, excluding delivery-attempt encryption randomness. */
export async function a1IngressStableLogicalHeaderDigest(header: A1FrameHeaderV2): Promise<string> {
  return a1AttemptHeaderDigest(assertInboundSemanticHeader(header));
}

/** Digest of one authenticated plaintext part after AEAD open. */
export async function a1IngressAuthenticatedPartDigest(
  header: A1FrameHeaderV2,
  openedPart: Uint8Array,
): Promise<string> {
  const selected = assertInboundSemanticHeader(header);
  let plaintext: Uint8Array;
  try {
    plaintext = canonicalByteSnapshot(openedPart);
  } catch {
    return reject("invalid-field", "openedPart must be a Uint8Array");
  }
  try {
    if (plaintext.byteLength > A1_INGRESS_MAX_OPENED_PART_BYTES) {
      return reject(
        "bad-length",
        `openedPart must not exceed ${A1_INGRESS_MAX_OPENED_PART_BYTES} bytes`,
      );
    }
    return await a1AuthenticatedPartDigest(selected, plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/** Digest of the complete, ordered, reassembled source plaintext. */
export async function a1IngressCanonicalMessageDigest(
  header: A1FrameHeaderV2,
  reassembledPlaintext: Uint8Array,
): Promise<string> {
  const selected = assertInboundSemanticHeader(header);
  let plaintext: Uint8Array;
  try {
    plaintext = canonicalByteSnapshot(reassembledPlaintext);
  } catch {
    return reject("invalid-field", "reassembledPlaintext must be a Uint8Array");
  }
  try {
    if (plaintext.byteLength > A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES) {
      return reject(
        "bad-length",
        `reassembledPlaintext must not exceed ${A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES} bytes`,
      );
    }
    return await a1CanonicalMessageDigest(selected, plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/** Exact A1 source-event fingerprint preimage retained with a complete semantic result. */
export function canonicalA1IngressSourceEventFingerprintPreimage(
  brokerRouteId: string,
  sourceEventNamespaceId: string,
  msgId: string,
  canonicalMessageDigest: string,
): Uint8Array {
  const route = canonicalId(brokerRouteId, "rcr_", "brokerRouteId");
  const namespace = canonicalId(sourceEventNamespaceId, "wns_", "sourceEventNamespaceId");
  const message = safeId(msgId, "msgId");
  const messageDigest = digest(canonicalMessageDigest, "canonicalMessageDigest");
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/source-event-fingerprint/v1");
  writer.str(route);
  writer.str(namespace);
  writer.str(message);
  writer.bytes(base64urlDecode(messageDigest));
  return writer.finish();
}

export async function a1IngressSourceEventFingerprint(
  brokerRouteId: string,
  sourceEventNamespaceId: string,
  msgId: string,
  canonicalMessageDigest: string,
): Promise<string> {
  return base64urlEncode(
    await sha256(
      canonicalA1IngressSourceEventFingerprintPreimage(
        brokerRouteId,
        sourceEventNamespaceId,
        msgId,
        canonicalMessageDigest,
      ),
    ),
  );
}

export interface A1IngressUserPayloadV1 {
  readonly v: 1;
  readonly text: string;
}

export interface A1IngressNewChatPayloadV1 {
  readonly v: 1;
  readonly intent: "first_bootstrap" | "new_chat";
  readonly projectId: string;
  readonly workspaceSelectorId: string;
}

export type A1SelectedInboundPayload =
  | {
      readonly recordKind: "user";
      readonly sourcePayloadSchemaId: typeof A1_INGRESS_USER_PAYLOAD_SCHEMA_ID;
      readonly canonicalBytes: Uint8Array;
      readonly payload: A1IngressUserPayloadV1;
    }
  | {
      readonly recordKind: "new_chat";
      readonly sourcePayloadSchemaId: typeof A1_INGRESS_NEW_CHAT_PAYLOAD_SCHEMA_ID;
      readonly canonicalBytes: Uint8Array;
      readonly payload: A1IngressNewChatPayloadV1;
    };

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

function parseUserValue(value: unknown): A1IngressUserPayloadV1 {
  const row = exactRecord(value, ["v", "text"] as const, "userPayload");
  if (row.v !== 1) return reject("invalid-field", "userPayload.v must be exactly 1");
  return Object.freeze({ v: 1, text: unicodeScalarString(row.text, "userPayload.text") });
}

function parseNewChatValue(value: unknown): A1IngressNewChatPayloadV1 {
  const row = exactRecord(
    value,
    ["v", "intent", "project_id", "workspace_selector_id"] as const,
    "newChatPayload",
  );
  if (row.v !== 1) return reject("invalid-field", "newChatPayload.v must be exactly 1");
  if (row.intent !== "first_bootstrap" && row.intent !== "new_chat") {
    return reject("invalid-field", "newChatPayload.intent must be first_bootstrap or new_chat");
  }
  return Object.freeze({
    v: 1,
    intent: row.intent,
    projectId: safeId(row.project_id, "newChatPayload.project_id"),
    workspaceSelectorId: safeId(row.workspace_selector_id, "newChatPayload.workspace_selector_id"),
  });
}

function parseNewChatCanonicalValue(value: unknown): A1IngressNewChatPayloadV1 {
  const row = exactRecord(
    value,
    ["v", "intent", "projectId", "workspaceSelectorId"] as const,
    "newChatPayload",
  );
  if (row.v !== 1) return reject("invalid-field", "newChatPayload.v must be exactly 1");
  if (row.intent !== "first_bootstrap" && row.intent !== "new_chat") {
    return reject("invalid-field", "newChatPayload.intent must be first_bootstrap or new_chat");
  }
  return Object.freeze({
    v: 1,
    intent: row.intent,
    projectId: safeId(row.projectId, "newChatPayload.projectId"),
    workspaceSelectorId: safeId(row.workspaceSelectorId, "newChatPayload.workspaceSelectorId"),
  });
}

function encodeUserValue(value: A1IngressUserPayloadV1): string {
  return `{"v":1,"text":${JSON.stringify(value.text)}}`;
}

function encodeNewChatValue(value: A1IngressNewChatPayloadV1): string {
  return `{"v":1,"intent":${JSON.stringify(value.intent)},"project_id":${JSON.stringify(value.projectId)},"workspace_selector_id":${JSON.stringify(value.workspaceSelectorId)}}`;
}

function boundedUtf8(
  raw: string | Uint8Array,
  field: string,
): {
  readonly text: string;
  readonly bytes: Uint8Array;
} {
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
  if (bytes.byteLength > A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES) {
    bytes.fill(0);
    return reject(
      "bad-length",
      `${field} must not exceed ${A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES} UTF-8 bytes`,
    );
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

export function encodeA1IngressUserPayloadV1(value: unknown): string {
  const parsed = parseUserValue(value);
  const encoded = encodeUserValue(parsed);
  if (new TextEncoder().encode(encoded).byteLength > A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES) {
    return reject(
      "bad-length",
      `userPayload must not exceed ${A1_INGRESS_MAX_REASSEMBLED_PLAINTEXT_BYTES} UTF-8 bytes`,
    );
  }
  return encoded;
}

export function encodeA1IngressUserPayloadV1Bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeA1IngressUserPayloadV1(value));
}

export function parseA1IngressUserPayloadV1(raw: string | Uint8Array): A1IngressUserPayloadV1 {
  const source = boundedUtf8(raw, "userPayload");
  try {
    const parsed = parseUserValue(jsonValue(source.text, "userPayload"));
    if (encodeUserValue(parsed) !== source.text) {
      return reject(
        "non-canonical",
        "userPayload must use exact compact JSON with keys v,text in that order",
      );
    }
    return parsed;
  } finally {
    source.bytes.fill(0);
  }
}

export function encodeA1IngressNewChatPayloadV1(value: unknown): string {
  const parsed = parseNewChatCanonicalValue(value);
  return encodeNewChatValue(parsed);
}

export function encodeA1IngressNewChatPayloadV1Bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeA1IngressNewChatPayloadV1(value));
}

export function parseA1IngressNewChatPayloadV1(
  raw: string | Uint8Array,
): A1IngressNewChatPayloadV1 {
  const source = boundedUtf8(raw, "newChatPayload");
  try {
    const parsed = parseNewChatValue(jsonValue(source.text, "newChatPayload"));
    if (encodeNewChatValue(parsed) !== source.text) {
      return reject(
        "non-canonical",
        "newChatPayload must use exact compact JSON with keys v,intent,project_id,workspace_selector_id in that order",
      );
    }
    return parsed;
  } finally {
    source.bytes.fill(0);
  }
}

/**
 * Decode only the two inbound source schemas selected for A1.7a.
 *
 * Other wire-recognized kinds remain recognizable for durable rejection, but deliberately receive no
 * payload semantics from this slice.
 */
export function parseSelectedA1InboundPayload(
  header: A1FrameHeaderV2,
  reassembledPlaintext: string | Uint8Array,
): A1SelectedInboundPayload {
  const selected = assertInboundSemanticHeader(header);
  if (selected.recordKind === "user") {
    const payload = parseA1IngressUserPayloadV1(reassembledPlaintext);
    return Object.freeze({
      recordKind: "user",
      sourcePayloadSchemaId: A1_INGRESS_USER_PAYLOAD_SCHEMA_ID,
      canonicalBytes: encodeA1IngressUserPayloadV1Bytes(payload),
      payload,
    });
  }
  if (selected.recordKind === "new_chat") {
    const payload = parseA1IngressNewChatPayloadV1(reassembledPlaintext);
    return Object.freeze({
      recordKind: "new_chat",
      sourcePayloadSchemaId: A1_INGRESS_NEW_CHAT_PAYLOAD_SCHEMA_ID,
      canonicalBytes: encodeA1IngressNewChatPayloadV1Bytes(payload),
      payload,
    });
  }
  return reject(
    "unsupported-record-kind",
    `record kind ${selected.recordKind} has no selected A1.7a source payload schema`,
  );
}
