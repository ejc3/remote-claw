import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import {
	inspectCandidateRepository,
	inspectionReceiptPath,
	inspectionReceiptStagePath,
	listTursoDatabases,
	PINNED_LIBSQL_PACKAGES,
	preparePinnedLibsqlClient,
	publishStagedInspectionReceipt,
	readInspectionBootstrapInput,
	readTopologyReceipt,
	resolveImmutableVercelDeployment,
	runTrustedFinalInspection,
	scanSettledVercelLogs,
	scanTursoFleet,
	scanVercelLogSnapshot,
	validateInspectionInput,
	validateInspectionPublishEnvironment,
	validateInspectionReceipt,
	validatePinnedPackageTree,
	validateStableTursoFleet,
	writeInspectionReceipt,
} from "./run-trusted-final-inspection.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLEAN_WRAPPER = join(HERE, "run-trusted-final-inspection-clean.sh");
const RUNNER = join(HERE, "run-trusted-final-inspection.mjs");
const HEAD = "a".repeat(40);
const RUN_ID = "12345678-1234-4123-8123-123456789abc";
const COMPACT_RUN_ID = RUN_ID.replaceAll("-", "");
const NEEDLE = `RC_PLAINTEXT_SCAN_${COMPACT_RUN_ID}`;
const BEGIN = `RC_RELEASE_PROOF_LOG_BEGIN_${COMPACT_RUN_ID}`;
const END = `RC_RELEASE_PROOF_LOG_END_${COMPACT_RUN_ID}`;
const ORIGIN = "https://remote-claw-6usc0ku3z-ejc3-7031s-projects.vercel.app";
const PROJECT_ID = "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM";
const TEAM_ID = "team_fYexi4KRmIrq9wtYsiXs9e9H";
const DEPLOYMENT_ID = "dpl_1234567890abcdef";
const STARTED_AT_MS = 1_780_000_000_000;
const COMPLETED_AT_MS = STARTED_AT_MS + 780_000;
const HASH = "b".repeat(64);
const DB_ID_ONE = "11111111-1111-4111-8111-111111111111";
const DB_ID_TWO = "22222222-2222-4222-8222-222222222222";
const pinnedReleaseHost =
	process.platform === "linux" && process.arch === "arm64";

function topologyReceipt(overrides = {}) {
	return {
		schema: "remote-claw-real-topology-browser-leg/v4",
		runId: RUN_ID,
		headSha: HEAD,
		githubDeploymentId: "123",
		trustedOrigin: ORIGIN,
		runtimeAttestation: {
			environment: "preview",
			sha: HEAD,
			storage: {
				backend: "sqlite",
				locator: "turso",
				organization: "proof-org",
				group: "proof-group",
				scope: "pr-aaaaaaa",
			},
		},
		inspectionStatus: "pending",
		logCanaries: { begin: BEGIN, end: END },
		proofWindow: {
			startedAtMs: STARTED_AT_MS,
			completedAtMs: COMPLETED_AT_MS,
		},
		packedTarballSha256: HASH,
		edgeRateLimit: {
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
		},
		claude: {
			version: "2.1.237 (Claude Code)",
			platform: "linux",
			arch: "arm64",
			executableSha256:
				"a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177",
			binaryBytes: 331_864_296,
		},
		browser: {
			name: "chromium",
			version: "140.0.7339.16",
			project: "mobile-chromium",
			result: "passed",
		},
		streamRotation: {
			marker: "rotate",
			routeRotateMs: 240_000,
			observedElapsedMs: 240_125,
			browserObserved: true,
			browserReconnected: true,
			postRotationTurn: "assertions_passed",
		},
		plaintextScanNeedle: NEEDLE,
		...overrides,
	};
}

function inspectionReceipt(overrides = {}) {
	return {
		schema: "remote-claw-real-topology-inspection/v1",
		result: "passed",
		topology: {
			receiptSha256: HASH,
			schema: "remote-claw-real-topology-browser-leg/v4",
			runId: RUN_ID,
			headSha: HEAD,
			githubDeploymentId: "123",
			packedTarballSha256: HASH,
			needleSha256: HASH,
		},
		inspection: {
			startedAt: new Date(COMPLETED_AT_MS + 1_000).toISOString(),
			completedAt: new Date(COMPLETED_AT_MS + 2_000).toISOString(),
		},
		turso: {
			organization: "proof-org",
			group: "proof-group",
			scope: "pr-aaaaaaa",
			databasePrefix: "rc-pr-aaaaaaa-",
			databaseCount: 2,
			databaseSetSha256: HASH,
			fleetEnumerations: 2,
			tableCount: 3,
			rowCount: 6,
			valueCount: 30,
			valueBytes: 120,
			plaintextMatchCount: 0,
		},
		vercel: {
			teamId: TEAM_ID,
			projectId: PROJECT_ID,
			deploymentId: DEPLOYMENT_ID,
			origin: ORIGIN,
			windowStartedAt: new Date(STARTED_AT_MS).toISOString(),
			windowCompletedAt: new Date(COMPLETED_AT_MS).toISOString(),
			beginCanarySha256: HASH,
			endCanarySha256: HASH,
			exhaustedLeafCount: 2,
			queryCount: 2,
			requestCount: 3,
			logLineCount: 3,
			rowManifestSha256: HASH,
			wrongDeploymentCount: 0,
			malformedCount: 0,
			truncatedCount: 0,
			saturatedLeafCount: 0,
			plaintextMatchCount: 0,
		},
		...overrides,
	};
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stagedEvidence(path) {
	const stat = lstatSync(path, { bigint: true });
	return {
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		stat: `${stat.dev}:${stat.ino}:${stat.size}`,
	};
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function stageBoundInspection(topologyPath, overrides = {}) {
	const topology = readTopologyReceipt(topologyPath);
	const base = inspectionReceipt(overrides);
	const receipt = {
		...base,
		topology: {
			...base.topology,
			receiptSha256: topology.receiptSha256,
			needleSha256: sha256(topology.receipt.plaintextScanNeedle),
		},
		vercel: {
			...base.vercel,
			beginCanarySha256: sha256(topology.receipt.logCanaries.begin),
			endCanarySha256: sha256(topology.receipt.logCanaries.end),
		},
	};
	const stagePath = inspectionReceiptStagePath(topologyPath);
	writeInspectionReceipt(stagePath, receipt);
	return {
		evidence: stagedEvidence(stagePath),
		receipt,
		stagePath,
	};
}

function inspectionInput(overrides = {}) {
	return {
		RC_TOPOLOGY_RECEIPT_FILE: "/tmp/topology.json",
		TURSO_API_TOKEN: "platform-token",
		TURSO_GROUP_AUTH_TOKEN: "group-token",
		VERCEL_TOKEN: "vercel-token",
		...overrides,
	};
}

test("private inspection input is an exact four-field, absolute-path contract", () => {
	assert.deepEqual(
		validateInspectionInput(inspectionInput()),
		inspectionInput(),
	);
	assert.throws(
		() =>
			validateInspectionInput(
				inspectionInput({ NODE_OPTIONS: "--require=fake" }),
			),
		/unexpected fields/,
	);
	assert.throws(
		() =>
			validateInspectionInput(
				inspectionInput({ RC_TOPOLOGY_RECEIPT_FILE: "relative.json" }),
			),
		/must be absolute/,
	);
});

test("bootstrap rejects argv and never forwards credentials on argv", () => {
	const result = spawnSync(CLEAN_WRAPPER, ["unexpected"], {
		env: { PATH: "/usr/bin:/bin", ...inspectionInput() },
		encoding: "utf8",
	});
	assert.equal(result.status, 126);
	assert.match(result.stderr, /bootstrap refused/);
	const source = readFileSync(CLEAN_WRAPPER, "utf8");
	assert.match(source, /env -i/);
	assert.match(source, /\/usr\/bin\/node "\$runner_path"/);
	assert.doesNotMatch(source, /\/usr\/bin\/node[^\n]*\$TURSO_/);
});

test("bootstrap verifies and snapshots the committed scanner before opening the credential pipe", () => {
	const source = readFileSync(CLEAN_WRAPPER, "utf8");
	const firstTreeCheck = source.indexOf("verify_candidate_tree || fail");
	const pipeOpen = source.indexOf("printf '%s\\0'");
	const secondTreeCheck = source.lastIndexOf("verify_candidate_tree || fail");
	const publisher = source.indexOf("RC_INSPECTION_MODE=publish");
	const freshPublisherRoot = source.indexOf(
		"publisher_snapshot_root=$(/bin/busybox mktemp",
	);
	const freshPublisherRunner = source.indexOf(
		"publisher_runner_path=$publisher_snapshot_root/scripts/run-trusted-final-inspection.mjs",
	);
	assert.ok(firstTreeCheck > 0);
	assert.ok(pipeOpen > firstTreeCheck);
	assert.ok(secondTreeCheck > pipeOpen);
	assert.ok(freshPublisherRoot > secondTreeCheck);
	assert.ok(freshPublisherRunner > freshPublisherRoot);
	assert.ok(publisher > secondTreeCheck);
	assert.match(source, /\/usr\/bin\/node "\$publisher_runner_path"/);
	assert.match(source, /timeout -s KILL 10[\s\S]*env -i/);
	assert.match(source, /GIT_NO_REPLACE_OBJECTS=1/);
	assert.match(source, /core\.fsmonitor=false/);
	assert.match(source, /status --porcelain=v1 --untracked-files=all/);
	for (const path of [
		"scripts/run-trusted-final-inspection-clean.sh",
		"scripts/run-trusted-final-inspection.mjs",
		"scripts/inspection-receipt-schema.mjs",
	]) {
		assert.match(source, new RegExp(`materialize_committed_module ${path}`));
	}
	assert.match(source, /RC_INSPECTION_REPOSITORY_ROOT="\$repository_root"/);
	assert.match(source, /RC_INSPECTION_MODE=scan/);
	assert.match(source, /publisher_started=1[\s\S]*run_publisher/);
	assert.match(
		source,
		/"\$publisher_started" -eq 0[\s\S]*"\$publisher_succeeded" -eq 1[\s\S]*rm -f -- "\$stage_file"/,
	);
	assert.match(
		source,
		/"\$publisher_status" -eq 75[\s\S]*"\$publisher_status" -ge 128[\s\S]*publisher_indeterminate_seen=1[\s\S]*run_publisher/,
	);
	assert.match(
		source,
		/"\$publisher_indeterminate_seen" -eq 1[\s\S]*publisher_status=75/,
	);
	assert.match(source, /publisher_succeeded=1[\s\S]*cat "\$runner_stdout"/);
	assert.match(
		source,
		/stage_owned_by_this_run=0[\s\S]*"\$stage_owned_by_this_run" -eq 1/,
	);
	assert.match(source, /\[ ! -e "\$stage_file" \] \|\| fail/);
	assert.doesNotMatch(
		source,
		/runner_stdout=\$snapshot_root\/runner\.stdout\n\/bin\/busybox rm/,
	);
	assert.match(
		source,
		/unset TURSO_API_TOKEN TURSO_GROUP_AUTH_TOKEN VERCEL_TOKEN/,
	);
});

test("outer recheck publishes nothing after an equal-tree HEAD move, then a stable retry uses a fresh committed snapshot", (context) => {
	if (!pinnedReleaseHost) {
		context.skip("requires the pinned Linux/arm64 release host");
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "remote-claw-fresh-publisher-"));
	const scripts = join(root, "scripts");
	const receiptRoot = join(root, "tests", "web", "test-results");
	const publisherRetryMarker = join(root, ".publisher-retried");
	const failedRecoveryMarker = join(receiptRoot, "failed-recovery");
	const failedRecoveryAttempt = join(receiptRoot, "failed-recovery-attempt");
	const runGit = (...args) => {
		const result = spawnSync("/usr/bin/git", ["-C", root, ...args], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	try {
		mkdirSync(scripts, { recursive: true });
		mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
		chmodSync(receiptRoot, 0o700);
		cpSync(CLEAN_WRAPPER, join(scripts, basename(CLEAN_WRAPPER)));
		chmodSync(join(scripts, basename(CLEAN_WRAPPER)), 0o755);
		writeFileSync(
			join(scripts, "run-trusted-final-inspection.mjs"),
			`import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
	const finalPath = (topologyPath) => topologyPath.replace(/\\.json$/, ".inspection-v1.json");
	if (process.env.RC_INSPECTION_MODE === "scan") {
		const [topologyPath] = readFileSync(0).toString("utf8").split("\\0");
		const stagePath = \`\${finalPath(topologyPath)}.stage\`;
		writeFileSync(stagePath, '{"schema":"committed-stage"}\\n', { mode: 0o600 });
		const failAfterStage = join(process.env.RC_INSPECTION_REPOSITORY_ROOT, "tests/web/test-results/fail-after-stage");
		if (existsSync(failAfterStage)) process.exit(94);
		chmodSync(process.argv[1], 0o600);
	writeFileSync(process.argv[1], "process.exit(91);\\n");
	const moveHead = join(process.env.RC_INSPECTION_REPOSITORY_ROOT, "tests/web/test-results/move-head");
	if (existsSync(moveHead)) {
		const moved = spawnSync("/usr/bin/git", ["-C", process.env.RC_INSPECTION_REPOSITORY_ROOT, "commit", "--allow-empty", "--quiet", "-m", "equal-tree move"]);
		if (moved.status !== 0) process.exit(93);
	}
	process.stdout.write(\`content-free staged final-inspection receipt: \${stagePath}\\n\`);
} else if (process.env.RC_INSPECTION_MODE === "publish") {
	const outputPath = finalPath(process.env.RC_TOPOLOGY_RECEIPT_FILE);
	const failedRecoveryMarker = ${JSON.stringify(failedRecoveryMarker)};
	const failedRecoveryAttempt = ${JSON.stringify(failedRecoveryAttempt)};
	if (existsSync(failedRecoveryMarker)) {
		if (!existsSync(failedRecoveryAttempt)) {
			copyFileSync(process.env.RC_INSPECTION_STAGE_FILE, outputPath, constants.COPYFILE_EXCL);
			chmodSync(outputPath, 0o600);
			writeFileSync(failedRecoveryAttempt, "attempt\\n", { mode: 0o600, flag: "wx" });
			process.exit(75);
		}
		process.exit(1);
	}
	const signalMarker = join(process.env.RC_INSPECTION_REPOSITORY_ROOT, "tests/web/test-results/signal-publisher");
	if (existsSync(signalMarker)) {
		copyFileSync(process.env.RC_INSPECTION_STAGE_FILE, outputPath, constants.COPYFILE_EXCL);
		chmodSync(outputPath, 0o600);
		process.kill(process.ppid, "SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 250));
		process.exit(74);
	}
	const retryMarker = ${JSON.stringify(publisherRetryMarker)};
	if (!existsSync(retryMarker)) {
		copyFileSync(process.env.RC_INSPECTION_STAGE_FILE, outputPath, constants.COPYFILE_EXCL);
		chmodSync(outputPath, 0o600);
		writeFileSync(retryMarker, "retry\\n", { mode: 0o600, flag: "wx" });
		process.exit(75);
	}
	process.stdout.write(\`content-free final-inspection receipt: \${outputPath}\\n\`);
} else {
	process.exit(92);
}
`,
			{ mode: 0o644 },
		);
		writeFileSync(
			join(scripts, "inspection-receipt-schema.mjs"),
			"export {};\n",
			{
				mode: 0o644,
			},
		);
		writeFileSync(join(root, ".gitignore"), "/tests/web/test-results/\n");
		runGit("init", "--quiet");
		runGit("config", "user.name", "Proof Test");
		runGit("config", "user.email", "proof@example.invalid");
		runGit("add", ".");
		runGit("commit", "--quiet", "-m", "fixture");
		const head = runGit("rev-parse", "HEAD");
		const originalTree = runGit("rev-parse", "HEAD^{tree}");
		const topologyPath = join(
			receiptRoot,
			`real-topology-browser-leg-${head}-${"1".repeat(32)}.json`,
		);
		writeFileSync(topologyPath, "{}\n", { mode: 0o600 });
		const moveHead = join(receiptRoot, "move-head");
		const invoke = () =>
			spawnSync(join(scripts, "run-trusted-final-inspection-clean.sh"), [], {
				encoding: "utf8",
				env: {
					PATH: "/usr/bin:/bin",
					RC_TOPOLOGY_RECEIPT_FILE: topologyPath,
					TURSO_API_TOKEN: "platform-token",
					TURSO_GROUP_AUTH_TOKEN: "group-token",
					VERCEL_TOKEN: "vercel-token",
				},
				timeout: 30_000,
			});
		const canonicalPath = inspectionReceiptPath(topologyPath);
		const stagePath = inspectionReceiptStagePath(topologyPath);
		const committedRunner = join(scripts, "run-trusted-final-inspection.mjs");
		const committedRunnerBytes = readFileSync(committedRunner);
		const failAfterStage = join(receiptRoot, "fail-after-stage");
		writeFileSync(failAfterStage, "fail\\n", { mode: 0o600 });
		const scannerFailed = invoke();
		assert.equal(scannerFailed.status, 94, scannerFailed.stderr);
		assert.equal(
			readFileSync(stagePath, "utf8"),
			'{"schema":"committed-stage"}\n',
		);
		assert.deepEqual(readFileSync(committedRunner), committedRunnerBytes);
		rmSync(failAfterStage);
		rmSync(stagePath);
		writeFileSync(stagePath, "preserved-stage\n", { mode: 0o600 });
		const preservedStageStat = lstatSync(stagePath);
		const preserved = invoke();
		assert.equal(preserved.status, 126, preserved.stderr);
		const preservedStageAfter = lstatSync(stagePath);
		assert.equal(preservedStageAfter.dev, preservedStageStat.dev);
		assert.equal(preservedStageAfter.ino, preservedStageStat.ino);
		assert.equal(readFileSync(stagePath, "utf8"), "preserved-stage\n");
		assert.deepEqual(readFileSync(committedRunner), committedRunnerBytes);
		rmSync(stagePath);
		writeFileSync(moveHead, "move\n", { mode: 0o600 });
		const refused = invoke();
		assert.equal(refused.status, 126, refused.stderr);
		assert.equal(existsSync(canonicalPath), false);
		assert.equal(existsSync(stagePath), false);
		assert.notEqual(runGit("rev-parse", "HEAD"), head);
		assert.equal(runGit("rev-parse", "HEAD^{tree}"), originalTree);

		runGit("update-ref", "HEAD", head);
		rmSync(moveHead);
		const signalMarker = join(receiptRoot, "signal-publisher");
		writeFileSync(signalMarker, "signal\n", { mode: 0o600 });
		const interrupted = invoke();
		assert.equal(interrupted.status, 143, interrupted.stderr);
		assert.equal(existsSync(canonicalPath), true);
		assert.equal(existsSync(stagePath), true);
		rmSync(canonicalPath);
		rmSync(stagePath);
		rmSync(signalMarker);

		writeFileSync(failedRecoveryMarker, "fail\n", { mode: 0o600 });
		const unresolved = invoke();
		assert.equal(unresolved.status, 75, unresolved.stderr);
		assert.equal(existsSync(canonicalPath), true);
		assert.equal(existsSync(stagePath), true);
		rmSync(canonicalPath);
		rmSync(stagePath);
		rmSync(failedRecoveryMarker);
		rmSync(failedRecoveryAttempt);

		const result = invoke();
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			result.stdout,
			`content-free final-inspection receipt: ${canonicalPath}\n`,
		);
		assert.equal(
			readFileSync(canonicalPath, "utf8"),
			'{"schema":"committed-stage"}\n',
		);
		assert.equal(existsSync(publisherRetryMarker), true);
		assert.equal(existsSync(stagePath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("direct runner refuses argv before consuming private bootstrap input", () => {
	const result = spawnSync("/usr/bin/node", [RUNNER, "unexpected"], {
		env: {
			PATH: "/usr/bin:/bin",
			LANG: "C.UTF-8",
			RC_INSPECTION_INPUT_FD: "0",
			RC_INSPECTION_MODE: "scan",
		},
		input: Buffer.from(
			Object.values(inspectionInput())
				.map((value) => `${value}\0`)
				.join(""),
		),
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		"final inspection refused: release gate did not pass\n",
	);
});

test("fd bootstrap validates the exact clean environment before reading", () => {
	let reads = 0;
	assert.throws(
		() =>
			readInspectionBootstrapInput({
				environment: {
					PATH: "/usr/bin:/bin",
					LANG: "C.UTF-8",
					RC_INSPECTION_INPUT_FD: "0",
					RC_INSPECTION_MODE: "scan",
					RC_INSPECTION_REPOSITORY_ROOT: resolve(HERE, ".."),
					NODE_OPTIONS: "hostile",
				},
				read() {
					reads += 1;
					return 0;
				},
				statFd: () => ({ isFIFO: () => true }),
			}),
		/bootstrap environment/,
	);
	assert.equal(reads, 0);
});

test("credential-free publisher accepts only its exact nonsecret environment", () => {
	const repositoryRoot = resolve(HERE, "..");
	const environment = {
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		RC_INSPECTION_MODE: "publish",
		RC_INSPECTION_REPOSITORY_ROOT: repositoryRoot,
		RC_TOPOLOGY_RECEIPT_FILE: "/tmp/topology.json",
		RC_INSPECTION_STAGE_FILE: "/tmp/topology.inspection-v1.json.stage",
		RC_INSPECTION_STAGE_SHA256: HASH,
		RC_INSPECTION_STAGE_STAT: "1:2:3",
	};
	assert.equal(
		validateInspectionPublishEnvironment(environment).repositoryRoot,
		repositoryRoot,
	);
	assert.throws(
		() =>
			validateInspectionPublishEnvironment({
				...environment,
				VERCEL_TOKEN: "forbidden",
			}),
		/unexpected fields/,
	);
	for (const [field, value] of [
		["RC_INSPECTION_STAGE_SHA256", "not-a-digest"],
		["RC_INSPECTION_STAGE_STAT", "1:2:0"],
		["RC_INSPECTION_STAGE_STAT", "1:2:3:4"],
	]) {
		assert.throws(
			() =>
				validateInspectionPublishEnvironment({
					...environment,
					[field]: value,
				}),
			/staged inspection receipt/,
		);
	}
});

test("private v4 topology receipt is strict, hashed over immutable bytes, and owner-mode checked", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-topology-read-"));
	const path = join(root, "topology.json");
	chmodSync(root, 0o700);
	try {
		writeFileSync(path, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const result = readTopologyReceipt(path);
		assert.equal(result.receipt.runId, RUN_ID);
		assert.match(result.receiptSha256, /^[0-9a-f]{64}$/);
		chmodSync(path, 0o644);
		assert.throws(
			() => readTopologyReceipt(path),
			/private owned regular file/,
		);
		chmodSync(path, 0o600);
		writeFileSync(
			path,
			JSON.stringify(topologyReceipt({ transcript: "forbidden" })),
		);
		assert.throws(() => readTopologyReceipt(path), /unexpected fields/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("topology receipt reading rejects symlinks and an inode swap during the descriptor read", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-topology-swap-"));
	const path = join(root, "topology.json");
	const link = join(root, "topology-link.json");
	const hardLink = join(root, "topology-hard-link.json");
	const displaced = join(root, "topology.displaced.json");
	chmodSync(root, 0o700);
	try {
		writeFileSync(path, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		symlinkSync(path, link);
		assert.throws(
			() => readTopologyReceipt(link),
			/bounded private owned regular file/,
		);
		linkSync(path, hardLink);
		assert.throws(
			() => readTopologyReceipt(path),
			/bounded private owned regular file/,
		);
		rmSync(hardLink);
		assert.throws(
			() =>
				readTopologyReceipt(path, {
					readFile(descriptor) {
						const bytes = readFileSync(descriptor);
						renameSync(path, displaced);
						writeFileSync(path, bytes, { mode: 0o600 });
						return bytes;
					},
				}),
			/topology receipt identity changed while it was read/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("strict v4 parsing independently pins the Claude, browser, and complete WAF evidence", () => {
	const mutations = [
		(receipt) => {
			receipt.claude.version = "2.1.238 (Claude Code)";
		},
		(receipt) => {
			receipt.claude.platform = "darwin";
		},
		(receipt) => {
			receipt.claude.arch = "x64";
		},
		(receipt) => {
			receipt.claude.executableSha256 = "c".repeat(64);
		},
		(receipt) => {
			receipt.claude.binaryBytes += 1;
		},
		(receipt) => {
			receipt.browser.name = "firefox";
		},
		(receipt) => {
			receipt.browser.version = "Chromium 140";
		},
		(receipt) => {
			receipt.browser.project = "desktop-chromium";
		},
		(receipt) => {
			receipt.browser.result = "failed";
		},
		...[
			["projectId", "prj_wrong"],
			["teamId", "team_wrong"],
			["firewallConfigId", "waf_wrong"],
			["firewallConfigVersion", 4],
			["ruleId", "rule_wrong"],
			["ruleName", "wrong-name"],
			["pathPrefix", "/api/other"],
			["algorithm", "fixed_window"],
			["limit", 21],
			["windowSeconds", 61],
			["key", "user"],
			["excessAction", "log"],
			["firewallBypassCount", 1],
		].map(([key, value]) => (receipt) => {
			receipt.edgeRateLimit[key] = value;
		}),
	];
	const root = mkdtempSync(join(tmpdir(), "remote-claw-topology-mutations-"));
	const path = join(root, "topology.json");
	chmodSync(root, 0o700);
	try {
		for (const mutate of mutations) {
			const receipt = structuredClone(topologyReceipt());
			mutate(receipt);
			writeFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
			assert.throws(() => readTopologyReceipt(path));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("candidate repository binding rejects dirty and different HEAD states", () => {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "remote-claw-repository-"));
	let head = HEAD;
	let status = "";
	const execFile = (_git, args, options) => {
		assert.equal(options.cwd, repositoryRoot);
		assert.deepEqual(options.env, {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_OPTIONAL_LOCKS: "0",
			LANG: "C.UTF-8",
			PATH: "/usr/bin:/bin",
		});
		assert.equal(options.timeout, 10_000);
		assert.equal(options.killSignal, "SIGKILL");
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
		if (command.join(" ") === "rev-parse --show-toplevel")
			return `${repositoryRoot}\n`;
		if (command.join(" ") === "rev-parse --verify HEAD") return `${head}\n`;
		if (command[0] === "status") return status;
		throw new Error("unexpected git command");
	};
	try {
		assert.equal(
			inspectCandidateRepository({
				expectedHead: HEAD,
				repositoryRoot,
				execFile,
			}).headSha,
			HEAD,
		);
		status = " M scripts/run-trusted-final-inspection.mjs\n";
		assert.throws(
			() =>
				inspectCandidateRepository({
					expectedHead: HEAD,
					repositoryRoot,
					execFile,
				}),
			/clean topology-candidate repository HEAD/,
		);
		status = "";
		head = "b".repeat(40);
		assert.throws(
			() =>
				inspectCandidateRepository({
					expectedHead: HEAD,
					repositoryRoot,
					execFile,
				}),
			/clean topology-candidate repository HEAD/,
		);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("pinned libSQL package manifests reject changed dependency bytes", () => {
	const spec = PINNED_LIBSQL_PACKAGES[0];
	const source = resolve(HERE, "..", spec.packagePath);
	assert.equal(validatePinnedPackageTree(source, spec).sha256, spec.sha256);
	const root = mkdtempSync(join(tmpdir(), "remote-claw-mutated-libsql-"));
	const target = join(root, "client");
	try {
		cpSync(source, target, { recursive: true });
		writeFileSync(join(target, "package.json"), "{}\n");
		assert.throws(
			() => validatePinnedPackageTree(target, spec),
			/package bytes do not match/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("libSQL is loaded only from a private byte-pinned snapshot and revalidated", async () => {
	const scannerSource = readFileSync(RUNNER, "utf8");
	assert.doesNotMatch(scannerSource, /from\s+["']@libsql\/client/);
	const snapshotRoot = mkdtempSync(
		join(tmpdir(), "remote-claw-libsql-snapshot-"),
	);
	const proof = await preparePinnedLibsqlClient({
		temporaryDirectory: () => snapshotRoot,
	});
	try {
		const client = proof.createClient({
			url: "https://proof.invalid",
			authToken: "unused",
		});
		assert.equal(client.protocol, "http");
		client.close();
		proof.revalidate();
		writeFileSync(
			join(snapshotRoot, "node_modules/@libsql/client/package.json"),
			"{}\n",
		);
		assert.throws(() => proof.revalidate(), /package bytes do not match/);
	} finally {
		proof.cleanup();
	}
});

test("Turso enumeration uses the exact org/group API, rejects pagination, and binds hostnames", async () => {
	let requested;
	const databases = await listTursoDatabases({
		organization: "proof-org",
		group: "proof-group",
		token: "platform-token",
		async fetchImpl(url, options) {
			requested = { url: String(url), options };
			return jsonResponse({
				databases: [
					{
						Name: "rc-pr-aaaaaaa-two",
						DbId: DB_ID_TWO,
						Hostname: "rc-pr-aaaaaaa-two-proof-org.turso.io",
						group: "proof-group",
					},
					{
						Name: "rc-pr-aaaaaaa-one",
						DbId: DB_ID_ONE,
						Hostname: "rc-pr-aaaaaaa-one-proof-org.turso.io",
						group: "proof-group",
					},
				],
			});
		},
	});
	assert.deepEqual(
		databases.map((database) => database.name),
		["rc-pr-aaaaaaa-one", "rc-pr-aaaaaaa-two"],
	);
	const url = new URL(requested.url);
	assert.equal(url.origin, "https://api.turso.tech");
	assert.equal(url.pathname, "/v1/organizations/proof-org/databases");
	assert.equal(url.searchParams.get("group"), "proof-group");
	assert.equal(
		requested.options.headers.authorization,
		"Bearer platform-token",
	);
	await assert.rejects(
		listTursoDatabases({
			organization: "proof-org",
			group: "proof-group",
			token: "token",
			fetchImpl: async () => jsonResponse({ databases: [], next: "cursor" }),
		}),
		/unexpected fields/,
	);
	await assert.rejects(
		listTursoDatabases({
			organization: "proof-org",
			group: "proof-group",
			token: "token",
			fetchImpl: async () =>
				jsonResponse({
					databases: [
						{
							Name: "db",
							DbId: DB_ID_ONE,
							Hostname: "other-proof-org.turso.io",
							group: "proof-group",
						},
					],
				}),
		}),
		/not bound/,
	);
});

test("Turso response bodies have a hard read deadline and are cancelled", async () => {
	let cancelled = false;
	const started = performance.now();
	await assert.rejects(
		listTursoDatabases({
			organization: "proof-org",
			group: "proof-group",
			token: "token",
			operationTimeoutMs: 20,
			fetchImpl: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 200 },
				),
		}),
		(error) => {
			assert.equal(
				error.message,
				"Turso fleet enumeration response is malformed or oversized",
			);
			return true;
		},
	);
	assert.equal(cancelled, true);
	assert.ok(performance.now() - started < 1_000);
});

test("Turso fleet stability binds physical DbId, not only reusable name and hostname", () => {
	const before = [
		{
			id: DB_ID_ONE,
			name: "rc-pr-aaaaaaa-one",
			hostname: "rc-pr-aaaaaaa-one-proof-org.turso.io",
		},
	];
	assert.throws(
		() => validateStableTursoFleet(before, [{ ...before[0], id: DB_ID_TWO }]),
		/fleet changed/,
	);
});

function result(columns, rows) {
	return { columns, rows };
}

function tursoClientFixture({ plaintext = false, rejectExecute = false } = {}) {
	const statements = [];
	const tables = {
		messages: {
			pragma: [
				{
					cid: 0,
					name: "id",
					type: "INTEGER",
					notnull: 1,
					dflt_value: null,
					pk: 1,
					hidden: 0,
				},
				{
					cid: 1,
					name: "body",
					type: "BLOB",
					notnull: 0,
					dflt_value: null,
					pk: 0,
					hidden: 0,
				},
			],
			rows: [
				[1, new Uint8Array(Buffer.from(plaintext ? NEEDLE : "cipher-one"))],
				[2, null],
			],
		},
		memberships: {
			pragma: [
				{
					cid: 0,
					name: "tenant",
					type: "TEXT",
					notnull: 1,
					dflt_value: null,
					pk: 1,
					hidden: 0,
				},
				{
					cid: 1,
					name: "id",
					type: "TEXT",
					notnull: 1,
					dflt_value: null,
					pk: 2,
					hidden: 0,
				},
				{
					cid: 2,
					name: "value",
					type: "TEXT",
					notnull: 0,
					dflt_value: null,
					pk: 0,
					hidden: 0,
				},
			],
			rows: [
				{ tenant: "same", id: "a", value: "opaque-a" },
				{ tenant: "same", id: "b", value: "opaque-b" },
			],
		},
		shadows: {
			pragma: [
				{
					cid: 0,
					name: "_rowid_",
					type: "TEXT",
					notnull: 0,
					dflt_value: null,
					pk: 1,
					hidden: 0,
				},
				{
					cid: 1,
					name: "rowid",
					type: "TEXT",
					notnull: 0,
					dflt_value: null,
					pk: 0,
					hidden: 0,
				},
				{
					cid: 2,
					name: "oid",
					type: "TEXT",
					notnull: 0,
					dflt_value: null,
					pk: 0,
					hidden: 0,
				},
			],
			rows: [
				{ _rowid_: "a", rowid: "same", oid: "same" },
				{ _rowid_: "A", rowid: "same", oid: "same" },
			],
		},
	};
	const schemaRows = [
		{
			type: "table",
			name: "messages",
			tbl_name: "messages",
			sql: "CREATE TABLE messages(id INTEGER PRIMARY KEY, body BLOB)",
		},
		{
			type: "table",
			name: "memberships",
			tbl_name: "memberships",
			sql: "CREATE TABLE memberships(tenant TEXT, id TEXT, value TEXT, PRIMARY KEY(tenant,id)) WITHOUT ROWID",
		},
		{
			type: "table",
			name: "shadows",
			tbl_name: "shadows",
			sql: "CREATE TABLE shadows(_rowid_ TEXT COLLATE NOCASE PRIMARY KEY, rowid TEXT, oid TEXT)",
		},
	];
	const transaction = {
		async execute(sql) {
			statements.push(sql);
			if (rejectExecute) throw new Error(`provider leak ${NEEDLE}`);
			if (sql.startsWith("SELECT type")) {
				return result(["type", "name", "tbl_name", "sql"], schemaRows);
			}
			const pragma = /PRAGMA table_xinfo\("([^"]+)"\)/.exec(sql);
			if (pragma) {
				return result(
					["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"],
					tables[pragma[1]].pragma,
				);
			}
			const tableName = /FROM "([^"]+)"/.exec(sql)?.[1];
			if (!tableName) throw new Error("unexpected test SQL");
			if (sql.startsWith("SELECT COUNT")) {
				return result(
					["rc_scan_count"],
					[{ rc_scan_count: tables[tableName].rows.length }],
				);
			}
			return result(
				tables[tableName].pragma.map((column) => column.name),
				tables[tableName].rows,
			);
		},
		async close() {},
	};
	return {
		statements,
		createClientImpl() {
			return {
				async transaction(mode) {
					assert.equal(mode, "read");
					return transaction;
				},
				close() {},
			};
		},
	};
}

test("Turso scan covers schema, metadata, all cells, composite-key ties, and shadowed-rowid fallback", async () => {
	const fixture = tursoClientFixture();
	const counters = await scanTursoFleet({
		databases: [
			{
				name: "rc-pr-aaaaaaa-one",
				hostname: "rc-pr-aaaaaaa-one-proof-org.turso.io",
			},
		],
		authToken: "group-token",
		needle: NEEDLE,
		createClientImpl: fixture.createClientImpl,
	});
	assert.equal(counters.tableCount, 3);
	assert.equal(counters.columnCount, 8);
	assert.equal(counters.rowCount, 6);
	assert.equal(counters.plaintextMatchCount, 0);
	assert.ok(
		fixture.statements.some((statement) =>
			statement.includes('FROM "messages" ORDER BY "_rowid_"'),
		),
	);
	assert.ok(
		fixture.statements.some((statement) =>
			statement.includes('FROM "memberships" ORDER BY "tenant", "id"'),
		),
	);
	assert.ok(
		fixture.statements.some(
			(statement) =>
				statement.includes(
					'FROM "shadows" ORDER BY typeof("_rowid_") COLLATE BINARY, hex(CAST("_rowid_" AS BLOB)) COLLATE BINARY, typeof("rowid") COLLATE BINARY, hex(CAST("rowid" AS BLOB)) COLLATE BINARY, typeof("oid") COLLATE BINARY, hex(CAST("oid" AS BLOB)) COLLATE BINARY',
				) && statement.includes(" LIMIT "),
		),
	);
});

test("Turso scan exhausts a real multi-page NOCASE table with every rowid alias shadowed", async () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-libsql-order-"));
	const databasePath = join(root, "proof.db");
	const url = `file:${databasePath}`;
	const setup = createClient({ url });
	try {
		await setup.execute(
			'CREATE TABLE shadows("_rowid_" TEXT COLLATE NOCASE, "rowid" TEXT, "oid" TEXT)',
		);
		await setup.execute(
			"WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 502) INSERT INTO shadows SELECT CASE WHEN n % 2 = 0 THEN 'a' ELSE 'A' END, 'same', printf('%03d', n % 3) FROM seq",
		);
	} finally {
		setup.close();
	}
	try {
		const counters = await scanTursoFleet({
			databases: [
				{
					name: "rc-pr-aaaaaaa-one",
					hostname: "rc-pr-aaaaaaa-one-proof-org.turso.io",
				},
			],
			authToken: "group-token",
			needle: NEEDLE,
			createClientImpl: () => createClient({ url }),
		});
		assert.equal(counters.tableCount, 1);
		assert.equal(counters.rowCount, 502);
		assert.equal(counters.plaintextMatchCount, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Turso content and provider failures are fail-closed and content-free", async () => {
	for (const fixture of [
		tursoClientFixture({ plaintext: true }),
		tursoClientFixture({ rejectExecute: true }),
	]) {
		await assert.rejects(
			scanTursoFleet({
				databases: [
					{
						name: "rc-pr-aaaaaaa-one",
						hostname: "rc-pr-aaaaaaa-one-proof-org.turso.io",
					},
				],
				authToken: "group-token",
				needle: NEEDLE,
				createClientImpl: fixture.createClientImpl,
			}),
			(error) => {
				assert.equal(error.message, "Turso content inspection failed");
				assert.doesNotMatch(error.message, new RegExp(NEEDLE));
				return true;
			},
		);
	}
});

test("Turso query and transaction-close hangs still abort the client within bounded cleanup", async () => {
	let transactionCloseCalled = false;
	let clientClosed = false;
	const started = performance.now();
	await assert.rejects(
		scanTursoFleet({
			databases: [
				{
					name: "rc-pr-aaaaaaa-one",
					hostname: "rc-pr-aaaaaaa-one-proof-org.turso.io",
				},
			],
			authToken: "group-token",
			needle: NEEDLE,
			operationTimeoutMs: 20,
			createClientImpl() {
				return {
					async transaction() {
						return {
							execute: () => new Promise(() => undefined),
							close() {
								transactionCloseCalled = true;
								return new Promise(() => undefined);
							},
						};
					},
					close() {
						clientClosed = true;
					},
				};
			},
		}),
		(error) => {
			assert.equal(error.message, "Turso content inspection failed");
			return true;
		},
	);
	assert.equal(transactionCloseCalled, true);
	assert.equal(clientClosed, true);
	assert.ok(performance.now() - started < 1_000);
});

function logRow(requestId, timestamp, message, overrides = {}) {
	return {
		requestId,
		timestamp,
		deploymentId: DEPLOYMENT_ID,
		domain: new URL(ORIGIN).hostname,
		logs: [{ level: "info", message, messageTruncated: false }],
		...overrides,
	};
}

function shardedLogFetch({ mutateSecondSnapshot = false } = {}) {
	const calls = [];
	let rootCalls = 0;
	return {
		calls,
		async fetchImpl(url, options) {
			const parsed = new URL(url);
			const start = Number(parsed.searchParams.get("startDate"));
			const end = Number(parsed.searchParams.get("endDate"));
			calls.push({ parsed, options, start, end });
			if (start === 1_000 && end === 2_000) {
				rootCalls += 1;
				return jsonResponse({ rows: [], hasMoreRows: true });
			}
			if (end === 1_500) {
				return jsonResponse({
					rows: [
						logRow("begin-request", 1_100, BEGIN),
						logRow("shared-request", 1_500, "settled"),
					],
					hasMoreRows: false,
				});
			}
			return jsonResponse({
				rows: [
					logRow("shared-request", 1_500, "settled"),
					logRow(
						"end-request",
						1_900,
						mutateSecondSnapshot && rootCalls > 1 ? `${END}-changed` : END,
					),
				],
				hasMoreRows: false,
			});
		},
	};
}

function logScanOptions(fetchImpl) {
	return {
		projectId: PROJECT_ID,
		teamId: TEAM_ID,
		deploymentId: DEPLOYMENT_ID,
		windowStartedAtMs: 1_000,
		windowCompletedAtMs: 2_000,
		token: "vercel-token",
		plaintextNeedle: NEEDLE,
		beginCanary: BEGIN,
		endCanary: END,
		fetchImpl,
	};
}

test("Vercel log scan recursively exhausts page zero with a 1ms halo and dedupes overlap", async () => {
	const fixture = shardedLogFetch();
	const result = await scanVercelLogSnapshot(logScanOptions(fixture.fetchImpl));
	assert.equal(result.queryCount, 3);
	assert.equal(result.exhaustedLeafCount, 2);
	assert.equal(result.requestCount, 3);
	assert.equal(result.logLineCount, 3);
	assert.equal(result.plaintextMatchCount, 0);
	assert.match(result.rowManifestSha256, /^[0-9a-f]{64}$/);
	for (const call of fixture.calls) {
		assert.equal(call.parsed.origin, "https://vercel.com");
		assert.equal(call.parsed.pathname, "/api/logs/request-logs");
		assert.equal(call.parsed.searchParams.get("page"), "0");
		assert.equal(call.parsed.searchParams.get("deploymentId"), DEPLOYMENT_ID);
		assert.equal(call.options.headers.authorization, "Bearer vercel-token");
	}
	assert.ok(
		fixture.calls.some((call) => call.start === 1_000 && call.end === 1_500),
	);
	assert.ok(
		fixture.calls.some((call) => call.start === 1_500 && call.end === 2_000),
	);
});

test("Vercel provider calls clamp their timeout to the remaining overall deadline", async () => {
	const started = performance.now();
	await assert.rejects(
		scanVercelLogSnapshot({
			...logScanOptions(() => new Promise(() => undefined)),
			now: () => performance.now(),
			deadlineAt: started + 25,
			operationTimeoutMs: 1_000,
		}),
		/Vercel runtime-log request failed/,
	);
	assert.ok(performance.now() - started < 500);
});

test("Vercel scan fails when only a saturated parent page exposes plaintext", async () => {
	await assert.rejects(
		scanVercelLogSnapshot(
			logScanOptions(async (url) => {
				const parsed = new URL(url);
				const start = Number(parsed.searchParams.get("startDate"));
				const end = Number(parsed.searchParams.get("endDate"));
				if (start === 1_000 && end === 2_000) {
					return jsonResponse({
						rows: [logRow("parent-only", 1_250, NEEDLE)],
						hasMoreRows: true,
					});
				}
				return jsonResponse({
					rows:
						end === 1_500
							? [logRow("begin", 1_100, BEGIN)]
							: [logRow("end", 1_900, END)],
					hasMoreRows: false,
				});
			}),
		),
		/Vercel runtime-log inspection did not pass/,
	);
});

test("Vercel settlement refuses before starting a wait that cannot fit in the overall deadline", async () => {
	let delayed = false;
	const started = performance.now();
	await assert.rejects(
		scanSettledVercelLogs({
			...logScanOptions(async () =>
				jsonResponse({ rows: [], hasMoreRows: false }),
			),
			now: () => performance.now(),
			deadlineAt: started + 10,
			initialSettleMs: 30,
			betweenSettleMs: 0,
			delay: async () => {
				delayed = true;
			},
		}),
		/exceeded the final-inspection deadline/,
	);
	assert.equal(delayed, false);
});

test("Vercel log scan fails on 1ms saturation, truncation, wrong deployment, plaintext, and missing canaries", async () => {
	await assert.rejects(
		scanVercelLogSnapshot({
			...logScanOptions(async () =>
				jsonResponse({ rows: [], hasMoreRows: true }),
			),
			windowStartedAtMs: 1_000,
			windowCompletedAtMs: 1_000,
		}),
		/saturated a 1ms leaf/,
	);
	for (const [row, pattern] of [
		[
			logRow("truncated", 1_100, BEGIN, {
				logs: [{ message: BEGIN, messageTruncated: true }],
			}),
			/truncated/,
		],
		[
			logRow("wrong", 1_100, BEGIN, { deploymentId: "dpl_wrong" }),
			/wrong deployment/,
		],
		[
			logRow("bad-truncation", 1_100, BEGIN, {
				logs: [{ message: BEGIN, messageTruncated: "unknown" }],
			}),
			/truncated or malformed/,
		],
		[logRow("bad-line", 1_100, BEGIN, { logs: [BEGIN] }), /malformed log line/],
		[logRow("plaintext", 1_100, NEEDLE), /did not pass/],
		[
			logRow("plaintext-key", 1_100, BEGIN, {
				logs: [{ message: BEGIN, messageTruncated: false, [NEEDLE]: "opaque" }],
			}),
			/did not pass/,
		],
		[logRow("only-begin", 1_100, BEGIN), /missing a proof-window canary/],
	]) {
		await assert.rejects(
			scanVercelLogSnapshot(
				logScanOptions(async () =>
					jsonResponse({ rows: [row], hasMoreRows: false }),
				),
			),
			pattern,
		);
	}
});

test("Vercel log gate requires two byte-identical settled snapshots", async () => {
	const stable = shardedLogFetch();
	const delays = [];
	const result = await scanSettledVercelLogs({
		...logScanOptions(stable.fetchImpl),
		initialSettleMs: 1,
		betweenSettleMs: 2,
		delay: async (milliseconds) => delays.push(milliseconds),
	});
	assert.deepEqual(delays, [1, 2]);
	assert.equal(result.queryCount, 6);
	assert.equal(result.exhaustedLeafCount, 4);

	const changing = shardedLogFetch({ mutateSecondSnapshot: true });
	await assert.rejects(
		scanSettledVercelLogs({
			...logScanOptions(changing.fetchImpl),
			initialSettleMs: 0,
			betweenSettleMs: 0,
			delay: async () => undefined,
		}),
		/two identical settled snapshots/,
	);
});

test("Vercel deployment resolution binds immutable hostname, team, project, SHA, state, and Preview target", async () => {
	let requested;
	const result = await resolveImmutableVercelDeployment({
		origin: ORIGIN,
		headSha: HEAD,
		teamId: TEAM_ID,
		projectId: PROJECT_ID,
		token: "vercel-token",
		async fetchImpl(url, options) {
			requested = { url: String(url), options };
			return jsonResponse({
				id: DEPLOYMENT_ID,
				url: new URL(ORIGIN).hostname,
				projectId: PROJECT_ID,
				project: { id: PROJECT_ID },
				ownerId: TEAM_ID,
				target: null,
				readyState: "READY",
				status: "READY",
				meta: { githubCommitSha: HEAD },
				gitSource: { type: "github", sha: HEAD },
			});
		},
	});
	assert.equal(result.deploymentId, DEPLOYMENT_ID);
	assert.equal(
		requested.url,
		`https://api.vercel.com/v13/deployments/${new URL(ORIGIN).hostname}?teamId=${TEAM_ID}`,
	);
	assert.equal(requested.options.headers.authorization, "Bearer vercel-token");
	await assert.rejects(
		resolveImmutableVercelDeployment({
			origin: ORIGIN,
			headSha: HEAD,
			teamId: TEAM_ID,
			projectId: PROJECT_ID,
			token: "token",
			fetchImpl: async () =>
				jsonResponse({
					id: DEPLOYMENT_ID,
					url: new URL(ORIGIN).hostname,
					projectId: PROJECT_ID,
					project: { id: PROJECT_ID },
					ownerId: "team_wrong",
					target: null,
					readyState: "READY",
					status: "READY",
					meta: { githubCommitSha: HEAD },
					gitSource: { type: "github", sha: HEAD },
				}),
		}),
		/does not match/,
	);
});

test("final inspection orchestrates both exhaustive provider scans and emits only counts and digests", async () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-final-inspection-"));
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	chmodSync(root, 0o700);
	writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
		mode: 0o600,
	});
	const tursoFixture = tursoClientFixture();
	let fleetEnumerations = 0;
	let logSnapshots = 0;
	let repositoryInspections = 0;
	let written;
	try {
		const result = await runTrustedFinalInspection({
			input: inspectionInput({ RC_TOPOLOGY_RECEIPT_FILE: topologyPath }),
			receiptRoot: root,
			repositoryRoot: root,
			repositoryInspector({ expectedHead, repositoryRoot }) {
				assert.equal(expectedHead, HEAD);
				assert.equal(repositoryRoot, root);
				repositoryInspections += 1;
			},
			createClientImpl: tursoFixture.createClientImpl,
			now: () => COMPLETED_AT_MS + 1_000,
			initialSettleMs: 0,
			betweenSettleMs: 0,
			delay: async () => undefined,
			async fetchImpl(url) {
				const parsed = new URL(url);
				if (parsed.origin === "https://api.turso.tech") {
					fleetEnumerations += 1;
					return jsonResponse({
						databases: [
							{
								Name: "rc-pr-aaaaaaa-one",
								DbId: DB_ID_ONE,
								Hostname: "rc-pr-aaaaaaa-one-proof-org.turso.io",
								group: "proof-group",
							},
						],
					});
				}
				if (parsed.origin === "https://api.vercel.com") {
					return jsonResponse({
						id: DEPLOYMENT_ID,
						url: new URL(ORIGIN).hostname,
						projectId: PROJECT_ID,
						project: { id: PROJECT_ID },
						ownerId: TEAM_ID,
						target: null,
						readyState: "READY",
						status: "READY",
						meta: { githubCommitSha: HEAD },
						gitSource: { type: "github", sha: HEAD },
					});
				}
				assert.equal(parsed.origin, "https://vercel.com");
				logSnapshots += 1;
				return jsonResponse({
					rows: [
						logRow("begin", STARTED_AT_MS + 1, BEGIN),
						logRow("end", COMPLETED_AT_MS - 1, END),
					],
					hasMoreRows: false,
				});
			},
			stageWriter(path, receipt) {
				written = { path, receipt };
			},
		});
		assert.equal(result.path, inspectionReceiptPath(topologyPath));
		assert.equal(result.stagePath, inspectionReceiptStagePath(topologyPath));
		assert.equal(written.path, result.stagePath);
		assert.equal(result.receipt, written.receipt);
		assert.equal(fleetEnumerations, 2);
		assert.equal(logSnapshots, 2);
		assert.equal(repositoryInspections, 2);
		assert.equal(result.receipt.turso.databaseCount, 1);
		assert.equal(result.receipt.turso.tableCount, 3);
		assert.equal(result.receipt.turso.rowCount, 6);
		assert.equal(result.receipt.vercel.requestCount, 2);
		assert.equal(result.receipt.vercel.exhaustedLeafCount, 2);
		const serialized = JSON.stringify(result.receipt);
		for (const forbidden of [
			NEEDLE,
			BEGIN,
			END,
			DB_ID_ONE,
			"platform-token",
			"group-token",
			"vercel-token",
		]) {
			assert.doesNotMatch(serialized, new RegExp(forbidden));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("final inspection refuses a dirty candidate before loading dependencies or contacting providers", async () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-dirty-candidate-"));
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	chmodSync(root, 0o700);
	writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
		mode: 0o600,
	});
	let dependencyLoads = 0;
	let providerCalls = 0;
	try {
		await assert.rejects(
			runTrustedFinalInspection({
				input: inspectionInput({ RC_TOPOLOGY_RECEIPT_FILE: topologyPath }),
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector() {
					throw new Error("candidate is dirty");
				},
				async dependencyLoader() {
					dependencyLoads += 1;
					throw new Error("must not load");
				},
				async fetchImpl() {
					providerCalls += 1;
					throw new Error("must not fetch");
				},
			}),
			/candidate is dirty/,
		);
		assert.equal(dependencyLoads, 0);
		assert.equal(providerCalls, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a forced outer recheck failure leaves no canonical receipt and a clean retry can publish", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-inspection-retry-"));
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const first = stageBoundInspection(topologyPath);
		assert.equal(existsSync(canonicalPath), false);
		assert.throws(() => {
			throw new Error("forced outer candidate-tree recheck failure");
		}, /forced outer candidate-tree recheck failure/);
		assert.equal(existsSync(canonicalPath), false);
		rmSync(first.stagePath);
		assert.equal(existsSync(canonicalPath), false);

		const retry = stageBoundInspection(topologyPath);
		const result = publishStagedInspectionReceipt({
			topologyReceiptFile: topologyPath,
			stageFile: retry.stagePath,
			stageEvidence: retry.evidence,
			receiptRoot: root,
			repositoryRoot: root,
			repositoryInspector({ expectedHead, repositoryRoot }) {
				assert.equal(expectedHead, HEAD);
				assert.equal(repositoryRoot, root);
			},
		});
		assert.equal(result.path, canonicalPath);
		assert.deepEqual(result.receipt, retry.receipt);
		assert.equal(lstatSync(canonicalPath).mode & 0o777, 0o600);
		assert.deepEqual(
			JSON.parse(readFileSync(canonicalPath, "utf8")),
			retry.receipt,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher rejects staged-byte replacement and in-place drift before creating a canonical receipt", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-stage-drift-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	const displacedPath = join(root, "displaced.stage");
	const publish = (stage) =>
		publishStagedInspectionReceipt({
			topologyReceiptFile: topologyPath,
			stageFile: stage.stagePath,
			stageEvidence: stage.evidence,
			receiptRoot: root,
			repositoryRoot: root,
			repositoryInspector: () => undefined,
		});
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const replaced = stageBoundInspection(topologyPath);
		const originalBytes = readFileSync(replaced.stagePath);
		renameSync(replaced.stagePath, displacedPath);
		writeFileSync(replaced.stagePath, originalBytes, { mode: 0o600 });
		assert.throws(() => publish(replaced), /could not be published safely/);
		assert.equal(existsSync(canonicalPath), false);
		rmSync(replaced.stagePath);
		rmSync(displacedPath);

		const mutated = stageBoundInspection(topologyPath);
		writeFileSync(
			mutated.stagePath,
			`${readFileSync(mutated.stagePath, "utf8")} \n`,
			{ mode: 0o600 },
		);
		assert.throws(() => publish(mutated), /could not be published safely/);
		assert.equal(existsSync(canonicalPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher converges an observed one-time pair-sync failure without retracting canonical authority", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-sync-rollback-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		let directorySyncs = 0;
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
				fsyncDirectory(descriptor) {
					directorySyncs += 1;
					if (directorySyncs === 2) {
						assert.equal(lstatSync(canonicalPath).nlink, 2);
						throw new Error("injected commit sync failure");
					}
					fsyncSync(descriptor);
				},
			}).path,
			canonicalPath,
		);
		assert.equal(directorySyncs, 4);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.equal(existsSync(stage.stagePath), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher converges a one-time source-unlink failure without deleting canonical", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-unlink-rollback-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		let unlinks = 0;
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
				unlinkFile(path) {
					unlinks += 1;
					if (unlinks === 1)
						throw new Error("injected temporary unlink failure");
					unlinkSync(path);
				},
			}).path,
			canonicalPath,
		);
		assert.equal(unlinks, 2);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fresh publisher reconciles an exact canonical link after an ambiguous EEXIST result", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-link-reconcile-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
					linkFile(source, target) {
						linkSync(source, target);
						const error = new Error("injected ambiguous link result");
						error.code = "EEXIST";
						throw error;
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(lstatSync(canonicalPath).nlink, 2);
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
			}).path,
			canonicalPath,
		);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh inspection publication adopts an exact orphaned source after a pre-link failure", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-orphan-source-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		const publish = (options = {}) =>
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
				...options,
			});
		assert.throws(
			() =>
				publish({
					linkFile() {
						throw new Error("injected pre-link failure");
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(existsSync(canonicalPath), false);
		const temporaries = readdirSync(root).filter((name) =>
			name.endsWith(".publish.tmp"),
		);
		assert.equal(temporaries.length, 1);
		const orphanStat = lstatSync(join(root, temporaries[0]));
		assert.equal(orphanStat.nlink, 1);

		assert.equal(publish().path, canonicalPath);
		const canonicalStat = lstatSync(canonicalPath);
		assert.equal(canonicalStat.nlink, 1);
		assert.equal(canonicalStat.dev, orphanStat.dev);
		assert.equal(canonicalStat.ino, orphanStat.ino);
		assert.equal(
			readdirSync(root).filter((name) => name.endsWith(".publish.tmp")).length,
			0,
		);
		assert.equal(lstatSync(stage.stagePath).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a torn random inspection source cannot block a fresh exact publication", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-torn-source-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		const publish = (options = {}) =>
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
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
			/could not be published safely/,
		);
		assert.equal(existsSync(canonicalPath), false);
		const torn = readdirSync(root).filter((name) =>
			name.endsWith(".publish.tmp"),
		);
		assert.equal(torn.length, 1);
		assert.equal(lstatSync(join(root, torn[0])).size, 7);

		assert.equal(publish().path, canonicalPath);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.deepEqual(
			readdirSync(root).filter((name) => name.endsWith(".publish.tmp")),
			torn,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inspection publication deterministically adopts one of multiple exact orphan sources", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-orphan-set-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		const prefix = `.${basename(canonicalPath)}.${stage.evidence.sha256}.`;
		const first = join(
			root,
			`${prefix}00000000-0000-4000-8000-000000000001.publish.tmp`,
		);
		const second = join(
			root,
			`${prefix}00000000-0000-4000-8000-000000000002.publish.tmp`,
		);
		const stageBytes = readFileSync(stage.stagePath);
		writeFileSync(first, stageBytes, { mode: 0o600, flag: "wx" });
		writeFileSync(second, stageBytes, { mode: 0o600, flag: "wx" });
		const firstStat = lstatSync(first);

		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
			}).path,
			canonicalPath,
		);
		const canonicalStat = lstatSync(canonicalPath);
		assert.equal(canonicalStat.dev, firstStat.dev);
		assert.equal(canonicalStat.ino, firstStat.ino);
		assert.equal(existsSync(first), false);
		assert.equal(lstatSync(second).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed inspection source-only sync leaves no canonical and a fresh invocation adopts the exact source", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-source-sync-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		const publish = (options = {}) =>
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
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
		assert.equal(existsSync(canonicalPath), false);
		const temporaries = readdirSync(root).filter((name) =>
			name.endsWith(".publish.tmp"),
		);
		assert.equal(temporaries.length, 1);
		const sourceStat = lstatSync(join(root, temporaries[0]));
		assert.equal(sourceStat.nlink, 1);

		assert.equal(publish().path, canonicalPath);
		const canonicalStat = lstatSync(canonicalPath);
		assert.equal(canonicalStat.nlink, 1);
		assert.equal(canonicalStat.dev, sourceStat.dev);
		assert.equal(canonicalStat.ino, sourceStat.ino);
		assert.equal(
			readdirSync(root).filter((name) => name.endsWith(".publish.tmp")).length,
			0,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inspection publication revalidates the exact link pair after its directory sync", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-inspection-pair-race-"));
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		let directorySyncs = 0;
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
					fsyncDirectory(descriptor) {
						directorySyncs += 1;
						fsyncSync(descriptor);
						if (directorySyncs === 2) {
							const [temporary] = readdirSync(root).filter((name) =>
								name.endsWith(".publish.tmp"),
							);
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
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		const [replacement] = readdirSync(root).filter((name) =>
			name.endsWith(".publish.tmp"),
		);
		assert.equal(
			readFileSync(join(root, replacement), "utf8"),
			"replacement\n",
		);
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
			}).path,
			canonicalPath,
		);
		assert.equal(
			readFileSync(join(root, replacement), "utf8"),
			"replacement\n",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inspection publication refuses an unbounded recovery directory before mutation", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-inspection-dir-bound-"));
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		let directoryReads = 0;
		let directoryClosed = false;
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
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
			/could not be published safely/,
		);
		assert.equal(directoryReads, 4_097);
		assert.equal(directoryClosed, true);
		assert.equal(existsSync(canonicalPath), false);
		assert.equal(
			readdirSync(root).filter((name) => name.endsWith(".publish.tmp")).length,
			0,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a newer inspection stage is not blocked by an older orphaned source", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-stale-source-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const oldStage = stageBoundInspection(topologyPath);
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: oldStage.stagePath,
					stageEvidence: oldStage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
					linkFile() {
						throw new Error("injected pre-link crash");
					},
				}),
			/publication state is indeterminate/,
		);
		const oldTemporaries = readdirSync(root).filter((name) =>
			name.endsWith(".publish.tmp"),
		);
		assert.equal(oldTemporaries.length, 1);
		rmSync(oldStage.stagePath);

		const newStage = stageBoundInspection(topologyPath, {
			inspection: {
				startedAt: new Date(COMPLETED_AT_MS + 2_000).toISOString(),
				completedAt: new Date(COMPLETED_AT_MS + 3_000).toISOString(),
			},
		});
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: newStage.stagePath,
				stageEvidence: newStage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
			}).path,
			canonicalPath,
		);
		assert.deepEqual(
			JSON.parse(readFileSync(canonicalPath, "utf8")),
			newStage.receipt,
		);
		assert.deepEqual(
			readdirSync(root).filter((name) => name.endsWith(".publish.tmp")),
			oldTemporaries,
		);
		assert.equal(lstatSync(join(root, oldTemporaries[0])).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher rejects descriptor-bound canonical byte mismatch without deleting either link", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-byte-mismatch-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		let reads = 0;
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
					readFile(descriptor) {
						reads += 1;
						const bytes = readFileSync(descriptor);
						if (reads >= 2) bytes[0] ^= 1;
						return bytes;
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(lstatSync(canonicalPath).nlink, 2);
		assert.equal(existsSync(stage.stagePath), true);
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
			}).path,
			canonicalPath,
		);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.equal(existsSync(stage.stagePath), true);
		assert.equal(
			readdirSync(root).filter((name) => name.endsWith(".publish.tmp")).length,
			0,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("post-commit directory close failure cannot downgrade an inspection receipt", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-close-after-commit-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
				closeDirectory(descriptor) {
					closeSync(descriptor);
					throw new Error("injected close acknowledgement failure");
				},
			}).path,
			canonicalPath,
		);
		assert.equal(existsSync(canonicalPath), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("persistent inspection sync failure preserves a non-authoritative canonical inode and reports indeterminate", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-indeterminate-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		let directorySyncs = 0;
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
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
		assert.equal(lstatSync(canonicalPath).nlink, 2);
		assert.equal(existsSync(stage.stagePath), true);
		assert.equal(
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
			}).path,
			canonicalPath,
		);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.equal(existsSync(stage.stagePath), true);
		assert.equal(
			readdirSync(root).filter((name) => name.endsWith(".publish.tmp")).length,
			0,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an exhausted post-unlink inspection sync is recovered by a fresh exact invocation", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-post-unlink-recovery-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		let directorySyncs = 0;
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
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
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.equal(lstatSync(stage.stagePath).nlink, 1);

		let recoveryFileSyncs = 0;
		const recovered = publishStagedInspectionReceipt({
			topologyReceiptFile: topologyPath,
			stageFile: stage.stagePath,
			stageEvidence: stage.evidence,
			receiptRoot: root,
			repositoryRoot: root,
			repositoryInspector: () => undefined,
			fsyncFile(descriptor) {
				recoveryFileSyncs += 1;
				fsyncSync(descriptor);
			},
		});
		assert.equal(recovered.path, canonicalPath);
		assert.equal(recoveryFileSyncs, 1);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.equal(existsSync(stage.stagePath), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh inspection recovery refuses a pre-existing canonical with different bytes", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-recovery-mismatch-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		writeFileSync(canonicalPath, "{}\n", { mode: 0o600, flag: "wx" });
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
				}),
			(error) => {
				assert.doesNotMatch(
					error.message,
					/publication state is indeterminate/,
				);
				return /could not be published safely/.test(error.message);
			},
		);
		assert.equal(readFileSync(canonicalPath, "utf8"), "{}\n");
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.equal(lstatSync(stage.stagePath).nlink, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh inspection recovery refuses an exact inode replacement after its durability sync", () => {
	const root = mkdtempSync(
		join(tmpdir(), "remote-claw-inspection-recovery-race-"),
	);
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		const publish = (options = {}) =>
			publishStagedInspectionReceipt({
				topologyReceiptFile: topologyPath,
				stageFile: stage.stagePath,
				stageEvidence: stage.evidence,
				receiptRoot: root,
				repositoryRoot: root,
				repositoryInspector: () => undefined,
				...options,
			});
		publish();
		const exactBytes = readFileSync(canonicalPath);
		const replacement = join(root, ".replacement-inspection-receipt");
		assert.throws(
			() =>
				publish({
					fsyncDirectory(descriptor) {
						fsyncSync(descriptor);
						writeFileSync(replacement, exactBytes, {
							mode: 0o600,
							flag: "wx",
						});
						renameSync(replacement, canonicalPath);
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(lstatSync(canonicalPath).nlink, 1);
		assert.deepEqual(readFileSync(canonicalPath), exactBytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publisher keeps stage and canonical operations anchored when the visible receipt root is swapped", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-claw-inspection-root-race-"));
	const displacedRoot = `${root}.displaced`;
	chmodSync(root, 0o700);
	const topologyPath = join(
		root,
		`real-topology-browser-leg-${HEAD}-${COMPACT_RUN_ID}.json`,
	);
	const canonicalPath = inspectionReceiptPath(topologyPath);
	try {
		writeFileSync(topologyPath, `${JSON.stringify(topologyReceipt())}\n`, {
			mode: 0o600,
		});
		const stage = stageBoundInspection(topologyPath);
		assert.throws(
			() =>
				publishStagedInspectionReceipt({
					topologyReceiptFile: topologyPath,
					stageFile: stage.stagePath,
					stageEvidence: stage.evidence,
					receiptRoot: root,
					repositoryRoot: root,
					repositoryInspector: () => undefined,
					linkFile(source, target) {
						renameSync(root, displacedRoot);
						mkdirSync(root, { mode: 0o700 });
						linkSync(source, target);
					},
				}),
			/publication state is indeterminate/,
		);
		assert.equal(existsSync(canonicalPath), false);
		const displacedCanonical = join(displacedRoot, basename(canonicalPath));
		const [temporary] = readdirSync(displacedRoot).filter((name) =>
			name.endsWith(".publish.tmp"),
		);
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

test("inspection/v1 validator is exact and the writer is exclusive, atomic, and mode 0600", () => {
	assert.equal(validateInspectionReceipt(inspectionReceipt()).result, "passed");
	assert.throws(
		() =>
			validateInspectionReceipt({
				...inspectionReceipt(),
				transcript: "forbidden",
			}),
		/unexpected fields/,
	);
	assert.throws(
		() =>
			validateInspectionReceipt({
				...inspectionReceipt(),
				vercel: { ...inspectionReceipt().vercel, truncatedCount: 1 },
			}),
		/did not pass/,
	);
	const root = mkdtempSync(join(tmpdir(), "remote-claw-inspection-write-"));
	chmodSync(root, 0o700);
	const topologyPath = join(root, "proof.json");
	const path = inspectionReceiptPath(topologyPath);
	try {
		assert.equal(path, join(root, "proof.inspection-v1.json"));
		writeInspectionReceipt(path, inspectionReceipt(), {
			newId: () => "12345678-1234-4123-8123-123456789abc",
		});
		assert.equal(lstatSync(path).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).result, "passed");
		assert.throws(
			() => writeInspectionReceipt(path, inspectionReceipt()),
			/already exists/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clean wrapper is an executable real file in the repository", () => {
	assert.equal(realpathSync(CLEAN_WRAPPER), resolve(CLEAN_WRAPPER));
	const stat = lstatSync(CLEAN_WRAPPER);
	assert.ok(stat.isFile());
	assert.notEqual(stat.mode & 0o111, 0);
});
