import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex } from "../../lib/broker/session-index";
import { dbFileName, FileDbLocator, SqliteMultiBackend } from "../../lib/broker/sqlite-multi";

// The cold channel catalog is the scalable (cloud) retention path: written ONCE on db-create and
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
  it("adds an absorbing continuity witness and lists in id order with a resumable cursor", async () => {
    const client = createClient({ url: `file:${join(tmp(), "idx.db")}` });
    const idx = new SessionIndex(client);
    try {
      await idx.add("rc-b", "libsql://rc-b", 1);
      await idx.add("rc-a", "libsql://rc-a", 2);
      await idx.add("rc-c", "libsql://rc-c", 3);
      await idx.add("rc-a", "libsql://rc-a", 99); // INSERT OR IGNORE — no duplicate, keeps created_at

      expect(await idx.has("rc-a")).toBe(true);
      expect(await idx.has("rc-missing")).toBe(false);
      expect((await idx.batchAfter("", 2)).map((s) => s.id)).toEqual(["rc-a", "rc-b"]); // id-ordered page
      expect((await idx.batchAfter("rc-b", 10)).map((s) => s.id)).toEqual(["rc-c"]); // resume after cursor

      await idx.setCursor("rc-b");
      expect(await idx.getCursor()).toBe("rc-b"); // cursor persists across runs

      // There is deliberately no removal API: losing the physical db must not erase prior-existence
      // evidence and authorize a fresh empty store under the same token.
      expect(await idx.has("rc-b")).toBe(true);
    } finally {
      client.close();
    }
  });
});

describe("SqliteMultiBackend fail-closed retention catalog", () => {
  it("catalogs sessions on create but never treats idle time as collection authority", async () => {
    const dir = tmp();
    const be = new SqliteMultiBackend(new FileDbLocator(dir));
    await be.publish(A, frame(1)); // create → catalogued in the index
    await be.publish(B, frame(1));
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    expect(existsSync(join(dir, dbFileName(B)))).toBe(true);

    // Even an all-stale cutoff cannot prove either session ended, so the sweep is non-mutating.
    expect(await be.sweep(-1)).toBe(0);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    expect(existsSync(join(dir, dbFileName(B)))).toBe(true);
    const sub = await be.subscribe(A, undefined);
    expect(seqs(await take(sub as ReadableStream<WireFrame>, 1))).toEqual([1]);
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

    // A retention call cannot empty the catalog or make dropping it safe.
    expect(await be.sweep(-1)).toBe(0);
    await be.dropIndex();
    expect(existsSync(join(dir, "_index.db"))).toBe(true);
  });
});
