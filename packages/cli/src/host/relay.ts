// HostRelay — the wrapper's core, decoupled from how "claude" is reached. It joins a session on the
// broker, broadcasts presence, and pumps inbound frames: a viewer `user` prompt is decrypted, fed to
// the ClaudeBackend, and the turn is relayed back out as content frames (the echo, streamed
// assistant text, the result) plus a meta `accepted` ack — each sealed, the broker seeing only
// ciphertext. The backend seam means the SAME relay runs over a real claude (ClaudeStreamSession) or
// a fake one (tests). (§6A/§11/§16.)

import { type FrameHeader, utf8 } from "@remote-claw/clawsec";
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

  constructor(opts: HostRelayOptions) {
    this.#client = opts.client;
    this.#identityId = opts.identityId;
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

  /** Emit one out-frame (content carries a seq; meta/control pass seq=null). */
  async #emit(recordKind: string, seq: number | null, text: string): Promise<void> {
    await this.#client.postFrame(
      this.#header(
        recordKind,
        seq,
        `${recordKind}-${this.#sessionId}-${seq ?? "m"}-${this.#seen.size}`,
      ),
      utf8(text),
    );
  }

  /**
   * Serve the session: tail inbound frames and relay each turn until `signal` aborts. A `user`
   * prompt is acked, echoed, run through the backend, and its assistant/result streamed back out.
   * (Control frames are acknowledged structurally here; mapping them to RC verbs is the live MITM's
   * job — out of scope for the stream-json backend.)
   */
  async serve(signal: AbortSignal): Promise<void> {
    for await (const frame of this.#client.streamFrames({
      session: this.#sessionId,
      startIndex: 0,
      signal,
    })) {
      if (frame.dir !== "in") continue; // ignore our own out-frames echoed on the shared stream
      if (this.#seen.has(frame.msgId)) continue; // at-least-once dedup
      this.#seen.add(frame.msgId);

      if (frame.recordKind === "user") {
        const text = new TextDecoder().decode(await this.#client.openFrame(frame));
        const userSeq = this.#seq++;
        // Ack the client's frame (meta), then echo the user prompt into the transcript (content).
        await this.#emit(
          "accepted",
          null,
          JSON.stringify({ client_msg_id: frame.clientMsgId ?? null, seq: userSeq }),
        );
        await this.#emit("user", userSeq, text);
        // Drive the real model and relay the turn.
        for await (const ev of this.#backend.prompt(text)) {
          await this.#emit(ev.kind, this.#seq++, ev.text);
        }
      }
    }
  }
}
