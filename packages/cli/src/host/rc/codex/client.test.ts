import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  assertCodexCompatibility,
  CODEX_APP_SERVER_VERSION,
  CODEX_LEGACY_TURN_PAGE_LIMIT,
  CodexAppServerClient,
  CodexAppServerError,
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

  emit(message: Record<string, unknown>): void {
    this.#events.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  respond(id: unknown, result: unknown): void {
    queueMicrotask(() => this.emit({ id, result }));
  }
}

describe("Codex app-server boundary", () => {
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

  it("pins the measured app-server and runtime compatibility tuple", () => {
    const compatible = {
      userAgent: `some-other-subscriber/${CODEX_APP_SERVER_VERSION} codex-cli/${CODEX_APP_SERVER_VERSION}`,
      platformFamily: "unix",
      platformOs: "linux",
    };
    expect(() =>
      assertCodexCompatibility(compatible, { platform: "linux", arch: "arm64" }),
    ).not.toThrow();

    for (const [result, runtime] of [
      [
        { ...compatible, userAgent: "some-other-subscriber/0.150.0 codex-cli/0.150.0" },
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
        /Codex app-server 0\.151\.0 on Linux arm64/,
      );
    }
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
              { type: "commandExecution", id: "tool-hidden" },
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
    expect(socket.sent.some((message) => message.method === "thread/items/list")).toBe(false);

    client.close();
  });

  it("does not charge hidden tool activity against the legacy text projection", async () => {
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
                type: "commandExecution",
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
});
