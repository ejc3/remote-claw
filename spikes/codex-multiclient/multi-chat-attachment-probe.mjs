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
import WebSocket from "ws";

const EXPECTED_CODEX_VERSION = "codex-cli 0.146.0";
const EXPECTED_CODEX_BINARY_SHA256 =
	"cb5e8cb8a333a408ce6adbe0d4fad1845c69772c2216af7c1f88c98a11460dc6";
const EXPECTED_DELETE_ERROR = {
	code: -32600,
	message: "thread not loaded: <deleted-thread>",
};
const NAMESPACE_MARKER = "REMOTE_CLAW_CODEX_MULTI_CHAT_NETNS";
const NAMESPACE_MODE = "REMOTE_CLAW_CODEX_MULTI_CHAT_NETNS_MODE";
const PARENT_NAMESPACE = "REMOTE_CLAW_CODEX_MULTI_CHAT_PARENT_NETNS";
const CODEX_BINARY = "REMOTE_CLAW_CODEX_MULTI_CHAT_BIN";
const IP_BINARY = "REMOTE_CLAW_CODEX_MULTI_CHAT_IP_BIN";
const ORIGINAL_UID = "REMOTE_CLAW_CODEX_MULTI_CHAT_ORIGINAL_UID";
const ORIGINAL_GID = "REMOTE_CLAW_CODEX_MULTI_CHAT_ORIGINAL_GID";
const RPC_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 2_000;
const STDERR_LIMIT_BYTES = 16 * 1024;
const scriptPath = fileURLToPath(import.meta.url);

async function relaunchInPrivateNetworkNamespace() {
	if (process.platform !== "linux") {
		throw new Error(
			"This proof requires Linux network namespaces and refuses to run without containment.",
		);
	}

	const [codexBinary, unshareBinary, ipBinary] = await Promise.all([
		resolveExecutable("codex"),
		resolveExecutable("unshare"),
		resolveExecutable("ip"),
	]);
	const codexVersion = await readCodexVersion(codexBinary);
	assert(
		codexVersion === EXPECTED_CODEX_VERSION,
		`expected ${EXPECTED_CODEX_VERSION}, received ${codexVersion}`,
	);
	const codexBinarySha256 = await sha256File(codexBinary);
	assert(
		codexBinarySha256 === EXPECTED_CODEX_BINARY_SHA256,
		`Codex binary hash changed: ${codexBinarySha256}`,
	);

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
		return runNamespaceChild(
			unshareBinary,
			unprivilegedArguments,
			{
				...process.env,
				[NAMESPACE_MARKER]: "1",
				[NAMESPACE_MODE]: "unprivileged-user-net",
				[PARENT_NAMESPACE]: parentNamespace,
				[CODEX_BINARY]: codexBinary,
				[IP_BINARY]: ipBinary,
			},
			[],
		);
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
		[CODEX_BINARY]: codexBinary,
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
	extraArguments,
) {
	const result = await runProcess(
		unshareBinary,
		[
			...namespaceArguments,
			process.execPath,
			scriptPath,
			...process.argv.slice(2),
			...extraArguments,
		],
		{ env: environment, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	return result.code ?? 1;
}

async function runContainedProbe() {
	const ipBinary = requiredEnvironment(IP_BINARY);
	await runCheckedProcess(ipBinary, ["link", "set", "lo", "up"]);
	dropSudoFallbackPrivileges();

	const isolation = await inspectNetworkContainment();
	const codexBinary = await realpath(requiredEnvironment(CODEX_BINARY));
	const codexVersion = await readCodexVersion(codexBinary);
	const [codexBinarySha256, probeSha256] = await Promise.all([
		sha256File(codexBinary),
		sha256File(scriptPath),
	]);
	assert(
		codexVersion === EXPECTED_CODEX_VERSION,
		`expected ${EXPECTED_CODEX_VERSION}, received ${codexVersion}`,
	);
	assert(
		codexBinarySha256 === EXPECTED_CODEX_BINARY_SHA256,
		`Codex binary hash changed: ${codexBinarySha256}`,
	);

	await executeProbe({
		codexBinary,
		codexBinarySha256,
		codexVersion,
		isolation,
		probeSha256,
	});
}

async function executeProbe(metadata) {
	const abortController = new AbortController();
	let probeRoot;
	let denyProxy;
	let appServer;
	let tuiA;
	let tuiB;
	let hostObserver;
	const liveThreadIds = new Set();
	let evidenceCore;
	let runError;
	let receivedSignal;

	const interrupt = (signalName) => {
		receivedSignal = signalName;
		abortController.abort(new Error(`received ${signalName}`));
		for (const client of [tuiA, tuiB, hostObserver]) {
			void client?.close();
		}
		appServer?.child.kill("SIGTERM");
	};
	const onSigint = () => interrupt("SIGINT");
	const onSigterm = () => interrupt("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	let cleanup;
	try {
		probeRoot = await mkdtemp(join(tmpdir(), "remote-claw-codex-multi-chat-"));
		const codexHome = join(probeRoot, "codex-home");
		const userHome = join(probeRoot, "user-home");
		const workspace = join(probeRoot, "workspace");
		await Promise.all(
			[codexHome, userHome, workspace].map((path) =>
				mkdir(path, { mode: 0o700 }),
			),
		);
		const codexHomeInitiallyEmpty = (await readdir(codexHome)).length === 0;
		const userHomeInitiallyEmpty = (await readdir(userHome)).length === 0;
		assert(codexHomeInitiallyEmpty, "temporary CODEX_HOME was not empty");
		assert(userHomeInitiallyEmpty, "temporary HOME was not empty");

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

		tuiA = new RpcClient({
			label: "TUI_A",
			name: "remote-claw-proof-direct-tui-a",
			port,
			signal: abortController.signal,
		});
		tuiB = new RpcClient({
			label: "TUI_B",
			name: "remote-claw-proof-direct-tui-b",
			port,
			signal: abortController.signal,
		});
		hostObserver = new RpcClient({
			label: "HOST",
			name: "remote-claw-proof-host-observer",
			port,
			signal: abortController.signal,
		});
		const clients = [tuiA, tuiB, hostObserver];

		for (const client of clients) {
			await client.connect(appServer);
			await client.initialize();
		}
		assert(
			clients.every(
				(client) =>
					client.initializeRequestId === 1 && client.connectionOpenCount === 1,
			),
			"clients were not independently initialized on one connection each",
		);

		const firstStarted = await tuiA.request("thread/start", {
			cwd: workspace,
			ephemeral: false,
			sandbox: "read-only",
			approvalPolicy: "never",
		});
		const firstThreadId = firstStarted.thread.id;
		liveThreadIds.add(firstThreadId);
		assert(
			firstStarted.thread.ephemeral === false,
			"first thread was unexpectedly ephemeral",
		);

		const firstBeforeHostJoin = await executeCommandWithExpectedObservers({
			absentObservers: [tuiB, hostObserver],
			allClients: clients,
			command: "printf codex-multi-chat-thread-a-before-host-join",
			expectedObservers: [tuiA],
			expectedOutput: "codex-multi-chat-thread-a-before-host-join",
			label: "thread-A-before-host-join",
			sender: tuiA,
			threadId: firstThreadId,
		});

		const secondStarted = await tuiB.request("thread/start", {
			cwd: workspace,
			ephemeral: false,
			sandbox: "read-only",
			approvalPolicy: "never",
		});
		const secondThreadId = secondStarted.thread.id;
		liveThreadIds.add(secondThreadId);
		assert(
			secondStarted.thread.ephemeral === false,
			"second thread was unexpectedly ephemeral",
		);
		assert(
			secondThreadId !== firstThreadId,
			"two thread/start requests returned the same thread ID",
		);

		const secondBeforeHostJoin = await executeCommandWithExpectedObservers({
			absentObservers: [tuiA, hostObserver],
			allClients: clients,
			command: "printf codex-multi-chat-thread-b-before-host-join",
			expectedObservers: [tuiB],
			expectedOutput: "codex-multi-chat-thread-b-before-host-join",
			label: "thread-B-before-host-join",
			sender: tuiB,
			threadId: secondThreadId,
		});

		const hostFirstResume = await hostObserver.request("thread/resume", {
			threadId: firstThreadId,
		});
		const hostSecondResume = await hostObserver.request("thread/resume", {
			threadId: secondThreadId,
		});
		assert(
			hostFirstResume.thread.id === firstThreadId &&
				hostSecondResume.thread.id === secondThreadId,
			"host observer resume changed a native thread ID",
		);

		const firstAfterHostJoin = await executeCommandWithExpectedObservers({
			absentObservers: [tuiB],
			allClients: clients,
			command: "printf codex-multi-chat-thread-a-after-host-join",
			expectedObservers: [tuiA, hostObserver],
			expectedOutput: "codex-multi-chat-thread-a-after-host-join",
			label: "thread-A-after-host-join",
			sender: tuiA,
			threadId: firstThreadId,
		});
		const secondAfterHostJoin = await executeCommandWithExpectedObservers({
			absentObservers: [tuiA],
			allClients: clients,
			command: "printf codex-multi-chat-thread-b-after-host-join",
			expectedObservers: [tuiB, hostObserver],
			expectedOutput: "codex-multi-chat-thread-b-after-host-join",
			label: "thread-B-after-host-join",
			sender: tuiB,
			threadId: secondThreadId,
		});

		const attachmentMatrix = {
			threadA: {
				TUI_A: (
					await tuiA.request("thread/unsubscribe", {
						threadId: firstThreadId,
					})
				).status,
				TUI_B: (
					await tuiB.request("thread/unsubscribe", {
						threadId: firstThreadId,
					})
				).status,
				HOST: (
					await hostObserver.request("thread/unsubscribe", {
						threadId: firstThreadId,
					})
				).status,
			},
			threadB: {
				TUI_A: (
					await tuiA.request("thread/unsubscribe", {
						threadId: secondThreadId,
					})
				).status,
				TUI_B: (
					await tuiB.request("thread/unsubscribe", {
						threadId: secondThreadId,
					})
				).status,
				HOST: (
					await hostObserver.request("thread/unsubscribe", {
						threadId: secondThreadId,
					})
				).status,
			},
		};
		assert(
			isDeepStrictEqual(attachmentMatrix, {
				threadA: {
					TUI_A: "unsubscribed",
					TUI_B: "notSubscribed",
					HOST: "unsubscribed",
				},
				threadB: {
					TUI_A: "notSubscribed",
					TUI_B: "unsubscribed",
					HOST: "unsubscribed",
				},
			}),
			`native attachment matrix changed: ${JSON.stringify(attachmentMatrix)}`,
		);

		const directClientsSentNoResume = [tuiA, tuiB].every(
			(client) =>
				!client.sent.some((message) => message.method === "thread/resume"),
		);
		const hostResumeRequestsSent = hostObserver.sent.filter(
			(message) => message.method === "thread/resume",
		).length;
		const turnStartRequestsSent = clients
			.flatMap((client) => client.sent)
			.filter((message) => message.method === "turn/start").length;
		assert(
			directClientsSentNoResume,
			"a direct-client stand-in unexpectedly sent thread/resume",
		);
		assert(
			hostResumeRequestsSent === 2,
			"host observer did not resume exactly two threads",
		);
		assert(turnStartRequestsSent === 0, "fixture unexpectedly sent turn/start");

		const commands = [
			firstBeforeHostJoin,
			secondBeforeHostJoin,
			firstAfterHostJoin,
			secondAfterHostJoin,
		];
		const directClientCrossThreadObservations = {
			TUI_A_received_threadB_selected_projection: [
				secondBeforeHostJoin,
				secondAfterHostJoin,
			].some((command) => command.observations.TUI_A.length > 0),
			TUI_B_received_threadA_selected_projection: [
				firstBeforeHostJoin,
				firstAfterHostJoin,
			].some((command) => command.observations.TUI_B.length > 0),
		};
		const hostObserverReceivedBothThreads = [
			firstAfterHostJoin,
			secondAfterHostJoin,
		].every((command) => command.observations.HOST.length > 0);
		const hostResumeReturnedSameNativeThreadIds =
			hostFirstResume.thread.id === firstThreadId &&
			hostSecondResume.thread.id === secondThreadId;
		const fixtureConclusion = {
			ordinaryTopLevelThreadStartAttachedEveryInitializedConnection: [
				firstBeforeHostJoin,
				secondBeforeHostJoin,
			].every((command) =>
				Object.values(command.observations).every(
					(projection) => projection.length > 0,
				),
			),
			nonOwningDirectClientReceivedSelectedEvents: Object.values(
				directClientCrossThreadObservations,
			).some(Boolean),
			hostObserverCanExplicitlySubscribeToBothNativeThreads:
				hostResumeReturnedSameNativeThreadIds &&
				hostObserverReceivedBothThreads,
			hostAndOwningDirectClientReceivedEqualSelectedProjections: [
				[firstAfterHostJoin, "TUI_A"],
				[secondAfterHostJoin, "TUI_B"],
			].every(([command, owningClient]) =>
				isDeepStrictEqual(
					command.observations.HOST,
					command.observations[owningClient],
				),
			),
			nonOwningDirectClientRemainedUnsubscribedAfterHostJoin: [
				[firstAfterHostJoin, "TUI_B", "threadA"],
				[secondAfterHostJoin, "TUI_A", "threadB"],
			].every(
				([command, nonOwner, threadLabel]) =>
					command.observations[nonOwner].length === 0 &&
					command.nativeNotSubscribedResponseFences[nonOwner] ===
						"notSubscribed" &&
					attachmentMatrix[threadLabel][nonOwner] === "notSubscribed",
			),
		};
		assert(
			isDeepStrictEqual(directClientCrossThreadObservations, {
				TUI_A_received_threadB_selected_projection: false,
				TUI_B_received_threadA_selected_projection: false,
			}),
			`direct-client cross-thread observations changed: ${JSON.stringify(
				directClientCrossThreadObservations,
			)}`,
		);
		assert(
			hostObserverReceivedBothThreads,
			"host observer did not receive selected projections from both threads",
		);
		assert(
			isDeepStrictEqual(fixtureConclusion, {
				ordinaryTopLevelThreadStartAttachedEveryInitializedConnection: false,
				nonOwningDirectClientReceivedSelectedEvents: false,
				hostObserverCanExplicitlySubscribeToBothNativeThreads: true,
				hostAndOwningDirectClientReceivedEqualSelectedProjections: true,
				nonOwningDirectClientRemainedUnsubscribedAfterHostJoin: true,
			}),
			`fixture conclusion changed: ${JSON.stringify(fixtureConclusion)}`,
		);

		const deletion = {};
		for (const [threadLabel, threadId, client] of [
			["threadA", firstThreadId, tuiA],
			["threadB", secondThreadId, tuiB],
		]) {
			await client.request("thread/delete", { threadId });
			liveThreadIds.delete(threadId);
			const readError = await expectRpcError(() =>
				client.request("thread/read", {
					threadId,
					includeTurns: false,
				}),
			);
			const sanitizedError = sanitizeRpcError(
				readError,
				threadId,
				"<deleted-thread>",
			);
			assert(
				isDeepStrictEqual(sanitizedError, EXPECTED_DELETE_ERROR),
				`${threadLabel} deletion readback error changed: ${JSON.stringify(
					sanitizedError,
				)}`,
			);
			deletion[threadLabel] = {
				nativeDeleteAcknowledged: true,
				readAfterDeleteFailed: true,
				error: sanitizedError,
			};
		}

		evidenceCore = {
			capturedAt: new Date().toISOString(),
			proofScope:
				"ordinary top-level thread/start behavior on pinned Codex 0.146.0: each requester is subscribed only to its own new thread, two other pre-initialized connections report notSubscribed and receive no correlated selected shellCommand projection, then one host observer explicitly resumes both native thread IDs and receives both while each non-owning direct-client stand-in remains unsubscribed",
			scopeBoundary:
				"the fixture does not exercise core-created ThreadSpawn child threads; those require a model-driven collaboration tool path, while this proof is deliberately model-free",
			probe: {
				file: "multi-chat-attachment-probe.mjs",
				sha256: metadata.probeSha256,
				nodeVersion: process.version,
			},
			codex: {
				version: metadata.codexVersion,
				binaryPath: "<codex-binary>",
				binarySha256: metadata.codexBinarySha256,
				platform: process.platform,
				architecture: process.arch,
				appServerProcessCount: 1,
			},
			isolation: {
				...metadata.isolation,
				temporaryCodexHomeInitiallyEmpty: codexHomeInitiallyEmpty,
				temporaryUserHomeInitiallyEmpty: userHomeInitiallyEmpty,
				ambientCodexHomeInherited: false,
				ambientCredentialEnvironmentInherited: false,
				ambientProxyBypassInherited: false,
				ambientUserHomeInherited: false,
				ambientUserStartupDirectoryInherited: false,
				appServerEnvironmentVariableNames: appServer.environmentVariableNames,
			},
			clients: Object.fromEntries(
				clients.map((client) => [
					client.label,
					{
						role:
							client === hostObserver ? "hostObserver" : "directClientStandIn",
						name: client.name,
						connectionOpenCount: client.connectionOpenCount,
						initializeRequestId: client.initializeRequestId,
						startedThread:
							client === tuiA
								? firstThreadId
								: client === tuiB
									? secondThreadId
									: null,
						resumeRequestsSent: client.sent.filter(
							(message) => message.method === "thread/resume",
						).length,
					},
				]),
			),
			threads: {
				threadA: {
					id: firstThreadId,
					startedBy: tuiA.label,
					persistent: true,
				},
				threadB: {
					id: secondThreadId,
					startedBy: tuiB.label,
					persistent: true,
				},
				distinctIds: firstThreadId !== secondThreadId,
			},
			hostJoin: {
				resumedThreadIds: [
					hostFirstResume.thread.id,
					hostSecondResume.thread.id,
				],
				sameNativeThreadIds: hostResumeReturnedSameNativeThreadIds,
			},
			commands,
			finalNativeAttachmentStatus: attachmentMatrix,
			directClientCrossThreadObservations,
			hostObserverReceivedBothThreads,
			fixtureConclusion,
			inference: {
				directClientsSentNoResume,
				hostResumeRequestsSent,
				turnStartRequestsSent,
				probeIssuedModelPrompt: false,
			},
			deletion,
		};
	} catch (error) {
		runError = addAppServerDiagnostics(error, appServer);
	} finally {
		cleanup = await cleanupResources({
			appServer,
			clients: [tuiA, tuiB, hostObserver],
			denyProxy,
			liveThreadIds,
			probeRoot,
			signalAborted: abortController.signal.aborted,
		});
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}

	if (runError) throw combineErrors(runError, cleanup.errors);
	if (receivedSignal) {
		throw combineErrors(
			new Error(`probe interrupted by ${receivedSignal}`),
			cleanup.errors,
		);
	}
	if (cleanup.errors.length > 0) {
		throw new AggregateError(cleanup.errors, "probe cleanup failed");
	}
	assert(evidenceCore, "probe completed without evidence");
	assert(
		cleanup.appServerExit?.code === 0 &&
			cleanup.appServerExit.signal === null &&
			cleanup.appServerExit.forced === false,
		`app-server did not exit cleanly: ${JSON.stringify(cleanup.appServerExit)}`,
	);

	const evidence = {
		...evidenceCore,
		isolation: {
			...evidenceCore.isolation,
			localDenyProxyConnectionAttempts: denyProxy.attempts,
			externalRouteAvailable: false,
		},
		cleanup: {
			nativeThreadsDeleted: true,
			appServerExit: cleanup.appServerExit,
			allClientSocketsClosed: cleanup.allClientSocketsClosed,
			temporaryRootRemoved: cleanup.temporaryRootRemoved,
		},
	};
	console.log(JSON.stringify(evidence, null, "\t"));
}

class RpcClient {
	constructor({ label, name, port, signal }) {
		this.label = label;
		this.name = name;
		this.port = port;
		this.signal = signal;
		this.nextId = 1;
		this.messages = [];
		this.sent = [];
		this.pending = new Map();
		this.connectionOpenCount = 0;
		this.initializeRequestId = undefined;
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
					`app-server exited before ${this.label} connected (${formatExit(
						appServer.closed,
					)})`,
				);
			}
			const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
			try {
				await waitForOpen(socket, 250, this.signal);
				this.socket = socket;
				this.connectionOpenCount += 1;
				break;
			} catch (error) {
				lastError = error;
				socket.close();
				await sleep(25, this.signal);
			}
		}
		if (!this.socket) {
			throw lastError ?? new Error(`${this.label} could not connect`);
		}

		this.socket.on("message", (data) => this.handleMessage(data));
		this.socket.on("error", () => {
			const error = new Error(`${this.label} websocket failed`);
			this.connectionError ??= error;
			this.rejectAll(error);
		});
		this.socket.on("close", () => {
			if (this.closing) return;
			const error = new Error(`${this.label} websocket closed`);
			this.connectionError ??= error;
			this.rejectAll(error);
		});
	}

	async initialize() {
		this.initializeRequestId = this.nextId;
		await this.request("initialize", {
			clientInfo: {
				name: this.name,
				title: this.name,
				version: "1.0.0",
			},
		});
		this.notify("initialized");
	}

	request(method, params = {}, options = {}) {
		throwIfAborted(this.signal);
		if (!this.isOpen()) {
			return Promise.reject(
				this.connectionError ?? new Error(`${this.label} is not connected`),
			);
		}
		const id = this.nextId;
		this.nextId += 1;
		const message = { method, id, params };
		this.sent.push(message);
		const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
		const response = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`${this.label} ${method} timed out after ${timeoutMs}ms`),
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
			this.socket.send(JSON.stringify(message));
		} catch (error) {
			this.rejectPending(id, error);
		}
		return response;
	}

	notify(method, params = {}) {
		throwIfAborted(this.signal);
		assert(this.isOpen(), `${this.label} is not connected`);
		const message = { method, params };
		this.sent.push(message);
		this.socket.send(JSON.stringify(message));
	}

	async waitForMessage(predicate, sinceIndex, timeoutMs = RPC_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			throwIfAborted(this.signal);
			if (this.connectionError) throw this.connectionError;
			const match = this.messages.slice(sinceIndex).find(predicate);
			if (match) return match;
			await sleep(10, this.signal);
		}
		throw new Error(
			`${this.label} did not receive correlated event; saw ${this.messages
				.slice(sinceIndex)
				.map(summarizeMessage)
				.join(", ")}`,
		);
	}

	handleMessage(data) {
		let message;
		try {
			message = JSON.parse(String(data));
		} catch (error) {
			const parseError = new Error(
				`${this.label} received malformed JSON: ${String(error)}`,
			);
			this.connectionError ??= parseError;
			this.rejectAll(parseError);
			this.socket?.close();
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
		return this.socket?.readyState === WebSocket.OPEN;
	}

	async close() {
		this.closing = true;
		this.rejectAll(new Error(`${this.label} closed`));
		if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
		const closed = new Promise((resolve) => {
			this.socket.once("close", () => resolve(true));
		});
		this.socket.close();
		const didClose = await raceWithTimeout(closed, 500);
		if (!didClose && this.socket.readyState !== WebSocket.CLOSED) {
			throw new Error(`${this.label} websocket did not close`);
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

async function executeCommandWithExpectedObservers({
	absentObservers,
	allClients,
	command,
	expectedObservers,
	expectedOutput,
	label,
	sender,
	threadId,
}) {
	const startIndexes = new Map(
		allClients.map((client) => [client, client.messages.length]),
	);
	await sender.request("thread/shellCommand", { threadId, command });

	const completions = await Promise.all(
		expectedObservers.map((client) =>
			client.waitForMessage(
				(message) => isCommandCompletion(message, threadId, expectedOutput),
				startIndexes.get(client),
			),
		),
	);
	await Promise.all(
		expectedObservers.map((client, index) => {
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
	const absenceFences = {};
	for (const client of absentObservers) {
		const response = await client.request("thread/unsubscribe", { threadId });
		assert(
			response.status === "notSubscribed",
			`${label}: ${client.label} unexpectedly had native subscription status ${String(
				response.status,
			)}`,
		);
		absenceFences[client.label] = response.status;
	}

	const canonicalCompletion = completions[0];
	const itemId = canonicalCompletion.params.item.id;
	const turnId = canonicalCompletion.params.turnId;
	const projections = Object.fromEntries(
		allClients.map((client) => [
			client.label,
			projectCommandEvents(
				client.messages.slice(startIndexes.get(client)),
				threadId,
				turnId,
				itemId,
			),
		]),
	);
	const firstProjection = projections[expectedObservers[0].label];
	const nativeCommand = completions[0].params.item.command;
	assert(
		nativeCommand.includes(command),
		`${label} native command did not contain requested command`,
	);
	for (const client of expectedObservers) {
		const projection = projections[client.label];
		validateExactProjection(projection, {
			expectedOutput,
			nativeCommand,
			requestedCommand: command,
		});
		assert(
			isDeepStrictEqual(firstProjection, projection),
			`${label} projection differed between ${expectedObservers[0].label} and ${client.label}`,
		);
	}
	for (const client of absentObservers) {
		assert(
			projections[client.label].length === 0,
			`${label}: ${client.label} received a correlated selected projection despite native notSubscribed fence`,
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
		expectedObserverLabels: expectedObservers.map((client) => client.label),
		absentObserverLabels: absentObservers.map((client) => client.label),
		orderedExpectedProjectionsEqual: true,
		nativeNotSubscribedResponseFences: absenceFences,
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
	const projection = [];
	for (const message of messages) {
		const params = message.params;
		if (message.method === "turn/started") {
			if (params?.threadId === threadId && params?.turn?.id === turnId) {
				projection.push({
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
				projection.push({
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
			projection.push({
				method: message.method,
				threadId,
				turnId,
				itemId,
				command: params.item.command,
				status: params.item.status,
			});
		} else if (message.method === "item/commandExecution/outputDelta") {
			projection.push({
				method: message.method,
				threadId,
				turnId,
				itemId,
				delta: encodeBytes(params.delta),
			});
		} else if (message.method === "item/completed") {
			projection.push({
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
	return projection;
}

function validateExactProjection(
	projection,
	{ expectedOutput, nativeCommand, requestedCommand },
) {
	const expectedMethods = [
		"turn/started",
		"item/started",
		"item/commandExecution/outputDelta",
		"item/completed",
		"turn/completed",
	];
	assert(
		isDeepStrictEqual(
			projection.map((event) => event.method),
			expectedMethods,
		),
		`${requestedCommand} did not produce the exact selected five-event projection`,
	);
	const started = projection[1];
	const delta = projection[2];
	const completed = projection[3];
	assert(started.command === nativeCommand, "started command differed");
	assert(completed.command === nativeCommand, "completed command differed");
	assert(completed.status === "completed", "command did not complete");
	assert(completed.exitCode === 0, "command exit code was not zero");
	const deltaOutput = decodeBytes(delta.delta);
	const completedOutput = decodeBytes(completed.aggregatedOutput);
	assert(deltaOutput === expectedOutput, "delta output bytes differed");
	assert(completedOutput === expectedOutput, "completed output bytes differed");
}

function encodeBytes(text) {
	const bytes = Buffer.from(text, "utf8");
	return {
		base64: bytes.toString("base64"),
		byteLength: bytes.length,
		utf8: text,
	};
}

function decodeBytes(encoded) {
	return Buffer.from(encoded.base64, "base64").toString("utf8");
}

function summarizeMessage(message) {
	if (typeof message?.method === "string") return message.method;
	if (Object.hasOwn(message ?? {}, "id"))
		return `response:${String(message.id)}`;
	return "unclassified-message";
}

async function cleanupResources({
	appServer,
	clients,
	denyProxy,
	liveThreadIds,
	probeRoot,
	signalAborted,
}) {
	const errors = [];
	if (!signalAborted && liveThreadIds.size > 0) {
		const cleanupClient = clients.find((client) => client?.isOpen());
		for (const threadId of liveThreadIds) {
			if (!cleanupClient) {
				errors.push(
					new Error(`could not delete live probe thread ${threadId}`),
				);
				continue;
			}
			try {
				await cleanupClient.request(
					"thread/delete",
					{ threadId },
					{ timeoutMs: STOP_TIMEOUT_MS },
				);
			} catch (error) {
				errors.push(
					new Error(`failed to delete live probe thread: ${String(error)}`),
				);
			}
		}
	}

	let allClientSocketsClosed = true;
	for (const client of clients) {
		if (!client) continue;
		try {
			await client.close();
			allClientSocketsClosed &&= !client.isOpen();
		} catch (error) {
			allClientSocketsClosed = false;
			errors.push(
				new Error(`failed to close ${client.label}: ${String(error)}`),
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
			errors.push(new Error(`failed to close deny proxy: ${String(error)}`));
		}
	}

	let temporaryRootRemoved = false;
	if (probeRoot) {
		try {
			await rm(probeRoot, { recursive: true, force: true });
			temporaryRootRemoved = !(await pathExists(probeRoot));
			assert(temporaryRootRemoved, "temporary root still exists");
		} catch (error) {
			errors.push(
				new Error(`failed to remove temporary root: ${String(error)}`),
			);
		}
	}
	return {
		allClientSocketsClosed,
		appServerExit,
		errors,
		temporaryRootRemoved,
	};
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
		let closed = await raceWithTimeout(appServer.closePromise, STOP_TIMEOUT_MS);
		if (!closed) {
			forced = true;
			appServer.child.kill("SIGKILL");
			closed = await raceWithTimeout(appServer.closePromise, STOP_TIMEOUT_MS);
		}
		if (!closed) throw new Error("app-server did not exit after SIGKILL");
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
		throw new Error("deny proxy did not bind a loopback TCP port");
	}
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
		`private namespace exposed interfaces: ${interfaces.join(", ")}`,
	);
	assert(!defaultRoutePresent, "private namespace has a default route");
	return {
		mode: requiredEnvironment(NAMESPACE_MODE),
		parentNamespace,
		probeNamespace,
		distinctNetworkNamespace: true,
		interfaces,
		defaultRoutePresent,
	};
}

function dropSudoFallbackPrivileges() {
	if (process.env[NAMESPACE_MODE] !== "sudo-net") return;
	assert(
		process.getuid?.() === 0,
		"sudo network namespace did not start as root",
	);
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

async function readCodexVersion(codexBinary) {
	const result = await runProcess(codexBinary, ["--version"], {
		captureStdout: true,
		timeoutMs: 5_000,
	});
	if (result.error) throw result.error;
	assert(result.code === 0, `codex --version exited ${String(result.code)}`);
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

async function waitForOpen(socket, timeoutMs, signal) {
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
			socket.off("open", onOpen);
			socket.off("error", onError);
			signal.removeEventListener("abort", onAbort);
		};
		socket.once("open", onOpen);
		socket.once("error", onError);
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
	throw new Error("expected RPC failure, but request succeeded");
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
	if (!value) throw new Error(`missing required environment variable ${name}`);
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
		"probe failed and cleanup also reported errors",
	);
}

function formatExit(exit) {
	return exit.signal ? `signal ${exit.signal}` : `exit ${String(exit.code)}`;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	if (process.env[NAMESPACE_MARKER] === "1") {
		await runContainedProbe();
	} else {
		process.exitCode = await relaunchInPrivateNetworkNamespace();
	}
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
}
