// HostRcRelay — bridges ONE Remote Control session (the MITM's in-memory Session, fed by the real
// `claude --remote-control`) to the E2E-encrypted broker (§3.1/§6A/§17.5). It is the v2 replacement
// for Phase 0's localhost ClientServer: instead of a token-gated local web UI, the clients are broker
// subscribers (phone/laptop), and every frame is sealed so the broker sees only ciphertext.
//
// Two concurrent pumps run for the session's life:
//   • OUTBOUND — tail the session's upstream (assistant/result the worker POSTs back), allocate a
//     transcript `seq`, log it (for catch_up), seal, and POST to the session channel.
//   • INBOUND  — tail the session channel for client frames: a `user` prompt is acked + echoed (so
//     every device's transcript shows it) and injected into claude (pushUserInput); a `catch_up`
//     replays the log; a `permission` grant answers a worker control_request.
//
// catch_up has two regimes (see `#durable`): on a capped/ephemeral backend the host keeps an in-memory
// `#log` and re-posts it on a viewer `catch_up`; on a DURABLE-log backend (Turso) the broker retains
// every frame, so a viewer's subscribe(startIndex:0) replays the full history on its own — the host
// builds no `#log` and ignores `catch_up`. One log, mediated by the broker.
//
// The transcript `seq` is allocated solely here (§6: clients never assign order), and a bounded
// `#seen` set dedups the at-least-once inbound stream. Mirrors HostRelay's broker discipline, but
// decoupled into the event-driven shape RC needs (a turn's response is async, tool turns interleave).

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Frame, type FrameHeader, utf8 } from "@remote-claw/clawsec";
import { type BrokerClient, BrokerError, type SeqCursor } from "../../broker/client.js";
import { NOOP_TRACER, type Tracer } from "../../trace.js";
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

/** Defensive cap on a viewer attachment's base64 length (~12 MB of bytes). The viewer downscales far
 *  below this; the cap just stops a buggy/hostile client from writing an arbitrarily large file. (#44) */
export const MAX_ATTACHMENT_B64 = 16 * 1024 * 1024;

/** Client control verbs (§3.7) the relay forwards to the worker as a `control_request`. (A slash
 *  command rides the `user` path instead — claude processes `/compact` etc. as input.) */
const CONTROL_VERBS = new Set(["interrupt", "set_model", "set_mode", "end"]);

/** Out-post retry budget for a transient broker error (409 = the run cap-rolled between resolve and
 *  publish — the "window rolling over"). A `seq` is allocated BEFORE the post, so a dropped post would
 *  strand the viewer on a permanent gap; retrying the SAME frame (deterministic msg_id → viewer
 *  dedups) closes that hole. */
const POST_RETRIES = 6;
const POST_RETRY_BASE_MS = 50;
const SEQ_RESUME_ATTEMPTS = 3;
const SEQ_RESUME_RETRY_BASE_MS = 100;
const RELAY_INCARNATION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  /** Where a viewer-sent attachment (#44) is written on the host before claude `Read`s it. Defaults to
   *  an OS-temp subdir; the wrapper points it at the session workspace so paths are familiar to claude. */
  attachmentsDir?: string;
}

/** One content frame to relay out of a worker upstream event. */
interface OutItem {
  kind: string;
  text: string;
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
  /** Inbound at-least-once dedup set (msg_id). Grows with the count of DISTINCT client frames this
   *  session (prompts + catch_ups + permission grants) — modest, human-paced, and freed when the
   *  session ends. Must NOT be size-bounded: #tailInbound re-reads from index 0 on each reconnect, so
   *  an evicted-then-re-read `user` msg_id would re-inject a duplicate prompt into claude. */
  readonly #seen = new Set<string>();
  /** In-memory replay log — content frames plus unordered state frames such as permission_resolved,
   *  replayed on a viewer `catch_up` (§6/§16). Left EMPTY when `#durable`: a durable-log backend
   *  (Turso) keeps every frame, so its own subscribe(0) replays the full history and the host need not
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
  /** Whether announce() has run; gates the periodic re-announce so a session with a genuinely empty
   *  title/cwd still keepalives (and an un-announced session never does). */
  #announced = false;
  /** Title/cwd/git captured by announce(), reused by every periodic re-announce (presence refreshes
   *  status/phase/needs; title/cwd/git are a snapshot taken once at announce time). */
  #annTitle = "";
  #annCwd: string | null = null;
  #annGit: GitInfo | null = null;
  /** A per-announce counter → a UNIQUE msg_id for every (re-)announce (announces don't advance #seq,
   *  so without this every idle keepalive would reuse one msg_id — fine for today's consumer, fragile
   *  if any future consumer dedups by msg_id). */
  #annCount = 0;
  /** Throttle: the last announced presence key + when, so we only re-announce on change or keepalive. */
  #lastPresenceKey = "";
  #lastAnnounceAt = 0;

  /** Latched when a seq-allocating post fails. A failed post has burned a transcript seq that can never
   *  be filled (it was allocated before the post, and never logged), so retrying the inbound stream
   *  would only allocate seqs PAST the burned one — widening a permanent mid-stream gap on a STILL-LIVE
   *  session (the worst adversarial-review finding). Instead, #fatal makes the relay tear down (serve()
   *  couples the pumps): the session ends and the viewer reads disconnect, rather than limping on behind
   *  a hole. (A durable gap may remain for a reconnecting viewer — §12 boundary, broker-windowing #36.) */
  #fatal = false;

  readonly #trace: Tracer;
  /** Where a viewer attachment is written before claude Reads it (#44). */
  readonly #attachmentsDir: string;
  /** Monotonic prefix making each on-disk attachment name unique (so a later upload can't overwrite a
   *  file an earlier still-queued prompt will Read). (#44) */
  #attachmentSeq = 0;

  constructor(opts: HostRcRelayOptions) {
    this.#client = opts.client;
    this.#identityId = opts.identityId;
    this.#sessionId = opts.sessionId;
    this.#session = opts.session;
    this.#attachmentsDir =
      opts.attachmentsDir ?? join(tmpdir(), "remote-claw-attachments", opts.sessionId);
    // Bind the session id onto every line (span-like) so interleaved sessions are distinguishable.
    this.#trace = (opts.tracer ?? NOOP_TRACER).child({ session: opts.sessionId });
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
   *  title/cwd/git so the periodic re-announce (#maybeAnnounce) can refresh presence without them.
   *  `git` is a static snapshot of the session's repo state (branch/dirty/ahead-behind) for the
   *  viewer's git chip (#49); null when the session isn't in a git repo. */
  async announce(
    title: string,
    cwd: string | null = null,
    git: GitInfo | null = null,
  ): Promise<void> {
    // The bus announce publishes IMMEDIATELY — it must NOT wait on prepare() (the durable-cursor
    // sample), because that round-trip would delay the bus publish enough to race a viewer's concurrent
    // bus subscribe (the broker rejects a concurrent channel create). prepare() instead gates the
    // INBOUND TAIL in serve(): the session's inbound cursor is sampled before any inbound is processed,
    // and a viewer cannot post session-inbound faster than prepare() resolves (it must first receive
    // this announce, subscribe to the session channel, and post — all well after the local sample).
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
    const p = this.#presence();
    const body: Record<string, unknown> = {
      session_id: this.#sessionId,
      title: this.#annTitle,
      cwd: this.#annCwd,
      sent_at: Date.now(),
      incarnation: RELAY_INCARNATION,
      status: p.status,
      phase: p.phase,
      needs: p.needs,
      git: this.#annGit,
    };
    if (p.mode !== null) body.mode = p.mode;
    await this.#client.postFrame(
      this.#header("session_announce", null, `ann-${this.#sessionId}-${this.#annCount++}`),
      utf8(JSON.stringify(body)),
    );
    this.#lastPresenceKey = `${p.status}|${p.needs}|${p.mode ?? ""}`;
    this.#lastAnnounceAt = Date.now();
    this.#trace.debug("announce", { phase: p.phase, needs: p.needs, mode: p.mode ?? "" });
  }

  /** Re-announce when presence changed, or when the keepalive floor elapsed (so the viewer's
   *  freshness check has a steady signal). Called on the heartbeat null-tick + after a state change.
   *  Presence is ADVISORY: a failed announce is swallowed (warn-only) so a transient bus blip can't
   *  reject a pump — which, now that serve() couples the pumps, would otherwise tear the session down.
   *  The viewer's freshness check already degrades a missed announce to reconnecting/disconnected. */
  async #maybeAnnounce(): Promise<void> {
    if (!this.#announced) return; // first announce() hasn't run yet — nothing to refresh
    const p = this.#presence();
    const key = `${p.status}|${p.needs}|${p.mode ?? ""}`;
    if (
      key !== this.#lastPresenceKey ||
      Date.now() - this.#lastAnnounceAt >= ANNOUNCE_KEEPALIVE_MS
    ) {
      try {
        await this.#sendAnnounce();
      } catch (e) {
        this.#trace.warn("announce failed (advisory)", {
          error: (e as Error)?.message ?? String(e),
        });
      }
    }
  }

  /**
   * POST one out-message (postMessage chunks a large payload into seq-sharing parts, §8). Retries a
   * transient 409 (the channel run cap-rolled mid-publish) with bounded backoff: the frame's msg_id
   * is deterministic, so a re-post is deduped by the viewer — but a DROPPED post would leave a seq
   * gap that stalls every viewer's orderer forever, so we must not let one slip.
   */
  async #post(recordKind: string, seq: number | null, msgId: string, text: string): Promise<void> {
    const header = this.#header(recordKind, seq, msgId);
    const body = utf8(text);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#client.postMessage(header, body);
        return;
      } catch (e) {
        // 409 = run rolled → retry (§6B). Anything else, or out of budget, is terminal.
        if (BrokerError.is(e) && e.status === 409 && attempt < POST_RETRIES) {
          this.#trace.debug("post 409 → retry", { kind: recordKind, seq, attempt: attempt + 1 });
          await new Promise((r) => setTimeout(r, POST_RETRY_BASE_MS * 2 ** attempt));
          continue;
        }
        // Terminal. A CONTENT post (seq !== null) burns a durable transcript `seq` → a permanent gap
        // that stalls a late viewer's orderer forever (§12 boundary #1). Surface it as an ERROR (with
        // the burned seq) so it's an actionable alert, not just a silent #fatal teardown, before it
        // propagates to #fatalOnThrow.
        if (seq !== null) {
          this.#trace.error("durable content post failed — seq burned (permanent gap)", {
            kind: recordKind,
            seq,
            msgId,
            attempts: attempt + 1,
            error: (e as Error)?.message ?? String(e),
          });
        }
        throw e;
      }
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

  /** Run a seq-allocating publish; on failure latch #fatal (a transcript seq is now burned) and
   *  propagate. serve()'s coupling + #pumpInbound's #fatal check then tear the relay down rather than
   *  retrying (which would allocate seqs past the hole). Keeps the two pumps' allocate-before-post
   *  discipline but makes a burned seq end the session instead of silently stranding a live one. */
  async #fatalOnThrow<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.#fatal = true;
      throw e;
    }
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
   *  shared #publishLock/#halted, would otherwise leave a live session stranded behind a permanent seq
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
    try {
      await Promise.all([
        this.#pumpUpstream(child).catch(halt),
        this.#pumpInbound(child).catch(halt),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Sample the broker's durable cursors before this relay becomes discoverable or starts its pumps.
   *  Idempotent so launch, announce(), and direct tests can all call it without racing duplicate cursor
   *  reads. On a durable backend, failing to resume all cursors remains fail-closed. */
  async prepare(): Promise<void> {
    if (!this.#durabilityDiscovered) {
      if (this.#preparePromise === null) this.#preparePromise = this.#discoverDurability();
      await this.#preparePromise;
    }
    if (this.#durable && !this.#durableCursorsReady) {
      throw new Error("durable broker reported but restart cursors are not ready");
    }
  }

  /** Discover the broker's EFFECTIVE durability from the server before either pump starts. A failed
   *  discovery means durability is still unknown, so the relay keeps the legacy non-durable path instead
   *  of failing closed; fail-closed is reserved for the case where the server has already reported
   *  `durable: true`. */
  async #discoverDurability(): Promise<void> {
    let seqCursor: SeqCursor;
    try {
      seqCursor = await this.#client.seqCursor(this.#sessionId);
    } catch (e) {
      this.#durabilityDiscovered = true;
      this.#durable = false;
      this.#trace.warn("durability discovery failed — using non-durable relay path", {
        error: (e as Error)?.message ?? String(e),
      });
      return;
    }

    this.#durabilityDiscovered = true;
    this.#durable = seqCursor.durable;
    if (!this.#durable) {
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
          await new Promise((r) => setTimeout(r, SEQ_RESUME_RETRY_BASE_MS * 2 ** attempt));
        }
      }
    }
    this.#fatal = true;
    this.#trace.error("inbound cursor resume failed after retries — aborting durable relay", {
      attempts: SEQ_RESUME_ATTEMPTS,
      error: (lastErr as Error)?.message ?? String(lastErr),
    });
    throw lastErr;
  }

  /** OUTBOUND: tail the worker's upstream and relay each assistant/result as a content frame. */
  async #pumpUpstream(signal: AbortSignal): Promise<void> {
    this.#trace.debug("pumpUpstream start");
    for await (const ev of this.#session.followUpstream(() => signal.aborted)) {
      if (ev === null) {
        await this.#maybeAnnounce(); // idle null-tick → refresh presence (keepalive + a phase flip)
        continue;
      }
      // The worker cancels a pending gate (e.g. the turn was interrupted) with a control_cancel_request
      // carrying the gate's request_id — the GROUNDED signal (captured via --rc-trace) that an open
      // permission is now unanswerable. Clear it so `needs` doesn't stay pinned true. (Primary fix for
      // the sticky-needs finding; the interrupt/end verb clear in #driveControlVerb is a backstop.)
      if (ev.eventType === "control_cancel_request") {
        const id = ev.payload.request_id;
        if (typeof id === "string" && this.#openPerms.delete(id)) {
          this.#trace.debug("gate cancelled by worker", { request_id: id });
          await this.#maybeAnnounce();
        }
        continue; // not a rendered content frame
      }
      const mode = permissionModeFrom(ev.payload);
      if (mode !== null && mode !== this.#session.permissionMode) {
        this.#session.permissionMode = mode;
        await this.#maybeAnnounce();
      }
      const items = mapUpstreamItems(ev);
      this.#trace.debug("upstream event", {
        event: ev.eventType,
        items: items.map((i) => i.kind).join(",") || "skip",
      });
      for (const item of items) {
        // Register a permission gate BEFORE the publish, not after: #emit yields the event loop, so a
        // fast viewer can grant the permission (and #pumpInbound run its delete) before this add would
        // have happened — leaving the id stuck in #openPerms and `needs` true forever. Adding first
        // (outside the lock — it's not seq work) means the inbound delete always finds it. Roll back if
        // the publish fails, since the viewer never saw the request and could never answer it. (codex HIGH #1)
        let gateId: string | null = null;
        if (item.kind === "permission_request") {
          try {
            const id = (JSON.parse(item.text) as { request_id?: unknown }).request_id;
            if (typeof id === "string" && id !== "") {
              gateId = id;
              this.#openPerms.add(id);
            }
          } catch {
            // a malformed permission_request body — don't track an unanswerable gate
          }
        }
        const seq = this.#seq++;
        try {
          await this.#fatalOnThrow(() =>
            this.#emit(item.kind, seq, `${item.kind}-${seq}`, item.text),
          );
        } catch (e) {
          if (gateId !== null) this.#openPerms.delete(gateId); // publish failed → gate is unanswerable
          throw e;
        }
      }
      await this.#maybeAnnounce(); // an event may have flipped phase (running) or opened a gate
    }
    this.#trace.debug("pumpUpstream end");
  }

  /** INBOUND: tail the session channel for client frames and drive the worker. Re-subscribes if the
   *  stream ends — the session run may not exist yet (the relay serves before the first client
   *  prompt) or may have cap-rolled (the "window rolling over"); `#seen` dedups the re-read. */
  async #pumpInbound(signal: AbortSignal): Promise<void> {
    this.#trace.debug("pumpInbound start");
    while (!signal.aborted) {
      try {
        await this.#tailInbound(signal);
      } catch (e) {
        // A seq-burning publish failure latches #fatal; retrying would re-subscribe and allocate seqs
        // PAST the burned one — widening the mid-stream gap on a live session. So propagate and let
        // serve() tear the relay down. Only a NON-fatal error (stream not up yet / cap-roll) is the
        // retryable case the loop exists for. The message is local-only (this machine holds the
        // transcript), clipped by the formatter.
        if (this.#fatal) throw e;
        this.#trace.warn("inbound tail threw → retry", {
          error: (e as Error)?.message ?? String(e),
        });
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, 150)); // run not up / stream closed → resume-or-retry
    }
    this.#trace.debug("pumpInbound end");
  }

  async #tailInbound(signal: AbortSignal): Promise<void> {
    this.#trace.debug("inbound subscribe");
    for await (const frame of this.#client.streamFrames({
      session: this.#sessionId,
      startIndex: this.#durable ? this.#inboundStartIndex : 0,
      signal,
    })) {
      if (frame.dir !== "in") continue; // ignore our own out-frames on the shared stream
      // Inbound is single-frame by design (the viewer chunks nothing — viewer.ts). `openFrame` returns
      // only THIS frame's plaintext, so a frame claiming `parts > 1` would be opened to just its first
      // part — a silently truncated prompt / permission answer / attachment, acted on as if whole. Drop
      // it loudly instead. (Dedup keys on `msgId`, not `(msgId, part)`, which is fine precisely because
      // we never process a multi-part inbound frame.)
      if (frame.parts !== 1) {
        this.#trace.warn("dropped multi-part inbound frame", {
          kind: frame.recordKind,
          parts: frame.parts,
          msg: frame.msgId,
        });
        continue;
      }
      this.#trace.trace("inbound frame", { kind: frame.recordKind, msg: frame.msgId });
      if (this.#seen.has(frame.msgId)) continue; // at-least-once dedup
      this.#seen.add(frame.msgId);

      if (frame.recordKind === "user") {
        const text = new TextDecoder().decode(await this.#client.openFrame(frame));
        const userSeq = this.#seq++;
        // Ack the client's frame (meta), echo the prompt (content, so every device sees it), then
        // inject it into the real claude. A failed echo post is FATAL (a seq is burned) — tear down
        // rather than feed claude a prompt no viewer can see.
        await this.#fatalOnThrow(async () => {
          await this.#post(
            "accepted",
            null,
            `accepted-${this.#sessionId}-${userSeq}`,
            JSON.stringify({ client_msg_id: frame.clientMsgId ?? null, seq: userSeq }),
          );
          await this.#emit("user", userSeq, `user-${userSeq}`, text);
        });
        this.#session.pushUserInput(text);
        // Content preview at debug (opt-in); bytes always.
        this.#trace.debug("user prompt", { seq: userSeq, bytes: text.length, text });
      } else if (frame.recordKind === "catch_up") {
        if (this.#durable) {
          // The durable backend's own log answers catch_up: the viewer's subscribe(startIndex:0) already
          // replays the full history straight from the frames table, so there's nothing for the host to
          // re-post. (We don't even open the frame — `since` is irrelevant when the broker serves it.)
          this.#trace.debug("catch_up ignored — durable backend serves history");
        } else {
          const body = JSON.parse(new TextDecoder().decode(await this.#client.openFrame(frame)));
          const since = typeof body.since === "number" ? body.since : 0;
          this.#trace.debug("catch_up replay", { since, frames: this.#log.length });
          await this.#replay(since);
        }
      } else if (frame.recordKind === "permission") {
        const body = JSON.parse(new TextDecoder().decode(await this.#client.openFrame(frame)));
        // Act only if this answer closes an OPEN gate. `#openPerms.delete` returns false for a
        // duplicate, stale, or unknown request_id (two devices both granting; a re-read after
        // reconnect), so gating on it makes the answer idempotent — no second pushControlResponse to
        // the worker and no duplicate permission_resolved frame in the log. (codex HIGH #2)
        if (typeof body.request_id === "string" && this.#openPerms.delete(body.request_id)) {
          const behavior = body.behavior === "deny" ? "deny" : "allow";
          this.#trace.debug("permission response", { behavior });
          // An AskUserQuestion answer (#42) carries `answers` (+ the request's `tool_use_id`) — forward
          // them so pushControlResponse builds the real `updatedInput.answers` + `toolUseID` shape.
          const extra: { toolUseId?: string; answers?: Record<string, string | string[]> } = {};
          if (typeof body.tool_use_id === "string" && body.tool_use_id) {
            extra.toolUseId = body.tool_use_id;
          }
          if (body.answers !== null && typeof body.answers === "object") {
            extra.answers = body.answers as Record<string, string | string[]>;
          }
          // Log a permission_resolved unordered frame BEFORE the worker side effect. If the durable log
          // publish fails, the worker must not act on a grant that reload/catch_up cannot observe (#56).
          await this.#fatalOnThrow(() =>
            this.#emit(
              "permission_resolved",
              null,
              `permresolved-${body.request_id}`,
              JSON.stringify(
                extra.answers
                  ? { request_id: body.request_id, behavior, answers: extra.answers }
                  : { request_id: body.request_id, behavior },
              ),
            ),
          );
          this.#session.pushControlResponse(body.request_id, behavior, extra);
          // Clearing the gate also drops `needs` from presence — re-announce so the viewer's
          // needs-you indicator clears (#58).
          await this.#maybeAnnounce();
        }
      } else if (frame.recordKind === "attachment") {
        await this.#handleAttachment(frame);
      } else if (CONTROL_VERBS.has(frame.recordKind)) {
        // A client control verb (§3.7) — ESC the turn, switch model/mode, end the session. Forward it
        // to the worker as a `control_request` with the mapped subtype + params.
        await this.#driveControlVerb(frame.recordKind, frame);
      }
    }
  }

  /**
   * Handle a viewer attachment (#44): write the (E2E-decrypted) bytes into the host's attachments dir,
   * then drive claude to `Read` the file — claude's image Read gives real vision, so this needs NO
   * unverified worker-protocol write (the image rides our own `attachment` frame, the rest is a normal
   * prompt + the standard Read tool). Also echoes a `user` content frame so every device's transcript
   * shows the attachment. A write/parse failure is logged, not fatal (it didn't burn a seq).
   */
  async #handleAttachment(frame: Frame): Promise<void> {
    let name: string;
    let path: string;
    let caption: string;
    try {
      const body = JSON.parse(new TextDecoder().decode(await this.#client.openFrame(frame))) as {
        name?: unknown;
        mime?: unknown;
        data?: unknown;
        caption?: unknown;
      };
      // Reject anything not well-formed base64 (Buffer.from would otherwise silently truncate it) or
      // over the size cap — drop cleanly, before any seq/file/prompt side effect.
      if (typeof body.data !== "string" || !isLikelyBase64(body.data)) return;
      if (body.data.length > MAX_ATTACHMENT_B64) {
        this.#trace.warn("attachment too large", { b64: body.data.length });
        return;
      }
      const bytes = Buffer.from(body.data, "base64");
      if (bytes.length === 0) return; // decoded to nothing
      name = safeAttachmentName(typeof body.name === "string" ? body.name : ""); // display name (chip)
      caption = typeof body.caption === "string" ? body.caption : "";
      // On-disk name: a unique prefix (no overwrite of a still-referenced file) + the extension that
      // matches the ACTUAL bytes (the viewer always re-encodes), so claude's image Read detects it right.
      const mime = typeof body.mime === "string" ? body.mime : "";
      const ext = extForMime(mime);
      const stem = name.replace(/\.[A-Za-z0-9]+$/, "") || "attachment";
      const diskName = `${(this.#attachmentSeq++).toString(36)}-${ext ? `${stem}.${ext}` : name}`;
      await mkdir(this.#attachmentsDir, { recursive: true });
      path = join(this.#attachmentsDir, diskName);
      await writeFile(path, bytes);
      this.#trace.debug("attachment written", { name, diskName, bytes: bytes.length });
    } catch (e) {
      this.#trace.warn("attachment rejected", { error: (e as Error)?.message ?? String(e) });
      return; // bad frame / unwritable — drop (non-fatal: no seq was allocated)
    }
    // Echo the user frame FIRST (durably — a failed post is fatal), THEN inject into claude: the same
    // invariant as the `user` path (never feed claude a prompt no viewer can see), here ordered so a
    // torn-down relay can't have driven claude to Read an image that never reached any transcript.
    const seq = this.#seq++;
    await this.#fatalOnThrow(() =>
      this.#emit("user", seq, `user-${seq}`, `📎 ${name}${caption ? `\n${caption}` : ""}`),
    );
    const prompt = `${caption || "Please look at this image."}\n\n[Attached image "${name}" saved at ${path} — use the Read tool to view it.]`;
    this.#session.pushUserInput(prompt);
  }

  /** Map a client control-verb frame → the worker control_request the spec uses (§3.7). */
  async #driveControlVerb(kind: string, frame: Frame): Promise<void> {
    // openFrame IS the authentication: a forged/corrupt/tampered frame fails AEAD here. We must NOT
    // act on a frame that fails to open — even a bodyless verb (interrupt/end) proves authenticity by
    // opening cleanly. (Earlier this swallowed the error and fired anyway, letting the UNTRUSTED
    // broker forge an interrupt/end — both assessors flagged it.)
    let body: Record<string, unknown>;
    try {
      const raw = new TextDecoder().decode(await this.#client.openFrame(frame));
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed === null || typeof parsed !== "object") return; // authenticated but malformed → drop
      body = parsed as Record<string, unknown>;
    } catch {
      this.#trace.warn("control verb rejected (AEAD/parse)", { kind });
      return; // AEAD open failed or unparseable → reject, never drive a control action
    }
    // Drop a STALE control frame: a malicious broker can withhold a valid frame and replay it much
    // later. The client stamps `expiry`; past it, the verb is a no-op (matches catch_up's freshness).
    if (typeof body.expiry === "number" && body.expiry < Date.now()) {
      this.#trace.warn("control verb dropped (stale)", { kind });
      return;
    }
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
          this.#session.permissionMode = body.mode;
          this.#session.pushControlRequest("set_permission_mode", { mode: body.mode });
          await this.#maybeAnnounce();
        }
        break;
      case "end":
        this.#session.pushControlRequest("end_session");
        this.#clearOpenPerms(); // ending the session orphans any open gate too
        break;
    }
  }

  /** Drop all open permission gates and refresh presence so `needs` clears. Used when a turn is
   *  interrupted or the session ends, which abandon any pending can_use_tool without a viewer answer. */
  #clearOpenPerms(): void {
    if (this.#openPerms.size === 0) return;
    this.#openPerms.clear();
    void this.#maybeAnnounce(); // #maybeAnnounce is self-swallowing; fire-and-forget the presence refresh
  }
}
