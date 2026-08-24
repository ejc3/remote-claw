import { describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import { NOOP_TRACER } from "../../../trace.js";
import { MITM_CAPABILITIES, MITM_HARNESS } from "../driver.js";
import { Session } from "../session.js";
import type { BridgeArgs, BridgeSessionHandle } from "./bridge.js";
import { ReadyBridge } from "./ready-bridge.js";

const ID = new Uint8Array(16);
const ANNOUNCEMENT = {
  capabilities: MITM_CAPABILITIES,
  harness: MITM_HARNESS,
  title: "ready",
  cwd: "/repo",
  git: null,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lifecycle(options: {
  parent: AbortController;
  session?: Session;
  startBridge?: (args: BridgeArgs) => BridgeSessionHandle;
  newClient?: () => BrokerClient;
}): ReadyBridge {
  return new ReadyBridge({
    session: options.session ?? new Session("ready-bridge", "session", {}),
    newClient: options.newClient ?? (() => ({}) as BrokerClient),
    identityId: ID,
    relays: new Set(),
    terminalTasks: new Set(),
    tracer: NOOP_TRACER,
    parentSignal: options.parent.signal,
    ...(options.startBridge === undefined ? {} : { startBridge: options.startBridge }),
  });
}

describe("ReadyBridge", () => {
  it("does not create a broker client or announce when cancellation wins before readiness", async () => {
    const parent = new AbortController();
    const session = new Session("cancelled-before-ready", "session", {});
    let clients = 0;
    let starts = 0;
    const bridge = lifecycle({
      parent,
      session,
      newClient: () => {
        clients += 1;
        return {} as BrokerClient;
      },
      startBridge: () => {
        starts += 1;
        return { served: Promise.resolve() };
      },
    });

    parent.abort();

    expect(bridge.state).toBe("closed");
    expect(bridge.signal.aborted).toBe(true);
    expect(session.closed).toBe(true);
    expect(session.closeReason).toBe("parent cancelled");
    expect(() => bridge.start(ANNOUNCEMENT)).toThrow("closed before readiness");
    await bridge.close("test teardown");
    expect(starts).toBe(0);
    expect(clients).toBe(0);
  });

  it("lets synchronous cancellation overtake bridge construction without a live ghost", async () => {
    const parent = new AbortController();
    const session = new Session("cancelled-during-ready", "session", {});
    let starts = 0;
    let bridgeSignal: AbortSignal | undefined;
    const bridge = lifecycle({
      parent,
      session,
      startBridge: (args) => {
        starts += 1;
        bridgeSignal = args.signal;
        parent.abort();
        return { served: Promise.resolve() };
      },
    });

    expect(() => bridge.start(ANNOUNCEMENT)).toThrow("closed before readiness");
    expect(starts).toBe(1);
    expect(bridgeSignal?.aborted).toBe(true);
    expect(bridge.state).toBe("closed");
    expect(session.closed).toBe(true);
    expect(() => bridge.start(ANNOUNCEMENT)).toThrow("closed before readiness");
    await bridge.close("test teardown");
  });

  it("does not start after the Session independently closed", async () => {
    const parent = new AbortController();
    const session = new Session("native-setup-failed", "session", {});
    session.close("native setup failed");
    let starts = 0;
    const bridge = lifecycle({
      parent,
      session,
      startBridge: () => {
        starts += 1;
        return { served: Promise.resolve() };
      },
    });

    expect(bridge.state).toBe("closed");
    expect(bridge.signal.aborted).toBe(true);
    expect(() => bridge.start(ANNOUNCEMENT)).toThrow("closed before readiness");
    expect(starts).toBe(0);
    expect(session.closeReason).toBe("native setup failed");
    await bridge.close("test teardown");
  });

  it("starts once, aborts synchronously, and awaits active bridge teardown", async () => {
    const parent = new AbortController();
    const session = new Session("active", "session", {});
    const serving = deferred();
    let starts = 0;
    let bridgeSignal: AbortSignal | undefined;
    const bridge = lifecycle({
      parent,
      session,
      startBridge: (args) => {
        starts += 1;
        bridgeSignal = args.signal;
        return { served: serving.promise };
      },
    });

    const handle = bridge.start(ANNOUNCEMENT);
    expect(handle.served).toBe(serving.promise);
    expect(bridge.state).toBe("ready");
    expect(starts).toBe(1);
    expect(() => bridge.start(ANNOUNCEMENT)).toThrow("already ready");

    let settled = false;
    const closing = bridge.close("driver teardown").then(() => {
      settled = true;
    });
    expect(bridge.state).toBe("closed");
    expect(bridgeSignal?.aborted).toBe(true);
    expect(session.closed).toBe(true);
    expect(session.closeReason).toBe("driver teardown");
    await Promise.resolve();
    expect(settled).toBe(false);

    serving.resolve();
    await closing;
    await bridge.close("idempotent teardown");
    expect(starts).toBe(1);
  });

  it("does not equate projection settlement with native-owner cancellation", async () => {
    const parent = new AbortController();
    const session = new Session("settled", "session", {});
    const serving = deferred();
    const bridge = lifecycle({
      parent,
      session,
      startBridge: () => ({ served: serving.promise }),
    });

    bridge.start(ANNOUNCEMENT);
    serving.resolve();
    await serving.promise;
    await Promise.resolve();

    expect(bridge.state).toBe("ready");
    expect(bridge.signal.aborted).toBe(false);
    expect(session.closed).toBe(false);
    parent.abort();
    expect(bridge.state).toBe("closed");
    expect(bridge.signal.aborted).toBe(true);
    expect(session.closeReason).toBe("parent cancelled");
  });
});
