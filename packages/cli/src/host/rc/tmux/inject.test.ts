// Inject tests: injectUserText records exactly [stdin loadBuffer, pasteBuffer, sleep, sendKeys Enter] in
// order; runInjectPump drains a real Session's downstream queue, excludes prompts from active native
// turns and their focused permission/question modal,
// acks unsupported controls without pane input, and ignores control_response/initialize. The tmux exec is a spy, the
// settle sleep a no-op — no real tmux, no real timers.

import { describe, expect, it } from "vitest";
import { Session } from "../session.js";
import {
  downstreamUserText,
  injectUserText,
  PASTE_SETTLE_MAX_MS,
  PASTE_SETTLE_MS,
  PASTE_SETTLE_PER_CHAR_MS,
  runInjectPump,
  settleMs,
} from "./inject.js";
import { TmuxCtl, type TmuxExec, type TmuxExecOptions, type TmuxExecResult } from "./tmuxctl.js";

const noSleep = (): Promise<void> => Promise.resolve();

class TrackingSession extends Session {
  readonly acknowledgements: string[] = [];

  override ack(eventId: string): void {
    this.acknowledgements.push(eventId);
    super.ack(eventId);
  }
}

/** A spy exec recording each tmux subcommand and its process-local options (including stdin). */
function spyTmux(): {
  tmux: TmuxCtl;
  verbs: string[];
  calls: string[][];
  options: Array<TmuxExecOptions | undefined>;
} {
  const verbs: string[] = [];
  const calls: string[][] = [];
  const options: Array<TmuxExecOptions | undefined> = [];
  const exec: TmuxExec = (args, execOptions): Promise<TmuxExecResult> => {
    calls.push([...args]);
    options.push(execOptions);
    verbs.push(args[0] ?? "");
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { tmux: new TmuxCtl(exec), verbs, calls, options };
}

describe("downstreamUserText", () => {
  it("reads the STRING content pushUserInput sets", () => {
    const s = new Session("cse_1", "t", null);
    const ev = s.pushUserInput("hello world");
    expect(downstreamUserText(ev)).toBe("hello world");
  });
});

describe("injectUserText", () => {
  it("runs setBuffer → pasteBuffer → settle → send Enter, in order", async () => {
    const order: string[] = [];
    const inputs: Array<string | undefined> = [];
    const exec: TmuxExec = (args, options) => {
      order.push(args[0] ?? "");
      inputs.push(options?.stdin);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const sleep = (): Promise<void> => {
      order.push("sleep");
      return Promise.resolve();
    };
    await injectUserText(new TmuxCtl(exec), "rc-cse_x", "hi", "rcin-cse_x", sleep);
    // loadAndPaste (stdin load-buffer, paste-buffer) then submitPrompt (settle, send Enter). No read-back:
    // a single Enter after the length-scaled settle — the capture-confirm/resend was removed because its
    // TUI parse had false-"submitted" reads that silently dropped prompts (codex review).
    expect(order).toEqual(["load-buffer", "paste-buffer", "sleep", "send-keys"]);
    expect(inputs).toEqual(["hi", undefined, undefined]);
  });

  it("rejects pane-active controls before loading the tmux buffer", async () => {
    const { tmux, verbs } = spyTmux();
    await expect(injectUserText(tmux, "rc-cse_x", "x\u001b[201~/permissions")).rejects.toThrow(
      /pane-unsafe control/,
    );
    expect(verbs).toEqual([]);
  });
});

describe("runInjectPump", () => {
  it("injects a user prompt (paste+Enter), acks it, and stops on abort", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, verbs, calls, options } = spyTmux();
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
    expect(verbs).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
    expect(calls[0]).toEqual(["load-buffer", "-b", "rcin", "-"]);
    expect(options[0]).toEqual({ stdin: "drive this" });
    expect(JSON.stringify(calls)).not.toContain("drive this");
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
    expect(verbs).toEqual([]); // no load-buffer / paste-buffer / send-keys — the box is untouched
    expect(await replayedEventIds(s, ev.eventId)).toBe(false); // acked, so not replayed
  });

  it("acks every unsupported control without sending pane keys", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, calls } = spyTmux();
    const ac = new AbortController();
    const events = [
      s.pushControlRequest("interrupt"),
      s.pushControlRequest("set_model", { model: "opus" }),
      s.pushControlRequest("set_mode", { mode: "plan" }),
      s.pushControlRequest("end"),
    ];
    s.pushUserInput("after controls");
    const pump = runInjectPump({
      session: s,
      tmux,
      target: "rc-cse_1",
      signal: ac.signal,
      sleep: noSleep,
    });
    await waitFor(() => calls.some((c) => c[0] === "send-keys" && c.includes("Enter")));
    ac.abort();
    s.wake();
    await pump;
    expect(calls.some((c) => c.includes("Escape"))).toBe(false);
    expect(calls.some((c) => c.includes("/model"))).toBe(false);
    for (const event of events) expect(await replayedEventIds(s, event.eventId)).toBe(false);
  });

  it("rejects slash-prefixed text at the pane boundary", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, verbs } = spyTmux();
    const ac = new AbortController();
    const slash = s.pushUserInput(" \n /permissions");
    const after = s.pushUserInput("ordinary text");
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
    expect(verbs).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
    expect(await replayedEventIds(s, slash.eventId)).toBe(false);
    expect(await replayedEventIds(s, after.eventId)).toBe(false);
  });

  it("rejects C0/C1 controls at the pane boundary while preserving TAB, LF, and Unicode", async () => {
    const s = new Session("cse_1", "t", null);
    const { tmux, verbs, options } = spyTmux();
    const ac = new AbortController();
    const escapeControl = s.pushUserInput("break out\u001b[201~/permissions");
    const carriageReturn = s.pushUserInput("submit\rnow");
    const del = s.pushUserInput("delete\u007f");
    const c1 = s.pushUserInput("colour\u009b31m");
    const safe = s.pushUserInput("line one\nline two\t✓");
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
    expect(verbs).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
    expect(options[0]?.stdin).toBe("line one\nline two\t✓");
    for (const event of [escapeControl, carriageReturn, del, c1, safe]) {
      expect(await replayedEventIds(s, event.eventId)).toBe(false);
    }
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
    expect(verbs).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
    // initialize was acked (review #5) → not replayed.
    expect(init).not.toBeNull();
    if (init) expect(await replayedEventIds(s, init.eventId)).toBe(false);
  });

  it("retries the PASTE phase as a unit and acks once it lands (codex #4)", async () => {
    const s = new Session("cse_1", "t", null);
    // load-buffer fails the FIRST time, then succeeds — a transient tmux hiccup BEFORE any paste.
    const verbs: string[] = [];
    let failedOnce = false;
    const exec: TmuxExec = (args) => {
      verbs.push(args[0] ?? "");
      if (args[0] === "load-buffer" && !failedOnce) {
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
    // One transient PASTE failure; the retry re-ran the paste unit (load-buffer x2), paste-buffer once
    // (attempt 1 threw at load-buffer, before paste). Submit happened once.
    expect(errors).toEqual([{ attempt: 1, phase: "paste" }]);
    expect(verbs.filter((v) => v === "load-buffer").length).toBe(2);
    expect(verbs.filter((v) => v === "paste-buffer").length).toBe(1);
    expect(await replayedEventIds(s, ev.eventId)).toBe(false); // landed → acked
  });

  it("retries only an Enter that tmux proves was not applied — never re-pastes", async () => {
    const s = new Session("cse_1", "t", null);
    // The paste succeeds; tmux authoritatively rejects the first Enter before application, then accepts
    // the retry. The text must not be pasted a second time (that would submit the prompt doubled).
    const verbs: string[] = [];
    let enterFailed = false;
    const exec: TmuxExec = (args) => {
      verbs.push(args[0] ?? "");
      if (args[0] === "send-keys" && !enterFailed) {
        enterFailed = true;
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "busy",
          application: "not-applied",
        });
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
    expect(verbs.filter((v) => v === "load-buffer").length).toBe(1);
    expect(verbs.filter((v) => v === "paste-buffer").length).toBe(1);
    expect(verbs.filter((v) => v === "send-keys").length).toBe(2);
    expect(errors).toEqual([{ attempt: 1, phase: "submit" }]);
    expect(await replayedEventIds(s, ev.eventId)).toBe(false); // landed → acked
  });

  it.each([
    "paste",
    "submit",
  ] as const)("fails closed after one unknown %s mutation attempt", async (phase) => {
    const s = new TrackingSession("cse_1", "t", null);
    const event = s.pushUserInput("once only");
    let mutationAttempts = 0;
    const exec: TmuxExec = (args) => {
      const isAmbiguousMutation =
        (phase === "paste" && args[0] === "paste-buffer") ||
        (phase === "submit" && args[0] === "send-keys" && args.includes("Enter"));
      if (isAmbiguousMutation) {
        // Model the dangerous order: the server applies the mutation, then its completion is lost.
        mutationAttempts += 1;
        return Promise.resolve({
          code: 127,
          stdout: "",
          stderr: "",
          application: "unknown",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const errors: Array<{ attempt: number; phase: string }> = [];

    const pump = runInjectPump({
      session: s,
      tmux: new TmuxCtl(exec),
      target: "rc-cse_1",
      signal: new AbortController().signal,
      sleep: noSleep,
      onError: (_event, _error, info) => {
        if (info) errors.push(info);
      },
    });

    await expect(pump).resolves.toBeUndefined();
    expect(mutationAttempts).toBe(1);
    expect(errors).toEqual([{ attempt: 1, phase }]);
    expect(s.acknowledgements).not.toContain(event.eventId);
    expect(s.closed).toBe(true);
    expect(s.closeReason).toBe(`tmux ${phase} application outcome unknown`);
  });

  it("retries the paste until abort with NO silent give-up (prompt not dropped)", async () => {
    const s = new Session("cse_1", "t", null);
    // load-buffer ALWAYS fails; after 3 failures the test aborts (mimicking a teardown / pane death).
    const verbs: string[] = [];
    const ac = new AbortController();
    let fails = 0;
    const exec: TmuxExec = (args) => {
      verbs.push(args[0] ?? "");
      if (args[0] === "load-buffer") {
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

describe("settleMs (long-prompt submit-Enter race)", () => {
  it("scales the paste settle with length and caps it", () => {
    expect(settleMs("hi")).toBe(PASTE_SETTLE_MS + Math.ceil(2 * PASTE_SETTLE_PER_CHAR_MS));
    expect(settleMs("")).toBe(PASTE_SETTLE_MS);
    expect(settleMs("x".repeat(100_000))).toBe(PASTE_SETTLE_MAX_MS);
  });
});
