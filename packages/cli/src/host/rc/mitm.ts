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
import { NOOP_TRACER, type Tracer } from "../../trace.js";
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
  /**
   * "relay" (default): INTERCEPT the RC endpoints and serve them from `core` — the wrapper backend.
   * "trace": pass EVERYTHING through to real Anthropic and TRACE the RC traffic both ways — a live
   * protocol inspector (point it at the real API, drive it from real claude). No `core` needed.
   */
  mode?: "relay" | "trace";
  /** The RelayCore the relay serves RC endpoints from. Required in "relay" mode; unused in "trace". */
  core?: RelayCore;
  /** Called when claude registers a new RC session (POST /v1/code/sessions) — the wrapper announces
   *  it on the bus and starts pumping its upstream to the broker. (relay mode only) */
  onSession?: (s: Session) => void;
  /** Optional structured tracer (target "rc.mitm"; defaults to no-op). Local-only sink; in trace mode
   *  it dumps full RC bodies (no key material — auth headers are never passed to it). */
  tracer?: Tracer;
}

export class MitmProxy {
  readonly #opts: MitmOptions;
  readonly #server: Server;
  /** The inner HTTP server that parses requests off each TLS-terminated client socket. */
  readonly #inner: Server;
  readonly #leaf: { cert: Buffer; key: Buffer };
  readonly #trace: Tracer;
  #stopped = false;

  constructor(opts: MitmOptions) {
    this.#opts = opts;
    this.#trace = opts.tracer ?? NOOP_TRACER;
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
    this.#opts.core?.closeAll();
    this.#server.close();
    this.#inner.close();
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
      tls.on("error", (e) => this.#trace.warn("client TLS error", { error: e.message }));
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
    const rc = rcLabel(path); // an RC worker endpoint (session id masked), or null
    if (
      (this.#opts.mode ?? "relay") === "relay" &&
      INTERCEPT_PREFIXES.some((p) => path.startsWith(p))
    ) {
      this.#trace.debug("intercept", { method: req.method ?? "GET", path });
      this.#intercept(req.method ?? "GET", path, body, res);
    } else {
      // Pass the FULL request-target (query string included) upstream — stripping `?…` would drop
      // params the real API needs (e.g. /api/claude_cli/bootstrap?entrypoint=…&model=…, ?limit=…). In
      // trace mode, an RC endpoint is traced both ways as it flows to/from the real upstream.
      if (rc !== null) this.#traceRcRequest(req.method ?? "GET", rc, body);
      this.#passthrough(req, rawUrl, body, res, rc);
    }
  }

  /** Trace one client→Anthropic RC request: the verb/path always; the worker event types it carries
   *  at debug; the full body at trace. Auth headers are never touched (they aren't passed here). */
  #traceRcRequest(method: string, label: string, body: Buffer): void {
    if (!this.#trace.enabled("info")) return;
    const fields: Record<string, string | number> = { dir: "→", method, path: label };
    if (this.#trace.enabled("debug")) {
      const json = tryJson(body);
      if (json) {
        if (Array.isArray(json.events))
          fields.events = json.events.map((e) => evType(e)).join(",") || "0";
        if (Array.isArray(json.updates)) fields.acks = json.updates.length;
        if (typeof json.worker_status === "string") fields.worker_status = json.worker_status;
      }
    }
    this.#trace.info("rc →", fields);
    if (this.#trace.enabled("trace") && body.length) {
      this.#trace.trace("rc → body", { body: body.toString("utf8") });
    }
  }

  // Returns the ServerResponse it handled (Express-style: `sendJson` returns `res`, the SSE branch
  // returns `res` directly), so the `return sendJson(...)` early-exits are legal (biome forbids a
  // value-return from a `void` function — noVoidTypeReturn — and dislikes `void` in a union).
  #intercept(method: string, path: string, body: Buffer, res: ServerResponse): ServerResponse {
    const core = this.#opts.core;
    if (!core) return sendJson(res, { error: "no relay core" }, 500); // relay mode always has one
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
      const s = core.create(data);
      // Enqueue `initialize` as downstream seq 1 AT CREATE — before onSession announces the session and
      // a fast client prompt could race a `user` event ahead of it. The worker's SSE then always
      // receives initialize first (pushInitialize is idempotent, so #streamWorker's call is a no-op).
      s.pushInitialize();
      this.#trace.info("session created", { session: s.id, title: s.title });
      this.#opts.onSession?.(s);
      return sendJson(res, { session: s.sessionObj() });
    }

    const m = SESS_RE.exec(path);
    if (!m) return sendJson(res, { error: "not found" }, 404);
    const sid = m[1] as string;
    const sub = m[2] ?? "";
    const s = core.get(sid);
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
        // At debug (opt-in) we include a clipped content preview — the formatter bounds it. Secrets
        // (keys, OAuth) are never carried here; conversation text is fine once you've asked for debug.
        if (this.#trace.enabled("debug")) {
          const type = typeof payload.type === "string" ? payload.type : "event";
          const fields: { session: string; type: string; bytes?: number; text?: string } = {
            session: s.id,
            type,
          };
          if (payload.type === "assistant") {
            const txt = assistantText(payload);
            fields.bytes = txt.length;
            fields.text = txt;
          }
          this.#trace.debug("upstream event", fields);
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
    this.#trace.debug("worker SSE connected", { session: s.id, gen });
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

  #passthrough(
    req: IncomingMessage,
    path: string,
    body: Buffer,
    res: ServerResponse,
    rc: string | null = null,
  ): void {
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
        if (rc !== null)
          this.#trace.info("rc ←", { dir: "←", path: rc, status: up.statusCode ?? 0 });
        const isSse = String(up.headers["content-type"] ?? "").includes("text/event-stream");
        if (rc !== null && isSse && this.#trace.enabled("debug")) {
          this.#teeSse(rc, up, res); // worker event stream: forward + trace each event
        } else if (rc !== null && this.#trace.enabled("trace")) {
          this.#teeJson(rc, up, res); // small JSON response: forward + dump the body at trace
        } else {
          up.pipe(res);
        }
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    if (body.length) upstream.write(body);
    upstream.end();
  }

  /** Forward an SSE response unchanged while parsing each `event:/id:/data:` block to trace the worker
   *  event type (Anthropic→worker direction). Forwarding happens first, so tracing never delays delivery. */
  #teeSse(label: string, up: IncomingMessage, res: ServerResponse): void {
    let buf = "";
    up.on("data", (chunk: Buffer) => {
      res.write(chunk);
      buf += chunk.toString("utf8");
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.#traceSseEvent(label, raw);
        idx = buf.indexOf("\n\n");
      }
    });
    up.on("end", () => res.end());
    up.on("error", () => res.end());
  }

  #traceSseEvent(label: string, raw: string): void {
    const { event, id, data } = parseSseBlock(raw);
    if (event === "" && data === "") return; // a keepalive (":...") — nothing to trace
    this.#trace.debug("rc ← sse", {
      dir: "←",
      path: label,
      event,
      id,
      type: evType(tryJson(data)),
    });
    if (this.#trace.enabled("trace") && data !== "") this.#trace.trace("rc ← sse data", { data });
  }

  /** Forward a non-SSE response while buffering it to dump the body at trace (protocol vetting). */
  #teeJson(label: string, up: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    up.on("data", (c: Buffer) => {
      chunks.push(c);
      res.write(c);
    });
    up.on("end", () => {
      this.#trace.trace("rc ← body", { path: label, body: Buffer.concat(chunks).toString("utf8") });
      res.end();
    });
    up.on("error", () => res.end());
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

/** A stable label for an RC worker endpoint (session id masked), or null if it isn't one. */
export function rcLabel(path: string): string | null {
  if (!path.startsWith("/v1/code/")) return null;
  return path.replace(/(\/v1\/code\/sessions\/)[^/?]+/, "$1{id}");
}

function tryJson(s: string | Buffer): Record<string, unknown> | null {
  const str = typeof s === "string" ? s : s.toString("utf8");
  if (str.trim() === "") return null;
  try {
    const v = JSON.parse(str);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse one SSE block (`event:`/`id:`/`data:` lines, possibly multi-line data) into its fields. */
export function parseSseBlock(raw: string): { event: string; id: string; data: string } {
  let event = "";
  let id = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { event, id, data };
}

/** The RC event type carried by a frame: an SSE/worker event is `{payload:{type}}` or `{type}`. */
export function evType(json: unknown): string {
  if (!json || typeof json !== "object") return "?";
  const o = json as Record<string, unknown>;
  const payload = o.payload;
  if (payload && typeof payload === "object") {
    const pt = (payload as Record<string, unknown>).type;
    if (typeof pt === "string") return pt;
  }
  return typeof o.type === "string" ? o.type : "?";
}
