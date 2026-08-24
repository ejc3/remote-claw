// HostRelay — the wrapper's core, decoupled from how "claude" is reached. It joins a session on the
// broker, broadcasts presence, and pumps inbound frames: a viewer `user` prompt is decrypted, fed to
// the ClaudeBackend, and the turn is relayed back out as content frames (the echo, streamed
// assistant text, the result) plus a meta `accepted` ack — each sealed, the broker seeing only
// ciphertext. The backend seam means the SAME relay runs over a real claude (ClaudeStreamSession) or
// a fake one (tests). (§6A/§11/§16.)

import { type FrameHeader, timingSafeEqual, utf8 } from "@remote-claw/clawsec";
import type { BrokerClient } from "../broker/client.js";
import type { ClaudeBackend } from "./claude.js";

export interface HostRelayOptions {
  client: BrokerClient;
  /** This machine's 16-byte identity id (for frame headers). */
  identityId: Uint8Array;
  sessionId: string;
  backend: ClaudeBackend;
}

export class HostRelay {
  readonly #client: BrokerClient;
  readonly #identityId: Uint8Array;
  readonly #sessionId: string;
  readonly #backend: ClaudeBackend;
  /** Next transcript seq to allocate (the user echo gets 0, then assistant/result follow). */
  #seq = 0;
  /** Inbound replay-dedup window (msg_id). */
  readonly #seen = new Set<string>();
  /** The in-memory transcript (content frames only) — replayed on a viewer `catch_up` (§3.2/§16). */
  readonly #log: { recordKind: string; seq: number; msgId: string; text: string }[] = [];

  constructor(opts: HostRelayOptions) {
    this.#client = opts.client;
    // Snapshot the expected coordinate: caller mutation must not retarget a live relay.
    this.#identityId = opts.identityId.slice();
    this.#sessionId = opts.sessionId;
    this.#backend = opts.backend;
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

  /** Broadcast one presence announce for this session on the bus. */
  async announce(title: string, cwd: string | null = null): Promise<void> {
    await this.#client.postFrame(
      this.#header("session_announce", null, `ann-${this.#sessionId}-${this.#seq}`),
      utf8(JSON.stringify({ session_id: this.#sessionId, title, cwd, sent_at: Date.now() })),
    );
  }

  /**
   * POST one out-message. postMessage chunks a large payload into parts that share this seq (§8) — a
   * small one is exactly one frame — so a big turn reassembles correctly on the viewer.
   */
  async #post(recordKind: string, seq: number | null, msgId: string, text: string): Promise<void> {
    await this.#client.postMessage(this.#header(recordKind, seq, msgId), utf8(text));
  }

  /** Post AND record a content frame in the transcript (so it can be replayed via catch_up). */
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

  /**
   * Serve the session: tail inbound frames and relay each turn until `signal` aborts. A `user`
   * prompt is acked, echoed, run through the backend, and its assistant/result streamed back out; a
   * `catch_up` control frame replays the in-memory transcript from its `since` (history sync, §16).
   */
  async serve(signal: AbortSignal): Promise<void> {
    for await (const frame of this.#client.streamFrames({
      session: this.#sessionId,
      startIndex: 0,
      signal,
    })) {
      // The broker is an untrusted router. A frame may carry a valid AEAD tag for the session named in
      // its own clear header while having been returned on this relay's different requested channel.
      // Bind the clear coordinate before decrypting, deduping, or driving the backend.
      if (
        frame.dir !== "in" ||
        frame.sessionId !== this.#sessionId ||
        !timingSafeEqual(frame.identityId, this.#identityId)
      ) {
        continue;
      }

      // Authenticate before persistent dedup. Otherwise a broker can put a tampered copy with a
      // genuine frame's visible msg_id first and make #seen suppress the authentic command forever.
      let plaintext: Uint8Array;
      try {
        plaintext = await this.#client.openFrame(frame);
      } catch {
        continue;
      }
      if (this.#seen.has(frame.msgId)) continue; // authenticated at-least-once replay
      this.#seen.add(frame.msgId);

      if (frame.recordKind === "user") {
        const text = new TextDecoder().decode(plaintext);
        const userSeq = this.#seq++;
        // Ack the client's frame (meta — not part of the transcript), then echo the prompt (content).
        await this.#post(
          "accepted",
          null,
          `accepted-${this.#sessionId}-${userSeq}`,
          JSON.stringify({ client_msg_id: frame.clientMsgId ?? null, seq: userSeq }),
        );
        await this.#emit("user", userSeq, `user-${userSeq}`, text);
        // Drive the real model and relay the turn.
        for await (const ev of this.#backend.prompt(text)) {
          const seq = this.#seq++;
          await this.#emit(ev.kind, seq, `${ev.kind}-${seq}`, ev.text);
        }
      } else if (frame.recordKind === "catch_up") {
        const body = JSON.parse(new TextDecoder().decode(plaintext));
        await this.#replay(typeof body.since === "number" ? body.since : 0);
      }
    }
  }
}
