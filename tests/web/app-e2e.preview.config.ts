import { defineConfig, devices } from "@playwright/test";

// The SAME app e2e (app-e2e/transcript.spec.ts) run against a DEPLOYED Vercel PREVIEW — the only place
// the Vercel Workflows runtime actually exists, so this is how the **vercel backend** UI e2e runs.
// No webServer: the app is already deployed; `baseURL` is the preview URL (WEB_E2E_URL). The seed route
// is reached with the DEV_SEED_TOKEN secret (E2E_SEED_TOKEN). E2E_BACKEND is unset, so the spec uses the
// deployment's default (vercel). Driven by .github/workflows/web-preview.yml on a successful preview.

const BASE = process.env.WEB_E2E_URL;

export default defineConfig({
  testDir: "./app-e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 }, // remote round-trips over the public internet
  workers: 1,
  retries: 2,
  use: { baseURL: BASE, trace: "retain-on-failure" },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
