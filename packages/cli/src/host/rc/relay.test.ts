import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentity, type Frame, type FrameHeader, utf8 } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BrokerClient,
  BrokerError,
  BrokerPermanentStorageLossError,
  BrokerTimeoutError,
} from "../../broker/client.js";
import { securityProvider } from "../../security/provider.js";
import type { Tracer } from "../../trace.js";
import {
  CLAUDE_NATIVE_CAPABILITIES,
  CLAUDE_NATIVE_HARNESS,
  type DriverCapabilities,
  MITM_CAPABILITIES,
  MITM_HARNESS,
  OPENCODE_HARNESS,
  STABLE_MITM_CAPABILITIES,
  TMUX_HARNESS,
} from "./driver.js";
import {
  defaultAttachmentsDir,
  extForMime,
  HostRcRelay,
  isLikelyBase64,
  MAX_ATTACHMENT_B64,
  safeAttachmentName,
} from "./relay.js";
import { Session } from "./session.js";

/** A capturing tracer that records `error` lines (and is its own `child`) — for asserting alerts. */
function spyTracer(): {
  tracer: Tracer;
  errors: Array<{ msg: string; fields: Record<string, unknown> | undefined }>;
  debugs: Array<{ msg: string; fields: Record<string, unknown> | undefined }>;
} {
  const errors: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const debugs: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const noop = () => {};
  const t = {
    error: (msg: string, fields?: Record<string, unknown>) => errors.push({ msg, fields }),
    warn: noop,
    info: noop,
    debug: (msg: string, fields?: Record<string, unknown>) => debugs.push({ msg, fields }),
    trace: noop,
    child: () => t,
  } as unknown as Tracer;
  return { tracer: t, errors, debugs };
}

describe("safeAttachmentName", () => {
  it("strips path separators + odd chars and keeps a basename", () => {
    expect(safeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("a/b/IMG 1.png")).toBe("IMG_1.png");
    expect(safeAttachmentName("weird*name?.jpeg")).toBe("weird_name_.jpeg");
  });
  it("falls back for an empty/dotfile-only name", () => {
    expect(safeAttachmentName("")).toBe("attachment");
    expect(safeAttachmentName("...")).toBe("attachment");
    expect(safeAttachmentName("/")).toBe("attachment");
  });
});

describe("extForMime / isLikelyBase64", () => {
  it("maps known image mimes and rejects unknown", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/webp")).toBe("webp");
    expect(extForMime("application/pdf")).toBe("");
    expect(extForMime("")).toBe("");
  });
  it("accepts well-formed base64 and rejects malformed/empty", () => {
    expect(isLikelyBase64(Buffer.from("hello").toString("base64"))).toBe(true);
    expect(isLikelyBase64("")).toBe(false);
    expect(isLikelyBase64("!!!!")).toBe(false); // non-base64 chars
    expect(isLikelyBase64("Zm9v!")).toBe(false); // bad length + char
    expect(isLikelyBase64("abc")).toBe(false); // length not a multiple of 4
  });
});

// Adversarial-review fixes for the relay's two-pump seq discipline (the mid-stream-gap bug) and the
// sticky `needs` flag. We drive the REAL HostRcRelay.serve() loop with a controllable fake broker
// client so a publish can be made to FAIL (and BLOCK) deterministically — the failure path the real
// broker won't reproduce on demand.

const ID = new Uint8Array(16);
const enc = (s: string) => new TextEncoder().encode(s);

/** The exact default OpenCode M2 surface. */
const OPENCODE_M2_CAPABILITIES: DriverCapabilities = {
  structuredPermissions: false,
  status: false,
  controls: { interrupt: true, setModel: false, setMode: false, end: false },
  attachments: false,
};
const OPENCODE_MIRRORED_CAPABILITIES: DriverCapabilities = {
  ...OPENCODE_M2_CAPABILITIES,
  structuredPermissions: true,
};

interface Posted {
  recordKind: string;
  seq: number | null;
  msgId: string;
  text: string;
}

/** A fake BrokerClient: records posts, can fail a post by seq or block+fail one by record_kind, and
 *  streams a queued set of inbound frames then parks until aborted (like a live SSE subscription). */
class FakeClient {
  posts: Posted[] = [];
  /** Content posts only (seq !== null) — the durable transcript the viewer's orderer consumes. */
  get content(): Posted[] {
    return this.posts.filter((p) => p.seq !== null);
  }
  announces: Array<Record<string, unknown>> = [];

  /** Legacy synchronous client hint. The real relay no longer trusts this for safety; it waits for
   *  seqCursor().durable from the server. */
  durable = false;
  /** Server-reported effective durability returned by seqCursor()/frameCountCursor(). */
  reportedDurable = false;

  /** Mirrors BrokerClient.maxSeq — the durable log's highest seq when a durable host (re)starts a
   *  session. null ⇒ start fresh at 0; a number ⇒ resume at value+1 (#36). serve() reads it on durable
   *  starts only. `maxSeqFailures` simulates transient read failures before a later success. */
  maxSeqValue: number | null = null;
  maxSeqThrows = false;
  maxSeqFailures = 0;
  maxSeqCalls = 0;
  async seqCursor(_sessionId?: string): Promise<{ maxSeq: number | null; durable: boolean }> {
    this.maxSeqCalls++;
    if (this.maxSeqFailures > 0) {
      this.maxSeqFailures--;
      throw new BrokerError(500, "maxSeq failed");
    }
    if (this.maxSeqThrows) throw new BrokerError(500, "maxSeq failed");
    return { maxSeq: this.maxSeqValue, durable: this.reportedDurable };
  }
  async maxSeq(sessionId?: string): Promise<number | null> {
    return (await this.seqCursor(sessionId)).maxSeq;
  }

  frameCountCalls = 0;
  frameCountThrows = false;
  frameCountFailures = 0;
  async frameCountCursor(
    _sessionId?: string,
  ): Promise<{ frameCount: number | null; durable: boolean }> {
    this.frameCountCalls++;
    if (this.frameCountFailures > 0) {
      this.frameCountFailures--;
      throw new BrokerError(500, "frameCount failed");
    }
    if (this.frameCountThrows) throw new BrokerError(500, "frameCount failed");
    return { frameCount: this.#inbound.length, durable: this.reportedDurable };
  }
  async frameCount(sessionId?: string): Promise<number | null> {
    return (await this.frameCountCursor(sessionId)).frameCount;
  }

  failSeq: number | null = null; // fail postMessage when header.seq === failSeq
  failRecordKind: string | null = null; // fail postMessage when header.recordKind matches
  onAnnounce: (() => void) | null = null;

  #inbound: Frame[] = [];
  #wakes = new Set<() => void>();
  streamStarts: Array<number | undefined> = [];
  /** Inbound msgIds yielded into the relay, before any queue/authentication work. */
  streamedInbound: string[] = [];

  queueInbound(f: Frame): void {
    this.#inbound.push(f);
  }

  /** Deliver an inbound frame to a LIVE stream (after streaming has started + parked). */
  pushInbound(f: Frame): void {
    this.#inbound.push(f);
    for (const wake of this.#wakes) wake();
    this.#wakes.clear();
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    const text = new TextDecoder().decode(body);
    if (this.failSeq !== null && header.seq === this.failSeq) {
      throw new BrokerError(500, "injected failure");
    }
    if (this.failRecordKind !== null && header.recordKind === this.failRecordKind) {
      throw new BrokerError(500, `injected ${header.recordKind} failure`);
    }
    this.posts.push({ recordKind: header.recordKind, seq: header.seq, msgId: header.msgId, text });
    return [{ ok: true, channel: "session", runId: "r", created: false }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    const text = new TextDecoder().decode(body);
    if (header.recordKind === "session_announce") {
      try {
        this.announces.push(JSON.parse(text));
      } catch {
        /* ignore */
      }
      this.onAnnounce?.();
    }
    this.posts.push({ recordKind: header.recordKind, seq: header.seq, msgId: header.msgId, text });
    return { ok: true, channel: "bus", runId: "r", created: false };
  }

  async *streamFrames(opts: { startIndex?: number; signal?: AbortSignal }): AsyncGenerator<Frame> {
    this.streamStarts.push(opts.startIndex);
    let cursor =
      opts.startIndex === undefined
        ? 0
        : Math.max(0, Math.min(opts.startIndex, this.#inbound.length));
    for (;;) {
      while (cursor < this.#inbound.length) {
        const f = this.#inbound[cursor++];
        if (f !== undefined) {
          this.streamedInbound.push(f.msgId);
          yield f;
        }
      }
      if (opts.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#wakes.delete(wake);
          opts.signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.#wakes.add(wake);
        opts.signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  /** msgIds whose openFrame should REJECT — simulates an AEAD/auth failure (forged/tampered frame). */
  failOpen = new Set<string>();
  /** Every msgId passed to openFrame, in order — lets a test prove which inbound frames the relay
   *  authenticated before admission (including an otherwise ignored durable catch_up). */
  opened: string[] = [];

  openFrame(frame: Frame): Promise<Uint8Array> {
    this.opened.push(frame.msgId);
    // Reject by msgId OR by a per-frame "FORGED" ct sentinel (models a broker-injected garbage frame that
    // fails AEAD — used to prove a forged frame reusing a real msgId can't poison #seen).
    if (this.failOpen.has(frame.msgId) || new TextDecoder().decode(frame.ct) === "FORGED")
      return Promise.reject(new Error("AEAD open failed"));
    return Promise.resolve(frame.ct); // inbound test frames stash plaintext in `ct`
  }

  /** Reassemble chunk frames (the relay's #collectAttachmentChunk uses this for grouped/large
   *  attachments). Mirrors the real BrokerClient.openMessage's part-coverage check; here each chunk's
   *  plaintext is its `ct`, so the message is the parts concatenated in order. */
  async openMessage(frames: Frame[]): Promise<Uint8Array> {
    const parts = frames[0]?.parts ?? 0;
    if (frames.length !== parts)
      throw new Error(`openMessage: expected ${parts}, got ${frames.length}`);
    const slots = new Array<Uint8Array | undefined>(parts);
    for (const f of frames) {
      if (this.failOpen.has(f.msgId)) throw new Error("AEAD open failed");
      if (f.part < 0 || f.part >= parts || slots[f.part] !== undefined)
        throw new Error(`openMessage: bad part ${f.part}`);
      slots[f.part] = f.ct;
    }
    const ordered: Uint8Array[] = [];
    for (let i = 0; i < parts; i++) {
      const s = slots[i];
      if (s === undefined) throw new Error(`openMessage: missing part ${i}`);
      ordered.push(s);
    }
    const total = ordered.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of ordered) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

/** A FakeClient whose inbound opens use the real sealed provider. This proves a sibling-session or
 * wrong-identity header can carry a perfectly valid AEAD tag under the same machine identity; the
 * relay's expected-coordinate fence, rather than decryption failure, must reject it. */
class SealedInboundClient extends FakeClient {
  constructor(readonly provider: ReturnType<typeof securityProvider>) {
    super();
  }

  override openFrame(frame: Frame): Promise<Uint8Array> {
    this.opened.push(frame.msgId);
    return this.provider.openFrame("session", frame);
  }
}

/** A publish fake whose content POSTs fail with the supplied HTTP statuses before succeeding. */
class SequencedStatusClient extends FakeClient {
  postMessageAttempts = 0;

  constructor(readonly failureStatuses: number[]) {
    super();
  }

  override async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    this.postMessageAttempts++;
    const status = this.failureStatuses.shift();
    if (status !== undefined) throw new BrokerError(status, `injected ${status}`);
    return super.postMessage(header, body);
  }
}

/** Blocks the first matching publish until released, then fails it. This makes the queue head and a
 *  successor admitted by the opposite pump observable without scheduler sleeps. */
class BlockingFailureClient extends FakeClient {
  readonly failureStarted: Promise<void>;
  #markFailureStarted: () => void = () => {};
  #releaseFailure: () => void = () => {};
  readonly #failureRelease: Promise<void>;
  #failed = false;

  constructor(readonly targetRecordKind: string) {
    super();
    this.failureStarted = new Promise<void>((resolve) => {
      this.#markFailureStarted = resolve;
    });
    this.#failureRelease = new Promise<void>((resolve) => {
      this.#releaseFailure = resolve;
    });
  }

  releaseFailure(): void {
    this.#releaseFailure();
  }

  override async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    if (!this.#failed && header.recordKind === this.targetRecordKind) {
      this.#failed = true;
      this.#markFailureStarted();
      await this.#failureRelease;
      throw new BrokerError(500, `injected blocked ${header.recordKind} failure`);
    }
    return super.postMessage(header, body);
  }
}

/** Blocks the first matching publish until released, then lets it succeed. */
class BlockingSuccessClient extends FakeClient {
  readonly blocked: Promise<void>;
  #markBlocked: () => void = () => {};
  #release: () => void = () => {};
  readonly #released: Promise<void>;
  #didBlock = false;

  constructor(readonly targetRecordKind: string) {
    super();
    this.blocked = new Promise<void>((resolve) => {
      this.#markBlocked = resolve;
    });
    this.#released = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  override async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    if (!this.#didBlock && header.recordKind === this.targetRecordKind) {
      this.#didBlock = true;
      this.#markBlocked();
      await this.#released;
    }
    return super.postMessage(header, body);
  }
}

/** Lets a newer announce reach the broker before the first request completes. */
class DelayedFirstAnnounceClient extends FakeClient {
  readonly firstAnnounceStarted: Promise<void>;
  #markFirstAnnounceStarted: () => void = () => {};
  #releaseFirstAnnounce: () => void = () => {};
  readonly #firstAnnounceRelease: Promise<void>;
  #announcePosts = 0;

  constructor() {
    super();
    this.firstAnnounceStarted = new Promise<void>((resolve) => {
      this.#markFirstAnnounceStarted = resolve;
    });
    this.#firstAnnounceRelease = new Promise<void>((resolve) => {
      this.#releaseFirstAnnounce = resolve;
    });
  }

  releaseFirstAnnounce(): void {
    this.#releaseFirstAnnounce();
  }

  override async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    if (header.recordKind === "session_announce" && this.#announcePosts++ === 0) {
      this.#markFirstAnnounceStarted();
      await this.#firstAnnounceRelease;
    }
    return super.postFrame(header, body);
  }
}

/** Lets the initial presence land, then parks one advisory refresh until released. */
class BlockingAdvisoryAnnounceClient extends FakeClient {
  readonly advisoryStarted: Promise<void>;
  #markAdvisoryStarted: () => void = () => {};
  #releaseAdvisory: () => void = () => {};
  readonly #advisoryRelease: Promise<void>;
  #announcePosts = 0;

  constructor() {
    super();
    this.advisoryStarted = new Promise<void>((resolve) => {
      this.#markAdvisoryStarted = resolve;
    });
    this.#advisoryRelease = new Promise<void>((resolve) => {
      this.#releaseAdvisory = resolve;
    });
  }

  releaseAdvisory(): void {
    this.#releaseAdvisory();
  }

  override async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    if (header.recordKind === "session_announce" && this.#announcePosts++ === 1) {
      this.#markAdvisoryStarted();
      await this.#advisoryRelease;
    }
    return super.postFrame(header, body);
  }
}

class FailOnceAdvisoryAnnounceClient extends FakeClient {
  announceAttempts = 0;

  override async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    if (header.recordKind === "session_announce") {
      this.announceAttempts += 1;
      if (this.announceAttempts === 2) throw new BrokerError(500, "advisory failed");
    }
    return super.postFrame(header, body);
  }
}

class PermanentLossAnnounceClient extends FakeClient {
  announceAttempts = 0;

  constructor(readonly failOnAttempt: number) {
    super();
  }

  override async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    if (header.recordKind === "session_announce") {
      this.announceAttempts += 1;
      if (this.announceAttempts === this.failOnAttempt) {
        throw new BrokerPermanentStorageLossError();
      }
    }
    return super.postFrame(header, body);
  }
}

/** Proves the relay's own terminal deadline is authoritative even when a custom transport ignores
 * AbortSignal and never settles its first request. */
class HangingFirstTerminalClient extends FakeClient {
  terminalAttempts = 0;

  override async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    if (header.recordKind === "session_terminal" && this.terminalAttempts++ === 0) {
      return new Promise<never>(() => {});
    }
    return super.postFrame(header, body);
  }
}

/** Parks the inbound user echo while ignoring its deadline signal, then lets the test settle it late. */
class HangingInboundContentClient extends FakeClient {
  userAttempts = 0;
  userSignals: AbortSignal[] = [];
  resolveLate: () => void = () => {};

  override async postMessage(
    header: FrameHeader,
    body: Uint8Array,
    _maxChunkBytes?: number,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (header.recordKind !== "user") return super.postMessage(header, body);
    this.userAttempts += 1;
    if (signal !== undefined) this.userSignals.push(signal);
    return new Promise<unknown[]>((resolve) => {
      this.resolveLate = () => resolve([{ ok: true }]);
    });
  }
}

/** Completes a content post just inside its wall and records whether the deadline fired too early. */
class NearDeadlineSuccessClient extends FakeClient {
  assistantAttempts = 0;
  abortedAtSuccess: boolean | null = null;

  override async postMessage(
    header: FrameHeader,
    body: Uint8Array,
    _maxChunkBytes?: number,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (header.recordKind !== "assistant") return super.postMessage(header, body);
    this.assistantAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    this.abortedAtSuccess = signal?.aborted ?? false;
    return super.postMessage(header, body);
  }
}

type StreamAttempt =
  | { kind: "fail"; status: number }
  | { kind: "clean" }
  | { kind: "frame-then-fail"; frame: Frame; status: number }
  | { kind: "frames-then-fail"; frames: Frame[]; status: number }
  | { kind: "park"; rejectOnAbort?: boolean };

/** Script one result per subscription so the consecutive-failure circuit is directly observable. */
class ScriptedInboundClient extends FakeClient {
  constructor(readonly attempts: StreamAttempt[]) {
    super();
  }

  override async *streamFrames(opts: {
    startIndex?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<Frame> {
    this.streamStarts.push(opts.startIndex);
    const attempt = this.attempts.shift() ?? { kind: "park" };
    if (attempt.kind === "fail") {
      throw new BrokerError(attempt.status, `injected stream ${attempt.status}`);
    }
    if (attempt.kind === "clean") return;
    if (attempt.kind === "frame-then-fail") {
      this.streamedInbound.push(attempt.frame.msgId);
      yield attempt.frame;
      throw new BrokerError(attempt.status, `injected stream ${attempt.status}`);
    }
    if (attempt.kind === "frames-then-fail") {
      for (const frame of attempt.frames) {
        this.streamedInbound.push(frame.msgId);
        yield frame;
      }
      throw new BrokerError(attempt.status, `injected stream ${attempt.status}`);
    }
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    if (attempt.rejectOnAbort) throw new BrokerError(503, "owner-abort race");
  }
}

/** A `dir:"in"` client frame the relay's inbound pump will process (plaintext stashed in `ct`). */
function inFrame(recordKind: string, msgId: string, text: string, clientMsgId?: string): Frame {
  return {
    v: 1,
    identityId: ID,
    sessionId: "s",
    dir: "in",
    recordKind,
    seq: null,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...(clientMsgId !== undefined ? { clientMsgId } : {}),
    salt: new Uint8Array(32),
    nonce: new Uint8Array(12),
    ct: enc(text),
  } as Frame;
}

/** One chunk of a multi-part inbound message (the plaintext piece stashed in `ct`), for #114 reassembly. */
function inChunk(
  recordKind: string,
  msgId: string,
  part: number,
  parts: number,
  piece: string,
): Frame {
  return { ...inFrame(recordKind, msgId, piece), part, parts };
}

function relayOf(
  session: Session,
  client: FakeClient,
  capabilities?: DriverCapabilities,
  timing: {
    postTimeoutMs?: number;
    inboundRetryDelayMs?: number;
    cursorRetryBaseMs?: number;
  } = {},
): HostRcRelay {
  return new HostRcRelay({
    client: client as unknown as BrokerClient,
    identityId: ID,
    sessionId: session.id,
    session,
    ...(capabilities ? { capabilities } : {}),
    ...timing,
  });
}

function nativeRelayOf(session: Session, client: FakeClient): HostRcRelay {
  return new HostRcRelay({
    client: client as unknown as BrokerClient,
    identityId: ID,
    sessionId: session.id,
    session,
    capabilities: CLAUDE_NATIVE_CAPABILITIES,
    harness: CLAUDE_NATIVE_HARNESS,
  });
}

function opencodeM2RelayOf(session: Session, client: FakeClient): HostRcRelay {
  return new HostRcRelay({
    client: client as unknown as BrokerClient,
    identityId: ID,
    sessionId: session.id,
    session,
    capabilities: OPENCODE_M2_CAPABILITIES,
    harness: OPENCODE_HARNESS,
  });
}

function opencodeMirroredRelayOf(session: Session, client: FakeClient): HostRcRelay {
  return new HostRcRelay({
    client: client as unknown as BrokerClient,
    identityId: ID,
    sessionId: session.id,
    session,
    capabilities: OPENCODE_MIRRORED_CAPABILITIES,
    harness: OPENCODE_HARNESS,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await tick();
  if (!pred()) throw new Error("timed out");
}
function assistant(text: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("HostRcRelay inbound coordinate binding", () => {
  it("rejects an authenticated sibling-session command before dedup or side effects", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(41));
    const provider = securityProvider("sealed", identity);
    const client = new SealedInboundClient(provider);
    const sessionA = new Session("session-a", "A", {});
    const sessionB = new Session("session-b", "B", {});
    const sharedMsgId = "same-source-coordinate";
    const header = (sessionId: string): FrameHeader => ({
      v: 1,
      identityId: identity.identityId,
      sessionId,
      dir: "in",
      recordKind: "user",
      seq: null,
      msgId: sharedMsgId,
      keyEpoch: 0,
      part: 0,
      parts: 1,
    });
    // Both frames are validly sealed by one trusted controller under the same machine identity. The
    // untrusted broker misroutes B first, then yields A's legitimate command with the SAME msgId.
    client.queueInbound(
      await provider.sealFrame("session", header(sessionB.id), utf8("command intended for B")),
    );
    client.queueInbound(
      await provider.sealFrame("session", header(sessionA.id), utf8("command intended for A")),
    );
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: identity.identityId,
      sessionId: sessionA.id,
      session: sessionA,
    });
    const pushUser = vi.spyOn(sessionA, "pushUserInput");
    const ac = new AbortController();
    const served = relay.serve(ac.signal);

    await waitFor(() => client.content.some(({ text }) => text === "command intended for A"));
    ac.abort();
    await served;

    expect(pushUser).toHaveBeenCalledTimes(1);
    expect(pushUser).toHaveBeenCalledWith("command intended for A");
    expect(client.content.filter(({ recordKind }) => recordKind === "user")).toEqual([
      expect.objectContaining({ text: "command intended for A", seq: 0 }),
    ]);
    // Only A's frame reached AEAD open; B was rejected before decrypt and could not poison #seen.
    expect(client.opened).toEqual([sharedMsgId]);
  });

  it("rejects a validly sealed wrong-identity header without poisoning the shared msgId", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(42));
    const provider = securityProvider("sealed", identity);
    const client = new SealedInboundClient(provider);
    const session = new Session("session-a", "A", {});
    const sharedMsgId = "wrong-identity-coordinate";
    const header = (identityId: Uint8Array): FrameHeader => ({
      v: 1,
      identityId,
      sessionId: session.id,
      dir: "in",
      recordKind: "user",
      seq: null,
      msgId: sharedMsgId,
      keyEpoch: 0,
      part: 0,
      parts: 1,
    });
    // identityId is AEAD-associated data, but the session key derives from the same content root and
    // sessionId. A same-secret sender can therefore seal this wrong clear identity coordinate validly.
    client.queueInbound(
      await provider.sealFrame(
        "session",
        header(new Uint8Array(identity.identityId.length).fill(0xff)),
        utf8("wrong identity"),
      ),
    );
    client.queueInbound(
      await provider.sealFrame("session", header(identity.identityId), utf8("right identity")),
    );
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
    });
    const pushUser = vi.spyOn(session, "pushUserInput");
    const ac = new AbortController();
    const served = relay.serve(ac.signal);

    await waitFor(() => client.content.some(({ text }) => text === "right identity"));
    ac.abort();
    await served;

    expect(pushUser).toHaveBeenCalledTimes(1);
    expect(pushUser).toHaveBeenCalledWith("right identity");
    expect(client.content.filter(({ recordKind }) => recordKind === "user")).toEqual([
      expect.objectContaining({ text: "right identity", seq: 0 }),
    ]);
    expect(client.opened).toEqual([sharedMsgId]);
  });

  it("authenticates before dedup so forged ciphertext cannot suppress a genuine same-msgId command", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(43));
    const provider = securityProvider("sealed", identity);
    const client = new SealedInboundClient(provider);
    const session = new Session("session-auth-order", "auth order", {});
    const header: FrameHeader = {
      v: 1,
      identityId: identity.identityId,
      sessionId: session.id,
      dir: "in",
      recordKind: "user",
      seq: null,
      msgId: "visible-shared-msg-id",
      keyEpoch: 0,
      part: 0,
      parts: 1,
    };
    const genuine = await provider.sealFrame("session", header, utf8("genuine command"));
    const forged = { ...genuine, ct: genuine.ct.slice() };
    forged.ct[0] = (forged.ct[0] ?? 0) ^ 1;
    // The untrusted broker sees msg_id in the clear and returns its tampered copy first.
    client.queueInbound(forged);
    client.queueInbound(genuine);

    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
    });
    const pushUser = vi.spyOn(session, "pushUserInput");
    const ac = new AbortController();
    const served = relay.serve(ac.signal);

    await waitFor(() => client.content.some(({ text }) => text === "genuine command"));
    ac.abort();
    await served;

    expect(pushUser).toHaveBeenCalledTimes(1);
    expect(pushUser).toHaveBeenCalledWith("genuine command");
    expect(client.opened).toEqual([header.msgId, header.msgId]);
  });
});

describe("HostRcRelay local-origin prompt rendering (local_prompt)", () => {
  it("renders a local_prompt user event as a `user` frame but still drops a normal upstream user echo", async () => {
    // A non-MITM driver (tmux/opencode) sets `local_prompt` on a prompt typed at the host TUI so it
    // shows for viewers; a normal upstream user event (the worker's echo of a web prompt) is still
    // dropped (the inbound pump already rendered it — rendering the echo too would double it).
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    session.pushUpstream({ type: "user", message: { role: "user", content: "web echo" } });
    session.pushUpstream({
      type: "user",
      message: { role: "user", content: "typed at the host TUI" },
      local_prompt: true,
    });
    await waitFor(() =>
      client.content.some(
        (p) => p.recordKind === "user" && p.text.includes("typed at the host TUI"),
      ),
    );
    ac.abort();
    await served;
    const userTexts = client.content.filter((p) => p.recordKind === "user").map((p) => p.text);
    expect(userTexts).toContain("typed at the host TUI"); // local-origin prompt surfaced
    expect(userTexts.some((t) => t.includes("web echo"))).toBe(false); // normal upstream user text still dropped
  });
});

describe("HostRcRelay provider-ordered text boundaries", () => {
  it.each([
    {
      surface: "Claude native",
      text: "browser prompt",
      relayFor: nativeRelayOf,
    },
    {
      surface: "OpenCode M2",
      text: "\t browser prompt \n",
      relayFor: opencodeM2RelayOf,
    },
    {
      surface: "OpenCode M2 with experimental permission mirroring",
      text: "\t mirrored browser prompt \n",
      relayFor: opencodeMirroredRelayOf,
    },
  ])("$surface waits for native observation before assigning a browser user its canonical seq", async ({
    text,
    relayFor,
  }) => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    const relay = relayFor(session, client);
    const pushUser = vi.spyOn(session, "pushUserInput");
    const ac = new AbortController();
    const served = relay.serve(ac.signal);

    await waitFor(() => client.streamStarts.length === 1);
    client.pushInbound(inFrame("user", "native-in", text, "browser-msg"));
    await waitFor(() => pushUser.mock.calls.length === 1);

    // Admission preserves the original bytes and browser reconciliation coordinate, but owns no
    // canonical row/seq until the driver reports the exact native echo.
    expect(pushUser).toHaveBeenCalledWith(text, { clientMsgId: "browser-msg" });
    expect(client.content).toEqual([]);
    expect(
      client.posts
        .filter(({ recordKind }) => recordKind === "accepted")
        .map(({ text: receipt }) => JSON.parse(receipt)),
    ).toEqual([{ client_msg_id: "browser-msg", native_pending: true }]);

    session.pushUpstream(assistant("native event before the user"));
    session.pushUpstream({
      type: "user",
      local_prompt: true,
      client_msg_id: "browser-msg",
      message: { role: "user", content: text },
    });
    await waitFor(() => client.content.length === 2);
    ac.abort();
    await served;

    expect(client.content).toEqual([
      expect.objectContaining({
        recordKind: "assistant",
        seq: 0,
        text: "native event before the user",
      }),
      expect.objectContaining({ recordKind: "user", seq: 1, text }),
    ]);
    expect(
      client.posts
        .filter(({ recordKind }) => recordKind === "accepted")
        .map(({ text: receipt }) => JSON.parse(receipt)),
    ).toEqual([
      { client_msg_id: "browser-msg", native_pending: true },
      { client_msg_id: "browser-msg", seq: 1 },
    ]);
  });

  it("suppresses every unsupported native control without creating transcript content", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    const relay = nativeRelayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlRequest");
    const ac = new AbortController();
    const served = relay.serve(ac.signal);

    await waitFor(() => client.streamStarts.length === 1);
    for (const kind of ["interrupt", "set_model", "set_mode", "end"]) {
      client.pushInbound(
        inFrame(
          kind,
          `native-${kind}`,
          JSON.stringify({ model: "opus", mode: "plan", expiry: Date.now() + 60_000 }),
        ),
      );
    }
    await waitFor(() => client.opened.length === 4);
    await tick();
    expect(pushControl).not.toHaveBeenCalled();
    expect(client.content).toEqual([]);

    session.pushUpstream(assistant("provider content still flows"));
    await waitFor(() => client.content.length === 1);
    ac.abort();
    await served;

    expect(client.content).toEqual([
      expect.objectContaining({
        recordKind: "assistant",
        seq: 0,
        text: "provider content still flows",
      }),
    ]);
  });
});

describe("HostRcRelay OpenCode M2 surface", () => {
  it("admits only preserved non-slash text plus interrupt and suppresses every other mutation", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    const relay = opencodeM2RelayOf(session, client);
    const pushUser = vi.spyOn(session, "pushUserInput");
    const pushControl = vi.spyOn(session, "pushControlRequest");
    const pushResponse = vi.spyOn(session, "pushControlResponse");

    await relay.announce("OpenCode M2");
    expect(client.announces.at(-1)?.capabilities).toEqual(OPENCODE_M2_CAPABILITIES);

    const ac = new AbortController();
    const served = relay.serve(ac.signal);
    await waitFor(() => client.streamStarts.length === 1);

    // A native permission/question remains local and cannot be answered by this browser surface.
    session.pushUpstream({
      type: "control_request",
      request_id: "native-question",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Local only?" }] },
      },
    });

    client.pushInbound(inFrame("user", "oc-empty", " \t\r\n", "empty-client"));
    client.pushInbound(inFrame("user", "oc-slash", " \n\t/compact please", "slash-client"));
    client.pushInbound(
      inFrame(
        "attachment",
        "oc-attachment",
        JSON.stringify({ name: "not-supported.png", mime: "image/png", data: "AAAA" }),
      ),
    );
    client.pushInbound(
      inFrame(
        "permission",
        "oc-permission",
        JSON.stringify({ request_id: "native-question", behavior: "allow" }),
      ),
    );
    for (const kind of ["set_model", "set_mode", "end"]) {
      client.pushInbound(
        inFrame(
          kind,
          `oc-${kind}`,
          JSON.stringify({
            model: "other",
            mode: "plan",
            expiry: Date.now() + 60_000,
          }),
        ),
      );
    }
    client.pushInbound(
      inFrame("interrupt", "oc-interrupt", JSON.stringify({ expiry: Date.now() + 60_000 })),
    );
    const admittedText = "\n  preserve / inside and trailing space \t";
    client.pushInbound(inFrame("user", "oc-text", admittedText, "oc-client-msg"));

    await waitFor(() => pushUser.mock.calls.length === 1 && pushControl.mock.calls.length === 1);
    await waitFor(() => client.opened.length === 9);

    expect(pushUser).toHaveBeenCalledWith(admittedText, { clientMsgId: "oc-client-msg" });
    expect(pushControl).toHaveBeenCalledTimes(1);
    expect(pushControl).toHaveBeenCalledWith("interrupt");
    expect(pushResponse).not.toHaveBeenCalled();
    expect(client.content).toEqual([]);
    expect(
      client.posts
        .filter(({ recordKind }) => recordKind === "accepted")
        .map(({ text }) => JSON.parse(text)),
    ).toEqual([{ client_msg_id: "oc-client-msg", native_pending: true }]);
    expect(client.posts.some(({ recordKind }) => recordKind === "permission_request")).toBe(false);

    // The driver adds client_msg_id only after exact native-ID + immutable-text correlation. That
    // canonical echo, rather than admission, owns the viewer row and final reconciliation receipt.
    session.pushUpstream({
      type: "user",
      uuid: "msg_rc_11111111111141118111111111111111",
      local_prompt: true,
      client_msg_id: "oc-client-msg",
      message: { role: "user", content: admittedText },
    });
    await waitFor(() => client.content.length === 1);
    ac.abort();
    await served;

    expect(client.content).toEqual([
      expect.objectContaining({ recordKind: "user", seq: 0, text: admittedText }),
    ]);
    expect(
      client.posts
        .filter(({ recordKind }) => recordKind === "accepted")
        .map(({ text }) => JSON.parse(text)),
    ).toEqual([
      { client_msg_id: "oc-client-msg", native_pending: true },
      { client_msg_id: "oc-client-msg", seq: 0 },
    ]);
  });
});

describe("HostRcRelay seq discipline (adversarial-review fixes)", () => {
  it("projects one transcript item for an exact Claude-native request retry", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal);
    const nativeBatch = [
      {
        payload: {
          uuid: "11111111-1111-4111-8111-111111111111",
          type: "assistant",
          session_id: session.id,
          message: { content: [{ type: "text", text: "one projection" }] },
        },
      },
    ];

    expect(session.ingestNativeUpstreamBatch(1, nativeBatch)[0]?.duplicate).toBe(false);
    expect(session.ingestNativeUpstreamBatch(1, nativeBatch)[0]?.duplicate).toBe(true);
    await waitFor(() => client.content.length === 1);
    ac.abort();
    await served;

    expect(client.content).toEqual([
      expect.objectContaining({ recordKind: "assistant", seq: 0, text: "one projection" }),
    ]);
  });

  it("retries a broker 409 and preserves the same content frame", async () => {
    const session = new Session("s", "t", {});
    const client = new SequencedStatusClient([409]);
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal);
    session.pushUpstream(assistant("retry me"));

    await waitFor(() => client.content.length === 1);
    ac.abort();
    await served;

    expect(client.postMessageAttempts).toBe(2);
    expect(client.content).toHaveLength(1);
    expect(client.content[0]).toMatchObject({ seq: 0, recordKind: "assistant" });
  });

  it("does not retry a broker 500", async () => {
    const session = new Session("s", "t", {});
    const client = new SequencedStatusClient([500]);
    const relay = relayOf(session, client);
    session.pushUpstream(assistant("fail once"));

    await expect(relay.serve(new AbortController().signal)).rejects.toMatchObject({
      name: "BrokerError",
      status: 500,
    });

    expect(client.postMessageAttempts).toBe(1);
    expect(client.content).toHaveLength(0);
  });

  it("hard-times an ambiguous content post without replay, latches fatal, and observes late reject", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(55));
    let contentAttempts = 0;
    const contentSignals: AbortSignal[] = [];
    const busKinds: string[] = [];
    let rejectLate: (reason: unknown) => void = () => {};
    const fetchFn: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (pathname === "/api/seq") {
        return Promise.resolve(Response.json({ maxSeq: null, durable: false }, { status: 200 }));
      }
      if (pathname === "/api/stream") {
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      if (pathname === "/api/relay") {
        const body = JSON.parse(String(init?.body)) as { record_kind?: unknown };
        if (body.record_kind === "assistant") {
          contentAttempts += 1;
          if (init?.signal !== undefined && init.signal !== null) contentSignals.push(init.signal);
          return new Promise<Response>((_resolve, reject) => {
            rejectLate = reject;
          }); // deliberately ignores AbortSignal
        }
        if (typeof body.record_kind === "string") busKinds.push(body.record_kind);
        return Promise.resolve(
          Response.json({ ok: true, channel: "bus", runId: "r", created: true }),
        );
      }
      return Promise.reject(new Error(`unexpected broker route ${pathname}`));
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
    });
    const session = new Session("s", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      postTimeoutMs: 15,
      inboundRetryDelayMs: 0,
    });
    await relay.announce("timed post");
    session.pushUpstream(assistant("must publish once"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const failure = await relay
        .serve(new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "HostRcPostTimeoutError" });
      await relay.settlePresence();

      expect(session.closed).toBe(true);
      expect(contentAttempts).toBe(1);
      expect(contentSignals).toHaveLength(1);
      expect(contentSignals[0]?.aborted).toBe(true);
      expect(busKinds).toEqual(["session_announce", "session_terminal"]);
      await expect(relay.prepare()).rejects.toBe(failure); // the first fatal cause stays latched

      rejectLate(new Error("hostile late content rejection"));
      await tick();
      expect(contentAttempts).toBe(1); // no ambiguous replay after timeout/late settlement
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("hard-times a hung inbound content echo, never injects, and ignores its late success", async () => {
    const session = new Session("s", "t", {});
    const client = new HangingInboundContentClient();
    const relay = relayOf(session, client, undefined, {
      postTimeoutMs: 15,
      inboundRetryDelayMs: 0,
    });
    const pushUser = vi.spyOn(session, "pushUserInput");
    client.queueInbound(inFrame("user", "hung-inbound", "must never inject", "client-hung"));
    await relay.announce("hung inbound");

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({ name: "HostRcPostTimeoutError" });
    expect(session.closed).toBe(true);
    expect(pushUser).not.toHaveBeenCalled();
    expect(client.userAttempts).toBe(1);
    expect(client.userSignals).toHaveLength(1);
    expect(client.userSignals[0]?.aborted).toBe(true);
    expect(client.posts.filter(({ recordKind }) => recordKind === "accepted")).toHaveLength(1);
    expect(client.content).toEqual([]);
    expect(client.posts.some(({ recordKind }) => recordKind === "session_terminal")).toBe(true);

    client.resolveLate();
    await tick();
    expect(client.userAttempts).toBe(1); // late success cannot replay/resurrect the timed-out unit
    expect(pushUser).not.toHaveBeenCalled();
    expect(client.content).toEqual([]);
  });

  it("admits a content post that succeeds immediately before its hard deadline", async () => {
    const session = new Session("s", "t", {});
    const client = new NearDeadlineSuccessClient();
    const relay = relayOf(session, client, undefined, {
      postTimeoutMs: 30,
      inboundRetryDelayMs: 0,
    });
    const owner = new AbortController();
    const served = relay.serve(owner.signal);
    session.pushUpstream(assistant("just in time"));

    await waitFor(() => client.content.length === 1);
    expect(client.assistantAttempts).toBe(1);
    expect(client.abortedAtSuccess).toBe(false);
    expect(session.closed).toBe(false);

    owner.abort();
    await served;
    expect(client.content).toEqual([
      expect.objectContaining({ recordKind: "assistant", seq: 0, text: "just in time" }),
    ]);
  });

  it("a failing content post HALTS the relay (serve rejects) with a gap-free durable prefix", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.failSeq = 1; // the SECOND content frame's post fails
    const relay = relayOf(session, client);
    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));

    // The coupled pumps tear down on the publish failure; serve() rejects.
    await expect(relay.serve(new AbortController().signal)).rejects.toThrow();

    // Only seq 0 was durably posted; seq 1 (failed) and seq 2 (never allocated — halted) are absent.
    // The channel is a clean prefix, NOT [0, 2] with a permanent hole at 1.
    expect(client.content.map((p) => p.seq)).toEqual([0]);
  });

  it("emits an ERROR alert naming the burned seq when a content post fails terminally (#4)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.failSeq = 1; // the second content post fails terminally → seq 1 is burned
    const { tracer, errors } = spyTracer();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      tracer,
    });
    for (const a of ["a0", "a1"]) session.pushUpstream(assistant(a));
    await relay.serve(new AbortController().signal).catch(() => {});

    // The teardown is now also an actionable alert: an ERROR line that names the burned seq.
    const alert = errors.find((e) => e.msg.includes("seq burned"));
    expect(alert).toBeDefined();
    expect(alert?.fields?.seq).toBe(1);
  });

  it("a fatal INBOUND publish failure tears the relay down (couples both pumps; no silent retry-limp)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.failSeq = 0; // the inbound `user` echo (the first content seq) fails → #fatal
    const relay = relayOf(session, client);
    client.queueInbound(inFrame("user", "c-1", "hello", "c-1"));

    // Pre-fix, #pumpInbound would swallow the failure and retry forever (a live session limping behind
    // a burned seq). Now it latches #fatal and serve() couples the pumps → the whole relay tears down.
    const outcome = await relay.serve(new AbortController().signal).then(
      () => "resolved",
      () => "rejected",
    );
    expect(outcome).toBe("rejected");
    // The failed echo never became a durable content frame (only the seq:null `accepted` was attempted).
    expect(client.content.map((p) => p.seq)).toEqual([]);
  });

  it("holds an inbound user unit behind blocked upstream N; failure closes the Session before N+1 or native injection", async () => {
    const session = new Session("s", "t", {});
    const client = new BlockingFailureClient("assistant");
    const relay = relayOf(session, client);
    const pushUser = vi.spyOn(session, "pushUserInput");
    session.pushUpstream(assistant("blocked N"));
    const served = relay.serve(new AbortController().signal).then(
      () => "resolved",
      () => "rejected",
    );

    // Upstream owns queue head N. Admit an inbound user while N's broker POST is still blocked.
    await client.failureStarted;
    client.pushInbound(inFrame("user", "queued-inbound", "must not inject", "client-next"));
    await waitFor(() => client.opened.includes("queued-inbound"));
    await tick(); // openFrame's continuation has synchronously admitted the complete user unit

    client.releaseFailure();
    await expect(served).resolves.toBe("rejected");

    expect(session.closed).toBe(true);
    expect(pushUser).not.toHaveBeenCalled();
    expect(client.posts.some((p) => p.recordKind === "accepted")).toBe(false);
    expect(client.content).toEqual([]); // failed N is absent; queued N+1 never publishes
  });

  it("holds upstream N+1 behind a blocked inbound user unit; failure prevents both native injection and later publication", async () => {
    const session = new Session("s", "t", {});
    const client = new BlockingFailureClient("user");
    const { tracer, debugs } = spyTracer();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: session.id,
      session,
      tracer,
    });
    const pushUser = vi.spyOn(session, "pushUserInput");
    client.queueInbound(inFrame("user", "blocked-inbound", "blocked N", "client-n"));
    const served = relay.serve(new AbortController().signal).then(
      () => "resolved",
      () => "rejected",
    );

    // The inbound unit has allocated seq 0, published accepted, and is blocked failing its user echo.
    await client.failureStarted;
    session.pushUpstream(assistant("must not publish"));
    await waitFor(() => debugs.some((entry) => entry.msg === "upstream event"));

    client.releaseFailure();
    await expect(served).resolves.toBe("rejected");

    expect(session.closed).toBe(true);
    expect(pushUser).not.toHaveBeenCalled();
    expect(client.posts.filter((p) => p.recordKind === "accepted")).toHaveLength(1);
    expect(client.content).toEqual([]); // failed inbound N + queued upstream N+1 are both absent
  });

  it("holds a control mutation behind blocked upstream N; failure closes before the verb reaches the worker", async () => {
    const session = new Session("s", "t", {});
    const client = new BlockingFailureClient("assistant");
    const relay = relayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlRequest");
    session.pushUpstream(assistant("blocked N"));
    const served = relay.serve(new AbortController().signal).then(
      () => "resolved",
      () => "rejected",
    );

    await client.failureStarted;
    client.pushInbound(
      inFrame("interrupt", "queued-control", JSON.stringify({ expiry: Date.now() + 60_000 })),
    );
    await waitFor(() => client.streamedInbound.includes("queued-control"));
    await tick(); // the control unit is now queued behind the blocked publication

    client.releaseFailure();
    await expect(served).resolves.toBe("rejected");

    expect(session.closed).toBe(true);
    expect(pushControl).not.toHaveBeenCalled();
    expect(client.content).toEqual([]);
  });

  it("clean Session close terminates both pumps and rejects every later broker mutation", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const pushUser = vi.spyOn(session, "pushUserInput");
    const served = relay.serve(new AbortController().signal);
    await waitFor(() => client.streamStarts.length > 0);

    session.close();
    await served;
    client.pushInbound(inFrame("user", "after-close", "must not publish", "late-client"));
    await tick();

    expect(pushUser).not.toHaveBeenCalled();
    expect(client.posts).toEqual([]);
    expect(client.streamedInbound).not.toContain("after-close");
  });

  it("a close during an in-flight echo prevents the last-moment native injection", async () => {
    const session = new Session("s", "t", {});
    const client = new BlockingSuccessClient("user");
    const relay = relayOf(session, client);
    const pushUser = vi.spyOn(session, "pushUserInput");
    client.queueInbound(inFrame("user", "in-flight", "must not inject", "client-in-flight"));
    const served = relay.serve(new AbortController().signal).then(
      () => "resolved",
      () => "rejected",
    );

    await client.blocked; // accepted posted; sequenced user echo is awaiting the broker
    session.close();
    client.release();
    await expect(served).resolves.toBe("rejected");

    expect(pushUser).not.toHaveBeenCalled();
    expect(client.content.map((post) => post.recordKind)).toEqual(["user"]);
  });

  it("a worker control_cancel_request clears an open gate so `needs` doesn't stick (grounded fix)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box"); // begin announcing presence (initial needs=false)
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // The outbound pump opens a can_use_tool gate → needs=true announced.
    session.pushUpstream({
      type: "control_request",
      request_id: "perm-x",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo" } },
    });
    await waitFor(() => client.announces.at(-1)?.needs === true);

    // The worker then CANCELS that gate (real RC `control_cancel_request`, captured via --rc-trace) →
    // the relay clears #openPerms and re-announces needs=false. (Same pump, so order is deterministic.)
    session.pushUpstream({ type: "control_cancel_request", request_id: "perm-x" });
    await waitFor(() => client.announces.at(-1)?.needs === false);
    ac.abort();
    await served;

    expect(client.announces.at(-1)?.needs).toBe(false); // the gate was cleared, not left pinned
    expect(client.announces.some((a) => a.needs === true)).toBe(true); // we saw the open→clear transition
  });

  it("stable MITM suppresses both unexpected permission requests and attempted answers", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    const relay = relayOf(session, client, STABLE_MITM_CAPABILITIES);
    const pushResponse = vi.spyOn(session, "pushControlResponse");
    session.pushUpstream({
      type: "control_request",
      request_id: "stable-gate",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_input: {} },
    });
    const ac = new AbortController();
    const served = relay.serve(ac.signal);

    await waitFor(() => client.streamStarts.length === 1);
    client.pushInbound(
      inFrame(
        "permission",
        "stable-answer",
        JSON.stringify({ request_id: "stable-gate", behavior: "allow" }),
      ),
    );
    await waitFor(() => client.streamedInbound.includes("stable-answer"));
    await tick();
    ac.abort();
    await served;

    expect(pushResponse).not.toHaveBeenCalled();
    expect(client.posts.some((post) => post.recordKind === "permission_request")).toBe(false);
    expect(client.posts.some((post) => post.recordKind === "permission_resolved")).toBe(false);
    expect(STABLE_MITM_CAPABILITIES.structuredPermissions).toBe(false);
  });

  it("stable MITM admits only non-empty plain text and suppresses every unproved mutation family", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    const relay = relayOf(session, client, STABLE_MITM_CAPABILITIES);
    const pushUser = vi.spyOn(session, "pushUserInput");
    const pushControl = vi.spyOn(session, "pushControlRequest");
    const ac = new AbortController();
    const served = relay.serve(ac.signal);

    await waitFor(() => client.streamStarts.length === 1);
    client.pushInbound(inFrame("user", "stable-empty", "   "));
    client.pushInbound(inFrame("user", "stable-slash", "   /compact"));
    client.pushInbound(
      inFrame(
        "attachment",
        "stable-attachment",
        JSON.stringify({
          name: "proof.png",
          mime: "image/png",
          data: Buffer.from("not-an-image").toString("base64"),
        }),
      ),
    );
    for (const kind of ["interrupt", "set_model", "set_mode", "end"]) {
      client.pushInbound(
        inFrame(
          kind,
          `stable-${kind}`,
          JSON.stringify({
            model: "opus",
            mode: "plan",
            expiry: Date.now() + 60_000,
          }),
        ),
      );
    }
    client.pushInbound(inFrame("user", "stable-plain", "hello stable", "stable-client"));

    await waitFor(() => pushUser.mock.calls.length === 1);
    ac.abort();
    await served;

    expect(pushUser).toHaveBeenCalledWith("hello stable");
    expect(pushControl).not.toHaveBeenCalled();
    expect(client.content.map(({ recordKind, text }) => ({ recordKind, text }))).toEqual([
      { recordKind: "user", text: "hello stable" },
    ]);
    expect(client.posts.filter(({ recordKind }) => recordKind === "accepted")).toHaveLength(1);
    // Capability suppression happens only after origin authentication; none of these valid but
    // unsupported mutations reaches a native side effect or transcript publication.
    expect(client.opened).toEqual(
      expect.arrayContaining([
        "stable-attachment",
        "stable-interrupt",
        "stable-set_model",
        "stable-set_mode",
        "stable-end",
      ]),
    );
  });

  it("stable MITM fails closed before pumps or discoverability on a non-durable broker", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const pushUser = vi.spyOn(session, "pushUserInput");
    client.queueInbound(inFrame("user", "must-not-run", "unsafe legacy command"));
    session.pushUpstream(assistant("must not publish"));
    const relay = relayOf(session, client, STABLE_MITM_CAPABILITIES);

    await expect(relay.prepare()).rejects.toThrow(
      "stable Claude remote control requires a durable broker backend",
    );
    await expect(relay.serve(new AbortController().signal)).rejects.toThrow(
      "stable Claude remote control requires a durable broker backend",
    );

    expect(session.closed).toBe(true);
    expect(client.streamStarts).toEqual([]);
    expect(client.content).toEqual([]);
    expect(client.announces).toEqual([]);
    expect(pushUser).not.toHaveBeenCalled();
  });

  it("the interrupt verb is a backstop that also clears an open gate", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream({
      type: "control_request",
      request_id: "perm-y",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: {} },
    });
    await waitFor(() => client.announces.at(-1)?.needs === true); // gate open

    // A viewer ESC with NO subsequent worker cancel — the interrupt-verb backstop clears the gate.
    client.pushInbound(inFrame("interrupt", "int-1", JSON.stringify({})));
    await waitFor(() => client.announces.at(-1)?.needs === false);
    ac.abort();
    await served;

    expect(client.announces.at(-1)?.needs).toBe(false);
  });

  it("permission_resolved is unordered (seq=null), does not burn content seq, and replays on catch_up", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream({
      type: "control_request",
      request_id: "perm-v4",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo" } },
    });
    await waitFor(() => client.content.some((p) => p.recordKind === "permission_request"));

    client.pushInbound(
      inFrame(
        "permission",
        "perm-in-v4",
        JSON.stringify({ request_id: "perm-v4", behavior: "allow" }),
      ),
    );
    await waitFor(() => client.posts.some((p) => p.recordKind === "permission_resolved"));

    const resolved = client.posts.find((p) => p.recordKind === "permission_resolved");
    expect(resolved?.seq).toBeNull();
    expect(JSON.parse(resolved?.text ?? "{}")).toMatchObject({
      request_id: "perm-v4",
      behavior: "allow",
    });

    session.pushUpstream(assistant("after permission"));
    await waitFor(() => client.content.some((p) => p.recordKind === "assistant"));
    expect(client.content.map((p) => p.seq)).toEqual([0, 1]);

    client.pushInbound(inFrame("catch_up", "cu-perm-v4", JSON.stringify({ since: 1 })));
    await waitFor(
      () => client.posts.filter((p) => p.recordKind === "permission_resolved").length >= 2,
    );
    ac.abort();
    await served;

    const replayed = client.posts.filter((p) => p.recordKind === "permission_resolved").at(-1);
    expect(replayed?.seq).toBeNull();
    expect(replayed?.msgId).toBe(resolved?.msgId);
  });

  it("FAILS CLOSED: a malformed/absent behavior in a permission answer resolves to DENY, not allow", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream({
      type: "control_request",
      request_id: "perm-malformed",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo" } },
    });
    await waitFor(() => client.content.some((p) => p.recordKind === "permission_request"));

    // A garbled answer frame (behavior is neither "allow" nor "deny") must NOT auto-approve the tool.
    client.pushInbound(
      inFrame(
        "permission",
        "perm-malformed-in",
        JSON.stringify({ request_id: "perm-malformed", behavior: "maybe" }),
      ),
    );
    await waitFor(() => client.posts.some((p) => p.recordKind === "permission_resolved"));
    ac.abort();
    await served;

    const resolved = client.posts.find((p) => p.recordKind === "permission_resolved");
    expect(JSON.parse(resolved?.text ?? "{}")).toMatchObject({ behavior: "deny" });
  });

  it("does not apply a permission grant when logging permission_resolved fails", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlResponse");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => "resolved",
      () => "rejected",
    );

    session.pushUpstream({
      type: "control_request",
      request_id: "perm-log-first",
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_input: { command: "echo" } },
    });
    await waitFor(() => client.content.some((p) => p.recordKind === "permission_request"));

    client.failRecordKind = "permission_resolved";
    client.pushInbound(
      inFrame(
        "permission",
        "perm-log-first-in",
        JSON.stringify({ request_id: "perm-log-first", behavior: "allow" }),
      ),
    );

    await expect(served).resolves.toBe("rejected");
    expect(pushControl).not.toHaveBeenCalled();
    expect(client.posts.filter((p) => p.recordKind === "permission_resolved")).toHaveLength(0);
  });

  it("echoes an AskUserQuestion's questions back in the answer's updatedInput (the q.map fix, #42)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlResponse");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // Worker raises an AskUserQuestion can_use_tool with its questions under `input` (real claude shape).
    const questions = [
      {
        question: "Which name?",
        header: "Name",
        multiSelect: false,
        options: [{ label: "Orion" }],
      },
    ];
    session.pushUpstream({
      type: "control_request",
      request_id: "askq-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_q1",
        input: { questions },
      },
    });
    await waitFor(() => client.content.some((p) => p.recordKind === "permission_request"));

    // The viewer answers with the chosen option (+ the request's tool_use_id) but NOT the questions.
    client.pushInbound(
      inFrame(
        "permission",
        "askq-1-in",
        JSON.stringify({
          request_id: "askq-1",
          behavior: "allow",
          tool_use_id: "toolu_q1",
          answers: { "Which name?": "Orion" },
        }),
      ),
    );
    await waitFor(() => pushControl.mock.calls.length === 1);
    ac.abort();
    await served;

    // The relay must reattach the ORIGINAL questions so claude's call({questions,answers}) doesn't q.map undefined.
    expect(pushControl).toHaveBeenCalledWith(
      "askq-1",
      "allow",
      expect.objectContaining({
        toolUseId: "toolu_q1",
        answers: { "Which name?": "Orion" },
        questions,
      }),
    );
  });
});

describe("HostRcRelay permission mode presence", () => {
  it("seeds the announced mode from session config", async () => {
    const session = new Session("s", "t", { permissionMode: "default" });
    const client = new FakeClient();
    const relay = relayOf(session, client);

    await relay.announce("box");

    expect(client.announces.at(-1)?.mode).toBe("default");
  });

  it("updates mode from a worker system init event and re-announces", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream({ type: "system", subtype: "init", permissionMode: "plan" });
    await waitFor(() => client.announces.at(-1)?.mode === "plan");
    ac.abort();
    await served;

    expect(session.permissionMode).toBe("plan");
    expect(client.announces.at(-1)?.mode).toBe("plan");
  });

  it("updates mode from an inbound set_mode verb, forwards it, and re-announces", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const pushControl = vi.spyOn(session, "pushControlRequest");
    await relay.announce("box");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    client.pushInbound(
      inFrame("set_mode", "mode-1", JSON.stringify({ mode: "plan", expiry: Date.now() + 60_000 })),
    );
    await waitFor(() => client.announces.at(-1)?.mode === "plan");
    ac.abort();
    await served;

    expect(session.permissionMode).toBe("plan");
    expect(pushControl).toHaveBeenCalledWith("set_permission_mode", { mode: "plan" });
  });

  it("a driver that can't honor set_mode suppresses the verb and does not fabricate a confirmed mode", async () => {
    // The viewer disables unsupported controls, and the host independently enforces the same boundary
    // against an old, racing, or crafted authenticated client.
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const caps: DriverCapabilities = {
      ...MITM_CAPABILITIES,
      controls: { ...MITM_CAPABILITIES.controls, setMode: false },
    };
    const relay = relayOf(session, client, caps);
    const pushControl = vi.spyOn(session, "pushControlRequest");
    await relay.announce("box");
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    const annBefore = client.announces.length;
    client.pushInbound(
      inFrame("set_mode", "mode-1", JSON.stringify({ mode: "plan", expiry: Date.now() + 60_000 })),
    );
    client.pushInbound(inFrame("user", "mode-barrier", "still alive"));
    await waitFor(() => client.content.some(({ text }) => text === "still alive"));
    ac.abort();
    await served;

    expect(pushControl).not.toHaveBeenCalled();
    expect(session.permissionMode).toBeNull();
    expect(client.announces.slice(annBefore).some((a) => a.mode === "plan")).toBe(false);
  });
});

describe("HostRcRelay capabilities on session_announce", () => {
  it("broadcasts the full MITM capability set by default", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box");
    expect(client.announces.at(-1)?.capabilities).toEqual(MITM_CAPABILITIES);
  });

  it("broadcasts a driver's reduced capabilities verbatim", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const caps: DriverCapabilities = {
      structuredPermissions: false,
      status: true,
      controls: { interrupt: true, setModel: false, setMode: false, end: false },
      attachments: true,
    };
    const relay = relayOf(session, client, caps);
    await relay.announce("box");
    expect(client.announces.at(-1)?.capabilities).toEqual(caps);
  });

  it("strictly sequences same-millisecond presence updates when an older publish arrives last", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const session = new Session("s", "t", {});
      const client = new DelayedFirstAnnounceClient();
      const relay = relayOf(session, client);

      const initial = relay.announce("starting", "/old", null);
      await client.firstAnnounceStarted;
      const abort = new AbortController();
      const served = relay.serve(abort.signal);
      await waitFor(() => client.streamStarts.length === 1);
      session.workerStatus = "running";
      session.wake();
      await waitFor(() => client.announces.length === 1);
      client.releaseFirstAnnounce();
      await initial;
      abort.abort();
      await served;

      // Broker arrival is deliberately reversed. announce_seq, not the equal liveness timestamp,
      // identifies the running snapshot as newer; metadata remains frozen at readiness.
      expect(client.announces.map((a) => a.title)).toEqual(["starting", "starting"]);
      expect(client.announces.map((a) => a.status)).toEqual([
        "running",
        "WORKER_STATUS_UNSPECIFIED",
      ]);
      expect(client.announces.map((a) => a.sent_at)).toEqual([1_000, 1_000]);
      expect(client.announces.map((a) => a.announce_seq)).toEqual([1, 0]);
      expect(client.announces[0]?.incarnation_started_at).toBe(
        client.announces[1]?.incarnation_started_at,
      );
    } finally {
      now.mockRestore();
    }
  });
});

describe("HostRcRelay absorbing presence terminal", () => {
  it("fails closed on permanent identity-bus loss during the initial announce before serve can admit work", async () => {
    const session = new Session("s", "t", {});
    const client = new PermanentLossAnnounceClient(1);
    const relay = relayOf(session, client);

    const failure = await relay.announce("box").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrokerPermanentStorageLossError);
    expect(session.closed).toBe(true);
    expect(session.closeReason).toBe("identity bus storage permanently lost");
    await expect(relay.serve(new AbortController().signal)).rejects.toBe(failure);
    expect(client.streamStarts).toEqual([]);
    expect(client.content).toEqual([]);
  });

  it("latches permanent loss on a later presence update, closes native routes with 410, and preserves the first cause", async () => {
    const session = new Session("s", "t", {});
    const client = new PermanentLossAnnounceClient(2);
    const relay = relayOf(session, client);
    await relay.announce("box");
    const abort = new AbortController();
    const served = relay.serve(abort.signal);
    await waitFor(() => client.streamStarts.length === 1);
    session.workerStatus = "running";
    session.wake();
    await waitFor(() => session.closed);
    await served;
    const failure = await relay.prepare().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrokerPermanentStorageLossError);
    expect(session.closed).toBe(true);
    expect(session.closeReason).toBe("identity bus storage permanently lost");
    let nativeFailure: unknown;
    try {
      session.ingestNativeUpstreamBatch(1, [
        {
          payload: {
            uuid: "11111111-1111-4111-8111-111111111111",
            type: "assistant",
            session_id: session.id,
          },
        },
      ]);
    } catch (error) {
      nativeFailure = error;
    }
    expect(nativeFailure).toMatchObject({ status: 410 });
    await expect(relay.prepare()).rejects.toBe(failure);
  });

  it("publishes the canonical terminal exactly once and rejects every later live snapshot", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);

    await relay.announce("box");
    session.close();
    await relay.terminalizePresence();
    await relay.terminalizePresence();
    await relay.settlePresence();

    expect(client.posts.filter(({ recordKind }) => recordKind === "session_terminal")).toEqual([
      {
        recordKind: "session_terminal",
        seq: null,
        msgId: "terminal-s",
        text: '{"v":1}',
      },
    ]);
    await expect(relay.announce("resurrected")).rejects.toThrow("session closed");
    expect(client.announces.map(({ title }) => title)).toEqual(["box"]);
  });

  it("bounds a terminal attempt even when the transport ignores abort, then retries the same coordinate", async () => {
    const session = new Session("s", "t", {});
    const client = new HangingFirstTerminalClient();
    const relay = relayOf(session, client);

    await relay.announce("box");
    session.close();
    await relay.terminalizePresence();

    expect(client.terminalAttempts).toBe(2);
    expect(client.posts.filter(({ recordKind }) => recordKind === "session_terminal")).toEqual([
      {
        recordKind: "session_terminal",
        seq: null,
        msgId: "terminal-s",
        text: '{"v":1}',
      },
    ]);
  }, 5_000);

  it("keeps transcript publication live behind a stuck advisory presence refresh", async () => {
    const session = new Session("s", "t", {});
    const client = new BlockingAdvisoryAnnounceClient();
    const relay = relayOf(session, client);
    await relay.announce("box");
    const abort = new AbortController();
    const served = relay.serve(abort.signal);
    await waitFor(() => client.streamStarts.length === 1);

    session.workerStatus = "running";
    session.wake();
    await client.advisoryStarted;
    session.pushUpstream(assistant("must pass the stuck bus"));
    await waitFor(() =>
      client.content.some(({ text }) => text.includes("must pass the stuck bus")),
    );

    abort.abort();
    await served;
    expect(session.closed).toBe(false);
    client.releaseAdvisory();
    await relay.settlePresence();
  });

  it("normalizes a failed advisory observer even when the tracer sink throws", async () => {
    const session = new Session("s", "t", {});
    const client = new FailOnceAdvisoryAnnounceClient();
    const noop = () => {};
    const throwingTracer = {
      error: noop,
      warn: () => {
        throw new Error("closed diagnostics sink");
      },
      info: noop,
      debug: noop,
      trace: noop,
      child: () => throwingTracer,
    } as unknown as Tracer;
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: session.id,
      session,
      tracer: throwingTracer,
    });
    await relay.announce("box");
    const abort = new AbortController();
    const served = relay.serve(abort.signal);
    await waitFor(() => client.streamStarts.length === 1);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      session.workerStatus = "running";
      session.wake();
      await waitFor(() => client.announceAttempts === 2);
      session.wake();
      await waitFor(() => client.announceAttempts === 3);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(session.closed).toBe(false);
      expect(session.closeReason).toBeNull();
      await expect(relay.prepare()).resolves.toBeUndefined();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      abort.abort();
      await served;
    }
  });

  it("does not emit a tombstone when terminality wins before any live announce is admitted", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);

    session.close();
    await relay.terminalizePresence();
    await relay.settlePresence();

    expect(client.posts).toHaveLength(0);
    await expect(relay.announce("ghost")).rejects.toThrow("session closed");
  });

  it("dispatches terminal independently of a blocked live announce", async () => {
    const session = new Session("s", "t", {});
    const client = new DelayedFirstAnnounceClient();
    const relay = relayOf(session, client);

    const live = relay.announce("slow live");
    await client.firstAnnounceStarted;
    session.close();
    await relay.terminalizePresence();

    expect(client.posts.map(({ recordKind }) => recordKind)).toEqual(["session_terminal"]);
    client.releaseFirstAnnounce();
    await live;
    await relay.settlePresence();

    // Arrival is deliberately reversed. The broker contract tested at its own boundary latches the
    // first terminal and reports this late live frame as an idempotent success without forwarding it.
    expect(client.posts.map(({ recordKind }) => recordKind)).toEqual([
      "session_terminal",
      "session_announce",
    ]);
  });
});

describe("HostRcRelay harness on session_announce (#164)", () => {
  it("defaults to the MITM harness (native-RC Claude Code) when none is given", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    await relay.announce("box");
    expect(client.announces.at(-1)?.harness).toEqual(MITM_HARNESS);
  });

  it("broadcasts a driver's harness verbatim (tmux / opencode)", async () => {
    for (const h of [TMUX_HARNESS, OPENCODE_HARNESS]) {
      const session = new Session("s", "t", {});
      const client = new FakeClient();
      const relay = new HostRcRelay({
        client: client as unknown as BrokerClient,
        identityId: ID,
        sessionId: session.id,
        session,
        harness: h,
      });
      await relay.announce("box");
      expect(client.announces.at(-1)?.harness).toEqual(h);
    }
  });
});

describe("defaultAttachmentsDir (#44)", () => {
  it("is a per-session subdir of claude's own uploads tree (read without a permission prompt)", () => {
    expect(defaultAttachmentsDir("cse_abc")).toBe(join(homedir(), ".claude", "uploads", "cse_abc"));
  });
  it("isolates sessions so a later upload can't collide with another session's files", () => {
    expect(defaultAttachmentsDir("a")).not.toBe(defaultAttachmentsDir("b"));
  });
});

describe("HostRcRelay attachments (#44)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("writes a viewer attachment to disk (sanitized name) and echoes a user frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    const pushUser = vi.spyOn(session, "pushUserInput");
    const bytes = Buffer.from("PNGDATA-καλημέρα-\x00\x01\x02");
    client.queueInbound(
      inFrame(
        "attachment",
        "att-1",
        JSON.stringify({
          name: "../IMG 1.png", // path traversal + space → must sanitize to IMG_1.png
          mime: "image/png",
          data: bytes.toString("base64"),
          caption: "look at this",
        }),
      ),
    );
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    // The bytes were written under a SANITIZED basename (traversal stripped) carrying a unique prefix +
    // the mime-derived extension, byte-for-byte. There is exactly one file.
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const written = files[0] as string;
    expect(written).toMatch(/^[a-z0-9]+-IMG_1\.png$/); // <unique>-IMG_1.png (mime image/png → .png)
    expect(readFileSync(join(dir, written)).equals(bytes)).toBe(true);
    // The transcript echo shows the attachment chip (the original display name) + the caption.
    const echo = client.content.find((p) => p.recordKind === "user");
    expect(echo?.text).toContain("📎 IMG_1.png");
    expect(echo?.text).toContain("look at this");
    // claude is handed the on-disk file via the native `@"<abs-path>"` reference (matches real
    // Anthropic's upload resolution — frame 224), not a "use the Read tool" instruction.
    const injected = (pushUser.mock.calls.at(-1)?.[0] as string | undefined) ?? "";
    expect(injected).toMatch(/^@"[^"]*-IMG_1\.png" look at this$/);
    expect(injected).toContain(`@"${join(dir, written)}"`);
  });

  it("rewrites the on-disk extension to match the mime, not the original name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    const bytes = Buffer.from("JPEGDATA");
    // The viewer always re-encodes to JPEG, so a ".png" source name must land as ".jpg" on disk.
    client.queueInbound(
      inFrame(
        "attachment",
        "att-2",
        JSON.stringify({ name: "photo.png", mime: "image/jpeg", data: bytes.toString("base64") }),
      ),
    );
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    const written = readdirSync(dir)[0] as string;
    expect(written).toMatch(/^[a-z0-9]+-photo\.jpg$/); // extension follows the JPEG bytes
    const echo = client.content.find((p) => p.recordKind === "user");
    expect(echo?.text).toContain("📎 photo.png"); // …but the chip keeps the original display name
  });

  it("drops a malformed-base64 attachment: no file, no echo, no seq burned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    // A bad attachment, then a normal user frame: the user echo proves the relay kept running and that
    // the bad attachment neither wrote a file nor emitted a content frame (and burned no seq → seq 0).
    client.queueInbound(
      inFrame(
        "attachment",
        "bad-1",
        JSON.stringify({ name: "x.png", mime: "image/png", data: "!!!!" }),
      ),
    );
    client.queueInbound(inFrame("user", "u-1", "hi"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    expect(readdirSync(dir)).toHaveLength(0); // nothing written for the bad frame
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1); // only the real user frame echoed
    expect(users[0]?.seq).toBe(0); // the dropped attachment burned no seq
  });

  it("groups MULTIPLE images into ONE echo + one turn, caption sent ONCE (#114)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    const pushUser = vi.spyOn(session, "pushUserInput");
    const a = Buffer.from("AAAA-img-one");
    const b = Buffer.from("BBBB-img-two");
    client.queueInbound(
      inFrame(
        "attachment",
        "att-grp",
        JSON.stringify({
          images: [
            { name: "IMG_2159.jpeg", mime: "image/jpeg", data: a.toString("base64") },
            { name: "IMG_2158.jpeg", mime: "image/jpeg", data: b.toString("base64") },
          ],
          caption: "Tell me what these images say",
        }),
        "att-grp", // clientMsgId → the host echoes it on the `accepted` ack for the viewer's optimistic echo (#113)
      ),
    );
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    // BOTH images written.
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    // EXACTLY ONE echo, listing both chips, with the caption ONCE (not repeated per image).
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toContain("📎 IMG_2159.jpeg");
    expect(users[0]?.text).toContain("📎 IMG_2158.jpeg");
    expect(users[0]?.text.match(/Tell me what these images say/g)).toHaveLength(1);
    // ONE injected turn referencing BOTH files + the caption once.
    const injected = (pushUser.mock.calls.at(-1)?.[0] as string | undefined) ?? "";
    expect(injected.match(/@"/g)).toHaveLength(2);
    expect(injected).toContain("Tell me what these images say");
    expect(pushUser).toHaveBeenCalledTimes(1);
    // The attachment path emits an `accepted` ack carrying the clientMsgId + the echo's seq, so the
    // viewer can reconcile its optimistic echo (#113).
    const ack = client.posts.find((p) => p.recordKind === "accepted");
    expect(ack).toBeDefined();
    expect(JSON.parse(ack?.text ?? "{}")).toMatchObject({ client_msg_id: "att-grp", seq: 0 });
  });

  it("reassembles a CHUNKED attachment (parts > 1) and handles it as one message (#114)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    const payload = JSON.stringify({
      images: [
        {
          name: "big.jpg",
          mime: "image/jpeg",
          data: Buffer.from("CHUNKED-BYTES").toString("base64"),
        },
      ],
      caption: "describe it",
    });
    const mid = Math.floor(payload.length / 2);
    // Two chunks sharing msgId "att-big"; the FakeClient.openMessage concats the ct pieces in part order.
    client.queueInbound(inChunk("attachment", "att-big", 0, 2, payload.slice(0, mid)));
    client.queueInbound(inChunk("attachment", "att-big", 1, 2, payload.slice(mid)));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    expect(readdirSync(dir)).toHaveLength(1); // the reassembled image was written
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1); // one echo for the reassembled message
    expect(users[0]?.text).toContain("📎 big.jpg");
    expect(users[0]?.text).toContain("describe it");
  });

  it("a forged attachment frame is dropped non-fatally and does NOT poison a later same-msgId send (#114 review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    // A forged attachment (openFrame throws) reusing the msgId of the REAL send that follows — the
    // untrusted-broker poisoning attack. Then the genuine attachment with the same msgId. Then a user
    // frame to prove the relay never tore down.
    client.queueInbound(inFrame("attachment", "att-reuse", "FORGED")); // ct sentinel → openFrame rejects
    client.queueInbound(
      inFrame(
        "attachment",
        "att-reuse",
        JSON.stringify({
          images: [
            { name: "real.jpg", mime: "image/jpeg", data: Buffer.from("REAL").toString("base64") },
          ],
          caption: "the real one",
        }),
      ),
    );
    client.queueInbound(inFrame("user", "u-after", "still alive"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() =>
      client.content.some((p) => p.recordKind === "user" && p.text === "still alive"),
    );
    ac.abort();
    await served;

    // The relay survived the forged frame (the trailing user prompt echoed), AND the genuine attachment —
    // same msgId — was NOT suppressed: it wrote its file and echoed its chip.
    expect(readdirSync(dir)).toHaveLength(1);
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(
      users.some((p) => p.text.includes("📎 real.jpg") && p.text.includes("the real one")),
    ).toBe(true);
    expect(users.some((p) => p.text === "still alive")).toBe(true);
  });

  it("STILL drops a multi-part NON-attachment frame (a truncated prompt is never acted on)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    dirs.push(dir);
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    const pushUser = vi.spyOn(session, "pushUserInput");
    // A multi-part USER frame (must be dropped), then a normal user frame (proves the relay kept running).
    client.queueInbound(inChunk("user", "u-multi", 0, 2, "truncated half of a prompt"));
    client.queueInbound(inFrame("user", "u-ok", "a whole prompt"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    // Only the whole prompt was injected/echoed; the truncated multi-part user frame was dropped.
    expect(pushUser).toHaveBeenCalledTimes(1);
    expect(pushUser.mock.calls[0]?.[0]).toBe("a whole prompt");
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1);
  });
});

// #36 — "deep-history worker backfill" GROUNDING.
//
// The v2-architecture §6 design had the WORKER re-emit prior turns as `historical:true` frames on RC
// (re)connect, gated by a completeness check. The real RC protocol (captured via --rc-trace) does NOT
// do this: `POST .../bridge` returns only a worker_jwt (no transcript); the SSE stream carries only NEW
// inputs; a `--resume`d worker is streamed NO prior history; `historical` appears in zero captures. So
// there is nothing to backfill FROM the worker, and nothing to gate on.
//
// Instead, the RELAY is the source of truth for its session's transcript: every content frame is
// appended to `#log`, and a mid-session (re)connecting viewer replays the COMPLETE history from that log
// via `catch_up` (§8) — no worker round-trip. These tests simulate that mid-session reconnect end to end
// against the real relay, which is what #36 actually needs to guarantee.
describe("HostRcRelay mid-session reconnect = complete history from the relay log (#36)", () => {
  it("a viewer that joins mid-session catch_up's the WHOLE prior transcript (no worker backfill)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // Drive a few turns so the relay accumulates a transcript (seq 0,1,2) BEFORE any viewer is present.
    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);
    const original = client.content.map((p) => ({ seq: p.seq, msgId: p.msgId, text: p.text }));
    expect(original.map((p) => p.seq)).toEqual([0, 1, 2]);

    // A late viewer connects and asks for everything since the start (mid-session reconnect).
    client.pushInbound(inFrame("catch_up", "cu-1", JSON.stringify({ since: 0 })));
    await waitFor(() => client.content.length >= 6);
    ac.abort();
    await served;

    // The replay re-posted the ENTIRE prior transcript with identical seq+msg_id+text — the late viewer
    // reconstructs the full history from the relay log alone (the viewer's orderer dedups the re-posts).
    const replayed = client.content
      .slice(3, 6)
      .map((p) => ({ seq: p.seq, msgId: p.msgId, text: p.text }));
    expect(replayed).toEqual(original);
  });

  it("an incremental catch_up replays only frames at/after `since` (no gap, no over-send)", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);

    // A viewer that already has seq 0 reconnects mid-session and only needs the tail (1,2).
    client.pushInbound(inFrame("catch_up", "cu-2", JSON.stringify({ since: 1 })));
    await waitFor(() => client.content.length >= 5);
    ac.abort();
    await served;

    expect(client.content.slice(3).map((p) => p.seq)).toEqual([1, 2]); // only the missing tail
  });
});

// A2a — on a DURABLE-log backend (per-channel SQLite) the broker keeps every frame, so a (re)connecting viewer's
// subscribe(startIndex:0) replays the whole transcript on its own. The host then must NOT also keep an
// in-memory `#log` or re-post it on `catch_up` (that would be pure waste — the frames are already in the
// durable log and already delivered by subscribe). "One log, mediated by the broker."
describe("HostRcRelay durable backend retires the host catch_up replay (A2a)", () => {
  it("DURABLE: catch_up is authenticated but not replayed", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true; // server-reported durable libSQL backend
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    // Drive a few turns: the content frames are POSTed live (into the durable log, in production).
    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);

    // Deliver a catch_up, then a real `user` prompt BEHIND it on the same inbound stream. The inbound
    // pump is FIFO, so the relay processing the user prompt PROVES it got past the catch_up (consumed,
    // not stuck) — without us needing to peek at any private state.
    client.pushInbound(inFrame("catch_up", "cu-d", JSON.stringify({ since: 0 })));
    client.pushInbound(inFrame("user", "u-1", "hi from viewer"));
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    // The user frame WAS opened (decrypted) — the pump reached past the catch_up …
    expect(client.opened).toContain("u-1");
    // … and the catch_up frame was authenticated before persistent dedup even though its `since` is
    // irrelevant on a durable backend. This prevents a forged clear msg_id from poisoning #seen.
    expect(client.opened).toContain("cu-d");
    // … and nothing was re-posted: the only content frames are the 3 live ones + the echoed user prompt
    // (seq 3). No replay of seq 0–2 (contrast the non-durable test below, which re-posts them).
    expect(client.content.map((p) => p.seq)).toEqual([0, 1, 2, 3]);
  });

  it("NON-DURABLE (contrast): catch_up IS opened and replays the host #log", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient(); // durable defaults false — the legacy capped/ephemeral path
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    for (const a of ["a0", "a1", "a2"]) session.pushUpstream(assistant(a));
    await waitFor(() => client.content.length >= 3);

    // On a non-durable backend the host MUST still build #log and replay it on catch_up (the broker's
    // buffer may have rolled). So the same catch_up opens the frame (to read `since`) and re-posts the log.
    client.pushInbound(inFrame("catch_up", "cu-n", JSON.stringify({ since: 0 })));
    await waitFor(() => client.content.length >= 6); // 3 live + 3 replayed
    ac.abort();
    await served;

    expect(client.opened).toContain("cu-n"); // opened to read `since` (the durable branch would not)
    // The host re-posted the whole log — proving the `if (!this.#durable)` #emit guard still POPULATES
    // #log on the non-durable path (a regression that skipped it would make this replay empty).
    expect(client.content.map((p) => p.seq)).toEqual([0, 1, 2, 0, 1, 2]);
  });
});

describe("HostRcRelay durable restart inbound safety", () => {
  it("announce publishes WITHOUT sampling the durable cursors (so it can't race a viewer bus subscribe); serve() samples before the inbound tail", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    const pushUser = vi.spyOn(session, "pushUserInput");
    const relay = relayOf(session, client);

    // The bus announce must NOT do the durable-cursor round-trip (maxSeq/frameCount) — that delay would
    // race a viewer's CONCURRENT bus subscribe in the broker (the in-process Workflow runtime rejects a
    // concurrent channel create). The cursors are sampled in serve(), before the inbound tail, instead —
    // and a viewer cannot post session-inbound faster than that local sample resolves (it must first
    // receive this announce, subscribe to the session channel, and post).
    await relay.announce("box");
    expect(client.maxSeqCalls).toBe(0);
    expect(client.frameCountCalls).toBe(0);

    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});
    await waitFor(() => client.streamStarts.length > 0);
    // serve() sampled both durable cursors before starting the inbound tail.
    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(1);

    // A live inbound arriving after the sample is delivered (exactly once).
    client.pushInbound(inFrame("user", "new-u-1", "new prompt", "new-c-1"));
    await waitFor(() => pushUser.mock.calls.length === 1);
    ac.abort();
    await served;
    expect(pushUser).toHaveBeenCalledWith("new prompt");
    expect(client.content.find((p) => p.recordKind === "user")?.text).toBe("new prompt");
  });

  it("uses server-reported durable=true even when the local backend hint is false", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.queueInbound(inFrame("user", "old-u-1", "old prompt 1", "old-c-1"));
    client.queueInbound(inFrame("user", "old-u-2", "old prompt 2", "old-c-2"));
    client.queueInbound(
      inFrame(
        "permission",
        "old-p-1",
        JSON.stringify({ request_id: "perm-old", behavior: "allow" }),
      ),
    );
    const pushUser = vi.spyOn(session, "pushUserInput");
    const pushControl = vi.spyOn(session, "pushControlResponse");
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    await waitFor(() => client.streamStarts.length > 0);
    await tick();

    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(1);
    expect(client.streamStarts[0]).toBe(3); // the three historical inbound frames are below the floor
    expect(pushUser).not.toHaveBeenCalled();
    expect(pushControl).not.toHaveBeenCalled();
    expect(client.content.filter((p) => p.recordKind === "user")).toHaveLength(0);
    expect(client.content.filter((p) => p.recordKind === "permission_resolved")).toHaveLength(0);

    client.pushInbound(inFrame("user", "new-u-1", "new prompt", "new-c-1"));
    await waitFor(() => pushUser.mock.calls.length === 1);
    ac.abort();
    await served;

    expect(pushUser).toHaveBeenCalledTimes(1);
    expect(pushUser).toHaveBeenCalledWith("new prompt");
    expect(pushControl).not.toHaveBeenCalled();
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toBe("new prompt");
    expect(client.content.filter((p) => p.recordKind === "permission_resolved")).toHaveLength(0);
  });
});

// A2b/#36 (durable face) — on a durable backend the session's frames OUTLIVE the host process, so a
// restarted relay must CONTINUE the seq timeline. serve() resumes `#seq = maxSeq + 1` from the broker's
// durable log (cleartext seq column; host holds no store creds) before either pump emits — else a restart
// re-issues seqs the log already holds and a viewer's orderer drops the new content as duplicates.
describe("HostRcRelay durable seq continuity across restart (A2b/#36)", () => {
  it("resumes seq = durable MAX + 1 so a restart doesn't collide with prior frames", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.maxSeqValue = 4; // a prior incarnation already wrote seq 0..4 to the durable log
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("after restart"));
    await waitFor(() => client.content.length >= 1);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(1); // queried exactly once, on serve()
    expect(client.content[0]?.seq).toBe(5); // resumed at MAX(4)+1 — NOT 0
  });

  it("starts at 0 when the durable log is empty (maxSeq null) — a fresh session", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.maxSeqValue = null;
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("first ever"));
    await waitFor(() => client.content.length >= 1);
    ac.abort();
    await served;

    expect(client.content[0]?.seq).toBe(0);
  });

  it("retries transient frameCount failures after durable=true before starting the pumps", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.frameCountFailures = 2;
    client.maxSeqValue = 4;
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("after transient failures"));
    await waitFor(() => client.content.length >= 1);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(3);
    expect(client.content[0]?.seq).toBe(5);
  });

  it("uses the legacy path when the server reports non-durable", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient(); // durable false
    client.maxSeqValue = 9; // ignored because durable=false
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("legacy"));
    await waitFor(() => client.content.length >= 1);
    await waitFor(() => client.streamStarts.length > 0);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(1); // capability discovery only
    expect(client.frameCountCalls).toBe(0);
    expect(client.streamStarts[0]).toBe(0);
    expect(client.content[0]?.seq).toBe(0);
  });

  it("fails closed when durability remains unknown after bounded discovery retries", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.maxSeqThrows = true;
    client.maxSeqValue = 9;
    const { tracer, errors } = spyTracer();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      tracer,
    });

    await expect(relay.serve(new AbortController().signal)).rejects.toThrow(/maxSeq failed/);

    expect(client.maxSeqCalls).toBe(3);
    expect(client.frameCountCalls).toBe(0);
    expect(client.streamStarts).toEqual([]);
    expect(client.content).toEqual([]);
    expect(session.closed).toBe(true);
    expect(
      errors.find((event) => event.msg.includes("durability discovery failed after retries")),
    ).toBeDefined();
  });

  it("recovers from transient durability-discovery failures before discoverability", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.maxSeqFailures = 2;
    client.maxSeqValue = 4;
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).catch(() => {});

    session.pushUpstream(assistant("after discovery retries"));
    await waitFor(() => client.content.length === 1);
    ac.abort();
    await served;

    expect(client.maxSeqCalls).toBe(3);
    expect(client.frameCountCalls).toBe(1);
    expect(client.content[0]?.seq).toBe(5);
  });

  it("fails loud after durable frameCount retries fail instead of reusing startIndex 0", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    client.reportedDurable = true;
    client.frameCountThrows = true;
    const { tracer, errors } = spyTracer();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      tracer,
    });

    const firstCause = await relay.prepare().catch((error: unknown) => error);
    expect(firstCause).toBeInstanceOf(BrokerError);
    expect((firstCause as Error).message).toMatch(/frameCount failed/);

    expect(client.maxSeqCalls).toBe(1);
    expect(client.frameCountCalls).toBe(3);
    expect(client.content).toHaveLength(0); // no seq 0 collision is posted
    expect(session.closed).toBe(true);
    let nativeFailure: unknown;
    try {
      session.ingestNativeUpstreamBatch(1, [
        {
          payload: {
            uuid: "11111111-1111-4111-8111-111111111111",
            type: "assistant",
            session_id: session.id,
          },
        },
      ]);
    } catch (error) {
      nativeFailure = error;
    }
    expect(nativeFailure).toMatchObject({ status: 410 });
    await expect(relay.prepare()).rejects.toBe(firstCause);
    expect(
      errors.find((e) => e.msg.includes("inbound cursor resume failed after retries")),
    ).toBeDefined();
  });
});

describe("HostRcRelay bounded transport liveness", () => {
  it("bounds never-settling startup cursor attempts, then fails closed after the finite retry count", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(51));
    const cursorSignals: AbortSignal[] = [];
    const hostileFetch: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) cursorSignals.push(init.signal);
      return new Promise<Response>(() => {}); // deliberately ignores AbortSignal forever
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn: hostileFetch,
      cursorTimeoutMs: 10,
    });
    const session = new Session("cursor-timeout", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      cursorRetryBaseMs: 0,
    });

    await expect(relay.prepare()).rejects.toBeInstanceOf(BrokerTimeoutError);

    expect(cursorSignals).toHaveLength(3);
    expect(cursorSignals.every((signal) => signal.aborted)).toBe(true);
    expect(session.closed).toBe(true);
  });

  it("turns three initial-stream header stalls into a fatal close and terminal presence", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(52));
    const streamSignals: AbortSignal[] = [];
    const busKinds: string[] = [];
    const fetchFn: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (pathname === "/api/seq") {
        return Promise.resolve(Response.json({ maxSeq: null, durable: false }, { status: 200 }));
      }
      if (pathname === "/api/relay") {
        const body = JSON.parse(String(init?.body)) as { record_kind?: unknown };
        if (typeof body.record_kind === "string") busKinds.push(body.record_kind);
        return Promise.resolve(
          Response.json({ ok: true, channel: "bus", runId: "r", created: true }),
        );
      }
      if (pathname === "/api/stream") {
        if (init?.signal !== undefined && init.signal !== null) streamSignals.push(init.signal);
        return new Promise<Response>(() => {}); // ignores each connect abort
      }
      return Promise.reject(new Error(`unexpected broker route ${pathname}`));
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
      streamConnectTimeoutMs: 10,
    });
    const session = new Session("stream-timeout", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      inboundRetryDelayMs: 0,
    });
    await relay.announce("stream timeout");

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({
      name: "BrokerTimeoutError",
      operation: "broker stream headers",
    });
    expect(streamSignals).toHaveLength(3);
    expect(streamSignals.every((signal) => signal.aborted)).toBe(true);
    expect(session.closed).toBe(true);
    expect(busKinds).toEqual(["session_announce", "session_terminal"]);
    await expect(relay.prepare()).rejects.toBe(failure);
  });

  it("counts malformed SSE, established-stream idle, and broker SSE error as consecutive failures", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(54));
    const busKinds: string[] = [];
    let streamAttempts = 0;
    const fetchFn: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (pathname === "/api/seq") {
        return Promise.resolve(Response.json({ maxSeq: null, durable: false }, { status: 200 }));
      }
      if (pathname === "/api/relay") {
        const body = JSON.parse(String(init?.body)) as { record_kind?: unknown };
        if (typeof body.record_kind === "string") busKinds.push(body.record_kind);
        return Promise.resolve(
          Response.json({ ok: true, channel: "bus", runId: "r", created: true }),
        );
      }
      if (pathname === "/api/stream") {
        streamAttempts += 1;
        if (streamAttempts === 1) {
          return Promise.resolve(
            new Response("data: definitely-not-json\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }
        if (streamAttempts === 2) {
          return Promise.resolve(
            new Response(new ReadableStream<Uint8Array>({ start() {} }), {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(
          new Response("event: error\ndata: broker stream failed\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected broker route ${pathname}`));
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
      streamIdleTimeoutMs: 10,
    });
    const session = new Session("stream-protocol", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      inboundRetryDelayMs: 0,
    });
    await relay.announce("protocol failures");

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({ name: "BrokerError", status: 502 });
    expect(streamAttempts).toBe(3);
    expect(session.closed).toBe(true);
    expect(busKinds).toEqual(["session_announce", "session_terminal"]);
  });

  it("counts an established stream's clean EOF and fails closed on the third occurrence", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(58));
    const busKinds: string[] = [];
    let streamAttempts = 0;
    const fetchFn: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (pathname === "/api/seq") {
        return Promise.resolve(Response.json({ maxSeq: null, durable: false }, { status: 200 }));
      }
      if (pathname === "/api/relay") {
        const body = JSON.parse(String(init?.body)) as { record_kind?: unknown };
        if (typeof body.record_kind === "string") busKinds.push(body.record_kind);
        return Promise.resolve(
          Response.json({ ok: true, channel: "bus", runId: "r", created: true }),
        );
      }
      if (pathname === "/api/stream") {
        streamAttempts += 1;
        return Promise.resolve(
          new Response(": open\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected broker route ${pathname}`));
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
    });
    const session = new Session("stream-open-eof", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      inboundRetryDelayMs: 0,
    });
    await relay.announce("open eof");

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({
      name: "BrokerError",
      status: 502,
      message: expect.stringContaining("broker stream ended unexpectedly"),
    });
    expect(streamAttempts).toBe(3);
    expect(session.closed).toBe(true);
    expect(busKinds).toEqual(["session_announce", "session_terminal"]);
  });

  it("keeps an idle session live across repeated broker-planned stream rotations", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(80));
    let streamAttempts = 0;
    const fetchFn: typeof fetch = ((input: RequestInfo | URL) => {
      const pathname = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (pathname === "/api/seq") {
        return Promise.resolve(Response.json({ maxSeq: null, durable: false }, { status: 200 }));
      }
      if (pathname === "/api/relay") {
        return Promise.resolve(
          Response.json({ ok: true, channel: "bus", runId: "r", created: true }),
        );
      }
      if (pathname === "/api/stream") {
        streamAttempts += 1;
        if (streamAttempts <= 6) {
          return Promise.resolve(
            new Response(": open\n\n: rotate\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected broker route ${pathname}`));
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
    });
    const session = new Session("stream-planned-rotations", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      inboundRetryDelayMs: 0,
    });
    const owner = new AbortController();
    const served = relay.serve(owner.signal);

    await waitFor(() => streamAttempts === 7);
    expect(session.closed).toBe(false);
    owner.abort();
    await served;
    expect(session.closed).toBe(false);
  });

  it("neither increments nor resets the failure circuit on planned rotations", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(81));
    let streamAttempts = 0;
    const fetchFn: typeof fetch = ((input: RequestInfo | URL) => {
      const pathname = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (pathname === "/api/seq") {
        return Promise.resolve(Response.json({ maxSeq: null, durable: false }, { status: 200 }));
      }
      if (pathname === "/api/relay") {
        return Promise.resolve(
          Response.json({ ok: true, channel: "bus", runId: "r", created: true }),
        );
      }
      if (pathname === "/api/stream") {
        streamAttempts += 1;
        if ([1, 5, 9].includes(streamAttempts)) {
          return Promise.resolve(new Response("temporary", { status: 503 }));
        }
        return Promise.resolve(
          new Response(": open\n\n: rotate\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected broker route ${pathname}`));
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
    });
    const session = new Session("stream-rotation-neutral", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      inboundRetryDelayMs: 0,
    });

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({ name: "BrokerError", status: 503 });
    expect(streamAttempts).toBe(9);
    expect(session.closed).toBe(true);
  });

  it("resets the real transport circuit only for an explicit empty-channel response", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(59));
    let streamAttempts = 0;
    const fetchFn: typeof fetch = ((input: RequestInfo | URL) => {
      const pathname = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (pathname === "/api/seq") {
        return Promise.resolve(Response.json({ maxSeq: null, durable: false }, { status: 200 }));
      }
      if (pathname === "/api/relay") {
        return Promise.resolve(
          Response.json({ ok: true, channel: "bus", runId: "r", created: true }),
        );
      }
      if (pathname === "/api/stream") {
        streamAttempts += 1;
        if ([1, 2, 4, 5].includes(streamAttempts)) {
          return Promise.resolve(new Response("temporary", { status: 503 }));
        }
        if (streamAttempts === 3) {
          return Promise.resolve(
            new Response(": empty\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": open\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected broker route ${pathname}`));
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
    });
    const session = new Session("stream-explicit-empty", "t", {});
    const relay = new HostRcRelay({
      client,
      identityId: identity.identityId,
      sessionId: session.id,
      session,
      inboundRetryDelayMs: 0,
    });
    const owner = new AbortController();
    const served = relay.serve(owner.signal);

    await waitFor(() => streamAttempts === 6);
    expect(session.closed).toBe(false);
    owner.abort();
    await served;
    expect(session.closed).toBe(false);
  });

  it("fails closed on the third consecutive selective stream 5xx", async () => {
    const session = new Session("s", "t", {});
    const client = new ScriptedInboundClient([
      { kind: "fail", status: 500 },
      { kind: "fail", status: 502 },
      { kind: "fail", status: 503 },
    ]);
    const relay = relayOf(session, client, undefined, { inboundRetryDelayMs: 0 });
    await relay.announce("selective failures");

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({ name: "BrokerError", status: 503 });
    expect(client.streamStarts).toHaveLength(3);
    expect(session.closed).toBe(true);
    expect(client.posts.some(({ recordKind }) => recordKind === "session_terminal")).toBe(true);
    await expect(relay.prepare()).rejects.toBe(failure);
  });

  it("resets consecutive failures only after a clean absent attempt or admitted frame", async () => {
    const session = new Session("s", "t", {});
    const client = new ScriptedInboundClient([
      { kind: "fail", status: 500 },
      { kind: "fail", status: 500 },
      { kind: "clean" }, // existing absent-channel success resets the first pair
      { kind: "fail", status: 502 },
      { kind: "fail", status: 502 },
      {
        kind: "frame-then-fail",
        frame: inFrame("catch_up", "admitted-reset", JSON.stringify({ since: 0 })),
        status: 503,
      }, // authenticated + handled frame resets, then this failure becomes #1
      { kind: "fail", status: 503 }, // #2 after admitted reset
      { kind: "park" },
    ]);
    const relay = relayOf(session, client, undefined, { inboundRetryDelayMs: 0 });
    const owner = new AbortController();
    const served = relay.serve(owner.signal);

    await waitFor(() => client.streamStarts.length === 8);
    expect(client.opened).toContain("admitted-reset");
    expect(session.closed).toBe(false);

    owner.abort();
    await served;
    expect(session.closed).toBe(false); // direct owner abort is lifecycle, not a fatal relay latch
  });

  it("does not let a replayed stable-disabled multipart attachment forgive stream failures", async () => {
    const replay = inChunk("attachment", "stable-multipart-replay", 0, 2, "partial");
    const session = new Session("s", "t", {});
    const client = new ScriptedInboundClient([
      { kind: "frame-then-fail", frame: replay, status: 503 },
      { kind: "frame-then-fail", frame: replay, status: 503 },
      { kind: "frame-then-fail", frame: replay, status: 503 },
      { kind: "park" },
    ]);
    client.reportedDurable = true;
    const relay = relayOf(session, client, STABLE_MITM_CAPABILITIES, {
      inboundRetryDelayMs: 0,
    });
    await relay.announce("stable multipart replay");

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({ name: "BrokerError", status: 503 });
    expect(client.streamStarts).toHaveLength(3);
    expect(client.opened.filter((msgId) => msgId === replay.msgId)).toHaveLength(3);
    expect(session.closed).toBe(true);
    expect(client.posts.some(({ recordKind }) => recordKind === "session_terminal")).toBe(true);
  });

  it("does not let incomplete attachment-group eviction masquerade as admitted progress", async () => {
    const partials = Array.from({ length: 5 }, (_unused, index) =>
      inChunk("attachment", `partial-group-${index}`, 0, 2, `piece-${index}`),
    );
    const session = new Session("s", "t", {});
    const client = new ScriptedInboundClient([
      { kind: "frames-then-fail", frames: partials, status: 503 },
      { kind: "frames-then-fail", frames: partials, status: 503 },
      { kind: "frames-then-fail", frames: partials, status: 503 },
      { kind: "park" },
    ]);
    const relay = relayOf(session, client, MITM_CAPABILITIES, { inboundRetryDelayMs: 0 });
    await relay.announce("partial attachment churn");

    const failure = await relay
      .serve(new AbortController().signal)
      .catch((error: unknown) => error);
    await relay.settlePresence();

    expect(failure).toMatchObject({ name: "BrokerError", status: 503 });
    expect(client.streamStarts).toHaveLength(3);
    expect(session.closed).toBe(true);
  });

  it("does not count a stream rejection raced with owner shutdown as fatal", async () => {
    const session = new Session("s", "t", {});
    const client = new ScriptedInboundClient([{ kind: "park", rejectOnAbort: true }]);
    const relay = relayOf(session, client, undefined, { inboundRetryDelayMs: 0 });
    const owner = new AbortController();
    const served = relay.serve(owner.signal);
    await waitFor(() => client.streamStarts.length === 1);

    owner.abort();
    await expect(served).resolves.toBeUndefined();
    expect(session.closed).toBe(false);
    expect(client.posts.some(({ recordKind }) => recordKind === "session_terminal")).toBe(false);
  });
});

describe("HostRcRelay inbound framing (single-frame invariant)", () => {
  it("drops a multi-part inbound frame instead of acting on a truncated first part", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    // A `user` frame claiming parts=2 (openFrame would yield only part 0 — a truncated prompt). It must
    // be dropped, NOT injected. A normal single-frame prompt follows and must still be processed (the
    // relay kept running, and the dropped frame burned no seq).
    client.queueInbound({ ...inFrame("user", "mp-1", "hello"), parts: 2 } as Frame);
    client.queueInbound(inFrame("user", "u-1", "world"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1); // only the single-frame prompt echoed
    expect(users[0]?.text).toBe("world"); // the multi-part "hello" was dropped, not injected
    expect(users[0]?.seq).toBe(0); // the dropped frame burned no seq
  });
});

// #5 — coverage backfills for the documented-but-untested control-verb auth invariant, the attachment
// size cap, and the shared-seq discipline under concurrent load.
describe("HostRcRelay control-verb auth + validation (#5)", () => {
  /** Drive one inbound control frame, then a benign `user` frame that proves the relay kept running;
   *  returns the spy on session.pushControlRequest so a test can assert what (if anything) it drove. */
  async function driveVerb(verb: string, msgId: string, bodyJson: string, failAead = false) {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    if (failAead) client.failOpen.add(msgId);
    const relay = relayOf(session, client);
    const spy = vi.spyOn(session, "pushControlRequest");
    client.queueInbound(inFrame(verb, msgId, bodyJson));
    client.queueInbound(inFrame("user", `after-${msgId}`, "ok"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;
    return spy;
  }

  it("rejects a verb whose frame fails AEAD open — never drives the action (forge-proof)", async () => {
    const spy = await driveVerb("interrupt", "v-aead", JSON.stringify({}), /* failAead */ true);
    expect(spy).not.toHaveBeenCalled(); // a forged/tampered interrupt must NOT reach the worker
  });

  it("drops a STALE (expired) control verb", async () => {
    const spy = await driveVerb(
      "set_model",
      "v-stale",
      JSON.stringify({ model: "opus", expiry: 1 }),
    );
    expect(spy).not.toHaveBeenCalled(); // expiry in the distant past → no-op
  });

  it("ignores a verb with a missing required field", async () => {
    const spy = await driveVerb("set_model", "v-nomodel", JSON.stringify({})); // no `model`
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores an authenticated-but-malformed (non-object) body", async () => {
    const spy = await driveVerb("set_mode", "v-bad", "42"); // valid JSON, not an object
    expect(spy).not.toHaveBeenCalled();
  });

  it("drives a valid, fresh verb through to the worker", async () => {
    const spy = await driveVerb(
      "set_model",
      "v-ok",
      JSON.stringify({ model: "opus", expiry: Date.now() + 60_000 }),
    );
    expect(spy).toHaveBeenCalledWith("set_model", { model: "opus" });
  });

  it("the `end` verb drives NO worker control_request (claude's REPL bridge rejects end_session)", async () => {
    // Verified against the claude 2.1.x binary: the control_request switch has no `end_session` case, so
    // it returns an error control_response ("REPL bridge does not handle control_request subtype:
    // end_session") — the real RC server hits the same wall (docs/protocol.md §11). So `end` must NOT
    // send a worker control_request; it only clears local gate state. The frame still authenticates
    // (AEAD-opened) and the relay keeps running (the trailing `user` frame is processed).
    const spy = await driveVerb("end", "v-end", JSON.stringify({ expiry: Date.now() + 60_000 }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("HostRcRelay attachment size cap (#5)", () => {
  it("rejects an over-cap attachment: nothing written, nothing echoed, no seq burned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-att-"));
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = new HostRcRelay({
      client: client as unknown as BrokerClient,
      identityId: ID,
      sessionId: "s",
      session,
      attachmentsDir: dir,
    });
    // `data` is well-formed base64 but one char over the cap → rejected before any side effect.
    const oversized = "A".repeat(MAX_ATTACHMENT_B64 + 4);
    client.queueInbound(
      inFrame(
        "attachment",
        "big-1",
        JSON.stringify({ name: "x.png", mime: "image/png", data: oversized }),
      ),
    );
    client.queueInbound(inFrame("user", "u-1", "after"));
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    await waitFor(() => client.content.some((p) => p.recordKind === "user"));
    ac.abort();
    await served;

    expect(readdirSync(dir)).toHaveLength(0); // nothing written
    const users = client.content.filter((p) => p.recordKind === "user");
    expect(users).toHaveLength(1); // only the real user frame echoed
    expect(users[0]?.seq).toBe(0); // the oversized attachment burned no seq
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("HostRcRelay seq discipline under load (#5)", () => {
  it("allocates a gap-free, dup-free seq run under interleaved upstream + inbound traffic", async () => {
    const session = new Session("s", "t", {});
    const client = new FakeClient();
    const relay = relayOf(session, client);
    const ac = new AbortController();
    const served = relay.serve(ac.signal).then(
      () => {},
      () => {},
    );
    // Interleave N upstream turns and N inbound prompts so both pumps allocate from the shared `#seq`.
    const N = 40;
    for (let i = 0; i < N; i++) {
      session.pushUpstream(assistant(`a${i}`));
      client.pushInbound(inFrame("user", `u${i}`, `p${i}`));
    }
    await waitFor(() => client.content.length >= 2 * N, 5000);
    ac.abort();
    await served;

    const seqs = (client.content.map((p) => p.seq) as number[]).sort((a, b) => a - b);
    expect(seqs).toHaveLength(2 * N); // every frame got a seq
    expect(new Set(seqs).size).toBe(2 * N); // …all distinct (no duplicate seq)
    expect(seqs[0]).toBe(0);
    expect(seqs[2 * N - 1]).toBe(2 * N - 1); // a contiguous 0..2N-1 run (no gap)
  });
});
