import type { WireFrame } from "@remote-claw/clawsec";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { relayWorkflow } from "../../workflows/relay";
import {
  type BrokerBackend,
  isClose,
  PublishConflictError,
  type PublishResult,
  type RelayPayload,
} from "./backend";

// Compatibility/experimental backend: Vercel Workflows. Each channel token addresses ONE persistent
// `relayWorkflow` run that owns the token's inbound hook and re-emits every published frame onto its
// resumable out-stream (§6A/§6B). The adapter reports non-durable because it has neither safe cap
// rollover nor host recovery cursors; stable Claude rejects it before discovery. This file holds the
// resume-or-start handshake and stream resolution; workflows/relay.ts owns the compiled loop.

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
 * Workflow lookup errors can contain the full hook URL, including the derived channel token. Next
 * logs unhandled route errors, so never rethrow that provider object or attach it as a cause. The
 * channel kind is enough local context while preserving hard-failure behavior.
 */
function channelKind(token: string): "bus" | "session" | "unknown" {
  if (token.startsWith("bus:")) return "bus";
  if (token.startsWith("sess:")) return "session";
  return "unknown";
}

function workflowFailure(operation: "lookup" | "start" | "delivery", token: string): Error {
  const subject = operation === "lookup" ? "hook lookup" : `channel ${operation}`;
  return new Error(`workflow ${subject} failed for ${channelKind(token)} channel`);
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
 *
 * Concurrent callers IN THIS PROCESS are collapsed by `ensureChannel` (below), so this inner fn is
 * the sole in-process starter for its token per invocation and won't race a sibling's start().
 */
async function resolveOrStartChannel(token: string): Promise<{ runId: string; created: boolean }> {
  try {
    return { runId: runIdOf(await getHookByToken(token)), created: false };
  } catch (e) {
    if (!HookNotFoundError.is(e)) throw workflowFailure("lookup", token);
    // No live run holds this token — create one, then wait for its hook to register.
  }
  try {
    await start(relayWorkflow, [token]);
  } catch {
    throw workflowFailure("start", token);
  }
  // Observe the registration so a slow COLD START (transient) is distinguishable from a hard broker
  // OUTAGE (the deadline blown) instead of both surfacing as one opaque 500. Log only the channel KIND
  // (`bus`/`sess`) — never the full token, which carries the identity_id.
  const channel = token.split(":")[0] ?? "?";
  const startedAt = Date.now();
  let delay = BASE_MS;
  let attempts = 0;
  const deadline = startedAt + REGISTER_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const runId = runIdOf(await getHookByToken(token));
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > REGISTER_DEADLINE_MS / 2) {
        console.warn(
          `[broker] slow relay hook registration channel=${channel} elapsedMs=${elapsedMs} attempts=${attempts + 1}`,
        );
      }
      return { runId, created: true };
    } catch (e) {
      if (!HookNotFoundError.is(e)) throw workflowFailure("lookup", token);
      attempts++;
      await sleep(jittered(delay));
      delay = Math.min(delay * 2, CEIL_MS);
    }
  }
  console.error(
    `[broker] relay hook did NOT register channel=${channel} deadlineMs=${REGISTER_DEADLINE_MS} attempts=${attempts}`,
  );
  throw new Error(`relay hook did not register within ${REGISTER_DEADLINE_MS}ms`);
}

// Singleflight over resolveOrStartChannel, keyed by token. A host announces + serves (+ heartbeats
// presence) near-simultaneously, so two publishers race to resolve-or-start the SAME bus/session
// token: both see no hook, both start() a run, one wins createHook and the loser dies with a
// HookConflictError. That death is benign by design — but it burns a wasted cold-start round, spams
// the log with the conflict, and on a COLD/loaded workflow runtime can push the winner's hook
// registration past REGISTER_DEADLINE_MS, surfacing as a spurious relay outage or a stalled
// round-trip (the flaky real-rc prove timeout). Collapsing concurrent same-token calls to a single
// start() removes the loser run entirely. The entry clears on settle (success OR failure), so
// liveness is always re-checked on the next call and a failed start never poisons the token.
// Cross-process races (host and viewer on different invocations) can't share this map and still fall
// back to the SDK-enforced one-run-per-token conflict, which stays correct there.
const inflightEnsure = new Map<string, Promise<{ runId: string; created: boolean }>>();

function ensureChannel(token: string): Promise<{ runId: string; created: boolean }> {
  const pending = inflightEnsure.get(token);
  if (pending) return pending;
  const p = resolveOrStartChannel(token).finally(() => {
    inflightEnsure.delete(token);
  });
  inflightEnsure.set(token, p);
  return p;
}

export class VercelBackend implements BrokerBackend {
  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    // A __close RESOLVES an existing run only — never start one just to close it (ensureChannel would
    // create and immediately dispose an empty run, or race a real first publish and kill the fresh
    // run). No-op if no run holds the token (matching LocalBackend's close-on-absent).
    if (isClose(payload)) {
      let runId: string;
      try {
        runId = runIdOf(await getHookByToken(token));
      } catch (e) {
        if (!HookNotFoundError.is(e)) throw workflowFailure("lookup", token);
        return { created: false, channelId: "" };
      }
      return { created: false, channelId: await this.#deliver(token, payload, runId) };
    }
    // A failure to resolve-or-start the channel (e.g. the hook never registers within the deadline)
    // is a HARD outage — let it propagate so the route returns 500 and the client fails fast.
    const { runId, created } = await ensureChannel(token);
    return { created, channelId: await this.#deliver(token, payload, runId) };
  }

  /** Deliver one payload to a resolved run. Workflow 4.4.0 reports a hook that disappeared during
   *  resume as HookNotFoundError; only that typed channel-turnover race becomes
   *  PublishConflictError → 409 → client re-posts the same deterministic-msg_id frame. resumeHook
   *  also performs serialization, event persistence, and queueing, so every other error must
   *  remain a hard failure rather than being mislabeled retryable. Provider error details are
   *  replaced because they can include the full derived channel token. */
  async #deliver(token: string, payload: RelayPayload, runId: string): Promise<string> {
    try {
      await resumeHook(token, payload);
    } catch (e) {
      if (HookNotFoundError.is(e)) {
        throw new PublishConflictError("workflow channel disappeared during publish");
      }
      throw workflowFailure("delivery", token);
    }
    return runId;
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
    } catch (e) {
      if (!HookNotFoundError.is(e)) throw workflowFailure("lookup", token);
      return null;
    }
    const run = getRun(runId);
    return run.getReadable(
      startIndex !== undefined ? { startIndex } : {},
    ) as unknown as ReadableStream<WireFrame>;
  }
}
