import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  VERSION_EIGHT_DATA_STATEMENTS,
  VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v8.js";
import {
  VERSION_NINE_DATA_STATEMENTS,
  VERSION_NINE_PRE_SCHEMA_STATEMENTS,
  VERSION_NINE_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v9.js";
import {
  VERSION_TEN_DATA_STATEMENTS,
  VERSION_TEN_PRE_SCHEMA_STATEMENTS,
  VERSION_TEN_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v10.js";
import { expectedHostStateMigrationDigest, HOST_STATE_MIGRATIONS } from "./migrations.js";

const MACHINE_IDENTITY_ID = "0".repeat(32);
const SERVER_ID = `rcs_${encoded(16, 1)}`;
const COORDINATOR_LEASE_ID = `rccl_${encoded(16, 2)}`;
const SUCCESSOR_COORDINATOR_LEASE_ID = `rccl_${encoded(16, 25)}`;
const SIGNING_KEY_REF = `rcph_${encoded(16, 3)}`;
const TRUST_REF = `rcph_${encoded(16, 4)}`;
const COMMAND_PAYLOAD_REF = `rcph_${encoded(16, 5)}`;
const NORMALIZATION_REF = `rcph_${encoded(16, 26)}`;
const PROJECT_TARGET_SELECTOR_MAPPING_ID = `ptm_${encoded(32, 27)}`;
const DECISION_EVIDENCE_REF = `rcph_${encoded(16, 6)}`;
const RESULT_PAYLOAD_REF = `rcph_${encoded(16, 7)}`;
const PUBLIC_KEY = encoded(32, 8);
const DIGEST = encoded(32, 9);
const COMMAND_DIGEST = encoded(32, 10);
const SIGNED_RECORD_DIGEST = encoded(32, 11);
const SIGNATURE = encoded(64, 12);
const SERVER_IDENTITY_KEY_ID = "server-key-1";
const SCOPE_CERTIFICATE_ID = "server-cert-1";
const SIGNING_LEASE_ID = "server-signing-lease-1";
const SUCCESSOR_SIGNING_LEASE_ID = "server-signing-lease-2";
const ROUTE_ID = `rcr_${encoded(32, 13)}`;
const RESULT_ID = `rrs_${encoded(32, 14)}`;
const EARLIER_RESULT_ID = `rrs_${encoded(32, 1)}`;
const SOURCE_NAMESPACE_ID = `wns_${encoded(32, 15)}`;
const COMMAND_ID = `rcm_${encoded(32, 16)}`;
const COMMAND_RESULT_ID = `ccr_${encoded(32, 17)}`;
const PREPARATION_ID = `crp_${encoded(32, 18)}`;
const GROUP_ID = `csg_${encoded(32, 19)}`;
const SECOND_PREPARATION_ID = `crp_${encoded(32, 20)}`;
const SECOND_GROUP_ID = `csg_${encoded(32, 21)}`;
const SECOND_COMMAND_RESULT_ID = `ccr_${encoded(32, 22)}`;
const THIRD_PREPARATION_ID = `crp_${encoded(32, 23)}`;
const THIRD_GROUP_ID = `csg_${encoded(32, 24)}`;

function encoded(byteLength: number, fill: number): string {
  return base64urlEncode(new Uint8Array(byteLength).fill(fill));
}

function indexedId(prefix: string, value: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(28, value);
  return `${prefix}${base64urlEncode(bytes)}`;
}

function applyEntries(
  database: DatabaseSync,
  entries: readonly { readonly type: string; readonly sql: string }[],
  type?: string,
): void {
  for (const entry of entries) {
    if (type === undefined || entry.type === type) database.exec(entry.sql);
  }
}

function openEmptyVersionNine(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of HOST_STATE_MIGRATIONS.slice(0, 9)) {
    for (const statement of migration.statements) database.exec(statement);
  }
  return database;
}

function applyVersionTen(database: DatabaseSync): void {
  for (const statement of VERSION_TEN_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  applyEntries(database, VERSION_TEN_SQLITE_SCHEMA_ENTRIES);
  for (const statement of VERSION_TEN_DATA_STATEMENTS) database.exec(statement);
}

/**
 * Builds a semantically current v9 signer while installing v8/v9 triggers only after the retained
 * fixture rows. This keeps the fixture focused on the new v10 gates rather than duplicating the
 * independently tested v8 actor and v9 bootstrap state machines.
 */
function openCurrentSignerFixture(options?: {
  readonly activeGapCount?: number;
  readonly includeEarlierResult?: boolean;
}): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of HOST_STATE_MIGRATIONS.slice(0, 7)) {
    for (const statement of migration.statements) database.exec(statement);
  }
  database
    .prepare(
      `INSERT INTO host_state_metadata
         (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
       VALUES (1, ?, 9, ?, 1)`,
    )
    .run(MACHINE_IDENTITY_ID, expectedHostStateMigrationDigest(9));
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

  applyEntries(database, VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES, "table");
  applyEntries(database, VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES, "index");
  for (const statement of VERSION_EIGHT_DATA_STATEMENTS) database.exec(statement);

  database.exec("PRAGMA foreign_keys = OFF");
  insertIngressResult(database, RESULT_ID, 10);
  if (options?.includeEarlierResult === true) insertIngressResult(database, EARLIER_RESULT_ID, 9);
  database
    .prepare(
      `INSERT INTO broker_route_runtime_status
         (broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
          machine_identity_id, state, current_channel_generation, active_gap_count,
          updated_at_ms)
       VALUES (?, ?, 'server_control', NULL, ?, 'current', 0, ?, 5)`,
    )
    .run(ROUTE_ID, SERVER_ID, MACHINE_IDENTITY_ID, options?.activeGapCount ?? 0);
  database.exec("PRAGMA foreign_keys = ON");
  applyEntries(database, VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES, "trigger");

  for (const statement of VERSION_NINE_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  applyEntries(
    database,
    VERSION_NINE_SQLITE_SCHEMA_ENTRIES.filter((entry) => entry.type !== "trigger"),
  );
  for (const statement of VERSION_NINE_DATA_STATEMENTS) database.exec(statement);
  seedCurrentSigner(database);
  applyEntries(database, VERSION_NINE_SQLITE_SCHEMA_ENTRIES, "trigger");
  applyVersionTen(database);
  return database;
}

function insertIngressResult(database: DatabaseSync, resultId: string, frameIndex: number): void {
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
       VALUES (?, ?, ?, 'server_control', NULL, ?, ?, 'new_chat', 'client-1', 1,
               'remote-claw/a1-ingress-new-chat/v1', ?,
               'remote-claw/a1/source-event-fingerprint/v1', ?,
               ?, 0, ?, 0, ?, 1000, 'awaiting_order', NULL, NULL)`,
    )
    .run(
      resultId,
      ROUTE_ID,
      SERVER_ID,
      SOURCE_NAMESPACE_ID,
      `message-${frameIndex}`,
      DIGEST,
      DIGEST,
      `rda_${encoded(16, frameIndex)}`,
      frameIndex,
      frameIndex,
    );
}

function seedCurrentSigner(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO coordinator_leases
         (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
          owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
          heartbeat_deadline_ms, released_at_ms, state)
       VALUES (?, ?, 1, 'owner-1', 2, 10000, 10000, NULL, 'current')`,
    )
    .run(COORDINATOR_LEASE_ID, SERVER_ID);
  database
    .prepare(
      `UPDATE collaboration_servers
          SET current_coordinator_epoch = 1, current_coordinator_lease_id = ?
        WHERE collaboration_server_id = ?`,
    )
    .run(COORDINATOR_LEASE_ID, SERVER_ID);

  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO protected_artifacts
           (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
            artifact_digest, byte_length, artifact_bytes, created_at_ms)
         VALUES (?, 'artifact', 'collaboration_server', ?,
                 'remote-claw/server-signer-bootstrap-intent/v1', ?, 1, ?, 3)`,
      )
      .run(TRUST_REF, SERVER_ID, DIGEST, Buffer.of(1));
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
        SERVER_IDENTITY_KEY_ID,
        PUBLIC_KEY,
        SIGNING_KEY_REF,
        SCOPE_CERTIFICATE_ID,
        TRUST_REF,
        DIGEST,
      );
    database
      .prepare(
        `INSERT INTO server_identity_private_key_envelopes
           (signing_key_ref, collaboration_server_id, identity_key_id, key_generation,
            custody_backend, wrapping_schema_id, wrap_nonce, wrapped_pkcs8, auth_tag,
            pkcs8_digest, created_at_ms, destroyed_at_ms, state)
         VALUES (?, ?, ?, 1, 'owned-file',
                 'remote-claw/server-identity-key-wrap/aes-256-gcm/v1',
                 ?, ?, ?, ?, 4, NULL, 'current')`,
      )
      .run(
        SIGNING_KEY_REF,
        SERVER_ID,
        SERVER_IDENTITY_KEY_ID,
        Buffer.alloc(12, 1),
        Buffer.alloc(48, 2),
        Buffer.alloc(16, 3),
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
         VALUES (?, 1, 'remote-claw/server-scope-certificate/v1', ?, ?, ?, 'Ed25519',
                 ?, 1, 5, NULL, ?, 0, NULL, 'Ed25519', 'SHA-256', ?, ?)`,
      )
      .run(
        SCOPE_CERTIFICATE_ID,
        SERVER_ID,
        MACHINE_IDENTITY_ID,
        SERVER_IDENTITY_KEY_ID,
        PUBLIC_KEY,
        SERVER_IDENTITY_KEY_ID,
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
      .run(SERVER_ID, SCOPE_CERTIFICATE_ID, TRUST_REF, DIGEST);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  database
    .prepare(
      `UPDATE collaboration_servers
          SET current_key_generation = 1, current_identity_key_id = ?,
              current_scope_certificate_id = ?, next_server_signature_seq = 1,
              state = 'current'
        WHERE collaboration_server_id = ?`,
    )
    .run(SERVER_IDENTITY_KEY_ID, SCOPE_CERTIFICATE_ID, SERVER_ID);
  database
    .prepare(
      `INSERT INTO server_signing_leases
         (signing_lease_id, collaboration_server_id, identity_key_id, key_generation,
          scope_certificate_id, coordinator_lease_id, coordinator_epoch, fencing_token,
          acquired_at_ms, draining_at_ms, superseded_at_ms, closed_at_ms, state)
       VALUES (?, ?, ?, 1, ?, ?, 1, 1, 7, NULL, NULL, NULL, 'current')`,
    )
    .run(
      SIGNING_LEASE_ID,
      SERVER_ID,
      SERVER_IDENTITY_KEY_ID,
      SCOPE_CERTIFICATE_ID,
      COORDINATOR_LEASE_ID,
    );
}

function takeOverCurrentSigner(database: DatabaseSync): void {
  database
    .prepare(
      `UPDATE coordinator_leases
          SET released_at_ms = 30, state = 'released'
        WHERE coordinator_lease_id = ?`,
    )
    .run(COORDINATOR_LEASE_ID);
  database
    .prepare(
      `UPDATE collaboration_servers
          SET current_coordinator_lease_id = NULL
        WHERE collaboration_server_id = ?`,
    )
    .run(SERVER_ID);
  database
    .prepare(
      `INSERT INTO coordinator_leases
         (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
          owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
          heartbeat_deadline_ms, released_at_ms, state)
       VALUES (?, ?, 2, 'owner-2', 31, 10000, 10000, NULL, 'current')`,
    )
    .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);
  database
    .prepare(
      `UPDATE collaboration_servers
          SET current_coordinator_epoch = 2, current_coordinator_lease_id = ?
        WHERE collaboration_server_id = ?`,
    )
    .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);
  database
    .prepare(
      `INSERT INTO server_signing_leases
         (signing_lease_id, collaboration_server_id, identity_key_id, key_generation,
          scope_certificate_id, coordinator_lease_id, coordinator_epoch, fencing_token,
          acquired_at_ms, draining_at_ms, superseded_at_ms, closed_at_ms, state)
       VALUES (?, ?, ?, 1, ?, ?, 2, 2, 31, NULL, NULL, NULL, 'current')`,
    )
    .run(
      SUCCESSOR_SIGNING_LEASE_ID,
      SERVER_ID,
      SERVER_IDENTITY_KEY_ID,
      SCOPE_CERTIFICATE_ID,
      SUCCESSOR_COORDINATOR_LEASE_ID,
    );
}

function insertArtifact(
  database: DatabaseSync,
  ref: string,
  schemaId: string,
  digest: string,
): void {
  database
    .prepare(
      `INSERT INTO protected_artifacts
         (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
          artifact_digest, byte_length, artifact_bytes, created_at_ms)
       VALUES (?, 'artifact', 'collaboration_server', ?, ?, ?, 1, ?, 20)`,
    )
    .run(ref, SERVER_ID, schemaId, digest, Buffer.of(1));
}

function insertAwaitingCommand(
  database: DatabaseSync,
  options?: {
    readonly commandCreatedAtMs?: number;
    readonly payloadSchemaId?: string;
    readonly readyAtMs?: number;
    readonly sourceEventId?: string;
    readonly targetLogicalChatId?: string;
    readonly normalizationEvidence?: boolean;
  },
): void {
  const payloadSchemaId =
    options?.payloadSchemaId ?? "remote-claw/command-payload/unsupported-recognized/v1";
  insertArtifact(database, COMMAND_PAYLOAD_REF, payloadSchemaId, DIGEST);
  if (options?.normalizationEvidence === true) {
    insertArtifact(
      database,
      NORMALIZATION_REF,
      "remote-claw/pre-decision-normalization/test/v1",
      DIGEST,
    );
  }
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO collaboration_commands
           (command_id, collaboration_server_id, scope_kind, logical_chat_id,
            target_logical_chat_id, source_kind, source_ref,
            source_event_namespace_id, source_event_id, source_command_identity_digest,
            canonical_source_event_digest, mutation_family,
            canonical_command_payload_schema_id, canonical_command_payload_ref,
            canonical_command_payload_digest,
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
            coordinator_lease_id, coordinator_epoch, created_at_ms, decided_at_ms, state)
         VALUES (?, ?, 'server_control', NULL, ?, 'a1_ingress', ?, ?, ?, ?,
                 NULL, 'new_chat', ?, ?, ?,
                 ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 ?, 1, ?, NULL, 'awaiting_order')`,
      )
      .run(
        COMMAND_ID,
        SERVER_ID,
        options?.targetLogicalChatId ?? null,
        RESULT_ID,
        SOURCE_NAMESPACE_ID,
        options?.sourceEventId ?? "message-10",
        DIGEST,
        payloadSchemaId,
        COMMAND_PAYLOAD_REF,
        DIGEST,
        options?.normalizationEvidence === true
          ? "remote-claw/pre-decision-normalization/test/v1"
          : null,
        options?.normalizationEvidence === true ? NORMALIZATION_REF : null,
        options?.normalizationEvidence === true ? DIGEST : null,
        COORDINATOR_LEASE_ID,
        options?.commandCreatedAtMs ?? 21,
      );
    database
      .prepare(
        `INSERT INTO command_ready_entries
           (collaboration_server_id, ready_at_journal_seq, command_id,
            stable_semantic_result_id, coordinator_lease_id, coordinator_epoch,
            ready_at_ms)
         VALUES (?, 0, ?, ?, ?, 1, ?)`,
      )
      .run(SERVER_ID, COMMAND_ID, RESULT_ID, COORDINATOR_LEASE_ID, options?.readyAtMs ?? 21);
    database
      .prepare(
        `INSERT INTO a1_ingress_adjudications
           (stable_semantic_result_id, collaboration_server_id, command_id,
            ready_at_journal_seq, command_seq, disposition, command_result_id,
            command_result_preparation_id, viewer_projection_seq, decided_at_ms,
            terminal_at_ms, state)
         VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 'awaiting_order')`,
      )
      .run(RESULT_ID, SERVER_ID, COMMAND_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedUnresolvedCommandLimit(database: DatabaseSync): void {
  const initialTrigger = VERSION_TEN_SQLITE_SCHEMA_ENTRIES.find(
    (entry) => entry.name === "collaboration_commands_require_initial_awaiting_order",
  );
  if (initialTrigger === undefined) throw new Error("missing v10 command insert trigger");
  database.exec("DROP TRIGGER collaboration_commands_require_initial_awaiting_order");
  database.exec("PRAGMA foreign_keys = OFF");
  const insert = database.prepare(
    `INSERT INTO collaboration_commands
       (command_id, collaboration_server_id, scope_kind, logical_chat_id,
        target_logical_chat_id, source_kind, source_ref, source_event_namespace_id,
        source_event_id, source_command_identity_digest, canonical_source_event_digest,
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
        coordinator_lease_id, coordinator_epoch, created_at_ms, decided_at_ms, state)
     VALUES (?, ?, 'server_control', NULL, NULL, 'a1_ingress', ?, ?, ?, ?, NULL,
             'new_chat', 'remote-claw/command-payload/new-chat/v1', ?, ?,
             NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             ?, 1, 21, NULL, 'awaiting_order')`,
  );
  for (let index = 0; index < 256; index += 1) {
    insert.run(
      indexedId("rcm_", index),
      SERVER_ID,
      indexedId("rrs_", index),
      SOURCE_NAMESPACE_ID,
      `backlog-${index}`,
      DIGEST,
      COMMAND_PAYLOAD_REF,
      DIGEST,
      index,
      COORDINATOR_LEASE_ID,
    );
  }
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(initialTrigger.sql);
}

function attemptRejectedDecision(
  database: DatabaseSync,
  commandId: string,
  options?: {
    readonly decidedAtMs?: number;
    readonly decisionCoordinatorEpoch?: number;
    readonly decisionCoordinatorLeaseId?: string;
    readonly projectTargetEvidence?: boolean;
  },
): void {
  database
    .prepare(
      `UPDATE collaboration_commands
          SET command_seq = 0, disposition = 'rejected',
              project_target_selector_mapping_id = ?,
              project_target_selector_mapping_generation = ?,
              project_target_digest = ?,
              decision_evidence_schema_id =
                'remote-claw/collaboration-command-decision-evidence/v1',
              decision_evidence_ref = ?, decision_evidence_digest = ?,
              canonical_command_record_digest = ?,
              decision_coordinator_lease_id = ?, decision_coordinator_epoch = ?,
              decided_at_ms = ?,
              state = 'decision_reserved'
        WHERE command_id = ?`,
    )
    .run(
      options?.projectTargetEvidence === true ? PROJECT_TARGET_SELECTOR_MAPPING_ID : null,
      options?.projectTargetEvidence === true ? 1 : null,
      options?.projectTargetEvidence === true ? DIGEST : null,
      DECISION_EVIDENCE_REF,
      DIGEST,
      COMMAND_DIGEST,
      options?.decisionCoordinatorLeaseId ?? COORDINATOR_LEASE_ID,
      options?.decisionCoordinatorEpoch ?? 1,
      options?.decidedAtMs ?? 22,
      commandId,
    );
}

function seedBoundRejectedDecision(
  database: DatabaseSync,
  options?: {
    readonly commandAlreadyReady?: boolean;
    readonly decidedAtMs?: number;
    readonly decisionCoordinatorEpoch?: number;
    readonly decisionCoordinatorLeaseId?: string;
    readonly signingLeaseId?: string;
  },
): void {
  const decidedAtMs = options?.decidedAtMs ?? 22;
  const boundAtMs = decidedAtMs + 1;
  const signingLeaseId = options?.signingLeaseId ?? SIGNING_LEASE_ID;
  if (options?.commandAlreadyReady !== true) insertAwaitingCommand(database);
  insertArtifact(
    database,
    DECISION_EVIDENCE_REF,
    "remote-claw/collaboration-command-decision-evidence/v1",
    DIGEST,
  );
  insertArtifact(
    database,
    RESULT_PAYLOAD_REF,
    "remote-claw/collaboration-command-result/v1",
    DIGEST,
  );
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO server_signature_reservations
           (collaboration_server_id, signer_sequence, signing_lease_id,
            signing_lease_kind, purpose, canonical_payload_schema_id,
            canonical_payload_ref, canonical_payload_digest, signed_record_digest,
            signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
            bound_at_ms, signed_at_ms, aborted_at_ms, state)
         VALUES (?, 1, ?, 'current', 'collaboration_command_result',
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?,
                 NULL, NULL, NULL, 'reserved')`,
      )
      .run(SERVER_ID, signingLeaseId, decidedAtMs);
    database
      .prepare(
        `INSERT INTO collaboration_command_compound_signing_groups
           (compound_signing_group_id, collaboration_server_id, command_id,
            command_result_id, preparation_generation, signing_lease_id,
            result_preparation_ref, required_finalization_artifact_kind,
            secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
            both_signed_at_ms, finalized_at_ms, aborted_at_ms, state)
         VALUES (?, ?, ?, ?, 1, ?, ?, 'none', NULL, ?, NULL, NULL, NULL,
                 NULL, 'reserved')`,
      )
      .run(
        GROUP_ID,
        SERVER_ID,
        COMMAND_ID,
        COMMAND_RESULT_ID,
        signingLeaseId,
        PREPARATION_ID,
        decidedAtMs,
      );
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
                 ?, NULL, NULL, NULL, 'reserved')`,
      )
      .run(
        PREPARATION_ID,
        COMMAND_RESULT_ID,
        SERVER_ID,
        COMMAND_ID,
        COMMAND_DIGEST,
        RESULT_PAYLOAD_REF,
        DIGEST,
        signingLeaseId,
        GROUP_ID,
        decidedAtMs,
      );
    database
      .prepare(
        `UPDATE server_signature_reservations
            SET canonical_payload_schema_id =
                  'remote-claw/collaboration-command-result/v1',
                canonical_payload_ref = ?, canonical_payload_digest = ?,
                signed_artifact_type =
                  'collaboration_command_result_preparation',
                signed_artifact_id = ?, bound_at_ms = ?, state = 'bound'
          WHERE collaboration_server_id = ? AND signer_sequence = 1`,
      )
      .run(RESULT_PAYLOAD_REF, DIGEST, PREPARATION_ID, boundAtMs, SERVER_ID);
    database
      .prepare(
        `UPDATE collaboration_command_result_preparations
            SET bound_at_ms = ?, state = 'bound'
          WHERE command_result_preparation_id = ?`,
      )
      .run(boundAtMs, PREPARATION_ID);
    attemptRejectedDecision(database, COMMAND_ID, {
      decidedAtMs,
      decisionCoordinatorEpoch: options?.decisionCoordinatorEpoch ?? 1,
      decisionCoordinatorLeaseId: options?.decisionCoordinatorLeaseId ?? COORDINATOR_LEASE_ID,
    });
    database
      .prepare(
        `UPDATE a1_ingress_adjudications
            SET command_seq = 0, disposition = 'rejected', command_result_id = ?,
                command_result_preparation_id = ?, decided_at_ms = ?,
                state = 'deciding'
          WHERE stable_semantic_result_id = ?`,
      )
      .run(COMMAND_RESULT_ID, PREPARATION_ID, decidedAtMs, RESULT_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function abortPreparationGeneration(
  database: DatabaseSync,
  signerSequence: number,
  preparationId: string,
  groupId: string,
  abortedAtMs: number,
): void {
  database
    .prepare(
      `UPDATE server_signature_reservations
          SET aborted_at_ms = ?, state = 'aborted'
        WHERE collaboration_server_id = ? AND signer_sequence = ?`,
    )
    .run(abortedAtMs, SERVER_ID, signerSequence);
  database
    .prepare(
      `UPDATE collaboration_command_result_preparations
          SET aborted_at_ms = ?, state = 'aborted'
        WHERE command_result_preparation_id = ?`,
    )
    .run(abortedAtMs, preparationId);
  database
    .prepare(
      `UPDATE collaboration_command_compound_signing_groups
          SET aborted_at_ms = ?, state = 'aborted'
        WHERE compound_signing_group_id = ?`,
    )
    .run(abortedAtMs, groupId);
}

function reserveReplacementGeneration(
  database: DatabaseSync,
  options: {
    readonly generation: number;
    readonly groupId: string;
    readonly preparationId: string;
    readonly reservedAtMs: number;
    readonly signerSequence: number;
    readonly supersedesPreparationId: string;
  },
): void {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO server_signature_reservations
           (collaboration_server_id, signer_sequence, signing_lease_id,
            signing_lease_kind, purpose, canonical_payload_schema_id,
            canonical_payload_ref, canonical_payload_digest, signed_record_digest,
            signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
            bound_at_ms, signed_at_ms, aborted_at_ms, state)
         VALUES (?, ?, ?, 'current', 'collaboration_command_result',
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?,
                 NULL, NULL, NULL, 'reserved')`,
      )
      .run(SERVER_ID, options.signerSequence, SIGNING_LEASE_ID, options.reservedAtMs);
    database
      .prepare(
        `INSERT INTO collaboration_command_compound_signing_groups
           (compound_signing_group_id, collaboration_server_id, command_id,
            command_result_id, preparation_generation, signing_lease_id,
            result_preparation_ref, required_finalization_artifact_kind,
            secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
            both_signed_at_ms, finalized_at_ms, aborted_at_ms, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NULL, ?, NULL, NULL, NULL,
                 NULL, 'reserved')`,
      )
      .run(
        options.groupId,
        SERVER_ID,
        COMMAND_ID,
        COMMAND_RESULT_ID,
        options.generation,
        SIGNING_LEASE_ID,
        options.preparationId,
        options.reservedAtMs,
      );
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
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'none', NULL,
                 ?, NULL, NULL, NULL, 'reserved')`,
      )
      .run(
        options.preparationId,
        COMMAND_RESULT_ID,
        SERVER_ID,
        COMMAND_ID,
        COMMAND_DIGEST,
        options.generation,
        options.supersedesPreparationId,
        RESULT_PAYLOAD_REF,
        DIGEST,
        options.signerSequence,
        SIGNING_LEASE_ID,
        options.groupId,
        options.reservedAtMs,
      );
    database
      .prepare(
        `UPDATE a1_ingress_adjudications
            SET command_result_preparation_id = ?
          WHERE stable_semantic_result_id = ?`,
      )
      .run(options.preparationId, RESULT_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("schema v10 dormant command adjudication ledger", () => {
  it("adds exactly five inert tables with named indexes and no effect surface", () => {
    const database = openEmptyVersionNine();
    try {
      applyVersionTen(database);
      const tableNames = VERSION_TEN_SQLITE_SCHEMA_ENTRIES.filter(
        (entry) => entry.type === "table",
      ).map((entry) => entry.name);
      expect(tableNames).toEqual([
        "command_ready_entries",
        "a1_ingress_adjudications",
        "collaboration_commands",
        "collaboration_command_compound_signing_groups",
        "collaboration_command_result_preparations",
      ]);
      expect(
        VERSION_TEN_SQLITE_SCHEMA_ENTRIES.find(
          (entry) => entry.type === "table" && entry.name === "collaboration_commands",
        )?.sql,
      ).toContain("target_logical_chat_id IS NOT NULL");
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema
              WHERE type = 'table'
                AND name GLOB '*result*delivery*'
                   OR type = 'table' AND name GLOB '*outbox*'
                   OR type = 'table' AND name GLOB '*effect*'
                   OR type = 'table' AND name GLOB '*dispatch*'`,
          )
          .all(),
      ).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema
              WHERE type = 'index' AND name LIKE 'sqlite_autoindex_%'
                AND (name LIKE 'sqlite_autoindex_command_%'
                  OR name LIKE 'sqlite_autoindex_a1_%'
                  OR name LIKE 'sqlite_autoindex_collaboration_command_%')`,
          )
          .all(),
      ).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps later route heads and routes with an open gap outside the shared journal", () => {
    for (const fixtureOptions of [{ includeEarlierResult: true }, { activeGapCount: 1 }]) {
      const database = openCurrentSignerFixture(fixtureOptions);
      try {
        expect(() => insertAwaitingCommand(database)).toThrow(/exact complete A1 ingress source/);
        expect(
          database
            .prepare(
              `SELECT next_journal_offset AS nextJournalOffset
                 FROM collaboration_servers
                WHERE collaboration_server_id = ?`,
            )
            .get(SERVER_ID),
        ).toEqual({ nextJournalOffset: 0 });
      } finally {
        database.close();
      }
    }
  });

  it("materializes one ready A1 command and freezes its accepted ingress tuple", () => {
    const database = openCurrentSignerFixture();
    try {
      insertAwaitingCommand(database);
      expect(
        database
          .prepare(
            `SELECT next_journal_offset AS nextJournalOffset
               FROM collaboration_servers
              WHERE collaboration_server_id = ?`,
          )
          .get(SERVER_ID),
      ).toEqual({ nextJournalOffset: 1 });
      expect(() =>
        database
          .prepare(
            `UPDATE authenticated_ingress_results
                SET state = 'quarantined_collision', collision_at_ms = 30,
                    terminal_at_ms = 30
              WHERE stable_semantic_result_id = ?`,
          )
          .run(RESULT_ID),
      ).toThrow(/source tuple is frozen/);
      expect(() =>
        database
          .prepare(
            `UPDATE command_ready_entries SET ready_at_ms = 31
              WHERE collaboration_server_id = ? AND ready_at_journal_seq = 0`,
          )
          .run(SERVER_ID),
      ).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });

  it("rejects split-time command and ready materialization provenance", () => {
    const database = openCurrentSignerFixture();
    try {
      expect(() => insertAwaitingCommand(database, { readyAtMs: 22 })).toThrow(
        /exact complete A1 command/,
      );
      expect(
        database.prepare("SELECT count(*) AS count FROM collaboration_commands").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects a server-control ready head with a premature chat target", () => {
    const database = openCurrentSignerFixture();
    try {
      expect(() =>
        insertAwaitingCommand(database, {
          targetLogicalChatId: `rcl_${encoded(16, 23)}`,
        }),
      ).toThrow(/CHECK constraint failed|must begin awaiting order/);
      expect(
        database.prepare("SELECT count(*) AS count FROM collaboration_commands").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects a command materialized before its route's durable recovery time", () => {
    const database = openCurrentSignerFixture();
    try {
      const routeTriggers = database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'trigger' AND tbl_name = 'broker_route_runtime_status'`,
        )
        .all() as Array<{ name: string }>;
      for (const trigger of routeTriggers) database.exec(`DROP TRIGGER ${trigger.name}`);
      database
        .prepare(
          `UPDATE broker_route_runtime_status SET updated_at_ms = 22
            WHERE broker_route_id = ?`,
        )
        .run(ROUTE_ID);
      applyEntries(
        database,
        VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES.filter(
          (entry) =>
            entry.type === "trigger" && routeTriggers.some(({ name }) => name === entry.name),
        ),
      );
      expect(() => insertAwaitingCommand(database)).toThrow(/exact complete A1 ingress source/);
    } finally {
      database.close();
    }
  });

  it("preserves creation provenance while a successor coordinator decides", () => {
    const database = openCurrentSignerFixture();
    try {
      insertAwaitingCommand(database);
      takeOverCurrentSigner(database);
      seedBoundRejectedDecision(database, {
        commandAlreadyReady: true,
        decidedAtMs: 32,
        decisionCoordinatorEpoch: 2,
        decisionCoordinatorLeaseId: SUCCESSOR_COORDINATOR_LEASE_ID,
        signingLeaseId: SUCCESSOR_SIGNING_LEASE_ID,
      });
      expect(
        database
          .prepare(
            `SELECT coordinator_lease_id AS createdLeaseId,
                    coordinator_epoch AS createdEpoch,
                    decision_coordinator_lease_id AS decisionLeaseId,
                    decision_coordinator_epoch AS decisionEpoch,
                    created_at_ms AS createdAtMs, decided_at_ms AS decidedAtMs,
                    state
               FROM collaboration_commands WHERE command_id = ?`,
          )
          .get(COMMAND_ID),
      ).toEqual({
        createdLeaseId: COORDINATOR_LEASE_ID,
        createdEpoch: 1,
        decisionLeaseId: SUCCESSOR_COORDINATOR_LEASE_ID,
        decisionEpoch: 2,
        createdAtMs: 21,
        decidedAtMs: 32,
        state: "decision_reserved",
      });
    } finally {
      database.close();
    }
  });

  it("accepts only A1-safe retained event IDs", () => {
    for (const sourceEventId of ["message/10", "m".repeat(129)]) {
      const database = openCurrentSignerFixture();
      try {
        expect(() => insertAwaitingCommand(database, { sourceEventId })).toThrow(
          /CHECK constraint failed|exact complete A1 ingress source/,
        );
      } finally {
        database.close();
      }
    }
  });

  it("persists only the bounded unsupported-recognized payload vocabulary", () => {
    for (const payloadSchemaId of [
      "remote-claw/command-payload/user-text/v1",
      "remote-claw/command-payload/new-chat/v1",
    ]) {
      const database = openCurrentSignerFixture();
      try {
        expect(() => insertAwaitingCommand(database, { payloadSchemaId })).toThrow(
          /exact complete A1 ingress source|must begin awaiting order/,
        );
      } finally {
        database.close();
      }
    }
  });

  it("forbids pre-decision normalization evidence in the v10 persistence slice", () => {
    const database = openCurrentSignerFixture();
    try {
      expect(() => insertAwaitingCommand(database, { normalizationEvidence: true })).toThrow(
        /must begin awaiting order/,
      );
    } finally {
      database.close();
    }
  });

  it("forbids future project-target evidence on a rejected decision", () => {
    const database = openCurrentSignerFixture();
    try {
      insertAwaitingCommand(database);
      insertArtifact(
        database,
        DECISION_EVIDENCE_REF,
        "remote-claw/collaboration-command-decision-evidence/v1",
        DIGEST,
      );
      expect(() =>
        attemptRejectedDecision(database, COMMAND_ID, { projectTargetEvidence: true }),
      ).toThrow(/one frozen rejected decision|CHECK constraint/);
      expect(
        database
          .prepare(
            `SELECT state, command_seq AS commandSeq
               FROM collaboration_commands WHERE command_id = ?`,
          )
          .get(COMMAND_ID),
      ).toEqual({ state: "awaiting_order", commandSeq: null });
    } finally {
      database.close();
    }
  });

  it("refuses a 257th unresolved command before consuming the ready journal", () => {
    const database = openCurrentSignerFixture();
    try {
      seedUnresolvedCommandLimit(database);
      expect(() => insertAwaitingCommand(database)).toThrow(/unresolved command limit exceeded/);
      expect(
        database
          .prepare(
            `SELECT next_journal_offset AS nextJournalOffset
               FROM collaboration_servers
              WHERE collaboration_server_id = ?`,
          )
          .get(SERVER_ID),
      ).toEqual({ nextJournalOffset: 0 });
    } finally {
      database.close();
    }
  });

  it("refuses to decide a later ready command before the global minimum", () => {
    const database = openCurrentSignerFixture();
    try {
      seedUnresolvedCommandLimit(database);
      expect(() => attemptRejectedDecision(database, indexedId("rcm_", 1))).toThrow(
        /not the next ready command/,
      );
      expect(
        database
          .prepare(
            `SELECT next_command_seq AS nextCommandSeq
               FROM collaboration_servers
              WHERE collaboration_server_id = ?`,
          )
          .get(SERVER_ID),
      ).toEqual({ nextCommandSeq: 0 });
    } finally {
      database.close();
    }
  });

  it("blocks a ready command when its source route opens a later gap", () => {
    const database = openCurrentSignerFixture();
    try {
      insertAwaitingCommand(database);
      const runtimeTriggers = database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'trigger' AND tbl_name = 'broker_route_runtime_status'`,
        )
        .all() as unknown as readonly { readonly name: string }[];
      for (const row of runtimeTriggers) database.exec(`DROP TRIGGER "${row.name}"`);
      database
        .prepare(
          `UPDATE broker_route_runtime_status
              SET active_gap_count = 1, updated_at_ms = 22
            WHERE broker_route_id = ?`,
        )
        .run(ROUTE_ID);
      insertArtifact(
        database,
        DECISION_EVIDENCE_REF,
        "remote-claw/collaboration-command-decision-evidence/v1",
        DIGEST,
      );
      expect(() => attemptRejectedDecision(database, COMMAND_ID)).toThrow(/recovered source route/);
    } finally {
      database.close();
    }
  });

  it("rejects reservations and groups timestamped before the current signing lease", () => {
    const database = openCurrentSignerFixture();
    try {
      insertAwaitingCommand(database);
      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, canonical_payload_schema_id,
                canonical_payload_ref, canonical_payload_digest, signed_record_digest,
                signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
                bound_at_ms, signed_at_ms, aborted_at_ms, state)
             VALUES (?, 1, ?, 'current', 'collaboration_command_result',
                     NULL, NULL, NULL, NULL, NULL, NULL, NULL, 6,
                     NULL, NULL, NULL, 'reserved')`,
          )
          .run(SERVER_ID, SIGNING_LEASE_ID),
      ).toThrow(/current signing authority/);
      expect(() =>
        database
          .prepare(
            `INSERT INTO collaboration_command_compound_signing_groups
               (compound_signing_group_id, collaboration_server_id, command_id,
                command_result_id, preparation_generation, signing_lease_id,
                result_preparation_ref, required_finalization_artifact_kind,
                secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
                both_signed_at_ms, finalized_at_ms, aborted_at_ms, state)
             VALUES (?, ?, ?, ?, 1, ?, ?, 'none', NULL, 6, NULL, NULL, NULL,
                     NULL, 'reserved')`,
          )
          .run(
            GROUP_ID,
            SERVER_ID,
            COMMAND_ID,
            COMMAND_RESULT_ID,
            SIGNING_LEASE_ID,
            PREPARATION_ID,
          ),
      ).toThrow(/exact current command signer/);
    } finally {
      database.close();
    }
  });

  it("rejects command-result aborts outside every retained coordinator interval", () => {
    const database = openCurrentSignerFixture();
    try {
      seedBoundRejectedDecision(database);
      expect(() =>
        database
          .prepare(
            `UPDATE server_signature_reservations
                SET aborted_at_ms = 10001, state = 'aborted'
              WHERE collaboration_server_id = ? AND signer_sequence = 1`,
          )
          .run(SERVER_ID),
      ).toThrow(/command-result abort requires exact coordinator authority/);
      expect(
        database
          .prepare(
            `SELECT state, aborted_at_ms AS abortedAtMs
               FROM server_signature_reservations
              WHERE collaboration_server_id = ? AND signer_sequence = 1`,
          )
          .get(SERVER_ID),
      ).toEqual({ state: "bound", abortedAtMs: null });
    } finally {
      database.close();
    }
  });

  it("advances the deciding sidecar through exact aborted replacement generations", () => {
    const database = openCurrentSignerFixture();
    try {
      seedBoundRejectedDecision(database);
      abortPreparationGeneration(database, 1, PREPARATION_ID, GROUP_ID, 24);
      reserveReplacementGeneration(database, {
        generation: 2,
        groupId: SECOND_GROUP_ID,
        preparationId: SECOND_PREPARATION_ID,
        reservedAtMs: 25,
        signerSequence: 2,
        supersedesPreparationId: PREPARATION_ID,
      });
      expect(
        database
          .prepare(
            `SELECT command_seq AS commandSeq, disposition, command_result_id AS resultId,
                    command_result_preparation_id AS preparationId,
                    decided_at_ms AS decidedAtMs, state
               FROM a1_ingress_adjudications
              WHERE stable_semantic_result_id = ?`,
          )
          .get(RESULT_ID),
      ).toEqual({
        commandSeq: 0,
        disposition: "rejected",
        resultId: COMMAND_RESULT_ID,
        preparationId: SECOND_PREPARATION_ID,
        decidedAtMs: 22,
        state: "deciding",
      });

      abortPreparationGeneration(database, 2, SECOND_PREPARATION_ID, SECOND_GROUP_ID, 26);
      reserveReplacementGeneration(database, {
        generation: 3,
        groupId: THIRD_GROUP_ID,
        preparationId: THIRD_PREPARATION_ID,
        reservedAtMs: 27,
        signerSequence: 3,
        supersedesPreparationId: SECOND_PREPARATION_ID,
      });

      expect(
        database
          .prepare(
            `SELECT command_result_preparation_id AS preparationId,
                    command_seq AS commandSeq, command_result_id AS resultId,
                    disposition, decided_at_ms AS decidedAtMs, state
               FROM a1_ingress_adjudications
              WHERE stable_semantic_result_id = ?`,
          )
          .get(RESULT_ID),
      ).toEqual({
        preparationId: THIRD_PREPARATION_ID,
        commandSeq: 0,
        resultId: COMMAND_RESULT_ID,
        disposition: "rejected",
        decidedAtMs: 22,
        state: "deciding",
      });
      expect(
        database
          .prepare(
            `SELECT next_command_seq AS nextCommandSeq,
                    next_server_signature_seq AS nextSignerSequence
               FROM collaboration_servers
              WHERE collaboration_server_id = ?`,
          )
          .get(SERVER_ID),
      ).toEqual({ nextCommandSeq: 1, nextSignerSequence: 4 });
      expect(
        database
          .prepare(
            `SELECT preparation_generation AS generation, state
               FROM collaboration_command_compound_signing_groups
              WHERE collaboration_server_id = ?
              ORDER BY preparation_generation`,
          )
          .all(SERVER_ID),
      ).toEqual([
        { generation: 1, state: "aborted" },
        { generation: 2, state: "aborted" },
        { generation: 3, state: "reserved" },
      ]);
    } finally {
      database.close();
    }
  });

  it("allows only current result reservations and cannot finalize the dormant group", () => {
    const database = openCurrentSignerFixture();
    try {
      insertAwaitingCommand(database);
      insertArtifact(
        database,
        DECISION_EVIDENCE_REF,
        "remote-claw/collaboration-command-decision-evidence/v1",
        DIGEST,
      );
      insertArtifact(
        database,
        RESULT_PAYLOAD_REF,
        "remote-claw/collaboration-command-result/v1",
        DIGEST,
      );
      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, canonical_payload_schema_id,
                canonical_payload_ref, canonical_payload_digest, signed_record_digest,
                signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
                bound_at_ms, signed_at_ms, aborted_at_ms, state)
             VALUES (?, 1, ?, 'current', 'collaboration_command_result',
                     NULL, NULL, NULL, NULL, NULL, NULL, NULL, 22,
                     NULL, NULL, NULL, 'reserved')`,
          )
          .run(SERVER_ID, SIGNING_LEASE_ID);
        database
          .prepare(
            `INSERT INTO collaboration_command_compound_signing_groups
               (compound_signing_group_id, collaboration_server_id, command_id,
                command_result_id, preparation_generation, signing_lease_id,
                result_preparation_ref, required_finalization_artifact_kind,
                secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
                both_signed_at_ms, finalized_at_ms, aborted_at_ms, state)
             VALUES (?, ?, ?, ?, 1, ?, ?, 'none', NULL, 22, NULL, NULL, NULL,
                     NULL, 'reserved')`,
          )
          .run(
            GROUP_ID,
            SERVER_ID,
            COMMAND_ID,
            COMMAND_RESULT_ID,
            SIGNING_LEASE_ID,
            PREPARATION_ID,
          );
        expect(() =>
          database
            .prepare(
              `INSERT INTO collaboration_command_compound_signing_groups
                 (compound_signing_group_id, collaboration_server_id, command_id,
                  command_result_id, preparation_generation, signing_lease_id,
                  result_preparation_ref, required_finalization_artifact_kind,
                  secondary_preparation_ref, reserved_at_ms, result_signed_at_ms,
                  both_signed_at_ms, finalized_at_ms, aborted_at_ms, state)
               VALUES (?, ?, ?, ?, 1, ?, ?, 'none', NULL, 22, NULL, NULL, NULL,
                       NULL, 'reserved')`,
            )
            .run(
              SECOND_GROUP_ID,
              SERVER_ID,
              COMMAND_ID,
              SECOND_COMMAND_RESULT_ID,
              SIGNING_LEASE_ID,
              SECOND_PREPARATION_ID,
            ),
        ).toThrow(/UNIQUE constraint/);
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
                     22, NULL, NULL, NULL, 'reserved')`,
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
        database
          .prepare(
            `UPDATE server_signature_reservations
                SET canonical_payload_schema_id =
                      'remote-claw/collaboration-command-result/v1',
                    canonical_payload_ref = ?, canonical_payload_digest = ?,
                    signed_artifact_type =
                      'collaboration_command_result_preparation',
                    signed_artifact_id = ?, bound_at_ms = 23, state = 'bound'
              WHERE collaboration_server_id = ? AND signer_sequence = 1`,
          )
          .run(RESULT_PAYLOAD_REF, DIGEST, PREPARATION_ID, SERVER_ID);
        database
          .prepare(
            `UPDATE collaboration_command_result_preparations
                SET bound_at_ms = 23, state = 'bound'
              WHERE command_result_preparation_id = ?`,
          )
          .run(PREPARATION_ID);
        database
          .prepare(
            `UPDATE collaboration_commands
                SET command_seq = 0, disposition = 'rejected',
                    decision_evidence_schema_id =
                      'remote-claw/collaboration-command-decision-evidence/v1',
                    decision_evidence_ref = ?, decision_evidence_digest = ?,
                    canonical_command_record_digest = ?,
                    decision_coordinator_lease_id = ?,
                    decision_coordinator_epoch = 1, decided_at_ms = 22,
                    state = 'decision_reserved'
              WHERE command_id = ?`,
          )
          .run(DECISION_EVIDENCE_REF, DIGEST, COMMAND_DIGEST, COORDINATOR_LEASE_ID, COMMAND_ID);
        database
          .prepare(
            `UPDATE a1_ingress_adjudications
                SET command_seq = 0, disposition = 'rejected', command_result_id = ?,
                    command_result_preparation_id = ?, decided_at_ms = 22,
                    state = 'deciding'
              WHERE stable_semantic_result_id = ?`,
          )
          .run(COMMAND_RESULT_ID, PREPARATION_ID, RESULT_ID);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      database
        .prepare(
          `UPDATE server_signature_reservations
              SET signed_record_digest = ?, signature = ?, signed_at_ms = 25,
                  state = 'signed'
            WHERE collaboration_server_id = ? AND signer_sequence = 1`,
        )
        .run(SIGNED_RECORD_DIGEST, SIGNATURE, SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_command_result_preparations
              SET signed_at_ms = 25, state = 'signed'
            WHERE command_result_preparation_id = ?`,
        )
        .run(PREPARATION_ID);
      database
        .prepare(
          `UPDATE collaboration_command_compound_signing_groups
              SET result_signed_at_ms = 25, state = 'result_signed'
            WHERE compound_signing_group_id = ?`,
        )
        .run(GROUP_ID);

      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signed_record_acceptances
               (collaboration_server_id, accepted_at_journal_seq, signed_record_digest,
                signer_identity_key_id, signer_key_generation,
                signer_scope_certificate_id, signer_sequence, accepted_at_ms,
                historical_reattestation_id)
             VALUES (?, 1, ?, ?, 1, ?, 1, 25, NULL)`,
          )
          .run(SERVER_ID, SIGNED_RECORD_DIGEST, SERVER_IDENTITY_KEY_ID, SCOPE_CERTIFICATE_ID),
      ).toThrow(/command-result preparations cannot be accepted/);

      expect(() =>
        database
          .prepare(
            `UPDATE collaboration_command_compound_signing_groups
                SET finalized_at_ms = 26, state = 'finalized'
              WHERE compound_signing_group_id = ?`,
          )
          .run(GROUP_ID),
      ).toThrow(/cannot finalize|CHECK constraint/);
      expect(() =>
        database
          .prepare(
            `UPDATE a1_ingress_adjudications
                SET terminal_at_ms = 26, state = 'terminal'
              WHERE stable_semantic_result_id = ?`,
          )
          .run(RESULT_ID),
      ).toThrow(/may only enter rejected deciding/);
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("collaboration_command_results"),
      ).toBeUndefined();

      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, canonical_payload_schema_id,
                canonical_payload_ref, canonical_payload_digest, signed_record_digest,
                signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
                bound_at_ms, signed_at_ms, aborted_at_ms, state)
             VALUES (?, 2, ?, 'current', 'host_output', NULL, NULL, NULL, NULL,
                     NULL, NULL, NULL, 26, NULL, NULL, NULL, 'reserved')`,
          )
          .run(SERVER_ID, SIGNING_LEASE_ID),
      ).toThrow(/current signing authority/);
    } finally {
      database.close();
    }
  });
});
