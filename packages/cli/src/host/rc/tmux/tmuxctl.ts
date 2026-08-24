// A thin, dependency-free wrapper over the `tmux` binary (the `gitinfo.ts` pattern: `execFile` with an
// argv array — no shell). Prompt text is streamed to `load-buffer` over stdin, so it has neither a shell
// injection surface nor an argv/process-list disclosure surface. The tmux driver spawns a plain
// `claude` in a detached pane (capture by tailing claude's transcript JSONL, inject by typing into the
// pane), and these are the only tmux verbs it needs.
//
// Every command goes through an injectable `TmuxExec` so the unit suite asserts exact argv and process
// options with no real tmux (mirrors gitinfo.test.ts's canned-output discipline). Session probes keep
// "absent" distinct from "couldn't ask", and errors expose only a fixed operation name, exit code,
// and application-outcome enum: child argv, environment, stdout, and stderr can all contain secrets.

import { execFile } from "node:child_process";

/** Hard timeout on any single `tmux` invocation so a hung tmux server can't wedge a pump or teardown
 *  (codex review #3). Generous — real tmux verbs return in ms; only a true hang hits this. On timeout
 *  execFile kills the child and resolves with an unknown-application failure, never a hang. */
export const TMUX_EXEC_TIMEOUT_MS = 15_000;

/** The result of one `tmux` invocation. `code` is the process exit status (null ⇒ killed by signal).
 * On failure, `application` distinguishes a tmux rejection that proves the command did not apply from
 * a timeout/spawn/stdin/signal/transport outcome where the server may already have applied it. An
 * injected executor that omits the field is treated conservatively as `unknown`. */
export interface TmuxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  application?: "not-applied" | "unknown";
}

/** Process-local options for one tmux client invocation. Environment values and stdin payloads stay
 * off argv and therefore out of process listings and argv-bearing errors/telemetry. */
export interface TmuxExecOptions {
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}

/** Run `tmux <args>` and resolve its result. Never rejects — a spawn failure (tmux not on PATH) and a
 *  non-zero exit both resolve so the caller decides what an error means (e.g. hasSession reads `code`). */
export type TmuxExec = (
  args: readonly string[],
  options?: TmuxExecOptions,
) => Promise<TmuxExecResult>;

/** A small closed set of tmux diagnostics that prove a command never reached a mutable target. Keep
 * this deliberately narrow: an unfamiliar diagnostic is an unknown application outcome. */
function provesCommandNotApplied(code: number | null, stderr: string): boolean {
  if (code !== 1) return false;
  const diagnostic = stderr.trim();
  return (
    /^can't find (?:pane|window|session): [^\r\n]+$/.test(diagnostic) ||
    /^no server running on [^\r\n]+$/.test(diagnostic) ||
    /^error connecting to [^\r\n]+ \(No such file or directory\)$/.test(diagnostic)
  );
}

/** The default exec: a real `tmux` child via execFile (no shell). Spawn, stdin, timeout, signal, and
 * other unproved failures resolve with a redacted `unknown` application outcome rather than rejecting
 * or exposing the child Error object. */
export const realTmuxExec: TmuxExec = (args, options) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result: TmuxExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      // Clone the read-only public map at the Node boundary. The explicit assertion avoids inheriting
      // consumer-workspace ProcessEnv declaration augmentations (Next requires NODE_ENV at type level),
      // while preserving the caller's exact runtime environment instead of fabricating that variable.
      const childEnv =
        options?.env === undefined ? undefined : ({ ...options.env } as NodeJS.ProcessEnv);
      const child = execFile(
        "tmux",
        [...args],
        {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 8 << 20,
          timeout: TMUX_EXEC_TIMEOUT_MS,
          ...(childEnv === undefined ? {} : { env: childEnv }),
        },
        (err, stdout, stderr) => {
          if (err === null) {
            finish({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          const meta = err as { code?: unknown; killed?: unknown; signal?: unknown };
          const signalled = typeof meta.signal === "string" && meta.signal !== "";
          const code = signalled ? null : typeof meta.code === "number" ? meta.code : 127;
          const diagnostic = stderr ?? "";
          const application =
            meta.killed !== true && !signalled && provesCommandNotApplied(code, diagnostic)
              ? "not-applied"
              : "unknown";
          finish({ code, stdout: stdout ?? "", stderr: diagnostic, application });
        },
      );
      // Spawn and stdin failures may contain argv, environment values, or the input payload in their
      // Error objects. Collapse them to a redacted failure and ensure an EPIPE can never become an
      // unhandled stream error. The normal exec callback still retains tmux's own stderr internally so
      // the façade can recognize narrowly defined "session absent" diagnostics without surfacing them.
      child.once("error", () =>
        finish({ code: 127, stdout: "", stderr: "", application: "unknown" }),
      );
      if (options?.stdin !== undefined) {
        const input = child.stdin;
        const failInput = (): void => {
          if (settled) return;
          try {
            child.kill();
          } catch {
            // The child may already have exited. The redacted failure below remains authoritative.
          }
          finish({ code: 127, stdout: "", stderr: "", application: "unknown" });
        };
        if (input === null) {
          failInput();
        } else {
          input.once("error", failInput);
          try {
            input.end(options.stdin, "utf8");
          } catch {
            failInput();
          }
        }
      }
    } catch {
      finish({ code: 127, stdout: "", stderr: "", application: "unknown" });
    }
  });

/** Stable names for tmux operations that may be safely surfaced in errors and telemetry. */
export type TmuxOperation =
  | "version"
  | "new-session"
  | "has-session"
  | "load-buffer"
  | "set-buffer"
  | "paste-buffer"
  | "send-keys"
  | "kill-session";

/** Three-valued liveness result: transport/spawn failures must never masquerade as a missing session. */
export type TmuxSessionState = "present" | "gone" | "unknown";

/** Result of an idempotent kill attempt, retaining uncertainty instead of silently claiming success. */
export type TmuxKillOutcome = "terminated" | "already-gone" | "unknown";

/** Thrown when a tmux command we REQUIRE to succeed (e.g. new-session) exits non-zero. Deliberately
 * carries only the fixed operation, exit code, and application-outcome enum: argv, environment,
 * stdout, stderr, and causes may contain a prompt, token, or path. */
export class TmuxError extends Error {
  constructor(
    readonly operation: TmuxOperation,
    readonly code: number | null,
    readonly application: "not-applied" | "unknown",
  ) {
    super(`tmux ${operation} failed (code ${code ?? "unknown"})`);
    this.name = "TmuxError";
  }
}

export interface NewSessionOptions {
  /** Working directory for the pane (`-c <cwd>`). */
  cwd?: string;
  /** Exact environment for the tmux client/new private server, kept off argv. */
  env?: Record<string, string>;
  /** Initial pane geometry so the captured TUI has room (`-x <width> -y <height>`). */
  width?: number;
  height?: number;
}

/** Exit 1 is tmux's generic command failure, not an absence code. Treat it as definitive absence only
 * when tmux itself emits one of its stable, single-line missing-session/server diagnostics. Connection
 * refusal, permission errors, malformed commands, and unfamiliar/new diagnostics remain unknown. The
 * text is inspected only at this boundary and is never copied into a public error or trace record. */
function provesSessionAbsent(result: TmuxExecResult): boolean {
  if (result.code !== 1) return false;
  const diagnostic = result.stderr.trim();
  return (
    /^can't find session: [^\r\n]+$/.test(diagnostic) ||
    /^no server running on [^\r\n]+$/.test(diagnostic) ||
    /^error connecting to [^\r\n]+ \(No such file or directory\)$/.test(diagnostic)
  );
}

/** A small façade over the tmux verbs the driver uses. Supplying `socketPath` pins every command to
 * one private tmux server with `-S`, rather than discovering or mutating the user's default server. */
export class TmuxCtl {
  constructor(
    private readonly exec: TmuxExec = realTmuxExec,
    private readonly socketPath?: string,
  ) {
    if (socketPath === "") throw new TypeError("tmux socket path must not be empty");
  }

  /** Prefix a verb with the private socket selector. Keep this centralized so no control path can
   * accidentally address the user's default tmux server. */
  #args(args: readonly string[]): readonly string[] {
    return this.socketPath === undefined ? args : ["-S", this.socketPath, ...args];
  }

  async #run(args: readonly string[], options?: TmuxExecOptions): Promise<TmuxExecResult> {
    try {
      return await this.exec(this.#args(args), options);
    } catch {
      // The real executor is non-rejecting, but an injected executor may throw arbitrary data. Collapse
      // that boundary to the same redacted spawn-failure shape so rejection text cannot escape via a
      // required-command error or a driver log.
      return { code: 127, stdout: "", stderr: "", application: "unknown" };
    }
  }

  /** Run a command we require to succeed; throw TmuxError on a non-zero exit (so the driver can report). */
  async #must(
    operation: TmuxOperation,
    args: readonly string[],
    options?: TmuxExecOptions,
  ): Promise<TmuxExecResult> {
    const r = await this.#run(args, options);
    if (r.code !== 0) throw new TmuxError(operation, r.code, r.application ?? "unknown");
    return r;
  }

  /** `tmux -V` — present + version string (proves tmux is installed before we try to spawn a pane). */
  async version(): Promise<string> {
    const r = await this.#must("version", ["-V"]);
    return r.stdout.trim();
  }

  /** Create a DETACHED session named `name` running `command`. Detached (`-d`) so the wrapper keeps its
   *  own stdio; the user shares it through the same private socket (`tmux -S <socket> attach -t <name>`).
   *  `command` is one argv element; tmux runs it via its parser, so the driver passes a quoted string. */
  async newSession(name: string, command: string, opts: NewSessionOptions = {}): Promise<void> {
    const args = ["new-session", "-d", "-s", name];
    if (opts.cwd !== undefined) args.push("-c", opts.cwd);
    if (opts.width !== undefined) args.push("-x", String(opts.width));
    if (opts.height !== undefined) args.push("-y", String(opts.height));
    args.push(command);
    await this.#must("new-session", args, opts.env === undefined ? undefined : { env: opts.env });
  }

  /** Probe a session without collapsing "tmux says it is absent" and "tmux could not be reached". */
  async sessionState(name: string): Promise<TmuxSessionState> {
    const r = await this.#run(["has-session", "-t", name]);
    if (r.code === 0) return "present";
    if (provesSessionAbsent(r)) return "gone";
    return "unknown";
  }

  /** Compatibility convenience. Prefer `sessionState` when an unknown result must fail closed. */
  async hasSession(name: string): Promise<boolean> {
    return (await this.sessionState(name)) === "present";
  }

  /** Compatibility convenience. Prefer `sessionState` when the caller needs all three outcomes. */
  async sessionGone(name: string): Promise<boolean> {
    return (await this.sessionState(name)) === "gone";
  }

  /** Load `text` into a named tmux paste-buffer (`-b`) from stdin (`-`). Prompt text never becomes a
   * process argument; backticks, `$()`, newlines, arbitrary Unicode, and leading dashes are streamed
   * as inert data and stdin is closed after the complete string is written. */
  async setBuffer(bufferName: string, text: string): Promise<void> {
    await this.#must("load-buffer", ["load-buffer", "-b", bufferName, "-"], { stdin: text });
  }

  /** Paste a named buffer into `target` as BRACKETED paste (`-p`), deleting the buffer after (`-d`).
   *  Bracketed paste means claude's input box receives the whole text as data — multiline + special
   *  chars don't trigger a premature submit. `-r` is intentionally NOT set so tmux DOESN'T translate
   *  the buffer's own newlines into Enter; submission is a separate explicit send-keys Enter. */
  async pasteBuffer(target: string, bufferName: string): Promise<void> {
    await this.#must("paste-buffer", ["paste-buffer", "-d", "-p", "-b", bufferName, "-t", target]);
  }

  /** Send literal key(s) to `target` (e.g. "Enter", "Escape"). Each key is its own argv element; tmux
   *  interprets named keys (Enter/Escape/C-c) and sends other tokens as literal characters. */
  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await this.#must("send-keys", ["send-keys", "-t", target, ...keys]);
  }

  /** Kill a session by name. Only exit 0 or a proved missing-session/server diagnostic establishes safe
   * teardown; generic exit 1 and execution failures retain uncertainty. */
  async killSession(name: string): Promise<TmuxKillOutcome> {
    const r = await this.#run(["kill-session", "-t", name]);
    if (r.code === 0) return "terminated";
    if (provesSessionAbsent(r)) return "already-gone";
    return "unknown";
  }
}
