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
import { type RcLaunchOptions, runRcLaunch as runRcLaunchBoundary } from "./launch.js";

const runRcLaunch = (opts: RcLaunchOptions): Promise<number> =>
  runRcLaunchBoundary({
    ...opts,
    backend: opts.backend ?? "sqlite",
    claudeCompatibilityCheck: async () => {},
  });

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

function rpcResponse(
  agent: unknown,
  method: string,
  path: string,
  body?: unknown,
  workerToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
        ...(workerToken ? { authorization: `Bearer ${workerToken}` } : {}),
        ...(payload ? { "content-length": payload.length } : {}),
      },
    };
    const req = httpsRequest(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
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

async function rpc(
  agent: unknown,
  method: string,
  path: string,
  body?: unknown,
  workerToken?: string,
): Promise<Record<string, unknown>> {
  return (await rpcResponse(agent, method, path, body, workerToken)).body;
}

async function bridgeWorker(agent: unknown, sessionId: string): Promise<string> {
  const response = await rpc(agent, "POST", `/v1/code/sessions/${sessionId}/bridge`);
  const workerToken = response.worker_jwt;
  if (typeof workerToken !== "string") throw new Error("worker bridge failed");
  return workerToken;
}

function openWorkerStream(
  agent: unknown,
  sessionId: string,
  workerToken: string,
  onEvent: (ev: Record<string, unknown>) => void,
): () => void {
  const opts: RequestOptions = {
    host: MITM_HOST,
    port: 443,
    method: "GET",
    path: `/v1/code/sessions/${sessionId}/worker/events/stream`,
    agent: agent as RequestOptions["agent"],
    headers: { accept: "text/event-stream", authorization: `Bearer ${workerToken}` },
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

async function waitForAsync(pred: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

async function take<T>(gen: AsyncGenerator<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
    if (out.length === count) return out;
  }
  throw new Error(`broker stream ended before ${count} frame(s)`);
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

describe("runRcLaunch public stable boundary", () => {
  it("rejects an unsupported version before certificates, network setup, or child spawn", async () => {
    const certsDir = tmp();
    let spawned = false;

    await expect(
      runRcLaunchBoundary({
        claudeArgs: [],
        identity: {} as Identity,
        brokerUrl: "http://broker.example",
        certsDir,
        claudeBin: "unsupported-claude",
        claudeCompatibilityCheck: async (bin) => {
          expect(bin).toBe("unsupported-claude");
          throw new Error("unsupported stable version");
        },
        spawnClaude: async () => {
          spawned = true;
          return 0;
        },
      }),
    ).rejects.toThrow("unsupported stable version");

    expect(spawned).toBe(false);
    expect(existsSync(join(certsDir, "ca.pem"))).toBe(false);
  });
});

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

  it("bedrock mode: swaps any real Anthropic creds for a pretend key and walls the child off from AWS/IMDS", async () => {
    // In zero-Anthropic (bedrock) mode the child must hold NO usable Anthropic credential (a hostile MCP
    // that dodged the proxy could otherwise call api.anthropic.com directly) and NO path to the host's
    // AWS creds (not even IMDS). Verify the launch env reflects all of that.
    const id = await deriveIdentity(new Uint8Array(32).fill(74));
    const certsDir = tmp();
    const prev = {
      key: process.env.ANTHROPIC_API_KEY,
      authTok: process.env.ANTHROPIC_AUTH_TOKEN,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      akid: process.env.AWS_ACCESS_KEY_ID,
      meta: process.env.AWS_EC2_METADATA_DISABLED,
    };
    process.env.ANTHROPIC_API_KEY = "sk-ant-REAL-user-key-should-not-reach-child";
    process.env.ANTHROPIC_AUTH_TOKEN = "real-oauth-token-should-not-reach-child";
    process.env.ANTHROPIC_BASE_URL = "https://other-host.example/should-not-reach-child";
    process.env.AWS_ACCESS_KEY_ID = "AKIAHOSTONLYSHOULDNOTLEAK";
    delete process.env.AWS_EC2_METADATA_DISABLED; // prove we SET it (not merely inherit a prior value)
    let seenEnv: NodeJS.ProcessEnv | null = null;
    try {
      await runRcLaunch({
        claudeArgs: [],
        identity: id,
        brokerUrl: "http://broker.example",
        certsDir,
        inference: "bedrock",
        bedrock: {},
        spawnClaude: async (_bin, _args, env) => {
          seenEnv = env;
          return 0;
        },
      });
    } finally {
      for (const [k, v] of [
        ["ANTHROPIC_API_KEY", prev.key],
        ["ANTHROPIC_AUTH_TOKEN", prev.authTok],
        ["ANTHROPIC_BASE_URL", prev.baseUrl],
        ["AWS_ACCESS_KEY_ID", prev.akid],
        ["AWS_EC2_METADATA_DISABLED", prev.meta],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const env = seenEnv as unknown as NodeJS.ProcessEnv;
    // The real Anthropic key/token/base-url never reach the child — only the pretend key.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-remote-claw-bedrock-no-account-needed");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined(); // can't redirect the child off our MITM
    // Host AWS creds are scrubbed AND IMDS is explicitly disabled for the child.
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_EC2_METADATA_DISABLED).toBe("true");
    // CLAUDE_CODE_USE_BEDROCK must NOT be set — it would put the child in Bedrock-transport mode and
    // DISABLE /remote-control (the whole point is to keep RC alive on a synthesized Anthropic front).
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    // The proxy env the child genuinely needs still survives.
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 20_000);

  it("accountless mode: points the child at an isolated seeded config dir, then removes it on teardown", async () => {
    // Accountless seeds a synthetic claude.ai login + RC gates into a throwaway CLAUDE_CONFIG_DIR so
    // native /remote-control works with no real login — without touching the user's real ~/.claude.json.
    const id = await deriveIdentity(new Uint8Array(32).fill(75));
    const certsDir = tmp();
    let seenEnv: NodeJS.ProcessEnv | null = null;
    let seededDir = "";
    let cfgDuringSpawn: Record<string, unknown> | null = null;
    await runRcLaunch({
      claudeArgs: [],
      identity: id,
      brokerUrl: "http://broker.example",
      certsDir,
      inference: "bedrock",
      bedrock: {},
      accountless: true,
      spawnClaude: async (_bin, _args, env) => {
        seenEnv = env;
        seededDir = env.CLAUDE_CONFIG_DIR ?? "";
        // The seeded config exists DURING the child's life and carries the RC gates.
        cfgDuringSpawn = JSON.parse(readFileSync(join(seededDir, ".claude.json"), "utf8"));
        return 0;
      },
    });
    const env = seenEnv as unknown as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(seededDir).toContain("rc-accountless-");
    const cfg = cfgDuringSpawn as unknown as { cachedGrowthBookFeatures: Record<string, unknown> };
    expect(cfg.cachedGrowthBookFeatures.tengu_ccr_bridge).toBe(true);
    // The pretend key still gets injected (bedrock), and the seeded config rejects it → claude.ai-login mode.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-remote-claw-bedrock-no-account-needed");
    // Ephemeral: the dir is gone after teardown.
    expect(existsSync(seededDir)).toBe(false);
  }, 20_000);

  it("accountless without bedrock is rejected at the library boundary (not just the CLI arg layer)", async () => {
    // runRcLaunch is exported; a programmatic caller must not be able to seed a fabricated login while
    // the MITM passes through to real Anthropic. The guard must fire before any spawn.
    const id = await deriveIdentity(new Uint8Array(32).fill(76));
    let spawned = false;
    await expect(
      runRcLaunch({
        claudeArgs: [],
        identity: id,
        brokerUrl: "http://broker.example",
        certsDir: tmp(),
        accountless: true,
        // inference omitted ⇒ defaults to anthropic passthrough
        spawnClaude: async () => {
          spawned = true;
          return 0;
        },
      }),
    ).rejects.toThrow(/accountless requires inference:'bedrock'/);
    expect(spawned).toBe(false);
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
        const workerToken = await bridgeWorker(agent, session.id);

        await rpc(
          agent,
          "POST",
          `/v1/code/sessions/${session.id}/worker/events`,
          {
            worker_epoch: 1,
            events: [
              {
                payload: {
                  session_id: session.id,
                  uuid: "11111111-1111-4111-8111-111111111111",
                  type: "assistant",
                  message: { content: [{ type: "text", text: "final frame" }] },
                },
              },
            ],
          },
          workerToken,
        );
        await assistantPostStarted;
        setTimeout(releaseAssistantPost, 50);
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(broker.posts.some((p) => p.frame.record_kind === "assistant")).toBe(true);
  }, 20_000);

  it("keeps teardown alive through every configured presence-terminal retry", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(72));
    const certsDir = tmp();
    const broker = new MockBroker();
    broker.requireAuth(id.authToken);
    let terminalAttempts = 0;

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const frame = JSON.parse(String(init?.body ?? "{}")) as { record_kind?: unknown };
      if (url.pathname === "/api/relay" && frame.record_kind === "session_terminal") {
        terminalAttempts += 1;
        if (terminalAttempts <= 3) {
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(
                new Response(JSON.stringify({ error: "late injected terminal failure" }), {
                  status: 500,
                  headers: { "content-type": "application/json" },
                }),
              );
            }, 1_200);
            const abort = () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            };
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener("abort", abort, { once: true });
          });
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
        const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
        if (match === null) throw new Error("missing HTTPS_PROXY");
        const caPath = env.NODE_EXTRA_CA_CERTS;
        if (caPath === undefined) throw new Error("missing NODE_EXTRA_CA_CERTS");
        const agent = proxyAgent(Number.parseInt(match[1] as string, 10), readFileSync(caPath));
        const registration = await rpc(agent, "POST", "/v1/code/sessions", {
          title: "terminal retry cutoff",
        });
        const session = registration.session as { id?: unknown };
        if (typeof session.id !== "string") throw new Error("session registration failed");
        await waitFor(() =>
          broker.posts.some((post) => post.frame.record_kind === "session_announce"),
        );
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(terminalAttempts).toBe(4);
    expect(
      broker.posts.filter((post) => post.frame.record_kind === "session_terminal"),
    ).toHaveLength(1);
  }, 20_000);

  it("does not let an elapsed teardown cutoff skip terminal retries after an event-loop stall", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(73));
    const certsDir = tmp();
    const broker = new MockBroker();
    broker.requireAuth(id.authToken);
    let terminalAttempts = 0;
    let markTerminalStarted = () => {};
    const terminalStarted = new Promise<void>((resolve) => {
      markTerminalStarted = resolve;
    });

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const frame = JSON.parse(String(init?.body ?? "{}")) as { record_kind?: unknown };
      if (url.pathname === "/api/relay" && frame.record_kind === "session_terminal") {
        terminalAttempts += 1;
        if (terminalAttempts === 1) {
          markTerminalStarted();
          // Intentionally ignore AbortSignal: the relay's local Promise.race owns the hard attempt bound.
          return new Promise<Response>(() => {});
        }
        if (terminalAttempts <= 3) {
          return new Response(JSON.stringify({ error: "injected terminal failure" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return broker.fetch(input, init);
    }) as typeof fetch;

    const launch = runRcLaunch({
      claudeArgs: [],
      identity: id,
      brokerUrl: "http://broker.test",
      certsDir,
      fetchFn,
      spawnClaude: async (_bin, _args, env) => {
        const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
        if (match === null) throw new Error("missing HTTPS_PROXY");
        const caPath = env.NODE_EXTRA_CA_CERTS;
        if (caPath === undefined) throw new Error("missing NODE_EXTRA_CA_CERTS");
        const agent = proxyAgent(Number.parseInt(match[1] as string, 10), readFileSync(caPath));
        const registration = await rpc(agent, "POST", "/v1/code/sessions", {
          title: "terminal retry after scheduler stall",
        });
        const session = registration.session as { id?: unknown };
        if (typeof session.id !== "string") throw new Error("session registration failed");
        await waitFor(() =>
          broker.posts.some((post) => post.frame.record_kind === "session_announce"),
        );
        return 0;
      },
    });

    await terminalStarted;
    // Simulate suspend/a long synchronous stall past the unrelated 2s teardown cutoff. Both the first
    // attempt timer and launcher cutoff are overdue on resume; terminal-policy completion must win.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);

    expect(await launch).toBe(0);
    expect(terminalAttempts).toBe(4);
    expect(
      broker.posts.filter((post) => post.frame.record_kind === "session_terminal"),
    ).toHaveLength(1);
  }, 20_000);

  it("fail-stops one remote cse after broker publication failure while the local Claude process remains alive", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(79));
    const certsDir = tmp();
    const broker = new MockBroker();
    broker.requireAuth(id.authToken);
    let assistantPublishFailed = false;
    let localProcessContinued = false;

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/relay" && url.searchParams.has("session")) {
        const frame = JSON.parse(String(init?.body ?? "{}")) as { record_kind?: unknown };
        if (frame.record_kind === "assistant") {
          assistantPublishFailed = true;
          return new Response(JSON.stringify({ error: "injected publication failure" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
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
        const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
        if (match === null) throw new Error("missing HTTPS_PROXY");
        const caPath = env.NODE_EXTRA_CA_CERTS;
        if (caPath === undefined) throw new Error("missing NODE_EXTRA_CA_CERTS");
        const agent = proxyAgent(Number.parseInt(match[1] as string, 10), readFileSync(caPath));
        const registration = await rpc(agent, "POST", "/v1/code/sessions", {
          title: "fail-stop test",
        });
        const session = registration.session as { id?: unknown };
        if (typeof session.id !== "string") throw new Error("session registration failed");
        const workerToken = await bridgeWorker(agent, session.id);

        const admitted = await rpcResponse(
          agent,
          "POST",
          `/v1/code/sessions/${session.id}/worker/events`,
          {
            worker_epoch: 1,
            events: [
              {
                payload: {
                  session_id: session.id,
                  uuid: "44444444-4444-4444-8444-444444444444",
                  type: "assistant",
                  message: { content: [{ type: "text", text: "cannot publish" }] },
                },
              },
            ],
          },
          workerToken,
        );
        expect(admitted.status).toBe(200); // in-memory admission precedes asynchronous projection
        await waitFor(() => assistantPublishFailed);

        let closedStatus = 0;
        await waitForAsync(async () => {
          closedStatus = (await rpcResponse(agent, "GET", `/v1/code/sessions/${session.id}`))
            .status;
          return closedStatus === 410;
        });
        expect(closedStatus).toBe(410);
        const laterIntake = await rpcResponse(
          agent,
          "POST",
          `/v1/code/sessions/${session.id}/worker/events`,
          { worker_epoch: 1, events: [] },
        );
        expect(laterIntake.status).toBe(410);

        // A bridge failure retires remote access only; it does not kill the real local TUI process.
        localProcessContinued = true;
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(localProcessContinued).toBe(true);
  }, 20_000);

  it("spends one shared teardown grace period when a session announce stalls", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(78));
    const certsDir = tmp();
    const broker = new MockBroker();
    broker.requireAuth(id.authToken);

    let resolveAnnounceStarted: () => void = () => {};
    const announceStarted = new Promise<void>((resolve) => {
      resolveAnnounceStarted = resolve;
    });
    let releaseAnnounce: () => void = () => {};
    const announceRelease = new Promise<void>((resolve) => {
      releaseAnnounce = resolve;
    });
    let stalled = false;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/relay" && !url.searchParams.has("session") && !stalled) {
        const frame = JSON.parse(String(init?.body ?? "{}")) as { record_kind?: unknown };
        if (frame.record_kind === "session_announce") {
          stalled = true;
          resolveAnnounceStarted();
          await announceRelease;
        }
      }
      return broker.fetch(input, init);
    }) as typeof fetch;

    let childExitAt = 0;
    try {
      const code = await runRcLaunch({
        claudeArgs: [],
        identity: id,
        brokerUrl: "http://broker.test",
        certsDir,
        fetchFn,
        spawnClaude: async (_bin, _args, env) => {
          const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
          if (match === null) throw new Error("missing HTTPS_PROXY");
          const caPath = env.NODE_EXTRA_CA_CERTS;
          if (caPath === undefined) throw new Error("missing NODE_EXTRA_CA_CERTS");
          const agent = proxyAgent(Number.parseInt(match[1] as string, 10), readFileSync(caPath));
          const registration = await rpc(agent, "POST", "/v1/code/sessions", {
            title: "stalled announce",
          });
          const session = registration.session as { id?: unknown };
          if (typeof session.id !== "string") throw new Error("session registration failed");
          await announceStarted;
          childExitAt = performance.now();
          return 0;
        },
      });

      const teardownMs = performance.now() - childExitAt;
      expect(code).toBe(0);
      expect(stalled).toBe(true);
      // Obsolete live-announce/registration cleanup gets one shared 2s deadline. The separately tracked
      // terminal policy is already complete here and cannot be overtaken by this unrelated-work cutoff.
      expect(teardownMs).toBeGreaterThanOrEqual(1_500);
      expect(teardownMs).toBeLessThan(3_500);
    } finally {
      releaseAnnounce();
    }
  }, 15_000);

  it("registers two intercepted sessions independently and routes a viewer command only to its worker", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(77));
    const certsDir = tmp();
    const broker = new MockBroker();
    broker.requireAuth(id.authToken);
    const workerEvents: [Record<string, unknown>[], Record<string, unknown>[]] = [[], []];
    const sessionIds: [string, string] = ["", ""];

    const code = await runRcLaunch({
      claudeArgs: [],
      identity: id,
      brokerUrl: "http://broker.test",
      certsDir,
      fetchFn: broker.fetch,
      spawnClaude: async (_bin, _args, env) => {
        const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(env.HTTPS_PROXY ?? "");
        if (match === null) throw new Error("missing HTTPS_PROXY");
        const caPath = env.NODE_EXTRA_CA_CERTS;
        if (caPath === undefined) throw new Error("missing NODE_EXTRA_CA_CERTS");
        const agent = proxyAgent(Number.parseInt(match[1] as string, 10), readFileSync(caPath));
        const abortWorkers: Array<() => void> = [];

        try {
          for (let index = 0; index < 2; index += 1) {
            const registration = await rpc(agent, "POST", "/v1/code/sessions", {
              title: `worker ${index + 1}`,
            });
            const session = registration.session as { id?: unknown };
            if (typeof session.id !== "string") throw new Error("session registration failed");
            sessionIds[index] = session.id;
            const workerToken = await bridgeWorker(agent, session.id);
            abortWorkers.push(
              openWorkerStream(agent, session.id, workerToken, (event) =>
                workerEvents[index]?.push(event),
              ),
            );
          }

          await waitFor(() =>
            workerEvents.every((events) =>
              events.some((event) => event.event_type === "control_request"),
            ),
          );
          await waitFor(() => {
            const announced = new Set(
              broker.posts
                .filter((post) => post.frame.record_kind === "session_announce")
                .map((post) => post.frame.session_id),
            );
            return sessionIds.every((sessionId) => announced.has(sessionId));
          });

          const viewer = new BrokerClient({
            baseUrl: "http://broker.test",
            provider: securityProvider("sealed", id),
            fetchFn: broker.fetch,
          });
          await viewer.postFrame(
            clientHeader(id, sessionIds[0], "user", "two-session-user-1", {
              clientMsgId: "two-session-client-user-1",
            }),
            utf8("only worker one"),
          );
          await waitFor(() =>
            workerEvents[0].some((event) => {
              const payload = event.payload as { message?: { content?: unknown } } | undefined;
              return event.event_type === "user" && payload?.message?.content === "only worker one";
            }),
          );
          await viewer.postFrame(
            clientHeader(id, sessionIds[1], "user", "two-session-user-2", {
              clientMsgId: "two-session-client-user-2",
            }),
            utf8("worker two barrier"),
          );
          await waitFor(() =>
            workerEvents[1].some((event) => {
              const payload = event.payload as { message?: { content?: unknown } } | undefined;
              return (
                event.event_type === "user" && payload?.message?.content === "worker two barrier"
              );
            }),
          );

          expect(workerEvents[1]).not.toContainEqual(
            expect.objectContaining({
              event_type: "user",
              payload: expect.objectContaining({
                message: expect.objectContaining({ content: "only worker one" }),
              }),
            }),
          );
          expect(workerEvents[0]).not.toContainEqual(
            expect.objectContaining({
              event_type: "user",
              payload: expect.objectContaining({
                message: expect.objectContaining({ content: "worker two barrier" }),
              }),
            }),
          );
          expect(new Set(sessionIds).size).toBe(2);
          return 0;
        } finally {
          for (const abortWorker of abortWorkers) abortWorker();
        }
      },
    });

    expect(code).toBe(0);
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
            const workerToken = await bridgeWorker(agent, sessionId);

            abortWorker = openWorkerStream(agent, sessionId, workerToken, (ev) =>
              workerEvents.push(ev),
            );
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

            await rpc(
              agent,
              "POST",
              `/v1/code/sessions/${sessionId}/worker/events`,
              {
                worker_epoch: 1,
                events: [
                  {
                    payload: {
                      session_id: sessionId,
                      uuid: "22222222-2222-4222-8222-222222222222",
                      type: "assistant",
                      message: { content: [{ type: "text", text: "hello from worker" }] },
                    },
                  },
                  {
                    payload: {
                      session_id: sessionId,
                      uuid: "33333333-3333-4333-8333-333333333333",
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
              },
              workerToken,
            );
            await waitFor(() => broker.posts.some((p) => p.frame.record_kind === "assistant"));

            // The stable private-relay beta never exposes or answers this compatibility path.
            // An old/current authenticated viewer frame is still rejected at the host boundary.
            await viewer.postFrame(
              clientHeader(id, sessionId, "permission", "permission-in-1"),
              utf8(JSON.stringify({ request_id: "perm-launch-1", behavior: "allow" })),
            );

            await viewer.postFrame(
              clientHeader(id, sessionId, "interrupt", "interrupt-in-1"),
              utf8(JSON.stringify({ expiry: Date.now() + 60_000 })),
            );
            await viewer.postFrame(
              clientHeader(id, sessionId, "user", "user-barrier", {
                clientMsgId: "client-barrier",
              }),
              utf8("stable barrier"),
            );
            await waitFor(() =>
              workerEvents.some((e) => {
                const payload = e.payload as { message?: { content?: unknown } } | undefined;
                return e.event_type === "user" && payload?.message?.content === "stable barrier";
              }),
            );
            expect(
              workerEvents.some((e) => {
                const payload = e.payload as { request?: { subtype?: unknown } } | undefined;
                return (
                  e.event_type === "control_request" && payload?.request?.subtype === "interrupt"
                );
              }),
            ).toBe(false);
            expect(
              workerEvents.some((e) => {
                const payload = e.payload as { response?: { request_id?: unknown } } | undefined;
                return (
                  e.event_type === "control_response" &&
                  payload?.response?.request_id === "perm-launch-1"
                );
              }),
            ).toBe(false);
            expect(
              broker.posts.some(
                (p) =>
                  p.frame.record_kind === "permission_request" ||
                  p.frame.record_kind === "permission_resolved",
              ),
            ).toBe(false);
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
    const busFrameCount = await verifier.frameCount();
    const sessionFrameCount = await verifier.frameCount(sessionId);
    if (busFrameCount === null || busFrameCount < 1) throw new Error("missing bus proof frames");
    if (sessionFrameCount === null || sessionFrameCount < 1)
      throw new Error("missing session proof frames");
    const frames = [
      ...(await take(verifier.streamFrames({}), busFrameCount)),
      ...(await take(verifier.streamFrames({ session: sessionId }), sessionFrameCount)),
    ];
    const openedFrames = await Promise.all(
      frames.map(async (frame) => ({
        frame,
        text: new TextDecoder().decode(await verifier.openFrame(frame)),
      })),
    );
    const plaintext = openedFrames.map(({ text }) => text).join("\n");
    expect(plaintext).toContain("hello from viewer");
    expect(plaintext).toContain("hello from worker");
    const announce = openedFrames.find(
      ({ frame }) => frame.recordKind === "session_announce",
    )?.text;
    expect(announce).toBeDefined();
    expect(JSON.parse(announce as string).capabilities).toEqual({
      structuredPermissions: false,
      status: true,
      controls: { interrupt: false, setModel: false, setMode: false, end: false },
      attachments: false,
    });

    const traceText = existsSync(traceFile) ? readFileSync(traceFile, "utf8") : "";
    expect(traceText).toContain('"target":"rc.relay"');
    expect(traceText).toContain('"msg":"frame sealed"');

    assertNoSensitiveMaterial(traceText, id, { token, secret });
    assertNoSensitiveMaterial(JSON.stringify(seenEnv), id, { token, secret });
    assertNoSensitiveMaterial(plaintext, id, { token, secret });
  }, 30_000);
});
