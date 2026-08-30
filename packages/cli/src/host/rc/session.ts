// RC relay state: sessions and the event bus between the worker (the real `claude --remote-control`
// process, reached through our MITM) and the clients (our broker subscribers). It was ported from the
// retired Phase 0 core. Node is single-threaded async, so the blocking
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

function stringField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** Extract a Claude permission mode from the shapes seen in session config and system init events.
 *  The protocol has used both camelCase and snake_case; accept any non-empty string so new modes do
 *  not require a relay deploy just to display accurately. */
export function permissionModeFrom(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  return (
    stringField(o, "permissionMode") ??
    stringField(o, "permission_mode") ??
    permissionModeFrom(o.config)
  );
}

/** What kind of correlated party produced an event: a client (downstream) or the worker (upstream). */
export type EventSource = "client" | "worker";

/** The worker-event surface retained from the supported Claude native-output proof. Keep this
 * intentionally closed: accepting a new native type is a compatibility decision, not a fallback. */
const CLAUDE_NATIVE_EVENT_TYPES = new Set([
  "assistant",
  "control_cancel_request",
  "control_request",
  "control_response",
  "rate_limit_event",
  "result",
  "system",
  "user",
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NativeUpstreamAdmissionStatus = 400 | 409 | 410;

/** A deliberately content-free admission failure: callers may map the status to HTTP without
 * reflecting a native UUID, payload, or other conversation material into logs/responses. */
export class NativeUpstreamAdmissionError extends Error {
  constructor(readonly status: NativeUpstreamAdmissionStatus) {
    super(
      status === 410
        ? "session closed"
        : status === 409
          ? "native event coordinate collision"
          : "invalid native event batch",
    );
    this.name = "NativeUpstreamAdmissionError";
  }
}

export interface NativeUpstreamAdmission {
  event: RcEvent;
  duplicate: boolean;
}

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
  /** Opaque session-scoped bearer returned by /bridge and required on every worker route. */
  readonly workerToken: string;
  readonly title: string;
  readonly config: Record<string, unknown>;
  readonly createdAt: string;
  workerEpoch = 1;
  workerStatus = "WORKER_STATUS_UNSPECIFIED";
  permissionMode: string | null;
  closed = false;
  /** First local fail-stop/teardown cause. Diagnostic only; never transported or derived from content. */
  closeReason: string | null = null;
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
  /** The one locally minted initialize event. It alone may be attempted again on worker reconnect. */
  #initializeEventId: string | null = null;
  #initializeWriteAttempted = false;
  /** Mutating downstream events for which an SSE write has already been attempted. This is
   * session-wide (not stream-local), so reconnect cannot replay an unacked prompt/control action. */
  readonly #downstreamWriteAttempted = new Set<string>();
  /** Native UUID coordinates admitted through the Claude MITM path. Generic driver ingestion stays
   * permissive and deliberately does not participate in this native-only identity index. */
  readonly #nativeUpstreamByUuid = new Map<string, { bytes: Buffer; event: RcEvent }>();
  /** Synchronous lifecycle listeners. A relay uses this edge to latch terminal presence before any
   * asynchronous cleanup can race another announce onto the broker. */
  readonly #closeListeners = new Set<() => void>();

  constructor(
    id: string,
    title: string,
    config: Record<string, unknown> | null,
    opts: SessionOptions = {},
  ) {
    this.id = id;
    this.workerToken = `rcw-${randomUUID().replace(/-/g, "")}`;
    this.title = title;
    this.config = config ?? {};
    this.#clock = opts.clock ?? Date.now;
    this.createdAt = nowIso(this.#clock);
    this.permissionMode = permissionModeFrom(this.config);
  }

  // ---- producers ----
  #pushDownstream(eventType: string, payload: Record<string, unknown>): RcEvent {
    if (this.closed) throw new Error("session closed");
    this.#dsSeq += 1;
    // Claude may echo this payload upstream verbatim (notably the remote `user` turn). Mint the same
    // UUIDv4 coordinate our native intake requires, so our own producer can never trip its validator.
    const eid = randomUUID();
    if (payload.uuid === undefined) payload.uuid = eid;
    const ev = new RcEvent(eid, this.#dsSeq, eventType, "client", payload, nowIso(this.#clock));
    this.#downstream.push(ev);
    this.#gate.wake();
    return ev;
  }

  /** Push a `user` prompt downstream to the worker (the client→claude direction). A provider-native
   * companion keeps the authenticated browser coordinate alongside the immutable UUID/timestamp so the
   * later canonical provider event can reconcile the viewer's optimistic echo without pre-ordering it. */
  pushUserInput(content: string, options: { clientMsgId?: string } = {}): RcEvent {
    const payload: Record<string, unknown> = {
      type: "user",
      message: { role: "user", content },
      session_id: this.id,
      timestamp: nowIso(this.#clock),
      parent_tool_use_id: null,
    };
    if (options.clientMsgId !== undefined) payload.client_msg_id = options.clientMsgId;
    return this.#pushDownstream("user", payload);
  }

  /** Append the `initialize` control_request — guaranteed first downstream event. Idempotent. */
  pushInitialize(): RcEvent | null {
    if (this.closed || this.initialized) return null;
    this.initialized = true;
    this.#dsSeq += 1;
    const eid = randomUUID();
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
    this.#initializeEventId = ev.eventId;
    this.#gate.wake();
    return ev;
  }

  /**
   * Answer a worker `can_use_tool` (the permission grant path, §17.4). A plain allow/deny sends
   * `response:{behavior}`. An AskUserQuestion answer (#42) additionally carries `toolUseID` and an
   * `updatedInput` that REPLACES the tool input — and real claude's AskUserQuestion tool runs
   * `call({questions, answers})`, so updatedInput MUST carry BOTH the original `questions` array and the
   * `answers` ({"<questionText>":"<choice>"}). Omitting `questions` makes claude evaluate `q.map` on
   * undefined → "undefined is not an object (evaluating 'q.map')". Verified stable in claude 2.1.76
   * (Mar) … 2.1.177 (Jun): `async call({questions:A, answers:q={}, …}){return{data:{questions:A,answers:q,…}}}`.
   */
  pushControlResponse(
    requestId: string,
    behavior: "allow" | "deny" = "allow",
    extra?: {
      toolUseId?: string;
      answers?: Record<string, string | string[]>;
      questions?: unknown;
    },
  ): RcEvent {
    const response: Record<string, unknown> = { behavior };
    if (extra?.toolUseId) response.toolUseID = extra.toolUseId;
    if (extra?.answers) {
      // Echo the original questions alongside the answers — claude's tool call() destructures both.
      response.updatedInput =
        extra.questions !== undefined
          ? { questions: extra.questions, answers: extra.answers }
          : { answers: extra.answers };
    }
    return this.#pushDownstream("control_response", {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  /**
   * Push a server→worker `control_request` (§3.7): the verbs a client drives the session with —
   * `interrupt` (ESC the current turn), `set_permission_mode`, `set_model`. (No `end_session`: claude's
   * REPL bridge has no such subtype and rejects it — docs/protocol.md §11.) Each gets a fresh
   * `request_id`. `extra` carries the verb's params (e.g. `{ model }`, `{ mode }`).
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
    if (this.closed) throw new Error("session closed");
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

  /** A contradiction at the pinned Claude-native boundary is terminal for this remote session. If
   *  the batch were merely rejected while later batches remained admissible, the broker projection
   *  could continue after a silently missing native event. */
  #rejectNativeAdmission(status: NativeUpstreamAdmissionStatus, reason: string): never {
    if (status !== 410) this.close(`native upstream admission rejected (${status}): ${reason}`);
    throw new NativeUpstreamAdmissionError(status);
  }

  /**
   * Atomically admit one Claude-native worker POST. The whole batch is preflighted before sequence
   * allocation or mutation. A UUIDv4 is a session-long coordinate: exact normalized-payload retries
   * return the original RcEvent, while changed bytes at that coordinate fail the entire batch.
   *
   * This is intentionally separate from `pushUpstream`: tmux/OpenCode synthesize their own event ids
   * and retain the generic permissive path.
   */
  ingestNativeUpstreamBatch(workerEpoch: unknown, events: unknown): NativeUpstreamAdmission[] {
    if (this.closed) this.#rejectNativeAdmission(410, "session already closed");
    if (
      typeof workerEpoch !== "number" ||
      !Number.isSafeInteger(workerEpoch) ||
      workerEpoch !== this.workerEpoch ||
      !Array.isArray(events)
    ) {
      this.#rejectNativeAdmission(400, "worker epoch or events envelope invalid");
    }

    type Pending = {
      bytes: Buffer;
      payload: Record<string, unknown>;
      firstIndex: number;
    };
    type Preflight =
      | { kind: "existing"; event: RcEvent }
      | { kind: "first"; pending: Pending }
      | { kind: "duplicate"; firstIndex: number };

    // Track only new coordinates in this request. Looking retained coordinates up in place avoids
    // copying a session-long map for every small worker POST (quadratic work over a long transcript).
    const pendingByUuid = new Map<string, Pending>();
    const preflight: Preflight[] = [];

    for (const wrapper of events) {
      if (!isRecord(wrapper) || !isRecord(wrapper.payload)) {
        this.#rejectNativeAdmission(400, "event wrapper or payload is not an object");
      }
      const payload = wrapper.payload;
      const uuid = payload.uuid;
      const type = payload.type;
      if (typeof uuid !== "string" || !UUID_V4.test(uuid)) {
        const knownType =
          typeof type === "string" && CLAUDE_NATIVE_EVENT_TYPES.has(type)
            ? type
            : "not-allowlisted";
        const uuidLength = typeof uuid === "string" ? uuid.length : -1;
        const uuidShape =
          typeof uuid === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)
            ? "generic-uuid"
            : typeof uuid;
        this.#rejectNativeAdmission(
          400,
          `event UUID is not UUIDv4 (type=${knownType}, uuidShape=${uuidShape}, uuidLength=${uuidLength})`,
        );
      }
      if (payload.session_id !== this.id)
        this.#rejectNativeAdmission(400, "event session_id does not match the route session");
      if (typeof type !== "string" || !CLAUDE_NATIVE_EVENT_TYPES.has(type))
        this.#rejectNativeAdmission(400, "event type is not in the pinned native allowlist");

      let bytes: Buffer;
      try {
        bytes = Buffer.from(JSON.stringify(payload), "utf8");
      } catch {
        this.#rejectNativeAdmission(400, "event payload is not JSON serializable");
      }
      const key = uuid.toLowerCase();
      const retained = this.#nativeUpstreamByUuid.get(key);
      if (retained !== undefined) {
        if (!retained.bytes.equals(bytes))
          this.#rejectNativeAdmission(409, "retained UUID replay changed payload bytes");
        preflight.push({ kind: "existing", event: retained.event });
        continue;
      }
      const prior = pendingByUuid.get(key);
      if (prior !== undefined) {
        if (!prior.bytes.equals(bytes))
          this.#rejectNativeAdmission(409, "same-batch UUID replay changed payload bytes");
        preflight.push({ kind: "duplicate", firstIndex: prior.firstIndex });
        continue;
      }

      const pending: Pending = {
        bytes,
        payload,
        firstIndex: preflight.length,
      };
      pendingByUuid.set(key, pending);
      preflight.push({ kind: "first", pending });
    }

    const committed = new Map<number, RcEvent>();
    for (const item of preflight) {
      if (item.kind !== "first") continue;
      this.#usSeq += 1;
      const payload = item.pending.payload;
      const event = new RcEvent(
        payload.uuid as string,
        this.#usSeq,
        payload.type as string,
        "worker",
        payload,
        nowIso(this.#clock),
      );
      this.#upstream.push(event);
      this.#nativeUpstreamByUuid.set((payload.uuid as string).toLowerCase(), {
        bytes: item.pending.bytes,
        event,
      });
      committed.set(item.pending.firstIndex, event);
    }
    if (committed.size > 0) this.#gate.wake();

    return preflight.map((item) => {
      if (item.kind === "existing") return { event: item.event, duplicate: true };
      if (item.kind === "duplicate") {
        const event = committed.get(item.firstIndex);
        if (event === undefined) throw new Error("native admission invariant violated");
        return { event, duplicate: true };
      }
      const event = committed.get(item.pending.firstIndex);
      if (event === undefined) throw new Error("native admission invariant violated");
      return { event, duplicate: false };
    });
  }

  ack(eventId: string): void {
    this.#acked.add(eventId);
  }

  /** Strict Claude-worker delivery acknowledgement. Unlike the generic driver `ack()` seam, native
   * delivery may acknowledge only events whose SSE write was actually attempted. Preflight the whole
   * batch so one bogus/future id cannot partially mutate replay suppression. */
  acknowledgeNativeDeliveryBatch(eventIds: readonly string[]): boolean {
    for (const eventId of eventIds) {
      const known = this.#downstream.some((event) => event.eventId === eventId);
      const attempted =
        eventId === this.#initializeEventId
          ? this.#initializeWriteAttempted
          : this.#downstreamWriteAttempted.has(eventId);
      if (!known || !attempted) return false;
    }
    for (const eventId of eventIds) this.#acked.add(eventId);
    return true;
  }

  /** Register a new worker SSE stream, superseding any prior one. Returns the generation token. */
  claimWorkerStream(): number {
    this.#workerGen += 1;
    this.#gate.wake();
    return this.#workerGen;
  }

  /** Claim the Claude-native SSE writer. Reconnect is safe only when every prior mutating write attempt
   * was acknowledged; otherwise delivery is ambiguous and a successor stream could apply N+1 after a
   * possibly-lost N. The generic driver seam keeps its separately managed claim/ack behavior. */
  claimNativeWorkerStream(): number | null {
    if (this.closed || this.#hasUnackedNativeMutationAttempt()) {
      this.close("native worker stream claimed after an unacknowledged mutation attempt");
      return null;
    }
    return this.claimWorkerStream();
  }

  /** Retire the current native stream. A socket loss after any unacknowledged mutating write attempt is
   * terminal for this cse; an older superseded stream cannot close the newer owner. */
  endNativeWorkerStream(gen: number): void {
    if (gen === this.#workerGen && this.#hasUnackedNativeMutationAttempt()) {
      this.close("native worker stream ended after an unacknowledged mutation attempt");
    }
  }

  #hasUnackedNativeMutationAttempt(): boolean {
    for (const eventId of this.#downstreamWriteAttempted) {
      if (!this.#acked.has(eventId)) return true;
    }
    return false;
  }

  /**
   * Synchronous last-moment fence immediately before `ServerResponse.write`. The caller serializes
   * first, then calls this method, then attempts the write without an await in between. A stale
   * generation, close, acknowledgement, unknown event, or prior mutating write attempt is rejected.
   */
  claimDownstreamWriteAttempt(gen: number, eventId: string): boolean {
    if (this.closed || gen !== this.#workerGen || this.#acked.has(eventId)) return false;
    if (!this.#downstream.some((event) => event.eventId === eventId)) return false;
    if (eventId === this.#initializeEventId) {
      this.#initializeWriteAttempted = true;
      return true;
    }
    if (this.#downstreamWriteAttempted.has(eventId)) return false;
    this.#downstreamWriteAttempted.add(eventId);
    return true;
  }

  close(reason = "unspecified local teardown"): void {
    if (this.closed) return;
    this.closeReason = reason;
    this.closed = true;
    this.#gate.wake();
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch {
        // One observer must never prevent the remaining observers from seeing terminality. Lifecycle
        // listeners perform their own asynchronous/error reporting outside this synchronous fence.
      }
    }
    this.#closeListeners.clear();
  }

  /** Observe the one-way open→closed transition. Registration after close invokes immediately so a
   * bridge constructed in a teardown race cannot miss the terminal edge. */
  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
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
    const pendingEvents = () =>
      this.#downstream.filter(
        (e) =>
          !sent.has(e.eventId) &&
          !this.#acked.has(e.eventId) &&
          (e.eventId === this.#initializeEventId || !this.#downstreamWriteAttempted.has(e.eventId)),
      );
    for (;;) {
      if (this.closed || stop() || gen !== this.#workerGen) return;
      let pending = pendingEvents();
      if (pending.length === 0) {
        await this.#gate.wait(HEARTBEAT_MS);
        if (this.closed || stop() || gen !== this.#workerGen) return;
        pending = pendingEvents();
      }
      for (const e of pending) {
        // `pending` is a snapshot. Re-check every safety predicate between buffered yields: a newer
        // stream may claim the session, the socket may close, or another stream may fence this event
        // while the generator is suspended at the previous yield.
        if (this.closed || stop() || gen !== this.#workerGen) return;
        if (
          this.#acked.has(e.eventId) ||
          (e.eventId !== this.#initializeEventId && this.#downstreamWriteAttempted.has(e.eventId))
        ) {
          continue;
        }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
