// Pure predicate for the test-env RC_* scrub (used by vitest.setup.ts). Extracted so it can be
// unit-tested WITHOUT the setup file's import-time side effect of mutating process.env.
//
// Why the carve-out: the scrub strips ambient RC_* vars (e.g. a left-over RC_APP) so tests never take
// the real RC-launch path. But the live opencode e2e (driver.e2e.test.ts) reads its exact RUN and MODEL
// controls at import time. Scrubbing either could silently disable an explicitly requested live run or
// point it at the wrong model; preserving the whole namespace would retain stale or accidental knobs.
export function shouldScrubEnvKey(key: string): boolean {
  return key.startsWith("RC_") && key !== "RC_OPENCODE_E2E_RUN" && key !== "RC_OPENCODE_E2E_MODEL";
}
