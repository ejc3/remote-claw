import { getBackend } from "../../../../lib/broker";
import { authorized } from "../../temporal/drain/gate";
import { retentionMs, sqliteConfigured } from "./gate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    // 404 (not 401/403) so the route is indistinguishable from "doesn't exist" to an unauthorized caller.
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  if (!sqliteConfigured()) return Response.json({ swept: 0 });

  try {
    const backend = await getBackend("sqlite");
    if (backend.sweep === undefined) return Response.json({ swept: 0 });

    return Response.json({ swept: await backend.sweep(retentionMs()) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[sqlite-retention] sweep failed:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
