// The transparent-wrapper runner. For this P2 skeleton it classifies argv and either forwards
// to `claude` (the common path) or reports a parse error. The `--rc-*` actions (identity,
// share, …) are wired in later PRs; here a recognized rc flag is reported as not-yet-
// implemented so the namespace never silently leaks into claude.

import { spawn as nodeSpawn } from "node:child_process";
import { writeSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { deriveIdentity, toHex } from "@remote-claw/clawsec";
import { classifyArgs } from "./args.js";
import { BrokerClient } from "./broker/client.js";
import { RC_HELP } from "./help.js";
import { parseStripKeys } from "./host/rc/bedrock/translate.js";
import type { DriverContext } from "./host/rc/driver.js";
import { gitInfo } from "./host/rc/gitinfo.js";
import { runRcLaunch, type SpawnClaudeEnv } from "./host/rc/launch.js";
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
 *  `warn`. Allowlist-gated to KNOWN drivers (mitm | tmux | opencode) so an UNKNOWN driver gets only its
 *  own "unknown --rc-driver" error, not a second misapplied-flag nag. A reserved VALUE flag counts as
 *  "passed" only when it carries a non-empty (trimmed) value — an empty/blank value is absent everywhere.
 *  Each group names the driver it DOES apply to:
 *    • tmux: --rc-session-hook / --rc-no-session-hook (ongoing transcript/rotation follow only) /
 *      --rc-tmux-skip-permissions
 *    • opencode: --rc-oc-url / --rc-oc-model / --rc-oc-session / --rc-oc-skip-permissions
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
  if (driver === "mitm" || driver === "opencode") {
    emit(
      [
        ...(rc["rc-session-hook"] === true ? ["--rc-session-hook"] : []),
        ...(rc["rc-no-session-hook"] === true ? ["--rc-no-session-hook"] : []),
        ...(rc["rc-tmux-skip-permissions"] === true ? ["--rc-tmux-skip-permissions"] : []),
      ],
      "tmux",
    );
  }
  if (driver === "mitm" || driver === "tmux") {
    emit(
      [
        ...(rc["rc-oc-skip-permissions"] === true ? ["--rc-oc-skip-permissions"] : []),
        ...(has("rc-oc-url") ? ["--rc-oc-url"] : []),
        ...(has("rc-oc-model") ? ["--rc-oc-model"] : []),
        ...(has("rc-oc-session") ? ["--rc-oc-session"] : []),
      ],
      "opencode",
    );
  }
  if (driver === "tmux" || driver === "opencode") {
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
  return out;
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
  /** Injectable OpenCode driver boundary (tests). */
  runOpencodeDriver?: typeof runOpencodeDriver;
  /** Injectable tmux driver boundary (tests). */
  runTmuxDriver?: typeof runTmuxDriver;
  /**
   * Production-only bridge to the independently supervised runtime owner. Library callers and tests
   * may omit it; an unavailable owner preserves the existing A0 driver path without advertising A1.
   */
  runtimeOwnerBootstrap?: RuntimeOwnerBootstrap;
}

export interface RuntimeOwnerBootstrapInput {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
  readonly secretPath: string;
}

export interface RuntimeOwnerCollaborator {
  close(): void | Promise<void>;
}

export type RuntimeOwnerBootstrap = (
  input: RuntimeOwnerBootstrapInput,
) => Promise<RuntimeOwnerCollaborator | null>;

async function bootstrapRuntimeOwnerForDriver(
  opts: RunOptions,
  input: RuntimeOwnerBootstrapInput,
): Promise<RuntimeOwnerCollaborator | null> {
  if (opts.runtimeOwnerBootstrap === undefined) return null;
  try {
    const collaborator = await opts.runtimeOwnerBootstrap(input);
    return collaborator !== null && typeof collaborator.close === "function" ? collaborator : null;
  } catch {
    // A1.3 activation is deliberately fail-soft for the still-A0 driver paths. No A1 capability is
    // advertised, and native/broker behavior stays exactly as it was before the owner was available.
    return null;
  }
}

async function closeRuntimeOwnerCollaborator(collaborator: RuntimeOwnerCollaborator | null) {
  try {
    await collaborator?.close();
  } catch {
    // Disconnect means detach only. It must not replace the driver's exit result or terminate a runtime.
  }
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
  const stray = rcNames.filter(
    (n) =>
      n !== "rc-file" &&
      n !== "rc-app" &&
      n !== "rc-backend" &&
      n !== "rc-driver" &&
      n !== "rc-inference" &&
      n !== "rc-bedrock-region" &&
      n !== "rc-bedrock-model" &&
      n !== "rc-oc-url" &&
      n !== "rc-oc-model" &&
      n !== "rc-oc-session" &&
      n !== "rc-oc-skip-permissions" &&
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

  // Remote control needs a broker to relay to (`--rc-app` / RC_APP). With one configured, launch the
  // selected capture/inject driver and wire its sessions into the broker (§3.1). Without one, there's
  // nothing to relay to — run claude transparently (identical to plain `claude`). A bare `--help`
  // short-circuits the launch: never create an identity or start a driver just to print claude's help —
  // fall through to a plain spawn.
  const rcApp = (typeof rc["rc-app"] === "string" ? rc["rc-app"] : "") || process.env.RC_APP || "";
  if (rcApp !== "" && !helpWanted) {
    // Which capture/inject driver runs the harness: --rc-driver / RC_DRIVER, default "mitm" (the real
    // claude behind our MITM). tmux runs a PLAIN claude in a tmux pane and bridges via the transcript
    // (provider-agnostic, Bedrock-capable — no MITM); opencode peer-attaches to an opencode server. All
    // three bridge to the SAME broker via the pluggable seam (driver.ts).
    const driver = (
      (typeof rc["rc-driver"] === "string" ? rc["rc-driver"] : "").trim() ||
      (process.env.RC_DRIVER ?? "").trim() ||
      "mitm"
    ).toLowerCase();
    // Warn (don't fail) when a flag that belongs to a DIFFERENT known driver was explicitly passed, so a
    // silent no-op (e.g. `--rc-driver=tmux --rc-inference=bedrock`, which is NOT zero-api.anthropic.com)
    // becomes visible. Pure + allowlist-gated (an unknown driver gets only its own error below).
    for (const line of misappliedDriverFlagWarnings(driver, rc)) warn(line);
    if (driver === "mitm") {
      return runRcLaunchPath(rcApp, rc, claudeArgs, bin, opts, warn);
    }
    if (driver === "opencode") {
      return runOpencodeDriverPath(rcApp, rc, claudeArgs, opts, warn);
    }
    if (driver === "tmux") {
      return runTmuxDriverPath(rcApp, rc, claudeArgs, bin, opts, warn);
    }
    warn(`remote-claw: unknown --rc-driver=${driver} (expected mitm | tmux | opencode)\n`);
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
    await ensureIdentity(secretPath); // local, idempotent — create on first run, no network
    const { identity, runtimeOwner } = await withClearedRootSecret(secretPath, async (secret) => {
      const identity = await deriveIdentity(secret);
      const runtimeOwner = await bootstrapRuntimeOwnerForDriver(opts, {
        machineIdentityId: toHex(identity.identityId),
        identitySecret: secret,
        secretPath,
      });
      return { identity, runtimeOwner };
    });
    try {
      return await runRcLaunch({
        claudeArgs,
        identity,
        brokerUrl,
        certsDir: join(dirname(secretPath), "mitm-certs"),
        claudeBin: bin,
        spawnClaude: opts.spawnRcEnv ?? realSpawnEnv,
        ...(backend !== undefined ? { backend } : {}),
        inference,
        ...(bedrock !== undefined ? { bedrock } : {}),
        ...(accountless ? { accountless: true } : {}),
      });
    } finally {
      await closeRuntimeOwnerCollaborator(runtimeOwner);
    }
  } catch (e) {
    warn(`remote-claw: could not start remote control: ${(e as Error)?.message ?? e}\n`);
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
  rc: Record<string, unknown>,
  claudeArgs: string[],
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  const secretPath = resolveSecretPath({
    ...(typeof rc["rc-file"] === "string" ? { file: rc["rc-file"] } : {}),
  }).path;
  const backend =
    (typeof rc["rc-backend"] === "string" ? rc["rc-backend"] : "").trim() ||
    (process.env.RC_BACKEND ?? "").trim() ||
    undefined;
  // OpenCode server origin (--rc-oc-url, else OPENCODE_URL, else the default loopback). The model is
  // "providerID/modelID" (--rc-oc-model, else RC_OC_MODEL, else the bedrock-sonnet default — a reliable
  // tool-caller via the region-agnostic `global.` profile; the opencode server supplies AWS creds).
  const baseUrl =
    (typeof rc["rc-oc-url"] === "string" ? rc["rc-oc-url"] : "").trim() ||
    (process.env.OPENCODE_URL ?? "").trim() ||
    undefined;
  const modelStr =
    (typeof rc["rc-oc-model"] === "string" ? rc["rc-oc-model"] : "").trim() ||
    (process.env.RC_OC_MODEL ?? "").trim();
  const slash = modelStr.indexOf("/");
  const model =
    slash > 0
      ? { providerID: modelStr.slice(0, slash), modelID: modelStr.slice(slash + 1) }
      : DEFAULT_OPENCODE_MODEL;
  const password = (process.env.OPENCODE_SERVER_PASSWORD ?? "").trim() || undefined;
  // Which OpenCode session to attach to (--rc-oc-session, else RC_OC_SESSION). The driver confirms an
  // explicit canonical ID exactly. If omitted, only a valid empty discovery snapshot permits creation;
  // an existing-session list is ambiguous and fails closed.
  const ocSessionId =
    (typeof rc["rc-oc-session"] === "string" ? rc["rc-oc-session"] : "").trim() ||
    (process.env.RC_OC_SESSION ?? "").trim() ||
    undefined;

  try {
    await ensureIdentity(secretPath);
    const { ctx, runtimeOwner } = await withClearedRootSecret(secretPath, async (secret) => {
      const identity = await deriveIdentity(secret);
      const provider = securityProvider("sealed", identity);
      const cwd = process.cwd();
      const git = await gitInfo(cwd);
      const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      const newClient = () =>
        new BrokerClient({
          baseUrl: brokerUrl,
          provider,
          ...(bypass ? { protectionBypass: bypass } : {}),
          ...(backend !== undefined ? { backend } : {}),
        });
      const ctx: DriverContext = {
        harnessArgs: claudeArgs,
        identity,
        brokerUrl,
        title: "remote-claw",
        cwd,
        git,
        newClient,
        tracer: tracerFromEnv("rc.opencode"),
        extra: {
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          model,
          ...(password !== undefined ? { password } : {}),
          ...(ocSessionId !== undefined ? { sessionId: ocSessionId } : {}),
          // Permission MIRRORING (B2 parity, DEFAULT ON): add a catch-all "ask" so
          // otherwise-unconfigured tools raise a viewer gate. Opt out with
          // --rc-oc-skip-permissions / RC_OC_SKIP_PERMISSIONS truthy.
          mirrorPermissions: resolveMirrorPermissions({
            skipFlag: rc["rc-oc-skip-permissions"] === true,
            env: process.env.RC_OC_SKIP_PERMISSIONS,
          }),
        },
        ...(backend !== undefined ? { backend } : {}),
      };
      const runtimeOwner = await bootstrapRuntimeOwnerForDriver(opts, {
        machineIdentityId: toHex(identity.identityId),
        identitySecret: secret,
        secretPath,
      });
      return { ctx, runtimeOwner };
    });

    try {
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
    } finally {
      await closeRuntimeOwnerCollaborator(runtimeOwner);
    }
  } catch (e) {
    warn(`remote-claw: could not start opencode driver: ${(e as Error)?.message ?? e}\n`);
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
  rc: Record<string, unknown>,
  claudeArgs: string[],
  bin: string,
  opts: RunOptions,
  warn: (line: string) => void,
): Promise<number> {
  const secretPath = resolveSecretPath({
    ...(typeof rc["rc-file"] === "string" ? { file: rc["rc-file"] } : {}),
  }).path;
  const backend =
    (typeof rc["rc-backend"] === "string" ? rc["rc-backend"] : "").trim() ||
    (process.env.RC_BACKEND ?? "").trim() ||
    undefined;
  try {
    await ensureIdentity(secretPath); // local, idempotent — create on first run, no network
    const { ctx, injectSessionHook, mirrorPermissions, runtimeOwner } = await withClearedRootSecret(
      secretPath,
      async (secret) => {
        const identity = await deriveIdentity(secret);
        const provider = securityProvider("sealed", identity);
        // The Vercel deployment-protection bypass (SSO) for the host's own broker calls; scrubbed from
        // the child claude's env by the driver. An unprotected broker leaves it unset → no header.
        const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
        const newClient = () =>
          new BrokerClient({
            baseUrl: brokerUrl,
            provider,
            ...(bypass ? { protectionBypass: bypass } : {}),
            ...(backend !== undefined ? { backend } : {}),
          });
        const cwd = process.cwd();
        const ctx: DriverContext = {
          harnessArgs: claudeArgs,
          harnessBin: bin, // spawn the SAME binary the MITM path resolves (RC_CLAUDE_BIN-aware) — codex #6
          identity,
          brokerUrl,
          title: "remote-claw",
          cwd,
          git: await gitInfo(cwd),
          newClient,
          tracer: tracerFromEnv("rc.tmux"),
          ...(backend !== undefined ? { backend } : {}),
        };
        // Whether capture keeps following the private SessionStart marker for exact transcript
        // discovery + rotations after startup. The driver ALWAYS injects and waits for that marker once.
        const injectSessionHook = resolveInjectSessionHook({
          noFlag: rc["rc-no-session-hook"] === true,
          yesFlag: rc["rc-session-hook"] === true,
          env: process.env.RC_SESSION_HOOK,
        });
        const mirrorPermissions = resolveMirrorPermissions({
          skipFlag: rc["rc-tmux-skip-permissions"] === true,
          env: process.env.RC_TMUX_SKIP_PERMISSIONS,
        });
        const runtimeOwner = await bootstrapRuntimeOwnerForDriver(opts, {
          machineIdentityId: toHex(identity.identityId),
          identitySecret: secret,
          secretPath,
        });
        return { ctx, injectSessionHook, mirrorPermissions, runtimeOwner };
      },
    );
    // Couple Ctrl-C / SIGTERM to the driver's abort so teardown (flush + kill-session) runs. Record
    // which signal fired so we return the shell-standard 128+N code (codex review #9) instead of 0.
    try {
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
    } finally {
      await closeRuntimeOwnerCollaborator(runtimeOwner);
    }
  } catch (e) {
    warn(`remote-claw: could not start remote control: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}
