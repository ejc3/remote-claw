import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Client, createClient, type ResultSet, type Transaction } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { type BrokerBackend, isClose, type PublishResult, type RelayPayload } from "./backend";
import { SessionIndex, sqliteSweepBatch } from "./session-index";

// The per-session SQLite (libSQL) durable backend — ONE database per channel token, rather than one
// shared `frames` table for all sessions. Each token addresses its OWN database, so a session's frames
// are physically isolated:
// retention is "drop the file", there is no cross-session write contention (SQLite serializes writes per
// database, so the write lock is per-session, not one global mutex), and a leaked/compromised channel
// can't even see another session's at-rest ciphertext. This is the broker's "dumb per-channel pipe"
// model made physical, and the primary backend for local development (BROKER_BACKEND=sqlite).
//
// Storage is pluggable behind `DbLocator`: the default `FileDbLocator` maps a token to a local file:
// database under RC_SQLITE_DIR. A future Turso-Cloud locator (one remote libSQL database per session via
// the Platform API) would slot in unchanged — the backend logic below is storage-agnostic.
//
// E2E preserved: `frame` stores the verbatim sealed WireFrame JSON; the broker never decrypts. The only
// cleartext columns are the §8 routing fields it already routes on (seq/msg_id/part), minus `token`
// (implicit — it IS the database).

const SWEEP_DEADLINE_MS = 250_000;

const writeLocks = new WeakMap<Client, Promise<void>>();

/** How a libSQL client is opened from a connection config. Defaults to @libsql/client's createClient;
 *  injectable so tests can wrap the client (e.g. fault-inject a transient poll error) and so a future
 *  deployment could supply an instrumented driver. */
export type ClientFactory = typeof createClient;

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

/** Connection-level by error code only (no client handle) — for the index client, which the backend
 *  doesn't hold directly; lets it drop+rebuild a dead index connection instead of stalling retention. */
function isConnLevelLibsqlErrorByCode(e: unknown): boolean {
  const code = errorCode(e);
  return code !== undefined && CONNECTION_LIBSQL_CODES.has(code);
}

/** A "channel gone" error: the per-session database/namespace was deleted out from under a cached client
 *  — the retention sweep dropped it after long idle, or the dev `dropScope` teardown removed it. libSQL
 *  surfaces it as a generic error with NO transient/connection code, so it would otherwise hard-error
 *  (issue #111). The broker treats it as "channel absent": publish recreates + retries once, subscribe
 *  clean-closes, maxSeq/frameCount → null. Message-based (the only signal libSQL gives). */
function isChannelGoneError(e: unknown): boolean {
  const msg = errorMessage(e);
  return (
    /was deleted while processing/i.test(msg) ||
    (/\bnamespace\b/i.test(msg) &&
      /(doesn't exist|does not exist|not found|was deleted)/i.test(msg))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitAfterTransientPollError(e: unknown, pollMs: number): Promise<boolean> {
  if (!isTransientLibsqlError(e)) return false;
  console.warn("[sqlite] transient subscribe poll failed; retrying:", errorMessage(e));
  await sleep(pollMs);
  return true;
}

// Serialize writes against a single per-session client (SQLite is single-writer; a concurrent publish /
// __close on the SAME database would otherwise SQLITE_BUSY). Writes to DIFFERENT sessions use different
// clients and never contend — the whole point of one database per session.
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

// Per-session schema. No `token` column (it IS the database); `channel` is a single row (id = 1) holding
// the live/closed flag and incarnation `gen` (bumps on a publish-after-__close so a recycled token starts
// fresh WITHOUT deleting durable history, matching the shared-log backend). `frames` is the append-only
// log; `id` (AUTOINCREMENT) is the total order AND the live cursor. UNIQUE(gen, msg_id, part) makes a
// deterministic-msg_id re-POST idempotent; a NULL msg_id is distinct in SQLite, so a minimal frame
// without one always inserts.
const DDL = [
  `CREATE TABLE IF NOT EXISTS channel (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     gen         INTEGER NOT NULL DEFAULT 0,
     closed      INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS frames (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     gen         INTEGER NOT NULL,
     seq         INTEGER,
     msg_id      TEXT,
     part        INTEGER,
     frame       TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     UNIQUE (gen, msg_id, part)
   )`,
  `CREATE INDEX IF NOT EXISTS frames_gen_id ON frames (gen, id)`,
  `CREATE INDEX IF NOT EXISTS frames_created_at ON frames (created_at)`,
];

/**
 * A channel token's database filename. A real token (`bus:<hex>` / `sess:<hex>:<session_id>`) is
 * filename-friendly, but the wire layer permits ANY non-control session_id up to 256 chars (hyphens,
 * dots, even `/`), so a pure reversible mapping can't be both traversal-safe and collision-free here.
 * Instead: a readable, sanitized PREFIX (so a directory listing stays human-scannable) plus a short
 * content HASH that guarantees (a) two distinct tokens never collide onto one database — which would
 * leak one session's frames into another — and (b) no path traversal (the output is only `[A-Za-z0-9_-]`
 * and is bounded length). The hash is purely an internal filename detail; the channel token stays the
 * URL-friendly addressing key everywhere else.
 */
export function dbFileName(token: string): string {
  const prefix = token.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  const hash = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24);
  return `${prefix}-${hash}.db`;
}

/**
 * Pluggable storage — the ONLY thing that differs between a local-file deployment and a cloud one.
 * `FileDbLocator` puts one `file:` db per token on local disk; `TursoCloudDbLocator` puts one Turso
 * Cloud db per token (created via the Platform API). The backend engine is identical either way.
 */
export interface DbLocator {
  /** Connection config for the token's database (used to OPEN it; the storage must already exist). */
  config(token: string): { url: string; authToken?: string };
  /** The opaque drop/catalog handle for a token's db (the file path, or the cloud db name). Stable; used
   *  as the dropStored() argument and the session-index primary key. */
  idFor(token: string): string;
  /** Create the token's database if absent (write path). No-op for `file:` (createClient makes it). */
  ensure(token: string): Promise<void>;
  /** Configure a freshly-opened client (e.g. file: sets WAL + busy_timeout so its lock/concurrency
   *  semantics match a remote single-writer libSQL). Optional; omit when the store needs no per-client
   *  setup (remote Turso serializes writes server-side). */
  prepare?(client: Client): Promise<void>;
  /** Block until a freshly-provisioned database is actually serving queries. Turso Cloud has a
   *  create→serve propagation gap — the Platform API POST returns before the new db's libSQL endpoint
   *  resolves, so the first query transiently 404s — so the cloud locator probes the just-opened client
   *  with bounded backoff until it answers. Optional; omit ⇒ no wait (a file: db serves the moment it's
   *  opened). Called once per client open (cache miss), BEFORE the client is cached or used. */
  awaitReady?(client: Client, token: string): Promise<void>;
  /** Whether the token's database already exists. Read paths must NOT create one (subscribe-or-null). */
  exists(token: string): Promise<boolean>;
  /** Forget any cached "this db exists" memo for the token, so the NEXT `ensure()` actually re-checks /
   *  re-provisions the store. Called when a cached client hit a deleted-db (channel-gone) error: the cloud
   *  locator's positive existence cache is TTL'd and per-process, so after a CROSS-instance retention
   *  delete it can be stale — `ensure()` would then no-op and the recreate wouldn't really happen (issue
   *  #111 / codex review). Optional; omit for locators with no such cache (`file:` recreates on open). */
  forget?(token: string): void;
  /** Delete a stored database by its `id` (from idFor / the session index), reclaiming its space. */
  dropStored?(id: string): Promise<void>;

  // --- Retention via a COLD session index (both file and cloud — written once on create, walked in
  //     resumable batches by the sweep; omit indexConfig ⇒ retention is a no-op). ---
  /** Connection config for the shared catalog db that the SessionIndex lives in. */
  indexConfig?(): { url: string; authToken?: string };
  /** Provision the catalog db if needed (cloud: Platform-API create the `rc-<scope>-index` db; file: no-op). */
  ensureIndex?(): Promise<void>;

  // --- Ephemeral one-time-handoff store (one small table, SEPARATE from session frames; see
  //     docs/ephemeral-handoff.md). Omit ⇒ the handoff feature is unavailable on this locator. ---
  /** Connection config for the dedicated handoff store db (cloud: `rc-<scope>-hx`; file: `_handoff.db`). */
  handoffConfig?(): { url: string; authToken?: string };
  /** Provision the handoff db if needed (cloud: Platform-API create `rc-<scope>-hx`; file: no-op). */
  ensureHandoff?(): Promise<void>;

  /** The auth token a retention probe uses to connect a catalogued db by its url (cloud: the group token). */
  probeAuthToken?(): string | undefined;
  /** Drop the cold-index catalog db ITSELF (after its sessions are reclaimed), so a short-lived scope
   *  doesn't leave an empty index db behind. Used by the dev/CI cleanup; omit ⇒ no-op. */
  dropIndex?(): Promise<void>;
  /** Delete EVERY db in this locator's scope by name (cataloged or not) — the dev/CI cleanup primitive
   *  that also reclaims uncatalogued orphans the index sweep misses. Returns this pass's `deleted` count
   *  and the `remaining` count re-listed after (nonzero ⇒ a live relay recreated one ⇒ loop). Cloud-only;
   *  omit ⇒ the caller falls back to the index sweep. */
  dropScope?(): Promise<{ deleted: number; remaining: number }>;
}

function sqliteDir(): string {
  const d = process.env.RC_SQLITE_DIR;
  return d !== undefined && d.trim() !== "" ? d : join(process.cwd(), ".rc-sqlite");
}

/** Default storage: one local `file:` database per token under a directory (RC_SQLITE_DIR). */
export class FileDbLocator implements DbLocator {
  readonly #dir: string;

  constructor(dir: string = sqliteDir()) {
    // A file: database on Vercel writes to an EPHEMERAL, per-instance disk — frames vanish between
    // invocations and two instances see different data. Fail closed with guidance rather than silently
    // lose a "durable" session. (A future Turso-Cloud locator is the durable per-session prod story.)
    if (process.env.VERCEL === "1" && (process.env.RC_SQLITE_DIR ?? "") === "") {
      throw new Error(
        "FileDbLocator: file-mode per-session sqlite is not durable on Vercel (ephemeral, per-instance " +
          "filesystem). Configure a durable per-session store, or set RC_SQLITE_DIR to acknowledge an " +
          "ephemeral location.",
      );
    }
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  #path(token: string): string {
    return join(this.#dir, dbFileName(token));
  }

  config(token: string): { url: string } {
    return { url: `file:${this.#path(token)}` };
  }

  idFor(token: string): string {
    return this.#path(token);
  }

  // No-op: opening a `file:` URL creates the database file, so there is nothing to pre-provision.
  async ensure(_token: string): Promise<void> {}

  // Align local-file lock semantics with a remote single-writer libSQL so concurrency has the SAME SHAPE
  // in dev and prod. WAL lets readers (the poll-tail subscribe, the sweep probe) proceed concurrently
  // with the writer instead of hitting reader↔writer SQLITE_BUSY — matching Turso's MVCC-style reads.
  // WRITE serialization is structural, not a busy_timeout: the cache opens exactly ONE writer connection
  // per session token (create-lock + per-client write-lock), so two writers to one file never race —
  // the same one-writer-per-session shape cloud has (one client per token + server-side single-writer).
  // (@libsql/client does not honour a PRAGMA busy_timeout for transaction lock waits, so we don't rely
  // on one; the single-writer invariant is what guarantees writes serialize rather than fail.)
  async prepare(client: Client): Promise<void> {
    await client.execute("PRAGMA journal_mode = WAL");
  }

  async exists(token: string): Promise<boolean> {
    return existsSync(this.#path(token));
  }

  // The cold session-index catalog db lives alongside the session dbs (`_index.db`). It can't collide
  // with a session file (those are `<token>-<24 hex>.db`) and is never catalogued/swept itself, so the
  // index walks only real sessions. createClient auto-creates the file, so there's no ensureIndex.
  indexConfig(): { url: string } {
    return { url: `file:${join(this.#dir, "_index.db")}` };
  }

  // The handoff store lives alongside the session dbs (`_handoff.db`). createClient auto-creates the file,
  // so there is no ensureHandoff. Local/dev only — single-instance.
  handoffConfig(): { url: string } {
    // HARD-FAIL on Vercel regardless of RC_SQLITE_DIR: a `file:` handoff store is per-instance, so a PUT
    // and its claim would land on different instances and never match. The handoff REQUIRES a shared cloud
    // db (TursoCloudDbLocator's `rc-<scope>-hx`); fail closed rather than silently break cross-instance.
    if (process.env.VERCEL === "1") {
      throw new Error(
        "FileDbLocator: the one-time-handoff store needs a cloud (Turso) backend on Vercel — a file: db is " +
          "per-instance, so a PUT and its claim would miss. Configure TURSO_API_TOKEN/ORG/GROUP/GROUP_AUTH_TOKEN.",
      );
    }
    return { url: `file:${join(this.#dir, "_handoff.db")}` };
  }

  async dropStored(path: string): Promise<void> {
    // Remove the database and any SQLite sidecars (WAL/SHM/rollback journal). Best-effort.
    for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  /** Drop the `_index.db` catalog (and its sidecars). Mirror of the cloud locator's dropIndex. */
  async dropIndex(): Promise<void> {
    await this.dropStored(join(this.#dir, "_index.db"));
  }
}

function sqliteMaxClients(): number {
  const n = Number.parseInt(process.env.RC_SQLITE_MAX_CLIENTS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 256;
}

function sqlitePollMs(): number {
  const n = Number.parseInt(process.env.RC_SQLITE_POLL_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

/** A borrowed per-session client; the borrower MUST call release() exactly once when done. */
interface Lease {
  readonly client: Client;
  release(): void;
}

interface CacheEntry {
  client: Client;
  refs: number;
  url: string; // the connection url (e.g. `file:<path>`) — lets the sweep evict by store path
}

// A bounded, ref-counted LRU of per-session libSQL clients. Opening one client per session and caching
// it (a) reuses the connection across a session's publish/subscribe/maxSeq calls and (b) bounds the
// number of open handles on a busy deployment. A client with an active subscribe (refs > 0) is never
// evicted; eviction only closes IDLE clients, and when all are busy we briefly exceed the cap rather
// than close a connection out from under a live stream.
class SessionDbCache {
  readonly #locator: DbLocator;
  readonly #max: number;
  // Insertion order approximates LRU; reuse deletes+re-sets to bump an entry to most-recent.
  readonly #entries = new Map<string, CacheEntry>();
  readonly #migrated = new WeakMap<Client, Promise<void>>();
  // Per-token mutex for the miss→create critical section (so only one client per token is opened).
  readonly #createLocks = new Map<string, Promise<void>>();
  readonly #newClient: ClientFactory;

  constructor(
    locator: DbLocator,
    max: number = sqliteMaxClients(),
    newClient: ClientFactory = createClient,
  ) {
    this.#locator = locator;
    this.#max = max;
    this.#newClient = newClient;
  }

  #ensureSchema(client: Client): Promise<void> {
    let p = this.#migrated.get(client);
    if (p === undefined) {
      p = client.batch(DDL, "write").then(
        () => undefined,
        (e) => {
          this.#migrated.delete(client);
          throw e;
        },
      );
      this.#migrated.set(client, p);
    }
    return p;
  }

  /** Borrow the token's client. `create:false` returns null if the database doesn't exist yet. */
  async acquire(token: string, create: boolean): Promise<Lease | null> {
    const hit = this.#entries.get(token);
    if (hit !== undefined) return this.#lease(token, hit);

    // Miss: serialize the create section per token so concurrent first-touches coalesce onto ONE client
    // — multiple clients to the same database would race (SQLITE_BUSY for file:, wasted connections for
    // cloud). The locator's exists()/ensure() awaits also live here, so they can't interleave two opens.
    //
    // This lock is PER PROCESS (= per serverless instance). It fully coalesces concurrent requests within
    // one instance (incl. Fluid Compute's per-instance concurrency). It does NOT span instances — and
    // doesn't need to: file: mode (the SQLITE_BUSY reason) is single-instance only, and cloud mode is
    // safe across instances because ensure() is idempotent (create-if-absent) and a libSQL database is
    // single-writer, so concurrent write transactions are serialized server-side.
    return this.#withCreateLock(token, async () => {
      const again = this.#entries.get(token);
      if (again !== undefined) return this.#lease(token, again); // created while we waited for the lock
      if (create) {
        await this.#locator.ensure(token); // provision the storage (file: no-op; cloud: Platform API)
      } else if (!(await this.#locator.exists(token))) {
        return null; // read path: never create a channel
      }
      const cfg = this.#locator.config(token);
      const client = this.#newClient(cfg);
      try {
        // Cloud: wait out the create→serve propagation window (a brand-new db's endpoint briefly 404s)
        // BEFORE caching the client, so every downstream query (the schema batch, the channel SELECTs)
        // hits a serving endpoint. No-op for file:. Close the client on failure so we never cache (or
        // leak) a half-open one.
        await this.#locator.awaitReady?.(client, token);
        await this.#locator.prepare?.(client); // file: WAL; cloud: server serializes writes
      } catch (e) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
        throw e;
      }
      const entry: CacheEntry = { client, refs: 0, url: cfg.url };
      this.#entries.set(token, entry);
      return this.#lease(token, entry);
    });
  }

  /** Bump the entry to MRU, take a ref, ensure its schema, and hand back a single-release lease. */
  async #lease(token: string, entry: CacheEntry): Promise<Lease> {
    this.#entries.delete(token);
    this.#entries.set(token, entry); // bump to MRU
    entry.refs += 1;
    // EVERY borrow awaits the migration — it's an idempotent, per-client cached promise, so a borrow that
    // hit a still-migrating client cannot run SQL against a schemaless database. refs > 0 here, so the
    // entry can't be evicted out from under the await.
    try {
      await this.#ensureSchema(entry.client);
    } catch (e) {
      entry.refs -= 1;
      if (entry.refs <= 0 && this.#entries.get(token) === entry) {
        this.#entries.delete(token);
        try {
          entry.client.close();
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
    let released = false;
    this.#evict();
    return {
      client: entry.client,
      release: () => {
        if (released) return;
        released = true;
        entry.refs -= 1;
        this.#evict();
      },
    };
  }

  /** A per-token async mutex — serializes the miss→create critical section (a promise chain per key). */
  async #withCreateLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#createLocks.get(token) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = previous.catch(() => undefined).then(() => gate);
    this.#createLocks.set(token, mine);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.#createLocks.get(token) === mine) this.#createLocks.delete(token);
    }
  }

  async runWrite<T>(token: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const lease = await this.acquire(token, true);
    // create:true never returns null.
    if (lease === null) throw new Error("sqlite: failed to open session database");
    try {
      return await fn(lease.client);
    } finally {
      lease.release();
    }
  }

  async runReadOrNull<T>(token: string, fn: (c: Client) => Promise<T>): Promise<T | null> {
    const lease = await this.acquire(token, false);
    if (lease === null) return null;
    try {
      return await fn(lease.client);
    } finally {
      lease.release();
    }
  }

  /**
   * On a connection-level error the client is already broken, so drop it from the cache (the next
   * acquire reopens a fresh one) and close it. We detach the entry even if a lease still holds it: that
   * outstanding lease's later release() decrements the now-detached entry (harmless — it is no longer in
   * the map, so #evict()/activeTokens() never see it) while NEW acquires get a healthy client. The
   * per-client write lock is dropped too so its Promise can't pile up across rapid reconnects.
   */
  evictClient(token: string, client: Client): void {
    const entry = this.#entries.get(token);
    if (entry !== undefined && entry.client === client) {
      this.#entries.delete(token);
    }
    writeLocks.delete(client);
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }

  /** Tokens with a live borrow (refs > 0) — the retention sweep must not drop these. */
  activeTokens(): string[] {
    const out: string[] = [];
    for (const [token, entry] of this.#entries) if (entry.refs > 0) out.push(token);
    return out;
  }

  /**
   * Evict the IDLE cached client for a connection url, so the retention sweep can drop its db without a
   * stale client (open on the unlinked file) surviving in the cache and serving the next access. Returns
   * "busy" if a live borrow holds it — the caller must NOT drop the db then (it raced into use) — else
   * "evicted" (closed + removed) or "absent" (nothing cached). Closing the dropped-then-evicted handle
   * also re-checks the refs at drop time, closing the activeTokens()-snapshot TOCTOU.
   */
  evictByUrl(url: string): "evicted" | "busy" | "absent" {
    for (const [token, entry] of this.#entries) {
      if (entry.url !== url) continue;
      if (entry.refs > 0) return "busy";
      this.#entries.delete(token);
      writeLocks.delete(entry.client);
      try {
        entry.client.close();
      } catch {
        /* already closed */
      }
      return "evicted";
    }
    return "absent";
  }

  #evict(): void {
    while (this.#entries.size > this.#max) {
      let removed = false;
      for (const [token, entry] of this.#entries) {
        if (entry.refs === 0) {
          this.#entries.delete(token);
          try {
            entry.client.close();
          } catch {
            /* already closed */
          }
          removed = true;
          break;
        }
      }
      if (!removed) break; // every client is in use — exceed the cap rather than break a live stream
    }
  }
}

export class SqliteMultiBackend implements BrokerBackend {
  readonly #locator: DbLocator;
  readonly #cache: SessionDbCache;
  readonly #newClient: ClientFactory;
  readonly #pollMs = sqlitePollMs();
  // The cold session index (retention strategy B), built lazily from the locator's indexConfig. undefined
  // = not yet built; the promise resolves to null when the locator has no index (→ dir-scan retention).
  #indexBuild: Promise<SessionIndex | null> | undefined;

  /** Production/dev uses the env-configured FileDbLocator; tests inject a tmp-dir locator (and may inject
   *  a client factory to fault-test the connection). */
  constructor(locator: DbLocator = new FileDbLocator(), newClient: ClientFactory = createClient) {
    this.#locator = locator;
    this.#newClient = newClient;
    this.#cache = new SessionDbCache(locator, sqliteMaxClients(), newClient);
  }

  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    if (isClose(payload)) {
      // Mark an EXISTING live channel closed — never delete its rows (a buffered replay must survive a
      // close; the durable history is the point). A later publish reopens a fresh incarnation (gen+1).
      // No-op (and DON'T create a database) if the token is absent or already closed.
      try {
        const res = await this.#cache.runReadOrNull(token, (c) =>
          this.#withConnErrorEvict(token, c, async () => {
            await withWriteLock(c, async () => {
              await c.execute("UPDATE channel SET closed = 1 WHERE id = 1 AND closed = 0");
            });
            return { created: false, channelId: token } satisfies PublishResult;
          }),
        );
        return res ?? { created: false, channelId: token };
      } catch (e) {
        // The db was deleted out from under us — there's nothing to close (issue #111). The dead client
        // was already evicted by #withConnErrorEvict; treat the close as a no-op.
        if (isChannelGoneError(e)) return { created: false, channelId: token };
        throw e;
      }
    }
    const result = await this.#publishFrameRecreating(token, payload as Partial<WireFrame>);
    // Catalog the db in the cold index — only on CREATE (once per session/incarnation), so this never
    // touches the index on the per-frame hot path. Best-effort: the frame is already durable, so an index
    // hiccup must not fail the publish (the worst case is one un-catalogued session escaping retention).
    if (result.created) await this.#recordInIndex(token);
    return result;
  }

  /** Append a frame, transparently RECREATING the db if it was deleted under us (issue #111). The first
   *  attempt's #withConnErrorEvict drops the dead client on a channel-gone error; the retry's runWrite
   *  re-acquires with create:true → the locator re-ensure()s a fresh db and the frame lands (created=true,
   *  a new incarnation). ONE retry only — a second channel-gone is a real failure and propagates. */
  async #publishFrameRecreating(token: string, wire: Partial<WireFrame>): Promise<PublishResult> {
    try {
      return await this.#cache.runWrite(token, (c) =>
        this.#withConnErrorEvict(token, c, () => this.#publishFrame(token, c, wire)),
      );
    } catch (e) {
      if (!isChannelGoneError(e)) throw e;
      console.warn(
        "[sqlite] channel gone on publish; recreating db and retrying once:",
        errorMessage(e),
      );
      return await this.#cache.runWrite(token, (c) =>
        this.#withConnErrorEvict(token, c, () => this.#publishFrame(token, c, wire)),
      );
    }
  }

  async #recordInIndex(token: string): Promise<void> {
    try {
      const index = await this.#getIndex();
      if (index === null) return;
      await index.add(this.#locator.idFor(token), this.#locator.config(token).url, Date.now());
    } catch (e) {
      // Best-effort: the frame is already durable, so an index hiccup must not fail the publish. But if
      // the index CONNECTION died, drop the cached build so the next call reconnects (else every later
      // catalog + the sweep would reuse a dead client and retention would stall).
      if (isConnLevelLibsqlErrorByCode(e)) this.#indexBuild = undefined;
      console.warn("[sqlite] failed to catalog session in the retention index:", errorMessage(e));
    }
  }

  /** Lazily build the cold SessionIndex from the locator's indexConfig (null if the locator has none). */
  #getIndex(): Promise<SessionIndex | null> {
    if (this.#indexBuild === undefined) {
      this.#indexBuild = (async () => {
        const cfg = this.#locator.indexConfig?.();
        if (cfg === undefined) return null;
        await this.#locator.ensureIndex?.();
        const client = this.#newClient(cfg);
        await this.#locator.prepare?.(client);
        return new SessionIndex(client);
      })().catch((e) => {
        this.#indexBuild = undefined; // let a later call retry the build
        throw e;
      });
    }
    return this.#indexBuild;
  }

  /**
   * Resolve-or-start the channel AND append the frame in ONE write transaction, so the frame's `gen`
   * and its insert are consistent (a frame can never land in a gen a racing __close just closed).
   * create if absent, reuse if live, reopen with a bumped `gen` if closed (a recycled token reports
   * created=true and a new subscriber sees only the new incarnation's frames).
   */
  async #publishFrame(
    token: string,
    client: Client,
    wire: Partial<WireFrame>,
  ): Promise<PublishResult> {
    return runWriteTransaction(client, async (tx) => {
      const cur = await tx.execute("SELECT gen, closed FROM channel WHERE id = 1");
      const row = cur.rows[0];
      let created: boolean;
      let gen: number;
      if (row === undefined) {
        gen = 0;
        created = true;
        await tx.execute({
          sql: "INSERT INTO channel (id, gen, closed, created_at) VALUES (1, 0, 0, ?)",
          args: [Date.now()],
        });
      } else if (Number(row.closed) === 0) {
        gen = Number(row.gen);
        created = false;
      } else {
        gen = Number(row.gen) + 1;
        created = true;
        await tx.execute({
          sql: "UPDATE channel SET gen = ?, closed = 0 WHERE id = 1",
          args: [gen],
        });
      }
      await tx.execute({
        // `?? null` (nullish, NOT `||`) preserves a legitimate seq=0 / part=0; only an absent field → NULL.
        sql: `INSERT INTO frames (gen, seq, msg_id, part, frame, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (gen, msg_id, part) DO NOTHING`,
        args: [
          gen,
          wire.seq ?? null,
          wire.msg_id ?? null,
          wire.part ?? null,
          JSON.stringify(wire), // the opaque sealed frame — never decrypted here
          Date.now(),
        ],
      });
      return { created, channelId: token };
    });
  }

  async maxSeq(token: string): Promise<number | null> {
    try {
      return await this.#cache.runReadOrNull(token, (c) =>
        this.#withConnErrorEvict(token, c, async () => {
          const tx = await c.transaction("read");
          try {
            const ch = await tx.execute("SELECT gen, closed FROM channel WHERE id = 1");
            const meta = ch.rows[0];
            if (meta === undefined || Number(meta.closed) === 1) return null;
            const r = await tx.execute({
              sql: "SELECT MAX(seq) AS m FROM frames WHERE gen = ?",
              args: [Number(meta.gen)],
            });
            const m = r.rows[0]?.m;
            return m === null || m === undefined ? null : Number(m);
          } finally {
            tx.close();
          }
        }),
      );
    } catch (e) {
      // The db was deleted under us — the channel is absent, so report no max seq (the host resumes at
      // seq 0 on the recreated db, same as a never-seen channel) (issue #111).
      if (isChannelGoneError(e)) return null;
      throw e;
    }
  }

  async frameCount(token: string): Promise<number | null> {
    try {
      return await this.#cache.runReadOrNull(token, (c) =>
        this.#withConnErrorEvict(token, c, async () => {
          const tx = await c.transaction("read");
          try {
            const ch = await tx.execute("SELECT gen, closed FROM channel WHERE id = 1");
            const meta = ch.rows[0];
            if (meta === undefined || Number(meta.closed) === 1) return null;
            const r = await tx.execute({
              sql: "SELECT COUNT(*) AS n FROM frames WHERE gen = ?",
              args: [Number(meta.gen)],
            });
            return Number(r.rows[0]?.n ?? 0);
          } finally {
            tx.close();
          }
        }),
      );
    } catch (e) {
      if (isChannelGoneError(e)) return null; // channel absent (deleted) ⇒ startIndex 0 (issue #111)
      throw e;
    }
  }

  async subscribe(
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    const lease = await this.#cache.acquire(token, false);
    if (lease === null) return null; // subscribing never creates a channel
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      lease.release();
    };
    const c = lease.client;
    try {
      const ch = await c.execute("SELECT gen, closed FROM channel WHERE id = 1");
      const meta = ch.rows[0];
      // Absent OR closed → null ⇒ the route replies 200-empty (subscribing never creates a channel).
      if (meta === undefined || Number(meta.closed) === 1) {
        release();
        return null;
      }
      // Pin gen for the stream's whole life. A concurrent close+reopen may bump it after this read, but
      // we only ever query THIS gen, and the poll loop below ends the stream when it sees gen change —
      // so a subscriber is cleanly isolated to the incarnation it joined.
      const gen = Number(meta.gen);
      const cursor = await this.#resolveCursor(c, gen, startIndex);

      // The stream holds its client lease until a terminal path (cancel / channel-close / error) calls
      // release(). The normal consumer (sseResponse) cancels in a finally; a stream abandoned without
      // cancel keeps its lease until GC — the same accepted tradeoff the other backends carry. The
      // bounded client LRU plus the route's maxDuration cap keep that from growing unbounded.
      let stopped = false;
      const pollMs = this.#pollMs;
      let pos = cursor;
      return new ReadableStream<WireFrame>({
        pull: async (controller) => {
          while (!stopped) {
            let res: ResultSet;
            try {
              res = await c.execute({
                sql: "SELECT id, frame FROM frames WHERE gen = ? AND id > ? ORDER BY id LIMIT 500",
                args: [gen, pos],
              });
            } catch (e) {
              if (await waitAfterTransientPollError(e, pollMs)) continue;
              if (isConnectionLevelLibsqlError(c, e) || isChannelGoneError(e))
                this.#cache.evictClient(token, c);
              if (isChannelGoneError(e)) {
                // The db was deleted mid-stream — end the stream cleanly, like a closed channel. A
                // reconnect re-subscribes (to a recreated db once a publish lands) (issue #111).
                controller.close();
                release();
                return;
              }
              release();
              throw e;
            }
            if (stopped) return; // cancelled while the query was in flight (cancel() released)
            if (res.rows.length > 0) {
              let lastId = pos;
              try {
                for (const r of res.rows) {
                  controller.enqueue(JSON.parse(r.frame as string) as WireFrame);
                  lastId = Number(r.id);
                }
              } catch {
                release();
                return; // controller already closed (a racing cancel)
              }
              pos = lastId;
              return;
            }
            // No new frames: end the stream if the channel closed or recycled to a newer gen (the
            // buffered replay has drained); else wait and poll again.
            let st: ResultSet;
            try {
              st = await c.execute("SELECT closed, gen FROM channel WHERE id = 1");
            } catch (e) {
              if (await waitAfterTransientPollError(e, pollMs)) continue;
              if (isConnectionLevelLibsqlError(c, e) || isChannelGoneError(e))
                this.#cache.evictClient(token, c);
              if (isChannelGoneError(e)) {
                // db deleted while polling for close/recycle → end the stream like a closed channel.
                controller.close();
                release();
                return;
              }
              release();
              throw e;
            }
            const s = st.rows[0];
            if (s === undefined || Number(s.closed) === 1 || Number(s.gen) !== gen) {
              controller.close();
              release();
              return;
            }
            await sleep(pollMs);
          }
        },
        cancel: () => {
          stopped = true;
          release();
        },
      });
    } catch (e) {
      if (isConnectionLevelLibsqlError(c, e) || isChannelGoneError(e))
        this.#cache.evictClient(token, c);
      release();
      // The db was deleted before the stream opened → treat as channel-absent: null ⇒ 200-empty, and a
      // reconnect re-subscribes once a publish recreates it (issue #111).
      if (isChannelGoneError(e)) return null;
      throw e;
    }
  }

  /**
   * Resolve an `id` cursor such that `id > cursor` selects from the requested start. undefined/0 → the
   * whole log (ids start at 1); positive → skip the first N rows of this gen (clamp past-end → head);
   * negative → the last |N| rows.
   *
   * The COUNT and the OFFSET run in ONE read transaction so a concurrent publish can't shift the count
   * between them and skew the cursor. The OFFSET→id step assumes frame ids within a gen are CONTIGUOUS;
   * that holds because the log is append-only and a session is only ever deleted whole (sweep drops the
   * file) — never partially. If that ever changes (row-level retention), switch to a position query.
   */
  async #resolveCursor(c: Client, gen: number, startIndex: number | undefined): Promise<number> {
    const tx = await c.transaction("read");
    try {
      let absStart = 0;
      if (startIndex !== undefined) {
        if (startIndex >= 0) {
          absStart = startIndex;
        } else {
          const cnt = await tx.execute({
            sql: "SELECT COUNT(*) AS n FROM frames WHERE gen = ?",
            args: [gen],
          });
          absStart = Math.max(0, Number(cnt.rows[0]?.n ?? 0) + startIndex);
        }
      }
      if (absStart <= 0) return 0;
      const at = await tx.execute({
        sql: "SELECT id FROM frames WHERE gen = ? ORDER BY id LIMIT 1 OFFSET ?",
        args: [gen, absStart - 1],
      });
      if (at.rows[0] !== undefined) return Number(at.rows[0].id);
      // startIndex past the end → clamp to head: replay nothing, then stream new frames.
      const mx = await tx.execute({
        sql: "SELECT COALESCE(MAX(id), 0) AS m FROM frames WHERE gen = ?",
        args: [gen],
      });
      return Number(mx.rows[0]?.m ?? 0);
    } finally {
      tx.close();
    }
  }

  /**
   * Purge whole sessions (their entire database) idle longer than retainMs. Never partial-deletes a
   * session, and never drops one with a live borrow (an active subscriber) — so replay never starts on a
   * gap. Uses the COLD session index when the locator provides one (cloud — scalable, resumable), else a
   * fleet dir-scan (file — drift-free, single-box). An empty/unreadable db is treated as stale.
   */
  async sweep(retainMs: number): Promise<number> {
    const index = await this.#getIndex();
    return index !== null ? this.#sweepViaIndex(index, retainMs) : 0;
  }

  /** Drop the cold-index catalog db itself, for the dev/CI cleanup of a short-lived scope AFTER its
   *  sessions are swept — leaves no empty index db behind. SAFE: drops ONLY when the catalog has no
   *  remaining sessions, so a sweep that intentionally left entries (non-zero retain, busy/fresh/
   *  deadline-skipped) never has its catalog deleted out from under those still-reclaimable dbs. Closes
   *  the catalog client and forgets the cached build (a later publish re-provisions both). No concurrent
   *  publish during the post-sweep cleanup (same TOCTOU window the sweep itself accepts). */
  async dropIndex(): Promise<void> {
    const index = await this.#getIndex();
    if (index === null) return; // locator has no droppable index (e.g. file dir without one)
    if ((await index.batchAfter("", 1)).length > 0) return; // sessions remain → keep the catalog
    this.#indexBuild = undefined;
    index.close();
    await this.#locator.dropIndex?.();
  }

  /** Walk the cold catalog in bounded, RESUMABLE batches (a persisted cursor that rotates through the
   *  fleet across cron runs), probing only the current batch — the same index path for file and cloud,
   *  so it's exercised by the file-backed tests. O(stale) per run. */
  async #sweepViaIndex(index: SessionIndex, retainMs: number): Promise<number> {
    const cutoff = Date.now() - retainMs;
    const deadline = Date.now() + SWEEP_DEADLINE_MS;
    const probeAuth = this.#locator.probeAuthToken?.();
    const busyUrls = new Set(this.#cache.activeTokens().map((t) => this.#locator.config(t).url));
    let cursor = await index.getCursor();
    let swept = 0;
    try {
      for (;;) {
        if (Date.now() >= deadline) break;
        const batch = await index.batchAfter(cursor, sqliteSweepBatch());
        if (batch.length === 0) {
          await index.setCursor(""); // reached the end → wrap to the start next run
          break;
        }
        for (const { id, url } of batch) {
          // Deadline check is PER ITEM: each cloud probe+drop is up to two network round-trips, so a
          // 200-item batch could blow past the route maxDuration and be killed mid-batch (losing the
          // cursor advance). Persist progress and stop cleanly instead.
          if (Date.now() >= deadline) {
            await index.setCursor(cursor);
            return swept;
          }
          cursor = id;
          if (await this.#probeAndMaybeDrop(id, url, probeAuth, cutoff, busyUrls)) {
            await index.remove(id);
            swept += 1;
          }
        }
        await index.setCursor(cursor);
      }
    } catch (e) {
      // A dead index connection must not stall retention forever: drop the cached build so the next cron
      // run reconnects. Persist progress so we resume rather than re-probe from the top.
      if (isConnLevelLibsqlErrorByCode(e)) this.#indexBuild = undefined;
      try {
        await index.setCursor(cursor);
      } catch {
        /* index is down; cursor will resume from its last persisted value */
      }
      throw e;
    }
    return swept;
  }

  /** Probe one catalogued db's own MAX(created_at) (Turso has no last-activity API); if idle and not
   *  actively borrowed, evict its cached client and drop it. Returns true iff it was dropped. */
  async #probeAndMaybeDrop(
    id: string,
    url: string,
    authToken: string | undefined,
    cutoff: number,
    busyUrls: Set<string>,
  ): Promise<boolean> {
    if (busyUrls.has(url)) return false;
    const first = await this.#probeStale(url, authToken, cutoff);
    if (!first.ok || !first.stale) return false;
    // Evict any idle cached client FIRST, so any NEW publish must re-acquire (re-create) a fresh client —
    // and skip the drop if a live borrow raced in (busy). THEN RE-PROBE: a frame that landed after the
    // first read would bump MAX(created_at) past the cutoff, so we must NOT destroy a session that just
    // came back. Only drop if it is STILL stale on the second read (TOCTOU data-loss guard — the residual
    // window is just the two awaits between this re-probe and the drop).
    if (this.#cache.evictByUrl(url) === "busy") return false;
    const second = await this.#probeStale(url, authToken, cutoff);
    if (!second.ok || !second.stale) return false;
    await this.#locator.dropStored?.(id);
    return true;
  }

  /** Read a db's MAX(created_at) and decide staleness. `ok:false` (unreadable/connect error) ⇒ never drop. */
  async #probeStale(
    url: string,
    authToken: string | undefined,
    cutoff: number,
  ): Promise<{ ok: boolean; stale: boolean }> {
    let probe: Client | undefined;
    try {
      // newClient is INSIDE the try so a construction/connect throw is handled like an unreadable db
      // (leave it for a later sweep) rather than aborting the whole sweep.
      probe = this.#newClient(authToken !== undefined ? { url, authToken } : { url });
      await this.#locator.prepare?.(probe); // WAL (file): read concurrently with a live writer
      const r = await probe.execute("SELECT MAX(created_at) AS m FROM frames");
      const m = r.rows[0]?.m;
      return { ok: true, stale: m === null || m === undefined ? true : Number(m) < cutoff };
    } catch {
      return { ok: false, stale: false }; // unreadable/locked → leave it for a later sweep
    } finally {
      try {
        probe?.close();
      } catch {
        /* ignore */
      }
    }
  }

  async #withConnErrorEvict<T>(token: string, c: Client, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // Evict on a dead CONNECTION or a gone CHANNEL: either way the cached client is useless (a gone
      // channel's client points at a deleted db), so the next acquire reopens — and for a write,
      // re-ensure()s a fresh db (issue #111).
      if (isConnectionLevelLibsqlError(c, e) || isChannelGoneError(e))
        this.#cache.evictClient(token, c);
      // …and forget the locator's "db exists" memo, or the cloud locator's stale positive cache would make
      // the recreating ensure() no-op and the new client would re-point at the deleted db (codex review).
      if (isChannelGoneError(e)) this.#locator.forget?.(token);
      throw e;
    }
  }
}
