// The wrapper's RC launch path (§3.1). When you run `remote-claw` like `claude`, this stands up the
// local MITM and spawns the REAL `claude` with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` pointed at it —
// so the moment you hit `/remote-control` inside claude, its RC connection lands on OUR relay (not
// Anthropic's), and we bridge that session E2E-encrypted to the broker. Until then the MITM is
// transparent (it passes `/v1/messages` + OAuth through), so a session that never enables RC sends
// nothing to the broker (lazy registration). One RelayCore owns every RC session the child opens.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "@remote-claw/clawsec";
import { BrokerClient } from "../../broker/client.js";
import { securityProvider } from "../../security/provider.js";
import { tracerFromEnv } from "../../trace.js";
import type { NativeConversationCapabilities } from "../native/index.js";
import { PRETEND_API_KEY, seedAccountlessConfigDir } from "./accountless.js";
import type { BedrockConfig } from "./bedrock/inference.js";
import { ensureCerts } from "./certs.js";
import { acquireStableClaudeExecutable } from "./compatibility.js";
import { MITM_HARNESS, STABLE_MITM_CAPABILITIES } from "./driver.js";
import {
  type LegacyRcConversationMetadata,
  LegacyRcConversationRegistrar,
} from "./drivers/legacy-registrar.js";
import { type GitInfo, gitInfo } from "./gitinfo.js";
import { MitmProxy } from "./mitm.js";
import { RelayCore, type Session } from "./session.js";

// Unrelated stuck registration/live-announce cleanup is time-boxed. The terminal safety policy is
// tracked and awaited separately: JS timers are minimum delays, so no wall-clock cutoff may overtake its
// remaining retries after an OS suspend or event-loop stall.
const RELAY_TEARDOWN_WAIT_MS = 2_000;
const CLAUDE_NATIVE_CAPABILITIES: NativeConversationCapabilities = {
  version: 1,
  mutationAdmission: "mixed",
  history: "none",
  deliveryEvidence: "structured_receipt",
  liveReattach: false,
};

/** How the child claude is launched with the proxy env (injectable for tests). */
export type SpawnClaudeEnv = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<number>;

export interface RcLaunchOptions {
  /** Args forwarded verbatim to claude. */
  claudeArgs: string[];
  /** This machine's identity (derived from its secret) — its bus + session keys. */
  identity: Identity;
  /** The broker origin (`--rc-app` / RC_APP). Its `/api` is the relay broker. */
  brokerUrl: string;
  /** Which broker backend to target (`--rc-backend` / RC_BACKEND), sent as the x-broker-backend header.
   *  Omitted ⇒ the broker's default. The server reports whether the effective backend is durable, which
   *  lets the host retire its #log/catch_up replay. Must match what viewers subscribe with. */
  backend?: string;
  /** Directory holding the MITM CA + leaf (generated if absent). */
  certsDir: string;
  /** The claude binary (default "claude"). */
  claudeBin?: string;
  /** Injectable only for deterministic boundary tests. Direct production callers instead open and
   * retain one executable inode, then probe it before certificates, listeners, git probes, or spawn. */
  claudeCompatibilityCheck?: (claudeBin: string) => Promise<void>;
  /** Launch the child (default: real child process with inherited stdio + the proxy env). */
  spawnClaude: SpawnClaudeEnv;
  /** A short title for the session announce (default: hostname-ish label). */
  title?: string;
  /** The session's working dir, snapshotted for the announce's cwd + git chip (default process.cwd()). */
  cwd?: string;
  /** Custom fetch for the broker client (tests). */
  fetchFn?: typeof fetch;
  /** Notified when a session registers (tests/observability). */
  onSession?: (s: Session) => void;
  /** Where inference goes: "anthropic" (default — pass `/v1/messages` through to the real upstream) or
   *  "bedrock" (translate to Amazon Bedrock + synthesize the rest of the Anthropic control plane, so the
   *  child reaches NO real api.anthropic.com). */
  inference?: "anthropic" | "bedrock";
  /** Bedrock config (region/model/auth), used only when `inference==="bedrock"`. */
  bedrock?: BedrockConfig;
  /** Accountless native RC: seed an ISOLATED CLAUDE_CONFIG_DIR with a synthetic claude.ai login + the RC
   *  feature gates so native `/remote-control` works with NO real login. Pairs with `inference:"bedrock"`
   *  (a fake token can't reach real Anthropic). The user's real `~/.claude.json` is never touched. */
  accountless?: boolean;
}

/**
 * Run the wrapper: MITM up, child claude spawned behind it, every RC session it opens bridged to the
 * broker. Resolves with claude's exit code; tears the MITM + relays down on exit.
 */
export async function runRcLaunch(opts: RcLaunchOptions): Promise<number> {
  const requestedClaudeBin = opts.claudeBin ?? "claude";
  // The production boundary retains the exact executable inode from compatibility probe through child
  // exit. Deterministic tests may inject the documented check seam and keep their synthetic command.
  const executable =
    opts.claudeCompatibilityCheck === undefined
      ? await acquireStableClaudeExecutable(requestedClaudeBin)
      : await opts.claudeCompatibilityCheck(requestedClaudeBin).then(() => ({
          claudeBin: requestedClaudeBin,
          release() {},
        }));
  try {
    return await runRcLaunchWithExecutable(opts, executable.claudeBin);
  } finally {
    executable.release();
  }
}

async function runRcLaunchWithExecutable(
  opts: RcLaunchOptions,
  claudeBin: string,
): Promise<number> {
  // Enforce the accountless⇒bedrock invariant at the library boundary, not just in the CLI arg layer:
  // runRcLaunch is exported, so a programmatic caller could otherwise seed a fabricated claude.ai login
  // while the MITM stays in Anthropic passthrough — leaking that fake account state toward real
  // api.anthropic.com (and breaking the zero-Anthropic contract). Fail fast, before any setup.
  if (opts.accountless && opts.inference !== "bedrock") {
    throw new Error(
      "runRcLaunch: accountless requires inference:'bedrock' (a fabricated login can't reach real Anthropic)",
    );
  }
  const provider = securityProvider("sealed", opts.identity);
  const certs = ensureCerts(opts.certsDir);
  const core = new RelayCore();
  const title = opts.title ?? "remote-claw";
  // Snapshot the session's working dir + git state ONCE at launch for the announce (cwd + #49 chip).
  // Bounded and non-throwing — outside a repo / without git it's just null and no chip shows. Gathered
  // before listen() so it's ready well before the child enables RC and onSession can fire.
  const cwd = opts.cwd ?? process.cwd();
  const git: GitInfo | null = await gitInfo(cwd);
  // Wire diagnostics: quiet by default, opt in with RC_LOG (e.g. RC_LOG=debug). The relay binds the
  // session id per relay; both share the env-configured sink (stderr, or RC_LOG_FILE for capture).
  const mitmTracer = tracerFromEnv("rc.mitm");
  const relayTracer = tracerFromEnv("rc.relay");
  const relays = new Set<Promise<void>>();
  const terminalTasks = new Set<Promise<void>>();
  const registrations = new Set<Promise<void>>();
  let tearingDown = false;

  // If the broker is deployed behind Vercel Deployment Protection (SSO), the host's requests need the
  // automation-bypass secret to get past the edge. Read it from the env on this host; an unprotected
  // broker (local dev) leaves it unset and sends no header.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const newClient = () =>
    new BrokerClient({
      baseUrl: opts.brokerUrl,
      provider,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(bypass ? { protectionBypass: bypass } : {}),
      ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    });

  // One host-scoped registrar owns the lifecycle of every intercepted conversation. A Session remains
  // the native port used by today's relay, but neither its synthetic cse_* id nor any other RC transport
  // value is promoted into the host binding/native identity.
  const registrar = new LegacyRcConversationRegistrar({
    newClient,
    identityId: opts.identity.identityId,
    relays,
    terminalTasks,
    tracer: relayTracer,
  });
  const registerSession = async (session: Session): Promise<void> => {
    const metadata: LegacyRcConversationMetadata = {
      title,
      cwd,
      git,
      capabilities: STABLE_MITM_CAPABILITIES,
      harness: MITM_HARNESS,
    };
    let lease: Awaited<ReturnType<LegacyRcConversationRegistrar["open"]>> | undefined;
    try {
      lease = await registrar.open({
        bindingId: null,
        registrationAttemptId: randomUUID(),
        descriptor: { product: "claude-code", access: "native-rc" },
        project: null,
        nativeRef: null,
        phase: "starting",
        capabilities: null,
        port: session,
        metadata,
      });
      if (tearingDown) {
        await lease.close("host teardown");
        return;
      }
      await lease.update(metadata, CLAUDE_NATIVE_CAPABILITIES);
      if (tearingDown) {
        await lease.close("host teardown");
        return;
      }
      await lease.setPhase("ready");
    } catch (error) {
      if (lease !== undefined) {
        await lease.close("registration failed").catch((closeError: unknown) => {
          relayTracer.error("native conversation lease close failed", {
            error: String(closeError),
          });
        });
      }
      throw error;
    }
  };
  const closeRegistrarLeases = async (deadlineMs: number): Promise<void> => {
    const closing = registrar.closeAll("host teardown").catch((error: unknown) => {
      relayTracer.error("native conversation registrar teardown failed", {
        error: String(error),
      });
    });
    // An unresponsive broker post must not keep the wrapper alive forever after the child exits. Every
    // teardown stage shares one deadline so the same stalled announce cannot consume a fresh grace
    // period in closeAll(), registration cleanup, and the final relay wait.
    await waitForTasks([closing], deadlineMs);
  };

  const proxy = new MitmProxy({
    port: 0,
    leafCert: certs.leafPem,
    leafKey: certs.leafKey,
    core,
    tracer: mitmTracer,
    ...(opts.inference !== undefined ? { inference: opts.inference } : {}),
    ...(opts.bedrock !== undefined ? { bedrock: opts.bedrock } : {}),
    onSession: (s) => {
      // Preserve the existing observability timing: callers see the Session synchronously at MITM
      // registration, before the asynchronous host registration begins.
      opts.onSession?.(s);
      const registration = registerSession(s).catch((error: unknown) => {
        // A half-registered Session must not keep accepting native or viewer work. Closing the legacy
        // Session is the fail-closed error path only; ordinary lease teardown never owns the native port.
        relayTracer.error("native conversation registration failed", {
          error: String(error),
        });
        s.close();
      });
      registrations.add(registration);
      void registration.finally(() => registrations.delete(registration));
    },
  });
  await proxy.listen();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    // Some stacks read the lowercase form; set both so the child's HTTPS reliably routes through us.
    https_proxy: `http://127.0.0.1:${proxy.port}`,
    NODE_EXTRA_CA_CERTS: certs.caPem,
  };
  // A pre-existing NO_PROXY (e.g. "api.anthropic.com" or "*") would make a proxy-aware HTTP stack
  // BYPASS our MITM despite HTTPS_PROXY — so `/remote-control` would never reach the local backend.
  // Clear both forms for the child; our proxy itself passes inference/OAuth straight through anyway.
  delete env.NO_PROXY;
  delete env.no_proxy;
  // Defense-in-depth: the child claude is our payload, not our confidant. Strip host-only secrets it
  // never needs so a compromised claude / hostile MCP can't read the host secret-file pointer or reuse
  // the broker's deployment-protection bypass. The wrapper holds these; the child speaks only to our
  // local MITM (which injects the bypass itself when it loops back to the broker).
  delete env.REMOTE_CLAW_SECRET_FILE;
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  // Scrub the LAUNCHING claude's session identity so OUR spawned `claude` is a fresh, independent,
  // top-level session — not a child/continuation of whatever ran the wrapper. When remote-claw is
  // started from INSIDE a claude session (a terminal already in claude, or claude itself spawning it),
  // these leak in via `...process.env`:
  //   • CLAUDE_CODE_CHILD_SESSION — makes the child a STUB that bridges to the parent instead of running
  //     as a real claude (so the MITM would drive a stub, never a real session — verified: a wrapper
  //     launched under Claude Code spawned a child bridged to the harness's own session).
  //   • CLAUDE_CODE_SESSION_ID — pins/resumes the parent's session id instead of minting a new cse_.
  // Outside a claude session these are unset, so deleting them is a no-op. The child mints its own
  // session id when it enables /remote-control.
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;

  if (opts.inference === "bedrock") {
    // The child must run as a normal FIRST-PARTY Anthropic claude so /remote-control stays enabled —
    // CLAUDE_CODE_USE_BEDROCK would put it in Bedrock-transport mode, which DISABLES RC. We never set it.
    // The MITM validates nothing and serves ALL inference from Bedrock, so the child needs no real
    // Anthropic credential — and in zero-Anthropic mode it must not HOLD one: a hostile MCP that dodged
    // the proxy could otherwise make a direct, authenticated api.anthropic.com call. So unconditionally
    // replace any real key with a pretend one and drop the bearer token form. (A login in ~/.claude is
    // moot — the MITM synthesizes the OAuth/refresh endpoints, so it can't reach the real upstream.)
    // Same constant the accountless seed lists under customApiKeyResponses.rejected — keep them in sync
    // (a mismatch would leave claude in API-key mode, disabling RC), so import it rather than re-type it.
    env.ANTHROPIC_API_KEY = PRETEND_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Drop ANTHROPIC_BASE_URL so the child resolves to api.anthropic.com (the host OUR MITM intercepts).
    // Left set (from the launching env), it would point claude's first-party calls at some OTHER host —
    // which the MITM doesn't intercept, so they'd blind-tunnel straight past Bedrock AND past the
    // zero-Anthropic guarantee. The MITM is the only endpoint the child should ever reach.
    delete env.ANTHROPIC_BASE_URL;
    // Scrub EVERY AWS_* var so the child can't reach ANY host credential source — not just static keys
    // (AWS_ACCESS_KEY_ID/…), but the container + web-identity channels the AWS SDK chain also honors
    // (AWS_CONTAINER_CREDENTIALS_*, AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN, AWS_PROFILE, …). On
    // ECS/EKS those ARE the host's live role-creds path, so deleting only static keys would be a no-op
    // and let a hostile MCP mint the host's role. The wrapper signs Bedrock itself; the child needs none.
    for (const k of Object.keys(env)) {
      if (k.startsWith("AWS_")) delete env[k];
    }
    // The scrub above also DELETED any inherited AWS_EC2_METADATA_DISABLED, which would re-open IMDS to
    // the child. Set it back so a child AWS SDK can't fetch the host's EC2 instance role from
    // 169.254.169.254 (the static-key/container scrub alone wouldn't stop the IMDS channel).
    env.AWS_EC2_METADATA_DISABLED = "true";
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
  }

  // Accountless temp dir, declared here so the finally always cleans it. mkdir + seed happen INSIDE the
  // try so that even if they throw, the proxy/relays still tear down (they're already listening).
  let accountlessDir: string | undefined;
  try {
    if (opts.accountless) {
      // Seed an ISOLATED config dir with a synthetic claude.ai login + the RC feature gates and point the
      // child at it via CLAUDE_CONFIG_DIR — so native /remote-control works with no real login, without
      // ever touching the user's real ~/.claude.json. Removed on teardown (the identity is ephemeral).
      // Assign the dir BEFORE seeding so a seed failure still leaves it for the finally to remove.
      accountlessDir = mkdtempSync(join(tmpdir(), "rc-accountless-"));
      seedAccountlessConfigDir(accountlessDir, Date.now(), cwd);
      env.CLAUDE_CONFIG_DIR = accountlessDir;
    }
    return await opts.spawnClaude(claudeBin, opts.claudeArgs, env);
  } finally {
    tearingDown = true;
    const teardownDeadlineMs = Date.now() + RELAY_TEARDOWN_WAIT_MS;
    await closeRegistrarLeases(teardownDeadlineMs);
    await waitForTasks(registrations, teardownDeadlineMs);
    // Catch a lease whose open raced the first closeAll snapshot. The registration path also observes
    // tearingDown and closes it, so this second pass is idempotent. Always initiate the second close
    // even if the shared wait budget is already exhausted.
    await closeRegistrarLeases(teardownDeadlineMs);
    await waitForTasks(relays, teardownDeadlineMs);
    // Do not apply the unrelated-work wall-clock cutoff here. Each terminal task has its own per-attempt
    // Promise.race bound, but a suspended event loop cannot schedule retries until it resumes. Await the
    // policy itself so process.exit never wins merely because both timers became due during suspension.
    await settleTasks(terminalTasks);
    await proxy.close();
    // force:true already swallows ENOENT; guard the rest so a cleanup error can't mask the real result.
    if (accountlessDir !== undefined) {
      try {
        rmSync(accountlessDir, { recursive: true, force: true });
      } catch {
        /* best-effort: a leftover throwaway dir in tmpdir is harmless (creds are fake) */
      }
    }
  }
}

async function waitForTasks(tasks: Iterable<Promise<void>>, deadlineMs: number): Promise<void> {
  const pending = [...tasks];
  if (pending.length === 0) return;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, remainingMs);
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  });
  try {
    await Promise.race([Promise.allSettled(pending), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleTasks(tasks: Set<Promise<void>>): Promise<void> {
  for (;;) {
    const pending = [...tasks];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}
