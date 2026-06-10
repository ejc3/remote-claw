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

// The cache lives on globalThis, NOT a module-level binding: Next can give the relay route and the
// stream route SEPARATE instances of this module (per-route bundles) and re-import it on HMR — either
// would give each route its OWN LocalBackend map, so a publish and the matching subscribe would land
// on different in-memory channels (the "0 sessions" failure). A globalThis singleton is the same Map
// for every module instance in the process.
const g = globalThis as unknown as { __rcBrokerCache?: Map<string, BrokerBackend> };
if (g.__rcBrokerCache === undefined) g.__rcBrokerCache = new Map();
const cache: Map<string, BrokerBackend> = g.__rcBrokerCache;

/** The HTTP header an API client sends to pick the backend (same meaning as the `?backend=` param). */
export const BACKEND_HEADER = "x-broker-backend";

/** True for a recognized backend name. */
export function isKnownBackend(name: string): boolean {
  return KNOWN.has(name);
}

// Durable, shared backends are safe to pick PER REQUEST. `local` is process-memory, so picking it
// per-request on a multi-instance / serverless deploy would land publish + subscribe on different
// instances' maps. So `local` is only honoured when it's the deployment's OWN default (i.e. dev /
// `next start` with BROKER_BACKEND=local) — never as a header/param override on a vercel/temporal
// deployment.
const REQUESTABLE = new Set(["vercel", "temporal"]);

/** True if `name` may be chosen by an incoming request's selector (header / ?backend=). */
export function isRequestableBackend(name: string): boolean {
  return REQUESTABLE.has(name) || name === (process.env.BROKER_BACKEND ?? "vercel");
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
