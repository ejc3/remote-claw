import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/host/rc/opencode/driver.e2e.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
