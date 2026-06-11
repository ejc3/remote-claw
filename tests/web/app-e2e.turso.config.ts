import { defineConfig, devices } from "@playwright/test";

// The SAME app e2e (app-e2e/transcript.spec.ts) as app-e2e.config.ts, but the spec flips the broker to
// TURSO via the ?backend= switch (E2E_BACKEND=turso, set by the test:app:turso script) — so the
// IDENTICAL UI assertions run against the durable libSQL backend too, proving the BrokerBackend
// abstraction is swappable per-request AND that a real prompt→reply round-trips through Turso (browser →
// /api/relay+/api/stream → TursoBackend → the seeded HostRcRelay). The Next server's DEFAULT stays local
// (which also enables the dev /api/dev/seed route); only the ?backend=turso requests hit Turso.
//
// No external service: TURSO_DATABASE_URL points at a LOCAL libSQL file, so this runs anywhere. A
// separate port (3103) so it never collides with the local/temporal/drain runs.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "transcript.spec.ts",
  timeout: 90_000,
  expect: { timeout: 25_000 }, // Turso adds poll-tail latency atop cold start
  outputDir: "./test-results-turso",
  fullyParallel: false,
  workers: 1,
  retries: 2,
  use: { baseURL: "http://localhost:3103", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3103",
    cwd: "../../apps/web",
    port: 3103,
    env: {
      BROKER_BACKEND: "local", // default backend + enables /api/dev/seed; ?backend=turso overrides
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL ?? "file:/tmp/rc-turso-e2e.db",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
