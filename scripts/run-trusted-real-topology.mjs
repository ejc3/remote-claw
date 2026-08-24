import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	validateTrustedDeployment,
	validateTrustedDeploymentOrigin,
} from "./resolve-trusted-vercel-deployment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..");
const WEB_TEST_ROOT = join(REPOSITORY_ROOT, "tests", "web");
const RECEIPT_ROOT = join(WEB_TEST_ROOT, "test-results");
const RECEIPT_SCHEMA = "remote-claw-real-topology-browser-leg/v4";
const PINNED_CLAUDE_VERSION = "2.1.237 (Claude Code)";
const PINNED_CLAUDE_PLATFORM = "linux";
const PINNED_CLAUDE_ARCH = "arm64";
const PINNED_CLAUDE_EXECUTABLE_SHA256 =
	"a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177";
const PINNED_CLAUDE_BINARY_BYTES = 331_864_296;
const ATTESTATION_PATH = "/api/prove/deployment-attestation";
const LOG_CANARY_PATH = "/api/prove/log-canary";
const VERCEL_API_ORIGIN = "https://api.vercel.com";
const VERCEL_PROJECT_ID = "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM";
const VERCEL_TEAM_ID = "team_fYexi4KRmIrq9wtYsiXs9e9H";
const WAF_CONFIG_ID = "waf_TG8xDULMuMuR";
const WAF_CONFIG_VERSION = 3;
const WAF_RULE_ID = "rule_handoff_per_ip_rate_limit_UWaS5F";
const WAF_RULE_NAME = "handoff-per-ip-rate-limit";
const WAF_MANAGED_RULES = Object.freeze({
	gen: Object.freeze({ active: true, action: "log" }),
	java: Object.freeze({ active: false, action: "log" }),
	lfi: Object.freeze({ active: false, action: "log" }),
	ma: Object.freeze({ active: false, action: "log" }),
	php: Object.freeze({ active: false, action: "log" }),
	rce: Object.freeze({ active: true, action: "log" }),
	rfi: Object.freeze({ active: false, action: "log" }),
	sd: Object.freeze({ active: false, action: "log" }),
	sf: Object.freeze({ active: false, action: "log" }),
	sqli: Object.freeze({ active: true, action: "log" }),
	xss: Object.freeze({ active: true, action: "log" }),
});
const PLANNED_STREAM_ROTATION_MS = 240_000;
const MIN_OBSERVED_STREAM_ROTATION_MS = 235_000;
const MAX_OBSERVED_STREAM_ROTATION_MS = 270_000;
const MAX_PROOF_WINDOW_MS = 30 * 60_000;
const TRUSTED_PATH = "/usr/bin:/bin";
const NODE_BIN = "/usr/bin/node";
const PNPM_BIN = "/usr/bin/pnpm";
const NPM_BIN = "/usr/bin/npm";
const GIT_BIN = "/usr/bin/git";
const TAR_BIN = "/usr/bin/tar";
const BOOTSTRAP_ENVIRONMENT = {
	LANG: "C.UTF-8",
	PATH: TRUSTED_PATH,
	RC_PROOF_INPUT_FD: "0",
};
const PROOF_INPUT_FIELDS = [
	"HOME",
	"GITHUB_REPOSITORY",
	"GITHUB_TOKEN",
	"RC_DEPLOYMENT_ID",
	"VERCEL_AUTOMATION_BYPASS_SECRET",
	"VERCEL_TOKEN",
	"RC_PROVE_CLAUDE_CWD",
];
const MAX_BOOTSTRAP_INPUT_BYTES = 64 * 1_024;
const MAX_RELEASE_PROCESS_ENVIRONMENT_BYTES = 64 * 1_024;
const FORBIDDEN_RELEASE_PROCESS_ENVIRONMENT_KEYS = new Set([
	"BASH_ENV",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_SESSION_ID",
	"CRON_SECRET",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"INIT_CWD",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NPM_CONFIG_NODE_OPTIONS",
	"NPM_CONFIG_PREFIX",
	"NPM_CONFIG_USERCONFIG",
	"REMOTE_CLAW_SECRET_FILE",
	"TURSO_API_TOKEN",
	"TURSO_AUTH_TOKEN",
	"TURSO_DATABASE_URL",
	"TURSO_GROUP_AUTH_TOKEN",
	"VERCEL_AUTOMATION_BYPASS_SECRET",
	"VERCEL_TOKEN",
	"npm_config_node_options",
	"npm_config_prefix",
	"npm_config_userconfig",
]);
const OPTIONAL_RUNTIME_ENV = [
	"LANG",
	"LC_ALL",
	"LOGNAME",
	"TZ",
	"USER",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
];

function requireNonBlank(value, name) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} is required`);
	}
	return value;
}

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
}

function storageCoordinate(value, label) {
	const coordinate = requireNonBlank(value, label);
	if (
		coordinate !== coordinate.trim() ||
		!/^[A-Za-z0-9._-]+$/.test(coordinate) ||
		Buffer.byteLength(coordinate, "utf8") > 256
	) {
		throw new Error(`${label} is invalid`);
	}
	return coordinate;
}

function canonicalPreviewTursoScope(sha) {
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new Error("runtime attestation expected SHA is invalid");
	}
	return `pr-${sha.slice(0, 7)}`;
}

function normalizeRuntimeAttestation(attestation, expectedSha) {
	exactKeys(
		attestation,
		["environment", "sha", "storage"],
		"deployment runtime attestation",
	);
	if (
		attestation.environment !== "preview" ||
		attestation.sha !== expectedSha
	) {
		throw new Error(
			"served deployment SHA/environment does not match the trusted candidate",
		);
	}
	exactKeys(
		attestation.storage,
		["backend", "group", "locator", "organization", "scope"],
		"deployment runtime storage attestation",
	);
	const organization = storageCoordinate(
		attestation.storage.organization,
		"runtime Turso organization",
	);
	const group = storageCoordinate(
		attestation.storage.group,
		"runtime Turso group",
	);
	const scope = canonicalPreviewTursoScope(expectedSha);
	if (
		attestation.storage.backend !== "sqlite" ||
		attestation.storage.locator !== "turso" ||
		attestation.storage.scope !== scope
	) {
		throw new Error(
			"served deployment storage profile is not the canonical candidate profile",
		);
	}
	return {
		environment: "preview",
		sha: expectedSha,
		storage: {
			backend: "sqlite",
			locator: "turso",
			organization,
			group,
			scope,
		},
	};
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateTrustedExecutable(path, label) {
	let resolvedPath;
	let stat;
	try {
		resolvedPath = realpathSync(path);
		stat = lstatSync(resolvedPath);
	} catch {
		throw new Error(`${label} is not an available trusted executable`);
	}
	const currentUid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o111) === 0 ||
		(stat.mode & 0o022) !== 0 ||
		(currentUid !== undefined && stat.uid !== 0 && stat.uid !== currentUid)
	) {
		throw new Error(`${label} is not an available trusted executable`);
	}
	return resolvedPath;
}

export function validateBootstrapEnvironment(environment) {
	exactKeys(
		environment,
		Object.keys(BOOTSTRAP_ENVIRONMENT),
		"real-topology bootstrap environment",
	);
	for (const [key, value] of Object.entries(BOOTSTRAP_ENVIRONMENT)) {
		if (environment[key] !== value) {
			throw new Error("real-topology bootstrap environment is not exact");
		}
	}
	const trustedNode = validateTrustedExecutable(NODE_BIN, "system Node.js");
	if (realpathSync(process.execPath) !== trustedNode) {
		throw new Error(
			"real-topology proof was not launched by the trusted system Node.js",
		);
	}
}

export function validateProofInput(input) {
	exactKeys(input, PROOF_INPUT_FIELDS, "real-topology private proof input");
	for (const field of PROOF_INPUT_FIELDS) requireNonBlank(input[field], field);
	return input;
}

export function readProofBootstrapInput({
	environment = process.env,
	fd = 0,
	read = readSync,
	statFd = fstatSync,
} = {}) {
	// This exact nonsecret environment check deliberately precedes every fd read, git command, and
	// network request. Direct Node invocation therefore refuses instead of trusting inherited state.
	validateBootstrapEnvironment(environment);
	if (fd !== 0 || environment.RC_PROOF_INPUT_FD !== String(fd)) {
		throw new Error("real-topology bootstrap input descriptor is not pinned");
	}
	let descriptorStat;
	try {
		descriptorStat = statFd(fd);
	} catch {
		throw new Error("real-topology bootstrap input descriptor is unavailable");
	}
	if (!descriptorStat.isFIFO()) {
		throw new Error("real-topology bootstrap input descriptor is not a pipe");
	}
	const chunks = [];
	let totalBytes = 0;
	while (true) {
		const buffer = Buffer.alloc(
			Math.min(4_096, MAX_BOOTSTRAP_INPUT_BYTES + 1 - totalBytes),
		);
		let bytesRead;
		try {
			bytesRead = read(fd, buffer, 0, buffer.length, null);
		} catch {
			throw new Error("real-topology bootstrap input could not be read");
		}
		if (
			!Number.isInteger(bytesRead) ||
			bytesRead < 0 ||
			bytesRead > buffer.length
		) {
			throw new Error("real-topology bootstrap input read was invalid");
		}
		if (bytesRead === 0) break;
		totalBytes += bytesRead;
		if (totalBytes > MAX_BOOTSTRAP_INPUT_BYTES) {
			throw new Error("real-topology bootstrap input is oversized");
		}
		chunks.push(buffer.subarray(0, bytesRead));
	}
	const raw = Buffer.concat(chunks, totalBytes);
	try {
		if (raw.length === 0 || raw.at(-1) !== 0) {
			throw new Error("real-topology bootstrap input is incomplete");
		}
		const fields = [];
		let fieldStart = 0;
		for (let index = 0; index < raw.length; index += 1) {
			if (raw[index] !== 0) continue;
			const encoded = raw.subarray(fieldStart, index);
			let value;
			try {
				value = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
			} catch {
				throw new Error("real-topology bootstrap input is not valid UTF-8");
			}
			fields.push(value);
			fieldStart = index + 1;
		}
		if (
			fieldStart !== raw.length ||
			fields.length !== PROOF_INPUT_FIELDS.length
		) {
			throw new Error("real-topology bootstrap input field count is invalid");
		}
		return validateProofInput(
			Object.freeze(
				Object.fromEntries(
					PROOF_INPUT_FIELDS.map((name, index) => [name, fields[index]]),
				),
			),
		);
	} finally {
		raw.fill(0);
		for (const chunk of chunks) chunk.fill(0);
	}
}

function releaseProcessEnvironmentRefusal() {
	return new Error(
		"running Claude descendant environment is not release-clean",
	);
}

function validateReleaseProcessEnvironmentBytes(raw, byteLength) {
	if (
		!Buffer.isBuffer(raw) ||
		!Number.isInteger(byteLength) ||
		byteLength < 1 ||
		byteLength > MAX_RELEASE_PROCESS_ENVIRONMENT_BYTES ||
		raw[byteLength - 1] !== 0
	) {
		throw releaseProcessEnvironmentRefusal();
	}
	let entryStart = 0;
	while (entryStart < byteLength) {
		const entryEnd = raw.indexOf(0, entryStart);
		const equalsIndex = raw.indexOf(0x3d, entryStart);
		if (
			entryEnd <= entryStart ||
			entryEnd >= byteLength ||
			equalsIndex <= entryStart ||
			equalsIndex >= entryEnd
		) {
			throw releaseProcessEnvironmentRefusal();
		}
		for (let index = entryStart; index < equalsIndex; index += 1) {
			const byte = raw[index];
			const isUpper = byte >= 0x41 && byte <= 0x5a;
			const isLower = byte >= 0x61 && byte <= 0x7a;
			const isDigit = index > entryStart && byte >= 0x30 && byte <= 0x39;
			if (!(isUpper || isLower || isDigit || byte === 0x5f)) {
				throw releaseProcessEnvironmentRefusal();
			}
		}
		const key = raw.toString("ascii", entryStart, equalsIndex);
		if (FORBIDDEN_RELEASE_PROCESS_ENVIRONMENT_KEYS.has(key)) {
			throw releaseProcessEnvironmentRefusal();
		}
		entryStart = entryEnd + 1;
	}
}

export function attestReleaseCleanProcessEnvironment(
	pid,
	{ openFile = openSync, readFromFd = readSync, closeFile = closeSync } = {},
) {
	if (!Number.isSafeInteger(pid) || pid < 1) {
		throw releaseProcessEnvironmentRefusal();
	}
	const raw = Buffer.alloc(MAX_RELEASE_PROCESS_ENVIRONMENT_BYTES + 1);
	let descriptor;
	let valid = false;
	try {
		descriptor = openFile(
			`/proc/${pid}/environ`,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		let byteLength = 0;
		while (byteLength < raw.length) {
			const bytesRead = readFromFd(
				descriptor,
				raw,
				byteLength,
				raw.length - byteLength,
				null,
			);
			if (
				!Number.isInteger(bytesRead) ||
				bytesRead < 0 ||
				bytesRead > raw.length - byteLength
			) {
				throw releaseProcessEnvironmentRefusal();
			}
			if (bytesRead === 0) break;
			byteLength += bytesRead;
		}
		validateReleaseProcessEnvironmentBytes(raw, byteLength);
		valid = true;
	} catch {
		valid = false;
	} finally {
		raw.fill(0);
		if (descriptor !== undefined) {
			try {
				closeFile(descriptor);
			} catch {
				valid = false;
			}
		}
	}
	if (!valid) throw releaseProcessEnvironmentRefusal();
}

function isolatedToolEnvironment(home) {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	return { CI: "1", HOME: home, LANG: "C.UTF-8", PATH: TRUSTED_PATH };
}

export function validateRepositoryState(headOutput, statusOutput) {
	const head = requireNonBlank(headOutput, "local HEAD").trim().toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(head)) {
		throw new Error("local HEAD is not a full commit digest");
	}
	if (typeof statusOutput !== "string" || statusOutput !== "") {
		throw new Error(
			"real-topology proof requires a clean worktree at a committed HEAD",
		);
	}
	return head;
}

export function readRepositoryState({
	cwd = REPOSITORY_ROOT,
	execFile = execFileSync,
} = {}) {
	const git = validateTrustedExecutable(GIT_BIN, "system git");
	const headOutput = execFile(git, ["rev-parse", "--verify", "HEAD"], {
		cwd,
		encoding: "utf8",
		env: { PATH: TRUSTED_PATH },
		stdio: ["ignore", "pipe", "ignore"],
	});
	const statusOutput = execFile(
		git,
		["status", "--porcelain=v1", "--untracked-files=all"],
		{
			cwd,
			encoding: "utf8",
			env: { PATH: TRUSTED_PATH },
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	return { headOutput, statusOutput };
}

function validateRepository(repository) {
	const normalized = requireNonBlank(repository, "GITHUB_REPOSITORY").trim();
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
		throw new Error("GITHUB_REPOSITORY is invalid");
	}
	return normalized;
}

function validateDeploymentId(deploymentId) {
	const normalized = requireNonBlank(deploymentId, "RC_DEPLOYMENT_ID").trim();
	if (!/^[1-9][0-9]*$/.test(normalized)) {
		throw new Error("RC_DEPLOYMENT_ID is invalid");
	}
	return normalized;
}

async function boundedJson(response, label, maximumBytes) {
	let body;
	try {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > maximumBytes)
			throw new Error("oversized");
		body = JSON.parse(text);
	} catch {
		throw new Error(`${label} response is invalid`);
	}
	return body;
}

async function githubJson(path, token, fetchImpl) {
	const response = await fetchImpl(`https://api.github.com${path}`, {
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) {
		throw new Error(
			`GitHub deployment lookup failed with HTTP ${response.status}`,
		);
	}
	return response.json();
}

export async function resolveManualTrustedDeployment({
	deploymentId,
	repository,
	token,
	head,
	fetchImpl = fetch,
}) {
	const normalizedRepository = validateRepository(repository);
	const normalizedDeploymentId = validateDeploymentId(deploymentId);
	const githubToken = requireNonBlank(token, "GITHUB_TOKEN");
	const deployment = await githubJson(
		`/repos/${normalizedRepository}/deployments/${normalizedDeploymentId}`,
		githubToken,
		fetchImpl,
	);
	const statuses = await githubJson(
		`/repos/${normalizedRepository}/deployments/${normalizedDeploymentId}/statuses?per_page=100`,
		githubToken,
		fetchImpl,
	);
	const trusted = validateTrustedDeployment(deployment, statuses);
	if (trusted.sha !== head) {
		throw new Error("deployment SHA does not equal the current local HEAD");
	}
	return trusted;
}

export async function attestServedDeployment({
	origin,
	expectedSha,
	bypass,
	fetchImpl = fetch,
}) {
	const pinnedOrigin = validateTrustedDeploymentOrigin(origin);
	if (pinnedOrigin !== origin) {
		throw new Error("deployment origin is not in canonical pinned form");
	}
	if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
		throw new Error("runtime attestation expected SHA is invalid");
	}
	const bypassSecret = requireNonBlank(
		bypass,
		"VERCEL_AUTOMATION_BYPASS_SECRET",
	);
	const response = await fetchImpl(`${pinnedOrigin}${ATTESTATION_PATH}`, {
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
		headers: {
			accept: "application/json",
			"x-vercel-protection-bypass": bypassSecret,
		},
	});
	if (response.status !== 200) {
		throw new Error(
			`deployment runtime attestation failed with HTTP ${response.status}`,
		);
	}
	if (
		!response.headers.get("cache-control")?.toLowerCase().includes("no-store")
	) {
		throw new Error("deployment runtime attestation response is cacheable");
	}
	const body = await boundedJson(
		response,
		"deployment runtime attestation",
		1_024,
	);
	return normalizeRuntimeAttestation(body, expectedSha);
}

export async function emitProofLogCanary({
	origin,
	bypass,
	canary,
	fetchImpl = fetch,
}) {
	const pinnedOrigin = validateTrustedDeploymentOrigin(origin);
	if (pinnedOrigin !== origin) {
		throw new Error("deployment origin is not in canonical pinned form");
	}
	const bypassSecret = requireNonBlank(
		bypass,
		"VERCEL_AUTOMATION_BYPASS_SECRET",
	);
	if (
		typeof canary !== "string" ||
		!/^RC_RELEASE_PROOF_LOG_(?:BEGIN|END)_[0-9a-f]{32}$/.test(canary)
	) {
		throw new Error("release-proof log canary is invalid");
	}
	const response = await fetchImpl(`${pinnedOrigin}${LOG_CANARY_PATH}`, {
		method: "POST",
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"x-vercel-protection-bypass": bypassSecret,
		},
		body: JSON.stringify({ canary }),
	});
	if (response.status !== 200) {
		throw new Error(
			`release-proof log canary failed with HTTP ${response.status}`,
		);
	}
	if (
		!response.headers.get("cache-control")?.toLowerCase().includes("no-store")
	) {
		throw new Error("release-proof log canary response is cacheable");
	}
	const body = await boundedJson(response, "release-proof log canary", 128);
	exactKeys(body, ["accepted"], "release-proof log canary response");
	if (body.accepted !== true) {
		throw new Error("release-proof log canary was not accepted");
	}
}

function normalizedEdgeRateLimit() {
	return {
		projectId: VERCEL_PROJECT_ID,
		teamId: VERCEL_TEAM_ID,
		firewallConfigId: WAF_CONFIG_ID,
		firewallConfigVersion: WAF_CONFIG_VERSION,
		ruleId: WAF_RULE_ID,
		ruleName: WAF_RULE_NAME,
		pathPrefix: "/api/handoff",
		algorithm: "token_bucket",
		limit: 20,
		windowSeconds: 60,
		key: "ip",
		excessAction: "deny",
		firewallBypassCount: 0,
	};
}

export function validateEdgeRateLimitEvidence(evidence) {
	const expected = normalizedEdgeRateLimit();
	exactKeys(
		evidence,
		Object.keys(expected),
		"handoff edge-rate-limit evidence",
	);
	for (const [key, value] of Object.entries(expected)) {
		if (evidence[key] !== value) {
			throw new Error("handoff edge-rate-limit evidence is not pinned");
		}
	}
	return evidence;
}

async function vercelJson(path, token, fetchImpl) {
	const response = await fetchImpl(`${VERCEL_API_ORIGIN}${path}`, {
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
		headers: { accept: "application/json", authorization: `Bearer ${token}` },
	});
	if (response.status !== 200) {
		throw new Error(
			`Vercel firewall preflight failed with HTTP ${response.status}`,
		);
	}
	return boundedJson(response, "Vercel firewall preflight", 512 * 1_024);
}

export async function verifyHandoffEdgeRateLimit({ token, fetchImpl = fetch }) {
	const vercelToken = requireNonBlank(token, "VERCEL_TOKEN");
	const query = `projectId=${encodeURIComponent(VERCEL_PROJECT_ID)}&teamId=${encodeURIComponent(
		VERCEL_TEAM_ID,
	)}`;
	const config = await vercelJson(
		`/v1/security/firewall/config?${query}`,
		vercelToken,
		fetchImpl,
	);
	const bypass = await vercelJson(
		`/v1/security/firewall/bypass?${query}`,
		vercelToken,
		fetchImpl,
	);
	try {
		exactKeys(
			config,
			["active", "draft", "versions"],
			"Vercel firewall config",
		);
		if (
			config.draft !== null ||
			!Array.isArray(config.versions) ||
			config.versions.length !== 0
		) {
			throw new Error("not live");
		}
		const active = config.active;
		if (
			active === null ||
			typeof active !== "object" ||
			Array.isArray(active)
		) {
			throw new Error("active config mismatch");
		}
		exactKeys(
			active,
			[
				"changes",
				"crs",
				"firewallEnabled",
				"id",
				"ips",
				"ownerId",
				"projectKey",
				"rules",
				"updatedAt",
				"version",
			],
			"Vercel firewall active config",
		);
		exactKeys(
			active.crs,
			Object.keys(WAF_MANAGED_RULES),
			"Vercel firewall managed rules",
		);
		for (const [category, expected] of Object.entries(WAF_MANAGED_RULES)) {
			const actual = active.crs[category];
			exactKeys(
				actual,
				["action", "active"],
				`Vercel firewall managed rule ${category}`,
			);
			if (
				actual.active !== expected.active ||
				actual.action !== expected.action
			) {
				throw new Error("managed-rule mismatch");
			}
		}
		if (
			typeof active.updatedAt !== "string" ||
			!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(
				active.updatedAt,
			) ||
			Number.isNaN(Date.parse(active.updatedAt)) ||
			new Date(active.updatedAt).toISOString() !== active.updatedAt ||
			active.id !== WAF_CONFIG_ID ||
			active.version !== WAF_CONFIG_VERSION ||
			active.ownerId !== VERCEL_TEAM_ID ||
			active.projectKey !== `${VERCEL_PROJECT_ID}#active` ||
			active.firewallEnabled !== true ||
			!Array.isArray(active.ips) ||
			active.ips.length !== 0 ||
			!Array.isArray(active.changes) ||
			active.changes.length !== 0 ||
			!Array.isArray(active.rules) ||
			active.rules.length !== 1
		) {
			throw new Error("active config mismatch");
		}
		const rule = active.rules[0];
		exactKeys(
			rule,
			[
				"action",
				"active",
				"conditionGroup",
				"description",
				"id",
				"name",
				"valid",
				"validationErrors",
			],
			"Vercel firewall rule",
		);
		if (
			rule.id !== WAF_RULE_ID ||
			rule.name !== WAF_RULE_NAME ||
			rule.active !== true ||
			rule.valid !== true ||
			rule.validationErrors !== null
		) {
			throw new Error("rule mismatch");
		}
		exactKeys(rule.action, ["mitigate"], "Vercel firewall action");
		exactKeys(
			rule.action.mitigate,
			["action", "actionDuration", "rateLimit", "redirect"],
			"Vercel firewall mitigation",
		);
		const mitigation = rule.action.mitigate;
		if (
			mitigation.redirect !== null ||
			mitigation.action !== "rate_limit" ||
			mitigation.actionDuration !== null
		) {
			throw new Error("mitigation mismatch");
		}
		exactKeys(
			mitigation.rateLimit,
			["action", "algo", "keys", "limit", "window"],
			"Vercel firewall rate limit",
		);
		const rateLimit = mitigation.rateLimit;
		if (
			rateLimit.limit !== 20 ||
			rateLimit.window !== 60 ||
			rateLimit.algo !== "token_bucket" ||
			rateLimit.action !== "deny" ||
			!Array.isArray(rateLimit.keys) ||
			rateLimit.keys.length !== 1 ||
			rateLimit.keys[0] !== "ip"
		) {
			throw new Error("rate-limit mismatch");
		}
		if (
			!Array.isArray(rule.conditionGroup) ||
			rule.conditionGroup.length !== 1
		) {
			throw new Error("condition mismatch");
		}
		const group = rule.conditionGroup[0];
		exactKeys(group, ["conditions"], "Vercel firewall condition group");
		if (!Array.isArray(group.conditions) || group.conditions.length !== 1) {
			throw new Error("condition mismatch");
		}
		const condition = group.conditions[0];
		exactKeys(condition, ["op", "type", "value"], "Vercel firewall condition");
		if (
			condition.type !== "path" ||
			condition.op !== "pre" ||
			condition.value !== "/api/handoff"
		) {
			throw new Error("condition mismatch");
		}
		exactKeys(bypass, ["result"], "Vercel firewall bypass list");
		if (!Array.isArray(bypass.result) || bypass.result.length !== 0) {
			throw new Error("bypass mismatch");
		}
	} catch {
		throw new Error(
			"Vercel handoff edge-rate-limit preflight is not the pinned live policy",
		);
	}
	return normalizedEdgeRateLimit();
}

function validateArtifactCoordinates(artifact) {
	if (
		artifact === null ||
		typeof artifact !== "object" ||
		typeof artifact.sourceRoot !== "string" ||
		!isAbsolute(artifact.sourceRoot) ||
		typeof artifact.tarballPath !== "string" ||
		!isAbsolute(artifact.tarballPath) ||
		!/^[0-9a-f]{64}$/.test(artifact.sha256) ||
		typeof artifact.scratchRoot !== "string" ||
		!isAbsolute(artifact.scratchRoot)
	) {
		throw new Error("pinned-HEAD CLI artifact coordinates are invalid");
	}
	return artifact;
}

export function preparePinnedHeadArtifact({
	head,
	cwd = REPOSITORY_ROOT,
	execFile = execFileSync,
	makeScratch = (prefix) => mkdtempSync(prefix),
} = {}) {
	if (!/^[0-9a-f]{40}$/.test(head)) {
		throw new Error("pinned-HEAD CLI artifact requires a full commit digest");
	}
	const scratchRoot = makeScratch(join(tmpdir(), "remote-claw-pinned-head-"));
	try {
		const scratchStat = lstatSync(scratchRoot);
		if (
			!scratchStat.isDirectory() ||
			scratchStat.isSymbolicLink() ||
			(scratchStat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" &&
				scratchStat.uid !== process.getuid())
		) {
			throw new Error("pinned-HEAD CLI scratch root is not private");
		}
		const sourceRoot = join(scratchRoot, "source");
		const artifactRoot = join(scratchRoot, "artifact");
		const toolHome = join(scratchRoot, "tool-home");
		mkdirSync(sourceRoot, { mode: 0o700 });
		mkdirSync(artifactRoot, { mode: 0o700 });
		const toolEnv = isolatedToolEnvironment(toolHome);
		const git = validateTrustedExecutable(GIT_BIN, "system git");
		const tar = validateTrustedExecutable(TAR_BIN, "system tar");
		const node = validateTrustedExecutable(NODE_BIN, "system Node.js");
		const pnpm = validateTrustedExecutable(PNPM_BIN, "system pnpm");
		const npm = validateTrustedExecutable(NPM_BIN, "system npm");
		const archiveFile = join(scratchRoot, "head.tar");
		execFile(git, ["archive", "--format=tar", "--output", archiveFile, head], {
			cwd,
			env: toolEnv,
			stdio: "ignore",
		});
		execFile(
			tar,
			["--extract", "--file", archiveFile, "--directory", sourceRoot],
			{
				cwd: scratchRoot,
				env: toolEnv,
				stdio: "ignore",
			},
		);
		execFile(
			node,
			[
				pnpm,
				"install",
				"--frozen-lockfile",
				"--store-dir",
				join(scratchRoot, "pnpm-store"),
			],
			{ cwd: sourceRoot, env: toolEnv, stdio: "ignore" },
		);
		execFile(node, [pnpm, "run", "build:cli"], {
			cwd: sourceRoot,
			env: toolEnv,
			stdio: "ignore",
		});
		const packed = JSON.parse(
			execFile(
				node,
				[
					npm,
					"pack",
					"--ignore-scripts",
					"--json",
					"--pack-destination",
					artifactRoot,
				],
				{
					cwd: sourceRoot,
					encoding: "utf8",
					env: toolEnv,
					maxBuffer: 64 * 1_024,
					stdio: ["ignore", "pipe", "ignore"],
				},
			),
		);
		const filename = packed[0]?.filename;
		if (
			typeof filename !== "string" ||
			filename === "" ||
			basename(filename) !== filename
		) {
			throw new Error("npm pack returned no safe artifact filename");
		}
		const tarballPath = join(artifactRoot, filename);
		const tarballStat = lstatSync(tarballPath);
		if (
			!tarballStat.isFile() ||
			tarballStat.isSymbolicLink() ||
			tarballStat.size < 1 ||
			tarballStat.size > 64 * 1_024 * 1_024 ||
			(typeof process.getuid === "function" &&
				tarballStat.uid !== process.getuid())
		) {
			throw new Error(
				"pinned-HEAD CLI artifact is not a bounded owned regular file",
			);
		}
		chmodSync(tarballPath, 0o400);
		return validateArtifactCoordinates({
			scratchRoot,
			sourceRoot,
			tarballPath,
			sha256: sha256File(tarballPath),
		});
	} catch (error) {
		rmSync(scratchRoot, { recursive: true, force: true });
		throw error;
	}
}

export function cleanupPinnedHeadArtifact(artifact) {
	validateArtifactCoordinates(artifact);
	const expectedPrefix = resolve(tmpdir(), "remote-claw-pinned-head-");
	if (!resolve(artifact.scratchRoot).startsWith(expectedPrefix)) {
		throw new Error("refusing to clean an unrecognized artifact scratch root");
	}
	const stat = lstatSync(artifact.scratchRoot);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("refusing to clean an unsafe artifact scratch root");
	}
	rmSync(artifact.scratchRoot, { recursive: true, force: true });
}

export function createProofCoordinates({
	head,
	deploymentId,
	trusted,
	runtimeAttestation,
	packedArtifact,
	edgeRateLimit,
	runId = randomUUID(),
	windowStartedAtMs = Date.now(),
}) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			runId,
		)
	) {
		throw new Error("proof run id is not a UUIDv4");
	}
	const normalizedRuntimeAttestation = normalizeRuntimeAttestation(
		runtimeAttestation,
		head,
	);
	const artifact = validateArtifactCoordinates(packedArtifact);
	validateEdgeRateLimitEvidence(edgeRateLimit);
	const normalizedDeploymentId = validateDeploymentId(deploymentId);
	const compactRunId = runId.replaceAll("-", "");
	if (!Number.isSafeInteger(windowStartedAtMs) || windowStartedAtMs < 1) {
		throw new Error("proof window start is invalid");
	}
	return {
		runId,
		headSha: head,
		githubDeploymentId: normalizedDeploymentId,
		trustedOrigin: trusted.url,
		runtimeAttestation: normalizedRuntimeAttestation,
		packedTarballPath: artifact.tarballPath,
		packedTarballSha256: artifact.sha256,
		edgeRateLimit,
		plaintextScanNeedle: `RC_PLAINTEXT_SCAN_${compactRunId}`,
		logCanaries: {
			begin: `RC_RELEASE_PROOF_LOG_BEGIN_${compactRunId}`,
			end: `RC_RELEASE_PROOF_LOG_END_${compactRunId}`,
		},
		proofWindow: { startedAtMs: windowStartedAtMs },
		receiptFile: join(
			RECEIPT_ROOT,
			`real-topology-browser-leg-${head}-${compactRunId}.json`,
		),
	};
}

function copyOptionalRuntimeEnvironment(target, source) {
	for (const key of OPTIONAL_RUNTIME_ENV) {
		if (typeof source[key] === "string" && source[key] !== "")
			target[key] = source[key];
	}
}

export function buildPlaywrightEnvironment(sourceEnv, trusted, proof) {
	const bypass = requireNonBlank(
		sourceEnv.VERCEL_AUTOMATION_BYPASS_SECRET,
		"VERCEL_AUTOMATION_BYPASS_SECRET",
	);
	const home = requireNonBlank(sourceEnv.HOME, "HOME");
	if (!isAbsolute(home)) throw new Error("HOME must be absolute");
	const claudeCwd = requireNonBlank(
		sourceEnv.RC_PROVE_CLAUDE_CWD,
		"RC_PROVE_CLAUDE_CWD",
	);
	if (!isAbsolute(claudeCwd))
		throw new Error("RC_PROVE_CLAUDE_CWD must be absolute");
	const env = {
		HOME: home,
		LANG: "C.UTF-8",
		PATH: TRUSTED_PATH,
		TERM: "xterm-256color",
		WEB_E2E_URL: trusted.url,
		VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
		RC_PROVE_CLAUDE_CWD: claudeCwd,
		RC_PROOF_RUN_ID: proof.runId,
		RC_PROOF_HEAD_SHA: proof.headSha,
		RC_PROOF_GITHUB_DEPLOYMENT_ID: proof.githubDeploymentId,
		RC_PROOF_TRUSTED_ORIGIN: proof.trustedOrigin,
		RC_PROOF_ATTESTED_SHA: proof.runtimeAttestation.sha,
		RC_PROOF_ATTESTED_ENVIRONMENT: proof.runtimeAttestation.environment,
		RC_PROOF_ATTESTED_STORAGE_BACKEND: proof.runtimeAttestation.storage.backend,
		RC_PROOF_ATTESTED_STORAGE_LOCATOR: proof.runtimeAttestation.storage.locator,
		RC_PROOF_ATTESTED_TURSO_ORGANIZATION:
			proof.runtimeAttestation.storage.organization,
		RC_PROOF_ATTESTED_TURSO_GROUP: proof.runtimeAttestation.storage.group,
		RC_PROOF_ATTESTED_TURSO_SCOPE: proof.runtimeAttestation.storage.scope,
		RC_PROOF_PACKED_TARBALL_PATH: proof.packedTarballPath,
		RC_PROOF_PACKED_TARBALL_SHA256: proof.packedTarballSha256,
		RC_PROOF_WAF_CONFIG_ID: proof.edgeRateLimit.firewallConfigId,
		RC_PROOF_WAF_CONFIG_VERSION: String(
			proof.edgeRateLimit.firewallConfigVersion,
		),
		RC_PROOF_WAF_RULE_ID: proof.edgeRateLimit.ruleId,
		RC_PROOF_PLAINTEXT_SCAN_NEEDLE: proof.plaintextScanNeedle,
		RC_PROOF_LOG_CANARY_BEGIN: proof.logCanaries.begin,
		RC_PROOF_LOG_CANARY_END: proof.logCanaries.end,
		RC_PROOF_WINDOW_STARTED_AT_MS: String(proof.proofWindow.startedAtMs),
		RC_PROOF_RECEIPT_FILE: proof.receiptFile,
		RC_PROOF_OPERATOR_REPOSITORY_ROOT: REPOSITORY_ROOT,
	};
	copyOptionalRuntimeEnvironment(env, sourceEnv);
	return env;
}

export function validateReceiptDraft(receipt, proof) {
	exactKeys(
		receipt,
		[
			"browser",
			"claude",
			"edgeRateLimit",
			"githubDeploymentId",
			"headSha",
			"inspectionStatus",
			"logCanaries",
			"packedTarballSha256",
			"plaintextScanNeedle",
			"proofWindow",
			"runId",
			"runtimeAttestation",
			"schema",
			"streamRotation",
			"trustedOrigin",
		],
		"topology/browser-leg receipt",
	);
	if (
		receipt.schema !== RECEIPT_SCHEMA ||
		receipt.runId !== proof.runId ||
		receipt.headSha !== proof.headSha ||
		receipt.githubDeploymentId !== proof.githubDeploymentId ||
		receipt.trustedOrigin !== proof.trustedOrigin ||
		receipt.inspectionStatus !== "pending" ||
		receipt.plaintextScanNeedle !== proof.plaintextScanNeedle ||
		receipt.packedTarballSha256 !== proof.packedTarballSha256
	) {
		throw new Error("topology/browser-leg receipt coordinates are invalid");
	}
	exactKeys(
		receipt.logCanaries,
		["begin", "end"],
		"topology/browser-leg log canaries",
	);
	if (
		receipt.logCanaries.begin !== proof.logCanaries.begin ||
		receipt.logCanaries.end !== proof.logCanaries.end
	) {
		throw new Error("topology/browser-leg receipt log canaries are invalid");
	}
	exactKeys(
		receipt.proofWindow,
		["completedAtMs", "startedAtMs"],
		"topology/browser-leg proof window",
	);
	if (
		receipt.proofWindow.startedAtMs !== proof.proofWindow.startedAtMs ||
		receipt.proofWindow.completedAtMs !== null
	) {
		throw new Error("topology/browser-leg receipt proof window is invalid");
	}
	let receiptRuntimeAttestation;
	try {
		receiptRuntimeAttestation = normalizeRuntimeAttestation(
			receipt.runtimeAttestation,
			proof.headSha,
		);
	} catch {
		throw new Error(
			"topology/browser-leg receipt runtime attestation is invalid",
		);
	}
	if (
		receiptRuntimeAttestation.storage.organization !==
			proof.runtimeAttestation.storage.organization ||
		receiptRuntimeAttestation.storage.group !==
			proof.runtimeAttestation.storage.group ||
		receiptRuntimeAttestation.storage.scope !==
			proof.runtimeAttestation.storage.scope
	) {
		throw new Error(
			"topology/browser-leg receipt runtime attestation is invalid",
		);
	}
	validateEdgeRateLimitEvidence(receipt.edgeRateLimit);
	for (const key of Object.keys(proof.edgeRateLimit)) {
		if (receipt.edgeRateLimit[key] !== proof.edgeRateLimit[key]) {
			throw new Error(
				"topology/browser-leg receipt edge-rate-limit evidence is invalid",
			);
		}
	}
	exactKeys(
		receipt.claude,
		["arch", "binaryBytes", "executableSha256", "platform", "version"],
		"Claude receipt tuple",
	);
	if (
		receipt.claude.version !== PINNED_CLAUDE_VERSION ||
		receipt.claude.platform !== PINNED_CLAUDE_PLATFORM ||
		receipt.claude.arch !== PINNED_CLAUDE_ARCH ||
		receipt.claude.executableSha256 !== PINNED_CLAUDE_EXECUTABLE_SHA256 ||
		receipt.claude.binaryBytes !== PINNED_CLAUDE_BINARY_BYTES
	) {
		throw new Error("topology/browser-leg receipt Claude tuple is not pinned");
	}
	exactKeys(
		receipt.browser,
		["name", "project", "result", "version"],
		"browser receipt",
	);
	if (
		receipt.browser.name !== "chromium" ||
		receipt.browser.project !== "mobile-chromium" ||
		receipt.browser.result !== "assertions_passed" ||
		typeof receipt.browser.version !== "string" ||
		!/^[0-9]+(?:\.[0-9]+){1,4}$/.test(receipt.browser.version)
	) {
		throw new Error("topology/browser-leg receipt browser result is invalid");
	}
	exactKeys(
		receipt.streamRotation,
		[
			"browserObserved",
			"browserReconnected",
			"marker",
			"observedElapsedMs",
			"postRotationTurn",
			"routeRotateMs",
		],
		"stream-rotation receipt",
	);
	if (
		receipt.streamRotation.marker !== "rotate" ||
		receipt.streamRotation.routeRotateMs !== PLANNED_STREAM_ROTATION_MS ||
		!Number.isSafeInteger(receipt.streamRotation.observedElapsedMs) ||
		receipt.streamRotation.observedElapsedMs <
			MIN_OBSERVED_STREAM_ROTATION_MS ||
		receipt.streamRotation.observedElapsedMs >
			MAX_OBSERVED_STREAM_ROTATION_MS ||
		receipt.streamRotation.browserObserved !== true ||
		receipt.streamRotation.browserReconnected !== true ||
		receipt.streamRotation.postRotationTurn !== "assertions_passed"
	) {
		throw new Error("topology/browser-leg receipt stream rotation is invalid");
	}
	return receipt;
}

function sameDirectoryIdentity(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid
	);
}

function openPrivateReceiptDirectoryDescriptor(
	path,
	{ lstat = lstatSync, openFile = openSync, statFd = fstatSync } = {},
) {
	const currentUid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	let initial;
	try {
		initial = lstat(path);
	} catch {
		throw new Error("real-topology receipt root could not be inspected safely");
	}
	if (
		!initial.isDirectory() ||
		initial.isSymbolicLink() ||
		(initial.mode & 0o777) !== 0o700 ||
		(currentUid !== undefined && initial.uid !== currentUid)
	) {
		throw new Error(
			"real-topology receipt root is not a private owned directory",
		);
	}
	let descriptor;
	try {
		descriptor = openFile(
			path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const opened = statFd(descriptor);
		if (
			!opened.isDirectory() ||
			!sameDirectoryIdentity(initial, opened) ||
			(opened.mode & 0o777) !== 0o700 ||
			(currentUid !== undefined && opened.uid !== currentUid)
		) {
			throw new Error("real-topology receipt root changed while opening");
		}
		return { descriptor, opened };
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				throw new Error(
					"real-topology receipt root descriptor could not be closed",
				);
			}
		}
		if (error instanceof Error && error.message.startsWith("real-topology ")) {
			throw error;
		}
		throw new Error("real-topology receipt root could not be opened safely");
	}
}

function verifyPrivateReceiptDirectoryDescriptor(
	path,
	descriptor,
	opened,
	{ lstat = lstatSync, statFd = fstatSync } = {},
) {
	const currentUid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	const current = statFd(descriptor);
	const finalPath = lstat(path);
	if (
		!current.isDirectory() ||
		!finalPath.isDirectory() ||
		finalPath.isSymbolicLink() ||
		!sameDirectoryIdentity(opened, current) ||
		!sameDirectoryIdentity(current, finalPath) ||
		(current.mode & 0o777) !== 0o700 ||
		(finalPath.mode & 0o777) !== 0o700 ||
		(currentUid !== undefined && current.uid !== currentUid)
	) {
		throw new Error("real-topology receipt root changed while writing");
	}
}

function sameReceiptFileIdentity(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid
	);
}

function writeDurableReceiptFileWithDirectory(
	path,
	contents,
	{
		lstat = lstatSync,
		openFile = openSync,
		statFd = fstatSync,
		writeFile = writeFileSync,
		syncFd = fsyncSync,
		closeFile = closeSync,
		afterInitialDirectorySync,
	} = {},
) {
	if (
		typeof path !== "string" ||
		!isAbsolute(path) ||
		resolve(path) !== path ||
		typeof contents !== "string"
	) {
		throw new Error("real-topology receipt write coordinates are invalid");
	}
	const receiptRoot = dirname(path);
	const receiptName = basename(path);
	let directoryDescriptor;
	let openedDirectory;
	let fileDescriptor;
	let failure;
	let fileCloseFailed = false;
	let directoryCloseFailed = false;
	try {
		({ descriptor: directoryDescriptor, opened: openedDirectory } =
			openPrivateReceiptDirectoryDescriptor(receiptRoot, {
				lstat,
				openFile,
				statFd,
			}));
		fileDescriptor = openFile(
			`/proc/self/fd/${directoryDescriptor}/${receiptName}`,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		const created = statFd(fileDescriptor);
		const currentUid =
			typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			!created.isFile() ||
			created.isSymbolicLink() ||
			created.nlink !== 1 ||
			(created.mode & 0o777) !== 0o600 ||
			(currentUid !== undefined && created.uid !== currentUid)
		) {
			throw new Error("real-topology receipt file was not created safely");
		}
		writeFile(fileDescriptor, contents, { encoding: "utf8" });
		syncFd(fileDescriptor);
		const written = statFd(fileDescriptor);
		const finalPath = lstat(path);
		if (
			!written.isFile() ||
			!finalPath.isFile() ||
			finalPath.isSymbolicLink() ||
			written.nlink !== 1 ||
			finalPath.nlink !== 1 ||
			!sameReceiptFileIdentity(created, written) ||
			!sameReceiptFileIdentity(written, finalPath) ||
			(written.mode & 0o777) !== 0o600 ||
			(finalPath.mode & 0o777) !== 0o600 ||
			written.size !== Buffer.byteLength(contents, "utf8") ||
			finalPath.size !== written.size
		) {
			throw new Error("real-topology receipt file changed while writing");
		}
		closeFile(fileDescriptor);
		fileDescriptor = undefined;
		syncFd(directoryDescriptor);
		verifyPrivateReceiptDirectoryDescriptor(
			receiptRoot,
			directoryDescriptor,
			openedDirectory,
			{ lstat, statFd },
		);
		if (afterInitialDirectorySync !== undefined) {
			afterInitialDirectorySync({
				directoryDescriptor,
				openedDirectory,
				receiptName,
				written,
			});
			verifyPrivateReceiptDirectoryDescriptor(
				receiptRoot,
				directoryDescriptor,
				openedDirectory,
				{ lstat, statFd },
			);
		}
	} catch (error) {
		failure =
			error instanceof Error && error.message.startsWith("real-topology ")
				? error
				: new Error("real-topology receipt file could not be written safely");
	} finally {
		if (fileDescriptor !== undefined) {
			try {
				closeFile(fileDescriptor);
			} catch {
				fileCloseFailed = true;
			}
		}
		if (directoryDescriptor !== undefined) {
			try {
				closeFile(directoryDescriptor);
			} catch {
				directoryCloseFailed = true;
			}
		}
	}
	if (fileCloseFailed || directoryCloseFailed) {
		throw new Error("real-topology receipt descriptor could not be closed");
	}
	if (failure !== undefined) throw failure;
}

export function writeDurableReceiptFile(path, contents, options = {}) {
	writeDurableReceiptFileWithDirectory(path, contents, options);
}

export function replaceDurableReceiptFile(
	path,
	contents,
	{
		lstat = lstatSync,
		openFile = openSync,
		statFd = fstatSync,
		writeFile = writeFileSync,
		syncFd = fsyncSync,
		closeFile = closeSync,
		renameFile = renameSync,
	} = {},
) {
	if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
		throw new Error(
			"real-topology receipt replacement coordinates are invalid",
		);
	}
	const receiptName = basename(path);
	const finalPath = `${path}.final`;
	writeDurableReceiptFileWithDirectory(finalPath, contents, {
		lstat,
		openFile,
		statFd,
		writeFile,
		syncFd,
		closeFile,
		afterInitialDirectorySync({
			directoryDescriptor,
			receiptName: finalName,
			written,
		}) {
			renameFile(
				`/proc/self/fd/${directoryDescriptor}/${finalName}`,
				`/proc/self/fd/${directoryDescriptor}/${receiptName}`,
			);
			const replaced = lstat(path);
			if (
				!replaced.isFile() ||
				replaced.isSymbolicLink() ||
				replaced.nlink !== 1 ||
				!sameReceiptFileIdentity(written, replaced) ||
				(replaced.mode & 0o777) !== 0o600 ||
				replaced.size !== written.size
			) {
				throw new Error("real-topology receipt file changed while replacing");
			}
			syncFd(directoryDescriptor);
		},
	});
}

export function preparePrivateReceiptDirectory(
	path,
	{
		mkdir = mkdirSync,
		lstat = lstatSync,
		openFile = openSync,
		statFd = fstatSync,
		chmodFd = fchmodSync,
		closeFile = closeSync,
	} = {},
) {
	try {
		mkdir(path, { recursive: true, mode: 0o700 });
	} catch {
		throw new Error("real-topology receipt root could not be created safely");
	}
	const currentUid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	let initial;
	try {
		initial = lstat(path);
	} catch {
		throw new Error("real-topology receipt root could not be inspected safely");
	}
	if (
		!initial.isDirectory() ||
		initial.isSymbolicLink() ||
		(currentUid !== undefined && initial.uid !== currentUid)
	) {
		throw new Error("real-topology receipt root is not an owned directory");
	}
	let descriptor;
	let failure;
	let closeFailed = false;
	try {
		descriptor = openFile(
			path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const opened = statFd(descriptor);
		if (
			!opened.isDirectory() ||
			!sameDirectoryIdentity(initial, opened) ||
			(currentUid !== undefined && opened.uid !== currentUid)
		) {
			throw new Error("real-topology receipt root changed while opening");
		}
		chmodFd(descriptor, 0o700);
		const secured = statFd(descriptor);
		const finalPath = lstat(path);
		if (
			!secured.isDirectory() ||
			!finalPath.isDirectory() ||
			finalPath.isSymbolicLink() ||
			!sameDirectoryIdentity(opened, secured) ||
			!sameDirectoryIdentity(secured, finalPath) ||
			(secured.mode & 0o777) !== 0o700 ||
			(finalPath.mode & 0o777) !== 0o700
		) {
			throw new Error("real-topology receipt root changed while securing");
		}
	} catch (error) {
		failure =
			error instanceof Error && error.message.startsWith("real-topology ")
				? error
				: new Error("real-topology receipt root could not be secured safely");
	} finally {
		if (descriptor !== undefined) {
			try {
				closeFile(descriptor);
			} catch {
				closeFailed = true;
			}
		}
	}
	if (closeFailed) {
		throw new Error(
			"real-topology receipt root descriptor could not be closed",
		);
	}
	if (failure !== undefined) throw failure;
	return path;
}

export function finalizeReceipt(
	receiptFile,
	proof,
	completedAtMs = Date.now(),
	{ replaceReceipt = replaceDurableReceiptFile } = {},
) {
	if (receiptFile !== proof.receiptFile) {
		throw new Error(
			"topology/browser-leg receipt path is not bound to the run",
		);
	}
	const stat = lstatSync(receiptFile);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		stat.size > 16_384
	) {
		throw new Error(
			"topology/browser-leg receipt is not a small private regular file",
		);
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error("topology/browser-leg receipt is not owned by this user");
	}
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(receiptFile, "utf8"));
	} catch {
		throw new Error("topology/browser-leg receipt is invalid JSON");
	}
	const draft = validateReceiptDraft(parsed, proof);
	if (
		!Number.isSafeInteger(completedAtMs) ||
		completedAtMs < proof.proofWindow.startedAtMs ||
		completedAtMs - proof.proofWindow.startedAtMs > MAX_PROOF_WINDOW_MS
	) {
		throw new Error("topology/browser-leg proof window is invalid");
	}
	const finalReceipt = {
		...draft,
		browser: { ...draft.browser, result: "passed" },
		proofWindow: {
			startedAtMs: proof.proofWindow.startedAtMs,
			completedAtMs,
		},
	};
	replaceReceipt(receiptFile, `${JSON.stringify(finalReceipt, null, 2)}\n`);
	return finalReceipt;
}

function runPlaywright({ env, packedArtifact }) {
	validateArtifactCoordinates(packedArtifact);
	const archivedWebTestRoot = join(packedArtifact.sourceRoot, "tests", "web");
	const archivedPlaywrightCli = join(
		archivedWebTestRoot,
		"node_modules",
		"@playwright",
		"test",
		"cli.js",
	);
	const node = validateTrustedExecutable(NODE_BIN, "system Node.js");
	const playwrightCli = validateTrustedExecutable(
		archivedPlaywrightCli,
		"pinned Playwright CLI",
	);
	execFileSync(
		node,
		[playwrightCli, "test", "-c", "real-topology.prove.config.ts"],
		{ cwd: archivedWebTestRoot, env, stdio: "inherit" },
	);
}

export async function runTrustedRealTopology({
	input,
	fetchImpl = fetch,
	repositoryState = readRepositoryState,
	edgePreflight = verifyHandoffEdgeRateLimit,
	artifactBuilder = preparePinnedHeadArtifact,
	artifactCleanup = cleanupPinnedHeadArtifact,
	playwright = runPlaywright,
	canaryEmitter = emitProofLogCanary,
	receiptFinalizer = finalizeReceipt,
	newRunId = randomUUID,
	now = Date.now,
} = {}) {
	validateProofInput(input);
	requireNonBlank(
		input.VERCEL_AUTOMATION_BYPASS_SECRET,
		"VERCEL_AUTOMATION_BYPASS_SECRET",
	);
	requireNonBlank(input.VERCEL_TOKEN, "VERCEL_TOKEN");
	const state = repositoryState();
	const head = validateRepositoryState(state.headOutput, state.statusOutput);
	const trusted = await resolveManualTrustedDeployment({
		deploymentId: input.RC_DEPLOYMENT_ID,
		repository: input.GITHUB_REPOSITORY,
		token: input.GITHUB_TOKEN,
		head,
		fetchImpl,
	});
	const resolvedState = repositoryState();
	const resolvedHead = validateRepositoryState(
		resolvedState.headOutput,
		resolvedState.statusOutput,
	);
	if (resolvedHead !== head) {
		throw new Error("local HEAD changed while resolving the deployment");
	}
	const runtimeAttestation = await attestServedDeployment({
		origin: trusted.url,
		expectedSha: head,
		bypass: input.VERCEL_AUTOMATION_BYPASS_SECRET,
		fetchImpl,
	});
	const attestedState = repositoryState();
	const attestedHead = validateRepositoryState(
		attestedState.headOutput,
		attestedState.statusOutput,
	);
	if (attestedHead !== head) {
		throw new Error("local HEAD changed while attesting the served deployment");
	}
	const edgeRateLimit = await edgePreflight({
		token: input.VERCEL_TOKEN,
		fetchImpl,
	});
	let packedArtifact;
	try {
		packedArtifact = await artifactBuilder({ head });
		validateArtifactCoordinates(packedArtifact);
		const builtState = repositoryState();
		const builtHead = validateRepositoryState(
			builtState.headOutput,
			builtState.statusOutput,
		);
		if (builtHead !== head) {
			throw new Error(
				"local HEAD changed while building the pinned-HEAD CLI artifact",
			);
		}
		const windowStartedAtMs = now();
		const proof = createProofCoordinates({
			head,
			deploymentId: input.RC_DEPLOYMENT_ID,
			trusted,
			runtimeAttestation,
			packedArtifact,
			edgeRateLimit,
			runId: newRunId(),
			windowStartedAtMs,
		});
		const childEnv = buildPlaywrightEnvironment(input, trusted, proof);
		process.stdout.write(
			"trusted deployment, live handoff edge policy, and archived HEAD artifact verified; starting topology/browser leg\n",
		);
		process.stdout.write(
			`nonsecret plaintext-scan needle: ${proof.plaintextScanNeedle}\n`,
		);
		await canaryEmitter({
			origin: proof.trustedOrigin,
			bypass: input.VERCEL_AUTOMATION_BYPASS_SECRET,
			canary: proof.logCanaries.begin,
			fetchImpl,
		});
		await playwright({ env: childEnv, proof, packedArtifact });
		await canaryEmitter({
			origin: proof.trustedOrigin,
			bypass: input.VERCEL_AUTOMATION_BYPASS_SECRET,
			canary: proof.logCanaries.end,
			fetchImpl,
		});
		const receipt = receiptFinalizer(proof.receiptFile, proof, now());
		process.stdout.write(
			`topology/browser-leg receipt (plaintext inspection pending): ${proof.receiptFile}\n`,
		);
		return receipt;
	} finally {
		if (packedArtifact !== undefined) artifactCleanup(packedArtifact);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		const input = readProofBootstrapInput();
		await runTrustedRealTopology({ input });
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown failure";
		process.stderr.write(`real-topology proof refused: ${message}\n`);
		process.exitCode = 1;
	}
}
