import { describe, expect, it, vi } from "vitest";
import {
  assertStableClaudeCompatibility,
  compatibilityProbeEnv,
  STABLE_CLAUDE_REQUIREMENT,
} from "./compatibility.js";

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

  it("accepts the supported Claude version without constraining OS or installation path", async () => {
    const readVersion = vi.fn(async () => "2.1.237 (Claude Code)\n");

    await expect(
      assertStableClaudeCompatibility("/user/owned/bin/claude", { readVersion }),
    ).resolves.toBeUndefined();
    expect(readVersion).toHaveBeenCalledWith("/user/owned/bin/claude");
  });

  it.each([
    "2.1.238 (Claude Code)",
    "2.1.237",
    "",
    "2.1.237 (Claude Code) extra",
  ])("rejects non-exact version output without reflecting it in the error: %j", async (output) => {
    const error = await assertStableClaudeCompatibility("claude", {
      readVersion: async () => output,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(STABLE_CLAUDE_REQUIREMENT);
  });

  it("collapses probe failures to the same bounded compatibility error", async () => {
    await expect(
      assertStableClaudeCompatibility("/secret/path/claude", {
        readVersion: async () => {
          throw new Error("spawn /secret/path/claude EACCES token=secret");
        },
      }),
    ).rejects.toThrow(STABLE_CLAUDE_REQUIREMENT);
  });
});
