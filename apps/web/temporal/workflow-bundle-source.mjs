import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The single source of truth for "what the committed workflow bundle was built from", used by BOTH
// the generator (scripts/gen-workflow-bundle.mjs) and the drift test so they can't compute it
// differently. We hash the workflow SOURCE (workflows.ts + the shared names.ts) plus the resolved
// versions of the two packages bundleWorkflowCode inlines — @temporalio/worker (the bundler) and
// @temporalio/workflow (the runtime workflows.ts imports) — NOT the bundle output, because
// bundleWorkflowCode is only deterministic on a given machine/toolchain (CI vs local differ
// byte-for-byte). A source hash is identical everywhere, so the drift test passes on any machine
// while still catching a workflow edit OR a Temporal version bump that wasn't followed by
// `pnpm gen:workflow-bundle`.

const require = createRequire(import.meta.url);

export function workflowBundleSourceSha() {
  const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
  const namesPath = fileURLToPath(new URL("./names.ts", import.meta.url));
  const workerVersion = require("@temporalio/worker/package.json").version;
  const workflowVersion = require("@temporalio/workflow/package.json").version;
  return createHash("sha256")
    .update(readFileSync(workflowsPath))
    .update(readFileSync(namesPath))
    .update(`@temporalio/worker@${workerVersion}`)
    .update(`@temporalio/workflow@${workflowVersion}`)
    .digest("hex");
}
