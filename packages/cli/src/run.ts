// The transparent-wrapper runner. For this P2 skeleton it classifies argv and either forwards
// to `claude` (the common path) or reports a parse error. The `--rc-*` actions (identity,
// rotate, share, …) are wired in later PRs; here a recognized rc flag is reported as not-yet-
// implemented so the namespace never silently leaks into claude.

import { spawn as nodeSpawn } from "node:child_process";
import { writeSync } from "node:fs";
import { constants } from "node:os";
import { classifyArgs } from "./args.js";
import { RC_HELP } from "./help.js";
import { runIdentity } from "./identity.js";
import { runShowSecret } from "./showsecret.js";

/** Map a signal name to its number (for the shell-standard 128+N exit code). */
function signalExitCode(signal: NodeJS.Signals): number {
  const n = (constants.signals as Record<string, number>)[signal];
  return 128 + (n ?? 0);
}

/** True if `--help`/`-h` appears before the `--` escape (post-`--` tokens are opaque claude payload). */
function wantsHelp(claudeArgs: readonly string[]): boolean {
  const end = claudeArgs.indexOf("--");
  const scan = end === -1 ? claudeArgs : claudeArgs.slice(0, end);
  return scan.includes("--help") || scan.includes("-h");
}

/** Run `bin` with `args`, inheriting stdio, resolving to the process exit code. */
export type SpawnFn = (bin: string, args: string[]) => Promise<number>;

export interface RunOptions {
  /** Override the claude binary (else RC_CLAUDE_BIN env, else "claude"). */
  claudeBin?: string;
  /** Injectable spawn (tests). Defaults to a real child process with inherited stdio. */
  spawnFn?: SpawnFn;
  /** stderr sink (tests). Defaults to process.stderr. */
  stderr?: (line: string) => void;
  /** stdout sink (tests) for local rc actions like --rc-identity. Defaults to process.stdout. */
  stdout?: (line: string) => void;
}

const realSpawn: SpawnFn = (bin, args) =>
  new Promise((resolve) => {
    // Report why the spawn failed (e.g. ENOENT) before resolving 127 — a bare exit code
    // leaves the user with no idea the binary was missing or not executable.
    const fail = (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`remote-claw: cannot run claude: ${reason}\n`);
      resolve(127);
    };
    try {
      // No shell: args are passed as an argv array, so there is no shell-injection surface
      // even though they're forwarded verbatim from the user.
      const child = nodeSpawn(bin, args, { stdio: "inherit" });
      child.on("error", fail); // command not found / not executable
      child.on("close", (code, signal) => resolve(signal ? signalExitCode(signal) : (code ?? 0)));
    } catch (err) {
      fail(err); // e.g. an empty/invalid bin that throws synchronously
    }
  });

export async function runWrapper(argv: string[], opts: RunOptions = {}): Promise<number> {
  const warn = opts.stderr ?? ((line: string) => void process.stderr.write(line));
  const { rc, claudeArgs, errors } = classifyArgs(argv);

  if (errors.length > 0) {
    for (const e of errors) warn(`remote-claw: ${e}\n`);
    return 2;
  }
  // --rc-identity is the one implemented action; it runs locally and never launches claude.
  // (--rc-file/--rc-json/--rc-quiet are its modifiers, handled inside runIdentity.)
  if (rc["rc-identity"] === true) {
    const writeOut = opts.stdout ?? ((line: string) => void process.stdout.write(line));
    return runIdentity(rc, claudeArgs, { stdout: writeOut, stderr: warn });
  }
  if (rc["rc-show-secret"] === true) {
    const writeOut = opts.stdout ?? ((line: string) => void process.stdout.write(line));
    return runShowSecret(rc, claudeArgs, { stdout: writeOut, stderr: warn });
  }

  const rcNames = Object.keys(rc);
  if (rcNames.length > 0) {
    // Name the offending flag(s) only — never echo their values.
    const named = rcNames.map((k) => `--${k}`).join(", ");
    warn(`remote-claw: --rc-* flags are not implemented in this build yet (${named})\n`);
    return 2;
  }

  // `--help`/`-h`: print our --rc-* help first, then fall through to claude so the user also
  // sees claude's help (claudeArgs still carries --help). Only honor it BEFORE the `--` escape,
  // so a literal `-h` passed through (e.g. `remote-claw -- -h`) stays opaque per that contract.
  if (wantsHelp(claudeArgs)) {
    // Default sink uses a SYNCHRONOUS fd write so the banner is fully flushed before the child
    // (inherited stdio) starts writing — otherwise piped stdout could interleave the two.
    const writeOut = opts.stdout ?? ((line: string) => void writeSync(1, line));
    writeOut(RC_HELP);
  }

  // `||` (not `??`) so an empty string from RC_CLAUDE_BIN falls through to the default
  // instead of producing a synchronous spawn("") throw.
  const bin = opts.claudeBin || process.env.RC_CLAUDE_BIN || "claude";
  const spawnFn = opts.spawnFn ?? realSpawn;
  return spawnFn(bin, claudeArgs);
}
