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

/** True when this deployment's durable backend is the per-session sqlite backend — i.e. there is a
 *  per-session store for the retention sweep to operate on. Both storage modes sweep idle session dbs by
 *  walking a COLD session index in resumable batches (file: a local `_index.db`; cloud: an `rc-index`
 *  Turso db) and dropping the idle ones (each db's own MAX(created_at) is the idle signal — Turso exposes
 *  no last-activity timestamp). */
export function sqliteConfigured(): boolean {
  return process.env.BROKER_BACKEND?.trim() === "sqlite";
}
