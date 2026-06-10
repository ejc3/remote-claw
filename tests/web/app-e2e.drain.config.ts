import { defineConfig, devices } from "@playwright/test";

// Proves the KEEP-WARM drain route against a REAL production build (`next build` → `next start`),
// which is the only thing that catches a route that compiles but fails at runtime in the built
// server — exactly the failure mode where the workflow bundle couldn't resolve `./names` from the
// Next-emitted asset. The server runs with NO standalone Temporal worker (scripts/with-temporal.sh
// with TEMPORAL_NO_WORKER=1), so a seeded ?backend=temporal session stays queued until the BUILT
// `GET /api/temporal/drain` boots the worker and drains it. Separate port (3102) from the other runs.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "drain.spec.ts",
  timeout: 120_000,
  expect: { timeout: 45_000 }, // build cold-start + Temporal signal/query polling + the drain window
  outputDir: "./test-results-drain",
  fullyParallel: false,
  workers: 1,
  retries: 2,
  use: { baseURL: "http://localhost:3102", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3102",
    cwd: "../../apps/web",
    port: 3102,
    env: {
      BROKER_BACKEND: "local", // default backend + enables /api/dev/seed; ?backend=temporal overrides
      TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
      CRON_SECRET: "test-cron-secret", // the drain spec authenticates with this exact value
      TEMPORAL_DRAIN_WINDOW_MS: "8000", // short window so the route returns promptly in the test
    },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
