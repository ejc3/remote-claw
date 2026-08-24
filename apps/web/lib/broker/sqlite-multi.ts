import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Client, createClient, type ResultSet, type Transaction } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import {
  type BrokerBackend,
  isClose,
  PublishCollisionError,
  type PublishResult,
  type RelayPayload,
} from "./backend";
import { SessionIndex } from "./session-index";

// The per-channel SQLite (libSQL) durable backend — ONE database per channel token, rather than one
// shared `frames` table for all channels. Each token addresses its OWN database, so a channel's frames
// are physically isolated:
// there is no cross-channel write contention (SQLite serializes writes per database, so the write lock
// is per channel, not one global mutex), and a leaked/compromised channel can't even see another
// session's at-rest ciphertext. This is the broker's "dumb per-channel pipe" model made physical, and
// the primary backend for local development (BROKER_BACKEND=sqlite).
//
// Storage is pluggable behind `DbLocator`: the default `FileDbLocator` maps a token to a local file:
// database under RC_SQLITE_DIR. A Turso-Cloud locator (one remote libSQL database per channel token via
// the Platform API) would slot in unchanged — the backend logic below is storage-agnostic.
//
// E2E preserved: `frame` stores the verbatim sealed WireFrame JSON; the broker never decrypts. The only
// cleartext columns are the §8 routing fields it already routes on (seq/msg_id/part), minus `token`
// (implicit — it IS the database).

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
const MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES = 3;
const MAX_POLL_QUERY_MS = 15_000;

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

/** A "channel gone" error: the per-channel database/namespace was deleted out from under a cached client.
 *  libSQL surfaces it as a generic error with no stable code, so this message check is the only signal.
 *  Once the durable catalog says the token existed, this is irreversible storage loss: every operation
 *  fails closed instead of silently creating an empty replacement under the same live token. */
function isChannelGoneError(e: unknown): boolean {
  const msg = errorMessage(e);
  return (
    /was deleted while processing/i.test(msg) ||
    (/\bnamespace\b/i.test(msg) &&
      /(doesn't exist|does not exist|not found|was deleted)/i.test(msg)) ||
    // Local SQLite can keep a cached handle to an unlinked database path; the next query then sees a
    // fresh empty file/schema rather than a provider namespace error. Missing either non-derivable core
    // table is the same permanent loss. (presence_terminals is excluded: it is rebuilt from frames.)
    /no such table:\s*(?:channel|frames)\b/i.test(msg)
  );
}

/** A previously established token lost its physical per-channel store. The message deliberately carries
 *  neither the token nor provider details: callers may surface/log it without disclosing coordinates. */
export class ChannelStorageLossError extends Error {
  constructor() {
    super("sqlite: previously known channel storage is missing");
    this.name = "ChannelStorageLossError";
  }
}

/** A live subscription could no longer make a complete durable poll decision. Deliberately omit the
 *  provider error/cause: this reaches the SSE error event and may therefore be shown or logged by a
 *  client. The next subscription gets a fresh client because every path that throws this evicts first. */
export class SqlitePollFailureError extends Error {
  constructor() {
    super("sqlite: subscription poll failed");
    this.name = "SqlitePollFailureError";
  }
}

/** Internal sentinel for a query that crossed the bounded live-poll deadline. */
class PollQueryDeadlineError extends Error {
  constructor() {
    super("sqlite: subscription poll query exceeded its deadline");
    this.name = "PollQueryDeadlineError";
  }
}

/** The independent continuity catalog could not be re-opened. Keep this distinct from channel loss so
 *  callers never turn an index outage into a false permanent-loss decision for the token database. */
class ChannelCatalogUnavailableError extends Error {
  constructor() {
    super("sqlite: durable channel catalog is unavailable");
    this.name = "ChannelCatalogUnavailableError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race one ongoing poll query against its hard deadline. The explicit rejection observer remains
 *  attached after a timeout: evicting/closing the client may reject the underlying query later, and
 *  that late settlement must never become an unhandled rejection. */
async function executePollQuery<T>(query: () => Promise<T>, deadlineMs: number): Promise<T> {
  const pending = Promise.resolve().then(query);
  void pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PollQueryDeadlineError()), deadlineMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Serialize writes against a single per-channel client (SQLite is single-writer; a concurrent publish /
// __close on the SAME database would otherwise SQLITE_BUSY). Writes to DIFFERENT channels use different
// clients and never contend — the whole point of one database per channel token.
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

// Per-channel schema. No `token` column (it IS the database); `channel` is a single row (id = 1) holding
// the live/closed flag and incarnation `gen` (bumps on a publish-after-__close so a recycled token starts
// fresh WITHOUT deleting durable history, matching the shared-log backend). `frames` is append-only;
// `id` (AUTOINCREMENT) is the total order AND the live cursor.
// UNIQUE(gen, msg_id, part) identifies a transport retry coordinate: exact stored bytes are idempotent,
// while changed bytes are a hard PublishCollisionError. A NULL msg_id is distinct in SQLite, so a
// minimal internal/test frame without one always inserts.
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
  `CREATE TABLE IF NOT EXISTS presence_terminals (
     session_id  TEXT PRIMARY KEY,
     created_at  INTEGER NOT NULL
   )`,
];

// `presence_terminals` is a derived projection, not an independent continuity witness. Older channel
// databases predate that table, and an absent projection can be rebuilt exactly from the retained,
// append-only terminal frames. Run this only when the table was absent so ordinary opens stay cold.
const BACKFILL_PRESENCE_TERMINALS = `
  INSERT OR IGNORE INTO presence_terminals (session_id, created_at)
  SELECT json_extract(frame, '$.session_id'), MIN(created_at)
  FROM frames
  WHERE json_extract(frame, '$.record_kind') = 'session_terminal'
    AND typeof(json_extract(frame, '$.session_id')) = 'text'
  GROUP BY json_extract(frame, '$.session_id')`;

const PRESENCE_BUS_PREFIX = "bus:presence-v2:";

function isPresenceBus(token: string): boolean {
  return token.startsWith(PRESENCE_BUS_PREFIX);
}

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
   *  as the dropStored() argument and the channel-catalog primary key. */
  idFor(token: string): string;
  /** Materialize the token's database if absent (genuinely-new write path only). */
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
  /** Forget any cached "this db exists" memo for the token so the next exists() is authoritative after a
   *  channel-gone error. This never grants recreation authority: the durable catalog separately fences a
   *  previously-known id. Optional for locators with no positive existence cache. */
  forget?(token: string): void;
  /** Delete a stored database by its `id` (from idFor / the channel catalog), reclaiming its space. */
  dropStored?(id: string): Promise<void>;

  // --- Retention via a COLD channel catalog (both file and cloud — written once on create, walked in
  //     resumable batches by the sweep; omit indexConfig ⇒ retention is a no-op). ---
  /** Connection config for the shared catalog db that the SessionIndex lives in. */
  indexConfig?(): { url: string; authToken?: string };
  /** Provision the catalog db if needed (cloud: Platform-API create the `rc-<scope>-index` db; file: no-op). */
  ensureIndex?(): Promise<void>;

  // --- Ephemeral one-time-handoff store (one small table, SEPARATE from channel frames; see
  //     docs/ephemeral-handoff.md). Omit ⇒ the handoff feature is unavailable on this locator. ---
  /** Connection config for the dedicated handoff store db (cloud: `rc-<scope>-hx`; file: `_handoff.db`). */
  handoffConfig?(): { url: string; authToken?: string };
  /** Provision the handoff db if needed (cloud: Platform-API create `rc-<scope>-hx`; file: no-op). */
  ensureHandoff?(): Promise<void>;

  /** The auth token a retention probe uses to connect a catalogued db by its url (cloud: the group token). */
  probeAuthToken?(): string | undefined;
  /** Low-level diagnostic: drop the cold-index catalog db itself after its channels are gone. */
  dropIndex?(): Promise<void>;
  /** Dangerous low-level diagnostic: delete EVERY db matching this locator's scope by name (cataloged
   *  or not), including uncatalogued orphans. Returns this pass's `deleted` count
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
    // lose a "durable" channel. (Turso Cloud is the durable per-channel production store.)
    if (process.env.VERCEL === "1" && (process.env.RC_SQLITE_DIR ?? "") === "") {
      throw new Error(
        "FileDbLocator: file-mode per-channel sqlite is not durable on Vercel (ephemeral, per-instance " +
          "filesystem). Configure a durable per-channel store, or set RC_SQLITE_DIR to acknowledge an " +
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

  // Materialize an empty file before the durable catalog boundary. This ordering is crash-safe: a crash
  // before cataloguing leaves an unclaimed empty file that a retry may finish, while a catalog row is
  // never committed for a path that did not yet exist. O_NOFOLLOW also refuses a substituted symlink.
  async ensure(token: string): Promise<void> {
    const descriptor = openSync(
      this.#path(token),
      constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(descriptor);
  }

  // Align local-file lock semantics with a remote single-writer libSQL so concurrency has the SAME SHAPE
  // in dev and prod. WAL lets readers (the poll-tail subscribe, the sweep probe) proceed concurrently
  // with the writer instead of hitting reader↔writer SQLITE_BUSY — matching Turso's MVCC-style reads.
  // WRITE serialization is structural, not a busy_timeout: the cache opens exactly ONE writer connection
  // per channel token (create-lock + per-client write-lock), so two writers to one file never race —
  // the same one-writer-per-channel shape cloud has (one client per token + server-side single-writer).
  // (@libsql/client does not honour a PRAGMA busy_timeout for transaction lock waits, so we don't rely
  // on one; the single-writer invariant is what guarantees writes serialize rather than fail.)
  async prepare(client: Client): Promise<void> {
    await client.execute("PRAGMA journal_mode = WAL");
  }

  async exists(token: string): Promise<boolean> {
    return existsSync(this.#path(token));
  }

  // The cold channel-catalog db lives alongside the channel dbs (`_index.db`). It can't collide with a
  // channel file (those are `<token>-<24 hex>.db`) and is never catalogued/swept itself, so the index
  // walks only real channels. createClient auto-creates the file, so there's no ensureIndex.
  indexConfig(): { url: string } {
    return { url: `file:${join(this.#dir, "_index.db")}` };
  }

  // The handoff store lives alongside the channel dbs (`_handoff.db`). createClient auto-creates the file,
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

/** A deployment may tighten the deadline (tests do); environment input can never relax the code ceiling. */
function sqlitePollQueryMs(): number {
  const n = Number.parseInt(process.env.RC_SQLITE_POLL_QUERY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_POLL_QUERY_MS) : MAX_POLL_QUERY_MS;
}

/** A borrowed per-channel client; the borrower MUST call release() exactly once when done. */
interface Lease {
  readonly client: Client;
  isCatalogKnown(): boolean;
  markCatalogKnown(): void;
  release(): void;
}

interface CacheEntry {
  client: Client;
  refs: number;
  catalogKnown: boolean;
}

interface OpenDisposition {
  readonly catalogKnown: boolean;
}

type PrepareOpen = (token: string, create: boolean) => Promise<OpenDisposition | null>;

// A bounded, ref-counted LRU of per-channel libSQL clients. Opening one client per channel and caching
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
  readonly #prepareOpen: PrepareOpen;

  constructor(
    locator: DbLocator,
    prepareOpen: PrepareOpen,
    max: number = sqliteMaxClients(),
    newClient: ClientFactory = createClient,
  ) {
    this.#locator = locator;
    this.#prepareOpen = prepareOpen;
    this.#max = max;
    this.#newClient = newClient;
  }

  #ensureSchema(client: Client, catalogKnown: boolean): Promise<void> {
    let p = this.#migrated.get(client);
    if (p === undefined) {
      p = (async () => {
        // CREATE IF NOT EXISTS must not heal a known/replaced database whose durable continuity core
        // vanished. For an uncatalogued store, *no* user tables is the crash-safe pre-schema provisioning
        // state; any other shape must contain both channel+frames. This also refuses an unrelated database
        // at the deterministic name instead of mistaking it for a safely empty provision.
        const schema = await client.execute(
          "SELECT name FROM sqlite_master " + "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        );
        const core = new Set(schema.rows.map((row) => String(row.name)));
        const hasLegacyCore = core.has("channel") && core.has("frames");
        if (
          (catalogKnown && !hasLegacyCore) ||
          (!catalogKnown && core.size > 0 && !hasLegacyCore)
        ) {
          throw new ChannelStorageLossError();
        }
        const presenceProjectionMissing = !core.has("presence_terminals");
        await client.batch(
          presenceProjectionMissing ? [...DDL, BACKFILL_PRESENCE_TERMINALS] : DDL,
          "write",
        );
      })().then(
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
      const disposition = await this.#prepareOpen(token, create);
      if (disposition === null) return null; // read path: genuinely new token, never create it
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
      const entry: CacheEntry = { client, refs: 0, catalogKnown: disposition.catalogKnown };
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
      await this.#ensureSchema(entry.client, entry.catalogKnown);
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
      isCatalogKnown: () => entry.catalogKnown,
      markCatalogKnown: () => {
        entry.catalogKnown = true;
      },
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

  /**
   * On a connection-level error the client is already broken, so drop it from the cache (the next
   * acquire reopens a fresh one) and close it. We detach the entry even if a lease still holds it: that
   * outstanding lease's later release() decrements the now-detached entry (harmless — it is no longer in
   * the map, so #evict() never sees it) while NEW acquires get a healthy client. The per-client write lock
   * is dropped too so its Promise can't pile up across rapid reconnects.
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
  readonly #pollQueryMs = sqlitePollQueryMs();
  // The cold channel continuity catalog, built lazily from the locator's indexConfig. undefined = not yet
  // built; null is rejected on channel access because create-once loss detection requires durable evidence.
  #indexBuild: Promise<SessionIndex | null> | undefined;

  /** Production/dev uses the env-configured FileDbLocator; tests inject a tmp-dir locator (and may inject
   *  a client factory to fault-test the connection). */
  constructor(locator: DbLocator = new FileDbLocator(), newClient: ClientFactory = createClient) {
    this.#locator = locator;
    this.#newClient = newClient;
    this.#cache = new SessionDbCache(
      locator,
      (token, create) => this.#prepareOpen(token, create),
      sqliteMaxClients(),
      newClient,
    );
  }

  /** Cold-open decision from two independent facts: the durable catalog says whether this token crossed
   *  create-once before, while locator.exists says whether its physical store is still present. A known
   *  id with no store is data loss, never a new channel. An uncatalogued existing store is recoverable
   *  crash/legacy evidence and is reconciled only after its channel row is verified below. */
  async #prepareOpen(token: string, create: boolean): Promise<OpenDisposition | null> {
    const known = await this.#withIndex((index) => index.has(this.#locator.idFor(token)));
    const exists = await this.#locator.exists(token);
    if (known) {
      if (!exists) {
        this.#locator.forget?.(token);
        throw new ChannelStorageLossError();
      }
      return { catalogKnown: true };
    }
    if (!exists) {
      if (!create) return null;
      // Genuinely new token: provision an empty physical store, but do not call it known until its
      // channel witness row has committed. FileDbLocator.ensure materializes the file; Turso ensure
      // creates the named database. Neither path can append a frame here.
      await this.#locator.ensure(token);
    }
    return { catalogKnown: false };
  }

  /** Verify (or, only for a genuinely new write, establish) the in-database channel witness. Ordering:
   *  witness row → durable catalog row → first frame. Thus every crash point is safe: before the witness
   *  a retry may initialize; after it, the database itself proves existence; after cataloguing, either
   *  witness being absent is a hard loss. */
  async #establishChannel(
    token: string,
    lease: Lease,
    create: boolean,
  ): Promise<{ created: boolean } | null> {
    let created = false;
    if (create) {
      created = await runWriteTransaction(lease.client, async (tx) => {
        const current = await tx.execute("SELECT 1 FROM channel WHERE id = 1");
        if (current.rows[0] !== undefined) return false;
        if (lease.isCatalogKnown()) throw new ChannelStorageLossError();
        await tx.execute({
          sql: "INSERT INTO channel (id, gen, closed, created_at) VALUES (1, 0, 0, ?)",
          args: [Date.now()],
        });
        return true;
      });
    } else {
      const current = await lease.client.execute("SELECT 1 FROM channel WHERE id = 1");
      if (current.rows[0] === undefined) {
        if (lease.isCatalogKnown()) throw new ChannelStorageLossError();
        return null;
      }
    }

    if (!lease.isCatalogKnown()) {
      await this.#withIndex((index) =>
        index.add(this.#locator.idFor(token), this.#locator.config(token).url, Date.now()),
      );
      lease.markCatalogKnown();
    }
    return { created };
  }

  async #withChannel<T>(
    token: string,
    create: boolean,
    fn: (client: Client, created: boolean) => Promise<T>,
  ): Promise<T | null> {
    let lease: Lease | null;
    try {
      lease = await this.#cache.acquire(token, create);
    } catch (e) {
      this.#raiseChannelGone(token, e);
    }
    if (lease === null) return null;
    try {
      const established = await this.#establishChannel(token, lease, create);
      if (established === null) return null;
      return await fn(lease.client, established.created);
    } catch (e) {
      if (isChannelGoneError(e)) this.#cache.evictClient(token, lease.client);
      this.#raiseChannelGone(token, e);
    } finally {
      lease.release();
    }
  }

  #raiseChannelGone(token: string, error: unknown): never {
    if (!isChannelGoneError(error)) throw error;
    this.#locator.forget?.(token);
    throw new ChannelStorageLossError();
  }

  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    if (isClose(payload)) {
      // Mark an EXISTING live channel closed — never delete its rows (a buffered replay must survive a
      // close; the durable history is the point). A later publish reopens a fresh incarnation (gen+1).
      // No-op (and DON'T create a database) if the token is absent or already closed.
      const res = await this.#withChannel(token, false, (c) =>
        this.#withConnErrorEvict(token, c, async () => {
          await withWriteLock(c, async () => {
            await c.execute("UPDATE channel SET closed = 1 WHERE id = 1 AND closed = 0");
          });
          return {
            created: false,
            channelId: this.#locator.idFor(token),
          } satisfies PublishResult;
        }),
      );
      return res ?? { created: false, channelId: this.#locator.idFor(token) };
    }
    const result = await this.#withChannel(token, true, (c, created) =>
      this.#withConnErrorEvict(token, c, () => this.#publishFrame(token, c, payload, created)),
    );
    if (result === null) throw new Error("sqlite: failed to establish channel database");
    return result;
  }

  /** Lazily build the cold SessionIndex from the locator's indexConfig (null if the locator has none). */
  #getIndex(): Promise<SessionIndex | null> {
    if (this.#indexBuild === undefined) {
      this.#indexBuild = (async () => {
        const cfg = this.#locator.indexConfig?.();
        if (cfg === undefined) return null;
        await this.#locator.ensureIndex?.();
        const client = this.#newClient(cfg);
        try {
          // The catalog is a real Turso database too. A first deployment can observe the same
          // Platform-API create→serve 404 window as a channel database, and no SessionIndex DDL/read may
          // race ahead of that readiness barrier. Keep the client uncached until both readiness and
          // connection preparation succeed; #withIndex may then rebuild on its existing bounded retry.
          await this.#locator.awaitReady?.(client, "index");
          await this.#locator.prepare?.(client);
          return new SessionIndex(client);
        } catch (error) {
          try {
            client.close();
          } catch {
            /* a half-open client may already have closed itself */
          }
          throw error;
        }
      })().catch((e) => {
        this.#indexBuild = undefined; // let a later call retry the build
        throw e;
      });
    }
    return this.#indexBuild;
  }

  /** Run a catalog operation, rebuilding once if its cached client was deleted/disconnected. A second
   *  such failure is deliberately wrapped in a content-free catalog error: outer channel handling must
   *  not mistake a provider's generic "namespace deleted" text for loss of the token database. */
  async #withIndex<T>(operation: (index: SessionIndex) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let index: SessionIndex | null = null;
      try {
        index = await this.#getIndex();
        if (index === null) {
          throw new Error("sqlite: per-channel storage requires a durable channel catalog");
        }
        return await operation(index);
      } catch (e) {
        const reconnectable = isChannelGoneError(e) || isConnLevelLibsqlErrorByCode(e);
        if (!reconnectable) throw e;
        if (index !== null) await this.#discardIndex(index);
        else this.#indexBuild = undefined;
        if (attempt === 1) throw new ChannelCatalogUnavailableError();
      }
    }
    throw new ChannelCatalogUnavailableError();
  }

  async #discardIndex(index: SessionIndex): Promise<void> {
    const current = this.#indexBuild;
    if (current !== undefined) {
      const built = await current.catch(() => null);
      if (built === index && this.#indexBuild === current) this.#indexBuild = undefined;
    }
    index.close();
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
    wire: WireFrame,
    establishedNow: boolean,
  ): Promise<PublishResult> {
    return runWriteTransaction(client, async (tx) => {
      const presenceBus = isPresenceBus(token);
      const terminal = presenceBus && wire.record_kind === "session_terminal";
      const liveAnnounce = presenceBus && wire.record_kind === "session_announce";

      if (presenceBus) {
        if (terminal || liveAnnounce) {
          const fenced = await tx.execute({
            sql: "SELECT 1 FROM presence_terminals WHERE session_id = ? LIMIT 1",
            args: [wire.session_id],
          });
          if (fenced.rows[0] !== undefined) {
            // A terminal retry and a late live announce are both successful semantic no-ops. A retry is
            // freshly AEAD-sealed, so its transport bytes legitimately differ at the same coordinate;
            // the durable session_id fence identifies the already-accepted operation and deliberately
            // bypasses collision checking WITHOUT inserting/updating the first stored terminal bytes.
            // Check before resolving/reopening the channel so suppression cannot create an incarnation.
            return { created: false, channelId: this.#locator.idFor(token) };
          }
        }
      }

      const cur = await tx.execute("SELECT gen, closed FROM channel WHERE id = 1");
      const row = cur.rows[0];
      let created: boolean;
      let gen: number;
      if (row === undefined) {
        throw new ChannelStorageLossError();
      } else if (Number(row.closed) === 0) {
        gen = Number(row.gen);
        created = establishedNow;
      } else {
        gen = Number(row.gen) + 1;
        created = true;
        await tx.execute({
          sql: "UPDATE channel SET gen = ?, closed = 0 WHERE id = 1",
          args: [gen],
        });
      }
      const now = Date.now();
      const serialized = JSON.stringify(wire); // route-normalized canonical WireFrame key order
      const inserted = await tx.execute({
        // `?? null` (nullish, NOT `||`) preserves a legitimate seq=0 / part=0; only an absent field → NULL.
        sql: `INSERT INTO frames (gen, seq, msg_id, part, frame, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (gen, msg_id, part) DO NOTHING`,
        args: [
          gen,
          wire.seq ?? null,
          wire.msg_id ?? null,
          wire.part ?? null,
          serialized, // the opaque sealed frame — never decrypted here
          now,
        ],
      });
      if (inserted.rowsAffected === 0) {
        const occupied = await tx.execute({
          sql: `SELECT frame FROM frames
                WHERE gen = ? AND msg_id = ? AND part = ?
                LIMIT 1`,
          args: [gen, wire.msg_id, wire.part],
        });
        if (String(occupied.rows[0]?.frame ?? "") !== serialized) {
          throw new PublishCollisionError();
        }
      }
      if (terminal) {
        // The frame append and absorbing fence share this write transaction: every total order is
        // either live-before-terminal (both observable) or terminal-before-live (live suppressed).
        await tx.execute({
          sql: "INSERT INTO presence_terminals (session_id, created_at) VALUES (?, ?)",
          args: [wire.session_id, now],
        });
      }
      return { created, channelId: this.#locator.idFor(token) };
    });
  }

  async maxSeq(token: string): Promise<number | null> {
    return await this.#withChannel(token, false, (c) =>
      this.#withConnErrorEvict(token, c, async () => {
        const tx = await c.transaction("read");
        try {
          const ch = await tx.execute("SELECT gen, closed FROM channel WHERE id = 1");
          const meta = ch.rows[0];
          if (meta === undefined) throw new ChannelStorageLossError();
          if (Number(meta.closed) === 1) return null;
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
  }

  async frameCount(token: string): Promise<number | null> {
    return await this.#withChannel(token, false, (c) =>
      this.#withConnErrorEvict(token, c, async () => {
        const tx = await c.transaction("read");
        try {
          const ch = await tx.execute("SELECT gen, closed FROM channel WHERE id = 1");
          const meta = ch.rows[0];
          if (meta === undefined) throw new ChannelStorageLossError();
          if (Number(meta.closed) === 1) return null;
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
  }

  async subscribe(
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    let lease: Lease | null;
    try {
      lease = await this.#cache.acquire(token, false);
    } catch (e) {
      this.#raiseChannelGone(token, e);
    }
    if (lease === null) return null; // subscribing never creates a channel
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      lease.release();
    };
    const c = lease.client;
    try {
      const established = await this.#establishChannel(token, lease, false);
      if (established === null) {
        release();
        return null;
      }
      const ch = await c.execute("SELECT gen, closed FROM channel WHERE id = 1");
      const meta = ch.rows[0];
      if (meta === undefined) throw new ChannelStorageLossError();
      // Closed → null ⇒ the route replies 200-empty (subscribing never reopens a channel).
      if (Number(meta.closed) === 1) {
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
      const pollQueryMs = this.#pollQueryMs;
      let consecutiveTransientFailures = 0;
      let pos = cursor;
      const terminatePoll = (error: unknown): never => {
        this.#cache.evictClient(token, c);
        release();
        if (isChannelGoneError(error)) {
          this.#locator.forget?.(token);
          throw new ChannelStorageLossError();
        }
        throw new SqlitePollFailureError();
      };
      const retryTransientPoll = async (error: unknown): Promise<boolean> => {
        if (!isTransientLibsqlError(error)) return false;
        consecutiveTransientFailures++;
        if (consecutiveTransientFailures >= MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES) return false;
        // Content-free by design: provider messages may contain database coordinates or request data.
        console.warn(
          `[sqlite] transient subscribe poll failed; retrying ` +
            `(${consecutiveTransientFailures}/${MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES})`,
        );
        await sleep(pollMs);
        return true;
      };
      return new ReadableStream<WireFrame>({
        pull: async (controller) => {
          while (!stopped) {
            let res!: ResultSet;
            try {
              res = await executePollQuery(
                () =>
                  c.execute({
                    sql: "SELECT id, frame FROM frames WHERE gen = ? AND id > ? ORDER BY id LIMIT 500",
                    args: [gen, pos],
                  }),
                pollQueryMs,
              );
            } catch (e) {
              // Channel-gone is checked BEFORE transient retry: loss may carry SERVER_ERROR, but it is
              // permanent for this live token and must error the stream instead of retrying or clean-closing.
              if (isChannelGoneError(e)) terminatePoll(e);
              if (await retryTransientPoll(e)) continue;
              terminatePoll(e);
            }
            if (stopped) return; // cancelled while the query was in flight (cancel() released)
            if (res.rows.length > 0) {
              // A row-bearing frame query is itself a complete successful poll decision.
              consecutiveTransientFailures = 0;
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
            let st!: ResultSet;
            try {
              st = await executePollQuery(
                () => c.execute("SELECT closed, gen FROM channel WHERE id = 1"),
                pollQueryMs,
              );
            } catch (e) {
              // A deleted namespace is permanent for this live token, even when it also carries a
              // transient provider code. Error rather than clean-closing into an apparent empty history.
              if (isChannelGoneError(e)) terminatePoll(e);
              if (await retryTransientPoll(e)) continue;
              terminatePoll(e);
            }
            // An empty frame query is only half a poll. Reset after the state query also succeeds, so
            // alternating frame-success/state-failure cannot keep an unhealthy subscription alive.
            consecutiveTransientFailures = 0;
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
      this.#raiseChannelGone(token, e);
    }
  }

  /**
   * Resolve an `id` cursor such that `id > cursor` selects from the requested start. undefined/0 → the
   * whole log (ids start at 1); positive → skip the first N rows of this gen (clamp past-end → head);
   * negative → the last |N| rows.
   *
   * The COUNT and the OFFSET run in ONE read transaction so a concurrent publish can't shift the count
   * between them and skew the cursor. OFFSET selects an actual row id rather than calculating one, so
   * the cursor remains correct even if a future safe collection protocol ever makes ids sparse.
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
   * Inactivity is not proof that a session ended: a live host writes keepalives to its identity bus, not
   * its idle per-session transcript. The broker also cannot AEAD-authenticate a collection transition.
   * Therefore ordinary retention is deliberately fail-closed: it neither drops session databases nor
   * compacts bus frames. Destructive locator methods remain low-level diagnostic primitives and are not
   * reachable from an HTTP or production path.
   */
  async sweep(_retainMs: number): Promise<number> {
    return 0;
  }

  /** Drop an empty catalog db as a low-level diagnostic primitive. Ordinary retention never calls this:
   *  sweep() is deliberately a no-op because inactivity cannot authenticate a safe collection
   *  transition. SAFE: an index with any session entry is retained. Closes the catalog client and
   *  forgets the cached build (a later publish re-provisions both). */
  async dropIndex(): Promise<void> {
    const index = await this.#getIndex();
    if (index === null) return; // locator has no droppable index (e.g. file dir without one)
    if ((await index.batchAfter("", 1)).length > 0) return; // sessions remain → keep the catalog
    this.#indexBuild = undefined;
    index.close();
    await this.#locator.dropIndex?.();
  }

  async #withConnErrorEvict<T>(token: string, c: Client, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // Evict on a dead connection or gone channel. A gone channel is also permanently fenced by the
      // durable catalog: forgetting only the locator's stale positive memo enables an authoritative
      // exists() check; it never authorizes ensure()/recreation for the known id.
      if (isConnectionLevelLibsqlError(c, e) || isChannelGoneError(e))
        this.#cache.evictClient(token, c);
      this.#raiseChannelGone(token, e);
    }
  }
}
