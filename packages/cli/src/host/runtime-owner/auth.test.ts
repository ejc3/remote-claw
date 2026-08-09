import { describe, expect, it } from "vitest";
import {
  RUNTIME_OWNER_RPC_AUTH_KDF_DOMAIN,
  RuntimeOwnerRpcAuthenticator,
  runtimeOwnerRpcSocketAddress,
} from "./auth.js";

const machineIdentityId = "0123456789abcdef0123456789abcdef";

describe("runtime-owner RPC authentication", () => {
  it("derives a private domain-separated authenticator and mutually authenticates", async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
    const server = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, secret);
    const client = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, secret);
    const challenge = server.createChallenge(() => Uint8Array.from({ length: 32 }, () => 7));

    expect(RUNTIME_OWNER_RPC_AUTH_KDF_DOMAIN).toBe("remote-claw/runtime-owner-rpc-auth/v1");
    expect(client.verifyServerProof(challenge.challenge, challenge.serverProof)).toBe(true);
    expect(
      server.verifyClientProof(challenge.challenge, client.createClientProof(challenge.challenge)),
    ).toBe(true);

    server.close();
    client.close();
    expect(secret).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index));
  });

  it("rejects wrong-key proofs and a proof replayed under a fresh challenge", async () => {
    const server = await RuntimeOwnerRpcAuthenticator.create(machineIdentityId, new Uint8Array(32));
    const wrong = await RuntimeOwnerRpcAuthenticator.create(
      machineIdentityId,
      Uint8Array.from({ length: 32 }, () => 1),
    );
    const first = server.createChallenge(() => Uint8Array.from({ length: 32 }, () => 2));
    const second = server.createChallenge(() => Uint8Array.from({ length: 32 }, () => 3));
    const firstClientProof = server.createClientProof(first.challenge);

    expect(wrong.verifyServerProof(first.challenge, first.serverProof)).toBe(false);
    expect(
      server.verifyClientProof(first.challenge, wrong.createClientProof(first.challenge)),
    ).toBe(false);
    expect(server.verifyClientProof(second.challenge, firstClientProof)).toBe(false);

    server.close();
    wrong.close();
  });

  it("uses a machine-scoped Linux abstract socket address", () => {
    const address = runtimeOwnerRpcSocketAddress(machineIdentityId);
    expect(address.startsWith("\0remote-claw.runtime-owner.v1.")).toBe(true);
    expect(address.endsWith(machineIdentityId)).toBe(true);
    expect(() => runtimeOwnerRpcSocketAddress(machineIdentityId.toUpperCase())).toThrow();
  });
});
