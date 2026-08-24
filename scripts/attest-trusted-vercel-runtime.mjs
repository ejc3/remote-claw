import { fileURLToPath } from "node:url";
import { attestServedDeployment } from "./run-trusted-real-topology.mjs";

function required(value, name) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} is required`);
	}
	return value;
}

export async function attestTrustedVercelRuntime({
	env = process.env,
	fetchImpl = fetch,
} = {}) {
	const attestation = await attestServedDeployment({
		origin: required(env.WEB_E2E_URL, "WEB_E2E_URL").trim(),
		expectedSha: required(
			env.EXPECTED_DEPLOYMENT_SHA,
			"EXPECTED_DEPLOYMENT_SHA",
		)
			.trim()
			.toLowerCase(),
		bypass: required(
			env.VERCEL_AUTOMATION_BYPASS_SECRET,
			"VERCEL_AUTOMATION_BYPASS_SECRET",
		),
		fetchImpl,
	});
	process.stdout.write(
		`served Vercel Preview attested at ${attestation.sha} (content inspection not performed)\n`,
	);
	return attestation;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		await attestTrustedVercelRuntime();
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown failure";
		process.stderr.write(
			`served Vercel Preview attestation refused: ${message}\n`,
		);
		process.exitCode = 1;
	}
}
