import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { deriveIdentity } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import type { Session } from "../session.js";
import {
  type HistoryMessage,
  OpencodeClient,
  OpencodeError,
  type OpencodeEvent,
  type OpencodeModel,
  type OpencodeSession,
  type OpencodeSessionStatus,
  type PermissionRule,
} from "./client.js";
import {
  DEFAULT_OPENCODE_MODEL,
  errText,
  mergeAskRules,
  OpencodeDriver,
  OpencodeProjectionError,
  opencodePartId,
} from "./driver.js";

const MAIN = "ses_main";
const CHILD = "ses_child";
const PROMPT_MESSAGE_BASE = 0xf000_0000_0000;

function nativeMessageId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff_ffff) {
    throw new Error("test native message sequence is out of range");
  }
  return `msg_${sequence.toString(16).padStart(12, "0")}${"0".repeat(14)}`;
}

function nativePartId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff_ffff) {
    throw new Error("test native part sequence is out of range");
  }
  return `prt_${sequence.toString(16).padStart(12, "0")}${"0".repeat(14)}`;
}

function nativePartForMessage(messageId: string): string {
  return `prt_${messageId.slice(4)}`;
}

type BrokerPost = { recordKind: string; seq: number | null; text: string };

class FakeBroker {
  readonly posts: BrokerPost[] = [];
  failContent = false;

  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    return { maxSeq: null, durable: false };
  }

  async maxSeq(): Promise<number | null> {
    return null;
  }

  async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    return { frameCount: null, durable: false };
  }

  async frameCount(): Promise<number | null> {
    return null;
  }

  async postMessage(header: FrameHeader, body: Uint8Array): Promise<unknown[]> {
    if (this.failContent && header.seq !== null) throw new Error("broker content failed");
    this.#record(header, body);
    return [{ ok: true }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    this.#record(header, body);
    return { ok: true };
  }

  async *streamFrames(options: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    await aborted(options.signal);
    yield* [];
  }

  async openFrame(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  #record(header: FrameHeader, body: Uint8Array): void {
    this.posts.push({
      recordKind: header.recordKind,
      seq: header.seq,
      text: new TextDecoder().decode(body),
    });
  }
}

class EventQueue {
  readonly #items: OpencodeEvent[] = [];
  readonly #waiters = new Set<() => void>();
  #ended = false;

  push(event: OpencodeEvent): void {
    if (this.#ended) throw new Error("event connection ended");
    this.#items.push(event);
    this.#wake();
  }

  end(): void {
    this.#ended = true;
    this.#wake();
  }

  async next(signal: AbortSignal): Promise<IteratorResult<OpencodeEvent>> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) return { done: false, value: item };
      if (this.#ended || signal.aborted) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          this.#waiters.delete(finish);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        this.#waiters.add(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  #wake(): void {
    for (const wake of [...this.#waiters]) wake();
  }
}

interface PromptCall {
  sessionId: string;
  text: string;
  model: OpencodeModel;
  partId: string;
  signal?: AbortSignal;
}

class FakeOpencodeClient extends OpencodeClient {
  versionCalls = 0;
  readonly versionSignals: AbortSignal[] = [];
  versionError: Error | null = null;
  readonly sessionGets: string[] = [];
  readonly sessionGetSignals: AbortSignal[] = [];
  sessionGetError: Error | null = null;
  confirmedSessionId: string | null = null;
  sessionStatus: OpencodeSessionStatus = "idle";
  readonly sessionStatusGets: string[] = [];
  readonly sessionStatusSignals: AbortSignal[] = [];
  sessionStatusError: Error | null = null;

  historyCalls = 0;
  historySnapshots: HistoryMessage[][] = [[]];
  readonly historyBarriers = new Map<number, Promise<void>>();
  readonly historyErrors = new Map<number, Error>();

  readonly prompts: PromptCall[] = [];
  readonly promptedMessages: HistoryMessage[] = [];
  promptError: Error | null = null;
  promptHook: ((call: PromptCall) => void) | null = null;
  promptedMessageFactory: ((call: PromptCall, messageId: string) => HistoryMessage) | null = null;
  promptEventHook: ((call: PromptCall, message: HistoryMessage) => void) | null = null;
  aborts = 0;
  readonly abortSignals: AbortSignal[] = [];
  abortError: Error | null = null;

  readonly permissionWrites: Array<{ sessionId: string; rules: readonly PermissionRule[] }> = [];
  readonly permissions = new Map<string, PermissionRule[]>();
  permissionReadError: Error | null = null;
  permissionWriteError: Error | null = null;

  readonly connections: EventQueue[] = [];
  readonly eventSignals: AbortSignal[] = [];
  connectionFirst: Array<OpencodeEvent | Error | null> = [];

  constructor() {
    super({ baseUrl: "http://127.0.0.1:4096" });
  }

  override async requireSupportedVersion(signal?: AbortSignal): Promise<void> {
    this.versionCalls += 1;
    if (signal !== undefined) this.versionSignals.push(signal);
    if (this.versionError !== null) throw this.versionError;
  }

  override async getSession(sessionId: string, signal?: AbortSignal): Promise<OpencodeSession> {
    this.sessionGets.push(sessionId);
    if (signal !== undefined) this.sessionGetSignals.push(signal);
    if (this.sessionGetError !== null) throw this.sessionGetError;
    return {
      id: this.confirmedSessionId ?? sessionId,
      permission: this.permissions.get(sessionId) ?? [],
    };
  }

  override async getSessionStatus(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OpencodeSessionStatus> {
    this.sessionStatusGets.push(sessionId);
    if (signal !== undefined) this.sessionStatusSignals.push(signal);
    if (this.sessionStatusError !== null) throw this.sessionStatusError;
    return this.sessionStatus;
  }

  override async getMessages(_sessionId: string, signal?: AbortSignal): Promise<HistoryMessage[]> {
    this.historyCalls += 1;
    const call = this.historyCalls;
    const barrier = this.historyBarriers.get(call);
    if (barrier !== undefined) {
      await Promise.race([barrier, aborted(signal)]);
      if (signal?.aborted) throw new DOMException("operation aborted", "AbortError");
    }
    const error = this.historyErrors.get(call);
    if (error !== undefined) throw error;
    const index = Math.min(call - 1, this.historySnapshots.length - 1);
    const snapshot = this.historySnapshots[index] ?? [];
    const ids = new Set(snapshot.map((message) => message.info.id));
    return structuredClone([
      ...snapshot,
      ...this.promptedMessages.filter((message) => !ids.has(message.info.id)),
    ]);
  }

  override async promptAsync(
    sessionId: string,
    args: { text: string; model: OpencodeModel; partId: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const call: PromptCall = { sessionId, ...args, ...(signal !== undefined ? { signal } : {}) };
    this.prompts.push(call);
    this.promptHook?.(call);
    if (this.promptError !== null) throw this.promptError;
    const messageId = nativeMessageId(PROMPT_MESSAGE_BASE + this.promptedMessages.length + 1);
    const message =
      this.promptedMessageFactory?.(call, messageId) ??
      ({
        info: { id: messageId, role: "user" },
        parts: [
          {
            type: "text",
            id: args.partId,
            messageID: messageId,
            text: args.text,
          },
        ],
      } satisfies HistoryMessage);
    this.promptedMessages.push(message);
    if (this.promptEventHook !== null) {
      this.promptEventHook(call, message);
      return;
    }
    this.emit(statusEvent(sessionId, "busy"));
    for (const part of message.parts) {
      this.emit(partEvent(sessionId, messageId, part as unknown as Record<string, unknown>));
    }
    this.emit(messageEvent(sessionId, messageId, "user"));
    // A tail user with native idle is OpenCode's valid cancelled-turn shape. It also proves that the
    // capture-owned idle reconciliation, rather than prompt_async's 204, releases the next queued turn.
    this.emit(statusEvent(sessionId, "idle"));
    this.emit(idleEvent(sessionId));
  }

  override async abort(_sessionId: string, signal?: AbortSignal): Promise<void> {
    this.aborts += 1;
    if (signal !== undefined) this.abortSignals.push(signal);
    if (this.abortError !== null) throw this.abortError;
    this.emit(statusEvent(MAIN, "idle"));
    this.emit(idleEvent());
  }

  override async getSessionPermission(
    sessionId: string,
    _signal?: AbortSignal,
  ): Promise<PermissionRule[]> {
    if (this.permissionReadError !== null) throw this.permissionReadError;
    return this.permissions.get(sessionId) ?? [];
  }

  override async setSessionPermission(
    sessionId: string,
    rules: readonly PermissionRule[],
    _signal?: AbortSignal,
  ): Promise<void> {
    if (this.permissionWriteError !== null) throw this.permissionWriteError;
    this.permissionWrites.push({ sessionId, rules });
    this.permissions.set(sessionId, [...rules]);
  }

  override async *events(
    want: string | ((id: string | undefined) => boolean),
    signal: AbortSignal,
  ): AsyncGenerator<OpencodeEvent> {
    const index = this.connections.length;
    const queue = new EventQueue();
    this.connections.push(queue);
    this.eventSignals.push(signal);
    const configured = this.connectionFirst[index];
    if (configured instanceof Error) throw configured;
    if (configured === null) return;
    const first = configured ?? { type: "server.connected", properties: {} };
    yield first;

    for (;;) {
      const next = await queue.next(signal);
      if (next.done) return;
      if (delivers(next.value, want)) yield next.value;
    }
  }

  emit(event: OpencodeEvent, connection = this.connections.length - 1): void {
    const queue = this.connections[connection];
    if (queue === undefined) throw new Error("no live event connection");
    queue.push(event);
  }

  drop(connection = this.connections.length - 1): void {
    const queue = this.connections[connection];
    if (queue === undefined) throw new Error("no live event connection");
    queue.end();
  }
}

function delivers(
  event: OpencodeEvent,
  want: string | ((id: string | undefined) => boolean),
): boolean {
  const predicate =
    typeof want === "function" ? want : (id: string | undefined): boolean => id === want;
  if (typeof want === "function" && event.type === "session.created") return true;
  const sessionId =
    event.properties.sessionID ??
    event.properties.part?.sessionID ??
    (event.properties.info as { sessionID?: string } | undefined)?.sessionID;
  return sessionId === undefined ? event.type.startsWith("server.") : predicate(sessionId);
}

function partEvent(
  sessionId: string,
  messageId: string,
  part: Record<string, unknown>,
): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: sessionId,
      part: { ...part, messageID: messageId, sessionID: sessionId } as never,
    },
  };
}

function messageEvent(
  sessionId: string,
  messageId: string,
  role: "user" | "assistant",
  completed = false,
  parentId?: string,
): OpencodeEvent {
  return {
    type: "message.updated",
    properties: {
      sessionID: sessionId,
      info: {
        id: messageId,
        role,
        sessionID: sessionId,
        ...(parentId !== undefined ? { parentID: parentId } : {}),
        time: completed ? { completed: 2 } : {},
      },
    },
  };
}

function idleEvent(sessionId = MAIN): OpencodeEvent {
  return { type: "session.idle", properties: { sessionID: sessionId } };
}

function statusEvent(sessionId: string, status: "idle" | "busy" | "retry"): OpencodeEvent {
  return { type: "session.status", properties: { sessionID: sessionId, status: { type: status } } };
}

function userHistory(messageId: string, text: string): HistoryMessage {
  return {
    info: { id: messageId, role: "user" },
    parts: [
      {
        type: "text",
        id: nativePartForMessage(messageId),
        messageID: messageId,
        text,
      },
    ],
  };
}

function assistantHistory(messageId: string, text: string, parentId: string): HistoryMessage {
  return {
    info: { id: messageId, role: "assistant", parentID: parentId, time: { completed: 2 } },
    parts: [
      {
        type: "text",
        id: nativePartForMessage(messageId),
        messageID: messageId,
        text,
      },
    ],
  };
}

function emitUser(client: FakeOpencodeClient, messageId: string, text: string): void {
  client.emit(
    partEvent(MAIN, messageId, { type: "text", id: nativePartForMessage(messageId), text }),
  );
  client.emit(messageEvent(MAIN, messageId, "user"));
}

function emitAssistant(client: FakeOpencodeClient, messageId: string, text: string): void {
  const parentId = nativeMessageId(1);
  emitUser(client, parentId, "");
  client.emit(
    partEvent(MAIN, messageId, { type: "text", id: nativePartForMessage(messageId), text }),
  );
  client.emit(messageEvent(MAIN, messageId, "assistant", true, parentId));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeContext(
  client: FakeOpencodeClient,
  broker: FakeBroker,
  onSession: (session: Session) => void,
  extra: Record<string, unknown> = {},
) {
  const identity = await deriveIdentity(new TextEncoder().encode("opencode-driver-test"));
  return {
    harnessArgs: [],
    identity,
    brokerUrl: "http://broker.invalid",
    title: "remote-claw",
    cwd: "/tmp",
    git: null,
    newClient: () => broker as unknown as BrokerClient,
    onSession,
    extra: { client, sessionId: MAIN, ...extra },
  };
}

async function launch(
  client = new FakeOpencodeClient(),
  extra: Record<string, unknown> = {},
): Promise<{
  ac: AbortController;
  broker: FakeBroker;
  client: FakeOpencodeClient;
  driver: OpencodeDriver;
  run: Promise<number>;
  session: Session;
}> {
  const broker = new FakeBroker();
  let captured: Session | null = null;
  const context = await makeContext(
    client,
    broker,
    (session) => {
      captured = session;
    },
    extra,
  );
  const driver = new OpencodeDriver(context);
  const ac = new AbortController();
  const run = driver.run(ac.signal);
  await waitFor(() => broker.posts.some((post) => post.recordKind === "session_announce"));
  if (captured === null) throw new Error("driver did not create a compatibility session");
  return { ac, broker, client, driver, run, session: captured };
}

async function stop(ac: AbortController, run: Promise<number>): Promise<void> {
  ac.abort();
  await expect(run).resolves.toBe(0);
}

function upstream(session: Session, type: string): Array<Record<string, unknown>> {
  return session
    .snapshotUpstream()
    .filter((event) => event.eventType === type)
    .map((event) => event.payload);
}

describe("OpenCode M2 registration", () => {
  const controllers: AbortController[] = [];

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.abort();
  });

  it("does no work when already cancelled", async () => {
    const client = new FakeOpencodeClient();
    const broker = new FakeBroker();
    let sessions = 0;
    const context = await makeContext(client, broker, () => {
      sessions += 1;
    });
    const ac = new AbortController();
    ac.abort();

    await expect(new OpencodeDriver(context).run(ac.signal)).resolves.toBe(0);
    expect(sessions).toBe(0);
    expect(client.versionCalls).toBe(0);
    expect(client.sessionGets).toEqual([]);
    expect(broker.posts).toEqual([]);
  });

  it("keeps broker presence private until version, exact attach, live SSE, and strict history finish", async () => {
    const client = new FakeOpencodeClient();
    const gate = deferred();
    client.historyBarriers.set(1, gate.promise);
    const broker = new FakeBroker();
    let session: Session | null = null;
    const context = await makeContext(client, broker, (value) => {
      session = value;
    });
    const ac = new AbortController();
    controllers.push(ac);
    const driver = new OpencodeDriver(context);
    const run = driver.run(ac.signal);

    await waitFor(() => client.historyCalls === 1);
    expect(session).not.toBeNull();
    expect(client.versionCalls).toBe(2);
    expect(client.sessionGets).toEqual([MAIN, MAIN]);
    expect(client.connections).toHaveLength(1);
    expect(broker.posts).toEqual([]);
    expect(client.permissionWrites).toEqual([]);

    gate.resolve();
    await waitFor(() => broker.posts.some((post) => post.recordKind === "session_announce"));
    expect(driver.capabilities).toEqual({
      structuredPermissions: false,
      status: true,
      controls: {
        interrupt: true,
        setModel: false,
        setMode: false,
        end: false,
      },
      attachments: false,
    });
    await stop(ac, run);
  });

  it.each([
    ["idle", "idle"],
    ["busy", "running"],
    ["retry", "running"],
  ] as const)("publishes an initial native %s snapshot as %s", async (status, projected) => {
    const client = new FakeOpencodeClient();
    client.sessionStatus = status;
    const running = await launch(client);

    expect(running.driver.capabilities.status).toBe(true);
    expect(running.session.workerStatus).toBe(projected);
    await stop(running.ac, running.run);
  });

  it.each([
    [
      "wrong server version",
      (client: FakeOpencodeClient) => (client.versionError = new Error("wrong")),
    ],
    [
      "missing exact native session",
      (client: FakeOpencodeClient) => (client.sessionGetError = new Error("missing")),
    ],
    [
      "mismatched exact native session",
      (client: FakeOpencodeClient) => (client.confirmedSessionId = "ses_other"),
    ],
  ])("fails before presence for %s", async (_name, arrange) => {
    const client = new FakeOpencodeClient();
    arrange(client);
    const broker = new FakeBroker();
    const context = await makeContext(client, broker, () => {});
    const ac = new AbortController();

    await expect(new OpencodeDriver(context).run(ac.signal)).resolves.toBe(1);
    expect(broker.posts).toEqual([]);
    expect(client.aborts).toBe(0);
  });

  it("requires the frozen model before native I/O", async () => {
    const client = new FakeOpencodeClient();
    const broker = new FakeBroker();
    const context = await makeContext(client, broker, () => {}, {
      model: { providerID: "other", modelID: "other" },
    });

    await expect(new OpencodeDriver(context).run(new AbortController().signal)).resolves.toBe(1);
    expect(client.versionCalls).toBe(0);
    expect(client.sessionGets).toEqual([]);
    expect(broker.posts).toEqual([]);
  });

  it("requires server.connected as the first SSE frame", async () => {
    const client = new FakeOpencodeClient();
    client.connectionFirst = [{ type: "server.heartbeat", properties: {} }];
    const broker = new FakeBroker();
    const context = await makeContext(client, broker, () => {});

    await expect(new OpencodeDriver(context).run(new AbortController().signal)).resolves.toBe(1);
    expect(broker.posts).toEqual([]);
    expect(client.aborts).toBe(0);
  });

  it("does not mutate permissions by default; the positive experimental opt-in proves its write", async () => {
    const normal = await launch();
    expect(normal.client.permissionWrites).toEqual([]);
    await stop(normal.ac, normal.run);

    const mirrored = await launch(new FakeOpencodeClient(), { mirrorPermissions: true });
    expect(mirrored.client.permissionWrites).toEqual([
      {
        sessionId: MAIN,
        rules: [{ permission: "*", pattern: "*", action: "ask" }],
      },
    ]);
    expect(mirrored.driver.capabilities.structuredPermissions).toBe(true);
    await stop(mirrored.ac, mirrored.run);
  });
});

describe("OpenCode M2 canonical projection", () => {
  it("replays strict bounded history before readiness", async () => {
    const client = new FakeOpencodeClient();
    const userId = nativeMessageId(100);
    const assistantId = nativeMessageId(200);
    client.historySnapshots = [
      [userHistory(userId, "typed in TUI"), assistantHistory(assistantId, "native reply", userId)],
    ];
    const running = await launch(client);

    expect(upstream(running.session, "user")).toMatchObject([
      {
        uuid: userId,
        local_prompt: true,
        message: { content: "typed in TUI" },
      },
    ]);
    expect(upstream(running.session, "assistant")).toHaveLength(1);
    await stop(running.ac, running.run);
  });

  it("uses the host event UUID as a part marker and correlates identical TUI/browser text exactly", async () => {
    const text = "  identical text survives  \n";
    const client = new FakeOpencodeClient();
    const localMessageId = nativeMessageId(100);
    client.historySnapshots = [[userHistory(localMessageId, text)]];
    const running = await launch(client);
    const browser = running.session.pushUserInput(text, { clientMsgId: "browser-coordinate" });
    const expectedPartId = opencodePartId(browser.eventId);
    await waitFor(() => running.client.prompts.length === 1);

    expect(running.client.prompts[0]).toMatchObject({
      sessionId: MAIN,
      text,
      model: DEFAULT_OPENCODE_MODEL,
      partId: expectedPartId,
    });
    await waitFor(() => upstream(running.session, "user").length === 2);

    const users = upstream(running.session, "user");
    expect(users[0]).toMatchObject({
      uuid: localMessageId,
      local_prompt: true,
      message: { content: text },
    });
    expect(users[0]).not.toHaveProperty("client_msg_id");
    const generatedMessageId = running.client.promptedMessages[0]?.info.id;
    expect(users[1]).toMatchObject({
      uuid: generatedMessageId,
      local_prompt: true,
      client_msg_id: "browser-coordinate",
      message: { content: text },
    });
    await stop(running.ac, running.run);
  });

  it("fences if OpenCode omits the exact browser part marker from its canonical echo", async () => {
    const client = new FakeOpencodeClient();
    client.promptedMessageFactory = (call, messageId) => ({
      info: { id: messageId, role: "user" },
      parts: [
        {
          type: "text",
          id: nativePartId(1),
          messageID: messageId,
          text: call.text,
        },
      ],
    });
    const running = await launch(client);
    running.session.pushUserInput("marker must survive");

    await expect(running.run).rejects.toThrow(/lost the active browser correlation marker/);
    expect(client.prompts).toHaveLength(1);
    expect(client.aborts).toBe(0);
  });

  it("fences if OpenCode preserves the browser marker but changes the marked part", async () => {
    const client = new FakeOpencodeClient();
    client.promptedMessageFactory = (call, messageId) => ({
      info: { id: messageId, role: "user" },
      parts: [
        {
          type: "text",
          id: call.partId,
          messageID: messageId,
          text: "marked",
        },
        {
          type: "text",
          id: nativePartId(2),
          messageID: messageId,
          text: " text",
        },
      ],
    });
    const running = await launch(client);
    running.session.pushUserInput("marked text");

    await expect(running.run).rejects.toThrow(/changed the browser correlation marker/);
    expect(client.prompts).toHaveLength(1);
    expect(client.aborts).toBe(0);
  });

  it("fences if one browser marker is reused by two newly observed native messages", async () => {
    const client = new FakeOpencodeClient();
    client.promptHook = (call) => {
      const reusedMessageId = nativeMessageId(100);
      client.emit(
        partEvent(MAIN, reusedMessageId, {
          type: "text",
          id: call.partId,
          text: call.text,
        }),
      );
      client.emit(messageEvent(MAIN, reusedMessageId, "user"));
    };
    const running = await launch(client);
    running.session.pushUserInput("one marker, one message");

    const timeout = setTimeout(() => running.ac.abort(), 500);
    await expect(running.run).rejects.toThrow(/reused.*(?:part|correlation marker)/i);
    clearTimeout(timeout);
    expect(client.prompts).toHaveLength(1);
    expect(client.aborts).toBe(0);
  });

  it("does not correlate or acknowledge a marker-only partial SSE observation", async () => {
    const client = new FakeOpencodeClient();
    client.promptEventHook = (call, message) => {
      const marker = message.parts[0];
      if (marker === undefined) throw new Error("fake prompt lacked its marker");
      client.emit(statusEvent(call.sessionId, "busy"));
      client.emit(partEvent(call.sessionId, message.info.id, { ...marker }));
    };
    const running = await launch(client);
    const acked: string[] = [];
    const originalAck = running.session.ack.bind(running.session);
    Object.defineProperty(running.session, "ack", {
      configurable: true,
      value: (eventId: string) => {
        acked.push(eventId);
        originalAck(eventId);
      },
    });

    const browser = running.session.pushUserInput("wait for the canonical whole message");
    await waitFor(() => client.prompts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(acked).not.toContain(browser.eventId);
    expect(upstream(running.session, "user")).toEqual([]);
    await stop(running.ac, running.run);
  });

  it("coalesces whole-part resends once and rejects changed reuse", async () => {
    const running = await launch();
    const parentId = nativeMessageId(100);
    const id = nativeMessageId(200);
    const textPartId = nativePartId(1);
    emitUser(running.client, parentId, "");
    running.client.emit(partEvent(MAIN, id, { type: "text", id: textPartId, text: "partial" }));
    running.client.emit(partEvent(MAIN, id, { type: "text", id: textPartId, text: "final" }));
    running.client.emit(messageEvent(MAIN, id, "assistant", true, parentId));
    await waitFor(() => upstream(running.session, "assistant").length === 1);

    running.client.emit(partEvent(MAIN, id, { type: "text", id: textPartId, text: "final" }));
    running.client.emit(messageEvent(MAIN, id, "assistant", true, parentId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upstream(running.session, "assistant")).toHaveLength(1);

    running.client.emit(partEvent(MAIN, id, { type: "text", id: textPartId, text: "changed" }));
    running.client.emit(messageEvent(MAIN, id, "assistant", true, parentId));
    await expect(running.run).rejects.toThrow(/reused a message id|changed content/);
    expect(running.client.aborts).toBe(0);
  });

  it("treats queued exact parts and completion after history emission as the same message", async () => {
    const client = new FakeOpencodeClient();
    const parentId = nativeMessageId(100);
    const messageId = nativeMessageId(200);
    const firstPartId = nativePartId(1);
    const queuedPartId = nativePartId(2);
    client.historySnapshots = [
      [
        userHistory(parentId, ""),
        {
          info: {
            id: messageId,
            role: "assistant",
            parentID: parentId,
            time: { completed: 2 },
          },
          parts: [
            {
              type: "text",
              id: firstPartId,
              messageID: messageId,
              text: "before ",
            },
            {
              type: "text",
              id: queuedPartId,
              messageID: messageId,
              text: "and during history",
            },
          ],
        },
      ],
    ];
    const running = await launch(client);

    client.emit(
      partEvent(MAIN, messageId, {
        type: "text",
        id: queuedPartId,
        text: "and during history",
      }),
    );
    client.emit(messageEvent(MAIN, messageId, "assistant", true, parentId));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(upstream(running.session, "assistant")).toHaveLength(1);
    await stop(running.ac, running.run);
  });

  it("applies the native 1.17.5 part-removal shape before completion", async () => {
    const running = await launch();
    const parentId = nativeMessageId(100);
    const messageId = nativeMessageId(200);
    const keptPartId = nativePartId(1);
    const removedPartId = nativePartId(2);
    emitUser(running.client, parentId, "");
    running.client.emit(partEvent(MAIN, messageId, { type: "text", id: keptPartId, text: "kept" }));
    running.client.emit(
      partEvent(MAIN, messageId, { type: "text", id: removedPartId, text: "removed" }),
    );
    running.client.emit({
      type: "message.part.removed",
      properties: { sessionID: MAIN, messageID: messageId, partID: removedPartId },
    });
    running.client.emit(messageEvent(MAIN, messageId, "assistant", true, parentId));
    await waitFor(() => upstream(running.session, "assistant").length === 1);

    expect(upstream(running.session, "assistant")[0]?.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "kept" }],
    });
    await stop(running.ac, running.run);
  });

  it("fences removals of canonical content and whole native messages", async () => {
    const partRemoval = await launch();
    const canonicalMessageId = nativeMessageId(2);
    emitAssistant(partRemoval.client, canonicalMessageId, "shared");
    await waitFor(() => upstream(partRemoval.session, "assistant").length === 1);
    partRemoval.client.emit({
      type: "message.part.removed",
      properties: {
        sessionID: MAIN,
        messageID: canonicalMessageId,
        partID: nativePartForMessage(canonicalMessageId),
      },
    });
    await expect(partRemoval.run).rejects.toThrow(/removed already projected content/);
    expect(partRemoval.client.aborts).toBe(0);

    const messageRemoval = await launch();
    const removedMessageId = nativeMessageId(2);
    emitAssistant(messageRemoval.client, removedMessageId, "already shared");
    await waitFor(() => upstream(messageRemoval.session, "assistant").length === 1);
    messageRemoval.client.emit({
      type: "message.removed",
      properties: { sessionID: MAIN, messageID: removedMessageId },
    });
    await expect(messageRemoval.run).rejects.toThrow(/removed a native message/);
    expect(messageRemoval.client.aborts).toBe(0);
  });

  it("fences malformed own-session message events before they can flush buffered users", async () => {
    const running = await launch();
    const waitingUserId = nativeMessageId(1);
    running.client.emit(
      partEvent(MAIN, waitingUserId, {
        type: "text",
        id: nativePartId(1),
        text: "not canonical yet",
      }),
    );
    running.client.emit(messageEvent(MAIN, waitingUserId, "user"));
    running.client.emit({
      type: "message.updated",
      properties: { sessionID: MAIN, info: { role: "assistant", time: { completed: 2 } } },
    });

    await expect(running.run).rejects.toThrow(/invalid message update/);
    expect(upstream(running.session, "user")).toEqual([]);
    expect(running.client.aborts).toBe(0);
  });

  it("fences deletion of the attached native session", async () => {
    const running = await launch();
    running.client.emit({
      type: "session.deleted",
      properties: { sessionID: MAIN, info: { id: MAIN } },
    });

    await expect(running.run).rejects.toThrow(/deleted an attached native session/);
    expect(running.client.aborts).toBe(0);
  });

  it("fences after one rejected prompt and never retries or mutates the native session on teardown", async () => {
    const client = new FakeOpencodeClient();
    client.promptError = new Error("ambiguous prompt failure");
    const running = await launch(client);
    running.session.pushUserInput("one attempt");

    await expect(running.run).rejects.toThrow(OpencodeProjectionError);
    expect(client.prompts).toHaveLength(1);
    expect(client.aborts).toBe(0);
  });

  it("allows a successful interrupt followed by later text", async () => {
    const running = await launch();
    running.session.pushControlRequest("interrupt");
    await waitFor(() => running.client.aborts === 1);
    running.session.pushUserInput("after interrupt");
    await waitFor(() => running.client.prompts.length === 1);
    expect(running.client.prompts[0]?.text).toBe("after interrupt");
    await stop(running.ac, running.run);
    expect(running.client.aborts).toBe(1);
  });

  it("fences after one rejected interrupt", async () => {
    const client = new FakeOpencodeClient();
    client.abortError = new Error("abort outcome unknown");
    const running = await launch(client);
    running.session.pushControlRequest("interrupt");

    await expect(running.run).rejects.toThrow(OpencodeProjectionError);
    expect(client.aborts).toBe(1);
    expect(client.prompts).toEqual([]);
  });

  it("defensively rejects slash input instead of restoring the retired compact route", async () => {
    const running = await launch();
    running.session.pushUserInput("/compact");
    await expect(running.run).rejects.toThrow(/unsupported browser text/);
    expect(running.client.prompts).toEqual([]);
    expect(running.client.aborts).toBe(0);
  });

  it.each([
    ["idle", "idle"],
    ["busy", "running"],
    ["retry", "running"],
  ] as const)("surfaces a native session error and converges viewer status from exact %s", async (nativeStatus, viewerStatus) => {
    const running = await launch();
    running.client.emit(statusEvent(MAIN, "busy"));
    await waitFor(() => running.session.workerStatus === "running");
    running.client.sessionStatus = nativeStatus;
    running.client.emit({
      type: "session.error",
      properties: { sessionID: MAIN, error: { data: { message: "provider failed" } } },
    });
    await waitFor(
      () =>
        upstream(running.session, "result").length === 1 &&
        running.client.sessionStatusGets.length === 2,
    );
    expect(upstream(running.session, "result")[0]?.result).toContain("provider failed");
    expect(running.session.workerStatus).toBe(viewerStatus);

    // Viewer-status convergence is read-only: even an exact idle result does not bypass the stricter
    // history/correlation gate that owns the next browser mutation.
    running.session.pushUserInput("must remain gated after provider failure");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(running.client.prompts).toEqual([]);
    await stop(running.ac, running.run);
    expect(running.client.aborts).toBe(0);
  });
});

describe("OpenCode M2 recovery and ownership", () => {
  it("projects only exact main lifecycle and requires strict idle reproof", async () => {
    const running = await launch();
    expect(running.session.workerStatus).toBe("idle");
    const statusGets = running.client.sessionStatusGets.length;

    running.client.emit({
      type: "session.created",
      properties: {
        sessionID: CHILD,
        info: { id: CHILD, parentID: MAIN, agent: "research" },
      },
    });
    running.client.emit(statusEvent(CHILD, "busy"));
    running.client.emit({
      type: "session.error",
      properties: { sessionID: CHILD, error: { data: { message: "child failed" } } },
    });
    running.client.emit(idleEvent(CHILD));
    await waitFor(() => upstream(running.session, "result").length === 1);
    expect(running.session.workerStatus).toBe("idle");
    expect(running.client.sessionStatusGets).toHaveLength(statusGets);

    running.client.emit(statusEvent(MAIN, "retry"));
    await waitFor(() => running.session.workerStatus === "running");
    running.client.emit(statusEvent(MAIN, "idle"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(running.session.workerStatus).toBe("running");

    running.client.sessionStatus = "busy";
    running.client.emit(idleEvent());
    await waitFor(() => running.client.sessionStatusGets.length === statusGets + 1);
    expect(running.session.workerStatus).toBe("running");

    running.client.sessionStatus = "idle";
    running.client.emit(idleEvent());
    await waitFor(() => running.client.sessionStatusGets.length === statusGets + 2);
    expect(running.session.workerStatus).toBe("idle");
    await stop(running.ac, running.run);
  });

  it("fences an invalid live main-session status", async () => {
    const running = await launch();
    running.client.emit({
      type: "session.status",
      properties: { sessionID: MAIN, status: { type: "unknown" } },
    } as unknown as OpencodeEvent);

    await expect(running.run).rejects.toThrow(/invalid native status/);
  });

  it("closes admission for a new main user but not a duplicate update of an old user", async () => {
    const existingUserId = nativeMessageId(1);
    const duplicateClient = new FakeOpencodeClient();
    duplicateClient.historySnapshots = [[userHistory(existingUserId, "existing")]];
    const duplicate = await launch(duplicateClient);
    duplicateClient.emit(messageEvent(MAIN, existingUserId, "user"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    duplicate.session.pushUserInput("duplicate must not close admission");
    await waitFor(() => duplicateClient.prompts.length === 1);
    await stop(duplicate.ac, duplicate.run);

    const freshClient = new FakeOpencodeClient();
    const fresh = await launch(freshClient);
    emitUser(freshClient, nativeMessageId(1), "new native turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fresh.session.pushUserInput("must wait behind native turn");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(freshClient.prompts).toEqual([]);
    await stop(fresh.ac, fresh.run);
  });

  it.each([
    "busy",
    "retry",
  ] as const)("does not release queued browser text when idle reconciliation still reports %s", async (status) => {
    const client = new FakeOpencodeClient();
    const nativeUserId = nativeMessageId(1);
    client.historySnapshots = [[], [userHistory(nativeUserId, "native turn")]];
    const running = await launch(client);
    client.sessionStatus = status;
    emitUser(client, nativeUserId, "native turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    running.session.pushUserInput("queued browser turn");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.prompts).toEqual([]);

    client.emit(idleEvent());
    await waitFor(() => client.sessionStatusGets.length === 2);
    expect(client.prompts).toEqual([]);

    client.sessionStatus = "idle";
    client.emit(idleEvent());
    await waitFor(() => client.prompts.length === 1);
    await stop(running.ac, running.run);
  });

  it("fences if native idle follows the active marker with a newer TUI user", async () => {
    const client = new FakeOpencodeClient();
    client.promptEventHook = (call, browserMessage) => {
      client.emit(statusEvent(call.sessionId, "busy"));
      for (const part of browserMessage.parts) {
        client.emit(partEvent(call.sessionId, browserMessage.info.id, { ...part }));
      }
      client.emit(messageEvent(call.sessionId, browserMessage.info.id, "user"));

      const tuiMessage = userHistory(
        nativeMessageId(PROMPT_MESSAGE_BASE + 100),
        "newer TUI steering",
      );
      client.promptedMessages.push(tuiMessage);
      for (const part of tuiMessage.parts) {
        client.emit(partEvent(call.sessionId, tuiMessage.info.id, { ...part }));
      }
      client.emit(messageEvent(call.sessionId, tuiMessage.info.id, "user"));
      client.emit(statusEvent(call.sessionId, "idle"));
      client.emit(idleEvent(call.sessionId));
    };
    const running = await launch(client);
    running.session.pushUserInput("browser turn being overtaken");

    await expect(running.run).rejects.toThrow(/advanced past the active browser turn/);
    expect(client.prompts).toHaveLength(1);
    expect(client.aborts).toBe(0);
  });

  it("rejects poisoned history where a legacy msg_rc user sorts after its native assistant", async () => {
    const client = new FakeOpencodeClient();
    const legacyUserId = "msg_rc_123e4567e89b42d3a456426614174000";
    client.historySnapshots = [
      [
        userHistory(legacyUserId, "legacy caller-selected identity"),
        assistantHistory(nativeMessageId(1), "native reply", legacyUserId),
      ],
    ];
    const broker = new FakeBroker();
    const context = await makeContext(client, broker, () => {});

    await expect(new OpencodeDriver(context).run(new AbortController().signal)).resolves.toBe(1);
    expect(broker.posts).toEqual([]);
    expect(client.aborts).toBe(0);
  });

  it.each([
    ["missing", undefined, /invalid message update/],
    ["dangling", nativeMessageId(1), /did not bind the latest native user/],
  ] as const)("fences a live assistant with a %s native parent", async (_kind, parentId, error) => {
    const running = await launch();
    const assistantId = nativeMessageId(2);
    running.client.emit(
      partEvent(MAIN, assistantId, {
        type: "text",
        id: nativePartId(10),
        text: "must not project",
      }),
    );
    running.client.emit(messageEvent(MAIN, assistantId, "assistant", true, parentId));

    await expect(running.run).rejects.toThrow(error);
    expect(running.client.aborts).toBe(0);
  });

  it("fences an assistant bound to an earlier rather than the latest preceding user", async () => {
    const client = new FakeOpencodeClient();
    const earlierUserId = nativeMessageId(1);
    const latestUserId = nativeMessageId(2);
    const assistantId = nativeMessageId(3);
    client.historySnapshots = [[userHistory(earlierUserId, ""), userHistory(latestUserId, "")]];
    const running = await launch(client);
    running.client.emit(
      partEvent(MAIN, assistantId, {
        type: "text",
        id: nativePartId(10),
        text: "wrong turn",
      }),
    );
    running.client.emit(messageEvent(MAIN, assistantId, "assistant", true, earlierUserId));

    await expect(running.run).rejects.toThrow(/did not bind the latest native user/);
    expect(running.client.aborts).toBe(0);
  });

  it("fences if a live assistant changes its already-observed native parent", async () => {
    const client = new FakeOpencodeClient();
    const firstParentId = nativeMessageId(1);
    const secondParentId = nativeMessageId(2);
    const assistantId = nativeMessageId(3);
    client.historySnapshots = [[userHistory(firstParentId, ""), userHistory(secondParentId, "")]];
    const running = await launch(client);
    running.client.emit(
      partEvent(MAIN, assistantId, {
        type: "text",
        id: nativePartId(10),
        text: "answer",
      }),
    );
    running.client.emit(messageEvent(MAIN, assistantId, "assistant", false, secondParentId));
    running.client.emit(messageEvent(MAIN, assistantId, "assistant", false, firstParentId));

    await expect(running.run).rejects.toThrow(/changed an assistant parent/);
    expect(client.aborts).toBe(0);
  });

  it("accepts increasing assistant siblings that share one native user parent", async () => {
    const client = new FakeOpencodeClient();
    const parentId = nativeMessageId(1);
    const firstAssistantId = nativeMessageId(2);
    const secondAssistantId = nativeMessageId(3);
    client.historySnapshots = [
      [
        userHistory(parentId, "one turn"),
        assistantHistory(firstAssistantId, "tool prelude", parentId),
        assistantHistory(secondAssistantId, "final answer", parentId),
      ],
    ];
    const running = await launch(client);

    expect(upstream(running.session, "assistant").map((payload) => payload.uuid)).toEqual([
      firstAssistantId,
      secondAssistantId,
    ]);
    await stop(running.ac, running.run);
  });

  it("pauses writes through reconnect and resumes only after exact history reconciliation", async () => {
    const client = new FakeOpencodeClient();
    const parentId = nativeMessageId(1);
    const assistantId = nativeMessageId(2);
    client.historySnapshots = [
      [],
      [userHistory(parentId, ""), assistantHistory(assistantId, "once", parentId)],
    ];
    const gate = deferred();
    client.historyBarriers.set(2, gate.promise);
    const running = await launch(client);

    emitAssistant(client, assistantId, "once");
    await waitFor(() => upstream(running.session, "assistant").length === 1);
    client.drop(0);
    await waitFor(() => client.historyCalls === 2, 3_000);
    expect(client.versionCalls).toBe(3);
    expect(client.sessionGets).toEqual([MAIN, MAIN, MAIN]);

    running.session.pushUserInput("held behind recovery");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.prompts).toEqual([]);
    gate.resolve();
    await waitFor(() => client.prompts.length === 1);
    expect(upstream(running.session, "assistant")).toHaveLength(1);
    await stop(running.ac, running.run);
  });

  it("retains the last proved viewer status while reconnect keeps writes paused", async () => {
    const client = new FakeOpencodeClient();
    client.historySnapshots = [[], []];
    const gate = deferred();
    client.historyBarriers.set(2, gate.promise);
    const running = await launch(client);
    expect(running.session.workerStatus).toBe("idle");

    client.drop(0);
    await waitFor(() => client.historyCalls === 2, 3_000);
    expect(running.session.workerStatus).toBe("idle");
    running.session.pushUserInput("held behind status reproof");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.prompts).toEqual([]);

    gate.resolve();
    await waitFor(() => client.prompts.length === 1);
    expect(client.sessionStatusGets.length).toBeGreaterThanOrEqual(2);
    await stop(running.ac, running.run);
  });

  it("fences if history inserts a missed message behind projected order", async () => {
    const client = new FakeOpencodeClient();
    const missedId = nativeMessageId(1);
    const observedId = nativeMessageId(2);
    client.historySnapshots = [
      [userHistory(observedId, "a")],
      [userHistory(missedId, "missed"), userHistory(observedId, "a")],
    ];
    const running = await launch(client);
    client.drop(0);

    await expect(running.run).rejects.toThrow(/history changed behind projected order/);
    expect(client.aborts).toBe(0);
  });

  it("fences if the same history identity changes content", async () => {
    const client = new FakeOpencodeClient();
    const messageId = nativeMessageId(1);
    client.historySnapshots = [
      [userHistory(messageId, "before")],
      [userHistory(messageId, "after")],
    ];
    const running = await launch(client);
    client.drop(0);

    await expect(running.run).rejects.toThrow(/reused a message id|changed content/);
    expect(client.aborts).toBe(0);
  });

  it("treats strict-history response failure as terminal, not best effort", async () => {
    const client = new FakeOpencodeClient();
    client.historyErrors.set(1, new OpencodeError(0, "malformed history"));
    const broker = new FakeBroker();
    const context = await makeContext(client, broker, () => {});

    await expect(new OpencodeDriver(context).run(new AbortController().signal)).resolves.toBe(1);
    expect(broker.posts).toEqual([]);
    expect(client.aborts).toBe(0);
  });

  it("broker projection loss stops the companion without aborting OpenCode", async () => {
    const running = await launch();
    running.broker.failContent = true;
    emitAssistant(running.client, nativeMessageId(2), "native stays alive");

    await expect(running.run).resolves.toBe(0);
    expect(running.client.aborts).toBe(0);
  });

  it("restart creates a fresh projection, observes history, and never replays an old command", async () => {
    const client = new FakeOpencodeClient();
    const text = "first projection command";
    const first = await launch(client);
    first.session.pushUserInput(text, { clientMsgId: "first-browser" });
    await waitFor(() => client.prompts.length === 1);
    const nativeId = client.promptedMessages[0]?.info.id;
    if (nativeId === undefined) throw new Error("fake did not generate a native message id");
    await waitFor(() => upstream(first.session, "user").length === 1);
    const firstSessionId = first.session.id;
    await stop(first.ac, first.run);

    const second = await launch(client);
    await waitFor(() => upstream(second.session, "user").length === 1);
    expect(second.session.id).not.toBe(firstSessionId);
    expect(client.prompts).toHaveLength(1);
    expect(upstream(second.session, "user")[0]).toMatchObject({
      uuid: nativeId,
      local_prompt: true,
      message: { content: text },
    });
    expect(upstream(second.session, "user")[0]).not.toHaveProperty("client_msg_id");
    await stop(second.ac, second.run);
  });

  it("retains useful child-session nesting without widening the M2 browser control surface", async () => {
    const running = await launch();
    const parentUserId = nativeMessageId(1);
    const parentAssistantId = nativeMessageId(2);
    const childUserId = nativeMessageId(3);
    const childAssistantId = nativeMessageId(4);
    const taskPartId = nativePartId(10);
    emitUser(running.client, parentUserId, "");
    running.client.emit(
      partEvent(MAIN, parentAssistantId, {
        type: "subtask",
        id: taskPartId,
        agent: "research",
        prompt: "inspect",
        description: "child",
      }),
    );
    running.client.emit({
      type: "session.created",
      properties: {
        sessionID: CHILD,
        info: { id: CHILD, parentID: MAIN, agent: "research" },
      },
    });
    running.client.emit(messageEvent(MAIN, parentAssistantId, "assistant", true, parentUserId));

    running.client.emit(
      partEvent(CHILD, childUserId, {
        type: "text",
        id: nativePartId(2),
        text: "internal prompt",
      }),
    );
    running.client.emit(messageEvent(CHILD, childUserId, "user"));
    running.client.emit(
      partEvent(CHILD, childAssistantId, {
        type: "text",
        id: nativePartId(3),
        text: "child answer",
      }),
    );
    running.client.emit(messageEvent(CHILD, childAssistantId, "assistant", true, childUserId));
    running.client.emit(idleEvent(CHILD));

    await waitFor(() => upstream(running.session, "assistant").length === 2);
    const child = upstream(running.session, "assistant").find(
      (payload) => payload.uuid === childAssistantId,
    );
    expect(child).toMatchObject({ parent_tool_use_id: taskPartId });
    expect(upstream(running.session, "user")).toEqual([]);
    await stop(running.ac, running.run);
  });
});

describe("small exported invariants", () => {
  it("derives the exact native part marker only from a canonical host UUID", () => {
    expect(opencodePartId("123e4567-e89b-42d3-a456-426614174000")).toBe(
      "prt_rc_123e4567e89b42d3a456426614174000",
    );
    expect(() => opencodePartId("not-a-uuid")).toThrow(/noncanonical/);
    expect(() => opencodePartId("123E4567-E89B-42D3-A456-426614174000")).toThrow(/noncanonical/);
    expect(() => opencodePartId("123e4567-e89b-32d3-a456-426614174000")).toThrow(/noncanonical/);
  });

  it("keeps the experimental ask rule before preserved native policy", () => {
    const deny: PermissionRule = { permission: "bash", pattern: "*", action: "deny" };
    expect(mergeAskRules([deny])).toEqual([{ permission: "*", pattern: "*", action: "ask" }, deny]);
  });

  it("extracts a useful viewer error without changing tracing policy", () => {
    expect(errText({ data: { message: "provider detail" } })).toBe("provider detail");
  });
});
