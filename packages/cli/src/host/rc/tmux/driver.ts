// The tmux driver (Track B): drive a PLAIN `claude` in a detached tmux pane and bridge it to the
// broker — provider-agnostic (works on Bedrock/Vertex, where native Remote Control is disabled),
// because there is NO MITM and NO HTTPS_PROXY/NODE_EXTRA_CA_CERTS. claude talks to whatever provider
// it's configured for; we CAPTURE by tailing its local transcript JSONL and INJECT by typing into the
// pane via tmux. The lifecycle mirrors `launch.ts`'s onSession path exactly, minus the MITM.
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
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import type { Driver, DriverContext } from "../driver.js";
import { bridgeSession } from "../drivers/bridge.js";
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
import { realTmuxExec, TmuxCtl, type TmuxExec } from "./tmuxctl.js";
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
 *  it runs `--dangerously-skip-permissions` and auto-approves (false). set_model is honored via a `/model`
 *  inject and interrupt via ESC, but set_mode/end have no faithful pane analogue, so controlVerbs stays
 *  false (the coarse flag can't say "some"). status comes from the transcript debounce; attachments arrive
 *  as relay-owned `user` injects. */
export function tmuxCapabilities(mirrorPermissions: boolean): Driver["capabilities"] {
  return {
    structuredPermissions: mirrorPermissions,
    status: true,
    controlVerbs: false,
    attachments: true,
  };
}

/** Default capabilities (mirroring on) — kept as a named export for callers/tests that want the default. */
export const TMUX_CAPABILITIES: Driver["capabilities"] = tmuxCapabilities(true);

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
 *  (proxy/CA env passes through — see SCRUB_ENV). Returns a flat string map for tmux `-e KEY=VALUE`. */
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

/** Detect whether the user's harness args already drive the session, and extract an explicit id if they
 *  gave one. Recognizes the long forms `--session-id` / `--resume` / `--continue` (incl. `--flag=value`)
 *  and the short `-r` / `-c`; an id is the `=value` or the next non-`-` token for `--session-id`/`--resume`
 *  /`-r`. Stops at a `--` separator (anything after is a literal, not an option) so `-r` as a flag VALUE
 *  past `--` doesn't false-trigger. When the user owns the session we don't pin; when they gave an explicit
 *  id we TRACK that transcript by id (a `--resume <id>` appends to `<id>.jsonl`); a picker (`--continue` /
 *  bare `--resume`) leaves the id unknown. Pure, exported for unit tests. */
export function parseUserSession(args: readonly string[]): {
  ownsSession: boolean;
  explicitId: string | null;
} {
  const sep = args.indexOf("--");
  const opts = sep === -1 ? args : args.slice(0, sep);
  let ownsSession = false;
  let explicitId: string | null = null;
  const takeNext = (i: number): void => {
    const v = opts[i + 1];
    if (v !== undefined && !v.startsWith("-")) explicitId = v;
  };
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i] ?? "";
    const long = a.match(/^--(session-id|resume|continue)(?:=(.*))?$/);
    if (long) {
      ownsSession = true;
      if (long[1] !== "continue") {
        if (long[2] !== undefined && long[2] !== "") explicitId = long[2];
        else takeNext(i);
      }
    } else if (a === "-r") {
      ownsSession = true;
      takeNext(i);
    } else if (a === "-c") {
      ownsSession = true;
    }
  }
  return { ownsSession, explicitId };
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
  /** Override the pinned session id (tests) — makes the spawned `<uuid>.jsonl` filename deterministic
   *  without parsing the tmux command. Production mints a fresh v4 UUID. */
  sessionId?: string;
  /** Inject a Claude Code SessionStart hook (merged with the user's --settings) so the spawned claude
   *  reports its exact transcript_path/session_id to a sentinel file — exact discovery + rotation-follow,
   *  no scan (`--rc-session-hook`). */
  injectSessionHook?: boolean;
  /** Override the hook sentinel file path (tests). Production derives one under tmpdir per session. */
  sentinelPath?: string;
  /** Mirror permissions to the viewer (B2): inject a blocking PreToolUse hook so each tool waits for a
   *  viewer allow/deny — faithful to a real RC session — instead of `--dangerously-skip-permissions`.
   *  DEFAULT ON; the opt-out (`--rc-tmux-skip-permissions`) sets this false to restore auto-approve. */
  mirrorPermissions?: boolean;
  /** Override the permission requests-sentinel / decisions-dir / helper paths (tests). Production derives
   *  per-session paths under tmpdir. */
  permReqPath?: string;
  permDecDir?: string;
  permHelperPath?: string;
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
/** With the SessionStart hook ON but the session id UNKNOWN (a `--continue`/picker run, no pin), how long
 *  to let the hook sentinel report the EXACT transcript before falling back to the newest-file guess — so
 *  a concurrent same-cwd sibling isn't mis-attached in the window before the hook fires. After this we
 *  still fall back (covers `--bare`, where the hook can't fire at all). */
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

/**
 * Run the tmux driver until `signal` aborts, claude exits / the pane closes, or a pump crashes. Mirrors
 * `runRcLaunch`'s lifecycle:
 *   1. RelayCore.create({ title }) → pushInitialize() (initialize is the first downstream event).
 *   2. bridgeSession(...) — the SHARED broker wiring (announce-now-then-serve; tracked for flush).
 *   3. spawn `claude --dangerously-skip-permissions <harnessArgs>` in a detached tmux pane (NO proxy).
 *   4. run CAPTURE (tail transcript → pushUpstream, dedup by uuid; also probes pane liveness and does a
 *      final drain on pane death) and INJECT (followDownstream → pane, ack after success) concurrently.
 *   5. teardown: abort, session.close(), bounded-wait the pumps + relay flush, dispose status, kill-session.
 * Exit code: 1 if a pump crashed, else 0 (a clean pane death / external abort). The run.ts dispatch maps
 * SIGINT/SIGTERM to 128+N. NOTE: unlike a bare detached pane, claude exiting now ENDS the wrapper (the
 * capture loop's liveness probe aborts), so the driver's lifetime is `signal` OR the pane's life.
 */
export async function runTmuxDriver(
  ctx: DriverContext,
  signal: AbortSignal,
  deps: TmuxDriverDeps = {},
): Promise<number> {
  const tracer: Tracer = (ctx.tracer ?? NOOP_TRACER).child({ driver: "tmux" });
  const tmux = new TmuxCtl(deps.tmuxExec ?? realTmuxExec);
  const sleep = deps.sleep ?? sleepReal;
  const pollMs = deps.pollMs ?? 120;
  const parentEnv = deps.parentEnv ?? process.env;

  // Verify tmux is present BEFORE we mint a session — a clear error beats a half-bridged launch.
  try {
    const ver = await tmux.version();
    tracer.debug("tmux present", { version: ver });
  } catch (e) {
    throw new Error(
      `tmux not found — install it (e.g. sudo apt-get install -y tmux): ${(e as Error)?.message ?? e}`,
    );
  }

  const core = new RelayCore();
  const session: Session = core.create({ title: ctx.title });
  session.pushInitialize(); // guarantees `initialize` is the first downstream event
  ctx.onSession?.(session);

  // An internal controller so a spawn failure (or the pumps ending) tears down cleanly, coupled to the
  // external signal. We never re-export `ac`; `stop` is what every pump watches.
  const ac = new AbortController();
  const stop = ac.signal;
  const onExternalAbort = () => ac.abort();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", onExternalAbort, { once: true });

  const relays = new Set<Promise<void>>();
  const served = bridgeSession({
    session,
    newClient: ctx.newClient,
    identityId: ctx.identity.identityId,
    title: ctx.title,
    cwd: ctx.cwd,
    git: ctx.git,
    signal: stop,
    relays,
    tracer,
  });

  // The tmux session name carries the broker session id (cse_<hex>) so the user can attach the pane.
  const tmuxName = `rc-${session.id}`;
  const bin = ctx.harnessBin ?? "claude";
  // Belt-and-suspenders env scrub (codex review #1/#4): `new-session -e` only SETS vars, so a stale
  // value living in a PRE-EXISTING tmux server's environment would still leak into the pane. Prepend
  // `env -u <var>…` so:
  //   • the stub-gotcha ids + host secrets are ALWAYS unset (regardless of the tmux server env), and
  //   • a proxy/CA var is unset ONLY when the wrapper's OWN env doesn't set it — so the user's legit
  //     proxy (in the `-e` map) passes through, but a stale tmux-server proxy can't leak in.
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
  // `=value` forms), we do NOT pin. We still TRACK by id when they gave an explicit one — `--resume <id>`
  // APPENDS to `<id>.jsonl` (verified; -p), which `findNewestTranscript` would miss as "not fresh", so we
  // locate it by id. Only a picker (`--continue` / bare `--resume`) leaves the id unknown → newest-file
  // heuristic. NOTE: an in-session `/clear` or `/branch` ROTATES to a NEW uuid file (verified) —
  // following that rotation is a separate follow-up; this governs the FIRST attach (the common case).
  const userSession = parseUserSession(ctx.harnessArgs);
  const sessionUuid = userSession.ownsSession ? null : (deps.sessionId ?? randomUUID());
  // The id whose transcript we TRACK: our pin, else the user's explicit resume/session id, else null
  // (unknown — picker/continue → newest-file heuristic).
  const trackedId = sessionUuid ?? userSession.explicitId;
  // SessionStart-hook capture (--rc-session-hook): inject a hook (MERGED with any user --settings) that
  // writes the EXACT transcript_path/session_id to a per-session sentinel on start + every rotation. When
  // on, discovery reads the sentinel (exact, no scan) and follows rotations; the pin/id lookup is the
  // fallback if the hook never fires (e.g. --bare disables hooks).
  let sentinelPath = deps.injectSessionHook
    ? (deps.sentinelPath ?? join(tmpdir(), `rc-sessionhook-${session.id}.ndjson`))
    : null;
  // Permission MIRRORING (B2, DEFAULT ON): inject a blocking PreToolUse hook so each tool waits for a
  // viewer allow/deny — faithful to a real RC session — instead of `--dangerously-skip-permissions`. The
  // helper (a tiny Node script) appends each tool request to `permReqPath` (the driver tails it → raises a
  // can_use_tool gate) and blocks polling `permDecDir/<id>.json` (the inject pump writes it on the viewer's
  // answer). Off (the `--rc-tmux-skip-permissions` opt-out) → keep today's auto-approve.
  let mirror = deps.mirrorPermissions ?? true;
  let permReqPath = mirror
    ? (deps.permReqPath ?? join(tmpdir(), `rc-permreq-${session.id}.ndjson`))
    : null;
  const permDecDir = mirror
    ? (deps.permDecDir ?? join(tmpdir(), `rc-permdec-${session.id}`))
    : null;
  const permHelperPath = mirror
    ? (deps.permHelperPath ?? join(tmpdir(), `rc-permhook-${session.id}.mjs`))
    : null;
  if (mirror && permReqPath !== null && permDecDir !== null && permHelperPath !== null) {
    await mkdir(permDecDir, { recursive: true });
    await writeFile(permHelperPath, PRE_TOOL_USE_HELPER_SOURCE, "utf8");
  }

  // Build the combined `--settings` (SessionStart hook + PreToolUse hook), deep-merged with the user's.
  const fragments: HookFragment[] = [];
  if (sentinelPath !== null) fragments.push(sessionHookFragment(sentinelPath));
  if (mirror && permReqPath !== null && permDecDir !== null && permHelperPath !== null) {
    // Pass this process's ABSOLUTE node binary (not a bare `node`) so the PreToolUse hook spawns even when
    // the pane shell has no `node` on PATH (a standalone/native claude install) — else the gate is silently
    // bypassed. Local tmux ⇒ same machine/fs, so process.execPath is a valid interpreter for the pane.
    fragments.push(
      preToolUseHookFragment(permHelperPath, permReqPath, permDecDir, 100, process.execPath),
    );
  }
  let harnessArgs: readonly string[] = ctx.harnessArgs;
  if (fragments.length > 0) {
    const { value, rest } = extractSettingsArg(ctx.harnessArgs);
    const merged = await mergeHooksIntoSettings(value, fragments);
    if (merged === null) {
      // The user passed a --settings we can't parse/merge — pass their args through UNCHANGED and skip our
      // hooks, so claude behaves natively (incl. its own error on a bad settings file) rather than us
      // silently masking it. Without the PreToolUse hook we CAN'T mirror, so fall back to the safe
      // auto-approve (`--dangerously-skip-permissions`) — never leave claude prompting locally with no
      // remote answer (a hung pane).
      tracer.warn(
        "hooks disabled — user --settings not parseable; args passed through, mirroring off",
      );
      sentinelPath = null;
      mirror = false;
      permReqPath = null;
    } else {
      // Insert BEFORE any `--` so claude parses our --settings as an OPTION; after `--` it's a literal —
      // the hook wouldn't register and the JSON would leak into the prompt.
      harnessArgs = insertSettingsArg(rest, merged);
      tracer.debug("hooks injected", {
        sessionHook: sentinelPath !== null,
        permMirror: mirror,
        mergedUserSettings: value !== null,
      });
    }
  }
  // CAVEAT (mirror on): dropping `--dangerously-skip-permissions` (below) also drops its folder-TRUST
  // bypass, so a FRESH/untrusted cwd would block at claude's startup "Do you trust the files in this
  // folder?" gate in the detached pane — the PreToolUse hook does NOT cover it (a startup gate, not a
  // tool) and no one is at the pane to answer → a hung pane. So pre-accept the trust bit for the cwd
  // (exactly what claude records on "trust"), idempotently. Best-effort: a write failure just warns and
  // a fresh cwd may still hang (the user can trust interactively or use `--rc-tmux-skip-permissions`).
  //
  // BUT: if the user FORWARDED `--dangerously-skip-permissions` themselves (it lands in harnessArgs, which
  // we don't strip), the child bypasses the trust gate regardless — there's no gate to seed, so don't
  // write the user's real config when we don't have to (keep the write surgical: only when it's needed).
  const childSkipsTrustGate = harnessArgs.includes("--dangerously-skip-permissions");
  if (mirror && !childSkipsTrustGate) {
    // Resolve the SAME `.claude.json` the pane's claude will read: pass the child's effective
    // CLAUDE_CONFIG_DIR (parentEnv's value — passed through via `-e`, or unset for the child via `env -u`,
    // see envUnset above). An empty string means "unset" → the writer falls back to home, exactly as the
    // pane will. Thread deps.home so unit tests (home → a temp dir) never touch the real ~/.claude.json.
    const trust =
      deps.ensureCwdTrusted ??
      ((cwd: string) =>
        ensureCwdTrusted(cwd, {
          ...(deps.home !== undefined ? { home: deps.home } : {}),
          configDir: parentEnv.CLAUDE_CONFIG_DIR ?? "",
        }));
    try {
      const t = trust(ctx.cwd);
      if (t.changed) {
        tracer.info("pre-accepted folder trust for cwd (mirror on)", { path: t.path });
      } else if (t.bailed) {
        tracer.warn(
          "could not pre-accept folder trust (existing config unreadable or malformed) — a fresh cwd may hang on claude's trust gate",
          { path: t.path },
        );
      }
    } catch (e) {
      tracer.warn(
        "could not pre-accept folder trust — a fresh cwd may hang on claude's trust gate",
        {
          error: String(e),
        },
      );
    }
  }
  const command = shellQuoteCommand([
    "env",
    ...envUnset,
    bin,
    // With mirroring ON the PreToolUse hook is the sole tool gate (the viewer decides), so we must NOT skip
    // permissions (and we pre-accepted folder trust above); with it OFF we keep today's hands-off
    // auto-approve (`--dangerously-skip-permissions`, which also bypasses the trust gate).
    ...(mirror ? [] : ["--dangerously-skip-permissions"]),
    ...(sessionUuid !== null ? ["--session-id", sessionUuid] : []),
    ...harnessArgs,
  ]);
  // Snapshot pre-existing transcript inodes BEFORE spawn so capture can never attach to a concurrent
  // pre-existing session's file (codex review #2). Taken before newSession so claude's fresh file is
  // guaranteed absent from the set.
  const dir = projectDir(ctx.cwd, deps.home);
  const preexisting = await snapshotTranscriptInodes(dir);
  const spawnedAt = Date.now();
  try {
    await tmux.newSession(tmuxName, command, {
      cwd: ctx.cwd,
      env: buildChildEnv(parentEnv),
      width: 200,
      height: 50,
    });
  } catch (e) {
    ac.abort();
    signal.removeEventListener("abort", onExternalAbort);
    session.close();
    // Bounded (review wf#8): a slow/unreachable broker must not hang this actionable spawn error — the
    // announce/prepare round-trips don't observe the abort promptly.
    await boundedWait(
      served.catch(() => {}),
      TEARDOWN_FLUSH_MS,
    );
    throw new Error(`could not start tmux session: ${(e as Error)?.message ?? e}`);
  }
  tracer.info("tmux session up", { name: tmuxName });
  process.stderr.write(
    `remote-claw: claude running in tmux — attach with: tmux attach -t ${tmuxName}\n`,
  );

  // On each real turn end (a top-level assistant line with a terminal stop_reason), emit a synthetic
  // `result` frame. Interactive claude never sends one, so without it the viewer shows no turn separator
  // between tmux turns (the mitm driver, on real RC, does). The relay maps `result` → a turn-sep marker;
  // an empty `result` is exactly that. handleLine pushes the assistant frame BEFORE calling status.onLine,
  // so this synthetic result lands immediately after the answer it closes.
  const status = new StatusTracker({
    session,
    onTurnEnd: () => session.pushUpstream({ type: "result", subtype: "success", result: "" }),
  });

  // A pump that crashes is a BUG, not a clean exit — record it so we return non-zero (codex review #3).
  let pumpCrashed = false;
  const onPumpCrash = (where: string, e: unknown): void => {
    pumpCrashed = true;
    tracer.error(`${where} pump crashed`, { error: String(e) });
    ac.abort(); // a dead pump means we can no longer bridge — tear the whole thing down
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

  // The latest SessionStart-hook event from the sentinel (exact transcript_path/session_id), or null when
  // the hook is off / hasn't fired yet. Reading a small NDJSON file is cheap; tolerant of a torn append.
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
    status.onLine(payload); // ALWAYS: a top-level user text turn is a turn boundary even when suppressed
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
  const capture = (async () => {
    let warnedNoTranscript = false;
    let goneStreak = 0;
    let tick = 0;
    let discoverTick = 0;
    while (!stop.aborted) {
      if (tailer === null) {
        // Prefer the SessionStart-hook sentinel (the EXACT transcript_path — no scan, no long-cwd-hash
        // problem) when enabled. Else, when we know the tracked id (our PIN, or the user's explicit
        // --resume/--session-id id), wait for THAT EXACT transcript — authoritative, so a concurrent
        // same-cwd sibling can NEVER be mis-attached. Only an unknown id (a --continue/picker session)
        // falls back to the newest-file heuristic. claude creates the file lazily, so null = poll again.
        // When the hook is ON but the id is unknown, give the sentinel a HEAD START (HOOK_GRACE_MS) before
        // guessing newest — the hook will report the exact path shortly, so we avoid mis-attaching a
        // concurrent sibling in that window; after the grace we still fall back (e.g. --bare = no hook).
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
            ac.abort();
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
  const inject = runInjectPump({
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
    ...(mirror && permDecDir !== null
      ? {
          onDecision: async (
            requestId: string,
            behavior: "allow" | "deny",
            updatedInput?: unknown,
          ) => {
            // Defense-in-depth: never let a crafted id escape the decisions dir (the relay only forwards
            // ids it already gated, but the path join is user-influenced data).
            if (!isSafeToolUseId(requestId)) {
              tracer.warn("permission decision skipped — unsafe request_id", { requestId });
              return;
            }
            try {
              // ATOMIC write: the blocked helper polls this path with existsSync→readFileSync, so a plain
              // writeFile would briefly expose a 0-byte/partial file. Write a temp sibling then rename
              // (atomic on the same fs) so the helper only ever observes a COMPLETE decision. `updatedInput`
              // (AskUserQuestion answers, #42) rides into the file on an allow so the helper re-emits it.
              const finalPath = join(permDecDir, `${requestId}.json`);
              const tmpPath = `${finalPath}.tmp`;
              // Only carry answer `updatedInput` for an AskUserQuestion gate (the helper also enforces this);
              // for any other tool, drop it so a stray/crafted `answers` can't clobber the tool's input.
              const answerInput = askqGateIds.has(requestId) ? updatedInput : undefined;
              await writeFile(tmpPath, decisionFileContent(behavior, undefined, answerInput));
              await rename(tmpPath, finalPath);
              tracer.debug("permission decision written", {
                requestId,
                behavior,
                answers: answerInput !== undefined,
              });
            } catch (e) {
              tracer.warn("permission decision write failed", { requestId, error: String(e) });
            } finally {
              // The gate is closed once a decision lands (allow or deny), so drop its AskUserQuestion
              // classification — keeps the set to currently-open gates, not an ever-growing history.
              askqGateIds.delete(requestId);
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
  const permPump: Promise<void> =
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

  try {
    // Run until the signal fires — external abort, a confirmed pane death, or a crashed pump (each
    // routes through `ac.abort()` above).
    await new Promise<void>((resolve) => {
      if (stop.aborted) return resolve();
      stop.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    ac.abort();
    signal.removeEventListener("abort", onExternalAbort);
    session.close();
    // Bounded so a hung tmux exec (in a pump) or a hung serve() can't block kill-session (codex #3/#7).
    await boundedWait(Promise.allSettled([capture, inject, permPump]), TEARDOWN_FLUSH_MS);
    await boundedWait(
      served.catch(() => {}),
      TEARDOWN_FLUSH_MS,
    );
    // Dispose AFTER the capture pump settles (it is the only caller of status.onLine, which re-arms the
    // idle timer) so we don't clear a timer the producer immediately re-arms (review wf#12).
    status.dispose();
    await tmux.killSession(tmuxName);
    if (sentinelPath !== null) await rm(sentinelPath, { force: true }).catch(() => {});
    // Clean up the permission-mirroring scratch (helper script, requests sentinel, decisions dir).
    if (permHelperPath !== null) await rm(permHelperPath, { force: true }).catch(() => {});
    if (permReqPath !== null) await rm(permReqPath, { force: true }).catch(() => {});
    if (permDecDir !== null) await rm(permDecDir, { force: true, recursive: true }).catch(() => {});
    tracer.info("tmux driver torn down", { name: tmuxName, pumpCrashed });
  }
  return pumpCrashed ? 1 : 0;
}

/** The Driver façade the dispatcher uses: holds the ctx + deps, exposes capabilities + run(signal).
 *  Capabilities reflect whether permission mirroring is on (default on → structuredPermissions). */
export function tmuxDriver(ctx: DriverContext, deps: TmuxDriverDeps = {}): Driver {
  return {
    capabilities: tmuxCapabilities(deps.mirrorPermissions ?? true),
    run: (signal: AbortSignal) => runTmuxDriver(ctx, signal, deps),
  };
}
