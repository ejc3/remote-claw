import {
  base64urlEncode,
  nativeRootCanonicalPayloadDigest as browserNativeRootCanonicalPayloadDigest,
  nativeRootCertificateSignedRecordDigest as browserNativeRootCertificateSignedRecordDigest,
} from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId, parseEd25519Signature } from "./ids.js";
import {
  canonicalNativeRootPayload,
  type NativeRootActivationOperationRecord,
  type NativeRootCertificate,
  nativeBindingEvidenceDigest,
  nativeRootActivationOperationDigest,
  nativeRootCanonicalPayloadDigest,
  nativeRootCertificateId,
  nativeRootSignedRecordDigest,
  parseNativeRootActivationOperationRecord,
  parseNativeRootActivationPreparationInput,
  parseNativeRootCertificate,
  verifyNativeRootActivationOperationDigest,
  verifyNativeRootCanonicalPayloadDigest,
} from "./native-root.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const SERVER_ID = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const CHAT_ID = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 2)}`);
const EDGE_ID = parseA1CanonicalId("inwardEdge", `rcie_${encoded(16, 3)}`);
const BINDING_ID = parseA1CanonicalId("nativeBinding", `rcnb_${encoded(16, 4)}`);
const RUNTIME_ID = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 5)}`);
const COORDINATOR_LEASE_ID = parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 6)}`);
const CONVERSATION_LEASE_ID = parseA1CanonicalId(
  "nativeConversationLease",
  `rcncl_${encoded(16, 7)}`,
);
const PAYLOAD_REF = parseA1CanonicalId("protectedHandle", `rcph_${encoded(16, 8)}`);
const DIGEST = parseA1Digest(encoded(32, 9));
const SIGNATURE = parseEd25519Signature(encoded(64, 10));
const MACHINE_IDENTITY_ID = "0".repeat(32);

function certificate(overrides: Partial<NativeRootCertificate> = {}): NativeRootCertificate {
  return {
    schemaVersion: 1,
    canonicalPayloadSchemaId: "remote-claw/native-root-certificate/v1",
    rootPathCertificateId: parseA1SafeId("native-root-1"),
    kind: "native-root",
    terminalNativeBindingId: BINDING_ID,
    terminalServerId: SERVER_ID,
    terminalLogicalChatId: CHAT_ID,
    terminalTopologyGeneration: 1,
    nativeBindingEvidenceDigest: DIGEST,
    runtimeOwnerIdentityKeyId: parseA1SafeId("runtime-owner-key-1"),
    runtimeOwnerKeyGeneration: 1,
    signerSequence: 0,
    issuedAtMs: 100,
    expiresAtMs: 300_100,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
    canonicalPayloadDigest: DIGEST,
    signature: SIGNATURE,
    ...overrides,
  };
}

function operation(
  overrides: Partial<NativeRootActivationOperationRecord> = {},
): NativeRootActivationOperationRecord {
  return {
    operationId: parseA1SafeId("activate-native-root-1"),
    operationSchemaId: "remote-claw/native-root-activation/v1",
    operationDigest: DIGEST,
    kind: "activate",
    rootPathCertificateId: parseA1SafeId("native-root-1"),
    expectedPriorRootPathCertificateId: null,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
    inwardEdgeId: EDGE_ID,
    terminalTopologyGeneration: 1,
    nativeBindingId: BINDING_ID,
    runtimeId: RUNTIME_ID,
    nativeIncarnation: 1,
    nativeBindingIncarnationId: parseA1SafeId("binding-incarnation-1"),
    attachmentId: parseA1SafeId("attachment-1"),
    attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
    transportEpoch: 1,
    nativeConversationLeaseId: CONVERSATION_LEASE_ID,
    nativeConversationLeaseGeneration: 1,
    nativeRegistrationPublicationId: parseA1SafeId("publication-1"),
    publicationGeneration: 1,
    bindingGateGeneration: 1,
    runtimeOwnerServiceLeaseId: parseA1SafeId("runtime-owner-lease-1"),
    runtimeOwnerServiceEpoch: 1,
    coordinatorLeaseId: COORDINATOR_LEASE_ID,
    coordinatorEpoch: 1,
    runtimeOwnerIdentityKeyId: parseA1SafeId("runtime-owner-key-1"),
    runtimeOwnerKeyGeneration: 1,
    signerSequence: 0,
    nativeBindingEvidenceDigest: DIGEST,
    canonicalPayloadRef: PAYLOAD_REF,
    canonicalPayloadDigest: DIGEST,
    signedRecordDigest: null,
    preparedAtMs: 90,
    issuedAtMs: 100,
    expiresAtMs: 300_100,
    committedAtMs: null,
    state: "prepared",
    ...overrides,
  };
}

function payloadInput(record: NativeRootCertificate) {
  const { canonicalPayloadDigest: _digest, signature: _signature, ...payload } = record;
  return payload;
}

function preparationInput(record: NativeRootActivationOperationRecord) {
  const {
    operationDigest: _operationDigest,
    signedRecordDigest: _signedRecordDigest,
    committedAtMs: _committedAtMs,
    state: _state,
    ...preparation
  } = record;
  return preparation;
}

describe("native terminal-root contracts", () => {
  it("pins the native-binding, canonical-payload, signed-record, and operation digests", () => {
    const evidence = nativeBindingEvidenceDigest({
      runtimeId: RUNTIME_ID,
      nativeIncarnation: 1,
      nativeBindingId: BINDING_ID,
      descriptor: { product: "codex", access: "app-server" },
      nativeConversationId: parseA1SafeId("thread-1"),
      attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
    });
    const unsigned = certificate({ nativeBindingEvidenceDigest: evidence });
    const payloadDigest = nativeRootCanonicalPayloadDigest(payloadInput(unsigned));
    const signed = certificate({
      nativeBindingEvidenceDigest: evidence,
      canonicalPayloadDigest: payloadDigest,
    });
    const signedDigest = nativeRootSignedRecordDigest(signed);
    const prepared = operation({
      nativeBindingEvidenceDigest: evidence,
      canonicalPayloadDigest: payloadDigest,
    });
    const operationDigest = nativeRootActivationOperationDigest(preparationInput(prepared));

    expect(base64urlEncode(canonicalNativeRootPayload(payloadInput(signed)))).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect({ evidence, payloadDigest, signedDigest, operationDigest }).toEqual({
      evidence: "9v4YZzAQiuMFNudvx0r6y17A_J0pvRMIeXy3aYwjvkI",
      payloadDigest: "5QroaoayRSc6Xr7Ss8bQUauu3gMnlrVRSIfLIGJQ2XM",
      signedDigest: "4V4p0VtaCgcBoiKPGJ9eEYnLVqXXMz8wQqr8T_Grr2Q",
      operationDigest: "ciYOAsK5JUDZNmIJCNKJfgFDIB8iPTXHmjMqkrmacq4",
    });
    expect(() =>
      verifyNativeRootCanonicalPayloadDigest({ ...signed, canonicalPayloadDigest: DIGEST }),
    ).toThrow(/does not match its payload/);
    const scopedRootId = nativeRootCertificateId({
      machineIdentityId: MACHINE_IDENTITY_ID,
      collaborationServerId: SERVER_ID,
      logicalChatId: CHAT_ID,
      operationId: prepared.operationId,
    });
    expect(scopedRootId).toBe("nrpc_jOgfeDb_xNOrDU3-qegUUgQKOkbJoUbvTv9zZDC2mUY");
    expect(
      nativeRootCertificateId({
        machineIdentityId: MACHINE_IDENTITY_ID,
        collaborationServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 11)}`),
        logicalChatId: CHAT_ID,
        operationId: prepared.operationId,
      }),
    ).not.toBe(scopedRootId);
  });

  it("keeps the Node persistence and browser verification native-root digests byte-identical", async () => {
    const unsigned = certificate({
      nativeBindingEvidenceDigest: nativeBindingEvidenceDigest({
        runtimeId: RUNTIME_ID,
        nativeIncarnation: 1,
        nativeBindingId: BINDING_ID,
        descriptor: { product: "codex", access: "app-server" },
        nativeConversationId: parseA1SafeId("thread-1"),
        attachmentLeaseId: parseA1SafeId("attachment-lease-1"),
      }),
    });
    const payload = payloadInput(unsigned);
    const canonicalPayloadDigest = nativeRootCanonicalPayloadDigest(payload);
    const signed = certificate({
      nativeBindingEvidenceDigest: unsigned.nativeBindingEvidenceDigest,
      canonicalPayloadDigest,
    });

    await expect(browserNativeRootCanonicalPayloadDigest(payload)).resolves.toBe(
      canonicalPayloadDigest,
    );
    await expect(browserNativeRootCertificateSignedRecordDigest(signed)).resolves.toBe(
      nativeRootSignedRecordDigest(signed),
    );
  });

  it("rejects unknown fields, noncanonical identifiers, and overlong lifetimes", () => {
    expect(() => parseNativeRootCertificate({ ...certificate(), extra: true })).toThrow(
      /exactly the selected fields/,
    );
    expect(() =>
      parseNativeRootCertificate({
        ...certificate(),
        rootPathCertificateId: "new prefix is forbidden!",
      }),
    ).toThrow(/A-Za-z0-9/);
    expect(() => parseNativeRootCertificate({ ...certificate(), expiresAtMs: 300_101 })).toThrow(
      /at most 300000ms/,
    );
  });

  it("enforces activate/renew preparation and exact committed linkage", () => {
    expect(
      Object.keys(parseNativeRootActivationPreparationInput(preparationInput(operation()))),
    ).not.toEqual(
      expect.arrayContaining(["operationDigest", "signedRecordDigest", "committedAtMs", "state"]),
    );
    expect(parseNativeRootActivationOperationRecord(operation())).toMatchObject({
      kind: "activate",
      state: "prepared",
      expectedPriorRootPathCertificateId: null,
    });
    expect(() =>
      parseNativeRootActivationOperationRecord(
        operation({ kind: "renew", expectedPriorRootPathCertificateId: null }),
      ),
    ).toThrow(/present for renewal/);
    expect(() =>
      parseNativeRootActivationOperationRecord(
        operation({
          signedRecordDigest: DIGEST,
          committedAtMs: 101,
          state: "prepared",
        }),
      ),
    ).toThrow(/absent while the operation is prepared/);
    const digest = nativeRootActivationOperationDigest(preparationInput(operation()));
    const committed = operation({
      operationDigest: digest,
      signedRecordDigest: parseA1Digest(encoded(32, 11)),
      committedAtMs: 120,
      state: "committed",
    });
    expect(() => verifyNativeRootActivationOperationDigest(committed)).not.toThrow();
    expect(() =>
      parseNativeRootActivationOperationRecord({ ...committed, committedAtMs: 300_100 }),
    ).toThrow(/before expiry/);
  });
});
