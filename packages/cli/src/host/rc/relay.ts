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
// The transcript `seq` is allocated solely here (§6: clients never assign order), and a bounded
// `#seen` set dedups the at-least-once inbound stream. Mirrors HostRelay's broker discipline, but
// decoupled into the event-driven shape RC needs (a turn's response is async, tool turns interleave).

import { type Frame, type FrameHeader, utf8 } from "@remote-claw/clawsec";
import { type BrokerClient, BrokerError } from "../../broker/client.js";
import { NOOP_TRACER, type Tracer } from "../../trace.js";
import { assistantText, type RcEvent, type Session } from "./session.js";

/** Client control verbs (§3.7) the relay forwards to the worker as a `control_request`. (A slash
 *  command rides the `user` path instead — claude processes `/compact` etc. as input.) */
const CONTROL_VERBS = new Set(["interrupt", "set_model", "set_mode", "end"]);

/** Out-post retry budget for a transient broker error (409 = the run cap-rolled between resolve and
 *  publish — the "window rolling over"). A `seq` is allocated BEFORE the post, so a dropped post would
 *  strand the viewer on a permanent gap; retrying the SAME frame (deterministic msg_id → viewer
 *  dedups) closes that hole. */
const POST_RETRIES = 6;
const POST_RETRY_BASE_MS = 50;

export interface HostRcRelayOptions {
  client: BrokerClient;
  /** This machine's 16-byte identity id (for frame headers). */
  identityId: Uint8Array;
  /** The broker session id this RC session maps to (1:1). */
  sessionId: string;
  /** The RC session (from RelayCore) the MITM created for the worker. */
  session: Session;
  /** Optional structured tracer (target "rc.relay"; defaults to no-op). Logs shapes/ids only. */
  tracer?: Tracer;
}

/** One content frame to relay out of a worker upstream event. */
interface OutItem {
  kind: string;
  text: string;
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
      (ev.payload.request as { subtype?: string; tool_name?: string; tool_input?: unknown }) ?? {};
    if (req.subtype !== "can_use_tool") return []; // initialize/other control verbs aren't rendered
    const requestId =
      (ev.payload.request_id as string) ?? (req as { request_id?: string }).request_id ?? "";
    return [
      {
        kind: "permission_request",
        text: JSON.stringify({
          request_id: requestId,
          tool_name: req.tool_name ?? "tool",
          tool_input: req.tool_input ?? null,
        }),
      },
    ];
  }
  if (ev.eventType !== "assistant") return []; // system/status — not rendered (kept minimal)

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
  /** In-memory transcript (content frames only) — replayed on a viewer `catch_up` (§6/§16). */
  readonly #log: { recordKind: string; seq: number; msgId: string; text: string }[] = [];

  readonly #trace: Tracer;

  constructor(opts: HostRcRelayOptions) {
    this.#client = opts.client;
    this.#identityId = opts.identityId;
    this.#sessionId = opts.sessionId;
    this.#session = opts.session;
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

  /** Broadcast one presence announce for this session on the bus (§6B). */
  async announce(title: string, cwd: string | null = null): Promise<void> {
    await this.#client.postFrame(
      this.#header("session_announce", null, `ann-${this.#sessionId}-${this.#seq}`),
      utf8(JSON.stringify({ session_id: this.#sessionId, title, cwd, sent_at: Date.now() })),
    );
    this.#trace.info("announce", { title });
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
        // 409 = run rolled → retry (§6B). Anything else, or out of budget, propagates.
        if (!(BrokerError.is(e) && e.status === 409) || attempt >= POST_RETRIES) throw e;
        this.#trace.debug("post 409 → retry", { kind: recordKind, seq, attempt: attempt + 1 });
        await new Promise((r) => setTimeout(r, POST_RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }

  /** Post AND record a content frame so it can be replayed via catch_up. */
  async #emit(recordKind: string, seq: number, msgId: string, text: string): Promise<void> {
    await this.#post(recordKind, seq, msgId, text);
    this.#log.push({ recordKind, seq, msgId, text });
    // Per-frame, so it's `trace`. Body length only at this level; the upstream-event log carries a
    // content preview at debug (a content frame here may be any record_kind, so just the shape).
    this.#trace.trace("frame sealed", { kind: recordKind, seq, bytes: text.length });
  }

  /** Replay the logged transcript from `since` onward — idempotent (the viewer dedups by seq/msg_id). */
  async #replay(since: number): Promise<void> {
    for (const e of [...this.#log]) {
      if (e.seq >= since) await this.#post(e.recordKind, e.seq, e.msgId, e.text);
    }
  }

  /** Serve the session until `signal` aborts: run the outbound + inbound pumps concurrently. */
  async serve(signal: AbortSignal): Promise<void> {
    await Promise.all([this.#pumpUpstream(signal), this.#pumpInbound(signal)]);
  }

  /** OUTBOUND: tail the worker's upstream and relay each assistant/result as a content frame. */
  async #pumpUpstream(signal: AbortSignal): Promise<void> {
    this.#trace.debug("pumpUpstream start");
    for await (const ev of this.#session.followUpstream(() => signal.aborted)) {
      if (ev === null) continue; // heartbeat tick
      const items = mapUpstreamItems(ev);
      this.#trace.debug("upstream event", {
        event: ev.eventType,
        items: items.map((i) => i.kind).join(",") || "skip",
      });
      for (const item of items) {
        const seq = this.#seq++;
        await this.#emit(item.kind, seq, `${item.kind}-${seq}`, item.text);
      }
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
      startIndex: 0,
      signal,
    })) {
      if (frame.dir !== "in") continue; // ignore our own out-frames on the shared stream
      this.#trace.trace("inbound frame", { kind: frame.recordKind, msg: frame.msgId });
      if (this.#seen.has(frame.msgId)) continue; // at-least-once dedup
      this.#seen.add(frame.msgId);

      if (frame.recordKind === "user") {
        const text = new TextDecoder().decode(await this.#client.openFrame(frame));
        const userSeq = this.#seq++;
        // Ack the client's frame (meta), echo the prompt (content, so every device sees it), then
        // inject it into the real claude via the MITM downstream.
        await this.#post(
          "accepted",
          null,
          `accepted-${this.#sessionId}-${userSeq}`,
          JSON.stringify({ client_msg_id: frame.clientMsgId ?? null, seq: userSeq }),
        );
        await this.#emit("user", userSeq, `user-${userSeq}`, text);
        this.#session.pushUserInput(text);
        // Content preview at debug (opt-in); bytes always.
        this.#trace.debug("user prompt", { seq: userSeq, bytes: text.length, text });
      } else if (frame.recordKind === "catch_up") {
        const body = JSON.parse(new TextDecoder().decode(await this.#client.openFrame(frame)));
        const since = typeof body.since === "number" ? body.since : 0;
        this.#trace.debug("catch_up replay", { since, frames: this.#log.length });
        await this.#replay(since);
      } else if (frame.recordKind === "permission") {
        const body = JSON.parse(new TextDecoder().decode(await this.#client.openFrame(frame)));
        if (typeof body.request_id === "string") {
          const behavior = body.behavior === "deny" ? "deny" : "allow";
          this.#trace.debug("permission response", { behavior });
          this.#session.pushControlResponse(body.request_id, behavior);
        }
      } else if (CONTROL_VERBS.has(frame.recordKind)) {
        // A client control verb (§3.7) — ESC the turn, switch model/mode, end the session. Forward it
        // to the worker as a `control_request` with the mapped subtype + params.
        await this.#driveControlVerb(frame.recordKind, frame);
      }
    }
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
        break;
      case "set_model":
        if (typeof body.model === "string")
          this.#session.pushControlRequest("set_model", { model: body.model });
        break;
      case "set_mode":
        if (typeof body.mode === "string")
          this.#session.pushControlRequest("set_permission_mode", { mode: body.mode });
        break;
      case "end":
        this.#session.pushControlRequest("end_session");
        break;
    }
  }
}
