import { describe, expect, it } from "vitest";
import { AnthropicRcClient, type RcUserEventInput } from "./client.js";
import { AnthropicRcError } from "./errors.js";
import type { AnthropicRcTransport, AnthropicRcTransportRequest } from "./transport.js";

type Reply =
  | Response
  | ((request: AnthropicRcTransportRequest, index: number) => Response | Promise<Response>);

class FakeTransport implements AnthropicRcTransport {
  readonly requests: AnthropicRcTransportRequest[] = [];
  readonly #replies: Reply[];

  constructor(...replies: Reply[]) {
    this.#replies = replies;
  }

  async request(request: AnthropicRcTransportRequest): Promise<Response> {
    const index = this.requests.length;
    this.requests.push(request);
    const reply = this.#replies[index];
    if (reply === undefined) throw new Error(`unexpected request ${index}: ${request.path}`);
    return typeof reply === "function" ? reply(request, index) : reply;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function event(
  eventId: string,
  sequenceNum: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: eventId,
    event_type: "assistant",
    sequence_num: sequenceNum,
    source: "worker",
    created_at: "2026-07-26T04:00:00.000Z",
    payload: {
      type: "assistant",
      message: { role: "assistant", content: "hello" },
    },
    ...extra,
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

describe("AnthropicRcClient configuration", () => {
  it.each([
    0,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
    1.5,
  ])("rejects an unsafe request timeout (%s)", (requestTimeoutMs) => {
    expect(
      () => new AnthropicRcClient({ transport: new FakeTransport(), requestTimeoutMs }),
    ).toThrow(/requestTimeoutMs/);
  });
});

describe("AnthropicRcClient list/history", () => {
  it("reads a session page and preserves its opaque cursor, resume token, and raw fields", async () => {
    const transport = new FakeTransport(
      json({
        data: [
          {
            id: "cse_one",
            title: "api bridge",
            status: "active",
            environment_kind: "bridge",
          },
        ],
        next_cursor: "next-page",
        resume_token: "resume-list",
      }),
    );
    const client = new AnthropicRcClient({ transport });

    const page = await client.listSessions({ cursor: "from/a+b", limit: 2 });

    expect(page).toMatchObject({
      nextCursor: "next-page",
      resumeToken: "resume-list",
      data: [{ id: "cse_one", title: "api bridge", status: "active" }],
    });
    expect(page.data[0]?.raw.environment_kind).toBe("bridge");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      operation: "listSessions",
      method: "GET",
      path: "/v1/code/sessions?cursor=from%2Fa%2Bb&limit=2",
      accept: "application/json",
    });
  });

  it("reads caller-driven history pages without coercing canonical sequence strings", async () => {
    const transport = new FakeTransport(
      json({
        data: [event("evt_41", "900719925474099312345")],
        next_cursor: "history/next",
      }),
      json({
        data: [
          event("evt_42", "900719925474099312346", {
            event_type: "result",
            payload: { type: "result", result: "done" },
          }),
        ],
        next_cursor: null,
      }),
    );
    const client = new AnthropicRcClient({ transport });

    const first = await client.history("cse/a", { limit: 1 });
    if (first.nextCursor === null) throw new Error("missing history cursor");
    const second = await client.history("cse/a", {
      cursor: first.nextCursor,
      limit: 1,
    });

    expect(first.data[0]).toMatchObject({
      eventId: "evt_41",
      eventType: "assistant",
      sequenceNum: "900719925474099312345",
      source: "worker",
    });
    expect(second.data[0]).toMatchObject({
      eventId: "evt_42",
      eventType: "result",
      sequenceNum: "900719925474099312346",
    });
    expect(transport.requests.map((request) => request.path)).toEqual([
      "/v1/code/sessions/cse%2Fa/events?sort_order=asc&limit=1",
      "/v1/code/sessions/cse%2Fa/events?sort_order=asc&cursor=history%2Fnext&limit=1",
    ]);
  });

  it("preserves the resume cursor observed on ascending native history", async () => {
    const transport = new FakeTransport(
      json({
        data: [event("evt_resume", "41")],
        resume_cursor: "41",
      }),
    );

    await expect(new AnthropicRcClient({ transport }).history("cse_resume")).resolves.toMatchObject(
      {
        nextCursor: null,
        resumeCursor: "41",
        data: [{ eventId: "evt_resume", sequenceNum: "41" }],
      },
    );
  });
});

describe("AnthropicRcClient.postEvent", () => {
  it("posts the exact user-event envelope and returns Anthropic's canonical acknowledgement", async () => {
    const canonical = {
      event_id: "evt_server_41",
      sequence_num: "900719925474099312345",
    };
    const transport = new FakeTransport(
      json({ results: [{ ...canonical, duplicate: false }] }),
      json({ results: [{ ...canonical, duplicate: true }] }),
    );
    const client = new AnthropicRcClient({ transport });
    const input: RcUserEventInput = {
      uuid: "client-generated-uuid",
      timestamp: "2026-07-26T04:01:02.003Z",
      message: { role: "user", content: "Reply with APPLE" },
      parentToolUseId: null,
    };

    await expect(client.postEvent("cse/a", input)).resolves.toEqual({
      eventId: "evt_server_41",
      sequenceNum: "900719925474099312345",
      duplicate: false,
    });
    await expect(client.postEvent("cse/a", input)).resolves.toEqual({
      eventId: "evt_server_41",
      sequenceNum: "900719925474099312345",
      duplicate: true,
    });

    expect(transport.requests).toHaveLength(2);
    for (const request of transport.requests) {
      expect(request).toMatchObject({
        operation: "postEvent",
        method: "POST",
        path: "/v1/code/sessions/cse%2Fa/events",
        accept: "application/json",
      });
      expect(JSON.parse(request.body ?? "{}")).toEqual({
        events: [
          {
            payload: {
              type: "user",
              message: { role: "user", content: "Reply with APPLE" },
              uuid: "client-generated-uuid",
              session_id: "cse/a",
              timestamp: "2026-07-26T04:01:02.003Z",
              parent_tool_use_id: null,
            },
          },
        ],
      });
    }
    expect(transport.requests[0]?.body).toBe(transport.requests[1]?.body);
  });

  it.each([
    ["empty content", { message: { role: "user", content: "" } }],
    ["oversized content", { message: { role: "user", content: "x".repeat(100_001) } }],
    ["oversized UUID", { uuid: "u".repeat(513) }],
    ["empty parent tool id", { parentToolUseId: "" }],
  ])("rejects %s before dispatch", async (_label, override) => {
    const transport = new FakeTransport();
    const client = new AnthropicRcClient({ transport });
    const input = {
      uuid: "client-generated-uuid",
      timestamp: "2026-07-26T04:01:02.003Z",
      message: { role: "user", content: "hello" },
      parentToolUseId: null,
      ...override,
    } as RcUserEventInput;

    await expect(client.postEvent("cse_input", input)).rejects.toMatchObject({
      kind: "protocol",
      retryable: false,
      outcomeUnknown: false,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it.each([
    null,
    undefined,
    [],
    "not-an-event",
  ])("rejects a non-object event before dispatch", async (input) => {
    const transport = new FakeTransport();
    const client = new AnthropicRcClient({ transport });

    await expect(
      client.postEvent("cse_input", input as unknown as RcUserEventInput),
    ).rejects.toMatchObject({
      kind: "protocol",
      operation: "postEvent",
      retryable: false,
      outcomeUnknown: false,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("sanitizes unreadable event objects before dispatch", async () => {
    const transport = new FakeTransport();
    const client = new AnthropicRcClient({ transport });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingGetter = {
      get uuid() {
        throw new Error("private-event-getter-canary");
      },
    };

    for (const input of [revoked.proxy, throwingGetter]) {
      const error = await client
        .postEvent("cse_input", input as unknown as RcUserEventInput)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        kind: "protocol",
        operation: "postEvent",
        retryable: false,
        outcomeUnknown: false,
      });
      expect(String(error)).not.toContain("private-event-getter-canary");
    }
    expect(transport.requests).toHaveLength(0);
  });

  it("snapshots validated event fields once before serialization", async () => {
    const transport = new FakeTransport(
      json({
        results: [{ duplicate: false, event_id: "evt_snapshot", sequence_num: "1" }],
      }),
    );
    const client = new AnthropicRcClient({ transport });
    let uuidReads = 0;
    let messageReads = 0;
    const input = {
      get uuid() {
        uuidReads += 1;
        return uuidReads === 1 ? "stable-uuid" : "x".repeat(513);
      },
      timestamp: "2026-07-26T04:01:02.003Z",
      get message() {
        messageReads += 1;
        return messageReads === 1
          ? { role: "user", content: "hello" }
          : { role: "user", content: "x".repeat(100_001) };
      },
      parentToolUseId: null,
    } as RcUserEventInput;

    await expect(client.postEvent("cse_input", input)).resolves.toEqual({
      eventId: "evt_snapshot",
      sequenceNum: "1",
      duplicate: false,
    });
    expect(uuidReads).toBe(1);
    expect(messageReads).toBe(1);
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toMatchObject({
      events: [
        {
          payload: {
            uuid: "stable-uuid",
            message: { role: "user", content: "hello" },
          },
        },
      ],
    });
  });
});

describe("AnthropicRcClient.streamEvents", () => {
  it("calls onOpen only after a valid SSE response reader is ready", async () => {
    const invalidResponses = [
      new Response("unavailable", {
        status: 503,
        headers: { "content-type": "text/event-stream" },
      }),
      new Response(null, { headers: { "content-type": "text/event-stream" } }),
      new Response("{}", { headers: { "content-type": "application/json" } }),
    ];
    const invalidReader = sse([]);
    if (invalidReader.body === null) throw new Error("missing test body");
    Object.defineProperty(invalidReader.body, "getReader", {
      value: () => {
        throw new Error("reader unavailable");
      },
    });
    invalidResponses.push(invalidReader);

    for (const response of invalidResponses) {
      let opens = 0;
      const client = new AnthropicRcClient({ transport: new FakeTransport(response) });
      await expect(
        collect(
          client.streamEvents("cse_not_ready", {
            signal: new AbortController().signal,
            onOpen: () => {
              opens += 1;
            },
          }),
        ),
      ).rejects.toBeDefined();
      expect(opens).toBe(0);
    }

    const ready = sse([`data: ${JSON.stringify(event("evt_ready", "1"))}\n\n`]);
    let bodyLockedAtOpen = false;
    let opens = 0;
    const items = await collect(
      new AnthropicRcClient({ transport: new FakeTransport(ready) }).streamEvents("cse_ready", {
        signal: new AbortController().signal,
        onOpen: () => {
          opens += 1;
          bodyLockedAtOpen = ready.body?.locked === true;
        },
      }),
    );

    expect(opens).toBe(1);
    expect(bodyLockedAtOpen).toBe(true);
    expect(items).toMatchObject([{ kind: "event", event: { eventId: "evt_ready" } }]);
  });

  it("skips standalone comments and parses CRLF, split chunks, multiline data, and SSE metadata", async () => {
    const wire = event("evt_sse", "17");
    const serialized = JSON.stringify(wire);
    const split = serialized.indexOf(',"event_type"');
    expect(split).toBeGreaterThan(0);
    const transport = new FakeTransport(
      sse([
        ": keepalive\r",
        "\n\r\n",
        "event: ping\r\n",
        "id: heartbeat-only\r\n\r\n",
        "event: client_event\r\n",
        "id: stream-17\r\n",
        `data: ${serialized.slice(0, split + 1)}\r\n`,
        ": comment inside the event\r\n",
        `data: ${serialized.slice(split + 1)}\r`,
        "\n\r",
        "\n",
      ]),
    );
    const client = new AnthropicRcClient({ transport });

    const items = await collect(
      client.streamEvents("cse_stream", { signal: new AbortController().signal }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "event",
      eventName: "client_event",
      sseId: "stream-17",
      event: {
        eventId: "evt_sse",
        eventType: "assistant",
        sequenceNum: "17",
        source: "worker",
      },
    });
    expect(transport.requests[0]).toMatchObject({
      operation: "streamEvents",
      method: "GET",
      path: "/v1/code/sessions/cse_stream/events/stream",
      accept: "text/event-stream",
    });
  });

  it("surfaces noncanonical tagged records as opaque frames without terminating the stream", async () => {
    const tags = [
      "delivery_update",
      "ephemeral_event",
      "catch_up_truncated",
      "session_update",
      "future_record",
    ];
    const transport = new FakeTransport(
      sse(
        tags.map(
          (tag, index) =>
            `event: ${tag}\nid: opaque-${index}\ndata: ${JSON.stringify({
              tag,
              nested: { sequence_num: String(index + 1) },
            })}\n\n`,
        ),
      ),
    );
    const client = new AnthropicRcClient({ transport });

    const items = await collect(
      client.streamEvents("cse_union", { signal: new AbortController().signal }),
    );

    expect(items).toHaveLength(tags.length);
    expect(items.map((item) => item.kind)).toEqual(tags.map(() => "frame"));
    expect(items.map((item) => item.eventName)).toEqual(tags);
    expect(items.at(-1)).toMatchObject({
      kind: "frame",
      eventName: "future_record",
      sseId: "opaque-4",
      data: { tag: "future_record", nested: { sequence_num: "5" } },
    });
  });

  it("keeps simultaneous long-lived streams independent when one is aborted", async () => {
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const cancelled = [false, false];
    const transport = new FakeTransport(
      ...[0, 1].map(
        (index): Reply =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controllers[index] = controller;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify(
                      event(index === 0 ? "evt_a" : "evt_b", String(index + 1)),
                    )}\n\n`,
                  ),
                );
              },
              cancel() {
                cancelled[index] = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const client = new AnthropicRcClient({ transport });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = client.streamEvents("cse_shared", { signal: firstAbort.signal });
    const second = client.streamEvents("cse_shared", { signal: secondAbort.signal });

    await expect(first.next()).resolves.toMatchObject({
      value: { event: { eventId: "evt_a" } },
      done: false,
    });
    await expect(second.next()).resolves.toMatchObject({
      value: { event: { eventId: "evt_b" } },
      done: false,
    });

    const firstParked = first.next();
    firstAbort.abort();
    await expect(firstParked).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toEqual([true, false]);

    const secondParked = second.next();
    controllers[1]?.enqueue(encoder.encode(`data: ${JSON.stringify(event("evt_b2", "3"))}\n\n`));
    await expect(secondParked).resolves.toMatchObject({
      value: { event: { eventId: "evt_b2" } },
      done: false,
    });
    controllers[1]?.close();
    await expect(second.next()).resolves.toEqual({ value: undefined, done: true });
    expect(cancelled).toEqual([true, false]);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.map((request) => request.path)).toEqual([
      "/v1/code/sessions/cse_shared/events/stream",
      "/v1/code/sessions/cse_shared/events/stream",
    ]);
  });

  it("sanitizes an injected SSE Response failure while acquiring its reader", async () => {
    const response = sse([]);
    if (response.body === null) throw new Error("missing test body");
    Object.defineProperty(response.body, "getReader", {
      value: () => {
        throw new AnthropicRcError(
          "network",
          "private-sse-response-operation-canary",
          null,
          true,
          "private-sse-response-reader-canary",
        );
      },
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    const error = await collect(
      client.streamEvents("cse_stream", { signal: new AbortController().signal }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "network",
      operation: "streamEvents",
      retryable: true,
      outcomeUnknown: false,
    });
    expect(String(error)).not.toMatch(
      /private-sse-response-operation-canary|private-sse-response-reader-canary/,
    );
  });

  it("accepts CR-only framing, including a final blank line ending exactly at EOF", async () => {
    const transport = new FakeTransport(
      sse([`data: ${JSON.stringify(event("evt_cr", "18"))}\r\r`]),
    );
    const client = new AnthropicRcClient({ transport });

    const items = await collect(
      client.streamEvents("cse_cr", { signal: new AbortController().signal }),
    );

    expect(items).toMatchObject([{ kind: "event", event: { eventId: "evt_cr" } }]);
  });

  it("applies the size cap per SSE frame rather than to a chunk containing many frames", async () => {
    const frames = Array.from({ length: 24 }, (_, index) => {
      const wire = event(`evt_bulk_${index}`, String(index + 1), {
        payload: { type: "assistant", padding: "x".repeat(50_000) },
      });
      return `data: ${JSON.stringify(wire)}\n\n`;
    }).join("");
    expect(frames.length).toBeGreaterThan(1024 * 1024);
    const client = new AnthropicRcClient({
      transport: new FakeTransport(sse([frames])),
    });

    const items = await collect(
      client.streamEvents("cse_bulk", { signal: new AbortController().signal }),
    );

    expect(items).toHaveLength(24);
    expect(items.at(-1)).toMatchObject({
      kind: "event",
      event: { eventId: "evt_bulk_23" },
    });
  });

  it("stops before a second event already buffered in the same chunk when its signal is aborted", async () => {
    const wire = [event("evt_first", "1"), event("evt_second", "2")]
      .map((item) => `data: ${JSON.stringify(item)}\n\n`)
      .join("");
    const client = new AnthropicRcClient({
      transport: new FakeTransport(sse([wire])),
    });
    const abort = new AbortController();
    const stream = client.streamEvents("cse_abort", { signal: abort.signal });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { event: { eventId: "evt_first" } },
    });
    abort.abort();

    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("AnthropicRcClient malformed bodies", () => {
  it("never advertises a failed write as automatically retryable", async () => {
    const input: RcUserEventInput = {
      uuid: "stable-write-uuid",
      timestamp: "2026-07-26T04:01:02.003Z",
      message: { role: "user", content: "private-body-canary" },
      parentToolUseId: null,
    };
    const unknown = new AnthropicRcClient({
      transport: new FakeTransport(new Response("private-response-canary", { status: 503 })),
    });
    const rejected = new AnthropicRcClient({
      transport: new FakeTransport(new Response(null, { status: 429 })),
    });

    const unknownFailure = unknown.postEvent("cse_write", input);
    await expect(unknownFailure).rejects.toMatchObject({
      kind: "http",
      status: 503,
      retryable: false,
      outcomeUnknown: true,
    });
    await expect(unknownFailure).rejects.not.toThrow(/private-body-canary|private-response-canary/);
    await expect(rejected.postEvent("cse_write", input)).rejects.toMatchObject({
      kind: "http",
      status: 429,
      retryable: false,
      outcomeUnknown: false,
    });
  });

  it("overrides unsafe write metadata from an injected transport", async () => {
    const client = new AnthropicRcClient({
      transport: new FakeTransport(() => {
        throw new AnthropicRcError(
          "network",
          "private-transport-operation-canary",
          null,
          true,
          "private-transport-message-canary",
          null,
          false,
        );
      }),
    });

    const error = await client
      .postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "network",
      operation: "postEvent",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(String(error)).not.toMatch(
      /private-transport-operation-canary|private-transport-message-canary/,
    );
  });

  it("sanitizes an injected Response failure before a write body reader is acquired", async () => {
    const response = json({
      results: [{ duplicate: false, event_id: "evt_unused", sequence_num: "1" }],
    });
    if (response.body === null) throw new Error("missing test body");
    Object.defineProperty(response.body, "getReader", {
      value: () => {
        throw new AnthropicRcError(
          "network",
          "private-response-operation-canary",
          null,
          true,
          "private-response-reader-canary",
          null,
          false,
        );
      },
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    const error = await client
      .postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "network",
      operation: "postEvent",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(String(error)).not.toMatch(
      /private-response-operation-canary|private-response-reader-canary/,
    );
  });

  it("snapshots an injected write reader result before inspecting its accessors", async () => {
    const response = json({
      results: [{ duplicate: false, event_id: "evt_unused", sequence_num: "1" }],
    });
    if (response.body === null) throw new Error("missing test body");
    const reader = response.body.getReader();
    Object.defineProperty(reader, "read", {
      value: async () => {
        const result = {};
        Object.defineProperty(result, "done", {
          get() {
            throw new Error("private-reader-result-canary");
          },
        });
        return result;
      },
    });
    Object.defineProperty(response.body, "getReader", {
      value: () => reader,
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    const error = await client
      .postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "network",
      operation: "postEvent",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(String(error)).not.toContain("private-reader-result-canary");
  });

  it("classifies a status-zero Response as a network boundary, including ambiguous writes", async () => {
    const getClient = new AnthropicRcClient({
      transport: new FakeTransport(Response.error()),
    });
    await expect(getClient.listSessions()).rejects.toMatchObject({
      kind: "network",
      status: null,
      retryable: true,
      outcomeUnknown: false,
    });

    const postClient = new AnthropicRcClient({
      transport: new FakeTransport(Response.error()),
    });
    await expect(
      postClient.postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      }),
    ).rejects.toMatchObject({
      kind: "network",
      status: null,
      retryable: false,
      outcomeUnknown: true,
    });
  });

  it.each([
    [200, false],
    [503, true],
    [0, true],
  ])("rejects contradictory injected Response status %s / ok %s for a write", async (status, ok) => {
    const response = json({
      results: [{ duplicate: false, event_id: "evt_must_not_publish", sequence_num: "1" }],
    });
    Object.defineProperties(response, {
      ok: { configurable: true, value: ok },
      status: { configurable: true, value: status },
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    await expect(
      client.postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      }),
    ).rejects.toMatchObject({
      kind: "network",
      status: null,
      retryable: false,
      outcomeUnknown: true,
    });
  });

  it("cannot hide an intrinsic HTTP write failure behind coherent own success metadata", async () => {
    const response = json(
      {
        results: [{ duplicate: false, event_id: "evt_false_ack", sequence_num: "1" }],
      },
      503,
    );
    Object.defineProperties(response, {
      ok: { configurable: true, value: true },
      status: { configurable: true, value: 200 },
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    await expect(
      client.postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      }),
    ).rejects.toMatchObject({
      kind: "network",
      status: null,
      retryable: false,
      outcomeUnknown: true,
    });
  });

  it("cancels a captured SSE body when a later top-level Response accessor throws", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    Object.defineProperty(response, "ok", {
      configurable: true,
      get() {
        throw new AnthropicRcError(
          "network",
          "private-top-level-operation-canary",
          null,
          true,
          "private-top-level-response-canary",
        );
      },
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    const error = await collect(
      client.streamEvents("cse_stream", { signal: new AbortController().signal }),
    ).catch((caught: unknown) => caught);
    await Promise.resolve();

    expect(error).toMatchObject({
      kind: "network",
      operation: "streamEvents",
      retryable: true,
      outcomeUnknown: false,
    });
    expect(String(error)).not.toMatch(
      /private-top-level-operation-canary|private-top-level-response-canary/,
    );
    expect(cancelled).toBe(true);
  });

  it.each([
    "throws",
    "hides",
  ] as const)("recovers and cancels the intrinsic SSE body when an own body accessor %s it", async (behavior) => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    Object.defineProperty(response, "body", {
      configurable: true,
      ...(behavior === "throws"
        ? {
            get() {
              throw new Error("private-own-body-accessor-canary");
            },
          }
        : { value: null }),
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    const error = await collect(
      client.streamEvents("cse_stream", { signal: new AbortController().signal }),
    ).catch((caught: unknown) => caught);
    await Promise.resolve();

    expect(error).toMatchObject({
      kind: "network",
      operation: "streamEvents",
      retryable: true,
      outcomeUnknown: false,
    });
    expect(String(error)).not.toContain("private-own-body-accessor-canary");
    expect(cancelled).toBe(true);
  });

  it.each([
    "throws",
    "replaces",
  ] as const)("rejects and cleans up when an own Response headers accessor %s the intrinsic headers", async (behavior) => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    Object.defineProperty(response, "headers", {
      configurable: true,
      ...(behavior === "throws"
        ? {
            get() {
              throw new Error("private-own-headers-accessor-canary");
            },
          }
        : { value: new Headers({ "content-type": "text/event-stream" }) }),
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    const error = await collect(
      client.streamEvents("cse_stream", { signal: new AbortController().signal }),
    ).catch((caught: unknown) => caught);
    await Promise.resolve();

    expect(error).toMatchObject({
      kind: "network",
      operation: "streamEvents",
      retryable: true,
      outcomeUnknown: false,
    });
    expect(String(error)).not.toContain("private-own-headers-accessor-canary");
    expect(cancelled).toBe(true);
  });

  it("does not wait for an injected write Response cleanup promise", async () => {
    let cancelStarted: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      cancelStarted = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelStarted();
          return new Promise<void>(() => undefined);
        },
      }),
      { status: 503 },
    );
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"hung">((resolve) => {
      timeout = setTimeout(() => resolve("hung"), 100);
    });
    const pending = client
      .postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      })
      .catch((error: unknown) => error);

    const settled = await Promise.race([pending, deadline]);
    if (timeout !== undefined) clearTimeout(timeout);
    await cancelling;

    expect(settled).not.toBe("hung");
    expect(settled).toMatchObject({
      kind: "http",
      status: 503,
      retryable: false,
      outcomeUnknown: true,
    });
  });

  it("uses the branded write cleanup method instead of hostile own promise accessors", async () => {
    const response = new Response("private-response-body-canary", { status: 503 });
    if (response.body === null) throw new Error("missing test body");
    let ownCancelCalls = 0;
    Object.defineProperty(response.body, "cancel", {
      value: () => {
        ownCancelCalls += 1;
        const cleanup = Promise.reject(new Error("cleanup-rejection-secret-canary"));
        Object.defineProperties(cleanup, {
          catch: {
            configurable: true,
            get() {
              throw new Error("cleanup-catch-accessor-secret-canary");
            },
          },
          constructor: {
            configurable: true,
            get() {
              throw new Error("cleanup-constructor-accessor-secret-canary");
            },
          },
        });
        return cleanup;
      },
    });
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    await expect(
      client.postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      }),
    ).rejects.toMatchObject({
      kind: "http",
      status: 503,
      retryable: false,
      outcomeUnknown: true,
    });
    await Promise.resolve();
    expect(ownCancelCalls).toBe(0);
  });

  it("rejects hostile SSE and write header values inside the response sanitizer", async () => {
    const sseResponse = sse([]);
    Object.defineProperty(sseResponse.headers, "get", {
      value: () => ({
        split() {
          throw new AnthropicRcError(
            "network",
            "private-sse-header-operation-canary",
            null,
            true,
            "private-sse-header-canary",
          );
        },
      }),
    });
    const sseClient = new AnthropicRcClient({
      transport: new FakeTransport(sseResponse),
    });
    const sseError = await collect(
      sseClient.streamEvents("cse_stream", { signal: new AbortController().signal }),
    ).catch((caught: unknown) => caught);
    expect(sseError).toMatchObject({
      kind: "network",
      retryable: true,
      outcomeUnknown: false,
    });
    expect(String(sseError)).not.toMatch(
      /private-sse-header-operation-canary|private-sse-header-canary/,
    );

    const postResponse = json({
      results: [{ duplicate: false, event_id: "evt_unused", sequence_num: "1" }],
    });
    Object.defineProperty(postResponse.headers, "get", {
      value: () => ({
        [Symbol.toPrimitive]() {
          throw new AnthropicRcError(
            "network",
            "private-write-header-operation-canary",
            null,
            true,
            "private-write-header-canary",
          );
        },
      }),
    });
    const postClient = new AnthropicRcClient({
      transport: new FakeTransport(postResponse),
    });
    const postError = await postClient
      .postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      })
      .catch((caught: unknown) => caught);
    expect(postError).toMatchObject({
      kind: "network",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(String(postError)).not.toMatch(
      /private-write-header-operation-canary|private-write-header-canary/,
    );
  });

  it("copies write response chunks without trusting typed-array own accessors", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        results: [{ duplicate: false, event_id: "evt_safe_copy", sequence_num: "7" }],
      }),
    );
    const actualLength = bytes.byteLength;
    let ownByteLengthReads = 0;
    Object.defineProperty(bytes, "byteLength", {
      configurable: true,
      get() {
        ownByteLengthReads += 1;
        if (ownByteLengthReads > 1) {
          throw new AnthropicRcError(
            "network",
            "private-chunk-operation-canary",
            null,
            true,
            "private-chunk-accessor-canary",
          );
        }
        return actualLength;
      },
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const client = new AnthropicRcClient({ transport: new FakeTransport(response) });

    await expect(
      client.postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      }),
    ).resolves.toEqual({
      duplicate: false,
      eventId: "evt_safe_copy",
      sequenceNum: "7",
    });
    expect(ownByteLengthReads).toBe(0);
  });

  it("falls back safely when injected typed-error metadata accessors throw", async () => {
    const hostileError = (canary: string): AnthropicRcError => {
      const error = AnthropicRcError.network("private-error-operation-canary");
      Object.defineProperty(error, "kind", {
        configurable: true,
        get() {
          throw new Error(canary);
        },
      });
      return error;
    };

    const getClient = new AnthropicRcClient({
      transport: new FakeTransport(() => {
        throw hostileError("private-get-error-accessor-canary");
      }),
    });
    const getError = await getClient.listSessions().catch((caught: unknown) => caught);
    expect(getError).toMatchObject({
      kind: "network",
      retryable: true,
      outcomeUnknown: false,
    });
    expect(String(getError)).not.toContain("private-get-error-accessor-canary");

    const postClient = new AnthropicRcClient({
      transport: new FakeTransport(() => {
        throw hostileError("private-post-error-accessor-canary");
      }),
    });
    const postError = await postClient
      .postEvent("cse_write", {
        uuid: "stable-write-uuid",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      })
      .catch((caught: unknown) => caught);
    expect(postError).toMatchObject({
      kind: "network",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(String(postError)).not.toContain("private-post-error-accessor-canary");
  });

  it("rejects malformed list, history, acknowledgement, and SSE bodies as protocol errors", async () => {
    const cases: Array<{
      operation: string;
      outcomeUnknown: boolean;
      run: (client: AnthropicRcClient) => Promise<unknown>;
      response: Response;
    }> = [
      {
        operation: "listSessions",
        outcomeUnknown: false,
        response: json({ data: "not-an-array" }),
        run: (client) => client.listSessions(),
      },
      {
        operation: "history",
        outcomeUnknown: false,
        response: json({
          data: [event("evt_bad_sequence", "1", { sequence_num: 1 })],
          next_cursor: null,
        }),
        run: (client) => client.history("cse_bad"),
      },
      {
        operation: "postEvent",
        outcomeUnknown: true,
        response: json({ results: [] }),
        run: (client) =>
          client.postEvent("cse_bad", {
            uuid: "client-uuid",
            timestamp: "2026-07-26T04:01:02.003Z",
            message: { role: "user", content: "hello" },
            parentToolUseId: null,
          }),
      },
      {
        operation: "streamEvents",
        outcomeUnknown: false,
        response: sse(["data: {not-json}\n\n"]),
        run: (client) =>
          collect(client.streamEvents("cse_bad", { signal: new AbortController().signal })),
      },
      {
        operation: "streamEvents",
        outcomeUnknown: false,
        response: json({ error: "not an event stream" }),
        run: (client) =>
          collect(client.streamEvents("cse_bad", { signal: new AbortController().signal })),
      },
    ];

    for (const testCase of cases) {
      const client = new AnthropicRcClient({
        transport: new FakeTransport(testCase.response),
      });
      const error = await testCase.run(client).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AnthropicRcError);
      expect(error).toMatchObject({
        kind: "protocol",
        operation: testCase.operation,
        outcomeUnknown: testCase.outcomeUnknown,
        retryable: false,
      });
    }
  });

  it("rejects a successful JSON response with no body", async () => {
    const client = new AnthropicRcClient({
      transport: new FakeTransport(new Response(null, { status: 200 })),
    });

    await expect(client.listSessions()).rejects.toMatchObject({
      kind: "protocol",
      operation: "listSessions",
    });
  });

  it("preserves an incomplete client_event envelope as an opaque frame", async () => {
    const client = new AnthropicRcClient({
      transport: new FakeTransport(
        sse([
          `event: client_event\ndata: ${JSON.stringify({
            event_id: "evt_incomplete",
            sequence_num: "1",
            source: "worker",
          })}\n\n`,
        ]),
      ),
    });

    await expect(
      collect(client.streamEvents("cse_bad", { signal: new AbortController().signal })),
    ).resolves.toMatchObject([
      {
        kind: "frame",
        eventName: "client_event",
        data: {
          event_id: "evt_incomplete",
          sequence_num: "1",
          source: "worker",
        },
      },
    ]);
  });
});

describe("AnthropicRcClient aborts", () => {
  it("sanitizes a raw SSE transport cancellation from an injected transport", async () => {
    const abort = new AbortController();
    const transport = new FakeTransport(() => {
      const error = new AnthropicRcError(
        "network",
        "private-sse-operation-canary",
        null,
        true,
        "sse-typed-secret-canary",
      );
      abort.abort(error);
      throw error;
    });
    const client = new AnthropicRcClient({ transport });

    const error = await collect(client.streamEvents("cse_abort", { signal: abort.signal })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toMatch(/private-sse-operation-canary|sse-typed-secret-canary/);
  });

  it("sanitizes a typed body error that wins the abort race", async () => {
    const abort = new AbortController();
    const transport = new FakeTransport((request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal?.addEventListener(
            "abort",
            () => controller.error(request.signal?.reason),
            { once: true },
          );
        },
        pull() {
          return new Promise<void>(() => undefined);
        },
      });
      return new Response(body, { status: 200 });
    });
    const client = new AnthropicRcClient({ transport });
    const pending = client.listSessions({ signal: abort.signal });
    const reason = new AnthropicRcError(
      "protocol",
      "private-json-operation-canary",
      null,
      false,
      "json-typed-secret-canary",
    );
    abort.abort(reason);

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toMatch(/private-json-operation-canary|json-typed-secret-canary/);
  });

  it("applies its real timeout signal and preserves conservative POST outcome metadata", async () => {
    const parked = (): Reply => async (request) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = request.signal;
        if (signal === undefined) throw new Error("missing request signal");
        const fail = () => reject(signal.reason);
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });

    const getClient = new AnthropicRcClient({
      transport: new FakeTransport(parked()),
      requestTimeoutMs: 5,
    });
    const getFailure = getClient.listSessions();
    await expect(getFailure).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(getFailure).rejects.not.toBeInstanceOf(AnthropicRcError);

    const postClient = new AnthropicRcClient({
      transport: new FakeTransport(parked()),
      requestTimeoutMs: 5,
    });
    await expect(
      postClient.postEvent("cse_timeout", {
        uuid: "stable-timeout-write",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      kind: "network",
      retryable: false,
      outcomeUnknown: true,
    });
  });

  it("preserves AbortError when cancellation happens while a JSON body read is parked", async () => {
    let bodyReadStarted: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    let cancelled = false;
    const transport = new FakeTransport(() => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          bodyReadStarted();
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });
    const client = new AnthropicRcClient({ transport });
    const abort = new AbortController();
    const pending = client.listSessions({ signal: abort.signal });

    await reading;
    abort.abort(new DOMException("private-json-abort-canary", "AbortError"));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(AnthropicRcError);
    expect(String(error)).not.toContain("private-json-abort-canary");
    expect(cancelled).toBe(true);
  });

  it("marks an abort after a write response starts as indeterminate and non-retryable", async () => {
    let bodyReadStarted: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    let cancelled = false;
    const transport = new FakeTransport(() => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          bodyReadStarted();
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new AnthropicRcClient({ transport });
    const abort = new AbortController();
    const pending = client.postEvent(
      "cse_abort_write",
      {
        uuid: "stable-aborted-write",
        timestamp: "2026-07-26T04:01:02.003Z",
        message: { role: "user", content: "hello" },
        parentToolUseId: null,
      },
      { signal: abort.signal },
    );

    await reading;
    abort.abort(new DOMException("private-write-abort-canary", "AbortError"));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "AbortError",
      kind: "network",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(error).toBeInstanceOf(AnthropicRcError);
    expect(String(error)).not.toContain("private-write-abort-canary");
    expect(cancelled).toBe(true);
  });
});
