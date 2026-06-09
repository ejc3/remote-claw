// The wrapper's RC launch path (§3.1). When you run `remote-claw` like `claude`, this stands up the
// local MITM and spawns the REAL `claude` with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` pointed at it —
// so the moment you hit `/remote-control` inside claude, its RC connection lands on OUR relay (not
// Anthropic's), and we bridge that session E2E-encrypted to the broker. Until then the MITM is
// transparent (it passes `/v1/messages` + OAuth through), so a session that never enables RC sends
// nothing to the broker (lazy registration). One RelayCore owns every RC session the child opens.

import type { Identity } from "@remote-claw/clawsec";
import { BrokerClient } from "../../broker/client.js";
import { securityProvider } from "../../security/provider.js";
import { ensureCerts } from "./certs.js";
import { MitmProxy } from "./mitm.js";
import { HostRcRelay } from "./relay.js";
import { RelayCore, type Session } from "./session.js";

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
  /** Directory holding the MITM CA + leaf (generated if absent). */
  certsDir: string;
  /** The claude binary (default "claude"). */
  claudeBin?: string;
  /** Launch the child (default: real child process with inherited stdio + the proxy env). */
  spawnClaude: SpawnClaudeEnv;
  /** A short title for the session announce (default: hostname-ish label). */
  title?: string;
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

  const newClient = () =>
    new BrokerClient({
      baseUrl: opts.brokerUrl,
      provider,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });

  const proxy = new MitmProxy({
    port: 0,
    leafCert: certs.leafPem,
    leafKey: certs.leafKey,
    core,
    onSession: (s) => {
      opts.onSession?.(s);
      // Each RC session the child opens gets its own relay: announce presence on the bus, then bridge
      // its turns to the broker until the wrapper exits.
      const relay = new HostRcRelay({
        client: newClient(),
        identityId: opts.identity.identityId,
        sessionId: s.id,
        session: s,
      });
      void relay.announce(title).catch(() => {});
      void relay.serve(ac.signal).catch(() => {});
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

  try {
    return await opts.spawnClaude(opts.claudeBin ?? "claude", opts.claudeArgs, env);
  } finally {
    ac.abort();
    core.closeAll();
    await proxy.close();
  }
}
