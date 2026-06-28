// Unit tests for OpencodeClient endpoint shapes via an injectable fetch (no real server). Focused on
// summarize() — the /compact native equivalent added for the documented slash-command routing.

import { describe, expect, it } from "vitest";
import { isPermissionRule, OpencodeClient } from "./client.js";

interface Captured {
  url: string;
  method: string | undefined;
  body: string | undefined;
}

/** A fetch double recording each call and returning a Response-like with the given ok/status. */
function fakeFetch(captured: Captured[], ok = true, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return {
      ok,
      status,
      text: async () => "",
      json: async () => true,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("OpencodeClient.summarize (/compact native equivalent)", () => {
  it("POSTs /session/{id}/summarize with { providerID, modelID, auto:false }", async () => {
    const calls: Captured[] = [];
    const c = new OpencodeClient({ baseUrl: "http://oc.test", fetchFn: fakeFetch(calls) });
    await c.summarize("ses_1", { providerID: "ollama", modelID: "qwen2.5:0.5b" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://oc.test/session/ses_1/summarize");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      providerID: "ollama",
      modelID: "qwen2.5:0.5b",
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

  it("filters MALFORMED rules out of the server response (never re-PATCH garbage)", async () => {
    const good = { permission: "edit", pattern: "*", action: "allow" };
    const c = new OpencodeClient({
      baseUrl: "http://oc.test",
      fetchFn: fakeFetchBody({
        permission: [good, { permission: "x" }, { action: "nope" }, null, "str"],
      }),
    });
    expect(await c.getSessionPermission("ses_9")).toEqual([good]);
  });

  it("throws OpencodeError on a non-ok response", async () => {
    const c = new OpencodeClient({
      baseUrl: "http://oc.test",
      fetchFn: fakeFetchBody(null, false, 404),
    });
    await expect(c.getSessionPermission("ses_9")).rejects.toThrow(
      /getSessionPermission failed: 404/,
    );
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
