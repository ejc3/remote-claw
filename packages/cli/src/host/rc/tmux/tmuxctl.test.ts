// tmuxctl tests: every command's exact argv shape via an injected TmuxExec spy (no real tmux — same
// discipline as gitinfo.test.ts's canned output). Asserts argv-safety (`--` before user text),
// hasSession's exit→bool mapping, and that killSession swallows a "no session" exit.

import { describe, expect, it } from "vitest";
import { TmuxCtl, TmuxError, type TmuxExec, type TmuxExecResult } from "./tmuxctl.js";

/** A spy exec that records argv and replies from a queue (default: success). */
function spyExec(replies: TmuxExecResult[] = []): { exec: TmuxExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: TmuxExec = (args) => {
    calls.push([...args]);
    const r = replies.shift() ?? { code: 0, stdout: "", stderr: "" };
    return Promise.resolve(r);
  };
  return { exec, calls };
}

describe("TmuxCtl argv shapes", () => {
  it("version → tmux -V", async () => {
    const { exec, calls } = spyExec([{ code: 0, stdout: "tmux 3.4\n", stderr: "" }]);
    const v = await new TmuxCtl(exec).version();
    expect(v).toBe("tmux 3.4");
    expect(calls).toEqual([["-V"]]);
  });

  it("newSession → detached, with cwd/geometry/env and the command last", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).newSession("rc-cse_x", "'claude' '--foo'", {
      cwd: "/work",
      width: 200,
      height: 50,
      env: { A: "1", B: "two words" },
    });
    expect(calls[0]).toEqual([
      "new-session",
      "-d",
      "-s",
      "rc-cse_x",
      "-c",
      "/work",
      "-x",
      "200",
      "-y",
      "50",
      "-e",
      "A=1",
      "-e",
      "B=two words",
      "'claude' '--foo'",
    ]);
  });

  it("setBuffer ends option parsing with -- so text starting with - is literal", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).setBuffer("rcin", "--not-a-flag `echo hi`");
    expect(calls[0]).toEqual(["set-buffer", "-b", "rcin", "--", "--not-a-flag `echo hi`"]);
  });

  it("pasteBuffer is bracketed (-p) and deletes (-d) the buffer into the target", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).pasteBuffer("rc-cse_x", "rcin");
    expect(calls[0]).toEqual(["paste-buffer", "-d", "-p", "-b", "rcin", "-t", "rc-cse_x"]);
  });

  it("sendKeys forwards each named key as its own argv element", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).sendKeys("rc-cse_x", "Enter");
    await new TmuxCtl(exec).sendKeys("rc-cse_x", "Escape");
    expect(calls[0]).toEqual(["send-keys", "-t", "rc-cse_x", "Enter"]);
    expect(calls[1]).toEqual(["send-keys", "-t", "rc-cse_x", "Escape"]);
  });
});

describe("hasSession / killSession", () => {
  it("hasSession maps exit 0 → true, non-zero → false", async () => {
    const present = spyExec([{ code: 0, stdout: "", stderr: "" }]);
    expect(await new TmuxCtl(present.exec).hasSession("rc-cse_x")).toBe(true);
    expect(present.calls[0]).toEqual(["has-session", "-t", "rc-cse_x"]);

    const absent = spyExec([{ code: 1, stdout: "", stderr: "can't find session" }]);
    expect(await new TmuxCtl(absent.exec).hasSession("rc-gone")).toBe(false);
  });

  it("sessionGone is true ONLY for exit 1 (tmux ran, session missing), NOT 127 (couldn't run)", async () => {
    // exit 1 = tmux ran and reported the session gone → really gone.
    expect(
      await new TmuxCtl(spyExec([{ code: 1, stdout: "", stderr: "no session" }]).exec).sessionGone(
        "x",
      ),
    ).toBe(true);
    // 127 = spawn failure / timeout (realTmuxExec maps these here) → "couldn't probe", NOT gone.
    expect(
      await new TmuxCtl(spyExec([{ code: 127, stdout: "", stderr: "ENOENT" }]).exec).sessionGone(
        "x",
      ),
    ).toBe(false);
    // 0 = present → not gone.
    expect(
      await new TmuxCtl(spyExec([{ code: 0, stdout: "", stderr: "" }]).exec).sessionGone("x"),
    ).toBe(false);
  });

  it("killSession swallows a non-zero 'no session' exit (idempotent teardown)", async () => {
    const { exec, calls } = spyExec([
      { code: 1, stdout: "", stderr: "can't find session: rc-gone" },
    ]);
    await expect(new TmuxCtl(exec).killSession("rc-gone")).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["kill-session", "-t", "rc-gone"]);
  });
});

describe("required-command failure", () => {
  it("throws TmuxError with argv + stderr when a required command exits non-zero", async () => {
    const { exec } = spyExec([{ code: 127, stdout: "", stderr: "tmux: not found" }]);
    await expect(new TmuxCtl(exec).version()).rejects.toBeInstanceOf(TmuxError);
  });
});
