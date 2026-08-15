import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type A1CanonicalId,
  type A1CanonicalIdKind,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "./ids.js";
import { HOST_STATE_SQLITE_SCHEMA_MANIFEST } from "./migrations.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  HostStateCommitOutcomeUnknownError,
  HostStateRepositoryConflictError,
  openHostStateDatabase,
  type TerminalRegistrationInput,
} from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "73".repeat(16);
const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

function canonicalId<K extends A1CanonicalIdKind>(kind: K, fill: number): A1CanonicalId<K> {
  const spec = {
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
    `${spec[kind]}${base64urlEncode(new Uint8Array(byteLength).fill(fill))}`,
  );
}

function digest(fill: number) {
  return parseA1Digest(base64urlEncode(new Uint8Array(32).fill(fill)));
}

function registration(fill: number): TerminalRegistrationInput {
  return {
    registrationAttemptId: canonicalId("registrationAttempt", fill),
    descriptor: { product: "claude-code", access: "native-rc" },
    descriptorRef: parseA1SafeId(`descriptor-${fill}`),
    descriptorDigest: digest(fill + 1),
    projectRef: parseA1SafeId(`project-${fill}`),
    projectDigest: digest(fill + 2),
    expectedNativeRefDigest: null,
    initialPhase: "starting",
    metadataSchemaId: "remote-claw/sqlite-repository-test/v1",
    metadataRef: parseA1SafeId(`metadata-${fill}`),
    metadataDigest: digest(fill + 3),
    capabilitiesRef: null,
    capabilitiesDigest: null,
  };
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a12-repository-"),
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

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.2 secure durable-record repository", () => {
  it("reopens mapping generations and terminal reservations for exact reconciliation", () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const bootstrap = database.records.ensureDefaultCollaborationServer();
    const acquisition = database.records.acquireCoordinatorLease({
      collaborationServerId: bootstrap.server.collaborationServerId,
      candidateLeaseId: canonicalId("coordinatorLease", 10),
      ownerInstanceId: parseA1SafeId("coordinator-owner-1"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 600_000,
    });
    const fence = {
      collaborationServerId: bootstrap.server.collaborationServerId,
      coordinatorLeaseId: acquisition.lease.coordinatorLeaseId,
      coordinatorEpoch: acquisition.lease.coordinatorEpoch,
    };
    const firstRequest = {
      fence,
      workspaceSelectorId: parseA1SafeId("workspace-main"),
      terminalTarget: {
        kind: "terminal_native" as const,
        descriptor: { product: "claude-code" as const, access: "native-rc" as const },
        terminalProjectRef: parseA1SafeId("terminal-project-main"),
        nativeWorkspaceBindingId: null,
      },
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-main"),
      registration: registration(20),
    };
    const first = database.records.reserveFirstTerminalChat(firstRequest);
    expect(database.records.reserveFirstTerminalChat(firstRequest)).toEqual({
      ...first,
      replayed: true,
    });
    expect(() =>
      database.records.reserveFirstTerminalChat({
        ...firstRequest,
        mappingEvidenceRef: parseA1SafeId("changed-evidence"),
      }),
    ).toThrow(HostStateRepositoryConflictError);

    const replacementRequest = {
      fence,
      expectedMapping: {
        projectId: first.project.projectId,
        workspaceSelectorId: first.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: first.mapping.projectTargetSelectorMappingId,
        mappingGeneration: first.mapping.mappingGeneration,
        targetDigest: first.mapping.targetDigest,
      },
      terminalTarget: {
        kind: "terminal_native" as const,
        descriptor: { product: "claude-code" as const, access: "native-rc" as const },
        terminalProjectRef: parseA1SafeId("terminal-project-generation-2"),
        nativeWorkspaceBindingId: null,
      },
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-generation-2"),
    };
    const replacement = database.records.replaceProjectTargetMapping(replacementRequest);
    expect(replacement).toMatchObject({
      previousMapping: { mappingGeneration: 1, state: "superseded" },
      mapping: { mappingGeneration: 2, state: "current" },
      journalEntry: { entryKind: "project_target_mapping_replaced" },
      replayed: false,
    });
    expect(database.records.replaceProjectTargetMapping(replacementRequest)).toEqual({
      ...replacement,
      replayed: true,
    });
    expect(() =>
      database.records.replaceProjectTargetMapping({
        ...replacementRequest,
        mappingEvidenceRef: parseA1SafeId("mapping-evidence-generation-2-collision"),
      }),
    ).toThrow(HostStateRepositoryConflictError);
    expect(
      database.records.reconcileProjectTargetMappingReplacement({
        ...replacementRequest,
        mappingEvidenceRef: parseA1SafeId("mapping-evidence-generation-2-collision"),
      }),
    ).toEqual({ status: "collision", replacement: null });

    const second = database.records.reserveAdditionalTerminalChat({
      fence,
      mappingFence: {
        projectId: replacement.project.projectId,
        workspaceSelectorId: replacement.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: replacement.mapping.projectTargetSelectorMappingId,
        mappingGeneration: replacement.mapping.mappingGeneration,
        targetDigest: replacement.mapping.targetDigest,
      },
      parentChatId: first.chat.logicalChatId,
      registration: registration(30),
    });
    expect(second.chat.logicalChatId).not.toBe(first.chat.logicalChatId);
    expect(second.chat.projectTargetSelectorMappingId).toBe(
      replacement.mapping.projectTargetSelectorMappingId,
    );
    expect(first.chat.projectTargetSelectorMappingId).toBe(
      first.mapping.projectTargetSelectorMappingId,
    );

    const laterReplacementRequest = {
      fence,
      expectedMapping: {
        projectId: replacement.project.projectId,
        workspaceSelectorId: replacement.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: replacement.mapping.projectTargetSelectorMappingId,
        mappingGeneration: replacement.mapping.mappingGeneration,
        targetDigest: replacement.mapping.targetDigest,
      },
      terminalTarget: {
        kind: "terminal_native" as const,
        descriptor: { product: "claude-code" as const, access: "native-rc" as const },
        terminalProjectRef: parseA1SafeId("terminal-project-generation-3"),
        nativeWorkspaceBindingId: null,
      },
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-generation-3"),
    };
    const laterReplacement = database.records.replaceProjectTargetMapping(laterReplacementRequest);
    const mappingChain = database.records.listProjectTargetMappings(
      bootstrap.server.collaborationServerId,
      first.project.projectId,
      first.mapping.workspaceSelectorId,
    );
    expect(mappingChain).toEqual([
      { ...first.mapping, state: "superseded" },
      { ...replacement.mapping, state: "superseded" },
      laterReplacement.mapping,
    ]);
    expect(
      database.records.readCurrentProjectTargetMapping(
        bootstrap.server.collaborationServerId,
        first.project.projectId,
        first.mapping.workspaceSelectorId,
      ),
    ).toEqual(laterReplacement.mapping);

    const neverAppliedReplacementRequest = {
      fence,
      expectedMapping: {
        projectId: laterReplacement.project.projectId,
        workspaceSelectorId: laterReplacement.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: laterReplacement.mapping.projectTargetSelectorMappingId,
        mappingGeneration: laterReplacement.mapping.mappingGeneration,
        targetDigest: laterReplacement.mapping.targetDigest,
      },
      terminalTarget: {
        kind: "terminal_native" as const,
        descriptor: { product: "claude-code" as const, access: "native-rc" as const },
        terminalProjectRef: parseA1SafeId("terminal-project-never-applied"),
        nativeWorkspaceBindingId: null,
      },
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-never-applied"),
    };
    expect(
      database.records.reconcileProjectTargetMappingReplacement(neverAppliedReplacementRequest),
    ).toEqual({ status: "not_applied", replacement: null });
    expect(
      database.records.listLogicalChats(
        bootstrap.server.collaborationServerId,
        first.project.projectId,
      ),
    ).toHaveLength(2);
    expect(
      database.records.listTerminalReservations(bootstrap.server.collaborationServerId),
    ).toHaveLength(2);
    expect(
      database.records.listTerminalReservations(
        bootstrap.server.collaborationServerId,
        first.project.projectId,
      ),
    ).toHaveLength(2);

    const released = database.records.releaseCoordinatorLease({ fence });
    expect(
      database.records.reconcileCoordinatorRelease(
        bootstrap.server.collaborationServerId,
        released.lease.coordinatorLeaseId,
      )?.status,
    ).toBe("released");
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      expect(reopened.records.reconcileProjectTargetMappingReplacement(replacementRequest)).toEqual(
        {
          status: "applied",
          replacement: {
            ...replacement,
            mapping: { ...replacement.mapping, state: "superseded" },
            replayed: true,
          },
        },
      );
      expect(
        reopened.records.reconcileProjectTargetMappingReplacement(neverAppliedReplacementRequest),
      ).toEqual({ status: "not_applied", replacement: null });
      expect(
        reopened.records.listProjectTargetMappings(
          bootstrap.server.collaborationServerId,
          first.project.projectId,
          first.mapping.workspaceSelectorId,
        ),
      ).toEqual(mappingChain);
      expect(
        reopened.records.readCurrentProjectTargetMapping(
          bootstrap.server.collaborationServerId,
          first.project.projectId,
          first.mapping.workspaceSelectorId,
        ),
      ).toEqual(laterReplacement.mapping);

      const reservations = reopened.records.listTerminalReservations(
        bootstrap.server.collaborationServerId,
        first.project.projectId,
      );
      expect(reservations).toHaveLength(2);
      expect(
        reservations.map((reservation) => ({
          registrationAttemptId: reservation.registrationIntent.registrationAttemptId,
          mappingId: reservation.chat.projectTargetSelectorMappingId,
          mappingGeneration: reservation.mapping.mappingGeneration,
        })),
      ).toEqual([
        {
          registrationAttemptId: first.registrationIntent.registrationAttemptId,
          mappingId: first.mapping.projectTargetSelectorMappingId,
          mappingGeneration: 1,
        },
        {
          registrationAttemptId: second.registrationIntent.registrationAttemptId,
          mappingId: replacement.mapping.projectTargetSelectorMappingId,
          mappingGeneration: 2,
        },
      ]);
      expect(
        reopened.records.readTerminalReservation(
          bootstrap.server.collaborationServerId,
          firstRequest.registration.registrationAttemptId,
        ),
      ).toMatchObject({
        mapping: {
          projectTargetSelectorMappingId: first.mapping.projectTargetSelectorMappingId,
          mappingGeneration: 1,
          state: "superseded",
        },
        replayed: true,
      });
      expect(
        reopened.records.readTerminalReservation(
          bootstrap.server.collaborationServerId,
          second.registrationIntent.registrationAttemptId,
        ),
      ).toMatchObject({
        mapping: {
          projectTargetSelectorMappingId: replacement.mapping.projectTargetSelectorMappingId,
          mappingGeneration: 2,
          state: "superseded",
        },
        replayed: true,
      });
      expect(
        reopened.records.readCoordinatorLeaseAcquisition(
          bootstrap.server.collaborationServerId,
          acquisition.lease.coordinatorLeaseId,
        ),
      ).toMatchObject({ isCurrent: false, unexpired: false, replayed: true });
    } finally {
      reopened.close();
    }

    const editor = new DatabaseSync(state.paths.databasePath);
    try {
      const noUpdate = HOST_STATE_SQLITE_SCHEMA_MANIFEST.find(
        (entry) => entry.name === "native_registration_intents_no_update",
      );
      if (noUpdate === undefined) throw new Error("missing registration-intent guard");
      editor.exec("DROP TRIGGER native_registration_intents_no_update");
      editor
        .prepare(
          `UPDATE native_registration_intents
           SET canonical_intent_digest = ?
           WHERE registration_attempt_id = ?`,
        )
        .run(digest(99), firstRequest.registration.registrationAttemptId);
      editor.exec(noUpdate.sql);
    } finally {
      editor.close();
    }
    expect(() =>
      openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      }),
    ).toThrow(/semantic validation/);
  });

  it("reconciles a mapping replacement after an unknown COMMIT outcome", () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const bootstrap = database.records.ensureDefaultCollaborationServer();
    const acquisition = database.records.acquireCoordinatorLease({
      collaborationServerId: bootstrap.server.collaborationServerId,
      candidateLeaseId: canonicalId("coordinatorLease", 35),
      ownerInstanceId: parseA1SafeId("coordinator-owner-unknown-commit"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 600_000,
    });
    const fence = {
      collaborationServerId: bootstrap.server.collaborationServerId,
      coordinatorLeaseId: acquisition.lease.coordinatorLeaseId,
      coordinatorEpoch: acquisition.lease.coordinatorEpoch,
    };
    const first = database.records.reserveFirstTerminalChat({
      fence,
      workspaceSelectorId: parseA1SafeId("workspace-unknown-commit"),
      terminalTarget: {
        kind: "terminal_native",
        descriptor: { product: "claude-code", access: "native-rc" },
        terminalProjectRef: parseA1SafeId("terminal-project-unknown-commit"),
        nativeWorkspaceBindingId: null,
      },
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-unknown-commit"),
      registration: registration(36),
    });
    const replacementRequest = {
      fence,
      expectedMapping: {
        projectId: first.project.projectId,
        workspaceSelectorId: first.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: first.mapping.projectTargetSelectorMappingId,
        mappingGeneration: first.mapping.mappingGeneration,
        targetDigest: first.mapping.targetDigest,
      },
      terminalTarget: {
        kind: "terminal_native" as const,
        descriptor: { product: "claude-code" as const, access: "native-rc" as const },
        terminalProjectRef: parseA1SafeId("terminal-project-committed-before-error"),
        nativeWorkspaceBindingId: null,
      },
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-committed-before-error"),
    };

    const originalExec = DatabaseSync.prototype.exec;
    let armed = false;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      Reflect.apply(originalExec, this, [sql]);
      if (armed && sql === "COMMIT") {
        throw new Error("simulated lost COMMIT acknowledgement");
      }
    });
    armed = true;
    let failure: unknown;
    try {
      database.records.replaceProjectTargetMapping(replacementRequest);
    } catch (error) {
      failure = error;
    } finally {
      armed = false;
      exec.mockRestore();
    }
    expect(failure).toBeInstanceOf(HostStateCommitOutcomeUnknownError);
    expect(() => database.records.readDefaultCollaborationServer()).toThrow(/poisoned/);
    database.close();

    const reopened = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      expect(
        reopened.records.reconcileProjectTargetMappingReplacement(replacementRequest),
      ).toMatchObject({
        status: "applied",
        replacement: {
          previousMapping: { mappingGeneration: 1, state: "superseded" },
          mapping: { mappingGeneration: 2, state: "current" },
          replayed: true,
        },
      });
    } finally {
      reopened.close();
    }
  });

  it("commits or rolls back protected evidence and project allocation together", async () => {
    const state = temporaryState();
    const database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    try {
      const bootstrap = database.records.ensureDefaultCollaborationServer();
      const acquisition = database.records.acquireCoordinatorLease({
        collaborationServerId: bootstrap.server.collaborationServerId,
        candidateLeaseId: canonicalId("coordinatorLease", 40),
        ownerInstanceId: parseA1SafeId("coordinator-owner-2"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      const fence = {
        collaborationServerId: bootstrap.server.collaborationServerId,
        coordinatorLeaseId: acquisition.lease.coordinatorLeaseId,
        coordinatorEpoch: acquisition.lease.coordinatorEpoch,
      };
      database.records.reserveFirstTerminalChat({
        fence,
        workspaceSelectorId: parseA1SafeId("workspace-bootstrap"),
        terminalTarget: {
          kind: "terminal_native",
          descriptor: { product: "claude-code", access: "native-rc" },
          terminalProjectRef: parseA1SafeId("terminal-project-bootstrap"),
          nativeWorkspaceBindingId: null,
        },
        mappingEvidenceRef: parseA1SafeId("mapping-evidence-bootstrap"),
        registration: registration(50),
      });
      const bytes = Uint8Array.of(1, 2, 3, 4);
      const artifactDigest = parseA1Digest(createHash("sha256").update(bytes).digest("base64url"));
      const projectRequest = {
        fence,
        projectAllocationIntentId: parseA1SafeId("explicit-project-command-1"),
        workspaceSelectorId: parseA1SafeId("workspace-explicit"),
        terminalTarget: {
          kind: "terminal_native" as const,
          descriptor: { product: "codex" as const, access: "app-server" as const },
          terminalProjectRef: parseA1SafeId("terminal-project-explicit"),
          nativeWorkspaceBindingId: null,
        },
        mappingEvidenceRef: parseA1SafeId("mapping-evidence-explicit"),
      };
      let rolledBackHandle: string | undefined;
      expect(() =>
        database.transaction((transaction) => {
          rolledBackHandle = transaction.putArtifact({
            scopeKind: "host_profile",
            scopeId: "default",
            artifactSchemaId: "remote-claw/sqlite-repository-test/v1",
            artifactDigest,
            artifactBytes: ProtectedByteSnapshot.from(bytes),
          }).artifactRef.protectedHandleId;
          transaction.records.allocateExplicitProject(projectRequest);
          throw new Error("roll back combined state");
        }),
      ).toThrow(/roll back combined state/);
      expect(
        database.records.readProjectAllocation(
          bootstrap.server.collaborationServerId,
          projectRequest.projectAllocationIntentId,
        ),
      ).toBeNull();
      if (rolledBackHandle === undefined) throw new Error("missing rolled-back artifact handle");
      await expect(
        database.readVerifiedArtifact({
          artifactRef: {
            protectedHandleId: parseA1CanonicalId("protectedHandle", rolledBackHandle),
            kind: "artifact",
          },
          scopeKind: "host_profile",
          scopeId: "default",
          artifactSchemaId: "remote-claw/sqlite-repository-test/v1",
          expectedArtifactDigest: artifactDigest,
        }),
      ).rejects.toThrow(/could not be verified/);

      const committed = database.transaction((transaction) => ({
        artifact: transaction.putArtifact({
          scopeKind: "host_profile",
          scopeId: "default",
          artifactSchemaId: "remote-claw/sqlite-repository-test/v1",
          artifactDigest,
          artifactBytes: ProtectedByteSnapshot.from(bytes),
        }),
        project: transaction.records.allocateExplicitProject(projectRequest),
      }));
      expect(committed.project.project.projectAllocationIntentId).toBe(
        projectRequest.projectAllocationIntentId,
      );
      expect(
        await database.readVerifiedArtifact({
          artifactRef: committed.artifact.artifactRef,
          scopeKind: "host_profile",
          scopeId: "default",
          artifactSchemaId: "remote-claw/sqlite-repository-test/v1",
          expectedArtifactDigest: artifactDigest,
        }),
      ).toMatchObject({ artifactRef: committed.artifact.artifactRef });
    } finally {
      database.close();
    }
  });
});
