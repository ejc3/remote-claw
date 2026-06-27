// The wrapper's RC launch path (§3.1). When you run `remote-claw` like `claude`, this stands up the
// local MITM and spawns the REAL `claude` with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` pointed at it —
// so the moment you hit `/remote-control` inside claude, its RC connection lands on OUR relay (not
// Anthropic's), and we bridge that session E2E-encrypted to the broker. Until then the MITM is
// transparent (it passes `/v1/messages` + OAuth through), so a session that never enables RC sends
// nothing to the broker (lazy registration). One RelayCore owns every RC session the child opens.

import type { Identity } from "@remote-claw/clawsec";
import { BrokerClient } from "../../broker/client.js";
import { securityProvider } from "../../security/provider.js";
import { tracerFromEnv } from "../../trace.js";
import type { BedrockConfig } from "./bedrock/inference.js";
import { ensureCerts } from "./certs.js";
import { bridgeSession } from "./drivers/bridge.js";
import { type GitInfo, gitInfo } from "./gitinfo.js";
import { MitmProxy } from "./mitm.js";
import { RelayCore, type Session } from "./session.js";

const RELAY_TEARDOWN_WAIT_MS = 2000;

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
}

/**
 * Run the wrapper: MITM up, child claude spawned behind it, every RC session it opens bridged to the
 * broker. Resolves with claude's exit code; tears the MITM + relays down on exit.
 */
export async function runRcLaunch(opts: RcLaunchOptions): Promise<number> {
  const provider = securityProvider("sealed", opts.identity);
  const certs = ensureCerts(opts.certsDir);
  const core = new RelayCore();
  const ac = new AbortController();
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

  const proxy = new MitmProxy({
    port: 0,
    leafCert: certs.leafPem,
    leafKey: certs.leafKey,
    core,
    tracer: mitmTracer,
    ...(opts.inference !== undefined ? { inference: opts.inference } : {}),
    ...(opts.bedrock !== undefined ? { bedrock: opts.bedrock } : {}),
    onSession: (s) => {
      opts.onSession?.(s);
      // Each RC session the child opens gets its own relay, bridged to the broker until the wrapper
      // exits. The wiring (announce-now-then-serve — announce must NOT wait on serve()'s durable-cursor
      // prepare, which would race a viewer's concurrent bus subscribe — tracked in `relays` for the
      // teardown flush) is shared with every other driver via bridgeSession: the seam keeps the
      // relay/broker contract identical across harnesses (mitm/tmux/opencode).
      bridgeSession({
        session: s,
        newClient,
        identityId: opts.identity.identityId,
        title,
        cwd,
        git,
        signal: ac.signal,
        relays,
        tracer: relayTracer,
      });
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
    env.ANTHROPIC_API_KEY = "sk-ant-remote-claw-bedrock-no-account-needed";
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

  try {
    return await opts.spawnClaude(opts.claudeBin ?? "claude", opts.claudeArgs, env);
  } finally {
    ac.abort();
    await waitForRelays(relays);
    await proxy.close();
  }
}

async function waitForRelays(relays: Set<Promise<void>>): Promise<void> {
  const pending = [...relays];
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RELAY_TEARDOWN_WAIT_MS);
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  });
  try {
    await Promise.race([Promise.allSettled(pending), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
