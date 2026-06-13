import { createHash } from "node:crypto";
import { type DbLocator, FileDbLocator } from "./sqlite-multi";

// Cloud storage for the per-session libSQL backend: ONE Turso Cloud database per channel token. This is
// the SAME backend as the local-file mode — only the storage location differs. A token maps to a Turso
// database created on demand via the Platform API and connected with a GROUP token (one JWT that auths
// every database in the group), so a Vercel deployment with the Turso integration drives both the
// connection (group token) and creation (Platform API token) from env. See lib/broker/README.md.
//
// Why a hashed db name: a Turso database name is length/charset-limited and the raw channel token
// (`sess:<32hex>:<sid>`) is too long, so we derive a stable, collision-resistant name from it. The name
// is purely internal — the channel token stays the addressing key everywhere else.

const TURSO_API_BASE = "https://api.turso.tech";

// The shared catalog db for the cold session index (one per group). A reserved name that can never
// collide with a session db (those are `rc-<32 hex>`), and never itself catalogued/swept.
const INDEX_DB_NAME = "rc-index";

export interface TursoCloudOptions {
  /** Platform API token (org-scoped) — creates/lists/deletes databases. */
  apiToken: string;
  /** Turso organization slug. */
  org: string;
  /** Group the per-session databases live in (one group, many databases). */
  group: string;
  /** Group token (libSQL connect credential) — auths every database in the group. */
  authToken: string;
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
  // Databases we've confirmed/created — avoids a Platform API round-trip per call. TTL-BOUNDED (name →
  // expiry): the cache is per-process, but db create/delete is cluster-wide, so a positive entry can go
  // stale when ANOTHER instance (or the retention cron) drops the db. The TTL bounds that staleness and
  // makes it self-heal — after expiry the next call re-validates via the Platform API instead of opening
  // a connection to a deleted db.
  readonly #known = new Map<string, number>();
  readonly #knownTtlMs: number;

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

  /** Stable, collision-resistant, Turso-valid db name from a channel token (`rc-<32 hex>`). */
  #dbName(token: string): string {
    return `rc-${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 32)}`;
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

  /** The shared catalog db connection for the cold session index (retention strategy B). */
  indexConfig(): { url: string; authToken: string } {
    return this.#connect(INDEX_DB_NAME);
  }

  /** Provision the catalog db (idempotent), so a fresh deployment's first index write can connect. */
  async ensureIndex(): Promise<void> {
    await this.#createIfAbsent(INDEX_DB_NAME);
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
    return this.#existsName(this.#dbName(token));
  }

  async #existsName(name: string): Promise<boolean> {
    if (this.#isKnown(name)) return true;
    const res = await this.#fetch(this.#api(`/databases/${name}`), { headers: this.#authHeader() });
    if (res.status === 200) {
      this.#rememberKnown(name);
      return true;
    }
    if (res.status === 404) return false;
    throw new Error(
      `TursoCloud: get database "${name}" failed: ${res.status} ${await safeText(res)}`,
    );
  }

  // Retention uses the COLD session index (indexConfig/ensureIndex above), NOT a fleet list: Turso's
  // list-databases is un-paginated and exposes no last-activity, so it can't scale. The sweep reads the
  // index, probes each candidate's own MAX(created_at), and drops the idle ones via dropStored.
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
    this.#known.delete(name); // forget it so a later publish re-provisions a fresh db
  }
}

/**
 * The per-session storage locator chosen from the environment — this is the single switch between
 * cloud and local-file storage. If the Turso Cloud credentials are all present we use Turso Cloud
 * (one database per session); otherwise we use local files (one db per session under RC_SQLITE_DIR).
 */
export function selectLocatorFromEnv(): DbLocator {
  const apiToken = process.env.TURSO_API_TOKEN?.trim();
  const org = process.env.TURSO_ORG?.trim();
  const group = process.env.TURSO_GROUP?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (apiToken && org && group && authToken) {
    return new TursoCloudDbLocator({ apiToken, org, group, authToken });
  }
  return new FileDbLocator();
}
