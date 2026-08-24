import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { type DbLocator, FileDbLocator } from "./sqlite-multi";

// Cloud storage for the per-channel libSQL backend: ONE Turso Cloud database per channel token. This is
// the SAME backend as the local-file mode — only the storage location differs. A token maps to a Turso
// database created on demand via the Platform API and connected with a GROUP token (one JWT that auths
// every database in the group), so a Vercel deployment with the Turso integration drives both the
// connection (group token) and creation (Platform API token) from env. See lib/broker/README.md.
//
// Why a hashed db name: a Turso database name is length/charset-limited and the raw channel token
// (`sess:<32hex>:<sid>`) is too long, so we derive a stable, collision-resistant name from it. The name
// is purely internal — the channel token stays the addressing key everywhere else.

const TURSO_API_BASE = "https://api.turso.tech";

// Turso db names are [a-z0-9-] and 1–36 chars. We spend that budget on a HUMAN-SCANNABLE name rather than
// an opaque hash, so `turso db list` is meaningful:
//
//   rc-<scope>-<kind>-<16 hex>     e.g. rc-prod-s-3f9a1c2e8b7d6045   (prod, session channel)
//                                       rc-prod-b-3f9a1c2e8b7d6045   (prod, bus channel)
//                                       rc-prod-c-3f9a1c2e8b7d6045   (prod, A1 control channel)
//                                       rc-pr-a1b2c3d-s-<16hex>      (preview of commit a1b2c3d)
//   rc-<scope>-index               the per-scope cold-index catalog db (rc-prod-index / rc-pr-a1b2c3d-index)
//
//   • `rc`      — the app marker (these are remote-claw's dbs).
//   • `<scope>` — the deployment ENVIRONMENT (see tursoScopeFromEnv): `prod`, `pr-<7-char commit sha>` for a
//                 preview, or `dev`. It separates ordinary routing/catalog names, but it is not deletion
//                 authority: seven-character commit prefixes can collide and an explicit override can
//                 select another deployment's scope.
//   • `<kind>`  — `s` (session), `b` (bus), `c` (selected-A1 control), or `x` (other).
//   • `<hash>`  — sha256(channel token) truncated; the uniqueness/addressing component.
//
// Budget: `rc-`(3) + scope(≤14) + `-`+kind(1)+`-`(2) + 16 hex = ≤36. The scope is bounded to 14 chars.
const APP = "rc";
const DEFAULT_SCOPE = "dev";
const SCOPE_MAX = 14;
const HASH_LEN = 16;

// awaitReady backoff: a brand-new Turso db's libSQL endpoint can briefly 404 (or its host not resolve)
// after the Platform-API create returns, until it propagates. Probe with jittered exponential backoff
// up to a deadline (bounded well under the routes' maxDuration). The e2e override may only tighten it.
const READY_BASE_MS = 100;
const READY_CEIL_MS = 1500;
export const TURSO_READY_DEADLINE_MS = 30_000;

/** Caller-visible readiness exhaustion. Deliberately carries neither a database token/name nor a libSQL
 * error code: catalog reconnect logic must not mistake a fully-spent readiness budget for an early
 * connection failure and start a second full wait inside the same server request. */
export class TursoReadinessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`TursoCloud: database endpoint readiness timed out after ${timeoutMs}ms`);
    this.name = "TursoReadinessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function readyDeadlineMs(): number {
  const raw = process.env.RC_TURSO_READY_DEADLINE_MS?.trim();
  if (!raw) return TURSO_READY_DEADLINE_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0
    ? Math.min(n, TURSO_READY_DEADLINE_MS)
    : TURSO_READY_DEADLINE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jittered(ms: number): number {
  const j = ms * 0.25;
  return ms - j + Math.random() * 2 * j;
}

/** The first HTTP status found walking an error's `cause` chain (libSQL wraps an HttpServerError whose
 *  `.status` is the server's code) — undefined if none. */
function statusInCause(e: unknown): number | undefined {
  let cur: unknown = e;
  const seen = new Set<unknown>();
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const s = (cur as { status?: unknown }).status;
    if (typeof s === "number") return s;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A create→serve transient worth retrying: the new db's libSQL endpoint 404s (HttpServerError 404 —
 *  the db record exists but isn't serving yet) or its host isn't resolving yet (a DNS/connection error
 *  with no HTTP status). NOT an auth failure (401/403) or any other HTTP status — those must fail fast,
 *  not be masked by the readiness wait. */
function isEndpointNotReady(e: unknown): boolean {
  if (statusInCause(e) === 404) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|failed to lookup|InvalidUri/i.test(
    msg,
  );
}

export interface TursoCloudOptions {
  /** Platform API token (org-scoped) — creates/lists/deletes databases. */
  apiToken: string;
  /** Turso organization slug. */
  org: string;
  /** Group the per-channel databases live in (one group, many databases). */
  group: string;
  /** Group token (libSQL connect credential) — auths every database in the group. */
  authToken: string;
  /** Deployment scope embedded in every db name (`rc-<scope>-…`); isolates environments. Default `dev`. */
  scope?: string;
  /** Override the Platform API base (tests). */
  apiBase?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

export class TursoCloudDbLocator implements DbLocator {
  readonly #o: Required<Pick<TursoCloudOptions, "apiToken" | "org" | "group" | "authToken">> & {
    apiBase: string;
  };
  readonly #fetch: typeof fetch;
  // Databases we've confirmed/created — avoids repeated create-if-absent round trips. TTL-BOUNDED (name →
  // expiry), but never used by exists(): cold-open continuity classification must make a fresh Platform
  // GET because a cross-instance/operator delete can invalidate a positive immediately.
  readonly #known = new Map<string, number>();
  readonly #knownTtlMs: number;
  // The deployment scope embedded in every db name (`rc-<scope>-…`) and the per-scope cold-index name.
  // It separates normal routing/catalog names; it is not an ownership proof for deletion.
  readonly #scope: string;
  readonly #indexName: string;
  readonly #handoffName: string;

  constructor(o: TursoCloudOptions) {
    this.#o = {
      apiToken: o.apiToken,
      org: o.org,
      group: o.group,
      authToken: o.authToken,
      apiBase: o.apiBase ?? TURSO_API_BASE,
    };
    const f = o.fetchImpl ?? globalThis.fetch;
    if (f === undefined) throw new Error("TursoCloudDbLocator: global fetch is unavailable");
    this.#fetch = f.bind(globalThis);
    const ttl = Number.parseInt(process.env.RC_TURSO_KNOWN_TTL_MS ?? "", 10);
    this.#knownTtlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 300_000;
    // A Turso db name is [a-z0-9-], 1–36 chars; `rc-<scope>-<kind>-<16 hex>` must fit, so bound the scope
    // to SCOPE_MAX and reject an out-of-charset value rather than fail opaquely at create time.
    const scope = (o.scope ?? DEFAULT_SCOPE).toLowerCase();
    if (!new RegExp(`^[a-z0-9][a-z0-9-]{0,${SCOPE_MAX - 1}}$`).test(scope)) {
      throw new Error(
        `TursoCloudDbLocator: invalid db scope "${o.scope}" (need [a-z0-9-], ≤${SCOPE_MAX} chars)`,
      );
    }
    this.#scope = scope;
    this.#indexName = `${APP}-${scope}-index`;
    // `-hx` (handoff) is a fixed suffix distinct from the relay-channel kinds (s/b/c/x), parallel to
    // `-index`. It shares the ordinary routing prefix, which must not be treated as deletion authority.
    this.#handoffName = `${APP}-${scope}-hx`;
  }

  #isKnown(name: string): boolean {
    const exp = this.#known.get(name);
    if (exp === undefined) return false;
    if (exp <= Date.now()) {
      this.#known.delete(name);
      return false; // expired → force a Platform-API re-check
    }
    return true;
  }

  #rememberKnown(name: string): void {
    this.#known.set(name, Date.now() + this.#knownTtlMs);
  }

  /** The channel KIND, for a meaningful + distinguishable name: `s` (session), `b` (bus), selected-A1
   *  `c` (server control), or `x` (other). */
  #kind(token: string): string {
    if (token.startsWith("sess:")) return "s";
    if (token.startsWith("bus:")) return "b";
    if (token.startsWith("ctl:a1:")) return "c";
    return "x";
  }

  /** Stable, collision-resistant, human-scannable Turso db name (`rc-<scope>-<kind>-<16 hex>`). */
  #dbName(token: string): string {
    const hash = createHash("sha256").update(token, "utf8").digest("hex").slice(0, HASH_LEN);
    return `${APP}-${this.#scope}-${this.#kind(token)}-${hash}`;
  }

  config(token: string): { url: string; authToken: string } {
    return this.#connect(this.#dbName(token));
  }

  idFor(token: string): string {
    return this.#dbName(token);
  }

  /** The auth token a retention probe uses to connect a catalogued db by url (the group token). */
  probeAuthToken(): string {
    return this.#o.authToken;
  }

  /** Connection for a db by NAME — built from the name, not the API-returned Hostname, so it is always
   *  byte-identical to config()'s url for the same session (the sweep busy-set/eviction key matches). */
  #connect(name: string): { url: string; authToken: string } {
    return { url: `libsql://${name}-${this.#o.org}.turso.io`, authToken: this.#o.authToken };
  }

  #api(path: string): string {
    return `${this.#o.apiBase}/v1/organizations/${this.#o.org}${path}`;
  }

  #authHeader(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.apiToken}` };
  }

  async ensure(token: string): Promise<void> {
    await this.#createIfAbsent(this.#dbName(token));
  }

  /** Wait out the create→serve propagation window: after the Platform-API create returns, the db's libSQL
   *  endpoint can briefly 404 (or its host not resolve) until it propagates, and Turso exposes no readiness
   *  signal — so probe `SELECT 1` on the just-opened client with bounded backoff, retrying ONLY the
   *  not-ready transients (HTTP 404 / unresolved host) and failing fast on anything else (auth, real 5xx).
   *  Each libSQL query is a stateless HTTP request, so the same client re-probes the endpoint each time. */
  async awaitReady(client: Client, _token: string): Promise<void> {
    const timeoutMs = readyDeadlineMs();
    const deadline = Date.now() + timeoutMs;
    let delay = READY_BASE_MS;
    let attempts = 0;
    let expired = false;
    let timeoutLogged = false;
    const timeoutError = new TursoReadinessTimeoutError(timeoutMs);
    const failTimeout = (): TursoReadinessTimeoutError => {
      if (!timeoutLogged) {
        timeoutLogged = true;
        console.error(
          `[turso] db endpoint not serving after ${attempts} completed probe(s) / ${timeoutMs}ms`,
        );
      }
      return timeoutError;
    };

    if (timeoutMs === 0) throw failTimeout();

    let rejectBoundary: (reason: unknown) => void = () => {};
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    const timer = setTimeout(() => {
      expired = true;
      rejectBoundary(failTimeout());
    }, timeoutMs);
    const probes = (async () => {
      for (;;) {
        if (expired || Date.now() >= deadline) throw failTimeout();
        try {
          await client.execute("SELECT 1");
          if (expired || Date.now() >= deadline) throw failTimeout();
          if (attempts > 0) console.warn(`[turso] db endpoint ready after ${attempts} probe(s)`);
          return;
        } catch (e) {
          if (e === timeoutError) throw e;
          attempts++;
          if (!isEndpointNotReady(e)) throw e;
          const remaining = deadline - Date.now();
          if (expired || remaining <= 0) throw failTimeout();
          await sleep(Math.min(jittered(delay), remaining));
          delay = Math.min(delay * 2, READY_CEIL_MS);
        }
      }
    })();
    // A libSQL request has no AbortSignal surface and may settle after the caller-visible wall. Observe
    // that late settlement so closing its half-open client cannot create an unhandled rejection.
    void probes.catch(() => undefined);
    try {
      await Promise.race([probes, boundary]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The per-scope channel catalog connection. Ordinary retention is disabled; this catalog remains
   *  useful for lookup. */
  indexConfig(): { url: string; authToken: string } {
    return this.#connect(this.#indexName);
  }

  /** Provision the catalog db (idempotent), so a fresh deployment's first index write can connect. */
  async ensureIndex(): Promise<void> {
    // This runs only when a backend instance builds/rebuilds its catalog client. Never trust a positive
    // memo here: a cached catalog namespace may have been deleted by another instance/operator, and the
    // reconnect path must force create-or-409 confirmation before opening its replacement client.
    this.#known.delete(this.#indexName);
    await this.#createIfAbsent(this.#indexName);
  }

  /** The dedicated ephemeral-handoff store db for this scope (`rc-<scope>-hx`), separate from channel dbs
   *  and the cold index so its one-time/short-TTL lifecycle never entangles the frame log or retention. */
  handoffConfig(): { url: string; authToken: string } {
    return this.#connect(this.#handoffName);
  }

  /** Provision the handoff db (idempotent), so the first PUT can connect. */
  async ensureHandoff(): Promise<void> {
    await this.#createIfAbsent(this.#handoffName);
  }

  /** Create a database if absent (idempotent). A conflict — 409, or a 400/422 confirmed via GET — means
   *  it already exists → success. */
  async #createIfAbsent(name: string): Promise<void> {
    if (this.#isKnown(name)) return;
    const res = await this.#fetch(this.#api("/databases"), {
      method: "POST",
      headers: { ...this.#authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ name, group: this.#o.group }),
    });
    if (res.ok || res.status === 409) {
      this.#rememberKnown(name);
      return;
    }
    if ((res.status === 400 || res.status === 422) && (await this.#existsName(name))) return;
    throw new Error(
      `TursoCloud: create database "${name}" failed: ${res.status} ${await safeText(res)}`,
    );
  }

  async exists(token: string): Promise<boolean> {
    return this.#existsName(this.#dbName(token), false);
  }

  /** Drop the positive existence memo for the token so the next exists() re-checks the Platform API.
   *  The backend calls this after a cached-client channel-gone error; its durable catalog then turns a
   *  confirmed missing previously-known database into a hard storage-loss failure, never an ensure(). */
  forget(token: string): void {
    this.#known.delete(this.#dbName(token));
  }

  async #existsName(name: string, allowKnown = true): Promise<boolean> {
    if (allowKnown && this.#isKnown(name)) return true;
    const res = await this.#fetch(this.#api(`/databases/${name}`), { headers: this.#authHeader() });
    if (res.status === 200) {
      this.#rememberKnown(name);
      return true;
    }
    if (res.status === 404) {
      this.#known.delete(name);
      return false;
    }
    throw new Error(
      `TursoCloud: get database "${name}" failed: ${res.status} ${await safeText(res)}`,
    );
  }

  // Low-level destructive diagnostic primitive. No HTTP or production path calls it. Ordinary channel
  // retention is a deliberate no-op: neither this catalog nor last activity authenticates collection.
  async dropStored(name: string): Promise<void> {
    const res = await this.#fetch(this.#api(`/databases/${encodeURIComponent(name)}`), {
      method: "DELETE",
      headers: this.#authHeader(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `TursoCloud: delete database "${name}" failed: ${res.status} ${await safeText(res)}`,
      );
    }
    this.#known.delete(name); // force the next operation to re-check physical existence
  }

  /** Low-level diagnostic primitive that drops this scope's empty catalog db. */
  async dropIndex(): Promise<void> {
    await this.dropStored(this.#indexName);
  }

  /** Platform-API names of every db in THIS scope (`rc-<scope>-*`: session channels, bus, and the index). The
   *  trailing `-` in the prefix keeps `pr-abc` from matching `pr-abcd`. */
  async #listScopeNames(): Promise<string[]> {
    const res = await this.#fetch(this.#api("/databases"), { headers: this.#authHeader() });
    if (!res.ok) {
      throw new Error(`TursoCloud: list databases failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { databases?: Array<{ Name?: string; name?: string }> };
    const prefix = `${APP}-${this.#scope}-`;
    return (body.databases ?? [])
      .map((d) => d.Name ?? d.name ?? "")
      .filter((n) => n.startsWith(prefix));
  }

  /**
   * Delete EVERY db matching this scope (`rc-<scope>-*`) via the Platform API — cataloged or NOT. This
   * dangerous low-level diagnostic primitive can also reclaim dbs a crashed/early-frozen relay created
   * (via ensure()) but never published/catalogued (0-frame orphans the index never lists).
   * Returns {deleted} for this pass and {remaining} re-listed AFTER the deletes — a nonzero `remaining`
   * means a still-live seed relay recreated a db mid-pass, so the caller should loop until it's 0 (i.e.
   * until the relays have aged out). The prefix is not proof of exact deployment ownership; callers must
   * independently review the exact target list. No HTTP or production path calls this method.
   */
  async dropScope(): Promise<{ deleted: number; remaining: number }> {
    const names = await this.#listScopeNames();
    for (const name of names) await this.dropStored(name);
    const remaining = await this.#listScopeNames();
    return { deleted: names.length, remaining: remaining.length };
  }
}

/**
 * The per-channel storage locator chosen from the environment — this is the single switch between
 * cloud and local-file storage. If the Turso Cloud credentials are all present we use Turso Cloud
 * (one database per channel token). Off Vercel, an incomplete/absent tuple falls back to local files
 * (one db per channel under RC_SQLITE_DIR). On Vercel, that fallback is forbidden: even an explicitly
 * configured RC_SQLITE_DIR is per-instance/ephemeral and cannot truthfully satisfy the durable-recovery
 * capability this backend advertises.
 *
 * The connect credential is read from `TURSO_GROUP_AUTH_TOKEN`, NOT the conventional `TURSO_AUTH_TOKEN`,
 * ON PURPOSE: the Vercel↔Turso integration OWNS `TURSO_AUTH_TOKEN` (+ `TURSO_DATABASE_URL`) and sets it
 * to a PER-DATABASE token for the integration's own managed db. Our fleet needs a GROUP token (one JWT
 * that auths every per-channel db in the group), so reusing that name would (a) be clobbered when the
 * integration re-syncs and (b) connect with the wrong-scope token. A distinct name keeps the two
 * independent. The Platform-API token / org / group names don't collide (the integration sets neither).
 */
export function selectLocatorFromEnv(): DbLocator {
  const apiToken = process.env.TURSO_API_TOKEN?.trim();
  const org = process.env.TURSO_ORG?.trim();
  const group = process.env.TURSO_GROUP?.trim();
  const authToken = process.env.TURSO_GROUP_AUTH_TOKEN?.trim();
  const complete = Boolean(apiToken && org && group && authToken);
  if (process.env.VERCEL === "1" && !complete) {
    throw new Error(
      "sqlite on Vercel requires the complete Turso Cloud fleet configuration " +
        "(TURSO_API_TOKEN, TURSO_ORG, TURSO_GROUP, TURSO_GROUP_AUTH_TOKEN)",
    );
  }
  if (apiToken && org && group && authToken) {
    return new TursoCloudDbLocator({ apiToken, org, group, authToken, scope: tursoScopeFromEnv() });
  }
  return new FileDbLocator();
}

/**
 * The deployment scope embedded in every db name (`rc-<scope>-…`). Only an EXPLICIT
 * `VERCEL_ENV=production` → `prod`; a preview deploy → `pr-<7-char commit sha>` (ties non-prod to the
 * deployment, so two concurrent preview deploys of DIFFERENT commits get distinct scopes and can't
 * reclaim each other's dbs); anything else — development, an UNSET env (local / self-host / CI), or an
 * unknown value — → `dev`. Unset deliberately resolves to `dev`, NOT `prod`: the `prod` scope is the
 * precious one, so it must be opted into explicitly (Vercel always sets VERCEL_ENV=production on the
 * production deployment; a self-host sets RC_TURSO_DB_SCOPE=prod). Ordinary storage scope is
 * overridable with RC_TURSO_DB_SCOPE and bounded to SCOPE_MAX. The HTTP dev-sweep route is disabled:
 * this truncated name prefix is routing metadata, not exact deployment-deletion authority. Ordinary
 * indexed retention is a no-op.
 */
export function tursoScopeFromEnv(): string {
  const explicit = process.env.RC_TURSO_DB_SCOPE?.trim();
  if (explicit) return explicit;
  const env = process.env.VERCEL_ENV?.trim().toLowerCase();
  if (env === "production") return "prod";
  if (env === "preview") {
    const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return sha ? `pr-${sha.slice(0, 7)}` : "preview";
  }
  return "dev"; // development / unset / unknown — never `prod` unless explicitly asked
}
