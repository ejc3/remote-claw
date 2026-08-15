// Selected-A1 version-2 route, KDF, wire, and digest primitives (§4.3).
//
// This module intentionally uses only Web Platform APIs. It is a dormant byte-contract layer:
// callers still have to authenticate the externally selected broker route and verify an outbound
// Ed25519 host signature before AEAD open or semantic dispatch.

import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { fromHex, sha256, timingSafeEqual, toHex } from "./bytes.js";
import { CanonicalWriter, canonicalByteSnapshot } from "./canonical.js";
import { hkdfExpand, hkdfExtract } from "./hkdf.js";

const IDENTITY_ID_BYTES = 16;
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_SAFE_ID_BYTES = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const LOWER_HEX_IDENTITY = /^[0-9a-f]{32}$/;
const CANONICAL_UINT_TOKEN = /^(?:0|[1-9][0-9]*)$/;
const MAX_SAFE_INTEGER_TOKEN = String(Number.MAX_SAFE_INTEGER);
const MESSAGE_KEY_DOMAIN = "remote-claw/a1/msg-key/v1";

const CONTENT_KINDS = [
  "user",
  "assistant",
  "assistant_sub",
  "assistant_thinking",
  "assistant_thinking_sub",
  "result",
  "system",
  "status",
  "rate_limit",
  "can_use_tool",
  "tool_use",
  "tool_result",
  "task",
  "permission_request",
] as const;

const CHAT_CONTROL_KINDS = [
  "catch_up",
  "permission",
  "interrupt",
  "set_mode",
  "set_model",
  "command",
  "end",
  "attachment",
] as const;

const META_KINDS = [
  "accepted",
  "session_announce",
  "permission_resolved",
  "action_result",
] as const;

const SERVER_CONTROL_KINDS = ["new_chat", "chat_creation_result"] as const;

export type A1ContentKind = (typeof CONTENT_KINDS)[number];
export type A1ChatControlKind = (typeof CHAT_CONTROL_KINDS)[number];
export type A1MetaKind = (typeof META_KINDS)[number];
export type A1ServerControlKind = (typeof SERVER_CONTROL_KINDS)[number];
export type A1RecordKind = A1ContentKind | A1ChatControlKind | A1MetaKind | A1ServerControlKind;
export type A1Direction = "in" | "out";
export type A1Plane = "content" | "control" | "meta" | "server_control_in" | "server_control_out";
export type A1RouteKind = "scope_bus" | "server_control" | "chat";

const CONTENT_KIND_SET: ReadonlySet<string> = new Set(CONTENT_KINDS);
const CHAT_CONTROL_KIND_SET: ReadonlySet<string> = new Set(CHAT_CONTROL_KINDS);
const META_KIND_SET: ReadonlySet<string> = new Set(META_KINDS);
const SERVER_CONTROL_KIND_SET: ReadonlySet<string> = new Set(SERVER_CONTROL_KINDS);

export class A1WireError extends Error {
  constructor(message: string) {
    super(`A1 wire rejected: ${message}`);
    this.name = "A1WireError";
  }

  static is(error: unknown): error is A1WireError {
    return error instanceof A1WireError;
  }
}

function reject(message: string): never {
  throw new A1WireError(message);
}

function snapshotBytes(value: Uint8Array, field: string, expectedBytes?: number): Uint8Array {
  let snapshot: Uint8Array;
  try {
    snapshot = canonicalByteSnapshot(value);
  } catch {
    reject(`${field} must be a Uint8Array`);
  }
  if (expectedBytes !== undefined && snapshot.length !== expectedBytes) {
    reject(`${field} must be exactly ${expectedBytes} bytes`);
  }
  return snapshot;
}

function assertSafeUint(value: number, field: string): number {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    Object.is(value, -0) ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    reject(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertSafeId(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SAFE_ID_BYTES ||
    !SAFE_ID.test(value)
  ) {
    reject(`${field} must be 1-128 ASCII bytes matching [A-Za-z0-9._:-]+`);
  }
  return value;
}

function decodeCanonicalBase64url(
  value: string,
  field: string,
  expectedBytes?: number,
): Uint8Array {
  if (typeof value !== "string") reject(`${field} must be a string`);
  if (expectedBytes !== undefined && value.length !== Math.ceil((expectedBytes * 4) / 3)) {
    reject(`${field} must be canonical unpadded base64url of exactly ${expectedBytes} bytes`);
  }
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value);
  } catch {
    reject(`${field} must be canonical unpadded base64url`);
  }
  if (
    (expectedBytes !== undefined && decoded.length !== expectedBytes) ||
    base64urlEncode(decoded) !== value
  ) {
    const suffix = expectedBytes === undefined ? "" : ` of exactly ${expectedBytes} bytes`;
    reject(`${field} must be canonical unpadded base64url${suffix}`);
  }
  return decoded;
}

function assertCanonicalId(
  value: string,
  field: string,
  prefix: "rcs_" | "rcl_" | "rda_" | "rcr_",
  bodyBytes: number,
): string {
  assertSafeId(value, field);
  if (!value.startsWith(prefix)) reject(`${field} must use the ${prefix} namespace`);
  decodeCanonicalBase64url(value.slice(prefix.length), field, bodyBytes);
  return value;
}

function snapshotIdentityId(identityId: Uint8Array): Uint8Array {
  return snapshotBytes(identityId, "identityId", IDENTITY_ID_BYTES);
}

function writeScope(
  domain: "remote-claw/a1/scope" | "remote-claw/a1/server-control",
  identityId: Uint8Array,
  collaborationServerId: string,
): Uint8Array {
  const identity = snapshotIdentityId(identityId);
  assertCanonicalId(collaborationServerId, "collaborationServerId", "rcs_", 16);
  const writer = new CanonicalWriter();
  writer.str(domain);
  writer.bytes(identity);
  writer.str(collaborationServerId);
  return writer.finish();
}

function writeChatScope(
  domain: string,
  identityId: Uint8Array,
  collaborationServerId: string,
  logicalChatId: string,
): Uint8Array {
  const identity = snapshotIdentityId(identityId);
  assertCanonicalId(collaborationServerId, "collaborationServerId", "rcs_", 16);
  assertCanonicalId(logicalChatId, "logicalChatId", "rcl_", 16);
  const writer = new CanonicalWriter();
  writer.str(domain);
  writer.bytes(identity);
  writer.str(collaborationServerId);
  writer.str(logicalChatId);
  return writer.finish();
}

async function address(bytes: Uint8Array): Promise<string> {
  return base64urlEncode(await sha256(bytes));
}

/** Canonical discovery-bus address for one machine/server scope. */
export async function deriveA1ScopeAddress(
  identityId: Uint8Array,
  collaborationServerId: string,
): Promise<string> {
  return address(
    canonicalA1BrokerRouteAddressPreimage({
      routeKind: "scope_bus",
      identityId,
      collaborationServerId,
      logicalChatId: null,
    }),
  );
}

/** Canonical server-control address for one machine/server scope. */
export async function deriveA1ServerControlAddress(
  identityId: Uint8Array,
  collaborationServerId: string,
): Promise<string> {
  return address(
    canonicalA1BrokerRouteAddressPreimage({
      routeKind: "server_control",
      identityId,
      collaborationServerId,
      logicalChatId: null,
    }),
  );
}

/** Canonical chat address for one complete machine/server/chat scope. */
export async function deriveA1ChatAddress(
  identityId: Uint8Array,
  collaborationServerId: string,
  logicalChatId: string,
): Promise<string> {
  return address(
    canonicalA1BrokerRouteAddressPreimage({
      routeKind: "chat",
      identityId,
      collaborationServerId,
      logicalChatId,
    }),
  );
}

export async function deriveA1ScopeToken(
  identityId: Uint8Array,
  collaborationServerId: string,
): Promise<string> {
  return `bus:a1:${await deriveA1ScopeAddress(identityId, collaborationServerId)}`;
}

export async function deriveA1ServerControlToken(
  identityId: Uint8Array,
  collaborationServerId: string,
): Promise<string> {
  return `ctl:a1:${await deriveA1ServerControlAddress(identityId, collaborationServerId)}`;
}

export async function deriveA1ChatToken(
  identityId: Uint8Array,
  collaborationServerId: string,
  logicalChatId: string,
): Promise<string> {
  return `sess:a1:${await deriveA1ChatAddress(identityId, collaborationServerId, logicalChatId)}`;
}

export type A1BrokerRoute =
  | {
      readonly routeKind: "scope_bus" | "server_control";
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

function snapshotRoute(route: A1BrokerRoute): A1BrokerRoute {
  const {
    routeKind,
    identityId: rawIdentityId,
    collaborationServerId: rawCollaborationServerId,
    logicalChatId: rawLogicalChatId,
  } = route;
  const identityId = snapshotIdentityId(rawIdentityId);
  const collaborationServerId = assertCanonicalId(
    rawCollaborationServerId,
    "collaborationServerId",
    "rcs_",
    16,
  );
  if (routeKind === "chat") {
    return {
      routeKind: "chat",
      identityId,
      collaborationServerId,
      logicalChatId: assertCanonicalId(rawLogicalChatId, "logicalChatId", "rcl_", 16),
    };
  }
  if (routeKind !== "scope_bus" && routeKind !== "server_control") {
    reject("routeKind must be scope_bus, server_control, or chat");
  }
  if (rawLogicalChatId !== null) {
    reject(`${routeKind} route must have null logicalChatId`);
  }
  return { routeKind, identityId, collaborationServerId, logicalChatId: null };
}

/**
 * Exact route-kind-specific address preimage used by the externally visible A1 route token.
 *
 * The route is snapshotted before bytes are emitted, so synchronous host validators can hash these
 * bytes without duplicating domain selection or null-chat rules.
 */
export function canonicalA1BrokerRouteAddressPreimage(route: A1BrokerRoute): Uint8Array {
  const scoped = snapshotRoute(route);
  if (scoped.routeKind === "scope_bus") {
    return writeScope("remote-claw/a1/scope", scoped.identityId, scoped.collaborationServerId);
  }
  if (scoped.routeKind === "server_control") {
    return writeScope(
      "remote-claw/a1/server-control",
      scoped.identityId,
      scoped.collaborationServerId,
    );
  }
  if (scoped.logicalChatId === null) {
    return reject("chat route must have a non-null logicalChatId");
  }
  return writeChatScope(
    "remote-claw/a1/chat",
    scoped.identityId,
    scoped.collaborationServerId,
    scoped.logicalChatId,
  );
}

/** Exact physical broker-route ID preimage, including the route kind and explicit optional chat. */
export function canonicalA1BrokerRouteIdPreimage(route: A1BrokerRoute): Uint8Array {
  const scoped = snapshotRoute(route);
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/broker-route/v1");
  writer.bytes(scoped.identityId);
  writer.str(scoped.collaborationServerId);
  writer.str(scoped.routeKind);
  writer.optionalStr(scoped.logicalChatId);
  return writer.finish();
}

/** Stable physical route ID; distinct from the externally used broker hook token. */
export async function deriveA1BrokerRouteId(route: A1BrokerRoute): Promise<string> {
  return `rcr_${base64urlEncode(await sha256(canonicalA1BrokerRouteIdPreimage(route)))}`;
}

function chatInfo(
  label: string,
  identityId: Uint8Array,
  collaborationServerId: string,
  logicalChatId: string,
): Uint8Array {
  return writeChatScope(label, identityId, collaborationServerId, logicalChatId);
}

function serverControlInfo(
  label: "remote-claw/a1/server-control-in-key/v1" | "remote-claw/a1/server-control-out-key/v1",
  identityId: Uint8Array,
  collaborationServerId: string,
): Uint8Array {
  const identity = snapshotIdentityId(identityId);
  assertCanonicalId(collaborationServerId, "collaborationServerId", "rcs_", 16);
  const writer = new CanonicalWriter();
  writer.str(label);
  writer.bytes(identity);
  writer.str(collaborationServerId);
  return writer.finish();
}

function snapshotKey(key: Uint8Array, field: string): Uint8Array {
  return snapshotBytes(key, field, KEY_BYTES);
}

export interface A1ChatKeys {
  readonly contentKey: Uint8Array;
  readonly controlKey: Uint8Array;
  readonly metaKey: Uint8Array;
}

/** Derive all three chat-scoped A1 plane keys from the onboarding operational keys. */
export async function deriveA1ChatKeys(
  contentRoot: Uint8Array,
  controlKey: Uint8Array,
  metaKey: Uint8Array,
  identityId: Uint8Array,
  collaborationServerId: string,
  logicalChatId: string,
): Promise<A1ChatKeys> {
  const content = snapshotKey(contentRoot, "contentRoot");
  const control = snapshotKey(controlKey, "controlKey");
  const meta = snapshotKey(metaKey, "metaKey");
  const identity = snapshotIdentityId(identityId);
  const server = assertCanonicalId(collaborationServerId, "collaborationServerId", "rcs_", 16);
  const chat = assertCanonicalId(logicalChatId, "logicalChatId", "rcl_", 16);
  // Snapshot every shared coordinate and construct every info value before the first await. A
  // caller mutating its identity Uint8Array while one Expand is pending cannot create mixed-scope
  // output keys.
  const contentInfo = chatInfo("remote-claw/a1/content-key/v1", identity, server, chat);
  const controlInfo = chatInfo("remote-claw/a1/control-key/v1", identity, server, chat);
  const metaInfo = chatInfo("remote-claw/a1/meta-key/v1", identity, server, chat);
  const [contentKeyA1, controlKeyA1, metaKeyA1] = await Promise.all([
    hkdfExpand(content, contentInfo, KEY_BYTES),
    hkdfExpand(control, controlInfo, KEY_BYTES),
    hkdfExpand(meta, metaInfo, KEY_BYTES),
  ]);
  return {
    contentKey: contentKeyA1,
    controlKey: controlKeyA1,
    metaKey: metaKeyA1,
  };
}

export interface A1ServerControlKeys {
  readonly inboundKey: Uint8Array;
  readonly outboundKey: Uint8Array;
}

/** Derive the deliberately distinct server-control inbound and outbound plane keys. */
export async function deriveA1ServerControlKeys(
  controlKey: Uint8Array,
  metaKey: Uint8Array,
  identityId: Uint8Array,
  collaborationServerId: string,
): Promise<A1ServerControlKeys> {
  const control = snapshotKey(controlKey, "controlKey");
  const meta = snapshotKey(metaKey, "metaKey");
  const identity = snapshotIdentityId(identityId);
  const server = assertCanonicalId(collaborationServerId, "collaborationServerId", "rcs_", 16);
  const inboundInfo = serverControlInfo(
    "remote-claw/a1/server-control-in-key/v1",
    identity,
    server,
  );
  const outboundInfo = serverControlInfo(
    "remote-claw/a1/server-control-out-key/v1",
    identity,
    server,
  );
  const [inboundKey, outboundKey] = await Promise.all([
    hkdfExpand(control, inboundInfo, KEY_BYTES),
    hkdfExpand(meta, outboundInfo, KEY_BYTES),
  ]);
  return {
    inboundKey,
    outboundKey,
  };
}

export interface A1FrameHeaderV2 {
  readonly v: 2;
  readonly identityId: Uint8Array;
  readonly collaborationServerId: string;
  readonly logicalChatId: string | null;
  readonly dir: A1Direction;
  readonly recordKind: A1RecordKind;
  readonly seq: number | null;
  readonly msgId: string;
  readonly deliveryAttemptId: string;
  readonly clientMsgId: string | null;
  readonly keyEpoch: 0;
  readonly part: number;
  readonly parts: number;
  readonly serverKeyGeneration: number | null;
  readonly hostSignerIdentityKeyId: string | null;
  readonly hostScopeCertificateId: string | null;
  readonly hostSignatureSequence: number | null;
}

export interface A1SealedFrameV2 extends A1FrameHeaderV2 {
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ct: Uint8Array;
}

export interface A1EncryptedFrameV2 extends A1SealedFrameV2 {
  readonly hostSignature: Uint8Array | null;
}

function isA1RecordKind(value: string): value is A1RecordKind {
  return (
    CONTENT_KIND_SET.has(value) ||
    CHAT_CONTROL_KIND_SET.has(value) ||
    META_KIND_SET.has(value) ||
    SERVER_CONTROL_KIND_SET.has(value)
  );
}

/** Closed kind-to-plane mapping. Unknown kinds fail instead of inheriting a nearby key. */
export function a1PlaneForKind(recordKind: string): A1Plane {
  if (CONTENT_KIND_SET.has(recordKind)) return "content";
  if (CHAT_CONTROL_KIND_SET.has(recordKind)) return "control";
  if (META_KIND_SET.has(recordKind)) return "meta";
  if (recordKind === "new_chat") return "server_control_in";
  if (recordKind === "chat_creation_result") return "server_control_out";
  return reject("unknown record_kind");
}

function snapshotHeader(header: A1FrameHeaderV2): A1FrameHeaderV2 {
  const {
    v,
    identityId: rawIdentityId,
    collaborationServerId: rawCollaborationServerId,
    logicalChatId: rawLogicalChatId,
    dir,
    recordKind,
    seq: rawSeq,
    msgId: rawMsgId,
    deliveryAttemptId: rawDeliveryAttemptId,
    clientMsgId: rawClientMsgId,
    keyEpoch,
    part: rawPart,
    parts: rawParts,
    serverKeyGeneration: rawServerKeyGeneration,
    hostSignerIdentityKeyId: rawHostSignerIdentityKeyId,
    hostScopeCertificateId: rawHostScopeCertificateId,
    hostSignatureSequence: rawHostSignatureSequence,
  } = header;
  if (v !== 2) reject("v must be exactly 2");
  const identityId = snapshotIdentityId(rawIdentityId);
  const collaborationServerId = assertCanonicalId(
    rawCollaborationServerId,
    "collaborationServerId",
    "rcs_",
    16,
  );
  const logicalChatId =
    rawLogicalChatId === null
      ? null
      : assertCanonicalId(rawLogicalChatId, "logicalChatId", "rcl_", 16);
  if (dir !== "in" && dir !== "out") reject('dir must be "in" or "out"');
  if (!isA1RecordKind(recordKind)) reject("unknown record_kind");
  const seq = rawSeq === null ? null : assertSafeUint(rawSeq, "seq");
  const msgId = assertSafeId(rawMsgId, "msgId");
  const deliveryAttemptId = assertCanonicalId(
    rawDeliveryAttemptId,
    "deliveryAttemptId",
    "rda_",
    16,
  );
  const clientMsgId = rawClientMsgId === null ? null : assertSafeId(rawClientMsgId, "clientMsgId");
  if (keyEpoch !== 0) reject("keyEpoch must be exactly 0");
  const part = assertSafeUint(rawPart, "part");
  const parts = assertSafeUint(rawParts, "parts");
  if (parts < 1) reject("parts must be at least 1");
  if (part >= parts) reject("part must be less than parts");
  const serverKeyGeneration =
    rawServerKeyGeneration === null
      ? null
      : assertSafeUint(rawServerKeyGeneration, "serverKeyGeneration");
  if (serverKeyGeneration === 0) reject("serverKeyGeneration must be positive when present");
  const hostSignerIdentityKeyId =
    rawHostSignerIdentityKeyId === null
      ? null
      : assertSafeId(rawHostSignerIdentityKeyId, "hostSignerIdentityKeyId");
  const hostScopeCertificateId =
    rawHostScopeCertificateId === null
      ? null
      : assertSafeId(rawHostScopeCertificateId, "hostScopeCertificateId");
  const hostSignatureSequence =
    rawHostSignatureSequence === null
      ? null
      : assertSafeUint(rawHostSignatureSequence, "hostSignatureSequence");

  const authFields = [
    serverKeyGeneration,
    hostSignerIdentityKeyId,
    hostScopeCertificateId,
    hostSignatureSequence,
  ];
  if (dir === "in" && authFields.some((value) => value !== null)) {
    reject("inbound host-authentication fields must all be null");
  }
  if (dir === "out" && authFields.some((value) => value === null)) {
    reject("outbound host-authentication fields must all be non-null");
  }

  if (SERVER_CONTROL_KIND_SET.has(recordKind)) {
    if (logicalChatId !== null) reject("server-control frames must have null logicalChatId");
    if (part !== 0 || parts !== 1) reject("server-control frames must use part=0 and parts=1");
  } else if (logicalChatId === null) {
    reject("chat and scope-bus frames must have a non-null logicalChatId");
  }

  if (recordKind === "user") {
    if (dir === "in") {
      if (seq !== null) reject("inbound user must have null seq");
      if (clientMsgId === null) reject("inbound user requires clientMsgId");
    } else {
      if (seq === null) reject("outbound user requires a non-null seq");
    }
  } else if (CONTENT_KIND_SET.has(recordKind)) {
    if (dir !== "out" || seq === null || clientMsgId !== null) {
      reject("non-user content must be outbound with non-null seq and null clientMsgId");
    }
  } else if (recordKind === "attachment") {
    if (dir !== "in" || seq !== null || clientMsgId === null) {
      reject("attachment must be inbound with null seq and a clientMsgId");
    }
  } else if (CHAT_CONTROL_KIND_SET.has(recordKind)) {
    if (dir !== "in" || seq !== null || clientMsgId !== null) {
      reject("chat-control must be inbound with null seq and null clientMsgId");
    }
  } else if (META_KIND_SET.has(recordKind)) {
    if (dir !== "out" || seq !== null || clientMsgId !== null) {
      reject("meta frames must be outbound with null seq and null clientMsgId");
    }
  } else if (recordKind === "new_chat") {
    if (dir !== "in" || seq !== null || clientMsgId === null) {
      reject("new_chat must be inbound with null seq and a clientMsgId");
    }
  } else if (dir !== "out" || seq === null || clientMsgId === null) {
    reject("chat_creation_result must be outbound with non-null seq and a clientMsgId");
  }

  return {
    v: 2,
    identityId,
    collaborationServerId,
    logicalChatId,
    dir,
    recordKind,
    seq,
    msgId,
    deliveryAttemptId,
    clientMsgId,
    keyEpoch: 0,
    part,
    parts,
    serverKeyGeneration,
    hostSignerIdentityKeyId,
    hostScopeCertificateId,
    hostSignatureSequence,
  };
}

function snapshotSealedFrame(frame: A1SealedFrameV2): A1SealedFrameV2 {
  const header = snapshotHeader(frame);
  const salt = snapshotBytes(frame.salt, "salt", SALT_BYTES);
  const nonce = snapshotBytes(frame.nonce, "nonce", NONCE_BYTES);
  const ct = snapshotBytes(frame.ct, "ct");
  if (ct.length < GCM_TAG_BYTES) reject(`ct must contain at least a ${GCM_TAG_BYTES}-byte GCM tag`);
  return { ...header, salt, nonce, ct };
}

function snapshotFrame(frame: A1EncryptedFrameV2): A1EncryptedFrameV2 {
  const sealed = snapshotSealedFrame(frame);
  const rawHostSignature = frame.hostSignature;
  const hostSignature =
    rawHostSignature === null
      ? null
      : snapshotBytes(rawHostSignature, "hostSignature", ED25519_SIGNATURE_BYTES);
  if (sealed.dir === "in" && hostSignature !== null) {
    reject("inbound hostSignature must be null");
  }
  if (sealed.dir === "out" && hostSignature === null) {
    reject("outbound hostSignature must be non-null");
  }
  return { ...sealed, hostSignature };
}

/** Exact version-2 canonical AAD, including all cleartext header/signing-coordinate fields. */
export function canonicalA1Aad(header: A1FrameHeaderV2): Uint8Array {
  const value = snapshotHeader(header);
  const writer = new CanonicalWriter();
  writer.uint(2);
  writer.bytes(value.identityId);
  writer.str(value.collaborationServerId);
  writer.optionalStr(value.logicalChatId);
  writer.str(value.dir);
  writer.str(value.recordKind);
  writer.optionalUint(value.seq);
  writer.str(value.msgId);
  writer.str(value.deliveryAttemptId);
  writer.optionalStr(value.clientMsgId);
  writer.uint(0);
  writer.uint(value.part);
  writer.uint(value.parts);
  writer.optionalUint(value.serverKeyGeneration);
  writer.optionalStr(value.hostSignerIdentityKeyId);
  writer.optionalStr(value.hostScopeCertificateId);
  writer.optionalUint(value.hostSignatureSequence);
  return writer.finish();
}

/** Stable logical header shared by transport attempts of one semantic frame. */
export function canonicalA1StableLogicalHeader(header: A1FrameHeaderV2): Uint8Array {
  const value = snapshotHeader(header);
  const writer = new CanonicalWriter();
  writer.uint(2);
  writer.bytes(value.identityId);
  writer.str(value.collaborationServerId);
  writer.optionalStr(value.logicalChatId);
  writer.str(value.dir);
  writer.str(value.recordKind);
  writer.optionalUint(value.seq);
  writer.str(value.msgId);
  writer.optionalStr(value.clientMsgId);
  writer.uint(0);
  return writer.finish();
}

/** K_msg = HKDF-Extract/Expand-SHA256 with the exact A1 domain and canonical AAD bytes. */
export async function deriveA1MessageKey(
  planeKey: Uint8Array,
  salt: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = snapshotKey(planeKey, "planeKey");
  const saltSnapshot = snapshotBytes(salt, "salt", SALT_BYTES);
  const aadSnapshot = snapshotBytes(aad, "aad");
  const infoWriter = new CanonicalWriter();
  infoWriter.str(MESSAGE_KEY_DOMAIN);
  infoWriter.bytes(aadSnapshot);
  const prk = await hkdfExtract(saltSnapshot, key);
  return hkdfExpand(prk, infoWriter.finish(), KEY_BYTES);
}

/**
 * Deterministically seal one part for a caller-allocated salt/nonce.
 *
 * Outbound callers must next sign the returned ciphertext and attach that signature before encode.
 */
export async function sealA1FramePartWith(
  planeKey: Uint8Array,
  header: A1FrameHeaderV2,
  plaintext: Uint8Array,
  salt: Uint8Array,
  nonce: Uint8Array,
): Promise<A1SealedFrameV2> {
  const value = snapshotHeader(header);
  const plaintextSnapshot = snapshotBytes(plaintext, "plaintext");
  const saltSnapshot = snapshotBytes(salt, "salt", SALT_BYTES);
  const nonceSnapshot = snapshotBytes(nonce, "nonce", NONCE_BYTES);
  const aad = canonicalA1Aad(value);
  const messageKey = await deriveA1MessageKey(planeKey, saltSnapshot, aad);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    messageKey as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonceSnapshot as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: GCM_TAG_BYTES * 8,
    },
    cryptoKey,
    plaintextSnapshot as BufferSource,
  );
  return { ...value, salt: saltSnapshot, nonce: nonceSnapshot, ct: new Uint8Array(encrypted) };
}

/**
 * AEAD-open one already route-matched frame. For outbound frames, verify its certified host
 * signature before calling this primitive; AES-GCM alone does not distinguish a pass holder.
 */
export async function openA1FramePart(
  planeKey: Uint8Array,
  frame: A1EncryptedFrameV2,
): Promise<Uint8Array> {
  const value = snapshotFrame(frame);
  const aad = canonicalA1Aad(value);
  const messageKey = await deriveA1MessageKey(planeKey, value.salt, aad);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    messageKey as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: value.nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: GCM_TAG_BYTES * 8,
      },
      cryptoKey,
      value.ct as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    reject("AES-GCM authentication failed");
  }
}

/** Reject machine/server/chat and bus/control/chat transplants before KDF selection. */
export function assertA1FrameMatchesRoute(frame: A1EncryptedFrameV2, route: A1BrokerRoute): void {
  const value = snapshotFrame(frame);
  const selected = snapshotRoute(route);
  if (!timingSafeEqual(value.identityId, selected.identityId)) reject("route identity mismatch");
  if (value.collaborationServerId !== selected.collaborationServerId) {
    reject("route collaboration server mismatch");
  }
  if (selected.routeKind === "scope_bus") {
    if (value.recordKind !== "session_announce" || value.dir !== "out") {
      reject("scope_bus accepts only outbound session_announce");
    }
    return;
  }
  if (selected.routeKind === "server_control") {
    if (value.logicalChatId !== null || !SERVER_CONTROL_KIND_SET.has(value.recordKind)) {
      reject("server_control accepts only new_chat or chat_creation_result with null chat");
    }
    return;
  }
  if (value.logicalChatId !== selected.logicalChatId) reject("route logical chat mismatch");
  if (SERVER_CONTROL_KIND_SET.has(value.recordKind) || value.recordKind === "session_announce") {
    reject("chat route rejects discovery and server-control kinds");
  }
}

function canonicalDigest(bytes: Uint8Array): Promise<string> {
  return sha256(bytes).then(base64urlEncode);
}

/** Exact signed preimage for one outbound ciphertext part. */
export function a1HostSignaturePayload(brokerRouteId: string, frame: A1SealedFrameV2): Uint8Array {
  assertCanonicalId(brokerRouteId, "brokerRouteId", "rcr_", 32);
  const value = snapshotSealedFrame(frame);
  if (value.dir !== "out") reject("inbound frames have no host signature payload");
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/host-output-signature/v1");
  writer.str(brokerRouteId);
  writer.bytes(canonicalA1Aad(value));
  writer.bytes(value.salt);
  writer.bytes(value.nonce);
  writer.bytes(value.ct);
  return writer.finish();
}

export async function a1HostSignedRecordDigest(
  brokerRouteId: string,
  frame: A1SealedFrameV2,
): Promise<string> {
  return canonicalDigest(a1HostSignaturePayload(brokerRouteId, frame));
}

/** Canonical transport bytes; unlike semantic digests these include attempt randomness/signature. */
export function normalizedA1TransportFrameBytes(frame: A1EncryptedFrameV2): Uint8Array {
  const value = snapshotFrame(frame);
  const writer = new CanonicalWriter();
  writer.str("remote-claw/a1/transport-frame/v2");
  writer.bytes(canonicalA1Aad(value));
  writer.bytes(value.salt);
  writer.bytes(value.nonce);
  writer.bytes(value.ct);
  writer.optionalBytes(value.hostSignature);
  return writer.finish();
}

export async function a1TransportFrameDigest(frame: A1EncryptedFrameV2): Promise<string> {
  return canonicalDigest(normalizedA1TransportFrameBytes(frame));
}

export async function a1AttemptHeaderDigest(header: A1FrameHeaderV2): Promise<string> {
  const writer = new CanonicalWriter();
  let canonicalHeader: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    writer.str("remote-claw/a1/attempt-header/v1");
    canonicalHeader = canonicalA1StableLogicalHeader(header);
    writer.bytes(canonicalHeader);
    preimage = writer.finish();
    return await canonicalDigest(preimage);
  } finally {
    canonicalHeader?.fill(0);
    preimage?.fill(0);
    writer.destroy();
  }
}

export async function a1AuthenticatedPartDigest(
  header: A1FrameHeaderV2,
  openedPart: Uint8Array,
): Promise<string> {
  const value = snapshotHeader(header);
  const plaintext = snapshotBytes(openedPart, "openedPart");
  const writer = new CanonicalWriter();
  let canonicalHeader: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    writer.str("remote-claw/a1/stable-part/v1");
    canonicalHeader = canonicalA1StableLogicalHeader(value);
    writer.bytes(canonicalHeader);
    writer.uint(value.part);
    writer.uint(value.parts);
    writer.bytes(plaintext);
    preimage = writer.finish();
    return await canonicalDigest(preimage);
  } finally {
    plaintext.fill(0);
    canonicalHeader?.fill(0);
    preimage?.fill(0);
    writer.destroy();
  }
}

export async function a1CanonicalMessageDigest(
  header: A1FrameHeaderV2,
  reassembledPlaintext: Uint8Array,
): Promise<string> {
  const value = snapshotHeader(header);
  const plaintext = snapshotBytes(reassembledPlaintext, "reassembledPlaintext");
  const writer = new CanonicalWriter();
  let canonicalHeader: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    writer.str("remote-claw/a1/logical-message/v1");
    canonicalHeader = canonicalA1StableLogicalHeader(value);
    writer.bytes(canonicalHeader);
    writer.uint(value.parts);
    writer.bytes(plaintext);
    preimage = writer.finish();
    return await canonicalDigest(preimage);
  } finally {
    plaintext.fill(0);
    canonicalHeader?.fill(0);
    preimage?.fill(0);
    writer.destroy();
  }
}

type RawJsonValue =
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "number"; readonly token: string }
  | { readonly type: "null" };

class FlatJsonObjectParser {
  readonly #raw: string;
  #offset = 0;

  constructor(raw: string) {
    this.#raw = raw;
  }

  #skipWhitespace(): void {
    while (this.#offset < this.#raw.length) {
      const char = this.#raw.charCodeAt(this.#offset);
      if (char !== 0x20 && char !== 0x09 && char !== 0x0a && char !== 0x0d) break;
      this.#offset++;
    }
  }

  #consume(expected: string): void {
    if (this.#raw[this.#offset] !== expected) reject(`expected ${JSON.stringify(expected)}`);
    this.#offset++;
  }

  #string(): string {
    if (this.#raw[this.#offset] !== '"') reject("expected a JSON string");
    const start = this.#offset++;
    let closed = false;
    while (this.#offset < this.#raw.length) {
      const code = this.#raw.charCodeAt(this.#offset++);
      if (code === 0x22) {
        closed = true;
        break;
      }
      if (code === 0x5c) {
        if (this.#offset >= this.#raw.length) break;
        this.#offset++;
      }
    }
    if (!closed) reject("unterminated JSON string");
    const token = this.#raw.slice(start, this.#offset);
    try {
      const parsed = JSON.parse(token) as unknown;
      if (typeof parsed !== "string") reject("expected a JSON string");
      return parsed;
    } catch (error) {
      if (A1WireError.is(error)) throw error;
      return reject("invalid JSON string");
    }
  }

  #value(): RawJsonValue {
    if (this.#raw[this.#offset] === '"') return { type: "string", value: this.#string() };
    const start = this.#offset;
    while (this.#offset < this.#raw.length) {
      const code = this.#raw.charCodeAt(this.#offset);
      if (
        code === 0x2c ||
        code === 0x7d ||
        code === 0x20 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d
      ) {
        break;
      }
      this.#offset++;
    }
    const token = this.#raw.slice(start, this.#offset);
    if (token === "null") return { type: "null" };
    if (token.length === 0) reject("expected a JSON value");
    return { type: "number", token };
  }

  parse(): Map<string, RawJsonValue> {
    this.#skipWhitespace();
    this.#consume("{");
    const fields = new Map<string, RawJsonValue>();
    this.#skipWhitespace();
    if (this.#raw[this.#offset] === "}") {
      this.#offset++;
    } else {
      while (true) {
        this.#skipWhitespace();
        const key = this.#string();
        if (fields.has(key)) reject(`duplicate JSON member: ${key}`);
        this.#skipWhitespace();
        this.#consume(":");
        this.#skipWhitespace();
        fields.set(key, this.#value());
        this.#skipWhitespace();
        const next = this.#raw[this.#offset];
        if (next === "}") {
          this.#offset++;
          break;
        }
        this.#consume(",");
        this.#skipWhitespace();
        if (this.#raw[this.#offset] === "}") reject("trailing JSON comma");
      }
    }
    this.#skipWhitespace();
    if (this.#offset !== this.#raw.length) reject("trailing bytes after JSON frame");
    return fields;
  }
}

const REQUIRED_JSON_FIELDS = [
  "v",
  "identity_id",
  "collaboration_server_id",
  "logical_chat_id",
  "dir",
  "record_kind",
  "seq",
  "msg_id",
  "delivery_attempt_id",
  "key_epoch",
  "salt",
  "nonce",
  "ct",
  "part",
  "parts",
  "server_key_generation",
  "host_signer_identity_key_id",
  "host_scope_certificate_id",
  "host_signature_sequence",
  "host_signature",
] as const;

const JSON_FIELD_SET: ReadonlySet<string> = new Set([...REQUIRED_JSON_FIELDS, "client_msg_id"]);

function requireRaw(fields: Map<string, RawJsonValue>, field: string): RawJsonValue {
  const value = fields.get(field);
  if (value === undefined) reject(`missing JSON member: ${field}`);
  return value;
}

function requireString(fields: Map<string, RawJsonValue>, field: string): string {
  const value = requireRaw(fields, field);
  if (value.type !== "string") reject(`${field} must be a JSON string`);
  return value.value;
}

function optionalNullableString(fields: Map<string, RawJsonValue>, field: string): string | null {
  const value = requireRaw(fields, field);
  if (value.type === "null") return null;
  if (value.type !== "string") reject(`${field} must be a JSON string or null`);
  return value.value;
}

function parseCanonicalUintToken(token: string, field: string): number {
  if (!CANONICAL_UINT_TOKEN.test(token)) {
    reject(`${field} must use canonical non-negative integer spelling`);
  }
  if (
    token.length > MAX_SAFE_INTEGER_TOKEN.length ||
    (token.length === MAX_SAFE_INTEGER_TOKEN.length && token > MAX_SAFE_INTEGER_TOKEN)
  ) {
    reject(`${field} must be at most ${MAX_SAFE_INTEGER_TOKEN}`);
  }
  return Number(token);
}

function requireUint(fields: Map<string, RawJsonValue>, field: string): number {
  const value = requireRaw(fields, field);
  if (value.type !== "number") reject(`${field} must be a JSON number`);
  return parseCanonicalUintToken(value.token, field);
}

function requireNullableUint(fields: Map<string, RawJsonValue>, field: string): number | null {
  const value = requireRaw(fields, field);
  if (value.type === "null") return null;
  if (value.type !== "number") reject(`${field} must be a JSON number or null`);
  return parseCanonicalUintToken(value.token, field);
}

function parseWireIdentity(value: string): Uint8Array {
  if (!LOWER_HEX_IDENTITY.test(value)) {
    reject("identity_id must be exactly 32 lowercase hexadecimal characters");
  }
  return fromHex(value);
}

function decodeRawJson(raw: string | Uint8Array): string {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else {
    const bytes = snapshotBytes(raw, "frame");
    try {
      // `ignoreBOM:true` preserves an encoded BOM as U+FEFF so it can be rejected explicitly.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      reject("frame bytes must be well-formed UTF-8");
    }
  }
  if (text.charCodeAt(0) === 0xfeff) reject("frame must not begin with a UTF-8 BOM");
  return text;
}

/** Parse raw JSON text/bytes without first-key/last-key or lossy number-token behavior. */
export function parseA1EncryptedFrameV2(raw: string | Uint8Array): A1EncryptedFrameV2 {
  const fields = new FlatJsonObjectParser(decodeRawJson(raw)).parse();
  for (const field of fields.keys()) {
    if (!JSON_FIELD_SET.has(field)) reject(`unknown JSON member: ${field}`);
  }
  for (const field of REQUIRED_JSON_FIELDS) requireRaw(fields, field);

  const clientRaw = fields.get("client_msg_id");
  let clientMsgId: string | null = null;
  if (clientRaw !== undefined) {
    if (clientRaw.type !== "string") reject("client_msg_id must be a JSON string when present");
    clientMsgId = clientRaw.value;
  }

  const recordKind = requireString(fields, "record_kind");
  if (!isA1RecordKind(recordKind)) reject("unknown record_kind");
  const dir = requireString(fields, "dir");
  if (dir !== "in" && dir !== "out") reject('dir must be "in" or "out"');
  const logicalChatId = optionalNullableString(fields, "logical_chat_id");
  const hostSignatureString = optionalNullableString(fields, "host_signature");

  const frame: A1EncryptedFrameV2 = {
    v: requireUint(fields, "v") as 2,
    identityId: parseWireIdentity(requireString(fields, "identity_id")),
    collaborationServerId: requireString(fields, "collaboration_server_id"),
    logicalChatId,
    dir,
    recordKind,
    seq: requireNullableUint(fields, "seq"),
    msgId: requireString(fields, "msg_id"),
    deliveryAttemptId: requireString(fields, "delivery_attempt_id"),
    clientMsgId,
    keyEpoch: requireUint(fields, "key_epoch") as 0,
    salt: decodeCanonicalBase64url(requireString(fields, "salt"), "salt", SALT_BYTES),
    nonce: decodeCanonicalBase64url(requireString(fields, "nonce"), "nonce", NONCE_BYTES),
    ct: decodeCanonicalBase64url(requireString(fields, "ct"), "ct"),
    part: requireUint(fields, "part"),
    parts: requireUint(fields, "parts"),
    serverKeyGeneration: requireNullableUint(fields, "server_key_generation"),
    hostSignerIdentityKeyId: optionalNullableString(fields, "host_signer_identity_key_id"),
    hostScopeCertificateId: optionalNullableString(fields, "host_scope_certificate_id"),
    hostSignatureSequence: requireNullableUint(fields, "host_signature_sequence"),
    hostSignature:
      hostSignatureString === null
        ? null
        : decodeCanonicalBase64url(hostSignatureString, "host_signature", ED25519_SIGNATURE_BYTES),
  };
  return snapshotFrame(frame);
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function jsonNullableString(value: string | null): string {
  return value === null ? "null" : jsonString(value);
}

function jsonNullableUint(value: number | null): string {
  return value === null ? "null" : String(value);
}

/** Emit the one deterministic compact JSON spelling used for retained A1 frame bytes. */
export function encodeA1EncryptedFrameV2(frame: A1EncryptedFrameV2): string {
  const value = snapshotFrame(frame);
  const members = [
    `"v":2`,
    `"identity_id":${jsonString(toHex(value.identityId))}`,
    `"collaboration_server_id":${jsonString(value.collaborationServerId)}`,
    `"logical_chat_id":${jsonNullableString(value.logicalChatId)}`,
    `"dir":${jsonString(value.dir)}`,
    `"record_kind":${jsonString(value.recordKind)}`,
    `"seq":${jsonNullableUint(value.seq)}`,
    `"msg_id":${jsonString(value.msgId)}`,
    `"delivery_attempt_id":${jsonString(value.deliveryAttemptId)}`,
  ];
  if (value.clientMsgId !== null) {
    members.push(`"client_msg_id":${jsonString(value.clientMsgId)}`);
  }
  members.push(
    `"key_epoch":0`,
    `"salt":${jsonString(base64urlEncode(value.salt))}`,
    `"nonce":${jsonString(base64urlEncode(value.nonce))}`,
    `"ct":${jsonString(base64urlEncode(value.ct))}`,
    `"part":${String(value.part)}`,
    `"parts":${String(value.parts)}`,
    `"server_key_generation":${jsonNullableUint(value.serverKeyGeneration)}`,
    `"host_signer_identity_key_id":${jsonNullableString(value.hostSignerIdentityKeyId)}`,
    `"host_scope_certificate_id":${jsonNullableString(value.hostScopeCertificateId)}`,
    `"host_signature_sequence":${jsonNullableUint(value.hostSignatureSequence)}`,
    `"host_signature":${
      value.hostSignature === null ? "null" : jsonString(base64urlEncode(value.hostSignature))
    }`,
  );
  return `{${members.join(",")}}`;
}

/** UTF-8 bytes of {@link encodeA1EncryptedFrameV2}, suitable for exact retained transport bytes. */
export function encodeA1EncryptedFrameV2Bytes(frame: A1EncryptedFrameV2): Uint8Array {
  return new TextEncoder().encode(encodeA1EncryptedFrameV2(frame));
}
