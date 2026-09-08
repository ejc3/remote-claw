import { describe, expect, it } from "vitest";
import { RC_FLAGS } from "./args.js";
import { RC_HELP } from "./help.js";

// Drift guard: the hand-written banner has no automatic link to RC_FLAGS, so lock the
// invariants that matter — it advertises exactly the implemented identity flags, points at
// claude's --remote-control, and never re-advertises a removed flag.
describe("RC_HELP banner", () => {
  it("names every reserved launcher flag", () => {
    for (const name of Object.keys(RC_FLAGS)) expect(RC_HELP).toContain(`--${name}`);
  });

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
      "--rc-native-session",
      "--rc-trace",
    ]) {
      expect(RC_HELP).toContain(f);
    }
  });

  it("documents the per-driver (tmux / opencode / codex) flags", () => {
    for (const f of [
      "--rc-session-hook",
      "--rc-no-session-hook",
      "--rc-oc-url",
      "--rc-oc-model",
      "--rc-oc-session",
      "--rc-oc-mirror-permissions",
      "--rc-codex-url",
      "--rc-codex-thread",
    ]) {
      expect(RC_HELP).toContain(f);
    }
    expect(RC_HELP).toMatch(/Permissions and questions remain native\/local in the tmux pane/);
    expect(RC_HELP).not.toContain("--rc-tmux-skip-permissions");
  });

  it("documents the env-only knobs that have no flag", () => {
    for (const e of [
      "RC_CLAUDE_BIN",
      "RC_BEDROCK_STRIP_KEYS",
      "VERCEL_AUTOMATION_BYPASS_SECRET",
      "OPENCODE_SERVER_USERNAME",
      "OPENCODE_SERVER_PASSWORD",
      "RC_OC_MIRROR_PERMISSIONS",
    ]) {
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

  it("states the pass authority and deployment-bypass origin pin", () => {
    expect(RC_HELP).toMatch(/indefinite, machine-wide bearer credential/);
    expect(RC_HELP).toMatch(/forge trusted records/);
    expect(RC_HELP).toMatch(/individual revocation is unavailable/);
    expect(RC_HELP).toMatch(/RC_APP must independently pin the exact same HTTPS origin/);
    expect(RC_HELP).toMatch(/bypass is never sent to loopback/);
  });

  it("states the stable Claude durable-backend precondition", () => {
    expect(RC_HELP).toMatch(/Stable Claude requires that\s+durable profile/);
    expect(RC_HELP).toContain("sqlite/Turso");
    expect(RC_HELP).toContain("fails closed before discovery");
  });

  it("exposes the bounded Claude native companion separately from the private relay", () => {
    expect(RC_HELP).toMatch(/mitm \| claude-native \| tmux \| opencode/);
    expect(RC_HELP).toContain("Claude native companion (--rc-driver=claude-native)");
    expect(RC_HELP).toContain("Linux/Claude 2.1.237 text/image/interrupt companion");
    expect(RC_HELP).toMatch(/Images become private host-owned\s+upload files/);
    expect(RC_HELP).toContain("256 MiB decoded-image budget is per companion run");
    expect(RC_HELP).toContain("not a global or cross-restart disk quota");
    expect(RC_HELP).toMatch(/Literal official-client coexistence acceptance passed/);
    expect(RC_HELP).toContain("session-scoped Interrupt");
    expect(RC_HELP).toContain("a delayed Stop may affect newer work");
    expect(RC_HELP).toMatch(/--rc-inference, --rc-bedrock-\*, and --rc-accountless\s+are rejected/);
    expect(RC_HELP).toMatch(/--rc-native-session <cse_…>/);
    expect(RC_HELP).toMatch(/starts no interactive Claude session or proxy/);
    expect(RC_HELP).toMatch(/required version probe still runs/);
  });

  it("distinguishes the maintained tmux boundary, pinned OpenCode tuple, and Bedrock inference", () => {
    expect(RC_HELP).toContain("tmux is the maintained lower-fidelity compatibility driver");
    expect(RC_HELP).toContain("Linux arm64 with Claude 2.1.237");
    expect(RC_HELP).toContain("no provider-native/official-client");
    expect(RC_HELP).toMatch(/idle editor and slash\/config UI share one keystream/);
    expect(RC_HELP).toMatch(/do not manipulate them while\s+remote viewers may submit/);
    expect(RC_HELP).toContain("Pinned OpenCode driver (--rc-driver=opencode)");
    expect(RC_HELP).toMatch(/pinned supported text\/interrupt\/status tuple/);
    expect(RC_HELP).toMatch(
      /maintained\s+accountless text-smoke tuple \(tools disabled\) is Linux arm64 \/ Claude 2\.1\.237/,
    );
    expect(RC_HELP).toContain("anthropic.claude-opus-4-8 / temporary IMDSv2 SigV4");
  });

  it("documents the frozen attach-only OpenCode tuple and no-mutation default", () => {
    expect(RC_HELP).toMatch(/Linux arm64 and exact OpenCode 1\.17\.5/);
    expect(RC_HELP).toMatch(/Attach-only: the companion never discovers, selects, or creates/);
    expect(RC_HELP).toMatch(/Default leaves native permission policy untouched/);
    expect(RC_HELP).toMatch(/retired --rc-oc-skip-permissions is an error/);
    expect(RC_HELP).toMatch(/MAIN-session running\/idle\s+status is read-only/);
    expect(RC_HELP).toMatch(/No forwarded arguments/);
  });

  it("documents the frozen attach-only Codex tuple and local interaction ownership", () => {
    expect(RC_HELP).toContain("Pinned Codex companion (--rc-driver=codex)");
    expect(RC_HELP).toMatch(/Linux arm64\s+and exact Codex app-server 0\.151\.0\s+or 0\.153\.4/);
    expect(RC_HELP).toMatch(/literal `unix:\/\/` for Codex's same-user managed\s+control socket/);
    expect(RC_HELP).toMatch(/caller-owned explicit-port loopback `ws:\/\/` origin/);
    expect(RC_HELP).toMatch(/Arbitrary\s+Unix paths.+are rejected/);
    expect(RC_HELP).toMatch(/never starts or stops the app-server/);
    expect(RC_HELP).toMatch(/resumes\/joins only the\s+exact supplied thread/);
    expect(RC_HELP).toMatch(/Browser input is non-empty, non-slash text plus interrupt/);
    expect(RC_HELP).toMatch(/images with an optional non-slash caption/);
    expect(RC_HELP).toMatch(/host-prepared inline bytes, never browser URLs or file paths/);
    expect(RC_HELP).toMatch(/one active turn ID without retargeting or retrying/);
    expect(RC_HELP).toMatch(
      /Exact 0\.153\.4 also supports one-shot ordinary local-command approvals/,
    );
    expect(RC_HELP).toMatch(/Submitted choices stay pending until native resolution/);
    expect(RC_HELP).toMatch(/Keep a local Codex TUI attached/);
    expect(RC_HELP).toMatch(
      /Version 0\.151\.0 approvals,\s+other permission kinds, and all questions remain native-owned/,
    );
    expect(RC_HELP).toMatch(/No forwarded arguments/);
  });

  it("does not advertise removed flags", () => {
    expect(RC_HELP).not.toContain("--rc-share");
    expect(RC_HELP).not.toContain("--rc-web");
    expect(RC_HELP).not.toContain("--rc-app-key");
  });
});
