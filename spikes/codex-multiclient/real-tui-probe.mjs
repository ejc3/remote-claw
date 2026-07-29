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
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const EXPECTED_CODEX_VERSION = "codex-cli 0.146.0";
const EXPECTED_CODEX_BINARY_SHA256 =
	"cb5e8cb8a333a408ce6adbe0d4fad1845c69772c2216af7c1f88c98a11460dc6";
const EXPECTED_DELETE_ERROR = {
	code: -32600,
	message: "thread not loaded: <deleted-thread>",
};
const MARKER = "REMOTE_CLAW_REAL_TUI_PROOF_NETNS";
const PARENT_NS = "REMOTE_CLAW_REAL_TUI_PROOF_PARENT_NS";
const CODEX_BIN = "REMOTE_CLAW_REAL_TUI_PROOF_CODEX_BIN";
const ENV_BIN = "REMOTE_CLAW_REAL_TUI_PROOF_ENV_BIN";
const IP_BIN = "REMOTE_CLAW_REAL_TUI_PROOF_IP_BIN";
const TMUX_BIN = "REMOTE_CLAW_REAL_TUI_PROOF_TMUX_BIN";
const TIMEOUT = 20_000;
const STOP_TIMEOUT = 2_000;
const scriptPath = fileURLToPath(import.meta.url);

async function run() {
	const commands = {
		codex: requiredEnvironment(CODEX_BIN),
		env: requiredEnvironment(ENV_BIN),
		ip: requiredEnvironment(IP_BIN),
		tmux: requiredEnvironment(TMUX_BIN),
	};
	let root;
	let appServer;
	let raw;
	let recorder;
	let deny;
	let tmux;
	let threadId;
	let paneEvidence = "";
	let appStderr;
	let evidenceCore;
	let cleanupEvidence;
	let runError;
	const cleanupErrors = [];
	try {
		await checked(commands.ip, ["link", "set", "lo", "up"]);
		const isolation = await inspectIsolation();
		const version = (
			await captured(commands.codex, ["--version"])
		).stdout.trim();
		assert(
			version === EXPECTED_CODEX_VERSION,
			`expected ${EXPECTED_CODEX_VERSION}, received ${version}`,
		);
		const [binarySha256, probeSha256] = await Promise.all([
			sha256File(commands.codex),
			sha256File(scriptPath),
		]);
		assert(
			binarySha256 === EXPECTED_CODEX_BINARY_SHA256,
			`Codex binary hash changed: ${binarySha256}`,
		);

		root = await mkdtemp(join(tmpdir(), "remote-claw-real-tui-"));
		const serverCodexHome = join(root, "server-codex-home");
		const serverUserHome = join(root, "server-user-home");
		const tuiCodexHome = join(root, "tui-codex-home");
		const tuiUserHome = join(root, "tui-user-home");
		const tmuxTmpDir = join(root, "tmux");
		const workspace = join(root, "workspace");
		await Promise.all(
			[
				serverCodexHome,
				serverUserHome,
				tuiCodexHome,
				tuiUserHome,
				tmuxTmpDir,
				workspace,
			].map((path) => mkdir(path, { mode: 0o700 })),
		);
		const serverCodexHomeInitiallyEmpty =
			(await readdir(serverCodexHome)).length === 0;
		const tuiCodexHomeInitiallyEmpty =
			(await readdir(tuiCodexHome)).length === 0;
		assert(serverCodexHomeInitiallyEmpty, "server CODEX_HOME not empty");
		assert(tuiCodexHomeInitiallyEmpty, "TUI CODEX_HOME not empty");
		await writeSyntheticAuth(join(serverCodexHome, "auth.json"));
		await writeFile(
			join(tuiCodexHome, "config.toml"),
			`[projects."${workspace}"]\ntrust_level = "trusted"\n`,
			{ flag: "wx", mode: 0o600 },
		);

		deny = await startDenyServer();
		const serverPort = await reservePort();
		const serverEnv = isolatedEnvironment({
			allowLoopback: false,
			codexHome: serverCodexHome,
			denyPort: deny.port,
			term: "dumb",
			userHome: serverUserHome,
		});
		appServer = spawn(
			commands.codex,
			[
				"app-server",
				"--listen",
				`ws://127.0.0.1:${serverPort}`,
				"--strict-config",
				"-c",
				"mcp_servers={}",
				"-c",
				"analytics.enabled=false",
				...disabledFeatures(),
			],
			{ cwd: workspace, env: serverEnv, stdio: ["ignore", "ignore", "pipe"] },
		);
		appStderr = collectText(appServer.stderr);

		raw = new RpcClient(`ws://127.0.0.1:${serverPort}`);
		await raw.connect(appServer);
		await raw.request("initialize", {
			clientInfo: {
				name: "remote-claw-real-tui-proof",
				title: "remote-claw-real-tui-proof",
				version: "1",
			},
		});
		raw.notify("initialized");
		const started = await raw.request("thread/start", {
			cwd: workspace,
			ephemeral: false,
			sandbox: "read-only",
			approvalPolicy: "never",
		});
		threadId = started.thread.id;
		assert(started.thread.ephemeral === false, "thread was ephemeral");

		const materialized = await issueAndObserve({
			client: raw,
			command: "printf codex-tui-proof-materialize",
			expected: "codex-tui-proof-materialize",
			threadId,
		});

		recorder = await startRecorder(`ws://127.0.0.1:${serverPort}`);
		tmux = {
			binary: commands.tmux,
			environment: {
				PATH: requiredEnvironment("PATH"),
				TMUX_TMPDIR: tmuxTmpDir,
			},
			name: `rc-real-tui-${process.pid}`,
		};
		const tuiEnv = isolatedEnvironment({
			allowLoopback: true,
			codexHome: tuiCodexHome,
			denyPort: deny.port,
			term: "xterm-256color",
			userHome: tuiUserHome,
		});
		const tuiArgs = [
			"resume",
			threadId,
			"--remote",
			`ws://127.0.0.1:${recorder.port}`,
			"--no-alt-screen",
			"--strict-config",
			"-C",
			workspace,
			"-s",
			"read-only",
			"-a",
			"never",
			"-c",
			"mcp_servers={}",
			"-c",
			"analytics.enabled=false",
			...disabledFeatures(),
		];
		const shellCommand = [
			commands.env,
			"-i",
			...Object.entries(tuiEnv).map(([key, value]) => `${key}=${value}`),
			commands.codex,
			...tuiArgs,
		]
			.map(shellQuote)
			.join(" ");
		await checked(
			tmux.binary,
			[
				"-L",
				tmux.name,
				"new-session",
				"-d",
				"-s",
				"proof",
				"-x",
				"120",
				"-y",
				"40",
				"-c",
				workspace,
				shellCommand,
			],
			{ env: tmux.environment },
		);
		await checked(
			tmux.binary,
			["-L", tmux.name, "set-option", "-t", "proof", "remain-on-exit", "on"],
			{ env: tmux.environment },
		);

		const resumeRequest = await recorder.waitFor(
			(entry) =>
				entry.direction === "tui->server" &&
				entry.message.method === "thread/resume" &&
				entry.message.params?.threadId === threadId,
		);
		const resumeResponse = await recorder.waitFor(
			(entry) =>
				entry.direction === "server->tui" &&
				entry.message.id === resumeRequest.message.id &&
				entry.message.result?.thread?.id === threadId,
		);
		assert(
			resumeResponse.message.result.thread.id === threadId,
			"TUI resume changed thread ID",
		);
		assert(
			recorder.downstreamConnectionCount === 1 &&
				recorder.upstreamConnectionCount === 1,
			"transparent recorder did not carry exactly one TUI connection",
		);

		const rawToTuiRawStart = raw.messages.length;
		const rawToTuiRecorderStart = recorder.entries.length;
		const rawToTui = await issueAndObserve({
			client: raw,
			command: "printf codex-raw-to-tui",
			expected: "codex-raw-to-tui",
			threadId,
		});
		const rawToTuiProxyProjection = await waitForProjection({
			entries: recorder.entries,
			expected: "codex-raw-to-tui",
			getMessages: () =>
				recorder.entries
					.slice(rawToTuiRecorderStart)
					.filter((entry) => entry.direction === "server->tui")
					.map((entry) => entry.message),
			threadId,
		});
		assert(
			sameProjection(rawToTui.projection, rawToTuiProxyProjection),
			"raw and TUI projections differ for raw-to-TUI command",
		);
		assert(
			raw.messages
				.slice(rawToTuiRawStart)
				.some(
					(message) =>
						message.method === "turn/completed" &&
						message.params?.turn?.id === rawToTui.turnId,
				),
			"raw completion fence missing",
		);
		await waitForPane(tmux, "codex-raw-to-tui");

		const tuiToRawRawStart = raw.messages.length;
		const tuiToRawRecorderStart = recorder.entries.length;
		await checked(
			tmux.binary,
			[
				"-L",
				tmux.name,
				"send-keys",
				"-t",
				"proof:0.0",
				"-l",
				"!printf codex-tui-to-raw",
			],
			{ env: tmux.environment },
		);
		await delay(500);
		await checked(
			tmux.binary,
			["-L", tmux.name, "send-keys", "-t", "proof:0.0", "Enter"],
			{ env: tmux.environment },
		);
		const tuiShellRequest = await recorder.waitFor(
			(entry) =>
				entry.direction === "tui->server" &&
				entry.message.method === "thread/shellCommand" &&
				entry.message.params?.threadId === threadId &&
				entry.message.params?.command === "printf codex-tui-to-raw",
			tuiToRawRecorderStart,
		);
		const tuiToRawRawProjection = await waitForProjection({
			expected: "codex-tui-to-raw",
			getMessages: () => raw.messages.slice(tuiToRawRawStart),
			threadId,
		});
		const tuiToRawProxyProjection = await waitForProjection({
			expected: "codex-tui-to-raw",
			getMessages: () =>
				recorder.entries
					.slice(tuiToRawRecorderStart)
					.filter((entry) => entry.direction === "server->tui")
					.map((entry) => entry.message),
			threadId,
		});
		assert(
			sameProjection(tuiToRawRawProjection, tuiToRawProxyProjection),
			"raw and TUI projections differ for TUI-to-raw command",
		);
		await waitForPane(tmux, "codex-tui-to-raw");
		paneEvidence = sanitizePane(await capturePane(tmux), root, threadId);
		assert(
			paneEvidence.includes("codex-raw-to-tui"),
			"pane missed raw-to-TUI command",
		);
		assert(
			paneEvidence.includes("codex-tui-to-raw"),
			"pane missed TUI-to-raw command",
		);

		const unsubscribeStart = recorder.entries.length;
		await checked(
			tmux.binary,
			["-L", tmux.name, "send-keys", "-t", "proof:0.0", "C-c"],
			{ env: tmux.environment },
		);
		await delay(250);
		await checked(
			tmux.binary,
			["-L", tmux.name, "send-keys", "-t", "proof:0.0", "C-c"],
			{ env: tmux.environment },
		);
		const unsubscribeRequest = await recorder.waitFor(
			(entry) =>
				entry.direction === "tui->server" &&
				entry.message.method === "thread/unsubscribe" &&
				entry.message.params?.threadId === threadId,
			unsubscribeStart,
		);
		const unsubscribeResponse = await recorder.waitFor(
			(entry) =>
				entry.direction === "server->tui" &&
				entry.message.id === unsubscribeRequest.message.id &&
				entry.message.result?.status === "unsubscribed",
			unsubscribeStart,
		);
		await waitUntil(async () => {
			const result = await captured(
				tmux.binary,
				[
					"-L",
					tmux.name,
					"display-message",
					"-p",
					"-t",
					"proof:0.0",
					"#{pane_dead}:#{pane_dead_status}",
				],
				{ allowFailure: true, env: tmux.environment },
			);
			return result.stdout.trim().startsWith("1:");
		});
		const paneStatus = (
			await captured(
				tmux.binary,
				[
					"-L",
					tmux.name,
					"display-message",
					"-p",
					"-t",
					"proof:0.0",
					"#{pane_dead_status}",
				],
				{ env: tmux.environment },
			)
		).stdout.trim();
		assert(paneStatus === "0", `TUI exited with status ${paneStatus}`);

		const modelTurnStarts = [
			...raw.sent,
			...recorder.entries
				.filter((entry) => entry.direction === "tui->server")
				.map((entry) => entry.message),
		].filter((message) => message.method === "turn/start");
		assert(modelTurnStarts.length === 0, "fixture sent turn/start");

		const deletedThreadId = threadId;
		await raw.request("thread/delete", { threadId: deletedThreadId });
		const readAfterDeleteError = await expectRpcError(() =>
			raw.request("thread/read", {
				threadId: deletedThreadId,
				includeTurns: false,
			}),
		);
		const sanitizedDeleteError = sanitizeRpcError(
			readAfterDeleteError,
			deletedThreadId,
			"<deleted-thread>",
		);
		assert(
			JSON.stringify(sanitizedDeleteError) ===
				JSON.stringify(EXPECTED_DELETE_ERROR),
			`delete readback error changed: ${JSON.stringify(sanitizedDeleteError)}`,
		);
		threadId = undefined;

		evidenceCore = {
			proofScope:
				"one real Codex TUI and one raw client coexist on one native app-server thread and observe identical bidirectional user-shell turn/item projections",
			probe: {
				sha256: probeSha256,
				nodeVersion: process.version,
			},
			codex: {
				version,
				binarySha256,
				expectedBinarySha256: EXPECTED_CODEX_BINARY_SHA256,
				platform: process.platform,
				architecture: process.arch,
			},
			isolation,
			temporaryHomes: {
				serverCodexHomeInitiallyEmpty,
				tuiCodexHomeInitiallyEmpty,
				ambientCredentialsInherited: false,
				ambientAuthRead: false,
				syntheticAuth: true,
				syntheticAuthWrittenOnlyInsideTemporaryServerHome: true,
				externalRouteAvailable: false,
				appServerEnvironmentVariableNames: Object.keys(serverEnv).sort(),
				tuiEnvironmentVariableNames: Object.keys(tuiEnv).sort(),
			},
			appServer: {
				spawnCount: 1,
				pid: appServer.pid,
				transport: `ws://127.0.0.1:${serverPort}`,
			},
			recorder: {
				transparentPassThrough: true,
				tuiDownstreamConnectionCount: recorder.downstreamConnectionCount,
				appServerUpstreamConnectionCount: recorder.upstreamConnectionCount,
			},
			connections: {
				rawInitializeRequestId: 1,
				tuiInitializeObserved: recorder.entries.some(
					(entry) =>
						entry.direction === "tui->server" &&
						entry.message.method === "initialize",
				),
				tuiResumeRequestedThreadId: resumeRequest.message.params.threadId,
				tuiResumeReturnedThreadId: resumeResponse.message.result.thread.id,
			},
			thread: {
				id: deletedThreadId,
				materializedTurnId: materialized.turnId,
			},
			rawToTui: {
				requestedByRaw: true,
				threadId: rawToTui.threadId,
				turnId: rawToTui.turnId,
				itemId: rawToTui.itemId,
				rawAndTuiNativeProjectionsEqual: true,
				rawNativeProjection: rawToTui.projection,
				tuiNativeProjection: rawToTuiProxyProjection.projection,
				tuiPaneContainsMarker: true,
			},
			tuiToRaw: {
				requestObservedFromRealTui: true,
				tuiRequestId: tuiShellRequest.message.id,
				threadId: tuiShellRequest.message.params.threadId,
				turnId: tuiToRawRawProjection.projection.at(-1).turnId,
				itemId: tuiToRawRawProjection.projection.find(
					(event) => event.method === "item/completed",
				).itemId,
				rawAndTuiNativeProjectionsEqual: true,
				rawNativeProjection: tuiToRawRawProjection.projection,
				tuiNativeProjection: tuiToRawProxyProjection.projection,
				tuiPaneContainsMarker: true,
			},
			modelSafety: {
				turnStartRequestsObserved: modelTurnStarts.length,
				modelPromptSent: false,
			},
			tui: {
				processExitStatus: Number(paneStatus),
				unsubscribeRequestId: unsubscribeRequest.message.id,
				unsubscribeStatus: unsubscribeResponse.message.result.status,
				sanitizedPaneExcerpt: paneEvidence,
			},
			deletion: {
				nativeDeleteAcknowledged: true,
				readAfterDeleteFailed: true,
				readAfterDeleteError: sanitizedDeleteError,
			},
		};
	} catch (error) {
		let pane = "";
		if (tmux) {
			try {
				pane = await capturePane(tmux);
			} catch {}
		}
		console.error(
			JSON.stringify(
				{
					error: String(error),
					appServerStderr: appStderr?.text(),
					recorderEntries: recorder?.entries.map((entry) => ({
						direction: entry.direction,
						id: entry.message.id,
						method: entry.message.method,
						error: entry.message.error,
					})),
					pane: sanitizePane(pane, root ?? "", threadId ?? ""),
				},
				null,
				2,
			),
		);
		runError = error instanceof Error ? error : new Error(String(error));
	} finally {
		let nativeThreadDeletedDuringCleanup = false;
		let rawClientClosed = false;
		let tmuxServerStopped = false;
		let tuiRecorderClosed = false;
		let appServerExit;
		let denyProxyClosed = false;
		const denyProxyConnectionAttempts = deny?.attempts ?? 0;
		if (threadId && raw?.isOpen()) {
			try {
				await raw.request("thread/delete", { threadId }, 2_000);
				nativeThreadDeletedDuringCleanup = true;
			} catch (error) {
				cleanupErrors.push(`thread delete: ${String(error)}`);
			}
		}
		if (raw) {
			try {
				await raw.close();
				rawClientClosed = true;
			} catch (error) {
				cleanupErrors.push(`raw close: ${String(error)}`);
			}
		}
		if (tmux) {
			const tmuxStop = await captured(
				tmux.binary,
				["-L", tmux.name, "kill-server"],
				{ allowFailure: true, env: tmux.environment },
			);
			tmuxServerStopped = tmuxStop.code === 0;
			if (!tmuxServerStopped) {
				cleanupErrors.push(
					`tmux server stop failed ${tmuxStop.code}: ${tmuxStop.stderr}`,
				);
			}
		}
		if (recorder) {
			try {
				await recorder.close();
				tuiRecorderClosed = true;
			} catch (error) {
				cleanupErrors.push(`recorder close: ${String(error)}`);
			}
		}
		if (appServer) {
			appServer.kill("SIGTERM");
			let forced = false;
			let exit = await Promise.race([
				onExit(appServer),
				delay(STOP_TIMEOUT).then(() => null),
			]);
			if (exit === null) {
				forced = true;
				appServer.kill("SIGKILL");
				exit = await onExit(appServer);
			}
			appServerExit = { ...exit, forced };
			if (
				appServerExit.code !== 0 ||
				appServerExit.signal !== null ||
				appServerExit.forced
			) {
				cleanupErrors.push(
					`app-server did not exit cleanly: ${JSON.stringify(appServerExit)}`,
				);
			}
		}
		if (deny) {
			try {
				await deny.close();
				denyProxyClosed = true;
			} catch (error) {
				cleanupErrors.push(`deny close: ${String(error)}`);
			}
		}
		let temporaryRootRemoved = false;
		if (root) {
			await rm(root, { recursive: true, force: true });
			temporaryRootRemoved = !(await pathExists(root));
			if (!temporaryRootRemoved) {
				cleanupErrors.push("temporary root still exists");
			}
		}
		cleanupEvidence = {
			nativeThreadDeleted:
				evidenceCore?.deletion.nativeDeleteAcknowledged ?? false,
			nativeThreadDeletedDuringCleanup,
			rawClientClosed,
			tuiRecorderClosed,
			tmuxServerStopped,
			appServerExit,
			denyProxyClosed,
			denyProxyConnectionAttempts,
			temporaryRootRemoved,
			tmuxSocketDirectoryRemovedWithTemporaryRoot: temporaryRootRemoved,
			syntheticAuthRemovedWithTemporaryRoot: temporaryRootRemoved,
		};
	}
	if (runError) {
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[runError, ...cleanupErrors.map((error) => new Error(error))],
				"probe failed and cleanup also failed",
			);
		}
		throw runError;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			cleanupErrors.map((error) => new Error(error)),
			"probe cleanup failed",
		);
	}
	assert(evidenceCore, "probe completed without evidence");
	assert(cleanupEvidence, "probe completed without cleanup evidence");
	console.log(
		JSON.stringify(
			{
				capturedAt: new Date().toISOString(),
				...evidenceCore,
				isolation: {
					...evidenceCore.isolation,
					denyProxyConnectionAttempts:
						cleanupEvidence.denyProxyConnectionAttempts,
				},
				cleanup: cleanupEvidence,
			},
			null,
			"\t",
		),
	);
}

class RpcClient {
	constructor(url) {
		this.url = url;
		this.nextId = 1;
		this.messages = [];
		this.sent = [];
		this.pending = new Map();
	}

	async connect(child) {
		await waitUntil(async () => {
			if (child.exitCode !== null) {
				throw new Error(`app-server exited ${child.exitCode}`);
			}
			const socket = new WebSocket(this.url);
			try {
				await Promise.race([
					new Promise((resolve, reject) => {
						socket.once("open", resolve);
						socket.once("error", reject);
					}),
					delay(200).then(() => {
						throw new Error("connect timeout");
					}),
				]);
				this.socket = socket;
				socket.on("message", (data) => this.handle(data));
				return true;
			} catch {
				socket.terminate();
				return false;
			}
		});
	}

	handle(data) {
		const message = JSON.parse(data.toString());
		this.messages.push(message);
		if (
			Object.hasOwn(message, "id") &&
			!Object.hasOwn(message, "method") &&
			(Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
		) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
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
	}

	request(method, params = {}, timeout = TIMEOUT) {
		const id = this.nextId++;
		const message = { id, method, params };
		this.sent.push(message);
		this.socket.send(JSON.stringify(message));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timeout`));
			}, timeout);
			this.pending.set(id, { resolve, reject, timer });
		});
	}

	notify(method, params = {}) {
		const message = { method, params };
		this.sent.push(message);
		this.socket.send(JSON.stringify(message));
	}

	isOpen() {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	async close() {
		if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
		const closed = new Promise((resolve) => this.socket.once("close", resolve));
		this.socket.close();
		await Promise.race([closed, delay(500)]);
		if (this.socket.readyState !== WebSocket.CLOSED) {
			this.socket.terminate();
			await Promise.race([closed, delay(500)]);
		}
		if (this.socket.readyState !== WebSocket.CLOSED) {
			throw new Error("raw websocket did not close");
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

async function startRecorder(upstreamUrl) {
	const entries = [];
	const sockets = new Set();
	let downstreamConnectionCount = 0;
	let upstreamConnectionCount = 0;
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	server.on("connection", (downstream) => {
		downstreamConnectionCount += 1;
		sockets.add(downstream);
		const upstream = new WebSocket(upstreamUrl);
		upstreamConnectionCount += 1;
		sockets.add(upstream);
		const pending = [];
		downstream.on("message", (data, binary) => {
			const bytes = Buffer.from(data);
			record(entries, "tui->server", bytes);
			if (upstream.readyState === WebSocket.OPEN)
				upstream.send(bytes, { binary });
			else pending.push([bytes, binary]);
		});
		upstream.on("open", () => {
			for (const [bytes, binary] of pending.splice(0)) {
				upstream.send(bytes, { binary });
			}
		});
		upstream.on("message", (data, binary) => {
			const bytes = Buffer.from(data);
			record(entries, "server->tui", bytes);
			if (downstream.readyState === WebSocket.OPEN)
				downstream.send(bytes, { binary });
		});
		const closeBoth = () => {
			if (downstream.readyState === WebSocket.OPEN) downstream.close();
			if (upstream.readyState === WebSocket.OPEN) upstream.close();
		};
		downstream.on("close", closeBoth);
		upstream.on("close", closeBoth);
		downstream.on("error", closeBoth);
		upstream.on("error", closeBoth);
	});
	const address = server.address();
	return {
		entries,
		get downstreamConnectionCount() {
			return downstreamConnectionCount;
		},
		get upstreamConnectionCount() {
			return upstreamConnectionCount;
		},
		port: address.port,
		waitFor: (predicate, start = 0) =>
			waitUntil(() => entries.slice(start).find(predicate)),
		close: async () => {
			for (const socket of sockets) socket.terminate();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

function record(entries, direction, bytes) {
	try {
		entries.push({ direction, message: JSON.parse(bytes.toString()) });
	} catch {
		entries.push({ direction, message: { nonJsonByteLength: bytes.length } });
	}
}

async function issueAndObserve({ client, command, expected, threadId }) {
	const start = client.messages.length;
	await client.request("thread/shellCommand", { threadId, command });
	return waitForProjection({
		expected,
		getMessages: () => client.messages.slice(start),
		threadId,
	});
}

async function waitForProjection({ expected, getMessages, threadId }) {
	const completed = await waitUntil(() =>
		getMessages().find(
			(message) =>
				message.method === "item/completed" &&
				message.params?.threadId === threadId &&
				message.params?.item?.type === "commandExecution" &&
				message.params.item.source === "userShell" &&
				message.params.item.status === "completed" &&
				message.params.item.exitCode === 0 &&
				message.params.item.aggregatedOutput === expected,
		),
	);
	const turnId = completed.params.turnId;
	const itemId = completed.params.item.id;
	await waitUntil(() =>
		getMessages().find(
			(message) =>
				message.method === "turn/completed" &&
				message.params?.threadId === threadId &&
				message.params?.turn?.id === turnId,
		),
	);
	const projection = [];
	for (const message of getMessages()) {
		const params = message.params;
		if (
			message.method === "turn/started" &&
			params?.threadId === threadId &&
			params?.turn?.id === turnId
		) {
			projection.push({
				method: message.method,
				threadId,
				turnId,
				status: params.turn.status,
			});
		} else if (
			message.method === "turn/completed" &&
			params?.threadId === threadId &&
			params?.turn?.id === turnId
		) {
			projection.push({
				method: message.method,
				threadId,
				turnId,
				status: params.turn.status,
			});
		} else if (
			params?.threadId === threadId &&
			params?.turnId === turnId &&
			(params?.itemId ?? params?.item?.id) === itemId
		) {
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
					delta: params.delta,
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
					aggregatedOutput: params.item.aggregatedOutput,
				});
			}
		}
	}
	assert(
		projection.at(0)?.method === "turn/started",
		"projection missing turn/started",
	);
	assert(
		projection.at(-1)?.method === "turn/completed",
		"projection missing turn/completed",
	);
	return { projection, threadId, turnId, itemId };
}

function sameProjection(left, right) {
	return (
		JSON.stringify(left.projection ?? left) ===
		JSON.stringify(right.projection ?? right)
	);
}

async function capturePane(tmux) {
	return (
		await captured(
			tmux.binary,
			[
				"-L",
				tmux.name,
				"capture-pane",
				"-p",
				"-J",
				"-S",
				"-200",
				"-t",
				"proof:0.0",
			],
			{ env: tmux.environment },
		)
	).stdout;
}

async function waitForPane(tmux, marker) {
	return waitUntil(async () => {
		const pane = await capturePane(tmux);
		return pane.includes(marker) ? pane : false;
	});
}

function sanitizePane(text, root, threadId) {
	let sanitized = text;
	if (root) sanitized = sanitized.replaceAll(root, "<temp-root>");
	if (threadId) sanitized = sanitized.replaceAll(threadId, "<thread-id>");
	return (
		sanitized
			// biome-ignore lint/suspicious/noControlCharactersInRegex: tmux pane capture contains ANSI escape sequences.
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
			.split("\n")
			.filter((line) =>
				/codex-(raw|tui)-to-(tui|raw)|Codex|thread|remote/i.test(line),
			)
			.slice(-20)
			.join("\n")
	);
}

function disabledFeatures() {
	return [
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
	];
}

async function writeSyntheticAuth(authPath) {
	const encode = (value) =>
		Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	const idToken = `${encode({ alg: "none" })}.${encode({
		sub: "remote-claw-proof",
	})}.sig`;
	const syntheticAuth = {
		auth_mode: "chatgpt",
		OPENAI_API_KEY: null,
		tokens: {
			id_token: idToken,
			access_token: "remote-claw-proof-access",
			refresh_token: "remote-claw-proof-refresh",
			account_id: "proof-account",
		},
		last_refresh: null,
	};
	await writeFile(authPath, `${JSON.stringify(syntheticAuth)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
}

function isolatedEnvironment({
	allowLoopback,
	codexHome,
	denyPort,
	term,
	userHome,
}) {
	const proxy = `http://127.0.0.1:${denyPort}`;
	const noProxy = allowLoopback ? "127.0.0.1,localhost" : "";
	return {
		...allowlistedAmbientEnvironment(),
		ALL_PROXY: proxy,
		CODEX_HOME: codexHome,
		HOME: userHome,
		HTTP_PROXY: proxy,
		HTTPS_PROXY: proxy,
		NO_PROXY: noProxy,
		RUST_LOG: "warn",
		TERM: term,
		ZDOTDIR: userHome,
		all_proxy: proxy,
		http_proxy: proxy,
		https_proxy: proxy,
		no_proxy: noProxy,
	};
}

function allowlistedAmbientEnvironment() {
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
	assert(environment.PATH, "PATH is required");
	return environment;
}

async function inspectIsolation() {
	const parentNamespace = process.env[PARENT_NS];
	const probeNamespace = await readlink("/proc/self/ns/net");
	const interfaces = (await readFile("/proc/net/dev", "utf8"))
		.split("\n")
		.slice(2)
		.map((line) => line.split(":")[0].trim())
		.filter(Boolean)
		.sort();
	const routes = await readFile("/proc/net/route", "utf8");
	const defaultRoutePresent = routes
		.split("\n")
		.slice(1)
		.some((line) => line.trim().split(/\s+/)[1] === "00000000");
	assert(parentNamespace !== probeNamespace, "network namespace unchanged");
	assert(
		JSON.stringify(interfaces) === '["lo"]',
		`unexpected interfaces: ${interfaces}`,
	);
	assert(!defaultRoutePresent, "default route exists");
	return {
		parentNamespace,
		probeNamespace,
		distinctNetworkNamespace: true,
		interfaces,
		defaultRoutePresent,
	};
}

async function startDenyServer() {
	let attempts = 0;
	const sockets = new Set();
	const server = createServer((socket) => {
		attempts++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.destroy();
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		get attempts() {
			return attempts;
		},
		port: server.address().port,
		close: () =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(resolve);
			}),
	};
}

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function collectText(stream) {
	let text = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		text = `${text}${chunk}`.slice(-16_384);
	});
	return { text: () => text };
}

async function waitUntil(operation, timeout = TIMEOUT) {
	const deadline = Date.now() + timeout;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const result = await operation();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await delay(25);
	}
	throw lastError ?? new Error("wait timed out");
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
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
	for (const directory of requiredEnvironment("PATH").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			return realpath(candidate);
		} catch {}
	}
	throw new Error(`required executable not found on PATH: ${name}`);
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

async function checked(command, args, options = {}) {
	const result = await captured(command, args, options);
	if (result.code !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed ${result.code}: ${result.stderr}`,
		);
	}
	return result;
}

async function captured(command, args, options = {}) {
	const child = spawn(command, args, {
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exit = await onExit(child);
	const result = { ...exit, stdout, stderr };
	if (!options.allowFailure && exit.code !== 0) {
		throw new Error(`${command} failed ${exit.code}: ${stderr}`);
	}
	return result;
}

function onExit(child) {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null) {
			resolve({ code: child.exitCode, signal: child.signalCode });
			return;
		}
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

if (!process.env[MARKER]) {
	if (process.platform !== "linux") {
		throw new Error(
			"the real-TUI proof requires Linux user and network namespaces",
		);
	}
	const [codexBinary, unshareBinary, ipBinary, tmuxBinary, envBinary] =
		await Promise.all(
			["codex", "unshare", "ip", "tmux", "env"].map(resolveExecutable),
		);
	const parentNs = await readlink("/proc/self/ns/net");
	const childEnvironment = {
		...allowlistedAmbientEnvironment(),
		[MARKER]: "1",
		[PARENT_NS]: parentNs,
		[CODEX_BIN]: codexBinary,
		[ENV_BIN]: envBinary,
		[IP_BIN]: ipBinary,
		[TMUX_BIN]: tmuxBinary,
	};
	const child = spawn(
		unshareBinary,
		[
			"--user",
			"--map-current-user",
			"--keep-caps",
			"--net",
			"--fork",
			"--kill-child=SIGKILL",
			"--",
			envBinary,
			"-i",
			...Object.entries(childEnvironment).map(
				([name, value]) => `${name}=${value}`,
			),
			process.execPath,
			scriptPath,
		],
		{ stdio: "inherit" },
	);
	const exit = await onExit(child);
	process.exitCode = exit.code ?? 1;
} else {
	await run();
}
