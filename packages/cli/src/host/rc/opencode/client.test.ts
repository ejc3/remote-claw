// Unit tests for OpencodeClient endpoint shapes via an injectable fetch (no real server). Focused on
// summarize() — the /compact native equivalent added for the documented slash-command routing.

import { describe, expect, it } from "vitest";
import { isPermissionRule, OpencodeClient, OpencodeError } from "./client.js";

interface Captured {
  url: string;
  method: string | undefined;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
}

/** A fetch double recording each call and returning a Response-like with the given ok/status. */
function fakeFetch(captured: Captured[], ok = true, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
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
        json: async () => (isCreate || isExactGet ? { id: "ses_new" } : []),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://oc.test", fetchFn });
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
    const client = new OpencodeClient({ baseUrl: "http://oc.test", fetchFn });
    const ac = new AbortController();
    const pending = client.listSessions(ac.signal);

    ac.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("OpencodeClient.summarize (/compact native equivalent)", () => {
  it("POSTs /session/{id}/summarize with { providerID, modelID, auto:false }", async () => {
    const calls: Captured[] = [];
    const c = new OpencodeClient({ baseUrl: "http://oc.test", fetchFn: fakeFetch(calls) });
    await c.summarize("ses_1", {
      providerID: "amazon-bedrock",
      modelID: "global.anthropic.claude-sonnet-4-6",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://oc.test/session/ses_1/summarize");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      providerID: "amazon-bedrock",
      modelID: "global.anthropic.claude-sonnet-4-6",
      auto: false,
    });
  });

  it("throws OpencodeError on a non-ok response", async () => {
    const c = new OpencodeClient({ baseUrl: "http://oc.test", fetchFn: fakeFetch([], false, 500) });
    await expect(c.summarize("ses_1", { providerID: "p", modelID: "m" })).rejects.toThrow(
      /summarize failed: 500/,
    );
  });
});

describe("OpencodeClient.setSessionPermission (flip a session to ask mode)", () => {
  it("PATCHes /session/{id} with { permission: rules }", async () => {
    const calls: Captured[] = [];
    const c = new OpencodeClient({ baseUrl: "http://oc.test", fetchFn: fakeFetch(calls) });
    await c.setSessionPermission("ses_9", [{ permission: "*", pattern: "*", action: "ask" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://oc.test/session/ses_9");
    expect(calls[0]?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });
  });

  it("throws OpencodeError on a non-ok response", async () => {
    const c = new OpencodeClient({ baseUrl: "http://oc.test", fetchFn: fakeFetch([], false, 404) });
    await expect(
      c.setSessionPermission("ses_9", [{ permission: "*", pattern: "*", action: "ask" }]),
    ).rejects.toThrow(/setSessionPermission failed: 404/);
  });
});

describe("OpencodeClient server-controlled error bodies", () => {
  it("does not copy native response text into exceptions that callers may trace", async () => {
    const secret = "Bearer should-never-reach-a-log";
    const client = new OpencodeClient({
      baseUrl: "http://oc.test",
      fetchFn: (async () =>
        ({
          ok: false,
          status: 500,
          text: async () => secret,
        }) as unknown as Response) as unknown as typeof fetch,
    });

    const errors = await Promise.all([
      client
        .promptAsync("ses_1", { text: "hello", model: { providerID: "p", modelID: "m" } })
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
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
      fetchFn: fakeFetch(calls),
    });

    await client.replyPermission("per_9", "once", ac.signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://oc.test/permission/per_9/reply");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ reply: "once" });
    expect(calls[0]?.signal).toBe(ac.signal);
  });

  it("encodes the opaque request ID as one path segment", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://oc.test",
      fetchFn: fakeFetch(calls),
    });

    await client.replyPermission("per_/../secret?x=#", "reject");

    expect(calls[0]?.url).toBe("http://oc.test/permission/per_%2F..%2Fsecret%3Fx%3D%23/reply");
  });

  it("requires a literal true acknowledgement", async () => {
    for (const body of [false, null, {}, "true", 1]) {
      const client = new OpencodeClient({
        baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
      fetchFn: fakeFetchBody({ id: "ses_9", permission: rules }),
    });
    expect(await c.getSessionPermission("ses_9")).toEqual(rules);
  });

  it("returns [] when the permission field is absent (a fresh session)", async () => {
    const c = new OpencodeClient({
      baseUrl: "http://oc.test",
      fetchFn: fakeFetchBody({ id: "ses_9" }),
    });
    expect(await c.getSessionPermission("ses_9")).toEqual([]);
  });

  it("rejects a partially malformed policy instead of silently re-PATCHing only the valid subset", async () => {
    const good = { permission: "edit", pattern: "*", action: "allow" };
    const c = new OpencodeClient({
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
      fetchFn: fakeFetchBody(null, false, 404),
    });
    await expect(c.getSessionPermission("ses_9")).rejects.toThrow(/getSession failed: 404/);
  });
});

describe("OpencodeClient fail-closed native-session identity", () => {
  it("treats a discovery HTTP error as an error, never an empty list", async () => {
    const client = new OpencodeClient({
      baseUrl: "http://oc.test",
      fetchFn: fakeFetchBody(null, false, 503),
    });
    await expect(client.listSessions()).rejects.toThrow(/listSessions failed: 503/);
  });

  it("accepts only a complete list of unique canonical ses_* IDs", async () => {
    const valid = new OpencodeClient({
      baseUrl: "http://oc.test",
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
        baseUrl: "http://oc.test",
        fetchFn: fakeFetchBody(body),
      });
      await expect(client.listSessions()).rejects.toThrow(/listSessions:/);
    }
  });

  it("rejects a create response without one canonical native ID", async () => {
    for (const body of [null, [], {}, { id: "session_1" }, { id: "ses_" }, { id: "ses_bad-id" }]) {
      const client = new OpencodeClient({
        baseUrl: "http://oc.test",
        fetchFn: fakeFetchBody(body),
      });
      await expect(client.createSession()).rejects.toThrow(
        /createSession: invalid native session id/,
      );
    }
  });

  it("confirms an exact GET and rejects identity or policy ambiguity", async () => {
    const rules = [{ permission: "*", pattern: "*", action: "ask" }];
    const valid = new OpencodeClient({
      baseUrl: "http://oc.test",
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
        baseUrl: "http://oc.test",
        fetchFn: fakeFetchBody(body),
      });
      await expect(client.getSession("ses_exact")).rejects.toThrow(/getSession:/);
    }
  });

  it("rejects a non-canonical requested ID before issuing the exact GET", async () => {
    const calls: Captured[] = [];
    const client = new OpencodeClient({
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
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
      baseUrl: "http://oc.test",
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

  it("derivation precedence: the TOP-LEVEL sessionID is authoritative over a conflicting nested one", async () => {
    // The derivation is sessionID ?? part.sessionID ?? info.sessionID — top-level wins. A (malformed)
    // event with OUR id at top level but a different id nested is KEPT for us; a foreign top-level id is
    // DROPPED even if a nested id matches us. Tests the real events() filter via a streamed frame.
    const c = new OpencodeClient({
      baseUrl: "http://oc.test",
      fetchFn: streamingFetch([
        frame({ type: "a", properties: { sessionID: "ses_1", part: { sessionID: "ses_OTHER" } } }), // top=ours → KEEP
        frame({ type: "b", properties: { sessionID: "ses_OTHER", info: { sessionID: "ses_1" } } }), // top=foreign → DROP
      ]),
    });
    const got: string[] = [];
    for await (const ev of c.events("ses_1", new AbortController().signal)) got.push(ev.type);
    expect(got).toEqual(["a"]); // only the top-level-ours event survives
  });
});
