import { timingSafeEqual, utf8 } from "@remote-claw/clawsec";

const DIGITS = /^\d+$/;

/** Whether this cron request may run the retention sweep. Vercel sends `Authorization: Bearer
 *  $CRON_SECRET` on cron invocations when CRON_SECRET is set; we require an exact match. With NO secret
 *  we allow the route only in a non-production, off-Vercel environment (local dev / a manual curl) and
 *  FAIL CLOSED everywhere else — a missing secret in ANY production deploy (Vercel or self-hosted) must
 *  not leave this endpoint open. (Moved here from the removed Temporal drain gate; it is a generic
 *  CRON_SECRET check, never Temporal-specific.) */
export function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL !== "1" && process.env.NODE_ENV !== "production";
  const got = req.headers.get("authorization");
  if (got === null) return false;
  // timingSafeEqual throws on unequal lengths, so the length guard is required (not redundant); the
  // Bearer prefix and secret length are fixed, so it leaks nothing useful.
  const a = utf8(got);
  const b = utf8(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function retentionMs(): number {
  // BROKER_RETENTION_MS is a strictly positive integer number of milliseconds.
  const raw = process.env.BROKER_RETENTION_MS?.trim();
  if (raw !== undefined && DIGITS.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RETENTION_MS;
}

/** True when this deployment can hold per-channel SQLite dbs the retention sweep must reclaim. NOT just
 *  when sqlite is the DEFAULT: `sqlite` is per-request selectable (REQUESTABLE), so a vercel-default
 *  deployment with Turso Cloud creds still provisions real per-channel cloud dbs via `?backend=sqlite` —
 *  those must be swept too, or they grow unbounded. So: sqlite is the default, OR the Turso Cloud creds
 *  are present. Both storage modes then sweep by walking a COLD channel catalog in resumable batches (file:
 *  a local `_index.db`; cloud: an `rc-index` Turso db), dropping idle dbs by each db's own MAX(created_at). */
export function sqliteConfigured(): boolean {
  if (process.env.BROKER_BACKEND?.trim() === "sqlite") return true;
  return Boolean(
    process.env.TURSO_API_TOKEN?.trim() &&
      process.env.TURSO_ORG?.trim() &&
      process.env.TURSO_GROUP?.trim() &&
      // The GROUP connect token — a distinct name from the integration-owned TURSO_AUTH_TOKEN; see
      // selectLocatorFromEnv() in lib/broker/turso-cloud-locator.ts for why.
      process.env.TURSO_GROUP_AUTH_TOKEN?.trim(),
  );
}
