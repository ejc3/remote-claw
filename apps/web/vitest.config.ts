import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

// The @workflow/vitest plugin runs workflows in-process — the real durable runtime (hooks,
// streams, resume), no deployed server. So the relay round-trip is exercised against the SAME
// engine that runs on Vercel, just locally and deterministically.
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
