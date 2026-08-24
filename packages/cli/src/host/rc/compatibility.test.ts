import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireStableClaudeExecutable,
  assertStableClaudeCompatibility,
  compatibilityProbeEnv,
  STABLE_CLAUDE_REQUIREMENT,
  type StableClaudeExecutableIdentity,
} from "./compatibility.js";

function fixtureIdentity(path: string): StableClaudeExecutableIdentity {
  const stat = statSync(path);
  return {
    byteLength: stat.size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
  };
}

describe("assertStableClaudeCompatibility", () => {
  it("scrubs wrapper-only secrets and parent-session identity from the probe child", () => {
    const source = {
      PATH: "/bin",
      REMOTE_CLAW_SECRET_FILE: "/private/secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      CLAUDE_CODE_CHILD_SESSION: "child",
      CLAUDE_CODE_SESSION_ID: "parent",
    };

    expect(compatibilityProbeEnv(source)).toEqual({ PATH: "/bin" });
    expect(source.REMOTE_CLAW_SECRET_FILE).toBe("/private/secret");
  });

  it("accepts only the retained Linux arm64 Claude version", async () => {
    const readVersion = vi.fn(async () => "2.1.237 (Claude Code)\n");

    await expect(
      assertStableClaudeCompatibility("claude", {
        platform: "linux",
        arch: "arm64",
        readVersion,
      }),
    ).resolves.toBeUndefined();
    expect(readVersion).toHaveBeenCalledWith("claude");
  });

  it.each([
    { platform: "darwin" as const, arch: "arm64" },
    { platform: "linux" as const, arch: "x64" },
  ])("rejects an unsupported $platform/$arch before executing Claude", async (host) => {
    const readVersion = vi.fn(async () => "2.1.237 (Claude Code)");

    await expect(
      assertStableClaudeCompatibility("claude", { ...host, readVersion }),
    ).rejects.toThrow(STABLE_CLAUDE_REQUIREMENT);
    expect(readVersion).not.toHaveBeenCalled();
  });

  it.each([
    "2.1.238 (Claude Code)",
    "2.1.237",
    "",
    "2.1.237 (Claude Code) extra",
  ])("rejects non-exact version output without reflecting it in the error: %j", async (output) => {
    const error = await assertStableClaudeCompatibility("claude", {
      platform: "linux",
      arch: "arm64",
      readVersion: async () => output,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(STABLE_CLAUDE_REQUIREMENT);
  });

  it("collapses probe failures to the same bounded compatibility error", async () => {
    await expect(
      assertStableClaudeCompatibility("/secret/path/claude", {
        platform: "linux",
        arch: "arm64",
        readVersion: async () => {
          throw new Error("spawn /secret/path/claude EACCES token=secret");
        },
      }),
    ).rejects.toThrow(STABLE_CLAUDE_REQUIREMENT);
  });

  it("rejects a version-spoofing executable before running its probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-claw-claude-spoof-"));
    const command = join(root, "claude");
    const readVersion = vi.fn(async () => "2.1.237 (Claude Code)\n");
    writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' '2.1.237 (Claude Code)'\n", {
      mode: 0o755,
    });
    try {
      await expect(
        acquireStableClaudeExecutable("claude", {
          path: root,
          platform: "linux",
          arch: "arm64",
          readVersion,
        }),
      ).rejects.toThrow(STABLE_CLAUDE_REQUIREMENT);
      expect(readVersion).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects changed bytes with the same metadata and claimed version", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-claw-claude-digest-"));
    const command = join(root, "claude");
    const original = "#!/bin/sh\nprintf '%s\\n' 'fixture-a'\n";
    const changed = "#!/bin/sh\nprintf '%s\\n' 'fixture-b'\n";
    writeFileSync(command, original, { mode: 0o755 });
    const expectedExecutableIdentity = fixtureIdentity(command);
    writeFileSync(command, changed, { mode: 0o755 });
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    const readVersion = vi.fn(async () => "2.1.237 (Claude Code)\n");
    try {
      await expect(
        acquireStableClaudeExecutable("claude", {
          path: root,
          platform: "linux",
          arch: "arm64",
          readVersion,
          expectedExecutableIdentity,
        }),
      ).rejects.toThrow(STABLE_CLAUDE_REQUIREMENT);
      expect(readVersion).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the exact checked executable inode across an atomic path replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-claw-claude-pin-"));
    const command = join(root, "claude");
    const checked = join(root, "checked-claude");
    const script = (marker: string) =>
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '2.1.237 (Claude Code)'; else printf '%s\\n' '${marker}'; fi\n`;
    writeFileSync(command, script("checked-inode"), { mode: 0o755 });
    const expectedExecutableIdentity = fixtureIdentity(command);
    let pinnedPath = "";
    let release = () => {};
    try {
      const executable = await acquireStableClaudeExecutable("claude", {
        path: root,
        platform: "linux",
        arch: "arm64",
        expectedExecutableIdentity,
      });
      release = executable.release;
      pinnedPath = executable.claudeBin;
      expect(pinnedPath).toMatch(/^\/proc\/[0-9]+\/fd\/[0-9]+$/);

      renameSync(command, checked);
      writeFileSync(command, script("replacement-inode"), { mode: 0o755 });
      expect(execFileSync(pinnedPath, ["--marker"], { encoding: "utf8" }).trim()).toBe(
        "checked-inode",
      );

      executable.release();
      executable.release();
      expect(existsSync(pinnedPath)).toBe(false);
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
