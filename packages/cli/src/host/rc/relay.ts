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

import { type FrameHeader, utf8 } from "@remote-claw/clawsec";
import type { BrokerClient } from "../../broker/client.js";
import { assistantText, type RcEvent, type Session } from "./session.js";

export interface HostRcRelayOptions {
  client: BrokerClient;
  /** This machine's 16-byte identity id (for frame headers). */
  identityId: Uint8Array;
  /** The broker session id this RC session maps to (1:1). */
  sessionId: string;
  /** The RC session (from RelayCore) the MITM created for the worker. */
  session: Session;
  /** Optional logger (defaults to no-op; never logs secrets/plaintext bodies). */
  log?: (msg: string) => void;
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
  if (ev.eventType !== "assistant") return []; // system/status/control — not rendered (kept minimal)

  // Sub-agent output is any assistant message produced under a parent Task tool call.
  const sub =
    typeof ev.payload.parent_tool_use_id === "string" && ev.payload.parent_tool_use_id !== "";
  const message = ev.payload.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const items: OutItem[] = [];
  for (const b of blocks) {
    const bb = b as { type?: string; text?: string; name?: string; input?: unknown };
    if (bb.type === "text" && typeof bb.text === "string" && bb.text !== "") {
      items.push({ kind: sub ? "assistant_sub" : "assistant", text: bb.text });
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
  /** Inbound at-least-once dedup window (msg_id). */
  readonly #seen = new Set<string>();
  /** In-memory transcript (content frames only) — replayed on a viewer `catch_up` (§6/§16). */
  readonly #log: { recordKind: string; seq: number; msgId: string; text: string }[] = [];

  readonly #logger: (msg: string) => void;

  constructor(opts: HostRcRelayOptions) {
    this.#client = opts.client;
    this.#identityId = opts.identityId;
    this.#sessionId = opts.sessionId;
    this.#session = opts.session;
    this.#logger = opts.log ?? (() => {});
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
  }

  /** POST one out-message (postMessage chunks a large payload into seq-sharing parts, §8). */
  async #post(recordKind: string, seq: number | null, msgId: string, text: string): Promise<void> {
    await this.#client.postMessage(this.#header(recordKind, seq, msgId), utf8(text));
  }

  /** Post AND record a content frame so it can be replayed via catch_up. */
  async #emit(recordKind: string, seq: number, msgId: string, text: string): Promise<void> {
    await this.#post(recordKind, seq, msgId, text);
    this.#log.push({ recordKind, seq, msgId, text });
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
    this.#logger("pumpUpstream: start");
    for await (const ev of this.#session.followUpstream(() => signal.aborted)) {
      if (ev === null) continue; // heartbeat tick
      const items = mapUpstreamItems(ev);
      this.#logger(
        `pumpUpstream: upstream ${ev.eventType} → ${items.map((i) => i.kind).join(",") || "skip"}`,
      );
      for (const item of items) {
        const seq = this.#seq++;
        await this.#emit(item.kind, seq, `${item.kind}-${seq}`, item.text);
      }
    }
    this.#logger("pumpUpstream: end");
  }

  /** INBOUND: tail the session channel for client frames and drive the worker. Re-subscribes if the
   *  stream ends — the session run may not exist yet (the relay serves before the first client
   *  prompt) or may have cap-rolled (the "window rolling over"); `#seen` dedups the re-read. */
  async #pumpInbound(signal: AbortSignal): Promise<void> {
    this.#logger("pumpInbound: start");
    while (!signal.aborted) {
      try {
        await this.#tailInbound(signal);
      } catch (e) {
        this.#logger(`pumpInbound: tail threw ${(e as Error)?.message ?? e} → retry`);
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, 150)); // run not up / stream closed → resume-or-retry
    }
    this.#logger("pumpInbound: end");
  }

  async #tailInbound(signal: AbortSignal): Promise<void> {
    this.#logger("tailInbound: subscribe");
    for await (const frame of this.#client.streamFrames({
      session: this.#sessionId,
      startIndex: 0,
      signal,
    })) {
      if (frame.dir !== "in") continue; // ignore our own out-frames on the shared stream
      this.#logger(`tailInbound: in ${frame.recordKind} msg=${frame.msgId}`);
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
      } else if (frame.recordKind === "catch_up") {
        const body = JSON.parse(new TextDecoder().decode(await this.#client.openFrame(frame)));
        await this.#replay(typeof body.since === "number" ? body.since : 0);
      } else if (frame.recordKind === "permission") {
        const body = JSON.parse(new TextDecoder().decode(await this.#client.openFrame(frame)));
        if (typeof body.request_id === "string") {
          this.#session.pushControlResponse(
            body.request_id,
            body.behavior === "deny" ? "deny" : "allow",
          );
        }
      }
    }
  }
}
