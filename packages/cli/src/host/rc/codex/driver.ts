import { createHash } from "node:crypto";
import { boundLiveText } from "../../../broker/live-output.js";
import { parseSessionSettings, type SessionSettings } from "../../../harness.js";
import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import {
  CODEX_APPROVAL_CAPABILITIES,
  CODEX_CAPABILITIES,
  CODEX_HARNESS,
  type Driver,
  type DriverContext,
} from "../driver.js";
import { ReadyBridge } from "../drivers/ready-bridge.js";
import { NativePreviewBudget, NativeUploadStore } from "../native-uploads.js";
import { boundedImagePreviews, toolResultOutput } from "../relay.js";
import { type HostImage, type RcEvent, RelayCore, type Session } from "../session.js";
import { CodexCommandApprovals } from "./approvals.js";
import {
  assertCodexCompatibility,
  CODEX_HISTORY_ITEM_LIMIT,
  CodexAppServerClient,
  CodexAppServerError,
  type CodexClient,
  type CodexInbound,
  type CodexThreadItem,
  type CodexThreadStatus,
  codexAppServerVersion,
  isCodexThreadId,
  isCodexTurnStatus,
  parseCodexStatus,
} from "./client.js";
import { CodexFileApprovals } from "./file-approvals.js";
import { CodexUserQuestions } from "./questions.js";
import {
  type CodexSettingsUpdate,
  codexSettingsUpdate,
  parseCodexCurrentSettings,
} from "./settings.js";

// One native item per page keeps retained inline images from combining into an oversized frame.
// Preserve the existing roughly 100k raw-item scan budget, independently of projected item limits.
const HISTORY_PAGE_LIMIT = 100_000;
const CORRELATION_TIMEOUT_MS = 15_000;

function settingsConfirmed(
  update: CodexSettingsUpdate,
  current: SessionSettings["current"],
): boolean {
  if ("model" in update) return current.model === update.model;
  if ("effort" in update) return current.effort === update.effort;
  return (
    current.collaborationMode === update.collaborationMode.mode &&
    current.model === update.collaborationMode.settings.model &&
    current.effort === update.collaborationMode.settings.reasoning_effort
  );
}

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
  uploadStore?: NativeUploadStore;
  /** Test seam for the projection-wide decoded preview allowance (32 MiB by default). */
  projectionPreviewByteLimit?: number;
}

interface BrowserMutation {
  inputDigest: string;
  clientMsgId?: string;
  itemCoordinate: string | null;
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

function userInput(item: CodexThreadItem): {
  text: string;
  digest: string;
  images: ReturnType<typeof boundedImagePreviews>;
} | null {
  if (!Array.isArray(item.content) || item.content.length === 0) return null;
  const parts: string[] = [];
  const blocks: [string, string][] = [];
  const previews: { name: string; mime: string; data: string }[] = [];
  for (const value of item.content) {
    const input = record(value);
    if (input?.type === "text" && typeof input.text === "string") {
      parts.push(input.text);
      blocks.push(["text", input.text]);
    } else if (input?.type === "image" && typeof input.url === "string" && input.url !== "") {
      blocks.push(["image", input.url]);
      const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/.exec(input.url);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        previews.push({ name: `Image ${previews.length + 1}`, mime: match[1], data: match[2] });
      }
    } else if (
      input?.type === "localImage" &&
      typeof input.path === "string" &&
      input.path !== ""
    ) {
      // Read-only native observation. Never read this path or fetch a native image URL.
      blocks.push(["localImage", input.path]);
    } else return null;
  }
  const text = parts.join("");
  const trimmed = text.trim();
  if (trimmed.startsWith("/") || (trimmed === "" && blocks.every(([type]) => type === "text")))
    return null;
  return {
    text:
      trimmed === "" ? `📎 ${blocks.filter(([type]) => type !== "text").length} image(s)` : text,
    digest: inputDigest(blocks),
    images: boundedImagePreviews(previews),
  };
}

function inputDigest(blocks: [string, string][]): string {
  // Hash each block separately: no JSON-sized copy of an entire multi-image group and no raw image
  // strings retained in the mutation/dedup maps. Tuple encoding preserves order and boundaries.
  const hash = createHash("sha256");
  for (const block of blocks) hash.update(JSON.stringify(block));
  return hash.digest("hex");
}

function browserInputDigest(text: string, images: readonly HostImage[]): string {
  return inputDigest([
    ["text", text],
    ...images.map((image): [string, string] => ["image", image.url]),
  ]);
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

/** Order browser text/settings together while interrupts and native decisions remain responsive. */
class BrowserTurnQueue {
  readonly #items: RcEvent[] = [];
  #wake = Promise.withResolvers<void>();

  push(event: RcEvent): void {
    if (this.#items.length >= CODEX_HISTORY_ITEM_LIMIT) {
      throw new CodexProjectionError("Codex browser-turn queue exceeded its bound");
    }
    this.#items.push(event);
    const wake = this.#wake;
    this.#wake = Promise.withResolvers<void>();
    wake.resolve();
  }

  async shift(signal: AbortSignal): Promise<RcEvent | undefined> {
    while (this.#items.length === 0) await withAbort(this.#wake.promise, signal);
    throwIfAborted(signal);
    return this.#items.shift();
  }
}

/** Only turns deferred during startup may request one repair, after a native terminal signal. */
class HistoryRepairQueue {
  readonly #deferred = new Set<string>();
  readonly #ready: string[] = [];
  #wake = Promise.withResolvers<void>();

  defer(turnId: string): void {
    if (this.#deferred.has(turnId)) return;
    if (turnId === "" || turnId.length > 256 || this.#deferred.size >= HISTORY_PAGE_LIMIT)
      throw new CodexProjectionError("Codex deferred history exceeded its bound");
    this.#deferred.add(turnId);
  }

  complete(turnId: string): void {
    if (!this.#deferred.delete(turnId)) return;
    this.#ready.push(turnId);
    const wake = this.#wake;
    this.#wake = Promise.withResolvers<void>();
    wake.resolve();
  }

  async shift(signal: AbortSignal): Promise<string | undefined> {
    while (this.#ready.length === 0) await withAbort(this.#wake.promise, signal);
    throwIfAborted(signal);
    return this.#ready.shift();
  }
}

class CodexReconciler {
  readonly #session: Session;
  readonly #mutations: Map<string, BrowserMutation>;
  readonly #seen = new Map<string, string>();
  readonly #uploads: NativeUploadStore;
  readonly #previews: NativePreviewBudget;
  readonly #live: boolean;
  #draftCoordinate: string | null = null;
  #lastFinishedCoordinate: string | null = null;
  #overlap = false;
  readonly tasksSupported: boolean;

  constructor(
    session: Session,
    mutations: Map<string, BrowserMutation>,
    uploads: NativeUploadStore,
    previewByteLimit?: number,
    tasksSupported = false,
    live = false,
  ) {
    this.#session = session;
    this.#mutations = mutations;
    this.#uploads = uploads;
    this.#previews = new NativePreviewBudget(previewByteLimit);
    this.#live = live;
    this.tasksSupported = tasksSupported;
  }

  #textId(coordinate: string): string {
    return `native-text-${createHash("sha256")
      .update(JSON.stringify(["parent-text-v1", this.#session.id, coordinate]))
      .digest("hex")}`;
  }

  observeLive(method: string, params: Record<string, unknown>): void {
    if (!this.#live) return;
    if (method === "turn/completed") {
      this.#draftCoordinate = null;
      this.#overlap = false;
      this.#session.setLiveOutput(null);
      return;
    }
    if (typeof params.turnId !== "string" || !params.turnId || params.turnId.length > 256) return;
    const item = record(params.item);
    const id = method === "item/started" ? item?.id : params.itemId;
    if (typeof id !== "string" || !id || id.length > 256) return;
    const coordinate = JSON.stringify([params.turnId, id]);
    if (this.#seen.has(coordinate) || coordinate === this.#lastFinishedCoordinate || this.#overlap)
      return;
    if (
      method === "item/started" &&
      item?.type === "agentMessage" &&
      typeof item.text === "string"
    ) {
      if (this.#draftCoordinate === coordinate) return;
      if (this.#draftCoordinate !== null) {
        this.#overlap = true;
        this.#draftCoordinate = null;
        this.#session.setLiveOutput(null);
        return;
      }
      this.#draftCoordinate = coordinate;
      this.#session.setLiveOutput({
        finalMsgId: this.#textId(coordinate),
        ...boundLiveText(item.text),
      });
    } else if (
      method === "item/agentMessage/delta" &&
      coordinate === this.#draftCoordinate &&
      typeof params.delta === "string"
    ) {
      const current = this.#session.liveOutput.item;
      if (current && !current.truncated)
        this.#session.setLiveOutput({
          finalMsgId: current.finalMsgId,
          ...boundLiveText(current.text + params.delta),
        });
    }
  }

  accept(turnId: string, item: CodexThreadItem): void {
    // Codex item ids are stable only within one turn. The app-server stores and reconciles them by
    // (turn_id, item_id), and legacy histories may legitimately reuse an id after rollback. JSON's
    // tuple encoding is an exact, collision-free session coordinate for arbitrary string ids.
    const coordinate = JSON.stringify([turnId, item.id]);
    if (item.type === "userMessage") {
      const input = userInput(item);
      if (input === null) return;
      const { text, digest } = input;
      const clientId = typeof item.clientId === "string" ? item.clientId : null;
      if (!this.#admit(coordinate, JSON.stringify([item.type, clientId, digest]))) return;
      const mutation = clientId === null ? undefined : this.#mutations.get(clientId);
      if (mutation !== undefined) {
        if (mutation.itemCoordinate !== null || mutation.inputDigest !== digest) {
          throw new CodexProjectionError("Codex browser coordinate changed or repeated");
        }
        mutation.itemCoordinate = coordinate;
      }
      const display = this.#uploads.display(text);
      this.#session.pushUpstream({
        type: "user",
        uuid: coordinate,
        local_prompt: true,
        message: {
          role: "user",
          content: display.text,
          images: this.#previews.accept([...input.images, ...display.images]),
        },
        ...(mutation?.clientMsgId !== undefined ? { client_msg_id: mutation.clientMsgId } : {}),
      });
      mutation?.correlated.resolve();
      return;
    }

    if (item.type === "agentMessage" && typeof item.text === "string") {
      this.#lastFinishedCoordinate = coordinate;
      if (this.#draftCoordinate === coordinate) {
        this.#draftCoordinate = null;
        this.#session.setLiveOutput(null);
      }
      if (item.text === "" || !this.#admit(coordinate, JSON.stringify([item.type, item.text])))
        return;
      this.#session.pushUpstream({
        type: "assistant",
        uuid: coordinate,
        ...(this.#live ? { native_text_id: this.#textId(coordinate) } : {}),
        message: { role: "assistant", content: [{ type: "text", text: item.text }] },
      });
      return;
    }

    if (item.type === "subAgentActivity" && this.tasksSupported) {
      // These are immutable parent-thread observations, not child state or authority. In particular,
      // a completed wait call or parent turn cannot establish that a child has finished.
      const { kind, agentThreadId, agentPath } = item;
      if (
        (kind !== "started" &&
          kind !== "interacted" &&
          kind !== "interrupted" &&
          kind !== "completed") ||
        !isCodexThreadId(agentThreadId) ||
        typeof agentPath !== "string" ||
        agentPath === "" ||
        agentPath.length > 1024 ||
        /[\p{Cc}\p{Cf}]/u.test(agentPath) ||
        item.id === "" ||
        item.id.length > 256 ||
        turnId === "" ||
        turnId.length > 256
      )
        return;
      if (!this.#admit(coordinate, JSON.stringify([item.type, kind, agentThreadId, agentPath])))
        return;
      this.#session.pushUpstream({
        type: "system",
        uuid: coordinate,
        subtype: kind === "started" ? "task_started" : "task_updated",
        task_id: agentThreadId,
        description: `${agentPath} — ${kind}`,
      });
      return;
    }

    if (item.type === "commandExecution") {
      // Completed native observations only: no execution, approval response, or inferred running
      // lifecycle. History can include in-progress items, which must not consume their final identity.
      if (
        (item.status !== "completed" && item.status !== "failed" && item.status !== "declined") ||
        typeof item.command !== "string" ||
        item.command === "" ||
        typeof item.cwd !== "string" ||
        (item.aggregatedOutput !== null && typeof item.aggregatedOutput !== "string") ||
        (item.exitCode !== null && !Number.isSafeInteger(item.exitCode))
      )
        return;
      const output = item.aggregatedOutput ?? "";
      const failed = item.status !== "completed" || (item.exitCode !== null && item.exitCode !== 0);
      // Retain only a digest, but fence changes even beyond the displayed output prefix.
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([item.type, item.command, item.cwd, item.status, item.exitCode, output]),
        )
        .digest("hex");
      if (!this.#admit(coordinate, fingerprint)) return;
      this.#session.pushUpstream({
        type: "assistant",
        uuid: JSON.stringify([turnId, item.id, "call"]),
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: coordinate,
              name: "Shell",
              input: { command: item.command, cwd: item.cwd },
            },
          ],
        },
      });
      this.#session.pushUpstream({
        type: "user",
        uuid: JSON.stringify([turnId, item.id, "output"]),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: coordinate,
              is_error: failed,
              // Session retains upstream events before the relay applies its publication bound.
              content: toolResultOutput(
                output ||
                  (item.status === "declined"
                    ? "Command declined in native Codex."
                    : failed
                      ? `Command failed in native Codex${item.exitCode === null ? "." : ` (exit ${item.exitCode}).`}`
                      : ""),
              ),
            },
          ],
        },
      });
    }
  }

  #admit(id: string, fingerprint: string): boolean {
    const previous = this.#seen.get(id);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new CodexProjectionError(
          "Codex reused a projected item coordinate with changed content",
        );
      }
      return false;
    }
    if (this.#seen.size >= CODEX_HISTORY_ITEM_LIMIT) {
      throw new CodexProjectionError("Codex projection exceeded its item limit");
    }
    this.#seen.set(id, fingerprint);
    return true;
  }
}

export class CodexDriver implements Driver {
  get capabilities() {
    const base = this.#approvals === null ? CODEX_CAPABILITIES : CODEX_APPROVAL_CAPABILITIES;
    return {
      ...base,
      ...(this.#filesSupported ? { files: true } : {}),
      ...(this.#filesSupported ? { liveAssistant: true } : {}),
      ...(this.#settingsSupported
        ? { controls: { ...base.controls, configureSession: true } }
        : {}),
    };
  }
  readonly #ctx: DriverContext;
  readonly #options: CodexDriverOptions;
  readonly #client: CodexClient;
  readonly #trace: Tracer;
  readonly #mutations = new Map<string, BrowserMutation>();
  readonly #browserTurns = new BrowserTurnQueue();
  #lastInterruptedTurn: string | null = null;
  #approvals: CodexCommandApprovals | null = null;
  #fileApprovals: CodexFileApprovals | null = null;
  #questions: CodexUserQuestions | null = null;
  readonly #uploads: NativeUploadStore;
  readonly #historyRepairs = new HistoryRepairQueue();
  #filesSupported = false;
  #settingsSupported = false;
  /** RPC acceptance is not native application; dependent writes must not embed stale settings. */
  #expectedSettings: CodexSettingsUpdate | null = null;

  constructor(ctx: DriverContext, options: CodexDriverOptions) {
    this.#ctx = ctx;
    this.#options = options;
    this.#client = options.client ?? new CodexAppServerClient(options.url);
    this.#uploads = options.uploadStore ?? new NativeUploadStore();
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
    let historyRepair: Promise<void> | undefined;
    try {
      const initialized = await this.#client.initialize(signal);
      assertCodexCompatibility(initialized, this.#options.runtime);
      // Approval/question replay and resolution belong to these exact versions, not the older tuple.
      const nativeVersion = codexAppServerVersion(initialized.userAgent);
      this.#filesSupported = nativeVersion === "0.154.0";
      if (nativeVersion === "0.154.0") {
        this.#fileApprovals = new CodexFileApprovals(session, this.#options.threadId, this.#client);
      }
      if (nativeVersion === "0.153.4" || nativeVersion === "0.154.0") {
        this.#approvals = new CodexCommandApprovals(session, this.#options.threadId, this.#client);
        this.#questions = new CodexUserQuestions(session, this.#options.threadId, this.#client);
      }
      const resumed = await this.#client.resume(this.#options.threadId, signal);
      if (
        resumed.thread.id !== this.#options.threadId ||
        resumed.thread.canAcceptDirectInput !== true ||
        resumed.thread.status.type === "notLoaded" ||
        resumed.thread.status.type === "systemError"
      ) {
        throw new CodexProjectionError("Codex thread is not writable");
      }

      if (nativeVersion === "0.154.0") {
        try {
          const [models, collaborationModes] = await Promise.all([
            this.#client.listModels(signal),
            this.#client.listCollaborationModes(signal),
          ]);
          const settings = parseSessionSettings({
            models,
            collaborationModes,
            current: resumed.settings ?? { model: null, effort: null, collaborationMode: null },
          });
          if (settings === null) throw new CodexAppServerError("Codex settings catalog is invalid");
          session.sessionSettings = settings;
          this.#settingsSupported = true;
        } catch {
          // Optional catalogs cannot turn a healthy conversation into a failed projection.
          this.#trace.warn("Codex settings catalog unavailable; settings remain native-only");
        }
      }

      const gate = new IdleGate(resumed.thread.status);
      const reconciler = new CodexReconciler(
        session,
        this.#mutations,
        this.#uploads,
        this.#options.projectionPreviewByteLimit,
        nativeVersion === "0.154.0",
        this.#filesSupported,
      );
      session.workerStatus = resumed.thread.status.type === "active" ? "running" : "idle";
      await this.#reconcileHistory(reconciler, resumed.thread.historyMode, signal);
      for (const inbound of this.#client.drainInbound()) {
        this.#acceptInbound(inbound, session, reconciler, gate, "startup");
      }
      const handle = bridge.start({
        title: resumed.thread.name
          ? `${resumed.thread.name} · ${this.#options.threadId}`
          : `Codex ${this.#options.threadId}`,
        cwd: this.#ctx.cwd,
        git: this.#ctx.git,
        capabilities: this.capabilities,
        harness: CODEX_HARNESS,
      });
      this.#trace.info("Codex thread attached");
      historyRepair = this.#historyRepairPump(
        session,
        reconciler,
        resumed.thread.historyMode,
        signal,
      );

      await withAbort(
        Promise.race([
          this.#capturePump(session, reconciler, gate, signal),
          this.#injectPump(session, signal),
          this.#browserTurnPump(session, gate, signal),
          historyRepair,
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
      this.#fileApprovals?.close();
      this.#client.close();
      await bridge.close("Codex companion exited");
      await Promise.allSettled([...terminalTasks, ...(historyRepair ? [historyRepair] : [])]);
    }
    return exitCode;
  }

  async #reconcileHistory(
    reconciler: CodexReconciler,
    historyMode: "legacy" | "paginated",
    signal: AbortSignal,
    repairTurnId?: string,
  ): Promise<void> {
    // Metadata must precede item reads: a later terminal observation cannot make earlier partial
    // bytes final. Legacy full-turn pages already carry their own turn status.
    const terminalTurns =
      historyMode === "paginated" && repairTurnId === undefined
        ? await this.#terminalHistoryTurns(signal)
        : null;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < HISTORY_PAGE_LIMIT; pageNo += 1) {
      const page = await withAbort(
        historyMode === "legacy"
          ? this.#client.listTurnItems(this.#options.threadId, cursor, signal)
          : this.#client.listItems(this.#options.threadId, cursor, signal, repairTurnId),
        signal,
      );
      throwIfAborted(signal);
      for (const entry of page.data) {
        if (repairTurnId !== undefined && entry.turnId !== repairTurnId) {
          if (historyMode === "paginated")
            throw new CodexProjectionError("Codex returned a different turn's repair history");
          continue; // Legacy has no turn-filtered pager; never project other turns during repair.
        }
        if (entry.item.type === "subAgentActivity" && !reconciler.tasksSupported) continue;
        if (entry.item.type === "agentMessage" || entry.item.type === "subAgentActivity") {
          if (historyMode === "legacy" && !isCodexTurnStatus(entry.turnStatus))
            throw new CodexProjectionError("Codex history has invalid turn status");
          const final =
            historyMode === "legacy"
              ? entry.turnStatus !== "inProgress"
              : repairTurnId !== undefined || terminalTurns?.has(entry.turnId) === true;
          if (!final) {
            if (repairTurnId !== undefined)
              throw new CodexProjectionError("Codex repaired turn is not terminal");
            this.#historyRepairs.defer(entry.turnId);
            continue;
          }
        }
        reconciler.accept(entry.turnId, entry.item);
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

  async #terminalHistoryTurns(signal: AbortSignal): Promise<Set<string>> {
    const terminal = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let count = 0;
    for (let pageNo = 0; pageNo < HISTORY_PAGE_LIMIT; pageNo++) {
      const page = await withAbort(
        this.#client.listTurnMetadata(this.#options.threadId, cursor, signal),
        signal,
      );
      throwIfAborted(signal);
      count += page.data.length;
      if (count > HISTORY_PAGE_LIMIT)
        throw new CodexProjectionError("Codex turn metadata exceeded its bound");
      for (const turn of page.data) {
        if (!isCodexTurnStatus(turn.status) || turn.id === "" || turn.id.length > 256)
          throw new CodexProjectionError("Codex history has invalid turn metadata");
        if (turn.status !== "inProgress") terminal.add(turn.id);
      }
      if (page.nextCursor === null) return terminal;
      if (page.nextCursor === "" || cursors.has(page.nextCursor))
        throw new CodexProjectionError("Codex turn metadata cursor cycled");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new CodexProjectionError("Codex turn metadata exceeded its page limit");
  }

  async #historyRepairPump(
    session: Session,
    reconciler: CodexReconciler,
    historyMode: "legacy" | "paginated",
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !session.closed) {
      const turnId = await this.#historyRepairs.shift(signal);
      if (turnId === undefined || signal.aborted || session.closed) return;
      await this.#reconcileHistory(reconciler, historyMode, signal, turnId);
    }
  }

  async #capturePump(
    session: Session,
    reconciler: CodexReconciler,
    gate: IdleGate,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const inbound of this.#client.inbound(signal)) {
      this.#acceptInbound(inbound, session, reconciler, gate, "runtime");
    }
  }

  #acceptInbound(
    inbound: CodexInbound,
    session: Session,
    reconciler: CodexReconciler,
    gate: IdleGate,
    phase: "startup" | "runtime",
  ): void {
    if (inbound.kind === "request") {
      this.#approvals?.observe(inbound.value);
      this.#fileApprovals?.observe(inbound.value);
      this.#questions?.observe(inbound.value);
      return;
    }
    const { method, params } = inbound.value;
    if (params.threadId !== this.#options.threadId) return;
    if (method === "item/started" || method === "item/agentMessage/delta") {
      reconciler.observeLive(method, params);
      return;
    }
    if (method === "thread/settings/updated") {
      if (!this.#settingsSupported || session.sessionSettings === null) return;
      const current = parseCodexCurrentSettings(params.threadSettings);
      if (current === null) return;
      const settings = parseSessionSettings({ ...session.sessionSettings, current });
      if (settings === null) return;
      session.sessionSettings = settings;
      if (this.#expectedSettings !== null && settingsConfirmed(this.#expectedSettings, current))
        this.#expectedSettings = null;
      session.wake();
      return;
    }
    if (method === "turn/completed") {
      const turn = record(params.turn);
      if (
        typeof turn?.id !== "string" ||
        turn.id === "" ||
        turn.id.length > 256 ||
        !isCodexTurnStatus(turn.status) ||
        turn.status === "inProgress"
      )
        throw new CodexProjectionError("Codex emitted invalid terminal turn metadata");
      this.#historyRepairs.complete(turn.id);
      reconciler.observeLive(method, params);
      return; // A terminal turn is not native idle and does not complete child/background work.
    }
    if (method === "serverRequest/resolved") {
      this.#approvals?.resolve(params);
      this.#fileApprovals?.resolve(params);
      this.#questions?.resolve(params);
      return;
    }
    if (method === "item/started") {
      this.#fileApprovals?.started(params);
      return;
    }
    if (method === "item/completed") {
      this.#fileApprovals?.completed(params);
      const item = record(params.item);
      if (
        typeof params.turnId !== "string" ||
        typeof item?.type !== "string" ||
        typeof item.id !== "string"
      ) {
        throw new CodexProjectionError("Codex emitted an invalid completed item");
      }
      reconciler.accept(params.turnId, item as CodexThreadItem);
      return;
    }
    if (method === "thread/status/changed") {
      const status = parseCodexStatus(params.status);
      if (status.type === "notLoaded" || (status.type === "systemError" && phase === "startup")) {
        throw new CodexProjectionError("Codex thread became unavailable");
      }
      // A native turn error can recover without losing this thread or connection. Keep capture live,
      // but systemError is not idle: only a later native idle may release queued browser input.
      gate.update(status);
      session.workerStatus = status.type === "active" ? "running" : status.type;
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

  async #browserTurnPump(session: Session, gate: IdleGate, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !session.closed) {
      const event = await this.#browserTurns.shift(signal);
      if (event === undefined || signal.aborted || session.closed) return;
      if (event.eventType === "user") await this.#injectText(session, event, gate, signal);
      else await this.#updateSettings(session, event, signal);
    }
  }

  async #injectPump(session: Session, signal: AbortSignal): Promise<void> {
    const generation = session.claimWorkerStream();
    for await (const event of session.followDownstream(generation, () => signal.aborted)) {
      if (signal.aborted || session.closed) return;
      if (event === null) continue;
      if (event.eventType === "user") {
        this.#browserTurns.push(event);
        continue;
      }
      if (event.eventType === "control_request") {
        const request = record(event.payload.request);
        if (request?.subtype === "set_session_settings") {
          this.#browserTurns.push(event);
          continue;
        }
        if (request?.subtype === "interrupt") await this.#interruptCurrent(session, signal);
        // Initialize and every other control remain local no-ops.
      }
      if (event.eventType === "control_response") {
        this.#approvals?.respond(event.payload, signal);
        this.#fileApprovals?.respond(event.payload, signal);
        this.#questions?.respond(event.payload, signal);
      }
      session.ack(event.eventId);
    }
  }

  async #updateSettings(session: Session, event: RcEvent, signal: AbortSignal): Promise<void> {
    try {
      const request = record(event.payload.request);
      if (!this.#settingsSupported || session.sessionSettings === null || request === null) return;
      if (this.#expectedSettings !== null) {
        this.#trace.warn("Codex settings choice dropped: prior update lacks native confirmation");
        return;
      }
      const update = codexSettingsUpdate(request.change, session.sessionSettings);
      // A settings choice may have waited behind a browser turn. Re-check current native choices and
      // expiry here, immediately before the one RPC, rather than using admission-time values.
      if (
        update === null ||
        typeof request.expiry !== "number" ||
        !Number.isFinite(request.expiry) ||
        request.expiry <= Date.now() ||
        signal.aborted ||
        session.closed
      )
        return;
      if (settingsConfirmed(update, session.sessionSettings.current)) return;
      // Set before invoking the client: the matching native notification may precede its response.
      this.#expectedSettings = update;
      try {
        await this.#client.updateSettings(this.#options.threadId, update, signal);
      } catch {
        // No retry: a timeout can mean the update already applied. Preserve only native-confirmed
        // state and keep observing this healthy conversation; the viewer's waiting label expires.
        if (!signal.aborted && !session.closed)
          this.#trace.warn("Codex settings update not confirmed");
      }
    } finally {
      session.ack(event.eventId);
    }
  }

  async #interruptCurrent(session: Session, signal: AbortSignal): Promise<void> {
    const turnId = await this.#client.activeTurn(this.#options.threadId, signal);
    if (signal.aborted || session.closed || turnId === null || turnId === this.#lastInterruptedTurn)
      return;
    this.#lastInterruptedTurn = turnId;
    await this.#client.interruptTurn(this.#options.threadId, turnId, signal);
    // RPC acceptance is not completion. Only native status can release queued text or show idle.
  }

  async #injectText(
    session: Session,
    event: RcEvent,
    gate: IdleGate,
    signal: AbortSignal,
  ): Promise<void> {
    const message = record(event.payload.message);
    let text = typeof message?.content === "string" ? message.content : "";
    if (text.trim() === "" || text.trimStart().startsWith("/")) {
      throw new CodexProjectionError("unsupported browser text reached the Codex writer");
    }
    const clientMsgId = event.payload.client_msg_id;
    if (clientMsgId !== undefined && typeof clientMsgId !== "string") {
      throw new CodexProjectionError("browser mutation carried an invalid client coordinate");
    }
    if (this.#mutations.size >= CODEX_HISTORY_ITEM_LIMIT || this.#mutations.has(event.eventId)) {
      throw new CodexProjectionError("Codex browser coordinate limit or reuse");
    }
    if (session.closed) return;
    let prepared: Awaited<ReturnType<NativeUploadStore["prepare"]>> | undefined;
    let attempted = false;
    try {
      if (event.files !== undefined) {
        if (!this.#filesSupported)
          throw new CodexProjectionError("native file input is unsupported");
        prepared = await this.#uploads.prepare(event.files, text, signal);
        text = prepared.text;
      }
      // Claim idle once, after asynchronous file preparation. Closure can precede bridge teardown,
      // so recheck the fence immediately before the irreversible native write.
      await gate.wait(signal);
      if (signal.aborted || session.closed) return;
      const mutation: BrowserMutation = {
        inputDigest: browserInputDigest(text, event.images ?? []),
        ...(typeof clientMsgId === "string" ? { clientMsgId } : {}),
        itemCoordinate: null,
        correlated: Promise.withResolvers<void>(),
      };
      this.#mutations.set(event.eventId, mutation);
      attempted = true;
      await this.#client.startTurn(
        this.#options.threadId,
        event.eventId,
        text,
        signal,
        event.images,
      );
      session.releaseImages(event);
      await waitForCorrelation(mutation.correlated.promise, signal);
      throwIfAborted(signal);
      session.ack(event.eventId);
    } catch (error) {
      if (signal.aborted || session.closed) return;
      throw new CodexProjectionError(
        error instanceof CodexProjectionError
          ? error.message
          : "Codex input outcome is unknown; projection fenced",
      );
    } finally {
      session.releaseImages(event);
      if (!attempted) await prepared?.discard();
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
