import { describe, expect, it } from "vitest";
import {
  encodeServerScopeCertificatePayload,
  encodeViewerOnboardingKeyAttestationPayload,
  type ServerScopeCertificateRecord,
  type ViewerOnboardingKeyAttestationV1,
  viewerOnboardingKeyCommitments,
} from "./a1-certificates.js";
import {
  canonicalViewerOnboardingBundleBytes,
  formatViewerOnboardingBundle,
  parseViewerOnboardingBundleV2,
  parseViewerOnboardingBundleWire,
  type ViewerOnboardingBundleV2,
  verifyViewerOnboardingBundle,
  viewerOnboardingBundleChecksum,
} from "./a1-onboarding.js";
import { base64urlEncode } from "./base64url.js";
import { fromHex, sha256, utf8 } from "./bytes.js";
import { CanonicalWriter } from "./canonical.js";

const KEY_ONE = {
  id: "server-key.one",
  seed: fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
  publicKey: fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
} as const;

const KEY_TWO = {
  id: "server-key.two",
  seed: fromHex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"),
  publicKey: fromHex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
} as const;

const AUTH_TOKEN = new Uint8Array(32).fill(10);
const CONTENT_ROOT = new Uint8Array(32).fill(11);
const CONTROL_KEY = new Uint8Array(32).fill(12);
const META_KEY = new Uint8Array(32).fill(13);
const ZERO_DIGEST = base64urlEncode(new Uint8Array(32));
const ZERO_SIGNATURE = base64urlEncode(new Uint8Array(64));

function canonicalId(prefix: string, fill: number): string {
  return `${prefix}${base64urlEncode(new Uint8Array(16).fill(fill))}`;
}

async function machineIdentityId(): Promise<string> {
  return Array.from((await sha256(AUTH_TOKEN)).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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

async function scopeCertificate(
  subject: typeof KEY_ONE | typeof KEY_TWO,
  signer: typeof KEY_ONE | typeof KEY_TWO,
  predecessor: ServerScopeCertificateRecord | null,
): Promise<ServerScopeCertificateRecord> {
  const signerSequence = predecessor === null ? 3 : 11;
  const unsigned = {
    schemaVersion: 1,
    canonicalPayloadSchemaId: "remote-claw/server-scope-certificate/v1",
    scopeCertificateId: predecessor === null ? "scope-cert.one" : "scope-cert.two",
    collaborationServerId: canonicalId("rcs_", 2),
    machineIdentityId: await machineIdentityId(),
    subjectIdentityKeyId: subject.id,
    subjectKeyAlgorithm: "Ed25519",
    subjectPublicKey: base64urlEncode(subject.publicKey),
    keyGeneration: predecessor === null ? 1 : predecessor.keyGeneration + 1,
    issuedAtMs: predecessor === null ? 1_700_000_000_000 : 1_700_000_100_000,
    supersedesScopeCertificateId: predecessor?.scopeCertificateId ?? null,
    signerIdentityKeyId: signer.id,
    signerSequence,
    supersededSignerMaxSequence: predecessor === null ? null : signerSequence,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
    canonicalPayloadDigest: ZERO_DIGEST,
    signature: ZERO_SIGNATURE,
  } satisfies ServerScopeCertificateRecord;
  const payload = encodeServerScopeCertificatePayload(unsigned);
  return {
    ...unsigned,
    canonicalPayloadDigest: base64urlEncode(await sha256(payload)),
    signature: await sign(signer, payload),
  };
}

async function attestation(
  certificate: ServerScopeCertificateRecord,
  key: typeof KEY_ONE | typeof KEY_TWO,
): Promise<ViewerOnboardingKeyAttestationV1> {
  const commitments = await viewerOnboardingKeyCommitments({
    authToken: AUTH_TOKEN,
    contentRoot: CONTENT_ROOT,
    controlKey: CONTROL_KEY,
    metaKey: META_KEY,
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
    signature: await sign(key, payload),
  };
}

async function bundle(rotated = false): Promise<ViewerOnboardingBundleV2> {
  const anchor = await scopeCertificate(KEY_ONE, KEY_ONE, null);
  const tip = rotated ? await scopeCertificate(KEY_TWO, KEY_ONE, anchor) : anchor;
  const tipKey = rotated ? KEY_TWO : KEY_ONE;
  return {
    version: 2,
    machineIdentityId: await machineIdentityId(),
    collaborationServerId: anchor.collaborationServerId,
    authToken: base64urlEncode(AUTH_TOKEN),
    contentRoot: base64urlEncode(CONTENT_ROOT),
    controlKey: base64urlEncode(CONTROL_KEY),
    metaKey: base64urlEncode(META_KEY),
    serverIdentityKey: {
      identityKeyId: tip.subjectIdentityKeyId,
      algorithm: "Ed25519",
      publicKey: tip.subjectPublicKey,
    },
    scopeCertificateChain: rotated ? [anchor, tip] : [anchor],
    keyAttestation: await attestation(tip, tipKey),
  };
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function noncanonicalTailAlias(canonical: string): string {
  const last = canonical.at(-1);
  const index = last === undefined ? -1 : BASE64URL_ALPHABET.indexOf(last);
  if (index < 0 || canonical.length % 4 === 0 || index + 1 >= BASE64URL_ALPHABET.length) {
    throw new Error("fixture has no base64url tail alias");
  }
  return `${canonical.slice(0, -1)}${BASE64URL_ALPHABET[index + 1]}`;
}

async function wireForRawBytes(bytes: Uint8Array): Promise<string> {
  const writer = new CanonicalWriter();
  writer.str("remote-claw/viewer-onboarding-wire-checksum/v2");
  writer.bytes(bytes);
  return `rcp2.${base64urlEncode(bytes)}.${base64urlEncode(await sha256(writer.finish()))}`;
}

describe("ViewerOnboardingBundleV2 canonical transfer", () => {
  it("matches the locked canonical-bundle and checksum vector", async () => {
    const value = await bundle();
    const bytes = canonicalViewerOnboardingBundleBytes(value);
    const wire = await formatViewerOnboardingBundle(value);
    expect({
      canonicalByteLength: bytes.byteLength,
      canonicalBundleDigest: base64urlEncode(await sha256(bytes)),
      checksum: await viewerOnboardingBundleChecksum(value),
      wireLength: wire.length,
      wireDigest: base64urlEncode(await sha256(utf8(wire))),
    }).toEqual({
      canonicalByteLength: 1137,
      canonicalBundleDigest: "bz4IFo3-lQl0o4NwhLCJFp0nNGNrV8TITYDugsyO9tY",
      checksum: "-NXSJGWJwDWCuxzFTVYIZoSXcWWIUnqYBAjmLAY3SXE",
      wireLength: 1565,
      wireDigest: "4Pz8IPa1-P5ZXmdIc-I0-RZ28KdXkQ9cNP-nGBixwpc",
    });
    await expect(parseViewerOnboardingBundleWire(wire)).resolves.toEqual(
      parseViewerOnboardingBundleV2(value),
    );
    await expect(verifyViewerOnboardingBundle(wire)).resolves.toEqual(
      parseViewerOnboardingBundleV2(value),
    );
  });

  it("verifies an oldest-to-newest rotation and an exact trusted suffix replay", async () => {
    const rotated = await bundle(true);
    await expect(verifyViewerOnboardingBundle(rotated)).resolves.toEqual(
      parseViewerOnboardingBundleV2(rotated),
    );

    const tip = rotated.scopeCertificateChain[1];
    expect(tip).toBeDefined();
    if (tip === undefined) throw new Error("missing test tip");
    const suffix = { ...rotated, scopeCertificateChain: [tip] };
    await expect(
      verifyViewerOnboardingBundle(suffix, {
        trustedFirstCertificate: tip,
        expectedServerIdentityKey: rotated.serverIdentityKey,
      }),
    ).resolves.toEqual(parseViewerOnboardingBundleV2(suffix));
    await expect(
      verifyViewerOnboardingBundle(suffix, {
        trustedFirstCertificate: {
          ...tip,
          signature: base64urlEncode(new Uint8Array(64).fill(99)),
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a renamed identity that reuses the predecessor public key as a rotation", async () => {
    const anchor = await scopeCertificate(KEY_ONE, KEY_ONE, null);
    const unsignedSuccessor = {
      schemaVersion: 1,
      canonicalPayloadSchemaId: "remote-claw/server-scope-certificate/v1",
      scopeCertificateId: "scope-cert.renamed",
      collaborationServerId: anchor.collaborationServerId,
      machineIdentityId: anchor.machineIdentityId,
      subjectIdentityKeyId: "server-key.renamed",
      subjectKeyAlgorithm: "Ed25519",
      subjectPublicKey: anchor.subjectPublicKey,
      keyGeneration: 2,
      issuedAtMs: 1_700_000_100_000,
      supersedesScopeCertificateId: anchor.scopeCertificateId,
      signerIdentityKeyId: anchor.subjectIdentityKeyId,
      signerSequence: 11,
      supersededSignerMaxSequence: 11,
      signatureAlgorithm: "Ed25519",
      canonicalPayloadDigestAlgorithm: "SHA-256",
      canonicalPayloadDigest: ZERO_DIGEST,
      signature: ZERO_SIGNATURE,
    } satisfies ServerScopeCertificateRecord;
    const successorPayload = encodeServerScopeCertificatePayload(unsignedSuccessor);
    const successor: ServerScopeCertificateRecord = {
      ...unsignedSuccessor,
      canonicalPayloadDigest: base64urlEncode(await sha256(successorPayload)),
      signature: await sign(KEY_ONE, successorPayload),
    };
    const renamed: ViewerOnboardingBundleV2 = {
      ...(await bundle()),
      serverIdentityKey: {
        identityKeyId: successor.subjectIdentityKeyId,
        algorithm: "Ed25519",
        publicKey: successor.subjectPublicKey,
      },
      scopeCertificateChain: [anchor, successor],
      keyAttestation: await attestation(successor, KEY_ONE),
    };

    await expect(verifyViewerOnboardingBundle(renamed)).rejects.toMatchObject({
      reason: "certificate-chain-invalid",
    });
  });

  it("rejects a later rotation that reintroduces any earlier public key under a new ID", async () => {
    const rotated = await bundle(true);
    const [anchor, predecessor] = rotated.scopeCertificateChain;
    if (anchor === undefined || predecessor === undefined) throw new Error("missing test chain");
    const unsignedSuccessor = {
      schemaVersion: 1,
      canonicalPayloadSchemaId: "remote-claw/server-scope-certificate/v1",
      scopeCertificateId: "scope-cert.reintroduced",
      collaborationServerId: predecessor.collaborationServerId,
      machineIdentityId: predecessor.machineIdentityId,
      subjectIdentityKeyId: "server-key.reintroduced",
      subjectKeyAlgorithm: "Ed25519",
      subjectPublicKey: anchor.subjectPublicKey,
      keyGeneration: 3,
      issuedAtMs: 1_700_000_200_000,
      supersedesScopeCertificateId: predecessor.scopeCertificateId,
      signerIdentityKeyId: predecessor.subjectIdentityKeyId,
      signerSequence: 12,
      supersededSignerMaxSequence: 12,
      signatureAlgorithm: "Ed25519",
      canonicalPayloadDigestAlgorithm: "SHA-256",
      canonicalPayloadDigest: ZERO_DIGEST,
      signature: ZERO_SIGNATURE,
    } satisfies ServerScopeCertificateRecord;
    const successorPayload = encodeServerScopeCertificatePayload(unsignedSuccessor);
    const successor: ServerScopeCertificateRecord = {
      ...unsignedSuccessor,
      canonicalPayloadDigest: base64urlEncode(await sha256(successorPayload)),
      signature: await sign(KEY_TWO, successorPayload),
    };
    const reintroduced: ViewerOnboardingBundleV2 = {
      ...rotated,
      serverIdentityKey: {
        identityKeyId: successor.subjectIdentityKeyId,
        algorithm: "Ed25519",
        publicKey: successor.subjectPublicKey,
      },
      scopeCertificateChain: [anchor, predecessor, successor],
      keyAttestation: await attestation(successor, KEY_ONE),
    };

    await expect(verifyViewerOnboardingBundle(reintroduced)).rejects.toMatchObject({
      reason: "certificate-chain-invalid",
    });
  });

  it("rejects substitution of each operational key before returning a verified bundle", async () => {
    const value = await bundle();
    for (const field of ["authToken", "contentRoot", "controlKey", "metaKey"] as const) {
      const changed = { ...value, [field]: base64urlEncode(new Uint8Array(32).fill(99)) };
      await expect(verifyViewerOnboardingBundle(changed)).rejects.toMatchObject({
        reason: field === "authToken" ? "identity-mismatch" : "attestation-mismatch",
      });
    }
  });

  it("rejects certificate, scope, generation, key, and signature transplants", async () => {
    const value = await bundle(true);
    const [anchor, tip] = value.scopeCertificateChain;
    if (anchor === undefined || tip === undefined) throw new Error("missing test chain");

    await expect(
      verifyViewerOnboardingBundle({
        ...value,
        scopeCertificateChain: [{ ...anchor, signature: tip.signature }, tip],
      }),
    ).rejects.toMatchObject({ reason: "certificate-chain-invalid" });
    await expect(
      verifyViewerOnboardingBundle({
        ...value,
        scopeCertificateChain: [anchor, { ...tip, keyGeneration: 3 }],
      }),
    ).rejects.toMatchObject({ reason: "certificate-chain-invalid" });
    await expect(
      verifyViewerOnboardingBundle({
        ...value,
        collaborationServerId: canonicalId("rcs_", 8),
      }),
    ).rejects.toMatchObject({ reason: "certificate-chain-invalid" });
    await expect(
      verifyViewerOnboardingBundle({
        ...value,
        serverIdentityKey: { ...value.serverIdentityKey, identityKeyId: KEY_ONE.id },
      }),
    ).rejects.toMatchObject({ reason: "key-mismatch" });
  });

  it("rejects malformed, corrupted, aliased, oversized, and trailing-byte wire forms", async () => {
    const value = await bundle();
    const wire = await formatViewerOnboardingBundle(value);
    const [prefix, encoded, checksum] = wire.split(".");
    expect(prefix).toBe("rcp2");
    if (encoded === undefined || checksum === undefined) throw new Error("malformed test wire");

    await expect(
      parseViewerOnboardingBundleWire(`rcp1.${encoded}.${checksum}`),
    ).rejects.toMatchObject({ reason: "bad-prefix" });
    const changed = `${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}`;
    await expect(
      parseViewerOnboardingBundleWire(`rcp2.${changed}.${checksum}`),
    ).rejects.toMatchObject({ reason: "bad-checksum" });
    await expect(
      parseViewerOnboardingBundleWire(`rcp2.${encoded}.${noncanonicalTailAlias(checksum)}`),
    ).rejects.toMatchObject({ reason: "bad-encoding" });
    await expect(parseViewerOnboardingBundleWire(`${wire}.extra`)).rejects.toMatchObject({
      reason: "bad-encoding",
    });
    await expect(
      parseViewerOnboardingBundleWire(`rcp2.${"A".repeat(350_000)}.${checksum}`),
    ).rejects.toMatchObject({ reason: "bad-length" });

    const bytes = canonicalViewerOnboardingBundleBytes(value);
    const withTrailingByte = new Uint8Array(bytes.byteLength + 1);
    withTrailingByte.set(bytes);
    withTrailingByte[bytes.byteLength] = 1;
    await expect(
      parseViewerOnboardingBundleWire(await wireForRawBytes(withTrailingByte)),
    ).rejects.toMatchObject({ reason: "noncanonical-wire" });
  });

  it("rejects duplicate IDs, duplicate subject declarations, bad namespaces, and oversized chains", async () => {
    const value = await bundle(true);
    const [anchor, tip] = value.scopeCertificateChain;
    if (anchor === undefined || tip === undefined) throw new Error("missing test chain");
    await expect(
      verifyViewerOnboardingBundle({ ...value, scopeCertificateChain: [anchor, anchor] }),
    ).rejects.toMatchObject({ reason: "certificate-chain-invalid" });
    await expect(
      verifyViewerOnboardingBundle({
        ...value,
        scopeCertificateChain: [
          anchor,
          { ...tip, subjectIdentityKeyId: anchor.subjectIdentityKeyId },
        ],
      }),
    ).rejects.toThrow();
    expect(() =>
      parseViewerOnboardingBundleV2({ ...value, collaborationServerId: "server.safe" }),
    ).toThrow(/rcs_/);
    expect(() =>
      parseViewerOnboardingBundleV2({
        ...value,
        scopeCertificateChain: Array.from({ length: 33 }, () => anchor),
      }),
    ).toThrow(/1-32/);
  });
});
