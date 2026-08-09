import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDurableProjectSelectionEvidence,
  createNativeConversationRefEvidence,
  createNativeEngineDescriptorEvidence,
  createNativeRegistrationMetadataEvidence,
} from "../native/evidence.js";
import { nativeRuntimeId, projectTargetDigest } from "./digests.js";
import {
  type A1CanonicalId,
  type A1CanonicalIdKind,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseEd25519Signature,
  parseWardenLaunchNonce,
} from "./ids.js";
import { expectedHostStateSqliteSchemaManifest, HOST_STATE_SCHEMA_VERSION } from "./migrations.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import { createNativeRegistrationOperationEvidence } from "./registration-repository.js";
import {
  type AcquireRuntimeOwnerServiceLeaseRequest,
  type RegisterInitialRuntimeRequest,
  type RuntimeOwnerKeyMaterialInput,
  type RuntimeOwnerOperationEvidence,
  RuntimeOwnerRepositoryConflictError,
  type RuntimeOwnerServiceFence,
  RuntimeOwnerStaleOwnerError,
} from "./runtime-repository.js";
import { openHostStateDatabase, type TerminalRegistrationInput } from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "93".repeat(16);
const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

function canonicalId<K extends A1CanonicalIdKind>(kind: K, fill: number): A1CanonicalId<K> {
  const prefix = {
    collaborationServer: "rcs_",
    project: "rcpj_",
    logicalChat: "rcl_",
    inwardEdge: "rcie_",
    nativeBinding: "rcnb_",
    nativeRuntime: "rcrt_",
    coordinatorLease: "rccl_",
    registrationAttempt: "rcra_",
    nativeConversationLease: "rcncl_",
    protectedHandle: "rcph_",
    projectTargetSelectorMapping: "ptm_",
    nativeDeliveryAttempt: "nat_",
  } as const;
  const byteLength =
    kind === "nativeRuntime" ||
    kind === "projectTargetSelectorMapping" ||
    kind === "nativeDeliveryAttempt"
      ? 32
      : 16;
  return parseA1CanonicalId(
    kind,
    `${prefix[kind]}${base64urlEncode(new Uint8Array(byteLength).fill(fill))}`,
  );
}

function digest(fill: number) {
  return parseA1Digest(base64urlEncode(new Uint8Array(32).fill(fill)));
}

function operation(label: string, fill: number): RuntimeOwnerOperationEvidence {
  return {
    operationId: parseA1SafeId(`${label}-operation-${fill}`),
    operationSchemaId: `remote-claw/test/${label}/v1`,
    operationDigest: digest(fill),
  };
}

function acquireRequest(
  fill: number,
  expectedCurrentLeaseId: AcquireRuntimeOwnerServiceLeaseRequest["expectedCurrentLeaseId"] = null,
  expectedRuntimeOwnerServiceEpoch = 0,
): AcquireRuntimeOwnerServiceLeaseRequest {
  return {
    candidateLeaseId: parseA1SafeId(`owner-lease-${fill}`),
    ownerInstanceId: parseA1SafeId(`owner-instance-${fill}`),
    ownerProcessStartIdentitySchemaId: "remote-claw/test/process-start/v1",
    ownerProcessStartIdentityRef: parseA1SafeId(`owner-process-start-${fill}`),
    ownerProcessStartIdentityDigest: digest(fill),
    expectedCurrentLeaseId,
    expectedRuntimeOwnerServiceEpoch,
    leaseDurationMs: 10_000,
    operation: operation("owner-acquire", fill + 1),
  };
}

function ownerFence(
  request: AcquireRuntimeOwnerServiceLeaseRequest,
  runtimeOwnerServiceEpoch: number,
): RuntimeOwnerServiceFence {
  return {
    runtimeOwnerServiceLeaseId: request.candidateLeaseId,
    runtimeOwnerServiceEpoch,
    ownerInstanceId: request.ownerInstanceId,
    ownerProcessStartIdentitySchemaId: request.ownerProcessStartIdentitySchemaId,
    ownerProcessStartIdentityRef: request.ownerProcessStartIdentityRef,
    ownerProcessStartIdentityDigest: request.ownerProcessStartIdentityDigest,
  };
}

function keyMaterial(fill: number): RuntimeOwnerKeyMaterialInput {
  return {
    runtimeOwnerIdentityKeyId: parseA1SafeId(`runtime-identity-key-${fill}`),
    publicKey: parseEd25519PublicKey(base64urlEncode(new Uint8Array(32).fill(fill))),
    signingKeyRef: {
      protectedHandleId: canonicalId("protectedHandle", fill),
      kind: "signing_key",
    },
    localTrustEvidenceRef: parseA1SafeId(`local-trust-${fill}`),
    localTrustEvidenceDigest: digest(fill + 1),
    wrapNonce: ProtectedByteSnapshot.from(new Uint8Array(12).fill(fill)),
    wrappedPkcs8: ProtectedByteSnapshot.from(new Uint8Array(48).fill(fill)),
    authTag: ProtectedByteSnapshot.from(new Uint8Array(16).fill(fill)),
    pkcs8Digest: digest(fill + 2),
  };
}

async function runtimeRegistration(
  fence: RuntimeOwnerServiceFence,
  fill: number,
  descriptor: RegisterInitialRuntimeRequest["descriptor"] = {
    product: "codex",
    access: "app-server",
  },
): Promise<RegisterInitialRuntimeRequest> {
  const wardenLaunchNonce = parseWardenLaunchNonce(base64urlEncode(new Uint8Array(32).fill(fill)));
  const startIdentitySchemaId = "remote-claw/test/native-process-start/v1";
  const startIdentityDigest = digest(fill + 1);
  return {
    fence,
    operation: operation("runtime-register", fill + 2),
    runtimeId: await nativeRuntimeId({
      wardenLaunchNonce,
      startIdentitySchemaId,
      startIdentityDigest,
    }),
    descriptor,
    wardenLaunchNonce,
    startIdentitySchemaId,
    startIdentityRef: parseA1SafeId(`native-process-start-${fill}`),
    startIdentityDigest,
    runtimeOwnerAssignmentId: parseA1SafeId(`runtime-assignment-${fill}-1`),
    key: keyMaterial(fill),
  };
}

function terminalRegistration(fill: number): TerminalRegistrationInput {
  return {
    registrationAttemptId: canonicalId("registrationAttempt", fill),
    descriptor: { product: "codex", access: "app-server" },
    descriptorRef: parseA1SafeId(`descriptor-${fill}`),
    descriptorDigest: digest(fill + 1),
    projectRef: parseA1SafeId(`project-${fill}`),
    projectDigest: digest(fill + 2),
    expectedNativeRefDigest: null,
    initialPhase: "starting",
    metadataSchemaId: "remote-claw/test/native-registration/v1",
    metadataRef: parseA1SafeId(`metadata-${fill}`),
    metadataDigest: digest(fill + 3),
    capabilitiesRef: null,
    capabilitiesDigest: null,
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a13-runtime-repository-"),
  );
  temporaryRoots.push(root);
  const environment = {
    xdgStateHome: join(root, "state"),
    homeDirectory: join(root, "home"),
  };
  return {
    environment,
    paths: resolveHostStatePaths(MACHINE_IDENTITY_ID, environment),
  };
}

async function createRetainedRegistrationFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(40_000);
  const state = temporaryState();
  const database = openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: state.environment,
  });
  const server = database.records.ensureDefaultCollaborationServer();
  const coordinator = database.records.acquireCoordinatorLease({
    collaborationServerId: server.server.collaborationServerId,
    candidateLeaseId: canonicalId("coordinatorLease", 141),
    ownerInstanceId: parseA1SafeId("lineage-coordinator-owner"),
    expectedCurrentLeaseId: null,
    expectedCoordinatorEpoch: 0,
    leaseDurationMs: 600_000,
  });
  const coordinatorFence = {
    collaborationServerId: server.server.collaborationServerId,
    coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
    coordinatorEpoch: coordinator.lease.coordinatorEpoch,
  };
  const ownerRequest = acquireRequest(142);
  database.runtimeOwner.acquireServiceLease(ownerRequest);
  const fence = ownerFence(ownerRequest, 1);
  const registration = await runtimeRegistration(fence, 143);
  const runtime = database.runtimeOwner.registerInitialRuntime(registration);
  const workspaceSelectorId = parseA1SafeId("lineage-workspace");
  const terminalTarget = {
    kind: "terminal_native" as const,
    descriptor: registration.descriptor,
    terminalProjectRef: parseA1SafeId("lineage-terminal-project"),
    nativeWorkspaceBindingId: null,
  };
  const targetDigest = await projectTargetDigest(terminalTarget);
  const descriptorEvidence = createNativeEngineDescriptorEvidence(registration.descriptor);
  const projectEvidence = createDurableProjectSelectionEvidence({
    kind: "first_bootstrap",
    collaborationServerId: server.server.collaborationServerId,
    workspaceSelectorId,
    terminalDescriptor: registration.descriptor,
    targetDigest,
  });
  const metadataEvidence = createNativeRegistrationMetadataEvidence({
    metadataSchemaId: "remote-claw/test/lineage-metadata/v1",
    metadataBytes: new TextEncoder().encode("retained registration lineage"),
  });
  const semanticConversationId = parseA1SafeId("lineage-semantic-conversation");
  const nativeRefEvidence = createNativeConversationRefEvidence({
    descriptor: registration.descriptor,
    runtimeId: runtime.runtime.runtimeId,
    conversationId: semanticConversationId,
    incarnation: 1,
  });
  const reserved = database.transaction((transaction) => {
    const descriptor = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: server.server.collaborationServerId,
      artifactSchemaId: descriptorEvidence.canonicalSchemaId,
      artifactDigest: descriptorEvidence.canonicalDigest,
      artifactBytes: descriptorEvidence.canonicalBytes,
    });
    const project = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: server.server.collaborationServerId,
      artifactSchemaId: projectEvidence.canonicalSchemaId,
      artifactDigest: projectEvidence.canonicalDigest,
      artifactBytes: projectEvidence.canonicalBytes,
    });
    const metadata = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: server.server.collaborationServerId,
      artifactSchemaId: metadataEvidence.canonicalSchemaId,
      artifactDigest: metadataEvidence.canonicalDigest,
      artifactBytes: metadataEvidence.canonicalBytes,
    });
    const nativeRef = transaction.putArtifact({
      scopeKind: "runtime",
      scopeId: runtime.runtime.runtimeId,
      artifactSchemaId: nativeRefEvidence.canonicalSchemaId,
      artifactDigest: nativeRefEvidence.canonicalDigest,
      artifactBytes: nativeRefEvidence.canonicalBytes,
    });
    const terminal = transaction.records.reserveFirstTerminalChat({
      fence: coordinatorFence,
      workspaceSelectorId,
      terminalTarget,
      mappingEvidenceRef: parseA1SafeId("lineage-mapping-evidence"),
      registration: {
        registrationAttemptId: canonicalId("registrationAttempt", 144),
        descriptor: registration.descriptor,
        descriptorRef: descriptor.artifactRef.protectedHandleId,
        descriptorDigest: descriptorEvidence.canonicalDigest,
        projectRef: project.artifactRef.protectedHandleId,
        projectDigest: projectEvidence.canonicalDigest,
        expectedNativeRefDigest: nativeRefEvidence.canonicalDigest,
        initialPhase: "starting",
        metadataSchemaId: metadataEvidence.value.metadataSchemaId,
        metadataRef: metadata.artifactRef.protectedHandleId,
        metadataDigest: metadataEvidence.canonicalDigest,
        capabilitiesRef: null,
        capabilitiesDigest: null,
      },
    });
    return { terminal, nativeRef };
  });
  const openInput = {
    fence,
    coordinatorFence,
    nativeConversationLeaseId: canonicalId("nativeConversationLease", 145),
    registrationAttemptId: reserved.terminal.registrationIntent.registrationAttemptId,
    nativeBindingId: reserved.terminal.binding.nativeBindingId,
    runtimeId: runtime.runtime.runtimeId,
    nativeIncarnation: 1,
    protectedPortHandleId: canonicalId("protectedHandle", 146),
  };
  const opened = database.registration.open({
    ...openInput,
    operation: createNativeRegistrationOperationEvidence(
      "open",
      parseA1SafeId("lineage-registration-open"),
      openInput,
    ),
  });

  const bind = () => {
    const local = database.runtimeOwner.appendLocalConversationTransition({
      fence,
      operation: operation("lineage-local-discover", 147),
      runtimeId: runtime.runtime.runtimeId,
      nativeIncarnation: 1,
      localTransitionId: parseA1SafeId("lineage-local-transition"),
      kind: "discover",
      sourceLocalNativeConversationId: null,
      target: {
        localNativeConversationId: parseA1SafeId("lineage-local-conversation"),
        descriptor: registration.descriptor,
        projectId: reserved.terminal.project.projectId,
        semanticConversationId,
        parentLocalNativeConversationId: null,
        state: "open",
      },
      observedSemanticConversationId: semanticConversationId,
      nativeEvidenceSchemaId: nativeRefEvidence.canonicalSchemaId,
      nativeEvidenceRef: reserved.nativeRef.artifactRef.protectedHandleId,
      nativeEvidenceDigest: nativeRefEvidence.canonicalDigest,
    });
    const prepared = database.runtimeOwner.prepareBindingRuntime({
      fence,
      coordinatorFence,
      bindingOperation: operation("lineage-binding-prepare", 148),
      attachmentOperation: operation("lineage-attachment-acquire", 149),
      nativeBindingIncarnationId: parseA1SafeId("lineage-binding-incarnation"),
      collaborationServerId: server.server.collaborationServerId,
      logicalChatId: reserved.terminal.chat.logicalChatId,
      nativeBindingId: reserved.terminal.binding.nativeBindingId,
      runtimeId: runtime.runtime.runtimeId,
      nativeIncarnation: 1,
      semanticConversationId,
      attachmentId: parseA1SafeId("lineage-attachment"),
      attachmentKind: "app-server",
      transportId: parseA1SafeId("lineage-transport"),
      attachmentGeneration: 1,
      attachmentLeaseId: parseA1SafeId("lineage-attachment-lease"),
      transportEpoch: 1,
      resourceOwnership: "shared_runtime",
      phase: "starting",
      disconnectPolicy: "detach",
    });
    const bindInput = {
      fence,
      coordinatorFence,
      nativeConversationLeaseId: opened.lease.nativeConversationLeaseId,
      nativeBindingIncarnationId: prepared.bindingIncarnation.nativeBindingIncarnationId,
      attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
    };
    const bound = database.registration.bind({
      ...bindInput,
      operation: createNativeRegistrationOperationEvidence(
        "bind",
        parseA1SafeId("lineage-registration-bind"),
        bindInput,
      ),
    });
    return { local, prepared, bound };
  };

  return {
    database,
    state,
    fence,
    coordinatorFence,
    registration,
    runtime,
    reserved: reserved.terminal,
    opened,
    bind,
  };
}

function mutateWithoutLifecycleTriggers(databasePath: string, sql: string): void {
  const database = new DatabaseSync(databasePath);
  const triggers = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION).filter(
    ({ type }) => type === "trigger",
  );
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("BEGIN IMMEDIATE");
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    database.exec(sql);
    for (const trigger of triggers) database.exec(trigger.sql);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the mutation failure below.
    }
    throw error;
  } finally {
    database.close();
  }
}

function swapJournalOffsetsSql(leftPredicate: string, rightPredicate: string): string {
  return `CREATE TEMP TABLE runtime_owner_journal_offset_swap (
      side TEXT PRIMARY KEY,
      journal_offset INTEGER NOT NULL
    );
    INSERT INTO runtime_owner_journal_offset_swap (side, journal_offset)
      SELECT 'left', journal_offset FROM runtime_owner_journal_entries WHERE ${leftPredicate};
    INSERT INTO runtime_owner_journal_offset_swap (side, journal_offset)
      SELECT 'right', journal_offset FROM runtime_owner_journal_entries WHERE ${rightPredicate};
    UPDATE runtime_owner_journal_entries SET journal_offset = 1000000 WHERE ${leftPredicate};
    UPDATE runtime_owner_journal_entries
      SET journal_offset = (
        SELECT journal_offset FROM runtime_owner_journal_offset_swap WHERE side = 'left'
      ) WHERE ${rightPredicate};
    UPDATE runtime_owner_journal_entries
      SET journal_offset = (
        SELECT journal_offset FROM runtime_owner_journal_offset_swap WHERE side = 'right'
      ) WHERE journal_offset = 1000000;
    DROP TABLE runtime_owner_journal_offset_swap`;
}

async function createCompleteRuntimeGraphFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(30_000);
  const state = temporaryState();
  const database = openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: state.environment,
  });
  try {
    const server = database.records.ensureDefaultCollaborationServer();
    const coordinator = database.records.acquireCoordinatorLease({
      collaborationServerId: server.server.collaborationServerId,
      candidateLeaseId: canonicalId("coordinatorLease", 101),
      ownerInstanceId: parseA1SafeId("validator-coordinator-owner"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 600_000,
    });
    const coordinatorFence = {
      collaborationServerId: server.server.collaborationServerId,
      coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
      coordinatorEpoch: coordinator.lease.coordinatorEpoch,
    };
    const terminal = database.records.reserveFirstTerminalChat({
      fence: coordinatorFence,
      workspaceSelectorId: parseA1SafeId("validator-workspace"),
      terminalTarget: {
        kind: "terminal_native",
        descriptor: { product: "codex", access: "app-server" },
        terminalProjectRef: parseA1SafeId("validator-terminal-project"),
        nativeWorkspaceBindingId: null,
      },
      mappingEvidenceRef: parseA1SafeId("validator-mapping-evidence"),
      registration: terminalRegistration(102),
    });
    const ownerRequest = acquireRequest(103);
    database.runtimeOwner.acquireServiceLease(ownerRequest);
    const fence = ownerFence(ownerRequest, 1);
    const registration = await runtimeRegistration(fence, 104);
    const runtime = database.runtimeOwner.registerInitialRuntime(registration);
    database.runtimeOwner.reserveSignature({
      fence,
      runtimeId: runtime.runtime.runtimeId,
      runtimeOwnerIdentityKeyId: runtime.identityKey.runtimeOwnerIdentityKeyId,
      runtimeOwnerKeyGeneration: 1,
      expectedSignerSequence: 0,
      purpose: "native_root",
    });
    database.runtimeOwner.abortSignature({
      fence,
      runtimeId: runtime.runtime.runtimeId,
      runtimeOwnerIdentityKeyId: runtime.identityKey.runtimeOwnerIdentityKeyId,
      runtimeOwnerKeyGeneration: 1,
      signerSequence: 0,
    });
    const secondKey = keyMaterial(118);
    database.runtimeOwner.rotateIdentityKey({
      fence,
      operation: operation("validator-key-rotate", 117),
      runtimeId: runtime.runtime.runtimeId,
      expectedRuntimeOwnerIdentityKeyId: runtime.identityKey.runtimeOwnerIdentityKeyId,
      expectedKeyGeneration: 1,
      key: secondKey,
    });
    const local = database.runtimeOwner.appendLocalConversationTransition({
      fence,
      operation: operation("validator-local-transition", 105),
      runtimeId: runtime.runtime.runtimeId,
      nativeIncarnation: 1,
      localTransitionId: parseA1SafeId("validator-local-transition-1"),
      kind: "discover",
      sourceLocalNativeConversationId: null,
      target: {
        localNativeConversationId: parseA1SafeId("validator-local-conversation-1"),
        descriptor: registration.descriptor,
        projectId: terminal.project.projectId,
        semanticConversationId: parseA1SafeId("validator-semantic-conversation-1"),
        parentLocalNativeConversationId: null,
        state: "open",
      },
      observedSemanticConversationId: parseA1SafeId("validator-semantic-conversation-1"),
      nativeEvidenceSchemaId: "remote-claw/test/native-observation/v1",
      nativeEvidenceRef: parseA1SafeId("validator-native-observation-1"),
      nativeEvidenceDigest: digest(106),
    });
    database.runtimeOwner.appendLocalConversationTransition({
      fence,
      operation: operation("validator-local-fork", 107),
      runtimeId: runtime.runtime.runtimeId,
      nativeIncarnation: 1,
      localTransitionId: parseA1SafeId("validator-local-transition-2"),
      kind: "fork",
      sourceLocalNativeConversationId: local.conversation.localNativeConversationId,
      target: {
        localNativeConversationId: parseA1SafeId("validator-local-conversation-2"),
        descriptor: registration.descriptor,
        projectId: terminal.project.projectId,
        semanticConversationId: parseA1SafeId("validator-semantic-conversation-2"),
        parentLocalNativeConversationId: local.conversation.localNativeConversationId,
        state: "open",
      },
      observedSemanticConversationId: parseA1SafeId("validator-semantic-conversation-2"),
      nativeEvidenceSchemaId: "remote-claw/test/native-observation/v1",
      nativeEvidenceRef: parseA1SafeId("validator-native-observation-2"),
      nativeEvidenceDigest: digest(108),
    });
    const prepared = database.runtimeOwner.prepareBindingRuntime({
      fence,
      coordinatorFence,
      bindingOperation: operation("validator-binding-prepare", 107),
      attachmentOperation: operation("validator-attachment-acquire", 108),
      nativeBindingIncarnationId: parseA1SafeId("validator-binding-incarnation-1"),
      collaborationServerId: server.server.collaborationServerId,
      logicalChatId: terminal.chat.logicalChatId,
      nativeBindingId: terminal.binding.nativeBindingId,
      runtimeId: runtime.runtime.runtimeId,
      nativeIncarnation: 1,
      semanticConversationId:
        local.conversation.semanticConversationId ??
        parseA1SafeId("validator-unreachable-semantic-conversation"),
      attachmentId: parseA1SafeId("validator-attachment-1"),
      attachmentKind: "app-server",
      transportId: parseA1SafeId("validator-transport-1"),
      attachmentGeneration: 1,
      attachmentLeaseId: parseA1SafeId("validator-attachment-lease-1"),
      transportEpoch: 1,
      resourceOwnership: "shared_runtime",
      phase: "starting",
      disconnectPolicy: "detach",
    });
    database.runtimeOwner.detachBindingRuntime({
      fence,
      coordinatorFence,
      operation: operation("validator-attachment-detach", 109),
      nativeBindingId: terminal.binding.nativeBindingId,
      attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
      expectedGateGeneration: prepared.gate.gateGeneration,
    });
    const replacement = database.runtimeOwner.replaceRuntimeIncarnation({
      fence,
      operation: operation("validator-runtime-replace", 110),
      runtimeId: runtime.runtime.runtimeId,
      predecessorNativeIncarnation: 1,
      expectedRuntimeOwnerAssignmentId: runtime.assignment.runtimeOwnerAssignmentId,
      containmentId: parseA1SafeId("validator-runtime-containment-1"),
      containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
      containmentEvidenceRef: parseA1SafeId("validator-containment-evidence-1"),
      containmentEvidenceDigest: digest(111),
      successorStartIdentitySchemaId: "remote-claw/test/native-process-start/v1",
      successorStartIdentityRef: parseA1SafeId("validator-process-start-incarnation-2"),
      successorStartIdentityDigest: digest(112),
      successorRuntimeOwnerAssignmentId: parseA1SafeId("validator-runtime-assignment-2"),
    });
    vi.setSystemTime(31_000);
    database.runtimeOwner.releaseServiceLease({
      fence,
      operation: operation("validator-owner-release", 113),
    });
    const successorOwnerRequest = acquireRequest(114, null, 1);
    database.runtimeOwner.acquireServiceLease(successorOwnerRequest);
    const successorFence = ownerFence(successorOwnerRequest, 2);
    database.runtimeOwner.reassignRuntimeOwner({
      fence: successorFence,
      operation: operation("validator-runtime-reassign", 119),
      runtimeId: runtime.runtime.runtimeId,
      nativeIncarnation: 2,
      expectedRuntimeOwnerAssignmentId: replacement.assignment.runtimeOwnerAssignmentId,
      runtimeOwnerAssignmentId: parseA1SafeId("validator-runtime-assignment-2-takeover"),
      reattachmentEvidenceSchemaId: "remote-claw/test/reattachment/v1",
      reattachmentEvidenceRef: parseA1SafeId("validator-runtime-reattachment-2"),
      reattachmentEvidenceDigest: digest(120),
    });
    const thirdKey = keyMaterial(122);
    database.runtimeOwner.rotateIdentityKey({
      fence: successorFence,
      operation: operation("validator-key-rotate", 121),
      runtimeId: runtime.runtime.runtimeId,
      expectedRuntimeOwnerIdentityKeyId: secondKey.runtimeOwnerIdentityKeyId,
      expectedKeyGeneration: 2,
      key: thirdKey,
    });
    database.runtimeOwner.rotateIdentityKey({
      fence: successorFence,
      operation: operation("validator-key-rotate", 125),
      runtimeId: runtime.runtime.runtimeId,
      expectedRuntimeOwnerIdentityKeyId: thirdKey.runtimeOwnerIdentityKeyId,
      expectedKeyGeneration: 3,
      key: keyMaterial(126),
    });
    database.records.releaseCoordinatorLease({ fence: coordinatorFence });
    database.records.acquireCoordinatorLease({
      collaborationServerId: server.server.collaborationServerId,
      candidateLeaseId: canonicalId("coordinatorLease", 127),
      ownerInstanceId: parseA1SafeId("validator-coordinator-owner-2"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 1,
      leaseDurationMs: 600_000,
    });
  } finally {
    database.close();
  }
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.3 high-level runtime-owner repository", () => {
  it("keeps an unbound registration lease intact when legacy runtime retirement is attempted", async () => {
    const fixture = await createRetainedRegistrationFixture();
    const { database, fence, runtime } = fixture;
    const boundLeaseId = fixture.opened.lease.nativeConversationLeaseId;
    try {
      expect(() =>
        database.runtimeOwner.terminateRuntime({
          fence,
          operation: operation("lineage-runtime-terminate", 150),
          runtimeId: runtime.runtime.runtimeId,
          predecessorNativeIncarnation: 1,
          expectedRuntimeOwnerAssignmentId: runtime.assignment.runtimeOwnerAssignmentId,
          containmentId: parseA1SafeId("lineage-runtime-termination"),
          containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
          containmentEvidenceRef: parseA1SafeId("lineage-runtime-termination-evidence"),
          containmentEvidenceDigest: digest(151),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.replaceRuntimeIncarnation({
          fence,
          operation: operation("lineage-runtime-replace", 152),
          runtimeId: runtime.runtime.runtimeId,
          predecessorNativeIncarnation: 1,
          expectedRuntimeOwnerAssignmentId: runtime.assignment.runtimeOwnerAssignmentId,
          containmentId: parseA1SafeId("lineage-runtime-replacement"),
          containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
          containmentEvidenceRef: parseA1SafeId("lineage-runtime-replacement-evidence"),
          containmentEvidenceDigest: digest(153),
          successorStartIdentitySchemaId: "remote-claw/test/native-process-start/v1",
          successorStartIdentityRef: parseA1SafeId("lineage-runtime-successor-start"),
          successorStartIdentityDigest: digest(154),
          successorRuntimeOwnerAssignmentId: parseA1SafeId("lineage-runtime-successor-assignment"),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const bound = fixture.bind();
      expect(database.registration.readLease(boundLeaseId)).toEqual(bound.bound.lease);
      expect(database.runtimeOwner.readInventory()).toMatchObject({
        runtimes: [{ state: "current", currentNativeIncarnation: 1 }],
        containments: [],
      });
    } finally {
      database.close();
    }

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      expect(reopened.registration.readLease(boundLeaseId)).toMatchObject({ state: "starting" });
      expect(reopened.runtimeOwner.readInventory().runtimes).toMatchObject([
        { state: "current", currentNativeIncarnation: 1 },
      ]);
    } finally {
      reopened.close();
    }
  });

  it("rejects detach, clear, and archive while their graph is retained by registration", async () => {
    const fixture = await createRetainedRegistrationFixture();
    const { database, fence, coordinatorFence, registration, reserved } = fixture;
    const boundLeaseId = fixture.opened.lease.nativeConversationLeaseId;
    try {
      const { local, prepared, bound } = fixture.bind();
      expect(() =>
        database.runtimeOwner.detachBindingRuntime({
          fence,
          coordinatorFence,
          operation: operation("lineage-attachment-detach", 155),
          nativeBindingId: reserved.binding.nativeBindingId,
          attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
          expectedGateGeneration: prepared.gate.gateGeneration,
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      expect(() =>
        database.runtimeOwner.appendLocalConversationTransition({
          fence,
          operation: operation("lineage-local-clear", 156),
          runtimeId: local.conversation.runtimeId,
          nativeIncarnation: local.conversation.nativeIncarnation,
          localTransitionId: parseA1SafeId("lineage-local-clear-transition"),
          kind: "clear",
          sourceLocalNativeConversationId: local.conversation.localNativeConversationId,
          target: {
            localNativeConversationId: parseA1SafeId("lineage-cleared-local-conversation"),
            descriptor: registration.descriptor,
            projectId: local.conversation.projectId,
            semanticConversationId: null,
            parentLocalNativeConversationId: null,
            state: "unbound",
          },
          observedSemanticConversationId: null,
          nativeEvidenceSchemaId: "remote-claw/test/native-observation/v1",
          nativeEvidenceRef: parseA1SafeId("lineage-clear-observation"),
          nativeEvidenceDigest: digest(157),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      expect(() =>
        database.runtimeOwner.appendLocalConversationTransition({
          fence,
          operation: operation("lineage-local-archive", 158),
          runtimeId: local.conversation.runtimeId,
          nativeIncarnation: local.conversation.nativeIncarnation,
          localTransitionId: parseA1SafeId("lineage-local-archive-transition"),
          kind: "archive",
          sourceLocalNativeConversationId: local.conversation.localNativeConversationId,
          target: {
            localNativeConversationId: local.conversation.localNativeConversationId,
            descriptor: registration.descriptor,
            projectId: local.conversation.projectId,
            semanticConversationId: local.conversation.semanticConversationId,
            parentLocalNativeConversationId: null,
            state: "closed",
          },
          observedSemanticConversationId: local.conversation.semanticConversationId,
          nativeEvidenceSchemaId: "remote-claw/test/native-observation/v1",
          nativeEvidenceRef: parseA1SafeId("lineage-archive-observation"),
          nativeEvidenceDigest: digest(159),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      expect(database.registration.readLease(boundLeaseId)).toEqual(bound.lease);
      expect(database.runtimeOwner.readInventory()).toMatchObject({
        conversations: [{ state: "open" }],
        transitions: [{ kind: "discover" }],
        bindingIncarnations: [{ state: "current" }],
        attachments: [{ state: "current" }],
        attachmentLeases: [{ state: "current" }],
        gates: [{ phase: "starting", gateGeneration: prepared.gate.gateGeneration }],
      });
    } finally {
      database.close();
    }

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      expect(reopened.registration.readLease(boundLeaseId)).toMatchObject({ state: "starting" });
      expect(reopened.runtimeOwner.readInventory()).toMatchObject({
        conversations: [{ state: "open" }],
        gates: [{ phase: "starting" }],
      });
    } finally {
      reopened.close();
    }
  });

  it("fences, renews, releases, reconciles, and takes over the machine-wide owner lease", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      const firstRequest = acquireRequest(1);
      const first = database.runtimeOwner.acquireServiceLease(firstRequest);
      expect(database.runtimeOwner.acquireServiceLease(firstRequest)).toEqual({
        ...first,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.acquireServiceLease({
          ...firstRequest,
          ownerInstanceId: parseA1SafeId("colliding-owner"),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const firstFence = ownerFence(firstRequest, 1);
      const renewal = {
        fence: firstFence,
        expectedHeartbeatDeadlineMs: 11_000,
        newHeartbeatDeadlineMs: 15_000,
      };
      expect(database.runtimeOwner.renewServiceLease(renewal)).toMatchObject({
        replayed: false,
        lease: { heartbeatDeadlineMs: 15_000 },
      });
      expect(database.runtimeOwner.renewServiceLease(renewal)).toMatchObject({ replayed: true });
      expect(() =>
        database.runtimeOwner.renewServiceLease({
          ...renewal,
          expectedHeartbeatDeadlineMs: 12_000,
          newHeartbeatDeadlineMs: 16_000,
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      vi.setSystemTime(2_000);
      const releaseRequest = {
        fence: firstFence,
        operation: operation("owner-release", 3),
      };
      const released = database.runtimeOwner.releaseServiceLease(releaseRequest);
      expect(database.runtimeOwner.releaseServiceLease(releaseRequest)).toEqual({
        ...released,
        replayed: true,
      });
      expect(database.runtimeOwner.reconcileServiceLeaseRelease(releaseRequest)).toEqual({
        ...released,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.releaseServiceLease({
          ...releaseRequest,
          operation: { ...releaseRequest.operation, operationDigest: digest(99) },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const successorRequest = acquireRequest(4, null, 1);
      const successor = database.runtimeOwner.acquireServiceLease(successorRequest);
      expect(successor.lease.runtimeOwnerServiceEpoch).toBe(2);
      expect(() =>
        database.runtimeOwner.reconcileServiceLeaseAcquisition({
          ...successorRequest,
          ownerProcessStartIdentityDigest: digest(100),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() => database.runtimeOwner.renewServiceLease(renewal)).toThrow(
        RuntimeOwnerStaleOwnerError,
      );
      expect(database.runtimeOwner.readInventory()).toMatchObject({
        state: {
          currentRuntimeOwnerServiceEpoch: 2,
          currentRuntimeOwnerServiceLeaseId: successorRequest.candidateLeaseId,
        },
        serviceLeases: [{ state: "released" }, { state: "current" }],
      });
    } finally {
      database.close();
    }
  });

  it("runs multi-runtime ownership, key/signature, takeover, replacement, and containment lifecycles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const firstLeaseRequest = acquireRequest(10);
    const firstFence = ownerFence(firstLeaseRequest, 1);
    try {
      database.runtimeOwner.acquireServiceLease(firstLeaseRequest);
      const firstRequest = await runtimeRegistration(firstFence, 20);
      const secondRequest = await runtimeRegistration(firstFence, 30);
      const first = database.runtimeOwner.registerInitialRuntime(firstRequest);
      const second = database.runtimeOwner.registerInitialRuntime(secondRequest);
      expect(database.runtimeOwner.registerInitialRuntime(firstRequest)).toEqual({
        ...first,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.registerInitialRuntime({
          ...firstRequest,
          startIdentityRef: parseA1SafeId("colliding-start-ref"),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const rolledBackRequest = await runtimeRegistration(firstFence, 40);
      expect(() =>
        database.transaction((transaction) => {
          transaction.runtimeOwner.registerInitialRuntime(rolledBackRequest);
          throw new Error("rollback requested");
        }),
      ).toThrow("rollback requested");
      expect(database.runtimeOwner.readRuntime(rolledBackRequest.runtimeId)).toBeNull();

      const reserved = database.runtimeOwner.reserveSignature({
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        expectedSignerSequence: 0,
        purpose: "native_root",
      });
      expect(
        database.runtimeOwner.reserveSignature({
          fence: firstFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          expectedSignerSequence: 0,
          purpose: "native_root",
        }),
      ).toEqual({ ...reserved, replayed: true });
      expect(() =>
        database.runtimeOwner.reserveSignature({
          fence: firstFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          expectedSignerSequence: 0,
          purpose: "runtime_isolation_attestation",
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const boundRequest = {
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        signerSequence: 0,
        canonicalPayloadSchemaId: "remote-claw/native-root-certificate/v1" as const,
        canonicalPayloadRef: parseA1SafeId("native-root-payload-1"),
        canonicalPayloadDigest: digest(50),
      };
      const bound = database.runtimeOwner.bindSignature(boundRequest);
      expect(database.runtimeOwner.bindSignature(boundRequest)).toEqual({
        ...bound,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.bindSignature({
          ...boundRequest,
          canonicalPayloadDigest: digest(51),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const signedRequest = {
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        signerSequence: 0,
        signedRecordDigest: digest(52),
        signature: parseEd25519Signature(base64urlEncode(new Uint8Array(64).fill(52))),
        signedArtifactId: parseA1SafeId("native-root-artifact-1"),
      };
      const signed = database.runtimeOwner.storeSignedRecord(signedRequest);
      expect(database.runtimeOwner.storeSignedRecord(signedRequest)).toEqual({
        ...signed,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.storeSignedRecord({
          ...signedRequest,
          signature: parseEd25519Signature(base64urlEncode(new Uint8Array(64).fill(53))),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      const acceptance = database.runtimeOwner.acceptSignedRecord({
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        signerSequence: 0,
        signedRecordDigest: signedRequest.signedRecordDigest,
      });
      expect(
        database.runtimeOwner.acceptSignedRecord({
          fence: firstFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          signerSequence: 0,
          signedRecordDigest: signedRequest.signedRecordDigest,
        }),
      ).toEqual({ ...acceptance, replayed: true });
      expect(() =>
        database.runtimeOwner.acceptSignedRecord({
          fence: firstFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          signerSequence: 0,
          signedRecordDigest: digest(54),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.abortSignature({
          fence: firstFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          signerSequence: 0,
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      database.runtimeOwner.reserveSignature({
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        expectedSignerSequence: 1,
        purpose: "runtime_isolation_attestation",
      });
      const aborted = database.runtimeOwner.abortSignature({
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        signerSequence: 1,
      });
      expect(
        database.runtimeOwner.abortSignature({
          fence: firstFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          signerSequence: 1,
        }),
      ).toEqual({ ...aborted, replayed: true });

      const rotationRequest = {
        fence: firstFence,
        operation: operation("runtime-key-rotate", 55),
        runtimeId: first.runtime.runtimeId,
        expectedRuntimeOwnerIdentityKeyId: first.identityKey.runtimeOwnerIdentityKeyId,
        expectedKeyGeneration: 1,
        key: keyMaterial(56),
      };
      const rotated = database.runtimeOwner.rotateIdentityKey(rotationRequest);
      expect(database.runtimeOwner.rotateIdentityKey(rotationRequest)).toEqual({
        ...rotated,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.rotateIdentityKey({
          ...rotationRequest,
          key: {
            ...rotationRequest.key,
            localTrustEvidenceRef: parseA1SafeId("colliding-rotation-local-trust"),
          },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.rotateIdentityKey({
          ...rotationRequest,
          operation: { ...rotationRequest.operation, operationDigest: digest(57) },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      database.runtimeOwner.reserveSignature({
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 2,
        expectedSignerSequence: 0,
        purpose: "native_root",
      });
      database.runtimeOwner.bindSignature({
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 2,
        signerSequence: 0,
        canonicalPayloadSchemaId: "remote-claw/native-root-certificate/v1",
        canonicalPayloadRef: parseA1SafeId("native-root-payload-duplicate-digest"),
        canonicalPayloadDigest: digest(58),
      });
      expect(() =>
        database.runtimeOwner.storeSignedRecord({
          fence: firstFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 2,
          signerSequence: 0,
          signedRecordDigest: signedRequest.signedRecordDigest,
          signature: parseEd25519Signature(base64urlEncode(new Uint8Array(64).fill(59))),
          signedArtifactId: parseA1SafeId("duplicate-signed-record-artifact"),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      database.runtimeOwner.storeSignedRecord({
        fence: firstFence,
        runtimeId: first.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 2,
        signerSequence: 0,
        signedRecordDigest: digest(59),
        signature: parseEd25519Signature(base64urlEncode(new Uint8Array(64).fill(60))),
        signedArtifactId: parseA1SafeId("rotated-native-root-artifact"),
      });
      database.runtimeOwner.reserveSignature({
        fence: firstFence,
        runtimeId: second.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: second.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        expectedSignerSequence: 0,
        purpose: "native_root",
      });
      database.runtimeOwner.bindSignature({
        fence: firstFence,
        runtimeId: second.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: second.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        signerSequence: 0,
        canonicalPayloadSchemaId: "remote-claw/native-root-certificate/v1",
        canonicalPayloadRef: parseA1SafeId("second-runtime-native-root-payload"),
        canonicalPayloadDigest: digest(144),
      });
      database.runtimeOwner.reserveSignature({
        fence: firstFence,
        runtimeId: second.runtime.runtimeId,
        runtimeOwnerIdentityKeyId: second.identityKey.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: 1,
        expectedSignerSequence: 1,
        purpose: "runtime_isolation_attestation",
      });

      const terminateSecondRequest = {
        fence: firstFence,
        operation: operation("runtime-terminate", 60),
        runtimeId: second.runtime.runtimeId,
        predecessorNativeIncarnation: 1,
        expectedRuntimeOwnerAssignmentId: second.assignment.runtimeOwnerAssignmentId,
        containmentId: parseA1SafeId("runtime-2-termination"),
        containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
        containmentEvidenceRef: parseA1SafeId("runtime-2-termination-evidence"),
        containmentEvidenceDigest: digest(61),
      };
      const terminatedSecond = database.runtimeOwner.terminateRuntime(terminateSecondRequest);
      expect(database.runtimeOwner.terminateRuntime(terminateSecondRequest)).toEqual({
        ...terminatedSecond,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.terminateRuntime({
          ...terminateSecondRequest,
          operation: { ...terminateSecondRequest.operation, operationDigest: digest(58) },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      expect(() =>
        database.runtimeOwner.reassignRuntimeOwner({
          fence: firstFence,
          operation: operation("runtime-reassign-same-owner", 62),
          runtimeId: first.runtime.runtimeId,
          nativeIncarnation: 1,
          expectedRuntimeOwnerAssignmentId: first.assignment.runtimeOwnerAssignmentId,
          runtimeOwnerAssignmentId: parseA1SafeId("runtime-assignment-invalid-same-owner"),
          reattachmentEvidenceSchemaId: "remote-claw/test/reattachment/v1",
          reattachmentEvidenceRef: parseA1SafeId("same-owner-reattachment"),
          reattachmentEvidenceDigest: digest(63),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      vi.setSystemTime(11_000);
      database.runtimeOwner.releaseServiceLease({
        fence: firstFence,
        operation: operation("owner-release", 64),
      });
      const successorLeaseRequest = acquireRequest(65, null, 1);
      database.runtimeOwner.acquireServiceLease(successorLeaseRequest);
      const successorFence = ownerFence(successorLeaseRequest, 2);
      expect(() =>
        database.runtimeOwner.rotateIdentityKey({
          fence: successorFence,
          operation: operation("stale-runtime-key-rotate", 137),
          runtimeId: first.runtime.runtimeId,
          expectedRuntimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
          expectedKeyGeneration: 2,
          key: keyMaterial(138),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.reserveSignature({
          fence: successorFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 2,
          expectedSignerSequence: 1,
          purpose: "runtime_isolation_attestation",
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.acceptSignedRecord({
          fence: successorFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 2,
          signerSequence: 0,
          signedRecordDigest: digest(59),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.abortSignature({
          fence: successorFence,
          runtimeId: second.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: second.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          signerSequence: 1,
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.bindSignature({
          fence: successorFence,
          runtimeId: second.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: second.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          signerSequence: 1,
          canonicalPayloadSchemaId: "remote-claw/native-runtime-isolation-attestation/v1",
          canonicalPayloadRef: parseA1SafeId("stale-runtime-isolation-payload"),
          canonicalPayloadDigest: digest(145),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.storeSignedRecord({
          fence: successorFence,
          runtimeId: second.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: second.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 1,
          signerSequence: 0,
          signedRecordDigest: digest(146),
          signature: parseEd25519Signature(base64urlEncode(new Uint8Array(64).fill(146))),
          signedArtifactId: parseA1SafeId("stale-second-runtime-signed-artifact"),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.terminateRuntime({
          fence: successorFence,
          operation: operation("stale-runtime-terminate", 139),
          runtimeId: first.runtime.runtimeId,
          predecessorNativeIncarnation: 1,
          expectedRuntimeOwnerAssignmentId: first.assignment.runtimeOwnerAssignmentId,
          containmentId: parseA1SafeId("stale-runtime-termination"),
          containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
          containmentEvidenceRef: parseA1SafeId("stale-runtime-termination-evidence"),
          containmentEvidenceDigest: digest(140),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.replaceRuntimeIncarnation({
          fence: successorFence,
          operation: operation("stale-runtime-replace", 141),
          runtimeId: first.runtime.runtimeId,
          predecessorNativeIncarnation: 1,
          expectedRuntimeOwnerAssignmentId: first.assignment.runtimeOwnerAssignmentId,
          containmentId: parseA1SafeId("stale-runtime-replacement"),
          containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
          containmentEvidenceRef: parseA1SafeId("stale-runtime-replacement-evidence"),
          containmentEvidenceDigest: digest(142),
          successorStartIdentitySchemaId: "remote-claw/test/native-process-start/v1",
          successorStartIdentityRef: parseA1SafeId("stale-runtime-successor-start"),
          successorStartIdentityDigest: digest(143),
          successorRuntimeOwnerAssignmentId: parseA1SafeId("stale-runtime-successor-assignment"),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(database.runtimeOwner.readInventory().runtimes).toHaveLength(2);
      const reassignRequest = {
        fence: successorFence,
        operation: operation("runtime-reassign", 67),
        runtimeId: first.runtime.runtimeId,
        nativeIncarnation: 1,
        expectedRuntimeOwnerAssignmentId: first.assignment.runtimeOwnerAssignmentId,
        runtimeOwnerAssignmentId: parseA1SafeId("runtime-assignment-20-2"),
        reattachmentEvidenceSchemaId: "remote-claw/test/reattachment/v1",
        reattachmentEvidenceRef: parseA1SafeId("runtime-20-owner-2-reattachment"),
        reattachmentEvidenceDigest: digest(68),
      };
      const reassigned = database.runtimeOwner.reassignRuntimeOwner(reassignRequest);
      expect(database.runtimeOwner.reassignRuntimeOwner(reassignRequest)).toEqual({
        ...reassigned,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.reassignRuntimeOwner({
          ...reassignRequest,
          operation: { ...reassignRequest.operation, operationDigest: digest(66) },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const replacementRequest = {
        fence: successorFence,
        operation: operation("runtime-replace", 69),
        runtimeId: first.runtime.runtimeId,
        predecessorNativeIncarnation: 1,
        expectedRuntimeOwnerAssignmentId: reassigned.assignment.runtimeOwnerAssignmentId,
        containmentId: parseA1SafeId("runtime-20-replacement-1"),
        containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
        containmentEvidenceRef: parseA1SafeId("runtime-20-replacement-evidence"),
        containmentEvidenceDigest: digest(70),
        successorStartIdentitySchemaId: "remote-claw/test/native-process-start/v1",
        successorStartIdentityRef: parseA1SafeId("native-process-start-20-incarnation-2"),
        successorStartIdentityDigest: digest(71),
        successorRuntimeOwnerAssignmentId: parseA1SafeId("runtime-assignment-20-incarnation-2"),
      };
      const replacement = database.runtimeOwner.replaceRuntimeIncarnation(replacementRequest);
      expect(database.runtimeOwner.replaceRuntimeIncarnation(replacementRequest)).toEqual({
        ...replacement,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.replaceRuntimeIncarnation({
          ...replacementRequest,
          operation: { ...replacementRequest.operation, operationDigest: digest(74) },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const terminateFirstRequest = {
        fence: successorFence,
        operation: operation("runtime-terminate", 72),
        runtimeId: first.runtime.runtimeId,
        predecessorNativeIncarnation: 2,
        expectedRuntimeOwnerAssignmentId: replacement.assignment.runtimeOwnerAssignmentId,
        containmentId: parseA1SafeId("runtime-20-termination"),
        containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
        containmentEvidenceRef: parseA1SafeId("runtime-20-termination-evidence"),
        containmentEvidenceDigest: digest(73),
      };
      const terminatedFirst = database.runtimeOwner.terminateRuntime(terminateFirstRequest);
      expect(database.runtimeOwner.terminateRuntime(terminateFirstRequest)).toEqual({
        ...terminatedFirst,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.terminateRuntime({
          ...terminateFirstRequest,
          operation: { ...terminateFirstRequest.operation, operationDigest: digest(75) },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(() =>
        database.runtimeOwner.reserveSignature({
          fence: successorFence,
          runtimeId: first.runtime.runtimeId,
          runtimeOwnerIdentityKeyId: rotated.identityKey.runtimeOwnerIdentityKeyId,
          runtimeOwnerKeyGeneration: 2,
          expectedSignerSequence: 1,
          purpose: "runtime_isolation_attestation",
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(database.runtimeOwner.readInventory().runtimes).toHaveLength(2);

      const inventory = database.runtimeOwner.readInventory();
      expect(inventory).toMatchObject({
        runtimes: [{ state: "closed" }, { state: "closed" }],
        incarnations: expect.arrayContaining([
          expect.objectContaining({
            runtimeId: first.runtime.runtimeId,
            nativeIncarnation: 1,
            state: "closed",
          }),
          expect.objectContaining({
            runtimeId: first.runtime.runtimeId,
            nativeIncarnation: 2,
            state: "closed",
          }),
          expect.objectContaining({
            runtimeId: second.runtime.runtimeId,
            nativeIncarnation: 1,
            state: "closed",
          }),
        ]),
        assignments: expect.arrayContaining([
          expect.objectContaining({ reason: "takeover", runtimeOwnerServiceEpoch: 2 }),
        ]),
        identityKeys: expect.arrayContaining([
          expect.objectContaining({ keyGeneration: 1, state: "retired" }),
          expect.objectContaining({ keyGeneration: 2, state: "current" }),
        ]),
      });
      expect(database.runtimeOwner.readOperation(replacementRequest.operation.operationId)).toEqual(
        replacement.journalEntry,
      );
    } finally {
      database.close();
    }

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      expect(reopened.runtimeOwner.readInventory().runtimes).toHaveLength(2);
    } finally {
      reopened.close();
    }
  });

  it("records local native transitions and detaches a prepared collaborator without killing its runtime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      const server = database.records.ensureDefaultCollaborationServer();
      const coordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: server.server.collaborationServerId,
        candidateLeaseId: canonicalId("coordinatorLease", 80),
        ownerInstanceId: parseA1SafeId("coordinator-owner-80"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      const coordinatorFence = {
        collaborationServerId: server.server.collaborationServerId,
        coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: coordinator.lease.coordinatorEpoch,
      };
      const terminal = database.records.reserveFirstTerminalChat({
        fence: coordinatorFence,
        workspaceSelectorId: parseA1SafeId("workspace-a13"),
        terminalTarget: {
          kind: "terminal_native",
          descriptor: { product: "codex", access: "app-server" },
          terminalProjectRef: parseA1SafeId("terminal-project-a13"),
          nativeWorkspaceBindingId: null,
        },
        mappingEvidenceRef: parseA1SafeId("mapping-evidence-a13"),
        registration: terminalRegistration(81),
      });
      const otherProject = database.records.allocateExplicitProject({
        fence: coordinatorFence,
        projectAllocationIntentId: parseA1SafeId("other-project-allocation"),
        workspaceSelectorId: parseA1SafeId("other-project-workspace"),
        terminalTarget: {
          kind: "terminal_native",
          descriptor: { product: "codex", access: "app-server" },
          terminalProjectRef: parseA1SafeId("other-terminal-project"),
          nativeWorkspaceBindingId: null,
        },
        mappingEvidenceRef: parseA1SafeId("other-project-mapping-evidence"),
      });

      const ownerRequest = acquireRequest(82);
      database.runtimeOwner.acquireServiceLease(ownerRequest);
      const fence = ownerFence(ownerRequest, 1);
      const registrationRequest = await runtimeRegistration(fence, 83);
      const runtime = database.runtimeOwner.registerInitialRuntime(registrationRequest);

      const transitionRequest = {
        fence,
        operation: operation("local-transition", 84),
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        localTransitionId: parseA1SafeId("local-transition-1"),
        kind: "discover" as const,
        sourceLocalNativeConversationId: null,
        target: {
          localNativeConversationId: parseA1SafeId("local-conversation-1"),
          descriptor: registrationRequest.descriptor,
          projectId: terminal.project.projectId,
          semanticConversationId: parseA1SafeId("semantic-conversation-1"),
          parentLocalNativeConversationId: null,
          state: "open" as const,
        },
        observedSemanticConversationId: parseA1SafeId("semantic-conversation-1"),
        nativeEvidenceSchemaId: "remote-claw/test/native-observation/v1",
        nativeEvidenceRef: parseA1SafeId("native-observation-1"),
        nativeEvidenceDigest: digest(85),
      };
      const transition = database.runtimeOwner.appendLocalConversationTransition(transitionRequest);
      expect(database.runtimeOwner.appendLocalConversationTransition(transitionRequest)).toEqual({
        ...transition,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.appendLocalConversationTransition({
          ...transitionRequest,
          target: {
            ...transitionRequest.target,
            projectId: canonicalId("project", 119),
          },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      const crossProjectTransition = database.runtimeOwner.appendLocalConversationTransition({
        ...transitionRequest,
        operation: operation("cross-project-local-transition", 137),
        localTransitionId: parseA1SafeId("cross-project-local-transition"),
        kind: "new",
        target: {
          ...transitionRequest.target,
          localNativeConversationId: parseA1SafeId("cross-project-local-conversation"),
          projectId: otherProject.project.projectId,
          semanticConversationId: parseA1SafeId("cross-project-semantic-conversation"),
        },
        observedSemanticConversationId: parseA1SafeId("cross-project-semantic-conversation"),
        nativeEvidenceRef: parseA1SafeId("cross-project-native-observation"),
        nativeEvidenceDigest: digest(138),
      });
      expect(() =>
        database.runtimeOwner.appendLocalConversationTransition({
          ...transitionRequest,
          nativeEvidenceDigest: digest(86),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);

      for (const [index, kind] of (["discover", "new", "clear"] as const).entries()) {
        expect(() =>
          database.runtimeOwner.appendLocalConversationTransition({
            ...transitionRequest,
            operation: operation(`invalid-${kind}-parent`, 120 + index),
            localTransitionId: parseA1SafeId(`invalid-${kind}-parent-transition`),
            kind,
            sourceLocalNativeConversationId:
              kind === "clear" ? transition.conversation.localNativeConversationId : null,
            target: {
              ...transitionRequest.target,
              localNativeConversationId: parseA1SafeId(`invalid-${kind}-parent-conversation`),
              semanticConversationId: null,
              parentLocalNativeConversationId: transition.conversation.localNativeConversationId,
            },
            observedSemanticConversationId: null,
            nativeEvidenceRef: parseA1SafeId(`invalid-${kind}-parent-evidence`),
          }),
        ).toThrow(RuntimeOwnerRepositoryConflictError);
      }

      const fork = database.runtimeOwner.appendLocalConversationTransition({
        ...transitionRequest,
        operation: operation("local-transition", 87),
        localTransitionId: parseA1SafeId("local-transition-2"),
        kind: "fork",
        sourceLocalNativeConversationId: transition.conversation.localNativeConversationId,
        target: {
          ...transitionRequest.target,
          localNativeConversationId: parseA1SafeId("local-conversation-2"),
          semanticConversationId: parseA1SafeId("semantic-conversation-2"),
          parentLocalNativeConversationId: transition.conversation.localNativeConversationId,
        },
        observedSemanticConversationId: parseA1SafeId("semantic-conversation-2"),
        nativeEvidenceRef: parseA1SafeId("native-observation-2"),
        nativeEvidenceDigest: digest(88),
      });
      expect(fork.transition.localTransitionSeq).toBe(3);

      database.runtimeOwner.releaseServiceLease({
        fence,
        operation: operation("local-owner-release", 131),
      });
      const successorOwnerRequest = acquireRequest(132, null, 1);
      database.runtimeOwner.acquireServiceLease(successorOwnerRequest);
      const successorFence = ownerFence(successorOwnerRequest, 2);
      expect(() =>
        database.runtimeOwner.appendLocalConversationTransition({
          ...transitionRequest,
          fence: successorFence,
          operation: operation("stale-runtime-transition", 133),
          localTransitionId: parseA1SafeId("stale-runtime-transition"),
          kind: "clear",
          sourceLocalNativeConversationId: fork.conversation.localNativeConversationId,
          target: {
            ...transitionRequest.target,
            localNativeConversationId: parseA1SafeId("stale-runtime-conversation"),
            semanticConversationId: null,
            parentLocalNativeConversationId: null,
            state: "unbound",
          },
          observedSemanticConversationId: null,
          nativeEvidenceRef: parseA1SafeId("stale-runtime-observation"),
          nativeEvidenceDigest: digest(134),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(database.runtimeOwner.readInventory().transitions).toHaveLength(3);
      const reassigned = database.runtimeOwner.reassignRuntimeOwner({
        fence: successorFence,
        operation: operation("local-runtime-reassign", 135),
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        expectedRuntimeOwnerAssignmentId: runtime.assignment.runtimeOwnerAssignmentId,
        runtimeOwnerAssignmentId: parseA1SafeId("local-runtime-assignment-owner-2"),
        reattachmentEvidenceSchemaId: "remote-claw/test/reattachment/v1",
        reattachmentEvidenceRef: parseA1SafeId("local-runtime-owner-2-reattachment"),
        reattachmentEvidenceDigest: digest(136),
      });

      const prepareRequest = {
        fence: successorFence,
        coordinatorFence,
        bindingOperation: operation("binding-prepare", 89),
        attachmentOperation: operation("attachment-acquire", 90),
        nativeBindingIncarnationId: parseA1SafeId("native-binding-incarnation-1"),
        collaborationServerId: server.server.collaborationServerId,
        logicalChatId: terminal.chat.logicalChatId,
        nativeBindingId: terminal.binding.nativeBindingId,
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        semanticConversationId:
          transition.conversation.semanticConversationId ??
          parseA1SafeId("unreachable-semantic-conversation"),
        attachmentId: parseA1SafeId("transport-attachment-1"),
        attachmentKind: "app-server" as const,
        transportId: parseA1SafeId("app-server-transport-1"),
        attachmentGeneration: 1,
        attachmentLeaseId: parseA1SafeId("transport-attachment-lease-1"),
        transportEpoch: 1,
        resourceOwnership: "shared_runtime" as const,
        phase: "starting" as const,
        disconnectPolicy: "detach" as const,
      };
      expect(() =>
        database.runtimeOwner.prepareBindingRuntime({
          ...prepareRequest,
          bindingOperation: operation("cross-project-binding-prepare", 139),
          attachmentOperation: operation("cross-project-attachment-acquire", 140),
          nativeBindingIncarnationId: parseA1SafeId("cross-project-binding-incarnation"),
          semanticConversationId:
            crossProjectTransition.conversation.semanticConversationId ??
            parseA1SafeId("unreachable-cross-project-semantic-conversation"),
          attachmentId: parseA1SafeId("cross-project-transport-attachment"),
          transportId: parseA1SafeId("cross-project-app-server-transport"),
          attachmentLeaseId: parseA1SafeId("cross-project-transport-lease"),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      const prepared = database.runtimeOwner.prepareBindingRuntime(prepareRequest);
      expect(database.runtimeOwner.prepareBindingRuntime(prepareRequest)).toEqual({
        ...prepared,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.prepareBindingRuntime({
          ...prepareRequest,
          bindingOperation: {
            ...prepareRequest.bindingOperation,
            operationDigest: digest(94),
          },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      const blockedTermination = {
        fence: successorFence,
        operation: operation("runtime-terminate", 91),
        runtimeId: runtime.runtime.runtimeId,
        predecessorNativeIncarnation: 1,
        expectedRuntimeOwnerAssignmentId: reassigned.assignment.runtimeOwnerAssignmentId,
        containmentId: parseA1SafeId("runtime-83-termination"),
        containmentEvidenceSchemaId: "remote-claw/test/containment/v1",
        containmentEvidenceRef: parseA1SafeId("runtime-83-termination-evidence"),
        containmentEvidenceDigest: digest(92),
      };
      expect(() => database.runtimeOwner.terminateRuntime(blockedTermination)).toThrow(
        RuntimeOwnerRepositoryConflictError,
      );

      const detachRequest = {
        fence: successorFence,
        coordinatorFence,
        operation: operation("attachment-detach", 93),
        nativeBindingId: terminal.binding.nativeBindingId,
        attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration,
      };
      const detached = database.runtimeOwner.detachBindingRuntime(detachRequest);
      expect(database.runtimeOwner.detachBindingRuntime(detachRequest)).toEqual({
        ...detached,
        replayed: true,
      });
      expect(() =>
        database.runtimeOwner.detachBindingRuntime({
          ...detachRequest,
          operation: { ...detachRequest.operation, operationDigest: digest(95) },
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(detached.runtime).toMatchObject({
        runtimeId: runtime.runtime.runtimeId,
        state: "current",
        currentNativeIncarnation: 1,
      });
      expect(detached).toMatchObject({
        gate: { phase: "closed" },
        attachment: { state: "closed" },
        attachmentLease: { state: "closed" },
      });
      expect(database.runtimeOwner.terminateRuntime(blockedTermination)).toMatchObject({
        runtime: { state: "closed" },
      });
      expect(database.runtimeOwner.readInventory()).toMatchObject({
        transitions: [
          { localTransitionSeq: 1 },
          { localTransitionSeq: 2 },
          { localTransitionSeq: 3 },
        ],
        gates: [{ phase: "closed" }],
      });
    } finally {
      database.close();
    }

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      expect(reopened.runtimeOwner.readInventory()).toMatchObject({
        runtimes: [{ state: "closed" }],
        gates: [{ phase: "closed" }],
      });
    } finally {
      reopened.close();
    }
  });

  it("refuses to invent A1.2 project authority for a brand-new offline local conversation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(25_000);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      const ownerRequest = acquireRequest(96);
      database.runtimeOwner.acquireServiceLease(ownerRequest);
      const fence = ownerFence(ownerRequest, 1);
      const registration = await runtimeRegistration(fence, 97);
      const runtime = database.runtimeOwner.registerInitialRuntime(registration);
      expect(() =>
        database.runtimeOwner.appendLocalConversationTransition({
          fence,
          operation: operation("missing-project-local-transition", 98),
          runtimeId: runtime.runtime.runtimeId,
          nativeIncarnation: 1,
          localTransitionId: parseA1SafeId("missing-project-local-transition-1"),
          kind: "discover",
          sourceLocalNativeConversationId: null,
          target: {
            localNativeConversationId: parseA1SafeId("missing-project-local-conversation-1"),
            descriptor: registration.descriptor,
            projectId: canonicalId("project", 99),
            semanticConversationId: null,
            parentLocalNativeConversationId: null,
            state: "unbound",
          },
          observedSemanticConversationId: null,
          nativeEvidenceSchemaId: "remote-claw/test/native-observation/v1",
          nativeEvidenceRef: parseA1SafeId("missing-project-native-observation"),
          nativeEvidenceDigest: digest(100),
        }),
      ).toThrow(RuntimeOwnerRepositoryConflictError);
      expect(database.runtimeOwner.readInventory()).toMatchObject({
        conversations: [],
        transitions: [],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    [
      "journal offset history",
      "UPDATE runtime_owner_journal_entries SET journal_offset = journal_offset + 100 WHERE journal_offset = 0",
    ],
    [
      "journal causal ordering",
      `UPDATE runtime_owner_journal_entries SET journal_offset = 1000000 WHERE journal_offset = 0;
       UPDATE runtime_owner_journal_entries SET journal_offset = 0 WHERE journal_offset = 1;
       UPDATE runtime_owner_journal_entries SET journal_offset = 1 WHERE journal_offset = 1000000`,
    ],
    [
      "attachment coordinator fence",
      `UPDATE native_transport_leases
       SET coordinator_lease_id = (
         SELECT coordinator_lease_id FROM coordinator_leases WHERE coordinator_epoch = 2
       ), coordinator_epoch = 2`,
    ],
    [
      "cross-service-epoch journal ordering",
      swapJournalOffsetsSql(
        "entry_kind = 'service_lease_released' AND runtime_owner_service_epoch = 1",
        "entry_kind = 'service_lease_acquired' AND runtime_owner_service_epoch = 2",
      ),
    ],
    [
      "assignment-generation activation ordering",
      swapJournalOffsetsSql("entry_kind = 'runtime_replaced'", "entry_kind = 'runtime_reassigned'"),
    ],
    [
      "transport detach before acquisition",
      swapJournalOffsetsSql(
        "entry_kind = 'attachment_lease_acquired'",
        "entry_kind = 'attachment_detached'",
      ),
    ],
    [
      "key-rotation generation ordering",
      swapJournalOffsetsSql(
        "entry_kind = 'runtime_key_rotated' AND subject_id = 'runtime-identity-key-122'",
        "entry_kind = 'runtime_key_rotated' AND subject_id = 'runtime-identity-key-126'",
      ),
    ],
    [
      "incarnation effect after runtime replacement",
      `UPDATE runtime_owner_journal_entries SET journal_offset = journal_offset + 100
       WHERE journal_offset BETWEEN 4 AND 8;
       UPDATE runtime_owner_journal_entries SET journal_offset = 4
       WHERE entry_kind = 'binding_incarnation_prepared';
       UPDATE runtime_owner_journal_entries SET journal_offset = 5
       WHERE entry_kind = 'attachment_lease_acquired';
       UPDATE runtime_owner_journal_entries SET journal_offset = 6
       WHERE entry_kind = 'attachment_detached';
       UPDATE runtime_owner_journal_entries SET journal_offset = 7
       WHERE entry_kind = 'runtime_replaced';
       UPDATE runtime_owner_journal_entries SET journal_offset = 8
       WHERE entry_kind = 'local_conversation_transitioned'
         AND subject_id = 'validator-local-transition-2'`,
    ],
    [
      "extra journal effect without a durable mutation",
      `INSERT INTO runtime_owner_journal_entries (
         journal_offset, entry_kind, subject_kind, subject_id, operation_id,
         operation_schema_id, operation_digest, runtime_owner_service_lease_id,
         runtime_owner_service_epoch, committed_at_ms
       ) SELECT next_journal_offset, 'runtime_reassigned', 'native_runtime',
           (SELECT runtime_id FROM native_runtimes LIMIT 1),
           'tampered-extra-operation', 'remote-claw/test/tampered-extra/v1',
           '${digest(200)}', current_runtime_owner_service_lease_id,
           current_runtime_owner_service_epoch, 30000
         FROM runtime_owner_state WHERE singleton = 1;
       UPDATE runtime_owner_state SET next_journal_offset = next_journal_offset + 1
       WHERE singleton = 1`,
    ],
    [
      "owner lease pointer/history",
      "UPDATE runtime_owner_state SET current_runtime_owner_service_lease_id = NULL WHERE singleton = 1",
    ],
    [
      "runtime containment chain",
      "UPDATE native_runtime_containments SET contained_at_ms = contained_at_ms + 1 WHERE kind = 'replacement'",
    ],
    [
      "runtime containment without predecessor-owner assignment",
      `UPDATE native_runtime_containments
       SET contained_at_ms = 31000,
           runtime_owner_service_lease_id = (
             SELECT runtime_owner_service_lease_id FROM runtime_owner_service_leases
             WHERE runtime_owner_service_epoch = 2
           ), runtime_owner_service_epoch = 2
       WHERE kind = 'replacement';
       UPDATE native_runtime_incarnations SET closed_at_ms = 31000
       WHERE native_incarnation = 1;
       UPDATE native_runtime_incarnations
       SET started_at_ms = 31000,
           runtime_owner_service_lease_id = (
             SELECT runtime_owner_service_lease_id FROM runtime_owner_service_leases
             WHERE runtime_owner_service_epoch = 2
           ), runtime_owner_service_epoch = 2
       WHERE native_incarnation = 2;
       UPDATE runtime_owner_assignments
       SET assigned_at_ms = 31000,
           runtime_owner_service_lease_id = (
             SELECT runtime_owner_service_lease_id FROM runtime_owner_service_leases
             WHERE runtime_owner_service_epoch = 2
           ), runtime_owner_service_epoch = 2
       WHERE native_incarnation = 2 AND assignment_generation = 1;
       UPDATE runtime_owner_journal_entries
       SET committed_at_ms = 31000,
           runtime_owner_service_lease_id = (
             SELECT runtime_owner_service_lease_id FROM runtime_owner_service_leases
             WHERE runtime_owner_service_epoch = 2
           ), runtime_owner_service_epoch = 2,
           journal_offset = 1000000
       WHERE entry_kind = 'runtime_replaced';
       UPDATE runtime_owner_journal_entries SET journal_offset = 8
       WHERE entry_kind = 'service_lease_acquired' AND runtime_owner_service_epoch = 2;
       UPDATE runtime_owner_journal_entries SET journal_offset = 10
       WHERE journal_offset = 1000000`,
    ],
    [
      "runtime creation-assignment evidence",
      `UPDATE runtime_owner_assignments SET assignment_evidence_digest = '${digest(201)}'
       WHERE native_incarnation = 2 AND assignment_generation = 1`,
    ],
    [
      "runtime journal fact timestamp",
      `UPDATE runtime_owner_journal_entries SET committed_at_ms = committed_at_ms + 1
       WHERE entry_kind = 'runtime_registered'`,
    ],
    [
      "released-owner effect timestamp",
      `UPDATE native_runtime_containments SET contained_at_ms = 31001
       WHERE kind = 'replacement';
       UPDATE native_runtime_incarnations SET closed_at_ms = 31001
       WHERE native_incarnation = 1;
       UPDATE native_runtime_incarnations SET started_at_ms = 31001
       WHERE native_incarnation = 2;
       UPDATE runtime_owner_assignments SET assigned_at_ms = 31001
       WHERE native_incarnation = 2 AND assignment_generation = 1;
       UPDATE runtime_owner_journal_entries SET committed_at_ms = 31001
       WHERE entry_kind = 'runtime_replaced'`,
    ],
    [
      "signer sequence",
      "UPDATE runtime_owner_identity_keys SET next_signer_sequence = next_signer_sequence + 1 WHERE state = 'current'",
    ],
    [
      "identity-key/private-envelope lifecycle pairing",
      `UPDATE runtime_owner_private_keys SET state = 'destroyed', destroyed_at_ms = created_at_ms
       WHERE state = 'current'`,
    ],
    [
      "founding identity-key registration time",
      `UPDATE runtime_owner_private_keys
       SET created_at_ms = created_at_ms + 1, destroyed_at_ms = destroyed_at_ms + 1
       WHERE key_generation = 1`,
    ],
    [
      "rotated-key predecessor destruction time",
      `UPDATE runtime_owner_private_keys SET destroyed_at_ms = destroyed_at_ms + 1
       WHERE key_generation = 1`,
    ],
    [
      "local transition sequence",
      "UPDATE local_native_conversation_transitions SET local_transition_seq = local_transition_seq + 100",
    ],
    [
      "local transition semantic lineage",
      `UPDATE local_native_conversation_transitions
       SET observed_semantic_conversation_id = 'tampered-semantic-conversation'`,
    ],
    [
      "local transition source causality",
      `UPDATE local_native_conversation_transitions
       SET kind = 'fork', source_local_native_conversation_id = 'validator-local-conversation-2'
       WHERE local_transition_seq = 1;
       UPDATE local_native_conversations
       SET parent_local_native_conversation_id = 'validator-local-conversation-2'
       WHERE local_native_conversation_id = 'validator-local-conversation-1';
       UPDATE local_native_conversation_transitions
       SET kind = 'discover', source_local_native_conversation_id = NULL
       WHERE local_transition_seq = 2;
       UPDATE local_native_conversations
       SET parent_local_native_conversation_id = NULL
       WHERE local_native_conversation_id = 'validator-local-conversation-2'`,
    ],
    [
      "local conversation without a creating transition",
      `INSERT INTO local_native_conversations (
         local_native_conversation_id, descriptor_product, descriptor_access, project_id,
         runtime_id, native_incarnation, semantic_conversation_id,
         parent_local_native_conversation_id, state
       ) SELECT 'tampered-unintroduced-conversation', descriptor_product, descriptor_access,
           project_id, runtime_id, native_incarnation, NULL, NULL, 'unbound'
         FROM local_native_conversations LIMIT 1`,
    ],
    [
      "binding incarnation without its exact attachment graph",
      `INSERT INTO native_binding_incarnations (
         native_binding_incarnation_id, collaboration_server_id, logical_chat_id,
         native_binding_id, runtime_id, native_incarnation, semantic_conversation_id,
         created_at_ms, closed_at_ms, state
       ) SELECT 'tampered-orphan-binding-incarnation', collaboration_server_id,
           logical_chat_id, native_binding_id, runtime_id, native_incarnation,
           semantic_conversation_id, created_at_ms, created_at_ms, 'closed'
         FROM native_binding_incarnations LIMIT 1`,
    ],
    [
      "binding journal fact timestamp",
      `UPDATE runtime_owner_journal_entries SET committed_at_ms = committed_at_ms + 1
       WHERE entry_kind = 'binding_incarnation_prepared'`,
    ],
    [
      "binding attachment gate lifecycle",
      "UPDATE binding_lifecycle_gates SET phase = 'starting' WHERE phase = 'closed'",
    ],
    [
      "binding detach atomic timestamp",
      "UPDATE binding_lifecycle_gates SET updated_at_ms = updated_at_ms + 1 WHERE phase = 'closed'",
    ],
  ])("rejects hostile but row-valid %s tampering on recovery", async (_caseName, sql) => {
    const state = await createCompleteRuntimeGraphFixture();
    mutateWithoutLifecycleTriggers(state.paths.databasePath, sql);
    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      }),
    ).toThrow(/runtime-owner records failed semantic validation/);
  });
});
