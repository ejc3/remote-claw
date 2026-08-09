import { describe, expect, it } from "vitest";
import { bootstrapRuntimeOwner, type RuntimeOwnerDetachedSpawnRequest } from "./bootstrap.js";
import type { ConnectRuntimeOwnerRpcOptions, RuntimeOwnerRpcClient } from "./client.js";
import { RuntimeOwnerRpcError } from "./protocol.js";

const MACHINE_IDENTITY = "abcdef0123456789abcdef0123456789";

function secret(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
}

function fakeClient(): RuntimeOwnerRpcClient {
  return Object.freeze({ marker: "fake-runtime-owner-client" }) as unknown as RuntimeOwnerRpcClient;
}

describe("runtime-owner bootstrap", () => {
  it("connects to an existing owner without spawning", async () => {
    const rootSecret = secret();
    const original = Uint8Array.from(rootSecret);
    const client = fakeClient();
    let spawnCalls = 0;
    let observedSecret: Uint8Array | undefined;

    const result = await bootstrapRuntimeOwner({
      machineIdentityId: MACHINE_IDENTITY,
      identitySecret: rootSecret,
      spawnDetached: () => {
        spawnCalls++;
      },
      connect: async (options) => {
        observedSecret = options.identitySecret;
        return client;
      },
    });

    expect(result).toEqual({ status: "connected", client, spawnAttempted: false });
    expect(spawnCalls).toBe(0);
    expect(rootSecret).toEqual(original);
    expect(observedSecret).toEqual(new Uint8Array(32));
  });

  it("spawns once after unavailable, then connects through the raced abstract socket", async () => {
    const rootSecret = secret();
    const original = Uint8Array.from(rootSecret);
    const client = fakeClient();
    const connectionSecrets: Uint8Array[] = [];
    let connectCalls = 0;
    let now = 1_000;
    let spawnRequest: RuntimeOwnerDetachedSpawnRequest | undefined;

    const result = await bootstrapRuntimeOwner({
      machineIdentityId: MACHINE_IDENTITY,
      identitySecret: rootSecret,
      startupTimeoutMs: 100,
      pollIntervalMs: 10,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      spawnDetached: (request) => {
        spawnRequest = request;
      },
      connect: async (options) => {
        connectCalls++;
        connectionSecrets.push(options.identitySecret);
        if (connectCalls === 1) throw new RuntimeOwnerRpcError("UNAVAILABLE");
        return client;
      },
    });

    expect(result).toEqual({ status: "connected", client, spawnAttempted: true });
    expect(connectCalls).toBe(2);
    expect(spawnRequest).toEqual({ machineIdentityId: MACHINE_IDENTITY, detached: true });
    expect(Object.keys(spawnRequest ?? {}).sort()).toEqual(["detached", "machineIdentityId"]);
    expect(JSON.stringify(spawnRequest)).not.toContain(String(rootSecret[0]));
    expect(rootSecret).toEqual(original);
    for (const connectionSecret of connectionSecrets) {
      expect(connectionSecret).toEqual(new Uint8Array(32));
    }
  });

  it("returns unavailable after a bounded autostart timeout", async () => {
    let now = 0;
    let connectCalls = 0;
    let spawnCalls = 0;
    const result = await bootstrapRuntimeOwner({
      machineIdentityId: MACHINE_IDENTITY,
      identitySecret: secret(),
      startupTimeoutMs: 30,
      pollIntervalMs: 10,
      connectTimeoutMs: 10,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      spawnDetached: () => {
        spawnCalls++;
      },
      connect: async () => {
        connectCalls++;
        throw new RuntimeOwnerRpcError("UNAVAILABLE");
      },
    });

    expect(result).toEqual({ status: "unavailable", client: null, spawnAttempted: true });
    expect(spawnCalls).toBe(1);
    expect(connectCalls).toBe(3);
  });

  it("stays bounded even when the injected clock never advances", async () => {
    let connectCalls = 0;
    const result = await bootstrapRuntimeOwner({
      machineIdentityId: MACHINE_IDENTITY,
      identitySecret: secret(),
      startupTimeoutMs: 30,
      pollIntervalMs: 10,
      now: () => 0,
      sleep: async () => undefined,
      spawnDetached: () => undefined,
      connect: async () => {
        connectCalls++;
        throw new RuntimeOwnerRpcError("UNAVAILABLE");
      },
    });

    expect(result.status).toBe("unavailable");
    expect(connectCalls).toBe(5);
  });

  it("fails closed without spawning on authentication or protocol failures", async () => {
    for (const code of ["AUTHENTICATION_FAILED", "PROTOCOL_ERROR"] as const) {
      let spawnCalls = 0;
      const result = await bootstrapRuntimeOwner({
        machineIdentityId: MACHINE_IDENTITY,
        identitySecret: secret(),
        spawnDetached: () => {
          spawnCalls++;
        },
        connect: async (_options: ConnectRuntimeOwnerRpcOptions) => {
          throw new RuntimeOwnerRpcError(code);
        },
      });
      expect(result).toEqual({ status: "unavailable", client: null, spawnAttempted: false });
      expect(spawnCalls).toBe(0);
    }
  });

  it("returns unavailable when detached spawn fails and does not retry it", async () => {
    let spawnCalls = 0;
    let connectCalls = 0;
    const result = await bootstrapRuntimeOwner({
      machineIdentityId: MACHINE_IDENTITY,
      identitySecret: secret(),
      spawnDetached: () => {
        spawnCalls++;
        throw new Error("provider detail that must not escape");
      },
      connect: async () => {
        connectCalls++;
        throw new RuntimeOwnerRpcError("UNAVAILABLE");
      },
    });

    expect(result).toEqual({ status: "unavailable", client: null, spawnAttempted: true });
    expect(spawnCalls).toBe(1);
    expect(connectCalls).toBe(1);
  });
});
