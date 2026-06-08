import { describe, expect, it } from "vitest";
import { runWrapper } from "./run.js";

function recordingSpawn(exitCode = 0) {
  const calls: { bin: string; args: string[] }[] = [];
  const fn = async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return exitCode;
  };
  return { fn, calls };
}

describe("runWrapper (functional)", () => {
  it("forwards claude args to the resolved binary and returns its exit code", async () => {
    const { fn, calls } = recordingSpawn(0);
    const code = await runWrapper(["chat", "--model", "opus"], {
      claudeBin: "claude",
      spawnFn: fn,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ bin: "claude", args: ["chat", "--model", "opus"] }]);
  });

  it("propagates a non-zero claude exit code", async () => {
    const { fn } = recordingSpawn(7);
    expect(await runWrapper(["x"], { spawnFn: fn })).toBe(7);
  });

  it("forwards everything after -- verbatim", async () => {
    const { fn, calls } = recordingSpawn();
    await runWrapper(["a", "--", "--rc-identity", "-x"], { spawnFn: fn });
    expect(calls[0]?.args).toEqual(["a", "--", "--rc-identity", "-x"]);
  });

  it("exits 2 on an unknown --rc flag without spawning claude", async () => {
    const { fn, calls } = recordingSpawn();
    const lines: string[] = [];
    const code = await runWrapper(["--rc-bogus"], { spawnFn: fn, stderr: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("")).toMatch(/unknown flag --rc-bogus/);
  });

  it("exits 2 on a recognized-but-unimplemented rc flag without spawning", async () => {
    const { fn, calls } = recordingSpawn();
    // --rc-rotate is still a reserved stub; --rc-identity is implemented (covered in identity tests).
    expect(await runWrapper(["--rc-rotate"], { spawnFn: fn, stderr: () => {} })).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("--help prints the rc help banner and STILL falls through to claude with --help", async () => {
    const { fn, calls } = recordingSpawn(0);
    const out: string[] = [];
    const code = await runWrapper(["--help"], { spawnFn: fn, stdout: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join("")).toContain("remote-claw"); // our --rc-* banner printed first
    expect(out.join("")).toMatch(/--rc-identity/);
    expect(calls).toEqual([{ bin: "claude", args: ["--help"] }]); // claude still gets --help
  });

  it("-h triggers the same help passthrough", async () => {
    const { fn, calls } = recordingSpawn(0);
    const out: string[] = [];
    await runWrapper(["chat", "-h"], { spawnFn: fn, stdout: (l) => out.push(l) });
    expect(out.join("")).toMatch(/--rc-identity/);
    expect(calls[0]?.args).toEqual(["chat", "-h"]);
  });

  it("does NOT print the banner for -h/--help after the `--` escape (stays opaque)", async () => {
    const { fn, calls } = recordingSpawn(0);
    const out: string[] = [];
    await runWrapper(["chat", "--", "-h", "--help"], { spawnFn: fn, stdout: (l) => out.push(l) });
    expect(out.join("")).toBe(""); // escape contract: post-`--` tokens are claude's, verbatim
    expect(calls[0]?.args).toEqual(["chat", "--", "-h", "--help"]);
  });

  it("resolves the claude binary from RC_CLAUDE_BIN when not overridden", async () => {
    const { fn, calls } = recordingSpawn();
    const prev = process.env.RC_CLAUDE_BIN;
    process.env.RC_CLAUDE_BIN = "/opt/claude";
    try {
      await runWrapper(["go"], { spawnFn: fn });
    } finally {
      if (prev === undefined) delete process.env.RC_CLAUDE_BIN;
      else process.env.RC_CLAUDE_BIN = prev;
    }
    expect(calls[0]?.bin).toBe("/opt/claude");
  });

  it("treats an empty RC_CLAUDE_BIN as unset (falls back to claude)", async () => {
    const { fn, calls } = recordingSpawn();
    const prev = process.env.RC_CLAUDE_BIN;
    process.env.RC_CLAUDE_BIN = "";
    try {
      await runWrapper(["go"], { spawnFn: fn });
    } finally {
      if (prev === undefined) delete process.env.RC_CLAUDE_BIN;
      else process.env.RC_CLAUDE_BIN = prev;
    }
    expect(calls[0]?.bin).toBe("claude");
  });
});
