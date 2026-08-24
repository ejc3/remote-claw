import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
	resolve(root, ".github/workflows/web-preview.yml"),
	"utf8",
);

test("deployment credentials remain behind a trusted default-branch dispatch", () => {
	assert.match(workflow, /repository_dispatch:/);
	assert.match(workflow, /types: \[web-preview-e2e\]/);
	assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
	assert.match(workflow, /environment: release-proof/);
	assert.match(workflow, /RC_REQUIRE_TRUSTED: "1"/);

	const privilegedJob = workflow.indexOf("  smoke:\n");
	assert.notEqual(privilegedJob, -1);
	assert.doesNotMatch(workflow.slice(0, privilegedJob), /\$\{\{ secrets\./);
});

test("one exact-SHA binding precedes one deployed product smoke", () => {
	const checkoutNeedle =
		"ref: $" + "{{ needs.resolve-deployment.outputs.sha }}";
	const checkout = workflow.indexOf(checkoutNeedle);
	const bind = workflow.indexOf(
		"node scripts/attest-trusted-vercel-runtime.mjs",
	);
	const smoke = workflow.indexOf(
		"playwright test -c app-e2e.preview.config.ts",
	);
	assert.ok(checkout >= 0 && checkout < bind && bind < smoke);
	assert.equal(
		workflow.match(/playwright test -c app-e2e\.preview\.config\.ts/g)?.length,
		1,
	);
	assert.doesNotMatch(
		workflow,
		/run-trusted|inspection-receipt|verify-production-release|E2E_BACKEND: vercel/,
	);
});

test("the bypass is scoped to the protected job and never persisted by checkout", () => {
	assert.match(workflow, /persist-credentials: false/g);
	assert.match(workflow, /VERCEL_AUTOMATION_BYPASS_SECRET: \$\{\{ secrets\./);
	assert.doesNotMatch(workflow, /trace: ['"]?on|upload-artifact/);
});
