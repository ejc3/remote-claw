import { defineConfig, devices } from "@playwright/test";

// One thin outcome smoke against a DEPLOYED Vercel PREVIEW — the only place the production edge and
// SQLite/Turso Cloud storage actually exist. Exhaustive transcript/UI behavior stays in the cheaper
// local built-app suite.
// No webServer: the app is already deployed; `baseURL` is the preview URL (WEB_E2E_URL). The HOST runs as
// a persistent test process (the seedHost fixture spawns host-runner.ts), talking to the deployed broker
// via identity auth + the SSO bypass. The workflow leaves E2E_BACKEND unset so the supported deployment
// default remains in control. Driven by .github/workflows/web-preview.yml on a successful preview.

const BASE = process.env.WEB_E2E_URL;

// fixtures.ts primes Vercel's origin-scoped bypass cookie with one exact-origin request. Never put the
// bypass in context-wide request headers: Playwright sends those to page-controlled cross-origin
// requests and persists them in traces. Credential-bearing deployed runs retain no browser artifacts.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "deployed-smoke.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 }, // remote round-trips over the public internet
  workers: 1,
  forbidOnly: true,
  // The deployed smoke owns intermittent create→serve and edge behavior, so a retry would erase the
  // very signal this sentinel exists to catch. Diagnose a transport outage from the first failure.
  retries: 0,
  use: { baseURL: BASE, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
