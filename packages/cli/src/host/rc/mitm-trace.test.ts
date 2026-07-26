// Transparent trace-mode integration tests. A real TLS client connects through the MITM, while an
// injected request transport routes the upstream leg to a loopback fake Anthropic service. This pins
// the production invariant: observability may sanitize its copy, but never mutate protocol bytes.

import { execFileSync } from "node:child_process";
import { errorMonitor } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  type ClientRequest,
  createServer,
  type RequestOptions as HttpRequestOptions,
  request as httpRequest,
  type IncomingMessage,
  Server,
  type ServerResponse,
} from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import {
  createServer as createNetServer,
  type Server as NetServer,
  connect as netConnect,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildFilter,
  createTracer,
  formatRecordJson,
  TRACE_REDACTED,
  type TraceRecord,
} from "../../trace.js";
import { ensureCerts, MITM_HOST } from "./certs.js";
import { MitmProxy, type UpstreamRequest } from "./mitm.js";

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
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rc-mitm-trace-"));
  dirs.push(dir);
  return dir;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("fake upstream did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function listenNet(server: NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("tunnel target did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

function openBlindTunnel(proxyPort: number, targetPort: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`,
      );
    });
    let banner = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      banner = Buffer.concat([banner, chunk]);
      if (!banner.includes(Buffer.from("\r\n\r\n"))) return;
      socket.removeListener("data", onData);
      resolve(socket);
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

/** An https.Agent that tunnels through our proxy via CONNECT, trusting our generated MITM CA. */
function proxyAgent(proxyPort: number, ca: Buffer): Agent {
  const agent = new Agent({ ca, keepAlive: false });
  (agent as unknown as { createConnection: unknown }).createConnection = (
    opts: { host?: string; port?: number },
    cb: (err: Error | null, socket?: unknown) => void,
  ) => {
    const host = opts.host ?? MITM_HOST;
    const port = opts.port ?? 443;
    const raw = netConnect(proxyPort, "127.0.0.1", () => {
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let banner = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      banner = Buffer.concat([banner, chunk]);
      if (!banner.includes(Buffer.from("\r\n\r\n"))) return;
      raw.removeListener("data", onData);
      const tls = tlsConnect({ socket: raw, servername: host, ca }, () => cb(null, tls));
      tls.on("error", (error) => cb(error));
    };
    raw.on("data", onData);
    raw.on("error", (error) => cb(error));
  };
  return agent;
}

function tlsSocketThroughProxy(proxyPort: number, ca: Buffer): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const raw = netConnect(proxyPort, "127.0.0.1", () => {
      raw.write(`CONNECT ${MITM_HOST}:443 HTTP/1.1\r\nHost: ${MITM_HOST}:443\r\n\r\n`);
    });
    let banner = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      banner = Buffer.concat([banner, chunk]);
      if (!banner.includes(Buffer.from("\r\n\r\n"))) return;
      raw.removeListener("data", onData);
      const tls = tlsConnect({ socket: raw, servername: MITM_HOST, ca }, () => resolve(tls));
      tls.on("error", reject);
    };
    raw.on("data", onData);
    raw.on("error", reject);
  });
}

interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

function requestThroughProxy(
  agent: Agent,
  method: string,
  path: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: MITM_HOST,
        port: 443,
        method,
        path,
        agent: agent as RequestOptions["agent"],
        headers: {
          ...headers,
          "content-length": String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body.length > 0) req.write(body);
    req.end();
  });
}

function openStreamThroughProxy(agent: Agent, path: string): Promise<ClientRequest> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: MITM_HOST,
        port: 443,
        method: "GET",
        path,
        agent: agent as RequestOptions["agent"],
        headers: { accept: "text/event-stream" },
      },
      (res) => {
        res.on("data", () => {});
        // Destroying the client request intentionally aborts this response in lifecycle tests.
        res.on("error", () => {});
        resolve(req);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function readRequest(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function loopbackRequest(
  port: number,
  onResponse?: (response: IncomingMessage) => void,
): UpstreamRequest {
  return (options, callback): ClientRequest => {
    const { servername: _servername, ...rest } = options;
    const local: HttpRequestOptions = {
      ...rest,
      host: "127.0.0.1",
      hostname: "127.0.0.1",
      port,
    };
    return httpRequest(local, (response) => {
      onResponse?.(response);
      callback(response);
    });
  };
}

interface Harness {
  proxy: MitmProxy;
  agent: Agent;
  ca: Buffer;
  upstream: Server;
  records: TraceRecord[];
  close(): Promise<void>;
}

async function startHarness(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: {
    log?: "warn" | "trace";
    onUpstreamResponse?: (response: IncomingMessage) => void;
  } = {},
): Promise<Harness> {
  const upstream = createServer(handler);
  const upstreamPort = await listen(upstream);
  const certs = ensureCerts(tempDir());
  const records: TraceRecord[] = [];
  const tracer = createTracer("rc.mitm", {
    filter: buildFilter(options.log ?? "trace"),
    sink: (record) => records.push(record),
    now: () => 0,
  });
  const proxy = new MitmProxy({
    port: 0,
    leafCert: certs.leafPem,
    leafKey: certs.leafKey,
    mode: "trace",
    tracer,
    upstreamRequest: loopbackRequest(upstreamPort, options.onUpstreamResponse),
  });
  await proxy.listen();
  const ca = readFileSync(certs.caPem);
  const agent = proxyAgent(proxy.port, ca);
  return {
    proxy,
    agent,
    ca,
    upstream,
    records,
    async close() {
      agent.destroy();
      await proxy.close();
      await closeServer(upstream);
    },
  };
}

function rendered(records: TraceRecord[]): string {
  return records.map((record) => formatRecordJson(record)).join("\n");
}

describe.skipIf(!RUN)("MITM trace passthrough", () => {
  it("preserves RC request/response bytes and credential headers while redacting every trace sink", async () => {
    const requestAccess = "oauth-access-request-canary";
    const requestRefresh = "oauth-refresh-request-canary";
    const requestBearer = "oauth-header-request-canary";
    const requestCookie = "cookie-request-canary";
    const requestApiKey = "api-key-request-canary";
    const embeddedBearer = "embedded-bearer-request-canary";
    const workerJwt = `sk-${["ant", "si", "worker-response-canary"].join("-")}`;
    const responseAccess = "oauth-access-response-canary";
    const responseCookie = "cookie-response-canary";
    const requestBody = Buffer.from(
      JSON.stringify({
        title: "safe-request-title",
        auth: { accessToken: requestAccess, refresh_token: requestRefresh },
        text: `Bearer ${embeddedBearer}`,
      }),
    );
    const responseBody = Buffer.from(
      JSON.stringify({
        api_base_url: "https://api.anthropic.com",
        worker_jwt: workerJwt,
        nested: { access_token: responseAccess },
        safe: "safe-response-value",
      }),
    );

    let seen:
      | {
          method: string | undefined;
          url: string | undefined;
          headers: IncomingMessage["headers"];
          body: Buffer;
        }
      | undefined;
    const harness = await startHarness((req, res) => {
      void readRequest(req).then((body) => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(201, {
          "content-type": "application/json",
          "content-length": String(responseBody.length),
          "set-cookie": `session=${responseCookie}`,
          "x-upstream": "kept",
        });
        res.end(responseBody);
      });
    });

    try {
      const response = await requestThroughProxy(
        harness.agent,
        "POST",
        "/v1/code/sessions/cse_trace/bridge?cursor=a%2Fb",
        requestBody,
        {
          "content-type": "application/json",
          authorization: `Bearer ${requestBearer}`,
          cookie: `session=${requestCookie}`,
          "x-api-key": requestApiKey,
          "x-forward-me": "yes",
        },
      );

      expect(seen?.method).toBe("POST");
      expect(seen?.url).toBe("/v1/code/sessions/cse_trace/bridge?cursor=a%2Fb");
      expect(seen?.body.equals(requestBody)).toBe(true);
      expect(seen?.headers.authorization).toBe(`Bearer ${requestBearer}`);
      expect(seen?.headers.cookie).toBe(`session=${requestCookie}`);
      expect(seen?.headers["x-api-key"]).toBe(requestApiKey);
      expect(seen?.headers["x-forward-me"]).toBe("yes");
      expect(seen?.headers["accept-encoding"]).toBe("identity");
      expect(seen?.headers["content-length"]).toBe(String(requestBody.length));

      expect(response.status).toBe(201);
      expect(response.body.equals(responseBody)).toBe(true);
      expect(response.headers["x-upstream"]).toBe("kept");
      expect(response.headers["set-cookie"]).toEqual([`session=${responseCookie}`]);

      const trace = rendered(harness.records);
      for (const secret of [
        requestAccess,
        requestRefresh,
        requestBearer,
        requestCookie,
        requestApiKey,
        embeddedBearer,
        workerJwt,
        responseAccess,
        responseCookie,
      ]) {
        expect(trace, `${secret} leaked`).not.toContain(secret);
      }
      expect(trace).toContain("safe-request-title");
      expect(trace).toContain("safe-response-value");
      expect(trace).toContain(TRACE_REDACTED);
      expect(trace).toContain("/v1/code/sessions/{id}/bridge");
    } finally {
      await harness.close();
    }
  });

  it("tees SSE payload bytes unchanged while tracing a redacted structured copy", async () => {
    const workerJwt = `sk-${["ant", "si", "sse-worker-canary"].join("-")}`;
    const event = {
      payload: {
        type: "user",
        worker_jwt: workerJwt,
        message: { content: "safe snowman ☃" },
      },
    };
    const source = Buffer.from(
      `:keepalive\r\n\r\nevent: client_event\r\nid: 7\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
    );
    const snowman = source.indexOf(Buffer.from("☃"));
    const cuts = [1, 13, snowman + 1, snowman + 2, source.length - 3, source.length];
    const chunks: Buffer[] = [];
    let start = 0;
    for (const end of cuts) {
      if (end > start) chunks.push(source.subarray(start, end));
      start = end;
    }

    const harness = await startHarness((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
    try {
      const response = await requestThroughProxy(
        harness.agent,
        "GET",
        "/v1/code/sessions/cse_trace/worker/events/stream",
        Buffer.alloc(0),
        { accept: "text/event-stream" },
      );
      expect(response.status).toBe(200);
      expect(response.body.equals(source)).toBe(true);

      const trace = rendered(harness.records);
      expect(trace).not.toContain(workerJwt);
      expect(trace).toContain("safe snowman ☃");
      expect(trace).toContain(TRACE_REDACTED);
      expect(trace).toContain('"event":"client_event"');
      expect(trace).toContain('"id":"7"');
      expect(trace).toContain('"type":"user"');
    } finally {
      await harness.close();
    }
  });

  it("does not body-trace non-RC OAuth traffic", async () => {
    const oauthRequest = "oauth-non-rc-request-canary";
    const oauthResponse = "oauth-non-rc-response-canary";
    const requestBody = Buffer.from(JSON.stringify({ access_token: oauthRequest }));
    const responseBody = Buffer.from(JSON.stringify({ refresh_token: oauthResponse }));
    const harness = await startHarness((req, res) => {
      void readRequest(req).then(() => {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(responseBody.length),
        });
        res.end(responseBody);
      });
    });
    try {
      const response = await requestThroughProxy(
        harness.agent,
        "POST",
        "/api/oauth/token",
        requestBody,
        { "content-type": "application/json" },
      );
      expect(response.body.equals(responseBody)).toBe(true);
      const trace = rendered(harness.records);
      expect(trace).not.toContain(oauthRequest);
      expect(trace).not.toContain(oauthResponse);
      expect(harness.records).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("bounds a single oversized response copy while forwarding the complete body", async () => {
    const workerJwt = `sk-${["ant", "si", "large-worker-canary"].join("-")}`;
    const responseBody = Buffer.from(
      JSON.stringify({ worker_jwt: workerJwt, padding: "x".repeat(300 * 1024) }),
    );
    const harness = await startHarness((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(responseBody.length),
      });
      res.end(responseBody);
    });
    try {
      const response = await requestThroughProxy(
        harness.agent,
        "POST",
        "/v1/code/sessions/cse_trace/bridge",
        Buffer.from("{}"),
        { "content-type": "application/json" },
      );
      expect(response.body.equals(responseBody)).toBe(true);
      const trace = rendered(harness.records);
      expect(trace).not.toContain(workerJwt);
      expect(trace).toContain("RC_BODY_OMITTED");
      expect(trace.length).toBeLessThan(10_000);
    } finally {
      await harness.close();
    }
  });

  it("bounds an oversized request trace copy while forwarding the complete body", async () => {
    const workerJwt = `sk-${["ant", "si", "large-request-canary"].join("-")}`;
    const requestBody = Buffer.from(
      JSON.stringify({ worker_jwt: workerJwt, padding: "x".repeat(300 * 1024) }),
    );
    let seen: Buffer | undefined;
    const harness = await startHarness((req, res) => {
      void readRequest(req).then((body) => {
        seen = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    try {
      const response = await requestThroughProxy(
        harness.agent,
        "POST",
        "/v1/code/sessions/cse_trace/worker/events",
        requestBody,
        { "content-type": "application/json" },
      );
      expect(response.status).toBe(200);
      expect(seen?.equals(requestBody)).toBe(true);
      const trace = rendered(harness.records);
      expect(trace).not.toContain(workerJwt);
      expect(trace).toContain("RC_BODY_OMITTED");
      expect(trace.length).toBeLessThan(10_000);
    } finally {
      await harness.close();
    }
  });

  it("never forwards an aborted partial request, including across proxy shutdown", async () => {
    let upstreamRequests = 0;
    const harness = await startHarness((_req, res) => {
      upstreamRequests += 1;
      res.end("{}");
    });
    const socket = await tlsSocketThroughProxy(harness.proxy.port, harness.ca);
    socket.write(
      [
        "POST /v1/code/sessions/cse_trace/worker/events HTTP/1.1",
        `Host: ${MITM_HOST}`,
        "Content-Type: application/json",
        "Content-Length: 4096",
        "",
        '{"events":[{"payload":{"type":"user"}}]}',
      ].join("\r\n"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    try {
      await harness.proxy.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(upstreamRequests).toBe(0);
    } finally {
      socket.destroy();
      await harness.close();
    }
  });

  it("handles an upstream response reset on the production-default plain forwarding path", async () => {
    let markUpstreamClosed: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve;
    });
    let markResponseError: ((error: Error) => void) | undefined;
    const responseError = new Promise<Error>((resolve) => {
      markResponseError = resolve;
    });
    const harness = await startHarness(
      (_req, res) => {
        res.once("close", () => markUpstreamClosed?.());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(":keepalive\n\n");
        // Deliberately remain open until the downstream disconnect tears this response down.
      },
      {
        log: "warn",
        onUpstreamResponse: (response) => {
          // Observe without consuming: the proxy itself must install the normal error listener.
          response.once(errorMonitor, (error) => markResponseError?.(error as Error));
        },
      },
    );
    const stream = await openStreamThroughProxy(
      harness.agent,
      "/v1/code/sessions/cse_trace/worker/events/stream",
    );
    try {
      stream.destroy();
      const error = await Promise.race([
        responseError,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("upstream response did not reset")), 2_000),
        ),
      ]);
      expect(error.message).toMatch(/aborted|reset/i);
      const closed = await Promise.race([
        upstreamClosed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(closed).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      stream.destroy();
      await harness.close();
    }
  });

  it("destroys a long-lived upstream SSE request during proxy shutdown", async () => {
    let markUpstreamClosed: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
      markUpstreamClosed = resolve;
    });
    const harness = await startHarness((req, res) => {
      req.once("close", () => markUpstreamClosed?.());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(":keepalive\n\n");
      // Deliberately never end: MitmProxy.close() must own this upstream request.
    });
    const stream = await openStreamThroughProxy(
      harness.agent,
      "/v1/code/sessions/cse_trace/worker/events/stream",
    );
    try {
      const closed = await Promise.race([
        harness.proxy.close().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(closed).toBe(true);
      const upstreamWasClosed = await Promise.race([
        upstreamClosed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(upstreamWasClosed).toBe(true);
    } finally {
      stream.destroy();
      await harness.close();
    }
  });

  it("destroys CONNECT-upgraded blind-tunnel sockets during proxy shutdown", async () => {
    const target = createNetServer(() => {
      // Keep the accepted tunnel open: MitmProxy.close() must destroy both tunnel endpoints.
    });
    const targetPort = await listenNet(target);
    const harness = await startHarness((_req, res) => res.end());
    const tunnel = await openBlindTunnel(harness.proxy.port, targetPort);
    try {
      const closed = await Promise.race([
        harness.proxy.close().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(closed).toBe(true);
    } finally {
      tunnel.destroy();
      await harness.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("stops CONNECT admission before sweeping and rejects an already-queued upgrade", async () => {
    const pairServer = createNetServer();
    let acceptSocket: ((socket: Socket) => void) | undefined;
    const acceptedPromise = new Promise<Socket>((resolve) => {
      acceptSocket = resolve;
    });
    pairServer.on("connection", (socket) => acceptSocket?.(socket));
    const pairPort = await listenNet(pairServer);
    const peer = netConnect(pairPort, "127.0.0.1");
    peer.on("error", () => {});
    const peerConnected = new Promise<void>((resolve) => peer.once("connect", resolve));
    const [accepted] = await Promise.all([acceptedPromise, peerConnected]);
    const received: Buffer[] = [];
    peer.on("data", (chunk: Buffer) => received.push(chunk));

    const harness = await startHarness((_req, res) => res.end());
    const proxyPort = harness.proxy.port;
    const order: string[] = [];
    let outerServer: Server | undefined;
    let markInjected: (() => void) | undefined;
    const injected = new Promise<void>((resolve) => {
      markInjected = resolve;
    });
    const originalClose = Server.prototype.close;
    const originalCloseAll = Server.prototype.closeAllConnections;
    const closeSpy = vi.spyOn(Server.prototype, "close").mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void,
    ): Server {
      const address = this.address();
      if (typeof address === "object" && address !== null && address.port === proxyPort) {
        outerServer = this;
        order.push("close");
      }
      return Reflect.apply(originalClose, this, callback === undefined ? [] : [callback]) as Server;
    });
    const closeAllSpy = vi
      .spyOn(Server.prototype, "closeAllConnections")
      .mockImplementation(function (this: Server): void {
        const address = this.address();
        const isOuter =
          this === outerServer ||
          (typeof address === "object" && address !== null && address.port === proxyPort);
        if (isOuter) {
          outerServer = this;
          order.push("closeAllConnections");
        }
        Reflect.apply(originalCloseAll, this, []);
        if (isOuter) {
          // Model a CONNECT event that was already queued when close() stopped admission. Emitting it
          // after the sweep makes the stopped guard—not timing luck—own the regression.
          queueMicrotask(() => {
            this.emit(
              "connect",
              { url: `${MITM_HOST}:443` } as IncomingMessage,
              accepted,
              Buffer.alloc(0),
            );
            markInjected?.();
          });
        }
      });

    try {
      await Promise.all([harness.proxy.close(), injected]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual(["close", "closeAllConnections"]);
      expect(accepted.destroyed).toBe(true);
      expect(Buffer.concat(received).toString("utf8")).not.toContain("200 Connection Established");
    } finally {
      closeAllSpy.mockRestore();
      closeSpy.mockRestore();
      accepted.destroy();
      peer.destroy();
      await harness.close();
      await new Promise<void>((resolve) => pairServer.close(() => resolve()));
    }
  });
});
