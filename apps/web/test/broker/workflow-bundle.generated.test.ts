import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_BUNDLE_GZIP_B64,
  WORKFLOW_BUNDLE_SOURCE_SHA256,
} from "../../temporal/workflow-bundle.generated";
import { workflowBundleSourceSha } from "../../temporal/workflow-bundle-source.mjs";

// Drift guard for the committed, pre-built workflow bundle (temporal/workflow-bundle.generated.ts).
// We compare a hash of the SOURCE (workflows.ts + names.ts + the @temporalio/worker version), NOT the
// bundle bytes — bundleWorkflowCode is only deterministic per machine (CI vs local differ), so a
// byte compare would flake across environments. A source hash is identical everywhere, so this fails
// exactly when someone edits the workflow without running `pnpm gen:workflow-bundle`.

describe("workflow-bundle.generated.ts", () => {
  it("decodes to a non-empty bundle that mentions the relay signal/query names", () => {
    const code = gunzipSync(Buffer.from(WORKFLOW_BUNDLE_GZIP_B64, "base64")).toString("utf8");
    expect(code.length).toBeGreaterThan(1_000);
    for (const name of ["publish", "close", "state", "relayChannel"]) {
      expect(code).toContain(name);
    }
  });

  it("is current with the workflow source (regenerate with `pnpm gen:workflow-bundle`)", () => {
    expect(WORKFLOW_BUNDLE_SOURCE_SHA256).toEqual(workflowBundleSourceSha());
  });
});
