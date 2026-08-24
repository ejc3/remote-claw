import assert from "node:assert/strict";
import test from "node:test";
import { validateTrustedDeployment } from "./resolve-trusted-vercel-deployment.mjs";

const SHA = "a".repeat(40);
const DEPLOYMENT_URL =
	"https://remote-claw-abc123xyz-ejc3-7031s-projects.vercel.app";

function deployment(overrides = {}) {
	return {
		sha: SHA,
		environment: "Preview",
		creator: { login: "vercel[bot]" },
		...overrides,
	};
}

function statuses(overrides = {}) {
	return [
		{
			state: "success",
			environment: "Preview",
			environment_url: DEPLOYMENT_URL,
			creator: { login: "vercel[bot]" },
			...overrides,
		},
	];
}

test("accepts only an immutable deployment origin for the pinned Vercel project/team", () => {
	assert.deepEqual(validateTrustedDeployment(deployment(), statuses()), {
		sha: SHA,
		url: DEPLOYMENT_URL,
	});
});

test("rejects attacker-controlled deployment coordinates", () => {
	const hostile = [
		[deployment({ creator: { login: "attacker" } }), statuses()],
		[deployment({ environment: "Production" }), statuses()],
		[deployment({ sha: "short" }), statuses()],
		[deployment(), statuses({ state: "pending" })],
		[
			deployment(),
			statuses({
				environment_url: "http://remote-claw-x-ejc3-7031s-projects.vercel.app",
			}),
		],
		[
			deployment(),
			statuses({ environment_url: "https://evil-project.vercel.app" }),
		],
		[
			deployment(),
			statuses({
				environment_url:
					"https://remote-claw-git-release-ejc3-7031s-projects.vercel.app",
			}),
		],
		[
			deployment(),
			statuses({
				environment_url:
					"https://remote-claw-abc123xy-ejc3-7031s-projects.vercel.app",
			}),
		],
		[
			deployment(),
			statuses({
				environment_url:
					"https://remote-claw-abc123xyzz-ejc3-7031s-projects.vercel.app",
			}),
		],
		[
			deployment(),
			statuses({
				environment_url:
					"https://remote-claw-ABC123XYZ-ejc3-7031s-projects.vercel.app",
			}),
		],
		[deployment(), statuses({ environment_url: `${DEPLOYMENT_URL}/path` })],
		[
			deployment(),
			statuses({ environment_url: `${DEPLOYMENT_URL}?token=smuggle` }),
		],
		[
			deployment(),
			statuses({
				environment_url: `https://user:pass@${new URL(DEPLOYMENT_URL).hostname}`,
			}),
		],
	];
	for (const [candidate, candidateStatuses] of hostile) {
		assert.throws(() =>
			validateTrustedDeployment(candidate, candidateStatuses),
		);
	}
});

test("does not fall back to an older success after a newer failure", () => {
	assert.throws(
		() =>
			validateTrustedDeployment(deployment(), [
				...statuses({ state: "failure" }),
				...statuses(),
			]),
		/newest status/,
	);
});
