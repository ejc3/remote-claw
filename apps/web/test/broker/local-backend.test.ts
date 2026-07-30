import type { WireFrame } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  type BrokerBackend,
  hasDurableRecovery,
  type PublishResult,
  type RelayPayload,
} from "../../lib/broker/backend";
import { LocalBackend } from "../../lib/broker/local";

// The LocalBackend is the in-process fake broker. These tests pin the channel CONTRACT every backend
// must honour (ordering, resumable replay, tail-relative reads, create-or-resume, subscribe-or-null,
// close-frees-token, multi-subscriber fan-out) — no Vercel runtime, just the class.

// The backend treats a frame as opaque, so a minimal WireFrame carrying a `seq` marker is enough to
// assert order/identity.
function frame(seq: number): WireFrame {
  return { seq } as unknown as WireFrame;
}
const seqs = (fs: WireFrame[]) => fs.map((f) => (f as unknown as { seq: number }).seq);

function cursorBackend(
  cursors: Partial<Pick<BrokerBackend, "maxSeq" | "frameCount">>,
): BrokerBackend {
  return {
    publish: async (_token: string, _payload: RelayPayload): Promise<PublishResult> => ({
      created: false,
      channelId: "test",
    }),
    subscribe: async () => null,
    ...cursors,
  };
}

describe("BrokerBackend durable-recovery capability", () => {
  it("requires maxSeq and frameCount together", () => {
    expect(hasDurableRecovery(cursorBackend({}))).toBe(false);
    expect(hasDurableRecovery(cursorBackend({ maxSeq: async () => null }))).toBe(false);
    expect(hasDurableRecovery(cursorBackend({ frameCount: async () => null }))).toBe(false);
    expect(
      hasDurableRecovery(cursorBackend({ maxSeq: async () => null, frameCount: async () => null })),
    ).toBe(true);
  });
});

/** Assert a subscribe() result is a live stream (not the absent-channel null) and narrow it. */
function present(stream: ReadableStream<WireFrame> | null): ReadableStream<WireFrame> {
  expect(stream).not.toBeNull();
  if (stream === null) throw new Error("expected a stream, got null");
  return stream;
}

/** Read exactly `n` frames from a stream (or fewer if it closes first), with a safety timeout. */
async function readN(
  stream: ReadableStream<WireFrame>,
  n: number,
  ms = 1000,
): Promise<WireFrame[]> {
  const reader = stream.getReader();
  const out: WireFrame[] = [];
  const deadline = Date.now() + ms;
  try {
    while (out.length < n) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const timeout = new Promise<{ timedOut: true }>((r) =>
        setTimeout(() => r({ timedOut: true }), remaining),
      );
      const res = await Promise.race([reader.read(), timeout]);
      if ("timedOut" in res) break;
      if (res.done) break;
      out.push(res.value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

describe("LocalBackend — durable channel contract", () => {
  it("replays buffered frames in publish order from the start", async () => {
    const b = new LocalBackend();
    await b.publish("t", frame(0));
    await b.publish("t", frame(1));
    await b.publish("t", frame(2));
    const stream = present(await b.subscribe("t", 0));
    expect(seqs(await readN(stream, 3))).toEqual([0, 1, 2]);
  });

  it("returns null when no channel exists (subscribe never creates one)", async () => {
    const b = new LocalBackend();
    expect(await b.subscribe("absent", 0)).toBeNull();
  });

  it("reports created=true only for the first publish to a token", async () => {
    const b = new LocalBackend();
    expect((await b.publish("t", frame(0))).created).toBe(true);
    expect((await b.publish("t", frame(1))).created).toBe(false);
  });

  it("delivers live frames to an already-connected subscriber", async () => {
    const b = new LocalBackend();
    await b.publish("t", frame(0)); // create the channel so subscribe resolves
    const stream = present(await b.subscribe("t", 0));
    await b.publish("t", frame(1));
    await b.publish("t", frame(2));
    // 0 was buffered; 1 and 2 arrive live.
    expect(seqs(await readN(stream, 3))).toEqual([0, 1, 2]);
  });

  it("a negative startIndex reads only the recent window", async () => {
    const b = new LocalBackend();
    for (let i = 0; i < 5; i++) await b.publish("t", frame(i));
    const stream = present(await b.subscribe("t", -2));
    expect(seqs(await readN(stream, 2))).toEqual([3, 4]); // last 2 only
  });

  it("clamps a positive out-of-range startIndex to the head: empty replay, then live", async () => {
    const b = new LocalBackend();
    await b.publish("t", frame(0));
    await b.publish("t", frame(1));
    const stream = present(await b.subscribe("t", 99)); // past the end → clamp to len
    await b.publish("t", frame(2));
    expect(seqs(await readN(stream, 1))).toEqual([2]); // no replay of 0/1, only the new frame
  });

  it("fans a live frame out to every subscriber", async () => {
    const b = new LocalBackend();
    await b.publish("t", frame(0));
    const a = present(await b.subscribe("t", 0));
    const c = present(await b.subscribe("t", 0));
    await b.publish("t", frame(1));
    expect(seqs(await readN(a, 2))).toEqual([0, 1]);
    expect(seqs(await readN(c, 2))).toEqual([0, 1]);
  });

  it("__close ends live streams and frees the token for a fresh channel", async () => {
    const b = new LocalBackend();
    await b.publish("t", frame(0));
    const stream = present(await b.subscribe("t", 0));
    await b.publish("t", { __close: true });
    // The stream closes after draining the buffered frame; no live frame follows.
    expect(seqs(await readN(stream, 5, 300))).toEqual([0]);
    // Token freed: a new subscribe sees nothing until a fresh publish re-creates the channel.
    expect(await b.subscribe("t", 0)).toBeNull();
    expect((await b.publish("t", frame(9))).created).toBe(true);
  });

  it("isolates channels by token", async () => {
    const b = new LocalBackend();
    await b.publish("A", frame(1));
    await b.publish("B", frame(2));
    expect(seqs(await readN(present(await b.subscribe("A", 0)), 1))).toEqual([1]);
    expect(seqs(await readN(present(await b.subscribe("B", 0)), 1))).toEqual([2]);
  });
});
