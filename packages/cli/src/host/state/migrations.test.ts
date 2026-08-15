import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { parseA1CanonicalId, parseA1SafeId } from "./ids.js";
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
import { nativeRootCertificateId } from "./native-root.js";

const PINNED_VERSION_ONE_DIGEST = "Pk8Yrc3jVK9xoHKDcBdeyejFYUSbyjnp-SH0VMA_Hec";
const PINNED_VERSION_TWO_DIGEST = "yx23Bca9rSZttCEInDAEOrzLVhq-KWcZLE1i27tqNiY";
const PINNED_VERSION_THREE_DIGEST = "cMLS59JfiV7fRoK68n1kZz3DN9Vo4yu7VZAX_HxHpq4";
const PINNED_VERSION_FOUR_DIGEST = "zx52EtAFNY9hEZneG3RW14zRCYR18gg7ysnltHbOkT0";
const PINNED_VERSION_FIVE_DIGEST = "l32ozsKKBm5ueLOk-_IeiasPgp_deE-tZHEbaZ6urOE";
const PINNED_VERSION_SIX_DIGEST = "li87zqB0yxSfRtN-p_xT5Yk2xAvX8Iy5a1xDXNTYYZo";
const PINNED_VERSION_SEVEN_DIGEST = "uShlOvT_fWScwCLQD1g6-GAd1YyKR2QIlGjC0SPQWbw";
const PINNED_VERSION_EIGHT_DIGEST = "6Vf2H56rDvW2PGMrU83upUDz1r9gHP11tdq_w7T1K5E";
const PINNED_VERSION_NINE_DIGEST = "fYrN5atmwIj-tlT_tTXmrg9kNF52ah-zWmgf7vVFQWE";
const PINNED_VERSION_TEN_DIGEST = "rdJC_2C5IyjfsTuXhxjFSzT0bvDYtlpT8o0xDvu4IEk";
const PINNED_VERSION_ELEVEN_DIGEST = "SkkuAFJed-7GT9XyXXPCub7VFauqNY6eu0u4IQJEInc";
const BROKER_CAPABILITY_PIN_ID = `rbcp_${encoded(32, 40)}`;
const BROKER_CAPABILITY_ARTIFACT_ID = `rcph_${encoded(16, 41)}`;
const BROKER_ROUTE_ID = `rcr_${encoded(32, 42)}`;
const SECOND_BROKER_ROUTE_ID = `rcr_${encoded(32, 43)}`;
const BROKER_STORE_ID = `rbsi_${encoded(16, 44)}`;
const SECOND_BROKER_STORE_ID = `rbsi_${encoded(16, 45)}`;
const BROKER_ROUTE_TOKEN = `ctl:a1:${encoded(32, 46)}`;
const SECOND_BROKER_ROUTE_TOKEN = `bus:a1:${encoded(32, 47)}`;
const CHANNEL_POSITION_ID = `rcp_${encoded(32, 48)}`;
const DELIVERY_ATTEMPT_ID = `rda_${encoded(16, 49)}`;
const RAW_FRAME_ARTIFACT_ID = `rcph_${encoded(16, 50)}`;
const GAP_EVIDENCE_ARTIFACT_ID = `rcph_${encoded(16, 51)}`;
const GAP_ID = "gap-invalid-frame-1";
const RECOVERY_ID = "recover-invalid-frame-1";
const SOURCE_NAMESPACE_ID = `wns_${encoded(32, 56)}`;
const SEMANTIC_RESULT_ID = `rrs_${encoded(32, 57)}`;
const INGRESS_OBSERVATION_ID = `rio_${encoded(32, 58)}`;
const PLAINTEXT_ARTIFACT_ID = `rcph_${encoded(16, 59)}`;

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
const NATIVE_CONVERSATION_LEASE_ID = `rcncl_${encoded(16, 18)}`;
const SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID = `rcncl_${encoded(16, 22)}`;
const PROTECTED_PORT_HANDLE_ID = `rcph_${encoded(16, 19)}`;
const SUCCESSOR_PROTECTED_PORT_HANDLE_ID = `rcph_${encoded(16, 23)}`;
const METADATA_HANDLE_ID = `rcph_${encoded(16, 20)}`;
const CAPABILITIES_HANDLE_ID = `rcph_${encoded(16, 21)}`;
const METADATA_DIGEST = encoded(32, 20);
const CAPABILITIES_DIGEST = encoded(32, 21);
const ROOT_PAYLOAD_HANDLE_ID = `rcph_${encoded(16, 24)}`;
const ROOT_PAYLOAD_DIGEST = encoded(32, 25);
const ROOT_SIGNED_RECORD_DIGEST = encoded(32, 26);
const ROOT_OPERATION_DIGEST = encoded(32, 27);
const ROOT_OPERATION_ID = "activate-native-root-1";
const ROOT_ID_SCOPE = {
  machineIdentityId: MACHINE_IDENTITY_ID,
  collaborationServerId: parseA1CanonicalId("collaborationServer", SERVER_ID),
  logicalChatId: parseA1CanonicalId("logicalChat", CHAT_ID),
} as const;
const ROOT_CERTIFICATE_ID = nativeRootCertificateId({
  ...ROOT_ID_SCOPE,
  operationId: parseA1SafeId(ROOT_OPERATION_ID),
});
const RENEW_PAYLOAD_HANDLE_ID = `rcph_${encoded(16, 28)}`;
const RENEW_PAYLOAD_DIGEST = encoded(32, 29);
const RENEW_SIGNED_RECORD_DIGEST = encoded(32, 30);
const RENEW_OPERATION_DIGEST = encoded(32, 31);
const RENEW_OPERATION_ID = "renew-native-root-2";
const RENEW_CERTIFICATE_ID = nativeRootCertificateId({
  ...ROOT_ID_SCOPE,
  operationId: parseA1SafeId(RENEW_OPERATION_ID),
});
const TAKEOVER_RENEW_PAYLOAD_HANDLE_ID = `rcph_${encoded(16, 32)}`;
const TAKEOVER_RENEW_PAYLOAD_DIGEST = encoded(32, 33);
const TAKEOVER_RENEW_SIGNED_RECORD_DIGEST = encoded(32, 34);
const TAKEOVER_RENEW_OPERATION_DIGEST = encoded(32, 35);
const TAKEOVER_RENEW_OPERATION_ID = "renew-native-root-after-takeover";
const TAKEOVER_RENEW_CERTIFICATE_ID = nativeRootCertificateId({
  ...ROOT_ID_SCOPE,
  operationId: parseA1SafeId(TAKEOVER_RENEW_OPERATION_ID),
});

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

function openedV5Database(): DatabaseSync {
  const database = openedV4Database();
  const migration = HOST_STATE_MIGRATIONS[4];
  if (migration === undefined) throw new Error("missing v5 migration");
  for (const statement of migration.statements) database.exec(statement);
  database
    .prepare(
      `UPDATE host_state_metadata
       SET schema_version = 5, migration_digest = ?
       WHERE singleton = 1`,
    )
    .run(PINNED_VERSION_FIVE_DIGEST);
  return database;
}

function openedV6Database(): DatabaseSync {
  const database = openedV5Database();
  const migration = HOST_STATE_MIGRATIONS[5];
  if (migration === undefined) throw new Error("missing v6 migration");
  for (const statement of migration.statements) database.exec(statement);
  database
    .prepare(
      `UPDATE host_state_metadata
       SET schema_version = 6, migration_digest = ?
       WHERE singleton = 1`,
    )
    .run(PINNED_VERSION_SIX_DIGEST);
  return database;
}

function openedV7Database(): DatabaseSync {
  const database = openedV6Database();
  const migration = HOST_STATE_MIGRATIONS[6];
  if (migration === undefined) throw new Error("missing v7 migration");
  for (const statement of migration.statements) database.exec(statement);
  database
    .prepare(
      `UPDATE host_state_metadata
       SET schema_version = 7, migration_digest = ?
       WHERE singleton = 1`,
    )
    .run(PINNED_VERSION_SEVEN_DIGEST);
  return database;
}

function prepareV7BrokerRoute(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO coordinator_leases (
         coordinator_lease_id, collaboration_server_id, coordinator_epoch,
         owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
         heartbeat_deadline_ms, released_at_ms, state
       ) VALUES (?, ?, 1, 'migration-coordinator', 10, 1000, 1000, NULL, 'current')`,
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
      `INSERT INTO protected_artifacts (
         protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
         artifact_digest, byte_length, artifact_bytes, created_at_ms
       ) VALUES (?, 'artifact', 'host_profile', 'default',
                 'remote-claw/broker-backend-capabilities/v1', ?, 1, ?, 20)`,
    )
    .run(BROKER_CAPABILITY_ARTIFACT_ID, DIGEST, Uint8Array.of(1));
  database
    .prepare(
      `INSERT INTO broker_backend_capability_pins (
         broker_backend_capability_pin_id, machine_identity_id, broker_origin,
         broker_backend_selector, canonical_payload_schema_id, canonical_payload_ref,
         canonical_payload_digest, observed_at_ms
       ) VALUES (?, ?, 'https://broker.example', 'sqlite',
                 'remote-claw/broker-backend-capabilities/v1', ?, ?, 20)`,
    )
    .run(BROKER_CAPABILITY_PIN_ID, MACHINE_IDENTITY_ID, BROKER_CAPABILITY_ARTIFACT_ID, DIGEST);
  database
    .prepare(
      `INSERT INTO broker_routes (
         broker_route_id, machine_identity_id, collaboration_server_id, route_kind,
         logical_chat_id, route_token, broker_origin, broker_backend_selector,
         broker_route_store_instance_id, genesis_generation,
         broker_backend_capabilities_ref, broker_backend_capabilities_digest,
         coordinator_lease_id, coordinator_epoch, created_at_ms, state
       ) VALUES (?, ?, ?, 'server_control', NULL, ?, 'https://broker.example', 'sqlite',
                 ?, 0, ?, ?, ?, 1, 30, 'current')`,
    )
    .run(
      BROKER_ROUTE_ID,
      MACHINE_IDENTITY_ID,
      SERVER_ID,
      BROKER_ROUTE_TOKEN,
      BROKER_STORE_ID,
      BROKER_CAPABILITY_PIN_ID,
      DIGEST,
      COORDINATOR_LEASE_ID,
    );
  database
    .prepare(
      `INSERT INTO broker_channel_generations (
         broker_route_id, channel_generation, frame_count, next_generation,
         state, manifest_digest
       ) VALUES (?, 0, NULL, NULL, 'open', NULL)`,
    )
    .run(BROKER_ROUTE_ID);
}

function openedV8BrokerRouteDatabase(): DatabaseSync {
  const database = openedV7Database();
  prepareV7BrokerRoute(database);
  const migration = HOST_STATE_MIGRATIONS[7];
  if (migration === undefined) throw new Error("missing v8 migration");
  for (const statement of migration.statements) database.exec(statement);
  return database;
}

function claimBrokerRouteActor(database: DatabaseSync, observedAtMs = 40): void {
  database
    .prepare(
      `UPDATE broker_route_actors
       SET revision = revision + 1, claim_token = 'claim-one',
           coordinator_lease_id = ?, coordinator_epoch = 1, claimed_at_ms = ?,
           last_operation_id = 'claim-operation-one', last_operation_kind = 'claim',
           last_operation_digest = ?, updated_at_ms = ?
       WHERE broker_route_id = ?`,
    )
    .run(COORDINATOR_LEASE_ID, observedAtMs, DIGEST, observedAtMs, BROKER_ROUTE_ID);
}

function insertIngressArtifact(
  database: DatabaseSync,
  handleId: string,
  schemaId: string,
  digest = DIGEST,
): void {
  database
    .prepare(
      `INSERT INTO protected_artifacts (
         protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
         artifact_digest, byte_length, artifact_bytes, created_at_ms
       ) VALUES (?, 'artifact', 'collaboration_server', ?, ?, ?, 1, ?, 40)`,
    )
    .run(handleId, SERVER_ID, schemaId, digest, Uint8Array.of(1));
}

function insertPendingPosition(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO authenticated_channel_positions (
         channel_position_observation_id, broker_route_id, collaboration_server_id,
         route_kind, logical_chat_id, channel_generation, frame_index,
         claimed_delivery_attempt_id, claimed_part, claimed_transport_frame_digest,
         received_frame_ref, received_frame_digest, received_frame_byte_length,
         normalized_transport_frame_digest, frame_identity_id,
         frame_collaboration_server_id, frame_logical_chat_id, direction, record_kind,
         sequence, message_id, delivery_attempt_id, client_message_id, key_epoch,
         part, parts, server_key_generation, host_signer_identity_key_id,
         host_scope_certificate_id, host_signature_sequence, stable_logical_header_digest,
         classification, validation_failure_code, ingress_observation_id,
         cursor_disposition, recovery_id, gap_id, observed_at_ms, classified_at_ms
       ) VALUES (?, ?, ?, 'server_control', NULL, 0, 0, ?, 0, ?, ?, ?, 1,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pending_validation',
                 NULL, NULL, 'blocked', NULL, NULL, 40, NULL)`,
    )
    .run(
      CHANNEL_POSITION_ID,
      BROKER_ROUTE_ID,
      SERVER_ID,
      DELIVERY_ATTEMPT_ID,
      DIGEST,
      RAW_FRAME_ARTIFACT_ID,
      DIGEST,
    );
}

function insertPendingPositionAt(
  database: DatabaseSync,
  positionId: string,
  frameIndex: number,
  deliveryAttemptId: string,
): void {
  database
    .prepare(
      `INSERT INTO authenticated_channel_positions (
         channel_position_observation_id, broker_route_id, collaboration_server_id,
         route_kind, logical_chat_id, channel_generation, frame_index,
         claimed_delivery_attempt_id, claimed_part, claimed_transport_frame_digest,
         received_frame_ref, received_frame_digest, received_frame_byte_length,
         classification, cursor_disposition, observed_at_ms
       ) VALUES (?, ?, ?, 'server_control', NULL, 0, ?, ?, 0, ?, ?, ?, 1,
                 'pending_validation', 'blocked', 40)`,
    )
    .run(
      positionId,
      BROKER_ROUTE_ID,
      SERVER_ID,
      frameIndex,
      deliveryAttemptId,
      DIGEST,
      RAW_FRAME_ARTIFACT_ID,
      DIGEST,
    );
}

function classifyInboundPosition(
  database: DatabaseSync,
  positionId: string,
  observationId: string,
  deliveryAttemptId: string,
  cursorDisposition: "blocked" | "advanceable",
  gapId: string | null,
  recoveryId: string | null = null,
  parts = 1,
): void {
  database
    .prepare(
      `UPDATE authenticated_channel_positions SET
         normalized_transport_frame_digest = ?, frame_identity_id = ?,
         frame_collaboration_server_id = ?, frame_logical_chat_id = NULL,
         direction = 'in', record_kind = 'new_chat', sequence = 0,
         message_id = 'message-one', delivery_attempt_id = ?, client_message_id = 'client-one',
         key_epoch = 0, part = 0, parts = ?, server_key_generation = 1,
         host_signer_identity_key_id = NULL, host_scope_certificate_id = NULL,
         host_signature_sequence = NULL, stable_logical_header_digest = ?,
         classification = 'inbound_ingress', ingress_observation_id = ?,
         cursor_disposition = ?, gap_id = ?, recovery_id = ?, classified_at_ms = 50
       WHERE channel_position_observation_id = ?`,
    )
    .run(
      DIGEST,
      MACHINE_IDENTITY_ID,
      SERVER_ID,
      deliveryAttemptId,
      parts,
      DIGEST,
      observationId,
      cursorDisposition,
      gapId,
      recoveryId,
      positionId,
    );
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

function takeOverRuntimeOwner(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO runtime_owner_service_leases
         (runtime_owner_service_lease_id, machine_identity_id,
          runtime_owner_service_epoch, owner_instance_id,
          owner_process_start_identity_schema_id, owner_process_start_identity_ref,
          owner_process_start_identity_digest, acquired_at_ms,
          initial_heartbeat_deadline_ms, heartbeat_deadline_ms,
          released_at_ms, state)
       VALUES ('runtime-owner-lease-2', ?, 2, 'owner-instance-2',
               'process-start/v1', 'process-start-2', ?, 100, 200, 200,
               NULL, 'current')`,
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

function prepareDurableRegistrationGraph(database: DatabaseSync): void {
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
       VALUES (?, ?, 1, 'coordinator-1', 10, 200, 200, NULL, 'current')`,
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
       VALUES ('registration-binding-incarnation', ?, ?, ?, ?, 1, 'codex-thread-1',
               20, NULL, 'current')`,
    )
    .run(SERVER_ID, CHAT_ID, BINDING_ID, RUNTIME_ID);
  database
    .prepare(
      `INSERT INTO native_transport_attachments
         (attachment_id, native_binding_id, kind, transport_id, generation,
          current_attachment_lease_id, resource_ownership,
          created_at_ms, closed_at_ms, state)
       VALUES ('registration-attachment', ?, 'app-server', 'codex-app-server-1', 1,
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
       VALUES ('registration-attachment-lease', 'registration-attachment',
               'registration-binding-incarnation', ?, 1, ?, 1, ?, 1, 1,
               NULL, NULL, 20, NULL, 'current')`,
    )
    .run(RUNTIME_ID, RUNTIME_OWNER_LEASE_ID, COORDINATOR_LEASE_ID);
  database
    .prepare(
      `UPDATE native_transport_attachments
       SET current_attachment_lease_id = 'registration-attachment-lease'
       WHERE attachment_id = 'registration-attachment'`,
    )
    .run();
}

function insertRegistrationArtifacts(database: DatabaseSync): void {
  const insert = database.prepare(
    `INSERT INTO protected_artifacts
       (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
        artifact_digest, byte_length, artifact_bytes, created_at_ms)
     VALUES (?, 'artifact', 'native_binding', ?, ?, ?, 1, ?, 24)`,
  );
  insert.run(
    METADATA_HANDLE_ID,
    BINDING_ID,
    "remote-claw/native-registration-metadata-evidence/v1",
    METADATA_DIGEST,
    Uint8Array.of(20),
  );
  insert.run(
    CAPABILITIES_HANDLE_ID,
    BINDING_ID,
    "remote-claw/native-conversation-capabilities/v1",
    CAPABILITIES_DIGEST,
    Uint8Array.of(21),
  );
}

function insertStartingConversationLease(
  database: DatabaseSync,
  options: {
    readonly leaseId?: string;
    readonly portHandleId?: string;
    readonly ownerLeaseId?: string;
    readonly ownerEpoch?: number;
    readonly acquiredAtMs?: number;
    readonly leaseGeneration?: number;
    readonly supersedesLeaseId?: string | null;
    readonly state?: "starting" | "recovering";
  } = {},
): void {
  database
    .prepare(
      `INSERT INTO native_conversation_leases
         (native_conversation_lease_id, collaboration_server_id, logical_chat_id,
          native_binding_id, registration_attempt_id, runtime_id, native_incarnation,
          native_binding_incarnation_id, attachment_lease_id,
          runtime_owner_service_lease_id, runtime_owner_service_epoch,
          coordinator_lease_id, coordinator_epoch, protected_port_handle_id,
          lease_generation, supersedes_native_conversation_lease_id,
          current_publication_id, next_operation_sequence,
          acquired_at_ms, updated_at_ms, closed_at_ms, state)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?, 1, ?, ?, ?,
               NULL, 1, ?, ?, NULL, ?)`,
    )
    .run(
      options.leaseId ?? NATIVE_CONVERSATION_LEASE_ID,
      SERVER_ID,
      CHAT_ID,
      BINDING_ID,
      REGISTRATION_ATTEMPT_ID,
      RUNTIME_ID,
      options.ownerLeaseId ?? RUNTIME_OWNER_LEASE_ID,
      options.ownerEpoch ?? 1,
      COORDINATOR_LEASE_ID,
      options.portHandleId ?? PROTECTED_PORT_HANDLE_ID,
      options.leaseGeneration ?? 1,
      options.supersedesLeaseId ?? null,
      options.acquiredAtMs ?? 25,
      options.acquiredAtMs ?? 25,
      options.state ?? "starting",
    );
}

function insertRegistrationOperation(
  database: DatabaseSync,
  operationId: string,
  operationSequence: number,
  kind: string,
  committedAtMs: number,
  fences: {
    readonly ownerLeaseId?: string;
    readonly ownerEpoch?: number;
    readonly coordinatorLeaseId?: string;
    readonly coordinatorEpoch?: number;
    readonly leaseId?: string;
  } = {},
): void {
  database
    .prepare(
      `INSERT INTO native_registration_operations
         (operation_id, operation_sequence, kind, operation_schema_id,
          operation_digest, native_conversation_lease_id, native_binding_id,
          runtime_owner_service_lease_id, runtime_owner_service_epoch,
          coordinator_lease_id, coordinator_epoch,
          committed_at_ms)
       VALUES (?, ?, ?, 'remote-claw/native-registration-operation/v1', ?, ?, ?,
               ?, ?, ?, ?, ?)`,
    )
    .run(
      operationId,
      operationSequence,
      kind,
      DIGEST,
      fences.leaseId ?? NATIVE_CONVERSATION_LEASE_ID,
      BINDING_ID,
      fences.ownerLeaseId ?? RUNTIME_OWNER_LEASE_ID,
      fences.ownerEpoch ?? 1,
      fences.coordinatorLeaseId ?? COORDINATOR_LEASE_ID,
      fences.coordinatorEpoch ?? 1,
      committedAtMs,
    );
}

function prepareReadyNativeRootGraph(database: DatabaseSync): void {
  prepareDurableRegistrationGraph(database);
  insertRegistrationArtifacts(database);
  insertStartingConversationLease(database);
  insertRegistrationOperation(database, "operation-open", 1, "open", 25);
  insertRegistrationOperation(database, "operation-bind", 2, "bind", 30);
  database
    .prepare(
      `UPDATE native_conversation_leases
       SET native_binding_incarnation_id = 'registration-binding-incarnation',
           attachment_lease_id = 'registration-attachment-lease', updated_at_ms = 30
       WHERE native_conversation_lease_id = ?`,
    )
    .run(NATIVE_CONVERSATION_LEASE_ID);
  database
    .prepare(
      `INSERT INTO native_registration_publications
         (native_registration_publication_id, native_conversation_lease_id,
          native_binding_id, runtime_id, native_incarnation,
          native_binding_incarnation_id, attachment_lease_id,
          publication_generation, metadata_schema_id, metadata_ref,
          metadata_digest, capabilities_schema_id, capabilities_ref,
          capabilities_digest, published_at_ms, state)
       VALUES ('registration-publication-1', ?, ?, ?, 1,
               'registration-binding-incarnation', 'registration-attachment-lease',
               1, 'provider-metadata/v1', ?, ?,
               'remote-claw/native-conversation-capabilities/v1', ?, ?, 30, 'current')`,
    )
    .run(
      NATIVE_CONVERSATION_LEASE_ID,
      BINDING_ID,
      RUNTIME_ID,
      METADATA_HANDLE_ID,
      METADATA_DIGEST,
      CAPABILITIES_HANDLE_ID,
      CAPABILITIES_DIGEST,
    );
  insertRegistrationOperation(database, "operation-publish", 3, "publish", 30);
  database
    .prepare(
      `UPDATE native_conversation_leases
       SET current_publication_id = 'registration-publication-1', updated_at_ms = 30
       WHERE native_conversation_lease_id = ?`,
    )
    .run(NATIVE_CONVERSATION_LEASE_ID);
  insertRegistrationOperation(database, "operation-ready", 4, "ready", 30);
  database
    .prepare(
      `UPDATE native_conversation_leases
       SET state = 'ready', updated_at_ms = 30
       WHERE native_conversation_lease_id = ?`,
    )
    .run(NATIVE_CONVERSATION_LEASE_ID);
  database
    .prepare(
      `UPDATE native_bindings
       SET semantic_conversation_id = 'codex-thread-1',
           current_binding_incarnation_id = 'registration-binding-incarnation',
           state = 'current'
       WHERE native_binding_id = ?`,
    )
    .run(BINDING_ID);
  database
    .prepare(
      `INSERT INTO binding_lifecycle_gates
         (native_binding_id, collaboration_server_id, logical_chat_id, runtime_id,
          native_incarnation, native_binding_incarnation_id, attachment_id,
          current_attachment_lease_id, phase, disconnect_policy,
          gate_generation, updated_at_ms)
       VALUES (?, ?, ?, ?, 1, 'registration-binding-incarnation',
               'registration-attachment', 'registration-attachment-lease',
               'ready', 'detach', 1, 30)`,
    )
    .run(BINDING_ID, SERVER_ID, CHAT_ID, RUNTIME_ID);
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
                 ?, ?, ?, ?, 31, NULL, 'current')`,
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
  database
    .prepare(
      `INSERT INTO protected_artifacts
         (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
          artifact_digest, byte_length, artifact_bytes, created_at_ms)
       VALUES (?, 'artifact', 'native_binding', ?,
               'remote-claw/native-root-certificate/v1', ?, 1, ?, 40)`,
    )
    .run(ROOT_PAYLOAD_HANDLE_ID, BINDING_ID, ROOT_PAYLOAD_DIGEST, Uint8Array.of(24));
  database
    .prepare(
      `UPDATE runtime_owner_signature_reservations
       SET canonical_payload_schema_id = 'remote-claw/native-root-certificate/v1',
           canonical_payload_ref = ?, canonical_payload_digest = ?, state = 'bound'
       WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
         AND runtime_owner_key_generation = 1 AND signer_sequence = 0`,
    )
    .run(ROOT_PAYLOAD_HANDLE_ID, ROOT_PAYLOAD_DIGEST, RUNTIME_ID);
}

function reserveBoundNativeRootSigner(
  database: DatabaseSync,
  options: {
    readonly signerSequence: number;
    readonly canonicalPayloadRef: string;
    readonly canonicalPayloadDigest: string;
    readonly createdAtMs: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO runtime_owner_signature_reservations
         (runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
          signer_sequence, purpose, canonical_payload_schema_id,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          signature, signed_artifact_id, state)
       VALUES (?, 'runtime-key-1', 1, ?, 'native_root', NULL, NULL, NULL,
               NULL, NULL, NULL, 'reserved')`,
    )
    .run(RUNTIME_ID, options.signerSequence);
  database
    .prepare(
      `INSERT INTO protected_artifacts
         (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
          artifact_digest, byte_length, artifact_bytes, created_at_ms)
       VALUES (?, 'artifact', 'native_binding', ?,
               'remote-claw/native-root-certificate/v1', ?, 1, ?, ?)`,
    )
    .run(
      options.canonicalPayloadRef,
      BINDING_ID,
      options.canonicalPayloadDigest,
      Uint8Array.of(options.signerSequence),
      options.createdAtMs,
    );
  database
    .prepare(
      `UPDATE runtime_owner_signature_reservations
       SET canonical_payload_schema_id = 'remote-claw/native-root-certificate/v1',
           canonical_payload_ref = ?, canonical_payload_digest = ?, state = 'bound'
       WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
         AND runtime_owner_key_generation = 1 AND signer_sequence = ?`,
    )
    .run(
      options.canonicalPayloadRef,
      options.canonicalPayloadDigest,
      RUNTIME_ID,
      options.signerSequence,
    );
}

function takeOverReadyNativeRootGraph(database: DatabaseSync): void {
  takeOverRuntimeOwner(database);
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO runtime_owner_assignments
           (runtime_owner_assignment_id, runtime_id, native_incarnation,
            assignment_generation, runtime_owner_service_lease_id,
            runtime_owner_service_epoch, assigned_at_ms,
            assignment_evidence_schema_id, assignment_evidence_ref,
            assignment_evidence_digest, supersedes_runtime_owner_assignment_id, reason)
         VALUES ('runtime-owner-assignment-2', ?, 1, 2, 'runtime-owner-lease-2', 2,
                 105, 'runtime-owner-assignment/v1', 'assignment-evidence-2', ?,
                 ?, 'takeover')`,
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

  insertRegistrationOperation(database, "operation-takeover-close", 5, "close", 110, {
    ownerLeaseId: "runtime-owner-lease-2",
    ownerEpoch: 2,
  });
  database
    .prepare(
      `UPDATE native_conversation_leases
       SET updated_at_ms = 110, closed_at_ms = 110, state = 'closed'
       WHERE native_conversation_lease_id = ?`,
    )
    .run(NATIVE_CONVERSATION_LEASE_ID);
  database
    .prepare(`UPDATE logical_chats SET state = 'recovering' WHERE logical_chat_id = ?`)
    .run(CHAT_ID);
  database
    .prepare(
      `UPDATE inward_collaboration_edges
       SET root_path_certificate_id = NULL, state = 'installing'
       WHERE inward_edge_id = ?`,
    )
    .run(EDGE_ID);
  database
    .prepare(
      `UPDATE binding_lifecycle_gates
       SET current_attachment_lease_id = NULL, phase = 'recovering',
           gate_generation = 2, updated_at_ms = 110
       WHERE native_binding_id = ?`,
    )
    .run(BINDING_ID);
  database
    .prepare(
      `UPDATE native_transport_leases
       SET released_at_ms = 110, state = 'superseded'
       WHERE attachment_lease_id = 'registration-attachment-lease'`,
    )
    .run();
  database
    .prepare(
      `UPDATE native_transport_attachments SET current_attachment_lease_id = NULL
       WHERE attachment_id = 'registration-attachment'`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO native_transport_leases
         (attachment_lease_id, attachment_id, native_binding_incarnation_id,
          runtime_id, native_incarnation, runtime_owner_service_lease_id,
          runtime_owner_service_epoch, coordinator_lease_id, coordinator_epoch,
          transport_epoch, current_capability_snapshot_id,
          current_native_client_ingress_lease_id, acquired_at_ms, released_at_ms, state)
       VALUES ('registration-attachment-lease-2', 'registration-attachment',
               'registration-binding-incarnation', ?, 1, 'runtime-owner-lease-2', 2,
               ?, 1, 2, NULL, NULL, 110, NULL, 'current')`,
    )
    .run(RUNTIME_ID, COORDINATOR_LEASE_ID);
  database
    .prepare(
      `UPDATE native_transport_attachments
       SET current_attachment_lease_id = 'registration-attachment-lease-2'
       WHERE attachment_id = 'registration-attachment'`,
    )
    .run();

  insertStartingConversationLease(database, {
    leaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
    portHandleId: SUCCESSOR_PROTECTED_PORT_HANDLE_ID,
    ownerLeaseId: "runtime-owner-lease-2",
    ownerEpoch: 2,
    acquiredAtMs: 110,
    leaseGeneration: 2,
    supersedesLeaseId: NATIVE_CONVERSATION_LEASE_ID,
    state: "recovering",
  });
  insertRegistrationOperation(database, "operation-takeover-reattach", 1, "reattach", 110, {
    leaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
    ownerLeaseId: "runtime-owner-lease-2",
    ownerEpoch: 2,
  });
  database
    .prepare(
      `UPDATE native_conversation_leases
       SET native_binding_incarnation_id = 'registration-binding-incarnation',
           attachment_lease_id = 'registration-attachment-lease-2', updated_at_ms = 110
       WHERE native_conversation_lease_id = ?`,
    )
    .run(SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID);
  database
    .prepare(
      `INSERT INTO native_registration_publications
         (native_registration_publication_id, native_conversation_lease_id,
          native_binding_id, runtime_id, native_incarnation,
          native_binding_incarnation_id, attachment_lease_id,
          publication_generation, metadata_schema_id, metadata_ref,
          metadata_digest, capabilities_schema_id, capabilities_ref,
          capabilities_digest, published_at_ms, state)
       VALUES ('registration-publication-2', ?, ?, ?, 1,
               'registration-binding-incarnation', 'registration-attachment-lease-2',
               1, 'provider-metadata/v1', ?, ?,
               'remote-claw/native-conversation-capabilities/v1', ?, ?, 112, 'current')`,
    )
    .run(
      SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
      BINDING_ID,
      RUNTIME_ID,
      METADATA_HANDLE_ID,
      METADATA_DIGEST,
      CAPABILITIES_HANDLE_ID,
      CAPABILITIES_DIGEST,
    );
  insertRegistrationOperation(database, "operation-takeover-publish", 2, "publish", 112, {
    leaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
    ownerLeaseId: "runtime-owner-lease-2",
    ownerEpoch: 2,
  });
  database
    .prepare(
      `UPDATE native_conversation_leases
       SET current_publication_id = 'registration-publication-2', updated_at_ms = 112
       WHERE native_conversation_lease_id = ?`,
    )
    .run(SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID);
  insertRegistrationOperation(database, "operation-takeover-ready", 3, "ready", 113, {
    leaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
    ownerLeaseId: "runtime-owner-lease-2",
    ownerEpoch: 2,
  });
  database
    .prepare(
      `UPDATE native_conversation_leases
       SET state = 'ready', updated_at_ms = 113
       WHERE native_conversation_lease_id = ?`,
    )
    .run(SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID);
  database
    .prepare(
      `UPDATE binding_lifecycle_gates
       SET current_attachment_lease_id = 'registration-attachment-lease-2',
           phase = 'ready', gate_generation = 3, updated_at_ms = 113
       WHERE native_binding_id = ?`,
    )
    .run(BINDING_ID);
}

interface NativeRootFixtureOptions {
  readonly operationId?: string;
  readonly operationDigest?: string;
  readonly kind?: "activate" | "renew";
  readonly rootPathCertificateId?: string;
  readonly expectedPriorRootPathCertificateId?: string | null;
  readonly signerSequence?: number;
  readonly canonicalPayloadRef?: string;
  readonly canonicalPayloadDigest?: string;
  readonly signedRecordDigest?: string;
  readonly attachmentLeaseId?: string;
  readonly transportEpoch?: number;
  readonly nativeConversationLeaseId?: string;
  readonly nativeConversationLeaseGeneration?: number;
  readonly nativeRegistrationPublicationId?: string;
  readonly publicationGeneration?: number;
  readonly bindingGateGeneration?: number;
  readonly runtimeOwnerServiceLeaseId?: string;
  readonly runtimeOwnerServiceEpoch?: number;
  readonly preparedAtMs?: number;
  readonly issuedAtMs?: number;
  readonly expiresAtMs?: number;
  readonly acceptedAtMs?: number;
  readonly committedAtMs?: number;
}

function insertPreparedNativeRootOperation(
  database: DatabaseSync,
  options: NativeRootFixtureOptions = {},
): void {
  database
    .prepare(
      `INSERT INTO native_root_activation_operations
         (operation_id, operation_schema_id, operation_digest, kind,
          root_path_certificate_id, expected_prior_root_path_certificate_id,
          collaboration_server_id, logical_chat_id, inward_edge_id,
          terminal_topology_generation, native_binding_id, runtime_id,
          native_incarnation, native_binding_incarnation_id, attachment_id,
          attachment_lease_id, transport_epoch, native_conversation_lease_id,
          native_conversation_lease_generation, native_registration_publication_id,
          publication_generation, binding_gate_generation,
          runtime_owner_service_lease_id, runtime_owner_service_epoch,
          coordinator_lease_id, coordinator_epoch, runtime_owner_identity_key_id,
          runtime_owner_key_generation, signer_sequence, native_binding_evidence_digest,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          prepared_at_ms, issued_at_ms, expires_at_ms, committed_at_ms, state)
       VALUES (?, 'remote-claw/native-root-activation/v1', ?, ?, ?, ?,
               ?, ?, ?, 1, ?, ?, 1, 'registration-binding-incarnation',
               'registration-attachment', ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, 1,
               'runtime-key-1', 1, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'prepared')`,
    )
    .run(
      options.operationId ?? ROOT_OPERATION_ID,
      options.operationDigest ?? ROOT_OPERATION_DIGEST,
      options.kind ?? "activate",
      options.rootPathCertificateId ?? ROOT_CERTIFICATE_ID,
      options.expectedPriorRootPathCertificateId ?? null,
      SERVER_ID,
      CHAT_ID,
      EDGE_ID,
      BINDING_ID,
      RUNTIME_ID,
      options.attachmentLeaseId ?? "registration-attachment-lease",
      options.transportEpoch ?? 1,
      options.nativeConversationLeaseId ?? NATIVE_CONVERSATION_LEASE_ID,
      options.nativeConversationLeaseGeneration ?? 1,
      options.nativeRegistrationPublicationId ?? "registration-publication-1",
      options.publicationGeneration ?? 1,
      options.bindingGateGeneration ?? 1,
      options.runtimeOwnerServiceLeaseId ?? RUNTIME_OWNER_LEASE_ID,
      options.runtimeOwnerServiceEpoch ?? 1,
      COORDINATOR_LEASE_ID,
      options.signerSequence ?? 0,
      DIGEST,
      options.canonicalPayloadRef ?? ROOT_PAYLOAD_HANDLE_ID,
      options.canonicalPayloadDigest ?? ROOT_PAYLOAD_DIGEST,
      options.preparedAtMs ?? 40,
      options.issuedAtMs ?? 50,
      options.expiresAtMs ?? 90,
    );
}

function insertNativeRootCertificate(
  database: DatabaseSync,
  options: NativeRootFixtureOptions = {},
): void {
  database
    .prepare(
      `INSERT INTO native_root_certificates
         (root_path_certificate_id, activation_operation_id,
          activation_operation_digest, expected_prior_root_path_certificate_id,
          schema_version, canonical_payload_schema_id, kind,
          terminal_native_binding_id, terminal_server_id, terminal_logical_chat_id,
          terminal_topology_generation, native_binding_evidence_digest,
          runtime_id, native_incarnation, native_binding_incarnation_id,
          attachment_id, attachment_lease_id, transport_epoch,
          native_conversation_lease_id, native_conversation_lease_generation,
          native_registration_publication_id, publication_generation,
          binding_gate_generation, runtime_owner_service_lease_id,
          runtime_owner_service_epoch, coordinator_lease_id, coordinator_epoch,
          runtime_owner_identity_key_id, runtime_owner_key_generation, signer_sequence,
          issued_at_ms, expires_at_ms, signature_algorithm,
          canonical_payload_digest_algorithm, canonical_payload_ref,
          canonical_payload_digest, signed_record_digest, signature,
          committed_at_ms, state)
       VALUES (?, ?, ?, ?, 1, 'remote-claw/native-root-certificate/v1',
               'native-root', ?, ?, ?, 1, ?, ?, 1,
               'registration-binding-incarnation', 'registration-attachment',
               ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, 1,
               'runtime-key-1', 1, ?, ?, ?, 'Ed25519', 'SHA-256',
               ?, ?, ?, ?, ?, 'activated')`,
    )
    .run(
      options.rootPathCertificateId ?? ROOT_CERTIFICATE_ID,
      options.operationId ?? ROOT_OPERATION_ID,
      options.operationDigest ?? ROOT_OPERATION_DIGEST,
      options.expectedPriorRootPathCertificateId ?? null,
      BINDING_ID,
      SERVER_ID,
      CHAT_ID,
      DIGEST,
      RUNTIME_ID,
      options.attachmentLeaseId ?? "registration-attachment-lease",
      options.transportEpoch ?? 1,
      options.nativeConversationLeaseId ?? NATIVE_CONVERSATION_LEASE_ID,
      options.nativeConversationLeaseGeneration ?? 1,
      options.nativeRegistrationPublicationId ?? "registration-publication-1",
      options.publicationGeneration ?? 1,
      options.bindingGateGeneration ?? 1,
      options.runtimeOwnerServiceLeaseId ?? RUNTIME_OWNER_LEASE_ID,
      options.runtimeOwnerServiceEpoch ?? 1,
      COORDINATOR_LEASE_ID,
      options.signerSequence ?? 0,
      options.issuedAtMs ?? 50,
      options.expiresAtMs ?? 90,
      options.canonicalPayloadRef ?? ROOT_PAYLOAD_HANDLE_ID,
      options.canonicalPayloadDigest ?? ROOT_PAYLOAD_DIGEST,
      options.signedRecordDigest ?? ROOT_SIGNED_RECORD_DIGEST,
      SIGNATURE,
      options.committedAtMs ?? 60,
    );
}

function signAndAcceptPreparedNativeRoot(
  database: DatabaseSync,
  options: NativeRootFixtureOptions = {},
): void {
  database
    .prepare(
      `UPDATE runtime_owner_signature_reservations
       SET signed_record_digest = ?, signature = ?, signed_artifact_id = ?, state = 'signed'
       WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
         AND runtime_owner_key_generation = 1 AND signer_sequence = ?`,
    )
    .run(
      options.signedRecordDigest ?? ROOT_SIGNED_RECORD_DIGEST,
      SIGNATURE,
      options.rootPathCertificateId ?? ROOT_CERTIFICATE_ID,
      RUNTIME_ID,
      options.signerSequence ?? 0,
    );
  database
    .prepare(
      `INSERT INTO runtime_owner_signed_record_acceptances
         (runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
          signer_sequence, signed_record_digest, accepted_at_ms)
       VALUES (?, 'runtime-key-1', 1, ?, ?, ?)`,
    )
    .run(
      RUNTIME_ID,
      options.signerSequence ?? 0,
      options.signedRecordDigest ?? ROOT_SIGNED_RECORD_DIGEST,
      options.acceptedAtMs ?? 55,
    );
}

describe("A1 host-state migrations", () => {
  it("pins the application id, schema version, and exact migration digests", () => {
    expect(HOST_STATE_APPLICATION_ID).toBe(0x52434c57);
    expect(HOST_STATE_SCHEMA_VERSION).toBe(11);
    expect(HOST_STATE_MIGRATION_DIGESTS).toEqual([
      PINNED_VERSION_ONE_DIGEST,
      PINNED_VERSION_TWO_DIGEST,
      PINNED_VERSION_THREE_DIGEST,
      PINNED_VERSION_FOUR_DIGEST,
      PINNED_VERSION_FIVE_DIGEST,
      PINNED_VERSION_SIX_DIGEST,
      PINNED_VERSION_SEVEN_DIGEST,
      PINNED_VERSION_EIGHT_DIGEST,
      PINNED_VERSION_NINE_DIGEST,
      PINNED_VERSION_TEN_DIGEST,
      PINNED_VERSION_ELEVEN_DIGEST,
    ]);
    expect(HOST_STATE_SCHEMA_MANIFEST).toEqual({
      applicationId: 0x52434c57,
      schemaVersion: 11,
      migrationDigest: PINNED_VERSION_ELEVEN_DIGEST,
      sqliteSchema: HOST_STATE_SQLITE_SCHEMA_MANIFEST,
    });
    expect(expectedHostStateSqliteSchemaManifest(1)).toHaveLength(6);
    expect(expectedHostStateSqliteSchemaManifest(2)).toHaveLength(10);
    expect(expectedHostStateSqliteSchemaManifest(3)).toHaveLength(91);
    expect(expectedHostStateSqliteSchemaManifest(4)).toHaveLength(231);
    expect(expectedHostStateSqliteSchemaManifest(5)).toHaveLength(269);
    expect(expectedHostStateSqliteSchemaManifest(6)).toHaveLength(304);
    expect(expectedHostStateSqliteSchemaManifest(7)).toHaveLength(326);
    expect(expectedHostStateSqliteSchemaManifest(8)).toHaveLength(492);
    expect(expectedHostStateSqliteSchemaManifest(9)).toHaveLength(571);
    expect(expectedHostStateSqliteSchemaManifest(10)).toHaveLength(619);
    expect(expectedHostStateSqliteSchemaManifest(11)).toHaveLength(647);
    expect(HOST_STATE_MIGRATIONS[8]?.statements).toHaveLength(81);
    expect(HOST_STATE_MIGRATIONS[9]?.statements).toHaveLength(50);
    expect(HOST_STATE_MIGRATIONS[10]?.statements).toHaveLength(38);
    expect(
      HOST_STATE_SQLITE_SCHEMA_MANIFEST.filter((entry) => entry.type === "table"),
    ).toHaveLength(73);
    expect(
      HOST_STATE_SQLITE_SCHEMA_MANIFEST.filter((entry) => entry.type === "index"),
    ).toHaveLength(147);
    expect(
      HOST_STATE_SQLITE_SCHEMA_MANIFEST.filter((entry) => entry.type === "trigger"),
    ).toHaveLength(427);
    expect(HOST_STATE_SQLITE_SCHEMA_MANIFEST.filter((entry) => entry.type === "view")).toHaveLength(
      0,
    );
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
    expect(expectedHostStateMigrationDigest(5)).toBe(PINNED_VERSION_FIVE_DIGEST);
    expect(expectedHostStateMigrationDigest(6)).toBe(PINNED_VERSION_SIX_DIGEST);
    expect(expectedHostStateMigrationDigest(7)).toBe(PINNED_VERSION_SEVEN_DIGEST);
    expect(expectedHostStateMigrationDigest(8)).toBe(PINNED_VERSION_EIGHT_DIGEST);
    expect(expectedHostStateMigrationDigest(9)).toBe(PINNED_VERSION_NINE_DIGEST);
    expect(expectedHostStateMigrationDigest(10)).toBe(PINNED_VERSION_TEN_DIGEST);
    expect(expectedHostStateMigrationDigest(11)).toBe(PINNED_VERSION_ELEVEN_DIGEST);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ELEVEN_DIGEST, 11)).toBe(true);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 1)).toBe(true);
    expect(isExpectedHostStateMigrationDigest(`${PINNED_VERSION_ONE_DIGEST}=`, 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest("A".repeat(43), 1)).toBe(false);
    expect(isExpectedHostStateMigrationDigest(PINNED_VERSION_ONE_DIGEST, 2)).toBe(false);
    expect(() => expectedHostStateMigrationDigest(0)).toThrow(/not supported/);
    expect(() => expectedHostStateMigrationDigest(12)).toThrow(/not supported/);
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

      expect(rows.filter((row) => row.type === "table")).toHaveLength(73);
      expect(rows.filter((row) => row.type === "index")).toHaveLength(147);
      expect(rows.filter((row) => row.type === "trigger")).toHaveLength(427);
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

  it("migrates the exact v4 manifest to the empty v5 registration graph", () => {
    const database = openedV4Database();
    try {
      const migration = HOST_STATE_MIGRATIONS[4];
      if (migration === undefined) throw new Error("missing v5 migration");
      expect(migration.id).toBe("005-durable-native-registration");
      expect(migration.statements).toHaveLength(38);
      for (const statement of migration.statements) database.exec(statement);

      const actual = database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
           ORDER BY type, name`,
        )
        .all();
      const expected = [...expectedHostStateSqliteSchemaManifest(5)].sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type.localeCompare(right.type),
      );
      expect(actual).toEqual(expected);
      for (const table of [
        "native_conversation_leases",
        "native_registration_publications",
        "native_registration_operations",
      ]) {
        expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("migrates the exact v5 manifest to the empty v6 terminal-root ledger", () => {
    const database = openedV5Database();
    try {
      const migration = HOST_STATE_MIGRATIONS[5];
      if (migration === undefined) throw new Error("missing v6 migration");
      expect(migration.id).toBe("006-terminal-native-root");
      expect(migration.statements).toHaveLength(36);
      for (const statement of migration.statements) database.exec(statement);

      const actual = database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
           ORDER BY type, name`,
        )
        .all();
      const expected = [...expectedHostStateSqliteSchemaManifest(6)].sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type.localeCompare(right.type),
      );
      expect(actual).toEqual(expected);
      for (const table of [
        "native_root_signature_activation_fences",
        "native_root_activation_operations",
        "native_root_certificates",
      ]) {
        expect(database.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
      }
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("migrates the exact v6 manifest to the empty v7 dormant broker-route graph", () => {
    const database = openedV6Database();
    try {
      const migration = HOST_STATE_MIGRATIONS[6];
      if (migration === undefined) throw new Error("missing v7 migration");
      expect(migration.id).toBe("007-a1-broker-routes");
      expect(migration.statements).toHaveLength(22);
      for (const statement of migration.statements) database.exec(statement);

      const actual = database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql
           FROM sqlite_schema
           ORDER BY type, name`,
        )
        .all();
      const expected = [...expectedHostStateSqliteSchemaManifest(7)].sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type.localeCompare(right.type),
      );
      expect(actual).toEqual(expected);
      for (const table of [
        "broker_backend_capability_pins",
        "broker_routes",
        "broker_channel_generations",
      ]) {
        expect(database.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
      }
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("backfills every v7 broker route into the dormant v8 ingress heads", () => {
    const database = openedV7Database();
    try {
      prepareV7BrokerRoute(database);
      const migration = HOST_STATE_MIGRATIONS[7];
      if (migration === undefined) throw new Error("missing v8 migration");
      expect(migration.id).toBe("008-a1-durable-ingress");
      for (const statement of migration.statements) database.exec(statement);

      expect(
        database
          .prepare(
            `SELECT state, current_channel_generation, active_gap_count
             FROM broker_route_runtime_status WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ state: "current", current_channel_generation: 0, active_gap_count: 0 });
      expect(
        database
          .prepare(
            `SELECT state, observed_next_frame_index, frame_count, next_generation,
                    manifest_digest
             FROM broker_channel_generation_observations
             WHERE broker_route_id = ? AND channel_generation = 0`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({
        state: "open",
        observed_next_frame_index: 0,
        frame_count: null,
        next_generation: null,
        manifest_digest: null,
      });
      expect(
        database
          .prepare(
            `SELECT next_generation, next_frame_index, revision
             FROM broker_route_fetch_cursors WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ next_generation: 0, next_frame_index: 0, revision: 0 });
      expect(
        database
          .prepare(
            `SELECT next_generation, next_frame_index, contiguous_through_generation,
                    contiguous_through_frame_index, revision
             FROM broker_route_semantic_cursors WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({
        next_generation: 0,
        next_frame_index: 0,
        contiguous_through_generation: null,
        contiguous_through_frame_index: null,
        revision: 0,
      });
      expect(
        database
          .prepare(
            `SELECT revision, claim_token, coordinator_lease_id, coordinator_epoch,
                    last_operation_id
             FROM broker_route_actors WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({
        revision: 0,
        claim_token: null,
        coordinator_lease_id: null,
        coordinator_epoch: null,
        last_operation_id: null,
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("auto-seeds the same v8 heads for a route installed after migration", () => {
    const database = openedV7Database();
    try {
      prepareV7BrokerRoute(database);
      const migration = HOST_STATE_MIGRATIONS[7];
      if (migration === undefined) throw new Error("missing v8 migration");
      for (const statement of migration.statements) database.exec(statement);

      database
        .prepare(
          `INSERT INTO broker_routes (
             broker_route_id, machine_identity_id, collaboration_server_id, route_kind,
             logical_chat_id, route_token, broker_origin, broker_backend_selector,
             broker_route_store_instance_id, genesis_generation,
             broker_backend_capabilities_ref, broker_backend_capabilities_digest,
             coordinator_lease_id, coordinator_epoch, created_at_ms, state
           ) VALUES (?, ?, ?, 'scope_bus', NULL, ?, 'https://broker.example', 'sqlite',
                     ?, 0, ?, ?, ?, 1, 40, 'current')`,
        )
        .run(
          SECOND_BROKER_ROUTE_ID,
          MACHINE_IDENTITY_ID,
          SERVER_ID,
          SECOND_BROKER_ROUTE_TOKEN,
          SECOND_BROKER_STORE_ID,
          BROKER_CAPABILITY_PIN_ID,
          DIGEST,
          COORDINATOR_LEASE_ID,
        );
      database
        .prepare(
          `INSERT INTO broker_channel_generations (
             broker_route_id, channel_generation, frame_count, next_generation,
             state, manifest_digest
           ) VALUES (?, 0, NULL, NULL, 'open', NULL)`,
        )
        .run(SECOND_BROKER_ROUTE_ID);

      for (const table of [
        "broker_route_runtime_status",
        "broker_channel_generation_observations",
        "broker_route_fetch_cursors",
        "broker_route_semantic_cursors",
        "broker_route_actors",
      ]) {
        expect(
          database
            .prepare(`SELECT count(*) AS count FROM ${table} WHERE broker_route_id = ?`)
            .get(SECOND_BROKER_ROUTE_ID),
          table,
        ).toEqual({ count: 1 });
      }
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("installs exactly the dormant A1.7b1 command foundation and no final/effect surface", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database, 10);
      const priorTableNames = new Set(
        expectedHostStateSqliteSchemaManifest(9)
          .filter((entry) => entry.type === "table")
          .map((entry) => entry.name),
      );
      const foundationTables = database
        .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
        .all()
        .filter((row) => !priorTableNames.has(String(row.name)));
      expect(foundationTables).toEqual([
        { name: "a1_ingress_adjudications" },
        { name: "collaboration_command_compound_signing_groups" },
        { name: "collaboration_command_result_preparations" },
        { name: "collaboration_commands" },
        { name: "command_ready_entries" },
      ]);
      for (const forbidden of [
        "collaboration_command_results",
        "collaboration_command_result_deliveries",
        "ingress_result_deliveries",
        "host_output_deliveries",
        "collaboration_command_result_outbox_entries",
        "causal_outbox_entries",
        "command_effect_gates",
        "native_execution_attempts",
        "native_dispatch_attempts",
        "command_dispatch_attempts",
        "effect_gates",
      ]) {
        expect(
          database
            .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get(forbidden),
          forbidden,
        ).toBeUndefined();
      }
    } finally {
      database.close();
    }
  });

  it("adds only the dormant rejected-result closure and no A1.8b or effect surface", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      const priorTableNames = new Set(
        expectedHostStateSqliteSchemaManifest(10)
          .filter((entry) => entry.type === "table")
          .map((entry) => entry.name),
      );
      const finalizationTables = database
        .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
        .all()
        .filter((row) => !priorTableNames.has(String(row.name)));
      expect(finalizationTables).toEqual([
        { name: "a1_ingress_result_deliveries" },
        { name: "a1_ingress_terminal_results" },
        { name: "collaboration_command_results" },
      ]);
      for (const forbidden of [
        "collaboration_command_result_deliveries",
        "host_output_deliveries",
        "host_output_parts",
        "causal_outbox_entries",
        "command_effect_gates",
        "native_execution_attempts",
        "native_dispatch_attempts",
        "command_dispatch_attempts",
        "effect_gates",
      ]) {
        expect(
          database
            .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get(forbidden),
          forbidden,
        ).toBeUndefined();
      }
      expect(
        database
          .prepare("PRAGMA table_info(a1_ingress_result_deliveries)")
          .all()
          .map((row) => row.name),
      ).not.toEqual(expect.arrayContaining(["encrypted_result_payload_ref", "published_at_ms"]));
    } finally {
      database.close();
    }
  });

  it("lets only exact scoped artifacts enter the staged-position ledger", () => {
    const database = openedV8BrokerRouteDatabase();
    try {
      claimBrokerRouteActor(database);
      insertIngressArtifact(database, RAW_FRAME_ARTIFACT_ID, "wrong-schema/v1");
      expect(() => insertPendingPosition(database)).toThrow(/exact received-frame artifact/);

      const validRef = `rcph_${encoded(16, 52)}`;
      database
        .prepare(
          `INSERT INTO protected_artifacts (
             protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
             artifact_digest, byte_length, artifact_bytes, created_at_ms
           ) VALUES (?, 'artifact', 'collaboration_server', ?,
                     'remote-claw/a1/received-frame/v1', ?, 1, ?, 40)`,
        )
        .run(validRef, SERVER_ID, DIGEST, Uint8Array.of(1));
      expect(() =>
        database
          .prepare(
            `INSERT INTO authenticated_channel_positions (
               channel_position_observation_id, broker_route_id, collaboration_server_id,
               route_kind, logical_chat_id, channel_generation, frame_index,
               claimed_delivery_attempt_id, claimed_part, claimed_transport_frame_digest,
               received_frame_ref, received_frame_digest, received_frame_byte_length,
               classification, cursor_disposition, observed_at_ms
             ) VALUES (?, ?, ?, 'chat', NULL, 0, 0, ?, 0, ?, ?, ?, 1,
                       'pending_validation', 'blocked', 40)`,
          )
          .run(
            CHANNEL_POSITION_ID,
            BROKER_ROUTE_ID,
            SERVER_ID,
            DELIVERY_ATTEMPT_ID,
            DIGEST,
            validRef,
            DIGEST,
          ),
      ).toThrow(/route scope|CHECK constraint/);
    } finally {
      database.close();
    }
  });

  it("makes gap count and quarantine state database-owned through exact recovery", () => {
    const database = openedV8BrokerRouteDatabase();
    try {
      claimBrokerRouteActor(database);
      insertIngressArtifact(database, RAW_FRAME_ARTIFACT_ID, "remote-claw/a1/received-frame/v1");
      insertIngressArtifact(
        database,
        GAP_EVIDENCE_ARTIFACT_ID,
        "remote-claw/a1/ingress-gap-evidence/v1",
      );
      insertPendingPosition(database);
      database
        .prepare(
          `INSERT INTO broker_route_gaps (
             gap_id, broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
             reason, stable_semantic_result_id, channel_position_observation_id,
             channel_generation, manifest_equivocation_id, transport_key_collision_id,
             evidence_ref, evidence_digest, state, opened_at_ms, resolved_at_ms, recovery_id
           ) VALUES (?, ?, ?, 'server_control', NULL, 'invalid_frame', NULL, ?,
                     NULL, NULL, NULL, ?, ?, 'open', 45, NULL, NULL)`,
        )
        .run(
          GAP_ID,
          BROKER_ROUTE_ID,
          SERVER_ID,
          CHANNEL_POSITION_ID,
          GAP_EVIDENCE_ARTIFACT_ID,
          DIGEST,
        );
      expect(
        database
          .prepare(
            `SELECT state, active_gap_count FROM broker_route_runtime_status
             WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ state: "quarantined", active_gap_count: 1 });
      expect(() =>
        database
          .prepare(
            `UPDATE broker_route_runtime_status SET active_gap_count = 0, state = 'current'
             WHERE broker_route_id = ?`,
          )
          .run(BROKER_ROUTE_ID),
      ).toThrow(/runtime transition/);

      database
        .prepare(
          `INSERT INTO channel_position_recoveries (
             recovery_id, gap_id, broker_route_id, collaboration_server_id, route_kind,
             logical_chat_id, reason, decision, evidence_ref, evidence_digest,
             coordinator_lease_id, coordinator_epoch, decided_at_ms
           ) VALUES (?, ?, ?, ?, 'server_control', NULL, 'invalid_frame',
                     'proved_safe_discard', ?, ?, ?, 1, 50)`,
        )
        .run(
          RECOVERY_ID,
          GAP_ID,
          BROKER_ROUTE_ID,
          SERVER_ID,
          GAP_EVIDENCE_ARTIFACT_ID,
          DIGEST,
          COORDINATOR_LEASE_ID,
        );
      database
        .prepare(
          `UPDATE broker_route_gaps SET state = 'resolved', resolved_at_ms = 50,
                  recovery_id = ? WHERE gap_id = ?`,
        )
        .run(RECOVERY_ID, GAP_ID);
      expect(
        database
          .prepare(
            `SELECT state, active_gap_count FROM broker_route_runtime_status
             WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ state: "current", active_gap_count: 0 });
      expect(() =>
        database.prepare("DELETE FROM broker_route_gaps WHERE gap_id = ?").run(GAP_ID),
      ).toThrow(/retained/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("retains fresh retry evidence while extending semantic cursor bounds by min and max", () => {
    const database = openedV8BrokerRouteDatabase();
    try {
      claimBrokerRouteActor(database);
      insertIngressArtifact(database, RAW_FRAME_ARTIFACT_ID, "remote-claw/a1/received-frame/v1");
      insertIngressArtifact(
        database,
        PLAINTEXT_ARTIFACT_ID,
        "remote-claw/a1/opened-plaintext-part/v1",
      );
      insertPendingPosition(database);
      database.exec("BEGIN");
      database
        .prepare(
          `INSERT INTO authenticated_ingress_results (
             stable_semantic_result_id, broker_route_id, collaboration_server_id, route_kind,
             logical_chat_id, source_event_namespace_id, message_id, record_kind,
             client_message_id, expected_parts, source_payload_schema_id,
             canonical_message_digest, source_event_fingerprint_schema_id,
             source_event_fingerprint, first_ingress_generation, first_ingress_frame_index,
             last_observed_ingress_generation, last_observed_ingress_frame_index,
             assembly_deadline_ms, state, collision_at_ms, terminal_at_ms
           ) VALUES (?, ?, ?, 'server_control', NULL, ?, 'message-one', 'new_chat',
                     'client-one', 1, NULL, NULL, NULL, NULL, 0, 10, 0, 10,
                     300040, 'assembling', NULL, NULL)`,
        )
        .run(SEMANTIC_RESULT_ID, BROKER_ROUTE_ID, SERVER_ID, SOURCE_NAMESPACE_ID);
      database
        .prepare(
          `INSERT INTO ingress_transport_attempts (
             broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
             delivery_attempt_id, source_event_namespace_id, stable_semantic_result_id,
             message_id, record_kind, client_message_id, stable_logical_header_digest,
             expected_parts, binding_disposition, collision_gap_id
           ) VALUES (?, ?, 'server_control', NULL, ?, ?, ?, 'message-one', 'new_chat',
                     'client-one', ?, 1, 'exact', NULL)`,
        )
        .run(
          BROKER_ROUTE_ID,
          SERVER_ID,
          DELIVERY_ATTEMPT_ID,
          SOURCE_NAMESPACE_ID,
          SEMANTIC_RESULT_ID,
          DIGEST,
        );
      database
        .prepare(
          `INSERT INTO ingress_delivery_candidates (
             stable_semantic_result_id, delivery_attempt_id, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, expected_parts,
             received_parts, plaintext_byte_count, first_ingress_generation,
             first_ingress_frame_index, last_observed_ingress_generation,
             last_observed_ingress_frame_index, state
           ) VALUES (?, ?, ?, ?, 'server_control', NULL, 1, 0, 0, 0, 10, 0, 10, 'assembling')`,
        )
        .run(SEMANTIC_RESULT_ID, DELIVERY_ATTEMPT_ID, BROKER_ROUTE_ID, SERVER_ID);
      database
        .prepare(
          `INSERT INTO authenticated_ingress_parts (
             stable_semantic_result_id, delivery_attempt_id, part, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, parts,
             authenticated_part_digest, plaintext_part_ref, plaintext_part_digest,
             plaintext_part_byte_length, first_ingress_generation, first_ingress_frame_index
           ) VALUES (?, ?, 0, ?, ?, 'server_control', NULL, 1, ?, ?, ?, 1, 0, 10)`,
        )
        .run(
          SEMANTIC_RESULT_ID,
          DELIVERY_ATTEMPT_ID,
          BROKER_ROUTE_ID,
          SERVER_ID,
          DIGEST,
          PLAINTEXT_ARTIFACT_ID,
          DIGEST,
        );
      database
        .prepare(
          `UPDATE ingress_delivery_candidates
           SET received_parts = 1, plaintext_byte_count = 1, state = 'complete'
           WHERE broker_route_id = ? AND stable_semantic_result_id = ?
             AND delivery_attempt_id = ?`,
        )
        .run(BROKER_ROUTE_ID, SEMANTIC_RESULT_ID, DELIVERY_ATTEMPT_ID);
      database
        .prepare(
          `UPDATE authenticated_ingress_results
           SET state = 'awaiting_order', source_payload_schema_id =
                 'remote-claw/a1-ingress-new-chat/v1', canonical_message_digest = ?,
               source_event_fingerprint_schema_id =
                 'remote-claw/a1/source-event-fingerprint/v1',
               source_event_fingerprint = ?, accepted_delivery_attempt_id = ?
           WHERE broker_route_id = ? AND stable_semantic_result_id = ?`,
        )
        .run(DIGEST, DIGEST, DELIVERY_ATTEMPT_ID, BROKER_ROUTE_ID, SEMANTIC_RESULT_ID);
      database
        .prepare(
          `INSERT INTO authenticated_ingress_observations (
             ingress_observation_id, channel_position_observation_id,
             stable_semantic_result_id, delivery_attempt_id, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, channel_generation,
             frame_index, part, parts, authenticated_part_digest, plaintext_evidence_ref,
             plaintext_evidence_digest, plaintext_evidence_byte_length, disposition,
             cursor_disposition, gap_id, recovery_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'server_control', NULL, 0, 0, 0, 1, ?, ?, ?, 1,
                     'exact_transport_retry', 'advanceable', NULL, NULL)`,
        )
        .run(
          INGRESS_OBSERVATION_ID,
          CHANNEL_POSITION_ID,
          SEMANTIC_RESULT_ID,
          DELIVERY_ATTEMPT_ID,
          BROKER_ROUTE_ID,
          SERVER_ID,
          DIGEST,
          PLAINTEXT_ARTIFACT_ID,
          DIGEST,
        );
      database.exec("COMMIT");

      for (const table of ["authenticated_ingress_results", "ingress_delivery_candidates"]) {
        expect(
          database
            .prepare(
              `SELECT first_ingress_generation, first_ingress_frame_index,
                      last_observed_ingress_generation, last_observed_ingress_frame_index
               FROM ${table} WHERE stable_semantic_result_id = ?`,
            )
            .get(SEMANTIC_RESULT_ID),
          table,
        ).toEqual({
          first_ingress_generation: 0,
          first_ingress_frame_index: 0,
          last_observed_ingress_generation: 0,
          last_observed_ingress_frame_index: 10,
        });
      }
      expect(
        database
          .prepare(
            `SELECT plaintext_evidence_ref FROM authenticated_ingress_observations
             WHERE ingress_observation_id = ?`,
          )
          .get(INGRESS_OBSERVATION_ID),
      ).toEqual({ plaintext_evidence_ref: PLAINTEXT_ARTIFACT_ID });
      expect(() =>
        database
          .prepare(
            `UPDATE authenticated_ingress_results
             SET accepted_delivery_attempt_id = ?
             WHERE stable_semantic_result_id = ?`,
          )
          .run(`rda_${encoded(16, 60)}`, SEMANTIC_RESULT_ID),
      ).toThrow(/transition is not allowed|FOREIGN KEY|exact complete accepted candidate/);
      expect(() =>
        database
          .prepare(
            `UPDATE ingress_delivery_candidates SET state = 'collision'
             WHERE stable_semantic_result_id = ? AND delivery_attempt_id = ?`,
          )
          .run(SEMANTIC_RESULT_ID, DELIVERY_ATTEMPT_ID),
      ).toThrow(/accepted delivery candidate must remain complete/);

      const collisionPositionId = `rcp_${encoded(32, 61)}`;
      const collisionObservationId = `rio_${encoded(32, 62)}`;
      const collisionAttemptId = `rda_${encoded(16, 63)}`;
      const collisionGapId = "gap-semantic-collision-one";
      const collisionRecoveryId = "recover-semantic-collision-one";
      insertPendingPositionAt(database, collisionPositionId, 1, collisionAttemptId);
      database
        .prepare(
          `INSERT INTO broker_route_gaps (
             gap_id, broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
             reason, stable_semantic_result_id, channel_position_observation_id,
             channel_generation, manifest_equivocation_id, transport_key_collision_id,
             evidence_ref, evidence_digest, state, opened_at_ms, resolved_at_ms, recovery_id
           ) VALUES (?, ?, ?, 'server_control', NULL, 'semantic_collision', ?, NULL,
                     NULL, NULL, NULL, ?, ?, 'open', 51, NULL, NULL)`,
        )
        .run(
          collisionGapId,
          BROKER_ROUTE_ID,
          SERVER_ID,
          SEMANTIC_RESULT_ID,
          RAW_FRAME_ARTIFACT_ID,
          DIGEST,
        );
      database
        .prepare(
          `INSERT INTO authenticated_ingress_observations (
             ingress_observation_id, channel_position_observation_id,
             stable_semantic_result_id, delivery_attempt_id, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, channel_generation,
             frame_index, part, parts, authenticated_part_digest, plaintext_evidence_ref,
             plaintext_evidence_digest, plaintext_evidence_byte_length, disposition,
             cursor_disposition, gap_id, recovery_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'server_control', NULL, 0, 1, 0, 1, ?, ?, ?, 1,
                     'collision', 'blocked', ?, NULL)`,
        )
        .run(
          collisionObservationId,
          collisionPositionId,
          SEMANTIC_RESULT_ID,
          collisionAttemptId,
          BROKER_ROUTE_ID,
          SERVER_ID,
          DIGEST,
          PLAINTEXT_ARTIFACT_ID,
          DIGEST,
          collisionGapId,
        );
      classifyInboundPosition(
        database,
        collisionPositionId,
        collisionObservationId,
        collisionAttemptId,
        "blocked",
        collisionGapId,
      );
      insertIngressArtifact(
        database,
        GAP_EVIDENCE_ARTIFACT_ID,
        "remote-claw/a1/ingress-gap-evidence/v1",
      );
      database
        .prepare(
          `INSERT INTO channel_position_recoveries (
             recovery_id, gap_id, broker_route_id, collaboration_server_id, route_kind,
             logical_chat_id, reason, decision, evidence_ref, evidence_digest,
             coordinator_lease_id, coordinator_epoch, decided_at_ms
           ) VALUES (?, ?, ?, ?, 'server_control', NULL, 'semantic_collision',
                     'proved_safe_discard', ?, ?, ?, 1, 55)`,
        )
        .run(
          collisionRecoveryId,
          collisionGapId,
          BROKER_ROUTE_ID,
          SERVER_ID,
          GAP_EVIDENCE_ARTIFACT_ID,
          DIGEST,
          COORDINATOR_LEASE_ID,
        );
      database
        .prepare(
          `UPDATE broker_route_gaps SET state = 'resolved', resolved_at_ms = 55, recovery_id = ?
           WHERE gap_id = ?`,
        )
        .run(collisionRecoveryId, collisionGapId);
      database
        .prepare(
          `UPDATE authenticated_ingress_observations
           SET cursor_disposition = 'advanceable', recovery_id = ?
           WHERE ingress_observation_id = ?`,
        )
        .run(collisionRecoveryId, collisionObservationId);
      database
        .prepare(
          `UPDATE authenticated_channel_positions
           SET cursor_disposition = 'advanceable', recovery_id = ?
           WHERE channel_position_observation_id = ?`,
        )
        .run(collisionRecoveryId, collisionPositionId);
      expect(
        database
          .prepare(
            `SELECT state, accepted_delivery_attempt_id FROM authenticated_ingress_results
             WHERE stable_semantic_result_id = ?`,
          )
          .get(SEMANTIC_RESULT_ID),
      ).toEqual({ state: "awaiting_order", accepted_delivery_attempt_id: DELIVERY_ATTEMPT_ID });

      const lateResultId = `rrs_${encoded(32, 64)}`;
      const latePositionId = `rcp_${encoded(32, 65)}`;
      const lateObservationId = `rio_${encoded(32, 66)}`;
      const lateAttemptId = `rda_${encoded(16, 67)}`;
      database
        .prepare(
          `INSERT INTO authenticated_ingress_results (
             stable_semantic_result_id, broker_route_id, collaboration_server_id, route_kind,
             logical_chat_id, source_event_namespace_id, message_id, record_kind,
             client_message_id, expected_parts, source_payload_schema_id,
             canonical_message_digest, source_event_fingerprint_schema_id,
             source_event_fingerprint, accepted_delivery_attempt_id,
             first_ingress_generation, first_ingress_frame_index,
             last_observed_ingress_generation, last_observed_ingress_frame_index,
             assembly_deadline_ms, state, collision_at_ms, terminal_at_ms
           ) VALUES (?, ?, ?, 'server_control', NULL, ?, 'message-late', 'new_chat',
                     'client-late', 1, NULL, NULL, NULL, NULL, NULL, 0, 2, 0, 2,
                     50, 'assembling', NULL, NULL)`,
        )
        .run(lateResultId, BROKER_ROUTE_ID, SERVER_ID, SOURCE_NAMESPACE_ID);
      database
        .prepare(
          `UPDATE authenticated_ingress_results
              SET state='quarantined_incomplete', terminal_at_ms=60
            WHERE stable_semantic_result_id=?`,
        )
        .run(lateResultId);
      insertPendingPositionAt(database, latePositionId, 2, lateAttemptId);
      database
        .prepare(
          `INSERT INTO authenticated_ingress_observations (
             ingress_observation_id, channel_position_observation_id,
             stable_semantic_result_id, delivery_attempt_id, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, channel_generation,
             frame_index, part, parts, authenticated_part_digest, plaintext_evidence_ref,
             plaintext_evidence_digest, plaintext_evidence_byte_length, disposition,
             cursor_disposition, gap_id, recovery_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'server_control', NULL, 0, 2, 0, 1, ?, ?, ?, 1,
                     'late_after_tombstone', 'advanceable', NULL, NULL)`,
        )
        .run(
          lateObservationId,
          latePositionId,
          lateResultId,
          lateAttemptId,
          BROKER_ROUTE_ID,
          SERVER_ID,
          DIGEST,
          PLAINTEXT_ARTIFACT_ID,
          DIGEST,
        );
      classifyInboundPosition(
        database,
        latePositionId,
        lateObservationId,
        lateAttemptId,
        "advanceable",
        null,
      );

      const invalidResultId = `rrs_${encoded(32, 68)}`;
      const invalidAttemptId = `rda_${encoded(16, 69)}`;
      const invalidPositionId = `rcp_${encoded(32, 70)}`;
      const invalidObservationId = `rio_${encoded(32, 71)}`;
      const invalidGapId = "gap-invalid-payload-one";
      database.exec("BEGIN");
      database
        .prepare(
          `INSERT INTO authenticated_ingress_results (
             stable_semantic_result_id, broker_route_id, collaboration_server_id, route_kind,
             logical_chat_id, source_event_namespace_id, message_id, record_kind,
             client_message_id, expected_parts, source_payload_schema_id,
             canonical_message_digest, source_event_fingerprint_schema_id,
             source_event_fingerprint, accepted_delivery_attempt_id,
             first_ingress_generation, first_ingress_frame_index,
             last_observed_ingress_generation, last_observed_ingress_frame_index,
             assembly_deadline_ms, state, collision_at_ms, terminal_at_ms
           ) VALUES (?, ?, ?, 'server_control', NULL, ?, 'message-invalid', 'new_chat',
                     'client-invalid', 2, NULL, NULL, NULL, NULL, NULL, 0, 3, 0, 3,
                     300070, 'assembling', NULL, NULL)`,
        )
        .run(invalidResultId, BROKER_ROUTE_ID, SERVER_ID, SOURCE_NAMESPACE_ID);
      database
        .prepare(
          `INSERT INTO ingress_transport_attempts (
             broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
             delivery_attempt_id, source_event_namespace_id, stable_semantic_result_id,
             message_id, record_kind, client_message_id, stable_logical_header_digest,
             expected_parts, binding_disposition, collision_gap_id
           ) VALUES (?, ?, 'server_control', NULL, ?, ?, ?, 'message-invalid', 'new_chat',
                     'client-invalid', ?, 2, 'exact', NULL)`,
        )
        .run(
          BROKER_ROUTE_ID,
          SERVER_ID,
          invalidAttemptId,
          SOURCE_NAMESPACE_ID,
          invalidResultId,
          DIGEST,
        );
      database
        .prepare(
          `INSERT INTO ingress_delivery_candidates (
             stable_semantic_result_id, delivery_attempt_id, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, expected_parts,
             received_parts, plaintext_byte_count, first_ingress_generation,
             first_ingress_frame_index, last_observed_ingress_generation,
             last_observed_ingress_frame_index, state
           ) VALUES (?, ?, ?, ?, 'server_control', NULL, 2, 0, 0, 0, 3, 0, 3, 'assembling')`,
        )
        .run(invalidResultId, invalidAttemptId, BROKER_ROUTE_ID, SERVER_ID);
      database
        .prepare(
          `INSERT INTO authenticated_ingress_parts (
             stable_semantic_result_id, delivery_attempt_id, part, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, parts,
             authenticated_part_digest, plaintext_part_ref, plaintext_part_digest,
             plaintext_part_byte_length, first_ingress_generation, first_ingress_frame_index
           ) VALUES (?, ?, 0, ?, ?, 'server_control', NULL, 2, ?, ?, ?, 1, 0, 3)`,
        )
        .run(
          invalidResultId,
          invalidAttemptId,
          BROKER_ROUTE_ID,
          SERVER_ID,
          DIGEST,
          PLAINTEXT_ARTIFACT_ID,
          DIGEST,
        );
      database
        .prepare(
          `UPDATE ingress_delivery_candidates
           SET received_parts = 1, plaintext_byte_count = 1, state = 'expired'
           WHERE stable_semantic_result_id = ? AND delivery_attempt_id = ?`,
        )
        .run(invalidResultId, invalidAttemptId);
      database
        .prepare(
          `UPDATE authenticated_ingress_results
           SET state = 'quarantined_incomplete', terminal_at_ms = 70
           WHERE stable_semantic_result_id = ?`,
        )
        .run(invalidResultId);
      insertPendingPositionAt(database, invalidPositionId, 3, invalidAttemptId);
      database
        .prepare(
          `INSERT INTO broker_route_gaps (
             gap_id, broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
             reason, stable_semantic_result_id, channel_position_observation_id,
             channel_generation, manifest_equivocation_id, transport_key_collision_id,
             evidence_ref, evidence_digest, state, opened_at_ms, resolved_at_ms, recovery_id
           ) VALUES (?, ?, ?, 'server_control', NULL, 'invalid_frame', NULL, ?,
                     NULL, NULL, NULL, ?, ?, 'open', 70, NULL, NULL)`,
        )
        .run(
          invalidGapId,
          BROKER_ROUTE_ID,
          SERVER_ID,
          invalidPositionId,
          GAP_EVIDENCE_ARTIFACT_ID,
          DIGEST,
        );
      database
        .prepare(
          `INSERT INTO authenticated_ingress_observations (
             ingress_observation_id, channel_position_observation_id,
             stable_semantic_result_id, delivery_attempt_id, broker_route_id,
             collaboration_server_id, route_kind, logical_chat_id, channel_generation,
             frame_index, part, parts, authenticated_part_digest, plaintext_evidence_ref,
             plaintext_evidence_digest, plaintext_evidence_byte_length, disposition,
             cursor_disposition, gap_id, recovery_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'server_control', NULL, 0, 3, 0, 2, ?, ?, ?, 1,
                     'invalid_payload', 'advanceable', ?, NULL)`,
        )
        .run(
          invalidObservationId,
          invalidPositionId,
          invalidResultId,
          invalidAttemptId,
          BROKER_ROUTE_ID,
          SERVER_ID,
          DIGEST,
          PLAINTEXT_ARTIFACT_ID,
          DIGEST,
          invalidGapId,
        );
      classifyInboundPosition(
        database,
        invalidPositionId,
        invalidObservationId,
        invalidAttemptId,
        "advanceable",
        invalidGapId,
        null,
        2,
      );
      database.exec("COMMIT");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  });

  it("seals open and empty generations once and seeds each exact successor", () => {
    const database = openedV8BrokerRouteDatabase();
    try {
      claimBrokerRouteActor(database);
      const manifestOne = encoded(32, 53);
      database
        .prepare(
          `UPDATE broker_channel_generation_observations
           SET observed_next_frame_index = 1, last_observed_at_ms = 45
           WHERE broker_route_id = ? AND channel_generation = 0`,
        )
        .run(BROKER_ROUTE_ID);
      database
        .prepare(
          `UPDATE broker_channel_generation_observations
           SET state = 'sealed', frame_count = 1, next_generation = 1,
               manifest_digest = ?, last_observed_at_ms = 50
           WHERE broker_route_id = ? AND channel_generation = 0`,
        )
        .run(manifestOne, BROKER_ROUTE_ID);
      expect(
        database
          .prepare(
            `SELECT state, observed_next_frame_index FROM broker_channel_generation_observations
             WHERE broker_route_id = ? AND channel_generation = 1`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ state: "open", observed_next_frame_index: 0 });
      expect(() =>
        database
          .prepare(
            `UPDATE broker_channel_generation_observations SET manifest_digest = ?
             WHERE broker_route_id = ? AND channel_generation = 0`,
          )
          .run(encoded(32, 54), BROKER_ROUTE_ID),
      ).toThrow(/transition is not allowed/);

      database
        .prepare(
          `UPDATE broker_channel_generation_observations
           SET state = 'sealed', frame_count = 0, next_generation = 2,
               manifest_digest = ?, last_observed_at_ms = 55
           WHERE broker_route_id = ? AND channel_generation = 1`,
        )
        .run(encoded(32, 55), BROKER_ROUTE_ID);
      expect(
        database
          .prepare(
            `SELECT state, observed_next_frame_index FROM broker_channel_generation_observations
             WHERE broker_route_id = ? AND channel_generation = 2`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ state: "open", observed_next_frame_index: 0 });
      expect(
        database
          .prepare(
            `SELECT current_channel_generation FROM broker_route_runtime_status
             WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ current_channel_generation: 2 });
    } finally {
      database.close();
    }
  });

  it("lets a successor coordinator replace a crash-retained actor claim but rejects stale reuse", () => {
    const database = openedV8BrokerRouteDatabase();
    try {
      claimBrokerRouteActor(database);
      database
        .prepare(
          `INSERT INTO coordinator_leases (
             coordinator_lease_id, collaboration_server_id, coordinator_epoch,
             owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
             heartbeat_deadline_ms, released_at_ms, state
           ) VALUES ('rccl_AQEBAQEBAQEBAQEBAQEBAQ', ?, 2, 'successor',
                     1000, 2000, 2000, NULL, 'current')`,
        )
        .run(SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_servers
           SET current_coordinator_epoch = 2,
               current_coordinator_lease_id = 'rccl_AQEBAQEBAQEBAQEBAQEBAQ'
           WHERE collaboration_server_id = ?`,
        )
        .run(SERVER_ID);
      database
        .prepare(
          `UPDATE broker_route_actors
           SET revision = 2, claim_token = 'successor-claim',
               coordinator_lease_id = 'rccl_AQEBAQEBAQEBAQEBAQEBAQ', coordinator_epoch = 2,
               claimed_at_ms = 1000, last_operation_id = 'claim-operation-two',
               last_operation_kind = 'claim', last_operation_digest = ?, updated_at_ms = 1000
           WHERE broker_route_id = ? AND revision = 1`,
        )
        .run(DIGEST, BROKER_ROUTE_ID);
      expect(
        database
          .prepare(
            `SELECT revision, coordinator_epoch, claim_token FROM broker_route_actors
             WHERE broker_route_id = ?`,
          )
          .get(BROKER_ROUTE_ID),
      ).toEqual({ revision: 2, coordinator_epoch: 2, claim_token: "successor-claim" });
      expect(() =>
        database
          .prepare(
            `UPDATE broker_route_actors
             SET revision = 3, claim_token = 'stale-reclaim', coordinator_lease_id = ?,
                 coordinator_epoch = 1, claimed_at_ms = 1001,
                 last_operation_id = 'stale-operation', last_operation_kind = 'claim',
                 last_operation_digest = ?, updated_at_ms = 1001
             WHERE broker_route_id = ?`,
          )
          .run(COORDINATOR_LEASE_ID, DIGEST, BROKER_ROUTE_ID),
      ).toThrow(/current unexpired coordinator/);
    } finally {
      database.close();
    }
  });

  it("finalizes one prepared native root atomically through its accepted signer fact", () => {
    const database = openedV6Database();
    try {
      prepareReadyNativeRootGraph(database);
      expect(
        database
          .prepare(
            `SELECT first_eligible_signer_sequence
             FROM native_root_signature_activation_fences
             WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
               AND runtime_owner_key_generation = 1`,
          )
          .get(RUNTIME_ID),
      ).toEqual({ first_eligible_signer_sequence: 0 });
      insertPreparedNativeRootOperation(database);
      expect(
        database
          .prepare(
            `SELECT state, signed_record_digest, committed_at_ms
             FROM native_root_activation_operations WHERE operation_id = ?`,
          )
          .get(ROOT_OPERATION_ID),
      ).toEqual({ state: "prepared", signed_record_digest: null, committed_at_ms: null });
      expect(
        database
          .prepare(
            `SELECT state, root_path_certificate_id FROM inward_collaboration_edges
             WHERE inward_edge_id = ?`,
          )
          .get(EDGE_ID),
      ).toEqual({ state: "installing", root_path_certificate_id: null });
      expect(() =>
        database
          .prepare(`UPDATE logical_chats SET state = 'ready' WHERE logical_chat_id = ?`)
          .run(CHAT_ID),
      ).toThrow(/committed native root/);
      expect(() =>
        database
          .prepare(
            `UPDATE native_root_activation_operations
             SET signed_record_digest = ?, committed_at_ms = 60, state = 'committed'
             WHERE operation_id = ?`,
          )
          .run(ROOT_SIGNED_RECORD_DIGEST, ROOT_OPERATION_ID),
      ).toThrow(/certificate finalization/);

      signAndAcceptPreparedNativeRoot(database);
      insertNativeRootCertificate(database);

      expect(
        database
          .prepare(
            `SELECT state, signed_record_digest, committed_at_ms
             FROM native_root_activation_operations WHERE operation_id = ?`,
          )
          .get(ROOT_OPERATION_ID),
      ).toEqual({
        state: "committed",
        signed_record_digest: ROOT_SIGNED_RECORD_DIGEST,
        committed_at_ms: 60,
      });
      expect(
        database
          .prepare(
            `SELECT state, root_path_certificate_id FROM inward_collaboration_edges
             WHERE inward_edge_id = ?`,
          )
          .get(EDGE_ID),
      ).toEqual({ state: "current", root_path_certificate_id: ROOT_CERTIFICATE_ID });
      expect(
        database.prepare("SELECT state FROM logical_chats WHERE logical_chat_id = ?").get(CHAT_ID),
      ).toEqual({ state: "ready" });
      expect(() => database.prepare("DELETE FROM native_root_certificates").run()).toThrow(
        /retained/,
      );
      expect(() =>
        database.prepare("UPDATE native_root_certificates SET committed_at_ms = 61").run(),
      ).toThrow(/immutable/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("backfills an immutable floor that keeps v5 native-root signatures inert", () => {
    const database = openedV5Database();
    try {
      prepareReadyNativeRootGraph(database);
      database
        .prepare(
          `UPDATE runtime_owner_signature_reservations
           SET signed_record_digest = ?, signature = ?,
               signed_artifact_id = 'historical-native-root', state = 'signed'
           WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
             AND runtime_owner_key_generation = 1 AND signer_sequence = 0`,
        )
        .run(ROOT_SIGNED_RECORD_DIGEST, SIGNATURE, RUNTIME_ID);
      database
        .prepare(
          `INSERT INTO runtime_owner_signed_record_acceptances
             (runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
              signer_sequence, signed_record_digest, accepted_at_ms)
           VALUES (?, 'runtime-key-1', 1, 0, ?, 55)`,
        )
        .run(RUNTIME_ID, ROOT_SIGNED_RECORD_DIGEST);
      reserveBoundNativeRootSigner(database, {
        signerSequence: 1,
        canonicalPayloadRef: RENEW_PAYLOAD_HANDLE_ID,
        canonicalPayloadDigest: RENEW_PAYLOAD_DIGEST,
        createdAtMs: 60,
      });

      const migration = HOST_STATE_MIGRATIONS[5];
      if (migration === undefined) throw new Error("missing v6 migration");
      for (const statement of migration.statements) database.exec(statement);

      expect(
        database
          .prepare(
            `SELECT first_eligible_signer_sequence
             FROM native_root_signature_activation_fences
             WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
               AND runtime_owner_key_generation = 1`,
          )
          .get(RUNTIME_ID),
      ).toEqual({ first_eligible_signer_sequence: 2 });
      expect(
        database
          .prepare(
            `SELECT state, signed_artifact_id
             FROM runtime_owner_signature_reservations
             WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
               AND runtime_owner_key_generation = 1 AND signer_sequence = 0`,
          )
          .get(RUNTIME_ID),
      ).toEqual({ state: "signed", signed_artifact_id: "historical-native-root" });
      expect(database.prepare("SELECT * FROM native_root_certificates").all()).toEqual([]);
      expect(database.prepare("SELECT * FROM native_root_activation_operations").all()).toEqual([]);
      expect(() => insertPreparedNativeRootOperation(database)).toThrow(/exact signer reservation/);
      expect(() =>
        insertPreparedNativeRootOperation(database, {
          signerSequence: 1,
          canonicalPayloadRef: RENEW_PAYLOAD_HANDLE_ID,
          canonicalPayloadDigest: RENEW_PAYLOAD_DIGEST,
        }),
      ).toThrow(/exact signer reservation/);
      expect(() =>
        database
          .prepare(
            `UPDATE inward_collaboration_edges
             SET root_path_certificate_id = 'historical-native-root', state = 'current'
             WHERE inward_edge_id = ?`,
          )
          .run(EDGE_ID),
      ).toThrow(/committed activation fact/);
      expect(() =>
        database
          .prepare(
            `UPDATE native_root_signature_activation_fences
             SET first_eligible_signer_sequence = 0`,
          )
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        database.prepare("DELETE FROM native_root_signature_activation_fences").run(),
      ).toThrow(/retained/);
      expect(() =>
        database
          .prepare(
            `INSERT INTO native_root_signature_activation_fences
               (runtime_id, runtime_owner_identity_key_id,
                runtime_owner_key_generation, first_eligible_signer_sequence)
             VALUES (?, 'runtime-key-1', 1, 0)`,
          )
          .run(RUNTIME_ID),
      ).toThrow(/cannot be replaced/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rechecks the actual owner and coordinator lock-time fences before finalization", () => {
    const database = openedV6Database();
    try {
      prepareReadyNativeRootGraph(database);
      insertPreparedNativeRootOperation(database);
      signAndAcceptPreparedNativeRoot(database);
      takeOverRuntimeOwner(database);

      expect(() => insertNativeRootCertificate(database)).toThrow(/current graph|unexpired fences/);
      expect(database.prepare("SELECT * FROM native_root_certificates").all()).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT state, signed_record_digest, committed_at_ms
             FROM native_root_activation_operations WHERE operation_id = ?`,
          )
          .get(ROOT_OPERATION_ID),
      ).toEqual({ state: "prepared", signed_record_digest: null, committed_at_ms: null });
      expect(
        database
          .prepare(
            `SELECT state, root_path_certificate_id FROM inward_collaboration_edges
             WHERE inward_edge_id = ?`,
          )
          .get(EDGE_ID),
      ).toEqual({ state: "installing", root_path_certificate_id: null });
    } finally {
      database.close();
    }
  });

  it("renews from the latest retained root after recovery demotes the live edge", () => {
    const database = openedV6Database();
    try {
      prepareReadyNativeRootGraph(database);
      insertPreparedNativeRootOperation(database);
      signAndAcceptPreparedNativeRoot(database);
      insertNativeRootCertificate(database);
      database
        .prepare("UPDATE logical_chats SET state = 'recovering' WHERE logical_chat_id = ?")
        .run(CHAT_ID);
      database
        .prepare(
          `UPDATE inward_collaboration_edges
           SET root_path_certificate_id = NULL, state = 'installing'
           WHERE inward_edge_id = ?`,
        )
        .run(EDGE_ID);

      database
        .prepare(
          `INSERT INTO runtime_owner_signature_reservations
             (runtime_id, runtime_owner_identity_key_id, runtime_owner_key_generation,
              signer_sequence, purpose, canonical_payload_schema_id,
              canonical_payload_ref, canonical_payload_digest, signed_record_digest,
              signature, signed_artifact_id, state)
           VALUES (?, 'runtime-key-1', 1, 1, 'native_root', NULL, NULL, NULL,
                   NULL, NULL, NULL, 'reserved')`,
        )
        .run(RUNTIME_ID);
      database
        .prepare(
          `INSERT INTO protected_artifacts
             (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
              artifact_digest, byte_length, artifact_bytes, created_at_ms)
           VALUES (?, 'artifact', 'native_binding', ?,
                   'remote-claw/native-root-certificate/v1', ?, 1, ?, 65)`,
        )
        .run(RENEW_PAYLOAD_HANDLE_ID, BINDING_ID, RENEW_PAYLOAD_DIGEST, Uint8Array.of(28));
      database
        .prepare(
          `UPDATE runtime_owner_signature_reservations
           SET canonical_payload_schema_id = 'remote-claw/native-root-certificate/v1',
               canonical_payload_ref = ?, canonical_payload_digest = ?, state = 'bound'
           WHERE runtime_id = ? AND runtime_owner_identity_key_id = 'runtime-key-1'
             AND runtime_owner_key_generation = 1 AND signer_sequence = 1`,
        )
        .run(RENEW_PAYLOAD_HANDLE_ID, RENEW_PAYLOAD_DIGEST, RUNTIME_ID);

      const renewal: NativeRootFixtureOptions = {
        operationId: RENEW_OPERATION_ID,
        operationDigest: RENEW_OPERATION_DIGEST,
        kind: "renew",
        rootPathCertificateId: RENEW_CERTIFICATE_ID,
        expectedPriorRootPathCertificateId: ROOT_CERTIFICATE_ID,
        signerSequence: 1,
        canonicalPayloadRef: RENEW_PAYLOAD_HANDLE_ID,
        canonicalPayloadDigest: RENEW_PAYLOAD_DIGEST,
        signedRecordDigest: RENEW_SIGNED_RECORD_DIGEST,
        preparedAtMs: 65,
        issuedAtMs: 70,
        expiresAtMs: 99,
        acceptedAtMs: 75,
        committedAtMs: 80,
      };
      expect(() =>
        insertPreparedNativeRootOperation(database, {
          ...renewal,
          kind: "activate",
          expectedPriorRootPathCertificateId: null,
        }),
      ).toThrow(/root lineage/);
      insertPreparedNativeRootOperation(database, renewal);
      signAndAcceptPreparedNativeRoot(database, renewal);
      insertNativeRootCertificate(database, renewal);

      expect(
        database
          .prepare(
            `SELECT state, root_path_certificate_id FROM inward_collaboration_edges
             WHERE inward_edge_id = ?`,
          )
          .get(EDGE_ID),
      ).toEqual({ state: "current", root_path_certificate_id: RENEW_CERTIFICATE_ID });
      expect(
        database.prepare("SELECT state FROM logical_chats WHERE logical_chat_id = ?").get(CHAT_ID),
      ).toEqual({ state: "ready" });
      expect(
        database
          .prepare(
            `SELECT expected_prior_root_path_certificate_id, state
             FROM native_root_activation_operations WHERE operation_id = ?`,
          )
          .get(RENEW_OPERATION_ID),
      ).toEqual({
        expected_prior_root_path_certificate_id: ROOT_CERTIFICATE_ID,
        state: "committed",
      });
      expect(
        database.prepare("SELECT count(*) AS count FROM native_root_certificates").get(),
      ).toEqual({ count: 2 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("lets a new authority win renewal while retaining an abandoned prepared fork", () => {
    const database = openedV6Database();
    try {
      prepareReadyNativeRootGraph(database);
      insertPreparedNativeRootOperation(database);
      signAndAcceptPreparedNativeRoot(database);
      insertNativeRootCertificate(database);

      reserveBoundNativeRootSigner(database, {
        signerSequence: 1,
        canonicalPayloadRef: RENEW_PAYLOAD_HANDLE_ID,
        canonicalPayloadDigest: RENEW_PAYLOAD_DIGEST,
        createdAtMs: 65,
      });
      const abandoned: NativeRootFixtureOptions = {
        operationId: RENEW_OPERATION_ID,
        operationDigest: RENEW_OPERATION_DIGEST,
        kind: "renew",
        rootPathCertificateId: RENEW_CERTIFICATE_ID,
        expectedPriorRootPathCertificateId: ROOT_CERTIFICATE_ID,
        signerSequence: 1,
        canonicalPayloadRef: RENEW_PAYLOAD_HANDLE_ID,
        canonicalPayloadDigest: RENEW_PAYLOAD_DIGEST,
        signedRecordDigest: RENEW_SIGNED_RECORD_DIGEST,
        preparedAtMs: 65,
        issuedAtMs: 70,
        expiresAtMs: 180,
        acceptedAtMs: 75,
        committedAtMs: 80,
      };
      insertPreparedNativeRootOperation(database, abandoned);

      takeOverReadyNativeRootGraph(database);
      reserveBoundNativeRootSigner(database, {
        signerSequence: 2,
        canonicalPayloadRef: TAKEOVER_RENEW_PAYLOAD_HANDLE_ID,
        canonicalPayloadDigest: TAKEOVER_RENEW_PAYLOAD_DIGEST,
        createdAtMs: 114,
      });
      const winner: NativeRootFixtureOptions = {
        operationId: TAKEOVER_RENEW_OPERATION_ID,
        operationDigest: TAKEOVER_RENEW_OPERATION_DIGEST,
        kind: "renew",
        rootPathCertificateId: TAKEOVER_RENEW_CERTIFICATE_ID,
        expectedPriorRootPathCertificateId: ROOT_CERTIFICATE_ID,
        signerSequence: 2,
        canonicalPayloadRef: TAKEOVER_RENEW_PAYLOAD_HANDLE_ID,
        canonicalPayloadDigest: TAKEOVER_RENEW_PAYLOAD_DIGEST,
        signedRecordDigest: TAKEOVER_RENEW_SIGNED_RECORD_DIGEST,
        attachmentLeaseId: "registration-attachment-lease-2",
        transportEpoch: 2,
        nativeConversationLeaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
        nativeConversationLeaseGeneration: 2,
        nativeRegistrationPublicationId: "registration-publication-2",
        publicationGeneration: 1,
        bindingGateGeneration: 3,
        runtimeOwnerServiceLeaseId: "runtime-owner-lease-2",
        runtimeOwnerServiceEpoch: 2,
        preparedAtMs: 120,
        issuedAtMs: 125,
        expiresAtMs: 180,
        acceptedAtMs: 128,
        committedAtMs: 130,
      };
      insertPreparedNativeRootOperation(database, winner);
      signAndAcceptPreparedNativeRoot(database, winner);
      insertNativeRootCertificate(database, winner);

      expect(
        database
          .prepare(
            `SELECT operation_id, state, committed_at_ms
             FROM native_root_activation_operations
             WHERE expected_prior_root_path_certificate_id = ?
             ORDER BY operation_id`,
          )
          .all(ROOT_CERTIFICATE_ID),
      ).toEqual([
        { operation_id: RENEW_OPERATION_ID, state: "prepared", committed_at_ms: null },
        {
          operation_id: TAKEOVER_RENEW_OPERATION_ID,
          state: "committed",
          committed_at_ms: 130,
        },
      ]);
      expect(
        database
          .prepare(
            `SELECT root_path_certificate_id
             FROM native_root_certificates
             WHERE expected_prior_root_path_certificate_id = ?`,
          )
          .all(ROOT_CERTIFICATE_ID),
      ).toEqual([{ root_path_certificate_id: TAKEOVER_RENEW_CERTIFICATE_ID }]);
      expect(
        database
          .prepare(
            `SELECT state, root_path_certificate_id FROM inward_collaboration_edges
             WHERE inward_edge_id = ?`,
          )
          .get(EDGE_ID),
      ).toEqual({ state: "current", root_path_certificate_id: TAKEOVER_RENEW_CERTIFICATE_ID });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("orders same-millisecond durable registration effects by a contiguous lease sequence", () => {
    const database = openedV5Database();
    try {
      prepareDurableRegistrationGraph(database);
      insertRegistrationArtifacts(database);
      insertStartingConversationLease(database);

      expect(() => insertRegistrationOperation(database, "operation-gap", 2, "bind", 25)).toThrow(
        /next lease sequence/,
      );
      insertRegistrationOperation(database, "operation-open", 1, "open", 25);
      expect(() =>
        database
          .prepare(
            `UPDATE native_conversation_leases
             SET native_binding_incarnation_id = 'registration-binding-incarnation',
                 attachment_lease_id = 'registration-attachment-lease',
                 updated_at_ms = 25
             WHERE native_conversation_lease_id = ?`,
          )
          .run(NATIVE_CONVERSATION_LEASE_ID),
      ).toThrow(/correlated operation/);
      insertRegistrationOperation(database, "operation-bind", 2, "bind", 30);
      database
        .prepare(
          `UPDATE native_conversation_leases
           SET native_binding_incarnation_id = 'registration-binding-incarnation',
               attachment_lease_id = 'registration-attachment-lease',
               updated_at_ms = 30
           WHERE native_conversation_lease_id = ?`,
        )
        .run(NATIVE_CONVERSATION_LEASE_ID);

      expect(() =>
        database
          .prepare(
            `INSERT INTO native_registration_publications
               (native_registration_publication_id, native_conversation_lease_id,
                native_binding_id, runtime_id, native_incarnation,
                native_binding_incarnation_id, attachment_lease_id,
                publication_generation, metadata_schema_id, metadata_ref,
                metadata_digest, capabilities_schema_id, capabilities_ref,
                capabilities_digest, published_at_ms, state)
             VALUES ('registration-publication-bad', ?, ?, ?, 1,
                     'registration-binding-incarnation', 'registration-attachment-lease',
                     1, 'provider-metadata/v1', ?, ?,
                     'remote-claw/native-conversation-capabilities/v1', ?, ?, 30, 'current')`,
          )
          .run(
            NATIVE_CONVERSATION_LEASE_ID,
            BINDING_ID,
            RUNTIME_ID,
            METADATA_HANDLE_ID,
            DIGEST,
            CAPABILITIES_HANDLE_ID,
            CAPABILITIES_DIGEST,
          ),
      ).toThrow(/exact lease and artifacts/);
      database
        .prepare(
          `INSERT INTO native_registration_publications
             (native_registration_publication_id, native_conversation_lease_id,
              native_binding_id, runtime_id, native_incarnation,
              native_binding_incarnation_id, attachment_lease_id,
              publication_generation, metadata_schema_id, metadata_ref,
              metadata_digest, capabilities_schema_id, capabilities_ref,
              capabilities_digest, published_at_ms, state)
           VALUES ('registration-publication-1', ?, ?, ?, 1,
                   'registration-binding-incarnation', 'registration-attachment-lease',
                   1, 'provider-metadata/v1', ?, ?,
                   'remote-claw/native-conversation-capabilities/v1', ?, ?, 30, 'current')`,
        )
        .run(
          NATIVE_CONVERSATION_LEASE_ID,
          BINDING_ID,
          RUNTIME_ID,
          METADATA_HANDLE_ID,
          METADATA_DIGEST,
          CAPABILITIES_HANDLE_ID,
          CAPABILITIES_DIGEST,
        );
      insertRegistrationOperation(database, "operation-publish", 3, "publish", 30);
      database
        .prepare(
          `UPDATE native_conversation_leases
           SET current_publication_id = 'registration-publication-1', updated_at_ms = 30
           WHERE native_conversation_lease_id = ?`,
        )
        .run(NATIVE_CONVERSATION_LEASE_ID);
      insertRegistrationOperation(database, "operation-ready", 4, "ready", 30);
      database
        .prepare(
          `UPDATE native_conversation_leases
           SET state = 'ready', updated_at_ms = 30
           WHERE native_conversation_lease_id = ?`,
        )
        .run(NATIVE_CONVERSATION_LEASE_ID);

      expect(
        database
          .prepare(
            `SELECT next_operation_sequence, updated_at_ms, state
             FROM native_conversation_leases
             WHERE native_conversation_lease_id = ?`,
          )
          .get(NATIVE_CONVERSATION_LEASE_ID),
      ).toEqual({ next_operation_sequence: 5, updated_at_ms: 30, state: "ready" });
      expect(
        database
          .prepare(
            `SELECT operation_sequence, kind
             FROM native_registration_operations
             WHERE native_conversation_lease_id = ?
             ORDER BY operation_sequence`,
          )
          .all(NATIVE_CONVERSATION_LEASE_ID),
      ).toEqual([
        { operation_sequence: 1, kind: "open" },
        { operation_sequence: 2, kind: "bind" },
        { operation_sequence: 3, kind: "publish" },
        { operation_sequence: 4, kind: "ready" },
      ]);

      insertRegistrationOperation(database, "operation-close", 5, "close", 30);
      database
        .prepare(
          `UPDATE native_conversation_leases
           SET updated_at_ms = 30, closed_at_ms = 30, state = 'closed'
           WHERE native_conversation_lease_id = ?`,
        )
        .run(NATIVE_CONVERSATION_LEASE_ID);
      expect(() =>
        insertRegistrationOperation(database, "operation-after-close", 6, "recover", 30),
      ).toThrow(/exact lease/);
      insertStartingConversationLease(database, {
        leaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
        portHandleId: SUCCESSOR_PROTECTED_PORT_HANDLE_ID,
        acquiredAtMs: 30,
        leaseGeneration: 2,
        supersedesLeaseId: NATIVE_CONVERSATION_LEASE_ID,
        state: "recovering",
      });
      expect(() =>
        insertRegistrationOperation(database, "operation-successor-open", 1, "open", 30, {
          leaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
        }),
      ).toThrow(/exact lease/);
      insertRegistrationOperation(database, "operation-reattach", 1, "reattach", 30, {
        leaseId: SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID,
      });
      expect(
        database
          .prepare(
            `SELECT next_operation_sequence
             FROM native_conversation_leases
             WHERE native_conversation_lease_id = ?`,
          )
          .get(SUCCESSOR_NATIVE_CONVERSATION_LEASE_ID),
      ).toEqual({ next_operation_sequence: 2 });
      expect(() =>
        database
          .prepare(
            "UPDATE native_registration_operations SET committed_at_ms = 31 WHERE operation_id = 'operation-open'",
          )
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        database
          .prepare(
            `INSERT INTO protected_artifacts
               (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
                artifact_digest, byte_length, artifact_bytes, created_at_ms)
             VALUES (?, 'artifact', 'native_binding', ?, 'test/v1', ?, 1, ?, 31)`,
          )
          .run(PROTECTED_PORT_HANDLE_ID, BINDING_ID, DIGEST, Uint8Array.of(1)),
      ).toThrow(/callable port/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects a globally current owner that is stale for the selected runtime", () => {
    const database = openedV5Database();
    try {
      prepareDurableRegistrationGraph(database);
      takeOverRuntimeOwner(database);

      expect(() =>
        insertStartingConversationLease(database, {
          ownerLeaseId: "runtime-owner-lease-2",
          ownerEpoch: 2,
          acquiredAtMs: 110,
        }),
      ).toThrow(/exact active graph/);
      expect(() => insertStartingConversationLease(database, { acquiredAtMs: 110 })).toThrow(
        /current owner and coordinator fences/,
      );
      expect(database.prepare("SELECT * FROM native_conversation_leases").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("fences every operation and lets the current successor close an orphaned lease", () => {
    const database = openedV5Database();
    try {
      prepareDurableRegistrationGraph(database);
      insertStartingConversationLease(database);
      insertRegistrationOperation(database, "operation-open", 1, "open", 25);
      takeOverRuntimeOwner(database);

      expect(() =>
        insertRegistrationOperation(database, "operation-stale-close", 2, "close", 110),
      ).toThrow(/current unexpired fences/);
      insertRegistrationOperation(database, "operation-successor-close", 2, "close", 110, {
        ownerLeaseId: "runtime-owner-lease-2",
        ownerEpoch: 2,
      });
      database
        .prepare(
          `UPDATE native_conversation_leases
           SET updated_at_ms = 110, closed_at_ms = 110, state = 'closed'
           WHERE native_conversation_lease_id = ?`,
        )
        .run(NATIVE_CONVERSATION_LEASE_ID);

      expect(
        database
          .prepare(
            `SELECT runtime_owner_service_lease_id, runtime_owner_service_epoch,
                    coordinator_lease_id, coordinator_epoch
             FROM native_registration_operations
             WHERE operation_id = 'operation-successor-close'`,
          )
          .get(),
      ).toEqual({
        runtime_owner_service_lease_id: "runtime-owner-lease-2",
        runtime_owner_service_epoch: 2,
        coordinator_lease_id: COORDINATOR_LEASE_ID,
        coordinator_epoch: 1,
      });
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
