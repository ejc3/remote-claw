import type { WireFrame } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { TemporalBackend } from "../../lib/broker/temporal";
import { createRelayWorker, runRelayWorkerFor } from "../../temporal/run";

// Proves the Vercel keep-warm path: a worker booted by createRelayWorker() (the SAME bootstrap the
// drain route uses) drains a channel that was queued while NO worker was polling. Run via
// `pnpm test:drain`, which stands up a Temporal dev server with TEMPORAL_NO_WORKER=1 (no standalone
// worker) so the only thing that can drain the queue is the worker this test boots — otherwise the
// assertion wouldn't attribute the drain to our bootstrap. Skipped offline (no TEMPORAL_ADDRESS).

const RUN = Boolean(process.env.TEMPORAL_ADDRESS);

function frame(seq: number): WireFrame {
  return { seq } as unknown as WireFrame;
}
const seqs = (fs: WireFrame[]) => fs.map((f) => (f as unknown as { seq: number }).seq);

async function readN(stream: ReadableStream<WireFrame>, n: number, ms = 8000): Promise<WireFrame[]> {
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

describe.skipIf(!RUN)("keep-warm drain worker (real server, no standalone worker)", () => {
  it("a worker booted by createRelayWorker drains a channel queued while nothing was polling", async () => {
    const backend = new TemporalBackend();
    const t = `drain-${process.pid}-${Date.now()}`;

    // Publish with NO worker running yet: signalWithStart creates the workflow + buffers the signals,
    // but nothing advances it (no poller). This is exactly the state a Vercel deploy is in between
    // cron ticks.
    expect((await backend.publish(t, frame(0))).created).toBe(true);
    await backend.publish(t, frame(1));

    // Now boot a worker the way the drain route does, and run it in the background.
    const { worker, connection } = await createRelayWorker();
    const runP = worker.run();
    try {
      // The queued frames drain only because OUR worker is now polling.
      const stream = await backend.subscribe(t, 0);
      expect(stream).not.toBeNull();
      if (stream === null) throw new Error("expected a stream");
      expect(seqs(await readN(stream, 2))).toEqual([0, 1]);
      // Close while the worker is still up so the run completes and frees the id.
      await backend.publish(t, { __close: true });
    } finally {
      worker.shutdown();
      await runP; // resolves once the graceful drain finishes
      await connection.close();
    }
  }, 60_000);

  it("runRelayWorkerFor runs for the window, then shuts down gracefully and resolves", async () => {
    const result = await runRelayWorkerFor(1500);
    expect(result.ran).toBe(true);
    expect(result.windowMs).toBe(1500);
  }, 30_000);
});
