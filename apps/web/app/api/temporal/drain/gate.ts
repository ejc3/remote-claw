import { timingSafeEqual, utf8 } from "@remote-claw/clawsec";

// Pure decision helpers for the drain route — factored out so they're unit-testable without booting
// the native Temporal worker (route.ts wires them to the HTTP method + the worker run).

export const DEFAULT_WINDOW_MS = 70_000; // > the 60s cron interval ⇒ invocations overlap (no gap)
export const SHUTDOWN_HEADROOM_S = 10; // keep the window this far under maxDuration for graceful drain

/** Whether this request may spin a worker. Vercel sends `Authorization: Bearer $CRON_SECRET` on cron
 *  invocations when CRON_SECRET is set; we require an exact match. With NO secret we allow the route
 *  only in a non-production, off-Vercel environment (local dev / a manual curl) and FAIL CLOSED
 *  everywhere else — a missing secret in ANY production deploy (Vercel or self-hosted) must not leave
 *  this worker-spawning endpoint open. */
export function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL !== "1" && process.env.NODE_ENV !== "production";
  const got = req.headers.get("authorization");
  if (got === null) return false;
  // timingSafeEqual throws on unequal lengths, so the length guard is required (not redundant); the
  // Bearer prefix and secret length are fixed, so it leaks nothing useful. Mirrors the dev/seed gate.
  const a = utf8(got);
  const b = utf8(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when a Temporal cluster is configured to drain. Requires an ADDRESS to connect to —
 *  `TEMPORAL_ADDRESS`, or `BROKER_BACKEND=temporal` which opts into the local default. NOT
 *  `TEMPORAL_API_KEY` alone: an API key is auth, not an endpoint, so connecting on it would fall back
 *  to the 127.0.0.1 default and 500 every cron tick (a Cloud key without its address is a misconfig,
 *  not a reason to spin a worker). Cron on a deploy that doesn't use Temporal is a harmless no-op. */
export function temporalConfigured(): boolean {
  return process.env.BROKER_BACKEND === "temporal" || process.env.TEMPORAL_ADDRESS !== undefined;
}

/** The worker run window (ms), clamped to leave shutdown headroom under the function's maxDuration.
 *  Overridable via TEMPORAL_DRAIN_WINDOW_MS; overlap with the next tick (not a long window) is what
 *  removes gaps, so it only needs to sit a little above the 60s cron interval. */
export function drainWindowMs(maxDurationS: number): number {
  const ceil = Math.max(1_000, (maxDurationS - SHUTDOWN_HEADROOM_S) * 1000);
  const parsed = Number.parseInt(process.env.TEMPORAL_DRAIN_WINDOW_MS ?? "", 10);
  const want = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_MS;
  return Math.min(want, ceil);
}
