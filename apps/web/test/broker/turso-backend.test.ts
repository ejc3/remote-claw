import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it } from "vitest";
import { TursoBackend } from "../../lib/broker/turso";

// The Turso (libSQL) backend MUST honour the same durable-channel contract as LocalBackend (ordering,
// resumable replay, recent-window, create-or-resume, subscribe-or-null, close-frees-token, multi-
// subscriber fan-out) — these are the local-backend.test.ts cases, re-run against a REAL libSQL backed
// by a local FILE (no Turso cloud, no skipIf → runs in plain CI). Plus Turso-specific cases (idempotent
// dedup, chunked parts, live-poll latency). A unique token per test isolates them on the shared file.

const dir = mkdtempSync(join(tmpdir(), "rc-turso-"));
const client: Client = createClient({ url: `file:${join(dir, "test.db")}` });
afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
const tok = () => `t${counter++}`;
const be = () => new TursoBackend(client);

// A minimal opaque WireFrame carrying a `seq` marker (plus optional dedup fields) is enough to assert
// order/identity — the backend never decrypts it.
function frame(seq: number, extra: Record<string, unknown> = {}): WireFrame {
  return { seq, ...extra } as unknown as WireFrame;
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
  ms = 1500,
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

describe("TursoBackend — durable channel contract", () => {
  it("replays buffered frames in publish order from the start", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0));
    await b.publish(t, frame(1));
    await b.publish(t, frame(2));
    expect(seqs(await readN(present(await b.subscribe(t, 0)), 3))).toEqual([0, 1, 2]);
  });

  it("returns null when no channel exists (subscribe never creates one)", async () => {
    expect(await be().subscribe(tok(), 0)).toBeNull();
  });

  it("reports created=true only for the first publish to a token", async () => {
    const t = tok();
    const b = be();
    expect((await b.publish(t, frame(0))).created).toBe(true);
    expect((await b.publish(t, frame(1))).created).toBe(false);
  });

  it("delivers live frames to an already-connected subscriber", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0));
    const stream = present(await b.subscribe(t, 0));
    await b.publish(t, frame(1));
    await b.publish(t, frame(2));
    expect(seqs(await readN(stream, 3))).toEqual([0, 1, 2]);
  });

  it("a negative startIndex reads only the recent window", async () => {
    const t = tok();
    const b = be();
    for (let i = 0; i < 5; i++) await b.publish(t, frame(i));
    expect(seqs(await readN(present(await b.subscribe(t, -2)), 2))).toEqual([3, 4]);
  });

  it("clamps a positive out-of-range startIndex to the head: empty replay, then live", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0));
    await b.publish(t, frame(1));
    const stream = present(await b.subscribe(t, 99));
    await b.publish(t, frame(2));
    expect(seqs(await readN(stream, 1))).toEqual([2]);
  });

  it("fans a live frame out to every subscriber", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0));
    const a = present(await b.subscribe(t, 0));
    const c = present(await b.subscribe(t, 0));
    await b.publish(t, frame(1));
    expect(seqs(await readN(a, 2))).toEqual([0, 1]);
    expect(seqs(await readN(c, 2))).toEqual([0, 1]);
  });

  it("__close ends live streams and frees the token for a fresh channel", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0));
    const stream = present(await b.subscribe(t, 0));
    await b.publish(t, { __close: true });
    // The buffered frame still replays (rows kept), then the stream closes — no live frame follows.
    expect(seqs(await readN(stream, 5, 600))).toEqual([0]);
    // Token freed: a fresh subscribe is null until a new publish re-creates the channel (a new gen).
    expect(await b.subscribe(t, 0)).toBeNull();
    expect((await b.publish(t, frame(9))).created).toBe(true);
    // …and the reopened channel shows ONLY the new incarnation's frame, not the old one.
    expect(seqs(await readN(present(await b.subscribe(t, 0)), 1))).toEqual([9]);
  });

  it("isolates channels by token", async () => {
    const a = tok();
    const b2 = tok();
    const b = be();
    await b.publish(a, frame(1));
    await b.publish(b2, frame(2));
    expect(seqs(await readN(present(await b.subscribe(a, 0)), 1))).toEqual([1]);
    expect(seqs(await readN(present(await b.subscribe(b2, 0)), 1))).toEqual([2]);
  });
});

describe("TursoBackend — Turso-specific", () => {
  it("is idempotent: re-publishing the same (msg_id, part) yields ONE frame", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0, { msg_id: "m1", part: 0 }));
    await b.publish(t, frame(0, { msg_id: "m1", part: 0 })); // a 409 retry of the same frame
    await b.publish(t, frame(1, { msg_id: "m2", part: 0 }));
    // Only two distinct frames land despite three publishes.
    expect(seqs(await readN(present(await b.subscribe(t, 0)), 5, 600))).toEqual([0, 1]);
  });

  it("keeps every part of a chunked message (same msg_id, distinct part)", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0, { msg_id: "big", part: 0 }));
    await b.publish(t, frame(1, { msg_id: "big", part: 1 }));
    await b.publish(t, frame(2, { msg_id: "big", part: 2 }));
    expect(seqs(await readN(present(await b.subscribe(t, 0)), 3))).toEqual([0, 1, 2]);
  });

  it("sweeps frames older than the retention cutoff and prunes empty closed channels", async () => {
    const closed = tok();
    const live = tok();
    const b = be();
    await b.publish(closed, frame(0));
    await b.publish(closed, { __close: true });
    await b.publish(live, frame(1));
    await b.publish(live, frame(2));

    const old = Date.now() - 60_000;
    const recent = Date.now();
    await client.execute({
      sql: "UPDATE frames SET created_at = ? WHERE token = ?",
      args: [old, closed],
    });
    await client.execute({
      sql: `UPDATE frames
            SET created_at = CASE WHEN seq = 1 THEN ? ELSE ? END
            WHERE token = ?`,
      args: [old, recent, live],
    });

    expect(await b.sweep(30_000)).toBe(2);
    expect(seqs(await readN(present(await b.subscribe(live, 0)), 1))).toEqual([2]);

    const remaining = await client.execute({
      sql: "SELECT seq FROM frames WHERE token = ? ORDER BY seq",
      args: [live],
    });
    expect(remaining.rows.map((r) => Number(r.seq))).toEqual([2]);

    const pruned = await client.execute({
      sql: "SELECT token FROM channels WHERE token = ?",
      args: [closed],
    });
    expect(pruned.rows).toHaveLength(0);
  });

  it("picks up a frame published AFTER subscribe (the poll tail)", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0));
    const stream = present(await b.subscribe(t, 0));
    const reading = readN(stream, 2, 3000);
    setTimeout(() => void b.publish(t, frame(1)), 60); // arrives live, within a poll cycle
    expect(seqs(await reading)).toEqual([0, 1]);
  });
});

describe("TursoBackend.maxSeq — durable cross-restart seq cursor (A2b/#36)", () => {
  it("returns null when the channel does not exist", async () => {
    expect(await be().maxSeq(tok())).toBeNull();
  });

  it("returns the highest seq across published frames", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0));
    await b.publish(t, frame(1));
    await b.publish(t, frame(2));
    expect(await b.maxSeq(t)).toBe(2);
  });

  it("ignores NULL-seq frames (accepted/meta) — MAX over seq-bearing rows only", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(5, { msg_id: "a", part: 0 }));
    // A frame with no seq stores seq=NULL (the `?? null` path); SQL MAX skips it.
    await b.publish(t, { msg_id: "meta", part: 0 } as unknown as WireFrame);
    expect(await b.maxSeq(t)).toBe(5);
  });

  it("returns null for a closed channel (a fresh incarnation restarts at 0)", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(3));
    await b.publish(t, { __close: true });
    expect(await b.maxSeq(t)).toBeNull();
  });

  it("reflects only the current incarnation after a reopen (gen bump)", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(7)); // gen 0, seq 7
    await b.publish(t, { __close: true });
    await b.publish(t, frame(0)); // reopen gen 1, seq 0
    expect(await b.maxSeq(t)).toBe(0); // only the new gen's frames count
  });
});
