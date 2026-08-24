// The MITM proxy — a faithful port of phase0/remote_claw/mitm.py to Node's http/tls/net.
//
// `claude` is pointed here via HTTPS_PROXY. For `api.anthropic.com` we TLS-terminate with our leaf
// (claude trusts our CA via NODE_EXTRA_CA_CERTS) and either:
//   • INTERCEPT the Remote Control endpoints (`/v1/code/sessions*`, `/v1/code/triggers`) — we are the
//     RC backend, serving them from the in-memory RelayCore; or
//   • PASS THROUGH everything else (inference `/v1/messages`, OAuth, telemetry) to the real upstream.
// Any other host is blind-tunnelled untouched. This is the §14/§17.5 mechanism, verified in Phase 0.

import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type ClientRequest, type IncomingMessage, Server, type ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { TLSSocket } from "node:tls";
import { NOOP_TRACER, redactJsonTraceBody, type Tracer } from "../../trace.js";
import { type BedrockConfig, BedrockInference } from "./bedrock/inference.js";
import { isInferencePath, synthControlPlane } from "./bedrock/synth.js";
import { MITM_HOST } from "./certs.js";
import {
  assistantText,
  NativeUpstreamAdmissionError,
  type RelayCore,
  type Session,
} from "./session.js";

/** Endpoint prefixes we serve ourselves; everything else on the MITM host is passed through. */
const INTERCEPT_PREFIXES = ["/v1/code/sessions", "/v1/code/triggers"];

/** SSE event boundary — a blank line, LF or CRLF framed. */
const SSE_SEP = /\r?\n\r?\n/;
/** Caps so a pathological stream can't grow the trace buffers without bound (it's a diagnostic). */
const SSE_BUF_CAP = 256 * 1024;
const JSON_TRACE_CAP = 256 * 1024;
/** Relay control/native bodies are local and JSON. Bound them independently from passthrough inference
 * so an unauthorized or malformed local request cannot exhaust the wrapper before fail-stop handling. */
export const RC_INTERCEPT_BODY_CAP = 16 * 1024 * 1024;
const PASSTHROUGH_BODY_CAP = 64 * 1024 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 30_000;
const BODY_TOO_LARGE = Symbol("body too large");
const BODY_TIMED_OUT = Symbol("body timed out");
type BodyReadResult = Buffer | null | typeof BODY_TOO_LARGE | typeof BODY_TIMED_OUT;

function omittedTraceBody(bytes: number): string {
  return `<RC_BODY_OMITTED bytes=${bytes} limit=${JSON_TRACE_CAP}>`;
}

const SESS_RE = /^\/v1\/code\/sessions\/([^/?]+)(\/[^?]*)?/;

/** Injectable only so transparent forwarding can be proved against a loopback fake upstream. */
export type UpstreamRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

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
   *  it dumps structurally credential-redacted RC bodies. Auth headers are never passed to it. */
  tracer?: Tracer;
  /** Request transport for the real upstream. Defaults to node:https.request; injectable for tests. */
  upstreamRequest?: UpstreamRequest;
  /** Where inference (`/v1/messages*`) goes: "anthropic" (default — pass through to the real upstream)
   *  or "bedrock" (translate to Amazon Bedrock and synthesize the rest of the Anthropic control plane,
   *  so NOTHING reaches api.anthropic.com). Only meaningful in "relay" mode. */
  inference?: "anthropic" | "bedrock";
  /** Bedrock config (region/model/auth), used only when `inference==="bedrock"`. */
  bedrock?: BedrockConfig;
}

export class MitmProxy {
  readonly #opts: MitmOptions;
  readonly #server: Server;
  /** The inner HTTP server that parses requests off each TLS-terminated client socket. */
  readonly #inner: Server;
  readonly #leaf: { cert: Buffer; key: Buffer };
  readonly #trace: Tracer;
  /** Non-null when inference is routed to Bedrock instead of the real Anthropic upstream. */
  readonly #bedrock: BedrockInference | null;
  /** Active passthrough requests, including long-lived worker SSE. Owned and destroyed on close. */
  readonly #upstreamRequests = new Set<ClientRequest>();
  /** CONNECT sockets are upgraded out of HTTP server ownership, so close() must destroy them itself. */
  readonly #connectSockets = new Set<Socket>();
  #stopped = false;
  #closePromise: Promise<void> | null = null;

  constructor(opts: MitmOptions) {
    this.#opts = opts;
    this.#trace = opts.tracer ?? NOOP_TRACER;
    this.#bedrock =
      opts.inference === "bedrock"
        ? new BedrockInference({ ...opts.bedrock, tracer: opts.tracer ?? NOOP_TRACER })
        : null;
    this.#leaf = { cert: readFileSync(opts.leafCert), key: readFileSync(opts.leafKey) };
    this.#inner = new Server((req, res) => {
      void this.#onRequest(req, res).catch(() => {
        // No request-shape bug may escape as an unhandled rejection and take down sibling sessions or
        // the local Claude process. An unexpected failure under one known cse is terminal only there.
        const path = (req.url ?? "").split("?", 1)[0] ?? "";
        const matched = SESS_RE.exec(path);
        if (matched) this.#opts.core?.get(matched[1] as string)?.close();
        if (res.destroyed) return;
        if (res.headersSent) res.destroy();
        else sendJson(res, { error: "session request failed" }, 500);
      });
    });
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
    if (this.#closePromise !== null) return this.#closePromise;
    this.#stopped = true;
    // Stop accepting first. closeAllConnections() is deliberately called only after close() inside
    // closeServer: doing the sweep first leaves a race where a newly accepted connection is missed.
    // CONNECT-upgraded sockets are outside Server ownership and are swept explicitly below.
    this.#closePromise = Promise.all([closeServer(this.#server), closeServer(this.#inner)]).then(
      () => undefined,
    );
    // Wake every worker-SSE follower NOW (close() sets #stopped, but a follower parked on the
    // session Gate's heartbeat wait wouldn't re-check it for up to HEARTBEAT_MS). Closing the
    // sessions wakes their gates so #streamWorker loops exit and end their responses immediately.
    this.#opts.core?.closeAll();
    for (const request of this.#upstreamRequests) request.destroy();
    this.#upstreamRequests.clear();
    for (const socket of this.#connectSockets) socket.destroy();
    this.#connectSockets.clear();
    return this.#closePromise;
  }

  // ---- CONNECT handling ----
  #onConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    // A CONNECT event can already be queued when close() stops the listening server. Reject it
    // before it is upgraded (and therefore before it leaves Server connection ownership).
    if (this.#stopped) {
      clientSocket.destroy();
      return;
    }
    this.#trackConnectSocket(clientSocket);
    const { host, port } = splitAuthority(req.url ?? "");
    // Normalize before matching: a CONNECT authority may be upper/mixed-case or carry one-or-more FQDN
    // trailing dots ("api.anthropic.com." / "api.anthropic.com.."). Without stripping ALL of them, such
    // a request would miss MITM_HOST and get blind-tunnelled to the real host — a zero-Anthropic LEAK in
    // bedrock mode.
    if (host.toLowerCase().replace(/\.+$/, "") === MITM_HOST) {
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
      // DNS/connect completion can race with close() after both sockets have been swept.
      if (this.#stopped || clientSocket.destroyed) {
        upstream.destroy();
        clientSocket.destroy();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    this.#trackConnectSocket(upstream);
    const kill = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", kill);
    clientSocket.on("error", kill);
  }

  #trackConnectSocket(socket: Socket): void {
    this.#connectSockets.add(socket);
    socket.once("close", () => this.#connectSockets.delete(socket));
  }

  // ---- request handling (intercept or passthrough) ----
  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?", 1)[0] ?? ""; // the path WITHOUT query — only for intercept matching
    const relayIntercept =
      (this.#opts.mode ?? "relay") === "relay" &&
      INTERCEPT_PREFIXES.some((prefix) => path.startsWith(prefix));
    // Reject unknown/closed/unauthorized worker routes from headers alone. Waiting for EOF first lets a
    // missing bearer hold an unbounded chunked request open and consume memory before its inevitable 401.
    if (relayIntercept) {
      const match = SESS_RE.exec(path);
      if (match !== null) {
        const session = this.#opts.core?.get(match[1] as string);
        if (session === undefined) {
          rejectBeforeBody(req, res, { error: "no such session" }, 404);
          return;
        }
        if (session.closed) {
          rejectBeforeBody(req, res, { error: "session closed" }, 410);
          return;
        }
        if (
          isWorkerRoute(match[2]) &&
          !matchesWorkerBearer(req.headers.authorization, session.workerToken)
        ) {
          rejectBeforeBody(req, res, { error: "unauthorized worker" }, 401);
          return;
        }
      }
    }
    const body = await readBody(
      req,
      relayIntercept ? RC_INTERCEPT_BODY_CAP : PASSTHROUGH_BODY_CAP,
      REQUEST_BODY_TIMEOUT_MS,
    );
    if (body === BODY_TOO_LARGE || body === BODY_TIMED_OUT) {
      const match = SESS_RE.exec(path);
      if (relayIntercept && match !== null && isWorkerRoute(match[2])) {
        this.#opts.core?.get(match[1] as string)?.close();
      }
      rejectBeforeBody(
        req,
        res,
        { error: body === BODY_TOO_LARGE ? "request body too large" : "request body timed out" },
        body === BODY_TOO_LARGE ? 413 : 408,
      );
      return;
    }
    // Never turn an aborted partial upload into a different, apparently complete upstream request.
    // close() can also run while readBody is parked; do not create a new outbound request after its
    // ownership sets have already been swept.
    if (body === null || !req.complete || this.#stopped || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    const rc = rcLabel(path); // an RC worker endpoint (session id masked), or null
    if (relayIntercept) {
      this.#trace.debug("intercept", { method: req.method ?? "GET", path });
      this.#intercept(req.method ?? "GET", path, body, res, req.headers.authorization);
    } else if (this.#bedrock !== null) {
      // Bedrock inference mode: serve /v1/messages* from Bedrock; synthesize every other
      // api.anthropic.com path locally. NOTHING reaches the real upstream (zero Anthropic).
      await this.#serveBedrock(this.#bedrock, req, path, body, res);
    } else {
      // Pass the FULL request-target (query string included) upstream — stripping `?…` would drop
      // params the real API needs (e.g. /api/claude_cli/bootstrap?entrypoint=…&model=…, ?limit=…). In
      // trace mode, an RC endpoint is traced both ways as it flows to/from the real upstream.
      if (isInferencePath(path)) {
        this.#trace.debug("inference passthrough", {
          dir: "→",
          method: req.method ?? "GET",
          path,
          body_bytes: body.length,
        });
      }
      if (rc !== null) this.#traceRcRequest(req.method ?? "GET", rc, body);
      this.#passthrough(req, rawUrl, body, res, rc);
    }
  }

  /** Serve a request in Bedrock inference mode: inference → Bedrock; everything else → a synthesized
   *  control-plane response. RC endpoints are handled by `#intercept` before this (caller-guarded). */
  async #serveBedrock(
    bedrock: BedrockInference,
    req: IncomingMessage,
    path: string,
    body: Buffer,
    res: ServerResponse,
  ): Promise<void> {
    if (isInferencePath(path)) {
      await bedrock.serve(path, normalizeHeaders(req.headers), body, res);
      return;
    }
    // synthControlPlane returns null ONLY for inference paths, which `isInferencePath` already routed
    // above — so it's non-null here. Fall back to an empty 200 anyway rather than EVER leaving the
    // child's request hanging with no response (a silent stall if that invariant ever drifts).
    const synth = synthControlPlane(req.method ?? "GET", path) ?? { status: 200, json: {} };
    sendJson(res, synth.json, synth.status);
  }

  /** Trace one client→Anthropic RC request: the verb/path always; bounded worker event metadata at
   *  debug; a bounded body copy at trace. Auth headers are never touched (they aren't passed here). */
  #traceRcRequest(method: string, label: string, body: Buffer): void {
    if (!this.#trace.enabled("info")) return;
    const fields: Record<string, string | number> = { dir: "→", method, path: label };
    if (body.length > JSON_TRACE_CAP) {
      fields.body_bytes = body.length;
    } else if (this.#trace.enabled("debug")) {
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
      this.#trace.trace("rc → body", {
        body:
          body.length > JSON_TRACE_CAP
            ? omittedTraceBody(body.length)
            : redactJsonTraceBody(body.toString("utf8")),
      });
    }
  }

  // Returns the ServerResponse it handled (Express-style: `sendJson` returns `res`, the SSE branch
  // returns `res` directly), so the `return sendJson(...)` early-exits are legal (biome forbids a
  // value-return from a `void` function — noVoidTypeReturn — and dislikes `void` in a union).
  #intercept(
    method: string,
    path: string,
    body: Buffer,
    res: ServerResponse,
    authorization: string | undefined,
  ): ServerResponse {
    const core = this.#opts.core;
    if (!core) return sendJson(res, { error: "no relay core" }, 500); // relay mode always has one

    // Closed is terminal for every route under a known cse, even when the request body is malformed.
    // Resolve this before JSON parsing so a closed session cannot be revived/probed through a route-
    // specific error path.
    const matchedSession = SESS_RE.exec(path);
    const matched = matchedSession ? core.get(matchedSession[1] as string) : undefined;
    if (matched?.closed) return sendJson(res, { error: "session closed" }, 410);
    if (
      matched !== undefined &&
      isWorkerRoute(matchedSession?.[2]) &&
      !matchesWorkerBearer(authorization, matched.workerToken)
    ) {
      return sendJson(res, { error: "unauthorized worker" }, 401);
    }

    let data: Record<string, unknown> = {};
    if (body.length) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
      } catch {
        if (
          method === "POST" &&
          (matchedSession?.[2] === "/worker/events" ||
            matchedSession?.[2] === "/worker/events/delivery")
        ) {
          matched?.close();
        }
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
      try {
        this.#opts.onSession?.(s);
      } catch (error) {
        s.close("session registration callback failed");
        throw error;
      }
      return sendJson(res, { session: s.sessionObj() });
    }

    const m = SESS_RE.exec(path);
    if (!m) return sendJson(res, { error: "not found" }, 404);
    const sid = m[1] as string;
    const sub = m[2] ?? "";
    const s = core.get(sid);
    if (!s) return sendJson(res, { error: "no such session" }, 404);

    if (sub === "" && method === "GET") return sendJson(res, { session: s.sessionObj() });
    if (sub === "/bridge" && method === "POST") {
      return sendJson(res, {
        api_base_url: `https://${MITM_HOST}`,
        expires_in: 14400,
        worker_epoch: "1",
        worker_jwt: s.workerToken,
      });
    }
    if (sub === "/bridge") return sendJson(res, { error: "method not allowed" }, 405);
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
      const rejectWorkerUpdate = (reason: string): ServerResponse => {
        this.#trace.warn("invalid worker update — closing session", {
          session: s.id,
          reason,
          fields: Object.keys(data).sort().join(","),
          worker_status_type:
            data.worker_status === null
              ? "null"
              : Array.isArray(data.worker_status)
                ? "array"
                : typeof data.worker_status,
          worker_epoch_type:
            data.worker_epoch === null
              ? "null"
              : Array.isArray(data.worker_epoch)
                ? "array"
                : typeof data.worker_epoch,
          external_metadata_type:
            data.external_metadata === null
              ? "null"
              : Array.isArray(data.external_metadata)
                ? "array"
                : typeof data.external_metadata,
        });
        s.close(`invalid worker update: ${reason}`);
        return sendJson(res, { error: "invalid worker update" }, 400);
      };
      // Claude 2.1.237 sends an authenticated metadata-only registration PUT before its first status
      // transition. It is not a status contradiction: accept the exact required coordinates and leave
      // the prior status unchanged. A missing/mismatched epoch or malformed metadata still fails closed.
      if (data.worker_status === undefined) {
        if (data.worker_epoch !== s.workerEpoch)
          return rejectWorkerUpdate("metadata-only update has the wrong worker epoch");
        if (!isRecord(data.external_metadata))
          return rejectWorkerUpdate("metadata-only update lacks object external_metadata");
        return sendJson(res, {});
      }
      if (typeof data.worker_status !== "string")
        return rejectWorkerUpdate("worker_status is not a string");
      if (data.worker_epoch !== undefined && data.worker_epoch !== s.workerEpoch)
        return rejectWorkerUpdate("status update has the wrong worker epoch");
      if (data.worker_status !== s.workerStatus) {
        s.workerStatus = data.worker_status;
        s.wake(); // nudge the relay's idle null-tick so it re-announces presence promptly (#48/#58)
      }
      return sendJson(res, {});
    }
    if (sub === "/worker/heartbeat" && method === "POST") return sendJson(res, {});
    if (sub === "/worker/events/delivery" && method === "POST") {
      const updates = data.updates;
      if (
        !Array.isArray(updates) ||
        updates.some(
          (update) =>
            !isRecord(update) || typeof update.event_id !== "string" || update.event_id === "",
        )
      ) {
        s.close();
        return sendJson(res, { error: "invalid delivery batch" }, 400);
      }
      const eventIds = updates.map(
        (update) => (update as Record<string, unknown>).event_id as string,
      );
      if (!s.acknowledgeNativeDeliveryBatch(eventIds)) {
        s.close();
        return sendJson(res, { error: "invalid delivery batch" }, 400);
      }
      return sendJson(res, {});
    }
    if (sub === "/worker/events" && method === "POST") {
      let admissions: ReturnType<Session["ingestNativeUpstreamBatch"]>;
      try {
        admissions = s.ingestNativeUpstreamBatch(data.worker_epoch, data.events);
      } catch (error) {
        if (error instanceof NativeUpstreamAdmissionError) {
          return sendJson(res, { error: error.message }, error.status);
        }
        s.close();
        return sendJson(res, { error: "native event admission failed" }, 500);
      }
      const results = admissions.map(({ event, duplicate }) => ({
        event_id: event.eventId,
        sequence_num: String(event.sequenceNum),
        duplicate,
      }));
      for (const { event: up, duplicate } of admissions) {
        // Exact retries are already represented by their original event; do not emit a second trace
        // record that could be mistaken for a second transcript mutation.
        if (duplicate) continue;
        const payload = up.payload;
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
      void this.#streamWorker(s, res).catch(() => {
        s.close();
        if (!res.destroyed) {
          if (res.headersSent) res.destroy();
          else sendJson(res, { error: "worker stream failed" }, 500);
        }
      }); // long-lived SSE; runs until the worker disconnects
      return res;
    }
    if (isWorkerRoute(sub)) {
      s.close();
      return sendJson(res, { error: "invalid worker request" }, 400);
    }
    return sendJson(res, {});
  }

  async #streamWorker(s: Session, res: ServerResponse): Promise<void> {
    const gen = s.claimNativeWorkerStream();
    if (gen === null) {
      sendJson(res, { error: "session closed" }, 410);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "close",
    });
    s.pushInitialize();
    this.#trace.debug("worker SSE connected", { session: s.id, gen });
    // A remote disconnect can close/destroy the response WITHOUT setting writableEnded, so watch the
    // `close` event too — else a dead follower lingers, waking on every heartbeat and holding the
    // response forever. The flag is re-checked by the stop predicate below.
    let closed = false;
    const stopped = () => this.#stopped || closed || res.writableEnded || res.destroyed;
    res.on("close", () => {
      closed = true;
      s.endNativeWorkerStream(gen);
      s.wake(); // break the follower out of its heartbeat wait immediately
    });
    try {
      for await (const ev of s.followDownstream(gen, stopped)) {
        if (ev === null) {
          if (!stopped()) res.write(":keepalive\n\n");
          continue;
        }
        // Serialize before the synchronous session-wide fence. With no await between the fence and
        // write, another generation cannot interleave and claim the same mutating event. Claiming is
        // an at-most-one write ATTEMPT: even a socket failure after this point must not cause replay.
        const frame = `event: client_event\nid: ${ev.sequenceNum}\ndata: ${JSON.stringify(ev.wire())}\n\n`;
        if (stopped() || !s.claimDownstreamWriteAttempt(gen, ev.eventId)) continue;
        res.write(frame);
      }
    } catch {
      // A socket loss is handled by the close listener. Any other stream failure is terminal rather
      // than escaping as a process-level rejection or leaving a live cse behind a lost write.
      if (!stopped()) s.close();
    } finally {
      s.endNativeWorkerStream(gen);
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
    if (this.#stopped || res.destroyed) return;
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

    const requestUpstream: UpstreamRequest = this.#opts.upstreamRequest ?? httpsRequest;
    const upstream = requestUpstream(
      { host: MITM_HOST, port: 443, method: req.method, path, headers, servername: MITM_HOST },
      (up) => {
        // pipe() does not consume source errors. In particular, destroying ClientRequest after its
        // response has arrived makes the IncomingMessage emit ECONNRESET; always handle that path,
        // including the production-default (non-debug) forwarding branch.
        up.on("error", () => {
          if (!res.destroyed) res.destroy();
        });
        if (this.#stopped || res.destroyed) {
          up.destroy();
          return;
        }
        res.writeHead(up.statusCode ?? 502, up.headers);
        if (rc !== null)
          this.#trace.info("rc ←", { dir: "←", path: rc, status: up.statusCode ?? 0 });
        else {
          const requestPath = path.split("?", 1)[0] ?? "";
          if (isInferencePath(requestPath)) {
            this.#trace.debug("inference passthrough response", {
              dir: "←",
              path: requestPath,
              status: up.statusCode ?? 0,
            });
          }
        }
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
    this.#upstreamRequests.add(upstream);
    upstream.once("close", () => this.#upstreamRequests.delete(upstream));
    // If the proxied child disconnects first, tear down the corresponding upstream stream instead of
    // leaving a worker SSE/socket alive and pinning trace-mode shutdown.
    res.once("close", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    if (body.length) upstream.write(body);
    upstream.end();
  }

  /** Forward an SSE response and trace each `event:/id:/data:` block (Anthropic→worker direction).
   *  `up.pipe(res)` does the forwarding — it keeps proper backpressure and ends res — while a `data`
   *  listener (which still fires under pipe) decodes a copy for tracing via a StringDecoder, so a
   *  multi-byte char split across chunks isn't corrupted in the trace. Delivery is byte-exact. */
  #teeSse(label: string, up: IncomingMessage, res: ServerResponse): void {
    up.pipe(res);
    const decoder = new StringDecoder("utf8");
    let buf = "";
    up.on("data", (chunk: Buffer) => {
      buf += decoder.write(chunk);
      let m = SSE_SEP.exec(buf);
      while (m) {
        this.#traceSseEvent(label, buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        m = SSE_SEP.exec(buf);
      }
      if (buf.length > SSE_BUF_CAP) buf = buf.slice(-SSE_BUF_CAP); // never grow without bound
    });
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
    if (this.#trace.enabled("trace") && data !== "") {
      this.#trace.trace("rc ← sse data", { data: redactJsonTraceBody(data) });
    }
  }

  /** Forward a non-SSE response (pipe = backpressure + end) while keeping a CAPPED copy to dump the
   *  body at trace. The cap means even a huge response can't OOM the diagnostic. */
  #teeJson(label: string, up: IncomingMessage, res: ServerResponse): void {
    up.pipe(res);
    const chunks: Buffer[] = [];
    let kept = 0;
    let total = 0;
    up.on("data", (c: Buffer) => {
      total += c.length;
      const remaining = JSON_TRACE_CAP - kept;
      if (remaining > 0) {
        const copy = c.subarray(0, remaining);
        chunks.push(copy);
        kept += copy.length;
      }
    });
    up.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      this.#trace.trace("rc ← body", {
        path: label,
        body: total > JSON_TRACE_CAP ? omittedTraceBody(total) : redactJsonTraceBody(body),
      });
    });
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error & { code?: string }) => {
      if (err !== undefined && err.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      resolve();
    });
    // Node explicitly requires this order: close() first prevents new connections, then the force
    // sweep terminates HTTP connections that would otherwise keep the close callback pending.
    server.closeAllConnections?.();
  });
}

function readBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (body: BodyReadResult, drain = false) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (body !== null && !Buffer.isBuffer(body)) chunks.length = 0;
      if (drain) req.resume();
      resolve(body);
    };

    const declaredLength = req.headers["content-length"];
    if (
      typeof declaredLength === "string" &&
      /^\d+$/.test(declaredLength) &&
      Number(declaredLength) > maxBytes
    ) {
      settle(BODY_TOO_LARGE, true);
      return;
    }

    timer = setTimeout(() => settle(BODY_TIMED_OUT, true), timeoutMs);
    timer.unref();
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settle(BODY_TOO_LARGE, true);
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => settle(Buffer.concat(chunks, bytes)));
    req.once("aborted", () => settle(null));
    req.once("error", () => settle(null));
    req.once("close", () => {
      if (!req.complete) settle(null);
    });
  });
}

/** Flatten node's incoming headers (a value may be string[]) to a simple string map for the Bedrock
 *  handler — joining multi-value headers the way an HTTP forwarder would. */
function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerRoute(sub: string | undefined): boolean {
  return sub === "/worker" || sub?.startsWith("/worker/") === true;
}

function matchesWorkerBearer(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const actual = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Complete a header-only rejection immediately, then discard any body without retaining it. Closing
 *  the connection keeps a peer that never finishes a chunked upload from occupying a reusable socket. */
function rejectBeforeBody(
  req: IncomingMessage,
  res: ServerResponse,
  obj: unknown,
  status: number,
): void {
  res.shouldKeepAlive = false;
  res.setHeader("Connection", "close");
  sendJson(res, obj, status);
  req.resume();
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

/** Parse one SSE block (`event:`/`id:`/`data:` lines) into its fields. Tolerates LF or CRLF line
 *  endings; multiple `data:` lines are joined with "\n", per the SSE spec. */
export function parseSseBlock(raw: string): { event: string; id: string; data: string } {
  let event = "";
  let id = "";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return { event, id, data: data.join("\n") };
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
