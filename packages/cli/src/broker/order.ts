// Viewer-side delivery discipline. The broker is at-least-once and NOT FIFO (§12), so a subscriber
// must DEDUP (by msg_id, or msg_id:part for a chunked frame) and REORDER content by `seq` before
// rendering. Control/meta frames carry no seq (seq=null) and are delivered immediately once deduped;
// content frames (the transcript) are buffered and released in consecutive seq order, so a reorder
// or a duplicate never corrupts the transcript. A gap (a missing seq) holds delivery until it fills
// (live retry or a catch_up replay, §6/§16) — the design's intended behavior.
//
// A CHUNKED message (§8) is ONE transcript entry: all its parts share the same `seq` and differ only
// by `part` (0..parts-1). So a seq slot holds the WHOLE message — released only once every part has
// arrived, all parts together in part order — and the cursor advances by one for the message, not
// per chunk. (The caller reassembles a multi-part group with BrokerClient.openMessage.)

import type { Frame } from "@remote-claw/clawsec";

const DEFAULT_SEEN_CAP = 8192;

export class FrameOrderer {
  /** msg_id (or `${msg_id}:${part}`) → already delivered; bounded FIFO so it can't grow forever. */
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  readonly #seenCap: number;
  /** seq → the frames for that transcript entry: one frame, or the accumulating chunks of one message. */
  readonly #buffered = new Map<number, Frame[]>();
  #nextSeq: number;

  /** `nextSeq` is the first transcript seq to expect (0 for a full catch_up; N+1 to resume). */
  constructor(nextSeq = 0, seenCap = DEFAULT_SEEN_CAP) {
    this.#nextSeq = nextSeq;
    this.#seenCap = seenCap;
  }

  #dedupKey(frame: Frame): string {
    return frame.parts > 1 ? `${frame.msgId}:${frame.part}` : frame.msgId;
  }

  /** Record a dedup key, evicting the oldest once the window is full. Returns false if a duplicate. */
  #markSeen(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    this.#seenOrder.push(key);
    if (this.#seenOrder.length > this.#seenCap) {
      const evicted = this.#seenOrder.shift();
      if (evicted !== undefined) this.#seen.delete(evicted);
    }
    return true;
  }

  /**
   * Feed one received frame; returns the frames now ready to deliver, in order (possibly empty, or
   * several at once when a buffered gap just filled). Duplicates and already-passed content seqs
   * return nothing.
   */
  accept(frame: Frame): Frame[] {
    if (!this.#markSeen(this.#dedupKey(frame))) return []; // duplicate

    // Unordered planes (control/meta) deliver as soon as they're deduped.
    if (frame.seq === null) return [frame];

    // A content frame older than the cursor was already delivered — drop it (don't leak it forever).
    if (frame.seq < this.#nextSeq) return [];

    // Place the frame into its seq slot. A single frame IS the slot; a chunk accumulates with its
    // siblings (the same seq) — already deduped by msg_id:part above, so each part lands once. A seq
    // is ONE transcript entry, so every frame in a slot must share the message's msg_id + parts;
    // drop a mismatch (a valid frame can't be forged, but never let two messages pollute one slot).
    const slot = this.#buffered.get(frame.seq) ?? [];
    const head = slot[0];
    if (head !== undefined && (head.msgId !== frame.msgId || head.parts !== frame.parts)) return [];
    // Reject a duplicate within the slot. The msg_id(:part) dedup above normally catches a replay, but
    // the dedup window is BOUNDED — a frame that sat buffered behind a gap long enough for its key to
    // evict can be re-read (every reconnect re-reads from index 0) and reach here a second time.
    if (frame.parts > 1) {
      // Counting a part twice would make the slot reach `parts` while a real part is still missing,
      // releasing a corrupt (and unrecoverable) message; also validate the part index.
      if (frame.part < 0 || frame.part >= frame.parts) return []; // out of range
      if (slot.some((f) => f.part === frame.part)) return []; // duplicate part
    } else if (slot.length > 0) {
      // A parts=1 slot holds exactly one frame; a second copy would be drained and rendered TWICE as
      // duplicate transcript entries (same seq/msg_id). Drop it. (Adversarial-review fix.)
      return [];
    }
    slot.push(frame);
    this.#buffered.set(frame.seq, slot);

    // Drain consecutive COMPLETE slots from the cursor. A chunked slot is complete only when it holds
    // all `parts`; an incomplete chunked message holds the cursor (like any gap) until its rest lands.
    const ready: Frame[] = [];
    for (;;) {
      const cur = this.#buffered.get(this.#nextSeq);
      if (cur === undefined) break;
      const parts = cur[0]?.parts ?? 1;
      if (parts > 1 && cur.length < parts) break; // chunked message still missing parts
      ready.push(...(parts > 1 ? [...cur].sort((a, b) => a.part - b.part) : cur));
      this.#buffered.delete(this.#nextSeq);
      this.#nextSeq += 1;
    }
    return ready;
  }

  /** The next transcript seq still awaited (the catch_up `since` point). */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  /** How many out-of-order content frames are buffered awaiting a gap fill. */
  get pending(): number {
    return this.#buffered.size;
  }

  /** True only when delivery is blocked on a genuinely MISSING seq: frames are buffered ABOVE the
   *  cursor but the cursor's own slot is absent. This distinguishes a real gap (a never-arriving seq,
   *  worth surfacing) from a chunked message AT the cursor still accumulating its parts (pending>0 but
   *  NOT a gap — its parts are arriving, it's progress). The host posts a message's parts together, so a
   *  partial slot at the cursor is transient; an empty cursor slot with later seqs buffered is the stall. */
  get stalledOnMissingSeq(): boolean {
    return this.#buffered.size > 0 && !this.#buffered.has(this.#nextSeq);
  }
}
