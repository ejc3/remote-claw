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
  parseWardenLaunchNonce,
} from "./ids.js";
import {
  expectedHostStateMigrationDigest,
  expectedHostStateSqliteSchemaManifest,
  HOST_STATE_SCHEMA_VERSION,
} from "./migrations.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import type {
  AcquireRuntimeOwnerServiceLeaseRequest,
  RuntimeOwnerKeyMaterialInput,
  RuntimeOwnerOperationEvidence,
  RuntimeOwnerServiceFence,
} from "./runtime-repository.js";
import {
  createNativeRegistrationOperationEvidence,
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type HostStateTransaction,
  type NativeRegistrationOperationInputByKind,
  NativeRegistrationRepositoryPersistenceError,
  openHostStateDatabase,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "a4".repeat(16);
const NOW_MS = 400_000;
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
    candidateLeaseId: parseA1SafeId(`registration-owner-lease-${fill}`),
    ownerInstanceId: parseA1SafeId(`registration-owner-instance-${fill}`),
    ownerProcessStartIdentitySchemaId: "remote-claw/test/owner-process-start/v1",
    ownerProcessStartIdentityRef: parseA1SafeId(`registration-owner-process-${fill}`),
    ownerProcessStartIdentityDigest: digest(fill),
    expectedCurrentLeaseId: null,
    expectedRuntimeOwnerServiceEpoch: 0,
    leaseDurationMs: 600_000,
    operation: operation("registration-owner-acquire", fill + 1),
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
    runtimeOwnerIdentityKeyId: parseA1SafeId(`registration-runtime-key-${fill}`),
    publicKey: parseEd25519PublicKey(base64urlEncode(new Uint8Array(32).fill(fill))),
    signingKeyRef: {
      protectedHandleId: canonicalId("protectedHandle", fill),
      kind: "signing_key",
    },
    localTrustEvidenceRef: parseA1SafeId(`registration-local-trust-${fill}`),
    localTrustEvidenceDigest: digest(fill + 1),
    wrapNonce: ProtectedByteSnapshot.from(new Uint8Array(12).fill(fill)),
    wrappedPkcs8: ProtectedByteSnapshot.from(new Uint8Array(48).fill(fill)),
    authTag: ProtectedByteSnapshot.from(new Uint8Array(16).fill(fill)),
    pkcs8Digest: digest(fill + 2),
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a14-sqlite-registration-"),
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

function downgradeFixture(databasePath: string, targetVersion: 4): void {
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
}

async function registrationPlan(
  collaborationServerId: A1CanonicalId<"collaborationServer">,
): Promise<RegistrationPlan> {
  const descriptor = { product: "codex", access: "app-server" } as const;
  const terminalTarget = {
    kind: "terminal_native",
    descriptor,
    terminalProjectRef: parseA1SafeId("registration-terminal-project"),
    nativeWorkspaceBindingId: null,
  } as const;
  const targetDigest = await projectTargetDigest(terminalTarget);
  const workspaceSelectorId = parseA1SafeId("registration-workspace-main");
  const wardenLaunchNonce = parseWardenLaunchNonce(base64urlEncode(new Uint8Array(32).fill(81)));
  const startIdentityDigest = digest(82);
  const runtimeId = await nativeRuntimeId({
    wardenLaunchNonce,
    startIdentitySchemaId: "remote-claw/test/native-process-start/v1",
    startIdentityDigest,
  });
  const semanticConversationId = parseA1SafeId("registration-semantic-conversation");
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
      metadataBytes: Uint8Array.of(1, 4, 0, 4),
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

function createRegistrationGraph(
  transaction: HostStateTransaction,
  serverId: A1CanonicalId<"collaborationServer">,
  plan: RegistrationPlan,
) {
  const coordinator = transaction.records.acquireCoordinatorLease({
    collaborationServerId: serverId,
    candidateLeaseId: canonicalId("coordinatorLease", 71),
    ownerInstanceId: parseA1SafeId("registration-coordinator-owner"),
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
    mappingEvidenceRef: parseA1SafeId("registration-mapping-evidence"),
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
  const acquire = ownerRequest(72);
  const owner = transaction.runtimeOwner.acquireServiceLease(acquire);
  const fence = ownerFence(acquire, owner.lease.runtimeOwnerServiceEpoch);
  const runtime = transaction.runtimeOwner.registerInitialRuntime({
    fence,
    operation: operation("registration-runtime-register", 73),
    runtimeId: plan.runtimeId,
    descriptor: plan.descriptor,
    wardenLaunchNonce: plan.wardenLaunchNonce,
    startIdentitySchemaId: "remote-claw/test/native-process-start/v1",
    startIdentityRef: parseA1SafeId("registration-native-process-start"),
    startIdentityDigest: plan.startIdentityDigest,
    runtimeOwnerAssignmentId: parseA1SafeId("registration-runtime-assignment-1"),
    key: keyMaterial(74),
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
    operation: operation("registration-local-discover", 75),
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    localTransitionId: parseA1SafeId("registration-local-transition-1"),
    kind: "discover",
    sourceLocalNativeConversationId: null,
    target: {
      localNativeConversationId: parseA1SafeId("registration-local-conversation-1"),
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
    bindingOperation: operation("registration-binding-prepare", 76),
    attachmentOperation: operation("registration-attachment-acquire", 77),
    nativeBindingIncarnationId: parseA1SafeId("registration-binding-incarnation-1"),
    collaborationServerId: serverId,
    logicalChatId: reservation.chat.logicalChatId,
    nativeBindingId: reservation.binding.nativeBindingId,
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    semanticConversationId:
      local.conversation.semanticConversationId ??
      parseA1SafeId("registration-unreachable-semantic-conversation"),
    attachmentId: parseA1SafeId("registration-attachment-1"),
    attachmentKind: "app-server",
    transportId: parseA1SafeId("registration-transport-1"),
    attachmentGeneration: 1,
    attachmentLeaseId: parseA1SafeId("registration-attachment-lease-1"),
    transportEpoch: 1,
    resourceOwnership: "shared_runtime",
    phase: "starting",
    disconnectPolicy: "detach",
  });
  const leaseId = canonicalId("nativeConversationLease", 78);
  const openRequest = registrationRequest("open", "registration-open", 78, {
    fence,
    coordinatorFence,
    nativeConversationLeaseId: leaseId,
    registrationAttemptId: plan.registrationAttemptId,
    nativeBindingId: reservation.binding.nativeBindingId,
    runtimeId: plan.runtimeId,
    nativeIncarnation: 1,
    protectedPortHandleId: canonicalId("protectedHandle", 79),
  });
  const opened = transaction.registration.open(openRequest);
  const bound = transaction.registration.bind(
    registrationRequest("bind", "registration-bind", 80, {
      fence,
      coordinatorFence,
      nativeConversationLeaseId: leaseId,
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
  const publicationId = parseA1SafeId("registration-publication-1");
  const published = transaction.registration.publish(
    registrationRequest("publish", "registration-publish", 81, {
      fence,
      coordinatorFence,
      nativeConversationLeaseId: leaseId,
      nativeRegistrationPublicationId: publicationId,
      publicationGeneration: 1,
      metadataSchemaId: plan.metadataEvidence.value.metadataSchemaId,
      metadataRef: publicationMetadataArtifact.artifactRef.protectedHandleId,
      metadataDigest: publicationMetadataArtifact.artifactDigest,
      capabilitiesRef: publicationCapabilitiesArtifact.artifactRef.protectedHandleId,
      capabilitiesDigest: publicationCapabilitiesArtifact.artifactDigest,
    }),
  );
  const readyRequest = registrationRequest("ready", "registration-ready", 82, {
    fence,
    coordinatorFence,
    nativeConversationLeaseId: leaseId,
    expectedGateGeneration: prepared.gate.gateGeneration,
    expectedPublicationId: publicationId,
  });
  const ready = transaction.registration.ready(readyRequest);
  return {
    coordinatorFence,
    descriptorArtifact,
    reservation,
    runtime,
    prepared,
    openRequest,
    opened,
    bound,
    published,
    readyRequest,
    ready,
  };
}

async function createActivatedFixture() {
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
  return { state, database, server, plan, graph };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.4 secure durable-registration SQLite integration", () => {
  it("adds only the closed high-level registration surface", () => {
    expectTypeOf<keyof HostStateDatabase>().toEqualTypeOf<
      | "machineIdentityId"
      | "databasePath"
      | "schemaVersion"
      | "records"
      | "runtimeOwner"
      | "registration"
      | "putArtifact"
      | "readVerifiedArtifact"
      | "transaction"
      | "close"
    >();
    expectTypeOf<keyof HostStateTransaction>().toEqualTypeOf<
      "records" | "runtimeOwner" | "registration" | "putArtifact" | "readVerifiedArtifact"
    >();
  });

  it("rolls artifacts, records, runtime ownership, and registration back together", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const server = database.records.ensureDefaultCollaborationServer().server;
    const plan = await registrationPlan(server.collaborationServerId);
    let attempted: ReturnType<typeof createRegistrationGraph> | undefined;
    expect(() =>
      database.transaction((transaction) => {
        attempted = createRegistrationGraph(transaction, server.collaborationServerId, plan);
        throw new Error("abort the composed registration transaction");
      }),
    ).toThrow("abort the composed registration transaction");
    if (attempted === undefined) throw new Error("registration fixture did not run");

    expect(database.records.listTerminalReservations(server.collaborationServerId)).toEqual([]);
    expect(database.runtimeOwner.readInventory()).toMatchObject({
      state: {
        currentRuntimeOwnerServiceEpoch: 0,
        currentRuntimeOwnerServiceLeaseId: null,
        nextJournalOffset: 0,
      },
      runtimes: [],
      bindingIncarnations: [],
    });
    expect(database.registration.readInventory()).toEqual({
      leases: [],
      publications: [],
      operations: [],
    });
    await expect(
      database.readVerifiedArtifact({
        scopeKind: "collaboration_server",
        scopeId: server.collaborationServerId,
        artifactRef: attempted.descriptorArtifact.artifactRef,
        artifactSchemaId: attempted.descriptorArtifact.artifactSchemaId,
        expectedArtifactDigest: attempted.descriptorArtifact.artifactDigest,
      }),
    ).rejects.toThrow(/could not be verified/);
    database.close();
  });

  it("reopens the exact activated inventory and reconciles operation replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createActivatedFixture();
    const inventory = fixture.database.registration.readInventory();
    expect(inventory).toMatchObject({
      leases: [
        {
          nativeConversationLeaseId: fixture.graph.ready.lease.nativeConversationLeaseId,
          state: "ready",
          leaseGeneration: 1,
          nextOperationSequence: 5,
        },
      ],
      publications: [{ state: "current", publicationGeneration: 1 }],
      operations: [
        { kind: "open", operationSequence: 1 },
        { kind: "bind", operationSequence: 2 },
        { kind: "publish", operationSequence: 3 },
        { kind: "ready", operationSequence: 4 },
      ],
    });
    fixture.database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      expect(reopened.registration.readInventory()).toEqual(inventory);
      expect(reopened.registration.ready(fixture.graph.readyRequest)).toEqual({
        ...fixture.graph.ready,
        replayed: true,
      });
      expect(
        reopened.records.readTerminalReservation(
          fixture.server.collaborationServerId,
          fixture.plan.registrationAttemptId,
        ),
      ).toMatchObject({
        binding: {
          nativeBindingId: fixture.graph.reservation.binding.nativeBindingId,
          state: "current",
          semanticConversationId: fixture.plan.semanticConversationId,
        },
      });
    } finally {
      reopened.close();
    }
  });

  it("reopens and reconciles a registration mutation whose COMMIT acknowledgement was lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createActivatedFixture();
    const drainRequest = registrationRequest("drain", "registration-drain", 83, {
      fence: fixture.graph.openRequest.fence,
      coordinatorFence: fixture.graph.coordinatorFence,
      nativeConversationLeaseId: fixture.graph.ready.lease.nativeConversationLeaseId,
      expectedGateGeneration: fixture.graph.prepared.gate.gateGeneration + 1,
    });
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      Reflect.apply(originalExec, this, [sql]);
      if (armed && sql === "COMMIT") {
        throw new Error("simulated lost registration COMMIT acknowledgement");
      }
    });

    expect(() => fixture.database.registration.drain(drainRequest)).toThrow(
      HostStateCommitOutcomeUnknownError,
    );
    armed = false;
    expect(() => fixture.database.registration.readInventory()).toThrow(/poisoned/);
    fixture.database.close();
    vi.restoreAllMocks();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: fixture.state.environment,
    });
    try {
      const reconciled = reopened.registration.drain(drainRequest);
      expect(reconciled).toMatchObject({
        replayed: true,
        lease: { state: "draining" },
        operation: { kind: "drain", operationSequence: 5 },
      });
      expect(reopened.registration.readInventory().operations).toHaveLength(5);
    } finally {
      reopened.close();
    }
  });

  it("poisons the handle after a registration persistence failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createActivatedFixture();
    const originalPrepare = DatabaseSync.prototype.prepare;
    let armed = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (armed && sql.includes("FROM native_conversation_leases")) {
        throw new Error("simulated registration inventory read failure");
      }
      return Reflect.apply(originalPrepare, this, [sql]);
    });

    expect(() => fixture.database.registration.readInventory()).toThrow(
      NativeRegistrationRepositoryPersistenceError,
    );
    armed = false;
    expect(() => fixture.database.registration.readInventory()).toThrow(/poisoned/);
    fixture.database.close();
  });

  it("refuses a trigger-valid registration ledger with corrupt semantic ordering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const fixture = await createActivatedFixture();
    fixture.database.close();

    const trigger = expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION).find(
      (entry) => entry.name === "native_registration_operations_no_update",
    );
    if (trigger === undefined)
      throw new Error("missing registration operation immutability trigger");
    const editor = new DatabaseSync(fixture.state.paths.databasePath);
    try {
      editor.exec("DROP TRIGGER native_registration_operations_no_update");
      editor
        .prepare(
          `UPDATE native_registration_operations SET committed_at_ms = ?
           WHERE operation_id = ?`,
        )
        .run(NOW_MS - 1, fixture.graph.readyRequest.operation.operationId);
      editor.exec(trigger.sql);
    } finally {
      editor.close();
    }

    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: fixture.state.environment,
      }),
    ).toThrow(/native registration records failed semantic validation/);
  });

  it("migrates a dormant v4 graph but refuses an activated root without its v5 closure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const dormant = temporaryState();
    openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: dormant.environment,
    }).close();
    downgradeFixture(dormant.paths.databasePath, 4);
    const migrated = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: dormant.environment,
    });
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.registration.readInventory()).toEqual({
      leases: [],
      publications: [],
      operations: [],
    });
    migrated.close();

    const activated = await createActivatedFixture();
    activated.database.close();
    downgradeFixture(activated.state.paths.databasePath, 4);
    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: activated.state.environment,
      }),
    ).toThrow(/semantic validation/);
  });
});
