// Unit tests for OpencodeClient endpoint shapes via an injectable fetch (no real server). Focused on
// summarize() — the /compact native equivalent added for the documented slash-command routing.

import { describe, expect, it } from "vitest";
import { OpencodeClient } from "./client.js";

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
});
