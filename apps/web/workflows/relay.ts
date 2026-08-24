import type { WireFrame } from "@remote-claw/clawsec";
import { createHook, getWritable } from "workflow";

// §6A/§6B — the relay run (the Vercel backend's durable loop). One run owns ONE channel token's
// inbound hook and re-emits every published frame onto its durable resumable out-stream. The
// versioned per-identity presence BUS and a PER-SESSION stream
// (`sess:<id>:<sid>`, turn/control frames) are the SAME workflow under different tokens — the broker
// is a dumb ciphertext relay that never holds a key, so it forges nothing. Stream payload bytes bypass
// event-log storage, but every publish still creates a hook receipt and a journaled emit step, so every
// frame in either direction consumes the run's event budget (§12).
//
// __close is an internal explicit-close / teardown primitive (§6B): completing the run closes its
// stream and disposes the hook, freeing the token for a fresh `start()` under the same name. No shipped
// production component currently invokes it as a pre-cap rollover controller.
//
// RelayPayload + isClose are kept LOCAL here (not imported from lib/broker/backend, the canonical
// home the other adapters use): this file is compiled by the Workflow DevKit into a separate steps
// bundle whose ESM loader doesn't apply the `.js`→`.ts` extensionAlias, so a runtime import of a
// local `.ts` would fail to resolve. The shapes are trivial and structurally identical.

/** What a publisher may put on the channel: a wire frame, or the teardown sentinel. */
export type RelayPayload = WireFrame | { __close: true };

function isClose(p: RelayPayload): p is { __close: true } {
  return (p as { __close?: boolean }).__close === true;
}

function isPresenceBus(token: string): boolean {
  return token.startsWith("bus:presence-v2:");
}

async function emit(frame: WireFrame) {
  "use step";
  const writer = getWritable<WireFrame>().getWriter();
  try {
    await writer.write(frame);
  } finally {
    writer.releaseLock();
  }
}

async function closeStream() {
  "use step";
  await getWritable().close();
}

/** The relay run for a single channel token. Loops, re-emitting each published frame, until close. */
export async function relayWorkflow(channelToken: string) {
  "use workflow";
  const hook = createHook<RelayPayload>({ token: channelToken });
  // Workflow replay deterministically reconstructs this Set from the ordered hook history. It is the
  // absorbing lifecycle fence for THIS run/generation: close/cap-roll still ends the run, and a future
  // rollover design must carry this compact state before it can safely replace the token owner.
  const terminalSessions = new Set<string>();
  const presenceBus = isPresenceBus(channelToken);
  for await (const payload of hook) {
    if (isClose(payload)) break;
    if (presenceBus && payload.record_kind === "session_terminal") {
      if (terminalSessions.has(payload.session_id)) continue; // retry: semantic idempotency by sid
      terminalSessions.add(payload.session_id); // latch before the durable emit step
      await emit(payload);
      continue;
    }
    if (
      presenceBus &&
      payload.record_kind === "session_announce" &&
      terminalSessions.has(payload.session_id)
    ) {
      continue; // successful hook delivery, deliberately absent from the observable output stream
    }
    await emit(payload);
  }
  await closeStream();
  // Return -> run completes -> hook auto-disposes -> token frees (explicit-close primitive, §6B).
}
