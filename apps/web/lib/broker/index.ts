import type { BrokerBackend } from "./backend";
import { brokerCache } from "./broker-cache";
import { LocalBackend } from "./local";
import { VercelBackend } from "./vercel";

// The broker's durable backend is selected PER REQUEST: a `?backend=` query param (forwarded by the
// client) wins, else the BROKER_BACKEND env default, else "vercel". So one deployment defaults to
// Vercel Workflows but a client can opt a session into another backend with `?backend=temporal`
// without a redeploy. The publish (relay) and subscribe (stream) for a given channel MUST name the
// same backend — the client sends the param on both.
//
//   (unset) | "vercel"  → Vercel Workflows (production; the default)
//   "local"            → in-process fake broker (tests / Playwright e2e)
//   "temporal"         → Temporal durable workflows (needs a server + the relayChannel worker)
//   "sqlite"           → per-session libSQL: ONE database per channel token; storage = local file
//                        (RC_SQLITE_DIR, the `pnpm dev` default) or Turso Cloud (one db per session)
//
// Each backend is cached per-name (process-wide), so the LocalBackend's in-memory channel map and the
// Temporal connection persist across requests. getBackend() is async only so the Temporal adapter can
// be DYNAMICALLY imported — keeping the heavy @temporalio/client out of the bundle unless selected.

const KNOWN = new Set(["vercel", "local", "temporal", "sqlite"]);

// The cache lives on globalThis, NOT a module-level binding: Next can give the relay route and the
// stream route SEPARATE instances of this module (per-route bundles) and re-import it on HMR — either
// would give each route its OWN LocalBackend map, so a publish and the matching subscribe would land
// on different in-memory channels (the "0 sessions" failure). A globalThis singleton is the same Map
// for every module instance in the process.
const cache: Map<string, BrokerBackend> = brokerCache();

/** The HTTP header an API client sends to pick the backend (same meaning as the `?backend=` param). */
export const BACKEND_HEADER = "x-broker-backend";

/** True for a recognized backend name. */
export function isKnownBackend(name: string): boolean {
  return KNOWN.has(name);
}

// Durable backends are safe to pick PER REQUEST. `local` is the lone exception: it's process MEMORY, so
// on a multi-instance / serverless deploy a per-request pick would land publish + subscribe on different
// instances — it's honoured only as the deployment's OWN default (dev / `next start`). `sqlite` IS
// requestable: its storage is either a single local process's disk (dev / `next start` / e2e) or a
// SHARED remote Turso db (multi-instance / Vercel), and file-mode on Vercel is guarded off — so a
// selected `sqlite` request always reaches a CONSISTENT store, the way `vercel`/`temporal` do.
const REQUESTABLE = new Set(["vercel", "temporal", "sqlite"]);

/** True if `name` may be chosen by an incoming request's selector (header / ?backend=). Only `local` is
 *  deliberately NOT in REQUESTABLE — it is process memory, honoured solely as the deployment's own
 *  BROKER_BACKEND default, so a per-request override can't split publish/subscribe across instances. */
export function isRequestableBackend(name: string): boolean {
  return REQUESTABLE.has(name) || name === (process.env.BROKER_BACKEND ?? "vercel");
}

/** The per-request backend selector: `?backend=` (browser URLs) or the header (API calls), whichever
 *  is present (param wins). A BLANK selector (`?backend=`, whitespace, or an empty header) is treated as
 *  NO selection → null, so the route's null-guard skips validation and getBackend falls back to the
 *  BROKER_BACKEND default (matching getBackend's own `trim() || default`). Without this, a blank value is
 *  non-null but not requestable, so the routes 400 instead of using the default. The value is trimmed so
 *  `?backend=%20sqlite%20` resolves like `sqlite` rather than failing the requestable check. */
export function backendSelector(req: Request, url: URL): string | null {
  const raw = url.searchParams.get("backend") ?? req.headers.get(BACKEND_HEADER);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
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
    case "sqlite": {
      // Per-session libSQL — ONE database per channel token (BROKER_BACKEND=sqlite, or ?backend=sqlite).
      // The ONLY thing that varies is the storage locator, chosen from env: Turso Cloud (one remote db
      // per session) when the cloud creds are set, else local files under RC_SQLITE_DIR. Dynamic-imported
      // so @libsql/client + node:fs stay out of the bundle unless selected.
      const { SqliteMultiBackend } = await import("./sqlite-multi");
      const { selectLocatorFromEnv } = await import("./turso-cloud-locator");
      backend = new SqliteMultiBackend(selectLocatorFromEnv());
      break;
    }
    default:
      throw new Error(`unknown backend "${name}" (expected: vercel | local | temporal | sqlite)`);
  }
  cache.set(name, backend);
  return backend;
}

export type { BrokerBackend } from "./backend";
export { isClose, type RelayPayload } from "./backend";
export { evictBackend } from "./broker-cache";
