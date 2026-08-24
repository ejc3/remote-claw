import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	attestReleaseCleanProcessEnvironment,
	attestServedDeployment,
	buildPlaywrightEnvironment,
	cleanupPinnedHeadArtifact,
	createProofCoordinates,
	emitProofLogCanary,
	finalizeReceipt,
	matchesReleaseClaudeProcessArguments,
	preparePinnedHeadArtifact,
	preparePrivateReceiptDirectory,
	readProofBootstrapInput,
	replaceDurableReceiptFile,
	resolveManualTrustedDeployment,
	runTrustedRealTopology,
	validateBootstrapEnvironment,
	validateProofInput,
	validateReceiptDraft,
	validateRepositoryState,
	verifyHandoffEdgeRateLimit,
	writeDurableReceiptFile,
} from "./run-trusted-real-topology.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..");
const WEB_TEST_ROOT = resolve(REPOSITORY_ROOT, "tests/web");
const NODE_BIN = "/usr/bin/node";
const CLEAN_BOOTSTRAP = join(
	REPOSITORY_ROOT,
	"scripts/run-trusted-real-topology-clean.sh",
);
const TSX_CLI = realpathSync(
	join(WEB_TEST_ROOT, "node_modules/tsx/dist/cli.mjs"),
);
const PLAYWRIGHT_CLI = realpathSync(
	join(WEB_TEST_ROOT, "node_modules/@playwright/test/cli.js"),
);
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const DEPLOYMENT_URL =
	"https://remote-claw-6usc0ku3z-ejc3-7031s-projects.vercel.app";
const RUN_ID = "12345678-1234-4123-8123-123456789abc";
const WINDOW_STARTED_AT_MS = 1_700_000_000_000;
const WINDOW_COMPLETED_AT_MS = WINDOW_STARTED_AT_MS + 780_000;
const ARTIFACT_SHA = "b".repeat(64);
const CLAUDE_SHA =
	"a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177";
const pinnedReleaseHost =
	process.platform === "linux" && process.arch === "arm64";

test("receipt-root hardening refuses symlinks before chmod and secures the opened directory", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-receipt-root-"));
	const target = join(root, "target");
	const link = join(root, "link");
	const receiptRoot = join(root, "receipt");
	try {
		mkdirSync(target, { mode: 0o755 });
		symlinkSync(target, link);
		assert.throws(
			() => preparePrivateReceiptDirectory(link),
			/not an owned directory/,
		);
		assert.equal(statSync(target).mode & 0o777, 0o755);
		mkdirSync(receiptRoot, { mode: 0o755 });
		preparePrivateReceiptDirectory(receiptRoot);
		assert.equal(lstatSync(receiptRoot).mode & 0o777, 0o700);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("durable receipt writes sync the file and parent, and finalization syncs after rename", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-durable-receipt-"));
	const receiptFile = join(root, "receipt.json");
	const proof = { ...proofCoordinates(), receiptFile };
	const events = [];
	let finalRenamed = false;
	try {
		preparePrivateReceiptDirectory(root);
		writeDurableReceiptFile(
			receiptFile,
			`${JSON.stringify(receiptDraft(proof))}\n`,
			{
				syncFd(descriptor) {
					events.push(
						fstatSync(descriptor).isDirectory() ? "draft-parent" : "draft-file",
					);
					fsyncSync(descriptor);
				},
			},
		);
		finalizeReceipt(receiptFile, proof, WINDOW_COMPLETED_AT_MS, {
			replaceReceipt(path, contents) {
				events.push("write-final");
				replaceDurableReceiptFile(path, contents, {
					syncFd(descriptor) {
						events.push(
							fstatSync(descriptor).isDirectory()
								? finalRenamed
									? "final-parent-after-rename"
									: "final-parent-before-rename"
								: "final-file",
						);
						fsyncSync(descriptor);
					},
					renameFile(from, to) {
						events.push("rename");
						renameSync(from, to);
						finalRenamed = true;
					},
				});
			},
		});
		assert.deepEqual(events, [
			"draft-file",
			"draft-parent",
			"write-final",
			"final-file",
			"final-parent-before-rename",
			"rename",
			"final-parent-after-rename",
		]);
		assert.equal(existsSync(`${receiptFile}.final`), false);
		assert.equal(
			JSON.parse(readFileSync(receiptFile, "utf8")).browser.result,
			"passed",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function runtimeAttestation(sha = HEAD, storageOverrides = {}) {
	return {
		environment: "preview",
		sha,
		storage: {
			backend: "sqlite",
			locator: "turso",
			organization: "proof-org",
			group: "proof-group",
			scope: `pr-${sha.slice(0, 7)}`,
			...storageOverrides,
		},
	};
}

function edgeEvidence() {
	return {
		projectId: "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM",
		teamId: "team_fYexi4KRmIrq9wtYsiXs9e9H",
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
	};
}

function packedArtifact(overrides = {}) {
	return {
		scratchRoot: "/tmp/remote-claw-pinned-head-test",
		sourceRoot: "/tmp/remote-claw-pinned-head-test/source",
		tarballPath:
			"/tmp/remote-claw-pinned-head-test/artifact/remote-claw-0.0.0.tgz",
		sha256: ARTIFACT_SHA,
		...overrides,
	};
}

function proofCoordinates() {
	return createProofCoordinates({
		head: HEAD,
		deploymentId: "123",
		trusted: { sha: HEAD, url: DEPLOYMENT_URL },
		runtimeAttestation: runtimeAttestation(),
		packedArtifact: packedArtifact(),
		edgeRateLimit: edgeEvidence(),
		runId: RUN_ID,
		windowStartedAtMs: WINDOW_STARTED_AT_MS,
	});
}

function receiptDraft(proof, overrides = {}) {
	return {
		schema: "remote-claw-real-topology-browser-leg/v4",
		runId: proof.runId,
		headSha: proof.headSha,
		githubDeploymentId: proof.githubDeploymentId,
		trustedOrigin: proof.trustedOrigin,
		runtimeAttestation: proof.runtimeAttestation,
		inspectionStatus: "pending",
		logCanaries: proof.logCanaries,
		proofWindow: {
			startedAtMs: WINDOW_STARTED_AT_MS,
			completedAtMs: null,
		},
		packedTarballSha256: ARTIFACT_SHA,
		edgeRateLimit: edgeEvidence(),
		claude: {
			version: "2.1.237 (Claude Code)",
			platform: "linux",
			arch: "arm64",
			executableSha256: CLAUDE_SHA,
			binaryBytes: 331_864_296,
		},
		browser: {
			name: "chromium",
			version: "140.0.7339.16",
			project: "mobile-chromium",
			result: "assertions_passed",
		},
		streamRotation: {
			marker: "rotate",
			routeRotateMs: 240_000,
			observedElapsedMs: 240_125,
			browserObserved: true,
			browserReconnected: true,
			postRotationTurn: "assertions_passed",
		},
		plaintextScanNeedle: proof.plaintextScanNeedle,
		...overrides,
	};
}

function deployment(overrides = {}) {
	return {
		sha: HEAD,
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

function jsonResponse(body) {
	return {
		ok: true,
		status: 200,
		async json() {
			return body;
		},
	};
}

function githubFetch(
	candidateDeployment = deployment(),
	candidateStatuses = statuses(),
) {
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ url, options });
		return jsonResponse(
			calls.length === 1 ? candidateDeployment : candidateStatuses,
		);
	};
	return { calls, fetchImpl };
}

function proofInput(overrides = {}) {
	return {
		GITHUB_REPOSITORY: "ejc3/remote-claw",
		GITHUB_TOKEN: "test-github-token",
		RC_DEPLOYMENT_ID: "123",
		RC_PROVE_CLAUDE_CWD: "/tmp/real-claude-cwd",
		VERCEL_AUTOMATION_BYPASS_SECRET: "test-bypass",
		VERCEL_TOKEN: "test-vercel-token",
		HOME: "/tmp/test-home",
		...overrides,
	};
}

function bootstrapEnvironment(overrides = {}) {
	return {
		LANG: "C.UTF-8",
		PATH: "/usr/bin:/bin",
		RC_PROOF_INPUT_FD: "0",
		...overrides,
	};
}

function encodedProofInput(input = proofInput()) {
	return Buffer.concat(
		[
			"HOME",
			"GITHUB_REPOSITORY",
			"GITHUB_TOKEN",
			"RC_DEPLOYMENT_ID",
			"VERCEL_AUTOMATION_BYPASS_SECRET",
			"VERCEL_TOKEN",
			"RC_PROVE_CLAUDE_CWD",
		].map((field) => Buffer.from(`${input[field]}\0`, "utf8")),
	);
}

function bufferReader(contents) {
	let cursor = 0;
	return (_fd, destination, offset, length) => {
		const bytes = Math.min(length, contents.length - cursor);
		if (bytes === 0) return 0;
		contents.copy(destination, offset, cursor, cursor + bytes);
		cursor += bytes;
		return bytes;
	};
}

const FIFO_STAT = { isFIFO: () => true };

function attestedFetch(mock, order) {
	return async (url, options) => {
		if (url.startsWith("https://api.github.com/")) {
			order?.push("github");
			assert.equal(options.headers["x-vercel-protection-bypass"], undefined);
			return mock.fetchImpl(url, options);
		}
		order?.push("attestation");
		assert.equal(url, `${DEPLOYMENT_URL}/api/prove/deployment-attestation`);
		assert.equal(options.redirect, "error");
		assert.equal(options.headers["x-vercel-protection-bypass"], "test-bypass");
		return new Response(JSON.stringify(runtimeAttestation()), {
			status: 200,
			headers: { "cache-control": "private, no-store" },
		});
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
			ownerId: "team_fYexi4KRmIrq9wtYsiXs9e9H",
			updatedAt: "2026-08-23T00:00:00.000Z",
			id: "waf_TG8xDULMuMuR",
			ips: [],
			projectKey: "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM#active",
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

test("repository state requires a clean full committed HEAD", () => {
	assert.equal(validateRepositoryState(`${HEAD}\n`, ""), HEAD);
	assert.throws(
		() => validateRepositoryState(`${HEAD}\n`, " M tracked-file\n"),
		/clean worktree/,
	);
	assert.throws(() => validateRepositoryState("HEAD\n", ""), /full commit/);
});

test("manual resolver requires the deployment SHA to equal local HEAD", async () => {
	const mock = githubFetch(deployment({ sha: OTHER_HEAD }));
	await assert.rejects(
		resolveManualTrustedDeployment({
			deploymentId: "123",
			repository: "ejc3/remote-claw",
			token: "test-github-token",
			head: HEAD,
			fetchImpl: mock.fetchImpl,
		}),
		/equal the current local HEAD/,
	);
});

test("manual resolver reuses the exact immutable Vercel coordinate validation", async () => {
	const hostile = githubFetch(
		deployment(),
		statuses({
			environment_url:
				"https://remote-claw-git-main-ejc3-7031s-projects.vercel.app",
		}),
	);
	await assert.rejects(
		resolveManualTrustedDeployment({
			deploymentId: "123",
			repository: "ejc3/remote-claw",
			token: "test-github-token",
			head: HEAD,
			fetchImpl: hostile.fetchImpl,
		}),
		/immutable pinned Vercel deployment origin/,
	);
});

test("proof log canary sends only the bounded nonsecret marker to the pinned Preview", async () => {
	const calls = [];
	await emitProofLogCanary({
		origin: DEPLOYMENT_URL,
		bypass: "test-bypass",
		canary: "RC_RELEASE_PROOF_LOG_BEGIN_12345678123441238123123456789abc",
		async fetchImpl(url, options) {
			calls.push({ url, options });
			return new Response(JSON.stringify({ accepted: true }), {
				status: 200,
				headers: { "cache-control": "private, no-store" },
			});
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${DEPLOYMENT_URL}/api/prove/log-canary`);
	assert.equal(calls[0].options.method, "POST");
	assert.equal(
		JSON.parse(calls[0].options.body).canary,
		"RC_RELEASE_PROOF_LOG_BEGIN_12345678123441238123123456789abc",
	);
	assert.equal(
		calls[0].options.headers["x-vercel-protection-bypass"],
		"test-bypass",
	);
	await assert.rejects(
		emitProofLogCanary({
			origin: "https://attacker.example",
			bypass: "test-bypass",
			canary: "RC_RELEASE_PROOF_LOG_BEGIN_12345678123441238123123456789abc",
			fetchImpl: async () => new Response(),
		}),
		/immutable pinned Vercel deployment origin/,
	);
});

test("WAF preflight binds the exact live handoff rule and empty bypass list", async () => {
	const calls = [];
	const evidence = await verifyHandoffEdgeRateLimit({
		token: "test-vercel-token",
		async fetchImpl(url, options) {
			calls.push({ url, options });
			const body = url.includes("/config?")
				? wafConfigFixture()
				: { result: [] };
			return new Response(JSON.stringify(body), { status: 200 });
		},
	});
	assert.deepEqual(evidence, edgeEvidence());
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.match(
			call.url,
			/^https:\/\/api\.vercel\.com\/v1\/security\/firewall\//,
		);
		assert.match(call.url, /projectId=prj_qUeYYc7P87JmsQUipJG0m0kqmYbM/);
		assert.match(call.url, /teamId=team_fYexi4KRmIrq9wtYsiXs9e9H/);
		assert.equal(call.options.redirect, "error");
		assert.equal(
			call.options.headers.authorization,
			"Bearer test-vercel-token",
		);
	}
});

test("WAF preflight fails closed on policy drift, drafts, or bypass entries", async () => {
	for (const mutate of [
		(config, _bypass) => {
			config.active.rules[0].action.mitigate.rateLimit.limit = 21;
		},
		(config, _bypass) => {
			config.draft = {};
		},
		(config, _bypass) => {
			config.active.ownerId = "team_wrong";
		},
		(config, _bypass) => {
			config.active.projectKey = "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM";
		},
		(config, _bypass) => {
			config.active.updatedAt = "2026-08-23T00:00:00Z";
		},
		(config, _bypass) => {
			config.active.ips.push({ hostname: "unexpected" });
		},
		(config, _bypass) => {
			config.active.changes.push({ operation: "unexpected" });
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
			config.active.unexpected = true;
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
			verifyHandoffEdgeRateLimit({
				token: "test-vercel-token",
				async fetchImpl() {
					request += 1;
					return new Response(JSON.stringify(request === 1 ? config : bypass), {
						status: 200,
					});
				},
			}),
			/not the pinned live policy/,
		);
	}
});

test("WAF preflight errors never reproduce response bodies or credentials", async () => {
	await assert.rejects(
		verifyHandoffEdgeRateLimit({
			token: "SECRET_SENTINEL",
			async fetchImpl() {
				return new Response("RAW_SECRET_SENTINEL", { status: 503 });
			},
		}),
		(error) => {
			assert.doesNotMatch(error.message, /SECRET_SENTINEL/);
			assert.doesNotMatch(error.message, /RAW_SECRET_SENTINEL/);
			return true;
		},
	);
});

test("pinned artifact is archived from the validated HEAD and built only in scratch", () => {
	const calls = [];
	let scratchRoot;
	const artifact = preparePinnedHeadArtifact({
		head: HEAD,
		cwd: REPOSITORY_ROOT,
		makeScratch(prefix) {
			scratchRoot = mkdtempSync(prefix);
			return scratchRoot;
		},
		execFile(file, args, options) {
			calls.push({ file, args, options });
			if (args.includes("pack")) {
				const artifactRoot = args[args.indexOf("--pack-destination") + 1];
				writeFileSync(
					join(artifactRoot, "remote-claw-0.0.0.tgz"),
					"pinned archive",
				);
				return JSON.stringify([{ filename: "remote-claw-0.0.0.tgz" }]);
			}
			return "";
		},
	});
	try {
		const archive = calls.find((call) => call.args[0] === "archive");
		assert.ok(archive);
		assert.equal(archive.file, realpathSync("/usr/bin/git"));
		assert.equal(archive.args.at(-1), HEAD);
		assert.equal(archive.options.cwd, REPOSITORY_ROOT);
		const install = calls.find((call) => call.args.includes("install"));
		const build = calls.find((call) => call.args.includes("build:cli"));
		const pack = calls.find((call) => call.args.includes("pack"));
		assert.ok(install?.args.includes("--frozen-lockfile"));
		assert.equal(build.options.cwd, join(scratchRoot, "source"));
		assert.equal(pack.options.cwd, join(scratchRoot, "source"));
		assert.equal(
			calls.some(
				(call) =>
					(call.args.includes("build:cli") || call.args.includes("pack")) &&
					call.options.cwd === REPOSITORY_ROOT,
			),
			false,
		);
		for (const call of calls) {
			assert.equal(call.options.env.NODE_OPTIONS, undefined);
			assert.equal(call.options.env.npm_config_userconfig, undefined);
		}
		assert.equal(artifact.scratchRoot, scratchRoot);
		assert.equal(lstatSync(artifact.tarballPath).mode & 0o777, 0o400);
		assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
	} finally {
		cleanupPinnedHeadArtifact(artifact);
	}
	assert.equal(existsSync(scratchRoot), false);
});

test("runner validates every binding before launch and forwards a minimal environment", async () => {
	const mock = githubFetch();
	const order = [];
	let childEnv;
	let nowCalls = 0;
	await runTrustedRealTopology({
		input: proofInput(),
		repositoryState() {
			order.push("repository");
			return { headOutput: `${HEAD}\n`, statusOutput: "" };
		},
		fetchImpl: attestedFetch(mock, order),
		async edgePreflight({ token }) {
			order.push("waf");
			assert.equal(token, "test-vercel-token");
			return edgeEvidence();
		},
		artifactBuilder({ head }) {
			order.push("artifact");
			assert.equal(head, HEAD);
			return packedArtifact();
		},
		artifactCleanup() {
			order.push("cleanup");
		},
		playwright({ env, proof, packedArtifact: archivedArtifact }) {
			order.push("playwright");
			childEnv = env;
			assert.equal(proof.packedTarballSha256, ARTIFACT_SHA);
			assert.equal(archivedArtifact.sourceRoot, packedArtifact().sourceRoot);
		},
		canaryEmitter({ origin, bypass, canary }) {
			order.push(canary.includes("BEGIN") ? "canary-begin" : "canary-end");
			assert.equal(origin, DEPLOYMENT_URL);
			assert.equal(bypass, "test-bypass");
		},
		receiptFinalizer(receiptFile, proof, completedAtMs) {
			order.push("finalize");
			assert.equal(receiptFile, proof.receiptFile);
			assert.equal(completedAtMs, WINDOW_COMPLETED_AT_MS);
			return { result: "passed" };
		},
		newRunId: () => RUN_ID,
		now() {
			nowCalls += 1;
			return nowCalls === 1 ? WINDOW_STARTED_AT_MS : WINDOW_COMPLETED_AT_MS;
		},
	});
	assert.deepEqual(order, [
		"repository",
		"github",
		"github",
		"repository",
		"attestation",
		"repository",
		"waf",
		"artifact",
		"repository",
		"canary-begin",
		"playwright",
		"canary-end",
		"finalize",
		"cleanup",
	]);
	assert.equal(childEnv.WEB_E2E_URL, DEPLOYMENT_URL);
	assert.equal(childEnv.PATH, "/usr/bin:/bin");
	assert.equal(childEnv.GITHUB_TOKEN, undefined);
	assert.equal(childEnv.GH_TOKEN, undefined);
	assert.equal(childEnv.RC_DEPLOYMENT_ID, undefined);
	assert.equal(childEnv.VERCEL_TOKEN, undefined);
	assert.equal(childEnv.TURSO_API_TOKEN, undefined);
	assert.equal(childEnv.TURSO_GROUP_AUTH_TOKEN, undefined);
	assert.equal(childEnv.TURSO_AUTH_TOKEN, undefined);
	assert.equal(childEnv.TURSO_DATABASE_URL, undefined);
	assert.equal(childEnv.CRON_SECRET, undefined);
	assert.equal(childEnv.RC_PROOF_PACKED_TARBALL_SHA256, ARTIFACT_SHA);
	assert.equal(childEnv.RC_PROOF_OPERATOR_REPOSITORY_ROOT, REPOSITORY_ROOT);
	assert.equal(childEnv.RC_PROOF_WAF_CONFIG_ID, "waf_TG8xDULMuMuR");
	assert.equal(childEnv.RC_PROOF_HEAD_SHA, HEAD);
	assert.equal(childEnv.RC_PROOF_ATTESTED_STORAGE_BACKEND, "sqlite");
	assert.equal(childEnv.RC_PROOF_ATTESTED_STORAGE_LOCATOR, "turso");
	assert.equal(childEnv.RC_PROOF_ATTESTED_TURSO_ORGANIZATION, "proof-org");
	assert.equal(childEnv.RC_PROOF_ATTESTED_TURSO_GROUP, "proof-group");
	assert.equal(childEnv.RC_PROOF_ATTESTED_TURSO_SCOPE, "pr-aaaaaaa");
	assert.deepEqual(
		childEnv.RC_PROOF_PLAINTEXT_SCAN_NEEDLE,
		"RC_PLAINTEXT_SCAN_12345678123441238123123456789abc",
	);
	assert.equal(
		childEnv.RC_PROOF_LOG_CANARY_BEGIN,
		"RC_RELEASE_PROOF_LOG_BEGIN_12345678123441238123123456789abc",
	);
	assert.equal(childEnv.RC_PROOF_WINDOW_STARTED_AT_MS, "1700000000000");
});

test("private proof input rejects every extra field before repository or network work", async () => {
	let repositoryReads = 0;
	await assert.rejects(
		runTrustedRealTopology({
			input: proofInput({ RC_CLAUDE_BIN: "/tmp/fake-exact-version-claude" }),
			repositoryState() {
				repositoryReads += 1;
				return { headOutput: `${HEAD}\n`, statusOutput: "" };
			},
		}),
		/unexpected fields/,
	);
	assert.equal(repositoryReads, 0);
	assert.doesNotThrow(() => validateProofInput(proofInput()));
});

test("bootstrap validates its exact three-key environment before reading fd0", () => {
	assert.doesNotThrow(() =>
		validateBootstrapEnvironment(bootstrapEnvironment()),
	);
	for (const environment of [
		bootstrapEnvironment({ NODE_OPTIONS: "--require=/tmp/fake.cjs" }),
		bootstrapEnvironment({ RC_CLAUDE_BIN: "/tmp/fake" }),
		{ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
	]) {
		let reads = 0;
		assert.throws(
			() =>
				readProofBootstrapInput({
					environment,
					read() {
						reads += 1;
						return 0;
					},
					statFd: () => FIFO_STAT,
				}),
			/bootstrap environment/,
		);
		assert.equal(reads, 0);
	}
});

test("bootstrap bounded-reads exactly seven NUL-delimited private fields", () => {
	const encoded = encodedProofInput();
	assert.deepEqual(
		readProofBootstrapInput({
			environment: bootstrapEnvironment(),
			read: bufferReader(encoded),
			statFd: () => FIFO_STAT,
		}),
		proofInput(),
	);
	for (const malformed of [
		encoded.subarray(0, encoded.length - 1),
		Buffer.concat([encoded, Buffer.from("extra\0")]),
		Buffer.alloc(64 * 1_024 + 1, 0x61),
	]) {
		assert.throws(
			() =>
				readProofBootstrapInput({
					environment: bootstrapEnvironment(),
					read: bufferReader(malformed),
					statFd: () => FIFO_STAT,
				}),
			/(incomplete|field count|oversized)/,
		);
	}
	assert.throws(
		() =>
			readProofBootstrapInput({
				environment: bootstrapEnvironment(),
				read: bufferReader(encoded),
				statFd: () => ({ isFIFO: () => false }),
			}),
		/not a pipe/,
	);
});

test("direct system-Node entrypoint refuses before reading bootstrap input", () => {
	assert.throws(
		() =>
			execFileSync(
				NODE_BIN,
				[join(REPOSITORY_ROOT, "scripts/run-trusted-real-topology.mjs")],
				{
					cwd: REPOSITORY_ROOT,
					env: { PATH: "/usr/bin:/bin" },
					encoding: "utf8",
					stdio: "pipe",
				},
			),
		(error) => {
			const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
			assert.match(output, /bootstrap environment/);
			assert.doesNotMatch(
				output,
				/bootstrap input (?:could not be read|is incomplete)/,
			);
			return true;
		},
	);
});

test("static BusyBox bootstrap strips hostile loader, Node, shell, and npm state", (context) => {
	if (!pinnedReleaseHost) {
		context.skip("requires the pinned Linux/arm64 release host");
		return;
	}
	const scratch = mkdtempSync(join(tmpdir(), "remote-claw-bootstrap-test-"));
	const nodeMarker = join(scratch, "node-marker");
	const loaderMarker = join(scratch, "loader-marker");
	const shellMarker = join(scratch, "shell-marker");
	const nodeHook = join(scratch, "self-delete.cjs");
	const shellHook = join(scratch, "hostile-shell-env");
	const preloadSource = join(scratch, "hostile-preload.c");
	const preloadLibrary = join(scratch, "SECRET_LD_PRELOAD_SENTINEL.so");
	try {
		writeFileSync(
			nodeHook,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(nodeMarker)},"ran");fs.unlinkSync(__filename);\n`,
		);
		writeFileSync(shellHook, `printf ran > ${JSON.stringify(shellMarker)}\n`);
		writeFileSync(
			preloadSource,
			`#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void injected(void){int fd=open(${JSON.stringify(loaderMarker)},O_WRONLY|O_CREAT,0600);if(fd>=0){write(fd,"ran",3);close(fd);}}\n`,
		);
		execFileSync(
			"/usr/bin/cc",
			["-shared", "-fPIC", "-o", preloadLibrary, preloadSource],
			{
				stdio: "ignore",
			},
		);
		const result = spawnSync(CLEAN_BOOTSTRAP, [], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				...proofInput({ GITHUB_REPOSITORY: "invalid" }),
				BASH_ENV: shellHook,
				ENV: shellHook,
				INIT_CWD: "/tmp/hostile-init-cwd",
				LD_PRELOAD: preloadLibrary,
				NODE_OPTIONS: `--require=${nodeHook}`,
				NODE_PATH: "/tmp/hostile-node-path",
				RC_CLAUDE_BIN: "/tmp/fake-exact-version-claude",
				npm_config_node_options: `--require=${nodeHook}`,
				npm_config_script_shell: "/tmp/hostile-shell",
				npm_config_userconfig: "/tmp/hostile-npmrc",
			},
			maxBuffer: 64 * 1_024,
			timeout: 10_000,
		});
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		assert.equal(result.status, 1);
		assert.match(output, /real-topology proof refused/);
		assert.doesNotMatch(output, /bootstrap environment/);
		assert.match(output, /(?:clean worktree|GITHUB_REPOSITORY is invalid)/);
		assert.doesNotMatch(output, /SECRET_LD_PRELOAD_SENTINEL/);
		assert.doesNotMatch(output, /test-(?:github|vercel|bypass)-token/);
		assert.equal(existsSync(nodeMarker), false);
		assert.equal(existsSync(loaderMarker), false);
		assert.equal(existsSync(shellMarker), false);
		assert.equal(existsSync(nodeHook), true);
		assert.equal(statSync(CLEAN_BOOTSTRAP).mode & 0o777, 0o755);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("real Claude descendant environment attestation is bounded and value-blind", () => {
	const forbiddenKeys = [
		"CLAUDE_CODE_CHILD_SESSION",
		"CLAUDE_CODE_SESSION_ID",
		"CRON_SECRET",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"NODE_OPTIONS",
		"REMOTE_CLAW_SECRET_FILE",
		"TURSO_API_TOKEN",
		"TURSO_AUTH_TOKEN",
		"TURSO_DATABASE_URL",
		"TURSO_GROUP_AUTH_TOKEN",
		"VERCEL_AUTOMATION_BYPASS_SECRET",
		"VERCEL_TOKEN",
	];
	const attest = (payload) => {
		let sourceOffset = 0;
		let attestationBuffer;
		let closed = false;
		let thrown;
		try {
			attestReleaseCleanProcessEnvironment(4321, {
				openFile(path, flags) {
					assert.equal(path, "/proc/4321/environ");
					assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW);
					return 99;
				},
				readFromFd(fd, buffer, offset, length) {
					assert.equal(fd, 99);
					attestationBuffer = buffer;
					const copied = Math.min(length, payload.length - sourceOffset);
					if (copied === 0) return 0;
					payload.copy(buffer, offset, sourceOffset, sourceOffset + copied);
					sourceOffset += copied;
					return copied;
				},
				closeFile(fd) {
					assert.equal(fd, 99);
					closed = true;
				},
			});
		} catch (error) {
			thrown = error;
		}
		assert.equal(closed, true);
		assert.ok(attestationBuffer);
		assert.equal(
			attestationBuffer.every((byte) => byte === 0),
			true,
		);
		return thrown;
	};
	assert.equal(
		attest(Buffer.from("HOME=/tmp/proof\0PATH=/usr/bin:/bin\0")),
		undefined,
	);
	for (const key of forbiddenKeys) {
		const error = attest(
			Buffer.from(`HOME=/tmp/proof\0${key}=SECRET_VALUE_SENTINEL\0`),
		);
		assert.match(error.message, /not release-clean/);
		assert.doesNotMatch(error.message, /SECRET_VALUE_SENTINEL/);
		assert.doesNotMatch(error.message, new RegExp(key));
	}
	const oversized = attest(Buffer.alloc(64 * 1_024 + 1, 0x61));
	assert.match(oversized.message, /not release-clean/);
});

test("real Claude descendant selection ignores probes and matches only the exact release payload", () => {
	const releaseArguments = [
		"--safe-mode",
		"--tools",
		"",
		"--remote-control",
		"remote-claw-release-proof",
	];
	const matches = (payload, { closeFails = false } = {}) => {
		let sourceOffset = 0;
		let selectionBuffer;
		let closed = false;
		const result = matchesReleaseClaudeProcessArguments(
			4321,
			releaseArguments,
			{
				openFile(path, flags) {
					assert.equal(path, "/proc/4321/cmdline");
					assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW);
					return 99;
				},
				readFromFd(fd, buffer, offset, length) {
					assert.equal(fd, 99);
					selectionBuffer = buffer;
					const copied = Math.min(length, payload.length - sourceOffset);
					if (copied === 0) return 0;
					payload.copy(buffer, offset, sourceOffset, sourceOffset + copied);
					sourceOffset += copied;
					return copied;
				},
				closeFile(fd) {
					assert.equal(fd, 99);
					closed = true;
					if (closeFails) throw new Error("close failed");
				},
			},
		);
		assert.equal(closed, true);
		assert.ok(selectionBuffer);
		assert.equal(
			selectionBuffer.every((byte) => byte === 0),
			true,
		);
		return result;
	};
	const payload = (arguments_) =>
		Buffer.from(`/proc/9876/fd/19\0${arguments_.join("\0")}\0`);
	assert.equal(matches(payload(releaseArguments)), true);
	assert.equal(matches(payload(["--version"])), false);
	assert.equal(matches(payload(releaseArguments.slice(0, -1))), false);
	assert.equal(matches(payload([...releaseArguments, "extra"])), false);
	assert.equal(
		matches(
			payload([
				releaseArguments[1],
				releaseArguments[0],
				...releaseArguments.slice(2),
			]),
		),
		false,
	);
	assert.equal(matches(Buffer.from("\0--safe-mode\0")), false);
	assert.equal(matches(Buffer.from("claude\0--safe-mode")), false);
	assert.equal(matches(Buffer.alloc(4 * 1_024 + 1, 0x61)), false);
	assert.equal(matches(payload(releaseArguments), { closeFails: true }), false);
	assert.equal(
		matchesReleaseClaudeProcessArguments(0, releaseArguments),
		false,
	);
	assert.equal(matchesReleaseClaudeProcessArguments(4321, []), false);
});

test("package scripts cannot masquerade as the trusted real-topology entrypoint", () => {
	const packageJson = JSON.parse(
		readFileSync(join(WEB_TEST_ROOT, "package.json"), "utf8"),
	);
	assert.equal(packageJson.scripts?.["prove:real-topology"], undefined);
});

test("dirty or mismatched candidates never build or launch", async () => {
	let builds = 0;
	let launches = 0;
	let fetches = 0;
	const common = {
		input: proofInput(),
		artifactBuilder() {
			builds += 1;
			return packedArtifact();
		},
		playwright() {
			launches += 1;
		},
	};
	await assert.rejects(
		runTrustedRealTopology({
			...common,
			repositoryState: () => ({
				headOutput: `${HEAD}\n`,
				statusOutput: "?? uncommitted\n",
			}),
			async fetchImpl() {
				fetches += 1;
				return jsonResponse({});
			},
		}),
		/clean worktree/,
	);
	const mismatched = githubFetch(deployment({ sha: OTHER_HEAD }));
	await assert.rejects(
		runTrustedRealTopology({
			...common,
			repositoryState: () => ({ headOutput: `${HEAD}\n`, statusOutput: "" }),
			fetchImpl: mismatched.fetchImpl,
		}),
		/equal the current local HEAD/,
	);
	assert.equal(fetches, 0);
	assert.equal(builds, 0);
	assert.equal(launches, 0);
});

test("repository mutation during artifact build cannot finalize a mismatched receipt", async () => {
	const mock = githubFetch();
	let stateRead = 0;
	let cleanups = 0;
	let launches = 0;
	await assert.rejects(
		runTrustedRealTopology({
			input: proofInput(),
			repositoryState() {
				stateRead += 1;
				return {
					headOutput: `${stateRead === 4 ? OTHER_HEAD : HEAD}\n`,
					statusOutput: "",
				};
			},
			fetchImpl: attestedFetch(mock),
			edgePreflight: async () => edgeEvidence(),
			artifactBuilder: () => packedArtifact(),
			artifactCleanup() {
				cleanups += 1;
			},
			playwright() {
				launches += 1;
			},
		}),
		/changed while building the pinned-HEAD CLI artifact/,
	);
	assert.equal(cleanups, 1);
	assert.equal(launches, 0);
});

test("wrong served SHA refuses before WAF, artifact build, or Playwright", async () => {
	const mock = githubFetch();
	let downstream = 0;
	await assert.rejects(
		runTrustedRealTopology({
			input: proofInput(),
			repositoryState: () => ({ headOutput: `${HEAD}\n`, statusOutput: "" }),
			async fetchImpl(url, options) {
				if (url.startsWith("https://api.github.com/"))
					return mock.fetchImpl(url, options);
				return new Response(JSON.stringify(runtimeAttestation(OTHER_HEAD)), {
					status: 200,
					headers: { "cache-control": "no-store" },
				});
			},
			edgePreflight() {
				downstream += 1;
			},
			artifactBuilder() {
				downstream += 1;
			},
			playwright() {
				downstream += 1;
			},
		}),
		/served deployment SHA\/environment does not match/,
	);
	assert.equal(downstream, 0);
});

test("attestation never sends the bypass to an untrusted origin", async () => {
	let requests = 0;
	await assert.rejects(
		attestServedDeployment({
			origin: "https://attacker.example",
			expectedSha: HEAD,
			bypass: "test-bypass",
			async fetchImpl() {
				requests += 1;
				return new Response();
			},
		}),
		/immutable pinned Vercel deployment origin/,
	);
	assert.equal(requests, 0);
});

test("attestation refuses a cacheable response", async () => {
	await assert.rejects(
		attestServedDeployment({
			origin: DEPLOYMENT_URL,
			expectedSha: HEAD,
			bypass: "test-bypass",
			async fetchImpl() {
				return new Response(JSON.stringify(runtimeAttestation()), {
					status: 200,
				});
			},
		}),
		/response is cacheable/,
	);
});

test("attestation refuses a noncanonical or extensible storage profile", async () => {
	for (const body of [
		runtimeAttestation(HEAD, { scope: "prod" }),
		{
			...runtimeAttestation(),
			storage: { ...runtimeAttestation().storage, token: "must-not-appear" },
		},
	]) {
		await assert.rejects(
			attestServedDeployment({
				origin: DEPLOYMENT_URL,
				expectedSha: HEAD,
				bypass: "test-bypass",
				async fetchImpl() {
					return new Response(JSON.stringify(body), {
						status: 200,
						headers: { "cache-control": "no-store" },
					});
				},
			}),
			/storage profile|unexpected fields/,
		);
	}
});

function configEnvironment(overrides = {}) {
	return {
		HOME: "/tmp/test-home",
		PATH: "/usr/bin:/bin",
		WEB_E2E_URL: DEPLOYMENT_URL,
		VERCEL_AUTOMATION_BYPASS_SECRET: "test-bypass",
		...overrides,
	};
}

test("Playwright config rejects empty release inputs and inherited Claude overrides", () => {
	for (const [name, value, pattern] of [
		["WEB_E2E_URL", "", /WEB_E2E_URL is required/],
		[
			"VERCEL_AUTOMATION_BYPASS_SECRET",
			" \t",
			/VERCEL_AUTOMATION_BYPASS_SECRET is required/,
		],
		["RC_CLAUDE_BIN", "/tmp/fake", /refuses inherited RC_CLAUDE_BIN/],
	]) {
		assert.throws(
			() =>
				execFileSync(NODE_BIN, [TSX_CLI, "real-topology.prove.config.ts"], {
					cwd: WEB_TEST_ROOT,
					env: configEnvironment({ [name]: value }),
					encoding: "utf8",
					stdio: "pipe",
				}),
			(error) => {
				assert.match(error.stderr ?? "", pattern);
				return true;
			},
		);
	}
});

test("Playwright config accepts the runner's minimal environment", () => {
	assert.doesNotThrow(() =>
		execFileSync(NODE_BIN, [TSX_CLI, "real-topology.prove.config.ts"], {
			cwd: WEB_TEST_ROOT,
			env: configEnvironment(),
			stdio: "pipe",
		}),
	);
});

test("direct Playwright invocation refuses to run without wrapper coordinates", () => {
	assert.throws(
		() =>
			execFileSync(
				NODE_BIN,
				[
					PLAYWRIGHT_CLI,
					"test",
					"--list",
					"-c",
					"real-topology.prove.config.ts",
				],
				{
					cwd: WEB_TEST_ROOT,
					env: configEnvironment(),
					encoding: "utf8",
					stdio: "pipe",
				},
			),
		(error) => {
			assert.match(
				`${error.stdout ?? ""}${error.stderr ?? ""}`,
				/RC_PROOF_RUN_ID/,
			);
			return true;
		},
	);
});

test("Playwright environment is an allowlist and rejects a whitespace-only bypass", () => {
	const proof = proofCoordinates();
	const env = buildPlaywrightEnvironment(
		{
			...proofInput(),
			NODE_OPTIONS: "--require=/tmp/fake.cjs",
			NODE_PATH: "/tmp/fake-modules",
			VERCEL_TOKEN: "test-vercel-token",
			TURSO_API_TOKEN: "test-turso-token",
		},
		{ url: DEPLOYMENT_URL },
		proof,
	);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.NODE_PATH, undefined);
	assert.equal(env.VERCEL_TOKEN, undefined);
	assert.equal(env.TURSO_API_TOKEN, undefined);
	assert.equal(env.RC_CLAUDE_BIN, undefined);
	assert.equal(env.RC_PROOF_PACKED_TARBALL_PATH, proof.packedTarballPath);
	assert.equal(env.RC_PROOF_ATTESTED_TURSO_SCOPE, "pr-aaaaaaa");
	assert.throws(
		() =>
			buildPlaywrightEnvironment(
				{ ...proofInput(), VERCEL_AUTOMATION_BYPASS_SECRET: " \t" },
				{ url: DEPLOYMENT_URL },
				proof,
			),
		/VERCEL_AUTOMATION_BYPASS_SECRET is required/,
	);
});

test("receipt schema binds artifact, Claude bytes, edge policy, and no secret fields", () => {
	const proof = proofCoordinates();
	assert.equal(validateReceiptDraft(receiptDraft(proof), proof).runId, RUN_ID);
	assert.throws(
		() =>
			validateReceiptDraft(
				receiptDraft(proof, { transcript: "must never be retained" }),
				proof,
			),
		/unexpected fields/,
	);
	assert.throws(
		() =>
			validateReceiptDraft(
				receiptDraft(proof, { packedTarballSha256: "c".repeat(64) }),
				proof,
			),
		/coordinates are invalid/,
	);
	assert.throws(
		() =>
			validateReceiptDraft(
				receiptDraft(proof, {
					claude: {
						...receiptDraft(proof).claude,
						executableSha256: "c".repeat(64),
					},
				}),
				proof,
			),
		/Claude tuple is not pinned/,
	);
	assert.throws(
		() =>
			validateReceiptDraft(
				receiptDraft(proof, {
					edgeRateLimit: { ...edgeEvidence(), limit: 21 },
				}),
				proof,
			),
		/edge-rate-limit evidence is not pinned/,
	);
	assert.throws(
		() =>
			validateReceiptDraft(
				receiptDraft(proof, {
					runtimeAttestation: runtimeAttestation(HEAD, {
						group: "other-group",
					}),
				}),
				proof,
			),
		/runtime attestation is invalid/,
	);
	assert.throws(
		() =>
			validateReceiptDraft(
				receiptDraft(proof, {
					streamRotation: {
						...receiptDraft(proof).streamRotation,
						browserReconnected: false,
					},
				}),
				proof,
			),
		/stream rotation is invalid/,
	);
});

test("runner finalizes the browser result while inspection remains pending", () => {
	const proofRoot = mkdtempSync(join(tmpdir(), "remote-claw-receipt-test-"));
	const receiptFile = join(proofRoot, "receipt.json");
	const proof = { ...proofCoordinates(), receiptFile };
	try {
		writeFileSync(receiptFile, `${JSON.stringify(receiptDraft(proof))}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		const finalReceipt = finalizeReceipt(
			receiptFile,
			proof,
			WINDOW_COMPLETED_AT_MS,
		);
		assert.equal(finalReceipt.browser.result, "passed");
		const retained = JSON.parse(readFileSync(receiptFile, "utf8"));
		assert.equal(retained.browser.result, "passed");
		assert.equal(retained.packedTarballSha256, ARTIFACT_SHA);
		assert.equal(retained.claude.executableSha256, CLAUDE_SHA);
		assert.equal(
			retained.edgeRateLimit.ruleId,
			"rule_handoff_per_ip_rate_limit_UWaS5F",
		);
		assert.equal(retained.inspectionStatus, "pending");
		assert.deepEqual(retained.proofWindow, {
			startedAtMs: WINDOW_STARTED_AT_MS,
			completedAtMs: WINDOW_COMPLETED_AT_MS,
		});
	} finally {
		rmSync(proofRoot, { recursive: true, force: true });
	}
});
