import { describe, expect, it, vi } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import { NOOP_TRACER } from "../../../trace.js";
import type {
  NativeConversationBinding,
  NativeConversationCapabilities,
  NativeConversationRef,
} from "../../native/adapter.js";
import { MITM_CAPABILITIES, MITM_HARNESS } from "../driver.js";
import { Session } from "../session.js";
import type { BridgeAnnouncement, BridgeArgs, BridgeSessionHandle } from "./bridge.js";
import {
  type LegacyRcConversationMetadata,
  LegacyRcConversationRegistrar,
} from "./legacy-registrar.js";

const NATIVE_CAPABILITIES: NativeConversationCapabilities = {
  version: 1,
  mutationAdmission: "structured",
  history: "partial",
  deliveryEvidence: "native_observation",
  liveReattach: false,
};

function nativeCapabilities(
  overrides: Partial<NativeConversationCapabilities> = {},
): NativeConversationCapabilities {
  return { ...NATIVE_CAPABILITIES, ...overrides };
}

function metadata(
  overrides: Partial<LegacyRcConversationMetadata> = {},
): LegacyRcConversationMetadata {
  return {
    title: "remote-claw",
    cwd: "/work/project",
    git: null,
    capabilities: MITM_CAPABILITIES,
    harness: MITM_HARNESS,
    ...overrides,
  };
}

function registration(
  port: Session,
  registrationAttemptId: string,
  overrides: Partial<NativeConversationBinding<Session, LegacyRcConversationMetadata>> = {},
): NativeConversationBinding<Session, LegacyRcConversationMetadata> {
  return {
    bindingId: null,
    registrationAttemptId,
    descriptor: { product: "claude-code", access: "native-rc" },
    project: { projectId: "project-1", cwd: "/work/project" },
    nativeRef: null,
    phase: "starting",
    capabilities: null,
    port,
    metadata: metadata(),
    ...overrides,
  };
}

function nativeRef(
  conversationId: string,
  overrides: Partial<NativeConversationRef> = {},
): NativeConversationRef {
  return {
    descriptor: { product: "claude-code", access: "native-rc" },
    runtimeId: "runtime-1",
    conversationId,
    incarnation: 1,
    ...overrides,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface StartedBridge {
  args: BridgeArgs;
  handle: BridgeSessionHandle;
  served: ReturnType<typeof deferred<void>>;
  refreshes: BridgeAnnouncement[];
  refreshImpl: ReturnType<typeof vi.fn<(announcement: BridgeAnnouncement) => Promise<void>>>;
}

function bridgeHarness(): {
  starts: StartedBridge[];
  startBridge: (args: BridgeArgs) => BridgeSessionHandle;
} {
  const starts: StartedBridge[] = [];
  return {
    starts,
    startBridge(args) {
      const served = deferred<void>();
      const refreshes: BridgeAnnouncement[] = [];
      const refreshImpl = vi.fn(async (announcement: BridgeAnnouncement) => {
        refreshes.push(announcement);
      });
      const handle = { served: served.promise, refresh: refreshImpl };
      starts.push({ args, handle, served, refreshes, refreshImpl });
      return handle;
    },
  };
}

function registrar(
  bridge = bridgeHarness(),
  ids: string[] = ["rcb_one", "rcb_two", "rcb_three"],
): {
  registrar: LegacyRcConversationRegistrar;
  bridge: ReturnType<typeof bridgeHarness>;
} {
  return {
    registrar: new LegacyRcConversationRegistrar({
      newClient: () => ({}) as BrokerClient,
      identityId: new Uint8Array(16).fill(7),
      relays: new Set(),
      tracer: NOOP_TRACER,
      coordinatorEpoch: 19,
      newBindingId: () => ids.shift() ?? "rcb_exhausted",
      startBridge: bridge.startBridge,
    }),
    bridge,
  };
}

describe("LegacyRcConversationRegistrar", () => {
  it("allocates distinct process-local rcb bindings and exactly replays one attempt", async () => {
    const h = registrar();
    const firstRequest = registration(new Session("session-1", "one", null), "attempt-1");
    const secondRequest = registration(new Session("session-2", "two", null), "attempt-2");

    const first = await h.registrar.open(firstRequest);
    const replay = await h.registrar.open(firstRequest);
    const second = await h.registrar.open(secondRequest);

    expect(replay).toBe(first);
    expect(first.bindingId).toBe("rcb_one");
    expect(second.bindingId).toBe("rcb_two");
    expect(first.coordinatorEpoch).toBe(19);
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(h.bridge.starts).toHaveLength(0);
  });

  it("fails closed on attempt, caller binding, generated binding, port, and session-id conflicts", async () => {
    const h = registrar();
    const session = new Session("same-session-id", "one", null);
    const original = registration(session, "attempt-1");
    await h.registrar.open(original);

    await expect(
      h.registrar.open({ ...original, metadata: metadata({ title: "changed" }) }),
    ).rejects.toThrow(/registrationAttemptId was reused with a different request/);
    await expect(
      h.registrar.open(
        registration(new Session("unknown", "unknown", null), "attempt-unknown", {
          bindingId: "rcb_one",
        }),
      ),
    ).rejects.toThrow(/cannot adopt or reopen/);
    await expect(h.registrar.open(registration(session, "attempt-2"))).rejects.toThrow(
      /port is already registered/,
    );
    await expect(
      h.registrar.open(
        registration(new Session("same-session-id", "other object", null), "attempt-3"),
      ),
    ).rejects.toThrow(/Session id is already registered/);

    const invalidId = registrar(bridgeHarness(), ["not-an-rcb-id"]);
    await expect(
      invalidId.registrar.open(
        registration(new Session("invalid-id", "invalid", null), "attempt-invalid"),
      ),
    ).rejects.toThrow(/rcb_\* namespace/);

    const duplicateId = registrar(bridgeHarness(), ["rcb_duplicate", "rcb_duplicate"]);
    await duplicateId.registrar.open(
      registration(new Session("duplicate-1", "one", null), "attempt-duplicate-1"),
    );
    await expect(
      duplicateId.registrar.open(
        registration(new Session("duplicate-2", "two", null), "attempt-duplicate-2"),
      ),
    ).rejects.toThrow(/duplicate bindingId/);
  });

  it("requires validated generic capabilities before ready and starts a bridge exactly once", async () => {
    const h = registrar();
    const session = new Session("session-ready", "ready", null);
    const lease = await h.registrar.open(registration(session, "attempt-ready"));

    await expect(lease.setPhase("ready")).rejects.toThrow(/capabilities are required before ready/);
    expect(h.bridge.starts).toHaveLength(0);

    const setupMetadata = metadata({
      title: "configured title",
      cwd: "/configured",
      git: {
        branch: "main",
        sha: "12345678",
        dirty: false,
        ahead: 1,
        behind: 2,
      },
    });
    await lease.update(setupMetadata, nativeCapabilities());
    await lease.setPhase("ready");
    await lease.setPhase("ready");

    expect(h.bridge.starts).toHaveLength(1);
    const started = h.bridge.starts[0];
    expect(started?.args).toMatchObject({
      session,
      title: "configured title",
      cwd: "/configured",
      git: setupMetadata.git,
      capabilities: MITM_CAPABILITIES,
      harness: MITM_HARNESS,
    });
    expect(started?.args.signal.aborted).toBe(false);

    started?.served.resolve();
    await lease.close("test complete");
  });

  it("accepts validated initial capabilities and permits ready with nativeRef still null", async () => {
    const h = registrar();
    const lease = await h.registrar.open(
      registration(new Session("session-initial-cap", "initial", null), "attempt-initial-cap", {
        capabilities: nativeCapabilities({ history: "none" }),
      }),
    );

    await lease.setPhase("ready");
    expect(h.bridge.starts).toHaveLength(1);

    h.bridge.starts[0]?.served.resolve();
    await lease.close("done");
  });

  it("rejects malformed generic capabilities at open and update", async () => {
    const h = registrar();
    const invalid = {
      ...nativeCapabilities(),
      version: 2,
    } as unknown as NativeConversationCapabilities;
    await expect(
      h.registrar.open(
        registration(new Session("session-invalid-open", "invalid", null), "attempt-invalid-open", {
          capabilities: invalid,
        }),
      ),
    ).rejects.toThrow(/native capabilities are invalid/);

    const lease = await h.registrar.open(
      registration(
        new Session("session-invalid-update", "invalid", null),
        "attempt-invalid-update",
      ),
    );
    await expect(lease.update(metadata(), invalid)).rejects.toThrow(
      /native capabilities are invalid/,
    );
    await expect(lease.setPhase("ready")).rejects.toThrow(/required before ready/);
    await lease.close("done");
  });

  it("refreshes viewer metadata and legacy capabilities after ready without restarting", async () => {
    const h = registrar();
    const lease = await h.registrar.open(
      registration(new Session("session-refresh", "refresh", null), "attempt-refresh", {
        capabilities: nativeCapabilities(),
      }),
    );
    await lease.setPhase("ready");

    const changed = metadata({
      title: "refreshed",
      cwd: "/refreshed",
      capabilities: {
        structuredPermissions: false,
        status: false,
        attachments: true,
        controls: { interrupt: true, setModel: false, setMode: false, end: false },
      },
    });
    await lease.update(changed, nativeCapabilities({ history: "complete" }));

    expect(h.bridge.starts).toHaveLength(1);
    expect(h.bridge.starts[0]?.refreshes).toEqual([
      {
        title: "refreshed",
        cwd: "/refreshed",
        git: null,
        capabilities: changed.capabilities,
      },
    ]);

    h.bridge.starts[0]?.served.resolve();
    await lease.close("done");
  });

  it("commits validated local truth before advisory delivery and permits a later refresh", async () => {
    const h = registrar();
    const lease = await h.registrar.open(
      registration(new Session("session-refresh-fail", "refresh", null), "attempt-refresh-fail", {
        capabilities: nativeCapabilities(),
      }),
    );
    await lease.setPhase("ready");
    const started = h.bridge.starts[0];
    started?.refreshImpl.mockRejectedValueOnce(new Error("announce failed"));
    const failedSnapshot = metadata({
      title: "failed delivery, retained truth",
      cwd: "/retained",
    });

    // Rejection reports the advisory delivery gap; it does not roll validated registrar state back.
    await expect(lease.update(failedSnapshot, nativeCapabilities())).rejects.toThrow(
      "announce failed",
    );
    expect(started?.refreshImpl.mock.calls[0]?.[0]).toEqual({
      title: "failed delivery, retained truth",
      cwd: "/retained",
      git: null,
      capabilities: failedSnapshot.capabilities,
    });

    const laterSnapshot = metadata({ title: "later snapshot", cwd: "/later" });
    await lease.update(laterSnapshot, nativeCapabilities({ history: "complete" }));
    expect(started?.refreshImpl).toHaveBeenCalledTimes(2);
    expect(started?.refreshImpl.mock.calls[1]?.[0]).toEqual({
      title: "later snapshot",
      cwd: "/later",
      git: null,
      capabilities: laterSnapshot.capabilities,
    });

    started?.served.resolve();
    await lease.close("done");
  });

  it("fences and aborts shutdown before an in-flight refresh settles, without resurrection", async () => {
    const h = registrar();
    const lease = await h.registrar.open(
      registration(new Session("session-refresh-drain", "refresh", null), "attempt-refresh-drain", {
        capabilities: nativeCapabilities(),
      }),
    );
    await lease.setPhase("ready");
    const started = h.bridge.starts[0];
    if (started === undefined) throw new Error("bridge did not start");

    const refresh = deferred<void>();
    started.refreshImpl.mockImplementationOnce(() => refresh.promise);
    const updating = lease.update(
      metadata({ title: "validated before drain" }),
      nativeCapabilities({ history: "complete" }),
    );
    await vi.waitFor(() => expect(started.refreshImpl).toHaveBeenCalledTimes(1));

    const draining = lease.setPhase("draining");
    expect(started.args.signal.aborted).toBe(true);
    await expect(
      lease.update(metadata({ title: "must reject" }), nativeCapabilities()),
    ).rejects.toThrow(/drain was requested/);
    await expect(lease.setPhase("ready")).rejects.toThrow(/drain was requested/);
    expect(h.bridge.starts).toHaveLength(1);

    refresh.resolve();
    await expect(updating).rejects.toThrow(/update completed after drain was requested/);
    await draining;
    const closing = lease.close("drain complete");
    started.served.resolve();
    await closing;
    expect(h.bridge.starts).toHaveLength(1);
  });

  it("snapshots queued update and native-binding inputs at call time", async () => {
    const h = registrar();
    const lease = await h.registrar.open(
      registration(
        new Session("session-input-snapshot", "snapshot", null),
        "attempt-input-snapshot",
        {
          capabilities: nativeCapabilities(),
        },
      ),
    );
    await lease.setPhase("ready");
    const started = h.bridge.starts[0];
    if (started === undefined) throw new Error("bridge did not start");

    const earlierRefresh = deferred<void>();
    started.refreshImpl.mockImplementationOnce(() => earlierRefresh.promise);
    const earlierUpdate = lease.update(
      metadata({ title: "earlier refresh" }),
      nativeCapabilities(),
    );
    await vi.waitFor(() => expect(started.refreshImpl).toHaveBeenCalledTimes(1));

    const mutableViewerCapabilities = {
      structuredPermissions: true,
      status: true,
      attachments: true,
      controls: { interrupt: true, setModel: true, setMode: true, end: false },
    };
    const mutableMetadata: LegacyRcConversationMetadata = {
      title: "queued snapshot",
      cwd: "/queued",
      git: {
        branch: "snapshot-branch",
        sha: "12345678",
        dirty: false,
        ahead: 1,
        behind: 2,
      },
      capabilities: mutableViewerCapabilities,
      harness: { agent: "claude-code", mode: "rc" },
    };
    const expectedAnnouncement: BridgeAnnouncement = {
      title: "queued snapshot",
      cwd: "/queued",
      git: {
        branch: "snapshot-branch",
        sha: "12345678",
        dirty: false,
        ahead: 1,
        behind: 2,
      },
      capabilities: {
        structuredPermissions: true,
        status: true,
        attachments: true,
        controls: { interrupt: true, setModel: true, setMode: true, end: false },
      },
    };
    const mutableCapabilities = nativeCapabilities({ history: "complete" });
    const originalRef = nativeRef("snapshot-conversation", {
      runtimeId: "snapshot-runtime",
      incarnation: 7,
    });
    const mutableRef: NativeConversationRef = {
      ...originalRef,
      descriptor: { ...originalRef.descriptor },
    };

    const queuedUpdate = lease.update(mutableMetadata, mutableCapabilities);
    const queuedBind = lease.bindNative(mutableRef);

    mutableMetadata.title = "mutated title";
    mutableMetadata.cwd = "/mutated";
    if (mutableMetadata.git !== null) {
      mutableMetadata.git.branch = "mutated-branch";
      mutableMetadata.git.ahead = 99;
    }
    mutableViewerCapabilities.structuredPermissions = false;
    mutableViewerCapabilities.controls.setModel = false;
    mutableMetadata.harness.mode = "tmux";
    (mutableCapabilities as { version: number }).version = 2;
    mutableCapabilities.history = "none";
    mutableRef.runtimeId = "mutated-runtime";
    mutableRef.conversationId = "mutated-conversation";
    mutableRef.incarnation = 8;

    earlierRefresh.resolve();
    await earlierUpdate;
    await queuedUpdate;
    await queuedBind;

    expect(started.refreshImpl.mock.calls[1]?.[0]).toEqual(expectedAnnouncement);
    await lease.bindNative(originalRef);
    await expect(lease.bindNative(mutableRef)).rejects.toThrow(/cannot be replaced/);

    const closing = lease.close("done");
    started.served.resolve();
    await closing;
  });

  it("binds the first native identity, accepts its exact replay, and rejects replacement", async () => {
    const h = registrar();
    const lease = await h.registrar.open(
      registration(new Session("session-bind", "bind", null), "attempt-bind"),
    );
    const first = nativeRef("conversation-1");

    await lease.bindNative(first);
    await lease.bindNative({ ...first, descriptor: { ...first.descriptor } });
    await expect(lease.bindNative(nativeRef("conversation-2"))).rejects.toThrow(
      /cannot be replaced/,
    );
    await expect(
      lease.bindNative(
        nativeRef("conversation-1", {
          descriptor: { product: "claude-code", access: "tmux" },
        }),
      ),
    ).rejects.toThrow(/descriptor does not match/);
    await lease.close("done");
  });

  it("enforces active native-reference uniqueness and releases it only when the lease closes", async () => {
    const h = registrar();
    const ref = nativeRef("shared-conversation");
    const first = await h.registrar.open(
      registration(new Session("session-native-1", "one", null), "attempt-native-1", {
        nativeRef: ref,
      }),
    );

    await expect(
      h.registrar.open(
        registration(new Session("session-native-2", "two", null), "attempt-native-2", {
          nativeRef: { ...ref, descriptor: { ...ref.descriptor } },
        }),
      ),
    ).rejects.toThrow(/native reference is already active/);

    await first.close("release native ref");
    const replacement = await h.registrar.open(
      registration(new Session("session-native-3", "three", null), "attempt-native-3", {
        nativeRef: ref,
      }),
    );
    expect(replacement.bindingId).toBe("rcb_two");
    await replacement.close("done");
  });

  it("rejects sibling incarnations of one active native conversation", async () => {
    const h = registrar();
    const firstRef = nativeRef("sibling-conversation", { incarnation: 4 });
    const siblingRef = nativeRef("sibling-conversation", { incarnation: 5 });
    const first = await h.registrar.open(
      registration(new Session("session-sibling-1", "one", null), "attempt-sibling-1", {
        nativeRef: firstRef,
      }),
    );

    await expect(
      h.registrar.open(
        registration(new Session("session-sibling-2", "two", null), "attempt-sibling-2", {
          nativeRef: siblingRef,
        }),
      ),
    ).rejects.toThrow(/native reference is already active/);

    const lateBinding = await h.registrar.open(
      registration(new Session("session-sibling-3", "three", null), "attempt-sibling-3"),
    );
    await expect(lateBinding.bindNative(siblingRef)).rejects.toThrow(
      /native reference is already active/,
    );

    await first.close("done");
    await lateBinding.close("done");
  });

  it("retains native identity until served bridge teardown settles", async () => {
    const h = registrar();
    const ref = nativeRef("closing-conversation");
    const first = await h.registrar.open(
      registration(
        new Session("session-closing-native-1", "one", null),
        "attempt-closing-native-1",
        {
          nativeRef: ref,
          capabilities: nativeCapabilities(),
        },
      ),
    );
    await first.setPhase("ready");
    const started = h.bridge.starts[0];
    if (started === undefined) throw new Error("bridge did not start");

    let closed = false;
    const closing = first.close("close while bridge is serving").then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(started.args.signal.aborted).toBe(true);
    expect(closed).toBe(false);

    await expect(
      h.registrar.open(
        registration(
          new Session("session-closing-native-2", "two", null),
          "attempt-closing-native-2",
          { nativeRef: ref },
        ),
      ),
    ).rejects.toThrow(/native reference is already active/);

    const lateBinding = await h.registrar.open(
      registration(
        new Session("session-closing-native-3", "three", null),
        "attempt-closing-native-3",
      ),
    );
    await expect(lateBinding.bindNative(ref)).rejects.toThrow(/native reference is already active/);

    started.served.resolve();
    await closing;
    expect(closed).toBe(true);
    await lateBinding.bindNative(ref);
    await lateBinding.close("done");
  });

  it("enforces the forward-only phase graph for starting and recovering leases", async () => {
    const h = registrar();
    const starting = await h.registrar.open(
      registration(new Session("session-phase-start", "start", null), "attempt-phase-start"),
    );
    await expect(starting.setPhase("recovering")).rejects.toThrow(
      /illegal phase transition starting -> recovering/,
    );
    await starting.setPhase("draining");
    await expect(starting.setPhase("ready")).rejects.toThrow(
      /illegal phase transition draining -> ready/,
    );
    await starting.setPhase("closed");
    await starting.setPhase("closed");

    const recovering = await h.registrar.open(
      registration(new Session("session-phase-recover", "recover", null), "attempt-phase-recover", {
        phase: "recovering",
        capabilities: nativeCapabilities(),
      }),
    );
    await recovering.setPhase("ready");
    await expect(recovering.setPhase("recovering")).rejects.toThrow(
      /illegal phase transition ready -> recovering/,
    );
    await recovering.setPhase("draining");
    h.bridge.starts[0]?.served.resolve();
    await recovering.close("done");
  });

  it("closing is idempotent, owns only its bridge, awaits it, and never closes Session", async () => {
    const h = registrar();
    const firstSession = new Session("session-close-1", "one", null);
    const secondSession = new Session("session-close-2", "two", null);
    const first = await h.registrar.open(
      registration(firstSession, "attempt-close-1", {
        capabilities: nativeCapabilities(),
      }),
    );
    const second = await h.registrar.open(
      registration(secondSession, "attempt-close-2", {
        capabilities: nativeCapabilities(),
      }),
    );
    await first.setPhase("ready");
    await second.setPhase("ready");

    let firstClosed = false;
    const closing = first.close("first only").then(() => {
      firstClosed = true;
    });
    await vi.waitFor(() => expect(h.bridge.starts[0]?.args.signal.aborted).toBe(true));
    expect(h.bridge.starts[1]?.args.signal.aborted).toBe(false);
    expect(firstClosed).toBe(false);
    expect(firstSession.closed).toBe(false);
    expect(secondSession.closed).toBe(false);

    h.bridge.starts[0]?.served.resolve();
    await closing;
    await first.close("idempotent replay");
    expect(firstSession.closed).toBe(false);

    h.bridge.starts[1]?.served.resolve();
    await second.close("done");
  });

  it("closeAll snapshots, aborts, and awaits every registered lease bridge", async () => {
    const h = registrar();
    const leases = await Promise.all(
      ["one", "two"].map(async (suffix) => {
        const lease = await h.registrar.open(
          registration(
            new Session(`session-all-${suffix}`, suffix, null),
            `attempt-all-${suffix}`,
            { capabilities: nativeCapabilities() },
          ),
        );
        await lease.setPhase("ready");
        return lease;
      }),
    );

    let closed = false;
    const closing = h.registrar.closeAll("host shutdown").then(() => {
      closed = true;
    });
    await vi.waitFor(() => {
      expect(h.bridge.starts.every((start) => start.args.signal.aborted)).toBe(true);
    });
    expect(closed).toBe(false);

    h.bridge.starts[0]?.served.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    h.bridge.starts[1]?.served.resolve();
    await closing;
    expect(closed).toBe(true);

    await Promise.all(leases.map((lease) => lease.close("again")));
  });

  it("closes without starting a bridge and preserves closed attempt replay without resurrection", async () => {
    const h = registrar();
    const session = new Session("session-never-ready", "never ready", null);
    const request = registration(session, "attempt-never-ready");
    const lease = await h.registrar.open(request);

    await lease.close("setup failed");
    expect(h.bridge.starts).toHaveLength(0);
    expect(session.closed).toBe(false);
    expect(await h.registrar.open(request)).toBe(lease);
    await expect(lease.update(metadata(), nativeCapabilities())).rejects.toThrow(/closed lease/);
    await expect(lease.bindNative(nativeRef("late"))).rejects.toThrow(/while closed/);
    await expect(h.registrar.open(registration(session, "new-attempt-same-port"))).rejects.toThrow(
      /port is already registered/,
    );
  });

  it("rejects descriptor/harness mismatch and malformed registration fields", async () => {
    const h = registrar();
    await expect(
      h.registrar.open(
        registration(new Session("session-harness", "bad harness", null), "attempt-harness", {
          metadata: metadata({
            harness: { agent: "claude-code", mode: "tmux" },
          }),
        }),
      ),
    ).rejects.toThrow(/harness does not match/);
    await expect(
      h.registrar.open(registration(new Session("session-attempt", "bad attempt", null), "")),
    ).rejects.toThrow(/registrationAttemptId must be non-empty/);
    await expect(
      h.registrar.open(
        registration(new Session("session-ref", "bad ref", null), "attempt-ref", {
          nativeRef: nativeRef("wrong-descriptor", {
            descriptor: { product: "claude-code", access: "tmux" },
          }),
        }),
      ),
    ).rejects.toThrow(/descriptor does not match/);
  });
});
