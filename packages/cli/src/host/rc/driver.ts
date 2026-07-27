// packages/cli/src/host/rc/driver.ts
//
// The CANONICAL pluggable-harness seam. A `Driver` produces a `Session` and bridges a harness's
// native protocol to the canonical Session contract, so HostRcRelay + the broker router + the web
// viewer are UNCHANGED. Grounded in the real code: HostRcRelay is a pure function of
// (Session, BrokerClient); it owns broker command/content traffic and presence publication, while a
// driver owns only the harness-facing side and the two meet at the Session.

import type { Identity } from "@remote-claw/clawsec";
import type { BrokerClient } from "../../broker/client.js";
import type { Tracer } from "../../trace.js";
import type { GitInfo } from "./gitinfo.js";
import type { Session } from "./session.js";

/** The driver names the wrapper can dispatch on (`--rc-driver=<name>`, default "mitm"). */
export type DriverName = "mitm" | "tmux" | "opencode";

/** Per-verb control support. Coarse "controlVerbs: boolean" couldn't say "interrupt works but set_mode
 *  doesn't", which made the viewer fabricate a confirmed mode/model for a driver that silently no-ops it
 *  (a permission-mode "✓" that lies). Each verb is declared independently so the viewer can disable+label
 *  exactly the controls a driver can't honor. `end` is false on EVERY driver: claude's REPL bridge has no
 *  remote session-end (see relay.ts `end` case), so no harness can faithfully service it. */
export interface ControlCapabilities {
  /** interrupt the current turn (mitm: control_request; tmux: ESC; opencode: abort). */
  interrupt: boolean;
  /** switch model and have it take effect (mitm: set_model; tmux: `/model <alias>` inject). opencode
   *  only honors `providerID/modelID`, not the viewer's bare aliases, so it declares false. */
  setModel: boolean;
  /** switch permission mode (Plan / Accept-edits / …) and have the worker actually enter it (mitm only;
   *  tmux/opencode have no faithful pane/session analogue). */
  setMode: boolean;
  /** end the session remotely — false everywhere (no claude REPL analogue). */
  end: boolean;
}

/** A driver declares which broker-side features it can faithfully service. The relay surfaces this on
 *  `session_announce` and the viewer disables+labels controls a driver can't honor (no false "✓"). */
export interface DriverCapabilities {
  /** Can surface + round-trip structured can_use_tool permission gates (else auto-approve/ignore). When
   *  false the session runs WITHOUT gating (--dangerously-skip-permissions / no per-tool ask) — the
   *  viewer shows a "permissions bypassed" posture so the human knows edits aren't gated. */
  structuredPermissions: boolean;
  /** Reports real workerStatus transitions (else presence is a best-effort heuristic). */
  status: boolean;
  /** Per-verb control support (interrupt / setModel / setMode / end). */
  controls: ControlCapabilities;
  /** Receives viewer attachments. NOTE: attachments are relay-owned end-to-end — a driver never sees
   *  the `attachment` frame, only the resulting downstream `user` prompt. So this tracks `user`
   *  injection support; listed for documentation. */
  attachments: boolean;
}

/** The MITM driver's capabilities — the maximal *real* set: native claude RC honors interrupt, set_model
 *  and set_permission_mode, surfaces structured permission gates, and reports real status. `end` is false
 *  even here (claude's REPL bridge has no remote session-end). Also the relay's safe default when a relay
 *  is built without explicit capabilities (preserves pre-capability mitm behavior: nothing gets gated). */
export const MITM_CAPABILITIES: DriverCapabilities = {
  structuredPermissions: true,
  status: true,
  controls: { interrupt: true, setModel: true, setMode: true, end: false },
  attachments: true,
};

/** Which harness a session runs, so the viewer's session list can show WHICH agent + mode it is (the
 *  three sessions look identical otherwise). `agent` is the product; `mode` is how we bridge it. Rides
 *  every session_announce alongside `capabilities`. */
export interface HarnessDescriptor {
  /** The underlying agent product. */
  agent: "claude-code" | "opencode";
  /** How the session is bridged: native RC (mitm), a tmux pane, or opencode's own server. */
  mode: "rc" | "tmux" | "opencode";
}

/** The MITM driver runs the real `claude` under native remote-control. */
export const MITM_HARNESS: HarnessDescriptor = { agent: "claude-code", mode: "rc" };
/** The tmux driver runs a plain `claude` in a tmux pane, bridged via the permission hook + transcript. */
export const TMUX_HARNESS: HarnessDescriptor = { agent: "claude-code", mode: "tmux" };
/** The opencode driver peer-attaches to an `opencode serve`. */
export const OPENCODE_HARNESS: HarnessDescriptor = { agent: "opencode", mode: "opencode" };

/**
 * Everything a driver needs to bridge a harness to the broker. Mirrors the launch surface
 * (RcLaunchOptions in launch.ts) so the MITM driver maps onto it 1:1; non-MITM drivers ignore the
 * MITM-only fields and add their own under `extra`.
 */
export interface DriverContext {
  /** Args forwarded verbatim to the harness binary. */
  harnessArgs: string[];
  /** The harness binary to spawn (resolved from --rc claudeBin / RC_CLAUDE_BIN / "claude"). Drivers
   *  that spawn a child (tmux) use this; the MITM driver carries its own spawn via `extra`. */
  harnessBin?: string;
  /** This machine's identity (its bus + session keys). identity.identityId feeds HostRcRelay. */
  identity: Identity;
  /** The broker origin (`--rc-app` / RC_APP); its /api is the relay broker. */
  brokerUrl: string;
  /** Which broker backend to target (`--rc-backend` / RC_BACKEND); omitted ⇒ broker default. */
  backend?: string;
  /** Session title for the announce (default "remote-claw"). */
  title: string;
  /** The session's working dir, snapshotted for the announce's cwd + git chip. */
  cwd: string;
  /** Static git snapshot for the viewer's git chip; null outside a repo. */
  git: GitInfo | null;
  /** Builds a fresh BrokerClient (already wired with provider + Vercel bypass + backend), one per
   *  session — exactly as launch.ts does, so each relay owns its own transport. */
  newClient: () => BrokerClient;
  /** Driver-own diagnostics tracer (target "rc.<name>"; defaults to no-op). */
  tracer?: Tracer;
  /** Notified the instant a Session registers (test parity with launch.ts's onSession). */
  onSession?: (s: Session) => void;
  /** Driver-specific knobs (e.g. { certsDir, spawnClaude } for mitm; { dangerouslySkipPermissions }
   *  for tmux). Keeps the common context clean while letting each driver carry its own config. */
  extra?: Record<string, unknown>;
}

/**
 * A pluggable harness adapter. A driver MUST:
 *   1. Create a Session via RelayCore.create({ title }) and call session.pushInitialize() once
 *      (idempotent; guarantees `initialize` is the first downstream event).
 *   2. CAPTURE: translate harness output into a canonical UpstreamPayload and call
 *      session.pushUpstream(payload). relay.mapUpstreamItems consumes it unchanged.
 *   3. INJECT: drain session.followDownstream(session.claimWorkerStream(), () => signal.aborted);
 *      for each eventType === "user" send its text to the harness; map control_request verbs.
 *   4. STATUS: set session.workerStatus + call session.wake() so the relay's presence tracks it.
 *   5. PERMISSIONS (capability-gated): raise a gate by pushUpstream-ing a can_use_tool
 *      control_request; apply an answer by observing the matching control_response in
 *      followDownstream. The relay's existing permission_request ⇄ permission round-trip does the
 *      broker side — no relay change.
 * Current compatibility drivers pass the Session to bridgeSession(...), which starts
 * relay.announce(...) and relay.serve(signal) concurrently. Announce performs its presence post;
 * serve owns the two command/content pumps and durable-cursor prepare. The driver tears the harness
 * and relay down on exit.
 */
export interface Driver {
  readonly capabilities: DriverCapabilities;
  /** Run until `signal` aborts (or the harness exits). Resolves with the harness exit code. */
  run(signal: AbortSignal): Promise<number>;
}

/** Factory the dispatcher calls once per wrapper launch. */
export type DriverFactory = (ctx: DriverContext) => Driver;

// The shape every driver MUST pass to session.pushUpstream(payload). mapUpstreamItems(ev) in
// relay.ts IS the spec; if the shape drifts the relay SILENTLY DROPS the frame (no driver-specific
// adaptation exists, by design). claude's transcript JSONL message.content blocks are byte-identical
// to this — the tmux driver's ONLY required reshape is parentToolUseID → parent_tool_use_id.

export interface UpstreamPayload {
  /** Event type. The relay routes on this exactly:
   *   "assistant"             → text / thinking / tool_use blocks
   *   "user"                  → tool_result blocks (agent posts tool OUTPUT as a user-role message)
   *   "system"                → only subtypes starting "task_" (sub-agent visibility); rest dropped
   *   "result"                → end-of-turn result string
   *   "control_request" + request.subtype==="can_use_tool" → a permission gate (→ permission_request)
   *   "control_cancel_request"→ clears an open gate by request_id */
  type:
    | "assistant"
    | "user"
    | "system"
    | "result"
    | "control_request"
    | "control_cancel_request"
    | string;

  /** Event uuid (unique within the session). Absent ⇒ session mints one; supply the harness's own
   *  where available so dedup/ordering is stable across reconnects. */
  uuid?: string;

  /** Sub-agent nesting: an assistant/user event produced UNDER a parent Task tool_use carries the
   *  spawning Task's tool_use_id; the viewer nests it under the Task. */
  parent_tool_use_id?: string | null;

  /** For "assistant" / "user": the message envelope holding the content. Usually `ContentBlock[]`, but a
   *  STRING is also valid — a non-MITM driver sends a plain string for a local prompt, and real claude's
   *  user content is sometimes a bare string too. The relay's userPromptText (relay.ts) accepts both. */
  message?: { role?: "assistant" | "user" | string; content: ContentBlock[] | string };

  /** For "result": the turn's result (string preferred; non-string is JSON-stringified by relay). */
  result?: string | Record<string, unknown>;

  /** For "control_request": relay reads request_id at top level OR inside request. */
  request_id?: string;
  request?: {
    subtype?: string; // "can_use_tool" to render a permission_request
    tool_name?: string; // e.g. "Bash", "AskUserQuestion"
    input?: unknown; // real claude carries tool input here…
    tool_input?: unknown; // …older/fake protocol used this; relay reads either
    tool_use_id?: string; // rides the answer back as toolUseID (#42)
    request_id?: string; // relay reads req.request_id as a FALLBACK gate id (mapUpstreamItems) — review #3
  };

  /** For "system": task lifecycle (only "task_*" surfaced). */
  subtype?: string;
  task_id?: string;
  description?: string;
  tool_use_id?: string;

  /** Forward-compat: extra fields preserved; the relay ignores what it doesn't read. */
  [key: string]: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
} // empty text → dropped
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
} // empty-after-trim → dropped
export interface ToolUseBlock {
  type: "tool_use";
  name: string; // a "Task" tool_use spawns a sub-agent
  input: unknown;
  id?: string; // matched by a later tool_result.tool_use_id
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string; // matches the ToolUseBlock.id it answers
  // Bash stdout (string) OR structured blocks: text + non-text (image/source/…), which the relay
  // flattens to a "[type]" marker. Widened beyond ContentBlock so a real image tool_result type-checks
  // (relay toolResultOutput tolerates any block shape) — review #8.
  content: string | Array<{ type?: string; text?: string; [k: string]: unknown }>;
  is_error?: boolean; // true if the tool call failed
}

// Relay-enforced field rules a driver MUST honor:
//  • text="" and thinking="" (after .trim()) are DROPPED.
//  • tool_result.content is flattened to text and CAPPED at 4000 chars (TOOL_RESULT_CAP); non-text
//    blocks (images) surface as a "[type]" marker (host holds the image; SendUserFile is the
//    worker→viewer image path).
//  • system events surface ONLY when subtype starts "task_"; thinking_tokens etc. are dropped.
//  • a "user" event's TEXT is intentionally dropped by the relay (only tool_result blocks relay) —
//    the inbound pump already echoes every viewer prompt. Drivers pushUpstream user/tool_result
//    as-is; do NOT re-add the text.
//
// ── DRIVER OBLIGATIONS (adversarial-review-hardened; codex + Claude) ──────────────────────────────
// The relay/viewer are unchanged ONLY if a driver upholds these. The relay allocates a FRESH transcript
// `seq` per pushUpstream and the viewer dedups by seq/msgId — NOT by payload.uuid — so:
//  1. COALESCE per logical message (review #1, CRITICAL). If the harness streams a growing message
//     (e.g. OpenCode re-sends a whole part on every `message.part.updated`), buffer by part id and
//     pushUpstream ONCE when the message is COMPLETE (message.completed / session.idle) — never per
//     delta. Per-delta pushUpstream would mint a new seq each time and balloon/duplicate the transcript.
//  2. DEDUP before pushUpstream (review #2). On a re-read (tmux JSONL re-scan) or stream reconnect
//     (OpenCode SSE), DROP already-emitted items (track their ids) — pushing the same `uuid` again does
//     NOT dedup at the relay. `uuid` only stabilizes the worker/viewer payload, not relay ordering.
//  3. ACK after injection (review #5). followDownstream only suppresses replay for ids in the session's
//     #acked set; the MITM acks via /worker/events/delivery, which non-MITM drivers don't have. So after
//     SUCCESSFULLY injecting a downstream event, call session.ack(ev.eventId) (including for the leading
//     `initialize`) — else a reclaimed worker stream replays old prompts/control events.
//  4. SAFELY NO-OP unsupported controls (review #4). DriverCapabilities now rides session_announce and
//     the viewer DISABLES the controls a driver declares false (no false "✓") — but a driver must STILL
//     handle or safely no-op every verb it receives (never throw on an unsupported one): an older viewer,
//     a race before the first announce, or a hand-crafted frame can still deliver any verb. Declaring a
//     verb false hides its button; it does not guarantee the verb never arrives.
//  5. TEARDOWN cleanly (review #10). bridgeSession returns the served promise; on teardown abort the
//     signal, session.close(), and await it (mirrors runRcLaunch) so a final frame flushes and the
//     relay's death is observable rather than swallowed.
// Known v1 limitations (documented, not bugs): a prompt typed into a LOCAL tmux TUI is upstream `user`
// text and the relay drops it, so it won't appear in the web transcript (review #6); and tool_use `id`
// is dropped by the relay so the viewer can't correlate a tool_result to its row (review #7).
