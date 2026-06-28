// A thin, dependency-free wrapper over the `tmux` binary (the `gitinfo.ts` pattern: `execFile` with an
// argv array — no shell, so a prompt full of backticks/`;`/`$()` carries NO injection surface). The
// tmux driver spawns a plain `claude` in a detached pane (capture by tailing claude's transcript JSONL,
// inject by typing into the pane), and these are the only tmux verbs it needs.
//
// Every command goes through an injectable `TmuxExec` so the unit suite asserts exact argv shapes with
// no real tmux (mirrors gitinfo.test.ts's canned-output discipline). `hasSession` maps tmux's exit
// code to a boolean; `killSession` swallows the "can't find session" error so teardown is idempotent.

import { execFile } from "node:child_process";

/** Hard timeout on any single `tmux` invocation so a hung tmux server can't wedge a pump or teardown
 *  (codex review #3). Generous — real tmux verbs return in ms; only a true hang hits this. On timeout
 *  execFile kills the child and resolves with a spawn-style failure (code 127), never a hang. */
export const TMUX_EXEC_TIMEOUT_MS = 15_000;

/** The result of one `tmux` invocation. `code` is the process exit status (null ⇒ killed by signal). */
export interface TmuxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `tmux <args>` and resolve its result. Never rejects — a spawn failure (tmux not on PATH) and a
 *  non-zero exit both resolve so the caller decides what an error means (e.g. hasSession reads `code`). */
export type TmuxExec = (args: readonly string[]) => Promise<TmuxExecResult>;

/** The default exec: a real `tmux` child via execFile (no shell). A spawn error (ENOENT when tmux isn't
 *  installed) resolves with code 127 + the error message on stderr, so callers see it without a throw. */
export const realTmuxExec: TmuxExec = (args) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        "tmux",
        [...args],
        { windowsHide: true, maxBuffer: 8 << 20, timeout: TMUX_EXEC_TIMEOUT_MS },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 127 // spawn failure (ENOENT etc.) has a string `code` like "ENOENT"
                : 0;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
      child.on("error", (e) => resolve({ code: 127, stdout: "", stderr: String(e) }));
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e) });
    }
  });

/** Thrown when a tmux command we REQUIRE to succeed (e.g. new-session) exits non-zero. Carries the
 *  argv + stderr so the driver can surface an actionable "tmux not found / pane gone" message. */
export class TmuxError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: TmuxExecResult,
  ) {
    super(`tmux ${args.join(" ")} failed (code ${result.code}): ${result.stderr.trim()}`);
    this.name = "TmuxError";
  }
}

export interface NewSessionOptions {
  /** Working directory for the pane (`-c <cwd>`). */
  cwd?: string;
  /** Env vars to set on the new session (`-e KEY=VALUE`), already scrubbed by the driver. */
  env?: Record<string, string>;
  /** Initial pane geometry so the captured TUI has room (`-x <width> -y <height>`). */
  width?: number;
  height?: number;
}

/** A small façade over the tmux verbs the driver uses. One instance per launch; `exec` is injected. */
export class TmuxCtl {
  constructor(private readonly exec: TmuxExec = realTmuxExec) {}

  /** Run a command we require to succeed; throw TmuxError on a non-zero exit (so the driver can report). */
  async #must(args: readonly string[]): Promise<TmuxExecResult> {
    const r = await this.exec(args);
    if (r.code !== 0) throw new TmuxError(args, r);
    return r;
  }

  /** `tmux -V` — present + version string (proves tmux is installed before we try to spawn a pane). */
  async version(): Promise<string> {
    const r = await this.#must(["-V"]);
    return r.stdout.trim();
  }

  /** Create a DETACHED session named `name` running `command`. Detached (`-d`) so the wrapper keeps its
   *  own stdio; the user shares the live pane with `tmux attach -t <name>`. `command` is passed as ONE
   *  argv element — tmux runs it via its own command parser, so the driver passes a pre-quoted string. */
  async newSession(name: string, command: string, opts: NewSessionOptions = {}): Promise<void> {
    const args = ["new-session", "-d", "-s", name];
    if (opts.cwd !== undefined) args.push("-c", opts.cwd);
    if (opts.width !== undefined) args.push("-x", String(opts.width));
    if (opts.height !== undefined) args.push("-y", String(opts.height));
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(command);
    await this.#must(args);
  }

  /** True iff a session named `name` exists. `has-session` exits 0 when present, non-zero otherwise. */
  async hasSession(name: string): Promise<boolean> {
    const r = await this.exec(["has-session", "-t", name]);
    return r.code === 0;
  }

  /** True ONLY when tmux RAN and reported the session missing — i.e. exit code 1 ("can't find
   *  session"). A spawn/exec failure (realTmuxExec maps these to 127) or a timeout is NOT "gone" — it
   *  means we couldn't probe — so the pane-liveness watcher won't tear down a healthy session on a
   *  transient inability to run tmux under load (codex/review #3). Returns false for present (0) too. */
  async sessionGone(name: string): Promise<boolean> {
    const r = await this.exec(["has-session", "-t", name]);
    return r.code === 1;
  }

  /** Load `text` into a named tmux paste-buffer (`-b`). `--` ends option parsing so a `text` starting
   *  with `-` is taken literally; the argv array means backticks/`$()`/newlines are all inert data. */
  async setBuffer(bufferName: string, text: string): Promise<void> {
    await this.#must(["set-buffer", "-b", bufferName, "--", text]);
  }

  /** Paste a named buffer into `target` as BRACKETED paste (`-p`), deleting the buffer after (`-d`).
   *  Bracketed paste means claude's input box receives the whole text as data — multiline + special
   *  chars don't trigger a premature submit. `-r` is intentionally NOT set so tmux DOESN'T translate
   *  the buffer's own newlines into Enter; submission is a separate explicit send-keys Enter. */
  async pasteBuffer(target: string, bufferName: string): Promise<void> {
    await this.#must(["paste-buffer", "-d", "-p", "-b", bufferName, "-t", target]);
  }

  /** Send literal key(s) to `target` (e.g. "Enter", "Escape"). Each key is its own argv element; tmux
   *  interprets named keys (Enter/Escape/C-c) and sends other tokens as literal characters. */
  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await this.#must(["send-keys", "-t", target, ...keys]);
  }

  /** Kill a session by name. Idempotent: a "can't find session" exit (already gone) is swallowed so
   *  teardown never throws on a session the user already closed or that never started. */
  async killSession(name: string): Promise<void> {
    await this.exec(["kill-session", "-t", name]); // best-effort; ignore exit code
  }
}
