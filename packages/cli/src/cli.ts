#!/usr/bin/env node
// `remote-claw` entry point: classify argv, forward to claude, propagate the exit code.
import { runWrapper } from "./run.js";

try {
  process.exit(
    await runWrapper(process.argv.slice(2), {
      // Keep node:sqlite and the A1 owner graph completely unloaded on plain/help/trace/local paths.
      runtimeOwnerBootstrap: async (input) =>
        (await import("./host/runtime-owner/production.js")).bootstrapProductionRuntimeOwner(input),
    }),
  );
} catch (err) {
  // Defensive: runWrapper resolves a code rather than throwing, but never crash with an
  // unhandled rejection — report and exit 2.
  process.stderr.write(`remote-claw: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
