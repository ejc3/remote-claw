import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import { CODEX_CAPABILITIES, CODEX_HARNESS, type Driver, type DriverContext } from "../driver.js";
import { ReadyBridge } from "../drivers/ready-bridge.js";
import { type RcEvent, RelayCore, type Session } from "../session.js";
import {
  assertCodexCompatibility,
  CodexAppServerClient,
  CodexAppServerError,
  type CodexClient,
  type CodexInbound,
  type CodexThreadItem,
  type CodexThreadStatus,
  isCodexThreadId,
  parseCodexStatus,
} from "./client.js";

const ITEM_LIMIT = 10_000;
const PAGE_LIMIT = 100;
const CORRELATION_TIMEOUT_MS = 15_000;

export class CodexProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProjectionError";
  }
}

export interface CodexDriverOptions {
  url: string;
  threadId: string;
  client?: CodexClient;
  runtime?: Readonly<{ platform: NodeJS.Platform; arch: string }>;
}

interface BrowserMutation {
  text: string;
  clientMsgId?: string;
  itemId: string | null;
  correlated: PromiseWithResolvers<void>;
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([operation, cancellation]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

function waitForCorrelation(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CodexProjectionError("Codex user-item correlation timed out")),
      CORRELATION_TIMEOUT_MS,
    );
    if (typeof timer === "object") timer.unref();
  });
  return withAbort(Promise.race([operation, deadline]), signal).finally(() => clearTimeout(timer));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function userText(item: CodexThreadItem): string | null {
  if (!Array.isArray(item.content) || item.content.length === 0) return null;
  const parts: string[] = [];
  for (const value of item.content) {
    const input = record(value);
    if (input?.type !== "text" || typeof input.text !== "string") return null;
    parts.push(input.text);
  }
  const text = parts.join("");
  const trimmed = text.trim();
  return trimmed === "" || trimmed.startsWith("/") ? null : text;
}

class IdleGate {
  #idle: boolean;
  #wake = Promise.withResolvers<void>();

  constructor(status: CodexThreadStatus) {
    this.#idle = status.type === "idle";
  }

  update(status: CodexThreadStatus): void {
    const idle = status.type === "idle";
    if (idle === this.#idle) return;
    this.#idle = idle;
    const wake = this.#wake;
    this.#wake = Promise.withResolvers<void>();
    wake.resolve();
  }

  async wait(signal: AbortSignal): Promise<void> {
    while (!this.#idle) {
      throwIfAborted(signal);
      await withAbort(this.#wake.promise, signal);
    }
    throwIfAborted(signal);
    // Claim the one native turn before another browser event can pass this gate.
    this.#idle = false;
  }
}

class CodexReconciler {
  readonly #session: Session;
  readonly #mutations: Map<string, BrowserMutation>;
  readonly #seen = new Map<string, string>();

  constructor(session: Session, mutations: Map<string, BrowserMutation>) {
    this.#session = session;
    this.#mutations = mutations;
  }

  accept(item: CodexThreadItem): void {
    if (item.type === "userMessage") {
      const text = userText(item);
      if (text === null) return;
      const clientId = typeof item.clientId === "string" ? item.clientId : null;
      if (!this.#admit(item.id, JSON.stringify([item.type, clientId, text]))) return;
      const mutation = clientId === null ? undefined : this.#mutations.get(clientId);
      if (mutation !== undefined) {
        if (mutation.itemId !== null || mutation.text !== text) {
          throw new CodexProjectionError("Codex browser coordinate changed or repeated");
        }
        mutation.itemId = item.id;
      }
      this.#session.pushUpstream({
        type: "user",
        uuid: item.id,
        local_prompt: true,
        message: { role: "user", content: text },
        ...(mutation?.clientMsgId !== undefined ? { client_msg_id: mutation.clientMsgId } : {}),
      });
      mutation?.correlated.resolve();
      return;
    }

    if (item.type === "agentMessage" && typeof item.text === "string" && item.text !== "") {
      if (!this.#admit(item.id, JSON.stringify([item.type, item.text]))) return;
      this.#session.pushUpstream({
        type: "assistant",
        uuid: item.id,
        message: { role: "assistant", content: [{ type: "text", text: item.text }] },
      });
    }
  }

  #admit(id: string, fingerprint: string): boolean {
    const previous = this.#seen.get(id);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new CodexProjectionError("Codex reused a projected item id with changed content");
      }
      return false;
    }
    if (this.#seen.size >= ITEM_LIMIT) {
      throw new CodexProjectionError("Codex projection exceeded its item limit");
    }
    this.#seen.set(id, fingerprint);
    return true;
  }
}

export class CodexDriver implements Driver {
  readonly capabilities = CODEX_CAPABILITIES;
  readonly #ctx: DriverContext;
  readonly #options: CodexDriverOptions;
  readonly #client: CodexClient;
  readonly #trace: Tracer;
  readonly #mutations = new Map<string, BrowserMutation>();

  constructor(ctx: DriverContext, options: CodexDriverOptions) {
    this.#ctx = ctx;
    this.#options = options;
    this.#client = options.client ?? new CodexAppServerClient(options.url);
    this.#trace = (ctx.tracer ?? NOOP_TRACER).child({ driver: "codex" });
    if (!isCodexThreadId(options.threadId)) {
      throw new TypeError("threadId must be a canonical Codex UUIDv7");
    }
  }

  async run(parentSignal: AbortSignal): Promise<number> {
    if (parentSignal.aborted) return 0;
    const core = new RelayCore();
    const session = core.create({ title: this.#ctx.title });
    session.pushInitialize();
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
    const signal = bridge.signal;
    let exitCode = 0;
    try {
      const initialized = await this.#client.initialize(signal);
      assertCodexCompatibility(initialized, this.#options.runtime);
      const resumed = await this.#client.resume(this.#options.threadId, signal);
      if (
        resumed.thread.id !== this.#options.threadId ||
        resumed.thread.canAcceptDirectInput !== true ||
        resumed.thread.status.type === "notLoaded" ||
        resumed.thread.status.type === "systemError"
      ) {
        throw new CodexProjectionError("Codex thread is not writable");
      }

      const gate = new IdleGate(resumed.thread.status);
      const reconciler = new CodexReconciler(session, this.#mutations);
      session.workerStatus = resumed.thread.status.type === "active" ? "running" : "idle";
      await this.#reconcileHistory(reconciler, signal);
      for (const inbound of this.#client.drainInbound()) {
        this.#acceptInbound(inbound, session, reconciler, gate);
      }
      const handle = bridge.start({
        title: this.#ctx.title,
        cwd: this.#ctx.cwd,
        git: this.#ctx.git,
        capabilities: CODEX_CAPABILITIES,
        harness: CODEX_HARNESS,
      });
      this.#trace.info("Codex thread attached");

      await withAbort(
        Promise.race([
          this.#capturePump(session, reconciler, gate, signal),
          this.#injectPump(session, gate, signal),
          handle.served,
        ]),
        signal,
      );
      if (!parentSignal.aborted && session.closed) exitCode = 1;
    } catch (error) {
      if (!signal.aborted) {
        exitCode = 1;
        this.#trace.error("Codex projection stopped", {
          error:
            error instanceof CodexProjectionError || error instanceof CodexAppServerError
              ? error.message
              : "unexpected error",
        });
      }
    } finally {
      this.#client.close();
      await bridge.close("Codex companion exited");
      await Promise.allSettled([...terminalTasks]);
    }
    return exitCode;
  }

  async #reconcileHistory(reconciler: CodexReconciler, signal: AbortSignal): Promise<void> {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let count = 0;
    for (let pageNo = 0; pageNo < PAGE_LIMIT; pageNo += 1) {
      const page = await this.#client.listItems(this.#options.threadId, cursor, signal);
      for (const entry of page.data) {
        count += 1;
        if (count > ITEM_LIMIT) {
          throw new CodexProjectionError("Codex history exceeded its item limit");
        }
        reconciler.accept(entry.item);
      }
      if (page.nextCursor === null) return;
      if (page.nextCursor === "" || cursors.has(page.nextCursor)) {
        throw new CodexProjectionError("Codex history cursor cycled");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new CodexProjectionError("Codex history exceeded its page limit");
  }

  async #capturePump(
    session: Session,
    reconciler: CodexReconciler,
    gate: IdleGate,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const inbound of this.#client.inbound(signal)) {
      this.#acceptInbound(inbound, session, reconciler, gate);
    }
  }

  #acceptInbound(
    inbound: CodexInbound,
    session: Session,
    reconciler: CodexReconciler,
    gate: IdleGate,
  ): void {
    // App-server approvals and questions are global first-response-wins requests. Remaining completely
    // silent preserves the native TUI as their sole owner. The client exposes no response API.
    if (inbound.kind === "request") return;
    const { method, params } = inbound.value;
    if (params.threadId !== this.#options.threadId) return;
    if (method === "item/completed") {
      const item = record(params.item);
      if (typeof item?.type !== "string" || typeof item.id !== "string") {
        throw new CodexProjectionError("Codex emitted an invalid completed item");
      }
      reconciler.accept(item as CodexThreadItem);
      return;
    }
    if (method === "thread/status/changed") {
      const status = parseCodexStatus(params.status);
      if (status.type === "notLoaded" || status.type === "systemError") {
        throw new CodexProjectionError("Codex thread became unavailable");
      }
      gate.update(status);
      session.workerStatus = status.type === "active" ? "running" : "idle";
      session.wake();
      return;
    }
    if (
      method === "thread/closed" ||
      method === "thread/deleted" ||
      method === "thread/archived" ||
      method === "thread/reverted"
    ) {
      throw new CodexProjectionError("Codex thread is no longer a valid projection target");
    }
  }

  async #injectPump(session: Session, gate: IdleGate, signal: AbortSignal): Promise<void> {
    const generation = session.claimWorkerStream();
    for await (const event of session.followDownstream(generation, () => signal.aborted)) {
      if (event === null || signal.aborted || session.closed) continue;
      if (event.eventType === "control_request") {
        // initialize and every browser-disabled control are local no-ops at this text-only boundary.
        session.ack(event.eventId);
        continue;
      }
      if (event.eventType !== "user") {
        session.ack(event.eventId);
        continue;
      }
      await this.#injectText(session, event, gate, signal);
    }
  }

  async #injectText(
    session: Session,
    event: RcEvent,
    gate: IdleGate,
    signal: AbortSignal,
  ): Promise<void> {
    const message = record(event.payload.message);
    const text = typeof message?.content === "string" ? message.content : "";
    if (text.trim() === "" || text.trimStart().startsWith("/")) {
      throw new CodexProjectionError("unsupported browser text reached the Codex writer");
    }
    const clientMsgId = event.payload.client_msg_id;
    if (clientMsgId !== undefined && typeof clientMsgId !== "string") {
      throw new CodexProjectionError("browser mutation carried an invalid client coordinate");
    }
    if (this.#mutations.size >= ITEM_LIMIT || this.#mutations.has(event.eventId)) {
      throw new CodexProjectionError("Codex browser coordinate limit or reuse");
    }
    await gate.wait(signal);
    const mutation: BrowserMutation = {
      text,
      ...(typeof clientMsgId === "string" ? { clientMsgId } : {}),
      itemId: null,
      correlated: Promise.withResolvers<void>(),
    };
    this.#mutations.set(event.eventId, mutation);
    try {
      await this.#client.startTurn(this.#options.threadId, event.eventId, text, signal);
      await waitForCorrelation(mutation.correlated.promise, signal);
      throwIfAborted(signal);
      session.ack(event.eventId);
    } catch (error) {
      if (signal.aborted || session.closed) return;
      throw new CodexProjectionError(
        error instanceof CodexProjectionError
          ? error.message
          : "Codex text outcome is unknown; projection fenced",
      );
    }
  }
}

export function runCodexDriver(
  context: DriverContext,
  signal: AbortSignal,
  options: CodexDriverOptions,
): Promise<number> {
  return new CodexDriver(context, options).run(signal);
}
