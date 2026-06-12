// The broker transport: the host (wrapper) and a viewer both reach the §3.2 routes through this.
// It seals on the way out and opens on the way in (via the SecurityProvider), encodes/decodes the
// §8 wire envelope, and speaks the two endpoints — POST /api/relay (publish) and GET /api/stream
// (subscribe, SSE). The broker only ever sees ciphertext + the cleartext routing header.

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

// Default chunk size for postMessage. A POST body (the inbound hook) is capped at 4.5 MB (§8) and
// base64url expands ~33%, so a ~3 MB plaintext chunk stays comfortably under the limit with room for
// the JSON envelope. Callers can override per message.
const DEFAULT_MAX_CHUNK_BYTES = 3_000_000;

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
  /** Pick the broker's durable backend for this client's calls ("vercel" | "local" | "temporal" |
   *  "turso"). Sent as the `x-broker-backend` header on every /api/relay + /api/stream request; omitted
   *  ⇒ the broker's default. Publish and subscribe for one channel MUST agree, so it's set per client.
   *  "turso" is a durable log (see `durable`): the broker retains every frame, so the host can retire
   *  its in-memory transcript and let subscribe() serve history. */
  backend?: string;
  /** Vercel "Protection Bypass for Automation" secret. When the broker is deployed behind Vercel
   *  Deployment Protection (SSO), an unauthenticated request is bounced with a 401 auth wall before
   *  it reaches the route. Sending this as the `x-vercel-protection-bypass` header gets through it.
   *  Omitted ⇒ no header (an unprotected broker doesn't need it). Not a broker secret — it only
   *  satisfies Vercel's edge, never the broker's own auth. */
  protectionBypass?: string;
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
  readonly #backend: string | undefined;
  readonly #bypass: string | undefined;

  constructor(opts: BrokerClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#provider = opts.provider;
    // Normalize the backend ONCE: trim, and treat blank as unset. So `durable` and the
    // `x-broker-backend` header both see the same value — no host-vs-broker disagreement from stray
    // whitespace (the broker trims `?backend=` before matching, but its requestable gate does not).
    this.#backend = opts.backend?.trim() || undefined;
    this.#bypass = opts.protectionBypass;
    // The browser's global fetch is a built-in that MUST be called with `this === window`; storing
    // it on the instance and calling `this.#fetch(...)` rebinds `this` to the BrokerClient and throws
    // "Illegal invocation" (Node's fetch is lenient, so this only bites in a real browser). Bind the
    // default to globalThis. An injected fetchFn is used as-is (the caller owns its binding).
    this.#fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /** True when this client targets a DURABLE-log backend (currently only `turso`): the broker keeps
   *  every frame forever, so a fresh subscribe(startIndex:0) alone replays the WHOLE transcript and the
   *  host need not hold an in-memory `#log` or re-post it on a viewer `catch_up`. A capped/ephemeral
   *  backend (vercel) rolls old frames off its buffer, so there the host's `#log` is still the only full
   *  history — hence the conservative default (undefined/unknown backend ⇒ NOT durable, keep the #log). */
  get durable(): boolean {
    // `#backend` is already trimmed/blank-normalized at construction, so this matches exactly what the
    // `x-broker-backend` header sends — host and broker can't disagree about which store is in play.
    return this.#backend === "turso";
  }

  /** `Authorization: Bearer <hex(auth_token)>` — recomputed by the broker into identity_id (§4.5). */
  #authHeader(): string {
    return `Bearer ${toHex(this.#provider.authBearer())}`;
  }

  /** The `x-broker-backend` header selecting the durable backend, when one is configured. Merged into
   *  every /api/relay + /api/stream request so publish + subscribe address the same backend. */
  #backendHeader(): Record<string, string> {
    return this.#backend ? { "x-broker-backend": this.#backend } : {};
  }

  /** The `x-vercel-protection-bypass` header to pass Vercel Deployment Protection, when configured.
   *  Merged into every request so both publish and the long-lived subscribe get through the SSO edge. */
  #bypassHeader(): Record<string, string> {
    return this.#bypass ? { "x-vercel-protection-bypass": this.#bypass } : {};
  }

  /**
   * Seal `plaintext` for `header` and publish it. A session_announce rides the identity BUS; every
   * other kind rides its session channel (`?session=header.sessionId`), matching the broker's
   * routing + its bus-only-announce guard (§6A). Throws BrokerError on a non-2xx reply.
   */
  async postFrame(header: FrameHeader, plaintext: Uint8Array): Promise<RelayResult> {
    const plane = planeForKind(header.recordKind);
    const frame = await this.#provider.sealFrame(plane, header, plaintext);
    return this.#publish(frame);
  }

  /** POST one sealed frame on its channel (bus for session_announce, else the session channel). */
  async #publish(frame: Frame): Promise<RelayResult> {
    const onBus = frame.recordKind === "session_announce";
    const qs = onBus ? "" : `?session=${encodeURIComponent(frame.sessionId)}`;
    const res = await this.#fetch(`${this.#baseUrl}/api/relay${qs}`, {
      method: "POST",
      headers: {
        authorization: this.#authHeader(),
        "content-type": "application/json",
        ...this.#backendHeader(),
        ...this.#bypassHeader(),
      },
      body: JSON.stringify(encodeFrame(frame)),
    });
    if (!res.ok) throw new BrokerError(res.status, await safeErr(res));
    return (await res.json()) as RelayResult;
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
  ): Promise<RelayResult[]> {
    const plane = planeForKind(header.recordKind);
    const pieces = splitPlaintext(plaintext, maxChunkBytes);
    const parts = pieces.length;
    const results: RelayResult[] = [];
    for (let part = 0; part < parts; part++) {
      const frame = await this.#provider.sealFrame(
        plane,
        { ...header, part, parts },
        pieces[part] as Uint8Array,
      );
      results.push(await this.#publish(frame));
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
   * need different keys. A "nothing connected" reply (HookNotFound) simply yields nothing.
   */
  async *streamFrames(opts: StreamOptions = {}): AsyncGenerator<Frame> {
    const params = new URLSearchParams();
    if (opts.session !== undefined) params.set("session", opts.session);
    if (opts.startIndex !== undefined) params.set("startIndex", String(opts.startIndex));
    const qs = params.toString();
    const url = `${this.#baseUrl}/api/stream${qs ? `?${qs}` : ""}`;
    const init: RequestInit = {
      headers: {
        authorization: this.#authHeader(),
        accept: "text/event-stream",
        ...this.#backendHeader(),
        ...this.#bypassHeader(),
      },
    };
    if (opts.signal !== undefined) init.signal = opts.signal;
    const res = await this.#fetch(url, init);
    if (!res.ok) throw new BrokerError(res.status, await safeErr(res));
    if (res.body === null) return;
    for await (const data of sseData(res.body)) {
      yield decodeFrame(JSON.parse(data));
    }
  }

  /**
   * GET /api/seq — the highest transcript `seq` the broker's durable log holds for `sessionId` (or the
   * bus when omitted), or null if the backend keeps no durable log / the channel is absent. A restarted
   * host resumes `seq = max + 1` so its new frames don't collide with the durable ones (#36). Holds no
   * store creds — the broker reads the cleartext `seq` column; the body is `{ maxSeq: number | null }`.
   */
  async maxSeq(sessionId?: string): Promise<number | null> {
    const qs = sessionId !== undefined ? `?session=${encodeURIComponent(sessionId)}` : "";
    const res = await this.#fetch(`${this.#baseUrl}/api/seq${qs}`, {
      headers: {
        authorization: this.#authHeader(),
        ...this.#backendHeader(),
        ...this.#bypassHeader(),
      },
    });
    if (!res.ok) throw new BrokerError(res.status, await safeErr(res));
    const body = (await res.json()) as { maxSeq?: unknown };
    return typeof body.maxSeq === "number" ? body.maxSeq : null;
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
