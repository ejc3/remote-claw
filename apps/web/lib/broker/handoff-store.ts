import { type Client, createClient } from "@libsql/client";
import { type DbLocator, FileDbLocator } from "./sqlite-multi";
import { selectLocatorFromEnv } from "./turso-cloud-locator";

// The server half of the ephemeral one-time-handoff (docs/ephemeral-handoff.md). A zero-knowledge,
// one-time, short-TTL blob store: one small table, SEPARATE from the per-session frame dbs and the cold
// index. It holds ONLY public one-way hashes + an opaque AES-256-GCM blob it cannot read:
//
//   handoff(id, proof_hash, ct, expires_at)
//     id          = hex(SHA256(OTK))                 — public lookup key (the OTK never reaches the server)
//     proof_hash  = hex(SHA256(HKDF(OTK,"claim")))   — so an observer of `id` alone cannot claim/burn the row
//     ct          = hex(sealed handoff box)           — undecryptable without the OTK
//     expires_at  = epoch ms
//
// The claim is a SINGLE atomic statement (DELETE ... RETURNING) gated on id AND proof_hash, so (a) exactly
// one of two concurrent claims wins, (b) a wrong/absent proof deletes nothing (an `id`-only edge/log observer
// cannot burn it), and (c) the row is burned-on-touch even when expired (then the ct is discarded). This is
// the per-session-SQLite single-writer/atomic discipline (sqlite-multi.ts) applied to a one-time row.
//
// Expiry has THREE reapers (so an unclaimed row's at-rest lifetime tracks its TTL): claim-time burn-on-touch,
// a dedicated frequent cron (sweepExpired), and an opportunistic DELETE batched into every PUT (put()).

const HANDOFF_DDL = [
  `CREATE TABLE IF NOT EXISTS handoff (
     id          TEXT PRIMARY KEY,
     proof_hash  TEXT NOT NULL,
     ct          TEXT NOT NULL,
     expires_at  INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS handoff_expires ON handoff (expires_at)",
];

export class HandoffStore {
  readonly #client: Client;
  #migrated: Promise<void> | undefined;

  constructor(client: Client) {
    this.#client = client;
  }

  close(): void {
    try {
      this.#client.close();
    } catch {
      /* already closed */
    }
  }

  #ensure(): Promise<void> {
    if (this.#migrated === undefined) {
      this.#migrated = this.#client.batch(HANDOFF_DDL, "write").then(
        () => undefined,
        (e) => {
          this.#migrated = undefined;
          throw e;
        },
      );
    }
    return this.#migrated;
  }

  /** Store a sealed handoff. Returns true if inserted, false on an `id` collision (the caller returns 409
   *  so the host re-mints a fresh OTK rather than publishing a QR for a row it doesn't own).
   *
   *  Opportunistic GC: the insert is batched (ONE write transaction) AFTER a `DELETE … WHERE expires_at <= now`,
   *  so every PUT reaps expired rows — belt-and-suspenders alongside the dedicated cron and the claim-time
   *  burn, so an unclaimed row's at-rest lifetime tracks its TTL even if the cron is degraded. */
  async put(
    id: string,
    proofHash: string,
    ct: string,
    expiresAt: number,
    now: number = Date.now(),
  ): Promise<boolean> {
    await this.#ensure();
    const results = await this.#client.batch(
      [
        { sql: "DELETE FROM handoff WHERE expires_at <= ?", args: [now] },
        {
          sql: "INSERT INTO handoff (id, proof_hash, ct, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
          args: [id, proofHash, ct, expiresAt],
        },
      ],
      "write",
    );
    return (results[1]?.rowsAffected ?? 0) > 0;
  }

  /** Atomically burn-and-return the row for `id` IFF `proofHash` matches. One statement ⇒ exactly one
   *  concurrent claimant wins; a wrong/absent proof returns null (and deletes nothing); an expired row is
   *  burned but its ct is NOT served. Returns the ct (hex-encoded box) or null (uniform miss). */
  async claim(id: string, proofHash: string, now: number): Promise<string | null> {
    await this.#ensure();
    const r = await this.#client.execute({
      sql: "DELETE FROM handoff WHERE id = ? AND proof_hash = ? RETURNING ct, expires_at",
      args: [id, proofHash],
    });
    const row = r.rows[0];
    if (row === undefined) return null; // wrong id/proof, or already claimed
    if (Number(row.expires_at) <= now) return null; // burned an expired row; refuse to serve it
    return String(row.ct);
  }

  /** Delete every expired row — the dedicated cron sweep (PUT also reaps expired rows inline; see put()).
   *  Returns the count removed. */
  async sweepExpired(now: number): Promise<number> {
    await this.#ensure();
    const r = await this.#client.execute({
      sql: "DELETE FROM handoff WHERE expires_at <= ?",
      args: [now],
    });
    return r.rowsAffected;
  }
}

// Per-instance cached store (one client per serverless instance, like the broker backend cache). The first
// build provisions + readiness-gates the db; a failure clears the cache so the next call retries.
let cached: Promise<HandoffStore> | undefined;

export function getHandoffStore(): Promise<HandoffStore> {
  if (cached === undefined) {
    const p: Promise<HandoffStore> = build().catch((e) => {
      if (cached === p) cached = undefined; // only clear if still ours — don't clobber a newer build
      throw e;
    });
    cached = p;
  }
  return cached;
}

/** Drop the cached store so the next getHandoffStore() rebuilds. Call after a query failure so a dead
 *  cached client (rotated token, dead endpoint, network partition) self-heals instead of 500ing for the
 *  whole instance lifetime. */
export function resetHandoffStore(): void {
  cached = undefined;
}

/** True if the configured environment supports the handoff store. Calls handoffConfig() (not just checks
 *  it exists) so a FileDbLocator on Vercel — which fails closed — correctly reports unavailable, and a
 *  misconfigured locator (e.g. invalid scope) surfaces as not-configured rather than throwing. */
export function handoffConfigured(): boolean {
  try {
    selectLocatorFromEnv().handoffConfig?.();
    return true;
  } catch {
    return false;
  }
}

async function build(): Promise<HandoffStore> {
  const locator: DbLocator = selectLocatorFromEnv();
  if (locator.handoffConfig === undefined) {
    throw new Error("handoff store unavailable: the configured locator has no handoffConfig()");
  }
  try {
    await locator.ensureHandoff?.();
    const client = createClient(locator.handoffConfig());
    try {
      await locator.prepare?.(client); // file: WAL; cloud: no-op
      await locator.awaitReady?.(client, "handoff"); // cloud create→serve gate (tursodatabase/libsql-client-ts#346)
    } catch (e) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      throw e;
    }
    return new HandoffStore(client);
  } catch (e) {
    // Surface the real cause to logs (the route returns an opaque 500) so a misconfig is diagnosable.
    console.error("[handoff] store build failed:", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Test seam: build a store over an explicit locator (e.g. a tmp-dir FileDbLocator), bypassing the env
 *  + the per-instance cache, so a test can exercise the real schema/atomic-claim against a local file db. */
export async function handoffStoreForTest(
  locator: DbLocator = new FileDbLocator(),
): Promise<HandoffStore> {
  if (locator.handoffConfig === undefined) throw new Error("locator has no handoffConfig()");
  await locator.ensureHandoff?.();
  const client = createClient(locator.handoffConfig());
  await locator.prepare?.(client);
  return new HandoffStore(client);
}
