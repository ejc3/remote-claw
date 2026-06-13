import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex } from "../../lib/broker/session-index";
import { dbFileName, FileDbLocator, SqliteMultiBackend } from "../../lib/broker/sqlite-multi";

// The cold session index is the scalable (cloud) retention path: a catalog written ONCE on db-create and
// deleted on drop, walked in resumable batches by the sweep. Here it's exercised over REAL libSQL file
// dbs via a FileDbLocator that opts into the index (so we test the index sweep engine without Turso).

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rc-idx-"));
  dirs.push(d);
  return d;
}

const A = "sess:00000000000000000000000000000000:cse_aaaa";
const B = "sess:00000000000000000000000000000000:cse_bbbb";
function frame(seq: number): WireFrame {
  return { seq } as unknown as WireFrame;
}
const seqs = (fs: WireFrame[]) => fs.map((f) => (f as unknown as { seq: number }).seq);
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

// FileDbLocator now exposes the cold index (an `_index.db` in the same dir) natively, so the backend
// takes the index sweep path over real file dbs — the same path the Turso Cloud locator uses in prod,
// which is exactly why "use the index for local too" makes the cloud retention engine testable here.

describe("SessionIndex", () => {
  it("adds, lists in id order with a resumable cursor, and removes", async () => {
    const client = createClient({ url: `file:${join(tmp(), "idx.db")}` });
    const idx = new SessionIndex(client);
    try {
      await idx.add("rc-b", "libsql://rc-b", 1);
      await idx.add("rc-a", "libsql://rc-a", 2);
      await idx.add("rc-c", "libsql://rc-c", 3);
      await idx.add("rc-a", "libsql://rc-a", 99); // INSERT OR IGNORE — no duplicate, keeps created_at

      expect((await idx.batchAfter("", 2)).map((s) => s.id)).toEqual(["rc-a", "rc-b"]); // id-ordered page
      expect((await idx.batchAfter("rc-b", 10)).map((s) => s.id)).toEqual(["rc-c"]); // resume after cursor

      await idx.setCursor("rc-b");
      expect(await idx.getCursor()).toBe("rc-b"); // cursor persists across runs

      await idx.remove("rc-b");
      expect((await idx.batchAfter("", 10)).map((s) => s.id)).toEqual(["rc-a", "rc-c"]);
    } finally {
      client.close();
    }
  });
});

describe("SqliteMultiBackend cold-index retention", () => {
  it("catalogs sessions on create and sweeps the idle ones via the index (not busy ones)", async () => {
    const dir = tmp();
    const be = new SqliteMultiBackend(new FileDbLocator(dir));
    await be.publish(A, frame(1)); // create → catalogued in the index
    await be.publish(B, frame(1));
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    expect(existsSync(join(dir, dbFileName(B)))).toBe(true);

    expect(await be.sweep(60_000)).toBe(0); // nothing older than a generous window
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);

    // Hold a live subscriber on A; a negative retention makes all stale, but A is busy → only B drops.
    const liveA = await be.subscribe(A, undefined);
    expect(await be.sweep(-1)).toBe(1);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    expect(existsSync(join(dir, dbFileName(B)))).toBe(false);
    await (liveA as ReadableStream<WireFrame>).cancel();

    // A is now idle → swept AND removed from the index, so a later subscribe sees no channel.
    expect(await be.sweep(-1)).toBe(1);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(false);
    expect(await be.subscribe(A, undefined)).toBeNull();

    // A republish re-catalogs + recreates; the index sweep finds it again.
    await be.publish(A, frame(7));
    const sub = await be.subscribe(A, undefined);
    expect(seqs(await take(sub as ReadableStream<WireFrame>, 1))).toEqual([7]);
  });

  it("dropIndex removes the catalog ONLY when empty — a non-empty index is kept (no orphaning)", async () => {
    const dir = tmp();
    const be = new SqliteMultiBackend(new FileDbLocator(dir));
    await be.publish(A, frame(1)); // catalogues A → the index now has a session
    expect(existsSync(join(dir, "_index.db"))).toBe(true);

    // dropIndex while a session is still catalogued must NOT delete the catalog (that would orphan A's
    // db — nothing left to reclaim it). The index file survives.
    await be.dropIndex();
    expect(existsSync(join(dir, "_index.db"))).toBe(true);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);

    // Once A is swept (index empty), dropIndex reclaims the now-empty catalog db itself.
    expect(await be.sweep(-1)).toBe(1);
    await be.dropIndex();
    expect(existsSync(join(dir, "_index.db"))).toBe(false);
  });

  it("does NOT drop a session that gets a fresh frame between the two staleness probes (TOCTOU guard)", async () => {
    const dir = tmp();
    // A probe-intercepting factory: the 1st MAX(created_at) reads STALE (epoch 1), the 2nd reads FRESH
    // (now) — simulating a publish that lands after the first probe. The backend must re-probe (after
    // evicting the cached client) and, seeing it fresh, NOT drop the db.
    let probeReads = 0;
    const factory = ((config: { url: string; authToken?: string }) => {
      const real = createClient(config);
      return new Proxy(real, {
        get(t, p) {
          if (p === "execute") {
            return async (...a: unknown[]) => {
              const stmt = a[0];
              const sql =
                typeof stmt === "object" && stmt !== null && "sql" in stmt
                  ? String((stmt as { sql: unknown }).sql)
                  : String(stmt);
              if (sql.includes("SELECT MAX(created_at) AS m FROM frames")) {
                probeReads += 1;
                return { rows: [{ m: probeReads >= 2 ? Date.now() : 1 }] };
              }
              const ex = (t as { execute: (...x: unknown[]) => Promise<unknown> }).execute.bind(t);
              return ex(...a);
            };
          }
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    }) as unknown as typeof createClient;

    const be = new SqliteMultiBackend(new FileDbLocator(dir), factory);
    await be.publish(A, frame(1));
    // cutoff = now-1000: probe#1 m=1 (stale) → evict → probe#2 m=now (fresh, > cutoff) → keep.
    expect(await be.sweep(1000)).toBe(0);
    expect(probeReads).toBe(2); // proves it re-probed after eviction
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true); // the session (and its frame) survived
  });
});
