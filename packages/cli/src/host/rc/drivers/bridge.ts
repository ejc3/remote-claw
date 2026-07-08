// The shared driver→broker wiring. Every driver (mitm/tmux/opencode) produces a `Session`; this is
// the ONE place that turns a Session into a live broker bridge: construct the HostRcRelay, announce
// presence on the bus, and serve it until the launch is aborted. Keeping it here (vs copied into each
// driver) guarantees the relay/broker contract is identical across harnesses — the seam's whole point.

import type { BrokerClient } from "../../../broker/client.js";
import type { Tracer } from "../../../trace.js";
import type { DriverCapabilities, HarnessDescriptor } from "../driver.js";
import type { GitInfo } from "../gitinfo.js";
import { HostRcRelay } from "../relay.js";
import type { Session } from "../session.js";

export interface BridgeArgs {
  /** The Session the driver created for this RC session. */
  session: Session;
  /** What this driver can faithfully service — broadcast on session_announce so the viewer disables the
   *  controls this driver can't honor (no false "✓"). */
  capabilities: DriverCapabilities;
  /** Which harness (agent + bridge mode) this session runs — broadcast on session_announce so the viewer's
   *  session list can label it (Claude Code · RC / · TX / opencode). */
  harness: HarnessDescriptor;
  /** Builds a fresh BrokerClient (provider + Vercel bypass + backend already wired), one per session. */
  newClient: () => BrokerClient;
  /** This machine's 16-byte identity id (frame headers). */
  identityId: Uint8Array;
  /** Announce title / cwd / git chip (snapshotted once at launch). */
  title: string;
  cwd: string;
  git: GitInfo | null;
  /** Aborts when the wrapper exits; stops the relay's pumps. */
  signal: AbortSignal;
  /** Set the served promise is tracked in, so the launcher can await flush on teardown. */
  relays: Set<Promise<void>>;
  /** Relay diagnostics tracer (target "rc.relay"; NOOP when quiet). */
  tracer: Tracer;
}

/**
 * Bridge ONE Session to the broker: announce immediately (must not wait on serve()'s durable-cursor
 * prepare — that delay would race a viewer's concurrent bus subscribe), then serve both pumps until
 * `signal` aborts. The served promise is registered in `relays` so the launcher can await a final
 * flush on teardown. Errors are swallowed (announce/serve are best-effort; a fatal seq error tears
 * down only that session's relay).
 */
export function bridgeSession(a: BridgeArgs): Promise<void> {
  const relay = new HostRcRelay({
    client: a.newClient(),
    identityId: a.identityId,
    sessionId: a.session.id,
    session: a.session,
    tracer: a.tracer,
    capabilities: a.capabilities,
    harness: a.harness,
  });
  void relay.announce(a.title, a.cwd, a.git).catch(() => {});
  // Surface relay death rather than silently swallowing it (review #10): serve() ending early (a fatal
  // seq error tears down only this session's relay) is logged so a driver/operator can see the bridge
  // died while the harness keeps running. The RETURNED promise lets a driver await teardown / observe
  // the end; the `relays` set still tracks it for the launcher's final-flush wait.
  const served = relay.serve(a.signal).catch((e: unknown) => {
    // The catch MUST stay no-throw (the prior inline code used `() => {}`): a logging sink that throws
    // — e.g. a closed stderr fd — must not convert a handled relay error into an unhandled rejection.
    try {
      a.tracer.debug("bridge: relay serve ended", { session: a.session.id, error: String(e) });
    } catch {
      /* logging must never throw */
    }
  });
  a.relays.add(served);
  void served.finally(() => a.relays.delete(served));
  return served;
}
