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

export function tursoConfigured(): boolean {
  const url = process.env.TURSO_DATABASE_URL;
  return url !== undefined && url.trim() !== "";
}
