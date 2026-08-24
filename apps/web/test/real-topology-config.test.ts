import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const realTopologyConfigPath = fileURLToPath(
  new URL("../../../tests/web/real-topology.prove.config.ts", import.meta.url),
);
const previewConfigPath = fileURLToPath(
  new URL("../../../tests/web/app-e2e.preview.config.ts", import.meta.url),
);
const realTopologySpecPath = fileURLToPath(
  new URL("../../../tests/web/app-e2e/real-topology.prove.spec.ts", import.meta.url),
);
const deployedFixturePath = fileURLToPath(
  new URL("../../../tests/web/app-e2e/fixtures.ts", import.meta.url),
);
const protectionBypassPath = fileURLToPath(
  new URL("../../../tests/web/app-e2e/protection-bypass.ts", import.meta.url),
);
const cleanBootstrapPath = fileURLToPath(
  new URL("../../../scripts/run-trusted-real-topology-clean.sh", import.meta.url),
);
const trustedRunnerPath = fileURLToPath(
  new URL("../../../scripts/run-trusted-real-topology.mjs", import.meta.url),
);

describe("real-topology credential artifact boundary", () => {
  it("retains no browser artifacts and installs no context-wide bypass header", () => {
    const source = readFileSync(realTopologyConfigPath, "utf8");
    expect(source).toMatch(/trace:\s*["']off["']/);
    expect(source).toMatch(/screenshot:\s*["']off["']/);
    expect(source).toMatch(/video:\s*["']off["']/);
    expect(source).not.toContain("extraHTTPHeaders");
    expect(source).toContain("launchOptions: { env: browserEnvironment }");
    expect(source).toContain(
      'const browserEnvironment: Record<string, string> = { PATH: "/usr/bin:/bin" }',
    );
  });

  it("uses the same no-artifact boundary for the deployed preview suite", () => {
    const source = readFileSync(previewConfigPath, "utf8");
    expect(source).toMatch(/trace:\s*["']off["']/);
    expect(source).toMatch(/screenshot:\s*["']off["']/);
    expect(source).toMatch(/video:\s*["']off["']/);
    expect(source).not.toContain("extraHTTPHeaders");
  });

  it("overrides inherited wire tracing and gives the release wrapper an allowlisted environment", () => {
    const releaseSource = readFileSync(realTopologySpecPath, "utf8");
    expect(releaseSource).toMatch(/RC_LOG:\s*["']warn["']/);
    expect(releaseSource).not.toContain("...process.env");
    expect(releaseSource).not.toContain("RC_LOG_FILE:");
    expect(releaseSource).not.toContain("RC_LOG_FORMAT:");
    for (const credential of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "VERCEL_TOKEN",
      "TURSO_API_TOKEN",
      "TURSO_GROUP_AUTH_TOKEN",
      "TURSO_AUTH_TOKEN",
      "TURSO_DATABASE_URL",
      "CRON_SECRET",
    ]) {
      expect(releaseSource).not.toContain(credential);
    }

    const deployedSource = readFileSync(deployedFixturePath, "utf8");
    expect(deployedSource).toMatch(/RC_LOG:\s*["']warn["']/);
    expect(deployedSource).toContain("delete env.RC_LOG_FILE");
    expect(deployedSource).toContain("delete env.RC_LOG_FORMAT");
  });

  it("keeps the viewer pass and backend selector out of browser navigation", () => {
    const source = readFileSync(realTopologySpecPath, "utf8");
    expect(source).toContain('await page.goto("/")');
    expect(source).toMatch(/window\.location\.hash\s*=\s*encodedPass/);
    expect(source).toContain("encodeURIComponent(pass)");
    expect(source).not.toMatch(/page\.goto\([^)]*(?:pass|backend|#|\?)/i);
  });

  it("exercises the deployed broker default without a CLI or URL backend override", () => {
    const source = readFileSync(realTopologySpecPath, "utf8");
    expect(source).not.toContain("--rc-backend");
    expect(source).not.toContain("backend=sqlite");
  });

  it("does no in-spec broker warm-up before launching the installed host", () => {
    const source = readFileSync(realTopologySpecPath, "utf8");
    const bypassSource = readFileSync(protectionBypassPath, "utf8");
    const testStart = source.indexOf('test("installed CLI + real Claude');
    const hostLaunch = source.indexOf("child = launchInstalled(", testStart);
    const browserNavigation = source.indexOf('await page.goto("/")', hostLaunch);

    expect(testStart).toBeGreaterThanOrEqual(0);
    expect(hostLaunch).toBeGreaterThan(testStart);
    expect(browserNavigation).toBeGreaterThan(hostLaunch);
    expect(source.slice(testStart, hostLaunch)).not.toMatch(
      /\/api\/(?:seq|frame-count|relay|stream)/,
    );
    expect(bypassSource).toContain("context.request.get(origin.href");
    expect(bypassSource).not.toContain("/api/");
  });

  it("installs only the runner-built immutable tarball", () => {
    const source = readFileSync(realTopologySpecPath, "utf8");
    expect(source).toContain("RC_PROOF_PACKED_TARBALL_PATH");
    expect(source).toContain("RC_PROOF_PACKED_TARBALL_SHA256");
    expect(source).not.toContain("scripts/build-cli.mjs");
    expect(source).not.toMatch(/["']pack["']/);
  });

  it("pins the real Claude launcher, bytes, and descendant executable", () => {
    const source = readFileSync(realTopologySpecPath, "utf8");
    const runnerSource = readFileSync(trustedRunnerPath, "utf8");
    expect(source).toContain('const CLAUDE_BIN = "/usr/bin/claude"');
    expect(source).not.toContain("process.env.RC_CLAUDE_BIN ||");
    expect(source).toContain("331_864_296");
    expect(source).toContain("a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177");
    expect(source).toContain("readlinkSync(processExecutable)");
    expect(source).toContain("attestReleaseCleanProcessEnvironment(pid)");
    expect(source).not.toContain('.includes("claude")');
    expect(runnerSource).toMatch(/\/proc\/\$\{pid\}\/environ/);
    expect(runnerSource).toContain('raw.toString("ascii", entryStart, equalsIndex)');
    expect(runnerSource).toContain("raw.fill(0)");
    for (const forbidden of [
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
      "GITHUB_TOKEN",
      "REMOTE_CLAW_SECRET_FILE",
      "VERCEL_AUTOMATION_BYPASS_SECRET",
      "VERCEL_TOKEN",
    ]) {
      expect(runnerSource).toContain(`"${forbidden}"`);
    }
  });

  it("crosses one deployed planned stream rotation before the post-rotation turn", () => {
    const spec = readFileSync(realTopologySpecPath, "utf8");
    const config = readFileSync(realTopologyConfigPath, "utf8");
    expect(spec).toContain("PLANNED_STREAM_ROTATION_MS = 240_000");
    expect(spec).toContain("observePlannedSessionRotation(page)");
    expect(spec).toContain("rotation.observedAndReconnected");
    expect(spec).toContain("_AFTER_ROTATION");
    expect(spec).toContain('postRotationTurn: "assertions_passed"');
    expect(config).toContain("timeout: 780_000");
  });

  it("uses the attested static BusyBox credential-to-stdin bootstrap", () => {
    const source = readFileSync(cleanBootstrapPath, "utf8");
    expect(source.startsWith("#!/bin/busybox ash\n")).toBe(true);
    expect(statSync(cleanBootstrapPath).mode & 0o777).toBe(0o755);
    expect(source).toContain('busybox_stat" = "0:0:755:1914704"');
    expect(source).toContain("52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933");
    expect(source).toContain("printf '%s\\0'");
    expect(source).toContain("/bin/busybox env -i");
    expect(source).toContain("RC_PROOF_INPUT_FD=0");
    expect(source).toContain('/usr/bin/node "$runner_path"');
  });
});
