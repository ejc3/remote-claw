// Pure predicate for the test-env RC_* scrub (used by vitest.setup.ts). Extracted so it can be
// unit-tested WITHOUT the setup file's import-time side effect of mutating process.env.
//
// Why the carve-out: the scrub strips ambient RC_* vars (e.g. a left-over RC_APP) so tests never take
// the real RC-launch path. But the live opencode e2e (driver.e2e.test.ts) is CONFIGURED by
// RC_OPENCODE_E2E_* vars read at import time — scrubbing those silently disabled the e2e's model
// selector (it always fell back to the built-in default model, so it could never be pointed at an
// OVERRIDING model, and CI couldn't catch that because CI has no opencode server and skips the suite).
export function shouldScrubEnvKey(key: string): boolean {
  return key.startsWith("RC_") && !key.startsWith("RC_OPENCODE_E2E_");
}
