import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8099" },
  webServer: {
    command: "python3 -m http.server 8099 -d ../../docs",
    port: 8099,
    reuseExistingServer: true,
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 5"] } }],
});
