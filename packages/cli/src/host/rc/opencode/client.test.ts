// Unit tests for OpencodeClient endpoint shapes via an injectable fetch (no real server). Focused on
// summarize() — the /compact native equivalent added for the documented slash-command routing.

import { describe, expect, it } from "vitest";
import {
  isOpencodeMessageId,
  isOpencodePartId,
  isPermissionRule,
  isValidOpencodeMessageInfo,
  isValidOpencodePart,
  normalizeOpencodeBaseUrl,
  OPENCODE_HISTORY_LIMIT,
  OpencodeClient,
  OpencodeError,
  SUPPORTED_OPENCODE_VERSION,
} from "./client.js";

interface Captured {
  url: string;
  method: string | undefined;
  body: string | undefined;
  headers: Headers;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
}

function nativeMessageId(index: number): string {
  return `msg_${index.toString(16).padStart(12, "0")}${index.toString(36).padStart(14, "0")}`;
}

function nativePartId(index: number): string {
  return `prt_${index.toString(16).padStart(12, "0")}${index.toString(36).padStart(14, "0")}`;
}

const MESSAGE_1 = nativeMessageId(1);
const MESSAGE_2 = nativeMessageId(2);
const PART_1 = nativePartId(1);
const BROWSER_PART = "prt_rc_00000000000000000000000000000001";

/** A fetch double recording each call and returning a Response-like with the given ok/status. */
function fakeFetch(captured: Captured[], ok = true, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      signal: init?.signal,
    });
    return {
      ok,
      status,
      text: async () => "",
      json: async () => true,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("OpenCode server trust boundary", () => {
  it.each([
    ["http://127.0.0.1:4096", "http://127.0.0.1:4096"],
    ["http://127.0.0.1:4096/", "http://127.0.0.1:4096"],
    ["http://[::1]:4096", "http://[::1]:4096"],
    ["http://127.0.0.1:80", "http://127.0.0.1:80"],
    ["http://[::1]:80/", "http://[::1]:80"],
  ])("canonicalizes supported literal-loopback origin %s", (input, expected) => {
    expect(normalizeOpencodeBaseUrl(input)).toBe(expected);
  });

  it.each([
    "https://127.0.0.1:4096",
    "http://localhost:4096",
    "http://127.0.0.2:4096",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:99999",
    "http://user:pass@127.0.0.1:4096",
    "http://127.0.0.1:4096/api",
    "http://127.0.0.1:4096/?query=1",
    "http://127.0.0.1:4096/#fragment",
    " http://127.0.0.1:4096",
    "http://127.0.0.1:4096\n",
  ])("rejects unsupported origin %s", (input) => {
    expect(() => normalizeOpencodeBaseUrl(input)).toThrow(/OpenCode URL/);
  });

  it("uses redirect:error and preserves Basic-auth username/password bytes", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      username: "operator",
      password: "  päss\n",
      fetchFn: fakeFetch(calls),
    });

    await client.abort("ses_1");

    expect(calls[0]?.redirect).toBe("error");
    expect(calls[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("operator:  päss\n").toString("base64")}`,
    );
  });
});

describe("OpenCode pinned readiness", () => {
  it("accepts only a healthy exact 1.17.5 response", async () => {
    const client = new OpencodeClient({
      fetchFn: fakeFetchBody({ healthy: true, version: SUPPORTED_OPENCODE_VERSION }),
    });
    await expect(client.requireSupportedVersion()).resolves.toBeUndefined();
  });

  it.each([
    { healthy: false, version: SUPPORTED_OPENCODE_VERSION },
    { healthy: true, version: "1.17.6" },
    { healthy: true },
  ])("rejects unsupported health shape %#", async (body) => {
    const client = new OpencodeClient({ fetchFn: fakeFetchBody(body) });
    await expect(client.requireSupportedVersion()).rejects.toThrow(/1\.17\.5 is required/);
  });
});

describe("OpenCode exact-session status", () => {
  it.each([
    [{}, "idle"],
    [{ ses_1: { type: "idle" } }, "idle"],
    [{ ses_1: { type: "busy" } }, "busy"],
    [{ ses_1: { type: "retry" } }, "retry"],
  ] as const)("maps the active status snapshot %#", async (body, expected) => {
    const client = new OpencodeClient({ fetchFn: fakeFetchBody(body) });
    await expect(client.getSessionStatus("ses_1")).resolves.toBe(expected);
  });

  it.each([
    null,
    [],
    { ses_1: null },
    { ses_1: {} },
    { ses_1: { type: "running" } },
  ])("rejects a malformed exact-session status %#", async (body) => {
    const client = new OpencodeClient({ fetchFn: fakeFetchBody(body) });
    await expect(client.getSessionStatus("ses_1")).rejects.toBeInstanceOf(OpencodeError);
  });

  it("uses the exact status route and caller signal", async () => {
    const calls: Captured[] = [];
    const signal = new AbortController().signal;
    const client = new OpencodeClient({
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
          signal: init?.signal,
        });
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as typeof fetch,
    });

    await client.getSessionStatus("ses_1", signal);

    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/session/status");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.signal).toBe(signal);
  });
});

describe("OpenCode consumed-shape guards", () => {
  it("accepts only canonical native message coordinates", () => {
    expect(isOpencodeMessageId(MESSAGE_1)).toBe(true);
    expect(isOpencodeMessageId("msg_")).toBe(false);
    expect(isOpencodeMessageId("msg_rc_00000000000000000000000000000001")).toBe(false);
    expect(isOpencodeMessageId("other_1")).toBe(false);
    expect(isOpencodePartId(PART_1)).toBe(true);
    expect(isOpencodePartId(BROWSER_PART)).toBe(true);
    expect(isOpencodePartId("prt_")).toBe(false);
    expect(isOpencodePartId("msg_1")).toBe(false);
  });

  it("binds message identity to the expected session and validates completion time", () => {
    expect(
      isValidOpencodeMessageInfo(
        {
          id: MESSAGE_2,
          sessionID: "ses_1",
          role: "assistant",
          parentID: MESSAGE_1,
          time: { completed: 1 },
        },
        "ses_1",
      ),
    ).toBe(true);
    expect(
      isValidOpencodeMessageInfo({ id: MESSAGE_2, sessionID: "ses_1", role: "assistant" }, "ses_1"),
    ).toBe(false);
    expect(
      isValidOpencodeMessageInfo({ id: MESSAGE_1, sessionID: "ses_other", role: "user" }, "ses_1"),
    ).toBe(false);
    expect(
      isValidOpencodeMessageInfo(
        {
          id: MESSAGE_2,
          sessionID: "ses_1",
          role: "assistant",
          parentID: MESSAGE_1,
          time: { completed: NaN },
        },
        "ses_1",
      ),
    ).toBe(false);
  });

  it("validates consumed known-part fields while retaining opaque part types", () => {
    const identity = { id: PART_1, messageID: MESSAGE_1, sessionID: "ses_1" };
    expect(
      isValidOpencodePart({ ...identity, type: "text", text: "hello" }, MESSAGE_1, "ses_1"),
    ).toBe(true);
    expect(
      isValidOpencodePart(
        {
          ...identity,
          type: "tool",
          callID: "call_1",
          tool: "bash",
          state: { status: "completed", output: "done" },
        },
        MESSAGE_1,
        "ses_1",
      ),
    ).toBe(true);
    expect(isValidOpencodePart({ ...identity, type: "snapshot" }, MESSAGE_1, "ses_1")).toBe(true);
    expect(
      isValidOpencodePart({ ...identity, type: "reasoning", text: 1 }, MESSAGE_1, "ses_1"),
    ).toBe(false);
    expect(
      isValidOpencodePart(
        { ...identity, type: "tool", callID: "call_1", tool: "bash", state: { status: "done" } },
        MESSAGE_1,
        "ses_1",
      ),
    ).toBe(false);
    expect(
      isValidOpencodePart({ ...identity, type: "subtask", prompt: 1 }, MESSAGE_1, "ses_1"),
    ).toBe(false);
  });
});

describe("OpencodeClient cancellation-aware session endpoints", () => {
  it("threads the caller signal through attach, permission-setup, and abort requests", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      const href = String(url);
      const isCreate = href.endsWith("/session") && init?.method === "POST";
      const isExactGet = href.endsWith("/session/ses_new") && init?.method === "GET";
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () =>
          href.endsWith("/abort") ? true : isCreate || isExactGet ? { id: "ses_new" } : [],
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchFn });
    const ac = new AbortController();

    await client.listSessions(ac.signal);
    await expect(client.createSession("new", ac.signal)).resolves.toBe("ses_new");
    await client.getSessionPermission("ses_new", ac.signal);
    await client.setSessionPermission(
      "ses_new",
      [{ permission: "*", pattern: "*", action: "ask" }],
      ac.signal,
    );
    await client.abort("ses_new", ac.signal);

    expect(signals).toEqual([ac.signal, ac.signal, ac.signal, ac.signal, ac.signal]);
  });

  it("a hung list request rejects promptly when its signal is aborted", async () => {
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        const fail = () => reject(new DOMException("The operation was aborted", "AbortError"));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener("abort", fail, { once: true });
      });
    }) as unknown as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchFn });
    const ac = new AbortController();
    const pending = client.listSessions(ac.signal);

    ac.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("OpencodeClient.summarize (/compact native equivalent)", () => {
  it("POSTs /session/{id}/summarize with { providerID, modelID, auto:false }", async () => {
    const calls: Captured[] = [];
    const c = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchFn: fakeFetch(calls) });
    await c.summarize("ses_1", {
      providerID: "amazon-bedrock",
      modelID: "global.anthropic.claude-sonnet-4-6",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/session/ses_1/summarize");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      providerID: "amazon-bedrock",
      modelID: "global.anthropic.claude-sonnet-4-6",
      auto: false,
    });
  });

  it("throws OpencodeError on a non-ok response", async () => {
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetch([], false, 500),
    });
    await expect(c.summarize("ses_1", { providerID: "p", modelID: "m" })).rejects.toThrow(
      /summarize failed: 500/,
    );
  });
});

describe("OpencodeClient.promptAsync", () => {
  it("lets OpenCode mint the message ID and sends an exact caller part marker", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({ fetchFn: fakeFetch(calls, true, 204) });

    await client.promptAsync("ses_1", {
      text: "  preserve me\n",
      model: { providerID: "amazon-bedrock", modelID: "model" },
      partId: BROWSER_PART,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/session/ses_1/prompt_async");
    expect(calls[0]?.redirect).toBe("error");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      model: { providerID: "amazon-bedrock", modelID: "model" },
      parts: [{ id: BROWSER_PART, type: "text", text: "  preserve me\n" }],
    });
  });

  it("rejects a noncanonical caller part ID before fetch", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({ fetchFn: fakeFetch(calls, true, 204) });

    await expect(
      client.promptAsync("ses_1", {
        text: "hello",
        model: { providerID: "p", modelID: "m" },
        partId: "browser-controlled",
      }),
    ).rejects.toThrow(/invalid caller part id/);
    expect(calls).toHaveLength(0);
  });

  it("requires the exact 204 receipt, not an arbitrary successful response", async () => {
    const client = new OpencodeClient({ fetchFn: fakeFetch([], true, 200) });
    await expect(
      client.promptAsync("ses_1", {
        text: "hello",
        model: { providerID: "p", modelID: "m" },
        partId: BROWSER_PART,
      }),
    ).rejects.toThrow(/promptAsync failed: 200/);
  });
});

describe("OpencodeClient.abort", () => {
  it("requires a literal true native acknowledgement", async () => {
    const client = new OpencodeClient({ fetchFn: fakeFetchBody({ accepted: true }) });
    await expect(client.abort("ses_1")).rejects.toThrow(/invalid acknowledgement/);
  });
});

describe("OpencodeClient bounded strict history", () => {
  const message = (index = 1) => {
    const id = nativeMessageId(index);
    return {
      info: { id, sessionID: "ses_1", role: "user" },
      parts: [
        { id: nativePartId(index), messageID: id, sessionID: "ses_1", type: "text", text: "hello" },
      ],
    };
  };

  it("requests one over the cap and returns only a fully valid chronological snapshot", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
          signal: init?.signal,
        });
        return { ok: true, status: 200, json: async () => [message()] } as Response;
      }) as typeof fetch,
    });

    await expect(client.getMessages("ses_1")).resolves.toEqual([message()]);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:4096/session/ses_1/message?limit=${OPENCODE_HISTORY_LIMIT + 1}`,
    );
  });

  it.each([
    null,
    {},
    [{ info: { id: "msg_1", sessionID: "ses_1", role: "user" }, parts: "not-parts" }],
    [{ info: { id: "bad", sessionID: "ses_1", role: "user" }, parts: [] }],
    [{ info: { id: "msg_1", sessionID: "ses_1", role: "system" }, parts: [] }],
    [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user" },
        parts: [{ id: "prt_1", messageID: "msg_2", sessionID: "ses_1", type: "text", text: "x" }],
      },
    ],
    [message(), message()],
  ])("rejects malformed or ambiguous snapshot %#", async (body) => {
    const client = new OpencodeClient({ fetchFn: fakeFetchBody(body) });
    await expect(client.getMessages("ses_1")).rejects.toBeInstanceOf(OpencodeError);
  });

  it("rejects a history larger than the projection bound", async () => {
    const body = Array.from({ length: OPENCODE_HISTORY_LIMIT + 1 }, (_, i) => message(i + 1));
    const client = new OpencodeClient({ fetchFn: fakeFetchBody(body) });
    await expect(client.getMessages("ses_1")).rejects.toThrow(/exceeds the reconciliation limit/);
  });

  it.each([
    {
      name: "cross-session message info",
      body: [
        {
          info: { id: "msg_1", sessionID: "ses_other", role: "user" },
          parts: [],
        },
      ],
    },
    {
      name: "cross-session part",
      body: [
        {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            parentID: "msg_user",
          },
          parts: [
            {
              id: "prt_1",
              messageID: "msg_1",
              sessionID: "ses_other",
              type: "text",
              text: "x",
            },
          ],
        },
      ],
    },
    {
      name: "duplicate part ID",
      body: [
        {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            parentID: "msg_user",
          },
          parts: [
            {
              id: "prt_same",
              messageID: "msg_1",
              sessionID: "ses_1",
              type: "text",
              text: "first",
            },
            {
              id: "prt_same",
              messageID: "msg_1",
              sessionID: "ses_1",
              type: "text",
              text: "second",
            },
          ],
        },
      ],
    },
    {
      name: "malformed known part",
      body: [
        {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            parentID: "msg_user",
          },
          parts: [
            {
              id: "prt_1",
              messageID: "msg_1",
              sessionID: "ses_1",
              type: "tool",
              callID: "call_1",
              tool: "bash",
              state: { status: "completed", output: 7 },
            },
          ],
        },
      ],
    },
  ])("rejects $name", async ({ body }) => {
    const client = new OpencodeClient({ fetchFn: fakeFetchBody(body) });
    await expect(client.getMessages("ses_1")).rejects.toBeInstanceOf(OpencodeError);
  });

  it("also bounds total part coordinates inside otherwise-small history", async () => {
    const body = [
      {
        info: {
          id: MESSAGE_2,
          sessionID: "ses_1",
          role: "assistant",
          parentID: MESSAGE_1,
          time: { completed: 1 },
        },
        parts: Array.from({ length: OPENCODE_HISTORY_LIMIT + 1 }, (_, index) => ({
          id: nativePartId(index + 1),
          messageID: MESSAGE_2,
          sessionID: "ses_1",
          type: "text",
          text: "x",
        })),
      },
    ];
    const client = new OpencodeClient({ fetchFn: fakeFetchBody(body) });
    await expect(client.getMessages("ses_1")).rejects.toThrow(/history parts exceed/);
  });
});

describe("OpencodeClient.setSessionPermission (flip a session to ask mode)", () => {
  it("PATCHes /session/{id} with { permission: rules }", async () => {
    const calls: Captured[] = [];
    const c = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchFn: fakeFetch(calls) });
    await c.setSessionPermission("ses_9", [{ permission: "*", pattern: "*", action: "ask" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/session/ses_9");
    expect(calls[0]?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });
  });

  it("throws OpencodeError on a non-ok response", async () => {
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetch([], false, 404),
    });
    await expect(
      c.setSessionPermission("ses_9", [{ permission: "*", pattern: "*", action: "ask" }]),
    ).rejects.toThrow(/setSessionPermission failed: 404/);
  });
});

describe("OpencodeClient server-controlled error bodies", () => {
  it("does not copy native response text into exceptions that callers may trace", async () => {
    const secret = "Bearer should-never-reach-a-log";
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: (async () =>
        ({
          ok: false,
          status: 500,
          text: async () => secret,
        }) as unknown as Response) as unknown as typeof fetch,
    });

    const errors = await Promise.all([
      client
        .promptAsync("ses_1", {
          text: "hello",
          model: { providerID: "p", modelID: "m" },
          partId: "prt_rc_1",
        })
        .catch((error: unknown) => String(error)),
      client
        .summarize("ses_1", { providerID: "p", modelID: "m" })
        .catch((error: unknown) => String(error)),
      client
        .setSessionPermission("ses_1", [{ permission: "*", pattern: "*", action: "ask" }])
        .catch((error: unknown) => String(error)),
    ]);

    expect(errors.join("\n")).not.toContain(secret);
  });

  it.each([
    {
      name: "POST /session",
      endpoint: "POST /session",
      call: (client: OpencodeClient) => client.createSession(),
    },
    {
      name: "GET /session",
      endpoint: "GET /session",
      call: (client: OpencodeClient) => client.listSessions(),
    },
    {
      name: "GET /session/{id}",
      endpoint: "GET /session/{id}",
      call: (client: OpencodeClient) => client.getSession("ses_1"),
    },
    {
      name: "GET /session/{id}/message",
      endpoint: "GET /session/{id}/message",
      call: (client: OpencodeClient) => client.getMessages("ses_1"),
    },
  ])("sanitizes a real malformed successful JSON response from $name", async ({
    endpoint,
    call,
  }) => {
    const sentinel = "SENTINEL_NATIVE_RESPONSE_BODY_MUST_NOT_ESCAPE";
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: (async () =>
        new Response(sentinel, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const error = await call(client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpencodeError);
    expect(error).toMatchObject({ status: 200 });
    expect(String(error)).toContain(endpoint);
    expect(String(error)).toContain("200");
    expect(String(error)).not.toContain(sentinel);
  });
});

describe("OpencodeClient.replyPermission (retained OpenCode 1.17.5 route)", () => {
  it("POSTs /permission/{requestID}/reply with { reply } and threads cancellation", async () => {
    const calls: Captured[] = [];
    const ac = new AbortController();
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetch(calls),
    });

    await client.replyPermission("per_9", "once", ac.signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/permission/per_9/reply");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ reply: "once" });
    expect(calls[0]?.signal).toBe(ac.signal);
  });

  it("encodes the opaque request ID as one path segment", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetch(calls),
    });

    await client.replyPermission("per_/../secret?x=#", "reject");

    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4096/permission/per_%2F..%2Fsecret%3Fx%3D%23/reply",
    );
  });

  it("requires a literal true acknowledgement", async () => {
    for (const body of [false, null, {}, "true", 1]) {
      const client = new OpencodeClient({
        baseUrl: "http://127.0.0.1:4096",
        fetchFn: fakeFetchBody(body),
      });

      await expect(client.replyPermission("per_9", "reject")).rejects.toThrow(
        /invalid acknowledgement/,
      );
    }
  });

  it("does not expose a valid but non-true acknowledgement body", async () => {
    const sentinel = "SENTINEL_NON_TRUE_PERMISSION_REPLY_MUST_NOT_ESCAPE";
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: (async () =>
        new Response(JSON.stringify(sentinel), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const error = await client
      .replyPermission("per_9", "reject")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpencodeError);
    expect(String(error)).toContain("invalid acknowledgement");
    expect(String(error)).not.toContain(sentinel);
  });

  it("sanitizes malformed acknowledgement JSON from a real Response body", async () => {
    const sentinel = "SENTINEL_PERMISSION_REPLY_BODY_MUST_NOT_ESCAPE";
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: (async () =>
        new Response(sentinel, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const error = await client
      .replyPermission("per_9", "always")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpencodeError);
    expect(error).toMatchObject({ status: 200 });
    expect(String(error)).toContain("POST /permission/{requestID}/reply");
    expect(String(error)).toContain("200");
    expect(String(error)).not.toContain(sentinel);
  });

  it("throws a body-free endpoint error on a non-ok response", async () => {
    const sentinel = "SENTINEL_PERMISSION_ERROR_BODY_MUST_NOT_ESCAPE";
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: (async () => new Response(sentinel, { status: 503 })) as typeof fetch,
    });

    const error = await client
      .replyPermission("per_9", "reject")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpencodeError);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).toContain("POST /permission/{requestID}/reply");
    expect(String(error)).toContain("503");
    expect(String(error)).not.toContain(sentinel);
  });
});

/** A fetch double returning a JSON body (for GET endpoints that the client parses). */
function fakeFetchBody(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      text: async () => "",
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("OpencodeClient.getSessionPermission (read existing rules so mirroring can preserve them)", () => {
  it("GETs /session/{id} and returns its permission rules", async () => {
    const rules = [{ permission: "bash", pattern: "*", action: "deny" }];
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetchBody({ id: "ses_9", permission: rules }),
    });
    expect(await c.getSessionPermission("ses_9")).toEqual(rules);
  });

  it("returns [] when the permission field is absent (a fresh session)", async () => {
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetchBody({ id: "ses_9" }),
    });
    expect(await c.getSessionPermission("ses_9")).toEqual([]);
  });

  it("rejects a partially malformed policy instead of silently re-PATCHing only the valid subset", async () => {
    const good = { permission: "edit", pattern: "*", action: "allow" };
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetchBody({
        id: "ses_9",
        permission: [good, { permission: "x" }, { action: "nope" }, null, "str"],
      }),
    });
    await expect(c.getSessionPermission("ses_9")).rejects.toThrow(
      /getSession: invalid permission policy/,
    );
  });

  it("throws OpencodeError on a non-ok response", async () => {
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetchBody(null, false, 404),
    });
    await expect(c.getSessionPermission("ses_9")).rejects.toThrow(/getSession failed: 404/);
  });
});

describe("OpencodeClient fail-closed native-session identity", () => {
  it("treats a discovery HTTP error as an error, never an empty list", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetchBody(null, false, 503),
    });
    await expect(client.listSessions()).rejects.toThrow(/listSessions failed: 503/);
  });

  it("accepts only a complete list of unique canonical ses_* IDs", async () => {
    const valid = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetchBody([{ id: "ses_A1" }, { id: "ses_b2" }]),
    });
    await expect(valid.listSessions()).resolves.toEqual([{ id: "ses_A1" }, { id: "ses_b2" }]);

    for (const body of [
      {},
      [null],
      [{ title: "missing" }],
      [{ id: "not_native" }],
      [{ id: "ses_same" }, { id: "ses_same" }],
    ]) {
      const client = new OpencodeClient({
        baseUrl: "http://127.0.0.1:4096",
        fetchFn: fakeFetchBody(body),
      });
      await expect(client.listSessions()).rejects.toThrow(/listSessions:/);
    }
  });

  it("rejects a create response without one canonical native ID", async () => {
    for (const body of [null, [], {}, { id: "session_1" }, { id: "ses_" }, { id: "ses_bad-id" }]) {
      const client = new OpencodeClient({
        baseUrl: "http://127.0.0.1:4096",
        fetchFn: fakeFetchBody(body),
      });
      await expect(client.createSession()).rejects.toThrow(
        /createSession: invalid native session id/,
      );
    }
  });

  it("makes exactly one create attempt when the response is lost", async () => {
    let calls = 0;
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: (async () => {
        calls += 1;
        throw new TypeError("native create response lost");
      }) as typeof fetch,
    });

    await expect(client.createSession()).rejects.toThrow(/response lost/);
    expect(calls).toBe(1);
  });

  it("confirms an exact GET and rejects identity or policy ambiguity", async () => {
    const rules = [{ permission: "*", pattern: "*", action: "ask" }];
    const valid = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetchBody({ id: "ses_exact", permission: rules }),
    });
    await expect(valid.getSession("ses_exact")).resolves.toEqual({
      id: "ses_exact",
      permission: rules,
    });

    for (const body of [
      [],
      {},
      { id: "ses_other" },
      { id: "ses_exact", permission: {} },
      { id: "ses_exact", permission: [{ permission: "*", pattern: "*" }] },
    ]) {
      const client = new OpencodeClient({
        baseUrl: "http://127.0.0.1:4096",
        fetchFn: fakeFetchBody(body),
      });
      await expect(client.getSession("ses_exact")).rejects.toThrow(/getSession:/);
    }
  });

  it("rejects a non-canonical requested ID before issuing the exact GET", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: fakeFetch(calls),
    });

    await expect(client.getSession("ses_bad-id")).rejects.toThrow(
      /getSession: invalid requested native session id/,
    );
    expect(calls).toEqual([]);
  });
});

describe("isPermissionRule (runtime guard)", () => {
  it("accepts a well-formed rule and rejects malformed shapes", () => {
    expect(isPermissionRule({ permission: "*", pattern: "*", action: "ask" })).toBe(true);
    expect(isPermissionRule({ permission: "bash", pattern: "rm *", action: "deny" })).toBe(true);
    expect(isPermissionRule({ permission: "x", pattern: "y", action: "maybe" })).toBe(false); // bad action
    expect(isPermissionRule({ permission: "x", action: "ask" })).toBe(false); // missing pattern
    expect(isPermissionRule(null)).toBe(false);
    expect(isPermissionRule("str")).toBe(false);
  });
});

/** A fetch double whose response body STREAMS the given SSE blocks (each already `\n\n`-terminated),
 *  then EOFs — exercising the real reader/decoder/frame-split path of events(). */
function streamingFetch(blocks: string[]): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of blocks) controller.enqueue(enc.encode(b));
        controller.close();
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("OpencodeClient.events (server-wide stream → per-session filter)", () => {
  const frame = (o: object) => `data: ${JSON.stringify(o)}\n\n`;

  it("yields own-session + server.* events; DROPS other-session AND session-less non-server.* events", async () => {
    // The server-wide GET /event carries every session's frames plus session-less ones. A bridged
    // single-session driver must see ONLY its own session's events + global server.* (connected/
    // heartbeat). A session-less `session.error` must NOT pass — it would fan out to EVERY driver on
    // this shared stream (codex review). Prove all four cases in one stream.
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: streamingFetch([
        frame({ type: "server.connected", properties: {} }), // session-less server.* → KEEP
        frame({ type: "session.error", properties: { error: { name: "X" } } }), // session-less non-server.* → DROP
        frame({ type: "message.updated", properties: { sessionID: "ses_1", info: {} } }), // ours → KEEP
        frame({ type: "message.updated", properties: { sessionID: "ses_OTHER", info: {} } }), // other → DROP
      ]),
    });
    const got: string[] = [];
    for await (const ev of c.events("ses_1", new AbortController().signal)) {
      got.push(`${ev.type}${ev.properties?.sessionID ? `:${ev.properties.sessionID}` : ""}`);
    }
    expect(got).toEqual(["server.connected", "message.updated:ses_1"]);
  });

  it("keeps own-session events whose id is ONLY nested (part.sessionID / info.sessionID), drops others", async () => {
    // Session-scoped sub-shapes carry the session id ONLY nested — not at properties.sessionID. The
    // filter must derive it from properties.part.sessionID / properties.info.sessionID, else it would
    // drop the driver's OWN assistant/tool content (codex review). Prove both nested own-session shapes
    // pass and a nested OTHER-session shape is dropped.
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: streamingFetch([
        frame({ type: "message.part.updated", properties: { part: { sessionID: "ses_1" } } }), // ours (nested in part) → KEEP
        frame({ type: "message.updated", properties: { info: { sessionID: "ses_1" } } }), // ours (nested in info) → KEEP
        frame({ type: "message.part.updated", properties: { part: { sessionID: "ses_OTHER" } } }), // other (nested) → DROP
      ]),
    });
    const got: string[] = [];
    for await (const ev of c.events("ses_1", new AbortController().signal)) got.push(ev.type);
    expect(got).toEqual(["message.part.updated", "message.updated"]);
  });

  it("a PREDICATE subscription receives session.created for a NOT-yet-followed session (discovery), but still gates other events", async () => {
    // The sub-agent follow path (#102): the driver passes a predicate over its live follow-set. A child
    // session's `session.created` carries the CHILD's own id at properties.sessionID — which the driver
    // does NOT yet follow (it learns to follow FROM this very event). Gating it by the follow-set would be
    // circular, so the client delivers session.created to a predicate consumer regardless; every OTHER
    // event stays gated. Prove: child session.created passes, child message.updated drops, main passes.
    const followed = new Set<string>(["ses_main"]);
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: streamingFetch([
        frame({
          type: "session.created",
          properties: {
            sessionID: "ses_child",
            info: { id: "ses_child", parentID: "ses_main", agent: "explore" },
          },
        }), // not followed → KEEP (discovery)
        frame({ type: "message.updated", properties: { sessionID: "ses_child", info: {} } }), // not followed → DROP
        frame({ type: "message.updated", properties: { sessionID: "ses_main", info: {} } }), // followed → KEEP
      ]),
    });
    const got: string[] = [];
    for await (const ev of c.events(
      (id) => id !== undefined && followed.has(id),
      new AbortController().signal,
    )) {
      got.push(`${ev.type}:${ev.properties?.sessionID}`);
    }
    expect(got).toEqual(["session.created:ses_child", "message.updated:ses_main"]);
  });

  it("a STRING (single-session) subscription stays strictly scoped — no foreign session.created leaks in", async () => {
    // The discovery exception is scoped to PREDICATE consumers; a fixed single-session subscription never
    // wants foreign sessions, so a session.created for another session must NOT leak to it.
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: streamingFetch([
        frame({
          type: "session.created",
          properties: { sessionID: "ses_OTHER", info: { id: "ses_OTHER" } },
        }), // foreign → DROP
        frame({ type: "message.updated", properties: { sessionID: "ses_1", info: {} } }), // ours → KEEP
      ]),
    });
    const got: string[] = [];
    for await (const ev of c.events("ses_1", new AbortController().signal)) got.push(ev.type);
    expect(got).toEqual(["message.updated"]);
  });

  it("fails closed when top-level and nested session coordinates conflict", async () => {
    const c = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetchFn: streamingFetch([
        frame({
          type: "message.part.updated",
          properties: {
            sessionID: "ses_1",
            part: {
              id: "prt_1",
              messageID: "msg_1",
              sessionID: "ses_OTHER",
              type: "text",
              text: "x",
            },
          },
        }),
      ]),
    });
    const consume = async (): Promise<void> => {
      for await (const _event of c.events("ses_1", new AbortController().signal)) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow(/conflicting session identities/);
  });

  it("preserves OpenCode 1.17.5's direct removal coordinates", async () => {
    const client = new OpencodeClient({
      fetchFn: streamingFetch([
        frame({
          type: "message.part.removed",
          properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
        }),
        frame({
          type: "message.removed",
          properties: { sessionID: "ses_1", messageID: "msg_1" },
        }),
      ]),
    });
    const got = [];
    for await (const event of client.events("ses_1", new AbortController().signal)) {
      got.push(event);
    }
    expect(got.map(({ type, properties }) => ({ type, properties }))).toEqual([
      {
        type: "message.part.removed",
        properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
      },
      {
        type: "message.removed",
        properties: { sessionID: "ses_1", messageID: "msg_1" },
      },
    ]);
  });

  it.each([
    ["malformed JSON", "data: {not-json}\n\n"],
    ["missing properties", 'data: {"type":"server.connected"}\n\n'],
    ["incomplete final frame", 'data: {"type":"server.connected","properties":{}}'],
  ])("fails closed on %s", async (_name, body) => {
    const client = new OpencodeClient({ fetchFn: streamingFetch([body]) });
    const consume = async (): Promise<void> => {
      for await (const _event of client.events("ses_1", new AbortController().signal)) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow(/events stream/);
  });

  it("accepts comment keepalives without treating them as malformed events", async () => {
    const client = new OpencodeClient({
      fetchFn: streamingFetch([
        ": keepalive\n\n",
        frame({ type: "server.connected", properties: {} }),
      ]),
    });
    const got: string[] = [];
    for await (const event of client.events("ses_1", new AbortController().signal)) {
      got.push(event.type);
    }
    expect(got).toEqual(["server.connected"]);
  });

  it("normalizes a CRLF separator split across transport chunks", async () => {
    const json = JSON.stringify({ type: "server.connected", properties: {} });
    const client = new OpencodeClient({
      fetchFn: streamingFetch([`data: ${json}\r`, "\n\r", "\n"]),
    });
    const got: string[] = [];
    for await (const event of client.events("ses_1", new AbortController().signal)) {
      got.push(event.type);
    }
    expect(got).toEqual(["server.connected"]);
  });
});
