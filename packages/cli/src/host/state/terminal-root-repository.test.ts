import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
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
  DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
  NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
  NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
  NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
  NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
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
import {
  type NativeRootActivationPreparationInput,
  nativeRootActivationOperationDigest,
} from "./native-root.js";
import { ProtectedByteSnapshot } from "./protected.js";
import type {
  AcquireRuntimeOwnerServiceLeaseRequest,
  RuntimeOwnerKeyMaterialInput,
  RuntimeOwnerOperationEvidence,
  RuntimeOwnerServiceFence,
} from "./runtime-repository.js";
import { RuntimeOwnerRepositoryConflictError } from "./runtime-repository.js";
import {
  createNativeRegistrationOperationEvidence,
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type HostStateTransaction,
  type NativeRegistrationOperationInputByKind,
  openHostStateDatabase,
} from "./sqlite.js";
import {
  type PrepareNativeRootRequest,
  TerminalRootRepositoryConflictError,
  TerminalRootRepositoryPersistenceError,
  TerminalRootStaleCoordinatorError,
  TerminalRootStaleOwnerError,
} from "./terminal-root-repository.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "a5".repeat(16);
const NOW_MS = 500_000;
const ROOT_TTL_MS = 30_000;
const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];
const openDatabases: HostStateDatabase[] = [];

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
    collaborationCommand: "rcm_",
    collaborationCommandResult: "ccr_",
    commandSigningGroup: "csg_",
    commandResultPreparation: "crp_",
  } as const;
  const byteLength =
    kind === "nativeRuntime" ||
    kind === "projectTargetSelectorMapping" ||
    kind === "nativeDeliveryAttempt" ||
    kind === "collaborationCommand" ||
    kind === "collaborationCommandResult" ||
    kind === "commandSigningGroup" ||
    kind === "commandResultPreparation"
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

function registrationRequest<K extends keyof NativeRegistrationOperationInputByKind>(
  kind: K,
  label: string,
  input: NativeRegistrationOperationInputByKind[K],
): NativeRegistrationOperationInputByKind[K] & {
  readonly operation: RuntimeOwnerOperationEvidence;
} {
  return {
    ...input,
    operation: createNativeRegistrationOperationEvidence(kind, parseA1SafeId(label), input),
  };
}

function acquireOwnerRequest(fill: number): AcquireRuntimeOwnerServiceLeaseRequest {
  return {
    candidateLeaseId: parseA1SafeId(`root-owner-lease-${fill}`),
    ownerInstanceId: parseA1SafeId(`root-owner-instance-${fill}`),
    ownerProcessStartIdentitySchemaId: "remote-claw/test/owner-process-start/v1",
    ownerProcessStartIdentityRef: parseA1SafeId(`root-owner-process-${fill}`),
    ownerProcessStartIdentityDigest: digest(fill),
    expectedCurrentLeaseId: null,
    expectedRuntimeOwnerServiceEpoch: 0,
    leaseDurationMs: 600_000,
    operation: ownerOperation("root-owner-acquire", fill + 1),
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

function keyMaterial(fill: number, publicKey: string): RuntimeOwnerKeyMaterialInput {
  return {
    runtimeOwnerIdentityKeyId: parseA1SafeId(`root-runtime-key-${fill}`),
    publicKey: parseEd25519PublicKey(publicKey),
    signingKeyRef: {
      protectedHandleId: canonicalId("protectedHandle", fill),
      kind: "signing_key",
    },
    localTrustEvidenceRef: parseA1SafeId(`root-local-trust-${fill}`),
    localTrustEvidenceDigest: digest(fill + 1),
    wrapNonce: ProtectedByteSnapshot.from(new Uint8Array(12).fill(fill)),
    wrappedPkcs8: ProtectedByteSnapshot.from(new Uint8Array(48).fill(fill)),
    authTag: ProtectedByteSnapshot.from(new Uint8Array(16).fill(fill)),
    pkcs8Digest: digest(fill + 2),
  };
}

function publicKeyBytes(publicKey: KeyObject): string {
  const exported = publicKey.export({ format: "jwk" });
  if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || exported.x === undefined) {
    throw new Error("test Ed25519 key did not export an OKP public coordinate");
  }
  return exported.x;
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a15-terminal-root-"),
  );
  temporaryRoots.push(root);
  return {
    environment: {
      xdgStateHome: join(root, "state"),
      homeDirectory: join(root, "home"),
    },
  };
}

function mutateWithoutTrigger(
  databasePath: string,
  triggerName: string,
  mutation: (editor: DatabaseSync) => void,
): void {
  const trigger = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION).find(
    (entry) => entry.type === "trigger" && entry.name === triggerName,
  );
  if (trigger === undefined) throw new Error(`missing ${triggerName} trigger`);
  const editor = new DatabaseSync(databasePath);
  try {
    editor.exec("BEGIN IMMEDIATE");
    editor.exec(`DROP TRIGGER "${trigger.name}"`);
    mutation(editor);
    editor.exec(trigger.sql);
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

interface RegistrationPlan {
  readonly descriptor: Readonly<{ product: "codex"; access: "app-server" }>;
  readonly terminalTarget: Readonly<{
    kind: "terminal_native";
    descriptor: Readonly<{ product: "codex"; access: "app-server" }>;
    terminalProjectRef: ReturnType<typeof parseA1SafeId>;
    nativeWorkspaceBindingId: null;
  }>;
  readonly targetDigest: ReturnType<typeof parseA1Digest>;
  readonly workspaceSelectorId: ReturnType<typeof parseA1SafeId>;
  readonly registrationAttemptId: ReturnType<typeof canonicalId<"registrationAttempt">>;
  readonly runtimeId: ReturnType<typeof canonicalId<"nativeRuntime">>;
  readonly wardenLaunchNonce: ReturnType<typeof parseWardenLaunchNonce>;
  readonly startIdentityDigest: ReturnType<typeof parseA1Digest>;
  readonly semanticConversationId: ReturnType<typeof parseA1SafeId>;
  readonly descriptorEvidence: ReturnType<typeof createNativeEngineDescriptorEvidence>;
  readonly projectEvidence: ReturnType<typeof createDurableProjectSelectionEvidence>;
  readonly nativeRefEvidence: ReturnType<typeof createNativeConversationRefEvidence>;
  readonly metadataEvidence: ReturnType<typeof createNativeRegistrationMetadataEvidence>;
  readonly capabilitiesEvidence: ReturnType<typeof createNativeConversationCapabilitiesEvidence>;
}

async function registrationPlan(
  collaborationServerId: A1CanonicalId<"collaborationServer">,
): Promise<RegistrationPlan> {
  const descriptor = { product: "codex", access: "app-server" } as const;
  const terminalTarget = {
    kind: "terminal_native",
    descriptor,
    terminalProjectRef: parseA1SafeId("root-terminal-project"),
    nativeWorkspaceBindingId: null,
  } as const;
  const targetDigest = await projectTargetDigest(terminalTarget);
  const workspaceSelectorId = parseA1SafeId("root-workspace-main");
  const wardenLaunchNonce = parseWardenLaunchNonce(base64urlEncode(new Uint8Array(32).fill(81)));
  const startIdentityDigest = digest(82);
  const runtimeId = await nativeRuntimeId({
    wardenLaunchNonce,
    startIdentitySchemaId: "remote-claw/test/native-process-start/v1",
    startIdentityDigest,
  });
  const semanticConversationId = parseA1SafeId("root-semantic-conversation");
  return {
    descriptor,
    terminalTarget,
    targetDigest,
    workspaceSelectorId,
    registrationAttemptId: canonicalId("registrationAttempt", 70),
    runtimeId,
    wardenLaunchNonce,
    startIdentityDigest,
    semanticConversationId,
    descriptorEvidence: createNativeEngineDescriptorEvidence(descriptor),
    projectEvidence: createDurableProjectSelectionEvidence({
      kind: "first_bootstrap",
      collaborationServerId,
      workspaceSelectorId,
      terminalDescriptor: descriptor,
      targetDigest,
    }),
    nativeRefEvidence: createNativeConversationRefEvidence({
      descriptor,
      runtimeId,
      conversationId: semanticConversationId,
      incarnation: 1,
    }),
    metadataEvidence: createNativeRegistrationMetadataEvidence({
      metadataSchemaId: "remote-claw/test/provider-registration-metadata/v1",
      metadataBytes: Uint8Array.of(1, 5, 0, 5),
    }),
    capabilitiesEvidence: createNativeConversationCapabilitiesEvidence({
      version: 1,
      mutationAdmission: "structured",
      history: "complete",
      deliveryEvidence: "structured_receipt",
      liveReattach: true,
    }),
  };
}

function createReadyRegistrationGraph(
  transaction: HostStateTransaction,
  serverId: A1CanonicalId<"collaborationServer">,
  plan: RegistrationPlan,
  publicKey: string,
) {
  const coordinator = transaction.records.acquireCoordinatorLease({
    collaborationServerId: serverId,
    candidateLeaseId: canonicalId("coordinatorLease", 71),
    ownerInstanceId: parseA1SafeId("root-coordinator-owner"),
    expectedCurrentLeaseId: null,
    expectedCoordinatorEpoch: 0,
    leaseDurationMs: 600_000,
  });
  const coordinatorFence = {
    collaborationServerId: serverId,
    coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
    coordinatorEpoch: coordinator.lease.coordinatorEpoch,
  };
  const descriptorArtifact = transaction.putArtifact({
    scopeKind: "collaboration_server",
    scopeId: serverId,
    artifactSchemaId: NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
    artifactDigest: plan.descriptorEvidence.canonicalDigest,
    artifactBytes: plan.descriptorEvidence.canonicalBytes,
  });
  const projectArtifact = transaction.putArtifact({
    scopeKind: "collaboration_server",
    scopeId: serverId,
    artifactSchemaId: DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
    artifactDigest: plan.projectEvidence.canonicalDigest,
    artifactBytes: plan.projectEvidence.canonicalBytes,
  });
  const intentMetadataArtifact = transaction.putArtifact({
    scopeKind: "collaboration_server",
    scopeId: serverId,
    artifactSchemaId: NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
    artifactDigest: plan.metadataEvidence.canonicalDigest,
    artifactBytes: plan.metadataEvidence.canonicalBytes,
  });
  const intentCapabilitiesArtifact = transaction.putArtifact({
    scopeKind: "collaboration_server",
    scopeId: serverId,
    artifactSchemaId: NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
    artifactDigest: plan.capabilitiesEvidence.canonicalDigest,
    artifactBytes: plan.capabilitiesEvidence.canonicalBytes,
  });
  const reservation = transaction.records.reserveFirstTerminalChat({
    fence: coordinatorFence,
    workspaceSelectorId: plan.workspaceSelectorId,
    terminalTarget: plan.terminalTarget,
    mappingEvidenceRef: parseA1SafeId("root-mapping-evidence"),
    registration: {
      registrationAttemptId: plan.registrationAttemptId,
      descriptor: plan.descriptor,
      descriptorRef: descriptorArtifact.artifactRef.protectedHandleId,
      descriptorDigest: descriptorArtifact.artifactDigest,
      projectRef: projectArtifact.artifactRef.protectedHandleId,
      projectDigest: projectArtifact.artifactDigest,
      expectedNativeRefDigest: plan.nativeRefEvidence.canonicalDigest,
      initialPhase: "starting",
      metadataSchemaId: plan.metadataEvidence.value.metadataSchemaId,
      metadataRef: intentMetadataArtifact.artifactRef.protectedHandleId,
      metadataDigest: intentMetadataArtifact.artifactDigest,
      capabilitiesRef: intentCapabilitiesArtifact.artifactRef.protectedHandleId,
      capabilitiesDigest: intentCapabilitiesArtifact.artifactDigest,
    },
  });
  const acquire = acquireOwnerRequest(72);
  const owner = transaction.runtimeOwner.acquireServiceLease(acquire);
  const fence = ownerFence(acquire, owner.lease.runtimeOwnerServiceEpoch);
  const runtime = transaction.runtimeOwner.registerInitialRuntime({
    fence,
    operation: ownerOperation("root-runtime-register", 73),
    runtimeId: plan.runtimeId,
    descriptor: plan.descriptor,
    wardenLaunchNonce: plan.wardenLaunchNonce,
    startIdentitySchemaId: "remote-claw/test/native-process-start/v1",
    startIdentityRef: parseA1SafeId("root-native-process-start"),
    startIdentityDigest: plan.startIdentityDigest,
    runtimeOwnerAssignmentId: parseA1SafeId("root-runtime-assignment-1"),
    key: keyMaterial(74, publicKey),
  });
  const nativeRefArtifact = transaction.putArtifact({
    scopeKind: "runtime",
    scopeId: plan.runtimeId,
    artifactSchemaId: NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
    artifactDigest: plan.nativeRefEvidence.canonicalDigest,
    artifactBytes: plan.nativeRefEvidence.canonicalBytes,
  });
  const local = transaction.runtimeOwner.appendLocalConversationTransition({
    fence,
    operation: ownerOperation("root-local-discover", 75),
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    localTransitionId: parseA1SafeId("root-local-transition-1"),
    kind: "discover",
    sourceLocalNativeConversationId: null,
    target: {
      localNativeConversationId: parseA1SafeId("root-local-conversation-1"),
      descriptor: plan.descriptor,
      projectId: reservation.project.projectId,
      semanticConversationId: plan.semanticConversationId,
      parentLocalNativeConversationId: null,
      state: "open",
    },
    observedSemanticConversationId: plan.semanticConversationId,
    nativeEvidenceSchemaId: NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
    nativeEvidenceRef: nativeRefArtifact.artifactRef.protectedHandleId,
    nativeEvidenceDigest: nativeRefArtifact.artifactDigest,
  });
  const prepared = transaction.runtimeOwner.prepareBindingRuntime({
    fence,
    coordinatorFence,
    bindingOperation: ownerOperation("root-binding-prepare", 76),
    attachmentOperation: ownerOperation("root-attachment-acquire", 77),
    nativeBindingIncarnationId: parseA1SafeId("root-binding-incarnation-1"),
    collaborationServerId: serverId,
    logicalChatId: reservation.chat.logicalChatId,
    nativeBindingId: reservation.binding.nativeBindingId,
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    semanticConversationId:
      local.conversation.semanticConversationId ??
      parseA1SafeId("root-unreachable-semantic-conversation"),
    attachmentId: parseA1SafeId("root-attachment-1"),
    attachmentKind: "app-server",
    transportId: parseA1SafeId("root-transport-1"),
    attachmentGeneration: 1,
    attachmentLeaseId: parseA1SafeId("root-attachment-lease-1"),
    transportEpoch: 1,
    resourceOwnership: "shared_runtime",
    phase: "starting",
    disconnectPolicy: "detach",
  });
  const nativeConversationLeaseId = canonicalId("nativeConversationLease", 78);
  const openRequest = registrationRequest("open", "root-registration-open", {
    fence,
    coordinatorFence,
    nativeConversationLeaseId,
    registrationAttemptId: plan.registrationAttemptId,
    nativeBindingId: reservation.binding.nativeBindingId,
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    protectedPortHandleId: canonicalId("protectedHandle", 79),
  });
  transaction.registration.open(openRequest);
  transaction.registration.bind(
    registrationRequest("bind", "root-registration-bind", {
      fence,
      coordinatorFence,
      nativeConversationLeaseId,
      nativeBindingIncarnationId: prepared.bindingIncarnation.nativeBindingIncarnationId,
      attachmentLeaseId: prepared.attachmentLease.attachmentLeaseId,
    }),
  );
  const publicationMetadataArtifact = transaction.putArtifact({
    scopeKind: "native_binding",
    scopeId: reservation.binding.nativeBindingId,
    artifactSchemaId: NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
    artifactDigest: plan.metadataEvidence.canonicalDigest,
    artifactBytes: plan.metadataEvidence.canonicalBytes,
  });
  const publicationCapabilitiesArtifact = transaction.putArtifact({
    scopeKind: "native_binding",
    scopeId: reservation.binding.nativeBindingId,
    artifactSchemaId: NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
    artifactDigest: plan.capabilitiesEvidence.canonicalDigest,
    artifactBytes: plan.capabilitiesEvidence.canonicalBytes,
  });
  const publicationId = parseA1SafeId("root-publication-1");
  transaction.registration.publish(
    registrationRequest("publish", "root-registration-publish", {
      fence,
      coordinatorFence,
      nativeConversationLeaseId,
      nativeRegistrationPublicationId: publicationId,
      publicationGeneration: 1,
      metadataSchemaId: plan.metadataEvidence.value.metadataSchemaId,
      metadataRef: publicationMetadataArtifact.artifactRef.protectedHandleId,
      metadataDigest: publicationMetadataArtifact.artifactDigest,
      capabilitiesRef: publicationCapabilitiesArtifact.artifactRef.protectedHandleId,
      capabilitiesDigest: publicationCapabilitiesArtifact.artifactDigest,
    }),
  );
  const ready = transaction.registration.ready(
    registrationRequest("ready", "root-registration-ready", {
      fence,
      coordinatorFence,
      nativeConversationLeaseId,
      expectedGateGeneration: prepared.gate.gateGeneration,
      expectedPublicationId: publicationId,
    }),
  );
  return { coordinatorFence, reservation, runtime, prepared, openRequest, ready, publicationId };
}

async function createFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  const state = temporaryState();
  const keyPair = generateKeyPairSync("ed25519");
  const database = openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: state.environment,
  });
  openDatabases.push(database);
  const server = database.records.ensureDefaultCollaborationServer().server;
  const plan = await registrationPlan(server.collaborationServerId);
  const graph = database.transaction((transaction) =>
    createReadyRegistrationGraph(
      transaction,
      server.collaborationServerId,
      plan,
      publicKeyBytes(keyPair.publicKey),
    ),
  );
  return { state, database, server, plan, graph, privateKey: keyPair.privateKey };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function activationRequest(
  fixture: Fixture,
  operationId = "root-activate-1",
  ttlMs = ROOT_TTL_MS,
): PrepareNativeRootRequest {
  return {
    fence: fixture.graph.openRequest.fence,
    coordinatorFence: fixture.graph.coordinatorFence,
    operationId: parseA1SafeId(operationId),
    kind: "activate",
    nativeConversationLeaseId: fixture.graph.ready.lease.nativeConversationLeaseId,
    expectedPriorRootPathCertificateId: null,
    ttlMs,
  };
}

function renewalRequest(
  fixture: Fixture,
  priorRootPathCertificateId: ReturnType<typeof parseA1SafeId>,
  operationId: string,
): PrepareNativeRootRequest {
  return {
    ...activationRequest(fixture, operationId),
    kind: "renew",
    expectedPriorRootPathCertificateId: priorRootPathCertificateId,
  };
}

function signPreparation(
  preparation: ReturnType<HostStateDatabase["terminalRoot"]["prepare"]>,
  privateKey: KeyObject,
) {
  const payload = preparation.canonicalPayload.copyBytes();
  try {
    return parseEd25519Signature(base64urlEncode(sign(null, payload, privateKey)));
  } finally {
    payload.fill(0);
  }
}

function activateRoot(fixture: Fixture, request = activationRequest(fixture)) {
  const preparation = fixture.database.terminalRoot.prepare(request);
  const signature = signPreparation(preparation, fixture.privateKey);
  const activation = fixture.database.terminalRoot.finalize({
    fence: request.fence,
    coordinatorFence: request.coordinatorFence,
    operationId: request.operationId,
    signature,
  });
  return { request, preparation, signature, activation };
}

function reservationState(fixture: Fixture) {
  return fixture.database.records.readTerminalReservation(
    fixture.server.collaborationServerId,
    fixture.plan.registrationAttemptId,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Preserve the test's primary assertion failure.
    }
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.5 terminal-root SQLite repository", () => {
  it("activates exactly one root and atomically makes the edge and chat current", async () => {
    const fixture = await createFixture();
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "recovering" },
      edge: { state: "installing", rootPathCertificateId: null },
    });

    const activated = activateRoot(fixture);

    expect(activated.activation).toMatchObject({
      replayed: false,
      operation: { state: "committed" },
      storedCertificate: {
        activationOperationId: activated.request.operationId,
        certificate: {
          rootPathCertificateId: activated.preparation.operation.rootPathCertificateId,
          terminalServerId: fixture.server.collaborationServerId,
          terminalLogicalChatId: fixture.graph.reservation.chat.logicalChatId,
          terminalNativeBindingId: fixture.graph.reservation.binding.nativeBindingId,
        },
      },
    });
    expect(fixture.database.terminalRoot.readInventory()).toMatchObject({
      operations: [{ state: "committed" }],
      certificates: [{ activationOperationId: activated.request.operationId }],
    });
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "ready" },
      edge: {
        state: "current",
        rootPathCertificateId: activated.preparation.operation.rootPathCertificateId,
      },
    });
    expect(
      fixture.database.terminalRoot.readCurrentCertificate(
        fixture.server.collaborationServerId,
        fixture.graph.ready.lease.nativeConversationLeaseId,
      ),
    ).toEqual(activated.activation.storedCertificate);
  });

  it("keeps prepared native-root signing closed to public runtime-owner APIs across reopen", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture, "root-closed-signing-boundary");
    const preparation = fixture.database.terminalRoot.prepare(request);
    const signature = signPreparation(preparation, fixture.privateKey);
    const attackerDigest = digest(201);
    const signer = preparation.operation;

    vi.setSystemTime(NOW_MS + 5);
    expect(() =>
      fixture.database.runtimeOwner.storeSignedRecord({
        fence: request.fence,
        runtimeId: signer.runtimeId,
        runtimeOwnerIdentityKeyId: signer.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: signer.runtimeOwnerKeyGeneration,
        signerSequence: signer.signerSequence,
        signedRecordDigest: attackerDigest,
        signature,
        signedArtifactId: signer.rootPathCertificateId,
      }),
    ).toThrow(RuntimeOwnerRepositoryConflictError);
    expect(() =>
      fixture.database.runtimeOwner.acceptSignedRecord({
        fence: request.fence,
        runtimeId: signer.runtimeId,
        runtimeOwnerIdentityKeyId: signer.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: signer.runtimeOwnerKeyGeneration,
        signerSequence: signer.signerSequence,
        signedRecordDigest: attackerDigest,
      }),
    ).toThrow(RuntimeOwnerRepositoryConflictError);
    expect(() =>
      fixture.database.runtimeOwner.abortSignature({
        fence: request.fence,
        runtimeId: signer.runtimeId,
        runtimeOwnerIdentityKeyId: signer.runtimeOwnerIdentityKeyId,
        runtimeOwnerKeyGeneration: signer.runtimeOwnerKeyGeneration,
        signerSequence: signer.signerSequence,
      }),
    ).toThrow(/owned by its closed finalizer/);
    expect(fixture.database.runtimeOwner.readInventory()).toMatchObject({
      signatureReservations: [{ state: "bound", signedRecordDigest: null }],
      signedRecordAcceptances: [],
    });
    expect(fixture.database.terminalRoot.readOperation(request.operationId)).toMatchObject({
      state: "prepared",
      signedRecordDigest: null,
      committedAtMs: null,
    });

    fixture.database.close();
    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    vi.setSystemTime(NOW_MS + 10);
    const finalized = reopened.terminalRoot.finalize({
      fence: request.fence,
      coordinatorFence: request.coordinatorFence,
      operationId: request.operationId,
      signature,
    });

    expect(finalized).toMatchObject({
      replayed: false,
      operation: { state: "committed", committedAtMs: NOW_MS + 10 },
      storedCertificate: { committedAtMs: NOW_MS + 10 },
    });
    expect(reopened.runtimeOwner.readInventory().signedRecordAcceptances).toMatchObject([
      { acceptedAtMs: NOW_MS + 10 },
    ]);
  });

  it("replays exact prepare/finalize calls and rejects collisions without poisoning the handle", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture);
    const preparation = fixture.database.terminalRoot.prepare(request);
    const payload = preparation.canonicalPayload.copyBytes();
    const replay = fixture.database.terminalRoot.prepare(request);
    expect(replay.replayed).toBe(true);
    expect(replay.operation).toEqual(preparation.operation);
    expect(replay.canonicalPayload.copyBytes()).toEqual(payload);
    payload.fill(0);

    expect(() =>
      fixture.database.terminalRoot.prepare({ ...request, ttlMs: request.ttlMs + 1 }),
    ).toThrow(TerminalRootRepositoryConflictError);
    expect(fixture.database.terminalRoot.readInventory().operations).toHaveLength(1);

    const signature = signPreparation(preparation, fixture.privateKey);
    const finalized = fixture.database.terminalRoot.finalize({
      fence: request.fence,
      coordinatorFence: request.coordinatorFence,
      operationId: request.operationId,
      signature,
    });
    expect(
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      }),
    ).toEqual({ ...finalized, replayed: true });

    expect(() =>
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature: parseEd25519Signature(base64urlEncode(new Uint8Array(64).fill(99))),
      }),
    ).toThrow(TerminalRootRepositoryConflictError);
    expect(fixture.database.terminalRoot.readInventory()).toMatchObject({
      operations: [{ state: "committed" }],
      certificates: [{ activationOperationId: request.operationId }],
    });
  });

  it("rejects stale owner and coordinator fences before any root mutation", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture);
    expect(() =>
      fixture.database.terminalRoot.prepare({
        ...request,
        fence: { ...request.fence, runtimeOwnerServiceEpoch: 2 },
      }),
    ).toThrow(TerminalRootStaleOwnerError);
    expect(() =>
      fixture.database.terminalRoot.prepare({
        ...request,
        coordinatorFence: { ...request.coordinatorFence, coordinatorEpoch: 2 },
      }),
    ).toThrow(TerminalRootStaleCoordinatorError);
    expect(fixture.database.terminalRoot.readInventory()).toEqual({
      operations: [],
      certificates: [],
    });
  });

  it("classifies a cleared owner pointer as stale without mutating or poisoning state", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture, "root-released-owner");
    const before = fixture.database.terminalRoot.readInventory();
    fixture.database.runtimeOwner.releaseServiceLease({
      fence: request.fence,
      operation: ownerOperation("root-owner-release-before-prepare", 110),
    });

    expect(() => fixture.database.terminalRoot.prepare(request)).toThrow(
      TerminalRootStaleOwnerError,
    );
    expect(fixture.database.terminalRoot.readInventory()).toEqual(before);
    expect(
      fixture.database.transaction((transaction) => transaction.terminalRoot.readInventory()),
    ).toEqual(before);
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "recovering" },
      edge: { state: "installing", rootPathCertificateId: null },
    });

    fixture.database.close();
    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    expect(reopened.terminalRoot.readInventory()).toEqual(before);
    expect(
      reopened.records.readTerminalReservation(
        fixture.server.collaborationServerId,
        fixture.plan.registrationAttemptId,
      ),
    ).toMatchObject({ chat: { state: "recovering" }, edge: { state: "installing" } });
  });

  it("classifies a cleared coordinator pointer as stale and rolls finalization back", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture, "root-released-coordinator");
    const preparation = fixture.database.terminalRoot.prepare(request);
    const signature = signPreparation(preparation, fixture.privateKey);
    const before = fixture.database.terminalRoot.readInventory();
    fixture.database.records.releaseCoordinatorLease({ fence: request.coordinatorFence });

    expect(() =>
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      }),
    ).toThrow(TerminalRootStaleCoordinatorError);
    expect(fixture.database.terminalRoot.readInventory()).toEqual(before);
    expect(fixture.database.terminalRoot.reconcileOperation(request)).toMatchObject({
      operation: { state: "prepared" },
      storedCertificate: null,
    });
    expect(fixture.database.runtimeOwner.readInventory()).toMatchObject({
      signatureReservations: [{ purpose: "native_root", state: "bound" }],
      signedRecordAcceptances: [],
    });

    fixture.database.close();
    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    expect(reopened.terminalRoot.readInventory()).toEqual(before);
    expect(reopened.terminalRoot.reconcileOperation(request)).toMatchObject({
      operation: { state: "prepared" },
      storedCertificate: null,
    });
  });

  it("leaves a prepared operation unchanged when its TTL expires before finalization", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture, "root-expiry", 5);
    const preparation = fixture.database.terminalRoot.prepare(request);
    const signature = signPreparation(preparation, fixture.privateKey);
    vi.setSystemTime(NOW_MS + 5);

    expect(() =>
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      }),
    ).toThrow(/expired/);
    expect(fixture.database.terminalRoot.reconcileOperation(request)).toMatchObject({
      operation: { state: "prepared", signedRecordDigest: null, committedAtMs: null },
      storedCertificate: null,
    });
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "recovering" },
      edge: { state: "installing", rootPathCertificateId: null },
    });
  });

  it("rolls back a signed-record acceptance when the clock precedes certificate issuance", async () => {
    const fixture = await createFixture();
    fixture.database.close();
    let clockMs = NOW_MS + 10;
    const clockReadings: number[] = [];
    vi.spyOn(Date, "now").mockImplementation(() => clockReadings.shift() ?? clockMs);
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(database);
    const request = activationRequest(fixture, "root-clock-rollback");
    const preparation = database.terminalRoot.prepare(request);
    const signature = signPreparation(preparation, fixture.privateKey);
    const before = database.terminalRoot.readInventory();

    clockMs = NOW_MS + 11;
    clockReadings.push(NOW_MS + 11, NOW_MS + 11, NOW_MS + 5);
    let finalizationError: unknown;
    try {
      database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      });
    } catch (error) {
      finalizationError = error;
    }
    expect(finalizationError).toBeInstanceOf(TerminalRootRepositoryConflictError);
    expect((finalizationError as Error).message).toContain(
      "native-root signature acceptance is outside the certificate validity interval",
    );
    expect(database.terminalRoot.readInventory()).toEqual(before);
    expect(database.runtimeOwner.readInventory()).toMatchObject({
      signatureReservations: [{ purpose: "native_root", state: "bound", signedRecordDigest: null }],
      signedRecordAcceptances: [],
    });
    expect(database.transaction((transaction) => transaction.terminalRoot.readInventory())).toEqual(
      before,
    );

    database.close();
    vi.restoreAllMocks();
    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    expect(reopened.terminalRoot.readInventory()).toEqual(before);
    expect(reopened.terminalRoot.reconcileOperation(request)).toMatchObject({
      operation: { state: "prepared" },
      storedCertificate: null,
    });
    expect(reopened.runtimeOwner.readInventory().signedRecordAcceptances).toEqual([]);
  });

  it("rejects an invalid signature with zero finalization mutation and remains usable", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture, "root-invalid-signature");
    const preparation = fixture.database.terminalRoot.prepare(request);
    expect(() =>
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature: parseEd25519Signature(base64urlEncode(new Uint8Array(64).fill(33))),
      }),
    ).toThrow(TerminalRootRepositoryConflictError);
    expect(fixture.database.terminalRoot.reconcileOperation(request)).toMatchObject({
      operation: { state: "prepared" },
      storedCertificate: null,
    });
    expect(fixture.database.runtimeOwner.readInventory().signatureReservations).toMatchObject([
      { purpose: "native_root", state: "bound", signedRecordDigest: null },
    ]);

    const signature = signPreparation(preparation, fixture.privateKey);
    expect(
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      }),
    ).toMatchObject({ replayed: false, operation: { state: "committed" } });
  });

  it("rolls back preparation when its ledger INSERT statement fails", async () => {
    const fixture = await createFixture();
    const originalPrepare = DatabaseSync.prototype.prepare;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (armed && sql.includes("INSERT INTO native_root_activation_operations")) {
        throw new Error("simulated native-root preparation statement failure");
      }
      return Reflect.apply(originalPrepare, this, [sql]);
    });

    expect(() => fixture.database.terminalRoot.prepare(activationRequest(fixture))).toThrow(
      TerminalRootRepositoryPersistenceError,
    );
    armed = false;
    expect(() => fixture.database.terminalRoot.readInventory()).toThrow(/poisoned/);
    fixture.database.close();
    vi.restoreAllMocks();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    expect(reopened.terminalRoot.readInventory()).toEqual({ operations: [], certificates: [] });
    expect(reopened.runtimeOwner.readInventory().signatureReservations).toEqual([]);
    expect(reopened.runtimeOwner.readInventory().identityKeys).toMatchObject([
      { nextSignerSequence: 0 },
    ]);
  });

  it("rolls accepted signature evidence back when certificate finalization fails", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture, "root-finalize-fault");
    const preparation = fixture.database.terminalRoot.prepare(request);
    const signature = signPreparation(preparation, fixture.privateKey);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (armed && sql.includes("INSERT INTO native_root_certificates")) {
        throw new Error("simulated native-root certificate statement failure");
      }
      return Reflect.apply(originalPrepare, this, [sql]);
    });

    expect(() =>
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      }),
    ).toThrow(TerminalRootRepositoryPersistenceError);
    armed = false;
    fixture.database.close();
    vi.restoreAllMocks();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    expect(reopened.terminalRoot.reconcileOperation(request)).toMatchObject({
      operation: { state: "prepared" },
      storedCertificate: null,
    });
    expect(reopened.runtimeOwner.readInventory().signatureReservations).toMatchObject([
      { purpose: "native_root", state: "bound", signedRecordDigest: null },
    ]);
    expect(reservationState({ ...fixture, database: reopened })).toMatchObject({
      chat: { state: "recovering" },
      edge: { state: "installing", rootPathCertificateId: null },
    });
    expect(
      reopened.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      }),
    ).toMatchObject({ replayed: false, operation: { state: "committed" } });
  });

  it("reopens and reconciles finalization when its COMMIT acknowledgement is lost", async () => {
    const fixture = await createFixture();
    const request = activationRequest(fixture, "root-lost-commit");
    const preparation = fixture.database.terminalRoot.prepare(request);
    const signature = signPreparation(preparation, fixture.privateKey);
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      Reflect.apply(originalExec, this, [sql]);
      if (armed && sql === "COMMIT") {
        throw new Error("simulated lost native-root COMMIT acknowledgement");
      }
    });

    expect(() =>
      fixture.database.terminalRoot.finalize({
        fence: request.fence,
        coordinatorFence: request.coordinatorFence,
        operationId: request.operationId,
        signature,
      }),
    ).toThrow(HostStateCommitOutcomeUnknownError);
    armed = false;
    fixture.database.close();
    vi.restoreAllMocks();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    expect(reopened.terminalRoot.reconcileOperation(request)).toMatchObject({
      operation: { state: "committed" },
      storedCertificate: { activationOperationId: request.operationId },
    });
  });

  it("renews the current root as a strict linear successor", async () => {
    const fixture = await createFixture();
    const activated = activateRoot(fixture);
    vi.setSystemTime(NOW_MS + 1);
    const request = renewalRequest(
      fixture,
      activated.activation.storedCertificate.certificate.rootPathCertificateId,
      "root-renew-current",
    );
    const preparation = fixture.database.terminalRoot.prepare(request);
    const signature = signPreparation(preparation, fixture.privateKey);
    const renewed = fixture.database.terminalRoot.finalize({
      fence: request.fence,
      coordinatorFence: request.coordinatorFence,
      operationId: request.operationId,
      signature,
    });

    expect(renewed).toMatchObject({
      operation: {
        state: "committed",
        expectedPriorRootPathCertificateId:
          activated.activation.storedCertificate.certificate.rootPathCertificateId,
      },
    });
    expect(fixture.database.terminalRoot.readInventory()).toMatchObject({
      operations: [{ kind: "activate" }, { kind: "renew" }],
      certificates: [{}, {}],
    });
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "ready" },
      edge: {
        state: "current",
        rootPathCertificateId: renewed.storedCertificate.certificate.rootPathCertificateId,
      },
    });
  });

  it("retains a prepared losing renewal fork when its sibling commits later", async () => {
    const fixture = await createFixture();
    const activated = activateRoot(fixture);
    const predecessor = activated.activation.storedCertificate.certificate.rootPathCertificateId;
    vi.setSystemTime(NOW_MS + 1);
    const winnerRequest = renewalRequest(fixture, predecessor, "root-renew-fork-winner");
    const loserRequest = renewalRequest(fixture, predecessor, "root-renew-fork-loser");
    const winnerPreparation = fixture.database.terminalRoot.prepare(winnerRequest);
    fixture.database.terminalRoot.prepare(loserRequest);
    vi.setSystemTime(NOW_MS + 2);
    fixture.database.terminalRoot.finalize({
      fence: winnerRequest.fence,
      coordinatorFence: winnerRequest.coordinatorFence,
      operationId: winnerRequest.operationId,
      signature: signPreparation(winnerPreparation, fixture.privateKey),
    });

    expect(fixture.database.terminalRoot.readInventory()).toMatchObject({
      operations: [
        { kind: "activate", state: "committed" },
        { operationId: loserRequest.operationId, kind: "renew", state: "prepared" },
        { operationId: winnerRequest.operationId, kind: "renew", state: "committed" },
      ],
      certificates: [{}, {}],
    });
    fixture.database.close();
    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    openDatabases.push(reopened);
    expect(reopened.terminalRoot.reconcileOperation(loserRequest)).toMatchObject({
      operation: {
        expectedPriorRootPathCertificateId: predecessor,
        state: "prepared",
      },
      storedCertificate: null,
    });
    expect(reopened.terminalRoot.reconcileOperation(winnerRequest)).toMatchObject({
      operation: { state: "committed" },
      storedCertificate: { activationOperationId: winnerRequest.operationId },
    });
  });

  it("rejects a trigger-valid prepared renewal whose predecessor was not yet committed", async () => {
    const fixture = await createFixture();
    vi.setSystemTime(NOW_MS + 5);
    const activated = activateRoot(fixture);
    vi.setSystemTime(NOW_MS + 6);
    const request = renewalRequest(
      fixture,
      activated.activation.storedCertificate.certificate.rootPathCertificateId,
      "root-renew-corrupt-predecessor-time",
    );
    const preparation = fixture.database.terminalRoot.prepare(request);
    const operation = preparation.operation;
    const preparationInput = Object.fromEntries(
      Object.entries(operation).filter(
        ([key]) =>
          key !== "operationDigest" &&
          key !== "signedRecordDigest" &&
          key !== "committedAtMs" &&
          key !== "state",
      ),
    );
    const corruptPreparedAtMs = NOW_MS + 4;
    const corruptDigest = nativeRootActivationOperationDigest({
      ...preparationInput,
      preparedAtMs: corruptPreparedAtMs,
    } as unknown as NativeRootActivationPreparationInput);
    fixture.database.close();
    mutateWithoutTrigger(
      fixture.database.databasePath,
      "native_root_activation_operations_finalize_only",
      (editor) => {
        editor
          .prepare(
            `UPDATE native_root_activation_operations
                SET prepared_at_ms = ?, operation_digest = ?
              WHERE operation_id = ?`,
          )
          .run(corruptPreparedAtMs, corruptDigest, request.operationId);
      },
    );

    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: fixture.state.environment,
      }),
    ).toThrow(/terminal-root records failed semantic validation/);
  });

  it("renews only after a demoted registration is re-readied", async () => {
    const fixture = await createFixture();
    const activated = activateRoot(fixture);
    vi.setSystemTime(NOW_MS + 1);
    const recover = registrationRequest("recover", "root-registration-recover", {
      fence: fixture.graph.openRequest.fence,
      coordinatorFence: fixture.graph.coordinatorFence,
      nativeConversationLeaseId: fixture.graph.ready.lease.nativeConversationLeaseId,
      expectedGateGeneration: fixture.graph.prepared.gate.gateGeneration + 1,
    });
    fixture.database.registration.recover(recover);
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "recovering" },
      edge: { state: "installing", rootPathCertificateId: null },
    });

    const prematureRenewal = renewalRequest(
      fixture,
      activated.activation.storedCertificate.certificate.rootPathCertificateId,
      "root-renew-premature",
    );
    expect(() => fixture.database.terminalRoot.prepare(prematureRenewal)).toThrow(
      TerminalRootRepositoryConflictError,
    );
    fixture.database.registration.ready(
      registrationRequest("ready", "root-registration-reready", {
        fence: fixture.graph.openRequest.fence,
        coordinatorFence: fixture.graph.coordinatorFence,
        nativeConversationLeaseId: fixture.graph.ready.lease.nativeConversationLeaseId,
        expectedGateGeneration: fixture.graph.prepared.gate.gateGeneration + 2,
        expectedPublicationId: fixture.graph.publicationId,
      }),
    );
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "recovering" },
      edge: { state: "installing", rootPathCertificateId: null },
    });

    const request = renewalRequest(
      fixture,
      activated.activation.storedCertificate.certificate.rootPathCertificateId,
      "root-renew-demoted",
    );
    const preparation = fixture.database.terminalRoot.prepare(request);
    const renewed = fixture.database.terminalRoot.finalize({
      fence: request.fence,
      coordinatorFence: request.coordinatorFence,
      operationId: request.operationId,
      signature: signPreparation(preparation, fixture.privateKey),
    });
    expect(renewed.operation.state).toBe("committed");
    expect(reservationState(fixture)).toMatchObject({
      chat: { state: "ready" },
      edge: {
        state: "current",
        rootPathCertificateId: renewed.storedCertificate.certificate.rootPathCertificateId,
      },
    });
  });
});
