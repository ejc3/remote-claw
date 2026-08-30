const REQUEST_TIMEOUT_MS = 15_000;

export const CODEX_APP_SERVER_VERSION = "0.151.0";
export const CODEX_APP_SERVER_REQUIREMENT = `Codex app-server ${CODEX_APP_SERVER_VERSION} on Linux arm64`;
export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";

export interface CodexThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: string[];
}

export interface CodexThreadItem {
  type: string;
  id: string;
  clientId?: string | null;
  content?: unknown[];
  text?: string;
  [key: string]: unknown;
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexServerRequest {
  method: string;
  params: Record<string, unknown>;
}

export type CodexInbound =
  | { kind: "notification"; value: CodexNotification }
  | { kind: "request"; value: CodexServerRequest };

export interface CodexInitializeResult {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexResumeResult {
  thread: {
    id: string;
    status: CodexThreadStatus;
    canAcceptDirectInput: boolean | null;
  };
}

export interface CodexItemsPage {
  data: Array<{ turnId: string; item: CodexThreadItem }>;
  nextCursor: string | null;
}

/** The driver-facing surface deliberately has no server-request response method. This makes the
 * companion structurally unable to win Codex's first-response-wins approval/question race. */
export interface CodexClient {
  initialize(signal: AbortSignal): Promise<CodexInitializeResult>;
  resume(threadId: string, signal: AbortSignal): Promise<CodexResumeResult>;
  listItems(
    threadId: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<CodexItemsPage>;
  startTurn(
    threadId: string,
    clientUserMessageId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
  drainInbound(): CodexInbound[];
  inbound(signal: AbortSignal): AsyncGenerator<CodexInbound>;
  close(): void;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
}

type SocketFactory = (url: string) => SocketLike;

export class CodexAppServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function aborted(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([operation, cancellation]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

export function parseCodexStatus(value: unknown): CodexThreadStatus {
  const status = record(value);
  const type = status?.type;
  if (type !== "notLoaded" && type !== "idle" && type !== "systemError" && type !== "active") {
    throw new CodexAppServerError("Codex returned an invalid thread status");
  }
  if (type !== "active") return { type };
  const activeFlags = status?.activeFlags;
  if (!Array.isArray(activeFlags) || !activeFlags.every((flag) => typeof flag === "string")) {
    throw new CodexAppServerError("Codex returned invalid active flags");
  }
  return { type, activeFlags };
}

export function isCodexThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

/** Accept only a literal, explicit-port loopback WebSocket origin. No path, credentials, query, or
 * fragment means a hostile URL cannot turn the companion into a network client or leak via routing. */
export function normalizeCodexAppServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CodexAppServerError("invalid Codex app-server URL");
  }
  if (
    url.protocol !== "ws:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CodexAppServerError("Codex app-server URL must be an explicit loopback ws origin");
  }
  return url.origin;
}

/** A tiny JSON-RPC client for the exact app-server methods M3a needs. Server requests are queued for
 * observation only and can never receive a result OR an error from this client. */
export class CodexAppServerClient implements CodexClient {
  readonly #url: string;
  readonly #socketFactory: SocketFactory;
  #socket: SocketLike | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #queue: CodexInbound[] = [];
  #wake = Promise.withResolvers<void>();
  #closed = false;

  constructor(url: string, socketFactory: SocketFactory = (value) => new WebSocket(value)) {
    this.#url = normalizeCodexAppServerUrl(url);
    this.#socketFactory = socketFactory;
  }

  async initialize(signal: AbortSignal): Promise<CodexInitializeResult> {
    if (this.#socket !== null) throw new CodexAppServerError("Codex client is already initialized");
    const socket = this.#socketFactory(this.#url);
    this.#socket = socket;
    socket.addEventListener("message", this.#onMessage as EventListener);
    socket.addEventListener("close", this.#onClose as EventListener, { once: true });
    await withAbort(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new CodexAppServerError("could not connect to Codex app-server")),
          { once: true },
        );
      }),
      signal,
    );
    const result = record(
      await this.#request(
        "initialize",
        {
          clientInfo: { name: "remote-claw-codex", title: "remote-claw", version: "0.0.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: null,
            extensions: null,
          },
        },
        signal,
      ),
    );
    if (
      typeof result?.userAgent !== "string" ||
      typeof result.platformFamily !== "string" ||
      typeof result.platformOs !== "string"
    ) {
      throw new CodexAppServerError("Codex returned an invalid initialize response");
    }
    this.#notify("initialized");
    return {
      userAgent: result.userAgent,
      platformFamily: result.platformFamily,
      platformOs: result.platformOs,
    };
  }

  async resume(threadId: string, signal: AbortSignal): Promise<CodexResumeResult> {
    const result = record(
      await this.#request("thread/resume", { threadId, excludeTurns: true }, signal),
    );
    const thread = record(result?.thread);
    if (
      !isCodexThreadId(thread?.id) ||
      (thread.canAcceptDirectInput !== null && typeof thread.canAcceptDirectInput !== "boolean")
    ) {
      throw new CodexAppServerError("Codex returned an invalid resumed thread");
    }
    return {
      thread: {
        id: thread.id,
        status: parseCodexStatus(thread.status),
        canAcceptDirectInput: thread.canAcceptDirectInput,
      },
    };
  }

  async listItems(
    threadId: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<CodexItemsPage> {
    const result = record(
      await this.#request(
        "thread/items/list",
        { threadId, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) },
        signal,
      ),
    );
    if (
      !Array.isArray(result?.data) ||
      (result.nextCursor !== null && typeof result.nextCursor !== "string")
    ) {
      throw new CodexAppServerError("Codex returned an invalid item page");
    }
    const data: CodexItemsPage["data"] = [];
    for (const value of result.data) {
      const entry = record(value);
      const item = record(entry?.item);
      if (
        typeof entry?.turnId !== "string" ||
        typeof item?.type !== "string" ||
        typeof item.id !== "string"
      ) {
        throw new CodexAppServerError("Codex returned an invalid thread item");
      }
      data.push({ turnId: entry.turnId, item: item as CodexThreadItem });
    }
    return { data, nextCursor: result.nextCursor };
  }

  async startTurn(
    threadId: string,
    clientUserMessageId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = record(
      await this.#request(
        "turn/start",
        {
          threadId,
          clientUserMessageId,
          input: [{ type: "text", text, text_elements: [] }],
        },
        signal,
      ),
    );
    if (record(result?.turn) === null) {
      throw new CodexAppServerError("Codex returned an invalid turn response");
    }
  }

  async *inbound(signal: AbortSignal): AsyncGenerator<CodexInbound> {
    for (;;) {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift();
        if (next !== undefined) yield next;
      }
      if (signal.aborted) return;
      if (this.#closed) throw new CodexAppServerError("Codex app-server connection closed");
      const wake = this.#wake.promise;
      await withAbort(wake, signal);
    }
  }

  drainInbound(): CodexInbound[] {
    return this.#queue.splice(0);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.close();
    this.#releaseQueue();
    this.#rejectPending(new CodexAppServerError("Codex client closed"));
  }

  #request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(aborted());
    const socket = this.#socket;
    if (socket === null || this.#closed || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CodexAppServerError("Codex app-server is not connected"));
    }
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexAppServerError(`Codex ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer === "object") timer.unref();
      this.#pending.set(id, { method, resolve, reject, timer });
      socket.send(JSON.stringify({ method, id, params }));
    });
    return withAbort(response, signal).finally(() => {
      if (!signal.aborted) return;
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
    });
  }

  #notify(method: string): void {
    const socket = this.#socket;
    if (socket === null || this.#closed || socket.readyState !== WebSocket.OPEN) {
      throw new CodexAppServerError("Codex app-server is not connected");
    }
    socket.send(JSON.stringify({ method }));
  }

  readonly #onMessage = (event: MessageEvent): void => {
    let message: Record<string, unknown> | null = null;
    try {
      const body = typeof event.data === "string" ? event.data : "";
      message = record(JSON.parse(body));
    } catch {
      // Malformed JSON makes subsequent request ownership unknowable. Fence this projection.
    }
    if (message === null) {
      this.#protocolFailure();
      return;
    }
    if (typeof message.id === "number" && typeof message.method !== "string") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new CodexAppServerError(`Codex ${pending.method} failed`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const params = record(message.params) ?? {};
    this.#queue.push(
      message.id !== undefined
        ? { kind: "request", value: { method: message.method, params } }
        : { kind: "notification", value: { method: message.method, params } },
    );
    this.#releaseQueue();
  };

  readonly #onClose = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new CodexAppServerError("Codex app-server connection closed"));
    this.#releaseQueue();
  };

  #protocolFailure(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#rejectPending(new CodexAppServerError("Codex app-server protocol error"));
    this.#releaseQueue();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #releaseQueue(): void {
    const wake = this.#wake;
    this.#wake = Promise.withResolvers<void>();
    wake.resolve();
  }
}

export function assertCodexCompatibility(
  result: CodexInitializeResult,
  runtime: Readonly<{ platform: NodeJS.Platform; arch: string }> = process,
): void {
  // app-server's leading product name belongs to the first initialized subscriber and is shared by
  // later subscribers. The version after its final slash is the server version; never pin that
  // unrelated client name to this companion's name.
  const serverProduct = result.userAgent.split(" ", 1)[0] ?? "";
  const slash = serverProduct.lastIndexOf("/");
  const serverVersion = slash === -1 ? "" : serverProduct.slice(slash + 1);
  if (
    runtime.platform !== "linux" ||
    runtime.arch !== "arm64" ||
    result.platformFamily !== "unix" ||
    result.platformOs !== "linux" ||
    serverVersion !== CODEX_APP_SERVER_VERSION
  ) {
    throw new CodexAppServerError(`requires ${CODEX_APP_SERVER_REQUIREMENT}`);
  }
}
