import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertFreshInspection,
	attestProductionDataPlane,
	attestProductionDeploymentProtection,
	attestProductionFirewall,
	attestProductionRuntime,
	createProductionReceipt,
	inspectLocalReleaseState,
	normalizeProductionDataPlaneAttestation,
	normalizeProductionRuntimeAttestation,
	productionReceiptPath,
	publishStagedProductionReceipt,
	readInspectionReceipt,
	readProofBootstrapInput,
	readPublishBootstrapInput,
	resolveGithubMainHead,
	resolveGithubProduction,
	resolveVercelProduction,
	stageProductionReceipt,
	validateBootstrapEnvironment,
	validateGithubCandidateAncestry,
	validateGithubMainRef,
	validateGithubProductionDeployment,
	validateImmutableProductionOrigin,
	validateNewestGithubProductionDeployment,
	validateProductionFirewallAttestation,
	validateProductionReceipt,
	validateProofInput,
	validatePublishBootstrapEnvironment,
	validateVercelProductionDeployment,
	verifyProductionRelease,
} from "./verify-production-release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RESULT_ROOT = join(ROOT, "tests", "web", "test-results");
const CLEAN_WRAPPER = join(HERE, "verify-production-release-clean.sh");
const RUNNER = join(HERE, "verify-production-release.mjs");
const CANDIDATE = "a".repeat(40);
const PRODUCTION = "b".repeat(40);
const OTHER = "d".repeat(40);
const TREE = "c".repeat(40);
const OTHER_TREE = "e".repeat(40);
const HASH = "f".repeat(64);

function productionDatabaseId(challenge) {
	const challengeSha256 = createHash("sha256").update(challenge).digest("hex");
	const identityId = challengeSha256.slice(0, 32);
	const sessionId = `release-storage-${challengeSha256.slice(0, 32)}`;
	return `rc-prod-s-${createHash("sha256")
		.update(`sess:${identityId}:${sessionId}`)
		.digest("hex")
		.slice(0, 16)}`;
}
const RUN_ID = "12345678-1234-4123-8123-123456789abc";
const PREVIEW_ORIGIN =
	"https://remote-claw-abc123xyz-ejc3-7031s-projects.vercel.app";
const PRODUCTION_ORIGIN =
	"https://remote-claw-def456uvw-ejc3-7031s-projects.vercel.app";
const PROJECT_ID = "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM";
const TEAM_ID = "team_fYexi4KRmIrq9wtYsiXs9e9H";
const pinnedReleaseHost =
	process.platform === "linux" && process.arch === "arm64";

function ensurePrivateResultRoot() {
	try {
		mkdirSync(RESULT_ROOT, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}
	const descriptor = openSync(
		RESULT_ROOT,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		const stat = fstatSync(descriptor);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())
		) {
			throw new Error(
				"production test result root is not a private owned directory",
			);
		}
		fchmodSync(descriptor, 0o700);
	} finally {
		closeSync(descriptor);
	}
}

ensurePrivateResultRoot();

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function stagedBinding(stagePath) {
	const stat = lstatSync(stagePath);
	return {
		stagePath,
		sha256: sha256(readFileSync(stagePath)),
		device: String(stat.dev),
		inode: String(stat.ino),
		size: String(stat.size),
	};
}

function publicationTemporaries(root) {
	return readdirSync(root).filter((name) => name.endsWith(".publish.tmp"));
}

function inspectionReceipt(overrides = {}) {
	const value = {
		schema: "remote-claw-real-topology-inspection/v1",
		result: "passed",
		topology: {
			receiptSha256: "1".repeat(64),
			schema: "remote-claw-real-topology-browser-leg/v4",
			runId: RUN_ID,
			headSha: CANDIDATE,
			githubDeploymentId: "987654",
			packedTarballSha256: "2".repeat(64),
			needleSha256: "3".repeat(64),
		},
		inspection: {
			startedAt: "2026-08-24T01:00:00.000Z",
			completedAt: "2026-08-24T01:05:00.000Z",
		},
		turso: {
			organization: "proof-org",
			group: "proof-group",
			scope: "pr-aaaaaaa",
			databasePrefix: "rc-pr-aaaaaaa-",
			databaseCount: 2,
			databaseSetSha256: "4".repeat(64),
			fleetEnumerations: 2,
			tableCount: 8,
			rowCount: 18,
			valueCount: 72,
			valueBytes: 4096,
			plaintextMatchCount: 0,
		},
		vercel: {
			teamId: TEAM_ID,
			projectId: PROJECT_ID,
			deploymentId: "dpl_Preview123",
			origin: PREVIEW_ORIGIN,
			windowStartedAt: "2026-08-24T01:00:00.000Z",
			windowCompletedAt: "2026-08-24T01:05:00.000Z",
			beginCanarySha256: "5".repeat(64),
			endCanarySha256: "6".repeat(64),
			exhaustedLeafCount: 2,
			queryCount: 3,
			requestCount: 12,
			logLineCount: 34,
			rowManifestSha256: "7".repeat(64),
			wrongDeploymentCount: 0,
			malformedCount: 0,
			truncatedCount: 0,
			saturatedLeafCount: 0,
			plaintextMatchCount: 0,
		},
	};
	return { ...value, ...overrides };
}

function inspectionName(receipt = inspectionReceipt()) {
	return `real-topology-browser-leg-${receipt.topology.headSha}-${receipt.topology.runId.replaceAll(
		"-",
		"",
	)}.inspection-v1.json`;
}

function inspectionBinding(receipt = inspectionReceipt()) {
	return {
		path: join(RESULT_ROOT, inspectionName(receipt)),
		file: inspectionName(receipt),
		sha256: HASH,
		receipt,
		candidateSha: receipt.topology.headSha,
		organization: receipt.turso.organization,
		group: receipt.turso.group,
	};
}

function proofInput(overrides = {}) {
	return {
		GITHUB_REPOSITORY: "ejc3/remote-claw",
		GITHUB_TOKEN: "github-secret",
		RC_PRODUCTION_DEPLOYMENT_ID: "123456",
		RC_INSPECTION_RECEIPT_FILE: join(RESULT_ROOT, inspectionName()),
		VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
		VERCEL_TOKEN: "vercel-secret",
		...overrides,
	};
}

function localState(overrides = {}) {
	return {
		headSha: PRODUCTION,
		candidateTree: TREE,
		productionTree: TREE,
		...overrides,
	};
}

function githubDeployment(overrides = {}) {
	return {
		id: 123456,
		sha: PRODUCTION,
		environment: "Production",
		creator: { login: "vercel[bot]" },
		...overrides,
	};
}

function githubDeployments(overrides = {}) {
	return [githubDeployment(overrides)];
}

function githubStatuses(overrides = {}) {
	return [
		{
			state: "success",
			environment: "Production",
			environment_url: PRODUCTION_ORIGIN,
			creator: { login: "vercel[bot]" },
			...overrides,
		},
	];
}

function githubRef(sha = PRODUCTION) {
	return { ref: "refs/heads/main", object: { type: "commit", sha } };
}

function githubCommit(sha, tree = TREE) {
	return { sha, tree: { sha: tree } };
}

function githubComparison(overrides = {}) {
	return {
		status: "ahead",
		ahead_by: 1,
		behind_by: 0,
		base_commit: { sha: CANDIDATE },
		merge_base_commit: { sha: CANDIDATE },
		...overrides,
	};
}

function githubResolution(overrides = {}) {
	return {
		deploymentId: "123456",
		headSha: PRODUCTION,
		origin: PRODUCTION_ORIGIN,
		candidateTree: TREE,
		productionTree: TREE,
		...overrides,
	};
}

function vercelDeployment(overrides = {}) {
	return {
		id: "dpl_Production123",
		url: new URL(PRODUCTION_ORIGIN).hostname,
		ownerId: TEAM_ID,
		projectId: PROJECT_ID,
		readyState: "READY",
		status: "READY",
		project: { id: PROJECT_ID },
		target: "production",
		meta: { githubCommitSha: PRODUCTION, githubCommitRef: "main" },
		gitSource: { type: "github", ref: "main", sha: PRODUCTION },
		...overrides,
	};
}

function vercelResolution(overrides = {}) {
	return {
		deploymentId: "dpl_Production123",
		origin: PRODUCTION_ORIGIN,
		ownerId: TEAM_ID,
		projectId: PROJECT_ID,
		teamId: TEAM_ID,
		readyState: "READY",
		status: "READY",
		target: "production",
		...overrides,
	};
}

function runtimeAttestation(overrides = {}, storageOverrides = {}) {
	return {
		environment: "production",
		sha: PRODUCTION,
		storage: {
			backend: "sqlite",
			locator: "turso",
			organization: "proof-org",
			group: "proof-group",
			scope: "prod",
			...storageOverrides,
		},
		...overrides,
	};
}

function dataPlaneAttestation(overrides = {}) {
	return {
		schema: "remote-claw-production-data-plane/v1",
		result: "passed",
		headSha: PRODUCTION,
		backend: "sqlite",
		durable: true,
		deploymentProtection: true,
		databaseId: `rc-prod-s-${"b".repeat(16)}`,
		frameCountBefore: null,
		frameCountAfter: 1,
		frameSha256: "8".repeat(64),
		...overrides,
	};
}

function firewallAttestation(overrides = {}) {
	return {
		schema: "remote-claw-production-firewall/v1",
		result: "passed",
		projectId: PROJECT_ID,
		teamId: TEAM_ID,
		firewallConfigId: "waf_TG8xDULMuMuR",
		firewallConfigVersion: 3,
		ruleId: "rule_handoff_per_ip_rate_limit_UWaS5F",
		ruleName: "handoff-per-ip-rate-limit",
		pathPrefix: "/api/handoff",
		algorithm: "token_bucket",
		limit: 20,
		windowSeconds: 60,
		key: "ip",
		excessAction: "deny",
		firewallBypassCount: 0,
		...overrides,
	};
}

function wafConfigFixture() {
	return {
		active: {
			crs: {
				gen: { active: true, action: "log" },
				java: { active: false, action: "log" },
				lfi: { active: false, action: "log" },
				ma: { active: false, action: "log" },
				php: { active: false, action: "log" },
				rce: { active: true, action: "log" },
				rfi: { active: false, action: "log" },
				sd: { active: false, action: "log" },
				sf: { active: false, action: "log" },
				sqli: { active: true, action: "log" },
				xss: { active: true, action: "log" },
			},
			version: 3,
			firewallEnabled: true,
			ownerId: TEAM_ID,
			updatedAt: "2026-08-24T00:00:00.000Z",
			id: "waf_TG8xDULMuMuR",
			ips: [],
			projectKey: `${PROJECT_ID}#active`,
			changes: [],
			rules: [
				{
					name: "handoff-per-ip-rate-limit",
					description: "",
					active: true,
					action: {
						mitigate: {
							redirect: null,
							action: "rate_limit",
							rateLimit: {
								limit: 20,
								action: "deny",
								window: 60,
								algo: "token_bucket",
								keys: ["ip"],
							},
							actionDuration: null,
						},
					},
					id: "rule_handoff_per_ip_rate_limit_UWaS5F",
					conditionGroup: [
						{
							conditions: [{ type: "path", op: "pre", value: "/api/handoff" }],
						},
					],
					valid: true,
					validationErrors: null,
				},
			],
		},
		draft: null,
		versions: [],
	};
}

function productionReceipt() {
	return createProductionReceipt({
		inspection: inspectionBinding(),
		local: localState(),
		github: githubResolution(),
		vercel: vercelResolution(),
		runtimeAttestation: runtimeAttestation(),
		dataPlaneAttestation: dataPlaneAttestation(),
		firewallAttestation: firewallAttestation(),
		repository: "ejc3/remote-claw",
		verifiedAt: "2026-08-24T02:00:00.000Z",
	});
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), { status, headers });
}

const PROTECTION_COOKIE_NONCE = "9".repeat(48);

function protectionCallbackNonce(cookieNonce = PROTECTION_COOKIE_NONCE) {
	return createHash("sha256").update(cookieNonce, "ascii").digest("hex");
}

function protectionResponse(
	origin = PRODUCTION_ORIGIN,
	headerOverrides = {},
	callbackNonce = protectionCallbackNonce(),
) {
	const target = `${origin}/api/prove/deployment-attestation`;
	const callback = new URL("https://vercel.com/sso-api");
	callback.searchParams.set("url", target);
	callback.searchParams.set("nonce", callbackNonce);
	return jsonResponse(
		{
			protection: {
				vercel_auth_callback: callback.href,
				auto_vercel_auth_redirect: true,
				password_enabled: false,
				vercel_auth_enabled: true,
			},
			error: { code: "401", message: "Protected deployment" },
		},
		{
			status: 401,
			headers: protectionHeaders(headerOverrides),
		},
	);
}

function protectionHeaders(overrides = {}) {
	return {
		"cache-control": "no-store, max-age=0",
		server: "Vercel",
		"set-cookie": `_vercel_sso_nonce=${PROTECTION_COOKIE_NONCE}; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`,
		"x-frame-options": "DENY",
		...overrides,
	};
}

function redirectProtectionResponse(
	origin = PRODUCTION_ORIGIN,
	callbackNonce = protectionCallbackNonce(),
) {
	const target = `${origin}/api/prove/deployment-attestation`;
	const location = new URL("https://vercel.com/sso-api");
	location.searchParams.set("url", target);
	location.searchParams.set("nonce", callbackNonce);
	return new Response(null, {
		status: 302,
		headers: {
			...protectionHeaders(),
			location: location.href,
		},
	});
}

function encodedInput(input = proofInput()) {
	return Buffer.concat(
		[
			"GITHUB_REPOSITORY",
			"GITHUB_TOKEN",
			"RC_PRODUCTION_DEPLOYMENT_ID",
			"RC_INSPECTION_RECEIPT_FILE",
			"VERCEL_AUTOMATION_BYPASS_SECRET",
			"VERCEL_TOKEN",
		].map((field) => Buffer.from(`${input[field]}\0`, "utf8")),
	);
}

function bufferReader(contents) {
	let offset = 0;
	return (_fd, buffer, targetOffset, length) => {
		const count = Math.min(length, contents.length - offset);
		if (count === 0) return 0;
		contents.copy(buffer, targetOffset, offset, offset + count);
		offset += count;
		return count;
	};
}

const FIFO_STAT = { isFIFO: () => true };
const BOOTSTRAP_ENV = {
	LANG: "C.UTF-8",
	PATH: "/usr/bin:/bin",
	RC_PRODUCTION_INPUT_FD: "0",
	RC_PRODUCTION_REPOSITORY_ROOT: ROOT,
};
const PUBLISH_ENV = {
	LANG: "C.UTF-8",
	PATH: "/usr/bin:/bin",
	RC_PRODUCTION_PUBLISH_INPUT_FD: "0",
	RC_PRODUCTION_REPOSITORY_ROOT: ROOT,
};

test("bootstrap accepts only the exact clean environment, repository root, and NUL pipe fields", () => {
	assert.equal(validateBootstrapEnvironment(BOOTSTRAP_ENV), ROOT);
	assert.throws(
		() => validateBootstrapEnvironment({ ...BOOTSTRAP_ENV, HOME: "/tmp" }),
		/not exact|unexpected fields/,
	);
	assert.throws(
		() =>
			validateBootstrapEnvironment({
				...BOOTSTRAP_ENV,
				RC_PRODUCTION_REPOSITORY_ROOT: ".",
			}),
		/not absolute/,
	);
	assert.deepEqual(
		readProofBootstrapInput({
			environment: BOOTSTRAP_ENV,
			read: bufferReader(encodedInput()),
			statFd: () => FIFO_STAT,
		}),
		proofInput(),
	);
	assert.throws(
		() =>
			readProofBootstrapInput({
				environment: BOOTSTRAP_ENV,
				read: bufferReader(Buffer.from("unterminated")),
				statFd: () => FIFO_STAT,
			}),
		/incomplete/,
	);
	assert.throws(
		() =>
			readProofBootstrapInput({
				environment: BOOTSTRAP_ENV,
				read: bufferReader(encodedInput()),
				statFd: () => ({ isFIFO: () => false }),
			}),
		/not a pipe/,
	);
});

test("credential-free publisher accepts only an exact environment and byte binding", () => {
	assert.equal(validatePublishBootstrapEnvironment(PUBLISH_ENV), ROOT);
	assert.throws(
		() =>
			validatePublishBootstrapEnvironment({
				...PUBLISH_ENV,
				GITHUB_TOKEN: "forbidden",
			}),
		/unexpected fields|not exact/,
	);
	const binding = {
		stagePath: join(
			RESULT_ROOT,
			".production-release-stage-12345678-1234-4123-8123-123456789abc.json",
		),
		sha256: HASH,
		device: "2049",
		inode: "12345",
		size: "4096",
	};
	const encoded = Buffer.from(
		Object.values(binding)
			.map((value) => `${value}\0`)
			.join(""),
		"utf8",
	);
	assert.deepEqual(
		readPublishBootstrapInput({
			environment: PUBLISH_ENV,
			read: bufferReader(encoded),
			statFd: () => FIFO_STAT,
		}),
		binding,
	);
	assert.throws(() =>
		readPublishBootstrapInput({
			environment: PUBLISH_ENV,
			read: bufferReader(Buffer.from(`${binding.stagePath}\0${HASH}\0`)),
			statFd: () => FIFO_STAT,
		}),
	);
});

test("private input rejects extra fields, bad ids, and noncanonical receipt paths", () => {
	const valid = proofInput();
	assert.equal(validateProofInput(valid), valid);
	for (const input of [
		{ ...proofInput(), EXTRA: "no" },
		proofInput({ RC_PRODUCTION_DEPLOYMENT_ID: "0" }),
		proofInput({ RC_PRODUCTION_DEPLOYMENT_ID: " 123456" }),
		proofInput({ RC_INSPECTION_RECEIPT_FILE: "relative.json" }),
		proofInput({ GITHUB_REPOSITORY: "not-a-repository" }),
		proofInput({ GITHUB_REPOSITORY: " ejc3/remote-claw" }),
		proofInput({ VERCEL_AUTOMATION_BYPASS_SECRET: "" }),
	]) {
		assert.throws(() => validateProofInput(input));
	}
	const missingBypass = proofInput();
	delete missingBypass.VERCEL_AUTOMATION_BYPASS_SECRET;
	assert.throws(() => validateProofInput(missingBypass));
});

test("BusyBox wrapper keeps credentials off argv and output", () => {
	const source = readFileSync(CLEAN_WRAPPER, "utf8");
	assert.match(source, /^#!\/bin\/busybox ash/);
	assert.match(source, /busybox sha256sum \/proc\/\$\$\/exe/);
	assert.match(source, /\[ "\$#" -eq 0 \] \|\| fail/);
	assert.match(source, /printf '%s\\0'/);
	assert.match(source, /\/bin\/busybox env -i/);
	assert.match(source, /RC_PRODUCTION_INPUT_FD=0/);
	assert.match(source, /RC_PRODUCTION_REPOSITORY_ROOT="\$repository_root"/);
	assert.doesNotMatch(
		source,
		/\/usr\/bin\/node[^\n]*(GITHUB_TOKEN|VERCEL_TOKEN|VERCEL_AUTOMATION_BYPASS_SECRET|RC_INSPECTION_RECEIPT_FILE)/,
	);
	const sentinel = "SENTINEL_PRODUCTION_SECRET";
	const baseEnvironment = {
		GITHUB_REPOSITORY: "ejc3/remote-claw",
		GITHUB_TOKEN: sentinel,
		RC_PRODUCTION_DEPLOYMENT_ID: "123",
		RC_INSPECTION_RECEIPT_FILE: join(RESULT_ROOT, "missing.json"),
		VERCEL_AUTOMATION_BYPASS_SECRET: sentinel,
		VERCEL_TOKEN: sentinel,
	};
	const result = spawnSync(CLEAN_WRAPPER, [sentinel], {
		encoding: "utf8",
		env: baseEnvironment,
	});
	assert.equal(result.status, 126);
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel));
	for (const bypass of [undefined, ""]) {
		const environment = { ...baseEnvironment };
		if (bypass === undefined) {
			delete environment.VERCEL_AUTOMATION_BYPASS_SECRET;
		} else {
			environment.VERCEL_AUTOMATION_BYPASS_SECRET = bypass;
		}
		const refused = spawnSync(CLEAN_WRAPPER, [], {
			encoding: "utf8",
			env: environment,
		});
		assert.equal(refused.status, 126);
		assert.doesNotMatch(
			`${refused.stdout}${refused.stderr}`,
			new RegExp(sentinel),
		);
	}
});

test("BusyBox wrapper proves and snapshots committed release bytes before opening the credential pipe", () => {
	const source = readFileSync(CLEAN_WRAPPER, "utf8");
	const firstTreeCheck = source.indexOf("verify_release_tree || fail");
	const pipeOpen = source.indexOf("printf '%s\\0'");
	const secondTreeCheck = source.lastIndexOf("verify_release_tree || fail");
	assert.ok(firstTreeCheck > 0);
	assert.ok(pipeOpen > firstTreeCheck);
	assert.ok(secondTreeCheck > pipeOpen);
	assert.match(source, /busybox sha256sum "\$git_path"/);
	assert.match(source, /busybox sha256sum "\$node_path"/);
	assert.match(source, /timeout -s KILL 10[\s\S]*env -i/);
	assert.match(source, /GIT_CONFIG_NOSYSTEM=1/);
	assert.match(source, /GIT_CONFIG_GLOBAL=\/dev\/null/);
	assert.match(source, /GIT_NO_REPLACE_OBJECTS=1/);
	assert.match(source, /GIT_TERMINAL_PROMPT=0/);
	assert.match(source, /GIT_OPTIONAL_LOCKS=0/);
	assert.match(source, /core\.fsmonitor=false/);
	assert.match(source, /core\.hooksPath=\/dev\/null/);
	assert.match(source, /credential\.helper=/);
	assert.match(source, /protocol\.file\.allow=never/);
	assert.match(source, /status --porcelain=v1 --untracked-files=all/);
	assert.match(
		source,
		/merge-base --is-ancestor "\$candidate_head" "\$git_head"/,
	);
	assert.match(source, /\[ "\$candidate_tree" = "\$release_tree" \]/);
	assert.match(source, /initial_release_head=\$git_head/);
	assert.match(source, /initial_release_tree=\$release_tree/);
	assert.match(source, /\[ "\$git_head" = "\$initial_release_head" \]/);
	const stageParse = source.indexOf("stage_prefix='staged production release");
	const publisher = source.indexOf("RC_PRODUCTION_PUBLISH_INPUT_FD=0");
	assert.ok(stageParse > pipeOpen);
	assert.ok(secondTreeCheck > stageParse);
	assert.ok(publisher > secondTreeCheck);
	assert.match(source, /sha256sum "\$stage_candidate"/);
	assert.match(source, /"\$stage_device"/);
	assert.match(source, /"\$stage_inode"/);
	assert.match(source, /"\$stage_size"/);
	assert.match(source, /remote-claw-production-publisher\.XXXXXX/);
	assert.match(
		source,
		/\/usr\/bin\/node "\$publisher_runner_path" >"\$publisher_stdout"/,
	);
	assert.match(source, /publisher_started=1[\s\S]*run_publisher/);
	assert.match(
		source,
		/"\$publisher_started" -eq 0[\s\S]*"\$publisher_succeeded" -eq 1[\s\S]*rm -f -- "\$staged_receipt"/,
	);
	assert.match(
		source,
		/"\$publisher_status" -eq 75[\s\S]*"\$publisher_status" -ge 128[\s\S]*publisher_indeterminate_seen=1[\s\S]*run_publisher/,
	);
	assert.match(
		source,
		/"\$publisher_indeterminate_seen" -eq 1[\s\S]*publisher_status=75/,
	);
	assert.match(source, /publisher_succeeded=1[\s\S]*cat "\$publisher_stdout"/);
	assert.match(
		source,
		/find "\$receipt_root" -maxdepth 1 -name '\.production-release-stage-\*\.json' -print -quit[\s\S]*\[ -z "\$preserved_stage" \] \|\| fail/,
	);
	for (const path of [
		"scripts/verify-production-release-clean.sh",
		"scripts/verify-production-release.mjs",
		"scripts/inspection-receipt-schema.mjs",
	]) {
		assert.match(source, new RegExp(`materialize_committed_module ${path}`));
	}
});

test("outer HEAD recheck leaves no final receipt and permits a clean retry", (context) => {
	if (!pinnedReleaseHost) {
		context.skip("requires the pinned Linux/arm64 release host");
		return;
	}
	const sandbox = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-outer-recheck-")),
	);
	const repository = join(sandbox, "repository");
	const scripts = join(repository, "scripts");
	const receiptRoot = join(repository, "tests", "web", "test-results");
	const marker = join(sandbox, ".head-moved-once");
	const publisherRetryMarker = join(sandbox, ".publisher-retried");
	const signalPublisherMarker = join(sandbox, ".signal-publisher");
	const failedRecoveryMarker = join(sandbox, ".failed-recovery");
	const failedRecoveryAttempt = join(sandbox, ".failed-recovery-attempt");
	const gitEnvironment = {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		LANG: "C.UTF-8",
		PATH: "/usr/bin:/bin",
	};
	const git = (args) => {
		const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], {
			encoding: "utf8",
			env: gitEnvironment,
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	try {
		mkdirSync(scripts, { recursive: true, mode: 0o700 });
		mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
		chmodSync(receiptRoot, 0o700);
		writeFileSync(
			join(scripts, "verify-production-release-clean.sh"),
			readFileSync(CLEAN_WRAPPER),
			{ mode: 0o755 },
		);
		chmodSync(join(scripts, "verify-production-release-clean.sh"), 0o755);
		writeFileSync(
			join(scripts, "inspection-receipt-schema.mjs"),
			"export const fixture = true;\n",
			{ mode: 0o644 },
		);
		const fakeRunner = [
			'import { spawnSync } from "node:child_process";',
			'import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";',
			'import { basename, dirname, join } from "node:path";',
			"const root = process.env.RC_PRODUCTION_REPOSITORY_ROOT;",
			"const input = readFileSync(0);",
			'if (process.env.RC_PRODUCTION_INPUT_FD === "0") {',
			"  input.fill(0);",
			'  const stage = join(root, "tests", "web", "test-results", ".production-release-stage-12345678-1234-4123-8123-123456789abc.json");',
			'  writeFileSync(stage, "{}\\n", { mode: 0o600, flag: "wx" });',
			'  process.stdout.write("staged production release attestation: " + stage + "\\n");',
			`  const marker = ${JSON.stringify(marker)};`,
			"  if (!existsSync(marker)) {",
			'    writeFileSync(marker, "moved\\n", { mode: 0o600, flag: "wx" });',
			'    const moved = spawnSync("/usr/bin/git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "move HEAD"], { env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8", PATH: "/usr/bin:/bin" } });',
			"    if (moved.status !== 0) process.exit(2);",
			"  }",
			'} else if (process.env.RC_PRODUCTION_PUBLISH_INPUT_FD === "0") {',
			"  const fields = input.toString('utf8').split('\\0');",
			"  input.fill(0);",
			"  const stage = fields[0];",
			'  const head = spawnSync("/usr/bin/git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8", PATH: "/usr/bin:/bin" } }).stdout.trim();',
			'  const finalPath = join(dirname(stage), "production-release-attestation-" + head + "-123.json");',
			`  const failedRecoveryMarker = ${JSON.stringify(failedRecoveryMarker)};`,
			`  const failedRecoveryAttempt = ${JSON.stringify(failedRecoveryAttempt)};`,
			"  if (existsSync(failedRecoveryMarker)) {",
			"    if (!existsSync(failedRecoveryAttempt)) {",
			'      writeFileSync(finalPath, readFileSync(stage), { mode: 0o600, flag: "wx" });',
			'      writeFileSync(failedRecoveryAttempt, "attempt\\n", { mode: 0o600, flag: "wx" });',
			"      process.exit(75);",
			"    }",
			"    process.exit(1);",
			"  }",
			`  if (existsSync(${JSON.stringify(signalPublisherMarker)})) {`,
			'    writeFileSync(finalPath, readFileSync(stage), { mode: 0o600, flag: "wx" });',
			'    process.kill(process.ppid, "SIGTERM");',
			"    await new Promise((resolve) => setTimeout(resolve, 250));",
			"    process.exit(74);",
			"  }",
			`  const retryMarker = ${JSON.stringify(publisherRetryMarker)};`,
			"  if (!existsSync(retryMarker)) {",
			'    writeFileSync(finalPath, readFileSync(stage), { mode: 0o600, flag: "wx" });',
			'    writeFileSync(retryMarker, "retry\\n", { mode: 0o600, flag: "wx" });',
			"    process.exit(75);",
			"  }",
			'  process.stdout.write("production release attestation: " + finalPath + "\\n");',
			"} else { process.exit(3); }",
		].join("\n");
		writeFileSync(join(scripts, "verify-production-release.mjs"), fakeRunner, {
			mode: 0o644,
		});
		writeFileSync(join(repository, ".gitignore"), "tests/web/test-results/\n");
		spawnSync("/usr/bin/git", ["init", repository], {
			encoding: "utf8",
			env: gitEnvironment,
		});
		git(["add", "."]);
		git([
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"commit.gpgSign=false",
			"commit",
			"-m",
			"candidate",
		]);
		const candidate = git(["rev-parse", "--verify", "HEAD"]);
		const receiptPath = join(
			receiptRoot,
			`real-topology-browser-leg-${candidate}-12345678123441238123123456789abc.inspection-v1.json`,
		);
		writeFileSync(receiptPath, "{}\n", { mode: 0o600, flag: "wx" });
		const environment = {
			GITHUB_REPOSITORY: "ejc3/remote-claw",
			GITHUB_TOKEN: "github-secret",
			RC_INSPECTION_RECEIPT_FILE: receiptPath,
			RC_PRODUCTION_DEPLOYMENT_ID: "123",
			VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
			VERCEL_TOKEN: "vercel-secret",
		};
		const preservedStage = join(
			receiptRoot,
			".production-release-stage-00000000-0000-4000-8000-000000000001.json",
		);
		writeFileSync(preservedStage, "preserved-stage\n", { mode: 0o600 });
		const preservedStageStat = lstatSync(preservedStage);
		const preserved = spawnSync(
			join(scripts, "verify-production-release-clean.sh"),
			[],
			{ encoding: "utf8", env: environment },
		);
		assert.equal(preserved.status, 126, preserved.stderr);
		const preservedStageAfter = lstatSync(preservedStage);
		assert.equal(preservedStageAfter.dev, preservedStageStat.dev);
		assert.equal(preservedStageAfter.ino, preservedStageStat.ino);
		assert.equal(readFileSync(preservedStage, "utf8"), "preserved-stage\n");
		assert.equal(existsSync(marker), false);
		rmSync(preservedStage);
		const first = spawnSync(
			join(scripts, "verify-production-release-clean.sh"),
			[],
			{ encoding: "utf8", env: environment },
		);
		assert.equal(first.status, 126);
		assert.deepEqual(
			readdirSync(receiptRoot).filter((name) =>
				name.startsWith("production-release-attestation-"),
			),
			[],
		);
		assert.deepEqual(
			readdirSync(receiptRoot).filter((name) =>
				name.startsWith(".production-release-stage-"),
			),
			[],
		);

		writeFileSync(signalPublisherMarker, "signal\n", { mode: 0o600 });
		const interrupted = spawnSync(
			join(scripts, "verify-production-release-clean.sh"),
			[],
			{ encoding: "utf8", env: environment },
		);
		assert.equal(interrupted.status, 143, interrupted.stderr);
		const interruptedCanonical = readdirSync(receiptRoot).filter((name) =>
			name.startsWith("production-release-attestation-"),
		);
		const interruptedStage = readdirSync(receiptRoot).filter((name) =>
			name.startsWith(".production-release-stage-"),
		);
		assert.equal(interruptedCanonical.length, 1);
		assert.equal(interruptedStage.length, 1);
		rmSync(join(receiptRoot, interruptedCanonical[0]));
		rmSync(join(receiptRoot, interruptedStage[0]));
		rmSync(signalPublisherMarker);

		writeFileSync(failedRecoveryMarker, "fail\n", { mode: 0o600 });
		const unresolved = spawnSync(
			join(scripts, "verify-production-release-clean.sh"),
			[],
			{ encoding: "utf8", env: environment },
		);
		assert.equal(unresolved.status, 75, unresolved.stderr);
		const unresolvedCanonical = readdirSync(receiptRoot).filter((name) =>
			name.startsWith("production-release-attestation-"),
		);
		const unresolvedStage = readdirSync(receiptRoot).filter((name) =>
			name.startsWith(".production-release-stage-"),
		);
		assert.equal(unresolvedCanonical.length, 1);
		assert.equal(unresolvedStage.length, 1);
		rmSync(join(receiptRoot, unresolvedCanonical[0]));
		rmSync(join(receiptRoot, unresolvedStage[0]));
		rmSync(failedRecoveryMarker);
		rmSync(failedRecoveryAttempt);

		const retry = spawnSync(
			join(scripts, "verify-production-release-clean.sh"),
			[],
			{ encoding: "utf8", env: environment },
		);
		assert.equal(retry.status, 0, retry.stderr);
		assert.equal(
			readdirSync(receiptRoot).filter((name) =>
				name.startsWith("production-release-attestation-"),
			).length,
			1,
		);
		assert.equal(existsSync(publisherRetryMarker), true);
		assert.deepEqual(
			readdirSync(receiptRoot).filter((name) =>
				name.startsWith(".production-release-stage-"),
			),
			[],
		);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

test("direct inherited-environment invocation refuses without disclosing secrets", () => {
	const sentinel = "SENTINEL_DIRECT_SECRET";
	const result = spawnSync("/usr/bin/node", [RUNNER], {
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_TOKEN: sentinel,
			VERCEL_TOKEN: sentinel,
			VERCEL_AUTOMATION_BYPASS_SECRET: sentinel,
		},
	});
	assert.equal(result.status, 1);
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel));
	const argvResult = spawnSync("/usr/bin/node", [RUNNER, sentinel], {
		encoding: "utf8",
		env: BOOTSTRAP_ENV,
	});
	assert.equal(argvResult.status, 1);
	assert.doesNotMatch(
		`${argvResult.stdout}${argvResult.stderr}`,
		new RegExp(sentinel),
	);
});

test("inspection reader hashes exact owned 0600 bytes under the pinned result root", () => {
	const receipt = inspectionReceipt();
	const path = join(RESULT_ROOT, inspectionName(receipt));
	const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	try {
		writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
		const inspected = readInspectionReceipt(path);
		assert.equal(inspected.sha256, sha256(bytes));
		assert.equal(inspected.candidateSha, CANDIDATE);
		assert.equal(inspected.organization, "proof-org");
		assert.equal(inspected.group, "proof-group");
		assert.deepEqual(inspected.receipt, receipt);
	} finally {
		rmSync(path, { force: true });
	}
});

test("inspection reader rejects mode, filename, schema, and out-of-root paths", () => {
	const cases = [
		{ receipt: inspectionReceipt(), name: inspectionName(), mode: 0o644 },
		{
			receipt: inspectionReceipt(),
			name: `wrong-${randomUUID()}.inspection-v1.json`,
			mode: 0o600,
		},
		{
			receipt: inspectionReceipt({ schema: "wrong/v1" }),
			name: inspectionName(),
			mode: 0o600,
		},
	];
	for (const candidate of cases) {
		const path = join(RESULT_ROOT, candidate.name);
		try {
			writeFileSync(path, `${JSON.stringify(candidate.receipt)}\n`, {
				mode: candidate.mode,
				flag: "wx",
			});
			chmodSync(path, candidate.mode);
			assert.throws(() => readInspectionReceipt(path));
		} finally {
			rmSync(path, { force: true });
		}
	}
	const outside = join(
		mkdtempSync(join(tmpdir(), "rc-inspection-outside-")),
		inspectionName(),
	);
	try {
		writeFileSync(outside, JSON.stringify(inspectionReceipt()), {
			mode: 0o600,
		});
		assert.throws(() => readInspectionReceipt(outside), /outside/);
	} finally {
		rmSync(dirname(outside), { recursive: true, force: true });
	}
});

test("Production accepts inspection evidence only inside the 71-hour freshness window", () => {
	const inspection = inspectionBinding();
	assert.equal(
		assertFreshInspection(inspection, "2026-08-27T00:05:00.000Z"),
		"2026-08-24T01:05:00.000Z",
	);
	assert.throws(
		() => assertFreshInspection(inspection, "2026-08-27T00:05:00.001Z"),
		/too old/,
	);
	assert.equal(
		assertFreshInspection(inspection, "2026-08-24T01:00:00.000Z"),
		"2026-08-24T01:05:00.000Z",
	);
	assert.throws(
		() => assertFreshInspection(inspection, "2026-08-24T00:59:59.999Z"),
		/from the future/,
	);
});

function localGitExecutor({
	head = PRODUCTION,
	status = "",
	candidateTree = TREE,
	productionTree = TREE,
	ancestor = true,
	replaceRefs = "",
	grafts = false,
} = {}) {
	const calls = [];
	const execFile = (_path, args, options) => {
		calls.push({ args, options });
		const command = args.slice(8);
		assert.deepEqual(args.slice(0, 8), [
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"credential.helper=",
			"-c",
			"protocol.file.allow=never",
		]);
		if (command[0] === "rev-parse" && command[1] === "--show-toplevel") {
			return `${ROOT}\n`;
		}
		if (command[0] === "for-each-ref") return replaceRefs;
		if (command[0] === "rev-parse" && command[1] === "--path-format=absolute") {
			return "/definitely-absent/remote-claw-test-git\n";
		}
		if (command[0] === "status") return status;
		if (command[0] === "merge-base") {
			if (!ancestor) throw new Error("not an ancestor");
			return "";
		}
		if (
			command[0] === "rev-parse" &&
			command[1] === "--verify" &&
			command[2] === "HEAD"
		) {
			return `${head}\n`;
		}
		if (command[0] === "rev-parse" && command[1] === `${CANDIDATE}^{tree}`) {
			return `${candidateTree}\n`;
		}
		if (command[0] === "rev-parse" && command[1] === `${head}^{tree}`) {
			return `${productionTree}\n`;
		}
		throw new Error("unexpected git command");
	};
	return { calls, execFile, pathExists: () => grafts };
}

test("local release state requires clean HEAD, candidate ancestry, and equal trees", () => {
	const clean = localGitExecutor();
	assert.deepEqual(
		inspectLocalReleaseState({
			candidateSha: CANDIDATE,
			execFile: clean.execFile,
			pathExists: clean.pathExists,
		}),
		localState(),
	);
	assert.deepEqual(clean.calls[5].args.slice(8), [
		"merge-base",
		"--is-ancestor",
		CANDIDATE,
		PRODUCTION,
	]);
	for (const call of clean.calls) {
		assert.equal(call.options.timeout, 15_000);
		assert.deepEqual(call.options.env, {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_TERMINAL_PROMPT: "0",
			LANG: "C.UTF-8",
			PATH: "/usr/bin:/bin",
		});
	}
	for (const options of [
		{ status: " M tracked-file\n" },
		{ ancestor: false },
		{ productionTree: OTHER_TREE },
		{ replaceRefs: "refs/replace/aaaaaaaa\n" },
		{ grafts: true },
	]) {
		const candidate = localGitExecutor(options);
		assert.throws(() =>
			inspectLocalReleaseState({
				candidateSha: CANDIDATE,
				execFile: candidate.execFile,
				pathExists: candidate.pathExists,
			}),
		);
	}
});

test("GitHub accepts an equal-tree merge commit and exact newest Production status", () => {
	assert.deepEqual(
		validateGithubProductionDeployment({
			productionDeployments: githubDeployments(),
			deployment: githubDeployment(),
			statuses: githubStatuses(),
			mainRef: githubRef(),
			candidateCommit: githubCommit(CANDIDATE),
			productionCommit: githubCommit(PRODUCTION),
			comparison: githubComparison(),
			deploymentId: "123456",
			expectedHead: PRODUCTION,
			candidateSha: CANDIDATE,
			localCandidateTree: TREE,
			localProductionTree: TREE,
		}),
		githubResolution(),
	);
});

test("GitHub rejects moved main, wrong deployment identity, and any tree mismatch", () => {
	assert.throws(
		() => validateGithubMainRef(githubRef(OTHER), PRODUCTION),
		/main/,
	);
	const base = {
		productionDeployments: githubDeployments(),
		deployment: githubDeployment(),
		statuses: githubStatuses(),
		mainRef: githubRef(),
		candidateCommit: githubCommit(CANDIDATE),
		productionCommit: githubCommit(PRODUCTION),
		comparison: githubComparison(),
		deploymentId: "123456",
		expectedHead: PRODUCTION,
		candidateSha: CANDIDATE,
		localCandidateTree: TREE,
		localProductionTree: TREE,
	};
	for (const override of [
		{
			productionDeployments: [
				githubDeployment({ id: 999999 }),
				githubDeployment(),
			],
		},
		{ deployment: githubDeployment({ sha: OTHER }) },
		{ deployment: githubDeployment({ environment: "Preview" }) },
		{ deployment: githubDeployment({ creator: { login: "attacker" } }) },
		{ statuses: githubStatuses({ state: "pending" }) },
		{
			statuses: [githubStatuses({ state: "failure" })[0], ...githubStatuses()],
		},
		{ candidateCommit: githubCommit(CANDIDATE, OTHER_TREE) },
		{ productionCommit: githubCommit(PRODUCTION, OTHER_TREE) },
		{ localCandidateTree: OTHER_TREE },
		{ localProductionTree: OTHER_TREE },
		{ comparison: githubComparison({ status: "diverged" }) },
		{
			comparison: githubComparison({
				merge_base_commit: { sha: OTHER },
			}),
		},
	]) {
		assert.throws(() =>
			validateGithubProductionDeployment({ ...base, ...override }),
		);
	}
});

test("GitHub ancestry validator rejects unrelated equal-tree commits", () => {
	assert.equal(
		validateGithubCandidateAncestry(githubComparison(), {
			candidateSha: CANDIDATE,
			productionSha: PRODUCTION,
		}),
		true,
	);
	for (const comparison of [
		githubComparison({ status: "diverged" }),
		githubComparison({ behind_by: 1 }),
		githubComparison({ merge_base_commit: { sha: OTHER } }),
		githubComparison({ base_commit: { sha: OTHER } }),
	]) {
		assert.throws(() =>
			validateGithubCandidateAncestry(comparison, {
				candidateSha: CANDIDATE,
				productionSha: PRODUCTION,
			}),
		);
	}
});

test("GitHub resolver uses exact deployment, status, main-ref, and commit APIs", async () => {
	const seen = [];
	const bodies = [
		githubDeployments(),
		githubDeployment(),
		githubStatuses(),
		githubRef(),
		githubCommit(CANDIDATE),
		githubCommit(PRODUCTION),
		githubComparison(),
	];
	const resolved = await resolveGithubProduction({
		repository: "ejc3/remote-claw",
		token: "github-secret",
		deploymentId: "123456",
		expectedHead: PRODUCTION,
		candidateSha: CANDIDATE,
		localCandidateTree: TREE,
		localProductionTree: TREE,
		fetchImpl: async (url, options) => {
			seen.push({ url, options });
			return jsonResponse(bodies[seen.length - 1]);
		},
	});
	assert.deepEqual(resolved, githubResolution());
	assert.deepEqual(
		seen.map((call) => new URL(call.url).pathname + new URL(call.url).search),
		[
			"/repos/ejc3/remote-claw/deployments?environment=Production&per_page=100",
			"/repos/ejc3/remote-claw/deployments/123456",
			"/repos/ejc3/remote-claw/deployments/123456/statuses?per_page=100",
			"/repos/ejc3/remote-claw/git/ref/heads/main",
			`/repos/ejc3/remote-claw/git/commits/${CANDIDATE}`,
			`/repos/ejc3/remote-claw/git/commits/${PRODUCTION}`,
			`/repos/ejc3/remote-claw/compare/${CANDIDATE}...${PRODUCTION}`,
		],
	);
	for (const call of seen) {
		assert.equal(call.options.redirect, "error");
		assert.equal(call.options.headers.authorization, "Bearer github-secret");
		assert.equal(call.options.headers["x-vercel-protection-bypass"], undefined);
	}
});

test("newest Production deployment check rejects a stale supplied id", () => {
	assert.equal(
		validateNewestGithubProductionDeployment(githubDeployments(), {
			deploymentId: "123456",
			expectedHead: PRODUCTION,
		}),
		"123456",
	);
	assert.throws(
		() =>
			validateNewestGithubProductionDeployment(
				[githubDeployment({ id: 999999 }), githubDeployment()],
				{ deploymentId: "123456", expectedHead: PRODUCTION },
			),
		/newest/,
	);
});

test("final GitHub recheck covers newest Production deployment and main ref", async () => {
	const seen = [];
	const resolved = await resolveGithubMainHead({
		repository: "ejc3/remote-claw",
		token: "github-secret",
		expectedHead: PRODUCTION,
		deploymentId: "123456",
		expectedOrigin: PRODUCTION_ORIGIN,
		fetchImpl: async (url) => {
			seen.push(url);
			return jsonResponse(
				seen.length === 1
					? githubDeployments()
					: seen.length === 2
						? githubStatuses()
						: githubRef(),
			);
		},
	});
	assert.equal(resolved, PRODUCTION);
	assert.match(seen[0], /deployments\?environment=Production/);
	assert.match(seen[1], /deployments\/123456\/statuses/);
	assert.match(seen[2], /git\/ref\/heads\/main/);
	await assert.rejects(
		resolveGithubMainHead({
			repository: "ejc3/remote-claw",
			token: "github-secret",
			expectedHead: PRODUCTION,
			deploymentId: "123456",
			expectedOrigin: PRODUCTION_ORIGIN,
			fetchImpl: async (url) =>
				jsonResponse(
					url.includes("deployments?")
						? [githubDeployment({ id: 999999 }), githubDeployment()]
						: url.includes("statuses")
							? githubStatuses()
							: githubRef(),
				),
		}),
		/newest/,
	);
	await assert.rejects(
		resolveGithubMainHead({
			repository: "ejc3/remote-claw",
			token: "github-secret",
			expectedHead: PRODUCTION,
			deploymentId: "123456",
			expectedOrigin: PRODUCTION_ORIGIN,
			fetchImpl: async (url) =>
				jsonResponse(
					url.includes("deployments?")
						? githubDeployments()
						: url.includes("statuses")
							? githubStatuses({ state: "failure" })
							: githubRef(),
				),
		}),
		/newest status/,
	);
});

test("immutable production origin rejects aliases and URL smuggling", () => {
	assert.equal(
		validateImmutableProductionOrigin(PRODUCTION_ORIGIN),
		PRODUCTION_ORIGIN,
	);
	for (const origin of [
		"https://remote-claw.vercel.app",
		"https://evil.example",
		`${PRODUCTION_ORIGIN}/path`,
		`${PRODUCTION_ORIGIN}/`,
		`${PRODUCTION_ORIGIN}?token=x`,
		PRODUCTION_ORIGIN.replace("https:", "http:"),
	]) {
		assert.throws(() => validateImmutableProductionOrigin(origin));
	}
});

test("Vercel v13 validator rejects wrong project/team/target/state/url/SHA", () => {
	assert.equal(vercelDeployment().teamId, undefined);
	assert.deepEqual(
		validateVercelProductionDeployment(vercelDeployment(), {
			origin: PRODUCTION_ORIGIN,
			expectedHead: PRODUCTION,
		}),
		vercelResolution(),
	);
	assert.deepEqual(
		validateVercelProductionDeployment(
			vercelDeployment({ projectId: undefined }),
			{ origin: PRODUCTION_ORIGIN, expectedHead: PRODUCTION },
		),
		vercelResolution(),
	);
	for (const deployment of [
		vercelDeployment({ projectId: "prj_wrong" }),
		vercelDeployment({ teamId: "team_wrong" }),
		vercelDeployment({ ownerId: "team_wrong" }),
		vercelDeployment({ target: "preview" }),
		vercelDeployment({ readyState: "BUILDING" }),
		vercelDeployment({ status: "BUILDING" }),
		vercelDeployment({ project: { id: "prj_wrong" } }),
		vercelDeployment({ url: "evil.example" }),
		vercelDeployment({ id: "not-a-deployment" }),
		vercelDeployment({
			meta: { githubCommitSha: OTHER, githubCommitRef: "main" },
		}),
		vercelDeployment({
			meta: { githubCommitSha: PRODUCTION, githubCommitRef: "feature" },
		}),
		vercelDeployment({
			gitSource: { type: "github", ref: "main", sha: OTHER },
		}),
		vercelDeployment({
			gitSource: { type: "github", ref: "feature", sha: PRODUCTION },
		}),
	]) {
		assert.throws(() =>
			validateVercelProductionDeployment(deployment, {
				origin: PRODUCTION_ORIGIN,
				expectedHead: PRODUCTION,
			}),
		);
	}
	assert.throws(() =>
		validateVercelProductionDeployment(vercelDeployment(), {
			origin: PRODUCTION_ORIGIN,
			expectedHead: PRODUCTION,
			requestTeamId: "team_wrong",
		}),
	);
});

test("Vercel resolver uses v13 with fixed team and status immutable hostname", async () => {
	let call;
	const resolved = await resolveVercelProduction({
		origin: PRODUCTION_ORIGIN,
		expectedHead: PRODUCTION,
		token: "vercel-secret",
		fetchImpl: async (url, options) => {
			call = { url, options };
			return jsonResponse(vercelDeployment());
		},
	});
	assert.deepEqual(resolved, vercelResolution());
	assert.equal(
		call.url,
		`https://api.vercel.com/v13/deployments/${new URL(PRODUCTION_ORIGIN).hostname}?withGitRepoInfo=true&teamId=${TEAM_ID}`,
	);
	assert.equal(call.options.headers.authorization, "Bearer vercel-secret");
	assert.equal(call.options.headers["x-vercel-protection-bypass"], undefined);
});

test("Production sealing re-attests the exact live WAF rule and empty bypass list", async () => {
	const calls = [];
	const attestation = await attestProductionFirewall({
		token: "vercel-secret",
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			return jsonResponse(
				url.includes("/config?") ? wafConfigFixture() : { result: [] },
			);
		},
	});
	assert.deepEqual(attestation, firewallAttestation());
	assert.equal(validateProductionFirewallAttestation(attestation), attestation);
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.match(
			call.url,
			/^https:\/\/api\.vercel\.com\/v1\/security\/firewall\//,
		);
		assert.match(call.url, new RegExp(`projectId=${PROJECT_ID}`));
		assert.match(call.url, new RegExp(`teamId=${TEAM_ID}`));
		assert.equal(call.options.redirect, "error");
		assert.equal(call.options.headers.authorization, "Bearer vercel-secret");
	}
});

test("Production WAF attestation fails closed on policy drift or bypass entries", async () => {
	for (const mutate of [
		(config, _bypass) => {
			config.active.rules[0].action.mitigate.rateLimit.limit = 21;
		},
		(config, _bypass) => {
			config.active.ips.push({ action: "deny", ip: "192.0.2.1" });
		},
		(config, _bypass) => {
			delete config.active.crs.java;
		},
		(config, _bypass) => {
			config.active.crs.xss.active = false;
		},
		(config, _bypass) => {
			config.active.crs.rce.action = "deny";
		},
		(config, _bypass) => {
			config.active.crs.owasp = { active: true, action: "log" };
		},
		(config, _bypass) => {
			config.active.ownerId = "team_wrong";
		},
		(config, _bypass) => {
			config.active.projectKey = "prj_wrong";
		},
		(config, _bypass) => {
			config.active.updatedAt = "not-canonical";
		},
		(config, _bypass) => {
			config.active.unattestedPolicy = true;
		},
		(config, _bypass) => {
			config.draft = {};
		},
		(_config, bypass) => {
			bypass.result.push({ id: "unexpected" });
		},
	]) {
		const config = wafConfigFixture();
		const bypass = { result: [] };
		mutate(config, bypass);
		let request = 0;
		await assert.rejects(
			attestProductionFirewall({
				token: "vercel-secret",
				fetchImpl: async () => jsonResponse(request++ === 0 ? config : bypass),
			}),
			/pinned live policy/,
		);
	}
});

test("production runtime requires production/sqlite/turso/prod and inspected org/group", () => {
	assert.deepEqual(
		normalizeProductionRuntimeAttestation(runtimeAttestation(), {
			expectedHead: PRODUCTION,
			organization: "proof-org",
			group: "proof-group",
		}),
		runtimeAttestation(),
	);
	for (const attestation of [
		runtimeAttestation({ environment: "preview" }),
		runtimeAttestation({ sha: OTHER }),
		runtimeAttestation({}, { backend: "vercel" }),
		runtimeAttestation({}, { locator: "local" }),
		runtimeAttestation({}, { scope: "pr-aaaaaaa" }),
		runtimeAttestation({}, { organization: "other-org" }),
		runtimeAttestation({}, { group: "other-group" }),
	]) {
		assert.throws(() =>
			normalizeProductionRuntimeAttestation(attestation, {
				expectedHead: PRODUCTION,
				organization: "proof-org",
				group: "proof-group",
			}),
		);
	}
});

test("runtime attestation is no-store, redirect-denying, and confines the bypass", async () => {
	let call;
	const attestation = await attestProductionRuntime({
		origin: PRODUCTION_ORIGIN,
		expectedHead: PRODUCTION,
		organization: "proof-org",
		group: "proof-group",
		bypass: "bypass-secret",
		fetchImpl: async (url, options) => {
			call = { url, options };
			return jsonResponse(runtimeAttestation(), {
				headers: { "cache-control": "private, no-store" },
			});
		},
	});
	assert.deepEqual(attestation, runtimeAttestation());
	assert.equal(
		call.url,
		`${PRODUCTION_ORIGIN}/api/prove/deployment-attestation`,
	);
	assert.equal(call.options.cache, "no-store");
	assert.equal(call.options.redirect, "error");
	assert.deepEqual(call.options.headers, {
		accept: "application/json",
		"x-vercel-protection-bypass": "bypass-secret",
	});
	await assert.rejects(
		attestProductionRuntime({
			origin: PRODUCTION_ORIGIN,
			expectedHead: PRODUCTION,
			organization: "proof-org",
			group: "proof-group",
			bypass: "",
			fetchImpl: async () => assert.fail("blank bypass must fail before fetch"),
		}),
		/VERCEL_AUTOMATION_BYPASS_SECRET/,
	);
	await assert.rejects(
		attestProductionRuntime({
			origin: PRODUCTION_ORIGIN,
			expectedHead: PRODUCTION,
			organization: "proof-org",
			group: "proof-group",
			bypass: "bypass-secret",
			fetchImpl: async () =>
				jsonResponse(runtimeAttestation(), {
					headers: { "cache-control": "private, x-no-store" },
				}),
		}),
		/cacheable/,
	);
});

test("Production sealing requires the immutable origin to remain behind Vercel protection", async () => {
	let call;
	assert.equal(
		await attestProductionDeploymentProtection({
			origin: PRODUCTION_ORIGIN,
			fetchImpl: async (url, options) => {
				call = { url, options };
				return protectionResponse();
			},
		}),
		true,
	);
	assert.equal(
		call.url,
		`${PRODUCTION_ORIGIN}/api/prove/deployment-attestation`,
	);
	assert.equal(call.options.redirect, "manual");
	assert.deepEqual(call.options.headers, { accept: "application/json" });
	assert.equal(
		await attestProductionDeploymentProtection({
			origin: PRODUCTION_ORIGIN,
			fetchImpl: async () => redirectProtectionResponse(),
		}),
		true,
	);
	for (const response of [
		new Response(null, { status: 200 }),
		protectionResponse(
			PRODUCTION_ORIGIN,
			{},
			protectionCallbackNonce("8".repeat(48)),
		),
		redirectProtectionResponse(
			PRODUCTION_ORIGIN,
			protectionCallbackNonce("8".repeat(48)),
		),
		new Response(null, {
			status: 302,
			headers: {
				...protectionHeaders(),
				location: "https://evil.example/sso-api",
			},
		}),
		protectionResponse(PRODUCTION_ORIGIN, {
			"set-cookie": `_vercel_sso_nonce=${"8".repeat(47)}; Path=/; Secure; HttpOnly`,
		}),
		new Response(null, {
			status: 302,
			headers: {
				...Object.fromEntries(redirectProtectionResponse().headers),
				"cache-control": "max-age=0",
			},
		}),
		new Response(null, {
			status: 302,
			headers: {
				...Object.fromEntries(redirectProtectionResponse().headers),
				"set-cookie": `_vercel_sso_nonce=${"8".repeat(47)}; Path=/; Secure; HttpOnly`,
			},
		}),
		new Response(null, {
			status: 302,
			headers: {
				...Object.fromEntries(redirectProtectionResponse().headers),
				"set-cookie": `_vercel_sso_nonce=${"9".repeat(48)}; Path=/; Secure; HttpOnly; _vercel_sso_nonce=${"9".repeat(48)}`,
			},
		}),
	]) {
		await assert.rejects(
			attestProductionDeploymentProtection({
				origin: PRODUCTION_ORIGIN,
				fetchImpl: async () => response,
			}),
			/protection/,
		);
	}
});

test("Production data-plane proof creates one opaque frame through relay and reads its durable cursor", async () => {
	const calls = [];
	const challenge = Buffer.alloc(32, 0x42);
	const attestation = await attestProductionDataPlane({
		origin: PRODUCTION_ORIGIN,
		expectedHead: PRODUCTION,
		bypass: "bypass-secret",
		newChallenge: () => challenge,
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			if (calls.length === 1) return protectionResponse();
			if (calls.length === 2) {
				return jsonResponse({ durable: true, frameCount: null });
			}
			if (calls.length === 3) {
				return jsonResponse({
					ok: true,
					channel: "session",
					runId: productionDatabaseId(Buffer.alloc(32, 0x42)),
					created: true,
				});
			}
			return jsonResponse({ durable: true, frameCount: 1 });
		},
	});
	assert.equal(
		normalizeProductionDataPlaneAttestation(attestation, PRODUCTION),
		attestation,
	);
	assert.equal(attestation.schema, "remote-claw-production-data-plane/v1");
	assert.equal(attestation.headSha, PRODUCTION);
	assert.equal(
		attestation.databaseId,
		productionDatabaseId(Buffer.alloc(32, 0x42)),
	);
	assert.match(attestation.frameSha256, /^[0-9a-f]{64}$/);
	assert.equal(calls.length, 4);
	assert.equal(
		calls[0].url,
		`${PRODUCTION_ORIGIN}/api/prove/deployment-attestation`,
	);
	assert.equal(calls[0].options.redirect, "manual");
	assert.equal(calls[0].options.headers.authorization, undefined);
	assert.equal(
		calls[0].options.headers["x-vercel-protection-bypass"],
		undefined,
	);
	assert.match(calls[1].url, /\/api\/frame-count\?session=/);
	assert.match(calls[2].url, /\/api\/relay\?session=/);
	assert.equal(new URL(calls[1].url).search, new URL(calls[2].url).search);
	assert.equal(new URL(calls[2].url).search, new URL(calls[3].url).search);
	assert.equal(calls[2].options.method, "POST");
	const frame = JSON.parse(calls[2].options.body);
	assert.equal(frame.record_kind, "release_storage_canary");
	assert.equal(frame.identity_id.length, 32);
	assert.equal(
		frame.session_id,
		new URL(calls[2].url).searchParams.get("session"),
	);
	for (const call of calls.slice(1)) {
		assert.equal(call.options.cache, "no-store");
		assert.equal(call.options.redirect, "error");
		assert.equal(
			call.options.headers.authorization,
			`Bearer ${"42".repeat(32)}`,
		);
		assert.equal(
			call.options.headers["x-vercel-protection-bypass"],
			"bypass-secret",
		);
	}
	assert.deepEqual(challenge, Buffer.alloc(32));
	assert.doesNotMatch(JSON.stringify(attestation), /42424242|bypass-secret/);
});

test("Production data-plane proof fails closed on preexisting, unwritten, or malformed channels", async () => {
	const cases = [
		[{ durable: true, frameCount: 0 }],
		[
			{ durable: true, frameCount: null },
			{
				ok: true,
				channel: "session",
				runId: productionDatabaseId(Buffer.alloc(32, 1)),
				created: false,
			},
		],
		[
			{ durable: true, frameCount: null },
			{
				ok: true,
				channel: "session",
				runId: productionDatabaseId(Buffer.alloc(32, 1)),
				created: true,
			},
			{ durable: true, frameCount: 0 },
		],
		[
			{ durable: true, frameCount: null },
			{
				ok: true,
				channel: "session",
				runId: `rc-prod-s-${"0".repeat(16)}`,
				created: true,
			},
		],
		[{ durable: true, frameCount: null, extra: true }],
	];
	for (const bodies of cases) {
		let index = 0;
		let protectedOriginChecked = false;
		await assert.rejects(
			attestProductionDataPlane({
				origin: PRODUCTION_ORIGIN,
				expectedHead: PRODUCTION,
				bypass: "bypass-secret",
				newChallenge: () => Buffer.alloc(32, 1),
				fetchImpl: async () => {
					if (!protectedOriginChecked) {
						protectedOriginChecked = true;
						return protectionResponse();
					}
					return jsonResponse(bodies[index++]);
				},
			}),
		);
	}
	const sentinel = "SENTINEL_DATA_PLANE_PROVIDER_SECRET";
	await assert.rejects(
		attestProductionDataPlane({
			origin: PRODUCTION_ORIGIN,
			expectedHead: PRODUCTION,
			bypass: "bypass-secret",
			newChallenge: () => Buffer.alloc(32, 9),
			fetchImpl: async () => {
				throw new Error(sentinel);
			},
		}),
		(error) => !error.message.includes(sentinel),
	);
});

test("provider failures never include response bodies or thrown causes", async () => {
	const sentinel = "SENTINEL_PROVIDER_BODY_SECRET";
	await assert.rejects(
		attestProductionRuntime({
			origin: PRODUCTION_ORIGIN,
			expectedHead: PRODUCTION,
			organization: "proof-org",
			group: "proof-group",
			bypass: "bypass-secret",
			fetchImpl: async () => {
				throw new Error(sentinel);
			},
		}),
		(error) => !error.message.includes(sentinel),
	);
	await assert.rejects(
		resolveVercelProduction({
			origin: PRODUCTION_ORIGIN,
			expectedHead: PRODUCTION,
			token: "vercel-secret",
			fetchImpl: async () => new Response(sentinel, { status: 500 }),
		}),
		(error) => !error.message.includes(sentinel),
	);
});

test("production receipt strictly binds inspection, trees, providers, and runtime", () => {
	const receipt = productionReceipt();
	assert.equal(validateProductionReceipt(receipt), receipt);
	assert.deepEqual(receipt.inspection, {
		file: inspectionName(),
		sha256: HASH,
	});
	assert.deepEqual(receipt.candidate, {
		headSha: CANDIDATE,
		treeSha: TREE,
		githubDeploymentId: "987654",
	});
	assert.deepEqual(receipt.production, {
		headSha: PRODUCTION,
		treeSha: TREE,
	});
	assert.deepEqual(receipt.dataPlaneAttestation, dataPlaneAttestation());
	assert.deepEqual(receipt.firewallAttestation, firewallAttestation());
	assert.doesNotMatch(
		JSON.stringify(receipt),
		/bypass-secret|github-secret|vercel-secret/,
	);
	for (const candidate of [
		{ ...receipt, extra: true },
		{ ...receipt, schema: "wrong/v1" },
		{
			...receipt,
			inspection: { ...receipt.inspection, sha256: "short" },
		},
		{
			...receipt,
			production: { ...receipt.production, treeSha: OTHER_TREE },
		},
		{
			...receipt,
			vercel: { ...receipt.vercel, projectId: "prj_wrong" },
		},
		{
			...receipt,
			runtimeAttestation: runtimeAttestation({ environment: "preview" }),
		},
		{
			...receipt,
			dataPlaneAttestation: dataPlaneAttestation({ frameCountAfter: 0 }),
		},
		{
			...receipt,
			firewallAttestation: firewallAttestation({ firewallBypassCount: 1 }),
		},
	]) {
		assert.throws(() => validateProductionReceipt(candidate));
	}
});

test("receipt staging precedes credential-free atomic publication", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-receipt-")),
	);
	const receipt = productionReceipt();
	let directorySyncs = 0;
	try {
		const expected = productionReceiptPath(receipt, root);
		const staged = stageProductionReceipt(receipt, {
			receiptRoot: root,
			fsyncDirectory: (descriptor) => {
				directorySyncs += 1;
				fsyncSync(descriptor);
			},
		});
		assert.equal(existsSync(expected), false);
		assert.match(
			basename(staged),
			/^\.production-release-stage-[0-9a-f-]{36}\.json$/,
		);
		assert.equal(lstatSync(staged).mode & 0o777, 0o600);
		const written = publishStagedProductionReceipt(stagedBinding(staged), {
			receiptRoot: root,
			repositoryRoot: ROOT,
			localInspector: () => localState(),
			fsyncDirectory: (descriptor) => {
				directorySyncs += 1;
				fsyncSync(descriptor);
			},
		});
		assert.equal(written, expected);
		assert.equal(existsSync(staged), true);
		const stat = lstatSync(written);
		assert.equal(stat.mode & 0o777, 0o600);
		assert.equal(stat.nlink, 1);
		assert.deepEqual(JSON.parse(readFileSync(written, "utf8")), receipt);
		assert.deepEqual(
			readdirSync(root).sort(),
			[basename(expected), basename(staged)].sort(),
		);
		assert.ok(directorySyncs >= 2);
		assert.throws(
			() =>
				stageProductionReceipt(
					{
						...receipt,
						github: { ...receipt.github, deploymentId: "654321" },
					},
					{ receiptRoot: root, newId: () => "../escape" },
				),
			/staging id/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher rejects replacement staging bytes, leaves no final, and a fresh retry succeeds", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-stage-replace-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const firstStage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(firstStage);
		const exactBytes = readFileSync(firstStage);
		rmSync(firstStage);
		const replacementBytes = Buffer.from(
			exactBytes
				.toString("utf8")
				.replace(
					'"verifiedAt": "2026-08-24T02:00:00.000Z"',
					'"verifiedAt": "2025-08-24T02:00:00.000Z"',
				),
			"utf8",
		);
		assert.equal(replacementBytes.length, exactBytes.length);
		writeFileSync(firstStage, replacementBytes, { mode: 0o600, flag: "wx" });
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
				}),
			/staging identity changed|staging bytes could not be read exactly/,
		);
		assert.equal(existsSync(expected), false);
		rmSync(firstStage);
		const retryStage = stageProductionReceipt(receipt, { receiptRoot: root });
		assert.equal(
			publishStagedProductionReceipt(stagedBinding(retryStage), {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
			}),
			expected,
		);
		assert.equal(existsSync(expected), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher converges an observed one-time pair-sync failure without retracting canonical authority", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-sync-rollback-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		let directorySyncs = 0;
		assert.equal(
			publishStagedProductionReceipt(stagedBinding(stage), {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
				fsyncDirectory(descriptor) {
					directorySyncs += 1;
					if (directorySyncs === 2) {
						assert.equal(lstatSync(expected).nlink, 2);
						throw new Error("injected commit sync failure");
					}
					fsyncSync(descriptor);
				},
			}),
			expected,
		);
		assert.equal(directorySyncs, 4);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.equal(existsSync(stage), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher converges a one-time source-unlink failure without deleting canonical", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-unlink-rollback-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		let unlinks = 0;
		assert.equal(
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
				unlinkFile(path) {
					unlinks += 1;
					if (unlinks === 1) throw new Error("injected source unlink failure");
					unlinkSync(path);
				},
			}),
			expected,
		);
		assert.equal(unlinks, 2);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.equal(existsSync(stage), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fresh publisher reconciles an exact canonical link after an ambiguous EEXIST result", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-link-reconcile-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					linkFile(source, target) {
						linkSync(source, target);
						const error = new Error("injected ambiguous link result");
						error.code = "EEXIST";
						throw error;
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(lstatSync(expected).nlink, 2);
		assert.equal(
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
			}),
			expected,
		);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.equal(existsSync(stage), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh publication adopts an exact orphaned source after a pre-link failure", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-orphan-source-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					linkFile() {
						throw new Error("injected pre-link failure");
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(existsSync(expected), false);
		const temporaries = publicationTemporaries(root);
		assert.equal(temporaries.length, 1);
		const orphanStat = lstatSync(join(root, temporaries[0]));
		assert.equal(orphanStat.nlink, 1);

		assert.equal(
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
			}),
			expected,
		);
		const canonicalStat = lstatSync(expected);
		assert.equal(canonicalStat.nlink, 1);
		assert.equal(canonicalStat.dev, orphanStat.dev);
		assert.equal(canonicalStat.ino, orphanStat.ino);
		assert.equal(publicationTemporaries(root).length, 0);
		assert.equal(lstatSync(stage).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a torn random production source cannot block a fresh exact publication", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-torn-source-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		const publish = (options = {}) =>
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
				...options,
			});
		assert.throws(
			() =>
				publish({
					writeFile(descriptor, bytes) {
						writeFileSync(descriptor, bytes.subarray(0, 7));
						throw new Error("injected torn publication write");
					},
				}),
			/could not be published exclusively/,
		);
		assert.equal(existsSync(expected), false);
		const torn = publicationTemporaries(root);
		assert.equal(torn.length, 1);
		assert.equal(lstatSync(join(root, torn[0])).size, 7);

		assert.equal(publish(), expected);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.deepEqual(publicationTemporaries(root), torn);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production publication deterministically adopts one of multiple exact orphan sources", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-orphan-set-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		const prefix = `.${basename(expected)}.${binding.sha256}.`;
		const first = join(
			root,
			`${prefix}00000000-0000-4000-8000-000000000001.publish.tmp`,
		);
		const second = join(
			root,
			`${prefix}00000000-0000-4000-8000-000000000002.publish.tmp`,
		);
		const stageBytes = readFileSync(stage);
		writeFileSync(first, stageBytes, { mode: 0o600, flag: "wx" });
		writeFileSync(second, stageBytes, { mode: 0o600, flag: "wx" });
		const firstStat = lstatSync(first);

		assert.equal(
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
			}),
			expected,
		);
		const canonicalStat = lstatSync(expected);
		assert.equal(canonicalStat.dev, firstStat.dev);
		assert.equal(canonicalStat.ino, firstStat.ino);
		assert.equal(existsSync(first), false);
		assert.equal(lstatSync(second).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed production source-only sync leaves no canonical and a fresh invocation adopts the exact source", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-source-sync-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		const publish = (options = {}) =>
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
				...options,
			});
		assert.throws(
			() =>
				publish({
					fsyncDirectory() {
						throw new Error("injected source-only sync failure");
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(existsSync(expected), false);
		const temporaries = publicationTemporaries(root);
		assert.equal(temporaries.length, 1);
		const sourceStat = lstatSync(join(root, temporaries[0]));
		assert.equal(sourceStat.nlink, 1);

		assert.equal(publish(), expected);
		const canonicalStat = lstatSync(expected);
		assert.equal(canonicalStat.nlink, 1);
		assert.equal(canonicalStat.dev, sourceStat.dev);
		assert.equal(canonicalStat.ino, sourceStat.ino);
		assert.equal(publicationTemporaries(root).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production publication revalidates the exact link pair after its directory sync", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-pair-race-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		let directorySyncs = 0;
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					fsyncDirectory(descriptor) {
						directorySyncs += 1;
						fsyncSync(descriptor);
						if (directorySyncs === 2) {
							const [temporary] = publicationTemporaries(root);
							unlinkSync(join(root, temporary));
							writeFileSync(join(root, temporary), "replacement\n", {
								mode: 0o600,
								flag: "wx",
							});
						}
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(lstatSync(expected).nlink, 1);
		const [replacement] = publicationTemporaries(root);
		assert.equal(
			readFileSync(join(root, replacement), "utf8"),
			"replacement\n",
		);
		assert.equal(
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
			}),
			expected,
		);
		assert.equal(
			readFileSync(join(root, replacement), "utf8"),
			"replacement\n",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production publication refuses an unbounded recovery directory before mutation", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-dir-bound-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		let directoryReads = 0;
		let directoryClosed = false;
		assert.throws(
			() =>
				publishStagedProductionReceipt(stagedBinding(stage), {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					openPublicationDirectory: () => ({
						readSync() {
							directoryReads += 1;
							return { name: "entry" };
						},
						closeSync() {
							directoryClosed = true;
						},
					}),
				}),
			/publication directory is unbounded/,
		);
		assert.equal(directoryReads, 4_097);
		assert.equal(directoryClosed, true);
		assert.equal(existsSync(expected), false);
		assert.equal(publicationTemporaries(root).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a newer exact stage is not blocked by an older orphaned source", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-stale-source-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const oldStage = stageProductionReceipt(receipt, { receiptRoot: root });
		assert.throws(
			() =>
				publishStagedProductionReceipt(stagedBinding(oldStage), {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					linkFile() {
						throw new Error("injected pre-link crash");
					},
				}),
			/publication state is indeterminate/,
		);
		const oldTemporary = publicationTemporaries(root);
		assert.equal(oldTemporary.length, 1);

		const newerReceipt = {
			...receipt,
			verifiedAt: "2026-08-24T02:01:00.000Z",
		};
		const newStage = stageProductionReceipt(newerReceipt, {
			receiptRoot: root,
		});
		assert.equal(
			publishStagedProductionReceipt(stagedBinding(newStage), {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
			}),
			expected,
		);
		assert.deepEqual(JSON.parse(readFileSync(expected, "utf8")), newerReceipt);
		assert.deepEqual(publicationTemporaries(root), oldTemporary);
		assert.equal(lstatSync(join(root, oldTemporary[0])).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher rejects descriptor-bound canonical byte mismatch without deleting either link", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-byte-mismatch-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		let reads = 0;
		assert.throws(
			() =>
				publishStagedProductionReceipt(stagedBinding(stage), {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					readFile(descriptor) {
						reads += 1;
						const bytes = readFileSync(descriptor);
						if (reads > 2) bytes[0] ^= 1;
						return bytes;
					},
				}),
			/publication state is indeterminate/,
		);
		assert.ok(reads >= 4);
		assert.equal(lstatSync(expected).nlink, 2);
		assert.equal(lstatSync(stage).nlink, 1);
		const temporaries = publicationTemporaries(root);
		assert.equal(temporaries.length, 1);
		assert.equal(lstatSync(join(root, temporaries[0])).nlink, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("root swap preserves the anchored canonical and reports indeterminate", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-root-race-")),
	);
	const displacedRoot = `${root}.displaced`;
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					linkFile(source, target) {
						renameSync(root, displacedRoot);
						mkdirSync(root, { mode: 0o700 });
						linkSync(source, target);
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(existsSync(expected), false);
		const displacedCanonical = join(displacedRoot, basename(expected));
		const [temporary] = publicationTemporaries(displacedRoot);
		const canonicalStat = lstatSync(displacedCanonical);
		const temporaryStat = lstatSync(join(displacedRoot, temporary));
		assert.equal(canonicalStat.nlink, 2);
		assert.equal(temporaryStat.nlink, 2);
		assert.equal(canonicalStat.dev, temporaryStat.dev);
		assert.equal(canonicalStat.ino, temporaryStat.ino);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(displacedRoot, { recursive: true, force: true });
	}
});

test("post-commit directory close failure cannot downgrade a durable publication", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-close-after-commit-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		let closes = 0;
		assert.equal(
			publishStagedProductionReceipt(stagedBinding(stage), {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
				closeDirectory(descriptor) {
					closes += 1;
					closeSync(descriptor);
					throw new Error("injected close acknowledgement failure");
				},
			}),
			expected,
		);
		assert.equal(closes, 2);
		assert.equal(existsSync(expected), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("persistent sync failure preserves a non-authoritative canonical inode and reports indeterminate", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-indeterminate-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		let directorySyncs = 0;
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					fsyncDirectory(descriptor) {
						directorySyncs += 1;
						if (directorySyncs >= 2) {
							throw new Error("injected persistent sync failure");
						}
						fsyncSync(descriptor);
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(directorySyncs, 3);
		assert.equal(lstatSync(expected).nlink, 2);
		assert.equal(lstatSync(stage).nlink, 1);
		const temporaries = publicationTemporaries(root);
		assert.equal(temporaries.length, 1);
		assert.equal(lstatSync(join(root, temporaries[0])).nlink, 2);
		assert.equal(
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
			}),
			expected,
		);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.equal(publicationTemporaries(root).length, 0);
		assert.equal(lstatSync(stage).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an exhausted post-unlink sync failure is recovered by a fresh exact invocation", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-post-unlink-recovery-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		let directorySyncs = 0;
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					fsyncDirectory(descriptor) {
						directorySyncs += 1;
						if (directorySyncs >= 3) {
							throw new Error("injected exhausted post-unlink sync failure");
						}
						fsyncSync(descriptor);
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(directorySyncs, 4);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.equal(lstatSync(stage).nlink, 1);
		assert.equal(publicationTemporaries(root).length, 0);

		let recoveryFileSyncs = 0;
		assert.equal(
			publishStagedProductionReceipt(binding, {
				receiptRoot: root,
				repositoryRoot: ROOT,
				localInspector: () => localState(),
				fsyncFile(descriptor) {
					recoveryFileSyncs += 1;
					fsyncSync(descriptor);
				},
			}),
			expected,
		);
		assert.equal(recoveryFileSyncs, 1);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.equal(existsSync(stage), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh recovery refuses a pre-existing canonical with different bytes", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-recovery-mismatch-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		writeFileSync(expected, "{}\n", { mode: 0o600, flag: "wx" });
		assert.throws(
			() =>
				publishStagedProductionReceipt(stagedBinding(stage), {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
				}),
			(error) => {
				assert.doesNotMatch(
					error.message,
					/publication state is indeterminate/,
				);
				return /canonical bytes changed/.test(error.message);
			},
		);
		assert.equal(readFileSync(expected, "utf8"), "{}\n");
		assert.equal(lstatSync(expected).nlink, 1);
		assert.equal(lstatSync(stage).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh recovery refuses an exact canonical inode replacement after its durability sync", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "rc-production-recovery-race-")),
	);
	const receipt = productionReceipt();
	const expected = productionReceiptPath(receipt, root);
	try {
		const stage = stageProductionReceipt(receipt, { receiptRoot: root });
		const binding = stagedBinding(stage);
		publishStagedProductionReceipt(binding, {
			receiptRoot: root,
			repositoryRoot: ROOT,
			localInspector: () => localState(),
		});
		const exactBytes = readFileSync(expected);
		const replacement = join(root, ".replacement-production-receipt");
		assert.throws(
			() =>
				publishStagedProductionReceipt(binding, {
					receiptRoot: root,
					repositoryRoot: ROOT,
					localInspector: () => localState(),
					fsyncDirectory(descriptor) {
						fsyncSync(descriptor);
						writeFileSync(replacement, exactBytes, {
							mode: 0o600,
							flag: "wx",
						});
						renameSync(replacement, expected);
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(lstatSync(expected).nlink, 1);
		assert.deepEqual(readFileSync(expected), exactBytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("orchestrator rechecks inspection, local state, and main before writing", async () => {
	let inspectionReads = 0;
	let localReads = 0;
	let writes = 0;
	const order = [];
	const result = await verifyProductionRelease({
		input: proofInput(),
		inspectionReader: (_path, options) => {
			assert.equal(options.receiptRoot, RESULT_ROOT);
			inspectionReads += 1;
			order.push(`inspection-${inspectionReads}`);
			return inspectionBinding();
		},
		localInspector: ({ cwd }) => {
			assert.equal(cwd, ROOT);
			localReads += 1;
			order.push(`local-${localReads}`);
			return localState();
		},
		githubResolver: async () => githubResolution(),
		vercelResolver: async () => vercelResolution(),
		firewallAttester: async () => firewallAttestation(),
		runtimeAttester: async () => runtimeAttestation(),
		dataPlaneAttester: async () => dataPlaneAttestation(),
		mainRefResolver: async ({ expectedHead }) => {
			order.push("main-final");
			return expectedHead;
		},
		receiptStager: (_receipt, options) => {
			assert.equal(options.receiptRoot, RESULT_ROOT);
			writes += 1;
			order.push("write");
			return "/private/staged-production-receipt.json";
		},
		now: () => "2026-08-24T02:00:00.000Z",
		repositoryRoot: ROOT,
		receiptRoot: RESULT_ROOT,
	});
	assert.equal(inspectionReads, 2);
	assert.equal(localReads, 2);
	assert.equal(writes, 1);
	assert.equal(
		result.stagedReceiptFile,
		"/private/staged-production-receipt.json",
	);
	assert.equal(result.receipt.production.headSha, PRODUCTION);
	assert.equal(result.receipt.candidate.headSha, CANDIDATE);
	assert.deepEqual(order.slice(-3), ["local-2", "main-final", "write"]);
});

test("orchestrator refuses if main moves and never writes a receipt", async () => {
	let writes = 0;
	await assert.rejects(
		verifyProductionRelease({
			input: proofInput(),
			inspectionReader: () => inspectionBinding(),
			localInspector: () => localState(),
			githubResolver: async () => githubResolution(),
			vercelResolver: async () => vercelResolution(),
			firewallAttester: async () => firewallAttestation(),
			runtimeAttester: async () => runtimeAttestation(),
			dataPlaneAttester: async () => dataPlaneAttestation(),
			mainRefResolver: async () => {
				throw new Error("GitHub refs/heads/main moved");
			},
			receiptStager: () => {
				writes += 1;
			},
		}),
		/main moved/,
	);
	assert.equal(writes, 0);
});

test("orchestrator refuses inspection or local TOCTOU changes", async () => {
	for (const mode of ["inspection", "local"]) {
		let inspectionReads = 0;
		let localReads = 0;
		await assert.rejects(
			verifyProductionRelease({
				input: proofInput(),
				inspectionReader: () => {
					inspectionReads += 1;
					return inspectionBinding(
						mode === "inspection" && inspectionReads === 2
							? inspectionReceipt({
									topology: {
										...inspectionReceipt().topology,
										headSha: OTHER,
									},
								})
							: inspectionReceipt(),
					);
				},
				localInspector: () => {
					localReads += 1;
					return localState(
						mode === "local" && localReads === 2 ? { headSha: OTHER } : {},
					);
				},
				githubResolver: async () => githubResolution(),
				vercelResolver: async () => vercelResolution(),
				firewallAttester: async () => firewallAttestation(),
				runtimeAttester: async () => runtimeAttestation(),
				dataPlaneAttester: async () => dataPlaneAttestation(),
				mainRefResolver: async () => PRODUCTION,
				receiptStager: () => assert.fail("receipt must not be staged"),
			}),
			/changed/,
		);
	}
});

test("clean wrapper and verifier source have no secret-bearing argv or output paths", () => {
	const wrapper = readFileSync(CLEAN_WRAPPER, "utf8");
	const verifier = readFileSync(RUNNER, "utf8");
	for (const source of [wrapper, verifier]) {
		assert.doesNotMatch(source, /console\.log/);
		assert.doesNotMatch(source, /JSON\.stringify\(process\.env/);
	}
	assert.doesNotMatch(verifier, /process\.argv\[[2-9]/);
	assert.doesNotMatch(
		verifier,
		/process\.(?:stdout|stderr)\.write\([^)]*(GITHUB_TOKEN|VERCEL_TOKEN|VERCEL_AUTOMATION_BYPASS_SECRET)/s,
	);
	assert.equal(existsSync(CLEAN_WRAPPER), true);
});
