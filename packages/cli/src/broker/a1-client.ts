// Browser-safe, explicitly negotiated selected-A1 broker client.
//
// This is deliberately separate from BrokerClient: it never falls back to an A0 endpoint/backend,
// never seals or opens application plaintext, and never retries an ambiguous mutation on its own.

import {
  A1_BROKER_DEFAULT_READ_FRAMES,
  A1_BROKER_GENERATION_FRAME_CAP,
  A1_BROKER_MAX_PARTS,
  A1_BROKER_MAX_RAW_FRAME_BYTES,
  A1_BROKER_MAX_READ_ENCODED_BYTES,
  A1_BROKER_MAX_READ_FRAMES,
  type A1BrokerCanonicalFrameV1,
  A1BrokerContractError,
  type A1BrokerEnsureRouteReceiptV1,
  type A1BrokerPublishReceiptV1,
  type A1BrokerReadPageV1,
  type A1BrokerRoute,
  type A1BrokerRouteDescriptorV1,
  type A1BrokerTransportCollisionV1,
  A1WireError,
  assertA1FrameMatchesRoute,
  type BrokerChannelCursorV1,
  type BrokerChannelGenerationRecordV1,
  type BrokerReadPositionV1,
  base64urlDecode,
  base64urlEncode,
  brokerBackendCapabilitiesDigest,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  deriveA1ScopeToken,
  deriveA1ServerControlToken,
  parseA1BrokerCanonicalFrameV1,
  parseA1BrokerEnsureRouteReceiptV1,
  parseA1BrokerOrigin,
  parseA1BrokerPublishReceiptV1,
  parseA1BrokerReadPageV1,
  parseA1BrokerRouteStoreInstanceId,
  parseA1BrokerTransportCollisionV1,
  parseBrokerBackendCapabilitiesV1,
  parseBrokerChannelCursorV1,
  parseBrokerChannelGenerationRecordV1,
  parseBrokerReadPositionV1,
  SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
  sha256,
  toHex,
} from "@remote-claw/clawsec";
import type { SecurityProvider } from "../security/provider.js";

const BACKEND_HEADER = "x-broker-backend";
const CAPABILITIES_DIGEST_HEADER = "x-remote-claw-a1-capabilities-digest";
const ROUTE_KIND_HEADER = "x-remote-claw-a1-route-kind";
const ROUTE_TOKEN_HEADER = "x-remote-claw-a1-route-token";
const ROUTE_STORE_HEADER = "x-remote-claw-a1-route-store-instance-id";
const CONTROL_RESPONSE_BYTES = 64 * 1024;
const READ_RESPONSE_BYTES = A1_BROKER_MAX_READ_ENCODED_BYTES;

export type A1BrokerErrorCode =
  | "invalid_request"
  | "backend_selector_required"
  | "unauthorized"
  | "route_auth_mismatch"
  | "route_not_found"
  | "route_coordinate_collision"
  | "route_store_mismatch"
  | "broker_capabilities_mismatch"
  | "generation_mismatch"
  | "frame_too_large"
  | "unsupported_media_type"
  | "invalid_read_position"
  | "a1_backend_unsupported"
  | "counter_exhausted"
  | "broker_failure";

const ERROR_CODES: ReadonlySet<string> = new Set<A1BrokerErrorCode>([
  "invalid_request",
  "backend_selector_required",
  "unauthorized",
  "route_auth_mismatch",
  "route_not_found",
  "route_coordinate_collision",
  "route_store_mismatch",
  "broker_capabilities_mismatch",
  "generation_mismatch",
  "frame_too_large",
  "unsupported_media_type",
  "invalid_read_position",
  "a1_backend_unsupported",
  "counter_exhausted",
  "broker_failure",
]);

const ERROR_STATUS: Readonly<Record<A1BrokerErrorCode, number>> = {
  invalid_request: 400,
  backend_selector_required: 400,
  unauthorized: 401,
  route_auth_mismatch: 403,
  route_not_found: 404,
  route_coordinate_collision: 409,
  route_store_mismatch: 409,
  broker_capabilities_mismatch: 409,
  generation_mismatch: 409,
  frame_too_large: 413,
  unsupported_media_type: 415,
  invalid_read_position: 416,
  a1_backend_unsupported: 501,
  counter_exhausted: 507,
  broker_failure: 500,
};

export class A1BrokerHttpError extends Error {
  readonly status: number;
  readonly code: A1BrokerErrorCode;

  constructor(status: number, code: A1BrokerErrorCode) {
    super(`A1 broker request failed (${status}/${code})`);
    this.name = "A1BrokerHttpError";
    this.status = status;
    this.code = code;
  }

  static is(error: unknown): error is A1BrokerHttpError {
    return error instanceof A1BrokerHttpError;
  }
}

/** A request whose server-side outcome is not known. Callers may retry only the exact same input. */
export class A1BrokerOutcomeUnknownError extends Error {
  constructor() {
    // Deliberately do not retain the fetch/stream error as `cause`: implementations are allowed to
    // include request headers in those errors, and the bearer must never escape through this API.
    super("A1 broker request outcome is unknown");
    this.name = "A1BrokerOutcomeUnknownError";
  }
}

export class A1BrokerProtocolError extends Error {
  constructor(message: string) {
    // Protocol failures use only caller-selected labels, never remote response text or error causes.
    super(`A1 broker response rejected: ${message}`);
    this.name = "A1BrokerProtocolError";
  }
}

export class A1BrokerTransportCollisionError extends Error {
  readonly collision: A1BrokerTransportCollisionV1;

  constructor(collision: A1BrokerTransportCollisionV1) {
    super("A1 broker rejected a changed transport retry");
    this.name = "A1BrokerTransportCollisionError";
    this.collision = collision;
  }
}

export interface A1BrokerClientOptions {
  readonly baseUrl: string;
  readonly provider: Pick<SecurityProvider, "authBearer">;
  readonly fetchFn?: typeof fetch;
  readonly protectionBypass?: string;
}

export interface OpenA1BrokerRouteOptions {
  readonly expectedRouteStoreInstanceId?: string | null;
}

export interface ReadA1BrokerRouteOptions {
  readonly position: BrokerReadPositionV1;
  readonly maxFrames?: number;
}

export interface A1BrokerRouteHandle {
  readonly descriptor: A1BrokerRouteDescriptorV1;
  readonly openReceipt: A1BrokerEnsureRouteReceiptV1;
  publish(canonicalFrame: string): Promise<A1BrokerPublishReceiptV1>;
  read(options: ReadA1BrokerRouteOptions): Promise<A1BrokerReadPageV1>;
}

/**
 * Authenticated broker evidence whose inner frame text has deliberately not been trusted yet.
 *
 * @internal This seam is for the host's future durable ingress actor. It is intentionally absent
 * from the browser-safe `@remote-claw/cli/broker` barrel until that actor owns the quarantine and
 * artifact lifecycle. Claimed metadata is broker evidence, not a statement about `rawFrame`.
 */
export interface InternalA1BrokerReadEvidenceFrameV1 {
  readonly cursor: BrokerChannelCursorV1;
  readonly deliveryAttemptId: string;
  readonly part: number;
  readonly transportFrameDigest: string;
  readonly rawFrame: string;
}

/** @internal See {@link InternalA1BrokerReadEvidenceFrameV1}. */
export interface InternalA1BrokerReadEvidencePageV1 {
  readonly schemaVersion: 1;
  readonly brokerRouteId: string;
  readonly routeStoreInstanceId: string;
  readonly requestedPosition: BrokerReadPositionV1;
  readonly generation: BrokerChannelGenerationRecordV1;
  readonly observedNextFrameIndex: number;
  readonly frames: readonly InternalA1BrokerReadEvidenceFrameV1[];
  readonly nextPosition: BrokerReadPositionV1;
  readonly atLiveTail: boolean;
}

/** @internal Closed read-only view used to capture broker evidence before inspecting a frame. */
export interface InternalA1BrokerEvidenceReader {
  read(options: ReadA1BrokerRouteOptions): Promise<InternalA1BrokerReadEvidencePageV1>;
}

export interface A1BrokerNegotiatedClient {
  readonly brokerOrigin: string;
  readonly brokerBackendCapabilitiesDigest: string;
  openRoute(route: A1BrokerRoute, options?: OpenA1BrokerRouteOptions): Promise<A1BrokerRouteHandle>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function exactRecord(value: unknown, keys: readonly string[], field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new A1BrokerProtocolError(`${field} must be an object`);
  }
  let ownKeys: readonly PropertyKey[];
  let prototype: object | null;
  try {
    ownKeys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new A1BrokerProtocolError(`${field} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new A1BrokerProtocolError(`${field} must be a plain object`);
  }
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new A1BrokerProtocolError(`${field} contains an unexpected field set`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new A1BrokerProtocolError(`${field}.${key} could not be inspected safely`);
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new A1BrokerProtocolError(`${field}.${key} must be an own data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new A1BrokerProtocolError(`${field} must be a string`);
  return value;
}

function requiredUint(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw new A1BrokerProtocolError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Decode only the small JSON grammar selected by the A1 HTTP DTOs. In addition to exact object
 * validators below, this rejects duplicate members and alternate numeric spellings before object
 * construction, and caps attacker-controlled container cardinality. */
class StrictResponseJsonParser {
  readonly #raw: string;
  readonly #field: string;
  #offset = 0;

  constructor(raw: string, field: string) {
    this.#raw = raw;
    this.#field = field;
  }

  parse(): unknown {
    if (this.#raw.charCodeAt(0) === 0xfeff) return this.#invalid();
    this.#space();
    const value = this.#value(0);
    this.#space();
    if (this.#offset !== this.#raw.length) return this.#invalid();
    return value;
  }

  #invalid(): never {
    throw new A1BrokerProtocolError(`${this.#field} must be strict JSON`);
  }

  #space(): void {
    for (;;) {
      const character = this.#raw[this.#offset];
      if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") {
        return;
      }
      this.#offset++;
    }
  }

  #value(depth: number): unknown {
    if (depth > 8) return this.#invalid();
    const character = this.#raw[this.#offset];
    if (character === "{") return this.#object(depth + 1);
    if (character === "[") return this.#array(depth + 1);
    if (character === '"') return this.#string();
    if (character !== undefined && /[0-9]/.test(character)) return this.#number();
    for (const [token, value] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (this.#raw.startsWith(token, this.#offset)) {
        this.#offset += token.length;
        return value;
      }
    }
    return this.#invalid();
  }

  #object(depth: number): JsonRecord {
    this.#offset++;
    this.#space();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    if (this.#raw[this.#offset] === "}") {
      this.#offset++;
      return result;
    }
    for (;;) {
      if (seen.size >= 32 || this.#raw[this.#offset] !== '"') return this.#invalid();
      const key = this.#string();
      if (seen.has(key)) return this.#invalid();
      seen.add(key);
      this.#space();
      if (this.#raw[this.#offset] !== ":") return this.#invalid();
      this.#offset++;
      this.#space();
      result[key] = this.#value(depth);
      this.#space();
      const next = this.#raw[this.#offset];
      if (next === "}") {
        this.#offset++;
        return result;
      }
      if (next !== ",") return this.#invalid();
      this.#offset++;
      this.#space();
      if (this.#raw[this.#offset] === "}") return this.#invalid();
    }
  }

  #array(depth: number): readonly unknown[] {
    this.#offset++;
    this.#space();
    const result: unknown[] = [];
    if (this.#raw[this.#offset] === "]") {
      this.#offset++;
      return result;
    }
    for (;;) {
      if (result.length >= A1_BROKER_MAX_READ_FRAMES) return this.#invalid();
      result.push(this.#value(depth));
      this.#space();
      const next = this.#raw[this.#offset];
      if (next === "]") {
        this.#offset++;
        return result;
      }
      if (next !== ",") return this.#invalid();
      this.#offset++;
      this.#space();
      if (this.#raw[this.#offset] === "]") return this.#invalid();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset++;
    for (;;) {
      const character = this.#raw[this.#offset];
      if (character === undefined || character.charCodeAt(0) < 0x20) return this.#invalid();
      if (character === '"') {
        this.#offset++;
        try {
          return JSON.parse(this.#raw.slice(start, this.#offset)) as string;
        } catch {
          return this.#invalid();
        }
      }
      if (character === "\\") {
        this.#offset++;
        const escaped = this.#raw[this.#offset];
        if (escaped === "u") {
          const hex = this.#raw.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return this.#invalid();
          this.#offset += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) return this.#invalid();
      }
      this.#offset++;
    }
  }

  #number(): number {
    const remainder = this.#raw.slice(this.#offset);
    const match = /^(?:0|[1-9][0-9]*)/.exec(remainder);
    if (match === null) return this.#invalid();
    const token = match[0];
    const next = remainder[token.length];
    if (next !== undefined && /[0-9.eE+-]/.test(next)) return this.#invalid();
    this.#offset += token.length;
    const value = Number(token);
    if (!Number.isSafeInteger(value)) return this.#invalid();
    return value;
  }
}

function parseJson(text: string, field: string): unknown {
  return new StrictResponseJsonParser(text, field).parse();
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new A1BrokerProtocolError("response body could not be consumed");
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response can already be closed. The deterministic byte-bound failure wins.
        }
        throw new A1BrokerProtocolError("response exceeded its byte limit");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof A1BrokerProtocolError) throw error;
    // `fetch()` can resolve once headers arrive and fail while consuming the body. For mutations,
    // that leaves the durable server-side outcome unknown, so expose the same fixed error as a
    // pre-header transport failure and never retain the implementation error as a cause.
    throw new A1BrokerOutcomeUnknownError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Nothing actionable remains after a consumed, cancelled, or failed response stream.
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new A1BrokerProtocolError("response was not well-formed UTF-8");
  }
}

async function responseError(response: Response): Promise<A1BrokerHttpError> {
  return parsedResponseError(
    response.status,
    parseJson(await readResponseText(response, 8_192), "error response"),
  );
}

function parsedResponseError(status: number, value: unknown): A1BrokerHttpError {
  const body = exactRecord(value, ["v", "error"], "error response");
  if (body.v !== 1 || typeof body.error !== "string" || !ERROR_CODES.has(body.error)) {
    throw new A1BrokerProtocolError("error response contained an unknown error code");
  }
  const code = body.error as A1BrokerErrorCode;
  if (ERROR_STATUS[code] !== status) {
    throw new A1BrokerProtocolError("error response status did not match its error code");
  }
  return new A1BrokerHttpError(status, code);
}

function discardResponse(response: Response): void {
  void response.body?.cancel().catch(() => {
    // The body may already be closed; the fixed outcome classification still wins.
  });
}

function requireMutationStatus(response: Response): "success" | "error" {
  if (
    (response.status >= 500 && response.status !== 501 && response.status !== 507) ||
    (response.status >= 200 && response.status < 300 && response.status !== 200)
  ) {
    discardResponse(response);
    throw new A1BrokerOutcomeUnknownError();
  }
  return response.status === 200 ? "success" : "error";
}

async function parseMutationSuccess<T>(
  response: Response,
  capabilityDigest: string,
  parse: () => Promise<T>,
): Promise<T> {
  try {
    assertResponseHeaders(response, capabilityDigest);
    return await parse();
  } catch (error) {
    if (error instanceof A1BrokerOutcomeUnknownError) throw error;
    // A malformed/downgraded 200 may have followed a committed mutation. Do not invite a changed
    // retry by classifying it as an ordinary protocol rejection.
    throw new A1BrokerOutcomeUnknownError();
  }
}

function requireReadSuccessStatus(response: Response): void {
  if (response.status !== 200 && response.ok) {
    throw new A1BrokerProtocolError("success response used a noncanonical status");
  }
}

function responseContract<T>(field: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (A1BrokerContractError.is(error) || A1WireError.is(error)) {
      throw new A1BrokerProtocolError(`${field} violated the selected A1 contract`);
    }
    throw error;
  }
}

async function responseContractAsync<T>(field: string, parse: () => Promise<T>): Promise<T> {
  try {
    return await parse();
  } catch (error) {
    if (A1BrokerContractError.is(error) || A1WireError.is(error)) {
      throw new A1BrokerProtocolError(`${field} violated the selected A1 contract`);
    }
    throw error;
  }
}

function generationFromHttp(
  value: unknown,
  brokerRouteId: string,
): BrokerChannelGenerationRecordV1 {
  const row = exactRecord(
    value,
    ["channel_generation", "state", "frame_count", "next_generation", "manifest_digest"],
    "generation",
  );
  return {
    schemaVersion: 1,
    brokerRouteId,
    channelGeneration: requiredUint(row.channel_generation, "generation.channel_generation"),
    state: row.state as "open" | "sealed",
    frameCount: row.frame_count as number | null,
    nextGeneration: row.next_generation as number | null,
    manifestDigest: row.manifest_digest as string | null,
  } as BrokerChannelGenerationRecordV1;
}

function cursorFromHttp(value: unknown): {
  readonly version: 1;
  readonly channelGeneration: number;
  readonly frameIndex: number;
} {
  const row = exactRecord(value, ["version", "channel_generation", "frame_index"], "cursor");
  return {
    version: row.version as 1,
    channelGeneration: requiredUint(row.channel_generation, "cursor.channel_generation"),
    frameIndex: requiredUint(row.frame_index, "cursor.frame_index"),
  };
}

function positionToHttp(position: BrokerReadPositionV1): JsonRecord {
  return {
    version: position.version,
    channel_generation: position.channelGeneration,
    next_frame_index: position.nextFrameIndex,
  };
}

function positionFromHttp(value: unknown): BrokerReadPositionV1 {
  const row = exactRecord(value, ["version", "channel_generation", "next_frame_index"], "position");
  return parseBrokerReadPositionV1({
    version: row.version,
    channelGeneration: row.channel_generation,
    nextFrameIndex: row.next_frame_index,
  });
}

function canonicalBase64urlValue(value: unknown, byteLength: number, field: string): string {
  const text = requiredString(value, field);
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(text);
  } catch {
    throw new A1BrokerProtocolError(`${field} must use canonical base64url`);
  }
  if (decoded.byteLength !== byteLength || base64urlEncode(decoded) !== text) {
    throw new A1BrokerProtocolError(`${field} must use canonical base64url`);
  }
  return text;
}

function canonicalPrefixedBase64urlValue(
  value: unknown,
  prefix: string,
  byteLength: number,
  field: string,
): string {
  const text = requiredString(value, field);
  if (!text.startsWith(prefix)) {
    throw new A1BrokerProtocolError(`${field} used the wrong namespace`);
  }
  canonicalBase64urlValue(text.slice(prefix.length), byteLength, field);
  return text;
}

async function evidencePageFromHttp(
  value: unknown,
  descriptor: A1BrokerRouteDescriptorV1,
  requestedPosition: BrokerReadPositionV1,
  maxFrames: number,
): Promise<InternalA1BrokerReadEvidencePageV1> {
  const row = exactRecord(
    value,
    [
      "v",
      "broker_route_id",
      "route_store_instance_id",
      "generation",
      "observed_next_frame_index",
      "frames",
      "next_position",
      "at_live_tail",
    ],
    "read response",
  );
  if (row.v !== 1) {
    throw new A1BrokerProtocolError("read response v must be 1");
  }
  if (
    requiredString(row.broker_route_id, "read response broker_route_id") !==
    descriptor.brokerRouteId
  ) {
    throw new A1BrokerProtocolError("read page does not match the bound route/store");
  }
  const routeStoreInstanceId = responseContract("read response", () =>
    parseA1BrokerRouteStoreInstanceId(row.route_store_instance_id),
  );
  if (routeStoreInstanceId !== descriptor.routeStoreInstanceId) {
    throw new A1BrokerProtocolError("read page does not match the bound route/store");
  }
  const generation = await responseContractAsync("read response", () =>
    parseBrokerChannelGenerationRecordV1(
      generationFromHttp(row.generation, descriptor.brokerRouteId),
    ),
  );
  if (
    generation.brokerRouteId !== descriptor.brokerRouteId ||
    generation.channelGeneration !== requestedPosition.channelGeneration
  ) {
    throw new A1BrokerProtocolError("read generation does not match its route/request position");
  }
  const observedNextFrameIndex = requiredUint(
    row.observed_next_frame_index,
    "read response observed_next_frame_index",
  );
  if (observedNextFrameIndex > A1_BROKER_GENERATION_FRAME_CAP) {
    throw new A1BrokerProtocolError("read response observed tail exceeded the generation cap");
  }
  if (!Array.isArray(row.frames)) {
    throw new A1BrokerProtocolError("read response frames must be an array");
  }
  if (row.frames.length > maxFrames || row.frames.length > A1_BROKER_MAX_READ_FRAMES) {
    throw new A1BrokerProtocolError("read response exceeded the requested frame count");
  }
  const frames = row.frames.map((value, index): InternalA1BrokerReadEvidenceFrameV1 => {
    const frame = exactRecord(
      value,
      ["cursor", "delivery_attempt_id", "part", "transport_frame_digest", "frame"],
      `read response frames[${index}]`,
    );
    const cursor = responseContract("read response", () =>
      parseBrokerChannelCursorV1(cursorFromHttp(frame.cursor)),
    );
    if (
      cursor.channelGeneration !== requestedPosition.channelGeneration ||
      cursor.frameIndex !== requestedPosition.nextFrameIndex + index
    ) {
      throw new A1BrokerProtocolError("read response frames must carry contiguous exact cursors");
    }
    const part = requiredUint(frame.part, `read response frames[${index}].part`);
    if (part >= A1_BROKER_MAX_PARTS) {
      throw new A1BrokerProtocolError(
        `read response frames[${index}].part exceeded the selected A1 bound`,
      );
    }
    const rawFrame = requiredString(frame.frame, `read response frames[${index}].frame`);
    if (new TextEncoder().encode(rawFrame).byteLength > A1_BROKER_MAX_RAW_FRAME_BYTES) {
      throw new A1BrokerProtocolError(
        `read response frames[${index}].frame exceeded the selected A1 raw-frame bound`,
      );
    }
    return Object.freeze({
      cursor,
      deliveryAttemptId: canonicalPrefixedBase64urlValue(
        frame.delivery_attempt_id,
        "rda_",
        16,
        `read response frames[${index}].delivery_attempt_id`,
      ),
      part,
      transportFrameDigest: canonicalBase64urlValue(
        frame.transport_frame_digest,
        32,
        `read response frames[${index}].transport_frame_digest`,
      ),
      rawFrame,
    });
  });
  if (requestedPosition.nextFrameIndex > observedNextFrameIndex) {
    throw new A1BrokerProtocolError("read request position lies beyond the sampled tail");
  }
  const consumedIndex = requestedPosition.nextFrameIndex + frames.length;
  if (consumedIndex > observedNextFrameIndex || consumedIndex > A1_BROKER_GENERATION_FRAME_CAP) {
    throw new A1BrokerProtocolError("read response frames cross the sampled generation tail");
  }
  if (generation.state === "sealed" && observedNextFrameIndex !== generation.frameCount) {
    throw new A1BrokerProtocolError("sealed read sampled a tail other than its frame count");
  }
  let expectedNextPosition: BrokerReadPositionV1;
  if (generation.state === "sealed") {
    if (
      requestedPosition.nextFrameIndex > generation.frameCount ||
      consumedIndex > generation.frameCount
    ) {
      throw new A1BrokerProtocolError("read cursor lies beyond the sealed frame count");
    }
    if (consumedIndex < generation.frameCount && frames.length === 0) {
      throw new A1BrokerProtocolError("read response omitted a known sealed frame");
    }
    expectedNextPosition =
      consumedIndex === generation.frameCount
        ? Object.freeze({
            version: 1,
            channelGeneration: generation.nextGeneration,
            nextFrameIndex: 0,
          })
        : Object.freeze({
            version: 1,
            channelGeneration: generation.channelGeneration,
            nextFrameIndex: consumedIndex,
          });
  } else {
    expectedNextPosition = Object.freeze({
      version: 1,
      channelGeneration: generation.channelGeneration,
      nextFrameIndex: consumedIndex,
    });
  }
  if (consumedIndex < observedNextFrameIndex && frames.length === 0) {
    throw new A1BrokerProtocolError("read response omitted a known frame");
  }
  const nextPosition = responseContract("read response", () => positionFromHttp(row.next_position));
  if (
    nextPosition.channelGeneration !== expectedNextPosition.channelGeneration ||
    nextPosition.nextFrameIndex !== expectedNextPosition.nextFrameIndex
  ) {
    throw new A1BrokerProtocolError("read response next_position does not follow its frames");
  }
  const expectedLiveTail = generation.state === "open" && consumedIndex === observedNextFrameIndex;
  if (row.at_live_tail !== expectedLiveTail) {
    throw new A1BrokerProtocolError("read response at_live_tail did not match its sampled tail");
  }
  return Object.freeze({
    schemaVersion: 1,
    brokerRouteId: descriptor.brokerRouteId,
    routeStoreInstanceId,
    requestedPosition,
    generation,
    observedNextFrameIndex,
    frames: Object.freeze(frames),
    nextPosition,
    atLiveTail: expectedLiveTail,
  });
}

function routeSnapshot(route: A1BrokerRoute): A1BrokerRoute {
  return route.routeKind === "chat"
    ? {
        routeKind: "chat",
        identityId: new Uint8Array(route.identityId),
        collaborationServerId: route.collaborationServerId,
        logicalChatId: route.logicalChatId,
      }
    : {
        routeKind: route.routeKind,
        identityId: new Uint8Array(route.identityId),
        collaborationServerId: route.collaborationServerId,
        logicalChatId: null,
      };
}

async function routeToken(route: A1BrokerRoute): Promise<string> {
  if (route.routeKind === "scope_bus") {
    return deriveA1ScopeToken(route.identityId, route.collaborationServerId);
  }
  if (route.routeKind === "server_control") {
    return deriveA1ServerControlToken(route.identityId, route.collaborationServerId);
  }
  if (route.logicalChatId === null) {
    throw new A1BrokerProtocolError("chat route must carry a logical chat ID");
  }
  return deriveA1ChatToken(route.identityId, route.collaborationServerId, route.logicalChatId);
}

interface RequestAuthority {
  headers(includeCapability: boolean): Promise<Record<string, string>>;
  request(url: string, init: RequestInit): Promise<Response>;
}

class BoundRequestAuthority implements RequestAuthority {
  readonly #provider: Pick<SecurityProvider, "authBearer">;
  readonly #fetch: typeof fetch;
  readonly #protectionBypass: string | undefined;
  readonly #capabilityDigest: string | undefined;
  readonly #identityId: string | undefined;

  constructor(
    provider: Pick<SecurityProvider, "authBearer">,
    fetchFn: typeof fetch,
    protectionBypass: string | undefined,
    capabilityDigest?: string,
    identityId?: string,
  ) {
    this.#provider = provider;
    this.#fetch = fetchFn;
    this.#protectionBypass = protectionBypass;
    this.#capabilityDigest = capabilityDigest;
    this.#identityId = identityId;
  }

  async authHeader(): Promise<string> {
    let supplied: Uint8Array;
    try {
      supplied = this.#provider.authBearer();
    } catch {
      throw new A1BrokerProtocolError("bearer provider failed");
    }
    if (!(supplied instanceof Uint8Array)) {
      throw new A1BrokerProtocolError("bearer provider returned an invalid value");
    }
    // The public provider seam does not promise caller-owned storage. Snapshot it and scrub only
    // our private copy so a custom provider's retained credential is never mutated.
    const token = new Uint8Array(supplied);
    try {
      if (token.byteLength !== 32) {
        throw new A1BrokerProtocolError("bearer must contain exactly 32 bytes");
      }
      if (
        this.#identityId !== undefined &&
        toHex((await sha256(token)).slice(0, 16)) !== this.#identityId
      ) {
        throw new A1BrokerProtocolError("bearer identity changed after negotiation");
      }
      return `Bearer ${toHex(token)}`;
    } finally {
      token.fill(0);
    }
  }

  async headers(includeCapability: boolean): Promise<Record<string, string>> {
    return {
      authorization: await this.authHeader(),
      [BACKEND_HEADER]: "sqlite",
      "cache-control": "no-store",
      ...(includeCapability && this.#capabilityDigest !== undefined
        ? { [CAPABILITIES_DIGEST_HEADER]: this.#capabilityDigest }
        : {}),
      ...(this.#protectionBypass === undefined
        ? {}
        : { "x-vercel-protection-bypass": this.#protectionBypass }),
    };
  }

  async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, { ...init, redirect: "error", cache: "no-store" });
    } catch {
      throw new A1BrokerOutcomeUnknownError();
    }
  }
}

function assertResponseHeaders(response: Response, capabilityDigest: string): void {
  if (response.headers.get(CAPABILITIES_DIGEST_HEADER) !== capabilityDigest) {
    throw new A1BrokerProtocolError("capability digest response header changed");
  }
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (!cacheControl.split(",").some((value) => value.trim() === "no-store")) {
    throw new A1BrokerProtocolError("response was not marked no-store");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes(",") || contentType.split(";", 1)[0]?.trim() !== "application/json") {
    throw new A1BrokerProtocolError("response was not JSON");
  }
}

class BoundA1BrokerRoute implements A1BrokerRouteHandle {
  readonly descriptor: A1BrokerRouteDescriptorV1;
  readonly openReceipt: A1BrokerEnsureRouteReceiptV1;
  readonly #origin: string;
  readonly #authority: RequestAuthority;
  readonly #capabilityDigest: string;
  readonly #route: A1BrokerRoute;

  constructor(
    origin: string,
    authority: RequestAuthority,
    capabilityDigest: string,
    route: A1BrokerRoute,
    receipt: A1BrokerEnsureRouteReceiptV1,
  ) {
    this.#origin = origin;
    this.#authority = authority;
    this.#capabilityDigest = capabilityDigest;
    this.#route = routeSnapshot(route);
    this.descriptor = receipt.route;
    this.openReceipt = receipt;
  }

  async publish(canonicalFrame: string): Promise<A1BrokerPublishReceiptV1> {
    const inspected = await parseA1BrokerCanonicalFrameV1(canonicalFrame);
    if (inspected.canonicalFrame !== canonicalFrame) {
      throw new A1BrokerProtocolError("publish input must use canonical compact A1 JSON");
    }
    assertA1FrameMatchesRoute(inspected.frame, this.#route);
    const response = await this.#authority.request(`${this.#origin}/api/a1/relay`, {
      method: "POST",
      headers: {
        ...(await this.#authority.headers(true)),
        "content-type": "application/json",
        [ROUTE_KIND_HEADER]: this.descriptor.routeKind,
        [ROUTE_TOKEN_HEADER]: this.descriptor.routeToken,
        [ROUTE_STORE_HEADER]: this.descriptor.routeStoreInstanceId,
      },
      body: canonicalFrame,
    });
    const statusKind = requireMutationStatus(response);
    if (statusKind === "success") {
      return parseMutationSuccess(response, this.#capabilityDigest, async () => {
        const row = exactRecord(
          parseJson(await readResponseText(response, CONTROL_RESPONSE_BYTES), "publish response"),
          [
            "v",
            "disposition",
            "broker_route_id",
            "route_store_instance_id",
            "cursor",
            "transport_frame_digest",
          ],
          "publish response",
        );
        const receipt = responseContract("publish response", () =>
          parseA1BrokerPublishReceiptV1({
            schemaVersion: row.v,
            outcome: row.disposition,
            brokerRouteId: row.broker_route_id,
            routeStoreInstanceId: row.route_store_instance_id,
            deliveryAttemptId: inspected.frame.deliveryAttemptId,
            part: inspected.frame.part,
            transportFrameDigest: row.transport_frame_digest,
            cursor: cursorFromHttp(row.cursor),
          }),
        );
        if (
          receipt.brokerRouteId !== this.descriptor.brokerRouteId ||
          receipt.routeStoreInstanceId !== this.descriptor.routeStoreInstanceId ||
          receipt.transportFrameDigest !== inspected.transportFrameDigest
        ) {
          throw new A1BrokerProtocolError("publish receipt does not match the exact request");
        }
        return receipt;
      });
    }
    assertResponseHeaders(response, this.#capabilityDigest);
    if (response.status === 409) {
      const raw = parseJson(
        await readResponseText(response, CONTROL_RESPONSE_BYTES),
        "transport collision",
      );
      if (
        typeof raw === "object" &&
        raw !== null &&
        (raw as { error?: unknown }).error === "transport_collision"
      ) {
        const row = exactRecord(
          raw,
          [
            "v",
            "error",
            "broker_route_id",
            "route_store_instance_id",
            "delivery_attempt_id",
            "part",
            "original_cursor",
            "original_transport_frame_digest",
            "first_conflicting_transport_frame_digest",
            "conflicting_transport_frame_digest",
          ],
          "transport collision",
        );
        const collision = responseContract("transport collision", () =>
          parseA1BrokerTransportCollisionV1({
            schemaVersion: row.v,
            code: row.error,
            brokerRouteId: row.broker_route_id,
            routeStoreInstanceId: row.route_store_instance_id,
            deliveryAttemptId: row.delivery_attempt_id,
            part: row.part,
            originalCursor: cursorFromHttp(row.original_cursor),
            originalTransportFrameDigest: row.original_transport_frame_digest,
            firstConflictingTransportFrameDigest: row.first_conflicting_transport_frame_digest,
            conflictingTransportFrameDigest: row.conflicting_transport_frame_digest,
          }),
        );
        if (
          collision.brokerRouteId !== this.descriptor.brokerRouteId ||
          collision.routeStoreInstanceId !== this.descriptor.routeStoreInstanceId ||
          collision.deliveryAttemptId !== inspected.frame.deliveryAttemptId ||
          collision.part !== inspected.frame.part ||
          collision.conflictingTransportFrameDigest !== inspected.transportFrameDigest
        ) {
          throw new A1BrokerProtocolError("collision response does not match the publish request");
        }
        throw new A1BrokerTransportCollisionError(collision);
      }
      throw parsedResponseError(response.status, raw);
    }
    throw await responseError(response);
  }

  async readEvidence(
    options: ReadA1BrokerRouteOptions,
  ): Promise<InternalA1BrokerReadEvidencePageV1> {
    const position = parseBrokerReadPositionV1(options.position);
    const maxFrames = options.maxFrames ?? A1_BROKER_DEFAULT_READ_FRAMES;
    if (
      !Number.isSafeInteger(maxFrames) ||
      maxFrames < 1 ||
      maxFrames > A1_BROKER_MAX_READ_FRAMES
    ) {
      throw new A1BrokerProtocolError(
        `maxFrames must be between 1 and ${A1_BROKER_MAX_READ_FRAMES}`,
      );
    }
    const response = await this.#authority.request(`${this.#origin}/api/a1/subscribe`, {
      method: "POST",
      headers: {
        ...(await this.#authority.headers(true)),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        v: 1,
        identity_id: this.descriptor.identityId,
        collaboration_server_id: this.descriptor.collaborationServerId,
        route_kind: this.descriptor.routeKind,
        logical_chat_id: this.descriptor.logicalChatId,
        route_token: this.descriptor.routeToken,
        expected_route_store_instance_id: this.descriptor.routeStoreInstanceId,
        position: positionToHttp(position),
        max_frames: maxFrames,
      }),
    });
    assertResponseHeaders(response, this.#capabilityDigest);
    requireReadSuccessStatus(response);
    if (response.status !== 200) throw await responseError(response);
    return evidencePageFromHttp(
      parseJson(await readResponseText(response, READ_RESPONSE_BYTES), "read response"),
      this.descriptor,
      position,
      maxFrames,
    );
  }

  async read(options: ReadA1BrokerRouteOptions): Promise<A1BrokerReadPageV1> {
    const evidence = await this.readEvidence(options);
    const page = await responseContractAsync("read response", () =>
      parseA1BrokerReadPageV1({
        schemaVersion: evidence.schemaVersion,
        brokerRouteId: evidence.brokerRouteId,
        routeStoreInstanceId: evidence.routeStoreInstanceId,
        requestedPosition: evidence.requestedPosition,
        generation: evidence.generation,
        observedNextFrameIndex: evidence.observedNextFrameIndex,
        frames: evidence.frames.map((frame) => ({
          schemaVersion: 1,
          cursor: frame.cursor,
          deliveryAttemptId: frame.deliveryAttemptId,
          part: frame.part,
          transportFrameDigest: frame.transportFrameDigest,
          canonicalFrame: frame.rawFrame,
        })),
        nextPosition: evidence.nextPosition,
        atLiveTail: evidence.atLiveTail,
      }),
    );
    if (
      page.brokerRouteId !== this.descriptor.brokerRouteId ||
      page.routeStoreInstanceId !== this.descriptor.routeStoreInstanceId
    ) {
      throw new A1BrokerProtocolError("read page does not match the bound route/store");
    }
    for (const frame of page.frames) {
      await responseContractAsync("read frame", async () => {
        const inspected: A1BrokerCanonicalFrameV1 = await parseA1BrokerCanonicalFrameV1(
          frame.canonicalFrame,
        );
        assertA1FrameMatchesRoute(inspected.frame, this.#route);
        return undefined;
      });
    }
    return page;
  }
}

/**
 * Obtain the closed, read-only evidence seam for a handle created by this client.
 *
 * @internal Deliberately not re-exported from `@remote-claw/cli/broker`.
 */
export function internalA1BrokerEvidenceReader(
  handle: A1BrokerRouteHandle,
): InternalA1BrokerEvidenceReader {
  if (!(handle instanceof BoundA1BrokerRoute)) {
    throw new A1BrokerProtocolError("evidence reader requires a bound selected-A1 route handle");
  }
  return Object.freeze({
    read: (options: ReadA1BrokerRouteOptions) => handle.readEvidence(options),
  });
}

class BoundA1BrokerNegotiatedClient implements A1BrokerNegotiatedClient {
  readonly brokerOrigin: string;
  readonly brokerBackendCapabilitiesDigest: string;
  readonly #authority: RequestAuthority;
  readonly #identityId: string;

  constructor(
    brokerOrigin: string,
    authority: RequestAuthority,
    capabilityDigest: string,
    identityId: string,
  ) {
    this.brokerOrigin = brokerOrigin;
    this.#authority = authority;
    this.brokerBackendCapabilitiesDigest = capabilityDigest;
    this.#identityId = identityId;
  }

  async openRoute(
    rawRoute: A1BrokerRoute,
    options: OpenA1BrokerRouteOptions = {},
  ): Promise<A1BrokerRouteHandle> {
    const route = routeSnapshot(rawRoute);
    if (toHex(route.identityId) !== this.#identityId) {
      throw new A1BrokerProtocolError("route identity does not match the negotiated bearer");
    }
    const brokerRouteId = await deriveA1BrokerRouteId(route);
    const expectedToken = await routeToken(route);
    const expectedStore =
      options.expectedRouteStoreInstanceId === null ||
      options.expectedRouteStoreInstanceId === undefined
        ? null
        : parseA1BrokerRouteStoreInstanceId(options.expectedRouteStoreInstanceId);
    const response = await this.#authority.request(`${this.brokerOrigin}/api/a1/route/open`, {
      method: "POST",
      headers: {
        ...(await this.#authority.headers(true)),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        v: 1,
        identity_id: this.#identityId,
        collaboration_server_id: route.collaborationServerId,
        route_kind: route.routeKind,
        logical_chat_id: route.logicalChatId,
        route_token: expectedToken,
        expected_route_store_instance_id: expectedStore,
      }),
    });
    if (requireMutationStatus(response) === "error") {
      assertResponseHeaders(response, this.brokerBackendCapabilitiesDigest);
      throw await responseError(response);
    }
    return parseMutationSuccess(response, this.brokerBackendCapabilitiesDigest, async () => {
      const row = exactRecord(
        parseJson(await readResponseText(response, CONTROL_RESPONSE_BYTES), "route-open response"),
        [
          "v",
          "disposition",
          "broker_route_id",
          "route_store_instance_id",
          "broker_backend_capabilities_digest",
          "genesis",
          "current_generation",
          "observed_next_frame_index",
        ],
        "route-open response",
      );
      const routeStoreInstanceId = responseContract("route-open response", () =>
        parseA1BrokerRouteStoreInstanceId(row.route_store_instance_id),
      );
      const descriptor: A1BrokerRouteDescriptorV1 = {
        schemaVersion: 1,
        brokerOrigin: this.brokerOrigin,
        backendSelector: "sqlite",
        routeStoreInstanceId,
        identityId: this.#identityId,
        collaborationServerId: route.collaborationServerId,
        routeKind: route.routeKind,
        logicalChatId: route.logicalChatId,
        brokerRouteId: requiredString(row.broker_route_id, "route-open broker_route_id"),
        routeToken: expectedToken,
        brokerBackendCapabilitiesDigest: requiredString(
          row.broker_backend_capabilities_digest,
          "route-open capabilities digest",
        ),
      };
      const receipt = await responseContractAsync("route-open response", () =>
        parseA1BrokerEnsureRouteReceiptV1({
          schemaVersion: row.v,
          disposition: row.disposition,
          route: descriptor,
          genesis: generationFromHttp(row.genesis, brokerRouteId),
          currentGeneration: generationFromHttp(row.current_generation, brokerRouteId),
          observedNextFrameIndex: row.observed_next_frame_index,
        }),
      );
      if (
        receipt.route.brokerRouteId !== brokerRouteId ||
        receipt.route.routeToken !== expectedToken ||
        receipt.route.brokerBackendCapabilitiesDigest !== this.brokerBackendCapabilitiesDigest ||
        (expectedStore !== null && receipt.route.routeStoreInstanceId !== expectedStore)
      ) {
        throw new A1BrokerProtocolError(
          "route-open receipt changed the requested route/provider pin",
        );
      }
      return new BoundA1BrokerRoute(
        this.brokerOrigin,
        this.#authority,
        this.brokerBackendCapabilitiesDigest,
        route,
        receipt,
      );
    });
  }
}

export class A1BrokerClient {
  readonly #origin: string;
  readonly #provider: Pick<SecurityProvider, "authBearer">;
  readonly #fetch: typeof fetch;
  readonly #protectionBypass: string | undefined;

  constructor(options: A1BrokerClientOptions) {
    this.#origin = parseA1BrokerOrigin(options.baseUrl);
    this.#provider = options.provider;
    this.#fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.#protectionBypass = options.protectionBypass;
  }

  async negotiate(): Promise<A1BrokerNegotiatedClient> {
    const capabilityDigest = await brokerBackendCapabilitiesDigest(
      SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
    );
    let suppliedBearer: Uint8Array;
    try {
      suppliedBearer = this.#provider.authBearer();
    } catch {
      throw new A1BrokerProtocolError("bearer provider failed");
    }
    if (!(suppliedBearer instanceof Uint8Array)) {
      throw new A1BrokerProtocolError("bearer provider returned an invalid value");
    }
    const bearer = new Uint8Array(suppliedBearer);
    let identityId: string;
    try {
      if (bearer.byteLength !== 32) {
        throw new A1BrokerProtocolError("bearer must contain exactly 32 bytes");
      }
      identityId = toHex((await sha256(bearer)).slice(0, 16));
    } finally {
      bearer.fill(0);
    }
    const preAuthority = new BoundRequestAuthority(
      this.#provider,
      this.#fetch,
      this.#protectionBypass,
      undefined,
      identityId,
    );
    const response = await preAuthority.request(`${this.#origin}/api/a1/capabilities`, {
      method: "GET",
      headers: {
        ...(await preAuthority.headers(false)),
        accept: "application/json",
      },
    });
    assertResponseHeaders(response, capabilityDigest);
    requireReadSuccessStatus(response);
    if (response.status !== 200) throw await responseError(response);
    const capabilities = await responseContractAsync("capabilities response", async () =>
      parseBrokerBackendCapabilitiesV1(
        parseJson(
          await readResponseText(response, CONTROL_RESPONSE_BYTES),
          "capabilities response",
        ),
      ),
    );
    if ((await brokerBackendCapabilitiesDigest(capabilities)) !== capabilityDigest) {
      throw new A1BrokerProtocolError("broker capabilities changed during negotiation");
    }
    const authority = new BoundRequestAuthority(
      this.#provider,
      this.#fetch,
      this.#protectionBypass,
      capabilityDigest,
      identityId,
    );
    return new BoundA1BrokerNegotiatedClient(this.#origin, authority, capabilityDigest, identityId);
  }
}
