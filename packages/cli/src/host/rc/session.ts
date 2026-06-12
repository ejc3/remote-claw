// RC relay state: sessions and the event bus between the worker (the real `claude --remote-control`
// process, reached through our MITM) and the clients (our broker subscribers). A faithful port of
// phase0/remote_claw/core.py — the difference is Node is single-threaded async, so the blocking
// `threading.Condition` follower loops become async generators that await a wake signal instead of a
// condition variable. Semantics are identical:
//
//   • downstream — events the relay pushes to the worker over SSE: `user` input from our clients, the
//     `initialize` control_request (always first), and permission `control_response`s.
//   • upstream — events the worker POSTs back (assistant / result / system…), fanned out to clients.
//
// A new worker SSE stream supersedes any prior one (the `gen` token) so exactly ONE follower delivers
// downstream events — preventing duplicate turns on a reconnect race. (§17.2/§17.3.)

import { randomUUID } from "node:crypto";

/** A wake primitive: a promise that resolves on the next `wake()`, then re-arms. The async stand-in
 *  for threading.Condition.notify_all() — every follower awaiting `wait()` is released together. */
class Gate {
  #resolve: (() => void) | null = null;
  #promise: Promise<void> = new Promise((r) => {
    this.#resolve = r;
  });

  /** Release everyone currently awaiting `wait()`, then arm a fresh promise for the next cycle. */
  wake(): void {
    const r = this.#resolve;
    this.#promise = new Promise((res) => {
      this.#resolve = res;
    });
    r?.();
  }

  /** Await the next `wake()`, or resolve after `ms` (the heartbeat tick), whichever comes first. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
      this.#promise.then(finish, finish);
    });
  }
}

const HEARTBEAT_MS = 10_000;

let counter = 0;
/** A unique-enough id without Math.random/Date (kept deterministic-friendly for tests). Used for
 *  event/request ids, which are scoped UNDER a session's globally-unique id, so repeating across
 *  launches is harmless. NOT used for the session id itself (see `randomSessionId`). */
function newId(prefix = ""): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}-${(counter * 2654435761) % 0xffffffff}`;
}

/** A GLOBALLY-unique session-id body. Unlike `newId` (a process-local counter that resets to 0 each
 *  launch — so the first session of EVERY launch would mint the same `cse_…`), this never repeats
 *  across launches. That matters because the broker channel token is `sess:<identityId>:<sessionId>`:
 *  two launches under one identity minting the same id would land on ONE channel, and on a durable
 *  backend the second session would read/extend the first's frames (a corrupt, merged transcript). */
function randomSessionId(): string {
  return randomUUID().replace(/-/g, "");
}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

/** What kind of correlated party produced an event: a client (downstream) or the worker (upstream). */
export type EventSource = "client" | "worker";

/** One event on a session's log — the shape sent to the worker over SSE (`wire()`). */
export class RcEvent {
  constructor(
    readonly eventId: string,
    readonly sequenceNum: number,
    readonly eventType: string,
    readonly source: EventSource,
    readonly payload: Record<string, unknown>,
    readonly createdAt: string,
  ) {}

  /** The SSE wire shape the worker expects (sequence_num is a string in the real protocol). */
  wire(): Record<string, unknown> {
    return {
      event_id: this.eventId,
      sequence_num: String(this.sequenceNum),
      event_type: this.eventType,
      source: this.source,
      payload: this.payload,
      created_at: this.createdAt,
    };
  }
}

/** Concatenate the text blocks of an assistant message payload (§17.3). */
export function assistantText(payload: Record<string, unknown>): string {
  const message = payload.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((b): b is { type: string; text: string } => {
      const bb = b as { type?: unknown; text?: unknown };
      return bb.type === "text" && typeof bb.text === "string";
    })
    .map((b) => b.text)
    .join("");
}

export interface SessionOptions {
  /** Injectable clock (ms since epoch) so tests stay deterministic; defaults to Date.now. */
  clock?: () => number;
  /** Injectable session-id minter so tests stay deterministic; defaults to a crypto-random unique id
   *  (`randomSessionId`) so ids never repeat across launches (a repeat is a broker-channel collision). */
  newSessionId?: () => string;
}

/** Authoritative state + event bus for ONE Remote Control session. */
export class Session {
  readonly id: string;
  readonly title: string;
  readonly config: Record<string, unknown>;
  readonly createdAt: string;
  workerEpoch = 1;
  workerStatus = "WORKER_STATUS_UNSPECIFIED";
  closed = false;
  initialized = false;

  readonly #clock: () => number;
  readonly #gate = new Gate();
  readonly #downstream: RcEvent[] = [];
  readonly #upstream: RcEvent[] = [];
  #dsSeq = 0;
  #usSeq = 0;
  /** event_ids the worker has acked, so a reconnecting worker stream doesn't re-deliver them. */
  readonly #acked = new Set<string>();
  /** id of the active worker SSE stream; a newer stream supersedes older followers. */
  #workerGen = 0;

  constructor(
    id: string,
    title: string,
    config: Record<string, unknown> | null,
    opts: SessionOptions = {},
  ) {
    this.id = id;
    this.title = title;
    this.config = config ?? {};
    this.#clock = opts.clock ?? Date.now;
    this.createdAt = nowIso(this.#clock);
  }

  // ---- producers ----
  #pushDownstream(eventType: string, payload: Record<string, unknown>): RcEvent {
    this.#dsSeq += 1;
    const eid = newId("e");
    if (payload.uuid === undefined) payload.uuid = eid;
    const ev = new RcEvent(eid, this.#dsSeq, eventType, "client", payload, nowIso(this.#clock));
    this.#downstream.push(ev);
    this.#gate.wake();
    return ev;
  }

  /** Push a `user` prompt downstream to the worker (the client→claude direction). */
  pushUserInput(content: string): RcEvent {
    return this.#pushDownstream("user", {
      type: "user",
      message: { role: "user", content },
      session_id: this.id,
      timestamp: nowIso(this.#clock),
      parent_tool_use_id: null,
    });
  }

  /** Append the `initialize` control_request — guaranteed first downstream event. Idempotent. */
  pushInitialize(): RcEvent | null {
    if (this.initialized) return null;
    this.initialized = true;
    this.#dsSeq += 1;
    const eid = newId("e");
    const ev = new RcEvent(
      eid,
      this.#dsSeq,
      "control_request",
      "client",
      {
        type: "control_request",
        request: { subtype: "initialize" },
        request_id: newId("req"),
        uuid: eid,
      },
      nowIso(this.#clock),
    );
    this.#downstream.push(ev);
    this.#gate.wake();
    return ev;
  }

  /**
   * Answer a worker `can_use_tool` (the permission grant path, §17.4). A plain allow/deny sends
   * `response:{behavior}`. An AskUserQuestion answer (#42) additionally carries `toolUseID` and
   * `updatedInput:{answers}` — the exact shape real claude expects (captured via --rc-trace):
   * `response:{behavior:"allow", toolUseID, updatedInput:{answers:{"<question>":"<choice>"}}}`.
   */
  pushControlResponse(
    requestId: string,
    behavior: "allow" | "deny" = "allow",
    extra?: { toolUseId?: string; answers?: Record<string, string | string[]> },
  ): RcEvent {
    const response: Record<string, unknown> = { behavior };
    if (extra?.toolUseId) response.toolUseID = extra.toolUseId;
    if (extra?.answers) response.updatedInput = { answers: extra.answers };
    return this.#pushDownstream("control_response", {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  /**
   * Push a server→worker `control_request` (§3.7): the verbs a client drives the session with —
   * `interrupt` (ESC the current turn), `set_permission_mode`, `set_model`, `end_session`. Each gets
   * a fresh `request_id`. `extra` carries the verb's params (e.g. `{ model }`, `{ mode }`).
   */
  pushControlRequest(subtype: string, extra: Record<string, unknown> = {}): RcEvent {
    return this.#pushDownstream("control_request", {
      type: "control_request",
      request: { subtype, ...extra },
      request_id: newId("req"),
    });
  }

  /** Record an event the worker POSTed back (assistant/result/…), fanned out to clients. */
  pushUpstream(payload: Record<string, unknown>): RcEvent {
    this.#usSeq += 1;
    const ev = new RcEvent(
      (payload.uuid as string) || newId("e"),
      this.#usSeq,
      (payload.type as string) || "unknown",
      "worker",
      payload,
      nowIso(this.#clock),
    );
    this.#upstream.push(ev);
    this.#gate.wake();
    return ev;
  }

  ack(eventId: string): void {
    this.#acked.add(eventId);
  }

  /** Register a new worker SSE stream, superseding any prior one. Returns the generation token. */
  claimWorkerStream(): number {
    this.#workerGen += 1;
    this.#gate.wake();
    return this.#workerGen;
  }

  close(): void {
    this.closed = true;
    this.#gate.wake();
  }

  /** Wake any parked follower so it re-checks its stop predicate now (e.g. an SSE response closed). */
  wake(): void {
    this.#gate.wake();
  }

  // ---- consumers (async generators that block until new events) ----
  /** Yield downstream events for the worker stream `gen`; `null` is a heartbeat tick. Exits when
   *  superseded by a newer stream, on close, or when `stop()` returns true. */
  async *followDownstream(gen: number, stop: () => boolean): AsyncGenerator<RcEvent | null> {
    const sent = new Set<string>();
    for (;;) {
      if (this.closed || stop() || gen !== this.#workerGen) return;
      let pending = this.#downstream.filter(
        (e) => !sent.has(e.eventId) && !this.#acked.has(e.eventId),
      );
      if (pending.length === 0) {
        await this.#gate.wait(HEARTBEAT_MS);
        if (this.closed || stop() || gen !== this.#workerGen) return;
        pending = this.#downstream.filter(
          (e) => !sent.has(e.eventId) && !this.#acked.has(e.eventId),
        );
      }
      for (const e of pending) {
        sent.add(e.eventId);
        yield e;
      }
      if (pending.length === 0) yield null; // heartbeat tick
    }
  }

  /** Yield upstream events for a client (live; multi-client safe). `null` is a heartbeat tick. */
  async *followUpstream(stop: () => boolean): AsyncGenerator<RcEvent | null> {
    let idx = 0;
    for (;;) {
      if (this.closed || stop()) return;
      if (idx >= this.#upstream.length) {
        await this.#gate.wait(HEARTBEAT_MS);
        if (this.closed || stop()) return;
      }
      const pending = this.#upstream.slice(idx);
      idx = this.#upstream.length;
      if (pending.length > 0) yield* pending;
      else yield null;
    }
  }

  snapshotUpstream(): RcEvent[] {
    return [...this.#upstream];
  }

  /** The session detail object the worker/list endpoints return (§17.2). */
  sessionObj(): Record<string, unknown> {
    return {
      id: this.id,
      title: this.title,
      status: "active",
      environment_kind: "bridge",
      environment_id: "",
      worker_status: this.workerStatus,
      connection_status: "connected",
      created_at: this.createdAt,
      updated_at: nowIso(this.#clock),
      last_event_at: nowIso(this.#clock),
      participants: [],
      client_presence: [],
      tags: ["remote-control-repl"],
      security_tier: "standard",
      unread: false,
      config: this.config,
    };
  }
}

/** Registry of live RC sessions (one per `claude --remote-control` the wrapper owns). */
export class RelayCore {
  readonly #sessions = new Map<string, Session>();
  readonly #clock: () => number;
  readonly #newSessionId: () => string;

  constructor(opts: SessionOptions = {}) {
    this.#clock = opts.clock ?? Date.now;
    this.#newSessionId = opts.newSessionId ?? randomSessionId;
  }

  /** Register a session for a worker `POST /v1/code/sessions`. */
  create(body: Record<string, unknown>): Session {
    const sid = `cse_${this.#newSessionId()}`.replace(/[^A-Za-z0-9_]/g, "");
    const s = new Session(
      sid,
      typeof body.title === "string" ? body.title : "remote-claw",
      (body.config as Record<string, unknown>) ?? null,
      { clock: this.#clock },
    );
    this.#sessions.set(s.id, s);
    return s;
  }

  get(sid: string): Session | undefined {
    return this.#sessions.get(sid);
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  closeAll(): void {
    for (const s of this.list()) s.close();
  }
}
