// Pure, dependency-free schema boundary shared by the Preview inspection and Production verifier.
// Importing this module performs no filesystem, environment, package, or network access.

export const TOPOLOGY_RECEIPT_SCHEMA =
	"remote-claw-real-topology-browser-leg/v4";
export const INSPECTION_RECEIPT_SCHEMA =
	"remote-claw-real-topology-inspection/v1";
export const INSPECTION_VERCEL_PROJECT_ID = "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM";
export const INSPECTION_VERCEL_TEAM_ID = "team_fYexi4KRmIrq9wtYsiXs9e9H";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_COORDINATE_PATTERN = /^[A-Za-z0-9._-]+$/;
const IMMUTABLE_PREVIEW_ORIGIN_PATTERN =
	/^https:\/\/remote-claw-[a-z0-9]{9}-ejc3-7031s-projects\.vercel\.app$/;

function exactKeys(value, expected, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is not an object`);
	}
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw new Error(`${label} contains unexpected fields`);
	}
	return value;
}

function safeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function exactString(value, pattern, label) {
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function coordinate(value, label) {
	if (
		typeof value !== "string" ||
		value === "" ||
		value !== value.trim() ||
		!STORAGE_COORDINATE_PATTERN.test(value) ||
		Buffer.byteLength(value, "utf8") > 256
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function canonicalIso(value, label) {
	if (typeof value !== "string") throw new Error(`${label} is invalid`);
	const milliseconds = Date.parse(value);
	if (
		!Number.isSafeInteger(milliseconds) ||
		new Date(milliseconds).toISOString() !== value
	) {
		throw new Error(`${label} is invalid`);
	}
	return milliseconds;
}

export function validateInspectionReceipt(receipt) {
	exactKeys(
		receipt,
		["inspection", "result", "schema", "topology", "turso", "vercel"],
		"inspection receipt",
	);
	if (
		receipt.schema !== INSPECTION_RECEIPT_SCHEMA ||
		receipt.result !== "passed"
	) {
		throw new Error("inspection receipt did not pass");
	}
	exactKeys(
		receipt.topology,
		[
			"githubDeploymentId",
			"headSha",
			"needleSha256",
			"packedTarballSha256",
			"receiptSha256",
			"runId",
			"schema",
		],
		"inspection topology binding",
	);
	for (const key of ["needleSha256", "packedTarballSha256", "receiptSha256"]) {
		exactString(
			receipt.topology[key],
			HASH_PATTERN,
			`inspection topology ${key}`,
		);
	}
	if (
		receipt.topology.schema !== TOPOLOGY_RECEIPT_SCHEMA ||
		!UUID_V4_PATTERN.test(receipt.topology.runId) ||
		!/^[0-9a-f]{40}$/.test(receipt.topology.headSha) ||
		!/^[1-9][0-9]*$/.test(receipt.topology.githubDeploymentId)
	) {
		throw new Error("inspection topology binding is invalid");
	}
	exactKeys(
		receipt.inspection,
		["completedAt", "startedAt"],
		"inspection time window",
	);
	const inspectionStartedAt = canonicalIso(
		receipt.inspection.startedAt,
		"inspection start",
	);
	const inspectionCompletedAt = canonicalIso(
		receipt.inspection.completedAt,
		"inspection completion",
	);
	if (inspectionCompletedAt < inspectionStartedAt) {
		throw new Error("inspection time window is invalid");
	}
	exactKeys(
		receipt.turso,
		[
			"databaseCount",
			"databasePrefix",
			"databaseSetSha256",
			"fleetEnumerations",
			"group",
			"organization",
			"plaintextMatchCount",
			"rowCount",
			"scope",
			"tableCount",
			"valueBytes",
			"valueCount",
		],
		"inspection Turso result",
	);
	coordinate(receipt.turso.organization, "inspection Turso organization");
	coordinate(receipt.turso.group, "inspection Turso group");
	const scope = coordinate(receipt.turso.scope, "inspection Turso scope");
	if (receipt.turso.databasePrefix !== `rc-${scope}-`) {
		throw new Error("inspection Turso database prefix is invalid");
	}
	exactString(
		receipt.turso.databaseSetSha256,
		HASH_PATTERN,
		"inspection Turso database-set digest",
	);
	for (const key of [
		"databaseCount",
		"tableCount",
		"rowCount",
		"valueCount",
		"valueBytes",
	]) {
		safeInteger(receipt.turso[key], `inspection Turso ${key}`);
	}
	if (
		receipt.turso.databaseCount < 1 ||
		receipt.turso.fleetEnumerations !== 2 ||
		receipt.turso.plaintextMatchCount !== 0
	) {
		throw new Error("inspection Turso result is incomplete");
	}
	exactKeys(
		receipt.vercel,
		[
			"beginCanarySha256",
			"deploymentId",
			"endCanarySha256",
			"exhaustedLeafCount",
			"logLineCount",
			"malformedCount",
			"origin",
			"plaintextMatchCount",
			"projectId",
			"queryCount",
			"requestCount",
			"rowManifestSha256",
			"saturatedLeafCount",
			"teamId",
			"truncatedCount",
			"windowCompletedAt",
			"windowStartedAt",
			"wrongDeploymentCount",
		],
		"inspection Vercel result",
	);
	if (
		receipt.vercel.teamId !== INSPECTION_VERCEL_TEAM_ID ||
		receipt.vercel.projectId !== INSPECTION_VERCEL_PROJECT_ID ||
		!/^dpl_[A-Za-z0-9]+$/.test(receipt.vercel.deploymentId) ||
		!IMMUTABLE_PREVIEW_ORIGIN_PATTERN.test(receipt.vercel.origin)
	) {
		throw new Error("inspection Vercel coordinates are invalid");
	}
	const windowStartedAt = canonicalIso(
		receipt.vercel.windowStartedAt,
		"Vercel log window start",
	);
	const windowCompletedAt = canonicalIso(
		receipt.vercel.windowCompletedAt,
		"Vercel log window completion",
	);
	if (windowCompletedAt < windowStartedAt) {
		throw new Error("inspection Vercel window is invalid");
	}
	for (const key of [
		"beginCanarySha256",
		"endCanarySha256",
		"rowManifestSha256",
	]) {
		exactString(receipt.vercel[key], HASH_PATTERN, `inspection Vercel ${key}`);
	}
	for (const key of [
		"exhaustedLeafCount",
		"queryCount",
		"requestCount",
		"logLineCount",
	]) {
		safeInteger(receipt.vercel[key], `inspection Vercel ${key}`);
	}
	if (receipt.vercel.exhaustedLeafCount < 2 || receipt.vercel.queryCount < 2) {
		throw new Error(
			"inspection Vercel result lacks repeated exhausted snapshots",
		);
	}
	for (const key of [
		"wrongDeploymentCount",
		"malformedCount",
		"truncatedCount",
		"saturatedLeafCount",
		"plaintextMatchCount",
	]) {
		if (receipt.vercel[key] !== 0) {
			throw new Error("inspection Vercel result did not pass");
		}
	}
	return receipt;
}
