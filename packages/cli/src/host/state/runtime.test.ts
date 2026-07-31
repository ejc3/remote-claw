import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest } from "./ids.js";
import {
  parseInferenceRuntimeBindingRecord,
  parseInwardCollaborationEdgeRecord,
  parseNativeBindingIncarnationRecord,
  parseNativeRuntimeIncarnationRecord,
  parseNativeTransportAttachmentRecord,
  parseNativeTransportLeaseRecord,
  parseRuntimeOwnerServiceLeaseRecord,
} from "./runtime.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const machineIdentityId = "0123456789abcdef".repeat(2);
const collaborationServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const targetServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 2)}`);
const logicalChatId = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 3)}`);
const targetLogicalChatId = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 4)}`);
const nativeBindingId = parseA1CanonicalId("nativeBinding", `rcnb_${encoded(16, 5)}`);
const coordinatorLeaseId = parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 6)}`);
const nativeRuntimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 7)}`);

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
    ).toThrow(/must not precede acquisition/);
    expect(() => parseRuntimeOwnerServiceLeaseRecord({ ...current, releasedAtMs: 120 })).toThrow(
      /must be null while the lease is current/,
    );
    expect(() => parseRuntimeOwnerServiceLeaseRecord({ ...released, releasedAtMs: null })).toThrow(
      /must be present for a released lease/,
    );
  });

  it("keeps provider-neutral runtime identity separate from inference request identity", () => {
    const current = {
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 0,
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
      nativeIncarnation: 0,
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

describe("native transport attachment and lease records", () => {
  it("accepts every selected transport kind and rejects unversioned generations", () => {
    for (const [index, kind] of ["claude-inner-rc", "app-server", "server", "tmux"].entries()) {
      const value = {
        attachmentId: `attachment-${index + 1}`,
        nativeBindingId,
        kind,
        transportId: `transport-${index + 1}`,
        generation: index + 1,
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
        state: "current",
      }),
    ).toThrow(/greater than zero/);
  });

  it("binds a transport lease to exact runtime, coordinator, and transport epochs", () => {
    const value = {
      attachmentLeaseId: "attachment-lease-1",
      attachmentId: "attachment-1",
      nativeBindingIncarnationId: "binding-incarnation-1",
      runtimeId: nativeRuntimeId,
      nativeIncarnation: 0,
      coordinatorLeaseId,
      coordinatorEpoch: 2,
      transportEpoch: 3,
      currentCapabilitySnapshotId: "capability-snapshot-1",
      currentNativeClientIngressLeaseId: "ingress-lease-1",
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
  });
});

describe("inward collaboration edge records", () => {
  const installingNative = {
    inwardEdgeId: "inward-edge-1",
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
      inwardEdgeId: "inward-edge-2",
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
