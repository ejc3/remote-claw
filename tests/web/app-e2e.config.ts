import { defineConfig, devices } from "@playwright/test";

// App e2e: drives the REAL web client (a real Chromium) against a REAL Next server running the broker
// on the in-process LocalBackend (BROKER_BACKEND=local). The host side is a real, persistent process: the
// seedHost fixture (app-e2e/fixtures.ts) spawns host-runner.ts (a real HostRcRelay + serve() + a scripted
// RC turn) per test. Separate from playwright.config.ts (the docs site) — run with `pnpm test:app`.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "transcript.spec.ts", // the drain spec runs under app-e2e.drain.config.ts only
  timeout: 90_000,
  expect: { timeout: 20_000 }, // absorb cold-start latency of a freshly-built prod server
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1, // each test spawns its own host; keep them sequential and deterministic
  // No retries: the in-process host makes this deterministic, and the old retries:2 is exactly what masked
  // the seed-route publish race as "flaky→green". A flake here now is a real bug — surface it, don't absorb.
  retries: 0,
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  // Run against a PRODUCTION build, not `next dev`: dev's on-demand compilation triggers HMR
  // module-graph rebuilds, and a prod build also exercises the real bundle. (The broker cache is a
  // globalThis singleton so it survives module duplication / HMR regardless — see lib/broker/index.ts.)
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3100",
    cwd: "../../apps/web",
    port: 3100,
    env: { BROKER_BACKEND: "local" },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
