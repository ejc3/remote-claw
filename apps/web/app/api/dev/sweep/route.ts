import { gate } from "../_gate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Dev/CI scope deletion is intentionally disabled. A truncated database-name scope cannot prove exact
// deployment ownership: two commits can share the same prefix, so a name-prefix sweep can erase another
// preview. Inactivity is not collection authority either. Keep the authenticated/loopback gate so the
// route reveals nothing in production, then fail closed without constructing a locator or issuing a
// Platform API read/delete. A future cleanup path needs an exact retained full-deployment ownership
// record (or an authenticated per-channel manifest) before this endpoint may mutate storage.

export async function POST(req: Request): Promise<Response> {
  const g = gate(req);
  if (g instanceof Response) return g; // 404 (not enabled) / 400 (non-loopback locally)

  return Response.json(
    { error: "automated scope cleanup is disabled until exact deployment ownership is retained" },
    { status: 501 },
  );
}
