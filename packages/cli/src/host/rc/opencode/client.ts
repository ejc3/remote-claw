// A typed, dependency-free wrapper over the OpenCode HTTP+SSE server (`opencode serve`, an Effect
// HttpApi). It uses the global `fetch` (Node 22) — no `@opencode-ai/sdk` dep, since the surface we need
// is small and the SDK isn't installed. Shapes verified against the live server's GET /doc (OpenAPI) and
// by curling `opencode serve` on 127.0.0.1:4096:
//   POST /session                                  → { id: "ses_…", … }
//   POST /session/{id}/prompt_async {parts, model} → HTTP 204 (EMPTY body — never JSON-parse it)
//   POST /session/{id}/abort                       → 200 (boolean)
//   GET  /event                                    → server-wide SSE: data: {id,type,properties}
//   POST /permission/{requestID}/reply {reply:"once"|"always"|"reject"} → 200 (boolean)

import type { Part } from "./translate.js";

export const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";
export const SUPPORTED_OPENCODE_VERSION = "1.17.5";
export const OPENCODE_HISTORY_LIMIT = 4096;
const OPENCODE_SSE_BUFFER_LIMIT = 1024 * 1024;

/**
 * Canonicalize the only supported server trust boundary. A hostname that happens to resolve to
 * loopback is not equivalent: DNS, URL credentials, paths, and redirects would all widen the local
 * authority this companion is allowed to reach.
 */
export function normalizeOpencodeBaseUrl(value: string): string {
  // Match the raw authority rather than relying on URL.port: the WHATWG parser erases an explicit
  // default `:80`, which would make it indistinguishable from the forbidden missing-port spelling.
  // A whole-string literal match also rejects the parser's otherwise-helpful whitespace trimming,
  // DNS names, credentials, and non-root URL components before any network request is possible.
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/.exec(value);
  const port = match === null ? Number.NaN : Number(match[2]);
  if (
    match === null ||
    match[0] !== value ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      "OpenCode URL must be http://127.0.0.1:<port>/ or http://[::1]:<port>/ with no credentials, path, query, or fragment",
    );
  }
  return `http://${match[1]}:${port}`;
}

/** One server-wide SSE frame. `properties.sessionID` is how a single-session driver filters the global
 *  stream (GET /event carries EVERY session's events). `properties.part`/`info` are event-specific. */
export interface OpencodeEvent {
  id?: string;
  type: string;
  properties: {
    sessionID?: string;
    part?: Part & { messageID?: string; sessionID?: string };
    info?: {
      id?: string;
      sessionID?: string;
      role?: string;
      time?: { completed?: number };
      [k: string]: unknown;
    };
    /** OpenCode 1.17.5 removal events carry coordinates directly on properties, not in `part`. */
    messageID?: string;
    partID?: string;
    status?: { type?: string };
    /** permission.asked: the gate id (`per…`), the tool name (`permission`), its metadata + the tool
     *  call it gates. permission.replied: `requestID` + `reply`. (Per the OpenAPI EventPermission*.) */
    id?: string;
    permission?: string;
    metadata?: Record<string, unknown>;
    patterns?: string[];
    tool?: { messageID?: string; callID?: string };
    requestID?: string;
    reply?: string;
    [k: string]: unknown;
  };
}

/** The OpenCode model selector for prompt_async (providerID + modelID, e.g.
 *  amazon-bedrock / global.anthropic.claude-sonnet-4-6). */
export interface OpencodeModel {
  providerID: string;
  modelID: string;
}

/** OpenCode's active-run status. The 1.17.5 status map normally represents idle by omission, but the
 * public schema also permits an explicit idle value, so the client accepts both spellings. */
export type OpencodeSessionStatus = "idle" | "busy" | "retry";

/** One OpenCode permission rule (PermissionRule in the OpenAPI). `permission` is a tool/category glob
 *  ("*" = every tool, "bash", "edit", …), `pattern` matches the tool's argument ("*" = any), and `action`
 *  is ask|allow|deny. Used to flip a session into "ask" mode so each tool raises a `permission.asked`
 *  gate (verified live: a single {permission:"*",pattern:"*",action:"ask"} rule gates ALL tools). */
export interface PermissionRule {
  permission: string;
  pattern: string;
  action: "ask" | "allow" | "deny";
}

/** OpenCode 1.17.5 native session IDs use this exact retained-proof shape. */
export function isOpencodeSessionId(value: unknown): value is string {
  return typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value);
}

/** OpenCode 1.17.5 native message IDs. Release prompts let OpenCode mint these in its own order. */
export function isOpencodeMessageId(value: unknown): value is string {
  return typeof value === "string" && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}

/** OpenCode 1.17.5 part IDs, including caller-selected `prt_rc_*` correlation markers. */
export function isOpencodePartId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value) || /^prt_rc_[0-9a-f]{32}$/.test(value))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the message fields consumed by reconciliation and live projection. When a session is
 * supplied, the native payload must carry that exact identity; absence is not treated as a match.
 */
export function isValidOpencodeMessageInfo(
  value: unknown,
  expectedSessionId?: string,
): value is HistoryMessage["info"] & { sessionID?: string } {
  if (!isPlainRecord(value)) return false;
  if (!isOpencodeMessageId(value.id) || (value.role !== "user" && value.role !== "assistant")) {
    return false;
  }
  if (value.role === "assistant") {
    if (!isOpencodeMessageId(value.parentID)) return false;
  } else if (value.parentID !== undefined && !isOpencodeMessageId(value.parentID)) {
    return false;
  }
  if (expectedSessionId !== undefined) {
    if (!isOpencodeSessionId(expectedSessionId) || value.sessionID !== expectedSessionId)
      return false;
  } else if (value.sessionID !== undefined && !isOpencodeSessionId(value.sessionID)) {
    return false;
  }
  if (value.time === undefined) return true;
  if (!isPlainRecord(value.time)) return false;
  return (
    value.time.completed === undefined ||
    (typeof value.time.completed === "number" && Number.isFinite(value.time.completed))
  );
}

const OPENCODE_TOOL_STATUSES = new Set(["pending", "running", "completed", "error"]);

/**
 * Validate one native part's identity and the fields the translator consumes. Unknown part types are
 * retained as opaque coordinates; known rendered types fail closed instead of being silently dropped.
 */
export function isValidOpencodePart(
  value: unknown,
  expectedMessageId?: string,
  expectedSessionId?: string,
): value is Part & { id: string; messageID?: string; sessionID?: string } {
  if (
    !isPlainRecord(value) ||
    !isOpencodePartId(value.id) ||
    typeof value.type !== "string" ||
    value.type === ""
  ) {
    return false;
  }
  if (expectedMessageId !== undefined) {
    if (!isOpencodeMessageId(expectedMessageId) || value.messageID !== expectedMessageId)
      return false;
  } else if (value.messageID !== undefined && !isOpencodeMessageId(value.messageID)) {
    return false;
  }
  if (expectedSessionId !== undefined) {
    if (!isOpencodeSessionId(expectedSessionId) || value.sessionID !== expectedSessionId)
      return false;
  } else if (value.sessionID !== undefined && !isOpencodeSessionId(value.sessionID)) {
    return false;
  }

  if (value.type === "text" || value.type === "reasoning") {
    return typeof value.text === "string";
  }
  if (value.type === "tool") {
    if (
      typeof value.callID !== "string" ||
      value.callID === "" ||
      typeof value.tool !== "string" ||
      value.tool === "" ||
      !isPlainRecord(value.state) ||
      typeof value.state.status !== "string" ||
      !OPENCODE_TOOL_STATUSES.has(value.state.status)
    ) {
      return false;
    }
    if (value.state.output !== undefined && typeof value.state.output !== "string") return false;
    if (value.state.error !== undefined && typeof value.state.error !== "string") return false;
  }
  if (value.type === "subtask") {
    for (const field of ["prompt", "description", "agent"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") return false;
    }
  }
  return true;
}

/** Runtime guard used to reject a garbled server-returned policy before the driver ever re-PATCHes
 * native state. */
export function isPermissionRule(v: unknown): v is PermissionRule {
  const r = v as { permission?: unknown; pattern?: unknown; action?: unknown };
  return (
    typeof r?.permission === "string" &&
    typeof r?.pattern === "string" &&
    (r.action === "ask" || r.action === "allow" || r.action === "deny")
  );
}

export interface OpencodeSession {
  id: string;
  permission: PermissionRule[];
}

/** One entry of GET /session/{id}/message — a message's `info` (id/role/time) + its `parts`. The
 *  driver replays these on attach (history backfill) through the SAME coalesce path as live events, so
 *  `info`/`parts` mirror what `message.updated`/`message.part.updated` carry on the SSE stream. */
export interface HistoryMessage {
  info: {
    id: string;
    role: "user" | "assistant";
    /** Required by the exact 1.17.5 assistant schema; absent for ordinary user messages. */
    parentID?: string;
    time?: { completed?: number };
    [k: string]: unknown;
  };
  parts: Array<Part & { id: string; messageID: string }>;
}

export interface OpencodeClientOptions {
  /** Server origin; default http://127.0.0.1:4096. */
  baseUrl?: string;
  /** HTTP Basic username when password authentication is configured (default `opencode`). */
  username?: string;
  /** Optional HTTP Basic password (OPENCODE_SERVER_PASSWORD). Its bytes are never trimmed or logged. */
  password?: string;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

export class OpencodeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpencodeError";
  }
}

export class OpencodeClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #authHeader: string | undefined;

  constructor(opts: OpencodeClientOptions = {}) {
    this.#baseUrl = normalizeOpencodeBaseUrl(opts.baseUrl ?? DEFAULT_OPENCODE_URL);
    this.#fetch = opts.fetchFn ?? globalThis.fetch;
    this.#authHeader =
      opts.password !== undefined
        ? `Basic ${Buffer.from(`${opts.username ?? "opencode"}:${opts.password}`).toString("base64")}`
        : undefined;
  }

  #request(path: string, init: RequestInit): Promise<Response> {
    return this.#fetch(`${this.#baseUrl}${path}`, { ...init, redirect: "error" });
  }

  #headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.#authHeader !== undefined) h.authorization = this.#authHeader;
    return h;
  }

  /**
   * Parse a successful native response without ever exposing server-controlled body text through
   * Response.json()'s SyntaxError. These errors can be traced by callers, so only the stable endpoint
   * name and HTTP status may leave this boundary.
   */
  async #parseJson(res: Response, endpoint: string): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new OpencodeError(
        res.status,
        `${endpoint}: invalid JSON response (status ${res.status})`,
      );
    }
  }

  /** Prove the exact pinned server version before the companion publishes presence. */
  async requireSupportedVersion(signal?: AbortSignal): Promise<void> {
    const res = await this.#request("/global/health", {
      method: "GET",
      headers: this.#headers(false),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw new OpencodeError(res.status, `health check failed: ${res.status}`);
    const data = await this.#parseJson(res, "GET /global/health");
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      (data as { healthy?: unknown }).healthy !== true ||
      (data as { version?: unknown }).version !== SUPPORTED_OPENCODE_VERSION
    ) {
      throw new OpencodeError(0, `OpenCode ${SUPPORTED_OPENCODE_VERSION} is required`);
    }
  }

  /** Create a fresh OpenCode session, returning its `ses_…` id. */
  async createSession(title?: string, signal?: AbortSignal): Promise<string> {
    const body = title !== undefined ? JSON.stringify({ title }) : "{}";
    const res = await this.#request("/session", {
      method: "POST",
      headers: this.#headers(true),
      body,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw new OpencodeError(res.status, `createSession failed: ${res.status}`);
    const data = await this.#parseJson(res, "POST /session");
    const id =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as { id?: unknown }).id
        : undefined;
    if (!isOpencodeSessionId(id)) {
      throw new OpencodeError(res.status, "createSession: invalid native session id");
    }
    return id;
  }

  /**
   * Return one complete, schema-valid native-session identity snapshot. OpenCode orders this response
   * by recent activity, but registration must never infer identity from that order. A successful
   * malformed response is an error—not an empty list that could authorize accidental session creation.
   */
  async listSessions(signal?: AbortSignal): Promise<Array<{ id: string }>> {
    const res = await this.#request("/session", {
      method: "GET",
      headers: this.#headers(false),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw new OpencodeError(res.status, `listSessions failed: ${res.status}`);
    const data = await this.#parseJson(res, "GET /session");
    if (!Array.isArray(data)) {
      throw new OpencodeError(res.status, "listSessions: response is not an array");
    }
    const sessions: Array<{ id: string }> = [];
    const seen = new Set<string>();
    for (const item of data) {
      const id =
        typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
      if (!isOpencodeSessionId(id)) {
        throw new OpencodeError(res.status, "listSessions: invalid native session entry");
      }
      if (seen.has(id)) {
        throw new OpencodeError(res.status, "listSessions: duplicate native session id");
      }
      seen.add(id);
      sessions.push({ id });
    }
    return sessions;
  }

  /**
   * Confirm one exact native session with GET /session/{id}. The response must repeat the requested
   * canonical ID and carry either no permission field (fresh/default policy) or a completely valid
   * permission-rule vector. Partial filtering would make a later append capable of overriding a rule
   * the adapter silently discarded.
   */
  async getSession(sessionId: string, signal?: AbortSignal): Promise<OpencodeSession> {
    if (!isOpencodeSessionId(sessionId)) {
      throw new OpencodeError(0, "getSession: invalid requested native session id");
    }
    const res = await this.#request(`/session/${sessionId}`, {
      method: "GET",
      headers: this.#headers(false),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw new OpencodeError(res.status, `getSession failed: ${res.status}`);
    const data = await this.#parseJson(res, "GET /session/{id}");
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OpencodeError(res.status, "getSession: response is not an object");
    }
    const record = data as { id?: unknown; permission?: unknown };
    if (record.id !== sessionId) {
      throw new OpencodeError(res.status, "getSession: native session id mismatch");
    }
    if (record.permission === undefined) return { id: sessionId, permission: [] };
    if (
      !Array.isArray(record.permission) ||
      !record.permission.every((rule) => isPermissionRule(rule))
    ) {
      throw new OpencodeError(res.status, "getSession: invalid permission policy");
    }
    return { id: sessionId, permission: record.permission };
  }

  /** Read one exact session's runner state from the server-wide active-status map. OpenCode 1.17.5
   * deletes idle entries, so an absent exact key is returned as `idle`; malformed present state is never
   * treated as idle. This is a corroborating snapshot, not an atomic prompt-admission lock. */
  async getSessionStatus(sessionId: string, signal?: AbortSignal): Promise<OpencodeSessionStatus> {
    if (!isOpencodeSessionId(sessionId)) {
      throw new OpencodeError(0, "getSessionStatus: invalid requested native session id");
    }
    const res = await this.#request("/session/status", {
      method: "GET",
      headers: this.#headers(false),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw new OpencodeError(res.status, `getSessionStatus failed: ${res.status}`);
    const data = await this.#parseJson(res, "GET /session/status");
    if (!isPlainRecord(data)) {
      throw new OpencodeError(res.status, "getSessionStatus: response is not an object");
    }
    const status = data[sessionId];
    if (status === undefined) return "idle";
    if (
      !isPlainRecord(status) ||
      (status.type !== "idle" && status.type !== "busy" && status.type !== "retry")
    ) {
      throw new OpencodeError(res.status, "getSessionStatus: invalid exact-session status");
    }
    return status.type;
  }

  /**
   * Fetch a session's FULL message history (OpenCode's built-in resume): GET /session/{id}/message →
   * `[{ info, parts }]` in chronological order. The driver replays these through the SAME coalesce +
   * dedup path as the live stream so attach backfills the prior conversation, and a wrapper restart is a
   * seamless re-attach (re-fetch). `info` carries id/role/time; `parts` is the part list per message.
   */
  async getMessages(sessionId: string, signal?: AbortSignal): Promise<HistoryMessage[]> {
    const res = await this.#request(
      `/session/${sessionId}/message?limit=${OPENCODE_HISTORY_LIMIT + 1}`,
      {
        method: "GET",
        headers: this.#headers(false),
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    if (!res.ok) throw new OpencodeError(res.status, `getMessages failed: ${res.status}`);
    const data = await this.#parseJson(res, "GET /session/{id}/message");
    if (!Array.isArray(data)) {
      throw new OpencodeError(res.status, "getMessages: response is not an array");
    }
    if (data.length > OPENCODE_HISTORY_LIMIT) {
      throw new OpencodeError(0, "getMessages: history exceeds the reconciliation limit");
    }
    const seen = new Set<string>();
    const messages: HistoryMessage[] = [];
    let partCount = 0;
    for (const value of data) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new OpencodeError(res.status, "getMessages: invalid history entry");
      }
      const entry = value as { info?: unknown; parts?: unknown };
      if (!isValidOpencodeMessageInfo(entry.info, sessionId) || !Array.isArray(entry.parts)) {
        throw new OpencodeError(res.status, "getMessages: invalid message identity");
      }
      const info = entry.info;
      if (seen.has(info.id)) {
        throw new OpencodeError(res.status, "getMessages: duplicate message id");
      }
      const parts: HistoryMessage["parts"] = [];
      const partIds = new Set<string>();
      for (const part of entry.parts) {
        partCount += 1;
        if (partCount > OPENCODE_HISTORY_LIMIT) {
          throw new OpencodeError(0, "getMessages: history parts exceed the reconciliation limit");
        }
        if (!isValidOpencodePart(part, info.id, sessionId)) {
          throw new OpencodeError(res.status, "getMessages: invalid message part");
        }
        if (partIds.has(part.id)) {
          throw new OpencodeError(res.status, "getMessages: duplicate message part id");
        }
        partIds.add(part.id);
        parts.push(part as HistoryMessage["parts"][number]);
      }
      seen.add(info.id);
      messages.push({
        info: entry.info as HistoryMessage["info"],
        parts,
      });
    }
    return messages;
  }

  /**
   * Drive a turn. Returns after HTTP transport receipt; native application/order must be proved later
   * from OpenCode events/history. The turn runs in a background fiber. The server replies 204 with an
   * EMPTY body and no response-assigned ID, so we MUST NOT call res.json(). The caller-supplied
   * text-part ID is an exact correlation marker, not an idempotency key. The
   * message ID is deliberately omitted so OpenCode's own monotonic generator retains native order.
   */
  async promptAsync(
    sessionId: string,
    args: { text: string; model: OpencodeModel; partId: string },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isOpencodePartId(args.partId)) {
      throw new OpencodeError(0, "promptAsync: invalid caller part id");
    }
    const res = await this.#request(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({
        model: args.model,
        parts: [{ id: args.partId, type: "text", text: args.text }],
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
    // 204 No Content is the success shape — do not read the (empty) body.
    if (!res.ok || res.status !== 204) {
      throw new OpencodeError(res.status, `promptAsync failed: ${res.status}`);
    }
  }

  /** Interrupt the running turn (maps the relay's `interrupt` verb). */
  async abort(sessionId: string, signal?: AbortSignal): Promise<void> {
    const res = await this.#request(`/session/${sessionId}/abort`, {
      method: "POST",
      headers: this.#headers(false),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw new OpencodeError(res.status, `abort failed: ${res.status}`);
    const acknowledged = await this.#parseJson(res, "POST /session/{id}/abort");
    if (acknowledged !== true) {
      throw new OpencodeError(
        res.status,
        `POST /session/{id}/abort: invalid acknowledgement (status ${res.status})`,
      );
    }
  }

  /** Compact/summarize the session — POST /session/{id}/summarize { providerID, modelID }. This is the
   *  native equivalent of the `/compact` slash command (verified against the live OpenAPI: the route +
   *  the SummarizePayload {providerID, modelID, auto?}). The server kicks off a compaction turn whose
   *  output arrives over events(), so we just check the 200 boolean ack here. */
  async summarize(sessionId: string, model: OpencodeModel): Promise<void> {
    const res = await this.#request(`/session/${sessionId}/summarize`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID, auto: false }),
    });
    if (!res.ok) {
      throw new OpencodeError(res.status, `summarize failed: ${res.status}`);
    }
  }

  /** Read a session's complete validated permission policy. */
  async getSessionPermission(sessionId: string, signal?: AbortSignal): Promise<PermissionRule[]> {
    return (await this.getSession(sessionId, signal)).permission;
  }

  /** Flip a session into permission "ask" mode: PATCH /session/{id} { permission: rules }. opencode
   *  auto-runs every tool by default, so the driver's mirroring gate never fires unless a session carries
   *  ask rules. Verified live against opencode 1.17.5: a per-session `permission` override (PATCH or at
   *  create) makes each tool emit `permission.asked`. opencode is LAST-match-wins, so callers put the
   *  catch-all ask FIRST and any preserved (specific) rules AFTER it. 200 on success; we don't read the body. */
  async setSessionPermission(
    sessionId: string,
    rules: readonly PermissionRule[],
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.#request(`/session/${sessionId}`, {
      method: "PATCH",
      headers: this.#headers(true),
      body: JSON.stringify({ permission: rules }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) {
      throw new OpencodeError(res.status, `setSessionPermission failed: ${res.status}`);
    }
  }

  /**
   * Answer a permission gate through OpenCode 1.17.5's retained, nondeprecated endpoint:
   * POST /permission/{requestID}/reply { reply }. The native server must acknowledge with literal
   * JSON true; any other successful-response body fails closed.
   */
  async replyPermission(
    requestId: string,
    response: "once" | "always" | "reject",
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.#request(`/permission/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({ reply: response }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) {
      throw new OpencodeError(
        res.status,
        `POST /permission/{requestID}/reply failed: ${res.status}`,
      );
    }
    const acknowledged = await this.#parseJson(res, "POST /permission/{requestID}/reply");
    if (acknowledged !== true) {
      throw new OpencodeError(
        res.status,
        `POST /permission/{requestID}/reply: invalid acknowledgement (status ${res.status})`,
      );
    }
  }

  /**
   * Async-iterable over the server-wide SSE stream (GET /event) for ONE connection, filtered by either
   * one exact session or a caller predicate. Predicate consumers also receive every `session.created`
   * discovery event before filtering; truly session-less `server.*` events pass for presence refresh.
   * The generator ENDS on stream EOF (`return`) or throws on a connect/transport error; it does NOT
   * reconnect — the driver's #capturePump owns the reconnect loop
   * (so a transient SSE close doesn't tear down the bridge — review #2). Parses the `data: <json>` SSE
   * framing; non-JSON / comment (`:keepalive`) lines are skipped. CRLF-safe (review #4): a frame may be
   * separated by `\r\n\r\n` OR `\n\n`, and individual lines by `\r\n`/`\n`/`\r`.
   */
  async *events(
    want: string | ((id: string | undefined) => boolean),
    signal: AbortSignal,
  ): AsyncGenerator<OpencodeEvent> {
    // `want` selects which session(s) this connection delivers: a single id (the common case) OR a
    // predicate (the driver passes one so it can FOLLOW child sub-agent sessions discovered live — #102).
    const isPredicate = typeof want === "function";
    const wantSession = isPredicate
      ? (want as (id: string | undefined) => boolean)
      : (id: string | undefined) => id === want;
    const res = await this.#request("/event", {
      headers: this.#headers(false),
      signal,
    });
    if (!res.ok || res.body === null) {
      throw new OpencodeError(res.status, `events stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let pendingCr = false;
    const normalizeNewlines = (decoded: string, final = false): string => {
      let text = pendingCr ? `\r${decoded}` : decoded;
      pendingCr = false;
      if (!final && text.endsWith("\r")) {
        pendingCr = true;
        text = text.slice(0, -1);
      }
      return text.replace(/\r\n?/g, "\n");
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buf += normalizeNewlines(decoder.decode(), true);
          if (buf.trim() !== "") {
            throw new OpencodeError(0, "events stream ended with an incomplete SSE frame");
          }
          return;
        }
        // Normalize CRLF/CR → LF up front so frame + line splitting is uniform (review #4). The OpenCode
        // server emits LF today, but a CRLF proxy in front of it must still frame correctly.
        buf += normalizeNewlines(decoder.decode(value, { stream: true }));
        // SSE frames are separated by a blank line. Each frame may carry several `data:` lines.
        for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
          if (sep > OPENCODE_SSE_BUFFER_LIMIT) {
            throw new OpencodeError(0, "events stream frame exceeds the bounded parser limit");
          }
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const obj = parseSseFrame(block);
          if (obj === null) {
            const hasData = block
              .split("\n")
              .some((line) => line.startsWith("data:") && line.slice(5).trim() !== "");
            if (hasData) {
              throw new OpencodeError(0, "events stream contained an invalid SSE event");
            }
            continue;
          }
          // `session.created` is a DISCOVERY event — a predicate consumer (the driver FOLLOWS child
          // sub-agent sessions, #102) can only learn a child exists FROM its own session.created. Its
          // event-session is the not-yet-followed CHILD (and the shape may carry the id ONLY as
          // `info.id`, with no `sessionID`), so gating it by the follow-set — or by the session-less drop
          // below — would be circular and lose the child. Deliver EVERY session.created to a predicate
          // consumer BEFORE any filtering; the driver's handler still ignores one whose parentID it
          // doesn't follow, so this can't over-follow. A fixed single-session (string) subscription is
          // unaffected (it never follows children) and stays strictly scoped.
          if (isPredicate && obj.type === "session.created") {
            yield obj;
            continue;
          }
          // Otherwise derive the event's session id from wherever the server puts it: most events carry a
          // top-level `properties.sessionID`, but session-scoped sub-shapes carry it ONLY nested —
          // `message.part.*` on `properties.part.sessionID`, `message.updated` on `properties.info
          // .sessionID`. Checking only the top level would drop our OWN assistant/tool content (codex).
          const evSession = eventSessionId(obj.properties);
          if (evSession === undefined && hasConflictingEventSessionIds(obj.properties)) {
            throw new OpencodeError(0, "events stream contained conflicting session identities");
          }
          if (evSession === undefined) {
            // Truly session-less events: ONLY `server.*` (connected/heartbeat) are global. A session-less
            // event of any other type (e.g. a `session.error` the server emitted without a sessionID)
            // must NOT be delivered — otherwise it would fan out to EVERY bridged session/driver on this
            // server-wide stream (codex review). Drop it.
            if (!obj.type.startsWith("server.")) continue;
          } else if (!wantSession(evSession)) {
            continue; // a session this connection doesn't follow
          }
          yield obj;
        }
        if (buf.length > OPENCODE_SSE_BUFFER_LIMIT) {
          throw new OpencodeError(0, "events stream buffer exceeds the bounded parser limit");
        }
      }
    } finally {
      // Releasing the lock lets the underlying body be GC'd when the abort tears the response down.
      try {
        reader.releaseLock();
      } catch {
        /* already released on abort */
      }
    }
  }
}

/** The OpenCode session an event belongs to, derived from wherever the server puts the id: most events
 *  carry a top-level `properties.sessionID`, but session-scoped sub-shapes carry it ONLY nested —
 *  `message.part.*` on `properties.part.sessionID`, `message.updated` on `properties.info.sessionID`.
 *  Returns undefined for genuinely session-less events (`server.*`) and for `session.created` (whose
 *  session is `info.id`, handled specially by the follow path). Shared by the client filter AND the driver
 *  so the two never drift (codex review). */
export function eventSessionId(props: OpencodeEvent["properties"] | undefined): string | undefined {
  const ids = eventSessionIds(props);
  if (new Set(ids).size > 1) return undefined;
  return ids[0];
}

function eventSessionIds(props: OpencodeEvent["properties"] | undefined): string[] {
  if (props === undefined) return [];
  const candidates: unknown[] = [props.sessionID, props.part?.sessionID, props.info?.sessionID];
  return candidates.filter((candidate): candidate is string => typeof candidate === "string");
}

function hasConflictingEventSessionIds(props: OpencodeEvent["properties"] | undefined): boolean {
  return new Set(eventSessionIds(props)).size > 1;
}

/** Parse ONE SSE frame block (its `\n\n`-delimited lines, already LF-normalized) into an OpencodeEvent,
 *  or null if it carries no valid typed event. The stream owner distinguishes empty/comment frames from
 *  malformed data frames so continuity failures are terminal rather than silently skipped. */
export function parseSseFrame(block: string): OpencodeEvent | null {
  const data = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("");
  if (data === "") return null;
  let obj: OpencodeEvent;
  try {
    obj = JSON.parse(data) as OpencodeEvent;
  } catch {
    return null; // malformed frame — skip rather than kill the stream
  }
  if (
    typeof obj?.type !== "string" ||
    typeof obj.properties !== "object" ||
    obj.properties === null ||
    Array.isArray(obj.properties)
  ) {
    return null;
  }
  return obj;
}
