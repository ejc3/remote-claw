#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_EVIDENCE_SHA256 =
	"a5641094f970884067aed3cf191cc40670420448ba938053f5ee056c02cc97bd";
const EXPECTED_PROBE_SHA256 =
	"ebb2ca1ea48a0c86d31bce5746fd30a6913bd4f7ed54fe9928dad69fd8d50b6a";
const EXPECTED_LAUNCHER_SHA256 =
	"d167e30e12cca32cc4a5da0003ee0deb1120b5ca5ee2d64cef23aec44a3c9fa9";
const EXPECTED_BINARY_SHA256 =
	"fe1839ac5c417c5fc4a08dd268465907c3e8c6ca15e7ffd93f3a8dc46d63d339";
const EXPECTED_OPENAPI_SHA256 =
	"0cded4547ac93d617517419233f08f134eb002dae111534e5c02031803e35721";
const CREATION_ID = "rcc_remote_claw_opencode_native_proof_001";
const MESSAGE_ID = "msg_remoteclaw_native_proof_001";
const MESSAGE_TEXT = "remote-claw opencode no-reply proof";
const packageDirectory = dirname(fileURLToPath(import.meta.url));

const [evidenceBytes, probeBytes] = await Promise.all([
	readFile(join(packageDirectory, "evidence-1.17.5.json")),
	readFile(join(packageDirectory, "probe.mjs")),
]);
const evidenceText = evidenceBytes.toString("utf8");

assert.doesNotMatch(evidenceText, /\/(?:home|Users)\//);
assert.doesNotMatch(evidenceText, /(?:\/)?tmp\/remote-claw-opencode-native-/);

assert.equal(
	sha256(evidenceBytes),
	EXPECTED_EVIDENCE_SHA256,
	"retained evidence bytes changed",
);
assert.equal(
	sha256(probeBytes),
	EXPECTED_PROBE_SHA256,
	"the probe no longer matches the program named by the retained evidence",
);

const evidence = JSON.parse(evidenceText);
assert.deepEqual(Object.keys(evidence), [
	"capturedAt",
	"proofScope",
	"scopeLimits",
	"probe",
	"opencode",
	"openApi",
	"isolation",
	"sse",
	"sessionCreate",
	"permissionSurface",
	"promptAsync",
	"deletion",
	"disposal",
	"cleanup",
]);
assert.equal(evidence.capturedAt, "2026-07-29T21:22:36.747Z");
assert.equal(
	evidence.proofScope,
	"model-free OpenCode 1.17.5 session-create metadata correlation and prompt_async caller-message-ID behavior on one private native server",
);
assert.deepEqual(evidence.scopeLimits, {
	modelReplyRequested: false,
	providerCredentialSuppliedViaEnvironmentOrFreshHomes: false,
	permissionListRuntimeObservedEmpty: true,
	permissionReplyRuntimeExercised: false,
	denyProxyTargetsOrProtocolsRetained: false,
});

assert.deepEqual(evidence.probe, {
	file: "probe.mjs",
	nodeVersion: "v22.23.1",
	sha256: EXPECTED_PROBE_SHA256,
});
assert.deepEqual(evidence.opencode, {
	version: "1.17.5",
	launcherPath: "<opencode-launcher>",
	launcherSha256: EXPECTED_LAUNCHER_SHA256,
	nativeBinaryPath: "<opencode-native-binary>",
	nativeBinarySha256: EXPECTED_BINARY_SHA256,
	platform: "linux",
	architecture: "arm64",
	nativeVersionProbeSpawnCount: 1,
	nativeServerSpawnCount: 1,
});
assert.deepEqual(evidence.openApi, {
	route: "/doc",
	byteLength: 386197,
	sha256: EXPECTED_OPENAPI_SHA256,
	selectedSchema: {
		create: {
			metadataType: "object",
			operationId: "session.create",
			responseSchema: "#/components/schemas/Session",
		},
		promptAsync: {
			messageIdPattern: "^msg",
			noReplyType: "boolean",
			operationId: "session.prompt_async",
			required: ["parts"],
			successStatus: 204,
		},
		permissionList: {
			itemSchema: "#/components/schemas/PermissionRequest",
			operationId: "permission.list",
		},
		permissionReply: {
			operationId: "permission.reply",
			replyEnum: ["once", "always", "reject"],
			requestIdPattern: "^per",
			required: ["reply"],
		},
	},
});

assert.equal(evidence.isolation.mode, "unprivileged-user-net");
assert.match(evidence.isolation.parentNamespace, /^net:\[\d+\]$/);
assert.match(evidence.isolation.proofNamespace, /^net:\[\d+\]$/);
assert.notEqual(
	evidence.isolation.parentNamespace,
	evidence.isolation.proofNamespace,
);
assert.equal(evidence.isolation.distinctNetworkNamespace, true);
assert.deepEqual(evidence.isolation.interfaces, ["lo"]);
assert.equal(evidence.isolation.defaultRoutePresent, false);
assert.equal(evidence.isolation.serverBindHost, "127.0.0.1");
assert.deepEqual(evidence.isolation.temporaryDirectoriesInitiallyEmpty, {
	cache: true,
	config: true,
	data: true,
	home: true,
	state: true,
	temp: true,
	workspace: true,
});
assert.equal(evidence.isolation.ambientHomeInherited, false);
assert.equal(evidence.isolation.ambientXdgDirectoriesInherited, false);
assert.equal(
	evidence.isolation.ambientProviderCredentialEnvironmentInherited,
	false,
);
assert.deepEqual(evidence.isolation.credentialFilesSeededInFreshHomes, []);
assert.deepEqual(evidence.isolation.serverEnvironmentVariableNames, [
	"ALL_PROXY",
	"HOME",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"LANG",
	"LC_ALL",
	"NO_PROXY",
	"OPENCODE_DISABLE_AUTOUPDATE",
	"PATH",
	"TERM",
	"TMPDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"all_proxy",
	"http_proxy",
	"https_proxy",
	"no_proxy",
]);
assert.equal(evidence.isolation.localDenyProxyConnectionAttempts, 6);
assert.equal(evidence.isolation.externalRouteAvailable, false);
assert.deepEqual(evidence.isolation.afterCleanup, {
	proofNamespace: evidence.isolation.proofNamespace,
	interfaces: ["lo"],
	defaultRoutePresent: false,
});

const session = evidence.sessionCreate.returnedSession;
assert.deepEqual(evidence.sessionCreate.initialNativeSessionList, []);
assert.equal(evidence.sessionCreate.postCount, 1);
assert.equal(evidence.sessionCreate.blindRetryIssued, false);
assert.equal(evidence.sessionCreate.remoteClawCreationId, CREATION_ID);
assert.match(session.id, /^ses_[A-Za-z0-9]+$/);
assert.equal(session.directory, "<temp-root>/workspace");
assert.equal(session.title, "remote-claw-native-proof");
assert.equal(session.version, "1.17.5");
assert.deepEqual(session.metadata, { remoteClawCreationId: CREATION_ID });
assert.equal(Number.isSafeInteger(session.time.created), true);
assert.deepEqual(session.time, {
	created: session.time.created,
	updated: session.time.created,
});
assert.deepEqual(evidence.sessionCreate.listAfterCreate, [session]);
assert.equal(evidence.sessionCreate.matchingCreationIdCount, 1);

assert.deepEqual(evidence.permissionSurface, {
	initialPendingListStatus: 200,
	initialPendingList: [],
	replyRuntimeExercised: false,
});
assert.deepEqual(evidence.promptAsync.request, {
	messageID: MESSAGE_ID,
	noReply: true,
	parts: [{ type: "text", text: MESSAGE_TEXT }],
});
assert.equal(evidence.promptAsync.postCount, 2);
assert.deepEqual(evidence.promptAsync.firstReceipt, {
	status: 204,
	bodyByteLength: 0,
});
assert.deepEqual(evidence.promptAsync.secondReceipt, {
	status: 204,
	bodyByteLength: 0,
});
assert.equal(
	evidence.promptAsync.pinnedBehavior,
	"same caller message ID retained as one user message with a second distinct text part",
);
assert.equal(evidence.promptAsync.nonIdempotent, true);

const firstHistory = evidence.promptAsync.firstHistory;
const secondHistory = evidence.promptAsync.secondHistory;
validateUserMessage(firstHistory, session.id, 1);
validateUserMessage(secondHistory, session.id, 2);
assert.deepEqual(secondHistory.parts[0], firstHistory.parts[0]);
assert.notEqual(secondHistory.parts[0].id, secondHistory.parts[1].id);

const sse = evidence.sse;
assert.deepEqual(sse.connectedEvent, {
	eventId: sse.connectedEvent.eventId,
	type: "server.connected",
	properties: {},
});
assert.deepEqual(sse.sessionCreatedEvent, {
	eventId: sse.sessionCreatedEvent.eventId,
	type: "session.created",
	sessionID: session.id,
	info: session,
});
assert.deepEqual(sse.firstApplication.messageUpdated, {
	eventId: sse.firstApplication.messageUpdated.eventId,
	type: "message.updated",
	sessionID: session.id,
	info: firstHistory.info,
});
assert.deepEqual(sse.firstApplication.partUpdated, {
	eventId: sse.firstApplication.partUpdated.eventId,
	type: "message.part.updated",
	sessionID: session.id,
	part: firstHistory.parts[0],
});
assert.deepEqual(sse.secondApplication.messageUpdated, {
	eventId: sse.secondApplication.messageUpdated.eventId,
	type: "message.updated",
	sessionID: session.id,
	info: secondHistory.info,
});
assert.deepEqual(sse.secondApplication.partUpdated, {
	eventId: sse.secondApplication.partUpdated.eventId,
	type: "message.part.updated",
	sessionID: session.id,
	part: secondHistory.parts[1],
});
assert.deepEqual(sse.sessionDeletedEvent, {
	eventId: sse.sessionDeletedEvent.eventId,
	type: "session.deleted",
	sessionID: session.id,
});
assert.equal(sse.assistantMessageEventsForSession, 0);
const eventIds = [
	sse.connectedEvent.eventId,
	sse.sessionCreatedEvent.eventId,
	sse.firstApplication.messageUpdated.eventId,
	sse.firstApplication.partUpdated.eventId,
	sse.secondApplication.messageUpdated.eventId,
	sse.secondApplication.partUpdated.eventId,
	sse.sessionDeletedEvent.eventId,
];
for (const eventId of eventIds) assert.match(eventId, /^evt_[A-Za-z0-9]+$/);
assert.equal(new Set(eventIds).size, eventIds.length);

const decodedEvents = sse.decodedEventSequence;
assert.equal(decodedEvents.length, 58);
for (const event of decodedEvents) {
	assert.deepEqual(Object.keys(event), ["id", "type", "properties"]);
	assert.match(event.id, /^evt_[A-Za-z0-9]+$/);
	assert.equal(typeof event.type, "string");
	assert.equal(
		typeof event.properties === "object" && event.properties !== null,
		true,
	);
}
assert.equal(
	new Set(decodedEvents.map((event) => event.id)).size,
	decodedEvents.length,
);
const selectedEventIndexes = eventIds.map((eventId) =>
	decodedEvents.findIndex((event) => event.id === eventId),
);
assert.equal(
	selectedEventIndexes.every(
		(index, position) =>
			index >= 0 &&
			(position === 0 || index > selectedEventIndexes[position - 1]),
	),
	true,
);
assert.deepEqual(
	matchingEventIds(decodedEvents, (event) => event.type === "server.connected"),
	[sse.connectedEvent.eventId],
);
assert.deepEqual(
	matchingEventIds(
		decodedEvents,
		(event) =>
			event.type === "session.created" &&
			event.properties.sessionID === session.id,
	),
	[sse.sessionCreatedEvent.eventId],
);
assert.deepEqual(
	matchingEventIds(
		decodedEvents,
		(event) =>
			event.type === "message.updated" &&
			event.properties.sessionID === session.id &&
			event.properties.info?.id === MESSAGE_ID,
	),
	[
		sse.firstApplication.messageUpdated.eventId,
		sse.secondApplication.messageUpdated.eventId,
	],
);
assert.deepEqual(
	matchingEventIds(
		decodedEvents,
		(event) =>
			event.type === "message.part.updated" &&
			event.properties.sessionID === session.id &&
			event.properties.part?.messageID === MESSAGE_ID,
	),
	[
		sse.firstApplication.partUpdated.eventId,
		sse.secondApplication.partUpdated.eventId,
	],
);
assert.deepEqual(
	matchingEventIds(
		decodedEvents,
		(event) =>
			event.type === "session.deleted" &&
			event.properties.sessionID === session.id,
	),
	[sse.sessionDeletedEvent.eventId],
);
assert.equal(
	decodedEvents.filter(
		(event) =>
			event.properties.sessionID === session.id &&
			event.properties.info?.role === "assistant",
	).length,
	0,
);
const decodedById = new Map(decodedEvents.map((event) => [event.id, event]));
assert.deepEqual(decodedById.get(sse.connectedEvent.eventId), {
	id: sse.connectedEvent.eventId,
	type: "server.connected",
	properties: {},
});
assert.equal(
	decodedById.get(sse.sessionCreatedEvent.eventId).properties.info.metadata
		.remoteClawCreationId,
	CREATION_ID,
);
assert.deepEqual(
	decodedById.get(sse.firstApplication.messageUpdated.eventId).properties,
	{ sessionID: session.id, info: firstHistory.info },
);
assert.deepEqual(
	decodedById.get(sse.firstApplication.partUpdated.eventId).properties.part,
	firstHistory.parts[0],
);
assert.deepEqual(
	decodedById.get(sse.secondApplication.messageUpdated.eventId).properties,
	{ sessionID: session.id, info: secondHistory.info },
);
assert.deepEqual(
	decodedById.get(sse.secondApplication.partUpdated.eventId).properties.part,
	secondHistory.parts[1],
);
assert.equal(
	decodedById.get(sse.sessionDeletedEvent.eventId).properties.info.id,
	session.id,
);

const notFound = {
	name: "NotFoundError",
	data: { message: "Session not found: <session>" },
};
assert.deepEqual(evidence.deletion, {
	nativeDeleteAcknowledged: true,
	deletedSessionId: session.id,
	sessionDeletedSseObserved: true,
	readAfterDeleteStatus: 404,
	readAfterDeleteError: notFound,
	historyAfterDeleteStatus: 404,
	historyAfterDeleteError: notFound,
	listAfterDelete: [],
});
assert.deepEqual(evidence.disposal, {
	globalDisposeAcknowledged: true,
});
assert.deepEqual(evidence.cleanup, {
	serverExit: { code: null, signal: "SIGTERM", forced: false },
	processGroupTerminated: true,
	loopbackPortRefused: true,
	sseClosed: true,
	denyProxyClosed: true,
	temporaryRootRemoved: true,
});

console.log(
	"verified retained OpenCode 1.17.5 native evidence: one exact creation marker, complete decoded SSE and history, same-ID noReply resend appends within one incarnation, native cleanup complete",
);

function validateUserMessage(message, sessionId, partCount) {
	assert.deepEqual(message.info, {
		id: MESSAGE_ID,
		sessionID: sessionId,
		role: "user",
		time: { created: message.info.time.created },
		agent: "build",
		model: { providerID: "opencode", modelID: "big-pickle" },
	});
	assert.equal(Number.isSafeInteger(message.info.time.created), true);
	assert.equal(message.parts.length, partCount);
	for (const part of message.parts) {
		assert.deepEqual(part, {
			id: part.id,
			sessionID: sessionId,
			messageID: MESSAGE_ID,
			type: "text",
			text: MESSAGE_TEXT,
		});
		assert.match(part.id, /^prt_[A-Za-z0-9]+$/);
	}
	assert.equal(new Set(message.parts.map((part) => part.id)).size, partCount);
}

function matchingEventIds(events, predicate) {
	return events.filter(predicate).map((event) => event.id);
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
