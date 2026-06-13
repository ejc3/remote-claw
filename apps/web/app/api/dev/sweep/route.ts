import { getBackend } from "../../../../lib/broker";
import { gate } from "../seed/gate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Dev/CI-only retention sweep: reclaims the per-session Turso Cloud dbs the sqlite app-e2e creates, so a
// preview/CI run CLEANS UP AFTER ITSELF instead of leaking session dbs until the 7-day prod cron. It runs
// the SAME cold-index sweep as /api/cron/retention, just with a caller-supplied (short) window.
//
// Gated by the SAME dev-seed gate as /api/dev/seed: a matching DEV_SEED_TOKEN on a NON-production preview
// (or local dev) only — it can NEVER run on production (the gate refuses when VERCEL_ENV=production), so
// the aggressive short window here cannot reap real prod sessions. Production reclamation stays the
// /api/cron/retention cron with its 7-day default. (The sweep's own busy-set still protects any db with a
// live subscriber, and it re-probes MAX(created_at) before dropping — see SqliteMultiBackend#sweep.)
const DIGITS = /^\d+$/;

export async function POST(req: Request): Promise<Response> {
  const g = gate(req);
  if (g instanceof Response) return g; // 404 (not enabled) / 400 (non-loopback locally)

  // `retain` = staleness window in ms; default 0 → reclaim every db not written within the window. A
  // non-numeric value falls back to 0 rather than NaN (NaN cutoff would make MAX(created_at) < cutoff
  // false for every db → silently sweep nothing, defeating the cleanup).
  const raw = new URL(req.url).searchParams.get("retain")?.trim();
  const retainMs = raw !== undefined && DIGITS.test(raw) ? Number(raw) : 0;

  try {
    const backend = await getBackend("sqlite");
    if (backend.sweep === undefined) return Response.json({ swept: 0 });
    return Response.json({ swept: await backend.sweep(retainMs) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[dev/sweep] sweep failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
