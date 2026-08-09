import { randomBytes, verify } from "node:crypto";
import { base64urlDecode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId } from "../state/ids.js";
import { ProtectedByteSnapshot } from "../state/protected.js";
import {
  assertWrappedRuntimeOwnerIdentityKeyUsable,
  createRuntimeOwnerKeyCustodySigner,
  generateWrappedRuntimeOwnerIdentityKey,
  RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
  signWithWrappedRuntimeOwnerIdentityKey,
} from "./key-custody.js";

const runtimeId = parseA1CanonicalId(
  "nativeRuntime",
  "rcrt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
);

describe("runtime-owner wrapped Ed25519 custody", () => {
  it("stores only a bound ciphertext envelope and signs exact payload bytes", () => {
    const rootSecret = randomBytes(32);
    const envelope = generateWrappedRuntimeOwnerIdentityKey(rootSecret, runtimeId, 1);
    const payload = ProtectedByteSnapshot.from(new TextEncoder().encode("canonical payload"));
    const signature = signWithWrappedRuntimeOwnerIdentityKey(rootSecret, envelope, payload);

    expect(envelope.wrappingSchemaId).toBe(RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID);
    expect(envelope.binding.runtimeId).toBe(runtimeId);
    expect(envelope.binding.runtimeOwnerIdentityKeyId).toMatch(/^roik_/);
    expect(envelope.wrapNonce.byteLength).toBe(12);
    expect(envelope.authTag.byteLength).toBe(16);
    expect(signature.byteLength).toBe(64);
    expect(() => assertWrappedRuntimeOwnerIdentityKeyUsable(rootSecret, envelope)).not.toThrow();
    expect(
      verify(
        null,
        payload.copyBytes(),
        {
          key: {
            kty: "OKP",
            crv: "Ed25519",
            x: envelope.binding.publicKey,
          },
          format: "jwk",
        },
        signature.copyBytes(),
      ),
    ).toBe(true);
  });

  it("rejects wrong roots and every binding or ciphertext transplant", () => {
    const rootSecret = randomBytes(32);
    const envelope = generateWrappedRuntimeOwnerIdentityKey(rootSecret, runtimeId, 1);
    const payload = ProtectedByteSnapshot.from(Uint8Array.of(1, 2, 3));

    expect(() =>
      signWithWrappedRuntimeOwnerIdentityKey(randomBytes(32), envelope, payload),
    ).toThrow();
    expect(() =>
      signWithWrappedRuntimeOwnerIdentityKey(
        rootSecret,
        {
          ...envelope,
          binding: { ...envelope.binding, keyGeneration: 2 },
        },
        payload,
      ),
    ).toThrow();
    const changed = envelope.wrappedPkcs8.copyBytes();
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(() =>
      signWithWrappedRuntimeOwnerIdentityKey(
        rootSecret,
        { ...envelope, wrappedPkcs8: ProtectedByteSnapshot.from(changed) },
        payload,
      ),
    ).toThrow();
  });

  it("snapshots caller-owned roots, payloads, and returned signature bytes", () => {
    const rootSecret = randomBytes(32);
    const originalRoot = Uint8Array.from(rootSecret);
    const envelope = generateWrappedRuntimeOwnerIdentityKey(rootSecret, runtimeId, 1);
    rootSecret.fill(9);
    const payloadBytes = Uint8Array.of(4, 5, 6);
    const payload = ProtectedByteSnapshot.from(payloadBytes);
    payloadBytes.fill(7);
    const signature = signWithWrappedRuntimeOwnerIdentityKey(originalRoot, envelope, payload);
    const first = signature.copyBytes();
    first.fill(0);
    expect(signature.copyBytes()).not.toEqual(first);
    expect(base64urlDecode(envelope.binding.publicKey)).toHaveLength(32);
  });

  it("retains only a daemon-lifetime derived signer and erases it idempotently on close", () => {
    const rootSecret = randomBytes(32);
    const originalRoot = Uint8Array.from(rootSecret);
    const envelope = generateWrappedRuntimeOwnerIdentityKey(rootSecret, runtimeId, 1);
    const signer = createRuntimeOwnerKeyCustodySigner(rootSecret);
    const payload = ProtectedByteSnapshot.from(new TextEncoder().encode("daemon payload"));

    rootSecret.fill(0);
    expect(signer.closed).toBe(false);
    expect(Object.keys(signer)).toEqual([]);
    expect(() => signer.assertUsable(envelope)).not.toThrow();
    expect(signer.sign(envelope, payload).byteLength).toBe(64);
    const wrongSigner = createRuntimeOwnerKeyCustodySigner(Uint8Array.from(originalRoot).fill(1));
    try {
      expect(() => wrongSigner.assertUsable(envelope)).toThrow();
    } finally {
      wrongSigner.close();
    }

    signer.close();
    signer.close();
    expect(signer.closed).toBe(true);
    expect(() => signer.assertUsable(envelope)).toThrow(/signer is closed/);
    expect(() => signer.sign(envelope, payload)).toThrow(/signer is closed/);
  });
});
