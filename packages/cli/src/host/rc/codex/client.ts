import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import NodeWebSocket from "ws";
import {
  isLikelyBase64,
  MAX_ATTACHMENT_B64,
  MAX_ATTACHMENT_IMAGES,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from "../relay.js";
import type { HostImage } from "../session.js";

const REQUEST_TIMEOUT_MS = 15_000;
const CODEX_UNIX_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export const CODEX_APP_SERVER_VERSION = "0.151.0";
export const CODEX_APP_SERVER_VERSIONS = [CODEX_APP_SERVER_VERSION, "0.153.4"] as const;
export const CODEX_APP_SERVER_REQUIREMENT = `Codex app-server ${CODEX_APP_SERVER_VERSIONS.join(" or ")} on Linux arm64`;
export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";
export const CODEX_HISTORY_ITEM_LIMIT = 10_000;
// Native history preserves inline image bytes. One item/turn avoids combining multiple accepted
// image groups into a response larger than the managed socket's transport limit.
export const CODEX_LEGACY_TURN_PAGE_LIMIT = 1;

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

export type CodexRequestId = string | number;

export interface CodexServerRequest {
  id: CodexRequestId;
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
    historyMode: "legacy" | "paginated";
  };
}

export interface CodexItemsPage {
  data: Array<{ turnId: string; item: CodexThreadItem }>;
  nextCursor: string | null;
}

/** Only explicitly selected, observed command approvals and supported native input forms can receive
 * responses. There is no generic result/error or policy-changing response API. */
export interface CodexClient {
  initialize(signal: AbortSignal): Promise<CodexInitializeResult>;
  resume(threadId: string, signal: AbortSignal): Promise<CodexResumeResult>;
  listItems(
    threadId: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<CodexItemsPage>;
  listTurnItems(
    threadId: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<CodexItemsPage>;
  startTurn(
    threadId: string,
    clientUserMessageId: string,
    text: string,
    signal: AbortSignal,
    images?: ReadonlyArray<HostImage>,
  ): Promise<void>;
  activeTurn(threadId: string, signal: AbortSignal): Promise<string | null>;
  interruptTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<void>;
  respondCommandApproval(
    request: CodexServerRequest,
    decision: "accept" | "decline" | "cancel",
    signal: AbortSignal,
  ): boolean;
  respondUserInput(
    request: CodexServerRequest,
    answers: Record<string, { answers: string[] }>,
    signal: AbortSignal,
  ): boolean;
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

function defaultControlSocketPath(): string {
  const configured = (process.env.CODEX_HOME ?? "").trim();
  const codexHome = configured === "" ? join(homedir(), ".codex") : configured;
  return join(codexHome, "app-server-control", "app-server-control.sock");
}

function createSocket(url: string): SocketLike {
  if (url !== "unix://") return new WebSocket(url);
  // The managed daemon's Unix upgrader intentionally does not negotiate extensions. `ws` lets us
  // suppress permessage-deflate (which Node's built-in WebSocket always offers) and supply the
  // same private control socket used by `codex resume --remote unix://`.
  return new NodeWebSocket("ws://localhost/", {
    createConnection: () => createConnection(defaultControlSocketPath()),
    handshakeTimeout: REQUEST_TIMEOUT_MS,
    maxPayload: CODEX_UNIX_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  }) as unknown as SocketLike;
}

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

/** Retain only a fixed-size identity after resolution. Object-key order is not native identity. */
function requestFingerprint(request: CodexServerRequest): string {
  const canonical = JSON.stringify([request.method, request.params], (_key, value: unknown) => {
    const object = record(value);
    return object === null
      ? value
      : Object.fromEntries(
          Object.keys(object)
            .sort()
            .map((key) => [key, object[key]]),
        );
  });
  return createHash("sha256").update(canonical).digest("hex");
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

/** Accept only Codex's literal managed-socket shorthand or an explicit-port loopback WebSocket
 * origin. No arbitrary socket path, credentials, query, or fragment can redirect the companion. */
export function normalizeCodexAppServerUrl(raw: string): string {
  // The literal shorthand resolves only Codex's same-user managed control socket. Deliberately do
  // not accept arbitrary unix:/// paths: the companion remains attach-only and cannot be turned
  // into a local socket scanner.
  if (raw === "unix://") return raw;
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

/** A tiny JSON-RPC client with one-shot replies for observed command approvals and input forms. Native
 * serverRequest/resolved, not a socket write, owns resolution of the first-response-wins race. */
export class CodexAppServerClient implements CodexClient {
  readonly #url: string;
  readonly #socketFactory: SocketFactory;
  #socket: SocketLike | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #serverRequests = new Map<
    CodexRequestId,
    { fingerprint: string; threadId: string | null }
  >();
  readonly #liveServerRequests = new Map<CodexRequestId, CodexServerRequest>();
  readonly #queue: CodexInbound[] = [];
  #wake = Promise.withResolvers<void>();
  #closed = false;

  constructor(url: string, socketFactory: SocketFactory = createSocket) {
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
      (thread.canAcceptDirectInput !== null && typeof thread.canAcceptDirectInput !== "boolean") ||
      (thread.historyMode !== "legacy" && thread.historyMode !== "paginated")
    ) {
      throw new CodexAppServerError("Codex returned an invalid resumed thread");
    }
    return {
      thread: {
        id: thread.id,
        status: parseCodexStatus(thread.status),
        canAcceptDirectInput: thread.canAcceptDirectInput,
        historyMode: thread.historyMode,
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
        { threadId, limit: 1, sortDirection: "asc", ...(cursor ? { cursor } : {}) },
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
      if (
        item.type === "userMessage" ||
        item.type === "agentMessage" ||
        item.type === "commandExecution"
      ) {
        data.push({ turnId: entry.turnId, item: item as CodexThreadItem });
      }
    }
    return { data, nextCursor: result.nextCursor };
  }

  async listTurnItems(
    threadId: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<CodexItemsPage> {
    const result = record(
      await this.#request(
        "thread/turns/list",
        {
          threadId,
          limit: CODEX_LEGACY_TURN_PAGE_LIMIT,
          sortDirection: "asc",
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
        },
        signal,
      ),
    );
    if (
      !Array.isArray(result?.data) ||
      (result.nextCursor !== null && typeof result.nextCursor !== "string")
    ) {
      throw new CodexAppServerError("Codex returned an invalid turn page");
    }
    const data: CodexItemsPage["data"] = [];
    for (const value of result.data) {
      const turn = record(value);
      if (typeof turn?.id !== "string" || !Array.isArray(turn.items)) {
        throw new CodexAppServerError("Codex returned an invalid full turn");
      }
      for (const rawItem of turn.items) {
        const item = record(rawItem);
        if (typeof item?.type !== "string" || typeof item.id !== "string") {
          throw new CodexAppServerError("Codex returned an invalid full turn item");
        }
        if (
          item.type === "userMessage" ||
          item.type === "agentMessage" ||
          item.type === "commandExecution"
        ) {
          data.push({ turnId: turn.id, item: item as CodexThreadItem });
        }
      }
    }
    return { data, nextCursor: result.nextCursor };
  }

  async startTurn(
    threadId: string,
    clientUserMessageId: string,
    text: string,
    signal: AbortSignal,
    images: ReadonlyArray<HostImage> = [],
  ): Promise<void> {
    if (!Array.isArray(images) || images.length > MAX_ATTACHMENT_IMAGES) {
      throw new CodexAppServerError("Codex received invalid host-prepared images");
    }
    let imageBytes = 0;
    const imageInput = images.map((image) => {
      const url = image?.url;
      const prefix =
        typeof url === "string" ? /^data:image\/(?:png|jpeg|webp|gif);base64,/.exec(url) : null;
      if (typeof url !== "string" || prefix === null) {
        throw new CodexAppServerError("Codex received invalid host-prepared images");
      }
      imageBytes += url.length;
      if (
        imageBytes > MAX_ATTACHMENT_TOTAL_BYTES ||
        url.length - prefix[0].length > MAX_ATTACHMENT_B64 ||
        !isLikelyBase64(url.slice(prefix[0].length))
      ) {
        throw new CodexAppServerError("Codex received invalid host-prepared images");
      }
      // Only relay-prepared inline bytes cross this boundary, never paths, remote URLs or policy.
      return { type: "image" as const, url };
    });
    const result = record(
      await this.#request(
        "turn/start",
        {
          threadId,
          clientUserMessageId,
          input: [{ type: "text", text, text_elements: [] }, ...imageInput],
        },
        signal,
      ),
    );
    if (record(result?.turn) === null) {
      throw new CodexAppServerError("Codex returned an invalid turn response");
    }
  }

  /** Read only the latest turn's metadata, including an already-running turn when we attached. */
  async activeTurn(threadId: string, signal: AbortSignal): Promise<string | null> {
    const result = record(
      await this.#request(
        "thread/turns/list",
        { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
        signal,
      ),
    );
    if (!Array.isArray(result?.data) || result.data.length > 1) {
      throw new CodexAppServerError("Codex returned invalid active-turn metadata");
    }
    if (result.data.length === 0) return null;
    const turn = record(result.data[0]);
    if (
      typeof turn?.id !== "string" ||
      turn.id === "" ||
      typeof turn.status !== "string" ||
      !["inProgress", "completed", "interrupted", "failed"].includes(turn.status)
    ) {
      throw new CodexAppServerError("Codex returned invalid active-turn metadata");
    }
    return turn.status === "inProgress" ? turn.id : null;
  }

  /** The pinned native servers reject stale turn IDs atomically. Never retarget or retry. */
  async interruptTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<void> {
    let result: unknown;
    try {
      result = await this.#request("turn/interrupt", { threadId, turnId }, signal);
    } catch (error) {
      // Measured on both pinned versions: no active turn / mismatched target is Invalid Request.
      // This explicit rejection is a no-op, not permission to interrupt a newer turn.
      if (error instanceof CodexAppServerError && error.rpcCode === -32600) return;
      throw error;
    }
    const response = record(result);
    if (response === null || Object.keys(response).length !== 0) {
      throw new CodexAppServerError("Codex returned an invalid interrupt response");
    }
  }

  /** True means one submission was attempted, never that this client's choice won. The exact
   * connection-owned request object is required; consumed/resolved requests cannot be revived. */
  respondCommandApproval(
    request: CodexServerRequest,
    decision: "accept" | "decline" | "cancel",
    signal: AbortSignal,
  ): boolean {
    return this.#respondToRequest(request, "item/commandExecution/requestApproval", signal, () => {
      const available = request.params.availableDecisions;
      if (
        (decision !== "accept" && decision !== "decline" && decision !== "cancel") ||
        (available !== undefined &&
          available !== null &&
          (!Array.isArray(available) || !available.includes(decision)))
      ) {
        throw new CodexAppServerError("unsupported Codex command approval response");
      }
      return { decision };
    });
  }

  /** The host form adapter validates offered choices. Copy only bounded answer envelopes here;
   * extra viewer fields cannot become native configuration or a different response family. */
  respondUserInput(
    request: CodexServerRequest,
    answers: Record<string, { answers: string[] }>,
    signal: AbortSignal,
  ): boolean {
    return this.#respondToRequest(request, "item/tool/requestUserInput", signal, () => {
      const entries = Object.entries(record(answers) ?? {});
      if (entries.length < 1 || entries.length > 3) {
        throw new CodexAppServerError("unsupported Codex user input response");
      }
      const prepared = entries.map(([id, answer]) => {
        const values = record(answer)?.answers;
        const value = Array.isArray(values) && values.length === 1 ? values[0] : undefined;
        if (
          id.trim() === "" ||
          id.length > 256 ||
          typeof value !== "string" ||
          value.trim() === "" ||
          value.length > 16_384
        ) {
          throw new CodexAppServerError("unsupported Codex user input response");
        }
        return [id, { answers: [value] }];
      });
      return { answers: Object.fromEntries(prepared) };
    });
  }

  #respondToRequest(
    request: CodexServerRequest,
    method: "item/commandExecution/requestApproval" | "item/tool/requestUserInput",
    signal: AbortSignal,
    result: () => Record<string, unknown>,
  ): boolean {
    if (signal.aborted) throw aborted();
    if (
      record(request) === null ||
      this.#closed ||
      this.#liveServerRequests.get(request.id) !== request
    ) {
      return false;
    }
    const label = method === "item/tool/requestUserInput" ? "user input" : "command approval";
    if (
      this.#serverRequests.get(request.id)?.fingerprint !== requestFingerprint(request) ||
      request.method !== method
    ) {
      throw new CodexAppServerError(`unsupported Codex ${label} response`);
    }
    const response = result();
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new CodexAppServerError("Codex app-server is not connected");
    }
    // Consume before the irreversible write, including a write that throws after partial delivery.
    this.#liveServerRequests.delete(request.id);
    try {
      socket.send(JSON.stringify({ id: request.id, result: response }));
    } catch {
      this.#protocolFailure();
      throw new CodexAppServerError(`Codex ${label} submission failed`);
    }
    return true;
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
    this.#clearServerRequests();
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
    if (this.#closed) return;
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
    if (message.id !== undefined && !isRequestId(message.id)) {
      this.#protocolFailure();
      return;
    }
    if (typeof message.id === "number" && typeof message.method !== "string") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const code = record(message.error)?.code;
        pending.reject(
          new CodexAppServerError(
            `Codex ${pending.method} failed`,
            typeof code === "number" && Number.isSafeInteger(code) ? code : undefined,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const params = record(message.params) ?? {};
    if (message.id !== undefined) {
      const request: CodexServerRequest = { id: message.id, method: message.method, params };
      let fingerprint: string;
      try {
        fingerprint = requestFingerprint(request);
      } catch {
        this.#protocolFailure();
        return;
      }
      const existing = this.#serverRequests.get(request.id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          this.#protocolFailure();
          return;
        }
        const live = this.#liveServerRequests.get(request.id);
        if (live !== undefined) {
          this.#queue.push({ kind: "request", value: live });
        }
      } else {
        if (this.#serverRequests.size >= CODEX_HISTORY_ITEM_LIMIT) {
          this.#protocolFailure();
          return;
        }
        this.#serverRequests.set(request.id, {
          fingerprint,
          threadId: typeof params.threadId === "string" ? params.threadId : null,
        });
        this.#liveServerRequests.set(request.id, request);
        this.#queue.push({ kind: "request", value: request });
      }
    } else {
      if (message.method === "serverRequest/resolved") {
        if (!isRequestId(params.requestId)) {
          this.#protocolFailure();
          return;
        }
        const request = this.#serverRequests.get(params.requestId);
        if (request !== undefined && request.threadId === params.threadId) {
          this.#liveServerRequests.delete(params.requestId);
        }
      }
      this.#queue.push({ kind: "notification", value: { method: message.method, params } });
    }
    this.#releaseQueue();
  };

  readonly #onClose = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearServerRequests();
    this.#rejectPending(new CodexAppServerError("Codex app-server connection closed"));
    this.#releaseQueue();
  };

  #protocolFailure(): void {
    this.#closed = true;
    this.#clearServerRequests();
    this.#socket?.close();
    this.#rejectPending(new CodexAppServerError("Codex app-server protocol error"));
    this.#releaseQueue();
  }

  #clearServerRequests(): void {
    this.#serverRequests.clear();
    this.#liveServerRequests.clear();
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

/** The first subscriber supplies the product name, which can contain spaces ("Codex Desktop").
 * Only that leading product's version counts; never fall through to a later codex-cli token. */
export function codexAppServerVersion(userAgent: string): string | null {
  return /^[^\s/]+(?: [^\s/]+)*\/([^\s/]+)(?:\s|$)/.exec(userAgent)?.[1] ?? null;
}

export function assertCodexCompatibility(
  result: CodexInitializeResult,
  runtime: Readonly<{ platform: NodeJS.Platform; arch: string }> = process,
): void {
  const serverVersion = codexAppServerVersion(result.userAgent);
  if (
    runtime.platform !== "linux" ||
    runtime.arch !== "arm64" ||
    result.platformFamily !== "unix" ||
    result.platformOs !== "linux" ||
    !CODEX_APP_SERVER_VERSIONS.some((version) => version === serverVersion)
  ) {
    throw new CodexAppServerError(`requires ${CODEX_APP_SERVER_REQUIREMENT}`);
  }
}
