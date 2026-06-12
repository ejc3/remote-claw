// End-to-end harness: the REAL CLI transport (BrokerClient) talking to the REAL broker routes on the
// REAL Workflow runtime (in-process via @workflow/vitest). Only "claude" is faked. This exercises the
// whole spine — seal → POST /api/relay → relay run → out-stream → GET /api/stream (SSE) → open — in
// both directions, with real AES-256-GCM under the derived keys. The one thing NOT covered here is
// the live MITM of Claude's RC protocol (P4/W6), which needs a real claude binary + network.

import type { Frame, FrameHeader, Identity } from "@remote-claw/clawsec";
import { GET as frameCountRoute } from "../../app/api/frame-count/route";
import { POST as relayRoute } from "../../app/api/relay/route";
import { GET as seqRoute } from "../../app/api/seq/route";
import { GET as streamRoute } from "../../app/api/stream/route";

/** A `fetch` that dispatches BrokerClient's calls straight to the real route handlers, in-process. */
export const brokerFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const req = new Request(url, init);
  if (url.pathname === "/api/relay") return relayRoute(req);
  if (url.pathname === "/api/stream") return streamRoute(req);
  if (url.pathname === "/api/seq") return seqRoute(req);
  if (url.pathname === "/api/frame-count") return frameCountRoute(req);
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
};

/** The fake "claude": a deterministic reply so the test can assert the round-trip end to end. */
export function fakeClaudeReply(prompt: string): string {
  return `you said: ${prompt}`;
}

/** Build a frame header with this identity + sensible defaults. */
export function header(id: Identity, extra: Partial<FrameHeader>): FrameHeader {
  return {
    v: 1,
    identityId: id.identityId,
    sessionId: "sess-1",
    dir: "out",
    recordKind: "assistant",
    seq: null,
    msgId: "m",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    ...extra,
  };
}

/**
 * Drain up to `n` frames matching `pred` from a live stream generator, then stop (breaking cancels
 * the underlying SSE). The harness only ever asks for frames it has already published, so the
 * buffered replay (startIndex=0) satisfies the count immediately — no blocking, no timeout needed.
 */
export async function takeFrames(
  gen: AsyncGenerator<Frame>,
  n: number,
  pred: (f: Frame) => boolean = () => true,
): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const f of gen) {
    if (pred(f)) out.push(f);
    if (out.length >= n) break;
  }
  return out;
}
