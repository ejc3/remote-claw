import type { BrokerBackend } from "./backend";
import { LocalBackend } from "./local";
import { VercelBackend } from "./vercel";

// The broker's durable backend is selected PER REQUEST: a `?backend=` query param (forwarded by the
// client) wins, else the BROKER_BACKEND env default, else "vercel". So one deployment defaults to
// Vercel Workflows but a client can opt a session into another backend with `?backend=temporal`
// without a redeploy. The publish (relay) and subscribe (stream) for a given channel MUST name the
// same backend — the client sends the param on both.
//
//   (unset) | "vercel"  → Vercel Workflows (production; the default)
//   "local"            → in-process fake broker (next dev / tests / Playwright e2e)
//   "temporal"         → Temporal durable workflows (needs a server + the relayChannel worker)
//
// Each backend is cached per-name (process-wide), so the LocalBackend's in-memory channel map and the
// Temporal connection persist across requests. getBackend() is async only so the Temporal adapter can
// be DYNAMICALLY imported — keeping the heavy @temporalio/client out of the bundle unless selected.

const KNOWN = new Set(["vercel", "local", "temporal"]);
const cache = new Map<string, BrokerBackend>();

/** The HTTP header an API client sends to pick the backend (same meaning as the `?backend=` param). */
export const BACKEND_HEADER = "x-broker-backend";

/** True for a recognized backend name (used by the routes to 400 a bad selector). */
export function isKnownBackend(name: string): boolean {
  return KNOWN.has(name);
}

/** The per-request backend selector: `?backend=` (browser URLs) or the header (API calls), whichever
 *  is present (param wins). Null → getBackend falls back to the BROKER_BACKEND env default. */
export function backendSelector(req: Request, url: URL): string | null {
  return url.searchParams.get("backend") ?? req.headers.get(BACKEND_HEADER);
}

/** Resolve the backend for a request. `requested` is the raw `?backend=` value (may be null/empty). */
export async function getBackend(requested?: string | null): Promise<BrokerBackend> {
  const name = requested?.trim() || process.env.BROKER_BACKEND || "vercel";
  const hit = cache.get(name);
  if (hit !== undefined) return hit;

  let backend: BrokerBackend;
  switch (name) {
    case "vercel":
      backend = new VercelBackend();
      break;
    case "local":
      backend = new LocalBackend();
      break;
    case "temporal": {
      const { TemporalBackend } = await import("./temporal");
      backend = new TemporalBackend();
      break;
    }
    default:
      throw new Error(`unknown backend "${name}" (expected: vercel | local | temporal)`);
  }
  cache.set(name, backend);
  return backend;
}

export type { BrokerBackend } from "./backend";
export { isClose, type RelayPayload } from "./backend";
