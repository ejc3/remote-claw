// INJECT for the tmux driver: drain the relay's downstream queue and type each event into the pane.
//
// The queue is the session's `followDownstream(claimWorkerStream(), stop)` generator — the SAME stream
// the MITM consumes over SSE. We process it STRICTLY serially (review #9): a burst of prompts must not
// race the multi-step paste (set-buffer → paste-buffer → settle → Enter), or two prompts interleave in
// the input box. Because the generator is consumed one event at a time and each handler is awaited
// before the next, serialization is structural — no extra lock needed.
//
// ACK DISCIPLINE (review #5, load-bearing): a non-MITM driver has no `/worker/events/delivery`, so
// `followDownstream` would REPLAY old prompts/controls on a reclaimed stream unless we call
// `session.ack(eventId)` after each SUCCESSFUL inject — including the leading `initialize`.

import type { RcEvent, Session } from "../session.js";
import type { TmuxCtl } from "./tmuxctl.js";

/** The DEFAULT tmux paste-buffer name. The driver passes a PER-SESSION name (`rcin-<session.id>`) so
 *  two concurrent tmux drivers can't overwrite each other's buffer between `set-buffer` and
 *  `paste-buffer` (tmux buffers are server-global) — codex review #5. This const is the fallback. */
export const INJECT_BUFFER = "rcin";

/** ms to wait after the bracketed paste before sending Enter, so the input box has settled and the
 *  Enter isn't swallowed by the in-flight paste. Validated against real claude in the design sessions. */
export const PASTE_SETTLE_MS = 40;

/** Initial backoff between inject retries (a transient set-buffer/paste-buffer error clears fast). */
export const INJECT_RETRY_MS = 100;
/** Cap on the exponential retry backoff — bounds the cost when a pane is alive but persistently
 *  rejecting input (the pane-liveness watcher tears down a genuinely DEAD pane, ending the retry). */
export const INJECT_RETRY_MAX_MS = 2000;

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pull the user prompt text out of a downstream `user` event. `pushUserInput` sets
 *  `message.content` to a STRING (not blocks), so we read that; anything else yields "" (skip). */
export function downstreamUserText(ev: RcEvent): string {
  const message = ev.payload.message as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

/** True if a downstream control_request is an `interrupt` (the one verb the tmux pane can honor — ESC). */
export function isInterrupt(ev: RcEvent): boolean {
  if (ev.eventType !== "control_request") return false;
  const req = ev.payload.request as { subtype?: unknown } | undefined;
  return req?.subtype === "interrupt";
}

/**
 * PHASE 1 of injection — get the text into the pane's input box: load it into a named buffer, then
 * BRACKETED-paste it (so multiline / backticks / special chars don't submit early). Split out from the
 * Enter so the pump can retry it AS A UNIT: a `paste-buffer` is a single tmux command that either
 * pastes the whole buffer or fails to start, so a FAILED paste leaves the box empty and re-running is
 * safe — but a SUCCEEDED paste must never be re-run (it would double the text). `buffer` is the
 * per-session paste-buffer name (codex review #5).
 */
export async function loadAndPaste(
  tmux: TmuxCtl,
  target: string,
  text: string,
  buffer: string = INJECT_BUFFER,
): Promise<void> {
  await tmux.setBuffer(buffer, text);
  await tmux.pasteBuffer(target, buffer);
}

/** PHASE 2 of injection — settle, then the SEPARATE send-keys Enter that actually submits. Retried
 *  ALONE (never re-pasting) when a transient error lands after the paste already succeeded. */
export async function submitPrompt(
  tmux: TmuxCtl,
  target: string,
  sleep: (ms: number) => Promise<void> = sleepReal,
): Promise<void> {
  await sleep(PASTE_SETTLE_MS);
  await tmux.sendKeys(target, "Enter");
}

/**
 * Inject one prompt end-to-end (phase 1 then phase 2). Kept for the order test + external callers; the
 * pump drives the two phases separately so it can retry them with the right idempotency (see runInjectPump).
 */
export async function injectUserText(
  tmux: TmuxCtl,
  target: string,
  text: string,
  buffer: string = INJECT_BUFFER,
  sleep: (ms: number) => Promise<void> = sleepReal,
): Promise<void> {
  await loadAndPaste(tmux, target, text, buffer);
  await submitPrompt(tmux, target, sleep);
}

/**
 * Retry `action` until it succeeds or `signal` aborts, with capped exponential backoff. Returns true on
 * success, false if it aborted before landing. Reports each failure via `onError` so a stuck pane is
 * visible. There is NO max-attempts give-up (that would silently drop a prompt — review wf#7): a
 * genuinely DEAD pane is caught by the driver's pane-liveness watcher, which aborts `signal`.
 */
async function retryUntil(
  action: () => Promise<void>,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
  report: (attempt: number, error: unknown) => void,
): Promise<boolean> {
  let delay = INJECT_RETRY_MS;
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      await action();
      return true;
    } catch (e) {
      report(attempt, e);
      if (signal.aborted) return false;
      await sleep(delay);
      delay = Math.min(delay * 2, INJECT_RETRY_MAX_MS);
    }
  }
  return false;
}

export interface InjectPumpOptions {
  /** The session whose downstream queue we drain. */
  session: Session;
  /** The tmux façade (real or fake). */
  tmux: TmuxCtl;
  /** The tmux target (the session/pane). */
  target: string;
  /** Aborts the drain (wrapper exit). */
  signal: AbortSignal;
  /** Per-session paste-buffer name (codex review #5). Defaults to INJECT_BUFFER. */
  buffer?: string;
  /** Injectable settle delay (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional diagnostics callback (driver wires its tracer). `phase` is which retried step failed
   *  ("paste" = setBuffer+pasteBuffer unit; "submit" = Enter; "interrupt" = Escape). */
  onError?: (
    event: string,
    error: unknown,
    info?: { attempt: number; phase: "paste" | "submit" | "interrupt" },
  ) => void;
  /** Called with a prompt's text right AFTER it is successfully submitted (Enter sent, ack'd), so the
   *  driver records it in its local-prompt ledger. Recording AFTER submit keeps this display-side
   *  bookkeeping strictly DOWNSTREAM of the command: the ledger can NEVER block, reorder, or alter the
   *  prompt sent to claude (load-bearing — the remote transcript may be lossy, but commands to claude must
   *  not be). The small window between submit and this record is display-only: at worst claude's transcript
   *  echo is briefly mis-tagged as a local prompt (a harmless double-show in the viewer), never a
   *  wrong/dropped command. */
  onInjected?: (text: string) => void;
}

/**
 * Drain the downstream queue into the pane until `signal` aborts. For each event:
 *   • `user`            → loadAndPaste (phase 1) then submitPrompt (phase 2), then `session.ack`.
 *   • `control_request` `interrupt` → send Escape, then ack.
 *   • `control_request` (other verbs: set_model/set_permission_mode/end) → no faithful pane analogue;
 *      ack so a reclaimed stream doesn't replay it (capabilities.controlVerbs=false documents this).
 *   • `control_request` `initialize`, `control_response` → no pane action, but ACK (review #5) so the
 *      leading initialize isn't replayed on reconnect.
 *
 * RETRY DISCIPLINE (codex #4 + review wf#1/#4/#7 — STEP-AWARE so it stays idempotent):
 * `followDownstream` adds an event to its per-generator `sent` set the instant it yields, so a single
 * pump will NOT redeliver a failed inject. We therefore retry IN PLACE (serially — the for-await is
 * strictly sequential, so a burst can't interleave). Crucially the phases retry DIFFERENTLY:
 *   - PHASE 1 (setBuffer+pasteBuffer) retries as a UNIT — a failed paste-buffer left the box empty, so
 *     re-running is safe; this never double-pastes because we stop the instant paste succeeds.
 *   - PHASE 2 (Enter) retries ALONE — once the text is in the box we must NEVER re-paste (that would
 *     submit the prompt DOUBLED). A transient Enter failure just re-sends Enter.
 * Retry continues until success OR `signal` aborts — there is no silent max-attempts give-up (that
 * dropped the prompt while the session looked healthy). A genuinely dead pane is caught by the driver's
 * pane-liveness watcher (aborts `signal`); a live-but-stuck pane keeps retrying with capped backoff and
 * is surfaced via `onError`. Heartbeat ticks (`null`) are ignored.
 */
export async function runInjectPump(opts: InjectPumpOptions): Promise<void> {
  const { session, tmux, target, signal } = opts;
  const sleep = opts.sleep ?? sleepReal;
  const buffer = opts.buffer ?? INJECT_BUFFER;

  const gen = session.claimWorkerStream();
  for await (const ev of session.followDownstream(gen, () => signal.aborted)) {
    if (ev === null) continue; // heartbeat tick

    if (ev.eventType === "user") {
      const text = downstreamUserText(ev);
      // A blank prompt — empty OR whitespace-only (a human who hit send on spaces / a stray newline) —
      // is a no-op, not a junk turn pasted into the pane. Still acked (it's "handled").
      if (text.trim() === "") {
        session.ack(ev.eventId);
        continue;
      }
      // Phase 1: get the text into the box (retry as a unit). Phase 2: submit it (retry Enter alone).
      const pasted = await retryUntil(
        () => loadAndPaste(tmux, target, text, buffer),
        signal,
        sleep,
        (attempt, error) => opts.onError?.(ev.eventType, error, { attempt, phase: "paste" }),
      );
      if (!pasted) continue; // aborted before the text landed — leave un-acked
      const submitted = await retryUntil(
        () => submitPrompt(tmux, target, sleep),
        signal,
        sleep,
        (attempt, error) => opts.onError?.(ev.eventType, error, { attempt, phase: "submit" }),
      );
      if (submitted) {
        // ACK FIRST — the ack is what stops a reclaimed stream from REPLAYING (double-injecting) this
        // command, so the command path must complete before any display-side bookkeeping. THEN record in
        // the local-prompt ledger. Both are synchronous with no await between them, so the entry is still
        // in place before the next capture poll could read claude's echo. (Commands to claude must never
        // be lossy; the ledger is display-only — see onInjected.)
        session.ack(ev.eventId);
        opts.onInjected?.(text);
      }
    } else if (isInterrupt(ev)) {
      const sent = await retryUntil(
        () => tmux.sendKeys(target, "Escape"),
        signal,
        sleep,
        (attempt, error) => opts.onError?.(ev.eventType, error, { attempt, phase: "interrupt" }),
      );
      if (sent) session.ack(ev.eventId);
    } else {
      // control_request (initialize / set_model / set_mode / end) and control_response: no pane
      // analogue in v1, but ACK so followDownstream won't replay them after a stream reclaim.
      session.ack(ev.eventId);
    }
  }
}
