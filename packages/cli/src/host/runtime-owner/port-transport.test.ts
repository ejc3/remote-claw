import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "../state/ids.js";
import { RuntimeOwnerRpcAuthenticator, runtimeOwnerRpcSocketAddress } from "./auth.js";
import { connectRuntimeOwnerRpc, type RuntimeOwnerRpcClient } from "./client.js";
import type {
  RuntimeOwnerCallablePortEntry,
  RuntimeOwnerCallablePortRegistration,
} from "./port-registry.js";
import {
  encodeRuntimeOwnerRpcFrame,
  parseRuntimeOwnerRpcAuthenticated,
  parseRuntimeOwnerRpcChallenge,
  parseRuntimeOwnerRpcPortRequest,
  parseRuntimeOwnerRpcResponse,
  RUNTIME_OWNER_RPC_VERSION,
  RuntimeOwnerRpcFrameDecoder,
  type RuntimeOwnerRpcJsonValue,
  type RuntimeOwnerRpcPortInvocation,
  runtimeOwnerRpcPortSuccessResponse,
} from "./protocol.js";
import {
  type RuntimeOwnerRpcHandler,
  type RuntimeOwnerRpcServer,
  startRuntimeOwnerRpcServer,
} from "./server.js";

const machineIdentityId = "1234567890abcdef1234567890abcdef";

function bytes(length: number, fill: number): string {
  return base64urlEncode(new Uint8Array(length).fill(fill));
}

function secret(): Uint8Array {
  return new Uint8Array(32).fill(23);
}

function binding(fill: number) {
  return parseA1CanonicalId("nativeBinding", `rcnb_${bytes(16, fill)}`);
}

function runtime(fill: number) {
  return parseA1CanonicalId("nativeRuntime", `rcrt_${bytes(32, fill)}`);
}

function handler(overrides: Partial<RuntimeOwnerRpcHandler> = {}): RuntimeOwnerRpcHandler {
  return {
    health: async ({ connectionId }) => ({ connectionId }),
    dispatch: async () => null,
    ...overrides,
  };
}

function registration(connectionId: string, fill = 1): RuntimeOwnerCallablePortRegistration {
  const collaborationServerId = parseA1CanonicalId("collaborationServer", `rcs_${bytes(16, fill)}`);
  return {
    connectionId,
    collaborationServerId,
    nativeBindingId: binding(fill + 1),
    runtimeId: runtime(fill + 2),
    nativeIncarnation: 1,
    attachmentLeaseId: parseA1SafeId(`attachment-${fill}`),
    ownerFence: {
      runtimeOwnerServiceLeaseId: parseA1SafeId(`owner-lease-${fill}`),
      runtimeOwnerServiceEpoch: 1,
      ownerInstanceId: parseA1SafeId(`owner-${fill}`),
      ownerProcessStartIdentitySchemaId: "remote-claw/test-owner-start/v1",
      ownerProcessStartIdentityRef: parseA1SafeId(`owner-start-${fill}`),
      ownerProcessStartIdentityDigest: parseA1Digest(bytes(32, fill + 3)),
    },
    coordinatorFence: {
      collaborationServerId,
      coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", `rccl_${bytes(16, fill + 4)}`),
      coordinatorEpoch: 1,
    },
    portGeneration: fill,
  };
}

function invocation(entry: RuntimeOwnerCallablePortEntry): RuntimeOwnerRpcPortInvocation {
  return {
    connectionId: entry.connectionId,
    ownerFence: entry.ownerFence,
    nativeIncarnation: entry.nativeIncarnation,
    attachmentLeaseId: entry.attachmentLeaseId,
    portGeneration: entry.portGeneration,
    request: {
      scopeKind: "native_binding",
      scopeId: entry.nativeBindingId,
      callablePortRef: entry.callablePortRef,
      providerCredential: null,
      nativeBindingId: entry.nativeBindingId,
      runtimeId: entry.runtimeId,
      fence: entry.coordinatorFence,
      operationSchemaId: "remote-claw/test-port-operation/v1",
      operationRef: parseA1SafeId("operation-1"),
      operationDigest: parseA1Digest(bytes(32, 30)),
    },
  };
}

function connectionId(value: RuntimeOwnerRpcJsonValue): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("missing connection ID");
  }
  const record = value as { readonly [key: string]: RuntimeOwnerRpcJsonValue };
  if (typeof record.connectionId !== "string") throw new Error("missing connection ID");
  return record.connectionId;
}

class RawAuthenticatedPeer {
  readonly socket: Socket;
  readonly #decoder = new RuntimeOwnerRpcFrameDecoder();
  readonly #queued: RuntimeOwnerRpcJsonValue[] = [];
  readonly #waiters: Array<{
    resolve: (value: RuntimeOwnerRpcJsonValue) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      if (typeof chunk === "string") {
        socket.destroy();
        return;
      }
      try {
        for (const value of this.#decoder.push(chunk)) {
          const waiter = this.#waiters.shift();
          if (waiter === undefined) this.#queued.push(value);
          else waiter.resolve(value);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once("error", () => this.#reject());
    socket.once("close", () => this.#reject());
  }

  read(): Promise<RuntimeOwnerRpcJsonValue> {
    const value = this.#queued.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  write(value: unknown): void {
    this.socket.write(encodeRuntimeOwnerRpcFrame(value));
  }

  #reject(): void {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("socket closed"));
  }
}

async function connectRawAuthenticated(): Promise<RawAuthenticatedPeer> {
  const socket = createConnection({ path: runtimeOwnerRpcSocketAddress(machineIdentityId) });
  socket.on("error", () => {
    // The fixed assertions below own transport failures.
  });
  await once(socket, "connect");
  const peer = new RawAuthenticatedPeer(socket);
  const authenticator = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, secret());
  try {
    const challenge = parseRuntimeOwnerRpcChallenge(await peer.read());
    expect(authenticator.verifyServerProof(challenge.challenge, challenge.serverProof)).toBe(true);
    peer.write({
      version: RUNTIME_OWNER_RPC_VERSION,
      type: "authenticate",
      challenge: challenge.challenge,
      clientProof: authenticator.createClientProof(challenge.challenge),
    });
    expect(parseRuntimeOwnerRpcAuthenticated(await peer.read()).challenge).toBe(
      challenge.challenge,
    );
    return peer;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    authenticator.close();
  }
}

async function close(
  client: RuntimeOwnerRpcClient | undefined,
  server: RuntimeOwnerRpcServer | undefined,
): Promise<void> {
  client?.close();
  await server?.close();
}

describe.skipIf(process.platform !== "linux")(
  "runtime-owner duplex callable-port transport",
  () => {
    it("invokes only the registered handler and drops it with the authenticated connection", async () => {
      let detachCount = -1;
      let detached: (() => void) | undefined;
      const detachedPromise = new Promise<void>((resolve) => {
        detached = resolve;
      });
      let server: RuntimeOwnerRpcServer | undefined;
      let client: RuntimeOwnerRpcClient | undefined;
      server = await startRuntimeOwnerRpcServer({
        machineIdentityId,
        identitySecret: secret(),
        handler: handler({
          detach: () => {
            detachCount = server?.callablePortCount ?? -1;
            detached?.();
          },
        }),
      });
      try {
        client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: secret() });
        const id = connectionId(await client.health());
        const entry = server.registerCallablePort(registration(id));
        let calls = 0;
        client.registerCallablePort(entry.callablePortRef, (received) => {
          calls++;
          expect(Object.isFrozen(received)).toBe(true);
          expect(received).toEqual(invocation(entry));
          return {
            ...received.request,
            resultSchemaId: "remote-claw/test-port-result/v1",
            resultRef: parseA1SafeId("result-1"),
            resultDigest: parseA1Digest(bytes(32, 31)),
          };
        });

        await expect(server.invokeCallablePort(invocation(entry))).resolves.toMatchObject({
          resultRef: "result-1",
        });
        expect(calls).toBe(1);
        expect(server.callablePortCount).toBe(1);

        client.close();
        await detachedPromise;
        expect(detachCount).toBe(0);
        expect(server.callablePortCount).toBe(0);
        await expect(server.invokeCallablePort(invocation(entry))).rejects.toMatchObject({
          code: "UNAVAILABLE",
        });
      } finally {
        await close(client, server);
      }
    });

    it("enrolls authenticated detach before server close settles", async () => {
      let detachStarted = false;
      let releaseDetach: (() => void) | undefined;
      const detachHeld = new Promise<void>((resolve) => {
        releaseDetach = resolve;
      });
      const server = await startRuntimeOwnerRpcServer({
        machineIdentityId,
        identitySecret: secret(),
        handler: handler({
          detach: async () => {
            detachStarted = true;
            await detachHeld;
          },
        }),
      });
      let client: RuntimeOwnerRpcClient | undefined;
      try {
        client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: secret() });
        await client.health();
        await server.close();
        expect(detachStarted).toBe(true);
      } finally {
        releaseDetach?.();
        await close(client, server);
      }
    });

    it("bounds reverse in-flight work and rejects a changed echoed request", async () => {
      const server = await startRuntimeOwnerRpcServer({
        machineIdentityId,
        identitySecret: secret(),
        maxReverseInFlight: 1,
        handler: handler(),
      });
      let client: RuntimeOwnerRpcClient | undefined;
      try {
        client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: secret() });
        const id = connectionId(await client.health());
        const entry = server.registerCallablePort(registration(id));
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        client.registerCallablePort(entry.callablePortRef, async (received) => {
          await held;
          return {
            ...received.request,
            resultSchemaId: "remote-claw/test-port-result/v1",
            resultRef: parseA1SafeId("result-1"),
            resultDigest: parseA1Digest(bytes(32, 32)),
          };
        });
        const first = server.invokeCallablePort(invocation(entry));
        await expect(server.invokeCallablePort(invocation(entry))).rejects.toMatchObject({
          code: "TOO_MANY_IN_FLIGHT",
        });
        release?.();
        await expect(first).resolves.toMatchObject({ resultRef: "result-1" });

        client.unregisterCallablePort(entry.callablePortRef);
        client.registerCallablePort(entry.callablePortRef, (received) => ({
          ...received.request,
          operationRef: parseA1SafeId("changed-operation"),
          resultSchemaId: "remote-claw/test-port-result/v1",
          resultRef: parseA1SafeId("result-2"),
          resultDigest: parseA1Digest(bytes(32, 33)),
        }));
        await expect(server.invokeCallablePort(invocation(entry))).rejects.toMatchObject({
          code: "PROTOCOL_ERROR",
        });
        await expect.poll(() => client?.closed).toBe(true);
      } finally {
        await close(client, server);
      }
    });

    it("rejects a replayed reverse response and invalidates its connection ports", async () => {
      const server = await startRuntimeOwnerRpcServer({
        machineIdentityId,
        identitySecret: secret(),
        handler: handler(),
      });
      let peer: RawAuthenticatedPeer | undefined;
      try {
        peer = await connectRawAuthenticated();
        peer.write({
          version: RUNTIME_OWNER_RPC_VERSION,
          type: "request",
          requestId: bytes(16, 40),
          method: "health",
          params: null,
        });
        const health = parseRuntimeOwnerRpcResponse(await peer.read());
        if (!health.ok) throw new Error("health failed");
        const entry = server.registerCallablePort(registration(connectionId(health.result)));
        const pending = server.invokeCallablePort(invocation(entry));
        const request = parseRuntimeOwnerRpcPortRequest(await peer.read());
        const response = runtimeOwnerRpcPortSuccessResponse(request.reverseRequestId, {
          ...request.invocation.request,
          resultSchemaId: "remote-claw/test-port-result/v1",
          resultRef: parseA1SafeId("result-replay"),
          resultDigest: parseA1Digest(bytes(32, 41)),
        });
        peer.write(response);
        await expect(pending).resolves.toMatchObject({ resultRef: "result-replay" });

        peer.write(response);
        await expect.poll(() => peer?.socket.destroyed).toBe(true);
        await expect.poll(() => server.callablePortCount).toBe(0);
      } finally {
        peer?.socket.destroy();
        await server.close();
      }
    });

    it("closes at the per-connection reverse request budget", async () => {
      const server = await startRuntimeOwnerRpcServer({
        machineIdentityId,
        identitySecret: secret(),
        maxReverseRequestsPerConnection: 1,
        handler: handler(),
      });
      let client: RuntimeOwnerRpcClient | undefined;
      try {
        client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: secret() });
        const entry = server.registerCallablePort(
          registration(connectionId(await client.health())),
        );
        client.registerCallablePort(entry.callablePortRef, (received) => ({
          ...received.request,
          resultSchemaId: "remote-claw/test-port-result/v1",
          resultRef: parseA1SafeId("result-budget"),
          resultDigest: parseA1Digest(bytes(32, 42)),
        }));
        await expect(server.invokeCallablePort(invocation(entry))).resolves.toMatchObject({
          resultRef: "result-budget",
        });
        await expect(server.invokeCallablePort(invocation(entry))).rejects.toMatchObject({
          code: "CLOSED",
        });
        await expect.poll(() => client?.closed).toBe(true);
        await expect.poll(() => server.callablePortCount).toBe(0);
      } finally {
        await close(client, server);
      }
    });

    it("times out, closes the late-response channel, and enforces local port/request budgets", async () => {
      const server = await startRuntimeOwnerRpcServer({
        machineIdentityId,
        identitySecret: secret(),
        reverseRequestTimeoutMs: 20,
        handler: handler(),
      });
      let client: RuntimeOwnerRpcClient | undefined;
      try {
        client = await connectRuntimeOwnerRpc({
          machineIdentityId,
          identitySecret: secret(),
          requestTimeoutMs: 1_000,
          maxCallablePorts: 1,
        });
        const id = connectionId(await client.health());
        const entry = server.registerCallablePort(registration(id));
        const second = server.registerCallablePort(registration(id, 10));
        client.registerCallablePort(entry.callablePortRef, () => new Promise(() => undefined));
        expect(() =>
          client?.registerCallablePort(second.callablePortRef, () => null as never),
        ).toThrow(expect.objectContaining({ code: "TOO_MANY_IN_FLIGHT" }));

        await expect(server.invokeCallablePort(invocation(entry))).rejects.toMatchObject({
          code: "TIMEOUT",
        });
        await expect(server.invokeCallablePort(invocation(entry))).rejects.toMatchObject({
          code: "UNAVAILABLE",
        });
        await expect.poll(() => server.callablePortCount).toBe(0);
      } finally {
        await close(client, server);
      }
    });
  },
);
