// Viewer-side delivery discipline. The broker is at-least-once and NOT FIFO (§12), so a subscriber
// must DEDUP (by msg_id, or msg_id:part for a chunked frame) and REORDER content by `seq` before
// rendering. Control/meta frames carry no seq (seq=null) and are delivered immediately once deduped;
// content frames (the transcript) are buffered and released in consecutive seq order, so a reorder
// or a duplicate never corrupts the transcript. A gap (a missing seq) holds delivery until it fills
// (live retry or a catch_up replay, §6/§16) — the design's intended behavior.

import type { Frame } from "@remote-claw/clawsec";

const DEFAULT_SEEN_CAP = 8192;

export class FrameOrderer {
  /** msg_id (or `${msg_id}:${part}`) → already delivered; bounded FIFO so it can't grow forever. */
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  readonly #seenCap: number;
  /** Out-of-order content frames waiting for their turn, keyed by seq. */
  readonly #buffered = new Map<number, Frame>();
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

    this.#buffered.set(frame.seq, frame);
    const ready: Frame[] = [];
    let next = this.#buffered.get(this.#nextSeq);
    while (next !== undefined) {
      ready.push(next);
      this.#buffered.delete(this.#nextSeq);
      this.#nextSeq += 1;
      next = this.#buffered.get(this.#nextSeq);
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
}
