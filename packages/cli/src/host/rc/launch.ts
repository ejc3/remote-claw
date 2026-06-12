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
import { ensureCerts } from "./certs.js";
import { type GitInfo, gitInfo } from "./gitinfo.js";
import { MitmProxy } from "./mitm.js";
import { HostRcRelay } from "./relay.js";
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
    onSession: (s) => {
      opts.onSession?.(s);
      // Each RC session the child opens gets its own relay: announce presence on the bus, then bridge
      // its turns to the broker until the wrapper exits.
      const relay = new HostRcRelay({
        client: newClient(),
        identityId: opts.identity.identityId,
        sessionId: s.id,
        session: s,
        tracer: relayTracer,
      });
      void relay.announce(title, cwd, git).catch(() => {});
      const served = relay.serve(ac.signal).catch(() => {});
      relays.add(served);
      void served.finally(() => relays.delete(served));
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
