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
