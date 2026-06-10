import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { bundleWorkflowCode } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { WORKFLOW_BUNDLE_GZIP_B64 } from "../../temporal/workflow-bundle.generated";

// Drift guard for the committed, pre-built workflow bundle (temporal/workflow-bundle.generated.ts).
// bundleWorkflowCode is deterministic (toolchain pinned via the lockfile), so we re-bundle from the
// CURRENT source and assert the committed gzip decodes to exactly that. If someone edits
// workflows.ts / names.ts without running `pnpm gen:workflow-bundle`, this fails — so the keep-warm
// drain route can never ship a stale workflow.

describe("workflow-bundle.generated.ts", () => {
  it("decodes to a non-empty bundle that mentions the relay signal/query names", () => {
    const code = gunzipSync(Buffer.from(WORKFLOW_BUNDLE_GZIP_B64, "base64")).toString("utf8");
    expect(code.length).toBeGreaterThan(1_000);
    for (const name of ["publish", "close", "state", "relayChannel"]) {
      expect(code).toContain(name);
    }
  });

  it("matches a fresh bundle of the current source (regenerate with `pnpm gen:workflow-bundle`)", async () => {
    const committed = gunzipSync(Buffer.from(WORKFLOW_BUNDLE_GZIP_B64, "base64")).toString("utf8");
    const workflowsPath = fileURLToPath(new URL("../../temporal/workflows.ts", import.meta.url));
    const { code: fresh } = await bundleWorkflowCode({ workflowsPath });
    expect(committed).toEqual(fresh);
  }, 60_000);
});
