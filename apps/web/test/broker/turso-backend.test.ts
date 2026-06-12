import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { afterAll, describe, expect, it, vi } from "vitest";
import { evictBackend, getBackend } from "../../lib/broker";
import { TursoBackend } from "../../lib/broker/turso";
import { ensureSchema, resetTursoConnection } from "../../lib/broker/turso-connection";

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
const msgIds = (fs: WireFrame[]) => fs.map((f) => (f as unknown as { msg_id: string }).msg_id);

async function storedSeqs(token: string): Promise<number[]> {
  const res = await client.execute({
    sql: "SELECT seq FROM frames WHERE token = ? ORDER BY seq",
    args: [token],
  });
  return res.rows.map((r) => Number(r.seq));
}

async function storedMsgIds(token: string): Promise<string[]> {
  const res = await client.execute({
    sql: "SELECT msg_id FROM frames WHERE token = ? ORDER BY id",
    args: [token],
  });
  return res.rows.map((r) => String(r.msg_id));
}

async function channelExists(token: string): Promise<boolean> {
  const res = await client.execute({
    sql: "SELECT token FROM channels WHERE token = ?",
    args: [token],
  });
  return res.rows.length === 1;
}

function codedError(message: string, code: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

function failOnceOnFramePoll(base: Client): Client {
  let failed = false;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "execute") {
        return async (...args: unknown[]) => {
          const stmt = args[0];
          const sql =
            typeof stmt === "object" && stmt !== null && "sql" in stmt
              ? String((stmt as { sql: unknown }).sql)
              : String(stmt);
          if (!failed && sql.includes("SELECT id, frame FROM frames")) {
            failed = true;
            throw codedError("temporary server error", "SERVER_ERROR");
          }
          const execute = target.execute.bind(target) as (
            ...executeArgs: unknown[]
          ) => Promise<unknown>;
          return execute(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
}

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

  it("serializes concurrent writes while deduping idempotent retries", async () => {
    const t = tok();
    const b = be();
    const same = Array.from({ length: 10 }, () =>
      b.publish(t, frame(0, { msg_id: "same", part: 0 })),
    );
    const distinct = Array.from({ length: 10 }, (_, i) =>
      b.publish(t, frame(i + 1, { msg_id: `m${i}`, part: 0 })),
    );

    await expect(Promise.all([...same, ...distinct])).resolves.toHaveLength(20);

    const ids = await storedMsgIds(t);
    expect(ids).toHaveLength(11);
    expect(ids.filter((id) => id === "same")).toHaveLength(1);
    for (let i = 0; i < 10; i++) expect(ids).toContain(`m${i}`);
  });

  it("keeps every part of a chunked message (same msg_id, distinct part)", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0, { msg_id: "big", part: 0 }));
    await b.publish(t, frame(1, { msg_id: "big", part: 1 }));
    await b.publish(t, frame(2, { msg_id: "big", part: 2 }));
    expect(seqs(await readN(present(await b.subscribe(t, 0)), 3))).toEqual([0, 1, 2]);
  });

  it("sweeps whole stale sessions, preserving live sessions whose head is older than the cutoff", async () => {
    const stale = tok();
    const live = tok();
    const b = be();
    await b.publish(stale, frame(0));
    await b.publish(stale, frame(1));
    await b.publish(live, frame(0));
    await b.publish(live, frame(1));

    const old = Date.now() - 60_000;
    const recent = Date.now();
    await client.execute({
      sql: "UPDATE frames SET created_at = ? WHERE token = ?",
      args: [old, stale],
    });
    await client.execute({
      sql: `UPDATE frames
            SET created_at = CASE WHEN seq = 0 THEN ? ELSE ? END
            WHERE token = ?`,
      args: [old, recent, live],
    });

    expect(await b.sweep(30_000)).toBe(1);
    expect(await b.subscribe(stale, 0)).toBeNull();
    expect(await storedSeqs(stale)).toEqual([]);
    expect(await channelExists(stale)).toBe(false);

    expect(await channelExists(live)).toBe(true);
    expect(await storedSeqs(live)).toEqual([0, 1]);
    expect(seqs(await readN(present(await b.subscribe(live, 0)), 2))).toEqual([0, 1]);
  });

  it("does not prune a non-empty closed channel unless the whole session is stale", async () => {
    const closed = tok();
    const b = be();
    await b.publish(closed, frame(0));
    await b.publish(closed, { __close: true });
    await client.execute({
      sql: "UPDATE frames SET created_at = ? WHERE token = ?",
      args: [Date.now(), closed],
    });

    expect(await b.sweep(30_000)).toBe(0);
    expect(await channelExists(closed)).toBe(true);
    expect(await storedSeqs(closed)).toEqual([0]);
    expect(await b.subscribe(closed, 0)).toBeNull();
  });

  it("keeps a session whose newest frame is exactly at the retention cutoff", async () => {
    const t = tok();
    const b = be();
    const retainMs = 30_000;
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await b.publish(t, frame(0));
      await client.execute({
        sql: "UPDATE frames SET created_at = ? WHERE token = ?",
        args: [now - retainMs, t],
      });

      expect(await b.sweep(retainMs)).toBe(0);
      expect(await channelExists(t)).toBe(true);
      expect(await storedSeqs(t)).toEqual([0]);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("sweeps stale sessions across more than one batch", async () => {
    const sweepDir = mkdtempSync(join(tmpdir(), "rc-turso-sweep-"));
    const sweepClient = createClient({ url: `file:${join(sweepDir, "sweep.db")}` });
    try {
      const prefix = `${tok()}-batch-`;
      const tokens = Array.from({ length: 150 }, (_, i) => `${prefix}${i}`);
      const b = new TursoBackend(sweepClient);
      for (const token of tokens) await b.publish(token, frame(0));
      await sweepClient.execute({
        sql: "UPDATE frames SET created_at = ? WHERE token LIKE ?",
        args: [Date.now() - 60_000, `${prefix}%`],
      });

      expect(await b.sweep(30_000)).toBe(150);

      const remaining = await sweepClient.execute({
        sql: "SELECT COUNT(*) AS n FROM channels WHERE token LIKE ?",
        args: [`${prefix}%`],
      });
      expect(Number(remaining.rows[0]?.n ?? 0)).toBe(0);
      const index = await sweepClient.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'frames_token_created_at'",
      });
      expect(index.rows).toHaveLength(1);
    } finally {
      sweepClient.close();
      rmSync(sweepDir, { recursive: true, force: true });
    }
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

  it("keeps a live-tail subscriber open across one transient poll error", async () => {
    const previousPollMs = process.env.TURSO_POLL_MS;
    process.env.TURSO_POLL_MS = "10";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const t = tok();
      const writer = be();
      await writer.publish(t, frame(0));
      const b = new TursoBackend(failOnceOnFramePoll(client));
      const stream = present(await b.subscribe(t, 1));
      const reading = readN(stream, 2, 1500);
      setTimeout(() => {
        void (async () => {
          await writer.publish(t, frame(1));
          await writer.publish(t, frame(2));
        })();
      }, 30);

      expect(seqs(await reading)).toEqual([1, 2]);
      expect(warn).toHaveBeenCalledWith(
        "[turso] transient subscribe poll failed; retrying:",
        "temporary server error",
      );
    } finally {
      if (previousPollMs === undefined) delete process.env.TURSO_POLL_MS;
      else process.env.TURSO_POLL_MS = previousPollMs;
      warn.mockRestore();
    }
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

describe("TursoBackend.frameCount — durable inbound stream cursor", () => {
  it("returns null when the channel does not exist", async () => {
    expect(await be().frameCount(tok())).toBeNull();
  });

  it("counts every frame row, including NULL-seq meta frames", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(5, { msg_id: "content", part: 0 }));
    await b.publish(t, { msg_id: "meta", part: 0 } as unknown as WireFrame);
    await b.publish(t, frame(6, { msg_id: "content-2", part: 0 }));
    expect(await b.frameCount(t)).toBe(3);
  });

  it("reflects only the current incarnation after a reopen", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(7));
    await b.publish(t, { __close: true });
    expect(await b.frameCount(t)).toBeNull();
    await b.publish(t, frame(0));
    expect(await b.frameCount(t)).toBe(1);
  });

  it("subscribe(token, frameCount) skips all historical rows and delivers only future inbound", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0, { dir: "out", msg_id: "old-out-0", part: 0 }));
    await b.publish(t, {
      seq: null,
      dir: "in",
      record_kind: "user",
      msg_id: "old-in-0",
      part: 0,
    } as unknown as WireFrame);
    await b.publish(t, { msg_id: "old-meta-0", part: 0 } as unknown as WireFrame);
    await b.publish(t, frame(1, { dir: "out", msg_id: "old-out-1", part: 0 }));

    const count = await b.frameCount(t);
    expect(count).toBe(4);
    const stream = present(await b.subscribe(t, count ?? 0));
    await b.publish(t, {
      seq: null,
      dir: "in",
      record_kind: "user",
      msg_id: "new-in-0",
      part: 0,
    } as unknown as WireFrame);

    expect(msgIds(await readN(stream, 2, 600))).toEqual(["new-in-0"]);
  });

  it("handles the empty live-channel N=0 cursor boundary", async () => {
    const t = tok();
    const b = be();
    await ensureSchema(client);
    await client.execute({
      sql: "INSERT INTO channels (token, gen, closed, created_at) VALUES (?, 0, 0, ?)",
      args: [t, Date.now()],
    });

    const count = await b.frameCount(t);
    expect(count).toBe(0);
    const stream = present(await b.subscribe(t, count ?? 0));
    await b.publish(t, {
      seq: null,
      dir: "in",
      record_kind: "user",
      msg_id: "first-in",
      part: 0,
    } as unknown as WireFrame);

    expect(msgIds(await readN(stream, 2, 600))).toEqual(["first-in"]);
  });

  it("handles the single-row N=1 cursor boundary", async () => {
    const t = tok();
    const b = be();
    await b.publish(t, frame(0, { dir: "out", msg_id: "only-old", part: 0 }));

    const count = await b.frameCount(t);
    expect(count).toBe(1);
    const stream = present(await b.subscribe(t, count ?? 0));
    await b.publish(t, {
      seq: null,
      dir: "in",
      record_kind: "user",
      msg_id: "after-one",
      part: 0,
    } as unknown as WireFrame);

    expect(msgIds(await readN(stream, 2, 600))).toEqual(["after-one"]);
  });
});

describe("TursoBackend env cache", () => {
  it("evicts a dead cached client/backend so the next call rebuilds", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "rc-turso-cache-"));
    const previousUrl = process.env.TURSO_DATABASE_URL;
    const previousAuthToken = process.env.TURSO_AUTH_TOKEN;
    const previousBackend = process.env.BROKER_BACKEND;
    const globals = globalThis as unknown as {
      __rcBrokerCache?: Map<string, unknown>;
      __rcTursoClient?: Client;
    };
    try {
      process.env.TURSO_DATABASE_URL = `file:${join(cacheDir, "cache.db")}`;
      delete process.env.TURSO_AUTH_TOKEN;
      process.env.BROKER_BACKEND = "turso";
      evictBackend("turso");
      resetTursoConnection();

      const t = tok();
      const first = await getBackend("turso");
      await first.publish(t, frame(0));
      const firstClient = globals.__rcTursoClient;
      expect(firstClient).toBeDefined();
      if (firstClient === undefined) throw new Error("expected cached Turso client");
      Object.defineProperty(firstClient, "transaction", {
        configurable: true,
        value: async () => {
          firstClient.close();
          throw codedError("connection died", "CLIENT_CLOSED");
        },
      });

      await expect(first.publish(t, frame(1))).rejects.toThrow("connection died");
      expect(globals.__rcBrokerCache?.has("turso")).toBe(false);
      expect(globals.__rcTursoClient).toBeUndefined();

      const rebuilt = await getBackend("turso");
      expect(rebuilt).not.toBe(first);
      expect(globals.__rcTursoClient).not.toBe(firstClient);
      await rebuilt.publish(t, frame(2));
      expect(seqs(await readN(present(await rebuilt.subscribe(t, 0)), 2, 600))).toEqual([0, 2]);
    } finally {
      evictBackend("turso");
      resetTursoConnection();
      if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
      else process.env.TURSO_DATABASE_URL = previousUrl;
      if (previousAuthToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
      else process.env.TURSO_AUTH_TOKEN = previousAuthToken;
      if (previousBackend === undefined) delete process.env.BROKER_BACKEND;
      else process.env.BROKER_BACKEND = previousBackend;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
