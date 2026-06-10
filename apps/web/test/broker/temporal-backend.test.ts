import type { WireFrame } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import { TemporalBackend } from "../../lib/broker/temporal";

// The SAME durable-channel contract as local-backend.test.ts, run against a REAL Temporal server +
// the relayChannel worker. Skipped unless TEMPORAL_ADDRESS is set (so a normal `vitest run` stays
// green offline); `pnpm test:temporal` stands the server + worker up and sets it. Temporal is slower
// (signal round-trip + 150ms query polling), hence the generous timeouts and a unique token per test
// so reruns against the same (persistent) server don't collide on a workflow id.

const RUN = Boolean(process.env.TEMPORAL_ADDRESS);

function frame(seq: number): WireFrame {
  return { seq } as unknown as WireFrame;
}
const seqs = (fs: WireFrame[]) => fs.map((f) => (f as unknown as { seq: number }).seq);

function present(stream: ReadableStream<WireFrame> | null): ReadableStream<WireFrame> {
  expect(stream).not.toBeNull();
  if (stream === null) throw new Error("expected a stream, got null");
  return stream;
}

async function readN(
  stream: ReadableStream<WireFrame>,
  n: number,
  ms = 8000,
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

// A distinct token per test keeps runs isolated on a shared server.
let n = 0;
const tok = (name: string) => `e2e-temporal-${name}-${process.pid}-${n++}`;

describe.skipIf(!RUN)("TemporalBackend — durable channel contract (real server)", () => {
  const backend = new TemporalBackend();
  const opened: string[] = [];
  afterAll(async () => {
    // Close every channel we opened so its workflow completes and frees the id.
    for (const t of opened) await backend.publish(t, { __close: true });
  });

  it("replays buffered frames in order, then streams live", async () => {
    const t = tok("order");
    opened.push(t);
    expect((await backend.publish(t, frame(0))).created).toBe(true);
    await backend.publish(t, frame(1));
    const stream = present(await backend.subscribe(t, 0));
    await backend.publish(t, frame(2));
    expect(seqs(await readN(stream, 3))).toEqual([0, 1, 2]);
  }, 30_000);

  it("returns null for an absent channel", async () => {
    expect(await backend.subscribe(tok("absent"), 0)).toBeNull();
  }, 20_000);

  it("a negative startIndex reads the recent window", async () => {
    const t = tok("window");
    opened.push(t);
    for (let i = 0; i < 4; i++) await backend.publish(t, frame(i));
    // Let the worker apply all four signals before sampling the window.
    const stream = present(await backend.subscribe(t, -2));
    expect(seqs(await readN(stream, 2))).toEqual([2, 3]);
  }, 30_000);

  it("__close frees the token: a fresh run re-establishes the channel", async () => {
    const t = tok("close");
    await backend.publish(t, frame(0));
    await backend.publish(t, { __close: true });
    // Close is async (the worker must process the signal + complete the run). Wait for completion so
    // the next signalWithStart starts a FRESH run rather than signaling the still-running one.
    const { Client, Connection } = await import("@temporalio/client");
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    });
    try {
      await new Client({ connection }).workflow.getHandle(t).result();
    } finally {
      await connection.close();
    }
    // A fresh publish re-creates the channel from scratch, and a subscriber reads only the new frame.
    expect((await backend.publish(t, frame(9))).created).toBe(true);
    opened.push(t);
    expect(seqs(await readN(present(await backend.subscribe(t, 0)), 1))).toEqual([9]);
  }, 30_000);
});
