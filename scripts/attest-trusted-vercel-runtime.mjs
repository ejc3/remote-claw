import { fileURLToPath } from "node:url";
import { validateTrustedDeploymentOrigin } from "./resolve-trusted-vercel-deployment.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const COORDINATE_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const MAX_BODY_BYTES = 4_096;

function required(value, name) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} is required`);
	}
	return value.trim();
}

function validateAttestation(value, expectedSha) {
	if (
		value === null ||
		typeof value !== "object" ||
		value.environment !== "preview" ||
		value.sha !== expectedSha ||
		value.storage === null ||
		typeof value.storage !== "object" ||
		value.storage.backend !== "sqlite" ||
		value.storage.locator !== "turso" ||
		!COORDINATE_PATTERN.test(value.storage.organization) ||
		!COORDINATE_PATTERN.test(value.storage.group) ||
		value.storage.scope !== `pr-${expectedSha.slice(0, 7)}`
	) {
		throw new Error("deployment reported an unexpected runtime profile");
	}
	return value;
}

/**
 * Make one small, credential-confined check that the immutable Preview origin serves the commit and
 * durable backend we intend to exercise. This binds the following browser smoke to deployed bytes;
 * it is not a self-attesting release certificate.
 */
export async function attestTrustedVercelRuntime({
	env = process.env,
	fetchImpl = fetch,
} = {}) {
	const origin = validateTrustedDeploymentOrigin(
		required(env.WEB_E2E_URL, "WEB_E2E_URL"),
	);
	const expectedSha = required(
		env.EXPECTED_DEPLOYMENT_SHA,
		"EXPECTED_DEPLOYMENT_SHA",
	).toLowerCase();
	if (!SHA_PATTERN.test(expectedSha)) {
		throw new Error("EXPECTED_DEPLOYMENT_SHA must be a full commit digest");
	}
	const bypass = required(
		env.VERCEL_AUTOMATION_BYPASS_SECRET,
		"VERCEL_AUTOMATION_BYPASS_SECRET",
	);

	const response = await fetchImpl(`${origin}/api/health/deployment`, {
		redirect: "error",
		headers: {
			accept: "application/json",
			"x-vercel-protection-bypass": bypass,
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(
			`deployment attestation failed with HTTP ${response.status}`,
		);
	}
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		throw new Error("deployment attestation response is too large");
	}
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
		throw new Error("deployment attestation response is too large");
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("deployment attestation response is not JSON");
	}
	const attestation = validateAttestation(value, expectedSha);
	process.stdout.write(`served Preview matches ${expectedSha}\n`);
	return attestation;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		await attestTrustedVercelRuntime();
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown failure";
		process.stderr.write(`served Preview check failed: ${message}\n`);
		process.exitCode = 1;
	}
}
