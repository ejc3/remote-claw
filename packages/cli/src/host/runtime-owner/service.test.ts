import { EventEmitter } from "node:events";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "../state/ids.js";
import { parseProtectedHandleRef } from "../state/protected.js";
import { connectRuntimeOwnerRpc } from "./client.js";
import { RuntimeOwnerDaemon, readLinuxRuntimeOwnerProcessStartIdentity } from "./daemon.js";
import {
  createRuntimeOwnerKeyCustodySigner,
  type RuntimeOwnerKeyCustodySigner,
  type RuntimeOwnerKeyCustodySigningCapability,
} from "./key-custody.js";
import {
  type HostStateDatabaseFactory,
  RUNTIME_OWNER_NATIVE_REGISTRATION_OPERATION_NAMES,
  RUNTIME_OWNER_NATIVE_ROOT_OPERATION_NAMES,
  type RuntimeOwnerCollaboratorDetachContext,
  type RuntimeOwnerHostStateDatabase,
  type RuntimeOwnerKeyCustodyValidator,
  type RuntimeOwnerLease,
  type RuntimeOwnerLeaseAcquireRequest,
  type RuntimeOwnerLeaseController,
  type RuntimeOwnerLeaseHeartbeatRequest,
  type RuntimeOwnerLeaseReleaseRequest,
  type RuntimeOwnerProcessStartIdentity,
  type RuntimeOwnerRpcServerHandle,
  type RuntimeOwnerService,
  startRuntimeOwnerService,
} from "./service.js";

let identityCounter = 1;

function machineIdentity(): string {
  return (identityCounter++).toString(16).padStart(32, "0");
}

function secret(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => index + 1);
}

function encodedBytes(length: number, fill: number): string {
  return base64urlEncode(new Uint8Array(length).fill(fill));
}

function nativeRuntime(fill: number) {
  return parseA1CanonicalId("nativeRuntime", `rcrt_${encodedBytes(32, fill)}`);
}

function nativeBinding(fill: number) {
  return parseA1CanonicalId("nativeBinding", `rcnb_${encodedBytes(16, fill)}`);
}

function collaborationServer(fill: number) {
  return parseA1CanonicalId("collaborationServer", `rcs_${encodedBytes(16, fill)}`);
}

function coordinatorLease(fill: number) {
  return parseA1CanonicalId("coordinatorLease", `rccl_${encodedBytes(16, fill)}`);
}

function ownerIdentity(machineIdentityId: string): RuntimeOwnerProcessStartIdentity {
  const pid = 4242;
  const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "123456"];
  return readLinuxRuntimeOwnerProcessStartIdentity(machineIdentityId, {
    pid,
    readTextFile: (path) =>
      path.endsWith("boot_id")
        ? "12345678-1234-1234-1234-123456789abc\n"
        : `${pid} (remote claw test) ${fields.join(" ")}\n`,
  });
}

class FakeDatabase implements RuntimeOwnerHostStateDatabase {
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  close(): void {
    this.events.push("database.close");
  }
}

interface FakeLeaseControllerOptions {
  readonly events: string[];
  readonly now?: () => number;
  readonly heartbeatFails?: boolean;
  readonly beforeRelease?: () => Promise<void>;
}

class FakeLeaseController implements RuntimeOwnerLeaseController<FakeDatabase> {
  readonly events: string[];
  readonly heartbeatRequests: RuntimeOwnerLeaseHeartbeatRequest[] = [];
  readonly #now: () => number;
  readonly #heartbeatFails: boolean;
  readonly #beforeRelease: (() => Promise<void>) | undefined;
  current: RuntimeOwnerLease | undefined;
  epoch = 0;

  constructor(options: FakeLeaseControllerOptions) {
    this.events = options.events;
    this.#now = options.now ?? Date.now;
    this.#heartbeatFails = options.heartbeatFails ?? false;
    this.#beforeRelease = options.beforeRelease;
  }

  acquireOrReconcile(
    _database: FakeDatabase,
    request: RuntimeOwnerLeaseAcquireRequest,
  ): RuntimeOwnerLease {
    this.events.push("lease.acquire");
    if (this.current !== undefined && this.current.heartbeatDeadlineMs > this.#now()) {
      throw new Error("already owned");
    }
    this.epoch++;
    this.current = Object.freeze({
      machineIdentityId: request.machineIdentityId,
      runtimeOwnerServiceLeaseId: request.candidateLeaseId,
      runtimeOwnerServiceEpoch: this.epoch,
      ownerInstanceId: request.ownerInstanceId,
      ownerStartIdentitySchemaId: request.ownerStartIdentitySchemaId,
      ownerStartIdentityRef: request.ownerStartIdentityRef,
      ownerStartIdentityDigest: request.ownerStartIdentityDigest,
      heartbeatDeadlineMs: this.#now() + request.leaseDurationMs,
    });
    return this.current;
  }

  heartbeatOrReconcile(
    _database: FakeDatabase,
    request: RuntimeOwnerLeaseHeartbeatRequest,
  ): RuntimeOwnerLease {
    this.events.push("lease.heartbeat");
    this.heartbeatRequests.push(request);
    if (this.#heartbeatFails || this.current === undefined) throw new Error("lost");
    if (
      request.runtimeOwnerServiceLeaseId !== this.current.runtimeOwnerServiceLeaseId ||
      request.runtimeOwnerServiceEpoch !== this.current.runtimeOwnerServiceEpoch ||
      request.expectedHeartbeatDeadlineMs !== this.current.heartbeatDeadlineMs
    ) {
      throw new Error("stale");
    }
    this.current = Object.freeze({
      ...this.current,
      heartbeatDeadlineMs: Math.max(
        this.current.heartbeatDeadlineMs + 1,
        this.#now() + request.leaseDurationMs,
      ),
    });
    return this.current;
  }

  async releaseOrReconcile(
    _database: FakeDatabase,
    request: RuntimeOwnerLeaseReleaseRequest,
  ): Promise<void> {
    await this.#beforeRelease?.();
    this.events.push("lease.release");
    if (
      this.current === undefined ||
      request.runtimeOwnerServiceLeaseId !== this.current.runtimeOwnerServiceLeaseId ||
      request.runtimeOwnerServiceEpoch !== this.current.runtimeOwnerServiceEpoch
    ) {
      throw new Error("stale release");
    }
    this.current = undefined;
  }
}

function databaseFactory(events: string[]): HostStateDatabaseFactory<FakeDatabase> {
  return {
    open: () => {
      events.push("database.open");
      return new FakeDatabase(events);
    },
  };
}

function custody(
  events: string[],
  observe?: (signer: RuntimeOwnerKeyCustodySigningCapability) => void,
): RuntimeOwnerKeyCustodyValidator<FakeDatabase> {
  return {
    validateBeforeWritable: (_database, signer) => {
      events.push("custody.validate");
      observe?.(signer);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function stopQuietly(service: RuntimeOwnerService<FakeDatabase> | undefined): Promise<void> {
  await service?.stop().catch(() => undefined);
}

describe.skipIf(process.platform !== "linux")("runtime-owner service lifecycle", () => {
  it("opens once, validates custody, serves fenced operations, and closes in order", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    let rpcClosedBeforeRelease = false;
    const controller = new FakeLeaseController({
      events,
      beforeRelease: async () => {
        try {
          await connectRuntimeOwnerRpc({
            machineIdentityId,
            identitySecret: rootSecret,
            handshakeTimeoutMs: 50,
          });
        } catch {
          rpcClosedBeforeRelease = true;
        }
      },
    });
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: controller,
      keyCustodyValidator: custody(events),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
      operations: [
        {
          name: "inventory.read",
          execute: async (payload, context) => {
            const generated = context.custodySigner.generateIdentityKey(nativeRuntime(62), 1);
            return {
              payload,
              epoch: context.assertCurrent().runtimeOwnerServiceEpoch,
              signerMethods: Object.keys(context.custodySigner).sort(),
              generatedKeyId: generated.binding.runtimeOwnerIdentityKeyId,
              exposesLifecycle: "close" in context.custodySigner,
            };
          },
        },
      ],
    });
    const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: rootSecret });
    try {
      await expect(client.health()).resolves.toMatchObject({
        status: "ok",
        ownerOperationsWritable: true,
        nativeRegistrationEnabled: false,
      });
      await expect(
        client.dispatch({ operation: "inventory.read", payload: { page: 1 } }),
      ).resolves.toEqual({
        payload: { page: 1 },
        epoch: 1,
        signerMethods: ["assertUsable", "generateIdentityKey", "sign"],
        generatedKeyId: expect.stringMatching(/^roik_/),
        exposesLifecycle: false,
      });
      await service.stop();
      expect(rpcClosedBeforeRelease).toBe(true);
      expect(events).toEqual([
        "database.open",
        "lease.acquire",
        "custody.validate",
        "lease.release",
        "database.close",
      ]);
      expect(service.state).toBe("stopped");
    } finally {
      client.close();
      await stopQuietly(service);
    }
  });

  it("binds callable ports to the authenticated connection and exact live owner fence", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const collaborationServerId = collaborationServer(70);
    const nativeBindingId = nativeBinding(71);
    const runtimeId = nativeRuntime(72);
    const coordinatorFence = {
      collaborationServerId,
      coordinatorLeaseId: coordinatorLease(73),
      coordinatorEpoch: 4,
    } as const;
    let authenticatedConnectionId: string | undefined;
    let callablePortRef:
      | Extract<ReturnType<typeof parseProtectedHandleRef>, { readonly kind: "callable_port" }>
      | undefined;
    let retainedUnregister: (() => boolean) | undefined;
    let receivedConnectionId: string | undefined;
    let receivedOwnerLeaseId: string | undefined;
    let receivedOwnerEpoch: number | undefined;
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: new FakeLeaseController({ events }),
      keyCustodyValidator: custody(events),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
      operations: [
        {
          name: "test.port.register",
          execute: async (_payload, context) => {
            authenticatedConnectionId = context.connectionId;
            const registered = context.callablePort.register({
              nativeBindingId,
              runtimeId,
              nativeIncarnation: 2,
              attachmentLeaseId: parseA1SafeId("attachment-live-1"),
              coordinatorFence,
              portGeneration: 3,
              // These forged fields are deliberately ignored by the request-scoped capability.
              connectionId: encodedBytes(16, 99),
              ownerFence: { runtimeOwnerServiceEpoch: 999 },
              collaborationServerId: collaborationServer(99),
            } as never);
            callablePortRef = registered;
            retainedUnregister = () => context.callablePort.unregister(registered);
            return registered;
          },
        },
        {
          name: "test.port.invoke",
          execute: async (_payload, context) => {
            if (callablePortRef === undefined) throw new Error("port was not registered");
            const result = await context.callablePort.invoke({
              nativeIncarnation: 2,
              attachmentLeaseId: parseA1SafeId("attachment-live-1"),
              portGeneration: 3,
              request: {
                scopeKind: "native_binding",
                scopeId: nativeBindingId,
                callablePortRef,
                providerCredential: null,
                nativeBindingId,
                runtimeId,
                fence: coordinatorFence,
                operationSchemaId: "remote-claw/test-port-operation/v1",
                operationRef: parseA1SafeId("operation-live-1"),
                operationDigest: parseA1Digest(encodedBytes(32, 74)),
              },
              connectionId: encodedBytes(16, 98),
              ownerFence: { runtimeOwnerServiceEpoch: 998 },
            } as never);
            return {
              resultSchemaId: result.resultSchemaId,
              resultRef: result.resultRef,
              resultDigest: result.resultDigest,
            };
          },
        },
        {
          name: "test.port.unregister",
          execute: async (_payload, context) => {
            if (callablePortRef === undefined) throw new Error("port was not registered");
            return context.callablePort.unregister(callablePortRef);
          },
        },
      ],
    });
    const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: rootSecret });
    try {
      const registered = parseProtectedHandleRef(
        await client.dispatch({ operation: "test.port.register", payload: null }),
      );
      if (registered.kind !== "callable_port") throw new Error("unexpected protected handle kind");
      callablePortRef = registered;
      expect(() => retainedUnregister?.()).toThrow(/lease was lost/);
      client.registerCallablePort(registered, (invocation) => {
        receivedConnectionId = invocation.connectionId;
        receivedOwnerLeaseId = invocation.ownerFence.runtimeOwnerServiceLeaseId;
        receivedOwnerEpoch = invocation.ownerFence.runtimeOwnerServiceEpoch;
        return {
          ...invocation.request,
          resultSchemaId: "remote-claw/test-port-result/v1",
          resultRef: parseA1SafeId("result-live-1"),
          resultDigest: parseA1Digest(encodedBytes(32, 75)),
        };
      });

      await expect(
        client.dispatch({ operation: "test.port.invoke", payload: null }),
      ).resolves.toMatchObject({ resultRef: "result-live-1" });
      expect(receivedConnectionId).toBe(authenticatedConnectionId);
      expect(receivedOwnerLeaseId).toBe(service.lease.runtimeOwnerServiceLeaseId);
      expect(receivedOwnerEpoch).toBe(service.lease.runtimeOwnerServiceEpoch);
      await expect(
        client.dispatch({ operation: "test.port.unregister", payload: null }),
      ).resolves.toBe(true);
    } finally {
      client.close();
      await stopQuietly(service);
    }
  });

  it("allows the exact registration and terminal-root sets plus unrelated operations", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: new FakeLeaseController({ events }),
      keyCustodyValidator: custody(events),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
      operations: [
        ...RUNTIME_OWNER_NATIVE_REGISTRATION_OPERATION_NAMES,
        ...RUNTIME_OWNER_NATIVE_ROOT_OPERATION_NAMES,
        "inventory.read",
      ].map((name) => ({ name, execute: async () => null })),
      onCollaboratorDetach: async () => {},
    });
    const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: rootSecret });
    try {
      await expect(client.health()).resolves.toMatchObject({
        ownerOperationsWritable: true,
        nativeRegistrationEnabled: true,
      });
    } finally {
      client.close();
      await stopQuietly(service);
    }
  });

  it.each([
    { names: RUNTIME_OWNER_NATIVE_REGISTRATION_OPERATION_NAMES.slice(0, -1) },
    {
      names: [...RUNTIME_OWNER_NATIVE_REGISTRATION_OPERATION_NAMES, "native.registration.debug"],
    },
  ])("rejects a partial or extended reserved registration namespace", async ({ names }) => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    await expect(
      startRuntimeOwnerService({
        machineIdentityId,
        identitySecret: secret(),
        ownerIdentity: ownerIdentity(machineIdentityId),
        databaseFactory: databaseFactory(events),
        leaseController: new FakeLeaseController({ events }),
        keyCustodyValidator: custody(events),
        operations: names.map((name) => ({ name, execute: async () => null })),
        onCollaboratorDetach: async () => {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(events).toEqual([]);
  });

  it("rejects the native registration operation set without durable detach cleanup", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    await expect(
      startRuntimeOwnerService({
        machineIdentityId,
        identitySecret: secret(),
        ownerIdentity: ownerIdentity(machineIdentityId),
        databaseFactory: databaseFactory(events),
        leaseController: new FakeLeaseController({ events }),
        keyCustodyValidator: custody(events),
        operations: RUNTIME_OWNER_NATIVE_REGISTRATION_OPERATION_NAMES.map((name) => ({
          name,
          execute: async () => null,
        })),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(events).toEqual([]);
  });

  it.each([
    { names: RUNTIME_OWNER_NATIVE_ROOT_OPERATION_NAMES },
    {
      names: [
        ...RUNTIME_OWNER_NATIVE_REGISTRATION_OPERATION_NAMES,
        ...RUNTIME_OWNER_NATIVE_ROOT_OPERATION_NAMES,
        "native.root.debug",
      ],
    },
  ])("rejects a standalone or extended reserved terminal-root namespace", async ({ names }) => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    await expect(
      startRuntimeOwnerService({
        machineIdentityId,
        identitySecret: secret(),
        ownerIdentity: ownerIdentity(machineIdentityId),
        databaseFactory: databaseFactory(events),
        leaseController: new FakeLeaseController({ events }),
        keyCustodyValidator: custody(events),
        operations: names.map((name) => ({ name, execute: async () => null })),
        onCollaboratorDetach: async () => {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(events).toEqual([]);
  });

  it("passes dropped port tuples to detach cleanup and drains it before releasing the lease", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const collaborationServerId = collaborationServer(76);
    const nativeBindingId = nativeBinding(77);
    const runtimeId = nativeRuntime(78);
    let detachContext: RuntimeOwnerCollaboratorDetachContext | undefined;
    let announceDetach: (() => void) | undefined;
    const detachStarted = new Promise<void>((resolve) => {
      announceDetach = resolve;
    });
    let finishDetach: (() => void) | undefined;
    const detachHeld = new Promise<void>((resolve) => {
      finishDetach = resolve;
    });
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: new FakeLeaseController({ events }),
      keyCustodyValidator: custody(events),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
      operations: [
        {
          name: "test.port.register",
          execute: async (_payload, context) =>
            context.callablePort.register({
              nativeBindingId,
              runtimeId,
              nativeIncarnation: 5,
              attachmentLeaseId: parseA1SafeId("attachment-detach-1"),
              coordinatorFence: {
                collaborationServerId,
                coordinatorLeaseId: coordinatorLease(79),
                coordinatorEpoch: 6,
              },
              portGeneration: 7,
            }),
        },
      ],
      onCollaboratorDetach: async (context) => {
        context.assertCurrent();
        detachContext = context;
        announceDetach?.();
        await detachHeld;
        context.assertCurrent();
      },
    });
    const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: rootSecret });
    try {
      await client.dispatch({ operation: "test.port.register", payload: null });
      let stopSettled = false;
      const stopped = service.stop().finally(() => {
        stopSettled = true;
      });
      await detachStarted;
      expect(stopSettled).toBe(false);
      expect(events).not.toContain("lease.release");
      expect(detachContext?.callablePorts).toHaveLength(1);
      expect(detachContext?.callablePorts[0]).toMatchObject({
        collaborationServerId,
        nativeBindingId,
        runtimeId,
        nativeIncarnation: 5,
        attachmentLeaseId: "attachment-detach-1",
        portGeneration: 7,
        connectionId: detachContext?.connectionId,
        ownerFence: {
          runtimeOwnerServiceLeaseId: service.lease.runtimeOwnerServiceLeaseId,
          runtimeOwnerServiceEpoch: service.lease.runtimeOwnerServiceEpoch,
        },
      });
      finishDetach?.();
      await expect(stopped).resolves.toBeUndefined();
      expect(events).toContain("lease.release");
      expect(() => detachContext?.assertCurrent()).toThrow(/lease was lost/);
    } finally {
      client.close();
      finishDetach?.();
      await stopQuietly(service);
    }
  });

  it("bounds and observes a detach cleanup that ignores abort", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    let detachSignal: AbortSignal | undefined;
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: new FakeLeaseController({ events }),
      keyCustodyValidator: custody(events),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
      operationDrainTimeoutMs: 25,
      onCollaboratorDetach: async (context) => {
        detachSignal = context.signal;
        await new Promise<void>(() => undefined);
      },
    });
    const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: rootSecret });
    try {
      await client.health();
      await expect(service.stop()).rejects.toMatchObject({ code: "SHUTDOWN_FAILED" });
      expect(detachSignal?.aborted).toBe(true);
      expect(service.state).toBe("poisoned");
      expect(events).not.toContain("lease.release");
      await expect(service.completed).resolves.toBeUndefined();
    } finally {
      client.close();
      await stopQuietly(service);
    }
  });

  it("allows only one service to win a two-start race without disturbing it", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const controller = new FakeLeaseController({ events });
    const options = {
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: controller,
      keyCustodyValidator: custody(events),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
    } as const;
    const [left, right] = await Promise.allSettled([
      startRuntimeOwnerService(options),
      startRuntimeOwnerService(options),
    ]);
    const winner =
      left.status === "fulfilled"
        ? left.value
        : right.status === "fulfilled"
          ? right.value
          : undefined;
    try {
      expect(winner).toBeDefined();
      expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);
      const client = await connectRuntimeOwnerRpc({
        machineIdentityId,
        identitySecret: rootSecret,
      });
      await expect(client.health()).resolves.toMatchObject({
        status: "ok",
        ownerOperationsWritable: false,
        nativeRegistrationEnabled: false,
      });
      client.close();
    } finally {
      await stopQuietly(winner);
    }
  });

  it("poisons on heartbeat loss, aborts work, closes RPC, and never releases a stale lease", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const controller = new FakeLeaseController({ events, heartbeatFails: true });
    let custodySigner: RuntimeOwnerKeyCustodySigner | undefined;
    let operationContext:
      | Parameters<
          NonNullable<
            Parameters<typeof startRuntimeOwnerService>[0]["operations"]
          >[number]["execute"]
        >[1]
      | undefined;
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: controller,
      keyCustodyValidator: custody(events),
      createCustodySigner: (value) => {
        custodySigner = createRuntimeOwnerKeyCustodySigner(value);
        return custodySigner;
      },
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      operations: [
        {
          name: "hold",
          execute: async (_payload, context) => {
            operationContext = context;
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            context.assertCurrent();
            return null;
          },
        },
      ],
    });
    const signalTarget = new EventEmitter();
    const daemon = new RuntimeOwnerDaemon(service, signalTarget);
    const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: rootSecret });
    const pending = client.dispatch({ operation: "hold", payload: null }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitFor(() => operationContext !== undefined);
    await waitFor(() => service.state === "poisoned");
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(Error);
    expect(operationContext?.signal.aborted).toBe(true);
    expect(() => operationContext?.assertCurrent()).toThrow(/lease was lost/);
    const stalePort = parseProtectedHandleRef({
      protectedHandleId: `rcph_${encodedBytes(16, 61)}`,
      kind: "callable_port",
    });
    if (stalePort.kind !== "callable_port") throw new Error("unexpected protected handle kind");
    expect(() => operationContext?.callablePort.unregister(stalePort)).toThrow(/lease was lost/);
    expect(events).toContain("lease.heartbeat");
    expect(events).not.toContain("lease.release");
    expect(events.at(-1)).toBe("database.close");
    await expect(daemon.completed).resolves.toBeUndefined();
    expect(custodySigner?.closed).toBe(true);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
    client.close();
  });

  it("zeroes the signer input, closes its derived key, and never mutates the caller secret", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const original = Uint8Array.from(rootSecret);
    let signerInput: Uint8Array | undefined;
    let signer: RuntimeOwnerKeyCustodySigner | undefined;
    let signingCapability: RuntimeOwnerKeyCustodySigningCapability | undefined;
    const controller = new FakeLeaseController({ events });
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: controller,
      keyCustodyValidator: custody(events, (value) => {
        signingCapability = value;
      }),
      createCustodySigner: (value) => {
        signerInput = value;
        signer = createRuntimeOwnerKeyCustodySigner(value);
        return signer;
      },
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
    });
    try {
      expect(rootSecret).toEqual(original);
      expect(signerInput).toEqual(new Uint8Array(32));
      expect(signer?.closed).toBe(false);
      expect(Object.keys(signingCapability ?? {})).toEqual([
        "generateIdentityKey",
        "sign",
        "assertUsable",
      ]);
    } finally {
      await service.stop();
    }
    expect(signer?.closed).toBe(true);
  });

  it("poisons without renewing or releasing when its RPC listener becomes unreachable", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const controller = new FakeLeaseController({ events });
    let listening = true;
    const rpcServer: RuntimeOwnerRpcServerHandle = {
      get listening() {
        return listening;
      },
      registerCallablePort: () => {
        throw new Error("not reached");
      },
      unregisterCallablePort: () => false,
      invokeCallablePort: async () => {
        throw new Error("not reached");
      },
      close: async () => {
        events.push("rpc.close");
        listening = false;
      },
    };
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: secret(),
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: controller,
      keyCustodyValidator: custody(events),
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      startRpcServer: async () => rpcServer,
    });

    listening = false;
    await waitFor(() => service.state === "poisoned");
    await waitFor(() => events.at(-1) === "database.close");
    expect(controller.heartbeatRequests).toHaveLength(0);
    expect(events).toContain("rpc.close");
    expect(events).not.toContain("lease.release");
  });

  it("observes an automatic poison-shutdown rejection while preserving it for stop", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const controller = new FakeLeaseController({ events });
    const unhandledRejections: unknown[] = [];
    const observeUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    let listening = true;
    const rpcServer: RuntimeOwnerRpcServerHandle = {
      get listening() {
        return listening;
      },
      registerCallablePort: () => {
        throw new Error("not reached");
      },
      unregisterCallablePort: () => false,
      invokeCallablePort: async () => {
        throw new Error("not reached");
      },
      close: async () => {
        listening = false;
        throw new Error("injected RPC close failure");
      },
    };
    process.on("unhandledRejection", observeUnhandledRejection);
    try {
      const service = await startRuntimeOwnerService({
        machineIdentityId,
        identitySecret: secret(),
        ownerIdentity: ownerIdentity(machineIdentityId),
        databaseFactory: databaseFactory(events),
        leaseController: controller,
        keyCustodyValidator: custody(events),
        leaseDurationMs: 100,
        heartbeatIntervalMs: 10,
        startRpcServer: async () => rpcServer,
      });

      listening = false;
      await service.completed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
      await expect(service.stop()).rejects.toMatchObject({ code: "SHUTDOWN_FAILED" });
      expect(service.state).toBe("poisoned");
      expect(events).not.toContain("lease.release");
      expect(events.at(-1)).toBe("database.close");
    } finally {
      process.off("unhandledRejection", observeUnhandledRejection);
    }
  });

  it("bounds shutdown draining when an active operation ignores abort", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const controller = new FakeLeaseController({ events });
    let operationStarted = false;
    const service = await startRuntimeOwnerService({
      machineIdentityId,
      identitySecret: rootSecret,
      ownerIdentity: ownerIdentity(machineIdentityId),
      databaseFactory: databaseFactory(events),
      leaseController: controller,
      keyCustodyValidator: custody(events),
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 3_000,
      operationDrainTimeoutMs: 25,
      operations: [
        {
          name: "ignore_abort",
          execute: async () => {
            operationStarted = true;
            await new Promise<void>(() => undefined);
            return null;
          },
        },
      ],
    });
    const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: rootSecret });
    const dispatch = client
      .dispatch({ operation: "ignore_abort", payload: null })
      .catch((error: unknown) => error);
    try {
      await waitFor(() => operationStarted);
      await expect(service.stop()).rejects.toMatchObject({ code: "SHUTDOWN_FAILED" });
      await expect(service.completed).resolves.toBeUndefined();
      await expect(dispatch).resolves.toBeInstanceOf(Error);
      expect(service.state).toBe("poisoned");
      expect(events).not.toContain("lease.release");
      expect(events.at(-1)).toBe("database.close");
    } finally {
      client.close();
      await stopQuietly(service);
    }
  });

  it("never releases a mismatched acquire result that could belong to an incumbent", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const identity = ownerIdentity(machineIdentityId);
    let releaseCalls = 0;
    const controller: RuntimeOwnerLeaseController<FakeDatabase> = {
      acquireOrReconcile: () => ({
        machineIdentityId,
        runtimeOwnerServiceLeaseId: "rosl_incumbent",
        runtimeOwnerServiceEpoch: 9,
        ownerInstanceId: "roi_incumbent",
        ownerStartIdentitySchemaId: identity.schemaId,
        ownerStartIdentityRef: identity.ownerStartIdentityRef,
        ownerStartIdentityDigest: identity.canonicalDigest,
        heartbeatDeadlineMs: Date.now() + 60_000,
      }),
      heartbeatOrReconcile: () => {
        throw new Error("not reached");
      },
      releaseOrReconcile: () => {
        releaseCalls++;
      },
    };

    await expect(
      startRuntimeOwnerService({
        machineIdentityId,
        identitySecret: secret(),
        ownerIdentity: identity,
        databaseFactory: databaseFactory(events),
        leaseController: controller,
        keyCustodyValidator: custody(events),
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(releaseCalls).toBe(0);
    expect(events).toEqual(["database.open", "database.close"]);
  });

  it("closes a bound RPC listener if startup fails while scheduling its heartbeat", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    const controller = new FakeLeaseController({ events });
    let clockReads = 0;
    let custodySigner: RuntimeOwnerKeyCustodySigner | undefined;

    await expect(
      startRuntimeOwnerService({
        machineIdentityId,
        identitySecret: rootSecret,
        ownerIdentity: ownerIdentity(machineIdentityId),
        databaseFactory: databaseFactory(events),
        leaseController: controller,
        keyCustodyValidator: custody(events),
        createCustodySigner: (value) => {
          custodySigner = createRuntimeOwnerKeyCustodySigner(value);
          return custodySigner;
        },
        leaseDurationMs: 10_000,
        heartbeatIntervalMs: 3_000,
        now: () => {
          clockReads++;
          if (clockReads === 1) return Date.now();
          throw new Error("clock failed after RPC bind");
        },
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(
      connectRuntimeOwnerRpc({
        machineIdentityId,
        identitySecret: rootSecret,
        handshakeTimeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(custodySigner?.closed).toBe(true);
    expect(events).toEqual([
      "database.open",
      "lease.acquire",
      "custody.validate",
      "lease.release",
      "database.close",
    ]);
  });

  it("closes the signer and never binds RPC when key custody validation fails", async () => {
    const events: string[] = [];
    const machineIdentityId = machineIdentity();
    const rootSecret = secret();
    let custodySigner: RuntimeOwnerKeyCustodySigner | undefined;

    await expect(
      startRuntimeOwnerService({
        machineIdentityId,
        identitySecret: rootSecret,
        ownerIdentity: ownerIdentity(machineIdentityId),
        databaseFactory: databaseFactory(events),
        leaseController: new FakeLeaseController({ events }),
        keyCustodyValidator: {
          validateBeforeWritable: () => {
            events.push("custody.reject");
            throw new Error("wrapped private/public mismatch detail");
          },
        },
        createCustodySigner: (value) => {
          custodySigner = createRuntimeOwnerKeyCustodySigner(value);
          return custodySigner;
        },
      }),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "runtime owner service is unavailable",
    });
    expect(custodySigner?.closed).toBe(true);
    await expect(
      connectRuntimeOwnerRpc({
        machineIdentityId,
        identitySecret: rootSecret,
        handshakeTimeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(events).toEqual([
      "database.open",
      "lease.acquire",
      "custody.reject",
      "lease.release",
      "database.close",
    ]);
  });
});
