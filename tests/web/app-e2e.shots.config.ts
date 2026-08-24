import { defineConfig, devices } from "@playwright/test";
import base from "./app-e2e.config";

// The screenshot harness (app-e2e/shots.spec.ts) — the visual half of the Astryx migration's
// verification. Deliberately NOT in app-e2e.config.ts's testMatch: it asserts almost nothing, it exists
// to produce artifacts, and it would only slow the real gate down.
//
//   pnpm exec playwright test -c app-e2e.shots.config.ts                       # four projects
//   pnpm exec playwright test -c app-e2e.shots.config.ts --project=phone-dark  # one project
//
// Shots land in tests/web/shots/<project>/. Take a set on the base commit and a set on the branch, then
// compare them side by side — same server, same seeded host, same viewport, so any pixel difference is
// the change under review.
//
// Two viewports because the viewer has two genuinely different layouts: a single column with back-nav on
// a phone, and the two-pane console (plus ANCHORED dropdowns instead of bottom sheets) above 761px. Each
// viewport is captured in BOTH colour modes — the viewer now defaults to `system`, so `colorScheme` is set
// EXPLICITLY per project (not left to Playwright's implicit 'light') and drives light-dark() via the OS
// preference. Compare -light against -dark side by side to judge the light palette, and either against the
// pre-branch shot to judge the change. Shots land in tests/web/shots/<project>/.
export default defineConfig({
  ...base,
  testMatch: ["shots.spec.ts"],
  outputDir: "./test-results-shots",
  projects: [
    { name: "phone-dark", use: { ...devices["Pixel 5"], colorScheme: "dark" } },
    { name: "phone-light", use: { ...devices["Pixel 5"], colorScheme: "light" } },
    {
      name: "desktop-dark",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
        colorScheme: "dark",
      },
    },
    {
      name: "desktop-light",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
        colorScheme: "light",
      },
    },
  ],
});
