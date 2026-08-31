// The tmux driver (Track B): drive a PLAIN `claude` in a detached tmux pane and bridge it to the
// broker — provider-agnostic (works on Bedrock/Vertex, where native Remote Control is disabled),
// because there is NO MITM and NO HTTPS_PROXY/NODE_EXTRA_CA_CERTS. claude talks to whatever provider
// it's configured for; we CAPTURE by tailing its local transcript JSONL and INJECT by typing into the
// pane via tmux. Startup prepares the private wrapper, spawns the pane, requires both pane liveness and
// Claude's private SessionStart marker, constructs every native pump, then crosses one readiness latch
// to publish truthful capabilities and make the broker bridge visible.
//
// The transcript's `message.content` blocks are byte-identical to the relay's input. The relay and
// viewer additionally enforce this driver's deliberately narrow capability and pane-text boundary;
// broker routing/backends remain shared with the other drivers.
//
// Review findings handled here: #2 dedup (uuid set before pushUpstream), #5 ack (in the inject pump),
// #6 local-prompt visibility (a prompt typed into the LOCAL tmux TUI is surfaced via the local-prompt
// LEDGER — parity with the opencode driver: an upstream `user` text line that doesn't match a prompt WE
// injected is tagged `local_prompt` so the relay renders it), #9 strict inject queue.

import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import { type Driver, type DriverContext, TMUX_HARNESS } from "../driver.js";
import { ReadyBridge } from "../drivers/ready-bridge.js";
import { RelayCore, type Session } from "../session.js";
import { INJECT_BUFFER, runInjectPump, settleMs } from "./inject.js";
import {
  extractSettingsArg,
  insertSettingsArg,
  mergeHooksIntoSettings,
  parseSentinel,
  type SessionHookEvent,
  sessionHookFragment,
  turnGateHookFragment,
} from "./sessionhook.js";
import { StatusTracker } from "./status.js";
import { realTmuxExec, TmuxCtl, type TmuxExec, type TmuxSessionState } from "./tmuxctl.js";
import {
  findNewestTranscript,
  findTranscriptById,
  listSubagentFiles,
  mergeBatchByTimestamp,
  messageHasToolResult,
  projectDir,
  readAgentTaskId,
  snapshotTranscriptInodes,
  subagentDir,
  TranscriptTailer,
  transcriptToPayload,
  userMessageText,
} from "./transcript.js";

/** Whether argv itself explicitly disabled Claude's native permission checks. Settings and managed
 * policy are resolved from Claude's transcript after startup; this helper never tries to emulate them. */
export function tmuxPermissionPosture(
  args: readonly string[],
): NonNullable<Driver["capabilities"]["permissionPosture"]> {
  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  for (let i = 0; i < options.length; i++) {
    const arg = options[i];
    if (arg === "--dangerously-skip-permissions") return "bypassed";
    if (arg === "--permission-mode=bypassPermissions") return "bypassed";
    if (arg === "--permission-mode" && options[i + 1] === "bypassPermissions") return "bypassed";
  }
  return "local";
}

function tmuxRuntimePermissionMode(
  event: SessionHookEvent,
  args: readonly string[],
  transcript: string,
  transcriptNotBefore?: number,
): string | null {
  const options = args.slice(0, args.indexOf("--") === -1 ? args.length : args.indexOf("--"));
  const directBypass = options.some(
    (arg, index) =>
      arg === "--dangerously-skip-permissions" ||
      arg === "--permission-mode=bypassPermissions" ||
      (arg === "--permission-mode" && options[index + 1] === "bypassPermissions"),
  );
  if (directBypass) return "bypassPermissions";
  if (event.permissionMode !== undefined && event.permissionMode !== "") {
    return event.permissionMode;
  }
  // A resumed transcript contains permission records from prior launches. Without a caller-supplied
  // current-launch boundary, none of that history is evidence of the mode Claude resolved *now*.
  return transcriptNotBefore === undefined
    ? null
    : transcriptPermissionMode(transcript, event.sessionId, transcriptNotBefore);
}

/** Read Claude's own resolved mode from timestamped transcript evidence at/after a caller-owned
 * boundary. `null` is retained for focused pure callers that have separately proved the bytes were
 * appended live; the tmux driver itself always supplies its per-attach clock boundary. Current Claude's
 * bare `permission-mode` record has no timestamp, so attached history never promotes it. */
function transcriptPermissionMode(
  text: string,
  sessionId: string,
  notBefore: number | null,
): string | null {
  let latest: string | null = null;
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line) as {
        type?: unknown;
        permissionMode?: unknown;
        sessionId?: unknown;
        timestamp?: unknown;
      };
      const timestamp =
        typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      if (
        (value.type === "permission-mode" || value.type === "user") &&
        typeof value.permissionMode === "string" &&
        value.permissionMode !== "" &&
        (typeof value.sessionId !== "string" || value.sessionId === sessionId) &&
        (notBefore === null || (Number.isFinite(timestamp) && timestamp >= notBefore))
      ) {
        latest = value.permissionMode;
      }
    } catch {
      // A blank, partial, or future record is not evidence of local enforcement.
    }
  }
  return latest;
}

type TurnGateRelease = "absent" | "preserved-newer" | "released";

/** Atomically reconcile one native completion with the content-free turn gate. The gate mtime is its
 * generation boundary: UserPromptSubmit updates it before every turn, while Claude timestamps
 * `turn_duration` only after the full model loop and continuation hooks finish. Rename first so a newer
 * hook or tmux-owned input helper creates a distinct pathname; preserve/restore any gate whose mtime is
 * not strictly older than this completion. External writers are safe on either side of the rename. */
export async function releaseTurnGateForCompletion(
  gatePath: string,
  reconcilePath: string,
  completedAt: number,
): Promise<TurnGateRelease> {
  try {
    await rename(gatePath, reconcilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }

  const restore = async (): Promise<void> => {
    try {
      await link(reconcilePath, gatePath);
    } catch (error) {
      // A concurrent UserPromptSubmit created a newer gate after our rename; preserve that pathname.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await rm(reconcilePath, { force: true });
  };

  let gateMtime: number;
  try {
    gateMtime = (await stat(reconcilePath)).mtimeMs;
  } catch (error) {
    // Unknown generation is never permission to open the pane. Restore the gate, then retire this
    // remote injection path through the caller's normal error boundary.
    await restore();
    throw error;
  }
  if (!(gateMtime < completedAt)) {
    await restore();
    return "preserved-newer";
  }
  await rm(reconcilePath, { force: true });
  return "released";
}

type NativeTurnFact = { at: number; kind: "blocked" | "cancelled" | "completed" };

const INTERRUPTED_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

function exactInterruptedMarker(content: unknown): boolean {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0];
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" &&
    INTERRUPTED_MARKERS.has((block as { text: string }).text)
  );
}

/** Exact Claude 2.1.237 native-turn terminal facts from the current main transcript. Normal completion
 * is the post-loop `turn_duration`. A user/remote cancel carries one of two exact marker payloads plus a
 * non-empty `interruptedMessageId` only after Claude's abort signal is latched; that signal prevents any
 * later tool/permission/question work. A hook-rejected UserPromptSubmit has one of two exact
 * informational-warning families: command-hook blocking, or a successful sibling hook's structured
 * `{continue:false}` stop. Claude can emit either warning before all concurrent hooks finish, so the
 * caller must fail-stop the remote projection rather than guess which gate generation to release.
 * Completion/cancellation generation reconciliation makes old backfill harmless while retaining a
 * newer prompt's gate. */
export function nativeTurnFact(
  line: string,
  sessionId: string,
  notBefore: number,
): NativeTurnFact | null {
  try {
    const value = JSON.parse(line) as {
      type?: unknown;
      subtype?: unknown;
      timestamp?: unknown;
      sessionId?: unknown;
      isSidechain?: unknown;
      interruptedMessageId?: unknown;
      level?: unknown;
      preventContinuation?: unknown;
      content?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const timestamp =
      typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
    if (
      (typeof value.sessionId === "string" && value.sessionId !== sessionId) ||
      value.isSidechain === true ||
      !Number.isFinite(timestamp) ||
      timestamp < notBefore
    ) {
      return null;
    }
    if (value.type === "system" && value.subtype === "turn_duration") {
      return { at: timestamp, kind: "completed" };
    }
    const exactHookRejection =
      typeof value.content === "string" &&
      (value.content.startsWith("UserPromptSubmit operation blocked by hook:\n") ||
        value.content === "Operation stopped by hook" ||
        value.content.startsWith("Operation stopped by hook: "));
    if (
      value.type === "system" &&
      value.subtype === "informational" &&
      value.level === "warning" &&
      value.preventContinuation === true &&
      exactHookRejection
    ) {
      return { at: timestamp, kind: "blocked" };
    }
    if (
      value.type === "user" &&
      value.message?.role === "user" &&
      exactInterruptedMarker(value.message.content) &&
      typeof value.interruptedMessageId === "string" &&
      value.interruptedMessageId !== ""
    ) {
      return { at: timestamp, kind: "cancelled" };
    }
    return null;
  } catch {
    return null;
  }
}

/** Prefer Claude's resolved mode from SessionStart or its transcript. If neither is readable, report
 * unknown rather than make a false local or bypass claim. Direct bypass flags win over records. */
export function tmuxRuntimePermissionPosture(
  event: SessionHookEvent,
  args: readonly string[] = [],
  transcript = "",
  transcriptNotBefore?: number,
): NonNullable<Driver["capabilities"]["permissionPosture"]> {
  const resolved = tmuxRuntimePermissionMode(event, args, transcript, transcriptNotBefore);
  if (resolved === null) return "unknown";
  return resolved === "bypassPermissions" ? "bypassed" : "local";
}

/** Honest lower-fidelity capabilities. Claude's native pane owns permissions and questions unless the
 * caller explicitly bypassed them. Browser input is excluded from an already-active native turn and
 * the permission/question modal reached within it; idle editor and generic idle-modal concurrency are
 * not isolated. Raw controls and slash commands stay local. Transcript timing only gives heuristic
 * status, so that capability stays false. */
export function tmuxCapabilities(
  permissionPosture: NonNullable<Driver["capabilities"]["permissionPosture"]> = "local",
): Driver["capabilities"] {
  return {
    structuredPermissions: false,
    permissionPosture,
    status: false,
    controls: { interrupt: false, setModel: false, setMode: false, end: false },
    attachments: true,
  };
}

/** Env vars scrubbed from the child claude — ONLY the stub-gotcha ids + our host-only secrets.
 *  CLAUDE_CODE_CHILD_SESSION makes the spawned claude a STUB bridged to the launcher (never a real
 *  session); CLAUDE_CODE_SESSION_ID pins/resumes the parent's id; the two secrets are host-only and
 *  the child has no business with them.
 *
 *  We deliberately do NOT touch proxy/CA env (HTTP(S)_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS). This
 *  driver runs a PLAIN claude and never sets a proxy of its own — so it must also leave the user's
 *  alone: a corporate egress proxy, a Bedrock-behind-proxy setup, or the user's own MITM all need
 *  those vars to reach the provider. The thin-wrapper rule: we don't set it, so we don't strip it. */
const SCRUB_ENV = new Set([
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "REMOTE_CLAW_SECRET_FILE",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
]);

/** Proxy/CA vars we PASS THROUGH when the wrapper's own env sets them (the user's legit egress proxy /
 *  Bedrock-behind-proxy / their own MITM), but UNSET for the child when the parent env does NOT set them
 *  — so a stale value living in a PRE-EXISTING tmux server's environment can't leak in (codex review #4). */
const PROXY_CA_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Same stale-server defense for CLAUDE_CONFIG_DIR. If the wrapper's env sets it, buildChildEnv passes it
 * through so the pane honors the caller's configuration; if it does not, we unset it so a stale value in
 * a pre-existing tmux server cannot redirect Claude to an unrelated config directory. */
const CHILD_CONFIG_VARS = ["CLAUDE_CONFIG_DIR"] as const;

/** Build the child env: inherit the parent env and scrub only the stub-gotcha ids + host-only secrets
 *  (proxy/CA env passes through — see SCRUB_ENV). It is supplied to the private tmux server through
 *  `execFile` options, never serialized into tmux argv. */
export function buildChildEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || SCRUB_ENV.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Quote a command string so tmux runs `claude <args>` correctly even with spaces in an arg. tmux's
 *  `new-session <command>` hands the string to `/bin/sh -c`, so single-quote each token (escaping any
 *  embedded single quote). Args come from the user's own argv, not the network. */
export function shellQuoteCommand(parts: readonly string[]): string {
  return parts.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
}

const CLAUDE_SESSION_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Detect whether the user's harness args already drive the session, and extract an explicit id if they
 *  gave one. Recognizes the long forms `--session-id` / `--resume` / `--continue` (incl. `--flag=value`)
 *  and the short `-r` / `-c`. `--session-id` always carries an id; Claude's optional `--resume [value]`
 *  is different: only a UUID is an exact session id, while any other value is a picker search term.
 *  Stops at a `--` separator (anything after is a literal, not an option) so `-r` as a flag value past
 *  `--` doesn't false-trigger. When the user owns the session we don't pin; when they gave an explicit id
 *  we track that transcript by id. A picker (`--continue`, bare `--resume`, or `--resume <search>`) leaves
 *  the id unknown until the mandatory SessionStart marker resolves it. Pure, exported for unit tests. */
export function parseUserSession(args: readonly string[]): {
  ownsSession: boolean;
  explicitId: string | null;
} {
  const sep = args.indexOf("--");
  const opts = sep === -1 ? args : args.slice(0, sep);
  let ownsSession = false;
  let explicitId: string | null = null;
  const takeNext = (i: number): string | null => {
    const v = opts[i + 1];
    return v !== undefined && !v.startsWith("-") ? v : null;
  };
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i] ?? "";
    const long = a.match(/^--(session-id|resume|continue)(?:=(.*))?$/);
    if (long) {
      ownsSession = true;
      const name = long[1];
      if (name !== "continue") {
        const value = long[2] !== undefined && long[2] !== "" ? long[2] : takeNext(i);
        if (value !== null && (name === "session-id" || CLAUDE_SESSION_UUID.test(value))) {
          explicitId = value;
        }
      }
    } else if (a === "-r") {
      ownsSession = true;
      const value = takeNext(i);
      if (value !== null && CLAUDE_SESSION_UUID.test(value)) explicitId = value;
    } else if (a === "-c") {
      ownsSession = true;
    }
  }
  return { ownsSession, explicitId };
}

function hasHarnessOption(args: readonly string[], option: string): boolean {
  const separator = args.indexOf("--");
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  return optionArgs.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

export interface TmuxDriverDeps {
  /** Injectable tmux exec (tests pass a spy; default is the real `tmux` binary). */
  tmuxExec?: TmuxExec;
  /** Injectable poll interval for the transcript tailer (ms). */
  pollMs?: number;
  /** Injectable settle delay between paste and Enter (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the home dir used to locate ~/.claude/projects (tests). */
  home?: string;
  /** Override the parent env scrubbed for the child (tests). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Hook fired once the transcript file is discovered (tests/observability). */
  onTranscript?: (path: string) => void;
  /** Poll interval (ms) for the pane-liveness watcher (default PANE_WATCH_MS). */
  paneWatchMs?: number;
  /** Warn if no transcript is discovered within this many ms of spawn (default DISCOVERY_WARN_MS). */
  discoveryWarnMs?: number;
  /** Maximum startup wait for the injected SessionStart readiness hook (tests). */
  readinessTimeoutMs?: number;
  /** Poll interval while waiting for the injected SessionStart readiness hook (tests). */
  readinessPollMs?: number;
  /** Override the pinned session id (tests) — makes the spawned `<uuid>.jsonl` filename deterministic
   *  without parsing the tmux command. Production mints a fresh v4 UUID. */
  sessionId?: string;
  /** Keep consuming the mandatory private SessionStart marker after readiness for exact transcript
   * discovery + rotation-follow (`--rc-session-hook`). False disables ongoing follow, not the one
   * SessionStart marker the driver always injects and requires before publication. */
  injectSessionHook?: boolean;
  /** Override the private readiness-marker path (tests). When ongoing follow is enabled, capture uses
   * this same file for transcript discovery and rotations. */
  sentinelPath?: string;
  /** Override the private per-launch runtime directory (tests only). A caller-supplied directory is
   *  chmodded to 0700 but retained after teardown so the test owner can inspect/remove it. */
  runtimeDir?: string;
  /** Hook fired after the private runtime directory exists (tests/observability). */
  onRuntimeDir?: (path: string) => void;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How often (ms) the capture loop probes `tmux has-session` for pane liveness (codex review #3). */
export const PANE_WATCH_MS = 1000;
/** Consecutive "session gone" probes required before tearing down — so one transient probe (e.g. tmux
 *  momentarily un-runnable under load) can't kill a healthy session (review wf#3). */
export const PANE_GONE_CONFIRMATIONS = 2;
/** How long after spawn to wait for claude's transcript before warning it may not be writing one. */
export const DISCOVERY_WARN_MS = 15_000;
/** A pane is not public merely because tmux briefly reports it alive. Claude must execute the
 * SessionStart hook from the exact merged settings file. */
export const READINESS_TIMEOUT_MS = 30_000;
/** Readiness polling is intentionally independent of the inject/capture test sleeper. */
export const READINESS_POLL_MS = 50;
/** With ongoing marker-follow ON but the session id UNKNOWN (a `--continue`/picker run, no pin), how long
 * to let a new SessionStart marker report the exact transcript before falling back to newest-file
 * discovery. The mandatory startup marker has already proved hooks work; this grace covers the later
 * capture/rotation observation window without confusing a concurrent same-cwd sibling. */
export const HOOK_GRACE_MS = 4000;
/** Bounded wait for the relay's final flush + the pumps to settle on teardown, so a hung `serve()` or a
 *  hung tmux exec can't block `kill-session` (codex review #3/#7) — mirrors launch.ts's bounded wait. */
export const TEARDOWN_FLUSH_MS = 2000;

/** Await `p`, but give up after `ms` — with an UNREF'd timer that is CLEARED the instant `p` settles, so
 *  a fast-settling promise leaves no 2s zombie timer (codex review #7). Never rejects. */
function boundedWait(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(handle);
      resolve();
    };
    const handle = setTimeout(finish, ms);
    if (typeof handle.unref === "function") handle.unref();
    p.then(finish, finish);
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

async function writePrivateFile(
  path: string,
  contents: string,
  mode: 0o600 | 0o700 = 0o600,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

async function makeRuntimeDir(override: string | undefined): Promise<{
  path: string;
  owned: boolean;
}> {
  if (override !== undefined) {
    await mkdir(override, { recursive: true, mode: 0o700 });
    await chmod(override, 0o700);
    return { path: override, owned: false };
  }
  const path = await mkdtemp(join(tmpdir(), "remote-claw-tmux-"));
  await chmod(path, 0o700);
  return { path, owned: true };
}

/** Fixed helper run by tmux/Claude—not Node—for the short UserPromptSubmit/remote-submit critical
 * section. Linux `flock` is tied to fd 9, so the kernel releases it on every exit including SIGKILL/OOM.
 * Remote prompt bytes never enter helper argv: Node loaded the named tmux buffer over stdin first. A
 * Claude hook payload enters only helper stdin and is drained without storage or transport. Remote
 * outcomes are non-secret, per-attempt files written temp+rename so missing/malformed means ambiguity,
 * never a stale success. A failed/ambiguous remote mutation deliberately leaves the gate closed. */
export function tmuxInputHelperScript(): string {
  return `#!/bin/sh
set -u
umask 077

write_outcome() {
  outcome_tmp="\${outcome}.tmp.$$"
  if printf '%s\\n' "$1" > "$outcome_tmp"; then
    mv -f -- "$outcome_tmp" "$outcome"
  else
    rm -f -- "$outcome_tmp"
    return 1
  fi
}

mode=\${1-}
if [ "$mode" = probe ]; then
  [ "$#" -eq 3 ] || exit 64
  lock_file=$2
  outcome=$3
  command -v flock >/dev/null 2>&1 || { write_outcome unavailable; exit 69; }
  exec 9>"$lock_file" || { write_outcome unavailable; exit 70; }
  flock -x 9 || { write_outcome unavailable; exit 71; }
  write_outcome ready
  exit 0
fi

if [ "$mode" = prompt ]; then
  [ "$#" -eq 3 ] || exit 2
  gate=$2
  lock_file=$3
  cat >/dev/null || exit 2
  exec 9>"$lock_file" || exit 2
  flock -x 9 || exit 2
  : > "$gate" || exit 2
  # Completion/cancellation records used by the generation CAS can occur only after this synchronous
  # hook returns, at integer-ms precision. Keep those timestamps strictly newer than the fractional
  # filesystem mtime. Concurrent sibling-hook rejections are fail-stopped separately, never CAS-released.
  sleep 0.010 || exit 2
  exit 0
fi

if [ "$mode" = end ]; then
  [ "$#" -eq 4 ] || exit 2
  gate=$2
  lock_file=$3
  ended=$4
  cat >/dev/null || exit 2
  exec 9>"$lock_file" || exit 2
  flock -x 9 || exit 2
  : > "$gate" || exit 2
  : > "$ended" || exit 2
  exit 0
fi

[ "$mode" = remote ] && [ "$#" -eq 8 ] || exit 64
socket=$2
target=$3
gate=$4
lock_file=$5
buffer=$6
settle=$7
outcome=$8
exec 9>"$lock_file" || { write_outcome ambiguous; exit 70; }
flock -x 9 || { write_outcome ambiguous; exit 71; }
if ! (set -C; : > "$gate") 2>/dev/null; then
  write_outcome busy
  exit 0
fi
if ! tmux -S "$socket" paste-buffer -d -p -b "$buffer" -t "$target"; then
  write_outcome failed
  exit 0
fi
if ! sleep "$settle"; then
  write_outcome ambiguous
  exit 0
fi
if ! tmux -S "$socket" send-keys -t "$target" Enter; then
  write_outcome ambiguous
  exit 0
fi
write_outcome applied
`;
}

/**
 * Run the tmux driver until `signal` aborts, claude exits / the pane closes, or a pump crashes:
 *   1. Create a readiness latch in `starting`; no broker client exists yet.
 *   2. Prepare a private runtime directory/socket, readiness hook, and scrubbed launch environment.
 *   3. Spawn claude and require both a live pane and its exact private SessionStart marker.
 *   4. Construct capture/injection pumps, then start the bridge. That readiness edge alone
 *      creates the broker client and announces the conversation.
 *   5. Teardown closes the bridge and pane under one deadline; private files are removed only when pane
 *      termination is known.
 * Exit code: 1 if a pump crashed, else 0 (a clean pane death / external abort). The run.ts dispatch maps
 * SIGINT/SIGTERM to 128+N. NOTE: unlike a bare detached pane, claude exiting now ENDS the wrapper (the
 * capture loop's liveness probe aborts), so the driver's lifetime is `signal` OR the pane's life.
 */
export async function runTmuxDriver(
  ctx: DriverContext,
  signal: AbortSignal,
  deps: TmuxDriverDeps = {},
  publishedCapabilities?: Driver["capabilities"],
): Promise<number> {
  // A dead-on-arrival wrapper owns no pane and publishes no compatibility conversation.
  if (signal.aborted) return 0;

  const tracer: Tracer = (ctx.tracer ?? NOOP_TRACER).child({ driver: "tmux" });
  const tmuxExec = deps.tmuxExec ?? realTmuxExec;
  const binaryTmux = new TmuxCtl(tmuxExec);
  let tmux = binaryTmux;
  const sleep = deps.sleep ?? sleepReal;
  const pollMs = deps.pollMs ?? 120;
  const parentEnv = deps.parentEnv ?? process.env;

  // Verify tmux is present BEFORE we mint a session — a clear error beats a half-bridged launch.
  try {
    const ver = await binaryTmux.version();
    tracer.debug("tmux present", { version: ver });
  } catch (e) {
    if (signal.aborted) return 0;
    throw new Error(
      `tmux not found — install it (e.g. sudo apt-get install -y tmux): ${(e as Error)?.message ?? e}`,
    );
  }
  if (signal.aborted) return 0;

  const core = new RelayCore();
  const session: Session = core.create({ title: ctx.title });
  session.pushInitialize(); // guarantees `initialize` is the first downstream event
  ctx.onSession?.(session);

  const relays = new Set<Promise<void>>();
  const terminalTasks = new Set<Promise<void>>();
  const bridge = new ReadyBridge({
    session,
    newClient: ctx.newClient,
    identityId: ctx.identity.identityId,
    relays,
    terminalTasks,
    tracer,
    parentSignal: signal,
  });
  const stop = bridge.signal;

  // Closing the readiness latch aborts synchronously, so cancellation, pane death, or a pump crash
  // cannot be overtaken by a late ready result and publish a ghost.
  const requestDriverStop = (reason: string): void => {
    void bridge.close(reason).catch((error: unknown) => {
      try {
        tracer.error("tmux bridge close failed", { error: String(error) });
      } catch {
        // Diagnostics never own the shutdown boundary.
      }
    });
  };

  const tmuxName = `rc-${session.id}`;
  let spawnAttempted = false;
  let runtimePath: string | null = null;
  let runtimeOwned = false;
  let socketPath: string | null = null;
  let settingsPath: string | null = null;
  let launcherPath: string | null = null;
  const privateFiles = new Set<string>();
  let readinessPath: string | null = null;
  let sentinelPath: string | null = null;
  let status: StatusTracker | null = null;
  let capture: Promise<void> = Promise.resolve();
  let inject: Promise<void> = Promise.resolve();
  let pumpCrashed = false;
  let registrationReady = false;

  try {
    throwIfAborted(stop);
    const runtime = await makeRuntimeDir(deps.runtimeDir);
    runtimePath = runtime.path;
    runtimeOwned = runtime.owned;
    socketPath = join(runtime.path, "tmux.sock");
    settingsPath = join(runtime.path, "settings.json");
    launcherPath = join(runtime.path, "launch.sh");
    tmux = new TmuxCtl(tmuxExec, socketPath);
    deps.onRuntimeDir?.(runtime.path);
    throwIfAborted(stop);

    // The tmux session name carries the broker session id (cse_<hex>) so the user can attach the pane.
    const bin = ctx.harnessBin ?? "claude";
    // The random private socket guarantees this launch creates a fresh tmux server. Its inherited
    // environment is the scrubbed child environment supplied through execFile options, never `-e`
    // command-line values. Keep `env -u` as defense in depth for host-only variables and explicit
    // absence of proxy/config variables.
    const envUnset = [
      ...[...SCRUB_ENV].flatMap((k) => ["-u", k]),
      ...[...PROXY_CA_VARS, ...CHILD_CONFIG_VARS]
        .filter((k) => parentEnv[k] === undefined)
        .flatMap((k) => ["-u", k]),
    ];
    // PIN the session id (verified: `claude --session-id <uuid>` with NO --resume starts a FRESH session
    // and writes its transcript at exactly `<uuid>.jsonl`). This makes the first attach DETERMINISTIC and
    // disambiguates concurrent same-cwd siblings (no `findNewestTranscript` guesswork). claude requires a
    // valid v4 UUID (a ULID is rejected). We still SCRUB the inherited CLAUDE_CODE_SESSION_ID (no parent
    // leak) and pass a fresh one as a flag.
    //
    // If the USER already drives the session (--session-id / --resume / --continue, long, short, or
    // `=value` forms), we do NOT pin. We still TRACK by id when they gave an explicit UUID —
    // `--resume <uuid>` APPENDS to `<uuid>.jsonl` (verified; -p), which `findNewestTranscript` would miss
    // as "not fresh", so we locate it by id. A picker (`--continue`, bare `--resume`, or the optional
    // non-UUID `--resume <search>`) leaves the id unknown → newest-file heuristic. NOTE: an in-session
    // `/clear` or `/branch` ROTATES to a NEW uuid file (verified) — following that rotation is a separate
    // follow-up; this governs the FIRST attach (the common case).
    const userSession = parseUserSession(ctx.harnessArgs);
    const sessionUuid = userSession.ownsSession ? null : (deps.sessionId ?? randomUUID());
    // The id whose transcript we TRACK: our pin, else the user's explicit resume/session id, else null
    // (unknown — picker/continue → newest-file heuristic).
    const trackedId = sessionUuid ?? userSession.explicitId;
    // A SessionStart event from OUR merged settings is the positive native-readiness proof. A successful
    // tmux probe alone only proves that a short-lived launcher happened to exist for one instant; it does
    // not prove Claude loaded the settings. The discovery flag controls whether
    // capture follows this file after readiness, but the one startup proof is always required.
    readinessPath = deps.sentinelPath ?? join(runtime.path, "session-events.ndjson");
    const activeTurnGatePath = join(runtime.path, "turn-active");
    const turnGateReconcilePath = join(runtime.path, "turn-active.reconcile");
    const sessionEndedPath = join(runtime.path, "session-ended");
    const inputHelperPath = join(runtime.path, "input-gate.sh");
    const inputLockPath = join(runtime.path, "input-gate.lock");
    privateFiles.add(activeTurnGatePath);
    privateFiles.add(turnGateReconcilePath);
    privateFiles.add(sessionEndedPath);
    privateFiles.add(inputHelperPath);
    privateFiles.add(inputLockPath);
    sentinelPath = deps.injectSessionHook ? readinessPath : null;
    const hookDisablingArg = ["--bare", "--safe-mode"].find((option) =>
      hasHarnessOption(ctx.harnessArgs, option),
    );
    const hookDisablingEnv = ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE"].find((name) => {
      const value = parentEnv[name]?.trim().toLowerCase();
      return value !== undefined && !["", "0", "false", "no", "off"].includes(value);
    });
    if (hookDisablingArg !== undefined || hookDisablingEnv !== undefined) {
      throw new Error(
        `tmux remote readiness requires Claude hooks; remove ${hookDisablingArg ?? hookDisablingEnv}`,
      );
    }
    await writePrivateFile(readinessPath, "");
    privateFiles.add(readinessPath);
    throwIfAborted(stop);

    // Build the private SessionStart readiness setting, deep-merged with the user's settings and hooks.
    // Native Claude remains the sole owner of permissions; no PreToolUse hook or policy mutation is added.
    const { value, rest } = extractSettingsArg(ctx.harnessArgs);
    const merged = await mergeHooksIntoSettings(value, [
      sessionHookFragment(readinessPath),
      turnGateHookFragment(activeTurnGatePath, sessionEndedPath, inputHelperPath, inputLockPath),
    ]);
    if (merged === null) {
      throw new Error(
        "could not merge the required tmux readiness hook into --settings; fix the settings input",
      );
    }
    await writePrivateFile(settingsPath, `${merged}\n`);
    privateFiles.add(settingsPath);
    // Insert before `--` so Claude parses the private file path as an option.
    const harnessArgs: readonly string[] = insertSettingsArg(rest, settingsPath);
    tracer.debug("hooks injected", {
      sessionHook: sentinelPath !== null,
      readinessHook: true,
      turnGateHook: true,
      mergedUserSettings: value !== null,
    });

    const command = shellQuoteCommand([
      "env",
      ...envUnset,
      bin,
      ...(sessionUuid !== null ? ["--session-id", sessionUuid] : []),
      ...harnessArgs,
    ]);
    await writePrivateFile(launcherPath, `#!/bin/sh\nexec ${command}\n`, 0o700);
    privateFiles.add(launcherPath);
    await writePrivateFile(inputHelperPath, tmuxInputHelperScript(), 0o700);

    // Snapshot before spawn so capture cannot attach to an already-running sibling transcript.
    const dir = projectDir(ctx.cwd, deps.home);
    const preexisting = await snapshotTranscriptInodes(dir);
    throwIfAborted(stop);
    const spawnedAt = Date.now();
    spawnAttempted = true;
    try {
      await tmux.newSession(tmuxName, shellQuoteCommand([launcherPath]), {
        cwd: ctx.cwd,
        env: buildChildEnv(parentEnv),
        width: 200,
        height: 50,
      });
    } catch (e) {
      throw new Error(`could not start private tmux session: ${(e as Error)?.message ?? e}`);
    }
    // Print the recovery path as soon as the pane exists, before the readiness barrier. A fresh cwd can
    // legitimately show Claude's native folder-trust prompt before SessionStart runs; remote-claw never
    // pre-accepts that trust or changes permission policy, so the local owner must be able to attach now.
    const attachCommand = shellQuoteCommand(["tmux", "-S", socketPath, "attach", "-t", tmuxName]);
    process.stderr.write(`remote-claw: claude running in tmux — attach with: ${attachCommand}\n`);
    process.stderr.write(
      "remote-claw: tmux idle editor/slash/config UI is shared; do not manipulate it while remote viewers may submit\n",
    );
    throwIfAborted(stop);
    const readinessDeadline = Date.now() + (deps.readinessTimeoutMs ?? READINESS_TIMEOUT_MS);
    let readyEvent: SessionHookEvent | null = null;
    while (!stop.aborted && Date.now() <= readinessDeadline) {
      const paneState: TmuxSessionState = await tmux.sessionState(tmuxName);
      if (paneState === "gone") {
        throw new Error("tmux pane exited before Claude reported native readiness");
      }
      const candidate = parseSentinel(await readFile(readinessPath, "utf8").catch(() => ""));
      if (candidate !== null) {
        if (trackedId !== null && candidate.sessionId !== trackedId) {
          throw new Error("Claude readiness reported an unexpected native session");
        }
        if (paneState === "present") {
          readyEvent = candidate;
          break;
        }
      }
      await sleepReal(deps.readinessPollMs ?? READINESS_POLL_MS);
    }
    throwIfAborted(stop);
    if (readyEvent === null) {
      throw new Error(
        "Claude did not execute the required SessionStart readiness hook; attach to the tmux pane above and complete any native trust prompt, or check settings/policy",
      );
    }
    // Folder trust remains wholly native. Once SessionStart proves Claude loaded the merged settings,
    // prove the helper's kernel lock before publishing any writable remote projection. The synchronous
    // UserPromptSubmit hook already uses this helper; no global key binding or TUI parser is installed.
    const helperProbeOutcome = join(runtime.path, `input-probe-${randomUUID()}`);
    await tmux.runShell(
      shellQuoteCommand([inputHelperPath, "probe", inputLockPath, helperProbeOutcome]),
    );
    const helperProbe = await readFile(helperProbeOutcome, "utf8").catch(() => "");
    await rm(helperProbeOutcome, { force: true }).catch(() => {});
    if (helperProbe.trim() !== "ready") {
      throw new Error("tmux input arbitration requires a working Linux flock command");
    }
    tracer.debug("Claude native readiness proved", {
      sessionId: readyEvent.sessionId,
      transcriptPath: readyEvent.transcriptPath,
    });

    // Activity remains heuristic and unadvertised. Turn separators are emitted below from Claude's
    // authoritative post-loop `turn_duration`, not an earlier assistant stop_reason that a Stop hook or
    // built-in continuation may follow.
    const runStatus = new StatusTracker({ session });
    status = runStatus;

    // A pump that crashes is a BUG, not a clean exit — record it so we return non-zero (codex review #3).
    const onPumpCrash = (where: string, e: unknown): void => {
      pumpCrashed = true;
      tracer.error(`${where} pump crashed`, { error: String(e) });
      requestDriverStop(`${where} pump crashed`);
    };

    // CAPTURE + PANE-LIVENESS (one loop so the tailer is never polled concurrently): discover THIS
    // launch's transcript (excluding pre-existing files), tail it, AND probe the pane on a cadence. A
    // CONFIRMED pane death (claude exited / pane closed) ends the bridge — but we drain ONCE MORE first so
    // claude's final lines reach the viewer before abort (the relay stops consuming once aborted, review
    // codex#2). seenUuids makes the extra drain idempotent.
    const seenUuids = new Set<string>(); // review #2: re-pushing a uuid does NOT dedup at the relay
    // LOCAL-PROMPT LEDGER (parity with the opencode driver) — a DISPLAY-side concern only; it never touches
    // the inject path (commands to claude must not be lossy; the remote transcript may be). A multiset of
    // the prompt texts WE injected via the pane. claude echoes every prompt as a `user` transcript line; one
    // that matches a recorded inject is OUR echo (the relay already showed the viewer's prompt → suppress
    // it), while an unmatched user-text line was typed at the LOCAL tmux TUI → tag `local_prompt` so the
    // relay surfaces it. Keys are TRIMMED so trailing-whitespace drift in claude's echo still matches.
    // FIFO-capped so a never-matching echo (e.g. claude reshaping the text) can't grow it unbounded, and
    // cleared on rotation (text keys aren't session-scoped — see attach). Best-effort by design: two
    // identical prompts (one injected, one locally typed) are indistinguishable — same documented limit as
    // opencode. A mis-classification only mis-renders the transcript, never a command.
    const injectedTexts = new Map<string, number>();
    const INJECTED_LEDGER_CAP = 256;
    const recordInjected = (text: string): void => {
      const key = text.trim();
      injectedTexts.set(key, (injectedTexts.get(key) ?? 0) + 1);
      while (injectedTexts.size > INJECTED_LEDGER_CAP) {
        const oldest = injectedTexts.keys().next().value; // Map preserves insertion order → FIFO eviction
        if (oldest === undefined) break;
        injectedTexts.delete(oldest);
      }
    };
    /** Consume one matching entry; true ⇒ this user line is OUR injected echo (caller suppresses it). */
    const consumeInjected = (text: string): boolean => {
      const key = text.trim();
      const n = injectedTexts.get(key) ?? 0;
      if (n <= 0) return false;
      if (n === 1) injectedTexts.delete(key);
      else injectedTexts.set(key, n - 1);
      return true;
    };
    const discoveryWarnMs = deps.discoveryWarnMs ?? DISCOVERY_WARN_MS;
    const paneWatchMs = deps.paneWatchMs ?? PANE_WATCH_MS;
    const paneCheckEvery = Math.max(1, Math.round(paneWatchMs / pollMs)); // ≈paneWatchMs between probes
    let tailer: TranscriptTailer | null = null;
    // Sub-agent (Agent/Task) output lives in sibling `subagents/agent-*.jsonl` files (+ a `.meta.json`
    // sidecar) the main tailer can't see. We tail them too and overlay `parent_tool_use_id` = the spawning
    // Agent's tool_use_id (from the sidecar's `toolUseId`) so the viewer NESTS sub-agent work under the
    // Agent — like native RC — instead of dropping it or flooding the main transcript. A file is tailed
    // only once its `.meta.json` link is readable, so every surfaced sub-agent line is guaranteed to nest.
    let subDir: string | null = null;
    const subTailers = new Map<string, { tailer: TranscriptTailer; taskId: string }>();
    let currentPath: string | null = null; // the main transcript we're tailing (changes on a rotation)
    let currentNativeSessionId = readyEvent.sessionId;
    let observedPermissionMode: string | null = null;
    // Set on EVERY transcript attach, not once per wrapper launch. Existing bytes in a resumed/rotated
    // file are never posture evidence: another same-user process may have written them after this wrapper
    // originally spawned. `+1` makes same-millisecond ambiguity fail closed; the next timestamped live
    // user record resolves the posture.
    let permissionEvidenceNotBefore = Number.POSITIVE_INFINITY;
    const completedTurns: number[] = [];

    // (Re)bind the tailer to `path`. A rotation (the hook sentinel reporting a NEW transcript after /clear,
    // /branch, /compact, or resume) clears the sub-agent tailers (a new session = a fresh subagents/ dir)
    // but KEEPS seenUuids so nothing re-emits. The sentinel is an unambiguous rotation signal, so following
    // it is safe (no concurrent-sibling guesswork). A no-op if already on `path`.
    const attach = (path: string): void => {
      if (path === currentPath) return;
      // On a ROTATION (not the first attach), clear the local-prompt ledger: its keys are TEXT, not
      // session-scoped, so a stale entry from the old session would wrongly suppress an identical prompt
      // typed in the new one. (seenUuids stays — uuids are globally unique, so keeping it is safe.) Skip on
      // the first attach so a prompt injected before discovery still has its echo suppressed.
      if (currentPath !== null) injectedTexts.clear();
      tailer = new TranscriptTailer(path);
      subDir = subagentDir(path);
      subTailers.clear();
      currentPath = path;
      permissionEvidenceNotBefore = Date.now() + 1;
      deps.onTranscript?.(path);
      tracer.debug("transcript attached", { path, subDir });
    };

    // The latest SessionStart event from the private marker file while ongoing follow is enabled, or null
    // when follow is off / no readable event remains. Startup already required the initial marker. Reading
    // the small NDJSON file is cheap and parseSentinel tolerates a torn append.
    const readSentinelEvent = async (): Promise<SessionHookEvent | null> =>
      sentinelPath === null
        ? null
        : parseSentinel(await readFile(sentinelPath, "utf8").catch(() => ""));

    // Reshape → (overlay nesting) → dedup → status → pushUpstream for one line. `parentTaskId`, when given
    // (a sub-agent file), overrides parent_tool_use_id so the line nests under its Agent. seenUuids dedups
    // across the main + every sub-agent tailer.
    const handleLine = (line: string, parentTaskId?: string): void => {
      if (parentTaskId === undefined) {
        const turnFact = nativeTurnFact(line, currentNativeSessionId, Number.NEGATIVE_INFINITY);
        if (turnFact?.kind === "completed") {
          // Interactive Claude does not emit RC `result`; this empty result is the viewer's turn
          // separator. Backfilled duration records still render history separators; their old timestamp
          // cannot release a later gate generation.
          if (!session.closed) {
            session.pushUpstream({ type: "result", subtype: "success", result: "" });
          }
        }
        if (turnFact?.kind === "blocked") {
          // Claude races UserPromptSubmit hook results and can publish this warning before our sibling
          // helper has even touched the gate. No timestamp can safely identify that generation. Retire
          // only the remote projection and leave the gate closed; the native pane remains locally usable.
          // Unlike completion CAS, a fail-stop has no generation guard, so old transcript backfill must
          // not retire a fresh projection. Only a warning from this wrapper launch is actionable.
          if (turnFact.at >= spawnedAt && !session.closed) {
            session.close("native prompt rejected by hook");
          }
        } else if (turnFact !== null) {
          completedTurns.push(turnFact.at);
        }
        const permissionMode = transcriptPermissionMode(
          line,
          currentNativeSessionId,
          permissionEvidenceNotBefore,
        );
        if (
          permissionMode !== null &&
          permissionMode !== observedPermissionMode &&
          !session.closed
        ) {
          observedPermissionMode = permissionMode;
          session.pushUpstream({ type: "system", permissionMode });
        }
      }
      const payload = transcriptToPayload(line);
      if (payload === null) return;
      if (parentTaskId !== undefined) payload.parent_tool_use_id = parentTaskId;
      const uuid = typeof payload.uuid === "string" ? payload.uuid : null;
      if (uuid !== null) {
        if (seenUuids.has(uuid)) return; // dedup BEFORE pushUpstream (review #2)
        seenUuids.add(uuid);
      }
      // Local-prompt ledger — only TOP-LEVEL user TEXT turns (a sub-agent's user lines carry a
      // parent_tool_use_id — set above from `parentTaskId` for sub-files, or by the transcript rename for a
      // main-file nested line — and must NOT be ledgered; a tool_result turn is handled by the relay's
      // tool_result branch and must NOT be suppressed). Gate on the PAYLOAD field (not just the tailer's
      // parentTaskId arg) so a main-file line that already carries parent_tool_use_id is excluded too. A
      // match means it's OUR injected prompt's echo → drop the FRAME (the relay already showed the viewer's
      // prompt), but STILL feed status.onLine below so the turn boundary clears any abandoned open tool.
      let suppressFrame = false;
      if (
        payload.type === "user" &&
        payload.parent_tool_use_id == null &&
        !messageHasToolResult(payload.message)
      ) {
        const text = userMessageText(payload.message);
        // Trim to match the trimmed ledger keys: a whitespace-only line trims to "" (never a key), so skip
        // it rather than surfacing an empty local_prompt bubble.
        if (text.trim() !== "") {
          if (consumeInjected(text))
            suppressFrame = true; // our echo — drop the display frame only
          else payload.local_prompt = true; // typed at the local pane → surface it for viewers
        }
      }
      // A broker fail-stop closes only the compatibility Session. Keep watching the local pane, but
      // stop projecting into the closed relay so remote failure cannot become a pane failure.
      if (session.closed) return;
      if (!suppressFrame) session.pushUpstream(payload);
      runStatus.onLine(payload); // ALWAYS while projected: a user text line remains a turn boundary
    };

    /** Drain exact native completion/cancel/rejection facts promptly, even when no browser prompt is
     * waiting. The rename/link CAS itself serializes against local-hook and remote-helper gate writes:
     * backfill can never release a newer generation, and no Node-held lock can outlive this process. */
    const reconcileCompletedTurns = async (): Promise<void> => {
      while (completedTurns.length > 0) {
        const completedAt = completedTurns.shift();
        if (completedAt === undefined) break;
        const outcome = await releaseTurnGateForCompletion(
          activeTurnGatePath,
          turnGateReconcilePath,
          completedAt,
        );
        tracer.debug("native turn gate reconciled", { outcome, completedAt });
      }
    };

    // Drain newly-appended lines from the main transcript AND every discovered sub-agent file. Idempotent
    // via seenUuids, so a final teardown drain that overlaps the loop's own poll is safe.
    const drainTailer = async (): Promise<void> => {
      const mainLines = tailer !== null ? await tailer.poll() : [];
      const subLines: { line: string; parentTaskId: string }[] = [];
      if (subDir !== null) {
        for (const p of await listSubagentFiles(subDir)) {
          if (subTailers.has(p)) continue;
          // Only start tailing once the .meta.json link is readable — so the sub-agent's lines are
          // surfaced NESTED (never flat-flooding). The sidecar lands with the file, so this is immediate.
          const taskId = await readAgentTaskId(p);
          if (taskId === null) continue; // meta not ready yet — retry next drain (no lines lost)
          subTailers.set(p, { tailer: new TranscriptTailer(p), taskId });
          tracer.debug("subagent transcript discovered", { path: p, taskId });
        }
        for (const { tailer: t, taskId } of subTailers.values()) {
          for (const line of await t.poll()) subLines.push({ line, parentTaskId: taskId });
        }
      }
      // Fast path (the common case — no sub-agent output this batch): the main file is a single append-only
      // stream, so its lines are already chronological. Emit directly, with zero timestamp parsing.
      if (subLines.length === 0) {
        for (const line of mainLines) handleLine(line);
        await reconcileCompletedTurns();
        return;
      }
      // Mixed batch — main + sub lines must interleave by their transcript `timestamp`, NOT "all main then
      // all sub". The parent Agent's completion lives in the main file, the sub-agent's work in its own; the
      // viewer renders by sequence (sub frames indent but don't reorder), so emitting the parent answer
      // before the sub lines would show the sub-agent work AFTER the answer instead of nested in the Agent
      // turn. This happens on the backfill/attach drain (a whole history read at once) and a sub-agent that
      // finishes within one poll; steady-state (sub output trickles across polls while the parent blocks)
      // never co-batches a completion with its sub lines, so it stays on the fast path (codex review).
      for (const { line, parentTaskId } of mergeBatchByTimestamp(mainLines, subLines)) {
        handleLine(line, parentTaskId);
      }
      await reconcileCompletedTurns();
    };

    // The cross-project scan in findTranscriptById is an O(project-dirs) sweep; the O(1) direct-path check
    // happens every poll, but we only run the scan on the slow (pane-watch) cadence so a user with many
    // ~/.claude/projects dirs doesn't pay a readdir+stat sweep every pollMs while the first turn is pending.
    const scanEvery = Math.max(1, Math.round((deps.paneWatchMs ?? PANE_WATCH_MS) / pollMs));
    capture = (async () => {
      let warnedNoTranscript = false;
      let goneStreak = 0;
      let tick = 0;
      let discoverTick = 0;
      while (!stop.aborted) {
        // SessionEnd is not process-terminal in Claude: /clear, resume, and compaction can fire it while
        // an in-process transition continues. Its hook therefore closes the gate and leaves this marker.
        // No generic SessionStart sibling proves aggregate readiness afterward, so retire the remote
        // projection instead of guessing; the locally owned tmux pane remains alive and usable.
        if (!session.closed) {
          const ended = await stat(sessionEndedPath).then(
            () => true,
            () => false,
          );
          if (ended) {
            tracer.info("native SessionEnd — retiring tmux remote projection");
            session.close("native Claude session ended or transitioned");
          }
        }
        if (tailer === null) {
          // Prefer the ongoing SessionStart marker (the EXACT transcript_path — no scan or long-cwd-hash
          // problem) when follow is enabled. Else, when we know the tracked id (our PIN, or explicit
          // --resume/--session-id id), wait for THAT EXACT transcript — authoritative, so a concurrent
          // same-cwd sibling can NEVER be mis-attached. Only an unknown id (a --continue/picker session)
          // falls back to the newest-file heuristic. claude creates the file lazily, so null = poll again.
          // When follow is ON but the id is unknown, give the marker a head start before guessing newest.
          // A rotation event should report the exact path shortly, avoiding a concurrent-sibling
          // mis-attach; after the grace we still fall back to local transcript evidence.
          const hookEv = await readSentinelEvent();
          const path =
            hookEv?.transcriptPath ??
            (trackedId !== null
              ? await findTranscriptById(ctx.cwd, trackedId, deps.home, {
                  scanOtherDirs: discoverTick++ % scanEvery === 0,
                })
              : sentinelPath !== null && Date.now() - spawnedAt < HOOK_GRACE_MS
                ? null
                : await findNewestTranscript(dir, spawnedAt, {
                    exclude: preexisting,
                    onAmbiguity: (paths) =>
                      tracer.warn("multiple fresh transcripts — picking newest", {
                        paths: paths.join(", "),
                      }),
                  }));
          if (path !== null) {
            attach(path);
            tracer.debug("transcript discovered", {
              path,
              byHook: hookEv !== null,
              byId: trackedId !== null,
            });
          } else if (!warnedNoTranscript && Date.now() - spawnedAt > discoveryWarnMs) {
            warnedNoTranscript = true;
            tracer.warn("no transcript discovered yet — claude may not have started a turn", {
              dir,
              waitedMs: Date.now() - spawnedAt,
            });
          }
        }
        await drainTailer();
        // Pane-liveness probe on a cadence. Only a CONFIRMED gone (≥N consecutive REAL "session missing"
        // exits — sessionGone ignores a transient "couldn't run tmux", review wf#3) tears down.
        if (++tick % paneCheckEvery === 0) {
          // Hook rotation-follow: the sentinel reporting a NEW transcript_path means the session rotated
          // (/clear, /branch, /compact, resume) — flush the old file, then follow the new one. This is the
          // clean, unambiguous rotation signal the scan/pin path can't safely provide.
          if (sentinelPath !== null && tailer !== null) {
            const ev = await readSentinelEvent();
            if (ev !== null && ev.transcriptPath !== currentPath) {
              await drainTailer();
              tracer.info("session rotated (hook) — following new transcript", {
                from: currentPath,
                to: ev.transcriptPath,
              });
              currentNativeSessionId = ev.sessionId;
              observedPermissionMode = null;
              attach(ev.transcriptPath);
              // A closed compatibility projection must never become a reason to kill the still-local
              // pane. Rotation-follow may continue tailing for liveness, but it cannot mutate or push to
              // a Session that SessionEnd/broker fail-stop/helper ambiguity already retired.
              if (!session.closed) {
                session.clearPermissionMode();
                const rotatedPermissionMode = tmuxRuntimePermissionMode(ev, ctx.harnessArgs, "");
                if (rotatedPermissionMode !== null) {
                  observedPermissionMode = rotatedPermissionMode;
                  session.pushUpstream({ type: "system", permissionMode: rotatedPermissionMode });
                }
              }
            }
          }
          if (await tmux.sessionGone(tmuxName)) {
            goneStreak += 1;
            if (goneStreak >= PANE_GONE_CONFIRMATIONS) {
              await drainTailer(); // FINAL drain BEFORE abort, while the relay still consumes (codex #2)
              tracer.info("tmux pane gone — ending session", { name: tmuxName });
              requestDriverStop("tmux pane gone");
              break;
            }
          } else {
            goneStreak = 0; // present, or a transient probe failure — reset
          }
        }
        await sleep(pollMs);
      }
    })().catch((e) => onPumpCrash("capture", e));

    // INJECT: drain the downstream queue into one tmux-owned critical section per prompt (strict serial;
    // ack only after its atomic outcome says Enter applied). Node loads the private per-session buffer,
    // but the helper owns exclusive gate claim → bracketed paste → bounded settle → Enter under the
    // same kernel-released flock as Claude's synchronous UserPromptSubmit/SessionEnd hooks. Node/helper
    // ambiguity retires only the compatibility projection; it cannot strand a lock or kill the pane.
    const inputBuffer = `${INJECT_BUFFER}-${session.id}`;
    const injectSocketPath = socketPath;
    if (injectSocketPath === null) throw new Error("private tmux socket was not initialized");
    inject = runInjectPump({
      session,
      tmux,
      target: tmuxName,
      buffer: inputBuffer,
      signal: stop,
      sleep,
      injectAtomically: async (text) => {
        try {
          await tmux.setBuffer(inputBuffer, text);
        } catch (error) {
          // The private buffer may or may not have been loaded, but no pane mutation was attempted.
          // Retire only the compatibility projection; never turn a staging failure into a pane kill.
          session.close("tmux input buffer load failed");
          tracer.warn("tmux input buffer load failed", { error: String(error) });
          return false;
        }
        while (!stop.aborted && !session.closed) {
          const outcomePath = join(runtime.path, `input-outcome-${randomUUID()}`);
          const helperCommand = shellQuoteCommand([
            inputHelperPath,
            "remote",
            injectSocketPath,
            tmuxName,
            activeTurnGatePath,
            inputLockPath,
            inputBuffer,
            (settleMs(text) / 1000).toFixed(3),
            outcomePath,
          ]);
          try {
            await tmux.runShell(helperCommand);
          } catch (error) {
            session.close("tmux input helper outcome unknown");
            tracer.warn("tmux input helper failed", { error: String(error) });
            return false;
          }
          const outcome = (await readFile(outcomePath, "utf8").catch(() => "")).trim();
          await rm(outcomePath, { force: true }).catch(() => {});
          if (outcome === "applied") {
            return true;
          }
          if (outcome !== "busy") {
            session.close("tmux input helper outcome unknown");
            tracer.warn("tmux input helper returned no authoritative application outcome", {
              outcome: outcome === "" ? "missing" : outcome,
            });
            return false;
          }
          await sleep(pollMs);
        }
        return false;
      },
      onError: (event, error, info) =>
        tracer.warn("inject failed", { event, error: String(error), ...info }),
      onInjected: recordInjected, // ledger: claude's echo of this prompt is OUR own → suppressed in capture
    }).catch((e) => onPumpCrash("inject", e));

    // All native-side pumps now exist, and the SessionStart marker proved that Claude loaded the exact
    // settings source carrying the required readiness hook. Only now may the readiness latch create a broker
    // client and publish writable capabilities.
    throwIfAborted(stop);
    // Do not derive posture from attached history, even when its timestamps are newer than wrapper
    // spawn: a resumed file may have been written by another same-user process before this attach.
    const readyPermissionMode =
      tmuxRuntimePermissionMode(readyEvent, ctx.harnessArgs, "") ?? observedPermissionMode;
    if (readyPermissionMode !== null) {
      observedPermissionMode = readyPermissionMode;
      session.permissionMode = readyPermissionMode;
    }
    const readyCapabilities = tmuxCapabilities(
      readyPermissionMode === null
        ? "unknown"
        : readyPermissionMode === "bypassPermissions"
          ? "bypassed"
          : "local",
    );
    bridge.start({
      title: ctx.title,
      cwd: ctx.cwd,
      git: ctx.git,
      capabilities: readyCapabilities,
      harness: TMUX_HARNESS,
    });
    registrationReady = true;
    if (publishedCapabilities !== undefined) {
      Object.assign(publishedCapabilities, readyCapabilities);
    }
    throwIfAborted(stop);

    tracer.info("tmux session up", { name: tmuxName, nativeSessionId: readyEvent.sessionId });

    // Run until the signal fires — external abort, a confirmed pane death, or a crashed pump (each
    // synchronously closes the readiness latch before aborting the local pumps).
    await new Promise<void>((resolve) => {
      if (stop.aborted) return resolve();
      stop.addEventListener("abort", () => resolve(), { once: true });
    });
    return pumpCrashed ? 1 : 0;
  } catch (error) {
    if (!registrationReady && stop.aborted) {
      tracer.debug("tmux startup cancelled");
      return 0;
    }
    throw error;
  } finally {
    const teardownDeadline = Date.now() + TEARDOWN_FLUSH_MS;
    const bridgeTeardown = bridge.close(registrationReady ? "driver teardown" : "startup failed");
    // Pumps and registration/relay closure share one deadline so an unresponsive broker cannot add a
    // second timeout window after an unresponsive pane operation.
    await boundedWait(
      Promise.allSettled([capture, inject, bridgeTeardown]),
      Math.max(0, teardownDeadline - Date.now()),
    );
    // Dispose AFTER the capture pump settles (it is the only caller of status.onLine, which re-arms the
    // idle timer) so we don't clear a timer the producer immediately re-arms (review wf#12).
    status?.dispose();
    let cleanupSafe = !spawnAttempted;
    if (spawnAttempted) {
      let killOutcome: Awaited<ReturnType<TmuxCtl["killSession"]>> = "unknown";
      const kill = tmux
        .killSession(tmuxName)
        .then((outcome) => {
          killOutcome = outcome;
        })
        .catch(() => {
          tracer.warn("private tmux pane cleanup could not be confirmed");
        });
      await boundedWait(kill, Math.max(0, teardownDeadline - Date.now()));
      cleanupSafe = killOutcome !== "unknown";
    }
    if (cleanupSafe) {
      for (const path of [socketPath, ...privateFiles]) {
        if (path !== null) await rm(path, { force: true }).catch(() => {});
      }
      if (runtimeOwned && runtimePath !== null) {
        await rm(runtimePath, { force: true, recursive: true }).catch(() => {});
      }
    } else {
      const attachCommand =
        socketPath === null
          ? null
          : shellQuoteCommand(["tmux", "-S", socketPath, "attach", "-t", tmuxName]);
      tracer.warn("private tmux teardown is uncertain; retaining runtime files", {
        runtimePath,
        attach: attachCommand,
      });
      process.stderr.write(
        attachCommand === null
          ? `remote-claw: private tmux teardown is uncertain; retained runtime: ${runtimePath ?? "(unknown)"}\n`
          : `remote-claw: private tmux teardown is uncertain; retained runtime: ${runtimePath ?? "(unknown)"}; recover with: ${attachCommand}\n`,
      );
    }
    tracer.info("tmux driver torn down", { name: tmuxName, pumpCrashed });
  }
}

/** The Driver façade the dispatcher uses: holds the ctx + deps, exposes capabilities + run(signal).
 *  The fixed capability set is published only after native readiness succeeds. */
export function tmuxDriver(ctx: DriverContext, deps: TmuxDriverDeps = {}): Driver {
  const capabilities = tmuxCapabilities(
    tmuxPermissionPosture(ctx.harnessArgs) === "bypassed" ? "bypassed" : "unknown",
  );
  return {
    capabilities,
    run: (signal: AbortSignal) => runTmuxDriver(ctx, signal, deps, capabilities),
  };
}
