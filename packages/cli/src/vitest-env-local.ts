// Pure helper for the test-setup .env.local merge (used by vitest.setup.ts). Extracted so the
// shell-WINS precedence is unit-testable WITHOUT the setup file's import-time side effect of reading a
// file + mutating process.env (mirrors vitest-env-scrub.ts).
//
// Precedence: a var already present in the shell environment overrides .env.local — so an explicit
// `RC_OPENCODE_E2E_MODEL=… pnpm test` still wins over a committed-by-mistake or stale file value, and
// .env.local only FILLS the gaps. parseEnv yields strings; a non-string (shouldn't happen) is skipped.

/** Given the current env and the parsed .env.local entries, return ONLY the keys to set (those absent
 *  from `existing`, with a string value). Never returns a key already present — shell wins. */
export function envLocalAdditions(
  existing: Record<string, string | undefined>,
  parsed: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (existing[key] === undefined && typeof value === "string") out[key] = value;
  }
  return out;
}
