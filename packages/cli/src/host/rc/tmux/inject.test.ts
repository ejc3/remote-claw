// Inject tests: injectUserText records exactly [setBuffer, pasteBuffer, sleep, sendKeys Enter] in
// order; runInjectPump drains a real Session's downstream queue (prompt → paste+Enter, interrupt →
// Escape), acks after each, and ignores control_response/initialize. The tmux exec is a spy, the
// settle sleep a no-op — no real tmux, no real timers.

import { describe, expect, it } from "vitest";
import { Session } from "../session.js";
import {
  composerHasText,
  downstreamUserText,
  injectUserText,
  isInterrupt,
  PASTE_SETTLE_MAX_MS,
  PASTE_SETTLE_MS,
  PASTE_SETTLE_PER_CHAR_MS,
  runInjectPump,
  settleMs,
  stripAnsi,
  submitPrompt,
} from "./inject.js";
import { TmuxCtl, type TmuxExec, type TmuxExecResult } from "./tmuxctl.js";

const noSleep = (): Promise<void> => Promise.resolve();

/** A spy exec recording the tmux subcommand of each call (calls[i] = the verb, e.g. "set-buffer"). */
function spyTmux(): { tmux: TmuxCtl; verbs: string[]; calls: string[][] } {
  const verbs: string[] = [];
  const calls: string[][] = [];
  const exec: TmuxExec = (args): Promise<TmuxExecResult> => {
    calls.push([...args]);
    verbs.push(args[0] ?? "");
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { tmux: new TmuxCtl(exec), verbs, calls };
}

describe("downstreamUserText / isInterrupt", () => {
  it("reads the STRING content pushUserInput sets", () => {
    const s = new Session("cse_1", "t", null);
    const ev = s.pushUserInput("hello world");
    expect(downstreamUserText(ev)).toBe("hello world");
  });
  it("detects an interrupt control_request", () => {
    const s = new Session("cse_1", "t", null);
    expect(isInterrupt(s.pushControlRequest("interrupt"))).toBe(true);
    expect(isInterrupt(s.pushControlRequest("set_model", { model: "opus" }))).toBe(false);
    expect(isInterrupt(s.pushUserInput("x"))).toBe(false);
  });
});

describe("injectUserText", () => {
  it("runs setBuffer → pasteBuffer → settle → send Enter, in order", async () => {
    const order: string[] = [];
    const exec: TmuxExec = (args) => {
      order.push(args[0] ?? "");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const sleep = (): Promise<void> => {
      order.push("sleep");
      return Promise.resolve();
    };
    await injectUserText(new TmuxCtl(exec), "rc-cse_x", "hi", "rcin-cse_x", sleep);
    // After Enter, submitPrompt settles again then reads the pane back to confirm the submit. The spy
    // returns an empty pane (no "❯" composer line) → composerHasText is false → submitted, no resend.
    expect(order).toEqual([
      "set-buffer",
      "paste-buffer",
      "sleep",
      "send-keys",
      "sleep",
      "capture-pane",
    ]);
  });
});

describe("runInjectPump", () => {
  it("injects a user prompt (paste+Enter), acks it, and stops on abort", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, verbs } = spyTmux();
    const ac = new AbortController();
    const ev = s.pushUserInput("drive this");
    const pump = runInjectPump({
      session: s,
      tmux,
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
    });
    // Give the pump a few microtasks to drain the queued prompt, then abort.
    await waitFor(() => verbs.includes("send-keys"));
    ac.abort();
    s.wake();
    await pump;
    expect(verbs).toEqual(["set-buffer", "paste-buffer", "send-keys", "capture-pane"]);
    // After ack, a reclaimed stream must NOT replay the prompt.
    expect(await replayedEventIds(s, ev.eventId)).toBe(false);
  });

  it("calls onInjected with the prompt text after a successful submit (not for a blank prompt)", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux } = spyTmux();
    const ac = new AbortController();
    const recorded: string[] = [];
    s.pushUserInput("   \n "); // blank → no-op → must NOT be recorded
    s.pushUserInput("real prompt"); // recorded ONLY after its Enter lands
    const pump = runInjectPump({
      session: s,
      tmux,
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
      onInjected: (t) => recorded.push(t),
    });
    await waitFor(() => recorded.length > 0);
    ac.abort();
    s.wake();
    await pump;
    expect(recorded).toEqual(["real prompt"]); // the blank prompt was never recorded
  });

  it("treats a whitespace-only prompt as a no-op (acked, never pasted)", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, verbs } = spyTmux();
    const ac = new AbortController();
    const ev = s.pushUserInput("   \n  "); // spaces + a stray newline — non-empty but blank
    const pump = runInjectPump({
      session: s,
      tmux,
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
    });
    // Let the pump consume + ack the blank event (nothing should be typed).
    await new Promise((r) => setTimeout(r, 60));
    ac.abort();
    s.wake();
    await pump;
    expect(verbs).toEqual([]); // no set-buffer / paste-buffer / send-keys — the box is untouched
    expect(await replayedEventIds(s, ev.eventId)).toBe(false); // acked, so not replayed
  });

  it("maps interrupt → Escape and acks it", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, calls } = spyTmux();
    const ac = new AbortController();
    s.pushControlRequest("interrupt");
    const pump = runInjectPump({
      session: s,
      tmux,
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
    });
    await waitFor(() => calls.some((c) => c[0] === "send-keys" && c.includes("Escape")));
    ac.abort();
    s.wake();
    await pump;
    expect(calls.some((c) => c[0] === "send-keys" && c.includes("Escape"))).toBe(true);
  });

  it("acks (but does not type) initialize and control_response", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, verbs } = spyTmux();
    const ac = new AbortController();
    const init = s.pushInitialize();
    s.pushControlResponse("req-1", "allow");
    // also queue a real prompt so we can wait deterministically for the drain to reach it.
    s.pushUserInput("after");
    const pump = runInjectPump({
      session: s,
      tmux,
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
    });
    await waitFor(() => verbs.includes("send-keys"));
    ac.abort();
    s.wake();
    await pump;
    // initialize / control_response produced NO tmux verbs; only the prompt did.
    expect(verbs).toEqual(["set-buffer", "paste-buffer", "send-keys", "capture-pane"]);
    // initialize was acked (review #5) → not replayed.
    expect(init).not.toBeNull();
    if (init) expect(await replayedEventIds(s, init.eventId)).toBe(false);
  });

  it("retries the PASTE phase as a unit and acks once it lands (codex #4)", async () => {
    const s = new Session("cse_1", "t", null);
    // set-buffer fails the FIRST time, then succeeds — a transient tmux hiccup BEFORE any paste.
    const verbs: string[] = [];
    let failedOnce = false;
    const exec: TmuxExec = (args) => {
      verbs.push(args[0] ?? "");
      if (args[0] === "set-buffer" && !failedOnce) {
        failedOnce = true;
        return Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ac = new AbortController();
    const ev = s.pushUserInput("will recover");
    const errors: Array<{ attempt: number; phase: string }> = [];
    const pump = runInjectPump({
      session: s,
      tmux: new TmuxCtl(exec),
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
      onError: (_event, _error, info) => {
        if (info) errors.push(info);
      },
    });
    await waitFor(() => verbs.includes("send-keys")); // submit happened → fully landed
    ac.abort();
    s.wake();
    await pump;
    // One transient PASTE failure; the retry re-ran the paste unit (set-buffer x2), paste-buffer once
    // (attempt 1 threw at set-buffer, before paste). Submit happened once.
    expect(errors).toEqual([{ attempt: 1, phase: "paste" }]);
    expect(verbs.filter((v) => v === "set-buffer").length).toBe(2);
    expect(verbs.filter((v) => v === "paste-buffer").length).toBe(1);
    expect(await replayedEventIds(s, ev.eventId)).toBe(false); // landed → acked
  });

  it("retries ONLY Enter after a post-paste failure — never re-pastes (codex #4 / wf #1)", async () => {
    const s = new Session("cse_1", "t", null);
    // The paste SUCCEEDS; the first Enter fails transiently, then succeeds. The text must NOT be pasted
    // a second time (that would submit the prompt DOUBLED) — only Enter retries.
    const verbs: string[] = [];
    let enterFailed = false;
    const exec: TmuxExec = (args) => {
      verbs.push(args[0] ?? "");
      if (args[0] === "send-keys" && !enterFailed) {
        enterFailed = true;
        return Promise.resolve({ code: 1, stdout: "", stderr: "busy" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ac = new AbortController();
    const ev = s.pushUserInput("exactly once");
    const errors: Array<{ attempt: number; phase: string }> = [];
    const pump = runInjectPump({
      session: s,
      tmux: new TmuxCtl(exec),
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
      onError: (_event, _error, info) => {
        if (info) errors.push(info);
      },
    });
    await waitFor(() => verbs.filter((v) => v === "send-keys").length >= 2); // Enter retried
    ac.abort();
    s.wake();
    await pump;
    // CRITICAL: the prompt was pasted EXACTLY ONCE despite the Enter retry (no double-paste).
    expect(verbs.filter((v) => v === "set-buffer").length).toBe(1);
    expect(verbs.filter((v) => v === "paste-buffer").length).toBe(1);
    expect(verbs.filter((v) => v === "send-keys").length).toBe(2);
    expect(errors).toEqual([{ attempt: 1, phase: "submit" }]);
    expect(await replayedEventIds(s, ev.eventId)).toBe(false); // landed → acked
  });

  it("retries the paste until abort with NO silent give-up (prompt not dropped)", async () => {
    const s = new Session("cse_1", "t", null);
    // set-buffer ALWAYS fails; after 3 failures the test aborts (mimicking a teardown / pane death).
    const verbs: string[] = [];
    const ac = new AbortController();
    let fails = 0;
    const exec: TmuxExec = (args) => {
      verbs.push(args[0] ?? "");
      if (args[0] === "set-buffer") {
        fails++;
        if (fails >= 3) ac.abort(); // the pane-watch would abort a genuinely dead pane
        return Promise.resolve({ code: 1, stdout: "", stderr: "always fails" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ev = s.pushUserInput("doomed");
    const errors: Array<{ attempt: number; phase: string }> = [];
    await runInjectPump({
      session: s,
      tmux: new TmuxCtl(exec),
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
      onError: (_event, _error, info) => {
        if (info) errors.push(info);
      },
    });
    // It kept retrying (no max-attempts give-up) until abort; every failure was the paste phase.
    expect(errors.length).toBe(3);
    expect(errors.every((e) => e.phase === "paste")).toBe(true);
    expect(errors.map((e) => e.attempt)).toEqual([1, 2, 3]);
    // Never landed → not acked → a re-claimed stream WOULD replay it (not silently dropped).
    expect(await replayedEventIds(s, ev.eventId)).toBe(true);
  });
});

/** Spin the event loop until `pred` is true (or a deadline). */
async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  if (!pred()) throw new Error("timed out waiting for inject");
}

/** Re-claim the worker stream and check whether `eventId` is re-delivered (i.e. NOT acked). Wakes the
 *  gate so the first empty batch yields a heartbeat immediately (never parking on the 10s gate), and
 *  breaks the moment the event is seen or the first heartbeat (drained) arrives. */
async function replayedEventIds(s: Session, eventId: string): Promise<boolean> {
  const gen = s.claimWorkerStream();
  let replayed = false;
  const deadline = Date.now() + 250;
  const ticker = setInterval(() => s.wake(), 10); // nudge the gate so an empty batch yields null fast
  try {
    for await (const ev of s.followDownstream(gen, () => Date.now() > deadline)) {
      if (ev === null) break; // heartbeat → the pending batch is drained, none left
      if (ev.eventId === eventId) {
        replayed = true;
        break;
      }
    }
  } finally {
    clearInterval(ticker);
  }
  return replayed;
}

describe("settleMs / stripAnsi / composerHasText (issue: long-prompt submit-Enter race)", () => {
  it("settleMs scales the paste settle with length and caps it", () => {
    expect(settleMs("hi")).toBe(PASTE_SETTLE_MS + Math.ceil(2 * PASTE_SETTLE_PER_CHAR_MS));
    expect(settleMs("")).toBe(PASTE_SETTLE_MS);
    expect(settleMs("x".repeat(100_000))).toBe(PASTE_SETTLE_MAX_MS);
  });

  it("stripAnsi removes CSI and OSC escape sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b]0;title\x07body")).toBe("body");
  });

  it("composerHasText: true while the prompt sits after the composer marker, false once submitted", () => {
    // Unsubmitted: the prompt is on the "❯ " composer line.
    expect(composerHasText("❯ run the thing now please", "run the thing now please")).toBe(true);
    // Submitted: the prompt moved into a bubble ABOVE; the LAST "❯" (composer) is now empty.
    expect(
      composerHasText("run the thing now please\n──────\n❯ ", "run the thing now please"),
    ).toBe(false);
    // No composer marker captured → treat as submitted (don't resend blindly).
    expect(composerHasText("just some tool output", "run the thing")).toBe(false);
    // Blank prompt → never "in the composer".
    expect(composerHasText("❯ ", "   ")).toBe(false);
  });

  it("composerHasText sees through ANSI styling and collapsed wrapping whitespace", () => {
    const pane = "\x1b[2m❯\x1b[0m \x1b[1mlong  prompt   wraps\x1b[0m";
    expect(composerHasText(pane, "long prompt wraps")).toBe(true);
  });
});

describe("submitPrompt capture-verified resubmit (issue: a swallowed Enter is silently lost)", () => {
  it("resends Enter when the first was swallowed (composer still shows the prompt), then stops once it clears", async () => {
    const text = "a long pasted prompt that did not submit on the first Enter";
    let enters = 0;
    const exec: TmuxExec = (args) => {
      const verb = args[0] ?? "";
      if (verb === "send-keys" && args.includes("Enter")) enters++;
      if (verb === "capture-pane") {
        // The first Enter was swallowed (paste still settling) → composer still holds the prompt; after
        // the resend it clears.
        const stdout = enters >= 2 ? "the prompt\n────\n❯ " : `❯ ${text}`;
        return Promise.resolve({ code: 0, stdout, stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await submitPrompt(new TmuxCtl(exec), "rc-x", text, noSleep);
    expect(enters).toBe(2); // initial Enter + exactly one resend, then confirmed clear
  });

  it("does NOT resend when the first Enter already submitted (composer clear) — no double-submit", async () => {
    let enters = 0;
    const exec: TmuxExec = (args) => {
      const verb = args[0] ?? "";
      if (verb === "send-keys" && args.includes("Enter")) enters++;
      if (verb === "capture-pane") return Promise.resolve({ code: 0, stdout: "❯ ", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await submitPrompt(new TmuxCtl(exec), "rc-x", "hi", noSleep);
    expect(enters).toBe(1); // only the initial Enter; the composer was already clear
  });

  it("gives up after the bounded attempts if the composer never clears (falls through to the pump)", async () => {
    const text = "stuck prompt";
    let enters = 0;
    const exec: TmuxExec = (args) => {
      const verb = args[0] ?? "";
      if (verb === "send-keys" && args.includes("Enter")) enters++;
      if (verb === "capture-pane")
        return Promise.resolve({ code: 0, stdout: `❯ ${text}`, stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await submitPrompt(new TmuxCtl(exec), "rc-x", text, noSleep);
    // 1 initial Enter + one resend per verify attempt (bounded), never more.
    expect(enters).toBe(1 + 6);
  });
});
