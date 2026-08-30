// HostRcRelay — bridges ONE Remote Control session (the MITM's in-memory Session, fed by the real
// `claude --remote-control`) to the E2E-encrypted broker (§3.1/§6A/§17.5). It is the v2 replacement
// for Phase 0's localhost ClientServer: instead of a token-gated local web UI, the clients are broker
// subscribers (phone/laptop), and every frame is sealed so the broker sees only ciphertext.
//
// Two concurrent pumps run for the session's life:
//   • OUTBOUND — tail the session's upstream (assistant/result the worker POSTs back), then admit each
//     rendered item to the shared publication queue, allocate a transcript `seq`, seal, and POST to the
//     session channel; non-durable mode also logs it for host-served catch_up.
//   • INBOUND  — tail the session channel for client frames: a `user` prompt is acked + echoed (so
//     every device's transcript shows it) and injected into claude (pushUserInput); a `catch_up`
//     replays the host log only in non-durable mode; a `permission` grant answers a worker
//     control_request.
//
// catch_up has two regimes (see `#durable`): when the broker reports non-durable (Workflow because it
// has a fixed run cap with no rollover/recovery cursors; Local because it is process memory), the host
// keeps an in-memory `#log` and re-posts it on a viewer `catch_up`. On a DURABLE-log backend
// (per-channel SQLite), the broker retains every frame, so a viewer's subscribe(startIndex:0) replays
// full history on its own; the host builds no `#log` and ignores `catch_up`.
//
// The transcript `seq` is allocated solely here (§6: clients never assign order), and an
// incarnation-long, unbounded `#seen` set dedups the at-least-once inbound stream. This relay's
// broker discipline, but is decoupled into the event-driven shape RC needs (a turn's response is
// async, tool turns interleave).

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Frame, type FrameHeader, timingSafeEqual, utf8 } from "@remote-claw/clawsec";
import {
  type BrokerClient,
  BrokerError,
  BrokerPermanentStorageLossError,
  BrokerStreamRotationError,
  type SeqCursor,
} from "../../broker/client.js";
import { NOOP_TRACER, type Tracer } from "../../trace.js";
import {
  type DriverCapabilities,
  type HarnessDescriptor,
  MITM_CAPABILITIES,
  MITM_HARNESS,
} from "./driver.js";
import type { GitInfo } from "./gitinfo.js";
import { assistantText, permissionModeFrom, type RcEvent, type Session } from "./session.js";

/** Sanitize a viewer-supplied attachment filename to a safe basename (no path traversal, no separators).
 *  A blank/odd name falls back to a generic one; the extension is preserved when present. (#44) */
export function safeAttachmentName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned === "" ? "attachment" : cleaned;
}

/** The file extension matching an image mime, or "" if unknown. The viewer always re-encodes to one of
 *  these, so the on-disk name must carry the matching extension (not the original) for claude's Read. (#44) */
export function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "";
  }
}

/** True if `s` is non-empty, well-formed standard base64 (so a malformed `data` is rejected outright
 *  rather than silently decoded to truncated/empty bytes by Buffer.from). (#44) */
export function isLikelyBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Defensive cap on ONE image's base64 length (~12 MB of bytes). The viewer downscales far below this;
 *  the cap just stops a buggy/hostile client from writing an arbitrarily large file. (#44) */
export const MAX_ATTACHMENT_B64 = 16 * 1024 * 1024;

/** A grouped attachment message (#114) is sent as a chunked frame set (`postMessage`, one msgId, N AEAD
 *  parts), reassembled here. Bound the in-flight reassembly buffer so a hostile/buggy client streaming
 *  endless never-completing parts can't grow host memory unbounded: cap concurrent groups and per-group
 *  parts, and drop a stale/oversized group cleanly (it just burns no seq, like any rejected attachment).
 *  A legitimate send caps at MAX_ATTACHMENT_TOTAL_BYTES (48 MB ⇒ ≤16 chunks), so 32 leaves headroom; the
 *  worst-case aggregate held at once is MAX_INFLIGHT × MAX_PARTS × ~3 MB chunk ≈ 384 MB. */
const MAX_ATTACHMENT_PARTS = 32;
const MAX_INFLIGHT_ATTACHMENT_GROUPS = 4;

/** Client control verbs (§3.7) the relay forwards to the worker as a `control_request`. (A slash
 *  command rides the `user` path instead — claude processes `/compact` etc. as input.) */
const CONTROL_VERBS = new Set(["interrupt", "set_model", "set_mode", "end"]);

function supportsControl(capabilities: DriverCapabilities, kind: string): boolean {
  switch (kind) {
    case "interrupt":
      return capabilities.controls.interrupt;
    case "set_model":
      return capabilities.controls.setModel;
    case "set_mode":
      return capabilities.controls.setMode;
    case "end":
      return capabilities.controls.end;
    default:
      return false;
  }
}

function isStablePlainTextSurface(
  capabilities: DriverCapabilities,
  harness: HarnessDescriptor,
): boolean {
  return (
    harness.agent === "claude-code" &&
    (harness.mode === "rc" || harness.mode === "native-rc") &&
    !capabilities.structuredPermissions &&
    !capabilities.attachments &&
    !capabilities.controls.interrupt &&
    !capabilities.controls.setModel &&
    !capabilities.controls.setMode &&
    !capabilities.controls.end
  );
}

/** The one native-ordered OpenCode text surface. Permission mirroring is an orthogonal experimental
 *  capability: toggling structuredPermissions must not change prompt ordering/correlation semantics. */
function isOpencodeNativeTextSurface(
  capabilities: DriverCapabilities,
  harness: HarnessDescriptor,
): boolean {
  return (
    harness.agent === "opencode" &&
    harness.mode === "opencode" &&
    !capabilities.status &&
    capabilities.controls.interrupt &&
    !capabilities.controls.setModel &&
    !capabilities.controls.setMode &&
    !capabilities.controls.end &&
    !capabilities.attachments
  );
}

/** Out-post retry budget for a transient broker error (409 = the channel was disposed or replaced
 *  between resolve and publish). A `seq` is allocated BEFORE the post, so a dropped post would
 *  strand the viewer on a permanent gap; retrying the SAME frame (deterministic msg_id → viewer
 *  dedups) closes that hole. */
const POST_RETRIES = 6;
const POST_RETRY_BASE_MS = 50;
const LOGICAL_POST_TIMEOUT_MS = 65_000;
const TERMINAL_POST_RETRIES = 3;
const TERMINAL_POST_TIMEOUT_MS = 1_000;
const SEQ_RESUME_ATTEMPTS = 3;
const SEQ_RESUME_RETRY_BASE_MS = 100;
const INBOUND_FAILURE_ATTEMPTS = 3;
const INBOUND_RETRY_DELAY_MS = 150;

function checkedDuration(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero: boolean,
): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || (allowZero ? duration < 0 : duration <= 0)) {
    throw new RangeError(`${name} must be ${allowZero ? "non-negative" : "positive"} and finite`);
  }
  return duration;
}

/** A retry delay that wakes on abort. Resolving (rather than rejecting) lets each caller re-check its
 * own lifecycle/fatal condition without turning normal owner shutdown into a transport failure. */
function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
// One process-wide incarnation orders transcript resets; its wall-clock start plus each relay's
// announce_seq orders presence frames that race in flight. The start time is deliberately explicit
// instead of being parsed from the opaque incarnation id. It is not a durable epoch: equal or
// clock-regressed process starts remain ambiguous unless a future recovery design owns a persisted
// epoch. The current live-session path fails closed instead of claiming cross-process adoption.
const RELAY_INCARNATION_STARTED_AT = Date.now();
const RELAY_INCARNATION = `${RELAY_INCARNATION_STARTED_AT.toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`;
// Re-announce presence at least this often while idle so the viewer's freshness check (#58) has a
// steady signal. Sized UNDER the viewer's ~45s "connected" threshold (≈2× margin) so a single missed
// announce + jitter doesn't read as a disconnect — but no faster, because each keepalive appends a
// frame to the per-identity BUS channel, which (unlike the §6 session window) is not yet trimmed, so
// a slower cadence directly bounds that growth. (Bus windowing is the broker's job — §6 / #36.) A
// phase/needs CHANGE re-announces immediately regardless; this is just the idle floor.
const ANNOUNCE_KEEPALIVE_MS = 20_000;

/** The session's live presence, derived from the worker's status + any open permission gates. Carried
 *  on the (idempotent, meta-plane, never-logged) session_announce so the viewer can show a
 *  thinking/needs-you indicator (#48) and detect disconnect from announce-freshness (#58). */
export function phaseFor(workerStatus: string): "idle" | "thinking" {
  // Live claude (2.1.x) reports "running"; the captured/older protocol used "busy" — both = thinking.
  // Anything else (idle, requires_action, WORKER_STATUS_UNSPECIFIED) is not actively generating.
  return workerStatus === "running" || workerStatus === "busy" ? "thinking" : "idle";
}

export interface HostRcRelayOptions {
  client: BrokerClient;
  /** This machine's 16-byte identity id (for frame headers). */
  identityId: Uint8Array;
  /** The broker session id this RC session maps to (1:1). */
  sessionId: string;
  /** The RC session (from RelayCore) the MITM created for the worker. */
  session: Session;
  /** Optional structured tracer (target "rc.relay"; defaults to no-op). Local-only sink; content
   *  rides at debug+, never the key material. */
  tracer?: Tracer;
  /** Where a viewer-sent attachment (#44) is written on the host before claude reads it. Defaults to
   *  `defaultAttachmentsDir(sessionId)` — claude's own uploads dir, which it reads without a permission
   *  prompt (see that helper); override to redirect. */
  attachmentsDir?: string;
  /** What this driver can faithfully service. Rides every session_announce so the viewer disables the
   *  controls a driver can't honor (no false "✓"). Defaults to MITM_CAPABILITIES (full) so a relay built
   *  without it behaves exactly as before. */
  capabilities?: DriverCapabilities;
  /** Which harness (agent + bridge mode) this session runs. Rides every session_announce so the viewer's
   *  session list can label it (Claude Code · RC / · TX / opencode). Defaults to MITM_HARNESS so a relay
   *  built without it behaves exactly as before. */
  harness?: HarnessDescriptor;
  /** Test/embedding override for the 65s wall around one must-succeed logical publication. */
  postTimeoutMs?: number;
  /** Test/embedding override for the delay between inbound subscription attempts. */
  inboundRetryDelayMs?: number;
  /** Test/embedding override for the base delay between bounded startup cursor attempts. */
  cursorRetryBaseMs?: number;
}

/** Default on-disk location for a viewer-sent attachment (#44): `~/.claude/uploads/<sessionId>/`. This
 *  is the SAME tree the real Anthropic app drops uploaded images into, and claude treats reads there as
 *  trusted — so referencing the written file with `@"<path>"` attaches it natively WITHOUT triggering a
 *  Read-permission prompt (writing to an arbitrary temp dir did prompt). One subdir per session keeps a
 *  later upload from colliding with another session's files. */
export function defaultAttachmentsDir(sessionId: string): string {
  return join(homedir(), ".claude", "uploads", sessionId);
}

/** One content frame to relay out of a worker upstream event. */
interface OutItem {
  kind: string;
  text: string;
  /** Browser source coordinate for a native-canonical user event. Only a provider-ordered companion
   * sets this; the outbound queue publishes the matching receipt at the canonical transcript seq. */
  clientMsgId?: string;
}

/** Cap a tool_result's relayed output so a huge stdout can't bloat the durable transcript log. */
const TOOL_RESULT_CAP = 4000;

/**
 * Flatten a tool_result's `content` to display text. It's either a string (Bash stdout) or an array
 * of blocks (text + images). We surface text and a `[type]` marker for non-text — an image is on the
 * HOST as base64 (too big to relay, not viewable remotely; SendUserFile is the worker→viewer image
 * path). Capped to TOOL_RESULT_CAP.
 */
function toolResultOutput(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        // A content array can hold a `null` or a primitive (model-authored JSON is untrusted); guard
        // so dereferencing `.type` can't throw and kill #pumpUpstream, stalling all later relay output.
        const bb = (typeof b === "object" && b !== null ? b : {}) as {
          type?: string;
          text?: string;
        };
        if (bb.type === "text" && typeof bb.text === "string") return bb.text;
        return typeof bb.type === "string" ? `[${bb.type}]` : "";
      })
      .join("");
  } else {
    text = "";
  }
  return text.length > TOOL_RESULT_CAP ? `${text.slice(0, TOOL_RESULT_CAP)}…[truncated]` : text;
}

/** A user message's prompt text (content is a raw string, or `text` blocks) — used only to surface a
 *  driver-marked LOCAL-origin prompt as a `user` frame (see mapUpstreamItems' `local_prompt` branch). */
function userPromptText(message: { content?: unknown } | undefined): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b): b is { type: string; text: string } => {
      const bb = b as { type?: unknown; text?: unknown };
      return bb.type === "text" && typeof bb.text === "string";
    })
    .map((b) => b.text)
    .join("");
}

/**
 * Expand a worker upstream event into the content frames the viewer renders. An assistant message
 * carries one or more blocks: `text` (the model's words) and `tool_use` (a tool call — including
 * `Task`, which spawns a SUB-AGENT). Sub-agent output arrives as later assistant events whose
 * `parent_tool_use_id` is the spawning Task's id; we tag those `*_sub` so the UI can nest them. So a
 * single event can yield several frames (e.g. "thinking" text + a Bash tool_use), each its own seq.
 */
function mapUpstreamItems(ev: RcEvent): OutItem[] {
  if (ev.eventType === "result") {
    const r = ev.payload.result;
    return [{ kind: "result", text: typeof r === "string" ? r : JSON.stringify(ev.payload) }];
  }
  // A worker `can_use_tool` control_request — surface it so a viewer CAN grant/deny (the reply rides
  // back as an inbound `permission` frame → pushControlResponse). RC usually auto-executes tools with
  // no gate (§17.4), so this is rarely emitted, but we relay it rather than drop it silently.
  if (ev.eventType === "control_request") {
    const req =
      (ev.payload.request as {
        subtype?: string;
        tool_name?: string;
        tool_input?: unknown;
        input?: unknown;
        tool_use_id?: string;
        request_id?: string;
      }) ?? {};
    if (req.subtype !== "can_use_tool") return []; // initialize/other control verbs aren't rendered
    const requestId = (ev.payload.request_id as string) ?? req.request_id ?? "";
    return [
      {
        kind: "permission_request",
        text: JSON.stringify({
          request_id: requestId,
          tool_name: req.tool_name ?? "tool",
          // Real claude carries the tool input under `input` (captured via --rc-trace); the fake/older
          // protocol used `tool_input`. Read both so a real can_use_tool (incl. AskUserQuestion's
          // `questions`) isn't dropped. `tool_use_id` rides the answer back as `toolUseID` (#42).
          tool_input: req.input ?? req.tool_input ?? null,
          tool_use_id: typeof req.tool_use_id === "string" ? req.tool_use_id : "",
        }),
      },
    ];
  }
  // The worker posts tool OUTPUT as a `user`-role message whose content holds tool_result blocks
  // (Bash stdout, a Read's file, …), each keyed by the tool_use_id it answers. Surface those so the UI
  // can show a tool's Output (§40 design). A sub-agent's tool_result carries the spawning Task's
  // `parent_tool_use_id` (like its assistant siblings) — tag it `sub` so the UI nests it under the Task.
  //
  // We relay ONLY the tool_result blocks and deliberately DROP a user event's text. In the live viewer
  // flow that text is the echo of a prompt the inbound pump already emitted (#pumpInbound emits a
  // `user` frame for every client prompt), so relaying it would double every prompt — a guaranteed bug.
  // The cost is that a host-local TUI prompt (typed at the machine, with no inbound echo) isn't
  // surfaced to viewers. There is no worker history backfill to recover it either (#36, grounded: the
  // worker re-emits no history — see docs/protocol.md §12), so the drop is intentional here, not silent loss.
  if (ev.eventType === "user") {
    const sub =
      typeof ev.payload.parent_tool_use_id === "string" && ev.payload.parent_tool_use_id !== "";
    const message = ev.payload.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const items: OutItem[] = [];
    // A LOCAL-origin prompt (a non-MITM driver sets `local_prompt`; real claude NEVER does) is surfaced
    // as a `user` frame so a prompt typed at the host TUI (opencode/tmux) shows up for viewers. The
    // MITM/claude path is byte-identical — it never sets the flag, so it keeps dropping ALL upstream
    // user text (a web prompt is echoed by #pumpInbound; rendering its upstream copy too would double
    // it). The driver must mark ONLY prompts it did NOT inject, or the double-echo returns.
    if (ev.payload.local_prompt === true) {
      const text = userPromptText(message);
      if (text !== "") {
        const clientMsgId = ev.payload.client_msg_id;
        items.push({
          kind: "user",
          text,
          ...(typeof clientMsgId === "string" ? { clientMsgId } : {}),
        });
      }
    }
    for (const b of blocks) {
      const bb = (typeof b === "object" && b !== null ? b : {}) as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (bb.type === "tool_result") {
        items.push({
          kind: "tool_result",
          text: JSON.stringify({
            tool_use_id: typeof bb.tool_use_id === "string" ? bb.tool_use_id : "",
            is_error: bb.is_error === true,
            output: toolResultOutput(bb.content),
            sub,
          }),
        });
      }
    }
    return items;
  }

  // System events: surface the Task/sub-agent lifecycle (task_started/_updated/_notification) so a
  // long-running sub-agent is visible. `thinking_tokens` is a high-frequency streaming counter — too
  // noisy to commit to the durable transcript log, so it's dropped here.
  if (ev.eventType === "system") {
    const p = ev.payload as {
      subtype?: string;
      task_id?: string;
      description?: string;
      tool_use_id?: string;
    };
    const st = typeof p.subtype === "string" ? p.subtype : "";
    if (!st.startsWith("task_")) return [];
    return [
      {
        kind: "task",
        text: JSON.stringify({
          subtype: st,
          task_id: typeof p.task_id === "string" ? p.task_id : "",
          description: typeof p.description === "string" ? p.description : "",
          tool_use_id: typeof p.tool_use_id === "string" ? p.tool_use_id : "",
        }),
      },
    ];
  }

  if (ev.eventType !== "assistant") return []; // other status — not rendered (kept minimal)

  // Sub-agent output is any assistant message produced under a parent Task tool call.
  const sub =
    typeof ev.payload.parent_tool_use_id === "string" && ev.payload.parent_tool_use_id !== "";
  const message = ev.payload.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const items: OutItem[] = [];
  for (const b of blocks) {
    const bb = b as {
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
    };
    if (bb.type === "text" && typeof bb.text === "string" && bb.text !== "") {
      items.push({ kind: sub ? "assistant_sub" : "assistant", text: bb.text });
    } else if (
      bb.type === "thinking" &&
      typeof bb.thinking === "string" &&
      bb.thinking.trim() !== ""
    ) {
      // Extended-thinking block (§17.3): the worker posts the model's reasoning. Relay it as a
      // distinct kind so the UI can render it muted/collapsible (not as a normal reply); tag a
      // sub-agent's reasoning `*_sub` so it nests under its Task, like its text sibling. Per-token
      // streaming isn't available — the RC worker channel delivers COMPLETE messages (the live deltas
      // ride the passed-through /v1/messages inference SSE, not the worker events).
      items.push({
        kind: sub ? "assistant_thinking_sub" : "assistant_thinking",
        text: bb.thinking,
      });
    } else if (bb.type === "tool_use") {
      // A `Task` tool_use is a sub-agent spawn; everything else is a normal tool call. Carry the tool
      // name + input so the UI can render the activity (and recognize a sub-agent).
      items.push({
        kind: "tool_use",
        text: JSON.stringify({ name: bb.name ?? "tool", input: bb.input ?? null, sub }),
      });
    }
  }
  // An assistant turn with text blocks falls back to the concatenated text (covers odd block shapes).
  if (items.length === 0) {
    const text = assistantText(ev.payload);
    if (text !== "") items.push({ kind: sub ? "assistant_sub" : "assistant", text });
  }
  return items;
}

export class HostRcRelay {
  readonly #client: BrokerClient;
  readonly #identityId: Uint8Array;
  readonly #sessionId: string;
  readonly #session: Session;
  /** Next transcript seq to allocate (a single shared timeline across both pumps). */
  #seq = 0;
  /** One shared head-of-line queue for every must-succeed transcript publication from BOTH pumps.
   *  A unit allocates its seq only after it reaches the head, publishes all of its evidence, and
   *  performs its synchronous worker side effect before the next unit may begin. The stored tail is
   *  always normalized after rejection so it can never become an unhandled rejected promise; each
   *  caller still receives (and awaits) its own rejecting operation promise. */
  #publicationTail: Promise<void> = Promise.resolve();
  /** Inbound at-least-once dedup set (msg_id). Grows with the count of DISTINCT client frames this
   *  session (prompts + catch_ups + permission grants) — modest, human-paced, and freed when the
   *  session ends. Must NOT be size-bounded: #tailInbound re-reads from this incarnation's fixed
   *  start index on each reconnect (index 0 in non-durable mode), so an evicted-then-re-read `user`
   *  msg_id would re-inject a duplicate prompt into claude. */
  readonly #seen = new Set<string>();
  /** In-memory replay log — content frames plus unordered state frames such as permission_resolved,
   *  replayed on a viewer `catch_up` (§6/§16). Left EMPTY when `#durable`: a durable-log backend
   *  (per-channel SQLite) keeps every frame, so its own subscribe(0) replays the full history and the host need not
   *  hold (or re-post) a copy. The "one log, mediated by the broker" model — the broker IS history. */
  readonly #log: { recordKind: string; seq: number | null; msgId: string; text: string }[] = [];
  /** True when the broker reports its EFFECTIVE backend is a durable log: the host skips building `#log`
   *  and skips replaying on `catch_up`, because subscribe() serves history straight from the durable
   *  frames table. False (capped/ephemeral backend) keeps the legacy host-replayed catch_up. */
  #durable = false;
  #durabilityDiscovered = false;
  /** First inbound stream offset this relay incarnation may read. On durable restart this is set to the
   *  current frame count before the pumps go live, fencing the fresh empty #seen set above all frames
   *  written by earlier host incarnations. Non-durable backends keep the legacy 0 replay+dedup path. */
  #inboundStartIndex = 0;
  #durableCursorsReady = false;
  #preparePromise: Promise<void> | null = null;

  /** Unanswered permission requests (request_id) — drives the announce's `needs` flag (#48/#58) and
   *  is cleared when the matching inbound `permission` answer arrives (which logs permission_resolved). */
  readonly #openPerms = new Set<string>();
  // AskUserQuestion's `questions` array, retained per open gate (keyed by request_id) so the answer can
  // echo it in updatedInput — real claude's tool runs `call({questions, answers})`, so the answer MUST
  // carry both or claude throws "q.map" on undefined questions. Cleared alongside the gate.
  readonly #askqQuestions = new Map<string, unknown>();
  /** Whether announce() has run; gates the periodic re-announce so a session with a genuinely empty
   *  title/cwd still keepalives (and an un-announced session never does). */
  #announced = false;
  /** Immutable title/cwd/git captured by announce(), reused by periodic presence updates. */
  #annTitle = "";
  #annCwd: string | null = null;
  #annGit: GitInfo | null = null;
  /** A per-incarnation generation and unique-msg-id counter. Unlike sent_at (a wall-clock liveness
   *  value), this strictly orders concurrent publishes from this relay even when they share a
   *  millisecond or reach the broker out of order. */
  #annCount = 0;
  /** One-way presence fence. Once the Session closes, no later keepalive/refresh may advertise its
   *  cse as live. If any live announce was synchronously admitted, terminalization publishes an
   *  absorbing bus tombstone independently of the transcript HOL and of any stalled announce. */
  #presenceTerminal = false;
  #presenceStarted = false;
  #terminalPresenceTask: Promise<void> | null = null;
  readonly #presenceTasks = new Set<Promise<void>>();
  readonly #livePresenceControllers = new Set<AbortController>();
  #advisoryPresenceInFlight = false;
  #advisoryPresenceDirty = false;
  /** Throttle: the last announced presence key + when, so we only re-announce on change or keepalive. */
  #lastPresenceKey = "";
  #lastAnnounceAt = 0;

  /** Latched when durable cursor recovery fails or a must-succeed publish cannot be recorded. A failed
   *  sequenced post burns a transcript seq that cannot be filled; a failed unordered
   *  permission_resolved post must prevent the corresponding worker side effect. In either case
   *  #fatal makes serve() tear down the coupled pumps instead of retrying into inconsistent state.
   *  (A durable seq gap may remain for a reconnecting viewer — §12 recovery boundary, #36.) */
  #fatal = false;
  /** The first must-succeed publication failure. Queued successors reject with this SAME cause before
   *  allocating a seq or publishing anything, so one failure cannot widen into several independent
   *  holes. `#fatal` is the discriminator because JavaScript permits throwing `undefined`. */
  #fatalCause: unknown;

  readonly #trace: Tracer;
  /** Where a viewer attachment is written before claude Reads it (#44). */
  readonly #attachmentsDir: string;
  /** Driver capabilities frozen at readiness and broadcast so the viewer can gate controls. */
  readonly #capabilities: DriverCapabilities;
  /** Which harness (agent + bridge mode) this session runs; broadcast on every announce for the list label. */
  readonly #harness: HarnessDescriptor;
  readonly #postTimeoutMs: number;
  readonly #inboundRetryDelayMs: number;
  readonly #cursorRetryBaseMs: number;
  /** Monotonic prefix making each on-disk attachment name unique (so a later upload can't overwrite a
   *  file an earlier still-queued prompt will Read). (#44) */
  #attachmentSeq = 0;
  /** In-flight reassembly buffer for CHUNKED attachment messages (#114): msgId → (part → frame). A
   *  grouped/large attachment arrives as N AEAD chunks sharing one msgId; we collect them here until all
   *  `parts` are present, then `openMessage` reassembles. Bounded by MAX_INFLIGHT_ATTACHMENT_GROUPS /
   *  MAX_ATTACHMENT_PARTS. (Only `attachment` frames are ever buffered — every other multi-part inbound
   *  kind is still dropped, since acting on a truncated prompt/permission would be unsafe.) */
  readonly #attachmentChunks = new Map<string, Map<number, Frame>>();

  constructor(opts: HostRcRelayOptions) {
    this.#client = opts.client;
    this.#identityId = opts.identityId.slice();
    this.#sessionId = opts.sessionId;
    this.#session = opts.session;
    this.#attachmentsDir = opts.attachmentsDir ?? defaultAttachmentsDir(opts.sessionId);
    this.#capabilities = opts.capabilities ?? MITM_CAPABILITIES;
    this.#harness = opts.harness ?? MITM_HARNESS;
    this.#postTimeoutMs = checkedDuration(
      opts.postTimeoutMs,
      LOGICAL_POST_TIMEOUT_MS,
      "postTimeoutMs",
      false,
    );
    this.#inboundRetryDelayMs = checkedDuration(
      opts.inboundRetryDelayMs,
      INBOUND_RETRY_DELAY_MS,
      "inboundRetryDelayMs",
      true,
    );
    this.#cursorRetryBaseMs = checkedDuration(
      opts.cursorRetryBaseMs,
      SEQ_RESUME_RETRY_BASE_MS,
      "cursorRetryBaseMs",
      true,
    );
    // Bind the session id onto every line (span-like) so interleaved sessions are distinguishable.
    this.#trace = (opts.tracer ?? NOOP_TRACER).child({ session: opts.sessionId });
    // Session.close() is the authoritative, synchronous open→terminal edge. Register here so every
    // close source (native admission, worker/body failure, publication failure, or owner abort) starts
    // the same presence fence without depending on a particular pump/finalizer reaching an await.
    this.#session.onClose(() => {
      void this.terminalizePresence().catch(() => {
        // #postPresenceTerminal records the exhausted failure. The close path itself must stay
        // synchronous/no-throw, and this observer must never create an unhandled rejection.
      });
    });
  }

  #header(recordKind: string, seq: number | null, msgId: string): FrameHeader {
    return {
      v: 1,
      identityId: this.#identityId,
      sessionId: this.#sessionId,
      dir: "out",
      recordKind,
      seq,
      msgId,
      keyEpoch: 0,
      part: 0,
      parts: 1,
    };
  }

  /** Broadcast the first presence announce for this session on the bus (§6B), and remember the
   *  immutable title/cwd/git so periodic presence updates can reuse them.
   *  `git` is a static snapshot of the session's repo state (branch/dirty/ahead-behind) for the
   *  viewer's git chip (#49); null when the session isn't in a git repo. */
  async announce(
    title: string,
    cwd: string | null = null,
    git: GitInfo | null = null,
  ): Promise<void> {
    // This method publishes immediately and deliberately does not call prepare() itself. The production
    // bridge owns the ordering barrier: it completes prepare() BEFORE invoking announce(), then starts
    // announce and serve concurrently. That makes the durable inbound cursor older than every command
    // a newly discovering viewer can publish, without coupling the bus POST to pump startup.
    if (this.#presenceTerminal || this.#session.closed) throw new Error("session closed");
    this.#annTitle = title;
    this.#annCwd = cwd;
    this.#annGit = git;
    this.#announced = true; // gate the periodic re-announce on a real first announce, not on title===""
    await this.#sendAnnounce();
  }

  /** Current presence: phase (idle/thinking) from worker_status, needs (a pending permission or the
   *  worker awaiting a required action), and the effective permission mode when known. A stable string
   *  key lets us re-announce only on change. */
  #presence(): { status: string; phase: "idle" | "thinking"; needs: boolean; mode: string | null } {
    const status = this.#session.workerStatus;
    const needs = status === "requires_action" || this.#openPerms.size > 0;
    return { status, phase: phaseFor(status), needs, mode: this.#session.permissionMode };
  }

  /** Post a session_announce carrying the current presence. Meta-plane + seq===null, so the broker
   *  never logs it — re-announcing is cheap and idempotent (the viewer keeps only the freshest). */
  async #sendAnnounce(): Promise<void> {
    if (this.#presenceTerminal || this.#session.closed) throw new Error("session closed");
    const p = this.#presence();
    // Allocate before the first await. JavaScript runs this section atomically, so every publish
    // admitted by one relay gets a strict generation even when the HTTP requests overlap.
    const announceSeq = this.#annCount++;
    const body: Record<string, unknown> = {
      session_id: this.#sessionId,
      title: this.#annTitle,
      cwd: this.#annCwd,
      sent_at: Date.now(),
      incarnation: RELAY_INCARNATION,
      incarnation_started_at: RELAY_INCARNATION_STARTED_AT,
      announce_seq: announceSeq,
      status: p.status,
      phase: p.phase,
      needs: p.needs,
      git: this.#annGit,
      capabilities: this.#capabilities,
      harness: this.#harness,
    };
    if (p.mode !== null) body.mode = p.mode;
    // This is the live-admission linearization point. It is deliberately before invoking postFrame:
    // sealing itself may await. A close at any later instant therefore sees #presenceStarted and sends
    // the terminal tombstone concurrently, allowing the broker's absorbing fence to suppress a late
    // live request even when this request completes after terminal.
    this.#presenceStarted = true;
    const controller = new AbortController();
    this.#livePresenceControllers.add(controller);
    try {
      const publish = this.#client
        .postFrame(
          this.#header("session_announce", null, `ann-${this.#sessionId}-${announceSeq}`),
          utf8(JSON.stringify(body)),
          controller.signal,
        )
        .then(() => undefined);
      try {
        await this.#trackPresence(publish);
      } catch (error) {
        if (BrokerPermanentStorageLossError.is(error)) {
          // Losing the identity bus while the transcript remains writable would make this live cse
          // undiscoverable and erase its lifecycle projection. This exact broker disposition is the
          // one non-advisory presence failure: latch before close so every racing pump/prepare observes
          // the same first cause, then synchronously make all native MITM routes return 410.
          if (!this.#fatal) {
            this.#fatal = true;
            this.#fatalCause = error;
          }
          this.#session.close("identity bus storage permanently lost");
          try {
            this.#trace.error("identity bus storage lost — aborting relay");
          } catch {
            // Diagnostics are not authority: closing the native session above is the safety action.
          }
          throw this.#fatalCause;
        }
        throw error;
      }
    } finally {
      this.#livePresenceControllers.delete(controller);
    }
    this.#lastPresenceKey = `${p.status}|${p.needs}|${p.mode ?? ""}`;
    this.#lastAnnounceAt = Date.now();
    this.#trace.debug("announce", { phase: p.phase, needs: p.needs, mode: p.mode ?? "" });
  }

  /** Re-announce when presence changed, or when the keepalive floor elapsed (so the viewer's
   *  freshness check has a steady signal). Called on the heartbeat null-tick + after a state change.
   *  Presence is ADVISORY: a failed announce is swallowed (warn-only) so a transient bus blip can't
   *  reject a pump — which, now that serve() couples the pumps, would otherwise tear the session down.
   *  The viewer's freshness check already degrades a missed announce to reconnecting/disconnected. */
  #maybeAnnounce(): void {
    if (!this.#announced || this.#presenceTerminal || this.#session.closed) return;
    const p = this.#presence();
    const key = `${p.status}|${p.needs}|${p.mode ?? ""}`;
    if (
      key !== this.#lastPresenceKey ||
      Date.now() - this.#lastAnnounceAt >= ANNOUNCE_KEEPALIVE_MS
    ) {
      // Presence is advisory and must never become a transcript-pump HOL. Keep at most one background
      // request; concurrent state changes coalesce into one fresh snapshot after it settles. A hung bus
      // request therefore consumes one bounded task/controller but cannot stop native output or input.
      if (this.#advisoryPresenceInFlight) {
        this.#advisoryPresenceDirty = true;
        return;
      }
      this.#advisoryPresenceInFlight = true;
      const publish = this.#sendAnnounce();
      void publish
        .then(
          () => this.#finishAdvisoryPresence(),
          (error: unknown) => {
            try {
              if (!this.#presenceTerminal && !this.#session.closed) {
                this.#trace.warn("announce failed (advisory)", {
                  error: (error as Error)?.message ?? String(error),
                });
              }
            } catch {
              // Diagnostics are not authority: a broken sink cannot poison presence bookkeeping or
              // turn a deliberately backgrounded advisory failure into an unhandled rejection.
            } finally {
              this.#finishAdvisoryPresence();
            }
          },
        )
        .catch(() => {
          // Defense-in-depth for an unexpected bookkeeping exception in either observer. The normal
          // rejection path above already records (best effort) and clears the single-flight latch.
          this.#advisoryPresenceInFlight = false;
        });
    }
  }

  #finishAdvisoryPresence(): void {
    this.#advisoryPresenceInFlight = false;
    if (this.#presenceTerminal || this.#session.closed) {
      this.#advisoryPresenceDirty = false;
      return;
    }
    if (this.#advisoryPresenceDirty) {
      this.#advisoryPresenceDirty = false;
      this.#maybeAnnounce();
    }
  }

  /** Permanently fence this relay's bus presence. The latch and the decision that a tombstone is
   *  required are synchronous, so callers may invoke this from Session.close() without awaiting. A
   *  terminal publish never joins #publicationTail or an announce queue: it must overtake a blocked
   *  transcript/announce request and let the broker suppress any live request that arrives later. */
  terminalizePresence(): Promise<void> {
    if (this.#terminalPresenceTask !== null) return this.#terminalPresenceTask;
    this.#presenceTerminal = true;
    this.#advisoryPresenceDirty = false;
    // Abort every live announce fetch before publishing the tombstone. A request already committed at
    // the broker is ordered before terminal; a request not yet committed cannot linger past close and
    // later resurrect. The absorbing broker fence handles the unavoidable response/commit race.
    for (const controller of this.#livePresenceControllers) controller.abort();
    if (!this.#presenceStarted) {
      this.#terminalPresenceTask = Promise.resolve();
      return this.#terminalPresenceTask;
    }
    const task = this.#postPresenceTerminal();
    this.#terminalPresenceTask = task;
    return this.#trackPresence(task);
  }

  /** Await every live/terminal presence request already admitted. This intentionally never rejects:
   *  individual callers retain their own rejection, while bridge teardown needs a complete flush
   *  barrier without turning a handled broker outage into an unhandled process rejection. */
  async settlePresence(): Promise<void> {
    for (;;) {
      const pending = [...this.#presenceTasks];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  #trackPresence(task: Promise<void>): Promise<void> {
    this.#presenceTasks.add(task);
    void task.then(
      () => this.#presenceTasks.delete(task),
      () => this.#presenceTasks.delete(task),
    );
    return task;
  }

  async #postPresenceTerminal(): Promise<void> {
    const header = this.#header("session_terminal", null, `terminal-${this.#sessionId}`);
    const body = utf8('{"v":1}');
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const post = this.#client.postFrame(header, body, controller.signal);
        // If a custom fetch ignores abort and rejects after the deadline, keep that late settlement
        // observed. The race below is the caller-visible hard bound.
        void post.catch(() => undefined);
        await Promise.race([
          post,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(
                new Error(
                  `presence terminal attempt timed out after ${TERMINAL_POST_TIMEOUT_MS}ms`,
                ),
              );
            }, TERMINAL_POST_TIMEOUT_MS);
          }),
        ]);
        this.#trace.debug("presence terminal published");
        return;
      } catch (error) {
        // A lost response is ambiguous, but retrying is safe: the logical coordinate is deterministic
        // and every broker backend latches terminality by (identity_id, session_id). Retry all transport
        // failures, not only 409, because this is the last safety signal this relay can emit.
        if (attempt < TERMINAL_POST_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, POST_RETRY_BASE_MS * 2 ** attempt));
          continue;
        }
        this.#trace.error("presence terminal publish failed after retries", {
          attempts: attempt + 1,
          error: (error as Error)?.message ?? String(error),
        });
        throw error;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        controller.abort();
      }
    }
  }

  /**
   * POST one out-message (postMessage chunks a large payload into seq-sharing parts, §8). Retries a
   * transient 409 (the channel was disposed or replaced mid-publish) with bounded backoff: the frame's msg_id
   * is deterministic, so a re-post is deduped by the viewer — but a DROPPED post would leave a seq
   * gap that stalls every viewer's orderer forever, so we must not let one slip.
   */
  async #post(recordKind: string, seq: number | null, msgId: string, text: string): Promise<void> {
    const header = this.#header(recordKind, seq, msgId);
    const body = utf8(text);
    const controller = new AbortController();
    const timeoutError = new Error(
      `logical ${recordKind} post timed out after ${this.#postTimeoutMs}ms`,
    );
    timeoutError.name = "HostRcPostTimeoutError";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const operation = (async () => {
      for (let attempt = 0; ; attempt++) {
        attempts = attempt + 1;
        if (controller.signal.aborted) throw controller.signal.reason ?? timeoutError;
        try {
          // One signal covers every chunk and every deterministic 409 retry belonging to this ONE
          // logical post. The caller-visible wall below is authoritative even if the client ignores it.
          await this.#client.postMessage(header, body, undefined, controller.signal);
          return;
        } catch (e) {
          // Once the wall expires, the outcome is ambiguous. Never replay content: a late success plus
          // a retry could duplicate a non-idempotent broker append despite the stable message coordinate.
          if (controller.signal.aborted) throw controller.signal.reason ?? timeoutError;
          // 409 is an authoritative rejection (not an ambiguous lost response), so preserve the existing
          // bounded deterministic retry behavior inside the same logical-post wall.
          if (BrokerError.is(e) && e.status === 409 && attempt < POST_RETRIES) {
            this.#trace.debug("post 409 → retry", { kind: recordKind, seq, attempt: attempt + 1 });
            await waitForRetry(POST_RETRY_BASE_MS * 2 ** attempt, controller.signal);
            continue;
          }
          throw e;
        }
      }
    })();
    // A custom BrokerClient/fetch may ignore abort and settle after the hard wall. Keep that late
    // settlement observed so fail-closed teardown cannot create an unhandled process rejection.
    void operation.catch(() => undefined);
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(timeoutError);
            controller.abort(timeoutError);
          }, this.#postTimeoutMs);
        }),
      ]);
    } catch (e) {
      // Terminal. A CONTENT post (seq !== null) burns a durable transcript `seq` → a permanent gap
      // that stalls a late viewer's orderer forever (§12 boundary #1). Surface it as an ERROR (with
      // the burned seq) so it's an actionable alert, not just a silent #fatal teardown, before it
      // propagates to the enclosing #publishUnit.
      if (seq !== null) {
        this.#trace.error("durable content post failed — seq burned (permanent gap)", {
          kind: recordKind,
          seq,
          msgId,
          attempts,
          error: (e as Error)?.message ?? String(e),
        });
      }
      throw e;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      // On success this prevents no work (the operation is settled); on failure it stops cooperative
      // fetch/body work. Non-cooperative late settlement remains observed above.
      controller.abort();
    }
  }

  /** Post AND (on a non-durable backend) record a replayable out-frame so it can be replayed via
   *  catch_up. On a durable backend the broker keeps the frame, so subscribe() serves the replay and
   *  the host copy is pure waste — skip it. */
  async #emit(recordKind: string, seq: number | null, msgId: string, text: string): Promise<void> {
    await this.#post(recordKind, seq, msgId, text);
    if (!this.#durable) this.#log.push({ recordKind, seq, msgId, text });
    // Per-frame, so it's `trace`. Body length only at this level; the upstream-event log carries a
    // content preview at debug (a content frame here may be any record_kind, so just the shape).
    this.#trace.trace("frame sealed", { kind: recordKind, seq, bytes: text.length });
  }

  /** Admit one complete must-succeed publication unit to the cross-pump head-of-line queue. The first
   *  failing unit closes this Session synchronously and latches its cause. Every successor already
   *  parked on the tail observes that latch before its callback runs, so it cannot allocate a seq,
   *  publish an ack/echo, or mutate the worker. Low-level #post/#emit deliberately stay unqueued: a
   *  unit may need several ordered broker writes followed by one synchronous Session mutation. */
  #publishUnit<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.#publicationTail.then(async () => {
      if (this.#fatal) throw this.#fatalCause;
      if (this.#session.closed) {
        this.#fatal = true;
        this.#fatalCause = new Error("session closed");
        throw this.#fatalCause;
      }
      try {
        return await fn();
      } catch (e) {
        // There is only one queue head, but keep the guard explicit so the first cause remains the
        // authoritative failure even if this method is refactored or Session.close() wakes a sibling.
        if (!this.#fatal) {
          this.#fatal = true;
          this.#fatalCause = e;
          this.#session.close();
        }
        throw this.#fatalCause;
      }
    });
    // Normalize only the INTERNAL tail. Returning `operation` preserves rejection for the pump while
    // preventing a rejected tail from becoming unhandled or poisoning queue bookkeeping.
    this.#publicationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Replay the logged transcript from `since` onward — idempotent (the viewer dedups by seq/msg_id). */
  async #replay(since: number): Promise<void> {
    for (const e of [...this.#log]) {
      if (e.seq === null || e.seq >= since) await this.#post(e.recordKind, e.seq, e.msgId, e.text);
    }
  }

  /** Serve the session until `signal` aborts: run the outbound + inbound pumps concurrently.
   *  The pumps are COUPLED: if either throws (a fatal publish failure), the other is aborted so the
   *  session tears down cleanly instead of limping on with a dead pump — which, combined with the
   *  shared #publicationTail/#fatal, would otherwise leave a live session stranded behind a permanent seq
   *  gap. (Adversarial-review fix.) An external `signal` abort still stops both as before. */
  async serve(signal: AbortSignal): Promise<void> {
    await this.prepare();
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const child = ac.signal;
    // Wake the session's followUpstream gate on abort so the OUTBOUND pump re-checks its stop predicate
    // immediately instead of lingering up to HEARTBEAT_MS parked on the gate. (Without this, serve()
    // only stops promptly when the caller also closes the session.)
    child.addEventListener("abort", () => this.#session.wake(), { once: true });
    const halt = (e: unknown): never => {
      ac.abort(); // stop the sibling pump, then surface the original failure
      throw e;
    };
    const stopSiblingOnCleanEnd = async (pump: Promise<void>): Promise<void> => {
      await pump;
      // Session.close() ends followUpstream cleanly. That is still a terminal bridge transition: do
      // not leave the inbound broker pump alive under a cse whose MITM routes are now all 410.
      if (!child.aborted) ac.abort();
    };
    try {
      await Promise.all([
        stopSiblingOnCleanEnd(this.#pumpUpstream(child)).catch(halt),
        stopSiblingOnCleanEnd(this.#pumpInbound(child)).catch(halt),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Sample the broker's durable cursors before this relay becomes discoverable or starts its pumps.
   *  Idempotent so launch, announce(), and direct tests can all call it without racing duplicate cursor
   *  reads. On a durable backend, failing to resume all cursors remains fail-closed. */
  async prepare(): Promise<void> {
    if (this.#fatal) throw this.#fatalCause;
    if (!this.#durabilityDiscovered) {
      if (this.#preparePromise === null) this.#preparePromise = this.#discoverDurability();
      await this.#preparePromise;
    }
    if (this.#fatal) throw this.#fatalCause;
    if (this.#durable && !this.#durableCursorsReady) {
      throw new Error("durable broker reported but restart cursors are not ready");
    }
  }

  /** Discover the broker's EFFECTIVE durability from the server before either pump starts. Only an
   * authoritative durable:false response may select the legacy path. A read failure leaves durability
   * unknown: treating that as non-durable could replay durable history from zero, so bounded exhaustion
   * is terminal for this cse. */
  async #discoverDurability(): Promise<void> {
    let seqCursor: SeqCursor | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < SEQ_RESUME_ATTEMPTS; attempt++) {
      try {
        seqCursor = await this.#client.seqCursor(this.#sessionId);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < SEQ_RESUME_ATTEMPTS - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.#cursorRetryBaseMs * 2 ** attempt),
          );
        }
      }
    }
    if (seqCursor === null) {
      this.#fatal = true;
      this.#fatalCause = lastError;
      this.#session.close();
      this.#trace.error("durability discovery failed after retries — aborting relay", {
        attempts: SEQ_RESUME_ATTEMPTS,
        error: (lastError as Error)?.message ?? String(lastError),
      });
      throw lastError;
    }

    this.#durabilityDiscovered = true;
    this.#durable = seqCursor.durable;
    if (!this.#durable) {
      if (isStablePlainTextSurface(this.#capabilities, this.#harness)) {
        const error = new Error("stable Claude remote control requires a durable broker backend");
        this.#fatal = true;
        this.#fatalCause = error;
        this.#session.close();
        this.#trace.error("non-durable broker rejected by stable Claude boundary");
        throw error;
      }
      this.#trace.debug("broker reported non-durable relay path");
      return;
    }
    await this.#resumeDurableCursors(seqCursor);
  }

  /** Durable restart recovery has two independent cursors and both must be known BEFORE the pumps can
   *  emit or consume anything. `maxSeq` resumes the outbound transcript seq. `frameCount` resumes the
   *  inbound stream cursor because broker `startIndex` is a publish-order frame offset, not a transcript
   *  seq; counting every row (in/out/meta/chunks) is what makes the first yielded frame exactly the
   *  first publish after this relay incarnation's high-water mark. If either durable read fails after
   *  bounded retries we fail closed: starting at seq/startIndex 0 would either corrupt ordering or
   *  re-execute historical client actions from the durable log. */
  async #resumeDurableCursors(seqCursor: SeqCursor): Promise<void> {
    const max = seqCursor.maxSeq;
    if (max !== null && this.#seq === 0) {
      this.#seq = max + 1;
      this.#trace.debug("resumed seq from durable log", { maxSeq: max, nextSeq: this.#seq });
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < SEQ_RESUME_ATTEMPTS; attempt++) {
      try {
        const count = await this.#client.frameCountCursor(this.#sessionId);
        lastErr = undefined;
        if (!count.durable)
          throw new Error("broker durability changed while resuming durable cursors");
        this.#inboundStartIndex = count.frameCount ?? 0;
        this.#durableCursorsReady = true;
        this.#trace.debug("resumed inbound cursor from durable log", {
          startIndex: this.#inboundStartIndex,
        });
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < SEQ_RESUME_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, this.#cursorRetryBaseMs * 2 ** attempt));
        }
      }
    }
    this.#fatal = true;
    this.#fatalCause = lastErr;
    this.#session.close();
    this.#trace.error("inbound cursor resume failed after retries — aborting durable relay", {
      attempts: SEQ_RESUME_ATTEMPTS,
      error: (lastErr as Error)?.message ?? String(lastErr),
    });
    throw this.#fatalCause;
  }

  /** OUTBOUND: tail the worker's upstream and relay each assistant/result as a content frame. */
  async #pumpUpstream(signal: AbortSignal): Promise<void> {
    this.#trace.debug("pumpUpstream start");
    for await (const ev of this.#session.followUpstream(() => signal.aborted)) {
      if (ev === null) {
        this.#maybeAnnounce(); // idle null-tick → refresh presence (keepalive + a phase flip)
        continue;
      }
      // The worker cancels a pending gate (e.g. the turn was interrupted) with a control_cancel_request
      // carrying the gate's request_id — the GROUNDED signal (captured via --rc-trace) that an open
      // permission is now unanswerable. Clear it so `needs` doesn't stay pinned true. (Primary fix for
      // the sticky-needs finding; the interrupt/end verb clear in #driveControlVerb is a backstop.)
      if (ev.eventType === "control_cancel_request") {
        const id = ev.payload.request_id;
        if (typeof id === "string") {
          this.#askqQuestions.delete(id); // symmetric with the other gate-teardown sites
          if (this.#openPerms.delete(id)) {
            this.#trace.debug("gate cancelled by worker", { request_id: id });
            this.#maybeAnnounce();
          }
        }
        continue; // not a rendered content frame
      }
      const mode = permissionModeFrom(ev.payload);
      if (mode !== null && mode !== this.#session.permissionMode) {
        this.#session.permissionMode = mode;
        this.#maybeAnnounce();
      }
      const items = mapUpstreamItems(ev);
      this.#trace.debug("upstream event", {
        event: ev.eventType,
        items: items.map((i) => i.kind).join(",") || "skip",
      });
      for (const item of items) {
        if (item.kind === "permission_request" && !this.#capabilities.structuredPermissions) {
          this.#trace.warn("permission request suppressed by stable capability boundary");
          continue;
        }
        await this.#publishUnit(async () => {
          // Register a permission gate only after this item reaches the queue head, and BEFORE its
          // publish: #emit yields the event loop, so a fast viewer can enqueue a grant while the POST
          // is completing. The inbound grant is serialized behind this whole unit and therefore sees
          // the gate. Roll it back if publication fails because no viewer can answer an unseen request.
          let gateId: string | null = null;
          if (item.kind === "permission_request") {
            try {
              const parsed = JSON.parse(item.text) as {
                request_id?: unknown;
                tool_name?: unknown;
                tool_input?: { questions?: unknown };
              };
              const id = parsed.request_id;
              if (typeof id === "string" && id !== "") {
                gateId = id;
                this.#openPerms.add(id);
                // Stash AskUserQuestion's questions so the answer's updatedInput carries
                // {questions,answers}.
                if (
                  parsed.tool_name === "AskUserQuestion" &&
                  parsed.tool_input?.questions !== undefined
                ) {
                  this.#askqQuestions.set(id, parsed.tool_input.questions);
                }
              }
            } catch {
              // a malformed permission_request body — don't track an unanswerable gate
            }
          }
          const seq = this.#seq++;
          try {
            // A native-canonical browser prompt is not echoed at inbound admission: native history owns
            // its place in the shared order. Reconcile the optimistic browser row only now, at the
            // canonical native event's seq, immediately before publishing that user frame.
            if (item.clientMsgId !== undefined) {
              await this.#post(
                "accepted",
                null,
                `accepted-${this.#sessionId}-${seq}`,
                JSON.stringify({ client_msg_id: item.clientMsgId, seq }),
              );
            }
            await this.#emit(item.kind, seq, `${item.kind}-${seq}`, item.text);
          } catch (e) {
            if (gateId !== null) {
              this.#openPerms.delete(gateId); // publish failed → gate is unanswerable
              this.#askqQuestions.delete(gateId);
            }
            throw e;
          }
        });
      }
      this.#maybeAnnounce(); // an event may have flipped phase (running) or opened a gate
    }
    this.#trace.debug("pumpUpstream end");
  }

  /** INBOUND: tail the session channel for client frames and drive the worker. Re-subscribes if the
   *  stream ends — the session run may not exist yet (the relay serves before the first client
   *  prompt) or may have been explicitly closed/replaced; `#seen` dedups the re-read. */
  async #pumpInbound(signal: AbortSignal): Promise<void> {
    this.#trace.debug("pumpInbound start");
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await this.#tailInbound(signal, () => {
          // Only a newly admitted authenticated frame proves this subscription carried useful
          // protocol traffic. Replays, misroutes, and failed authentication do not forgive failures.
          consecutiveFailures = 0;
        });
        if (signal.aborted || this.#session.closed) break;
        // A successful empty/clean response is the broker's existing absent-channel signal (the host
        // serves before the first client publish). It is not a transport/protocol failure.
        consecutiveFailures = 0;
      } catch (e) {
        // A must-succeed publish or cursor-recovery failure latches #fatal; continuing could widen a
        // burned seq gap or apply a permission decision without durable evidence. Propagate and let
        // serve() tear the relay down.
        if (this.#fatal) throw e;
        // Owner shutdown is an expected lifecycle transition, even when it races an unrelated stream
        // rejection. Check this only after the publication latch above: Session.close() is also how a
        // real fatal wakes the sibling pump, and that first cause must still propagate.
        if (signal.aborted || this.#session.closed) break;
        if (BrokerStreamRotationError.is(e)) {
          // The route deliberately closed below its hosting-runtime ceiling. This proves neither a new
          // authenticated admission nor a transport failure, so preserve (but do not reset) the circuit.
          this.#trace.debug("inbound stream planned rotation → reconnect", {
            failures: consecutiveFailures,
          });
        } else {
          consecutiveFailures += 1;
          if (consecutiveFailures >= INBOUND_FAILURE_ATTEMPTS) {
            this.#fatal = true;
            this.#fatalCause = e;
            this.#session.close();
            this.#trace.error("inbound transport failed after retries — aborting relay", {
              attempts: consecutiveFailures,
              error: (e as Error)?.message ?? String(e),
            });
            throw e;
          }
          // The error stays in local diagnostics: the human formatter clips it, while JSON file capture
          // is intentionally unclipped.
          this.#trace.warn("inbound tail threw → retry", {
            attempt: consecutiveFailures,
            error: (e as Error)?.message ?? String(e),
          });
        }
      }
      if (signal.aborted) break;
      await waitForRetry(this.#inboundRetryDelayMs, signal); // run not up / stream closed → retry
    }
    this.#trace.debug("pumpInbound end");
  }

  async #tailInbound(signal: AbortSignal, admitted: () => void): Promise<void> {
    this.#trace.debug("inbound subscribe");
    for await (const frame of this.#client.streamFrames({
      session: this.#sessionId,
      startIndex: this.#durable ? this.#inboundStartIndex : 0,
      signal,
    })) {
      // The broker is an untrusted router. AEAD authenticates the CLEAR header the sender chose, but
      // openFrame derives K_session from frame.sessionId; it does not prove that the broker returned the
      // frame on the channel this relay requested. Bind every authenticated input to this relay BEFORE
      // dedup, decryption, or side effects. Otherwise a broker could replay a valid `dir:"in"` command
      // from sibling session B on session A's stream and it would open under B's key, then drive A.
      // Rejecting before #seen is equally important: a misrouted frame must not suppress a later valid
      // frame for this session that happens to carry the same cleartext msgId.
      const sessionMatches = frame.sessionId === this.#sessionId;
      const identityMatches = timingSafeEqual(frame.identityId, this.#identityId);
      if (frame.dir !== "in" || !sessionMatches || !identityMatches) {
        this.#trace.warn("dropped misrouted inbound frame", {
          kind: frame.recordKind,
          dir: frame.dir,
          session_matches: sessionMatches,
          identity_matches: identityMatches,
        });
        continue;
      }
      // Multi-part inbound: ONLY an `attachment` may be reassembled (#114) — collect its chunks and act
      // only on the complete, AEAD-verified message. Every OTHER kind is still dropped loudly: `openFrame`
      // returns only THIS frame's plaintext, so acting on a `parts > 1` user/permission/control frame
      // would act on a silently truncated prompt/answer.
      if (frame.parts !== 1) {
        if (frame.recordKind !== "attachment") {
          this.#trace.warn("dropped multi-part inbound frame", {
            kind: frame.recordKind,
            parts: frame.parts,
            msg: frame.msgId,
          });
          continue;
        }
        // Authenticate each chunk before retaining it in the in-flight group. The final openMessage
        // below authenticates the complete coordinate again, but this first open is what prevents an
        // untrusted broker from using a forged part to mutate the reassembly buffer.
        if ((await this.#openInboundFrame(frame)) === null) continue;
        if (!this.#capabilities.attachments) {
          if (this.#seen.has(frame.msgId)) continue;
          this.#seen.add(frame.msgId);
          this.#trace.warn("attachment suppressed by stable capability boundary");
          admitted();
          continue;
        }
        if (this.#seen.has(frame.msgId)) continue; // message already reassembled + handled
        const payload = await this.#collectAttachmentChunk(frame);
        if (payload === null) continue; // group not complete (or rejected) yet
        this.#seen.add(frame.msgId);
        await this.#handleAttachmentPayload(payload, frame.clientMsgId ?? null);
        // A partial chunk is not a complete protocol admission. Reset only after the authenticated
        // message is complete and dedup-latched; otherwise bounded-buffer eviction plus replay could
        // make the same incomplete groups look like fresh progress on every failed subscription.
        admitted();
        continue;
      }
      this.#trace.trace("inbound frame", { kind: frame.recordKind, msg: frame.msgId });
      // AEAD authentication MUST precede persistent dedup. The broker sees the clear msg_id and can
      // return a tampered copy before the genuine frame. Remembering the id before open would let that
      // invalid copy permanently suppress the later authentic command. Open failures are deterministic
      // local authentication failures, so drop them and continue this stream rather than resubscribing
      // behind a poisoned #seen entry.
      const plaintext = await this.#openInboundFrame(frame);
      if (plaintext === null) continue;
      if (this.#seen.has(frame.msgId)) continue; // authenticated at-least-once replay
      this.#seen.add(frame.msgId);

      if (frame.recordKind === "user") {
        const text = new TextDecoder().decode(plaintext);
        const trimmed = text.trim();
        if (
          (isStablePlainTextSurface(this.#capabilities, this.#harness) ||
            isOpencodeNativeTextSurface(this.#capabilities, this.#harness)) &&
          (trimmed === "" || trimmed.startsWith("/"))
        ) {
          this.#trace.warn("unsupported text mutation suppressed by capability boundary");
          admitted();
          continue;
        }
        if (
          this.#harness.mode === "native-rc" ||
          isOpencodeNativeTextSurface(this.#capabilities, this.#harness)
        ) {
          // Native history is the ordering authority for this companion. First prove the broker can
          // durably record a pre-mutation admission, then enqueue one immutable native UUID/timestamp.
          // This seq-null shape is intentionally ignored by current viewers; the canonical history
          // event later emits the ordinary {client_msg_id,seq} receipt and the one user frame together.
          await this.#publishUnit(async () => {
            await this.#post(
              "accepted",
              null,
              `admitted-${frame.msgId}`,
              JSON.stringify({ client_msg_id: frame.clientMsgId ?? null, native_pending: true }),
            );
            this.#assertSessionOpen();
            this.#session.pushUserInput(text, {
              ...(frame.clientMsgId !== undefined ? { clientMsgId: frame.clientMsgId } : {}),
            });
          });
          this.#trace.debug("native user prompt admitted", { bytes: text.length });
        } else {
          // Ack the client's frame (meta), echo the prompt (content, so every device sees it), then
          // inject it into the real claude as ONE queued unit. Its seq is allocated only at the queue
          // head, and the synchronous injection stays inside the unit so later publications cannot
          // overtake the native side effect. A failed post closes the Session before any injection.
          const userSeq = await this.#publishUnit(async () => {
            const seq = this.#seq++;
            await this.#post(
              "accepted",
              null,
              `accepted-${this.#sessionId}-${seq}`,
              JSON.stringify({ client_msg_id: frame.clientMsgId ?? null, seq }),
            );
            await this.#emit("user", seq, `user-${seq}`, text);
            this.#assertSessionOpen();
            this.#session.pushUserInput(text);
            return seq;
          });
          // Debug records shape and size only; conversation content requires explicit trace mode.
          this.#trace.debug("user prompt", { seq: userSeq, bytes: text.length });
        }
      } else if (frame.recordKind === "catch_up") {
        if (this.#durable) {
          // The durable backend's own log answers catch_up: the viewer's subscribe(startIndex:0) already
          // replays the full history straight from the frames table, so there's nothing for the host to
          // re-post. `since` is irrelevant, but the frame was still authenticated before dedup above.
          this.#trace.debug("catch_up ignored — durable backend serves history");
        } else {
          const body = JSON.parse(new TextDecoder().decode(plaintext));
          const since = typeof body.since === "number" ? body.since : 0;
          this.#trace.debug("catch_up replay", { since, frames: this.#log.length });
          // Replays are must-succeed publications too. Queue them through the same fatal boundary so
          // an ambiguous timeout closes this cse instead of letting a reconnect re-enter publication.
          await this.#publishUnit(() => this.#replay(since));
        }
      } else if (frame.recordKind === "permission") {
        if (!this.#capabilities.structuredPermissions) {
          this.#trace.warn("permission answer suppressed by stable capability boundary");
          admitted();
          continue;
        }
        const body = JSON.parse(new TextDecoder().decode(plaintext));
        const resolved = await this.#publishUnit(async () => {
          // Check/delete the gate only at the queue head. That makes a fast answer serialize behind the
          // permission_request unit that registers it, while duplicates/stale ids remain idempotent.
          if (typeof body.request_id !== "string" || !this.#openPerms.delete(body.request_id)) {
            return false;
          }
          // FAIL CLOSED: only an explicit "allow" grants; anything else (deny, or a malformed/absent
          // behavior) → deny, so a garbled answer frame can never auto-approve a tool. A real viewer
          // always sends an explicit "allow"/"deny", so this only changes malformed-frame handling.
          const behavior = body.behavior === "allow" ? "allow" : "deny";
          this.#trace.debug("permission response", { behavior });
          // An AskUserQuestion answer (#42) carries `answers` (+ the request's `tool_use_id`) — forward
          // them so pushControlResponse builds the real `updatedInput.answers` + `toolUseID` shape.
          const extra: {
            toolUseId?: string;
            answers?: Record<string, string | string[]>;
            questions?: unknown;
          } = {};
          if (typeof body.tool_use_id === "string" && body.tool_use_id) {
            extra.toolUseId = body.tool_use_id;
          }
          if (body.answers !== null && typeof body.answers === "object") {
            extra.answers = body.answers as Record<string, string | string[]>;
          }
          // Echo the AskUserQuestion's questions (stashed at gate-open) so claude's tool call() receives
          // the full {questions, answers} input — omitting questions is the `q.map` crash. Clear either way.
          const askqQuestions = this.#askqQuestions.get(body.request_id);
          if (askqQuestions !== undefined) extra.questions = askqQuestions;
          this.#askqQuestions.delete(body.request_id);
          // Log permission_resolved BEFORE the worker side effect, in this same queued unit. A failed
          // publish closes the Session and cannot be overtaken by another pump's publication.
          await this.#emit(
            "permission_resolved",
            null,
            `permresolved-${body.request_id}`,
            JSON.stringify(
              extra.answers
                ? { request_id: body.request_id, behavior, answers: extra.answers }
                : { request_id: body.request_id, behavior },
            ),
          );
          this.#assertSessionOpen();
          this.#session.pushControlResponse(body.request_id, behavior, extra);
          return true;
        });
        if (resolved) {
          // Clearing the gate also drops `needs` from presence — re-announce so the viewer's
          // needs-you indicator clears (#58).
          this.#maybeAnnounce();
        }
      } else if (frame.recordKind === "attachment") {
        if (!this.#capabilities.attachments) {
          this.#trace.warn("attachment suppressed by stable capability boundary");
          admitted();
          continue;
        }
        await this.#handleAttachmentPayload(plaintext, frame.clientMsgId ?? null);
      } else if (CONTROL_VERBS.has(frame.recordKind)) {
        if (!supportsControl(this.#capabilities, frame.recordKind)) {
          this.#trace.warn("control verb suppressed by capability boundary", {
            kind: frame.recordKind,
          });
          admitted();
          continue;
        }
        // A client control verb (§3.7) — ESC the turn, switch model/mode, end the session. Forward it
        // to the worker as a `control_request` with the mapped subtype + params. It owns no transcript
        // seq, but still joins the shared queue: a control native side effect must not race past an
        // earlier projection whose broker publication later fails.
        await this.#publishUnit(() => this.#driveControlVerb(frame.recordKind, plaintext));
      }
      admitted();
    }
  }

  /** Authenticate one coordinate-bound inbound frame without letting a broker-forged ciphertext tear
   *  down or poison the relay. No caller mutates dedup/reassembly/native state until this succeeds. */
  async #openInboundFrame(frame: Frame): Promise<Uint8Array | null> {
    try {
      return await this.#client.openFrame(frame);
    } catch (e) {
      this.#trace.warn("inbound frame authentication failed", {
        kind: frame.recordKind,
        error: (e as Error)?.message ?? String(e),
      });
      return null;
    }
  }

  /**
   * Collect one chunk of a CHUNKED attachment message (#114) and, once all `parts` have arrived,
   * reassemble + AEAD-verify them into the full plaintext (`openMessage`). Returns null while the group
   * is incomplete (or on a rejected/oversized group — dropped cleanly, no seq burned). Bounded by
   * MAX_INFLIGHT_ATTACHMENT_GROUPS / MAX_ATTACHMENT_PARTS so endless never-completing parts can't grow
   * host memory. `(msgId, part)` is the dedup key here (the final `msgId` join lives in #seen).
   */
  async #collectAttachmentChunk(frame: Frame): Promise<Uint8Array | null> {
    if (frame.parts > MAX_ATTACHMENT_PARTS) {
      this.#trace.warn("attachment too many parts", { parts: frame.parts, msg: frame.msgId });
      return null;
    }
    let group = this.#attachmentChunks.get(frame.msgId);
    if (group === undefined) {
      if (this.#attachmentChunks.size >= MAX_INFLIGHT_ATTACHMENT_GROUPS) {
        // Evict the OLDEST in-flight group (Map preserves insertion order) to bound memory.
        const oldest = this.#attachmentChunks.keys().next().value;
        if (oldest !== undefined) this.#attachmentChunks.delete(oldest);
        this.#trace.warn("attachment groups overflow — dropped oldest", { dropped: oldest });
      }
      group = new Map();
      this.#attachmentChunks.set(frame.msgId, group);
    }
    group.set(frame.part, frame); // idempotent on a re-delivered part
    if (group.size < frame.parts) return null; // not all parts yet
    this.#attachmentChunks.delete(frame.msgId);
    try {
      return await this.#client.openMessage([...group.values()]);
    } catch (e) {
      this.#trace.warn("attachment reassembly failed", {
        error: (e as Error)?.message ?? String(e),
      });
      return null; // a forged/inconsistent chunk fails openMessage — drop the group
    }
  }

  /**
   * Handle a (possibly multi-image) viewer attachment payload (#44/#114): write each E2E-decrypted image
   * into the host's uploads dir, then drive claude with ONE prompt referencing them all — `@"p1" @"p2"
   * <caption>` — so claude attaches them natively and the caption rides ONCE (not repeated per image).
   * Echoes a SINGLE `user` content frame (`📎 a.jpg, b.jpg\n<caption>`) so every device's transcript
   * shows the group as one message. Accepts the new `{ images: [...] , caption }` shape and the legacy
   * single `{ name, mime, data, caption }` shape. A parse/write failure is logged, not fatal — but the
   * echo is ordered before the inject (and fatal-on-throw) so claude never reads an image no viewer saw.
   */
  async #handleAttachmentPayload(plaintext: Uint8Array, clientMsgId: string | null): Promise<void> {
    const written: { name: string; path: string }[] = [];
    let caption = "";
    try {
      const body = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
      caption = typeof body.caption === "string" ? body.caption : "";
      // New grouped shape: { images: [{name,mime,data}], caption }. Legacy: { name,mime,data,caption }.
      const images = Array.isArray(body.images) ? body.images : [body];
      for (const img of images) {
        const w = await this.#writeOneImage(img as Record<string, unknown>);
        if (w !== null) written.push(w);
      }
    } catch (e) {
      this.#trace.warn("attachment rejected", { error: (e as Error)?.message ?? String(e) });
      return; // bad payload / unwritable — drop (non-fatal: no seq was allocated)
    }
    if (written.length === 0) return; // nothing valid decoded → drop (no seq burned)
    // Ack FIRST (carries clientMsgId+seq so the viewer can reconcile its optimistic echo, #113), then the
    // content echo (durably — a failed post is fatal), THEN inject: same ordering as the `user` path, so a
    // torn-down relay can't have driven claude to Read images that never reached any transcript. The
    // complete ack+echo+inject action occupies one cross-pump queue slot.
    const chips = written.map((w) => `📎 ${w.name}`).join(", ");
    // Reference every written file with the SAME `@"<abs-path>"` syntax real Anthropic uses for an
    // app-uploaded image (captured via --rc-trace), so claude attaches them NATIVELY as image blocks. The
    // caption (or a default) follows ALL the refs ONCE — claude treats it as one user turn with N images.
    const refs = written.map((w) => `@"${w.path}"`).join(" ");
    const fallback =
      written.length > 1 ? "What do you see in these images?" : "What do you see in this image?";
    await this.#publishUnit(async () => {
      const seq = this.#seq++;
      await this.#post(
        "accepted",
        null,
        `accepted-${this.#sessionId}-${seq}`,
        JSON.stringify({ client_msg_id: clientMsgId, seq }),
      );
      await this.#emit("user", seq, `user-${seq}`, `${chips}${caption ? `\n${caption}` : ""}`);
      this.#assertSessionOpen();
      this.#session.pushUserInput(`${refs} ${caption || fallback}`);
    });
  }

  /**
   * Write ONE image of an attachment to the uploads dir; returns {name (chip), path (abs)} or null if the
   * image is malformed base64 / oversized / empty (the caller skips it). The on-disk name carries a unique
   * prefix (no overwrite of a still-referenced file) + the extension matching the ACTUAL bytes (the viewer
   * re-encodes), so claude's image Read detects the type right.
   */
  async #writeOneImage(
    img: Record<string, unknown>,
  ): Promise<{ name: string; path: string } | null> {
    if (typeof img.data !== "string" || !isLikelyBase64(img.data)) return null;
    if (img.data.length > MAX_ATTACHMENT_B64) {
      this.#trace.warn("attachment image too large", { b64: img.data.length });
      return null;
    }
    const bytes = Buffer.from(img.data, "base64");
    if (bytes.length === 0) return null;
    const name = safeAttachmentName(typeof img.name === "string" ? img.name : "");
    const mime = typeof img.mime === "string" ? img.mime : "";
    const ext = extForMime(mime);
    const stem = name.replace(/\.[A-Za-z0-9]+$/, "") || "attachment";
    const diskName = `${(this.#attachmentSeq++).toString(36)}-${ext ? `${stem}.${ext}` : name}`;
    await mkdir(this.#attachmentsDir, { recursive: true });
    const path = join(this.#attachmentsDir, diskName);
    await writeFile(path, bytes);
    this.#trace.debug("attachment written", { name, diskName, bytes: bytes.length });
    return { name, path };
  }

  /** Map a client control-verb frame → the worker control_request the spec uses (§3.7). */
  async #driveControlVerb(kind: string, plaintext: Uint8Array): Promise<void> {
    // #tailInbound already AEAD-authenticated this frame before persistent dedup and queued this
    // immutable plaintext. Even a bodyless verb (interrupt/end) therefore has authenticated origin.
    let body: Record<string, unknown>;
    try {
      const raw = new TextDecoder().decode(plaintext);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed === null || typeof parsed !== "object") return; // authenticated but malformed → drop
      body = parsed as Record<string, unknown>;
    } catch {
      this.#trace.warn("control verb rejected (parse)", { kind });
      return; // authenticated but unparseable → reject, never drive a control action
    }
    // Drop a STALE control frame: a malicious broker can withhold a valid frame and replay it much
    // later. The client stamps `expiry`; past it, the verb is a no-op. The separate catch_up branch
    // currently does not enforce its stamped expiry; docs/protocol.md §11 records that boundary.
    if (typeof body.expiry === "number" && body.expiry < Date.now()) {
      this.#trace.warn("control verb dropped (stale)", { kind });
      return;
    }
    this.#assertSessionOpen();
    this.#trace.debug("control verb", { kind });
    switch (kind) {
      case "interrupt":
        this.#session.pushControlRequest("interrupt");
        // Interrupting the turn abandons any in-flight can_use_tool gate — its request_id is now
        // unanswerable (the viewer moved on; no `permission` frame will ever arrive). Clear the open
        // gates so `needs` doesn't stay pinned true forever on an idle session. (Adversarial-review fix.)
        this.#clearOpenPerms();
        break;
      case "set_model":
        if (typeof body.model === "string")
          this.#session.pushControlRequest("set_model", { model: body.model });
        break;
      case "set_mode":
        if (typeof body.mode === "string" && body.mode !== "") {
          // Drive the worker verb regardless — the driver honors it (mitm) or safely no-ops it
          // (obligation #4). But only REFLECT the mode as confirmed presence when this driver can
          // actually enter it; otherwise announcing body.mode fabricates a "✓" the worker never honored
          // (tmux/opencode have no mode analogue). A capability-gated viewer won't show the control, but
          // an older viewer or a pre-announce race can still send set_mode — so guard here too.
          this.#session.pushControlRequest("set_permission_mode", { mode: body.mode });
          if (this.#capabilities.controls.setMode) {
            this.#session.permissionMode = body.mode;
            this.#maybeAnnounce();
          }
        }
        break;
      case "end":
        // claude's REPL bridge has NO remote session-end. Its control_request switch (verified against
        // the 2.1.x binary — initialize / set_model / set_max_thinking_tokens / set_permission_mode /
        // rename_session / set_color / file_suggestions / read_file / get_context_usage / get_usage /
        // mcp_* / interrupt) has no `end_session` case, so sending it only drew an error control_response
        // ("REPL bridge does not handle control_request subtype: end_session"). The REAL RC server hits
        // the same wall — it emits end_session with reason:archived and is rejected identically (captured
        // via --rc-trace; docs/protocol.md §11). So we drive NO worker control_request here; claude is
        // ended at its own terminal (/quit, Ctrl-C). We still clear any open gate so `needs` can't stick.
        this.#clearOpenPerms();
        break;
    }
  }

  /** Drop all open permission gates and refresh presence so `needs` clears. Used when a turn is
   *  interrupted or the session ends, which abandon any pending can_use_tool without a viewer answer. */
  #clearOpenPerms(): void {
    if (this.#openPerms.size === 0) return;
    this.#openPerms.clear();
    this.#askqQuestions.clear();
    this.#maybeAnnounce(); // backgrounded + single-flight: presence never blocks a transcript unit
  }

  #assertSessionOpen(): void {
    if (this.#session.closed) throw new Error("session closed");
  }
}
