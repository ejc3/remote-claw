import type { Client } from "@libsql/client";

// A COLD enumeration index for retention at unlimited scale. Turso's list-databases is a flat,
// un-paginated response and exposes no last-activity timestamp, so a fleet-wide "list + probe each db"
// sweep is O(fleet) and can't scale. This index is our own scalable, ordered, paginable catalog of the
// per-channel databases — written ONCE when a channel db is created and deleted when it is dropped, so
// it is NEVER on the hot publish path (no per-frame writes, no write hotspot). It stores ONLY public
// routing metadata (the already-public db id + connection url + a creation timestamp) — no ciphertext,
// no keys — so it preserves the zero-knowledge model.
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

  /** Record a channel's db on create. Idempotent (a reopened gen re-adds harmlessly). */
  async add(id: string, url: string, createdAt: number): Promise<void> {
    await this.#ensure();
    await this.#client.execute({
      sql: "INSERT OR IGNORE INTO sessions (id, url, created_at) VALUES (?, ?, ?)",
      args: [id, url, createdAt],
    });
  }

  /** Forget a channel's db (on drop). */
  async remove(id: string): Promise<void> {
    await this.#ensure();
    await this.#client.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [id] });
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
