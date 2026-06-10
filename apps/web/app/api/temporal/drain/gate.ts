import { timingSafeEqual, utf8 } from "@remote-claw/clawsec";

// Pure decision helpers for the drain route — factored out so they're unit-testable without booting
// the native Temporal worker (route.ts wires them to the HTTP method + the worker run).

export const DEFAULT_WINDOW_MS = 70_000; // > the 60s cron interval ⇒ invocations overlap (no gap)
export const SHUTDOWN_HEADROOM_S = 10; // keep the window this far under maxDuration for graceful drain

/** Whether this request may spin a worker. Vercel sends `Authorization: Bearer $CRON_SECRET` on cron
 *  invocations when CRON_SECRET is set; we require an exact, constant-time match. With no secret we
 *  allow ONLY off-Vercel (local dev / a manual curl) and NEVER an unauthenticated request on Vercel
 *  (fail closed — a missing secret in prod must not open the route). */
export function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL !== "1";
  const got = req.headers.get("authorization");
  if (got === null) return false;
  const a = utf8(got);
  const b = utf8(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when a Temporal cluster is configured to drain. Cron on a deploy that doesn't use Temporal is
 *  a harmless no-op (don't connect a worker to nothing). */
export function temporalConfigured(): boolean {
  return (
    process.env.BROKER_BACKEND === "temporal" ||
    process.env.TEMPORAL_ADDRESS !== undefined ||
    process.env.TEMPORAL_API_KEY !== undefined
  );
}

/** The worker run window (ms), clamped to leave shutdown headroom under the function's maxDuration.
 *  Overridable via TEMPORAL_DRAIN_WINDOW_MS (e.g. raise it on Pro where maxDuration can be 800s). */
export function drainWindowMs(maxDurationS: number): number {
  const ceil = Math.max(1_000, (maxDurationS - SHUTDOWN_HEADROOM_S) * 1000);
  const parsed = Number.parseInt(process.env.TEMPORAL_DRAIN_WINDOW_MS ?? "", 10);
  const want = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_MS;
  return Math.min(want, ceil);
}
