import { defineConfig, devices } from "@playwright/test";

// The SAME app e2e (app-e2e/transcript.spec.ts) run against a DEPLOYED Vercel PREVIEW — the only place
// the Vercel Workflows runtime (and the sqlite backend's real Turso Cloud storage) actually exist, so
// this is how the **vercel** and **sqlite/Turso-Cloud** backend UI e2e run.
// No webServer: the app is already deployed; `baseURL` is the preview URL (WEB_E2E_URL). The HOST runs as
// a persistent test process (the seedHost fixture spawns host-runner.ts), talking to the deployed broker
// via identity auth + the SSO bypass. E2E_BACKEND selects the backend via ?backend=: the workflow passes
// `vercel` for its compatibility leg and `sqlite` for its real Turso Cloud leg. Unset exercises the
// supported deployment default, which is also SQLite/Turso. Driven by .github/workflows/web-preview.yml
// on a successful preview.

const BASE = process.env.WEB_E2E_URL;

// fixtures.ts primes Vercel's origin-scoped bypass cookie with one exact-origin request. Never put the
// bypass in context-wide request headers: Playwright sends those to page-controlled cross-origin
// requests and persists them in traces. Credential-bearing deployed runs retain no browser artifacts.

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "transcript.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 }, // remote round-trips over the public internet
  workers: 1,
  // One retry — only to absorb a genuine one-off public-internet blip (TCP reset / edge hiccup) to the
  // deployed preview, NOT to mask app behavior: a systematic race fails the retry too and reds the run.
  retries: 1,
  use: { baseURL: BASE, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
