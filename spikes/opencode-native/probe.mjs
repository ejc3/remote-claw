#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const EXPECTED_VERSION = "1.17.5";
const EXPECTED_LAUNCHER_SHA256 =
	"d167e30e12cca32cc4a5da0003ee0deb1120b5ca5ee2d64cef23aec44a3c9fa9";
const EXPECTED_BINARY_SHA256 =
	"fe1839ac5c417c5fc4a08dd268465907c3e8c6ca15e7ffd93f3a8dc46d63d339";
const EXPECTED_OPENAPI_SHA256 =
	"0cded4547ac93d617517419233f08f134eb002dae111534e5c02031803e35721";
const CREATION_ID = "rcc_remote_claw_opencode_native_proof_001";
const MESSAGE_ID = "msg_remoteclaw_native_proof_001";
const MESSAGE_TEXT = "remote-claw opencode no-reply proof";
const SESSION_TITLE = "remote-claw-native-proof";
const NAMESPACE_MARKER = "REMOTE_CLAW_OPENCODE_PROOF_NETNS";
const NAMESPACE_MODE = "REMOTE_CLAW_OPENCODE_PROOF_NETNS_MODE";
const PARENT_NAMESPACE = "REMOTE_CLAW_OPENCODE_PROOF_PARENT_NETNS";
const OPENCODE_LAUNCHER = "REMOTE_CLAW_OPENCODE_PROOF_LAUNCHER";
const OPENCODE_BINARY = "REMOTE_CLAW_OPENCODE_PROOF_BINARY";
const IP_BINARY = "REMOTE_CLAW_OPENCODE_PROOF_IP_BIN";
const ORIGINAL_UID = "REMOTE_CLAW_OPENCODE_PROOF_ORIGINAL_UID";
const ORIGINAL_GID = "REMOTE_CLAW_OPENCODE_PROOF_ORIGINAL_GID";
const HTTP_TIMEOUT_MS = 10_000;
const EVENT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 3_000;
const STDERR_LIMIT_BYTES = 32 * 1024;
const scriptPath = fileURLToPath(import.meta.url);

async function relaunchInPrivateNetworkNamespace() {
	if (process.platform !== "linux") {
		throw new Error(
			"This proof requires Linux network namespaces and refuses to run without containment.",
		);
	}
	const [launcher, unshareBinary, ipBinary] = await Promise.all([
		resolveExecutable("opencode"),
		resolveExecutable("unshare"),
		resolveExecutable("ip"),
	]);
	const nativeBinary = await resolveNativeBinary(launcher);
	await validatePinnedOpenCodeFiles(launcher, nativeBinary);
	const parentNamespace = await readlink("/proc/self/ns/net");

	const unprivilegedArguments = [
		"--user",
		"--map-current-user",
		"--keep-caps",
		"--net",
		"--fork",
		"--kill-child=SIGKILL",
		"--",
	];
	const unprivilegedPreflight = await runProcess(unshareBinary, [
		...unprivilegedArguments,
		ipBinary,
		"link",
		"set",
		"lo",
		"up",
	]);
	if (unprivilegedPreflight.code === 0) {
		return runNamespaceChild(unshareBinary, unprivilegedArguments, {
			...process.env,
			[NAMESPACE_MARKER]: "1",
			[NAMESPACE_MODE]: "unprivileged-user-net",
			[PARENT_NAMESPACE]: parentNamespace,
			[OPENCODE_LAUNCHER]: launcher,
			[OPENCODE_BINARY]: nativeBinary,
			[IP_BINARY]: ipBinary,
		});
	}

	const [sudoBinary, envBinary] = await Promise.all([
		resolveExecutable("sudo"),
		resolveExecutable("env"),
	]);
	const privilegedArguments = ["--net", "--fork", "--kill-child=SIGKILL", "--"];
	const privilegedPreflight = await runProcess(sudoBinary, [
		"-n",
		unshareBinary,
		...privilegedArguments,
		ipBinary,
		"link",
		"set",
		"lo",
		"up",
	]);
	if (privilegedPreflight.code !== 0) {
		throw new Error(
			`could not create a private network namespace (unprivileged exit ${String(
				unprivilegedPreflight.code,
			)}, sudo exit ${String(privilegedPreflight.code)})`,
		);
	}
	const namespaceEnvironment = {
		[NAMESPACE_MARKER]: "1",
		[NAMESPACE_MODE]: "sudo-net",
		[PARENT_NAMESPACE]: parentNamespace,
		[OPENCODE_LAUNCHER]: launcher,
		[OPENCODE_BINARY]: nativeBinary,
		[IP_BINARY]: ipBinary,
		[ORIGINAL_UID]: String(process.getuid?.() ?? 0),
		[ORIGINAL_GID]: String(process.getgid?.() ?? 0),
	};
	const environmentArguments = Object.entries(namespaceEnvironment).map(
		([name, value]) => `${name}=${value}`,
	);
	const result = await runProcess(
		sudoBinary,
		[
			"-n",
			envBinary,
			...environmentArguments,
			unshareBinary,
			...privilegedArguments,
			process.execPath,
			scriptPath,
			...process.argv.slice(2),
		],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	return result.code ?? 1;
}

async function runNamespaceChild(
	unshareBinary,
	namespaceArguments,
	environment,
) {
	const result = await runProcess(
		unshareBinary,
		[
			...namespaceArguments,
			process.execPath,
			scriptPath,
			...process.argv.slice(2),
		],
		{ env: environment, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	return result.code ?? 1;
}

async function runContainedProof() {
	await runCheckedProcess(requiredEnvironment(IP_BINARY), [
		"link",
		"set",
		"lo",
		"up",
	]);
	dropSudoFallbackPrivileges();

	const isolation = await inspectNetworkContainment();
	const launcher = await realpath(requiredEnvironment(OPENCODE_LAUNCHER));
	const binary = await realpath(requiredEnvironment(OPENCODE_BINARY));
	const pinned = await validatePinnedOpenCodeFiles(launcher, binary);
	const probeSha256 = await sha256File(scriptPath);
	await executeProof({
		binary,
		isolation,
		launcher,
		...pinned,
		probeSha256,
	});
}

async function executeProof(metadata) {
	let proofRoot;
	let denyProxy;
	let server;
	let sse;
	let sessionId;
	let evidenceCore;
	let runError;
	let receivedSignal;

	const interrupt = (signalName) => {
		receivedSignal = signalName;
		void sse?.close().catch(() => {});
		stopProcessGroupNow(server);
	};
	const onSigint = () => interrupt("SIGINT");
	const onSigterm = () => interrupt("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	let cleanup;
	try {
		proofRoot = await mkdtemp(join(tmpdir(), "remote-claw-opencode-native-"));
		const homes = {
			cache: join(proofRoot, "cache"),
			config: join(proofRoot, "config"),
			data: join(proofRoot, "data"),
			home: join(proofRoot, "home"),
			state: join(proofRoot, "state"),
			temp: join(proofRoot, "tmp"),
			workspace: join(proofRoot, "workspace"),
		};
		await Promise.all(
			Object.values(homes).map((directory) =>
				mkdir(directory, { mode: 0o700 }),
			),
		);
		const initiallyEmpty = Object.fromEntries(
			await Promise.all(
				Object.entries(homes).map(async ([name, directory]) => [
					name,
					(await readdir(directory)).length === 0,
				]),
			),
		);
		assert(
			Object.values(initiallyEmpty).every(Boolean),
			"one or more temporary homes were not empty",
		);

		denyProxy = await startDenyProxy();
		const version = await validatePinnedOpenCodeVersion(
			metadata.binary,
			denyProxy.port,
			homes,
		);
		const port = await reserveLoopbackPort();
		const origin = `http://127.0.0.1:${port}`;
		server = startOpenCodeServer({
			binary: metadata.binary,
			denyProxyPort: denyProxy.port,
			homes,
			port,
		});
		await waitForHealthyServer(origin, server);

		const openApiResponse = await request(origin, "/doc");
		assert(openApiResponse.status === 200, "GET /doc did not return 200");
		assert(
			openApiResponse.contentType.startsWith("application/json"),
			"GET /doc did not return JSON",
		);
		const openApiSha256 = sha256(openApiResponse.bytes);
		assert(
			openApiSha256 === EXPECTED_OPENAPI_SHA256,
			`OpenAPI hash changed: ${openApiSha256}`,
		);
		const openApi = JSON.parse(openApiResponse.text);
		const schemaProof = inspectOpenApi(openApi);

		sse = await SseRecorder.connect(origin, homes.workspace);
		const connectedEvent = await sse.waitFor(
			(event) => event.type === "server.connected",
			0,
		);

		const initialList = await requestJson(origin, "/session", {
			directory: homes.workspace,
		});
		assert(initialList.status === 200, "initial session list failed");
		assert(
			isDeepStrictEqual(initialList.json, []),
			"fresh native store did not have an empty session list",
		);
		const pendingPermissions = await requestJson(origin, "/permission", {
			directory: homes.workspace,
		});
		assert(
			pendingPermissions.status === 200 &&
				isDeepStrictEqual(pendingPermissions.json, []),
			"fresh native store had pending permission requests",
		);

		let createPostCount = 0;
		const beforeCreateEvent = sse.events.length;
		createPostCount += 1;
		const createResponse = await requestJson(origin, "/session", {
			body: {
				metadata: { remoteClawCreationId: CREATION_ID },
				title: SESSION_TITLE,
			},
			directory: homes.workspace,
			method: "POST",
		});
		assert(createResponse.status === 200, "session create did not return 200");
		const createdSession = createResponse.json;
		sessionId = createdSession.id;
		validateCreatedSession(createdSession, homes.workspace);
		const createdEvent = await sse.waitFor(
			(event) =>
				event.type === "session.created" &&
				event.properties?.sessionID === sessionId,
			beforeCreateEvent,
		);
		assert(
			createdEvent.properties.info.metadata?.remoteClawCreationId ===
				CREATION_ID,
			"session.created SSE omitted creation metadata",
		);

		const listAfterCreate = await requestJson(origin, "/session", {
			directory: homes.workspace,
		});
		assert(listAfterCreate.status === 200, "session list after create failed");
		assert(
			listAfterCreate.json.length === 1,
			"session create did not produce exactly one list entry",
		);
		assert(
			listAfterCreate.json[0].id === sessionId,
			"listed session ID differs from create response",
		);
		assert(
			listAfterCreate.json[0].metadata?.remoteClawCreationId === CREATION_ID,
			"listed session omitted creation metadata",
		);
		assert(
			listAfterCreate.json.filter(
				(session) => session.metadata?.remoteClawCreationId === CREATION_ID,
			).length === 1,
			"creation metadata did not identify exactly one native session",
		);

		const promptBody = {
			messageID: MESSAGE_ID,
			noReply: true,
			parts: [{ type: "text", text: MESSAGE_TEXT }],
		};
		let promptPostCount = 0;
		const beforeFirstPrompt = sse.events.length;
		promptPostCount += 1;
		const firstReceipt = await request(
			origin,
			`/session/${sessionId}/prompt_async`,
			{
				body: promptBody,
				method: "POST",
			},
		);
		validatePromptReceipt(firstReceipt, "first");
		const firstMessageEvent = await sse.waitFor(
			(event) => isUserMessageEvent(event, sessionId, MESSAGE_ID),
			beforeFirstPrompt,
		);
		const firstPartEvent = await sse.waitFor(
			(event) => isTextPartEvent(event, sessionId, MESSAGE_ID, MESSAGE_TEXT),
			beforeFirstPrompt,
		);
		const firstHistoryResponse = await waitForHistory(
			origin,
			homes.workspace,
			sessionId,
			(history) =>
				history.length === 1 &&
				history[0]?.info?.id === MESSAGE_ID &&
				history[0]?.parts?.length === 1,
		);
		const firstHistory = validateHistory(
			firstHistoryResponse.json,
			sessionId,
			1,
		);
		assert(
			firstPartEvent.properties.part.id === firstHistory.parts[0].id,
			"first SSE part ID differs from native history",
		);
		assert(
			firstMessageEvent.properties.info.time.created ===
				firstHistory.info.time.created,
			"first SSE message time differs from native history",
		);

		const beforeSecondPrompt = sse.events.length;
		promptPostCount += 1;
		const secondReceipt = await request(
			origin,
			`/session/${sessionId}/prompt_async`,
			{ body: promptBody, method: "POST" },
		);
		validatePromptReceipt(secondReceipt, "second");
		const secondMessageEvent = await sse.waitFor(
			(event) => isUserMessageEvent(event, sessionId, MESSAGE_ID),
			beforeSecondPrompt,
		);
		const secondPartEvent = await sse.waitFor(
			(event) =>
				isTextPartEvent(event, sessionId, MESSAGE_ID, MESSAGE_TEXT) &&
				event.properties.part.id !== firstHistory.parts[0].id,
			beforeSecondPrompt,
		);
		const secondHistoryResponse = await waitForHistory(
			origin,
			homes.workspace,
			sessionId,
			(history) =>
				history.length === 1 &&
				history[0]?.info?.id === MESSAGE_ID &&
				history[0]?.parts?.length === 2,
		);
		const secondHistory = validateHistory(
			secondHistoryResponse.json,
			sessionId,
			2,
		);
		assert(
			secondHistory.parts[0].id === firstHistory.parts[0].id,
			"resend did not retain the first native part",
		);
		assert(
			secondHistory.parts[1].id === secondPartEvent.properties.part.id,
			"second SSE part ID differs from native history",
		);
		assert(
			secondHistory.parts[0].id !== secondHistory.parts[1].id,
			"resend did not create a distinct native part",
		);
		assert(
			secondMessageEvent.properties.info.time.created ===
				secondHistory.info.time.created,
			"second SSE message time differs from native history",
		);
		assert(
			promptPostCount === 2,
			"fixture did not issue exactly two prompt_async requests",
		);
		const beforeDelete = sse.events.length;
		const deleteResponse = await requestJson(origin, `/session/${sessionId}`, {
			method: "DELETE",
		});
		assert(
			deleteResponse.status === 200 && deleteResponse.json === true,
			"native session delete did not return true",
		);
		const deletedSessionId = sessionId;
		sessionId = undefined;
		const deletedEvent = await sse.waitFor(
			(event) =>
				event.type === "session.deleted" &&
				event.properties?.sessionID === deletedSessionId,
			beforeDelete,
		);
		const readAfterDelete = await request(
			origin,
			`/session/${deletedSessionId}`,
		);
		assert(
			readAfterDelete.status === 404,
			"deleted session read did not return 404",
		);
		const readAfterDeleteError = sanitizeNotFound(
			JSON.parse(readAfterDelete.text),
			deletedSessionId,
		);
		const historyAfterDelete = await request(
			origin,
			`/session/${deletedSessionId}/message`,
		);
		assert(
			historyAfterDelete.status === 404,
			"deleted session history did not return 404",
		);
		const historyAfterDeleteError = sanitizeNotFound(
			JSON.parse(historyAfterDelete.text),
			deletedSessionId,
		);
		const listAfterDelete = await requestJson(origin, "/session", {
			directory: homes.workspace,
		});
		assert(
			listAfterDelete.status === 200 &&
				isDeepStrictEqual(listAfterDelete.json, []),
			"deleted session remained in native list",
		);

		await sse.close();
		const decodedEventSequence = structuredClone(sse.events);
		const assistantEvents = decodedEventSequence.filter(
			(event) =>
				event.properties?.sessionID === deletedSessionId &&
				event.properties?.info?.role === "assistant",
		);
		assert(
			assistantEvents.length === 0,
			"noReply fixture observed an assistant message event",
		);
		assertExactEvents(
			sse.events,
			(event) => event.type === "server.connected",
			[connectedEvent],
			"server.connected",
		);
		assertExactEvents(
			sse.events,
			(event) =>
				event.type === "session.created" &&
				event.properties?.sessionID === deletedSessionId,
			[createdEvent],
			"session.created",
		);
		assertExactEvents(
			sse.events,
			(event) =>
				event.type === "message.updated" &&
				event.properties?.sessionID === deletedSessionId &&
				event.properties?.info?.id === MESSAGE_ID,
			[firstMessageEvent, secondMessageEvent],
			"caller-ID message.updated",
		);
		assertExactEvents(
			sse.events,
			(event) =>
				event.type === "message.part.updated" &&
				event.properties?.sessionID === deletedSessionId &&
				event.properties?.part?.messageID === MESSAGE_ID,
			[firstPartEvent, secondPartEvent],
			"caller-ID message.part.updated",
		);
		assertExactEvents(
			sse.events,
			(event) =>
				event.type === "session.deleted" &&
				event.properties?.sessionID === deletedSessionId,
			[deletedEvent],
			"session.deleted",
		);
		const selectedEvents = [
			connectedEvent,
			createdEvent,
			firstMessageEvent,
			firstPartEvent,
			secondMessageEvent,
			secondPartEvent,
			deletedEvent,
		];
		assert(
			selectedEvents.every((event) => typeof event.id === "string") &&
				new Set(selectedEvents.map((event) => event.id)).size ===
					selectedEvents.length,
			"selected SSE event IDs were missing or repeated",
		);
		const selectedEventIndexes = selectedEvents.map((event) =>
			decodedEventSequence.findIndex((observed) => observed.id === event.id),
		);
		assert(
			selectedEventIndexes.every(
				(index, position) =>
					index >= 0 &&
					(position === 0 || index > selectedEventIndexes[position - 1]),
			),
			"selected SSE events were not observed in protocol order",
		);
		const disposeResponse = await requestJson(origin, "/global/dispose", {
			method: "POST",
		});
		assert(
			disposeResponse.status === 200 && disposeResponse.json === true,
			"global dispose did not return true",
		);

		evidenceCore = {
			capturedAt: new Date().toISOString(),
			proofScope:
				"model-free OpenCode 1.17.5 session-create metadata correlation and prompt_async caller-message-ID behavior on one private native server",
			scopeLimits: {
				modelReplyRequested: false,
				providerCredentialSuppliedViaEnvironmentOrFreshHomes: false,
				permissionListRuntimeObservedEmpty: true,
				permissionReplyRuntimeExercised: false,
				denyProxyTargetsOrProtocolsRetained: false,
			},
			probe: {
				file: "probe.mjs",
				nodeVersion: process.version,
				sha256: metadata.probeSha256,
			},
			opencode: {
				version,
				launcherPath: metadata.launcher,
				launcherSha256: metadata.launcherSha256,
				nativeBinaryPath: metadata.binary,
				nativeBinarySha256: metadata.binarySha256,
				platform: process.platform,
				architecture: process.arch,
				nativeVersionProbeSpawnCount: 1,
				nativeServerSpawnCount: 1,
			},
			openApi: {
				route: "/doc",
				byteLength: openApiResponse.bytes.length,
				sha256: openApiSha256,
				selectedSchema: schemaProof,
			},
			isolation: {
				...metadata.isolation,
				serverBindHost: "127.0.0.1",
				temporaryDirectoriesInitiallyEmpty: initiallyEmpty,
				ambientHomeInherited: false,
				ambientXdgDirectoriesInherited: false,
				ambientProviderCredentialEnvironmentInherited: false,
				credentialFilesSeededInFreshHomes: [],
				serverEnvironmentVariableNames: server.environmentVariableNames,
			},
			sse: {
				decodedEventSequence,
				connectedEvent: projectConnectedEvent(connectedEvent),
				sessionCreatedEvent: projectSessionEvent(createdEvent),
				firstApplication: {
					messageUpdated: projectMessageEvent(firstMessageEvent),
					partUpdated: projectPartEvent(firstPartEvent),
				},
				secondApplication: {
					messageUpdated: projectMessageEvent(secondMessageEvent),
					partUpdated: projectPartEvent(secondPartEvent),
				},
				sessionDeletedEvent: projectDeletedEvent(deletedEvent),
				assistantMessageEventsForSession: assistantEvents.length,
			},
			sessionCreate: {
				initialNativeSessionList: initialList.json,
				postCount: createPostCount,
				blindRetryIssued: false,
				remoteClawCreationId: CREATION_ID,
				returnedSession: projectSession(createdSession),
				listAfterCreate: listAfterCreate.json.map(projectSession),
				matchingCreationIdCount: 1,
			},
			permissionSurface: {
				initialPendingListStatus: pendingPermissions.status,
				initialPendingList: pendingPermissions.json,
				replyRuntimeExercised: false,
			},
			promptAsync: {
				postCount: promptPostCount,
				request: promptBody,
				firstReceipt: projectReceipt(firstReceipt),
				firstHistory,
				secondReceipt: projectReceipt(secondReceipt),
				secondHistory,
				pinnedBehavior:
					"same caller message ID retained as one user message with a second distinct text part",
				nonIdempotent: true,
			},
			deletion: {
				nativeDeleteAcknowledged: true,
				deletedSessionId,
				sessionDeletedSseObserved: true,
				readAfterDeleteStatus: readAfterDelete.status,
				readAfterDeleteError,
				historyAfterDeleteStatus: historyAfterDelete.status,
				historyAfterDeleteError,
				listAfterDelete: listAfterDelete.json,
			},
			disposal: {
				globalDisposeAcknowledged: true,
			},
		};
	} catch (error) {
		runError = addServerDiagnostics(error, server);
	} finally {
		cleanup = await cleanupResources({
			denyProxy,
			origin: server?.origin,
			proofRoot,
			server,
			sessionId,
			sse,
		});
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}

	if (runError) throw combineErrors(runError, cleanup.errors);
	if (receivedSignal) {
		throw combineErrors(
			new Error(`proof interrupted by ${receivedSignal}`),
			cleanup.errors,
		);
	}
	if (cleanup.errors.length > 0) {
		throw new AggregateError(cleanup.errors, "proof cleanup failed");
	}
	assert(evidenceCore, "proof completed without evidence");
	assert(
		cleanup.processGroupTerminated,
		"OpenCode process group survived cleanup",
	);
	assert(
		cleanup.loopbackPortRefused,
		"OpenCode loopback socket survived cleanup",
	);
	assert(cleanup.sseClosed, "SSE reader survived cleanup");
	assert(cleanup.denyProxyClosed, "local deny proxy survived cleanup");
	assert(cleanup.temporaryRootRemoved, "temporary proof root survived cleanup");
	const isolationAfterCleanup = await inspectNetworkContainment();
	assert(
		isolationAfterCleanup.proofNamespace === metadata.isolation.proofNamespace,
		"network namespace changed during the proof",
	);

	const evidence = {
		...evidenceCore,
		isolation: {
			...evidenceCore.isolation,
			localDenyProxyConnectionAttempts: denyProxy.attempts,
			externalRouteAvailable: false,
			afterCleanup: {
				proofNamespace: isolationAfterCleanup.proofNamespace,
				interfaces: isolationAfterCleanup.interfaces,
				defaultRoutePresent: isolationAfterCleanup.defaultRoutePresent,
			},
		},
		cleanup: {
			serverExit: cleanup.serverExit,
			processGroupTerminated: cleanup.processGroupTerminated,
			loopbackPortRefused: cleanup.loopbackPortRefused,
			sseClosed: cleanup.sseClosed,
			denyProxyClosed: cleanup.denyProxyClosed,
			temporaryRootRemoved: cleanup.temporaryRootRemoved,
		},
	};
	console.log(JSON.stringify(evidence, null, "\t"));
}

class SseRecorder {
	static async connect(origin, workspace) {
		const recorder = new SseRecorder();
		recorder.controller = new AbortController();
		const url = new URL("/event", origin);
		url.searchParams.set("directory", workspace);
		const response = await fetch(url, {
			headers: { accept: "text/event-stream" },
			signal: recorder.controller.signal,
		});
		assert(response.status === 200, `SSE returned ${response.status}`);
		assert(
			(response.headers.get("content-type") ?? "").startsWith(
				"text/event-stream",
			),
			"SSE response content type changed",
		);
		assert(response.body, "SSE response had no body");
		recorder.events = [];
		recorder.closed = false;
		recorder.settled = false;
		recorder.failure = undefined;
		recorder.pump = recorder
			.consume(response.body)
			.catch((error) => {
				if (!(recorder.closed && error?.name === "AbortError")) {
					recorder.failure =
						error instanceof Error ? error : new Error(String(error));
				}
			})
			.finally(() => {
				recorder.settled = true;
			});
		return recorder;
	}

	async consume(body) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (!this.closed) {
					throw new Error("SSE stream ended before explicit close");
				}
				break;
			}
			buffer += decoder
				.decode(value, { stream: true })
				.replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");
				const data = block
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (!data) continue;
				this.events.push(JSON.parse(data));
			}
		}
	}

	async waitFor(predicate, sinceIndex, timeoutMs = EVENT_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.failure) throw this.failure;
			const event = this.events.slice(sinceIndex).find(predicate);
			if (event) return event;
			await sleep(10);
		}
		throw new Error(
			`SSE event timed out; observed ${this.events
				.slice(sinceIndex)
				.map((event) => event.type)
				.join(", ")}`,
		);
	}

	async close() {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.controller.abort();
		this.closePromise = (async () => {
			const settled = await raceWithTimeout(
				this.pump.then(() => true),
				STOP_TIMEOUT_MS,
			);
			assert(settled === true, "SSE reader did not settle after abort");
			assert(this.settled, "SSE reader settlement was not recorded");
			if (this.failure) throw this.failure;
		})();
		return this.closePromise;
	}
}

function inspectOpenApi(openApi) {
	assert(openApi.openapi === "3.1.0", "OpenAPI version changed");
	assert(openApi.info?.title === "opencode", "OpenAPI title changed");
	const create = openApi.paths?.["/session"]?.post;
	const prompt = openApi.paths?.["/session/{sessionID}/prompt_async"]?.post;
	const permissionList = openApi.paths?.["/permission"]?.get;
	const permissionReply =
		openApi.paths?.["/permission/{requestID}/reply"]?.post;
	const createSchema =
		create?.requestBody?.content?.["application/json"]?.schema;
	const promptSchema =
		prompt?.requestBody?.content?.["application/json"]?.schema;
	const replySchema =
		permissionReply?.requestBody?.content?.["application/json"]?.schema;
	assert(create?.operationId === "session.create", "session.create missing");
	assert(
		createSchema?.properties?.metadata?.type === "object",
		"session.create metadata schema missing",
	);
	assert(
		createSchema.additionalProperties === false,
		"session.create unexpectedly accepts unknown top-level fields",
	);
	assert(
		prompt?.operationId === "session.prompt_async",
		"session.prompt_async missing",
	);
	assert(
		promptSchema?.properties?.messageID?.pattern === "^msg",
		"prompt_async caller messageID schema changed",
	);
	assert(
		promptSchema?.properties?.noReply?.type === "boolean",
		"prompt_async noReply schema changed",
	);
	assert(
		isDeepStrictEqual(promptSchema.required, ["parts"]),
		"prompt_async required fields changed",
	);
	assert(
		promptSchema.additionalProperties === false,
		"prompt_async unexpectedly accepts unknown top-level fields",
	);
	assert(
		permissionList?.operationId === "permission.list",
		"permission.list missing",
	);
	assert(
		permissionList.responses?.["200"]?.content?.["application/json"]?.schema
			?.items?.$ref === "#/components/schemas/PermissionRequest",
		"permission.list response schema changed",
	);
	assert(
		permissionReply?.operationId === "permission.reply",
		"permission.reply missing",
	);
	assert(
		permissionReply.parameters?.find(
			(parameter) => parameter.name === "requestID",
		)?.schema?.pattern === "^per",
		"permission.reply request ID schema changed",
	);
	assert(
		isDeepStrictEqual(replySchema?.properties?.reply?.enum, [
			"once",
			"always",
			"reject",
		]),
		"permission.reply enum changed",
	);
	assert(
		isDeepStrictEqual(replySchema?.required, ["reply"]) &&
			replySchema?.additionalProperties === false,
		"permission.reply body schema changed",
	);
	return {
		create: {
			metadataType: createSchema.properties.metadata.type,
			operationId: create.operationId,
			responseSchema:
				create.responses["200"].content["application/json"].schema.$ref,
		},
		promptAsync: {
			messageIdPattern: promptSchema.properties.messageID.pattern,
			noReplyType: promptSchema.properties.noReply.type,
			operationId: prompt.operationId,
			required: promptSchema.required,
			successStatus: Number(
				Object.keys(prompt.responses).find((status) => status === "204"),
			),
		},
		permissionList: {
			itemSchema:
				permissionList.responses["200"].content["application/json"].schema.items
					.$ref,
			operationId: permissionList.operationId,
		},
		permissionReply: {
			operationId: permissionReply.operationId,
			replyEnum: replySchema.properties.reply.enum,
			requestIdPattern: permissionReply.parameters.find(
				(parameter) => parameter.name === "requestID",
			).schema.pattern,
			required: replySchema.required,
		},
	};
}

function validateCreatedSession(session, workspace) {
	assert(/^ses_[A-Za-z0-9]+$/.test(session.id), "native session ID changed");
	assert(session.directory === workspace, "session directory changed");
	assert(session.title === SESSION_TITLE, "session title changed");
	assert(session.version === EXPECTED_VERSION, "session version changed");
	assert(
		session.metadata?.remoteClawCreationId === CREATION_ID,
		"session create response omitted creation metadata",
	);
	assert(
		Number.isSafeInteger(session.time?.created) &&
			Number.isSafeInteger(session.time?.updated),
		"session timestamps changed",
	);
}

function validatePromptReceipt(receipt, label) {
	assert(receipt.status === 204, `${label} prompt_async did not return 204`);
	assert(
		receipt.bytes.length === 0,
		`${label} prompt_async returned a response body`,
	);
}

function validateHistory(history, sessionId, expectedPartCount) {
	assert(history.length === 1, "native history did not contain one message");
	const message = history[0];
	assert(message.info.id === MESSAGE_ID, "native history changed caller ID");
	assert(message.info.sessionID === sessionId, "history session ID changed");
	assert(message.info.role === "user", "history role changed");
	assert(message.info.agent === "build", "history agent changed");
	assert(
		isDeepStrictEqual(message.info.model, {
			modelID: "big-pickle",
			providerID: "opencode",
		}),
		"history model metadata changed",
	);
	assert(
		Number.isSafeInteger(message.info.time?.created),
		"history creation time changed",
	);
	assert(
		message.parts.length === expectedPartCount,
		`history part count is not ${expectedPartCount}`,
	);
	for (const part of message.parts) {
		assert(/^prt_[A-Za-z0-9]+$/.test(part.id), "native part ID changed");
		assert(part.sessionID === sessionId, "part session ID changed");
		assert(part.messageID === MESSAGE_ID, "part caller message ID changed");
		assert(part.type === "text", "part type changed");
		assert(part.text === MESSAGE_TEXT, "part text changed");
	}
	assert(
		new Set(message.parts.map((part) => part.id)).size === expectedPartCount,
		"native part IDs are not distinct",
	);
	return structuredClone(message);
}

function isUserMessageEvent(event, sessionId, messageId) {
	return (
		event.type === "message.updated" &&
		event.properties?.sessionID === sessionId &&
		event.properties?.info?.id === messageId &&
		event.properties.info.role === "user"
	);
}

function isTextPartEvent(event, sessionId, messageId, text) {
	return (
		event.type === "message.part.updated" &&
		event.properties?.sessionID === sessionId &&
		event.properties?.part?.sessionID === sessionId &&
		event.properties.part.messageID === messageId &&
		event.properties.part.type === "text" &&
		event.properties.part.text === text
	);
}

function assertExactEvents(events, predicate, selected, label) {
	const matches = events.filter(predicate);
	assert(
		matches.length === selected.length,
		`${label} matched ${matches.length} events, expected ${selected.length}`,
	);
	assert(
		matches.every((event, index) => event === selected[index]),
		`${label} selections did not equal the complete matches in order`,
	);
}

function projectConnectedEvent(event) {
	return { eventId: event.id, type: event.type, properties: event.properties };
}

function projectSessionEvent(event) {
	return {
		eventId: event.id,
		type: event.type,
		sessionID: event.properties.sessionID,
		info: projectSession(event.properties.info),
	};
}

function projectMessageEvent(event) {
	return {
		eventId: event.id,
		type: event.type,
		sessionID: event.properties.sessionID,
		info: structuredClone(event.properties.info),
	};
}

function projectPartEvent(event) {
	return {
		eventId: event.id,
		type: event.type,
		sessionID: event.properties.sessionID,
		part: structuredClone(event.properties.part),
	};
}

function projectDeletedEvent(event) {
	return {
		eventId: event.id,
		type: event.type,
		sessionID: event.properties.sessionID,
	};
}

function projectSession(session) {
	return {
		id: session.id,
		directory: session.directory,
		title: session.title,
		version: session.version,
		metadata: structuredClone(session.metadata),
		time: structuredClone(session.time),
	};
}

function projectReceipt(response) {
	return {
		status: response.status,
		bodyByteLength: response.bytes.length,
	};
}

function sanitizeNotFound(error, sessionId) {
	const sanitized = {
		name: error.name,
		data: {
			message: error.data?.message?.replaceAll(sessionId, "<session>"),
		},
	};
	assert(
		isDeepStrictEqual(sanitized, {
			name: "NotFoundError",
			data: { message: "Session not found: <session>" },
		}),
		`native not-found error changed: ${JSON.stringify(sanitized)}`,
	);
	return sanitized;
}

async function waitForHistory(origin, workspace, sessionId, predicate) {
	const deadline = Date.now() + EVENT_TIMEOUT_MS;
	let lastResponse;
	while (Date.now() < deadline) {
		lastResponse = await requestJson(origin, `/session/${sessionId}/message`, {
			directory: workspace,
		});
		if (lastResponse.status === 200 && predicate(lastResponse.json)) {
			return lastResponse;
		}
		await sleep(25);
	}
	throw new Error(
		`native history did not reach expected state: ${JSON.stringify(
			lastResponse?.json,
		)}`,
	);
}

async function requestJson(origin, pathname, options = {}) {
	const response = await request(origin, pathname, options);
	return {
		...response,
		json: response.text ? JSON.parse(response.text) : undefined,
	};
}

async function request(origin, pathname, options = {}) {
	const url = new URL(pathname, origin);
	if (options.directory !== undefined) {
		url.searchParams.set("directory", options.directory);
	}
	const headers = {};
	let body;
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(options.body);
	}
	const response = await fetch(url, {
		body,
		headers,
		method: options.method ?? "GET",
		redirect: "error",
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});
	const bytes = Buffer.from(await response.arrayBuffer());
	return {
		bytes,
		contentType: response.headers.get("content-type") ?? "",
		status: response.status,
		text: bytes.toString("utf8"),
	};
}

function startOpenCodeServer({ binary, denyProxyPort, homes, port }) {
	const environment = buildServerEnvironment({ denyProxyPort, homes });
	const child = spawn(
		binary,
		[
			"serve",
			"--pure",
			"--hostname",
			"127.0.0.1",
			"--port",
			String(port),
			"--print-logs",
			"--log-level",
			"WARN",
		],
		{
			cwd: homes.workspace,
			detached: true,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const state = {
		child,
		closed: undefined,
		closePromise: undefined,
		environmentVariableNames: Object.keys(environment).sort(),
		origin: `http://127.0.0.1:${port}`,
		spawnError: undefined,
		stderr: "",
		stdout: "",
	};
	state.closePromise = new Promise((resolve) => {
		child.once("close", (code, signal) => {
			state.closed = { code, signal };
			resolve(state.closed);
		});
	});
	child.once("error", (error) => {
		state.spawnError = error;
	});
	state.stderr = collectText(child.stderr);
	state.stdout = collectText(child.stdout);
	return state;
}

function buildServerEnvironment({ denyProxyPort, homes }) {
	const proxy = `http://127.0.0.1:${denyProxyPort}`;
	return {
		ALL_PROXY: proxy,
		HOME: homes.home,
		HTTPS_PROXY: proxy,
		HTTP_PROXY: proxy,
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		NO_PROXY: "",
		OPENCODE_DISABLE_AUTOUPDATE: "true",
		PATH: "/usr/local/bin:/usr/bin:/bin",
		TERM: "dumb",
		TMPDIR: homes.temp,
		XDG_CACHE_HOME: homes.cache,
		XDG_CONFIG_HOME: homes.config,
		XDG_DATA_HOME: homes.data,
		XDG_STATE_HOME: homes.state,
		all_proxy: proxy,
		http_proxy: proxy,
		https_proxy: proxy,
		no_proxy: "",
	};
}

async function waitForHealthyServer(origin, server) {
	const deadline = Date.now() + HTTP_TIMEOUT_MS;
	let lastError;
	while (Date.now() < deadline) {
		if (server.spawnError) throw server.spawnError;
		if (server.closed) {
			throw new Error(
				`OpenCode exited before health check (${formatExit(server.closed)})`,
			);
		}
		try {
			const health = await requestJson(origin, "/global/health");
			if (
				health.status === 200 &&
				isDeepStrictEqual(health.json, {
					healthy: true,
					version: EXPECTED_VERSION,
				})
			) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await sleep(25);
	}
	throw lastError ?? new Error("OpenCode health check timed out");
}

async function cleanupResources({
	denyProxy,
	origin,
	proofRoot,
	server,
	sessionId,
	sse,
}) {
	const errors = [];
	if (sessionId && origin && !server?.closed) {
		try {
			await request(origin, `/session/${sessionId}`, { method: "DELETE" });
		} catch (error) {
			errors.push(new Error(`cleanup session delete failed: ${String(error)}`));
		}
	}
	let sseClosed = !sse;
	if (sse) {
		try {
			await sse.close();
			sseClosed = sse.closed && sse.settled;
		} catch (error) {
			errors.push(new Error(`SSE cleanup failed: ${String(error)}`));
		}
	}
	let serverExit;
	let processGroupTerminated = !server;
	let loopbackPortRefused = !origin;
	if (server) {
		try {
			serverExit = await stopProcessGroup(server);
			processGroupTerminated = !processGroupExists(server.child.pid);
			loopbackPortRefused = !(await canConnect(new URL(origin).port));
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	let denyProxyClosed = !denyProxy;
	if (denyProxy) {
		try {
			await denyProxy.close();
			denyProxyClosed = true;
		} catch (error) {
			errors.push(new Error(`deny proxy cleanup failed: ${String(error)}`));
		}
	}
	let temporaryRootRemoved = false;
	if (proofRoot) {
		try {
			await rm(proofRoot, { recursive: true, force: true });
			temporaryRootRemoved = !(await pathExists(proofRoot));
		} catch (error) {
			errors.push(new Error(`temporary-root cleanup failed: ${String(error)}`));
		}
	}
	return {
		denyProxyClosed,
		errors,
		loopbackPortRefused,
		processGroupTerminated,
		serverExit,
		sseClosed,
		temporaryRootRemoved,
	};
}

async function stopProcessGroup(server) {
	let forced = false;
	if (!server.closed) {
		stopProcessGroupNow(server, "SIGTERM");
		let closed = await raceWithTimeout(server.closePromise, STOP_TIMEOUT_MS);
		if (!closed) {
			forced = true;
			stopProcessGroupNow(server, "SIGKILL");
			closed = await raceWithTimeout(server.closePromise, STOP_TIMEOUT_MS);
		}
		if (!closed) throw new Error("OpenCode did not exit after SIGKILL");
	}
	return { ...server.closed, forced };
}

function stopProcessGroupNow(server, signal = "SIGTERM") {
	if (!server?.child?.pid || server.closed) return;
	try {
		process.kill(-server.child.pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

function processGroupExists(pid) {
	if (!pid) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}

async function canConnect(portValue) {
	const port = Number(portValue);
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (value) => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(250, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function startDenyProxy() {
	let attempts = 0;
	const sockets = new Set();
	const server = createServer((socket) => {
		attempts += 1;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.destroy();
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(
		address && typeof address !== "string",
		"deny proxy did not bind loopback",
	);
	return {
		get attempts() {
			return attempts;
		},
		port: address.port,
		close: () => closeServer(server, sockets),
	};
}

async function reserveLoopbackPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string", "unexpected loopback address");
	const port = address.port;
	await closeServer(server, new Set());
	return port;
}

async function closeServer(server, sockets) {
	for (const socket of sockets) socket.destroy();
	if (!server.listening) return;
	await new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function inspectNetworkContainment() {
	const parentNamespace = requiredEnvironment(PARENT_NAMESPACE);
	const proofNamespace = await readlink("/proc/self/ns/net");
	const networkDevices = await readFile("/proc/net/dev", "utf8");
	const interfaces = networkDevices
		.split("\n")
		.slice(2)
		.map((line) => line.split(":", 1)[0]?.trim())
		.filter((name) => name)
		.sort();
	const routeTable = await readFile("/proc/net/route", "utf8");
	const defaultRoutePresent = routeTable
		.split("\n")
		.slice(1)
		.some((line) => line.trim().split(/\s+/)[1] === "00000000");
	assert(
		proofNamespace !== parentNamespace,
		"proof did not enter a distinct network namespace",
	);
	assert(
		isDeepStrictEqual(interfaces, ["lo"]),
		`private namespace exposed interfaces: ${interfaces.join(", ")}`,
	);
	assert(!defaultRoutePresent, "private namespace has a default route");
	return {
		mode: requiredEnvironment(NAMESPACE_MODE),
		parentNamespace,
		proofNamespace,
		distinctNetworkNamespace: true,
		interfaces,
		defaultRoutePresent,
	};
}

function dropSudoFallbackPrivileges() {
	if (process.env[NAMESPACE_MODE] !== "sudo-net") return;
	assert(process.getuid?.() === 0, "sudo namespace did not start as root");
	const uid = Number.parseInt(requiredEnvironment(ORIGINAL_UID), 10);
	const gid = Number.parseInt(requiredEnvironment(ORIGINAL_GID), 10);
	assert(
		Number.isSafeInteger(uid) && Number.isSafeInteger(gid),
		"invalid original uid/gid",
	);
	process.setgroups?.([]);
	process.setgid?.(gid);
	process.setuid?.(uid);
	assert(process.getuid?.() === uid, "sudo fallback did not drop uid");
	assert(process.getgid?.() === gid, "sudo fallback did not drop gid");
}

async function validatePinnedOpenCodeFiles(launcher, binary) {
	const [launcherSha256, binarySha256] = await Promise.all([
		sha256File(launcher),
		sha256File(binary),
	]);
	assert(
		launcherSha256 === EXPECTED_LAUNCHER_SHA256,
		`OpenCode launcher hash changed: ${launcherSha256}`,
	);
	assert(
		binarySha256 === EXPECTED_BINARY_SHA256,
		`OpenCode native binary hash changed: ${binarySha256}`,
	);
	return { binarySha256, launcherSha256 };
}

async function validatePinnedOpenCodeVersion(binary, denyProxyPort, homes) {
	const versionResult = await runProcess(binary, ["--version"], {
		captureStdout: true,
		cwd: homes.workspace,
		env: buildServerEnvironment({ denyProxyPort, homes }),
		timeoutMs: 5_000,
	});
	if (versionResult.error) throw versionResult.error;
	const version = versionResult.stdout.trim();
	assert(versionResult.code === 0, "opencode --version failed");
	assert(version === EXPECTED_VERSION, `OpenCode version changed: ${version}`);
	return version;
}

async function resolveNativeBinary(launcher) {
	const launcherText = await readFile(launcher, "utf8");
	const match = launcherText.match(
		/"\$basedir\/([^"\n]*opencode-ai@1\.17\.5\/node_modules\/opencode-ai\/bin\/opencode\.exe)"/,
	);
	if (!match?.[1]) {
		throw new Error(
			"could not resolve pinned native binary from pnpm launcher",
		);
	}
	const binary = join(dirname(launcher), match[1]);
	await access(binary, fsConstants.X_OK);
	return realpath(binary);
}

async function sha256File(pathname) {
	const hash = createHash("sha256");
	await new Promise((resolve, reject) => {
		const stream = createReadStream(pathname);
		stream.once("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("end", resolve);
	});
	return hash.digest("hex");
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function resolveExecutable(name) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			return realpath(candidate);
		} catch {
			// Continue through PATH.
		}
	}
	throw new Error(`could not resolve executable ${name}`);
}

async function runCheckedProcess(command, arguments_) {
	const result = await runProcess(command, arguments_, { timeoutMs: 5_000 });
	if (result.error) throw result.error;
	assert(
		result.code === 0,
		`${command} ${arguments_.join(" ")} exited ${String(result.code)}`,
	);
}

async function runProcess(command, arguments_, options = {}) {
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdio:
			options.stdio ??
			(options.captureStdout ? ["ignore", "pipe", "ignore"] : "ignore"),
	});
	let stdout = "";
	if (options.captureStdout) {
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
	}
	return new Promise((resolve) => {
		let error;
		let timeout;
		if (options.timeoutMs) {
			timeout = setTimeout(() => {
				error = new Error(`${command} timed out after ${options.timeoutMs}ms`);
				child.kill("SIGKILL");
			}, options.timeoutMs);
		}
		child.once("error", (spawnError) => {
			error = spawnError;
		});
		child.once("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			resolve({ code, error, signal, stdout });
		});
	});
}

function collectText(stream) {
	let text = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		text = `${text}${chunk}`.slice(-STDERR_LIMIT_BYTES);
	});
	return {
		toString() {
			return text;
		},
	};
}

function addServerDiagnostics(error, server) {
	const base = error instanceof Error ? error : new Error(String(error));
	if (!server) return base;
	const stdout = String(server.stdout);
	const stderr = String(server.stderr);
	if (!stdout && !stderr) return base;
	return new Error(
		`${base.message}\nOpenCode stdout:\n${stdout}\nOpenCode stderr:\n${stderr}`,
		{ cause: base },
	);
}

function combineErrors(primary, cleanupErrors) {
	if (cleanupErrors.length === 0) return primary;
	return new AggregateError(
		[primary, ...cleanupErrors],
		"proof failed and cleanup also reported errors",
	);
}

async function pathExists(pathname) {
	try {
		await access(pathname);
		return true;
	} catch {
		return false;
	}
}

function requiredEnvironment(name) {
	const value = process.env[name];
	if (!value) throw new Error(`missing required environment variable ${name}`);
	return value;
}

async function raceWithTimeout(promise, timeoutMs) {
	let timeout;
	const timeoutPromise = new Promise((resolve) => {
		timeout = setTimeout(() => resolve(undefined), timeoutMs);
	});
	const result = await Promise.race([promise, timeoutPromise]);
	clearTimeout(timeout);
	return result;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatExit(exit) {
	return exit.signal ? `signal ${exit.signal}` : `exit ${String(exit.code)}`;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	if (process.env[NAMESPACE_MARKER] === "1") {
		await runContainedProof();
	} else {
		process.exitCode = await relaunchInPrivateNetworkNamespace();
	}
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
}
