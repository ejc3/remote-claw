// Browser-safe selected-A1 broker records and byte contracts.
//
// This module owns no HTTP routing, authentication, persistence, or recovery policy. It freezes the
// values those layers exchange so every runtime validates the same route, cursor, manifest, retry,
// collision, and pagination semantics.

import {
  type A1BrokerRoute,
  type A1EncryptedFrameV2,
  type A1RouteKind,
  a1TransportFrameDigest,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  deriveA1ScopeToken,
  deriveA1ServerControlToken,
  encodeA1EncryptedFrameV2,
  parseA1EncryptedFrameV2,
} from "./a1-wire.js";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { fromHex, sha256 } from "./bytes.js";
import { CanonicalWriter, canonicalByteSnapshot } from "./canonical.js";

export const BROKER_BACKEND_CAPABILITIES_SCHEMA_ID =
  "remote-claw/broker-backend-capabilities/v1" as const;
export const A1_BROKER_GENERATION_MANIFEST_DOMAIN =
  "remote-claw/a1/broker-generation-manifest/v1" as const;

/** Maximum accepted UTF-8 bytes in one raw publish body. */
export const A1_BROKER_MAX_RAW_FRAME_BYTES = 4_450_000;
/** Exclusive upper bound: ciphertexts whose decoded length is >= this value are rejected. */
export const A1_BROKER_CIPHERTEXT_LIMIT_BYTES = 3_300_000;
export const A1_BROKER_MAX_PARTS = 32;
export const A1_BROKER_GENERATION_FRAME_CAP = 4_096;
export const A1_BROKER_DEFAULT_READ_FRAMES = 64;
export const A1_BROKER_MAX_READ_FRAMES = 64;
export const A1_BROKER_MAX_READ_ENCODED_BYTES = 8_000_000;

const IDENTITY_ID = /^[0-9a-f]{32}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const MAX_SAFE_ID_LENGTH = 128;
const DIGEST_BYTES = 32;
const RANDOM_ID_BYTES = 16;

export type A1BrokerContractErrorReason =
  | "invalid-record"
  | "invalid-field"
  | "bad-length"
  | "digest-mismatch"
  | "route-mismatch"
  | "invalid-order";

export class A1BrokerContractError extends Error {
  readonly reason: A1BrokerContractErrorReason;

  constructor(reason: A1BrokerContractErrorReason, message: string) {
    super(`A1 broker contract rejected: ${message}`);
    this.name = "A1BrokerContractError";
    this.reason = reason;
  }

  static is(error: unknown): error is A1BrokerContractError {
    return error instanceof A1BrokerContractError;
  }
}

function reject(reason: A1BrokerContractErrorReason, message: string): never {
  throw new A1BrokerContractError(reason, message);
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  field: string,
): { readonly [P in K[number]]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("invalid-record", `${field} must be a plain object`);
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    reject("invalid-record", `${field} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    reject("invalid-record", `${field} must be a plain object`);
  }
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    reject("invalid-record", `${field} must contain exactly the selected fields`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      reject("invalid-record", `${field}.${key} could not be inspected safely`);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      reject("invalid-record", `${field}.${key} must be an own data property`);
    }
    snapshot[key] = descriptor.value as unknown;
  }
  return snapshot as { readonly [P in K[number]]: unknown };
}

function exactArray(value: unknown, field: string, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value)) reject("invalid-record", `${field} must be an array`);
  if (value.length > maxLength) reject("bad-length", `${field} exceeds ${maxLength} entries`);
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    reject("invalid-record", `${field} could not be inspected safely`);
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
    reject("invalid-record", `${field} must not contain extra properties`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      reject("invalid-record", `${field}[${index}] could not be inspected safely`);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      reject("invalid-record", `${field}[${index}] must be an own data property`);
    }
    snapshot.push(descriptor.value as unknown);
  }
  return snapshot;
}

function literal<const T extends string | number | boolean>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) reject("invalid-field", `${field} must be ${JSON.stringify(expected)}`);
  return expected;
}

function safeUint(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum ||
    Object.is(value, -0)
  ) {
    reject("invalid-field", `${field} must be a non-negative safe integer at most ${maximum}`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") reject("invalid-field", `${field} must be a string`);
  return value;
}

function safeId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SAFE_ID_LENGTH ||
    !SAFE_ID.test(value)
  ) {
    reject("invalid-field", `${field} must be 1-128 ASCII characters matching [A-Za-z0-9._:-]+`);
  }
  return value;
}

function canonicalBase64url(value: unknown, bytes: number, field: string): string {
  if (typeof value !== "string" || value.length !== Math.ceil((bytes * 4) / 3)) {
    reject("invalid-field", `${field} must be canonical unpadded base64url of ${bytes} bytes`);
  }
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value);
  } catch {
    reject("invalid-field", `${field} must be canonical unpadded base64url of ${bytes} bytes`);
  }
  if (decoded.byteLength !== bytes || base64urlEncode(decoded) !== value) {
    reject("invalid-field", `${field} must be canonical unpadded base64url of ${bytes} bytes`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  return canonicalBase64url(value, DIGEST_BYTES, field);
}

function canonicalId(
  value: unknown,
  prefix: "rcs_" | "rcl_" | "rda_" | "rcr_",
  bytes: number,
  field: string,
): string {
  const parsed = safeId(value, field);
  if (!parsed.startsWith(prefix))
    reject("invalid-field", `${field} must use the ${prefix} namespace`);
  canonicalBase64url(parsed.slice(prefix.length), bytes, field);
  return parsed;
}

function identityId(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTITY_ID.test(value)) {
    reject("invalid-field", `${field} must be exactly 32 lowercase hexadecimal characters`);
  }
  return value;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

export interface BrokerBackendCapabilitiesV1 {
  readonly schemaVersion: 1;
  readonly protocol: "remote-claw-broker-a1";
  readonly durableCiphertext: true;
  readonly routeWideDeliveryAttemptUniqueness: true;
  readonly brokerRecomputesTransportDigest: true;
  readonly exactRetryReturnsOriginalCursor: true;
  readonly generationManifests: true;
  readonly immutableCollisionTombstones: true;
}

const CAPABILITY_KEYS = [
  "schemaVersion",
  "protocol",
  "durableCiphertext",
  "routeWideDeliveryAttemptUniqueness",
  "brokerRecomputesTransportDigest",
  "exactRetryReturnsOriginalCursor",
  "generationManifests",
  "immutableCollisionTombstones",
] as const;

export const SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1: BrokerBackendCapabilitiesV1 = freeze({
  schemaVersion: 1,
  protocol: "remote-claw-broker-a1",
  durableCiphertext: true,
  routeWideDeliveryAttemptUniqueness: true,
  brokerRecomputesTransportDigest: true,
  exactRetryReturnsOriginalCursor: true,
  generationManifests: true,
  immutableCollisionTombstones: true,
});

export function parseBrokerBackendCapabilitiesV1(value: unknown): BrokerBackendCapabilitiesV1 {
  const row = exactRecord(value, CAPABILITY_KEYS, "brokerBackendCapabilities");
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "brokerBackendCapabilities.schemaVersion"),
    protocol: literal(row.protocol, "remote-claw-broker-a1", "brokerBackendCapabilities.protocol"),
    durableCiphertext: literal(
      row.durableCiphertext,
      true,
      "brokerBackendCapabilities.durableCiphertext",
    ),
    routeWideDeliveryAttemptUniqueness: literal(
      row.routeWideDeliveryAttemptUniqueness,
      true,
      "brokerBackendCapabilities.routeWideDeliveryAttemptUniqueness",
    ),
    brokerRecomputesTransportDigest: literal(
      row.brokerRecomputesTransportDigest,
      true,
      "brokerBackendCapabilities.brokerRecomputesTransportDigest",
    ),
    exactRetryReturnsOriginalCursor: literal(
      row.exactRetryReturnsOriginalCursor,
      true,
      "brokerBackendCapabilities.exactRetryReturnsOriginalCursor",
    ),
    generationManifests: literal(
      row.generationManifests,
      true,
      "brokerBackendCapabilities.generationManifests",
    ),
    immutableCollisionTombstones: literal(
      row.immutableCollisionTombstones,
      true,
      "brokerBackendCapabilities.immutableCollisionTombstones",
    ),
  });
}

/** Exact CanonicalWriter bytes retained as the protected capability artifact. */
export function canonicalBrokerBackendCapabilitiesV1(value: unknown): Uint8Array {
  const parsed = parseBrokerBackendCapabilitiesV1(value);
  const writer = new CanonicalWriter();
  writer.str(BROKER_BACKEND_CAPABILITIES_SCHEMA_ID);
  writer.uint(parsed.schemaVersion);
  writer.str(parsed.protocol);
  writer.uint(1);
  writer.uint(1);
  writer.uint(1);
  writer.uint(1);
  writer.uint(1);
  writer.uint(1);
  return writer.finish();
}

export async function brokerBackendCapabilitiesDigest(value: unknown): Promise<string> {
  return base64urlEncode(await sha256(canonicalBrokerBackendCapabilitiesV1(value)));
}

/** Normalize an absolute HTTP(S) URL with no authority ambiguity to its WHATWG origin. */
export function parseA1BrokerOrigin(value: unknown): string {
  if (typeof value !== "string") reject("invalid-field", "brokerOrigin must be a string");
  if (value.length === 0 || value.length > 1_024) {
    reject("bad-length", "brokerOrigin must contain 1-1024 UTF-16 code units");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    reject("invalid-field", "brokerOrigin must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    reject("invalid-field", "brokerOrigin must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    reject("invalid-field", "brokerOrigin must not contain userinfo");
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    reject("invalid-field", "brokerOrigin must contain only an origin");
  }
  return parsed.origin;
}

export function parseA1BrokerRouteStoreInstanceId(value: unknown): string {
  const parsed = safeId(value, "routeStoreInstanceId");
  if (!parsed.startsWith("rbsi_")) {
    reject("invalid-field", "routeStoreInstanceId must use the rbsi_ namespace");
  }
  canonicalBase64url(parsed.slice(5), RANDOM_ID_BYTES, "routeStoreInstanceId");
  return parsed;
}

export interface BrokerChannelCursorV1 {
  readonly version: 1;
  readonly channelGeneration: number;
  readonly frameIndex: number;
}

const CURSOR_KEYS = ["version", "channelGeneration", "frameIndex"] as const;

export function parseBrokerChannelCursorV1(value: unknown): BrokerChannelCursorV1 {
  const row = exactRecord(value, CURSOR_KEYS, "brokerChannelCursor");
  return freeze({
    version: literal(row.version, 1, "brokerChannelCursor.version"),
    channelGeneration: safeUint(row.channelGeneration, "brokerChannelCursor.channelGeneration"),
    frameIndex: safeUint(
      row.frameIndex,
      "brokerChannelCursor.frameIndex",
      A1_BROKER_GENERATION_FRAME_CAP - 1,
    ),
  });
}

export function encodeBrokerChannelCursorV1(value: unknown): string {
  const parsed = parseBrokerChannelCursorV1(value);
  return `{"version":1,"channelGeneration":${parsed.channelGeneration},"frameIndex":${parsed.frameIndex}}`;
}

export interface BrokerReadPositionV1 {
  readonly version: 1;
  readonly channelGeneration: number;
  readonly nextFrameIndex: number;
}

const READ_POSITION_KEYS = ["version", "channelGeneration", "nextFrameIndex"] as const;

export function parseBrokerReadPositionV1(value: unknown): BrokerReadPositionV1 {
  const row = exactRecord(value, READ_POSITION_KEYS, "brokerReadPosition");
  return freeze({
    version: literal(row.version, 1, "brokerReadPosition.version"),
    channelGeneration: safeUint(row.channelGeneration, "brokerReadPosition.channelGeneration"),
    nextFrameIndex: safeUint(
      row.nextFrameIndex,
      "brokerReadPosition.nextFrameIndex",
      A1_BROKER_GENERATION_FRAME_CAP,
    ),
  });
}

export function encodeBrokerReadPositionV1(value: unknown): string {
  const parsed = parseBrokerReadPositionV1(value);
  return `{"version":1,"channelGeneration":${parsed.channelGeneration},"nextFrameIndex":${parsed.nextFrameIndex}}`;
}

export type BrokerChannelGenerationRecordV1 =
  | {
      readonly schemaVersion: 1;
      readonly brokerRouteId: string;
      readonly channelGeneration: number;
      readonly state: "open";
      readonly frameCount: null;
      readonly nextGeneration: null;
      readonly manifestDigest: null;
    }
  | {
      readonly schemaVersion: 1;
      readonly brokerRouteId: string;
      readonly channelGeneration: number;
      readonly state: "sealed";
      readonly frameCount: number;
      readonly nextGeneration: number;
      readonly manifestDigest: string;
    };

const GENERATION_KEYS = [
  "schemaVersion",
  "brokerRouteId",
  "channelGeneration",
  "state",
  "frameCount",
  "nextGeneration",
  "manifestDigest",
] as const;

export interface A1BrokerGenerationManifestInputV1 {
  readonly brokerRouteId: string;
  readonly channelGeneration: number;
  readonly frameCount: number;
  readonly nextGeneration: number;
  readonly state: "sealed";
}

const MANIFEST_INPUT_KEYS = [
  "brokerRouteId",
  "channelGeneration",
  "frameCount",
  "nextGeneration",
  "state",
] as const;

function parseManifestInput(value: unknown): A1BrokerGenerationManifestInputV1 {
  const row = exactRecord(value, MANIFEST_INPUT_KEYS, "brokerGenerationManifest");
  const channelGeneration = safeUint(
    row.channelGeneration,
    "brokerGenerationManifest.channelGeneration",
    Number.MAX_SAFE_INTEGER - 1,
  );
  const nextGeneration = safeUint(row.nextGeneration, "brokerGenerationManifest.nextGeneration");
  if (nextGeneration !== channelGeneration + 1) {
    reject(
      "invalid-field",
      "brokerGenerationManifest.nextGeneration must equal channelGeneration + 1",
    );
  }
  return freeze({
    brokerRouteId: canonicalId(
      row.brokerRouteId,
      "rcr_",
      32,
      "brokerGenerationManifest.brokerRouteId",
    ),
    channelGeneration,
    frameCount: safeUint(
      row.frameCount,
      "brokerGenerationManifest.frameCount",
      A1_BROKER_GENERATION_FRAME_CAP,
    ),
    nextGeneration,
    state: literal(row.state, "sealed", "brokerGenerationManifest.state"),
  });
}

export function canonicalA1BrokerGenerationManifestV1(value: unknown): Uint8Array {
  const parsed = parseManifestInput(value);
  const writer = new CanonicalWriter();
  writer.str(A1_BROKER_GENERATION_MANIFEST_DOMAIN);
  writer.str(parsed.brokerRouteId);
  writer.uint(parsed.channelGeneration);
  writer.uint(parsed.frameCount);
  writer.uint(parsed.nextGeneration);
  writer.str("sealed");
  return writer.finish();
}

export async function a1BrokerGenerationManifestDigest(value: unknown): Promise<string> {
  return base64urlEncode(await sha256(canonicalA1BrokerGenerationManifestV1(value)));
}

export async function parseBrokerChannelGenerationRecordV1(
  value: unknown,
): Promise<BrokerChannelGenerationRecordV1> {
  const row = exactRecord(value, GENERATION_KEYS, "brokerChannelGeneration");
  const schemaVersion = literal(row.schemaVersion, 1, "brokerChannelGeneration.schemaVersion");
  const brokerRouteId = canonicalId(
    row.brokerRouteId,
    "rcr_",
    32,
    "brokerChannelGeneration.brokerRouteId",
  );
  const channelGeneration = safeUint(
    row.channelGeneration,
    "brokerChannelGeneration.channelGeneration",
  );
  if (row.state === "open") {
    if (row.frameCount !== null || row.nextGeneration !== null || row.manifestDigest !== null) {
      reject("invalid-field", "an open broker generation must have null manifest fields");
    }
    return freeze({
      schemaVersion,
      brokerRouteId,
      channelGeneration,
      state: "open",
      frameCount: null,
      nextGeneration: null,
      manifestDigest: null,
    });
  }
  literal(row.state, "sealed", "brokerChannelGeneration.state");
  const frameCount = safeUint(
    row.frameCount,
    "brokerChannelGeneration.frameCount",
    A1_BROKER_GENERATION_FRAME_CAP,
  );
  const nextGeneration = safeUint(row.nextGeneration, "brokerChannelGeneration.nextGeneration");
  const manifestDigest = digest(row.manifestDigest, "brokerChannelGeneration.manifestDigest");
  const expected = await a1BrokerGenerationManifestDigest({
    brokerRouteId,
    channelGeneration,
    frameCount,
    nextGeneration,
    state: "sealed",
  });
  if (manifestDigest !== expected) {
    reject(
      "digest-mismatch",
      "brokerChannelGeneration.manifestDigest does not match its sealed tuple",
    );
  }
  return freeze({
    schemaVersion,
    brokerRouteId,
    channelGeneration,
    state: "sealed",
    frameCount,
    nextGeneration,
    manifestDigest,
  });
}

function encodeGenerationParsed(value: BrokerChannelGenerationRecordV1): string {
  return `{"schemaVersion":1,"brokerRouteId":${jsonString(value.brokerRouteId)},"channelGeneration":${value.channelGeneration},"state":${jsonString(value.state)},"frameCount":${value.frameCount === null ? "null" : value.frameCount},"nextGeneration":${value.nextGeneration === null ? "null" : value.nextGeneration},"manifestDigest":${value.manifestDigest === null ? "null" : jsonString(value.manifestDigest)}}`;
}

export async function encodeBrokerChannelGenerationRecordV1(value: unknown): Promise<string> {
  return encodeGenerationParsed(await parseBrokerChannelGenerationRecordV1(value));
}

export interface A1BrokerRouteDescriptorV1 {
  readonly schemaVersion: 1;
  readonly brokerOrigin: string;
  readonly backendSelector: "sqlite";
  readonly routeStoreInstanceId: string;
  readonly identityId: string;
  readonly collaborationServerId: string;
  readonly routeKind: A1RouteKind;
  readonly logicalChatId: string | null;
  readonly brokerRouteId: string;
  readonly routeToken: string;
  readonly brokerBackendCapabilitiesDigest: string;
}

const ROUTE_KEYS = [
  "schemaVersion",
  "brokerOrigin",
  "backendSelector",
  "routeStoreInstanceId",
  "identityId",
  "collaborationServerId",
  "routeKind",
  "logicalChatId",
  "brokerRouteId",
  "routeToken",
  "brokerBackendCapabilitiesDigest",
] as const;

function routeKind(value: unknown, field: string): A1RouteKind {
  if (value !== "scope_bus" && value !== "server_control" && value !== "chat") {
    reject("invalid-field", `${field} must be scope_bus, server_control, or chat`);
  }
  return value;
}

async function expectedRouteCoordinates(route: A1BrokerRoute): Promise<readonly [string, string]> {
  const brokerRouteId = await deriveA1BrokerRouteId(route);
  if (route.routeKind === "scope_bus") {
    return [brokerRouteId, await deriveA1ScopeToken(route.identityId, route.collaborationServerId)];
  }
  if (route.routeKind === "server_control") {
    return [
      brokerRouteId,
      await deriveA1ServerControlToken(route.identityId, route.collaborationServerId),
    ];
  }
  if (route.logicalChatId === null) {
    return reject("route-mismatch", "chat route must have a logical chat ID");
  }
  return [
    brokerRouteId,
    await deriveA1ChatToken(route.identityId, route.collaborationServerId, route.logicalChatId),
  ];
}

export async function parseA1BrokerRouteDescriptorV1(
  value: unknown,
): Promise<A1BrokerRouteDescriptorV1> {
  const row = exactRecord(value, ROUTE_KEYS, "brokerRoute");
  const rawOrigin = stringValue(row.brokerOrigin, "brokerRoute.brokerOrigin");
  const brokerOrigin = parseA1BrokerOrigin(rawOrigin);
  if (rawOrigin !== brokerOrigin) {
    reject(
      "invalid-field",
      "brokerRoute.brokerOrigin must already use its canonical WHATWG origin",
    );
  }
  const parsedIdentityId = identityId(row.identityId, "brokerRoute.identityId");
  const collaborationServerId = canonicalId(
    row.collaborationServerId,
    "rcs_",
    16,
    "brokerRoute.collaborationServerId",
  );
  const parsedRouteKind = routeKind(row.routeKind, "brokerRoute.routeKind");
  let logicalChatId: string | null;
  if (parsedRouteKind === "chat") {
    logicalChatId = canonicalId(row.logicalChatId, "rcl_", 16, "brokerRoute.logicalChatId");
  } else {
    if (row.logicalChatId !== null) {
      reject("invalid-field", `brokerRoute.${parsedRouteKind} must have null logicalChatId`);
    }
    logicalChatId = null;
  }
  const route = {
    routeKind: parsedRouteKind,
    identityId: fromHex(parsedIdentityId),
    collaborationServerId,
    logicalChatId,
  } as A1BrokerRoute;
  const [expectedId, expectedToken] = await expectedRouteCoordinates(route);
  const brokerRouteId = canonicalId(row.brokerRouteId, "rcr_", 32, "brokerRoute.brokerRouteId");
  const routeToken = safeId(row.routeToken, "brokerRoute.routeToken");
  if (brokerRouteId !== expectedId || routeToken !== expectedToken) {
    reject("route-mismatch", "brokerRoute ID/token do not match the complete route tuple");
  }
  const capabilitiesDigest = digest(
    row.brokerBackendCapabilitiesDigest,
    "brokerRoute.brokerBackendCapabilitiesDigest",
  );
  const expectedCapabilitiesDigest = await brokerBackendCapabilitiesDigest(
    SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
  );
  if (capabilitiesDigest !== expectedCapabilitiesDigest) {
    reject("digest-mismatch", "brokerRoute capability digest is not the selected A1 vector");
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "brokerRoute.schemaVersion"),
    brokerOrigin,
    backendSelector: literal(row.backendSelector, "sqlite", "brokerRoute.backendSelector"),
    routeStoreInstanceId: parseA1BrokerRouteStoreInstanceId(row.routeStoreInstanceId),
    identityId: parsedIdentityId,
    collaborationServerId,
    routeKind: parsedRouteKind,
    logicalChatId,
    brokerRouteId,
    routeToken,
    brokerBackendCapabilitiesDigest: capabilitiesDigest,
  });
}

function encodeRouteParsed(value: A1BrokerRouteDescriptorV1): string {
  return `{"schemaVersion":1,"brokerOrigin":${jsonString(value.brokerOrigin)},"backendSelector":"sqlite","routeStoreInstanceId":${jsonString(value.routeStoreInstanceId)},"identityId":${jsonString(value.identityId)},"collaborationServerId":${jsonString(value.collaborationServerId)},"routeKind":${jsonString(value.routeKind)},"logicalChatId":${value.logicalChatId === null ? "null" : jsonString(value.logicalChatId)},"brokerRouteId":${jsonString(value.brokerRouteId)},"routeToken":${jsonString(value.routeToken)},"brokerBackendCapabilitiesDigest":${jsonString(value.brokerBackendCapabilitiesDigest)}}`;
}

export async function encodeA1BrokerRouteDescriptorV1(value: unknown): Promise<string> {
  return encodeRouteParsed(await parseA1BrokerRouteDescriptorV1(value));
}

export interface A1BrokerEnsureRouteReceiptV1 {
  readonly schemaVersion: 1;
  readonly disposition: "created" | "existing";
  readonly route: A1BrokerRouteDescriptorV1;
  readonly genesis: BrokerChannelGenerationRecordV1;
  readonly currentGeneration: BrokerChannelGenerationRecordV1;
  readonly observedNextFrameIndex: number;
}

const ENSURE_RECEIPT_KEYS = [
  "schemaVersion",
  "disposition",
  "route",
  "genesis",
  "currentGeneration",
  "observedNextFrameIndex",
] as const;

export async function parseA1BrokerEnsureRouteReceiptV1(
  value: unknown,
): Promise<A1BrokerEnsureRouteReceiptV1> {
  const row = exactRecord(value, ENSURE_RECEIPT_KEYS, "ensureRouteReceipt");
  // Start every nested parse before the first await so mutable caller-owned records cannot create a
  // mixed receipt while route derivation or manifest hashing is pending.
  const [route, genesis, currentGeneration] = await Promise.all([
    parseA1BrokerRouteDescriptorV1(row.route),
    parseBrokerChannelGenerationRecordV1(row.genesis),
    parseBrokerChannelGenerationRecordV1(row.currentGeneration),
  ]);
  if (genesis.brokerRouteId !== route.brokerRouteId || genesis.channelGeneration !== 0) {
    reject("route-mismatch", "ensureRouteReceipt genesis must be the route's generation zero");
  }
  if (
    currentGeneration.brokerRouteId !== route.brokerRouteId ||
    currentGeneration.state !== "open"
  ) {
    reject("route-mismatch", "ensureRouteReceipt current generation must be the route's open tip");
  }
  if (
    (genesis.state === "open" && currentGeneration.channelGeneration !== 0) ||
    (genesis.state === "sealed" && currentGeneration.channelGeneration < genesis.nextGeneration)
  ) {
    reject(
      "invalid-order",
      "ensureRouteReceipt current generation cannot precede its genesis chain",
    );
  }
  const observedNextFrameIndex = safeUint(
    row.observedNextFrameIndex,
    "ensureRouteReceipt.observedNextFrameIndex",
    A1_BROKER_GENERATION_FRAME_CAP,
  );
  const disposition = row.disposition;
  if (disposition !== "created" && disposition !== "existing") {
    reject("invalid-field", "ensureRouteReceipt.disposition must be created or existing");
  }
  if (
    disposition === "created" &&
    (genesis.state !== "open" ||
      currentGeneration.channelGeneration !== 0 ||
      observedNextFrameIndex !== 0)
  ) {
    reject("invalid-order", "a created route receipt must prove a pristine open generation zero");
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "ensureRouteReceipt.schemaVersion"),
    disposition,
    route,
    genesis,
    currentGeneration,
    observedNextFrameIndex,
  });
}

export async function encodeA1BrokerEnsureRouteReceiptV1(value: unknown): Promise<string> {
  const parsed = await parseA1BrokerEnsureRouteReceiptV1(value);
  return `{"schemaVersion":1,"disposition":${jsonString(parsed.disposition)},"route":${encodeRouteParsed(parsed.route)},"genesis":${encodeGenerationParsed(parsed.genesis)},"currentGeneration":${encodeGenerationParsed(parsed.currentGeneration)},"observedNextFrameIndex":${parsed.observedNextFrameIndex}}`;
}

export interface A1BrokerCanonicalFrameV1 {
  readonly frame: A1EncryptedFrameV2;
  readonly canonicalFrame: string;
  readonly transportFrameDigest: string;
}

/** Strict-parse, bound, canonicalize, and recompute one raw publish frame. */
export async function parseA1BrokerCanonicalFrameV1(
  raw: string | Uint8Array,
): Promise<A1BrokerCanonicalFrameV1> {
  let byteLength: number;
  if (typeof raw === "string") {
    byteLength = new TextEncoder().encode(raw).byteLength;
  } else {
    byteLength = canonicalByteSnapshot(raw).byteLength;
  }
  if (byteLength > A1_BROKER_MAX_RAW_FRAME_BYTES) {
    reject("bad-length", `raw frame exceeds ${A1_BROKER_MAX_RAW_FRAME_BYTES} bytes`);
  }
  const frame = parseA1EncryptedFrameV2(raw);
  if (frame.ct.byteLength >= A1_BROKER_CIPHERTEXT_LIMIT_BYTES) {
    reject(
      "bad-length",
      `decoded ciphertext must be shorter than ${A1_BROKER_CIPHERTEXT_LIMIT_BYTES} bytes`,
    );
  }
  if (frame.parts > A1_BROKER_MAX_PARTS) {
    reject("bad-length", `frame parts must not exceed ${A1_BROKER_MAX_PARTS}`);
  }
  const canonicalFrame = encodeA1EncryptedFrameV2(frame);
  return freeze({
    frame,
    canonicalFrame,
    transportFrameDigest: await a1TransportFrameDigest(frame),
  });
}

export interface A1BrokerPublishReceiptV1 {
  readonly schemaVersion: 1;
  readonly outcome: "inserted" | "exact_retry";
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly deliveryAttemptId: string;
  readonly part: number;
  readonly transportFrameDigest: string;
  readonly cursor: BrokerChannelCursorV1;
}

const PUBLISH_RECEIPT_KEYS = [
  "schemaVersion",
  "outcome",
  "brokerRouteId",
  "routeStoreInstanceId",
  "deliveryAttemptId",
  "part",
  "transportFrameDigest",
  "cursor",
] as const;

export function parseA1BrokerPublishReceiptV1(value: unknown): A1BrokerPublishReceiptV1 {
  const row = exactRecord(value, PUBLISH_RECEIPT_KEYS, "publishReceipt");
  if (row.outcome !== "inserted" && row.outcome !== "exact_retry") {
    reject("invalid-field", "publishReceipt.outcome must be inserted or exact_retry");
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "publishReceipt.schemaVersion"),
    outcome: row.outcome,
    brokerRouteId: canonicalId(row.brokerRouteId, "rcr_", 32, "publishReceipt.brokerRouteId"),
    routeStoreInstanceId: parseA1BrokerRouteStoreInstanceId(row.routeStoreInstanceId),
    deliveryAttemptId: canonicalId(
      row.deliveryAttemptId,
      "rda_",
      16,
      "publishReceipt.deliveryAttemptId",
    ),
    part: safeUint(row.part, "publishReceipt.part", A1_BROKER_MAX_PARTS - 1),
    transportFrameDigest: digest(row.transportFrameDigest, "publishReceipt.transportFrameDigest"),
    cursor: parseBrokerChannelCursorV1(row.cursor),
  });
}

function encodePublishParsed(value: A1BrokerPublishReceiptV1): string {
  return `{"schemaVersion":1,"outcome":${jsonString(value.outcome)},"brokerRouteId":${jsonString(value.brokerRouteId)},"routeStoreInstanceId":${jsonString(value.routeStoreInstanceId)},"deliveryAttemptId":${jsonString(value.deliveryAttemptId)},"part":${value.part},"transportFrameDigest":${jsonString(value.transportFrameDigest)},"cursor":${encodeBrokerChannelCursorV1(value.cursor)}}`;
}

export function encodeA1BrokerPublishReceiptV1(value: unknown): string {
  return encodePublishParsed(parseA1BrokerPublishReceiptV1(value));
}

export interface A1BrokerTransportCollisionV1 {
  readonly schemaVersion: 1;
  readonly code: "transport_collision";
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly deliveryAttemptId: string;
  readonly part: number;
  readonly originalCursor: BrokerChannelCursorV1;
  readonly originalTransportFrameDigest: string;
  readonly firstConflictingTransportFrameDigest: string;
  readonly conflictingTransportFrameDigest: string;
}

const COLLISION_KEYS = [
  "schemaVersion",
  "code",
  "brokerRouteId",
  "routeStoreInstanceId",
  "deliveryAttemptId",
  "part",
  "originalCursor",
  "originalTransportFrameDigest",
  "firstConflictingTransportFrameDigest",
  "conflictingTransportFrameDigest",
] as const;

export function parseA1BrokerTransportCollisionV1(value: unknown): A1BrokerTransportCollisionV1 {
  const row = exactRecord(value, COLLISION_KEYS, "transportCollision");
  const originalTransportFrameDigest = digest(
    row.originalTransportFrameDigest,
    "transportCollision.originalTransportFrameDigest",
  );
  const conflictingTransportFrameDigest = digest(
    row.conflictingTransportFrameDigest,
    "transportCollision.conflictingTransportFrameDigest",
  );
  const firstConflictingTransportFrameDigest = digest(
    row.firstConflictingTransportFrameDigest,
    "transportCollision.firstConflictingTransportFrameDigest",
  );
  if (
    originalTransportFrameDigest === firstConflictingTransportFrameDigest ||
    originalTransportFrameDigest === conflictingTransportFrameDigest
  ) {
    reject("invalid-field", "every conflicting transport digest must differ from the original");
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, "transportCollision.schemaVersion"),
    code: literal(row.code, "transport_collision", "transportCollision.code"),
    brokerRouteId: canonicalId(row.brokerRouteId, "rcr_", 32, "transportCollision.brokerRouteId"),
    routeStoreInstanceId: parseA1BrokerRouteStoreInstanceId(row.routeStoreInstanceId),
    deliveryAttemptId: canonicalId(
      row.deliveryAttemptId,
      "rda_",
      16,
      "transportCollision.deliveryAttemptId",
    ),
    part: safeUint(row.part, "transportCollision.part", A1_BROKER_MAX_PARTS - 1),
    originalCursor: parseBrokerChannelCursorV1(row.originalCursor),
    originalTransportFrameDigest,
    firstConflictingTransportFrameDigest,
    conflictingTransportFrameDigest,
  });
}

export function encodeA1BrokerTransportCollisionV1(value: unknown): string {
  const parsed = parseA1BrokerTransportCollisionV1(value);
  return `{"schemaVersion":1,"code":"transport_collision","brokerRouteId":${jsonString(parsed.brokerRouteId)},"routeStoreInstanceId":${jsonString(parsed.routeStoreInstanceId)},"deliveryAttemptId":${jsonString(parsed.deliveryAttemptId)},"part":${parsed.part},"originalCursor":${encodeBrokerChannelCursorV1(parsed.originalCursor)},"originalTransportFrameDigest":${jsonString(parsed.originalTransportFrameDigest)},"firstConflictingTransportFrameDigest":${jsonString(parsed.firstConflictingTransportFrameDigest)},"conflictingTransportFrameDigest":${jsonString(parsed.conflictingTransportFrameDigest)}}`;
}

export interface A1BrokerReadFrameV1 {
  readonly schemaVersion: 1;
  readonly cursor: BrokerChannelCursorV1;
  readonly deliveryAttemptId: string;
  readonly part: number;
  readonly transportFrameDigest: string;
  /** Exact canonical compact A1EncryptedFrameV2 JSON text. */
  readonly canonicalFrame: string;
}

const READ_FRAME_KEYS = [
  "schemaVersion",
  "cursor",
  "deliveryAttemptId",
  "part",
  "transportFrameDigest",
  "canonicalFrame",
] as const;

async function parseReadFrame(value: unknown, field: string): Promise<A1BrokerReadFrameV1> {
  const row = exactRecord(value, READ_FRAME_KEYS, field);
  const canonicalFrame = stringValue(row.canonicalFrame, `${field}.canonicalFrame`);
  const inspected = await parseA1BrokerCanonicalFrameV1(canonicalFrame);
  if (inspected.canonicalFrame !== canonicalFrame) {
    reject("invalid-field", `${field}.canonicalFrame must use the canonical compact JSON spelling`);
  }
  const deliveryAttemptId = canonicalId(
    row.deliveryAttemptId,
    "rda_",
    16,
    `${field}.deliveryAttemptId`,
  );
  const part = safeUint(row.part, `${field}.part`, A1_BROKER_MAX_PARTS - 1);
  const transportFrameDigest = digest(row.transportFrameDigest, `${field}.transportFrameDigest`);
  if (
    inspected.frame.deliveryAttemptId !== deliveryAttemptId ||
    inspected.frame.part !== part ||
    inspected.transportFrameDigest !== transportFrameDigest
  ) {
    reject("digest-mismatch", `${field} metadata does not match its canonical frame bytes`);
  }
  return freeze({
    schemaVersion: literal(row.schemaVersion, 1, `${field}.schemaVersion`),
    cursor: parseBrokerChannelCursorV1(row.cursor),
    deliveryAttemptId,
    part,
    transportFrameDigest,
    canonicalFrame,
  });
}

function encodeReadFrameParsed(value: A1BrokerReadFrameV1): string {
  return `{"schemaVersion":1,"cursor":${encodeBrokerChannelCursorV1(value.cursor)},"deliveryAttemptId":${jsonString(value.deliveryAttemptId)},"part":${value.part},"transportFrameDigest":${jsonString(value.transportFrameDigest)},"canonicalFrame":${jsonString(value.canonicalFrame)}}`;
}

export interface A1BrokerReadPageV1 {
  readonly schemaVersion: 1;
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly requestedPosition: BrokerReadPositionV1;
  readonly generation: BrokerChannelGenerationRecordV1;
  /** Exclusive generation tail sampled in the same read transaction. */
  readonly observedNextFrameIndex: number;
  readonly frames: readonly A1BrokerReadFrameV1[];
  readonly nextPosition: BrokerReadPositionV1;
  readonly atLiveTail: boolean;
}

const READ_PAGE_KEYS = [
  "schemaVersion",
  "brokerRouteId",
  "routeStoreInstanceId",
  "requestedPosition",
  "generation",
  "observedNextFrameIndex",
  "frames",
  "nextPosition",
  "atLiveTail",
] as const;

function encodeReadPageParsed(value: A1BrokerReadPageV1): string {
  return `{"schemaVersion":1,"brokerRouteId":${jsonString(value.brokerRouteId)},"routeStoreInstanceId":${jsonString(value.routeStoreInstanceId)},"requestedPosition":${encodeBrokerReadPositionV1(value.requestedPosition)},"generation":${encodeGenerationParsed(value.generation)},"observedNextFrameIndex":${value.observedNextFrameIndex},"frames":[${value.frames.map(encodeReadFrameParsed).join(",")}],"nextPosition":${encodeBrokerReadPositionV1(value.nextPosition)},"atLiveTail":${value.atLiveTail}}`;
}

export async function parseA1BrokerReadPageV1(value: unknown): Promise<A1BrokerReadPageV1> {
  const row = exactRecord(value, READ_PAGE_KEYS, "brokerReadPage");
  const brokerRouteId = canonicalId(row.brokerRouteId, "rcr_", 32, "brokerReadPage.brokerRouteId");
  const routeStoreInstanceId = parseA1BrokerRouteStoreInstanceId(row.routeStoreInstanceId);
  const requestedPosition = parseBrokerReadPositionV1(row.requestedPosition);
  const nextPosition = parseBrokerReadPositionV1(row.nextPosition);
  const observedNextFrameIndex = safeUint(
    row.observedNextFrameIndex,
    "brokerReadPage.observedNextFrameIndex",
    A1_BROKER_GENERATION_FRAME_CAP,
  );
  const rawFrames = exactArray(row.frames, "brokerReadPage.frames", A1_BROKER_MAX_READ_FRAMES);
  // As above, synchronously snapshot every nested record before any digest operation yields.
  const generationPromise = parseBrokerChannelGenerationRecordV1(row.generation);
  const framePromises = rawFrames.map((frame, index) =>
    parseReadFrame(frame, `brokerReadPage.frames[${index}]`),
  );
  const [generation, frames] = await Promise.all([generationPromise, Promise.all(framePromises)]);
  if (
    generation.brokerRouteId !== brokerRouteId ||
    generation.channelGeneration !== requestedPosition.channelGeneration
  ) {
    reject("route-mismatch", "brokerReadPage generation does not match its route/request position");
  }
  if (generation.state === "sealed" && observedNextFrameIndex !== generation.frameCount) {
    reject("invalid-order", "a sealed read page must sample its exact immutable frame count");
  }
  if (requestedPosition.nextFrameIndex > observedNextFrameIndex) {
    reject("invalid-order", "brokerReadPage requested position lies beyond its sampled tail");
  }
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame === undefined) {
      reject("invalid-record", `brokerReadPage.frames[${index}] is missing`);
    }
    if (
      frame.cursor.channelGeneration !== requestedPosition.channelGeneration ||
      frame.cursor.frameIndex !== requestedPosition.nextFrameIndex + index
    ) {
      reject(
        "invalid-order",
        "brokerReadPage frames must be contiguous in lexicographic cursor order",
      );
    }
  }
  const consumedIndex = requestedPosition.nextFrameIndex + frames.length;
  if (consumedIndex > observedNextFrameIndex) {
    reject("invalid-order", "brokerReadPage frames cross its sampled tail");
  }
  if (consumedIndex > A1_BROKER_GENERATION_FRAME_CAP) {
    reject("invalid-order", "brokerReadPage crosses the generation frame cap");
  }
  let expectedNext: BrokerReadPositionV1;
  if (generation.state === "sealed") {
    if (
      requestedPosition.nextFrameIndex > generation.frameCount ||
      consumedIndex > generation.frameCount
    ) {
      reject("invalid-order", "brokerReadPage cursor lies beyond the sealed frame count");
    }
    if (consumedIndex < generation.frameCount && frames.length === 0) {
      reject(
        "invalid-order",
        "brokerReadPage cannot omit a known sealed frame at its requested position",
      );
    }
    expectedNext =
      consumedIndex === generation.frameCount
        ? { version: 1, channelGeneration: generation.nextGeneration, nextFrameIndex: 0 }
        : {
            version: 1,
            channelGeneration: generation.channelGeneration,
            nextFrameIndex: consumedIndex,
          };
  } else {
    expectedNext = {
      version: 1,
      channelGeneration: generation.channelGeneration,
      nextFrameIndex: consumedIndex,
    };
  }
  if (consumedIndex < observedNextFrameIndex && frames.length === 0) {
    reject("invalid-order", "brokerReadPage cannot omit a known frame at its requested position");
  }
  if (
    nextPosition.channelGeneration !== expectedNext.channelGeneration ||
    nextPosition.nextFrameIndex !== expectedNext.nextFrameIndex
  ) {
    reject(
      "invalid-order",
      "brokerReadPage.nextPosition does not follow its generation and frames",
    );
  }
  const atLiveTail = literal(
    row.atLiveTail,
    generation.state === "open" && consumedIndex === observedNextFrameIndex,
    "brokerReadPage.atLiveTail",
  );
  const parsed = freeze({
    schemaVersion: literal(row.schemaVersion, 1, "brokerReadPage.schemaVersion"),
    brokerRouteId,
    routeStoreInstanceId,
    requestedPosition,
    generation,
    observedNextFrameIndex,
    frames: freeze(frames),
    nextPosition,
    atLiveTail,
  });
  return parsed;
}

export async function encodeA1BrokerReadPageV1(value: unknown): Promise<string> {
  return encodeReadPageParsed(await parseA1BrokerReadPageV1(value));
}
