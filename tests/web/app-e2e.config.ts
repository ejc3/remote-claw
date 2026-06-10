import { defineConfig, devices } from "@playwright/test";

// App e2e: drives the REAL web client (a real Chromium) against a REAL Next server running the broker
// on the in-process LocalBackend (BROKER_BACKEND=local). The host side is seeded by the dev-only
// /api/dev/seed route (a real HostRcRelay + a scripted RC turn). Separate from playwright.config.ts
// (the docs site) — run with `pnpm test:app`.

export default defineConfig({
  testDir: "./app-e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: "./test-results",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  // Run against a PRODUCTION build, not `next dev`: dev's on-demand compilation triggers HMR
  // module-graph rebuilds that reset the in-memory LocalBackend singleton (dropping a buffered
  // announce), and a prod build also exercises the real bundle. build + start has stable in-process
  // state, which the LocalBackend needs.
  webServer: {
    command: "pnpm exec next build --webpack && pnpm exec next start -p 3100",
    cwd: "../../apps/web",
    port: 3100,
    env: { BROKER_BACKEND: "local" },
    reuseExistingServer: true,
    timeout: 300_000,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
