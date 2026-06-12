// Unit tests for the RC session event bus — a faithful port of phase0/tests/test_unit.py's TestCore +
// TestClientEvent, plus async-generator-specific coverage (heartbeat ticks, supersede, close).

import { describe, expect, it } from "vitest";
import { assistantText, type RcEvent, RelayCore, Session } from "./session.js";

/** Drain a follower generator until `n` non-null events arrive (or it ends), returning those events. */
async function takeEvents(gen: AsyncGenerator<RcEvent | null>, n: number): Promise<RcEvent[]> {
  const out: RcEvent[] = [];
  for await (const ev of gen) {
    if (ev !== null) {
      out.push(ev);
      if (out.length >= n) break;
    }
  }
  return out;
}

/** Drain a follower to exhaustion (it must already be closed/superseded, else this never returns). */
async function drain(gen: AsyncGenerator<RcEvent | null>): Promise<RcEvent[]> {
  const out: RcEvent[] = [];
  for await (const ev of gen) if (ev !== null) out.push(ev);
  return out;
}

describe("RelayCore", () => {
  it("creates a cse_-prefixed session and gets it back", () => {
    const c = new RelayCore();
    const s = c.create({ title: "t" });
    expect(s.id.startsWith("cse_")).toBe(true);
    expect(c.get(s.id)).toBe(s);
    expect(c.get("nope")).toBeUndefined();
  });

  it("mints a globally-unique session id per launch — no cross-launch collision (K1)", () => {
    // Two RelayCores model two process launches. The old counter-based id reset to 0 each launch, so
    // the FIRST session of every launch was `cse_12654435761` — under one identity that is the SAME
    // broker channel (`sess:<id>:<sessionId>`), corrupting a durable session's frames. Ids must differ.
    const a = new RelayCore().create({ title: "t" }).id;
    const b = new RelayCore().create({ title: "t" }).id;
    expect(a).not.toBe(b);
    // Shape: cse_ + a 32-hex crypto.randomUUID body (dashes stripped) — valid channel-token charset.
    expect(a).toMatch(/^cse_[0-9a-f]{32}$/);
    expect(b).toMatch(/^cse_[0-9a-f]{32}$/);
  });

  it("accepts an injected deterministic session-id minter (test determinism)", () => {
    let n = 0;
    const c = new RelayCore({ newSessionId: () => `fixed${++n}` });
    expect(c.create({ title: "t" }).id).toBe("cse_fixed1");
    expect(c.create({ title: "t" }).id).toBe("cse_fixed2");
  });
});

describe("Session producers", () => {
  it("pushUserInput builds a client `user` event", () => {
    const s = new Session("cse_x", "t", {});
    const ev = s.pushUserInput("hello");
    expect(ev.eventType).toBe("user");
    expect((ev.payload.message as { content: string }).content).toBe("hello");
    expect(ev.source).toBe("client");
  });

  it("pushInitialize is idempotent (once per session)", () => {
    const s = new Session("cse_x", "t", {});
    expect(s.pushInitialize()).not.toBeNull();
    expect(s.pushInitialize()).toBeNull();
  });

  it("initialize occupies downstream sequence 1 even if a user push races after", async () => {
    const s = new Session("cse_x", "t", {});
    s.pushInitialize();
    s.pushUserInput("hi");
    const gen = s.claimWorkerStream();
    const out = await takeEvents(
      s.followDownstream(gen, () => false),
      2,
    );
    expect(out[0]?.sequenceNum).toBe(1);
    expect((out[0]?.payload.request as { subtype: string }).subtype).toBe("initialize");
    expect(out[1]?.eventType).toBe("user");
  });

  it("pushUpstream records a worker event recoverable via snapshot", () => {
    const s = new Session("cse_x", "t", {});
    s.pushUpstream({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const snap = s.snapshotUpstream();
    expect(snap).toHaveLength(1);
    expect(assistantText(snap[0]?.payload ?? {})).toBe("hi");
  });

  it("pushControlResponse answers a permission request (allow)", () => {
    const s = new Session("cse_x", "t", {});
    const ev = s.pushControlResponse("r1", "allow");
    expect(ev.eventType).toBe("control_response");
    const resp = ev.payload.response as { request_id: string; response: { behavior: string } };
    expect(resp.request_id).toBe("r1");
    expect(resp.response.behavior).toBe("allow");
  });

  it("pushControlResponse builds the AskUserQuestion answer shape (toolUseID + updatedInput.answers)", () => {
    // The exact shape real claude expects, verified live via --rc-trace (#42).
    const s = new Session("cse_x", "t", {});
    const ev = s.pushControlResponse("req-1", "allow", {
      toolUseId: "toolu_abc",
      answers: { "Which name?": "Orion" },
    });
    const resp = ev.payload.response as {
      request_id: string;
      response: { behavior: string; toolUseID: string; updatedInput: { answers: unknown } };
    };
    expect(resp.request_id).toBe("req-1");
    expect(resp.response.behavior).toBe("allow");
    expect(resp.response.toolUseID).toBe("toolu_abc");
    expect(resp.response.updatedInput.answers).toEqual({ "Which name?": "Orion" });
  });

  it("pushControlResponse omits toolUseID/updatedInput for a plain allow/deny", () => {
    const s = new Session("cse_x", "t", {});
    const resp = s.pushControlResponse("r2", "deny").payload.response as {
      response: Record<string, unknown>;
    };
    expect(resp.response).toEqual({ behavior: "deny" }); // no toolUseID, no updatedInput
  });

  it("pushControlRequest builds a server→worker control_request with subtype + params (§3.7)", () => {
    const s = new Session("cse_x", "t", {});
    const ev = s.pushControlRequest("set_model", { model: "claude-opus-4-8" });
    expect(ev.eventType).toBe("control_request");
    const req = ev.payload.request as { subtype: string; model: string };
    expect(req.subtype).toBe("set_model");
    expect(req.model).toBe("claude-opus-4-8");
    expect(typeof ev.payload.request_id).toBe("string");
    // A param-less verb still carries just the subtype.
    expect((s.pushControlRequest("interrupt").payload.request as { subtype: string }).subtype).toBe(
      "interrupt",
    );
  });
});

describe("Session followers", () => {
  it("a worker follower skips already-acked downstream events", async () => {
    const s = new Session("cse_x", "t", {});
    const e1 = s.pushUserInput("a");
    s.ack(e1.eventId); // already delivered before this stream
    s.pushUserInput("b");
    const gen = s.claimWorkerStream();
    const out = await takeEvents(
      s.followDownstream(gen, () => false),
      1,
    );
    expect(out.map((e) => (e.payload.message as { content: string }).content)).toEqual(["b"]);
  });

  it("a newer worker stream supersedes an older follower (no duplicate delivery)", async () => {
    const s = new Session("cse_x", "t", {});
    const g1 = s.claimWorkerStream();
    s.claimWorkerStream(); // supersedes g1
    expect(await drain(s.followDownstream(g1, () => false))).toEqual([]);
  });

  it("close stops both downstream and upstream followers", async () => {
    const s = new Session("cse_x", "t", {});
    const g = s.claimWorkerStream();
    s.close();
    expect(await drain(s.followDownstream(g, () => false))).toEqual([]);
    expect(await drain(s.followUpstream(() => false))).toEqual([]);
  });

  it("an upstream follower delivers events live to a client", async () => {
    const s = new Session("cse_x", "t", {});
    const gen = s.followUpstream(() => false);
    s.pushUpstream({ type: "assistant", message: { content: [{ type: "text", text: "yo" }] } });
    s.pushUpstream({ type: "result", result: "done" });
    const out = await takeEvents(gen, 2);
    expect(out.map((e) => e.eventType)).toEqual(["assistant", "result"]);
  });
});
