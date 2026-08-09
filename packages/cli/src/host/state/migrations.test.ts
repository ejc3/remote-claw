import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  assertHostStateMigrationRegistry,
  computeHostStateMigrationDigests,
  expectedHostStateMigrationDigest,
  expectedHostStateSqliteSchemaManifest,
  HOST_STATE_APPLICATION_ID,
  HOST_STATE_MIGRATION_DIGESTS,
  HOST_STATE_MIGRATIONS,
  HOST_STATE_SCHEMA_MANIFEST,
  HOST_STATE_SCHEMA_VERSION,
  HOST_STATE_SQLITE_SCHEMA_MANIFEST,
  type HostStateMigration,
  isExpectedHostStateMigrationDigest,
} from "./migrations.js";

const PINNED_VERSION_ONE_DIGEST = "Pk8Yrc3jVK9xoHKDcBdeyejFYUSbyjnp-SH0VMA_Hec";
const PINNED_VERSION_TWO_DIGEST = "yx23Bca9rSZttCEInDAEOrzLVhq-KWcZLE1i27tqNiY";
const PINNED_VERSION_THREE_DIGEST = "cMLS59JfiV7fRoK68n1kZz3DN9Vo4yu7VZAX_HxHpq4";

function encoded(byteLength: number, fill: number): string {
  return base64urlEncode(new Uint8Array(byteLength).fill(fill));
}

const MACHINE_IDENTITY_ID = "0".repeat(32);
const DIGEST = encoded(32, 9);
const SERVER_ID = `rcs_${encoded(16, 1)}`;
const PROJECT_ID = `rcpj_${encoded(16, 2)}`;
const MAPPING_ID = `ptm_${encoded(32, 3)}`;
const CHAT_ID = `rcl_${encoded(16, 4)}`;
const BINDING_ID = `rcnb_${encoded(16, 5)}`;
const EDGE_ID = `rcie_${encoded(16, 6)}`;
const REGISTRATION_ATTEMPT_ID = `rcra_${encoded(16, 7)}`;
const COORDINATOR_LEASE_ID = `rccl_${encoded(16, 8)}`;

function applyMigrations(database: DatabaseSync, through = HOST_STATE_SCHEMA_VERSION): void {
  for (const migration of HOST_STATE_MIGRATIONS.slice(0, through)) {
    for (const statement of migration.statements) database.exec(statement);
  }
}

function insertMetadata(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO host_state_metadata
         (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
       VALUES (1, ?, ?, ?, 1)`,
    )
    .run(MACHINE_IDENTITY_ID, HOST_STATE_SCHEMA_VERSION, PINNED_VERSION_THREE_DIGEST);
}

function insertDefaultServer(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO collaboration_servers
         (collaboration_server_id, machine_identity_id, current_key_generation,
          current_identity_key_id, current_scope_certificate_id, current_coordinator_epoch,
          current_coordinator_lease_id, next_journal_offset, next_server_signature_seq,
          next_command_seq, created_at_ms, state)
       VALUES (?, ?, 0, NULL, NULL, 0, NULL, 0, 0, 0, 1, 'installing')`,
    )
    .run(SERVER_ID, MACHINE_IDENTITY_ID);
  database
    .prepare(
      `INSERT INTO host_state_profiles
         (state_profile_id, machine_identity_id, default_collaboration_server_id, created_at_ms)
       VALUES ('default', ?, ?, 1)`,
    )
    .run(MACHINE_IDENTITY_ID, SERVER_ID);
}

function insertInitialProject(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO project_target_selector_mappings
           (project_target_selector_mapping_id, collaboration_server_id, project_id,
            workspace_selector_id, target_kind, target_product, target_access,
            terminal_project_ref, native_workspace_binding_id,
            nested_server_management_binding_id, target_server_id, target_project_id,
            target_workspace_selector_id, target_digest, mapping_generation, evidence_ref, state)
         VALUES (?, ?, ?, 'workspace-1', 'terminal_native', 'codex', 'app-server',
                 'terminal-project-1', NULL, NULL, NULL, NULL, NULL, ?, 1, 'evidence-1', 'current')`,
      )
      .run(MAPPING_ID, SERVER_ID, PROJECT_ID, DIGEST);
    database
      .prepare(
        `INSERT INTO projects
           (project_id, collaboration_server_id, project_allocation_intent_id,
            project_allocation_intent_schema_id, project_allocation_intent_digest,
            allocation_kind, initial_workspace_selector_id, initial_target_digest,
            initial_project_target_selector_mapping_id, initial_mapping_generation,
            initial_target_kind, created_at_ms, state)
         VALUES (?, ?, ?, 'remote-claw/project-allocation-intent/v1', ?,
                 'first_bootstrap', 'workspace-1', ?, ?, 1,
                 'terminal_native', 2, 'current')`,
      )
      .run(PROJECT_ID, SERVER_ID, REGISTRATION_ATTEMPT_ID, DIGEST, DIGEST, MAPPING_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertTerminalChat(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO logical_chats
           (logical_chat_id, collaboration_server_id, project_id,
            project_target_selector_mapping_id, state, topology_generation,
            current_inward_edge_id, current_native_binding_id, parent_chat_id,
            next_viewer_projection_seq)
         VALUES (?, ?, ?, ?, 'recovering', 1, ?, ?, NULL, 0)`,
      )
      .run(CHAT_ID, SERVER_ID, PROJECT_ID, MAPPING_ID, EDGE_ID, BINDING_ID);
    database
      .prepare(
        `INSERT INTO native_bindings
           (native_binding_id, collaboration_server_id, logical_chat_id,
            descriptor_product, descriptor_access, project_id, semantic_conversation_id,
            current_binding_incarnation_id, state)
         VALUES (?, ?, ?, 'codex', 'app-server', ?, NULL, NULL, 'starting')`,
      )
      .run(BINDING_ID, SERVER_ID, CHAT_ID, PROJECT_ID);
    database
      .prepare(
        `INSERT INTO inward_collaboration_edges
           (inward_edge_id, represented_server_id, represented_logical_chat_id,
            target_kind, target_server_id, target_logical_chat_id, target_native_binding_id,
            root_path_certificate_id, current_connection_epoch, current_live_lease_id,
            current_capability_snapshot_id, state)
         VALUES (?, ?, ?, 'native-harness', NULL, NULL, ?, NULL, 0, NULL, NULL, 'installing')`,
      )
      .run(EDGE_ID, SERVER_ID, CHAT_ID, BINDING_ID);
    database
      .prepare(
        `INSERT INTO native_registration_intents
           (registration_attempt_id, collaboration_server_id, native_binding_id,
            canonical_intent_schema_id, descriptor_ref, descriptor_digest, project_ref,
            project_digest, expected_native_ref_digest, initial_phase, metadata_schema_id,
            metadata_ref, metadata_digest, capabilities_ref, capabilities_digest,
            canonical_intent_digest, created_at_ms)
         VALUES (?, ?, ?, 'remote-claw/native-registration-intent/v1', 'descriptor-1', ?,
                 'project-ref-1', ?, NULL, 'starting', 'metadata/v1', 'metadata-1', ?,
                 NULL, NULL, ?, 3)`,
      )
      .run(REGISTRATION_ATTEMPT_ID, SERVER_ID, BINDING_ID, DIGEST, DIGEST, DIGEST, DIGEST);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function openedV3Database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA recursive_triggers=ON");
  applyMigrations(database);
  insertMetadata(database);
  insertDefaultServer(database);
  return database;
}

describe("A1 host-state migrations", () => {
  it("pins the application id, schema version, and exact migration digests", () => {
    expect(HOST_STATE_APPLICATION_ID).toBe(0x52434c57);
    expect(HOST_STATE_SCHEMA_VERSION).toBe(3);
    expect(HOST_STATE_MIGRATION_DIGESTS).toEqual([
      PINNED_VERSION_ONE_DIGEST,
      PINNED_VERSION_TWO_DIGEST,
      PINNED_VERSION_THREE_DIGEST,
    ]);
    expect(HOST_STATE_SCHEMA_MANIFEST).toEqual({
      applicationId: 0x52434c57,
      schemaVersion: 3,
      migrationDigest: PINNED_VERSION_THREE_DIGEST,
      sqliteSchema: HOST_STATE_SQLITE_SCHEMA_MANIFEST,
    });
    expect(expectedHostStateSqliteSchemaManifest(1)).toHaveLength(6);
    expect(expectedHostStateSqliteSchemaManifest(2)).toHaveLength(10);
    expect(expectedHostStateSqliteSchemaManifest(3)).toHaveLength(91);
  });

  it("commits every exact historical SQL byte into the chained digest", () => {
    const versionOne = HOST_STATE_MIGRATIONS[0];
    expect(versionOne).toBeDefined();
    if (versionOne === undefined) throw new Error("missing test migration");

    const editedVersionOne: HostStateMigration = {
      ...versionOne,
      statements: [`${versionOne.statements[0]} `, ...versionOne.statements.slice(1)],
    };
    expect(computeHostStateMigrationDigests([editedVersionOne])).not.toEqual(
      HOST_STATE_MIGRATION_DIGESTS,
    );

    const versionTwo: HostStateMigration = {
      version: 2,
      id: "002-test-successor",
      statements: ["CREATE TABLE test_successor (id INTEGER PRIMARY KEY) STRICT"],
    };
    const originalChain = computeHostStateMigrationDigests([versionOne, versionTwo]);
    const editedChain = computeHostStateMigrationDigests([editedVersionOne, versionTwo]);
    expect(originalChain[0]).toBe(PINNED_VERSION_ONE_DIGEST);
    expect(editedChain[0]).not.toBe(originalChain[0]);
    expect(editedChain[1]).not.toBe(originalChain[1]);
  });

  it("rejects gaps, reordering, duplicate ids, and invalid SQL", () => {
    const migration = HOST_STATE_MIGRATIONS[0];
    expect(migration).toBeDefined();
    if (migration === undefined) throw new Error("missing test migration");

    expect(() => assertHostStateMigrationRegistry([])).toThrow(/at least one migration/);
    expect(() => assertHostStateMigrationRegistry([{ ...migration, version: 2 }])).toThrow(
      /version 1 must be present/,
    );
    expect(() =>
      assertHostStateMigrationRegistry([migration, { ...migration, version: 2 }]),
    ).toThrow(/duplicated/);
    expect(() => assertHostStateMigrationRegistry([{ ...migration, statements: [] }])).toThrow(
      /at least one SQL statement/,
    );
    expect(() =>
      assertHostStateMigrationRegistry([{ ...migration, statements: ["SELECT 1\0"] }]),
    ).toThrow(/invalid SQL/);
  });

  it("validates only the canonical digest for a supported version", () => {
    expect(expectedHostStateMigrationDigest(1)).toBe(PINNED_VERSION_ONE_DIGEST);
    expect(expectedHostStateMigrationDigest(2)).toBe(PINNED_VERSION_TWO_DIGEST);
    expect(expectedHostStateMigrationDigest(3)).toBe(PINNED_VERSION_THREE_DIGEST);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 1)).toBe(true);
    expect(isExpectedHostStateMigrationDigest(`${PINNED_VERSION_ONE_DIGEST}=`, 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest("A".repeat(43), 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 2)).toBe(false);
    expect(() => expectedHostStateMigrationDigest(0)).toThrow(/not supported/);
    expect(() => expectedHostStateMigrationDigest(4)).toThrow(/not supported/);
  });

  it("creates exactly the declared application schema", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of HOST_STATE_MIGRATIONS) {
        for (const statement of migration.statements) database.exec(statement);
      }
      const rows = database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
           ORDER BY type, name`,
        )
        .all();
      const expected = [...HOST_STATE_SQLITE_SCHEMA_MANIFEST].sort((left, right) =>
        left.type === right.type
          ? left.name < right.name
            ? -1
            : left.name > right.name
              ? 1
              : 0
          : left.type < right.type
            ? -1
            : 1,
      );
      expect(rows).toEqual(expected);

      expect(
        database
          .prepare("PRAGMA table_info(protected_artifacts)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "protected_handle_id",
        "kind",
        "scope_kind",
        "scope_id",
        "artifact_schema_id",
        "artifact_digest",
        "byte_length",
        "artifact_bytes",
        "created_at_ms",
      ]);

      expect(rows.filter((row) => row.type === "table")).toHaveLength(13);
      expect(rows.filter((row) => row.type === "index")).toHaveLength(24);
      expect(rows.filter((row) => row.type === "trigger")).toHaveLength(54);
      expect(rows.some((row) => String(row.name).startsWith("sqlite_autoindex"))).toBe(false);
      expect(
        database
          .prepare("PRAGMA table_info(projects)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "project_id",
        "collaboration_server_id",
        "project_allocation_intent_id",
        "project_allocation_intent_schema_id",
        "project_allocation_intent_digest",
        "allocation_kind",
        "initial_workspace_selector_id",
        "initial_target_digest",
        "initial_project_target_selector_mapping_id",
        "initial_mapping_generation",
        "initial_target_kind",
        "created_at_ms",
        "state",
      ]);
      expect(
        database
          .prepare("PRAGMA table_info(logical_chats)")
          .all()
          .map((row) => row.name),
      ).toContain("project_target_selector_mapping_id");
      expect(
        database
          .prepare("PRAGMA table_info(coordinator_leases)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "coordinator_lease_id",
        "collaboration_server_id",
        "coordinator_epoch",
        "owner_instance_id",
        "acquired_at_ms",
        "initial_heartbeat_deadline_ms",
        "heartbeat_deadline_ms",
        "released_at_ms",
        "state",
      ]);
      expect(
        rows
          .filter((row) => row.type === "table")
          .flatMap((row) =>
            database
              .prepare(`PRAGMA table_info(${String(row.name)})`)
              .all()
              .map((column) => String(column.name)),
          )
          .some((name) => name.endsWith("_json")),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("migrates the exact v2 manifest to the exact v3 host-record manifest", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database, 2);
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'collaboration_servers'")
          .get(),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema").all(),
      ).toHaveLength(10);

      const migration = HOST_STATE_MIGRATIONS[2];
      expect(migration?.id).toBe("003-durable-host-records");
      expect(migration?.statements).toHaveLength(81);
      if (migration === undefined) throw new Error("missing v3 migration");
      for (const statement of migration.statements) database.exec(statement);

      const actual = database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
           ORDER BY type, name`,
        )
        .all();
      const expected = [...expectedHostStateSqliteSchemaManifest(3)].sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type.localeCompare(right.type),
      );
      expect(actual).toEqual(expected);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces the compound project, terminal chat, binding, and edge relationships", () => {
    const database = openedV3Database();
    try {
      insertInitialProject(database);
      insertTerminalChat(database);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT topology_generation, current_inward_edge_id, current_native_binding_id,
                    project_target_selector_mapping_id
             FROM logical_chats WHERE logical_chat_id = ?`,
          )
          .get(CHAT_ID),
      ).toEqual({
        topology_generation: 1,
        current_inward_edge_id: EDGE_ID,
        current_native_binding_id: BINDING_ID,
        project_target_selector_mapping_id: MAPPING_ID,
      });

      database
        .prepare("UPDATE native_bindings SET state = 'superseded' WHERE native_binding_id = ?")
        .run(BINDING_ID);

      expect(() =>
        database
          .prepare(
            `INSERT INTO native_bindings
               (native_binding_id, collaboration_server_id, logical_chat_id,
                descriptor_product, descriptor_access, project_id, semantic_conversation_id,
                current_binding_incarnation_id, state)
             VALUES (?, ?, ?, 'opencode', 'server', ?, NULL, NULL, 'starting')`,
          )
          .run(`rcnb_${"I".repeat(22)}`, SERVER_ID, CHAT_ID, PROJECT_ID),
      ).toThrow(/current terminal mapping/);

      expect(() =>
        database
          .prepare(
            `UPDATE project_target_selector_mappings
             SET target_digest = ?
             WHERE project_target_selector_mapping_id = ?`,
          )
          .run("B".repeat(43), MAPPING_ID),
      ).toThrow(/immutable/);
      expect(() => database.prepare("DELETE FROM logical_chats").run()).toThrow(/retained/);
    } finally {
      database.close();
    }
  });

  it("keeps terminal lifecycle states monotonic without freezing the initial mapping", () => {
    const database = openedV3Database();
    try {
      insertInitialProject(database);
      insertTerminalChat(database);

      database
        .prepare(
          "UPDATE project_target_selector_mappings SET state = 'superseded' WHERE project_target_selector_mapping_id = ?",
        )
        .run(MAPPING_ID);
      expect(() =>
        database
          .prepare(
            "UPDATE project_target_selector_mappings SET state = 'current' WHERE project_target_selector_mapping_id = ?",
          )
          .run(MAPPING_ID),
      ).toThrow(/cannot be resurrected/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      database.prepare("UPDATE projects SET state = 'closed' WHERE project_id = ?").run(PROJECT_ID);
      expect(() =>
        database
          .prepare("UPDATE projects SET state = 'current' WHERE project_id = ?")
          .run(PROJECT_ID),
      ).toThrow(/cannot be reopened/);

      database
        .prepare("UPDATE logical_chats SET state = 'closed' WHERE logical_chat_id = ?")
        .run(CHAT_ID);
      expect(() =>
        database
          .prepare("UPDATE logical_chats SET state = 'recovering' WHERE logical_chat_id = ?")
          .run(CHAT_ID),
      ).toThrow(/cannot be reopened/);

      database
        .prepare("UPDATE native_bindings SET state = 'superseded' WHERE native_binding_id = ?")
        .run(BINDING_ID);
      expect(() =>
        database
          .prepare("UPDATE native_bindings SET state = 'starting' WHERE native_binding_id = ?")
          .run(BINDING_ID),
      ).toThrow(/cannot be resurrected/);

      database
        .prepare(
          `UPDATE inward_collaboration_edges
           SET root_path_certificate_id = 'certificate-1', state = 'installed'
           WHERE inward_edge_id = ?`,
        )
        .run(EDGE_ID);
      database
        .prepare(
          "UPDATE inward_collaboration_edges SET state = 'superseded' WHERE inward_edge_id = ?",
        )
        .run(EDGE_ID);
      expect(() =>
        database
          .prepare(
            "UPDATE inward_collaboration_edges SET state = 'installed' WHERE inward_edge_id = ?",
          )
          .run(EDGE_ID),
      ).toThrow(/cannot be resurrected/);
    } finally {
      database.close();
    }
  });

  it("allows named servers later while keeping the default profile singular", () => {
    const database = openedV3Database();
    try {
      const additionalServerId = `rcs_${encoded(16, 10)}`;
      database
        .prepare(
          `INSERT INTO collaboration_servers
             (collaboration_server_id, machine_identity_id, current_key_generation,
              current_identity_key_id, current_scope_certificate_id, current_coordinator_epoch,
              current_coordinator_lease_id, next_journal_offset, next_server_signature_seq,
              next_command_seq, created_at_ms, state)
           VALUES (?, ?, 0, NULL, NULL, 0, NULL, 0, 0, 0, 2, 'installing')`,
        )
        .run(additionalServerId, MACHINE_IDENTITY_ID);
      expect(database.prepare("SELECT count(*) AS count FROM collaboration_servers").get()).toEqual(
        { count: 2 },
      );
      expect(() =>
        database
          .prepare(
            `INSERT OR REPLACE INTO host_state_profiles
               (state_profile_id, machine_identity_id, default_collaboration_server_id,
                created_at_ms)
             VALUES ('default', ?, ?, 2)`,
          )
          .run(MACHINE_IDENTITY_ID, additionalServerId),
      ).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });

  it("allocates journal offsets exactly once and keeps the journal append-only", () => {
    const database = openedV3Database();
    try {
      database.exec("BEGIN");
      database
        .prepare(
          `INSERT INTO coordinator_leases
             (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
              heartbeat_deadline_ms, released_at_ms, state)
           VALUES (?, ?, 1, 'owner-1', 10, 20, 20, NULL, 'current')`,
        )
        .run(COORDINATOR_LEASE_ID, SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_servers
           SET current_coordinator_epoch = 1, current_coordinator_lease_id = ?
           WHERE collaboration_server_id = ?`,
        )
        .run(COORDINATOR_LEASE_ID, SERVER_ID);
      expect(() =>
        database
          .prepare(
            `INSERT INTO control_journal_entries
               (collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
                entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
                coordinator_lease_id, coordinator_epoch, committed_at_ms)
             VALUES (?, 1, 'server_control', NULL, 'coordinator_lease_acquired',
                     'coordinator_lease', ?, 'remote-claw/coordinator-lease-acquisition/v1',
                     ?, ?, 1, 10)`,
          )
          .run(SERVER_ID, COORDINATOR_LEASE_ID, DIGEST, COORDINATOR_LEASE_ID),
      ).toThrow(/next server offset/);
      database
        .prepare(
          `INSERT INTO control_journal_entries
             (collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
              entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
              coordinator_lease_id, coordinator_epoch, committed_at_ms)
           VALUES (?, 0, 'server_control', NULL, 'coordinator_lease_acquired',
                   'coordinator_lease', ?, 'remote-claw/coordinator-lease-acquisition/v1',
                   ?, ?, 1, 10)`,
        )
        .run(SERVER_ID, COORDINATOR_LEASE_ID, DIGEST, COORDINATOR_LEASE_ID);
      database.exec("COMMIT");

      expect(
        database
          .prepare(
            "SELECT next_journal_offset FROM collaboration_servers WHERE collaboration_server_id = ?",
          )
          .get(SERVER_ID),
      ).toEqual({ next_journal_offset: 1 });
      expect(() =>
        database.prepare("UPDATE control_journal_entries SET committed_at_ms = 11").run(),
      ).toThrow(/append-only/);
      expect(() => database.prepare("DELETE FROM control_journal_entries").run()).toThrow(
        /append-only/,
      );
      expect(() =>
        database
          .prepare(
            `INSERT OR REPLACE INTO control_journal_entries
               (collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
                entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
                coordinator_lease_id, coordinator_epoch, committed_at_ms)
             VALUES (?, 1, 'server_control', NULL, 'coordinator_lease_acquired',
                     'coordinator_lease', ?, 'remote-claw/coordinator-lease-acquisition/v1',
                     ?, ?, 1, 11)`,
          )
          .run(SERVER_ID, COORDINATOR_LEASE_ID, DIGEST, COORDINATOR_LEASE_ID),
      ).toThrow(/append-only/);

      const staleLeaseId = `rccl_${encoded(16, 13)}`;
      database
        .prepare(
          `INSERT INTO coordinator_leases
             (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
              heartbeat_deadline_ms, released_at_ms, state)
           VALUES (?, ?, 2, 'owner-2', 12, 30, 30, NULL, 'current')`,
        )
        .run(staleLeaseId, SERVER_ID);
      expect(() =>
        database
          .prepare(
            `INSERT INTO control_journal_entries
               (collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
                entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
                coordinator_lease_id, coordinator_epoch, committed_at_ms)
             VALUES (?, 1, 'server_control', NULL, 'coordinator_lease_acquired',
                     'coordinator_lease', ?, 'remote-claw/coordinator-lease-acquisition/v1',
                     ?, ?, 2, 12)`,
          )
          .run(SERVER_ID, staleLeaseId, DIGEST, staleLeaseId),
      ).toThrow(/current coordinator fence/);

      expect(() =>
        database
          .prepare(
            `INSERT INTO control_journal_entries
               (collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
                entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
                coordinator_lease_id, coordinator_epoch, committed_at_ms)
             VALUES (?, 1, 'server_control', NULL, 'terminal_chat_reserved',
                     'logical_chat', ?, 'remote-claw/terminal-chat-reservation/v1',
                     ?, ?, 1, 11)`,
          )
          .run(SERVER_ID, `rcl_${encoded(16, 11)}`, DIGEST, COORDINATOR_LEASE_ID),
      ).toThrow(/subject is not present/);

      expect(() =>
        database
          .prepare(
            `INSERT INTO control_journal_entries
               (collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
                entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
                coordinator_lease_id, coordinator_epoch, committed_at_ms)
             VALUES (?, 1, 'server_control', NULL, 'coordinator_lease_released',
                     'coordinator_lease', ?, 'remote-claw/coordinator-lease-release/v1',
                     ?, ?, 1, 20)`,
          )
          .run(SERVER_ID, COORDINATOR_LEASE_ID, DIGEST, COORDINATOR_LEASE_ID),
      ).toThrow(/unexpired current coordinator/);

      database
        .prepare(
          `UPDATE coordinator_leases SET released_at_ms = 11, state = 'released'
           WHERE coordinator_lease_id = ?`,
        )
        .run(COORDINATOR_LEASE_ID);
      database
        .prepare("UPDATE collaboration_servers SET next_journal_offset = 9007199254740991")
        .run();
      expect(() =>
        database
          .prepare(
            `INSERT INTO control_journal_entries
               (collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
                entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
                coordinator_lease_id, coordinator_epoch, committed_at_ms)
             VALUES (?, 9007199254740991, 'server_control', NULL,
                     'coordinator_lease_released', 'coordinator_lease', ?,
                     'remote-claw/coordinator-lease-release/v1', ?, ?, 1, 11)`,
          )
          .run(SERVER_ID, COORDINATOR_LEASE_ID, DIGEST, COORDINATOR_LEASE_ID),
      ).toThrow(/next server offset/);
    } finally {
      database.close();
    }
  });

  it("keeps expired coordinator predecessors while fencing authority through the server pointer", () => {
    const database = openedV3Database();
    try {
      const successorLeaseId = `rccl_${encoded(16, 12)}`;
      database.exec("BEGIN");
      database
        .prepare(
          `INSERT INTO coordinator_leases
             (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
              heartbeat_deadline_ms, released_at_ms, state)
           VALUES (?, ?, 1, 'owner-1', 10, 20, 20, NULL, 'current')`,
        )
        .run(COORDINATOR_LEASE_ID, SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_servers
           SET current_coordinator_epoch = 1, current_coordinator_lease_id = ?
           WHERE collaboration_server_id = ?`,
        )
        .run(COORDINATOR_LEASE_ID, SERVER_ID);
      database.exec("COMMIT");

      expect(() =>
        database
          .prepare(
            `UPDATE coordinator_leases SET initial_heartbeat_deadline_ms = 19
             WHERE coordinator_lease_id = ?`,
          )
          .run(COORDINATOR_LEASE_ID),
      ).toThrow(/identity/);

      expect(() =>
        database
          .prepare(
            `UPDATE collaboration_servers
             SET current_coordinator_epoch = 2
             WHERE collaboration_server_id = ?`,
          )
          .run(SERVER_ID),
      ).toThrow(/not monotonic/);
      expect(() =>
        database
          .prepare(
            `UPDATE coordinator_leases SET heartbeat_deadline_ms = 20
             WHERE coordinator_lease_id = ?`,
          )
          .run(COORDINATOR_LEASE_ID),
      ).toThrow(/strictly extend/);
      database
        .prepare(
          `UPDATE coordinator_leases SET heartbeat_deadline_ms = 21
           WHERE coordinator_lease_id = ?`,
        )
        .run(COORDINATOR_LEASE_ID);

      database.exec("BEGIN");
      try {
        const prematureLeaseId = `rccl_${encoded(16, 14)}`;
        database
          .prepare(
            `INSERT INTO coordinator_leases
               (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
                owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
                heartbeat_deadline_ms, released_at_ms, state)
             VALUES (?, ?, 2, 'premature-owner', 20, 30, 30, NULL, 'current')`,
          )
          .run(prematureLeaseId, SERVER_ID);
        expect(() =>
          database
            .prepare(
              `UPDATE collaboration_servers
               SET current_coordinator_epoch = 2, current_coordinator_lease_id = ?
               WHERE collaboration_server_id = ?`,
            )
            .run(prematureLeaseId, SERVER_ID),
        ).toThrow(/not monotonic/);
      } finally {
        database.exec("ROLLBACK");
      }

      database.exec("BEGIN");
      database
        .prepare(
          `INSERT INTO coordinator_leases
             (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
              heartbeat_deadline_ms, released_at_ms, state)
           VALUES (?, ?, 2, 'owner-2', 21, 30, 30, NULL, 'current')`,
        )
        .run(successorLeaseId, SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_servers
           SET current_coordinator_epoch = 2, current_coordinator_lease_id = ?
           WHERE collaboration_server_id = ?
             AND current_coordinator_epoch = 1
             AND current_coordinator_lease_id = ?`,
        )
        .run(successorLeaseId, SERVER_ID, COORDINATOR_LEASE_ID);
      database.exec("COMMIT");

      expect(() =>
        database
          .prepare(
            `UPDATE coordinator_leases SET heartbeat_deadline_ms = 22
             WHERE coordinator_lease_id = ?`,
          )
          .run(COORDINATOR_LEASE_ID),
      ).toThrow(/current coordinator lease/);
      database
        .prepare(
          `UPDATE coordinator_leases SET heartbeat_deadline_ms = 31
           WHERE coordinator_lease_id = ?`,
        )
        .run(successorLeaseId);

      expect(
        database
          .prepare(
            `SELECT coordinator_lease_id, coordinator_epoch, state
             FROM coordinator_leases ORDER BY coordinator_epoch`,
          )
          .all(),
      ).toEqual([
        { coordinator_lease_id: COORDINATOR_LEASE_ID, coordinator_epoch: 1, state: "current" },
        { coordinator_lease_id: successorLeaseId, coordinator_epoch: 2, state: "current" },
      ]);
      expect(
        database
          .prepare(
            `SELECT current_coordinator_epoch, current_coordinator_lease_id
             FROM collaboration_servers WHERE collaboration_server_id = ?`,
          )
          .get(SERVER_ID),
      ).toEqual({
        current_coordinator_epoch: 2,
        current_coordinator_lease_id: successorLeaseId,
      });

      expect(() =>
        database
          .prepare(
            `UPDATE collaboration_servers SET current_coordinator_lease_id = NULL
             WHERE collaboration_server_id = ?`,
          )
          .run(SERVER_ID),
      ).toThrow(/not monotonic/);

      expect(() =>
        database
          .prepare(
            `UPDATE coordinator_leases
             SET released_at_ms = 20, state = 'released'
             WHERE coordinator_lease_id = ?`,
          )
          .run(COORDINATOR_LEASE_ID),
      ).toThrow(/allows only current to released/);

      database
        .prepare(
          `UPDATE coordinator_leases
           SET released_at_ms = 29, state = 'released'
           WHERE coordinator_lease_id = ?`,
        )
        .run(successorLeaseId);
      expect(() =>
        database
          .prepare(
            `UPDATE coordinator_leases
             SET released_at_ms = NULL, state = 'current'
             WHERE coordinator_lease_id = ?`,
          )
          .run(successorLeaseId),
      ).toThrow(/allows only current to released/);

      database
        .prepare(
          `UPDATE collaboration_servers SET current_coordinator_lease_id = NULL
           WHERE collaboration_server_id = ?`,
        )
        .run(SERVER_ID);
      expect(
        database
          .prepare(
            `SELECT current_coordinator_epoch, current_coordinator_lease_id
             FROM collaboration_servers WHERE collaboration_server_id = ?`,
          )
          .get(SERVER_ID),
      ).toEqual({ current_coordinator_epoch: 2, current_coordinator_lease_id: null });
    } finally {
      database.close();
    }
  });

  it("makes collaboration server closure terminal while permitting only declared repairs", () => {
    const database = openedV3Database();
    try {
      database
        .prepare(
          "UPDATE collaboration_servers SET state = 'repairing' WHERE collaboration_server_id = ?",
        )
        .run(SERVER_ID);
      database
        .prepare(
          "UPDATE collaboration_servers SET state = 'repairing' WHERE collaboration_server_id = ?",
        )
        .run(SERVER_ID);
      expect(() =>
        database
          .prepare(
            "UPDATE collaboration_servers SET state = 'installing' WHERE collaboration_server_id = ?",
          )
          .run(SERVER_ID),
      ).toThrow(/state transition is not allowed/);
      database
        .prepare(
          "UPDATE collaboration_servers SET state = 'closed' WHERE collaboration_server_id = ?",
        )
        .run(SERVER_ID);
      expect(() =>
        database
          .prepare(
            "UPDATE collaboration_servers SET state = 'repairing' WHERE collaboration_server_id = ?",
          )
          .run(SERVER_ID),
      ).toThrow(/state transition is not allowed/);
    } finally {
      database.close();
    }
  });

  it("makes applied migration history append-only at the database boundary", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of HOST_STATE_MIGRATIONS) {
        for (const statement of migration.statements) database.exec(statement);
      }
      database
        .prepare(
          `INSERT INTO host_state_migrations
             (schema_version, migration_id, migration_digest, applied_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(1, "001-initial-host-state", PINNED_VERSION_ONE_DIGEST, 1);

      expect(() =>
        database
          .prepare("UPDATE host_state_migrations SET applied_at_ms = 2 WHERE schema_version = 1")
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        database.prepare("DELETE FROM host_state_migrations WHERE schema_version = 1").run(),
      ).toThrow(/append-only/);
      expect(() =>
        database
          .prepare(
            `INSERT OR REPLACE INTO host_state_migrations
               (schema_version, migration_id, migration_digest, applied_at_ms)
             VALUES (1, 'changed-id', ?, 2)`,
          )
          .run(PINNED_VERSION_ONE_DIGEST),
      ).toThrow(/append-only/);
    } finally {
      database.close();
    }
  });

  it("makes protected artifacts immutable at the database boundary", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of HOST_STATE_MIGRATIONS) {
        for (const statement of migration.statements) database.exec(statement);
      }
      expect(database.prepare("PRAGMA recursive_triggers").get()).toEqual({
        recursive_triggers: 0,
      });
      database
        .prepare(
          `INSERT INTO protected_artifacts
             (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
              artifact_digest, byte_length, artifact_bytes, created_at_ms)
           VALUES (?, 'artifact', 'host_profile', 'default', ?, ?, 1, ?, 1)`,
        )
        .run(
          "rcph_AAAAAAAAAAAAAAAAAAAAAA",
          "test/v1",
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          Uint8Array.of(1),
        );

      expect(() =>
        database.prepare("UPDATE protected_artifacts SET created_at_ms = 2").run(),
      ).toThrow(/immutable/);
      expect(() => database.prepare("DELETE FROM protected_artifacts").run()).toThrow(/immutable/);
      expect(() =>
        database
          .prepare(
            `INSERT OR REPLACE INTO protected_artifacts
               (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
                artifact_digest, byte_length, artifact_bytes, created_at_ms)
             VALUES (?, 'artifact', 'host_profile', 'default', ?, ?, 1, ?, 2)`,
          )
          .run(
            "rcph_AAAAAAAAAAAAAAAAAAAAAA",
            "test/v1",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            Uint8Array.of(2),
          ),
      ).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });
});
