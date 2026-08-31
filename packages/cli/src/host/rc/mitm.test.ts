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
import { MitmProxy, RC_INTERCEPT_BODY_CAP, type UpstreamRequest } from "./mitm.js";
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
function rpcResponse(
  agent: unknown,
  method: string,
  path: string,
  body?: unknown,
  workerToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    const opts: RequestOptions = {
      host: MITM_HOST,
      port: 443,
      method,
      path,
      agent: agent as RequestOptions["agent"],
      headers: {
        "content-type": "application/json",
        ...(payload ? { "content-length": payload.length } : {}),
        ...(workerToken ? { authorization: `Bearer ${workerToken}` } : {}),
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

function openBodyRequest(
  agent: unknown,
  method: string,
  path: string,
  headers: Record<string, string | number>,
): {
  request: ReturnType<typeof httpsRequest>;
  response: Promise<{ status: number; body: Record<string, unknown> }>;
} {
  let request: ReturnType<typeof httpsRequest> | undefined;
  const response = new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      request = httpsRequest(
        {
          host: MITM_HOST,
          port: 443,
          method,
          path,
          agent: agent as RequestOptions["agent"],
          headers,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            try {
              resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
    },
  );
  if (request === undefined) throw new Error("request was not created synchronously");
  return { request, response };
}

async function within<T>(promise: Promise<T>, timeoutMs = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("response timed out before request EOF")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function bridgeWorker(agent: unknown, sessionId: string): Promise<string> {
  const bridge = await rpc(agent, "POST", `/v1/code/sessions/${sessionId}/bridge`);
  if (typeof bridge.worker_jwt !== "string" || bridge.worker_jwt === "") {
    throw new Error("bridge did not return worker_jwt");
  }
  return bridge.worker_jwt;
}

/** Open the worker SSE stream; calls `onEvent` for each `client_event` data line. Returns an abort fn. */
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
  it("keeps the Bedrock profile entirely off the Anthropic upstream transport", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-bedrock-routing-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    const bedrockCalls: Array<{ url: string; init: RequestInit }> = [];
    let anthropicCalls = 0;
    const upstreamRequest = (() => {
      anthropicCalls += 1;
      throw new Error("Bedrock profile attempted an Anthropic upstream request");
    }) as UpstreamRequest;
    const bedrockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      bedrockCalls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: "msg_bedrock_route",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "routed" }],
          model: "anthropic.claude-opus-4-8",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core: new RelayCore(),
      inference: "bedrock",
      upstreamRequest,
      bedrock: {
        region: "us-east-1",
        modelOverride: "anthropic.claude-opus-4-8",
        fetchFn: bedrockFetch,
        resolveAuth: async () => ({ kind: "bearer", token: "test-bedrock-token" }),
      },
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);

    const inference = await rpcResponse(agent, "POST", "/v1/messages", {
      model: "claude-opus-4-8",
      max_tokens: 8,
      messages: [{ role: "user", content: "hello" }],
    });
    const bootstrap = await rpcResponse(agent, "GET", "/api/claude_cli/bootstrap?entrypoint=cli");
    const registration = await rpcResponse(agent, "POST", "/v1/code/sessions", {
      title: "local rc",
    });

    expect(inference.status).toBe(200);
    expect(inference.body.content).toEqual([{ type: "text", text: "routed" }]);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.oauth_account).toMatchObject({
      account_email: "bedrock-user@example.com",
    });
    expect(registration.status).toBe(200);
    expect((registration.body.session as { id?: unknown }).id).toMatch(/^cse_/);
    expect(anthropicCalls).toBe(0);
    expect(bedrockCalls).toHaveLength(1);
    expect(bedrockCalls[0]?.url).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
    );
    expect(JSON.parse(String(bedrockCalls[0]?.init.body))).toMatchObject({
      model: "anthropic.claude-opus-4-8",
    });
  }, 30_000);

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

    // 2. Only the captured POST shape may mint/read the bridge capability.
    const wrongMethod = await rpcResponse(agent, "GET", `/v1/code/sessions/${session.id}/bridge`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body.worker_jwt).toBeUndefined();
    const bridge = await rpc(agent, "POST", `/v1/code/sessions/${session.id}/bridge`);
    const workerToken = bridge.worker_jwt;
    expect(typeof workerToken).toBe("string");
    expect(String(workerToken)).toMatch(/^rcw-[0-9a-f]{32}$/);
    expect(bridge.api_base_url).toBe(`https://${MITM_HOST}`);

    // 3. Worker opens its SSE downstream — the FIRST event must be control_request(initialize).
    const events: Record<string, unknown>[] = [];
    const abort = openWorkerStream(agent, session.id, workerToken as string, (ev) =>
      events.push(ev),
    );
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
    await rpc(
      agent,
      "POST",
      `/v1/code/sessions/${session.id}/worker/events`,
      {
        worker_epoch: 1,
        events: [
          {
            payload: {
              uuid: "11111111-1111-4111-8111-111111111111",
              type: "assistant",
              session_id: session.id,
              message: { content: [{ type: "text", text: "hi back" }] },
            },
          },
        ],
      },
      workerToken as string,
    );
    await waitFor(() => s.snapshotUpstream().some((e) => e.eventType === "assistant"));
    const up = s.snapshotUpstream().find((e) => e.eventType === "assistant");
    expect(up).toBeDefined();
  }, 30_000);

  it("rejects an unauthorized partial chunked worker request before EOF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-early-auth-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    const core = new RelayCore({ newSessionId: () => "earlyauth" });
    const session = core.create({ title: "early auth" });
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const workerToken = await bridgeWorker(agent, session.id);
    const pending = openBodyRequest(
      agent,
      "POST",
      `/v1/code/sessions/${session.id}/worker/events`,
      {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    );

    try {
      pending.request.write('{"events":[');
      const response = await within(pending.response);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "unauthorized worker" });
    } finally {
      pending.request.destroy();
    }

    expect(session.closed).toBe(false);
    expect(
      (
        await rpcResponse(
          agent,
          "GET",
          `/v1/code/sessions/${session.id}/worker`,
          undefined,
          workerToken,
        )
      ).status,
    ).toBe(200);
  }, 30_000);

  it("bounds declared and chunked bodies and closes only the addressed cse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-body-bounds-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    let index = 0;
    const core = new RelayCore({ newSessionId: () => `body${++index}` });
    const declared = core.create({ title: "declared overflow" });
    const chunked = core.create({ title: "chunked overflow" });
    const sibling = core.create({ title: "sibling" });
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const declaredToken = await bridgeWorker(agent, declared.id);
    const chunkedToken = await bridgeWorker(agent, chunked.id);
    const siblingToken = await bridgeWorker(agent, sibling.id);

    const declaredRequest = openBodyRequest(
      agent,
      "POST",
      `/v1/code/sessions/${declared.id}/worker/events`,
      {
        authorization: `Bearer ${declaredToken}`,
        "content-length": RC_INTERCEPT_BODY_CAP + 1,
        "content-type": "application/json",
      },
    );
    try {
      declaredRequest.request.flushHeaders();
      const response = await within(declaredRequest.response);
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: "request body too large" });
    } finally {
      declaredRequest.request.destroy();
    }
    expect(declared.closed).toBe(true);
    expect(chunked.closed).toBe(false);
    expect(sibling.closed).toBe(false);

    const chunkedRequest = openBodyRequest(
      agent,
      "POST",
      `/v1/code/sessions/${chunked.id}/worker/events`,
      {
        authorization: `Bearer ${chunkedToken}`,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    );
    try {
      chunkedRequest.request.write(Buffer.alloc(RC_INTERCEPT_BODY_CAP + 1, 0x20));
      const response = await within(chunkedRequest.response);
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: "request body too large" });
    } finally {
      chunkedRequest.request.destroy();
    }
    expect(chunked.closed).toBe(true);
    expect(sibling.closed).toBe(false);

    const siblingResponse = await rpcResponse(
      agent,
      "POST",
      `/v1/code/sessions/${sibling.id}/worker/events`,
      {
        worker_epoch: 1,
        events: [
          {
            payload: {
              uuid: "44444444-4444-4444-8444-444444444444",
              type: "assistant",
              session_id: sibling.id,
            },
          },
        ],
      },
      siblingToken,
    );
    expect(siblingResponse.status).toBe(200);
    expect(sibling.snapshotUpstream()).toHaveLength(1);
  }, 30_000);

  it("composes path, bearer, and payload session binding without harming the sibling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-composed-binding-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    let index = 0;
    const core = new RelayCore({ newSessionId: () => `binding${++index}` });
    const a = core.create({ title: "a" });
    const b = core.create({ title: "b" });
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const aToken = await bridgeWorker(agent, a.id);
    const bToken = await bridgeWorker(agent, b.id);

    const crossBound = await rpcResponse(
      agent,
      "POST",
      `/v1/code/sessions/${a.id}/worker/events`,
      {
        worker_epoch: 1,
        events: [
          {
            payload: {
              uuid: "55555555-5555-4555-8555-555555555555",
              type: "assistant",
              session_id: b.id,
            },
          },
        ],
      },
      aToken,
    );
    expect(crossBound.status).toBe(400);
    expect(a.closed).toBe(true);
    expect(a.snapshotUpstream()).toHaveLength(0);
    expect(b.closed).toBe(false);
    expect(b.snapshotUpstream()).toHaveLength(0);

    const sibling = await rpcResponse(
      agent,
      "POST",
      `/v1/code/sessions/${b.id}/worker/events`,
      {
        worker_epoch: 1,
        events: [
          {
            payload: {
              uuid: "66666666-6666-4666-8666-666666666666",
              type: "assistant",
              session_id: b.id,
            },
          },
        ],
      },
      bToken,
    );
    expect(sibling.status).toBe(200);
    expect(b.closed).toBe(false);
    expect(b.snapshotUpstream()).toHaveLength(1);
  }, 30_000);

  it("atomically deduplicates exact native retries and rejects UUID collisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-native-intake-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    const core = new RelayCore({ newSessionId: () => "native" });
    const session = core.create({ title: "native intake" });
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const path = `/v1/code/sessions/${session.id}/worker/events`;
    const workerToken = await bridgeWorker(agent, session.id);
    const firstEvent = {
      payload: {
        uuid: "11111111-1111-4111-8111-111111111111",
        type: "assistant",
        session_id: session.id,
        message: { content: [{ type: "text", text: "one" }] },
      },
    };

    const first = await rpcResponse(
      agent,
      "POST",
      path,
      { worker_epoch: 1, events: [firstEvent] },
      workerToken,
    );
    const retry = await rpcResponse(
      agent,
      "POST",
      path,
      { worker_epoch: 1, events: [firstEvent] },
      workerToken,
    );
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(first.body.results).toEqual([
      {
        event_id: "11111111-1111-4111-8111-111111111111",
        sequence_num: "1",
        duplicate: false,
      },
    ]);
    expect(retry.body.results).toEqual([
      {
        event_id: "11111111-1111-4111-8111-111111111111",
        sequence_num: "1",
        duplicate: true,
      },
    ]);

    const collision = await rpcResponse(
      agent,
      "POST",
      path,
      {
        worker_epoch: 1,
        events: [
          {
            payload: {
              uuid: "11111111-1111-4111-8111-111111111111",
              type: "assistant",
              session_id: session.id,
              message: { content: [{ type: "text", text: "changed" }] },
            },
          },
        ],
      },
      workerToken,
    );
    expect(collision.status).toBe(409);
    expect(session.snapshotUpstream()).toHaveLength(1);
    expect(session.closed).toBe(true);

    const afterCollision = await rpcResponse(
      agent,
      "POST",
      path,
      { worker_epoch: 1, events: [] },
      workerToken,
    );
    expect(afterCollision.status).toBe(410);

    const invalidSession = core.create({ title: "invalid native intake" });
    const invalidPath = `/v1/code/sessions/${invalidSession.id}/worker/events`;
    const invalidToken = await bridgeWorker(agent, invalidSession.id);
    const allOrNone = await rpcResponse(
      agent,
      "POST",
      invalidPath,
      {
        worker_epoch: 1,
        events: [
          {
            payload: {
              uuid: "22222222-2222-4222-8222-222222222222",
              type: "result",
              session_id: invalidSession.id,
            },
          },
          {
            payload: { uuid: "invalid", type: "system", session_id: invalidSession.id },
          },
        ],
      },
      invalidToken,
    );
    expect(allOrNone.status).toBe(400);
    expect(invalidSession.closed).toBe(true);
    expect(invalidSession.snapshotUpstream()).toHaveLength(0);

    const next = await rpcResponse(
      agent,
      "POST",
      invalidPath,
      {
        worker_epoch: 1,
        events: [
          {
            payload: {
              uuid: "33333333-3333-4333-8333-333333333333",
              type: "result",
              session_id: invalidSession.id,
            },
          },
        ],
      },
      invalidToken,
    );
    expect(next.status).toBe(410);

    const malformedSession = core.create({ title: "malformed JSON" });
    const malformedPath = `/v1/code/sessions/${malformedSession.id}/worker/events`;
    const malformedToken = await bridgeWorker(agent, malformedSession.id);
    expect(
      (await rpcResponse(agent, "POST", malformedPath, Buffer.from("{"), malformedToken)).status,
    ).toBe(400);
    expect(malformedSession.closed).toBe(true);
    expect((await rpcResponse(agent, "POST", malformedPath, {}, malformedToken)).status).toBe(410);
  }, 30_000);

  it("contains an unexpected request-handler rejection to the addressed cse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-handler-isolation-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    let index = 0;
    const core = new RelayCore({ newSessionId: () => `handler${++index}` });
    const failed = core.create({ title: "failed" });
    const sibling = core.create({ title: "sibling" });
    (failed as unknown as { sessionObj: () => Record<string, unknown> }).sessionObj = () => {
      throw new Error("injected request-handler failure");
    };
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);

    const failure = await rpcResponse(agent, "GET", `/v1/code/sessions/${failed.id}`);

    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({ error: "session request failed" });
    expect(failed.closed).toBe(true);
    expect(sibling.closed).toBe(false);
    expect((await rpcResponse(agent, "GET", `/v1/code/sessions/${sibling.id}`)).status).toBe(200);
  }, 30_000);

  it("terminally isolates malformed delivery input to its cse while a sibling stays live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-delivery-isolation-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    let index = 0;
    const core = new RelayCore({ newSessionId: () => `delivery${++index}` });
    const failed = core.create({ title: "failed" });
    const unattempted = core.create({ title: "unattempted" });
    const sibling = core.create({ title: "sibling" });
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const failedToken = await bridgeWorker(agent, failed.id);
    const unattemptedToken = await bridgeWorker(agent, unattempted.id);
    const siblingToken = await bridgeWorker(agent, sibling.id);

    expect(
      (
        await rpcResponse(agent, "POST", `/v1/code/sessions/${failed.id}/worker/events/delivery`, {
          updates: [],
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await rpcResponse(
          agent,
          "POST",
          `/v1/code/sessions/${failed.id}/worker/events/delivery`,
          { updates: [] },
          siblingToken,
        )
      ).status,
    ).toBe(401);
    expect(failed.closed).toBe(false);

    const malformed = await rpcResponse(
      agent,
      "POST",
      `/v1/code/sessions/${failed.id}/worker/events/delivery`,
      { updates: {} },
      failedToken,
    );

    expect(malformed.status).toBe(400);
    expect(failed.closed).toBe(true);
    const notWritten = unattempted.pushUserInput("not written");
    const premature = await rpcResponse(
      agent,
      "POST",
      `/v1/code/sessions/${unattempted.id}/worker/events/delivery`,
      { updates: [{ event_id: notWritten.eventId }] },
      unattemptedToken,
    );
    expect(premature.status).toBe(400);
    expect(unattempted.closed).toBe(true);
    expect(sibling.closed).toBe(false);
    expect((await rpcResponse(agent, "GET", `/v1/code/sessions/${sibling.id}`)).status).toBe(200);
    expect(
      (
        await rpcResponse(
          agent,
          "GET",
          `/v1/code/sessions/${sibling.id}/worker`,
          undefined,
          siblingToken,
        )
      ).status,
    ).toBe(200);
  }, 30_000);

  it("terminally closes after an unacknowledged mutating SSE write attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-no-redelivery-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    let nextSession = 0;
    const core = new RelayCore({ newSessionId: () => `reconnect${++nextSession}` });
    const session = core.create({ title: "reconnect" });
    session.pushInitialize();
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const workerToken = await bridgeWorker(agent, session.id);

    const first: Record<string, unknown>[] = [];
    const abortFirst = openWorkerStream(agent, session.id, workerToken, (event) =>
      first.push(event),
    );
    await waitFor(() => first.some((event) => event.event_type === "control_request"));
    session.pushUserInput("deliver once");
    await waitFor(() => first.some((event) => event.event_type === "user"));
    abortFirst();
    await waitFor(() => session.closed);
    expect(
      (
        await rpcResponse(
          agent,
          "GET",
          `/v1/code/sessions/${session.id}/worker/events/stream`,
          undefined,
          workerToken,
        )
      ).status,
    ).toBe(410);
    expect(() => session.pushUserInput("must not overtake ambiguity")).toThrow("session closed");

    const registeredSuccessor = await rpc(agent, "POST", "/v1/code/sessions", {
      title: "fresh successor",
    });
    const successorId = (registeredSuccessor.session as { id?: unknown }).id;
    expect(successorId).toBe("cse_reconnect2");
    expect(successorId).not.toBe(session.id);
    const successorToken = await bridgeWorker(agent, successorId as string);
    const successorEvents: Record<string, unknown>[] = [];
    const abortSuccessor = openWorkerStream(agent, successorId as string, successorToken, (event) =>
      successorEvents.push(event),
    );
    cleanup.push(abortSuccessor);
    await waitFor(() => successorEvents.some((event) => event.event_type === "control_request"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(successorEvents.filter((event) => event.event_type === "user")).toEqual([]);
  }, 30_000);

  it("returns 410 from every route under a closed cse without mutating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-closed-routes-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    const core = new RelayCore({ newSessionId: () => "closed" });
    const session = core.create({ title: "closed" });
    session.close();
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const base = `/v1/code/sessions/${session.id}`;
    const routes: Array<[string, string, unknown?]> = [
      ["GET", base],
      ["POST", `${base}/bridge`, {}],
      ["GET", `${base}/worker`],
      ["PUT", `${base}/worker`, { worker_status: "idle" }],
      ["POST", `${base}/worker/heartbeat`, { worker_epoch: 1 }],
      ["POST", `${base}/worker/events/delivery`, { updates: [] }],
      ["POST", `${base}/worker/events`, { worker_epoch: 1, events: [] }],
      ["GET", `${base}/worker/events/stream`],
      ["POST", `${base}/unknown`, {}],
    ];

    for (const [method, path, body] of routes) {
      expect((await rpcResponse(agent, method, path, body)).status, `${method} ${path}`).toBe(410);
    }
    expect(session.snapshotUpstream()).toEqual([]);
    expect(session.workerStatus).toBe("WORKER_STATUS_UNSPECIFIED");
  }, 30_000);

  it("accepts Claude 2.1.237 metadata-only worker updates and fences invalid variants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-mitm-worker-metadata-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = ensureCerts(dir);
    const ca = readFileSync(certs.caPem);
    let index = 0;
    const core = new RelayCore({ newSessionId: () => `worker-metadata-${++index}` });
    const valid = core.create({ title: "valid metadata" });
    const connection = core.create({ title: "valid connection" });
    const wrongEpoch = core.create({ title: "wrong epoch" });
    const malformed = core.create({ title: "malformed metadata" });
    const connected = core.create({ title: "unsupported connection value" });
    const extraConnection = core.create({ title: "extra connection field" });
    const proxy = new MitmProxy({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      core,
    });
    await proxy.listen();
    cleanup.push(() => void proxy.close());
    const agent = proxyAgent(proxy.port, ca);
    const validToken = await bridgeWorker(agent, valid.id);
    const connectionToken = await bridgeWorker(agent, connection.id);
    const wrongEpochToken = await bridgeWorker(agent, wrongEpoch.id);
    const malformedToken = await bridgeWorker(agent, malformed.id);
    const connectedToken = await bridgeWorker(agent, connected.id);
    const extraConnectionToken = await bridgeWorker(agent, extraConnection.id);

    expect(
      (
        await rpcResponse(
          agent,
          "PUT",
          `/v1/code/sessions/${valid.id}/worker`,
          { worker_epoch: 1, external_metadata: { current_branches: [] } },
          validToken,
        )
      ).status,
    ).toBe(200);
    expect(valid.closed).toBe(false);
    expect(valid.workerStatus).toBe("WORKER_STATUS_UNSPECIFIED");
    expect(
      (
        await rpcResponse(
          agent,
          "PUT",
          `/v1/code/sessions/${valid.id}/worker`,
          { worker_epoch: 1, worker_status: "idle", external_metadata: {} },
          validToken,
        )
      ).status,
    ).toBe(200);
    expect(valid.workerStatus).toBe("idle");

    expect(
      (
        await rpcResponse(
          agent,
          "PUT",
          `/v1/code/sessions/${connection.id}/worker`,
          { worker_epoch: 1, connection_status: "disconnected" },
          connectionToken,
        )
      ).status,
    ).toBe(200);
    expect(connection.closed).toBe(false);
    expect(connection.workerStatus).toBe("WORKER_STATUS_UNSPECIFIED");

    expect(
      (
        await rpcResponse(
          agent,
          "PUT",
          `/v1/code/sessions/${wrongEpoch.id}/worker`,
          { worker_epoch: 2, external_metadata: {} },
          wrongEpochToken,
        )
      ).status,
    ).toBe(400);
    expect(wrongEpoch.closed).toBe(true);

    expect(
      (
        await rpcResponse(
          agent,
          "PUT",
          `/v1/code/sessions/${malformed.id}/worker`,
          { worker_epoch: 1, external_metadata: null },
          malformedToken,
        )
      ).status,
    ).toBe(400);
    expect(malformed.closed).toBe(true);

    expect(
      (
        await rpcResponse(
          agent,
          "PUT",
          `/v1/code/sessions/${connected.id}/worker`,
          { worker_epoch: 1, connection_status: "connected" },
          connectedToken,
        )
      ).status,
    ).toBe(400);
    expect(connected.closed).toBe(true);

    expect(
      (
        await rpcResponse(
          agent,
          "PUT",
          `/v1/code/sessions/${extraConnection.id}/worker`,
          { worker_epoch: 1, connection_status: "disconnected", unexpected: true },
          extraConnectionToken,
        )
      ).status,
    ).toBe(400);
    expect(extraConnection.closed).toBe(true);
  }, 30_000);
});
