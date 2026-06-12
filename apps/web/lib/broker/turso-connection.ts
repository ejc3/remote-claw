import { type Client, createClient } from "@libsql/client";

// Connection + schema for the Turso (libSQL) durable backend. ONE libSQL client per process, cached on
// globalThis for the same reason the backend cache in index.ts is (Next can hand the relay route and the
// stream route SEPARATE module instances; a per-module client would fragment the connection pool and
// re-migrate on HMR). Production reads the env vars; tests inject a `file:`/`:memory:` client directly.

const g = globalThis as unknown as { __rcTursoClient?: Client };

// Per-client "schema is ready" promise — `CREATE TABLE IF NOT EXISTS` is idempotent, but we only want to
// issue it once per client (and share it across concurrent requests). Keyed by client so an injected
// test client migrates independently of the env singleton.
let migrated = new WeakMap<Client, Promise<void>>();

// The single durable log + a tiny channel-state row.
//   channels — one row per token: is it live, and which incarnation (`gen`). `gen` bumps on a
//     publish-after-__close so a recycled token starts fresh (matching LocalBackend's token-freeing,
//     but WITHOUT deleting the durable history — so a buffered replay survives a close).
//   frames   — the append-only log. `id` (global AUTOINCREMENT) is the total order AND the live cursor.
//     `frame` is the verbatim sealed WireFrame JSON (opaque — the broker never decrypts, E2E preserved);
//     token/gen/seq/msg_id/part are the §8 cleartext routing columns the broker already routes on.
//     UNIQUE(token,gen,msg_id,part) makes a re-POST of a deterministic-msg_id frame idempotent; a chunk
//     keeps its own `part` row, and a minimal frame with no msg_id (NULL, distinct in SQLite) always
//     inserts.
const DDL = [
  `CREATE TABLE IF NOT EXISTS channels (
     token       TEXT PRIMARY KEY,
     gen         INTEGER NOT NULL DEFAULT 0,
     closed      INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS frames (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     token       TEXT NOT NULL,
     gen         INTEGER NOT NULL,
     seq         INTEGER,
     msg_id      TEXT,
     part        INTEGER,
     frame       TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     UNIQUE (token, gen, msg_id, part)
   )`,
  `CREATE INDEX IF NOT EXISTS frames_token_gen_id ON frames (token, gen, id)`,
  `CREATE INDEX IF NOT EXISTS frames_token_created_at ON frames (token, created_at)`,
];

/** The env-configured libSQL client singleton. Throws clearly if the URL is missing. */
export function tursoClientFromEnv(): Client {
  if (g.__rcTursoClient === undefined) {
    const url = process.env.TURSO_DATABASE_URL;
    if (url === undefined || url === "") {
      throw new Error("TursoBackend: TURSO_DATABASE_URL is not set");
    }
    // TURSO_AUTH_TOKEN is required for remote libsql://https:// URLs, optional for file:/:memory: (CI).
    const authToken = process.env.TURSO_AUTH_TOKEN;
    g.__rcTursoClient = createClient(
      authToken !== undefined && authToken !== "" ? { url, authToken } : { url },
    );
  }
  return g.__rcTursoClient;
}

/** Create the schema on `client` exactly once per client (idempotent, race-safe via a cached promise). */
export function ensureSchema(client: Client): Promise<void> {
  let p = migrated.get(client);
  if (p === undefined) {
    p = client.batch(DDL, "write").then(
      () => undefined,
      (e) => {
        migrated.delete(client);
        throw e;
      },
    );
    migrated.set(client, p);
  }
  return p;
}

export function resetTursoConnection(client?: Client): void {
  if (client === undefined) {
    migrated = new WeakMap();
  } else {
    migrated.delete(client);
  }

  const cached = g.__rcTursoClient;
  if (cached !== undefined && (client === undefined || cached === client)) {
    try {
      cached.close();
    } catch {
      /* already closed */
    }
    delete g.__rcTursoClient;
  }
}

/** Live-tail poll interval (ms) — libSQL has no server→client push, so subscribe() polls. Default 150
 *  (matches the Temporal backend); env-tunable for the latency/read-load tradeoff. */
export function tursoPollMs(): number {
  const n = Number.parseInt(process.env.TURSO_POLL_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 150;
}
