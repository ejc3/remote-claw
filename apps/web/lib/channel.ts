import { busToken, sessionToken } from "@remote-claw/clawsec";
import { getHookByToken, getRun, start } from "workflow/api";
import { relayWorkflow } from "../workflows/relay";

// §6B resume-or-start. A channel token addresses a relay run; the FIRST publisher/subscriber to need
// it explicit-`start()`s the run (which immediately createHook(token)), and everyone else resolves
// the held token with getHookByToken. resumeHook only WAKES an existing run, never creates one — so
// coming online is "try resolve → on miss, start() → poll until the hook registers", with bounded
// exponential backoff (§6B: 50ms base, ×2, ≤2s ceiling, ±25% jitter). One run per token is
// SDK-enforced (a duplicate createHook on a held token throws HookConflictError inside the loser
// run, which dies harmlessly while the winner's token resolves), so the route never needs to catch
// it here — start() itself never conflicts; only the in-workflow createHook can.

const BASE_MS = 50;
const CEIL_MS = 2000;
const REGISTER_DEADLINE_MS = 10_000;

/** The 16-byte identity + an optional session id selects the channel: bus, or per-session stream. */
export function channelToken(identityId: Uint8Array, sessionId: string | null): string {
  return sessionId === null ? busToken(identityId) : sessionToken(identityId, sessionId);
}

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
 */
export async function ensureChannel(token: string): Promise<{ runId: string; created: boolean }> {
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

/**
 * Resolve `token` to its run's durable out-stream, or null if nothing is connected (HookNotFound ⇒
 * no bus ⇒ 200 empty, §6B). `startIndex` selects the resume point; a negative value reads the recent
 * window (e.g. -N for the last N frames) and keeps streaming new ones.
 */
export async function resolveStream(
  token: string,
  startIndex: number | undefined,
): Promise<ReadableStream<unknown> | null> {
  let runId: string;
  try {
    runId = runIdOf(await getHookByToken(token));
  } catch {
    return null;
  }
  const run = getRun(runId);
  return run.getReadable(
    startIndex !== undefined ? { startIndex } : {},
  ) as unknown as ReadableStream<unknown>;
}
