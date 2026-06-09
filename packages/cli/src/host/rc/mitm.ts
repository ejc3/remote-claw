// The MITM proxy — a faithful port of phase0/remote_claw/mitm.py to Node's http/tls/net.
//
// `claude` is pointed here via HTTPS_PROXY. For `api.anthropic.com` we TLS-terminate with our leaf
// (claude trusts our CA via NODE_EXTRA_CA_CERTS) and either:
//   • INTERCEPT the Remote Control endpoints (`/v1/code/sessions*`, `/v1/code/triggers`) — we are the
//     RC backend, serving them from the in-memory RelayCore; or
//   • PASS THROUGH everything else (inference `/v1/messages`, OAuth, telemetry) to the real upstream.
// Any other host is blind-tunnelled untouched. This is the §14/§17.5 mechanism, verified in Phase 0.

import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type IncomingMessage, Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { MITM_HOST } from "./certs.js";
import { assistantText, type RelayCore, type Session } from "./session.js";

/** Endpoint prefixes we serve ourselves; everything else on the MITM host is passed through. */
const INTERCEPT_PREFIXES = ["/v1/code/sessions", "/v1/code/triggers"];

const SESS_RE = /^\/v1\/code\/sessions\/([^/?]+)(\/[^?]*)?/;

export interface MitmOptions {
  /** Loopback port the proxy listens on (HTTPS_PROXY points here). */
  port: number;
  /** PEM file paths for the leaf cert/key we present for api.anthropic.com. */
  leafCert: string;
  leafKey: string;
  core: RelayCore;
  /** Called when claude registers a new RC session (POST /v1/code/sessions) — the wrapper announces
   *  it on the bus and starts pumping its upstream to the broker. */
  onSession?: (s: Session) => void;
  /** Optional logger (defaults to no-op; the relay never logs secrets). */
  log?: (msg: string) => void;
}

export class MitmProxy {
  readonly #opts: MitmOptions;
  readonly #server: Server;
  /** The inner HTTP server that parses requests off each TLS-terminated client socket. */
  readonly #inner: Server;
  readonly #leaf: { cert: Buffer; key: Buffer };
  #stopped = false;

  constructor(opts: MitmOptions) {
    this.#opts = opts;
    this.#leaf = { cert: readFileSync(opts.leafCert), key: readFileSync(opts.leafKey) };
    this.#inner = new Server((req, res) => this.#onRequest(req, res));
    this.#server = new Server((_req, res) => {
      // A plain (non-CONNECT) request to the proxy: nothing to serve.
      res.writeHead(400).end("proxy expects CONNECT");
    });
    this.#server.on("connect", (req, socket, head) => this.#onConnect(req, socket as Socket, head));
  }

  /** Start listening on 127.0.0.1:port. Resolves once bound. */
  async listen(): Promise<void> {
    this.#server.listen(this.#opts.port, "127.0.0.1");
    await once(this.#server, "listening");
  }

  get port(): number {
    const addr = this.#server.address();
    return typeof addr === "object" && addr !== null ? addr.port : this.#opts.port;
  }

  async close(): Promise<void> {
    this.#stopped = true;
    // Wake every worker-SSE follower NOW (close() sets #stopped, but a follower parked on the
    // session Gate's heartbeat wait wouldn't re-check it for up to HEARTBEAT_MS). Closing the
    // sessions wakes their gates so #streamWorker loops exit and end their responses immediately.
    this.#opts.core.closeAll();
    this.#server.close();
    this.#inner.close();
  }

  #log(msg: string): void {
    this.#opts.log?.(msg);
  }

  // ---- CONNECT handling ----
  #onConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const { host, port } = splitAuthority(req.url ?? "");
    if (host === MITM_HOST) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Any bytes the client pipelined after the CONNECT line are the START of its TLS ClientHello —
      // push them back onto the RAW socket so the TLS engine consumes them as handshake input.
      // (Unshifting onto the TLSSocket would feed raw ciphertext to the decoded-plaintext side and
      // break the handshake.) Normally empty for HTTPS_PROXY, but a coalescing client can pipeline.
      if (head?.length) clientSocket.unshift(head);
      const tls = new TLSSocket(clientSocket, {
        isServer: true,
        cert: this.#leaf.cert,
        key: this.#leaf.key,
        ALPNProtocols: ["http/1.1"],
      });
      tls.on("error", (e) => this.#log(`client TLS error: ${e.message}`));
      // Hand the decrypted stream to the inner HTTP server for request parsing.
      this.#inner.emit("connection", tls);
    } else {
      this.#blindTunnel(clientSocket, host, port, head);
    }
  }

  #blindTunnel(clientSocket: Socket, host: string, port: number, head: Buffer): void {
    const upstream = netConnect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const kill = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", kill);
    clientSocket.on("error", kill);
  }

  // ---- request handling (intercept or passthrough) ----
  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?", 1)[0] ?? ""; // the path WITHOUT query — only for intercept matching
    const body = await readBody(req);
    if (INTERCEPT_PREFIXES.some((p) => path.startsWith(p))) {
      this.#log(`intercept ${req.method} ${rawUrl}`);
      this.#intercept(req.method ?? "GET", path, body, res);
    } else {
      // Pass the FULL request-target (query string included) upstream — stripping `?…` would drop
      // params the real API needs (e.g. /api/claude_cli/bootstrap?entrypoint=…&model=…, ?limit=…).
      this.#passthrough(req, rawUrl, body, res);
    }
  }

  // Returns the ServerResponse it handled (Express-style: `sendJson` returns `res`, the SSE branch
  // returns `res` directly), so the `return sendJson(...)` early-exits are legal (biome forbids a
  // value-return from a `void` function — noVoidTypeReturn — and dislikes `void` in a union).
  #intercept(method: string, path: string, body: Buffer, res: ServerResponse): ServerResponse {
    let data: Record<string, unknown> = {};
    if (body.length) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
      } catch {
        return sendJson(res, { error: "invalid json" }, 400);
      }
    }

    if (path === "/v1/code/triggers") return sendJson(res, { data: [] });

    if (path === "/v1/code/sessions" && method === "POST") {
      const s = this.#opts.core.create(data);
      // Enqueue `initialize` as downstream seq 1 AT CREATE — before onSession announces the session and
      // a fast client prompt could race a `user` event ahead of it. The worker's SSE then always
      // receives initialize first (pushInitialize is idempotent, so #streamWorker's call is a no-op).
      s.pushInitialize();
      this.#log(`session created: ${s.id} (title=${s.title})`);
      this.#opts.onSession?.(s);
      return sendJson(res, { session: s.sessionObj() });
    }

    const m = SESS_RE.exec(path);
    if (!m) return sendJson(res, { error: "not found" }, 404);
    const sid = m[1] as string;
    const sub = m[2] ?? "";
    const s = this.#opts.core.get(sid);
    if (!s) return sendJson(res, { error: "no such session" }, 404);

    if (sub === "" && method === "GET") return sendJson(res, { session: s.sessionObj() });
    if (sub === "/bridge") {
      return sendJson(res, {
        api_base_url: `https://${MITM_HOST}`,
        expires_in: 14400,
        worker_epoch: "1",
        worker_jwt: `rcw-${s.id}`,
      });
    }
    if (sub === "/worker" && method === "GET") {
      return sendJson(res, {
        worker: {
          session_id: sid,
          worker_epoch: String(s.workerEpoch),
          worker_status: s.workerStatus,
        },
      });
    }
    if (sub === "/worker" && method === "PUT") {
      if (typeof data.worker_status === "string") s.workerStatus = data.worker_status;
      return sendJson(res, {});
    }
    if (sub === "/worker/heartbeat") return sendJson(res, {});
    if (sub === "/worker/events/delivery") {
      for (const upd of (data.updates as Array<{ event_id?: string }>) ?? []) {
        if (upd.event_id) s.ack(upd.event_id);
      }
      return sendJson(res, {});
    }
    if (sub === "/worker/events" && method === "POST") {
      const results: Array<{ event_id: string; sequence_num: string; duplicate: boolean }> = [];
      for (const ev of (data.events as Array<{ payload?: Record<string, unknown> }>) ?? []) {
        const payload = ev.payload ?? {};
        const up = s.pushUpstream(payload);
        results.push({
          event_id: up.eventId,
          sequence_num: String(up.sequenceNum),
          duplicate: false,
        });
        if (payload.type === "assistant") {
          const txt = assistantText(payload);
          if (txt) this.#log(`⇠ assistant (${s.id.slice(0, 12)}): ${clip(txt)}`);
        }
      }
      return sendJson(res, { results });
    }
    if (sub === "/worker/events/stream" && method === "GET") {
      void this.#streamWorker(s, res); // long-lived SSE; runs until the worker disconnects
      return res;
    }
    return sendJson(res, {});
  }

  async #streamWorker(s: Session, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "close",
    });
    const gen = s.claimWorkerStream(); // supersede any prior stream → single deliverer
    s.pushInitialize();
    this.#log(`worker SSE connected: ${s.id} (gen ${gen})`);
    // A remote disconnect can close/destroy the response WITHOUT setting writableEnded, so watch the
    // `close` event too — else a dead follower lingers, waking on every heartbeat and holding the
    // response forever. The flag is re-checked by the stop predicate below.
    let closed = false;
    res.on("close", () => {
      closed = true;
      s.wake(); // break the follower out of its heartbeat wait immediately
    });
    try {
      for await (const ev of s.followDownstream(
        gen,
        () => this.#stopped || closed || res.writableEnded || res.destroyed,
      )) {
        if (ev === null) {
          res.write(":keepalive\n\n");
          continue;
        }
        res.write(
          `event: client_event\nid: ${ev.sequenceNum}\ndata: ${JSON.stringify(ev.wire())}\n\n`,
        );
      }
    } catch {
      // client/socket went away — the follower exits on the stop predicate
    } finally {
      res.end();
    }
  }

  #passthrough(req: IncomingMessage, path: string, body: Buffer, res: ServerResponse): void {
    // Forward to the REAL upstream over a fresh TLS connection (default CA validation). Drop
    // hop-by-hop + framing headers; set an exact Content-Length from the fully-read body.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk === "content-length" || lk === "accept-encoding") continue;
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    headers["content-length"] = String(body.length);
    headers["accept-encoding"] = "identity";

    const upstream = httpsRequest(
      { host: MITM_HOST, port: 443, method: req.method, path, headers, servername: MITM_HOST },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    if (body.length) upstream.write(body);
    upstream.end();
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** Parse a CONNECT authority (`host:port`, IPv6-literal safe) into (host, port). */
export function splitAuthority(authority: string): { host: string; port: number } {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    const host = authority.slice(1, end);
    const rest = authority.slice(end + 1).replace(/^:/, "");
    return { host, port: Number.parseInt(rest || "443", 10) };
  }
  const idx = authority.lastIndexOf(":");
  if (idx === -1) return { host: authority, port: 443 };
  return {
    host: authority.slice(0, idx),
    port: Number.parseInt(authority.slice(idx + 1) || "443", 10),
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

/** Send a JSON response and return it (Express-style), so callers can `return sendJson(...)`. */
function sendJson(res: ServerResponse, obj: unknown, status = 200): ServerResponse {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
  res.end(body);
  return res;
}

function clip(s: string, n = 80): string {
  const flat = s.replace(/\n/g, " ");
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}
