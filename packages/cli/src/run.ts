// The transparent-wrapper runner. For this P2 skeleton it classifies argv and either forwards
// to `claude` (the common path) or reports a parse error. The `--rc-*` actions (identity,
// share, …) are wired in later PRs; here a recognized rc flag is reported as not-yet-
// implemented so the namespace never silently leaks into claude.

import { spawn as nodeSpawn } from "node:child_process";
import { writeSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { deriveIdentity } from "@remote-claw/clawsec";
import { classifyArgs } from "./args.js";
import { RC_HELP } from "./help.js";
import { runRcLaunch, type SpawnClaudeEnv } from "./host/rc/launch.js";
import { runRcTrace } from "./host/rc/trace-run.js";
import { runIdentity } from "./identity.js";
import { runPass } from "./pass.js";
import { runShowSecret } from "./showsecret.js";
import { ensureIdentity, loadSecret, resolveSecretPath } from "./store.js";

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
  /** Injectable env-aware spawn for the RC launch path (tests). Defaults to a real child process. */
  spawnRcEnv?: SpawnClaudeEnv;
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

/** Like realSpawn, but launches the child with an explicit env (the RC proxy env). */
const realSpawnEnv: SpawnClaudeEnv = (bin, args, env) =>
  new Promise((resolve) => {
    const fail = (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`remote-claw: cannot run claude: ${reason}\n`);
      resolve(127);
    };
    try {
      const child = nodeSpawn(bin, [...args], { stdio: "inherit", env });
      child.on("error", fail);
      child.on("close", (code, signal) => resolve(signal ? signalExitCode(signal) : (code ?? 0)));
    } catch (err) {
      fail(err);
    }
  });

export async function runWrapper(argv: string[], opts: RunOptions = {}): Promise<number> {
  const warn = opts.stderr ?? ((line: string) => void process.stderr.write(line));
  const { rc, claudeArgs, errors } = classifyArgs(argv);

  if (errors.length > 0) {
    for (const e of errors) warn(`remote-claw: ${e}\n`);
    return 2;
  }
  // The local rc actions (--rc-identity / --rc-show-secret / --rc-pass) run locally and never
  // launch claude; their modifiers (--rc-file/--rc-json/--rc-quiet/…) are handled inside each.
  if (rc["rc-identity"] === true) {
    const writeOut = opts.stdout ?? ((line: string) => void process.stdout.write(line));
    return runIdentity(rc, claudeArgs, { stdout: writeOut, stderr: warn });
  }
  if (rc["rc-show-secret"] === true) {
    const writeOut = opts.stdout ?? ((line: string) => void process.stdout.write(line));
    return runShowSecret(rc, claudeArgs, { stdout: writeOut, stderr: warn });
  }
  if (rc["rc-pass"] === true) {
    const writeOut = opts.stdout ?? ((line: string) => void process.stdout.write(line));
    return runPass(rc, claudeArgs, { stdout: writeOut, stderr: warn });
  }
  // `--rc-trace`: a live protocol inspector — stand up the tracing MITM → real Anthropic and spawn
  // claude behind it (no broker). Handled before the generic stray-flag check, so it validates its
  // own companions: only --rc-file (for the CA dir) applies; anything else is a usage error.
  if (rc["rc-trace"] === true) {
    if (wantsHelp(claudeArgs)) {
      const writeOut = opts.stdout ?? ((line: string) => void writeSync(1, line));
      writeOut(RC_HELP); // print our help; don't stand up a proxy just to show it
      return 0;
    }
    const stray = Object.keys(rc).filter((n) => n !== "rc-trace" && n !== "rc-file");
    if (stray.length > 0) {
      warn(`remote-claw: ${stray.map((k) => `--${k}`).join(", ")} doesn't apply to --rc-trace\n`);
      return 2;
    }
    const bin = opts.claudeBin || process.env.RC_CLAUDE_BIN || "claude";
    return runRcTracePath(rc, claudeArgs, bin, opts, warn);
  }

  // The remaining `--rc-*` namespace splits into flags the LAUNCH path consumes (the secret file +
  // the broker origin) and action modifiers that are only meaningful with a local action above.
  const rcNames = Object.keys(rc);
  const stray = rcNames.filter((n) => n !== "rc-file" && n !== "rc-app" && n !== "rc-backend");
  if (stray.length > 0) {
    const named = stray.map((k) => `--${k}`).join(", ");
    warn(`remote-claw: ${named} only applies to a --rc-* action (e.g. --rc-identity)\n`);
    return 2;
  }

  // `--help`/`-h`: print our --rc-* help first, then fall through to claude so the user also
  // sees claude's help (claudeArgs still carries --help). Only honor it BEFORE the `--` escape,
  // so a literal `-h` passed through (e.g. `remote-claw -- -h`) stays opaque per that contract.
  const helpWanted = wantsHelp(claudeArgs);
  if (helpWanted) {
    // Default sink uses a SYNCHRONOUS fd write so the banner is fully flushed before the child
    // (inherited stdio) starts writing — otherwise piped stdout could interleave the two.
    const writeOut = opts.stdout ?? ((line: string) => void writeSync(1, line));
    writeOut(RC_HELP);
  }

  // `||` (not `??`) so an empty string from RC_CLAUDE_BIN falls through to the default
  // instead of producing a synchronous spawn("") throw.
  const bin = opts.claudeBin || process.env.RC_CLAUDE_BIN || "claude";

  // Remote control needs a broker to relay to (`--rc-app` / RC_APP). With one configured, launch the
  // REAL claude behind our MITM so a `/remote-control` inside it wires into the broker (§3.1). Without
  // one, there's nothing to relay to — run claude transparently (identical to plain `claude`). A bare
  // `--help` short-circuits the launch: never create an identity or stand up the MITM just to print
  // claude's help — fall through to a plain spawn.
  const rcApp = (typeof rc["rc-app"] === "string" ? rc["rc-app"] : "") || process.env.RC_APP || "";
  if (rcApp !== "" && !helpWanted) {
    return runRcLaunchPath(rcApp, rc, claudeArgs, bin, opts, warn);
  }
  if (rcApp === "" && rcNames.length > 0 && !helpWanted) {
    warn(
      "remote-claw: --rc-file needs --rc-app (or RC_APP) to enable remote control; running plain claude\n",
    );
  }
  const spawnFn = opts.spawnFn ?? realSpawn;
  return spawnFn(bin, claudeArgs);
}

/** Stand up the tracing MITM → real Anthropic and spawn claude behind it. Reuses the wrapper's CA
 *  (the certs dir next to the secret file), but needs no identity/secret — nothing hits the broker. */
async function runRcTracePath(
  rc: Record<string, unknown>,
  claudeArgs: string[],
  bin: string,
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  const secretPath = resolveSecretPath({
    ...(typeof rc["rc-file"] === "string" ? { file: rc["rc-file"] } : {}),
  }).path;
  try {
    return await runRcTrace({
      claudeArgs,
      certsDir: join(dirname(secretPath), "mitm-certs"),
      claudeBin: bin,
      spawnClaude: opts.spawnRcEnv ?? realSpawnEnv,
    });
  } catch (e) {
    warn(`remote-claw: could not start trace MITM: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}

/** Resolve the identity (auto-created on first run) and launch claude behind the MITM (§3.1/§14). */
async function runRcLaunchPath(
  brokerUrl: string,
  rc: Record<string, unknown>,
  claudeArgs: string[],
  bin: string,
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  const secretPath = resolveSecretPath({
    ...(typeof rc["rc-file"] === "string" ? { file: rc["rc-file"] } : {}),
  }).path;
  // Which broker backend this host targets: --rc-backend wins, else RC_BACKEND, else the broker's
  // default (undefined ⇒ no x-broker-backend header). Empty/whitespace is treated as unset.
  const backend =
    (typeof rc["rc-backend"] === "string" ? rc["rc-backend"] : "").trim() ||
    (process.env.RC_BACKEND ?? "").trim() ||
    undefined;
  try {
    await ensureIdentity(secretPath); // local, idempotent — create on first run, no network
    const { secret } = await loadSecret(secretPath);
    const identity = await deriveIdentity(secret);
    return await runRcLaunch({
      claudeArgs,
      identity,
      brokerUrl,
      certsDir: join(dirname(secretPath), "mitm-certs"),
      claudeBin: bin,
      spawnClaude: opts.spawnRcEnv ?? realSpawnEnv,
      ...(backend !== undefined ? { backend } : {}),
    });
  } catch (e) {
    warn(`remote-claw: could not start remote control: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}
