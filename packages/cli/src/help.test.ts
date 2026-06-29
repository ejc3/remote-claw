import { describe, expect, it } from "vitest";
import { RC_HELP } from "./help.js";

// Drift guard: the hand-written banner has no automatic link to RC_FLAGS, so lock the
// invariants that matter — it advertises exactly the implemented identity flags, points at
// claude's --remote-control, and never re-advertises a removed flag.
describe("RC_HELP banner", () => {
  it("documents the implemented identity flags", () => {
    for (const f of [
      "--rc-identity",
      "--rc-show-secret",
      "--rc-pass",
      "--rc-confirm",
      "--rc-file",
      "--rc-json",
      "--rc-quiet",
    ]) {
      expect(RC_HELP).toContain(f);
    }
  });

  it("documents the implemented launcher / driver / inference flags", () => {
    for (const f of [
      "--rc-app",
      "--rc-backend",
      "--rc-driver",
      "--rc-inference",
      "--rc-bedrock-region",
      "--rc-bedrock-model",
      "--rc-accountless",
      "--rc-trace",
    ]) {
      expect(RC_HELP).toContain(f);
    }
  });

  it("documents the per-driver (tmux / opencode) flags", () => {
    for (const f of [
      "--rc-tmux-skip-permissions",
      "--rc-session-hook",
      "--rc-no-session-hook",
      "--rc-oc-url",
      "--rc-oc-model",
      "--rc-oc-session",
      "--rc-oc-skip-permissions",
    ]) {
      expect(RC_HELP).toContain(f);
    }
  });

  it("documents the env-only knobs that have no flag", () => {
    for (const e of ["RC_CLAUDE_BIN", "RC_BEDROCK_STRIP_KEYS", "OPENCODE_SERVER_PASSWORD"]) {
      expect(RC_HELP).toContain(e);
    }
  });

  it("no longer advertises --rc-rotate (replace folded into --rc-identity --rc-confirm)", () => {
    expect(RC_HELP).not.toContain("--rc-rotate");
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
