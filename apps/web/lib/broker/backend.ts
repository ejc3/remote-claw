import type { WireFrame } from "@remote-claw/clawsec";

// The durable pub/sub backend behind the two broker routes (§3.2/§6A/§6B). A *channel* is addressed
// by a derived token — the per-identity BUS (`bus:<id>`, session_announce broadcasts) or a
// PER-SESSION stream (`sess:<id>:<sid>`, turn/control frames) — and is an ORDERED, RESUMABLE stream
// of ciphertext frames. The broker is a dumb relay: it validates the §8 envelope shape but never
// decrypts, so every adapter moves opaque WireFrames and forges nothing.
//
// This interface is the seam that lets the broker run on different durable runtimes — Vercel
// Workflows in production, an in-process LocalBackend for `next dev` / tests, or Temporal — without
// the routes (or any client, which only ever speaks plain HTTP/SSE) knowing which is underneath.

/** What a publisher may put on a channel: a wire frame, or the teardown sentinel (cap-roll/§6B). */
export type RelayPayload = WireFrame | { __close: true };

/** The teardown sentinel narrows a payload: completing a channel closes its stream and frees the
 *  token for a fresh start (the Vercel cap-roll handoff; a no-op end-of-life on other backends). */
export function isClose(p: RelayPayload): p is { __close: true } {
  return (p as { __close?: boolean }).__close === true;
}

/**
 * Thrown by publish() ONLY when the channel completed/disposed BETWEEN resolving it and delivering
 * the frame (a concurrent __close or Vercel cap-roll). The relay route maps this to 409 — the client
 * re-posts the same (deterministic-msg_id) frame, which the fresh channel dedups. Any OTHER publish
 * failure (e.g. the channel never came up) must NOT be a 409: it propagates as a 500 so the client
 * fails fast instead of retry-looping a hard outage. (Keeping these distinct preserves the pre-port
 * behavior, where only the resume step was inside the route's 409 catch.)
 */
export class PublishConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishConflictError";
  }
  static is(e: unknown): e is PublishConflictError {
    return e instanceof PublishConflictError;
  }
}

/** The result of a publish: whether this call brought the channel into existence, and the adapter's
 *  id for it (a Vercel run id, a LocalBackend channel id, a Temporal workflow id). Both are surfaced
 *  on the relay route's JSON reply (`created`, `runId`) — preserving the client's RelayResult shape. */
export interface PublishResult {
  created: boolean;
  channelId: string;
}

export interface BrokerBackend {
  /**
   * Resume-or-start the token's channel and deliver one payload (a frame, or the close sentinel).
   * The FIRST publisher to a token brings the channel into existence; later publishes resume it.
   * Throws if the channel completed/disposed between resolve and deliver (the route maps that to a
   * 409 so the client retries) — a delivery must never be silently dropped (it would strand a
   * subscriber's ordered stream on a permanent gap).
   */
  publish(token: string, payload: RelayPayload): Promise<PublishResult>;

  /**
   * The channel's durable frame stream from `startIndex` (default 0 = from the beginning; a negative
   * value reads the recent window — e.g. -N for the last N frames — then streams new ones, §6B), or
   * `null` if no channel exists for the token (⇒ the route replies 200-empty, so an absent identity
   * is indistinguishable from a silent one). Subscribing never CREATES a channel — only publish does.
   * Frames arrive in publish order; the stream stays open (live) until the channel closes or the
   * caller cancels.
   */
  subscribe(token: string, startIndex?: number): Promise<ReadableStream<WireFrame> | null>;
}
