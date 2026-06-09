import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

// The @workflow/vitest plugin runs workflows in-process — the real durable runtime (hooks,
// streams, resume), no deployed server. So the relay round-trip is exercised against the SAME
// engine that runs on Vercel, just locally and deterministically.
//
// ROBUSTNESS (learned the hard way): the workspace packages are `file:` deps, which pnpm
// HARD-COPIES into its `.pnpm` store — so local edits to packages/cli or packages/clawsec do NOT
// reach a test run until `pnpm install` re-syncs the copy. That silently ran tests against STALE
// source (a fix appeared to "not work" because the test never saw it). These aliases pin the
// package specifiers to the LIVE source on disk, so vitest always compiles the current code and the
// stale-copy footgun cannot recur. (CI does a clean install, so it was always correct there; this
// only bites local iteration — which is exactly when it's most confusing.)
const src = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export default defineConfig({
  plugins: [workflow()],
  resolve: {
    alias: [
      { find: /^@remote-claw\/clawsec$/, replacement: src("clawsec/src/index.ts") },
      { find: /^@remote-claw\/cli\/broker$/, replacement: src("cli/src/broker/index.ts") },
      { find: /^@remote-claw\/cli\/rc$/, replacement: src("cli/src/host/rc/index.ts") },
      { find: /^@remote-claw\/cli$/, replacement: src("cli/src/index.ts") },
    ],
    // The workspace sources use `.js` import specifiers (verbatimModuleSyntax) that map to `.ts` on
    // disk — let vite resolve them.
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
