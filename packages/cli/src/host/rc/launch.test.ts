// Launch-path wiring test: runRcLaunch must stand up the MITM and hand the child claude a proxy env
// that points at it (HTTPS_PROXY) and trusts our CA (NODE_EXTRA_CA_CERTS), then tear it down on exit.
// The session→broker behavior is covered by mitm.test.ts + the apps/web rc-spine e2e; here we pin the
// contract the child relies on. Skips cleanly if openssl is unavailable.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import {
  deriveIdentity,
  type FrameHeader,
  formatSecret,
  type Identity,
  toHex,
  utf8,
} from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import { BrokerClient } from "../../broker/client.js";
import { MockBroker } from "../../broker/mockbroker.js";
import { assertNoSecretLeak } from "../../secretleak.js";
import { securityProvider } from "../../security/provider.js";
import { MITM_HOST } from "./certs.js";
import { runRcLaunch } from "./launch.js";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const RUN = haveOpenssl();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rc-launch-"));
  dirs.push(d);
  return d;
}

/** True if a TCP connect to 127.0.0.1:port succeeds (the proxy is listening). */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

/** An https.Agent that tunnels through the launch MITM via CONNECT, trusting its generated CA. */
function proxyAgent(proxyPort: number, ca: Buffer) {
  const agent = new Agent({ ca, keepAlive: false });
  (agent as unknown as { createConnection: unknown }).createConnection = (
    opts: { host?: string; port?: number },
    cb: (err: Error | null, sock?: unknown) => void,
  ) => {
    const host = opts.host ?? MITM_HOST;
    const port = opts.port ?? 443;
    const raw = netConnect(proxyPort, "127.0.0.1", () => {
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let banner = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      banner = Buffer.concat([banner, chunk]);
      if (banner.includes(Buffer.from("\r\n\r\n"))) {
        raw.removeListener("data", onData);
        const tls = tlsConnect({ socket: raw, servername: host, ca }, () => cb(null, tls));
        tls.on("error", (e) => cb(e));
      }
    };
    raw.on("data", onData);
    raw.on("error", (e) => cb(e));
  };
  return agent;
}

function rpc(
  agent: unknown,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const opts: RequestOptions = {
      host: MITM_HOST,
      port: 443,
      method,
      path,
      agent: agent as RequestOptions["agent"],
      headers: {
        "content-type": "application/json",
        ...(payload ? { "content-length": payload.length } : {}),
      },
    };
    const req = httpsRequest(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openWorkerStream(
  agent: unknown,
  sessionId: string,
  onEvent: (ev: Record<string, unknown>) => void,
): () => void {
  const opts: RequestOptions = {
    host: MITM_HOST,
    port: 443,
    method: "GET",
    path: `/v1/code/sessions/${sessionId}/worker/events/stream`,
    agent: agent as RequestOptions["agent"],
    headers: { accept: "text/event-stream" },
  };
  const req = httpsRequest(opts, (res: IncomingMessage) => {
    let buf = "";
    res.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let nl = buf.indexOf("\n\n");
      while (nl !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) {
          try {
            onEvent(JSON.parse(dataLine.slice(6)));
          } catch {
            // Ignore malformed keepalive/debug lines; the test waits on typed events.
          }
        }
        nl = buf.indexOf("\n\n");
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return () => req.destroy();
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!pred()) throw new Error("timed out");
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

function clientHeader(
  id: Identity,
  sessionId: string,
  recordKind: string,
  msgId: string,
  extra: Partial<FrameHeader> = {},
): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId,
    dir: "in",
    recordKind,
    seq: null,
    msgId,
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...extra,
  };
}

function assertNoSensitiveMaterial(
  text: string,
  id: Identity,
  secret: { token: string; secret: Uint8Array },
): void {
  assertNoSecretLeak(text, secret);
  const rawSecret = Buffer.from(secret.secret).toString("utf8");
  if (rawSecret !== "") expect(text).not.toContain(rawSecret);
  for (const [label, needle] of [
    ["auth bearer", toHex(id.authToken)],
    ["control key", toHex(id.controlKey)],
    ["meta key", toHex(id.kMeta)],
    ["content root", toHex(id.contentRoot)],
  ]) {
    expect(text, `${label} leaked`).not.toContain(needle);
  }
}

describe.skipIf(!RUN)("runRcLaunch wiring", () => {
  it("spawns claude with HTTPS_PROXY → a live MITM + NODE_EXTRA_CA_CERTS → our CA, then tears down", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(70));
    const certsDir = tmp();

    let seenEnv: NodeJS.ProcessEnv | null = null;
    let proxyPortDuringSpawn = -1;
    let openDuringSpawn = false;

    const code = await runRcLaunch({
      claudeArgs: ["--model", "opus", "chat"],
      identity: id,
      brokerUrl: "http://broker.example",
      certsDir,
      spawnClaude: async (bin, args, env) => {
        seenEnv = env;
        expect(bin).toBe("claude");
        expect(args).toEqual(["--model", "opus", "chat"]);
        // The proxy URL the child will route HTTPS through, and the proxy must be LIVE right now.
        const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
        proxyPortDuringSpawn = m ? Number.parseInt(m[1] as string, 10) : -1;
        openDuringSpawn = proxyPortDuringSpawn > 0 && (await portOpen(proxyPortDuringSpawn));
        return 7; // claude's exit code propagates
      },
    });

    expect(code).toBe(7);
    expect(seenEnv).not.toBeNull();
    const env = seenEnv as unknown as NodeJS.ProcessEnv;
    // Both proxy env forms set (some stacks read the lowercase one).
    expect(env.HTTPS_PROXY).toBe(env.https_proxy);
    // CA points at a real file under our certs dir (the child trusts our leaf via it).
    expect(env.NODE_EXTRA_CA_CERTS).toBe(join(certsDir, "ca.pem"));
    expect(existsSync(env.NODE_EXTRA_CA_CERTS as string)).toBe(true);
    // The MITM was listening during the child's lifetime…
    expect(openDuringSpawn).toBe(true);
    // …and is torn down once the child exits.
    expect(await portOpen(proxyPortDuringSpawn)).toBe(false);
  }, 20_000);

  it("scrubs host-only secrets from the child env (Sec-env) but keeps the proxy env", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(71));
    const certsDir = tmp();
    const prevSecret = process.env.REMOTE_CLAW_SECRET_FILE;
    const prevBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    process.env.REMOTE_CLAW_SECRET_FILE = "/home/u/.local/state/remote-claw/secret";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-should-not-reach-child";
    let seenEnv: NodeJS.ProcessEnv | null = null;
    try {
      await runRcLaunch({
        claudeArgs: [],
        identity: id,
        brokerUrl: "http://broker.example",
        certsDir,
        spawnClaude: async (_bin, _args, env) => {
          seenEnv = env;
          return 0;
        },
      });
    } finally {
      if (prevSecret === undefined) delete process.env.REMOTE_CLAW_SECRET_FILE;
      else process.env.REMOTE_CLAW_SECRET_FILE = prevSecret;
      if (prevBypass === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = prevBypass;
    }
    const env = seenEnv as unknown as NodeJS.ProcessEnv;
    // The host-only secrets are gone from what the child claude sees…
    expect(env.REMOTE_CLAW_SECRET_FILE).toBeUndefined();
    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBeUndefined();
    // …but the proxy env the child genuinely needs survives.
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 20_000);

  it("scrubs the launching claude's session identity so the child is a real, fresh claude (not a stub)", async () => {
    // When remote-claw is started from INSIDE a claude session, CLAUDE_CODE_CHILD_SESSION makes the
    // spawned claude a STUB bridged to the parent (the MITM would never drive a real session), and
    // CLAUDE_CODE_SESSION_ID pins/resumes the parent's id. Both must be stripped from the child env so
    // our claude mints its own fresh cse_ session.
    const id = await deriveIdentity(new Uint8Array(32).fill(72));
    const certsDir = tmp();
    const prevChild = process.env.CLAUDE_CODE_CHILD_SESSION;
    const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "parent-session-should-not-reach-child";
    let seenEnv: NodeJS.ProcessEnv | null = null;
    try {
      await runRcLaunch({
        claudeArgs: [],
        identity: id,
        brokerUrl: "http://broker.example",
        certsDir,
        spawnClaude: async (_bin, _args, env) => {
          seenEnv = env;
          return 0;
        },
      });
    } finally {
      if (prevChild === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
      else process.env.CLAUDE_CODE_CHILD_SESSION = prevChild;
      if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
    }
    const env = seenEnv as unknown as NodeJS.ProcessEnv;
    // The launching session's identity is gone from what the child claude sees…
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    // …but the proxy env the child genuinely needs survives.
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 20_000);

  it("awaits relay pumps on teardown so a final outbound frame flushes", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(73));
    const certsDir = tmp();
    const broker = new MockBroker();
    broker.requireAuth(id.authToken);

    let releaseAssistantPost: () => void = () => {};
    let assistantPostStarted: Promise<void>;
    let resolveAssistantPostStarted: () => void = () => {};
    assistantPostStarted = new Promise((resolve) => {
      resolveAssistantPostStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseAssistantPost = resolve;
    });
    let delayed = false;

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const body = String(init?.body ?? "");
      if (url.pathname === "/api/relay" && url.searchParams.has("session") && !delayed) {
        const frame = JSON.parse(body) as { record_kind?: unknown };
        if (frame.record_kind === "assistant") {
          delayed = true;
          resolveAssistantPostStarted();
          await release;
        }
      }
      return broker.fetch(input, init);
    }) as typeof fetch;

    const code = await runRcLaunch({
      claudeArgs: [],
      identity: id,
      brokerUrl: "http://broker.test",
      certsDir,
      fetchFn,
      spawnClaude: async (_bin, _args, env) => {
        const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
        if (m === null) throw new Error("missing HTTPS_PROXY");
        const caPath = env.NODE_EXTRA_CA_CERTS;
        if (caPath === undefined) throw new Error("missing NODE_EXTRA_CA_CERTS");
        const agent = proxyAgent(Number.parseInt(m[1] as string, 10), readFileSync(caPath));
        const reg = await rpc(agent, "POST", "/v1/code/sessions", { title: "flush test" });
        const session = reg.session as { id?: unknown };
        if (typeof session.id !== "string") throw new Error("session registration failed");

        await rpc(agent, "POST", `/v1/code/sessions/${session.id}/worker/events`, {
          events: [
            {
              payload: {
                type: "assistant",
                message: { content: [{ type: "text", text: "final frame" }] },
              },
            },
          ],
        });
        await assistantPostStarted;
        setTimeout(releaseAssistantPost, 50);
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(broker.posts.some((p) => p.frame.record_kind === "assistant")).toBe(true);
  }, 20_000);

  it("keeps root secret and derived keys out of launch traces, child env, and broker plaintext", async () => {
    const secret = new Uint8Array(32).fill("S".charCodeAt(0));
    const id = await deriveIdentity(secret);
    const token = await formatSecret(secret);
    const certsDir = tmp();
    const traceDir = tmp();
    const traceFile = join(traceDir, "rc-trace.jsonl");
    const broker = new MockBroker();
    broker.requireAuth(id.authToken);

    const saved = {
      RC_LOG: process.env.RC_LOG,
      RC_LOG_FILE: process.env.RC_LOG_FILE,
      RC_LOG_FORMAT: process.env.RC_LOG_FORMAT,
    };
    process.env.RC_LOG = "trace";
    process.env.RC_LOG_FILE = traceFile;
    process.env.RC_LOG_FORMAT = "json";

    let seenEnv: NodeJS.ProcessEnv | null = null;
    let sessionId = "";

    try {
      const code = await runRcLaunch({
        claudeArgs: [],
        identity: id,
        brokerUrl: "http://broker.test",
        certsDir,
        cwd: certsDir,
        fetchFn: broker.fetch,
        title: "leak proof",
        spawnClaude: async (_bin, _args, env) => {
          seenEnv = env;
          const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
          if (m === null) throw new Error("missing HTTPS_PROXY");
          const caPath = env.NODE_EXTRA_CA_CERTS;
          if (caPath === undefined) throw new Error("missing NODE_EXTRA_CA_CERTS");
          const agent = proxyAgent(Number.parseInt(m[1] as string, 10), readFileSync(caPath));
          const workerEvents: Record<string, unknown>[] = [];
          let abortWorker = () => {};

          try {
            const reg = await rpc(agent, "POST", "/v1/code/sessions", { title: "fake worker" });
            const session = reg.session as { id?: unknown };
            if (typeof session.id !== "string") throw new Error("session registration failed");
            sessionId = session.id;

            abortWorker = openWorkerStream(agent, sessionId, (ev) => workerEvents.push(ev));
            await waitFor(() => workerEvents.some((e) => e.event_type === "control_request"));
            await waitFor(() =>
              broker.posts.some((p) => p.frame.record_kind === "session_announce"),
            );

            const viewer = new BrokerClient({
              baseUrl: "http://broker.test",
              provider: securityProvider("sealed", id),
              fetchFn: broker.fetch,
            });
            await viewer.postFrame(
              clientHeader(id, sessionId, "user", "user-in-1", {
                clientMsgId: "client-user-1",
              }),
              utf8("hello from viewer"),
            );
            await waitFor(() =>
              workerEvents.some((e) => {
                const payload = e.payload as { message?: { content?: unknown } } | undefined;
                return e.event_type === "user" && payload?.message?.content === "hello from viewer";
              }),
            );

            await rpc(agent, "POST", `/v1/code/sessions/${sessionId}/worker/events`, {
              events: [
                {
                  payload: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "hello from worker" }] },
                  },
                },
                {
                  payload: {
                    type: "control_request",
                    request_id: "perm-launch-1",
                    request: {
                      subtype: "can_use_tool",
                      tool_name: "Bash",
                      tool_input: { command: "npm test" },
                    },
                  },
                },
              ],
            });
            await waitFor(() => broker.posts.some((p) => p.frame.record_kind === "assistant"));
            await waitFor(() =>
              broker.posts.some((p) => p.frame.record_kind === "permission_request"),
            );

            await viewer.postFrame(
              clientHeader(id, sessionId, "permission", "permission-in-1"),
              utf8(JSON.stringify({ request_id: "perm-launch-1", behavior: "allow" })),
            );
            await waitFor(() =>
              workerEvents.some((e) => {
                const payload = e.payload as { response?: { request_id?: unknown } } | undefined;
                return (
                  e.event_type === "control_response" &&
                  payload?.response?.request_id === "perm-launch-1"
                );
              }),
            );
            await waitFor(() =>
              broker.posts.some((p) => p.frame.record_kind === "permission_resolved"),
            );

            await viewer.postFrame(
              clientHeader(id, sessionId, "interrupt", "interrupt-in-1"),
              utf8(JSON.stringify({ expiry: Date.now() + 60_000 })),
            );
            await waitFor(() =>
              workerEvents.some((e) => {
                const payload = e.payload as { request?: { subtype?: unknown } } | undefined;
                return (
                  e.event_type === "control_request" && payload?.request?.subtype === "interrupt"
                );
              }),
            );
            return 0;
          } finally {
            abortWorker();
          }
        },
      });
      expect(code).toBe(0);
    } finally {
      if (saved.RC_LOG === undefined) delete process.env.RC_LOG;
      else process.env.RC_LOG = saved.RC_LOG;
      if (saved.RC_LOG_FILE === undefined) delete process.env.RC_LOG_FILE;
      else process.env.RC_LOG_FILE = saved.RC_LOG_FILE;
      if (saved.RC_LOG_FORMAT === undefined) delete process.env.RC_LOG_FORMAT;
      else process.env.RC_LOG_FORMAT = saved.RC_LOG_FORMAT;
    }

    expect(seenEnv).not.toBeNull();
    expect(sessionId).not.toBe("");
    const verifier = new BrokerClient({
      baseUrl: "http://broker.test",
      provider: securityProvider("sealed", id),
      fetchFn: broker.fetch,
    });
    const frames = [
      ...(await collect(verifier.streamFrames({}))),
      ...(await collect(verifier.streamFrames({ session: sessionId }))),
    ];
    const plaintext = (
      await Promise.all(
        frames.map(async (f) => new TextDecoder().decode(await verifier.openFrame(f))),
      )
    ).join("\n");
    expect(plaintext).toContain("hello from viewer");
    expect(plaintext).toContain("hello from worker");
    expect(plaintext).toContain("perm-launch-1");

    const traceText = existsSync(traceFile) ? readFileSync(traceFile, "utf8") : "";
    expect(traceText).toContain('"target":"rc.relay"');
    expect(traceText).toContain('"msg":"frame sealed"');

    assertNoSensitiveMaterial(traceText, id, { token, secret });
    assertNoSensitiveMaterial(JSON.stringify(seenEnv), id, { token, secret });
    assertNoSensitiveMaterial(plaintext, id, { token, secret });
  }, 30_000);
});
