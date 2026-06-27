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
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import type { Driver, DriverContext } from "../driver.js";
import { bridgeSession } from "../drivers/bridge.js";
import { RelayCore, type Session } from "../session.js";
import { INJECT_BUFFER, runInjectPump } from "./inject.js";
import {
  extractSettingsArg,
  insertSettingsArg,
  mergeSessionHookSettings,
  parseSentinel,
  type SessionHookEvent,
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

/** v1 capabilities: auto-approve permissions (no structured can_use_tool), real status from the
 *  transcript debounce, no faithful control-verb analogue beyond interrupt (best-effort), and `user`
 *  injection (so relay-owned attachments work — the driver never sees an attachment frame). */
export const TMUX_CAPABILITIES: Driver["capabilities"] = {
  structuredPermissions: false,
  status: true,
  controlVerbs: false,
  attachments: true,
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
    ...PROXY_CA_VARS.filter((k) => parentEnv[k] === undefined).flatMap((k) => ["-u", k]),
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
  let harnessArgs: readonly string[] = ctx.harnessArgs;
  if (sentinelPath !== null) {
    const { value, rest } = extractSettingsArg(ctx.harnessArgs);
    const merged = await mergeSessionHookSettings(value, sentinelPath);
    if (merged === null) {
      // The user passed a --settings we can't parse/merge — pass their args through UNCHANGED and skip
      // the hook (discovery falls back to the --session-id pin), so claude behaves natively (incl. its
      // own error on a bad settings file) rather than us silently masking it.
      tracer.warn("session-hook disabled — user --settings not parseable; args passed through");
      sentinelPath = null;
    } else {
      // Insert BEFORE any `--` so claude parses our --settings as an OPTION; after `--` it's a literal —
      // the hook wouldn't register and the JSON would leak into the prompt.
      harnessArgs = insertSettingsArg(rest, merged);
      tracer.debug("session-hook injected", {
        sentinel: sentinelPath,
        mergedUserSettings: value !== null,
      });
    }
  }
  const command = shellQuoteCommand([
    "env",
    ...envUnset,
    bin,
    "--dangerously-skip-permissions",
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

  const status = new StatusTracker({ session });

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
    status.onLine(payload); // ALWAYS: a top-level user text turn is a turn boundary even when suppressed
    if (!suppressFrame) session.pushUpstream(payload);
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
  }).catch((e) => onPumpCrash("inject", e));

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
    await boundedWait(Promise.allSettled([capture, inject]), TEARDOWN_FLUSH_MS);
    await boundedWait(
      served.catch(() => {}),
      TEARDOWN_FLUSH_MS,
    );
    // Dispose AFTER the capture pump settles (it is the only caller of status.onLine, which re-arms the
    // idle timer) so we don't clear a timer the producer immediately re-arms (review wf#12).
    status.dispose();
    await tmux.killSession(tmuxName);
    if (sentinelPath !== null) await rm(sentinelPath, { force: true }).catch(() => {});
    tracer.info("tmux driver torn down", { name: tmuxName, pumpCrashed });
  }
  return pumpCrashed ? 1 : 0;
}

/** The Driver façade the dispatcher uses: holds the ctx + deps, exposes capabilities + run(signal). */
export function tmuxDriver(ctx: DriverContext, deps: TmuxDriverDeps = {}): Driver {
  return {
    capabilities: TMUX_CAPABILITIES,
    run: (signal: AbortSignal) => runTmuxDriver(ctx, signal, deps),
  };
}
