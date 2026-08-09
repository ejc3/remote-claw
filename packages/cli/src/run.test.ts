import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("does not activate the runtime owner for an unwrapped invocation", async () => {
    const { fn } = recordingSpawn(0);
    let calls = 0;
    const code = await runWrapper(["chat"], {
      spawnFn: fn,
      runtimeOwnerBootstrap: async () => {
        calls++;
        return null;
      },
    });
    expect(code).toBe(0);
    expect(calls).toBe(0);
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
    let ownerCalls = 0;
    const code = await runWrapper(["--rc-trace", "--help"], {
      spawnFn: fn,
      spawnRcEnv: async () => {
        traceSpawned = true;
        return 0;
      },
      runtimeOwnerBootstrap: async () => {
        ownerCalls++;
        return null;
      },
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(traceSpawned).toBe(false);
    expect(ownerCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(out.join("")).toContain("--rc-trace");
  });

  it("--help prints the rc help banner and STILL falls through to claude with --help", async () => {
    const { fn, calls } = recordingSpawn(0);
    const out: string[] = [];
    let ownerCalls = 0;
    const code = await runWrapper(["--help"], {
      spawnFn: fn,
      stdout: (l) => out.push(l),
      runtimeOwnerBootstrap: async () => {
        ownerCalls++;
        return null;
      },
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("remote-claw"); // our --rc-* banner printed first
    expect(out.join("")).toMatch(/--rc-identity/);
    expect(calls).toEqual([{ bin: "claude", args: ["--help"] }]); // claude still gets --help
    expect(ownerCalls).toBe(0);
  });

  it("does not activate the runtime owner for the local identity action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-identity-"));
    const secret = join(dir, "secret");
    let ownerCalls = 0;
    try {
      const code = await runWrapper(["--rc-identity", "--rc-json", "--rc-file", secret], {
        stdout: () => {},
        stderr: () => {},
        runtimeOwnerBootstrap: async () => {
          ownerCalls++;
          return null;
        },
      });
      expect(code).toBe(0);
      expect(ownerCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!haveOpenssl())("does not activate the runtime owner for live trace mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-trace-"));
    const secret = join(dir, "secret");
    let ownerCalls = 0;
    try {
      const code = await runWrapper(["--rc-trace", "--rc-file", secret, "chat"], {
        spawnRcEnv: async () => 0,
        runtimeOwnerBootstrap: async () => {
          ownerCalls++;
          return null;
        },
      });
      expect(code).toBe(0);
      expect(ownerCalls).toBe(0);
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

  it.skipIf(!haveOpenssl())(
    "--rc-app launches claude behind the MITM (RC enabled), auto-creating the identity",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rc-run-"));
      const secret = join(dir, "secret");
      let seenEnv: NodeJS.ProcessEnv | null = null;
      let seenArgs: readonly string[] | null = null;
      const ownerInputs: Array<{ machineIdentityId: string; secretPath: string }> = [];
      let ownerSecret: Uint8Array | undefined;
      let ownerClosed = 0;
      try {
        const code = await runWrapper(
          ["chat", "--model", "opus", "--rc-file", secret, "--rc-app", "http://broker.example"],
          {
            spawnRcEnv: async (_bin, args, env) => {
              expect(ownerSecret?.every((byte) => byte === 0)).toBe(true);
              seenEnv = env;
              seenArgs = args;
              return 0;
            },
            runtimeOwnerBootstrap: async (input) => {
              ownerSecret = input.identitySecret;
              ownerInputs.push({
                machineIdentityId: input.machineIdentityId,
                secretPath: input.secretPath,
              });
              return {
                close: async () => {
                  ownerClosed++;
                },
              };
            },
          },
        );
        expect(code).toBe(0);
        expect(existsSync(secret)).toBe(true); // identity auto-created on first run
        expect(seenArgs).toEqual(["chat", "--model", "opus"]); // rc flags consumed, claude args kept
        const env = seenEnv as unknown as NodeJS.ProcessEnv;
        expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(env.NODE_EXTRA_CA_CERTS).toBe(join(dir, "mitm-certs", "ca.pem"));
        expect(ownerInputs).toEqual([
          { machineIdentityId: expect.stringMatching(/^[0-9a-f]{32}$/), secretPath: secret },
        ]);
        expect(ownerClosed).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "opencode",
    "tmux",
  ] as const)("activates and detaches the runtime owner around the %s driver", async (driver) => {
    const dir = mkdtempSync(join(tmpdir(), `rc-run-${driver}-`));
    const secret = join(dir, "secret");
    let ownerCalls = 0;
    let ownerClosed = 0;
    let driverCalls = 0;
    let ownerSecret: Uint8Array | undefined;
    try {
      const code = await runWrapper(
        ["chat", "--rc-file", secret, "--rc-app", "http://broker.example", "--rc-driver", driver],
        {
          runtimeOwnerBootstrap: async (input) => {
            ownerCalls++;
            ownerSecret = input.identitySecret;
            return {
              close: () => {
                ownerClosed++;
              },
            };
          },
          runOpencodeDriver: async () => {
            expect(ownerSecret?.every((byte) => byte === 0)).toBe(true);
            driverCalls++;
            return 0;
          },
          runTmuxDriver: async () => {
            expect(ownerSecret?.every((byte) => byte === 0)).toBe(true);
            driverCalls++;
            return 0;
          },
        },
      );
      expect(code).toBe(0);
      expect(ownerCalls).toBe(1);
      expect(driverCalls).toBe(1);
      expect(ownerClosed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues the exact A0 driver path when runtime-owner bootstrap fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-owner-fail-"));
    const secret = join(dir, "secret");
    let driverCalls = 0;
    let ownerSecret: Uint8Array | undefined;
    try {
      const code = await runWrapper(
        ["chat", "--rc-file", secret, "--rc-app", "http://broker.example", "--rc-driver", "tmux"],
        {
          runtimeOwnerBootstrap: async (input) => {
            ownerSecret = input.identitySecret;
            throw new Error("simulated runtime-owner startup failure");
          },
          runTmuxDriver: async () => {
            expect(ownerSecret?.every((byte) => byte === 0)).toBe(true);
            driverCalls++;
            return 0;
          },
        },
      );
      expect(code).toBe(0);
      expect(driverCalls).toBe(1);
    } finally {
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
          { spawnRcEnv: async () => 0, stderr: (l) => lines.push(l) },
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
          { spawnRcEnv: async () => 0, stderr: (l) => lines.push(l) },
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
