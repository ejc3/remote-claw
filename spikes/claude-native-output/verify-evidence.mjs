#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const EXPECTED_PROBE_SHA256 =
	"a0c9fa97ea7f70a0dbfd2aaf18c1f25a40992380c603840ede94d24c9c2d9375";
const EXPECTED_COVERAGE_SHA256 =
	"31802152069f52e1035ae5c24bfb7cbafa1eaec190e71f41e783b97672add922";
const EXPECTED_RETRY_SHA256 =
	"291fb59dc9bf09ec5b8d96df06b9a169e54c3b16315ef485198addf27803d765";
const EXPECTED_BINARY_SHA256 =
	"a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177";
const EXPECTED_PACKAGE_MANIFEST_SHA256 =
	"8aa26c770a5bd5cf9ba8d0a815e291d9b12c278ad3a60ab96f7d71b5bd33508f";
const EXPECTED_SOURCE_COMMIT = "32256f4413ce35cb3a06c0db4dba1f41507dfecd";
const EXPECTED_RUNTIME_SOURCE_SHA256 = {
	"packages/cli/src/host/rc/mitm.ts":
		"ed86b0a4538d54ade11202018b7d54314da3f03e964222dc249541aadcb23db0",
	"packages/cli/src/host/rc/trace-run.ts":
		"13dac7375c67933ed19b2086f656d6e638e358b66e2e3f2586fc8d282b2757eb",
	"packages/cli/src/run.ts":
		"7254c8d1774d782c76133fbbc509b6943f13b123066a328ce99f342974769926",
};
const EXPECTED_CAPTURE_ROUTE_SOURCE_SHA256 = {
	"packages/cli/src/args.ts":
		"caf50576895a7bae84d2dcc33c88630f8c16f3b74cad63bcd27b1d120213dd86",
	"packages/cli/src/cli.ts":
		"958e6a3236cf0c4f37ff38a2d0445fe8bf8807bfa35514135df7e89e4623775f",
	...EXPECTED_RUNTIME_SOURCE_SHA256,
};
const EXPECTED_COVERAGE_COUNTS = {
	assistant: 5,
	control_cancel_request: 1,
	control_request: 1,
	control_response: 1,
	rate_limit_event: 1,
	result: 3,
	system: 13,
	user: 5,
};
const EXPECTED_RETRY_COUNTS = {
	assistant: 2,
	rate_limit_event: 1,
	result: 3,
	system: 7,
	user: 4,
};
const EXPECTED_TYPES = Object.keys(EXPECTED_COVERAGE_COUNTS);
const TOP_LEVEL_KEYS = [
	"proofSchemaId",
	"capturedAt",
	"proofScope",
	"scopeLimits",
	"probe",
	"remoteClaw",
	"claude",
	"protocol",
	"attempts",
	"payloadTypes",
	"firstArrivals",
	"lostResponseRetry",
	"sanitization",
	"diagnostics",
	"verdict",
];
const ATTEMPT_KEYS = [
	"attempt",
	"bodyBytes",
	"bodySha256",
	"downstreamHeadersSentBeforeReset",
	"downstreamRequestMatched",
	"downstreamWritableBytesBeforeReset",
	"events",
	"localResponseDisposition",
	"session",
	"upstreamResponseBytes",
	"upstreamResponseSha256",
	"upstreamStatus",
	"workerEpoch",
];
const EVENT_KEYS = [
	"coordinate",
	"payloadBytes",
	"payloadSha256",
	"topLevelKeys",
	"type",
	"uuidSyntax",
];

const [probeBytes, coverageBytes, retryBytes] = await Promise.all([
	readFile(new URL("./probe.mjs", import.meta.url)),
	readFile(new URL("./evidence-coverage-2.1.237.json", import.meta.url)),
	readFile(new URL("./evidence-retry-2.1.237.json", import.meta.url)),
]);
assert.equal(
	sha256(probeBytes),
	EXPECTED_PROBE_SHA256,
	"live proof probe bytes drifted",
);
assert.equal(
	sha256(coverageBytes),
	EXPECTED_COVERAGE_SHA256,
	"coordinate-coverage evidence bytes drifted",
);
assert.equal(
	sha256(retryBytes),
	EXPECTED_RETRY_SHA256,
	"lost-response retry evidence bytes drifted",
);
await Promise.all(
	Object.entries(EXPECTED_CAPTURE_ROUTE_SOURCE_SHA256).map(
		async ([relativePath, expectedHash]) => {
			const sourceBytes = await readFile(
				new URL(`../../${relativePath}`, import.meta.url),
			);
			assert.equal(
				sha256(sourceBytes),
				expectedHash,
				`captured trace route source drifted: ${relativePath}`,
			);
		},
	),
);

const coverageText = coverageBytes.toString("utf8");
const retryText = retryBytes.toString("utf8");
assertSanitized(coverageText);
assertSanitized(retryText);
const coverage = JSON.parse(coverageText);
const retry = JSON.parse(retryText);

for (const evidence of [coverage, retry]) {
	assert.deepEqual(Object.keys(evidence), TOP_LEVEL_KEYS);
	assert.equal(
		evidence.proofSchemaId,
		"remote-claw/retained-claude-native-output-proof/v2",
	);
	assert.match(evidence.capturedAt, /^2026-08-23T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.deepEqual(evidence.scopeLimits, {
		claudeProcessIdentityObserved: false,
		crossVersionClaim: false,
		nativeApplicationClaim: false,
		scenarioBound: true,
		serverDedupClaim: false,
		singleTraceWrapperRun: true,
	});
	assert.deepEqual(evidence.probe, {
		file: "probe.mjs",
		nodeVersion: "v22.23.2",
		sha256: EXPECTED_PROBE_SHA256,
		sourceCommit: EXPECTED_SOURCE_COMMIT,
	});
	assert.deepEqual(evidence.remoteClaw, {
		claudeCommandOverrideAbsent: true,
		runtimeSourceSha256: EXPECTED_RUNTIME_SOURCE_SHA256,
	});
	assert.deepEqual(evidence.claude, {
		architecture: "arm64",
		binaryBytes: 331864296,
		executableSha256: EXPECTED_BINARY_SHA256,
		launcherPath: "<claude-launcher>",
		packageManifestPath: "<claude-package-manifest>",
		packageManifestSha256: EXPECTED_PACKAGE_MANIFEST_SHA256,
		packageVersion: "2.1.237",
		platform: "linux",
		resolvedBinaryPath: "<claude-binary>",
		version: "2.1.237 (Claude Code)",
	});
	assert.deepEqual(evidence.protocol, {
		anthropicVersions: ["2023-06-01"],
		endpoint: "/v1/code/sessions/{id}/worker/events",
		requestBodyCapBytes: 1048576,
	});
	assert.deepEqual(evidence.sanitization, {
		conversationContentRetained: false,
		credentialValuesRetained: false,
		hostPathsRetained: false,
		nativeIdentifiersRetained: false,
		rawRequestBodiesWritten: false,
		rawResponseBodiesWritten: false,
	});
	assert.equal(evidence.diagnostics.bodyCapExceeded, false);
}

const coverageDerived = validateAttempts(coverage);
assert.equal(
	coverage.proofScope,
	"Claude native worker-event UUID presence and first-arrival uniqueness across stable text and question-control scenarios",
);
assert.equal(coverage.verdict, "event-coordinate-coverage-observed");
assert.deepEqual(coverage.payloadTypes, EXPECTED_COVERAGE_COUNTS);
assert.equal(coverage.attempts.length, 22);
assert.equal(coverageDerived.sessions.size, 1);
assert.deepEqual([...coverageDerived.sessions], ["session-1"]);
assert.equal(
	coverage.attempts.every(
		(attempt) => attempt.localResponseDisposition === "forwarded",
	),
	true,
);
assert.deepEqual(coverage.diagnostics, {
	attemptCount: 22,
	bodyCapExceeded: false,
	dropCompleted: false,
	matchedType: "__no_fault__",
	mode: "coordinate-coverage",
});
assert.deepEqual(coverage.lostResponseRetry, {
	completeRequestBodyByteEqual: false,
	downstreamHeadersSentBeforeReset: null,
	downstreamRequestMatched: false,
	downstreamWritableBytesBeforeReset: null,
	firstUpstreamResponseFullyBuffered: false,
	firstUpstreamResponseBytes: 0,
	firstUpstreamResponseSha256: "",
	firstUpstreamStatus: 0,
	exactRetryCount: 0,
	orderedPayloadTypesEqual: false,
	orderedPayloadUuidsEqual: false,
	noRetryObservationWindowMs: 0,
	noRetryRequiredWindowMs: 120000,
	noRetryWindowReached: false,
	postDropAttemptCount: 0,
	postDropNewEventCount: 0,
	postDropSameCoordinateCount: 0,
	postDropSameSemanticPayloadCount: 0,
	retryObserved: false,
	retryForwardedUpstream: false,
	retrySameRemoteSession: false,
	retryUpstreamStatus: null,
	workerEpochEqual: false,
	writeHeadIntercepted: false,
});

const retryDerived = validateAttempts(retry);
assert.equal(
	retry.proofScope,
	"Claude native worker-event UUID presence, uniqueness, and exact request-body retry after a lost accepted response",
);
assert.equal(retry.verdict, "retry-coordinate-preserved");
assert.deepEqual(retry.payloadTypes, EXPECTED_RETRY_COUNTS);
assert.equal(retry.attempts.length, 9);
assert.equal(retryDerived.sessions.size, 1);
assert.deepEqual([...retryDerived.sessions], ["session-1"]);
assert.deepEqual(retry.diagnostics, {
	attemptCount: 9,
	bodyCapExceeded: false,
	dropCompleted: true,
	matchedType: "assistant",
	mode: "lost-response-retry",
});

const resetAttempts = retry.attempts.filter(
	(attempt) => attempt.localResponseDisposition === "reset-before-headers",
);
assert.equal(resetAttempts.length, 1, "expected one faulted HTTP-200 response");
const dropped = resetAttempts[0];
assert.ok(dropped);
assert.equal(dropped.downstreamRequestMatched, true);
assert.equal(dropped.downstreamHeadersSentBeforeReset, false);
assert.equal(dropped.downstreamWritableBytesBeforeReset, 0);
assert.equal(dropped.upstreamStatus, 200);
assert.equal(dropped.upstreamResponseBytes > 0, true);
assert.match(dropped.upstreamResponseSha256, /^[0-9a-f]{64}$/);
assert.equal(
	dropped.events.some((event) => event.type === "assistant"),
	true,
	"faulted request did not contain an assistant event",
);
assert.equal(dropped.workerEpoch.present, true);

const exactRetries = retry.attempts.filter(
	(attempt) =>
		attempt.attempt > dropped.attempt &&
		attempt.localResponseDisposition === "forwarded" &&
		attempt.bodyBytes === dropped.bodyBytes &&
		attempt.bodySha256 === dropped.bodySha256,
);
assert.equal(exactRetries.length, 1, "expected one exact request retry");
const exactRetry = exactRetries[0];
assert.ok(exactRetry);
assert.deepEqual(exactRetry.events, dropped.events);
assert.equal(exactRetry.session, dropped.session);
assert.deepEqual(exactRetry.workerEpoch, dropped.workerEpoch);
assert.equal(exactRetry.upstreamStatus, 200);

const lost = retry.lostResponseRetry;
assert.equal(lost.firstUpstreamResponseFullyBuffered, true);
assert.equal(lost.firstUpstreamResponseBytes, dropped.upstreamResponseBytes);
assert.equal(lost.firstUpstreamResponseSha256, dropped.upstreamResponseSha256);
assert.equal(lost.firstUpstreamStatus, dropped.upstreamStatus);
assert.equal(
	lost.downstreamHeadersSentBeforeReset,
	dropped.downstreamHeadersSentBeforeReset,
);
assert.equal(lost.downstreamRequestMatched, dropped.downstreamRequestMatched);
assert.equal(
	lost.downstreamWritableBytesBeforeReset,
	dropped.downstreamWritableBytesBeforeReset,
);
assert.equal(lost.writeHeadIntercepted, true);
assert.equal(lost.retryObserved, true);
assert.equal(lost.exactRetryCount, exactRetries.length);
assert.equal(lost.completeRequestBodyByteEqual, true);
assert.equal(lost.orderedPayloadTypesEqual, true);
assert.equal(lost.orderedPayloadUuidsEqual, true);
assert.equal(lost.workerEpochEqual, true);
assert.equal(lost.retrySameRemoteSession, true);
assert.equal(lost.retryForwardedUpstream, true);
assert.equal(lost.retryUpstreamStatus, exactRetry.upstreamStatus);
assert.equal(lost.noRetryWindowReached, false);
assert.equal(lost.noRetryRequiredWindowMs, 120000);
for (const field of [
	"noRetryObservationWindowMs",
	"postDropAttemptCount",
	"postDropNewEventCount",
	"postDropSameCoordinateCount",
	"postDropSameSemanticPayloadCount",
]) {
	assert.equal(Number.isSafeInteger(lost[field]) && lost[field] >= 0, true);
}

process.stdout.write(
	"Claude 2.1.237 native-output witnesses independently verify coordinate coverage and lost-HTTP-200 retry\n",
);

function validateAttempts(evidence) {
	assert.equal(
		Array.isArray(evidence.attempts) && evidence.attempts.length > 0,
		true,
	);
	const coordinates = new Map();
	const typeCounts = new Map();
	const sessions = new Set();
	let collisionCount = 0;
	let previousAttempt = 0;

	for (const attempt of evidence.attempts) {
		assert.deepEqual(Object.keys(attempt), ATTEMPT_KEYS);
		assert.equal(
			Number.isSafeInteger(attempt.attempt) &&
				attempt.attempt > previousAttempt,
			true,
		);
		previousAttempt = attempt.attempt;
		assert.equal(
			Number.isSafeInteger(attempt.bodyBytes) && attempt.bodyBytes > 0,
			true,
		);
		assert.match(attempt.bodySha256, /^[0-9a-f]{64}$/);
		assert.match(attempt.session, /^session-[1-9]\d*$/);
		sessions.add(attempt.session);
		assert.equal(
			Number.isSafeInteger(attempt.upstreamResponseBytes) &&
				attempt.upstreamResponseBytes >= 0,
			true,
		);
		assert.match(attempt.upstreamResponseSha256, /^[0-9a-f]{64}$/);
		assert.equal(
			Number.isSafeInteger(attempt.upstreamStatus) &&
				attempt.upstreamStatus >= 100 &&
				attempt.upstreamStatus <= 599,
			true,
		);
		assert.deepEqual(Object.keys(attempt.workerEpoch), [
			"alias",
			"present",
			"type",
		]);
		assert.match(attempt.workerEpoch.alias, /^worker-epoch-[1-9]\d*$/);
		assert.equal(attempt.workerEpoch.present, true);
		assert.equal(attempt.workerEpoch.type, "number");

		if (attempt.localResponseDisposition === "forwarded") {
			assert.equal(attempt.downstreamHeadersSentBeforeReset, null);
			assert.equal(attempt.downstreamRequestMatched, null);
			assert.equal(attempt.downstreamWritableBytesBeforeReset, null);
		} else {
			assert.equal(attempt.localResponseDisposition, "reset-before-headers");
			assert.equal(attempt.downstreamHeadersSentBeforeReset, false);
			assert.equal(attempt.downstreamRequestMatched, true);
			assert.equal(attempt.downstreamWritableBytesBeforeReset, 0);
		}

		assert.equal(
			Array.isArray(attempt.events) && attempt.events.length > 0,
			true,
		);
		for (const event of attempt.events) {
			assert.deepEqual(Object.keys(event), EVENT_KEYS);
			assert.match(event.coordinate, /^uuid-[1-9]\d*$/);
			assert.equal(
				Number.isSafeInteger(event.payloadBytes) && event.payloadBytes > 0,
				true,
			);
			assert.match(event.payloadSha256, /^[0-9a-f]{64}$/);
			assert.equal(event.uuidSyntax, "uuid-v4");
			assert.equal(EXPECTED_TYPES.includes(event.type), true);
			assert.equal(
				Array.isArray(event.topLevelKeys) &&
					event.topLevelKeys.length > 0 &&
					event.topLevelKeys.every((key) => typeof key === "string"),
				true,
			);
			assert.deepEqual(
				event.topLevelKeys,
				[...new Set(event.topLevelKeys)].sort(),
			);
			assert.equal(event.topLevelKeys.includes("type"), true);
			assert.equal(event.topLevelKeys.includes("uuid"), true);

			const previous = coordinates.get(event.coordinate);
			if (previous === undefined) {
				coordinates.set(event.coordinate, {
					payloadSha256: event.payloadSha256,
					type: event.type,
				});
				typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
			} else if (previous.payloadSha256 !== event.payloadSha256) {
				collisionCount += 1;
			} else {
				assert.equal(previous.type, event.type);
			}
		}
	}

	const derivedCounts = Object.fromEntries([...typeCounts.entries()].sort());
	assert.deepEqual(evidence.payloadTypes, derivedCounts);
	assert.deepEqual(evidence.firstArrivals, {
		allPayloadUuidsRfc4122V4: true,
		coordinateCollisionCount: collisionCount,
		distinctPayloadUuidCount: coordinates.size,
		eventCount: coordinates.size,
		malformedWorkerBodies: 0,
	});
	assert.equal(evidence.diagnostics.attemptCount, evidence.attempts.length);
	return { coordinates, sessions };
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function assertSanitized(text) {
	assert.doesNotMatch(text, /\/(?:home|Users|tmp)\//);
	assert.doesNotMatch(text, /\b(?:cse|msg|req)_[A-Za-z0-9_-]+\b/);
	assert.doesNotMatch(
		text,
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
	);
	assert.doesNotMatch(text, /\bsk-ant-[A-Za-z0-9_-]+\b/i);
	assert.doesNotMatch(text, /\bBearer\s+[A-Za-z0-9._~-]+/i);
	assert.doesNotMatch(
		text,
		/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
	);
	assert.doesNotMatch(
		text,
		/RETRY-PROBE-OK|Should I proceed|AskUserQuestion tool/i,
	);
}
