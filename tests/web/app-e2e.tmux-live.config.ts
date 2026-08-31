import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: ["tmux-live.spec.ts"],
  timeout: 600_000,
  expect: { timeout: 30_000 },
  outputDir: "./test-results/tmux-live",
  workers: 1,
  retries: 0,
  use: { baseURL: "http://localhost:3101", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3101",
    cwd: "../../apps/web",
    port: 3101,
    env: {
      BROKER_BACKEND: "sqlite",
      RC_SQLITE_DIR: `/tmp/rc-sqlite-tmux-live-${process.pid}`,
    },
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
