import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // A live provider suite is never part of ordinary `pnpm test`, even when a developer's shell or
      // .env.local contains its opt-in. The dedicated config selects it explicitly.
      "src/host/rc/opencode/driver.e2e.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
