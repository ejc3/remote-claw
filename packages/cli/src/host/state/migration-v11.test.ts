import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  VERSION_ELEVEN_DATA_STATEMENTS,
  VERSION_ELEVEN_PRE_SCHEMA_STATEMENTS,
  VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v11.js";
import { HOST_STATE_MIGRATIONS } from "./migrations.js";

function encoded(byteLength: number, fill: number): string {
  return base64urlEncode(new Uint8Array(byteLength).fill(fill));
}

const MACHINE_ID = "0".repeat(32);
const SERVER_ID = `rcs_${encoded(16, 1)}`;
const OLD_COORDINATOR_ID = `rccl_${encoded(16, 2)}`;
const NEW_COORDINATOR_ID = `rccl_${encoded(16, 3)}`;
const ROUTE_ID = `rcr_${encoded(32, 4)}`;
const RESULT_ID = `rrs_${encoded(32, 5)}`;
const COMMAND_ID = `rcm_${encoded(32, 6)}`;
const COMMAND_RESULT_ID = `ccr_${encoded(32, 7)}`;
const PREPARATION_ID = `crp_${encoded(32, 8)}`;
const GROUP_ID = `csg_${encoded(32, 9)}`;
const COMPLETION_OBSERVATION_ID = `rio_${encoded(32, 10)}`;
const EARLIER_OBSERVATION_ID = `rio_${encoded(32, 11)}`;
const COMPLETION_POSITION_ID = `rcp_${encoded(32, 12)}`;
const EARLIER_POSITION_ID = `rcp_${encoded(32, 13)}`;
const RESULT_DELIVERY_ID = `rrd_${encoded(32, 14)}`;
const ACCEPTED_INGRESS_ATTEMPT_ID = `rda_${encoded(16, 15)}`;
const RESULT_DELIVERY_ATTEMPT_ID = `rda_${encoded(16, 16)}`;
const SOURCE_NAMESPACE_ID = `wns_${encoded(32, 17)}`;
const COMMAND_PAYLOAD_REF = `rcph_${encoded(16, 18)}`;
const DECISION_REF = `rcph_${encoded(16, 19)}`;
const RESULT_PAYLOAD_REF = `rcph_${encoded(16, 20)}`;
const SEMANTIC_PAYLOAD_REF = `rcph_${encoded(16, 21)}`;
const PART_REF = `rcph_${encoded(16, 22)}`;
const SIGNING_KEY_REF = `rcph_${encoded(16, 23)}`;
const TRUST_REF = `rcph_${encoded(16, 24)}`;
const CAPABILITY_REF = `rbcp_${encoded(32, 25)}`;
const STORE_INSTANCE_ID = `rbsi_${encoded(16, 26)}`;
const DIGEST = encoded(32, 27);
const COMMAND_DIGEST = encoded(32, 28);
const SIGNED_RECORD_DIGEST = encoded(32, 29);
const BOOTSTRAP_SIGNED_DIGEST = encoded(32, 30);
const SEMANTIC_ARTIFACT_DIGEST = encoded(32, 31);
const STORED_SEMANTIC_DIGEST = encoded(32, 32);
const PUBLIC_KEY = encoded(32, 33);
const SIGNATURE = encoded(64, 34);
const IDENTITY_KEY_ID = "server-key-1";
const CERTIFICATE_ID = "server-cert-1";
const SIGNING_LEASE_ID = "server-signing-lease-1";
const LATER_SIGNING_LEASE_ID = "server-signing-lease-2";

function openVersionEleven(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of HOST_STATE_MIGRATIONS.slice(0, 10)) {
    for (const statement of migration.statements) database.exec(statement);
  }
  for (const statement of VERSION_ELEVEN_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  for (const entry of VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES) database.exec(entry.sql);
  for (const statement of VERSION_ELEVEN_DATA_STATEMENTS) database.exec(statement);
  return database;
}

interface FinalizationFixtureOptions {
  readonly collidedClosedRoute?: boolean;
  readonly supersededSigner?: boolean;
  readonly interveningSigner?: boolean;
  readonly supersededAtMs?: number;
}

function installVersionElevenAroundSeed(options: FinalizationFixtureOptions = {}): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of HOST_STATE_MIGRATIONS.slice(0, 10)) {
    for (const statement of migration.statements) database.exec(statement);
  }
  for (const statement of VERSION_ELEVEN_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  const retainedTriggers = database
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
    .all() as unknown as readonly Readonly<{ name: string; sql: string }>[];
  for (const retained of retainedTriggers) database.exec(`DROP TRIGGER ${retained.name}`);
  for (const entry of VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES) {
    if (entry.type !== "trigger") database.exec(entry.sql);
  }
  database.exec("PRAGMA foreign_keys = OFF");
  seedFinalizationFixture(database, options);
  database.exec("PRAGMA foreign_keys = ON");
  for (const retained of retainedTriggers) database.exec(retained.sql);
  for (const entry of VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES) {
    if (entry.type === "trigger") database.exec(entry.sql);
  }
  return database;
}

function insertArtifact(
  database: DatabaseSync,
  ref: string,
  schemaId: string,
  digest: string,
  createdAtMs: number,
): void {
  database
    .prepare(
      `INSERT INTO protected_artifacts
         (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
          artifact_digest, byte_length, artifact_bytes, created_at_ms)
       VALUES (?, 'artifact', 'collaboration_server', ?, ?, ?, 1, ?, ?)`,
    )
    .run(ref, SERVER_ID, schemaId, digest, Buffer.of(1), createdAtMs);
}

function seedFinalizationFixture(
  database: DatabaseSync,
  options: FinalizationFixtureOptions,
): void {
  const supersededSigner = options.supersededSigner === true;
  const finalCoordinatorId = supersededSigner ? NEW_COORDINATOR_ID : OLD_COORDINATOR_ID;
  const finalCoordinatorEpoch = supersededSigner ? 2 : 1;
  const supersededAtMs = options.supersededAtMs ?? 26;
  database
    .prepare(
      `INSERT INTO host_state_metadata
         (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
       VALUES (1, ?, 10, ?, 1)`,
    )
    .run(MACHINE_ID, DIGEST);
  database
    .prepare(
      `INSERT INTO collaboration_servers
         (collaboration_server_id, machine_identity_id, current_key_generation,
          current_identity_key_id, current_scope_certificate_id,
          current_coordinator_epoch, current_coordinator_lease_id,
          next_journal_offset, next_server_signature_seq, next_command_seq,
          created_at_ms, state)
       VALUES (?, ?, 1, ?, ?, ?, ?, 1, 2, 1, 2, 'current')`,
    )
    .run(
      SERVER_ID,
      MACHINE_ID,
      IDENTITY_KEY_ID,
      CERTIFICATE_ID,
      finalCoordinatorEpoch,
      finalCoordinatorId,
    );
  database
    .prepare(
      `INSERT INTO coordinator_leases
         (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
          owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
          heartbeat_deadline_ms, released_at_ms, state)
       VALUES (?, ?, 1, 'old-owner', 2, 100, 100, ?, ?)`,
    )
    .run(
      OLD_COORDINATOR_ID,
      SERVER_ID,
      supersededSigner ? supersededAtMs : null,
      supersededSigner ? "released" : "current",
    );
  if (supersededSigner) {
    database
      .prepare(
        `INSERT INTO coordinator_leases
           (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
            owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
            heartbeat_deadline_ms, released_at_ms, state)
         VALUES (?, ?, 2, 'new-owner', 27, 100, 100, NULL, 'current')`,
      )
      .run(NEW_COORDINATOR_ID, SERVER_ID);
  }
  database
    .prepare(
      `INSERT INTO broker_routes
         (broker_route_id, machine_identity_id, collaboration_server_id,
          route_kind, logical_chat_id, route_token, broker_origin,
          broker_backend_selector, broker_route_store_instance_id,
          genesis_generation, broker_backend_capabilities_ref,
          broker_backend_capabilities_digest, coordinator_lease_id,
          coordinator_epoch, created_at_ms, state)
       VALUES (?, ?, ?, 'server_control', NULL, ?, 'https://broker.invalid',
               'sqlite', ?, 0, ?, ?, ?, 1, 10, ?)`,
    )
    .run(
      ROUTE_ID,
      MACHINE_ID,
      SERVER_ID,
      `ctl:a1:${DIGEST}`,
      STORE_INSTANCE_ID,
      CAPABILITY_REF,
      DIGEST,
      OLD_COORDINATOR_ID,
      options.collidedClosedRoute === true ? "closed" : "current",
    );
  database
    .prepare(
      `INSERT INTO broker_route_runtime_status
         (broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
          machine_identity_id, state, current_channel_generation,
          active_gap_count, updated_at_ms)
       VALUES (?, ?, 'server_control', NULL, ?, ?, 0, ?, 26)`,
    )
    .run(
      ROUTE_ID,
      SERVER_ID,
      MACHINE_ID,
      options.collidedClosedRoute === true ? "closed" : "current",
      options.collidedClosedRoute === true ? 1 : 0,
    );
  database
    .prepare(
      `INSERT INTO broker_route_actors
         (broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
          revision, claim_token, coordinator_lease_id, coordinator_epoch,
          claimed_at_ms, last_operation_id, last_operation_kind,
          last_operation_digest, updated_at_ms)
       VALUES (?, ?, 'server_control', NULL, 1, 'claim-token', ?, ?, ?,
               NULL, NULL, NULL, ?)`,
    )
    .run(
      ROUTE_ID,
      SERVER_ID,
      finalCoordinatorId,
      finalCoordinatorEpoch,
      supersededSigner ? 28 : 10,
      supersededSigner ? 28 : 10,
    );

  insertArtifact(
    database,
    COMMAND_PAYLOAD_REF,
    "remote-claw/command-payload/unsupported-recognized/v1",
    DIGEST,
    20,
  );
  insertArtifact(
    database,
    DECISION_REF,
    "remote-claw/collaboration-command-decision-evidence/v1",
    DIGEST,
    22,
  );
  insertArtifact(
    database,
    RESULT_PAYLOAD_REF,
    "remote-claw/collaboration-command-result/v1",
    DIGEST,
    22,
  );
  insertArtifact(
    database,
    SEMANTIC_PAYLOAD_REF,
    "remote-claw/a1-chat-creation-result/v1",
    SEMANTIC_ARTIFACT_DIGEST,
    29,
  );
  insertArtifact(database, PART_REF, "remote-claw/a1/plaintext-part/v1", DIGEST, 15);
  insertArtifact(database, TRUST_REF, "remote-claw/test-trust/v1", DIGEST, 3);

  database
    .prepare(
      `INSERT INTO authenticated_ingress_results
         (stable_semantic_result_id, broker_route_id, collaboration_server_id,
          route_kind, logical_chat_id, source_event_namespace_id, message_id,
          record_kind, client_message_id, expected_parts, source_payload_schema_id,
          canonical_message_digest, source_event_fingerprint_schema_id,
          source_event_fingerprint, accepted_delivery_attempt_id,
          first_ingress_generation, first_ingress_frame_index,
          last_observed_ingress_generation, last_observed_ingress_frame_index,
          assembly_deadline_ms, state, collision_at_ms, terminal_at_ms)
       VALUES (?, ?, ?, 'server_control', NULL, ?, 'source-message', 'new_chat',
               'client-message', 2, 'remote-claw/a1-ingress-new-chat/v1', ?,
               'remote-claw/a1/source-event-fingerprint/v1', ?, ?,
               0, 4, 0, 5, 100, ?, ?, ?)`,
    )
    .run(
      RESULT_ID,
      ROUTE_ID,
      SERVER_ID,
      SOURCE_NAMESPACE_ID,
      DIGEST,
      DIGEST,
      ACCEPTED_INGRESS_ATTEMPT_ID,
      options.collidedClosedRoute === true ? "quarantined_collision" : "awaiting_order",
      options.collidedClosedRoute === true ? 26 : null,
      options.collidedClosedRoute === true ? 26 : null,
    );
  database
    .prepare(
      `INSERT INTO ingress_transport_attempts
         (broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
          delivery_attempt_id, source_event_namespace_id,
          stable_semantic_result_id, message_id, record_kind, client_message_id,
          stable_logical_header_digest, expected_parts, binding_disposition,
          collision_gap_id, candidate_required_result_id)
       VALUES (?, ?, 'server_control', NULL, ?, ?, ?, 'source-message',
               'new_chat', 'client-message', ?, 2, 'exact', NULL, ?)`,
    )
    .run(
      ROUTE_ID,
      SERVER_ID,
      ACCEPTED_INGRESS_ATTEMPT_ID,
      SOURCE_NAMESPACE_ID,
      RESULT_ID,
      DIGEST,
      RESULT_ID,
    );
  database
    .prepare(
      `INSERT INTO ingress_delivery_candidates
         (stable_semantic_result_id, delivery_attempt_id, broker_route_id,
          collaboration_server_id, route_kind, logical_chat_id, expected_parts,
          received_parts, plaintext_byte_count, first_ingress_generation,
          first_ingress_frame_index, last_observed_ingress_generation,
          last_observed_ingress_frame_index, state)
       VALUES (?, ?, ?, ?, 'server_control', NULL, 2, 2, 2, 0, 4, 0, 5,
               'complete')`,
    )
    .run(RESULT_ID, ACCEPTED_INGRESS_ATTEMPT_ID, ROUTE_ID, SERVER_ID);
  for (const [part, positionId, observationId, frameIndex] of [
    [0, EARLIER_POSITION_ID, EARLIER_OBSERVATION_ID, 4],
    [1, COMPLETION_POSITION_ID, COMPLETION_OBSERVATION_ID, 5],
  ] as const) {
    database
      .prepare(
        `INSERT INTO authenticated_ingress_parts
           (stable_semantic_result_id, delivery_attempt_id, part, broker_route_id,
            collaboration_server_id, route_kind, logical_chat_id, parts,
            authenticated_part_digest, plaintext_part_ref, plaintext_part_digest,
            plaintext_part_byte_length, first_ingress_generation,
            first_ingress_frame_index)
         VALUES (?, ?, ?, ?, ?, 'server_control', NULL, 2, ?, ?, ?, 1, 0, ?)`,
      )
      .run(
        RESULT_ID,
        ACCEPTED_INGRESS_ATTEMPT_ID,
        part,
        ROUTE_ID,
        SERVER_ID,
        DIGEST,
        PART_REF,
        DIGEST,
        frameIndex,
      );
    database
      .prepare(
        `INSERT INTO authenticated_ingress_observations
           (ingress_observation_id, channel_position_observation_id,
            stable_semantic_result_id, delivery_attempt_id, broker_route_id,
            collaboration_server_id, route_kind, logical_chat_id,
            channel_generation, frame_index, part, parts,
            authenticated_part_digest, plaintext_evidence_ref,
            plaintext_evidence_digest, plaintext_evidence_byte_length,
            disposition, cursor_disposition, gap_id, recovery_id)
         VALUES (?, ?, ?, ?, ?, ?, 'server_control', NULL, 0, ?, ?, 2,
                 ?, ?, ?, 1, 'new_part', 'advanceable', NULL, NULL)`,
      )
      .run(
        observationId,
        positionId,
        RESULT_ID,
        ACCEPTED_INGRESS_ATTEMPT_ID,
        ROUTE_ID,
        SERVER_ID,
        frameIndex,
        part,
        DIGEST,
        PART_REF,
        DIGEST,
      );
  }

  database
    .prepare(
      `INSERT INTO server_identity_keys
         (collaboration_server_id, identity_key_id, key_generation, algorithm,
          public_key, signing_key_ref, introduced_by_scope_certificate_id,
          trust_evidence_ref, trust_evidence_digest, valid_from_ms, state)
       VALUES (?, ?, 1, 'Ed25519', ?, ?, ?, ?, ?, 4, 'current')`,
    )
    .run(
      SERVER_ID,
      IDENTITY_KEY_ID,
      PUBLIC_KEY,
      SIGNING_KEY_REF,
      CERTIFICATE_ID,
      TRUST_REF,
      DIGEST,
    );
  database
    .prepare(
      `INSERT INTO server_scope_certificates
         (scope_certificate_id, schema_version, canonical_payload_schema_id,
          collaboration_server_id, machine_identity_id, subject_identity_key_id,
          subject_key_algorithm, subject_public_key, key_generation, issued_at_ms,
          supersedes_scope_certificate_id, signer_identity_key_id, signer_sequence,
          superseded_signer_max_sequence, signature_algorithm,
          canonical_payload_digest_algorithm, canonical_payload_digest, signature)
       VALUES (?, 1, 'remote-claw/server-scope-certificate/v1', ?, ?, ?,
               'Ed25519', ?, 1, 5, NULL, ?, 0, NULL, 'Ed25519', 'SHA-256', ?, ?)`,
    )
    .run(
      CERTIFICATE_ID,
      SERVER_ID,
      MACHINE_ID,
      IDENTITY_KEY_ID,
      PUBLIC_KEY,
      IDENTITY_KEY_ID,
      DIGEST,
      SIGNATURE,
    );
  database
    .prepare(
      `INSERT INTO server_scope_certificate_statuses
         (collaboration_server_id, scope_certificate_id, state,
          accept_signatures_through_sequence, changed_at_ms,
          change_evidence_ref, change_evidence_digest)
       VALUES (?, ?, 'current', NULL, 6, ?, ?)`,
    )
    .run(SERVER_ID, CERTIFICATE_ID, TRUST_REF, DIGEST);
  database
    .prepare(
      `INSERT INTO server_signing_leases
         (signing_lease_id, collaboration_server_id, identity_key_id,
          key_generation, scope_certificate_id, coordinator_lease_id,
          coordinator_epoch, fencing_token, acquired_at_ms, draining_at_ms,
          superseded_at_ms, closed_at_ms, state)
       VALUES (?, ?, ?, 1, ?, ?, 1, 1, 7, NULL, ?, NULL, ?)`,
    )
    .run(
      SIGNING_LEASE_ID,
      SERVER_ID,
      IDENTITY_KEY_ID,
      CERTIFICATE_ID,
      OLD_COORDINATOR_ID,
      supersededSigner ? supersededAtMs : null,
      supersededSigner ? "superseded" : "current",
    );
  if (options.interveningSigner === true) {
    database
      .prepare(
        `INSERT INTO server_signing_leases
           (signing_lease_id, collaboration_server_id, identity_key_id,
            key_generation, scope_certificate_id, coordinator_lease_id,
            coordinator_epoch, fencing_token, acquired_at_ms, draining_at_ms,
            superseded_at_ms, closed_at_ms, state)
         VALUES (?, ?, ?, 1, ?, ?, 2, 2, 27, NULL, NULL, NULL, 'current')`,
      )
      .run(LATER_SIGNING_LEASE_ID, SERVER_ID, IDENTITY_KEY_ID, CERTIFICATE_ID, NEW_COORDINATOR_ID);
  }
  database
    .prepare(
      `INSERT INTO server_signature_reservations
         (collaboration_server_id, signer_sequence, signing_lease_id,
          signing_lease_kind, purpose, canonical_payload_schema_id,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state)
       VALUES (?, 0, 'bootstrap-lease', 'bootstrap', 'scope_certificate',
               'remote-claw/server-scope-certificate/v1', ?, ?, ?, ?,
               'server_scope_certificate', ?, 3, 4, 5, NULL, 'signed')`,
    )
    .run(SERVER_ID, TRUST_REF, DIGEST, BOOTSTRAP_SIGNED_DIGEST, SIGNATURE, CERTIFICATE_ID);
  database
    .prepare(
      `INSERT INTO server_signed_record_acceptances
         (collaboration_server_id, accepted_at_journal_seq, signed_record_digest,
          signer_identity_key_id, signer_key_generation,
          signer_scope_certificate_id, signer_sequence, accepted_at_ms,
          historical_reattestation_id)
       VALUES (?, 0, ?, ?, 1, ?, 0, 6, NULL)`,
    )
    .run(SERVER_ID, BOOTSTRAP_SIGNED_DIGEST, IDENTITY_KEY_ID, CERTIFICATE_ID);
  database
    .prepare(
      `INSERT INTO server_signature_reservations
         (collaboration_server_id, signer_sequence, signing_lease_id,
          signing_lease_kind, purpose, canonical_payload_schema_id,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state)
       VALUES (?, 1, ?, 'current', 'collaboration_command_result',
               'remote-claw/collaboration-command-result/v1', ?, ?, ?, ?,
               'collaboration_command_result_preparation', ?, 22, 23, 25,
               NULL, 'signed')`,
    )
    .run(
      SERVER_ID,
      SIGNING_LEASE_ID,
      RESULT_PAYLOAD_REF,
      DIGEST,
      SIGNED_RECORD_DIGEST,
      SIGNATURE,
      PREPARATION_ID,
    );

  database
    .prepare(
      `INSERT INTO collaboration_commands
         (command_id, collaboration_server_id, scope_kind, logical_chat_id,
          target_logical_chat_id, source_kind, source_ref,
          source_event_namespace_id, source_event_id,
          source_command_identity_digest, canonical_source_event_digest,
          mutation_family, canonical_command_payload_schema_id,
          canonical_command_payload_ref, canonical_command_payload_digest,
          pre_decision_normalization_evidence_schema_id,
          pre_decision_normalization_evidence_ref,
          pre_decision_normalization_evidence_digest, ready_at_journal_seq,
          command_seq, disposition, admitted_target_kind,
          project_target_selector_mapping_id,
          project_target_selector_mapping_generation, project_target_digest,
          selected_executor_evidence_schema_id, selected_executor_evidence_ref,
          selected_executor_evidence_digest, target_capability_snapshot_id,
          target_capability_family_digest, current_command_result_id,
          decision_evidence_schema_id, decision_evidence_ref,
          decision_evidence_digest, canonical_command_record_digest,
          coordinator_lease_id, coordinator_epoch,
          decision_coordinator_lease_id, decision_coordinator_epoch,
          created_at_ms, decided_at_ms, state)
       VALUES (?, ?, 'server_control', NULL, NULL, 'a1_ingress', ?, ?,
               'source-message', ?, NULL, 'new_chat',
               'remote-claw/command-payload/unsupported-recognized/v1', ?, ?,
               NULL, NULL, NULL, 0, 0, 'rejected', NULL, NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, NULL, NULL,
               'remote-claw/collaboration-command-decision-evidence/v1', ?, ?, ?,
               ?, 1, ?, 1, 20, 22, 'decision_reserved')`,
    )
    .run(
      COMMAND_ID,
      SERVER_ID,
      RESULT_ID,
      SOURCE_NAMESPACE_ID,
      DIGEST,
      COMMAND_PAYLOAD_REF,
      DIGEST,
      DECISION_REF,
      DIGEST,
      COMMAND_DIGEST,
      OLD_COORDINATOR_ID,
      OLD_COORDINATOR_ID,
    );
  database
    .prepare(
      `INSERT INTO command_ready_entries
         (collaboration_server_id, ready_at_journal_seq, command_id,
          stable_semantic_result_id, coordinator_lease_id,
          coordinator_epoch, ready_at_ms)
       VALUES (?, 0, ?, ?, ?, 1, 20)`,
    )
    .run(SERVER_ID, COMMAND_ID, RESULT_ID, OLD_COORDINATOR_ID);
  database
    .prepare(
      `INSERT INTO a1_ingress_adjudications
         (stable_semantic_result_id, collaboration_server_id, command_id,
          ready_at_journal_seq, command_seq, disposition, command_result_id,
          command_result_preparation_id, viewer_projection_seq, decided_at_ms,
          terminal_at_ms, state)
       VALUES (?, ?, ?, 0, 0, 'rejected', ?, ?, NULL, 22, NULL, 'deciding')`,
    )
    .run(RESULT_ID, SERVER_ID, COMMAND_ID, COMMAND_RESULT_ID, PREPARATION_ID);
  database
    .prepare(
      `INSERT INTO collaboration_command_compound_signing_groups
         (compound_signing_group_id, collaboration_server_id, command_id,
          command_result_id, preparation_generation, signing_lease_id,
          result_preparation_ref, required_finalization_artifact_kind,
          secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
          both_signed_at_ms, finalized_at_ms, aborted_at_ms, state)
       VALUES (?, ?, ?, ?, 1, ?, ?, 'none', NULL, 22, 25, NULL, NULL,
               NULL, 'result_signed')`,
    )
    .run(GROUP_ID, SERVER_ID, COMMAND_ID, COMMAND_RESULT_ID, SIGNING_LEASE_ID, PREPARATION_ID);
  database
    .prepare(
      `INSERT INTO collaboration_command_result_preparations
         (command_result_preparation_id, command_result_id,
          collaboration_server_id, command_id, canonical_command_record_digest,
          result_version, preparation_generation, supersedes_preparation_ref,
          canonical_payload_ref, canonical_payload_digest, signer_sequence,
          signing_lease_id, compound_signing_group_id,
          required_finalization_artifact_kind,
          current_finalization_artifact_preparation_ref, prepared_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state)
       VALUES (?, ?, ?, ?, ?, 1, 1, NULL, ?, ?, 1, ?, ?, 'none', NULL,
               22, 23, 25, NULL, 'signed')`,
    )
    .run(
      PREPARATION_ID,
      COMMAND_RESULT_ID,
      SERVER_ID,
      COMMAND_ID,
      COMMAND_DIGEST,
      RESULT_PAYLOAD_REF,
      DIGEST,
      SIGNING_LEASE_ID,
      GROUP_ID,
    );
}

function finalCoordinator(database: DatabaseSync): Readonly<{ id: string; epoch: number }> {
  const row = database
    .prepare(
      `SELECT current_coordinator_lease_id AS id, current_coordinator_epoch AS epoch
         FROM collaboration_servers WHERE collaboration_server_id = ?`,
    )
    .get(SERVER_ID) as Readonly<{ id: string; epoch: number }>;
  return row;
}

function insertCommonResult(
  database: DatabaseSync,
  options?: Readonly<{ disposition?: "rejected" | "admitted" }>,
): void {
  database
    .prepare(
      `INSERT INTO collaboration_command_results
         (command_result_id, collaboration_server_id, command_id,
          canonical_command_record_digest, result_version,
          supersedes_command_result_id, source_kind, source_ref, scope_kind,
          logical_chat_id, target_logical_chat_id, command_seq, disposition,
          canonical_payload_schema_id, canonical_payload_ref,
          canonical_payload_digest, command_result_preparation_id,
          compound_signing_group_id, signer_sequence, server_key_generation,
          signer_identity_key_id, signer_scope_certificate_id,
          signature_algorithm, signature, signed_record_digest,
          accepted_at_journal_seq, created_at_ms, finalized_at_ms)
       VALUES (?, ?, ?, ?, 1, NULL, 'a1_ingress', ?, 'server_control', NULL,
               NULL, 0, ?, 'remote-claw/collaboration-command-result/v1',
               ?, ?, ?, ?, 1, 1, ?, ?, 'Ed25519', ?, ?, 1, 22, 30)`,
    )
    .run(
      COMMAND_RESULT_ID,
      SERVER_ID,
      COMMAND_ID,
      COMMAND_DIGEST,
      RESULT_ID,
      options?.disposition ?? "rejected",
      RESULT_PAYLOAD_REF,
      DIGEST,
      PREPARATION_ID,
      GROUP_ID,
      IDENTITY_KEY_ID,
      CERTIFICATE_ID,
      SIGNATURE,
      SIGNED_RECORD_DIGEST,
    );
}

function insertTerminalResult(
  database: DatabaseSync,
  triggerIngressObservationId = COMPLETION_OBSERVATION_ID,
): void {
  const coordinator = finalCoordinator(database);
  database
    .prepare(
      `INSERT INTO a1_ingress_terminal_results
         (stable_semantic_result_id, collaboration_server_id, broker_route_id,
          command_id, command_result_id, accepted_ingress_delivery_attempt_id,
          trigger_ingress_observation_id, initial_result_delivery_id,
          semantic_result_record_kind, semantic_result_payload_schema_id,
          semantic_result_payload_ref, semantic_result_payload_artifact_digest,
          stored_semantic_result_digest, finalization_coordinator_lease_id,
          finalization_coordinator_epoch, adjudication_state, terminal_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'chat_creation_result',
               'remote-claw/a1-chat-creation-result/v1', ?, ?, ?, ?, ?,
               'terminal', 30)`,
    )
    .run(
      RESULT_ID,
      SERVER_ID,
      ROUTE_ID,
      COMMAND_ID,
      COMMAND_RESULT_ID,
      ACCEPTED_INGRESS_ATTEMPT_ID,
      triggerIngressObservationId,
      RESULT_DELIVERY_ID,
      SEMANTIC_PAYLOAD_REF,
      SEMANTIC_ARTIFACT_DIGEST,
      STORED_SEMANTIC_DIGEST,
      coordinator.id,
      coordinator.epoch,
    );
}

function insertPendingSealDelivery(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO a1_ingress_result_deliveries
         (result_delivery_id, stable_semantic_result_id, source_kind, source_ref,
          command_result_id, trigger_ingress_observation_id, broker_route_id,
          target_kind, target_ref, delivery_attempt_id,
          semantic_result_record_kind, semantic_result_payload_schema_id,
          semantic_result_payload_ref, semantic_result_payload_artifact_digest,
          stored_semantic_result_digest, state, created_at_ms)
       VALUES (?, ?, 'a1_ingress', ?, ?, ?, ?, 'a1_broker', ?, ?,
               'chat_creation_result', 'remote-claw/a1-chat-creation-result/v1',
               ?, ?, ?, 'pending_seal', 30)`,
    )
    .run(
      RESULT_DELIVERY_ID,
      RESULT_ID,
      RESULT_ID,
      COMMAND_RESULT_ID,
      COMPLETION_OBSERVATION_ID,
      ROUTE_ID,
      ROUTE_ID,
      RESULT_DELIVERY_ATTEMPT_ID,
      SEMANTIC_PAYLOAD_REF,
      SEMANTIC_ARTIFACT_DIGEST,
      STORED_SEMANTIC_DIGEST,
    );
}

function insertCommandResultAcceptance(
  database: DatabaseSync,
  historicalReattestationId: string | null = null,
): void {
  database
    .prepare(
      `INSERT INTO server_signed_record_acceptances
         (collaboration_server_id, accepted_at_journal_seq, signed_record_digest,
          signer_identity_key_id, signer_key_generation,
          signer_scope_certificate_id, signer_sequence, accepted_at_ms,
          historical_reattestation_id)
       VALUES (?, 1, ?, ?, 1, ?, 1, 30, ?)`,
    )
    .run(
      SERVER_ID,
      SIGNED_RECORD_DIGEST,
      IDENTITY_KEY_ID,
      CERTIFICATE_ID,
      historicalReattestationId,
    );
}

function finalizeRejectedResult(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    insertCommonResult(database);
    insertTerminalResult(database);
    insertPendingSealDelivery(database);
    insertCommandResultAcceptance(database);
    database
      .prepare(
        `UPDATE a1_ingress_adjudications
            SET terminal_at_ms = 30, state = 'terminal'
          WHERE stable_semantic_result_id = ?`,
      )
      .run(RESULT_ID);
    database
      .prepare(
        `UPDATE collaboration_commands
            SET current_command_result_id = ?, state = 'decided'
          WHERE command_id = ?`,
      )
      .run(COMMAND_RESULT_ID, COMMAND_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("schema v11 rejected command finalization boundary", () => {
  it("installs exactly three additive finalization tables and their closed trigger surface", () => {
    const database = openVersionEleven();
    try {
      const tableNames = database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name IN (
              'collaboration_command_results',
              'a1_ingress_terminal_results',
              'a1_ingress_result_deliveries'
            ) ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      expect(tableNames).toEqual([
        "a1_ingress_result_deliveries",
        "a1_ingress_terminal_results",
        "collaboration_command_results",
      ]);
      expect(
        VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES.filter((entry) => entry.type === "table"),
      ).toHaveLength(3);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema
              WHERE type = 'trigger' AND name =
                'server_signed_record_acceptances_forbid_command_results_v10'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("commits one exact rejected result, acceptance, logical terminal, and pending seal", () => {
    const database = installVersionElevenAroundSeed();
    try {
      finalizeRejectedResult(database);
      expect(
        database
          .prepare(
            `SELECT command.state AS command_state,
                    adjudication.state AS adjudication_state,
                    signing_group.state AS signing_group_state,
                    preparation.state AS preparation_state,
                    reservation.state AS reservation_state,
                    delivery.state AS delivery_state
               FROM collaboration_commands AS command
               JOIN a1_ingress_adjudications AS adjudication
                 ON adjudication.command_id = command.command_id
               JOIN collaboration_command_results AS result
                 ON result.command_result_id = command.current_command_result_id
               JOIN collaboration_command_result_preparations AS preparation
                 ON preparation.command_result_preparation_id =
                    result.command_result_preparation_id
               JOIN collaboration_command_compound_signing_groups AS signing_group
                 ON signing_group.compound_signing_group_id =
                    result.compound_signing_group_id
               JOIN server_signature_reservations AS reservation
                 ON reservation.collaboration_server_id = result.collaboration_server_id
                AND reservation.signer_sequence = result.signer_sequence
               JOIN a1_ingress_result_deliveries AS delivery
                 ON delivery.command_result_id = result.command_result_id
              WHERE command.command_id = ?`,
          )
          .get(COMMAND_ID),
      ).toEqual({
        command_state: "decided",
        adjudication_state: "terminal",
        signing_group_state: "result_signed",
        preparation_state: "signed",
        reservation_state: "signed",
        delivery_state: "pending_seal",
      });
      for (const tableName of [
        "collaboration_command_results",
        "a1_ingress_terminal_results",
        "a1_ingress_result_deliveries",
      ]) {
        expect(database.prepare(`PRAGMA foreign_key_check(${tableName})`).all()).toEqual([]);
      }
    } finally {
      database.close();
    }
  });

  it("finalizes after collision, route closure, and coordinator takeover without reopening evidence", () => {
    const database = installVersionElevenAroundSeed({
      collidedClosedRoute: true,
      supersededSigner: true,
    });
    try {
      finalizeRejectedResult(database);
      expect(
        database
          .prepare(
            `SELECT ingress.state AS ingress_state,
                    route.state AS route_state,
                    route.active_gap_count,
                    terminal.finalization_coordinator_lease_id,
                    delivery.state AS delivery_state
               FROM authenticated_ingress_results AS ingress
               JOIN broker_route_runtime_status AS route
                 ON route.broker_route_id = ingress.broker_route_id
               JOIN a1_ingress_terminal_results AS terminal
                 ON terminal.stable_semantic_result_id =
                    ingress.stable_semantic_result_id
               JOIN a1_ingress_result_deliveries AS delivery
                 ON delivery.result_delivery_id = terminal.initial_result_delivery_id`,
          )
          .get(),
      ).toEqual({
        ingress_state: "quarantined_collision",
        route_state: "closed",
        active_gap_count: 1,
        finalization_coordinator_lease_id: NEW_COORDINATOR_ID,
        delivery_state: "pending_seal",
      });
    } finally {
      database.close();
    }
  });

  it("requires a successor signing lease to causally postdate predecessor acceptance", () => {
    const database = installVersionElevenAroundSeed({ supersededSigner: true });
    try {
      finalizeRejectedResult(database);
      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signing_leases
               (signing_lease_id, collaboration_server_id, identity_key_id,
                key_generation, scope_certificate_id, coordinator_lease_id,
                coordinator_epoch, fencing_token, acquired_at_ms, draining_at_ms,
                superseded_at_ms, closed_at_ms, state)
             VALUES (?, ?, ?, 1, ?, ?, 2, 2, 28, NULL, NULL, NULL, 'current')`,
          )
          .run(
            LATER_SIGNING_LEASE_ID,
            SERVER_ID,
            IDENTITY_KEY_ID,
            CERTIFICATE_ID,
            NEW_COORDINATOR_ID,
          ),
      ).toThrow(/must postdate predecessor acceptances/);
    } finally {
      database.close();
    }
  });

  it("permits the frozen v8 evidence row to latch a post-adjudication collision before finalization", () => {
    const database = installVersionElevenAroundSeed();
    try {
      database
        .prepare(
          `UPDATE authenticated_ingress_results
              SET state = 'quarantined_collision', collision_at_ms = 26,
                  terminal_at_ms = 26
            WHERE stable_semantic_result_id = ?`,
        )
        .run(RESULT_ID);
      finalizeRejectedResult(database);
      expect(
        database
          .prepare(
            `SELECT ingress.state AS ingress_state,
                    adjudication.state AS adjudication_state
               FROM authenticated_ingress_results AS ingress
               JOIN a1_ingress_adjudications AS adjudication
                 ON adjudication.stable_semantic_result_id =
                    ingress.stable_semantic_result_id`,
          )
          .get(),
      ).toEqual({
        ingress_state: "quarantined_collision",
        adjudication_state: "terminal",
      });
    } finally {
      database.close();
    }
  });

  it("derives completion from the maximum first-part cursor and rejects an earlier observation", () => {
    const database = installVersionElevenAroundSeed();
    try {
      database.exec("BEGIN");
      insertCommonResult(database);
      expect(() => insertTerminalResult(database, EARLIER_OBSERVATION_ID)).toThrow(
        /exact rejected completion evidence/,
      );
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  });

  it("cannot commit a split common result without terminal, delivery, acceptance, and command CAS", () => {
    const database = installVersionElevenAroundSeed();
    try {
      database.exec("BEGIN");
      insertCommonResult(database);
      expect(() => database.exec("COMMIT")).toThrow(/FOREIGN KEY constraint failed/);
      database.exec("ROLLBACK");
      expect(
        database.prepare("SELECT count(*) AS count FROM collaboration_command_results").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("forbids admitted, encrypted, published, historical, and mutable result surfaces", () => {
    const database = installVersionElevenAroundSeed();
    try {
      expect(() => insertCommonResult(database, { disposition: "admitted" })).toThrow(
        /CHECK constraint failed/,
      );
      const deliveryColumns = database
        .prepare("PRAGMA table_info(a1_ingress_result_deliveries)")
        .all()
        .map((row) => row.name);
      expect(deliveryColumns).not.toContain("encrypted_result_payload_ref");
      expect(deliveryColumns).not.toContain("encrypted_result_payload_digest");
      expect(deliveryColumns).not.toContain("published_at_ms");

      database.exec("BEGIN");
      insertCommonResult(database);
      insertTerminalResult(database);
      insertPendingSealDelivery(database);
      expect(() => insertCommandResultAcceptance(database, "historical-record-1")).toThrow();
      database.exec("ROLLBACK");

      finalizeRejectedResult(database);
      expect(() =>
        database
          .prepare(
            "UPDATE a1_ingress_result_deliveries SET state = 'pending_seal' WHERE result_delivery_id = ?",
          )
          .run(RESULT_DELIVERY_ID),
      ).toThrow(/immutable/);
      expect(() =>
        database
          .prepare("DELETE FROM collaboration_command_results WHERE command_result_id = ?")
          .run(COMMAND_RESULT_ID),
      ).toThrow(/retained/);
    } finally {
      database.close();
    }
  });

  it.each([
    ["a later signer lease", { interveningSigner: true, supersededSigner: true }],
    ["a signature after supersession", { supersededAtMs: 24, supersededSigner: true }],
  ] as const)("rejects superseded-signer acceptance with %s", (_label, options) => {
    const database = installVersionElevenAroundSeed(options);
    try {
      database.exec("BEGIN");
      insertCommonResult(database);
      insertTerminalResult(database);
      insertPendingSealDelivery(database);
      expect(() => insertCommandResultAcceptance(database)).toThrow(
        /exact trusted signed reservation/,
      );
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  });
});
