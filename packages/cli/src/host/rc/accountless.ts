// Accountless native RC (§ bedrock-rc "accountless"). Native `claude --remote-control` is a claude.ai
// account feature gated CLIENT-SIDE: claude only registers an RC session when its on-disk config
// (`<CLAUDE_CONFIG_DIR>/.claude.json`) carries the right cached feature gates. Those gates are normally
// seeded by a real claude.ai login (claude fetches them from `api.anthropic.com/api/features/` and caches
// them under `cachedGrowthBookFeatures`). A token is NOT what gates RC — the MITM intercepts every
// Anthropic call, so the token is never validated; the GATE is the cached-feature state.
//
// Proven live (2026-06-28): seeding ONLY the `bridge`/`ccr` gate family (plus a synthetic claude_max
// `oauthAccount` and a bogus credential) into a fresh, isolated config dir makes claude register and
// bridge a real RC session with NO real login — zero api.anthropic.com when paired with
// `--rc-inference=bedrock`. A from-scratch config WITHOUT these gates boots as "Claude Max" but never
// registers RC (the failure the earlier synth-config test hit). This module builds that seed.
//
// We seed an ISOLATED config dir (never the user's real `~/.claude.json`) and point the child at it via
// `CLAUDE_CONFIG_DIR`, so a real login on the host is untouched. The gates are a CURATED set (the RC
// ones), not a full feature-flag snapshot — the snapshot rots, the bridge gates are stable.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The pretend API key `launch.ts` injects in bedrock/accountless mode. Its last-20 chars are the key
 *  `customApiKeyResponses` is indexed by — listing it under `rejected` makes claude IGNORE the env key
 *  and use the (synthetic) claude.ai login instead of API-key mode, which would DISABLE remote-control. */
export const PRETEND_API_KEY = "sk-ant-remote-claw-bedrock-no-account-needed";
/** claude keys `customApiKeyResponses` by the LAST 20 chars of the API key. */
export const PRETEND_API_KEY_TAIL = PRETEND_API_KEY.slice(-20);

/** The `cachedGrowthBookFeatures` entries that gate native RC ("bridge" = the RC bridge, "ccr" = claude
 *  code remote). Values are the real ones observed in a logged-in config; the config dicts are claude's
 *  own RC tuning. The decisive flags are `tengu_ccr_bridge` + `tengu_bridge_repl_v2` (the master
 *  switches) and `tengu_bridge_attestation_enforce:false` (no device attestation required). Versions:
 *  our gates allow claude ≥ 2.1.139 / repl-v2 ≥ 2.1.70. */
export const RC_GROWTHBOOK_GATES: Readonly<Record<string, unknown>> = {
  tengu_ccr_bridge: true,
  tengu_ccr_bridge_multi_session: true,
  tengu_ccr_delta_rehydrate: true,
  tengu_ccr_bundle_seed_enabled: true,
  tengu_ccr_bundle_max_bytes: 104857600,
  tengu_ccr_v2_send_events_cli: true,
  tengu_bridge_repl_v2: true,
  tengu_bridge_repl_v2_config: {
    init_retry_max_attempts: 3,
    init_retry_base_delay_ms: 500,
    init_retry_jitter_fraction: 0.25,
    init_retry_max_delay_ms: 4000,
    http_timeout_ms: 10000,
    uuid_dedup_buffer_size: 2000,
    heartbeat_interval_ms: 20000,
    heartbeat_jitter_fraction: 0.1,
    token_refresh_buffer_ms: 600000,
    teardown_archive_timeout_ms: 1500,
    connect_timeout_ms: 15000,
    min_version: "2.1.70",
    should_show_app_upgrade_message: false,
  },
  tengu_bridge_requires_action_details: true,
  tengu_bridge_poll_interval_ms: 0,
  tengu_bridge_poll_interval_config: {
    poll_interval_ms_not_at_capacity: 2000,
    poll_interval_ms_at_capacity: 600000,
    heartbeat_interval_ms: 0,
    multisession_poll_interval_ms_not_at_capacity: 5000,
    multisession_poll_interval_ms_at_capacity: 60000,
    multisession_poll_interval_ms_partial_capacity: 5000,
    non_exclusive_heartbeat_interval_ms: 180000,
    session_keepalive_interval_ms: 0,
    session_keepalive_interval_v2_ms: 0,
  },
  tengu_bridge_attestation_enforce: false,
  tengu_bridge_attestation_enforce_config: {
    accept_level: "VERIFIED_KEYLESS_DEVICE",
    accept_statuses: [],
  },
  tengu_bridge_min_version: { minVersion: "2.1.139" },
  // Sessions feature family the RC menu lives under (observed true in a logged-in config).
  tengu_sessions_elevated_auth_enforcement: true,
};

/** Statsig gates from a logged-in config — none gate RC, but seed them so the cache looks complete. */
export const RC_STATSIG_GATES: Readonly<Record<string, boolean>> = {
  tengu_prompt_suggestion: true,
  tengu_year_end_2025_campaign_promo: false,
  tengu_disable_bypass_permissions_mode: false,
};

/** Build the synthetic `.claude.json` for an accountless session: a claude_max `oauthAccount` (so claude
 *  treats the box as logged-in), the RC gate cache (with a FRESH `cachedGrowthBookFeaturesAt` so claude
 *  trusts it and doesn't refetch over the MITM, which would return nothing in bedrock mode), and
 *  `customApiKeyResponses.rejected` carrying the pretend key's tail (forces claude.ai-login mode, not
 *  API-key mode). `now` is injected for deterministic tests. */
export function buildAccountlessClaudeJson(now: number, cwd: string): Record<string, unknown> {
  const iso = new Date(now).toISOString();
  return {
    // Pre-accept the per-folder trust dialog for the working dir. Without this, the child blocks at
    // claude's "Is this a project you trust?" prompt on first launch and never reaches /remote-control
    // (it's waiting on a keypress that, headless/remote, never comes) — the failure the curated-seed
    // live test hit. `hasCompletedOnboarding` covers the global first-run UX but NOT this per-folder gate.
    projects: {
      [cwd]: { hasTrustDialogAccepted: true, allowedTools: [], hasUnseenTeamArtifacts: false },
    },
    // Identity: a synthetic claude.ai account. None of these are validated (the MITM never forwards a
    // real call); they only make claude's client-side "am I logged in?" checks pass.
    oauthAccount: {
      accountUuid: "00000000-0000-0000-0000-000000000000",
      emailAddress: "accountless@remote-claw.local",
      organizationUuid: "11111111-1111-1111-1111-111111111111",
      organizationName: "remote-claw accountless",
      organizationRole: "admin",
      workspaceRole: null,
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_20x",
      userRateLimitTier: null,
      seatTier: null,
      billingType: "subscription",
      hasExtraUsageEnabled: false,
      displayName: "accountless",
      accountCreatedAt: iso,
      profileFetchedAt: iso,
    },
    // Force claude.ai-login mode (NOT API-key mode, which disables remote-control) by rejecting the
    // pretend key launch.ts injects.
    customApiKeyResponses: { approved: [], rejected: [PRETEND_API_KEY_TAIL] },
    // The RC gate cache. Fresh `...At` so claude trusts the on-disk gates and skips an HTTP refetch.
    cachedGrowthBookFeatures: { ...RC_GROWTHBOOK_GATES },
    cachedGrowthBookFeaturesAt: now,
    cachedStatsigGates: { ...RC_STATSIG_GATES },
    cachedExperimentFeatures: [],
    cachedDynamicConfigs: {},
    // Skip onboarding/first-run UX so the child boots straight into a usable REPL.
    hasCompletedOnboarding: true,
    hasUsedRemoteControl: true,
    remoteDialogSeen: true,
    autoUpdates: false,
    autoUpdatesProtectedForNative: true,
    installMethod: "native",
  };
}

/** Build the bogus `.credentials.json`. The tokens are deliberately fake — the MITM intercepts every
 *  Anthropic endpoint so they're never validated, and in bedrock mode all inference is signed for AWS by
 *  the wrapper, never with these. The `expiresAt` is far in the future so claude doesn't try to refresh
 *  (a refresh would also just hit the MITM, but skipping it keeps the boot clean). */
export function buildAccountlessCredentials(now: number): Record<string, unknown> {
  return {
    claudeAiOauth: {
      accessToken: "rc-accountless-no-real-token-access",
      refreshToken: "rc-accountless-no-real-token-refresh",
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
  };
}

/** Seed an isolated CLAUDE_CONFIG_DIR with the accountless `.claude.json` + `.credentials.json`. Creates
 *  `dir` if needed. Returns `dir`. Never touches the user's real config. */
export function seedAccountlessConfigDir(dir: string, now: number, cwd: string): string {
  // mode 0o700: the dir holds a (fake but realistic) credential file — keep it owner-only even if the
  // caller didn't pre-create it as a private mkdtemp dir. (When `dir` already exists, mode is ignored.)
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, ".claude.json"),
    `${JSON.stringify(buildAccountlessClaudeJson(now, cwd), null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, ".credentials.json"),
    `${JSON.stringify(buildAccountlessCredentials(now), null, 2)}\n`,
    { mode: 0o600 },
  );
  return dir;
}
