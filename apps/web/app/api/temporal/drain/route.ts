import { relayWorkflowBundle, runRelayWorkerFor } from "../../../../temporal/run";
import { authorized, drainWindowMs, temporalConfigured } from "./gate";

// Vercel keep-warm worker for the Temporal backend. A serverless function can't poll a Temporal task
// queue 24/7, so a cron (apps/web/vercel.json, `* * * * *`) hits this route every minute and it runs
// the relayChannel worker for a bounded window that OVERLAPS the next tick — so there is always ≥1
// poller draining the queue. Fluid Compute bills active CPU, so a mostly-idle long-poller is cheap.
//
// Per-minute crons require a Vercel Pro plan (Hobby caps at once/day and FAILS the deploy for
// anything more frequent). Crons fire only on the PRODUCTION deployment; previews are driven by a
// manual authenticated request. Gated by CRON_SECRET (see ./gate).

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Fluid max on Hobby; Pro allows up to 800 (raise via the env window)

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    // 404 (not 401/403) so the route is indistinguishable from "doesn't exist" to an unauthorized caller.
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  // `?selftest=1`: build the workflow bundle IN-FUNCTION without connecting — proves the native
  // worker bundler runs in a real Vercel function (the riskiest part) even before Temporal Cloud
  // creds are wired, and without spinning a 70s worker.
  const url = new URL(req.url);
  if (url.searchParams.get("selftest") === "1") {
    const bundle = await relayWorkflowBundle();
    return Response.json({ ran: false, selftest: true, bundleBytes: bundle.code.length });
  }

  if (!temporalConfigured()) {
    return Response.json({ ran: false, reason: "temporal backend not configured" });
  }

  try {
    const result = await runRelayWorkerFor(drainWindowMs(maxDuration));
    return Response.json(result);
  } catch (e) {
    // Surface the failure to the cron log (the message, not a stack with secrets) and 500 so a broken
    // worker is visible in Vercel observability rather than silently green.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[temporal-drain] worker failed:", message);
    return new Response(JSON.stringify({ ran: false, error: message }), { status: 500 });
  }
}
