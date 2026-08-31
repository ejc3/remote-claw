// The transparent-wrapper runner. It classifies argv, executes the implemented `--rc-*` actions and
// drivers, or forwards ordinary arguments to `claude`. Reserved flags are consumed or rejected here;
// they never leak silently into the child.

import { spawn as nodeSpawn } from "node:child_process";
import { writeSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { deriveIdentity } from "@remote-claw/clawsec";
import { classifyArgs } from "./args.js";
import { BrokerClient } from "./broker/client.js";
import { normalizeBrokerOrigin, protectionBypassForBrokerOrigin } from "./broker/origin.js";
import { RC_HELP } from "./help.js";
import { runClaudeNativeDriver } from "./host/rc/anthropic/driver.js";
import { parseStripKeys } from "./host/rc/bedrock/translate.js";
import {
  DEFAULT_CODEX_APP_SERVER_URL,
  isCodexThreadId,
  normalizeCodexAppServerUrl,
} from "./host/rc/codex/client.js";
import { runCodexDriver } from "./host/rc/codex/driver.js";
import {
  assertStableClaudeCompatibility,
  STABLE_CLAUDE_REQUIREMENT,
} from "./host/rc/compatibility.js";
import type { DriverContext } from "./host/rc/driver.js";
import { gitInfo } from "./host/rc/gitinfo.js";
import { runRcLaunch, type SpawnClaudeEnv } from "./host/rc/launch.js";
import {
  DEFAULT_OPENCODE_URL,
  isOpencodeSessionId,
  normalizeOpencodeBaseUrl,
} from "./host/rc/opencode/client.js";
import { DEFAULT_OPENCODE_MODEL, runOpencodeDriver } from "./host/rc/opencode/driver.js";
import { runTmuxDriver } from "./host/rc/tmux/driver.js";
import { resolveMirrorPermissions } from "./host/rc/tmux/permhook.js";
import { resolveInjectSessionHook } from "./host/rc/tmux/sessionhook.js";
import { runRcTrace } from "./host/rc/trace-run.js";
import { runIdentity } from "./identity.js";
import { runPass } from "./pass.js";
import { securityProvider } from "./security/provider.js";
import { runShowSecret } from "./showsecret.js";
import { ensureIdentity, loadSecret, resolveSecretPath } from "./store.js";
import { tracerFromEnv } from "./trace.js";

/** Map a signal name to its number (for the shell-standard 128+N exit code). */
function signalExitCode(signal: NodeJS.Signals): number {
  const n = (constants.signals as Record<string, number>)[signal];
  return 128 + (n ?? 0);
}

/** Warning lines for reserved flags that belong to a DIFFERENT known driver than the selected one — a
 *  silent no-op otherwise. Pure (no I/O) so it's unit-tested directly; the caller emits each line via
 *  `warn`. Allowlist-gated to KNOWN drivers so an UNKNOWN driver gets only its
 *  own "unknown --rc-driver" error, not a second misapplied-flag nag. A reserved VALUE flag counts as
 *  "passed" only when it carries a non-empty (trimmed) value — an empty/blank value is absent everywhere.
 *  Each group names the driver it DOES apply to:
 *    • tmux: --rc-session-hook / --rc-no-session-hook (ongoing transcript/rotation follow only) /
 *      --rc-tmux-skip-permissions
 *    • opencode: --rc-oc-url / --rc-oc-model / --rc-oc-session / --rc-oc-mirror-permissions
 *    • codex: --rc-codex-url / --rc-codex-thread
 *    • mitm (inference): --rc-inference / --rc-bedrock-region / --rc-bedrock-model / --rc-accountless
 *      (tmux/opencode reach Bedrock via their own provider, NOT our MITM translation). */
export function misappliedDriverFlagWarnings(
  driver: string,
  rc: Record<string, unknown>,
): string[] {
  const has = (n: string) => typeof rc[n] === "string" && (rc[n] as string).trim() !== "";
  const out: string[] = [];
  const emit = (flags: string[], appliesTo: string) => {
    if (flags.length === 0) return;
    out.push(
      `remote-claw: ${flags.join(" / ")} only appl${flags.length > 1 ? "y" : "ies"} to --rc-driver=${appliesTo}; ignored for ${driver}\n`,
    );
  };
  if (
    driver === "mitm" ||
    driver === "claude-native" ||
    driver === "opencode" ||
    driver === "codex"
  ) {
    emit(
      [
        ...(rc["rc-session-hook"] === true ? ["--rc-session-hook"] : []),
        ...(rc["rc-no-session-hook"] === true ? ["--rc-no-session-hook"] : []),
        ...(rc["rc-tmux-skip-permissions"] === true ? ["--rc-tmux-skip-permissions"] : []),
      ],
      "tmux",
    );
  }
  if (driver === "mitm" || driver === "claude-native" || driver === "tmux" || driver === "codex") {
    emit(
      [
        ...(rc["rc-oc-mirror-permissions"] === true ? ["--rc-oc-mirror-permissions"] : []),
        ...(has("rc-oc-url") ? ["--rc-oc-url"] : []),
        ...(has("rc-oc-model") ? ["--rc-oc-model"] : []),
        ...(has("rc-oc-session") ? ["--rc-oc-session"] : []),
      ],
      "opencode",
    );
  }
  if (driver === "tmux" || driver === "opencode" || driver === "codex") {
    emit(
      [
        ...(has("rc-inference") ? ["--rc-inference"] : []),
        ...(has("rc-bedrock-region") ? ["--rc-bedrock-region"] : []),
        ...(has("rc-bedrock-model") ? ["--rc-bedrock-model"] : []),
        ...(rc["rc-accountless"] === true ? ["--rc-accountless"] : []),
      ],
      "mitm",
    );
  }
  if (
    driver === "mitm" ||
    driver === "claude-native" ||
    driver === "tmux" ||
    driver === "opencode"
  ) {
    emit(
      [
        ...(has("rc-codex-url") ? ["--rc-codex-url"] : []),
        ...(has("rc-codex-thread") ? ["--rc-codex-thread"] : []),
      ],
      "codex",
    );
  }
  return out;
}

/** Anthropic's observed native route grammar: one path-safe, explicitly named cse_ identifier. */
const CANONICAL_CLAUDE_SESSION_RE = /^cse_[A-Za-z0-9_-]+$/;

/** True if `--help`/`-h` appears before the `--` escape (post-`--` tokens are opaque claude payload). */
function wantsHelp(claudeArgs: readonly string[]): boolean {
  const end = claudeArgs.indexOf("--");
  const scan = end === -1 ? claudeArgs : claudeArgs.slice(0, end);
  return scan.includes("--help") || scan.includes("-h");
}

const OPENCODE_CONFIG_FLAGS = [
  "rc-oc-url",
  "rc-oc-model",
  "rc-oc-session",
  "rc-oc-mirror-permissions",
] as const;

const OPENCODE_CONFIG_ENV = [
  "OPENCODE_URL",
  "RC_OC_MODEL",
  "RC_OC_SESSION",
  "RC_OC_MIRROR_PERMISSIONS",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
] as const;

const CODEX_CONFIG_FLAGS = ["rc-codex-url", "rc-codex-thread"] as const;
const CODEX_CONFIG_ENV = ["RC_CODEX_URL", "RC_CODEX_THREAD"] as const;

/** An OpenCode selection or any OpenCode-only configuration is an explicit attach request. */
function hasOpencodeIntent(rc: Record<string, unknown>, driver: string): boolean {
  return (
    driver === "opencode" ||
    OPENCODE_CONFIG_FLAGS.some((name) => Object.hasOwn(rc, name)) ||
    OPENCODE_CONFIG_ENV.some((name) => process.env[name] !== undefined)
  );
}

function hasCodexIntent(rc: Record<string, unknown>, driver: string): boolean {
  return (
    driver === "codex" ||
    CODEX_CONFIG_FLAGS.some((name) => Object.hasOwn(rc, name)) ||
    CODEX_CONFIG_ENV.some((name) => process.env[name] !== undefined)
  );
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
  /** Injectable OpenCode driver boundary (tests). */
  runOpencodeDriver?: typeof runOpencodeDriver;
  /** Injectable Codex driver boundary (tests). */
  runCodexDriver?: typeof runCodexDriver;
  /** Injectable Claude native-companion boundary (tests). */
  runClaudeNativeDriver?: typeof runClaudeNativeDriver;
  /** Injectable tmux driver boundary (tests). */
  runTmuxDriver?: typeof runTmuxDriver;
  /** Injectable stable-Claude compatibility boundary (tests). Defaults to the fail-closed probe. */
  claudeCompatibilityCheck?: (claudeBin: string) => Promise<void>;
  /** Narrow release-platform seam for pinned native companions (tests). */
  runtime?: Readonly<{ platform: NodeJS.Platform; arch: string }>;
}

async function withClearedRootSecret<T>(
  secretPath: string,
  operation: (secret: Uint8Array) => Promise<T>,
): Promise<T> {
  const { secret } = await loadSecret(secretPath);
  try {
    return await operation(secret);
  } finally {
    secret.fill(0);
  }
}

function resolveSecretFile(rc: Record<string, unknown>): string {
  return resolveSecretPath({
    ...(typeof rc["rc-file"] === "string" ? { file: rc["rc-file"] } : {}),
  }).path;
}

function resolveBrokerBackend(rc: Record<string, unknown>): string | undefined {
  return (
    (typeof rc["rc-backend"] === "string" ? rc["rc-backend"] : "").trim() ||
    (process.env.RC_BACKEND ?? "").trim() ||
    undefined
  );
}

interface DriverContextOptions {
  brokerUrl: string;
  protectionBypass?: string;
  rc: Record<string, unknown>;
  harnessArgs: string[];
  tracerTarget: string;
  harnessBin?: string;
  extra?: Record<string, unknown>;
}

/** Build the identity/broker half shared by every non-MITM harness. Driver-specific parsing stays at
 * the dispatch edge; crypto, deployment protection, backend selection, cwd, and git do not. */
async function createDriverContext(options: DriverContextOptions): Promise<DriverContext> {
  const secretPath = resolveSecretFile(options.rc);
  const backend = resolveBrokerBackend(options.rc);
  await ensureIdentity(secretPath);
  return withClearedRootSecret(secretPath, async (secret) => {
    const identity = await deriveIdentity(secret);
    const provider = securityProvider("sealed", identity);
    const newClient = () =>
      new BrokerClient({
        baseUrl: options.brokerUrl,
        provider,
        ...(options.protectionBypass !== undefined
          ? { protectionBypass: options.protectionBypass }
          : {}),
        ...(backend !== undefined ? { backend } : {}),
      });
    const cwd = process.cwd();
    return {
      harnessArgs: options.harnessArgs,
      ...(options.harnessBin !== undefined ? { harnessBin: options.harnessBin } : {}),
      identity,
      brokerUrl: options.brokerUrl,
      ...(backend !== undefined ? { backend } : {}),
      title: "remote-claw",
      cwd,
      git: await gitInfo(cwd),
      newClient,
      tracer: tracerFromEnv(options.tracerTarget),
      ...(options.extra !== undefined ? { extra: options.extra } : {}),
    };
  });
}

function plainClaudeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  // Plain passthrough is still an untrusted child boundary. These values belong to the wrapper host,
  // just as they do on every RC driver path; Claude and its MCPs never need either one.
  delete env.REMOTE_CLAW_SECRET_FILE;
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return env;
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
      const child = nodeSpawn(bin, args, { stdio: "inherit", env: plainClaudeEnv() });
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
  if (rc["rc-oc-skip-permissions"] === true) {
    warn(
      "remote-claw: --rc-oc-skip-permissions is retired; OpenCode permission policy is not mutated by default (use --rc-oc-mirror-permissions only for the experimental opt-in)\n",
    );
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
  const stray = rcNames.filter(
    (n) =>
      n !== "rc-file" &&
      n !== "rc-app" &&
      n !== "rc-backend" &&
      n !== "rc-driver" &&
      n !== "rc-native-session" &&
      n !== "rc-inference" &&
      n !== "rc-bedrock-region" &&
      n !== "rc-bedrock-model" &&
      n !== "rc-oc-url" &&
      n !== "rc-oc-model" &&
      n !== "rc-oc-session" &&
      n !== "rc-oc-mirror-permissions" &&
      n !== "rc-codex-url" &&
      n !== "rc-codex-thread" &&
      n !== "rc-session-hook" &&
      n !== "rc-no-session-hook" &&
      n !== "rc-tmux-skip-permissions" &&
      n !== "rc-accountless",
  );
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

  const driver = (
    (typeof rc["rc-driver"] === "string" ? rc["rc-driver"] : "").trim() ||
    (process.env.RC_DRIVER ?? "").trim() ||
    "mitm"
  ).toLowerCase();

  // Remote control needs a broker to relay to (`--rc-app` / RC_APP). With one configured, launch the
  // selected capture/inject driver and wire its sessions into the broker (§3.1). Without one, there's
  // nothing to relay to — ordinary legacy flags still run claude transparently. An explicit attach
  // request must never degrade into a new plain-Claude process, including on a help invocation.
  const rcApp = (typeof rc["rc-app"] === "string" ? rc["rc-app"] : "") || process.env.RC_APP || "";
  if (rcApp === "" && hasOpencodeIntent(rc, driver)) {
    warn(
      "remote-claw: OpenCode attach configuration requires --rc-app (or RC_APP); refusing to launch plain claude\n",
    );
    return 2;
  }
  if (rcApp === "" && hasCodexIntent(rc, driver)) {
    warn(
      "remote-claw: Codex attach configuration requires --rc-app (or RC_APP); refusing to launch plain claude\n",
    );
    return 2;
  }
  if (rcApp === "" && typeof rc["rc-native-session"] === "string" && !helpWanted) {
    // Unlike the legacy launch flags, an explicit attach request must not degrade to spawning a new
    // plain Claude when its broker origin is missing.
    warn("remote-claw: --rc-native-session requires --rc-app (or RC_APP)\n");
    return 2;
  }
  if (rcApp !== "" && (!helpWanted || driver === "opencode" || driver === "codex")) {
    let brokerUrl: string;
    let protectionBypass: string | undefined;
    try {
      brokerUrl = normalizeBrokerOrigin(rcApp);
      protectionBypass = protectionBypassForBrokerOrigin(brokerUrl, process.env);
    } catch (e) {
      warn(`remote-claw: ${(e as Error)?.message ?? e}\n`);
      return 2;
    }
    // Which capture/inject driver runs the harness: --rc-driver / RC_DRIVER, default "mitm" (the real
    // claude behind our MITM). tmux runs a PLAIN claude in a tmux pane and bridges via the transcript
    // (provider-agnostic, Bedrock-capable — no MITM); opencode peer-attaches to an opencode server. All
    // three bridge to the SAME broker via the pluggable seam (driver.ts).
    if (
      typeof rc["rc-native-session"] === "string" &&
      driver !== "claude-native" &&
      (driver === "mitm" || driver === "tmux" || driver === "opencode" || driver === "codex")
    ) {
      warn("remote-claw: --rc-native-session requires --rc-driver=claude-native\n");
      return 2;
    }
    // Warn (don't fail) when a flag that belongs to a DIFFERENT known driver was explicitly passed, so a
    // silent no-op (e.g. `--rc-driver=tmux --rc-inference=bedrock`, which is NOT zero-api.anthropic.com)
    // becomes visible. Pure + allowlist-gated (an unknown driver gets only its own error below).
    for (const line of misappliedDriverFlagWarnings(driver, rc)) warn(line);
    if (driver === "mitm") {
      return runRcLaunchPath(brokerUrl, protectionBypass, rc, claudeArgs, bin, opts, warn);
    }
    if (driver === "claude-native") {
      return runClaudeNativeDriverPath(
        brokerUrl,
        protectionBypass,
        rc,
        claudeArgs,
        bin,
        opts,
        warn,
      );
    }
    if (driver === "opencode") {
      return runOpencodeDriverPath(brokerUrl, protectionBypass, rc, claudeArgs, opts, warn);
    }
    if (driver === "codex") {
      return runCodexDriverPath(brokerUrl, protectionBypass, rc, claudeArgs, opts, warn);
    }
    if (driver === "tmux") {
      return runTmuxDriverPath(brokerUrl, protectionBypass, rc, claudeArgs, bin, opts, warn);
    }
    warn(
      `remote-claw: unknown --rc-driver=${driver} (expected mitm | claude-native | tmux | opencode | codex)\n`,
    );
    return 2;
  }
  if (rcApp === "" && rcNames.length > 0 && !helpWanted) {
    // Name the flags the user actually passed (e.g. --rc-backend) instead of always blaming --rc-file.
    const named = rcNames.map((n) => `--${n}`).join(", ");
    const verb = rcNames.length > 1 ? "need" : "needs";
    warn(
      `remote-claw: ${named} ${verb} --rc-app (or RC_APP) to enable remote control; running plain claude\n`,
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
  const secretPath = resolveSecretFile(rc);
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
  protectionBypass: string | undefined,
  rc: Record<string, unknown>,
  claudeArgs: string[],
  bin: string,
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  const secretPath = resolveSecretFile(rc);
  // Which broker backend this host targets: --rc-backend wins, else RC_BACKEND, else the broker's
  // default (undefined ⇒ no x-broker-backend header). Empty/whitespace is treated as unset.
  const backend = resolveBrokerBackend(rc);
  // Inference target: --rc-inference / RC_INFERENCE, default "anthropic" (pass through). "bedrock"
  // routes /v1/messages to Amazon Bedrock and synthesizes the rest — zero api.anthropic.com.
  const inferenceRaw =
    (typeof rc["rc-inference"] === "string" ? rc["rc-inference"] : "").trim() ||
    (process.env.RC_INFERENCE ?? "").trim() ||
    "anthropic";
  const inference = inferenceRaw.toLowerCase();
  if (inference !== "anthropic" && inference !== "bedrock") {
    warn(`remote-claw: unknown --rc-inference=${inferenceRaw} (expected anthropic | bedrock)\n`);
    return 2;
  }
  const region =
    (typeof rc["rc-bedrock-region"] === "string" ? rc["rc-bedrock-region"] : "").trim() ||
    undefined;
  const model =
    (typeof rc["rc-bedrock-model"] === "string" ? rc["rc-bedrock-model"] : "").trim() || undefined;
  // Extra body keys to strip before forwarding to Bedrock (RC_BEDROCK_STRIP_KEYS), for when a specific
  // model rejects a field claude sends (e.g. output_config/effort) with a hard 400.
  const stripKeys = parseStripKeys(process.env.RC_BEDROCK_STRIP_KEYS);
  const bedrock =
    inference === "bedrock"
      ? {
          ...(region !== undefined ? { region } : {}),
          ...(model !== undefined ? { modelOverride: model } : {}),
          ...(stripKeys !== undefined ? { stripKeys } : {}),
        }
      : undefined;
  // Accountless: --rc-accountless / RC_ACCOUNTLESS=1. Seeds a synthetic claude.ai login + RC gates so
  // native /remote-control works with no real login. Requires bedrock inference — a fabricated credential
  // can't reach real Anthropic for /v1/messages, so anthropic-passthrough would fail at the first turn.
  const accountless =
    rc["rc-accountless"] === true ||
    ["1", "true", "yes"].includes((process.env.RC_ACCOUNTLESS ?? "").trim().toLowerCase());
  if (accountless && inference !== "bedrock") {
    warn(
      "remote-claw: --rc-accountless requires --rc-inference=bedrock (a fabricated login can't reach real Anthropic)\n",
    );
    return 2;
  }
  try {
    await (opts.claudeCompatibilityCheck ?? assertStableClaudeCompatibility)(bin);
  } catch {
    warn(`remote-claw: ${STABLE_CLAUDE_REQUIREMENT}\n`);
    return 1;
  }
  try {
    await ensureIdentity(secretPath); // local, idempotent — create on first run, no network
    const identity = await withClearedRootSecret(secretPath, (secret) => deriveIdentity(secret));
    return await runRcLaunch({
      claudeArgs,
      identity,
      brokerUrl,
      certsDir: join(dirname(secretPath), "mitm-certs"),
      claudeBin: bin,
      // The CLI boundary checked the version already. Direct runRcLaunch callers are checked there.
      claudeCompatibilityCheck: async () => {},
      spawnClaude: opts.spawnRcEnv ?? realSpawnEnv,
      ...(protectionBypass !== undefined ? { protectionBypass } : {}),
      ...(backend !== undefined ? { backend } : {}),
      inference,
      ...(bedrock !== undefined ? { bedrock } : {}),
      ...(accountless ? { accountless: true } : {}),
    });
  } catch (e) {
    warn(`remote-claw: could not start remote control: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}

/**
 * Launch ordinary Anthropic-hosted Claude behind a transparent binding observer and project that exact
 * native Remote Control session into the sealed broker. Unlike the private MITM path, Anthropic remains
 * the sync service and the official Claude client can coexist with the local TUI and remote-claw.
 */
async function runClaudeNativeDriverPath(
  brokerUrl: string,
  protectionBypass: string | undefined,
  rc: Record<string, unknown>,
  claudeArgs: string[],
  bin: string,
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  const attachRequested = typeof rc["rc-native-session"] === "string";
  const nativeSessionId = attachRequested ? (rc["rc-native-session"] as string).trim() : undefined;
  if (
    attachRequested &&
    (nativeSessionId === undefined || !CANONICAL_CLAUDE_SESSION_RE.test(nativeSessionId))
  ) {
    warn("remote-claw: --rc-native-session must be a canonical cse_* session id\n");
    return 2;
  }
  if (attachRequested && claudeArgs.length > 0) {
    warn(
      "remote-claw: --rc-native-session attaches a companion only; remove forwarded Claude arguments\n",
    );
    return 2;
  }
  const incompatible = [
    ...(typeof rc["rc-inference"] === "string" && rc["rc-inference"].trim() !== ""
      ? ["--rc-inference"]
      : []),
    ...(typeof rc["rc-bedrock-region"] === "string" && rc["rc-bedrock-region"].trim() !== ""
      ? ["--rc-bedrock-region"]
      : []),
    ...(typeof rc["rc-bedrock-model"] === "string" && rc["rc-bedrock-model"].trim() !== ""
      ? ["--rc-bedrock-model"]
      : []),
    ...(rc["rc-accountless"] === true ? ["--rc-accountless"] : []),
  ];
  if (incompatible.length > 0) {
    warn(
      `remote-claw: ${incompatible.join(" / ")} cannot be used with --rc-driver=claude-native; this driver preserves Anthropic Remote Control\n`,
    );
    return 2;
  }

  try {
    await (opts.claudeCompatibilityCheck ?? assertStableClaudeCompatibility)(bin);
  } catch {
    warn(`remote-claw: ${STABLE_CLAUDE_REQUIREMENT}\n`);
    return 1;
  }

  const secretPath = resolveSecretFile(rc);
  try {
    const ctx = await createDriverContext({
      brokerUrl,
      ...(protectionBypass !== undefined ? { protectionBypass } : {}),
      rc,
      harnessArgs: claudeArgs,
      harnessBin: bin,
      tracerTarget: "rc.claude-native",
    });
    const ac = new AbortController();
    const onSignal = () => ac.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      return await (opts.runClaudeNativeDriver ?? runClaudeNativeDriver)(ctx, ac.signal, {
        certsDir: join(dirname(secretPath), "mitm-certs"),
        claudeBin: bin,
        spawnClaude: opts.spawnRcEnv ?? realSpawnEnv,
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      });
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } catch {
    warn("remote-claw: could not start Claude native companion\n");
    return 1;
  }
}

/**
 * The `--rc-driver=opencode` path: resolve the identity (auto-created on first run) and bridge an
 * `opencode serve` session to the broker — NO MITM, no spawned claude. Builds the same DriverContext
 * shape runRcLaunchPath builds for the MITM (identity, backend, newClient, title, cwd, git), plus the
 * OpenCode knobs (server url + model). Runs until SIGINT/SIGTERM (so Ctrl-C tears the driver down).
 */
async function runOpencodeDriverPath(
  brokerUrl: string,
  protectionBypass: string | undefined,
  rc: Record<string, unknown>,
  claudeArgs: string[],
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  // This compatibility release is deliberately one tuple, not a platform/version/model matrix. Every
  // usage/configuration check stays ahead of identity creation, git inspection, broker construction,
  // and the driver's native health probe.
  if (claudeArgs.length > 0) {
    warn(
      "remote-claw: --rc-driver=opencode attaches a companion only; remove forwarded arguments\n",
    );
    return 2;
  }
  const runtime = opts.runtime ?? { platform: process.platform, arch: process.arch };
  if (runtime.platform !== "linux" || runtime.arch !== "arm64") {
    warn("remote-claw: --rc-driver=opencode requires the supported Linux arm64 release tuple\n");
    return 2;
  }

  const configuredUrl =
    (typeof rc["rc-oc-url"] === "string" ? rc["rc-oc-url"] : undefined) ??
    process.env.OPENCODE_URL ??
    DEFAULT_OPENCODE_URL;
  let baseUrl: string;
  try {
    baseUrl = normalizeOpencodeBaseUrl(configuredUrl);
  } catch {
    warn(
      "remote-claw: --rc-oc-url / OPENCODE_URL must be an explicit-port HTTP origin on 127.0.0.1 or [::1], with no credentials, path, query, or fragment\n",
    );
    return 2;
  }

  const supportedModel = `${DEFAULT_OPENCODE_MODEL.providerID}/${DEFAULT_OPENCODE_MODEL.modelID}`;
  const modelStr =
    (typeof rc["rc-oc-model"] === "string" ? rc["rc-oc-model"] : undefined) ??
    process.env.RC_OC_MODEL ??
    supportedModel;
  if (modelStr !== supportedModel) {
    warn(`remote-claw: --rc-oc-model / RC_OC_MODEL must be exactly ${supportedModel}\n`);
    return 2;
  }

  const ocSessionId =
    (typeof rc["rc-oc-session"] === "string" ? rc["rc-oc-session"] : undefined) ??
    process.env.RC_OC_SESSION;
  if (!isOpencodeSessionId(ocSessionId)) {
    warn(
      "remote-claw: --rc-oc-session (or RC_OC_SESSION) is required and must be a canonical ses_* session id\n",
    );
    return 2;
  }

  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  // Presence, including an intentionally empty value, is meaningful. Never trim or interpolate this
  // credential into diagnostics.
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const mirrorPermissions =
    rc["rc-oc-mirror-permissions"] === true || process.env.RC_OC_MIRROR_PERMISSIONS === "1";

  try {
    const ctx = await createDriverContext({
      brokerUrl,
      ...(protectionBypass !== undefined ? { protectionBypass } : {}),
      rc,
      harnessArgs: claudeArgs,
      tracerTarget: "rc.opencode",
      extra: {
        baseUrl,
        model: DEFAULT_OPENCODE_MODEL,
        username,
        ...(password !== undefined ? { password } : {}),
        sessionId: ocSessionId,
        // Default is no native permission mutation; this is an explicit experimental positive opt-in.
        mirrorPermissions,
      },
    });

    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
    try {
      return await (opts.runOpencodeDriver ?? runOpencodeDriver)(ctx, ac.signal);
    } finally {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    }
  } catch (e) {
    warn(`remote-claw: could not start opencode driver: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}

/**
 * Attach one encrypted projection to an exact, caller-owned Codex app-server thread. The companion
 * owns neither the app-server nor the native thread, so teardown closes only the projection.
 */
async function runCodexDriverPath(
  brokerUrl: string,
  protectionBypass: string | undefined,
  rc: Record<string, unknown>,
  claudeArgs: string[],
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  if (claudeArgs.length > 0) {
    warn("remote-claw: --rc-driver=codex attaches a companion only; remove forwarded arguments\n");
    return 2;
  }

  const runtime = opts.runtime ?? { platform: process.platform, arch: process.arch };
  if (runtime.platform !== "linux" || runtime.arch !== "arm64") {
    warn("remote-claw: --rc-driver=codex requires the supported Linux arm64 release tuple\n");
    return 2;
  }

  const configuredUrl =
    (typeof rc["rc-codex-url"] === "string" ? rc["rc-codex-url"] : undefined) ??
    process.env.RC_CODEX_URL ??
    DEFAULT_CODEX_APP_SERVER_URL;
  let url: string;
  try {
    url = normalizeCodexAppServerUrl(configuredUrl);
  } catch {
    warn(
      "remote-claw: --rc-codex-url / RC_CODEX_URL must be literal unix:// for Codex's same-user managed control socket, or an explicit-port ws origin on 127.0.0.1 or [::1], with no credentials, path, query, or fragment; arbitrary Unix paths are not accepted\n",
    );
    return 2;
  }

  const threadId =
    (typeof rc["rc-codex-thread"] === "string" ? rc["rc-codex-thread"] : undefined) ??
    process.env.RC_CODEX_THREAD;
  if (!isCodexThreadId(threadId)) {
    warn(
      "remote-claw: --rc-codex-thread (or RC_CODEX_THREAD) is required and must be a canonical Codex UUIDv7\n",
    );
    return 2;
  }

  try {
    const ctx = await createDriverContext({
      brokerUrl,
      ...(protectionBypass !== undefined ? { protectionBypass } : {}),
      rc,
      harnessArgs: [],
      tracerTarget: "rc.codex",
    });
    const ac = new AbortController();
    const onSignal = () => ac.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      return await (opts.runCodexDriver ?? runCodexDriver)(ctx, ac.signal, {
        url,
        threadId,
        runtime,
      });
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } catch {
    warn("remote-claw: could not start Codex companion\n");
    return 1;
  }
}

/**
 * Track B: resolve the identity and drive a PLAIN claude in a tmux pane bridged to the broker — no
 * MITM, no certs (provider-agnostic, Bedrock-capable). Builds the same DriverContext shape as the
 * launch path (identity / brokerUrl / backend / newClient with the Vercel bypass / title / cwd / git),
 * minus the MITM-only certsDir, and runs runTmuxDriver under a SIGINT/SIGTERM-coupled AbortController
 * (the tmux pane runs detached, so Ctrl-C tears the bridge down and requests pane termination; uncertain
 * termination retains the private runtime for recovery).
 */
async function runTmuxDriverPath(
  brokerUrl: string,
  protectionBypass: string | undefined,
  rc: Record<string, unknown>,
  claudeArgs: string[],
  bin: string,
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  try {
    const ctx = await createDriverContext({
      brokerUrl,
      ...(protectionBypass !== undefined ? { protectionBypass } : {}),
      rc,
      harnessArgs: claudeArgs,
      harnessBin: bin,
      tracerTarget: "rc.tmux",
    });
    // The driver always uses a private SessionStart hook for startup readiness. This flag controls
    // only continued transcript/rotation following after that barrier.
    const injectSessionHook = resolveInjectSessionHook({
      noFlag: rc["rc-no-session-hook"] === true,
      yesFlag: rc["rc-session-hook"] === true,
      env: process.env.RC_SESSION_HOOK,
    });
    const mirrorPermissions = resolveMirrorPermissions({
      skipFlag: rc["rc-tmux-skip-permissions"] === true,
      env: process.env.RC_TMUX_SKIP_PERMISSIONS,
    });
    // Couple Ctrl-C / SIGTERM to the driver's abort so teardown (flush + kill-session) runs. Record
    // which signal fired so we return the shell-standard 128+N code (codex review #9) instead of 0.
    const ac = new AbortController();
    let firedSignal: NodeJS.Signals | null = null;
    const onSignal = (sig: NodeJS.Signals) => {
      firedSignal = sig;
      ac.abort();
    };
    const onInt = () => onSignal("SIGINT");
    const onTerm = () => onSignal("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    try {
      const code = await (opts.runTmuxDriver ?? runTmuxDriver)(ctx, ac.signal, {
        injectSessionHook,
        mirrorPermissions,
      });
      return firedSignal !== null ? signalExitCode(firedSignal) : code;
    } finally {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
  } catch (e) {
    warn(`remote-claw: could not start remote control: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}
