import { defineConfig, devices } from "@playwright/test";
import base from "./app-e2e.config";

// Produces the before/after evidence images embedded in docs/astryx-migration.md. Not a gate — run it
// when a finding in that report changes, and commit the PNGs it writes to docs/assets/astryx/.
//
//   pnpm exec playwright test -c app-e2e.evidence.config.ts
//
// deviceScaleFactor 2 (not the zoom harness's 3): these are committed to the repo and rendered inline
// in a doc, so they need to be legible without being large.
export default defineConfig({
  ...base,
  testMatch: ["evidence.spec.ts"],
  outputDir: "./test-results-evidence",
  projects: [
    {
      name: "evidence",
      use: { ...devices["Pixel 5"], deviceScaleFactor: 2, viewport: { width: 393, height: 851 } },
    },
  ],
});
