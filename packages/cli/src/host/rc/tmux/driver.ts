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
// #6 local-prompt visibility (documented limitation — a prompt typed into the LOCAL tmux TUI is
// upstream `user` text the relay drops, so it won't show in the web transcript), #9 strict inject queue.

import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import type { Driver, DriverContext } from "../driver.js";
import { bridgeSession } from "../drivers/bridge.js";
import { RelayCore, type Session } from "../session.js";
import { INJECT_BUFFER, runInjectPump } from "./inject.js";
import { StatusTracker } from "./status.js";
import { realTmuxExec, TmuxCtl, type TmuxExec } from "./tmuxctl.js";
import {
  findNewestTranscript,
  projectDir,
  snapshotTranscriptInodes,
  TranscriptTailer,
  transcriptToPayload,
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
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How often (ms) the capture loop probes `tmux has-session` for pane liveness (codex review #3). */
export const PANE_WATCH_MS = 1000;
/** Consecutive "session gone" probes required before tearing down — so one transient probe (e.g. tmux
 *  momentarily un-runnable under load) can't kill a healthy session (review wf#3). */
export const PANE_GONE_CONFIRMATIONS = 2;
/** How long after spawn to wait for claude's transcript before warning it may not be writing one. */
export const DISCOVERY_WARN_MS = 15_000;
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
  const command = shellQuoteCommand([
    "env",
    ...envUnset,
    bin,
    "--dangerously-skip-permissions",
    ...ctx.harnessArgs,
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
  const discoveryWarnMs = deps.discoveryWarnMs ?? DISCOVERY_WARN_MS;
  const paneWatchMs = deps.paneWatchMs ?? PANE_WATCH_MS;
  const paneCheckEvery = Math.max(1, Math.round(paneWatchMs / pollMs)); // ≈paneWatchMs between probes
  let tailer: TranscriptTailer | null = null;

  // Drain newly-appended transcript lines once. Idempotent via seenUuids, so a final teardown drain that
  // overlaps the loop's own poll is safe.
  const drainTailer = async (): Promise<void> => {
    if (tailer === null) return;
    for (const line of await tailer.poll()) {
      const payload = transcriptToPayload(line);
      if (payload === null) continue;
      const uuid = typeof payload.uuid === "string" ? payload.uuid : null;
      if (uuid !== null) {
        if (seenUuids.has(uuid)) continue; // dedup BEFORE pushUpstream (review #2)
        seenUuids.add(uuid);
      }
      status.onLine(payload);
      session.pushUpstream(payload);
    }
  };

  const capture = (async () => {
    let warnedNoTranscript = false;
    let goneStreak = 0;
    let tick = 0;
    while (!stop.aborted) {
      if (tailer === null) {
        const path = await findNewestTranscript(dir, spawnedAt, {
          exclude: preexisting,
          onAmbiguity: (paths) =>
            tracer.warn("multiple fresh transcripts — picking newest", { paths: paths.join(", ") }),
        });
        if (path !== null) {
          tailer = new TranscriptTailer(path);
          deps.onTranscript?.(path);
          tracer.debug("transcript discovered", { path });
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
