import { defineConfig, devices } from "@playwright/test";

// The SAME app e2e (app-e2e/transcript.spec.ts) as app-e2e.config.ts, but the spec flips the broker to
// TEMPORAL via the ?backend= switch (E2E_BACKEND=temporal, set by the test:app:temporal script) — so
// the IDENTICAL UI assertions run against Temporal too, proving the BrokerBackend abstraction is
// swappable per-request on ONE deployment. The Next server's DEFAULT stays local (which also enables
// the dev /api/dev/seed route); only the ?backend=temporal requests hit Temporal. The Temporal server
// + relayChannel worker are provisioned by scripts/with-temporal.sh, which exports TEMPORAL_ADDRESS.
//
// A separate port (3101) so it never collides with the local-backend run on 3100.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "transcript.spec.ts", // the drain spec runs under app-e2e.drain.config.ts only
  timeout: 90_000,
  expect: { timeout: 25_000 }, // Temporal adds signal round-trip + query polling, atop cold start
  outputDir: "./test-results-temporal",
  fullyParallel: false,
  workers: 1,
  retries: 2,
  use: { baseURL: "http://localhost:3101", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3101",
    cwd: "../../apps/web",
    port: 3101,
    env: {
      BROKER_BACKEND: "local", // default backend + enables /api/dev/seed; ?backend=temporal overrides
      TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
