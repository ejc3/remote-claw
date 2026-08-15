import { VERSION_NINE_SQLITE_SCHEMA_ENTRIES } from "./migration-v9.js";
import { VERSION_TEN_SQLITE_SCHEMA_ENTRIES } from "./migration-v10.js";
import type { HostStateSqliteSchemaEntry } from "./migrations.js";

function schemaEntry(
  type: HostStateSqliteSchemaEntry["type"],
  name: string,
  tableName: string,
  sql: string,
): HostStateSqliteSchemaEntry {
  return Object.freeze({ type, name, tableName, sql });
}

function table(name: string, sql: string): HostStateSqliteSchemaEntry {
  return schemaEntry("table", name, name, sql);
}

function trigger(name: string, tableName: string, sql: string): HostStateSqliteSchemaEntry {
  return schemaEntry("trigger", name, tableName, sql);
}

function priorSchemaSql(entries: readonly HostStateSqliteSchemaEntry[], name: string): string {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`v11 prerequisite schema entry ${name} is absent`);
  return entry.sql;
}

function replaceSchemaSqlOnce(sql: string, before: string, after: string): string {
  const first = sql.indexOf(before);
  if (first < 0 || sql.indexOf(before, first + before.length) >= 0) {
    throw new Error("v11 prerequisite schema text is absent or ambiguous");
  }
  return `${sql.slice(0, first)}${after}${sql.slice(first + before.length)}`;
}

const CREATE_COLLABORATION_COMMAND_RESULTS_SQL = `CREATE TABLE collaboration_command_results (
  command_result_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(command_result_id) = 47
    AND substr(command_result_id, 1, 4) = 'ccr_'
    AND command_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  command_id TEXT NOT NULL CHECK (
    length(command_id) = 47
    AND substr(command_id, 1, 4) = 'rcm_'
    AND command_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  canonical_command_record_digest TEXT NOT NULL CHECK (
    length(canonical_command_record_digest) = 43
    AND canonical_command_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  result_version INTEGER NOT NULL CHECK (result_version = 1),
  supersedes_command_result_id TEXT CHECK (supersedes_command_result_id IS NULL),
  source_kind TEXT NOT NULL CHECK (source_kind = 'a1_ingress'),
  source_ref TEXT NOT NULL CHECK (
    length(source_ref) = 47
    AND substr(source_ref, 1, 4) = 'rrs_'
    AND source_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('server_control', 'chat')),
  logical_chat_id TEXT CHECK (
    logical_chat_id IS NULL OR (
      length(logical_chat_id) = 26
      AND substr(logical_chat_id, 1, 4) = 'rcl_'
      AND logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  target_logical_chat_id TEXT CHECK (
    target_logical_chat_id IS NULL OR (
      length(target_logical_chat_id) = 26
      AND substr(target_logical_chat_id, 1, 4) = 'rcl_'
      AND target_logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  command_seq INTEGER NOT NULL CHECK (
    command_seq BETWEEN 0 AND 9007199254740991
  ),
  disposition TEXT NOT NULL CHECK (disposition = 'rejected'),
  canonical_payload_schema_id TEXT NOT NULL CHECK (
    canonical_payload_schema_id = 'remote-claw/collaboration-command-result/v1'
  ),
  canonical_payload_ref TEXT NOT NULL CHECK (
    length(canonical_payload_ref) = 27
    AND substr(canonical_payload_ref, 1, 5) = 'rcph_'
    AND canonical_payload_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  canonical_payload_digest TEXT NOT NULL CHECK (
    length(canonical_payload_digest) = 43
    AND canonical_payload_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  command_result_preparation_id TEXT NOT NULL CHECK (
    length(command_result_preparation_id) = 47
    AND substr(command_result_preparation_id, 1, 4) = 'crp_'
    AND command_result_preparation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  compound_signing_group_id TEXT NOT NULL CHECK (
    length(compound_signing_group_id) = 47
    AND substr(compound_signing_group_id, 1, 4) = 'csg_'
    AND compound_signing_group_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signer_sequence INTEGER NOT NULL CHECK (
    signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  server_key_generation INTEGER NOT NULL CHECK (
    server_key_generation BETWEEN 1 AND 9007199254740991
  ),
  signer_identity_key_id TEXT NOT NULL CHECK (
    length(signer_identity_key_id) BETWEEN 1 AND 128
    AND signer_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  signer_scope_certificate_id TEXT NOT NULL CHECK (
    length(signer_scope_certificate_id) BETWEEN 1 AND 128
    AND signer_scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'Ed25519'),
  signature TEXT NOT NULL CHECK (
    length(signature) = 86
    AND signature NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signed_record_digest TEXT NOT NULL CHECK (
    length(signed_record_digest) = 43
    AND signed_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  accepted_at_journal_seq INTEGER NOT NULL CHECK (
    accepted_at_journal_seq BETWEEN 0 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  finalized_at_ms INTEGER NOT NULL CHECK (
    finalized_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  CHECK (
    (scope_kind = 'server_control'
      AND logical_chat_id IS NULL
      AND target_logical_chat_id IS NULL)
    OR (scope_kind = 'chat'
      AND logical_chat_id IS NOT NULL
      AND target_logical_chat_id = logical_chat_id)
  ),
  FOREIGN KEY (source_ref)
    REFERENCES a1_ingress_terminal_results (stable_semantic_result_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (collaboration_server_id, command_id, command_result_id)
    REFERENCES collaboration_commands (
      collaboration_server_id,
      command_id,
      current_command_result_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (canonical_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (command_result_preparation_id)
    REFERENCES collaboration_command_result_preparations (
      command_result_preparation_id
    ),
  FOREIGN KEY (compound_signing_group_id)
    REFERENCES collaboration_command_compound_signing_groups (
      compound_signing_group_id
    ),
  FOREIGN KEY (
    collaboration_server_id,
    signer_sequence,
    signed_record_digest
  ) REFERENCES server_signature_reservations (
    collaboration_server_id,
    signer_sequence,
    signed_record_digest
  ),
  FOREIGN KEY (collaboration_server_id, accepted_at_journal_seq)
    REFERENCES server_signed_record_acceptances (
      collaboration_server_id,
      accepted_at_journal_seq
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_A1_INGRESS_TERMINAL_RESULTS_SQL = `CREATE TABLE a1_ingress_terminal_results (
  stable_semantic_result_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(stable_semantic_result_id) = 47
    AND substr(stable_semantic_result_id, 1, 4) = 'rrs_'
    AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  broker_route_id TEXT NOT NULL CHECK (
    length(broker_route_id) = 47
    AND substr(broker_route_id, 1, 4) = 'rcr_'
    AND broker_route_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  command_id TEXT NOT NULL CHECK (
    length(command_id) = 47
    AND substr(command_id, 1, 4) = 'rcm_'
    AND command_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  command_result_id TEXT NOT NULL CHECK (
    length(command_result_id) = 47
    AND substr(command_result_id, 1, 4) = 'ccr_'
    AND command_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  accepted_ingress_delivery_attempt_id TEXT NOT NULL CHECK (
    length(accepted_ingress_delivery_attempt_id) = 26
    AND substr(accepted_ingress_delivery_attempt_id, 1, 4) = 'rda_'
    AND accepted_ingress_delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  trigger_ingress_observation_id TEXT NOT NULL CHECK (
    length(trigger_ingress_observation_id) = 47
    AND substr(trigger_ingress_observation_id, 1, 4) = 'rio_'
    AND trigger_ingress_observation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  initial_result_delivery_id TEXT NOT NULL CHECK (
    length(initial_result_delivery_id) = 47
    AND substr(initial_result_delivery_id, 1, 4) = 'rrd_'
    AND initial_result_delivery_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  semantic_result_record_kind TEXT NOT NULL CHECK (
    semantic_result_record_kind IN ('action_result', 'chat_creation_result')
  ),
  semantic_result_payload_schema_id TEXT NOT NULL CHECK (
    semantic_result_payload_schema_id IN (
      'remote-claw/a1-action-result/v1',
      'remote-claw/a1-chat-creation-result/v1'
    )
  ),
  semantic_result_payload_ref TEXT NOT NULL CHECK (
    length(semantic_result_payload_ref) = 27
    AND substr(semantic_result_payload_ref, 1, 5) = 'rcph_'
    AND semantic_result_payload_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  semantic_result_payload_artifact_digest TEXT NOT NULL CHECK (
    length(semantic_result_payload_artifact_digest) = 43
    AND semantic_result_payload_artifact_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  stored_semantic_result_digest TEXT NOT NULL CHECK (
    length(stored_semantic_result_digest) = 43
    AND stored_semantic_result_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  finalization_coordinator_lease_id TEXT NOT NULL CHECK (
    length(finalization_coordinator_lease_id) = 27
    AND substr(finalization_coordinator_lease_id, 1, 5) = 'rccl_'
    AND finalization_coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  finalization_coordinator_epoch INTEGER NOT NULL CHECK (
    finalization_coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  adjudication_state TEXT NOT NULL CHECK (adjudication_state = 'terminal'),
  terminal_at_ms INTEGER NOT NULL CHECK (
    terminal_at_ms BETWEEN 0 AND 9007199254740991
  ),
  CHECK (
    (semantic_result_record_kind = 'action_result'
      AND semantic_result_payload_schema_id = 'remote-claw/a1-action-result/v1')
    OR (semantic_result_record_kind = 'chat_creation_result'
      AND semantic_result_payload_schema_id =
        'remote-claw/a1-chat-creation-result/v1')
  ),
  FOREIGN KEY (stable_semantic_result_id)
    REFERENCES authenticated_ingress_results (stable_semantic_result_id),
  FOREIGN KEY (
    stable_semantic_result_id,
    collaboration_server_id,
    broker_route_id,
    accepted_ingress_delivery_attempt_id
  ) REFERENCES authenticated_ingress_results (
    stable_semantic_result_id,
    collaboration_server_id,
    broker_route_id,
    accepted_delivery_attempt_id
  ),
  FOREIGN KEY (command_result_id)
    REFERENCES collaboration_command_results (command_result_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (trigger_ingress_observation_id)
    REFERENCES authenticated_ingress_observations (ingress_observation_id),
  FOREIGN KEY (semantic_result_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (
    finalization_coordinator_lease_id,
    collaboration_server_id,
    finalization_coordinator_epoch
  ) REFERENCES coordinator_leases (
    coordinator_lease_id,
    collaboration_server_id,
    coordinator_epoch
  ),
  FOREIGN KEY (
    stable_semantic_result_id,
    collaboration_server_id,
    command_id,
    command_result_id,
    adjudication_state,
    terminal_at_ms
  ) REFERENCES a1_ingress_adjudications (
    stable_semantic_result_id,
    collaboration_server_id,
    command_id,
    command_result_id,
    state,
    terminal_at_ms
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (initial_result_delivery_id)
    REFERENCES a1_ingress_result_deliveries (result_delivery_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_A1_INGRESS_RESULT_DELIVERIES_SQL = `CREATE TABLE a1_ingress_result_deliveries (
  result_delivery_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(result_delivery_id) = 47
    AND substr(result_delivery_id, 1, 4) = 'rrd_'
    AND result_delivery_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  stable_semantic_result_id TEXT NOT NULL CHECK (
    length(stable_semantic_result_id) = 47
    AND substr(stable_semantic_result_id, 1, 4) = 'rrs_'
    AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_kind TEXT NOT NULL CHECK (source_kind = 'a1_ingress'),
  source_ref TEXT NOT NULL CHECK (
    length(source_ref) = 47
    AND substr(source_ref, 1, 4) = 'rrs_'
    AND source_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  command_result_id TEXT NOT NULL CHECK (
    length(command_result_id) = 47
    AND substr(command_result_id, 1, 4) = 'ccr_'
    AND command_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  trigger_ingress_observation_id TEXT NOT NULL CHECK (
    length(trigger_ingress_observation_id) = 47
    AND substr(trigger_ingress_observation_id, 1, 4) = 'rio_'
    AND trigger_ingress_observation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  broker_route_id TEXT NOT NULL CHECK (
    length(broker_route_id) = 47
    AND substr(broker_route_id, 1, 4) = 'rcr_'
    AND broker_route_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  target_kind TEXT NOT NULL CHECK (target_kind = 'a1_broker'),
  target_ref TEXT NOT NULL CHECK (
    length(target_ref) = 47
    AND substr(target_ref, 1, 4) = 'rcr_'
    AND target_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  delivery_attempt_id TEXT NOT NULL CHECK (
    length(delivery_attempt_id) = 26
    AND substr(delivery_attempt_id, 1, 4) = 'rda_'
    AND delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  semantic_result_record_kind TEXT NOT NULL CHECK (
    semantic_result_record_kind IN ('action_result', 'chat_creation_result')
  ),
  semantic_result_payload_schema_id TEXT NOT NULL CHECK (
    semantic_result_payload_schema_id IN (
      'remote-claw/a1-action-result/v1',
      'remote-claw/a1-chat-creation-result/v1'
    )
  ),
  semantic_result_payload_ref TEXT NOT NULL CHECK (
    length(semantic_result_payload_ref) = 27
    AND substr(semantic_result_payload_ref, 1, 5) = 'rcph_'
    AND semantic_result_payload_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  semantic_result_payload_artifact_digest TEXT NOT NULL CHECK (
    length(semantic_result_payload_artifact_digest) = 43
    AND semantic_result_payload_artifact_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  stored_semantic_result_digest TEXT NOT NULL CHECK (
    length(stored_semantic_result_digest) = 43
    AND stored_semantic_result_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  state TEXT NOT NULL CHECK (state = 'pending_seal'),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  CHECK (source_ref = stable_semantic_result_id),
  CHECK (target_ref = broker_route_id),
  CHECK (
    (semantic_result_record_kind = 'action_result'
      AND semantic_result_payload_schema_id = 'remote-claw/a1-action-result/v1')
    OR (semantic_result_record_kind = 'chat_creation_result'
      AND semantic_result_payload_schema_id =
        'remote-claw/a1-chat-creation-result/v1')
  ),
  FOREIGN KEY (stable_semantic_result_id)
    REFERENCES a1_ingress_terminal_results (stable_semantic_result_id),
  FOREIGN KEY (command_result_id)
    REFERENCES collaboration_command_results (command_result_id),
  FOREIGN KEY (trigger_ingress_observation_id)
    REFERENCES authenticated_ingress_observations (ingress_observation_id),
  FOREIGN KEY (broker_route_id)
    REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (semantic_result_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_COMMANDS_FINAL_RESULT_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_commands_final_result_unique
ON collaboration_commands (
  collaboration_server_id,
  command_id,
  current_command_result_id
)`;

const CREATE_INGRESS_RESULTS_TERMINAL_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX authenticated_ingress_results_terminal_scope_unique
ON authenticated_ingress_results (
  stable_semantic_result_id,
  collaboration_server_id,
  broker_route_id,
  accepted_delivery_attempt_id
)`;

const CREATE_ADJUDICATION_TERMINAL_INDEX_SQL = `CREATE UNIQUE INDEX a1_ingress_adjudications_terminal_unique
ON a1_ingress_adjudications (
  stable_semantic_result_id,
  collaboration_server_id,
  command_id,
  command_result_id,
  state,
  terminal_at_ms
)`;

const CREATE_COMMAND_RESULTS_COMMAND_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_results_command_unique
ON collaboration_command_results (collaboration_server_id, command_id)`;

const CREATE_COMMAND_RESULTS_SOURCE_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_results_source_unique
ON collaboration_command_results (source_kind, source_ref)`;

const CREATE_COMMAND_RESULTS_SIGNER_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_results_signer_unique
ON collaboration_command_results (collaboration_server_id, signer_sequence)`;

const CREATE_TERMINAL_RESULTS_COMMAND_INDEX_SQL = `CREATE UNIQUE INDEX a1_ingress_terminal_results_command_unique
ON a1_ingress_terminal_results (
  collaboration_server_id,
  command_id,
  command_result_id
)`;

const CREATE_TERMINAL_RESULTS_DELIVERY_INDEX_SQL = `CREATE UNIQUE INDEX a1_ingress_terminal_results_delivery_unique
ON a1_ingress_terminal_results (initial_result_delivery_id)`;

const CREATE_RESULT_DELIVERIES_OBSERVATION_INDEX_SQL = `CREATE UNIQUE INDEX a1_ingress_result_deliveries_observation_unique
ON a1_ingress_result_deliveries (
  stable_semantic_result_id,
  trigger_ingress_observation_id
)`;

const CREATE_RESULT_DELIVERIES_ATTEMPT_INDEX_SQL = `CREATE UNIQUE INDEX a1_ingress_result_deliveries_attempt_unique
ON a1_ingress_result_deliveries (broker_route_id, delivery_attempt_id)`;

const CREATE_COMMAND_REQUIRE_DECISION_TRIGGER_SQL = replaceSchemaSqlOnce(
  priorSchemaSql(
    VERSION_TEN_SQLITE_SCHEMA_ENTRIES,
    "collaboration_commands_require_rejected_decision",
  ),
  "BEFORE UPDATE ON collaboration_commands\nBEGIN",
  `BEFORE UPDATE ON collaboration_commands
WHEN NOT (OLD.state = 'decision_reserved' AND NEW.state = 'decided')
BEGIN`,
);

const CREATE_ADJUDICATION_REQUIRE_DECIDING_TRIGGER_SQL = replaceSchemaSqlOnce(
  priorSchemaSql(
    VERSION_TEN_SQLITE_SCHEMA_ENTRIES,
    "a1_ingress_adjudications_require_deciding_transition",
  ),
  "BEFORE UPDATE ON a1_ingress_adjudications\nBEGIN",
  `BEFORE UPDATE ON a1_ingress_adjudications
WHEN NOT (OLD.state = 'deciding' AND NEW.state = 'terminal')
BEGIN`,
);

const CREATE_INGRESS_RESULT_FREEZE_TRIGGER_SQL = replaceSchemaSqlOnce(
  priorSchemaSql(
    VERSION_TEN_SQLITE_SCHEMA_ENTRIES,
    "authenticated_ingress_results_freeze_adjudicated_source",
  ),
  "NEW.state <> 'awaiting_order'",
  "NEW.state NOT IN ('awaiting_order', 'quarantined_collision')",
);

const ORIGINAL_ACCEPTANCE_REQUIRE_SIGNED_TRIGGER_SQL = priorSchemaSql(
  VERSION_NINE_SQLITE_SCHEMA_ENTRIES,
  "server_signed_record_acceptances_require_exact_signed_record",
);

const CREATE_ACCEPTANCE_REQUIRE_SIGNED_TRIGGER_SQL = replaceSchemaSqlOnce(
  ORIGINAL_ACCEPTANCE_REQUIRE_SIGNED_TRIGGER_SQL,
  `              ))
            )
        ))
      OR (reservation.signing_lease_kind = 'bootstrap'`,
  `              ))
              OR (reservation.purpose = 'collaboration_command_result'
                AND NEW.historical_reattestation_id IS NULL
                AND signing_lease.state = 'superseded'
                AND signing_lease.superseded_at_ms IS NOT NULL
                AND reservation.signed_at_ms <= signing_lease.superseded_at_ms
                AND signing_lease.superseded_at_ms <= NEW.accepted_at_ms
                AND NOT EXISTS (
                  SELECT 1 FROM server_signing_leases AS later_signing_lease
                  WHERE later_signing_lease.collaboration_server_id =
                      signing_lease.collaboration_server_id
                    AND later_signing_lease.fencing_token > signing_lease.fencing_token
                )
                AND EXISTS (
                  SELECT 1
                  FROM collaboration_command_results AS result
                  JOIN a1_ingress_terminal_results AS terminal
                    ON terminal.stable_semantic_result_id = result.source_ref
                   AND terminal.command_result_id = result.command_result_id
                  JOIN collaboration_servers AS server
                    ON server.collaboration_server_id = result.collaboration_server_id
                  JOIN coordinator_leases AS coordinator
                    ON coordinator.coordinator_lease_id =
                      terminal.finalization_coordinator_lease_id
                   AND coordinator.collaboration_server_id =
                      terminal.collaboration_server_id
                   AND coordinator.coordinator_epoch =
                      terminal.finalization_coordinator_epoch
                  WHERE result.collaboration_server_id = NEW.collaboration_server_id
                    AND result.signer_sequence = NEW.signer_sequence
                    AND result.signed_record_digest = NEW.signed_record_digest
                    AND result.signer_identity_key_id = NEW.signer_identity_key_id
                    AND result.server_key_generation = NEW.signer_key_generation
                    AND result.signer_scope_certificate_id =
                      NEW.signer_scope_certificate_id
                    AND result.accepted_at_journal_seq = NEW.accepted_at_journal_seq
                    AND result.finalized_at_ms = NEW.accepted_at_ms
                    AND terminal.terminal_at_ms = NEW.accepted_at_ms
                    AND server.state = 'current'
                    AND server.current_identity_key_id = signing_lease.identity_key_id
                    AND server.current_key_generation = signing_lease.key_generation
                    AND server.current_scope_certificate_id =
                      signing_lease.scope_certificate_id
                    AND server.current_coordinator_lease_id =
                      terminal.finalization_coordinator_lease_id
                    AND server.current_coordinator_epoch =
                      terminal.finalization_coordinator_epoch
                    AND coordinator.state = 'current'
                    AND coordinator.released_at_ms IS NULL
                    AND coordinator.acquired_at_ms <= NEW.accepted_at_ms
                    AND NEW.accepted_at_ms < coordinator.heartbeat_deadline_ms
                ))
            )
        ))
      OR (reservation.signing_lease_kind = 'bootstrap'`,
);

const CREATE_SIGNING_LEASE_REQUIRE_POST_ACCEPTANCE_TIME_TRIGGER_SQL = `CREATE TRIGGER server_signing_leases_require_post_acceptance_time_v11
BEFORE INSERT ON server_signing_leases
WHEN EXISTS (
  SELECT 1 FROM server_signing_leases AS prior_lease
  WHERE prior_lease.collaboration_server_id = NEW.collaboration_server_id
)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM server_signed_record_acceptances AS acceptance
    JOIN server_signature_reservations AS reservation
      ON reservation.collaboration_server_id = acceptance.collaboration_server_id
     AND reservation.signer_sequence = acceptance.signer_sequence
     AND reservation.signed_record_digest = acceptance.signed_record_digest
    JOIN server_signing_leases AS accepted_lease
      ON accepted_lease.collaboration_server_id = reservation.collaboration_server_id
     AND accepted_lease.signing_lease_id = reservation.signing_lease_id
    WHERE acceptance.collaboration_server_id = NEW.collaboration_server_id
      AND accepted_lease.fencing_token < NEW.fencing_token
      AND acceptance.accepted_at_ms >= NEW.acquired_at_ms
  ) THEN RAISE(ABORT, 'successor signing lease must postdate predecessor acceptances') END;
END`;

const CREATE_COMMAND_RESULT_REQUIRE_EXACT_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_results_require_exact_signed_rejection
BEFORE INSERT ON collaboration_command_results
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_commands AS command
    JOIN a1_ingress_adjudications AS adjudication
      ON adjudication.stable_semantic_result_id = command.source_ref
     AND adjudication.collaboration_server_id = command.collaboration_server_id
     AND adjudication.command_id = command.command_id
    JOIN authenticated_ingress_results AS ingress
      ON ingress.stable_semantic_result_id = command.source_ref
     AND ingress.collaboration_server_id = command.collaboration_server_id
    JOIN collaboration_command_result_preparations AS preparation
      ON preparation.command_result_preparation_id =
        adjudication.command_result_preparation_id
     AND preparation.collaboration_server_id = command.collaboration_server_id
     AND preparation.command_id = command.command_id
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id =
        preparation.compound_signing_group_id
     AND signing_group.result_preparation_ref =
        preparation.command_result_preparation_id
    JOIN server_signature_reservations AS reservation
      ON reservation.collaboration_server_id = preparation.collaboration_server_id
     AND reservation.signer_sequence = preparation.signer_sequence
     AND reservation.signing_lease_id = preparation.signing_lease_id
    JOIN server_signing_leases AS signing_lease
      ON signing_lease.signing_lease_id = preparation.signing_lease_id
     AND signing_lease.collaboration_server_id = preparation.collaboration_server_id
    JOIN protected_artifacts AS artifact
      ON artifact.protected_handle_id = preparation.canonical_payload_ref
    WHERE command.collaboration_server_id = NEW.collaboration_server_id
      AND command.command_id = NEW.command_id
      AND command.state = 'decision_reserved'
      AND command.current_command_result_id IS NULL
      AND command.source_kind = 'a1_ingress'
      AND command.source_ref = NEW.source_ref
      AND command.scope_kind = NEW.scope_kind
      AND command.logical_chat_id IS NEW.logical_chat_id
      AND command.target_logical_chat_id IS NEW.target_logical_chat_id
      AND command.command_seq = NEW.command_seq
      AND command.disposition = 'rejected'
      AND command.canonical_command_record_digest =
        NEW.canonical_command_record_digest
      AND adjudication.state = 'deciding'
      AND adjudication.command_seq = NEW.command_seq
      AND adjudication.disposition = 'rejected'
      AND adjudication.command_result_id = NEW.command_result_id
      AND adjudication.viewer_projection_seq IS NULL
      AND ingress.state IN ('awaiting_order', 'quarantined_collision')
      AND ingress.route_kind = NEW.scope_kind
      AND ingress.logical_chat_id IS NEW.logical_chat_id
      AND ingress.accepted_delivery_attempt_id IS NOT NULL
      AND preparation.command_result_id = NEW.command_result_id
      AND preparation.command_result_preparation_id =
        NEW.command_result_preparation_id
      AND preparation.canonical_command_record_digest =
        NEW.canonical_command_record_digest
      AND preparation.result_version = NEW.result_version
      AND preparation.canonical_payload_ref = NEW.canonical_payload_ref
      AND preparation.canonical_payload_digest = NEW.canonical_payload_digest
      AND preparation.signer_sequence = NEW.signer_sequence
      AND preparation.compound_signing_group_id = NEW.compound_signing_group_id
      AND preparation.required_finalization_artifact_kind = 'none'
      AND preparation.current_finalization_artifact_preparation_ref IS NULL
      AND preparation.prepared_at_ms = NEW.created_at_ms
      AND preparation.signed_at_ms IS NOT NULL
      AND preparation.signed_at_ms <= NEW.finalized_at_ms
      AND preparation.state = 'signed'
      AND signing_group.collaboration_server_id = NEW.collaboration_server_id
      AND signing_group.command_id = NEW.command_id
      AND signing_group.command_result_id = NEW.command_result_id
      AND signing_group.required_finalization_artifact_kind = 'none'
      AND signing_group.secondary_preparation_ref IS NULL
      AND signing_group.result_signed_at_ms = preparation.signed_at_ms
      AND signing_group.both_signed_at_ms IS NULL
      AND signing_group.finalized_at_ms IS NULL
      AND signing_group.aborted_at_ms IS NULL
      AND signing_group.state = 'result_signed'
      AND reservation.purpose = 'collaboration_command_result'
      AND reservation.canonical_payload_schema_id = NEW.canonical_payload_schema_id
      AND reservation.canonical_payload_ref = NEW.canonical_payload_ref
      AND reservation.canonical_payload_digest = NEW.canonical_payload_digest
      AND reservation.signed_record_digest = NEW.signed_record_digest
      AND reservation.signature = NEW.signature
      AND reservation.signed_artifact_type =
        'collaboration_command_result_preparation'
      AND reservation.signed_artifact_id = NEW.command_result_preparation_id
      AND reservation.signed_at_ms = preparation.signed_at_ms
      AND reservation.state = 'signed'
      AND signing_lease.identity_key_id = NEW.signer_identity_key_id
      AND signing_lease.key_generation = NEW.server_key_generation
      AND signing_lease.scope_certificate_id = NEW.signer_scope_certificate_id
      AND signing_lease.state IN ('current', 'draining', 'superseded')
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'collaboration_server'
      AND artifact.scope_id = NEW.collaboration_server_id
      AND artifact.artifact_schema_id = NEW.canonical_payload_schema_id
      AND artifact.artifact_digest = NEW.canonical_payload_digest
      AND ((NEW.scope_kind = 'server_control' AND ingress.record_kind = 'new_chat')
        OR (NEW.scope_kind = 'chat' AND ingress.record_kind = 'user'))
  ) THEN RAISE(ABORT, 'command result requires its exact signed rejected preparation') END;
END`;

const CREATE_TERMINAL_RESULT_REQUIRE_EXACT_TRIGGER_SQL = `CREATE TRIGGER a1_ingress_terminal_results_require_exact_rejection
BEFORE INSERT ON a1_ingress_terminal_results
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM authenticated_ingress_results AS ingress
    JOIN a1_ingress_adjudications AS adjudication
      ON adjudication.stable_semantic_result_id = ingress.stable_semantic_result_id
     AND adjudication.collaboration_server_id = ingress.collaboration_server_id
    JOIN collaboration_commands AS command
      ON command.command_id = adjudication.command_id
     AND command.collaboration_server_id = adjudication.collaboration_server_id
    JOIN collaboration_command_results AS result
      ON result.command_result_id = adjudication.command_result_id
     AND result.collaboration_server_id = adjudication.collaboration_server_id
     AND result.command_id = adjudication.command_id
    JOIN authenticated_ingress_observations AS observation
      ON observation.ingress_observation_id = NEW.trigger_ingress_observation_id
     AND observation.stable_semantic_result_id = ingress.stable_semantic_result_id
     AND observation.delivery_attempt_id = ingress.accepted_delivery_attempt_id
     AND observation.broker_route_id = ingress.broker_route_id
     AND observation.collaboration_server_id = ingress.collaboration_server_id
    JOIN authenticated_ingress_parts AS completion_part
      ON completion_part.stable_semantic_result_id =
        observation.stable_semantic_result_id
     AND completion_part.delivery_attempt_id = observation.delivery_attempt_id
     AND completion_part.part = observation.part
     AND completion_part.first_ingress_generation = observation.channel_generation
     AND completion_part.first_ingress_frame_index = observation.frame_index
    JOIN protected_artifacts AS artifact
      ON artifact.protected_handle_id = NEW.semantic_result_payload_ref
    JOIN collaboration_servers AS server
      ON server.collaboration_server_id = ingress.collaboration_server_id
    JOIN coordinator_leases AS coordinator
      ON coordinator.coordinator_lease_id =
        NEW.finalization_coordinator_lease_id
     AND coordinator.collaboration_server_id = NEW.collaboration_server_id
     AND coordinator.coordinator_epoch = NEW.finalization_coordinator_epoch
    WHERE ingress.stable_semantic_result_id = NEW.stable_semantic_result_id
      AND ingress.collaboration_server_id = NEW.collaboration_server_id
      AND ingress.broker_route_id = NEW.broker_route_id
      AND ingress.accepted_delivery_attempt_id =
        NEW.accepted_ingress_delivery_attempt_id
      AND ingress.state IN ('awaiting_order', 'quarantined_collision')
      AND adjudication.command_id = NEW.command_id
      AND adjudication.command_result_id = NEW.command_result_id
      AND adjudication.state = 'deciding'
      AND adjudication.disposition = 'rejected'
      AND adjudication.viewer_projection_seq IS NULL
      AND command.state = 'decision_reserved'
      AND command.disposition = 'rejected'
      AND command.current_command_result_id IS NULL
      AND result.source_kind = 'a1_ingress'
      AND result.source_ref = NEW.stable_semantic_result_id
      AND result.disposition = 'rejected'
      AND result.finalized_at_ms = NEW.terminal_at_ms
      AND observation.disposition = 'new_part'
      AND NOT EXISTS (
        SELECT 1
        FROM authenticated_ingress_parts AS later_part
        WHERE later_part.stable_semantic_result_id =
            ingress.stable_semantic_result_id
          AND later_part.delivery_attempt_id = ingress.accepted_delivery_attempt_id
          AND (
            later_part.first_ingress_generation > observation.channel_generation
            OR (later_part.first_ingress_generation = observation.channel_generation
              AND later_part.first_ingress_frame_index > observation.frame_index)
          )
      )
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'collaboration_server'
      AND artifact.scope_id = NEW.collaboration_server_id
      AND artifact.artifact_schema_id = NEW.semantic_result_payload_schema_id
      AND artifact.artifact_digest = NEW.semantic_result_payload_artifact_digest
      AND artifact.created_at_ms <= NEW.terminal_at_ms
      AND server.state = 'current'
      AND server.current_coordinator_lease_id =
        NEW.finalization_coordinator_lease_id
      AND server.current_coordinator_epoch = NEW.finalization_coordinator_epoch
      AND coordinator.state = 'current'
      AND coordinator.released_at_ms IS NULL
      AND coordinator.acquired_at_ms <= NEW.terminal_at_ms
      AND NEW.terminal_at_ms < coordinator.heartbeat_deadline_ms
      AND (
        (ingress.route_kind = 'chat'
          AND ingress.record_kind = 'user'
          AND NEW.semantic_result_record_kind = 'action_result'
          AND NEW.semantic_result_payload_schema_id =
            'remote-claw/a1-action-result/v1')
        OR (ingress.route_kind = 'server_control'
          AND ingress.record_kind = 'new_chat'
          AND NEW.semantic_result_record_kind = 'chat_creation_result'
          AND NEW.semantic_result_payload_schema_id =
            'remote-claw/a1-chat-creation-result/v1')
      )
  ) THEN RAISE(ABORT, 'terminal A1 result requires exact rejected completion evidence') END;
END`;

const CREATE_RESULT_DELIVERY_REQUIRE_EXACT_TRIGGER_SQL = `CREATE TRIGGER a1_ingress_result_deliveries_require_exact_pending_seal
BEFORE INSERT ON a1_ingress_result_deliveries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM a1_ingress_terminal_results AS terminal
    JOIN collaboration_command_results AS result
      ON result.command_result_id = terminal.command_result_id
    JOIN authenticated_ingress_observations AS observation
      ON observation.ingress_observation_id = terminal.trigger_ingress_observation_id
    WHERE terminal.initial_result_delivery_id = NEW.result_delivery_id
      AND terminal.stable_semantic_result_id = NEW.stable_semantic_result_id
      AND terminal.command_result_id = NEW.command_result_id
      AND terminal.trigger_ingress_observation_id =
        NEW.trigger_ingress_observation_id
      AND terminal.broker_route_id = NEW.broker_route_id
      AND terminal.semantic_result_record_kind = NEW.semantic_result_record_kind
      AND terminal.semantic_result_payload_schema_id =
        NEW.semantic_result_payload_schema_id
      AND terminal.semantic_result_payload_ref = NEW.semantic_result_payload_ref
      AND terminal.semantic_result_payload_artifact_digest =
        NEW.semantic_result_payload_artifact_digest
      AND terminal.stored_semantic_result_digest =
        NEW.stored_semantic_result_digest
      AND terminal.terminal_at_ms = NEW.created_at_ms
      AND result.source_ref = NEW.source_ref
      AND result.disposition = 'rejected'
      AND observation.stable_semantic_result_id = NEW.stable_semantic_result_id
      AND observation.broker_route_id = NEW.broker_route_id
      AND NEW.source_kind = 'a1_ingress'
      AND NEW.source_ref = NEW.stable_semantic_result_id
      AND NEW.target_kind = 'a1_broker'
      AND NEW.target_ref = NEW.broker_route_id
      AND NEW.state = 'pending_seal'
  ) THEN RAISE(ABORT, 'A1 result delivery requires its exact pending-seal terminal result') END;
END`;

const CREATE_ACCEPTANCE_REQUIRE_COMMAND_RESULT_TRIGGER_SQL = `CREATE TRIGGER server_signed_record_acceptances_require_command_result_v11
BEFORE INSERT ON server_signed_record_acceptances
WHEN EXISTS (
  SELECT 1 FROM server_signature_reservations AS reservation
  WHERE reservation.collaboration_server_id = NEW.collaboration_server_id
    AND reservation.signer_sequence = NEW.signer_sequence
    AND reservation.purpose = 'collaboration_command_result'
)
BEGIN
  SELECT CASE WHEN NEW.historical_reattestation_id IS NOT NULL OR NOT EXISTS (
    SELECT 1
    FROM collaboration_command_results AS result
    JOIN a1_ingress_terminal_results AS terminal
      ON terminal.stable_semantic_result_id = result.source_ref
     AND terminal.command_result_id = result.command_result_id
    JOIN a1_ingress_result_deliveries AS delivery
      ON delivery.result_delivery_id = terminal.initial_result_delivery_id
     AND delivery.stable_semantic_result_id = terminal.stable_semantic_result_id
     AND delivery.command_result_id = result.command_result_id
     AND delivery.trigger_ingress_observation_id =
        terminal.trigger_ingress_observation_id
    JOIN collaboration_servers AS server
      ON server.collaboration_server_id = result.collaboration_server_id
    JOIN coordinator_leases AS coordinator
      ON coordinator.coordinator_lease_id =
        terminal.finalization_coordinator_lease_id
     AND coordinator.collaboration_server_id = terminal.collaboration_server_id
     AND coordinator.coordinator_epoch = terminal.finalization_coordinator_epoch
    WHERE result.collaboration_server_id = NEW.collaboration_server_id
      AND result.signer_sequence = NEW.signer_sequence
      AND result.signed_record_digest = NEW.signed_record_digest
      AND result.signer_identity_key_id = NEW.signer_identity_key_id
      AND result.server_key_generation = NEW.signer_key_generation
      AND result.signer_scope_certificate_id = NEW.signer_scope_certificate_id
      AND result.accepted_at_journal_seq = NEW.accepted_at_journal_seq
      AND result.finalized_at_ms = NEW.accepted_at_ms
      AND terminal.terminal_at_ms = NEW.accepted_at_ms
      AND terminal.adjudication_state = 'terminal'
      AND delivery.state = 'pending_seal'
      AND delivery.created_at_ms = NEW.accepted_at_ms
      AND server.state = 'current'
      AND server.current_coordinator_lease_id =
        terminal.finalization_coordinator_lease_id
      AND server.current_coordinator_epoch = terminal.finalization_coordinator_epoch
      AND coordinator.state = 'current'
      AND coordinator.released_at_ms IS NULL
      AND coordinator.acquired_at_ms <= NEW.accepted_at_ms
      AND NEW.accepted_at_ms < coordinator.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, 'command-result acceptance requires its exact terminal outbox graph') END;
END`;

const CREATE_ADJUDICATION_REQUIRE_TERMINAL_TRIGGER_SQL = `CREATE TRIGGER a1_ingress_adjudications_require_terminal_result
BEFORE UPDATE ON a1_ingress_adjudications
WHEN OLD.state = 'deciding' AND NEW.state = 'terminal'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.stable_semantic_result_id IS OLD.stable_semantic_result_id
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.command_id IS OLD.command_id
    AND NEW.ready_at_journal_seq IS OLD.ready_at_journal_seq
    AND NEW.command_seq IS OLD.command_seq
    AND NEW.disposition IS OLD.disposition
    AND NEW.command_result_id IS OLD.command_result_id
    AND NEW.command_result_preparation_id IS OLD.command_result_preparation_id
    AND NEW.viewer_projection_seq IS NULL
    AND OLD.viewer_projection_seq IS NULL
    AND NEW.decided_at_ms IS OLD.decided_at_ms
    AND OLD.terminal_at_ms IS NULL
    AND NEW.terminal_at_ms IS NOT NULL
    AND NEW.disposition = 'rejected'
  ) THEN RAISE(ABORT, 'A1 terminal transition must freeze its rejected decision') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM a1_ingress_terminal_results AS terminal
    JOIN collaboration_command_results AS result
      ON result.command_result_id = terminal.command_result_id
     AND result.source_ref = terminal.stable_semantic_result_id
    JOIN a1_ingress_result_deliveries AS delivery
      ON delivery.result_delivery_id = terminal.initial_result_delivery_id
     AND delivery.stable_semantic_result_id = terminal.stable_semantic_result_id
     AND delivery.command_result_id = terminal.command_result_id
     AND delivery.trigger_ingress_observation_id =
        terminal.trigger_ingress_observation_id
    JOIN server_signed_record_acceptances AS acceptance
      ON acceptance.collaboration_server_id = result.collaboration_server_id
     AND acceptance.accepted_at_journal_seq = result.accepted_at_journal_seq
     AND acceptance.signed_record_digest = result.signed_record_digest
     AND acceptance.signer_sequence = result.signer_sequence
    JOIN collaboration_command_result_preparations AS preparation
      ON preparation.command_result_preparation_id =
        NEW.command_result_preparation_id
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id =
        preparation.compound_signing_group_id
     AND signing_group.result_preparation_ref =
        preparation.command_result_preparation_id
    WHERE terminal.stable_semantic_result_id = NEW.stable_semantic_result_id
      AND terminal.collaboration_server_id = NEW.collaboration_server_id
      AND terminal.command_id = NEW.command_id
      AND terminal.command_result_id = NEW.command_result_id
      AND terminal.adjudication_state = 'terminal'
      AND terminal.terminal_at_ms = NEW.terminal_at_ms
      AND result.command_id = NEW.command_id
      AND result.disposition = 'rejected'
      AND result.command_seq = NEW.command_seq
      AND result.command_result_preparation_id =
        NEW.command_result_preparation_id
      AND result.finalized_at_ms = NEW.terminal_at_ms
      AND delivery.state = 'pending_seal'
      AND delivery.created_at_ms = NEW.terminal_at_ms
      AND acceptance.accepted_at_ms = NEW.terminal_at_ms
      AND acceptance.historical_reattestation_id IS NULL
      AND preparation.state = 'signed'
      AND preparation.required_finalization_artifact_kind = 'none'
      AND signing_group.state = 'result_signed'
      AND signing_group.required_finalization_artifact_kind = 'none'
      AND signing_group.secondary_preparation_ref IS NULL
  ) THEN RAISE(ABORT, 'A1 terminal transition requires exact result acceptance and outbox') END;
END`;

const CREATE_COMMAND_REQUIRE_FINAL_RESULT_TRIGGER_SQL = `CREATE TRIGGER collaboration_commands_require_final_rejected_result
BEFORE UPDATE ON collaboration_commands
WHEN OLD.state = 'decision_reserved' AND NEW.state = 'decided'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.command_id IS OLD.command_id
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.scope_kind IS OLD.scope_kind
    AND NEW.logical_chat_id IS OLD.logical_chat_id
    AND NEW.target_logical_chat_id IS OLD.target_logical_chat_id
    AND NEW.source_kind IS OLD.source_kind
    AND NEW.source_ref IS OLD.source_ref
    AND NEW.source_event_namespace_id IS OLD.source_event_namespace_id
    AND NEW.source_event_id IS OLD.source_event_id
    AND NEW.source_command_identity_digest IS OLD.source_command_identity_digest
    AND NEW.canonical_source_event_digest IS OLD.canonical_source_event_digest
    AND NEW.mutation_family IS OLD.mutation_family
    AND NEW.canonical_command_payload_schema_id IS
      OLD.canonical_command_payload_schema_id
    AND NEW.canonical_command_payload_ref IS OLD.canonical_command_payload_ref
    AND NEW.canonical_command_payload_digest IS
      OLD.canonical_command_payload_digest
    AND NEW.pre_decision_normalization_evidence_schema_id IS
      OLD.pre_decision_normalization_evidence_schema_id
    AND NEW.pre_decision_normalization_evidence_ref IS
      OLD.pre_decision_normalization_evidence_ref
    AND NEW.pre_decision_normalization_evidence_digest IS
      OLD.pre_decision_normalization_evidence_digest
    AND NEW.ready_at_journal_seq IS OLD.ready_at_journal_seq
    AND NEW.command_seq IS OLD.command_seq
    AND NEW.disposition IS OLD.disposition
    AND NEW.admitted_target_kind IS OLD.admitted_target_kind
    AND NEW.project_target_selector_mapping_id IS
      OLD.project_target_selector_mapping_id
    AND NEW.project_target_selector_mapping_generation IS
      OLD.project_target_selector_mapping_generation
    AND NEW.project_target_digest IS OLD.project_target_digest
    AND NEW.selected_executor_evidence_schema_id IS
      OLD.selected_executor_evidence_schema_id
    AND NEW.selected_executor_evidence_ref IS OLD.selected_executor_evidence_ref
    AND NEW.selected_executor_evidence_digest IS
      OLD.selected_executor_evidence_digest
    AND NEW.target_capability_snapshot_id IS OLD.target_capability_snapshot_id
    AND NEW.target_capability_family_digest IS
      OLD.target_capability_family_digest
    AND NEW.decision_evidence_schema_id IS OLD.decision_evidence_schema_id
    AND NEW.decision_evidence_ref IS OLD.decision_evidence_ref
    AND NEW.decision_evidence_digest IS OLD.decision_evidence_digest
    AND NEW.canonical_command_record_digest IS
      OLD.canonical_command_record_digest
    AND NEW.coordinator_lease_id IS OLD.coordinator_lease_id
    AND NEW.coordinator_epoch IS OLD.coordinator_epoch
    AND NEW.decision_coordinator_lease_id IS OLD.decision_coordinator_lease_id
    AND NEW.decision_coordinator_epoch IS OLD.decision_coordinator_epoch
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.decided_at_ms IS OLD.decided_at_ms
    AND OLD.current_command_result_id IS NULL
    AND NEW.current_command_result_id IS NOT NULL
    AND NEW.disposition = 'rejected'
    AND NEW.admitted_target_kind IS NULL
    AND NEW.selected_executor_evidence_schema_id IS NULL
    AND NEW.target_capability_snapshot_id IS NULL
  ) THEN RAISE(ABORT, 'decided command must freeze its rejected decision') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_command_results AS result
    JOIN a1_ingress_terminal_results AS terminal
      ON terminal.stable_semantic_result_id = result.source_ref
     AND terminal.command_result_id = result.command_result_id
    JOIN a1_ingress_result_deliveries AS delivery
      ON delivery.result_delivery_id = terminal.initial_result_delivery_id
     AND delivery.command_result_id = result.command_result_id
    JOIN a1_ingress_adjudications AS adjudication
      ON adjudication.stable_semantic_result_id = terminal.stable_semantic_result_id
     AND adjudication.command_id = result.command_id
     AND adjudication.command_result_id = result.command_result_id
    JOIN server_signed_record_acceptances AS acceptance
      ON acceptance.collaboration_server_id = result.collaboration_server_id
     AND acceptance.accepted_at_journal_seq = result.accepted_at_journal_seq
     AND acceptance.signed_record_digest = result.signed_record_digest
     AND acceptance.signer_sequence = result.signer_sequence
    JOIN collaboration_command_result_preparations AS preparation
      ON preparation.command_result_preparation_id =
        result.command_result_preparation_id
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id = result.compound_signing_group_id
     AND signing_group.result_preparation_ref =
        result.command_result_preparation_id
    WHERE result.command_result_id = NEW.current_command_result_id
      AND result.collaboration_server_id = NEW.collaboration_server_id
      AND result.command_id = NEW.command_id
      AND result.source_kind = NEW.source_kind
      AND result.source_ref = NEW.source_ref
      AND result.scope_kind = NEW.scope_kind
      AND result.logical_chat_id IS NEW.logical_chat_id
      AND result.target_logical_chat_id IS NEW.target_logical_chat_id
      AND result.command_seq = NEW.command_seq
      AND result.disposition = 'rejected'
      AND result.canonical_command_record_digest =
        NEW.canonical_command_record_digest
      AND terminal.command_id = NEW.command_id
      AND terminal.adjudication_state = 'terminal'
      AND adjudication.state = 'terminal'
      AND adjudication.terminal_at_ms = terminal.terminal_at_ms
      AND delivery.state = 'pending_seal'
      AND acceptance.accepted_at_ms = terminal.terminal_at_ms
      AND acceptance.historical_reattestation_id IS NULL
      AND preparation.state = 'signed'
      AND preparation.required_finalization_artifact_kind = 'none'
      AND signing_group.state = 'result_signed'
      AND signing_group.required_finalization_artifact_kind = 'none'
      AND signing_group.secondary_preparation_ref IS NULL
  ) THEN RAISE(ABORT, 'decided command requires exact terminal rejected result graph') END;
END`;

function immutableUpdateTrigger(tableName: string, label: string): string {
  return `CREATE TRIGGER ${tableName}_no_update
BEFORE UPDATE ON ${tableName}
BEGIN
  SELECT RAISE(ABORT, '${label} are immutable');
END`;
}

function retainedDeleteTrigger(tableName: string, label: string): string {
  return `CREATE TRIGGER ${tableName}_no_delete
BEFORE DELETE ON ${tableName}
BEGIN
  SELECT RAISE(ABORT, '${label} are retained');
END`;
}

function noReplaceTrigger(tableName: string, primaryKey: string, label: string): string {
  return `CREATE TRIGGER ${tableName}_no_replace
BEFORE INSERT ON ${tableName}
WHEN EXISTS (
  SELECT 1 FROM ${tableName} WHERE ${primaryKey} = NEW.${primaryKey}
)
BEGIN
  SELECT RAISE(ABORT, '${label} are immutable');
END`;
}

const CREATE_COMMAND_RESULTS_NO_UPDATE_TRIGGER_SQL = immutableUpdateTrigger(
  "collaboration_command_results",
  "collaboration command results",
);
const CREATE_COMMAND_RESULTS_NO_DELETE_TRIGGER_SQL = retainedDeleteTrigger(
  "collaboration_command_results",
  "collaboration command results",
);
const CREATE_COMMAND_RESULTS_NO_REPLACE_TRIGGER_SQL = noReplaceTrigger(
  "collaboration_command_results",
  "command_result_id",
  "collaboration command results",
);
const CREATE_TERMINAL_RESULTS_NO_UPDATE_TRIGGER_SQL = immutableUpdateTrigger(
  "a1_ingress_terminal_results",
  "A1 ingress terminal results",
);
const CREATE_TERMINAL_RESULTS_NO_DELETE_TRIGGER_SQL = retainedDeleteTrigger(
  "a1_ingress_terminal_results",
  "A1 ingress terminal results",
);
const CREATE_TERMINAL_RESULTS_NO_REPLACE_TRIGGER_SQL = noReplaceTrigger(
  "a1_ingress_terminal_results",
  "stable_semantic_result_id",
  "A1 ingress terminal results",
);
const CREATE_RESULT_DELIVERIES_NO_UPDATE_TRIGGER_SQL = immutableUpdateTrigger(
  "a1_ingress_result_deliveries",
  "A1 ingress result deliveries",
);
const CREATE_RESULT_DELIVERIES_NO_DELETE_TRIGGER_SQL = retainedDeleteTrigger(
  "a1_ingress_result_deliveries",
  "A1 ingress result deliveries",
);
const CREATE_RESULT_DELIVERIES_NO_REPLACE_TRIGGER_SQL = noReplaceTrigger(
  "a1_ingress_result_deliveries",
  "result_delivery_id",
  "A1 ingress result deliveries",
);

/** Existing schema objects that v11 replaces before creating its final schema entries. */
export const VERSION_ELEVEN_PRE_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  "DROP TRIGGER collaboration_commands_require_rejected_decision",
  "DROP TRIGGER a1_ingress_adjudications_require_deciding_transition",
  "DROP TRIGGER authenticated_ingress_results_freeze_adjudicated_source",
  "DROP TRIGGER server_signed_record_acceptances_require_exact_signed_record",
  "DROP TRIGGER server_signed_record_acceptances_forbid_command_results_v10",
]);

export const VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    table("collaboration_command_results", CREATE_COLLABORATION_COMMAND_RESULTS_SQL),
    table("a1_ingress_terminal_results", CREATE_A1_INGRESS_TERMINAL_RESULTS_SQL),
    table("a1_ingress_result_deliveries", CREATE_A1_INGRESS_RESULT_DELIVERIES_SQL),
    schemaEntry(
      "index",
      "collaboration_commands_final_result_unique",
      "collaboration_commands",
      CREATE_COMMANDS_FINAL_RESULT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_ingress_results_terminal_scope_unique",
      "authenticated_ingress_results",
      CREATE_INGRESS_RESULTS_TERMINAL_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "a1_ingress_adjudications_terminal_unique",
      "a1_ingress_adjudications",
      CREATE_ADJUDICATION_TERMINAL_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_results_command_unique",
      "collaboration_command_results",
      CREATE_COMMAND_RESULTS_COMMAND_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_results_source_unique",
      "collaboration_command_results",
      CREATE_COMMAND_RESULTS_SOURCE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_results_signer_unique",
      "collaboration_command_results",
      CREATE_COMMAND_RESULTS_SIGNER_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "a1_ingress_terminal_results_command_unique",
      "a1_ingress_terminal_results",
      CREATE_TERMINAL_RESULTS_COMMAND_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "a1_ingress_terminal_results_delivery_unique",
      "a1_ingress_terminal_results",
      CREATE_TERMINAL_RESULTS_DELIVERY_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "a1_ingress_result_deliveries_observation_unique",
      "a1_ingress_result_deliveries",
      CREATE_RESULT_DELIVERIES_OBSERVATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "a1_ingress_result_deliveries_attempt_unique",
      "a1_ingress_result_deliveries",
      CREATE_RESULT_DELIVERIES_ATTEMPT_INDEX_SQL,
    ),
    trigger(
      "collaboration_commands_require_rejected_decision",
      "collaboration_commands",
      CREATE_COMMAND_REQUIRE_DECISION_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_commands_require_final_rejected_result",
      "collaboration_commands",
      CREATE_COMMAND_REQUIRE_FINAL_RESULT_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_adjudications_require_deciding_transition",
      "a1_ingress_adjudications",
      CREATE_ADJUDICATION_REQUIRE_DECIDING_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_adjudications_require_terminal_result",
      "a1_ingress_adjudications",
      CREATE_ADJUDICATION_REQUIRE_TERMINAL_TRIGGER_SQL,
    ),
    trigger(
      "authenticated_ingress_results_freeze_adjudicated_source",
      "authenticated_ingress_results",
      CREATE_INGRESS_RESULT_FREEZE_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_require_exact_signed_record",
      "server_signed_record_acceptances",
      CREATE_ACCEPTANCE_REQUIRE_SIGNED_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_require_command_result_v11",
      "server_signed_record_acceptances",
      CREATE_ACCEPTANCE_REQUIRE_COMMAND_RESULT_TRIGGER_SQL,
    ),
    trigger(
      "server_signing_leases_require_post_acceptance_time_v11",
      "server_signing_leases",
      CREATE_SIGNING_LEASE_REQUIRE_POST_ACCEPTANCE_TIME_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_results_require_exact_signed_rejection",
      "collaboration_command_results",
      CREATE_COMMAND_RESULT_REQUIRE_EXACT_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_results_no_update",
      "collaboration_command_results",
      CREATE_COMMAND_RESULTS_NO_UPDATE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_results_no_delete",
      "collaboration_command_results",
      CREATE_COMMAND_RESULTS_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_results_no_replace",
      "collaboration_command_results",
      CREATE_COMMAND_RESULTS_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_terminal_results_require_exact_rejection",
      "a1_ingress_terminal_results",
      CREATE_TERMINAL_RESULT_REQUIRE_EXACT_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_terminal_results_no_update",
      "a1_ingress_terminal_results",
      CREATE_TERMINAL_RESULTS_NO_UPDATE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_terminal_results_no_delete",
      "a1_ingress_terminal_results",
      CREATE_TERMINAL_RESULTS_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_terminal_results_no_replace",
      "a1_ingress_terminal_results",
      CREATE_TERMINAL_RESULTS_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_result_deliveries_require_exact_pending_seal",
      "a1_ingress_result_deliveries",
      CREATE_RESULT_DELIVERY_REQUIRE_EXACT_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_result_deliveries_no_update",
      "a1_ingress_result_deliveries",
      CREATE_RESULT_DELIVERIES_NO_UPDATE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_result_deliveries_no_delete",
      "a1_ingress_result_deliveries",
      CREATE_RESULT_DELIVERIES_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_result_deliveries_no_replace",
      "a1_ingress_result_deliveries",
      CREATE_RESULT_DELIVERIES_NO_REPLACE_TRIGGER_SQL,
    ),
  ]);

export const VERSION_ELEVEN_DATA_STATEMENTS: readonly string[] = Object.freeze([]);
