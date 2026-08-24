import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_CREATOR = "vercel[bot]";
const EXPECTED_ENVIRONMENT = "Preview";
const EXPECTED_DEPLOYMENT_ORIGIN =
	/^https:\/\/remote-claw-[a-z0-9]{9}-ejc3-7031s-projects\.vercel\.app\/?$/;

function ownString(value, key) {
	return value !== null &&
		typeof value === "object" &&
		typeof value[key] === "string"
		? value[key]
		: "";
}

export function validateTrustedDeploymentOrigin(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("deployment URL is not a valid absolute URL");
	}
	if (
		!EXPECTED_DEPLOYMENT_ORIGIN.test(rawUrl) ||
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error(
			"deployment URL is not an immutable pinned Vercel deployment origin",
		);
	}
	return url.origin;
}

export function validateTrustedDeployment(deployment, statuses) {
	if (ownString(deployment?.creator, "login") !== EXPECTED_CREATOR) {
		throw new Error(
			"deployment was not created by the pinned Vercel integration",
		);
	}
	if (deployment?.environment !== EXPECTED_ENVIRONMENT) {
		throw new Error("deployment is not a Vercel Preview");
	}
	const sha = ownString(deployment, "sha").toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(sha))
		throw new Error("deployment SHA is not a full commit digest");
	if (!Array.isArray(statuses))
		throw new Error("deployment statuses response is not an array");
	// GitHub returns deployment statuses newest-first. Trust only the authoritative newest status:
	// falling back to an older success after a later failure/inactive transition would authorize a
	// deployment GitHub no longer considers successful.
	const status = statuses[0];
	if (
		status?.state !== "success" ||
		status?.environment !== EXPECTED_ENVIRONMENT ||
		ownString(status?.creator, "login") !== EXPECTED_CREATOR
	) {
		throw new Error(
			"deployment's newest status is not a successful Vercel Preview",
		);
	}
	const rawUrl =
		ownString(status, "environment_url") || ownString(status, "target_url");
	return { sha, url: validateTrustedDeploymentOrigin(rawUrl) };
}

async function githubJson(path, token) {
	const response = await fetch(`https://api.github.com${path}`, {
		redirect: "error",
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok)
		throw new Error(
			`GitHub deployment lookup failed with HTTP ${response.status}`,
		);
	return response.json();
}

function setOutput(name, value) {
	const output = process.env.GITHUB_OUTPUT;
	if (!output) throw new Error("GITHUB_OUTPUT is required");
	appendFileSync(output, `${name}=${value}\n`, { encoding: "utf8" });
}

async function main() {
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const token = process.env.GITHUB_TOKEN ?? "";
	const deploymentId = process.env.RC_DEPLOYMENT_ID ?? "";
	const strict = process.env.RC_REQUIRE_TRUSTED === "1";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new Error("GITHUB_REPOSITORY is invalid");
	}
	if (!/^[1-9][0-9]*$/.test(deploymentId))
		throw new Error("deployment id is invalid");
	if (token === "") throw new Error("GITHUB_TOKEN is required");
	try {
		const deployment = await githubJson(
			`/repos/${repository}/deployments/${deploymentId}`,
			token,
		);
		const statuses = await githubJson(
			`/repos/${repository}/deployments/${deploymentId}/statuses?per_page=100`,
			token,
		);
		const trusted = validateTrustedDeployment(deployment, statuses);
		try {
			execFileSync(
				"git",
				["merge-base", "--is-ancestor", trusted.sha, "origin/main"],
				{
					stdio: "ignore",
				},
			);
		} catch {
			throw new Error("deployment commit is not contained in trusted main");
		}
		setOutput("trusted", "true");
		setOutput("sha", trusted.sha);
		setOutput("url", trusted.url);
		process.stdout.write("trusted Vercel deployment resolved\n");
	} catch (error) {
		if (strict) throw error;
		setOutput("trusted", "false");
		process.stdout.write(
			`deployment skipped: ${(error instanceof Error && error.message) || "untrusted"}\n`,
		);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main();
}
