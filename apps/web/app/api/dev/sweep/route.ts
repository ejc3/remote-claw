import { getBackend } from "../../../../lib/broker";
import { gate } from "../seed/gate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Dev/CI-only retention sweep: reclaims the per-session Turso Cloud dbs the sqlite app-e2e creates, so a
// preview/CI run CLEANS UP AFTER ITSELF instead of leaking session dbs until the 7-day prod cron. It runs
// the SAME cold-index sweep as /api/cron/retention, just with a caller-supplied (short) window.
//
// PROD-SAFE on two independent levels:
//  1. Gate — the SAME dev-seed gate as /api/dev/seed: a matching DEV_SEED_TOKEN on a NON-production
//     preview (or local dev) only; it can NEVER run on a production deployment (the gate refuses when
//     VERCEL_ENV=production).
//  2. Namespace — even on a preview, selectLocatorFromEnv() derives a per-deployment db-name scope
//     (production = `rc-prod-…`, preview = `rc-pr-<commit sha>-…`), so this sweep walks the preview's OWN
//     `rc-pr-<sha>-index` and can't even ENUMERATE a production `rc-prod-` session db, let alone drop one
//     — though both share one Turso org/group. (Busy-set + MAX(created_at) re-probe further guard a live db.)
// Production reclamation stays the /api/cron/retention cron (7-day default), scoped to prod's namespace.
const DIGITS = /^\d+$/;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
    const swept = await backend.sweep(retainMs);
    // This deployment's scope is short-lived (a preview tied to the commit), so after reclaiming its
    // sessions, drop the scope's own cold-index db too — otherwise every preview deploy leaves an empty
    // `rc-<scope>-index` behind. dropIndex only deletes the catalog when it's EMPTY, so a partial sweep
    // can't orphan remaining sessions. BEST-EFFORT: a dropIndex hiccup must not mask a successful sweep
    // (the empty index is harmless; a later run reclaims it). The dev-seed gate already bars production.
    let indexDropped = true;
    try {
      await backend.dropIndex?.();
    } catch (e) {
      indexDropped = false;
      console.warn("[dev/sweep] index drop failed (sweep still succeeded):", errMsg(e));
    }
    return Response.json({ swept, indexDropped });
  } catch (e) {
    const message = errMsg(e);
    console.error("[dev/sweep] sweep failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
