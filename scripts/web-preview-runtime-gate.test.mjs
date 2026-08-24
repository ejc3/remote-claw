import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
	resolve(ROOT, ".github/workflows/web-preview.yml"),
	"utf8",
);
const helper = readFileSync(
	resolve(ROOT, "scripts/attest-trusted-vercel-runtime.mjs"),
	"utf8",
);

function step(name) {
	const marker = `      - name: ${name}\n`;
	const start = workflow.indexOf(marker);
	assert.notEqual(start, -1, `missing workflow step: ${name}`);
	const next = workflow.indexOf("\n      - ", start + marker.length);
	return workflow.slice(start, next === -1 ? workflow.length : next);
}

test("preview credentials are reachable only from a typed default-branch dispatch", () => {
	assert.match(workflow, /repository_dispatch:/);
	assert.match(workflow, /types: \[web-preview-e2e\]/);
	assert.doesNotMatch(workflow, /workflow_dispatch:/);
	assert.doesNotMatch(workflow, /deployment_status:/);
	assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
	assert.match(workflow, /environment: release-proof/);
	assert.match(
		workflow,
		/RC_DEPLOYMENT_ID: \$\{\{ github\.event\.client_payload\.deployment_id \}\}/,
	);
	assert.match(workflow, /RC_REQUIRE_TRUSTED: "1"/);

	const privilegedJob = workflow.indexOf("  e2e:\n");
	assert.notEqual(privilegedJob, -1);
	assert.doesNotMatch(workflow.slice(0, privilegedJob), /\$\{\{ secrets\./);
});

test("preview secrets are step-scoped and runtime attestation precedes deployed e2e", () => {
	const e2eStart = workflow.indexOf("  e2e:\n");
	const stepsStart = workflow.indexOf("    steps:\n", e2eStart);
	assert.notEqual(e2eStart, -1);
	assert.notEqual(stepsStart, -1);
	const jobPreamble = workflow.slice(e2eStart, stepsStart);
	assert.doesNotMatch(
		jobPreamble,
		/VERCEL_AUTOMATION_BYPASS_SECRET|TURSO_CLOUD_E2E/,
	);

	const attestation = step("Bind the served Preview bytes to the resolved SHA");
	assert.match(attestation, /id: runtime_attestation/);
	assert.match(attestation, /EXPECTED_DEPLOYMENT_SHA:/);
	assert.match(attestation, /node scripts\/attest-trusted-vercel-runtime\.mjs/);
	assert.match(attestation, /echo "verified=true" >> "\$GITHUB_OUTPUT"/);

	const attestationAt = workflow.indexOf(attestation);
	for (const command of [
		"pnpm --filter @remote-claw/web run test:preview",
		"pnpm --filter remote-claw-web-tests exec playwright test -c app-e2e.preview.config.ts",
	]) {
		assert.ok(
			attestationAt < workflow.indexOf(command),
			`${command} precedes attestation`,
		);
	}
});

test("every bypass-bearing e2e requires the successful runtime-attestation output", () => {
	const broker = step("Deployment-targeted e2e (real broker over HTTP)");
	assert.match(broker, /runtime_attestation\.outputs\.verified == 'true'/);
	assert.match(broker, /optional_secrets\.outputs\.bypass != 'true'/);
	assert.match(broker, /VERCEL_AUTOMATION_BYPASS_SECRET:/);

	for (const name of [
		"App UI e2e against the preview (vercel backend)",
		"App UI e2e against the preview (sqlite — real Turso Cloud)",
	]) {
		const candidate = step(name);
		assert.match(candidate, /optional_secrets\.outputs\.bypass == 'true'/);
		assert.match(candidate, /runtime_attestation\.outputs\.verified == 'true'/);
		assert.match(candidate, /VERCEL_AUTOMATION_BYPASS_SECRET:/);
	}
});

test("deployed UI legs explicitly exercise distinct Vercel and SQLite backends", () => {
	const vercel = step("App UI e2e against the preview (vercel backend)");
	const sqlite = step(
		"App UI e2e against the preview (sqlite — real Turso Cloud)",
	);

	assert.match(vercel, /E2E_BACKEND: vercel/);
	assert.doesNotMatch(vercel, /E2E_BACKEND: sqlite/);
	assert.match(sqlite, /E2E_BACKEND: sqlite/);
	assert.doesNotMatch(sqlite, /E2E_BACKEND: vercel/);
});

test("attestation helper delegates to the pinned-origin redirect-denying verifier", () => {
	assert.match(helper, /attestServedDeployment/);
	assert.match(helper, /EXPECTED_DEPLOYMENT_SHA/);
	assert.doesNotMatch(
		helper,
		/console\.log|JSON\.stringify\(env|process\.env\)/,
	);
});
