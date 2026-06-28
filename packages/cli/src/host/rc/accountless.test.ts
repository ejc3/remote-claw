import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAccountlessClaudeJson,
  buildAccountlessCredentials,
  PRETEND_API_KEY,
  PRETEND_API_KEY_TAIL,
  RC_GROWTHBOOK_GATES,
  seedAccountlessConfigDir,
} from "./accountless.js";

const NOW = 1_782_615_004_431;
const CWD = "/home/ubuntu/project";

describe("accountless pretend-key tail", () => {
  it("is the last 20 chars of the injected key (what customApiKeyResponses is indexed by)", () => {
    expect(PRETEND_API_KEY_TAIL).toBe(PRETEND_API_KEY.slice(-20));
    expect(PRETEND_API_KEY_TAIL.length).toBe(20);
    expect(PRETEND_API_KEY_TAIL).toBe("ck-no-account-needed");
  });
});

describe("RC_GROWTHBOOK_GATES", () => {
  it("flips the decisive RC bridge switches on and attestation off", () => {
    // The master RC switches must be true, and device attestation must be off (a fabricated box can't
    // produce a real attestation) — these are exactly what a gate-less from-scratch config lacked.
    expect(RC_GROWTHBOOK_GATES.tengu_ccr_bridge).toBe(true);
    expect(RC_GROWTHBOOK_GATES.tengu_bridge_repl_v2).toBe(true);
    expect(RC_GROWTHBOOK_GATES.tengu_ccr_bridge_multi_session).toBe(true);
    expect(RC_GROWTHBOOK_GATES.tengu_bridge_attestation_enforce).toBe(false);
  });

  it("allows the installed claude version (min-version gates are below 2.1.x current)", () => {
    expect(RC_GROWTHBOOK_GATES.tengu_bridge_min_version).toEqual({ minVersion: "2.1.139" });
    const repl = RC_GROWTHBOOK_GATES.tengu_bridge_repl_v2_config as { min_version: string };
    expect(repl.min_version).toBe("2.1.70");
  });
});

describe("buildAccountlessClaudeJson", () => {
  it("seeds the RC gate cache with a fresh timestamp so claude trusts it (no HTTP refetch)", () => {
    const cfg = buildAccountlessClaudeJson(NOW, CWD);
    expect(cfg.cachedGrowthBookFeaturesAt).toBe(NOW);
    expect((cfg.cachedGrowthBookFeatures as Record<string, unknown>).tengu_ccr_bridge).toBe(true);
  });

  it("rejects the pretend key so claude uses claude.ai-login mode, NOT API-key mode (which disables RC)", () => {
    const cfg = buildAccountlessClaudeJson(NOW, CWD) as {
      customApiKeyResponses: { approved: string[]; rejected: string[] };
    };
    expect(cfg.customApiKeyResponses.rejected).toContain(PRETEND_API_KEY_TAIL);
    expect(cfg.customApiKeyResponses.approved).toEqual([]);
  });

  it("presents a synthetic claude_max account so client-side login checks pass", () => {
    const cfg = buildAccountlessClaudeJson(NOW, CWD) as {
      oauthAccount: { organizationType: string };
      hasCompletedOnboarding: boolean;
    };
    expect(cfg.oauthAccount.organizationType).toBe("claude_max");
    expect(cfg.hasCompletedOnboarding).toBe(true);
  });

  it("pre-accepts the per-folder trust dialog for the cwd (else the child blocks on the trust prompt)", () => {
    const cfg = buildAccountlessClaudeJson(NOW, CWD) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(cfg.projects[CWD]?.hasTrustDialogAccepted).toBe(true);
  });

  it("copies the gate maps (mutating the result does not corrupt the shared constant)", () => {
    const cfg = buildAccountlessClaudeJson(NOW, CWD);
    (cfg.cachedGrowthBookFeatures as Record<string, unknown>).tengu_ccr_bridge = false;
    expect(RC_GROWTHBOOK_GATES.tengu_ccr_bridge).toBe(true); // constant untouched
  });
});

describe("buildAccountlessCredentials", () => {
  it("uses bogus tokens with a far-future expiry (never validated; MITM intercepts everything)", () => {
    const c = buildAccountlessCredentials(NOW) as {
      claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number };
    };
    expect(c.claudeAiOauth.accessToken).toMatch(/no-real-token/);
    expect(c.claudeAiOauth.refreshToken).toMatch(/no-real-token/);
    expect(c.claudeAiOauth.expiresAt).toBeGreaterThan(NOW);
  });
});

describe("seedAccountlessConfigDir", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes .claude.json + .credentials.json (0600) that round-trip as the built objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-accountless-test-"));
    dirs.push(dir);
    const ret = seedAccountlessConfigDir(dir, NOW, CWD);
    expect(ret).toBe(dir);

    const cfg = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(cfg).toEqual(buildAccountlessClaudeJson(NOW, CWD));
    const creds = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
    expect(creds).toEqual(buildAccountlessCredentials(NOW));

    // Secret-bearing files must not be world/group readable.
    expect(statSync(join(dir, ".claude.json")).mode & 0o077).toBe(0);
    expect(statSync(join(dir, ".credentials.json")).mode & 0o077).toBe(0);
  });

  it("creates the dir if it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "rc-accountless-base-"));
    dirs.push(base);
    const nested = join(base, "deep", "config");
    seedAccountlessConfigDir(nested, NOW, CWD);
    expect(
      JSON.parse(readFileSync(join(nested, ".claude.json"), "utf8")).cachedGrowthBookFeaturesAt,
    ).toBe(NOW);
  });
});
