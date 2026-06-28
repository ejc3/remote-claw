// Scrub ambient RC_* vars from the developer's shell before any test runs. With RC_APP
// exported (e.g. left over from deploy work), runWrapper takes the real RC-launch path —
// bypassing injected spawn mocks and launching a REAL claude against a live broker.
// Tests that need an RC_* var set it explicitly (in-process or on the child env).
//
// The one carve-out (RC_OPENCODE_E2E_*) and WHY it matters live in vitest.env-scrub.ts, so the
// predicate stays pure + unit-testable (vitest.env-scrub.test.ts guards the silent regression that
// scrubbing the e2e's own config knobs would cause).
import { shouldScrubEnvKey } from "./src/vitest-env-scrub.js";

for (const key of Object.keys(process.env)) {
  if (shouldScrubEnvKey(key)) delete process.env[key];
}
