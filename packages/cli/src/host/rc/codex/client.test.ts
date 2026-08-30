import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  assertCodexCompatibility,
  CODEX_APP_SERVER_VERSION,
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
        },
      });
    } else if (message.method === "thread/items/list") {
      this.respond(message.id, { data: [], nextCursor: null });
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
  it("accepts only explicit loopback WebSocket origins and canonical UUIDv7 threads", () => {
    expect(normalizeCodexAppServerUrl("ws://127.0.0.1:4500")).toBe("ws://127.0.0.1:4500");
    expect(normalizeCodexAppServerUrl("ws://[::1]:4500/")).toBe("ws://[::1]:4500");
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
});
