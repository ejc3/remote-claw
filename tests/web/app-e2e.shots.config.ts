import { defineConfig, devices } from "@playwright/test";
import base from "./app-e2e.config";

// The screenshot harness (app-e2e/shots.spec.ts) — the visual half of the Astryx migration's
// verification. Deliberately NOT in app-e2e.config.ts's testMatch: it asserts almost nothing, it exists
// to produce artifacts, and it would only slow the real gate down.
//
//   pnpm exec playwright test -c app-e2e.shots.config.ts                 # both widths
//   pnpm exec playwright test -c app-e2e.shots.config.ts --project=phone # just the phone
//
// Shots land in tests/web/shots/<project>/. Take a set on the base commit and a set on the branch, then
// compare them side by side — same server, same seeded host, same viewport, so any pixel difference is
// the change under review.
//
// Two viewports because the viewer has two genuinely different layouts: a single column with back-nav on
// a phone, and the two-pane console (plus ANCHORED dropdowns instead of bottom sheets) above 761px.
export default defineConfig({
  ...base,
  testMatch: ["shots.spec.ts"],
  outputDir: "./test-results-shots",
  projects: [
    { name: "phone", use: { ...devices["Pixel 5"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
  ],
});
