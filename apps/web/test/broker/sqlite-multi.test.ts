import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WireFrame } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import { dbFileName, FileDbLocator, SqliteMultiBackend } from "../../lib/broker/sqlite-multi";

// The per-session SQLite backend must honour the SAME durable-channel contract as the shared turso /
// local backends (ordering, resumable replay, recent-window, create-or-resume, subscribe-or-null,
// close-frees-token, multi-subscriber fan-out, idempotent dedup), but with ONE database per channel
// token. Run against a REAL libSQL backed by local FILES in a temp dir (no cloud, plain CI). Plus the
// per-session specifics: physical isolation (one file per token), retention = drop the file, and the
// filename-safety guard against a hostile session id.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkBackend(): { be: SqliteMultiBackend; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-"));
  dirs.push(dir);
  return { be: new SqliteMultiBackend(new FileDbLocator(dir)), dir };
}

function frame(seq: number, extra: Record<string, unknown> = {}): WireFrame {
  return { seq, ...extra } as unknown as WireFrame;
}
function metaFrame(extra: Record<string, unknown> = {}): WireFrame {
  return { ...extra } as unknown as WireFrame; // no seq → stored as NULL
}
const seqs = (fs: WireFrame[]) => fs.map((f) => (f as unknown as { seq: number }).seq);

/** Read exactly `n` frames then cancel (works while the channel is still live). */
async function take(stream: ReadableStream<WireFrame>, n: number): Promise<WireFrame[]> {
  const reader = stream.getReader();
  const out: WireFrame[] = [];
  try {
    while (out.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) out.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

/** Drain a stream to its natural end (only returns if the channel closes/recycles). */
async function drain(stream: ReadableStream<WireFrame>): Promise<WireFrame[]> {
  const reader = stream.getReader();
  const out: WireFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out.push(value);
  }
  return out;
}

const A = "sess:00000000000000000000000000000000:cse_aaaa";
const B = "sess:00000000000000000000000000000000:cse_bbbb";
const BUS = "bus:00000000000000000000000000000000";

describe("dbFileName", () => {
  it("maps a token to a URL/filename-safe name with a reversible ':'→'-'", () => {
    expect(dbFileName(BUS)).toBe("bus-00000000000000000000000000000000.db");
    expect(dbFileName(A)).toBe("sess-00000000000000000000000000000000-cse_aaaa.db");
  });

  it("is injective for distinct safe tokens", () => {
    expect(dbFileName(A)).not.toBe(dbFileName(B));
  });

  it("throws (fail-closed) on a token carrying an unsafe char — no traversal, no collision", () => {
    expect(() => dbFileName("sess:00:../../etc/passwd")).toThrow(/unsafe/);
    expect(() => dbFileName("sess:00:a/b")).toThrow(/unsafe/);
    expect(() => dbFileName("sess:00:a-b")).toThrow(/unsafe/); // '-' is reserved for the ':' mapping
    expect(() => dbFileName("")).toThrow(/unsafe/);
  });
});

describe("SqliteMultiBackend", () => {
  it("publish creates the session's database; subscribe-before-publish returns null and creates nothing", async () => {
    const { be, dir } = mkBackend();
    expect(await be.subscribe(A, undefined)).toBeNull();
    expect(existsSync(join(dir, dbFileName(A)))).toBe(false);

    const r = await be.publish(A, frame(1));
    expect(r.created).toBe(true);
    expect(r.channelId).toBe(A);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
  });

  it("replays in order then tails live frames from one cursor", async () => {
    const { be } = mkBackend();
    await be.publish(A, frame(1));
    await be.publish(A, frame(2));

    const stream = await be.subscribe(A, undefined);
    expect(stream).not.toBeNull();
    const reader = (stream as ReadableStream<WireFrame>).getReader();
    expect(seqs([(await reader.read()).value as WireFrame])).toEqual([1]);
    expect(seqs([(await reader.read()).value as WireFrame])).toEqual([2]);
    await be.publish(A, frame(3)); // live tail
    expect(seqs([(await reader.read()).value as WireFrame])).toEqual([3]);
    await reader.cancel();
  });

  it("physically isolates sessions — a publish to A is invisible on B's database", async () => {
    const { be, dir } = mkBackend();
    await be.publish(A, frame(1));
    await be.publish(B, frame(99));
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    expect(existsSync(join(dir, dbFileName(B)))).toBe(true);

    const sa = await be.subscribe(A, undefined);
    const sb = await be.subscribe(B, undefined);
    expect(seqs(await take(sa as ReadableStream<WireFrame>, 1))).toEqual([1]);
    expect(seqs(await take(sb as ReadableStream<WireFrame>, 1))).toEqual([99]);
  });

  it("maxSeq ignores NULL-seq rows; frameCount counts every row", async () => {
    const { be } = mkBackend();
    await be.publish(A, frame(1));
    await be.publish(A, frame(2));
    await be.publish(A, frame(3));
    await be.publish(A, metaFrame({ record_kind: "session_announce" })); // seq NULL
    expect(await be.maxSeq(A)).toBe(3);
    expect(await be.frameCount(A)).toBe(4);
  });

  it("maxSeq/frameCount are null for an absent or closed channel", async () => {
    const { be } = mkBackend();
    expect(await be.maxSeq(A)).toBeNull();
    expect(await be.frameCount(A)).toBeNull();
    await be.publish(A, frame(1));
    await be.publish(A, { __close: true });
    expect(await be.maxSeq(A)).toBeNull();
    expect(await be.frameCount(A)).toBeNull();
  });

  it("close ends a live subscriber's stream; a reopen bumps gen so a new subscriber sees only the new incarnation", async () => {
    const { be } = mkBackend();
    await be.publish(A, frame(1));
    const live = await be.subscribe(A, undefined);
    const drained = drain(live as ReadableStream<WireFrame>);
    await be.publish(A, { __close: true });
    expect(seqs(await drained)).toEqual([1]); // got the replay, then the close ended it

    // Subscribing to a closed channel is null...
    expect(await be.subscribe(A, undefined)).toBeNull();
    // ...until a publish reopens a fresh incarnation (created=true), visible only in the new gen.
    const r = await be.publish(A, frame(2));
    expect(r.created).toBe(true);
    const reopened = await be.subscribe(A, undefined);
    expect(seqs(await take(reopened as ReadableStream<WireFrame>, 1))).toEqual([2]);
  });

  it("a close sentinel on an absent token is a no-op and creates no database", async () => {
    const { be, dir } = mkBackend();
    const r = await be.publish(A, { __close: true });
    expect(r.created).toBe(false);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(false);
  });

  it("resumes from a positive startIndex (skip), a negative window, and clamps past-the-end to the head", async () => {
    const { be } = mkBackend();
    for (let s = 1; s <= 5; s++) await be.publish(A, frame(s));

    const skip = await be.subscribe(A, 2);
    expect(seqs(await take(skip as ReadableStream<WireFrame>, 3))).toEqual([3, 4, 5]);

    const window = await be.subscribe(A, -2);
    expect(seqs(await take(window as ReadableStream<WireFrame>, 2))).toEqual([4, 5]);

    const pastEnd = await be.subscribe(A, 10); // replay nothing, then tail
    const tail = take(pastEnd as ReadableStream<WireFrame>, 1);
    await be.publish(A, frame(6));
    expect(seqs(await tail)).toEqual([6]);
  });

  it("dedups a re-POST with the same (msg_id, part) — idempotent publish", async () => {
    const { be } = mkBackend();
    await be.publish(A, frame(1, { msg_id: "m1", part: 0 }));
    await be.publish(A, frame(1, { msg_id: "m1", part: 0 })); // same → ON CONFLICT DO NOTHING
    await be.publish(A, frame(2, { msg_id: "m1", part: 1 })); // different part → inserts
    expect(await be.frameCount(A)).toBe(2);
  });

  it("fans out to multiple concurrent subscribers", async () => {
    const { be } = mkBackend();
    await be.publish(A, frame(1));
    await be.publish(A, frame(2));
    const s1 = await be.subscribe(A, undefined);
    const s2 = await be.subscribe(A, undefined);
    expect(seqs(await take(s1 as ReadableStream<WireFrame>, 2))).toEqual([1, 2]);
    expect(seqs(await take(s2 as ReadableStream<WireFrame>, 2))).toEqual([1, 2]);
  });

  it("serializes concurrent publishes to a brand-new session (no schemaless-DB race, no lost writes)", async () => {
    // All 20 borrows hit the same just-created client WHILE its schema is still migrating — they must
    // each await the shared migration before touching `channel`/`frames`, and the per-client write lock
    // must serialize the inserts. Without that, a borrow runs SQL against a schemaless db (no such table)
    // or two transactions collide.
    const { be } = mkBackend();
    const N = 20;
    await Promise.all(Array.from({ length: N }, (_, i) => be.publish(A, frame(i + 1))));
    expect(await be.frameCount(A)).toBe(N);
    const sub = await be.subscribe(A, undefined);
    const got = await take(sub as ReadableStream<WireFrame>, N);
    expect(seqs(got).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it("sweep drops idle session databases, keeps recent ones, and never drops one with a live subscriber", async () => {
    const { be, dir } = mkBackend();
    await be.publish(A, frame(1));
    await be.publish(B, frame(1));
    const pathA = join(dir, dbFileName(A));
    const pathB = join(dir, dbFileName(B));

    // Nothing is older than a generous retention window.
    expect(await be.sweep(60_000)).toBe(0);
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);

    // Hold a live subscriber on A. A negative retention makes EVERYTHING look stale, but A is busy.
    const liveA = await be.subscribe(A, undefined);
    expect(await be.sweep(-1)).toBe(1); // only B dropped
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(false);
    await (liveA as ReadableStream<WireFrame>).cancel();

    // Now A is idle and gets reclaimed.
    expect(await be.sweep(-1)).toBe(1);
    expect(existsSync(pathA)).toBe(false);
  });
});
