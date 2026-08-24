import assert from "node:assert/strict";
import test from "node:test";
import { attestTrustedVercelRuntime } from "./attest-trusted-vercel-runtime.mjs";

const SHA = "a".repeat(40);
const ORIGIN = "https://remote-claw-abc123xyz-ejc3-7031s-projects.vercel.app";
const ENV = {
	WEB_E2E_URL: ORIGIN,
	EXPECTED_DEPLOYMENT_SHA: SHA,
	VERCEL_AUTOMATION_BYPASS_SECRET: "do-not-print",
};
const BODY = {
	environment: "preview",
	sha: SHA,
	storage: {
		backend: "sqlite",
		locator: "turso",
		organization: "dev-org",
		group: "dev-group",
		scope: `pr-${SHA.slice(0, 7)}`,
	},
};

test("checks one pinned Preview origin and exact runtime profile", async () => {
	let request;
	const fetchImpl = async (...args) => {
		request = args;
		return Response.json(BODY);
	};

	assert.deepEqual(
		await attestTrustedVercelRuntime({ env: ENV, fetchImpl }),
		BODY,
	);
	assert.equal(request[0], `${ORIGIN}/api/health/deployment`);
	assert.equal(request[1].redirect, "error");
	assert.equal(
		request[1].headers["x-vercel-protection-bypass"],
		"do-not-print",
	);
});

test("fails closed on a mismatched SHA or storage profile", async () => {
	for (const body of [
		{ ...BODY, sha: "b".repeat(40) },
		{ ...BODY, storage: { ...BODY.storage, backend: "vercel" } },
		{ ...BODY, storage: { ...BODY.storage, scope: "prod" } },
	]) {
		await assert.rejects(
			attestTrustedVercelRuntime({
				env: ENV,
				fetchImpl: async () => Response.json(body),
			}),
			/unexpected runtime profile/,
		);
	}
});

test("rejects mutable targets and errors without exposing the bypass", async () => {
	await assert.rejects(
		attestTrustedVercelRuntime({
			env: { ...ENV, WEB_E2E_URL: "https://remote-claw-git-main.vercel.app" },
			fetchImpl: async () => Response.json(BODY),
		}),
		/immutable pinned Vercel deployment origin/,
	);

	const error = await attestTrustedVercelRuntime({
		env: ENV,
		fetchImpl: async () => new Response("no", { status: 503 }),
	}).catch((caught) => caught);
	assert.match(error.message, /HTTP 503/);
	assert.doesNotMatch(error.message, /do-not-print/);
});
