import { getHandoffStore, handoffConfigured } from "../../../../lib/broker/handoff-store";
import { authorized } from "../retention/gate";

// Dedicated, FREQUENT sweep of expired one-time-handoff rows (docs/ephemeral-handoff.md §3.2). Separate
// from the once-daily session-retention cron so an unclaimed handoff's at-rest lifetime tracks its 10-min
// TTL, not 24h. Belt-and-suspenders: claims delete on success and PUT sweeps opportunistically; this
// reclaims rows that were never claimed. Same CRON_SECRET gate as retention.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    // 404 (not 401/403) so the route is indistinguishable from "doesn't exist" to an unauthorized caller.
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }
  if (!handoffConfigured()) return Response.json({ swept: 0 });
  try {
    const store = await getHandoffStore();
    return Response.json({ swept: await store.sweepExpired(Date.now()) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[handoff-sweep] sweep failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
