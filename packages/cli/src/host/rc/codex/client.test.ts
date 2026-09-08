import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_B64, MAX_ATTACHMENT_IMAGES } from "../relay.js";
import type { HostImage } from "../session.js";
import {
  assertCodexCompatibility,
  CODEX_APP_SERVER_VERSION,
  CODEX_HISTORY_ITEM_LIMIT,
  CODEX_LEGACY_TURN_PAGE_LIMIT,
  CodexAppServerClient,
  CodexAppServerError,
  type CodexRequestId,
  type CodexServerRequest,
  codexAppServerVersion,
  isCodexThreadId,
  normalizeCodexAppServerUrl,
} from "./client.js";

const THREAD_ID = "01993d50-6c31-7e11-9f70-3a8d9b5e7201";

class FakeSocket {
  readonly #events = new EventTarget();
  readonly sent: Array<Record<string, unknown>> = [];
  readyState: number = WebSocket.OPEN;

  constructor() {
    queueMicrotask(() => this.#events.dispatchEvent(new Event("open")));
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.method === "initialize") {
      this.respond(message.id, {
        userAgent: `remote-claw-codex/${CODEX_APP_SERVER_VERSION} codex-cli/${CODEX_APP_SERVER_VERSION}`,
        platformFamily: "unix",
        platformOs: "linux",
      });
    } else if (message.method === "thread/resume") {
      this.respond(message.id, {
        thread: {
          id: THREAD_ID,
          status: { type: "idle" },
          canAcceptDirectInput: true,
          historyMode: "paginated",
        },
      });
    } else if (message.method === "thread/items/list") {
      this.respond(message.id, { data: [], nextCursor: null });
    } else if (message.method === "thread/turns/list") {
      this.respond(message.id, { data: [], nextCursor: null, backwardsCursor: null });
    } else if (message.method === "turn/start") {
      this.respond(message.id, { turn: { id: "turn-test" } });
    }
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#events.dispatchEvent(new Event("close"));
  }

  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void {
    this.#events.addEventListener(type, listener, options);
  }

  emit(message: Record<string, unknown> | CodexServerRequest): void {
    this.#events.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  respond(id: unknown, result: unknown): void {
    queueMicrotask(() => this.emit({ id, result }));
  }
}

function commandApproval(id: CodexRequestId = 731): CodexServerRequest {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: THREAD_ID,
      turnId: "turn-approval",
      itemId: "item-approval",
      command: "echo example",
      cwd: "/tmp",
      availableDecisions: ["accept", "decline", "cancel"],
    },
  };
}

function takeServerRequest(client: CodexAppServerClient): CodexServerRequest {
  const inbound = client.drainInbound().find((event) => event.kind === "request");
  if (inbound?.kind !== "request") throw new Error("expected native server request");
  return inbound.value;
}

describe("Codex app-server boundary", () => {
  it("sends only text and host-prepared inline images without native policy overrides", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);

    await client.startTurn(THREAD_ID, "text-event", "ordinary text", signal);
    expect(socket.sent.at(-1)?.params).toEqual({
      threadId: THREAD_ID,
      clientUserMessageId: "text-event",
      input: [{ type: "text", text: "ordinary text", text_elements: [] }],
    });

    const images = ["png", "jpeg", "webp", "gif"].map((mime) => ({
      name: `capture.${mime}`,
      url: `data:image/${mime};base64,YQ==`,
      path: "/private/not-an-input",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: "not-an-input",
    }));
    await client.startTurn(THREAD_ID, "image-event", "describe these screenshots", signal, images);
    expect(socket.sent.at(-1)?.params).toEqual({
      threadId: THREAD_ID,
      clientUserMessageId: "image-event",
      input: [
        { type: "text", text: "describe these screenshots", text_elements: [] },
        ...images.map(({ url }) => ({ type: "image", url })),
      ],
    });
    client.close();
  });

  it("rejects paths, remote URLs and malformed image data before any native mutation", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);

    for (const image of [
      { name: "remote.png", url: "https://example.com/private.png" },
      { name: "local.png", url: "file:///private/capture.png" },
      { name: "local.png", path: "/private/capture.png" },
      { name: "payload", url: "data:text/html;base64,YQ==" },
      { name: "vector.svg", url: "data:image/svg+xml;base64,YQ==" },
      { name: "empty.png", url: "data:image/png;base64," },
      { name: "bad.png", url: "data:image/png;base64,AA" },
      { name: "bad.png", url: "data:image/png;base64,A=AA" },
      { name: "bad.png", url: "data:image/png;base64,AAA\n" },
      { name: "bad.png", url: "data:image/png;base64,AAA\r" },
      { name: "bad.png", url: 42 },
      null,
    ]) {
      await expect(
        client.startTurn(THREAD_ID, "invalid-event", "caption", signal, [image] as HostImage[]),
      ).rejects.toThrow("Codex received invalid host-prepared images");
    }
    expect(socket.sent.some((message) => message.method === "turn/start")).toBe(false);
    client.close();
  });

  it("bounds image count, each encoded image and the complete native image group", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    const image = { name: "capture.png", url: "data:image/png;base64,YQ==" };
    const largeImage = {
      name: "large.png",
      url: `data:image/png;base64,${"A".repeat(MAX_ATTACHMENT_B64)}`,
    };

    for (const images of [
      Array.from({ length: MAX_ATTACHMENT_IMAGES + 1 }, () => image),
      [{ ...largeImage, url: `${largeImage.url}AAAA` }],
      [largeImage, largeImage, largeImage],
    ]) {
      await expect(
        client.startTurn(THREAD_ID, "too-large-event", "caption", signal, images),
      ).rejects.toThrow("Codex received invalid host-prepared images");
    }
    expect(socket.sent.some((message) => message.method === "turn/start")).toBe(false);
    client.close();
  });

  it("reads bounded latest-turn metadata without loading items or selecting another thread", async () => {
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    let data: unknown[] = [{ id: "active-turn", status: "inProgress" }];
    socket.send = (raw: string): void => {
      const message = JSON.parse(raw);
      if (message.method !== "thread/turns/list") {
        originalSend(raw);
        return;
      }
      socket.sent.push(message);
      socket.respond(message.id, { data, nextCursor: "older-turns" });
    };
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    await expect(client.activeTurn(THREAD_ID, signal)).resolves.toBe("active-turn");
    expect(socket.sent.at(-1)).toMatchObject({
      method: "thread/turns/list",
      params: { threadId: THREAD_ID, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
    });
    for (const status of ["completed", "interrupted", "failed"]) {
      data = [{ id: "finished-turn", status }];
      await expect(client.activeTurn(THREAD_ID, signal)).resolves.toBeNull();
    }
    data = [];
    await expect(client.activeTurn(THREAD_ID, signal)).resolves.toBeNull();
    for (const malformed of [
      [null],
      [{ id: "", status: "inProgress" }],
      [{ id: "turn", status: "unknown" }],
      [{ id: "turn", status: { toString: "inProgress" } }],
      [
        { id: "turn-1", status: "inProgress" },
        { id: "turn-2", status: "inProgress" },
      ],
    ]) {
      data = malformed;
      await expect(client.activeTurn(THREAD_ID, signal)).rejects.toThrow(/invalid active-turn/);
    }
    client.close();
  });

  it("interrupts one exact target once and treats native stale-target rejection as a no-op", async () => {
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    let reply: Record<string, unknown> = { result: {} };
    socket.send = (raw: string): void => {
      originalSend(raw);
      const message = JSON.parse(raw);
      if (message.method === "turn/interrupt") {
        queueMicrotask(() => socket.emit({ id: message.id, ...reply }));
      }
    };
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    await client.interruptTurn(THREAD_ID, "active-turn", signal);
    expect(socket.sent.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: THREAD_ID, turnId: "active-turn" },
    });
    reply = { error: { code: -32600, message: "native stale target details stay private" } };
    await expect(client.interruptTurn(THREAD_ID, "stale-turn", signal)).resolves.toBeUndefined();
    expect(socket.sent.filter((sent) => sent.method === "turn/interrupt")).toHaveLength(2);
    expect(socket.sent.some((sent) => sent.method === "thread/turns/list")).toBe(false);

    reply = { error: { code: -32603, message: "private native failure details" } };
    await expect(client.interruptTurn(THREAD_ID, "unknown-turn", signal)).rejects.toThrow(
      "Codex turn/interrupt failed",
    );
    for (const malformed of [null, [], { success: true }]) {
      reply = { result: malformed };
      await expect(client.interruptTurn(THREAD_ID, "bad-response", signal)).rejects.toThrow(
        /invalid interrupt response/,
      );
    }
    client.close();
  });

  it("accepts only the managed socket or explicit loopback WebSockets and canonical threads", () => {
    expect(normalizeCodexAppServerUrl("ws://127.0.0.1:4500")).toBe("ws://127.0.0.1:4500");
    expect(normalizeCodexAppServerUrl("ws://[::1]:4500/")).toBe("ws://[::1]:4500");
    expect(normalizeCodexAppServerUrl("unix://")).toBe("unix://");
    expect(isCodexThreadId(THREAD_ID)).toBe(true);

    for (const value of [
      "http://127.0.0.1:4500",
      "wss://127.0.0.1:4500",
      "ws://localhost:4500",
      "ws://0.0.0.0:4500",
      "ws://127.0.0.1",
      "ws://user@127.0.0.1:4500",
      "ws://127.0.0.1:4500/rpc",
      "ws://127.0.0.1:4500/?token=value",
      "ws://127.0.0.1:4500/#fragment",
      "unix:///tmp/another.sock",
    ]) {
      expect(() => normalizeCodexAppServerUrl(value)).toThrow(CodexAppServerError);
    }
    for (const value of [
      "",
      "01993d50-6c31-4e11-9f70-3a8d9b5e7201",
      "01993D50-6C31-7E11-9F70-3A8D9B5E7201",
      "01993d50-6c31-7e11-7f70-3a8d9b5e7201",
      `${THREAD_ID}/other`,
    ]) {
      expect(isCodexThreadId(value)).toBe(false);
    }
  });

  it("pins the two measured app-server versions and runtime compatibility tuple", () => {
    const compatible = {
      userAgent: `some-other-subscriber/${CODEX_APP_SERVER_VERSION} codex-cli/${CODEX_APP_SERVER_VERSION}`,
      platformFamily: "unix",
      platformOs: "linux",
    };
    expect(() =>
      assertCodexCompatibility(compatible, { platform: "linux", arch: "arm64" }),
    ).not.toThrow();
    expect(() =>
      assertCodexCompatibility(
        {
          ...compatible,
          userAgent:
            "Codex Desktop/0.153.4 (Ubuntu 24.4.0; aarch64) unknown (remote-claw-approval-version; 0.0.0)",
        },
        { platform: "linux", arch: "arm64" },
      ),
    ).not.toThrow();
    expect(() =>
      assertCodexCompatibility(
        {
          ...compatible,
          userAgent: "codex_chatgpt_ios_remote/0.153.4 (Ubuntu; aarch64)",
        },
        { platform: "linux", arch: "arm64" },
      ),
    ).not.toThrow();

    for (const [result, runtime] of [
      [
        { ...compatible, userAgent: "some-other-subscriber/0.150.0 codex-cli/0.150.0" },
        { platform: "linux", arch: "arm64" },
      ],
      [
        { ...compatible, userAgent: "subscriber/0.153.3" },
        { platform: "linux", arch: "arm64" },
      ],
      [
        { ...compatible, userAgent: "subscriber/0.153.5" },
        { platform: "linux", arch: "arm64" },
      ],
      [
        { ...compatible, userAgent: "subscriber/0.154.0" },
        { platform: "linux", arch: "arm64" },
      ],
      [
        { ...compatible, userAgent: "subscriber/0.153.4-dev" },
        { platform: "linux", arch: "arm64" },
      ],
      [
        { ...compatible, userAgent: "Codex Desktop/0.150.0 codex-cli/0.153.4" },
        { platform: "linux", arch: "arm64" },
      ],
      [
        { ...compatible, platformFamily: "windows" },
        { platform: "linux", arch: "arm64" },
      ],
      [
        { ...compatible, platformOs: "darwin" },
        { platform: "linux", arch: "arm64" },
      ],
      [compatible, { platform: "linux", arch: "x64" }],
      [compatible, { platform: "darwin", arch: "arm64" }],
    ] as const) {
      expect(() => assertCodexCompatibility(result, runtime)).toThrow(
        /Codex app-server 0\.151\.0 or 0\.153\.4 on Linux arm64/,
      );
    }
  });

  it.each([
    ["Codex Desktop/0.153.4 (Ubuntu 24.4.0; aarch64)", "0.153.4"],
    ["legacy-subscriber/0.151.0 codex-cli/0.151.0", "0.151.0"],
    ["Codex Desktop/0.150.0 codex-cli/0.153.4", "0.150.0"],
    ["subscriber/0.153.4-dev codex-cli/0.153.4", "0.153.4-dev"],
    ["", null],
    ["Codex Desktop", null],
    ["/0.153.4", null],
    ["Codex Desktop/", null],
    ["Codex Desktop/ codex-cli/0.153.4", null],
    ["Codex Desktop/0.153.4/extra", null],
    [" Codex Desktop/0.153.4", null],
    ["Codex\nDesktop/0.153.4", null],
  ])("extracts only the leading product version from %j", (userAgent, expected) => {
    expect(codexAppServerVersion(userAgent as string)).toBe(expected);
  });

  it("rejects a resumed thread without a recognized history mode", async () => {
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string): void => {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.method !== "thread/resume") {
        originalSend(data);
        return;
      }
      socket.sent.push(message);
      socket.respond(message.id, {
        thread: {
          id: THREAD_ID,
          status: { type: "idle" },
          canAcceptDirectInput: true,
          historyMode: "unknown",
        },
      });
    };
    const client = new CodexAppServerClient("ws://127.0.0.1:4500", () => socket);
    const signal = new AbortController().signal;

    await client.initialize(signal);
    await expect(client.resume(THREAD_ID, signal)).rejects.toThrow(CodexAppServerError);
    client.close();
  });

  it("queues server requests passively and never sends a result or error frame", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("ws://127.0.0.1:4500", () => socket);
    const signal = new AbortController().signal;

    await client.initialize(signal);
    expect(socket.sent.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    const outboundBeforeRequest = socket.sent.length;

    socket.emit({
      id: 731,
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD_ID, itemId: "item-approval" },
    });
    await Promise.resolve();

    expect(client.drainInbound()).toEqual([
      {
        kind: "request",
        value: {
          id: 731,
          method: "item/commandExecution/requestApproval",
          params: { threadId: THREAD_ID, itemId: "item-approval" },
        },
      },
    ]);
    expect(socket.sent).toHaveLength(outboundBeforeRequest);
    expect(
      socket.sent.some(
        (message) => message.id === 731 || "result" in message || "error" in message,
      ),
    ).toBe(false);

    client.close();
  });

  it("reuses live replay identity and submits each typed request ID at most once", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    socket.emit(commandApproval(731));
    const numeric = takeServerRequest(client);
    const replay = commandApproval(731);
    replay.params = Object.fromEntries(Object.entries(replay.params).reverse());
    socket.emit(replay);
    expect(takeServerRequest(client)).toBe(numeric);
    socket.emit(commandApproval("731"));
    const textual = takeServerRequest(client);
    expect(client.respondCommandApproval(numeric, "accept", signal)).toBe(true);
    expect(client.respondCommandApproval(numeric, "decline", signal)).toBe(false);
    socket.emit(commandApproval(731));
    expect(client.drainInbound()).toEqual([]);
    expect(client.respondCommandApproval(textual, "cancel", signal)).toBe(true);
    expect(socket.sent.filter((message) => "result" in message)).toEqual([
      { id: 731, result: { decision: "accept" } },
      { id: "731", result: { decision: "cancel" } },
    ]);
    client.close();
  });

  it("only a matching native thread and request ID resolves an already queued approval", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    socket.emit(commandApproval());
    const request = takeServerRequest(client);
    for (const params of [
      { threadId: "another-thread", requestId: 731 },
      { threadId: THREAD_ID, requestId: "731" },
    ]) {
      socket.emit({ method: "serverRequest/resolved", params });
    }
    socket.emit(commandApproval());
    expect(takeServerRequest(client)).toBe(request);
    socket.emit({
      method: "serverRequest/resolved",
      params: { threadId: THREAD_ID, requestId: 731 },
    });
    expect(client.respondCommandApproval(request, "accept", signal)).toBe(false);
    expect(client.drainInbound()).toEqual([
      {
        kind: "notification",
        value: {
          method: "serverRequest/resolved",
          params: { threadId: THREAD_ID, requestId: 731 },
        },
      },
    ]);
    socket.emit(commandApproval());
    expect(client.drainInbound()).toEqual([]);
    expect(socket.sent.some((message) => "result" in message || "error" in message)).toBe(false);
    client.close();
  });

  it.each([
    "pending",
    "consumed",
    "resolved",
  ])("fences changed request-ID reuse while the original is %s", async (state) => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    socket.emit(commandApproval());
    const request = takeServerRequest(client);
    if (state === "consumed") client.respondCommandApproval(request, "decline", signal);
    if (state === "resolved") {
      socket.emit({
        method: "serverRequest/resolved",
        params: { threadId: THREAD_ID, requestId: 731 },
      });
    }
    const before = socket.sent.length;
    const changed = commandApproval();
    changed.params.command = "different command";
    socket.emit(changed);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(client.respondCommandApproval(request, "accept", signal)).toBe(false);
    expect(socket.sent).toHaveLength(before);
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    null,
    {},
  ])("fences unsafe native request ID %j before an old queued decision can send", async (id) => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    socket.emit(commandApproval());
    const request = takeServerRequest(client);
    socket.emit({ ...commandApproval(), id });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(client.respondCommandApproval(request, "accept", signal)).toBe(false);
    expect(socket.sent.some((message) => "result" in message || "error" in message)).toBe(false);
  });

  it("rejects foreign objects, unsupported methods/choices and altered observed requests", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    socket.emit(commandApproval());
    const request = takeServerRequest(client);
    expect(client.respondCommandApproval(structuredClone(request), "accept", signal)).toBe(false);
    expect(client.respondCommandApproval(commandApproval(999), "accept", signal)).toBe(false);
    expect(() =>
      client.respondCommandApproval(request, "acceptForSession" as "accept", signal),
    ).toThrow("unsupported Codex command approval response");
    request.params.command = "changed after observation";
    expect(() => client.respondCommandApproval(request, "accept", signal)).toThrow(
      "unsupported Codex command approval response",
    );
    socket.emit({ ...commandApproval(732), method: "item/fileChange/requestApproval" });
    const fileRequest = takeServerRequest(client);
    expect(() => client.respondCommandApproval(fileRequest, "accept", signal)).toThrow(
      "unsupported Codex command approval response",
    );
    expect(socket.sent.some((message) => "result" in message || "error" in message)).toBe(false);
    client.close();
  });

  it("restricts answers to native available decisions without applying policy amendments", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    const native = commandApproval();
    native.params.availableDecisions = [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } },
      "cancel",
    ];
    socket.emit(native);
    const request = takeServerRequest(client);
    expect(() => client.respondCommandApproval(request, "decline", signal)).toThrow(
      "unsupported Codex command approval response",
    );
    expect(client.respondCommandApproval(request, "cancel", signal)).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ id: 731, result: { decision: "cancel" } });
    client.close();
  });

  it("never sends after abort or close, and consumes an ambiguous write before it throws", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const controller = new AbortController();
    await client.initialize(controller.signal);
    socket.emit(commandApproval());
    const request = takeServerRequest(client);
    controller.abort();
    expect(() => client.respondCommandApproval(request, "accept", controller.signal)).toThrow(
      "operation aborted",
    );
    expect(socket.sent.some((message) => "result" in message)).toBe(false);
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string): void => {
      originalSend(data);
      throw new Error("private socket detail");
    };
    const signal = new AbortController().signal;
    expect(() => client.respondCommandApproval(request, "accept", signal)).toThrow(
      "Codex command approval submission failed",
    );
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(client.respondCommandApproval(request, "accept", signal)).toBe(false);
    socket.emit(commandApproval());
    expect(client.respondCommandApproval(request, "accept", signal)).toBe(false);
    expect(socket.sent.filter((message) => "result" in message)).toHaveLength(1);
    client.close();
  });

  it.each([
    "client",
    "socket",
    "not-open",
  ])("never submits a pending approval when the %s closes", async (closedBy) => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    socket.emit(commandApproval());
    const request = takeServerRequest(client);
    if (closedBy === "client") client.close();
    else if (closedBy === "socket") socket.close();
    else socket.readyState = WebSocket.CLOSING;
    if (closedBy === "not-open") {
      expect(() => client.respondCommandApproval(request, "accept", signal)).toThrow(
        "Codex app-server is not connected",
      );
    } else {
      expect(client.respondCommandApproval(request, "accept", signal)).toBe(false);
    }
    expect(socket.sent.some((message) => "result" in message || "error" in message)).toBe(false);
    client.close();
  });

  it("bounds retained request identities even when native requests were already resolved", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    for (let id = 0; id < CODEX_HISTORY_ITEM_LIMIT; id += 1) {
      socket.emit(commandApproval(id));
      socket.emit({
        method: "serverRequest/resolved",
        params: { threadId: THREAD_ID, requestId: id },
      });
      client.drainInbound();
    }
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.emit(commandApproval(CODEX_HISTORY_ITEM_LIMIT));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(socket.sent.some((message) => "result" in message || "error" in message)).toBe(false);
  });

  it("removes abort listeners after sequential successful requests", async () => {
    const socket = new FakeSocket();
    const client = new CodexAppServerClient("ws://127.0.0.1:4500", () => socket);
    const controller = new AbortController();
    const listenerCount = () => getEventListeners(controller.signal, "abort").length;

    expect(listenerCount()).toBe(0);
    await client.initialize(controller.signal);
    expect(listenerCount()).toBe(0);

    for (let sequence = 0; sequence < 4; sequence += 1) {
      await client.resume(THREAD_ID, controller.signal);
      await client.listItems(THREAD_ID, undefined, controller.signal);
      await client.startTurn(
        THREAD_ID,
        `browser-event-${sequence}`,
        `prompt ${sequence}`,
        controller.signal,
      );
      expect(listenerCount()).toBe(0);
    }

    client.close();
  });

  it("hydrates legacy remote-store turns without using the unsupported item pager", async () => {
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string): void => {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.method !== "thread/turns/list") {
        originalSend(data);
        return;
      }
      socket.sent.push(message);
      socket.respond(message.id, {
        data: [
          {
            id: "turn-legacy",
            items: [
              {
                type: "commandExecution",
                id: "command-visible",
                command: "ls",
                cwd: "/tmp",
                status: "completed",
                aggregatedOutput: "example.ts",
                exitCode: 0,
              },
              { type: "mcpToolCall", id: "tool-hidden" },
              { type: "userMessage", id: "user-legacy", content: [{ type: "text", text: "hi" }] },
              { type: "agentMessage", id: "agent-legacy", text: "hello" },
            ],
          },
        ],
        nextCursor: "next-page",
        backwardsCursor: null,
      });
    };
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;

    await client.initialize(signal);
    const page = await client.listTurnItems(THREAD_ID, "legacy-cursor", signal);

    expect(page).toMatchObject({
      data: [
        { turnId: "turn-legacy", item: { id: "command-visible", type: "commandExecution" } },
        { turnId: "turn-legacy", item: { id: "user-legacy" } },
        { turnId: "turn-legacy", item: { id: "agent-legacy" } },
      ],
      nextCursor: "next-page",
    });
    expect(socket.sent.find((message) => message.method === "thread/turns/list")).toMatchObject({
      params: {
        threadId: THREAD_ID,
        cursor: "legacy-cursor",
        limit: CODEX_LEGACY_TURN_PAGE_LIMIT,
        sortDirection: "asc",
        itemsView: "full",
      },
    });
    expect(CODEX_LEGACY_TURN_PAGE_LIMIT).toBe(1);
    expect(socket.sent.some((message) => message.method === "thread/items/list")).toBe(false);

    client.close();
  });

  it("does not charge unsupported tool activity against the legacy projection", async () => {
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string): void => {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.method !== "thread/turns/list") {
        originalSend(data);
        return;
      }
      socket.sent.push(message);
      socket.respond(message.id, {
        data: [
          {
            id: "turn-legacy",
            items: [
              ...Array.from({ length: 10_001 }, (_, index) => ({
                type: "mcpToolCall",
                id: `tool-${index}`,
              })),
              { type: "userMessage", id: "user-visible", content: [{ type: "text", text: "hi" }] },
              { type: "agentMessage", id: "agent-visible", text: "hello" },
            ],
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      });
    };
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;

    await client.initialize(signal);
    const page = await client.listTurnItems(THREAD_ID, undefined, signal);

    expect(page.data.map((entry) => entry.item.id)).toEqual(["user-visible", "agent-visible"]);
    client.close();
  });

  it("retains command observations in paginated history while excluding unsupported tool families", async () => {
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string) => {
      const message = JSON.parse(data);
      if (message.method !== "thread/items/list") {
        originalSend(data);
        return;
      }
      socket.sent.push(message);
      socket.respond(message.id, {
        data: [
          {
            turnId: "turn",
            item: {
              type: "commandExecution",
              id: "command",
              command: "ls",
              cwd: "/tmp",
              status: "completed",
              aggregatedOutput: null,
              exitCode: 0,
            },
          },
          { turnId: "turn", item: { type: "mcpToolCall", id: "unsupported" } },
        ],
        nextCursor: null,
      });
    };
    const client = new CodexAppServerClient("unix://", () => socket);
    const signal = new AbortController().signal;
    await client.initialize(signal);
    const page = await client.listItems(THREAD_ID, undefined, signal);
    expect(page.data).toMatchObject([
      { turnId: "turn", item: { type: "commandExecution", id: "command" } },
    ]);
    expect(socket.sent.at(-1)?.params).toEqual({
      threadId: THREAD_ID,
      limit: 1,
      sortDirection: "asc",
    });
    client.close();
  });
});
