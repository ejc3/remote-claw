// The OpenCode driver: bridges an `opencode serve` session to our broker via the SAME Session/relay
// contract the MITM uses (driver.ts seam). It does NOT stand up the MITM — it talks straight to the
// OpenCode HTTP+SSE server. Lifecycle mirrors launch.ts: RelayCore.create({title}) → pushInitialize()
// → bridgeSession(...) → run the CAPTURE + INJECT pumps concurrently → teardown (abort the run, close
// the session, await the served promise so a final frame flushes).
//
// The three driver obligations from the adversarial review (driver.ts "DRIVER OBLIGATIONS") are the
// load-bearing logic here:
//   #1 COALESCE  — OpenCode re-sends a whole part on every message.part.updated; the relay mints a fresh
//                  transcript seq per pushUpstream. So we BUFFER parts per messageID and pushUpstream
//                  ONCE per completed message (on session.idle / an assistant message.updated with
//                  time.completed), never per part.updated.
//   #2 DEDUP     — re-pushing a uuid does NOT dedup at the relay. We track emitted message ids and never
//                  re-emit one (covers an SSE reconnect re-delivering a finished message).
//   #5 ACK       — followDownstream only suppresses replay for ids in #acked; a non-MITM driver has no
//                  /worker/events/delivery, so we call session.ack(ev.eventId) after EVERY successful
//                  inject, INCLUDING the leading `initialize` control_request.
//
// V1 LIMITATIONS (documented, intentional — not bugs):
//   • SUBAGENTS NOT BRIDGED (review #7). OpenCode spawns a Task/subagent as a CHILD session and emits a
//     `subtask` part on the parent message. translate.ts drops `subtask` parts (partToBlocks → EMPTY) and
//     the driver never passes parentToolUseId, so coalesceMessage tags nothing; the client also filters
//     events to ONE sessionID, so child-session events are not captured. A Task run therefore shows no
//     nested Task row / no subagent output in the web viewer. Bridging child sessions (follow whichever
//     child sessions a parent spawns, tag their messages with the parent Task tool_use id) is follow-up
//     work — coalesceMessage already accepts a parentToolUseId for when it lands.
//   • RELAY DEATH DOES NOT END OPENCODE (review #8, intentional). bridgeSession's serve() can end (the
//     broker dropped / the remote viewer went away); the driver KEEPS opencode running. The wrapper is
//     thin: the local TUI stays usable and the remote view reconnects when the broker recovers. run()
//     ends only on the PARENT signal abort — we deliberately do NOT race `served` to abort opencode (that
//     would kill the user's live local session on a transient broker blip).
//   • IDENTICAL-PROMPT COLLISION (review #9). Echo suppression correlates a flushed OpenCode user message
//     to a driver-injected prompt by TEXT (the #injectedTexts multiset). If a web prompt "X" and a TUI
//     prompt "X" race before the first echo flushes, the driver can mis-attribute one for the other
//     (suppress the local one / surface the injected one). Rare and self-limited to identical text;
//     revisit with message-id correlation if OpenCode exposes the prompt's resulting message id.

import type { BrokerClient } from "../../../broker/client.js";
import { type Tracer, tracerFromEnv } from "../../../trace.js";
import type { Driver, DriverCapabilities, DriverContext } from "../driver.js";
import { bridgeSession } from "../drivers/bridge.js";
import type { GitInfo } from "../gitinfo.js";
import { RelayCore, type Session } from "../session.js";
import {
  DEFAULT_OPENCODE_URL,
  type HistoryMessage,
  OpencodeClient,
  type OpencodeClientOptions,
  type OpencodeEvent,
  type OpencodeModel,
} from "./client.js";
import { coalesceMessage, type Part, userPartsText, userText } from "./translate.js";

export const DEFAULT_OPENCODE_MODEL: OpencodeModel = {
  providerID: "ollama",
  modelID: "qwen2.5:0.5b",
};

/** OpenCode-specific knobs the driver reads from DriverContext.extra (set by the wiring in run.ts). */
export interface OpencodeExtra {
  /** OpenCode server origin (default http://127.0.0.1:4096). */
  baseUrl?: string;
  /** providerID + modelID for prompt_async (default ollama/qwen2.5:0.5b). */
  model?: OpencodeModel;
  /** Optional HTTP Basic password (OPENCODE_SERVER_PASSWORD). */
  password?: string;
  /** Explicit OpenCode session to ATTACH to (`--rc-oc-session`). When set, the driver bridges THIS
   *  session verbatim — no auto-pick, no create. When unset, the driver auto-picks the server's most
   *  recent session (the active one), else creates a fresh one. THIN by default: bridge what's running. */
  sessionId?: string;
  /** Injectable client (tests) — bypasses the real HTTP server. */
  client?: OpencodeClient;
}

function readExtra(extra: Record<string, unknown> | undefined): OpencodeExtra {
  if (!extra) return {};
  const out: OpencodeExtra = {};
  if (typeof extra.baseUrl === "string") out.baseUrl = extra.baseUrl;
  if (typeof extra.password === "string") out.password = extra.password;
  if (typeof extra.sessionId === "string" && extra.sessionId !== "")
    out.sessionId = extra.sessionId;
  if (extra.client instanceof OpencodeClient) out.client = extra.client;
  const m = extra.model as { providerID?: unknown; modelID?: unknown } | undefined;
  if (m && typeof m.providerID === "string" && typeof m.modelID === "string") {
    out.model = { providerID: m.providerID, modelID: m.modelID };
  }
  return out;
}

/** What we buffer for one in-flight assistant message: its parts keyed by partID, in arrival order, so
 *  a re-sent whole part REPLACES its prior version (coalesce) rather than appending a duplicate. */
interface MessageBuffer {
  /** partID → the latest whole Part for that id (OpenCode re-sends the whole part, not a delta). */
  parts: Map<string, Part>;
  /** insertion order of partIDs so blocks render in the order OpenCode produced them. */
  order: string[];
}

/** Default cap for the bounded dedup/correlation structures (#emitted, #injectedTexts, #roles). Mirrors
 *  the relay's #seen discipline: keep the WINDOW of recent ids large enough that a re-backfill after a
 *  reconnect (review #2) still finds its just-emitted ids (no truncation/dup), but bounded so a very
 *  long-lived bridge can't grow unbounded. A single turn touches O(1) ids; 4096 covers thousands of
 *  recent turns — far more than any reconnect re-backfill replays. */
const DEFAULT_EMITTED_CAP = 4096;

/** SSE reconnect backoff bounds (review #2). A transient close reconnects after MIN; repeated failures
 *  (server down) back off exponentially up to MAX. The backoff is reset to MIN after a connection that
 *  lived (a clean EOF), so a healthy-then-blip reconnect is fast. */
const RECONNECT_BACKOFF_MIN_MS = 250;
const RECONNECT_BACKOFF_MAX_MS = 5000;

/** A Set with a FIFO eviction cap: re-adding a present key refreshes its recency (moves it to newest), and
 *  adding past the cap evicts the OLDEST key. Preserves recent-id dedup across a reconnect's re-backfill
 *  (the relay's bounded-#seen approach) while bounding memory on a long-lived bridge (review #6). A Set in
 *  JS already iterates in insertion order, so we delete-then-re-add to bump recency. */
class BoundedSet {
  readonly #set = new Set<string>();
  constructor(private readonly cap: number) {}
  has(key: string): boolean {
    return this.#set.has(key);
  }
  add(key: string): void {
    if (this.#set.has(key)) this.#set.delete(key); // bump recency: re-insert at the newest position
    this.#set.add(key);
    while (this.#set.size > this.cap) {
      const oldest = this.#set.values().next().value;
      if (oldest === undefined) break;
      this.#set.delete(oldest);
    }
  }
  get size(): number {
    return this.#set.size;
  }
}

/** A Map with a FIFO eviction cap (same eviction discipline as BoundedSet, keyed value preserved). Used to
 *  bound #roles so a long-lived bridge doesn't accumulate one role entry per message forever (review #6). */
class BoundedMap<V> {
  readonly #map = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get(key: string): V | undefined {
    return this.#map.get(key);
  }
  set(key: string, value: V): void {
    if (this.#map.has(key)) this.#map.delete(key); // bump recency
    this.#map.set(key, value);
    while (this.#map.size > this.cap) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }
}

export class OpencodeDriver implements Driver {
  readonly capabilities: DriverCapabilities = {
    // We surface OpenCode permission gates as can_use_tool and round-trip the answer to .../permissions.
    structuredPermissions: true,
    // session.status / session.idle drive a real workerStatus.
    status: true,
    // interrupt → abort; set_model is remembered for the next prompt; end/set_mode safely no-op.
    controlVerbs: true,
    // Attachments are relay-owned (the driver only sees the resulting downstream `user` prompt).
    attachments: true,
  };

  readonly #ctx: DriverContext;
  readonly #extra: OpencodeExtra;
  readonly #model: OpencodeModel;
  readonly #client: OpencodeClient;
  readonly #tracer: Tracer;

  /** Buffered in-flight assistant messages, keyed by OpenCode messageID. Flushed (and removed) on
   *  session.idle / a completed assistant message.updated. Self-bounded (cleared on flush / re-seeded
   *  per incomplete message), so it never needs an explicit cap. */
  readonly #buffers = new Map<string, MessageBuffer>();
  /** Message ids already pushUpstream-ed — the DEDUP set (#2): never emit a message twice (an SSE
   *  reconnect can re-deliver a finished message's parts). FIFO-bounded (review #6) so a long-lived
   *  bridge can't grow it without limit; the window is large enough that a reconnect's re-backfill still
   *  finds every recently-emitted id (coordinated with #2 — no truncation/dup across a reconnect). */
  readonly #emitted = new BoundedSet(DEFAULT_EMITTED_CAP);
  /** messageID → role, learned from `message.updated` (and backfilled history). An ASSISTANT message is
   *  pushed upstream as an `assistant` payload. A USER message is handled by origin (see #injectedTexts):
   *  one WE injected is the echo of a viewer prompt (the relay's inbound pump already surfaced it) and is
   *  SUPPRESSED; one we did NOT inject was typed at the OpenCode TUI / by another client and is surfaced
   *  as a `local_prompt` `user` payload so it shows in the web viewer. FIFO-bounded (review #6). */
  readonly #roles = new BoundedMap<string>(DEFAULT_EMITTED_CAP);
  /** Multiset of prompt texts the INJECT pump sent via prompt_async, keyed by text → count. When a
   *  user-role message flushes we decrement the matching entry and SUPPRESS it (it's our own echo); a
   *  user message with no matching entry is a LOCAL prompt (TUI / other client) → emitted `local_prompt`.
   *  A multiset (not a set) so two identical prompts each suppress exactly one echo. Bounded: entries are
   *  decremented+deleted on a matched echo, and a failed inject ROLLS BACK its entry (review #3), so this
   *  only holds in-flight (un-echoed) prompts — naturally small. */
  readonly #injectedTexts = new Map<string, number>();
  /** The active model to use for the next prompt_async; updated by a set_model control verb. */
  #activeModel: OpencodeModel;

  constructor(ctx: DriverContext) {
    this.#ctx = ctx;
    this.#extra = readExtra(ctx.extra);
    this.#model = this.#extra.model ?? DEFAULT_OPENCODE_MODEL;
    this.#activeModel = this.#model;
    this.#tracer = (ctx.tracer ?? tracerFromEnv("rc.opencode")).child({ driver: "opencode" });
    this.#client =
      this.#extra.client ??
      new OpencodeClient({
        baseUrl: this.#extra.baseUrl ?? DEFAULT_OPENCODE_URL,
        ...(this.#extra.password !== undefined ? { password: this.#extra.password } : {}),
      } satisfies OpencodeClientOptions);
  }

  /** Run until `signal` aborts (or the OpenCode stream ends). Resolves with an exit code (0 on a clean
   *  teardown). Mirrors runRcLaunch's structure: create+initialize the Session, bridge it, run the
   *  pumps, then tear down (abort the OpenCode run, close the session, await the served flush). */
  async run(signal: AbortSignal): Promise<number> {
    const core = new RelayCore();
    const session = core.create({ title: this.#ctx.title });
    session.pushInitialize(); // guaranteed first downstream event (idempotent)
    this.#ctx.onSession?.(session);

    // Our own abort controller, chained to the parent signal, so teardown can stop the pumps + the SSE
    // stream + the followDownstream loop together.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const relays = new Set<Promise<void>>();
    const served = bridgeSession({
      session,
      newClient: this.#ctx.newClient,
      identityId: this.#ctx.identity.identityId,
      title: this.#ctx.title,
      cwd: this.#ctx.cwd,
      git: this.#ctx.git as GitInfo | null,
      signal: ac.signal,
      relays,
      tracer: this.#ctx.tracer ?? tracerFromEnv("rc.relay"),
    });

    // ATTACH to the OpenCode session to bridge: an explicit --rc-oc-session, else the server's most-recent
    // (active) session, else create a fresh one. A failure here is fatal (no session to bridge); tear down
    // and report non-zero. This is the THIN default: bridge whatever OpenCode session is in use.
    let ocSessionId: string;
    try {
      ocSessionId = await this.#attach();
    } catch (e) {
      this.#tracer.error("opencode attach failed", { error: String(e) });
      ac.abort();
      session.close();
      await served.catch(() => {});
      return 1;
    }
    this.#tracer.info("opencode session attached", { session: session.id, opencode: ocSessionId });

    // HISTORY BACKFILL / RESUME runs INSIDE #capturePump, on the first SSE event (when the subscription
    // is LIVE) — NOT here. Backfilling before subscribing would lose any event arriving in the gap
    // between the GET /message snapshot and the /event subscription (SSE has no replay) — e.g. a prompt
    // another client (the TUI) sends during attach would vanish. Subscribe-first + #emitted dedup is
    // lossless and order-preserving (history first, then live).

    try {
      await Promise.race([
        this.#capturePump(session, ocSessionId, ac.signal),
        this.#injectPump(session, ocSessionId, ac.signal),
        waitAbort(ac.signal),
      ]);
      return 0;
    } finally {
      signal.removeEventListener("abort", onAbort);
      // Teardown (review #10): abort the OpenCode run, abort the pumps, close the Session so a final
      // frame flushes, and await the served promise so the relay's death is observed, not swallowed.
      try {
        await this.#client.abort(ocSessionId);
      } catch {
        /* best-effort */
      }
      ac.abort();
      session.workerStatus = "idle";
      session.close();
      await served.catch(() => {});
    }
  }

  /**
   * Pick the OpenCode session to bridge (the THIN attach):
   *   1. an explicit `--rc-oc-session` (extra.sessionId) → bridge it verbatim;
   *   2. else the server's MOST-RECENT session (listSessions()[0], "sorted by most recently updated") →
   *      bridge whatever's active rather than imposing a new one;
   *   3. else (no sessions on the server) → create a fresh one.
   * Returns the chosen `ses_…` id. A list failure falls through to create() so the driver still starts.
   */
  async #attach(): Promise<string> {
    if (this.#extra.sessionId !== undefined) {
      this.#tracer.debug("attaching to explicit session", { opencode: this.#extra.sessionId });
      return this.#extra.sessionId;
    }
    let sessions: Array<{ id: string }> = [];
    try {
      sessions = await this.#client.listSessions();
    } catch (e) {
      this.#tracer.warn("listSessions failed; creating a fresh session", { error: String(e) });
    }
    const first = sessions[0];
    if (first !== undefined) {
      this.#tracer.debug("auto-attaching to most-recent session", { opencode: first.id });
      return first.id;
    }
    const created = await this.#client.createSession(this.#ctx.title);
    this.#tracer.debug("no existing session; created one", { opencode: created });
    return created;
  }

  /**
   * HISTORY BACKFILL / RESUME: fetch the attached session's full message history (GET /…/message) and
   * replay it through the SAME flush path as the live stream — coalesce per message, dedup by messageID
   * (#emitted), emit assistant turns as `assistant` and locally-typed user turns as `local_prompt`. Run on
   * attach AND after EACH (re)connect (review #2) — #emitted dedups what was already emitted, so a re-run
   * re-emits nothing already shown. Because it shares #emitted, a wrapper restart re-attaches, re-fetches
   * the same history, and re-emits it with NO duplicates beyond a fresh broker session's first pass (the
   * broker/viewer dedup by their own seq within a session; a new session starts the log over).
   *
   * MID-TURN ATTACH (review #1, CRITICAL): an ASSISTANT message is flushed here ONLY when it is COMPLETE
   * (`info.time.completed`). If we attach while an assistant message is still streaming, flushing the
   * partial would mark it #emitted and the LIVE completion would then be deduped away — the viewer would
   * be stuck with truncated output forever. So for an INCOMPLETE assistant we SEED its parts into #buffers
   * + record its role WITHOUT touching #emitted; the live `message.updated` (completed) / `session.idle`
   * then flushes the FULL message exactly once. User messages carry no `completed` flag (they settle the
   * moment the model starts) — they flush as before.
   */
  async #backfillHistory(session: Session, ocSessionId: string): Promise<void> {
    const messages: HistoryMessage[] = await this.#client.getMessages(ocSessionId);
    let count = 0;
    for (const m of messages) {
      const id = m.info.id;
      if (typeof id !== "string" || id === "") continue;
      const role = typeof m.info.role === "string" ? m.info.role : undefined;
      if (role !== undefined) this.#roles.set(id, role);
      if (this.#emitted.has(id)) continue; // already emitted on a prior connection's backfill / live
      // Seed the buffer from the history parts (shared with the live path: coalesce + later flush).
      for (const part of m.parts) {
        if (part && typeof part.id === "string") this.#bufferPart(id, part);
      }
      // An INCOMPLETE assistant message (mid-turn attach) is left BUFFERED, not flushed — the live
      // completion flushes the full text. Everything else (a completed assistant, or a user message that
      // has no `completed` flag) flushes now via the shared path (dedup + coalesce + local_prompt origin).
      if (role === "assistant" && m.info.time?.completed === undefined) {
        this.#tracer.debug("backfill: buffering incomplete assistant for live completion", { id });
        continue;
      }
      const before = session.snapshotUpstream().length;
      this.#flushMessage(session, id);
      if (session.snapshotUpstream().length > before) count++;
    }
    if (count > 0) this.#tracer.info("history backfilled", { messages: count });
  }

  /**
   * CAPTURE: subscribe to GET /event (filtered to our ses_), buffer parts per messageID, and flush a
   * COMPLETED message to pushUpstream ONCE (review #1 coalesce, #2 dedup). Completion is signalled by
   * `session.idle` (turn end) or an assistant `message.updated` carrying `time.completed`.
   *
   * RECONNECT LOOP (review #2, CRITICAL): the SSE connection can EOF/error transiently (a proxy timeout,
   * the server restarting, a dropped TCP). A single subscription ending used to end run() → teardown →
   * client.abort(), CANCELLING the user's active OpenCode turn. Instead we wrap one connection in a loop
   * that RECONNECTS with capped backoff and ONLY ends when the parent signal aborts. Each (re)connect
   * re-runs backfill on its first event (deduped by #emitted; with fix #1 an incomplete assistant
   * re-seeds and completes live) — subscribe-first, lossless, no truncation/dup across reconnects.
   */
  async #capturePump(session: Session, ocSessionId: string, signal: AbortSignal): Promise<void> {
    let backoffMs = RECONNECT_BACKOFF_MIN_MS;
    while (!signal.aborted) {
      try {
        await this.#captureConnection(session, ocSessionId, signal);
        // A clean EOF (the generator returned). If the parent hasn't aborted, this was a transient close
        // — reconnect immediately (reset backoff; a healthy connection lived its life).
        backoffMs = RECONNECT_BACKOFF_MIN_MS;
      } catch (e) {
        // A connect/transport error (the server is down / restarting). Back off before retrying so we
        // don't hot-loop; the parent abort still wins (the sleep is abort-aware).
        if (signal.aborted) return;
        this.#tracer.warn("opencode SSE connection dropped; reconnecting", {
          error: String(e),
          backoffMs,
        });
      }
      if (signal.aborted) return;
      // Mark the bridge as "reconnecting" so presence reflects the gap rather than a stale "running".
      session.workerStatus = "idle";
      session.wake();
      await sleepAbortable(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
    }
  }

  /** Drive ONE SSE connection (one `events()` generator): backfill on the first event, then dispatch.
   *  Returns on a clean EOF, throws on a transport error — #capturePump decides whether to reconnect. */
  async #captureConnection(
    session: Session,
    ocSessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let backfilled = false;
    for await (const ev of this.#client.events(ocSessionId, signal)) {
      if (signal.aborted) return;
      if (!backfilled) {
        // The SSE is now LIVE (we received the first event — OpenCode sends `server.connected` on
        // connect). Backfill history NOW, before handling any live data event, so prior turns land
        // first and NOTHING is lost to a backfill-then-subscribe gap; #emitted dedups any message that
        // also appears in the live stream (and is re-run on EACH reconnect — review #2). Best-effort: a
        // backfill failure must not stop the bridge.
        backfilled = true;
        try {
          await this.#backfillHistory(session, ocSessionId);
        } catch (e) {
          this.#tracer.warn("opencode history backfill failed", { error: String(e) });
        }
        session.workerStatus = "running";
        session.wake();
        if (ev.type === "server.connected") continue; // pure marker — nothing to process
      }
      this.#onEvent(session, ev);
    }
  }

  /** Route one OpenCode SSE event. Pure dispatch — all the buffering/coalescing lives in the helpers. */
  #onEvent(session: Session, ev: OpencodeEvent): void {
    switch (ev.type) {
      case "message.part.updated": {
        const part = ev.properties.part;
        if (part && typeof part.messageID === "string") {
          this.#bufferPart(part.messageID, part);
        }
        break;
      }
      case "message.part.removed": {
        // A dropped part: forget it so it doesn't render in the eventual flush.
        const part = ev.properties.part;
        if (part && typeof part.messageID === "string" && typeof part.id === "string") {
          this.#buffers.get(part.messageID)?.parts.delete(part.id);
        }
        break;
      }
      case "message.updated": {
        const info = ev.properties.info;
        if (typeof info?.id === "string" && typeof info.role === "string") {
          this.#roles.set(info.id, info.role);
        }
        // The user message never carries time.completed (verified live) — it's settled the moment the
        // model starts responding. So when an ASSISTANT message appears, flush any buffered USER messages
        // FIRST: the prompt (the local_prompt frame) must precede the assistant reply in the transcript.
        if (info?.role === "assistant") this.#flushBufferedUsers(session);
        // An assistant message with time.completed is done — flush it now (don't wait for idle, so a
        // multi-message turn surfaces each message as it completes).
        if (info?.role === "assistant" && typeof info.id === "string" && info.time?.completed) {
          this.#flushMessage(session, info.id);
        }
        break;
      }
      case "session.status": {
        const status = ev.properties.status?.type;
        // "busy"/"running" → thinking; anything else → idle. The relay's phaseFor reads running/busy.
        session.workerStatus = status === "busy" || status === "running" ? "running" : "idle";
        session.wake();
        break;
      }
      case "session.idle": {
        // Turn complete: flush every still-buffered message, then mark idle.
        for (const id of [...this.#buffers.keys()]) this.#flushMessage(session, id);
        session.workerStatus = "idle";
        session.wake();
        break;
      }
      case "permission.asked":
        this.#onPermissionAsked(session, ev);
        break;
      case "server.heartbeat":
      case "server.connected":
        session.wake(); // keep presence fresh
        break;
      default:
        break; // session.created/updated/diff/etc. — not relayed
    }
  }

  /** Flush every buffered message whose KNOWN role is "user". Called when an assistant message begins so
   *  a local prompt surfaces BEFORE the assistant's reply (a user message never gets time.completed). A
   *  buffered message of unknown/assistant role is left for its own completion/idle flush. */
  #flushBufferedUsers(session: Session): void {
    for (const id of [...this.#buffers.keys()]) {
      if (this.#roles.get(id) === "user") this.#flushMessage(session, id);
    }
  }

  /** Buffer (or replace) a whole part under its messageID. OpenCode re-sends the whole part, so a later
   *  update for the same partID REPLACES the earlier one — that's the coalesce. */
  #bufferPart(messageId: string, part: Part): void {
    if (this.#emitted.has(messageId)) return; // already flushed — ignore late/duplicate parts (#2)
    let buf = this.#buffers.get(messageId);
    if (!buf) {
      buf = { parts: new Map(), order: [] };
      this.#buffers.set(messageId, buf);
    }
    if (!buf.parts.has(part.id)) buf.order.push(part.id);
    buf.parts.set(part.id, part);
  }

  /** Flush ONE completed message: coalesce its buffered parts and pushUpstream ONCE. Dedups by messageID
   *  (#2) and clears the buffer. Routing by role:
   *   • assistant → an `assistant` (and, for completed tools, a `user` tool_result) payload (coalesce #1).
   *   • user that WE injected → SUPPRESSED (the relay's inbound pump already echoed the viewer prompt;
   *     pushing our echo would double it). We consume one matching entry from #injectedTexts.
   *   • user we did NOT inject (TUI / another client / history) → a `local_prompt` `user` payload so it
   *     shows in the web viewer (the relay's local_prompt branch renders it without double-echoing).
   *   • unknown role → defaults to the assistant path so a real turn is never silently lost. */
  #flushMessage(session: Session, messageId: string): void {
    if (this.#emitted.has(messageId)) return; // DEDUP (#2): never emit a message twice
    const buf = this.#buffers.get(messageId);
    if (!buf) return;
    this.#buffers.delete(messageId);
    this.#emitted.add(messageId);
    const parts = buf.order
      .map((id) => buf.parts.get(id))
      .filter((p): p is Part => p !== undefined);

    if (this.#roles.get(messageId) === "user") {
      const text = userPartsText(parts);
      if (text !== "" && this.#consumeInjected(text)) return; // our own echo — suppress
      if (text === "") return; // an empty/synthetic-only user message — nothing to surface
      // A LOCAL prompt (typed at the OpenCode TUI / another client / history). Surface it as a
      // local_prompt `user` payload so the web viewer renders it (relay.ts local_prompt branch).
      session.pushUpstream({
        type: "user",
        uuid: messageId,
        local_prompt: true,
        message: { role: "user", content: text },
      });
      this.#tracer.debug("surfaced local prompt", { messageId, bytes: text.length });
      return;
    }

    const payloads = coalesceMessage(messageId, parts);
    for (const p of payloads) {
      session.pushUpstream(p as unknown as Record<string, unknown>); // COALESCE (#1): once per message
    }
    if (payloads.length > 0) {
      this.#tracer.debug("flushed message", { messageId, payloads: payloads.length });
    }
  }

  /** Record a prompt text the inject pump sent (multiset += 1) so its OpenCode user-message echo is
   *  suppressed when it flushes. */
  #recordInjected(text: string): void {
    this.#injectedTexts.set(text, (this.#injectedTexts.get(text) ?? 0) + 1);
  }

  /** Roll back a recorded injected-text entry (multiset -= 1) when the prompt POST FAILED so no echo will
   *  arrive (review #3). Symmetric with #recordInjected; the count never goes negative. */
  #unrecordInjected(text: string): void {
    const n = this.#injectedTexts.get(text) ?? 0;
    if (n <= 1) this.#injectedTexts.delete(text);
    else this.#injectedTexts.set(text, n - 1);
  }

  /** Consume one injected-text entry matching `text`. Returns true (and decrements) if this user message
   *  is the echo of a prompt WE injected — caller suppresses it. False ⇒ a local/foreign prompt. */
  #consumeInjected(text: string): boolean {
    const n = this.#injectedTexts.get(text) ?? 0;
    if (n <= 0) return false;
    if (n === 1) this.#injectedTexts.delete(text);
    else this.#injectedTexts.set(text, n - 1);
    return true;
  }

  /**
   * INJECT: drain followDownstream(claimWorkerStream(), () => signal.aborted). For each event:
   *   • initialize control_request → ack immediately (we're "ready"; no OpenCode handshake needed).
   *   • user → prompt_async with the active model, THEN ack.
   *   • control_request interrupt → abort; set_model → remember; set_mode/end → safe no-op; then ack.
   *   • control_response (a permission answer) → POST the OpenCode permissions reply, then ack.
   * ACK (review #5) is called after EVERY successful inject so a reclaimed stream doesn't replay.
   */
  async #injectPump(session: Session, ocSessionId: string, signal: AbortSignal): Promise<void> {
    const gen = session.claimWorkerStream();
    for await (const ev of session.followDownstream(gen, () => signal.aborted)) {
      if (signal.aborted) return;
      if (ev === null) continue; // heartbeat tick
      try {
        await this.#inject(session, ocSessionId, ev);
        session.ack(ev.eventId); // (#5) suppress replay for this id on a future reclaimed stream
      } catch (e) {
        // A transient inject failure: do NOT ack (so a reconnect can retry), log, and keep draining.
        this.#tracer.warn("inject failed", { type: ev.eventType, error: String(e) });
      }
    }
  }

  /** Map ONE downstream event to an OpenCode action. Throws on a transport failure so #injectPump can
   *  withhold the ack and retry; returns normally (no ack-blocking) for control verbs it safely no-ops. */
  async #inject(
    session: Session,
    ocSessionId: string,
    ev: { eventType: string; payload: Record<string, unknown> },
  ): Promise<void> {
    if (ev.eventType === "user") {
      const text = userText(ev.payload);
      if (text === "") return; // nothing to inject — still acked (an empty prompt is "handled")
      // Record the text BEFORE the POST so its OpenCode user-message echo (which can arrive on the SSE
      // before promptAsync even resolves) is recognized as OURS and suppressed (#flushMessage), not
      // double-rendered as a local_prompt.
      this.#recordInjected(text);
      try {
        await this.#client.promptAsync(ocSessionId, { text, model: this.#activeModel });
      } catch (e) {
        // The POST failed: no echo will ever arrive for this text, so the recorded suppression token would
        // leak — a LATER identical local prompt would be falsely suppressed (and #injectedTexts would grow
        // unboundedly). Roll the token back, then re-throw so #injectPump withholds the ack and retries
        // (review #3). The retry re-records before re-POSTing, so the multiset stays correct.
        this.#unrecordInjected(text);
        throw e;
      }
      session.workerStatus = "running";
      session.wake();
      this.#tracer.debug("injected prompt", { bytes: text.length });
      return;
    }
    if (ev.eventType === "control_request") {
      const req = ev.payload.request as { subtype?: string; model?: unknown } | undefined;
      const sub = req?.subtype;
      if (sub === "initialize") return; // we're ready immediately; just ack it
      if (sub === "interrupt") {
        await this.#client.abort(ocSessionId);
        return;
      }
      if (sub === "set_model") {
        // Remember for the next prompt_async. OpenCode's model is {providerID, modelID}; the viewer sends
        // an opaque model string. Best-effort: accept a "providerID/modelID" form, else keep current.
        const m = typeof req?.model === "string" ? req.model : "";
        const slash = m.indexOf("/");
        if (slash > 0) {
          this.#activeModel = { providerID: m.slice(0, slash), modelID: m.slice(slash + 1) };
          this.#tracer.debug("set_model", { ...this.#activeModel });
        }
        return;
      }
      // set_permission_mode / end / any other verb: safe no-op (review #4 — never throw on an
      // unsupported verb; the viewer still emits these regardless of capabilities).
      return;
    }
    if (ev.eventType === "control_response") {
      await this.#replyPermission(ocSessionId, ev.payload);
      return;
    }
    // Any other downstream event type: nothing to inject.
  }

  /** Surface an OpenCode `permission.asked` as the relay's `can_use_tool` control_request — the exact
   *  shape mapUpstreamItems renders as a permission_request. Idempotent at the relay (request_id). */
  #onPermissionAsked(session: Session, ev: OpencodeEvent): void {
    const p = ev.properties;
    const requestId = typeof p.id === "string" ? p.id : "";
    if (requestId === "") return;
    session.pushUpstream({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: typeof p.permission === "string" ? p.permission : "tool",
        input: p.metadata ?? null, // relay reads `input` (real-claude shape)
        tool_use_id: typeof p.tool?.callID === "string" ? p.tool.callID : "",
        request_id: requestId, // relay fallback gate id (review #3)
      },
    });
    this.#tracer.debug("permission gate surfaced", { requestId, tool: p.permission });
  }

  /** Map a relay control_response (the viewer's permission answer) to an OpenCode permissions reply.
   *  allow → "once", deny → "reject". The control_response payload carries response.request_id +
   *  response.response.behavior (pushControlResponse's shape). */
  async #replyPermission(ocSessionId: string, payload: Record<string, unknown>): Promise<void> {
    const resp = payload.response as
      | { request_id?: unknown; response?: { behavior?: unknown } }
      | undefined;
    const requestId = typeof resp?.request_id === "string" ? resp.request_id : "";
    if (requestId === "") return;
    const behavior = resp?.response?.behavior;
    const reply = behavior === "deny" ? "reject" : "once";
    await this.#client.replyPermission(ocSessionId, requestId, reply);
    this.#tracer.debug("permission replied", { requestId, reply });
  }
}

/** Resolve when `signal` aborts (the pump-coupling sentinel in run()'s Promise.race). */
function waitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** Sleep `ms`, but resolve EARLY if `signal` aborts (the reconnect-backoff wait — review #2). Never
 *  rejects: the caller re-checks signal.aborted after it returns. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Entry point the dispatcher calls: construct the driver and run it. Mirrors runRcLaunch's signature
 *  (resolve with an exit code; tear down on abort). The caller (run.ts) builds the DriverContext. */
export function runOpencodeDriver(ctx: DriverContext, signal: AbortSignal): Promise<number> {
  return new OpencodeDriver(ctx).run(signal);
}

// Re-export the client so the wiring/tests can construct/ inject one without reaching into ./client.
export { OpencodeClient } from "./client.js";
export type { BrokerClient };
