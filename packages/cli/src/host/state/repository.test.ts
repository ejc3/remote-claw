import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeRegistrationIntentDigest,
  projectAllocationIntentDigest,
  projectTargetDigest,
  projectTargetSelectorMappingId,
} from "./digests.js";
import { type A1CanonicalId, parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "./ids.js";
import { HOST_STATE_MIGRATIONS, HOST_STATE_SCHEMA_VERSION } from "./migrations.js";
import {
  HOST_STATE_REPOSITORY_MAX_ID_ATTEMPTS,
  type HostStateJournalEntry,
  HostStateRepository,
  HostStateRepositoryConflictError,
  HostStateRepositoryPersistenceError,
  type HostStateRepositorySqlTransaction,
  type HostStateRepositorySqlValue,
  type HostStateRepositoryTransactionExecutor,
  HostStateStaleCoordinatorError,
  parseHostStateActorScope,
  syncHostStateJournalEntryDigest,
  syncNativeRegistrationIntentDigest,
  syncProjectAllocationIntentDigest,
  syncProjectTargetDigest,
  syncProjectTargetSelectorMappingId,
  validateHostStateRepositorySnapshot,
} from "./repository.js";

const MACHINE_IDENTITY_ID = "0123456789abcdef".repeat(2);
const openDatabases: DatabaseSync[] = [];

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

function digest(fill: number) {
  return parseA1Digest(encoded(32, fill));
}

type TestCanonicalKind =
  | "collaborationServer"
  | "project"
  | "logicalChat"
  | "nativeBinding"
  | "inwardEdge"
  | "coordinatorLease"
  | "registrationAttempt";

function canonicalId<K extends TestCanonicalKind>(kind: K, fill: number): A1CanonicalId<K> {
  const prefixes = {
    collaborationServer: "rcs_",
    project: "rcpj_",
    logicalChat: "rcl_",
    nativeBinding: "rcnb_",
    inwardEdge: "rcie_",
    coordinatorLease: "rccl_",
    registrationAttempt: "rcra_",
  } as const;
  return parseA1CanonicalId(kind, `${prefixes[kind]}${encoded(16, fill)}`);
}

class SqlTransaction implements HostStateRepositorySqlTransaction {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  get(sql: string, parameters: readonly HostStateRepositorySqlValue[]): unknown {
    return this.#database.prepare(sql).get(...parameters);
  }

  all(sql: string, parameters: readonly HostStateRepositorySqlValue[]): readonly unknown[] {
    return this.#database.prepare(sql).all(...parameters);
  }

  run(sql: string, parameters: readonly HostStateRepositorySqlValue[]) {
    return this.#database.prepare(sql).run(...parameters);
  }
}

class JournalOffsetSwapTransaction implements HostStateRepositorySqlTransaction {
  readonly #transaction: HostStateRepositorySqlTransaction;
  readonly #leftSubjectId: string;
  readonly #rightSubjectId: string;

  constructor(
    transaction: HostStateRepositorySqlTransaction,
    leftSubjectId: string,
    rightSubjectId: string,
  ) {
    this.#transaction = transaction;
    this.#leftSubjectId = leftSubjectId;
    this.#rightSubjectId = rightSubjectId;
  }

  get(sql: string, parameters: readonly HostStateRepositorySqlValue[]): unknown {
    return this.#transaction.get(sql, parameters);
  }

  all(sql: string, parameters: readonly HostStateRepositorySqlValue[]): readonly unknown[] {
    const rows = this.#transaction.all?.(sql, parameters);
    if (rows === undefined) throw new Error("test transaction has no all method");
    if (!sql.includes("FROM control_journal_entries") || !sql.includes("ORDER BY")) return rows;
    const copies = rows.map((row) => ({ ...(row as Record<string, unknown>) }));
    const left = copies.find((row) => row.subject_id === this.#leftSubjectId);
    const right = copies.find((row) => row.subject_id === this.#rightSubjectId);
    if (left === undefined || right === undefined)
      throw new Error("test journal subject is missing");
    const leftOffset = left.journal_offset;
    left.journal_offset = right.journal_offset;
    right.journal_offset = leftOffset;
    for (const row of [left, right]) {
      const entry = {
        collaborationServerId: parseA1CanonicalId(
          "collaborationServer",
          row.collaboration_server_id,
        ),
        journalOffset: Number(row.journal_offset),
        scopeKind: row.scope_kind,
        logicalChatId:
          row.logical_chat_id === null
            ? null
            : parseA1CanonicalId("logicalChat", row.logical_chat_id),
        entryKind: row.entry_kind,
        subjectKind: row.subject_kind,
        subjectId: parseA1SafeId(row.subject_id),
        entrySchemaId: row.entry_schema_id,
        coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", row.coordinator_lease_id),
        coordinatorEpoch: Number(row.coordinator_epoch),
        committedAtMs: Number(row.committed_at_ms),
      } as Omit<HostStateJournalEntry, "entryDigest">;
      row.entry_digest = syncHostStateJournalEntryDigest(entry);
    }
    return copies;
  }

  run(sql: string, parameters: readonly HostStateRepositorySqlValue[]) {
    return this.#transaction.run(sql, parameters);
  }
}

class SqlExecutor implements HostStateRepositoryTransactionExecutor {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  transaction<T>(operation: (transaction: HostStateRepositorySqlTransaction) => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(new SqlTransaction(this.database));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  inspect<T>(operation: (transaction: HostStateRepositorySqlTransaction) => T): T {
    this.database.exec("BEGIN");
    try {
      const result = operation(new SqlTransaction(this.database));
      this.database.exec("ROLLBACK");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function openExecutor(path = ":memory:", initialize = true): SqlExecutor {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA recursive_triggers=ON");
  if (initialize) {
    for (const migration of HOST_STATE_MIGRATIONS) {
      for (const statement of migration.statements) database.exec(statement);
    }
    database
      .prepare(
        `INSERT INTO host_state_metadata
         (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
         VALUES (1, ?, ?, ?, 0)`,
      )
      .run(MACHINE_IDENTITY_ID, HOST_STATE_SCHEMA_VERSION, "A".repeat(43));
  }
  return new SqlExecutor(database);
}

function entropyCounter(start = 1): (byteLength: number) => Uint8Array {
  let fill = start;
  return (byteLength) => new Uint8Array(byteLength).fill(fill++);
}

function registration(fill: number) {
  return {
    registrationAttemptId: canonicalId("registrationAttempt", fill),
    descriptor: { product: "claude-code", access: "native-rc" } as const,
    descriptorRef: parseA1SafeId(`descriptor-${fill}`),
    descriptorDigest: digest(fill + 1),
    projectRef: parseA1SafeId(`project-${fill}`),
    projectDigest: digest(fill + 2),
    expectedNativeRefDigest: null,
    initialPhase: "starting" as const,
    metadataSchemaId: "remote-claw/test-metadata/v1",
    metadataRef: parseA1SafeId(`metadata-${fill}`),
    metadataDigest: digest(fill + 3),
    capabilitiesRef: null,
    capabilitiesDigest: null,
  };
}

const terminalTarget = {
  kind: "terminal_native" as const,
  descriptor: { product: "claude-code", access: "native-rc" } as const,
  terminalProjectRef: parseA1SafeId("terminal-project"),
  nativeWorkspaceBindingId: null,
};

afterEach(() => {
  while (openDatabases.length > 0) {
    try {
      openDatabases.pop()?.close();
    } catch {
      // A reopen test closes the first handle before opening its successor.
    }
  }
});

describe("host state repository canonical operations", () => {
  it("matches all landed asynchronous digest and derived-ID vectors", async () => {
    expect(syncProjectTargetDigest(terminalTarget)).toBe(await projectTargetDigest(terminalTarget));
    const mappingInput = {
      collaborationServerId: canonicalId("collaborationServer", 40),
      projectId: canonicalId("project", 41),
      workspaceSelectorId: parseA1SafeId("workspace-a"),
      mappingGeneration: 1,
      targetDigest: syncProjectTargetDigest(terminalTarget),
    };
    expect(syncProjectTargetSelectorMappingId(mappingInput)).toBe(
      await projectTargetSelectorMappingId(mappingInput),
    );
    const projectInput = {
      projectAllocationIntentSchemaId: "remote-claw/project-allocation-intent/v1" as const,
      projectAllocationIntentId: canonicalId("registrationAttempt", 42),
      collaborationServerId: mappingInput.collaborationServerId,
      projectId: mappingInput.projectId,
      allocationKind: "first_bootstrap" as const,
      initialWorkspaceSelectorId: mappingInput.workspaceSelectorId,
      initialTargetDigest: mappingInput.targetDigest,
    };
    expect(syncProjectAllocationIntentDigest(projectInput)).toBe(
      await projectAllocationIntentDigest(projectInput),
    );
    const registrationInput = {
      registrationAttemptId: projectInput.projectAllocationIntentId,
      collaborationServerId: mappingInput.collaborationServerId,
      nativeBindingId: canonicalId("nativeBinding", 43),
      canonicalIntentSchemaId: "remote-claw/native-registration-intent/v1" as const,
      descriptorRef: parseA1SafeId("descriptor-ref"),
      descriptorDigest: digest(44),
      projectRef: parseA1SafeId("project-ref"),
      projectDigest: digest(45),
      expectedNativeRefDigest: null,
      initialPhase: "starting" as const,
      metadataSchemaId: "remote-claw/test/v1",
      metadataRef: parseA1SafeId("metadata-ref"),
      metadataDigest: digest(46),
      capabilitiesRef: null,
      capabilitiesDigest: null,
    };
    expect(syncNativeRegistrationIntentDigest(registrationInput)).toBe(
      await nativeRegistrationIntentDigest(registrationInput),
    );
  });

  it("parses only closed server-control and chat actor scopes", () => {
    const serverId = canonicalId("collaborationServer", 47);
    const chatId = canonicalId("logicalChat", 48);
    expect(
      parseHostStateActorScope({
        collaborationServerId: serverId,
        scopeKind: "server_control",
        logicalChatId: null,
      }),
    ).toEqual({
      collaborationServerId: serverId,
      scopeKind: "server_control",
      logicalChatId: null,
    });
    expect(
      parseHostStateActorScope({
        collaborationServerId: serverId,
        scopeKind: "chat",
        logicalChatId: chatId,
      }),
    ).toEqual({ collaborationServerId: serverId, scopeKind: "chat", logicalChatId: chatId });
    expect(() =>
      parseHostStateActorScope({
        collaborationServerId: serverId,
        scopeKind: "server_control",
        logicalChatId: chatId,
      }),
    ).toThrow(/must be null/);
    expect(() =>
      parseHostStateActorScope({
        collaborationServerId: serverId,
        scopeKind: "chat",
        logicalChatId: null,
      }),
    ).toThrow(/must be present/);
  });

  it("bootstraps, replays, inventories, leases, releases, and takes over atomically", () => {
    const executor = openExecutor();
    let now = 100;
    const repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
      randomBytes: entropyCounter(1),
      nowMs: () => now,
    });
    const bootstrapped = repository.ensureDefaultCollaborationServer();
    expect(bootstrapped.created).toBe(true);
    expect(repository.ensureDefaultCollaborationServer()).toEqual({
      ...bootstrapped,
      created: false,
    });
    const serverId = bootstrapped.server.collaborationServerId;
    const lease1 = canonicalId("coordinatorLease", 60);
    const acquisition1 = repository.acquireCoordinatorLease({
      collaborationServerId: serverId,
      candidateLeaseId: lease1,
      ownerInstanceId: parseA1SafeId("coordinator-one"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 1_000,
    });
    expect(acquisition1).toMatchObject({ replayed: false, isCurrent: true, unexpired: true });
    expect(acquisition1.journalEntry.journalOffset).toBe(0);
    const fence1 = {
      collaborationServerId: serverId,
      coordinatorLeaseId: lease1,
      coordinatorEpoch: 1,
    } as const;

    now = 101;
    const firstRequest = {
      fence: fence1,
      workspaceSelectorId: parseA1SafeId("workspace-one"),
      terminalTarget,
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-one"),
      registration: registration(70),
    };
    const first = repository.reserveFirstTerminalChat(firstRequest);
    expect(first).toMatchObject({ replayed: false });
    expect(first.journalEntry.journalOffset).toBe(1);
    expect(first.chat).toMatchObject({
      state: "recovering",
      topologyGeneration: 1,
      currentNativeBindingId: first.binding.nativeBindingId,
      currentInwardEdgeId: first.edge.inwardEdgeId,
    });
    expect(repository.reserveFirstTerminalChat(firstRequest)).toEqual({ ...first, replayed: true });
    expect(() =>
      repository.reserveFirstTerminalChat({
        ...firstRequest,
        mappingEvidenceRef: parseA1SafeId("changed-evidence"),
      }),
    ).toThrow(HostStateRepositoryConflictError);
    expect(() =>
      repository.reserveAdditionalTerminalChat({
        fence: fence1,
        mappingFence: {
          projectId: first.project.projectId,
          workspaceSelectorId: first.mapping.workspaceSelectorId,
          projectTargetSelectorMappingId: first.mapping.projectTargetSelectorMappingId,
          mappingGeneration: first.mapping.mappingGeneration,
          targetDigest: first.mapping.targetDigest,
        },
        parentChatId: null,
        registration: firstRequest.registration,
      }),
    ).toThrow(HostStateRepositoryConflictError);

    now = 102;
    const explicit = repository.allocateExplicitProject({
      fence: fence1,
      projectAllocationIntentId: parseA1SafeId("management-command-one"),
      workspaceSelectorId: parseA1SafeId("workspace-two"),
      terminalTarget,
      mappingEvidenceRef: parseA1SafeId("mapping-evidence-two"),
    });
    expect(explicit.journalEntry.journalOffset).toBe(2);
    expect(
      repository.readProjectAllocation(serverId, parseA1SafeId("management-command-one")),
    ).toEqual({ ...explicit, replayed: true });

    now = 103;
    const beforeReplacement = repository.reserveAdditionalTerminalChat({
      fence: fence1,
      mappingFence: {
        projectId: explicit.project.projectId,
        workspaceSelectorId: explicit.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: explicit.mapping.projectTargetSelectorMappingId,
        mappingGeneration: explicit.mapping.mappingGeneration,
        targetDigest: explicit.mapping.targetDigest,
      },
      parentChatId: null,
      registration: registration(79),
    });
    expect(beforeReplacement.journalEntry.journalOffset).toBe(3);

    now = 104;
    const replacementTarget = {
      ...terminalTarget,
      terminalProjectRef: parseA1SafeId("terminal-project-replacement"),
    };
    const replacementRequest = {
      fence: fence1,
      expectedMapping: {
        projectId: explicit.project.projectId,
        workspaceSelectorId: explicit.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: explicit.mapping.projectTargetSelectorMappingId,
        mappingGeneration: explicit.mapping.mappingGeneration,
        targetDigest: explicit.mapping.targetDigest,
      },
      terminalTarget: replacementTarget,
      mappingEvidenceRef: parseA1SafeId("mapping-replacement-evidence"),
    };
    const replacement = repository.replaceProjectTargetMapping(replacementRequest);
    expect(replacement).toMatchObject({
      replayed: false,
      previousMapping: { state: "superseded" },
      mapping: { mappingGeneration: 2, state: "current" },
      journalEntry: { journalOffset: 4, entryKind: "project_target_mapping_replaced" },
    });
    expect(repository.replaceProjectTargetMapping(replacementRequest)).toEqual({
      ...replacement,
      replayed: true,
    });
    expect(
      repository.reconcileProjectTargetMappingReplacement({
        ...replacementRequest,
        mappingEvidenceRef: parseA1SafeId("changed-replacement-evidence"),
      }),
    ).toEqual({ status: "collision", replacement: null });

    now = 105;
    const second = repository.reserveAdditionalTerminalChat({
      fence: fence1,
      mappingFence: {
        projectId: replacement.project.projectId,
        workspaceSelectorId: replacement.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: replacement.mapping.projectTargetSelectorMappingId,
        mappingGeneration: replacement.mapping.mappingGeneration,
        targetDigest: replacement.mapping.targetDigest,
      },
      parentChatId: null,
      registration: registration(80),
    });
    expect(second.journalEntry.journalOffset).toBe(5);

    now = 106;
    const replacement2Request = {
      fence: fence1,
      expectedMapping: {
        projectId: replacement.project.projectId,
        workspaceSelectorId: replacement.mapping.workspaceSelectorId,
        projectTargetSelectorMappingId: replacement.mapping.projectTargetSelectorMappingId,
        mappingGeneration: replacement.mapping.mappingGeneration,
        targetDigest: replacement.mapping.targetDigest,
      },
      terminalTarget: {
        ...terminalTarget,
        terminalProjectRef: parseA1SafeId("terminal-project-replacement-two"),
      },
      mappingEvidenceRef: parseA1SafeId("mapping-replacement-evidence-two"),
    };
    const replacement2 = repository.replaceProjectTargetMapping(replacement2Request);
    expect(replacement2).toMatchObject({
      mapping: { mappingGeneration: 3, state: "current" },
      journalEntry: { journalOffset: 6 },
    });
    expect(repository.reconcileProjectTargetMappingReplacement(replacementRequest)).toMatchObject({
      status: "applied",
      replacement: { replayed: true },
    });
    expect(
      repository.reconcileProjectTargetMappingReplacement({
        fence: fence1,
        expectedMapping: {
          projectId: replacement2.project.projectId,
          workspaceSelectorId: replacement2.mapping.workspaceSelectorId,
          projectTargetSelectorMappingId: replacement2.mapping.projectTargetSelectorMappingId,
          mappingGeneration: replacement2.mapping.mappingGeneration,
          targetDigest: replacement2.mapping.targetDigest,
        },
        terminalTarget: {
          ...terminalTarget,
          terminalProjectRef: parseA1SafeId("not-applied-target"),
        },
        mappingEvidenceRef: parseA1SafeId("not-applied-evidence"),
      }),
    ).toEqual({ status: "not_applied", replacement: null });
    expect(
      repository.listProjectTargetMappings(
        serverId,
        explicit.project.projectId,
        explicit.mapping.workspaceSelectorId,
      ),
    ).toHaveLength(3);
    expect(
      repository.readCurrentProjectTargetMapping(
        serverId,
        explicit.project.projectId,
        explicit.mapping.workspaceSelectorId,
      ),
    ).toEqual(replacement2.mapping);
    expect(repository.listProjects(serverId)).toHaveLength(2);
    expect(repository.listLogicalChats(serverId, first.project.projectId)).toEqual([first.chat]);
    expect(repository.listLogicalChats(serverId, explicit.project.projectId)).toEqual(
      expect.arrayContaining([beforeReplacement.chat, second.chat]),
    );
    expect(repository.listNativeBindings(serverId, second.chat.logicalChatId)).toEqual([
      second.binding,
    ]);
    expect(repository.listTerminalReservations(serverId)).toHaveLength(3);
    expect(repository.listTerminalReservations(serverId, explicit.project.projectId)).toEqual(
      expect.arrayContaining([
        {
          ...beforeReplacement,
          mapping: { ...beforeReplacement.mapping, state: "superseded" },
          replayed: true,
        },
        {
          ...second,
          mapping: { ...second.mapping, state: "superseded" },
          replayed: true,
        },
      ]),
    );

    expect(
      repository.renewCoordinatorLease({
        fence: fence1,
        expectedHeartbeatDeadlineMs: 1_100,
        newHeartbeatDeadlineMs: 1_200,
      }),
    ).toMatchObject({ replayed: false, lease: { heartbeatDeadlineMs: 1_200 } });
    expect(
      repository.acquireCoordinatorLease({
        collaborationServerId: serverId,
        candidateLeaseId: lease1,
        ownerInstanceId: parseA1SafeId("coordinator-one"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 1_000,
      }),
    ).toMatchObject({ replayed: true, isCurrent: true, unexpired: true });
    expect(
      repository.reconcileCoordinatorAcquisition({
        collaborationServerId: serverId,
        candidateLeaseId: lease1,
        ownerInstanceId: parseA1SafeId("coordinator-one"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 1_000,
      }),
    ).toMatchObject({ replayed: true, isCurrent: true, unexpired: true });
    expect(() =>
      repository.acquireCoordinatorLease({
        collaborationServerId: serverId,
        candidateLeaseId: lease1,
        ownerInstanceId: parseA1SafeId("coordinator-one"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 999,
      }),
    ).toThrow(HostStateRepositoryConflictError);
    expect(
      repository.reconcileCoordinatorRenewal({
        collaborationServerId: serverId,
        coordinatorLeaseId: lease1,
        expectedHeartbeatDeadlineMs: 1_100,
        newHeartbeatDeadlineMs: 1_200,
      }),
    ).toMatchObject({ status: "applied" });

    now = 107;
    const released = repository.releaseCoordinatorLease({ fence: fence1 });
    expect(released.journalEntry.journalOffset).toBe(7);
    expect(repository.reconcileCoordinatorRelease(serverId, lease1)).toMatchObject({
      status: "released",
    });
    expect(() => repository.releaseCoordinatorLease({ fence: fence1 })).toThrow(
      HostStateStaleCoordinatorError,
    );

    now = 200;
    const lease2 = canonicalId("coordinatorLease", 61);
    repository.acquireCoordinatorLease({
      collaborationServerId: serverId,
      candidateLeaseId: lease2,
      ownerInstanceId: parseA1SafeId("coordinator-two"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 1,
      leaseDurationMs: 10,
    });
    now = 210;
    const lease3 = canonicalId("coordinatorLease", 62);
    const takeover = repository.acquireCoordinatorLease({
      collaborationServerId: serverId,
      candidateLeaseId: lease3,
      ownerInstanceId: parseA1SafeId("coordinator-three"),
      expectedCurrentLeaseId: lease2,
      expectedCoordinatorEpoch: 2,
      leaseDurationMs: 10,
    });
    expect(takeover).toMatchObject({ replayed: false, isCurrent: true, unexpired: true });
    expect(repository.readCoordinatorLease(serverId, lease2)).toMatchObject({ state: "current" });
    expect(
      repository.acquireCoordinatorLease({
        collaborationServerId: serverId,
        candidateLeaseId: lease3,
        ownerInstanceId: parseA1SafeId("coordinator-three"),
        expectedCurrentLeaseId: lease2,
        expectedCoordinatorEpoch: 2,
        leaseDurationMs: 10,
      }),
    ).toMatchObject({ replayed: true, isCurrent: true, unexpired: true });

    executor.inspect((transaction) =>
      validateHostStateRepositorySnapshot(transaction, MACHINE_IDENTITY_ID),
    );
    expect(() =>
      executor.inspect((transaction) =>
        validateHostStateRepositorySnapshot(
          new JournalOffsetSwapTransaction(transaction, lease1, first.project.projectId),
          MACHINE_IDENTITY_ID,
        ),
      ),
    ).toThrow(/does not follow its selected mapping|outside its coordinator lease interval/);
    expect(() =>
      executor.inspect((transaction) =>
        validateHostStateRepositorySnapshot(
          new JournalOffsetSwapTransaction(
            transaction,
            first.project.projectId,
            explicit.project.projectId,
          ),
          MACHINE_IDENTITY_ID,
        ),
      ),
    ).toThrow(/explicit project journal precedes the first bootstrap/);
    expect(() =>
      executor.inspect((transaction) =>
        validateHostStateRepositorySnapshot(
          new JournalOffsetSwapTransaction(
            transaction,
            replacement.mapping.projectTargetSelectorMappingId,
            replacement2.mapping.projectTargetSelectorMappingId,
          ),
          MACHINE_IDENTITY_ID,
        ),
      ),
    ).toThrow(/selector mapping replacement journal order/);
    expect(() =>
      executor.inspect((transaction) =>
        validateHostStateRepositorySnapshot(
          new JournalOffsetSwapTransaction(
            transaction,
            replacement.mapping.projectTargetSelectorMappingId,
            second.chat.logicalChatId,
          ),
          MACHINE_IDENTITY_ID,
        ),
      ),
    ).toThrow(/does not follow its selected mapping/);
    expect(() =>
      executor.inspect((transaction) =>
        validateHostStateRepositorySnapshot(
          new JournalOffsetSwapTransaction(
            transaction,
            beforeReplacement.chat.logicalChatId,
            replacement.mapping.projectTargetSelectorMappingId,
          ),
          MACHINE_IDENTITY_ID,
        ),
      ),
    ).toThrow(/does not precede mapping supersession/);

    executor.database
      .prepare("UPDATE native_bindings SET state = 'superseded' WHERE native_binding_id = ?")
      .run(first.binding.nativeBindingId);
    expect(() =>
      executor.inspect((transaction) =>
        validateHostStateRepositorySnapshot(transaction, MACHINE_IDENTITY_ID),
      ),
    ).toThrow(/terminal reservation graph linkage/);
  });

  it("reconciles an unknown mapping commit after close, reopen, and later supersession", () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-claw-repository-"));
    const databasePath = join(directory, "host-state.sqlite");
    let executor = openExecutor(databasePath);
    try {
      let now = 10;
      let repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
        randomBytes: entropyCounter(190),
        nowMs: () => now,
      });
      const server = repository.ensureDefaultCollaborationServer().server;
      const leaseId = canonicalId("coordinatorLease", 191);
      repository.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: leaseId,
        ownerInstanceId: parseA1SafeId("owner"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 1_000,
      });
      const fence = {
        collaborationServerId: server.collaborationServerId,
        coordinatorLeaseId: leaseId,
        coordinatorEpoch: 1,
      } as const;
      now = 11;
      const first = repository.reserveFirstTerminalChat({
        fence,
        workspaceSelectorId: parseA1SafeId("workspace"),
        terminalTarget,
        mappingEvidenceRef: parseA1SafeId("first-evidence"),
        registration: registration(192),
      });
      now = 12;
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
          ...terminalTarget,
          terminalProjectRef: parseA1SafeId("replacement-one"),
        },
        mappingEvidenceRef: parseA1SafeId("replacement-evidence-one"),
      };
      const replacement = repository.replaceProjectTargetMapping(replacementRequest);
      now = 13;
      const replacement2 = repository.replaceProjectTargetMapping({
        fence,
        expectedMapping: {
          projectId: replacement.project.projectId,
          workspaceSelectorId: replacement.mapping.workspaceSelectorId,
          projectTargetSelectorMappingId: replacement.mapping.projectTargetSelectorMappingId,
          mappingGeneration: replacement.mapping.mappingGeneration,
          targetDigest: replacement.mapping.targetDigest,
        },
        terminalTarget: {
          ...terminalTarget,
          terminalProjectRef: parseA1SafeId("replacement-two"),
        },
        mappingEvidenceRef: parseA1SafeId("replacement-evidence-two"),
      });

      executor.database.close();
      executor = openExecutor(databasePath, false);
      repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
        nowMs: () => now,
      });
      executor.inspect((transaction) =>
        validateHostStateRepositorySnapshot(transaction, MACHINE_IDENTITY_ID),
      );
      expect(repository.reconcileProjectTargetMappingReplacement(replacementRequest)).toMatchObject(
        { status: "applied", replacement: { replayed: true } },
      );
      expect(
        repository.reconcileProjectTargetMappingReplacement({
          ...replacementRequest,
          mappingEvidenceRef: parseA1SafeId("colliding-evidence"),
        }),
      ).toEqual({ status: "collision", replacement: null });
      expect(
        repository.reconcileProjectTargetMappingReplacement({
          fence,
          expectedMapping: {
            projectId: replacement2.project.projectId,
            workspaceSelectorId: replacement2.mapping.workspaceSelectorId,
            projectTargetSelectorMappingId: replacement2.mapping.projectTargetSelectorMappingId,
            mappingGeneration: replacement2.mapping.mappingGeneration,
            targetDigest: replacement2.mapping.targetDigest,
          },
          terminalTarget: {
            ...terminalTarget,
            terminalProjectRef: parseA1SafeId("never-applied"),
          },
          mappingEvidenceRef: parseA1SafeId("never-applied-evidence"),
        }),
      ).toEqual({ status: "not_applied", replacement: null });
    } finally {
      try {
        executor.database.close();
      } catch {
        // The pre-reopen handle was already closed.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects stale and early-takeover writes without consuming journal offsets", () => {
    const executor = openExecutor();
    let now = 10;
    const repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
      randomBytes: entropyCounter(100),
      nowMs: () => now,
    });
    const server = repository.ensureDefaultCollaborationServer().server;
    const leaseId = canonicalId("coordinatorLease", 110);
    repository.acquireCoordinatorLease({
      collaborationServerId: server.collaborationServerId,
      candidateLeaseId: leaseId,
      ownerInstanceId: parseA1SafeId("owner"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 10,
    });
    expect(() =>
      repository.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: canonicalId("coordinatorLease", 111),
        ownerInstanceId: parseA1SafeId("early-owner"),
        expectedCurrentLeaseId: leaseId,
        expectedCoordinatorEpoch: 1,
        leaseDurationMs: 10,
      }),
    ).toThrow(/has not expired/);
    now = 20;
    expect(() =>
      repository.reserveFirstTerminalChat({
        fence: {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: leaseId,
          coordinatorEpoch: 1,
        },
        workspaceSelectorId: parseA1SafeId("workspace"),
        terminalTarget,
        mappingEvidenceRef: parseA1SafeId("evidence"),
        registration: registration(120),
      }),
    ).toThrow(HostStateStaleCoordinatorError);
    expect(repository.readDefaultCollaborationServer()?.server.nextJournalOffset).toBe(1);
  });

  it("requires the first terminal bootstrap before explicit project allocation", () => {
    const executor = openExecutor();
    const repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
      randomBytes: entropyCounter(160),
      nowMs: () => 10,
    });
    const server = repository.ensureDefaultCollaborationServer().server;
    const leaseId = canonicalId("coordinatorLease", 161);
    repository.acquireCoordinatorLease({
      collaborationServerId: server.collaborationServerId,
      candidateLeaseId: leaseId,
      ownerInstanceId: parseA1SafeId("owner"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 100,
    });
    expect(() =>
      repository.allocateExplicitProject({
        fence: {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: leaseId,
          coordinatorEpoch: 1,
        },
        projectAllocationIntentId: parseA1SafeId("explicit-before-first"),
        workspaceSelectorId: parseA1SafeId("workspace"),
        terminalTarget,
        mappingEvidenceRef: parseA1SafeId("evidence"),
      }),
    ).toThrow(/requires an existing first-bootstrap project/);
    expect(executor.database.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
      count: 0,
    });
    expect(repository.readDefaultCollaborationServer()?.server.nextJournalOffset).toBe(1);
  });

  it("reports registration replay-key collisions before SQL uniqueness can poison the handle", () => {
    const executor = openExecutor();
    const now = 10;
    const repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
      randomBytes: entropyCounter(170),
      nowMs: () => now,
    });
    const server1 = repository.ensureDefaultCollaborationServer().server;
    const lease1 = canonicalId("coordinatorLease", 171);
    repository.acquireCoordinatorLease({
      collaborationServerId: server1.collaborationServerId,
      candidateLeaseId: lease1,
      ownerInstanceId: parseA1SafeId("owner-one"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 100,
    });
    const fence1 = {
      collaborationServerId: server1.collaborationServerId,
      coordinatorLeaseId: lease1,
      coordinatorEpoch: 1,
    } as const;
    const firstRegistration = registration(172);
    const first = repository.reserveFirstTerminalChat({
      fence: fence1,
      workspaceSelectorId: parseA1SafeId("workspace-one"),
      terminalTarget,
      mappingEvidenceRef: parseA1SafeId("evidence-one"),
      registration: firstRegistration,
    });
    const explicitAttempt = registration(173).registrationAttemptId;
    repository.allocateExplicitProject({
      fence: fence1,
      projectAllocationIntentId: explicitAttempt,
      workspaceSelectorId: parseA1SafeId("workspace-explicit"),
      terminalTarget,
      mappingEvidenceRef: parseA1SafeId("evidence-explicit"),
    });
    expect(() =>
      repository.reserveFirstTerminalChat({
        fence: fence1,
        workspaceSelectorId: parseA1SafeId("workspace-explicit"),
        terminalTarget,
        mappingEvidenceRef: parseA1SafeId("evidence-explicit"),
        registration: { ...registration(173), registrationAttemptId: explicitAttempt },
      }),
    ).toThrow(/already used by an explicit project allocation/);

    const server2Id = canonicalId("collaborationServer", 174);
    executor.database
      .prepare(
        `INSERT INTO collaboration_servers (
          collaboration_server_id, machine_identity_id, current_key_generation,
          current_identity_key_id, current_scope_certificate_id,
          current_coordinator_epoch, current_coordinator_lease_id,
          next_journal_offset, next_server_signature_seq, next_command_seq,
          created_at_ms, state
        ) VALUES (?, ?, 0, NULL, NULL, 0, NULL, 0, 0, 0, ?, 'installing')`,
      )
      .run(server2Id, MACHINE_IDENTITY_ID, now);
    const lease2 = canonicalId("coordinatorLease", 175);
    repository.acquireCoordinatorLease({
      collaborationServerId: server2Id,
      candidateLeaseId: lease2,
      ownerInstanceId: parseA1SafeId("owner-two"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 100,
    });
    const fence2 = {
      collaborationServerId: server2Id,
      coordinatorLeaseId: lease2,
      coordinatorEpoch: 1,
    } as const;
    expect(() =>
      repository.reserveFirstTerminalChat({
        fence: fence2,
        workspaceSelectorId: parseA1SafeId("workspace-two"),
        terminalTarget,
        mappingEvidenceRef: parseA1SafeId("evidence-two"),
        registration: firstRegistration,
      }),
    ).toThrow(/already allocated to another collaboration server/);
    expect(
      repository.reserveFirstTerminalChat({
        fence: fence2,
        workspaceSelectorId: parseA1SafeId("workspace-two"),
        terminalTarget,
        mappingEvidenceRef: parseA1SafeId("evidence-two"),
        registration: registration(176),
      }).project.allocationKind,
    ).toBe("first_bootstrap");
    expect(
      repository.readTerminalReservation(
        server1.collaborationServerId,
        firstRegistration.registrationAttemptId,
      ),
    ).toMatchObject({
      chat: { logicalChatId: first.chat.logicalChatId },
    });
  });

  it("rejects backward clocks without writes and remains usable", () => {
    const executor = openExecutor();
    let now = 10;
    const repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
      randomBytes: entropyCounter(180),
      nowMs: () => now,
    });
    const server = repository.ensureDefaultCollaborationServer().server;
    const lease1 = canonicalId("coordinatorLease", 181);
    repository.acquireCoordinatorLease({
      collaborationServerId: server.collaborationServerId,
      candidateLeaseId: lease1,
      ownerInstanceId: parseA1SafeId("owner-one"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 100,
    });
    const fence = {
      collaborationServerId: server.collaborationServerId,
      coordinatorLeaseId: lease1,
      coordinatorEpoch: 1,
    } as const;
    const request = {
      fence,
      workspaceSelectorId: parseA1SafeId("workspace"),
      terminalTarget,
      mappingEvidenceRef: parseA1SafeId("evidence"),
      registration: registration(182),
    };
    now = 9;
    expect(() => repository.reserveFirstTerminalChat(request)).toThrow(
      HostStateStaleCoordinatorError,
    );
    expect(repository.readDefaultCollaborationServer()?.server.nextJournalOffset).toBe(1);
    now = 11;
    expect(repository.reserveFirstTerminalChat(request).journalEntry.journalOffset).toBe(1);
    now = 12;
    repository.releaseCoordinatorLease({ fence });
    now = 11;
    const lease2 = canonicalId("coordinatorLease", 183);
    expect(() =>
      repository.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: lease2,
        ownerInstanceId: parseA1SafeId("owner-two"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 1,
        leaseDurationMs: 100,
      }),
    ).toThrow(/released predecessor/);
    expect(repository.readCoordinatorLease(server.collaborationServerId, lease2)).toBeNull();
    now = 12;
    expect(
      repository.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: lease2,
        ownerInstanceId: parseA1SafeId("owner-two"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 1,
        leaseDurationMs: 100,
      }).journalEntry.journalOffset,
    ).toBe(3);
  });

  it("bounds random-ID collision retries without creating a default profile", () => {
    const executor = openExecutor();
    const collisionBytes = new Uint8Array(16).fill(125);
    const collisionId = parseA1CanonicalId(
      "collaborationServer",
      `rcs_${base64urlEncode(collisionBytes)}`,
    );
    executor.database
      .prepare(
        `INSERT INTO collaboration_servers (
          collaboration_server_id, machine_identity_id, current_key_generation,
          current_identity_key_id, current_scope_certificate_id,
          current_coordinator_epoch, current_coordinator_lease_id,
          next_journal_offset, next_server_signature_seq, next_command_seq,
          created_at_ms, state
        ) VALUES (?, ?, 0, NULL, NULL, 0, NULL, 0, 0, 0, 0, 'installing')`,
      )
      .run(collisionId, MACHINE_IDENTITY_ID);
    let calls = 0;
    const repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
      randomBytes: (byteLength) => {
        calls++;
        return new Uint8Array(byteLength).fill(125);
      },
      nowMs: () => 0,
    });
    expect(() => repository.ensureDefaultCollaborationServer()).toThrow(
      HostStateRepositoryPersistenceError,
    );
    expect(calls).toBe(HOST_STATE_REPOSITORY_MAX_ID_ATTEMPTS);
    expect(
      executor.database.prepare("SELECT COUNT(*) AS count FROM host_state_profiles").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects exhausted journal allocation before creating graph rows", () => {
    const executor = openExecutor();
    const repository = new HostStateRepository(executor, MACHINE_IDENTITY_ID, {
      randomBytes: entropyCounter(130),
      nowMs: () => 10,
    });
    const server = repository.ensureDefaultCollaborationServer().server;
    const leaseId = canonicalId("coordinatorLease", 140);
    repository.acquireCoordinatorLease({
      collaborationServerId: server.collaborationServerId,
      candidateLeaseId: leaseId,
      ownerInstanceId: parseA1SafeId("owner"),
      expectedCurrentLeaseId: null,
      expectedCoordinatorEpoch: 0,
      leaseDurationMs: 100,
    });
    executor.database
      .prepare(
        "UPDATE collaboration_servers SET next_journal_offset = ? WHERE collaboration_server_id = ?",
      )
      .run(Number.MAX_SAFE_INTEGER, server.collaborationServerId);
    expect(() =>
      repository.reserveFirstTerminalChat({
        fence: {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: leaseId,
          coordinatorEpoch: 1,
        },
        workspaceSelectorId: parseA1SafeId("workspace"),
        terminalTarget,
        mappingEvidenceRef: parseA1SafeId("evidence"),
        registration: registration(150),
      }),
    ).toThrow(HostStateRepositoryConflictError);
    expect(executor.database.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
      count: 0,
    });
    expect(executor.database.prepare("SELECT COUNT(*) AS count FROM logical_chats").get()).toEqual({
      count: 0,
    });
  });
});
