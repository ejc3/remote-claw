import { deriveIdentity, type Frame, type FrameHeader } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { DriverContext } from "../driver.js";
import type { HostImage, Session } from "../session.js";
import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerError,
  type CodexClient,
  type CodexInbound,
  type CodexItemsPage,
  type CodexResumeResult,
  type CodexServerRequest,
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

function commandItem(id: string, overrides: Record<string, unknown> = {}): CodexThreadItem {
  return {
    type: "commandExecution",
    id,
    command: "sed -n '1,10p' example.ts",
    cwd: "/example",
    status: "completed",
    aggregatedOutput: "file content",
    exitCode: 0,
    ...overrides,
  };
}

function coordinate(turnId: string, itemId: string): string {
  return JSON.stringify([turnId, itemId]);
}

function completed(item: CodexThreadItem, threadId = THREAD_ID, turnId = "turn-1"): CodexInbound {
  return {
    kind: "notification",
    value: { method: "item/completed", params: { threadId, turnId, item } },
  };
}

class FakeCodexClient implements CodexClient {
  initializeCalls = 0;
  nativeVersion = CODEX_APP_SERVER_VERSION;
  readonly resumeCalls: string[] = [];
  readonly listCalls: Array<{ threadId: string; cursor: string | undefined }> = [];
  readonly turnListCalls: Array<{ threadId: string; cursor: string | undefined }> = [];
  readonly startCalls: Array<{
    threadId: string;
    clientUserMessageId: string;
    text: string;
    images?: readonly HostImage[];
  }> = [];
  closeCalls = 0;
  readonly activeTurnCalls: string[] = [];
  readonly interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  activeTurnId: string | null = null;
  activeTurnBarrier: Promise<void> | null = null;
  interruptError: Error | null = null;
  readonly approvalCalls: Array<{
    request: CodexServerRequest;
    decision: "accept" | "decline" | "cancel";
  }> = [];
  approvalError: Error | null = null;
  readonly questionCalls: Array<{
    request: CodexServerRequest;
    answers: Record<string, { answers: string[] }>;
  }> = [];
  externalThreadRunning = true;
  resumeResult: CodexResumeResult = {
    thread: {
      id: THREAD_ID,
      status: { type: "idle" },
      canAcceptDirectInput: true,
      historyMode: "paginated",
    },
  };
  pages: CodexItemsPage[] = [{ data: [], nextCursor: null }];
  turnPages: CodexItemsPage[] = [{ data: [], nextCursor: null }];
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
      userAgent: `remote-claw-codex/${this.nativeVersion} codex-cli/${this.nativeVersion}`,
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

  async listTurnItems(threadId: string, cursor: string | undefined): Promise<CodexItemsPage> {
    this.turnListCalls.push({ threadId, cursor });
    if (this.historyBarrier !== null) await this.historyBarrier;
    const page = this.turnPages[Math.min(this.turnListCalls.length - 1, this.turnPages.length - 1)];
    if (page === undefined) throw new Error("missing fake turn page");
    return structuredClone(page);
  }

  async startTurn(
    threadId: string,
    clientUserMessageId: string,
    text: string,
    _signal?: AbortSignal,
    images?: readonly HostImage[],
  ): Promise<void> {
    this.startCalls.push({ threadId, clientUserMessageId, text, ...(images ? { images } : {}) });
  }

  async activeTurn(threadId: string): Promise<string | null> {
    this.activeTurnCalls.push(threadId);
    if (this.activeTurnBarrier !== null) await this.activeTurnBarrier;
    return this.activeTurnId;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interruptCalls.push({ threadId, turnId });
    if (this.interruptError !== null) throw this.interruptError;
  }

  respondCommandApproval(
    request: CodexServerRequest,
    decision: "accept" | "decline" | "cancel",
    signal: AbortSignal,
  ): boolean {
    if (signal.aborted) return false;
    this.approvalCalls.push({ request, decision });
    if (this.approvalError !== null) throw this.approvalError;
    return true;
  }

  drainInbound(): CodexInbound[] {
    return this.buffered.splice(0);
  }

  respondUserInput(
    request: CodexServerRequest,
    answers: Record<string, { answers: string[] }>,
    signal: AbortSignal,
  ): boolean {
    if (signal.aborted) return false;
    this.questionCalls.push({ request, answers });
    return true;
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

function interruptFrame(identityId: Uint8Array, sessionId: string, msgId: string): Frame {
  return {
    ...browserFrame(identityId, sessionId, JSON.stringify({ expiry: Date.now() + 10_000 }), msgId),
    recordKind: "interrupt",
    msgId,
  };
}

function commandApproval(params: Record<string, unknown> = {}): CodexServerRequest {
  return {
    id: "native-approval-callback",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: THREAD_ID,
      turnId: "approval-turn",
      itemId: "approval-command",
      kind: "command",
      environmentId: "local",
      command: "ls /example",
      cwd: "/example",
      reason: "Inspect requested directory",
      availableDecisions: ["accept", "cancel"],
      ...params,
    },
  };
}

function approvalViewerId(session: Session): string {
  const id = upstream(session, "control_request")[0]?.request_id;
  if (typeof id !== "string") throw new Error("missing approval viewer ID");
  return id;
}

function nativeQuestion(): CodexServerRequest {
  return {
    id: "native-question-callback",
    method: "item/tool/requestUserInput",
    params: {
      threadId: THREAD_ID,
      turnId: "question-turn",
      itemId: "question-item",
      isBlocking: true,
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Choose a color",
          isSecret: false,
          isOther: true,
          options: [{ label: "Blue", description: "Blue sample" }],
        },
      ],
    },
  };
}

function approvalFrame(
  identityId: Uint8Array,
  sessionId: string,
  viewerId: string,
  behavior: "allow" | "deny",
  msgId = "browser-approval",
): Frame {
  return {
    ...browserFrame(
      identityId,
      sessionId,
      JSON.stringify({ request_id: viewerId, behavior }),
      msgId,
    ),
    recordKind: "permission",
    msgId,
  };
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
    expect(upstream(session, "user")).toMatchObject([
      { uuid: coordinate("turn-1", "user-history"), local_prompt: true },
    ]);
    expect(upstream(session, "assistant")).toMatchObject([
      { uuid: coordinate("turn-1", "assistant-history") },
    ]);

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
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: THREAD_ID, itemId: "approval-1" },
      },
    });
    client.emit({
      kind: "request",
      value: {
        id: "question-1",
        method: "item/tool/requestUserInput",
        params: { threadId: THREAD_ID, itemId: "question-1" },
      },
    });
    client.emit(completed(assistantItem("assistant-2", "second answer")));
    client.emit(completed(assistantItem("other-thread-item", "must stay out"), OTHER_THREAD_ID));

    await waitFor(() => upstream(launched.session, "assistant").length === 2);
    expect(upstream(launched.session, "user")).toHaveLength(1);
    expect(upstream(launched.session, "assistant").map((item) => item.uuid)).toEqual([
      coordinate("turn-1", "assistant-1"),
      coordinate("turn-1", "assistant-2"),
    ]);
    expect(client.startCalls).toEqual([]);
    expect(launched.session.closed).toBe(false);

    await stop(launched.ac, launched.run);
    controllers.splice(controllers.indexOf(launched.ac), 1);
  });

  it("projects completed commands once through the bounded tool relay in native item order", async () => {
    const client = new FakeCodexClient();
    const success = commandItem("read");
    client.pages = [{ data: [{ turnId: "turn-1", item: success }], nextCursor: null }];
    const launched = await start(client);
    controllers.push(launched.ac);
    client.emit(completed(success));
    client.emit(
      completed(
        commandItem("failure", {
          status: "failed",
          exitCode: 2,
          aggregatedOutput: "x".repeat(4001),
        }),
      ),
    );
    client.emit(
      completed(
        commandItem("declined", { status: "declined", exitCode: null, aggregatedOutput: null }),
      ),
    );
    client.emit(
      completed(
        commandItem("silent-failure", { status: "completed", exitCode: 1, aggregatedOutput: "" }),
      ),
    );
    client.emit(completed(commandItem("foreign"), OTHER_THREAD_ID));
    client.emit(completed(assistantItem("barrier", "Done")));
    await waitFor(() =>
      launched.broker.posts.some((p) => p.recordKind === "assistant" && p.text === "Done"),
    );
    const content = launched.broker.posts.filter((p) => p.seq !== null);
    expect(content.map((p) => p.recordKind)).toEqual([
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({
      name: "Shell",
      input: { command: success.command, cwd: "/example" },
    });
    expect(JSON.parse(content[1]?.text ?? "")).toMatchObject({
      tool_use_id: coordinate("turn-1", "read"),
      output: "file content",
      is_error: false,
    });
    expect(JSON.parse(content[3]?.text ?? "")).toMatchObject({
      output: `${"x".repeat(4000)}…[truncated]`,
      is_error: true,
    });
    expect(JSON.parse(content[5]?.text ?? "")).toMatchObject({
      output: "Command declined in native Codex.",
      is_error: true,
    });
    expect(JSON.parse(content[7]?.text ?? "")).toMatchObject({
      output: "Command failed in native Codex (exit 1).",
      is_error: true,
    });
    expect(client.startCalls).toEqual([]);
    await stop(launched.ac, launched.run);
  });

  it("bounds retained command output, deduplicates large results, and fences hidden tail changes", async () => {
    const client = new FakeCodexClient();
    const prefix = `🚀${"x".repeat(3997)}\uD83D`;
    const output = `${prefix}\uDE80${"x".repeat(1_000_000)} original tail`;
    const item = commandItem("large-output", { aggregatedOutput: output });
    client.pages = [{ data: [{ turnId: "turn-1", item }], nextCursor: null }];
    const launched = await start(client);
    controllers.push(launched.ac);
    client.emit(completed(item));
    client.emit(completed(item));
    client.emit(completed(assistantItem("replay-barrier", "Done")));
    await waitFor(() =>
      launched.broker.posts.some((post) => post.recordKind === "assistant" && post.text === "Done"),
    );

    // Inspect the retained Session, not merely the broker's already-capped publication.
    expect(upstream(launched.session, "user")).toEqual([
      expect.objectContaining({
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: coordinate("turn-1", "large-output"),
              is_error: false,
              content: `${prefix}…[truncated]`,
            },
          ],
        },
      }),
    ]);
    expect(launched.broker.posts.filter((post) => post.recordKind === "tool_result")).toHaveLength(
      1,
    );
    expect(launched.session.closed).toBe(false);

    client.emit(
      completed(commandItem("large-output", { aggregatedOutput: `${output} changed tail` })),
    );
    await expect(within(launched.run)).resolves.toBe(1);
    expect(upstream(launched.session, "user")).toHaveLength(1);
    expect(client.startCalls).toEqual([]);
    expect(client.externalThreadRunning).toBe(true);
  });

  it("does not consume unfinished/unsupported tool identities or turn them into native requests", async () => {
    const client = new FakeCodexClient();
    client.pages = [
      {
        data: [
          {
            turnId: "turn-1",
            item: commandItem("later", {
              status: "inProgress",
              exitCode: null,
              aggregatedOutput: null,
            }),
          },
        ],
        nextCursor: null,
      },
    ];
    const launched = await start(client);
    controllers.push(launched.ac);
    for (const item of [
      commandItem("bad-output", { aggregatedOutput: [] }),
      commandItem("bad-code", { exitCode: "1" }),
      commandItem("bad-command", { command: [] }),
      commandItem("bad-state", { status: "unknown" }),
      { type: "fileChange", id: "file-change" },
      { type: "mcpToolCall", id: "mcp-call" },
    ])
      client.emit(completed(item));
    client.emit({
      kind: "request",
      value: {
        id: "later-approval",
        method: "item/commandExecution/requestApproval",
        params: { threadId: THREAD_ID, itemId: "later" },
      },
    });
    client.emit(completed(commandItem("later")));
    client.emit(completed(assistantItem("barrier", "Done")));
    await waitFor(() =>
      launched.broker.posts.some((p) => p.recordKind === "assistant" && p.text === "Done"),
    );
    expect(launched.broker.posts.filter((p) => p.seq !== null).map((p) => p.recordKind)).toEqual([
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(client.startCalls).toEqual([]);
    expect(launched.session.closed).toBe(false);
    await stop(launched.ac, launched.run);
  });

  it("fences changed completed command content but permits the same item id in a different turn", async () => {
    const launched = await start();
    controllers.push(launched.ac);
    launched.client.emit(completed(commandItem("same")));
    launched.client.emit(completed(commandItem("same"), THREAD_ID, "turn-2"));
    await waitFor(() => upstream(launched.session, "assistant").length === 2);
    launched.client.emit(completed(commandItem("same", { aggregatedOutput: "changed" })));
    expect(await within(launched.run)).toBe(1);
    expect(upstream(launched.session, "assistant")).toHaveLength(2);
    expect(launched.client.startCalls).toEqual([]);
    expect(launched.client.externalThreadRunning).toBe(true);
  });

  it("hydrates official Remote legacy history without calling its unsupported item pager", async () => {
    const client = new FakeCodexClient();
    client.resumeResult.thread.historyMode = "legacy";
    client.turnPages = [
      {
        data: [{ turnId: "turn-legacy", item: userItem("user-legacy", "provider prompt") }],
        nextCursor: "legacy-page-2",
      },
      {
        data: [
          { turnId: "turn-legacy", item: assistantItem("assistant-legacy", "provider answer") },
        ],
        nextCursor: null,
      },
    ];

    const launched = await start(client);
    controllers.push(launched.ac);

    expect(client.turnListCalls).toEqual([
      { threadId: THREAD_ID, cursor: undefined },
      { threadId: THREAD_ID, cursor: "legacy-page-2" },
    ]);
    expect(client.listCalls).toEqual([]);
    expect(upstream(launched.session, "user")).toMatchObject([
      { uuid: coordinate("turn-legacy", "user-legacy"), local_prompt: true },
    ]);
    expect(upstream(launched.session, "assistant")).toMatchObject([
      { uuid: coordinate("turn-legacy", "assistant-legacy") },
    ]);

    await stop(launched.ac, launched.run);
    controllers.splice(controllers.indexOf(launched.ac), 1);
  });

  it("restarts with fresh history observation without replaying an earlier browser mutation", async () => {
    const first = await start();
    controllers.push(first.ac);
    first.broker.pushInbound(
      browserFrame(first.identityId, first.session.id, "applied before restart", "old-browser"),
    );
    await waitFor(() => first.client.startCalls.length === 1);
    const oldCoordinate = first.client.startCalls[0]?.clientUserMessageId;
    if (oldCoordinate === undefined) throw new Error("missing prior native coordinate");

    // The native mutation happened, but its completed item was not observed before the companion
    // stopped. The next invocation must learn that outcome from history without resubmitting it.
    await stop(first.ac, first.run);
    controllers.splice(controllers.indexOf(first.ac), 1);
    const priorUser = userItem("prior-user", "applied before restart", oldCoordinate);
    const priorAnswer = assistantItem("prior-answer", "answer before restart");
    const client = new FakeCodexClient();
    client.pages = [
      {
        data: [
          { turnId: "prior-turn", item: priorUser },
          { turnId: "prior-turn", item: priorAnswer },
        ],
        nextCursor: null,
      },
    ];
    client.buffered.push(
      completed(priorUser, THREAD_ID, "prior-turn"),
      completed(priorAnswer, THREAD_ID, "prior-turn"),
    );
    const second = await start(client);
    controllers.push(second.ac);

    expect(second.session.id).not.toBe(first.session.id);
    expect(first.client.resumeCalls).toEqual([THREAD_ID]);
    expect(client.resumeCalls).toEqual([THREAD_ID]);
    expect(upstream(second.session, "user")).toMatchObject([
      { uuid: coordinate("prior-turn", "prior-user"), local_prompt: true },
    ]);
    expect(upstream(second.session, "user")[0]).not.toHaveProperty("client_msg_id");
    expect(upstream(second.session, "assistant")).toHaveLength(1);
    expect(client.startCalls).toEqual([]);

    second.broker.pushInbound(
      browserFrame(first.identityId, first.session.id, "retired projection command", "stale"),
    );
    second.broker.pushInbound(
      browserFrame(second.identityId, second.session.id, "new projection command", "fresh"),
    );
    await waitFor(() => client.startCalls.length === 1);
    expect(client.startCalls.map(({ text }) => text)).toEqual(["new projection command"]);
    expect(first.client.startCalls).toHaveLength(1);

    await stop(second.ac, second.run);
    controllers.splice(controllers.indexOf(second.ac), 1);
  });

  it("does not charge ignored text shapes or hidden pages against projected history", async () => {
    const client = new FakeCodexClient();
    client.pages = [
      ...Array.from({ length: 101 }, (_, index) => ({
        data: [],
        nextCursor: `hidden-page-${index + 2}`,
      })),
      {
        data: [
          ...Array.from({ length: 10_001 }, (_, index) => ({
            turnId: `turn-ignored-${index}`,
            item: userItem(`ignored-${index}`, "/hidden-command"),
          })),
          { turnId: "turn-visible", item: assistantItem("visible", "visible answer") },
        ],
        nextCursor: null,
      },
    ];

    const launched = await start(client);
    controllers.push(launched.ac);

    expect(client.listCalls).toHaveLength(102);
    expect(upstream(launched.session, "user")).toEqual([]);
    expect(upstream(launched.session, "assistant")).toMatchObject([
      { uuid: coordinate("turn-visible", "visible") },
    ]);

    await stop(launched.ac, launched.run);
    controllers.splice(controllers.indexOf(launched.ac), 1);
  });

  it("treats item ids as turn-scoped while preserving same-turn mutation fencing", async () => {
    const client = new FakeCodexClient();
    client.pages = [
      {
        data: [
          { turnId: "turn-a", item: userItem("item-1", "first prompt") },
          { turnId: "turn-b", item: assistantItem("item-1", "second answer") },
        ],
        nextCursor: null,
      },
    ];
    const launched = await start(client);
    controllers.push(launched.ac);

    expect(upstream(launched.session, "user")).toMatchObject([
      { uuid: coordinate("turn-a", "item-1"), local_prompt: true },
    ]);
    expect(upstream(launched.session, "assistant")).toMatchObject([
      { uuid: coordinate("turn-b", "item-1") },
    ]);

    client.emit(completed(assistantItem("item-1", "changed answer"), THREAD_ID, "turn-b"));
    await expect(launched.run).resolves.toBe(1);
    expect(launched.session.closed).toBe(true);
    controllers.splice(controllers.indexOf(launched.ac), 1);
  });

  it("fails closed when a projected live item has no turn coordinate", async () => {
    const launched = await start();
    launched.client.emit({
      kind: "notification",
      value: {
        method: "item/completed",
        params: { threadId: THREAD_ID, item: assistantItem("item-1", "answer") },
      },
    });

    await expect(launched.run).resolves.toBe(1);
    expect(launched.session.closed).toBe(true);
    expect(launched.client.externalThreadRunning).toBe(true);
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

  it.each([
    false,
    true,
  ])("correlates full ordered image bytes before receipt (changed=%s)", async (changed) => {
    const launched = await start();
    controllers.push(launched.ac);
    const text = "📎 first.png, 📎 second.png\nDescribe both";
    const images = [
      { name: "first.png", url: "data:image/png;base64,YWJj" },
      { name: "second.png", url: "data:image/png;base64,ZGVm" },
    ];
    const event = launched.session.pushUserInput(text, { clientMsgId: "images", images });
    await waitFor(() => launched.client.startCalls.length === 1);
    expect(launched.client.startCalls[0]?.images).toEqual(images);
    await waitFor(() => event.images === undefined);
    expect(accepted(launched.broker)).toEqual([]);
    const item = {
      ...userItem("images-native", text, event.eventId),
      content: [
        { type: "text", text, text_elements: [] },
        ...images.map((img, i) => ({
          type: "image",
          url: changed && i === 1 ? "data:image/png;base64,ZGVn" : img.url,
          detail: null,
        })),
      ],
    };
    launched.client.emit(completed(item));
    if (changed) {
      await expect(launched.run).resolves.toBe(1);
      expect(accepted(launched.broker)).toEqual([]);
      expect(upstream(launched.session, "user")).toEqual([]);
    } else {
      await waitFor(() =>
        accepted(launched.broker).some((v) => v.client_msg_id === "images" && v.seq === 0),
      );
      launched.client.emit(completed(item));
      launched.client.emit(completed(assistantItem("image-barrier", "done")));
      await waitFor(() => upstream(launched.session, "assistant").length === 1);
      expect(upstream(launched.session, "user")).toHaveLength(1);
      expect(JSON.stringify(upstream(launched.session, "user"))).not.toContain("data:image");
      // Already-admitted bytes changing at the same native coordinate remain a fence.
      launched.client.emit(
        completed({
          ...item,
          content: [
            { type: "text", text },
            { type: "image", url: "data:image/png;base64,YWJk" },
          ],
        }),
      );
      await expect(launched.run).resolves.toBe(1);
    }
    expect(launched.client.externalThreadRunning).toBe(true);
    expect(event.images).toBeUndefined();
  });

  it.each([
    { label: "caption", texts: ["describe"], expected: "describe" },
    { label: "no text", texts: [], expected: "📎 2 image(s)" },
    { label: "empty text", texts: [""], expected: "📎 2 image(s)" },
    { label: "whitespace text", texts: [" \t", "\n "], expected: "📎 2 image(s)" },
  ])("projects native image history with $label without retaining inline bytes or reading local paths", async ({
    texts,
    expected,
  }) => {
    const client = new FakeCodexClient();
    client.pages = [
      {
        data: [
          {
            turnId: "old-turn",
            item: {
              ...userItem("old-image", texts.join("")),
              content: [
                ...texts.map((text) => ({ type: "text", text })),
                { type: "image", url: `data:image/png;base64,${"A".repeat(1024 * 1024)}` },
                { type: "localImage", path: "/not-readable.png" },
              ],
            },
          },
        ],
        nextCursor: null,
      },
    ];
    const launched = await start(client);
    controllers.push(launched.ac);
    expect(upstream(launched.session, "user")).toMatchObject([{ message: { content: expected } }]);
    expect(JSON.stringify(upstream(launched.session, "user"))).not.toContain("data:image");
    await stop(launched.ac, launched.run);
  });

  it("answers an exact-version native command once through the broker while text remains parked", async () => {
    const client = new FakeCodexClient();
    client.nativeVersion = "0.153.4";
    client.resumeResult.thread.status = { type: "active" };
    const native = commandApproval();
    client.buffered.push({ kind: "request", value: native });
    const launched = await start(client);
    controllers.push(launched.ac);
    await waitFor(() =>
      launched.broker.posts.some((post) => post.recordKind === "permission_request"),
    );
    const viewerId = approvalViewerId(launched.session);
    const announce = launched.broker.posts.find((post) => post.recordKind === "session_announce");
    expect(JSON.parse(announce?.text ?? "{}")).toMatchObject({
      capabilities: { structuredPermissions: true, permissionResolution: "native" },
    });

    launched.broker.pushInbound(
      browserFrame(
        launched.identityId,
        launched.broker.sessionId,
        "continue when done",
        "after-approval",
      ),
    );
    await waitFor(() => accepted(launched.broker).length === 1);
    expect(client.startCalls).toEqual([]);
    const answer = approvalFrame(launched.identityId, launched.broker.sessionId, viewerId, "allow");
    launched.broker.pushInbound(answer);
    await waitFor(() => client.approvalCalls.length === 1);
    expect(client.approvalCalls).toEqual([{ request: native, decision: "accept" }]);
    expect(client.approvalCalls[0]?.request).toBe(native);
    expect(client.startCalls).toEqual([]);
    expect(launched.session.workerStatus).toBe("running");

    launched.broker.pushInbound(answer);
    launched.broker.pushInbound(
      approvalFrame(
        launched.identityId,
        launched.broker.sessionId,
        viewerId,
        "deny",
        "other-browser-answer",
      ),
    );
    client.emit({
      kind: "notification",
      value: {
        method: "serverRequest/resolved",
        params: { threadId: THREAD_ID, requestId: native.id },
      },
    });
    await waitFor(() => upstream(launched.session, "control_cancel_request").length === 1);
    expect(client.approvalCalls).toHaveLength(1);
    expect(client.startCalls).toEqual([]);
    client.emit({
      kind: "notification",
      value: {
        method: "thread/status/changed",
        params: { threadId: THREAD_ID, status: { type: "idle" } },
      },
    });
    await waitFor(() => client.startCalls.length === 1);
    expect(client.startCalls[0]?.text).toBe("continue when done");
    expect(client.externalThreadRunning).toBe(true);
    await stop(launched.ac, launched.run);
  });

  it("does not answer when native resolution wins before the browser control is consumed", async () => {
    const client = new FakeCodexClient();
    client.nativeVersion = "0.153.4";
    const launched = await start(client);
    controllers.push(launched.ac);
    const native = commandApproval();
    client.emit({ kind: "request", value: native });
    await waitFor(() => upstream(launched.session, "control_request").length === 1);
    const viewerId = approvalViewerId(launched.session);
    client.emit({
      kind: "notification",
      value: {
        method: "serverRequest/resolved",
        params: { threadId: THREAD_ID, requestId: native.id },
      },
    });
    await waitFor(() => upstream(launched.session, "control_cancel_request").length === 1);
    const ack = vi.spyOn(launched.session, "ack");
    const response = launched.session.pushControlResponse(viewerId, "allow");
    await waitFor(() => ack.mock.calls.some(([id]) => id === response.eventId));
    expect(client.approvalCalls).toEqual([]);
    expect(launched.session.closed).toBe(false);
    await stop(launched.ac, launched.run);
  });

  // Detailed form validation and callback races live at questions/client; this is the thin
  // Session/relay wiring sentinel, including the capability snapshot used by real browsers.
  it("routes a native question through the broker and closes only on native resolution", async () => {
    const client = new FakeCodexClient();
    client.nativeVersion = "0.153.4";
    client.resumeResult.thread.status = { type: "active" };
    const native = nativeQuestion();
    client.buffered.push({ kind: "request", value: native });
    const launched = await start(client);
    controllers.push(launched.ac);
    await waitFor(() => launched.broker.posts.some((p) => p.recordKind === "permission_request"));
    const viewerId = approvalViewerId(launched.session);
    const announce = launched.broker.posts.find((p) => p.recordKind === "session_announce");
    expect(JSON.parse(announce?.text ?? "{}")).toMatchObject({
      capabilities: { structuredQuestions: true, permissionResolution: "native" },
    });
    const answer = {
      ...approvalFrame(launched.identityId, launched.broker.sessionId, viewerId, "allow"),
      ct: enc(
        JSON.stringify({ request_id: viewerId, behavior: "allow", answers: { color: "Blue" } }),
      ),
    };
    launched.broker.pushInbound(answer);
    await waitFor(() => client.questionCalls.length === 1);
    expect(client.questionCalls).toEqual([
      { request: native, answers: { color: { answers: ["Blue"] } } },
    ]);
    expect(client.questionCalls[0]?.request).toBe(native);
    expect(client.approvalCalls).toEqual([]);
    expect(upstream(launched.session, "control_cancel_request")).toEqual([]);
    expect(launched.session.workerStatus).toBe("running");
    launched.broker.pushInbound({ ...answer, msgId: "second-viewer-answer" });
    client.emit({
      kind: "notification",
      value: {
        method: "serverRequest/resolved",
        params: { threadId: THREAD_ID, requestId: native.id },
      },
    });
    await waitFor(() => upstream(launched.session, "control_cancel_request").length === 1);
    expect(client.questionCalls).toHaveLength(1);
    expect(client.externalThreadRunning).toBe(true);
    await stop(launched.ac, launched.run);
  });

  it.each([
    { label: "older native version", version: "0.151.0", request: commandApproval() },
    {
      label: "different thread",
      version: "0.153.4",
      request: commandApproval({ threadId: OTHER_THREAD_ID }),
    },
    {
      label: "malformed native question",
      version: "0.153.4",
      request: { ...commandApproval(), method: "item/tool/requestUserInput" },
    },
    { label: "older-version native question", version: "0.151.0", request: nativeQuestion() },
  ])("leaves $label owned by native clients", async ({ version, request }) => {
    const client = new FakeCodexClient();
    client.nativeVersion = version;
    const launched = await start(client);
    controllers.push(launched.ac);
    client.emit({ kind: "request", value: request });
    client.emit(completed(assistantItem("approval-owner-barrier", "native owner remains active")));
    await waitFor(() => upstream(launched.session, "assistant").length === 1);
    expect(upstream(launched.session, "control_request")).toEqual([]);
    const ack = vi.spyOn(launched.session, "ack");
    const response = launched.session.pushControlResponse(String(request.id), "allow");
    await waitFor(() => ack.mock.calls.some(([id]) => id === response.eventId));
    expect(client.approvalCalls).toEqual([]);
    expect(client.questionCalls).toEqual([]);
    if (version === "0.151.0") {
      const announce = launched.broker.posts.find((post) => post.recordKind === "session_announce");
      expect(JSON.parse(announce?.text ?? "{}")).toMatchObject({
        capabilities: { structuredPermissions: false },
      });
    }
    expect(client.externalThreadRunning).toBe(true);
    await stop(launched.ac, launched.run);
  });

  it("does not answer an open approval after the broker projection closes", async () => {
    const client = new FakeCodexClient();
    client.nativeVersion = "0.153.4";
    const launched = await start(client);
    controllers.push(launched.ac);
    client.emit({ kind: "request", value: commandApproval() });
    await waitFor(() => upstream(launched.session, "control_request").length === 1);
    const viewerId = approvalViewerId(launched.session);
    launched.session.pushControlResponse(viewerId, "allow");
    launched.session.close("injected broker closure before approval response consumption");
    await expect(within(launched.run)).resolves.toBe(1);
    expect(client.approvalCalls).toEqual([]);
    expect(client.closeCalls).toBe(1);
    expect(client.externalThreadRunning).toBe(true);
  });

  it("fences only the companion after an ambiguous approval response without retrying or starting queued text", async () => {
    const client = new FakeCodexClient();
    client.nativeVersion = "0.153.4";
    client.resumeResult.thread.status = { type: "active" };
    client.approvalError = new CodexAppServerError("injected ambiguous approval write");
    const launched = await start(client);
    controllers.push(launched.ac);
    const native = commandApproval();
    client.emit({ kind: "request", value: native });
    await waitFor(() => upstream(launched.session, "control_request").length === 1);
    launched.broker.pushInbound(
      browserFrame(
        launched.identityId,
        launched.broker.sessionId,
        "must remain parked",
        "approval-failure-queued",
      ),
    );
    await waitFor(() => accepted(launched.broker).length === 1);
    const viewerId = approvalViewerId(launched.session);
    launched.session.pushControlResponse(viewerId, "allow");
    launched.session.pushControlResponse(viewerId, "allow");
    await expect(within(launched.run)).resolves.toBe(1);
    expect(client.approvalCalls).toEqual([{ request: native, decision: "accept" }]);
    expect(client.startCalls).toEqual([]);
    expect(client.closeCalls).toBe(1);
    expect(client.externalThreadRunning).toBe(true);
    expect(launched.session.closed).toBe(true);
    expect(launched.broker.posts.some((post) => post.recordKind === "session_terminal")).toBe(true);
  });

  it("lets Interrupt pass parked text, deduplicates it, and waits for native idle before continuing", async () => {
    const client = new FakeCodexClient();
    client.resumeResult.thread.status = { type: "active" };
    client.activeTurnId = "native-active-turn";
    const launched = await start(client);
    controllers.push(launched.ac);
    const clientMsgId = "queued-after-stop";
    launched.broker.pushInbound(
      browserFrame(
        launched.identityId,
        launched.broker.sessionId,
        "continue after stop",
        clientMsgId,
      ),
    );
    await waitFor(() => accepted(launched.broker).length === 1);
    expect(client.startCalls).toEqual([]);

    const interrupt = interruptFrame(launched.identityId, launched.broker.sessionId, "stop-once");
    launched.broker.pushInbound(interrupt);
    await waitFor(() => client.interruptCalls.length === 1);
    expect(client.interruptCalls).toEqual([{ threadId: THREAD_ID, turnId: "native-active-turn" }]);
    // The RPC has returned, but no native completion was observed: accepted Stop is not idle.
    expect(client.startCalls).toEqual([]);
    expect(launched.session.workerStatus).toBe("running");

    launched.broker.pushInbound(interrupt);
    launched.broker.pushInbound(
      interruptFrame(launched.identityId, launched.broker.sessionId, "same-turn-another-viewer"),
    );
    await waitFor(() => client.activeTurnCalls.length === 2);
    expect(client.interruptCalls).toHaveLength(1);

    client.emit({
      kind: "notification",
      value: {
        method: "thread/status/changed",
        params: { threadId: OTHER_THREAD_ID, status: { type: "idle" } },
      },
    });
    client.emit(completed(assistantItem("foreign-idle-barrier", "still active")));
    await waitFor(() => upstream(launched.session, "assistant").length === 1);
    expect(client.startCalls).toEqual([]);
    expect(launched.session.workerStatus).toBe("running");

    client.emit({
      kind: "notification",
      value: {
        method: "thread/status/changed",
        params: { threadId: THREAD_ID, status: { type: "idle" } },
      },
    });
    await waitFor(() => client.startCalls.length === 1);
    const call = client.startCalls[0];
    if (call === undefined) throw new Error("expected queued text to start after native idle");
    expect(call).toMatchObject({ threadId: THREAD_ID, text: "continue after stop" });
    client.emit(completed(userItem("continued-user", call.text, call.clientUserMessageId)));
    await waitFor(() =>
      accepted(launched.broker).some(
        (receipt) => receipt.client_msg_id === clientMsgId && typeof receipt.seq === "number",
      ),
    );
    expect(client.activeTurnCalls).toEqual([THREAD_ID, THREAD_ID]);
    expect(client.interruptCalls).toHaveLength(1);
    await stop(launched.ac, launched.run);
  });

  it("acknowledges an idle Interrupt without a native write and permits a later active turn", async () => {
    const launched = await start();
    controllers.push(launched.ac);
    const ack = vi.spyOn(launched.session, "ack");
    const event = launched.session.pushControlRequest("interrupt");
    await waitFor(() => ack.mock.calls.some(([id]) => id === event.eventId));
    expect(launched.client.activeTurnCalls).toEqual([THREAD_ID]);
    expect(launched.client.interruptCalls).toEqual([]);
    expect(launched.session.closed).toBe(false);
    expect(launched.session.workerStatus).toBe("idle");

    launched.client.activeTurnId = "later-active-turn";
    launched.session.pushControlRequest("interrupt");
    await waitFor(() => launched.client.interruptCalls.length === 1);
    expect(launched.client.interruptCalls).toEqual([
      { threadId: THREAD_ID, turnId: "later-active-turn" },
    ]);
    await stop(launched.ac, launched.run);
  });

  it("does not interrupt after projection closure while native turn metadata is pending", async () => {
    const barrier = deferred();
    const client = new FakeCodexClient();
    client.activeTurnId = "active-before-close";
    client.activeTurnBarrier = barrier.promise;
    const launched = await start(client);
    controllers.push(launched.ac);
    launched.session.pushControlRequest("interrupt");
    await waitFor(() => client.activeTurnCalls.length === 1);

    launched.session.close("injected broker closure during turn lookup");
    barrier.resolve();
    await expect(within(launched.run)).resolves.toBe(1);
    expect(client.interruptCalls).toEqual([]);
    expect(client.startCalls).toEqual([]);
    expect(client.closeCalls).toBe(1);
    expect(client.externalThreadRunning).toBe(true);
  });

  it("fences only the companion on an unknown Interrupt outcome without retry or queued text", async () => {
    const client = new FakeCodexClient();
    client.resumeResult.thread.status = { type: "active" };
    client.activeTurnId = "outcome-unknown-turn";
    client.interruptError = new CodexAppServerError("injected unknown interrupt outcome");
    const launched = await start(client);
    controllers.push(launched.ac);
    launched.broker.pushInbound(
      browserFrame(launched.identityId, launched.broker.sessionId, "must remain queued", "queued"),
    );
    await waitFor(() => accepted(launched.broker).length === 1);
    launched.session.pushControlRequest("interrupt");
    launched.session.pushControlRequest("interrupt");

    await expect(within(launched.run)).resolves.toBe(1);
    expect(client.activeTurnCalls).toEqual([THREAD_ID]);
    expect(client.interruptCalls).toEqual([
      { threadId: THREAD_ID, turnId: "outcome-unknown-turn" },
    ]);
    expect(client.startCalls).toEqual([]);
    expect(client.closeCalls).toBe(1);
    expect(client.externalThreadRunning).toBe(true);
    expect(launched.session.closed).toBe(true);
    expect(accepted(launched.broker)).toEqual([{ client_msg_id: "queued", native_pending: true }]);
    expect(launched.broker.posts.some((post) => post.recordKind === "session_terminal")).toBe(true);
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

  it("does not submit parked browser text when native idle races a closed broker session", async () => {
    const client = new FakeCodexClient();
    client.resumeResult.thread.status = { type: "active" };
    const launched = await start(client);
    controllers.push(launched.ac);
    launched.broker.pushInbound(
      browserFrame(
        launched.identityId,
        launched.broker.sessionId,
        "must not run after closure",
        "parked-browser-coordinate",
      ),
    );
    await waitFor(() => accepted(launched.broker).length === 1);
    expect(client.startCalls).toEqual([]);

    launched.session.close("injected broker relay closure");
    client.emit({
      kind: "notification",
      value: {
        method: "thread/status/changed",
        params: { threadId: THREAD_ID, status: { type: "idle" } },
      },
    });

    await expect(within(launched.run)).resolves.toBe(1);
    expect(client.startCalls).toEqual([]);
    expect(client.closeCalls).toBe(1);
    expect(client.externalThreadRunning).toBe(true);
    expect(accepted(launched.broker)).toEqual([
      { client_msg_id: "parked-browser-coordinate", native_pending: true },
    ]);
    controllers.splice(controllers.indexOf(launched.ac), 1);
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
