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
import { type TmuxCtl, TmuxError } from "./tmuxctl.js";

/** The DEFAULT tmux paste-buffer name. The driver passes a PER-SESSION name (`rcin-<session.id>`) so
 *  two concurrent tmux drivers can't overwrite each other's buffer between `set-buffer` and
 *  `paste-buffer` (tmux buffers are server-global) — codex review #5. This const is the fallback. */
export const INJECT_BUFFER = "rcin";

/** Base ms to wait after the bracketed paste before sending Enter, so the input box has settled and the
 *  Enter isn't swallowed by the in-flight paste. Validated against real claude in the design sessions. */
export const PASTE_SETTLE_MS = 40;
/** Extra settle per pasted character: bracketed-paste ingestion time grows with length, so a fixed 40ms
 *  is too short for a long prompt (the Enter then lands mid-paste and is dropped — observed live). */
export const PASTE_SETTLE_PER_CHAR_MS = 1.5;
/** Cap on the length-scaled settle (a pathologically long paste shouldn't stall the pump for seconds). */
export const PASTE_SETTLE_MAX_MS = 1000;

/** Length-scaled settle for a paste of `text`: base + per-char, capped (see the consts above). */
export function settleMs(text: string): number {
  return Math.min(
    PASTE_SETTLE_MS + Math.ceil(text.length * PASTE_SETTLE_PER_CHAR_MS),
    PASTE_SETTLE_MAX_MS,
  );
}

/** Initial backoff between safe inject retries (idempotent load or proved non-application). */
export const INJECT_RETRY_MS = 100;
/** Cap on the exponential retry backoff — bounds the cost when a pane is alive but persistently and
 * authoritatively rejecting input (the pane-liveness watcher ends retries for a dead pane). */
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

/** Extract the model id from a downstream `set_model` control_request (the verb fidelity path, B2): the
 *  driver injects `/model <id>` into the pane. Returns the model string, or null if this isn't a
 *  well-formed set_model. `pushControlRequest("set_model", { model })` sets payload.request.model. */
export function downstreamSetModel(ev: RcEvent): string | null {
  if (ev.eventType !== "control_request") return null;
  const req = ev.payload.request as { subtype?: unknown; model?: unknown } | undefined;
  if (req?.subtype !== "set_model") return null;
  return typeof req.model === "string" && req.model !== "" ? req.model : null;
}

/** Extract { requestId, behavior, updatedInput? } from a downstream `control_response` (the
 *  permission-mirroring answer, B2): the viewer's grant/deny rides this, and the driver writes the matching
 *  decision file the blocked PreToolUse hook is polling. `pushControlResponse` sets
 *  payload.response.{request_id,response.behavior} and, for an AskUserQuestion answer (#42),
 *  response.response.updatedInput = {questions, answers}. Returns null if it isn't a well-formed
 *  control_response. */
export function downstreamControlResponse(
  ev: RcEvent,
): { requestId: string; behavior: "allow" | "deny"; updatedInput?: unknown } | null {
  if (ev.eventType !== "control_response") return null;
  const resp = ev.payload.response as
    | { request_id?: unknown; response?: { behavior?: unknown; updatedInput?: unknown } }
    | undefined;
  const requestId = resp?.request_id;
  if (typeof requestId !== "string" || requestId === "") return null;
  // Fail CLOSED: only an explicit "allow" allows; anything else — "deny", or a malformed/absent behavior —
  // denies, so a garbled control_response can never auto-approve a tool. The relay normalizes behavior to
  // exactly allow|deny before this, so a real viewer grant is always "allow"; this is the last-gate guard.
  const behavior = resp?.response?.behavior === "allow" ? "allow" : "deny";
  // AskUserQuestion (#42): carry the {questions, answers} the relay built so the PreToolUse helper re-emits
  // it as hookSpecificOutput.updatedInput and claude proceeds with the viewer's answers instead of
  // prompting in the pane. Only meaningful on ALLOW — a deny never carries it (a denied tool doesn't run).
  const updatedInput = resp?.response?.updatedInput;
  return behavior === "allow" && updatedInput !== undefined
    ? { requestId, behavior, updatedInput }
    : { requestId, behavior };
}

/**
 * PHASE 1 of injection — get the text into the pane's input box: load it into a named buffer, then
 * BRACKETED-paste it (so multiline / backticks / special chars don't submit early). `load-buffer` is
 * idempotent and can be repeated after an unknown outcome. `paste-buffer` mutates the pane and can be
 * repeated only when tmux authoritatively reports that it was not applied. `buffer` is the per-session
 * paste-buffer name (codex review #5).
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

/** PHASE 2 of injection — settle, then the SEPARATE send-keys Enter that submits. A `send-keys Enter`
 *  that the still-in-flight bracketed paste swallows never errors, so the Enter must land AFTER the paste
 *  has been ingested; the fix is a LENGTH-SCALED settle (settleMs) — the original fixed 40ms was too
 *  short for a long prompt, which left it unsubmitted in the box (observed live).
 *
 *  We deliberately do NOT read the pane back to "confirm" the submit and resend: capture-parsing claude's
 *  TUI is unreliable (a ❯ inside the prompt text, the prompt head scrolled out of the captured region, or
 *  a failed capture) and every ambiguous read defaults to "looks submitted" → the prompt is ACKed and
 *  SILENTLY DROPPED (codex review found three such paths). A scaled settle + a single Enter has no such
 *  false-negative. Enter is retried only after a proved non-application; an unknown completion could
 *  already have submitted the prompt, so it fail-stops the compatibility Session instead. */
export async function submitPrompt(
  tmux: TmuxCtl,
  target: string,
  text: string,
  sleep: (ms: number) => Promise<void> = sleepReal,
): Promise<void> {
  await sleep(settleMs(text));
  await tmux.sendKeys(target, "Enter");
}

/**
 * Inject one prompt end-to-end (phase 1 then phase 2). Kept for the order test + external callers; the
 * pump drives the two phases separately so it can apply their distinct retry rules (see runInjectPump).
 */
export async function injectUserText(
  tmux: TmuxCtl,
  target: string,
  text: string,
  buffer: string = INJECT_BUFFER,
  sleep: (ms: number) => Promise<void> = sleepReal,
): Promise<void> {
  await loadAndPaste(tmux, target, text, buffer);
  await submitPrompt(tmux, target, text, sleep);
}

/**
 * Retry one mutating inject step until it succeeds or `signal` aborts, with capped exponential backoff.
 * `load-buffer` may always repeat because it replaces the same named buffer without touching the pane;
 * paste/Enter/Escape may repeat only after an authoritative `not-applied` result. Anything else closes
 * the remote Session and ends this pump without crashing the native driver: the local pane may have
 * applied the command and remains alive under its existing owner. There is no max-attempts give-up for
 * safe retries.
 */
async function retryInjectStep(
  action: () => Promise<void>,
  session: Session,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
  report: (attempt: number, error: unknown) => void,
  unknownReason: string,
): Promise<boolean> {
  let delay = INJECT_RETRY_MS;
  for (let attempt = 1; !signal.aborted && !session.closed; attempt++) {
    try {
      await action();
      return true;
    } catch (e) {
      const retryable =
        e instanceof TmuxError &&
        (e.operation === "load-buffer" || e.application === "not-applied");
      if (!retryable) {
        session.close(unknownReason);
        try {
          report(attempt, e);
        } catch {
          // Diagnostics cannot turn remote ambiguity into a crash that kills the healthy local pane.
        }
        return false;
      }
      report(attempt, e);
      if (signal.aborted || session.closed) return false;
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
   *  ("paste" = setBuffer+pasteBuffer unit; "submit" = Enter; "interrupt" = Escape). Unknown
   *  mutation outcomes are reported once and then close the remote Session; only safe failures retry. */
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
  /** Called on a `control_response` (a viewer permission answer) when permission MIRRORING is on (B2):
   *  the driver writes the decision file the blocked PreToolUse hook is polling, keyed by request_id (==
   *  the can_use_tool gate's id == the tool_use_id). `updatedInput` is present only for an AskUserQuestion
   *  allow (#42): the {questions, answers} the helper re-emits as hookSpecificOutput.updatedInput. When
   *  absent (mirroring off), control_responses are just acked. May be async; awaited before the ack. */
  onDecision?: (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: unknown,
  ) => void | Promise<void>;
}

/**
 * Drain the downstream queue into the pane until `signal` aborts. For each event:
 *   • `user`            → loadAndPaste (phase 1) then submitPrompt (phase 2), then `session.ack`.
 *   • `control_request` `interrupt` → send Escape, then ack.
 *   • `control_request` `set_model` → type `/model <id>` into the pane (capabilities.controls.setModel=true).
 *   • `control_request` (other verbs: set_permission_mode/end) → no faithful pane analogue; ack so a
 *      reclaimed stream doesn't replay it (capabilities.controls.setMode/end=false documents this).
 *   • `control_request` `initialize`, `control_response` → no pane action, but ACK (review #5) so the
 *      leading initialize isn't replayed on reconnect.
 *
 * RETRY DISCIPLINE (step-aware and application-aware):
 * `followDownstream` adds an event to its per-generator `sent` set the instant it yields, so a single
 * pump will NOT redeliver a failed inject. We therefore retry IN PLACE (serially — the for-await is
 * strictly sequential, so a burst can't interleave). Crucially the phases retry DIFFERENTLY:
 *   - `load-buffer` may retry after any failure because replacing the same named buffer is idempotent.
 *   - `paste-buffer`, Enter, and Escape retry only after tmux proves `not-applied`.
 *   - An unknown mutation outcome is never retried or ACKed. It closes this Session and ends the inject
 *     pump normally, retiring the remote projection without turning broker ambiguity into pane failure.
 * Safe retries continue until success or abort; heartbeat ticks (`null`) are ignored.
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
      const pasted = await retryInjectStep(
        () => loadAndPaste(tmux, target, text, buffer),
        session,
        signal,
        sleep,
        (attempt, error) => opts.onError?.(ev.eventType, error, { attempt, phase: "paste" }),
        "tmux paste application outcome unknown",
      );
      if (!pasted) continue; // aborted before the text landed — leave un-acked
      const submitted = await retryInjectStep(
        () => submitPrompt(tmux, target, text, sleep),
        session,
        signal,
        sleep,
        (attempt, error) => opts.onError?.(ev.eventType, error, { attempt, phase: "submit" }),
        "tmux submit application outcome unknown",
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
      const sent = await retryInjectStep(
        () => tmux.sendKeys(target, "Escape"),
        session,
        signal,
        sleep,
        (attempt, error) => opts.onError?.(ev.eventType, error, { attempt, phase: "interrupt" }),
        "tmux interrupt application outcome unknown",
      );
      if (sent) session.ack(ev.eventId);
    } else if (downstreamSetModel(ev) !== null) {
      // Verb fidelity (B2): a viewer `set_model` → type `/model <id>` into the pane (claude's documented
      // one-shot model switch). Injected via the SAME paste+submit path as a prompt and recorded in the
      // local-prompt ledger so claude's transcript echo of the slash command is suppressed (the viewer
      // drove it from the ⋯ sheet, not as a typed message).
      const text = `/model ${downstreamSetModel(ev)}`;
      const pasted = await retryInjectStep(
        () => loadAndPaste(tmux, target, text, buffer),
        session,
        signal,
        sleep,
        (attempt, error) => opts.onError?.("set_model", error, { attempt, phase: "paste" }),
        "tmux model paste application outcome unknown",
      );
      if (!pasted) continue;
      const submitted = await retryInjectStep(
        () => submitPrompt(tmux, target, text, sleep),
        session,
        signal,
        sleep,
        (attempt, error) => opts.onError?.("set_model", error, { attempt, phase: "submit" }),
        "tmux model submit application outcome unknown",
      );
      if (submitted) {
        session.ack(ev.eventId);
        opts.onInjected?.(text);
      }
    } else if (ev.eventType === "control_response" && opts.onDecision) {
      // Permission mirroring (B2): the viewer's grant/deny → write the decision file the blocked PreToolUse
      // hook polls. ACK after so a reclaimed stream doesn't replay the answer (a second, redundant write).
      // For an AskUserQuestion allow, `updatedInput` ({questions, answers}, #42) rides along — the helper
      // re-emits it as hookSpecificOutput.updatedInput so claude proceeds with the viewer's chosen answers
      // instead of falling back to its own in-pane question flow.
      const dec = downstreamControlResponse(ev);
      if (dec !== null) await opts.onDecision(dec.requestId, dec.behavior, dec.updatedInput);
      session.ack(ev.eventId);
    } else {
      // control_request (initialize / set_mode / end) and an unhandled control_response (mirroring off):
      // no pane analogue, but ACK so followDownstream won't replay them after a stream reclaim.
      session.ack(ev.eventId);
    }
  }
}
