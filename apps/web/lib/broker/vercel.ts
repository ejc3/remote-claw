import type { WireFrame } from "@remote-claw/clawsec";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { relayWorkflow } from "../../workflows/relay";
import type { BrokerBackend, PublishResult, RelayPayload } from "./backend";

// The production backend: Vercel Workflows. Each channel token addresses ONE durable `relayWorkflow`
// run that owns the token's inbound hook and re-emits every published frame onto its resumable
// out-stream (§6A/§6B). This file is the adapter — it holds the resume-or-start handshake and the
// stream resolution that used to live inline in the two routes; the durable loop itself is
// workflows/relay.ts (compiled by withWorkflow).

const BASE_MS = 50;
const CEIL_MS = 2000;
const REGISTER_DEADLINE_MS = 10_000;

function jittered(ms: number): number {
  const j = ms * 0.25;
  return ms - j + Math.random() * 2 * j;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A getHookByToken result carries the run id of the run that holds the token (§6B). */
function runIdOf(hook: unknown): string {
  const id = (hook as { runId?: unknown }).runId;
  if (typeof id !== "string") throw new Error("getHookByToken returned no runId");
  return id;
}

/**
 * Resolve `token` to its live run, starting a relay run if none holds it yet. Returns the runId and
 * whether this call created the run. Throws if the hook never registers within the deadline.
 *
 * §6B resume-or-start: the FIRST publisher/subscriber to need a token explicit-`start()`s the run
 * (which immediately createHook(token)); everyone else resolves the held token with getHookByToken.
 * One run per token is SDK-enforced (a duplicate createHook on a held token throws HookConflictError
 * inside the loser run, which dies harmlessly while the winner's token resolves), so start() itself
 * never conflicts — only the in-workflow createHook can — and the caller never needs to catch it.
 */
async function ensureChannel(token: string): Promise<{ runId: string; created: boolean }> {
  try {
    return { runId: runIdOf(await getHookByToken(token)), created: false };
  } catch {
    // No live run holds this token — create one, then wait for its hook to register.
  }
  await start(relayWorkflow, [token]);
  let delay = BASE_MS;
  const deadline = Date.now() + REGISTER_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      return { runId: runIdOf(await getHookByToken(token)), created: true };
    } catch {
      await sleep(jittered(delay));
      delay = Math.min(delay * 2, CEIL_MS);
    }
  }
  throw new Error(`relay hook did not register within ${REGISTER_DEADLINE_MS}ms`);
}

export class VercelBackend implements BrokerBackend {
  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    const { runId, created } = await ensureChannel(token);
    // The run can complete/dispose between ensureChannel resolving and this resume (a concurrent
    // __close or cap-roll) -> resumeHook throws. Propagate so the route reports 409 (not 500); the
    // client retries. A dropped post would leave a permanent seq gap that stalls every subscriber.
    await resumeHook(token, payload);
    return { created, channelId: runId };
  }

  async subscribe(
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    // Resolve the token to its run's durable out-stream, or null if nothing is connected (HookNotFound
    // ⇒ no run ⇒ 200 empty, §6B). Subscribing never creates a run — only publish does.
    let runId: string;
    try {
      runId = runIdOf(await getHookByToken(token));
    } catch {
      return null;
    }
    const run = getRun(runId);
    return run.getReadable(
      startIndex !== undefined ? { startIndex } : {},
    ) as unknown as ReadableStream<WireFrame>;
  }
}
