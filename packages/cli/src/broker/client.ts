// The broker transport: the host (wrapper) and a viewer both reach the §3.2 routes through this.
// It seals on the way out and opens on the way in (via the SecurityProvider), encodes/decodes the
// §8 wire envelope, and speaks the two endpoints — POST /api/relay (publish) and GET /api/stream
// (subscribe, SSE). The broker only ever sees ciphertext + the cleartext routing header.

import {
  decodeFrame,
  encodeFrame,
  type Frame,
  type FrameHeader,
  toHex,
} from "@remote-claw/clawsec";
import type { SecurityProvider } from "../security/provider.js";
import { planeForKind } from "./protocol.js";

/** A non-2xx broker reply. `status` lets callers branch (e.g. 409 = run rolled → retry). */
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

export interface BrokerClientOptions {
  /** Broker origin, e.g. "https://broker.example.com" (no trailing slash needed). */
  baseUrl: string;
  /** Seals/opens frames and supplies the bearer (auth_token). */
  provider: SecurityProvider;
  /** Injectable fetch (tests / a custom agent). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
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

export class BrokerClient {
  readonly #baseUrl: string;
  readonly #provider: SecurityProvider;
  readonly #fetch: typeof fetch;

  constructor(opts: BrokerClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#provider = opts.provider;
    // The browser's global fetch is a built-in that MUST be called with `this === window`; storing
    // it on the instance and calling `this.#fetch(...)` rebinds `this` to the BrokerClient and throws
    // "Illegal invocation" (Node's fetch is lenient, so this only bites in a real browser). Bind the
    // default to globalThis. An injected fetchFn is used as-is (the caller owns its binding).
    this.#fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /** `Authorization: Bearer <hex(auth_token)>` — recomputed by the broker into identity_id (§4.5). */
  #authHeader(): string {
    return `Bearer ${toHex(this.#provider.authBearer())}`;
  }

  /**
   * Seal `plaintext` for `header` and publish it. A session_announce rides the identity BUS; every
   * other kind rides its session channel (`?session=header.sessionId`), matching the broker's
   * routing + its bus-only-announce guard (§6A). Throws BrokerError on a non-2xx reply.
   */
  async postFrame(header: FrameHeader, plaintext: Uint8Array): Promise<RelayResult> {
    const plane = planeForKind(header.recordKind);
    const frame = await this.#provider.sealFrame(plane, header, plaintext);
    const onBus = header.recordKind === "session_announce";
    const qs = onBus ? "" : `?session=${encodeURIComponent(header.sessionId)}`;
    const res = await this.#fetch(`${this.#baseUrl}/api/relay${qs}`, {
      method: "POST",
      headers: { authorization: this.#authHeader(), "content-type": "application/json" },
      body: JSON.stringify(encodeFrame(frame)),
    });
    if (!res.ok) throw new BrokerError(res.status, await safeErr(res));
    return (await res.json()) as RelayResult;
  }

  /** Open a received frame to its plaintext, choosing the plane from its record_kind (§6A). */
  openFrame(frame: Frame): Promise<Uint8Array> {
    return this.#provider.openFrame(planeForKind(frame.recordKind), frame);
  }

  /**
   * Subscribe to a channel and yield each decoded frame as it arrives (live, until the stream ends
   * or the signal aborts). Opening each frame is the caller's job (via openFrame) — different kinds
   * need different keys. A "nothing connected" reply (HookNotFound) simply yields nothing.
   */
  async *streamFrames(opts: StreamOptions = {}): AsyncGenerator<Frame> {
    const params = new URLSearchParams();
    if (opts.session !== undefined) params.set("session", opts.session);
    if (opts.startIndex !== undefined) params.set("startIndex", String(opts.startIndex));
    const qs = params.toString();
    const url = `${this.#baseUrl}/api/stream${qs ? `?${qs}` : ""}`;
    const init: RequestInit = {
      headers: { authorization: this.#authHeader(), accept: "text/event-stream" },
    };
    if (opts.signal !== undefined) init.signal = opts.signal;
    const res = await this.#fetch(url, init);
    if (!res.ok) throw new BrokerError(res.status, await safeErr(res));
    if (res.body === null) return;
    for await (const data of sseData(res.body)) {
      yield decodeFrame(JSON.parse(data));
    }
  }
}

/** Read an error reply body without throwing (best-effort message for BrokerError). */
async function safeErr(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j.error === "string") return j.error;
    } catch {
      /* not JSON */
    }
    return text.slice(0, 200);
  } catch {
    return res.statusText;
  }
}

/**
 * Parse a `text/event-stream` body into successive `data:` payloads (strings). Comments (`:`-lines
 * like `: open` / `: empty`) are skipped; a multi-line data field is joined per the SSE spec. An
 * `event: error` record throws so the caller sees a terminal broker error rather than a silent stop.
 */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const record = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSseRecord(record);
        if (parsed.event === "error") throw new BrokerError(502, `stream error: ${parsed.data}`);
        if (parsed.data !== "") yield parsed.data;
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** One SSE record → its `event` name and joined `data` (ignores comments + unknown fields). */
function parseSseRecord(record: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of record.split("\n")) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("data:")) dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    else if (line.startsWith("event:")) event = line.slice(line.startsWith("event: ") ? 7 : 6);
  }
  return { event, data: dataLines.join("\n") };
}
