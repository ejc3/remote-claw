import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	cpSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	opendirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	INSPECTION_RECEIPT_SCHEMA,
	INSPECTION_VERCEL_PROJECT_ID,
	INSPECTION_VERCEL_TEAM_ID,
	TOPOLOGY_RECEIPT_SCHEMA,
	validateInspectionReceipt as validatePureInspectionReceipt,
} from "./inspection-receipt-schema.mjs";

const TOPOLOGY_SCHEMA = TOPOLOGY_RECEIPT_SCHEMA;
const INSPECTION_SCHEMA = INSPECTION_RECEIPT_SCHEMA;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..");
const RECEIPT_ROOT = join(REPOSITORY_ROOT, "tests", "web", "test-results");
const VERCEL_API_ORIGIN = "https://api.vercel.com";
const VERCEL_LOG_ORIGIN = "https://vercel.com";
const VERCEL_PROJECT_ID = INSPECTION_VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = INSPECTION_VERCEL_TEAM_ID;
const WAF_CONFIG_ID = "waf_TG8xDULMuMuR";
const WAF_RULE_ID = "rule_handoff_per_ip_rate_limit_UWaS5F";
const PINNED_CLAUDE_VERSION = "2.1.237 (Claude Code)";
const PINNED_CLAUDE_EXECUTABLE_SHA256 =
	"a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177";
const TURSO_API_ORIGIN = "https://api.turso.tech";
const TRUSTED_PATH = "/usr/bin:/bin";
const NODE_BIN = "/usr/bin/node";
const GIT_BIN = "/usr/bin/git";
const INPUT_FIELDS = [
	"RC_TOPOLOGY_RECEIPT_FILE",
	"TURSO_API_TOKEN",
	"TURSO_GROUP_AUTH_TOKEN",
	"VERCEL_TOKEN",
];
const BOOTSTRAP_FIXED_ENVIRONMENT = {
	LANG: "C.UTF-8",
	PATH: TRUSTED_PATH,
	RC_INSPECTION_INPUT_FD: "0",
	RC_INSPECTION_MODE: "scan",
};
const BOOTSTRAP_REPOSITORY_ROOT_FIELD = "RC_INSPECTION_REPOSITORY_ROOT";
const PUBLISH_FIXED_ENVIRONMENT = {
	LANG: "C.UTF-8",
	PATH: TRUSTED_PATH,
	RC_INSPECTION_MODE: "publish",
};
const PUBLISH_PATH_FIELDS = [
	BOOTSTRAP_REPOSITORY_ROOT_FIELD,
	"RC_TOPOLOGY_RECEIPT_FILE",
	"RC_INSPECTION_STAGE_FILE",
];
const PUBLISH_EVIDENCE_FIELDS = [
	"RC_INSPECTION_STAGE_SHA256",
	"RC_INSPECTION_STAGE_STAT",
];
const MAX_INPUT_BYTES = 64 * 1_024;
const MAX_TOPOLOGY_RECEIPT_BYTES = 32 * 1_024;
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const MAX_DATABASES = 256;
const MAX_TABLES = 4_096;
const MAX_COLUMNS = 65_536;
const MAX_ROWS = 5_000_000;
const MAX_ROWS_PER_TABLE = 250_000;
const MAX_VALUES = 100_000_000;
const MAX_VALUE_BYTES = 4 * 1_024 * 1_024 * 1_024;
const ROW_PAGE_SIZE = 500;
const MAX_LOG_QUERIES = 4_096;
const MAX_LOG_ROWS = 1_000_000;
const MAX_PUBLICATION_DIRECTORY_ENTRIES = 4_096;
const PUBLISH_INDETERMINATE_EXIT_CODE = 75;
const PUBLISH_INDETERMINATE_MESSAGE =
	"inspection receipt publication state is indeterminate";
const MAX_PROOF_WINDOW_MS = 30 * 60_000;
const MAX_LOG_RETENTION_AGE_MS = 71 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_OVERALL_DEADLINE_MS = 10 * 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_LOG_SETTLE_MS = 30_000;
const DEFAULT_BETWEEN_LOG_SETTLE_MS = 10_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_COORDINATE_PATTERN = /^[A-Za-z0-9._-]+$/;
const TURSO_REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IMMUTABLE_PREVIEW_ORIGIN_PATTERN =
	/^https:\/\/remote-claw-[a-z0-9]{9}-ejc3-7031s-projects\.vercel\.app$/;

class PublicationIndeterminateError extends Error {}

export const PINNED_LIBSQL_PACKAGES = Object.freeze(
	[
		{
			name: "@libsql/client",
			version: "0.17.3",
			lockKey: "'@libsql/client@0.17.3'",
			integrity:
				"sha512-HXk9wiAoJbKFbyBH4O+aEhN6ir5ERXuXvwE5OD2eR4/5RUa3Pw/8L9zrnVdU+iNJitRvisPWaIwmhkO3bH7giA==",
			packagePath:
				"node_modules/.pnpm/@libsql+client@0.17.3/node_modules/@libsql/client",
			sha256:
				"03773be07c5c49eb02457bc6010538702f94f6f5a9894ccb0fe7ccb43a52e68a",
			files: 24,
			directories: 2,
			bytes: 140_127,
		},
		{
			name: "@libsql/core",
			version: "0.17.3",
			lockKey: "'@libsql/core@0.17.3'",
			integrity:
				"sha512-2UjK1i7JBkMduJo4WdvvBxMMvVJ31pArBZNONyz/GCJJAH+1UHat2X6vn10S/WpY5fKzIT98WqYFl2vzWRLOfg==",
			packagePath:
				"node_modules/.pnpm/@libsql+core@0.17.3/node_modules/@libsql/core",
			sha256:
				"765c1f616f325e87eacfe104608c0c583d2911cfdc7336ab42ca9ed834444b63",
			files: 14,
			directories: 2,
			bytes: 50_678,
		},
		{
			name: "@libsql/hrana-client",
			version: "0.10.0",
			lockKey: "'@libsql/hrana-client@0.10.0'",
			integrity:
				"sha512-OoA4EMqRAC7kn7V2P6EQqRcpZf2W+AjsNIyCizBg339Tq/aMC7sRnzs3SklderhmQWAqEzvv8A2vhxVmWpkVvw==",
			packagePath:
				"node_modules/.pnpm/@libsql+hrana-client@0.10.0/node_modules/@libsql/hrana-client",
			sha256:
				"5f4034bedd0339b7a66ed24fc26b957d219f24c5546c3d86ffcb30af64d9371e",
			files: 136,
			directories: 14,
			bytes: 305_584,
		},
		{
			name: "@libsql/isomorphic-ws",
			version: "0.1.5",
			lockKey: "'@libsql/isomorphic-ws@0.1.5'",
			integrity:
				"sha512-DtLWIH29onUYR00i0GlQ3UdcTRC6EP4u9w/h9LxpUZJWRMARk6dQwZ6Jkd+QdwVpuAOrdxt18v0K2uIYR3fwFg==",
			packagePath:
				"node_modules/.pnpm/@libsql+isomorphic-ws@0.1.5/node_modules/@libsql/isomorphic-ws",
			sha256:
				"b8044973b78e23954a2a266f7af43a6fcb7fd8352e32bd6597fbe4958491504a",
			files: 7,
			directories: 0,
			bytes: 2_432,
		},
		{
			name: "js-base64",
			version: "3.7.8",
			lockKey: "js-base64@3.7.8",
			integrity:
				"sha512-hNngCeKxIUQiEUN3GPJOkz4wF/YvdUdbNL9hsBcMQTkKzboD7T/q3OYOuuPZLUE6dBxSGpwhk5mwuDud7JVAow==",
			packagePath: "node_modules/.pnpm/js-base64@3.7.8/node_modules/js-base64",
			sha256:
				"0990c1e8513adb37e70d09337da97be097ee09353764c932dbec8f28df3d4a62",
			files: 7,
			directories: 0,
			bytes: 39_001,
		},
		{
			name: "promise-limit",
			version: "2.7.0",
			lockKey: "promise-limit@2.7.0",
			integrity:
				"sha512-7nJ6v5lnJsXwGprnGXga4wx6d1POjvi5Qmf1ivTRxTjH4Z/9Czja/UCMLVmB9N93GeWOU93XaFaEt6jbuoagNw==",
			packagePath:
				"node_modules/.pnpm/promise-limit@2.7.0/node_modules/promise-limit",
			sha256:
				"171f8317ccb8e4f225a5497b1a3bbfb7ae5f1ac0c60454947d99aacc5324feeb",
			files: 10,
			directories: 2,
			bytes: 16_473,
		},
		{
			name: "ws",
			version: "8.21.0",
			lockKey: "ws@8.21.0",
			integrity:
				"sha512-Vsp28b7DRcimFQvrqu2Wek3z1iYxDCWqHYB8Qsnk/S4RfaCQzPGPyBNuVjJV3cd6UiKtUtp6sNM77gWvzcCH+g==",
			packagePath: "node_modules/.pnpm/ws@8.21.0/node_modules/ws",
			sha256:
				"6536e091a2e485d82e10f596da308290c3b996841025d1d0b25fbb45d2c23356",
			files: 19,
			directories: 1,
			bytes: 151_087,
		},
	].map((specification) => Object.freeze(specification)),
);

function requireNonBlank(value, label) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} is required`);
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
	return value;
}

function safeInteger(value, label, { positive = false } = {}) {
	if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
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
	const result = requireNonBlank(value, label);
	if (
		result !== result.trim() ||
		!STORAGE_COORDINATE_PATTERN.test(result) ||
		Buffer.byteLength(result, "utf8") > 256
	) {
		throw new Error(`${label} is invalid`);
	}
	return result;
}

function sha256Bytes(value) {
	return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
	if (value instanceof Uint8Array) {
		return { $bytes: Buffer.from(value).toString("base64") };
	}
	if (value instanceof ArrayBuffer) {
		return { $bytes: Buffer.from(value).toString("base64") };
	}
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, stableValue(value[key])]),
		);
	}
	if (typeof value === "bigint") return { $bigint: value.toString() };
	return value;
}

function stableJson(value) {
	return JSON.stringify(stableValue(value));
}

function validateTrustedExecutable(path, label) {
	let resolved;
	let stat;
	try {
		resolved = realpathSync(path);
		stat = lstatSync(resolved);
	} catch {
		throw new Error(`${label} is not an available trusted executable`);
	}
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o111) === 0 ||
		(stat.mode & 0o022) !== 0 ||
		(uid !== undefined && stat.uid !== 0 && stat.uid !== uid)
	) {
		throw new Error(`${label} is not an available trusted executable`);
	}
	return resolved;
}

function validateTrustedNode() {
	const resolved = validateTrustedExecutable(NODE_BIN, "system Node.js");
	if (realpathSync(process.execPath) !== resolved) {
		throw new Error("system Node.js is not an available trusted executable");
	}
}

export function inspectCandidateRepository({
	expectedHead,
	repositoryRoot = REPOSITORY_ROOT,
	execFile = execFileSync,
} = {}) {
	exactString(expectedHead, /^[0-9a-f]{40}$/, "topology HEAD");
	let canonicalRoot;
	try {
		canonicalRoot = realpathSync(repositoryRoot);
	} catch {
		throw new Error("final-inspection repository is unavailable");
	}
	if (canonicalRoot !== repositoryRoot) {
		throw new Error("final-inspection repository path is not canonical");
	}
	const git = validateTrustedExecutable(GIT_BIN, "system git");
	const fixedGitArguments = [
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"credential.helper=",
		"-c",
		"protocol.file.allow=never",
	];
	const runGit = (args) =>
		String(
			execFile(git, [...fixedGitArguments, ...args], {
				cwd: canonicalRoot,
				encoding: "utf8",
				env: {
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_NO_REPLACE_OBJECTS: "1",
					GIT_OPTIONAL_LOCKS: "0",
					LANG: "C.UTF-8",
					PATH: TRUSTED_PATH,
				},
				killSignal: "SIGKILL",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 4 * 1_024 * 1_024,
				timeout: 10_000,
			}),
		);
	let topLevel;
	let head;
	let status;
	try {
		topLevel = runGit(["rev-parse", "--show-toplevel"]).trim();
		head = runGit(["rev-parse", "--verify", "HEAD"]).trim().toLowerCase();
		status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
	} catch {
		throw new Error(
			"final-inspection repository state could not be read safely",
		);
	}
	if (topLevel !== canonicalRoot || head !== expectedHead || status !== "") {
		throw new Error(
			"final inspection requires the clean topology-candidate repository HEAD",
		);
	}
	return { repositoryRoot: canonicalRoot, headSha: head };
}

function validatePinnedDependencyDeclarations(repositoryRoot) {
	let manifest;
	let lock;
	try {
		manifest = JSON.parse(
			readFileSync(join(repositoryRoot, "package.json"), "utf8"),
		);
		lock = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
	} catch {
		throw new Error("pinned libSQL dependency declarations are unavailable");
	}
	if (manifest.devDependencies?.["@libsql/client"] !== "0.17.3") {
		throw new Error("pinned libSQL root dependency is not exact");
	}
	for (const spec of PINNED_LIBSQL_PACKAGES) {
		const lockEntry = `  ${spec.lockKey}:\n    resolution: {integrity: ${spec.integrity}}`;
		if (!lock.includes(lockEntry)) {
			throw new Error("pinned libSQL dependency lock is not exact");
		}
	}
}

function readStableDependencyFile(path, pathStat) {
	let descriptor;
	let bytes;
	let failure;
	let closeFailed = false;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = fstatSync(descriptor);
		if (!before.isFile() || !sameFileIdentity(pathStat, before)) {
			throw new Error("dependency file changed while opening");
		}
		bytes = readFileSync(descriptor);
		const after = fstatSync(descriptor);
		const finalPath = lstatSync(path);
		if (
			!Buffer.isBuffer(bytes) ||
			bytes.length !== before.size ||
			!sameFileIdentity(before, after) ||
			!sameFileIdentity(after, finalPath)
		) {
			throw new Error("dependency file changed while reading");
		}
	} catch {
		failure = new Error(
			"pinned libSQL dependency file could not be read safely",
		);
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				closeFailed = true;
			}
		}
	}
	if (closeFailed) {
		throw new Error("pinned libSQL dependency descriptor could not be closed");
	}
	if (failure !== undefined) throw failure;
	return bytes;
}

export function validatePinnedPackageTree(packageRoot, spec) {
	let root;
	try {
		root = realpathSync(packageRoot);
	} catch {
		throw new Error("pinned libSQL dependency package is unavailable");
	}
	if (root !== packageRoot) {
		throw new Error("pinned libSQL dependency package path is not canonical");
	}
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error("pinned libSQL dependency package is not a directory");
	}
	const digest = createHash("sha256");
	let files = 0;
	let directories = 0;
	let bytes = 0;
	const visit = (directory, relativeDirectory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
		} catch {
			throw new Error("pinned libSQL dependency tree could not be enumerated");
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			const relativePath =
				relativeDirectory === ""
					? entry.name
					: `${relativeDirectory}/${entry.name}`;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				throw new Error("pinned libSQL dependency tree contains a symlink");
			}
			if (stat.isDirectory()) {
				directories += 1;
				if (directories > 256) {
					throw new Error("pinned libSQL dependency tree exceeded its cap");
				}
				digest.update("D\0").update(relativePath).update("\0");
				visit(path, relativePath);
				continue;
			}
			if (!stat.isFile() || stat.size > 2 * 1_024 * 1_024) {
				throw new Error(
					"pinned libSQL dependency tree contains an unsafe file",
				);
			}
			files += 1;
			bytes += stat.size;
			if (files > 1_024 || bytes > 8 * 1_024 * 1_024) {
				throw new Error("pinned libSQL dependency tree exceeded its cap");
			}
			const contents = readStableDependencyFile(path, stat);
			digest
				.update("F\0")
				.update(relativePath)
				.update("\0")
				.update(String(contents.length))
				.update("\0")
				.update(contents)
				.update("\0");
		}
	};
	visit(root, "");
	const sha256 = digest.digest("hex");
	if (
		sha256 !== spec.sha256 ||
		files !== spec.files ||
		directories !== spec.directories ||
		bytes !== spec.bytes
	) {
		throw new Error("pinned libSQL dependency package bytes do not match");
	}
	return { sha256, files, directories, bytes };
}

export async function preparePinnedLibsqlClient({
	repositoryRoot = REPOSITORY_ROOT,
	temporaryDirectory = () =>
		mkdtempSync(join(tmpdir(), "remote-claw-pinned-libsql-")),
} = {}) {
	validatePinnedDependencyDeclarations(repositoryRoot);
	for (const spec of PINNED_LIBSQL_PACKAGES) {
		validatePinnedPackageTree(join(repositoryRoot, spec.packagePath), spec);
	}
	let snapshotRoot;
	try {
		snapshotRoot = temporaryDirectory();
		const snapshotStat = lstatSync(snapshotRoot);
		if (
			!snapshotStat.isDirectory() ||
			snapshotStat.isSymbolicLink() ||
			(snapshotStat.mode & 0o077) !== 0
		) {
			throw new Error("private snapshot unavailable");
		}
		for (const spec of PINNED_LIBSQL_PACKAGES) {
			const source = join(repositoryRoot, spec.packagePath);
			const target = join(snapshotRoot, "node_modules", spec.name);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			cpSync(source, target, {
				recursive: true,
				dereference: false,
				errorOnExist: true,
				force: false,
			});
			validatePinnedPackageTree(target, spec);
		}
		const entrypoint = join(
			snapshotRoot,
			"node_modules",
			"@libsql",
			"client",
			"lib-esm",
			"http.js",
		);
		const loaded = await import(pathToFileURL(entrypoint).href);
		if (typeof loaded.createClient !== "function") {
			throw new Error("pinned libSQL client export is invalid");
		}
		let cleaned = false;
		return {
			createClient: loaded.createClient,
			revalidate() {
				if (cleaned)
					throw new Error("pinned libSQL snapshot is already closed");
				for (const spec of PINNED_LIBSQL_PACKAGES) {
					validatePinnedPackageTree(
						join(snapshotRoot, "node_modules", spec.name),
						spec,
					);
				}
			},
			cleanup() {
				if (cleaned) return;
				cleaned = true;
				rmSync(snapshotRoot, { recursive: true, force: true });
			},
		};
	} catch {
		if (snapshotRoot !== undefined) {
			try {
				rmSync(snapshotRoot, { recursive: true, force: true });
			} catch {
				// The fixed refusal below remains content-free.
			}
		}
		throw new Error("pinned libSQL dependency snapshot could not be prepared");
	}
}

export function validateInspectionBootstrapEnvironment(environment) {
	exactKeys(
		environment,
		[
			...Object.keys(BOOTSTRAP_FIXED_ENVIRONMENT),
			BOOTSTRAP_REPOSITORY_ROOT_FIELD,
		],
		"final-inspection bootstrap environment",
	);
	for (const [key, value] of Object.entries(BOOTSTRAP_FIXED_ENVIRONMENT)) {
		if (environment[key] !== value) {
			throw new Error("final-inspection bootstrap environment is not exact");
		}
	}
	const repositoryRoot = requireNonBlank(
		environment[BOOTSTRAP_REPOSITORY_ROOT_FIELD],
		BOOTSTRAP_REPOSITORY_ROOT_FIELD,
	);
	if (!isAbsolute(repositoryRoot)) {
		throw new Error("final-inspection bootstrap repository is not absolute");
	}
	let canonicalRoot;
	try {
		canonicalRoot = realpathSync(repositoryRoot);
	} catch {
		throw new Error("final-inspection bootstrap repository is unavailable");
	}
	if (canonicalRoot !== repositoryRoot) {
		throw new Error("final-inspection bootstrap repository is not canonical");
	}
	validateTrustedNode();
	return canonicalRoot;
}

export function validateInspectionPublishEnvironment(environment) {
	exactKeys(
		environment,
		[
			...Object.keys(PUBLISH_FIXED_ENVIRONMENT),
			...PUBLISH_PATH_FIELDS,
			...PUBLISH_EVIDENCE_FIELDS,
		],
		"final-inspection publish environment",
	);
	for (const [key, value] of Object.entries(PUBLISH_FIXED_ENVIRONMENT)) {
		if (environment[key] !== value) {
			throw new Error("final-inspection publish environment is not exact");
		}
	}
	for (const field of PUBLISH_PATH_FIELDS) {
		if (!isAbsolute(requireNonBlank(environment[field], field))) {
			throw new Error("final-inspection publish path is not absolute");
		}
	}
	let repositoryRoot;
	try {
		repositoryRoot = realpathSync(environment[BOOTSTRAP_REPOSITORY_ROOT_FIELD]);
	} catch {
		throw new Error("final-inspection publish repository is unavailable");
	}
	if (repositoryRoot !== environment[BOOTSTRAP_REPOSITORY_ROOT_FIELD]) {
		throw new Error("final-inspection publish repository is not canonical");
	}
	validateTrustedNode();
	const stageSha256 = exactString(
		environment.RC_INSPECTION_STAGE_SHA256,
		HASH_PATTERN,
		"staged inspection receipt digest",
	);
	const stageStat = exactString(
		environment.RC_INSPECTION_STAGE_STAT,
		/^[0-9]+:[0-9]+:[1-9][0-9]*$/,
		"staged inspection receipt stat",
	);
	return {
		repositoryRoot,
		topologyReceiptFile: environment.RC_TOPOLOGY_RECEIPT_FILE,
		stageFile: environment.RC_INSPECTION_STAGE_FILE,
		stageEvidence: { sha256: stageSha256, stat: stageStat },
	};
}

export function validateInspectionInput(input) {
	exactKeys(input, INPUT_FIELDS, "final-inspection private input");
	for (const field of INPUT_FIELDS) requireNonBlank(input[field], field);
	if (!isAbsolute(input.RC_TOPOLOGY_RECEIPT_FILE)) {
		throw new Error("RC_TOPOLOGY_RECEIPT_FILE must be absolute");
	}
	return input;
}

export function readInspectionBootstrapInput({
	environment = process.env,
	fd = 0,
	read = readSync,
	statFd = fstatSync,
} = {}) {
	validateInspectionBootstrapEnvironment(environment);
	if (fd !== 0 || environment.RC_INSPECTION_INPUT_FD !== String(fd)) {
		throw new Error(
			"final-inspection bootstrap input descriptor is not pinned",
		);
	}
	let stat;
	try {
		stat = statFd(fd);
	} catch {
		throw new Error(
			"final-inspection bootstrap input descriptor is unavailable",
		);
	}
	if (!stat.isFIFO()) {
		throw new Error(
			"final-inspection bootstrap input descriptor is not a pipe",
		);
	}
	const chunks = [];
	let total = 0;
	while (true) {
		const buffer = Buffer.alloc(Math.min(4_096, MAX_INPUT_BYTES + 1 - total));
		const bytesRead = read(fd, buffer, 0, buffer.length, null);
		if (
			!Number.isInteger(bytesRead) ||
			bytesRead < 0 ||
			bytesRead > buffer.length
		) {
			throw new Error("final-inspection bootstrap input read was invalid");
		}
		if (bytesRead === 0) break;
		total += bytesRead;
		if (total > MAX_INPUT_BYTES) {
			throw new Error("final-inspection bootstrap input is oversized");
		}
		chunks.push(buffer.subarray(0, bytesRead));
	}
	const raw = Buffer.concat(chunks, total);
	try {
		if (raw.length === 0 || raw.at(-1) !== 0) {
			throw new Error("final-inspection bootstrap input is incomplete");
		}
		const fields = [];
		let start = 0;
		for (let index = 0; index < raw.length; index += 1) {
			if (raw[index] !== 0) continue;
			let decoded;
			try {
				decoded = new TextDecoder("utf-8", { fatal: true }).decode(
					raw.subarray(start, index),
				);
			} catch {
				throw new Error("final-inspection bootstrap input is not valid UTF-8");
			}
			fields.push(decoded);
			start = index + 1;
		}
		if (start !== raw.length || fields.length !== INPUT_FIELDS.length) {
			throw new Error(
				"final-inspection bootstrap input field count is invalid",
			);
		}
		return validateInspectionInput(
			Object.freeze(
				Object.fromEntries(
					INPUT_FIELDS.map((name, index) => [name, fields[index]]),
				),
			),
		);
	} finally {
		raw.fill(0);
		for (const chunk of chunks) chunk.fill(0);
	}
}

function validateTopologyReceipt(receipt) {
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
		"topology receipt",
	);
	if (
		receipt.schema !== TOPOLOGY_SCHEMA ||
		receipt.inspectionStatus !== "pending"
	) {
		throw new Error("topology receipt is not an inspectable v4 browser leg");
	}
	exactString(receipt.runId, UUID_V4_PATTERN, "topology run id");
	exactString(receipt.headSha, /^[0-9a-f]{40}$/, "topology HEAD");
	exactString(
		receipt.githubDeploymentId,
		/^[1-9][0-9]*$/,
		"GitHub deployment id",
	);
	exactString(
		receipt.packedTarballSha256,
		HASH_PATTERN,
		"packed tarball digest",
	);
	exactString(
		receipt.trustedOrigin,
		IMMUTABLE_PREVIEW_ORIGIN_PATTERN,
		"trusted Preview origin",
	);
	const compactRunId = receipt.runId.replaceAll("-", "");
	if (receipt.plaintextScanNeedle !== `RC_PLAINTEXT_SCAN_${compactRunId}`) {
		throw new Error("topology plaintext needle is not bound to the run");
	}
	exactKeys(receipt.logCanaries, ["begin", "end"], "topology log canaries");
	if (
		receipt.logCanaries.begin !==
			`RC_RELEASE_PROOF_LOG_BEGIN_${compactRunId}` ||
		receipt.logCanaries.end !== `RC_RELEASE_PROOF_LOG_END_${compactRunId}`
	) {
		throw new Error("topology log canaries are not bound to the run");
	}
	exactKeys(
		receipt.proofWindow,
		["completedAtMs", "startedAtMs"],
		"topology proof window",
	);
	const startedAtMs = safeInteger(
		receipt.proofWindow.startedAtMs,
		"proof window start",
		{
			positive: true,
		},
	);
	const completedAtMs = safeInteger(
		receipt.proofWindow.completedAtMs,
		"proof window completion",
		{ positive: true },
	);
	if (
		completedAtMs < startedAtMs ||
		completedAtMs - startedAtMs > MAX_PROOF_WINDOW_MS
	) {
		throw new Error("topology proof window is invalid");
	}
	exactKeys(
		receipt.runtimeAttestation,
		["environment", "sha", "storage"],
		"runtime attestation",
	);
	exactKeys(
		receipt.runtimeAttestation.storage,
		["backend", "group", "locator", "organization", "scope"],
		"runtime storage attestation",
	);
	const storage = receipt.runtimeAttestation.storage;
	const organization = coordinate(storage.organization, "Turso organization");
	const group = coordinate(storage.group, "Turso group");
	const scope = coordinate(storage.scope, "Turso scope");
	if (
		receipt.runtimeAttestation.environment !== "preview" ||
		receipt.runtimeAttestation.sha !== receipt.headSha ||
		storage.backend !== "sqlite" ||
		storage.locator !== "turso" ||
		scope !== `pr-${receipt.headSha.slice(0, 7)}`
	) {
		throw new Error("topology runtime storage attestation is invalid");
	}
	exactKeys(
		receipt.edgeRateLimit,
		[
			"algorithm",
			"excessAction",
			"firewallBypassCount",
			"firewallConfigId",
			"firewallConfigVersion",
			"key",
			"limit",
			"pathPrefix",
			"projectId",
			"ruleId",
			"ruleName",
			"teamId",
			"windowSeconds",
		],
		"edge-rate-limit receipt",
	);
	if (
		receipt.edgeRateLimit.projectId !== VERCEL_PROJECT_ID ||
		receipt.edgeRateLimit.teamId !== VERCEL_TEAM_ID ||
		receipt.edgeRateLimit.firewallConfigId !== WAF_CONFIG_ID ||
		receipt.edgeRateLimit.firewallConfigVersion !== 3 ||
		receipt.edgeRateLimit.ruleId !== WAF_RULE_ID ||
		receipt.edgeRateLimit.ruleName !== "handoff-per-ip-rate-limit" ||
		receipt.edgeRateLimit.pathPrefix !== "/api/handoff" ||
		receipt.edgeRateLimit.algorithm !== "token_bucket" ||
		receipt.edgeRateLimit.limit !== 20 ||
		receipt.edgeRateLimit.windowSeconds !== 60 ||
		receipt.edgeRateLimit.key !== "ip" ||
		receipt.edgeRateLimit.excessAction !== "deny" ||
		receipt.edgeRateLimit.firewallBypassCount !== 0
	) {
		throw new Error("topology Vercel coordinates are invalid");
	}
	exactKeys(
		receipt.browser,
		["name", "project", "result", "version"],
		"browser receipt",
	);
	if (
		receipt.browser.name !== "chromium" ||
		receipt.browser.project !== "mobile-chromium" ||
		receipt.browser.result !== "passed" ||
		typeof receipt.browser.version !== "string" ||
		!/^[0-9]+(?:\.[0-9]+){1,4}$/.test(receipt.browser.version)
	) {
		throw new Error("topology browser result did not pass");
	}
	exactKeys(
		receipt.claude,
		["arch", "binaryBytes", "executableSha256", "platform", "version"],
		"Claude receipt",
	);
	exactString(
		receipt.claude.executableSha256,
		HASH_PATTERN,
		"Claude executable digest",
	);
	if (
		receipt.claude.version !== PINNED_CLAUDE_VERSION ||
		receipt.claude.platform !== "linux" ||
		receipt.claude.arch !== "arm64" ||
		receipt.claude.executableSha256 !== PINNED_CLAUDE_EXECUTABLE_SHA256 ||
		receipt.claude.binaryBytes !== 331_864_296
	) {
		throw new Error("topology Claude tuple is not pinned");
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
		receipt.streamRotation.routeRotateMs !== 240_000 ||
		!Number.isSafeInteger(receipt.streamRotation.observedElapsedMs) ||
		receipt.streamRotation.observedElapsedMs < 235_000 ||
		receipt.streamRotation.observedElapsedMs > 270_000 ||
		receipt.streamRotation.browserObserved !== true ||
		receipt.streamRotation.browserReconnected !== true ||
		receipt.streamRotation.postRotationTurn !== "assertions_passed"
	) {
		throw new Error("topology stream-rotation evidence is invalid");
	}
	return {
		...receipt,
		proofWindow: { startedAtMs, completedAtMs },
		runtimeAttestation: {
			...receipt.runtimeAttestation,
			storage: { ...storage, organization, group, scope },
		},
	};
}

function sameFileIdentity(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.nlink === right.nlink &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

export function readTopologyReceipt(
	path,
	{
		lstat = lstatSync,
		openFile = openSync,
		statFd = fstatSync,
		readFile = readFileSync,
		closeFile = closeSync,
		realpath = realpathSync,
	} = {},
) {
	if (!isAbsolute(path))
		throw new Error("topology receipt path must be absolute");
	const parent = dirname(path);
	const parentStat = lstat(parent);
	if (
		realpath(parent) !== parent ||
		!parentStat.isDirectory() ||
		parentStat.isSymbolicLink() ||
		(parentStat.mode & 0o777) !== 0o700 ||
		(typeof process.getuid === "function" &&
			parentStat.uid !== process.getuid())
	) {
		throw new Error(
			"topology receipt parent is not a canonical private owned directory",
		);
	}
	const pathStat = lstat(path);
	if (
		!pathStat.isFile() ||
		pathStat.isSymbolicLink() ||
		(pathStat.mode & 0o777) !== 0o600 ||
		pathStat.nlink !== 1 ||
		pathStat.size < 2 ||
		pathStat.size > MAX_TOPOLOGY_RECEIPT_BYTES ||
		(typeof process.getuid === "function" && pathStat.uid !== process.getuid())
	) {
		throw new Error(
			"topology receipt is not a bounded private owned regular file",
		);
	}
	let descriptor;
	let raw;
	let closeFailed = false;
	let result;
	let failure;
	try {
		descriptor = openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = statFd(descriptor);
		if (!sameFileIdentity(pathStat, before)) {
			throw new Error("topology receipt identity changed before it was read");
		}
		raw = readFile(descriptor);
		if (!Buffer.isBuffer(raw) || raw.length !== before.size) {
			throw new Error("topology receipt read was incomplete");
		}
		const after = statFd(descriptor);
		const finalPathStat = lstat(path);
		if (
			!sameFileIdentity(before, after) ||
			!sameFileIdentity(before, finalPathStat)
		) {
			throw new Error("topology receipt identity changed while it was read");
		}
		let text;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
		} catch {
			throw new Error("topology receipt is not valid UTF-8");
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("topology receipt is not valid JSON");
		}
		result = {
			receipt: validateTopologyReceipt(parsed),
			receiptSha256: sha256Bytes(raw),
		};
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("topology receipt")
		) {
			failure = error;
		} else {
			failure = new Error("topology receipt could not be read safely");
		}
	} finally {
		if (raw !== undefined) raw.fill(0);
		if (descriptor !== undefined) {
			try {
				closeFile(descriptor);
			} catch {
				closeFailed = true;
			}
		}
	}
	if (closeFailed)
		throw new Error("topology receipt descriptor could not be closed safely");
	if (failure !== undefined) throw failure;
	return result;
}

async function readBoundedJson(
	response,
	label,
	maximumBytes = MAX_PROVIDER_RESPONSE_BYTES,
	operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
) {
	let body;
	const chunks = [];
	let reader;
	const deadline = performance.now() + operationTimeoutMs;
	try {
		if (response.body === null) throw new Error("missing body");
		reader = response.body.getReader();
		let total = 0;
		while (true) {
			const remaining = Math.ceil(deadline - performance.now());
			if (remaining < 1) throw new Error("body deadline");
			const { done, value } = await withTimeout(
				reader.read(),
				remaining,
				`${label} body read`,
			);
			if (done) break;
			total += value.byteLength;
			if (total > maximumBytes) {
				throw new Error("oversized");
			}
			chunks.push(value);
		}
		const raw = Buffer.concat(
			chunks.map((chunk) => Buffer.from(chunk)),
			total,
		);
		try {
			body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		} finally {
			raw.fill(0);
		}
	} catch {
		if (reader !== undefined) {
			try {
				const cancelTimeoutMs = Math.max(
					1,
					Math.min(1_000, Math.ceil(deadline - performance.now())),
				);
				await withTimeout(
					reader.cancel(),
					cancelTimeoutMs,
					`${label} body cancel`,
				);
			} catch {
				// The fixed outer error remains the only observable failure.
			}
		}
		throw new Error(`${label} response is malformed or oversized`);
	} finally {
		for (const chunk of chunks) chunk.fill(0);
	}
	return body;
}

function assertWithinDeadline(deadlineAt, now, label) {
	if (now() > deadlineAt) throw new Error(`${label} exceeded its deadline`);
}

function remainingOperationTimeout(deadlineAt, now, maximumMs, label) {
	if (!Number.isSafeInteger(maximumMs) || maximumMs < 1) {
		throw new Error(`${label} operation timeout is invalid`);
	}
	const remaining = Math.floor(deadlineAt - now());
	if (!Number.isSafeInteger(remaining) || remaining < 1) {
		throw new Error(`${label} exceeded its deadline`);
	}
	return Math.min(maximumMs, remaining);
}

function withTimeout(promise, timeoutMs, label) {
	let timer;
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} timed out`)),
				timeoutMs,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

export async function listTursoDatabases({
	organization,
	group,
	token,
	fetchImpl = fetch,
	operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
	now = Date.now,
	deadlineAt = now() + operationTimeoutMs,
}) {
	const org = coordinate(organization, "Turso organization");
	const groupName = coordinate(group, "Turso group");
	const apiToken = requireNonBlank(token, "TURSO_API_TOKEN");
	const url = new URL(
		`/v1/organizations/${encodeURIComponent(org)}/databases`,
		TURSO_API_ORIGIN,
	);
	url.searchParams.set("group", groupName);
	let response;
	try {
		const requestTimeoutMs = remainingOperationTimeout(
			deadlineAt,
			now,
			operationTimeoutMs,
			"Turso fleet enumeration",
		);
		response = await withTimeout(
			fetchImpl(url, {
				redirect: "error",
				signal: AbortSignal.timeout(requestTimeoutMs),
				headers: {
					accept: "application/json",
					authorization: `Bearer ${apiToken}`,
				},
			}),
			requestTimeoutMs,
			"Turso fleet enumeration request",
		);
	} catch {
		throw new Error("Turso fleet enumeration request failed");
	}
	if (response.status !== 200) {
		throw new Error(
			`Turso fleet enumeration failed with HTTP ${response.status}`,
		);
	}
	const body = await readBoundedJson(
		response,
		"Turso fleet enumeration",
		4 * 1_024 * 1_024,
		remainingOperationTimeout(
			deadlineAt,
			now,
			operationTimeoutMs,
			"Turso fleet enumeration",
		),
	);
	exactKeys(body, ["databases"], "Turso fleet enumeration");
	if (!Array.isArray(body.databases) || body.databases.length > MAX_DATABASES) {
		throw new Error("Turso fleet enumeration exceeded its database cap");
	}
	const seen = new Set();
	const all = body.databases.map((database) => {
		if (
			database === null ||
			typeof database !== "object" ||
			Array.isArray(database)
		) {
			throw new Error("Turso fleet enumeration contains a malformed database");
		}
		const name = exactString(
			database.Name,
			/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/,
			"Turso database name",
		);
		const hostname = exactString(
			database.Hostname,
			/^[a-z0-9.-]+\.turso\.io$/,
			"Turso database hostname",
		);
		const id = exactString(
			database.DbId,
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			"Turso database id",
		);
		const primaryRegion =
			database.primaryRegion === undefined
				? undefined
				: exactString(
						database.primaryRegion,
						TURSO_REGION_PATTERN,
						"Turso database primary region",
					);
		const legacyHostname = `${name}-${org}.turso.io`;
		const regionalHostname =
			primaryRegion === undefined
				? undefined
				: `${name}-${org}.${primaryRegion}.turso.io`;
		if (
			database.group !== groupName ||
			(hostname !== legacyHostname && hostname !== regionalHostname) ||
			seen.has(name)
		) {
			throw new Error(
				"Turso fleet enumeration is not bound to the attested group",
			);
		}
		seen.add(name);
		return { name, hostname, id };
	});
	return all.sort((left, right) => left.name.localeCompare(right.name));
}

function scanValue(value, needleBytes, counters) {
	counters.valueCount += 1;
	if (counters.valueCount > MAX_VALUES)
		throw new Error("Turso scan exceeded its value cap");
	if (value === null || typeof value === "number" || typeof value === "bigint")
		return;
	let bytes;
	if (typeof value === "string") bytes = Buffer.from(value, "utf8");
	else if (value instanceof Uint8Array) bytes = Buffer.from(value);
	else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
	else if (typeof value === "boolean") return;
	else throw new Error("Turso scan encountered an unsupported SQLite value");
	try {
		counters.valueBytes += bytes.byteLength;
		if (counters.valueBytes > MAX_VALUE_BYTES) {
			throw new Error("Turso scan exceeded its byte cap");
		}
		if (bytes.includes(needleBytes)) {
			throw new Error(
				"Turso plaintext inspection found the release-proof needle",
			);
		}
	} finally {
		if (typeof value === "string") bytes.fill(0);
	}
}

function scanResult(result, needleBytes, counters) {
	if (!Array.isArray(result?.columns) || !Array.isArray(result?.rows)) {
		throw new Error("Turso scan received a malformed query result");
	}
	for (const column of result.columns) {
		if (typeof column !== "string")
			throw new Error("Turso scan received a malformed column name");
	}
	for (const row of result.rows) {
		if (row === null || typeof row !== "object") {
			throw new Error("Turso scan received a malformed row");
		}
		for (let index = 0; index < result.columns.length; index += 1) {
			const column = result.columns[index];
			const value = resultCell(row, column, index);
			if (value === undefined)
				throw new Error("Turso scan query result omitted a cell");
			scanValue(value, needleBytes, counters);
		}
	}
	return result.rows;
}

function resultCell(row, name, index) {
	const indexed = row[index];
	return indexed === undefined ? row[name] : indexed;
}

function quoteIdentifier(value) {
	return `"${value.replaceAll('"', '""')}"`;
}

async function closeQuietly(resource, operationTimeoutMs) {
	if (
		resource === undefined ||
		resource === null ||
		typeof resource.close !== "function"
	)
		return;
	try {
		await withTimeout(
			resource.close(),
			operationTimeoutMs,
			"Turso snapshot close",
		);
	} catch {
		throw new Error("Turso snapshot close failed");
	}
}

async function closeTursoResources({
	transaction,
	client,
	operationTimeoutMs,
	deadlineAt,
	now,
}) {
	let closeFailed = false;
	for (const resource of [transaction, client]) {
		// Cleanup is always attempted for both handles. If the work budget is already spent,
		// one millisecond still permits a synchronous client abort without extending the wall.
		const remaining = Math.max(
			1,
			Math.min(operationTimeoutMs, Math.floor(deadlineAt - now())),
		);
		try {
			await closeQuietly(resource, remaining);
		} catch {
			closeFailed = true;
		}
	}
	if (closeFailed) throw new Error("Turso snapshot close failed");
}

export async function scanTursoFleet({
	databases,
	authToken,
	needle,
	createClientImpl,
	now = Date.now,
	deadlineAt = now() + DEFAULT_OVERALL_DEADLINE_MS,
	operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
}) {
	if (
		!Array.isArray(databases) ||
		databases.length < 1 ||
		databases.length > MAX_DATABASES
	) {
		throw new Error("Turso scan requires a nonempty bounded database fleet");
	}
	if (typeof createClientImpl !== "function") {
		throw new Error("Turso scan requires the pinned libSQL client");
	}
	const groupToken = requireNonBlank(authToken, "TURSO_GROUP_AUTH_TOKEN");
	const needleString = exactString(
		needle,
		/^RC_PLAINTEXT_SCAN_[0-9a-f]{32}$/,
		"plaintext scan needle",
	);
	const needleBytes = Buffer.from(needleString, "utf8");
	const counters = {
		tableCount: 0,
		columnCount: 0,
		rowCount: 0,
		valueCount: 0,
		valueBytes: 0,
	};
	try {
		for (const database of databases) {
			assertWithinDeadline(deadlineAt, now, "Turso fleet scan");
			const client = createClientImpl({
				url: `libsql://${database.hostname}`,
				authToken: groupToken,
			});
			let transaction;
			try {
				transaction = await withTimeout(
					client.transaction("read"),
					remainingOperationTimeout(
						deadlineAt,
						now,
						operationTimeoutMs,
						"Turso fleet scan",
					),
					"Turso read snapshot",
				);
				const execute = async (statement) => {
					return withTimeout(
						transaction.execute(statement),
						remainingOperationTimeout(
							deadlineAt,
							now,
							operationTimeoutMs,
							"Turso fleet scan",
						),
						"Turso snapshot query",
					);
				};
				const schemaResult = await execute(
					"SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name",
				);
				const schemaRows = scanResult(schemaResult, needleBytes, counters);
				const tables = [];
				for (const row of schemaRows) {
					const type = resultCell(row, "type", 0);
					const name = resultCell(row, "name", 1);
					if (type === "table") {
						if (typeof name !== "string" || name === "") {
							throw new Error(
								"Turso sqlite_schema contains a malformed table name",
							);
						}
						tables.push({
							name,
							sql: resultCell(row, "sql", 3),
						});
					}
				}
				for (const table of tables) {
					const tableName = table.name;
					counters.tableCount += 1;
					if (counters.tableCount > MAX_TABLES) {
						throw new Error("Turso scan exceeded its table cap");
					}
					const pragma = await execute(
						`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`,
					);
					scanResult(pragma, needleBytes, counters);
					counters.columnCount += pragma.rows.length;
					if (pragma.rows.length < 1 || counters.columnCount > MAX_COLUMNS) {
						throw new Error("Turso scan exceeded its column cap");
					}
					const columns = pragma.rows.map((row) => {
						const name = resultCell(row, "name", 1);
						const pk = resultCell(row, "pk", 5);
						if (
							typeof name !== "string" ||
							name === "" ||
							!Number.isSafeInteger(pk) ||
							pk < 0
						) {
							throw new Error("Turso table_xinfo contains a malformed column");
						}
						return { name, pk };
					});
					const projection = columns
						.map((column) => quoteIdentifier(column.name))
						.join(", ");
					const countResult = await execute(
						`SELECT COUNT(*) AS ${quoteIdentifier("rc_scan_count")} FROM ${quoteIdentifier(tableName)}`,
					);
					scanResult(countResult, needleBytes, counters);
					if (countResult.rows.length !== 1)
						throw new Error("Turso row count is malformed");
					const rawCount = resultCell(countResult.rows[0], "rc_scan_count", 0);
					const tableRowCount =
						typeof rawCount === "bigint" ? Number(rawCount) : rawCount;
					if (
						!Number.isSafeInteger(tableRowCount) ||
						tableRowCount < 0 ||
						tableRowCount > MAX_ROWS_PER_TABLE ||
						counters.rowCount + tableRowCount > MAX_ROWS
					) {
						throw new Error("Turso scan exceeded its row cap");
					}
					const names = new Set(
						columns.map((column) => column.name.toLowerCase()),
					);
					const withoutRowid =
						typeof table.sql === "string" &&
						/\bWITHOUT\s+ROWID\b/i.test(table.sql);
					const rowidAlias = withoutRowid
						? undefined
						: ["_rowid_", "rowid", "oid"].find(
								(candidate) => !names.has(candidate),
							);
					const primaryKey = columns
						.filter((column) => column.pk > 0)
						.sort((left, right) => left.pk - right.pk)
						.map((column) => column.name);
					const order =
						rowidAlias !== undefined
							? quoteIdentifier(rowidAlias)
							: withoutRowid && primaryKey.length > 0
								? primaryKey.map(quoteIdentifier).join(", ")
								: columns
										.flatMap((column) => {
											const name = quoteIdentifier(column.name);
											return [
												`typeof(${name}) COLLATE BINARY`,
												`hex(CAST(${name} AS BLOB)) COLLATE BINARY`,
											];
										})
										.join(", ");
					let scannedRows = 0;
					if (tableRowCount > 0) {
						// WITHOUT ROWID tables use their unique PK; ordinary tables use an unshadowed
						// rowid alias. The pathological all-aliases-shadowed/no-PK case orders by each
						// value's type and binary bytes, overriding declared collations. Any remaining
						// ties are byte-identical for the plaintext property.
						let offset = 0;
						while (offset < tableRowCount) {
							const result = await execute(
								`SELECT ${projection} FROM ${quoteIdentifier(tableName)} ORDER BY ${order} LIMIT ${ROW_PAGE_SIZE} OFFSET ${offset}`,
							);
							scanResult(result, needleBytes, counters);
							if (
								result.rows.length < 1 ||
								result.rows.length > tableRowCount - offset
							) {
								throw new Error("Turso ordered snapshot paging is incomplete");
							}
							offset += result.rows.length;
						}
						scannedRows = offset;
					}
					if (scannedRows !== tableRowCount) {
						throw new Error(
							"Turso snapshot row count changed during inspection",
						);
					}
					counters.rowCount += scannedRows;
				}
			} finally {
				await closeTursoResources({
					transaction,
					client,
					operationTimeoutMs,
					deadlineAt,
					now,
				});
			}
		}
		return { ...counters, plaintextMatchCount: 0 };
	} catch {
		throw new Error("Turso content inspection failed");
	} finally {
		needleBytes.fill(0);
	}
}

export async function resolveImmutableVercelDeployment({
	origin,
	headSha,
	teamId,
	projectId,
	token,
	fetchImpl = fetch,
	operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
	now = Date.now,
	deadlineAt = now() + operationTimeoutMs,
}) {
	const trustedOrigin = exactString(
		origin,
		IMMUTABLE_PREVIEW_ORIGIN_PATTERN,
		"trusted Preview origin",
	);
	const expectedHead = exactString(headSha, /^[0-9a-f]{40}$/, "topology HEAD");
	if (teamId !== VERCEL_TEAM_ID || projectId !== VERCEL_PROJECT_ID) {
		throw new Error("Vercel deployment coordinates are not pinned");
	}
	const vercelToken = requireNonBlank(token, "VERCEL_TOKEN");
	const hostname = new URL(trustedOrigin).hostname;
	const url = new URL(
		`/v13/deployments/${encodeURIComponent(hostname)}`,
		VERCEL_API_ORIGIN,
	);
	url.searchParams.set("teamId", teamId);
	let response;
	try {
		const requestTimeoutMs = remainingOperationTimeout(
			deadlineAt,
			now,
			operationTimeoutMs,
			"Vercel immutable deployment resolution",
		);
		response = await withTimeout(
			fetchImpl(url, {
				redirect: "error",
				signal: AbortSignal.timeout(requestTimeoutMs),
				headers: {
					accept: "application/json",
					authorization: `Bearer ${vercelToken}`,
				},
			}),
			requestTimeoutMs,
			"Vercel immutable deployment request",
		);
	} catch {
		throw new Error("Vercel immutable deployment request failed");
	}
	if (response.status !== 200) {
		throw new Error(
			`Vercel immutable deployment resolution failed with HTTP ${response.status}`,
		);
	}
	const deployment = await readBoundedJson(
		response,
		"Vercel immutable deployment resolution",
		2 * 1_024 * 1_024,
		remainingOperationTimeout(
			deadlineAt,
			now,
			operationTimeoutMs,
			"Vercel immutable deployment resolution",
		),
	);
	if (
		deployment === null ||
		typeof deployment !== "object" ||
		Array.isArray(deployment)
	) {
		throw new Error("Vercel immutable deployment resolution is malformed");
	}
	const deploymentId = exactString(
		deployment.id,
		/^dpl_[A-Za-z0-9]+$/,
		"Vercel deployment id",
	);
	const resolvedProjectId = deployment.projectId ?? deployment.project?.id;
	if (
		deployment.url !== hostname ||
		resolvedProjectId !== projectId ||
		(deployment.projectId !== undefined &&
			deployment.projectId !== projectId) ||
		(deployment.project?.id !== undefined &&
			deployment.project.id !== projectId) ||
		deployment.ownerId !== teamId ||
		(deployment.teamId !== undefined && deployment.teamId !== teamId) ||
		deployment.target !== null ||
		deployment.readyState !== "READY" ||
		deployment.status !== "READY" ||
		deployment.meta?.githubCommitSha !== expectedHead ||
		deployment.gitSource?.type !== "github" ||
		deployment.gitSource.sha !== expectedHead
	) {
		throw new Error(
			"Vercel deployment does not match the immutable Preview receipt",
		);
	}
	return { deploymentId, hostname };
}

function occurrenceCount(value, needle) {
	if (needle.length === 0) return 0;
	let count = 0;
	let offset = 0;
	while (true) {
		const index = value.indexOf(needle, offset);
		if (index < 0) return count;
		count += 1;
		offset = index + needle.length;
	}
}

function scanNestedLogValue(value, targets, counters, key = "") {
	if (typeof value === "string") {
		if (value.includes(targets.plaintextNeedle))
			counters.plaintextMatchCount += 1;
		counters.beginCanaryCount += occurrenceCount(value, targets.beginCanary);
		counters.endCanaryCount += occurrenceCount(value, targets.endCanary);
		return;
	}
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		const encoded = Buffer.from(value);
		try {
			const needle = Buffer.from(targets.plaintextNeedle, "utf8");
			const begin = Buffer.from(targets.beginCanary, "utf8");
			const end = Buffer.from(targets.endCanary, "utf8");
			try {
				if (encoded.includes(needle)) counters.plaintextMatchCount += 1;
				if (encoded.includes(begin)) counters.beginCanaryCount += 1;
				if (encoded.includes(end)) counters.endCanaryCount += 1;
			} finally {
				needle.fill(0);
				begin.fill(0);
				end.fill(0);
			}
		} finally {
			if (value instanceof ArrayBuffer) encoded.fill(0);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) scanNestedLogValue(item, targets, counters, key);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [nestedKey, nestedValue] of Object.entries(value)) {
			scanNestedLogValue(nestedKey, targets, counters);
			if (/truncat/i.test(nestedKey)) {
				if (nestedValue === true) counters.truncatedCount += 1;
				else if (nestedValue !== false) counters.malformedCount += 1;
			}
			scanNestedLogValue(nestedValue, targets, counters, nestedKey);
		}
		return;
	}
	if (
		value !== null &&
		typeof value !== "number" &&
		typeof value !== "boolean" &&
		typeof value !== "undefined"
	) {
		counters.malformedCount += 1;
	}
	void key;
}

function rowTimestamp(row) {
	const raw = row.timestamp;
	const timestamp =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? Date.parse(raw)
				: Number.NaN;
	if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
		throw new Error("Vercel runtime-log row has an invalid timestamp");
	}
	return timestamp;
}

function validateLogRow(row, deploymentId, counters) {
	if (row === null || typeof row !== "object" || Array.isArray(row)) {
		counters.malformedCount += 1;
		throw new Error("Vercel runtime-log response contains a malformed row");
	}
	let timestamp;
	try {
		timestamp = rowTimestamp(row);
	} catch (error) {
		counters.malformedCount += 1;
		throw error;
	}
	if (row.deploymentId !== deploymentId) {
		counters.wrongDeploymentCount += 1;
		throw new Error(
			"Vercel runtime-log response contains the wrong deployment",
		);
	}
	if (
		typeof row.requestId !== "string" ||
		row.requestId === "" ||
		Buffer.byteLength(row.requestId, "utf8") > 512 ||
		!Array.isArray(row.logs)
	) {
		counters.malformedCount += 1;
		throw new Error(
			"Vercel runtime-log response contains a malformed request row",
		);
	}
	if (
		row.logs.some(
			(line) =>
				line === null || typeof line !== "object" || Array.isArray(line),
		)
	) {
		counters.malformedCount += 1;
		throw new Error(
			"Vercel runtime-log response contains a malformed log line",
		);
	}
	return { timestamp, requestId: row.requestId };
}

async function fetchVercelLogShard({
	projectId,
	teamId,
	deploymentId,
	startDate,
	endDate,
	token,
	fetchImpl,
	operationTimeoutMs,
	now,
	deadlineAt,
}) {
	const query = new URLSearchParams();
	query.set("projectId", projectId);
	query.set("ownerId", teamId);
	query.set("page", "0");
	query.set("startDate", String(startDate));
	query.set("endDate", String(endDate));
	query.set("deploymentId", deploymentId);
	let response;
	try {
		const requestTimeoutMs = remainingOperationTimeout(
			deadlineAt,
			now,
			operationTimeoutMs,
			"Vercel runtime-log scan",
		);
		response = await withTimeout(
			fetchImpl(`${VERCEL_LOG_ORIGIN}/api/logs/request-logs?${query}`, {
				redirect: "error",
				signal: AbortSignal.timeout(requestTimeoutMs),
				headers: {
					accept: "application/json",
					authorization: `Bearer ${token}`,
				},
			}),
			requestTimeoutMs,
			"Vercel runtime-log request",
		);
	} catch {
		throw new Error("Vercel runtime-log request failed");
	}
	if (response.status !== 200) {
		throw new Error(
			`Vercel runtime-log query failed with HTTP ${response.status}`,
		);
	}
	const body = await readBoundedJson(
		response,
		"Vercel runtime-log query",
		MAX_PROVIDER_RESPONSE_BYTES,
		remainingOperationTimeout(
			deadlineAt,
			now,
			operationTimeoutMs,
			"Vercel runtime-log scan",
		),
	);
	exactKeys(body, ["hasMoreRows", "rows"], "Vercel runtime-log query");
	if (!Array.isArray(body.rows) || typeof body.hasMoreRows !== "boolean") {
		throw new Error(
			"Vercel runtime-log query has no explicit completeness signal",
		);
	}
	if (body.rows.length > MAX_LOG_ROWS) {
		throw new Error("Vercel runtime-log query exceeded its row cap");
	}
	return body;
}

export async function scanVercelLogSnapshot({
	projectId,
	teamId,
	deploymentId,
	windowStartedAtMs,
	windowCompletedAtMs,
	token,
	plaintextNeedle,
	beginCanary,
	endCanary,
	fetchImpl = fetch,
	now = Date.now,
	deadlineAt = now() + DEFAULT_OVERALL_DEADLINE_MS,
	operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
}) {
	if (projectId !== VERCEL_PROJECT_ID || teamId !== VERCEL_TEAM_ID) {
		throw new Error("Vercel runtime-log coordinates are not pinned");
	}
	exactString(deploymentId, /^dpl_[A-Za-z0-9]+$/, "Vercel deployment id");
	safeInteger(windowStartedAtMs, "runtime-log window start", {
		positive: true,
	});
	safeInteger(windowCompletedAtMs, "runtime-log window completion", {
		positive: true,
	});
	if (windowCompletedAtMs < windowStartedAtMs)
		throw new Error("runtime-log window is invalid");
	const vercelToken = requireNonBlank(token, "VERCEL_TOKEN");
	const targets = {
		plaintextNeedle: exactString(
			plaintextNeedle,
			/^RC_PLAINTEXT_SCAN_[0-9a-f]{32}$/,
			"plaintext scan needle",
		),
		beginCanary: exactString(
			beginCanary,
			/^RC_RELEASE_PROOF_LOG_BEGIN_[0-9a-f]{32}$/,
			"BEGIN log canary",
		),
		endCanary: exactString(
			endCanary,
			/^RC_RELEASE_PROOF_LOG_END_[0-9a-f]{32}$/,
			"END log canary",
		),
	};
	const counters = {
		queryCount: 0,
		exhaustedLeafCount: 0,
		wrongDeploymentCount: 0,
		malformedCount: 0,
		truncatedCount: 0,
		saturatedLeafCount: 0,
		plaintextMatchCount: 0,
		beginCanaryCount: 0,
		endCanaryCount: 0,
	};
	const retained = new Map();

	const visit = async (startDate, endDate) => {
		assertWithinDeadline(deadlineAt, now, "Vercel runtime-log scan");
		counters.queryCount += 1;
		if (counters.queryCount > MAX_LOG_QUERIES) {
			throw new Error("Vercel runtime-log scan exceeded its query cap");
		}
		const page = await fetchVercelLogShard({
			projectId,
			teamId,
			deploymentId,
			startDate,
			endDate,
			token: vercelToken,
			fetchImpl,
			operationTimeoutMs,
			now,
			deadlineAt,
		});
		for (const row of page.rows) {
			validateLogRow(row, deploymentId, counters);
			const preflight = {
				plaintextMatchCount: 0,
				beginCanaryCount: 0,
				endCanaryCount: 0,
				truncatedCount: 0,
				malformedCount: 0,
			};
			scanNestedLogValue(row, targets, preflight);
			counters.plaintextMatchCount += preflight.plaintextMatchCount;
			counters.truncatedCount += preflight.truncatedCount;
			counters.malformedCount += preflight.malformedCount;
			if (preflight.plaintextMatchCount > 0) {
				throw new Error("Vercel runtime-log inspection did not pass");
			}
			if (preflight.truncatedCount > 0 || preflight.malformedCount > 0) {
				throw new Error(
					"Vercel runtime-log response is truncated or malformed",
				);
			}
		}
		if (page.hasMoreRows) {
			if (startDate === endDate) {
				counters.saturatedLeafCount += 1;
				throw new Error("Vercel runtime-log scan saturated a 1ms leaf");
			}
			const width = endDate - startDate;
			if (width === 1) {
				await visit(startDate, startDate);
				await visit(endDate, endDate);
				return;
			}
			const midpoint = Math.floor((startDate + endDate) / 2);
			await visit(startDate, midpoint);
			// The shared midpoint is a one-millisecond halo; request-id/canonical-row dedupe below
			// makes the overlap harmless while preventing a boundary row from falling between shards.
			await visit(midpoint, endDate);
			return;
		}
		counters.exhaustedLeafCount += 1;
		for (const row of page.rows) {
			const { timestamp, requestId } = validateLogRow(
				row,
				deploymentId,
				counters,
			);
			if (timestamp < startDate || timestamp > endDate) continue;
			if (timestamp < windowStartedAtMs || timestamp > windowCompletedAtMs)
				continue;
			const canonical = stableJson(row);
			const digest = sha256Bytes(canonical);
			const previous = retained.get(requestId);
			if (previous !== undefined && previous.digest !== digest) {
				counters.malformedCount += 1;
				throw new Error(
					"Vercel runtime-log request row changed within one snapshot",
				);
			}
			retained.set(requestId, { row, digest });
			if (retained.size > MAX_LOG_ROWS) {
				throw new Error("Vercel runtime-log snapshot exceeded its request cap");
			}
		}
	};

	await visit(windowStartedAtMs, windowCompletedAtMs);
	let logLineCount = 0;
	for (const { row } of retained.values()) {
		logLineCount += row.logs.length;
		scanNestedLogValue(row, targets, counters);
	}
	if (
		counters.wrongDeploymentCount !== 0 ||
		counters.malformedCount !== 0 ||
		counters.truncatedCount !== 0 ||
		counters.saturatedLeafCount !== 0 ||
		counters.plaintextMatchCount !== 0
	) {
		throw new Error("Vercel runtime-log inspection did not pass");
	}
	if (counters.beginCanaryCount < 1 || counters.endCanaryCount < 1) {
		throw new Error(
			"Vercel runtime-log snapshot is missing a proof-window canary",
		);
	}
	const manifest = [...retained.entries()]
		.map(([requestId, value]) => `${requestId}\0${value.digest}`)
		.sort()
		.join("\n");
	return {
		...counters,
		requestCount: retained.size,
		logLineCount,
		rowManifestSha256: sha256Bytes(manifest),
	};
}

function identicalSettledSnapshots(left, right) {
	for (const key of [
		"requestCount",
		"logLineCount",
		"rowManifestSha256",
		"beginCanaryCount",
		"endCanaryCount",
	]) {
		if (left[key] !== right[key]) return false;
	}
	return true;
}

export async function scanSettledVercelLogs({
	delay = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
	initialSettleMs = DEFAULT_INITIAL_LOG_SETTLE_MS,
	betweenSettleMs = DEFAULT_BETWEEN_LOG_SETTLE_MS,
	...options
}) {
	const settleTimeoutPad =
		options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
	const now = options.now ?? Date.now;
	const deadlineAt = options.deadlineAt ?? now() + DEFAULT_OVERALL_DEADLINE_MS;
	const settledOptions = { ...options, now, deadlineAt };
	const waitForSettlement = async (milliseconds, label) => {
		if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
			throw new Error(`${label} duration is invalid`);
		}
		const remaining = Math.floor(deadlineAt - now());
		if (remaining <= milliseconds) {
			throw new Error(`${label} exceeded the final-inspection deadline`);
		}
		await withTimeout(
			delay(milliseconds),
			Math.min(milliseconds + settleTimeoutPad, remaining),
			label,
		);
	};
	await waitForSettlement(initialSettleMs, "Vercel initial log settlement");
	const first = await scanVercelLogSnapshot(settledOptions);
	await waitForSettlement(betweenSettleMs, "Vercel repeated log settlement");
	const second = await scanVercelLogSnapshot(settledOptions);
	if (!identicalSettledSnapshots(first, second)) {
		throw new Error(
			"Vercel runtime logs did not produce two identical settled snapshots",
		);
	}
	return {
		...second,
		queryCount: first.queryCount + second.queryCount,
		exhaustedLeafCount: first.exhaustedLeafCount + second.exhaustedLeafCount,
	};
}

export function validateInspectionReceipt(receipt) {
	return validatePureInspectionReceipt(receipt);
}
export function inspectionReceiptPath(topologyReceiptPath) {
	if (
		!isAbsolute(topologyReceiptPath) ||
		!topologyReceiptPath.endsWith(".json")
	) {
		throw new Error("topology receipt path is invalid");
	}
	return join(
		dirname(topologyReceiptPath),
		`${basename(topologyReceiptPath, ".json")}.inspection-v1.json`,
	);
}

export function inspectionReceiptStagePath(topologyReceiptPath) {
	return `${inspectionReceiptPath(topologyReceiptPath)}.stage`;
}

function sameInspectionDirectoryIdentity(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode
	);
}

function validatePrivateInspectionDirectory(stat, label) {
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o700 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())
	) {
		throw new Error(`${label} is not a private owned directory`);
	}
}

function openPinnedInspectionDirectory(receiptRoot) {
	if (!isAbsolute(receiptRoot) || resolve(receiptRoot) !== receiptRoot) {
		throw new Error("inspection receipt root is not canonical");
	}
	let rootPathStat;
	try {
		if (realpathSync(receiptRoot) !== receiptRoot) {
			throw new Error("inspection receipt root is not canonical");
		}
		rootPathStat = lstatSync(receiptRoot);
		validatePrivateInspectionDirectory(rootPathStat, "inspection receipt root");
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("inspection receipt root ")
		) {
			throw error;
		}
		throw new Error("inspection receipt root is unavailable");
	}
	let descriptor;
	try {
		descriptor = openSync(
			receiptRoot,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const descriptorStat = fstatSync(descriptor);
		validatePrivateInspectionDirectory(
			descriptorStat,
			"inspection receipt root descriptor",
		);
		if (
			!sameInspectionDirectoryIdentity(rootPathStat, descriptorStat) ||
			realpathSync(`/proc/self/fd/${descriptor}`) !== receiptRoot
		) {
			throw new Error("inspection receipt root changed while opening");
		}
		return {
			anchoredRoot: `/proc/self/fd/${descriptor}`,
			descriptor,
			receiptRoot,
			rootPathStat,
		};
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Preserve the fixed refusal below.
			}
		}
		if (
			error instanceof Error &&
			error.message.startsWith("inspection receipt root ")
		) {
			throw error;
		}
		throw new Error("inspection receipt root could not be opened safely");
	}
}

function assertPinnedInspectionDirectory(pinned) {
	const descriptorStat = fstatSync(pinned.descriptor);
	const pathStat = lstatSync(pinned.receiptRoot);
	validatePrivateInspectionDirectory(
		descriptorStat,
		"inspection receipt root descriptor",
	);
	validatePrivateInspectionDirectory(pathStat, "inspection receipt root");
	if (
		!sameInspectionDirectoryIdentity(pinned.rootPathStat, descriptorStat) ||
		!sameInspectionDirectoryIdentity(descriptorStat, pathStat) ||
		realpathSync(pinned.receiptRoot) !== pinned.receiptRoot ||
		realpathSync(pinned.anchoredRoot) !== pinned.receiptRoot
	) {
		throw new Error("inspection receipt root changed while pinned");
	}
}

function sameInspectionReceiptIdentity(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

export function writeInspectionReceipt(
	path,
	receipt,
	{ newId = randomUUID, receiptRoot = dirname(path) } = {},
) {
	validateInspectionReceipt(receipt);
	if (
		!isAbsolute(path) ||
		resolve(path) !== path ||
		dirname(path) !== receiptRoot
	) {
		throw new Error("inspection receipt path is not canonical");
	}
	const parent = dirname(path);
	let parentStat;
	try {
		parentStat = lstatSync(parent);
	} catch {
		throw new Error("inspection receipt parent is unavailable");
	}
	if (
		realpathSync(parent) !== parent ||
		!parentStat.isDirectory() ||
		parentStat.isSymbolicLink() ||
		(parentStat.mode & 0o777) !== 0o700 ||
		(typeof process.getuid === "function" &&
			parentStat.uid !== process.getuid())
	) {
		throw new Error(
			"inspection receipt parent is not a private owned directory",
		);
	}
	const id = newId();
	if (!UUID_V4_PATTERN.test(id)) {
		throw new Error("inspection receipt temporary id is invalid");
	}
	const targetName = basename(path);
	const temporaryName = `.${targetName}.${id}.tmp`;
	let directoryDescriptor;
	let fileDescriptor;
	let temporaryPath;
	let failure;
	let closeFailed = false;
	try {
		directoryDescriptor = openSync(
			parent,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const openedParent = fstatSync(directoryDescriptor);
		if (
			!openedParent.isDirectory() ||
			!sameInspectionDirectoryIdentity(parentStat, openedParent) ||
			realpathSync(`/proc/self/fd/${directoryDescriptor}`) !== receiptRoot
		) {
			throw new Error("inspection receipt parent changed while opening");
		}
		const anchoredParent = `/proc/self/fd/${directoryDescriptor}`;
		const targetPath = `${anchoredParent}/${targetName}`;
		temporaryPath = `${anchoredParent}/${temporaryName}`;
		try {
			lstatSync(targetPath);
			throw new Error("inspection receipt already exists");
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "inspection receipt already exists"
			) {
				throw error;
			}
			if (error?.code !== "ENOENT") {
				throw new Error("inspection receipt target is unsafe");
			}
		}
		fileDescriptor = openSync(
			temporaryPath,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		const created = fstatSync(fileDescriptor);
		const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
		if (
			!created.isFile() ||
			created.nlink !== 1 ||
			(created.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === "function" && created.uid !== process.getuid())
		) {
			throw new Error("inspection receipt temporary file is unsafe");
		}
		writeFileSync(fileDescriptor, serialized, "utf8");
		fsyncSync(fileDescriptor);
		const written = fstatSync(fileDescriptor);
		linkSync(temporaryPath, targetPath);
		unlinkSync(temporaryPath);
		temporaryPath = undefined;
		const published = fstatSync(fileDescriptor);
		const finalPath = lstatSync(targetPath);
		if (
			!sameInspectionReceiptIdentity(written, published) ||
			!sameFileIdentity(published, finalPath) ||
			published.nlink !== 1 ||
			(published.mode & 0o777) !== 0o600 ||
			published.size !== Buffer.byteLength(serialized, "utf8")
		) {
			throw new Error("inspection receipt changed while publishing");
		}
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		fsyncSync(directoryDescriptor);
		const finalParentDescriptor = fstatSync(directoryDescriptor);
		const finalParentPath = lstatSync(parent);
		if (
			!sameInspectionDirectoryIdentity(openedParent, finalParentDescriptor) ||
			!finalParentPath.isDirectory() ||
			finalParentPath.isSymbolicLink() ||
			!sameInspectionDirectoryIdentity(
				finalParentDescriptor,
				finalParentPath,
			) ||
			realpathSync(parent) !== receiptRoot ||
			realpathSync(`/proc/self/fd/${directoryDescriptor}`) !== receiptRoot
		) {
			throw new Error("inspection receipt parent changed while publishing");
		}
	} catch (error) {
		failure = error;
	} finally {
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch {
				closeFailed = true;
			}
		}
		if (temporaryPath !== undefined) {
			try {
				unlinkSync(temporaryPath);
			} catch {
				// Nothing safe remains to clean through the pinned directory descriptor.
			}
		}
		if (directoryDescriptor !== undefined) {
			try {
				closeSync(directoryDescriptor);
			} catch {
				closeFailed = true;
			}
		}
	}
	if (closeFailed) {
		throw new Error("inspection receipt descriptor could not be closed");
	}
	if (failure !== undefined) throw failure;
	return path;
}

function requireAbsentReceipt(path, label) {
	try {
		lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw new Error(`${label} target could not be inspected safely`);
	}
	throw new Error(`${label} already exists`);
}

function stagedReceiptStatEvidence(stat) {
	return `${stat.dev}:${stat.ino}:${stat.size}`;
}

function sameBigIntFileIdentity(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.nlink === right.nlink &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

// A hard-link transaction changes ctime and link count. Publication identity therefore pins every
// other inode field, while descriptor-bound reads below independently bind the exact bytes.
function sameBigIntPublicationFile(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mtimeNs === right.mtimeNs
	);
}

function validateBigIntPublicationFile(stat, allowedLinks) {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777n) !== 0o600n ||
		stat.size < 2n ||
		stat.size > BigInt(MAX_TOPOLOGY_RECEIPT_BYTES) ||
		!allowedLinks.has(stat.nlink) ||
		(typeof process.getuid === "function" &&
			stat.uid !== BigInt(process.getuid()))
	) {
		throw new Error("inspection publication inode is unsafe");
	}
}

function readPinnedTopologyReceipt(pinned, path) {
	if (
		!isAbsolute(path) ||
		resolve(path) !== path ||
		dirname(path) !== pinned.receiptRoot
	) {
		throw new Error("topology receipt path is outside the pinned root");
	}
	const anchoredPath = join(pinned.anchoredRoot, basename(path));
	let descriptor;
	let raw;
	let result;
	let failure;
	let closeFailed = false;
	try {
		assertPinnedInspectionDirectory(pinned);
		const pathStat = lstatSync(anchoredPath);
		if (
			!pathStat.isFile() ||
			pathStat.isSymbolicLink() ||
			(pathStat.mode & 0o777) !== 0o600 ||
			pathStat.nlink !== 1 ||
			pathStat.size < 2 ||
			pathStat.size > MAX_TOPOLOGY_RECEIPT_BYTES ||
			(typeof process.getuid === "function" &&
				pathStat.uid !== process.getuid())
		) {
			throw new Error("pinned topology receipt file is invalid");
		}
		descriptor = openSync(
			anchoredPath,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		const before = fstatSync(descriptor);
		if (!sameFileIdentity(pathStat, before)) {
			throw new Error("pinned topology receipt changed while opening");
		}
		raw = readFileSync(descriptor);
		const after = fstatSync(descriptor);
		const finalPathStat = lstatSync(anchoredPath);
		if (
			!Buffer.isBuffer(raw) ||
			raw.length !== before.size ||
			!sameFileIdentity(before, after) ||
			!sameFileIdentity(after, finalPathStat)
		) {
			throw new Error("pinned topology receipt changed while reading");
		}
		let parsed;
		try {
			parsed = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(raw),
			);
		} catch {
			throw new Error("pinned topology receipt is malformed");
		}
		assertPinnedInspectionDirectory(pinned);
		result = {
			receipt: validateTopologyReceipt(parsed),
			receiptSha256: sha256Bytes(raw),
		};
	} catch (error) {
		failure = error;
	} finally {
		if (raw !== undefined) raw.fill(0);
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				closeFailed = true;
			}
		}
	}
	if (failure !== undefined || closeFailed) {
		throw new Error("pinned topology receipt could not be read safely");
	}
	return result;
}

function readPinnedStagedInspectionReceipt(pinned, path, evidence) {
	if (
		!isAbsolute(path) ||
		resolve(path) !== path ||
		dirname(path) !== pinned.receiptRoot
	) {
		throw new Error("staged inspection receipt path is not bound to the proof");
	}
	exactKeys(evidence, ["sha256", "stat"], "staged receipt evidence");
	exactString(evidence.sha256, HASH_PATTERN, "staged receipt digest");
	exactString(
		evidence.stat,
		/^[0-9]+:[0-9]+:[1-9][0-9]*$/,
		"staged receipt stat",
	);
	let fileDescriptor;
	let raw;
	let receipt;
	let stat;
	let failure;
	let closeFailed = false;
	try {
		assertPinnedInspectionDirectory(pinned);
		const anchoredPath = join(pinned.anchoredRoot, basename(path));
		const pathStat = lstatSync(anchoredPath, { bigint: true });
		if (
			!pathStat.isFile() ||
			pathStat.isSymbolicLink() ||
			(pathStat.mode & 0o777n) !== 0o600n ||
			pathStat.nlink !== 1n ||
			pathStat.size < 2n ||
			pathStat.size > BigInt(MAX_TOPOLOGY_RECEIPT_BYTES) ||
			(typeof process.getuid === "function" &&
				pathStat.uid !== BigInt(process.getuid())) ||
			stagedReceiptStatEvidence(pathStat) !== evidence.stat
		) {
			throw new Error("staged receipt file identity is invalid");
		}
		fileDescriptor = openSync(
			anchoredPath,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		const before = fstatSync(fileDescriptor, { bigint: true });
		if (!sameBigIntFileIdentity(pathStat, before)) {
			throw new Error("staged receipt changed while opening");
		}
		raw = readFileSync(fileDescriptor);
		const after = fstatSync(fileDescriptor, { bigint: true });
		const finalPath = lstatSync(anchoredPath, { bigint: true });
		if (
			!Buffer.isBuffer(raw) ||
			BigInt(raw.length) !== before.size ||
			!sameBigIntFileIdentity(before, after) ||
			!sameBigIntFileIdentity(after, finalPath) ||
			sha256Bytes(raw) !== evidence.sha256
		) {
			throw new Error("staged receipt changed while reading");
		}
		let parsed;
		try {
			parsed = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(raw),
			);
		} catch {
			throw new Error("staged receipt is malformed");
		}
		receipt = validateInspectionReceipt(parsed);
		stat = after;
		assertPinnedInspectionDirectory(pinned);
	} catch (error) {
		failure = error;
	} finally {
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch {
				closeFailed = true;
			}
		}
	}
	if (failure !== undefined || closeFailed) {
		if (raw !== undefined) raw.fill(0);
		throw new Error("staged inspection receipt could not be read safely");
	}
	return { bytes: raw, receipt, stat };
}

export function readStagedInspectionReceipt(path, expectedPath, evidence) {
	if (path !== expectedPath) {
		throw new Error("staged inspection receipt path is not bound to the proof");
	}
	const pinned = openPinnedInspectionDirectory(dirname(path));
	let result;
	let failure;
	let closeFailed = false;
	try {
		result = readPinnedStagedInspectionReceipt(pinned, path, evidence);
	} catch (error) {
		failure = error;
	} finally {
		if (result?.bytes !== undefined) result.bytes.fill(0);
		try {
			closeSync(pinned.descriptor);
		} catch {
			closeFailed = true;
		}
	}
	if (failure !== undefined || closeFailed) {
		throw new Error("staged inspection receipt could not be read safely");
	}
	return result.receipt;
}

function validateStagedInspectionBinding(inspection, topology) {
	const receipt = topology.receipt;
	const storage = receipt.runtimeAttestation.storage;
	if (
		inspection.topology.receiptSha256 !== topology.receiptSha256 ||
		inspection.topology.schema !== receipt.schema ||
		inspection.topology.runId !== receipt.runId ||
		inspection.topology.headSha !== receipt.headSha ||
		inspection.topology.githubDeploymentId !== receipt.githubDeploymentId ||
		inspection.topology.packedTarballSha256 !== receipt.packedTarballSha256 ||
		inspection.topology.needleSha256 !==
			sha256Bytes(receipt.plaintextScanNeedle) ||
		inspection.turso.organization !== storage.organization ||
		inspection.turso.group !== storage.group ||
		inspection.turso.scope !== storage.scope ||
		inspection.turso.databasePrefix !== `rc-${storage.scope}-` ||
		inspection.vercel.teamId !== receipt.edgeRateLimit.teamId ||
		inspection.vercel.projectId !== receipt.edgeRateLimit.projectId ||
		inspection.vercel.origin !== receipt.trustedOrigin ||
		inspection.vercel.windowStartedAt !==
			new Date(receipt.proofWindow.startedAtMs).toISOString() ||
		inspection.vercel.windowCompletedAt !==
			new Date(receipt.proofWindow.completedAtMs).toISOString() ||
		inspection.vercel.beginCanarySha256 !==
			sha256Bytes(receipt.logCanaries.begin) ||
		inspection.vercel.endCanarySha256 !== sha256Bytes(receipt.logCanaries.end)
	) {
		throw new Error("staged inspection receipt is not bound to the topology");
	}
	return inspection;
}

export function publishStagedInspectionReceipt({
	topologyReceiptFile,
	stageFile,
	stageEvidence,
	repositoryRoot = REPOSITORY_ROOT,
	receiptRoot = RECEIPT_ROOT,
	repositoryInspector = inspectCandidateRepository,
	newId = randomUUID,
	linkFile = linkSync,
	unlinkFile = unlinkSync,
	openFile = openSync,
	statFile = fstatSync,
	statPath = lstatSync,
	openPublicationDirectory = opendirSync,
	readFile = readFileSync,
	writeFile = writeFileSync,
	fsyncFile = fsyncSync,
	closeFile = closeSync,
	fsyncDirectory = fsyncSync,
	closeDirectory = closeSync,
} = {}) {
	if (
		!isAbsolute(topologyReceiptFile) ||
		resolve(topologyReceiptFile) !== topologyReceiptFile ||
		dirname(topologyReceiptFile) !== receiptRoot ||
		!isAbsolute(stageFile) ||
		resolve(stageFile) !== stageFile ||
		dirname(stageFile) !== receiptRoot
	) {
		throw new Error("inspection publication paths are not canonical");
	}
	const expectedStage = inspectionReceiptStagePath(topologyReceiptFile);
	const outputPath = inspectionReceiptPath(topologyReceiptFile);
	if (stageFile !== expectedStage) {
		throw new Error("staged inspection receipt path is not canonical");
	}
	const pinned = openPinnedInspectionDirectory(receiptRoot);
	const anchoredStage = join(pinned.anchoredRoot, basename(stageFile));
	const anchoredOutput = join(pinned.anchoredRoot, basename(outputPath));
	let staged;
	let temporaryDescriptor;
	let temporaryPath;
	let publicationStat;
	let publicationAttempted = false;
	let publicationCreated = false;
	let publicationCommitted = false;
	let authoritativeCanonicalObserved = false;
	let inspection;
	let result;
	let failure;
	let closeFailed = false;
	const readExactCanonical = (
		allowedLinks,
		{ requirePublicationIdentity = true, syncFile = false } = {},
	) => {
		let canonicalDescriptor;
		let canonicalBytes;
		let canonicalStat;
		let readFailure;
		let canonicalCloseFailed = false;
		try {
			canonicalDescriptor = openFile(
				anchoredOutput,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			const before = statFile(canonicalDescriptor, { bigint: true });
			validateBigIntPublicationFile(before, allowedLinks);
			if (
				requirePublicationIdentity &&
				(publicationStat === undefined ||
					!sameBigIntPublicationFile(publicationStat, before))
			) {
				throw new Error("canonical inspection receipt identity changed");
			}
			canonicalBytes = readFile(canonicalDescriptor);
			let after = statFile(canonicalDescriptor, { bigint: true });
			const pathStat = statPath(anchoredOutput, { bigint: true });
			if (
				!Buffer.isBuffer(canonicalBytes) ||
				staged?.bytes === undefined ||
				BigInt(canonicalBytes.length) !== before.size ||
				sha256Bytes(canonicalBytes) !== stageEvidence.sha256 ||
				!canonicalBytes.equals(staged.bytes) ||
				!sameBigIntFileIdentity(before, after) ||
				!sameBigIntFileIdentity(after, pathStat)
			) {
				throw new Error("canonical inspection receipt bytes changed");
			}
			if (after.nlink === 1n) {
				authoritativeCanonicalObserved = true;
			}
			if (syncFile) {
				fsyncFile(canonicalDescriptor);
				const synced = statFile(canonicalDescriptor, { bigint: true });
				const syncedPath = statPath(anchoredOutput, { bigint: true });
				if (
					!sameBigIntFileIdentity(after, synced) ||
					!sameBigIntFileIdentity(synced, syncedPath)
				) {
					throw new Error("canonical inspection receipt changed while syncing");
				}
				after = synced;
			}
			canonicalStat = after;
		} catch (error) {
			readFailure = error;
		} finally {
			if (canonicalBytes !== undefined) canonicalBytes.fill(0);
			if (canonicalDescriptor !== undefined) {
				try {
					closeFile(canonicalDescriptor);
				} catch {
					canonicalCloseFailed = true;
				}
			}
		}
		if (canonicalCloseFailed) {
			throw new Error(
				"canonical inspection receipt descriptor could not close",
			);
		}
		if (readFailure !== undefined) throw readFailure;
		return canonicalStat;
	};
	const readExactTemporary = (allowedLinks, { syncFile = false } = {}) => {
		let temporaryReadDescriptor;
		let temporaryBytes;
		let temporaryStat;
		let readFailure;
		let temporaryCloseFailed = false;
		try {
			temporaryReadDescriptor = openFile(
				temporaryPath,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			const before = statFile(temporaryReadDescriptor, { bigint: true });
			validateBigIntPublicationFile(before, allowedLinks);
			temporaryBytes = readFile(temporaryReadDescriptor);
			let after = statFile(temporaryReadDescriptor, { bigint: true });
			const pathStat = statPath(temporaryPath, { bigint: true });
			if (
				!Buffer.isBuffer(temporaryBytes) ||
				staged?.bytes === undefined ||
				BigInt(temporaryBytes.length) !== before.size ||
				sha256Bytes(temporaryBytes) !== stageEvidence.sha256 ||
				!temporaryBytes.equals(staged.bytes) ||
				!sameBigIntFileIdentity(before, after) ||
				!sameBigIntFileIdentity(after, pathStat)
			) {
				throw new Error("inspection publication source bytes changed");
			}
			if (syncFile) {
				fsyncFile(temporaryReadDescriptor);
				const synced = statFile(temporaryReadDescriptor, { bigint: true });
				const syncedPath = statPath(temporaryPath, { bigint: true });
				if (
					!sameBigIntFileIdentity(after, synced) ||
					!sameBigIntFileIdentity(synced, syncedPath)
				) {
					throw new Error(
						"inspection publication source changed while syncing",
					);
				}
				after = synced;
			}
			temporaryStat = after;
		} catch (error) {
			readFailure = error;
		} finally {
			if (temporaryBytes !== undefined) temporaryBytes.fill(0);
			if (temporaryReadDescriptor !== undefined) {
				try {
					closeFile(temporaryReadDescriptor);
				} catch {
					temporaryCloseFailed = true;
				}
			}
		}
		if (temporaryCloseFailed) {
			throw new Error(
				"inspection publication source descriptor could not close",
			);
		}
		if (readFailure !== undefined) throw readFailure;
		return temporaryStat;
	};
	const readBoundedPublicationEntries = () => {
		let directory;
		const entries = [];
		try {
			directory = openPublicationDirectory(pinned.anchoredRoot);
			if (
				directory === null ||
				typeof directory !== "object" ||
				typeof directory.readSync !== "function" ||
				typeof directory.closeSync !== "function"
			) {
				throw new Error("inspection publication directory is unsafe");
			}
			while (true) {
				const entry = directory.readSync();
				if (entry === null) return entries;
				if (typeof entry !== "object" || typeof entry.name !== "string") {
					throw new Error("inspection publication directory is unsafe");
				}
				entries.push(entry.name);
				if (entries.length > MAX_PUBLICATION_DIRECTORY_ENTRIES) {
					throw new Error("inspection publication directory is unbounded");
				}
			}
		} finally {
			directory?.closeSync();
		}
	};
	const findExactLinkedTemporary = (canonicalStat) => {
		const entries = readBoundedPublicationEntries();
		const prefix = `.${basename(outputPath)}.${stageEvidence.sha256}.`;
		const suffix = ".publish.tmp";
		const candidates = [];
		for (const entry of entries) {
			if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
			const id = entry.slice(prefix.length, -suffix.length);
			if (!UUID_V4_PATTERN.test(id)) continue;
			const candidatePath = join(pinned.anchoredRoot, entry);
			const candidateStat = statPath(candidatePath, { bigint: true });
			if (sameBigIntPublicationFile(canonicalStat, candidateStat)) {
				candidates.push(candidatePath);
			}
		}
		if (candidates.length !== 1) {
			throw new Error("inspection publication source is ambiguous");
		}
		temporaryPath = candidates[0];
		const sourceStat = readExactTemporary(new Set([2n]), { syncFile: true });
		if (!sameBigIntPublicationFile(canonicalStat, sourceStat)) {
			throw new Error("inspection publication source link changed");
		}
		return sourceStat;
	};
	const findExactOrphanedTemporary = () => {
		const entries = readBoundedPublicationEntries();
		const prefix = `.${basename(outputPath)}.${stageEvidence.sha256}.`;
		const suffix = ".publish.tmp";
		const candidates = entries
			.filter((entry) => {
				if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return false;
				const id = entry.slice(prefix.length, -suffix.length);
				return UUID_V4_PATTERN.test(id);
			})
			.sort();
		for (const entry of candidates) {
			temporaryPath = join(pinned.anchoredRoot, entry);
			try {
				return readExactTemporary(new Set([1n]), { syncFile: true });
			} catch {
				// Incomplete or concurrently changed random attempts cannot be authoritative while
				// canonical is absent. Never delete them because another publisher may own them.
			}
		}
		temporaryPath = undefined;
		return undefined;
	};
	const assertVisibleCanonical = (canonicalStat) => {
		assertPinnedInspectionDirectory(pinned);
		const visibleStat = statPath(outputPath, { bigint: true });
		if (!sameBigIntFileIdentity(canonicalStat, visibleStat)) {
			throw new Error("canonical inspection receipt path changed");
		}
	};
	const assertTemporaryAbsent = () => {
		try {
			statPath(temporaryPath, { bigint: true });
			throw new Error("inspection publication source is unexpectedly present");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	};
	const assertCanonicalAbsent = () => {
		try {
			statPath(anchoredOutput, { bigint: true });
			throw new Error("canonical inspection receipt already exists");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	};
	const convergePublication = () => {
		let canonicalStat = readExactCanonical(new Set([1n, 2n]));
		if (canonicalStat.nlink === 2n) {
			const sourceStat = readExactTemporary(new Set([2n]), {
				syncFile: true,
			});
			if (!sameBigIntPublicationFile(canonicalStat, sourceStat)) {
				throw new Error("inspection publication source link changed");
			}
			// The canonical name is first made durable while nlink=2 keeps it invalid to ordinary
			// readers. Removing the source is the irreversible transition to canonical authority.
			fsyncDirectory(pinned.descriptor);
			const durableCanonicalStat = readExactCanonical(new Set([2n]));
			const durableSourceStat = readExactTemporary(new Set([2n]));
			if (
				!sameBigIntPublicationFile(canonicalStat, durableCanonicalStat) ||
				!sameBigIntPublicationFile(sourceStat, durableSourceStat) ||
				!sameBigIntPublicationFile(durableCanonicalStat, durableSourceStat)
			) {
				throw new Error(
					"inspection publication link pair changed while syncing",
				);
			}
			canonicalStat = durableCanonicalStat;
			assertVisibleCanonical(canonicalStat);
			unlinkFile(temporaryPath);
		} else {
			try {
				statPath(temporaryPath, { bigint: true });
				throw new Error("inspection publication source cleanup is ambiguous");
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		assertTemporaryAbsent();
		canonicalStat = readExactCanonical(new Set([1n]), { syncFile: true });
		assertVisibleCanonical(canonicalStat);
		fsyncDirectory(pinned.descriptor);
		const durableCanonicalStat = readExactCanonical(new Set([1n]));
		if (!sameBigIntFileIdentity(canonicalStat, durableCanonicalStat)) {
			throw new Error("canonical inspection receipt changed while committing");
		}
		canonicalStat = durableCanonicalStat;
		assertVisibleCanonical(canonicalStat);
		assertTemporaryAbsent();
		publicationCommitted = true;
	};
	const recoverExistingCanonical = () => {
		let canonicalStat = readExactCanonical(new Set([1n]), {
			requirePublicationIdentity: false,
			syncFile: true,
		});
		assertVisibleCanonical(canonicalStat);
		// A fresh publisher may finish the directory sync that a previous invocation could not
		// observe after exposing nlink=1. Recovery never retracts or replaces canonical authority.
		fsyncDirectory(pinned.descriptor);
		const durableCanonicalStat = readExactCanonical(new Set([1n]), {
			requirePublicationIdentity: false,
		});
		if (!sameBigIntFileIdentity(canonicalStat, durableCanonicalStat)) {
			throw new Error("canonical inspection receipt changed during recovery");
		}
		canonicalStat = durableCanonicalStat;
		assertVisibleCanonical(canonicalStat);
		publicationCommitted = true;
	};
	try {
		const topology = readPinnedTopologyReceipt(pinned, topologyReceiptFile);
		validateTopologyReceiptLocation(
			topologyReceiptFile,
			topology.receipt,
			receiptRoot,
		);
		staged = readPinnedStagedInspectionReceipt(
			pinned,
			stageFile,
			stageEvidence,
		);
		inspection = validateStagedInspectionBinding(staged.receipt, topology);
		repositoryInspector({
			expectedHead: topology.receipt.headSha,
			repositoryRoot,
		});
		const finalTopology = readPinnedTopologyReceipt(
			pinned,
			topologyReceiptFile,
		);
		if (finalTopology.receiptSha256 !== topology.receiptSha256) {
			throw new Error("topology receipt changed before inspection publication");
		}
		const stableStage = statPath(anchoredStage, { bigint: true });
		if (!sameBigIntFileIdentity(staged.stat, stableStage)) {
			throw new Error("staged receipt changed before inspection publication");
		}
		assertPinnedInspectionDirectory(pinned);
		let canonicalExists = true;
		try {
			statPath(anchoredOutput);
		} catch (error) {
			if (error?.code !== "ENOENT") {
				throw new Error("canonical inspection receipt target is unsafe");
			}
			canonicalExists = false;
		}
		if (canonicalExists) {
			const canonicalStat = readExactCanonical(new Set([1n, 2n]), {
				requirePublicationIdentity: false,
			});
			if (canonicalStat.nlink === 1n) {
				recoverExistingCanonical();
			} else {
				publicationAttempted = true;
				publicationStat = findExactLinkedTemporary(canonicalStat);
				publicationCreated = true;
				convergePublication();
			}
		} else {
			publicationStat = findExactOrphanedTemporary();
			if (publicationStat === undefined) {
				const id = newId();
				if (typeof id !== "string" || !UUID_V4_PATTERN.test(id)) {
					throw new Error("inspection publication id is invalid");
				}
				temporaryPath = join(
					pinned.anchoredRoot,
					`.${basename(outputPath)}.${stageEvidence.sha256}.${id}.publish.tmp`,
				);
				temporaryDescriptor = openFile(
					temporaryPath,
					constants.O_CREAT |
						constants.O_EXCL |
						constants.O_WRONLY |
						constants.O_NOFOLLOW,
					0o600,
				);
				const created = statFile(temporaryDescriptor, { bigint: true });
				if (
					!created.isFile() ||
					created.nlink !== 1n ||
					(created.mode & 0o777n) !== 0o600n ||
					(typeof process.getuid === "function" &&
						created.uid !== BigInt(process.getuid()))
				) {
					throw new Error("inspection publication temporary file is unsafe");
				}
				writeFile(temporaryDescriptor, staged.bytes);
				fsyncFile(temporaryDescriptor);
				const written = statFile(temporaryDescriptor, { bigint: true });
				validateBigIntPublicationFile(written, new Set([1n]));
				const temporaryStat = statPath(temporaryPath, { bigint: true });
				if (
					written.size !== BigInt(staged.bytes.length) ||
					!sameBigIntFileIdentity(written, temporaryStat)
				) {
					throw new Error(
						"inspection publication bytes were not staged exactly",
					);
				}
				publicationStat = written;
				closeFile(temporaryDescriptor);
				temporaryDescriptor = undefined;
			}
			// Persist the exact source name before a canonical link can exist. This prevents a
			// crash from replaying canonical authority without its recoverable source alias.
			publicationAttempted = true;
			fsyncDirectory(pinned.descriptor);
			const durableSourceStat = readExactTemporary(new Set([1n]));
			if (!sameBigIntPublicationFile(publicationStat, durableSourceStat)) {
				throw new Error("inspection publication source changed while staging");
			}
			publicationStat = durableSourceStat;
			const finalStableStage = statPath(anchoredStage, { bigint: true });
			if (
				!sameBigIntFileIdentity(staged.stat, finalStableStage) ||
				sha256Bytes(staged.bytes) !== stageEvidence.sha256
			) {
				throw new Error("staged receipt changed before inspection publication");
			}
			assertPinnedInspectionDirectory(pinned);
			assertCanonicalAbsent();
			linkFile(temporaryPath, anchoredOutput);
			publicationCreated = true;
			convergePublication();
		}
		result = { path: outputPath, receipt: inspection };
	} catch (error) {
		failure = error;
		if (publicationCreated && !publicationCommitted) {
			try {
				convergePublication();
				result ??= { path: outputPath, receipt: inspection };
			} catch {
				// Canonical visibility is irreversible. Preserve it and the source evidence; only
				// exact descriptor-bound convergence may authorize success.
			}
		}
	} finally {
		if (staged?.bytes !== undefined) staged.bytes.fill(0);
		if (temporaryDescriptor !== undefined) {
			try {
				closeFile(temporaryDescriptor);
			} catch {
				closeFailed = true;
			}
		}
		try {
			closeDirectory(pinned.descriptor);
		} catch {
			if (!publicationCommitted) closeFailed = true;
		}
	}
	if (publicationCommitted) return result;
	if (publicationAttempted || authoritativeCanonicalObserved) {
		throw new PublicationIndeterminateError(PUBLISH_INDETERMINATE_MESSAGE);
	}
	if (failure !== undefined || closeFailed) {
		throw new Error("staged inspection receipt could not be published safely");
	}
	return result;
}

function filterProofFleet(databases, prefix) {
	const fleet = databases.filter((database) =>
		database.name.startsWith(prefix),
	);
	if (fleet.length < 1 || fleet.length > MAX_DATABASES) {
		throw new Error(
			"attested Turso prefix resolved to no bounded database fleet",
		);
	}
	return fleet;
}

export function validateStableTursoFleet(before, after) {
	if (stableJson(before) !== stableJson(after)) {
		throw new Error("attested Turso database fleet changed during inspection");
	}
	return before;
}

function validateTopologyReceiptLocation(path, receipt, receiptRoot) {
	const expected = join(
		receiptRoot,
		`real-topology-browser-leg-${receipt.headSha}-${receipt.runId.replaceAll("-", "")}.json`,
	);
	if (path !== expected) {
		throw new Error(
			"topology receipt path is not bound to the candidate proof run",
		);
	}
}

function releasePinnedLibsqlClient(proof) {
	if (proof === undefined) return;
	let failed = false;
	try {
		proof.revalidate();
	} catch {
		failed = true;
	}
	try {
		proof.cleanup();
	} catch {
		failed = true;
	}
	if (failed) {
		throw new Error("pinned libSQL dependency snapshot changed or leaked");
	}
}

export async function runTrustedFinalInspection({
	input,
	fetchImpl = fetch,
	createClientImpl,
	repositoryInspector = inspectCandidateRepository,
	dependencyLoader = preparePinnedLibsqlClient,
	repositoryRoot = REPOSITORY_ROOT,
	receiptRoot = RECEIPT_ROOT,
	now = Date.now,
	delay,
	initialSettleMs = DEFAULT_INITIAL_LOG_SETTLE_MS,
	betweenSettleMs = DEFAULT_BETWEEN_LOG_SETTLE_MS,
	operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
	overallDeadlineMs = DEFAULT_OVERALL_DEADLINE_MS,
	stageWriter = writeInspectionReceipt,
} = {}) {
	validateInspectionInput(input);
	const topology = readTopologyReceipt(input.RC_TOPOLOGY_RECEIPT_FILE);
	const receipt = topology.receipt;
	validateTopologyReceiptLocation(
		input.RC_TOPOLOGY_RECEIPT_FILE,
		receipt,
		receiptRoot,
	);
	repositoryInspector({ expectedHead: receipt.headSha, repositoryRoot });
	const outputPath = inspectionReceiptPath(input.RC_TOPOLOGY_RECEIPT_FILE);
	const stagePath = inspectionReceiptStagePath(input.RC_TOPOLOGY_RECEIPT_FILE);
	requireAbsentReceipt(outputPath, "canonical inspection receipt");
	requireAbsentReceipt(stagePath, "staged inspection receipt");
	const startedAtMs = now();
	if (
		startedAtMs + MAX_CLOCK_SKEW_MS < receipt.proofWindow.completedAtMs ||
		startedAtMs - receipt.proofWindow.startedAtMs > MAX_LOG_RETENTION_AGE_MS
	) {
		throw new Error(
			"topology proof window is outside Vercel runtime-log retention",
		);
	}
	const deadlineAt = startedAtMs + overallDeadlineMs;
	const storage = receipt.runtimeAttestation.storage;
	const databasePrefix = `rc-${storage.scope}-`;
	let pinnedLibsql;
	let effectiveCreateClient = createClientImpl;
	if (effectiveCreateClient === undefined) {
		pinnedLibsql = await dependencyLoader({ repositoryRoot });
		if (typeof pinnedLibsql?.createClient !== "function") {
			throw new Error(
				"pinned libSQL dependency loader did not return a client",
			);
		}
		effectiveCreateClient = pinnedLibsql.createClient;
	}
	let before;
	let turso;
	try {
		const beforeAll = await listTursoDatabases({
			organization: storage.organization,
			group: storage.group,
			token: input.TURSO_API_TOKEN,
			fetchImpl,
			operationTimeoutMs,
			now,
			deadlineAt,
		});
		before = filterProofFleet(beforeAll, databasePrefix);
		turso = await scanTursoFleet({
			databases: before,
			authToken: input.TURSO_GROUP_AUTH_TOKEN,
			needle: receipt.plaintextScanNeedle,
			createClientImpl: effectiveCreateClient,
			now,
			deadlineAt,
			operationTimeoutMs,
		});
		const afterAll = await listTursoDatabases({
			organization: storage.organization,
			group: storage.group,
			token: input.TURSO_API_TOKEN,
			fetchImpl,
			operationTimeoutMs,
			now,
			deadlineAt,
		});
		const after = filterProofFleet(afterAll, databasePrefix);
		validateStableTursoFleet(before, after);
	} finally {
		releasePinnedLibsqlClient(pinnedLibsql);
	}
	assertWithinDeadline(deadlineAt, now, "final inspection");
	const deployment = await resolveImmutableVercelDeployment({
		origin: receipt.trustedOrigin,
		headSha: receipt.headSha,
		teamId: receipt.edgeRateLimit.teamId,
		projectId: receipt.edgeRateLimit.projectId,
		token: input.VERCEL_TOKEN,
		fetchImpl,
		operationTimeoutMs,
		now,
		deadlineAt,
	});
	const vercel = await scanSettledVercelLogs({
		projectId: receipt.edgeRateLimit.projectId,
		teamId: receipt.edgeRateLimit.teamId,
		deploymentId: deployment.deploymentId,
		windowStartedAtMs: receipt.proofWindow.startedAtMs,
		windowCompletedAtMs: receipt.proofWindow.completedAtMs,
		token: input.VERCEL_TOKEN,
		plaintextNeedle: receipt.plaintextScanNeedle,
		beginCanary: receipt.logCanaries.begin,
		endCanary: receipt.logCanaries.end,
		fetchImpl,
		now,
		deadlineAt,
		operationTimeoutMs,
		delay,
		initialSettleMs,
		betweenSettleMs,
	});
	repositoryInspector({ expectedHead: receipt.headSha, repositoryRoot });
	const finalTopology = readTopologyReceipt(input.RC_TOPOLOGY_RECEIPT_FILE);
	if (finalTopology.receiptSha256 !== topology.receiptSha256) {
		throw new Error("topology receipt changed during final inspection");
	}
	const completedAtMs = now();
	assertWithinDeadline(deadlineAt, () => completedAtMs, "final inspection");
	const databaseManifest = before
		.map((database) => `${database.id}\0${database.name}\0${database.hostname}`)
		.join("\n");
	const finalReceipt = validateInspectionReceipt({
		schema: INSPECTION_SCHEMA,
		result: "passed",
		topology: {
			receiptSha256: topology.receiptSha256,
			schema: TOPOLOGY_SCHEMA,
			runId: receipt.runId,
			headSha: receipt.headSha,
			githubDeploymentId: receipt.githubDeploymentId,
			packedTarballSha256: receipt.packedTarballSha256,
			needleSha256: sha256Bytes(receipt.plaintextScanNeedle),
		},
		inspection: {
			startedAt: new Date(startedAtMs).toISOString(),
			completedAt: new Date(completedAtMs).toISOString(),
		},
		turso: {
			organization: storage.organization,
			group: storage.group,
			scope: storage.scope,
			databasePrefix,
			databaseCount: before.length,
			databaseSetSha256: sha256Bytes(databaseManifest),
			fleetEnumerations: 2,
			tableCount: turso.tableCount,
			rowCount: turso.rowCount,
			valueCount: turso.valueCount,
			valueBytes: turso.valueBytes,
			plaintextMatchCount: turso.plaintextMatchCount,
		},
		vercel: {
			teamId: receipt.edgeRateLimit.teamId,
			projectId: receipt.edgeRateLimit.projectId,
			deploymentId: deployment.deploymentId,
			origin: receipt.trustedOrigin,
			windowStartedAt: new Date(receipt.proofWindow.startedAtMs).toISOString(),
			windowCompletedAt: new Date(
				receipt.proofWindow.completedAtMs,
			).toISOString(),
			beginCanarySha256: sha256Bytes(receipt.logCanaries.begin),
			endCanarySha256: sha256Bytes(receipt.logCanaries.end),
			exhaustedLeafCount: vercel.exhaustedLeafCount,
			queryCount: vercel.queryCount,
			requestCount: vercel.requestCount,
			logLineCount: vercel.logLineCount,
			rowManifestSha256: vercel.rowManifestSha256,
			wrongDeploymentCount: vercel.wrongDeploymentCount,
			malformedCount: vercel.malformedCount,
			truncatedCount: vercel.truncatedCount,
			saturatedLeafCount: vercel.saturatedLeafCount,
			plaintextMatchCount: vercel.plaintextMatchCount,
		},
	});
	stageWriter(stagePath, finalReceipt);
	process.stdout.write(
		`content-free staged final-inspection receipt: ${stagePath}\n`,
	);
	return { path: outputPath, stagePath, receipt: finalReceipt };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const inspectionMode = process.env.RC_INSPECTION_MODE;
	try {
		if (process.argv.length !== 2) {
			throw new Error("final inspection accepts no command-line arguments");
		}
		if (inspectionMode === "scan") {
			const input = readInspectionBootstrapInput();
			const repositoryRoot = validateInspectionBootstrapEnvironment(
				process.env,
			);
			await runTrustedFinalInspection({
				input,
				repositoryRoot,
				receiptRoot: join(repositoryRoot, "tests", "web", "test-results"),
			});
		} else if (inspectionMode === "publish") {
			const publication = validateInspectionPublishEnvironment(process.env);
			const result = publishStagedInspectionReceipt({
				...publication,
				receiptRoot: join(
					publication.repositoryRoot,
					"tests",
					"web",
					"test-results",
				),
			});
			process.stdout.write(
				`content-free final-inspection receipt: ${result.path}\n`,
			);
		} else {
			throw new Error("final inspection mode is invalid");
		}
	} catch (error) {
		process.stderr.write(
			"final inspection refused: release gate did not pass\n",
		);
		process.exitCode =
			inspectionMode === "publish" &&
			error instanceof PublicationIndeterminateError
				? PUBLISH_INDETERMINATE_EXIT_CODE
				: 1;
	}
}
