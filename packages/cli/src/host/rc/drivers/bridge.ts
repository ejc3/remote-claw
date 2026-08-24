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
  /** Initial announce title / cwd / git chip. A live bridge can refresh these through its handle. */
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

/** The complete viewer-facing snapshot replaced by one live bridge refresh. All fields are required so
 * a caller cannot accidentally retain an optimistic pre-setup capability or stale location field. */
export interface BridgeAnnouncement {
  title: string;
  cwd: string;
  git: GitInfo | null;
  capabilities: DriverCapabilities;
}

/** A running broker bridge. The owner controls its lifetime through BridgeArgs.signal; `served` lets it
 * await teardown, while `refresh` replaces announcement metadata/capabilities without restarting either
 * relay pump. Harness identity is fixed for the bridge lifetime. */
export interface BridgeSessionHandle {
  served: Promise<void>;
  refresh(announcement: BridgeAnnouncement): Promise<void>;
}

function bridgeEndedError(): Error {
  return new Error("bridge is no longer serving");
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
  let announceTail = prepared
    .then(() =>
      ownerEnded() ? undefined : relay.announce(initial.title, initial.cwd, initial.git),
    )
    .catch(() => {});
  let acceptingRefreshes = !ownerEnded();
  let resolveEnded = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const stopAcceptingRefreshes = () => {
    if (!acceptingRefreshes) return;
    acceptingRefreshes = false;
    resolveEnded();
  };
  // The bridge owner is the only lifetime owner in A0: there is no supported reattachment path after
  // its signal ends. Close the cse synchronously so every MITM/native route becomes unusable and the
  // relay's Session.close observer can start the terminal bus publish before any stalled announce.
  const closeOnOwnerAbort = () => {
    stopAcceptingRefreshes();
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
  void prepared.catch(stopAcceptingRefreshes);
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
    stopAcceptingRefreshes();
    a.signal.removeEventListener("abort", closeOnOwnerAbort);
    const terminal = terminalize();
    await announceTail;
    await Promise.allSettled([terminal]);
    await relay.settlePresence();
  });
  a.relays.add(served);
  void served.finally(() => a.relays.delete(served));
  return {
    served,
    refresh(announcement) {
      const snapshot = snapshotAnnouncement(announcement);
      if (!acceptingRefreshes || ownerEnded()) {
        return Promise.reject(bridgeEndedError());
      }
      // Preserve publish order when setup completes immediately or several refinements arrive together:
      // an older, slow announce must not be posted after the newer snapshot.
      const refreshed = announceTail.then(() => {
        // A refresh admitted while an older announce was in flight may reach the head of the queue
        // only after abort/fatal relay termination. Recheck here so it cannot re-advertise a dead
        // session merely because it was queued while the bridge was still live.
        if (!acceptingRefreshes || ownerEnded()) throw bridgeEndedError();
        return relay.refreshAnnouncement(
          snapshot.title,
          snapshot.cwd,
          snapshot.git,
          snapshot.capabilities,
        );
      });
      // A transient advisory publish failure rejects this refresh so its caller can react, but must not
      // permanently poison the queue: a later truthful snapshot still gets a chance to re-announce.
      announceTail = refreshed.catch(() => {});
      // Report lifecycle loss immediately even when this refresh is parked behind a stalled older
      // announce. `announceTail` still tracks the queued operation so `served` waits for it to settle.
      return Promise.race([
        refreshed,
        ended.then(() => {
          throw bridgeEndedError();
        }),
      ]);
    },
  };
}

/** Backward-compatible bridge entrypoint used by the existing launchers and drivers. */
export function bridgeSession(a: BridgeArgs): Promise<void> {
  return startBridgeSession(a).served;
}
