import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublishCollisionError } from "../../lib/broker/backend";
import { SessionIndex } from "../../lib/broker/session-index";
import {
  ChannelStorageLossError,
  dbFileName,
  FileDbLocator,
  SqliteMultiBackend,
  SqlitePollFailureError,
} from "../../lib/broker/sqlite-multi";
import { TursoReadinessTimeoutError } from "../../lib/broker/turso-cloud-locator";
import { sseResponse } from "../../lib/http";

// The per-channel SQLite backend must honour the SAME durable-channel contract as the local backend
// (ordering, resumable replay, recent-window, create-or-resume, subscribe-or-null,
// close-frees-token, multi-subscriber fan-out, idempotent dedup), but with ONE database per channel
// token. Run against a REAL libSQL backed by local FILES in a temp dir (no cloud, plain CI). Plus the
// per-channel specifics: physical isolation (one file per token), non-mutating ordinary retention,
// create-once loss detection, and the filename-safety guard against a hostile session id.

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
function presence(
  kind: "session_announce" | "session_terminal",
  sessionId: string,
  msgId = kind === "session_terminal" ? `terminal-${sessionId}` : `ann-${sessionId}`,
): WireFrame {
  return {
    record_kind: kind,
    session_id: sessionId,
    msg_id: msgId,
    part: 0,
  } as WireFrame;
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

function codedError(message: string, code: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

type PollQueryKind = "frames" | "state";
type PollAction =
  | { readonly type: "throw"; readonly error: Error }
  | { readonly type: "wait"; readonly until: Promise<void> }
  | { readonly type: "return"; readonly result: Promise<unknown> };

function pollQueryKind(statement: unknown): PollQueryKind | undefined {
  const sql =
    typeof statement === "object" && statement !== null && "sql" in statement
      ? String((statement as { sql: unknown }).sql)
      : String(statement);
  if (sql.includes("SELECT id, frame FROM frames")) return "frames";
  if (sql.includes("SELECT closed, gen FROM channel")) return "state";
  return undefined;
}

/** Fault only the two ongoing subscribe-poll queries; setup/cursor/index traffic remains real libSQL. */
function interceptPollQueries(
  base: Client,
  actionFor: (kind: PollQueryKind) => PollAction | undefined,
): Client {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "execute") {
        return async (...args: unknown[]) => {
          const kind = pollQueryKind(args[0]);
          const action = kind === undefined ? undefined : actionFor(kind);
          if (action?.type === "throw") throw action.error;
          if (action?.type === "return") return await action.result;
          if (action?.type === "wait") await action.until;
          return (target.execute.bind(target) as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
}

/** Wrap a client so the FIRST frame-poll SELECT throws a transient SERVER_ERROR, then behaves normally. */
function failOnceOnFramePoll(base: Client): Client {
  let failed = false;
  return interceptPollQueries(base, (kind) => {
    if (kind !== "frames" || failed) return undefined;
    failed = true;
    return { type: "throw", error: codedError("temporary server error", "SERVER_ERROR") };
  });
}

/** Wrap a client so an operation throws a "namespace deleted" channel-gone error when `trip(op)` returns
 *  true (the caller owns the one-shot timing via a shared flag), else it behaves normally. Models the
 *  retention sweep / dev dropScope deleting the db under a cached client (issue #111). Intercepts BOTH
 *  `execute` and `transaction`: publish-frame + maxSeq/frameCount go through `transaction()`, while
 *  __close + subscribe polls go through `execute()`. `op` is `"execute:<sql>"` or `"transaction:<mode>"`. */
function channelGoneWhen(base: Client, trip: (op: string) => boolean, code?: string): Client {
  const boom = (): Error => {
    const e = new Error("Namespace ns-test was deleted while processing this request") as Error & {
      code?: string;
    };
    // Optionally ALSO carry a transient libSQL code (e.g. SERVER_ERROR): models a deleted-namespace
    // error that matches BOTH isChannelGoneError (message) and isTransientLibsqlError (code) — the poll
    // path must treat it as channel-gone, not retry it forever (codex review).
    if (code !== undefined) e.code = code;
    return e;
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "execute") {
        return async (...args: unknown[]) => {
          const stmt = args[0];
          const sql =
            typeof stmt === "object" && stmt !== null && "sql" in stmt
              ? String((stmt as { sql: unknown }).sql)
              : String(stmt);
          if (trip(`execute:${sql}`)) throw boom();
          return (target.execute.bind(target) as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      }
      if (prop === "transaction") {
        return async (...args: unknown[]) => {
          if (trip(`transaction:${String(args[0] ?? "")}`)) throw boom();
          return (target.transaction.bind(target) as (...a: unknown[]) => Promise<unknown>)(
            ...args,
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
}

const A = "sess:00000000000000000000000000000000:cse_aaaa";
const B = "sess:00000000000000000000000000000000:cse_bbbb";
const BUS = "bus:presence-v2:00000000000000000000000000000000";
const LEGACY_BUS = "bus:00000000000000000000000000000000";

describe("dbFileName", () => {
  it("is filename-safe for ANY token — a hostile session_id is neutralized (no '/' , no traversal)", () => {
    for (const t of [BUS, A, "sess:00:../../etc/passwd", "sess:00:a/b/c", "sess:00:weird.name"]) {
      const name = dbFileName(t);
      expect(name).toMatch(/^[A-Za-z0-9_-]+\.db$/);
      expect(name.includes("/")).toBe(false);
      expect(name.includes("..")).toBe(false);
    }
  });

  it("is injective — distinct tokens never collide onto one database, even with the same sanitized prefix", () => {
    // `a/b` and `a-b` sanitize to the SAME prefix; the content hash must still keep them distinct.
    const tokens = [A, B, BUS, "sess:00:a/b", "sess:00:a-b", "sess:00:..-b"];
    const names = tokens.map(dbFileName);
    expect(new Set(names).size).toBe(tokens.length);
  });

  it("is deterministic and carries a readable prefix", () => {
    expect(dbFileName(A)).toBe(dbFileName(A));
    expect(dbFileName(A).startsWith("sess-")).toBe(true);
  });
});

describe("SqliteMultiBackend", () => {
  it("publish creates the session's database; subscribe-before-publish returns null and creates nothing", async () => {
    const { be, dir } = mkBackend();
    expect(await be.subscribe(A, undefined)).toBeNull();
    expect(existsSync(join(dir, dbFileName(A)))).toBe(false);

    const r = await be.publish(A, frame(1));
    expect(r.created).toBe(true);
    expect(r.channelId).toBe(join(dir, dbFileName(A)));
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
    const { be, dir } = mkBackend();
    await be.publish(A, frame(1));
    const live = await be.subscribe(A, undefined);
    const drained = drain(live as ReadableStream<WireFrame>);
    const closed = await be.publish(A, { __close: true });
    expect(closed.channelId).toBe(join(dir, dbFileName(A)));
    expect(seqs(await drained)).toEqual([1]); // got the replay, then the close ended it

    // Subscribing to a closed channel is null...
    expect(await be.subscribe(A, undefined)).toBeNull();
    // ...until a publish reopens a fresh incarnation (created=true), visible only in the new gen.
    const r = await be.publish(A, frame(2));
    expect(r.created).toBe(true);
    expect(r.channelId).toBe(join(dir, dbFileName(A)));
    const reopened = await be.subscribe(A, undefined);
    expect(seqs(await take(reopened as ReadableStream<WireFrame>, 1))).toEqual([2]);
  });

  it("a close sentinel on an absent token is a no-op and creates no database", async () => {
    const { be, dir } = mkBackend();
    const r = await be.publish(A, { __close: true });
    expect(r.created).toBe(false);
    expect(r.channelId).toBe(join(dir, dbFileName(A)));
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

  it("accepts only an exact re-POST at the same (msg_id, part)", async () => {
    const { be } = mkBackend();
    await be.publish(A, frame(1, { msg_id: "m1", part: 0 }));
    await be.publish(A, frame(1, { msg_id: "m1", part: 0 })); // exact bytes → idempotent success
    await expect(be.publish(A, frame(9, { msg_id: "m1", part: 0 }))).rejects.toBeInstanceOf(
      PublishCollisionError,
    );
    await be.publish(A, frame(2, { msg_id: "m1", part: 1 })); // different part → inserts
    expect(await be.frameCount(A)).toBe(2);
  });

  it("serializes concurrent first writers: one wins and changed bytes collide", async () => {
    const { be } = mkBackend();
    const coordinate = { msg_id: "concurrent-coordinate", part: 0 };
    const results = await Promise.allSettled([
      be.publish(A, frame(1, coordinate)),
      be.publish(A, frame(2, coordinate)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status !== "rejected") throw new Error("expected one collision");
    expect(rejected.reason).toBeInstanceOf(PublishCollisionError);
    expect(await be.frameCount(A)).toBe(1);

    const stream = await be.subscribe(A, 0);
    const [winner] = await take(stream as ReadableStream<WireFrame>, 1);
    if (winner === undefined) throw new Error("winning frame missing");
    await expect(be.publish(A, winner)).resolves.toMatchObject({ created: false });
  });

  it("atomically appends one terminal fence and suppresses terminal retries and later live", async () => {
    const { be, dir } = mkBackend();
    const sid = "cse_dead";
    await be.publish(BUS, presence("session_announce", sid, `ann-before-${sid}`));
    await be.publish(BUS, presence("session_terminal", sid));
    await be.publish(BUS, presence("session_terminal", sid));
    await be.publish(BUS, presence("session_announce", sid, `ann-replay-${sid}`));

    expect(await be.frameCount(BUS)).toBe(2);
    const stream = await be.subscribe(BUS, 0);
    const frames = await take(stream as ReadableStream<WireFrame>, 2);
    expect(frames.map((item) => item.record_kind)).toEqual([
      "session_announce",
      "session_terminal",
    ]);

    const db = createClient({ url: `file:${join(dir, dbFileName(BUS))}` });
    try {
      const terminals = await db.execute("SELECT session_id FROM presence_terminals");
      expect(terminals.rows.map((row) => String(row.session_id))).toEqual([sid]);
    } finally {
      db.close();
    }
  });

  it("creates a bus from a terminal-first race without ever appending the overtaken live", async () => {
    const { be, dir } = mkBackend();
    const sid = "cse_terminal_first";
    const originalTerminal = presence("session_terminal", sid);
    const first = await be.publish(BUS, originalTerminal);
    const retry = await be.publish(BUS, {
      ...originalTerminal,
      ct: "fresh-aead-ciphertext",
    });
    const late = await be.publish(BUS, presence("session_announce", sid, `ann-overtaken-${sid}`));

    expect([first.created, retry.created, late.created]).toEqual([true, false, false]);
    expect([first.channelId, retry.channelId, late.channelId]).toEqual([
      join(dir, dbFileName(BUS)),
      join(dir, dbFileName(BUS)),
      join(dir, dbFileName(BUS)),
    ]);
    expect(await be.frameCount(BUS)).toBe(1);
    const stream = await be.subscribe(BUS, 0);
    const frames = await take(stream as ReadableStream<WireFrame>, 1);
    expect(frames).toEqual([originalTerminal]);

    // A terminal retry is an operation-level replay, not a byte-idempotent transport retry: resealing
    // changes its ciphertext. The absorbing session_id fence returns success without letting those new
    // bytes replace or append behind the first accepted terminal.
    const db = createClient({ url: `file:${join(dir, dbFileName(BUS))}` });
    try {
      const stored = await db.execute("SELECT frame FROM frames ORDER BY id LIMIT 1");
      expect(String(stored.rows[0]?.frame ?? "")).toBe(JSON.stringify(originalTerminal));
    } finally {
      db.close();
    }
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

  it("preserves an idle session's full history while its live host keeps announcing on the bus", async () => {
    const { be, dir } = mkBackend();
    await be.publish(A, frame(1));
    await be.publish(A, frame(2));

    // Make the transcript unambiguously older than retainMs, then model the still-live host's separate
    // 20s presence traffic. No browser subscriber is open while retention runs.
    const sessionDb = createClient({ url: `file:${join(dir, dbFileName(A))}` });
    try {
      await sessionDb.execute("UPDATE frames SET created_at = 1");
    } finally {
      sessionDb.close();
    }
    await be.publish(BUS, presence("session_announce", "cse_aaaa", "ann-live-1"));
    await be.publish(BUS, presence("session_announce", "cse_aaaa", "ann-live-2"));

    expect(await be.sweep(60_000)).toBe(0);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    // Reopen through a fresh backend instance: this is durable storage, not a stale cached handle.
    const reconnect = new SqliteMultiBackend(new FileDbLocator(dir));
    const later = await reconnect.subscribe(A, undefined);
    expect(seqs(await take(later as ReadableStream<WireFrame>, 2))).toEqual([1, 2]);
  });

  it("never invokes physical drop from ordinary retention, including the ambiguous-delete path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-no-retention-drop-"));
    dirs.push(dir);
    class DropRecordingLocator extends FileDbLocator {
      drops: string[] = [];
      override async dropStored(id: string): Promise<void> {
        this.drops.push(id);
        throw new Error("ambiguous platform delete must be unreachable");
      }
    }
    const locator = new DropRecordingLocator(dir);
    const be = new SqliteMultiBackend(locator);
    await be.publish(A, frame(1));

    await expect(be.sweep(-1)).resolves.toBe(0);
    expect(locator.drops).toEqual([]);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    const later = await be.subscribe(A, undefined);
    expect(seqs(await take(later as ReadableStream<WireFrame>, 1))).toEqual([1]);
  });

  it("preserves all bus frames and the absorbing v2 terminal tombstone", async () => {
    const { be, dir } = mkBackend();
    const sid = "cse_preserved";
    await be.publish(BUS, presence("session_announce", sid));
    await be.publish(BUS, presence("session_terminal", sid));
    await be.publish(A, frame(1));
    await be.publish(LEGACY_BUS, presence("session_announce", "legacy"));

    expect(await be.sweep(-1)).toBe(0);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);
    expect(existsSync(join(dir, dbFileName(LEGACY_BUS)))).toBe(true);
    expect(existsSync(join(dir, dbFileName(BUS)))).toBe(true);
    expect(await be.frameCount(BUS)).toBe(2);

    const db = createClient({ url: `file:${join(dir, dbFileName(BUS))}` });
    try {
      const terminals = await db.execute("SELECT session_id FROM presence_terminals");
      expect(terminals.rows.map((row) => String(row.session_id))).toEqual([sid]);
    } finally {
      db.close();
    }

    // The fence remains absorbing without deleting replay: a late announce cannot resurrect the session.
    await be.publish(BUS, presence("session_announce", sid, `ann-replay-${sid}`));
    expect(await be.frameCount(BUS)).toBe(2);
  });

  it("never drops a v2 bus when sweep races its first publish or a later terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-presence-race-"));
    dirs.push(dir);
    const first = new SqliteMultiBackend(new FileDbLocator(dir));
    const sweeper = new SqliteMultiBackend(new FileDbLocator(dir));
    const firstSid = "cse_first";

    // Ordinary retention is non-mutating, so it cannot overtake either terminal transaction.
    await Promise.all([
      first.publish(BUS, presence("session_terminal", firstSid)),
      sweeper.sweep(-1),
    ]);
    expect(existsSync(join(dir, dbFileName(BUS)))).toBe(true);

    const laterSid = "cse_later";
    await first.publish(BUS, presence("session_announce", laterSid));
    const [terminal] = await Promise.allSettled([
      first.publish(BUS, presence("session_terminal", laterSid)),
      sweeper.sweep(-1),
    ]);
    // Two local backend instances can contend on SQLite's write lock; a real remote libSQL writer
    // serializes them. Model the caller's ordinary retry if the local transaction lost that race.
    if (terminal?.status === "rejected") {
      await first.publish(BUS, presence("session_terminal", laterSid));
    }
    await first.publish(BUS, presence("session_announce", firstSid, `ann-late-${firstSid}`));
    await first.publish(BUS, presence("session_announce", laterSid, `ann-late-${laterSid}`));

    const db = createClient({ url: `file:${join(dir, dbFileName(BUS))}` });
    try {
      const terminals = await db.execute(
        "SELECT session_id FROM presence_terminals ORDER BY session_id",
      );
      expect(terminals.rows.map((row) => String(row.session_id))).toEqual([firstSid, laterSid]);
      const late = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM frames WHERE msg_id IN (?, ?)",
        args: [`ann-late-${firstSid}`, `ann-late-${laterSid}`],
      });
      expect(Number(late.rows[0]?.n ?? 0)).toBe(0);
    } finally {
      db.close();
    }
    expect(existsSync(join(dir, dbFileName(BUS)))).toBe(true);
  });
});

describe("FileDbLocator lock semantics", () => {
  it("opens each channel database in WAL mode (reads run concurrently with the writer, like remote libSQL)", async () => {
    const { be, dir } = mkBackend();
    await be.publish(A, frame(1)); // goes through prepare() on the real create path
    const c = createClient({ url: `file:${join(dir, dbFileName(A))}` });
    try {
      const jm = await c.execute("PRAGMA journal_mode");
      // WAL persists in the db header, so EVERY connection (poll-tail subscribe, sweep probe, this one)
      // gets reader/writer concurrency — no reader↔writer SQLITE_BUSY, matching Turso's MVCC reads.
      expect(String(jm.rows[0]?.journal_mode).toLowerCase()).toBe("wal");
    } finally {
      c.close();
    }
  });

  it("keeps a live-tail subscriber open across one transient poll error (retries, doesn't tear down)", async () => {
    const prevPoll = process.env.RC_SQLITE_POLL_MS;
    process.env.RC_SQLITE_POLL_MS = "10"; // fast retry (read before the backend is constructed)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-transient-"));
    dirs.push(dir);
    try {
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
        failOnceOnFramePoll(createClient(config)),
      );
      await be.publish(A, frame(0));
      const stream = await be.subscribe(A, 1); // start after frame 0; the first frame poll throws once
      const reading = take(stream as ReadableStream<WireFrame>, 2);
      await be.publish(A, frame(1));
      await be.publish(A, frame(2));
      expect(seqs(await reading)).toEqual([1, 2]);
      expect(warn).toHaveBeenCalledWith("[sqlite] transient subscribe poll failed; retrying (1/3)");
    } finally {
      warn.mockRestore();
      if (prevPoll === undefined) delete process.env.RC_SQLITE_POLL_MS;
      else process.env.RC_SQLITE_POLL_MS = prevPoll;
    }
  });

  it("terminates on the third consecutive transient poll failure, evicts the client, and never exposes provider detail", async () => {
    const previousPoll = process.env.RC_SQLITE_POLL_MS;
    process.env.RC_SQLITE_POLL_MS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-poll-budget-"));
    dirs.push(dir);
    const sensitive = "SERVER_ERROR database=rc-secret auth=bearer-secret";
    let armed = false;
    let framePolls = 0;
    let channelClients = 0;
    try {
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) => {
        const base = createClient(config);
        if (!config.url.includes(dbFileName(A))) return base;
        channelClients++;
        return interceptPollQueries(base, (kind) => {
          if (!armed || kind !== "frames") return undefined;
          framePolls++;
          return { type: "throw", error: codedError(sensitive, "SERVER_ERROR") };
        });
      });
      await be.publish(A, frame(0));
      armed = true;
      const stream = await be.subscribe(A, 1);
      expect(stream).not.toBeNull();

      let observed: unknown;
      try {
        await drain(stream as ReadableStream<WireFrame>);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(SqlitePollFailureError);
      expect(observed).toMatchObject({ message: "sqlite: subscription poll failed" });
      expect(String(observed)).not.toContain(sensitive);
      expect(framePolls).toBe(3);
      expect(warn.mock.calls).toEqual([
        ["[sqlite] transient subscribe poll failed; retrying (1/3)"],
        ["[sqlite] transient subscribe poll failed; retrying (2/3)"],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);

      armed = false;
      await expect(be.maxSeq(A)).resolves.toBe(0);
      expect(channelClients).toBe(2); // terminal poll failure evicted; the next operation cold-opened
    } finally {
      warn.mockRestore();
      if (previousPoll === undefined) delete process.env.RC_SQLITE_POLL_MS;
      else process.env.RC_SQLITE_POLL_MS = previousPoll;
    }
  });

  it("shares the transient budget across empty-frame and state queries", async () => {
    const previousPoll = process.env.RC_SQLITE_POLL_MS;
    process.env.RC_SQLITE_POLL_MS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-poll-state-budget-"));
    dirs.push(dir);
    let armed = false;
    let framePolls = 0;
    let statePolls = 0;
    try {
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
        interceptPollQueries(createClient(config), (kind) => {
          if (!armed) return undefined;
          if (kind === "frames") {
            framePolls++;
            return undefined; // successful but empty: only half of a complete poll decision
          }
          statePolls++;
          return {
            type: "throw",
            error: codedError("state endpoint detail must stay private", "SERVER_ERROR"),
          };
        }),
      );
      await be.publish(A, frame(0));
      armed = true;
      const stream = await be.subscribe(A, 1);
      expect(stream).not.toBeNull();
      await expect(drain(stream as ReadableStream<WireFrame>)).rejects.toBeInstanceOf(
        SqlitePollFailureError,
      );
      expect(framePolls).toBe(3);
      expect(statePolls).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      if (previousPoll === undefined) delete process.env.RC_SQLITE_POLL_MS;
      else process.env.RC_SQLITE_POLL_MS = previousPoll;
    }
  });

  it("resets the transient budget only after an empty-frame/state cycle completes", async () => {
    const previousPoll = process.env.RC_SQLITE_POLL_MS;
    process.env.RC_SQLITE_POLL_MS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-poll-cycle-reset-"));
    dirs.push(dir);
    let armed = false;
    let framePolls = 0;
    let statePolls = 0;
    let markCycle!: () => void;
    const cycleReached = new Promise<void>((resolve) => {
      markCycle = resolve;
    });
    let markRowReady!: () => void;
    const rowReady = new Promise<void>((resolve) => {
      markRowReady = resolve;
    });
    try {
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
        interceptPollQueries(createClient(config), (kind) => {
          if (!armed) return undefined;
          if (kind === "state") {
            statePolls++;
            markCycle();
            return undefined;
          }
          framePolls++;
          if ([1, 2, 4, 5].includes(framePolls)) {
            return {
              type: "throw",
              error: codedError("transient cycle fault", "SERVER_ERROR"),
            };
          }
          if (framePolls >= 6) return { type: "wait", until: rowReady };
          return undefined;
        }),
      );
      await be.publish(A, frame(0));
      armed = true;
      const stream = await be.subscribe(A, 1);
      expect(stream).not.toBeNull();
      const reader = (stream as ReadableStream<WireFrame>).getReader();
      const reading = reader.read();
      void reading.catch(() => undefined);
      await cycleReached;
      await be.publish(A, frame(1));
      markRowReady();
      await expect(reading).resolves.toMatchObject({ done: false, value: { seq: 1 } });
      await reader.cancel();
      expect(framePolls).toBeGreaterThanOrEqual(6); // the stream may prefetch one pull before cancel
      expect(statePolls).toBeGreaterThanOrEqual(1);
      expect(warn).toHaveBeenCalledTimes(4); // two strikes on each side of the completed cycle
    } finally {
      warn.mockRestore();
      if (previousPoll === undefined) delete process.env.RC_SQLITE_POLL_MS;
      else process.env.RC_SQLITE_POLL_MS = previousPoll;
    }
  });

  it("resets the transient budget after a row-bearing frame decision", async () => {
    const previousPoll = process.env.RC_SQLITE_POLL_MS;
    process.env.RC_SQLITE_POLL_MS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-poll-row-reset-"));
    dirs.push(dir);
    let armed = false;
    let framePolls = 0;
    try {
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
        interceptPollQueries(createClient(config), (kind) => {
          if (!armed || kind !== "frames") return undefined;
          framePolls++;
          if ([1, 2, 4, 5].includes(framePolls)) {
            return { type: "throw", error: codedError("transient row fault", "SERVER_ERROR") };
          }
          return undefined;
        }),
      );
      await be.publish(A, frame(0));
      armed = true;
      const stream = await be.subscribe(A, 0);
      expect(stream).not.toBeNull();
      const reader = (stream as ReadableStream<WireFrame>).getReader();
      await expect(reader.read()).resolves.toMatchObject({ done: false, value: { seq: 0 } });
      await be.publish(A, frame(1));
      await expect(reader.read()).resolves.toMatchObject({ done: false, value: { seq: 1 } });
      await reader.cancel();
      expect(framePolls).toBeGreaterThanOrEqual(6); // the stream may prefetch one pull before cancel
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
      if (previousPoll === undefined) delete process.env.RC_SQLITE_POLL_MS;
      else process.env.RC_SQLITE_POLL_MS = previousPoll;
    }
  });

  it("bounds a never-settling poll while SSE keepalives continue, observes its late rejection, and evicts", async () => {
    const previousTimeout = process.env.RC_SQLITE_POLL_QUERY_TIMEOUT_MS;
    process.env.RC_SQLITE_POLL_QUERY_TIMEOUT_MS = "30";
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-poll-deadline-"));
    dirs.push(dir);
    const lateSensitive = "late provider rejection database=rc-secret token=secret";
    let rejectLate: ((reason?: unknown) => void) | undefined;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    let armed = false;
    let framePolls = 0;
    let channelClients = 0;
    try {
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) => {
        const base = createClient(config);
        if (!config.url.includes(dbFileName(A))) return base;
        channelClients++;
        return interceptPollQueries(base, (kind) => {
          if (!armed || kind !== "frames") return undefined;
          framePolls++;
          return { type: "return", result: pending };
        });
      });
      await be.publish(A, frame(0));
      armed = true;
      const stream = await be.subscribe(A, 1);
      expect(stream).not.toBeNull();

      const text = await sseResponse(stream as ReadableStream<WireFrame>, 2, 1_000).text();
      expect(text).toContain(": ping\n\n"); // healthy-looking keepalives cannot mask the stuck DB query
      expect(text).toContain('event: error\ndata: "sqlite: subscription poll failed"\n\n');
      expect(text).not.toContain(lateSensitive);
      expect(framePolls).toBe(1);

      // Closing/evicting the timed-out client can settle its driver promise later. The production helper
      // keeps an explicit rejection observer attached, so this does not become an unhandled rejection.
      rejectLate?.(codedError(lateSensitive, "SERVER_ERROR"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      armed = false;
      await expect(be.maxSeq(A)).resolves.toBe(0);
      expect(channelClients).toBe(2);
    } finally {
      if (previousTimeout === undefined) delete process.env.RC_SQLITE_POLL_QUERY_TIMEOUT_MS;
      else process.env.RC_SQLITE_POLL_QUERY_TIMEOUT_MS = previousTimeout;
    }
  });

  it("awaits the locator's awaitReady before use — a failure rejects acquire and is NOT cached (next open is fresh)", async () => {
    // The cloud locator's awaitReady waits out the create→serve 404 window; acquire must await it before
    // caching/using the client, and on failure must close + NOT cache the half-open client so a retry opens
    // a fresh one. Model that with a FileDbLocator whose awaitReady fails once, then succeeds.
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-ready-"));
    dirs.push(dir);
    class FlakyReadyLocator extends FileDbLocator {
      fails = 1;
      async awaitReady(_client: Client, token: string): Promise<void> {
        if (token === A && this.fails > 0) {
          this.fails--;
          throw new Error("endpoint not ready (test)");
        }
      }
    }
    const be = new SqliteMultiBackend(new FlakyReadyLocator(dir));
    // First publish: awaitReady throws → acquire rejects and caches nothing.
    await expect(be.publish(A, frame(1))).rejects.toThrow(/not ready/);
    // Second publish: a FRESH client is opened (the broken one wasn't cached), awaitReady now passes, lands.
    await expect(be.publish(A, frame(1))).resolves.toBeDefined();
    const sub = await be.subscribe(A, undefined);
    expect(sub).not.toBeNull();
    expect(seqs(await take(sub as ReadableStream<WireFrame>, 1))).toEqual([1]);
  });

  it("waits for a cold continuity index and rebuilds a failed readiness client within the first operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-index-ready-"));
    dirs.push(dir);
    const events: string[] = [];
    let indexReadinessCalls = 0;
    let indexClients = 0;
    const indexCloses: number[] = [];

    class ColdIndexLocator extends FileDbLocator {
      async awaitReady(client: Client, token: string): Promise<void> {
        if (token !== "index") return;
        indexReadinessCalls++;
        events.push(`ready:${indexReadinessCalls}`);
        if (indexReadinessCalls === 1) {
          // Model the first catalog endpoint still being inside Turso's create→serve window. The
          // existing bounded #withIndex retry must discard this half-open client and finish the SAME
          // publish with a fresh client; callers must not need a sacrificial warm-up request.
          throw codedError("Namespace cold index doesn't exist (HTTP 404)", "SERVER_ERROR");
        }
        await client.execute("SELECT 1");
        events.push(`ready-ok:${indexReadinessCalls}`);
      }
    }

    const locator = new ColdIndexLocator(dir);
    const be = new SqliteMultiBackend(locator, (config) => {
      const base = createClient(config);
      if (!config.url.endsWith("/_index.db")) return base;
      const ordinal = ++indexClients;
      indexCloses.push(0);
      return new Proxy(base, {
        get(target, prop) {
          if (prop === "batch") {
            return async (...args: unknown[]) => {
              events.push(`index-op:${ordinal}`);
              const batch = target.batch.bind(target) as (...a: unknown[]) => Promise<unknown>;
              return batch(...args);
            };
          }
          if (prop === "close") {
            return () => {
              indexCloses[ordinal - 1] = (indexCloses[ordinal - 1] ?? 0) + 1;
              target.close();
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Client;
    });

    await expect(be.publish(A, frame(1))).resolves.toMatchObject({ created: true });
    expect(indexClients).toBe(2);
    expect(indexCloses[0]).toBe(1);
    expect(events).toEqual(["ready:1", "ready:2", "ready-ok:2", "index-op:2"]);
    await expect(be.maxSeq(A)).resolves.toBe(1);
  });

  it("does not turn a fully exhausted readiness budget into a second internal index wait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-index-ready-timeout-"));
    dirs.push(dir);
    let indexClients = 0;
    let indexReadinessCalls = 0;
    class TimedOutIndexLocator extends FileDbLocator {
      async awaitReady(_client: Client, token: string): Promise<void> {
        if (token === "index") {
          indexReadinessCalls++;
          throw new TursoReadinessTimeoutError(30_000);
        }
      }
    }
    const be = new SqliteMultiBackend(new TimedOutIndexLocator(dir), (config) => {
      if (config.url.endsWith("/_index.db")) indexClients++;
      return createClient(config);
    });

    await expect(be.maxSeq(A)).rejects.toBeInstanceOf(TursoReadinessTimeoutError);
    expect(indexClients).toBe(1);
    expect(indexReadinessCalls).toBe(1);
  });

  it("a reader sees the last committed snapshot while a writer holds an open transaction (no SQLITE_BUSY)", async () => {
    const { dir } = mkBackend();
    const loc = new FileDbLocator(dir);
    const writer = createClient(loc.config(A));
    const reader = createClient(loc.config(A));
    await loc.prepare(writer); // enables WAL (persisted)
    try {
      await writer.execute("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
      await writer.execute("INSERT INTO t (x) VALUES (1)"); // committed
      const tx = await writer.transaction("write");
      await tx.execute("INSERT INTO t (x) VALUES (2)"); // uncommitted; holds the write lock
      // WAL: the reader proceeds against the last committed snapshot instead of blocking/erroring.
      const mid = await reader.execute("SELECT COUNT(*) AS n FROM t");
      expect(Number(mid.rows[0]?.n)).toBe(1);
      await tx.commit();
      tx.close();
      const after = await reader.execute("SELECT COUNT(*) AS n FROM t");
      expect(Number(after.rows[0]?.n)).toBe(2);
    } finally {
      writer.close();
      reader.close();
    }
  });
});

describe("previously-known channel storage loss fails closed", () => {
  const deleteDb = (dir: string, token: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(join(dir, dbFileName(token) + suffix), { force: true });
    }
  };
  const deleteIndex = (dir: string): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(join(dir, `_index.db${suffix}`), { force: true });
    }
  };

  it("finishes a genuinely-new create after a crash left only an uncatalogued empty store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-new-orphan-"));
    dirs.push(dir);
    const locator = new FileDbLocator(dir);
    await locator.ensure(A); // provision happened, but no witness/catalog/frame committed
    expect(existsSync(join(dir, dbFileName(A)))).toBe(true);

    const be = new SqliteMultiBackend(locator);
    await expect(be.subscribe(A, 1)).resolves.toBeNull();
    await expect(be.publish(A, frame(1))).resolves.toMatchObject({ created: true });
    await expect(be.maxSeq(A)).resolves.toBe(1);
  });

  it("cold-process publish, history, seq, inbound cursor, and close all reject a catalogued missing store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-cold-"));
    dirs.push(dir);
    const first = new SqliteMultiBackend(new FileDbLocator(dir));
    await first.publish(A, frame(7));
    await first.publish(A, frame(8));
    expect(await first.maxSeq(A)).toBe(8);
    expect(await first.frameCount(A)).toBe(2);
    deleteDb(dir, A);

    const cold = new SqliteMultiBackend(new FileDbLocator(dir));
    await expect(cold.publish(A, frame(9))).rejects.toBeInstanceOf(ChannelStorageLossError);
    await expect(cold.maxSeq(A)).rejects.toBeInstanceOf(ChannelStorageLossError);
    await expect(cold.frameCount(A)).rejects.toBeInstanceOf(ChannelStorageLossError);
    await expect(cold.subscribe(A, 1)).rejects.toBeInstanceOf(ChannelStorageLossError);
    await expect(cold.publish(A, { __close: true })).rejects.toBeInstanceOf(
      ChannelStorageLossError,
    );
    expect(existsSync(join(dir, dbFileName(A)))).toBe(false); // no operation recreated it
  });

  it("cached publish hard-fails, forgets stale existence, and never retries recreation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-publish-"));
    dirs.push(dir);
    class RecordingLocator extends FileDbLocator {
      forgotten: string[] = [];
      forget(token: string): void {
        this.forgotten.push(token);
      }
    }
    const locator = new RecordingLocator(dir);
    let armed = false;
    const be = new SqliteMultiBackend(locator, (config) =>
      channelGoneWhen(createClient(config), (op) => {
        if (armed && op.startsWith("transaction:write")) {
          armed = false;
          deleteDb(dir, A);
          return true;
        }
        return false;
      }),
    );
    await be.publish(A, frame(0));
    armed = true;
    await expect(be.publish(A, frame(1))).rejects.toBeInstanceOf(ChannelStorageLossError);
    expect(locator.forgotten).toContain(A);
    expect(existsSync(join(dir, dbFileName(A)))).toBe(false);
  });

  it("cached maxSeq and frameCount reject loss instead of resetting outbound/inbound cursors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-meta-"));
    dirs.push(dir);
    let goneToken: string | null = null;
    const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
      channelGoneWhen(createClient(config), (op) => {
        const token = config.url.includes(dbFileName(A)) ? A : B;
        if (goneToken === token && op.startsWith("transaction:read")) {
          goneToken = null;
          deleteDb(dir, token);
          return true;
        }
        return false;
      }),
    );
    await be.publish(A, frame(7));
    await be.publish(B, frame(11));
    goneToken = A;
    await expect(be.maxSeq(A)).rejects.toBeInstanceOf(ChannelStorageLossError);
    goneToken = B;
    await expect(be.frameCount(B)).rejects.toBeInstanceOf(ChannelStorageLossError);
  });

  it("cached subscribe rejects when loss is observed while opening the history cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-open-"));
    dirs.push(dir);
    let armed = false;
    const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
      channelGoneWhen(createClient(config), (op) => {
        if (armed && op.startsWith("execute:SELECT gen, closed")) {
          armed = false;
          deleteDb(dir, A);
          return true;
        }
        return false;
      }),
    );
    await be.publish(A, frame(0));
    armed = true;
    await expect(be.subscribe(A, 1)).rejects.toBeInstanceOf(ChannelStorageLossError);
  });

  it("a mid-stream channel-gone errors instead of clean-closing as an empty durable history", async () => {
    const prevPoll = process.env.RC_SQLITE_POLL_MS;
    process.env.RC_SQLITE_POLL_MS = "10";
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-stream-"));
    dirs.push(dir);
    try {
      let armed = false;
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
        channelGoneWhen(createClient(config), (op) => {
          if (armed && op.startsWith("execute:SELECT id, frame")) {
            armed = false;
            deleteDb(dir, A);
            return true;
          }
          return false;
        }),
      );
      await be.publish(A, frame(0));
      armed = true; // the very next frame poll hits the deleted channel
      const sub = await be.subscribe(A, undefined);
      expect(sub).not.toBeNull();
      await expect(drain(sub as ReadableStream<WireFrame>)).rejects.toBeInstanceOf(
        ChannelStorageLossError,
      );
    } finally {
      if (prevPoll === undefined) delete process.env.RC_SQLITE_POLL_MS;
      else process.env.RC_SQLITE_POLL_MS = prevPoll;
    }
  });

  it("detects an empty replacement at the same physical id from the missing channel witness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-replaced-"));
    dirs.push(dir);
    const first = new SqliteMultiBackend(new FileDbLocator(dir));
    await first.publish(A, frame(4));
    deleteDb(dir, A);

    // Provider/operator recreated the deterministic database name, but its channel/history witness is
    // absent. Physical existence alone must not authorize a fresh empty incarnation.
    const replacement = createClient({ url: `file:${join(dir, dbFileName(A))}` });
    try {
      await replacement.execute("SELECT 1");
    } finally {
      replacement.close();
    }
    const cold = new SqliteMultiBackend(new FileDbLocator(dir));
    await expect(cold.subscribe(A, 0)).rejects.toBeInstanceOf(ChannelStorageLossError);
    await expect(cold.publish(A, frame(5))).rejects.toBeInstanceOf(ChannelStorageLossError);
  });

  it("upgrades a catalogued legacy channel without treating its two-table schema as loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-legacy-upgrade-"));
    dirs.push(dir);
    const locator = new FileDbLocator(dir);
    await locator.ensure(A);

    // Model the schema already deployed before presence_terminals/user_version existed. Its channel row
    // and frames are independent prior-existence evidence, so the v1 migration must preserve both.
    const legacy = createClient(locator.config(A));
    try {
      await legacy.batch(
        [
          `CREATE TABLE channel (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             gen INTEGER NOT NULL DEFAULT 0,
             closed INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL
           )`,
          `CREATE TABLE frames (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             gen INTEGER NOT NULL,
             seq INTEGER,
             msg_id TEXT,
             part INTEGER,
             frame TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             UNIQUE (gen, msg_id, part)
           )`,
        ],
        "write",
      );
      await legacy.execute({
        sql: "INSERT INTO channel (id, gen, closed, created_at) VALUES (1, 0, 0, ?)",
        args: [1],
      });
      await legacy.execute({
        sql: `INSERT INTO frames (gen, seq, msg_id, part, frame, created_at)
              VALUES (0, 6, 'legacy-6', 0, ?, 1)`,
        args: [JSON.stringify(frame(6, { msg_id: "legacy-6", part: 0 }))],
      });
    } finally {
      legacy.close();
    }

    const indexClient = createClient(locator.indexConfig());
    try {
      const index = new SessionIndex(indexClient);
      await index.add(locator.idFor(A), locator.config(A).url, 1);
    } finally {
      indexClient.close();
    }

    const upgraded = new SqliteMultiBackend(locator);
    await expect(upgraded.maxSeq(A)).resolves.toBe(6);
    await expect(upgraded.frameCount(A)).resolves.toBe(1);
    const stream = await upgraded.subscribe(A, 0);
    expect(seqs(await take(stream as ReadableStream<WireFrame>, 1))).toEqual([6]);

    const inspect = createClient(locator.config(A));
    try {
      const terminalTable = await inspect.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'presence_terminals'",
      );
      expect(terminalTable.rows).toHaveLength(1);
    } finally {
      inspect.close();
    }
  });

  it("rebuilds a missing terminal projection from durable frames before accepting a late announce", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-terminal-rebuild-"));
    dirs.push(dir);
    const first = new SqliteMultiBackend(new FileDbLocator(dir));
    const sessionId = "cse_terminal_rebuild";
    await first.publish(BUS, presence("session_terminal", sessionId));
    expect(await first.frameCount(BUS)).toBe(1);

    const damaged = createClient({ url: `file:${join(dir, dbFileName(BUS))}` });
    try {
      await damaged.execute("DROP TABLE presence_terminals");
    } finally {
      damaged.close();
    }

    const recovered = new SqliteMultiBackend(new FileDbLocator(dir));
    await recovered.publish(BUS, presence("session_announce", sessionId, "late-after-rebuild"));
    expect(await recovered.frameCount(BUS)).toBe(1); // late announce stayed suppressed
    const inspect = createClient({ url: `file:${join(dir, dbFileName(BUS))}` });
    try {
      const terminals = await inspect.execute({
        sql: "SELECT session_id FROM presence_terminals WHERE session_id = ?",
        args: [sessionId],
      });
      expect(terminals.rows.map((row) => String(row.session_id))).toEqual([sessionId]);
    } finally {
      inspect.close();
    }
  });

  it("rejects a known store with a missing core table before CREATE IF NOT EXISTS can mask loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-core-"));
    dirs.push(dir);
    const first = new SqliteMultiBackend(new FileDbLocator(dir));
    await first.publish(A, frame(4));
    const damaged = createClient({ url: `file:${join(dir, dbFileName(A))}` });
    try {
      await damaged.execute("DROP TABLE frames");
    } finally {
      damaged.close();
    }

    const cold = new SqliteMultiBackend(new FileDbLocator(dir));
    await expect(cold.maxSeq(A)).rejects.toBeInstanceOf(ChannelStorageLossError);
    await expect(cold.publish(A, frame(5))).rejects.toBeInstanceOf(ChannelStorageLossError);
  });

  it("does not acknowledge a first frame until durable catalog finalization succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-catalog-fail-"));
    dirs.push(dir);
    let failCatalog = true;
    const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) => {
      const base = createClient(config);
      if (!config.url.endsWith("/_index.db")) return base;
      return new Proxy(base, {
        get(target, prop) {
          if (prop === "execute") {
            return async (...args: unknown[]) => {
              const statement = args[0];
              const sql =
                typeof statement === "object" && statement !== null && "sql" in statement
                  ? String((statement as { sql: unknown }).sql)
                  : String(statement);
              if (failCatalog && sql.includes("INSERT OR IGNORE INTO sessions")) {
                failCatalog = false;
                throw new Error("catalog unavailable");
              }
              return (target.execute.bind(target) as (...a: unknown[]) => Promise<unknown>)(
                ...args,
              );
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Client;
    });

    await expect(be.publish(A, frame(1))).rejects.toThrow(/catalog unavailable/);
    const channel = createClient({ url: `file:${join(dir, dbFileName(A))}` });
    try {
      const count = await channel.execute("SELECT COUNT(*) AS n FROM frames");
      expect(Number(count.rows[0]?.n)).toBe(0); // witness committed, frame did not
    } finally {
      channel.close();
    }
    await expect(be.publish(A, frame(1))).resolves.toMatchObject({ created: false });
    await expect(be.maxSeq(A)).resolves.toBe(1);
  });

  it("recatalogues an existing channel witness when only the catalog was lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-index-recover-"));
    dirs.push(dir);
    const first = new SqliteMultiBackend(new FileDbLocator(dir));
    await first.publish(A, frame(1));
    await first.publish(A, frame(2));
    deleteIndex(dir);

    const recovered = new SqliteMultiBackend(new FileDbLocator(dir));
    await expect(recovered.maxSeq(A)).resolves.toBe(2);
    const stream = await recovered.subscribe(A, 0);
    expect(seqs(await take(stream as ReadableStream<WireFrame>, 2))).toEqual([1, 2]);
    expect(existsSync(join(dir, "_index.db"))).toBe(true);
  });

  it("rebuilds a deleted cached catalog during has and recatalogues from the channel witness", async () => {
    const previousMax = process.env.RC_SQLITE_MAX_CLIENTS;
    process.env.RC_SQLITE_MAX_CLIENTS = "1";
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-index-cached-has-"));
    dirs.push(dir);
    let armed = false;
    let indexClients = 0;
    try {
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) => {
        const base = createClient(config);
        if (!config.url.endsWith("/_index.db")) return base;
        indexClients++;
        if (indexClients !== 1) return base;
        return channelGoneWhen(base, (op) => {
          if (armed && op.startsWith("execute:SELECT 1 FROM sessions")) {
            armed = false;
            deleteIndex(dir);
            return true;
          }
          return false;
        });
      });
      await be.publish(A, frame(4));
      await be.publish(B, frame(8)); // maxClients=1 evicts A, while the index client stays cached
      armed = true;

      await expect(be.maxSeq(A)).resolves.toBe(4);
      expect(indexClients).toBe(2);
      const checkClient = createClient({ url: `file:${join(dir, "_index.db")}` });
      try {
        const index = new SessionIndex(checkClient);
        await expect(index.has(new FileDbLocator(dir).idFor(A))).resolves.toBe(true);
      } finally {
        checkClient.close();
      }
    } finally {
      if (previousMax === undefined) delete process.env.RC_SQLITE_MAX_CLIENTS;
      else process.env.RC_SQLITE_MAX_CLIENTS = previousMax;
    }
  });

  it("rebuilds a deleted catalog during add before acknowledging the first frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-index-cached-add-"));
    dirs.push(dir);
    let armed = true;
    let indexClients = 0;
    const locator = new FileDbLocator(dir);
    const be = new SqliteMultiBackend(locator, (config) => {
      const base = createClient(config);
      if (!config.url.endsWith("/_index.db")) return base;
      indexClients++;
      if (indexClients !== 1) return base;
      return channelGoneWhen(base, (op) => {
        if (armed && op.startsWith("execute:INSERT OR IGNORE INTO sessions")) {
          armed = false;
          deleteIndex(dir);
          return true;
        }
        return false;
      });
    });

    await expect(be.publish(A, frame(1))).resolves.toMatchObject({ created: true });
    expect(indexClients).toBe(2);
    await expect(be.frameCount(A)).resolves.toBe(1);
    const indexClient = createClient(locator.indexConfig());
    try {
      const index = new SessionIndex(indexClient);
      await expect(index.has(locator.idFor(A))).resolves.toBe(true);
    } finally {
      indexClient.close();
    }
  });

  it("channel-gone wins over a transient provider code and errors the stream without retrying", async () => {
    const prevPoll = process.env.RC_SQLITE_POLL_MS;
    process.env.RC_SQLITE_POLL_MS = "5";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rc-sqlite-gone-transient-"));
    dirs.push(dir);
    let pollCalls = 0;
    try {
      let armed = false;
      // The deleted-namespace error also carries SERVER_ERROR. If treated as transient this would retry
      // forever; loss must win and error the stream immediately.
      const be = new SqliteMultiBackend(new FileDbLocator(dir), (config) =>
        channelGoneWhen(
          createClient(config),
          (op) => {
            if (!armed || !op.startsWith("execute:SELECT id, frame")) return false;
            pollCalls++;
            return true;
          },
          "SERVER_ERROR",
        ),
      );
      await be.publish(A, frame(0));
      armed = true;
      const sub = await be.subscribe(A, undefined);
      expect(sub).not.toBeNull();
      let observed: unknown;
      try {
        await drain(sub as ReadableStream<WireFrame>);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(ChannelStorageLossError);
      expect(observed).toMatchObject({
        message: "sqlite: previously known channel storage is missing",
      });
      expect(String(observed)).not.toContain("ns-test");
      expect(pollCalls).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (prevPoll === undefined) delete process.env.RC_SQLITE_POLL_MS;
      else process.env.RC_SQLITE_POLL_MS = prevPoll;
    }
  });
});
