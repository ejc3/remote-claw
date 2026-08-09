import { base64urlDecode, base64urlEncode } from "@remote-claw/clawsec";

export const RUNTIME_OWNER_RPC_VERSION = 1 as const;
export const RUNTIME_OWNER_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const RUNTIME_OWNER_RPC_MAX_IN_FLIGHT = 32;
export const RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION = 4_096;
export const RUNTIME_OWNER_RPC_MAX_CONNECTIONS = 64;
export const RUNTIME_OWNER_RPC_MAX_PREAUTH_BYTES = 1_024;
export const RUNTIME_OWNER_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const MAX_JSON_DEPTH = 64;
const MAX_BUFFERED_BYTES =
  (RUNTIME_OWNER_RPC_MAX_FRAME_BYTES + 4) * RUNTIME_OWNER_RPC_MAX_IN_FLIGHT;
const REQUEST_ID_BYTES = 16;
const AUTH_VALUE_BYTES = 32;
const OPERATION = /^[a-z][a-z0-9_.:-]{0,127}$/;

export type RuntimeOwnerRpcJsonPrimitive = string | number | boolean | null;
export type RuntimeOwnerRpcJsonValue =
  | RuntimeOwnerRpcJsonPrimitive
  | readonly RuntimeOwnerRpcJsonValue[]
  | { readonly [key: string]: RuntimeOwnerRpcJsonValue };

export const RUNTIME_OWNER_RPC_ERROR_MESSAGES = Object.freeze({
  AUTHENTICATION_FAILED: "authentication failed",
  CLOSED: "connection closed",
  HANDLER_ERROR: "runtime owner operation failed",
  PROTOCOL_ERROR: "protocol error",
  TIMEOUT: "operation timed out",
  TOO_MANY_IN_FLIGHT: "too many operations in flight",
  UNAVAILABLE: "runtime owner unavailable",
} as const);

export type RuntimeOwnerRpcErrorCode = keyof typeof RUNTIME_OWNER_RPC_ERROR_MESSAGES;

export class RuntimeOwnerRpcError extends Error {
  readonly code: RuntimeOwnerRpcErrorCode;

  constructor(code: RuntimeOwnerRpcErrorCode, options?: ErrorOptions) {
    super(RUNTIME_OWNER_RPC_ERROR_MESSAGES[code], options);
    this.name = "RuntimeOwnerRpcError";
    this.code = code;
  }
}

export interface RuntimeOwnerRpcChallenge {
  readonly version: typeof RUNTIME_OWNER_RPC_VERSION;
  readonly type: "challenge";
  readonly challenge: string;
  readonly serverProof: string;
}

export interface RuntimeOwnerRpcAuthentication {
  readonly version: typeof RUNTIME_OWNER_RPC_VERSION;
  readonly type: "authenticate";
  readonly challenge: string;
  readonly clientProof: string;
}

export interface RuntimeOwnerRpcAuthenticated {
  readonly version: typeof RUNTIME_OWNER_RPC_VERSION;
  readonly type: "authenticated";
  readonly challenge: string;
}

export interface RuntimeOwnerRpcDispatchRequest {
  readonly operation: string;
  readonly payload: RuntimeOwnerRpcJsonValue;
}

export type RuntimeOwnerRpcRequest =
  | Readonly<{
      version: typeof RUNTIME_OWNER_RPC_VERSION;
      type: "request";
      requestId: string;
      method: "health";
      params: null;
    }>
  | Readonly<{
      version: typeof RUNTIME_OWNER_RPC_VERSION;
      type: "request";
      requestId: string;
      method: "dispatch";
      params: RuntimeOwnerRpcDispatchRequest;
    }>;

export interface RuntimeOwnerRpcResponseError {
  readonly code: RuntimeOwnerRpcErrorCode;
  readonly message: string;
}

export type RuntimeOwnerRpcResponse =
  | Readonly<{
      version: typeof RUNTIME_OWNER_RPC_VERSION;
      type: "response";
      requestId: string;
      ok: true;
      result: RuntimeOwnerRpcJsonValue;
      error: null;
    }>
  | Readonly<{
      version: typeof RUNTIME_OWNER_RPC_VERSION;
      type: "response";
      requestId: string;
      ok: false;
      result: null;
      error: RuntimeOwnerRpcResponseError;
    }>;

type UnknownRecord = Record<string, unknown>;

function protocolError(): never {
  throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) protocolError();
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) protocolError();
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      protocolError();
    }
  }
}

function canonicalJsonText(value: unknown, depth: number, ancestors: Set<object>): string {
  if (depth > MAX_JSON_DEPTH) protocolError();
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) protocolError();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") protocolError();
  if (ancestors.has(value)) protocolError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJsonText(item, depth + 1, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) protocolError();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) protocolError();
    const keys = (ownKeys as string[]).sort();
    const entries: string[] = [];
    for (const key of keys) {
      assertUnicodeScalarString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) protocolError();
      entries.push(
        `${JSON.stringify(key)}:${canonicalJsonText(descriptor.value, depth + 1, ancestors)}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function encodeRuntimeOwnerRpcCanonicalJson(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(canonicalJsonText(value, 0, new Set<object>()));
  } catch (error) {
    if (error instanceof RuntimeOwnerRpcError) throw error;
    protocolError();
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function decodeRuntimeOwnerRpcCanonicalJson(bytes: Uint8Array): RuntimeOwnerRpcJsonValue {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    protocolError();
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    protocolError();
  }
  const canonical = encodeRuntimeOwnerRpcCanonicalJson(value);
  if (!bytesEqual(bytes, canonical)) protocolError();
  return value as RuntimeOwnerRpcJsonValue;
}

export function encodeRuntimeOwnerRpcFrame(value: unknown): Buffer {
  const payload = encodeRuntimeOwnerRpcCanonicalJson(value);
  if (payload.length === 0 || payload.length > RUNTIME_OWNER_RPC_MAX_FRAME_BYTES) protocolError();
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.set(payload, 4);
  return frame;
}

export class RuntimeOwnerRpcFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): RuntimeOwnerRpcJsonValue[] {
    if (!(chunk instanceof Uint8Array)) protocolError();
    if (chunk.length === 0) return [];
    if (this.#buffer.length + chunk.length > MAX_BUFFERED_BYTES) protocolError();
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const values: RuntimeOwnerRpcJsonValue[] = [];
    let offset = 0;
    while (this.#buffer.length - offset >= 4) {
      const length = this.#buffer.readUInt32BE(offset);
      if (length === 0 || length > RUNTIME_OWNER_RPC_MAX_FRAME_BYTES) protocolError();
      if (this.#buffer.length - offset - 4 < length) break;
      const payload = this.#buffer.subarray(offset + 4, offset + 4 + length);
      values.push(decodeRuntimeOwnerRpcCanonicalJson(payload));
      offset += 4 + length;
    }
    if (offset > 0) this.#buffer = Buffer.from(this.#buffer.subarray(offset));
    return values;
  }

  end(): void {
    if (this.#buffer.length !== 0) protocolError();
  }
}

function exactRecord(value: unknown, keys: readonly string[]): UnknownRecord {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) protocolError();
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) protocolError();
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      protocolError();
    }
    const result = Object.create(null) as UnknownRecord;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) protocolError();
      result[key] = descriptor.value as unknown;
    }
    return result;
  } catch (error) {
    if (error instanceof RuntimeOwnerRpcError) throw error;
    protocolError();
  }
}

function literal<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) protocolError();
  return expected;
}

function canonicalBase64url(value: unknown, byteLength: number): string {
  if (typeof value !== "string" || value.length !== Math.ceil((byteLength * 4) / 3)) {
    protocolError();
  }
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value);
  } catch {
    protocolError();
  }
  if (decoded.length !== byteLength || base64urlEncode(decoded) !== value) protocolError();
  return value;
}

function parseRequestId(value: unknown): string {
  return canonicalBase64url(value, REQUEST_ID_BYTES);
}

function parseAuthValue(value: unknown): string {
  return canonicalBase64url(value, AUTH_VALUE_BYTES);
}

function parseDispatchRequest(value: unknown): RuntimeOwnerRpcDispatchRequest {
  const row = exactRecord(value, ["operation", "payload"]);
  if (typeof row.operation !== "string" || !OPERATION.test(row.operation)) protocolError();
  // Canonical re-encoding is also the recursive JSON-value validator.
  encodeRuntimeOwnerRpcCanonicalJson(row.payload);
  return Object.freeze({
    operation: row.operation,
    payload: row.payload as RuntimeOwnerRpcJsonValue,
  });
}

export function parseRuntimeOwnerRpcChallenge(value: unknown): RuntimeOwnerRpcChallenge {
  const row = exactRecord(value, ["challenge", "serverProof", "type", "version"]);
  return Object.freeze({
    version: literal(row.version, RUNTIME_OWNER_RPC_VERSION),
    type: literal(row.type, "challenge"),
    challenge: parseAuthValue(row.challenge),
    serverProof: parseAuthValue(row.serverProof),
  });
}

export function parseRuntimeOwnerRpcAuthentication(value: unknown): RuntimeOwnerRpcAuthentication {
  const row = exactRecord(value, ["challenge", "clientProof", "type", "version"]);
  return Object.freeze({
    version: literal(row.version, RUNTIME_OWNER_RPC_VERSION),
    type: literal(row.type, "authenticate"),
    challenge: parseAuthValue(row.challenge),
    clientProof: parseAuthValue(row.clientProof),
  });
}

export function parseRuntimeOwnerRpcAuthenticated(value: unknown): RuntimeOwnerRpcAuthenticated {
  const row = exactRecord(value, ["challenge", "type", "version"]);
  return Object.freeze({
    version: literal(row.version, RUNTIME_OWNER_RPC_VERSION),
    type: literal(row.type, "authenticated"),
    challenge: parseAuthValue(row.challenge),
  });
}

export function parseRuntimeOwnerRpcRequest(value: unknown): RuntimeOwnerRpcRequest {
  const row = exactRecord(value, ["method", "params", "requestId", "type", "version"]);
  const version = literal(row.version, RUNTIME_OWNER_RPC_VERSION);
  const type = literal(row.type, "request");
  const requestId = parseRequestId(row.requestId);
  if (row.method === "health") {
    if (row.params !== null) protocolError();
    return Object.freeze({ version, type, requestId, method: "health", params: null });
  }
  if (row.method === "dispatch") {
    return Object.freeze({
      version,
      type,
      requestId,
      method: "dispatch",
      params: parseDispatchRequest(row.params),
    });
  }
  protocolError();
}

function parseError(value: unknown): RuntimeOwnerRpcResponseError {
  const row = exactRecord(value, ["code", "message"]);
  if (typeof row.code !== "string" || !Object.hasOwn(RUNTIME_OWNER_RPC_ERROR_MESSAGES, row.code)) {
    protocolError();
  }
  const code = row.code as RuntimeOwnerRpcErrorCode;
  if (row.message !== RUNTIME_OWNER_RPC_ERROR_MESSAGES[code]) protocolError();
  return Object.freeze({ code, message: RUNTIME_OWNER_RPC_ERROR_MESSAGES[code] });
}

export function parseRuntimeOwnerRpcResponse(value: unknown): RuntimeOwnerRpcResponse {
  const row = exactRecord(value, ["error", "ok", "requestId", "result", "type", "version"]);
  const version = literal(row.version, RUNTIME_OWNER_RPC_VERSION);
  const type = literal(row.type, "response");
  const requestId = parseRequestId(row.requestId);
  if (row.ok === true) {
    if (row.error !== null) protocolError();
    encodeRuntimeOwnerRpcCanonicalJson(row.result);
    return Object.freeze({
      version,
      type,
      requestId,
      ok: true,
      result: row.result as RuntimeOwnerRpcJsonValue,
      error: null,
    });
  }
  if (row.ok === false) {
    if (row.result !== null) protocolError();
    return Object.freeze({
      version,
      type,
      requestId,
      ok: false,
      result: null,
      error: parseError(row.error),
    });
  }
  protocolError();
}

export function runtimeOwnerRpcErrorResponse(
  requestId: string,
  code: RuntimeOwnerRpcErrorCode,
): RuntimeOwnerRpcResponse {
  return Object.freeze({
    version: RUNTIME_OWNER_RPC_VERSION,
    type: "response",
    requestId: parseRequestId(requestId),
    ok: false,
    result: null,
    error: Object.freeze({ code, message: RUNTIME_OWNER_RPC_ERROR_MESSAGES[code] }),
  });
}

export function runtimeOwnerRpcSuccessResponse(
  requestId: string,
  result: RuntimeOwnerRpcJsonValue,
): RuntimeOwnerRpcResponse {
  encodeRuntimeOwnerRpcCanonicalJson(result);
  return Object.freeze({
    version: RUNTIME_OWNER_RPC_VERSION,
    type: "response",
    requestId: parseRequestId(requestId),
    ok: true,
    result,
    error: null,
  });
}
