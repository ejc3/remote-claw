import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { RuntimeOwnerRpcAuthenticator, runtimeOwnerRpcSocketAddress } from "./auth.js";
import { connectRuntimeOwnerRpc } from "./client.js";
import {
  encodeRuntimeOwnerRpcFrame,
  parseRuntimeOwnerRpcAuthenticated,
  parseRuntimeOwnerRpcChallenge,
  parseRuntimeOwnerRpcResponse,
  RUNTIME_OWNER_RPC_MAX_CONNECTIONS,
  RUNTIME_OWNER_RPC_MAX_FRAME_BYTES,
  RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
  RUNTIME_OWNER_RPC_MAX_PREAUTH_BYTES,
  RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION,
  RUNTIME_OWNER_RPC_VERSION,
  RuntimeOwnerRpcError,
  RuntimeOwnerRpcFrameDecoder,
  type RuntimeOwnerRpcJsonValue,
} from "./protocol.js";
import {
  type RuntimeOwnerRpcHandler,
  type RuntimeOwnerRpcServer,
  startRuntimeOwnerRpcServer,
} from "./server.js";

const machineIdentityId = "fedcba9876543210fedcba9876543210";

function secret(fill = 9): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => fill);
}

function requestId(fill: number): string {
  return base64urlEncode(Uint8Array.from({ length: 16 }, () => fill));
}

function handler(overrides: Partial<RuntimeOwnerRpcHandler> = {}): RuntimeOwnerRpcHandler {
  return {
    health: async () => ({ status: "ok" }),
    dispatch: async (request) => ({ operation: request.operation, payload: request.payload }),
    ...overrides,
  };
}

class RawPeer {
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
      } catch (error) {
        this.#reject(error instanceof Error ? error : new Error("protocol error"));
        socket.destroy();
      }
    });
    socket.once("error", () => this.#reject(new Error("socket error")));
    socket.once("close", () => this.#reject(new Error("socket closed")));
  }

  read(): Promise<RuntimeOwnerRpcJsonValue> {
    const value = this.#queued.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  write(value: unknown): void {
    this.socket.write(encodeRuntimeOwnerRpcFrame(value));
  }

  #reject(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

async function connectRaw(): Promise<RawPeer> {
  const socket = createConnection({ path: runtimeOwnerRpcSocketAddress(machineIdentityId) });
  socket.on("error", () => {
    // Individual read/close assertions own the fixed test outcome.
  });
  await once(socket, "connect");
  return new RawPeer(socket);
}

async function authenticateRaw(
  identitySecret = secret(),
): Promise<Readonly<{ peer: RawPeer; authenticator: RuntimeOwnerRpcAuthenticator }>> {
  const peer = await connectRaw();
  const authenticator = await RuntimeOwnerRpcAuthenticator.create(
    machineIdentityId,
    identitySecret,
  );
  const challenge = parseRuntimeOwnerRpcChallenge(await peer.read());
  expect(authenticator.verifyServerProof(challenge.challenge, challenge.serverProof)).toBe(true);
  peer.write({
    version: RUNTIME_OWNER_RPC_VERSION,
    type: "authenticate",
    challenge: challenge.challenge,
    clientProof: authenticator.createClientProof(challenge.challenge),
  });
  expect(parseRuntimeOwnerRpcAuthenticated(await peer.read()).challenge).toBe(challenge.challenge);
  return { peer, authenticator };
}

async function closeServer(server: RuntimeOwnerRpcServer | undefined): Promise<void> {
  await server?.close();
}

describe("runtime-owner RPC server and client", () => {
  it("authenticates, serves only health/typed dispatch, and redacts handler errors", async () => {
    const thrownSecret = "HANDLER_SECRET_SENTINEL";
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handler: handler({
        dispatch: async (request) => {
          if (request.operation === "explode") throw new Error(thrownSecret);
          return { accepted: request.operation, payload: request.payload };
        },
      }),
    });
    let client: Awaited<ReturnType<typeof connectRuntimeOwnerRpc>> | undefined;
    try {
      client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: secret() });
      await expect(client.health()).resolves.toEqual({ status: "ok" });
      await expect(
        client.dispatch({ operation: "inventory.read", payload: { page: 1 } }),
      ).resolves.toEqual({ accepted: "inventory.read", payload: { page: 1 } });
      const failure = await client.dispatch({ operation: "explode", payload: null }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RuntimeOwnerRpcError);
      expect(String(failure)).toContain("runtime owner operation failed");
      expect(String(failure)).not.toContain(thrownSecret);
    } finally {
      client?.close();
      await closeServer(server);
    }
  });

  it("rejects a second owner on the same machine-scoped address", async () => {
    const first = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handler: handler(),
    });
    try {
      await expect(
        startRuntimeOwnerRpcServer({
          machineIdentityId,
          identitySecret: secret(),
          handler: handler(),
        }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    } finally {
      await first.close();
    }
  });

  it("fails mutual authentication with the wrong identity secret", async () => {
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handler: handler(),
    });
    try {
      await expect(
        connectRuntimeOwnerRpc({
          machineIdentityId,
          identitySecret: secret(10),
          handshakeTimeoutMs: 1_000,
        }),
      ).rejects.toBeInstanceOf(RuntimeOwnerRpcError);
    } finally {
      await server.close();
    }
  });

  it("closes a silent peer when the authentication handshake times out", async () => {
    let detachCalls = 0;
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handshakeTimeoutMs: 50,
      handler: handler({
        detach: () => {
          detachCalls++;
        },
      }),
    });
    let peer: RawPeer | undefined;
    try {
      peer = await connectRaw();
      const closed = once(peer.socket, "close");
      parseRuntimeOwnerRpcChallenge(await peer.read());
      await closed;
      expect(detachCalls).toBe(0);
      expect(server.listening).toBe(true);
    } finally {
      peer?.socket.destroy();
      await server.close();
    }
  });

  it("bounds unauthenticated connections and pre-authentication bytes", async () => {
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handler: handler(),
    });
    const peers: RawPeer[] = [];
    try {
      for (let index = 0; index < RUNTIME_OWNER_RPC_MAX_CONNECTIONS; index++) {
        const peer = await connectRaw();
        parseRuntimeOwnerRpcChallenge(await peer.read());
        peers.push(peer);
      }

      const overflow = createConnection({ path: runtimeOwnerRpcSocketAddress(machineIdentityId) });
      let overflowData = 0;
      overflow.on("data", (chunk) => {
        overflowData += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      });
      const overflowClosed = once(overflow, "close");
      await once(overflow, "connect");
      await overflowClosed;
      expect(overflowData).toBe(0);

      const released = peers.shift();
      const releasedClosed = released === undefined ? undefined : once(released.socket, "close");
      released?.socket.destroy();
      await releasedClosed;

      const admitted = await connectRaw();
      parseRuntimeOwnerRpcChallenge(await admitted.read());
      peers.push(admitted);

      const oversized = peers.pop();
      expect(oversized).toBeDefined();
      if (oversized !== undefined) {
        const oversizedClosed = once(oversized.socket, "close");
        const declaredFrame = Buffer.alloc(RUNTIME_OWNER_RPC_MAX_PREAUTH_BYTES + 1);
        declaredFrame.writeUInt32BE(RUNTIME_OWNER_RPC_MAX_FRAME_BYTES, 0);
        oversized.socket.write(declaredFrame.subarray(0, 512));
        oversized.socket.write(declaredFrame.subarray(512));
        await oversizedClosed;
      }
    } finally {
      for (const peer of peers) peer.socket.destroy();
      await server.close();
    }
  });

  it("accepts fragmented authentication and coalesced requests", async () => {
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handler: handler(),
    });
    const peer = await connectRaw();
    const authenticator = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, secret());
    try {
      const challenge = parseRuntimeOwnerRpcChallenge(await peer.read());
      const authentication = encodeRuntimeOwnerRpcFrame({
        version: RUNTIME_OWNER_RPC_VERSION,
        type: "authenticate",
        challenge: challenge.challenge,
        clientProof: authenticator.createClientProof(challenge.challenge),
      });
      peer.socket.write(authentication.subarray(0, 3));
      peer.socket.write(authentication.subarray(3));
      parseRuntimeOwnerRpcAuthenticated(await peer.read());

      const firstId = requestId(1);
      const secondId = requestId(2);
      peer.socket.write(
        Buffer.concat([
          encodeRuntimeOwnerRpcFrame({
            version: 1,
            type: "request",
            requestId: firstId,
            method: "health",
            params: null,
          }),
          encodeRuntimeOwnerRpcFrame({
            version: 1,
            type: "request",
            requestId: secondId,
            method: "dispatch",
            params: { operation: "echo", payload: "two" },
          }),
        ]),
      );
      const responses = [await peer.read(), await peer.read()] as Array<{
        requestId?: unknown;
      }>;
      expect(new Set(responses.map((response) => response.requestId))).toEqual(
        new Set([firstId, secondId]),
      );
    } finally {
      authenticator.close();
      peer.socket.destroy();
      await server.close();
    }
  });

  it("closes on duplicate request IDs, oversized frames, and replayed authentication", async () => {
    let dispatchCalls = 0;
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handler: handler({
        dispatch: async () => {
          dispatchCalls++;
          return { ok: true };
        },
      }),
    });
    try {
      const authenticated = await authenticateRaw();
      const duplicate = encodeRuntimeOwnerRpcFrame({
        version: 1,
        type: "request",
        requestId: requestId(3),
        method: "dispatch",
        params: { operation: "once", payload: null },
      });
      const duplicateClosed = once(authenticated.peer.socket, "close");
      authenticated.peer.socket.write(Buffer.concat([duplicate, duplicate]));
      await duplicateClosed;
      expect(dispatchCalls).toBe(1);
      authenticated.authenticator.close();

      const oversized = await connectRaw();
      await oversized.read();
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(RUNTIME_OWNER_RPC_MAX_FRAME_BYTES + 1, 0);
      const oversizedClosed = once(oversized.socket, "close");
      oversized.socket.write(prefix);
      await oversizedClosed;

      const first = await connectRaw();
      const auth = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, secret());
      const firstChallenge = parseRuntimeOwnerRpcChallenge(await first.read());
      const replay = {
        version: 1,
        type: "authenticate",
        challenge: firstChallenge.challenge,
        clientProof: auth.createClientProof(firstChallenge.challenge),
      };
      first.socket.destroy();

      const second = await connectRaw();
      await second.read();
      const replayClosed = once(second.socket, "close");
      second.write(replay);
      await replayClosed;
      auth.close();

      const pipelined = await connectRaw();
      const pipelineAuth = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, secret());
      const pipelineChallenge = parseRuntimeOwnerRpcChallenge(await pipelined.read());
      const pipelinedClosed = once(pipelined.socket, "close");
      pipelined.socket.write(
        Buffer.concat([
          encodeRuntimeOwnerRpcFrame({
            version: 1,
            type: "authenticate",
            challenge: pipelineChallenge.challenge,
            clientProof: pipelineAuth.createClientProof(pipelineChallenge.challenge),
          }),
          encodeRuntimeOwnerRpcFrame({
            version: 1,
            type: "request",
            requestId: requestId(4),
            method: "health",
            params: null,
          }),
        ]),
      );
      await pipelinedClosed;
      pipelineAuth.close();

      const partialPipeline = await connectRaw();
      const partialAuth = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, secret());
      const partialChallenge = parseRuntimeOwnerRpcChallenge(await partialPipeline.read());
      const partialAuthentication = encodeRuntimeOwnerRpcFrame({
        version: 1,
        type: "authenticate",
        challenge: partialChallenge.challenge,
        clientProof: partialAuth.createClientProof(partialChallenge.challenge),
      });
      const partialRequest = encodeRuntimeOwnerRpcFrame({
        version: 1,
        type: "request",
        requestId: requestId(6),
        method: "health",
        params: null,
      });
      const partialClosed = once(partialPipeline.socket, "close");
      partialPipeline.socket.write(
        Buffer.concat([partialAuthentication, partialRequest.subarray(0, 3)]),
      );
      await partialClosed;
      partialAuth.close();
    } finally {
      await server.close();
    }
  });

  it("enforces the authenticated server-side in-flight limit", async () => {
    let startedCount = 0;
    let markAllStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      requestTimeoutMs: 5_000,
      handler: handler({
        dispatch: async (_request, context) => {
          startedCount++;
          if (startedCount === RUNTIME_OWNER_RPC_MAX_IN_FLIGHT) markAllStarted?.();
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return null;
        },
      }),
    });
    const authenticated = await authenticateRaw();
    try {
      authenticated.peer.socket.write(
        Buffer.concat(
          Array.from({ length: RUNTIME_OWNER_RPC_MAX_IN_FLIGHT }, (_, index) =>
            encodeRuntimeOwnerRpcFrame({
              version: RUNTIME_OWNER_RPC_VERSION,
              type: "request",
              requestId: requestId(index + 20),
              method: "dispatch",
              params: { operation: "hold", payload: index },
            }),
          ),
        ),
      );
      await allStarted;

      const overflowRequestId = requestId(100);
      authenticated.peer.write({
        version: RUNTIME_OWNER_RPC_VERSION,
        type: "request",
        requestId: overflowRequestId,
        method: "dispatch",
        params: { operation: "hold", payload: "overflow" },
      });
      expect(parseRuntimeOwnerRpcResponse(await authenticated.peer.read())).toMatchObject({
        requestId: overflowRequestId,
        ok: false,
        error: { code: "TOO_MANY_IN_FLIGHT" },
      });
      expect(startedCount).toBe(RUNTIME_OWNER_RPC_MAX_IN_FLIGHT);
    } finally {
      authenticated.authenticator.close();
      authenticated.peer.socket.destroy();
      await server.close();
    }
  });

  it("closes at the configured server request budget while retaining the 4,096 production cap", async () => {
    expect(RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION).toBe(4_096);
    await expect(
      startRuntimeOwnerRpcServer({
        machineIdentityId,
        identitySecret: secret(),
        maxRequestsPerConnection: RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION + 1,
        handler: handler(),
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });

    let healthCalls = 0;
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      maxRequestsPerConnection: 2,
      handler: handler({
        health: async () => {
          healthCalls++;
          return { status: "ok" };
        },
      }),
    });
    const authenticated = await authenticateRaw();
    try {
      for (const fill of [120, 121]) {
        const id = requestId(fill);
        authenticated.peer.write({
          version: RUNTIME_OWNER_RPC_VERSION,
          type: "request",
          requestId: id,
          method: "health",
          params: null,
        });
        expect(parseRuntimeOwnerRpcResponse(await authenticated.peer.read())).toMatchObject({
          requestId: id,
          ok: true,
        });
      }

      const closed = once(authenticated.peer.socket, "close");
      authenticated.peer.write({
        version: RUNTIME_OWNER_RPC_VERSION,
        type: "request",
        requestId: requestId(122),
        method: "health",
        params: null,
      });
      await closed;
      expect(healthCalls).toBe(2);
      expect(server.listening).toBe(true);
    } finally {
      authenticated.authenticator.close();
      authenticated.peer.socket.destroy();
      await server.close();
    }
  });

  it("enforces request timeout and unknown-method bounds", async () => {
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      requestTimeoutMs: 20,
      handler: handler({
        dispatch: async (request, context) => {
          if (request.operation !== "hold") return request.payload;
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return null;
        },
      }),
    });
    let client: Awaited<ReturnType<typeof connectRuntimeOwnerRpc>> | undefined;
    try {
      client = await connectRuntimeOwnerRpc({
        machineIdentityId,
        identitySecret: secret(),
        requestTimeoutMs: 1_000,
      });
      await expect(client.dispatch({ operation: "hold", payload: null })).rejects.toMatchObject({
        code: "TIMEOUT",
      });

      const unknown = await authenticateRaw();
      try {
        const closed = once(unknown.peer.socket, "close");
        unknown.peer.write({
          version: 1,
          type: "request",
          requestId: requestId(5),
          method: "unknown",
          params: null,
        });
        await closed;
      } finally {
        unknown.authenticator.close();
        unknown.peer.socket.destroy();
      }
    } finally {
      client?.close();
      await server.close();
    }
  });

  it("treats disconnect as detach and aborts only that connection's work", async () => {
    let detachedConnectionId: string | undefined;
    let resolveDetach: (() => void) | undefined;
    const detached = new Promise<void>((resolve) => {
      resolveDetach = resolve;
    });
    const server = await startRuntimeOwnerRpcServer({
      machineIdentityId,
      identitySecret: secret(),
      handler: handler({
        detach: ({ connectionId }) => {
          detachedConnectionId = connectionId;
          resolveDetach?.();
        },
      }),
    });
    try {
      const client = await connectRuntimeOwnerRpc({ machineIdentityId, identitySecret: secret() });
      await client.health();
      client.close();
      await detached;
      expect(detachedConnectionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(server.listening).toBe(true);
    } finally {
      await server.close();
    }
  });
});
