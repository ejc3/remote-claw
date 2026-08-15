import { describe, expect, it } from "vitest";
import {
  type A1Ed25519PublicKeyBinding,
  canonicalNativeRootPayload,
  encodeNativeRootCertificatePayload,
  encodeServerScopeCertificatePayload,
  encodeViewerOnboardingKeyAttestationPayload,
  type NativeRootCertificate,
  nativeRootCanonicalPayloadDigest,
  nativeRootCertificatePayloadDigest,
  nativeRootCertificateSignedRecordDigest,
  parseNativeRootCanonicalPayloadInput,
  parseNativeRootCertificate,
  type ServerScopeCertificateRecord,
  serverScopeCertificatePayloadDigest,
  serverScopeCertificateSignedRecordDigest,
  type ViewerOnboardingKeyAttestationV1,
  verifyNativeRootCertificate,
  verifyServerScopeCertificate,
  verifyViewerOnboardingKeyAttestation,
  viewerOnboardingKeyAttestationPayloadDigest,
  viewerOnboardingKeyAttestationSignedRecordDigest,
  viewerOnboardingKeyCommitment,
  viewerOnboardingKeyCommitments,
} from "./a1-certificates.js";
import { base64urlEncode } from "./base64url.js";
import { fromHex, sha256, toHex } from "./bytes.js";

const KEY_ONE = {
  id: "server-key.one",
  generation: 1,
  seed: fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
  publicKey: fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
} as const;

const KEY_TWO = {
  id: "server-key.two",
  generation: 2,
  seed: fromHex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"),
  publicKey: fromHex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
} as const;

const ZERO_DIGEST = base64urlEncode(new Uint8Array(32));
const ZERO_SIGNATURE = base64urlEncode(new Uint8Array(64));

function canonicalId(prefix: string, fill: number): string {
  return `${prefix}${base64urlEncode(new Uint8Array(16).fill(fill))}`;
}

function keyBinding(
  key: typeof KEY_ONE | typeof KEY_TWO,
  overrides: Partial<A1Ed25519PublicKeyBinding> = {},
): A1Ed25519PublicKeyBinding {
  return {
    identityKeyId: key.id,
    keyGeneration: key.generation,
    algorithm: "Ed25519",
    publicKey: base64urlEncode(key.publicKey),
    ...overrides,
  };
}

async function privateKey(key: typeof KEY_ONE | typeof KEY_TWO): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      x: base64urlEncode(key.publicKey),
      d: base64urlEncode(key.seed),
      key_ops: ["sign"],
      ext: false,
    },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function sign(key: typeof KEY_ONE | typeof KEY_TWO, payload: Uint8Array): Promise<string> {
  return base64urlEncode(
    new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, await privateKey(key), payload as BufferSource),
    ),
  );
}

async function nativeRoot(
  overrides: Partial<NativeRootCertificate> = {},
): Promise<NativeRootCertificate> {
  const unsigned = {
    schemaVersion: 1,
    canonicalPayloadSchemaId: "remote-claw/native-root-certificate/v1",
    rootPathCertificateId: "root-path.one",
    kind: "native-root",
    terminalNativeBindingId: canonicalId("rcnb_", 1),
    terminalServerId: canonicalId("rcs_", 2),
    terminalLogicalChatId: canonicalId("rcl_", 3),
    terminalTopologyGeneration: 7,
    nativeBindingEvidenceDigest: base64urlEncode(new Uint8Array(32).fill(4)),
    runtimeOwnerIdentityKeyId: KEY_ONE.id,
    runtimeOwnerKeyGeneration: KEY_ONE.generation,
    signerSequence: 19,
    issuedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_300_000,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
    canonicalPayloadDigest: ZERO_DIGEST,
    signature: ZERO_SIGNATURE,
    ...overrides,
  } satisfies NativeRootCertificate;
  const payload = encodeNativeRootCertificatePayload(unsigned);
  const canonicalPayloadDigest = base64urlEncode(await sha256(payload));
  const record = { ...unsigned, canonicalPayloadDigest };
  return { ...record, signature: await sign(KEY_ONE, payload) };
}

async function scopeAnchor(): Promise<ServerScopeCertificateRecord> {
  const unsigned = {
    schemaVersion: 1,
    canonicalPayloadSchemaId: "remote-claw/server-scope-certificate/v1",
    scopeCertificateId: "scope-cert.one",
    collaborationServerId: canonicalId("rcs_", 2),
    machineIdentityId: "00112233445566778899aabbccddeeff",
    subjectIdentityKeyId: KEY_ONE.id,
    subjectKeyAlgorithm: "Ed25519",
    subjectPublicKey: base64urlEncode(KEY_ONE.publicKey),
    keyGeneration: 1,
    issuedAtMs: 1_700_000_000_000,
    supersedesScopeCertificateId: null,
    signerIdentityKeyId: KEY_ONE.id,
    signerSequence: 3,
    supersededSignerMaxSequence: null,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
    canonicalPayloadDigest: ZERO_DIGEST,
    signature: ZERO_SIGNATURE,
  } satisfies ServerScopeCertificateRecord;
  const payload = encodeServerScopeCertificatePayload(unsigned);
  return {
    ...unsigned,
    canonicalPayloadDigest: base64urlEncode(await sha256(payload)),
    signature: await sign(KEY_ONE, payload),
  };
}

async function scopeRotation(
  anchor: ServerScopeCertificateRecord,
): Promise<ServerScopeCertificateRecord> {
  const unsigned = {
    schemaVersion: 1,
    canonicalPayloadSchemaId: "remote-claw/server-scope-certificate/v1",
    scopeCertificateId: "scope-cert.two",
    collaborationServerId: anchor.collaborationServerId,
    machineIdentityId: anchor.machineIdentityId,
    subjectIdentityKeyId: KEY_TWO.id,
    subjectKeyAlgorithm: "Ed25519",
    subjectPublicKey: base64urlEncode(KEY_TWO.publicKey),
    keyGeneration: 2,
    issuedAtMs: 1_700_000_100_000,
    supersedesScopeCertificateId: anchor.scopeCertificateId,
    signerIdentityKeyId: KEY_ONE.id,
    signerSequence: 11,
    supersededSignerMaxSequence: 11,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
    canonicalPayloadDigest: ZERO_DIGEST,
    signature: ZERO_SIGNATURE,
  } satisfies ServerScopeCertificateRecord;
  const payload = encodeServerScopeCertificatePayload(unsigned);
  return {
    ...unsigned,
    canonicalPayloadDigest: base64urlEncode(await sha256(payload)),
    signature: await sign(KEY_ONE, payload),
  };
}

async function onboardingAttestation(
  certificate: ServerScopeCertificateRecord,
): Promise<ViewerOnboardingKeyAttestationV1> {
  const commitments = await viewerOnboardingKeyCommitments({
    authToken: new Uint8Array(32).fill(10),
    contentRoot: new Uint8Array(32).fill(11),
    controlKey: new Uint8Array(32).fill(12),
    metaKey: new Uint8Array(32).fill(13),
  });
  const unsigned = {
    schemaVersion: 1,
    canonicalPayloadSchemaId: "remote-claw/viewer-onboarding-keys/v1",
    collaborationServerId: certificate.collaborationServerId,
    machineIdentityId: certificate.machineIdentityId,
    scopeCertificateId: certificate.scopeCertificateId,
    keyGeneration: certificate.keyGeneration,
    signerIdentityKeyId: certificate.subjectIdentityKeyId,
    signerSequence: 17,
    ...commitments,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
    canonicalPayloadDigest: ZERO_DIGEST,
    signature: ZERO_SIGNATURE,
  } satisfies ViewerOnboardingKeyAttestationV1;
  const payload = encodeViewerOnboardingKeyAttestationPayload(unsigned);
  return {
    ...unsigned,
    canonicalPayloadDigest: base64urlEncode(await sha256(payload)),
    signature: await sign(KEY_TWO, payload),
  };
}

describe("NativeRootCertificate canonical signing", () => {
  it("matches the locked payload, digest, signature, and signed-record vectors", async () => {
    const record = await nativeRoot();
    expect({
      payloadHex: toHex(encodeNativeRootCertificatePayload(record)),
      payloadDigest: await nativeRootCertificatePayloadDigest(record),
      signature: record.signature,
      signedRecordDigest: await nativeRootCertificateSignedRecordDigest(record),
    }).toEqual({
      payloadHex:
        "0000002672656d6f74652d636c61772f6e61746976652d726f6f742d63657274696669636174652f76310000000800000000000000010000000d726f6f742d706174682e6f6e650000000b6e61746976652d726f6f740000001b72636e625f415145424151454241514542415145424151454241510000001a7263735f416749434167494341674943416749434167494341670000001a72636c5f41774d4441774d4441774d4441774d4441774d4441770000000800000000000000070000002004040404040404040404040404040404040404040404040404040404040404040000000e7365727665722d6b65792e6f6e65000000080000000000000001000000080000000000000013000000080000018bcfe56800000000080000018bcfe9fbe00000000745643235353139000000075348412d323536",
      payloadDigest: "t1LOJ-Wgjkb7Hm1AkezacR5XBJMfDYq6KfzRPlEnwlw",
      signature:
        "iFCxbZN_FXT0vu2pdU-NhxbSGlCIQFV1fmHnyPLjMnj2vUsrxFVuOk4fCXlbF6Q9EThY5KfJxJ1ywcsTOLMaCA",
      signedRecordDigest: "-QATnHTEU32a-rJz40DqkRuldkKKGwi5LStptjjaHs0",
    });
    await expect(verifyNativeRootCertificate(record, keyBinding(KEY_ONE))).resolves.toEqual(record);
  });

  it("canonicalizes the strict unsigned payload without digest/signature placeholders", async () => {
    const record = await nativeRoot();
    const { canonicalPayloadDigest: _digest, signature: _signature, ...payload } = record;
    expect(parseNativeRootCanonicalPayloadInput(payload)).toEqual(payload);
    expect(canonicalNativeRootPayload(payload)).toEqual(encodeNativeRootCertificatePayload(record));
    await expect(nativeRootCanonicalPayloadDigest(payload)).resolves.toBe(
      record.canonicalPayloadDigest,
    );
    expect(() =>
      parseNativeRootCanonicalPayloadInput({ ...payload, signature: record.signature }),
    ).toThrow(/canonical fields/);
  });

  it("rejects digest changes, signature transplants, and signer-binding transplants", async () => {
    const first = await nativeRoot();
    const second = await nativeRoot({ rootPathCertificateId: "root-path.two" });
    await expect(
      verifyNativeRootCertificate(
        { ...first, terminalLogicalChatId: canonicalId("rcl_", 8) },
        keyBinding(KEY_ONE),
      ),
    ).rejects.toMatchObject({ reason: "digest-mismatch" });
    await expect(
      verifyNativeRootCertificate({ ...second, signature: first.signature }, keyBinding(KEY_ONE)),
    ).rejects.toMatchObject({ reason: "signature-invalid" });
    await expect(
      verifyNativeRootCertificate(first, keyBinding(KEY_ONE, { identityKeyId: "other-key" })),
    ).rejects.toMatchObject({ reason: "signer-mismatch" });
    await expect(
      verifyNativeRootCertificate(first, keyBinding(KEY_ONE, { keyGeneration: 2 })),
    ).rejects.toMatchObject({ reason: "signer-mismatch" });
  });

  it("rejects wrong namespaces, generation zero, excessive TTL, and noncanonical encodings", async () => {
    const record = await nativeRoot();
    expect(() =>
      parseNativeRootCertificate({ ...record, terminalNativeBindingId: canonicalId("rcl_", 1) }),
    ).toThrow(/rcnb_/);
    expect(() =>
      parseNativeRootCertificate({ ...record, terminalServerId: canonicalId("rcl_", 2) }),
    ).toThrow(/rcs_/);
    expect(() =>
      parseNativeRootCertificate({ ...record, terminalLogicalChatId: canonicalId("rcs_", 3) }),
    ).toThrow(/rcl_/);
    expect(() => parseNativeRootCertificate({ ...record, terminalTopologyGeneration: 0 })).toThrow(
      /at least 1/,
    );
    expect(() =>
      parseNativeRootCertificate({ ...record, expiresAtMs: record.expiresAtMs + 1 }),
    ).toThrow(/300000ms/);
    expect(() =>
      parseNativeRootCertificate({
        ...record,
        canonicalPayloadDigest: `${record.canonicalPayloadDigest}=`,
      }),
    ).toThrow(/canonical unpadded base64url/);
    expect(() => parseNativeRootCertificate({ ...record, extra: true })).toThrow(
      /canonical fields/,
    );
  });
});

describe("ServerScopeCertificate canonical signing", () => {
  it("matches locked self-signed and rotated certificate vectors", async () => {
    const anchor = await scopeAnchor();
    const rotation = await scopeRotation(anchor);
    expect({
      anchorPayloadDigest: await serverScopeCertificatePayloadDigest(anchor),
      anchorSignature: anchor.signature,
      anchorSignedRecordDigest: await serverScopeCertificateSignedRecordDigest(anchor),
      rotationPayloadDigest: await serverScopeCertificatePayloadDigest(rotation),
      rotationSignature: rotation.signature,
      rotationSignedRecordDigest: await serverScopeCertificateSignedRecordDigest(rotation),
    }).toEqual({
      anchorPayloadDigest: "USLLWLJEq_UruYASOjoPYEXsIJldgiFG1sQE8DWp0pY",
      anchorSignature:
        "kJRVZP9vIVtPZgjmdIoV8okjrDfMxCRriQtm9YMlWrHK7JpnXSC2qqpXGwcdJxpFS-h8dKUQYSBF84bSihASBw",
      anchorSignedRecordDigest: "gfz84mRaWpcN_2WLEgfQKWskYpEoDxEHnVFmXaC8uV4",
      rotationPayloadDigest: "p2KDYkZPI4qd6GGrhVRx_O4zbSiYPFoB3CJKOkPEhLY",
      rotationSignature:
        "g7-6b8uUKBsyfAwqALRHUyI_VT9GvUW5oKAP5P0zOkkuRa4Gff8QJpv30ZW98CH_b85PanMF4GD1L25wJ__bBw",
      rotationSignedRecordDigest: "4gLkjtHthLTBTv9nbNUgOMwJfPXlWberzgeRDHKCI9U",
    });
    await expect(verifyServerScopeCertificate(anchor, keyBinding(KEY_ONE))).resolves.toEqual(
      anchor,
    );
    await expect(verifyServerScopeCertificate(rotation, keyBinding(KEY_ONE))).resolves.toEqual(
      rotation,
    );
  });

  it("rejects a changed rotation, a transplanted signature, and noncanonical certificate shapes", async () => {
    const anchor = await scopeAnchor();
    const rotation = await scopeRotation(anchor);
    await expect(
      verifyServerScopeCertificate(
        { ...rotation, signature: anchor.signature },
        keyBinding(KEY_ONE),
      ),
    ).rejects.toMatchObject({ reason: "signature-invalid" });
    await expect(
      verifyServerScopeCertificate(
        { ...rotation, subjectPublicKey: anchor.subjectPublicKey },
        keyBinding(KEY_ONE),
      ),
    ).rejects.toMatchObject({ reason: "signer-mismatch" });
    await expect(
      verifyServerScopeCertificate(rotation, keyBinding(KEY_ONE, { keyGeneration: 2 })),
    ).rejects.toMatchObject({ reason: "signer-mismatch" });
    const renamedSameKeyUnsigned = {
      ...rotation,
      subjectIdentityKeyId: "server-key.renamed",
      subjectPublicKey: anchor.subjectPublicKey,
      canonicalPayloadDigest: ZERO_DIGEST,
      signature: ZERO_SIGNATURE,
    };
    const renamedSameKeyPayload = encodeServerScopeCertificatePayload(renamedSameKeyUnsigned);
    await expect(
      verifyServerScopeCertificate(
        {
          ...renamedSameKeyUnsigned,
          canonicalPayloadDigest: base64urlEncode(await sha256(renamedSameKeyPayload)),
          signature: await sign(KEY_ONE, renamedSameKeyPayload),
        },
        keyBinding(KEY_ONE),
      ),
    ).rejects.toMatchObject({ reason: "signer-mismatch" });
    const mismatchedSelfSignedPayload = {
      ...anchor,
      subjectPublicKey: base64urlEncode(KEY_TWO.publicKey),
      canonicalPayloadDigest: ZERO_DIGEST,
      signature: ZERO_SIGNATURE,
    };
    const mismatchedSelfSignedBytes = encodeServerScopeCertificatePayload(
      mismatchedSelfSignedPayload,
    );
    await expect(
      verifyServerScopeCertificate(
        {
          ...mismatchedSelfSignedPayload,
          canonicalPayloadDigest: base64urlEncode(await sha256(mismatchedSelfSignedBytes)),
          signature: await sign(KEY_ONE, mismatchedSelfSignedBytes),
        },
        keyBinding(KEY_ONE),
      ),
    ).rejects.toMatchObject({ reason: "signer-mismatch" });
    expect(() =>
      encodeServerScopeCertificatePayload({ ...anchor, collaborationServerId: "server.safe" }),
    ).toThrow(/rcs_/);
    expect(() =>
      encodeServerScopeCertificatePayload({ ...rotation, supersededSignerMaxSequence: 10 }),
    ).toThrow(/cutoff/);
  });
});

describe("ViewerOnboardingKeyAttestationV1 canonical signing", () => {
  it("locks all four commitment domains and the signed attestation vector", async () => {
    expect({
      authToken: await viewerOnboardingKeyCommitment("auth_token", new Uint8Array(32).fill(10)),
      contentRoot: await viewerOnboardingKeyCommitment("content_root", new Uint8Array(32).fill(11)),
      controlKey: await viewerOnboardingKeyCommitment("control_key", new Uint8Array(32).fill(12)),
      metaKey: await viewerOnboardingKeyCommitment("meta_key", new Uint8Array(32).fill(13)),
    }).toEqual({
      authToken: "pWBz1zWb9avulyQmDAbnhyOaYuxDcfAlFn-Q6j92wQI",
      contentRoot: "G5ujeroOpu570WQkNdcPU0fDlZbRdxYDDhNLjH9GDhg",
      controlKey: "aQBjBPqPGcNYWDxQTyY1YvUFFs3S2omViJXkVc7hhT0",
      metaKey: "BFMmjzlVG7fwh7staF0SvOSm1ky0ith7AuCizbKRv4Q",
    });

    const certificate = await scopeRotation(await scopeAnchor());
    const attestation = await onboardingAttestation(certificate);
    expect({
      payloadHex: toHex(encodeViewerOnboardingKeyAttestationPayload(attestation)),
      payloadDigest: await viewerOnboardingKeyAttestationPayloadDigest(attestation),
      signature: attestation.signature,
      signedRecordDigest: await viewerOnboardingKeyAttestationSignedRecordDigest(attestation),
    }).toEqual({
      payloadHex:
        "0000002572656d6f74652d636c61772f7669657765722d6f6e626f617264696e672d6b6579732f76310000000800000000000000010000001a7263735f416749434167494341674943416749434167494341670000001000112233445566778899aabbccddeeff0000000e73636f70652d636572742e74776f0000000800000000000000020000000e7365727665722d6b65792e74776f00000008000000000000001100000020a56073d7359bf5abee9724260c06e787239a62ec4371f025167f90ea3f76c102000000201b9ba37aba0ea6ee7bd1642435d70f5347c39596d17716030e134b8c7f460e180000002069006304fa8f19c358583c504f263562f50516cdd2da89958895e455cee1853d000000200453268f39551bb7f087bb2d685d12bce4a6d64cb48ad87b02e0a2cdb291bf840000000745643235353139000000075348412d323536",
      payloadDigest: "QmI-7PVcgy0f5tkdtjlnl787YNzX6m9MR9rKOULFnXE",
      signature:
        "HeeoMqNpRg2PbbsJy9hvPkU8lxtIEXMnjNljJb_gN4XajeLnSzW_LG0_xTHNDSNh3VWQKFZ1Si75HXso7nclCg",
      signedRecordDigest: "OTJLOKFo32rkvuo33jOb4YVMEctwbm4R0K_N1OioTcw",
    });
    await expect(
      verifyViewerOnboardingKeyAttestation(attestation, keyBinding(KEY_TWO)),
    ).resolves.toEqual(attestation);
  });

  it("rejects per-key substitution and signature transplant", async () => {
    const certificate = await scopeRotation(await scopeAnchor());
    const attestation = await onboardingAttestation(certificate);
    const otherCommitment = await viewerOnboardingKeyCommitment(
      "meta_key",
      new Uint8Array(32).fill(99),
    );
    await expect(
      verifyViewerOnboardingKeyAttestation(
        { ...attestation, metaKeyCommitment: otherCommitment },
        keyBinding(KEY_TWO),
      ),
    ).rejects.toMatchObject({ reason: "digest-mismatch" });

    const changedUnsigned = {
      ...attestation,
      signerSequence: attestation.signerSequence + 1,
      canonicalPayloadDigest: ZERO_DIGEST,
      signature: ZERO_SIGNATURE,
    };
    const changedPayload = encodeViewerOnboardingKeyAttestationPayload(changedUnsigned);
    const changed = {
      ...changedUnsigned,
      canonicalPayloadDigest: base64urlEncode(await sha256(changedPayload)),
      signature: attestation.signature,
    };
    await expect(
      verifyViewerOnboardingKeyAttestation(changed, keyBinding(KEY_TWO)),
    ).rejects.toMatchObject({ reason: "signature-invalid" });
  });
});
