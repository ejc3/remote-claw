import { deriveIdentity, type Frame, type FrameHeader } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { DriverContext } from "../driver.js";
import type { Session } from "../session.js";
import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerError,
  type CodexClient,
  type CodexInbound,
  type CodexItemsPage,
  type CodexResumeResult,
  type CodexThreadItem,
} from "./client.js";
import { CodexDriver } from "./driver.js";

const THREAD_ID = "01993d50-6c31-7e11-9f70-3a8d9b5e7201";
const OTHER_THREAD_ID = "01993d50-6c31-7e11-af70-3a8d9b5e7202";
const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function flushUntil(predicate: () => boolean, turns = 100): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached during microtask flush");
}

function userItem(id: string, text: string, clientId?: string): CodexThreadItem {
  return {
    type: "userMessage",
    id,
    ...(clientId !== undefined ? { clientId } : {}),
    content: [{ type: "text", text }],
  };
}

function assistantItem(id: string, text: string): CodexThreadItem {
  return { type: "agentMessage", id, text };
}

function completed(item: CodexThreadItem, threadId = THREAD_ID): CodexInbound {
  return {
    kind: "notification",
    value: { method: "item/completed", params: { threadId, item } },
  };
}

class FakeCodexClient implements CodexClient {
  initializeCalls = 0;
  readonly resumeCalls: string[] = [];
  readonly listCalls: Array<{ threadId: string; cursor: string | undefined }> = [];
  readonly startCalls: Array<{
    threadId: string;
    clientUserMessageId: string;
    text: string;
  }> = [];
  closeCalls = 0;
  externalThreadRunning = true;
  resumeResult: CodexResumeResult = {
    thread: {
      id: THREAD_ID,
      status: { type: "idle" },
      canAcceptDirectInput: true,
    },
  };
  pages: CodexItemsPage[] = [{ data: [], nextCursor: null }];
  historyBarrier: Promise<void> | null = null;
  readonly buffered: CodexInbound[] = [];
  readonly #live: CodexInbound[] = [];
  readonly #wakes = new Set<() => void>();
  #failure: Error | null = null;
  #closed = false;

  async initialize(): Promise<{
    userAgent: string;
    platformFamily: string;
    platformOs: string;
  }> {
    this.initializeCalls += 1;
    return {
      userAgent: `remote-claw-codex/${CODEX_APP_SERVER_VERSION} codex-cli/${CODEX_APP_SERVER_VERSION}`,
      platformFamily: "unix",
      platformOs: "linux",
    };
  }

  async resume(threadId: string): Promise<CodexResumeResult> {
    this.resumeCalls.push(threadId);
    return structuredClone(this.resumeResult);
  }

  async listItems(threadId: string, cursor: string | undefined): Promise<CodexItemsPage> {
    this.listCalls.push({ threadId, cursor });
    if (this.historyBarrier !== null) await this.historyBarrier;
    const page = this.pages[Math.min(this.listCalls.length - 1, this.pages.length - 1)];
    if (page === undefined) throw new Error("missing fake history page");
    return structuredClone(page);
  }

  async startTurn(threadId: string, clientUserMessageId: string, text: string): Promise<void> {
    this.startCalls.push({ threadId, clientUserMessageId, text });
  }

  drainInbound(): CodexInbound[] {
    return this.buffered.splice(0);
  }

  async *inbound(signal: AbortSignal): AsyncGenerator<CodexInbound> {
    for (;;) {
      while (this.#live.length > 0) {
        const next = this.#live.shift();
        if (next !== undefined) yield next;
      }
      if (this.#failure !== null) throw this.#failure;
      if (this.#closed || signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          this.#wakes.delete(finish);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        this.#wakes.add(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  emit(value: CodexInbound): void {
    this.#live.push(value);
    this.#wake();
  }

  disconnect(): void {
    this.#failure = new CodexAppServerError("injected app-server disconnect");
    this.#wake();
  }

  close(): void {
    this.closeCalls += 1;
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    for (const wake of [...this.#wakes]) wake();
  }
}

interface BrokerPost {
  recordKind: string;
  seq: number | null;
  text: string;
}

class FakeDurableBroker {
  readonly posts: BrokerPost[] = [];
  readonly #inbound: Frame[] = [];
  readonly #wakes = new Set<() => void>();
  #sessionId: string | null = null;

  get sessionId(): string {
    if (this.#sessionId === null) throw new Error("broker session is not bound");
    return this.#sessionId;
  }

  async seqCursor(sessionId: string): Promise<{ maxSeq: null; durable: true }> {
    this.#sessionId = sessionId;
    return { maxSeq: null, durable: true };
  }

  async frameCountCursor(): Promise<{ frameCount: number; durable: true }> {
    return { frameCount: this.#inbound.length, durable: true };
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    this.#record(header, body);
    return [{ ok: true }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    this.#record(header, body);
    return { ok: true };
  }

  async *streamFrames(options: {
    startIndex?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<Frame> {
    let cursor = options.startIndex ?? 0;
    for (;;) {
      while (cursor < this.#inbound.length) {
        const frame = this.#inbound[cursor];
        cursor += 1;
        if (frame !== undefined) yield frame;
      }
      if (options.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          this.#wakes.delete(finish);
          options.signal?.removeEventListener("abort", finish);
          resolve();
        };
        this.#wakes.add(finish);
        options.signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }

  openFrame(frame: Frame): Promise<Uint8Array> {
    return Promise.resolve(frame.ct);
  }

  pushInbound(frame: Frame): void {
    this.#inbound.push(frame);
    for (const wake of [...this.#wakes]) wake();
  }

  #record(header: FrameHeader, body: Uint8Array): void {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
  }
}

async function context(
  broker: FakeDurableBroker,
  onSession: (session: Session) => void,
): Promise<DriverContext> {
  const identity = await deriveIdentity(enc("codex-driver-test"));
  return {
    harnessArgs: [],
    identity,
    brokerUrl: "http://broker.invalid",
    title: "remote-claw",
    cwd: "/tmp",
    git: null,
    newClient: () => broker as unknown as BrokerClient,
    onSession,
  };
}

async function start(client = new FakeCodexClient()): Promise<{
  ac: AbortController;
  broker: FakeDurableBroker;
  client: FakeCodexClient;
  identityId: Uint8Array;
  run: Promise<number>;
  session: Session;
}> {
  const broker = new FakeDurableBroker();
  let captured: Session | null = null;
  const driverContext = await context(broker, (session) => {
    captured = session;
  });
  const driver = new CodexDriver(driverContext, {
    url: "ws://127.0.0.1:4500",
    threadId: THREAD_ID,
    client,
    runtime: { platform: "linux", arch: "arm64" },
  });
  const ac = new AbortController();
  const run = driver.run(ac.signal);
  await waitFor(() => broker.posts.some((post) => post.recordKind === "session_announce"));
  if (captured === null) throw new Error("driver did not create a session");
  return {
    ac,
    broker,
    client,
    identityId: driverContext.identity.identityId,
    run,
    session: captured,
  };
}

function browserFrame(
  identityId: Uint8Array,
  sessionId: string,
  text: string,
  clientMsgId: string,
): Frame {
  return {
    v: 1,
    identityId,
    sessionId,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "browser-user-1",
    clientMsgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    salt: new Uint8Array(32),
    nonce: new Uint8Array(12),
    ct: enc(text),
  } as Frame;
}

function upstream(session: Session, type: string): Array<Record<string, unknown>> {
  return session
    .snapshotUpstream()
    .filter((event) => event.eventType === type)
    .map((event) => event.payload);
}

function accepted(broker: FakeDurableBroker): Array<Record<string, unknown>> {
  return broker.posts
    .filter((post) => post.recordKind === "accepted")
    .map((post) => JSON.parse(post.text) as Record<string, unknown>);
}

async function stop(ac: AbortController, run: Promise<number>): Promise<void> {
  ac.abort();
  await expect(run).resolves.toBe(0);
}

describe("Codex M3a companion", () => {
  const controllers: AbortController[] = [];

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.abort();
  });

  it("keeps presence private until exact-thread resume and bounded history complete", async () => {
    const barrier = deferred();
    const client = new FakeCodexClient();
    client.historyBarrier = barrier.promise;
    client.pages = [
      {
        data: [{ turnId: "turn-1", item: userItem("user-history", "local history") }],
        nextCursor: "page-2",
      },
      {
        data: [{ turnId: "turn-1", item: assistantItem("assistant-history", "history answer") }],
        nextCursor: null,
      },
    ];
    const broker = new FakeDurableBroker();
    let session: Session | null = null;
    const driver = new CodexDriver(
      await context(broker, (value) => {
        session = value;
      }),
      {
        url: "ws://127.0.0.1:4500",
        threadId: THREAD_ID,
        client,
        runtime: { platform: "linux", arch: "arm64" },
      },
    );
    const ac = new AbortController();
    controllers.push(ac);
    const run = driver.run(ac.signal);

    await waitFor(() => client.listCalls.length === 1);
    expect(client.initializeCalls).toBe(1);
    expect(client.resumeCalls).toEqual([THREAD_ID]);
    expect(client.listCalls).toEqual([{ threadId: THREAD_ID, cursor: undefined }]);
    expect(broker.posts).toEqual([]);

    client.historyBarrier = null;
    barrier.resolve();
    await waitFor(() => broker.posts.some((post) => post.recordKind === "session_announce"));
    expect(client.listCalls).toEqual([
      { threadId: THREAD_ID, cursor: undefined },
      { threadId: THREAD_ID, cursor: "page-2" },
    ]);
    if (session === null) throw new Error("driver did not create a session");
    expect(upstream(session, "user")).toMatchObject([{ uuid: "user-history", local_prompt: true }]);
    expect(upstream(session, "assistant")).toMatchObject([{ uuid: "assistant-history" }]);

    await stop(ac, run);
    controllers.splice(controllers.indexOf(ac), 1);
  });

  it("deduplicates history/live overlap and ignores approval and question requests", async () => {
    const client = new FakeCodexClient();
    client.pages = [
      {
        data: [
          { turnId: "turn-1", item: userItem("user-1", "local prompt") },
          { turnId: "turn-1", item: assistantItem("assistant-1", "first answer") },
        ],
        nextCursor: null,
      },
    ];
    const launched = await start(client);
    controllers.push(launched.ac);

    client.emit(completed(userItem("user-1", "local prompt")));
    client.emit(completed(assistantItem("assistant-1", "first answer")));
    client.emit({
      kind: "request",
      value: {
        method: "item/commandExecution/requestApproval",
        params: { threadId: THREAD_ID, itemId: "approval-1" },
      },
    });
    client.emit({
      kind: "request",
      value: {
        method: "item/tool/requestUserInput",
        params: { threadId: THREAD_ID, itemId: "question-1" },
      },
    });
    client.emit(completed(assistantItem("assistant-2", "second answer")));
    client.emit(completed(assistantItem("other-thread-item", "must stay out"), OTHER_THREAD_ID));

    await waitFor(() => upstream(launched.session, "assistant").length === 2);
    expect(upstream(launched.session, "user")).toHaveLength(1);
    expect(upstream(launched.session, "assistant").map((item) => item.uuid)).toEqual([
      "assistant-1",
      "assistant-2",
    ]);
    expect(client.startCalls).toEqual([]);
    expect(launched.session.closed).toBe(false);

    await stop(launched.ac, launched.run);
    controllers.splice(controllers.indexOf(launched.ac), 1);
  });

  it("acknowledges a browser prompt only after the exact native user item appears", async () => {
    const launched = await start();
    controllers.push(launched.ac);
    const clientMsgId = "browser-coordinate-1";
    launched.broker.pushInbound(
      browserFrame(launched.identityId, launched.broker.sessionId, "remote prompt", clientMsgId),
    );

    await waitFor(() => launched.client.startCalls.length === 1);
    expect(launched.client.startCalls[0]).toMatchObject({
      threadId: THREAD_ID,
      text: "remote prompt",
    });
    expect(accepted(launched.broker)).toEqual([
      { client_msg_id: clientMsgId, native_pending: true },
    ]);

    launched.client.emit(completed(userItem("local-same-text", "remote prompt")));
    await waitFor(() => upstream(launched.session, "user").length === 1);
    expect(accepted(launched.broker)).toEqual([
      { client_msg_id: clientMsgId, native_pending: true },
    ]);

    const coordinate = launched.client.startCalls[0]?.clientUserMessageId;
    if (coordinate === undefined) throw new Error("missing native browser coordinate");
    launched.client.emit(completed(userItem("native-browser-user", "remote prompt", coordinate)));
    await waitFor(() => accepted(launched.broker).some((value) => value.seq === 1));
    expect(accepted(launched.broker)).toEqual([
      { client_msg_id: clientMsgId, native_pending: true },
      { client_msg_id: clientMsgId, seq: 1 },
    ]);
    expect(
      launched.broker.posts.filter(
        (post) => post.recordKind === "user" && post.text === "remote prompt",
      ),
    ).toHaveLength(2);

    await stop(launched.ac, launched.run);
    controllers.splice(controllers.indexOf(launched.ac), 1);
  });

  it("fences only the encrypted projection when the app-server connection drops", async () => {
    const launched = await start();
    launched.client.disconnect();

    await expect(launched.run).resolves.toBe(1);
    expect(launched.session.closed).toBe(true);
    expect(launched.client.closeCalls).toBe(1);
    expect(launched.client.externalThreadRunning).toBe(true);
    expect(launched.client.startCalls).toEqual([]);
    expect(launched.broker.posts.some((post) => post.recordKind === "session_terminal")).toBe(true);
  });

  it.each([
    "thread/archived",
    "thread/reverted",
  ])("fails closed on %s without mutating the external thread", async (method) => {
    const launched = await start();
    launched.client.emit({
      kind: "notification",
      value: { method, params: { threadId: THREAD_ID } },
    });

    await expect(launched.run).resolves.toBe(1);
    expect(launched.session.closed).toBe(true);
    expect(launched.client.closeCalls).toBe(1);
    expect(launched.client.externalThreadRunning).toBe(true);
    expect(launched.client.startCalls).toEqual([]);
    expect(launched.broker.posts.some((post) => post.recordKind === "session_terminal")).toBe(true);
  });

  it("settles a correlation wait when the broker session closes without stopping Codex", async () => {
    const launched = await start();
    controllers.push(launched.ac);
    const clientMsgId = "browser-coordinate-before-relay-close";
    launched.broker.pushInbound(
      browserFrame(launched.identityId, launched.broker.sessionId, "waiting prompt", clientMsgId),
    );
    await waitFor(() => launched.client.startCalls.length === 1);
    const nativeCallsAtClose = structuredClone(launched.client.startCalls);
    expect(accepted(launched.broker)).toEqual([
      { client_msg_id: clientMsgId, native_pending: true },
    ]);

    launched.session.close("injected broker relay closure");
    try {
      await expect(within(launched.run)).resolves.toBe(1);
    } finally {
      launched.ac.abort();
    }
    controllers.splice(controllers.indexOf(launched.ac), 1);

    expect(launched.client.closeCalls).toBe(1);
    expect(launched.client.externalThreadRunning).toBe(true);
    expect(launched.client.startCalls).toEqual(nativeCallsAtClose);
    expect(upstream(launched.session, "user")).toEqual([]);
    expect(accepted(launched.broker)).toEqual([
      { client_msg_id: clientMsgId, native_pending: true },
    ]);
    expect(launched.broker.posts.some((post) => post.recordKind === "session_terminal")).toBe(true);
  });

  it("fails closed at the bounded native-user correlation deadline", async () => {
    const launched = await start();
    controllers.push(launched.ac);
    const clientMsgId = "browser-coordinate-without-native-item";
    let fakeTimers = true;
    vi.useFakeTimers();
    try {
      launched.broker.pushInbound(
        browserFrame(
          launched.identityId,
          launched.broker.sessionId,
          "uncorrelated prompt",
          clientMsgId,
        ),
      );
      await flushUntil(() => launched.client.startCalls.length === 1);
      await flushUntil(() => accepted(launched.broker).length === 1);
      let settled = false;
      void launched.run.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      expect(accepted(launched.broker)).toEqual([
        { client_msg_id: clientMsgId, native_pending: true },
      ]);

      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      fakeTimers = false;
      await expect(within(launched.run)).resolves.toBe(1);
    } finally {
      if (fakeTimers) vi.useRealTimers();
      launched.ac.abort();
    }
    controllers.splice(controllers.indexOf(launched.ac), 1);

    expect(launched.client.closeCalls).toBe(1);
    expect(launched.client.externalThreadRunning).toBe(true);
    expect(launched.client.startCalls).toHaveLength(1);
    expect(upstream(launched.session, "user")).toEqual([]);
    expect(accepted(launched.broker)).toEqual([
      { client_msg_id: clientMsgId, native_pending: true },
    ]);
    expect(launched.broker.posts.some((post) => post.recordKind === "session_terminal")).toBe(true);
  });
});
