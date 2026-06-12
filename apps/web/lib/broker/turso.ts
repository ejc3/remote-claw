import type { Client, ResultSet, Transaction } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { type BrokerBackend, isClose, type PublishResult, type RelayPayload } from "./backend";
import { evictBackend } from "./broker-cache";
import {
  ensureSchema,
  resetTursoConnection,
  tursoClientFromEnv,
  tursoPollMs,
} from "./turso-connection";

const SWEEP_TOKEN_BATCH_SIZE = 100;
const SWEEP_DEADLINE_MS = 250_000;
const writeLocks = new WeakMap<Client, Promise<void>>();

const TRANSIENT_LIBSQL_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_INTERRUPT",
  "SERVER_ERROR",
]);
const CONNECTION_LIBSQL_CODES = new Set([
  "CLIENT_CLOSED",
  "HRANA_CLOSED_ERROR",
  "HRANA_PROTO_ERROR",
  "PROTOCOL_VERSION_ERROR",
]);

type CodedError = { code?: unknown; extendedCode?: unknown; cause?: unknown };

function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const coded = e as CodedError;
  if (typeof coded.code === "string") return coded.code;
  if (typeof coded.extendedCode === "string") return coded.extendedCode;
  return errorCode(coded.cause);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isTransientLibsqlError(e: unknown): boolean {
  const code = errorCode(e);
  if (code !== undefined && TRANSIENT_LIBSQL_CODES.has(code)) return true;
  return /\b(SQLITE_BUSY|SQLITE_LOCKED)\b/.test(errorMessage(e));
}

function isConnectionLevelLibsqlError(client: Client, e: unknown): boolean {
  if (client.closed) return true;
  const code = errorCode(e);
  return code !== undefined && CONNECTION_LIBSQL_CODES.has(code);
}

function evictOnConnectionLevelError(client: Client, e: unknown): void {
  if (!isConnectionLevelLibsqlError(client, e)) return;
  resetTursoConnection(client);
  evictBackend("turso");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitAfterTransientPollError(e: unknown, pollMs: number): Promise<boolean> {
  if (!isTransientLibsqlError(e)) return false;
  console.warn("[turso] transient subscribe poll failed; retrying:", errorMessage(e));
  await sleep(pollMs);
  return true;
}

async function withWriteLock<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(client) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  writeLocks.set(client, next);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(client) === next) writeLocks.delete(client);
  }
}

async function runWriteTransaction<T>(
  client: Client,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withWriteLock(client, async () => {
    const tx = await client.transaction("write");
    let committed = false;
    try {
      const result = await fn(tx);
      await tx.commit();
      committed = true;
      return result;
    } catch (e) {
      if (!committed) {
        try {
          await tx.rollback();
        } catch {
          /* already settled */
        }
      }
      throw e;
    } finally {
      tx.close();
    }
  });
}

// The Turso (libSQL) durable backend — the SINGLE shared, durable log behind the two broker routes,
// selected with BROKER_BACKEND=turso or `?backend=turso`. A channel token addresses one append-only
// `frames` log: the wrapper appends its out-frames and a client appends its in-frames (prompts,
// permission answers) to the SAME log, and both tail it — all via /api/relay + /api/stream (the broker
// mediates; neither side talks to Turso directly, so the wrapper stays a plain broker client). Unlike
// the in-process Local / capped Vercel / Temporal backends, this log is DURABLE + unbounded, so history
// survives a wrapper restart (the basis for retiring the in-memory #log / #36 in a later phase).
//
// E2E: `frame` stores the verbatim sealed WireFrame JSON — the broker never decrypts; the routing
// columns are the §8 cleartext header it already routes on. (Durable at-rest ciphertext is the accepted
// forward-secrecy tradeoff vs the ephemeral backends; a retention sweep is later work.)
//
// subscribe() POLLS (libSQL has no push): it replays history then tails live from the SAME monotonic
// `id` cursor — one query, no replay→live boundary, so a frame is never skipped or re-sent.

export class TursoBackend implements BrokerBackend {
  readonly #client: Client;
  readonly #pollMs = tursoPollMs();

  /** Production uses the env-configured singleton; tests inject a `file:`/`:memory:` client. */
  constructor(client?: Client) {
    this.#client = client ?? tursoClientFromEnv();
  }

  /**
   * Purges whole sessions idle longer than retainMs; never partial-deletes a live session (that would
   * break the viewer's ordered replay).
   */
  async sweep(retainMs: number): Promise<number> {
    const c = this.#client;
    try {
      await ensureSchema(c);

      const cutoff = Date.now() - retainMs;
      const deadline = Date.now() + SWEEP_DEADLINE_MS;
      let total = 0;

      for (;;) {
        if (Date.now() >= deadline) return total;

        const batch = await runWriteTransaction(c, async (tx) => {
          const stale = await tx.execute({
            sql: `SELECT token
                  FROM frames
                  GROUP BY token
                  HAVING MAX(created_at) < ?
                  ORDER BY token
                  LIMIT ?`,
            args: [cutoff, SWEEP_TOKEN_BATCH_SIZE],
          });
          const tokens = stale.rows.map((r) => String(r.token));
          if (tokens.length === 0) {
            return { done: true, swept: 0 };
          }

          const placeholders = tokens.map(() => "?").join(", ");
          // Bounding ciphertext for a still-active long session is a deeper per-log retention policy
          // decision; this sweep only removes fully idle sessions so replay never starts with a gap.
          await tx.execute({
            sql: `DELETE FROM frames WHERE token IN (${placeholders})`,
            args: tokens,
          });
          const deletedChannels = await tx.execute({
            sql: `DELETE FROM channels WHERE token IN (${placeholders})`,
            args: tokens,
          });
          return { done: false, swept: Number(deletedChannels.rowsAffected) };
        });

        total += batch.swept;
        if (batch.done) return total;
      }
    } catch (e) {
      evictOnConnectionLevelError(c, e);
      throw e;
    }
  }

  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    const c = this.#client;
    try {
      await ensureSchema(c);

      if (isClose(payload)) {
        // Mark an EXISTING live channel closed - do NOT delete its rows: a buffered replay must still
        // survive a close, and the history is the whole point of going durable. A later publish reopens a
        // fresh incarnation (gen+1). No-op if the token is absent or already closed.
        await withWriteLock(c, async () => {
          await c.execute({
            sql: "UPDATE channels SET closed = 1 WHERE token = ? AND closed = 0",
            args: [token],
          });
        });
        return { created: false, channelId: token };
      }

      return await this.#publishFrame(token, payload as Partial<WireFrame>);
    } catch (e) {
      evictOnConnectionLevelError(c, e);
      throw e;
    }
  }

  /**
   * Resolve-or-start the channel AND append the frame in ONE write transaction (BEGIN IMMEDIATE -> the
   * write lock serializes against a concurrent publish/__close). Doing both atomically is what makes the
   * frame's gen and its insert consistent: a frame can never land in a gen that a racing __close just
   * closed (which would orphan it - a subscriber reads only the live gen). create if absent, reuse if
   * live, reopen with a bumped `gen` if closed (a recycled token reports created=true and a new
   * subscriber sees only the new incarnation's frames - the LocalBackend close-frees-token contract,
   * kept durable). Because the channel is guaranteed live before the insert, there is no
   * publish-into-disposed race to surface as a 409 (PublishConflictError) the way the Vercel/Temporal
   * cap-roll backends have.
   */
  async #publishFrame(token: string, wire: Partial<WireFrame>): Promise<PublishResult> {
    return runWriteTransaction(this.#client, async (tx) => {
      const stale = await tx.execute({
        sql: "SELECT gen, closed FROM channels WHERE token = ?",
        args: [token],
      });
      const row = stale.rows[0];
      let created: boolean;
      let gen: number;
      if (row === undefined) {
        gen = 0;
        created = true;
        await tx.execute({
          sql: "INSERT INTO channels (token, gen, closed, created_at) VALUES (?, 0, 0, ?)",
          args: [token, Date.now()],
        });
      } else if (Number(row.closed) === 0) {
        gen = Number(row.gen);
        created = false;
      } else {
        gen = Number(row.gen) + 1;
        created = true;
        await tx.execute({
          sql: "UPDATE channels SET gen = ?, closed = 0 WHERE token = ?",
          args: [gen, token],
        });
      }
      await tx.execute({
        // `?? null` (nullish, NOT `||`) preserves a legitimate seq=0 / part=0; only an absent field -> NULL
        // (the minimal test frames). UNIQUE(token,gen,msg_id,part) + ON CONFLICT makes a deterministic-
        // msg_id re-POST idempotent; a NULL msg_id is distinct in SQLite, so a frame without one always
        // inserts.
        sql: `INSERT INTO frames (token, gen, seq, msg_id, part, frame, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (token, gen, msg_id, part) DO NOTHING`,
        args: [
          token,
          gen,
          wire.seq ?? null,
          wire.msg_id ?? null,
          wire.part ?? null,
          JSON.stringify(wire), // the opaque sealed frame - never decrypted here
          Date.now(),
        ],
      });
      return { created, channelId: token };
    });
  }

  /**
   * The highest `seq` in the live channel's current incarnation, or null if the channel is absent/closed
   * or holds no seq-bearing frame yet. MAX(seq) ignores the NULL-seq rows (accepted/meta frames), so it
   * returns the top transcript seq — exactly what a restarting host adds 1 to (#36). `seq` is cleartext,
   * so this never opens a frame. Same absent/closed→null rule as subscribe (a reopened token is a fresh
   * incarnation with no prior frames ⇒ the host restarts at 0).
   */
  async maxSeq(token: string): Promise<number | null> {
    const c = this.#client;
    try {
      await ensureSchema(c);
      const tx = await c.transaction("read");
      try {
        const ch = await tx.execute({
          sql: "SELECT gen, closed FROM channels WHERE token = ?",
          args: [token],
        });
        const meta = ch.rows[0];
        if (meta === undefined || Number(meta.closed) === 1) return null;
        const r = await tx.execute({
          sql: "SELECT MAX(seq) AS m FROM frames WHERE token = ? AND gen = ?",
          args: [token, Number(meta.gen)],
        });
        const m = r.rows[0]?.m;
        return m === null || m === undefined ? null : Number(m);
      } finally {
        tx.close();
      }
    } catch (e) {
      evictOnConnectionLevelError(c, e);
      throw e;
    }
  }

  /**
   * Current live-incarnation stream length in the SAME units as subscribe(startIndex): publish-order
   * frame rows, not transcript seq. This lets a restarted host subscribe from the durable high-water
   * mark and avoid re-consuming old inbound client actions.
   */
  async frameCount(token: string): Promise<number | null> {
    const c = this.#client;
    try {
      await ensureSchema(c);
      const tx = await c.transaction("read");
      try {
        const ch = await tx.execute({
          sql: "SELECT gen, closed FROM channels WHERE token = ?",
          args: [token],
        });
        const meta = ch.rows[0];
        if (meta === undefined || Number(meta.closed) === 1) return null;
        const r = await tx.execute({
          sql: "SELECT COUNT(*) AS n FROM frames WHERE token = ? AND gen = ?",
          args: [token, Number(meta.gen)],
        });
        return Number(r.rows[0]?.n ?? 0);
      } finally {
        tx.close();
      }
    } catch (e) {
      evictOnConnectionLevelError(c, e);
      throw e;
    }
  }

  async subscribe(
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    const c = this.#client;
    try {
      return await this.#subscribeWithClient(c, token, startIndex);
    } catch (e) {
      evictOnConnectionLevelError(c, e);
      throw e;
    }
  }

  async #subscribeWithClient(
    c: Client,
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    await ensureSchema(c);

    // Gen-consistency note for host restart cursors: maxSeq(), frameCount(), and subscribe() are
    // separate reads, but a Turso gen bump requires publish(__close) followed by a later publish. The
    // public /api/relay route accepts only decoded WireFrames and explicitly rejects the internal close
    // sentinel, so no host/viewer request can close+reopen a session channel during the restart resume
    // window. Direct backend callers that use __close are limited to tests/control paths and must not
    // apply an old-gen frameCount as a new-gen subscribe cursor.
    const ch = await c.execute({
      sql: "SELECT gen, closed FROM channels WHERE token = ?",
      args: [token],
    });
    const meta = ch.rows[0];
    // Absent OR closed → null ⇒ the route replies 200-empty (subscribing never creates a channel).
    if (meta === undefined || Number(meta.closed) === 1) return null;
    const gen = Number(meta.gen);

    // Resolve an `id` cursor such that `id > cursor` selects from the requested start. undefined/0 → the
    // whole log (ids start at 1); positive → skip the first N rows of this gen (clamp past-end → head);
    // negative → the last |N| rows.
    let absStart = 0;
    if (startIndex !== undefined) {
      if (startIndex >= 0) {
        absStart = startIndex;
      } else {
        const cnt = await c.execute({
          sql: "SELECT COUNT(*) AS n FROM frames WHERE token = ? AND gen = ?",
          args: [token, gen],
        });
        absStart = Math.max(0, Number(cnt.rows[0]?.n ?? 0) + startIndex);
      }
    }
    let cursor = 0;
    if (absStart > 0) {
      const at = await c.execute({
        sql: "SELECT id FROM frames WHERE token = ? AND gen = ? ORDER BY id LIMIT 1 OFFSET ?",
        args: [token, gen, absStart - 1],
      });
      if (at.rows[0] !== undefined) {
        cursor = Number(at.rows[0].id);
      } else {
        // startIndex past the end → clamp to head: replay nothing, then stream new frames.
        const mx = await c.execute({
          sql: "SELECT COALESCE(MAX(id), 0) AS m FROM frames WHERE token = ? AND gen = ?",
          args: [token, gen],
        });
        cursor = Number(mx.rows[0]?.m ?? 0);
      }
    }

    let stopped = false;
    const pollMs = this.#pollMs;
    return new ReadableStream<WireFrame>({
      pull: async (controller) => {
        while (!stopped) {
          let res: ResultSet;
          try {
            res = await c.execute({
              sql: "SELECT id, frame FROM frames WHERE token = ? AND gen = ? AND id > ? ORDER BY id LIMIT 500",
              args: [token, gen, cursor],
            });
          } catch (e) {
            if (await waitAfterTransientPollError(e, pollMs)) continue;
            evictOnConnectionLevelError(c, e);
            throw e;
          }
          if (stopped) return; // cancelled while the query was in flight
          if (res.rows.length > 0) {
            let lastId = cursor;
            try {
              for (const r of res.rows) {
                controller.enqueue(JSON.parse(r.frame as string) as WireFrame);
                lastId = Number(r.id);
              }
            } catch {
              return; // controller already closed (a racing cancel)
            }
            cursor = lastId;
            return;
          }
          // No new frames for this incarnation. End the stream if the channel was closed or recycled to a
          // newer gen (the buffered replay above has already drained); else wait and poll again.
          let st: ResultSet;
          try {
            st = await c.execute({
              sql: "SELECT closed, gen FROM channels WHERE token = ?",
              args: [token],
            });
          } catch (e) {
            if (await waitAfterTransientPollError(e, pollMs)) continue;
            evictOnConnectionLevelError(c, e);
            throw e;
          }
          const s = st.rows[0];
          if (s === undefined || Number(s.closed) === 1 || Number(s.gen) !== gen) {
            controller.close();
            return;
          }
          await sleep(pollMs);
        }
      },
      cancel: () => {
        stopped = true;
      },
    });
  }
}
