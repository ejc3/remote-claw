import type { BrokerBackend } from "./backend";
import { LocalBackend } from "./local";
import { VercelBackend } from "./vercel";

// The broker's durable backend is selected once, by the BROKER_BACKEND env var, and shared
// process-wide so the relay (publish) and stream (subscribe) routes operate on the SAME instance —
// essential for the in-process LocalBackend, where the channel map lives in this module's memory.
//
//   (unset) | "vercel"  → Vercel Workflows (production; the default)
//   "local"            → in-process fake broker (next dev / tests / Playwright e2e)
//   "temporal"         → Temporal durable workflows                       [added in PR C]

let cached: BrokerBackend | null = null;

export function getBackend(): BrokerBackend {
  if (cached !== null) return cached;
  const name = process.env.BROKER_BACKEND ?? "vercel";
  switch (name) {
    case "vercel":
      cached = new VercelBackend();
      break;
    case "local":
      cached = new LocalBackend();
      break;
    default:
      throw new Error(`unknown BROKER_BACKEND "${name}" (expected: vercel | local)`);
  }
  return cached;
}

export type { BrokerBackend } from "./backend";
export { isClose, type RelayPayload } from "./backend";
