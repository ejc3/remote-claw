import type { Client } from "@libsql/client";

// A COLD, durable catalog for per-channel databases. Its row is also the create-once continuity witness:
// once an id is present, a missing physical store is data loss and must never be recreated under the same
// live token. It is written before the first frame, then stays off the per-frame hot path. The ordered,
// paginable shape also supports retention diagnostics without Turso's flat fleet-wide list. It stores only
// public routing metadata (db id + connection url + creation timestamp) — no ciphertext or keys.
//
// Retention walks this catalog in bounded, RESUMABLE batches (a persisted `sweep_cursor`), probing only
// the current batch's own MAX(created_at) for the idle decision. Work happens at sweep time, spread
// across cron runs — never on publish.

const INDEX_DDL = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id          TEXT PRIMARY KEY,
     url         TEXT NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS index_meta (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,
];

const CURSOR_KEY = "sweep_cursor";

/** A libSQL-backed catalog of per-channel databases (id, connection url, created_at) + a sweep cursor. */
export class SessionIndex {
  readonly #client: Client;
  #migrated: Promise<void> | undefined;

  constructor(client: Client) {
    this.#client = client;
  }

  /** Close the underlying libSQL client (e.g. when the catalog db is being dropped). Best-effort. */
  close(): void {
    try {
      this.#client.close();
    } catch {
      /* already closed */
    }
  }

  #ensure(): Promise<void> {
    if (this.#migrated === undefined) {
      this.#migrated = this.#client.batch(INDEX_DDL, "write").then(
        () => undefined,
        (e) => {
          this.#migrated = undefined;
          throw e;
        },
      );
    }
    return this.#migrated;
  }

  /** Commit the create-once continuity witness. Idempotent (a reopened gen re-adds harmlessly). */
  async add(id: string, url: string, createdAt: number): Promise<void> {
    await this.#ensure();
    await this.#client.execute({
      sql: "INSERT OR IGNORE INTO sessions (id, url, created_at) VALUES (?, ?, ?)",
      args: [id, url, createdAt],
    });
  }

  /** Whether this channel database has ever crossed the create-once boundary. The row is durable
   *  prior-existence evidence: a catalogued id whose physical database is missing must fail closed,
   *  never be provisioned again under the same live token. */
  async has(id: string): Promise<boolean> {
    await this.#ensure();
    const r = await this.#client.execute({
      sql: "SELECT 1 FROM sessions WHERE id = ? LIMIT 1",
      args: [id],
    });
    return r.rows[0] !== undefined;
  }

  /** The next page of catalogued dbs after `cursor` (id-ordered, so the cursor is stable + resumable). */
  async batchAfter(cursor: string, limit: number): Promise<Array<{ id: string; url: string }>> {
    await this.#ensure();
    const r = await this.#client.execute({
      sql: "SELECT id, url FROM sessions WHERE id > ? ORDER BY id LIMIT ?",
      args: [cursor, limit],
    });
    return r.rows.map((row) => ({ id: String(row.id), url: String(row.url) }));
  }

  async getCursor(): Promise<string> {
    await this.#ensure();
    const r = await this.#client.execute({
      sql: "SELECT v FROM index_meta WHERE k = ?",
      args: [CURSOR_KEY],
    });
    return r.rows[0] ? String(r.rows[0].v) : "";
  }

  async setCursor(cursor: string): Promise<void> {
    await this.#ensure();
    await this.#client.execute({
      sql: "INSERT INTO index_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      args: [CURSOR_KEY, cursor],
    });
  }
}

function sqliteSweepBatch(): number {
  const n = Number.parseInt(process.env.RC_SQLITE_SWEEP_BATCH ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

export { sqliteSweepBatch };
