import { defineConfig, devices } from "@playwright/test";

// The SAME app e2e (app-e2e/transcript.spec.ts) run against a DEPLOYED Vercel PREVIEW — the only place
// the Vercel Workflows runtime (and the sqlite backend's real Turso Cloud storage) actually exist, so
// this is how the **vercel** and **sqlite/Turso-Cloud** backend UI e2e run.
// No webServer: the app is already deployed; `baseURL` is the preview URL (WEB_E2E_URL). The seed route
// is reached with the DEV_SEED_TOKEN secret (E2E_SEED_TOKEN). E2E_BACKEND selects the backend to flip to
// via ?backend=: unset ⇒ the deployment default (vercel); `sqlite` ⇒ the per-session backend on real
// Turso Cloud. Driven by .github/workflows/web-preview.yml on a successful preview.

const BASE = process.env.WEB_E2E_URL;

// If the preview is behind Vercel Deployment Protection (SSO), send the automation-bypass secret on
// EVERY browser request (page nav + the seed fetch) so they reach the app instead of the 401 wall.
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const extraHTTPHeaders = bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : undefined;

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "transcript.spec.ts", // the drain spec runs under app-e2e.drain.config.ts only
  timeout: 120_000,
  expect: { timeout: 30_000 }, // remote round-trips over the public internet
  workers: 1,
  retries: 2,
  use: { baseURL: BASE, trace: "retain-on-failure", ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}) },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
