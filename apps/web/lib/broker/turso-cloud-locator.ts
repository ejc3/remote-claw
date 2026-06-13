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
  // Databases we've already confirmed/created this process — avoids a Platform API round-trip per call.
  readonly #known = new Set<string>();

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
  }

  /** Stable, collision-resistant, Turso-valid db name from a channel token (`rc-<32 hex>`). */
  #dbName(token: string): string {
    return `rc-${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 32)}`;
  }

  config(token: string): { url: string; authToken: string } {
    return {
      url: `libsql://${this.#dbName(token)}-${this.#o.org}.turso.io`,
      authToken: this.#o.authToken,
    };
  }

  #api(path: string): string {
    return `${this.#o.apiBase}/v1/organizations/${this.#o.org}${path}`;
  }

  #authHeader(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.apiToken}` };
  }

  /** Create the database if absent (idempotent). A name conflict means it already exists → success. */
  async ensure(token: string): Promise<void> {
    const name = this.#dbName(token);
    if (this.#known.has(name)) return;
    const res = await this.#fetch(this.#api("/databases"), {
      method: "POST",
      headers: { ...this.#authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ name, group: this.#o.group }),
    });
    if (res.ok || res.status === 409) {
      this.#known.add(name);
      return;
    }
    // Some Platform API versions report an existing name as 400/422; confirm via GET before failing.
    if ((res.status === 400 || res.status === 422) && (await this.exists(token))) return;
    throw new Error(
      `TursoCloud: create database "${name}" failed: ${res.status} ${await safeText(res)}`,
    );
  }

  async exists(token: string): Promise<boolean> {
    const name = this.#dbName(token);
    if (this.#known.has(name)) return true;
    const res = await this.#fetch(this.#api(`/databases/${name}`), { headers: this.#authHeader() });
    if (res.status === 200) {
      this.#known.add(name);
      return true;
    }
    if (res.status === 404) return false;
    throw new Error(
      `TursoCloud: get database "${name}" failed: ${res.status} ${await safeText(res)}`,
    );
  }

  /**
   * Retention support. Turso's Platform API has NO last-activity timestamp (list/usage give cumulative
   * metrics only), so the sweep uses each db's OWN MAX(created_at) as the idle signal — listStored just
   * enumerates the candidate dbs, the backend probes each. We restrict to OUR `rc-` databases so the
   * sweep can never delete another db that happens to share the group. The connection `url` is built the
   * SAME way config() builds it (NOT the API-returned Hostname) so the sweep's busy-set/eviction key
   * matches a live session's cached client exactly.
   */
  async listStored(): Promise<Array<{ id: string; url: string; authToken: string }>> {
    const res = await this.#fetch(
      this.#api(`/databases?group=${encodeURIComponent(this.#o.group)}`),
      { headers: this.#authHeader() },
    );
    if (!res.ok) {
      throw new Error(`TursoCloud: list databases failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { databases?: Array<{ Name?: unknown }> };
    const out: Array<{ id: string; url: string; authToken: string }> = [];
    for (const db of body.databases ?? []) {
      const name = db.Name;
      if (typeof name !== "string" || !name.startsWith("rc-")) continue; // only our per-session dbs
      out.push({
        id: name,
        url: `libsql://${name}-${this.#o.org}.turso.io`,
        authToken: this.#o.authToken,
      });
    }
    return out;
  }

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
