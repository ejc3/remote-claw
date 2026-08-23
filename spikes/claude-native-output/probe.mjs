#!/usr/bin/env node

// Preload used only for the live Claude Code compatibility proof. It patches the Node built-in HTTPS
// client used by MitmProxy's transparent trace mode. One HTTP-200 Anthropic worker-events response
// is fully buffered, then the matching downstream ServerResponse is destroyed synchronously before
// writeHead can emit any bytes. Raw request/response bodies remain memory-only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BODY_CAP = 1024 * 1024;
const NO_RETRY_WINDOW_MS = 120_000;
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_EVENTS =
	/^\/v1\/code\/sessions\/([^/?]+)\/worker\/events(?:\?.*)?$/;
const outputPath = resolve(process.env.RC_NATIVE_OUTPUT_PROOF ?? "");
const matchType = process.env.RC_NATIVE_OUTPUT_MATCH_TYPE ?? "assistant";
const coverageMode = matchType === "__no_fault__";

if (process.env.RC_NATIVE_OUTPUT_PROOF === undefined || outputPath === "") {
	throw new Error(
		"RC_NATIVE_OUTPUT_PROOF must name a new sanitized evidence file",
	);
}
if ((process.env.RC_CLAUDE_BIN ?? "").trim() !== "") {
	throw new Error(
		"RC_CLAUDE_BIN must be unset so the hashed PATH-resolved Claude is the launched Claude",
	);
}

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
chmodSync(dirname(outputPath), 0o700);
try {
	readFileSync(outputPath);
	throw new Error(`refusing to overwrite existing evidence: ${outputPath}`);
} catch (error) {
	if (error?.code !== "ENOENT") throw error;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const commandOutput = (bin, args) =>
	execFileSync(bin, args, { encoding: "utf8" }).trim();
const claudeLauncher = commandOutput("which", ["claude"]);
const claudeBinary = realpathSync(claudeLauncher);
const claudeVersion = commandOutput(claudeBinary, ["--version"]);
const claudeBinarySha256 = commandOutput("sha256sum", [claudeBinary]).split(
	/\s+/,
	1,
)[0];
const claudePackageManifest = join(
	dirname(dirname(claudeBinary)),
	"package.json",
);
const claudePackageManifestJson = JSON.parse(
	readFileSync(claudePackageManifest, "utf8"),
);
const claudePackageManifestSha256 = sha256(readFileSync(claudePackageManifest));
const sourceCommit = commandOutput("git", ["rev-parse", "HEAD"]);
const sourceRoot = commandOutput("git", ["rev-parse", "--show-toplevel"]);
const runtimeSourceFiles = [
	"packages/cli/src/host/rc/mitm.ts",
	"packages/cli/src/host/rc/trace-run.ts",
	"packages/cli/src/run.ts",
];
const runtimeSourceSha256 = Object.fromEntries(
	runtimeSourceFiles.map((file) => [
		file,
		sha256(readFileSync(join(sourceRoot, file))),
	]),
);
const nodeVersion = process.version;
const probeSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));

const originalRequest = https.request;
const originalWriteHead = http.ServerResponse.prototype.writeHead;
const coordinateAliases = new Map();
const sessionAliases = new Map();
const workerEpochAliases = new Map();
const firstPayloadHashByCoordinate = new Map();
const typeCounts = new Map();
const attemptSummaries = [];
let coordinateCollisions = 0;
let malformedWorkerBodies = 0;
let bodyCapExceeded = false;
let nextAttempt = 1;
let dropArmed = true;
let dropCompleted = false;
let writeHeadIntercepted = false;
let downstreamRequestMatched = false;
let downstreamHeadersSentBeforeReset = null;
let downstreamWritableBytesBeforeReset = null;
let droppedBody = null;
let droppedResponse = null;
let retryObserved = false;
let retryBodyEqual = false;
let retryTypeVectorEqual = false;
let retryUuidVectorEqual = false;
let retryWorkerEpochEqual = false;
let retrySameSession = false;
let retryStatus = null;
let exactRetryCount = 0;
let dropMonotonicMs = null;
let noRetryWindowReached = false;
let postDropAttemptCount = 0;
let postDropNewEventCount = 0;
let postDropSameCoordinateCount = 0;
let postDropSameSemanticPayloadCount = 0;
let droppedSemanticHashes = new Set();
let droppedCoordinates = new Set();
const anthropicVersions = new Set();
let observationTimer = null;

const aliasCoordinate = (uuid) => {
	const existing = coordinateAliases.get(uuid);
	if (existing !== undefined) return existing;
	const alias = `uuid-${coordinateAliases.size + 1}`;
	coordinateAliases.set(uuid, alias);
	return alias;
};

const aliasSession = (sessionId) => {
	const existing = sessionAliases.get(sessionId);
	if (existing !== undefined) return existing;
	const alias = `session-${sessionAliases.size + 1}`;
	sessionAliases.set(sessionId, alias);
	return alias;
};

const aliasWorkerEpoch = (workerEpoch) => {
	const key = JSON.stringify(workerEpoch);
	const existing = workerEpochAliases.get(key);
	if (existing !== undefined) return existing;
	const alias = `worker-epoch-${workerEpochAliases.size + 1}`;
	workerEpochAliases.set(key, alias);
	return alias;
};

const parseWorkerBody = (body) => {
	let parsed;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		malformedWorkerBodies += 1;
		return null;
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!Array.isArray(parsed.events)
	) {
		malformedWorkerBodies += 1;
		return null;
	}
	const events = parsed.events.map((event) => {
		const payload =
			event !== null && typeof event === "object" && event.payload !== null
				? event.payload
				: {};
		const encoded = Buffer.from(JSON.stringify(payload));
		const semanticPayload = { ...payload };
		delete semanticPayload.uuid;
		const uuid = typeof payload.uuid === "string" ? payload.uuid : "";
		return {
			alias: uuid === "" ? "missing" : aliasCoordinate(uuid),
			payloadBytes: encoded.length,
			payloadHash: sha256(encoded),
			semanticPayloadHash: sha256(Buffer.from(JSON.stringify(semanticPayload))),
			payloadKeys: Object.keys(payload).sort(),
			type: typeof payload.type === "string" ? payload.type : "unknown",
			uuid,
			uuidV4: UUID_V4.test(uuid),
		};
	});
	return {
		events,
		workerEpoch: parsed.worker_epoch,
		workerEpochPresent: Object.hasOwn(parsed, "worker_epoch"),
		workerEpochType: typeof parsed.worker_epoch,
	};
};

const observeFirstArrivals = (parsed) => {
	if (parsed === null) return;
	for (const event of parsed.events) {
		const previous = firstPayloadHashByCoordinate.get(event.uuid);
		if (previous === undefined) {
			firstPayloadHashByCoordinate.set(event.uuid, event.payloadHash);
			typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
		} else if (previous !== event.payloadHash) {
			coordinateCollisions += 1;
		}
	}
};

const sanitizedEvents = (parsed) =>
	parsed?.events.map((event) => ({
		coordinate: event.alias,
		payloadBytes: event.payloadBytes,
		payloadSha256: event.payloadHash,
		topLevelKeys: event.payloadKeys,
		type: event.type,
		uuidSyntax: event.uuidV4 ? "uuid-v4" : "invalid",
	})) ?? [];

const sanitizedWorkerEpoch = (parsed) => ({
	alias:
		parsed?.workerEpochPresent === true
			? aliasWorkerEpoch(parsed.workerEpoch)
			: "missing",
	present: parsed?.workerEpochPresent === true,
	type: parsed?.workerEpochType ?? "undefined",
});

const armDownstreamReset = (invokeMitmCallback) => {
	let consumed = false;
	http.ServerResponse.prototype.writeHead = function patchedWriteHead() {
		consumed = true;
		writeHeadIntercepted = true;
		http.ServerResponse.prototype.writeHead = originalWriteHead;
		syncBuiltinESMExports();
		const requestPath = String(this.req?.url ?? "");
		downstreamRequestMatched =
			this.req?.method === "POST" && WORKER_EVENTS.test(requestPath);
		downstreamHeadersSentBeforeReset = this.headersSent;
		downstreamWritableBytesBeforeReset = this.writableLength;
		if (
			!downstreamRequestMatched ||
			downstreamHeadersSentBeforeReset ||
			downstreamWritableBytesBeforeReset !== 0
		) {
			throw new Error(
				"probe intercepted an unexpected or already-started downstream response",
			);
		}
		this.destroy();
		return this;
	};
	syncBuiltinESMExports();
	try {
		invokeMitmCallback();
	} finally {
		if (!consumed) {
			http.ServerResponse.prototype.writeHead = originalWriteHead;
			syncBuiltinESMExports();
			throw new Error(
				"probe failed to intercept the synchronous downstream writeHead",
			);
		}
	}
};

https.request = function patchedHttpsRequest(options, callback) {
	const method = String(options?.method ?? "GET");
	const path = String(options?.path ?? "");
	const match = method === "POST" ? WORKER_EVENTS.exec(path) : null;
	if (match === null || typeof callback !== "function") {
		return originalRequest.apply(this, arguments);
	}
	const headers = options?.headers ?? {};
	for (const [name, value] of Object.entries(headers)) {
		if (
			name.toLowerCase() === "anthropic-version" &&
			typeof value === "string"
		) {
			anthropicVersions.add(value);
		}
	}

	const current = {
		attempt: nextAttempt++,
		bodyChunks: [],
		bodyTooLarge: false,
		sessionId: match[1] ?? "unknown",
	};

	const wrappedCallback = (response) => {
		const requestBody = Buffer.concat(current.bodyChunks);
		const parsed = current.bodyTooLarge ? null : parseWorkerBody(requestBody);
		observeFirstArrivals(parsed);
		const bodyHash = current.bodyTooLarge ? "omitted" : sha256(requestBody);
		const uuidVector = parsed?.events.map((event) => event.uuid) ?? [];
		const shouldDrop =
			dropArmed &&
			!current.bodyTooLarge &&
			(response.statusCode ?? 0) >= 200 &&
			(response.statusCode ?? 0) < 300 &&
			parsed !== null &&
			parsed.events.some((event) => event.type === matchType) &&
			parsed.events.every((event) => event.uuidV4);

		if (shouldDrop) {
			dropArmed = false;
			const responseChunks = [];
			response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
			response.once("end", () => {
				const responseBody = Buffer.concat(responseChunks);
				droppedBody = {
					body: requestBody,
					hash: bodyHash,
					sessionId: current.sessionId,
					typeVector: parsed.events.map((event) => event.type),
					uuidVector,
					workerEpoch: parsed.workerEpoch,
					workerEpochPresent: parsed.workerEpochPresent,
					workerEpochType: parsed.workerEpochType,
				};
				droppedResponse = {
					body: responseBody,
					bytes: responseBody.length,
					hash: sha256(responseBody),
					status: response.statusCode ?? 0,
				};
				droppedCoordinates = new Set(parsed.events.map((event) => event.uuid));
				droppedSemanticHashes = new Set(
					parsed.events.map((event) => event.semanticPayloadHash),
				);
				armDownstreamReset(() => callback(response));
				attemptSummaries.push({
					attempt: current.attempt,
					bodyBytes: requestBody.length,
					bodySha256: bodyHash,
					downstreamHeadersSentBeforeReset,
					downstreamRequestMatched,
					downstreamWritableBytesBeforeReset,
					events: sanitizedEvents(parsed),
					localResponseDisposition: "reset-before-headers",
					session: aliasSession(current.sessionId),
					upstreamResponseBytes: responseBody.length,
					upstreamResponseSha256: sha256(responseBody),
					upstreamStatus: response.statusCode ?? 0,
					workerEpoch: sanitizedWorkerEpoch(parsed),
				});
				dropCompleted = true;
				dropMonotonicMs = performance.now();
				observationTimer = setTimeout(() => {
					observationTimer = null;
					noRetryWindowReached = true;
					process.stderr.write(
						`remote-claw native-output proof: ${NO_RETRY_WINDOW_MS / 1000}s observation window complete\n`,
					);
				}, NO_RETRY_WINDOW_MS);
				process.stderr.write(
					`remote-claw native-output proof: HTTP-200 ${matchType} response reset before downstream headers; awaiting Claude retry\n`,
				);
			});
			response.resume();
			return;
		}

		const responseChunks = [];
		response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
		response.once("end", () => {
			const responseBody = Buffer.concat(responseChunks);
			const isRetry = droppedBody !== null && bodyHash === droppedBody.hash;
			if (dropCompleted) {
				postDropAttemptCount += 1;
				for (const event of parsed?.events ?? []) {
					if (droppedCoordinates.has(event.uuid))
						postDropSameCoordinateCount += 1;
					if (droppedSemanticHashes.has(event.semanticPayloadHash)) {
						postDropSameSemanticPayloadCount += 1;
					} else {
						postDropNewEventCount += 1;
					}
				}
			}
			if (isRetry) {
				if (observationTimer !== null) {
					clearTimeout(observationTimer);
					observationTimer = null;
				}
				exactRetryCount += 1;
				retryObserved = true;
				retryBodyEqual = requestBody.equals(droppedBody.body);
				const typeVector = parsed?.events.map((event) => event.type) ?? [];
				retryTypeVectorEqual =
					typeVector.length === droppedBody.typeVector.length &&
					typeVector.every(
						(type, index) => type === droppedBody.typeVector[index],
					);
				retryUuidVectorEqual =
					uuidVector.length === droppedBody.uuidVector.length &&
					uuidVector.every(
						(uuid, index) => uuid === droppedBody.uuidVector[index],
					);
				retrySameSession = current.sessionId === droppedBody.sessionId;
				retryWorkerEpochEqual =
					parsed?.workerEpochPresent === true &&
					droppedBody.workerEpochPresent &&
					parsed.workerEpochType === droppedBody.workerEpochType &&
					parsed.workerEpoch === droppedBody.workerEpoch;
				retryStatus = response.statusCode ?? 0;
				process.stderr.write(
					"remote-claw native-output proof: Claude emitted a byte-identical same-session retry\n",
				);
			}
			attemptSummaries.push({
				attempt: current.attempt,
				bodyBytes: requestBody.length,
				bodySha256: bodyHash,
				downstreamHeadersSentBeforeReset: null,
				downstreamRequestMatched: null,
				downstreamWritableBytesBeforeReset: null,
				events: sanitizedEvents(parsed),
				localResponseDisposition: "forwarded",
				session: aliasSession(current.sessionId),
				upstreamResponseBytes: responseBody.length,
				upstreamResponseSha256: sha256(responseBody),
				upstreamStatus: response.statusCode ?? 0,
				workerEpoch: sanitizedWorkerEpoch(parsed),
			});
		});
		callback(response);
	};

	const request = originalRequest.call(this, options, wrappedCallback);
	const originalWrite = request.write.bind(request);
	request.write = (chunk, encoding, done) => {
		const copy = Buffer.isBuffer(chunk)
			? Buffer.from(chunk)
			: chunk instanceof Uint8Array
				? Buffer.from(chunk)
				: Buffer.from(String(chunk), encoding);
		if (
			!current.bodyTooLarge &&
			current.bodyChunks.reduce((sum, item) => sum + item.length, 0) +
				copy.length <=
				BODY_CAP
		) {
			current.bodyChunks.push(copy);
		} else {
			current.bodyTooLarge = true;
			current.bodyChunks = [];
			bodyCapExceeded = true;
		}
		return originalWrite(chunk, encoding, done);
	};
	return request;
};
syncBuiltinESMExports();

process.once("exit", () => {
	http.ServerResponse.prototype.writeHead = originalWriteHead;
	https.request = originalRequest;
	syncBuiltinESMExports();

	const firstEvents = [...firstPayloadHashByCoordinate.keys()].filter(
		(uuid) => uuid !== "",
	);
	const observationWindowMs =
		dropMonotonicMs === null
			? 0
			: Math.max(0, Math.floor(performance.now() - dropMonotonicMs));
	const positiveRetryVerdict =
		dropCompleted &&
		writeHeadIntercepted &&
		downstreamRequestMatched &&
		downstreamHeadersSentBeforeReset === false &&
		downstreamWritableBytesBeforeReset === 0 &&
		retryObserved &&
		retryBodyEqual &&
		retryTypeVectorEqual &&
		retryUuidVectorEqual &&
		retryWorkerEpochEqual &&
		retrySameSession;
	const negativeRetryVerdict =
		dropCompleted &&
		writeHeadIntercepted &&
		noRetryWindowReached &&
		observationWindowMs >= NO_RETRY_WINDOW_MS &&
		!retryObserved &&
		postDropAttemptCount > 0 &&
		postDropNewEventCount > 0 &&
		postDropSameCoordinateCount === 0 &&
		postDropSameSemanticPayloadCount === 0;
	const evidence = {
		proofSchemaId: "remote-claw/retained-claude-native-output-proof/v2",
		capturedAt: new Date().toISOString(),
		proofScope: coverageMode
			? "Claude native worker-event UUID presence and first-arrival uniqueness across stable text and question-control scenarios"
			: "Claude native worker-event UUID presence, uniqueness, and exact request-body retry after a lost accepted response",
		scopeLimits: {
			claudeProcessIdentityObserved: false,
			crossVersionClaim: false,
			nativeApplicationClaim: false,
			scenarioBound: true,
			serverDedupClaim: false,
			singleTraceWrapperRun: true,
		},
		probe: {
			file: "probe.mjs",
			nodeVersion,
			sha256: probeSha256,
			sourceCommit,
		},
		remoteClaw: {
			claudeCommandOverrideAbsent: true,
			runtimeSourceSha256,
		},
		claude: {
			architecture: process.arch,
			binaryBytes: statSync(claudeBinary).size,
			executableSha256: claudeBinarySha256,
			launcherPath: "<claude-launcher>",
			packageManifestPath: "<claude-package-manifest>",
			packageManifestSha256: claudePackageManifestSha256,
			packageVersion: claudePackageManifestJson.version,
			platform: process.platform,
			resolvedBinaryPath: "<claude-binary>",
			version: claudeVersion,
		},
		protocol: {
			anthropicVersions: [...anthropicVersions].sort(),
			endpoint: "/v1/code/sessions/{id}/worker/events",
			requestBodyCapBytes: BODY_CAP,
		},
		attempts: attemptSummaries,
		payloadTypes: Object.fromEntries([...typeCounts.entries()].sort()),
		firstArrivals: {
			allPayloadUuidsRfc4122V4:
				firstEvents.length === firstPayloadHashByCoordinate.size &&
				firstEvents.every((uuid) => UUID_V4.test(uuid)),
			coordinateCollisionCount: coordinateCollisions,
			distinctPayloadUuidCount: firstEvents.length,
			eventCount: firstPayloadHashByCoordinate.size,
			malformedWorkerBodies,
		},
		lostResponseRetry: {
			completeRequestBodyByteEqual: retryBodyEqual,
			downstreamHeadersSentBeforeReset,
			downstreamRequestMatched,
			downstreamWritableBytesBeforeReset,
			firstUpstreamResponseFullyBuffered: droppedResponse !== null,
			firstUpstreamResponseBytes: droppedResponse?.bytes ?? 0,
			firstUpstreamResponseSha256: droppedResponse?.hash ?? "",
			firstUpstreamStatus: droppedResponse?.status ?? 0,
			exactRetryCount,
			orderedPayloadTypesEqual: retryTypeVectorEqual,
			orderedPayloadUuidsEqual: retryUuidVectorEqual,
			noRetryObservationWindowMs: observationWindowMs,
			noRetryRequiredWindowMs: NO_RETRY_WINDOW_MS,
			noRetryWindowReached,
			postDropAttemptCount,
			postDropNewEventCount,
			postDropSameCoordinateCount,
			postDropSameSemanticPayloadCount,
			retryObserved,
			retryForwardedUpstream: retryObserved,
			retrySameRemoteSession: retrySameSession,
			retryUpstreamStatus: retryStatus,
			workerEpochEqual: retryWorkerEpochEqual,
			writeHeadIntercepted,
		},
		sanitization: {
			conversationContentRetained: false,
			credentialValuesRetained: false,
			hostPathsRetained: false,
			nativeIdentifiersRetained: false,
			rawRequestBodiesWritten: false,
			rawResponseBodiesWritten: false,
		},
		diagnostics: {
			attemptCount: attemptSummaries.length,
			bodyCapExceeded,
			dropCompleted,
			matchedType: matchType,
			mode: coverageMode ? "coordinate-coverage" : "lost-response-retry",
		},
		verdict:
			coordinateCollisions !== 0 ||
			bodyCapExceeded ||
			malformedWorkerBodies !== 0
				? "incomplete"
				: coverageMode && firstPayloadHashByCoordinate.size > 0
					? "event-coordinate-coverage-observed"
					: positiveRetryVerdict
						? "retry-coordinate-preserved"
						: negativeRetryVerdict
							? "no-retry-observed"
							: "incomplete",
	};
	writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	chmodSync(outputPath, 0o600);
});
