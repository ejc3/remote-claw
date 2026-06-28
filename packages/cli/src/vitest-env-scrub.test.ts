import { describe, expect, it } from "vitest";
import { shouldScrubEnvKey } from "./vitest-env-scrub.js";

// Guards the silent regression where the live opencode e2e's RC_OPENCODE_E2E_* config knobs got
// scrubbed (so it never ran against the intended provider). CI has no opencode server and skips the
// e2e, so ONLY this unit test can catch a re-broken carve-out.
describe("shouldScrubEnvKey", () => {
  it("scrubs wrapper-launch RC_* vars", () => {
    expect(shouldScrubEnvKey("RC_APP")).toBe(true);
    expect(shouldScrubEnvKey("RC_BACKEND")).toBe(true);
    expect(shouldScrubEnvKey("RC_LOG")).toBe(true);
    expect(shouldScrubEnvKey("RC_DRIVER")).toBe(true);
  });

  it("preserves the live-e2e config knobs (RC_OPENCODE_E2E_*)", () => {
    expect(shouldScrubEnvKey("RC_OPENCODE_E2E_MODEL")).toBe(false);
    expect(shouldScrubEnvKey("RC_OPENCODE_E2E_TURN_MS")).toBe(false);
  });

  it("pins the carve-out boundary: only the RC_OPENCODE_E2E_ namespace (trailing underscore) is preserved", () => {
    // The carve-out is the e2e var NAMESPACE — keys must have the trailing `_`. A bare `RC_OPENCODE_E2E`
    // or a near-miss like `RC_OPENCODE_E2EX` is NOT in the namespace and is still scrubbed, so the
    // allowlist can't be widened by accident to a non-namespaced wrapper var.
    expect(shouldScrubEnvKey("RC_OPENCODE_E2E")).toBe(true);
    expect(shouldScrubEnvKey("RC_OPENCODE_E2EX")).toBe(true);
    // Only `RC_`-prefixed keys are ever scrubbed; a lowercase/empty key is left untouched.
    expect(shouldScrubEnvKey("rc_app")).toBe(false);
    expect(shouldScrubEnvKey("")).toBe(false);
  });

  it("leaves non-RC vars untouched", () => {
    expect(shouldScrubEnvKey("OPENCODE_URL")).toBe(false);
    expect(shouldScrubEnvKey("AWS_REGION")).toBe(false);
    expect(shouldScrubEnvKey("PATH")).toBe(false);
  });
});
