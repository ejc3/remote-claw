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
