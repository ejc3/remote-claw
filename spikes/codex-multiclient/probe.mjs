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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const EXPECTED_CODEX_VERSION = "codex-cli 0.146.0";
const EXPECTED_EMPTY_THREAD_RESUME_ERROR = {
	code: -32600,
	message: "no rollout found for thread id <empty-thread>",
};
const NETWORK_NAMESPACE_MARKER = "REMOTE_CLAW_CODEX_PROBE_NETNS";
const NETWORK_NAMESPACE_MODE = "REMOTE_CLAW_CODEX_PROBE_NETNS_MODE";
const PARENT_NETWORK_NAMESPACE = "REMOTE_CLAW_CODEX_PROBE_PARENT_NETNS";
const CODEX_BINARY = "REMOTE_CLAW_CODEX_PROBE_BIN";
const IP_BINARY = "REMOTE_CLAW_CODEX_PROBE_IP_BIN";
const ORIGINAL_UID = "REMOTE_CLAW_CODEX_PROBE_ORIGINAL_UID";
const ORIGINAL_GID = "REMOTE_CLAW_CODEX_PROBE_ORIGINAL_GID";
const RPC_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CHILD_STOP_TIMEOUT_MS = 2_000;
const STDERR_LIMIT_BYTES = 16 * 1024;
const scriptPath = fileURLToPath(import.meta.url);

async function relaunchInPrivateNetworkNamespace() {
	if (process.platform !== "linux") {
		throw new Error(
			"This proof requires Linux network namespaces; it refuses to run without containment.",
		);
	}

	const [codexBinary, unshareBinary, ipBinary] = await Promise.all([
		resolveExecutable("codex"),
		resolveExecutable("unshare"),
		resolveExecutable("ip"),
	]);
	const parentNetworkNamespace = await readlink("/proc/self/ns/net");
	const namespaceArgs = [
		"--user",
		"--map-current-user",
		"--keep-caps",
		"--net",
		"--fork",
		"--kill-child=SIGKILL",
		"--",
	];
	const unprivilegedPreflight = await runProcess(unshareBinary, [
		...namespaceArgs,
		ipBinary,
		"link",
		"set",
		"lo",
		"up",
	]);

	if (unprivilegedPreflight.code === 0) {
		return runNamespaceChild(unshareBinary, namespaceArgs, {
			...process.env,
			[NETWORK_NAMESPACE_MARKER]: "1",
			[NETWORK_NAMESPACE_MODE]: "unprivileged-user-net",
			[PARENT_NETWORK_NAMESPACE]: parentNetworkNamespace,
			[CODEX_BINARY]: codexBinary,
			[IP_BINARY]: ipBinary,
		});
	}

	const [sudoBinary, envBinary] = await Promise.all([
		resolveExecutable("sudo"),
		resolveExecutable("env"),
	]);
	const privilegedNamespaceArgs = [
		"--net",
		"--fork",
		"--kill-child=SIGKILL",
		"--",
	];
	const sudoPreflight = await runProcess(sudoBinary, [
		"-n",
		unshareBinary,
		...privilegedNamespaceArgs,
		ipBinary,
		"link",
		"set",
		"lo",
		"up",
	]);
	if (sudoPreflight.code !== 0) {
		throw new Error(
			`Could not create a private network namespace (unprivileged exit ${String(
				unprivilegedPreflight.code,
			)}, sudo exit ${String(sudoPreflight.code)}).`,
		);
	}

	const namespaceEnvironment = {
		[NETWORK_NAMESPACE_MARKER]: "1",
		[NETWORK_NAMESPACE_MODE]: "sudo-net",
		[PARENT_NETWORK_NAMESPACE]: parentNetworkNamespace,
		[CODEX_BINARY]: codexBinary,
		[IP_BINARY]: ipBinary,
		[ORIGINAL_UID]: String(process.getuid?.() ?? 0),
		[ORIGINAL_GID]: String(process.getgid?.() ?? 0),
	};
	const environmentArgs = Object.entries(namespaceEnvironment).map(
		([name, value]) => `${name}=${value}`,
	);
	const result = await runProcess(
		sudoBinary,
		[
			"-n",
			envBinary,
			...environmentArgs,
			unshareBinary,
			...privilegedNamespaceArgs,
			process.execPath,
			scriptPath,
			...process.argv.slice(2),
		],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	return result.code ?? 1;
}

async function runNamespaceChild(unshareBinary, namespaceArgs, environment) {
	const result = await runProcess(
		unshareBinary,
		[...namespaceArgs, process.execPath, scriptPath, ...process.argv.slice(2)],
		{ env: environment, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	return result.code ?? 1;
}

async function runContainedProbe() {
	if (typeof WebSocket !== "function") {
		throw new Error(
			"This probe requires a Node.js runtime with global WebSocket support.",
		);
	}

	const ipBinary = requiredEnvironment(IP_BINARY);
	await runCheckedProcess(ipBinary, ["link", "set", "lo", "up"]);
	dropSudoFallbackPrivileges();

	const networkContainment = await inspectNetworkContainment();
	const codexBinary = await realpath(requiredEnvironment(CODEX_BINARY));
	const codexVersion = await readCodexVersion(codexBinary);
	if (codexVersion !== EXPECTED_CODEX_VERSION) {
		throw new Error(
			`Expected ${EXPECTED_CODEX_VERSION}, received ${codexVersion}. Refusing to generate mismatched evidence.`,
		);
	}

	const [codexBinarySha256, probeSha256] = await Promise.all([
		sha256File(codexBinary),
		sha256File(scriptPath),
	]);
	await executeProbe({
		codexBinary,
		codexBinarySha256,
		codexVersion,
		networkContainment,
		probeSha256,
	});
}

async function executeProbe(metadata) {
	const abortController = new AbortController();
	let receivedSignal;
	let probeRoot;
	let denyProxy;
	let appServer;
	let first;
	let second;
	let createdThreadId;
	let evidenceCore;
	let runError;

	const interrupt = (signalName) => {
		receivedSignal = signalName;
		abortController.abort(new Error(`received ${signalName}`));
		void first?.close();
		void second?.close();
		appServer?.child.kill("SIGTERM");
	};
	const onSigint = () => interrupt("SIGINT");
	const onSigterm = () => interrupt("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	let cleanupResult;
	try {
		probeRoot = await mkdtemp(join(tmpdir(), "remote-claw-codex-multiclient-"));
		const codexHome = join(probeRoot, "codex-home");
		const userHome = join(probeRoot, "user-home");
		const workspace = join(probeRoot, "workspace");
		await Promise.all([
			mkdir(codexHome, { mode: 0o700 }),
			mkdir(userHome, { mode: 0o700 }),
			mkdir(workspace, { mode: 0o700 }),
		]);
		const codexHomeInitiallyEmpty = (await readdir(codexHome)).length === 0;
		const userHomeInitiallyEmpty = (await readdir(userHome)).length === 0;
		assert(codexHomeInitiallyEmpty, "temporary CODEX_HOME was not empty");
		assert(userHomeInitiallyEmpty, "temporary user HOME was not empty");

		denyProxy = await startDenyProxy();
		const port = await reserveLoopbackPort();
		appServer = startAppServer({
			codexBinary: metadata.codexBinary,
			codexHome,
			denyProxyPort: denyProxy.port,
			port,
			userHome,
			workspace,
		});

		first = new ProbeClient(
			"remote-claw-probe-a",
			"A",
			port,
			abortController.signal,
		);
		second = new ProbeClient(
			"remote-claw-probe-b",
			"B",
			port,
			abortController.signal,
		);

		await first.connect(appServer);
		const firstInitialize = await first.initialize();

		const started = await first.request("thread/start", {
			cwd: workspace,
			ephemeral: false,
			sandbox: "read-only",
			approvalPolicy: "never",
		});
		createdThreadId = started.thread.id;
		assert(
			started.thread.ephemeral === false,
			"thread/start did not return a persistent thread",
		);

		// Join B after creation so this fixture cannot depend on best-effort
		// thread-created auto-attachment of already initialized connections.
		await second.connect(appServer);
		const secondInitialize = await second.initialize();

		const emptyThreadResumeError = await expectRpcError(() =>
			second.request("thread/resume", {
				threadId: createdThreadId,
			}),
		);
		const sanitizedEmptyThreadResumeError = sanitizeRpcError(
			emptyThreadResumeError,
			createdThreadId,
			"<empty-thread>",
		);
		assert(
			isDeepStrictEqual(
				sanitizedEmptyThreadResumeError,
				EXPECTED_EMPTY_THREAD_RESUME_ERROR,
			),
			`empty persistent thread resume error changed: ${JSON.stringify(
				sanitizedEmptyThreadResumeError,
			)}`,
		);

		const preResumeSubscriptionBeforeWrite = await second.request(
			"thread/unsubscribe",
			{
				threadId: createdThreadId,
			},
		);
		assert(
			preResumeSubscriptionBeforeWrite.status === "notSubscribed",
			`late B unexpectedly reported pre-write subscription status ${String(
				preResumeSubscriptionBeforeWrite.status,
			)}`,
		);
		const secondMessagesBeforePreResumeCommand = second.messages.length;
		const preResumeShellCommand = await executeCorrelatedCommand({
			command: "printf codex-multiclient-pre-resume",
			expectedOutput: "codex-multiclient-pre-resume",
			label: "pre-resume-B-to-A",
			observers: [first],
			sender: second,
			threadId: createdThreadId,
		});
		const preResumeSubscriptionAfterWrite = await second.request(
			"thread/unsubscribe",
			{
				threadId: createdThreadId,
			},
		);
		assert(
			preResumeSubscriptionAfterWrite.status === "notSubscribed",
			`late B unexpectedly reported post-write subscription status ${String(
				preResumeSubscriptionAfterWrite.status,
			)}`,
		);
		const secondMessagesBeforeResume = second.messages.length;
		const secondPreResumeObservedMethods = second.messages
			.slice(secondMessagesBeforePreResumeCommand, secondMessagesBeforeResume)
			.map(summarizeMessage);

		const resumed = await second.request("thread/resume", {
			threadId: createdThreadId,
		});
		assert(
			resumed.thread.id === createdThreadId,
			`thread/resume returned ${String(resumed.thread.id)} instead of ${createdThreadId}`,
		);
		assert(
			resumed.thread.ephemeral === false,
			"thread/resume did not return the persistent thread",
		);

		const aToB = await executeCorrelatedCommand({
			command: "printf codex-multiclient-a-to-b",
			expectedOutput: "codex-multiclient-a-to-b",
			label: "A-to-B",
			observers: [first, second],
			sender: first,
			threadId: createdThreadId,
		});
		const bToA = await executeCorrelatedCommand({
			command: "printf codex-multiclient-b-to-a",
			expectedOutput: "codex-multiclient-b-to-a",
			label: "B-to-A",
			observers: [first, second],
			sender: second,
			threadId: createdThreadId,
		});
		const secondPreResumeDetailedProjection = projectCommandEvents(
			second.messages.slice(secondMessagesBeforePreResumeCommand),
			createdThreadId,
			preResumeShellCommand.turnId,
			preResumeShellCommand.itemId,
		);
		assert(
			secondPreResumeDetailedProjection.length === 0,
			"B received a correlated detailed event for its pre-resume command",
		);

		await second.request("thread/delete", { threadId: createdThreadId });
		const readAfterDeleteError = await expectRpcError(() =>
			second.request("thread/read", {
				threadId: createdThreadId,
				includeTurns: false,
			}),
		);
		const sanitizedDeleteError = sanitizeRpcError(
			readAfterDeleteError,
			createdThreadId,
			"<deleted-thread>",
		);
		const deletedThreadId = createdThreadId;
		createdThreadId = undefined;

		const sentMethods = [...first.sent, ...second.sent].map(
			(message) => message.method,
		);
		const turnStartRequestsSent = sentMethods.filter(
			(method) => method === "turn/start",
		).length;
		assert(
			turnStartRequestsSent === 0,
			"the probe unexpectedly sent a model turn",
		);

		evidenceCore = {
			capturedAt: new Date().toISOString(),
			proofScope:
				"a late raw app-server client writes an empty live thread before subscribing but receives no correlated detailed projection for that command; after same-ID resume, two raw clients receive equal selected command-event projections",
			probe: {
				sha256: metadata.probeSha256,
				nodeVersion: process.version,
			},
			codex: {
				version: metadata.codexVersion,
				binaryPath: metadata.codexBinary,
				binarySha256: metadata.codexBinarySha256,
				platform: process.platform,
				architecture: process.arch,
			},
			isolation: {
				...metadata.networkContainment,
				temporaryCodexHomeInitiallyEmpty: codexHomeInitiallyEmpty,
				temporaryUserHomeInitiallyEmpty: userHomeInitiallyEmpty,
				ambientCodexHomeInherited: false,
				ambientCredentialEnvironmentInherited: false,
				ambientProxyBypassInherited: false,
				ambientUserHomeInherited: false,
				ambientUserStartupDirectoryInherited: false,
				appServerEnvironmentVariableNames: appServer.environmentVariableNames,
			},
			connections: {
				A: {
					clientName: first.name,
					initializeRequestId: firstInitialize.requestId,
				},
				B: {
					clientName: second.name,
					initializeRequestId: secondInitialize.requestId,
					initializedAfterThreadStart: true,
				},
				independentRequestIdOneAccepted:
					firstInitialize.requestId === 1 && secondInitialize.requestId === 1,
			},
			thread: {
				id: deletedThreadId,
				persistent: true,
				emptyResumeBeforeMaterialization: {
					attemptedBy: second.label,
					rejected: true,
					matchedPinnedNativeError: true,
					error: sanitizedEmptyThreadResumeError,
				},
				preResumeShellCommand: {
					sentBy: preResumeShellCommand.sentBy,
					requestedCommand: preResumeShellCommand.requestedCommand,
					nativeCommand: preResumeShellCommand.nativeCommand,
					expectedOutput: preResumeShellCommand.expectedOutput,
					threadId: preResumeShellCommand.threadId,
					turnId: preResumeShellCommand.turnId,
					itemId: preResumeShellCommand.itemId,
					writeAccepted: true,
					detailedObservationByA: preResumeShellCommand.observations.A,
					unresumedB: {
						nativeSubscriptionStatusBeforeWrite:
							preResumeSubscriptionBeforeWrite.status,
						nativeSubscriptionStatusAfterWrite:
							preResumeSubscriptionAfterWrite.status,
						observedMethodsBeforeResume: secondPreResumeObservedMethods,
						correlatedDetailedProjection: secondPreResumeDetailedProjection,
						absenceCheckedAfterPostResumeTurnId: bToA.turnId,
					},
				},
				resumeAfterMaterialization: {
					attemptedBy: second.label,
					requestedId: deletedThreadId,
					returnedId: resumed.thread.id,
					sameThread: resumed.thread.id === deletedThreadId,
				},
			},
			commands: [aToB, bToA],
			fixtureConclusion: {
				shellCommandAcceptedBetweenNotSubscribedChecksWhileSelectedCorrelatedProjectionAbsent: true,
			},
			inference: {
				turnStartRequestsSent,
				probeIssuedModelPrompt: false,
			},
			deletion: {
				nativeDeleteAcknowledged: true,
				readAfterDeleteFailed: true,
				readAfterDeleteError: sanitizedDeleteError,
			},
		};
	} catch (error) {
		runError = addAppServerDiagnostics(error, appServer);
	} finally {
		cleanupResult = await cleanupResources({
			appServer,
			createdThreadId,
			denyProxy,
			first,
			probeRoot,
			second,
			signalAborted: abortController.signal.aborted,
		});
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}

	if (runError) {
		throw combineErrors(runError, cleanupResult.errors);
	}
	if (receivedSignal) {
		throw combineErrors(
			new Error(`Probe interrupted by ${receivedSignal}`),
			cleanupResult.errors,
		);
	}
	if (cleanupResult.errors.length > 0) {
		throw new AggregateError(cleanupResult.errors, "Probe cleanup failed");
	}
	assert(evidenceCore, "probe completed without producing evidence");
	assert(
		cleanupResult.appServerExit?.code === 0 &&
			cleanupResult.appServerExit.signal === null &&
			cleanupResult.appServerExit.forced === false,
		`app-server did not exit cleanly: ${JSON.stringify(
			cleanupResult.appServerExit,
		)}`,
	);

	const evidence = {
		...evidenceCore,
		isolation: {
			...evidenceCore.isolation,
			localDenyProxyConnectionAttempts: denyProxy.attempts,
			externalRouteAvailable: false,
		},
		cleanup: {
			nativeThreadDeleted: true,
			appServerExit: cleanupResult.appServerExit,
			temporaryRootRemoved: cleanupResult.temporaryRootRemoved,
		},
	};
	console.log(JSON.stringify(evidence, null, "\t"));
}

class ProbeClient {
	constructor(name, label, serverPort, signal) {
		this.name = name;
		this.label = label;
		this.serverPort = serverPort;
		this.signal = signal;
		this.nextId = 1;
		this.messages = [];
		this.pending = new Map();
		this.sent = [];
		this.closing = false;
		this.connectionError = undefined;
	}

	async connect(appServer) {
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		let lastError;
		while (Date.now() < deadline) {
			throwIfAborted(this.signal);
			if (appServer.spawnError) throw appServer.spawnError;
			if (appServer.closed) {
				throw new Error(
					`app-server exited before ${this.name} connected (${formatExit(
						appServer.closed,
					)})`,
				);
			}

			const ws = new WebSocket(`ws://127.0.0.1:${this.serverPort}`);
			try {
				await waitForWebSocketOpen(ws, 250, this.signal);
				this.ws = ws;
				break;
			} catch (error) {
				lastError = error;
				ws.close();
				await sleep(25, this.signal);
			}
		}
		if (!this.ws) {
			throw lastError ?? new Error("app-server did not accept websocket");
		}

		this.ws.addEventListener("message", (event) => {
			this.handleMessage(event);
		});
		this.ws.addEventListener("error", () => {
			const error = new Error(`${this.name} websocket failed`);
			this.connectionError ??= error;
			this.rejectAll(error);
		});
		this.ws.addEventListener("close", () => {
			if (!this.closing) {
				const error = new Error(`${this.name} websocket closed`);
				this.connectionError ??= error;
				this.rejectAll(error);
			}
		});
	}

	async initialize() {
		const requestId = this.nextId;
		await this.request("initialize", {
			clientInfo: { name: this.name, title: this.name, version: "1.0.0" },
		});
		this.notify("initialized");
		return { requestId };
	}

	request(method, params = {}, options = {}) {
		throwIfAborted(this.signal);
		if (!this.isOpen()) {
			return Promise.reject(
				this.connectionError ?? new Error(`${this.name} websocket is not open`),
			);
		}

		const id = this.nextId;
		this.nextId += 1;
		const message = { method, id, params };
		this.sent.push(message);
		const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
		const result = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`${this.name} ${method} timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);
			const onAbort = () => {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(abortReason(this.signal));
			};
			this.signal.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				method,
				reject,
				resolve,
				timeout,
				removeAbortListener: () =>
					this.signal.removeEventListener("abort", onAbort),
			});
		});

		try {
			this.ws.send(JSON.stringify(message));
		} catch (error) {
			this.rejectPending(id, error);
		}
		return result;
	}

	notify(method, params = {}) {
		throwIfAborted(this.signal);
		if (!this.isOpen()) {
			throw new Error(`${this.name} websocket is not open`);
		}
		const message = { method, params };
		this.sent.push(message);
		this.ws.send(JSON.stringify(message));
	}

	async waitForMessage(predicate, sinceIndex, timeoutMs = RPC_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			throwIfAborted(this.signal);
			if (this.connectionError) throw this.connectionError;
			const match = this.messages
				.slice(sinceIndex)
				.find((message) => predicate(message));
			if (match) return match;
			await sleep(10, this.signal);
		}
		throw new Error(
			`${this.name} did not receive the correlated native event; observed ${this.messages
				.slice(sinceIndex)
				.map(summarizeMessage)
				.join(", ")}`,
		);
	}

	handleMessage(event) {
		let message;
		try {
			message = JSON.parse(String(event.data));
		} catch (error) {
			const parseError = new Error(
				`${this.name} received malformed JSON: ${String(error)}`,
			);
			this.connectionError ??= parseError;
			this.rejectAll(parseError);
			this.ws?.close();
			return;
		}

		this.messages.push(message);
		const isResponse =
			Object.hasOwn(message, "id") &&
			!Object.hasOwn(message, "method") &&
			(Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
		if (!isResponse) return;

		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timeout);
		pending.removeAbortListener();
		if (message.error) {
			pending.reject(
				new RpcError(
					message.error.code,
					message.error.message,
					message.error.data,
				),
			);
		} else {
			pending.resolve(message.result);
		}
	}

	rejectPending(id, error) {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		pending.removeAbortListener();
		pending.reject(error instanceof Error ? error : new Error(String(error)));
	}

	rejectAll(error) {
		for (const id of [...this.pending.keys()]) {
			this.rejectPending(id, error);
		}
	}

	isOpen() {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	async close() {
		this.closing = true;
		this.rejectAll(new Error(`${this.name} closed`));
		if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
		const closed = new Promise((resolve) => {
			this.ws.addEventListener("close", () => resolve(true), { once: true });
		});
		this.ws.close();
		const didClose = await raceWithTimeout(closed, 500);
		if (!didClose && this.ws.readyState !== WebSocket.CLOSED) {
			throw new Error(`${this.name} websocket did not close`);
		}
	}
}

class RpcError extends Error {
	constructor(code, message, data) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

async function executeCorrelatedCommand({
	command,
	expectedOutput,
	label,
	observers,
	sender,
	threadId,
}) {
	const startIndexes = new Map(
		observers.map((client) => [client, client.messages.length]),
	);
	await sender.request("thread/shellCommand", { threadId, command });

	const completions = await Promise.all(
		observers.map((client) =>
			client.waitForMessage(
				(message) => isCommandCompletion(message, threadId, expectedOutput),
				startIndexes.get(client),
			),
		),
	);
	await Promise.all(
		observers.map((client, index) => {
			const completion = completions[index];
			return client.waitForMessage(
				(message) =>
					message.method === "turn/completed" &&
					message.params?.threadId === threadId &&
					message.params?.turn?.id === completion.params.turnId,
				startIndexes.get(client),
			);
		}),
	);

	const projections = Object.fromEntries(
		observers.map((client, index) => {
			const completion = completions[index];
			const itemId = completion.params.item.id;
			const turnId = completion.params.turnId;
			return [
				client.label,
				projectCommandEvents(
					client.messages.slice(startIndexes.get(client)),
					threadId,
					turnId,
					itemId,
				),
			];
		}),
	);
	const firstProjection = projections[observers[0].label];
	const nativeCommand = completions[0].params.item.command;
	assert(
		nativeCommand.includes(command),
		`${label} native command did not contain the requested shell command`,
	);
	validateCommandProjection(firstProjection, {
		expectedOutput,
		nativeCommand,
		requestedCommand: command,
	});
	for (const client of observers.slice(1)) {
		const projection = projections[client.label];
		validateCommandProjection(projection, {
			expectedOutput,
			nativeCommand,
			requestedCommand: command,
		});
		assert(
			isDeepStrictEqual(firstProjection, projection),
			`${label} native event projections differed for ${observers[0].label} and ${client.label}`,
		);
	}

	const completed = firstProjection.find(
		(event) => event.method === "item/completed",
	);
	return {
		label,
		sentBy: sender.label,
		requestedCommand: command,
		nativeCommand,
		expectedOutput: encodeBytes(expectedOutput),
		threadId,
		turnId: completed.turnId,
		itemId: completed.itemId,
		orderedProjectionsEqual: observers.every((client) =>
			isDeepStrictEqual(firstProjection, projections[client.label]),
		),
		observations: projections,
	};
}

function isCommandCompletion(message, threadId, expectedOutput) {
	return (
		message.method === "item/completed" &&
		message.params?.threadId === threadId &&
		message.params?.item?.type === "commandExecution" &&
		message.params.item.source === "userShell" &&
		message.params.item.status === "completed" &&
		message.params.item.exitCode === 0 &&
		message.params.item.aggregatedOutput === expectedOutput
	);
}

function projectCommandEvents(messages, threadId, turnId, itemId) {
	const projected = [];
	for (const message of messages) {
		const params = message.params;
		if (message.method === "turn/started") {
			if (params?.threadId === threadId && params?.turn?.id === turnId) {
				projected.push({
					method: message.method,
					threadId,
					turnId,
					status: params.turn.status,
				});
			}
			continue;
		}
		if (message.method === "turn/completed") {
			if (params?.threadId === threadId && params?.turn?.id === turnId) {
				projected.push({
					method: message.method,
					threadId,
					turnId,
					status: params.turn.status,
				});
			}
			continue;
		}
		if (
			params?.threadId !== threadId ||
			params?.turnId !== turnId ||
			(params?.itemId ?? params?.item?.id) !== itemId
		) {
			continue;
		}
		if (message.method === "item/started") {
			projected.push({
				method: message.method,
				threadId,
				turnId,
				itemId,
				command: params.item.command,
				status: params.item.status,
			});
		} else if (message.method === "item/commandExecution/outputDelta") {
			projected.push({
				method: message.method,
				threadId,
				turnId,
				itemId,
				delta: encodeBytes(params.delta),
			});
		} else if (message.method === "item/completed") {
			projected.push({
				method: message.method,
				threadId,
				turnId,
				itemId,
				command: params.item.command,
				status: params.item.status,
				exitCode: params.item.exitCode,
				aggregatedOutput: encodeBytes(params.item.aggregatedOutput ?? ""),
			});
		}
	}
	return projected;
}

function validateCommandProjection(
	projection,
	{ expectedOutput, nativeCommand, requestedCommand },
) {
	const methods = projection.map((event) => event.method);
	assert(
		methods[0] === "turn/started",
		`${requestedCommand} did not start with a turn`,
	);
	assert(
		methods.filter((method) => method === "item/started").length === 1,
		`${requestedCommand} did not have exactly one item/started`,
	);
	assert(
		methods.includes("item/commandExecution/outputDelta"),
		`${requestedCommand} did not stream command output`,
	);
	assert(
		methods.filter((method) => method === "item/completed").length === 1,
		`${requestedCommand} did not have exactly one item/completed`,
	);
	assert(
		methods.at(-1) === "turn/completed",
		`${requestedCommand} did not end with turn/completed`,
	);

	const started = projection.find((event) => event.method === "item/started");
	const deltas = projection
		.filter((event) => event.method === "item/commandExecution/outputDelta")
		.map((event) => Buffer.from(event.delta.base64, "base64"));
	const streamedOutput = Buffer.concat(deltas).toString("utf8");
	const completed = projection.find(
		(event) => event.method === "item/completed",
	);
	assert(streamedOutput === expectedOutput, "delta bytes differed");
	assert(started.command === nativeCommand, "started command differed");
	assert(completed.command === nativeCommand, "completed command differed");
	assert(
		completed.status === "completed",
		"command did not complete successfully",
	);
	assert(completed.exitCode === 0, "command exit code was not zero");
	assert(
		Buffer.from(completed.aggregatedOutput.base64, "base64").toString(
			"utf8",
		) === streamedOutput,
		"completed output differed from streamed delta bytes",
	);
}

function encodeBytes(text) {
	const bytes = Buffer.from(text, "utf8");
	return {
		base64: bytes.toString("base64"),
		byteLength: bytes.length,
		utf8: text,
	};
}

function summarizeMessage(message) {
	if (typeof message?.method === "string") return message.method;
	if (Object.hasOwn(message ?? {}, "id")) {
		return `response:${String(message.id)}`;
	}
	return "unclassified-message";
}

async function cleanupResources({
	appServer,
	createdThreadId,
	denyProxy,
	first,
	probeRoot,
	second,
	signalAborted,
}) {
	const errors = [];
	if (createdThreadId && !signalAborted) {
		const cleanupClient = [second, first].find((client) => client?.isOpen());
		if (cleanupClient) {
			try {
				await cleanupClient.request(
					"thread/delete",
					{ threadId: createdThreadId },
					{ timeoutMs: 2_000 },
				);
			} catch (error) {
				errors.push(
					new Error(`Failed to delete probe thread: ${String(error)}`),
				);
			}
		}
	}

	for (const client of [first, second]) {
		if (!client) continue;
		try {
			await client.close();
		} catch (error) {
			errors.push(
				new Error(`Failed to close ${client.label}: ${String(error)}`),
			);
		}
	}

	let appServerExit;
	if (appServer) {
		try {
			appServerExit = await stopAppServer(appServer);
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (denyProxy) {
		try {
			await denyProxy.close();
		} catch (error) {
			errors.push(new Error(`Failed to close deny proxy: ${String(error)}`));
		}
	}

	let temporaryRootRemoved = false;
	if (probeRoot) {
		try {
			await rm(probeRoot, { recursive: true, force: true });
			temporaryRootRemoved = !(await pathExists(probeRoot));
			assert(temporaryRootRemoved, "temporary probe root still exists");
		} catch (error) {
			errors.push(
				new Error(`Failed to remove temporary probe root: ${String(error)}`),
			);
		}
	}
	return { appServerExit, errors, temporaryRootRemoved };
}

function startAppServer({
	codexBinary,
	codexHome,
	denyProxyPort,
	port,
	userHome,
	workspace,
}) {
	const childEnvironment = buildAppServerEnvironment({
		codexHome,
		denyProxyPort,
		userHome,
	});
	const child = spawn(
		codexBinary,
		[
			"app-server",
			"--listen",
			`ws://127.0.0.1:${port}`,
			"--strict-config",
			"-c",
			"mcp_servers={}",
			"-c",
			"analytics.enabled=false",
			"--disable",
			"apps",
			"--disable",
			"plugins",
			"--disable",
			"remote_plugin",
			"--disable",
			"plugin_sharing",
			"--disable",
			"browser_use",
			"--disable",
			"browser_use_external",
			"--disable",
			"in_app_browser",
			"--disable",
			"in_app_updates",
			"--disable",
			"tool_suggest",
			"--disable",
			"shell_snapshot",
		],
		{
			cwd: workspace,
			env: childEnvironment,
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	const state = {
		child,
		closed: undefined,
		closePromise: undefined,
		environmentVariableNames: Object.keys(childEnvironment).sort(),
		spawnError: undefined,
		stderr: "",
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
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		state.stderr = `${state.stderr}${chunk}`.slice(-STDERR_LIMIT_BYTES);
	});
	return state;
}

function buildAppServerEnvironment({ codexHome, denyProxyPort, userHome }) {
	const environment = {};
	for (const name of [
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"LOGNAME",
		"PATH",
		"TMPDIR",
		"USER",
	]) {
		if (process.env[name] !== undefined) {
			environment[name] = process.env[name];
		}
	}
	const proxyUrl = `http://127.0.0.1:${denyProxyPort}`;
	return {
		...environment,
		ALL_PROXY: proxyUrl,
		CODEX_HOME: codexHome,
		HOME: userHome,
		HTTP_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		NO_PROXY: "",
		RUST_LOG: "warn",
		TERM: "dumb",
		ZDOTDIR: userHome,
		all_proxy: proxyUrl,
		http_proxy: proxyUrl,
		https_proxy: proxyUrl,
		no_proxy: "",
	};
}

async function stopAppServer(appServer) {
	let forced = false;
	if (!appServer.closed) {
		appServer.child.kill("SIGTERM");
		let closed = await raceWithTimeout(
			appServer.closePromise,
			CHILD_STOP_TIMEOUT_MS,
		);
		if (!closed) {
			forced = true;
			appServer.child.kill("SIGKILL");
			closed = await raceWithTimeout(
				appServer.closePromise,
				CHILD_STOP_TIMEOUT_MS,
			);
		}
		if (!closed) {
			throw new Error("app-server did not exit after SIGKILL");
		}
	}
	return { ...appServer.closed, forced };
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
	if (!address || typeof address === "string") {
		await closeServer(server, sockets);
		throw new Error("deny proxy did not receive a loopback TCP address");
	}
	return {
		get attempts() {
			return attempts;
		},
		port: address.port,
		close: () => closeServer(server, sockets),
	};
}

async function closeServer(server, sockets) {
	for (const socket of sockets) socket.destroy();
	if (!server.listening) return;
	await new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function reserveLoopbackPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await closeServer(server, new Set());
		throw new Error("unexpected loopback address");
	}
	const selectedPort = address.port;
	await closeServer(server, new Set());
	return selectedPort;
}

async function inspectNetworkContainment() {
	const parentNamespace = requiredEnvironment(PARENT_NETWORK_NAMESPACE);
	const probeNamespace = await readlink("/proc/self/ns/net");
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
		probeNamespace !== parentNamespace,
		"probe did not enter a distinct network namespace",
	);
	assert(
		isDeepStrictEqual(interfaces, ["lo"]),
		`private network namespace exposed interfaces: ${interfaces.join(", ")}`,
	);
	assert(!defaultRoutePresent, "private network namespace has a default route");
	return {
		mode: requiredEnvironment(NETWORK_NAMESPACE_MODE),
		parentNamespace,
		probeNamespace,
		distinctNetworkNamespace: true,
		interfaces,
		defaultRoutePresent,
	};
}

function dropSudoFallbackPrivileges() {
	if (process.env[NETWORK_NAMESPACE_MODE] !== "sudo-net") return;
	if (process.getuid?.() !== 0) {
		throw new Error("sudo network namespace did not start as root");
	}
	const uid = Number.parseInt(requiredEnvironment(ORIGINAL_UID), 10);
	const gid = Number.parseInt(requiredEnvironment(ORIGINAL_GID), 10);
	if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
		throw new Error("invalid original uid/gid for sudo fallback");
	}
	process.setgroups?.([]);
	process.setgid?.(gid);
	process.setuid?.(uid);
	assert(process.getuid?.() === uid, "sudo fallback did not drop uid");
	assert(process.getgid?.() === gid, "sudo fallback did not drop gid");
}

async function readCodexVersion(codexBinary) {
	const result = await runProcess(codexBinary, ["--version"], {
		captureStdout: true,
		timeoutMs: 5_000,
	});
	if (result.error) throw result.error;
	if (result.code !== 0) {
		throw new Error(`codex --version exited ${String(result.code)}`);
	}
	return result.stdout.trim();
}

async function sha256File(path) {
	const hash = createHash("sha256");
	await new Promise((resolve, reject) => {
		const stream = createReadStream(path);
		stream.once("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("end", resolve);
	});
	return hash.digest("hex");
}

async function resolveExecutable(name) {
	const pathValue = process.env.PATH ?? "";
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			return realpath(candidate);
		} catch {
			// Continue through PATH.
		}
	}
	throw new Error(`Could not resolve executable ${name}`);
}

async function runCheckedProcess(command, args) {
	const result = await runProcess(command, args, { timeoutMs: 5_000 });
	if (result.error) throw result.error;
	if (result.code !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} exited ${String(result.code)}`,
		);
	}
}

async function runProcess(command, args, options = {}) {
	const child = spawn(command, args, {
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

async function waitForWebSocketOpen(ws, timeoutMs, signal) {
	throwIfAborted(signal);
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`websocket open timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onOpen = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("websocket connection failed"));
		};
		const onAbort = () => {
			cleanup();
			reject(abortReason(signal));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("error", onError);
			signal.removeEventListener("abort", onAbort);
		};
		ws.addEventListener("open", onOpen, { once: true });
		ws.addEventListener("error", onError, { once: true });
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function sleep(milliseconds, signal) {
	throwIfAborted(signal);
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
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

async function expectRpcError(operation) {
	try {
		await operation();
	} catch (error) {
		if (error instanceof RpcError) return error;
		throw error;
	}
	throw new Error("expected RPC failure, but the request succeeded");
}

function sanitizeRpcError(error, dynamicValue, replacement) {
	return {
		code: error.code,
		message: error.message.replaceAll(dynamicValue, replacement),
	};
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function requiredEnvironment(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

function throwIfAborted(signal) {
	if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal) {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("operation aborted");
}

function addAppServerDiagnostics(error, appServer) {
	const base = error instanceof Error ? error : new Error(String(error));
	if (!appServer?.stderr) return base;
	return new Error(`${base.message}\napp-server stderr:\n${appServer.stderr}`, {
		cause: base,
	});
}

function combineErrors(primary, cleanupErrors) {
	if (cleanupErrors.length === 0) return primary;
	return new AggregateError(
		[primary, ...cleanupErrors],
		"Probe failed and cleanup also reported errors",
	);
}

function formatExit(exit) {
	return exit.signal ? `signal ${exit.signal}` : `exit ${String(exit.code)}`;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	if (process.env[NETWORK_NAMESPACE_MARKER] === "1") {
		await runContainedProbe();
	} else {
		process.exitCode = await relaunchInPrivateNetworkNamespace();
	}
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
}
