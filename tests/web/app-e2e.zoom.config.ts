import { defineConfig, devices } from "@playwright/test";
import base from "./app-e2e.config";

// Design-inspection harness (app-e2e/zoom.spec.ts) — tight, high-DPI crops of each region plus the
// measured geometry behind them. Deliberately NOT in the gate's testMatch: it asserts almost nothing and
// exists to produce artifacts a human (or a model) can actually judge.
//
//   pnpm exec playwright test -c app-e2e.zoom.config.ts
//
// One project, a phone viewport at deviceScaleFactor 3. Phone because that is the viewer's primary
// device and the tightest space budget; 3× because a 1× crop of a 12px gap is unreadable — spacing
// mistakes only become obvious when the pixels are big enough to count.
export default defineConfig({
  ...base,
  testMatch: ["zoom.spec.ts"],
  outputDir: "./test-results-zoom",
  projects: [
    {
      name: "zoom",
      use: { ...devices["Pixel 5"], deviceScaleFactor: 3, viewport: { width: 393, height: 851 } },
    },
  ],
});
