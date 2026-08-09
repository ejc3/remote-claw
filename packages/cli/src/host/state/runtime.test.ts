import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest, parseWardenLaunchNonce } from "./ids.js";
import {
  parseInferenceRuntimeBindingRecord,
  parseInwardCollaborationEdgeRecord,
  parseLocalNativeConversationRecord,
  parseLocalNativeConversationTransitionRecord,
  parseNativeBindingIncarnationRecord,
  parseNativeBindingRuntimeGateRecord,
  parseNativeRuntimeContainmentRecord,
  parseNativeRuntimeIncarnationRecord,
  parseNativeRuntimeRecord,
  parseNativeTransportAttachmentRecord,
  parseNativeTransportLeaseRecord,
  parseRuntimeOwnerAssignmentRecord,
  parseRuntimeOwnerIdentityKeyRecord,
  parseRuntimeOwnerServiceLeaseRecord,
  parseRuntimeOwnerSignatureReservationRecord,
  parseRuntimeOwnerSignedRecordAcceptanceRecord,
  RUNTIME_OWNER_SIGNATURE_SCHEMAS,
} from "./runtime.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const machineIdentityId = "0123456789abcdef".repeat(2);
const collaborationServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const targetServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 2)}`);
const logicalChatId = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 3)}`);
const targetLogicalChatId = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 4)}`);
const inwardEdgeId = parseA1CanonicalId("inwardEdge", `rcie_${encoded(16, 8)}`);
const targetInwardEdgeId = parseA1CanonicalId("inwardEdge", `rcie_${encoded(16, 9)}`);
const nativeBindingId = parseA1CanonicalId("nativeBinding", `rcnb_${encoded(16, 5)}`);
const coordinatorLeaseId = parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 6)}`);
const nativeRuntimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 7)}`);
const projectId = parseA1CanonicalId("project", `rcpj_${encoded(16, 10)}`);
const wardenLaunchNonce = parseWardenLaunchNonce(encoded(32, 11));

function digest(fill: number) {
  return parseA1Digest(encoded(32, fill));
}

describe("runtime owner and incarnation records", () => {
  it("enforces the independent runtime-owner lease epoch and lifecycle", () => {
    const current = {
      runtimeOwnerServiceLeaseId: "runtime-owner-lease-1",
      machineIdentityId,
      runtimeOwnerServiceEpoch: 1,
      ownerInstanceId: "runtime-owner-process-1",
      ownerProcessStartIdentitySchemaId: "remote-claw/owner-process-start-identity/v1",
      ownerProcessStartIdentityRef: "owner-process-start-identity-1",
      ownerProcessStartIdentityDigest: digest(1),
      acquiredAtMs: 100,
      heartbeatDeadlineMs: 150,
      releasedAtMs: null,
      state: "current",
    };
    const released = {
      ...current,
      releasedAtMs: 140,
      state: "released",
    };

    for (const value of [current, released]) {
      const parsed = parseRuntimeOwnerServiceLeaseRecord(value);
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    expect(() =>
      parseRuntimeOwnerServiceLeaseRecord({ ...current, runtimeOwnerServiceEpoch: 0 }),
    ).toThrow(/greater than zero/);
    expect(() =>
      parseRuntimeOwnerServiceLeaseRecord({ ...current, heartbeatDeadlineMs: 99 }),
    ).toThrow(/must be after acquisition/);
    expect(() =>
      parseRuntimeOwnerServiceLeaseRecord({ ...current, heartbeatDeadlineMs: 100 }),
    ).toThrow(/must be after acquisition/);
    expect(() => parseRuntimeOwnerServiceLeaseRecord({ ...current, releasedAtMs: 120 })).toThrow(
      /must be null while the lease is current/,
    );
    expect(() => parseRuntimeOwnerServiceLeaseRecord({ ...released, releasedAtMs: null })).toThrow(
      /must be present for a released lease/,
    );
    expect(() => parseRuntimeOwnerServiceLeaseRecord({ ...released, releasedAtMs: 150 })).toThrow(
      /must precede lease expiry/,
    );
    expect(() =>
      parseRuntimeOwnerServiceLeaseRecord({ ...current, state: "expired", releasedAtMs: 120 }),
    ).toThrow(/must be null while the lease is expired/);
  });

  it("keeps one stable runtime root above its positive incarnation lineage", () => {
    const current = {
      runtimeId: nativeRuntimeId,
      descriptor: { product: "codex", access: "app-server" },
      wardenLaunchNonce,
      initialStartIdentitySchemaId: "remote-claw/codex-start-identity/v1",
      initialStartIdentityRef: "start-identity-1",
      initialStartIdentityDigest: digest(2),
      currentNativeIncarnation: 1,
      currentRuntimeOwnerAssignmentId: "runtime-owner-assignment-1",
      createdAtMs: 175,
      closedAtMs: null,
      state: "current",
    };
    const closed = {
      ...current,
      currentNativeIncarnation: null,
      currentRuntimeOwnerAssignmentId: null,
      closedAtMs: 300,
      state: "closed",
    };

    expect(parseNativeRuntimeRecord(current)).toEqual(current);
    expect(parseNativeRuntimeRecord(closed)).toEqual(closed);
    expect(() => parseNativeRuntimeRecord({ ...current, currentNativeIncarnation: 0 })).toThrow(
      /greater than zero/,
    );
    expect(() =>
      parseNativeRuntimeRecord({ ...current, currentRuntimeOwnerAssignmentId: null }),
    ).toThrow(/both be null or both be present/);
    expect(() => parseNativeRuntimeRecord({ ...closed, currentNativeIncarnation: 1 })).toThrow(
      /both be null or both be present|must be null/,
    );
    expect(() => parseNativeRuntimeRecord({ ...current, closedAtMs: 200 })).toThrow(
      /exactly when the runtime is closed/,
    );
    expect(() => parseNativeRuntimeRecord({ ...closed, closedAtMs: 174 })).toThrow(
      /must not precede creation/,
    );
    expect(() => parseNativeRuntimeRecord({ ...current, extra: true })).toThrow(
      /exactly the selected fields/,
    );
  });

  it("records immutable creation and takeover owner assignments", () => {
    const creation = {
      runtimeOwnerAssignmentId: "runtime-owner-assignment-1",
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 1,
      assignmentGeneration: 1,
      runtimeOwnerServiceLeaseId: "runtime-owner-lease-1",
      runtimeOwnerServiceEpoch: 1,
      assignedAtMs: 200,
      supersedesRuntimeOwnerAssignmentId: null,
      reason: "creation",
      assignmentEvidenceSchemaId: "remote-claw/codex-start-identity/v1",
      assignmentEvidenceRef: "start-identity-1",
      assignmentEvidenceDigest: digest(7),
    };
    const takeover = {
      ...creation,
      runtimeOwnerAssignmentId: "runtime-owner-assignment-2",
      assignmentGeneration: 2,
      runtimeOwnerServiceLeaseId: "runtime-owner-lease-2",
      runtimeOwnerServiceEpoch: 2,
      assignedAtMs: 250,
      supersedesRuntimeOwnerAssignmentId: creation.runtimeOwnerAssignmentId,
      reason: "takeover",
      assignmentEvidenceSchemaId: "remote-claw/same-process-reattachment/v1",
      assignmentEvidenceRef: "same-process-reattachment-1",
      assignmentEvidenceDigest: digest(8),
    };

    expect(parseRuntimeOwnerAssignmentRecord(creation)).toEqual(creation);
    expect(parseRuntimeOwnerAssignmentRecord(takeover)).toEqual(takeover);
    expect(() => parseRuntimeOwnerAssignmentRecord({ ...creation, nativeIncarnation: 0 })).toThrow(
      /greater than zero/,
    );
    expect(() => parseRuntimeOwnerAssignmentRecord({ ...creation, reason: "takeover" })).toThrow(
      /generation one must be creation/,
    );
    expect(() =>
      parseRuntimeOwnerAssignmentRecord({
        ...takeover,
        supersedesRuntimeOwnerAssignmentId: null,
      }),
    ).toThrow(/later generations must be takeover/);
    expect(() =>
      parseRuntimeOwnerAssignmentRecord({
        ...takeover,
        supersedesRuntimeOwnerAssignmentId: takeover.runtimeOwnerAssignmentId,
      }),
    ).toThrow(/must not reference the assignment itself/);
  });

  it("requires positive evidence for exact replacement or termination containment", () => {
    const replacement = {
      nativeRuntimeContainmentId: "runtime-containment-1",
      runtimeId: nativeRuntimeId,
      predecessorNativeIncarnation: 1,
      successorNativeIncarnation: 2,
      kind: "replacement",
      evidenceSchemaId: "remote-claw/process-stop-evidence/v1",
      evidenceRef: "process-stop-evidence-1",
      evidenceDigest: digest(9),
      runtimeOwnerServiceLeaseId: "runtime-owner-lease-2",
      runtimeOwnerServiceEpoch: 2,
      containedAtMs: 275,
    } as const;
    const termination = {
      ...replacement,
      nativeRuntimeContainmentId: "runtime-containment-2",
      successorNativeIncarnation: null,
      kind: "termination",
    } as const;

    expect(parseNativeRuntimeContainmentRecord(replacement)).toEqual(replacement);
    expect(parseNativeRuntimeContainmentRecord(termination)).toEqual(termination);
    expect(() =>
      parseNativeRuntimeContainmentRecord({
        ...replacement,
        successorNativeIncarnation: 3,
      }),
    ).toThrow(/exactly one greater/);
    expect(() =>
      parseNativeRuntimeContainmentRecord({
        ...termination,
        successorNativeIncarnation: 2,
      }),
    ).toThrow(/must be null for termination/);
    expect(() =>
      parseNativeRuntimeContainmentRecord({
        ...replacement,
        evidenceDigest: "not-a-digest",
      }),
    ).toThrow(/32 bytes/);
  });

  it("keeps provider-neutral runtime identity separate from inference request identity", () => {
    const current = {
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 1,
      descriptor: { product: "codex", access: "app-server" },
      runtimeOwnerServiceLeaseId: "runtime-owner-lease-1",
      runtimeOwnerServiceEpoch: 1,
      startIdentitySchemaId: "remote-claw/codex-start-identity/v1",
      startIdentityRef: "start-identity-1",
      startIdentityDigest: digest(7),
      startedAtMs: 200,
      closedAtMs: null,
      state: "current",
    };
    const closed = {
      ...current,
      closedAtMs: 250,
      state: "closed",
    };

    expect(parseNativeRuntimeIncarnationRecord(current)).toEqual(current);
    expect(parseNativeRuntimeIncarnationRecord(closed)).toEqual(closed);
    expect(() =>
      parseNativeRuntimeIncarnationRecord({
        ...current,
        nativeRequestNamespaceId: "must-live-on-inference-binding",
      }),
    ).toThrow(/exactly the selected fields/);
    expect(() =>
      parseNativeRuntimeIncarnationRecord({
        ...current,
        runtimeId: nativeBindingId,
      }),
    ).toThrow(/rcrt_/);
    expect(() => parseNativeRuntimeIncarnationRecord({ ...current, closedAtMs: 250 })).toThrow(
      /exactly when the incarnation is closed/,
    );
    expect(() => parseNativeRuntimeIncarnationRecord({ ...closed, closedAtMs: 199 })).toThrow(
      /must not precede start/,
    );
    expect(() => parseNativeRuntimeIncarnationRecord({ ...current, nativeIncarnation: 0 })).toThrow(
      /greater than zero/,
    );
  });

  it("accepts the separate inference binding proof and rejects incomplete extensions", () => {
    const value = {
      inferenceRuntimeBindingId: "inference-binding-1",
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 0,
      facadeProtocolSchemaId: "remote-claw/openai-facade/v1",
      nativeRequestNamespaceId: "native-request-namespace-1",
      nativeRequestIdExtractionSchemaId: "remote-claw/request-id-extraction/v1",
      nativeRequestIdUniquenessProofRef: "request-id-proof-1",
      nativeRequestIdUniquenessProofDigest: digest(8),
      canonicalProviderRequestSchemaId: "remote-claw/openai-request/v1",
      currentInferenceLeaseId: "inference-lease-1",
      state: "current",
    };

    const parsed = parseInferenceRuntimeBindingRecord(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() =>
      parseInferenceRuntimeBindingRecord({
        ...value,
        nativeRequestIdUniquenessProofRef: "",
      }),
    ).toThrow(/non-empty string|1-128 ASCII bytes/);
    const { nativeRequestIdUniquenessProofDigest: _, ...incomplete } = value;
    expect(() => parseInferenceRuntimeBindingRecord(incomplete)).toThrow(
      /exactly the selected fields/,
    );
  });

  it("records the exact binding-to-runtime incarnation join and close boundary", () => {
    const current = {
      nativeBindingIncarnationId: "binding-incarnation-1",
      collaborationServerId,
      logicalChatId,
      nativeBindingId,
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 1,
      semanticConversationId: "thread-1",
      createdAtMs: 300,
      closedAtMs: null,
      state: "current",
    };
    const closed = {
      ...current,
      closedAtMs: 350,
      state: "closed",
    };

    expect(parseNativeBindingIncarnationRecord(current)).toEqual(current);
    expect(parseNativeBindingIncarnationRecord(closed)).toEqual(closed);
    expect(() => parseNativeBindingIncarnationRecord({ ...current, closedAtMs: 350 })).toThrow(
      /exactly when the binding incarnation is closed/,
    );
    expect(() => parseNativeBindingIncarnationRecord({ ...closed, closedAtMs: 299 })).toThrow(
      /must not precede creation/,
    );
  });
});

describe("runtime-local conversation transition contracts", () => {
  const conversation = {
    localNativeConversationId: "local-conversation-1",
    descriptor: { product: "opencode", access: "server" },
    projectId,
    runtimeId: nativeRuntimeId,
    nativeIncarnation: 1,
    semanticConversationId: "ses-1",
    parentLocalNativeConversationId: null,
    state: "open",
  } as const;

  it("keeps local conversation identity runtime-scoped and rejects self-parenting", () => {
    const parsed = parseLocalNativeConversationRecord(conversation);
    expect(parsed).toEqual(conversation);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() =>
      parseLocalNativeConversationRecord({
        ...conversation,
        parentLocalNativeConversationId: conversation.localNativeConversationId,
      }),
    ).toThrow(/must not reference the conversation itself/);
    expect(() =>
      parseLocalNativeConversationRecord({ ...conversation, nativeIncarnation: 0 }),
    ).toThrow(/greater than zero/);
    expect(() =>
      parseLocalNativeConversationRecord({ ...conversation, projectId: "project-1" }),
    ).toThrow(/rcpj_/);
  });

  it("enforces source/target topology for every local transition family", () => {
    const base = {
      localTransitionId: "local-transition-1",
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 1,
      localTransitionSeq: 1,
      kind: "new",
      sourceLocalNativeConversationId: null,
      targetLocalNativeConversationId: "local-conversation-2",
      observedSemanticConversationId: "ses-2",
      nativeEvidenceSchemaId: "remote-claw/native-conversation-observation/v1",
      nativeEvidenceRef: "native-evidence-1",
      nativeEvidenceDigest: digest(12),
      observedAtMs: 400,
    } as const;
    const cases = [
      base,
      { ...base, kind: "discover", observedSemanticConversationId: null },
      {
        ...base,
        kind: "clear",
        sourceLocalNativeConversationId: "local-conversation-1",
      },
      {
        ...base,
        kind: "fork",
        sourceLocalNativeConversationId: "local-conversation-1",
      },
      {
        ...base,
        kind: "switch",
        sourceLocalNativeConversationId: "local-conversation-1",
      },
      {
        ...base,
        kind: "archive",
        sourceLocalNativeConversationId: "local-conversation-2",
      },
      {
        ...base,
        kind: "unarchive",
        sourceLocalNativeConversationId: "local-conversation-2",
      },
    ] as const;
    for (const value of cases) {
      expect(parseLocalNativeConversationTransitionRecord(value)).toEqual(value);
    }
    expect(() =>
      parseLocalNativeConversationTransitionRecord({
        ...base,
        sourceLocalNativeConversationId: "local-conversation-1",
      }),
    ).toThrow(/must be null for new/);
    expect(() =>
      parseLocalNativeConversationTransitionRecord({
        ...base,
        kind: "fork",
        sourceLocalNativeConversationId: null,
      }),
    ).toThrow(/must name a distinct source for fork/);
    expect(() =>
      parseLocalNativeConversationTransitionRecord({
        ...base,
        kind: "switch",
        sourceLocalNativeConversationId: base.targetLocalNativeConversationId,
      }),
    ).toThrow(/must name a distinct source for switch/);
    expect(() =>
      parseLocalNativeConversationTransitionRecord({
        ...base,
        kind: "archive",
        sourceLocalNativeConversationId: "local-conversation-1",
      }),
    ).toThrow(/must equal the target for archive/);
    expect(() =>
      parseLocalNativeConversationTransitionRecord({ ...base, localTransitionSeq: 0 }),
    ).toThrow(/greater than zero/);
  });
});

describe("runtime-owner protected identity and signing ledger", () => {
  const currentKey = {
    runtimeId: nativeRuntimeId,
    runtimeOwnerIdentityKeyId: "runtime-owner-key-1",
    keyGeneration: 1,
    algorithm: "Ed25519",
    publicKey: encoded(32, 12),
    signingKeyRef: {
      protectedHandleId: `rcph_${encoded(16, 13)}`,
      kind: "signing_key",
    },
    nextSignerSequence: 1,
    localTrustEvidenceRef: "local-trust-evidence-1",
    localTrustEvidenceDigest: digest(14),
    state: "current",
  } as const;

  it("keeps private signing material behind the typed current-key handle", () => {
    const parsed = parseRuntimeOwnerIdentityKeyRecord(currentKey);
    expect(parsed).toEqual(currentKey);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.signingKeyRef)).toBe(true);
    expect(
      parseRuntimeOwnerIdentityKeyRecord({
        ...currentKey,
        signingKeyRef: null,
        state: "retired",
      }),
    ).toEqual({ ...currentKey, signingKeyRef: null, state: "retired" });
    expect(() =>
      parseRuntimeOwnerIdentityKeyRecord({ ...currentKey, signingKeyRef: null }),
    ).toThrow(/present exactly while the key is current/);
    expect(() =>
      parseRuntimeOwnerIdentityKeyRecord({
        ...currentKey,
        signingKeyRef: { ...currentKey.signingKeyRef, kind: "artifact" },
      }),
    ).toThrow(/signing_key/);
    expect(() =>
      parseRuntimeOwnerIdentityKeyRecord({ ...currentKey, publicKey: encoded(31, 12) }),
    ).toThrow(/exactly 32 bytes/);
  });

  it("enforces reserve, bind, sign, and accept state exactness", () => {
    const reserved = {
      runtimeId: nativeRuntimeId,
      runtimeOwnerIdentityKeyId: currentKey.runtimeOwnerIdentityKeyId,
      runtimeOwnerKeyGeneration: 1,
      signerSequence: 0,
      purpose: "native_root",
      canonicalPayloadSchemaId: null,
      canonicalPayloadRef: null,
      canonicalPayloadDigest: null,
      signedRecordDigest: null,
      signature: null,
      signedArtifactId: null,
      state: "reserved",
    } as const;
    const bound = {
      ...reserved,
      canonicalPayloadSchemaId: RUNTIME_OWNER_SIGNATURE_SCHEMAS.native_root,
      canonicalPayloadRef: "native-root-payload-1",
      canonicalPayloadDigest: digest(15),
      state: "bound",
    } as const;
    const signed = {
      ...bound,
      signedRecordDigest: digest(16),
      signature: encoded(64, 17),
      signedArtifactId: "native-root-certificate-1",
      state: "signed",
    } as const;

    expect(parseRuntimeOwnerSignatureReservationRecord(reserved)).toEqual(reserved);
    expect(parseRuntimeOwnerSignatureReservationRecord(bound)).toEqual(bound);
    expect(parseRuntimeOwnerSignatureReservationRecord(signed)).toEqual(signed);
    expect(parseRuntimeOwnerSignatureReservationRecord({ ...reserved, state: "aborted" })).toEqual({
      ...reserved,
      state: "aborted",
    });
    expect(() =>
      parseRuntimeOwnerSignatureReservationRecord({
        ...bound,
        canonicalPayloadSchemaId: RUNTIME_OWNER_SIGNATURE_SCHEMAS.runtime_isolation_attestation,
      }),
    ).toThrow(/must match the selected signature purpose/);
    expect(() =>
      parseRuntimeOwnerSignatureReservationRecord({
        ...bound,
        canonicalPayloadDigest: null,
      }),
    ).toThrow(/all null or all present/);
    expect(() =>
      parseRuntimeOwnerSignatureReservationRecord({
        ...signed,
        signature: encoded(63, 17),
      }),
    ).toThrow(/exactly 64 bytes/);
    expect(() =>
      parseRuntimeOwnerSignatureReservationRecord({ ...signed, state: "bound" }),
    ).toThrow(/only the bound payload/);

    const acceptance = {
      runtimeId: nativeRuntimeId,
      runtimeOwnerIdentityKeyId: currentKey.runtimeOwnerIdentityKeyId,
      runtimeOwnerKeyGeneration: 1,
      signerSequence: 0,
      signedRecordDigest: signed.signedRecordDigest,
      acceptedAtMs: 600,
    };
    expect(parseRuntimeOwnerSignedRecordAcceptanceRecord(acceptance)).toEqual(acceptance);
    expect(() =>
      parseRuntimeOwnerSignedRecordAcceptanceRecord({ ...acceptance, extra: true }),
    ).toThrow(/exactly the selected fields/);
  });
});

describe("native transport attachment and lease records", () => {
  it("accepts every selected transport kind and rejects unversioned generations", () => {
    for (const [index, kind] of ["claude-inner-rc", "app-server", "server", "tmux"].entries()) {
      const value = {
        attachmentId: `attachment-${index + 1}`,
        nativeBindingId,
        kind,
        transportId: `transport-${index + 1}`,
        generation: index + 1,
        currentAttachmentLeaseId: null,
        resourceOwnership: index % 2 === 0 ? "dedicated_runtime" : "shared_runtime",
        createdAtMs: 400 + index,
        closedAtMs: null,
        state: "current",
      };
      const parsed = parseNativeTransportAttachmentRecord(value);
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    expect(() =>
      parseNativeTransportAttachmentRecord({
        attachmentId: "attachment-1",
        nativeBindingId,
        kind: "direct-provider",
        transportId: "transport-1",
        generation: 1,
        currentAttachmentLeaseId: null,
        resourceOwnership: "dedicated_runtime",
        createdAtMs: 400,
        closedAtMs: null,
        state: "current",
      }),
    ).toThrow(/not a selected value/);
    expect(() =>
      parseNativeTransportAttachmentRecord({
        attachmentId: "attachment-1",
        nativeBindingId,
        kind: "app-server",
        transportId: "transport-1",
        generation: 0,
        currentAttachmentLeaseId: null,
        resourceOwnership: "dedicated_runtime",
        createdAtMs: 400,
        closedAtMs: null,
        state: "current",
      }),
    ).toThrow(/greater than zero/);
    expect(() =>
      parseNativeTransportAttachmentRecord({
        attachmentId: "attachment-1",
        nativeBindingId,
        kind: "app-server",
        transportId: "transport-1",
        generation: 1,
        currentAttachmentLeaseId: "attachment-lease-1",
        resourceOwnership: "shared_runtime",
        createdAtMs: 400,
        closedAtMs: null,
        state: "superseded",
      }),
    ).toThrow(/must be null while the attachment is superseded/);
    expect(() =>
      parseNativeTransportAttachmentRecord({
        attachmentId: "attachment-1",
        nativeBindingId,
        kind: "app-server",
        transportId: "transport-1",
        generation: 1,
        currentAttachmentLeaseId: null,
        resourceOwnership: "shared_runtime",
        createdAtMs: 400,
        closedAtMs: null,
        state: "closed",
      }),
    ).toThrow(/present exactly when the attachment is closed/);
  });

  it("binds a transport lease to exact runtime, coordinator, and transport epochs", () => {
    const value = {
      attachmentLeaseId: "attachment-lease-1",
      attachmentId: "attachment-1",
      nativeBindingIncarnationId: "binding-incarnation-1",
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 1,
      runtimeOwnerServiceLeaseId: "runtime-owner-lease-1",
      runtimeOwnerServiceEpoch: 1,
      coordinatorLeaseId,
      coordinatorEpoch: 2,
      transportEpoch: 3,
      currentCapabilitySnapshotId: "capability-snapshot-1",
      currentNativeClientIngressLeaseId: "ingress-lease-1",
      acquiredAtMs: 500,
      releasedAtMs: null,
      state: "current",
    };

    const parsed = parseNativeTransportLeaseRecord(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseNativeTransportLeaseRecord({ ...value, coordinatorEpoch: 0 })).toThrow(
      /greater than zero/,
    );
    expect(() => parseNativeTransportLeaseRecord({ ...value, transportEpoch: 0 })).toThrow(
      /greater than zero/,
    );
    expect(() =>
      parseNativeTransportLeaseRecord({
        ...value,
        coordinatorLeaseId: nativeBindingId,
      }),
    ).toThrow(/rccl_/);
    expect(() => parseNativeTransportLeaseRecord({ ...value, nativeIncarnation: 0 })).toThrow(
      /greater than zero/,
    );
    expect(() =>
      parseNativeTransportLeaseRecord({ ...value, state: "closed", releasedAtMs: null }),
    ).toThrow(/null exactly while the lease is current/);
    expect(() =>
      parseNativeTransportLeaseRecord({ ...value, state: "closed", releasedAtMs: 499 }),
    ).toThrow(/must not precede acquisition/);
    expect(
      parseNativeTransportLeaseRecord({ ...value, state: "superseded", releasedAtMs: 550 }),
    ).toEqual({ ...value, state: "superseded", releasedAtMs: 550 });
  });

  it("keeps each binding lifecycle gate scoped and makes shutdown policy explicit", () => {
    const starting = {
      collaborationServerId,
      logicalChatId,
      nativeBindingId,
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 1,
      nativeBindingIncarnationId: "binding-incarnation-1",
      attachmentId: "attachment-1",
      currentAttachmentLeaseId: null,
      phase: "starting",
      disconnectPolicy: "detach",
      gateGeneration: 1,
      updatedAtMs: 600,
    } as const;
    const ready = {
      ...starting,
      currentAttachmentLeaseId: "attachment-lease-1",
      phase: "ready",
      disconnectPolicy: "terminate_when_idle",
      gateGeneration: 2,
      updatedAtMs: 650,
    } as const;

    expect(parseNativeBindingRuntimeGateRecord(starting)).toEqual(starting);
    expect(parseNativeBindingRuntimeGateRecord({ ...starting, phase: "recovering" })).toEqual({
      ...starting,
      phase: "recovering",
    });
    expect(parseNativeBindingRuntimeGateRecord(ready)).toEqual(ready);
    expect(
      parseNativeBindingRuntimeGateRecord({
        ...ready,
        currentAttachmentLeaseId: null,
        phase: "draining",
      }),
    ).toEqual({ ...ready, currentAttachmentLeaseId: null, phase: "draining" });
    expect(
      parseNativeBindingRuntimeGateRecord({
        ...ready,
        currentAttachmentLeaseId: null,
        phase: "closed",
      }),
    ).toEqual({ ...ready, currentAttachmentLeaseId: null, phase: "closed" });
    expect(() =>
      parseNativeBindingRuntimeGateRecord({ ...ready, currentAttachmentLeaseId: null }),
    ).toThrow(/must be present while the gate is ready/);
    expect(() => parseNativeBindingRuntimeGateRecord({ ...ready, phase: "closed" })).toThrow(
      /must be null while the gate is closed/,
    );
    expect(() => parseNativeBindingRuntimeGateRecord({ ...starting, gateGeneration: 0 })).toThrow(
      /greater than zero/,
    );
  });
});

describe("inward collaboration edge records", () => {
  const installingNative = {
    inwardEdgeId,
    representedServerId: collaborationServerId,
    representedLogicalChatId: logicalChatId,
    targetKind: "native-harness",
    targetServerId: null,
    targetLogicalChatId: null,
    targetNativeBindingId: nativeBindingId,
    rootPathCertificateId: null,
    currentConnectionEpoch: 0,
    currentLiveLeaseId: null,
    currentCapabilitySnapshotId: null,
    state: "installing",
  } as const;

  it("allows a null root certificate only during atomic installation", () => {
    const installed = {
      ...installingNative,
      rootPathCertificateId: "root-path-certificate-1",
      state: "installed",
    };
    const current = {
      ...installed,
      state: "current",
    };

    expect(parseInwardCollaborationEdgeRecord(installingNative)).toEqual(installingNative);
    expect(parseInwardCollaborationEdgeRecord(installed)).toEqual(installed);
    expect(parseInwardCollaborationEdgeRecord(current)).toEqual(current);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installingNative,
        rootPathCertificateId: "root-path-certificate-1",
      }),
    ).toThrow(/must be null only while the edge is installing/);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installed,
        rootPathCertificateId: null,
      }),
    ).toThrow(/must be null only while the edge is installing/);
  });

  it("keeps installing and native-harness edges free of nested live-connection state", () => {
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installingNative,
        currentConnectionEpoch: 1,
      }),
    ).toThrow(/remain at epoch zero/);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installingNative,
        currentLiveLeaseId: "live-lease-1",
        currentCapabilitySnapshotId: "capability-snapshot-1",
      }),
    ).toThrow(/remain at epoch zero/);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installingNative,
        rootPathCertificateId: "root-path-certificate-1",
        currentConnectionEpoch: 1,
        currentLiveLeaseId: "live-lease-1",
        currentCapabilitySnapshotId: "capability-snapshot-1",
        state: "current",
      }),
    ).toThrow(/do not use the remote-server live connection/);
  });

  it("accepts a current nested-server edge with its complete live connection", () => {
    const value = {
      inwardEdgeId: targetInwardEdgeId,
      representedServerId: collaborationServerId,
      representedLogicalChatId: logicalChatId,
      targetKind: "remote-claw-server",
      targetServerId,
      targetLogicalChatId,
      targetNativeBindingId: null,
      rootPathCertificateId: "root-path-certificate-2",
      currentConnectionEpoch: 1,
      currentLiveLeaseId: "live-lease-1",
      currentCapabilitySnapshotId: "capability-snapshot-1",
      state: "current",
    };

    const parsed = parseInwardCollaborationEdgeRecord(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects a generic safe ID where a canonical inward-edge ID is required", () => {
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installingNative,
        inwardEdgeId: "inward-edge-1",
      }),
    ).toThrow(/rcie_/);
  });

  it("rejects target-kind mixing and partial or unfenced live connections", () => {
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installingNative,
        targetServerId,
      }),
    ).toThrow(/exactly the identifiers selected by targetKind/);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installingNative,
        targetKind: "remote-claw-server",
        targetNativeBindingId: null,
        targetServerId,
      }),
    ).toThrow(/exactly the identifiers selected by targetKind/);
    const installedNested = {
      ...installingNative,
      targetKind: "remote-claw-server",
      targetNativeBindingId: null,
      targetServerId,
      targetLogicalChatId,
      rootPathCertificateId: "root-path-certificate-2",
      state: "installed",
    } as const;
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installedNested,
        currentCapabilitySnapshotId: "capability-snapshot-1",
      }),
    ).toThrow(/both be null or both be present/);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installedNested,
        currentLiveLeaseId: "live-lease-1",
        currentCapabilitySnapshotId: "capability-snapshot-1",
      }),
    ).toThrow(/must be positive when a live lease is installed/);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installedNested,
        state: "current",
      }),
    ).toThrow(/must be installed before the edge becomes current/);
    expect(() =>
      parseInwardCollaborationEdgeRecord({
        ...installedNested,
        targetServerId: collaborationServerId,
      }),
    ).toThrow(/immediate collaboration-server cycle/);
  });
});
