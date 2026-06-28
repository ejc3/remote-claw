// Test bootstrap, run once before any test (vitest.config.ts setupFiles).
//
// 1. Load `.env.local` (gitignored) so the LIVE opencode e2e (driver.e2e.test.ts) is reproducible on
//    another machine: drop OPENCODE_URL / RC_OPENCODE_E2E_MODEL there once instead of exporting them
//    each run. Precedence is shell-WINS (we only set keys not already in process.env), so an explicit
//    `RC_OPENCODE_E2E_MODEL=… pnpm test` still overrides the file. See .env.example for the keys.
// 2. Scrub ambient RC_* vars (whether from the shell OR .env.local) so tests never take the real
//    RC-launch path: with RC_APP set, runWrapper would bypass injected spawn mocks and launch a REAL
//    claude against a live broker. The one carve-out (RC_OPENCODE_E2E_*) and WHY it matters live in
//    src/vitest-env-scrub.ts, so the predicate stays pure + unit-testable (vitest-env-scrub.test.ts
//    guards the silent regression that scrubbing the e2e's own config knobs would cause).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { envLocalAdditions } from "./src/vitest-env-local.js";
import { shouldScrubEnvKey } from "./src/vitest-env-scrub.js";

// Load .env.local from the package root (next to this setup file). Absent file / parse hiccup is a
// no-op — most machines and CI have no .env.local and must stay green. Shell vars are never overwritten
// (shell-WINS precedence lives in envLocalAdditions, kept pure + unit-tested).
try {
  const envLocal = join(dirname(fileURLToPath(import.meta.url)), ".env.local");
  const additions = envLocalAdditions(process.env, parseEnv(readFileSync(envLocal, "utf8")));
  for (const [key, value] of Object.entries(additions)) process.env[key] = value;
} catch {
  // no .env.local (or unreadable) — nothing to load
}

for (const key of Object.keys(process.env)) {
  if (shouldScrubEnvKey(key)) delete process.env[key];
}

// Also scrub CLAUDE_CONFIG_DIR: the tmux folder-trust writer (trust.ts) resolves it ahead of $HOME the
// way claude does, so a developer who exports it would have tests write their REAL config dir. Tests that
// need it pass an explicit dir/override; none read it from the ambient env.
delete process.env.CLAUDE_CONFIG_DIR;
