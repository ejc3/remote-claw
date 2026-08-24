import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DriverContext } from "./host/rc/driver.js";
import { misappliedDriverFlagWarnings, runWrapper } from "./run.js";

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
    const code = await runWrapper(["--help"], {
      spawnFn: fn,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("remote-claw"); // our --rc-* banner printed first
    expect(out.join("")).toMatch(/--rc-identity/);
    expect(calls).toEqual([{ bin: "claude", args: ["--help"] }]); // claude still gets --help
  });

  it("runs the local identity action without spawning Claude", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-identity-"));
    const secret = join(dir, "secret");
    try {
      const code = await runWrapper(["--rc-identity", "--rc-json", "--rc-file", secret], {
        stdout: () => {},
        stderr: () => {},
      });
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!haveOpenssl())("runs live trace mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-trace-"));
    const secret = join(dir, "secret");
    try {
      const code = await runWrapper(["--rc-trace", "--rc-file", secret, "chat"], {
        spawnRcEnv: async () => 0,
      });
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("fails the stable MITM path before identity or launch when compatibility is unproved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-unsupported-"));
    const secret = join(dir, "secret");
    const lines: string[] = [];
    let spawned = 0;
    try {
      const code = await runWrapper(
        ["chat", "--rc-file", secret, "--rc-app", "http://broker.example"],
        {
          claudeBin: "/private/claude",
          claudeCompatibilityCheck: async (bin) => {
            expect(bin).toBe("/private/claude");
            throw new Error("raw probe detail must not escape");
          },
          spawnRcEnv: async () => {
            spawned++;
            return 0;
          },
          stderr: (line) => lines.push(line),
        },
      );

      expect(code).toBe(1);
      expect(existsSync(secret)).toBe(false);
      expect(spawned).toBe(0);
      expect(lines.join("")).toContain("stable --rc-app requires Claude 2.1.237 (Claude Code)");
      expect(lines.join("")).not.toContain("/private/claude");
      expect(lines.join("")).not.toContain("raw probe detail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!haveOpenssl())(
    "--rc-app launches claude behind the MITM (RC enabled), auto-creating the identity",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rc-run-"));
      const secret = join(dir, "secret");
      let seenEnv: NodeJS.ProcessEnv | null = null;
      let seenArgs: readonly string[] | null = null;
      const compatibilityBins: string[] = [];
      try {
        const code = await runWrapper(
          ["chat", "--model", "opus", "--rc-file", secret, "--rc-app", "http://broker.example"],
          {
            claudeCompatibilityCheck: async (bin) => {
              compatibilityBins.push(bin);
            },
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
        expect(compatibilityBins).toEqual(["claude"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("dispatches opencode with the shared driver context without touching the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-opencode-"));
    const secret = join(dir, "secret");
    const fetchSpy = vi.fn(() => Promise.reject(new Error("unexpected network call")));
    vi.stubGlobal("fetch", fetchSpy);
    let seenContext: DriverContext | undefined;
    let seenSignal: AbortSignal | undefined;
    try {
      const code = await runWrapper(
        [
          "chat",
          "--model",
          "host-arg",
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-backend",
          "sqlite",
          "--rc-driver",
          "opencode",
          "--rc-oc-url",
          "http://127.0.0.1:44096",
          "--rc-oc-model",
          "provider/model",
          "--rc-oc-session",
          "ses_test",
          "--rc-oc-skip-permissions",
        ],
        {
          runOpencodeDriver: async (ctx, signal) => {
            seenContext = ctx;
            seenSignal = signal;
            return 23;
          },
        },
      );

      expect(code).toBe(23);
      expect(existsSync(secret)).toBe(true);
      expect(seenSignal?.aborted).toBe(false);
      expect(seenContext).toMatchObject({
        brokerUrl: "https://broker.example",
        backend: "sqlite",
        harnessArgs: ["chat", "--model", "host-arg"],
        title: "remote-claw",
        cwd: process.cwd(),
        extra: {
          baseUrl: "http://127.0.0.1:44096",
          model: { providerID: "provider", modelID: "model" },
          sessionId: "ses_test",
          mirrorPermissions: false,
        },
      });
      expect(seenContext?.harnessBin).toBeUndefined();
      expect(seenContext?.identity.identityId).toBeInstanceOf(Uint8Array);
      expect(seenContext?.identity.identityId).toHaveLength(16);
      expect(typeof seenContext?.newClient).toBe("function");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches tmux with its harness settings without touching the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-tmux-"));
    const secret = join(dir, "secret");
    const fetchSpy = vi.fn(() => Promise.reject(new Error("unexpected network call")));
    vi.stubGlobal("fetch", fetchSpy);
    let seenContext: DriverContext | undefined;
    let seenSignal: AbortSignal | undefined;
    let seenDeps: { injectSessionHook?: boolean; mirrorPermissions?: boolean } | undefined;
    try {
      const code = await runWrapper(
        [
          "chat",
          "--verbose",
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-backend",
          "memory",
          "--rc-driver",
          "tmux",
          "--rc-no-session-hook",
          "--rc-tmux-skip-permissions",
        ],
        {
          claudeBin: "/opt/claude",
          runTmuxDriver: async (ctx, signal, deps) => {
            seenContext = ctx;
            seenSignal = signal;
            seenDeps = deps;
            return 17;
          },
        },
      );

      expect(code).toBe(17);
      expect(existsSync(secret)).toBe(true);
      expect(seenSignal?.aborted).toBe(false);
      expect(seenContext).toMatchObject({
        brokerUrl: "https://broker.example",
        backend: "memory",
        harnessArgs: ["chat", "--verbose"],
        harnessBin: "/opt/claude",
        title: "remote-claw",
        cwd: process.cwd(),
      });
      expect(seenContext?.extra).toBeUndefined();
      expect(seenContext?.identity.identityId).toBeInstanceOf(Uint8Array);
      expect(seenContext?.identity.identityId).toHaveLength(16);
      expect(typeof seenContext?.newClient).toBe("function");
      expect(seenDeps).toEqual({ injectSessionHook: false, mirrorPermissions: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it.skipIf(!haveOpenssl())(
    "warns that --rc-session-hook is a no-op for a non-tmux driver (here: mitm)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rc-run-hookwarn-"));
      const secret = join(dir, "secret");
      const lines: string[] = [];
      try {
        const code = await runWrapper(
          ["chat", "--rc-file", secret, "--rc-app", "http://broker.example", "--rc-session-hook"],
          {
            claudeCompatibilityCheck: async () => {},
            spawnRcEnv: async () => 0,
            stderr: (l) => lines.push(l),
          },
        );
        expect(code).toBe(0); // the flag is a harmless no-op here — we warn, we do NOT fail
        // The warning names ONLY the flag actually passed (precise), not the whole tmux group.
        expect(lines.join("")).toMatch(
          /--rc-session-hook only applies to --rc-driver=tmux; ignored for mitm/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!haveOpenssl())(
    "warns that --rc-oc-skip-permissions is a no-op for a non-opencode driver (here: mitm)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rc-run-ocwarn-"));
      const secret = join(dir, "secret");
      const lines: string[] = [];
      try {
        const code = await runWrapper(
          [
            "chat",
            "--rc-file",
            secret,
            "--rc-app",
            "http://broker.example",
            "--rc-oc-skip-permissions",
          ],
          {
            claudeCompatibilityCheck: async () => {},
            spawnRcEnv: async () => 0,
            stderr: (l) => lines.push(l),
          },
        );
        expect(code).toBe(0); // a harmless no-op on mitm — we warn, we do NOT fail
        expect(lines.join("")).toMatch(
          /--rc-oc-skip-permissions only applies to --rc-driver=opencode; ignored for mitm/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("an UNKNOWN driver with --rc-oc-skip-permissions gets ONLY the unknown-driver error (no double warn)", async () => {
    const { fn, calls } = recordingSpawn();
    const lines: string[] = [];
    // Allowlist-gated warn: the oc-skip-permissions nag must NOT fire for an unknown driver — that path
    // already errors on its own. Otherwise the user sees two messages for one mistake.
    const code = await runWrapper(
      ["--rc-app", "http://b", "--rc-driver", "bogus", "--rc-oc-skip-permissions"],
      { spawnFn: fn, stderr: (l) => lines.push(l) },
    );
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("")).toMatch(/unknown --rc-driver=bogus/);
    expect(lines.join("")).not.toMatch(/--rc-oc-skip-permissions only applies/); // no second message
  });
});

describe("misappliedDriverFlagWarnings — cross-mode flag hygiene", () => {
  it("inference flags are valid on mitm (no warning)", () => {
    expect(
      misappliedDriverFlagWarnings("mitm", {
        "rc-inference": "bedrock",
        "rc-bedrock-region": "us-east-1",
        "rc-accountless": true,
      }),
    ).toEqual([]);
  });

  it("warns that --rc-inference is a no-op for tmux (the real footgun: NOT zero-anthropic)", () => {
    const w = misappliedDriverFlagWarnings("tmux", { "rc-inference": "bedrock" });
    expect(w).toEqual([
      "remote-claw: --rc-inference only applies to --rc-driver=mitm; ignored for tmux\n",
    ]);
  });

  it("lists MULTIPLE misapplied inference flags with plural 'apply' (opencode)", () => {
    const w = misappliedDriverFlagWarnings("opencode", {
      "rc-bedrock-region": "us-west-2",
      "rc-accountless": true,
    });
    expect(w).toEqual([
      "remote-claw: --rc-bedrock-region / --rc-accountless only apply to --rc-driver=mitm; ignored for opencode\n",
    ]);
  });

  it("warns that opencode value flags are a no-op for mitm", () => {
    expect(misappliedDriverFlagWarnings("mitm", { "rc-oc-url": "http://x:4096" })).toEqual([
      "remote-claw: --rc-oc-url only applies to --rc-driver=opencode; ignored for mitm\n",
    ]);
  });

  it("a tmux run with BOTH opencode + inference flags warns once per group", () => {
    const w = misappliedDriverFlagWarnings("tmux", {
      "rc-oc-model": "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      "rc-inference": "bedrock",
    });
    expect(w).toEqual([
      "remote-claw: --rc-oc-model only applies to --rc-driver=opencode; ignored for tmux\n",
      "remote-claw: --rc-inference only applies to --rc-driver=mitm; ignored for tmux\n",
    ]);
  });

  it("an EMPTY/blank value flag is treated as absent (no warning)", () => {
    expect(misappliedDriverFlagWarnings("mitm", { "rc-oc-url": "   " })).toEqual([]);
  });

  it("correctly-applied flags never warn (opencode with oc flags; tmux with tmux flags)", () => {
    expect(
      misappliedDriverFlagWarnings("opencode", {
        "rc-oc-url": "http://x",
        "rc-oc-session": "ses_1",
      }),
    ).toEqual([]);
    expect(misappliedDriverFlagWarnings("tmux", { "rc-tmux-skip-permissions": true })).toEqual([]);
  });

  it("an UNKNOWN driver gets NO misapplied-flag nag (allowlist-gated; it errors on its own)", () => {
    expect(
      misappliedDriverFlagWarnings("bogus", {
        "rc-inference": "bedrock",
        "rc-oc-url": "http://x",
        "rc-tmux-skip-permissions": true,
      }),
    ).toEqual([]);
  });
});
