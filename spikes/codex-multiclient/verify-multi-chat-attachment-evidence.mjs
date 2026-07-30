#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertCapturedAt,
	assertNoCredentialEnvironmentNames,
	assertNoHostPaths,
	assertUniqueIdentifiers,
	EXPECTED_CODEX_BINARY_SHA256,
	EXPECTED_ISOLATED_ENVIRONMENT_NAMES,
	NAMESPACE_ID_PATTERN,
	outputRecord,
	SELECTED_PROJECTION_METHODS,
	UUID_PATTERN,
} from "./evidence-assertions.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const probePath = join(root, "multi-chat-attachment-probe.mjs");
const evidencePath = join(root, "evidence-multi-chat-attachment-0.146.0.json");
const EXPECTED_PROBE_SHA256 =
	"f1f6a14c69a1d8650cbc6519c129d7afc50e96c43e968d9866952615569065ba";
const EXPECTED_COMMANDS = [
	{
		absent: ["TUI_B", "HOST"],
		command: "printf codex-multi-chat-thread-a-before-host-join",
		expected: ["TUI_A"],
		label: "thread-A-before-host-join",
		output: "codex-multi-chat-thread-a-before-host-join",
		sender: "TUI_A",
		thread: "threadA",
	},
	{
		absent: ["TUI_A", "HOST"],
		command: "printf codex-multi-chat-thread-b-before-host-join",
		expected: ["TUI_B"],
		label: "thread-B-before-host-join",
		output: "codex-multi-chat-thread-b-before-host-join",
		sender: "TUI_B",
		thread: "threadB",
	},
	{
		absent: ["TUI_B"],
		command: "printf codex-multi-chat-thread-a-after-host-join",
		expected: ["TUI_A", "HOST"],
		label: "thread-A-after-host-join",
		output: "codex-multi-chat-thread-a-after-host-join",
		sender: "TUI_A",
		thread: "threadA",
	},
	{
		absent: ["TUI_A"],
		command: "printf codex-multi-chat-thread-b-after-host-join",
		expected: ["TUI_B", "HOST"],
		label: "thread-B-after-host-join",
		output: "codex-multi-chat-thread-b-after-host-join",
		sender: "TUI_B",
		thread: "threadB",
	},
];

const [probeBytes, evidenceBytes] = await Promise.all([
	readFile(probePath),
	readFile(evidencePath),
]);
const evidenceText = evidenceBytes.toString("utf8");
const evidence = JSON.parse(evidenceText);
const probeSha256 = createHash("sha256").update(probeBytes).digest("hex");

assertNoHostPaths(evidenceText);
assert.equal(evidence.probe.file, "multi-chat-attachment-probe.mjs");
assert.equal(probeSha256, EXPECTED_PROBE_SHA256, "multi-chat probe drifted");
assert.equal(
	evidence.probe.sha256,
	EXPECTED_PROBE_SHA256,
	"multi-chat evidence names a different probe",
);
assert.match(evidence.probe.nodeVersion, /^v22\./);
assertCapturedAt(evidence.capturedAt);
assert.match(evidence.proofScope, /ordinary top-level thread\/start behavior/);
assert.match(evidence.scopeBoundary, /does not exercise.*ThreadSpawn/);

assert.deepEqual(
	{
		appServerProcessCount: evidence.codex.appServerProcessCount,
		binarySha256: evidence.codex.binarySha256,
		version: evidence.codex.version,
	},
	{
		appServerProcessCount: 1,
		binarySha256: EXPECTED_CODEX_BINARY_SHA256,
		version: "codex-cli 0.146.0",
	},
);
assert.equal(evidence.codex.platform, "linux");
assert.equal(evidence.codex.architecture, "arm64");
assert.equal(evidence.codex.binaryPath, "<codex-binary>");

assert.deepEqual(Object.keys(evidence.clients).sort(), [
	"HOST",
	"TUI_A",
	"TUI_B",
]);
for (const [label, client] of Object.entries(evidence.clients)) {
	assert.equal(client.connectionOpenCount, 1, `${label} connection count`);
	assert.equal(client.initializeRequestId, 1, `${label} initialize ID`);
	assert.equal(
		client.role,
		label === "HOST" ? "hostObserver" : "directClientStandIn",
	);
}
assert.equal(evidence.clients.TUI_A.name, "remote-claw-proof-direct-tui-a");
assert.equal(evidence.clients.TUI_B.name, "remote-claw-proof-direct-tui-b");
assert.equal(evidence.clients.HOST.name, "remote-claw-proof-host-observer");
assert.equal(
	new Set(Object.values(evidence.clients).map((client) => client.name)).size,
	3,
);
assert.equal(evidence.clients.TUI_A.resumeRequestsSent, 0);
assert.equal(evidence.clients.TUI_B.resumeRequestsSent, 0);
assert.equal(evidence.clients.HOST.resumeRequestsSent, 2);

const threadA = evidence.threads.threadA.id;
const threadB = evidence.threads.threadB.id;
assert.match(threadA, UUID_PATTERN);
assert.match(threadB, UUID_PATTERN);
assert.equal(evidence.threads.threadA.startedBy, "TUI_A");
assert.equal(evidence.threads.threadB.startedBy, "TUI_B");
assert.equal(evidence.threads.threadA.persistent, true);
assert.equal(evidence.threads.threadB.persistent, true);
assert.equal(evidence.threads.distinctIds, true);
assert.notEqual(threadA, threadB);
assert.equal(evidence.clients.TUI_A.startedThread, threadA);
assert.equal(evidence.clients.TUI_B.startedThread, threadB);
assert.equal(evidence.clients.HOST.startedThread, null);
assert.deepEqual(evidence.hostJoin, {
	resumedThreadIds: [threadA, threadB],
	sameNativeThreadIds: true,
});

assert.equal(evidence.commands.length, EXPECTED_COMMANDS.length);
for (const [index, expected] of EXPECTED_COMMANDS.entries()) {
	const command = evidence.commands[index];
	const threadId = evidence.threads[expected.thread].id;
	assert.equal(command.label, expected.label);
	assert.equal(command.sentBy, expected.sender);
	assert.equal(command.requestedCommand, expected.command);
	assert.equal(command.nativeCommand, `/usr/bin/zsh -lc '${expected.command}'`);
	assert.equal(command.threadId, threadId);
	assert.deepEqual(command.expectedOutput, outputRecord(expected.output));
	assert.match(command.turnId, UUID_PATTERN);
	assert.match(command.itemId, UUID_PATTERN);
	assert.deepEqual(command.expectedObserverLabels, expected.expected);
	assert.deepEqual(command.absentObserverLabels, expected.absent);
	assert.equal(command.orderedExpectedProjectionsEqual, true);
	assert.deepEqual(
		command.nativeNotSubscribedResponseFences,
		Object.fromEntries(
			expected.absent.map((label) => [label, "notSubscribed"]),
		),
	);
	assert.deepEqual(Object.keys(command.observations).sort(), [
		"HOST",
		"TUI_A",
		"TUI_B",
	]);

	const canonical = command.observations[expected.expected[0]];
	assert.equal(canonical.length, 5, `${expected.label} canonical projection`);
	for (const label of expected.expected) {
		const projection = command.observations[label];
		assert.deepEqual(projection, canonical, `${expected.label} ${label}`);
		verifyProjection(projection, command);
	}
	for (const label of expected.absent) {
		assert.deepEqual(
			command.observations[label],
			[],
			`${expected.label} ${label} absence`,
		);
	}
}
assertUniqueIdentifiers([
	threadA,
	threadB,
	...evidence.commands.flatMap((command) => [command.turnId, command.itemId]),
]);

assert.deepEqual(evidence.finalNativeAttachmentStatus, {
	threadA: {
		HOST: "unsubscribed",
		TUI_A: "unsubscribed",
		TUI_B: "notSubscribed",
	},
	threadB: {
		HOST: "unsubscribed",
		TUI_A: "notSubscribed",
		TUI_B: "unsubscribed",
	},
});
assert.deepEqual(evidence.directClientCrossThreadObservations, {
	TUI_A_received_threadB_selected_projection: false,
	TUI_B_received_threadA_selected_projection: false,
});
assert.equal(evidence.hostObserverReceivedBothThreads, true);
assert.deepEqual(evidence.fixtureConclusion, {
	hostAndOwningDirectClientReceivedEqualSelectedProjections: true,
	hostObserverCanExplicitlySubscribeToBothNativeThreads: true,
	nonOwningDirectClientReceivedSelectedEvents: false,
	nonOwningDirectClientRemainedUnsubscribedAfterHostJoin: true,
	ordinaryTopLevelThreadStartAttachedEveryInitializedConnection: false,
});
assert.deepEqual(evidence.inference, {
	directClientsSentNoResume: true,
	hostResumeRequestsSent: 2,
	probeIssuedModelPrompt: false,
	turnStartRequestsSent: 0,
});

for (const threadLabel of ["threadA", "threadB"]) {
	assert.deepEqual(evidence.deletion[threadLabel], {
		error: {
			code: -32600,
			message: "thread not loaded: <deleted-thread>",
		},
		nativeDeleteAcknowledged: true,
		readAfterDeleteFailed: true,
	});
}

assert.equal(evidence.isolation.mode, "unprivileged-user-net");
assert.match(evidence.isolation.parentNamespace, NAMESPACE_ID_PATTERN);
assert.match(evidence.isolation.probeNamespace, NAMESPACE_ID_PATTERN);
assert.notEqual(
	evidence.isolation.parentNamespace,
	evidence.isolation.probeNamespace,
);
assert.equal(evidence.isolation.distinctNetworkNamespace, true);
assert.deepEqual(evidence.isolation.interfaces, ["lo"]);
assert.equal(evidence.isolation.defaultRoutePresent, false);
assert.equal(evidence.isolation.externalRouteAvailable, false);
assert.equal(evidence.isolation.temporaryCodexHomeInitiallyEmpty, true);
assert.equal(evidence.isolation.temporaryUserHomeInitiallyEmpty, true);
assert.equal(evidence.isolation.ambientCodexHomeInherited, false);
assert.equal(evidence.isolation.ambientCredentialEnvironmentInherited, false);
assert.equal(evidence.isolation.ambientProxyBypassInherited, false);
assert.equal(evidence.isolation.ambientUserHomeInherited, false);
assert.equal(evidence.isolation.ambientUserStartupDirectoryInherited, false);
assert.equal(evidence.isolation.localDenyProxyConnectionAttempts, 2);
assert.deepEqual(
	evidence.isolation.appServerEnvironmentVariableNames,
	EXPECTED_ISOLATED_ENVIRONMENT_NAMES,
);
assertNoCredentialEnvironmentNames(
	evidence.isolation.appServerEnvironmentVariableNames,
);
assert.deepEqual(evidence.cleanup, {
	allClientSocketsClosed: true,
	appServerExit: {
		code: 0,
		forced: false,
		signal: null,
	},
	nativeThreadsDeleted: true,
	temporaryRootRemoved: true,
});

console.log(
	"PASS multi-chat attachment evidence: non-owners stay notSubscribed and lack selected correlated events until one host observer explicitly resumes both top-level threads",
);

function verifyProjection(projection, command) {
	assert.deepEqual(
		projection.map((event) => event.method),
		SELECTED_PROJECTION_METHODS,
	);
	for (const event of projection) {
		assert.equal(event.threadId, command.threadId);
		assert.equal(event.turnId, command.turnId);
		if (event.itemId !== undefined) {
			assert.equal(event.itemId, command.itemId);
		}
	}
	assert.equal(projection[0].status, "inProgress");
	assert.equal(projection[1].command, command.nativeCommand);
	assert.equal(projection[1].status, "inProgress");
	verifyEncoding(projection[2].delta);
	assert.equal(projection[2].delta.utf8, command.expectedOutput.utf8);
	assert.equal(projection[3].command, command.nativeCommand);
	assert.equal(projection[3].status, "completed");
	assert.equal(projection[3].exitCode, 0);
	verifyEncoding(projection[3].aggregatedOutput);
	assert.deepEqual(projection[3].aggregatedOutput, command.expectedOutput);
	assert.equal(projection[4].status, "completed");
}

function verifyEncoding(encoded) {
	const bytes = Buffer.from(encoded.base64, "base64");
	assert.equal(bytes.length, encoded.byteLength);
	assert.equal(bytes.toString("utf8"), encoded.utf8);
}
