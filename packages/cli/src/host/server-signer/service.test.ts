import { verify } from "node:crypto";
import { base64urlDecode, base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "../state/ids.js";
import { ProtectedByteSnapshot } from "../state/protected.js";
import {
  canonicalServerKeyBindingAad,
  createServerKeyCustodySigner,
  deriveServerIdentityKeyId,
  SERVER_KEY_WRAP_SCHEMA_ID,
  type ServerKeyCustodySigner,
  type WrappedServerPrivateKey,
} from "./service.js";

const MACHINE_IDENTITY_ID = "00112233445566778899aabbccddeeff";
const COLLABORATION_SERVER_ID = parseA1CanonicalId(
  "collaborationServer",
  "rcs_EREiIjMzRERVVVZmZnd3dw",
);
const SIGNING_KEY_REF = parseA1CanonicalId("protectedHandle", "rcph_ABEiM0RVZneImaq7zN3u_w");

function destroyEnvelope(envelope: WrappedServerPrivateKey): void {
  envelope.wrapNonce.destroy();
  envelope.wrappedPkcs8.destroy();
  envelope.authTag.destroy();
}

function changedSnapshot(snapshot: ProtectedByteSnapshot): ProtectedByteSnapshot {
  const bytes = snapshot.copyBytes();
  try {
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    return ProtectedByteSnapshot.from(bytes);
  } finally {
    bytes.fill(0);
  }
}

function expectEnvelopeRejected(
  signer: ServerKeyCustodySigner,
  envelope: WrappedServerPrivateKey,
): void {
  expect(() => signer.assertUsable(envelope)).toThrow();
}

describe("server-scope signer key custody", () => {
  it("generates a server-bound envelope and signs without exporting PKCS#8", () => {
    const rootSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const retainedRootSecret = rootSecret.slice();
    const signer = createServerKeyCustodySigner(rootSecret);
    const envelope = signer.generateIdentityKey(
      MACHINE_IDENTITY_ID,
      COLLABORATION_SERVER_ID,
      SIGNING_KEY_REF,
      1,
    );
    expect(rootSecret).toEqual(retainedRootSecret);
    expect(envelope.wrappingSchemaId).toBe(SERVER_KEY_WRAP_SCHEMA_ID);
    expect(envelope.binding).toMatchObject({
      machineIdentityId: MACHINE_IDENTITY_ID,
      collaborationServerId: COLLABORATION_SERVER_ID,
      keyGeneration: 1,
      algorithm: "Ed25519",
      signingKeyRef: SIGNING_KEY_REF,
      custodyBackend: "owned-file",
    });
    expect(envelope.binding.identityKeyId).toMatch(/^sik_[A-Za-z0-9_-]{43}$/);
    expect(envelope.wrappedPkcs8.byteLength).toBeGreaterThan(0);

    const callerPayload = Uint8Array.of(1, 3, 3, 7);
    const payload = ProtectedByteSnapshot.from(callerPayload);
    const signature = signer.sign(envelope, payload);
    const signatureBytes = signature.copyBytes();
    try {
      expect(callerPayload).toEqual(Uint8Array.of(1, 3, 3, 7));
      expect(signatureBytes).toHaveLength(64);
      expect(
        verify(
          null,
          callerPayload,
          {
            key: {
              kty: "OKP",
              crv: "Ed25519",
              x: envelope.binding.publicKey,
            },
            format: "jwk",
          },
          signatureBytes,
        ),
      ).toBe(true);
      signer.assertUsable(envelope);
    } finally {
      signatureBytes.fill(0);
      signature.destroy();
      payload.destroy();
      destroyEnvelope(envelope);
      signer.close();
      rootSecret.fill(0);
      retainedRootSecret.fill(0);
    }
  });

  it("locks the identity-key ID and key-wrap AAD canonical vectors", () => {
    const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const pkcs8DigestBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    try {
      const identityKeyId = deriveServerIdentityKeyId(
        MACHINE_IDENTITY_ID,
        COLLABORATION_SERVER_ID,
        1,
        publicKey,
      );
      expect(identityKeyId).toBe("sik_QFJ2gR1wTxfCt-XCPasn8zCp0kcAarYOfFcTOy3J7cc");
      const aad = canonicalServerKeyBindingAad(
        {
          machineIdentityId: MACHINE_IDENTITY_ID,
          collaborationServerId: COLLABORATION_SERVER_ID,
          identityKeyId,
          keyGeneration: 1,
          algorithm: "Ed25519",
          publicKey: base64urlEncode(publicKey),
          signingKeyRef: SIGNING_KEY_REF,
          custodyBackend: "owned-file",
        },
        parseA1Digest(base64urlEncode(pkcs8DigestBytes)),
      );
      try {
        expect(base64urlEncode(aad)).toBe(
          "AAAAM3JlbW90ZS1jbGF3L3NlcnZlci1pZGVudGl0eS1rZXktd3JhcC9hZXMtMjU2LWdjbS92MQAAABAAESIzRFVmd4iZqrvM3e7_AAAAGnJjc19FUkVpSWpNelJFUlZWVlptWm5kM2R3AAAAL3Npa19RRkoyZ1Ixd1R4ZkN0LVhDUGFzbjh6Q3Awa2NBYXJZT2ZGY1RPeTNKN2NjAAAACAAAAAAAAAABAAAAB0VkMjU1MTkAAAAbcmNwaF9BQkVpTTBSVlpuZUltYXE3ek4zdV93AAAACm93bmVkLWZpbGUAAAAgAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8AAAAg__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA",
        );
      } finally {
        aad.fill(0);
      }
      expect(publicKey).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index));
    } finally {
      publicKey.fill(0);
      pkcs8DigestBytes.fill(0);
    }
  });

  it("rejects every key-wrap transplant dimension and the wrong custody root", () => {
    const rootSecret = new Uint8Array(32).fill(9);
    const signer = createServerKeyCustodySigner(rootSecret);
    const envelope = signer.generateIdentityKey(
      MACHINE_IDENTITY_ID,
      COLLABORATION_SERVER_ID,
      SIGNING_KEY_REF,
      1,
    );
    const otherRootSecret = new Uint8Array(32).fill(8);
    const otherSigner = createServerKeyCustodySigner(otherRootSecret);
    const changedPublicKeyBytes = base64urlDecode(envelope.binding.publicKey);
    changedPublicKeyBytes[0] = (changedPublicKeyBytes[0] ?? 0) ^ 1;
    const changedDigestBytes = base64urlDecode(envelope.pkcs8Digest);
    changedDigestBytes[0] = (changedDigestBytes[0] ?? 0) ^ 1;
    const changedNonce = changedSnapshot(envelope.wrapNonce);
    const changedCiphertext = changedSnapshot(envelope.wrappedPkcs8);
    const changedTag = changedSnapshot(envelope.authTag);
    try {
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: {
          ...envelope,
          ...envelope.binding,
          identityKeyId: parseA1SafeId("sik_collision"),
        },
      });
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: { ...envelope.binding, machineIdentityId: "ffeeddccbbaa99887766554433221100" },
      });
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: {
          ...envelope.binding,
          collaborationServerId: parseA1CanonicalId(
            "collaborationServer",
            "rcs_ABEiM0RVZneImaq7zN3u_w",
          ),
        },
      });
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: { ...envelope.binding, keyGeneration: 2 },
      });
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: { ...envelope.binding, algorithm: "X25519" },
      } as unknown as WrappedServerPrivateKey);
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: { ...envelope.binding, custodyBackend: "external-kms" },
      } as unknown as WrappedServerPrivateKey);
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: { ...envelope.binding, publicKey: base64urlEncode(changedPublicKeyBytes) },
      });
      expectEnvelopeRejected(signer, {
        ...envelope,
        binding: {
          ...envelope.binding,
          signingKeyRef: parseA1CanonicalId("protectedHandle", "rcph_EREiIjMzRERVVVZmZnd3dw"),
        },
      });
      expectEnvelopeRejected(signer, {
        ...envelope,
        pkcs8Digest: parseA1Digest(base64urlEncode(changedDigestBytes)),
      });
      expectEnvelopeRejected(signer, { ...envelope, wrapNonce: changedNonce });
      expectEnvelopeRejected(signer, { ...envelope, wrappedPkcs8: changedCiphertext });
      expectEnvelopeRejected(signer, { ...envelope, authTag: changedTag });
      expectEnvelopeRejected(otherSigner, envelope);
    } finally {
      changedPublicKeyBytes.fill(0);
      changedDigestBytes.fill(0);
      changedNonce.destroy();
      changedCiphertext.destroy();
      changedTag.destroy();
      destroyEnvelope(envelope);
      signer.close();
      otherSigner.close();
      rootSecret.fill(0);
      otherRootSecret.fill(0);
    }
  });

  it("fails closed after custody shutdown", () => {
    const rootSecret = new Uint8Array(32).fill(9);
    const signer = createServerKeyCustodySigner(rootSecret);
    const envelope = signer.generateIdentityKey(
      MACHINE_IDENTITY_ID,
      COLLABORATION_SERVER_ID,
      SIGNING_KEY_REF,
      1,
    );
    const payload = ProtectedByteSnapshot.from(Uint8Array.of(5));
    try {
      signer.close();
      expect(() => signer.sign(envelope, payload)).toThrow(/closed/);
      expect(() =>
        signer.generateIdentityKey(
          MACHINE_IDENTITY_ID,
          COLLABORATION_SERVER_ID,
          SIGNING_KEY_REF,
          2,
        ),
      ).toThrow(/closed/);
    } finally {
      payload.destroy();
      destroyEnvelope(envelope);
      signer.close();
      rootSecret.fill(0);
    }
  });
});
