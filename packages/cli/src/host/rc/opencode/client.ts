// A typed, dependency-free wrapper over the OpenCode HTTP+SSE server (`opencode serve`, an Effect
// HttpApi). It uses the global `fetch` (Node 22) — no `@opencode-ai/sdk` dep, since the surface we need
// is small and the SDK isn't installed. Shapes verified against the live server's GET /doc (OpenAPI) and
// by curling `opencode serve` on 127.0.0.1:4096 (model ollama/qwen2.5:0.5b):
//   POST /session                                  → { id: "ses_…", … }
//   POST /session/{id}/prompt_async {parts, model} → HTTP 204 (EMPTY body — never JSON-parse it)
//   POST /session/{id}/abort                       → 200 (boolean)
//   GET  /event                                    → server-wide SSE: data: {id,type,properties}
//   POST /session/{id}/permissions/{permID} {response:"once"|"always"|"reject"} → 200 (boolean)

import type { Part } from "./translate.js";

export const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";

/** One server-wide SSE frame. `properties.sessionID` is how a single-session driver filters the global
 *  stream (GET /event carries EVERY session's events). `properties.part`/`info` are event-specific. */
export interface OpencodeEvent {
  id?: string;
  type: string;
  properties: {
    sessionID?: string;
    part?: Part & { messageID?: string; sessionID?: string };
    info?: { id?: string; role?: string; time?: { completed?: number }; [k: string]: unknown };
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

/** The OpenCode model selector for prompt_async (providerID + modelID, e.g. ollama / qwen2.5:0.5b). */
export interface OpencodeModel {
  providerID: string;
  modelID: string;
}

/** One entry of GET /session/{id}/message — a message's `info` (id/role/time) + its `parts`. The
 *  driver replays these on attach (history backfill) through the SAME coalesce path as live events, so
 *  `info`/`parts` mirror what `message.updated`/`message.part.updated` carry on the SSE stream. */
export interface HistoryMessage {
  info: { id?: string; role?: string; time?: { completed?: number }; [k: string]: unknown };
  parts: Array<Part & { messageID?: string }>;
}

export interface OpencodeClientOptions {
  /** Server origin; default http://127.0.0.1:4096. */
  baseUrl?: string;
  /** Optional HTTP Basic password (OPENCODE_SERVER_PASSWORD); username is empty. Off on loopback. */
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
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_OPENCODE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetchFn ?? globalThis.fetch;
    this.#authHeader =
      opts.password !== undefined && opts.password !== ""
        ? `Basic ${Buffer.from(`:${opts.password}`).toString("base64")}`
        : undefined;
  }

  #headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.#authHeader !== undefined) h.authorization = this.#authHeader;
    return h;
  }

  /** Create a fresh OpenCode session, returning its `ses_…` id. */
  async createSession(title?: string): Promise<string> {
    const body = title !== undefined ? JSON.stringify({ title }) : "{}";
    const res = await this.#fetch(`${this.#baseUrl}/session`, {
      method: "POST",
      headers: this.#headers(true),
      body,
    });
    if (!res.ok) throw new OpencodeError(res.status, `createSession failed: ${res.status}`);
    const data = (await res.json()) as { id?: unknown };
    if (typeof data.id !== "string") throw new OpencodeError(res.status, "createSession: no id");
    return data.id;
  }

  /**
   * List sessions, MOST-RECENTLY-UPDATED FIRST (the server's documented order: GET /session is
   * "sorted by most recently updated"). The driver's auto-attach picks `[0]` — the active session — so
   * running the wrapper bridges whatever OpenCode session is in use rather than imposing a new one.
   * Returns just the `id` (the field auto-attach needs); the full Session object is server-owned.
   */
  async listSessions(): Promise<Array<{ id: string }>> {
    const res = await this.#fetch(`${this.#baseUrl}/session`, {
      method: "GET",
      headers: this.#headers(false),
    });
    if (!res.ok) throw new OpencodeError(res.status, `listSessions failed: ${res.status}`);
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .filter((s): s is { id: string } => {
        const id = (s as { id?: unknown })?.id;
        return typeof id === "string" && id !== "";
      })
      .map((s) => ({ id: s.id }));
  }

  /**
   * Fetch a session's FULL message history (OpenCode's built-in resume): GET /session/{id}/message →
   * `[{ info, parts }]` in chronological order. The driver replays these through the SAME coalesce +
   * dedup path as the live stream so attach backfills the prior conversation, and a wrapper restart is a
   * seamless re-attach (re-fetch). `info` carries id/role/time; `parts` is the part list per message.
   */
  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const res = await this.#fetch(`${this.#baseUrl}/session/${sessionId}/message`, {
      method: "GET",
      headers: this.#headers(false),
    });
    if (!res.ok) throw new OpencodeError(res.status, `getMessages failed: ${res.status}`);
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((m): m is HistoryMessage => {
      const mm = m as { info?: unknown; parts?: unknown };
      return typeof mm.info === "object" && mm.info !== null && Array.isArray(mm.parts);
    });
  }

  /**
   * Drive a turn. Returns when the request is ACCEPTED (the turn runs in a background fiber; output
   * arrives over events()). The server replies 204 with an EMPTY body, so we MUST NOT call res.json().
   */
  async promptAsync(
    sessionId: string,
    args: { text: string; model: OpencodeModel },
  ): Promise<void> {
    const res = await this.#fetch(`${this.#baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({
        model: args.model,
        parts: [{ type: "text", text: args.text }],
      }),
    });
    // 204 No Content is the success shape — do not read the (empty) body.
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new OpencodeError(res.status, `promptAsync failed: ${res.status} ${detail}`.trim());
    }
  }

  /** Interrupt the running turn (maps the relay's `interrupt` verb). Best-effort; ignores the result. */
  async abort(sessionId: string): Promise<void> {
    const res = await this.#fetch(`${this.#baseUrl}/session/${sessionId}/abort`, {
      method: "POST",
      headers: this.#headers(false),
    });
    if (!res.ok) throw new OpencodeError(res.status, `abort failed: ${res.status}`);
  }

  /** Compact/summarize the session — POST /session/{id}/summarize { providerID, modelID }. This is the
   *  native equivalent of the `/compact` slash command (verified against the live OpenAPI: the route +
   *  the SummarizePayload {providerID, modelID, auto?}). The server kicks off a compaction turn whose
   *  output arrives over events(), so we just check the 200 boolean ack here. */
  async summarize(sessionId: string, model: OpencodeModel): Promise<void> {
    const res = await this.#fetch(`${this.#baseUrl}/session/${sessionId}/summarize`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID, auto: false }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new OpencodeError(res.status, `summarize failed: ${res.status} ${detail}`.trim());
    }
  }

  /** Answer a permission gate: POST /session/{id}/permissions/{permID} { response }. */
  async replyPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    const res = await this.#fetch(
      `${this.#baseUrl}/session/${sessionId}/permissions/${permissionId}`,
      {
        method: "POST",
        headers: this.#headers(true),
        body: JSON.stringify({ response }),
      },
    );
    if (!res.ok) throw new OpencodeError(res.status, `replyPermission failed: ${res.status}`);
  }

  /**
   * Async-iterable over the server-wide SSE stream (GET /event) for ONE connection, pre-filtered to one
   * session by `properties.sessionID` (events with no sessionID — server.connected/heartbeat — pass
   * through so the driver can refresh presence). The generator ENDS on stream EOF (`return`) or throws on
   * a connect/transport error; it does NOT reconnect — the driver's #capturePump owns the reconnect loop
   * (so a transient SSE close doesn't tear down the bridge — review #2). Parses the `data: <json>` SSE
   * framing; non-JSON / comment (`:keepalive`) lines are skipped. CRLF-safe (review #4): a frame may be
   * separated by `\r\n\r\n` OR `\n\n`, and individual lines by `\r\n`/`\n`/`\r`.
   */
  async *events(sessionId: string, signal: AbortSignal): AsyncGenerator<OpencodeEvent> {
    const res = await this.#fetch(`${this.#baseUrl}/event`, {
      headers: this.#headers(false),
      signal,
    });
    if (!res.ok || res.body === null) {
      throw new OpencodeError(res.status, `events stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // Normalize CRLF/CR → LF up front so frame + line splitting is uniform (review #4). The OpenCode
        // server emits LF today, but a CRLF proxy in front of it must still frame correctly.
        buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        // SSE frames are separated by a blank line. Each frame may carry several `data:` lines.
        for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const obj = parseSseFrame(block);
          if (obj === null) continue; // empty/malformed/non-typed frame — skip, don't kill the stream
          // Derive the event's session id from wherever the server puts it: most events carry a top-level
          // `properties.sessionID`, but session-scoped sub-shapes carry it ONLY nested — `message.part.*`
          // on `properties.part.sessionID`, `message.updated` on `properties.info.sessionID`. Checking
          // only the top level would drop our OWN assistant/tool content for those shapes (codex review).
          const props = obj.properties;
          const evSession =
            props?.sessionID ??
            props?.part?.sessionID ??
            (props?.info as { sessionID?: string } | undefined)?.sessionID;
          if (evSession === undefined) {
            // Truly session-less events: ONLY `server.*` (connected/heartbeat) are global. A session-less
            // event of any other type (e.g. a `session.error` the server emitted without a sessionID)
            // must NOT be delivered — otherwise it would fan out to EVERY bridged session/driver on this
            // server-wide stream (codex review). Drop it.
            if (!obj.type.startsWith("server.")) continue;
          } else if (evSession !== sessionId) {
            continue; // a different session's event
          }
          yield obj;
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

/** Parse ONE SSE frame block (its `\n\n`-delimited lines, already LF-normalized) into an OpencodeEvent,
 *  or null if it carries no parseable typed event. Concatenates all `data:` lines per the SSE spec and
 *  skips `:comment` keepalives. Exported for the unit test that pins CRLF framing (review #4). */
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
  if (typeof obj?.type !== "string") return null;
  return obj;
}
