// MITM proxy integration test: a fake "claude worker" speaks the real RC worker protocol THROUGH the
// proxy over genuine TLS interception (CONNECT tunnel → our leaf, validated against our CA — exactly
// what claude does via HTTPS_PROXY + NODE_EXTRA_CA_CERTS). No real network: api.anthropic.com is
// intercepted locally for the RC endpoints. Verifies session register → bridge → worker SSE
// (initialize-first) → downstream `user` delivery → upstream `assistant` POST.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { ensureCerts, MITM_HOST } from "./certs.js";
import { MitmProxy } from "./mitm.js";
import { RelayCore, type Session } from "./session.js";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const RUN = haveOpenssl();

const cleanup: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanup) c();
});

/** An https.Agent that tunnels through our proxy via CONNECT, trusting our MITM CA. */
function proxyAgent(proxyPort: number, ca: Buffer) {
  const agent = new Agent({ ca, keepAlive: false });
  // Override connection creation to establish a CONNECT tunnel, then TLS over it.
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

/** One JSON request through the proxy; resolves to the parsed body. */
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

/** Open the worker SSE stream; calls `onEvent` for each `client_event` data line. Returns an abort fn. */
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
            // ignore non-JSON keepalives
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

describe.skipIf(!RUN)("MITM proxy (fake worker over real TLS interception)", () => {
  it("close is idempotent and owns RelayCore.closeAll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-close-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const core = new RelayCore();
    const session = core.create({ title: "close me" });
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();

    await proxy.close();
    await proxy.close();

    expect(session.closed).toBe(true);
  });

  it("registers a session, serves the worker SSE (initialize first), and round-trips events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);

    const core = new RelayCore();
    let created: Session | null = null;
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
      onSession: (s) => {
        created = s;
      },
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);

    // 1. Worker registers a session (POST /v1/code/sessions).
    const reg = await rpc(agent, "POST", "/v1/code/sessions", { title: "test box" });
    const session = (reg.session as { id: string }) ?? { id: "" };
    expect(session.id.startsWith("cse_")).toBe(true);
    expect(created).not.toBeNull();

    // 2. Worker mints a bridge (worker_jwt + base url).
    const bridge = await rpc(agent, "POST", `/v1/code/sessions/${session.id}/bridge`);
    expect(String(bridge.worker_jwt)).toContain(session.id);
    expect(bridge.api_base_url).toBe(`https://${MITM_HOST}`);

    // 3. Worker opens its SSE downstream — the FIRST event must be control_request(initialize).
    const events: Record<string, unknown>[] = [];
    const abort = openWorkerStream(agent, session.id, (ev) => events.push(ev));
    cleanup.push(abort);
    await waitFor(() => events.length >= 1);
    expect(events[0]?.event_type).toBe("control_request");
    const initPayload = events[0]?.payload as { request?: { subtype?: string } };
    expect(initPayload.request?.subtype).toBe("initialize");

    // 4. The RELAY pushes a user prompt downstream → the worker SSE receives a `user` event.
    const s = core.get(session.id);
    if (!s) throw new Error("no session");
    s.pushUserInput("hello from the relay");
    await waitFor(() => events.some((e) => e.event_type === "user"));
    const userEv = events.find((e) => e.event_type === "user");
    const userPayload = userEv?.payload as { message?: { content?: string } };
    expect(userPayload.message?.content).toBe("hello from the relay");

    // 5. The worker POSTs an assistant turn back (upstream) → the relay records it.
    await rpc(agent, "POST", `/v1/code/sessions/${session.id}/worker/events`, {
      events: [
        {
          payload: { type: "assistant", message: { content: [{ type: "text", text: "hi back" }] } },
        },
      ],
    });
    await waitFor(() => s.snapshotUpstream().some((e) => e.eventType === "assistant"));
    const up = s.snapshotUpstream().find((e) => e.eventType === "assistant");
    expect(up).toBeDefined();
  }, 30_000);
});
