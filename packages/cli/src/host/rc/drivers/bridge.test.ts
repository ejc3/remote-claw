import { deriveIdentity, type Frame, type FrameHeader } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { BrokerClient } from "../../../broker/client.js";
import { securityProvider } from "../../../security/provider.js";
import { NOOP_TRACER } from "../../../trace.js";
import { type DriverCapabilities, MITM_CAPABILITIES, TMUX_HARNESS } from "../driver.js";
import { Session } from "../session.js";
import { bridgeSession, startBridgeSession } from "./bridge.js";

const ID = new Uint8Array(16);

class FakeClient {
  announces: Array<Record<string, unknown>> = [];
  busPosts: Array<{ header: FrameHeader; text: string }> = [];
  streamStarts = 0;
  seqCursorCalls = 0;
  frameCountCursorCalls = 0;
  failAnnounces = 0;
  announceBlocks: Promise<void>[] = [];
  durable = false;
  frameCountError: Error | null = null;
  failRecordKind: string | null = null;
  posts: Array<{ kind: string; seq: number | null; text: string }> = [];

  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    this.seqCursorCalls += 1;
    return { maxSeq: null, durable: this.durable };
  }

  async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    this.frameCountCursorCalls += 1;
    if (this.frameCountError !== null) throw this.frameCountError;
    return { frameCount: null, durable: this.durable };
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    if (header.recordKind === this.failRecordKind) throw new Error("injected publication failure");
    this.posts.push({
      kind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
    return [{ ok: true }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    const text = new TextDecoder().decode(body);
    if (header.recordKind === "session_announce") {
      const block = this.announceBlocks.shift();
      if (block !== undefined) await block;
      if (this.failAnnounces > 0) {
        this.failAnnounces -= 1;
        throw new Error("injected announce failure");
      }
      this.announces.push(JSON.parse(text));
    }
    this.busPosts.push({ header, text });
    return { ok: true };
  }

  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    this.streamStarts += 1;
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async openFrame(_frame: Frame): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

class DurableFirstCommandClient extends FakeClient {
  readonly frameCountStarted: Promise<void>;
  #markFrameCountStarted: () => void = () => {};
  #releaseFrameCount: () => void = () => {};
  readonly #frameCountReleased: Promise<void>;
  readonly #inbound: Frame[] = [];
  readonly #wakes = new Set<() => void>();

  constructor() {
    super();
    this.durable = true;
    this.frameCountStarted = new Promise<void>((resolve) => {
      this.#markFrameCountStarted = resolve;
    });
    this.#frameCountReleased = new Promise<void>((resolve) => {
      this.#releaseFrameCount = resolve;
    });
  }

  releaseFrameCount(): void {
    this.#releaseFrameCount();
  }

  pushInbound(frame: Frame): void {
    this.#inbound.push(frame);
    for (const wake of this.#wakes) wake();
    this.#wakes.clear();
  }

  override async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    this.frameCountCursorCalls += 1;
    this.#markFrameCountStarted();
    await this.#frameCountReleased;
    return { frameCount: this.#inbound.length, durable: true };
  }

  override async *streamFrames(opts: {
    startIndex?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<Frame> {
    this.streamStarts += 1;
    let cursor = opts.startIndex ?? 0;
    for (;;) {
      while (cursor < this.#inbound.length) {
        const frame = this.#inbound[cursor++];
        if (frame !== undefined) yield frame;
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

  override async openFrame(frame: Frame): Promise<Uint8Array> {
    return frame.ct;
  }
}

function inboundUser(msgId: string, text: string): Frame {
  return {
    v: 1,
    identityId: ID,
    sessionId: "durable",
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    salt: new Uint8Array(32),
    nonce: new Uint8Array(12),
    ct: new TextEncoder().encode(text),
  } as Frame;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await tick();
  if (!predicate()) throw new Error("timed out");
}

describe("bridge lifecycle", () => {
  it("bounds a never-settling startup cursor, exhausts three attempts, and closes before advertise", async () => {
    const identity = await deriveIdentity(new Uint8Array(32).fill(53));
    const cursorSignals: AbortSignal[] = [];
    const fetchFn: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) cursorSignals.push(init.signal);
      return new Promise<Response>(() => {}); // intentionally ignores AbortSignal
    }) as typeof fetch;
    const client = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", identity),
      fetchFn,
      cursorTimeoutMs: 10,
    });
    const session = new Session("cursor-stall", "session", {});
    const relays = new Set<Promise<void>>();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client,
      identityId: identity.identityId,
      title: "must not advertise",
      cwd: "/repo",
      git: null,
      signal: new AbortController().signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });

    await handle.served;

    expect(cursorSignals).toHaveLength(3);
    expect(cursorSignals.every((signal) => signal.aborted)).toBe(true);
    expect(session.closed).toBe(true);
    expect(relays.has(handle.served)).toBe(false);
  });

  it("freezes the durable inbound cursor before discoverability, then handles the first command", async () => {
    const session = new Session("durable", "session", {});
    const client = new DurableFirstCommandClient();
    const pushed: string[] = [];
    const originalPushUserInput = session.pushUserInput.bind(session);
    session.pushUserInput = (text: string) => {
      pushed.push(text);
      return originalPushUserInput(text);
    };
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "durable",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });

    await client.frameCountStarted;
    await tick();
    expect(client.announces).toHaveLength(0);
    expect(client.streamStarts).toBe(0);

    client.releaseFrameCount();
    await waitFor(() => client.announces.length === 1 && client.streamStarts === 1);
    client.pushInbound(inboundUser("first-command", "hello after discovery"));
    await waitFor(() => pushed.length === 1);

    expect(pushed).toEqual(["hello after discovery"]);
    expect(client.posts.map((post) => post.kind)).toEqual(["accepted", "user"]);

    abort.abort();
    await handle.served;
  });

  it("refreshes one live bridge without restarting its pumps", async () => {
    const session = new Session("s", "session", {});
    const client = new FakeClient();
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/old",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });
    const readyCapabilities: DriverCapabilities = {
      structuredPermissions: false,
      status: true,
      controls: { interrupt: true, setModel: false, setMode: false, end: false },
      attachments: false,
    };
    const git = { branch: "main", sha: "deadbeef", dirty: false, ahead: 0, behind: 0 };

    await waitFor(() => client.announces.length === 1 && client.streamStarts === 1);
    expect(relays.has(handle.served)).toBe(true);
    await handle.refresh({
      title: "ready",
      cwd: "/new",
      git,
      capabilities: readyCapabilities,
    });

    expect(client.streamStarts).toBe(1);
    expect(client.announces).toHaveLength(2);
    expect(client.announces.at(-1)).toMatchObject({
      title: "ready",
      cwd: "/new",
      git,
      capabilities: readyCapabilities,
      harness: TMUX_HARNESS,
    });

    client.failAnnounces = 1;
    const retainedCapabilities: DriverCapabilities = {
      structuredPermissions: true,
      status: false,
      controls: { interrupt: true, setModel: false, setMode: true, end: false },
      attachments: false,
    };
    await expect(
      handle.refresh({
        title: "missed",
        cwd: "/missed",
        git: null,
        capabilities: retainedCapabilities,
      }),
    ).rejects.toThrow("injected announce failure");

    // Advisory delivery failed, but the validated snapshot is still the relay's latest truth. A
    // presence change must re-announce that snapshot without requiring the owner to replay refresh().
    session.workerStatus = "running";
    session.wake();
    await waitFor(() => client.announces.length === 3);
    expect(client.announces.at(-1)).toMatchObject({
      title: "missed",
      cwd: "/missed",
      git: null,
      capabilities: retainedCapabilities,
      harness: TMUX_HARNESS,
      status: "running",
      phase: "thinking",
    });

    await handle.refresh({
      title: "recovered",
      cwd: "/recovered",
      git,
      capabilities: readyCapabilities,
    });
    expect(client.announces).toHaveLength(4);
    expect(client.announces.at(-1)?.title).toBe("recovered");
    expect(client.streamStarts).toBe(1);

    abort.abort();
    await handle.served;
    expect(relays.has(handle.served)).toBe(false);
  });

  it("captures a queued refresh snapshot when refresh is called", async () => {
    const session = new Session("queued", "session", {});
    const client = new FakeClient();
    let releaseInitial = () => {};
    client.announceBlocks.push(
      new Promise<void>((resolve) => {
        releaseInitial = resolve;
      }),
    );
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/old",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });
    const capabilities: DriverCapabilities = {
      structuredPermissions: false,
      status: true,
      controls: { interrupt: true, setModel: false, setMode: false, end: false },
      attachments: true,
    };
    const git = { branch: "main", sha: "12345678", dirty: false, ahead: 0, behind: 0 };
    const announcement = {
      title: "captured",
      cwd: "/captured",
      git,
      capabilities,
    };

    const refreshing = handle.refresh(announcement);
    announcement.title = "mutated";
    announcement.cwd = "/mutated";
    git.branch = "mutated";
    capabilities.status = false;
    capabilities.controls.interrupt = false;
    releaseInitial();
    await refreshing;

    expect(client.announces).toHaveLength(2);
    expect(client.announces.at(-1)).toMatchObject({
      title: "captured",
      cwd: "/captured",
      git: { branch: "main" },
      capabilities: {
        status: true,
        controls: { interrupt: true },
      },
    });

    abort.abort();
    await handle.served;
  });

  it("overtakes a delayed live announce with terminality and drops queued refreshes on abort", async () => {
    const session = new Session("delayed", "session", {});
    const client = new FakeClient();
    let releaseInitial = () => {};
    client.announceBlocks.push(
      new Promise<void>((resolve) => {
        releaseInitial = resolve;
      }),
    );
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });
    const refreshing = handle.refresh({
      title: "ready",
      cwd: "/repo",
      git: null,
      capabilities: MITM_CAPABILITIES,
    });

    await waitFor(() => client.streamStarts === 1);
    abort.abort();
    await waitFor(() =>
      client.busPosts.some(({ header }) => header.recordKind === "session_terminal"),
    );
    const terminal = client.busPosts.find(({ header }) => header.recordKind === "session_terminal");
    expect(terminal).toEqual({
      header: {
        v: 1,
        identityId: ID,
        sessionId: "delayed",
        dir: "out",
        recordKind: "session_terminal",
        seq: null,
        msgId: "terminal-delayed",
        keyEpoch: 0,
        part: 0,
        parts: 1,
      },
      text: '{"v":1}',
    });
    expect(session.closed).toBe(true);
    expect(client.announces).toHaveLength(0);
    await expect(refreshing).rejects.toThrow("bridge is no longer serving");
    await expect(
      handle.refresh({
        title: "dead",
        cwd: "/repo",
        git: null,
        capabilities: MITM_CAPABILITIES,
      }),
    ).rejects.toThrow("bridge is no longer serving");

    let teardownFinished = false;
    void handle.served.then(() => {
      teardownFinished = true;
    });
    await tick();
    expect(teardownFinished).toBe(false);
    expect(relays.has(handle.served)).toBe(true);

    releaseInitial();
    await handle.served;
    expect(client.busPosts.map(({ header }) => header.recordKind)).toEqual([
      "session_terminal",
      "session_announce",
    ]);
    expect(client.announces.map((announcement) => announcement.title)).toEqual(["starting"]);
    expect(relays.has(handle.served)).toBe(false);
  });

  it("rejects refresh after a fatal relay termination", async () => {
    const session = new Session("fatal", "session", {});
    const client = new FakeClient();
    client.durable = true;
    client.frameCountError = new Error("injected durable cursor failure");
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const siblingSession = new Session("healthy", "session", {});
    const siblingClient = new FakeClient();
    const siblingAbort = new AbortController();
    const sibling = startBridgeSession({
      session: siblingSession,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => siblingClient as unknown as BrokerClient,
      identityId: ID,
      title: "healthy",
      cwd: "/repo",
      git: null,
      signal: siblingAbort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });

    await handle.served;
    expect(session.closed).toBe(true); // prepare failed before a pump could close it: bridge backstop
    expect(siblingSession.closed).toBe(false); // the fatal boundary is this cse, not every live bridge
    expect(client.announces).toHaveLength(0);
    expect(client.streamStarts).toBe(0);
    expect(relays.has(handle.served)).toBe(false);
    expect(relays.has(sibling.served)).toBe(true);
    await expect(
      handle.refresh({
        title: "dead",
        cwd: "/repo",
        git: null,
        capabilities: MITM_CAPABILITIES,
      }),
    ).rejects.toThrow("bridge is no longer serving");
    expect(client.announces).toHaveLength(0);

    siblingAbort.abort();
    await sibling.served;
    expect(siblingSession.closed).toBe(true); // A0 has no supported bridge reattachment after owner exit
  });

  it("isolates a fatal publication to one live bridge while its sibling keeps projecting", async () => {
    const failedSession = new Session("failed", "failed", {});
    const healthySession = new Session("healthy-publication", "healthy", {});
    const failedClient = new FakeClient();
    failedClient.failRecordKind = "assistant";
    const healthyClient = new FakeClient();
    const relays = new Set<Promise<void>>();
    const failedAbort = new AbortController();
    const healthyAbort = new AbortController();
    const failed = startBridgeSession({
      session: failedSession,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => failedClient as unknown as BrokerClient,
      identityId: ID,
      title: "failed",
      cwd: "/repo",
      git: null,
      signal: failedAbort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });
    const healthy = startBridgeSession({
      session: healthySession,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => healthyClient as unknown as BrokerClient,
      identityId: ID,
      title: "healthy",
      cwd: "/repo",
      git: null,
      signal: healthyAbort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });
    await waitFor(() => failedClient.streamStarts === 1 && healthyClient.streamStarts === 1);

    failedSession.pushUpstream({
      type: "assistant",
      message: { content: [{ type: "text", text: "fail" }] },
    });
    healthySession.pushUpstream({
      type: "assistant",
      message: { content: [{ type: "text", text: "survive" }] },
    });

    await failed.served;
    await waitFor(() => healthyClient.posts.some((post) => post.kind === "assistant"));
    expect(failedSession.closed).toBe(true);
    expect(healthySession.closed).toBe(false);
    expect(healthyClient.posts.find((post) => post.kind === "assistant")?.text).toContain(
      "survive",
    );
    expect(relays.has(healthy.served)).toBe(true);

    healthyAbort.abort();
    await healthy.served;
  });

  it("does not announce a bridge whose owner is already aborted", async () => {
    const session = new Session("already-stopped", "session", {});
    const client = new FakeClient();
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    abort.abort();

    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "ghost",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });

    await handle.served;
    expect(session.closed).toBe(true);
    expect(client.announces).toHaveLength(0);
    expect(client.busPosts).toHaveLength(0); // no live announce was ever admitted, so no tombstone needed
    expect(client.seqCursorCalls).toBe(0);
    expect(client.frameCountCursorCalls).toBe(0);
    expect(client.streamStarts).toBe(0);
    await expect(
      handle.refresh({
        title: "still dead",
        cwd: "/repo",
        git: null,
        capabilities: MITM_CAPABILITIES,
      }),
    ).rejects.toThrow("bridge is no longer serving");
  });

  it("does not advertise or serve a Session that fail-stops before its durable barrier settles", async () => {
    const session = new Session("native-failed", "session", {});
    const client = new DurableFirstCommandClient();
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "must stay hidden",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });

    await client.frameCountStarted;
    session.close();
    client.releaseFrameCount();
    await handle.served;

    expect(client.announces).toHaveLength(0);
    expect(client.streamStarts).toBe(0);
    expect(relays.has(handle.served)).toBe(false);
    await expect(
      handle.refresh({
        title: "still hidden",
        cwd: "/repo",
        git: null,
        capabilities: MITM_CAPABILITIES,
      }),
    ).rejects.toThrow("bridge is no longer serving");
  });

  it("keeps bridgeSession as the served-promise compatibility API", async () => {
    const session = new Session("legacy", "session", {});
    const client = new FakeClient();
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();

    const served = bridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "legacy",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      terminalTasks: new Set(),
      tracer: NOOP_TRACER,
    });

    expect(served).toBeInstanceOf(Promise);
    expect(relays.has(served)).toBe(true);
    abort.abort();
    await served;
    expect(session.closed).toBe(true);
    expect(relays.has(served)).toBe(false);
  });
});
