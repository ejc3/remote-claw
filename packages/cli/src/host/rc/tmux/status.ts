// STATUS for the tmux driver: there are no `result` lines in interactive mode, so presence is inferred
// from transcript activity. The relay's `phaseFor` (relay.ts) maps `running → thinking` and everything
// else → `idle`, so we set exactly those `workerStatus` values and `session.wake()` — the announce
// presence the viewer already understands just works.
//
// The heuristic, debounced:
//   • A new transcript line ⇒ `running` (claude is producing) + wake.
//   • ~1s after the LAST append with NO open tool_use ⇒ `idle` (turn finished) + wake.
// An "open tool_use" is an assistant block that called a tool whose `tool_result` hasn't arrived yet —
// claude is waiting on the tool, so we must NOT flip to idle even though the file is momentarily quiet.
//
// The timer + clock are INJECTED so the debounce is deterministic in tests (no real setTimeout / no
// sleeping). A real driver passes Node's timers; the test passes a manual scheduler.

import type { Session } from "../session.js";

/** A cancelable one-shot timer. The driver supplies Node's setTimeout/clearTimeout; tests supply a
 *  manual scheduler so the debounce fires exactly when the test advances it. */
export interface Timer {
  set(cb: () => void, ms: number): void;
  clear(): void;
}

/** A real timer over Node's setTimeout/clearTimeout (unref'd so it never holds the process open). */
export function nodeTimer(): Timer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return {
    set(cb, ms) {
      if (handle !== null) clearTimeout(handle);
      handle = setTimeout(cb, ms);
      if (typeof handle === "object" && typeof handle.unref === "function") handle.unref();
    },
    clear() {
      if (handle !== null) clearTimeout(handle);
      handle = null;
    },
  };
}

/** ms of no transcript append (with no open tool_use) before we declare the turn idle. */
export const IDLE_DEBOUNCE_MS = 1000;

/** ms of TOTAL transcript silence after which we force idle even if a tool_use is still "open" — it was
 *  orphaned (interrupt / crash / sub-agent nesting) and no tool_result will ever close it, so suppressing
 *  idle forever would pin the viewer on "thinking" (review wf#2). Sized WELL above any plausible
 *  no-append leaf-tool duration (an active sub-agent keeps appending, so it never trips this). */
export const HARD_IDLE_MS = 120_000;

/** Stop reasons that mean the turn is OVER (claude won't continue on its own) — the signal real RC
 *  turns into a `result`. `tool_use` (a tool call is pending) and `pause_turn` (a server-tool pause that
 *  claude resumes) mean "more coming"; an absent/streaming stop_reason isn't a boundary either. */
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

/** True if an assistant message's `stop_reason` marks a real end of turn (see TERMINAL_STOP_REASONS). */
export function isTerminalStopReason(stopReason: unknown): boolean {
  return typeof stopReason === "string" && TERMINAL_STOP_REASONS.has(stopReason);
}

export interface StatusTrackerOptions {
  session: Session;
  /** Idle debounce window (default IDLE_DEBOUNCE_MS). */
  idleMs?: number;
  /** Force-idle window for an orphaned open tool_use (default HARD_IDLE_MS). */
  hardIdleMs?: number;
  /** Injectable timer (default: real Node timer). */
  timer?: Timer;
  /** Injectable clock for the hard-idle window (default Date.now). */
  now?: () => number;
  /** Fired ONCE per real turn end. The driver uses this to emit a synthetic `result` end-of-turn frame —
   *  interactive claude never sends one, so without it the viewer shows no turn separator between tmux
   *  turns (the mitm driver, on real RC, does).
   *
   *  Driven by the assistant message's `stop_reason`, NOT the idle debounce: a TOP-LEVEL assistant line
   *  whose stop_reason is terminal (`end_turn`/`stop_sequence`/`max_tokens`/`refusal`) IS the turn end —
   *  exactly the signal real RC turns into a `result`. The debounce can't be that signal: it also fires
   *  during the >1s inference gap between a tool_result and claude's next step (no open tool, turn not
   *  done) and can straddle a fast follow-up prompt, both of which emit spurious mid-turn separators
   *  (code-review + codex). `tool_use`/`pause_turn`/absent stop_reasons mean "more coming" → no fire; a
   *  NESTED sub-agent line (parent_tool_use_id set) is its own turn end, not the parent's → no fire. */
  onTurnEnd?: () => void;
}

/**
 * Drives `session.workerStatus` from transcript activity. Feed it each captured `UpstreamPayload`-ish
 * line via `onLine`; it flips to `running` immediately and arms the idle debounce. When a payload opens
 * a tool_use (tool call with no result yet) it suppresses idle until the matching tool_result lands.
 */
export class StatusTracker {
  readonly #session: Session;
  readonly #idleMs: number;
  readonly #hardIdleMs: number;
  readonly #timer: Timer;
  readonly #now: () => number;
  readonly #onTurnEnd: (() => void) | undefined;
  /** tool_use ids that have been called but whose tool_result hasn't arrived — idle is suppressed
   *  while any remain open (claude is waiting on a tool, not finished). */
  readonly #openTools = new Set<string>();
  #status: "running" | "idle" = "idle";
  #lastLineAt = 0; // #now() of the most recent append — the hard-idle window measures silence from here

  constructor(opts: StatusTrackerOptions) {
    this.#session = opts.session;
    this.#idleMs = opts.idleMs ?? IDLE_DEBOUNCE_MS;
    this.#hardIdleMs = opts.hardIdleMs ?? HARD_IDLE_MS;
    this.#timer = opts.timer ?? nodeTimer();
    this.#now = opts.now ?? Date.now;
    this.#onTurnEnd = opts.onTurnEnd;
  }

  /** Observe one captured transcript payload (already reshaped). Updates the open-tool set, flips to
   *  running, and (re)arms the idle debounce. Pass the SAME shape `transcriptToPayload` returns
   *  (including `parent_tool_use_id` for a nested sub-agent line). */
  onLine(payload: {
    type?: string;
    message?: { content?: unknown; stop_reason?: unknown };
    parent_tool_use_id?: string | null;
  }): void {
    this.#lastLineAt = this.#now();
    this.#trackTools(payload);
    this.#setStatus("running");
    this.#armIdle();
    // The turn separator is driven by the ground-truth `stop_reason`, NOT the idle debounce (see
    // onTurnEnd's doc). A TOP-LEVEL assistant line with a terminal stop_reason IS the turn end → fire
    // once, AFTER #setStatus so presence and the marker are coherent. (The driver pushes the assistant
    // frame before calling onLine, so the synthetic `result` lands after the answer it closes.)
    if (
      payload.type === "assistant" &&
      payload.parent_tool_use_id == null &&
      isTerminalStopReason(payload.message?.stop_reason)
    ) {
      this.#onTurnEnd?.();
    }
  }

  /** Update the open-tool set from a payload's content blocks: an assistant `tool_use` opens an id; a
   *  user `tool_result` closes the id it answers. ALSO: a TOP-LEVEL user message carrying TEXT (a fresh
   *  prompt or an interrupt marker like "[Request interrupted]") is a turn boundary — any tool_use still
   *  open from a prior turn was abandoned, so clear them rather than suppressing idle forever (review
   *  wf#2). A NESTED sub-agent user message (`parent_tool_use_id` set) is NOT a turn boundary — clearing
   *  on it would wipe the parent's still-open Agent/Task tool and flip the host to idle mid-turn while the
   *  sub-agent runs (codex/code-review finding). */
  #trackTools(payload: {
    type?: string;
    message?: { content?: unknown };
    parent_tool_use_id?: string | null;
  }): void {
    const content = payload.message?.content;
    if (!Array.isArray(content)) return;
    let userText = false;
    for (const b of content) {
      if (typeof b !== "object" || b === null) continue;
      const block = b as { type?: unknown; id?: unknown; tool_use_id?: unknown; text?: unknown };
      if (block.type === "tool_use" && typeof block.id === "string") {
        this.#openTools.add(block.id);
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        this.#openTools.delete(block.tool_use_id);
      } else if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim() !== ""
      ) {
        userText = true;
      }
    }
    // Only a TOP-LEVEL user prompt is a turn boundary (a nested sub-agent prompt must not wipe the
    // parent's open Agent/Task tool — that would idle the host mid-turn).
    const topLevel = payload.parent_tool_use_id == null;
    if (payload.type === "user" && userText && topLevel) this.#openTools.clear();
  }

  /** (Re)arm the idle debounce. On fire: go idle if no tool is open; if a tool IS open but the
   *  transcript has been silent for the HARD window, the tool was orphaned — force idle (clearing it).
   *  Otherwise RE-ARM and re-check (the original bug: it returned without re-arming, so once a tool was
   *  open idle was never reconsidered — review wf#2). */
  #armIdle(): void {
    this.#timer.set(() => {
      if (this.#openTools.size === 0) {
        this.#setStatus("idle");
        return;
      }
      if (this.#now() - this.#lastLineAt >= this.#hardIdleMs) {
        this.#openTools.clear(); // orphaned — no tool_result will ever close it
        this.#setStatus("idle");
        return;
      }
      this.#armIdle(); // tool still legitimately pending — keep checking
    }, this.#idleMs);
  }

  /** Set the worker status and wake the relay only on a real transition (so the announce dedups). */
  #setStatus(status: "running" | "idle"): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#session.workerStatus = status;
    this.#session.wake();
  }

  /** Stop the pending idle timer (driver teardown). */
  dispose(): void {
    this.#timer.clear();
  }
}
