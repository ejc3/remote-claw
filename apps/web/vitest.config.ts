import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

// Per-INVOCATION namespace for the in-process workflow runtime's on-disk state. The plugin isolates
// each forked worker WITHIN one run via a `vitest-${VITEST_POOL_ID}` tag, but two concurrent
// `vitest run` invocations both start their pool ids at 0/1 — so without this they'd share
// `.workflow-data` AND `world.clear()` of one would wipe the other's data mid-run. Keying the data +
// bundle dirs by a per-invocation token (pid + start time) gives each run its OWN store, so the suite
// is safe to run as parallel invocations as well as in parallel files. The token also makes every run
// start from a fresh, never-before-used dir (pids alone can be reused), so no destructive pre-clean is
// needed — that's why `test:run`/`test:stress` no longer run `clean:wdk` before vitest (a tree-wide
// `rm -rf` there would delete a CONCURRENT run's dir mid-flight); `pnpm clean:wdk` stays for occasional
// manual cleanup of these gitignored dirs. Override WORKFLOW_TEST_NS for a stable, shared dir.
const RUN_NS = process.env.WORKFLOW_TEST_NS ?? `run-${process.pid}-${Date.now().toString(36)}`;

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
  plugins: [workflow({ dataDir: `.workflow-data/${RUN_NS}`, outDir: `.workflow-vitest/${RUN_NS}` })],
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
