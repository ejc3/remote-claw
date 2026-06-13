import { defineConfig, devices } from "@playwright/test";

// The SAME app e2e (app-e2e/transcript.spec.ts) as app-e2e.config.ts, but the spec flips the broker to
// the per-session SQLITE backend via the ?backend= switch (E2E_BACKEND=sqlite, set by the test:app:sqlite
// script) — so the IDENTICAL UI assertions run against the durable per-session libSQL backend too,
// proving the BrokerBackend abstraction is swappable per-request AND that a real prompt→reply round-trips
// through one-db-per-session SQLite (browser → /api/relay+/api/stream → SqliteMultiBackend → the seeded
// HostRcRelay). The Next server's DEFAULT stays local (which also enables the dev /api/dev/seed route);
// only the ?backend=sqlite requests hit the sqlite backend.
//
// No external service: file storage (one libSQL db per session under RC_SQLITE_DIR) runs anywhere; the
// Turso Cloud storage mode is exercised on a real deploy (like the vercel backend). A separate port
// (3103) so it never collides with the local/temporal/drain runs.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "transcript.spec.ts",
  timeout: 90_000,
  expect: { timeout: 25_000 }, // libSQL adds poll-tail latency atop cold start
  outputDir: "./test-results-sqlite",
  fullyParallel: false,
  workers: 1,
  retries: 2,
  use: { baseURL: "http://localhost:3103", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3103",
    cwd: "../../apps/web",
    port: 3103,
    env: {
      BROKER_BACKEND: "local", // default backend + enables /api/dev/seed; ?backend=sqlite overrides
      RC_SQLITE_DIR: process.env.RC_SQLITE_DIR ?? "/tmp/rc-sqlite-e2e",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
