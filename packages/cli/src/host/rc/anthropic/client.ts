import { ClaudeOAuthFileCredentialSource } from "./credentials.js";
import { AnthropicRcError } from "./errors.js";
import {
  type AnthropicRcTransport,
  OAuthAnthropicRcTransport,
  type RcOAuthProvider,
} from "./transport.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SSE_FRAME_CHARS = 1024 * 1024;
const MAX_EVENT_METADATA_CHARS = 512;
const MAX_USER_CONTENT_CHARS = 100_000;
const DECIMAL_SEQUENCE = /^\d+$/;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;

export type RcSequenceNum = string;

export interface RcSessionSummary {
  id: string;
  title: string;
  status: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface RcSessionPage {
  data: readonly RcSessionSummary[];
  nextCursor: string | null;
  resumeToken: string | null;
}

export interface AnthropicRcEvent {
  eventId: string;
  eventType: string;
  sequenceNum: RcSequenceNum;
  source: "client" | "worker";
  createdAt: string;
  payload: Readonly<Record<string, unknown>>;
  raw: Readonly<Record<string, unknown>>;
}

export interface RcEventPage {
  data: readonly AnthropicRcEvent[];
  nextCursor: string | null;
}

export interface RcUserEventInput {
  /** Caller-generated correlation/idempotency key. The client never substitutes or regenerates it. */
  uuid: string;
  /** Caller-stable timestamp so an intentional retry can reuse the exact logical event. */
  timestamp: string;
  message: {
    role: "user";
    content: string;
  };
  parentToolUseId: string | null;
}

export interface RcPostAck {
  /** Anthropic's canonical event identity; this may differ from the submitted UUID. */
  eventId: string;
  sequenceNum: RcSequenceNum;
  duplicate: boolean;
}

interface RcSseItemBase {
  /** Preserved for diagnostics/protocol evolution, but not interpreted as a reconnect contract. */
  eventName: string | null;
  /** Preserved for diagnostics/protocol evolution; never sent as Last-Event-ID. */
  sseId: string | null;
  /** Parsed JSON payload exactly as carried by the SSE data fields. */
  data: unknown;
}

/** A direct canonical event envelope observed on an unnamed or `client_event` SSE record. */
export interface RcSseEventItem extends RcSseItemBase {
  kind: "event";
  event: AnthropicRcEvent;
  data: Readonly<Record<string, unknown>>;
}

/**
 * Any other data-bearing SSE record. The live endpoint carries protocol-evolution and ephemeral
 * record types in addition to canonical history events; callers must preserve these until a proven
 * projector policy exists.
 */
export interface RcSseFrameItem extends RcSseItemBase {
  kind: "frame";
}

export type RcSseItem = RcSseEventItem | RcSseFrameItem;

export interface RcRequestOptions {
  signal?: AbortSignal;
}

export interface RcListOptions extends RcRequestOptions {
  cursor?: string;
  limit?: number;
}

export interface RcHistoryOptions extends RcListOptions {
  sortOrder?: "asc" | "desc";
}

export interface AnthropicRcClientOptions {
  /** Optional auth seam. The default is the secure Linux reader for native Claude's credential file. */
  oauth?: RcOAuthProvider;
  /** Test/projector seam. Production callers normally supply `oauth` instead. */
  transport?: AnthropicRcTransport;
  /** Injectable only as part of the fixed-origin production transport. */
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

/**
 * Typed client-side access to Anthropic's native Remote Control log. Each streamEvents call opens one
 * independent app/client connection; there is deliberately no lease or process-wide single-reader
 * guard. Reconnect and history reconciliation belong to the projector that owns publication order.
 */
export class AnthropicRcClient {
  readonly #transport: AnthropicRcTransport;
  readonly #requestTimeoutMs: number;

  constructor(options: AnthropicRcClientOptions = {}) {
    if (
      options.transport !== undefined &&
      (options.oauth !== undefined || options.fetchFn !== undefined)
    ) {
      throw new TypeError("provide transport or oauth/fetchFn, not both");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new TypeError(
        `requestTimeoutMs must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#transport =
      options.transport ??
      new OAuthAnthropicRcTransport({
        oauth: options.oauth ?? new ClaudeOAuthFileCredentialSource(),
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      });
  }

  async listSessions(options: RcListOptions = {}): Promise<RcSessionPage> {
    const operation = "listSessions";
    const query = pageQuery(options);
    const raw = await this.#json(operation, "GET", `/v1/code/sessions${query}`, options.signal);
    const page = expectRecord(raw, operation, "page");
    if (!Array.isArray(page.data))
      throw AnthropicRcError.protocol(operation, "data is not an array");
    return {
      data: page.data.map((item, index) => parseSession(item, operation, index)),
      nextCursor: optionalNullableString(page.next_cursor, operation, "next_cursor"),
      resumeToken: optionalNullableString(page.resume_token, operation, "resume_token"),
    };
  }

  async history(sessionId: string, options: RcHistoryOptions = {}): Promise<RcEventPage> {
    const operation = "history";
    const encodedSession = encodeSessionId(sessionId, operation);
    const query = historyQuery(options);
    const raw = await this.#json(
      operation,
      "GET",
      `/v1/code/sessions/${encodedSession}/events${query}`,
      options.signal,
    );
    const page = expectRecord(raw, operation, "page");
    if (!Array.isArray(page.data))
      throw AnthropicRcError.protocol(operation, "data is not an array");
    return {
      data: page.data.map((item, index) => parseEvent(item, operation, `data[${index}]`)),
      nextCursor: optionalNullableString(page.next_cursor, operation, "next_cursor"),
    };
  }

  /**
   * Open exactly one client-side SSE connection. EOF ends the generator; it does not reconnect and
   * sends no unverified cursor or Last-Event-ID. Multiple calls may run concurrently. The tracked spike
   * proves live JSON data on this endpoint but retained no sanitized exact frame fixture. Direct
   * history-shaped data on unnamed or `client_event` records is promoted to a typed event; every other
   * JSON record is preserved as an opaque frame rather than guessed, skipped, or treated as fatal.
   */
  async *streamEvents(
    sessionId: string,
    options: { signal: AbortSignal },
  ): AsyncGenerator<RcSseItem> {
    const operation = "streamEvents";
    const encodedSession = encodeSessionId(sessionId, operation);
    let response: Response;
    try {
      response = await this.#transport.request({
        operation,
        method: "GET",
        path: `/v1/code/sessions/${encodedSession}/events/stream`,
        accept: "text/event-stream",
        signal: options.signal,
      });
    } catch (error) {
      if (signalWasAborted(options.signal) || isAbortError(error)) {
        throw safeAbortError(error, options.signal);
      }
      if (AnthropicRcError.is(error)) {
        throw AnthropicRcError.sanitized(error, operation);
      }
      throw AnthropicRcError.network(operation);
    }
    const inspected = inspectResponse(response, operation, "GET", options.signal);
    if (!inspected.ok) {
      cancelResponseBody(inspected.body);
      throw AnthropicRcError.http(operation, inspected.status);
    }
    if (inspected.body === null) throw AnthropicRcError.protocol(operation, "missing SSE body");
    let mediaType: string | undefined;
    try {
      mediaType = responseHeader(
        inspected.headers,
        "content-type",
        operation,
        "GET",
        options.signal,
      )
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
    } catch (error) {
      cancelResponseBody(inspected.body);
      throw error;
    }
    if (mediaType !== "text/event-stream") {
      cancelResponseBody(inspected.body);
      throw AnthropicRcError.protocol(operation, "response is not text/event-stream");
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = responseReader(inspected.body, operation, "GET", options.signal);
    } catch (error) {
      cancelResponseBody(inspected.body);
      throw error;
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let input = "";
    let frameLines: string[] = [];
    let frameChars = 0;
    let reachedEof = false;
    try {
      for (;;) {
        throwIfAborted(options.signal);
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await readWithSignal(reader, options.signal);
        } catch (error) {
          if (signalWasAborted(options.signal) || isAbortError(error)) {
            throw safeAbortError(error, options.signal);
          }
          throw AnthropicRcError.network(operation);
        }
        if (chunk.done) {
          reachedEof = true;
          // A final decoder flush catches a truncated UTF-8 codepoint without publishing a partial frame.
          try {
            input += decoder.decode();
          } catch {
            throw AnthropicRcError.protocol(operation, "invalid UTF-8 in SSE stream");
          }
          // A trailing CR is a complete SSE line ending. During chunking we defer it in case the next
          // byte is LF; at EOF there is no next byte, so make it parseable as the equivalent CRLF.
          if (input.endsWith("\r")) input += "\n";
        } else {
          try {
            input += decoder.decode(chunk.value, { stream: true });
          } catch {
            throw AnthropicRcError.protocol(operation, "invalid UTF-8 in SSE stream");
          }
        }

        for (;;) {
          const lineEnd = nextLineEnd(input);
          if (lineEnd === null) break;
          const line = input.slice(0, lineEnd.index);
          input = input.slice(lineEnd.index + lineEnd.width);
          if (line === "") {
            if (frameLines.length > 0) {
              const item = parseSseFrame(frameLines, operation);
              if (item !== null) {
                throwIfAborted(options.signal);
                yield item;
                // The consumer can abort while the generator is suspended at `yield`. Do not publish a
                // second event already buffered in this network chunk after it resumes.
                throwIfAborted(options.signal);
              }
              frameLines = [];
              frameChars = 0;
            }
            continue;
          }
          frameChars += line.length + 1;
          if (frameChars > MAX_SSE_FRAME_CHARS) {
            throw AnthropicRcError.protocol(operation, "SSE frame exceeds size limit");
          }
          frameLines.push(line);
        }
        // Check the one unfinished frame only after draining complete frames. A single network chunk may
        // legitimately contain many individually bounded events.
        if (input.length + frameChars > MAX_SSE_FRAME_CHARS) {
          throw AnthropicRcError.protocol(operation, "SSE frame exceeds size limit");
        }
        if (chunk.done) return;
      }
    } finally {
      if (!reachedEof) cancelResponseReader(reader);
      releaseResponseReader(reader);
    }
  }

  async postEvent(
    sessionId: string,
    event: RcUserEventInput,
    options: RcRequestOptions = {},
  ): Promise<RcPostAck> {
    const operation = "postEvent";
    const encodedSession = encodeSessionId(sessionId, operation);
    const validatedEvent = validateUserEvent(event, operation);
    const body = JSON.stringify({
      events: [
        {
          payload: {
            type: "user",
            message: {
              role: "user",
              content: validatedEvent.message.content,
            },
            uuid: validatedEvent.uuid,
            session_id: sessionId,
            timestamp: validatedEvent.timestamp,
            parent_tool_use_id: validatedEvent.parentToolUseId,
          },
        },
      ],
    });
    const raw = await this.#json(
      operation,
      "POST",
      `/v1/code/sessions/${encodedSession}/events`,
      options.signal,
      body,
    );
    const response = expectRecord(raw, operation, "response", true);
    if (!Array.isArray(response.results) || response.results.length !== 1) {
      throw AnthropicRcError.protocol(
        operation,
        "results must contain exactly one acknowledgement",
        { outcomeUnknown: true },
      );
    }
    const ack = expectRecord(response.results[0], operation, "results[0]", true);
    if (typeof ack.duplicate !== "boolean") {
      throw AnthropicRcError.protocol(operation, "results[0].duplicate is not boolean", {
        outcomeUnknown: true,
      });
    }
    return {
      duplicate: ack.duplicate,
      eventId: requiredString(ack.event_id, operation, "results[0].event_id", true),
      sequenceNum: sequenceNum(ack.sequence_num, operation, "results[0].sequence_num", true),
    };
  }

  async #json(
    operation: string,
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal | undefined,
    body?: string,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    // An already-cancelled operation has definitely not crossed the injected transport boundary.
    throwIfAborted(requestSignal);
    let response: Response;
    try {
      response = await this.#transport.request({
        operation,
        method,
        path,
        accept: "application/json",
        ...(body === undefined ? {} : { body }),
        signal: requestSignal,
      });
    } catch (error) {
      if (signalWasAborted(requestSignal) || isAbortError(error)) {
        if (method === "POST") {
          // Once an arbitrary transport has been invoked, only that transport can know whether bytes
          // crossed the network. Treat a raw write cancellation conservatively rather than inviting a
          // replay. The built-in transport supplies the same metadata at its fetch boundary.
          throw AnthropicRcError.aborted(operation, abortName(error, requestSignal), true);
        }
        throw safeAbortError(error, requestSignal);
      }
      if (AnthropicRcError.is(error)) {
        throw AnthropicRcError.sanitized(error, operation, { write: method === "POST" });
      }
      throw AnthropicRcError.network(operation, {
        retryable: method === "GET",
        outcomeUnknown: method === "POST",
      });
    }
    const inspected = inspectResponse(response, operation, method, requestSignal);
    if (!inspected.ok) {
      cancelResponseBody(inspected.body);
      throw AnthropicRcError.http(operation, inspected.status, { write: method === "POST" });
    }
    return readBoundedJson(inspected, operation, requestSignal, method);
  }
}

function pageQuery(options: RcListOptions): string {
  const params = new URLSearchParams();
  addPageParams(params, options);
  const value = params.toString();
  return value === "" ? "" : `?${value}`;
}

function historyQuery(options: RcHistoryOptions): string {
  const params = new URLSearchParams();
  params.set("sort_order", options.sortOrder ?? "asc");
  addPageParams(params, options);
  return `?${params.toString()}`;
}

function addPageParams(params: URLSearchParams, options: RcListOptions): void {
  if (options.cursor !== undefined) {
    if (options.cursor === "") throw new TypeError("cursor must not be empty");
    params.set("cursor", options.cursor);
  }
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new TypeError("limit must be a positive safe integer");
    }
    params.set("limit", String(options.limit));
  }
}

function encodeSessionId(sessionId: string, operation: string): string {
  if (sessionId === "" || sessionId.length > 512 || hasControlCharacter(sessionId)) {
    throw AnthropicRcError.protocol(operation, "invalid session id");
  }
  return encodeURIComponent(sessionId);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseSession(value: unknown, operation: string, index: number): RcSessionSummary {
  const raw = expectRecord(value, operation, `data[${index}]`);
  return {
    id: requiredString(raw.id, operation, `data[${index}].id`),
    title: requiredString(raw.title, operation, `data[${index}].title`),
    status: requiredString(raw.status, operation, `data[${index}].status`),
    raw,
  };
}

function parseEvent(value: unknown, operation: string, field: string): AnthropicRcEvent {
  const raw = expectRecord(value, operation, field);
  const source = raw.source;
  if (source !== "client" && source !== "worker") {
    throw AnthropicRcError.protocol(operation, `${field}.source is not client or worker`);
  }
  return {
    eventId: requiredString(raw.event_id, operation, `${field}.event_id`),
    eventType: requiredString(raw.event_type, operation, `${field}.event_type`),
    sequenceNum: sequenceNum(raw.sequence_num, operation, `${field}.sequence_num`),
    source,
    createdAt: requiredString(raw.created_at, operation, `${field}.created_at`),
    payload: expectRecord(raw.payload, operation, `${field}.payload`),
    raw,
  };
}

function parseSseFrame(lines: readonly string[], operation: string): RcSseItem | null {
  const data: string[] = [];
  let eventName: string | null = null;
  let sseId: string | null = null;
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventName = value;
    else if (field === "id" && !value.includes("\0")) sseId = value;
  }
  // Per SSE, any record with an empty data buffer is ignored. This covers comments, `event:` heartbeat
  // records, and `id:`/`retry:` metadata without inventing an RC event.
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n")) as unknown;
  } catch {
    throw AnthropicRcError.protocol(operation, "SSE data is not valid JSON");
  }
  if ((eventName === null || eventName === "client_event") && isCanonicalEventEnvelope(parsed)) {
    return {
      kind: "event",
      event: parseEvent(parsed, operation, "SSE data"),
      eventName,
      sseId,
      data: parsed,
    };
  }
  return {
    kind: "frame",
    eventName,
    sseId,
    data: parsed,
  };
}

function isCanonicalEventEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  return (
    typeof value.event_id === "string" &&
    value.event_id !== "" &&
    typeof value.event_type === "string" &&
    value.event_type !== "" &&
    typeof value.sequence_num === "string" &&
    DECIMAL_SEQUENCE.test(value.sequence_num) &&
    (value.source === "client" || value.source === "worker") &&
    typeof value.created_at === "string" &&
    value.created_at !== ""
  );
}

function nextLineEnd(input: string): { index: number; width: number } | null {
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "\n") return { index, width: 1 };
    if (char === "\r") {
      // Preserve a CR at the end of a chunk until we know whether the following chunk begins with LF.
      if (index === input.length - 1) return null;
      return { index, width: input[index + 1] === "\n" ? 2 : 1 };
    }
  }
  return null;
}

interface InspectedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Snapshot the parts of an injected Response that callers use. All property access happens inside
 * this boundary because a test/projector transport can return a locked, proxied, or monkey-patched
 * object whose accessors throw arbitrary secret-bearing errors.
 */
function inspectResponse(
  response: Response,
  operation: string,
  method: "GET" | "POST",
  signal: AbortSignal,
): InspectedResponse {
  let intrinsicBodyForCleanup: ReadableStream<Uint8Array> | null = null;
  let exposedBodyForCleanup: ReadableStream<Uint8Array> | null = null;
  try {
    if (!(response instanceof Response)) throw new TypeError("invalid Response object");
    // Recover the branded Response's actual body before touching any monkey-patched own accessor so
    // that a hidden/throwing replacement cannot prevent cleanup of the live stream.
    const intrinsicBody: unknown = Reflect.get(Response.prototype, "body", response);
    if (intrinsicBody !== null && !(intrinsicBody instanceof ReadableStream)) {
      throw new TypeError("invalid intrinsic Response body");
    }
    intrinsicBodyForCleanup = intrinsicBody;
    const exposedBody: unknown = response.body;
    if (exposedBody !== null && !(exposedBody instanceof ReadableStream)) {
      throw new TypeError("invalid Response body");
    }
    exposedBodyForCleanup = exposedBody;
    if (exposedBody !== intrinsicBody) throw new TypeError("inconsistent Response body");
    const intrinsicOk: unknown = Reflect.get(Response.prototype, "ok", response);
    const intrinsicStatus: unknown = Reflect.get(Response.prototype, "status", response);
    const intrinsicHeaders: unknown = Reflect.get(Response.prototype, "headers", response);
    const exposedOk: unknown = response.ok;
    const exposedStatus: unknown = response.status;
    const exposedHeaders: unknown = response.headers;
    if (
      typeof intrinsicOk !== "boolean" ||
      typeof intrinsicStatus !== "number" ||
      !Number.isInteger(intrinsicStatus) ||
      (intrinsicStatus !== 0 && intrinsicStatus < 200) ||
      intrinsicStatus > 599 ||
      !(intrinsicHeaders instanceof Headers) ||
      intrinsicOk !== (intrinsicStatus >= 200 && intrinsicStatus <= 299) ||
      exposedOk !== intrinsicOk ||
      exposedStatus !== intrinsicStatus ||
      exposedHeaders !== intrinsicHeaders
    ) {
      throw new TypeError("invalid Response shape");
    }
    return {
      ok: intrinsicOk,
      status: intrinsicStatus,
      headers: intrinsicHeaders,
      body: intrinsicBody,
    };
  } catch (error) {
    cancelResponseBody(exposedBodyForCleanup);
    if (intrinsicBodyForCleanup !== exposedBodyForCleanup) {
      cancelResponseBody(intrinsicBodyForCleanup);
    }
    throw responseBoundaryError(error, operation, method, signal);
  }
}

function responseHeader(
  headers: Headers,
  name: string,
  operation: string,
  method: "GET" | "POST",
  signal: AbortSignal,
): string | null {
  try {
    const value: unknown = headers.get(name);
    if (value !== null && typeof value !== "string") {
      throw new TypeError("invalid Response header");
    }
    return value;
  } catch (error) {
    throw responseBoundaryError(error, operation, method, signal);
  }
}

function responseReader(
  body: ReadableStream<Uint8Array>,
  operation: string,
  method: "GET" | "POST",
  signal: AbortSignal,
): ReadableStreamDefaultReader<Uint8Array> {
  try {
    const reader = body.getReader();
    if (!(reader instanceof ReadableStreamDefaultReader)) {
      throw new TypeError("invalid Response reader");
    }
    return reader;
  } catch (error) {
    throw responseBoundaryError(error, operation, method, signal);
  }
}

function responseBoundaryError(
  error: unknown,
  operation: string,
  method: "GET" | "POST",
  signal: AbortSignal,
): Error {
  if (signalWasAborted(signal) || isAbortError(error)) {
    if (method === "POST") {
      return AnthropicRcError.aborted(operation, abortName(error, signal), true);
    }
    return safeAbortError(error, signal);
  }
  if (AnthropicRcError.is(error)) {
    return AnthropicRcError.sanitized(error, operation, { write: method === "POST" });
  }
  return AnthropicRcError.network(operation, {
    retryable: method === "GET",
    outcomeUnknown: method === "POST",
  });
}

function cancelResponseBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  try {
    observeCleanup(ReadableStream.prototype.cancel.call(body));
  } catch {
    // Best-effort cleanup must never replace the deliberately low-detail operation error.
  }
}

function cancelResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    observeCleanup(ReadableStreamDefaultReader.prototype.cancel.call(reader));
  } catch {
    // Best-effort cleanup must never replace the deliberately low-detail operation error.
  }
}

function observeCleanup(result: unknown): void {
  void (async () => {
    try {
      await result;
    } catch {
      // Await observes native promises without dynamically calling an own, monkey-patched `.catch`.
    }
  })();
}

function releaseResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    ReadableStreamDefaultReader.prototype.releaseLock.call(reader);
  } catch {
    // An abort/cancel may already have released or invalidated the reader.
  }
}

async function readBoundedJson(
  response: InspectedResponse,
  operation: string,
  signal: AbortSignal,
  method: "GET" | "POST",
): Promise<unknown> {
  const invalid = (detail: string) =>
    AnthropicRcError.protocol(operation, detail, { outcomeUnknown: method === "POST" });
  let contentLength: string | null;
  try {
    contentLength = responseHeader(response.headers, "content-length", operation, method, signal);
  } catch (error) {
    cancelResponseBody(response.body);
    throw error;
  }
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAX_JSON_BYTES) {
      cancelResponseBody(response.body);
      throw invalid("JSON body exceeds size limit");
    }
  }
  if (response.body === null) throw invalid("missing JSON body");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = responseReader(response.body, operation, method, signal);
  } catch (error) {
    cancelResponseBody(response.body);
    throw error;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reachedEof = false;
  try {
    for (;;) {
      throwIfAborted(signal, operation, method === "POST");
      const { done, value } = await readWithSignal(reader, signal);
      if (done) {
        reachedEof = true;
        break;
      }
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        throw invalid("JSON body exceeds size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signalWasAborted(signal) || isAbortError(error)) {
      if (method === "POST") {
        throw AnthropicRcError.aborted(operation, abortName(error, signal), true);
      }
      throw safeAbortError(error, signal);
    }
    if (AnthropicRcError.is(error)) {
      throw AnthropicRcError.sanitized(error, operation, { write: method === "POST" });
    }
    throw AnthropicRcError.network(operation, {
      retryable: method === "GET",
      outcomeUnknown: method === "POST",
    });
  } finally {
    if (!reachedEof) cancelResponseReader(reader);
    releaseResponseReader(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  throwIfAborted(signal, operation, method === "POST");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("JSON body is not UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid("body is not valid JSON");
  }
}

function validateUserEvent(event: RcUserEventInput, operation: string): RcUserEventInput {
  let eventIsRecord: boolean;
  try {
    eventIsRecord = isRecord(event);
  } catch {
    throw AnthropicRcError.protocol(operation, "event is not readable");
  }
  if (!eventIsRecord) {
    throw AnthropicRcError.protocol(operation, "event is not an object");
  }

  let uuid: unknown;
  let timestamp: unknown;
  let messageRole: unknown;
  let messageContent: unknown;
  let parentToolUseId: unknown;
  try {
    uuid = event.uuid;
    timestamp = event.timestamp;
    const message = event.message;
    if (isRecord(message)) {
      messageRole = message.role;
      messageContent = message.content;
    }
    parentToolUseId = event.parentToolUseId;
  } catch {
    throw AnthropicRcError.protocol(operation, "event fields are not readable");
  }

  const validatedUuid = boundedInputString(uuid, operation, "uuid", MAX_EVENT_METADATA_CHARS);
  const validatedTimestamp = boundedInputString(
    timestamp,
    operation,
    "timestamp",
    MAX_EVENT_METADATA_CHARS,
  );
  if (messageRole !== "user") {
    throw AnthropicRcError.protocol(operation, "message is not a user text message");
  }
  const validatedContent = boundedInputString(
    messageContent,
    operation,
    "message.content",
    MAX_USER_CONTENT_CHARS,
  );
  const validatedParentToolUseId =
    parentToolUseId === null
      ? null
      : boundedInputString(parentToolUseId, operation, "parentToolUseId", MAX_EVENT_METADATA_CHARS);

  return {
    uuid: validatedUuid,
    timestamp: validatedTimestamp,
    message: { role: "user", content: validatedContent },
    parentToolUseId: validatedParentToolUseId,
  };
}

function boundedInputString(
  value: unknown,
  operation: string,
  field: string,
  maxChars: number,
): string {
  const parsed = requiredString(value, operation, field);
  if (parsed.length > maxChars) {
    throw AnthropicRcError.protocol(operation, `${field} exceeds size limit`);
  }
  return parsed;
}

function expectRecord(
  value: unknown,
  operation: string,
  field: string,
  outcomeUnknown = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw AnthropicRcError.protocol(operation, `${field} is not an object`, { outcomeUnknown });
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  operation: string,
  field: string,
  outcomeUnknown = false,
): string {
  if (typeof value !== "string" || value === "") {
    throw AnthropicRcError.protocol(operation, `${field} is not a non-empty string`, {
      outcomeUnknown,
    });
  }
  return value;
}

function sequenceNum(
  value: unknown,
  operation: string,
  field: string,
  outcomeUnknown = false,
): RcSequenceNum {
  const sequence = requiredString(value, operation, field, outcomeUnknown);
  if (!DECIMAL_SEQUENCE.test(sequence)) {
    throw AnthropicRcError.protocol(operation, `${field} is not a decimal string`, {
      outcomeUnknown,
    });
  }
  return sequence;
}

function optionalNullableString(value: unknown, operation: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw AnthropicRcError.protocol(operation, `${field} is not string or null`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return domExceptionName(error) !== null;
}

function throwIfAborted(signal: AbortSignal, operation?: string, outcomeUnknown = false): void {
  if (signalWasAborted(signal)) {
    const reason = signalReason(signal);
    if (operation !== undefined && outcomeUnknown) {
      throw AnthropicRcError.aborted(operation, abortName(reason, signal), true);
    }
    throw safeAbortError(reason, signal);
  }
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(safeAbortError(signalReason(signal), signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result: unknown = await Promise.race([reader.read(), aborted]);
    try {
      if (typeof result !== "object" || result === null) {
        throw new TypeError("invalid response stream result");
      }
      const done: unknown = (result as { done?: unknown }).done;
      const value: unknown = (result as { value?: unknown }).value;
      if (done === true) return { done: true, value: undefined };
      if (done !== false) {
        throw new TypeError("invalid response stream result");
      }
      // Return a plain snapshot so hostile getters on an injected reader result cannot escape the
      // caller's response-boundary sanitizer during later SSE/JSON processing.
      return { done: false, value: copyResponseChunk(value) };
    } catch {
      throw new TypeError("invalid response stream result");
    }
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function copyResponseChunk(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("invalid response stream chunk");
  // Ignore own accessors/species on an injected typed array. The intrinsic TypedArray getters brand
  // check the receiver and expose the actual backing range, which is then copied into a plain array.
  const buffer = Reflect.get(TYPED_ARRAY_PROTOTYPE, "buffer", value) as ArrayBufferLike;
  const byteOffset = Reflect.get(TYPED_ARRAY_PROTOTYPE, "byteOffset", value) as number;
  const byteLength = Reflect.get(TYPED_ARRAY_PROTOTYPE, "byteLength", value) as number;
  const source = new Uint8Array(buffer, byteOffset, byteLength);
  const copy = new Uint8Array(byteLength);
  Uint8Array.prototype.set.call(copy, source);
  return copy;
}

function abortName(error: unknown, signal: AbortSignal): "AbortError" | "TimeoutError" {
  const reason = signalReason(signal);
  if (domExceptionName(error) === "TimeoutError" || domExceptionName(reason) === "TimeoutError") {
    return "TimeoutError";
  }
  return "AbortError";
}

function signalWasAborted(signal: AbortSignal): boolean {
  try {
    return signal.aborted === true;
  } catch {
    return true;
  }
}

function signalReason(signal: AbortSignal): unknown {
  try {
    return signal.reason;
  } catch {
    return undefined;
  }
}

function domExceptionName(error: unknown): "AbortError" | "TimeoutError" | null {
  try {
    if (!(error instanceof DOMException)) return null;
    const name: unknown = error.name;
    return name === "AbortError" || name === "TimeoutError" ? name : null;
  } catch {
    return null;
  }
}

function safeAbortError(error: unknown, signal: AbortSignal): DOMException {
  const name = abortName(error, signal);
  return new DOMException(
    name === "TimeoutError" ? "The operation timed out" : "The operation was aborted",
    name,
  );
}
