import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateInspectionReceipt } from "./inspection-receipt-schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DEFAULT_REPOSITORY_ROOT = resolve(HERE, "..");
const MODULE_DEFAULT_RECEIPT_ROOT = join(
	MODULE_DEFAULT_REPOSITORY_ROOT,
	"tests",
	"web",
	"test-results",
);
const INSPECTION_SCHEMA = "remote-claw-real-topology-inspection/v1";
const TOPOLOGY_SCHEMA = "remote-claw-real-topology-browser-leg/v4";
const RELEASE_SCHEMA = "remote-claw-production-release-attestation/v1";
const DATA_PLANE_SCHEMA = "remote-claw-production-data-plane/v1";
const ATTESTATION_PATH = "/api/prove/deployment-attestation";
const RELAY_PATH = "/api/relay";
const FRAME_COUNT_PATH = "/api/frame-count";
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
const EXPECTED_CREATOR = "vercel[bot]";
const EXPECTED_GITHUB_ENVIRONMENT = "Production";
const EXPECTED_GITHUB_REF = "refs/heads/main";
const EXPECTED_GIT_REF = "main";
const TRUSTED_PATH = "/usr/bin:/bin";
const NODE_BIN = "/usr/bin/node";
const GIT_BIN = "/usr/bin/git";
const BOOTSTRAP_FIXED_ENVIRONMENT = {
	LANG: "C.UTF-8",
	PATH: TRUSTED_PATH,
	RC_PRODUCTION_INPUT_FD: "0",
};
const BOOTSTRAP_REPOSITORY_ROOT_FIELD = "RC_PRODUCTION_REPOSITORY_ROOT";
const PUBLISH_INPUT_FD_FIELD = "RC_PRODUCTION_PUBLISH_INPUT_FD";
const TRUSTED_GIT_CONFIG_ARGS = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"credential.helper=",
	"-c",
	"protocol.file.allow=never",
];
const PROOF_INPUT_FIELDS = [
	"GITHUB_REPOSITORY",
	"GITHUB_TOKEN",
	"RC_PRODUCTION_DEPLOYMENT_ID",
	"RC_INSPECTION_RECEIPT_FILE",
	"VERCEL_AUTOMATION_BYPASS_SECRET",
	"VERCEL_TOKEN",
];
const PUBLISH_INPUT_FIELDS = ["stagePath", "sha256", "device", "inode", "size"];
const MAX_BOOTSTRAP_INPUT_BYTES = 64 * 1_024;
const MAX_PUBLISH_INPUT_BYTES = 8 * 1_024;
const MAX_INSPECTION_RECEIPT_BYTES = 128 * 1_024;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1_024;
const MAX_RUNTIME_ATTESTATION_BYTES = 4 * 1_024;
const MAX_DATA_PLANE_RESPONSE_BYTES = 16 * 1_024;
const MAX_INSPECTION_AGE_MS = 71 * 60 * 60 * 1_000;
const MAX_INSPECTION_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const LOCAL_GIT_TIMEOUT_MS = 15_000;
const IMMUTABLE_DEPLOYMENT_ORIGIN =
	/^https:\/\/remote-claw-[a-z0-9]{9}-ejc3-7031s-projects\.vercel\.app$/;

function refusal(message) {
	return new Error(message);
}

function requireNonBlank(value, name) {
	if (typeof value !== "string" || value.trim() === "") {
		throw refusal(`${name} is required`);
	}
	return value;
}

function exactKeys(value, expected, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw refusal(`${label} is not an object`);
	}
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw refusal(`${label} contains unexpected fields`);
	}
}

function fullSha(value, label) {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
		throw refusal(`${label} is not a full lowercase commit digest`);
	}
	return value;
}

function fullTree(value, label) {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
		throw refusal(`${label} is not a full lowercase tree digest`);
	}
	return value;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function storageCoordinate(value, label) {
	const coordinate = requireNonBlank(value, label);
	if (
		coordinate !== coordinate.trim() ||
		!/^[A-Za-z0-9._-]+$/.test(coordinate) ||
		Buffer.byteLength(coordinate, "utf8") > 256
	) {
		throw refusal(`${label} is invalid`);
	}
	return coordinate;
}

function numericDeploymentId(value, label = "RC_PRODUCTION_DEPLOYMENT_ID") {
	const deploymentId = requireNonBlank(value, label).trim();
	if (deploymentId !== value || !/^[1-9][0-9]*$/.test(deploymentId)) {
		throw refusal(`${label} is invalid`);
	}
	return deploymentId;
}

function repositoryCoordinate(value) {
	const repository = requireNonBlank(value, "GITHUB_REPOSITORY").trim();
	if (
		repository !== value ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
	) {
		throw refusal("GITHUB_REPOSITORY is invalid");
	}
	return repository;
}

function ownString(value, key) {
	return value !== null &&
		typeof value === "object" &&
		typeof value[key] === "string"
		? value[key]
		: "";
}

function canonicalIso(value, label) {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		throw refusal(`${label} is not a canonical UTC timestamp`);
	}
	return value;
}

export function assertFreshInspection(
	inspection,
	verifiedAt,
	{
		maxAgeMs = MAX_INSPECTION_AGE_MS,
		futureSkewMs = MAX_INSPECTION_FUTURE_SKEW_MS,
	} = {},
) {
	const completedAt = canonicalIso(
		inspection?.receipt?.inspection?.completedAt,
		"inspection completion time",
	);
	const checkedAt = canonicalIso(verifiedAt, "production verification time");
	const completedAtMs = Date.parse(completedAt);
	const checkedAtMs = Date.parse(checkedAt);
	if (
		!Number.isSafeInteger(maxAgeMs) ||
		maxAgeMs < 1 ||
		!Number.isSafeInteger(futureSkewMs) ||
		futureSkewMs < 0
	) {
		throw refusal("inspection freshness policy is invalid");
	}
	if (completedAtMs > checkedAtMs + futureSkewMs) {
		throw refusal("inspection receipt is from the future");
	}
	if (checkedAtMs - completedAtMs > maxAgeMs) {
		throw refusal("inspection receipt is too old for Production release");
	}
	return completedAt;
}

export function validateTrustedExecutable(path, label) {
	let resolvedPath;
	let stat;
	try {
		resolvedPath = realpathSync(path);
		stat = lstatSync(resolvedPath);
	} catch {
		throw refusal(`${label} is not an available trusted executable`);
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
		throw refusal(`${label} is not an available trusted executable`);
	}
	return resolvedPath;
}

export function validateBootstrapEnvironment(environment) {
	exactKeys(
		environment,
		[
			...Object.keys(BOOTSTRAP_FIXED_ENVIRONMENT),
			BOOTSTRAP_REPOSITORY_ROOT_FIELD,
		],
		"production verifier bootstrap environment",
	);
	for (const [key, value] of Object.entries(BOOTSTRAP_FIXED_ENVIRONMENT)) {
		if (environment[key] !== value) {
			throw refusal("production verifier bootstrap environment is not exact");
		}
	}
	const repositoryRoot = requireNonBlank(
		environment[BOOTSTRAP_REPOSITORY_ROOT_FIELD],
		BOOTSTRAP_REPOSITORY_ROOT_FIELD,
	);
	if (!isAbsolute(repositoryRoot)) {
		throw refusal("production verifier bootstrap repository is not absolute");
	}
	let canonicalRoot;
	try {
		canonicalRoot = realpathSync(repositoryRoot);
	} catch {
		throw refusal("production verifier bootstrap repository is unavailable");
	}
	if (canonicalRoot !== repositoryRoot) {
		throw refusal("production verifier bootstrap repository is not canonical");
	}
	const trustedNode = validateTrustedExecutable(NODE_BIN, "system Node.js");
	if (realpathSync(process.execPath) !== trustedNode) {
		throw refusal(
			"production verifier was not launched by the trusted system Node.js",
		);
	}
	return canonicalRoot;
}

export function validatePublishBootstrapEnvironment(environment) {
	exactKeys(
		environment,
		["LANG", "PATH", PUBLISH_INPUT_FD_FIELD, BOOTSTRAP_REPOSITORY_ROOT_FIELD],
		"production receipt publisher environment",
	);
	if (
		environment.LANG !== "C.UTF-8" ||
		environment.PATH !== TRUSTED_PATH ||
		environment[PUBLISH_INPUT_FD_FIELD] !== "0"
	) {
		throw refusal("production receipt publisher environment is not exact");
	}
	const repositoryRoot = requireNonBlank(
		environment[BOOTSTRAP_REPOSITORY_ROOT_FIELD],
		BOOTSTRAP_REPOSITORY_ROOT_FIELD,
	);
	if (!isAbsolute(repositoryRoot)) {
		throw refusal("production receipt publisher repository is not absolute");
	}
	let canonicalRoot;
	try {
		canonicalRoot = realpathSync(repositoryRoot);
	} catch {
		throw refusal("production receipt publisher repository is unavailable");
	}
	if (canonicalRoot !== repositoryRoot) {
		throw refusal("production receipt publisher repository is not canonical");
	}
	const trustedNode = validateTrustedExecutable(NODE_BIN, "system Node.js");
	if (realpathSync(process.execPath) !== trustedNode) {
		throw refusal(
			"production receipt publisher was not launched by the trusted system Node.js",
		);
	}
	return canonicalRoot;
}

export function validateProofInput(input) {
	exactKeys(input, PROOF_INPUT_FIELDS, "production verifier private input");
	for (const field of PROOF_INPUT_FIELDS) requireNonBlank(input[field], field);
	repositoryCoordinate(input.GITHUB_REPOSITORY);
	numericDeploymentId(input.RC_PRODUCTION_DEPLOYMENT_ID);
	if (
		!isAbsolute(input.RC_INSPECTION_RECEIPT_FILE) ||
		resolve(input.RC_INSPECTION_RECEIPT_FILE) !==
			input.RC_INSPECTION_RECEIPT_FILE
	) {
		throw refusal(
			"RC_INSPECTION_RECEIPT_FILE must be an absolute canonical path",
		);
	}
	return input;
}

export function readProofBootstrapInput({
	environment = process.env,
	fd = 0,
	read = readSync,
	statFd = fstatSync,
} = {}) {
	validateBootstrapEnvironment(environment);
	if (fd !== 0 || environment.RC_PRODUCTION_INPUT_FD !== String(fd)) {
		throw refusal(
			"production verifier bootstrap input descriptor is not pinned",
		);
	}
	let descriptorStat;
	try {
		descriptorStat = statFd(fd);
	} catch {
		throw refusal(
			"production verifier bootstrap input descriptor is unavailable",
		);
	}
	if (!descriptorStat.isFIFO()) {
		throw refusal(
			"production verifier bootstrap input descriptor is not a pipe",
		);
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
			throw refusal("production verifier bootstrap input could not be read");
		}
		if (
			!Number.isInteger(bytesRead) ||
			bytesRead < 0 ||
			bytesRead > buffer.length
		) {
			throw refusal("production verifier bootstrap input read was invalid");
		}
		if (bytesRead === 0) break;
		totalBytes += bytesRead;
		if (totalBytes > MAX_BOOTSTRAP_INPUT_BYTES) {
			throw refusal("production verifier bootstrap input is oversized");
		}
		chunks.push(buffer.subarray(0, bytesRead));
	}
	const raw = Buffer.concat(chunks, totalBytes);
	try {
		if (raw.length === 0 || raw.at(-1) !== 0) {
			throw refusal("production verifier bootstrap input is incomplete");
		}
		const fields = [];
		let start = 0;
		for (let index = 0; index < raw.length; index += 1) {
			if (raw[index] !== 0) continue;
			let value;
			try {
				value = new TextDecoder("utf-8", { fatal: true }).decode(
					raw.subarray(start, index),
				);
			} catch {
				throw refusal("production verifier bootstrap input is not valid UTF-8");
			}
			fields.push(value);
			start = index + 1;
		}
		if (start !== raw.length || fields.length !== PROOF_INPUT_FIELDS.length) {
			throw refusal(
				"production verifier bootstrap input field count is invalid",
			);
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

export function readPublishBootstrapInput({
	environment = process.env,
	fd = 0,
	read = readSync,
	statFd = fstatSync,
} = {}) {
	validatePublishBootstrapEnvironment(environment);
	if (fd !== 0 || environment[PUBLISH_INPUT_FD_FIELD] !== String(fd)) {
		throw refusal(
			"production receipt publisher input descriptor is not pinned",
		);
	}
	let descriptorStat;
	try {
		descriptorStat = statFd(fd);
	} catch {
		throw refusal("production receipt publisher input is unavailable");
	}
	if (!descriptorStat.isFIFO()) {
		throw refusal("production receipt publisher input is not a pipe");
	}
	const chunks = [];
	let totalBytes = 0;
	while (true) {
		const buffer = Buffer.alloc(
			Math.min(4_096, MAX_PUBLISH_INPUT_BYTES + 1 - totalBytes),
		);
		let bytesRead;
		try {
			bytesRead = read(fd, buffer, 0, buffer.length, null);
		} catch {
			throw refusal("production receipt publisher input could not be read");
		}
		if (
			!Number.isInteger(bytesRead) ||
			bytesRead < 0 ||
			bytesRead > buffer.length
		) {
			throw refusal("production receipt publisher input read was invalid");
		}
		if (bytesRead === 0) break;
		totalBytes += bytesRead;
		if (totalBytes > MAX_PUBLISH_INPUT_BYTES) {
			throw refusal("production receipt publisher input is oversized");
		}
		chunks.push(buffer.subarray(0, bytesRead));
	}
	const raw = Buffer.concat(chunks, totalBytes);
	try {
		if (raw.length < 2 || raw.at(-1) !== 0) {
			throw refusal("production receipt publisher input is malformed");
		}
		const fields = [];
		let start = 0;
		for (let index = 0; index < raw.length; index += 1) {
			if (raw[index] !== 0) continue;
			try {
				fields.push(
					new TextDecoder("utf-8", { fatal: true }).decode(
						raw.subarray(start, index),
					),
				);
			} catch {
				throw refusal("production receipt publisher input is not valid UTF-8");
			}
			start = index + 1;
		}
		if (start !== raw.length || fields.length !== PUBLISH_INPUT_FIELDS.length) {
			throw refusal("production receipt publisher input is malformed");
		}
		const binding = Object.freeze(
			Object.fromEntries(
				PUBLISH_INPUT_FIELDS.map((name, index) => [name, fields[index]]),
			),
		);
		const { stagePath } = binding;
		if (!isAbsolute(stagePath) || resolve(stagePath) !== stagePath) {
			throw refusal(
				"production receipt publisher staging path is not canonical",
			);
		}
		if (
			!/^[0-9a-f]{64}$/.test(binding.sha256) ||
			![binding.device, binding.inode].every((value) =>
				/^(?:0|[1-9][0-9]*)$/.test(value),
			) ||
			!/^[1-9][0-9]*$/.test(binding.size)
		) {
			throw refusal("production receipt publisher binding is invalid");
		}
		return binding;
	} finally {
		raw.fill(0);
		for (const chunk of chunks) chunk.fill(0);
	}
}

function sameFile(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function validatePrivateReceiptStat(stat) {
	const currentUid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!stat.isFile() ||
		stat.isSymbolicLink?.() ||
		(stat.mode & 0o777) !== 0o600 ||
		stat.size < 1 ||
		stat.size > MAX_INSPECTION_RECEIPT_BYTES ||
		stat.nlink !== 1 ||
		(currentUid !== undefined && stat.uid !== currentUid)
	) {
		throw refusal(
			"inspection receipt is not an owned 0600 bounded regular file",
		);
	}
}

function validatePrivateReceiptDirectory(stat) {
	const currentUid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink?.() ||
		(stat.mode & 0o777) !== 0o700 ||
		(currentUid !== undefined && stat.uid !== currentUid)
	) {
		throw refusal("production receipt directory is not owned private storage");
	}
}

function validateInspectionCoordinates(receipt, path) {
	if (
		receipt.schema !== INSPECTION_SCHEMA ||
		receipt.result !== "passed" ||
		receipt.topology?.schema !== TOPOLOGY_SCHEMA
	) {
		throw refusal("inspection receipt schema/result is not release-eligible");
	}
	const candidateSha = fullSha(
		receipt.topology.headSha,
		"inspection candidate SHA",
	);
	const runId = requireNonBlank(receipt.topology.runId, "inspection run id");
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			runId,
		)
	) {
		throw refusal("inspection run id is invalid");
	}
	const expectedName = `real-topology-browser-leg-${candidateSha}-${runId.replaceAll(
		"-",
		"",
	)}.inspection-v1.json`;
	if (basename(path) !== expectedName) {
		throw refusal(
			"inspection receipt filename is not bound to its topology run",
		);
	}
	if (
		receipt.vercel.teamId !== VERCEL_TEAM_ID ||
		receipt.vercel.projectId !== VERCEL_PROJECT_ID
	) {
		throw refusal("inspection receipt Vercel coordinates are not pinned");
	}
	const organization = storageCoordinate(
		receipt.turso.organization,
		"inspection Turso organization",
	);
	const group = storageCoordinate(
		receipt.turso.group,
		"inspection Turso group",
	);
	const expectedScope = `pr-${candidateSha.slice(0, 7)}`;
	if (
		receipt.turso.scope !== expectedScope ||
		receipt.turso.databasePrefix !== `rc-${expectedScope}-`
	) {
		throw refusal("inspection receipt Turso scope is not candidate-bound");
	}
	return { candidateSha, organization, group };
}

export function readInspectionReceipt(
	path,
	{
		receiptRoot = MODULE_DEFAULT_RECEIPT_ROOT,
		openFile = openSync,
		statFd = fstatSync,
		readFile = readFileSync,
		closeFile = closeSync,
		statPath = lstatSync,
		realpath = realpathSync,
	} = {},
) {
	if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
		throw refusal("inspection receipt path is not absolute and canonical");
	}
	let root;
	let parent;
	try {
		root = realpath(receiptRoot);
		parent = realpath(dirname(path));
	} catch {
		throw refusal("inspection receipt directory is unavailable");
	}
	if (parent !== root) {
		throw refusal("inspection receipt is outside tests/web/test-results");
	}
	try {
		if (realpath(path) !== path) {
			throw refusal("inspection receipt path is not canonical");
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("inspection ")) {
			throw error;
		}
		throw refusal("inspection receipt is unavailable");
	}
	let pathStat;
	let descriptor;
	try {
		pathStat = statPath(path);
		validatePrivateReceiptStat(pathStat);
		descriptor = openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const descriptorStat = statFd(descriptor);
		validatePrivateReceiptStat(descriptorStat);
		if (!sameFile(pathStat, descriptorStat)) {
			throw refusal("inspection receipt changed while opening");
		}
		const bytes = readFile(descriptor);
		if (!Buffer.isBuffer(bytes) || bytes.length !== descriptorStat.size) {
			throw refusal("inspection receipt could not be read exactly");
		}
		const afterStat = statPath(path);
		if (!sameFile(descriptorStat, afterStat)) {
			throw refusal("inspection receipt changed while reading");
		}
		if (realpath(path) !== path) {
			throw refusal("inspection receipt path changed while reading");
		}
		try {
			closeFile(descriptor);
			descriptor = undefined;
		} catch {
			throw refusal("inspection receipt descriptor could not be closed");
		}
		let parsed;
		try {
			parsed = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw refusal("inspection receipt is not valid JSON");
		}
		let receipt;
		try {
			receipt = validateInspectionReceipt(parsed);
		} catch {
			throw refusal("inspection receipt validation failed");
		}
		const coordinates = validateInspectionCoordinates(receipt, path);
		return {
			path,
			file: basename(path),
			sha256: sha256(bytes),
			receipt,
			...coordinates,
		};
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("inspection ")) {
			throw error;
		}
		throw refusal("inspection receipt could not be opened safely");
	} finally {
		if (descriptor !== undefined) {
			try {
				closeFile(descriptor);
			} catch {
				// A close failure cannot authorize a release.
			}
		}
	}
}

function gitOutput(
	execFile,
	git,
	args,
	cwd,
	stdio = ["ignore", "pipe", "ignore"],
) {
	return execFile(git, [...TRUSTED_GIT_CONFIG_ARGS, ...args], {
		cwd,
		encoding: "utf8",
		env: {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
			LANG: "C.UTF-8",
			PATH: TRUSTED_PATH,
		},
		maxBuffer: 1024 * 1_024,
		stdio,
		timeout: LOCAL_GIT_TIMEOUT_MS,
	});
}

export function inspectLocalReleaseState({
	candidateSha,
	cwd = MODULE_DEFAULT_REPOSITORY_ROOT,
	execFile = execFileSync,
	pathExists = existsSync,
} = {}) {
	fullSha(candidateSha, "candidate SHA");
	const git = validateTrustedExecutable(GIT_BIN, "system git");
	let repositoryRoot;
	let head;
	let status;
	let candidateTree;
	let productionTree;
	let finalHead;
	let finalStatus;
	try {
		repositoryRoot = realpathSync(cwd);
		if (
			!isAbsolute(cwd) ||
			resolve(cwd) !== cwd ||
			repositoryRoot !== cwd ||
			String(
				gitOutput(execFile, git, ["rev-parse", "--show-toplevel"], cwd),
			).trim() !== repositoryRoot
		) {
			throw refusal("local release repository root is not exact");
		}
		const replaceRefs = String(
			gitOutput(
				execFile,
				git,
				["for-each-ref", "--format=%(refname)", "refs/replace"],
				cwd,
			),
		).trim();
		const commonDirectory = String(
			gitOutput(
				execFile,
				git,
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				cwd,
			),
		).trim();
		if (
			replaceRefs !== "" ||
			!isAbsolute(commonDirectory) ||
			resolve(commonDirectory) !== commonDirectory ||
			pathExists(join(commonDirectory, "info", "grafts"))
		) {
			throw refusal("local Git ancestry has replacement or graft metadata");
		}
		head = String(
			gitOutput(execFile, git, ["rev-parse", "--verify", "HEAD"], cwd),
		)
			.trim()
			.toLowerCase();
		status = String(
			gitOutput(
				execFile,
				git,
				["status", "--porcelain=v1", "--untracked-files=all"],
				cwd,
			),
		);
		fullSha(head, "local HEAD");
		gitOutput(
			execFile,
			git,
			["merge-base", "--is-ancestor", candidateSha, head],
			cwd,
			"ignore",
		);
		candidateTree = String(
			gitOutput(execFile, git, ["rev-parse", `${candidateSha}^{tree}`], cwd),
		)
			.trim()
			.toLowerCase();
		productionTree = String(
			gitOutput(execFile, git, ["rev-parse", `${head}^{tree}`], cwd),
		)
			.trim()
			.toLowerCase();
		finalHead = String(
			gitOutput(execFile, git, ["rev-parse", "--verify", "HEAD"], cwd),
		)
			.trim()
			.toLowerCase();
		finalStatus = String(
			gitOutput(
				execFile,
				git,
				["status", "--porcelain=v1", "--untracked-files=all"],
				cwd,
			),
		);
	} catch {
		throw refusal(
			"local candidate ancestry and release-tree inspection did not succeed",
		);
	}
	if (status !== "" || finalStatus !== "" || finalHead !== head) {
		throw refusal(
			"production verification requires a clean committed local HEAD",
		);
	}
	fullTree(candidateTree, "local candidate tree");
	fullTree(productionTree, "local production tree");
	if (candidateTree !== productionTree) {
		throw refusal("local candidate and production trees do not match");
	}
	return { headSha: head, candidateTree, productionTree };
}

async function boundedJson(response, label, maximumBytes) {
	let text;
	try {
		text = await response.text();
	} catch {
		throw refusal(`${label} response could not be read`);
	}
	if (Buffer.byteLength(text, "utf8") > maximumBytes) {
		throw refusal(`${label} response is oversized`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw refusal(`${label} response is invalid JSON`);
	}
}

async function providerJson({
	url,
	token,
	label,
	fetchImpl,
	headers = {},
	maximumBytes = MAX_PROVIDER_RESPONSE_BYTES,
}) {
	let response;
	try {
		response = await fetchImpl(url, {
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers: {
				accept: "application/json",
				authorization: `Bearer ${token}`,
				...headers,
			},
		});
	} catch {
		throw refusal(`${label} request failed`);
	}
	if (!response.ok) {
		throw refusal(`${label} failed with HTTP ${response.status}`);
	}
	return boundedJson(response, label, maximumBytes);
}

async function githubJson(path, repository, token, fetchImpl, label) {
	return providerJson({
		url: `https://api.github.com/repos/${repository}${path}`,
		token,
		label,
		fetchImpl,
		headers: {
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		},
	});
}

export function validateImmutableProductionOrigin(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw refusal("production deployment URL is not a valid absolute URL");
	}
	if (
		!IMMUTABLE_DEPLOYMENT_ORIGIN.test(rawUrl) ||
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.origin !== rawUrl
	) {
		throw refusal(
			"production deployment URL is not an immutable pinned Vercel origin",
		);
	}
	return url.origin;
}

export function validateGithubMainRef(ref, expectedHead) {
	fullSha(expectedHead, "expected production HEAD");
	if (
		ref?.ref !== EXPECTED_GITHUB_REF ||
		ref.object?.type !== "commit" ||
		ownString(ref.object, "sha").toLowerCase() !== expectedHead
	) {
		throw refusal("GitHub refs/heads/main is not the local production HEAD");
	}
	return expectedHead;
}

export function validateNewestGithubProductionDeployment(
	deployments,
	{ deploymentId, expectedHead },
) {
	const normalizedDeploymentId = numericDeploymentId(
		deploymentId,
		"production GitHub deployment id",
	);
	fullSha(expectedHead, "expected production HEAD");
	if (!Array.isArray(deployments) || deployments.length < 1) {
		throw refusal("GitHub has no newest Production deployment");
	}
	const newest = deployments[0];
	if (
		String(newest?.id) !== normalizedDeploymentId ||
		ownString(newest, "sha").toLowerCase() !== expectedHead ||
		newest?.environment !== EXPECTED_GITHUB_ENVIRONMENT ||
		ownString(newest?.creator, "login") !== EXPECTED_CREATOR
	) {
		throw refusal(
			"supplied GitHub deployment is not the newest pinned Production deployment",
		);
	}
	return normalizedDeploymentId;
}

function githubCommitTree(commit, expectedSha, label) {
	if (ownString(commit, "sha").toLowerCase() !== expectedSha || !commit?.tree) {
		throw refusal(`${label} GitHub commit is not exact`);
	}
	return fullTree(
		ownString(commit.tree, "sha").toLowerCase(),
		`${label} GitHub tree`,
	);
}

export function validateGithubCandidateAncestry(
	comparison,
	{ candidateSha, productionSha },
) {
	fullSha(candidateSha, "candidate SHA");
	fullSha(productionSha, "production SHA");
	const aheadBy = comparison?.ahead_by;
	const behindBy = comparison?.behind_by;
	const sameCommit = candidateSha === productionSha;
	if (
		ownString(comparison?.base_commit, "sha").toLowerCase() !== candidateSha ||
		ownString(comparison?.merge_base_commit, "sha").toLowerCase() !==
			candidateSha ||
		!Number.isSafeInteger(aheadBy) ||
		!Number.isSafeInteger(behindBy) ||
		aheadBy < 0 ||
		behindBy !== 0 ||
		(sameCommit
			? comparison?.status !== "identical" || aheadBy !== 0
			: comparison?.status !== "ahead" || aheadBy < 1)
	) {
		throw refusal("GitHub does not prove candidate ancestry of Production");
	}
	return true;
}

export function validateNewestGithubProductionStatus(
	statuses,
	{ expectedOrigin } = {},
) {
	if (!Array.isArray(statuses) || statuses.length < 1) {
		throw refusal("GitHub Production deployment has no authoritative status");
	}
	// GitHub documents deployment-status lists as newest-first; never fall back to an older success.
	const status = statuses[0];
	if (
		status?.state !== "success" ||
		status?.environment !== EXPECTED_GITHUB_ENVIRONMENT ||
		ownString(status?.creator, "login") !== EXPECTED_CREATOR
	) {
		throw refusal(
			"GitHub Production deployment newest status is not successful Vercel production",
		);
	}
	const origin = validateImmutableProductionOrigin(
		ownString(status, "environment_url"),
	);
	if (expectedOrigin !== undefined && origin !== expectedOrigin) {
		throw refusal(
			"GitHub Production deployment origin changed during verification",
		);
	}
	return origin;
}

export function validateGithubProductionDeployment({
	productionDeployments,
	deployment,
	statuses,
	mainRef,
	candidateCommit,
	productionCommit,
	comparison,
	deploymentId,
	expectedHead,
	candidateSha,
	localCandidateTree,
	localProductionTree,
}) {
	fullSha(expectedHead, "expected production HEAD");
	fullSha(candidateSha, "candidate SHA");
	fullTree(localCandidateTree, "local candidate tree");
	fullTree(localProductionTree, "local production tree");
	const normalizedDeploymentId = numericDeploymentId(
		deploymentId,
		"production GitHub deployment id",
	);
	validateNewestGithubProductionDeployment(productionDeployments, {
		deploymentId: normalizedDeploymentId,
		expectedHead,
	});
	if (
		String(deployment?.id) !== normalizedDeploymentId ||
		deployment?.environment !== EXPECTED_GITHUB_ENVIRONMENT ||
		ownString(deployment?.creator, "login") !== EXPECTED_CREATOR ||
		ownString(deployment, "sha").toLowerCase() !== expectedHead
	) {
		throw refusal("GitHub Production deployment is not pinned to local HEAD");
	}
	const origin = validateNewestGithubProductionStatus(statuses);
	validateGithubMainRef(mainRef, expectedHead);
	validateGithubCandidateAncestry(comparison, {
		candidateSha,
		productionSha: expectedHead,
	});
	const githubCandidateTree = githubCommitTree(
		candidateCommit,
		candidateSha,
		"candidate",
	);
	const githubProductionTree = githubCommitTree(
		productionCommit,
		expectedHead,
		"production",
	);
	if (
		githubCandidateTree !== githubProductionTree ||
		githubCandidateTree !== localCandidateTree ||
		githubProductionTree !== localProductionTree
	) {
		throw refusal("GitHub and local candidate/production trees do not match");
	}
	return {
		deploymentId: normalizedDeploymentId,
		headSha: expectedHead,
		origin,
		candidateTree: githubCandidateTree,
		productionTree: githubProductionTree,
	};
}

export async function resolveGithubProduction({
	repository,
	token,
	deploymentId,
	expectedHead,
	candidateSha,
	localCandidateTree,
	localProductionTree,
	fetchImpl = fetch,
}) {
	const normalizedRepository = repositoryCoordinate(repository);
	const githubToken = requireNonBlank(token, "GITHUB_TOKEN");
	const normalizedDeploymentId = numericDeploymentId(deploymentId);
	fullSha(expectedHead, "expected production HEAD");
	fullSha(candidateSha, "candidate SHA");
	const productionDeployments = await githubJson(
		"/deployments?environment=Production&per_page=100",
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub newest Production deployment lookup",
	);
	const deployment = await githubJson(
		`/deployments/${normalizedDeploymentId}`,
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub Production deployment lookup",
	);
	const statuses = await githubJson(
		`/deployments/${normalizedDeploymentId}/statuses?per_page=100`,
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub Production deployment status lookup",
	);
	const mainRef = await githubJson(
		"/git/ref/heads/main",
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub main ref lookup",
	);
	const candidateCommit = await githubJson(
		`/git/commits/${candidateSha}`,
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub candidate commit lookup",
	);
	const productionCommit = await githubJson(
		`/git/commits/${expectedHead}`,
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub production commit lookup",
	);
	const comparison = await githubJson(
		`/compare/${candidateSha}...${expectedHead}`,
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub candidate ancestry lookup",
	);
	return validateGithubProductionDeployment({
		productionDeployments,
		deployment,
		statuses,
		mainRef,
		candidateCommit,
		productionCommit,
		comparison,
		deploymentId: normalizedDeploymentId,
		expectedHead,
		candidateSha,
		localCandidateTree,
		localProductionTree,
	});
}

export async function resolveGithubMainHead({
	repository,
	token,
	expectedHead,
	deploymentId,
	expectedOrigin,
	fetchImpl = fetch,
}) {
	const normalizedRepository = repositoryCoordinate(repository);
	const githubToken = requireNonBlank(token, "GITHUB_TOKEN");
	const productionDeployments = await githubJson(
		"/deployments?environment=Production&per_page=100",
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub final newest Production deployment lookup",
	);
	validateNewestGithubProductionDeployment(productionDeployments, {
		deploymentId,
		expectedHead,
	});
	const statuses = await githubJson(
		`/deployments/${numericDeploymentId(
			deploymentId,
			"production GitHub deployment id",
		)}/statuses?per_page=100`,
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub final Production deployment status lookup",
	);
	validateNewestGithubProductionStatus(statuses, { expectedOrigin });
	const ref = await githubJson(
		"/git/ref/heads/main",
		normalizedRepository,
		githubToken,
		fetchImpl,
		"GitHub final main ref lookup",
	);
	return validateGithubMainRef(ref, expectedHead);
}

export function validateVercelProductionDeployment(
	deployment,
	{ origin, expectedHead, requestTeamId = VERCEL_TEAM_ID },
) {
	const pinnedOrigin = validateImmutableProductionOrigin(origin);
	fullSha(expectedHead, "expected production HEAD");
	const hostname = new URL(pinnedOrigin).hostname;
	const id = ownString(deployment, "id");
	const resolvedProjectId = deployment.projectId ?? deployment.project?.id;
	if (
		!/^dpl_[A-Za-z0-9]+$/.test(id) ||
		ownString(deployment, "url") !== hostname ||
		ownString(deployment, "ownerId") !== VERCEL_TEAM_ID ||
		requestTeamId !== VERCEL_TEAM_ID ||
		(deployment.teamId !== undefined &&
			ownString(deployment, "teamId") !== VERCEL_TEAM_ID) ||
		resolvedProjectId !== VERCEL_PROJECT_ID ||
		(deployment.projectId !== undefined &&
			deployment.projectId !== VERCEL_PROJECT_ID) ||
		deployment?.readyState !== "READY" ||
		deployment?.status !== "READY" ||
		(deployment.project?.id !== undefined &&
			deployment.project.id !== VERCEL_PROJECT_ID) ||
		deployment?.target !== "production"
	) {
		throw refusal(
			"Vercel production deployment coordinates/state are not pinned",
		);
	}
	if (
		ownString(deployment?.meta, "githubCommitSha").toLowerCase() !==
			expectedHead ||
		ownString(deployment?.meta, "githubCommitRef") !== EXPECTED_GIT_REF ||
		ownString(deployment?.gitSource, "sha").toLowerCase() !== expectedHead ||
		ownString(deployment?.gitSource, "ref") !== EXPECTED_GIT_REF ||
		ownString(deployment?.gitSource, "type") !== "github"
	) {
		throw refusal(
			"Vercel production deployment git metadata is not exact main",
		);
	}
	return {
		deploymentId: id,
		origin: pinnedOrigin,
		ownerId: VERCEL_TEAM_ID,
		projectId: VERCEL_PROJECT_ID,
		teamId: VERCEL_TEAM_ID,
		readyState: "READY",
		status: "READY",
		target: "production",
	};
}

export async function resolveVercelProduction({
	origin,
	expectedHead,
	token,
	fetchImpl = fetch,
}) {
	const pinnedOrigin = validateImmutableProductionOrigin(origin);
	const vercelToken = requireNonBlank(token, "VERCEL_TOKEN");
	const hostname = new URL(pinnedOrigin).hostname;
	const query = `withGitRepoInfo=true&teamId=${encodeURIComponent(
		VERCEL_TEAM_ID,
	)}`;
	const deployment = await providerJson({
		url: `${VERCEL_API_ORIGIN}/v13/deployments/${encodeURIComponent(
			hostname,
		)}?${query}`,
		token: vercelToken,
		label: "Vercel production deployment lookup",
		fetchImpl,
	});
	return validateVercelProductionDeployment(deployment, {
		origin: pinnedOrigin,
		expectedHead,
	});
}

function normalizedProductionFirewallAttestation() {
	return {
		schema: "remote-claw-production-firewall/v1",
		result: "passed",
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

export function validateProductionFirewallAttestation(attestation) {
	const expected = normalizedProductionFirewallAttestation();
	exactKeys(
		attestation,
		Object.keys(expected),
		"production firewall attestation",
	);
	for (const [key, value] of Object.entries(expected)) {
		if (attestation[key] !== value) {
			throw refusal(
				"production firewall attestation is not the pinned live policy",
			);
		}
	}
	return attestation;
}

export async function attestProductionFirewall({ token, fetchImpl = fetch }) {
	const vercelToken = requireNonBlank(token, "VERCEL_TOKEN");
	const query = `projectId=${encodeURIComponent(
		VERCEL_PROJECT_ID,
	)}&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
	const config = await providerJson({
		url: `${VERCEL_API_ORIGIN}/v1/security/firewall/config?${query}`,
		token: vercelToken,
		label: "Vercel production firewall config",
		fetchImpl,
	});
	const bypass = await providerJson({
		url: `${VERCEL_API_ORIGIN}/v1/security/firewall/bypass?${query}`,
		token: vercelToken,
		label: "Vercel production firewall bypass list",
		fetchImpl,
	});
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
			throw refusal("Vercel firewall config is not live");
		}
		const active = config.active;
		if (
			active === null ||
			typeof active !== "object" ||
			Array.isArray(active)
		) {
			throw refusal("Vercel firewall active config is not pinned");
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
				throw refusal("Vercel firewall managed rules are not pinned");
			}
		}
		canonicalIso(active.updatedAt, "Vercel firewall updatedAt");
		if (
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
			throw refusal("Vercel firewall active config is not pinned");
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
			throw refusal("Vercel firewall rule is not pinned");
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
			throw refusal("Vercel firewall mitigation is not pinned");
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
			throw refusal("Vercel firewall rate limit is not pinned");
		}
		if (
			!Array.isArray(rule.conditionGroup) ||
			rule.conditionGroup.length !== 1
		) {
			throw refusal("Vercel firewall condition is not pinned");
		}
		const group = rule.conditionGroup[0];
		exactKeys(group, ["conditions"], "Vercel firewall condition group");
		if (!Array.isArray(group.conditions) || group.conditions.length !== 1) {
			throw refusal("Vercel firewall condition is not pinned");
		}
		const condition = group.conditions[0];
		exactKeys(condition, ["op", "type", "value"], "Vercel firewall condition");
		if (
			condition.type !== "path" ||
			condition.op !== "pre" ||
			condition.value !== "/api/handoff"
		) {
			throw refusal("Vercel firewall condition is not pinned");
		}
		exactKeys(bypass, ["result"], "Vercel firewall bypass list");
		if (!Array.isArray(bypass.result) || bypass.result.length !== 0) {
			throw refusal("Vercel firewall bypass list is not empty");
		}
	} catch {
		throw refusal("Vercel production firewall is not the pinned live policy");
	}
	return normalizedProductionFirewallAttestation();
}

export function normalizeProductionRuntimeAttestation(
	attestation,
	{ expectedHead, organization, group },
) {
	exactKeys(
		attestation,
		["environment", "sha", "storage"],
		"production runtime attestation",
	);
	fullSha(expectedHead, "expected production HEAD");
	if (
		attestation.environment !== "production" ||
		attestation.sha !== expectedHead
	) {
		throw refusal("served runtime is not the exact production HEAD");
	}
	exactKeys(
		attestation.storage,
		["backend", "group", "locator", "organization", "scope"],
		"production runtime storage attestation",
	);
	const expectedOrganization = storageCoordinate(
		organization,
		"inspected Turso organization",
	);
	const expectedGroup = storageCoordinate(group, "inspected Turso group");
	if (
		attestation.storage.backend !== "sqlite" ||
		attestation.storage.locator !== "turso" ||
		attestation.storage.scope !== "prod" ||
		attestation.storage.organization !== expectedOrganization ||
		attestation.storage.group !== expectedGroup
	) {
		throw refusal(
			"served production storage does not match the inspected durable profile",
		);
	}
	return {
		environment: "production",
		sha: expectedHead,
		storage: {
			backend: "sqlite",
			locator: "turso",
			organization: expectedOrganization,
			group: expectedGroup,
			scope: "prod",
		},
	};
}

export async function attestProductionRuntime({
	origin,
	expectedHead,
	organization,
	group,
	bypass,
	fetchImpl = fetch,
}) {
	const pinnedOrigin = validateImmutableProductionOrigin(origin);
	const bypassSecret = requireNonBlank(
		bypass,
		"VERCEL_AUTOMATION_BYPASS_SECRET",
	);
	let response;
	try {
		response = await fetchImpl(`${pinnedOrigin}${ATTESTATION_PATH}`, {
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers: {
				accept: "application/json",
				"x-vercel-protection-bypass": bypassSecret,
			},
		});
	} catch {
		throw refusal("production runtime attestation request failed");
	}
	if (response.status !== 200) {
		throw refusal(
			`production runtime attestation failed with HTTP ${response.status}`,
		);
	}
	if (
		!response.headers
			.get("cache-control")
			?.split(",")
			.some((directive) => directive.trim().toLowerCase() === "no-store")
	) {
		throw refusal("production runtime attestation response is cacheable");
	}
	const body = await boundedJson(
		response,
		"production runtime attestation",
		MAX_RUNTIME_ATTESTATION_BYTES,
	);
	return normalizeProductionRuntimeAttestation(body, {
		expectedHead,
		organization,
		group,
	});
}

function deriveProbeBytes(secret, label, length) {
	return createHash("sha256")
		.update(`remote-claw-production-data-plane/v1\0${label}\0`, "utf8")
		.update(secret)
		.digest()
		.subarray(0, length);
}

function normalizeFrameCount(body, label) {
	exactKeys(body, ["durable", "frameCount"], label);
	if (
		body.durable !== true ||
		(body.frameCount !== null &&
			(!Number.isSafeInteger(body.frameCount) || body.frameCount < 0))
	) {
		throw refusal(`${label} is not a durable cursor`);
	}
	return body.frameCount;
}

function deploymentProtectionCookieNonce(rawCookie) {
	if (
		typeof rawCookie !== "string" ||
		rawCookie === "" ||
		/[\r\n,]/.test(rawCookie)
	) {
		throw refusal("production deployment protection is not active");
	}
	const segments = rawCookie.split(";").map((segment) => segment.trim());
	const cookie = /^_vercel_sso_nonce=([0-9a-f]{48})$/.exec(
		segments.shift() ?? "",
	);
	if (cookie === null || cookie[1] === undefined || segments.length === 0) {
		throw refusal("production deployment protection is not active");
	}
	const attributes = new Set();
	for (const segment of segments) {
		const separator = segment.indexOf("=");
		const name = (separator === -1 ? segment : segment.slice(0, separator))
			.trim()
			.toLowerCase();
		const value = separator === -1 ? undefined : segment.slice(separator + 1);
		if (
			!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
			attributes.has(name) ||
			name === "_vercel_sso_nonce" ||
			(value !== undefined && (value === "" || /[^\x20-\x7e]/.test(value))) ||
			((name === "secure" || name === "httponly") && value !== undefined)
		) {
			throw refusal("production deployment protection is not active");
		}
		attributes.add(name);
	}
	if (!attributes.has("secure") || !attributes.has("httponly")) {
		throw refusal("production deployment protection is not active");
	}
	return cookie[1];
}

export async function attestProductionDeploymentProtection({
	origin,
	fetchImpl = fetch,
}) {
	const pinnedOrigin = validateImmutableProductionOrigin(origin);
	const target = `${pinnedOrigin}${ATTESTATION_PATH}`;
	let response;
	try {
		response = await fetchImpl(target, {
			cache: "no-store",
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
			headers: { accept: "application/json" },
		});
	} catch {
		throw refusal("production deployment-protection probe failed");
	}
	if (
		!response.headers
			.get("cache-control")
			?.split(",")
			.some((directive) => directive.trim().toLowerCase() === "no-store") ||
		response.headers.get("server")?.toLowerCase() !== "vercel" ||
		response.headers.get("x-frame-options")?.toUpperCase() !== "DENY"
	) {
		throw refusal("production deployment protection is not active");
	}
	const cookieNonce = deploymentProtectionCookieNonce(
		response.headers.get("set-cookie") ?? "",
	);
	const expectedCallbackNonce = createHash("sha256")
		.update(cookieNonce, "ascii")
		.digest("hex");
	const validateCallback = (raw) => {
		let callback;
		try {
			callback = new URL(raw);
		} catch {
			throw refusal("production deployment protection is not active");
		}
		const queryKeys = [...callback.searchParams.keys()].sort();
		if (
			callback.origin !== "https://vercel.com" ||
			callback.pathname !== "/sso-api" ||
			callback.username !== "" ||
			callback.password !== "" ||
			callback.port !== "" ||
			callback.hash !== "" ||
			queryKeys.length !== 2 ||
			queryKeys[0] !== "nonce" ||
			queryKeys[1] !== "url" ||
			callback.searchParams.get("url") !== target ||
			callback.searchParams.get("nonce") !== expectedCallbackNonce
		) {
			throw refusal("production deployment protection is not active");
		}
	};
	if (response.status === 302) {
		validateCallback(response.headers.get("location") ?? "");
	} else if (response.status === 401) {
		const body = await boundedJson(
			response,
			"production deployment-protection probe",
			2 * 1_024,
		);
		exactKeys(body, ["error", "protection"], "deployment-protection response");
		exactKeys(body.error, ["code", "message"], "deployment-protection error");
		exactKeys(
			body.protection,
			[
				"auto_vercel_auth_redirect",
				"password_enabled",
				"vercel_auth_callback",
				"vercel_auth_enabled",
			],
			"deployment-protection policy",
		);
		if (
			body.error.code !== "401" ||
			body.error.message !== "Protected deployment" ||
			body.protection.auto_vercel_auth_redirect !== true ||
			body.protection.password_enabled !== false ||
			body.protection.vercel_auth_enabled !== true
		) {
			throw refusal("production deployment protection is not active");
		}
		validateCallback(body.protection.vercel_auth_callback);
	} else {
		throw refusal("production deployment protection is not active");
	}
	return true;
}

async function dataPlaneJson({
	url,
	label,
	bypass,
	bearer,
	fetchImpl,
	method = "GET",
	body,
	timeoutMs,
}) {
	let response;
	try {
		response = await fetchImpl(url, {
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
			method,
			headers: {
				accept: "application/json",
				authorization: `Bearer ${bearer}`,
				"x-vercel-protection-bypass": bypass,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body }),
		});
	} catch {
		throw refusal(`${label} request failed`);
	}
	if (response.status !== 200) {
		throw refusal(`${label} failed with HTTP ${response.status}`);
	}
	return boundedJson(response, label, MAX_DATA_PLANE_RESPONSE_BYTES);
}

/**
 * Exercise the immutable Production deployment's real default broker surface with a fresh, random
 * identity/session. The initial durable cursor must be absent, relay must create and commit exactly one
 * opaque frame, and a second cursor read must observe it. This proves the shipped route, Platform API
 * credential, group credential, and Turso write/read path together without putting any secret or
 * plaintext in the receipt.
 */
export async function attestProductionDataPlane({
	origin,
	expectedHead,
	bypass,
	fetchImpl = fetch,
	newChallenge = () => randomBytes(32),
}) {
	const pinnedOrigin = validateImmutableProductionOrigin(origin);
	fullSha(expectedHead, "expected production HEAD");
	const bypassSecret = requireNonBlank(
		bypass,
		"VERCEL_AUTOMATION_BYPASS_SECRET",
	);
	await attestProductionDeploymentProtection({
		origin: pinnedOrigin,
		fetchImpl,
	});
	const suppliedChallenge = newChallenge();
	if (
		!(suppliedChallenge instanceof Uint8Array) ||
		suppliedChallenge.byteLength !== 32
	) {
		throw refusal("production data-plane challenge is invalid");
	}
	const challenge = Buffer.from(suppliedChallenge);
	suppliedChallenge.fill(0);
	try {
		const challengeSha256 = sha256(challenge);
		const identityId = createHash("sha256")
			.update(challenge)
			.digest("hex")
			.slice(0, 32);
		const sessionId = `release-storage-${challengeSha256.slice(0, 32)}`;
		const expectedDatabaseId = `rc-prod-s-${sha256(
			`sess:${identityId}:${sessionId}`,
		).slice(0, 16)}`;
		const frame = {
			v: 1,
			identity_id: identityId,
			session_id: sessionId,
			dir: "out",
			record_kind: "release_storage_canary",
			seq: 0,
			msg_id: `release-storage-${challengeSha256}`,
			key_epoch: 0,
			salt: deriveProbeBytes(challenge, "salt", 32).toString("base64url"),
			nonce: deriveProbeBytes(challenge, "nonce", 12).toString("base64url"),
			ct: deriveProbeBytes(challenge, "ciphertext", 32).toString("base64url"),
			part: 0,
			parts: 1,
		};
		const bearer = challenge.toString("hex");
		const query = `?session=${encodeURIComponent(sessionId)}`;
		const before = normalizeFrameCount(
			await dataPlaneJson({
				url: `${pinnedOrigin}${FRAME_COUNT_PATH}${query}`,
				label: "production data-plane initial cursor",
				bypass: bypassSecret,
				bearer,
				fetchImpl,
				timeoutMs: 15_000,
			}),
			"production data-plane initial cursor",
		);
		if (before !== null) {
			throw refusal("production data-plane challenge channel already exists");
		}
		const relay = await dataPlaneJson({
			url: `${pinnedOrigin}${RELAY_PATH}${query}`,
			label: "production data-plane relay",
			bypass: bypassSecret,
			bearer,
			fetchImpl,
			method: "POST",
			body: JSON.stringify(frame),
			timeoutMs: 55_000,
		});
		exactKeys(
			relay,
			["channel", "created", "ok", "runId"],
			"production data-plane relay result",
		);
		if (
			relay.ok !== true ||
			relay.created !== true ||
			relay.channel !== "session" ||
			relay.runId !== expectedDatabaseId
		) {
			throw refusal("production data-plane relay did not create the challenge");
		}
		const after = normalizeFrameCount(
			await dataPlaneJson({
				url: `${pinnedOrigin}${FRAME_COUNT_PATH}${query}`,
				label: "production data-plane committed cursor",
				bypass: bypassSecret,
				bearer,
				fetchImpl,
				timeoutMs: 15_000,
			}),
			"production data-plane committed cursor",
		);
		if (after !== 1) {
			throw refusal("production data-plane committed frame was not readable");
		}
		return {
			schema: DATA_PLANE_SCHEMA,
			result: "passed",
			headSha: expectedHead,
			backend: "sqlite",
			durable: true,
			deploymentProtection: true,
			databaseId: expectedDatabaseId,
			frameCountBefore: null,
			frameCountAfter: 1,
			frameSha256: sha256(Buffer.from(JSON.stringify(frame), "utf8")),
		};
	} finally {
		challenge.fill(0);
	}
}

export function normalizeProductionDataPlaneAttestation(
	attestation,
	expectedHead,
) {
	exactKeys(
		attestation,
		[
			"backend",
			"databaseId",
			"deploymentProtection",
			"durable",
			"frameCountAfter",
			"frameCountBefore",
			"frameSha256",
			"headSha",
			"result",
			"schema",
		],
		"production data-plane attestation",
	);
	fullSha(expectedHead, "expected production HEAD");
	if (
		attestation.schema !== DATA_PLANE_SCHEMA ||
		attestation.result !== "passed" ||
		attestation.headSha !== expectedHead ||
		attestation.backend !== "sqlite" ||
		!/^rc-prod-s-[0-9a-f]{16}$/.test(attestation.databaseId) ||
		attestation.durable !== true ||
		attestation.deploymentProtection !== true ||
		attestation.frameCountBefore !== null ||
		attestation.frameCountAfter !== 1 ||
		!/^[0-9a-f]{64}$/.test(attestation.frameSha256)
	) {
		throw refusal("production data-plane attestation did not pass");
	}
	return attestation;
}

export function validateProductionReceipt(receipt) {
	exactKeys(
		receipt,
		[
			"candidate",
			"dataPlaneAttestation",
			"firewallAttestation",
			"github",
			"inspection",
			"production",
			"result",
			"runtimeAttestation",
			"schema",
			"vercel",
			"verifiedAt",
		],
		"production release attestation",
	);
	if (receipt.schema !== RELEASE_SCHEMA || receipt.result !== "passed") {
		throw refusal("production release attestation schema/result is invalid");
	}
	exactKeys(
		receipt.inspection,
		["file", "sha256"],
		"production inspection binding",
	);
	if (
		typeof receipt.inspection.file !== "string" ||
		basename(receipt.inspection.file) !== receipt.inspection.file ||
		!receipt.inspection.file.endsWith(".inspection-v1.json") ||
		!/^[0-9a-f]{64}$/.test(receipt.inspection.sha256)
	) {
		throw refusal("production inspection binding is invalid");
	}
	exactKeys(
		receipt.candidate,
		["githubDeploymentId", "headSha", "treeSha"],
		"production candidate binding",
	);
	fullSha(receipt.candidate.headSha, "candidate HEAD");
	fullTree(receipt.candidate.treeSha, "candidate tree");
	numericDeploymentId(
		receipt.candidate.githubDeploymentId,
		"candidate GitHub deployment id",
	);
	exactKeys(
		receipt.production,
		["headSha", "treeSha"],
		"production HEAD binding",
	);
	fullSha(receipt.production.headSha, "production HEAD");
	fullTree(receipt.production.treeSha, "production tree");
	if (receipt.candidate.treeSha !== receipt.production.treeSha) {
		throw refusal("production candidate and release trees differ");
	}
	exactKeys(
		receipt.github,
		["creator", "deploymentId", "newestStatus", "ref", "repository"],
		"production GitHub coordinates",
	);
	repositoryCoordinate(receipt.github.repository);
	numericDeploymentId(
		receipt.github.deploymentId,
		"production GitHub deployment id",
	);
	if (
		receipt.github.creator !== EXPECTED_CREATOR ||
		receipt.github.newestStatus !== "success" ||
		receipt.github.ref !== EXPECTED_GITHUB_REF
	) {
		throw refusal("production GitHub coordinates are invalid");
	}
	exactKeys(
		receipt.vercel,
		[
			"deploymentId",
			"origin",
			"ownerId",
			"projectId",
			"readyState",
			"status",
			"target",
			"teamId",
		],
		"production Vercel coordinates",
	);
	if (
		!/^dpl_[A-Za-z0-9]+$/.test(receipt.vercel.deploymentId) ||
		receipt.vercel.ownerId !== VERCEL_TEAM_ID ||
		receipt.vercel.projectId !== VERCEL_PROJECT_ID ||
		receipt.vercel.teamId !== VERCEL_TEAM_ID ||
		receipt.vercel.readyState !== "READY" ||
		receipt.vercel.status !== "READY" ||
		receipt.vercel.target !== "production"
	) {
		throw refusal("production Vercel coordinates are invalid");
	}
	validateImmutableProductionOrigin(receipt.vercel.origin);
	normalizeProductionRuntimeAttestation(receipt.runtimeAttestation, {
		expectedHead: receipt.production.headSha,
		organization: receipt.runtimeAttestation?.storage?.organization,
		group: receipt.runtimeAttestation?.storage?.group,
	});
	normalizeProductionDataPlaneAttestation(
		receipt.dataPlaneAttestation,
		receipt.production.headSha,
	);
	validateProductionFirewallAttestation(receipt.firewallAttestation);
	canonicalIso(receipt.verifiedAt, "production verification time");
	return receipt;
}

export function createProductionReceipt({
	inspection,
	local,
	github,
	vercel,
	runtimeAttestation,
	dataPlaneAttestation,
	firewallAttestation,
	repository,
	verifiedAt = new Date().toISOString(),
}) {
	const receipt = {
		schema: RELEASE_SCHEMA,
		result: "passed",
		inspection: {
			file: inspection.file,
			sha256: inspection.sha256,
		},
		candidate: {
			headSha: inspection.candidateSha,
			treeSha: local.candidateTree,
			githubDeploymentId: String(
				inspection.receipt.topology.githubDeploymentId,
			),
		},
		production: {
			headSha: local.headSha,
			treeSha: local.productionTree,
		},
		github: {
			repository,
			deploymentId: github.deploymentId,
			ref: EXPECTED_GITHUB_REF,
			creator: EXPECTED_CREATOR,
			newestStatus: "success",
		},
		vercel,
		runtimeAttestation,
		dataPlaneAttestation: normalizeProductionDataPlaneAttestation(
			dataPlaneAttestation,
			local.headSha,
		),
		firewallAttestation:
			validateProductionFirewallAttestation(firewallAttestation),
		verifiedAt,
	};
	return validateProductionReceipt(receipt);
}

export function productionReceiptPath(
	receipt,
	receiptRoot = MODULE_DEFAULT_RECEIPT_ROOT,
) {
	validateProductionReceipt(receipt);
	if (!isAbsolute(receiptRoot) || resolve(receiptRoot) !== receiptRoot) {
		throw refusal("production receipt root is not absolute and canonical");
	}
	return join(
		receiptRoot,
		`production-release-attestation-${receipt.production.headSha}-${receipt.github.deploymentId}.json`,
	);
}

export function stageProductionReceipt(
	receipt,
	{
		receiptRoot = MODULE_DEFAULT_RECEIPT_ROOT,
		newId = randomUUID,
		openFile = openSync,
		writeFile = writeFileSync,
		fsyncFile = fsyncSync,
		closeFile = closeSync,
		unlinkFile = unlinkSync,
		statPath = lstatSync,
		realpath = realpathSync,
		openDirectory = openSync,
		statDirectory = fstatSync,
		fsyncDirectory = fsyncSync,
		closeDirectory = closeSync,
	} = {},
) {
	const normalized = validateProductionReceipt(receipt);
	const id = newId();
	if (
		typeof id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			id,
		)
	) {
		throw refusal("production receipt staging id is invalid");
	}
	let realRoot;
	try {
		realRoot = realpath(receiptRoot);
	} catch {
		throw refusal("production receipt directory is unavailable");
	}
	if (realRoot !== receiptRoot) {
		throw refusal("production receipt directory is not canonical");
	}
	const rootPathStat = statPath(receiptRoot);
	validatePrivateReceiptDirectory(rootPathStat);
	let directoryDescriptor;
	try {
		directoryDescriptor = openDirectory(
			receiptRoot,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const descriptorStat = statDirectory(directoryDescriptor);
		validatePrivateReceiptDirectory(descriptorStat);
		if (
			descriptorStat.dev !== rootPathStat.dev ||
			descriptorStat.ino !== rootPathStat.ino
		) {
			throw refusal("production receipt directory changed while opening");
		}
		if (realpath(`/proc/self/fd/${directoryDescriptor}`) !== receiptRoot) {
			throw refusal("production receipt directory descriptor is not pinned");
		}
	} catch (error) {
		if (directoryDescriptor !== undefined) {
			try {
				closeDirectory(directoryDescriptor);
			} catch {
				// Preserve the fixed refusal below.
			}
		}
		if (
			error instanceof Error &&
			error.message.startsWith("production receipt directory ")
		) {
			throw error;
		}
		throw refusal("production receipt directory could not be opened safely");
	}
	const stagePath = join(receiptRoot, `.production-release-stage-${id}.json`);
	const anchoredRoot = `/proc/self/fd/${directoryDescriptor}`;
	const anchoredStagePath = join(anchoredRoot, basename(stagePath));
	let descriptor;
	try {
		descriptor = openFile(
			anchoredStagePath,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		writeFile(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, {
			encoding: "utf8",
		});
		fsyncFile(descriptor);
		closeFile(descriptor);
		descriptor = undefined;
		const stageStat = statPath(anchoredStagePath);
		validatePrivateReceiptStat(stageStat);
		if (stageStat.nlink !== 1) {
			throw refusal("production receipt has an unsafe link count");
		}
		const currentRootStat = statPath(receiptRoot);
		validatePrivateReceiptDirectory(currentRootStat);
		const visibleStageStat = statPath(stagePath);
		if (
			currentRootStat.dev !== rootPathStat.dev ||
			currentRootStat.ino !== rootPathStat.ino ||
			!sameFile(stageStat, visibleStageStat) ||
			realpath(receiptRoot) !== receiptRoot
		) {
			throw refusal("production receipt directory changed while staging");
		}
		fsyncDirectory(directoryDescriptor);
		closeDirectory(directoryDescriptor);
		directoryDescriptor = undefined;
		return stagePath;
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeFile(descriptor);
			} catch {
				// Preserve the fixed refusal below.
			}
		}
		try {
			unlinkFile(anchoredStagePath);
		} catch {
			// Missing staging files are expected after an early open failure.
		}
		if (directoryDescriptor !== undefined) {
			try {
				fsyncDirectory(directoryDescriptor);
			} catch {
				// A failed directory sync cannot authorize a release.
			}
			try {
				closeDirectory(directoryDescriptor);
			} catch {
				// Preserve the fixed refusal below.
			}
			directoryDescriptor = undefined;
		}
		if (
			error instanceof Error &&
			error.message.startsWith("production receipt ")
		) {
			throw error;
		}
		throw refusal("production receipt could not be staged exclusively");
	}
}

export function publishStagedProductionReceipt(
	stageBinding,
	{
		receiptRoot = MODULE_DEFAULT_RECEIPT_ROOT,
		repositoryRoot = MODULE_DEFAULT_REPOSITORY_ROOT,
		localInspector = inspectLocalReleaseState,
		openFile = openSync,
		readFile = readFileSync,
		statFile = fstatSync,
		closeFile = closeSync,
		linkFile = linkSync,
		unlinkFile = unlinkSync,
		statPath = lstatSync,
		realpath = realpathSync,
		openDirectory = openSync,
		statDirectory = fstatSync,
		fsyncDirectory = fsyncSync,
		closeDirectory = closeSync,
	} = {},
) {
	exactKeys(
		stageBinding,
		PUBLISH_INPUT_FIELDS,
		"production receipt staging binding",
	);
	const { stagePath } = stageBinding;
	if (
		!/^[0-9a-f]{64}$/.test(stageBinding.sha256) ||
		![stageBinding.device, stageBinding.inode].every((value) =>
			/^(?:0|[1-9][0-9]*)$/.test(value),
		) ||
		!/^[1-9][0-9]*$/.test(stageBinding.size)
	) {
		throw refusal("production receipt staging binding is invalid");
	}
	if (
		typeof stagePath !== "string" ||
		!isAbsolute(stagePath) ||
		resolve(stagePath) !== stagePath ||
		dirname(stagePath) !== receiptRoot ||
		!/^\.production-release-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(
			basename(stagePath),
		)
	) {
		throw refusal("production receipt staging path is invalid");
	}
	let realRoot;
	try {
		realRoot = realpath(receiptRoot);
		if (realRoot !== receiptRoot || realpath(stagePath) !== stagePath) {
			throw refusal("production receipt staging path is not canonical");
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("production ")) {
			throw error;
		}
		throw refusal("production receipt staging path is unavailable");
	}
	const rootPathStat = statPath(receiptRoot);
	validatePrivateReceiptDirectory(rootPathStat);
	const stagePathStat = statPath(stagePath);
	validatePrivateReceiptStat(stagePathStat);
	if (
		String(stagePathStat.dev) !== stageBinding.device ||
		String(stagePathStat.ino) !== stageBinding.inode ||
		String(stagePathStat.size) !== stageBinding.size
	) {
		throw refusal("production receipt staging identity changed");
	}
	let directoryDescriptor;
	try {
		directoryDescriptor = openDirectory(
			receiptRoot,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const descriptorStat = statDirectory(directoryDescriptor);
		validatePrivateReceiptDirectory(descriptorStat);
		if (
			descriptorStat.dev !== rootPathStat.dev ||
			descriptorStat.ino !== rootPathStat.ino ||
			realpath(`/proc/self/fd/${directoryDescriptor}`) !== receiptRoot
		) {
			throw refusal("production receipt directory changed while opening");
		}
	} catch (error) {
		if (directoryDescriptor !== undefined) {
			try {
				closeDirectory(directoryDescriptor);
			} catch {
				// Preserve the fixed refusal below.
			}
		}
		if (error instanceof Error && error.message.startsWith("production ")) {
			throw error;
		}
		throw refusal("production receipt directory could not be opened safely");
	}
	const anchoredRoot = `/proc/self/fd/${directoryDescriptor}`;
	const anchoredStagePath = join(anchoredRoot, basename(stagePath));
	let descriptor;
	let linked = false;
	try {
		descriptor = openFile(
			anchoredStagePath,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		const descriptorStat = statFile(descriptor);
		validatePrivateReceiptStat(descriptorStat);
		if (!sameFile(stagePathStat, descriptorStat)) {
			throw refusal("production receipt changed while opening staging bytes");
		}
		const bytes = readFile(descriptor);
		if (
			!Buffer.isBuffer(bytes) ||
			bytes.length !== descriptorStat.size ||
			sha256(bytes) !== stageBinding.sha256
		) {
			throw refusal(
				"production receipt staging bytes could not be read exactly",
			);
		}
		const afterReadStat = statPath(anchoredStagePath);
		if (
			!sameFile(descriptorStat, afterReadStat) ||
			!sameFile(descriptorStat, statPath(stagePath)) ||
			realpath(stagePath) !== stagePath
		) {
			throw refusal("production receipt changed while reading staging bytes");
		}
		closeFile(descriptor);
		descriptor = undefined;
		let receipt;
		try {
			receipt = validateProductionReceipt(JSON.parse(bytes.toString("utf8")));
		} catch {
			throw refusal("production receipt staging bytes are invalid");
		}
		const local = localInspector({
			candidateSha: receipt.candidate.headSha,
			cwd: repositoryRoot,
		});
		if (
			local.headSha !== receipt.production.headSha ||
			local.candidateTree !== receipt.candidate.treeSha ||
			local.productionTree !== receipt.production.treeSha
		) {
			throw refusal(
				"production receipt no longer matches the release repository",
			);
		}
		const stableStageStat = statPath(anchoredStagePath);
		const currentRootStat = statPath(receiptRoot);
		validatePrivateReceiptStat(stableStageStat);
		validatePrivateReceiptDirectory(currentRootStat);
		if (
			!sameFile(stagePathStat, stableStageStat) ||
			!sameFile(stagePathStat, statPath(stagePath)) ||
			currentRootStat.dev !== rootPathStat.dev ||
			currentRootStat.ino !== rootPathStat.ino ||
			realpath(receiptRoot) !== receiptRoot ||
			realpath(stagePath) !== stagePath
		) {
			throw refusal("production receipt changed before publishing");
		}
		const finalPath = productionReceiptPath(receipt, receiptRoot);
		const anchoredFinalPath = join(anchoredRoot, basename(finalPath));
		linkFile(anchoredStagePath, anchoredFinalPath);
		linked = true;
		unlinkFile(anchoredStagePath);
		const finalStat = statPath(anchoredFinalPath);
		validatePrivateReceiptStat(finalStat);
		if (
			finalStat.nlink !== 1 ||
			!sameFile(finalStat, statPath(finalPath)) ||
			realpath(receiptRoot) !== receiptRoot
		) {
			throw refusal("production receipt final verification failed");
		}
		fsyncDirectory(directoryDescriptor);
		closeDirectory(directoryDescriptor);
		directoryDescriptor = undefined;
		return finalPath;
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeFile(descriptor);
			} catch {
				// Preserve the fixed refusal below.
			}
		}
		if (directoryDescriptor !== undefined) {
			try {
				fsyncDirectory(directoryDescriptor);
			} catch {
				// A failed directory sync cannot authorize a release.
			}
			try {
				closeDirectory(directoryDescriptor);
			} catch {
				// Preserve the fixed refusal below.
			}
			directoryDescriptor = undefined;
		}
		if (linked) {
			// The final link was created only after the outer proof boundary passed.
			throw refusal("production receipt final verification failed");
		}
		if (error instanceof Error && error.message.startsWith("production ")) {
			throw error;
		}
		throw refusal("production receipt could not be published exclusively");
	}
}

function sameLocalState(left, right) {
	return (
		left.headSha === right.headSha &&
		left.candidateTree === right.candidateTree &&
		left.productionTree === right.productionTree
	);
}

export async function verifyProductionRelease({
	input,
	fetchImpl = fetch,
	inspectionReader = readInspectionReceipt,
	localInspector = inspectLocalReleaseState,
	githubResolver = resolveGithubProduction,
	vercelResolver = resolveVercelProduction,
	firewallAttester = attestProductionFirewall,
	runtimeAttester = attestProductionRuntime,
	dataPlaneAttester = attestProductionDataPlane,
	mainRefResolver = resolveGithubMainHead,
	receiptStager = stageProductionReceipt,
	now = () => new Date().toISOString(),
	repositoryRoot = MODULE_DEFAULT_REPOSITORY_ROOT,
	receiptRoot = join(repositoryRoot, "tests", "web", "test-results"),
} = {}) {
	validateProofInput(input);
	const repository = repositoryCoordinate(input.GITHUB_REPOSITORY);
	const inspection = inspectionReader(input.RC_INSPECTION_RECEIPT_FILE, {
		receiptRoot,
	});
	assertFreshInspection(inspection, now());
	const local = localInspector({
		candidateSha: inspection.candidateSha,
		cwd: repositoryRoot,
	});
	const github = await githubResolver({
		repository,
		token: input.GITHUB_TOKEN,
		deploymentId: input.RC_PRODUCTION_DEPLOYMENT_ID,
		expectedHead: local.headSha,
		candidateSha: inspection.candidateSha,
		localCandidateTree: local.candidateTree,
		localProductionTree: local.productionTree,
		fetchImpl,
	});
	const vercel = await vercelResolver({
		origin: github.origin,
		expectedHead: local.headSha,
		token: input.VERCEL_TOKEN,
		fetchImpl,
	});
	const firewallAttestation = await firewallAttester({
		token: input.VERCEL_TOKEN,
		fetchImpl,
	});
	const runtimeAttestation = await runtimeAttester({
		origin: vercel.origin,
		expectedHead: local.headSha,
		organization: inspection.organization,
		group: inspection.group,
		bypass: input.VERCEL_AUTOMATION_BYPASS_SECRET,
		fetchImpl,
	});
	const dataPlaneAttestation = await dataPlaneAttester({
		origin: vercel.origin,
		expectedHead: local.headSha,
		bypass: input.VERCEL_AUTOMATION_BYPASS_SECRET,
		fetchImpl,
	});
	const finalInspection = inspectionReader(input.RC_INSPECTION_RECEIPT_FILE, {
		receiptRoot,
	});
	if (
		finalInspection.sha256 !== inspection.sha256 ||
		finalInspection.candidateSha !== inspection.candidateSha ||
		finalInspection.organization !== inspection.organization ||
		finalInspection.group !== inspection.group
	) {
		throw refusal("inspection receipt changed during production verification");
	}
	const finalLocal = localInspector({
		candidateSha: inspection.candidateSha,
		cwd: repositoryRoot,
	});
	if (!sameLocalState(local, finalLocal)) {
		throw refusal("local HEAD/tree changed during production verification");
	}
	await mainRefResolver({
		repository,
		token: input.GITHUB_TOKEN,
		expectedHead: local.headSha,
		deploymentId: github.deploymentId,
		expectedOrigin: github.origin,
		fetchImpl,
	});
	const verifiedAt = now();
	assertFreshInspection(finalInspection, verifiedAt);
	const receipt = createProductionReceipt({
		inspection,
		local,
		github,
		vercel,
		runtimeAttestation,
		dataPlaneAttestation,
		firewallAttestation,
		repository,
		verifiedAt,
	});
	const stagedReceiptFile = receiptStager(receipt, { receiptRoot });
	return { receipt, stagedReceiptFile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		if (process.argv.length !== 2) {
			throw refusal("production verifier accepts no command-line arguments");
		}
		if (Object.hasOwn(process.env, PUBLISH_INPUT_FD_FIELD)) {
			const stageBinding = readPublishBootstrapInput();
			const repositoryRoot = validatePublishBootstrapEnvironment(process.env);
			const receiptFile = publishStagedProductionReceipt(stageBinding, {
				repositoryRoot,
				receiptRoot: join(repositoryRoot, "tests", "web", "test-results"),
			});
			process.stdout.write(`production release attestation: ${receiptFile}\n`);
		} else {
			const input = readProofBootstrapInput();
			const repositoryRoot = validateBootstrapEnvironment(process.env);
			const result = await verifyProductionRelease({
				input,
				repositoryRoot,
				receiptRoot: join(repositoryRoot, "tests", "web", "test-results"),
			});
			process.stdout.write(
				`staged production release attestation: ${result.stagedReceiptFile}\n`,
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown failure";
		process.stderr.write(
			`production release verification refused: ${message}\n`,
		);
		process.exitCode = 1;
	}
}
