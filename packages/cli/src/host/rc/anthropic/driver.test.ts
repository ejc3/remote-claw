import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { DriverContext } from "../driver.js";
import type { MitmOptions } from "../mitm.js";
import type { Session } from "../session.js";
import type {
  AnthropicRcEvent,
  RcEventPage,
  RcPostAck,
  RcSseItem,
  RcUserEventInput,
} from "./client.js";
import { type ClaudeNativeClient, ClaudeNativeDriver, type ClaudeNativeProxy } from "./driver.js";
import { AnthropicRcError } from "./errors.js";

const ID = new Uint8Array(16);
const enc = new TextEncoder();
const dec = new TextDecoder();
const CERTS_DIR = mkdtempSync(join(tmpdir(), "rc-native-driver-"));

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

afterAll(() => rmSync(CERTS_DIR, { recursive: true, force: true }));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await tick();
  if (!predicate()) throw new Error("timed out");
}

class NativeStream {
  readonly sessionIds: string[] = [];
  #items: RcSseItem[] = [];
  #cursor = 0;
  #ended = false;
  #wakes = new Set<() => void>();

  push(event: AnthropicRcEvent): void {
    this.#items.push({
      kind: "event",
      eventName: "client_event",
      sseId: null,
      data: event.raw,
      event,
    });
    this.#wake();
  }

  end(): void {
    this.#ended = true;
    this.#wake();
  }

  async *iterate(
    sessionId: string,
    options: { signal: AbortSignal; onOpen?: () => void },
    onStart: () => void,
  ): AsyncGenerator<RcSseItem> {
    this.sessionIds.push(sessionId);
    onStart();
    options.onOpen?.();
    for (;;) {
      while (this.#cursor < this.#items.length) {
        const item = this.#items[this.#cursor++];
        if (item !== undefined) yield item;
      }
      if (this.#ended || options.signal.aborted) return;
      await this.#wait(options.signal);
    }
  }

  #wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.#wakes.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#wakes.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #wake(): void {
    for (const wake of this.#wakes) wake();
    this.#wakes.clear();
  }
}

class FakeNativeClient implements ClaudeNativeClient {
  readonly order: string[] = [];
  readonly streams = [new NativeStream()];
  readonly historyCalls: Array<{ sessionId: string; cursor: string | undefined }> = [];
  readonly postCalls: Array<{ sessionId: string; input: RcUserEventInput }> = [];
  historyImpl: (
    sessionId: string,
    cursor: string | undefined,
    call: number,
  ) => Promise<RcEventPage> = async () => ({ data: [], nextCursor: null });
  postImpl: (sessionId: string, input: RcUserEventInput, call: number) => Promise<RcPostAck> =
    async (_sessionId, _input, call) => ({
      eventId: `evt_ack_${call}`,
      sequenceNum: String(call + 1),
      duplicate: false,
    });

  history(
    sessionId: string,
    options: { cursor?: string; signal?: AbortSignal } = {},
  ): Promise<RcEventPage> {
    const call = this.historyCalls.length;
    this.historyCalls.push({ sessionId, cursor: options.cursor });
    this.order.push(`history:${sessionId}:${options.cursor ?? "-"}`);
    return this.historyImpl(sessionId, options.cursor, call);
  }

  streamEvents(
    sessionId: string,
    options: { signal: AbortSignal; onOpen?: () => void },
  ): AsyncGenerator<RcSseItem> {
    const call = this.streams.findIndex((stream) => stream.sessionIds.length === 0);
    const stream = call < 0 ? undefined : this.streams[call];
    if (stream === undefined) throw new Error("no scripted native stream");
    return stream.iterate(sessionId, options, () => this.order.push(`subscribe:${sessionId}`));
  }

  postEvent(sessionId: string, input: RcUserEventInput): Promise<RcPostAck> {
    const call = this.postCalls.length;
    this.postCalls.push({ sessionId, input });
    this.order.push(`post:${sessionId}:${input.message.content}`);
    return this.postImpl(sessionId, input, call);
  }
}

interface Posted {
  header: FrameHeader;
  text: string;
}

class FakeBroker {
  readonly posts: Posted[] = [];
  readonly bus: Posted[] = [];
  readonly announcements: Array<Record<string, unknown>> = [];
  streamStarts = 0;
  failContentPosts = false;
  #inbound: Frame[] = [];
  #wakes = new Set<() => void>();

  get content(): Posted[] {
    return this.posts.filter(({ header }) => header.seq !== null);
  }

  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    return { maxSeq: null, durable: true };
  }

  async frameCountCursor(): Promise<{ frameCount: number; durable: boolean }> {
    return { frameCount: this.#inbound.length, durable: true };
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    if (this.failContentPosts && header.seq !== null) {
      throw new Error("injected broker content loss");
    }
    this.posts.push({ header, text: dec.decode(body) });
    return [{ ok: true, channel: "session", runId: "r", created: false }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    const posted = { header, text: dec.decode(body) };
    this.bus.push(posted);
    if (header.recordKind === "session_announce") {
      this.announcements.push(JSON.parse(posted.text));
    }
    return { ok: true, channel: "bus", runId: "r", created: false };
  }

  push(frame: Frame): void {
    this.#inbound.push(frame);
    for (const wake of this.#wakes) wake();
    this.#wakes.clear();
  }

  async *streamFrames(options: {
    startIndex?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<Frame> {
    this.streamStarts += 1;
    let cursor = options.startIndex ?? 0;
    for (;;) {
      while (cursor < this.#inbound.length) {
        const frame = this.#inbound[cursor++];
        if (frame !== undefined) yield frame;
      }
      if (options.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          this.#wakes.delete(done);
          options.signal?.removeEventListener("abort", done);
          resolve();
        };
        this.#wakes.add(done);
        options.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  async openFrame(frame: Frame): Promise<Uint8Array> {
    return frame.ct;
  }
}

class FakeProxy implements ClaudeNativeProxy {
  readonly port = 43123;
  listened = false;
  closed = false;

  constructor(readonly options: MitmOptions) {}

  async listen(): Promise<void> {
    this.listened = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  bridge(nativeId: string): void {
    if (!this.listened) throw new Error("proxy is not listening");
    this.options.onTraceBridge?.(nativeId);
  }
}

interface Harness {
  native: FakeNativeClient;
  broker: FakeBroker;
  proxy: FakeProxy;
  session: Session;
  parent: AbortController;
  child: PromiseWithResolvers<number>;
  run: Promise<number>;
  brokerState: { creations: number };
  spawn: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  isRunSettled(): boolean;
  stop(): Promise<void>;
}

async function startHarness(options: { projectionCoordinateCap?: number } = {}): Promise<Harness> {
  const native = new FakeNativeClient();
  const broker = new FakeBroker();
  const brokerState = { creations: 0 };
  const child = Promise.withResolvers<number>();
  const parent = new AbortController();
  let session: Session | null = null;
  let proxy: FakeProxy | null = null;
  let spawn: Harness["spawn"] | null = null;
  let settled = false;
  const context: DriverContext = {
    harnessArgs: ["--remote-control", "fixture"],
    harnessBin: "unused-context-bin",
    identity: { identityId: ID } as DriverContext["identity"],
    brokerUrl: "https://broker.test",
    title: "native projection",
    cwd: "/repo",
    git: null,
    newClient: () => {
      brokerState.creations += 1;
      return broker as unknown as BrokerClient;
    },
    onSession: (created) => {
      session = created;
    },
  };
  const driver = new ClaudeNativeDriver(context, {
    certsDir: CERTS_DIR,
    claudeBin: "claude-fixture",
    client: native,
    reconnectDelayMs: 0,
    ...(options.projectionCoordinateCap === undefined
      ? {}
      : { projectionCoordinateCap: options.projectionCoordinateCap }),
    proxyFactory: (options) => {
      proxy = new FakeProxy(options);
      return proxy;
    },
    spawnClaude: async (bin, args, env) => {
      spawn = { bin, args: [...args], env };
      return child.promise;
    },
  });
  const run = driver.run(parent.signal);
  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await waitFor(() => session !== null && proxy !== null && spawn !== null);
  if (session === null || proxy === null || spawn === null)
    throw new Error("driver did not launch");

  return {
    native,
    broker,
    proxy,
    session,
    parent,
    child,
    run,
    brokerState,
    spawn,
    isRunSettled: () => settled,
    async stop() {
      parent.abort();
      child.resolve(0);
      await run;
    },
  };
}

interface AttachHarness {
  native: FakeNativeClient;
  broker: FakeBroker;
  session: Session;
  parent: AbortController;
  run: Promise<number>;
  ready(): Promise<void>;
  unusedOwnerCalls(): { proxy: number; spawn: number };
  stop(): Promise<number>;
}

async function startAttachHarness(options: {
  native: FakeNativeClient;
  broker: FakeBroker;
  nativeSessionId: string;
}): Promise<AttachHarness> {
  const parent = new AbortController();
  const announcementFloor = options.broker.announcements.length;
  const streamFloor = options.broker.streamStarts;
  let session: Session | null = null;
  let proxyCalls = 0;
  let spawnCalls = 0;
  const context: DriverContext = {
    harnessArgs: [],
    harnessBin: "must-not-spawn",
    identity: { identityId: ID } as DriverContext["identity"],
    brokerUrl: "https://broker.test",
    title: "native attachment",
    cwd: "/repo",
    git: null,
    newClient: () => options.broker as unknown as BrokerClient,
    onSession: (created) => {
      session = created;
    },
  };
  const driver = new ClaudeNativeDriver(context, {
    nativeSessionId: options.nativeSessionId,
    // These launch-only dependencies are traps: direct attachment must never touch any of them.
    certsDir: "",
    claudeBin: "must-not-spawn",
    client: options.native,
    reconnectDelayMs: 0,
    proxyFactory: () => {
      proxyCalls += 1;
      throw new Error("attach-only mode created a proxy");
    },
    spawnClaude: async () => {
      spawnCalls += 1;
      throw new Error("attach-only mode spawned Claude");
    },
  });
  const run = driver.run(parent.signal);
  await waitFor(() => session !== null);
  if (session === null) throw new Error("attach-only driver did not create a projection");

  return {
    native: options.native,
    broker: options.broker,
    session,
    parent,
    run,
    async ready() {
      await waitFor(
        () =>
          options.broker.announcements.length === announcementFloor + 1 &&
          options.broker.streamStarts === streamFloor + 1,
      );
    },
    unusedOwnerCalls: () => ({ proxy: proxyCalls, spawn: spawnCalls }),
    async stop() {
      parent.abort();
      return run;
    },
  };
}

async function bindReady(harness: Harness, nativeId = "cse_provider"): Promise<void> {
  harness.proxy.bridge(nativeId);
  await waitFor(
    () => harness.broker.announcements.length === 1 && harness.broker.streamStarts === 1,
  );
}

function assistant(eventId: string, sequenceNum: string, text: string): AnthropicRcEvent {
  const payload = { type: "assistant", message: { role: "assistant", content: text } };
  return {
    eventId,
    eventType: "assistant",
    sequenceNum,
    source: "worker",
    createdAt: `2026-08-30T00:00:${sequenceNum.padStart(2, "0")}.000Z`,
    payload,
    raw: { event_id: eventId, event_type: "assistant", sequence_num: sequenceNum, payload },
  };
}

function userEvent(
  eventId: string,
  sequenceNum: string,
  uuid: string,
  text: string,
  nativeId: string,
  source: "client" | "worker" = "client",
  timestamp = "2026-08-30T00:01:00.000Z",
): AnthropicRcEvent {
  const payload = {
    type: "user",
    uuid,
    session_id: nativeId,
    timestamp,
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
  return {
    eventId,
    eventType: "user",
    sequenceNum,
    source,
    createdAt: `2026-08-30T00:01:${sequenceNum.padStart(2, "0")}.000Z`,
    payload,
    raw: { event_id: eventId, event_type: "user", sequence_num: sequenceNum, payload },
  };
}

/** Minimal provider shape retained from the official iOS client (credentials/content removed). */
function iosClientUserEvent(
  eventId: string,
  sequenceNum: string,
  uuid: string,
  text: string,
  options: { fileAttachments?: readonly Readonly<Record<string, unknown>>[] } = {},
): AnthropicRcEvent {
  const payload = {
    client_platform: "ios",
    ...(options.fileAttachments === undefined ? {} : { file_attachments: options.fileAttachments }),
    message: { content: text, role: "user" },
    type: "user",
    uuid,
  };
  return {
    eventId,
    eventType: "user",
    sequenceNum,
    source: "client",
    createdAt: "2026-06-13T20:48:35.127455Z",
    payload,
    raw: { event_id: eventId, event_type: "user", sequence_num: sequenceNum, payload },
  };
}

function workerToolResult(
  eventId: string,
  sequenceNum: string,
  nativeId: string,
): AnthropicRcEvent {
  const payload = {
    type: "user",
    uuid: `tool-result-${sequenceNum}`,
    session_id: nativeId,
    timestamp: "2026-08-30T00:01:30.000Z",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "local output" }],
    },
  };
  return {
    eventId,
    eventType: "user",
    sequenceNum,
    source: "worker",
    createdAt: "2026-08-30T00:01:30.000Z",
    payload,
    raw: { event_id: eventId, event_type: "user", sequence_num: sequenceNum, payload },
  };
}

function inbound(
  harness: { session: Session },
  recordKind: string,
  msgId: string,
  text: string,
  clientMsgId?: string,
): Frame {
  return {
    v: 1,
    identityId: ID,
    sessionId: harness.session.id,
    dir: "in",
    recordKind,
    seq: null,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...(clientMsgId === undefined ? {} : { clientMsgId }),
    salt: new Uint8Array(32),
    nonce: new Uint8Array(12),
    ct: enc.encode(text),
  } as Frame;
}

function acceptedBodies(harness: Harness): Array<Record<string, unknown>> {
  return harness.broker.posts
    .filter(({ header }) => header.recordKind === "accepted")
    .map(({ text }) => JSON.parse(text));
}

describe("ClaudeNativeDriver direct attachment lifecycle", () => {
  it("reattaches one native session through a fresh isolated projection without repeating a prior write", async () => {
    const nativeId = "cse_restart_exact";
    const native = new FakeNativeClient();
    const broker = new FakeBroker();
    const initial = assistant("evt_initial", "1", "history once");
    const lostResponse = Promise.withResolvers<RcPostAck>();
    const secondHistory = Promise.withResolvers<RcEventPage>();
    const secondHistoryStarted = Promise.withResolvers<void>();
    let committed: AnthropicRcEvent | null = null;

    native.historyImpl = async (_sessionId, _cursor, call) => {
      if (call === 0) return { data: [initial], nextCursor: null };
      secondHistoryStarted.resolve();
      return secondHistory.promise;
    };
    native.postImpl = async (_sessionId, input, call) => {
      if (call === 0) {
        committed = userEvent(
          "evt_committed",
          "2",
          input.uuid,
          input.message.content,
          nativeId,
          "client",
          input.timestamp,
        );
        return lostResponse.promise;
      }
      return { eventId: `evt_fresh_${call}`, sequenceNum: String(call + 2), duplicate: false };
    };

    const first = await startAttachHarness({ native, broker, nativeSessionId: nativeId });
    let second: AttachHarness | undefined;
    try {
      await first.ready();
      await waitFor(
        () =>
          broker.content.filter(({ header }) => header.sessionId === first.session.id).length === 1,
      );
      broker.push(inbound(first, "user", "first-command", "committed once", "first-client"));
      await waitFor(() => native.postCalls.length === 1 && committed !== null);

      expect(await first.stop()).toBe(0);
      expect(
        broker.bus.filter(
          ({ header }) =>
            header.recordKind === "session_terminal" && header.sessionId === first.session.id,
        ),
      ).toHaveLength(1);

      native.streams.push(new NativeStream());
      second = await startAttachHarness({ native, broker, nativeSessionId: nativeId });
      await secondHistoryStarted.promise;
      if (committed === null) throw new Error("provider mutation was not committed");
      native.streams[1]?.push(committed);
      secondHistory.resolve({ data: [initial, committed], nextCursor: null });
      await second.ready();
      await waitFor(
        () =>
          broker.content.filter(({ header }) => header.sessionId === second?.session.id).length ===
          2,
      );

      expect(second.session.id).not.toBe(first.session.id);
      expect(native.streams[0]?.sessionIds).toEqual([nativeId]);
      expect(native.streams[1]?.sessionIds).toEqual([nativeId]);
      expect(
        broker.content
          .filter(({ header }) => header.sessionId === second?.session.id)
          .map(({ text }) => text),
      ).toEqual(["history once", "committed once"]);

      // A stale viewer may still publish to the retired channel. The fresh projection must skip it, then
      // consume only a command addressed to its own new channel.
      broker.push(inbound(first, "user", "retired-command", "must not repeat"));
      broker.push(inbound(second, "user", "fresh-command", "new projection write"));
      await waitFor(() => native.postCalls.length === 2);
      expect(native.postCalls.map(({ input }) => input.message.content)).toEqual([
        "committed once",
        "new projection write",
      ]);
      expect(
        native.postCalls.filter(({ input }) => input.message.content === "committed once"),
      ).toHaveLength(1);
      expect(first.unusedOwnerCalls()).toEqual({ proxy: 0, spawn: 0 });
      expect(second.unusedOwnerCalls()).toEqual({ proxy: 0, spawn: 0 });
    } finally {
      secondHistory.resolve({ data: [], nextCursor: null });
      lostResponse.resolve({ eventId: "evt_committed", sequenceNum: "2", duplicate: false });
      if (!first.parent.signal.aborted) await first.stop();
      if (second !== undefined && !second.parent.signal.aborted) await second.stop();
    }
  });

  it("returns failure when broker loss ends an attach-only projection", async () => {
    const native = new FakeNativeClient();
    const broker = new FakeBroker();
    const harness = await startAttachHarness({
      native,
      broker,
      nativeSessionId: "cse_attach_broker_loss",
    });

    await harness.ready();
    broker.failContentPosts = true;
    native.streams[0]?.push(assistant("evt_attach_broker_loss", "1", "cannot publish"));

    await expect(harness.run).resolves.toBe(1);
    expect(harness.session.closed).toBe(true);
    expect(harness.unusedOwnerCalls()).toEqual({ proxy: 0, spawn: 0 });
  });
});

describe.skipIf(!haveOpenssl())("ClaudeNativeDriver integration", () => {
  it("binds the exact native id to a distinct projection and scrubs the spawned child", async () => {
    const scrubbed = [
      "NO_PROXY",
      "no_proxy",
      "REMOTE_CLAW_SECRET_FILE",
      "VERCEL_AUTOMATION_BYPASS_SECRET",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
    ] as const;
    const saved = Object.fromEntries(scrubbed.map((key) => [key, process.env[key]]));
    for (const key of scrubbed) process.env[key] = `must-not-reach-child-${key}`;
    let harness: Harness | undefined;
    try {
      harness = await startHarness();
    } finally {
      for (const key of scrubbed) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    try {
      expect(harness.spawn.bin).toBe("claude-fixture");
      expect(harness.spawn.args).toEqual(["--remote-control", "fixture"]);
      expect(harness.spawn.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${harness.proxy.port}`);
      expect(harness.spawn.env.NODE_EXTRA_CA_CERTS).toContain(CERTS_DIR);
      for (const key of scrubbed) expect(key in harness.spawn.env).toBe(false);

      await bindReady(harness, "cse_provider_exact");
      expect(harness.session.id).not.toBe("cse_provider_exact");
      expect(harness.native.streams[0]?.sessionIds).toEqual(["cse_provider_exact"]);
      expect(harness.native.historyCalls.map(({ sessionId }) => sessionId)).toEqual([
        "cse_provider_exact",
      ]);
      expect(harness.broker.announcements[0]).toMatchObject({
        session_id: harness.session.id,
        harness: { agent: "claude-code", mode: "native-rc" },
      });

      harness.proxy.bridge("cse_provider_exact");
      await tick();
      expect(harness.session.closed).toBe(false);
      harness.proxy.bridge("cse_provider_other");
      await waitFor(() => harness?.session.closed === true);
      expect(harness.isRunSettled()).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("subscribes before history and deduplicates overlap in provider order", async () => {
    const harness = await startHarness();
    const historyStarted = Promise.withResolvers<void>();
    const history = Promise.withResolvers<RcEventPage>();
    harness.native.historyImpl = async () => {
      historyStarted.resolve();
      return history.promise;
    };
    const first = assistant("evt_first", "1", "first string");
    const localUser = userEvent(
      "evt_local",
      "2",
      "local-tui-uuid",
      "typed locally",
      "cse_overlap",
      "worker",
    );
    const unsupported = workerToolResult("evt_tool_result", "3", "cse_overlap");
    const overlap = assistant("evt_overlap", "4", "overlap string");

    try {
      harness.proxy.bridge("cse_overlap");
      await historyStarted.promise;
      harness.native.streams[0]?.push(overlap);
      history.resolve({ data: [overlap, unsupported, localUser, first], nextCursor: null });
      await waitFor(() => harness.broker.content.length === 3);
      harness.native.streams[0]?.push(assistant("evt_live", "5", "live after overlap"));
      await waitFor(() => harness.broker.content.length === 4);
      harness.session.pushUserInput("write after unsupported user");
      await waitFor(() => harness.native.postCalls.length === 1);

      expect(harness.native.order.slice(0, 2)).toEqual([
        "subscribe:cse_overlap",
        "history:cse_overlap:-",
      ]);
      expect(
        harness.broker.content.map(({ header, text }) => [header.seq, header.recordKind, text]),
      ).toEqual([
        [0, "assistant", "first string"],
        [1, "user", "typed locally"],
        [2, "assistant", "overlap string"],
        [3, "assistant", "live after overlap"],
      ]);
      expect(harness.session.snapshotUpstream()).toHaveLength(4);
      expect(harness.native.postCalls[0]?.input.message.content).toBe(
        "write after unsupported user",
      );
      expect(harness.session.closed).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("fails a cycling history cursor before broker creation or announcement", async () => {
    const harness = await startHarness();
    harness.native.historyImpl = async () => ({
      data: [assistant("evt_cycle", "1", "never projected")],
      nextCursor: null,
      resumeCursor: "cycle",
    });

    try {
      harness.proxy.bridge("cse_cycle");
      await waitFor(() => harness.session.closed);
      expect(harness.native.historyCalls.map(({ cursor }) => cursor)).toEqual([undefined, "cycle"]);
      expect(harness.brokerState.creations).toBe(0);
      expect(harness.broker.announcements).toEqual([]);
      expect(harness.isRunSettled()).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it.each([
    "changed identity",
    "reused sequence",
    "event behind high-water mark",
  ] as const)("fail-stops a provider event with %s while leaving the child running", async (variant) => {
    const harness = await startHarness();
    const original = assistant(
      "evt_stable",
      variant === "event behind high-water mark" ? "2" : "1",
      "stable",
    );
    harness.native.historyImpl = async () => ({ data: [original], nextCursor: null });

    try {
      await bindReady(harness, "cse_conflict");
      await waitFor(() => harness.broker.content.length === 1);
      harness.native.streams[0]?.push(
        variant === "changed identity"
          ? assistant("evt_stable", "1", "changed")
          : assistant("evt_other", "1", "other"),
      );
      await waitFor(() => harness.session.closed);

      expect(harness.broker.content.map(({ text }) => text)).toEqual(["stable"]);
      expect(
        harness.broker.bus.some(({ header }) => header.recordKind === "session_terminal"),
      ).toBe(true);
      expect(harness.isRunSettled()).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it.each([
    "ack-before-sse",
    "sse-before-ack",
  ] as const)("correlates browser UUID/clientMsgId when provider order is %s", async (order) => {
    const harness = await startHarness();
    const acknowledgement = Promise.withResolvers<void>();
    harness.native.postImpl = async (_nativeId, input) => {
      if (order === "sse-before-ack") {
        harness.native.streams[0]?.push(
          userEvent(
            "evt_browser",
            "1",
            input.uuid,
            input.message.content,
            "cse_browser",
            "client",
            input.timestamp,
          ),
        );
      }
      await acknowledgement.promise;
      return { eventId: "evt_browser", sequenceNum: "1", duplicate: false };
    };

    try {
      await bindReady(harness, "cse_browser");
      harness.broker.push(
        inbound(harness, "user", "browser-in", "hello native", "browser-coordinate"),
      );
      await waitFor(() => harness.native.postCalls.length === 1);

      if (order === "ack-before-sse") {
        acknowledgement.resolve();
        await tick();
        expect(harness.broker.content).toEqual([]);
        const input = harness.native.postCalls[0]?.input;
        if (input === undefined) throw new Error("missing provider post");
        harness.native.streams[0]?.push(
          userEvent(
            "evt_browser",
            "1",
            input.uuid,
            input.message.content,
            "cse_browser",
            "client",
            input.timestamp,
          ),
        );
      }
      await waitFor(() => harness.broker.content.length === 1);
      if (order === "sse-before-ack") acknowledgement.resolve();
      await tick();

      expect(harness.native.postCalls[0]?.sessionId).toBe("cse_browser");
      expect(harness.broker.content).toEqual([
        expect.objectContaining({
          header: expect.objectContaining({ recordKind: "user", seq: 0 }),
          text: "hello native",
        }),
      ]);
      expect(acceptedBodies(harness)).toEqual([
        { client_msg_id: "browser-coordinate", native_pending: true },
        { client_msg_id: "browser-coordinate", seq: 0 },
      ]);
    } finally {
      acknowledgement.resolve();
      await harness.stop();
    }
  });

  it.each([
    ["client", "worker"],
    ["worker", "client"],
  ] as const)("correlates one browser prompt across %s-then-%s provider echoes", async (...sources) => {
    const harness = await startHarness();
    const acknowledgement = Promise.withResolvers<void>();
    harness.native.postImpl = async () => {
      await acknowledgement.promise;
      return { eventId: "evt_echo", sequenceNum: "1", duplicate: false };
    };

    try {
      await bindReady(harness, "cse_echo");
      harness.broker.push(inbound(harness, "user", "browser-echo", "echo once", "echo-coordinate"));
      await waitFor(() => harness.native.postCalls.length === 1);
      const input = harness.native.postCalls[0]?.input;
      if (input === undefined) throw new Error("missing provider post");
      for (const source of sources) {
        harness.native.streams[0]?.push(
          userEvent(
            "evt_echo",
            "1",
            input.uuid,
            input.message.content,
            "cse_echo",
            source,
            input.timestamp,
          ),
        );
      }
      harness.native.streams[0]?.push(assistant("evt_echo_barrier", "2", "after both echoes"));
      await waitFor(() => harness.broker.content.length === 2);
      acknowledgement.resolve();
      await waitFor(() =>
        acceptedBodies(harness).some(
          (body) => body.client_msg_id === "echo-coordinate" && body.seq === 0,
        ),
      );

      expect(
        harness.broker.content.map(({ header, text }) => [header.recordKind, header.seq, text]),
      ).toEqual([
        ["user", 0, "echo once"],
        ["assistant", 1, "after both echoes"],
      ]);
      expect(acceptedBodies(harness)).toEqual([
        { client_msg_id: "echo-coordinate", native_pending: true },
        { client_msg_id: "echo-coordinate", seq: 0 },
      ]);
      expect(harness.session.closed).toBe(false);
    } finally {
      acknowledgement.resolve();
      await harness.stop();
    }
  });

  it("accepts the retained minimal iOS shape and correlates timestamp only when present", async () => {
    const harness = await startHarness();
    harness.native.postImpl = async (_nativeId, input) => {
      harness.native.streams[0]?.push(
        iosClientUserEvent("evt_ios", "1", input.uuid, input.message.content),
      );
      harness.native.streams[0]?.push(
        userEvent(
          "evt_ios",
          "1",
          input.uuid,
          input.message.content,
          "cse_ios",
          "worker",
          input.timestamp,
        ),
      );
      return { eventId: "evt_ios", sequenceNum: "1", duplicate: false };
    };

    try {
      await bindReady(harness, "cse_ios");
      harness.broker.push(
        inbound(harness, "user", "ios-browser", "hello from ios", "ios-coordinate"),
      );
      await waitFor(() => harness.broker.content.length === 1);
      harness.native.streams[0]?.push(assistant("evt_ios_barrier", "2", "ios received"));
      await waitFor(() => harness.broker.content.length === 2);

      expect(
        harness.broker.content.map(({ header, text }) => [header.recordKind, header.seq, text]),
      ).toEqual([
        ["user", 0, "hello from ios"],
        ["assistant", 1, "ios received"],
      ]);
      expect(acceptedBodies(harness)).toEqual([
        { client_msg_id: "ios-coordinate", native_pending: true },
        { client_msg_id: "ios-coordinate", seq: 0 },
      ]);
      expect(harness.session.closed).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("keeps an iOS attachment non-projectable across worker enrichment", async () => {
    const harness = await startHarness();
    const uuid = "ios-attachment-uuid";
    try {
      await bindReady(harness, "cse_ios_attachment");
      harness.native.streams[0]?.push(
        iosClientUserEvent("evt_attachment", "1", uuid, "What is in this image?", {
          fileAttachments: [
            { file_name: "photo.jpeg", file_uuid: "fixture-photo", is_image: true },
          ],
        }),
      );
      harness.native.streams[0]?.push(
        userEvent(
          "evt_attachment",
          "1",
          uuid,
          '@"/upload/path/photo.jpeg" What is in this image?',
          "cse_ios_attachment",
          "worker",
        ),
      );
      harness.native.streams[0]?.push(
        assistant("evt_attachment_barrier", "2", "attachment stayed native"),
      );
      await waitFor(() => harness.broker.content.length === 1);

      expect(harness.broker.content.map(({ header, text }) => [header.recordKind, text])).toEqual([
        ["assistant", "attachment stayed native"],
      ]);
      expect(harness.session.closed).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("rejects a present session id that disagrees with the bound provider stream", async () => {
    const harness = await startHarness();
    try {
      await bindReady(harness, "cse_bound");
      harness.native.streams[0]?.push(
        userEvent("evt_wrong_session", "1", "wrong-session-uuid", "do not project", "cse_other"),
      );
      await waitFor(() => harness.session.closed);

      expect(harness.broker.content).toEqual([]);
      expect(harness.isRunSettled()).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("bounds retained live provider coordinates without stopping the native child", async () => {
    const harness = await startHarness({ projectionCoordinateCap: 2 });
    try {
      await bindReady(harness, "cse_event_cap");
      harness.native.streams[0]?.push(assistant("evt_cap_1", "1", "first"));
      harness.native.streams[0]?.push(assistant("evt_cap_2", "2", "second"));
      await waitFor(() => harness.broker.content.length === 2);
      harness.native.streams[0]?.push(assistant("evt_cap_3", "3", "over limit"));
      await waitFor(() => harness.session.closed);

      expect(harness.broker.content.map(({ text }) => text)).toEqual(["first", "second"]);
      expect(harness.isRunSettled()).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("shares the retained-coordinate bound with browser mutations", async () => {
    const harness = await startHarness({ projectionCoordinateCap: 2 });
    try {
      await bindReady(harness, "cse_total_cap");
      harness.native.streams[0]?.push(assistant("evt_cap", "1", "one provider event"));
      await waitFor(() => harness.broker.content.length === 1);
      harness.broker.push(inbound(harness, "user", "first", "first mutation"));
      await waitFor(() => harness.native.postCalls.length === 1);
      harness.broker.push(inbound(harness, "user", "second", "over total limit"));
      await waitFor(() => harness.session.closed);

      expect(harness.native.postCalls.map(({ input }) => input.message.content)).toEqual([
        "first mutation",
      ]);
      expect(harness.isRunSettled()).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("fences an outcome-unknown write after one POST without stopping the native child", async () => {
    const harness = await startHarness();
    const firstWrite = Promise.withResolvers<RcPostAck>();
    harness.native.postImpl = async () => firstWrite.promise;

    try {
      await bindReady(harness, "cse_unknown");
      harness.broker.push(inbound(harness, "user", "first", "first text", "client-first"));
      await waitFor(() => harness.native.postCalls.length === 1);
      harness.broker.push(inbound(harness, "user", "second", "second text", "client-second"));
      await waitFor(
        () => acceptedBodies(harness).filter((body) => body.native_pending === true).length === 2,
      );
      firstWrite.reject(
        AnthropicRcError.network("postEvent", {
          retryable: false,
          outcomeUnknown: true,
        }),
      );
      await waitFor(() => harness.session.closed);
      await tick();

      expect(harness.native.postCalls.map(({ input }) => input.message.content)).toEqual([
        "first text",
      ]);
      expect(harness.isRunSettled()).toBe(false);
      expect(
        harness.broker.bus.some(({ header }) => header.recordKind === "session_terminal"),
      ).toBe(true);
    } finally {
      await harness.stop();
    }
  });

  it("isolates broker content loss from the transparent proxy and native child", async () => {
    const harness = await startHarness();
    try {
      await bindReady(harness, "cse_broker_loss");
      harness.broker.failContentPosts = true;
      harness.native.streams[0]?.push(assistant("evt_broker_loss", "1", "cannot publish"));
      await waitFor(() => harness.session.closed);

      expect(
        harness.broker.bus.some(
          ({ header }) =>
            header.recordKind === "session_terminal" && header.sessionId === harness.session.id,
        ),
      ).toBe(true);
      expect(harness.proxy.closed).toBe(false);
      expect(harness.isRunSettled()).toBe(false);
    } finally {
      await harness.stop();
    }
    expect(harness.proxy.closed).toBe(true);
  });

  it("does not POST unsupported downstream controls to Anthropic", async () => {
    const harness = await startHarness();
    try {
      await bindReady(harness, "cse_controls");
      for (const subtype of ["interrupt", "set_model", "set_permission_mode", "end_session"]) {
        harness.session.pushControlRequest(subtype);
      }
      harness.session.pushUserInput("text barrier");
      await waitFor(() => harness.native.postCalls.length === 1);

      expect(harness.native.postCalls.map(({ input }) => input.message.content)).toEqual([
        "text barrier",
      ]);
      expect(harness.broker.content).toEqual([]);
      expect(harness.session.closed).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  it("holds browser writes through reconnect history reconciliation", async () => {
    const harness = await startHarness();
    const before = assistant("evt_before", "1", "before reconnect");
    const reconciliation = Promise.withResolvers<RcEventPage>();
    try {
      await bindReady(harness, "cse_reconnect");
      harness.native.streams[0]?.push(before);
      await waitFor(() => harness.broker.content.length === 1);

      const second = new NativeStream();
      const reconciliationStarted = Promise.withResolvers<void>();
      harness.native.streams.push(second);
      harness.native.historyImpl = async (_sessionId, _cursor, call) => {
        if (call !== 1) return { data: [], nextCursor: null };
        reconciliationStarted.resolve();
        return reconciliation.promise;
      };
      harness.native.streams[0]?.end();
      await reconciliationStarted.promise;

      harness.broker.push(
        inbound(harness, "user", "during-reconnect", "held write", "held-client"),
      );
      await waitFor(() => acceptedBodies(harness).some((body) => body.native_pending === true));
      await tick();
      expect(harness.native.postCalls).toEqual([]);

      reconciliation.resolve({
        data: [before, assistant("evt_missed", "2", "missed during reconnect")],
        nextCursor: null,
      });
      await waitFor(
        () => harness.native.postCalls.length === 1 && harness.broker.content.length === 2,
      );

      expect(harness.native.order).toEqual(
        expect.arrayContaining([
          "subscribe:cse_reconnect",
          "history:cse_reconnect:-",
          "post:cse_reconnect:held write",
        ]),
      );
      expect(harness.broker.content.map(({ text }) => text)).toEqual([
        "before reconnect",
        "missed during reconnect",
      ]);
    } finally {
      reconciliation.resolve({ data: [], nextCursor: null });
      await harness.stop();
    }
  });

  it("cancels during pre-ready history without creating or announcing a broker projection", async () => {
    const harness = await startHarness();
    const historyStarted = Promise.withResolvers<void>();
    const history = Promise.withResolvers<RcEventPage>();
    harness.native.historyImpl = async () => {
      historyStarted.resolve();
      return history.promise;
    };

    harness.proxy.bridge("cse_cancel");
    await historyStarted.promise;
    expect(harness.brokerState.creations).toBe(0);
    harness.parent.abort();
    history.resolve({ data: [], nextCursor: null });
    await expect(harness.run).resolves.toBe(0);
    harness.child.resolve(0);
    await tick();

    expect(harness.brokerState.creations).toBe(0);
    expect(harness.broker.announcements).toEqual([]);
    expect(harness.proxy.closed).toBe(true);
  });
});
