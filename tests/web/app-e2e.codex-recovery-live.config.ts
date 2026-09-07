import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: ["codex-recovery-live.spec.ts"],
  timeout: 600_000,
  expect: { timeout: 30_000 },
  outputDir: "./test-results/codex-recovery-live",
  workers: 1,
  retries: 0,
  use: { trace: "off" }, // Pass-bearing pairing URLs must not be retained in traces.
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3103",
    cwd: "../../apps/web",
    port: 3103,
    env: {
      BROKER_BACKEND: "sqlite",
      RC_SQLITE_DIR: `/tmp/rc-sqlite-codex-recovery-${process.pid}`,
    },
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
