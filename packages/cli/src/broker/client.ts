// The broker transport: the host (wrapper) and a viewer both reach the §3.2 routes through this.
// It seals on the way out and opens on the way in (via the SecurityProvider), encodes/decodes the
// §8 wire envelope, and speaks the two data-plane endpoints — POST /api/relay (publish) and GET
// /api/stream (subscribe, SSE) — plus GET /api/seq for shared durability/outbound-sequence recovery
// and GET /api/frame-count for the host-only durable inbound fence. The broker only ever sees
// ciphertext + the cleartext routing header.

import {
  concatBytes,
  decodeFrame,
  encodeFrame,
  type Frame,
  type FrameHeader,
  splitPlaintext,
  toHex,
} from "@remote-claw/clawsec";
import type { SecurityProvider } from "../security/provider.js";
import { planeForKind } from "./protocol.js";

// Default chunk size for postMessage. The shared relay route rejects decoded ciphertext at 3.3 MB
// (§8), keeping its base64url JSON body below the deployment edge limit; a ~3 MB plaintext chunk
// leaves room for the AEAD tag and envelope. Only the Workflow backend turns that request into an
// inbound hook. Callers can override per message.
const DEFAULT_MAX_CHUNK_BYTES = 3_000_000;

/** Hard transport boundaries. AbortSignal alone is insufficient: an injected/hostile fetch may
 * ignore it forever, so cursor discovery and stream establishment also race a wall-clock timer. */
export const BROKER_CURSOR_TIMEOUT_MS = 70_000;
export const BROKER_STREAM_CONNECT_TIMEOUT_MS = 20_000;

/** A non-2xx broker reply. `status` lets callers branch (e.g. 409 = channel disposal race → retry). */
export class BrokerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`broker ${status}: ${message}`);
    this.name = "BrokerError";
    this.status = status;
  }
  static is(e: unknown): e is BrokerError {
    return e instanceof BrokerError;
  }
}

/** The broker proved that a previously-established channel's durable store is gone. This is distinct
 *  from ordinary 5xx/transient transport failure and deliberately carries no provider coordinates. */
export class BrokerPermanentStorageLossError extends BrokerError {
  constructor() {
    super(410, "permanent channel storage loss");
    this.name = "BrokerPermanentStorageLossError";
  }
  static is(e: unknown): e is BrokerPermanentStorageLossError {
    return e instanceof BrokerPermanentStorageLossError;
  }
}

/** A broker operation that crossed its local wall-clock safety boundary. */
export class BrokerTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "BrokerTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** The broker deliberately rotated a healthy established SSE response nominally ahead of its hosting
 * runtime's wall-clock ceiling. Callers must reconnect from their cursor/dedup policy without
 * forgiving or charging the bounded transport-failure circuit. */
export class BrokerStreamRotationError extends Error {
  constructor() {
    super("broker stream planned rotation");
    this.name = "BrokerStreamRotationError";
  }
  static is(e: unknown): e is BrokerStreamRotationError {
    return e instanceof BrokerStreamRotationError;
  }
}

export interface BrokerClientOptions {
  /** Broker origin, e.g. "https://broker.example.com" (no trailing slash needed). */
  baseUrl: string;
  /** Seals/opens frames and supplies the bearer (auth_token). */
  provider: SecurityProvider;
  /** Injectable fetch (tests / a custom agent). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Pick the broker backend for this client's calls ("vercel" | "local" | "sqlite"). Sent as the
   *  `x-broker-backend` header on every broker API request; omitted ⇒ the broker's
   *  default. Publish and subscribe for one channel MUST agree, so it's set per client. The host learns
   *  whether the effective server backend is durable from /api/seq, not from this flag. */
  backend?: string;
  /** Vercel "Protection Bypass for Automation" secret. When the broker is deployed behind Vercel
   *  Deployment Protection (SSO), an unauthenticated request is bounced with a 401 auth wall before
   *  it reaches the route. Sending this as the `x-vercel-protection-bypass` header gets through it.
   *  Omitted ⇒ no header (an unprotected broker doesn't need it). Not a broker secret — it only
   *  satisfies Vercel's edge, never the broker's own auth. */
  protectionBypass?: string;
  /** Test/embedding override for the 70s cursor-attempt wall. */
  cursorTimeoutMs?: number;
  /** Test/embedding override for the 20s initial SSE-response wall. */
  streamConnectTimeoutMs?: number;
  /** Test/embedding override for the established SSE byte-idle watchdog. */
  streamIdleTimeoutMs?: number;
}

/** The JSON reply shape of POST /api/relay on success. */
export interface RelayResult {
  ok: true;
  channel: "bus" | "session";
  runId: string;
  created: boolean;
}

export interface StreamOptions {
  /** The session channel to read; omit/undefined ⇒ the identity bus. */
  session?: string;
  /** Resume point; negative reads the recent window (§6B). */
  startIndex?: number;
  /** Abort the long-lived SSE read. */
  signal?: AbortSignal;
}

export interface SeqCursor {
  maxSeq: number | null;
  durable: boolean;
}

export interface FrameCountCursor {
  frameCount: number | null;
  durable: boolean;
}

export class BrokerClient {
  readonly #baseUrl: string;
  readonly #provider: SecurityProvider;
  readonly #fetch: typeof fetch;
  readonly #backend: string | undefined;
  readonly #bypass: string | undefined;
  readonly #cursorTimeoutMs: number;
  readonly #streamConnectTimeoutMs: number;
  readonly #streamIdleTimeoutMs: number;
  #serverDurable: boolean | undefined;

  constructor(opts: BrokerClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#provider = opts.provider;
    // Normalize the backend ONCE: trim, and treat blank as unset. So `durable` and the
    // `x-broker-backend` header both see the same value — no host-vs-broker disagreement from stray
    // whitespace (the broker trims `?backend=` before matching, but its requestable gate does not).
    this.#backend = opts.backend?.trim() || undefined;
    this.#bypass = opts.protectionBypass;
    this.#cursorTimeoutMs = checkedTimeout(
      opts.cursorTimeoutMs,
      BROKER_CURSOR_TIMEOUT_MS,
      "cursorTimeoutMs",
    );
    this.#streamConnectTimeoutMs = checkedTimeout(
      opts.streamConnectTimeoutMs,
      BROKER_STREAM_CONNECT_TIMEOUT_MS,
      "streamConnectTimeoutMs",
    );
    this.#streamIdleTimeoutMs = checkedTimeout(
      opts.streamIdleTimeoutMs,
      SSE_IDLE_MS,
      "streamIdleTimeoutMs",
    );
    // The browser's global fetch is a built-in that MUST be called with `this === window`; storing
    // it on the instance and calling `this.#fetch(...)` rebinds `this` to the BrokerClient and throws
    // "Illegal invocation" (Node's fetch is lenient, so this only bites in a real browser). Bind the
    // default to globalThis. An injected fetchFn is used as-is (the caller owns its binding).
    this.#fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /** True only after the broker itself has reported a durable-log backend. This deliberately does NOT
   *  infer durability from `#backend`: when the host omits --rc-backend, the deployment default may still
   *  be a durable libSQL log, and the safety decision must come from the server's effective backend. */
  get durable(): boolean {
    return this.#serverDurable === true;
  }

  /** `Authorization: Bearer <hex(auth_token)>` — recomputed by the broker into identity_id (§4.5). */
  #authHeader(): string {
    return `Bearer ${toHex(this.#provider.authBearer())}`;
  }

  /** The `x-broker-backend` header selecting the broker backend, when one is configured. Merged into
   *  every broker data/recovery request so publish, subscribe, and recovery cursors address the same backend. */
  #backendHeader(): Record<string, string> {
    return this.#backend ? { "x-broker-backend": this.#backend } : {};
  }

  /** The `x-vercel-protection-bypass` header to pass Vercel Deployment Protection, when configured.
   *  Merged into every request so both publish and the long-lived subscribe get through the protected edge. */
  #bypassHeader(): Record<string, string> {
    return this.#bypass ? { "x-vercel-protection-bypass": this.#bypass } : {};
  }

  /**
   * Seal `plaintext` for `header` and publish it. Presence lifecycle records (`session_announce` and
   * `session_terminal`) ride the identity BUS; every other kind rides its session channel
   * (`?session=header.sessionId`), matching the broker's bus guard (§6A). Throws BrokerError on a
   * non-2xx reply.
   */
  async postFrame(
    header: FrameHeader,
    plaintext: Uint8Array,
    signal?: AbortSignal,
  ): Promise<RelayResult> {
    const plane = planeForKind(header.recordKind);
    const frame = await this.#provider.sealFrame(plane, header, plaintext);
    return this.#publish(frame, signal);
  }

  /** POST one sealed frame on its channel (bus for presence lifecycle, else the session channel). */
  async #publish(frame: Frame, signal?: AbortSignal): Promise<RelayResult> {
    const onBus =
      frame.recordKind === "session_announce" || frame.recordKind === "session_terminal";
    const qs = onBus ? "" : `?session=${encodeURIComponent(frame.sessionId)}`;
    const res = await this.#fetch(`${this.#baseUrl}/api/relay${qs}`, {
      method: "POST",
      // Authorization and the optional Vercel bypass are origin credentials. Never let fetch carry
      // either through a broker-controlled redirect; callers must select the final exact origin.
      redirect: "error",
      headers: {
        authorization: this.#authHeader(),
        "content-type": "application/json",
        ...this.#backendHeader(),
        ...this.#bypassHeader(),
      },
      body: JSON.stringify(encodeFrame(frame)),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw await brokerResponseError(res);
    const body = await brokerSuccessJson(res);
    if (
      !isObject(body) ||
      body.ok !== true ||
      (body.channel !== "bus" && body.channel !== "session") ||
      typeof body.runId !== "string" ||
      typeof body.created !== "boolean"
    ) {
      throw new BrokerError(502, "invalid broker response");
    }
    return body as unknown as RelayResult;
  }

  /**
   * Publish a possibly-LARGE message: split the plaintext into ≤ `maxChunkBytes` pieces, seal each
   * as an independent AEAD frame sharing `header.msgId` with its `(part, parts)` bound into the AAD
   * (§8), and POST each on the message's channel. The receiver collects the parts and reassembles
   * with `openMessage`. A single-piece message is exactly one ordinary frame. Returns one
   * RelayResult per chunk.
   */
  async postMessage(
    header: FrameHeader,
    plaintext: Uint8Array,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    signal?: AbortSignal,
  ): Promise<RelayResult[]> {
    const plane = planeForKind(header.recordKind);
    const pieces = splitPlaintext(plaintext, maxChunkBytes);
    const parts = pieces.length;
    const results: RelayResult[] = [];
    for (let part = 0; part < parts; part++) {
      throwIfAborted(signal);
      const frame = await this.#provider.sealFrame(
        plane,
        { ...header, part, parts },
        pieces[part] as Uint8Array,
      );
      // Sealing may be asynchronous. Re-check before the irreversible POST so a logical-post timeout
      // can never publish a late chunk after the relay has already failed closed.
      throwIfAborted(signal);
      results.push(await this.#publish(frame, signal));
    }
    return results;
  }

  /** Open a received frame to its plaintext, choosing the plane from its record_kind (§6A). */
  openFrame(frame: Frame): Promise<Uint8Array> {
    return this.#provider.openFrame(planeForKind(frame.recordKind), frame);
  }

  /**
   * Reassemble the chunk frames of ONE message (all sharing msg_id, `parts` total) into the full
   * plaintext. Each chunk is AEAD-verified on open (its `part`/`parts` are in the AAD), and the
   * parts must cover 0..parts-1 with no gaps or duplicates — a forged/missing/reordered chunk
   * throws before it can corrupt the buffer.
   */
  async openMessage(frames: Frame[]): Promise<Uint8Array> {
    const first = frames[0];
    if (first === undefined) throw new Error("openMessage: no frames");
    const { parts } = first;
    if (frames.length !== parts)
      throw new Error(`openMessage: expected ${parts} frames, got ${frames.length}`);
    const slots: (Uint8Array | undefined)[] = new Array(parts);
    for (const f of frames) {
      if (f.parts !== parts) throw new Error("openMessage: inconsistent parts");
      // All chunks MUST be the same message (mirrors clawsec openChunked's sameMessage check): each
      // chunk's own AEAD passes individually, so without this two messages sharing a `parts` count
      // could be Frankensteined into one corrupt plaintext. msg_id is CSPRNG-unique per message (§8).
      if (
        f.msgId !== first.msgId ||
        f.sessionId !== first.sessionId ||
        f.recordKind !== first.recordKind ||
        f.seq !== first.seq ||
        f.keyEpoch !== first.keyEpoch ||
        f.dir !== first.dir ||
        f.clientMsgId !== first.clientMsgId ||
        toHex(f.identityId) !== toHex(first.identityId)
      ) {
        throw new Error("openMessage: frames are not from the same message");
      }
      if (f.part < 0 || f.part >= parts)
        throw new Error(`openMessage: part out of range (${f.part})`);
      if (slots[f.part] !== undefined) throw new Error(`openMessage: duplicate part ${f.part}`);
      slots[f.part] = await this.openFrame(f);
    }
    const ordered: Uint8Array[] = [];
    for (let i = 0; i < parts; i++) {
      const s = slots[i];
      if (s === undefined) throw new Error(`openMessage: missing part ${i}`);
      ordered.push(s);
    }
    return concatBytes(...ordered);
  }

  /**
   * Subscribe to a channel and yield each decoded frame as it arrives (live, until the stream ends
   * or the signal aborts). Opening each frame is the caller's job (via openFrame) — different kinds
   * need different keys. A successful empty reply for an absent channel simply yields nothing.
   */
  async *streamFrames(opts: StreamOptions = {}): AsyncGenerator<Frame> {
    const params = new URLSearchParams();
    if (opts.session !== undefined) params.set("session", opts.session);
    if (opts.startIndex !== undefined) params.set("startIndex", String(opts.startIndex));
    const qs = params.toString();
    const url = `${this.#baseUrl}/api/stream${qs ? `?${qs}` : ""}`;
    const res = await withDeadline(
      async (signal) => {
        const response = await this.#fetch(url, {
          redirect: "error",
          headers: {
            authorization: this.#authHeader(),
            accept: "text/event-stream",
            ...this.#backendHeader(),
            ...this.#bypassHeader(),
          },
          signal,
        });
        // Include rejection-body parsing in the establishment wall. A hostile edge returning headers
        // but never finishing its error body must not strand the retry budget either.
        if (!response.ok) throw await brokerResponseError(response);
        return response;
      },
      this.#streamConnectTimeoutMs,
      "broker stream headers",
      opts.signal,
    );
    // The real broker always supplies either `: empty` or an opened SSE body. Treat a bodyless 2xx as
    // a protocol failure; otherwise repeated bodyless replies could masquerade as the one clean
    // absent-channel result that resets the host relay's inbound failure circuit.
    if (res.body === null) throw new BrokerError(502, "broker stream ended unexpectedly");
    for await (const data of sseData(res.body, this.#streamIdleTimeoutMs, opts.signal)) {
      let frame: Frame;
      try {
        frame = decodeFrame(JSON.parse(data));
      } catch {
        // SSE data is broker-controlled. Keep parser/validator diagnostics (which may quote input)
        // out of normal relay logs while retaining the useful transport disposition.
        throw new BrokerError(502, "invalid broker frame");
      }
      yield frame;
    }
  }

  /**
   * GET /api/seq — the highest transcript `seq` the broker's durable log holds for `sessionId` (or the
   * bus when omitted), or null if the backend keeps no durable log / the channel is absent. A restarted
   * host resumes `seq = max + 1` so its new frames don't collide with the durable ones (#36). Holds no
   * store creds — the broker reads the cleartext `seq` column; the body is
   * `{ maxSeq: number | null, durable: boolean }`.
   */
  async seqCursor(sessionId?: string): Promise<SeqCursor> {
    const qs = sessionId !== undefined ? `?session=${encodeURIComponent(sessionId)}` : "";
    const body = await withDeadline(
      async (signal) => {
        const res = await this.#fetch(`${this.#baseUrl}/api/seq${qs}`, {
          redirect: "error",
          headers: {
            authorization: this.#authHeader(),
            ...this.#backendHeader(),
            ...this.#bypassHeader(),
          },
          signal,
        });
        if (!res.ok) throw await brokerResponseError(res);
        return brokerSuccessJson(res);
      },
      this.#cursorTimeoutMs,
      "broker seq cursor",
    );
    if (!isCursorBody(body, "maxSeq")) {
      throw new BrokerError(502, "invalid broker response");
    }
    const durable = body.durable;
    this.#serverDurable = durable;
    return { maxSeq: body.maxSeq, durable };
  }

  async maxSeq(sessionId?: string): Promise<number | null> {
    return (await this.seqCursor(sessionId)).maxSeq;
  }

  /**
   * GET /api/frame-count — the current publish-order stream length for `sessionId` (or null if the
   * backend has no durable frame log / the channel is absent). A restarted durable host uses this as
   * the inbound `startIndex` floor: unlike `maxSeq`, it counts in/out/meta/chunk rows exactly like the
   * broker's subscribe cursor.
   */
  async frameCountCursor(sessionId?: string): Promise<FrameCountCursor> {
    const qs = sessionId !== undefined ? `?session=${encodeURIComponent(sessionId)}` : "";
    const body = await withDeadline(
      async (signal) => {
        const res = await this.#fetch(`${this.#baseUrl}/api/frame-count${qs}`, {
          redirect: "error",
          headers: {
            authorization: this.#authHeader(),
            ...this.#backendHeader(),
            ...this.#bypassHeader(),
          },
          signal,
        });
        if (!res.ok) throw await brokerResponseError(res);
        return brokerSuccessJson(res);
      },
      this.#cursorTimeoutMs,
      "broker frame-count cursor",
    );
    if (!isCursorBody(body, "frameCount")) {
      throw new BrokerError(502, "invalid broker response");
    }
    const durable = body.durable;
    this.#serverDurable = durable;
    return { frameCount: body.frameCount, durable };
  }

  async frameCount(sessionId?: string): Promise<number | null> {
    return (await this.frameCountCursor(sessionId)).frameCount;
  }
}

function checkedTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return timeout;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Race an entire transport attempt against a hard deadline and an optional owner abort. The
 * operation is explicitly observed after the race so a fetch that ignores AbortSignal and rejects
 * late cannot create an unhandled rejection. */
async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  ownerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectBoundary: (reason: unknown) => void = () => {};
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const timeout = setTimeout(() => {
    const error = new BrokerTimeoutError(label, timeoutMs);
    // Settle the caller-visible boundary first; abort is best-effort cancellation for cooperative fetch.
    rejectBoundary(error);
    controller.abort(error);
  }, timeoutMs);
  const onOwnerAbort = () => {
    const reason = ownerSignal === undefined ? undefined : abortReason(ownerSignal);
    rejectBoundary(reason);
    controller.abort(reason);
  };
  if (ownerSignal?.aborted) onOwnerAbort();
  else ownerSignal?.addEventListener("abort", onOwnerAbort, { once: true });

  const pending = Promise.resolve().then(() => {
    throwIfAborted(controller.signal);
    return operation(controller.signal);
  });
  void pending.catch(() => undefined);
  try {
    return await Promise.race([pending, boundary]);
  } finally {
    clearTimeout(timeout);
    ownerSignal?.removeEventListener("abort", onOwnerAbort);
  }
}

/** Read a broker rejection once. Only the route's exact 410+code pair becomes permanent loss; a bare
 *  edge/proxy 410 remains an ordinary BrokerError. Broker-controlled body/status text is discarded so
 *  an exception reaching normal relay logs retains status/disposition but never response content. */
async function brokerResponseError(res: Response): Promise<BrokerError> {
  try {
    const text = await res.text();
    try {
      const body: unknown = JSON.parse(text);
      if (
        res.status === 410 &&
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        (body as { code?: unknown }).code === "channel_storage_lost"
      ) {
        return new BrokerPermanentStorageLossError();
      }
    } catch {
      /* not JSON */
    }
  } catch {
    /* unreadable rejection body */
  }
  return new BrokerError(res.status, "request rejected");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function brokerSuccessJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    // JSON parse errors in Node may quote broker-controlled bytes. Replace them before they reach the
    // relay's normal diagnostics.
    throw new BrokerError(502, "invalid broker response");
  }
}

function isCursorBody<K extends "maxSeq" | "frameCount">(
  value: unknown,
  field: K,
): value is Record<K, number | null> & { durable: boolean } {
  if (!isObject(value) || typeof value.durable !== "boolean") return false;
  const cursor = value[field];
  return cursor === null || (Number.isSafeInteger(cursor) && (cursor as number) >= 0);
}

/**
 * Parse a `text/event-stream` body into successive `data:` payloads (strings). Comments (`:`-lines
 * like `: open` / `: empty`) are skipped; a multi-line data field is joined per the SSE spec. An
 * `event: error` record throws so the caller sees a terminal broker error rather than a silent stop.
 */
/** Idle-watchdog window. The server emits a `: ping` keepalive every ~15s (`SSE_KEEPALIVE_MS`), so a
 *  live stream — even one with no frames — sends bytes well inside this. No bytes at all for this long
 *  means the stream is stalled (a suspended iOS fetch that never resolves/throws, a silently-dropped
 *  connection): end it so the caller's re-subscribe loop reconnects from its cursor (dedup/FrameOrderer
 *  absorb any re-read). Sized > 2× the server keepalive so a single lost ping can't trip a false stall. */
export const SSE_IDLE_MS = 40_000;
const SSE_IDLE = Symbol("sse-idle");
const SSE_ABORTED = Symbol("sse-aborted");

export async function* sseData(
  body: ReadableStream<Uint8Array>,
  idleMs = SSE_IDLE_MS,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let disposition: "unknown" | "open" | "empty" | "rotate" = "unknown";
  let byteDeadline = performance.now() + idleMs;
  let resolveAbort: (value: typeof SSE_ABORTED) => void = () => {};
  const aborted = new Promise<typeof SSE_ABORTED>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => resolveAbort(SSE_ABORTED);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const remainingIdleMs = byteDeadline - performance.now();
      // Check synchronously as well as racing a timer: a hostile reader can resolve an endless chain
      // of zero-length chunks in microtasks and otherwise starve the timer queue forever.
      if (remainingIdleMs <= 0) throw new BrokerTimeoutError("broker stream idle", idleMs);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof SSE_IDLE>((resolve) => {
        idleTimer = setTimeout(() => resolve(SSE_IDLE), remainingIdleMs);
        // Don't keep a Node process alive just for the watchdog (no-op in the browser).
        if (typeof idleTimer === "object" && typeof idleTimer.unref === "function")
          idleTimer.unref();
      });
      const read = reader.read();
      // Promise.race observes rejection too, but retain an explicit observer for hostile stream
      // implementations whose read settles after timeout/cancel has already returned to the caller.
      void read.catch(() => undefined);
      const winner = await Promise.race([read, idle, aborted]);
      clearTimeout(idleTimer);
      if (winner === SSE_ABORTED) return;
      if (winner === SSE_IDLE) throw new BrokerTimeoutError("broker stream idle", idleMs);
      const { done, value } = winner;
      if (done) {
        // Owner shutdown is an ordinary lifecycle edge even if it races the reader's EOF.
        if (signal?.aborted) return;
        // Only the broker's explicit absent-channel marker is a clean finite response. An established
        // stream (or an unclassified/bodyless one) that reaches EOF lost liveness and must consume the
        // relay's bounded failure budget rather than resetting it forever.
        if (disposition === "empty" && buf === "") return;
        if (disposition === "rotate" && buf === "") throw new BrokerStreamRotationError();
        throw new BrokerError(502, "broker stream ended unexpectedly");
      }
      // Only bytes prove liveness. A zero-length read neither changes the decoder nor advances the
      // watchdog; otherwise empty chunks could keep a dead transport nominally alive forever.
      if (value.byteLength === 0) continue;
      byteDeadline = performance.now() + idleMs;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const record = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSseRecord(record);
        if (disposition === "rotate") {
          throw new BrokerError(502, "broker stream continued after rotation marker");
        }
        if (parsed.comments.includes("empty")) {
          if (
            disposition !== "unknown" ||
            parsed.comments.length !== 1 ||
            parsed.event !== "message" ||
            parsed.data !== ""
          ) {
            throw new BrokerError(502, "invalid broker empty-stream marker");
          }
          disposition = "empty";
        } else if (parsed.comments.includes("rotate")) {
          if (
            disposition !== "open" ||
            parsed.comments.length !== 1 ||
            parsed.event !== "message" ||
            parsed.data !== ""
          ) {
            throw new BrokerError(502, "invalid broker stream-rotation marker");
          }
          disposition = "rotate";
        } else if (parsed.comments.length > 0) {
          if (disposition === "empty") {
            throw new BrokerError(502, "broker stream continued after empty marker");
          }
          disposition = "open";
        }
        if (parsed.event === "error") {
          // `data` is broker-controlled and may contain credentials or other opaque provider detail.
          throw new BrokerError(502, "broker stream reported an error");
        }
        if (parsed.data !== "") {
          if (disposition === "empty") {
            throw new BrokerError(502, "broker stream continued after empty marker");
          }
          disposition = "open";
          yield parsed.data;
        }
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Cancellation is best effort. Awaiting a hostile reader that ignores cancel would turn the
    // watchdog itself into another permanent hang; observe any late rejection without blocking exit.
    try {
      const cancellation = reader.cancel();
      void cancellation.catch(() => undefined);
    } catch {
      /* a non-conforming reader may throw synchronously during best-effort cancellation */
    }
  }
}

/** One SSE record → its `event`, joined `data`, and comment control tokens. */
function parseSseRecord(record: string): { event: string; data: string; comments: string[] } {
  let event = "message";
  const dataLines: string[] = [];
  const comments: string[] = [];
  for (const line of record.split("\n")) {
    if (line.startsWith(":")) comments.push(line.slice(line.startsWith(": ") ? 2 : 1));
    else if (line.startsWith("data:"))
      dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    else if (line.startsWith("event:")) event = line.slice(line.startsWith("event: ") ? 7 : 6);
  }
  return { event, data: dataLines.join("\n"), comments };
}
