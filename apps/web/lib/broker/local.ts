import type { WireFrame } from "@remote-claw/clawsec";
import { type BrokerBackend, isClose, type PublishResult, type RelayPayload } from "./backend";

// The in-process "fake" broker: a non-durable pub/sub backend that lives entirely in this Node process's
// memory — no Vercel Workflows runtime, no external service. It makes the whole broker runnable inside
// `next dev` (and inside a plain test process), which is what lets a real browser drive the real app
// end-to-end against a real spine. Selected with BROKER_BACKEND=local.
//
// Semantics it must match (so it's a drop-in for the Vercel backend, §6A/§6B):
//   • ordered + resumable — each channel is an append-only frame log; a subscriber replays from
//     startIndex (0 = from the start, negative = the last |n| frames) then streams live, in order.
//   • publish creates-or-resumes; subscribe resolves-or-null — only a publish brings a channel into
//     existence, so an absent identity's subscribe returns null (the route replies 200-empty).
//   • close frees the token — the __close sentinel ends every live stream and drops the channel, so a
//     later publish re-creates it under the same token (an explicit clean teardown).
//
// JS is single-threaded, so the synchronous replay-then-register in subscribe() and the synchronous
// fan-out in publish() never interleave — there is no missed-or-duplicated frame window.
//
// The frame log is unbounded (no production rollover controller): fine for dev/test sessions, which
// are short-lived. For comparison, Vercel exposes a persistent absolute-index resumable stream until
// its one run hits the fixed event cap; the current adapter has no eviction or pre-cap rollover.
// Per-channel SQLite supplies durable paged frame history plus shared durability/sequence and
// host-only inbound-fence cursors.

interface Subscriber {
  controller: ReadableStreamDefaultController<WireFrame>;
}

interface Channel {
  id: string;
  frames: WireFrame[];
  subscribers: Set<Subscriber>;
}

export class LocalBackend implements BrokerBackend {
  readonly #channels = new Map<string, Channel>();
  #nextId = 0;

  #open(token: string): Channel {
    const existing = this.#channels.get(token);
    if (existing !== undefined) return existing;
    const channel: Channel = { id: `local-${this.#nextId++}`, frames: [], subscribers: new Set() };
    this.#channels.set(token, channel);
    return channel;
  }

  #close(token: string, channel: Channel): void {
    for (const sub of channel.subscribers) {
      try {
        sub.controller.close();
      } catch {
        // already closed/errored — nothing to do
      }
    }
    channel.subscribers.clear();
    this.#channels.delete(token); // free the token for a fresh publish after explicit teardown
  }

  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    if (isClose(payload)) {
      const channel = this.#channels.get(token);
      // Closing an absent channel is a no-op (created:false); the id is synthetic for the reply shape.
      if (channel === undefined) return { created: false, channelId: "local-closed" };
      this.#close(token, channel);
      return { created: false, channelId: channel.id };
    }
    const created = !this.#channels.has(token);
    const channel = this.#open(token);
    channel.frames.push(payload);
    for (const sub of channel.subscribers) {
      // A slow/cancelled subscriber's controller can throw on enqueue; never let one bad subscriber
      // abort the publish (which would strand every OTHER subscriber on a permanent gap).
      try {
        sub.controller.enqueue(payload);
      } catch {
        channel.subscribers.delete(sub);
      }
    }
    return { created, channelId: channel.id };
  }

  async subscribe(
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    const channel = this.#channels.get(token);
    if (channel === undefined) return null; // subscribing never creates a channel — mirror Vercel

    // Resolve the resume point: undefined → 0 (from the start); negative → a tail-relative start
    // (the last |n| frames currently present); positive → that absolute index. Clamp both ends into
    // [0, len] so an out-of-range index degrades to "stream only new frames", matching getReadable's
    // contract.
    const len = channel.frames.length;
    let start = 0;
    if (startIndex !== undefined) {
      start = startIndex < 0 ? Math.max(0, len + startIndex) : Math.min(startIndex, len);
    }

    let sub: Subscriber | null = null;
    return new ReadableStream<WireFrame>({
      start: (controller) => {
        // Replay the buffered frames synchronously, THEN register for live frames — single-threaded,
        // so no frame can slip in between (no gap, no dupe).
        for (const f of channel.frames.slice(start)) controller.enqueue(f);
        sub = { controller };
        channel.subscribers.add(sub);
      },
      cancel: () => {
        if (sub !== null) channel.subscribers.delete(sub);
      },
    });
  }
}
