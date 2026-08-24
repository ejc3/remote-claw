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
  /** Immutable announce title / cwd / git chip sampled at the driver's readiness edge. */
  title: string;
  cwd: string;
  git: GitInfo | null;
  /** Aborts when the wrapper exits; stops the relay's pumps. */
  signal: AbortSignal;
  /** Set the served promise is tracked in, so the launcher can await flush on teardown. */
  relays: Set<Promise<void>>;
  /** Terminal safety signals are tracked separately from `served`: a stuck obsolete announce may keep
   *  the relay finalizer pending, but must never let the process exit before the self-bounded terminal
   *  policy has exhausted after an event-loop resume. */
  terminalTasks: Set<Promise<void>>;
  /** Relay diagnostics tracer (target "rc.relay"; NOOP when quiet). */
  tracer: Tracer;
}

/** The immutable viewer-facing snapshot used when one ready bridge starts. */
interface BridgeAnnouncement {
  title: string;
  cwd: string;
  git: GitInfo | null;
  capabilities: DriverCapabilities;
}

/** A running broker bridge. The owner controls its lifetime through BridgeArgs.signal and awaits teardown
 * through `served`. Harness readiness is established before this bridge is constructed. */
export interface BridgeSessionHandle {
  served: Promise<void>;
}

function snapshotAnnouncement(announcement: BridgeAnnouncement): BridgeAnnouncement {
  return {
    title: announcement.title,
    cwd: announcement.cwd,
    git:
      announcement.git === null
        ? null
        : {
            branch: announcement.git.branch,
            sha: announcement.git.sha,
            dirty: announcement.git.dirty,
            ahead: announcement.git.ahead,
            behind: announcement.git.behind,
          },
    capabilities: {
      structuredPermissions: announcement.capabilities.structuredPermissions,
      status: announcement.capabilities.status,
      attachments: announcement.capabilities.attachments,
      controls: {
        interrupt: announcement.capabilities.controls.interrupt,
        setModel: announcement.capabilities.controls.setModel,
        setMode: announcement.capabilities.controls.setMode,
        end: announcement.capabilities.controls.end,
      },
    },
  };
}

/**
 * Bridge ONE Session to the broker. First sample the session channel's durable high-water marks; only
 * then may the bus announce make this bridge discoverable. Announce and serve start together after
 * that barrier, so a viewer cannot publish the first command before the inbound cursor snapshot and
 * then have that command skipped as historical. The served promise is registered in `relays` so the
 * launcher can await a final flush on teardown. A fatal relay error tears down only that session;
 * every teardown path also emits the absorbing presence terminal after any admitted live announce.
 */
export function startBridgeSession(a: BridgeArgs): BridgeSessionHandle {
  const initial = snapshotAnnouncement(a);
  const relay = new HostRcRelay({
    client: a.newClient(),
    identityId: a.identityId.slice(),
    sessionId: a.session.id,
    session: a.session,
    tracer: a.tracer,
    capabilities: initial.capabilities,
    harness: { agent: a.harness.agent, mode: a.harness.mode },
  });
  // A direct-driver teardown or a native fail-stop can race bridge construction. Do not create a ghost
  // presence entry when either owner is already gone. For a live bridge, freeze the durable cursor
  // BEFORE discoverability; after that barrier announce and serve may proceed concurrently.
  const ownerEnded = () => a.signal.aborted || a.session.closed;
  let terminalTracked = false;
  const terminalize = (): Promise<void> => {
    const task = relay.terminalizePresence();
    if (!terminalTracked) {
      terminalTracked = true;
      a.terminalTasks.add(task);
      void task.then(
        () => a.terminalTasks.delete(task),
        () => a.terminalTasks.delete(task),
      );
    }
    return task;
  };
  const prepared = ownerEnded() ? Promise.resolve() : relay.prepare();
  const announced = prepared
    .then(() =>
      ownerEnded() ? undefined : relay.announce(initial.title, initial.cwd, initial.git),
    )
    .catch(() => {});
  // The bridge owner is the only lifetime owner: there is no supported reattachment path after
  // its signal ends. Close the cse synchronously so every MITM/native route becomes unusable and the
  // relay's Session.close observer can start the terminal bus publish before any stalled announce.
  const closeOnOwnerAbort = () => {
    a.session.close();
    void terminalize().catch(() => {
      // The terminal publisher records the exhausted failure; the abort listener stays no-throw.
    });
  };
  if (!ownerEnded()) {
    a.signal.addEventListener("abort", closeOnOwnerAbort, { once: true });
  } else {
    closeOnOwnerAbort();
  }
  // Surface relay death rather than silently swallowing it (review #10): serve() ending early (a fatal
  // seq error tears down only this session's relay) is logged so a driver/operator can see the bridge
  // died while the harness keeps running. The RETURNED promise lets a driver await teardown / observe
  // the end; the `relays` set still tracks it for the launcher's final-flush wait.
  // prepare() fetches are not governed by the relay signal. If either owner was already gone at
  // construction—or ends while preparation is pending—skip serve() after the barrier settles.
  const relayServed = prepared
    .then(() => (ownerEnded() ? undefined : relay.serve(a.signal)))
    .catch((e: unknown) => {
      // A rejected relay is a fail-stop boundary for THIS cse only. Publication-queue failures already
      // close the Session at their source; this is defense-in-depth for failures before the pumps start
      // (for example durable-cursor recovery). An ordinary owner abort resolves serve(), and the guard
      // prevents an abort/rejection race from converting routine teardown into a fatal Session close.
      a.session.close();
      // The catch MUST stay no-throw (the prior inline code used `() => {}`): a logging sink that throws
      // — e.g. a closed stderr fd — must not convert a handled relay error into an unhandled rejection.
      try {
        a.tracer.debug("bridge: relay serve ended", { session: a.session.id, error: String(e) });
      } catch {
        /* logging must never throw */
      }
    });
  const served = relayServed.finally(async () => {
    // Latch/start terminality BEFORE awaiting an older blocked announce. The broker's absorbing fence
    // then rejects/suppresses that late live request regardless of network completion order. Await all
    // admitted presence work before declaring teardown complete; launch teardown is independently
    // bounded, so a permanently stalled broker cannot hang process exit.
    a.signal.removeEventListener("abort", closeOnOwnerAbort);
    const terminal = terminalize();
    await announced;
    await Promise.allSettled([terminal]);
    await relay.settlePresence();
  });
  a.relays.add(served);
  void served.finally(() => a.relays.delete(served));
  return { served };
}
