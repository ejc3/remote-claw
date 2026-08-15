import { readFileSync } from "node:fs";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId } from "./ids.js";
import {
  deriveServerIdentityKeyId,
  encodeServerSignerBootstrapIntentV1,
  parseServerSignatureReservationRecord,
  parseServerSignerBootstrapIntentV1,
  SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
  serverSignerBootstrapIntentDigest,
} from "./server-signing.js";

const INTENT = Object.freeze({
  schemaVersion: 1,
  canonicalPayloadSchemaId: SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
  machineIdentityId: "00112233445566778899aabbccddeeff",
  collaborationServerId: "rcs_EREiIjMzRERVVVZmZnd3dw",
  bootstrapSigningLeaseId: "sbs_initial",
  purpose: "initial_pair",
  expectedPriorScopeCertificateId: null,
  proposedIdentityKeyId: "sik_vector",
  proposedKeyGeneration: 1,
  proposedKeyAlgorithm: "Ed25519",
  proposedPublicKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  proposedScopeCertificateId: "ssc_vector",
  signingKeyRef: "rcph_ABEiM0RVZneImaq7zN3u_w",
  preparedAtMs: 123_456_789,
} as const);

const ENCODED_VECTOR =
  "AAAALXJlbW90ZS1jbGF3L3NlcnZlci1zaWduZXItYm9vdHN0cmFwLWludGVudC92MQAAAAgAAAAAAAAAAQAAABAAESIzRFVmd4iZqrvM3e7_AAAAGnJjc19FUkVpSWpNelJFUlZWVlptWm5kM2R3AAAAC3Nic19pbml0aWFsAAAADGluaXRpYWxfcGFpcgAAAAAKc2lrX3ZlY3RvcgAAAAgAAAAAAAAAAQAAAAdFZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fAAAACnNzY192ZWN0b3IAAAAbcmNwaF9BQkVpTTBSVlpuZUltYXE3ek4zdV93AAAACAAAAAAHW80V";
const DIGEST_VECTOR = "T_gSdGZj6UBOkgglxF0kPl7fvrOdRJEMSondnytkmXU";

describe("server signer bootstrap intent", () => {
  it("keeps state validation independent from the custody service runtime", () => {
    const repositorySource = readFileSync(
      new URL("./server-signing-repository.ts", import.meta.url),
      "utf8",
    );
    expect(repositorySource).not.toContain("../server-signer/service");
  });

  it("derives the identity-key ID in the state contract without loading custody", () => {
    const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    try {
      expect(
        deriveServerIdentityKeyId(
          INTENT.machineIdentityId,
          parseA1CanonicalId("collaborationServer", INTENT.collaborationServerId),
          1,
          publicKey,
        ),
      ).toBe("sik_QFJ2gR1wTxfCt-XCPasn8zCp0kcAarYOfFcTOy3J7cc");
    } finally {
      publicKey.fill(0);
    }
  });

  it("derives from one public-key snapshot when a length-tracking view grows", () => {
    const backing = Reflect.construct(SharedArrayBuffer, [
      32,
      { maxByteLength: 33 },
    ]) as SharedArrayBuffer & { grow(newByteLength: number): void };
    const publicKey = new Uint8Array(backing);
    publicKey.set(Uint8Array.from({ length: 32 }, (_, index) => index));
    const originalSetUint32 = DataView.prototype.setUint32;
    let grew = false;
    DataView.prototype.setUint32 = function growAfterPublicKeySnapshot(
      byteOffset,
      value,
      littleEndian,
    ): void {
      if (!grew) {
        grew = true;
        backing.grow(33);
        new Uint8Array(backing)[32] = 0xff;
      }
      originalSetUint32.call(this, byteOffset, value, littleEndian);
    };
    try {
      expect(
        deriveServerIdentityKeyId(
          INTENT.machineIdentityId,
          parseA1CanonicalId("collaborationServer", INTENT.collaborationServerId),
          1,
          publicKey,
        ),
      ).toBe("sik_QFJ2gR1wTxfCt-XCPasn8zCp0kcAarYOfFcTOy3J7cc");
    } finally {
      DataView.prototype.setUint32 = originalSetUint32;
    }
    expect(grew).toBe(true);
    expect(publicKey.byteLength).toBe(33);
  });

  it("locks the exact public authorization preimage and digest", () => {
    const parsed = parseServerSignerBootstrapIntentV1(INTENT);
    expect(parsed).toEqual(INTENT);
    expect(Object.isFrozen(parsed)).toBe(true);

    const encoded = encodeServerSignerBootstrapIntentV1(parsed);
    try {
      expect(base64urlEncode(encoded)).toBe(ENCODED_VECTOR);
      expect(serverSignerBootstrapIntentDigest(parsed)).toBe(DIGEST_VECTOR);
    } finally {
      encoded.fill(0);
    }
  });

  it("rejects non-canonical, repair, and alternate-key spellings", () => {
    expect(() => parseServerSignerBootstrapIntentV1({ ...INTENT, extra: true })).toThrow(/exactly/);
    expect(() =>
      parseServerSignerBootstrapIntentV1({
        ...INTENT,
        purpose: "explicit_repair",
        expectedPriorScopeCertificateId: "ssc_old",
      }),
    ).toThrow(/initial pair/);
    expect(() =>
      parseServerSignerBootstrapIntentV1({
        ...INTENT,
        proposedPublicKey: `${INTENT.proposedPublicKey}=`,
      }),
    ).toThrow(/PublicKey/);
    expect(() =>
      parseServerSignerBootstrapIntentV1({
        ...INTENT,
        proposedKeyAlgorithm: "X25519",
      }),
    ).toThrow(/Ed25519/);
  });

  it("binds every server, key, certificate, handle, and time coordinate", () => {
    for (const changed of [
      { collaborationServerId: "rcs_ABEiM0RVZneImaq7zN3u_w" },
      { bootstrapSigningLeaseId: "sbs_changed" },
      { proposedIdentityKeyId: "sik_changed" },
      { proposedScopeCertificateId: "ssc_changed" },
      { signingKeyRef: "rcph_EREiIjMzRERVVVZmZnd3dw" },
      { preparedAtMs: INTENT.preparedAtMs + 1 },
    ] as const) {
      expect(serverSignerBootstrapIntentDigest({ ...INTENT, ...changed })).not.toBe(DIGEST_VECTOR);
    }
  });

  it("requires a canonical protected handle for a bound payload", () => {
    const reservation = {
      collaborationServerId: INTENT.collaborationServerId,
      signerSequence: 0,
      signingLeaseId: INTENT.bootstrapSigningLeaseId,
      signingLeaseKind: "bootstrap",
      purpose: "scope_certificate",
      canonicalPayloadSchemaId: "remote-claw/server-scope-certificate/v1",
      canonicalPayloadRef: INTENT.signingKeyRef,
      canonicalPayloadDigest: DIGEST_VECTOR,
      signedRecordDigest: null,
      signature: null,
      signedArtifactType: "server_scope_certificate",
      signedArtifactId: INTENT.proposedScopeCertificateId,
      reservedAtMs: INTENT.preparedAtMs,
      boundAtMs: INTENT.preparedAtMs,
      signedAtMs: null,
      abortedAtMs: null,
      state: "bound",
    } as const;
    expect(parseServerSignatureReservationRecord(reservation).canonicalPayloadRef).toBe(
      INTENT.signingKeyRef,
    );
    expect(() =>
      parseServerSignatureReservationRecord({
        ...reservation,
        canonicalPayloadRef: "payload-not-a-handle",
      }),
    ).toThrow(/rcph_/);
  });
});
