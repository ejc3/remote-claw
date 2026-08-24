import type { Tracer } from "../../../trace.js";
import type { DriverCapabilities, HarnessDescriptor } from "../driver.js";
import type { GitInfo } from "../gitinfo.js";
import type { Session } from "../session.js";
import { type BridgeArgs, type BridgeSessionHandle, startBridgeSession } from "./bridge.js";

export interface ReadyBridgeOptions {
  session: Session;
  newClient: BridgeArgs["newClient"];
  identityId: Uint8Array;
  relays: Set<Promise<void>>;
  terminalTasks: Set<Promise<void>>;
  tracer: Tracer;
  /** The harness owner. Cancellation is linked synchronously before native setup begins. */
  parentSignal: AbortSignal;
  /** Test seam for the bridge boundary. */
  startBridge?: (args: BridgeArgs) => BridgeSessionHandle;
}

export interface ReadyBridgeAnnouncement {
  capabilities: DriverCapabilities;
  harness: HarnessDescriptor;
  title: string;
  cwd: string;
  git: GitInfo | null;
}

export type ReadyBridgeState = "starting" | "ready" | "closed";

function closedError(): Error {
  return new Error("bridge owner closed before readiness");
}

/**
 * The small lifecycle shared by concrete harnesses.
 *
 * Native setup happens while this object is `starting` and therefore creates no BrokerClient and no
 * presence record. `start` is the single readiness edge. `close` flips the state and aborts synchronously
 * before awaiting network teardown, so cancellation can never be overtaken by a late readiness result.
 */
export class ReadyBridge {
  readonly #options: ReadyBridgeOptions;
  readonly #controller = new AbortController();
  readonly #startBridge: (args: BridgeArgs) => BridgeSessionHandle;
  readonly #onParentAbort: () => void;
  #state: ReadyBridgeState = "starting";
  #handle: BridgeSessionHandle | null = null;

  constructor(options: ReadyBridgeOptions) {
    this.#options = options;
    this.#startBridge = options.startBridge ?? startBridgeSession;
    this.#onParentAbort = () => {
      void this.close("parent cancelled").catch(() => {
        // Explicit owners await close during teardown. The signal listener only observes the same result
        // so a rejecting terminal publication cannot become an unhandled rejection.
      });
    };
    if (options.parentSignal.aborted) this.#requestClose("parent cancelled");
    else if (options.session.closed)
      this.#requestClose(options.session.closeReason ?? "session closed before readiness");
    else options.parentSignal.addEventListener("abort", this.#onParentAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get state(): ReadyBridgeState {
    return this.#state;
  }

  /** Publish one final, truthful capability snapshot and start the broker bridge exactly once. */
  start(announcement: ReadyBridgeAnnouncement): BridgeSessionHandle {
    if (
      this.#state === "closed" ||
      this.#controller.signal.aborted ||
      this.#options.session.closed
    ) {
      this.#requestClose(this.#options.session.closeReason ?? "session closed before readiness");
      throw closedError();
    }
    if (this.#state === "ready") throw new Error("bridge is already ready");

    let handle: BridgeSessionHandle;
    try {
      handle = this.#startBridge({
        session: this.#options.session,
        capabilities: announcement.capabilities,
        harness: announcement.harness,
        newClient: this.#options.newClient,
        identityId: this.#options.identityId,
        title: announcement.title,
        cwd: announcement.cwd,
        git: announcement.git,
        signal: this.#controller.signal,
        relays: this.#options.relays,
        terminalTasks: this.#options.terminalTasks,
        tracer: this.#options.tracer,
      });
    } catch (error) {
      this.#requestClose("bridge start failed");
      throw error;
    }

    this.#handle = handle;
    if (this.#controller.signal.aborted || this.#options.session.closed) {
      this.#requestClose(this.#options.session.closeReason ?? "session closed during readiness");
      void handle.served.catch(() => {});
      throw closedError();
    }
    this.#state = "ready";
    return handle;
  }

  /** Idempotently fence local work, close the Session, and await an active bridge if one exists. */
  close(reason: string): Promise<void> {
    this.#requestClose(reason);
    return this.#handle?.served ?? Promise.resolve();
  }

  #requestClose(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#options.parentSignal.removeEventListener("abort", this.#onParentAbort);
    // Preserve the causal reason before abort dispatch reaches startBridgeSession's generic close hook.
    this.#options.session.close(reason);
    this.#controller.abort();
  }
}
