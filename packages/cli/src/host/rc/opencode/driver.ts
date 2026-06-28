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
// SUB-AGENTS (Task) ARE BRIDGED (#102). OpenCode spawns a Task/subagent as a CHILD session
// (Session.parentID → the parent) and emits a `subtask` part on the parent message. translate.ts renders
// that part as a `Task` tool_use ANCHOR; the driver FOLLOWS the child session on the same server-wide SSE
// (the events() predicate adds it on `session.created`) and tags the child's assistant messages with
// parent_tool_use_id = the subtask part's id, so the viewer NESTS them under the Task — like native RC.
//   • V1 correlation limit: the subtask part carries no child session id (opencode links the child only
//     via parentID), so a child is matched to its Task by parent+agent+FIFO order. With CONCURRENT
//     same-agent subtasks from one parent the pairing can swap — a display-only mis-nest, never a dropped
//     message (an unmatched child just stays top-level). Revisit if opencode exposes a part→child id link.
//
// OTHER V1 LIMITATIONS (documented, intentional — not bugs):
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
  eventSessionId,
  type HistoryMessage,
  OpencodeClient,
  type OpencodeClientOptions,
  type OpencodeEvent,
  type OpencodeModel,
  type PermissionRule,
} from "./client.js";
import {
  coalesceMessage,
  type Part,
  type SubtaskPart,
  userPartsText,
  userText,
} from "./translate.js";

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
  /** MIRROR tool permissions to the viewer (B2 parity, DEFAULT ON). When on, the driver PATCHes the
   *  bridged session (and each followed child) into "ask" mode so every tool raises a `permission.asked`
   *  gate the viewer answers — instead of opencode's default auto-run. Off (`--rc-oc-skip-permissions`)
   *  leaves the session's own permission config untouched (today's behavior). */
  mirrorPermissions?: boolean;
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
  if (typeof extra.mirrorPermissions === "boolean") out.mirrorPermissions = extra.mirrorPermissions;
  if (extra.client instanceof OpencodeClient) out.client = extra.client;
  const m = extra.model as { providerID?: unknown; modelID?: unknown } | undefined;
  if (m && typeof m.providerID === "string" && typeof m.modelID === "string") {
    out.model = { providerID: m.providerID, modelID: m.modelID };
  }
  return out;
}

/** The permission rules the driver PATCHes onto the bridged session when mirroring is on. A single
 *  wildcard rule gates EVERY tool (verified live against opencode 1.17.5 — bash fired on the first try),
 *  so we don't have to enumerate per-tool categories. */
const ASK_PERMISSION_RULES: readonly PermissionRule[] = [
  { permission: "*", pattern: "*", action: "ask" },
];

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

/** Best-effort human-readable text from a `session.error` payload (OpenCode sends `error.toObject()`,
 *  typically `{ name, data: { message } }`, but shapes vary by provider). Falls back through message →
 *  name → JSON so the viewer always gets SOMETHING rather than a silent failure. Exported for unit tests
 *  (it backs BOTH the session.error result frame and the failed-/compact result frame). */
export function errText(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { message?: unknown; name?: unknown; data?: { message?: unknown } };
    if (typeof e.data?.message === "string" && e.data.message !== "") return e.data.message;
    if (typeof e.message === "string" && e.message !== "") return e.message;
    if (typeof e.name === "string" && e.name !== "") return e.name;
    try {
      return JSON.stringify(error);
    } catch {
      return "unknown error";
    }
  }
  return String(error);
}

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
  /** Capabilities. structuredPermissions reflects whether mirroring is ON (default): on, the driver
   *  PATCHes the session to "ask" and round-trips each gate; off, opencode auto-runs tools (no gate). */
  readonly capabilities: DriverCapabilities;

  readonly #ctx: DriverContext;
  readonly #extra: OpencodeExtra;
  /** Mirror tool permissions to the viewer (default on; `--rc-oc-skip-permissions` opts out). */
  readonly #mirror: boolean;
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

  // ── Sub-agent (Task) bridging (#102) ──────────────────────────────────────────────────────────────
  // OpenCode spawns a Task/subagent as a CHILD session (Session.parentID → the parent) and emits a
  // `subtask` part on the parent message (rendered as a Task tool_use anchor in translate.ts). We FOLLOW
  // child sessions on the same server-wide SSE and tag their assistant messages with parent_tool_use_id =
  // the spawning subtask part's id, so the viewer NESTS them under the Task — like native RC.
  /** OpenCode session ids this driver captures: the main session + every followed child. The events()
   *  predicate reads this live, so adding a child here makes the running SSE start delivering its events. */
  readonly #followed = new Set<string>();
  /** The MAIN bridged session id — only ITS status/idle events drive the relay's workerStatus (a child
   *  going idle must not flip the bridge idle while the parent is still waiting on the subagent). */
  #mainSessionId = "";
  /** child OpenCode sessionID → the spawning subtask part's id (the Task tool_use anchor). A message from
   *  a followed child is tagged parent_tool_use_id = this so it nests under the Task. Bounded (review #6). */
  readonly #childTag = new BoundedMap<string>(DEFAULT_EMITTED_CAP);
  /** messageID → the OpenCode sessionID it belongs to (from the part/info sessionID), so flush can look up
   *  the child tag for a message buffered across sessions. Bounded (review #6). */
  readonly #msgSession = new BoundedMap<string>(DEFAULT_EMITTED_CAP);
  /** (parentSession, agent) key → FIFO queue of subtask part ids awaiting their child session. A
   *  `session.created` with a matching parentID+agent pops the oldest (the subtask part carries no child id
   *  — opencode links the child only via Session.parentID, verified vs GET /doc — so we correlate by
   *  parent+agent+order). Keyed by parent (not agent alone) so concurrent same-agent Tasks from different
   *  parents don't cross-tag. Only LIVE anchors are enqueued (backfill is excluded — see #onEvent). */
  readonly #pendingSubtasks = new Map<string, string[]>();
  /** subtask part ids already enqueued, so a re-sent `message.part.updated` (opencode resends whole parts)
   *  doesn't enqueue the same anchor twice. Bounded (review #6). */
  readonly #notedSubtasks = new BoundedSet(DEFAULT_EMITTED_CAP);

  constructor(ctx: DriverContext) {
    this.#ctx = ctx;
    this.#extra = readExtra(ctx.extra);
    this.#mirror = this.#extra.mirrorPermissions ?? true; // DEFAULT ON (tmux parity)
    this.capabilities = {
      // Mirroring on → we PATCH the session to "ask" and round-trip each gate (structured permissions).
      // Off → opencode auto-runs tools, so there is no gate to surface.
      structuredPermissions: this.#mirror,
      // session.status / session.idle drive a real workerStatus.
      status: true,
      // interrupt → abort; set_model is remembered for the next prompt; end/set_mode safely no-op.
      controlVerbs: true,
      // Attachments are relay-owned (the driver only sees the resulting downstream `user` prompt).
      attachments: true,
    };
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

    // PERMISSION MIRRORING (default on): flip the bridged session into "ask" mode so every tool raises a
    // `permission.asked` gate the viewer answers (opencode auto-runs tools otherwise — the gate plumbing
    // below would never fire). Best-effort: a failure here must NOT abort the bridge (the session still
    // works, just without remote gating), so log + continue. Child sub-agent sessions are PATCHed when
    // we start following them (see the session.created handler).
    if (this.#mirror) {
      try {
        await this.#client.setSessionPermission(ocSessionId, [...ASK_PERMISSION_RULES]);
        this.#tracer.info("opencode permission mirroring on (session set to ask)", { ocSessionId });
      } catch (e) {
        this.#tracer.warn("could not set opencode session to ask mode — mirroring inactive", {
          ocSessionId,
          error: String(e),
        });
      }
    }

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
      // Seed the buffer from the history parts (shared with the live path: coalesce + later flush). The
      // backfilled session (ocSessionId — main OR a followed child) is the authoritative message owner.
      for (const part of m.parts) {
        if (part && typeof part.id === "string") this.#bufferPart(id, part, ocSessionId);
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
    // Seed the followed-session set with the main session; child sub-agent sessions are added live as
    // `session.created` events with a matching parentID arrive (#102). Children persist across reconnects.
    this.#mainSessionId = ocSessionId;
    this.#followed.add(ocSessionId);
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
    // Follow the main session AND any child sub-agent sessions added to #followed live (#102). The
    // predicate reads #followed each event, so a child added mid-stream starts being delivered at once.
    for await (const ev of this.#client.events(
      (id) => id !== undefined && this.#followed.has(id),
      signal,
    )) {
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
          // Re-backfill any IN-FLIGHT followed child sub-agent sessions too: GET /event has no replay, so a
          // child that produced output during the SSE drop would otherwise be lost (codex review). #emitted
          // dedups what already landed, and finished children were unfollowed on their session.idle, so this
          // set holds only still-running children — small. On the FIRST connect #followed is just the main
          // (no children yet), so this is a no-op then. (#102)
          for (const childId of [...this.#followed]) {
            if (childId === this.#mainSessionId) continue;
            try {
              await this.#backfillHistory(session, childId);
            } catch (e) {
              this.#tracer.warn("opencode child backfill failed", {
                childId,
                error: String(e),
              });
            }
          }
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
    // Which OpenCode session this event is for (main or a followed child) — drives per-session status/idle
    // routing so a child going idle doesn't flip the whole bridge idle while the parent waits (#102).
    // Shared derivation with the client filter (eventSessionId) so the two never drift. (undefined for
    // session.created — that case reads info.id/parentID directly below.)
    const evSession = eventSessionId(ev.properties);
    switch (ev.type) {
      case "message.part.updated": {
        const part = ev.properties.part;
        if (part && typeof part.messageID === "string") {
          // Record the message→session map from the EVENT's session (authoritative; the part's own
          // sessionID field may be absent — codex review). For a child part this is the child session.
          this.#bufferPart(part.messageID, part, evSession);
          // Note a subtask anchor ONLY on the LIVE stream, keyed by the PARENT (= this event's session).
          // Backfill must NOT enqueue historical anchors — their children already exist, so a stale anchor
          // would be popped by the next same-agent child and mis-nest it (codex review).
          if (part.type === "subtask" && evSession !== undefined) {
            this.#noteSubtask(part as SubtaskPart, evSession);
          }
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
      case "session.created": {
        // A new session: if it's a CHILD of one we follow (Session.parentID ∈ #followed), follow it and
        // map it to the spawning subtask part (by parent+agent+order) so its messages nest under the Task
        // tool_use anchor in the viewer (#102). The subtask part carries no child id — opencode links the
        // child only via parentID — so this parent+agent+FIFO correlation is the available mechanism.
        const info = ev.properties.info as
          | { id?: string; parentID?: string; agent?: string }
          | undefined;
        const childId = info?.id;
        const parentId = info?.parentID;
        if (
          typeof childId === "string" &&
          typeof parentId === "string" &&
          this.#followed.has(parentId)
        ) {
          this.#followed.add(childId);
          // Mirror permissions on the child too (best-effort, fire-and-forget) so sub-agent tool calls
          // raise gates like the parent's — a child may not inherit the parent's per-session ask rules.
          if (this.#mirror) {
            void this.#client
              .setSessionPermission(childId, [...ASK_PERMISSION_RULES])
              .catch((e) => {
                this.#tracer.warn("could not set child session to ask mode", {
                  childId,
                  error: String(e),
                });
              });
          }
          // Pair to the spawning subtask anchor by (PARENT session, agent) FIFO — keying by agent alone
          // would let two parents spawning the same agent steal each other's anchors (codex review).
          const agent = typeof info?.agent === "string" ? info.agent : "";
          const prt = this.#takePendingSubtask(parentId, agent);
          if (prt !== undefined) this.#childTag.set(childId, prt);
          this.#tracer.info("following child sub-agent session", {
            childId,
            parentId,
            agent: info?.agent,
            taskAnchor: prt ?? null,
          });
        }
        break;
      }
      case "session.status": {
        // Only the MAIN session's status drives the bridge's workerStatus — a child going busy/idle must
        // not flip presence while the parent is mid-turn waiting on the subagent (#102).
        if (evSession === this.#mainSessionId) {
          const status = ev.properties.status?.type;
          // "busy"/"running" → thinking; anything else → idle. The relay's phaseFor reads running/busy.
          session.workerStatus = status === "busy" || status === "running" ? "running" : "idle";
          session.wake();
        }
        break;
      }
      case "session.idle": {
        // Turn complete for THIS session: flush only ITS still-buffered messages (a child idle must not
        // prematurely flush the parent's in-flight message). Only the main idle marks the bridge idle.
        this.#flushSessionBuffers(session, evSession);
        if (evSession === this.#mainSessionId) {
          session.workerStatus = "idle";
          session.wake();
        } else if (evSession !== undefined && this.#followed.has(evSession)) {
          // A followed CHILD finished: drop it from the follow-set AFTER flushing its buffers, so #followed
          // (the one unbounded structure) stays bounded by IN-FLIGHT children, not lifetime children (codex
          // review). Its tag in #childTag (a BoundedMap) is harmless once unfollowed and ages out.
          this.#followed.delete(evSession);
          this.#tracer.debug("unfollowed finished child sub-agent", { childId: evSession });
        }
        break;
      }
      case "session.error": {
        // A run FAILED (provider 5xx, bad model, OOM, …). Flush THIS session's partials first, then surface
        // the error as a `result` frame so the viewer SHOWS the failure AND leaves the "working" state —
        // otherwise it just flips idle with no explanation (the documented contract). Only the main error
        // flips the bridge idle; a child sub-agent error is surfaced but doesn't end the parent turn (#102).
        this.#flushSessionBuffers(session, evSession);
        const msg = errText(ev.properties.error);
        this.#tracer.warn("session.error", { error: msg, session: evSession });
        session.pushUpstream({ type: "result", result: `⚠ OpenCode error: ${msg}` });
        if (evSession === this.#mainSessionId) {
          session.workerStatus = "idle";
          session.wake();
        }
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
        break; // session.updated/diff/next.*/etc. — not relayed
    }
  }

  /** Flush every buffered message that belongs to `evSession` (its recorded session, defaulting to the
   *  main session for an untagged message). Shared by session.idle and session.error so a child's
   *  idle/error flushes ONLY its own in-flight messages — never the parent's (#102). */
  #flushSessionBuffers(session: Session, evSession: string | undefined): void {
    for (const id of [...this.#buffers.keys()]) {
      if ((this.#msgSession.get(id) ?? this.#mainSessionId) === evSession) {
        this.#flushMessage(session, id);
      }
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
   *  update for the same partID REPLACES the earlier one — that's the coalesce. `ocSession` is the EVENT's
   *  session (the authoritative owner of this message — see #onEvent / #backfillHistory). */
  #bufferPart(messageId: string, part: Part, ocSession?: string): void {
    if (this.#emitted.has(messageId)) return; // already flushed — ignore late/duplicate parts (#2)
    // Record which OpenCode session this message belongs to so flush can look up its Task nesting tag. The
    // EVENT's session (ocSession) is authoritative — the part's own `sessionID` field is absent on some
    // shapes, which would otherwise mis-file a child message under the main session (codex review). Fall
    // back to the part field, then leave unset (flush defaults the message to the main session). (#102)
    const sid = ocSession ?? (part as { sessionID?: string }).sessionID;
    if (typeof sid === "string" && sid !== "") this.#msgSession.set(messageId, sid);
    // (subtask anchors are noted on the LIVE message.part.updated path in #onEvent, NOT here — so backfill
    // doesn't enqueue stale historical anchors that would mis-nest the next same-agent child. #102/codex.)
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

    // Is this message from a followed CHILD sub-agent session? If so, nest it under its spawning Task by
    // tagging parent_tool_use_id = the subtask part's id (#102). undefined → a top-level (main) message.
    const ocSession = this.#msgSession.get(messageId) ?? this.#mainSessionId;
    const childTag = this.#childTag.get(ocSession);

    if (this.#roles.get(messageId) === "user") {
      // A followed CHILD (non-main) session's user message is the subagent's INTERNAL prompt (the Task
      // input) — already shown via the Task tool_use anchor's `prompt`. Suppress it whether or not we
      // managed to TAG the child: an untagged child (e.g. its session.created raced ahead of the subtask
      // part) still must not leak its internal prompt as a top-level local_prompt (codex review). (#102)
      if (ocSession !== this.#mainSessionId && this.#followed.has(ocSession)) return;
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

    const payloads = coalesceMessage(
      messageId,
      parts,
      childTag !== undefined ? { parentToolUseId: childTag } : {},
    );
    for (const p of payloads) {
      session.pushUpstream(p as unknown as Record<string, unknown>); // COALESCE (#1): once per message
    }
    if (payloads.length > 0) {
      this.#tracer.debug("flushed message", {
        messageId,
        payloads: payloads.length,
        ...(childTag !== undefined ? { nestedUnder: childTag } : {}),
      });
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

  /** Note a `subtask` part seen on a PARENT message: enqueue its id under (parentSession, agent) so the
   *  child session it spawns — correlated by parentID+agent+FIFO order — can be tagged to nest under this
   *  Task. Keyed by the PARENT session (not agent alone) so two parents spawning the same agent can't steal
   *  each other's anchors (codex review). Idempotent across re-sent parts (#notedSubtasks dedups by id). */
  #noteSubtask(part: SubtaskPart, parentSession: string): void {
    if (typeof part.id !== "string" || part.id === "" || this.#notedSubtasks.has(part.id)) return;
    this.#notedSubtasks.add(part.id);
    const agent = typeof part.agent === "string" ? part.agent.trim() : "";
    const key = pendingKey(parentSession, agent);
    const q = this.#pendingSubtasks.get(key) ?? [];
    q.push(part.id);
    this.#pendingSubtasks.set(key, q);
  }

  /** Pop the oldest pending subtask-part id for (parentSession, agent) FIFO — the Task anchor for a just-
   *  created child of that agent under that parent. Returns undefined if none pending (the child nests
   *  nothing → its messages stay top-level, the safe fallback). Agent is trimmed to match #noteSubtask so a
   *  stray whitespace difference between the part and the session.created doesn't orphan the child (codex). */
  #takePendingSubtask(parentSession: string, agent: string): string | undefined {
    const key = pendingKey(parentSession, agent.trim());
    const q = this.#pendingSubtasks.get(key);
    if (q === undefined || q.length === 0) return undefined;
    const prt = q.shift();
    if (q.length === 0) this.#pendingSubtasks.delete(key);
    return prt;
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
      // A blank prompt (empty OR whitespace-only — a human who hit send on spaces / a stray newline) is
      // a no-op, not a burned model turn. Still acked (it's "handled").
      if (text.trim() === "") return;
      // Slash-command routing (documented): `/compact` runs OpenCode's native summarize endpoint rather
      // than feeding the literal string to the model. Other slash commands pass through as a prompt.
      if (text.trim() === "/compact") {
        // Dispatch summarize WITHOUT awaiting it (codex review): OpenCode's summarize endpoint runs the
        // whole compaction turn server-side before returning, so awaiting it here would BLOCK the serial
        // inject pump — a queued `interrupt` couldn't fire until compaction finished — and delay the ack,
        // so a reconnect could replay `/compact` and start a SECOND compaction. Fire-and-forget (errors
        // logged); the compaction's output arrives over the SSE like any turn, and the pump stays free.
        session.workerStatus = "running";
        session.wake();
        this.#client.summarize(ocSessionId, this.#activeModel).catch((e) => {
          // The dispatch failed before any server-side turn started, so NO session.status/session.error
          // will ever arrive to clear the "running" we just set — and the downstream event is already
          // acked (fire-and-forget), so a reconnect can't retry. Surface the failure as a result frame
          // and drop back to idle ourselves, exactly like the session.error path (codex review).
          const msg = errText(e);
          this.#tracer.warn("summarize failed", { error: msg });
          session.pushUpstream({ type: "result", result: `⚠ OpenCode error: ${msg}` });
          session.workerStatus = "idle";
          session.wake();
        });
        this.#tracer.debug("routed /compact → summarize (dispatched)");
        return;
      }
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
    // Fail CLOSED: only an explicit "allow" → "once"; anything else (deny, or a malformed/absent behavior)
    // → "reject", so a garbled control_response can never auto-approve a tool. The relay normalizes
    // behavior to allow|deny before this, so a real viewer grant is always "allow".
    const behavior = resp?.response?.behavior;
    const reply = behavior === "allow" ? "once" : "reject";
    await this.#client.replyPermission(ocSessionId, requestId, reply);
    this.#tracer.debug("permission replied", { requestId, reply });
  }
}

/** Compose the #pendingSubtasks key from a parent session id + agent name. A NUL joiner can't appear in
 *  either field, so distinct (parent, agent) pairs never collide. */
function pendingKey(parentSession: string, agent: string): string {
  return `${parentSession} ${agent}`;
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
