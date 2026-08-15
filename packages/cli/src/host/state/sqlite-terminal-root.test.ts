import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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
import {
  expectedHostStateMigrationDigest,
  expectedHostStateSqliteSchemaManifest,
  HOST_STATE_SCHEMA_VERSION,
} from "./migrations.js";
import { NATIVE_ROOT_CERTIFICATE_SCHEMA_ID } from "./native-root.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import type {
  AcquireRuntimeOwnerServiceLeaseRequest,
  RuntimeOwnerKeyMaterialInput,
  RuntimeOwnerOperationEvidence,
  RuntimeOwnerServiceFence,
} from "./runtime-repository.js";
import * as sqliteExports from "./sqlite.js";
import {
  createNativeRegistrationOperationEvidence,
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type HostStateTransaction,
  type NativeRegistrationOperationInputByKind,
  openHostStateDatabase,
  type PrepareNativeRootRequest,
  TerminalRootRepositoryPersistenceError,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "b5".repeat(16);
const NOW_MS = 500_000;
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

function operation(label: string, fill: number): RuntimeOwnerOperationEvidence {
  return {
    operationId: parseA1SafeId(`${label}-${fill}`),
    operationSchemaId: `remote-claw/test/${label}/v1`,
    operationDigest: digest(fill),
  };
}

function registrationRequest<K extends keyof NativeRegistrationOperationInputByKind>(
  kind: K,
  label: string,
  fill: number,
  input: NativeRegistrationOperationInputByKind[K],
): NativeRegistrationOperationInputByKind[K] & {
  readonly operation: RuntimeOwnerOperationEvidence;
} {
  return {
    ...input,
    operation: createNativeRegistrationOperationEvidence(
      kind,
      parseA1SafeId(`${label}-${fill}`),
      input,
    ),
  };
}

function ownerRequest(fill: number): AcquireRuntimeOwnerServiceLeaseRequest {
  return {
    candidateLeaseId: parseA1SafeId(`terminal-root-owner-lease-${fill}`),
    ownerInstanceId: parseA1SafeId(`terminal-root-owner-instance-${fill}`),
    ownerProcessStartIdentitySchemaId: "remote-claw/test/owner-process-start/v1",
    ownerProcessStartIdentityRef: parseA1SafeId(`terminal-root-owner-process-${fill}`),
    ownerProcessStartIdentityDigest: digest(fill),
    expectedCurrentLeaseId: null,
    expectedRuntimeOwnerServiceEpoch: 0,
    leaseDurationMs: 600_000,
    operation: operation("terminal-root-owner-acquire", fill + 1),
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

function keyMaterial(publicKey: KeyObject, fill: number): RuntimeOwnerKeyMaterialInput {
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("Ed25519 test key has no public coordinate");
  return {
    runtimeOwnerIdentityKeyId: parseA1SafeId(`terminal-root-runtime-key-${fill}`),
    publicKey: parseEd25519PublicKey(jwk.x),
    signingKeyRef: {
      protectedHandleId: canonicalId("protectedHandle", fill),
      kind: "signing_key",
    },
    localTrustEvidenceRef: parseA1SafeId(`terminal-root-local-trust-${fill}`),
    localTrustEvidenceDigest: digest(fill + 1),
    wrapNonce: ProtectedByteSnapshot.from(new Uint8Array(12).fill(fill)),
    wrappedPkcs8: ProtectedByteSnapshot.from(new Uint8Array(48).fill(fill)),
    authTag: ProtectedByteSnapshot.from(new Uint8Array(16).fill(fill)),
    pkcs8Digest: digest(fill + 2),
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a15-sqlite-terminal-root-"),
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

function downgradeFixture(databasePath: string, targetVersion: 5): void {
  const targetDigest = expectedHostStateMigrationDigest(targetVersion);
  const targetManifest = expectedHostStateSqliteSchemaManifest(targetVersion);
  const targetByName = new Map(targetManifest.map((entry) => [entry.name, entry]));
  const currentManifest = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION);
  const editor = new DatabaseSync(databasePath);
  try {
    editor.exec("PRAGMA foreign_keys=OFF");
    editor.exec("BEGIN IMMEDIATE");
    editor.exec("DROP TRIGGER host_state_migrations_no_delete");
    for (const type of ["trigger", "index", "table"] as const) {
      for (const entry of [...currentManifest].reverse()) {
        if (entry.type !== type || entry.name === "host_state_migrations_no_delete") continue;
        const target = targetByName.get(entry.name);
        if (target?.sql === entry.sql && target.type === entry.type) continue;
        editor.exec(`DROP ${type.toUpperCase()} "${entry.name}"`);
      }
    }
    const remaining = new Set(
      editor
        .prepare("SELECT name FROM sqlite_schema")
        .all()
        .map((row) => String(row.name)),
    );
    editor.prepare("DELETE FROM host_state_migrations WHERE schema_version > ?").run(targetVersion);
    editor
      .prepare(
        `UPDATE host_state_metadata
           SET schema_version = ?, migration_digest = ?
         WHERE singleton = 1`,
      )
      .run(targetVersion, targetDigest);
    for (const type of ["table", "index", "trigger"] as const) {
      for (const entry of targetManifest) {
        if (entry.type === type && !remaining.has(entry.name)) editor.exec(entry.sql);
      }
    }
    editor.exec(`PRAGMA user_version=${targetVersion}`);
    editor.exec("COMMIT");
  } catch (error) {
    try {
      editor.exec("ROLLBACK");
    } catch {
      // Preserve the fixture construction failure.
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
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

async function registrationPlan(
  collaborationServerId: A1CanonicalId<"collaborationServer">,
): Promise<RegistrationPlan> {
  const descriptor = { product: "codex", access: "app-server" } as const;
  const terminalTarget = {
    kind: "terminal_native",
    descriptor,
    terminalProjectRef: parseA1SafeId("terminal-root-project"),
    nativeWorkspaceBindingId: null,
  } as const;
  const targetDigest = await projectTargetDigest(terminalTarget);
  const workspaceSelectorId = parseA1SafeId("terminal-root-workspace-main");
  const wardenLaunchNonce = parseWardenLaunchNonce(base64urlEncode(new Uint8Array(32).fill(101)));
  const startIdentityDigest = digest(102);
  const runtimeId = await nativeRuntimeId({
    wardenLaunchNonce,
    startIdentitySchemaId: "remote-claw/test/native-process-start/v1",
    startIdentityDigest,
  });
  const semanticConversationId = parseA1SafeId("terminal-root-semantic-conversation");
  const keys = generateKeyPairSync("ed25519");
  return {
    descriptor,
    terminalTarget,
    targetDigest,
    workspaceSelectorId,
    registrationAttemptId: canonicalId("registrationAttempt", 100),
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
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  };
}

function createRegistrationGraph(
  transaction: HostStateTransaction,
  serverId: A1CanonicalId<"collaborationServer">,
  plan: RegistrationPlan,
) {
  const coordinator = transaction.records.acquireCoordinatorLease({
    collaborationServerId: serverId,
    candidateLeaseId: canonicalId("coordinatorLease", 103),
    ownerInstanceId: parseA1SafeId("terminal-root-coordinator-owner"),
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
    mappingEvidenceRef: parseA1SafeId("terminal-root-mapping-evidence"),
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
  const acquire = ownerRequest(104);
  const owner = transaction.runtimeOwner.acquireServiceLease(acquire);
  const fence = ownerFence(acquire, owner.lease.runtimeOwnerServiceEpoch);
  const runtime = transaction.runtimeOwner.registerInitialRuntime({
    fence,
    operation: operation("terminal-root-runtime-register", 105),
    runtimeId: plan.runtimeId,
    descriptor: plan.descriptor,
    wardenLaunchNonce: plan.wardenLaunchNonce,
    startIdentitySchemaId: "remote-claw/test/native-process-start/v1",
    startIdentityRef: parseA1SafeId("terminal-root-native-process-start"),
    startIdentityDigest: plan.startIdentityDigest,
    runtimeOwnerAssignmentId: parseA1SafeId("terminal-root-runtime-assignment-1"),
    key: keyMaterial(plan.publicKey, 106),
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
    operation: operation("terminal-root-local-discover", 107),
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    localTransitionId: parseA1SafeId("terminal-root-local-transition-1"),
    kind: "discover",
    sourceLocalNativeConversationId: null,
    target: {
      localNativeConversationId: parseA1SafeId("terminal-root-local-conversation-1"),
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
    bindingOperation: operation("terminal-root-binding-prepare", 108),
    attachmentOperation: operation("terminal-root-attachment-acquire", 109),
    nativeBindingIncarnationId: parseA1SafeId("terminal-root-binding-incarnation-1"),
    collaborationServerId: serverId,
    logicalChatId: reservation.chat.logicalChatId,
    nativeBindingId: reservation.binding.nativeBindingId,
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    semanticConversationId:
      local.conversation.semanticConversationId ?? parseA1SafeId("terminal-root-unreachable"),
    attachmentId: parseA1SafeId("terminal-root-attachment-1"),
    attachmentKind: "app-server",
    transportId: parseA1SafeId("terminal-root-transport-1"),
    attachmentGeneration: 1,
    attachmentLeaseId: parseA1SafeId("terminal-root-attachment-lease-1"),
    transportEpoch: 1,
    resourceOwnership: "shared_runtime",
    phase: "starting",
    disconnectPolicy: "detach",
  });
  const nativeConversationLeaseId = canonicalId("nativeConversationLease", 110);
  const opened = transaction.registration.open(
    registrationRequest("open", "terminal-root-open", 110, {
      fence,
      coordinatorFence,
      nativeConversationLeaseId,
      registrationAttemptId: plan.registrationAttemptId,
      nativeBindingId: reservation.binding.nativeBindingId,
      runtimeId: plan.runtimeId,
      nativeIncarnation: 1,
      protectedPortHandleId: canonicalId("protectedHandle", 111),
    }),
  );
  transaction.registration.bind(
    registrationRequest("bind", "terminal-root-bind", 112, {
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
  const publicationId = parseA1SafeId("terminal-root-publication-1");
  transaction.registration.publish(
    registrationRequest("publish", "terminal-root-publish", 113, {
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
    registrationRequest("ready", "terminal-root-ready", 114, {
      fence,
      coordinatorFence,
      nativeConversationLeaseId,
      expectedGateGeneration: prepared.gate.gateGeneration,
      expectedPublicationId: publicationId,
    }),
  );
  return { coordinatorFence, fence, reservation, runtime, prepared, opened, ready };
}

async function createReadyFixture() {
  const state = temporaryState();
  const database = openHostStateDatabase({
    machineIdentityId: MACHINE_IDENTITY_ID,
    pathEnvironment: state.environment,
  });
  const server = database.records.ensureDefaultCollaborationServer().server;
  const plan = await registrationPlan(server.collaborationServerId);
  const graph = database.transaction((transaction) =>
    createRegistrationGraph(transaction, server.collaborationServerId, plan),
  );
  const rootRequest: PrepareNativeRootRequest = {
    fence: graph.fence,
    coordinatorFence: graph.coordinatorFence,
    operationId: parseA1SafeId("terminal-root-activation-operation-1"),
    kind: "activate",
    nativeConversationLeaseId: graph.ready.lease.nativeConversationLeaseId,
    expectedPriorRootPathCertificateId: null,
    ttlMs: 300_000,
  };
  return { state, database, server, plan, graph, rootRequest };
}

function signPreparation(
  privateKey: KeyObject,
  preparation: ReturnType<HostStateDatabase["terminalRoot"]["prepare"]>,
) {
  const payload = preparation.canonicalPayload.copyBytes();
  try {
    return parseEd25519Signature(base64urlEncode(sign(null, payload, privateKey)));
  } finally {
    payload.fill(0);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.5 secure terminal-root SQLite integration", () => {
  it("adds only the closed terminal-root surface and keeps internals private", () => {
    expectTypeOf<keyof HostStateDatabase>().toEqualTypeOf<
      | "machineIdentityId"
      | "databasePath"
      | "schemaVersion"
      | "records"
      | "runtimeOwner"
      | "registration"
      | "terminalRoot"
      | "brokerRoute"
      | "ingress"
      | "serverSigning"
      | "commandAdjudication"
      | "putArtifact"
      | "readVerifiedArtifact"
      | "transaction"
      | "close"
    >();
    expectTypeOf<keyof HostStateTransaction>().toEqualTypeOf<
      | "records"
      | "runtimeOwner"
      | "registration"
      | "terminalRoot"
      | "brokerRoute"
      | "ingress"
      | "serverSigning"
      | "commandAdjudication"
      | "putArtifact"
      | "readVerifiedArtifact"
    >();
    expect(sqliteExports).not.toHaveProperty("createTerminalRootRepositoryOperations");
    expect(sqliteExports).not.toHaveProperty("createTerminalRootRepositoryTransactionOperations");
    expect(sqliteExports).not.toHaveProperty("validateTerminalRootRepositorySnapshot");
  });

  it("rolls root preparation, signer reservation, and payload artifact back together", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createReadyFixture();
    let attempted: ReturnType<HostStateDatabase["terminalRoot"]["prepare"]> | undefined;
    expect(() =>
      fixture.database.transaction((transaction) => {
        attempted = transaction.terminalRoot.prepare(fixture.rootRequest);
        throw new Error("abort terminal-root preparation");
      }),
    ).toThrow("abort terminal-root preparation");
    if (attempted === undefined) throw new Error("terminal-root preparation did not run");

    expect(fixture.database.terminalRoot.readInventory()).toEqual({
      operations: [],
      certificates: [],
    });
    expect(fixture.database.runtimeOwner.readInventory().signatureReservations).toEqual([]);
    await expect(
      fixture.database.readVerifiedArtifact({
        scopeKind: "native_binding",
        scopeId: fixture.graph.reservation.binding.nativeBindingId,
        artifactRef: {
          protectedHandleId: attempted.operation.canonicalPayloadRef,
          kind: "artifact",
        },
        artifactSchemaId: NATIVE_ROOT_CERTIFICATE_SCHEMA_ID,
        expectedArtifactDigest: attempted.operation.canonicalPayloadDigest,
      }),
    ).rejects.toThrow(/could not be verified/);
    fixture.database.close();
  });

  it("atomically activates a root and reopens its exact current inventory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createReadyFixture();
    const preparation = fixture.database.terminalRoot.prepare(fixture.rootRequest);
    const signature = signPreparation(fixture.plan.privateKey, preparation);
    const activated = fixture.database.terminalRoot.finalize({
      fence: fixture.rootRequest.fence,
      coordinatorFence: fixture.rootRequest.coordinatorFence,
      operationId: fixture.rootRequest.operationId,
      signature,
    });
    const inventory = fixture.database.terminalRoot.readInventory();
    expect(activated).toMatchObject({
      replayed: false,
      operation: { state: "committed", committedAtMs: NOW_MS },
      storedCertificate: {
        committedAtMs: NOW_MS,
        certificate: { signature, kind: "native-root" },
      },
    });
    expect(inventory).toEqual({
      operations: [activated.operation],
      certificates: [activated.storedCertificate],
    });
    expect(
      fixture.database.records.readTerminalReservation(
        fixture.server.collaborationServerId,
        fixture.plan.registrationAttemptId,
      ),
    ).toMatchObject({
      chat: { state: "ready" },
      edge: {
        state: "current",
        rootPathCertificateId: activated.storedCertificate.certificate.rootPathCertificateId,
      },
    });
    fixture.database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      expect(reopened.terminalRoot.readInventory()).toEqual(inventory);
      expect(
        reopened.terminalRoot.readCurrentCertificate(
          fixture.server.collaborationServerId,
          fixture.graph.ready.lease.nativeConversationLeaseId,
        ),
      ).toEqual(activated.storedCertificate);
    } finally {
      reopened.close();
    }
  });

  it("reopens and reconciles a prepared root whose COMMIT acknowledgement was lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createReadyFixture();
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      Reflect.apply(originalExec, this, [sql]);
      if (armed && sql === "COMMIT") {
        throw new Error("simulated lost terminal-root COMMIT acknowledgement");
      }
    });

    expect(() => fixture.database.terminalRoot.prepare(fixture.rootRequest)).toThrow(
      HostStateCommitOutcomeUnknownError,
    );
    armed = false;
    expect(() => fixture.database.terminalRoot.readInventory()).toThrow(/poisoned/);
    fixture.database.close();
    vi.restoreAllMocks();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      const reconciled = reopened.terminalRoot.reconcileOperation(fixture.rootRequest);
      expect(reconciled).toMatchObject({
        operation: { operationId: fixture.rootRequest.operationId, state: "prepared" },
        storedCertificate: null,
      });
      expect(reopened.terminalRoot.readInventory()).toMatchObject({
        operations: [{ operationId: fixture.rootRequest.operationId }],
        certificates: [],
      });
    } finally {
      reopened.close();
    }
  });

  it("poisons the handle after terminal-root persistence failure", () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const originalPrepare = DatabaseSync.prototype.prepare;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (armed && sql.includes("FROM native_root_activation_operations")) {
        throw new Error("simulated terminal-root read failure");
      }
      return Reflect.apply(originalPrepare, this, [sql]);
    });

    expect(() => database.terminalRoot.readInventory()).toThrow(
      TerminalRootRepositoryPersistenceError,
    );
    armed = false;
    expect(() => database.terminalRoot.readInventory()).toThrow(/poisoned/);
    database.close();
  });

  it("migrates a dormant v5 ready graph without fabricating root history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createReadyFixture();
    fixture.database.close();
    downgradeFixture(fixture.state.paths.databasePath, 5);

    const migrated = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      expect(migrated.schemaVersion).toBe(10);
      expect(migrated.terminalRoot.readInventory()).toEqual({
        operations: [],
        certificates: [],
      });
      expect(
        migrated.registration.readLease(fixture.graph.ready.lease.nativeConversationLeaseId),
      ).toMatchObject({ state: "ready" });
      expect(
        migrated.records.readTerminalReservation(
          fixture.server.collaborationServerId,
          fixture.plan.registrationAttemptId,
        ),
      ).toMatchObject({ chat: { state: "recovering" }, edge: { state: "installing" } });
    } finally {
      migrated.close();
    }
  });

  it("refuses a trigger-valid schema with a semantically corrupt root operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createReadyFixture();
    const preparation = fixture.database.terminalRoot.prepare(fixture.rootRequest);
    fixture.database.terminalRoot.finalize({
      fence: fixture.rootRequest.fence,
      coordinatorFence: fixture.rootRequest.coordinatorFence,
      operationId: fixture.rootRequest.operationId,
      signature: signPreparation(fixture.plan.privateKey, preparation),
    });
    fixture.database.close();

    const trigger = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION).find(
      (entry) => entry.name === "native_root_activation_operations_finalize_only",
    );
    if (trigger === undefined) throw new Error("missing native-root finalization trigger");
    const editor = new DatabaseSync(fixture.state.paths.databasePath);
    try {
      editor.exec("DROP TRIGGER native_root_activation_operations_finalize_only");
      editor
        .prepare(
          "UPDATE native_root_activation_operations SET operation_digest = ? WHERE operation_id = ?",
        )
        .run(digest(250), fixture.rootRequest.operationId);
      editor.exec(trigger.sql);
    } finally {
      editor.close();
    }

    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: fixture.state.environment,
      }),
    ).toThrow(/terminal-root records failed semantic validation/);
  });
});
