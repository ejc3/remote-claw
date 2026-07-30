import { getBackend } from "../../../../lib/broker";
import { selectLocatorFromEnv } from "../../../../lib/broker/turso-cloud-locator";
import { gate } from "../_gate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Dev/CI-only cleanup: reclaims the per-channel Turso Cloud dbs the sqlite app-e2e creates, so a
// preview/CI run CLEANS UP AFTER ITSELF instead of leaking channel dbs.
//
// It deletes EVERY db in THIS deployment's scope (`rc-<scope>-*`) by name via the Platform API
// (locator.dropScope) — NOT the cold-index sweep — because an e2e host relay can create a db (via
// ensure) but crash/freeze before publishing, leaving a 0-frame db the index never catalogued; only a
// by-name delete reclaims those. One call = one delete pass; it returns `remaining` (re-listed after the
// deletes), and the CI step loops until `remaining` is 0 — i.e. until the still-live e2e host relays
// (re-announcing to the bus until they exit) have aged out and stop recreating dbs.
//
// PROD-SAFE on two independent levels: (1) the dev gate (apps/web/app/api/dev/_gate.ts) — a matching
// DEV_SEED_TOKEN on a NON-production deploy only; it can NEVER run on production. (2) scope — a preview's
// scope is `pr-<commit sha>`, so dropScope only ever names `rc-pr-<sha>-…`, never a `rc-prod-` channel db.
// (Local/file dev has no scope ⇒ falls back to the cold-index sweep.)
const DIGITS = /^\d+$/;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function POST(req: Request): Promise<Response> {
  const g = gate(req);
  if (g instanceof Response) return g; // 404 (not enabled) / 400 (non-loopback locally)

  try {
    // Cloud: delete the whole scope by name (one pass; CI loops on `remaining`).
    const locator = selectLocatorFromEnv();
    if (locator.dropScope !== undefined) {
      return Response.json(await locator.dropScope());
    }

    // File/local fallback (no cloud scope): the index sweep + drop the (now-empty) index. `retain`
    // (ms, default 0) bounds staleness; non-numeric → 0 (never NaN, which would sweep nothing).
    const raw = new URL(req.url).searchParams.get("retain")?.trim();
    const retainMs = raw !== undefined && DIGITS.test(raw) ? Number(raw) : 0;
    const backend = await getBackend("sqlite");
    if (backend.sweep === undefined) return Response.json({ deleted: 0, remaining: 0 });
    const deleted = await backend.sweep(retainMs);
    let indexDropped = true;
    try {
      await backend.dropIndex?.();
    } catch (e) {
      indexDropped = false;
      console.warn("[dev/sweep] index drop failed (sweep still succeeded):", errMsg(e));
    }
    return Response.json({ deleted, remaining: 0, indexDropped });
  } catch (e) {
    const message = errMsg(e);
    console.error("[dev/sweep] cleanup failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
