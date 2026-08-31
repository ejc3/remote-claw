import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldScrubEnvKey } from "./vitest-env-scrub.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_TEST = resolve(PACKAGE_ROOT, "src/host/rc/opencode/driver.e2e.test.ts");

function listedFiles(config: string): string[] {
  const executable = join(PACKAGE_ROOT, "node_modules", ".bin", "vitest");
  const result = spawnSync(executable, ["list", "--filesOnly", "--json", "--config", config], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, RC_OPENCODE_E2E_RUN: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Vitest discovery failed: ${result.stderr || result.stdout}`);
  }
  return (JSON.parse(result.stdout) as Array<{ file: string }>).map(({ file }) => file);
}

// Guards the silent regression where the live opencode e2e's exact opt-in/session controls get scrubbed
// (so it never runs, or attaches to no caller-selected native session). CI has no opencode server, so
// this unit test owns that setup boundary.
describe("shouldScrubEnvKey", () => {
  it("scrubs wrapper-launch RC_* vars", () => {
    expect(shouldScrubEnvKey("RC_APP")).toBe(true);
    expect(shouldScrubEnvKey("RC_BACKEND")).toBe(true);
    expect(shouldScrubEnvKey("RC_LOG")).toBe(true);
    expect(shouldScrubEnvKey("RC_DRIVER")).toBe(true);
    expect(shouldScrubEnvKey("VERCEL_AUTOMATION_BYPASS_SECRET")).toBe(true);
  });

  it("preserves only the live-e2e controls that the suite reads", () => {
    expect(shouldScrubEnvKey("RC_OPENCODE_E2E_RUN")).toBe(false);
    expect(shouldScrubEnvKey("RC_OPENCODE_E2E_SESSION")).toBe(false);
    expect(shouldScrubEnvKey("RC_OPENCODE_E2E_MODEL")).toBe(true);
    expect(shouldScrubEnvKey("RC_OPENCODE_E2E_UNUSED")).toBe(true);
  });

  it("does not preserve near-miss live-e2e names", () => {
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

describe("Vitest suite discovery", () => {
  it("keeps the opted-in live provider suite out of ordinary tests", () => {
    expect(listedFiles("vitest.config.ts")).not.toContain(LIVE_TEST);
  });

  it("selects only the live provider suite through its explicit script", () => {
    expect(listedFiles("vitest.opencode-live.config.ts")).toEqual([LIVE_TEST]);

    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts).toMatchObject({
      test: "vitest",
      "test:run": "vitest run",
      "test:opencode-live":
        "RC_OPENCODE_E2E_RUN=1 vitest run --config vitest.opencode-live.config.ts",
    });
  });
});
