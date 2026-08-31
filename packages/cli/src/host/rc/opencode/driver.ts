// The OpenCode driver: bridges an `opencode serve` session to our broker via the SAME Session/relay
// contract the MITM uses (driver.ts seam). It does NOT stand up the MITM — it talks straight to the
// OpenCode HTTP+SSE server. Startup creates a private compatibility Session, proves the frozen native
// tuple and one exact caller-selected session, then subscribes and reconciles bounded history before
// one readiness latch starts the broker bridge and the concurrent CAPTURE + INJECT pumps.
//
// The three driver obligations from the adversarial review (driver.ts "DRIVER OBLIGATIONS") are the
// load-bearing logic here:
//   #1 COALESCE  — OpenCode re-sends a whole part on every message.part.updated; the relay mints a fresh
//                  transcript seq per pushUpstream. So we BUFFER parts per messageID and pushUpstream
//                  ONCE per completed message (on session.idle / an assistant message.updated with
//                  time.completed), never per part.updated.
//   #2 DEDUP     — re-pushing a uuid does NOT dedup at the relay. One projection-long bounded ledger
//                  admits each immutable native message coordinate once and rejects changed reuse.
//   #5 ACK       — followDownstream only suppresses replay for ids in #acked; a non-MITM driver has no
//                  /worker/events/delivery. Browser text is ACKed only after exact marker+full-text
//                  correlation in native capture; supported controls are ACKed after their one native
//                  transport response, and initialize after its no-op. None is a durable native receipt.
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
//   • RELAY DEATH closes only the compatibility projection. It never aborts the externally owned native
//     turn or stops the OpenCode server. A wrapper restart intentionally creates a fresh projection and
//     observes the same bounded native history without replaying commands from the old broker session.

import type { BrokerClient } from "../../../broker/client.js";
import { type Tracer, tracerFromEnv } from "../../../trace.js";
import {
  type Driver,
  type DriverCapabilities,
  type DriverContext,
  OPENCODE_HARNESS,
} from "../driver.js";
import { ReadyBridge } from "../drivers/ready-bridge.js";
import { type RcEvent, RelayCore, type Session } from "../session.js";
import {
  DEFAULT_OPENCODE_URL,
  eventSessionId,
  type HistoryMessage,
  isOpencodeMessageId,
  isOpencodeSessionId,
  isValidOpencodeMessageInfo,
  isValidOpencodePart,
  OPENCODE_HISTORY_LIMIT,
  OpencodeClient,
  type OpencodeClientOptions,
  OpencodeError,
  type OpencodeEvent,
  type OpencodeModel,
  type OpencodeSessionStatus,
  type PermissionRule,
} from "./client.js";
import {
  coalesceMessage,
  type Part,
  partToBlocks,
  type SubtaskPart,
  userPartsText,
  userText,
} from "./translate.js";

// Bedrock Claude Sonnet is the default model path: a reliable tool-caller, so the permission/tool
// round-trips actually exercise (no flaky tiny-model fallback). The `global.` inference profile selects
// the cross-region model, but the AWS SDK still requires a region. The opencode SERVER must have the
// `amazon-bedrock` region + credentials in ITS process env — opencode's AI-SDK Bedrock client does NOT
// walk the IMDS instance-role chain (verified on 1.17.5), so it needs explicit credentials (for example,
// short-lived values from `aws configure export-credentials --format env`) or
// AWS_BEARER_TOKEN_BEDROCK. See
// docs/opencode-driver.md.
export const DEFAULT_OPENCODE_MODEL: OpencodeModel = {
  providerID: "amazon-bedrock",
  modelID: "global.anthropic.claude-sonnet-4-6",
};

export class OpencodeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeProjectionError";
  }
}

/** Derive the exact caller-owned text-part marker from the host-minted downstream UUID. */
export function opencodePartId(eventId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId)) {
    throw new OpencodeProjectionError("downstream event has a noncanonical host identity");
  }
  return `prt_rc_${eventId.replaceAll("-", "")}`;
}

/** One atomic admission latch: text claims transport+idle in one synchronous edge; interrupt and
 * permission replies wait only for a trustworthy transport. */
class NativeAdmission {
  #transportReady = false;
  #nativeIdle = false;
  #next = Promise.withResolvers<void>();

  #changed(): void {
    const next = this.#next;
    this.#next = Promise.withResolvers<void>();
    next.resolve();
  }

  pauseTransport(): void {
    if (!this.#transportReady) return;
    this.#transportReady = false;
    this.#changed();
  }

  resumeTransport(): void {
    if (this.#transportReady) return;
    this.#transportReady = true;
    this.#changed();
  }

  markNativeBusy(): void {
    if (!this.#nativeIdle) return;
    this.#nativeIdle = false;
    this.#changed();
  }

  markNativeIdle(): void {
    if (this.#nativeIdle) return;
    this.#nativeIdle = true;
    this.#changed();
  }

  async waitTransport(signal: AbortSignal): Promise<void> {
    while (!this.#transportReady) {
      throwIfAborted(signal);
      await Promise.race([this.#next.promise, waitAbort(signal)]);
    }
    throwIfAborted(signal);
  }

  /** Node's synchronous run-to-completion makes the final check→busy transition one atomic claim. */
  tryClaimTurn(): boolean {
    if (!this.#transportReady || !this.#nativeIdle) return false;
    this.#nativeIdle = false;
    return true;
  }

  async claimTurn(signal: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      if (this.tryClaimTurn()) return;
      await Promise.race([this.#next.promise, waitAbort(signal)]);
    }
  }
}

/** A projection-long immutable message ledger; exhaustion or changed reuse is terminal. */
class CanonicalMessageLedger {
  readonly #fingerprints = new Map<string, string>();

  admit(messageId: string, fingerprint: string): boolean {
    const previous = this.#fingerprints.get(messageId);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new OpencodeProjectionError("OpenCode reused a message id with changed content");
      }
      return false;
    }
    if (this.#fingerprints.size >= OPENCODE_HISTORY_LIMIT) {
      throw new OpencodeProjectionError("OpenCode projection exceeds the message-coordinate limit");
    }
    this.#fingerprints.set(messageId, fingerprint);
    return true;
  }

  has(messageId: string): boolean {
    return this.#fingerprints.has(messageId);
  }
}

interface BrowserMutation {
  text: string;
  clientMsgId?: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface ActiveBrowserTurn {
  eventId: string;
  partId: string;
  text: string;
  nativeUserId?: string;
  sawBusy: boolean;
  correlated: Deferred;
}

/** A bounded FIFO above OpenCode's single native runner. Reading the broker stream stays independent so
 * an interrupt can still reach a running turn while later browser text waits here. */
class BrowserTurnQueue {
  readonly #items: RcEvent[] = [];
  #wake = Promise.withResolvers<void>();

  push(event: RcEvent): void {
    if (this.#items.length >= OPENCODE_HISTORY_LIMIT) {
      throw new OpencodeProjectionError("OpenCode browser-turn queue exceeded its bound");
    }
    this.#items.push(event);
    const wake = this.#wake;
    this.#wake = Promise.withResolvers<void>();
    wake.resolve();
  }

  async shift(signal: AbortSignal): Promise<RcEvent | undefined> {
    while (this.#items.length === 0) {
      if (signal.aborted) return undefined;
      await Promise.race([this.#wake.promise, waitAbort(signal)]);
    }
    return this.#items.shift();
  }
}

interface OpencodeConnection {
  iterator: AsyncIterator<OpencodeEvent>;
  first: IteratorResult<OpencodeEvent>;
  close(): void;
}

function opencodeViewerCapabilities(structuredPermissions: boolean): DriverCapabilities {
  return {
    structuredPermissions,
    // MAIN-session busy/retry and strictly reconciled idle are a supported read-only viewer surface.
    // Child lifecycle never drives this status, and transport recovery retains the last proved value.
    status: true,
    controls: { interrupt: true, setModel: false, setMode: false, end: false },
    // The compatibility prompt translator has no proved native OpenCode file-part fidelity.
    attachments: false,
  };
}

/** OpenCode-specific knobs the driver reads from DriverContext.extra (set by the wiring in run.ts). */
export interface OpencodeExtra {
  /** OpenCode server origin (default http://127.0.0.1:4096). */
  baseUrl?: string;
  /** providerID + modelID for prompt_async (default amazon-bedrock/global.anthropic.claude-sonnet-4-6). */
  model?: OpencodeModel;
  /** Optional HTTP Basic password (OPENCODE_SERVER_PASSWORD). */
  password?: string;
  /** HTTP Basic username (OPENCODE_SERVER_USERNAME, default `opencode`). */
  username?: string;
  /** Explicit OpenCode session to attach to (`--rc-oc-session`). Required on the supported path. */
  sessionId?: string;
  /** MIRROR tool permissions to the viewer (experimental, DEFAULT OFF). When on, the driver adds a catch-all
   *  "ask" rule to the bridged session (and each followed child), so otherwise-unconfigured tools raise
   *  a `permission.asked` gate the viewer answers instead of taking OpenCode's default. Existing later
   *  specific allow/deny rules remain authoritative. Off leaves native policy untouched.
   *
   *  PERSISTENCE (documented limitation): opencode's PATCH /session/{id} { permission } is APPEND-ONLY
   *  (verified live: rules concatenate; null/[]/{} are no-ops) — there is NO clear/replace. So once we
   *  flip a borrowed session to ask we CANNOT cleanly revert it on teardown: re-PATCHing the original is a
   *  no-op for the common empty config, and appending an allow-all to force auto-run would override the
   *  user's GLOBAL deny policy (worse than leaving it). We therefore do NOT attempt a restore — the flip
   *  is one-way and persists after the wrapper exits. This is the SAFE direction (ask never auto-approves
   *  anything; it only prompts), and the user can clear the session's rules in opencode if undesired. */
  mirrorPermissions?: boolean;
  /** Injectable client (tests) — bypasses the real HTTP server. */
  client?: OpencodeClient;
}

function readExtra(extra: Record<string, unknown> | undefined): OpencodeExtra {
  if (!extra) return {};
  const out: OpencodeExtra = {};
  if (typeof extra.baseUrl === "string") out.baseUrl = extra.baseUrl;
  if (typeof extra.password === "string") out.password = extra.password;
  if (typeof extra.username === "string") out.username = extra.username;
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

/** The catch-all rule the driver adds so EVERY otherwise-unconfigured tool raises a gate (verified live
 *  against opencode 1.17.5 — one wildcard ask gates all tools). */
const ASK_ALL_RULE: PermissionRule = { permission: "*", pattern: "*", action: "ask" };

export function hasRemoteClawAskRule(rules: readonly PermissionRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.permission === ASK_ALL_RULE.permission &&
      rule.pattern === ASK_ALL_RULE.pattern &&
      rule.action === ASK_ALL_RULE.action,
  );
}

/** Merge the catch-all ask with a session's EXISTING permission rules, preserving the existing policy —
 *  especially a hard `deny`. opencode is LAST-match-wins (verified live), so the catch-all ask goes
 *  FIRST and the existing rules AFTER it: an existing specific rule (deny/allow) still wins for its tool,
 *  while every unconfigured tool falls through to ask. This de-duplicates the PATCH PAYLOAD only.
 *  OpenCode 1.17.5 appends permission patches to native state, so calling PATCH again is not idempotent;
 *  registration first detects an already-installed catch-all and skips that append. */
export function mergeAskRules(existing: readonly PermissionRule[]): PermissionRule[] {
  const isOurCatchAll = (r: PermissionRule) =>
    r.permission === ASK_ALL_RULE.permission &&
    r.pattern === ASK_ALL_RULE.pattern &&
    r.action === ASK_ALL_RULE.action;
  return [ASK_ALL_RULE, ...existing.filter((r) => !isOurCatchAll(r))];
}

/** What we buffer for one in-flight assistant message: its parts keyed by partID, in arrival order, so
 *  a re-sent whole part REPLACES its prior version (coalesce) rather than appending a duplicate. */
interface MessageBuffer {
  /** partID → the latest whole Part for that id (OpenCode re-sends the whole part, not a delta). */
  parts: Map<string, Part>;
  /** insertion order of partIDs so blocks render in the order OpenCode produced them. */
  order: string[];
}

/** Shared bound for projection-local correlation structures. */
const DEFAULT_EMITTED_CAP = OPENCODE_HISTORY_LIMIT;

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

/** Trace only a narrow, body-free subset of a provider error. Error names, messages, and response
 * bodies are provider-controlled and can contain credentials or arbitrary output, so they belong only
 * in the E2E viewer result. Numeric status and boolean retryability are the only copied fields. */
function sessionErrorTraceFields(
  error: unknown,
  session: string | undefined,
): Record<string, string | number | boolean | undefined> {
  const outer =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const data =
    typeof outer?.data === "object" && outer.data !== null
      ? (outer.data as Record<string, unknown>)
      : undefined;
  const fields: Record<string, string | number | boolean | undefined> = { session };

  const status = outer?.status ?? outer?.statusCode ?? data?.status ?? data?.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    fields.status = status;
  }

  const retryable = outer?.retryable ?? outer?.isRetryable ?? data?.retryable ?? data?.isRetryable;
  if (typeof retryable === "boolean") fields.retryable = retryable;
  return fields;
}

/** SSE reconnect backoff bounds (review #2). A transient close reconnects after MIN; repeated failures
 *  (server down) back off exponentially up to MAX. The backoff is reset to MIN after a connection that
 *  lived (a clean EOF), so a healthy-then-blip reconnect is fast. */
const RECONNECT_BACKOFF_MIN_MS = 250;
const RECONNECT_BACKOFF_MAX_MS = 5000;
const RECONNECT_ATTEMPTS = 5;
const OPENCODE_MUTATION_TIMEOUT_MS = 15_000;

/** Let native abort and the bridge's final broker flush settle, but never let either unresponsive
 * endpoint prevent OpenCode attach-failure or normal driver teardown from returning. */
export const OPENCODE_TEARDOWN_FLUSH_MS = 2000;

/** Start teardown work with a deadline signal and await it up to `ms`. The timer is unref'd and cleared
 * on normal settlement so healthy cleanup exits immediately without leaving a process-liveness timer
 * behind. The deadline aborts cancellation-aware HTTP, while the outer bound still protects against a
 * transport/test double that ignores its signal. Never rejects. */
function boundedTeardownWait(
  start: (deadlineSignal: AbortSignal) => Promise<unknown>,
  ms: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new AbortController();
    const finish = (): void => {
      if (done) return;
      done = true;
      if (handle !== undefined) clearTimeout(handle);
      resolve();
    };
    handle = setTimeout(() => {
      deadline.abort();
      finish();
    }, ms);
    if (typeof handle.unref === "function") handle.unref();
    try {
      start(deadline.signal).then(finish, finish);
    } catch {
      finish();
    }
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

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
  /** Conservative until setup; the supported default never claims browser permission handling. */
  readonly capabilities: DriverCapabilities;

  readonly #ctx: DriverContext;
  readonly #extra: OpencodeExtra;
  /** Experimental permission mirroring (default off; positive opt-in only). */
  readonly #mirror: boolean;
  readonly #model: OpencodeModel;
  readonly #client: OpencodeClient;
  readonly #tracer: Tracer;

  /** Buffered in-flight messages, keyed by OpenCode messageID. New coordinates are hard-bounded. */
  readonly #buffers = new Map<string, MessageBuffer>();
  /** Projection-long immutable native message coordinates. */
  readonly #emitted = new CanonicalMessageLedger();
  /** Projected message → exact per-part display semantics, for subscribe-before-history overlap. */
  readonly #emittedParts = new Map<string, Map<string, string>>();
  #emittedPartCount = 0;
  /** Caller-owned text-part id → authenticated browser mutation awaiting its canonical native echo. */
  readonly #browserMutations = new Map<string, BrowserMutation>();
  /** Every native part coordinate has one immutable containing message, including consumed markers. */
  readonly #partOwner = new Map<string, string>();
  #partCoordinateCount = 0;
  /** Per-native-session chronological message identities used to detect inserts behind projected order. */
  readonly #messageOrder = new Map<string, string[]>();
  readonly #messageOwner = new Map<string, string>();
  #messageCoordinateCount = 0;
  readonly #admission = new NativeAdmission();
  readonly #browserTurns = new BrowserTurnQueue();
  #activeBrowserTurn: ActiveBrowserTurn | undefined;
  /** messageID → role, learned from `message.updated` and strict history. */
  readonly #roles = new BoundedMap<string>(DEFAULT_EMITTED_CAP);
  /** Assistant messageID → immutable required parent user messageID. */
  readonly #assistantParents = new BoundedMap<string>(DEFAULT_EMITTED_CAP);
  /** The newest user observed in each native session; new assistants must bind to that exact user. */
  readonly #latestUser = new BoundedMap<string>(DEFAULT_EMITTED_CAP);
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
  /** Best-effort child permission preparations that are still running. They share the driver's abort
   *  fence and are joined under the same bounded teardown deadline as native abort + bridge closure. */
  readonly #childPermissionTasks = new Set<Promise<void>>();

  constructor(ctx: DriverContext) {
    this.#ctx = ctx;
    this.#extra = readExtra(ctx.extra);
    this.#mirror = this.#extra.mirrorPermissions ?? false;
    this.capabilities = opencodeViewerCapabilities(false);
    this.#model = this.#extra.model ?? DEFAULT_OPENCODE_MODEL;
    this.#tracer = (ctx.tracer ?? tracerFromEnv("rc.opencode")).child({ driver: "opencode" });
    this.#client =
      this.#extra.client ??
      new OpencodeClient({
        baseUrl: this.#extra.baseUrl ?? DEFAULT_OPENCODE_URL,
        ...(this.#extra.username !== undefined ? { username: this.#extra.username } : {}),
        ...(this.#extra.password !== undefined ? { password: this.#extra.password } : {}),
      } satisfies OpencodeClientOptions);
  }

  /** Run until `signal` aborts. The compatibility Session stays private while native identity and policy
   *  are proved, and its broker bridge starts only at the explicit readiness edge. */
  async run(signal: AbortSignal): Promise<number> {
    // A dead-on-arrival wrapper owns no OpenCode session. Do not create a relay Session, inspect/select
    // a native session, or issue a later abort against whatever happens to be active on the server.
    if (signal.aborted) return 0;

    const core = new RelayCore();
    const session = core.create({ title: this.#ctx.title });
    session.pushInitialize(); // guaranteed first downstream event (idempotent)
    this.#ctx.onSession?.(session);

    const relays = new Set<Promise<void>>();
    const terminalTasks = new Set<Promise<void>>();
    const bridge = new ReadyBridge({
      session,
      newClient: this.#ctx.newClient,
      identityId: this.#ctx.identity.identityId,
      relays,
      terminalTasks,
      tracer: this.#ctx.tracer ?? tracerFromEnv("rc.relay"),
      parentSignal: signal,
    });
    const stop = bridge.signal;

    let ocSessionId: string;
    let firstConnection: OpencodeConnection | undefined;
    try {
      throwIfAborted(stop);

      if (
        this.#model.providerID !== DEFAULT_OPENCODE_MODEL.providerID ||
        this.#model.modelID !== DEFAULT_OPENCODE_MODEL.modelID
      ) {
        throw new Error("the supported OpenCode path requires the pinned Bedrock Sonnet model");
      }
      await this.#client.requireSupportedVersion(stop);
      throwIfAborted(stop);

      ocSessionId = await this.#attach(stop);
      throwIfAborted(stop);

      // A writable projection exists only after the stream is live and a strict bounded history
      // snapshot has reconciled behind it. Events arriving during history stay queued on this iterator.
      this.#mainSessionId = ocSessionId;
      this.#followed.add(ocSessionId);
      firstConnection = await this.#openConnection(ocSessionId, stop);
      // Re-prove the pinned tuple after the stream opens. A server replacement between the first
      // health/identity checks and GET /event must never inherit a writable projection.
      await this.#client.requireSupportedVersion(stop);
      await this.#requireExactSession(ocSessionId, stop);
      if (this.#mirror) await this.#requireAskMirroring(ocSessionId, stop);
      await this.#reconcileNativeTurnState(session, ocSessionId, stop);
      throwIfAborted(stop);

      const readyCapabilities = opencodeViewerCapabilities(this.#mirror);
      bridge.start({
        title: this.#ctx.title,
        cwd: this.#ctx.cwd,
        git: this.#ctx.git,
        capabilities: readyCapabilities,
        harness: OPENCODE_HARNESS,
      });
      throwIfAborted(stop);
      Object.assign(this.capabilities, readyCapabilities);
      this.#admission.resumeTransport();
    } catch (e) {
      firstConnection?.close();
      const cancelled = stop.aborted;
      if (cancelled) this.#tracer.debug("opencode startup cancelled");
      else this.#tracer.error("opencode registration failed", { error: String(e) });
      await boundedTeardownWait(
        () => bridge.close(cancelled ? "startup cancelled" : "registration failed"),
        OPENCODE_TEARDOWN_FLUSH_MS,
      );
      return cancelled ? 0 : 1;
    }
    if (firstConnection === undefined) return 1;
    this.#tracer.info("opencode session attached", { session: session.id, opencode: ocSessionId });

    try {
      await Promise.race([
        projectionPumpLifetime(
          this.#capturePump(session, ocSessionId, firstConnection, stop),
          session,
        ),
        projectionPumpLifetime(this.#injectPump(session, ocSessionId, stop), session),
        projectionPumpLifetime(this.#browserTurnPump(session, ocSessionId, stop), session),
        waitAbort(stop),
      ]);
      return 0;
    } finally {
      // The native session is externally owned. Only an authenticated browser interrupt calls /abort;
      // cancellation, broker/capture failure, restart, and ordinary teardown stop this companion only.
      const bridgeTeardown = bridge.close("driver teardown");
      session.workerStatus = "idle";
      const childPermissionTasks = [...this.#childPermissionTasks];
      await boundedTeardownWait(
        () => Promise.allSettled([...childPermissionTasks, bridgeTeardown]),
        OPENCODE_TEARDOWN_FLUSH_MS,
      );
    }
  }

  /**
   * Resolve one exact externally owned native identity. The release path never discovers, selects, or
   * creates a session; the final exact GET confirms the caller's explicit coordinate before readiness.
   */
  async #attach(signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const selected = this.#extra.sessionId;
    if (!isOpencodeSessionId(selected)) {
      throw new Error("configured OpenCode session must be a canonical ses_* id");
    }

    await this.#requireExactSession(selected, signal);
    this.#tracer.debug("confirmed exact OpenCode session", { opencode: selected });
    return selected;
  }

  /** Re-prove the exact externally owned session after every native transport establishment. */
  async #requireExactSession(sessionId: string, signal: AbortSignal): Promise<void> {
    const confirmed = await this.#client.getSession(sessionId, signal);
    throwIfAborted(signal);
    if (confirmed.id !== sessionId) {
      throw new Error("OpenCode exact session confirmation mismatched");
    }
  }

  /** Open the sole server-wide SSE reader and require OpenCode's readiness marker as its first event. */
  async #openConnection(ocSessionId: string, signal: AbortSignal): Promise<OpencodeConnection> {
    const owner = new AbortController();
    const connectionSignal = AbortSignal.any([signal, owner.signal]);
    const iterator = this.#client
      .events((id) => id !== undefined && this.#followed.has(id), connectionSignal)
      [Symbol.asyncIterator]();
    let first: IteratorResult<OpencodeEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      owner.abort();
      throw error;
    }
    if (first.done) {
      owner.abort();
      throw new Error("OpenCode event stream ended before readiness");
    }
    if (first.value.type !== "server.connected") {
      owner.abort();
      throw new OpencodeProjectionError("OpenCode event stream lacked its readiness marker");
    }
    this.#tracer.debug("OpenCode event stream connected", { sessionId: ocSessionId });
    return { iterator, first, close: () => owner.abort() };
  }

  /** Claim one live-observed message coordinate in that native session's chronological order. */
  #recordLiveMessage(ocSessionId: string, messageId: string): void {
    if (!isOpencodeMessageId(messageId)) {
      throw new OpencodeProjectionError("OpenCode emitted a noncanonical message id");
    }
    const owner = this.#messageOwner.get(messageId);
    if (owner !== undefined && owner !== ocSessionId) {
      throw new OpencodeProjectionError("OpenCode reused a message id across native sessions");
    }
    const order = this.#messageOrder.get(ocSessionId) ?? [];
    if (order.includes(messageId)) return;
    const previous = order.at(-1);
    if (previous !== undefined && messageId <= previous) {
      throw new OpencodeProjectionError("OpenCode message ids violated native chronological order");
    }
    if (this.#messageCoordinateCount >= OPENCODE_HISTORY_LIMIT) {
      throw new OpencodeProjectionError("OpenCode projection exceeds the message-coordinate limit");
    }
    this.#messageCoordinateCount += 1;
    this.#messageOwner.set(messageId, ocSessionId);
    order.push(messageId);
    this.#messageOrder.set(ocSessionId, order);
  }

  /**
   * Require each prior native coordinate in the same order and allow only an appended suffix. An unseen
   * message inserted behind an already projected coordinate would make the shared transcript order false.
   */
  #reconcileMessageOrder(ocSessionId: string, messageIds: readonly string[]): void {
    const previous = this.#messageOrder.get(ocSessionId) ?? [];
    for (let index = 0; index < previous.length; index += 1) {
      if (messageIds[index] !== previous[index]) {
        throw new OpencodeProjectionError("OpenCode history changed behind projected order");
      }
    }
    if (messageIds.length < previous.length) {
      throw new OpencodeProjectionError("OpenCode history omitted a projected message");
    }
    for (let index = previous.length; index < messageIds.length; index += 1) {
      const messageId = messageIds[index];
      if (messageId === undefined) continue;
      this.#recordLiveMessage(ocSessionId, messageId);
    }
  }

  /** Require each new assistant to retain the latest preceding user as its canonical parent. Existing
   * assistants may continue receiving updates after a later steering user is appended. */
  #reconcileMessageParents(ocSessionId: string, messages: readonly HistoryMessage[]): void {
    let latestUser: string | undefined;
    for (const message of messages) {
      if (message.info.role === "user") {
        latestUser = message.info.id;
        continue;
      }
      const parentId = message.info.parentID;
      if (!isOpencodeMessageId(parentId) || parentId !== latestUser) {
        throw new OpencodeProjectionError("OpenCode assistant did not bind the latest native user");
      }
      const previous = this.#assistantParents.get(message.info.id);
      if (previous !== undefined && previous !== parentId) {
        throw new OpencodeProjectionError("OpenCode changed an assistant parent");
      }
      this.#assistantParents.set(message.info.id, parentId);
    }
    if (latestUser !== undefined) this.#latestUser.set(ocSessionId, latestUser);
  }

  /** Bind one live assistant only after its parent user has been observed in the same native session. */
  #recordAssistantParent(ocSessionId: string, messageId: string, parentId: string): void {
    const previous = this.#assistantParents.get(messageId);
    if (previous !== undefined) {
      if (previous !== parentId) {
        throw new OpencodeProjectionError("OpenCode changed an assistant parent");
      }
      return;
    }
    if (this.#latestUser.get(ocSessionId) !== parentId) {
      throw new OpencodeProjectionError("OpenCode assistant did not bind the latest native user");
    }
    this.#assistantParents.set(messageId, parentId);
  }

  /** A live duplicate user update must not move the session's latest-user pointer backwards. */
  #recordLatestUser(ocSessionId: string, messageId: string): void {
    const previous = this.#latestUser.get(ocSessionId);
    if (previous === undefined || messageId > previous)
      this.#latestUser.set(ocSessionId, messageId);
  }

  /** Strict bounded history reconciliation shared by startup and every SSE recovery. */
  async #backfillHistory(
    session: Session,
    ocSessionId: string,
    signal: AbortSignal,
  ): Promise<HistoryMessage[]> {
    let messages: HistoryMessage[];
    try {
      messages = await this.#client.getMessages(ocSessionId, signal);
    } catch (error) {
      if (error instanceof OpencodeError) {
        throw new OpencodeProjectionError("OpenCode history could not be reconciled");
      }
      throw error;
    }
    this.#reconcileMessageOrder(
      ocSessionId,
      messages.map((message) => message.info.id),
    );
    this.#reconcileMessageParents(ocSessionId, messages);
    let count = 0;
    for (const message of messages) {
      const id = message.info.id;
      this.#msgSession.set(id, ocSessionId);
      const previousRole = this.#roles.get(id);
      if (previousRole !== undefined && previousRole !== message.info.role) {
        throw new OpencodeProjectionError("OpenCode changed a native message role");
      }
      this.#roles.set(id, message.info.role);
      // The strict history row is authoritative at this instant. Replace, rather than merge with, any
      // pre-drop partial so a part removed during the SSE gap cannot survive into the final transcript.
      this.#buffers.delete(id);
      for (const part of message.parts) this.#bufferPart(id, part, ocSessionId);
      this.#tryBindBrowserMutation(id);
      if (message.info.role === "assistant" && message.info.time?.completed === undefined) {
        if (this.#emitted.has(id)) {
          throw new OpencodeProjectionError("OpenCode regressed a completed message");
        }
        continue;
      }
      if (this.#flushMessage(session, id)) count += 1;
    }
    if (count > 0) this.#tracer.info("OpenCode history reconciled", { messages: count });
    return messages;
  }

  /** Bind the one pending browser marker to OpenCode's generated user message coordinate. */
  #tryBindBrowserMutation(messageId: string): void {
    const active = this.#activeBrowserTurn;
    if (active === undefined || this.#roles.get(messageId) !== "user") return;
    const mutation = this.#browserMutations.get(active.partId);
    const buffer = this.#buffers.get(messageId);
    const marker = buffer?.parts.get(active.partId);
    if (mutation === undefined || marker === undefined) return;
    if (textPartValue(marker) !== mutation.text || mutation.text !== active.text) {
      throw new OpencodeProjectionError("OpenCode changed the browser correlation marker");
    }
    const parts = (buffer?.order ?? [])
      .map((id) => buffer?.parts.get(id))
      .filter((part): part is Part => part !== undefined);
    if (userPartsText(parts) !== active.text) {
      throw new OpencodeProjectionError("OpenCode changed the browser message text");
    }
    if (active.nativeUserId !== undefined && active.nativeUserId !== messageId) {
      throw new OpencodeProjectionError("OpenCode reused a browser marker across messages");
    }
    active.nativeUserId = messageId;
    active.correlated.resolve();
  }

  /** Capture-owned startup/reconnect reconciliation. GET status corroborates bounded strict history; it
   * never acts as an atomic lock against a literally simultaneous native-TUI writer. */
  async #reconcileNativeTurnState(
    session: Session,
    ocSessionId: string,
    signal: AbortSignal,
    mode: "strict" | "live-idle" = "strict",
  ): Promise<void> {
    const messages = await this.#backfillHistory(session, ocSessionId, signal);
    const status: OpencodeSessionStatus = await this.#client.getSessionStatus(ocSessionId, signal);

    if (status === "busy" || status === "retry") {
      this.#admission.markNativeBusy();
      if (this.#activeBrowserTurn !== undefined) this.#activeBrowserTurn.sawBusy = true;
      session.workerStatus = "running";
      session.wake();
      return;
    }

    const active = this.#activeBrowserTurn;
    if (active !== undefined) {
      const user = messages.find(
        (message) =>
          message.info.role === "user" && message.parts.some((part) => part.id === active.partId),
      );
      if (user === undefined) {
        this.#admission.markNativeBusy();
        if (mode === "live-idle" && !active.sawBusy) return;
        throw new OpencodeProjectionError("OpenCode lost the active browser correlation marker");
      }
      const marker = user.parts.find((part) => part.id === active.partId);
      if (
        textPartValue(marker) !== active.text ||
        userPartsText(user.parts) !== active.text ||
        (active.nativeUserId !== undefined && active.nativeUserId !== user.info.id)
      ) {
        throw new OpencodeProjectionError("OpenCode changed the active browser turn");
      }
      active.nativeUserId = user.info.id;
      active.correlated.resolve();
      if (this.#latestUser.get(ocSessionId) !== user.info.id) {
        throw new OpencodeProjectionError("OpenCode advanced past the active browser turn");
      }
      if (mode === "live-idle" && !active.sawBusy) {
        this.#admission.markNativeBusy();
        return;
      }
      this.#activeBrowserTurn = undefined;
    }
    this.#admission.markNativeIdle();
    session.workerStatus = "idle";
    session.wake();
  }

  /** Consume one already-open connection, including its retained readiness marker. */
  async #consumeConnection(
    session: Session,
    connection: OpencodeConnection,
    signal: AbortSignal,
  ): Promise<void> {
    let next = connection.first;
    for (;;) {
      if (signal.aborted || session.closed) return;
      if (next.done) return;
      await this.#onEvent(session, next.value, signal);
      next = await connection.iterator.next();
    }
  }

  /** Pause writes on loss, reconnect one reader, and reconcile all known active sessions before resume. */
  async #capturePump(
    session: Session,
    ocSessionId: string,
    firstConnection: OpencodeConnection,
    signal: AbortSignal,
  ): Promise<void> {
    let connection = firstConnection;
    try {
      while (!signal.aborted && !session.closed) {
        try {
          await this.#consumeConnection(session, connection, signal);
        } catch (error) {
          if (signal.aborted || session.closed) return;
          if (error instanceof OpencodeProjectionError) {
            this.#admission.pauseTransport();
            throw error;
          }
          this.#tracer.warn("OpenCode event stream dropped; reconciling");
        }
        connection.close();
        if (signal.aborted || session.closed) return;
        this.#admission.pauseTransport();
        this.#admission.markNativeBusy();

        let recovered = false;
        let backoffMs = RECONNECT_BACKOFF_MIN_MS;
        for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
          await sleepAbortable(backoffMs, signal);
          if (signal.aborted || session.closed) return;
          let candidate: OpencodeConnection | undefined;
          try {
            candidate = await this.#openConnection(ocSessionId, signal);
            await this.#client.requireSupportedVersion(signal);
            await this.#requireExactSession(ocSessionId, signal);
            if (this.#mirror) await this.#requireAskMirroring(ocSessionId, signal);
            await this.#reconcileNativeTurnState(session, ocSessionId, signal);
            for (const followedId of this.#followed) {
              if (followedId !== ocSessionId) {
                await this.#backfillHistory(session, followedId, signal);
              }
            }
            connection = candidate;
            this.#admission.resumeTransport();
            recovered = true;
            break;
          } catch (error) {
            candidate?.close();
            if (signal.aborted || session.closed) return;
            if (error instanceof OpencodeProjectionError) throw error;
            this.#tracer.warn("OpenCode event stream reconnect failed", { attempt });
          }
          backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
        }
        if (!recovered) {
          throw new OpencodeProjectionError("OpenCode event stream could not be reconciled");
        }
      }
    } finally {
      connection.close();
    }
  }

  /** Route one OpenCode SSE event. Pure dispatch — all the buffering/coalescing lives in the helpers. */
  async #onEvent(session: Session, ev: OpencodeEvent, signal: AbortSignal): Promise<void> {
    // Which OpenCode session this event is for (main or a followed child) — drives per-session status/idle
    // routing so a child going idle doesn't flip the whole bridge idle while the parent waits (#102).
    // Shared derivation with the client filter (eventSessionId) so the two never drift. (undefined for
    // session.created — that case reads info.id/parentID directly below.)
    const evSession = eventSessionId(ev.properties);
    switch (ev.type) {
      case "message.part.updated": {
        const part = ev.properties.part;
        const messageId = part?.messageID;
        if (
          !isOpencodeSessionId(evSession) ||
          !isOpencodeMessageId(messageId) ||
          !isValidOpencodePart(part, messageId, evSession)
        ) {
          throw new OpencodeProjectionError("OpenCode emitted an invalid message part");
        }
        if (this.#emitted.has(messageId)) {
          const expected = this.#emittedParts.get(messageId)?.get(part.id);
          if (expected !== partFingerprint(part)) {
            throw new OpencodeProjectionError("OpenCode changed content already projected");
          }
          break;
        }
        this.#recordLiveMessage(evSession, messageId);
        // Record the message→session map from the EVENT's session (authoritative; the part's own
        // sessionID field may be absent). For a child part this is the child session.
        this.#bufferPart(messageId, part, evSession);
        // Note a subtask anchor ONLY on the LIVE stream, keyed by the PARENT (= this event's session).
        // Backfill must NOT enqueue historical anchors — their children already exist, so a stale anchor
        // would be popped by the next same-agent child and mis-nest it.
        if (part.type === "subtask") {
          this.#noteSubtask(part as SubtaskPart, evSession);
        }
        break;
      }
      case "message.part.removed": {
        const messageId = ev.properties.messageID;
        const partId = ev.properties.partID;
        if (
          !isOpencodeSessionId(evSession) ||
          !isOpencodeMessageId(messageId) ||
          typeof partId !== "string" ||
          partId === ""
        ) {
          throw new OpencodeProjectionError("OpenCode emitted an invalid part removal");
        }
        if (this.#browserMutations.has(partId)) {
          throw new OpencodeProjectionError(
            "OpenCode removed a pending browser correlation marker",
          );
        }
        if (this.#emitted.has(messageId)) {
          if (this.#emittedParts.get(messageId)?.has(partId) === false) break;
          throw new OpencodeProjectionError("OpenCode removed already projected content");
        }
        this.#buffers.get(messageId)?.parts.delete(partId);
        break;
      }
      case "message.removed": {
        if (!isOpencodeSessionId(evSession) || !isOpencodeMessageId(ev.properties.messageID)) {
          throw new OpencodeProjectionError("OpenCode emitted an invalid message removal");
        }
        // A removal queued before the strict snapshot is redundant when that native coordinate was never
        // observed. Once known, a whole-message removal changes chronology with no append-only mapping.
        if (
          !this.#emitted.has(ev.properties.messageID) &&
          !this.#messageOwner.has(ev.properties.messageID) &&
          this.#browserMutations.size === 0
        ) {
          break;
        }
        throw new OpencodeProjectionError("OpenCode removed a native message");
      }
      case "session.deleted": {
        if (!isOpencodeSessionId(evSession)) {
          throw new OpencodeProjectionError("OpenCode emitted an invalid session deletion");
        }
        throw new OpencodeProjectionError("OpenCode deleted an attached native session");
      }
      case "message.updated": {
        const info = ev.properties.info;
        if (!isOpencodeSessionId(evSession) || !isValidOpencodeMessageInfo(info, evSession)) {
          throw new OpencodeProjectionError("OpenCode emitted an invalid message update");
        }
        const previousRole = this.#roles.get(info.id);
        if (previousRole !== undefined && previousRole !== info.role) {
          throw new OpencodeProjectionError("OpenCode changed a native message role");
        }
        this.#recordLiveMessage(evSession, info.id);
        this.#msgSession.set(info.id, evSession);
        this.#roles.set(info.id, info.role);
        if (info.role === "user") {
          if (previousRole === undefined && evSession === this.#mainSessionId) {
            this.#admission.markNativeBusy();
            session.workerStatus = "running";
            session.wake();
          }
          this.#recordLatestUser(evSession, info.id);
        } else {
          if (!isOpencodeMessageId(info.parentID)) {
            throw new OpencodeProjectionError("OpenCode assistant lacked a native parent");
          }
          this.#recordAssistantParent(evSession, info.id, info.parentID);
        }
        // The user message never carries time.completed (verified live) — it's settled the moment the
        // model starts responding. So when an ASSISTANT message appears, flush any buffered USER messages
        // FIRST: the prompt (the local_prompt frame) must precede the assistant reply in the transcript.
        if (info.role === "assistant") this.#flushBufferedUsers(session);
        // An assistant message with time.completed is done — flush it now (don't wait for idle, so a
        // multi-message turn surfaces each message as it completes).
        if (info.role === "assistant" && info.time?.completed !== undefined) {
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
          isOpencodeSessionId(childId) &&
          typeof parentId === "string" &&
          this.#followed.has(parentId)
        ) {
          this.#followed.add(childId);
          // Child setup is still observational and cannot be a parent-readiness proof: OpenCode can run
          // the child before this async append/read-back finishes. It is nevertheless run-fenced, tracked,
          // and joined at teardown so a late read cannot start a PATCH after cancellation.
          if (this.#mirror) this.#prepareChildAskMirroring(childId, signal);
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
          if (status !== "busy" && status !== "retry" && status !== "idle") {
            throw new OpencodeProjectionError("OpenCode emitted an invalid native status");
          }
          if (status === "busy" || status === "retry") {
            this.#admission.markNativeBusy();
            if (this.#activeBrowserTurn !== undefined) this.#activeBrowserTurn.sawBusy = true;
            session.workerStatus = "running";
          }
          session.wake();
        }
        break;
      }
      case "session.idle": {
        if (evSession === this.#mainSessionId) {
          // The event is a trigger, not proof by itself. One capture-owned history/status pass both
          // settles projection bytes and decides whether the next queued browser turn may enter.
          await this.#reconcileNativeTurnState(session, this.#mainSessionId, signal, "live-idle");
        } else if (evSession !== undefined && this.#followed.has(evSession)) {
          this.#flushSessionBuffers(session, evSession);
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
        // the error as a `result` frame so the viewer SHOWS the failure. Re-read the MAIN session's exact
        // status so a failed turn cannot leave a stale "working" indicator; this viewer update deliberately
        // does NOT open write admission or clear browser correlation. Child errors never drive MAIN (#102).
        this.#flushSessionBuffers(session, evSession);
        const msg = errText(ev.properties.error);
        this.#tracer.warn(
          "OpenCode session failed",
          sessionErrorTraceFields(ev.properties.error, evSession),
        );
        session.pushUpstream({ type: "result", result: `⚠ OpenCode error: ${msg}` });
        if (evSession === this.#mainSessionId) {
          const status = await this.#client.getSessionStatus(this.#mainSessionId, signal);
          session.workerStatus = status === "busy" || status === "retry" ? "running" : "idle";
          session.wake();
        }
        break;
      }
      case "permission.asked":
        if (this.#mirror) this.#onPermissionAsked(session, ev);
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
    if (!isValidOpencodePart(part)) {
      throw new OpencodeProjectionError("OpenCode emitted a part without an immutable identity");
    }
    const previousOwner = this.#partOwner.get(part.id);
    if (previousOwner !== undefined && previousOwner !== messageId) {
      throw new OpencodeProjectionError("OpenCode reused a part id across native messages");
    }
    if (previousOwner === undefined) {
      if (this.#partCoordinateCount >= OPENCODE_HISTORY_LIMIT) {
        throw new OpencodeProjectionError("OpenCode projection exceeds the native-part limit");
      }
      this.#partOwner.set(part.id, messageId);
      this.#partCoordinateCount += 1;
    }
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
      if (this.#buffers.size >= OPENCODE_HISTORY_LIMIT) {
        throw new OpencodeProjectionError("OpenCode in-flight message buffer limit exceeded");
      }
      buf = { parts: new Map(), order: [] };
      this.#buffers.set(messageId, buf);
    }
    if (!buf.parts.has(part.id)) buf.order.push(part.id);
    buf.parts.set(part.id, part);
  }

  /** Flush one completed native message after immutable-ID/content admission. */
  #flushMessage(session: Session, messageId: string): boolean {
    const buf = this.#buffers.get(messageId);
    // Subscribe-before-history can leave a queued completion event behind a history snapshot that
    // already emitted the exact message. With no late part buffer, that completion is a duplicate no-op.
    if (buf === undefined && this.#emitted.has(messageId)) return false;
    this.#buffers.delete(messageId);
    const parts = (buf?.order ?? [])
      .map((id) => buf?.parts.get(id))
      .filter((p): p is Part => p !== undefined);

    // Is this message from a followed CHILD sub-agent session? If so, nest it under its spawning Task by
    // tagging parent_tool_use_id = the subtask part's id (#102). undefined → a top-level (main) message.
    const ocSession = this.#msgSession.get(messageId) ?? this.#mainSessionId;
    const childTag = this.#childTag.get(ocSession);
    const role = this.#roles.get(messageId);
    if (role !== "user" && role !== "assistant") {
      throw new OpencodeProjectionError("OpenCode completed a message without a valid role");
    }

    if (role === "user") {
      this.#tryBindBrowserMutation(messageId);
      const text = userPartsText(parts);
      const fresh = this.#emitted.admit(
        messageId,
        JSON.stringify({ role: "user", session: ocSession, text }),
      );
      if (!fresh) return false;
      this.#rememberEmittedParts(messageId, parts);
      // A followed CHILD (non-main) session's user message is the subagent's INTERNAL prompt (the Task
      // input) — already shown via the Task tool_use anchor's `prompt`. Suppress it whether or not we
      // managed to TAG the child: an untagged child (e.g. its session.created raced ahead of the subtask
      // part) still must not leak its internal prompt as a top-level local_prompt (codex review). (#102)
      if (ocSession !== this.#mainSessionId && this.#followed.has(ocSession)) return false;
      const markerParts = parts.filter((part) => this.#browserMutations.has(part.id));
      if (markerParts.length > 1) {
        throw new OpencodeProjectionError("OpenCode merged browser correlation markers");
      }
      const marker = markerParts[0];
      const mutation = marker === undefined ? undefined : this.#browserMutations.get(marker.id);
      if (mutation !== undefined && mutation.text !== text) {
        throw new OpencodeProjectionError("OpenCode browser message echo changed immutable text");
      }
      if (mutation !== undefined) {
        if (marker === undefined || textPartValue(marker) !== mutation.text) {
          throw new OpencodeProjectionError("OpenCode browser part marker changed immutable text");
        }
        if (this.#activeBrowserTurn?.partId !== marker.id) {
          throw new OpencodeProjectionError("OpenCode surfaced an unowned browser marker");
        }
      }
      if (text === "") {
        if (mutation !== undefined) {
          throw new OpencodeProjectionError("OpenCode browser message echo had no text");
        }
        return false;
      }
      // Both browser-origin and TUI-origin prompts enter the shared order only at this canonical native
      // observation. The authenticated browser coordinate rides only its exact caller-assigned PART id.
      session.pushUpstream({
        type: "user",
        uuid: messageId,
        local_prompt: true,
        ...(mutation?.clientMsgId !== undefined ? { client_msg_id: mutation.clientMsgId } : {}),
        message: { role: "user", content: text },
      });
      if (mutation !== undefined && marker !== undefined) this.#browserMutations.delete(marker.id);
      this.#tracer.debug("surfaced canonical native prompt", {
        messageId,
        bytes: text.length,
        browser: mutation !== undefined,
      });
      return true;
    }

    const payloads = coalesceMessage(
      messageId,
      parts,
      childTag !== undefined ? { parentToolUseId: childTag } : {},
    );
    const fresh = this.#emitted.admit(
      messageId,
      JSON.stringify({ role: "assistant", session: ocSession, payloads }),
    );
    if (!fresh) return false;
    this.#rememberEmittedParts(messageId, parts);
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
    return payloads.length > 0;
  }

  /** Retain only projection-relevant per-part semantics, under the same global native-part bound. */
  #rememberEmittedParts(messageId: string, parts: readonly Part[]): void {
    if (this.#emittedParts.has(messageId)) return;
    if (this.#emittedPartCount + parts.length > OPENCODE_HISTORY_LIMIT) {
      throw new OpencodeProjectionError("OpenCode projection exceeds the native-part limit");
    }
    const fingerprints = new Map<string, string>();
    for (const part of parts) fingerprints.set(part.id, partFingerprint(part));
    this.#emittedPartCount += fingerprints.size;
    this.#emittedParts.set(messageId, fingerprints);
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

  /** Apply queued browser text one turn at a time. The downstream reader remains free to deliver an
   * interrupt or permission answer while this worker waits for native idle. */
  async #browserTurnPump(
    session: Session,
    ocSessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !session.closed) {
      const event = await this.#browserTurns.shift(signal);
      if (event === undefined || signal.aborted || session.closed) return;
      await this.#admission.claimTurn(signal);
      if (this.#activeBrowserTurn !== undefined) {
        throw new OpencodeProjectionError("OpenCode admitted overlapping browser turns");
      }

      const text = userText(event.payload);
      if (text.trim() === "" || text.trimStart().startsWith("/")) {
        throw new OpencodeProjectionError("unsupported browser text reached the OpenCode writer");
      }
      const partId = opencodePartId(event.eventId);
      this.#activeBrowserTurn = {
        eventId: event.eventId,
        partId,
        text,
        sawBusy: false,
        correlated: Promise.withResolvers<void>(),
      };

      try {
        await this.#inject(ocSessionId, event, signal);
      } catch (error) {
        if (signal.aborted || session.closed) return;
        if (error instanceof OpencodeProjectionError) throw error;
        throw new OpencodeProjectionError("OpenCode text outcome is unknown; projection fenced");
      }
      session.ack(event.eventId);
    }
  }

  /** Read every downstream event once. Text moves to the turn FIFO; controls remain independently live. */
  async #injectPump(session: Session, ocSessionId: string, signal: AbortSignal): Promise<void> {
    const gen = session.claimWorkerStream();
    for await (const ev of session.followDownstream(gen, () => signal.aborted)) {
      if (signal.aborted || session.closed) return;
      if (ev === null) continue;
      if (ev.eventType === "user") {
        this.#browserTurns.push(ev);
        continue;
      }
      const request = ev.payload.request as { subtype?: unknown } | undefined;
      const mutable =
        (ev.eventType === "control_request" && request?.subtype === "interrupt") ||
        (this.#mirror && ev.eventType === "control_response");
      if (mutable) await this.#admission.waitTransport(signal);
      try {
        await this.#inject(ocSessionId, ev, signal);
      } catch (error) {
        if (signal.aborted || session.closed) return;
        if (error instanceof OpencodeProjectionError) throw error;
        throw new OpencodeProjectionError(
          "OpenCode mutation outcome is unknown; projection fenced",
        );
      }
      session.ack(ev.eventId);
    }
  }

  /** Map one downstream event to at most one native HTTP mutation. */
  async #inject(
    ocSessionId: string,
    ev: { eventId: string; eventType: string; payload: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<void> {
    if (ev.eventType === "user") {
      const text = userText(ev.payload);
      const partId = opencodePartId(ev.eventId);
      const active = this.#activeBrowserTurn;
      if (active?.eventId !== ev.eventId || active.partId !== partId || active.text !== text) {
        throw new OpencodeProjectionError("browser turn lost its native admission claim");
      }
      if (this.#browserMutations.has(partId) || this.#partOwner.has(partId)) {
        throw new OpencodeProjectionError("browser mutation reused a native part coordinate");
      }
      if (this.#partCoordinateCount + this.#browserMutations.size >= OPENCODE_HISTORY_LIMIT) {
        throw new OpencodeProjectionError("OpenCode browser-mutation limit exceeded");
      }
      const clientMsgId = ev.payload.client_msg_id;
      if (clientMsgId !== undefined && typeof clientMsgId !== "string") {
        throw new OpencodeProjectionError("browser mutation carried an invalid client coordinate");
      }
      this.#browserMutations.set(partId, {
        text,
        ...(typeof clientMsgId === "string" ? { clientMsgId } : {}),
      });
      await this.#client.promptAsync(
        ocSessionId,
        { text, model: this.#model, partId },
        sessionMutationSignal(signal),
      );
      // The 204 has no response-assigned message ID. The capture owner (live SSE, or its reconnect
      // history pass) must bind this exact marker+text before the broker event is acknowledged.
      const correlationSignal = sessionMutationSignal(signal);
      await Promise.race([active.correlated.promise, waitAbort(correlationSignal)]);
      throwIfAborted(correlationSignal);
      this.#tracer.debug("injected OpenCode prompt", { partId, bytes: text.length });
      return;
    }
    if (ev.eventType === "control_request") {
      const req = ev.payload.request as { subtype?: string } | undefined;
      const sub = req?.subtype;
      if (sub === "initialize") return;
      if (sub === "interrupt") {
        this.#admission.markNativeBusy();
        await this.#client.abort(ocSessionId, sessionMutationSignal(signal));
        return;
      }
      // Model, mode, status, and end controls are unsupported on the frozen tuple.
      return;
    }
    if (this.#mirror && ev.eventType === "control_response") {
      await this.#replyPermission(ev.payload, sessionMutationSignal(signal));
      return;
    }
    // Defense in depth for older/handcrafted viewers: unsupported types are harmless no-ops.
  }

  /** Prove one session's append-only permission setup. The parent awaits this before readiness. An
   *  already-installed exact rule is not appended again; every other path requires read/PATCH/read-back. */
  async #requireAskMirroring(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (signal !== undefined) throwIfAborted(signal);
    const existing = await this.#client.getSessionPermission(sessionId, signal);
    if (signal !== undefined) throwIfAborted(signal);
    if (hasRemoteClawAskRule(existing)) {
      this.#tracer.info("opencode permission mirroring already installed", { sessionId });
      return;
    }

    await this.#client.setSessionPermission(sessionId, mergeAskRules(existing), signal);
    if (signal !== undefined) throwIfAborted(signal);
    const readBack = await this.#client.getSessionPermission(sessionId, signal);
    if (signal !== undefined) throwIfAborted(signal);
    if (!hasRemoteClawAskRule(readBack)) {
      throw new Error("OpenCode permission read-back did not contain remote-claw ask rule");
    }
    this.#tracer.info("opencode permission mirroring verified", {
      sessionId,
      preserved: existing.length,
    });
  }

  /** Start one best-effort child policy preparation. The run signal is the mutation fence: if a
   *  cancellation-unaware read resolves late, #requireAskMirroring checks it before issuing PATCH.
   *  Keeping the caught task in #childPermissionTasks lets normal teardown join it without extending
   *  the single shared deadline. The first-tool race remains: OpenCode may run the child immediately. */
  #prepareChildAskMirroring(sessionId: string, signal: AbortSignal): void {
    let task: Promise<void>;
    task = this.#requireAskMirroring(sessionId, signal)
      .catch((error: unknown) => {
        if (signal.aborted) return;
        this.#tracer.warn(
          "could not prepare child permission mirroring",
          sessionErrorTraceFields(error, sessionId),
        );
      })
      .finally(() => {
        this.#childPermissionTasks.delete(task);
      });
    this.#childPermissionTasks.add(task);
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
   *  FAIL-CLOSED: only an explicit "allow" → "once"; anything else (deny, or a malformed/absent behavior)
   *  → "reject". The control_response payload carries response.request_id + response.response.behavior
   *  (pushControlResponse's shape). */
  async #replyPermission(payload: Record<string, unknown>, signal: AbortSignal): Promise<void> {
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
    await this.#client.replyPermission(requestId, reply, signal);
    this.#tracer.debug("permission replied", { requestId, reply });
  }
}

/** Compose the #pendingSubtasks key from a parent session id + agent name. A NUL joiner can't appear in
 *  either field, so distinct (parent, agent) pairs never collide. */
function pendingKey(parentSession: string, agent: string): string {
  return `${parentSession}\0${agent}`;
}

/** Exact display semantics for one validated part; identity is the containing map key. */
function partFingerprint(part: Part): string {
  return JSON.stringify(partToBlocks(part));
}

function textPartValue(part: Part | undefined): string | undefined {
  if (part?.type !== "text" || !("text" in part)) return undefined;
  return typeof part.text === "string" ? part.text : undefined;
}

/** Resolve when `signal` aborts (the pump-coupling sentinel in run()'s Promise.race). */
function waitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function sessionMutationSignal(parent: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(OPENCODE_MUTATION_TIMEOUT_MS)]);
}

/** A broker fail-stop ends the companion immediately without touching the externally owned native run. */
async function projectionPumpLifetime(pump: Promise<void>, session: Session): Promise<void> {
  try {
    await pump;
  } catch (error) {
    if (!session.closed) throw error;
  }
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
