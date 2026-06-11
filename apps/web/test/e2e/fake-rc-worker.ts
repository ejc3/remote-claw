// A fake `claude --remote-control` WORKER that speaks the REAL RC worker protocol over HTTP through
// the MITM proxy — exactly as the real binary does (HTTPS_PROXY → CONNECT tunnel → our leaf, trusted
// via our CA). It registers a session, mints a bridge, opens the worker SSE downstream, and for each
// `user` event the relay pushes, POSTs an assistant turn + result back upstream. The ONLY thing this
// fakes is the model; the transport it drives is the genuine `/v1/code/sessions*` worker API, so the
// MITM↔worker leg is exercised end to end (the real binary is covered by real-rc.prove.test.ts).

import type { IncomingMessage } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const MITM_HOST = "api.anthropic.com";

/** An https.Agent that tunnels through the proxy via CONNECT, trusting our MITM CA. */
function proxyAgent(proxyPort: number, ca: Buffer): Agent {
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

export class FakeRcWorker {
  readonly #agent: Agent;
  #sse: ReturnType<typeof httpsRequest> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #onControlResponse:
    | ((requestId: string, behavior: string, response?: Record<string, unknown>) => void)
    | null = null;
  #onControlRequest: ((subtype: string, request: Record<string, unknown>) => void) | null = null;

  constructor(proxyPort: number, ca: Buffer) {
    this.#agent = proxyAgent(proxyPort, ca);
  }

  /** Register a callback fired when the relay delivers a control_response downstream (a grant/deny).
   *  The 3rd arg is the FULL `response.response` object — for an AskUserQuestion answer that carries
   *  `{behavior, toolUseID, updatedInput:{answers}}` (#42). */
  onControlResponse(
    cb: (requestId: string, behavior: string, response?: Record<string, unknown>) => void,
  ): void {
    this.#onControlResponse = cb;
  }

  /** Register a callback fired on a downstream control_request (a client verb: interrupt/set_model/…). */
  onControlRequest(cb: (subtype: string, request: Record<string, unknown>) => void): void {
    this.#onControlRequest = cb;
  }

  #rpc(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const opts: RequestOptions = {
        host: MITM_HOST,
        port: 443,
        method,
        path,
        agent: this.#agent,
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

  /** The exact worker startup the real claude does (MANGO capture, §17.2): register → triggers →
   *  bridge → get worker → status idle. Returns the session id. */
  async register(title: string): Promise<string> {
    const reg = await this.#rpc("POST", "/v1/code/sessions", { title });
    const id = (reg.session as { id?: string })?.id;
    if (!id) throw new Error("worker: session register returned no id");
    await this.#rpc("GET", "/v1/code/triggers");
    await this.#rpc("POST", `/v1/code/sessions/${id}/bridge`);
    await this.#rpc("GET", `/v1/code/sessions/${id}/worker`);
    await this.#rpc("PUT", `/v1/code/sessions/${id}/worker`, {
      worker_epoch: 1,
      worker_status: "idle",
    });
    return id;
  }

  /** Open the worker SSE downstream and behave exactly like the real worker: ACK every event
   *  (events/delivery), and for a `user` event flip busy→respond→idle. Also heartbeats. `respond`
   *  builds the upstream event payloads for a prompt — default is a single assistant echo + result;
   *  a test can return a richer turn (tool_use, a sub-agent assistant with parent_tool_use_id, …). */
  start(
    sessionId: string,
    respond: (text: string) => Array<Record<string, unknown>> = (t) => [
      { type: "assistant", message: { content: [{ type: "text", text: `echo: ${t}` }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ],
  ): void {
    this.#heartbeat = setInterval(() => {
      void this.#rpc("POST", `/v1/code/sessions/${sessionId}/worker/heartbeat`, {
        session_id: sessionId,
        worker_epoch: 1,
      });
    }, 5000);
    if (typeof this.#heartbeat.unref === "function") this.#heartbeat.unref();

    const opts: RequestOptions = {
      host: MITM_HOST,
      port: 443,
      method: "GET",
      path: `/v1/code/sessions/${sessionId}/worker/events/stream`,
      agent: this.#agent,
      headers: { accept: "text/event-stream" },
    };
    this.#sse = httpsRequest(opts, (res: IncomingMessage) => {
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let nl = buf.indexOf("\n\n");
        while (nl !== -1) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) this.#onEvent(sessionId, dataLine.slice(6), respond);
          nl = buf.indexOf("\n\n");
        }
      });
    });
    this.#sse.on("error", () => {});
    this.#sse.end();
  }

  #onEvent(
    sessionId: string,
    raw: string,
    respond: (text: string) => Array<Record<string, unknown>>,
  ): void {
    let ev: {
      event_id?: string;
      event_type?: string;
      payload?: {
        message?: { content?: unknown };
        request?: { subtype?: string } & Record<string, unknown>;
        response?: { request_id?: string; response?: { behavior?: string } };
      };
    };
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    // ACK delivery of every downstream event, exactly as the real worker does (so reconnects don't
    // re-deliver). This exercises the MITM's events/delivery handler.
    if (ev.event_id) {
      void this.#rpc("POST", `/v1/code/sessions/${sessionId}/worker/events/delivery`, {
        worker_epoch: 1,
        updates: [{ event_id: ev.event_id, status: "received" }],
      });
    }
    // A control_response is the relay delivering a viewer's permission grant/deny back to the worker.
    if (ev.event_type === "control_response") {
      const r = ev.payload?.response;
      this.#onControlResponse?.(r?.request_id ?? "", r?.response?.behavior ?? "", r?.response);
      return;
    }
    // A control_request is a client verb (interrupt/set_model/…); `initialize` is the handshake.
    if (ev.event_type === "control_request") {
      const req = ev.payload?.request ?? {};
      if (req.subtype && req.subtype !== "initialize") this.#onControlRequest?.(req.subtype, req);
      return;
    }
    if (ev.event_type !== "user") return;
    const content = ev.payload?.message?.content;
    const text = typeof content === "string" ? content : "";
    // Flip busy, post the turn's upstream events (worker→relay), flip idle — the real turn lifecycle.
    // The body matches the captured shape: {worker_epoch, events:[{payload}]}.
    void (async () => {
      await this.#rpc("PUT", `/v1/code/sessions/${sessionId}/worker`, {
        worker_epoch: 1,
        worker_status: "busy",
      });
      await this.#rpc("POST", `/v1/code/sessions/${sessionId}/worker/events`, {
        worker_epoch: 1,
        events: respond(text).map((payload) => ({ payload })),
      });
      await this.#rpc("PUT", `/v1/code/sessions/${sessionId}/worker`, {
        worker_epoch: 1,
        worker_status: "idle",
      });
    })();
  }

  stop(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#sse?.destroy();
    this.#agent.destroy();
  }
}
