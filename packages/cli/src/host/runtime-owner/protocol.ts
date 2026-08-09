import { base64urlDecode, base64urlEncode } from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  type NativeBindingId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "../state/ids.js";
import {
  type InvokePortRequest,
  type InvokePortResult,
  type ProtectedCoordinatorFence,
  type ProtectedHandleRef,
  type ProviderCredentialUse,
  parseProtectedHandleRef,
  parseProtectedOperationScope,
} from "../state/protected.js";
import { parseNonEmptyString, parsePositiveSafeInteger } from "../state/validation.js";

export const RUNTIME_OWNER_RPC_VERSION = 1 as const;
export const RUNTIME_OWNER_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const RUNTIME_OWNER_RPC_MAX_IN_FLIGHT = 32;
export const RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION = 4_096;
export const RUNTIME_OWNER_RPC_MAX_CONNECTIONS = 64;
export const RUNTIME_OWNER_RPC_MAX_PREAUTH_BYTES = 1_024;
export const RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION = 64;
export const RUNTIME_OWNER_RPC_MAX_REVERSE_IN_FLIGHT = 32;
export const RUNTIME_OWNER_RPC_MAX_REVERSE_REQUESTS_PER_CONNECTION = 4_096;
export const RUNTIME_OWNER_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const MAX_JSON_DEPTH = 64;
const MAX_BUFFERED_BYTES =
  (RUNTIME_OWNER_RPC_MAX_FRAME_BYTES + 4) * RUNTIME_OWNER_RPC_MAX_IN_FLIGHT;
const REQUEST_ID_BYTES = 16;
const AUTH_VALUE_BYTES = 32;
const REVERSE_REQUEST_ID_PREFIX = "rcrq_";
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

/**
 * A reverse invocation carries the complete durable tuple used to authorize one protected port.
 * `connectionId` is deliberately repeated on the wire: a response from a channel other than the
 * registry-selected authenticated connection can never be mistaken for the intended port.
 */
export interface RuntimeOwnerRpcPortInvocation {
  readonly connectionId: string;
  readonly ownerFence: RuntimeOwnerRpcOwnerFence;
  readonly nativeIncarnation: number;
  readonly attachmentLeaseId: A1SafeId;
  readonly portGeneration: number;
  readonly request: InvokePortRequest<"native_binding">;
}

/** Structural copy of the owner fence keeps the wire layer independent of persistence modules. */
export interface RuntimeOwnerRpcOwnerFence {
  readonly runtimeOwnerServiceLeaseId: A1SafeId;
  readonly runtimeOwnerServiceEpoch: number;
  readonly ownerInstanceId: A1SafeId;
  readonly ownerProcessStartIdentitySchemaId: string;
  readonly ownerProcessStartIdentityRef: A1SafeId;
  readonly ownerProcessStartIdentityDigest: A1Digest;
}

export type RuntimeOwnerRpcCallablePortRef = ProtectedHandleRef<"callable_port">;

export type RuntimeOwnerRpcPortResult = InvokePortResult<"native_binding">;

export interface RuntimeOwnerRpcPortRequest {
  readonly version: typeof RUNTIME_OWNER_RPC_VERSION;
  readonly type: "port_request";
  readonly reverseRequestId: string;
  readonly invocation: RuntimeOwnerRpcPortInvocation;
}

export type RuntimeOwnerRpcPortResponse =
  | Readonly<{
      version: typeof RUNTIME_OWNER_RPC_VERSION;
      type: "port_response";
      reverseRequestId: string;
      ok: true;
      result: RuntimeOwnerRpcPortResult;
      error: null;
    }>
  | Readonly<{
      version: typeof RUNTIME_OWNER_RPC_VERSION;
      type: "port_response";
      reverseRequestId: string;
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

function parseConnectionId(value: unknown): string {
  return canonicalBase64url(value, REQUEST_ID_BYTES);
}

export function parseRuntimeOwnerRpcReverseRequestId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(REVERSE_REQUEST_ID_PREFIX)) {
    protocolError();
  }
  canonicalBase64url(value.slice(REVERSE_REQUEST_ID_PREFIX.length), REQUEST_ID_BYTES);
  return value;
}

export function runtimeOwnerRpcReverseRequestId(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== REQUEST_ID_BYTES) protocolError();
  return `${REVERSE_REQUEST_ID_PREFIX}${base64urlEncode(bytes)}`;
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

export function parseRuntimeOwnerRpcCallablePortRef(
  value: unknown,
): RuntimeOwnerRpcCallablePortRef {
  try {
    const ref = parseProtectedHandleRef(value);
    if (ref.kind !== "callable_port") protocolError();
    return ref;
  } catch (error) {
    if (error instanceof RuntimeOwnerRpcError) throw error;
    protocolError();
  }
}

function parseProviderCredential(value: unknown): ProviderCredentialUse | null {
  if (value === null) return null;
  const row = exactRecord(value, ["connectorId", "credentialPurpose", "providerCredentialRef"]);
  const providerCredentialRef = parseProtectedHandleRef(row.providerCredentialRef);
  if (providerCredentialRef.kind !== "provider_credential") protocolError();
  return Object.freeze({
    providerCredentialRef,
    connectorId: parseA1SafeId(row.connectorId, "invokePort.providerCredential.connectorId"),
    credentialPurpose: parseA1SafeId(
      row.credentialPurpose,
      "invokePort.providerCredential.credentialPurpose",
    ),
  });
}

function parseCoordinatorFence(value: unknown): ProtectedCoordinatorFence {
  const row = exactRecord(value, [
    "collaborationServerId",
    "coordinatorEpoch",
    "coordinatorLeaseId",
  ]);
  return Object.freeze({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "invokePort.fence.collaborationServerId",
    ),
    coordinatorLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "invokePort.fence.coordinatorLeaseId",
    ),
    coordinatorEpoch: parsePositiveSafeInteger(
      row.coordinatorEpoch,
      "invokePort.fence.coordinatorEpoch",
    ),
  });
}

export function parseRuntimeOwnerRpcOwnerFence(value: unknown): RuntimeOwnerRpcOwnerFence {
  const row = exactRecord(value, [
    "ownerInstanceId",
    "ownerProcessStartIdentityDigest",
    "ownerProcessStartIdentityRef",
    "ownerProcessStartIdentitySchemaId",
    "runtimeOwnerServiceEpoch",
    "runtimeOwnerServiceLeaseId",
  ]);
  return Object.freeze({
    runtimeOwnerServiceLeaseId: parseA1SafeId(
      row.runtimeOwnerServiceLeaseId,
      "portInvocation.ownerFence.runtimeOwnerServiceLeaseId",
    ),
    runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
      row.runtimeOwnerServiceEpoch,
      "portInvocation.ownerFence.runtimeOwnerServiceEpoch",
    ),
    ownerInstanceId: parseA1SafeId(
      row.ownerInstanceId,
      "portInvocation.ownerFence.ownerInstanceId",
    ),
    ownerProcessStartIdentitySchemaId: parseNonEmptyString(
      row.ownerProcessStartIdentitySchemaId,
      "portInvocation.ownerFence.ownerProcessStartIdentitySchemaId",
    ),
    ownerProcessStartIdentityRef: parseA1SafeId(
      row.ownerProcessStartIdentityRef,
      "portInvocation.ownerFence.ownerProcessStartIdentityRef",
    ),
    ownerProcessStartIdentityDigest: parseA1Digest(
      row.ownerProcessStartIdentityDigest,
      "portInvocation.ownerFence.ownerProcessStartIdentityDigest",
    ),
  });
}

function parseNativeBindingScope(
  scopeKind: unknown,
  scopeId: unknown,
): Readonly<{ scopeKind: "native_binding"; scopeId: NativeBindingId }> {
  const scope = parseProtectedOperationScope(scopeKind, scopeId);
  if (scope.scopeKind !== "native_binding") protocolError();
  return scope;
}

export function parseRuntimeOwnerInvokePortRequest(
  value: unknown,
): InvokePortRequest<"native_binding"> {
  try {
    const row = exactRecord(value, [
      "callablePortRef",
      "fence",
      "nativeBindingId",
      "operationDigest",
      "operationRef",
      "operationSchemaId",
      "providerCredential",
      "runtimeId",
      "scopeId",
      "scopeKind",
    ]);
    const scope = parseNativeBindingScope(row.scopeKind, row.scopeId);
    const nativeBindingId = parseA1CanonicalId(
      "nativeBinding",
      row.nativeBindingId,
      "invokePort.nativeBindingId",
    );
    if (scope.scopeId !== nativeBindingId) protocolError();
    return Object.freeze({
      ...scope,
      callablePortRef: parseRuntimeOwnerRpcCallablePortRef(row.callablePortRef),
      providerCredential: parseProviderCredential(row.providerCredential),
      nativeBindingId,
      runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId, "invokePort.runtimeId"),
      fence: parseCoordinatorFence(row.fence),
      operationSchemaId: parseNonEmptyString(row.operationSchemaId, "invokePort.operationSchemaId"),
      operationRef: parseA1SafeId(row.operationRef, "invokePort.operationRef"),
      operationDigest: parseA1Digest(row.operationDigest, "invokePort.operationDigest"),
    });
  } catch (error) {
    if (error instanceof RuntimeOwnerRpcError) throw error;
    protocolError();
  }
}

export function parseRuntimeOwnerInvokePortResult(
  value: unknown,
): InvokePortResult<"native_binding"> {
  try {
    const row = exactRecord(value, [
      "callablePortRef",
      "fence",
      "nativeBindingId",
      "operationDigest",
      "operationRef",
      "operationSchemaId",
      "providerCredential",
      "resultDigest",
      "resultRef",
      "resultSchemaId",
      "runtimeId",
      "scopeId",
      "scopeKind",
    ]);
    const request = parseRuntimeOwnerInvokePortRequest({
      scopeKind: row.scopeKind,
      scopeId: row.scopeId,
      callablePortRef: row.callablePortRef,
      providerCredential: row.providerCredential,
      nativeBindingId: row.nativeBindingId,
      runtimeId: row.runtimeId,
      fence: row.fence,
      operationSchemaId: row.operationSchemaId,
      operationRef: row.operationRef,
      operationDigest: row.operationDigest,
    });
    return Object.freeze({
      ...request,
      resultSchemaId: parseNonEmptyString(row.resultSchemaId, "invokePort.resultSchemaId"),
      resultRef: parseA1SafeId(row.resultRef, "invokePort.resultRef"),
      resultDigest: parseA1Digest(row.resultDigest, "invokePort.resultDigest"),
    });
  } catch (error) {
    if (error instanceof RuntimeOwnerRpcError) throw error;
    protocolError();
  }
}

export function parseRuntimeOwnerRpcPortInvocation(value: unknown): RuntimeOwnerRpcPortInvocation {
  try {
    const row = exactRecord(value, [
      "attachmentLeaseId",
      "connectionId",
      "nativeIncarnation",
      "ownerFence",
      "portGeneration",
      "request",
    ]);
    return Object.freeze({
      connectionId: parseConnectionId(row.connectionId),
      ownerFence: parseRuntimeOwnerRpcOwnerFence(row.ownerFence),
      nativeIncarnation: parsePositiveSafeInteger(
        row.nativeIncarnation,
        "portInvocation.nativeIncarnation",
      ),
      attachmentLeaseId: parseA1SafeId(row.attachmentLeaseId, "portInvocation.attachmentLeaseId"),
      portGeneration: parsePositiveSafeInteger(row.portGeneration, "portInvocation.portGeneration"),
      request: parseRuntimeOwnerInvokePortRequest(row.request),
    });
  } catch (error) {
    if (error instanceof RuntimeOwnerRpcError) throw error;
    protocolError();
  }
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

export function parseRuntimeOwnerRpcPortRequest(value: unknown): RuntimeOwnerRpcPortRequest {
  const row = exactRecord(value, ["invocation", "reverseRequestId", "type", "version"]);
  return Object.freeze({
    version: literal(row.version, RUNTIME_OWNER_RPC_VERSION),
    type: literal(row.type, "port_request"),
    reverseRequestId: parseRuntimeOwnerRpcReverseRequestId(row.reverseRequestId),
    invocation: parseRuntimeOwnerRpcPortInvocation(row.invocation),
  });
}

export function parseRuntimeOwnerRpcPortResponse(value: unknown): RuntimeOwnerRpcPortResponse {
  const row = exactRecord(value, ["error", "ok", "result", "reverseRequestId", "type", "version"]);
  const version = literal(row.version, RUNTIME_OWNER_RPC_VERSION);
  const type = literal(row.type, "port_response");
  const reverseRequestId = parseRuntimeOwnerRpcReverseRequestId(row.reverseRequestId);
  if (row.ok === true) {
    if (row.error !== null) protocolError();
    return Object.freeze({
      version,
      type,
      reverseRequestId,
      ok: true,
      result: parseRuntimeOwnerInvokePortResult(row.result),
      error: null,
    });
  }
  if (row.ok === false) {
    if (row.result !== null) protocolError();
    return Object.freeze({
      version,
      type,
      reverseRequestId,
      ok: false,
      result: null,
      error: parseError(row.error),
    });
  }
  protocolError();
}

/** Read only the discriminant; the selected exact parser still validates the complete message. */
export function runtimeOwnerRpcMessageType(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) protocolError();
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) protocolError();
  if (typeof descriptor.value !== "string") protocolError();
  return descriptor.value;
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

export function runtimeOwnerRpcPortErrorResponse(
  reverseRequestId: string,
  code: RuntimeOwnerRpcErrorCode,
): RuntimeOwnerRpcPortResponse {
  return Object.freeze({
    version: RUNTIME_OWNER_RPC_VERSION,
    type: "port_response",
    reverseRequestId: parseRuntimeOwnerRpcReverseRequestId(reverseRequestId),
    ok: false,
    result: null,
    error: Object.freeze({ code, message: RUNTIME_OWNER_RPC_ERROR_MESSAGES[code] }),
  });
}

export function runtimeOwnerRpcPortSuccessResponse(
  reverseRequestId: string,
  result: RuntimeOwnerRpcPortResult,
): RuntimeOwnerRpcPortResponse {
  return Object.freeze({
    version: RUNTIME_OWNER_RPC_VERSION,
    type: "port_response",
    reverseRequestId: parseRuntimeOwnerRpcReverseRequestId(reverseRequestId),
    ok: true,
    result: parseRuntimeOwnerInvokePortResult(result),
    error: null,
  });
}
