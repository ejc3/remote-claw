const DIGITS = /^\d+$/;

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

/** True when this deployment can hold per-session sqlite dbs the retention sweep must reclaim. NOT just
 *  when sqlite is the DEFAULT: `sqlite` is per-request selectable (REQUESTABLE), so a vercel/temporal
 *  -default deployment with Turso Cloud creds still provisions real per-session cloud dbs via
 *  `?backend=sqlite` — those must be swept too, or they grow unbounded. So: sqlite is the default, OR the
 *  Turso Cloud creds are present (mirrors the drain gate's "default OR store-configured" shape). Both
 *  storage modes then sweep by walking a COLD session index in resumable batches (file: a local
 *  `_index.db`; cloud: an `rc-index` Turso db), dropping idle dbs by each db's own MAX(created_at). */
export function sqliteConfigured(): boolean {
  if (process.env.BROKER_BACKEND?.trim() === "sqlite") return true;
  return Boolean(
    process.env.TURSO_API_TOKEN?.trim() &&
      process.env.TURSO_ORG?.trim() &&
      process.env.TURSO_GROUP?.trim() &&
      process.env.TURSO_AUTH_TOKEN?.trim(),
  );
}
