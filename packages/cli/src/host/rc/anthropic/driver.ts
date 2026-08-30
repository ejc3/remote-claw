/// <reference lib="es2024.promise" />

import { isDeepStrictEqual } from "node:util";
import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import { ensureCerts } from "../certs.js";
import {
  CLAUDE_NATIVE_CAPABILITIES,
  CLAUDE_NATIVE_HARNESS,
  type Driver,
  type DriverContext,
} from "../driver.js";
import { ReadyBridge } from "../drivers/ready-bridge.js";
import type { SpawnClaudeEnv } from "../launch.js";
import { type MitmOptions, MitmProxy } from "../mitm.js";
import { type RcEvent, RelayCore, type Session } from "../session.js";
import {
  AnthropicRcClient,
  type AnthropicRcEvent,
  type RcEventPage,
  type RcPostAck,
  type RcSseItem,
  type RcUserEventInput,
} from "./client.js";
import { AnthropicRcError } from "./errors.js";

const HISTORY_PAGE_LIMIT = 100;
const HISTORY_PAGE_CAP = 1_000;
const PROJECTION_COORDINATE_CAP = 100_000;
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 150;
const TEARDOWN_WAIT_MS = 2_000;

/** The small client surface the companion owns; injectable without weakening production origin/auth. */
export interface ClaudeNativeClient {
  history(
    sessionId: string,
    options?: { cursor?: string; limit?: number; sortOrder?: "asc" | "desc"; signal?: AbortSignal },
  ): Promise<RcEventPage>;
  streamEvents(
    sessionId: string,
    options: { signal: AbortSignal; onOpen?: () => void },
  ): AsyncGenerator<RcSseItem>;
  postEvent(
    sessionId: string,
    event: RcUserEventInput,
    options?: { signal?: AbortSignal },
  ): Promise<RcPostAck>;
}

export interface ClaudeNativeProxy {
  readonly port: number;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeNativeDriverOptions {
  /** Attach to this exact existing Anthropic RC session without a proxy or interactive Claude child. */
  nativeSessionId?: string;
  /** Wrapper cert directory beside the remote-claw secret. */
  certsDir: string;
  /** Real Claude executable (already compatibility-checked at the CLI boundary). */
  claudeBin: string;
  /** Launches ordinary Claude behind the transparent proxy. */
  spawnClaude: SpawnClaudeEnv;
  /** Deterministic seams for focused tests. */
  client?: ClaudeNativeClient;
  proxyFactory?: (options: MitmOptions) => ClaudeNativeProxy;
  reconnectDelayMs?: number;
  /** Test seam for the shared retained provider-event/browser-mutation ceiling. */
  projectionCoordinateCap?: number;
}

interface NativeConnection {
  iterator: AsyncIterator<RcSseItem>;
  first: Promise<IteratorResult<RcSseItem>>;
  close(): void;
}

interface BrowserMutation {
  readonly uuid: string;
  readonly timestamp: string;
  readonly text: string;
  readonly clientMsgId?: string;
  ackEventId: string | null;
  observedEventId: string | null;
}

interface UserObservation {
  readonly source: AnthropicRcEvent["source"];
  readonly eventId: string;
  readonly sequenceNum: string;
  readonly text: string | null;
  readonly attachment: boolean;
  readonly payload: AnthropicRcEvent["payload"];
}

class NativeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeProjectionError";
  }
}

/** Bounds all coordinates retained for the lifetime of one writable projection. */
class ProjectionBudget {
  #used = 0;

  constructor(readonly limit: number) {}

  claim(): void {
    if (this.#used >= this.limit) {
      throw new NativeProjectionError("native projection coordinate limit exceeded");
    }
    this.#used += 1;
  }
}

/** Pauses new provider mutations while the sole SSE owner is reconnecting and reconciling history. */
class WriteGate {
  #ready = false;
  #next = Promise.withResolvers<void>();

  pause(): void {
    if (!this.#ready) return;
    this.#ready = false;
    this.#next = Promise.withResolvers<void>();
  }

  resume(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#next.resolve();
  }

  async wait(signal: AbortSignal): Promise<void> {
    while (!this.#ready) {
      if (signal.aborted) throw abortError();
      await Promise.race([this.#next.promise, waitAbort(signal)]);
    }
    if (signal.aborted) throw abortError();
  }
}

/**
 * One provider-coordinate reconciler owns every history and SSE observation for this projection.
 * Exact repeats are harmless. Any changed identity or unseen event behind the committed high-water mark
 * means the projected order can no longer be truthful, so the writable projection fails closed.
 */
class NativeReconciler {
  readonly #session: Session;
  readonly #nativeId: string;
  readonly #mutations: Map<string, BrowserMutation>;
  readonly #budget: ProjectionBudget;
  readonly #trace: Tracer;
  readonly #seenEvents = new Map<string, AnthropicRcEvent>();
  readonly #usersByUuid = new Map<string, UserObservation>();
  #lastSequence: bigint | null = null;

  constructor(
    session: Session,
    nativeId: string,
    mutations: Map<string, BrowserMutation>,
    budget: ProjectionBudget,
    trace: Tracer,
  ) {
    this.#session = session;
    this.#nativeId = nativeId;
    this.#mutations = mutations;
    this.#budget = budget;
    this.#trace = trace;
  }

  accept(event: AnthropicRcEvent): void {
    const existing = this.#seenEvents.get(event.eventId);
    if (existing !== undefined) {
      if (sameProviderEvent(existing, event)) return;
      if (sameProviderUserEcho(existing, event)) {
        // The same logical prompt can be observed first from either provider source. Run the second
        // source through the UUID correlator even when Anthropic retained one event identity for both.
        this.#project(event);
        return;
      }
      throw new NativeProjectionError("provider event identity changed across reconciliation");
    }

    const sequence = BigInt(event.sequenceNum);
    if (this.#lastSequence !== null && sequence <= this.#lastSequence) {
      throw new NativeProjectionError("provider history revealed an event behind projected order");
    }

    this.#budget.claim();
    this.#seenEvents.set(event.eventId, event);
    this.#lastSequence = sequence;
    this.#project(event);
  }

  #project(event: AnthropicRcEvent): void {
    if (event.eventType === "user") {
      const user = providerUser(event, this.#nativeId);
      const mutation = this.#mutations.get(user.uuid);
      if (mutation !== undefined) {
        if (user.text === null) {
          throw new NativeProjectionError("browser UUID resolved to an unsupported provider shape");
        }
        if (
          mutation.text !== user.text ||
          (user.timestamp !== null && mutation.timestamp !== user.timestamp)
        ) {
          throw new NativeProjectionError("browser UUID resolved to changed provider content");
        }
        if (event.source === "client") {
          if (mutation.observedEventId !== null && mutation.observedEventId !== event.eventId) {
            throw new NativeProjectionError("browser UUID resolved to multiple provider events");
          }
          if (mutation.ackEventId !== null && mutation.ackEventId !== event.eventId) {
            throw new NativeProjectionError(
              "provider acknowledgement disagrees with history identity",
            );
          }
          mutation.observedEventId = event.eventId;
        }
      }
      const existingUser = this.#usersByUuid.get(user.uuid);
      if (existingUser !== undefined) {
        if (existingUser.source === event.source) {
          throw new NativeProjectionError("provider user UUID was reused with changed identity");
        }
        if (existingUser.text !== null && existingUser.text === user.text) {
          // Ordinary client/worker replicas deduplicate on the immutable UUID plus normalized text;
          // provider-only session/timestamp enrichment does not change that logical prompt.
          return;
        }
        if (
          existingUser.attachment &&
          existingUser.source === "client" &&
          event.source === "worker" &&
          existingUser.eventId === event.eventId &&
          existingUser.sequenceNum === event.sequenceNum
        ) {
          // The retained iOS sequence marks the attachment only on its client copy, then rewrites worker
          // text with a local upload path. The first marker permanently keeps this UUID out of projection.
          return;
        }
        if (
          existingUser.text === null &&
          user.text === null &&
          isDeepStrictEqual(existingUser.payload, event.payload)
        ) {
          return;
        }
        throw new NativeProjectionError("provider user UUID was reused with changed content");
      }
      this.#usersByUuid.set(user.uuid, {
        source: event.source,
        eventId: event.eventId,
        sequenceNum: event.sequenceNum,
        text: user.text,
        attachment: user.attachment,
        payload: event.payload,
      });
      if (user.text === null) {
        this.#trace.debug("native user event retained outside text projection", {
          source: event.source,
          sequence: event.sequenceNum,
        });
        return;
      }
      this.#session.pushUpstream({
        type: "user",
        uuid: event.eventId,
        local_prompt: true,
        message: { role: "user", content: user.text },
        ...(mutation?.clientMsgId !== undefined ? { client_msg_id: mutation.clientMsgId } : {}),
      });
      return;
    }

    if (event.eventType === "assistant" && event.source === "worker") {
      const text = providerAssistantText(event);
      if (text === "") return;
      this.#session.pushUpstream({
        type: "assistant",
        uuid: event.eventId,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      return;
    }

    if (event.eventType === "result" && event.source === "worker") {
      const result = event.payload.result;
      if (event.payload.type !== "result" || typeof result !== "string") {
        throw new NativeProjectionError("provider result is not the pinned text shape");
      }
      this.#session.pushUpstream({ type: "result", uuid: event.eventId, result });
      return;
    }

    // Permissions, controls, attachments, tool records, and protocol-evolution frames remain native.
    this.#trace.debug("native event retained outside text projection", {
      event: event.eventType,
      source: event.source,
      sequence: event.sequenceNum,
    });
  }
}

export class ClaudeNativeDriver implements Driver {
  readonly capabilities = CLAUDE_NATIVE_CAPABILITIES;
  readonly #ctx: DriverContext;
  readonly #options: ClaudeNativeDriverOptions;
  readonly #client: ClaudeNativeClient;
  readonly #trace: Tracer;
  readonly #mutations = new Map<string, BrowserMutation>();
  readonly #writeGate = new WriteGate();
  readonly #projectionCoordinateCap: number;

  constructor(ctx: DriverContext, options: ClaudeNativeDriverOptions) {
    this.#ctx = ctx;
    this.#options = options;
    this.#client = options.client ?? new AnthropicRcClient();
    this.#trace = (ctx.tracer ?? NOOP_TRACER).child({ driver: "claude-native" });
    this.#projectionCoordinateCap = options.projectionCoordinateCap ?? PROJECTION_COORDINATE_CAP;
    if (
      !Number.isSafeInteger(this.#projectionCoordinateCap) ||
      this.#projectionCoordinateCap <= 0
    ) {
      throw new TypeError("projectionCoordinateCap must be a positive safe integer");
    }
  }

  /** Run ordinary Claude until it exits. Any companion failure closes only the remote projection. */
  async run(parentSignal: AbortSignal): Promise<number> {
    if (parentSignal.aborted) return 0;

    const core = new RelayCore();
    const session = core.create({ title: this.#ctx.title });
    session.pushInitialize();
    session.workerStatus = "idle";
    this.#ctx.onSession?.(session);

    const relays = new Set<Promise<void>>();
    const terminalTasks = new Set<Promise<void>>();
    const bridge = new ReadyBridge({
      session,
      newClient: this.#ctx.newClient,
      identityId: this.#ctx.identity.identityId,
      relays,
      terminalTasks,
      tracer: this.#ctx.tracer ?? NOOP_TRACER,
      parentSignal,
    });
    const projectionSignal = bridge.signal;

    if (this.#options.nativeSessionId !== undefined) {
      let exitCode = 0;
      try {
        await this.#runProjection(
          session,
          bridge,
          Promise.resolve(this.#options.nativeSessionId),
          projectionSignal,
        );
        // Relay failures close the projection Session and are intentionally swallowed by the shared
        // bridge after terminalization. In attach-only mode there is no native child whose exit code
        // owns the process, so surface that unexpected end to service managers as a failed companion.
        if (!parentSignal.aborted && session.closed) exitCode = 1;
      } catch (error) {
        if (!projectionSignal.aborted) {
          exitCode = 1;
          this.#trace.error("native projection stopped", { error: safeError(error) });
        }
      } finally {
        await settleWithin(bridge.close("native companion exited"), TEARDOWN_WAIT_MS);
        await Promise.allSettled([...terminalTasks]);
      }
      return exitCode;
    }

    const binding = Promise.withResolvers<string>();
    let boundNativeId: string | null = null;

    const certs = ensureCerts(this.#options.certsDir);
    const proxyFactory = this.#options.proxyFactory ?? ((options) => new MitmProxy(options));
    const proxy = proxyFactory({
      port: 0,
      leafCert: certs.leafPem,
      leafKey: certs.leafKey,
      mode: "trace",
      tracer: this.#trace,
      onTraceBridge: (nativeId) => {
        if (boundNativeId === null) {
          boundNativeId = nativeId;
          binding.resolve(nativeId);
          return;
        }
        if (boundNativeId !== nativeId) {
          const error = new NativeProjectionError(
            "spawned Claude bridged more than one native session",
          );
          binding.reject(error);
          void bridge.close(error.message).catch(() => {});
        }
      },
    });
    await proxy.listen();

    const env = claudeNativeChildEnv(process.env, proxy.port, certs.caPem);
    let childResult: Promise<number>;
    try {
      childResult = Promise.resolve(
        this.#options.spawnClaude(this.#options.claudeBin, this.#ctx.harnessArgs, env),
      );
    } catch (error) {
      childResult = Promise.reject(error);
    }
    // A projection failure is reported but never tears down the transparent proxy or healthy child.
    const projection = this.#runProjection(
      session,
      bridge,
      binding.promise,
      projectionSignal,
    ).catch(async (error: unknown) => {
      if (!projectionSignal.aborted) {
        this.#trace.error("native projection stopped", { error: safeError(error) });
      }
      await bridge.close("native projection failed");
    });

    try {
      return await Promise.race([childResult, waitAbort(parentSignal).then(() => 0)]);
    } finally {
      binding.reject(abortError());
      const close = bridge.close("native child exited");
      await settleWithin(
        Promise.allSettled([projection, close]).then(() => undefined),
        TEARDOWN_WAIT_MS,
      );
      await Promise.allSettled([...terminalTasks]);
      await proxy.close();
    }
  }

  async #runProjection(
    session: Session,
    bridge: ReadyBridge,
    binding: Promise<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const nativeId = await raceAbort(binding, signal);
    const budget = new ProjectionBudget(this.#projectionCoordinateCap);
    const reconciler = new NativeReconciler(
      session,
      nativeId,
      this.#mutations,
      budget,
      this.#trace,
    );

    // Subscribe first, then read all bounded ascending history. This closes the snapshot gap: live
    // events occurring during pagination remain on the one SSE reader and are consumed in provider order.
    const firstConnection = await this.#openConnection(nativeId, signal);
    await this.#reconcileHistory(nativeId, reconciler, signal);
    if (signal.aborted || session.closed) throw abortError();

    bridge.start({
      title: this.#ctx.title,
      cwd: this.#ctx.cwd,
      git: this.#ctx.git,
      capabilities: CLAUDE_NATIVE_CAPABILITIES,
      harness: CLAUDE_NATIVE_HARNESS,
    });
    this.#writeGate.resume();
    this.#trace.info("native session attached", { session: session.id });

    await Promise.race([
      this.#capturePump(session, nativeId, reconciler, firstConnection, signal),
      this.#injectPump(session, nativeId, budget, signal),
      waitAbort(signal),
    ]);
  }

  async #openConnection(nativeId: string, signal: AbortSignal): Promise<NativeConnection> {
    const opened = Promise.withResolvers<void>();
    const owner = new AbortController();
    const connectionSignal = AbortSignal.any([signal, owner.signal]);
    const iterator = this.#client
      .streamEvents(nativeId, { signal: connectionSignal, onOpen: () => opened.resolve() })
      [Symbol.asyncIterator]();
    const first = iterator.next();
    // Keep a response error observed even if cancellation wins before the consumer takes ownership.
    void first.catch(() => undefined);
    await Promise.race([
      opened.promise,
      first.then(() => {
        throw new NativeProjectionError("native event stream ended before readiness");
      }),
      waitAbort(connectionSignal),
    ]);
    if (connectionSignal.aborted) throw abortError();
    return { iterator, first, close: () => owner.abort() };
  }

  async #reconcileHistory(
    nativeId: string,
    reconciler: NativeReconciler,
    signal: AbortSignal,
  ): Promise<void> {
    const events: AnthropicRcEvent[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < HISTORY_PAGE_CAP; pageNo += 1) {
      if (signal.aborted) throw abortError();
      const page = await this.#client.history(nativeId, {
        sortOrder: "asc",
        limit: HISTORY_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
        signal,
      });
      events.push(...page.data);
      if (events.length > this.#projectionCoordinateCap) {
        throw new NativeProjectionError("native history exceeds the bounded reconciliation limit");
      }
      // Ascending history has returned both next_cursor and polling-style resume_cursor in captured
      // provider responses. An empty page is the absorbing end for the latter; otherwise follow either
      // opaque cursor under the same cycle/page/event bounds.
      const continuation = page.nextCursor ?? page.resumeCursor ?? null;
      if (page.data.length === 0 || continuation === null) {
        events.sort(compareProviderEvents);
        for (const event of events) reconciler.accept(event);
        return;
      }
      if (continuation === "" || cursors.has(continuation)) {
        throw new NativeProjectionError("native history pagination cursor cycled");
      }
      cursors.add(continuation);
      cursor = continuation;
    }
    throw new NativeProjectionError("native history exceeds the bounded page limit");
  }

  async #capturePump(
    session: Session,
    nativeId: string,
    reconciler: NativeReconciler,
    firstConnection: NativeConnection,
    signal: AbortSignal,
  ): Promise<void> {
    let connection = firstConnection;
    try {
      while (!signal.aborted && !session.closed) {
        try {
          await this.#consumeConnection(connection, reconciler, signal);
        } catch (error) {
          if (signal.aborted || session.closed) return;
          if (error instanceof NativeProjectionError) throw error;
          this.#trace.warn("native event stream dropped; reconciling", {
            error: safeError(error),
          });
        }
        connection.close();
        if (signal.aborted || session.closed) return;
        this.#writeGate.pause();
        let recovered = false;
        for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
          await sleepAbortable(this.#options.reconnectDelayMs ?? RECONNECT_DELAY_MS, signal);
          if (signal.aborted || session.closed) return;
          let candidate: NativeConnection | null = null;
          try {
            candidate = await this.#openConnection(nativeId, signal);
            await this.#reconcileHistory(nativeId, reconciler, signal);
            connection = candidate;
            this.#writeGate.resume();
            recovered = true;
            break;
          } catch (error) {
            candidate?.close();
            if (signal.aborted || session.closed) return;
            if (error instanceof NativeProjectionError) throw error;
            this.#trace.warn("native event stream reconnect failed", {
              attempt,
              error: safeError(error),
            });
          }
        }
        if (!recovered) {
          throw new NativeProjectionError("native event stream could not be reconciled");
        }
      }
    } finally {
      connection.close();
    }
  }

  async #consumeConnection(
    connection: NativeConnection,
    reconciler: NativeReconciler,
    signal: AbortSignal,
  ): Promise<void> {
    let next = await connection.first;
    for (;;) {
      if (signal.aborted) throw abortError();
      if (next.done) return;
      if (next.value.kind === "event") reconciler.accept(next.value.event);
      next = await connection.iterator.next();
    }
  }

  /** One serial writer. A failed or outcome-unknown POST closes the projection before any successor. */
  async #injectPump(
    session: Session,
    nativeId: string,
    budget: ProjectionBudget,
    signal: AbortSignal,
  ): Promise<void> {
    const generation = session.claimWorkerStream();
    for await (const event of session.followDownstream(generation, () => signal.aborted)) {
      if (signal.aborted || session.closed) return;
      if (event === null) continue;
      if (event.eventType === "control_request" && initializeSubtype(event)) {
        session.ack(event.eventId);
        continue;
      }
      if (event.eventType !== "user") {
        // Defense in depth for old/handcrafted viewers: unsupported mutations never reach Anthropic.
        session.ack(event.eventId);
        continue;
      }

      await this.#writeGate.wait(signal);
      const input = downstreamInput(event);
      const mutation: BrowserMutation = {
        uuid: input.uuid,
        timestamp: input.timestamp,
        text: input.message.content,
        ...(typeof event.payload.client_msg_id === "string"
          ? { clientMsgId: event.payload.client_msg_id }
          : {}),
        ackEventId: null,
        observedEventId: null,
      };
      if (this.#mutations.has(mutation.uuid)) {
        throw new NativeProjectionError("browser mutation UUID was reused");
      }
      budget.claim();
      this.#mutations.set(mutation.uuid, mutation);

      let acknowledgement: RcPostAck;
      try {
        acknowledgement = await this.#client.postEvent(nativeId, input, { signal });
      } catch (error) {
        if (AnthropicRcError.is(error) && error.outcomeUnknown) {
          throw new NativeProjectionError("native text outcome is unknown; projection fenced");
        }
        throw new NativeProjectionError("native text was rejected; projection fenced");
      }
      mutation.ackEventId = acknowledgement.eventId;
      if (
        mutation.observedEventId !== null &&
        mutation.observedEventId !== acknowledgement.eventId
      ) {
        throw new NativeProjectionError("provider acknowledgement disagrees with observed history");
      }
      session.ack(event.eventId);
      this.#trace.debug("native text acknowledged", {
        duplicate: acknowledgement.duplicate,
        sequence: acknowledgement.sequenceNum,
      });
    }
  }
}

export function runClaudeNativeDriver(
  context: DriverContext,
  signal: AbortSignal,
  options: ClaudeNativeDriverOptions,
): Promise<number> {
  return new ClaudeNativeDriver(context, options).run(signal);
}

/** Build the transparent child environment without exposing wrapper/broker secrets or parent identity. */
export function claudeNativeChildEnv(
  source: NodeJS.ProcessEnv,
  proxyPort: number,
  caPem: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    https_proxy: `http://127.0.0.1:${proxyPort}`,
    NODE_EXTRA_CA_CERTS: caPem,
  };
  delete env.NO_PROXY;
  delete env.no_proxy;
  delete env.REMOTE_CLAW_SECRET_FILE;
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

function compareProviderEvents(a: AnthropicRcEvent, b: AnthropicRcEvent): number {
  const aa = BigInt(a.sequenceNum);
  const bb = BigInt(b.sequenceNum);
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return a.eventId.localeCompare(b.eventId);
}

function sameProviderEvent(a: AnthropicRcEvent, b: AnthropicRcEvent): boolean {
  return (
    a.eventId === b.eventId &&
    a.sequenceNum === b.sequenceNum &&
    a.eventType === b.eventType &&
    a.source === b.source &&
    a.createdAt === b.createdAt &&
    isDeepStrictEqual(a.payload, b.payload)
  );
}

/** Candidate match only; #project enforces normalized text or a prior non-projectable marker. */
function sameProviderUserEcho(a: AnthropicRcEvent, b: AnthropicRcEvent): boolean {
  const aUuid = providerUserUuid(a);
  const bUuid = providerUserUuid(b);
  return (
    aUuid !== null && aUuid === bUuid && a.source !== b.source && a.sequenceNum === b.sequenceNum
  );
}

function providerUserUuid(event: AnthropicRcEvent): string | null {
  const uuid = event.payload.uuid;
  return event.eventType === "user" &&
    event.payload.type === "user" &&
    typeof uuid === "string" &&
    uuid !== ""
    ? uuid
    : null;
}

function providerUser(
  event: AnthropicRcEvent,
  nativeId: string,
): { uuid: string; timestamp: string | null; text: string | null; attachment: boolean } {
  const payload = event.payload;
  const timestamp = payload.timestamp;
  const parentToolUseId = payload.parent_tool_use_id;
  // The exact `/sessions/{nativeId}` history/stream endpoint supplies the binding. Official mobile
  // events omit these redundant payload fields; when a field is present it must still agree/validate.
  if (
    payload.type !== "user" ||
    typeof payload.uuid !== "string" ||
    payload.uuid === "" ||
    (payload.session_id !== undefined && payload.session_id !== nativeId) ||
    (timestamp !== undefined && (typeof timestamp !== "string" || timestamp === "")) ||
    (parentToolUseId !== undefined &&
      parentToolUseId !== null &&
      (typeof parentToolUseId !== "string" || parentToolUseId === ""))
  ) {
    throw new NativeProjectionError("provider user event has invalid identity fields");
  }
  const message = payload.message;
  const attachment = Object.hasOwn(payload, "file_attachments");
  if (
    (parentToolUseId !== undefined && parentToolUseId !== null) ||
    attachment ||
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return {
      uuid: payload.uuid,
      timestamp: typeof timestamp === "string" ? timestamp : null,
      text: null,
      attachment,
    };
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "user" || typeof record.content !== "string" || record.content === "") {
    return {
      uuid: payload.uuid,
      timestamp: typeof timestamp === "string" ? timestamp : null,
      text: null,
      attachment: false,
    };
  }
  return {
    uuid: payload.uuid,
    timestamp: typeof timestamp === "string" ? timestamp : null,
    text: record.content,
    attachment: false,
  };
}

function providerAssistantText(event: AnthropicRcEvent): string {
  const payload = event.payload;
  const message = payload.message;
  if (
    payload.type !== "assistant" ||
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    throw new NativeProjectionError("provider assistant event is not the pinned text shape");
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") {
    throw new NativeProjectionError("provider assistant event is not the pinned text shape");
  }
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) {
    throw new NativeProjectionError("provider assistant event is not the pinned text shape");
  }
  return record.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function downstreamInput(event: RcEvent): RcUserEventInput {
  const payload = event.payload;
  const message = payload.message;
  if (
    typeof payload.uuid !== "string" ||
    typeof payload.timestamp !== "string" ||
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    throw new NativeProjectionError("browser text lacks an immutable native coordinate");
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "user" || typeof record.content !== "string") {
    throw new NativeProjectionError("browser text is not a user message");
  }
  const text = record.content;
  if (text.trim() === "" || text.trimStart().startsWith("/")) {
    throw new NativeProjectionError("unsupported browser text reached the native writer");
  }
  return {
    uuid: payload.uuid,
    timestamp: payload.timestamp,
    message: { role: "user", content: text },
    parentToolUseId: null,
  };
}

function initializeSubtype(event: RcEvent): boolean {
  const request = event.payload.request;
  return (
    typeof request === "object" &&
    request !== null &&
    !Array.isArray(request) &&
    (request as { subtype?: unknown }).subtype === "initialize"
  );
}

function safeError(error: unknown): string {
  if (error instanceof NativeProjectionError) return error.message;
  if (AnthropicRcError.is(error)) return `${error.operation} failed (${error.kind})`;
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return error.name;
  }
  return "native companion operation failed";
}

function abortError(): DOMException {
  return new DOMException("operation aborted", "AbortError");
}

function waitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return Promise.race([operation, waitAbort(signal).then(() => Promise.reject(abortError()))]);
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function settleWithin(operation: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}
