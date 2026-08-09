import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDurableProjectSelectionEvidence,
  createNativeConversationCapabilitiesEvidence,
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
  parseWardenLaunchNonce,
} from "./ids.js";
import { expectedHostStateSqliteSchemaManifest, HOST_STATE_SCHEMA_VERSION } from "./migrations.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  createNativeRegistrationOperationEvidence,
  type NativeRegistrationOperationInputByKind,
  type NativeRegistrationOperationKind,
  NativeRegistrationRepositoryConflictError,
  NativeRegistrationStaleOwnerError,
} from "./registration-repository.js";
import type {
  AcquireRuntimeOwnerServiceLeaseRequest,
  RegisterInitialRuntimeRequest,
  RuntimeOwnerKeyMaterialInput,
  RuntimeOwnerOperationEvidence,
  RuntimeOwnerServiceFence,
} from "./runtime-repository.js";
import { openHostStateDatabase } from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "a4".repeat(16);
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

function ownerOperation(label: string, fill: number): RuntimeOwnerOperationEvidence {
  return {
    operationId: parseA1SafeId(`${label}-${fill}`),
    operationSchemaId: `remote-claw/test/${label}/v1`,
    operationDigest: digest(fill),
  };
}

function acquireOwnerRequest(fill: number): AcquireRuntimeOwnerServiceLeaseRequest {
  return {
    candidateLeaseId: parseA1SafeId(`registration-owner-lease-${fill}`),
    ownerInstanceId: parseA1SafeId(`registration-owner-instance-${fill}`),
    ownerProcessStartIdentitySchemaId: "remote-claw/test/process-start/v1",
    ownerProcessStartIdentityRef: parseA1SafeId(`registration-process-start-${fill}`),
    ownerProcessStartIdentityDigest: digest(fill),
    expectedCurrentLeaseId: null,
    expectedRuntimeOwnerServiceEpoch: 0,
    leaseDurationMs: 600_000,
    operation: ownerOperation("owner-acquire", fill + 1),
  };
}

function ownerFence(
  request: AcquireRuntimeOwnerServiceLeaseRequest,
  runtimeOwnerServiceEpoch = 1,
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
    runtimeOwnerIdentityKeyId: parseA1SafeId(`registration-runtime-key-${fill}`),
    publicKey: parseEd25519PublicKey(base64urlEncode(new Uint8Array(32).fill(fill))),
    signingKeyRef: { protectedHandleId: canonicalId("protectedHandle", fill), kind: "signing_key" },
    localTrustEvidenceRef: parseA1SafeId(`registration-local-trust-${fill}`),
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
): Promise<RegisterInitialRuntimeRequest> {
  const wardenLaunchNonce = parseWardenLaunchNonce(base64urlEncode(new Uint8Array(32).fill(fill)));
  const startIdentitySchemaId = "remote-claw/test/native-process-start/v1";
  const startIdentityDigest = digest(fill + 1);
  return {
    fence,
    operation: ownerOperation("runtime-register", fill + 2),
    runtimeId: await nativeRuntimeId({
      wardenLaunchNonce,
      startIdentitySchemaId,
      startIdentityDigest,
    }),
    descriptor: { product: "codex", access: "app-server" },
    wardenLaunchNonce,
    startIdentitySchemaId,
    startIdentityRef: parseA1SafeId(`registration-native-start-${fill}`),
    startIdentityDigest,
    runtimeOwnerAssignmentId: parseA1SafeId(`registration-runtime-assignment-${fill}`),
    key: keyMaterial(fill),
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a14-registration-repository-"),
  );
  temporaryRoots.push(root);
  const environment = { xdgStateHome: join(root, "state"), homeDirectory: join(root, "home") };
  return { environment, paths: resolveHostStatePaths(MACHINE_IDENTITY_ID, environment) };
}

function mutateWithoutTriggers(
  databasePath: string,
  triggerNames: readonly string[],
  mutation: (editor: DatabaseSync) => void,
): void {
  const manifest = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION);
  const triggers = triggerNames.map((name) => {
    const trigger = manifest.find((entry) => entry.type === "trigger" && entry.name === name);
    if (trigger === undefined) throw new Error(`missing ${name} trigger`);
    return trigger;
  });
  const editor = new DatabaseSync(databasePath);
  try {
    editor.exec("BEGIN IMMEDIATE");
    for (const trigger of triggers) editor.exec(`DROP TRIGGER "${trigger.name}"`);
    mutation(editor);
    for (const trigger of triggers) editor.exec(trigger.sql);
    editor.exec("COMMIT");
  } catch (error) {
    try {
      editor.exec("ROLLBACK");
    } catch {
      // Preserve the mutation failure.
    }
    throw error;
  } finally {
    editor.close();
  }
}

function registrationOperation<K extends NativeRegistrationOperationKind>(
  kind: K,
  label: string,
  input: NativeRegistrationOperationInputByKind[K],
) {
  return createNativeRegistrationOperationEvidence(kind, parseA1SafeId(label), input);
}

async function createFixture(liveReattach = true) {
  vi.useFakeTimers();
  vi.setSystemTime(30_000);
  const state = temporaryState();
  const database = openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: state.environment,
  });
  const server = database.records.ensureDefaultCollaborationServer();
  const coordinator = database.records.acquireCoordinatorLease({
    collaborationServerId: server.server.collaborationServerId,
    candidateLeaseId: canonicalId("coordinatorLease", 2),
    ownerInstanceId: parseA1SafeId("registration-coordinator-owner"),
    expectedCurrentLeaseId: null,
    expectedCoordinatorEpoch: 0,
    leaseDurationMs: 600_000,
  });
  const coordinatorFence = {
    collaborationServerId: server.server.collaborationServerId,
    coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
    coordinatorEpoch: coordinator.lease.coordinatorEpoch,
  };
  const acquire = acquireOwnerRequest(3);
  database.runtimeOwner.acquireServiceLease(acquire);
  const fence = ownerFence(acquire);
  const registration = await runtimeRegistration(fence, 4);
  const runtime = database.runtimeOwner.registerInitialRuntime(registration);
  const workspaceSelectorId = parseA1SafeId("registration-workspace");
  const terminalTarget = {
    kind: "terminal_native" as const,
    descriptor: registration.descriptor,
    terminalProjectRef: parseA1SafeId("registration-terminal-project"),
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
    metadataSchemaId: "remote-claw/test/registration-metadata/v1",
    metadataBytes: new TextEncoder().encode("exact metadata"),
  });
  const capabilitiesEvidence = createNativeConversationCapabilitiesEvidence({
    version: 1,
    mutationAdmission: "structured",
    history: "complete",
    deliveryEvidence: "structured_receipt",
    liveReattach,
  });
  const semanticConversationId = parseA1SafeId("registration-semantic-conversation");
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
    const capabilities = transaction.putArtifact({
      scopeKind: "collaboration_server",
      scopeId: server.server.collaborationServerId,
      artifactSchemaId: capabilitiesEvidence.canonicalSchemaId,
      artifactDigest: capabilitiesEvidence.canonicalDigest,
      artifactBytes: capabilitiesEvidence.canonicalBytes,
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
      mappingEvidenceRef: parseA1SafeId("registration-mapping-evidence"),
      registration: {
        registrationAttemptId: canonicalId("registrationAttempt", 5),
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
        capabilitiesRef: capabilities.artifactRef.protectedHandleId,
        capabilitiesDigest: capabilitiesEvidence.canonicalDigest,
      },
    });
    return { terminal, nativeRef };
  });
  const local = database.runtimeOwner.appendLocalConversationTransition({
    fence,
    operation: ownerOperation("local-discover", 6),
    runtimeId: runtime.runtime.runtimeId,
    nativeIncarnation: 1,
    localTransitionId: parseA1SafeId("registration-local-transition"),
    kind: "discover",
    sourceLocalNativeConversationId: null,
    target: {
      localNativeConversationId: parseA1SafeId("registration-local-conversation"),
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
    bindingOperation: ownerOperation("binding-prepare", 7),
    attachmentOperation: ownerOperation("attachment-acquire", 8),
    nativeBindingIncarnationId: parseA1SafeId("registration-binding-incarnation"),
    collaborationServerId: server.server.collaborationServerId,
    logicalChatId: reserved.terminal.chat.logicalChatId,
    nativeBindingId: reserved.terminal.binding.nativeBindingId,
    runtimeId: runtime.runtime.runtimeId,
    nativeIncarnation: 1,
    semanticConversationId:
      local.conversation.semanticConversationId ?? parseA1SafeId("unreachable-semantic-id"),
    attachmentId: parseA1SafeId("registration-attachment"),
    attachmentKind: "app-server",
    transportId: parseA1SafeId("registration-transport"),
    attachmentGeneration: 1,
    attachmentLeaseId: parseA1SafeId("registration-attachment-lease"),
    transportEpoch: 1,
    resourceOwnership: "shared_runtime",
    phase: "starting",
    disconnectPolicy: "detach",
  });
  const publicationArtifacts = database.transaction((transaction) => ({
    metadata: transaction.putArtifact({
      scopeKind: "native_binding",
      scopeId: reserved.terminal.binding.nativeBindingId,
      artifactSchemaId: metadataEvidence.canonicalSchemaId,
      artifactDigest: metadataEvidence.canonicalDigest,
      artifactBytes: metadataEvidence.canonicalBytes,
    }),
    capabilities: transaction.putArtifact({
      scopeKind: "native_binding",
      scopeId: reserved.terminal.binding.nativeBindingId,
      artifactSchemaId: capabilitiesEvidence.canonicalSchemaId,
      artifactDigest: capabilitiesEvidence.canonicalDigest,
      artifactBytes: capabilitiesEvidence.canonicalBytes,
    }),
  }));
  return {
    database,
    state,
    fence,
    coordinatorFence,
    runtime,
    reserved: reserved.terminal,
    prepared,
    metadataEvidence,
    capabilitiesEvidence,
    publicationArtifacts,
  };
}

type RegistrationFixture = Awaited<ReturnType<typeof createFixture>>;

function activateRegistration(fixture: RegistrationFixture, fill: number) {
  const { database, fence, coordinatorFence, reserved, runtime, prepared } = fixture;
  const openInput = {
    fence,
    coordinatorFence,
    nativeConversationLeaseId: canonicalId("nativeConversationLease", fill),
    registrationAttemptId: reserved.registrationIntent.registrationAttemptId,
    nativeBindingId: reserved.binding.nativeBindingId,
    runtimeId: runtime.runtime.runtimeId,
    nativeIncarnation: 1,
    protectedPortHandleId: canonicalId("protectedHandle", fill + 1),
  };
  const openRequest = {
    ...openInput,
    operation: registrationOperation("open", `registration-open-${fill}`, openInput),
  };
  const opened = database.registration.open(openRequest);
  const bindInput = {
    fence,
    coordinatorFence,
    nativeConversationLeaseId: opened.lease.nativeConversationLeaseId,
    nativeBindingIncarnationId: prepared.bindingIncarnation.nativeBindingIncarnationId,
    attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
  };
  const bindRequest = {
    ...bindInput,
    operation: registrationOperation("bind", `registration-bind-${fill}`, bindInput),
  };
  const bound = database.registration.bind(bindRequest);
  const publishInput = {
    fence,
    coordinatorFence,
    nativeConversationLeaseId: bound.lease.nativeConversationLeaseId,
    nativeRegistrationPublicationId: parseA1SafeId(`registration-publication-${fill}`),
    publicationGeneration: 1,
    metadataSchemaId: fixture.metadataEvidence.value.metadataSchemaId,
    metadataRef: fixture.publicationArtifacts.metadata.artifactRef.protectedHandleId,
    metadataDigest: fixture.metadataEvidence.canonicalDigest,
    capabilitiesRef: fixture.publicationArtifacts.capabilities.artifactRef.protectedHandleId,
    capabilitiesDigest: fixture.capabilitiesEvidence.canonicalDigest,
  };
  const publishRequest = {
    ...publishInput,
    operation: registrationOperation("publish", `registration-publish-${fill}`, publishInput),
  };
  const published = database.registration.publish(publishRequest);
  const readyInput = {
    fence,
    coordinatorFence,
    nativeConversationLeaseId: published.lease.nativeConversationLeaseId,
    expectedGateGeneration: prepared.gate.gateGeneration,
    expectedPublicationId: published.publication.nativeRegistrationPublicationId,
  };
  const readyRequest = {
    ...readyInput,
    operation: registrationOperation("ready", `registration-ready-${fill}`, readyInput),
  };
  const ready = database.registration.ready(readyRequest);
  return {
    opened,
    bound,
    published,
    ready,
    requests: {
      open: openRequest,
      bind: bindRequest,
      publish: publishRequest,
      ready: readyRequest,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describeLinux("A1.4 durable registration repository", () => {
  it("activates the exact prepared graph without making the chat or edge writable", async () => {
    const fixture = await createFixture();
    const { database, fence, coordinatorFence, reserved, runtime, prepared } = fixture;
    try {
      const openInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 20),
        registrationAttemptId: reserved.registrationIntent.registrationAttemptId,
        nativeBindingId: reserved.binding.nativeBindingId,
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        protectedPortHandleId: canonicalId("protectedHandle", 21),
      };
      const openRequest = {
        ...openInput,
        operation: registrationOperation("open", "registration-open", openInput),
      };
      const opened = database.registration.open(openRequest);
      expect(database.registration.open(openRequest)).toEqual({ ...opened, replayed: true });

      const bindInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: opened.lease.nativeConversationLeaseId,
        nativeBindingIncarnationId: prepared.bindingIncarnation.nativeBindingIncarnationId,
        attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
      };
      const bound = database.registration.bind({
        ...bindInput,
        operation: registrationOperation("bind", "registration-bind", bindInput),
      });

      const publishInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: bound.lease.nativeConversationLeaseId,
        nativeRegistrationPublicationId: parseA1SafeId("registration-publication-1"),
        publicationGeneration: 1,
        metadataSchemaId: fixture.metadataEvidence.value.metadataSchemaId,
        metadataRef: fixture.publicationArtifacts.metadata.artifactRef.protectedHandleId,
        metadataDigest: fixture.metadataEvidence.canonicalDigest,
        capabilitiesRef: fixture.publicationArtifacts.capabilities.artifactRef.protectedHandleId,
        capabilitiesDigest: fixture.capabilitiesEvidence.canonicalDigest,
      };
      const published = database.registration.publish({
        ...publishInput,
        operation: registrationOperation("publish", "registration-publish", publishInput),
      });

      const readyInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: published.lease.nativeConversationLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration,
        expectedPublicationId: published.publication.nativeRegistrationPublicationId,
      };
      const readyRequest = {
        ...readyInput,
        operation: registrationOperation("ready", "registration-ready", readyInput),
      };
      const ready = database.registration.ready(readyRequest);
      expect(ready.lease.state).toBe("ready");
      expect(database.registration.reconcileOperation("ready", readyRequest)).toMatchObject({
        lease: { state: "ready" },
        gateGeneration: readyInput.expectedGateGeneration + 1,
      });
      const repeatedReadyInput = {
        ...readyInput,
        expectedGateGeneration: readyInput.expectedGateGeneration + 1,
      };
      expect(() =>
        database.registration.ready({
          ...repeatedReadyInput,
          operation: registrationOperation(
            "ready",
            "registration-illegal-repeat-ready",
            repeatedReadyInput,
          ),
        }),
      ).toThrow(NativeRegistrationRepositoryConflictError);
      const reservation = database.records.readTerminalReservation(
        reserved.project.collaborationServerId,
        reserved.registrationIntent.registrationAttemptId,
      );
      expect(reservation?.binding).toMatchObject({
        state: "current",
        currentBindingIncarnationId: prepared.bindingIncarnation.nativeBindingIncarnationId,
        semanticConversationId: prepared.bindingIncarnation.semanticConversationId,
      });
      expect(reservation?.chat.state).toBe("recovering");
      expect(reservation?.edge).toMatchObject({ state: "installing", rootPathCertificateId: null });
      expect(database.registration.readInventory()).toMatchObject({
        leases: [{ state: "ready", nextOperationSequence: 5 }],
        publications: [{ state: "current" }],
        operations: [{ kind: "open" }, { kind: "bind" }, { kind: "publish" }, { kind: "ready" }],
      });
    } finally {
      database.close();
    }
  });

  it("rejects changed operation replays and invalid lifecycle edges without poisoning the handle", async () => {
    const fixture = await createFixture();
    const { database, fence, coordinatorFence, reserved, runtime, prepared } = fixture;
    try {
      const input = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 30),
        registrationAttemptId: reserved.registrationIntent.registrationAttemptId,
        nativeBindingId: reserved.binding.nativeBindingId,
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        protectedPortHandleId: canonicalId("protectedHandle", 31),
      };
      const request = {
        ...input,
        operation: registrationOperation("open", "registration-open-collision", input),
      };
      database.registration.open(request);
      const competingInput = {
        ...input,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 33),
        protectedPortHandleId: canonicalId("protectedHandle", 34),
      };
      expect(() =>
        database.registration.open({
          ...competingInput,
          operation: registrationOperation("open", "registration-competing-open", competingInput),
        }),
      ).toThrow(NativeRegistrationRepositoryConflictError);
      const changedInput = { ...input, protectedPortHandleId: canonicalId("protectedHandle", 32) };
      expect(() =>
        database.registration.open({
          ...changedInput,
          operation: registrationOperation("open", request.operation.operationId, changedInput),
        }),
      ).toThrow(NativeRegistrationRepositoryConflictError);
      expect(database.registration.readLease(input.nativeConversationLeaseId)?.state).toBe(
        "starting",
      );
      const bindInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: input.nativeConversationLeaseId,
        nativeBindingIncarnationId: prepared.bindingIncarnation.nativeBindingIncarnationId,
        attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
      };
      const bindRequest = {
        ...bindInput,
        operation: registrationOperation("bind", "registration-bind-collision", bindInput),
      };
      database.registration.bind(bindRequest);
      const changedBindInput = {
        ...bindInput,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 36),
      };
      const changedBindRequest = {
        ...changedBindInput,
        operation: registrationOperation(
          "bind",
          bindRequest.operation.operationId,
          changedBindInput,
        ),
      };
      expect(() => database.registration.bind(changedBindRequest)).toThrow(
        NativeRegistrationRepositoryConflictError,
      );
      expect(() => database.registration.reconcileOperation("bind", changedBindRequest)).toThrow(
        NativeRegistrationRepositoryConflictError,
      );
      expect(database.registration.readLease(input.nativeConversationLeaseId)).toMatchObject({
        nativeBindingIncarnationId: prepared.bindingIncarnation.nativeBindingIncarnationId,
        attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
      });
      database.runtimeOwner.releaseServiceLease({
        fence,
        operation: ownerOperation("registration-owner-release-before-replay", 35),
      });
      expect(database.registration.reconcileOperation("open", request)).toMatchObject({
        operation: request.operation,
        lease: { nativeConversationLeaseId: input.nativeConversationLeaseId },
      });
      expect(() => database.registration.open(request)).toThrow(NativeRegistrationStaleOwnerError);
    } finally {
      database.close();
    }
  });

  it("reattaches from an orderly closed predecessor with its exact retained close proof", async () => {
    const fixture = await createFixture();
    const { database, fence, coordinatorFence, prepared } = fixture;
    try {
      const activated = activateRegistration(fixture, 40);
      const closeInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: activated.ready.lease.nativeConversationLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration + 1,
      };
      const closeEvidence = registrationOperation(
        "close",
        "registration-close-before-reconnect",
        closeInput,
      );
      const closed = database.registration.close({ ...closeInput, operation: closeEvidence });
      expect(closed.lease.state).toBe("closed");

      const reattachInput = {
        fence,
        coordinatorFence,
        predecessorCloseOperation: closeEvidence,
        predecessorNativeConversationLeaseId: closed.lease.nativeConversationLeaseId,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 42),
        protectedPortHandleId: canonicalId("protectedHandle", 43),
        successorAttachmentLeaseId: null,
        expectedGateGeneration: prepared.gate.gateGeneration + 2,
      };
      const reattachRequest = {
        ...reattachInput,
        operation: registrationOperation(
          "reattach",
          "registration-orderly-reattach",
          reattachInput,
        ),
      };
      const reattached = database.registration.reattach(reattachRequest);
      expect(database.registration.reattach(reattachRequest)).toEqual({
        ...reattached,
        replayed: true,
      });
      expect(reattached).toMatchObject({
        predecessor: { state: "closed" },
        lease: {
          state: "recovering",
          leaseGeneration: 2,
          supersedesNativeConversationLeaseId: closed.lease.nativeConversationLeaseId,
          attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
        },
        attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
      });
      const changedSuccessorInput = {
        ...reattachInput,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 54),
      };
      const changedSuccessorRequest = {
        ...changedSuccessorInput,
        operation: registrationOperation(
          "reattach",
          reattachRequest.operation.operationId,
          changedSuccessorInput,
        ),
      };
      expect(() => database.registration.reattach(changedSuccessorRequest)).toThrow(
        NativeRegistrationRepositoryConflictError,
      );
      expect(() =>
        database.registration.reconcileOperation("reattach", changedSuccessorRequest),
      ).toThrow(NativeRegistrationRepositoryConflictError);
      expect(database.registration.readLease(reattached.lease.nativeConversationLeaseId)).toEqual(
        reattached.lease,
      );
      const occupiedTailInput = {
        ...reattachInput,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 44),
        protectedPortHandleId: canonicalId("protectedHandle", 45),
        expectedGateGeneration: prepared.gate.gateGeneration + 3,
      };
      expect(() =>
        database.registration.reattach({
          ...occupiedTailInput,
          operation: registrationOperation(
            "reattach",
            "registration-nontail-reattach",
            occupiedTailInput,
          ),
        }),
      ).toThrow(NativeRegistrationRepositoryConflictError);
      database.close();
      const reopened = openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: fixture.state.environment,
      });
      try {
        expect(reopened.registration.readLease(reattached.lease.nativeConversationLeaseId)).toEqual(
          reattached.lease,
        );
      } finally {
        reopened.close();
      }
    } finally {
      database.close();
    }
  });

  it("rejects reattach when the retained canonical publication disables it", async () => {
    const fixture = await createFixture(false);
    const { database, fence, coordinatorFence, prepared } = fixture;
    const predecessorLeaseId = canonicalId("nativeConversationLease", 46);
    try {
      const activated = activateRegistration(fixture, 46);
      const closeInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: activated.ready.lease.nativeConversationLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration + 1,
      };
      const closeOperation = registrationOperation(
        "close",
        "registration-no-live-reattach-close",
        closeInput,
      );
      const closed = database.registration.close({ ...closeInput, operation: closeOperation });
      const reattachInput = {
        fence,
        coordinatorFence,
        predecessorCloseOperation: closeOperation,
        predecessorNativeConversationLeaseId: closed.lease.nativeConversationLeaseId,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 48),
        protectedPortHandleId: canonicalId("protectedHandle", 49),
        successorAttachmentLeaseId: null,
        expectedGateGeneration: prepared.gate.gateGeneration + 2,
      };
      expect(() =>
        database.registration.reattach({
          ...reattachInput,
          operation: registrationOperation(
            "reattach",
            "registration-no-live-reattach",
            reattachInput,
          ),
        }),
      ).toThrow(NativeRegistrationRepositoryConflictError);
      expect(database.registration.readLease(predecessorLeaseId)).toEqual(closed.lease);
      expect(database.registration.readInventory()).toMatchObject({
        leases: [{ state: "closed" }],
        publications: [{ state: "superseded" }],
      });
    } finally {
      database.close();
    }

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      expect(reopened.registration.readLease(predecessorLeaseId)).toMatchObject({
        state: "closed",
      });
    } finally {
      reopened.close();
    }
  });

  it("allows bound pre-publication recovery without inventing a reattach capability", async () => {
    const fixture = await createFixture(false);
    const { database, fence, coordinatorFence, prepared, reserved, runtime } = fixture;
    try {
      const openInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 50),
        registrationAttemptId: reserved.registrationIntent.registrationAttemptId,
        nativeBindingId: reserved.binding.nativeBindingId,
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        protectedPortHandleId: canonicalId("protectedHandle", 51),
      };
      const opened = database.registration.open({
        ...openInput,
        operation: registrationOperation("open", "registration-prepublication-open", openInput),
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
        operation: registrationOperation("bind", "registration-prepublication-bind", bindInput),
      });
      const closeInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: bound.lease.nativeConversationLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration,
      };
      const closeOperation = registrationOperation(
        "close",
        "registration-prepublication-close",
        closeInput,
      );
      const reattachInput = {
        fence,
        coordinatorFence,
        predecessorCloseOperation: closeOperation,
        predecessorNativeConversationLeaseId: bound.lease.nativeConversationLeaseId,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 52),
        protectedPortHandleId: canonicalId("protectedHandle", 53),
        successorAttachmentLeaseId: null,
        expectedGateGeneration: prepared.gate.gateGeneration,
      };
      const reattached = database.registration.reattach({
        ...reattachInput,
        operation: registrationOperation(
          "reattach",
          "registration-prepublication-reattach",
          reattachInput,
        ),
      });
      expect(reattached).toMatchObject({
        predecessor: { state: "closed" },
        lease: { state: "recovering", currentPublicationId: null },
      });
    } finally {
      database.close();
    }

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      expect(reopened.registration.readInventory()).toMatchObject({
        leases: [{ state: "closed" }, { state: "recovering" }],
        publications: [],
      });
    } finally {
      reopened.close();
    }
  });

  it.each([
    "digest",
    "fence",
    "time",
    "sequence",
  ] as const)("rejects row-valid registration operation %s tampering on recovery", async (tamperKind) => {
    const fixture = await createFixture();
    const { database, fence, coordinatorFence, runtime } = fixture;
    try {
      const activated = activateRegistration(fixture, 70);
      database.runtimeOwner.releaseServiceLease({
        fence,
        operation: ownerOperation(`registration-tamper-owner-release-${tamperKind}`, 71),
      });
      const successorOwnerRequest = {
        ...acquireOwnerRequest(72),
        expectedRuntimeOwnerServiceEpoch: 1,
      };
      database.runtimeOwner.acquireServiceLease(successorOwnerRequest);
      const successorFence = ownerFence(successorOwnerRequest, 2);
      database.runtimeOwner.reassignRuntimeOwner({
        fence: successorFence,
        operation: ownerOperation(`registration-tamper-runtime-reassign-${tamperKind}`, 73),
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        expectedRuntimeOwnerAssignmentId: runtime.assignment.runtimeOwnerAssignmentId,
        runtimeOwnerAssignmentId: parseA1SafeId(
          `registration-tamper-runtime-assignment-${tamperKind}`,
        ),
        reattachmentEvidenceSchemaId: "remote-claw/test/reattachment/v1",
        reattachmentEvidenceRef: parseA1SafeId(`registration-tamper-reattachment-${tamperKind}`),
        reattachmentEvidenceDigest: digest(74),
      });
      database.records.releaseCoordinatorLease({ fence: coordinatorFence });
      const successorCoordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: coordinatorFence.collaborationServerId,
        candidateLeaseId: canonicalId("coordinatorLease", 75),
        ownerInstanceId: parseA1SafeId(`registration-tamper-coordinator-${tamperKind}`),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 1,
        leaseDurationMs: 600_000,
      });
      database.close();

      mutateWithoutTriggers(
        fixture.state.paths.databasePath,
        ["native_registration_operations_no_update"],
        (editor) => {
          const operationId = activated.requests.ready.operation.operationId;
          if (tamperKind === "digest") {
            editor
              .prepare(
                "UPDATE native_registration_operations SET operation_digest = ? WHERE operation_id = ?",
              )
              .run(digest(76), operationId);
          } else if (tamperKind === "fence") {
            editor
              .prepare(
                `UPDATE native_registration_operations
                      SET runtime_owner_service_lease_id = ?, runtime_owner_service_epoch = ?,
                          coordinator_lease_id = ?, coordinator_epoch = ?
                    WHERE operation_id = ?`,
              )
              .run(
                successorFence.runtimeOwnerServiceLeaseId,
                successorFence.runtimeOwnerServiceEpoch,
                successorCoordinator.lease.coordinatorLeaseId,
                successorCoordinator.lease.coordinatorEpoch,
                operationId,
              );
          } else if (tamperKind === "time") {
            editor
              .prepare(
                `UPDATE native_registration_operations
                      SET committed_at_ms = committed_at_ms + 1 WHERE operation_id = ?`,
              )
              .run(operationId);
          } else {
            editor
              .prepare(
                `UPDATE native_registration_operations
                      SET operation_sequence = operation_sequence + 10 WHERE operation_id = ?`,
              )
              .run(operationId);
          }
        },
      );
      expect(() =>
        openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: fixture.state.environment,
        }),
      ).toThrow(/native registration records failed semantic validation/);
    } finally {
      database.close();
    }
  });

  it("rejects a canonical binding-scoped metadata transplant that diverges from A1.2 intent", async () => {
    const fixture = await createFixture();
    const { database } = fixture;
    try {
      const activated = activateRegistration(fixture, 80);
      const alternateMetadata = createNativeRegistrationMetadataEvidence({
        metadataSchemaId: "remote-claw/test/alternate-registration-metadata/v1",
        metadataBytes: new TextEncoder().encode("different canonical metadata"),
      });
      const alternateArtifact = database.transaction((transaction) =>
        transaction.putArtifact({
          scopeKind: "native_binding",
          scopeId: fixture.reserved.binding.nativeBindingId,
          artifactSchemaId: alternateMetadata.canonicalSchemaId,
          artifactDigest: alternateMetadata.canonicalDigest,
          artifactBytes: alternateMetadata.canonicalBytes,
        }),
      );
      const alternatePublishInput = {
        fence: fixture.fence,
        coordinatorFence: fixture.coordinatorFence,
        nativeConversationLeaseId: activated.published.lease.nativeConversationLeaseId,
        nativeRegistrationPublicationId:
          activated.published.publication.nativeRegistrationPublicationId,
        publicationGeneration: activated.published.publication.publicationGeneration,
        metadataSchemaId: alternateMetadata.value.metadataSchemaId,
        metadataRef: alternateArtifact.artifactRef.protectedHandleId,
        metadataDigest: alternateMetadata.canonicalDigest,
        capabilitiesRef: activated.published.publication.capabilitiesRef,
        capabilitiesDigest: activated.published.publication.capabilitiesDigest,
      };
      const alternateOperation = registrationOperation(
        "publish",
        activated.requests.publish.operation.operationId,
        alternatePublishInput,
      );
      database.close();
      mutateWithoutTriggers(
        fixture.state.paths.databasePath,
        [
          "native_registration_publications_identity_immutable",
          "native_registration_operations_no_update",
        ],
        (editor) => {
          editor
            .prepare(
              `UPDATE native_registration_publications
                  SET metadata_schema_id = ?, metadata_ref = ?, metadata_digest = ?
                WHERE native_registration_publication_id = ?`,
            )
            .run(
              alternatePublishInput.metadataSchemaId,
              alternatePublishInput.metadataRef,
              alternatePublishInput.metadataDigest,
              alternatePublishInput.nativeRegistrationPublicationId,
            );
          editor
            .prepare(
              `UPDATE native_registration_operations SET operation_digest = ?
                WHERE operation_id = ?`,
            )
            .run(alternateOperation.operationDigest, alternateOperation.operationId);
        },
      );
      expect(() =>
        openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: fixture.state.environment,
        }),
      ).toThrow(/native registration records failed semantic validation/);
    } finally {
      database.close();
    }
  });

  it("recovers a stale-open crash lease by fencing, closing, and reattaching after takeover", async () => {
    const fixture = await createFixture();
    const { database, fence, coordinatorFence, prepared, runtime, reserved } = fixture;
    let recoveryDatabase: ReturnType<typeof openHostStateDatabase> | null = null;
    try {
      const activated = activateRegistration(fixture, 50);

      database.runtimeOwner.releaseServiceLease({
        fence,
        operation: ownerOperation("registration-owner-release", 60),
      });
      const successorOwnerRequest = {
        ...acquireOwnerRequest(61),
        expectedRuntimeOwnerServiceEpoch: 1,
      };
      database.runtimeOwner.acquireServiceLease(successorOwnerRequest);
      const successorFence = ownerFence(successorOwnerRequest, 2);
      const staleRecoverInput = {
        fence,
        coordinatorFence,
        nativeConversationLeaseId: activated.ready.lease.nativeConversationLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration + 1,
      };
      expect(() =>
        database.registration.recover({
          ...staleRecoverInput,
          operation: registrationOperation(
            "recover",
            "registration-stale-recover-after-takeover",
            staleRecoverInput,
          ),
        }),
      ).toThrow(NativeRegistrationStaleOwnerError);
      database.runtimeOwner.reassignRuntimeOwner({
        fence: successorFence,
        operation: ownerOperation("registration-runtime-reassign", 62),
        runtimeId: runtime.runtime.runtimeId,
        nativeIncarnation: 1,
        expectedRuntimeOwnerAssignmentId: runtime.assignment.runtimeOwnerAssignmentId,
        runtimeOwnerAssignmentId: parseA1SafeId("registration-runtime-assignment-successor"),
        reattachmentEvidenceSchemaId: "remote-claw/test/reattachment/v1",
        reattachmentEvidenceRef: parseA1SafeId("registration-reattachment-successor"),
        reattachmentEvidenceDigest: digest(63),
      });

      database.records.releaseCoordinatorLease({ fence: coordinatorFence });
      const successorCoordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: coordinatorFence.collaborationServerId,
        candidateLeaseId: canonicalId("coordinatorLease", 64),
        ownerInstanceId: parseA1SafeId("registration-coordinator-successor"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 1,
        leaseDurationMs: 600_000,
      });
      const successorCoordinatorFence = {
        collaborationServerId: coordinatorFence.collaborationServerId,
        coordinatorLeaseId: successorCoordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: successorCoordinator.lease.coordinatorEpoch,
      };
      database.close();
      recoveryDatabase = openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: fixture.state.environment,
      });
      expect(
        recoveryDatabase.registration.readLease(activated.ready.lease.nativeConversationLeaseId),
      ).toMatchObject({
        state: "ready",
        runtimeOwnerServiceLeaseId: fence.runtimeOwnerServiceLeaseId,
        coordinatorLeaseId: coordinatorFence.coordinatorLeaseId,
      });
      const successorAttachmentLeaseId = parseA1SafeId("registration-attachment-lease-successor");
      const predecessorCloseInput = {
        fence: successorFence,
        coordinatorFence: successorCoordinatorFence,
        nativeConversationLeaseId: activated.ready.lease.nativeConversationLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration + 1,
      };
      const predecessorCloseOperation = registrationOperation(
        "close",
        "registration-successor-fenced-crash-close",
        predecessorCloseInput,
      );
      const reattachInput = {
        fence: successorFence,
        coordinatorFence: successorCoordinatorFence,
        predecessorCloseOperation,
        predecessorNativeConversationLeaseId: activated.ready.lease.nativeConversationLeaseId,
        nativeConversationLeaseId: canonicalId("nativeConversationLease", 65),
        protectedPortHandleId: canonicalId("protectedHandle", 66),
        successorAttachmentLeaseId,
        expectedGateGeneration: prepared.gate.gateGeneration + 1,
      };
      const reattached = recoveryDatabase.registration.reattach({
        ...reattachInput,
        operation: registrationOperation(
          "reattach",
          "registration-owner-takeover-reattach",
          reattachInput,
        ),
      });
      expect(reattached.lease).toMatchObject({
        state: "recovering",
        runtimeOwnerServiceLeaseId: successorFence.runtimeOwnerServiceLeaseId,
        coordinatorLeaseId: successorCoordinatorFence.coordinatorLeaseId,
        attachmentLeaseId: successorAttachmentLeaseId,
      });
      expect(recoveryDatabase.runtimeOwner.readInventory()).toMatchObject({
        attachmentLeases: [
          {
            attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
            state: "superseded",
          },
          { attachmentLeaseId: successorAttachmentLeaseId, state: "current" },
        ],
      });
      const journal = recoveryDatabase.runtimeOwner.readInventory().journal;
      expect(journal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entryKind: "attachment_detached",
            subjectId: prepared.attachmentLease.attachmentLeaseId,
            operationId: predecessorCloseOperation.operationId,
            runtimeOwnerServiceLeaseId: successorFence.runtimeOwnerServiceLeaseId,
          }),
          expect.objectContaining({
            entryKind: "attachment_lease_acquired",
            subjectId: successorAttachmentLeaseId,
            operationId: "registration-owner-takeover-reattach",
            runtimeOwnerServiceLeaseId: successorFence.runtimeOwnerServiceLeaseId,
          }),
        ]),
      );
      expect(
        recoveryDatabase.records.readTerminalReservation(
          reserved.project.collaborationServerId,
          reserved.registrationIntent.registrationAttemptId,
        )?.chat.state,
      ).toBe("recovering");
      recoveryDatabase.close();
      const reopened = openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: fixture.state.environment,
      });
      try {
        expect(reopened.registration.readInventory()).toMatchObject({
          leases: [{ state: "closed" }, { state: "recovering" }],
          operations: [
            { kind: "open" },
            { kind: "bind" },
            { kind: "publish" },
            { kind: "ready" },
            { kind: "close" },
            { kind: "reattach" },
          ],
        });
      } finally {
        reopened.close();
      }
      mutateWithoutTriggers(
        fixture.state.paths.databasePath,
        ["runtime_owner_journal_entries_no_update"],
        (editor) => {
          const detached = editor
            .prepare(
              "SELECT journal_offset FROM runtime_owner_journal_entries WHERE operation_id = ?",
            )
            .get(predecessorCloseOperation.operationId);
          const acquired = editor
            .prepare(
              "SELECT journal_offset FROM runtime_owner_journal_entries WHERE operation_id = ?",
            )
            .get("registration-owner-takeover-reattach");
          if (
            detached === undefined ||
            acquired === undefined ||
            typeof detached.journal_offset !== "number" ||
            typeof acquired.journal_offset !== "number"
          ) {
            throw new Error("missing reattach journals");
          }
          const temporaryOffset = detached.journal_offset + 1_000_000;
          editor
            .prepare(
              "UPDATE runtime_owner_journal_entries SET journal_offset = ? WHERE operation_id = ?",
            )
            .run(temporaryOffset, predecessorCloseOperation.operationId);
          editor
            .prepare(
              "UPDATE runtime_owner_journal_entries SET journal_offset = ? WHERE operation_id = ?",
            )
            .run(detached.journal_offset, "registration-owner-takeover-reattach");
          editor
            .prepare(
              "UPDATE runtime_owner_journal_entries SET journal_offset = ? WHERE operation_id = ?",
            )
            .run(acquired.journal_offset, predecessorCloseOperation.operationId);
        },
      );
      expect(() =>
        openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: fixture.state.environment,
        }),
      ).toThrow(/runtime-owner records failed semantic validation/);
    } finally {
      recoveryDatabase?.close();
      database.close();
    }
  });
});
