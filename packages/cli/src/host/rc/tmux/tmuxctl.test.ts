// tmuxctl tests: every command's exact argv/process-option shape via an injected TmuxExec spy (no real
// tmux — same discipline as gitinfo.test.ts's canned output). They also prove private-socket routing,
// three-valued probes/kill results, and that required-command errors cannot disclose raw child data.

import { describe, expect, it } from "vitest";
import {
  TmuxCtl,
  TmuxError,
  type TmuxExec,
  type TmuxExecOptions,
  type TmuxExecResult,
} from "./tmuxctl.js";

interface ExecCall {
  args: string[];
  options: TmuxExecOptions | undefined;
}

/** A spy exec that records argv and replies from a queue (default: success). */
function spyExec(replies: TmuxExecResult[] = []): { exec: TmuxExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: TmuxExec = (args, options) => {
    calls.push({ args: [...args], options });
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
    expect(calls).toEqual([{ args: ["-V"], options: undefined }]);
  });

  it("newSession keeps env off argv and passes it as the exact process environment", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).newSession("rc-cse_x", "'claude' '--foo'", {
      cwd: "/work",
      width: 200,
      height: 50,
      env: { A: "1", SECRET_SENTINEL: "value that must not reach argv" },
    });
    expect(calls[0]?.args).toEqual([
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
      "'claude' '--foo'",
    ]);
    expect(calls[0]?.options).toEqual({
      env: { A: "1", SECRET_SENTINEL: "value that must not reach argv" },
    });
    expect(JSON.stringify(calls[0]?.args)).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify(calls[0]?.args)).not.toContain("value that must not reach argv");
  });

  it("setBuffer streams prompt text over stdin and keeps the exact sentinel out of raw argv", async () => {
    const { exec, calls } = spyExec();
    const sentinel = "--ARGV_SECRET_SENTINEL `echo hi` $TOKEN\nsecond line";
    await new TmuxCtl(exec).setBuffer("rcin", sentinel);
    expect(calls[0]?.args).toEqual(["load-buffer", "-b", "rcin", "-"]);
    expect(calls[0]?.options).toEqual({ stdin: sentinel });
    expect(JSON.stringify(calls[0]?.args)).not.toContain("ARGV_SECRET_SENTINEL");
    expect(JSON.stringify(calls[0]?.args)).not.toContain("second line");
  });

  it("pasteBuffer is bracketed (-p) and deletes (-d) the buffer into the target", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).pasteBuffer("rc-cse_x", "rcin");
    expect(calls[0]?.args).toEqual(["paste-buffer", "-d", "-p", "-b", "rcin", "-t", "rc-cse_x"]);
  });

  it("sendKeys forwards each named key as its own argv element", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).sendKeys("rc-cse_x", "Enter");
    await new TmuxCtl(exec).sendKeys("rc-cse_x", "Escape");
    expect(calls[0]?.args).toEqual(["send-keys", "-t", "rc-cse_x", "Enter"]);
    expect(calls[1]?.args).toEqual(["send-keys", "-t", "rc-cse_x", "Escape"]);
  });

  it("runShell runs the exact fixed helper command synchronously", async () => {
    const { exec, calls } = spyExec();
    await new TmuxCtl(exec).runShell("/private/helper reconcile");
    expect(calls).toEqual([
      { args: ["run-shell", "/private/helper reconcile"], options: undefined },
    ]);
  });

  it("prefixes every verb with the configured private socket", async () => {
    const { exec, calls } = spyExec([{ code: 0, stdout: "tmux 3.4\n", stderr: "" }]);
    const tmux = new TmuxCtl(exec, "/run/user/1000/remote-claw/tmux.sock");

    await tmux.version();
    await tmux.newSession("rc-cse_x", "claude");
    await tmux.sessionState("rc-cse_x");
    await tmux.setBuffer("rcin", "hello");
    await tmux.pasteBuffer("rc-cse_x", "rcin");
    await tmux.sendKeys("rc-cse_x", "Enter");
    await tmux.runShell("/private/helper reconcile");
    await tmux.killSession("rc-cse_x");

    expect(calls.map(({ args }) => args.slice(0, 2))).toEqual(
      Array.from({ length: 8 }, () => ["-S", "/run/user/1000/remote-claw/tmux.sock"]),
    );
    expect(calls.map(({ args }) => args[2])).toEqual([
      "-V",
      "new-session",
      "has-session",
      "load-buffer",
      "paste-buffer",
      "send-keys",
      "run-shell",
      "kill-session",
    ]);
  });

  it("rejects an empty private socket path", () => {
    expect(() => new TmuxCtl(spyExec().exec, "")).toThrow("tmux socket path must not be empty");
  });
});

describe("session probe / kill outcome", () => {
  it.each([
    [{ code: 0, stderr: "" }, "present"],
    [{ code: 1, stderr: "can't find session: rc-cse_x" }, "gone"],
    [{ code: 1, stderr: "no server running on /private/tmux.sock" }, "gone"],
    [
      {
        code: 1,
        stderr: "error connecting to /private/tmux.sock (No such file or directory)",
      },
      "gone",
    ],
    [{ code: 1, stderr: "error connecting to /private/tmux.sock (Permission denied)" }, "unknown"],
    [{ code: 1, stderr: "server exited unexpectedly" }, "unknown"],
    [{ code: 1, stderr: "" }, "unknown"],
    [{ code: 127, stderr: "can't find session: rc-cse_x" }, "unknown"],
    [{ code: null, stderr: "can't find session: rc-cse_x" }, "unknown"],
  ] as const)("maps has-session $code / $stderr to $expected", async (reply, expected) => {
    const tmux = new TmuxCtl(
      spyExec([{ code: reply.code, stdout: "", stderr: reply.stderr }]).exec,
    );
    await expect(tmux.sessionState("rc-cse_x")).resolves.toBe(expected);
  });

  it("retains the boolean compatibility helpers without treating probe failure as gone", async () => {
    const present = spyExec([{ code: 0, stdout: "", stderr: "" }]);
    expect(await new TmuxCtl(present.exec).hasSession("rc-cse_x")).toBe(true);
    expect(present.calls[0]?.args).toEqual(["has-session", "-t", "rc-cse_x"]);

    const absent = spyExec([{ code: 1, stdout: "", stderr: "can't find session" }]);
    expect(await new TmuxCtl(absent.exec).hasSession("rc-gone")).toBe(false);
    expect(
      await new TmuxCtl(
        spyExec([{ code: 1, stdout: "", stderr: "can't find session: x" }]).exec,
      ).sessionGone("x"),
    ).toBe(true);
    // Generic exit 1, spawn failure, and timeout mean "couldn't prove absence", NOT gone.
    expect(
      await new TmuxCtl(
        spyExec([{ code: 1, stdout: "", stderr: "connection refused" }]).exec,
      ).sessionGone("x"),
    ).toBe(false);
    expect(
      await new TmuxCtl(
        spyExec([{ code: 127, stdout: "", stderr: "can't find session: x" }]).exec,
      ).sessionGone("x"),
    ).toBe(false);
    // 0 = present → not gone.
    expect(
      await new TmuxCtl(spyExec([{ code: 0, stdout: "", stderr: "" }]).exec).sessionGone("x"),
    ).toBe(false);
  });

  it.each([
    [{ code: 0, stderr: "" }, "terminated"],
    [{ code: 1, stderr: "can't find session: rc-cse_x" }, "already-gone"],
    [{ code: 1, stderr: "no server running on /private/tmux.sock" }, "already-gone"],
    [
      {
        code: 1,
        stderr: "error connecting to /private/tmux.sock (No such file or directory)",
      },
      "already-gone",
    ],
    [{ code: 1, stderr: "error connecting to /private/tmux.sock (Permission denied)" }, "unknown"],
    [{ code: 1, stderr: "server exited unexpectedly" }, "unknown"],
    [{ code: 1, stderr: "" }, "unknown"],
    [{ code: 127, stderr: "can't find session: rc-cse_x" }, "unknown"],
    [{ code: null, stderr: "can't find session: rc-cse_x" }, "unknown"],
  ] as const)("maps kill-session $code / $stderr to $expected", async (reply, expected) => {
    const { exec, calls } = spyExec([{ code: reply.code, stdout: "", stderr: reply.stderr }]);
    await expect(new TmuxCtl(exec).killSession("rc-cse_x")).resolves.toBe(expected);
    expect(calls[0]?.args).toEqual(["kill-session", "-t", "rc-cse_x"]);
  });
});

describe("redacted required-command failure", () => {
  it("exposes only the safe operation name and exit code", async () => {
    const sentinels = [
      "ARGV_SECRET_SENTINEL",
      "ENV_SECRET_SENTINEL",
      "STDOUT_SECRET_SENTINEL",
      "STDERR_SECRET_SENTINEL",
    ];
    const { exec } = spyExec([
      {
        code: 127,
        stdout: sentinels[2] ?? "",
        stderr: sentinels[3] ?? "",
      },
    ]);

    let thrown: unknown;
    try {
      await new TmuxCtl(exec).newSession("rc-cse_x", sentinels[0] ?? "", {
        env: { TOKEN: sentinels[1] ?? "" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TmuxError);
    const error = thrown as TmuxError;
    expect(error.operation).toBe("new-session");
    expect(error.code).toBe(127);
    expect(error.application).toBe("unknown");
    expect(error.message).toBe("tmux new-session failed (code 127)");
    expect("args" in error).toBe(false);
    expect("result" in error).toBe(false);

    const observable = [
      String(error),
      String(error.stack),
      JSON.stringify(error),
      JSON.stringify(Object.values(error)),
    ].join("\n");
    for (const sentinel of sentinels) expect(observable).not.toContain(sentinel);
  });

  it("collapses a rejecting executor to redacted unknown/failure outcomes", async () => {
    const exec: TmuxExec = () => Promise.reject(new Error("REJECTED_EXEC_SECRET"));
    const tmux = new TmuxCtl(exec, "/private/tmux.sock");

    await expect(tmux.sessionState("rc-cse_x")).resolves.toBe("unknown");
    await expect(tmux.killSession("rc-cse_x")).resolves.toBe("unknown");

    let thrown: unknown;
    try {
      await tmux.version();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TmuxError);
    expect(String(thrown)).toBe("TmuxError: tmux version failed (code 127)");
    expect((thrown as TmuxError).application).toBe("unknown");
    expect(String(thrown)).not.toContain("REJECTED_EXEC_SECRET");
  });

  it.each([
    "not-applied",
    "unknown",
  ] as const)("preserves an explicit %s application outcome in TmuxError", async (application) => {
    const { exec } = spyExec([{ code: 1, stdout: "", stderr: "", application }]);

    let thrown: unknown;
    try {
      await new TmuxCtl(exec).sendKeys("rc-cse_x", "Enter");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TmuxError);
    expect((thrown as TmuxError).operation).toBe("send-keys");
    expect((thrown as TmuxError).application).toBe(application);
  });

  it("does not copy a failed load-buffer stdin payload or tmux output into its error", async () => {
    const stdinSentinel = "STDIN_PROMPT_SECRET_SENTINEL";
    const outputSentinel = "TMUX_OUTPUT_SECRET_SENTINEL";
    const { exec, calls } = spyExec([{ code: 1, stdout: outputSentinel, stderr: outputSentinel }]);

    let thrown: unknown;
    try {
      await new TmuxCtl(exec).setBuffer("rcin", stdinSentinel);
    } catch (error) {
      thrown = error;
    }

    expect(calls[0]?.args).toEqual(["load-buffer", "-b", "rcin", "-"]);
    expect(JSON.stringify(calls[0]?.args)).not.toContain(stdinSentinel);
    expect(calls[0]?.options).toEqual({ stdin: stdinSentinel });
    expect(thrown).toBeInstanceOf(TmuxError);
    expect(String(thrown)).toBe("TmuxError: tmux load-buffer failed (code 1)");
    expect(String(thrown)).not.toContain(stdinSentinel);
    expect(String(thrown)).not.toContain(outputSentinel);
    expect(JSON.stringify(thrown)).not.toContain(stdinSentinel);
    expect(JSON.stringify(thrown)).not.toContain(outputSentinel);
  });
});
