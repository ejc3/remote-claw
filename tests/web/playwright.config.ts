import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // This config is ONLY the docs-site tests (docs.spec.ts, served by the python webServer below). The
  // app e2e (app-e2e/*.spec.ts) runs under its own configs against a Next server — keep it out of here.
  testIgnore: ["app-e2e/**"],
  timeout: 30_000,
  forbidOnly: true,
  use: { baseURL: "http://127.0.0.1:8099" },
  webServer: {
    command: "python3 -m http.server 8099 -d ../../docs",
    port: 8099,
    reuseExistingServer: true,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
