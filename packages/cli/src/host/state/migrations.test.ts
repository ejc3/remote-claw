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
const PINNED_VERSION_FOUR_DIGEST = "zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0";

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
const RUNTIME_ID = `rcrt_${encoded(32, 10)}`;
const WARDEN_LAUNCH_NONCE = encoded(32, 11);
const PUBLIC_KEY = encoded(32, 12);
const SIGNATURE = encoded(64, 13);
const SIGNING_KEY_HANDLE_ID = `rcph_${encoded(16, 14)}`;
const RUNTIME_OWNER_LEASE_ID = "runtime-owner-lease-1";
const RUNTIME_OWNER_ASSIGNMENT_ID = "runtime-owner-assignment-1";

function applyMigrations(database: DatabaseSync, through = HOST_STATE_SCHEMA_VERSION): void {
  for (const migration of HOST_STATE_MIGRATIONS.slice(0, through)) {
    for (const statement of migration.statements) database.exec(statement);
  }
}

function insertMetadata(
  database: DatabaseSync,
  schemaVersion = 3,
  migrationDigest = PINNED_VERSION_THREE_DIGEST,
): void {
  database
    .prepare(
      `INSERT INTO host_state_metadata
         (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
       VALUES (1, ?, ?, ?, 1)`,
    )
    .run(MACHINE_IDENTITY_ID, schemaVersion, migrationDigest);
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
  applyMigrations(database, 3);
  insertMetadata(database);
  insertDefaultServer(database);
  return database;
}

function openedV4Database(): DatabaseSync {
  const database = openedV3Database();
  const migration = HOST_STATE_MIGRATIONS[3];
  if (migration === undefined) throw new Error("missing v4 migration");
  for (const statement of migration.statements) database.exec(statement);
  database
    .prepare(
      `UPDATE host_state_metadata
       SET schema_version = 4, migration_digest = ?
       WHERE singleton = 1`,
    )
    .run(PINNED_VERSION_FOUR_DIGEST);
  return database;
}

function acquireRuntimeOwner(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO runtime_owner_service_leases
           (runtime_owner_service_lease_id, machine_identity_id, runtime_owner_service_epoch,
            owner_instance_id, owner_process_start_identity_schema_id,
            owner_process_start_identity_ref, owner_process_start_identity_digest,
            acquired_at_ms, initial_heartbeat_deadline_ms, heartbeat_deadline_ms,
            released_at_ms, state)
         VALUES (?, ?, 1, 'owner-instance-1', 'process-start/v1', 'process-start-1', ?,
                 10, 100, 100, NULL, 'current')`,
      )
      .run(RUNTIME_OWNER_LEASE_ID, MACHINE_IDENTITY_ID, DIGEST);
    database
      .prepare(
        `UPDATE runtime_owner_state
         SET current_runtime_owner_service_epoch = 1,
             current_runtime_owner_service_lease_id = ?
         WHERE singleton = 1`,
      )
      .run(RUNTIME_OWNER_LEASE_ID);
    database
      .prepare(
        `INSERT INTO runtime_owner_journal_entries
           (journal_offset, entry_kind, subject_kind, subject_id, operation_id,
            operation_schema_id, operation_digest, runtime_owner_service_lease_id,
            runtime_owner_service_epoch, committed_at_ms)
         VALUES (0, 'service_lease_acquired', 'service_lease', ?, 'acquire-owner-1',
                 'runtime-owner-acquire/v1', ?, ?, 1, 10)`,
      )
      .run(RUNTIME_OWNER_LEASE_ID, DIGEST, RUNTIME_OWNER_LEASE_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertInitialRuntime(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO native_runtimes
           (runtime_id, descriptor_product, descriptor_access, warden_launch_nonce,
            initial_start_identity_schema_id, initial_start_identity_ref,
            initial_start_identity_digest, current_native_incarnation,
            current_runtime_owner_assignment_id, next_local_transition_seq,
            created_at_ms, closed_at_ms, state)
         VALUES (?, 'codex', 'app-server', ?, 'codex-start/v1', 'start-identity-1', ?,
                 1, ?, 1, 12, NULL, 'current')`,
      )
      .run(RUNTIME_ID, WARDEN_LAUNCH_NONCE, DIGEST, RUNTIME_OWNER_ASSIGNMENT_ID);
    database
      .prepare(
        `INSERT INTO native_runtime_incarnations
           (runtime_id, native_incarnation, descriptor_product, descriptor_access,
            runtime_owner_service_lease_id, runtime_owner_service_epoch,
            start_identity_schema_id, start_identity_ref, start_identity_digest,
            started_at_ms, closed_at_ms, state)
         VALUES (?, 1, 'codex', 'app-server', ?, 1, 'codex-start/v1',
                 'start-identity-1', ?, 12, NULL, 'current')`,
      )
      .run(RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, DIGEST);
    database
      .prepare(
        `INSERT INTO runtime_owner_assignments
           (runtime_owner_assignment_id, runtime_id, native_incarnation,
            assignment_generation, runtime_owner_service_lease_id,
            runtime_owner_service_epoch, assigned_at_ms, assignment_evidence_schema_id,
            assignment_evidence_ref, assignment_evidence_digest,
            supersedes_runtime_owner_assignment_id, reason)
         VALUES (?, ?, 1, 1, ?, 1, 12, 'runtime-owner-assignment/v1',
                 'assignment-evidence-1', ?, NULL, 'creation')`,
      )
      .run(RUNTIME_OWNER_ASSIGNMENT_ID, RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, DIGEST);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("A1 host-state migrations", () => {
  it("pins the application id, schema version, and exact migration digests", () => {
    expect(HOST_STATE_APPLICATION_ID).toBe(0x52434c57);
    expect(HOST_STATE_SCHEMA_VERSION).toBe(4);
    expect(HOST_STATE_MIGRATION_DIGESTS).toEqual([
      PINNED_VERSION_ONE_DIGEST,
      PINNED_VERSION_TWO_DIGEST,
      PINNED_VERSION_THREE_DIGEST,
      PINNED_VERSION_FOUR_DIGEST,
    ]);
    expect(HOST_STATE_SCHEMA_MANIFEST).toEqual({
      applicationId: 0x52434c57,
      schemaVersion: 4,
      migrationDigest: PINNED_VERSION_FOUR_DIGEST,
      sqliteSchema: HOST_STATE_SQLITE_SCHEMA_MANIFEST,
    });
    expect(expectedHostStateSqliteSchemaManifest(1)).toHaveLength(6);
    expect(expectedHostStateSqliteSchemaManifest(2)).toHaveLength(10);
    expect(expectedHostStateSqliteSchemaManifest(3)).toHaveLength(91);
    expect(expectedHostStateSqliteSchemaManifest(4)).toHaveLength(231);
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
    expect(expectedHostStateMigrationDigest(4)).toBe(PINNED_VERSION_FOUR_DIGEST);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 1)).toBe(true);
    expect(isExpectedHostStateMigrationDigest(`${PINNED_VERSION_ONE_DIGEST}=`, 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest("A".repeat(43), 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 2)).toBe(false);
    expect(() => expectedHostStateMigrationDigest(0)).toThrow(/not supported/);
    expect(() => expectedHostStateMigrationDigest(5)).toThrow(/not supported/);
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

      expect(rows.filter((row) => row.type === "table")).toHaveLength(30);
      expect(rows.filter((row) => row.type === "index")).toHaveLength(57);
      expect(rows.filter((row) => row.type === "trigger")).toHaveLength(144);
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
        database
          .prepare("PRAGMA table_info(runtime_owner_private_keys)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "protected_handle_id",
        "runtime_id",
        "runtime_owner_identity_key_id",
        "key_generation",
        "wrapping_schema_id",
        "wrap_nonce",
        "wrapped_pkcs8",
        "auth_tag",
        "pkcs8_digest",
        "created_at_ms",
        "destroyed_at_ms",
        "state",
      ]);
      expect(
        database
          .prepare("PRAGMA table_info(native_runtime_containments)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "native_runtime_containment_id",
        "runtime_id",
        "predecessor_native_incarnation",
        "successor_native_incarnation",
        "kind",
        "evidence_schema_id",
        "evidence_ref",
        "evidence_digest",
        "runtime_owner_service_lease_id",
        "runtime_owner_service_epoch",
        "contained_at_ms",
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
      if (migration === undefined) throw new Error("missing v3 migration");
      expect(migration.id).toBe("003-durable-host-records");
      expect(migration.statements).toHaveLength(81);
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

  it("migrates an exact v3 database to the empty v4 runtime-owner graph", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys=ON");
      database.exec("PRAGMA recursive_triggers=ON");
      applyMigrations(database, 3);
      insertMetadata(database);

      const migration = HOST_STATE_MIGRATIONS[3];
      if (migration === undefined) throw new Error("missing v4 migration");
      expect(migration.id).toBe("004-runtime-owner-durability");
      expect(migration.statements).toHaveLength(141);
      for (const statement of migration.statements) database.exec(statement);

      const actual = database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
           ORDER BY type, name`,
        )
        .all();
      const expected = [...expectedHostStateSqliteSchemaManifest(4)].sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type.localeCompare(right.type),
      );
      expect(actual).toEqual(expected);
      expect(database.prepare("SELECT * FROM runtime_owner_state").all()).toEqual([
        {
          singleton: 1,
          machine_identity_id: MACHINE_IDENTITY_ID,
          current_runtime_owner_service_epoch: 0,
          current_runtime_owner_service_lease_id: null,
          next_journal_offset: 0,
          created_at_ms: 1,
        },
      ]);
      for (const table of [
        "runtime_owner_service_leases",
        "runtime_owner_journal_entries",
        "native_runtimes",
        "native_runtime_incarnations",
        "runtime_owner_assignments",
        "native_runtime_containments",
        "runtime_owner_identity_keys",
        "runtime_owner_private_keys",
        "runtime_owner_signature_reservations",
        "runtime_owner_signed_record_acceptances",
        "local_native_conversations",
        "local_native_conversation_transitions",
        "native_binding_incarnations",
        "native_transport_attachments",
        "native_transport_leases",
        "binding_lifecycle_gates",
      ]) {
        expect(database.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
      }
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("fences runtime-owner acquisition, heartbeat, release, and journal order", () => {
    const database = openedV4Database();
    try {
      acquireRuntimeOwner(database);
      expect(
        database
          .prepare(
            `SELECT current_runtime_owner_service_epoch, current_runtime_owner_service_lease_id,
                    next_journal_offset
             FROM runtime_owner_state WHERE singleton = 1`,
          )
          .get(),
      ).toEqual({
        current_runtime_owner_service_epoch: 1,
        current_runtime_owner_service_lease_id: RUNTIME_OWNER_LEASE_ID,
        next_journal_offset: 1,
      });

      database
        .prepare(
          `UPDATE runtime_owner_service_leases
           SET heartbeat_deadline_ms = 120
           WHERE runtime_owner_service_lease_id = ?`,
        )
        .run(RUNTIME_OWNER_LEASE_ID);
      expect(() =>
        database
          .prepare(
            `UPDATE runtime_owner_service_leases
             SET heartbeat_deadline_ms = 110
             WHERE runtime_owner_service_lease_id = ?`,
          )
          .run(RUNTIME_OWNER_LEASE_ID),
      ).toThrow(/strictly extend/);

      database.exec("BEGIN");
      try {
        database
          .prepare(
            `UPDATE runtime_owner_service_leases
             SET state = 'released', released_at_ms = 50
             WHERE runtime_owner_service_lease_id = ?`,
          )
          .run(RUNTIME_OWNER_LEASE_ID);
        database
          .prepare(
            `INSERT INTO runtime_owner_journal_entries
               (journal_offset, entry_kind, subject_kind, subject_id, operation_id,
                operation_schema_id, operation_digest, runtime_owner_service_lease_id,
                runtime_owner_service_epoch, committed_at_ms)
             VALUES (1, 'service_lease_released', 'service_lease', ?, 'release-owner-1',
                     'runtime-owner-release/v1', ?, ?, 1, 50)`,
          )
          .run(RUNTIME_OWNER_LEASE_ID, DIGEST, RUNTIME_OWNER_LEASE_ID);
        database
          .prepare(
            `UPDATE runtime_owner_state
             SET current_runtime_owner_service_lease_id = NULL
             WHERE singleton = 1`,
          )
          .run();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      expect(() =>
        database
          .prepare(
            `INSERT INTO runtime_owner_service_leases
               (runtime_owner_service_lease_id, machine_identity_id,
                runtime_owner_service_epoch, owner_instance_id,
                owner_process_start_identity_schema_id, owner_process_start_identity_ref,
                owner_process_start_identity_digest, acquired_at_ms,
                initial_heartbeat_deadline_ms, heartbeat_deadline_ms, released_at_ms, state)
             VALUES ('runtime-owner-lease-too-early', ?, 2, 'owner-instance-2',
                     'process-start/v1', 'process-start-2', ?, 49, 149, 149, NULL, 'current')`,
          )
          .run(MACHINE_IDENTITY_ID, DIGEST),
      ).toThrow(/next fenced epoch/);

      database
        .prepare(
          `INSERT INTO runtime_owner_service_leases
             (runtime_owner_service_lease_id, machine_identity_id,
              runtime_owner_service_epoch, owner_instance_id,
              owner_process_start_identity_schema_id, owner_process_start_identity_ref,
              owner_process_start_identity_digest, acquired_at_ms,
              initial_heartbeat_deadline_ms, heartbeat_deadline_ms, released_at_ms, state)
           VALUES ('runtime-owner-lease-2', ?, 2, 'owner-instance-2',
                   'process-start/v1', 'process-start-2', ?, 50, 150, 150, NULL, 'current')`,
        )
        .run(MACHINE_IDENTITY_ID, DIGEST);
      database
        .prepare(
          `UPDATE runtime_owner_state
           SET current_runtime_owner_service_epoch = 2,
               current_runtime_owner_service_lease_id = 'runtime-owner-lease-2'
           WHERE singleton = 1`,
        )
        .run();
      expect(
        database
          .prepare(
            `SELECT state, released_at_ms
             FROM runtime_owner_service_leases
             WHERE runtime_owner_service_lease_id = ?`,
          )
          .get(RUNTIME_OWNER_LEASE_ID),
      ).toEqual({ state: "released", released_at_ms: 50 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps runtime lineage, owner assignments, containment, and local transitions durable", () => {
    const database = openedV4Database();
    try {
      acquireRuntimeOwner(database);
      insertInitialProject(database);
      insertInitialRuntime(database);

      expect(() =>
        database
          .prepare(
            `INSERT INTO runtime_owner_assignments
               (runtime_owner_assignment_id, runtime_id, native_incarnation,
                assignment_generation, runtime_owner_service_lease_id,
                runtime_owner_service_epoch, assigned_at_ms, assignment_evidence_schema_id,
                assignment_evidence_ref, assignment_evidence_digest,
                supersedes_runtime_owner_assignment_id, reason)
             VALUES ('assignment-gap', ?, 1, 3, ?, 1, 20, 'assignment/v1',
                     'assignment-gap-evidence', ?, ?, 'takeover')`,
          )
          .run(RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, DIGEST, RUNTIME_OWNER_ASSIGNMENT_ID),
      ).toThrow(/exact predecessor/);

      database
        .prepare(
          `INSERT INTO local_native_conversations
             (local_native_conversation_id, descriptor_product, descriptor_access,
              project_id, runtime_id, native_incarnation, semantic_conversation_id,
              parent_local_native_conversation_id, state)
           VALUES ('local-conversation-1', 'codex', 'app-server', ?, ?, 1,
                   'codex-thread-1', NULL, 'open')`,
        )
        .run(PROJECT_ID, RUNTIME_ID);
      database
        .prepare(
          `INSERT INTO local_native_conversation_transitions
             (local_transition_id, runtime_id, native_incarnation, local_transition_seq,
              kind, source_local_native_conversation_id, target_local_native_conversation_id,
              observed_semantic_conversation_id, native_evidence_ref,
              native_evidence_schema_id, native_evidence_digest, observed_at_ms)
           VALUES ('local-transition-1', ?, 1, 1, 'discover', NULL,
                   'local-conversation-1', 'codex-thread-1', 'native-evidence-1',
                   'codex-native-evidence/v1', ?, 20)`,
        )
        .run(RUNTIME_ID, DIGEST);
      expect(
        database
          .prepare("SELECT next_local_transition_seq FROM native_runtimes WHERE runtime_id = ?")
          .get(RUNTIME_ID),
      ).toEqual({ next_local_transition_seq: 2 });
      expect(() =>
        database
          .prepare(
            `INSERT INTO local_native_conversation_transitions
               (local_transition_id, runtime_id, native_incarnation, local_transition_seq,
                kind, source_local_native_conversation_id, target_local_native_conversation_id,
                observed_semantic_conversation_id, native_evidence_ref,
                native_evidence_schema_id, native_evidence_digest, observed_at_ms)
             VALUES ('local-transition-gap', ?, 1, 3, 'archive', 'local-conversation-1',
                     'local-conversation-1', 'codex-thread-1', 'native-evidence-gap',
                     'codex-native-evidence/v1', ?, 21)`,
          )
          .run(RUNTIME_ID, DIGEST),
      ).toThrow(/next runtime sequence/);

      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO runtime_owner_service_leases
               (runtime_owner_service_lease_id, machine_identity_id,
                runtime_owner_service_epoch, owner_instance_id,
                owner_process_start_identity_schema_id, owner_process_start_identity_ref,
                owner_process_start_identity_digest, acquired_at_ms,
                initial_heartbeat_deadline_ms, heartbeat_deadline_ms, released_at_ms, state)
             VALUES ('runtime-owner-lease-2', ?, 2, 'owner-instance-2',
                     'process-start/v1', 'process-start-2', ?, 100, 200, 200, NULL, 'current')`,
          )
          .run(MACHINE_IDENTITY_ID, DIGEST);
        database
          .prepare(
            `UPDATE runtime_owner_state
             SET current_runtime_owner_service_epoch = 2,
                 current_runtime_owner_service_lease_id = 'runtime-owner-lease-2'
             WHERE singleton = 1`,
          )
          .run();
        database
          .prepare(
            `INSERT INTO runtime_owner_journal_entries
               (journal_offset, entry_kind, subject_kind, subject_id, operation_id,
                operation_schema_id, operation_digest, runtime_owner_service_lease_id,
                runtime_owner_service_epoch, committed_at_ms)
             VALUES (1, 'service_lease_acquired', 'service_lease',
                     'runtime-owner-lease-2', 'acquire-owner-2',
                     'runtime-owner-acquire/v1', ?, 'runtime-owner-lease-2', 2, 100)`,
          )
          .run(DIGEST);
        database
          .prepare(
            `INSERT INTO runtime_owner_assignments
               (runtime_owner_assignment_id, runtime_id, native_incarnation,
                assignment_generation, runtime_owner_service_lease_id,
                runtime_owner_service_epoch, assigned_at_ms, assignment_evidence_schema_id,
                assignment_evidence_ref, assignment_evidence_digest,
                supersedes_runtime_owner_assignment_id, reason)
             VALUES ('runtime-owner-assignment-2', ?, 1, 2, 'runtime-owner-lease-2', 2,
                     100, 'runtime-owner-assignment/v1', 'assignment-evidence-2', ?, ?,
                     'takeover')`,
          )
          .run(RUNTIME_ID, DIGEST, RUNTIME_OWNER_ASSIGNMENT_ID);
        database
          .prepare(
            `UPDATE native_runtimes
             SET current_runtime_owner_assignment_id = 'runtime-owner-assignment-2'
             WHERE runtime_id = ?`,
          )
          .run(RUNTIME_ID);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      expect(
        database
          .prepare(
            `SELECT current_native_incarnation, current_runtime_owner_assignment_id
             FROM native_runtimes WHERE runtime_id = ?`,
          )
          .get(RUNTIME_ID),
      ).toEqual({
        current_native_incarnation: 1,
        current_runtime_owner_assignment_id: "runtime-owner-assignment-2",
      });

      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO native_runtime_containments
               (native_runtime_containment_id, runtime_id,
                predecessor_native_incarnation, successor_native_incarnation, kind,
                evidence_schema_id, evidence_ref, evidence_digest,
                runtime_owner_service_lease_id, runtime_owner_service_epoch, contained_at_ms)
             VALUES ('runtime-containment-1', ?, 1, NULL, 'termination',
                     'runtime-containment/v1', 'containment-evidence-1', ?,
                     'runtime-owner-lease-2', 2, 110)`,
          )
          .run(RUNTIME_ID, DIGEST);
        database
          .prepare(
            `UPDATE native_runtime_incarnations
             SET state = 'closed', closed_at_ms = 110
             WHERE runtime_id = ? AND native_incarnation = 1`,
          )
          .run(RUNTIME_ID);
        database
          .prepare(
            `UPDATE native_runtimes
             SET current_native_incarnation = NULL,
                 current_runtime_owner_assignment_id = NULL,
                 closed_at_ms = 110,
                 state = 'closed'
             WHERE runtime_id = ?`,
          )
          .run(RUNTIME_ID);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      expect(() =>
        database
          .prepare(
            "DELETE FROM native_runtime_containments WHERE native_runtime_containment_id = 'runtime-containment-1'",
          )
          .run(),
      ).toThrow(/retained/);
      expect(() =>
        database
          .prepare("UPDATE native_runtimes SET closed_at_ms = 111 WHERE runtime_id = ?")
          .run(RUNTIME_ID),
      ).toThrow(/state transition/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("advances a runtime incarnation only after durable replacement containment", () => {
    const database = openedV4Database();
    try {
      acquireRuntimeOwner(database);
      insertInitialRuntime(database);
      expect(() =>
        database
          .prepare(
            `INSERT INTO native_runtime_incarnations
               (runtime_id, native_incarnation, descriptor_product, descriptor_access,
                runtime_owner_service_lease_id, runtime_owner_service_epoch,
                start_identity_schema_id, start_identity_ref, start_identity_digest,
                started_at_ms, closed_at_ms, state)
             VALUES (?, 2, 'codex', 'app-server', ?, 1, 'codex-start/v1',
                     'start-identity-2', ?, 20, NULL, 'starting')`,
          )
          .run(RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, DIGEST),
      ).toThrow(/contained predecessor/);

      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO native_runtime_containments
               (native_runtime_containment_id, runtime_id,
                predecessor_native_incarnation, successor_native_incarnation, kind,
                evidence_schema_id, evidence_ref, evidence_digest,
                runtime_owner_service_lease_id, runtime_owner_service_epoch, contained_at_ms)
             VALUES ('runtime-replacement-1', ?, 1, 2, 'replacement',
                     'runtime-replacement/v1', 'replacement-evidence-1', ?, ?, 1, 20)`,
          )
          .run(RUNTIME_ID, DIGEST, RUNTIME_OWNER_LEASE_ID);
        database
          .prepare(
            `UPDATE native_runtime_incarnations
             SET state = 'closed', closed_at_ms = 20
             WHERE runtime_id = ? AND native_incarnation = 1`,
          )
          .run(RUNTIME_ID);
        database
          .prepare(
            `INSERT INTO native_runtime_incarnations
               (runtime_id, native_incarnation, descriptor_product, descriptor_access,
                runtime_owner_service_lease_id, runtime_owner_service_epoch,
                start_identity_schema_id, start_identity_ref, start_identity_digest,
                started_at_ms, closed_at_ms, state)
             VALUES (?, 2, 'codex', 'app-server', ?, 1, 'codex-start/v1',
                     'start-identity-2', ?, 20, NULL, 'starting')`,
          )
          .run(RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, DIGEST);
        database
          .prepare(
            `INSERT INTO runtime_owner_assignments
               (runtime_owner_assignment_id, runtime_id, native_incarnation,
                assignment_generation, runtime_owner_service_lease_id,
                runtime_owner_service_epoch, assigned_at_ms, assignment_evidence_schema_id,
                assignment_evidence_ref, assignment_evidence_digest,
                supersedes_runtime_owner_assignment_id, reason)
             VALUES ('runtime-owner-assignment-inc2', ?, 2, 1, ?, 1, 20,
                     'runtime-owner-assignment/v1', 'assignment-evidence-inc2', ?,
                     NULL, 'creation')`,
          )
          .run(RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, DIGEST);
        database
          .prepare(
            `UPDATE native_runtimes
             SET current_native_incarnation = 2,
                 current_runtime_owner_assignment_id = 'runtime-owner-assignment-inc2'
             WHERE runtime_id = ?`,
          )
          .run(RUNTIME_ID);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      expect(
        database
          .prepare(
            `SELECT current_native_incarnation, current_runtime_owner_assignment_id
             FROM native_runtimes WHERE runtime_id = ?`,
          )
          .get(RUNTIME_ID),
      ).toEqual({
        current_native_incarnation: 2,
        current_runtime_owner_assignment_id: "runtime-owner-assignment-inc2",
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("stores only wrapped signing keys and preserves signer sequence evidence", () => {
    const database = openedV4Database();
    try {
      acquireRuntimeOwner(database);
      insertInitialRuntime(database);

      const artifactHandle = `rcph_${encoded(16, 15)}`;
      database
        .prepare(
          `INSERT INTO protected_artifacts
             (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
              artifact_digest, byte_length, artifact_bytes, created_at_ms)
           VALUES (?, 'artifact', 'runtime', ?, 'test/v1', ?, 1, ?, 14)`,
        )
        .run(artifactHandle, RUNTIME_ID, DIGEST, Uint8Array.of(1));
      expect(() =>
        database
          .prepare(
            `INSERT INTO runtime_owner_private_keys
               (protected_handle_id, runtime_id, runtime_owner_identity_key_id,
                key_generation, wrapping_schema_id, wrap_nonce, wrapped_pkcs8,
                auth_tag, pkcs8_digest, created_at_ms, destroyed_at_ms, state)
             VALUES (?, ?, 'uncommitted-key', 1,
                     'remote-claw/runtime-owner-key-wrap/aes-256-gcm/v1',
                     ?, ?, ?, ?, 15, NULL, 'current')`,
          )
          .run(
            artifactHandle,
            RUNTIME_ID,
            new Uint8Array(12).fill(1),
            new Uint8Array(64).fill(2),
            new Uint8Array(16).fill(3),
            DIGEST,
          ),
      ).toThrow(/artifact/);

      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO runtime_owner_identity_keys
               (runtime_owner_identity_key_id, runtime_id, key_generation, algorithm,
                public_key, signing_key_protected_handle_id, next_signer_sequence,
                local_trust_evidence_ref, local_trust_evidence_digest, state)
             VALUES ('runtime-key-1', ?, 1, 'Ed25519', ?, ?, 0,
                     'key-trust-evidence-1', ?, 'current')`,
          )
          .run(RUNTIME_ID, PUBLIC_KEY, SIGNING_KEY_HANDLE_ID, DIGEST);
        database
          .prepare(
            `INSERT INTO runtime_owner_private_keys
               (protected_handle_id, runtime_id, runtime_owner_identity_key_id,
                key_generation, wrapping_schema_id, wrap_nonce, wrapped_pkcs8,
                auth_tag, pkcs8_digest, created_at_ms, destroyed_at_ms, state)
             VALUES (?, ?, 'runtime-key-1', 1,
                     'remote-claw/runtime-owner-key-wrap/aes-256-gcm/v1',
                     ?, ?, ?, ?, 15, NULL, 'current')`,
          )
          .run(
            SIGNING_KEY_HANDLE_ID,
            RUNTIME_ID,
            new Uint8Array(12).fill(1),
            new Uint8Array(64).fill(2),
            new Uint8Array(16).fill(3),
            DIGEST,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      expect(() =>
        database
          .prepare(
            `INSERT INTO protected_artifacts
               (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
                artifact_digest, byte_length, artifact_bytes, created_at_ms)
             VALUES (?, 'artifact', 'runtime', ?, 'test/v1', ?, 1, ?, 16)`,
          )
          .run(SIGNING_KEY_HANDLE_ID, RUNTIME_ID, DIGEST, Uint8Array.of(1)),
      ).toThrow(/signing key/);

      database
        .prepare(
          `INSERT INTO runtime_owner_signature_reservations
             (runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
              signer_sequence, purpose, canonical_payload_schema_id,
              canonical_payload_ref, canonical_payload_digest, signed_record_digest,
              signature, signed_artifact_id, state)
           VALUES (?, 'runtime-key-1', 1, 0, 'native_root', NULL, NULL, NULL,
                   NULL, NULL, NULL, 'reserved')`,
        )
        .run(RUNTIME_ID);
      expect(
        database
          .prepare(
            `SELECT next_signer_sequence FROM runtime_owner_identity_keys
             WHERE runtime_id = ? AND key_generation = 1`,
          )
          .get(RUNTIME_ID),
      ).toEqual({ next_signer_sequence: 1 });
      database
        .prepare(
          `UPDATE runtime_owner_signature_reservations
           SET canonical_payload_schema_id = 'remote-claw/native-root-certificate/v1',
               canonical_payload_ref = 'native-root-payload-1',
               canonical_payload_digest = ?, state = 'bound'
           WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
             AND runtime_owner_key_generation = 1 AND signer_sequence = 0`,
        )
        .run(DIGEST, RUNTIME_ID);
      database
        .prepare(
          `UPDATE runtime_owner_signature_reservations
           SET signed_record_digest = ?, signature = ?,
               signed_artifact_id = 'native-root-artifact-1', state = 'signed'
           WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
             AND runtime_owner_key_generation = 1 AND signer_sequence = 0`,
        )
        .run(DIGEST, SIGNATURE, RUNTIME_ID);
      database
        .prepare(
          `INSERT INTO runtime_owner_signed_record_acceptances
             (runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
              signer_sequence, signed_record_digest, accepted_at_ms)
           VALUES (?, 'runtime-key-1', 1, 0, ?, 20)`,
        )
        .run(RUNTIME_ID, DIGEST);
      database
        .prepare(
          `INSERT INTO runtime_owner_signature_reservations
             (runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
              signer_sequence, purpose, canonical_payload_schema_id,
              canonical_payload_ref, canonical_payload_digest, signed_record_digest,
              signature, signed_artifact_id, state)
           VALUES (?, 'runtime-key-1', 1, 1, 'native_root',
                   'remote-claw/native-root-certificate/v1', 'native-root-payload-2', ?,
                   NULL, NULL, NULL, 'bound')`,
        )
        .run(RUNTIME_ID, encoded(32, 16));
      expect(() =>
        database
          .prepare(
            `UPDATE runtime_owner_signature_reservations
             SET signed_record_digest = ?, signature = ?,
                 signed_artifact_id = 'native-root-artifact-2', state = 'signed'
             WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
               AND runtime_owner_key_generation = 1 AND signer_sequence = 1`,
          )
          .run(DIGEST, SIGNATURE, RUNTIME_ID),
      ).toThrow(/UNIQUE/);
      expect(() =>
        database
          .prepare(
            `UPDATE runtime_owner_signature_reservations
             SET canonical_payload_digest = ?
             WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
               AND runtime_owner_key_generation = 1 AND signer_sequence = 1`,
          )
          .run(encoded(32, 17), RUNTIME_ID),
      ).toThrow(/lifecycle is monotonic/);
      expect(() =>
        database
          .prepare("UPDATE runtime_owner_signed_record_acceptances SET accepted_at_ms = 21")
          .run(),
      ).toThrow(/append-only/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("prepares exact binding runtime links without activating the v3 binding", () => {
    const database = openedV4Database();
    try {
      acquireRuntimeOwner(database);
      insertInitialProject(database);
      insertTerminalChat(database);
      insertInitialRuntime(database);

      database
        .prepare(
          `INSERT INTO native_binding_incarnations
             (native_binding_incarnation_id, collaboration_server_id, logical_chat_id,
              native_binding_id, runtime_id, native_incarnation, semantic_conversation_id,
              created_at_ms, closed_at_ms, state)
           VALUES ('binding-incarnation-1', ?, ?, ?, ?, 1, 'codex-thread-1',
                   20, NULL, 'current')`,
        )
        .run(SERVER_ID, CHAT_ID, BINDING_ID, RUNTIME_ID);
      database
        .prepare(
          `INSERT INTO native_transport_attachments
             (attachment_id, native_binding_id, kind, transport_id, generation,
              current_attachment_lease_id, resource_ownership,
              created_at_ms, closed_at_ms, state)
           VALUES ('attachment-1', ?, 'app-server', 'codex-app-server-1', 1,
                   NULL, 'shared_runtime', 20, NULL, 'current')`,
        )
        .run(BINDING_ID);
      database
        .prepare(
          `INSERT INTO binding_lifecycle_gates
             (native_binding_id, collaboration_server_id, logical_chat_id, runtime_id,
              native_incarnation, native_binding_incarnation_id, attachment_id,
              current_attachment_lease_id, phase, disconnect_policy,
              gate_generation, updated_at_ms)
           VALUES (?, ?, ?, ?, 1, 'binding-incarnation-1', 'attachment-1', NULL,
                   'starting', 'detach', 1, 20)`,
        )
        .run(BINDING_ID, SERVER_ID, CHAT_ID, RUNTIME_ID);

      expect(
        database
          .prepare(
            `SELECT semantic_conversation_id, current_binding_incarnation_id, state
             FROM native_bindings WHERE native_binding_id = ?`,
          )
          .get(BINDING_ID),
      ).toEqual({
        semantic_conversation_id: null,
        current_binding_incarnation_id: null,
        state: "starting",
      });
      expect(() =>
        database
          .prepare(
            `UPDATE binding_lifecycle_gates
             SET phase = 'ready', gate_generation = 2, updated_at_ms = 21
             WHERE native_binding_id = ?`,
          )
          .run(BINDING_ID),
      ).toThrow(/phase <> 'ready' OR current_attachment_lease_id IS NOT NULL/);
      expect(() =>
        database
          .prepare(
            `UPDATE native_bindings
             SET semantic_conversation_id = 'wrong-thread',
                 current_binding_incarnation_id = 'binding-incarnation-1',
                 state = 'current'
             WHERE native_binding_id = ?`,
          )
          .run(BINDING_ID),
      ).toThrow(/exact current incarnation/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("orders successor transport leases after the predecessor release", () => {
    const database = openedV4Database();
    try {
      acquireRuntimeOwner(database);
      insertInitialProject(database);
      insertTerminalChat(database);
      insertInitialRuntime(database);
      database
        .prepare(
          `INSERT INTO coordinator_leases
             (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
              heartbeat_deadline_ms, released_at_ms, state)
           VALUES (?, ?, 1, 'coordinator-1', 10, 100, 100, NULL, 'current')`,
        )
        .run(COORDINATOR_LEASE_ID, SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_servers
           SET current_coordinator_epoch = 1, current_coordinator_lease_id = ?
           WHERE collaboration_server_id = ?`,
        )
        .run(COORDINATOR_LEASE_ID, SERVER_ID);
      database
        .prepare(
          `INSERT INTO native_binding_incarnations
             (native_binding_incarnation_id, collaboration_server_id, logical_chat_id,
              native_binding_id, runtime_id, native_incarnation, semantic_conversation_id,
              created_at_ms, closed_at_ms, state)
           VALUES ('transport-binding-incarnation', ?, ?, ?, ?, 1, 'codex-thread-1',
                   20, NULL, 'current')`,
        )
        .run(SERVER_ID, CHAT_ID, BINDING_ID, RUNTIME_ID);
      database
        .prepare(
          `INSERT INTO native_transport_attachments
             (attachment_id, native_binding_id, kind, transport_id, generation,
              current_attachment_lease_id, resource_ownership,
              created_at_ms, closed_at_ms, state)
           VALUES ('transport-attachment', ?, 'app-server', 'codex-app-server-1', 1,
                   NULL, 'shared_runtime', 20, NULL, 'current')`,
        )
        .run(BINDING_ID);
      database
        .prepare(
          `INSERT INTO native_transport_leases
             (attachment_lease_id, attachment_id, native_binding_incarnation_id,
              runtime_id, native_incarnation, runtime_owner_service_lease_id,
              runtime_owner_service_epoch, coordinator_lease_id, coordinator_epoch,
              transport_epoch, current_capability_snapshot_id,
              current_native_client_ingress_lease_id, acquired_at_ms, released_at_ms, state)
           VALUES ('transport-lease-1', 'transport-attachment',
                   'transport-binding-incarnation', ?, 1, ?, 1, ?, 1, 1,
                   NULL, NULL, 20, NULL, 'current')`,
        )
        .run(RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, COORDINATOR_LEASE_ID);
      database
        .prepare(
          `UPDATE native_transport_attachments
           SET current_attachment_lease_id = 'transport-lease-1'
           WHERE attachment_id = 'transport-attachment'`,
        )
        .run();
      database
        .prepare(
          `UPDATE native_transport_leases
           SET released_at_ms = 30, state = 'superseded'
           WHERE attachment_lease_id = 'transport-lease-1'`,
        )
        .run();
      database
        .prepare(
          `UPDATE native_transport_attachments
           SET current_attachment_lease_id = NULL
           WHERE attachment_id = 'transport-attachment'`,
        )
        .run();

      const successorSql = `INSERT INTO native_transport_leases
        (attachment_lease_id, attachment_id, native_binding_incarnation_id,
         runtime_id, native_incarnation, runtime_owner_service_lease_id,
         runtime_owner_service_epoch, coordinator_lease_id, coordinator_epoch,
         transport_epoch, current_capability_snapshot_id,
         current_native_client_ingress_lease_id, acquired_at_ms, released_at_ms, state)
       VALUES (?, 'transport-attachment', 'transport-binding-incarnation', ?, 1, ?, 1,
               ?, 1, 2, NULL, NULL, ?, NULL, 'current')`;
      expect(() =>
        database
          .prepare(successorSql)
          .run(
            "transport-lease-too-early",
            RUNTIME_ID,
            RUNTIME_OWNER_LEASE_ID,
            COORDINATOR_LEASE_ID,
            29,
          ),
      ).toThrow(/exact owner and coordinator fences/);
      database
        .prepare(successorSql)
        .run("transport-lease-2", RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, COORDINATOR_LEASE_ID, 30);
      expect(
        database.prepare("SELECT state FROM native_runtimes WHERE runtime_id = ?").get(RUNTIME_ID),
      ).toEqual({ state: "current" });
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
