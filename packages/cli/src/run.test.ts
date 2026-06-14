import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWrapper } from "./run.js";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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
    // --rc-keep-old is a reserved modifier with no standalone action (it only acts alongside
    // --rc-identity --rc-confirm); --rc-identity/--rc-show-secret are implemented (own tests).
    expect(await runWrapper(["--rc-keep-old"], { spawnFn: fn, stderr: () => {} })).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("--rc-trace rejects an inapplicable modifier (e.g. --rc-json) without spawning", async () => {
    const { fn, calls } = recordingSpawn();
    const lines: string[] = [];
    const code = await runWrapper(["--rc-trace", "--rc-json", "chat"], {
      spawnFn: fn,
      spawnRcEnv: async () => 0,
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("")).toContain("--rc-json");
  });

  it("--rc-trace --help prints the rc help and does NOT stand up a proxy", async () => {
    const { fn, calls } = recordingSpawn();
    const out: string[] = [];
    let traceSpawned = false;
    const code = await runWrapper(["--rc-trace", "--help"], {
      spawnFn: fn,
      spawnRcEnv: async () => {
        traceSpawned = true;
        return 0;
      },
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(traceSpawned).toBe(false);
    expect(calls).toHaveLength(0);
    expect(out.join("")).toContain("--rc-trace");
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

  it("--rc-file alone (no broker) runs plain claude and warns RC is unavailable", async () => {
    const { fn, calls } = recordingSpawn(0);
    const lines: string[] = [];
    const code = await runWrapper(["chat", "--rc-file", "/tmp/x/secret"], {
      spawnFn: fn,
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ bin: "claude", args: ["chat"] }]); // the rc flag is consumed, not leaked
    expect(lines.join("")).toMatch(/needs --rc-app/);
  });

  it.skipIf(!haveOpenssl())(
    "--rc-app launches claude behind the MITM (RC enabled), auto-creating the identity",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rc-run-"));
      const secret = join(dir, "secret");
      let seenEnv: NodeJS.ProcessEnv | null = null;
      let seenArgs: readonly string[] | null = null;
      try {
        const code = await runWrapper(
          ["chat", "--model", "opus", "--rc-file", secret, "--rc-app", "http://broker.example"],
          {
            spawnRcEnv: async (_bin, args, env) => {
              seenEnv = env;
              seenArgs = args;
              return 0;
            },
          },
        );
        expect(code).toBe(0);
        expect(existsSync(secret)).toBe(true); // identity auto-created on first run
        expect(seenArgs).toEqual(["chat", "--model", "opus"]); // rc flags consumed, claude args kept
        const env = seenEnv as unknown as NodeJS.ProcessEnv;
        expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(env.NODE_EXTRA_CA_CERTS).toBe(join(dir, "mitm-certs", "ca.pem"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("exits 2 on an unknown --rc-driver (with the valid list) without spawning claude", async () => {
    const { fn, calls } = recordingSpawn();
    const lines: string[] = [];
    const code = await runWrapper(["--rc-app", "http://b", "--rc-driver", "bogus"], {
      spawnFn: fn,
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("")).toMatch(/unknown --rc-driver=bogus/);
    expect(lines.join("")).toMatch(/mitm \| tmux \| opencode/);
  });

  it("--rc-driver=tmux without --rc-app warns and runs plain claude (no broker)", async () => {
    const { fn, calls } = recordingSpawn(0);
    const lines: string[] = [];
    const code = await runWrapper(["chat", "--rc-driver", "tmux"], {
      spawnFn: fn,
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ bin: "claude", args: ["chat"] }]); // plain spawn, rc flag consumed
    expect(lines.join("")).toMatch(/needs --rc-app/);
  });
});
