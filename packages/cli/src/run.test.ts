import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STABLE_CLAUDE_REQUIREMENT } from "./host/rc/compatibility.js";
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

const OPENCODE_ENV_KEYS = [
  "RC_DRIVER",
  "OPENCODE_URL",
  "RC_OC_MODEL",
  "RC_OC_SESSION",
  "RC_OC_MIRROR_PERMISSIONS",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  "RC_CODEX_URL",
  "RC_CODEX_THREAD",
  "RC_APP",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
] as const;

function clearOpencodeEnv(): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of OPENCODE_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const key of OPENCODE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe("runWrapper (functional)", () => {
  // OpenCode's non-RC environment variables intentionally remain available to the opt-in live suite,
  // so the package-wide Vitest bootstrap cannot scrub them. Keep this functional unit suite hermetic
  // instead: an ambient OPENCODE_URL/password from a developer shell must not turn an unrelated plain
  // Claude test into an OpenCode attach request. Individual OpenCode cases can still set exactly the
  // values they exercise, and the outer restore preserves the caller's shell after each test.
  let restoreAmbientOpencodeEnv: (() => void) | undefined;
  beforeEach(() => {
    restoreAmbientOpencodeEnv = clearOpencodeEnv();
  });
  afterEach(() => {
    restoreAmbientOpencodeEnv?.();
    restoreAmbientOpencodeEnv = undefined;
  });

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

  it("scrubs host-only secrets from a real plain-passthrough child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-plain-env-"));
    const probeFile = join(dir, "child-env.json");
    const previousSecretFile = process.env.REMOTE_CLAW_SECRET_FILE;
    const previousBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    process.env.REMOTE_CLAW_SECRET_FILE = "/private/remote-claw-secret";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-must-not-reach-plain-child";
    const probe = `require("node:fs").writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({secretFile:process.env.REMOTE_CLAW_SECRET_FILE,bypass:process.env.VERCEL_AUTOMATION_BYPASS_SECRET}))`;
    try {
      expect(await runWrapper(["-e", probe], { claudeBin: process.execPath })).toBe(0);
      expect(JSON.parse(readFileSync(probeFile, "utf8"))).toEqual({});
    } finally {
      if (previousSecretFile === undefined) delete process.env.REMOTE_CLAW_SECRET_FILE;
      else process.env.REMOTE_CLAW_SECRET_FILE = previousSecretFile;
      if (previousBypass === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = previousBypass;
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("rejects a non-origin or remote HTTP --rc-app before identity creation", async () => {
    for (const target of [
      "http://broker.example",
      "https://broker.example/path",
      "https://user@broker.example",
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "rc-run-origin-"));
      const secret = join(dir, "secret");
      const lines: string[] = [];
      let compatibilityChecks = 0;
      try {
        const code = await runWrapper(["--rc-file", secret, "--rc-app", target], {
          claudeCompatibilityCheck: async () => {
            compatibilityChecks += 1;
          },
          spawnRcEnv: async () => 0,
          stderr: (line) => lines.push(line),
        });
        expect(code).toBe(2);
        expect(existsSync(secret)).toBe(false);
        expect(compatibilityChecks).toBe(0);
        expect(lines.join("")).not.toContain(target);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects an ambient deployment bypass without an exact RC_APP pin before identity or network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-bypass-pin-"));
    const secret = join(dir, "secret");
    const lines: string[] = [];
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "never-send";
    process.env.RC_APP = "https://trusted.example";
    try {
      const code = await runWrapper(
        ["--rc-file", secret, "--rc-app", "https://untrusted.invalid"],
        {
          claudeCompatibilityCheck: async () => {
            throw new Error("must not reach compatibility");
          },
          spawnRcEnv: async () => 0,
          stderr: (line) => lines.push(line),
        },
      );
      expect(code).toBe(2);
      expect(existsSync(secret)).toBe(false);
      expect(lines.join("")).toMatch(/does not match the RC_APP origin/);
      expect(lines.join("")).not.toContain("untrusted.invalid");
      expect(lines.join("")).not.toContain("never-send");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a deployment bypass only after the exact RC_APP pin matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-bypass-match-"));
    const secret = join(dir, "secret");
    let seenHeaders = new Headers();
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "scoped-bypass";
    process.env.RC_APP = "https://BROKER.example:443/";
    vi.stubGlobal("fetch", (async (_input: string | URL | Request, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return Response.json({ maxSeq: null, durable: true });
    }) as typeof fetch);
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "opencode",
          "--rc-oc-session",
          "ses_exact",
        ],
        {
          runtime: { platform: "linux", arch: "arm64" },
          runOpencodeDriver: async (ctx) => {
            await ctx.newClient().seqCursor("ses_exact");
            return 0;
          },
        },
      );
      expect(code).toBe(0);
      expect(seenHeaders.get("x-vercel-protection-bypass")).toBe("scoped-bypass");
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it.each([
    ["driver flag", ["--rc-driver", "opencode"], undefined],
    ["URL flag", ["--rc-oc-url", "http://127.0.0.1:4096"], undefined],
    ["model flag", ["--rc-oc-model", "provider/model"], undefined],
    ["session flag", ["--rc-oc-session", "ses_test"], undefined],
    ["permission flag", ["--rc-oc-mirror-permissions"], undefined],
    ["driver env", [], ["RC_DRIVER", "opencode"]],
    ["URL env", [], ["OPENCODE_URL", "http://127.0.0.1:4096"]],
    ["model env", [], ["RC_OC_MODEL", "provider/model"]],
    ["session env", [], ["RC_OC_SESSION", "ses_test"]],
    ["permission env", [], ["RC_OC_MIRROR_PERMISSIONS", "0"]],
    ["username env", [], ["OPENCODE_SERVER_USERNAME", "opencode"]],
    ["empty password env", [], ["OPENCODE_SERVER_PASSWORD", ""]],
  ] as const)("rejects OpenCode intent from %s without a broker instead of spawning plain Claude", async (_name, args, envEntry) => {
    const restoreEnv = clearOpencodeEnv();
    const { fn, calls } = recordingSpawn();
    const rcLaunchSpy = vi.fn(async () => 0);
    const driverSpy = vi.fn(async () => 0);
    const lines: string[] = [];
    try {
      if (envEntry !== undefined) process.env[envEntry[0]] = envEntry[1];
      const code = await runWrapper([...args], {
        spawnFn: fn,
        spawnRcEnv: rcLaunchSpy,
        runOpencodeDriver: driverSpy,
        stderr: (line) => lines.push(line),
      });

      expect(code).toBe(2);
      expect(calls).toEqual([]);
      expect(rcLaunchSpy).not.toHaveBeenCalled();
      expect(driverSpy).not.toHaveBeenCalled();
      expect(lines).toEqual([
        "remote-claw: OpenCode attach configuration requires --rc-app (or RC_APP); refusing to launch plain claude\n",
      ]);
    } finally {
      restoreEnv();
    }
  });

  it.each([
    ["driver flag", ["--rc-driver", "codex"], undefined],
    ["URL flag", ["--rc-codex-url", "ws://127.0.0.1:4500"], undefined],
    ["managed socket URL flag", ["--rc-codex-url", "unix://"], undefined],
    ["thread flag", ["--rc-codex-thread", "0194f8d8-10b4-7abc-8def-0123456789ab"], undefined],
    ["driver env", [], ["RC_DRIVER", "codex"]],
    ["URL env", [], ["RC_CODEX_URL", "ws://127.0.0.1:4500"]],
    ["thread env", [], ["RC_CODEX_THREAD", "0194f8d8-10b4-7abc-8def-0123456789ab"]],
  ] as const)("rejects Codex intent from %s without a broker instead of spawning plain Claude", async (_name, args, envEntry) => {
    const { fn, calls } = recordingSpawn();
    const driverSpy = vi.fn(async () => 0);
    const lines: string[] = [];
    if (envEntry !== undefined) process.env[envEntry[0]] = envEntry[1];

    const code = await runWrapper([...args], {
      spawnFn: fn,
      runCodexDriver: driverSpy,
      stderr: (line) => lines.push(line),
    });

    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(driverSpy).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "remote-claw: Codex attach configuration requires --rc-app (or RC_APP); refusing to launch plain claude\n",
    ]);
  });

  it("--rc-driver=opencode --help prints wrapper help but never spawns Claude or the driver", async () => {
    const restoreEnv = clearOpencodeEnv();
    const { fn, calls } = recordingSpawn();
    const rcLaunchSpy = vi.fn(async () => 0);
    const driverSpy = vi.fn(async () => 0);
    const out: string[] = [];
    try {
      const code = await runWrapper(["--rc-driver", "opencode", "--help"], {
        spawnFn: fn,
        spawnRcEnv: rcLaunchSpy,
        runOpencodeDriver: driverSpy,
        stdout: (line) => out.push(line),
        stderr: () => {},
      });

      expect(code).toBe(2);
      expect(out.join("")).toContain("remote-claw");
      expect(calls).toEqual([]);
      expect(rcLaunchSpy).not.toHaveBeenCalled();
      expect(driverSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("OpenCode plus a broker and --help still cannot fall through to plain Claude", async () => {
    const restoreEnv = clearOpencodeEnv();
    const { fn, calls } = recordingSpawn();
    const rcLaunchSpy = vi.fn(async () => 0);
    const driverSpy = vi.fn(async () => 0);
    const lines: string[] = [];
    try {
      const code = await runWrapper(
        ["--rc-app", "https://broker.example", "--rc-driver", "opencode", "--help"],
        {
          runtime: { platform: "linux", arch: "arm64" },
          spawnFn: fn,
          spawnRcEnv: rcLaunchSpy,
          runOpencodeDriver: driverSpy,
          stdout: () => {},
          stderr: (line) => lines.push(line),
        },
      );

      expect(code).toBe(2);
      expect(lines.join("")).toMatch(/remove forwarded arguments/);
      expect(calls).toEqual([]);
      expect(rcLaunchSpy).not.toHaveBeenCalled();
      expect(driverSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
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
        ["chat", "--rc-file", secret, "--rc-app", "https://broker.example"],
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

  it("rejects an unproved exact Claude version before native identity creation or dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-native-unsupported-"));
    const secret = join(dir, "secret");
    const lines: string[] = [];
    let dispatched = 0;
    try {
      const code = await runWrapper(
        [
          "--remote-control",
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "claude-native",
        ],
        {
          claudeBin: "/private/claude",
          claudeCompatibilityCheck: async (bin) => {
            expect(bin).toBe("/private/claude");
            throw new Error("raw version probe must not escape");
          },
          runClaudeNativeDriver: async () => {
            dispatched++;
            return 0;
          },
          stderr: (line) => lines.push(line),
        },
      );

      expect(code).toBe(1);
      expect(existsSync(secret)).toBe(false);
      expect(dispatched).toBe(0);
      expect(lines.join("")).toContain("Claude 2.1.237 (Claude Code)");
      expect(lines.join("")).not.toContain("/private/claude");
      expect(lines.join("")).not.toContain("raw version probe");
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
          ["chat", "--model", "opus", "--rc-file", secret, "--rc-app", "https://broker.example"],
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
    const restoreEnv = clearOpencodeEnv();
    let seenContext: DriverContext | undefined;
    let seenSignal: AbortSignal | undefined;
    try {
      const code = await runWrapper(
        [
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
          "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
          "--rc-oc-session",
          "ses_test",
          "--rc-oc-mirror-permissions",
        ],
        {
          runtime: { platform: "linux", arch: "arm64" },
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
        harnessArgs: [],
        title: "remote-claw",
        cwd: process.cwd(),
        extra: {
          baseUrl: "http://127.0.0.1:44096",
          model: {
            providerID: "amazon-bedrock",
            modelID: "global.anthropic.claude-sonnet-4-6",
          },
          sessionId: "ses_test",
          username: "opencode",
          mirrorPermissions: true,
        },
      });
      expect(seenContext?.harnessBin).toBeUndefined();
      expect(seenContext?.identity.identityId).toBeInstanceOf(Uint8Array);
      expect(seenContext?.identity.identityId).toHaveLength(16);
      expect(typeof seenContext?.newClient).toBe("function");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches Codex with the shared context and exact caller-owned attachment tuple", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-codex-"));
    const secret = join(dir, "secret");
    const fetchSpy = vi.fn(() => Promise.reject(new Error("unexpected network call")));
    vi.stubGlobal("fetch", fetchSpy);
    let seenContext: DriverContext | undefined;
    let seenSignal: AbortSignal | undefined;
    let seenOptions:
      | {
          url: string;
          threadId: string;
          runtime?: Readonly<{ platform: NodeJS.Platform; arch: string }>;
        }
      | undefined;
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-backend",
          "sqlite",
          "--rc-driver",
          "codex",
          "--rc-codex-url",
          "ws://[::1]:4510",
          "--rc-codex-thread",
          "0194f8d8-10b4-7abc-8def-0123456789ab",
        ],
        {
          runtime: { platform: "linux", arch: "arm64" },
          runCodexDriver: async (ctx, signal, options) => {
            seenContext = ctx;
            seenSignal = signal;
            seenOptions = options;
            return 29;
          },
        },
      );

      expect(code).toBe(29);
      expect(existsSync(secret)).toBe(true);
      expect(seenSignal?.aborted).toBe(false);
      expect(seenContext).toMatchObject({
        brokerUrl: "https://broker.example",
        backend: "sqlite",
        harnessArgs: [],
        title: "remote-claw",
        cwd: process.cwd(),
      });
      expect(seenContext?.harnessBin).toBeUndefined();
      expect(seenContext?.extra).toBeUndefined();
      expect(seenOptions).toEqual({
        url: "ws://[::1]:4510",
        threadId: "0194f8d8-10b4-7abc-8def-0123456789ab",
        runtime: { platform: "linux", arch: "arm64" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches literal unix:// without writing the native thread id or host secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-codex-managed-socket-"));
    const secret = join(dir, "secret");
    const threadId = "0194f8d8-10b4-7abc-8def-0123456789ab";
    const stdout: string[] = [];
    const stderr: string[] = [];
    let seenOptions:
      | {
          url: string;
          threadId: string;
          runtime?: Readonly<{ platform: NodeJS.Platform; arch: string }>;
        }
      | undefined;
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "codex",
          "--rc-codex-url",
          "unix://",
          "--rc-codex-thread",
          threadId,
        ],
        {
          runtime: { platform: "linux", arch: "arm64" },
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          runCodexDriver: async (_ctx, _signal, options) => {
            seenOptions = options;
            return 31;
          },
        },
      );

      expect(code).toBe(31);
      expect(seenOptions).toEqual({
        url: "unix://",
        threadId,
        runtime: { platform: "linux", arch: "arm64" },
      });
      const hostSecret = readFileSync(secret, "utf8").trim();
      expect(hostSecret).not.toBe("");
      const output = stdout.join("") + stderr.join("");
      expect(output).not.toContain(threadId);
      expect(output).not.toContain(hostSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "forwarded arguments",
      extra: ["chat", "--rc-codex-thread", "0194f8d8-10b4-7abc-8def-0123456789ab"],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /remove forwarded arguments/,
    },
    {
      name: "unsupported platform",
      extra: ["--rc-codex-thread", "0194f8d8-10b4-7abc-8def-0123456789ab"],
      runtime: { platform: "linux" as const, arch: "x64" },
      error: /requires the supported Linux arm64 release tuple/,
    },
    {
      name: "missing exact thread",
      extra: [],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /required and must be a canonical Codex UUIDv7/,
    },
    {
      name: "malformed thread",
      extra: ["--rc-codex-thread", "not-a-thread"],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /canonical Codex UUIDv7/,
    },
    {
      name: "non-loopback URL",
      extra: [
        "--rc-codex-thread",
        "0194f8d8-10b4-7abc-8def-0123456789ab",
        "--rc-codex-url",
        "ws://localhost:4500",
      ],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /explicit-port ws origin on 127\.0\.0\.1 or \[::1\]/,
    },
    {
      name: "arbitrary Unix socket URL",
      extra: [
        "--rc-codex-thread",
        "0194f8d8-10b4-7abc-8def-0123456789ab",
        "--rc-codex-url",
        "unix:///tmp/codex-app-server.sock",
      ],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /arbitrary Unix paths are not accepted/,
    },
    {
      name: "arbitrary Unix filesystem path",
      extra: [
        "--rc-codex-thread",
        "0194f8d8-10b4-7abc-8def-0123456789ab",
        "--rc-codex-url",
        "/tmp/codex-app-server.sock",
      ],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /arbitrary Unix paths are not accepted/,
    },
  ])("rejects Codex $name before identity or network", async ({ extra, runtime, error }) => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-codex-invalid-"));
    const secret = join(dir, "secret");
    const fetchSpy = vi.fn(() => Promise.reject(new Error("unexpected network call")));
    const driverSpy = vi.fn(async () => 0);
    vi.stubGlobal("fetch", fetchSpy);
    const lines: string[] = [];
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "codex",
          ...extra,
        ],
        {
          runtime,
          stderr: (line) => lines.push(line),
          runCodexDriver: driverSpy,
        },
      );
      expect(code).toBe(2);
      expect(lines.join("")).toMatch(error);
      expect(existsSync(secret)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(driverSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves OpenCode Basic-auth configuration and enables the env opt-in exactly at 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-opencode-auth-"));
    const secret = join(dir, "secret");
    const restoreEnv = clearOpencodeEnv();
    const password = "  secret\tvalue  ";
    process.env.RC_OC_SESSION = "ses_auth1";
    process.env.RC_OC_MIRROR_PERMISSIONS = "1";
    process.env.OPENCODE_SERVER_USERNAME = "alice";
    process.env.OPENCODE_SERVER_PASSWORD = password;
    let seenContext: DriverContext | undefined;
    const lines: string[] = [];
    try {
      const code = await runWrapper(
        ["--rc-file", secret, "--rc-app", "https://broker.example", "--rc-driver", "opencode"],
        {
          runtime: { platform: "linux", arch: "arm64" },
          stderr: (line) => lines.push(line),
          runOpencodeDriver: async (ctx) => {
            seenContext = ctx;
            return 0;
          },
        },
      );

      expect(code).toBe(0);
      expect(seenContext?.extra).toMatchObject({
        baseUrl: "http://127.0.0.1:4096",
        sessionId: "ses_auth1",
        username: "alice",
        password,
        mirrorPermissions: true,
      });
      expect(lines.join("")).not.toContain(password);
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves OpenCode native permission policy untouched by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-opencode-default-perm-"));
    const secret = join(dir, "secret");
    const restoreEnv = clearOpencodeEnv();
    let seenContext: DriverContext | undefined;
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "opencode",
          "--rc-oc-session",
          "ses_default1",
        ],
        {
          runtime: { platform: "linux", arch: "arm64" },
          runOpencodeDriver: async (ctx) => {
            seenContext = ctx;
            return 0;
          },
        },
      );
      expect(code).toBe(0);
      expect(seenContext?.extra?.mirrorPermissions).toBe(false);
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects the retired OpenCode inverse flag with the no-mutation-default guidance", async () => {
    const { fn, calls } = recordingSpawn();
    const lines: string[] = [];
    const code = await runWrapper(["--rc-oc-skip-permissions"], {
      spawnFn: fn,
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(lines.join("")).toMatch(/--rc-oc-skip-permissions is retired/);
    expect(lines.join("")).toMatch(/not mutated by default/);
    expect(lines.join("")).toMatch(/--rc-oc-mirror-permissions/);
  });

  it.each([
    {
      name: "forwarded arguments",
      extra: ["chat", "--rc-oc-session", "ses_good1"],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /remove forwarded arguments/,
    },
    {
      name: "unsupported platform",
      extra: ["--rc-oc-session", "ses_good1"],
      runtime: { platform: "linux" as const, arch: "x64" },
      error: /requires the supported Linux arm64 release tuple/,
    },
    {
      name: "missing exact session",
      extra: [],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /is required and must be a canonical ses_\* session id/,
    },
    {
      name: "malformed session",
      extra: ["--rc-oc-session", "ses_bad-id"],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /canonical ses_\* session id/,
    },
    {
      name: "non-loopback URL",
      extra: ["--rc-oc-session", "ses_good1", "--rc-oc-url", "http://localhost:4096"],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /explicit-port HTTP origin on 127\.0\.0\.1 or \[::1\]/,
    },
    {
      name: "non-pinned model",
      extra: ["--rc-oc-session", "ses_good1", "--rc-oc-model", "provider/model"],
      runtime: { platform: "linux" as const, arch: "arm64" },
      error: /must be exactly amazon-bedrock\/global\.anthropic\.claude-sonnet-4-6/,
    },
  ])("rejects OpenCode $name before identity or network", async ({ extra, runtime, error }) => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-opencode-invalid-"));
    const secret = join(dir, "secret");
    const restoreEnv = clearOpencodeEnv();
    const fetchSpy = vi.fn(() => Promise.reject(new Error("unexpected network call")));
    const driverSpy = vi.fn(async () => 0);
    vi.stubGlobal("fetch", fetchSpy);
    const lines: string[] = [];
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "opencode",
          ...extra,
        ],
        {
          runtime,
          stderr: (line) => lines.push(line),
          runOpencodeDriver: driverSpy,
        },
      );
      expect(code).toBe(2);
      expect(lines.join("")).toMatch(error);
      expect(existsSync(secret)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(driverSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches claude-native with the shared context after exact-version compatibility", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-claude-native-"));
    const secret = join(dir, "secret");
    let seenContext: DriverContext | undefined;
    let seenCertsDir = "";
    let seenClaudeBin = "";
    let seenSpawnClaude: unknown;
    const spawnClaude = vi.fn(async () => 0);
    const compatibilityBins: string[] = [];
    try {
      const code = await runWrapper(
        [
          "chat",
          "--remote-control",
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-backend",
          "sqlite",
          "--rc-driver",
          "claude-native",
        ],
        {
          claudeBin: "/opt/claude",
          claudeCompatibilityCheck: async (bin) => {
            compatibilityBins.push(bin);
          },
          spawnRcEnv: spawnClaude,
          runClaudeNativeDriver: async (ctx, _signal, deps) => {
            seenContext = ctx;
            seenCertsDir = deps.certsDir;
            seenClaudeBin = deps.claudeBin;
            seenSpawnClaude = deps.spawnClaude;
            return 29;
          },
        },
      );

      expect(code).toBe(29);
      expect(existsSync(secret)).toBe(true);
      expect(compatibilityBins).toEqual(["/opt/claude"]);
      expect(seenContext).toMatchObject({
        brokerUrl: "https://broker.example",
        backend: "sqlite",
        harnessArgs: ["chat", "--remote-control"],
        harnessBin: "/opt/claude",
        title: "remote-claw",
        cwd: process.cwd(),
      });
      expect(seenCertsDir).toBe(join(dir, "mitm-certs"));
      expect(seenClaudeBin).toBe("/opt/claude");
      expect(seenSpawnClaude).toBe(spawnClaude);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches exact-session attach without forwarding arguments or asking the driver to discover", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-claude-native-attach-"));
    const secret = join(dir, "secret");
    let seenNativeSessionId: string | undefined;
    let seenHarnessArgs: string[] | undefined;
    let spawnCalls = 0;
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "claude-native",
          "--rc-native-session",
          "cse_Abc-123_exact",
        ],
        {
          claudeCompatibilityCheck: async () => {},
          spawnRcEnv: async () => {
            spawnCalls++;
            return 0;
          },
          runClaudeNativeDriver: async (ctx, _signal, deps) => {
            seenHarnessArgs = ctx.harnessArgs;
            seenNativeSessionId = deps.nativeSessionId;
            return 31;
          },
        },
      );

      expect(code).toBe(31);
      expect(seenHarnessArgs).toEqual([]);
      expect(seenNativeSessionId).toBe("cse_Abc-123_exact");
      expect(spawnCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid id", ["--rc-native-session", "not-canonical"], /canonical cse_\* session id/],
    [
      "forwarded Claude args",
      ["--rc-native-session", "cse_exact", "--remote-control"],
      /remove forwarded Claude arguments/,
    ],
  ] as const)("rejects attach-only %s before compatibility, identity, or dispatch", async (_name, extra, message) => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-native-attach-invalid-"));
    const secret = join(dir, "secret");
    const lines: string[] = [];
    let compatibilityChecks = 0;
    let dispatches = 0;
    try {
      const code = await runWrapper(
        [
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "claude-native",
          ...extra,
        ],
        {
          claudeCompatibilityCheck: async () => {
            compatibilityChecks++;
          },
          runClaudeNativeDriver: async () => {
            dispatches++;
            return 0;
          },
          stderr: (line) => lines.push(line),
        },
      );

      expect(code).toBe(2);
      expect(existsSync(secret)).toBe(false);
      expect(compatibilityChecks).toBe(0);
      expect(dispatches).toBe(0);
      expect(lines.join("")).toMatch(message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects --rc-native-session on another known driver instead of ignoring ownership", async () => {
    const lines: string[] = [];
    const code = await runWrapper(
      [
        "--rc-app",
        "https://broker.example",
        "--rc-driver",
        "mitm",
        "--rc-native-session",
        "cse_exact",
      ],
      { stderr: (line) => lines.push(line) },
    );
    expect(code).toBe(2);
    expect(lines).toEqual([
      "remote-claw: --rc-native-session requires --rc-driver=claude-native\n",
    ]);
  });

  it("does not launch plain Claude when attach-only mode has no broker origin", async () => {
    const lines: string[] = [];
    let spawnCalls = 0;
    const code = await runWrapper(
      ["--rc-driver", "claude-native", "--rc-native-session", "cse_exact"],
      {
        spawnFn: async () => {
          spawnCalls++;
          return 0;
        },
        stderr: (line) => lines.push(line),
      },
    );

    expect(code).toBe(2);
    expect(spawnCalls).toBe(0);
    expect(lines).toEqual(["remote-claw: --rc-native-session requires --rc-app (or RC_APP)\n"]);
  });

  it.each([
    ["--rc-inference", ["--rc-inference", "anthropic"]],
    ["--rc-bedrock-region", ["--rc-bedrock-region", "us-west-2"]],
    ["--rc-bedrock-model", ["--rc-bedrock-model", "provider/model"]],
    ["--rc-accountless", ["--rc-accountless"]],
  ] as const)("rejects %s before native compatibility or dispatch", async (flag, incompatible) => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-native-incompatible-"));
    const secret = join(dir, "secret");
    const lines: string[] = [];
    let compatibilityChecks = 0;
    let dispatches = 0;
    try {
      const code = await runWrapper(
        [
          "--remote-control",
          "--rc-file",
          secret,
          "--rc-app",
          "https://broker.example",
          "--rc-driver",
          "claude-native",
          ...incompatible,
        ],
        {
          claudeCompatibilityCheck: async () => {
            compatibilityChecks++;
          },
          runClaudeNativeDriver: async () => {
            dispatches++;
            return 0;
          },
          stderr: (line) => lines.push(line),
        },
      );

      expect(code).toBe(2);
      expect(existsSync(secret)).toBe(false);
      expect(compatibilityChecks).toBe(0);
      expect(dispatches).toBe(0);
      expect(lines.join("")).toContain(flag);
      expect(lines.join("")).toContain("cannot be used with --rc-driver=claude-native");
    } finally {
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
    let seenDeps: { injectSessionHook?: boolean } | undefined;
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
        ],
        {
          claudeBin: "/opt/claude",
          runtime: { platform: "linux", arch: "arm64" },
          claudeCompatibilityCheck: async () => {},
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
      expect(seenDeps).toEqual({ injectSessionHook: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unproved tmux platform before compatibility, identity, or dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-tmux-platform-"));
    const secret = join(dir, "secret");
    const lines: string[] = [];
    let compatibilityChecks = 0;
    let dispatches = 0;
    try {
      const code = await runWrapper(
        ["--rc-file", secret, "--rc-app", "https://broker.example", "--rc-driver", "tmux"],
        {
          claudeBin: "/opt/claude",
          runtime: { platform: "linux", arch: "x64" },
          claudeCompatibilityCheck: async () => {
            compatibilityChecks++;
          },
          runTmuxDriver: async () => {
            dispatches++;
            return 0;
          },
          stderr: (line) => lines.push(line),
        },
      );

      expect(code).toBe(2);
      expect(existsSync(secret)).toBe(false);
      expect(compatibilityChecks).toBe(0);
      expect(dispatches).toBe(0);
      expect(lines).toContain(
        "remote-claw: --rc-driver=tmux requires the supported Linux arm64 release tuple\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unproved Claude version before tmux identity or dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-tmux-version-"));
    const secret = join(dir, "secret");
    const lines: string[] = [];
    let dispatches = 0;
    try {
      const code = await runWrapper(
        ["--rc-file", secret, "--rc-app", "https://broker.example", "--rc-driver", "tmux"],
        {
          claudeBin: "/opt/claude",
          runtime: { platform: "linux", arch: "arm64" },
          claudeCompatibilityCheck: async () => {
            throw new Error("wrong version");
          },
          runTmuxDriver: async () => {
            dispatches++;
            return 0;
          },
          stderr: (line) => lines.push(line),
        },
      );

      expect(code).toBe(1);
      expect(existsSync(secret)).toBe(false);
      expect(dispatches).toBe(0);
      expect(lines).toContain(`remote-claw: ${STABLE_CLAUDE_REQUIREMENT}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 on an unknown --rc-driver (with the valid list) without spawning claude", async () => {
    const { fn, calls } = recordingSpawn();
    const lines: string[] = [];
    const code = await runWrapper(["--rc-app", "https://b", "--rc-driver", "bogus"], {
      spawnFn: fn,
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("")).toMatch(/unknown --rc-driver=bogus/);
    expect(lines.join("")).toMatch(/mitm \| claude-native \| tmux \| opencode \| codex/);
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
          ["chat", "--rc-file", secret, "--rc-app", "https://broker.example", "--rc-session-hook"],
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
    "warns that --rc-oc-mirror-permissions is a no-op for a non-opencode driver (here: mitm)",
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
            "https://broker.example",
            "--rc-oc-mirror-permissions",
          ],
          {
            claudeCompatibilityCheck: async () => {},
            spawnRcEnv: async () => 0,
            stderr: (l) => lines.push(l),
          },
        );
        expect(code).toBe(0); // a harmless no-op on mitm — we warn, we do NOT fail
        expect(lines.join("")).toMatch(
          /--rc-oc-mirror-permissions only applies to --rc-driver=opencode; ignored for mitm/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("an UNKNOWN driver with --rc-oc-mirror-permissions gets ONLY the unknown-driver error (no double warn)", async () => {
    const { fn, calls } = recordingSpawn();
    const lines: string[] = [];
    // Allowlist-gated warning: the OpenCode permission nag must NOT fire for an unknown driver — that
    // path already errors on its own. Otherwise the user sees two messages for one mistake.
    const code = await runWrapper(
      ["--rc-app", "https://b", "--rc-driver", "bogus", "--rc-oc-mirror-permissions"],
      { spawnFn: fn, stderr: (l) => lines.push(l) },
    );
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("")).toMatch(/unknown --rc-driver=bogus/);
    expect(lines.join("")).not.toMatch(/--rc-oc-mirror-permissions only applies/); // no second message
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

  it("warns that Codex attach flags are a no-op for another known driver", () => {
    expect(
      misappliedDriverFlagWarnings("opencode", {
        "rc-codex-url": "ws://127.0.0.1:4500",
        "rc-codex-thread": "0194f8d8-10b4-7abc-8def-0123456789ab",
      }),
    ).toEqual([
      "remote-claw: --rc-codex-url / --rc-codex-thread only apply to --rc-driver=codex; ignored for opencode\n",
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
    expect(misappliedDriverFlagWarnings("tmux", { "rc-session-hook": true })).toEqual([]);
    expect(
      misappliedDriverFlagWarnings("codex", {
        "rc-codex-url": "ws://127.0.0.1:4500",
        "rc-codex-thread": "0194f8d8-10b4-7abc-8def-0123456789ab",
      }),
    ).toEqual([]);
  });

  it("an UNKNOWN driver gets NO misapplied-flag nag (allowlist-gated; it errors on its own)", () => {
    expect(
      misappliedDriverFlagWarnings("bogus", {
        "rc-inference": "bedrock",
        "rc-oc-url": "http://x",
      }),
    ).toEqual([]);
  });
});
