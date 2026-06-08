import { describe, expect, it } from "vitest";
import { RC_HELP } from "./help.js";

// Drift guard: the hand-written banner has no automatic link to RC_FLAGS, so lock the
// invariants that matter — it advertises exactly the implemented identity flags, points at
// claude's --remote-control, and never re-advertises a removed flag.
describe("RC_HELP banner", () => {
  it("documents the implemented identity flags", () => {
    for (const f of ["--rc-identity", "--rc-file", "--rc-json", "--rc-quiet"]) {
      expect(RC_HELP).toContain(f);
    }
  });

  it("points at claude's --remote-control and explains the passthrough", () => {
    expect(RC_HELP).toContain("--remote-control");
    expect(RC_HELP).toMatch(/forwarded verbatim/);
  });

  it("does not advertise removed flags", () => {
    expect(RC_HELP).not.toContain("--rc-share");
    expect(RC_HELP).not.toContain("--rc-web");
    expect(RC_HELP).not.toContain("--rc-app-key");
  });
});
