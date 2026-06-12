import { getBackend } from "../../../../lib/broker";
import { authorized } from "../../temporal/drain/gate";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

function retentionMs(): number {
  const parsed = Number.parseInt(process.env.BROKER_RETENTION_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_MS;
}

function tursoConfigured(): boolean {
  const url = process.env.TURSO_DATABASE_URL;
  return url !== undefined && url !== "";
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    // 404 (not 401/403) so the route is indistinguishable from "doesn't exist" to an unauthorized caller.
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  if (!tursoConfigured()) return Response.json({ swept: 0 });

  const backend = await getBackend("turso");
  if (backend.sweep === undefined) return Response.json({ swept: 0 });

  return Response.json({ swept: await backend.sweep(retentionMs()) });
}
