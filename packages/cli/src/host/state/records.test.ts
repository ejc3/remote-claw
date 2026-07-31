import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  nativeRegistrationIntentDigest,
  projectAllocationIntentDigest,
  projectTargetDigest,
  projectTargetSelectorMappingId,
  verifyNativeRegistrationIntentDigest,
  verifyProjectAllocationIntentDigest,
  verifyProjectTargetSelectorMapping,
} from "./digests.js";
import { HostStateContractError, parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "./ids.js";
import {
  parseCollaborationServerRecord,
  parseCoordinatorLeaseFence,
  parseCoordinatorLeaseRecord,
  parseHostStateProfileRecord,
  parseLocalArtifactRecord,
  parseLogicalChatRecord,
  parseNativeBindingRecord,
  parseNativeConversationLeaseRecord,
  parseNativeEngineDescriptor,
  parseNativeRegistrationIntentRecord,
  parseProjectRecord,
  parseProjectTarget,
  parseProjectTargetSelectorMappingRecord,
} from "./records.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function noncanonicalTailAlias(value: string): string {
  const last = value.at(-1);
  const index = last === undefined ? -1 : BASE64URL_ALPHABET.indexOf(last);
  const replacement = BASE64URL_ALPHABET.at(index + 1);
  if (index < 0 || index % 4 !== 0 || replacement === undefined) {
    throw new Error("expected a canonical 32-byte base64url value");
  }
  return `${value.slice(0, -1)}${replacement}`;
}

const collaborationServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const targetServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 46)}`);
const projectId = parseA1CanonicalId("project", `rcpj_${encoded(16, 2)}`);
const logicalChatId = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 3)}`);
const parentChatId = parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 4)}`);
const nativeBindingId = parseA1CanonicalId("nativeBinding", `rcnb_${encoded(16, 5)}`);
const coordinatorLeaseId = parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 6)}`);
const registrationAttemptId = parseA1CanonicalId("registrationAttempt", `rcra_${encoded(16, 7)}`);
const nativeConversationLeaseId = parseA1CanonicalId(
  "nativeConversationLease",
  `rcncl_${encoded(16, 8)}`,
);
const protectedPortHandleId = parseA1CanonicalId("protectedHandle", `rcph_${encoded(16, 9)}`);
const alternateProjectTargetSelectorMappingId = parseA1CanonicalId(
  "projectTargetSelectorMapping",
  `ptm_${encoded(32, 10)}`,
);
const machineIdentityId = "0123456789abcdef".repeat(2);

function digest(fill: number) {
  return parseA1Digest(encoded(32, fill));
}

async function projectFixture() {
  const intent = {
    projectAllocationIntentSchemaId: "remote-claw/project-allocation-intent/v1",
    projectAllocationIntentId: registrationAttemptId,
    collaborationServerId,
    projectId,
    allocationKind: "first_bootstrap",
    initialWorkspaceSelectorId: parseA1SafeId("workspace-selector-1"),
    initialTargetDigest: digest(10),
  } as const;
  return {
    ...intent,
    projectAllocationIntentDigest: await projectAllocationIntentDigest(intent),
    initialProjectTargetSelectorMappingId: alternateProjectTargetSelectorMappingId,
    createdAtMs: 100,
    state: "current",
  } as const;
}

async function registrationIntentFixture() {
  const intent = {
    registrationAttemptId,
    collaborationServerId,
    nativeBindingId,
    canonicalIntentSchemaId: "remote-claw/native-registration-intent/v1",
    descriptorRef: parseA1SafeId("descriptor-artifact"),
    descriptorDigest: digest(11),
    projectRef: parseA1SafeId("project-artifact"),
    projectDigest: digest(12),
    expectedNativeRefDigest: null,
    initialPhase: "starting",
    metadataSchemaId: "remote-claw/claude-metadata/v1",
    metadataRef: parseA1SafeId("metadata-artifact"),
    metadataDigest: digest(13),
    capabilitiesRef: parseA1SafeId("capabilities-artifact"),
    capabilitiesDigest: digest(14),
  } as const;
  return {
    ...intent,
    canonicalIntentDigest: await nativeRegistrationIntentDigest(intent),
    createdAtMs: 200,
  } as const;
}

describe("selected A1 durable host records", () => {
  it("accepts installing and fully installed collaboration server states", () => {
    const installing = {
      collaborationServerId,
      machineIdentityId,
      currentKeyGeneration: 0,
      currentIdentityKeyId: null,
      currentScopeCertificateId: null,
      currentCoordinatorEpoch: 0,
      currentCoordinatorLeaseId: null,
      nextJournalOffset: 0,
      nextServerSignatureSeq: 0,
      nextCommandSeq: 0,
      createdAtMs: 10,
      state: "installing",
    };
    const current = {
      ...installing,
      currentKeyGeneration: 1,
      currentIdentityKeyId: "identity-key-1",
      currentScopeCertificateId: "scope-certificate-1",
      currentCoordinatorEpoch: 2,
      currentCoordinatorLeaseId: coordinatorLeaseId,
      state: "current",
    };

    for (const value of [installing, current]) {
      const parsed = parseCollaborationServerRecord(value);
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it("rejects incomplete key pointers, zero-generation keys, and zero-epoch leases", () => {
    const base = {
      collaborationServerId,
      machineIdentityId,
      currentKeyGeneration: 0,
      currentIdentityKeyId: null,
      currentScopeCertificateId: null,
      currentCoordinatorEpoch: 0,
      currentCoordinatorLeaseId: null,
      nextJournalOffset: 0,
      nextServerSignatureSeq: 0,
      nextCommandSeq: 0,
      createdAtMs: 10,
      state: "installing",
    };

    expect(() =>
      parseCollaborationServerRecord({
        ...base,
        currentKeyGeneration: 1,
        currentIdentityKeyId: "identity-key",
      }),
    ).toThrow(/generation and identity\/certificate pointers/);
    expect(() =>
      parseCollaborationServerRecord({
        ...base,
        currentIdentityKeyId: "identity-key",
        currentScopeCertificateId: "scope-certificate",
      }),
    ).toThrow(/generation and identity\/certificate pointers/);
    expect(() =>
      parseCollaborationServerRecord({
        ...base,
        currentCoordinatorLeaseId: coordinatorLeaseId,
      }),
    ).toThrow(/first coordinator epoch/);
    expect(() =>
      parseCollaborationServerRecord({
        ...base,
        state: "current",
      }),
    ).toThrow(/must be installed before the server becomes current/);
    expect(() =>
      parseCollaborationServerRecord({
        ...base,
        currentKeyGeneration: 1,
        currentIdentityKeyId: "identity-key",
        currentScopeCertificateId: "scope-certificate",
      }),
    ).toThrow(/must remain at generation zero with null pointers while the server is installing/);
  });

  it("accepts the one default profile and rejects renamed profiles", () => {
    const value = {
      stateProfileId: "default",
      machineIdentityId,
      defaultCollaborationServerId: collaborationServerId,
      createdAtMs: 10,
    };
    expect(parseHostStateProfileRecord(value)).toEqual(value);
    expect(() => parseHostStateProfileRecord({ ...value, stateProfileId: "development" })).toThrow(
      /stateProfileId/,
    );
  });

  it("accepts and verifies a project allocation record", async () => {
    const value = await projectFixture();
    const parsed = parseProjectRecord(value);

    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.projectAllocationIntentDigest).toBe(
      "vcBqkmUnfPx2ld7xOwx6I3Lu6WFRcb-Th-ZAOumfTQc",
    );
    await expect(verifyProjectAllocationIntentDigest(parsed)).resolves.toBeUndefined();
    await expect(
      verifyProjectAllocationIntentDigest({
        ...value,
        projectAllocationIntentDigest: noncanonicalTailAlias(value.projectAllocationIntentDigest),
      } as unknown as Parameters<typeof verifyProjectAllocationIntentDigest>[0]),
    ).rejects.toThrow(/canonical/);
  });

  it("requires a registration-attempt ID only for first-bootstrap project allocation", async () => {
    const value = await projectFixture();
    expect(() =>
      parseProjectRecord({
        ...value,
        projectAllocationIntentId: "management-command-1",
      }),
    ).toThrow(/rcra_/);

    const explicitNewProject = {
      ...value,
      allocationKind: "explicit_new_project",
      projectAllocationIntentId: "management-command-1",
    } as const;
    expect(parseProjectRecord(explicitNewProject).projectAllocationIntentId).toBe(
      "management-command-1",
    );
  });

  it("commits every project allocation input but not mutable row metadata", async () => {
    const value = await projectFixture();
    const baseline = await projectAllocationIntentDigest(value);
    const includedMutations = [
      {
        ...value,
        projectAllocationIntentId: parseA1CanonicalId(
          "registrationAttempt",
          `rcra_${encoded(16, 20)}`,
        ),
      },
      {
        ...value,
        collaborationServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 21)}`),
      },
      { ...value, projectId: parseA1CanonicalId("project", `rcpj_${encoded(16, 22)}`) },
      { ...value, allocationKind: "explicit_new_project" },
      { ...value, initialWorkspaceSelectorId: parseA1SafeId("workspace-selector-2") },
      { ...value, initialTargetDigest: digest(23) },
    ] as const;

    await expect(
      projectAllocationIntentDigest({
        ...value,
        projectAllocationIntentSchemaId: "remote-claw/project-allocation-intent/v2",
      } as unknown as Parameters<typeof projectAllocationIntentDigest>[0]),
    ).rejects.toThrow(/projectAllocationIntentSchemaId/);
    for (const malformed of [
      noncanonicalTailAlias(value.initialTargetDigest),
      "A".repeat(1_000_000),
    ]) {
      await expect(
        projectAllocationIntentDigest({
          ...value,
          initialTargetDigest: malformed,
        } as unknown as Parameters<typeof projectAllocationIntentDigest>[0]),
      ).rejects.toThrow(/canonical|exactly 32 bytes/);
    }

    for (const changed of includedMutations) {
      expect(
        await projectAllocationIntentDigest(
          changed as Parameters<typeof projectAllocationIntentDigest>[0],
        ),
      ).not.toBe(baseline);
    }
    const rowMetadataChanged = {
      ...value,
      initialProjectTargetSelectorMappingId: parseA1SafeId("mapping-other"),
      createdAtMs: value.createdAtMs + 1,
      state: "closed",
    } as const;
    expect(await projectAllocationIntentDigest(rowMetadataChanged)).toBe(baseline);

    await expect(
      verifyProjectAllocationIntentDigest(
        parseProjectRecord({ ...value, projectAllocationIntentDigest: digest(24) }),
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("enforces coordinator lease time, state, and fencing invariants", () => {
    const current = {
      coordinatorLeaseId,
      collaborationServerId,
      coordinatorEpoch: 1,
      ownerInstanceId: "coordinator-process-1",
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

    expect(parseCoordinatorLeaseRecord(current)).toEqual(current);
    expect(parseCoordinatorLeaseRecord(released)).toEqual(released);
    expect(
      parseCoordinatorLeaseFence({
        collaborationServerId,
        coordinatorLeaseId,
        coordinatorEpoch: 1,
      }),
    ).toEqual({ collaborationServerId, coordinatorLeaseId, coordinatorEpoch: 1 });
    expect(() => parseCoordinatorLeaseRecord({ ...current, heartbeatDeadlineMs: 99 })).toThrow(
      /must not precede acquisition/,
    );
    expect(() => parseCoordinatorLeaseRecord({ ...current, releasedAtMs: 120 })).toThrow(
      /must be null while the lease is current/,
    );
    expect(() => parseCoordinatorLeaseRecord({ ...released, releasedAtMs: null })).toThrow(
      /must be present for a released lease/,
    );
    expect(() =>
      parseCoordinatorLeaseFence({
        collaborationServerId,
        coordinatorLeaseId,
        coordinatorEpoch: 0,
      }),
    ).toThrow(/greater than zero/);
  });

  it("accepts and verifies a durable native registration intent", async () => {
    const value = await registrationIntentFixture();
    const parsed = parseNativeRegistrationIntentRecord(value);

    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.canonicalIntentDigest).toBe("j7eWmuGIFfuaFawvK3ij5X4dM80dsEBOvcTqqG7pZ58");
    await expect(verifyNativeRegistrationIntentDigest(parsed)).resolves.toBeUndefined();
    await expect(
      verifyNativeRegistrationIntentDigest({
        ...value,
        canonicalIntentDigest: noncanonicalTailAlias(value.canonicalIntentDigest),
      } as unknown as Parameters<typeof verifyNativeRegistrationIntentDigest>[0]),
    ).rejects.toThrow(/canonical/);
  });

  it("commits registration intent fields, including explicit optional absence", async () => {
    const value = await registrationIntentFixture();
    const baseline = await nativeRegistrationIntentDigest(value);
    const withoutExpectedNative = {
      ...value,
      expectedNativeRefDigest: digest(15),
    };
    const withoutCapabilities = {
      ...value,
      capabilitiesRef: null,
      capabilitiesDigest: null,
    };

    expect(await nativeRegistrationIntentDigest(withoutExpectedNative)).not.toBe(baseline);
    expect(await nativeRegistrationIntentDigest(withoutCapabilities)).not.toBe(baseline);
    for (const malformed of [
      noncanonicalTailAlias(value.descriptorDigest),
      "A".repeat(1_000_000),
    ]) {
      await expect(
        nativeRegistrationIntentDigest({
          ...value,
          descriptorDigest: malformed,
        } as unknown as Parameters<typeof nativeRegistrationIntentDigest>[0]),
      ).rejects.toThrow(/canonical|exactly 32 bytes/);
    }
    expect(
      await nativeRegistrationIntentDigest({
        ...value,
        metadataRef: parseA1SafeId("metadata-artifact-2"),
      }),
    ).not.toBe(baseline);
    const rowMetadataChanged = {
      ...value,
      createdAtMs: value.createdAtMs + 1,
      canonicalIntentDigest: digest(16),
    };
    expect(await nativeRegistrationIntentDigest(rowMetadataChanged)).toBe(baseline);

    expect(() =>
      parseNativeRegistrationIntentRecord({
        ...value,
        capabilitiesDigest: null,
      }),
    ).toThrow(/capabilities/);
    await expect(
      verifyNativeRegistrationIntentDigest(
        parseNativeRegistrationIntentRecord({
          ...value,
          canonicalIntentDigest: digest(17),
        }),
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("enforces native conversation lease closure and coordinator fencing", () => {
    const active = {
      nativeConversationLeaseId,
      collaborationServerId,
      nativeBindingId,
      registrationAttemptId,
      coordinatorLeaseId,
      coordinatorEpoch: 1,
      protectedPortHandleId,
      acquiredAtMs: 300,
      closedAtMs: null,
      state: "ready",
    };
    const closed = { ...active, closedAtMs: 350, state: "closed" };

    expect(parseNativeConversationLeaseRecord(active)).toEqual(active);
    expect(parseNativeConversationLeaseRecord(closed)).toEqual(closed);
    expect(() => parseNativeConversationLeaseRecord({ ...active, closedAtMs: 350 })).toThrow(
      /exactly when the lease is closed/,
    );
    expect(() => parseNativeConversationLeaseRecord({ ...closed, closedAtMs: 299 })).toThrow(
      /must not precede acquisition/,
    );
    expect(() => parseNativeConversationLeaseRecord({ ...active, coordinatorEpoch: 0 })).toThrow(
      /greater than zero/,
    );
  });

  it("accepts immutable local artifact metadata and rejects ambiguous forms", () => {
    const value = {
      artifactId: "artifact-1",
      artifactKind: "native_descriptor",
      canonicalSchemaId: "remote-claw/native-descriptor/v1",
      digestAlgorithm: "SHA-256",
      artifactDigest: digest(38),
      byteLength: 512,
      protectedStorageHandleId: protectedPortHandleId,
      createdAtMs: 400,
    };

    const parsed = parseLocalArtifactRecord(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseLocalArtifactRecord({ ...value, digestAlgorithm: "SHA-512" })).toThrow(
      /digestAlgorithm/,
    );
    expect(() => parseLocalArtifactRecord({ ...value, byteLength: -1 })).toThrow(
      /non-negative safe integer/,
    );
    expect(() =>
      parseLocalArtifactRecord({
        ...value,
        protectedStorageHandleId: nativeBindingId,
      }),
    ).toThrow(/rcph_/);
  });

  it("parses terminal and recursively nested project targets as disjoint exact variants", () => {
    const terminal = {
      kind: "terminal_native",
      descriptor: { product: "claude-code", access: "native-rc" },
      terminalProjectRef: "claude-project-1",
      nativeWorkspaceBindingId: null,
    };
    const nested = {
      kind: "nested_server",
      nestedServerManagementBindingId: "nested-management-1",
      targetServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 39)}`),
      targetProjectId: parseA1CanonicalId("project", `rcpj_${encoded(16, 40)}`),
      targetWorkspaceSelectorId: "nested-workspace-1",
    };

    for (const value of [terminal, nested]) {
      const parsed = parseProjectTarget(value);
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    expect(() =>
      parseProjectTarget({
        ...terminal,
        targetServerId: collaborationServerId,
      }),
    ).toThrow(/exactly the selected fields/);
    expect(() =>
      parseProjectTarget({
        ...nested,
        kind: "terminal_native",
      }),
    ).toThrow(/exactly the selected fields/);
    expect(() => parseProjectTarget({ kind: "provider_account" })).toThrow(/not a selected value/);

    let invoked = false;
    const accessorTarget = { ...terminal };
    Object.defineProperty(accessorTarget, "kind", {
      enumerable: true,
      get() {
        invoked = true;
        return "terminal_native";
      },
    });
    expect(() => parseProjectTarget(accessorTarget)).toThrow(/own data property/);
    expect(invoked).toBe(false);
  });

  it("normalizes revoked project-target proxies to a contract error", () => {
    const revocable = Proxy.revocable(
      {
        kind: "terminal_native",
        descriptor: { product: "claude-code", access: "native-rc" },
        terminalProjectRef: "claude-project-1",
        nativeWorkspaceBindingId: null,
      },
      {},
    );
    revocable.revoke();

    expect(() => parseProjectTarget(revocable.proxy)).toThrow(HostStateContractError);
    expect(() => parseProjectTarget(revocable.proxy)).toThrow(
      "host state contract rejected: projectTarget could not be inspected safely",
    );
  });

  it("accepts and verifies a generation-fenced project target mapping", async () => {
    const target = {
      kind: "terminal_native",
      descriptor: { product: "opencode", access: "server" },
      terminalProjectRef: parseA1SafeId("opencode-project-1"),
      nativeWorkspaceBindingId: parseA1SafeId("workspace-binding-1"),
    } as const;
    const mappingIdentity = {
      collaborationServerId,
      projectId,
      workspaceSelectorId: parseA1SafeId("workspace-selector-1"),
      mappingGeneration: 1,
      targetDigest: await projectTargetDigest(target),
    } as const;
    const value = {
      ...mappingIdentity,
      projectTargetSelectorMappingId: await projectTargetSelectorMappingId(mappingIdentity),
      target,
      evidenceRef: "mapping-evidence-1",
      state: "current",
    } as const;

    const parsed = parseProjectTargetSelectorMappingRecord(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.target)).toBe(true);
    expect(parsed.targetDigest).toBe("AuPfKDHOeQmAD1DzIKwN-fmxfDc0_8cAyG1a44TDg6o");
    expect(parsed.projectTargetSelectorMappingId).toBe(
      "ptm_MMs0E0C-IYjJNonL6aXxMxvA_X_VuqZth_P2rqfW7NE",
    );
    await expect(verifyProjectTargetSelectorMapping(parsed)).resolves.toBeUndefined();
    await expect(
      verifyProjectTargetSelectorMapping({
        ...parsed,
        targetDigest: noncanonicalTailAlias(parsed.targetDigest),
      } as unknown as Parameters<typeof verifyProjectTargetSelectorMapping>[0]),
    ).rejects.toThrow(/canonical/);
    expect(() =>
      parseProjectTargetSelectorMappingRecord({ ...value, mappingGeneration: 0 }),
    ).toThrow(/greater than zero/);
    expect(() =>
      parseProjectTargetSelectorMappingRecord({
        ...value,
        projectTargetSelectorMappingId: `ptm_${encoded(16, 42)}`,
      }),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      parseProjectTargetSelectorMappingRecord({
        ...value,
        target: {
          kind: "nested_server",
          nestedServerManagementBindingId: "nested-management-1",
          targetServerId: collaborationServerId,
          targetProjectId: projectId,
          targetWorkspaceSelectorId: "workspace-selector-1",
        },
      }),
    ).toThrow(/immediate collaboration-server cycle/);

    expect(
      await projectTargetDigest({
        ...target,
        nativeWorkspaceBindingId: null,
      }),
    ).not.toBe(value.targetDigest);
    expect(
      await projectTargetDigest({
        kind: "nested_server",
        nestedServerManagementBindingId: parseA1SafeId("nested-management-1"),
        targetServerId,
        targetProjectId: projectId,
        targetWorkspaceSelectorId: parseA1SafeId("workspace-selector-1"),
      }),
    ).not.toBe(value.targetDigest);

    for (const changed of [
      {
        ...value,
        collaborationServerId: targetServerId,
      },
      {
        ...value,
        projectId: parseA1CanonicalId("project", `rcpj_${encoded(16, 43)}`),
      },
      { ...value, workspaceSelectorId: parseA1SafeId("workspace-selector-2") },
      { ...value, mappingGeneration: 2 },
      { ...value, targetDigest: digest(44) },
    ]) {
      expect(await projectTargetSelectorMappingId(changed)).not.toBe(
        value.projectTargetSelectorMappingId,
      );
    }
    await expect(
      verifyProjectTargetSelectorMapping({
        ...parsed,
        targetDigest: digest(45),
      }),
    ).rejects.toThrow(/targetDigest does not match/);
    await expect(
      verifyProjectTargetSelectorMapping({
        ...parsed,
        projectTargetSelectorMappingId: alternateProjectTargetSelectorMappingId,
      }),
    ).rejects.toThrow(/projectTargetSelectorMappingId does not match/);
  });

  it("enforces logical chat topology and rejects cross-namespace identifiers", () => {
    const value = {
      logicalChatId,
      collaborationServerId,
      projectId,
      state: "ready",
      topologyGeneration: 3,
      currentInwardEdgeId: "inward-edge-1",
      currentNativeBindingId: nativeBindingId,
      parentChatId,
      nextViewerProjectionSeq: 4,
    };

    expect(parseLogicalChatRecord(value)).toEqual(value);
    expect(() =>
      parseLogicalChatRecord({
        ...value,
        projectId: logicalChatId,
      }),
    ).toThrow(/rcpj_/);
    expect(() =>
      parseLogicalChatRecord({
        ...value,
        currentInwardEdgeId: null,
        currentNativeBindingId: null,
      }),
    ).toThrow(/before the chat becomes ready/);
    expect(() =>
      parseLogicalChatRecord({
        ...value,
        state: "recovering",
        currentInwardEdgeId: null,
      }),
    ).toThrow(/without its terminal inward edge/);
    expect(() =>
      parseLogicalChatRecord({
        ...value,
        parentChatId: logicalChatId,
      }),
    ).toThrow(/different logical chat/);

    const recoveringWithoutTarget = {
      ...value,
      state: "recovering",
      topologyGeneration: 0,
      currentInwardEdgeId: null,
      currentNativeBindingId: null,
      parentChatId: null,
    } as const;
    expect(parseLogicalChatRecord(recoveringWithoutTarget)).toEqual(recoveringWithoutTarget);
    expect(
      parseLogicalChatRecord({
        ...value,
        currentNativeBindingId: null,
      }).currentInwardEdgeId,
    ).toBe("inward-edge-1");
  });

  it("accepts only the selected native product/access combinations", () => {
    for (const descriptor of [
      { product: "claude-code", access: "native-rc" },
      { product: "claude-code", access: "tmux" },
      { product: "codex", access: "app-server" },
      { product: "opencode", access: "server" },
    ]) {
      const parsed = parseNativeEngineDescriptor(descriptor);
      expect(parsed).toEqual(descriptor);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    expect(() => parseNativeEngineDescriptor({ product: "codex", access: "native-rc" })).toThrow(
      /unsupported product\/access/,
    );
    expect(() =>
      parseNativeEngineDescriptor({
        product: "opencode",
        access: "server",
        fallback: "tmux",
      }),
    ).toThrow(/exactly the selected fields/);
  });

  it("requires native binding identity and incarnation to resolve together", () => {
    const starting = {
      nativeBindingId,
      collaborationServerId,
      logicalChatId,
      descriptor: { product: "codex", access: "app-server" },
      projectId,
      semanticConversationId: null,
      currentBindingIncarnationId: null,
      state: "starting",
    };
    const current = {
      ...starting,
      semanticConversationId: "thread-123",
      currentBindingIncarnationId: "binding-incarnation-1",
      state: "current",
    };

    expect(parseNativeBindingRecord(starting)).toEqual(starting);
    expect(parseNativeBindingRecord(current)).toEqual(current);
    expect(() =>
      parseNativeBindingRecord({
        ...starting,
        semanticConversationId: "thread-123",
      }),
    ).toThrow(/must be resolved together/);
    expect(() =>
      parseNativeBindingRecord({
        ...starting,
        state: "current",
      }),
    ).toThrow(/must be resolved before the binding is current/);
    expect(() =>
      parseNativeBindingRecord({
        ...starting,
        semanticConversationId: "thread-123",
        currentBindingIncarnationId: "binding-incarnation-1",
      }),
    ).toThrow(/must remain unresolved while the binding is starting/);
  });

  it("rejects unknown fields and inherited records without leaking values", async () => {
    const value = await projectFixture();
    expect(() => parseProjectRecord({ ...value, secretFutureField: "do-not-log-me" })).toThrow(
      /exactly the selected fields/,
    );
    expect(() =>
      parseProjectRecord(Object.assign(Object.create({ inherited: true }), value)),
    ).toThrow(/plain object/);
  });
});
