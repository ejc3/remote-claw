import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

// The @workflow/vitest plugin runs workflows in-process — the real durable runtime (hooks,
// streams, resume), no deployed server. So the relay round-trip is exercised against the SAME
// engine that runs on Vercel, just locally and deterministically.
//
// The workspace packages (@remote-claw/clawsec, @remote-claw/cli) are pnpm `workspace:*` deps, so
// node_modules SYMLINKS to their live source on disk — vitest always compiles the current code, no
// reinstall, no alias to keep in sync with the package `exports` map. (Earlier these were `file:`
// deps, which pnpm hard-COPIES into `.pnpm`, so edits silently didn't reach a test run until
// `pnpm install` — the stale-copy footgun the workspace conversion removed at the root.)
export default defineConfig({
  plugins: [workflow()],
  resolve: {
    // The workspace sources use `.js` import specifiers (verbatimModuleSyntax) that map to `.ts` on
    // disk — let vite resolve them through the symlinked package source.
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
