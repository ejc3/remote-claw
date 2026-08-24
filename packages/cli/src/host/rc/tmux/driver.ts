// The tmux driver (Track B): drive a PLAIN `claude` in a detached tmux pane and bridge it to the
// broker — provider-agnostic (works on Bedrock/Vertex, where native Remote Control is disabled),
// because there is NO MITM and NO HTTPS_PROXY/NODE_EXTRA_CA_CERTS. claude talks to whatever provider
// it's configured for; we CAPTURE by tailing its local transcript JSONL and INJECT by typing into the
// pane via tmux. Startup uses the shared process-local registration lifecycle: prepare the private
// wrapper, spawn the pane, require both pane liveness and Claude's private SessionStart marker, construct
// every native pump, then publish truthful capabilities and make the broker bridge visible at `ready`.
//
// Because the transcript's `message.content` blocks are byte-identical to the relay's input and the
// relay is a pure function of (Session, BrokerClient), this is a PURE ADDITION: the relay, the broker
// router/backends, and the web viewer are unchanged.
//
// Review findings handled here: #2 dedup (uuid set before pushUpstream), #5 ack (in the inject pump),
// #6 local-prompt visibility (a prompt typed into the LOCAL tmux TUI is surfaced via the local-prompt
// LEDGER — parity with the opencode driver: an upstream `user` text line that doesn't match a prompt WE
// injected is tagged `local_prompt` so the relay renders it), #9 strict inject queue.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import type { NativeConversationCapabilities } from "../../native/adapter.js";
import { type Driver, type DriverContext, TMUX_HARNESS } from "../driver.js";
import {
  type LegacyRcConversationMetadata,
  LegacyRcConversationRegistrar,
} from "../drivers/legacy-registrar.js";
import type { GitInfo } from "../gitinfo.js";
import { RelayCore, type Session } from "../session.js";
import { INJECT_BUFFER, runInjectPump } from "./inject.js";
import {
  decisionFileContent,
  isSafeToolUseId,
  PRE_TOOL_USE_HELPER_SOURCE,
  parsePermRequest,
  preToolUseHookFragment,
} from "./permhook.js";
import {
  extractSettingsArg,
  type HookFragment,
  insertSettingsArg,
  mergeHooksIntoSettings,
  parseSentinel,
  type SessionHookEvent,
  sessionHookFragment,
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
import { ensureCwdTrusted } from "./trust.js";

/** Capabilities. With permission MIRRORING on (default, B2) the driver surfaces structured can_use_tool
 *  gates via the injected PreToolUse hook (so structuredPermissions=true); with it off (the opt-out flag)
 *  it runs `--dangerously-skip-permissions` and auto-approves (false). interrupt works via ESC and
 *  set_model via a `/model <alias>` inject; set_mode/end have no faithful pane analogue so they stay
 *  false (the viewer disables those controls). Transcript timing only gives heuristic status, so the
 *  capability stays false. Attachments arrive as relay-owned `user` injects. */
export function tmuxCapabilities(mirrorPermissions: boolean): Driver["capabilities"] {
  return {
    structuredPermissions: mirrorPermissions,
    status: false,
    controls: { interrupt: true, setModel: true, setMode: false, end: false },
    attachments: true,
  };
}

/** A driver is conservative until its private pane and hooks are proved ready. */
export const TMUX_CAPABILITIES: Driver["capabilities"] = tmuxCapabilities(false);

/** Honest A0 evidence: tmux delivery has no native receipt, transcript capture is partial/post-hoc, and
 * the current wrapper cannot reattach to a live pane after its own process restarts. */
export const TMUX_NATIVE_CAPABILITIES: NativeConversationCapabilities = {
  version: 1,
  mutationAdmission: "post_hoc",
  history: "partial",
  deliveryEvidence: "best_effort",
  liveReattach: false,
};

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

/** Same stale-server defense for CLAUDE_CONFIG_DIR — but here it's also a COHERENCE requirement: claude
 *  reads this var to locate `.claude.json`, and so does our folder-trust writer (trust.ts). If the
 *  wrapper's env sets it, buildChildEnv passes it through (`-e`) so the pane + the writer agree; if it
 *  does NOT, we must unset it for the child so a stale value baked into a PRE-EXISTING tmux server's env
 *  can't make the pane read a DIFFERENT `.claude.json` than the one we seeded trust into (→ a hung pane
 *  on the startup trust gate). The writer is fed the same `parentEnv` value (see the trust call site). */
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
  /** Mirror permissions to the viewer (B2): inject a blocking PreToolUse hook so each tool waits for a
   *  viewer allow/deny — faithful to a real RC session — instead of `--dangerously-skip-permissions`.
   *  DEFAULT ON; the opt-out (`--rc-tmux-skip-permissions`) sets this false to restore auto-approve. */
  mirrorPermissions?: boolean;
  /** Override the permission requests-sentinel / decisions-dir / helper paths (tests). Production derives
   *  all of them inside a private per-launch runtime directory. */
  permReqPath?: string;
  permDecDir?: string;
  permHelperPath?: string;
  /** Override the private per-launch runtime directory (tests only). A caller-supplied directory is
   *  chmodded to 0700 but retained after teardown so the test owner can inspect/remove it. */
  runtimeDir?: string;
  /** Hook fired after the private runtime directory exists (tests/observability). */
  onRuntimeDir?: (path: string) => void;
  /** Pre-accept claude's per-folder trust gate for the cwd before spawn (mirror on only). Injectable so
   *  unit tests don't touch the real ~/.claude.json; production uses the real ensureCwdTrusted. */
  ensureCwdTrusted?: (cwd: string) => { changed: boolean; path: string; bailed?: boolean };
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
 * SessionStart hook from the exact merged settings file that also carries PreToolUse when mirroring. */
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

/**
 * Run the tmux driver until `signal` aborts, claude exits / the pane closes, or a pump crashes:
 *   1. Open a process-local registration in `starting`; no broker client exists yet.
 *   2. Prepare a private runtime directory/socket, hooks, trust, and a scrubbed launch environment.
 *   3. Spawn claude and require both a live pane and its exact private SessionStart marker.
 *   4. Construct capture/injection/permission pumps, then move the lease to `ready`. That transition
 *      alone creates the broker client and announces the conversation.
 *   5. Teardown closes the lease and pane under one deadline; private files are removed only when pane
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

  // An internal controller so a spawn failure (or the pumps ending) tears down cleanly. Closing a
  // starting lease requests drain synchronously, so cancellation cannot race a later ready transition.
  const ac = new AbortController();
  const stop = ac.signal;

  const relays = new Set<Promise<void>>();
  const terminalTasks = new Set<Promise<void>>();
  const registrar = new LegacyRcConversationRegistrar({
    newClient: ctx.newClient,
    identityId: ctx.identity.identityId,
    relays,
    terminalTasks,
    tracer,
  });
  const startingMetadata: LegacyRcConversationMetadata = {
    title: ctx.title,
    cwd: ctx.cwd,
    git: ctx.git as GitInfo | null,
    capabilities: tmuxCapabilities(false),
    harness: TMUX_HARNESS,
  };
  let lease: Awaited<ReturnType<LegacyRcConversationRegistrar["open"]>> | undefined;

  // Closing a starting lease synchronously requests drain inside the registrar, so a queued `ready`
  // transition cannot overtake cancellation, pane death, or a pump crash and publish a ghost.
  const requestDriverStop = (reason: string): void => {
    ac.abort();
    if (lease !== undefined) {
      void lease.close(reason).catch((error: unknown) => {
        tracer.error("tmux starting lease close failed", { error: String(error) });
      });
    }
  };
  const onRegistrationAbort = () => requestDriverStop("parent cancelled");
  if (signal.aborted) onRegistrationAbort();
  else signal.addEventListener("abort", onRegistrationAbort, { once: true });

  try {
    lease = await registrar.open({
      bindingId: null,
      registrationAttemptId: randomUUID(),
      descriptor: { product: "claude-code", access: "tmux" },
      project: null,
      nativeRef: null,
      phase: "starting",
      capabilities: null,
      port: session,
      metadata: startingMetadata,
    });
  } catch (error) {
    signal.removeEventListener("abort", onRegistrationAbort);
    ac.abort();
    session.close();
    throw error;
  }

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
  let permReqPath: string | null = null;
  let permDecDir: string | null = null;
  let permHelperPath: string | null = null;
  let status: StatusTracker | null = null;
  let capture: Promise<void> = Promise.resolve();
  let inject: Promise<void> = Promise.resolve();
  let permPump: Promise<void> = Promise.resolve();
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
    // not prove Claude loaded the settings or the PreToolUse hook. The discovery flag controls whether
    // capture follows this file after readiness, but the one startup proof is always required.
    readinessPath = deps.sentinelPath ?? join(runtime.path, "session-events.ndjson");
    sentinelPath = deps.injectSessionHook ? readinessPath : null;
    // Permission MIRRORING (B2, DEFAULT ON): inject a blocking PreToolUse hook so each tool waits for a
    // viewer allow/deny — faithful to a real RC session — instead of `--dangerously-skip-permissions`. The
    // helper (a tiny Node script) appends each tool request to `permReqPath` (the driver tails it → raises a
    // can_use_tool gate) and blocks polling `permDecDir/<id>.json` (the inject pump writes it on the viewer's
    // answer). Off (the `--rc-tmux-skip-permissions` opt-out) → keep today's auto-approve.
    const mirror = deps.mirrorPermissions ?? true;
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
    if (mirror && hasHarnessOption(ctx.harnessArgs, "--dangerously-skip-permissions")) {
      throw new Error(
        "tmux permission mirroring conflicts with --dangerously-skip-permissions; remove it or explicitly opt out with --rc-tmux-skip-permissions",
      );
    }
    permReqPath = mirror
      ? (deps.permReqPath ?? join(runtime.path, "permission-requests.ndjson"))
      : null;
    permDecDir = mirror ? (deps.permDecDir ?? join(runtime.path, "permission-decisions")) : null;
    permHelperPath = mirror
      ? (deps.permHelperPath ?? join(runtime.path, "permission-hook.mjs"))
      : null;
    await writePrivateFile(readinessPath, "");
    privateFiles.add(readinessPath);
    if (mirror && permReqPath !== null && permDecDir !== null && permHelperPath !== null) {
      await writePrivateFile(permReqPath, "");
      privateFiles.add(permReqPath);
      await mkdir(permDecDir, { recursive: false, mode: 0o700 });
      await chmod(permDecDir, 0o700);
      await writePrivateFile(permHelperPath, PRE_TOOL_USE_HELPER_SOURCE);
      privateFiles.add(permHelperPath);
    }
    throwIfAborted(stop);

    // Build the combined settings file (SessionStart + PreToolUse), deep-merged with the user's. The
    // merged JSON is never placed in tmux argv or the public error surface.
    const fragments: HookFragment[] = [sessionHookFragment(readinessPath)];
    if (mirror && permReqPath !== null && permDecDir !== null && permHelperPath !== null) {
      // Pass this process's absolute node binary so the helper works even when the pane shell has no
      // `node` on PATH. Local tmux means both processes share the same filesystem.
      fragments.push(
        preToolUseHookFragment(permHelperPath, permReqPath, permDecDir, 100, process.execPath),
      );
    }
    const { value, rest } = extractSettingsArg(ctx.harnessArgs);
    const merged = await mergeHooksIntoSettings(value, fragments);
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
      permMirror: mirror,
      mergedUserSettings: value !== null,
    });

    // Without skip-permissions, Claude's startup trust dialog can block before the hook exists. Trust
    // preparation is therefore a required readiness prerequisite when mirroring is on.
    if (mirror) {
      const trust =
        deps.ensureCwdTrusted ??
        ((cwd: string) =>
          ensureCwdTrusted(cwd, {
            ...(deps.home !== undefined ? { home: deps.home } : {}),
            configDir: parentEnv.CLAUDE_CONFIG_DIR ?? "",
          }));
      let t: ReturnType<typeof trust>;
      try {
        t = trust(ctx.cwd);
      } catch {
        throw new Error(
          "could not prepare Claude folder trust required for tmux permission mirroring; trust the folder locally or explicitly opt out with --rc-tmux-skip-permissions",
        );
      }
      if (t.bailed) {
        throw new Error(
          "could not safely update Claude folder trust required for tmux permission mirroring; repair or trust the folder locally, or explicitly opt out with --rc-tmux-skip-permissions",
        );
      }
      if (t.changed) {
        tracer.info("pre-accepted folder trust for cwd (mirror on)", { path: t.path });
      }
      throwIfAborted(stop);
    }

    const command = shellQuoteCommand([
      "env",
      ...envUnset,
      bin,
      ...(mirror ? [] : ["--dangerously-skip-permissions"]),
      ...(sessionUuid !== null ? ["--session-id", sessionUuid] : []),
      ...harnessArgs,
    ]);
    await writePrivateFile(launcherPath, `#!/bin/sh\nexec ${command}\n`, 0o700);
    privateFiles.add(launcherPath);

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
        "Claude did not execute the required SessionStart readiness hook; hooks may be disabled by safe mode, settings, or policy",
      );
    }
    tracer.debug("Claude native readiness proved", {
      sessionId: readyEvent.sessionId,
      transcriptPath: readyEvent.transcriptPath,
    });

    // On each real turn end (a top-level assistant line with a terminal stop_reason), emit a synthetic
    // `result` frame. Interactive claude never sends one, so without it the viewer shows no turn separator
    // between tmux turns (the mitm driver, on real RC, does). The relay maps `result` → a turn-sep marker;
    // an empty `result` is exactly that. handleLine pushes the assistant frame BEFORE calling status.onLine,
    // so this synthetic result lands immediately after the answer it closes.
    const runStatus = new StatusTracker({
      session,
      onTurnEnd: () => session.pushUpstream({ type: "result", subtype: "success", result: "" }),
    });
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
      // Push the frame BEFORE status.onLine so that when onLine sees a terminal assistant line and fires
      // onTurnEnd (→ a synthetic `result`), the result is queued AFTER the assistant answer it closes.
      if (!suppressFrame) session.pushUpstream(payload);
      runStatus.onLine(payload); // ALWAYS: a top-level user text turn is a turn boundary even when suppressed
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
              attach(ev.transcriptPath);
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

    // Track which OPEN gates are AskUserQuestion (by tool_use_id), so onDecision only carries the answer
    // `updatedInput` for THOSE — never letting a crafted `answers` payload on, say, a Bash gate replace that
    // tool's real input (#42 / #147 codex). Populated by the perm pump when it raises a gate; consumed and
    // DELETED by onDecision when the gate closes, so the set tracks only currently-open gates (bounded) —
    // not every AskUserQuestion the session ever saw (codex #147: was append-only → unbounded growth).
    const askqGateIds = new Set<string>();

    // INJECT: drain the downstream queue into the pane (strict serial; ack after success — review #5/#9).
    // Per-session paste buffer so concurrent drivers can't cross-wire (codex review #5); failed injects
    // retry step-aware until they land or abort (codex review #4 / wf#1).
    const decisionDir = mirror ? permDecDir : null;
    inject = runInjectPump({
      session,
      tmux,
      target: tmuxName,
      buffer: `${INJECT_BUFFER}-${session.id}`,
      signal: stop,
      sleep,
      onError: (event, error, info) =>
        tracer.warn("inject failed", { event, error: String(error), ...info }),
      onInjected: recordInjected, // ledger: claude's echo of this prompt is OUR own → suppressed in capture
      // Permission mirroring (B2): the viewer's allow/deny → write the decision file the blocked PreToolUse
      // hook is polling (keyed by request_id == the can_use_tool gate id == tool_use_id). Only wired when
      // mirroring is on; off, control_responses are just acked.
      ...(decisionDir !== null
        ? {
            onDecision: async (
              requestId: string,
              behavior: "allow" | "deny",
              updatedInput?: unknown,
            ) => {
              // Defense-in-depth: never let a crafted id escape the decisions dir (the relay only forwards
              // ids it already gated, but the path join is user-influenced data).
              if (!isSafeToolUseId(requestId)) {
                throw new Error("permission decision rejected: unsafe request id");
              }
              try {
                // ATOMIC write: the blocked helper polls this path with existsSync→readFileSync, so a plain
                // writeFile would briefly expose a 0-byte/partial file. Write a temp sibling then rename
                // (atomic on the same fs) so the helper only ever observes a COMPLETE decision. `updatedInput`
                // (AskUserQuestion answers, #42) rides into the file on an allow so the helper re-emits it.
                const finalPath = join(decisionDir, `${requestId}.json`);
                const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
                // Only carry answer `updatedInput` for an AskUserQuestion gate (the helper also enforces this);
                // for any other tool, drop it so a stray/crafted `answers` can't clobber the tool's input.
                const answerInput = askqGateIds.has(requestId) ? updatedInput : undefined;
                try {
                  await writePrivateFile(
                    tmpPath,
                    decisionFileContent(behavior, undefined, answerInput),
                  );
                  await rename(tmpPath, finalPath);
                } catch (error) {
                  await rm(tmpPath, { force: true }).catch(() => {});
                  throw error;
                }
                tracer.debug("permission decision written", {
                  requestId,
                  behavior,
                  answers: answerInput !== undefined,
                });
                // The gate is closed only after the durable decision file lands. Keep the classification
                // across a failed write so a retried AskUserQuestion answer does not lose updatedInput.
                askqGateIds.delete(requestId);
              } catch (e) {
                tracer.warn("permission decision write failed", { requestId, error: String(e) });
                throw new Error("permission decision persistence failed");
              }
            },
          }
        : {}),
    }).catch((e) => onPumpCrash("inject", e));

    // PERMISSION REQUESTS pump (B2): tail the requests sentinel the PreToolUse hook appends to; each new tool
    // request → raise a canonical can_use_tool gate (pushUpstream) so the relay + viewer render the card. The
    // blocked hook stays parked until the inject pump's onDecision writes the matching decision file. Tracks
    // toolUseIds so a re-read never double-raises a gate. Only runs when mirroring is on.
    //
    // Reuse TranscriptTailer: it reads only NEW bytes (no O(n²) full re-read each poll), HOLDS BACK a torn
    // final line until its newline lands (so parsePermRequest only ever sees complete lines), and returns []
    // when the sentinel doesn't exist yet (no tool has run). A pushUpstream throw is a real bug — let it
    // propagate to onPumpCrash (which tears down) rather than be swallowed, which would mark the id `seen` and
    // strand the blocked helper forever; for that reason we add to `seen` only AFTER the push succeeds.
    permPump =
      mirror && permReqPath !== null
        ? (async () => {
            const reqTailer = new TranscriptTailer(permReqPath);
            const seen = new Set<string>();
            while (!stop.aborted) {
              for (const line of await reqTailer.poll()) {
                const req = parsePermRequest(line);
                if (req === null || seen.has(req.toolUseId)) continue;
                if (!isSafeToolUseId(req.toolUseId)) {
                  tracer.warn("permission gate skipped — unsafe tool_use_id", {
                    toolUseId: req.toolUseId,
                  });
                  continue;
                }
                tracer.debug("permission gate raised", {
                  toolUseId: req.toolUseId,
                  tool: req.toolName,
                });
                session.pushUpstream({
                  type: "control_request",
                  uuid: `perm-${req.toolUseId}`,
                  request_id: req.toolUseId,
                  request: {
                    subtype: "can_use_tool",
                    tool_name: req.toolName,
                    tool_input: req.toolInput,
                    tool_use_id: req.toolUseId,
                  },
                });
                // Remember AskUserQuestion gates so onDecision carries the answer updatedInput for them only.
                if (req.toolName === "AskUserQuestion") askqGateIds.add(req.toolUseId);
                seen.add(req.toolUseId); // only after a SUCCESSFUL push (a throw above propagates, not strands)
              }
              await sleep(pollMs);
            }
          })().catch((e) => onPumpCrash("perm", e))
        : Promise.resolve();

    // All native-side pumps now exist, and the SessionStart marker proved that Claude loaded the exact
    // settings source carrying the required hooks. Only now may the process-local registrar create a
    // broker client and publish writable capabilities.
    throwIfAborted(stop);
    const readyCapabilities = tmuxCapabilities(mirror);
    await lease.update(
      { ...startingMetadata, capabilities: readyCapabilities },
      TMUX_NATIVE_CAPABILITIES,
    );
    throwIfAborted(stop);
    await lease.setPhase("ready");
    registrationReady = true;
    if (publishedCapabilities !== undefined) {
      Object.assign(publishedCapabilities, readyCapabilities);
    }
    throwIfAborted(stop);

    tracer.info("tmux session up", { name: tmuxName, nativeSessionId: readyEvent.sessionId });
    process.stderr.write(
      `remote-claw: claude running in tmux — attach with: ${shellQuoteCommand([
        "tmux",
        "-S",
        socketPath,
        "attach",
        "-t",
        tmuxName,
      ])}\n`,
    );

    // Run until the signal fires — external abort, a confirmed pane death, or a crashed pump (each
    // synchronously closes the lease before aborting the local pumps).
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
    ac.abort();
    signal.removeEventListener("abort", onRegistrationAbort);
    session.close();
    // Pumps and registration/relay closure share one deadline so an unresponsive broker cannot add a
    // second timeout window after an unresponsive pane operation.
    await boundedWait(
      Promise.allSettled([
        capture,
        inject,
        permPump,
        lease?.close(registrationReady ? "driver teardown" : "startup failed") ?? Promise.resolve(),
      ]),
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
      if (permDecDir !== null) {
        await rm(permDecDir, { force: true, recursive: true }).catch(() => {});
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
 *  It starts conservative and is mutated to the proved post-setup capabilities only after readiness. */
export function tmuxDriver(ctx: DriverContext, deps: TmuxDriverDeps = {}): Driver {
  const capabilities = tmuxCapabilities(false);
  return {
    capabilities,
    run: (signal: AbortSignal) => runTmuxDriver(ctx, signal, deps, capabilities),
  };
}
