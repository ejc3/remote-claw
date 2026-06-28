// Status tests: a manual Timer makes the debounce deterministic (no real setTimeout). Asserts running
// on append, idle after the debounce fires, open-tool suppression of idle, single transition (no churn),
// and that the values map onto the relay's phaseFor (running→thinking).

import { describe, expect, it } from "vitest";
import { phaseFor } from "../relay.js";
import { Session } from "../session.js";
import { StatusTracker, type Timer } from "./status.js";

/** A manual one-shot timer: `fire()` runs the pending callback (the debounce elapsing). */
function manualTimer(): Timer & { fire: () => void; armed: () => boolean } {
  let cb: (() => void) | null = null;
  return {
    set(c) {
      cb = c;
    },
    clear() {
      cb = null;
    },
    fire() {
      const c = cb;
      cb = null;
      c?.();
    },
    armed() {
      return cb !== null;
    },
  };
}

function track(): { s: Session; t: ReturnType<typeof manualTimer>; st: StatusTracker } {
  const s = new Session("cse_1", "t", null);
  const t = manualTimer();
  const st = new StatusTracker({ session: s, timer: t });
  return { s, t, st };
}

describe("StatusTracker", () => {
  it("flips to running on a transcript append + arms the idle debounce", () => {
    const { s, t, st } = track();
    expect(s.workerStatus).toBe("WORKER_STATUS_UNSPECIFIED");
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(s.workerStatus).toBe("running");
    expect(t.armed()).toBe(true);
  });

  it("goes idle when the debounce fires with no open tool_use", () => {
    const { s, t, st } = track();
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    expect(s.workerStatus).toBe("running");
    t.fire(); // ~1s of quiet elapsed
    expect(s.workerStatus).toBe("idle");
  });

  it("suppresses idle while a tool_use is open, then idles once the tool_result lands", () => {
    const { s, t, st } = track();
    // assistant calls a tool (opens toolu_1) — its result hasn't arrived.
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
    });
    t.fire(); // debounce elapses but the tool is still open → stay running
    expect(s.workerStatus).toBe("running");

    // the tool_result closes toolu_1; a following text turn finishes.
    st.onLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    });
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "all set" }] } });
    t.fire();
    expect(s.workerStatus).toBe("idle");
  });

  it("emits one transition per change (re-arming an append doesn't churn status)", () => {
    const { s, st } = track();
    let wakes = 0;
    const realWake = s.wake.bind(s);
    s.wake = () => {
      wakes++;
      realWake();
    };
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } });
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "b" }] } });
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "c" }] } });
    // Three appends but only ONE running transition → one wake.
    expect(wakes).toBe(1);
    expect(s.workerStatus).toBe("running");
  });

  it("clears an orphaned tool_use on a new user prompt, then idles (wf#2)", () => {
    const { s, t, st } = track();
    // assistant opens a tool that is NEVER answered (interrupt / claude moves on).
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: {} }] },
    });
    t.fire(); // tool open → stay running (now re-arms instead of dying)
    expect(s.workerStatus).toBe("running");
    // A new user PROMPT arrives (e.g. the "[Request interrupted]" marker) — no tool_result for toolu_x.
    st.onLine({
      type: "user",
      message: { content: [{ type: "text", text: "[Request interrupted]" }] },
    });
    t.fire();
    expect(s.workerStatus).toBe("idle"); // the orphaned tool was cleared at the turn boundary
  });

  it("does NOT treat a NESTED sub-agent user prompt as a turn boundary (parent's Agent tool stays open)", () => {
    const { s, t, st } = track();
    // The parent opens the Agent/Task spawner tool — it stays open until its tool_result lands.
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_AGENT", name: "Agent", input: {} }] },
    });
    // A NESTED sub-agent user prompt (parent_tool_use_id set) arrives. It must NOT wipe the parent's
    // open Agent tool — otherwise the host would flip to idle mid-turn while the sub-agent runs.
    st.onLine({
      type: "user",
      parent_tool_use_id: "toolu_AGENT",
      message: { content: [{ type: "text", text: "sub-agent: do the thing" }] },
    });
    t.fire();
    expect(s.workerStatus).toBe("running"); // parent Agent tool still open → stays running (not idle)
  });

  it("force-idles after the hard window when a tool_use is orphaned with no new prompt (wf#2)", () => {
    const s = new Session("cse_1", "t", null);
    const t = manualTimer();
    let clock = 1000;
    const st = new StatusTracker({ session: s, timer: t, now: () => clock, hardIdleMs: 5000 });
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_y", name: "Bash", input: {} }] },
    });
    clock = 2000;
    t.fire(); // 1s of silence < 5s hard window → still running (and re-armed)
    expect(s.workerStatus).toBe("running");
    expect(t.armed()).toBe(true); // crucially, it RE-ARMED (the original bug let the timer die here)
    clock = 7000;
    t.fire(); // 6s of silence ≥ 5s hard window → orphan, force idle
    expect(s.workerStatus).toBe("idle");
  });

  it("dispose() clears a pending idle timer", () => {
    const { t, st } = track();
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } });
    expect(t.armed()).toBe(true);
    st.dispose();
    expect(t.armed()).toBe(false);
  });

  it("phaseFor maps the tracker's values: running→thinking, idle→idle", () => {
    expect(phaseFor("running")).toBe("thinking");
    expect(phaseFor("idle")).toBe("idle");
  });

  it("fires onTurnEnd once on a top-level assistant line with a terminal stop_reason (end_turn)", () => {
    const s = new Session("cse_1", "t", null);
    const t = manualTimer();
    let ends = 0;
    const st = new StatusTracker({ session: s, timer: t, onTurnEnd: () => ends++ });
    expect(ends).toBe(0); // nothing on construction
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    });
    expect(ends).toBe(1); // fires immediately on the terminal line, not on the debounce
    // A second turn fires it again (one per real turn end).
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "again" }], stop_reason: "stop_sequence" },
    });
    expect(ends).toBe(2);
  });

  it("does NOT fire onTurnEnd during the inter-tool inference gap (the code-review/codex bug)", () => {
    const s = new Session("cse_1", "t", null);
    const t = manualTimer();
    let ends = 0;
    const st = new StatusTracker({ session: s, timer: t, onTurnEnd: () => ends++ });
    // assistant calls a tool — stop_reason is "tool_use" (NOT terminal): the turn isn't over.
    st.onLine({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
        stop_reason: "tool_use",
      },
    });
    // tool_result closes the tool; #openTools empties and the debounce re-arms.
    st.onLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    });
    // Inference takes >1s before claude's next step → the idle debounce fires. The OLD heuristic emitted a
    // spurious separator here; the stop_reason-driven design must NOT (no terminal line seen yet).
    t.fire();
    expect(s.workerStatus).toBe("idle");
    expect(ends).toBe(0);
    // claude finishes for real → exactly one separator for the whole turn.
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "the answer" }], stop_reason: "end_turn" },
    });
    expect(ends).toBe(1);
  });

  it("does NOT leak across a fast follow-up prompt (no separator before the next answer)", () => {
    const s = new Session("cse_1", "t", null);
    const t = manualTimer();
    let ends = 0;
    const st = new StatusTracker({ session: s, timer: t, onTurnEnd: () => ends++ });
    // Turn A ends.
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "A done" }], stop_reason: "end_turn" },
    });
    expect(ends).toBe(1);
    // User sends turn B before the idle debounce fires; claude thinks >1s before B's first line.
    st.onLine({ type: "user", message: { content: [{ type: "text", text: "now do B" }] } });
    t.fire(); // the OLD #producedOutput gate leaked here and emitted a spurious separator
    expect(ends).toBe(1);
    // B answers → exactly one more separator. A/B boundary preserved, no mid-B separator.
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "B done" }], stop_reason: "end_turn" },
    });
    expect(ends).toBe(2);
  });

  it("does NOT fire onTurnEnd for a NESTED sub-agent's terminal line (not the parent's turn end)", () => {
    const s = new Session("cse_1", "t", null);
    const t = manualTimer();
    let ends = 0;
    const st = new StatusTracker({ session: s, timer: t, onTurnEnd: () => ends++ });
    // A sub-agent (parent_tool_use_id set) finishes its own turn — must NOT close the parent's turn.
    st.onLine({
      type: "assistant",
      parent_tool_use_id: "toolu_AGENT",
      message: { content: [{ type: "text", text: "sub done" }], stop_reason: "end_turn" },
    });
    expect(ends).toBe(0);
  });

  it("does NOT fire onTurnEnd for a user prompt or a non-terminal stop_reason", () => {
    const s = new Session("cse_1", "t", null);
    const t = manualTimer();
    let ends = 0;
    const st = new StatusTracker({ session: s, timer: t, onTurnEnd: () => ends++ });
    st.onLine({ type: "user", message: { content: [{ type: "text", text: "hi" }] } });
    // a streaming/partial assistant line with no stop_reason yet
    st.onLine({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } });
    // a pause_turn (server-tool pause claude resumes) is NOT terminal
    st.onLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "paused" }], stop_reason: "pause_turn" },
    });
    expect(ends).toBe(0);
  });
});
