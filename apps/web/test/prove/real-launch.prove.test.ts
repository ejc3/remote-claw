// OPT-IN PROOF: the installed, pinned real Claude binary crosses the production runRcLaunch boundary,
// speaks the authenticated native worker protocol through its process-scoped MITM, and completes one
// Viewer-originated turn through the real in-process Workflow broker. This deliberately makes one real
// inference call and therefore never runs unless RC_PROVE_REAL_CLAUDE=1 is explicitly present.
//
// The child runs under util-linux `script`, which gives all three child streams a PTY while discarding
// the TUI bytes. No prompt, response, credential, worker bearer, or trace body is printed; the owned
// 0600 route trace is removed with the proof root in the mandatory finally path.
// Run only on the retained, logged-in Linux/arm64 tuple:
//   RC_PROVE_REAL_CLAUDE=1 RC_PROVE_CLAUDE_CWD=/path/already/trusted/by/claude \
//     pnpm exec vitest run test/prove/real-launch.prove.test.ts
//
// This closes the installed-real-Claude/runRcLaunch leg. It does not claim the separate packaged-CLI,
// deployed-broker, or browser-rendering release proof described in docs/release-finish-line.md.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { stripVTControlCharacters } from "node:util";
import { formatPass } from "@remote-claw/clawsec";
import { runRcLaunch, type Session } from "@remote-claw/cli/rc";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { type Announce, type Message, Viewer } from "../../app/lib/viewer";
import { brokerFetch } from "../e2e/harness";
import { uniqueIdentity } from "../helpers";

const RUN = process.env.RC_PROVE_REAL_CLAUDE === "1";
const CODEWORD = "RC_REAL_LAUNCH_PROVED";
const configuredTurnTimeout = Number.parseInt(process.env.RC_PROVE_TURN_TIMEOUT_MS ?? "", 10);
const TURN_TIMEOUT_MS =
  Number.isSafeInteger(configuredTurnTimeout) && configuredTurnTimeout >= 1_000
    ? configuredTurnTimeout
    : 120_000;

interface TraceRecord {
  readonly target?: unknown;
  readonly msg?: unknown;
  readonly method?: unknown;
  readonly path?: unknown;
  readonly fields?: unknown;
  readonly reason?: unknown;
  readonly worker_status_type?: unknown;
  readonly worker_epoch_type?: unknown;
  readonly external_metadata_type?: unknown;
  readonly status?: unknown;
}

interface BrokerCall {
  readonly method: string;
  readonly path: string;
  readonly backend: string;
  readonly status: number;
  readonly durable?: boolean;
  readonly cursor?: number | null;
}

/** The direct route harness has no network socket whose close would propagate Request.signal into the
 * response body. Wrap its SSE body so an aborted BrokerClient read cancels the upstream route stream,
 * matching real fetch and releasing the SQLite subscriber lease during proof teardown. */
function withAbort(response: Response, signal: AbortSignal | null | undefined): Response {
  if (
    response.body === null ||
    signal === undefined ||
    signal === null ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  )
    return response;
  const reader = response.body.getReader();
  const aborted = Symbol("aborted");
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let onAbort: (() => void) | undefined;
      const abort = new Promise<typeof aborted>((resolve) => {
        if (signal.aborted) resolve(aborted);
        else {
          onAbort = () => resolve(aborted);
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const result = await Promise.race([reader.read(), abort]);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      if (result === aborted) {
        await reader.cancel().catch(() => undefined);
        controller.close();
      } else if (result.done) {
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function observedBrokerFetch(calls: BrokerCall[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    const response = await brokerFetch(input, init);
    let cursor: Pick<BrokerCall, "durable" | "cursor"> = {};
    if (url.pathname === "/api/seq" || url.pathname === "/api/frame-count") {
      const body = (await response.clone().json()) as {
        durable?: unknown;
        maxSeq?: unknown;
        frameCount?: unknown;
      };
      cursor = {
        ...(typeof body.durable === "boolean" ? { durable: body.durable } : {}),
        ...("maxSeq" in body
          ? { cursor: typeof body.maxSeq === "number" ? body.maxSeq : null }
          : "frameCount" in body
            ? { cursor: typeof body.frameCount === "number" ? body.frameCount : null }
            : {}),
      };
    }
    calls.push({
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      path: url.pathname,
      backend: headers.get("x-broker-backend") ?? "default",
      status: response.status,
      ...cursor,
    });
    return withAbort(response, init?.signal);
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function traceRecords(path: string): TraceRecord[] {
  if (!existsSync(path)) return [];
  const records: TraceRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      records.push(JSON.parse(line) as TraceRecord);
    } catch {
      // A concurrent append can expose one incomplete final line; the next poll rereads the file.
    }
  }
  return records;
}

function routeCount(tracePath: string, method: string, path: string): number {
  return traceRecords(tracePath).filter(
    (record) =>
      record.target === "rc.mitm" &&
      record.msg === "intercept" &&
      record.method === method &&
      record.path === path,
  ).length;
}

function tuiSignals(raw: string): Record<string, boolean | number> {
  const text = Array.from(stripVTControlCharacters(raw), (character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && character !== "\n" && character !== "\t") || code === 127
      ? " "
      : character;
  }).join("");
  return {
    bytes: Buffer.byteLength(raw, "utf8"),
    trustPrompt: /do you trust|trust the files|workspace trust/i.test(text),
    remoteControl: /remote control|remote-control/i.test(text),
    pressEnter: /press enter/i.test(text),
    loginPrompt: /log in|login required|authentication required/i.test(text),
    permissionPrompt: /permission|allow access/i.test(text),
    rateLimit: /rate limit|usage limit|limit reached/i.test(text),
    errorText: /\berror\b|failed to|something went wrong/i.test(text),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  assertLaunchAlive?: () => void,
  describe?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    assertLaunchAlive?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assertLaunchAlive?.();
  if (!predicate()) {
    const detail = describe?.();
    throw new Error(
      `timed out waiting for real-launch proof evidence${detail ? `: ${detail}` : ""}`,
    );
  }
}

function childPids(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isSafeInteger);
  } catch {
    return [];
  }
}

function descendants(pid: number): number[] {
  const found: number[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const child of childPids(current)) {
      if (found.includes(child)) continue;
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

function realClaudePid(scriptPid: number): number | undefined {
  return descendants(scriptPid).find((pid) => {
    try {
      return basename(readlinkSync(`/proc/${pid}/exe`))
        .toLowerCase()
        .includes("claude");
    } catch {
      return false;
    }
  });
}

function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return afterName[19]; // procfs field 22, after removing pid + parenthesized comm
  } catch {
    return undefined;
  }
}

function sameProcessAlive(pid: number, startTime: string): boolean {
  return processStartTime(pid) === startTime;
}

function proxyAgent(proxyPort: number, ca: Buffer): Agent {
  const agent = new Agent({ ca, keepAlive: false });
  (agent as unknown as { createConnection: unknown }).createConnection = (
    options: { host?: string; port?: number },
    callback: (error: Error | null, socket?: unknown) => void,
  ) => {
    const host = options.host ?? "api.anthropic.com";
    const port = options.port ?? 443;
    const raw = netConnect(proxyPort, "127.0.0.1", () => {
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let banner = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      banner = Buffer.concat([banner, chunk]);
      if (!banner.includes(Buffer.from("\r\n\r\n"))) return;
      raw.removeListener("data", onData);
      const tls = tlsConnect({ socket: raw, servername: host, ca }, () => callback(null, tls));
      tls.on("error", (error) => callback(error));
    };
    raw.on("data", onData);
    raw.on("error", (error) => callback(error));
  };
  return agent;
}

function rpcResponse(
  agent: Agent,
  method: string,
  path: string,
  body: unknown,
  workerToken?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpsRequest(
      {
        host: "api.anthropic.com",
        port: 443,
        method,
        path,
        agent: agent as RequestOptions["agent"],
        headers: {
          ...(payload === undefined
            ? {}
            : { "content-length": payload.length, "content-type": "application/json" }),
          ...(workerToken === undefined ? {} : { authorization: `Bearer ${workerToken}` }),
        },
      },
      (response: IncomingMessage) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function terminateProcessGroup(child: ChildProcess | null): Promise<void> {
  if (child?.pid === undefined || child.exitCode !== null) return;
  child.stdin?.destroy();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

afterAll(async () => {
  await teardownWorkflowTests();
});

describe.skipIf(!RUN)("PROVE: real Claude through source runRcLaunch", () => {
  it("binds its native worker stream to one cse and leaves the local process alive on terminal rejection", async () => {
    if (process.platform !== "linux") throw new Error("real-launch proof requires Linux procfs");

    const identity = await uniqueIdentity();
    const proofRoot = mkdtempSync(join(tmpdir(), "rc-real-launch-proof-"));
    const claudeCwd = process.env.RC_PROVE_CLAUDE_CWD ?? process.cwd();
    if (!existsSync(claudeCwd)) throw new Error("RC_PROVE_CLAUDE_CWD does not exist");
    const tracePath = join(proofRoot, "rc-trace.jsonl");
    const previousTraceEnv = {
      log: process.env.RC_LOG,
      file: process.env.RC_LOG_FILE,
      format: process.env.RC_LOG_FORMAT,
    };
    process.env.RC_LOG = "rc.mitm=debug";
    process.env.RC_LOG_FILE = tracePath;
    process.env.RC_LOG_FORMAT = "json";

    const brokerCalls: BrokerCall[] = [];
    const proofFetch = observedBrokerFetch(brokerCalls);
    const viewer = await Viewer.fromPass(
      await formatPass(identity),
      "http://broker",
      proofFetch,
      "sqlite",
    );
    const announceAbort = new AbortController();
    const transcriptAbort = new AbortController();
    const announces: Announce[] = [];
    const messages: Message[] = [];
    let streamError: unknown;
    let announceTask: Promise<void> = Promise.resolve();

    let scriptProcess: ChildProcess | null = null;
    let proxyPort = -1;
    let caPath = "";
    let registered: Session | null = null;
    let launchSettled = false;
    let launchFailed = false;
    let tuiTail = "";
    const captureTui = (chunk: Buffer) => {
      tuiTail = `${tuiTail}${chunk.toString("utf8")}`.slice(-262_144);
    };
    const launch = runRcLaunch({
      // Run without project customizations or tools: the proof needs inference + native RC only, and
      // must not mutate the trusted project used to bypass Claude's interactive workspace-trust gate.
      claudeArgs: ["--safe-mode", "--tools", "", "--remote-control", "remote-claw-proof"],
      identity,
      brokerUrl: "http://broker",
      backend: "sqlite",
      certsDir: join(proofRoot, "certs"),
      cwd: claudeCwd,
      fetchFn: proofFetch,
      onSession: (session) => {
        registered = session;
      },
      spawnClaude: (bin, args, env) =>
        new Promise<number>((resolve, reject) => {
          const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
          if (match === null || env.NODE_EXTRA_CA_CERTS === undefined) {
            reject(new Error("runRcLaunch did not provide its production proxy environment"));
            return;
          }
          proxyPort = Number.parseInt(match[1] as string, 10);
          caPath = env.NODE_EXTRA_CA_CERTS;
          const command = `exec ${[bin, ...args].map(shellQuote).join(" ")}`;
          const child = spawn("script", ["-qefc", command, "/dev/null"], {
            cwd: claudeCwd,
            detached: true,
            env: { ...env, TERM: "xterm-256color" },
            stdio: ["pipe", "pipe", "pipe"],
          });
          scriptProcess = child;
          child.stdout?.on("data", captureTui);
          child.stderr?.on("data", captureTui);
          child.once("error", reject);
          child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
        }),
    }).then(
      (code) => {
        launchSettled = true;
        if (code !== 0) launchFailed = true;
        return code;
      },
      () => {
        launchSettled = true;
        launchFailed = true;
        return 1;
      },
    );

    const assertLaunchAlive = () => {
      if (streamError !== undefined) throw new Error("viewer proof stream failed");
      if (launchSettled || launchFailed)
        throw new Error("real Claude exited before proof completed");
    };

    let agent: Agent | undefined;
    try {
      await waitFor(
        () => registered !== null && scriptProcess?.pid !== undefined,
        90_000,
        assertLaunchAlive,
        () => "session registration and PTY process",
      );
      const session = registered as unknown as Session;
      const scriptPid = (scriptProcess as ChildProcess | null)?.pid;
      if (scriptPid === undefined) throw new Error("PTY launcher did not expose its process id");
      await waitFor(
        () => realClaudePid(scriptPid) !== undefined,
        10_000,
        assertLaunchAlive,
        () => "real Claude descendant process",
      );
      const claudePid = realClaudePid(scriptPid);
      if (claudePid === undefined)
        throw new Error("real Claude process was not found below the PTY");
      const claudeStart = processStartTime(claudePid);
      if (claudeStart === undefined)
        throw new Error("real Claude process identity was not readable");

      const base = `/v1/code/sessions/${session.id}`;
      await waitFor(
        () =>
          routeCount(tracePath, "POST", "/v1/code/sessions") >= 1 &&
          routeCount(tracePath, "POST", `${base}/bridge`) >= 1 &&
          routeCount(tracePath, "GET", `${base}/worker/events/stream`) >= 1,
        90_000,
        assertLaunchAlive,
        () =>
          JSON.stringify({
            create: routeCount(tracePath, "POST", "/v1/code/sessions"),
            bridge: routeCount(tracePath, "POST", `${base}/bridge`),
            stream: routeCount(tracePath, "GET", `${base}/worker/events/stream`),
            delivery: routeCount(tracePath, "POST", `${base}/worker/events/delivery`),
          }),
      );
      // Tail the same explicitly selected durable backend as the host. Starting after the native worker
      // prerequisite is safe because SQLite replays an already-published announce from storage.
      announceTask = (async () => {
        try {
          for await (const announce of viewer.announces(announceAbort.signal))
            announces.push(announce);
        } catch (error) {
          streamError = error;
        }
      })();
      await waitFor(
        () => announces.some((announce) => announce.sessionId === session.id),
        30_000,
        () => {
          assertLaunchAlive();
          if (session.closed) {
            throw new Error(
              `native session closed before broker announce: ${JSON.stringify({
                delivery: routeCount(tracePath, "POST", `${base}/worker/events/delivery`),
                workerEvents: routeCount(tracePath, "POST", `${base}/worker/events`),
                workerPuts: routeCount(tracePath, "PUT", `${base}/worker`),
                invalidStatus: traceRecords(tracePath)
                  .filter((record) => record.msg === "invalid worker update — closing session")
                  .map((record) => ({
                    reason: record.reason,
                    fields: record.fields,
                    workerStatusType: record.worker_status_type,
                    workerEpochType: record.worker_epoch_type,
                    externalMetadataType: record.external_metadata_type,
                  })),
                brokerCalls,
              })}`,
            );
          }
        },
        () =>
          JSON.stringify({
            announces: announces.length,
            calls: Object.fromEntries(
              [...new Set(brokerCalls.map((call) => JSON.stringify(call)))].map((key) => [
                key,
                brokerCalls.filter((call) => JSON.stringify(call) === key).length,
              ]),
            ),
          }),
      );

      const transcriptTask = (async () => {
        try {
          for await (const message of viewer.transcript(session.id, transcriptAbort.signal)) {
            messages.push(message);
          }
        } catch (error) {
          streamError = error;
        }
      })();
      const deliveryBefore = routeCount(tracePath, "POST", `${base}/worker/events/delivery`);
      const eventPostsBefore = routeCount(tracePath, "POST", `${base}/worker/events`);

      await viewer.sendPrompt(session.id, `Reply with exactly: ${CODEWORD}`);
      await waitFor(
        () =>
          messages.some(
            (message) => message.kind === "assistant" && message.text.includes(CODEWORD),
          ) && messages.some((message) => message.kind === "result"),
        TURN_TIMEOUT_MS,
        assertLaunchAlive,
        () =>
          JSON.stringify({
            sessionClosed: session.closed,
            closeReason: session.closeReason,
            delivery: routeCount(tracePath, "POST", `${base}/worker/events/delivery`),
            workerEvents: routeCount(tracePath, "POST", `${base}/worker/events`),
            workerPuts: routeCount(tracePath, "PUT", `${base}/worker`),
            heartbeat: routeCount(tracePath, "POST", `${base}/worker/heartbeat`),
            inferenceRequests: traceRecords(tracePath).filter(
              (record) => record.msg === "inference passthrough",
            ).length,
            inferenceStatuses: traceRecords(tracePath)
              .filter((record) => record.msg === "inference passthrough response")
              .map((record) => record.status),
            messageKinds: messages.map((message) => message.kind),
            upstreamKinds: session.snapshotUpstream().map((event) => event.eventType),
            tui: tuiSignals(tuiTail),
          }),
      );
      await waitFor(
        () =>
          routeCount(tracePath, "POST", `${base}/worker/events/delivery`) > deliveryBefore &&
          routeCount(tracePath, "POST", `${base}/worker/events`) > eventPostsBefore &&
          session.snapshotUpstream().some((event) => event.eventType === "assistant") &&
          session.snapshotUpstream().some((event) => event.eventType === "result"),
        30_000,
        assertLaunchAlive,
      );
      await waitFor(
        () => routeCount(tracePath, "POST", `${base}/worker/heartbeat`) >= 1,
        45_000,
        assertLaunchAlive,
      );

      agent = proxyAgent(proxyPort, readFileSync(caPath));
      const unauthorized = await rpcResponse(agent, "POST", `${base}/worker/events`, {
        worker_epoch: 1,
        events: [],
      });
      expect(unauthorized).toBe(401);
      expect(session.closed).toBe(false);

      const mismatched = await rpcResponse(
        agent,
        "POST",
        `${base}/worker/events`,
        {
          worker_epoch: 1,
          events: [
            {
              payload: {
                uuid: "77777777-7777-4777-8777-777777777777",
                type: "assistant",
                session_id: "cse_deliberately_not_the_path_session",
              },
            },
          ],
        },
        session.workerToken,
      );
      expect(mismatched).toBe(400);
      expect(session.closed).toBe(true);
      expect(await rpcResponse(agent, "GET", base, undefined, session.workerToken)).toBe(410);

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(sameProcessAlive(claudePid, claudeStart)).toBe(true);
      expect(launchSettled).toBe(false);
      expect(launchFailed).toBe(false);
      transcriptAbort.abort();
      await transcriptTask;
    } finally {
      announceAbort.abort();
      transcriptAbort.abort();
      agent?.destroy();
      await terminateProcessGroup(scriptProcess);
      await launch;
      await announceTask;
      if (previousTraceEnv.log === undefined) delete process.env.RC_LOG;
      else process.env.RC_LOG = previousTraceEnv.log;
      if (previousTraceEnv.file === undefined) delete process.env.RC_LOG_FILE;
      else process.env.RC_LOG_FILE = previousTraceEnv.file;
      if (previousTraceEnv.format === undefined) delete process.env.RC_LOG_FORMAT;
      else process.env.RC_LOG_FORMAT = previousTraceEnv.format;
      rmSync(proofRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
