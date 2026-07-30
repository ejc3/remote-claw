#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

const EXPECTED_RAW_PROBE_SHA256 =
	"539f92d9e72f3faf9b8abf41746f258cf8dcb346da96e0e6ae606d79fd746090";
const EXPECTED_TUI_PROBE_SHA256 =
	"698d2202c9dcaa5f1d5789fe11c7f8d27e35f430109cedd0bc6aeac3a703bc73";
const RAW_COMMANDS = [
	{
		label: "A-to-B",
		sentBy: "A",
		requestedCommand: "printf codex-multiclient-a-to-b",
		nativeCommand: "/usr/bin/zsh -lc 'printf codex-multiclient-a-to-b'",
		output: "codex-multiclient-a-to-b",
	},
	{
		label: "B-to-A",
		sentBy: "B",
		requestedCommand: "printf codex-multiclient-b-to-a",
		nativeCommand: "/usr/bin/zsh -lc 'printf codex-multiclient-b-to-a'",
		output: "codex-multiclient-b-to-a",
	},
];

const rawProbeUrl = new URL("./probe.mjs", import.meta.url);
const rawEvidenceUrl = new URL("./evidence-0.146.0.json", import.meta.url);
const tuiProbeUrl = new URL("./real-tui-probe.mjs", import.meta.url);
const tuiEvidenceUrl = new URL(
	"./evidence-real-tui-0.146.0.json",
	import.meta.url,
);

const [rawProbe, rawEvidenceText, tuiProbe, tuiEvidenceText] =
	await Promise.all([
		readFile(rawProbeUrl),
		readFile(rawEvidenceUrl, "utf8"),
		readFile(tuiProbeUrl),
		readFile(tuiEvidenceUrl, "utf8"),
	]);
const raw = JSON.parse(rawEvidenceText);
const tui = JSON.parse(tuiEvidenceText);

assertNoHostPaths(rawEvidenceText, tuiEvidenceText);
assertCapturedAt(raw.capturedAt);
assertCapturedAt(tui.capturedAt);
assert.equal(sha256(rawProbe), EXPECTED_RAW_PROBE_SHA256, "raw probe drifted");
assert.equal(
	raw.probe.sha256,
	EXPECTED_RAW_PROBE_SHA256,
	"raw evidence names a different probe",
);
assert.equal(
	sha256(tuiProbe),
	EXPECTED_TUI_PROBE_SHA256,
	"real-TUI probe drifted",
);
assert.equal(
	tui.probe.sha256,
	EXPECTED_TUI_PROBE_SHA256,
	"real-TUI evidence names a different probe",
);
assert.match(raw.probe.nodeVersion, /^v22\./);
assert.match(tui.probe.nodeVersion, /^v22\./);
assert.equal(raw.codex.version, "codex-cli 0.146.0");
assert.equal(tui.codex.version, "codex-cli 0.146.0");
assert.equal(raw.codex.binaryPath, "<codex-binary>");
assert.equal(
	raw.codex.binarySha256,
	EXPECTED_CODEX_BINARY_SHA256,
	"raw evidence uses a different Codex binary",
);
assert.equal(
	tui.codex.binarySha256,
	EXPECTED_CODEX_BINARY_SHA256,
	"real-TUI evidence uses a different Codex binary",
);
assert.equal(tui.codex.expectedBinarySha256, EXPECTED_CODEX_BINARY_SHA256);
for (const evidence of [raw, tui]) {
	assert.equal(evidence.codex.platform, "linux");
	assert.equal(evidence.codex.architecture, "arm64");
}

assert.deepEqual(raw.connections.A, {
	clientName: "remote-claw-probe-a",
	initializeRequestId: 1,
});
assert.deepEqual(raw.connections.B, {
	clientName: "remote-claw-probe-b",
	initializeRequestId: 1,
	initializedAfterThreadStart: true,
});
assert.notEqual(raw.connections.A.clientName, raw.connections.B.clientName);
assert.equal(raw.connections.B.initializedAfterThreadStart, true);
assert.equal(raw.connections.independentRequestIdOneAccepted, true);
assert.match(raw.thread.id, UUID_PATTERN);
assert.equal(raw.thread.persistent, true);
assert.equal(raw.thread.emptyResumeBeforeMaterialization.attemptedBy, "B");
assert.equal(raw.thread.emptyResumeBeforeMaterialization.rejected, true);
assert.equal(
	raw.thread.emptyResumeBeforeMaterialization.matchedPinnedNativeError,
	true,
);
assert.deepEqual(raw.thread.emptyResumeBeforeMaterialization.error, {
	code: -32600,
	message: "no rollout found for thread id <empty-thread>",
});
assert.equal(raw.thread.preResumeShellCommand.writeAccepted, true);
assert.equal(raw.thread.preResumeShellCommand.sentBy, "B");
assert.equal(
	raw.thread.preResumeShellCommand.requestedCommand,
	"printf codex-multiclient-pre-resume",
);
assert.equal(
	raw.thread.preResumeShellCommand.nativeCommand,
	"/usr/bin/zsh -lc 'printf codex-multiclient-pre-resume'",
);
assert.deepEqual(
	raw.thread.preResumeShellCommand.expectedOutput,
	outputRecord("codex-multiclient-pre-resume"),
);
assert.equal(raw.thread.preResumeShellCommand.threadId, raw.thread.id);
assert.match(raw.thread.preResumeShellCommand.turnId, UUID_PATTERN);
assert.match(raw.thread.preResumeShellCommand.itemId, UUID_PATTERN);
assert.equal(
	raw.thread.preResumeShellCommand.unresumedB
		.nativeSubscriptionStatusBeforeWrite,
	"notSubscribed",
);
assert.equal(
	raw.thread.preResumeShellCommand.unresumedB
		.nativeSubscriptionStatusAfterWrite,
	"notSubscribed",
);
assert.deepEqual(
	raw.thread.preResumeShellCommand.unresumedB.correlatedDetailedProjection,
	[],
);
assert.deepEqual(
	raw.thread.preResumeShellCommand.unresumedB.observedMethodsBeforeResume,
	[
		"response:4",
		"thread/status/changed",
		"thread/status/changed",
		"response:5",
	],
);
assertProjection(
	raw.thread.preResumeShellCommand.detailedObservationByA,
	raw.thread.id,
	{
		expectedCommand: "/usr/bin/zsh -lc 'printf codex-multiclient-pre-resume'",
		expectedOutput: outputRecord("codex-multiclient-pre-resume"),
	},
);
assert.equal(
	raw.thread.preResumeShellCommand.turnId,
	raw.thread.preResumeShellCommand.detailedObservationByA[0].turnId,
);
assert.equal(
	raw.thread.preResumeShellCommand.itemId,
	raw.thread.preResumeShellCommand.detailedObservationByA[1].itemId,
);
assert.equal(raw.thread.resumeAfterMaterialization.attemptedBy, "B");
assert.equal(raw.thread.resumeAfterMaterialization.requestedId, raw.thread.id);
assert.equal(raw.thread.resumeAfterMaterialization.returnedId, raw.thread.id);
assert.equal(raw.thread.resumeAfterMaterialization.sameThread, true);
assert.equal(
	raw.fixtureConclusion
		.shellCommandAcceptedBetweenNotSubscribedChecksWhileSelectedCorrelatedProjectionAbsent,
	true,
);
assert.equal(raw.commands.length, 2);
assert.deepEqual(
	raw.commands.map((command) => command.label),
	RAW_COMMANDS.map((command) => command.label),
);
for (const [index, command] of raw.commands.entries()) {
	const expected = RAW_COMMANDS[index];
	assert.ok(expected);
	assert.equal(command.sentBy, expected.sentBy);
	assert.equal(command.requestedCommand, expected.requestedCommand);
	assert.equal(command.nativeCommand, expected.nativeCommand);
	assert.deepEqual(command.expectedOutput, outputRecord(expected.output));
	assert.equal(command.threadId, raw.thread.id);
	assert.match(command.turnId, UUID_PATTERN);
	assert.match(command.itemId, UUID_PATTERN);
	assert.equal(command.orderedProjectionsEqual, true);
	assert.deepEqual(command.observations.A, command.observations.B);
	assertProjection(command.observations.A, command.threadId, {
		expectedCommand: expected.nativeCommand,
		expectedOutput: outputRecord(expected.output),
	});
	assert.equal(command.turnId, command.observations.A[0].turnId);
	assert.equal(command.itemId, command.observations.A[1].itemId);
}
assert.equal(
	raw.thread.preResumeShellCommand.unresumedB
		.absenceCheckedAfterPostResumeTurnId,
	raw.commands[1].turnId,
);
assertUniqueIdentifiers([
	raw.thread.id,
	raw.thread.preResumeShellCommand.turnId,
	raw.thread.preResumeShellCommand.itemId,
	...raw.commands.flatMap((command) => [command.turnId, command.itemId]),
]);
assert.deepEqual(raw.inference, {
	probeIssuedModelPrompt: false,
	turnStartRequestsSent: 0,
});
assertIsolation(raw.isolation, {
	denyAttemptField: "localDenyProxyConnectionAttempts",
	expectedDenyAttempts: 1,
	expectedMode: "unprivileged-user-net",
});
assert.equal(raw.isolation.temporaryCodexHomeInitiallyEmpty, true);
assert.equal(raw.isolation.temporaryUserHomeInitiallyEmpty, true);
assert.equal(raw.isolation.ambientCodexHomeInherited, false);
assert.equal(raw.isolation.ambientCredentialEnvironmentInherited, false);
assert.equal(raw.isolation.ambientProxyBypassInherited, false);
assert.equal(raw.isolation.ambientUserHomeInherited, false);
assert.equal(raw.isolation.ambientUserStartupDirectoryInherited, false);
assert.deepEqual(
	raw.isolation.appServerEnvironmentVariableNames,
	EXPECTED_ISOLATED_ENVIRONMENT_NAMES,
);
assertNoCredentialEnvironmentNames(
	raw.isolation.appServerEnvironmentVariableNames,
);
assert.equal(raw.deletion.nativeDeleteAcknowledged, true);
assert.equal(raw.deletion.readAfterDeleteFailed, true);
assert.deepEqual(raw.deletion.readAfterDeleteError, {
	code: -32600,
	message: "thread not loaded: <deleted-thread>",
});
assert.deepEqual(raw.cleanup, {
	appServerExit: {
		code: 0,
		forced: false,
		signal: null,
	},
	nativeThreadDeleted: true,
	temporaryRootRemoved: true,
});

assertIsolation(tui.isolation, {
	denyAttemptField: "denyProxyConnectionAttempts",
	expectedDenyAttempts: 25,
});
assert.equal(tui.temporaryHomes.serverCodexHomeInitiallyEmpty, true);
assert.equal(tui.temporaryHomes.tuiCodexHomeInitiallyEmpty, true);
assert.equal(tui.temporaryHomes.ambientCredentialsInherited, false);
assert.equal(tui.temporaryHomes.ambientAuthRead, false);
assert.equal(tui.temporaryHomes.syntheticAuth, true);
assert.equal(
	tui.temporaryHomes.syntheticAuthWrittenOnlyInsideTemporaryServerHome,
	true,
);
assert.equal(tui.temporaryHomes.externalRouteAvailable, false);
assert.deepEqual(
	tui.temporaryHomes.appServerEnvironmentVariableNames,
	EXPECTED_ISOLATED_ENVIRONMENT_NAMES,
);
assert.deepEqual(
	tui.temporaryHomes.tuiEnvironmentVariableNames,
	EXPECTED_ISOLATED_ENVIRONMENT_NAMES,
);
assertNoCredentialEnvironmentNames(
	tui.temporaryHomes.appServerEnvironmentVariableNames,
);
assertNoCredentialEnvironmentNames(
	tui.temporaryHomes.tuiEnvironmentVariableNames,
);
assert.equal(tui.appServer.spawnCount, 1);
assert.ok(Number.isSafeInteger(tui.appServer.pid) && tui.appServer.pid > 0);
assert.match(tui.appServer.transport, /^ws:\/\/127\.0\.0\.1:\d+$/);
assert.equal(tui.recorder.transparentPassThrough, true);
assert.equal(tui.recorder.tuiDownstreamConnectionCount, 1);
assert.equal(tui.recorder.appServerUpstreamConnectionCount, 1);
assert.equal(tui.connections.rawInitializeRequestId, 1);
assert.equal(tui.connections.tuiInitializeObserved, true);
assert.match(tui.thread.id, UUID_PATTERN);
assert.match(tui.thread.materializedTurnId, UUID_PATTERN);
assert.equal(tui.connections.tuiResumeRequestedThreadId, tui.thread.id);
assert.equal(tui.connections.tuiResumeReturnedThreadId, tui.thread.id);
const tuiExchanges = [
	{
		exchange: tui.rawToTui,
		expectedCommand: "/usr/bin/zsh -lc 'printf codex-raw-to-tui'",
		expectedOutput: "codex-raw-to-tui",
	},
	{
		exchange: tui.tuiToRaw,
		expectedCommand: "/usr/bin/zsh -lc 'printf codex-tui-to-raw'",
		expectedOutput: "codex-tui-to-raw",
	},
];
for (const { exchange, expectedCommand, expectedOutput } of tuiExchanges) {
	assert.equal(exchange.threadId, tui.thread.id);
	assert.match(exchange.turnId, UUID_PATTERN);
	assert.match(exchange.itemId, UUID_PATTERN);
	assert.equal(exchange.rawAndTuiNativeProjectionsEqual, true);
	assert.deepEqual(exchange.rawNativeProjection, exchange.tuiNativeProjection);
	assertProjection(exchange.rawNativeProjection, tui.thread.id, {
		expectedCommand,
		expectedOutput,
	});
	assert.equal(exchange.turnId, exchange.rawNativeProjection[0].turnId);
	assert.equal(exchange.itemId, exchange.rawNativeProjection[1].itemId);
	assert.equal(exchange.tuiPaneContainsMarker, true);
}
assert.equal(tui.rawToTui.requestedByRaw, true);
assert.equal(tui.tuiToRaw.requestObservedFromRealTui, true);
assert.equal(tui.tuiToRaw.tuiRequestId, 9);
assert.equal(tui.tui.unsubscribeRequestId, 10);
assertUniqueIdentifiers([
	tui.thread.id,
	tui.thread.materializedTurnId,
	tui.rawToTui.turnId,
	tui.rawToTui.itemId,
	tui.tuiToRaw.turnId,
	tui.tuiToRaw.itemId,
]);
assert.deepEqual(tui.modelSafety, {
	modelPromptSent: false,
	turnStartRequestsObserved: 0,
});
assert.equal(tui.tui.processExitStatus, 0);
assert.equal(tui.tui.unsubscribeStatus, "unsubscribed");
assert.match(tui.tui.sanitizedPaneExcerpt, /codex-raw-to-tui/);
assert.match(tui.tui.sanitizedPaneExcerpt, /codex-tui-to-raw/);
assert.equal(tui.deletion.nativeDeleteAcknowledged, true);
assert.equal(tui.deletion.readAfterDeleteFailed, true);
assert.deepEqual(tui.deletion.readAfterDeleteError, {
	code: -32600,
	message: "thread not loaded: <deleted-thread>",
});
assert.deepEqual(tui.cleanup, {
	appServerExit: {
		code: 0,
		forced: false,
		signal: null,
	},
	denyProxyClosed: true,
	denyProxyConnectionAttempts: 25,
	nativeThreadDeleted: true,
	nativeThreadDeletedDuringCleanup: false,
	rawClientClosed: true,
	syntheticAuthRemovedWithTemporaryRoot: true,
	temporaryRootRemoved: true,
	tmuxServerStopped: true,
	tmuxSocketDirectoryRemovedWithTemporaryRoot: true,
	tuiRecorderClosed: true,
});

console.log("Codex retained evidence: PASS");

function assertProjection(
	projection,
	threadId,
	{ expectedCommand, expectedOutput },
) {
	assert.equal(projection.length, SELECTED_PROJECTION_METHODS.length);
	assert.deepEqual(
		projection.map((event) => event.method),
		SELECTED_PROJECTION_METHODS,
	);
	assert.ok(projection.every((event) => event.threadId === threadId));
	const turnId = projection[0].turnId;
	assert.ok(turnId);
	assert.ok(projection.every((event) => event.turnId === turnId));
	assert.equal(projection[0].status, "inProgress");
	const itemEvents = projection.slice(1, 4);
	const itemId = itemEvents[0].itemId;
	assert.ok(itemId);
	assert.ok(itemEvents.every((event) => event.itemId === itemId));
	assert.equal(projection[1].command, expectedCommand);
	assert.equal(projection[1].status, "inProgress");
	assert.deepEqual(projection[2].delta, expectedOutput);
	assert.equal(projection[3].command, expectedCommand);
	assert.equal(projection[3].status, "completed");
	assert.equal(projection[3].exitCode, 0);
	assert.deepEqual(projection[3].aggregatedOutput, expectedOutput);
	assert.equal(projection[4].status, "completed");
}

function assertIsolation(
	isolation,
	{ denyAttemptField, expectedDenyAttempts, expectedMode },
) {
	if (expectedMode !== undefined) {
		assert.equal(isolation.mode, expectedMode);
	}
	assert.match(isolation.parentNamespace, NAMESPACE_ID_PATTERN);
	assert.match(isolation.probeNamespace, NAMESPACE_ID_PATTERN);
	assert.notEqual(isolation.parentNamespace, isolation.probeNamespace);
	assert.equal(isolation.distinctNetworkNamespace, true);
	assert.deepEqual(isolation.interfaces, ["lo"]);
	assert.equal(isolation.defaultRoutePresent, false);
	assert.equal(isolation[denyAttemptField], expectedDenyAttempts);
	if (Object.hasOwn(isolation, "externalRouteAvailable")) {
		assert.equal(isolation.externalRouteAvailable, false);
	}
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
