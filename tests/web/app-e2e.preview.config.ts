import { defineConfig, devices } from "@playwright/test";

// The SAME app e2e (app-e2e/transcript.spec.ts) run against a DEPLOYED Vercel PREVIEW — the only place
// the Vercel Workflows runtime (and the sqlite backend's real Turso Cloud storage) actually exist, so
// this is how the **vercel** and **sqlite/Turso-Cloud** backend UI e2e run.
// No webServer: the app is already deployed; `baseURL` is the preview URL (WEB_E2E_URL). The HOST runs as
// a persistent test process (the seedHost fixture spawns host-runner.ts), talking to the deployed broker
// via identity auth + the SSO bypass. E2E_BACKEND selects the backend to flip to via ?backend=: unset ⇒
// the deployment default (vercel); `sqlite` ⇒ the per-channel backend on real Turso Cloud. Driven by
// .github/workflows/web-preview.yml on a successful preview.

const BASE = process.env.WEB_E2E_URL;

// If the preview is behind Vercel Deployment Protection (SSO), send the automation-bypass secret on
// EVERY browser request (page nav + relay polling) so they reach the app instead of the 401 wall. The
// host-runner gets the same bypass via VERCEL_AUTOMATION_BYPASS_SECRET (see fixtures.ts).
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const extraHTTPHeaders = bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : undefined;

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "transcript.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 }, // remote round-trips over the public internet
  workers: 1,
  // One retry — only to absorb a genuine one-off public-internet blip (TCP reset / edge hiccup) to the
  // deployed preview, NOT to mask app behavior: a systematic race fails the retry too and reds the run.
  retries: 1,
  use: { baseURL: BASE, trace: "retain-on-failure", ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}) },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
