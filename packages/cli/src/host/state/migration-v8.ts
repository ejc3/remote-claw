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

const SCOPE_CHECK = `(route_kind IN ('scope_bus', 'server_control', 'chat'))`;
const INGRESS_SCOPE_CHECK = `(route_kind IN ('server_control', 'chat'))`;

const CREATE_BROKER_ROUTE_RUNTIME_STATUS_SQL = `CREATE TABLE broker_route_runtime_status (
  broker_route_id TEXT PRIMARY KEY NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  machine_identity_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('current', 'quarantined', 'closed')),
  current_channel_generation INTEGER NOT NULL CHECK (current_channel_generation BETWEEN 0 AND 9007199254740991),
  active_gap_count INTEGER NOT NULL CHECK (active_gap_count BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((route_kind IN ('scope_bus', 'server_control') AND logical_chat_id IS NULL) OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_CHANNEL_GENERATION_OBSERVATIONS_SQL = `CREATE TABLE broker_channel_generation_observations (
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  channel_generation INTEGER NOT NULL CHECK (channel_generation BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('open', 'sealed')),
  observed_next_frame_index INTEGER NOT NULL CHECK (observed_next_frame_index BETWEEN 0 AND 4096),
  frame_count INTEGER CHECK (frame_count IS NULL OR frame_count BETWEEN 0 AND 4096),
  next_generation INTEGER CHECK (next_generation IS NULL OR next_generation BETWEEN 1 AND 9007199254740991),
  manifest_digest TEXT CHECK (manifest_digest IS NULL OR length(manifest_digest) = 43),
  first_observed_at_ms INTEGER NOT NULL CHECK (first_observed_at_ms BETWEEN 0 AND 9007199254740991),
  last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms BETWEEN first_observed_at_ms AND 9007199254740991),
  PRIMARY KEY (broker_route_id, channel_generation),
  CHECK ((route_kind IN ('scope_bus', 'server_control') AND logical_chat_id IS NULL) OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)),
  CHECK ((state = 'open' AND frame_count IS NULL AND next_generation IS NULL AND manifest_digest IS NULL) OR (state = 'sealed' AND frame_count = observed_next_frame_index AND next_generation = channel_generation + 1 AND manifest_digest IS NOT NULL)),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_ROUTE_FETCH_CURSORS_SQL = `CREATE TABLE broker_route_fetch_cursors (
  broker_route_id TEXT PRIMARY KEY NOT NULL,
  next_generation INTEGER NOT NULL CHECK (next_generation BETWEEN 0 AND 9007199254740991),
  next_frame_index INTEGER NOT NULL CHECK (next_frame_index BETWEEN 0 AND 4096),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_ROUTE_SEMANTIC_CURSORS_SQL = `CREATE TABLE broker_route_semantic_cursors (
  broker_route_id TEXT PRIMARY KEY NOT NULL,
  next_generation INTEGER NOT NULL CHECK (next_generation BETWEEN 0 AND 9007199254740991),
  next_frame_index INTEGER NOT NULL CHECK (next_frame_index BETWEEN 0 AND 4096),
  contiguous_through_generation INTEGER CHECK (contiguous_through_generation IS NULL OR contiguous_through_generation BETWEEN 0 AND 9007199254740991),
  contiguous_through_frame_index INTEGER CHECK (contiguous_through_frame_index IS NULL OR contiguous_through_frame_index BETWEEN 0 AND 4095),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((contiguous_through_generation IS NULL) = (contiguous_through_frame_index IS NULL)),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_ROUTE_GAPS_SQL = `CREATE TABLE broker_route_gaps (
  gap_id TEXT PRIMARY KEY NOT NULL,
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('semantic_collision', 'manifest_equivocation', 'position_equivocation', 'transport_collision', 'unknown_outbound', 'invalid_frame', 'storage_quota', 'outer_page_invalid')),
  stable_semantic_result_id TEXT CHECK (stable_semantic_result_id IS NULL OR (length(stable_semantic_result_id) = 47 AND substr(stable_semantic_result_id, 1, 4) = 'rrs_' AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  channel_position_observation_id TEXT CHECK (channel_position_observation_id IS NULL OR (length(channel_position_observation_id) = 47 AND substr(channel_position_observation_id, 1, 4) = 'rcp_' AND channel_position_observation_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  channel_generation INTEGER CHECK (channel_generation IS NULL OR channel_generation BETWEEN 0 AND 9007199254740991),
  manifest_equivocation_id TEXT,
  transport_key_collision_id TEXT,
  evidence_ref TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 43),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  opened_at_ms INTEGER NOT NULL CHECK (opened_at_ms BETWEEN 0 AND 9007199254740991),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms BETWEEN opened_at_ms AND 9007199254740991),
  recovery_id TEXT,
  CHECK ((route_kind IN ('scope_bus', 'server_control') AND logical_chat_id IS NULL) OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)),
  CHECK ((state = 'open' AND resolved_at_ms IS NULL AND recovery_id IS NULL) OR (state = 'resolved' AND resolved_at_ms IS NOT NULL AND recovery_id IS NOT NULL)),
  CHECK (
    (reason = 'semantic_collision' AND stable_semantic_result_id IS NOT NULL AND channel_position_observation_id IS NULL AND channel_generation IS NULL AND manifest_equivocation_id IS NULL AND transport_key_collision_id IS NULL)
    OR (reason = 'manifest_equivocation' AND stable_semantic_result_id IS NULL AND channel_position_observation_id IS NULL AND channel_generation IS NOT NULL AND manifest_equivocation_id IS NOT NULL AND transport_key_collision_id IS NULL)
    OR (reason = 'position_equivocation' AND stable_semantic_result_id IS NULL AND channel_position_observation_id IS NOT NULL AND channel_generation IS NULL AND manifest_equivocation_id IS NULL AND transport_key_collision_id IS NULL)
    OR (reason = 'transport_collision' AND stable_semantic_result_id IS NULL AND channel_position_observation_id IS NULL AND channel_generation IS NULL AND manifest_equivocation_id IS NULL AND transport_key_collision_id IS NOT NULL)
    OR (reason IN ('unknown_outbound', 'invalid_frame') AND stable_semantic_result_id IS NULL AND channel_position_observation_id IS NOT NULL AND channel_generation IS NULL AND manifest_equivocation_id IS NULL AND transport_key_collision_id IS NULL)
    OR (reason IN ('storage_quota', 'outer_page_invalid') AND stable_semantic_result_id IS NULL AND channel_position_observation_id IS NULL AND channel_generation IS NULL AND manifest_equivocation_id IS NULL AND transport_key_collision_id IS NULL)
  ),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (evidence_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_AUTHENTICATED_CHANNEL_POSITIONS_SQL = `CREATE TABLE authenticated_channel_positions (
  channel_position_observation_id TEXT PRIMARY KEY NOT NULL CHECK (length(channel_position_observation_id) = 47 AND substr(channel_position_observation_id, 1, 4) = 'rcp_' AND channel_position_observation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  channel_generation INTEGER NOT NULL CHECK (channel_generation BETWEEN 0 AND 9007199254740991),
  frame_index INTEGER NOT NULL CHECK (frame_index BETWEEN 0 AND 4095),
  claimed_delivery_attempt_id TEXT NOT NULL CHECK (length(claimed_delivery_attempt_id) = 26 AND substr(claimed_delivery_attempt_id, 1, 4) = 'rda_' AND claimed_delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  claimed_part INTEGER NOT NULL CHECK (claimed_part BETWEEN 0 AND 31),
  claimed_transport_frame_digest TEXT NOT NULL CHECK (length(claimed_transport_frame_digest) = 43),
  received_frame_ref TEXT NOT NULL,
  received_frame_digest TEXT NOT NULL CHECK (length(received_frame_digest) = 43),
  received_frame_byte_length INTEGER NOT NULL CHECK (received_frame_byte_length BETWEEN 0 AND 4450000),
  normalized_transport_frame_digest TEXT CHECK (normalized_transport_frame_digest IS NULL OR length(normalized_transport_frame_digest) = 43),
  frame_identity_id TEXT,
  frame_collaboration_server_id TEXT,
  frame_logical_chat_id TEXT,
  direction TEXT CHECK (direction IS NULL OR direction IN ('in', 'out')),
  record_kind TEXT,
  sequence INTEGER CHECK (sequence IS NULL OR sequence BETWEEN 0 AND 9007199254740991),
  message_id TEXT,
  delivery_attempt_id TEXT CHECK (delivery_attempt_id IS NULL OR (length(delivery_attempt_id) = 26 AND substr(delivery_attempt_id, 1, 4) = 'rda_' AND delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  client_message_id TEXT,
  key_epoch INTEGER CHECK (key_epoch IS NULL OR key_epoch = 0),
  part INTEGER CHECK (part IS NULL OR part BETWEEN 0 AND 31),
  parts INTEGER CHECK (parts IS NULL OR parts BETWEEN 1 AND 32),
  server_key_generation INTEGER CHECK (server_key_generation IS NULL OR server_key_generation BETWEEN 1 AND 9007199254740991),
  host_signer_identity_key_id TEXT,
  host_scope_certificate_id TEXT,
  host_signature_sequence INTEGER CHECK (host_signature_sequence IS NULL OR host_signature_sequence BETWEEN 0 AND 9007199254740991),
  stable_logical_header_digest TEXT CHECK (stable_logical_header_digest IS NULL OR length(stable_logical_header_digest) = 43),
  classification TEXT NOT NULL CHECK (classification IN ('pending_validation', 'inbound_ingress', 'known_host_output', 'unknown_outbound', 'invalid')),
  validation_failure_code TEXT,
  ingress_observation_id TEXT CHECK (ingress_observation_id IS NULL OR (length(ingress_observation_id) = 47 AND substr(ingress_observation_id, 1, 4) = 'rio_' AND ingress_observation_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  cursor_disposition TEXT NOT NULL CHECK (cursor_disposition IN ('blocked', 'advanceable')),
  recovery_id TEXT,
  gap_id TEXT,
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  classified_at_ms INTEGER CHECK (classified_at_ms IS NULL OR classified_at_ms BETWEEN observed_at_ms AND 9007199254740991),
  CHECK ((route_kind IN ('scope_bus', 'server_control') AND logical_chat_id IS NULL) OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)),
  CHECK (part IS NULL OR parts IS NULL OR part < parts),
  CHECK (normalized_transport_frame_digest IS NULL OR (
    normalized_transport_frame_digest = claimed_transport_frame_digest
    AND delivery_attempt_id = claimed_delivery_attempt_id AND part = claimed_part
  )),
  CHECK (
    (normalized_transport_frame_digest IS NULL
      AND frame_identity_id IS NULL AND frame_collaboration_server_id IS NULL
      AND frame_logical_chat_id IS NULL AND direction IS NULL AND record_kind IS NULL
      AND sequence IS NULL AND message_id IS NULL AND delivery_attempt_id IS NULL
      AND client_message_id IS NULL AND key_epoch IS NULL AND part IS NULL AND parts IS NULL
      AND server_key_generation IS NULL AND host_signer_identity_key_id IS NULL
      AND host_scope_certificate_id IS NULL AND host_signature_sequence IS NULL
      AND stable_logical_header_digest IS NULL)
    OR (normalized_transport_frame_digest IS NOT NULL
      AND frame_identity_id IS NOT NULL AND frame_collaboration_server_id IS NOT NULL
      AND direction IS NOT NULL AND record_kind IS NOT NULL AND message_id IS NOT NULL
      AND delivery_attempt_id IS NOT NULL AND key_epoch = 0 AND part IS NOT NULL
      AND parts IS NOT NULL AND stable_logical_header_digest IS NOT NULL)
  ),
  CHECK (
    (classification = 'pending_validation'
      AND normalized_transport_frame_digest IS NULL AND validation_failure_code IS NULL
      AND ingress_observation_id IS NULL AND cursor_disposition = 'blocked'
      AND recovery_id IS NULL AND gap_id IS NULL AND classified_at_ms IS NULL)
    OR (classification = 'inbound_ingress'
      AND normalized_transport_frame_digest IS NOT NULL AND direction = 'in'
      AND validation_failure_code IS NULL AND ingress_observation_id IS NOT NULL
      AND classified_at_ms IS NOT NULL
      AND ((gap_id IS NULL AND recovery_id IS NULL)
        OR (gap_id IS NULL AND cursor_disposition = 'advanceable' AND recovery_id IS NOT NULL)
        OR (gap_id IS NOT NULL AND cursor_disposition = 'blocked' AND recovery_id IS NULL)
        OR (gap_id IS NOT NULL AND cursor_disposition = 'advanceable' AND recovery_id IS NULL)
        OR (gap_id IS NOT NULL AND cursor_disposition = 'advanceable' AND recovery_id IS NOT NULL)))
    OR (classification = 'known_host_output'
      AND normalized_transport_frame_digest IS NOT NULL AND direction = 'out'
      AND validation_failure_code IS NULL AND ingress_observation_id IS NULL
      AND cursor_disposition = 'advanceable' AND recovery_id IS NULL AND gap_id IS NULL
      AND classified_at_ms IS NOT NULL)
    OR (classification = 'unknown_outbound'
      AND normalized_transport_frame_digest IS NOT NULL AND direction = 'out'
      AND validation_failure_code IS NULL AND ingress_observation_id IS NULL
      AND gap_id IS NOT NULL AND classified_at_ms IS NOT NULL
      AND ((cursor_disposition = 'blocked' AND recovery_id IS NULL)
        OR (cursor_disposition = 'advanceable' AND recovery_id IS NOT NULL)))
    OR (classification = 'invalid'
      AND validation_failure_code IS NOT NULL AND ingress_observation_id IS NULL
      AND cursor_disposition = 'advanceable' AND gap_id IS NOT NULL
      AND classified_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (received_frame_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_CHANNEL_POSITION_EQUIVOCATIONS_SQL = `CREATE TABLE channel_position_equivocations (
  position_equivocation_id TEXT PRIMARY KEY NOT NULL,
  channel_position_observation_id TEXT NOT NULL CHECK (length(channel_position_observation_id) = 47 AND substr(channel_position_observation_id, 1, 4) = 'rcp_' AND channel_position_observation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  accepted_frame_digest TEXT NOT NULL CHECK (length(accepted_frame_digest) = 43),
  conflicting_frame_digest TEXT NOT NULL CHECK (length(conflicting_frame_digest) = 43),
  conflicting_frame_ref TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (channel_position_observation_id) REFERENCES authenticated_channel_positions (channel_position_observation_id),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (conflicting_frame_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_CHANNEL_MANIFEST_EQUIVOCATIONS_SQL = `CREATE TABLE broker_channel_manifest_equivocations (
  manifest_equivocation_id TEXT PRIMARY KEY NOT NULL,
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  channel_generation INTEGER NOT NULL CHECK (channel_generation BETWEEN 0 AND 9007199254740991),
  accepted_manifest_digest TEXT CHECK (accepted_manifest_digest IS NULL OR length(accepted_manifest_digest) = 43),
  conflicting_manifest_digest TEXT CHECK (conflicting_manifest_digest IS NULL OR length(conflicting_manifest_digest) = 43),
  conflicting_frame_count INTEGER CHECK (conflicting_frame_count IS NULL OR conflicting_frame_count BETWEEN 0 AND 4096),
  conflicting_next_generation INTEGER CHECK (conflicting_next_generation IS NULL OR conflicting_next_generation BETWEEN 1 AND 9007199254740991),
  conflicting_state TEXT NOT NULL CHECK (conflicting_state IN ('open', 'sealed')),
  conflicting_observation_digest TEXT NOT NULL CHECK (length(conflicting_observation_digest) = 43),
  evidence_ref TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 43),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((conflicting_state = 'open' AND conflicting_manifest_digest IS NULL
    AND conflicting_frame_count IS NULL AND conflicting_next_generation IS NULL)
    OR (conflicting_state = 'sealed' AND conflicting_manifest_digest IS NOT NULL
      AND conflicting_frame_count IS NOT NULL
      AND conflicting_next_generation = channel_generation + 1)),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (evidence_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_TRANSPORT_KEY_COLLISIONS_SQL = `CREATE TABLE broker_transport_key_collisions (
  transport_key_collision_id TEXT PRIMARY KEY NOT NULL,
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  delivery_attempt_id TEXT NOT NULL CHECK (length(delivery_attempt_id) = 26 AND substr(delivery_attempt_id, 1, 4) = 'rda_' AND delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  part INTEGER NOT NULL CHECK (part BETWEEN 0 AND 31),
  original_channel_generation INTEGER NOT NULL CHECK (original_channel_generation BETWEEN 0 AND 9007199254740991),
  original_frame_index INTEGER NOT NULL CHECK (original_frame_index BETWEEN 0 AND 4095),
  original_transport_frame_digest TEXT NOT NULL CHECK (length(original_transport_frame_digest) = 43),
  conflicting_transport_frame_digest TEXT NOT NULL CHECK (length(conflicting_transport_frame_digest) = 43),
  conflicting_frame_ref TEXT NOT NULL,
  conflicting_frame_digest TEXT NOT NULL CHECK (length(conflicting_frame_digest) = 43),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (original_transport_frame_digest <> conflicting_transport_frame_digest),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (conflicting_frame_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_CHANNEL_POSITION_RECOVERIES_SQL = `CREATE TABLE channel_position_recoveries (
  recovery_id TEXT PRIMARY KEY NOT NULL,
  gap_id TEXT NOT NULL,
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('semantic_collision', 'manifest_equivocation', 'position_equivocation', 'transport_collision', 'unknown_outbound', 'invalid_frame', 'storage_quota', 'outer_page_invalid')),
  decision TEXT NOT NULL CHECK (decision IN ('discard_and_close_source', 'proved_safe_discard')),
  evidence_ref TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 43),
  coordinator_lease_id TEXT NOT NULL,
  coordinator_epoch INTEGER NOT NULL CHECK (coordinator_epoch BETWEEN 1 AND 9007199254740991),
  decided_at_ms INTEGER NOT NULL CHECK (decided_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (gap_id) REFERENCES broker_route_gaps (gap_id),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (evidence_ref) REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch) REFERENCES coordinator_leases (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
) STRICT, WITHOUT ROWID`;

const CREATE_AUTHENTICATED_INGRESS_RESULTS_SQL = `CREATE TABLE authenticated_ingress_results (
  stable_semantic_result_id TEXT PRIMARY KEY NOT NULL CHECK (length(stable_semantic_result_id) = 47 AND substr(stable_semantic_result_id, 1, 4) = 'rrs_' AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${INGRESS_SCOPE_CHECK},
  logical_chat_id TEXT,
  source_event_namespace_id TEXT NOT NULL CHECK (length(source_event_namespace_id) = 47 AND substr(source_event_namespace_id, 1, 4) = 'wns_' AND source_event_namespace_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  message_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  client_message_id TEXT,
  expected_parts INTEGER NOT NULL CHECK (expected_parts BETWEEN 1 AND 32),
  source_payload_schema_id TEXT,
  canonical_message_digest TEXT CHECK (canonical_message_digest IS NULL OR length(canonical_message_digest) = 43),
  source_event_fingerprint_schema_id TEXT CHECK (source_event_fingerprint_schema_id IS NULL OR source_event_fingerprint_schema_id = 'remote-claw/a1/source-event-fingerprint/v1'),
  source_event_fingerprint TEXT CHECK (source_event_fingerprint IS NULL OR length(source_event_fingerprint) = 43),
  accepted_delivery_attempt_id TEXT CHECK (accepted_delivery_attempt_id IS NULL OR (length(accepted_delivery_attempt_id) = 26 AND substr(accepted_delivery_attempt_id, 1, 4) = 'rda_' AND accepted_delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  first_ingress_generation INTEGER NOT NULL CHECK (first_ingress_generation BETWEEN 0 AND 9007199254740991),
  first_ingress_frame_index INTEGER NOT NULL CHECK (first_ingress_frame_index BETWEEN 0 AND 4095),
  last_observed_ingress_generation INTEGER NOT NULL CHECK (last_observed_ingress_generation BETWEEN 0 AND 9007199254740991),
  last_observed_ingress_frame_index INTEGER NOT NULL CHECK (last_observed_ingress_frame_index BETWEEN 0 AND 4095),
  assembly_deadline_ms INTEGER NOT NULL CHECK (assembly_deadline_ms BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('assembling', 'awaiting_order', 'quarantined_incomplete', 'quarantined_collision')),
  collision_at_ms INTEGER CHECK (collision_at_ms IS NULL OR collision_at_ms BETWEEN 0 AND 9007199254740991),
  terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((route_kind = 'server_control' AND logical_chat_id IS NULL) OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)),
  CHECK ((route_kind = 'server_control' AND record_kind = 'new_chat' AND client_message_id IS NOT NULL) OR (route_kind = 'chat' AND record_kind = 'user' AND client_message_id IS NOT NULL)),
  CHECK (first_ingress_generation < last_observed_ingress_generation
    OR (first_ingress_generation = last_observed_ingress_generation
      AND first_ingress_frame_index <= last_observed_ingress_frame_index)),
  CHECK (
    (state = 'assembling' AND source_payload_schema_id IS NULL
      AND canonical_message_digest IS NULL AND source_event_fingerprint_schema_id IS NULL
      AND source_event_fingerprint IS NULL AND accepted_delivery_attempt_id IS NULL
      AND collision_at_ms IS NULL AND terminal_at_ms IS NULL)
    OR (state = 'awaiting_order' AND source_payload_schema_id IS NOT NULL
      AND canonical_message_digest IS NOT NULL
      AND source_event_fingerprint_schema_id = 'remote-claw/a1/source-event-fingerprint/v1'
      AND source_event_fingerprint IS NOT NULL AND accepted_delivery_attempt_id IS NOT NULL
      AND collision_at_ms IS NULL
      AND terminal_at_ms IS NULL)
    OR (state = 'quarantined_incomplete' AND source_payload_schema_id IS NULL
      AND canonical_message_digest IS NULL AND source_event_fingerprint_schema_id IS NULL
      AND source_event_fingerprint IS NULL AND accepted_delivery_attempt_id IS NULL
      AND collision_at_ms IS NULL AND terminal_at_ms IS NOT NULL)
    OR (state = 'quarantined_collision' AND collision_at_ms IS NOT NULL
      AND terminal_at_ms IS NOT NULL
      AND ((source_payload_schema_id IS NULL AND canonical_message_digest IS NULL
        AND source_event_fingerprint_schema_id IS NULL AND source_event_fingerprint IS NULL
        AND accepted_delivery_attempt_id IS NULL)
        OR (source_payload_schema_id IS NOT NULL AND canonical_message_digest IS NOT NULL
          AND source_event_fingerprint_schema_id = 'remote-claw/a1/source-event-fingerprint/v1'
          AND source_event_fingerprint IS NOT NULL AND accepted_delivery_attempt_id IS NOT NULL)))
  ),
  CHECK (source_payload_schema_id IS NULL OR
    (record_kind = 'user' AND source_payload_schema_id = 'remote-claw/a1-ingress-user/v1') OR
    (record_kind = 'new_chat' AND source_payload_schema_id = 'remote-claw/a1-ingress-new-chat/v1')),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (broker_route_id, stable_semantic_result_id, accepted_delivery_attempt_id)
    REFERENCES ingress_delivery_candidates (broker_route_id, stable_semantic_result_id, delivery_attempt_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_INGRESS_TRANSPORT_ATTEMPTS_SQL = `CREATE TABLE ingress_transport_attempts (
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${INGRESS_SCOPE_CHECK},
  logical_chat_id TEXT,
  delivery_attempt_id TEXT NOT NULL CHECK (length(delivery_attempt_id) = 26 AND substr(delivery_attempt_id, 1, 4) = 'rda_' AND delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  source_event_namespace_id TEXT NOT NULL CHECK (length(source_event_namespace_id) = 47 AND substr(source_event_namespace_id, 1, 4) = 'wns_' AND source_event_namespace_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  stable_semantic_result_id TEXT NOT NULL CHECK (length(stable_semantic_result_id) = 47 AND substr(stable_semantic_result_id, 1, 4) = 'rrs_' AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  message_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  client_message_id TEXT,
  stable_logical_header_digest TEXT NOT NULL CHECK (length(stable_logical_header_digest) = 43),
  expected_parts INTEGER NOT NULL CHECK (expected_parts BETWEEN 1 AND 32),
  binding_disposition TEXT NOT NULL CHECK (binding_disposition IN ('exact', 'collision')),
  collision_gap_id TEXT,
  candidate_required_result_id TEXT,
  PRIMARY KEY (broker_route_id, delivery_attempt_id),
  CHECK ((binding_disposition = 'exact' AND collision_gap_id IS NULL
      AND candidate_required_result_id = stable_semantic_result_id)
    OR (binding_disposition = 'collision' AND collision_gap_id IS NOT NULL
      AND candidate_required_result_id IS NULL)),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (stable_semantic_result_id) REFERENCES authenticated_ingress_results (stable_semantic_result_id),
  FOREIGN KEY (collision_gap_id) REFERENCES broker_route_gaps (gap_id),
  FOREIGN KEY (broker_route_id, candidate_required_result_id, delivery_attempt_id)
    REFERENCES ingress_delivery_candidates (broker_route_id, stable_semantic_result_id, delivery_attempt_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_INGRESS_DELIVERY_CANDIDATES_SQL = `CREATE TABLE ingress_delivery_candidates (
  stable_semantic_result_id TEXT NOT NULL CHECK (length(stable_semantic_result_id) = 47 AND substr(stable_semantic_result_id, 1, 4) = 'rrs_' AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  delivery_attempt_id TEXT NOT NULL CHECK (length(delivery_attempt_id) = 26 AND substr(delivery_attempt_id, 1, 4) = 'rda_' AND delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${INGRESS_SCOPE_CHECK},
  logical_chat_id TEXT,
  expected_parts INTEGER NOT NULL CHECK (expected_parts BETWEEN 1 AND 32),
  received_parts INTEGER NOT NULL CHECK (received_parts BETWEEN 0 AND expected_parts),
  plaintext_byte_count INTEGER NOT NULL CHECK (plaintext_byte_count BETWEEN 0 AND 50331648),
  first_ingress_generation INTEGER NOT NULL CHECK (first_ingress_generation BETWEEN 0 AND 9007199254740991),
  first_ingress_frame_index INTEGER NOT NULL CHECK (first_ingress_frame_index BETWEEN 0 AND 4095),
  last_observed_ingress_generation INTEGER NOT NULL CHECK (last_observed_ingress_generation BETWEEN 0 AND 9007199254740991),
  last_observed_ingress_frame_index INTEGER NOT NULL CHECK (last_observed_ingress_frame_index BETWEEN 0 AND 4095),
  state TEXT NOT NULL CHECK (state IN ('assembling', 'complete', 'expired', 'collision')),
  PRIMARY KEY (broker_route_id, stable_semantic_result_id, delivery_attempt_id),
  CHECK ((state = 'complete' AND received_parts = expected_parts)
    OR (state = 'assembling' AND received_parts < expected_parts)
    OR state IN ('expired', 'collision')),
  CHECK (first_ingress_generation < last_observed_ingress_generation
    OR (first_ingress_generation = last_observed_ingress_generation
      AND first_ingress_frame_index <= last_observed_ingress_frame_index)),
  FOREIGN KEY (broker_route_id, delivery_attempt_id) REFERENCES ingress_transport_attempts (broker_route_id, delivery_attempt_id),
  FOREIGN KEY (stable_semantic_result_id) REFERENCES authenticated_ingress_results (stable_semantic_result_id)
) STRICT, WITHOUT ROWID`;

const CREATE_AUTHENTICATED_INGRESS_PARTS_SQL = `CREATE TABLE authenticated_ingress_parts (
  stable_semantic_result_id TEXT NOT NULL CHECK (length(stable_semantic_result_id) = 47 AND substr(stable_semantic_result_id, 1, 4) = 'rrs_' AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  delivery_attempt_id TEXT NOT NULL CHECK (length(delivery_attempt_id) = 26 AND substr(delivery_attempt_id, 1, 4) = 'rda_' AND delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  part INTEGER NOT NULL CHECK (part BETWEEN 0 AND 31),
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${INGRESS_SCOPE_CHECK},
  logical_chat_id TEXT,
  parts INTEGER NOT NULL CHECK (parts BETWEEN 1 AND 32 AND part < parts),
  authenticated_part_digest TEXT NOT NULL CHECK (length(authenticated_part_digest) = 43),
  plaintext_part_ref TEXT NOT NULL,
  plaintext_part_digest TEXT NOT NULL CHECK (length(plaintext_part_digest) = 43),
  plaintext_part_byte_length INTEGER NOT NULL CHECK (plaintext_part_byte_length BETWEEN 0 AND 3299983),
  first_ingress_generation INTEGER NOT NULL CHECK (first_ingress_generation BETWEEN 0 AND 9007199254740991),
  first_ingress_frame_index INTEGER NOT NULL CHECK (first_ingress_frame_index BETWEEN 0 AND 4095),
  PRIMARY KEY (broker_route_id, stable_semantic_result_id, delivery_attempt_id, part),
  FOREIGN KEY (broker_route_id, stable_semantic_result_id, delivery_attempt_id) REFERENCES ingress_delivery_candidates (broker_route_id, stable_semantic_result_id, delivery_attempt_id),
  FOREIGN KEY (plaintext_part_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_AUTHENTICATED_INGRESS_OBSERVATIONS_SQL = `CREATE TABLE authenticated_ingress_observations (
  ingress_observation_id TEXT PRIMARY KEY NOT NULL CHECK (length(ingress_observation_id) = 47 AND substr(ingress_observation_id, 1, 4) = 'rio_' AND ingress_observation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  channel_position_observation_id TEXT NOT NULL CHECK (length(channel_position_observation_id) = 47 AND substr(channel_position_observation_id, 1, 4) = 'rcp_' AND channel_position_observation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  stable_semantic_result_id TEXT NOT NULL CHECK (length(stable_semantic_result_id) = 47 AND substr(stable_semantic_result_id, 1, 4) = 'rrs_' AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  delivery_attempt_id TEXT NOT NULL CHECK (length(delivery_attempt_id) = 26 AND substr(delivery_attempt_id, 1, 4) = 'rda_' AND delivery_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${INGRESS_SCOPE_CHECK},
  logical_chat_id TEXT,
  channel_generation INTEGER NOT NULL CHECK (channel_generation BETWEEN 0 AND 9007199254740991),
  frame_index INTEGER NOT NULL CHECK (frame_index BETWEEN 0 AND 4095),
  part INTEGER NOT NULL CHECK (part BETWEEN 0 AND 31),
  parts INTEGER NOT NULL CHECK (parts BETWEEN 1 AND 32 AND part < parts),
  authenticated_part_digest TEXT NOT NULL CHECK (length(authenticated_part_digest) = 43),
  plaintext_evidence_ref TEXT NOT NULL,
  plaintext_evidence_digest TEXT NOT NULL CHECK (length(plaintext_evidence_digest) = 43),
  plaintext_evidence_byte_length INTEGER NOT NULL CHECK (plaintext_evidence_byte_length BETWEEN 0 AND 3299983),
  disposition TEXT NOT NULL CHECK (disposition IN ('new_part', 'exact_duplicate_part', 'exact_transport_retry', 'completed_exact_replay', 'collision', 'invalid_payload', 'late_after_tombstone')),
  cursor_disposition TEXT NOT NULL CHECK (cursor_disposition IN ('blocked', 'advanceable')),
  gap_id TEXT,
  recovery_id TEXT,
  CHECK ((disposition = 'collision' AND gap_id IS NOT NULL
      AND ((cursor_disposition = 'blocked' AND recovery_id IS NULL)
        OR (cursor_disposition = 'advanceable' AND recovery_id IS NOT NULL)))
    OR (disposition = 'late_after_tombstone'
      AND ((cursor_disposition = 'advanceable' AND gap_id IS NULL AND recovery_id IS NULL)
        OR (cursor_disposition = 'blocked' AND gap_id IS NOT NULL AND recovery_id IS NULL)
        OR (cursor_disposition = 'advanceable' AND gap_id IS NOT NULL AND recovery_id IS NOT NULL)))
    OR (disposition = 'invalid_payload' AND cursor_disposition = 'advanceable'
      AND gap_id IS NOT NULL AND recovery_id IS NULL)
    OR (disposition NOT IN ('collision', 'invalid_payload', 'late_after_tombstone')
      AND ((gap_id IS NULL AND recovery_id IS NULL)
        OR (cursor_disposition = 'advanceable' AND gap_id IS NULL AND recovery_id IS NOT NULL)))),
  FOREIGN KEY (channel_position_observation_id) REFERENCES authenticated_channel_positions (channel_position_observation_id),
  FOREIGN KEY (stable_semantic_result_id) REFERENCES authenticated_ingress_results (stable_semantic_result_id),
  FOREIGN KEY (gap_id) REFERENCES broker_route_gaps (gap_id),
  FOREIGN KEY (plaintext_evidence_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_ROUTE_ACTORS_SQL = `CREATE TABLE broker_route_actors (
  broker_route_id TEXT PRIMARY KEY NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  claim_token TEXT,
  coordinator_lease_id TEXT,
  coordinator_epoch INTEGER CHECK (coordinator_epoch IS NULL OR coordinator_epoch BETWEEN 1 AND 9007199254740991),
  claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR claimed_at_ms BETWEEN 0 AND 9007199254740991),
  last_operation_id TEXT,
  last_operation_kind TEXT,
  last_operation_digest TEXT CHECK (last_operation_digest IS NULL OR length(last_operation_digest) = 43),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((route_kind IN ('scope_bus', 'server_control') AND logical_chat_id IS NULL) OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)),
  CHECK ((claim_token IS NULL AND coordinator_lease_id IS NULL AND coordinator_epoch IS NULL AND claimed_at_ms IS NULL) OR (claim_token IS NOT NULL AND coordinator_lease_id IS NOT NULL AND coordinator_epoch IS NOT NULL AND claimed_at_ms IS NOT NULL)),
  CHECK ((last_operation_id IS NULL AND last_operation_kind IS NULL AND last_operation_digest IS NULL) OR (last_operation_id IS NOT NULL AND last_operation_kind IS NOT NULL AND last_operation_digest IS NOT NULL)),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch) REFERENCES coordinator_leases (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_READ_PAGE_OBSERVATIONS_SQL = `CREATE TABLE broker_read_page_observations (
  read_page_observation_id TEXT PRIMARY KEY NOT NULL,
  broker_route_id TEXT NOT NULL,
  route_store_instance_id TEXT NOT NULL CHECK (length(route_store_instance_id) = 27 AND substr(route_store_instance_id, 1, 5) = 'rbsi_' AND route_store_instance_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  requested_generation INTEGER NOT NULL CHECK (requested_generation BETWEEN 0 AND 9007199254740991),
  requested_frame_index INTEGER NOT NULL CHECK (requested_frame_index BETWEEN 0 AND 4096),
  next_generation INTEGER NOT NULL CHECK (next_generation BETWEEN 0 AND 9007199254740991),
  next_frame_index INTEGER NOT NULL CHECK (next_frame_index BETWEEN 0 AND 4096),
  generation_state TEXT NOT NULL CHECK (generation_state IN ('open', 'sealed')),
  generation_frame_count INTEGER CHECK (generation_frame_count IS NULL OR generation_frame_count BETWEEN 0 AND 4096),
  generation_next_generation INTEGER CHECK (generation_next_generation IS NULL OR generation_next_generation BETWEEN 1 AND 9007199254740991),
  generation_manifest_digest TEXT CHECK (generation_manifest_digest IS NULL OR length(generation_manifest_digest) = 43),
  observed_next_frame_index INTEGER NOT NULL CHECK (observed_next_frame_index BETWEEN 0 AND 4096),
  frame_count_in_page INTEGER NOT NULL CHECK (frame_count_in_page BETWEEN 0 AND 64),
  frame_claims_digest TEXT NOT NULL CHECK (length(frame_claims_digest) = 43),
  at_live_tail INTEGER NOT NULL CHECK (at_live_tail IN (0, 1)),
  operation_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 43),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((route_kind IN ('scope_bus', 'server_control') AND logical_chat_id IS NULL) OR (route_kind = 'chat' AND logical_chat_id IS NOT NULL)),
  CHECK ((generation_state = 'open' AND generation_frame_count IS NULL
      AND generation_next_generation IS NULL AND generation_manifest_digest IS NULL)
    OR (generation_state = 'sealed' AND generation_frame_count IS NOT NULL
      AND generation_next_generation = requested_generation + 1
      AND generation_manifest_digest IS NOT NULL)),
  CHECK ((next_generation = requested_generation AND next_frame_index >= requested_frame_index)
    OR (generation_state = 'sealed' AND next_generation = requested_generation + 1
      AND next_frame_index = 0)),
  CHECK ((next_generation = requested_generation
      AND next_frame_index = requested_frame_index + frame_count_in_page)
    OR (next_generation = requested_generation + 1
      AND generation_frame_count = requested_frame_index + frame_count_in_page)),
  CHECK (observed_next_frame_index >= requested_frame_index + frame_count_in_page),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (evidence_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_BROKER_READ_PAGE_FRAME_EVIDENCE_SQL = `CREATE TABLE broker_read_page_frame_evidence (
  read_page_observation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  broker_route_id TEXT NOT NULL,
  collaboration_server_id TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK ${SCOPE_CHECK},
  logical_chat_id TEXT,
  channel_position_observation_id TEXT NOT NULL CHECK (length(channel_position_observation_id) = 47 AND substr(channel_position_observation_id, 1, 4) = 'rcp_'),
  channel_generation INTEGER NOT NULL CHECK (channel_generation BETWEEN 0 AND 9007199254740991),
  frame_index INTEGER NOT NULL CHECK (frame_index BETWEEN 0 AND 4095),
  claimed_delivery_attempt_id TEXT NOT NULL CHECK (length(claimed_delivery_attempt_id) = 26 AND substr(claimed_delivery_attempt_id, 1, 4) = 'rda_'),
  claimed_part INTEGER NOT NULL CHECK (claimed_part BETWEEN 0 AND 31),
  claimed_transport_frame_digest TEXT NOT NULL CHECK (length(claimed_transport_frame_digest) = 43),
  received_frame_ref TEXT NOT NULL,
  received_frame_digest TEXT NOT NULL CHECK (length(received_frame_digest) = 43),
  received_frame_byte_length INTEGER NOT NULL CHECK (received_frame_byte_length BETWEEN 0 AND 4450000),
  PRIMARY KEY (read_page_observation_id, ordinal),
  FOREIGN KEY (read_page_observation_id) REFERENCES broker_read_page_observations (read_page_observation_id),
  FOREIGN KEY (broker_route_id) REFERENCES broker_routes (broker_route_id),
  FOREIGN KEY (received_frame_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_POSITIONS_CURSOR_INDEX_SQL = `CREATE UNIQUE INDEX authenticated_channel_positions_cursor_unique
ON authenticated_channel_positions (broker_route_id, channel_generation, frame_index)`;
const CREATE_POSITIONS_PENDING_INDEX_SQL = `CREATE INDEX authenticated_channel_positions_pending
ON authenticated_channel_positions (broker_route_id, classification, channel_generation, frame_index)`;
const CREATE_POSITIONS_DISPOSITION_INDEX_SQL = `CREATE INDEX authenticated_channel_positions_disposition
ON authenticated_channel_positions (broker_route_id, cursor_disposition, channel_generation, frame_index)`;
const CREATE_GAPS_STATE_INDEX_SQL = `CREATE INDEX broker_route_gaps_state
ON broker_route_gaps (broker_route_id, state)`;
const CREATE_RESULTS_SEMANTIC_INDEX_SQL = `CREATE UNIQUE INDEX authenticated_ingress_results_semantic_unique
ON authenticated_ingress_results (broker_route_id, source_event_namespace_id, message_id)`;
const CREATE_RESULTS_ORDER_INDEX_SQL = `CREATE INDEX authenticated_ingress_results_state_order
ON authenticated_ingress_results (broker_route_id, state, first_ingress_generation, first_ingress_frame_index)`;
const CREATE_CANDIDATES_RESULT_ATTEMPT_INDEX_SQL = `CREATE UNIQUE INDEX ingress_delivery_candidates_result_attempt_unique
ON ingress_delivery_candidates (stable_semantic_result_id, delivery_attempt_id)`;
const CREATE_PARTS_RESULT_ATTEMPT_INDEX_SQL = `CREATE INDEX authenticated_ingress_parts_result_attempt
ON authenticated_ingress_parts (stable_semantic_result_id, delivery_attempt_id, part)`;
const CREATE_OBSERVATIONS_POSITION_INDEX_SQL = `CREATE UNIQUE INDEX authenticated_ingress_observations_position_unique
ON authenticated_ingress_observations (channel_position_observation_id)`;
const CREATE_OBSERVATIONS_CANDIDATE_INDEX_SQL = `CREATE INDEX authenticated_ingress_observations_candidate
ON authenticated_ingress_observations (stable_semantic_result_id, delivery_attempt_id)`;
const CREATE_MANIFEST_EQUIVOCATIONS_ROUTE_INDEX_SQL = `CREATE INDEX broker_channel_manifest_equivocations_route_generation
ON broker_channel_manifest_equivocations (broker_route_id, channel_generation)`;
const CREATE_TRANSPORT_COLLISIONS_KEY_INDEX_SQL = `CREATE UNIQUE INDEX broker_transport_key_collisions_key_unique
ON broker_transport_key_collisions (broker_route_id, delivery_attempt_id, part, conflicting_transport_frame_digest)`;
const CREATE_RECOVERIES_GAP_INDEX_SQL = `CREATE UNIQUE INDEX channel_position_recoveries_gap_unique
ON channel_position_recoveries (gap_id)`;
const CREATE_READ_PAGES_ROUTE_INDEX_SQL = `CREATE INDEX broker_read_page_observations_route_position
ON broker_read_page_observations (
  broker_route_id, requested_generation, requested_frame_index, observed_at_ms
)`;

const CREATE_BROKER_ROUTES_SEED_INGRESS_TRIGGER_SQL = `CREATE TRIGGER broker_routes_seed_durable_ingress
AFTER INSERT ON broker_routes
BEGIN
  INSERT INTO broker_route_runtime_status (
    broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
    machine_identity_id, state, current_channel_generation, active_gap_count, updated_at_ms
  ) VALUES (
    NEW.broker_route_id, NEW.collaboration_server_id, NEW.route_kind, NEW.logical_chat_id,
    NEW.machine_identity_id, 'current', 0, 0, NEW.created_at_ms
  );
  INSERT INTO broker_route_fetch_cursors (
    broker_route_id, next_generation, next_frame_index, revision, updated_at_ms
  ) VALUES (NEW.broker_route_id, 0, 0, 0, NEW.created_at_ms);
  INSERT INTO broker_route_semantic_cursors (
    broker_route_id, next_generation, next_frame_index,
    contiguous_through_generation, contiguous_through_frame_index, revision, updated_at_ms
  ) VALUES (NEW.broker_route_id, 0, 0, NULL, NULL, 0, NEW.created_at_ms);
  INSERT INTO broker_route_actors (
    broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
    revision, claim_token, coordinator_lease_id, coordinator_epoch, claimed_at_ms,
    last_operation_id, last_operation_kind, last_operation_digest, updated_at_ms
  ) VALUES (
    NEW.broker_route_id, NEW.collaboration_server_id, NEW.route_kind, NEW.logical_chat_id,
    0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NEW.created_at_ms
  );
END`;

const CREATE_BROKER_GENERATIONS_SEED_OBSERVATION_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generations_seed_observation
AFTER INSERT ON broker_channel_generations
WHEN NOT EXISTS (
  SELECT 1 FROM broker_channel_generation_observations
   WHERE broker_route_id = NEW.broker_route_id
     AND channel_generation = NEW.channel_generation
)
BEGIN
  INSERT INTO broker_channel_generation_observations (
    broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
    channel_generation, state, observed_next_frame_index, frame_count,
    next_generation, manifest_digest, first_observed_at_ms, last_observed_at_ms
  )
  SELECT route.broker_route_id, route.collaboration_server_id, route.route_kind,
         route.logical_chat_id, NEW.channel_generation, NEW.state,
         COALESCE(NEW.frame_count, 0), NEW.frame_count, NEW.next_generation,
         NEW.manifest_digest, route.created_at_ms, route.created_at_ms
    FROM broker_routes AS route
   WHERE route.broker_route_id = NEW.broker_route_id;
END`;

const SCOPED_TABLES = Object.freeze([
  "broker_route_runtime_status",
  "broker_channel_generation_observations",
  "broker_route_gaps",
  "authenticated_channel_positions",
  "channel_position_equivocations",
  "broker_channel_manifest_equivocations",
  "broker_transport_key_collisions",
  "channel_position_recoveries",
  "authenticated_ingress_results",
  "ingress_transport_attempts",
  "ingress_delivery_candidates",
  "authenticated_ingress_parts",
  "authenticated_ingress_observations",
  "broker_route_actors",
  "broker_read_page_observations",
  "broker_read_page_frame_evidence",
] as const);

function routeScopeTrigger(
  tableName: (typeof SCOPED_TABLES)[number],
  event: "INSERT" | "UPDATE",
): HostStateSqliteSchemaEntry {
  const suffix = event.toLowerCase();
  const machineClause =
    tableName === "broker_route_runtime_status"
      ? "AND route.machine_identity_id = NEW.machine_identity_id"
      : "";
  const routeStoreClause =
    tableName === "broker_read_page_observations"
      ? "AND route.broker_route_store_instance_id = NEW.route_store_instance_id"
      : "";
  const sql = `CREATE TRIGGER ${tableName}_require_exact_route_scope_${suffix}
BEFORE ${event} ON ${tableName}
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM broker_routes AS route
     WHERE route.broker_route_id = NEW.broker_route_id
       AND route.collaboration_server_id = NEW.collaboration_server_id
       AND route.route_kind = NEW.route_kind
       AND route.logical_chat_id IS NEW.logical_chat_id
       ${machineClause}
       ${routeStoreClause}
  ) THEN RAISE(ABORT, '${tableName} requires its exact broker route scope') END;
END`;
  return schemaEntry("trigger", `${tableName}_require_exact_route_scope_${suffix}`, tableName, sql);
}

const ACTOR_GUARDED_INSERT_TABLES = Object.freeze([
  "broker_route_gaps",
  "authenticated_channel_positions",
  "channel_position_equivocations",
  "broker_channel_manifest_equivocations",
  "broker_transport_key_collisions",
  "channel_position_recoveries",
  "authenticated_ingress_results",
  "ingress_transport_attempts",
  "ingress_delivery_candidates",
  "authenticated_ingress_parts",
  "authenticated_ingress_observations",
  "broker_read_page_observations",
  "broker_read_page_frame_evidence",
] as const);

const ACTOR_GUARDED_UPDATE_TABLES = Object.freeze([
  "broker_route_runtime_status",
  "broker_channel_generation_observations",
  "broker_route_fetch_cursors",
  "broker_route_semantic_cursors",
  "broker_route_gaps",
  "authenticated_channel_positions",
  "authenticated_ingress_results",
  "ingress_delivery_candidates",
  "authenticated_ingress_observations",
] as const);

function currentActorTrigger(
  tableName:
    | (typeof ACTOR_GUARDED_INSERT_TABLES)[number]
    | (typeof ACTOR_GUARDED_UPDATE_TABLES)[number],
  event: "INSERT" | "UPDATE",
): HostStateSqliteSchemaEntry {
  const suffix = event.toLowerCase();
  const sql = `CREATE TRIGGER ${tableName}_require_current_actor_${suffix}
BEFORE ${event} ON ${tableName}
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM broker_route_actors AS actor
      JOIN broker_routes AS route ON route.broker_route_id = actor.broker_route_id
      JOIN collaboration_servers AS server
        ON server.collaboration_server_id = route.collaboration_server_id
      JOIN coordinator_leases AS lease
        ON lease.coordinator_lease_id = actor.coordinator_lease_id
       AND lease.collaboration_server_id = route.collaboration_server_id
       AND lease.coordinator_epoch = actor.coordinator_epoch
     WHERE actor.broker_route_id = ${event === "INSERT" ? "NEW" : "OLD"}.broker_route_id
       AND actor.claim_token IS NOT NULL
       AND actor.coordinator_lease_id = server.current_coordinator_lease_id
       AND actor.coordinator_epoch = server.current_coordinator_epoch
       AND lease.state = 'current' AND lease.released_at_ms IS NULL
       AND lease.acquired_at_ms <= actor.claimed_at_ms
       AND actor.claimed_at_ms < lease.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, '${tableName} requires its current claimed coordinator actor') END;
END`;
  return schemaEntry("trigger", `${tableName}_require_current_actor_${suffix}`, tableName, sql);
}

const APPEND_ONLY_TABLE_KEYS = Object.freeze([
  ["channel_position_equivocations", "position_equivocation_id"],
  ["broker_channel_manifest_equivocations", "manifest_equivocation_id"],
  ["broker_transport_key_collisions", "transport_key_collision_id"],
  ["channel_position_recoveries", "recovery_id"],
  ["ingress_transport_attempts", "broker_route_id = NEW.broker_route_id AND delivery_attempt_id"],
  [
    "authenticated_ingress_parts",
    "broker_route_id = NEW.broker_route_id AND stable_semantic_result_id = NEW.stable_semantic_result_id AND delivery_attempt_id = NEW.delivery_attempt_id AND part",
  ],
  ["broker_read_page_observations", "read_page_observation_id"],
  [
    "broker_read_page_frame_evidence",
    "read_page_observation_id = NEW.read_page_observation_id AND ordinal",
  ],
] as const);

function appendOnlyTriggers(
  tableName: (typeof APPEND_ONLY_TABLE_KEYS)[number][0],
  keyExpression: string,
): readonly HostStateSqliteSchemaEntry[] {
  const keyPredicate = keyExpression.includes("=")
    ? `${keyExpression} = NEW.${keyExpression.slice(keyExpression.lastIndexOf(" ") + 1)}`
    : `${keyExpression} = NEW.${keyExpression}`;
  const updateSql = `CREATE TRIGGER ${tableName}_no_update
BEFORE UPDATE ON ${tableName}
BEGIN
  SELECT RAISE(ABORT, '${tableName} is append-only');
END`;
  const deleteSql = `CREATE TRIGGER ${tableName}_no_delete
BEFORE DELETE ON ${tableName}
BEGIN
  SELECT RAISE(ABORT, '${tableName} is retained');
END`;
  const replaceSql = `CREATE TRIGGER ${tableName}_no_replace
BEFORE INSERT ON ${tableName}
WHEN EXISTS (SELECT 1 FROM ${tableName} WHERE ${keyPredicate})
BEGIN
  SELECT RAISE(ABORT, '${tableName} is append-only');
END`;
  return Object.freeze([
    schemaEntry("trigger", `${tableName}_no_update`, tableName, updateSql),
    schemaEntry("trigger", `${tableName}_no_delete`, tableName, deleteSql),
    schemaEntry("trigger", `${tableName}_no_replace`, tableName, replaceSql),
  ]);
}

const CREATE_POSITIONS_REQUIRE_ARTIFACT_TRIGGER_SQL = `CREATE TRIGGER authenticated_channel_positions_require_exact_artifact
BEFORE INSERT ON authenticated_channel_positions
BEGIN
  SELECT CASE WHEN NEW.classification <> 'pending_validation'
    OR NEW.normalized_transport_frame_digest IS NOT NULL
    OR NEW.frame_identity_id IS NOT NULL OR NEW.frame_collaboration_server_id IS NOT NULL
    OR NEW.frame_logical_chat_id IS NOT NULL OR NEW.direction IS NOT NULL
    OR NEW.record_kind IS NOT NULL OR NEW.sequence IS NOT NULL OR NEW.message_id IS NOT NULL
    OR NEW.delivery_attempt_id IS NOT NULL OR NEW.client_message_id IS NOT NULL
    OR NEW.key_epoch IS NOT NULL OR NEW.part IS NOT NULL OR NEW.parts IS NOT NULL
    OR NEW.server_key_generation IS NOT NULL OR NEW.host_signer_identity_key_id IS NOT NULL
    OR NEW.host_scope_certificate_id IS NOT NULL OR NEW.host_signature_sequence IS NOT NULL
    OR NEW.stable_logical_header_digest IS NOT NULL OR NEW.validation_failure_code IS NOT NULL
    OR NEW.ingress_observation_id IS NOT NULL OR NEW.cursor_disposition <> 'blocked'
    OR NEW.recovery_id IS NOT NULL OR NEW.gap_id IS NOT NULL OR NEW.classified_at_ms IS NOT NULL
  THEN RAISE(ABORT, 'channel position must begin as exact pending outer evidence') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
     WHERE artifact.protected_handle_id = NEW.received_frame_ref
       AND artifact.kind = 'artifact'
       AND artifact.scope_kind = 'collaboration_server'
       AND artifact.scope_id = NEW.collaboration_server_id
       AND artifact.artifact_schema_id = 'remote-claw/a1/received-frame/v1'
       AND artifact.artifact_digest = NEW.received_frame_digest
       AND artifact.byte_length = NEW.received_frame_byte_length
  ) THEN RAISE(ABORT, 'channel position requires its exact received-frame artifact') END;
END`;

const CREATE_GAPS_REQUIRE_ARTIFACT_TRIGGER_SQL = `CREATE TRIGGER broker_route_gaps_require_exact_artifact
BEFORE INSERT ON broker_route_gaps
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
     WHERE artifact.protected_handle_id = NEW.evidence_ref
       AND artifact.kind = 'artifact'
       AND artifact.scope_kind = 'collaboration_server'
       AND artifact.scope_id = NEW.collaboration_server_id
       AND (
         (NEW.reason = 'manifest_equivocation'
           AND artifact.artifact_schema_id = 'remote-claw/a1/read-page-evidence/v1')
         OR (NEW.reason IN ('semantic_collision', 'position_equivocation', 'transport_collision')
           AND artifact.artifact_schema_id = 'remote-claw/a1/received-frame/v1')
         OR (NEW.reason = 'invalid_frame' AND artifact.artifact_schema_id IN (
           'remote-claw/a1/received-frame/v1', 'remote-claw/a1/ingress-gap-evidence/v1'
         ))
         OR (NEW.reason IN ('unknown_outbound', 'storage_quota')
           AND artifact.artifact_schema_id = 'remote-claw/a1/ingress-gap-evidence/v1')
         OR (NEW.reason = 'outer_page_invalid' AND artifact.artifact_schema_id IN (
           'remote-claw/a1/ingress-gap-evidence/v1', 'remote-claw/a1/read-page-evidence/v1'
         ))
       )
       AND artifact.artifact_digest = NEW.evidence_digest
  ) THEN RAISE(ABORT, 'broker route gap requires its exact scoped evidence artifact') END;
END`;

function exactArtifactTrigger(
  tableName:
    | "channel_position_equivocations"
    | "broker_channel_manifest_equivocations"
    | "broker_transport_key_collisions"
    | "channel_position_recoveries"
    | "authenticated_ingress_parts",
  refColumn: string,
  digestColumn: string,
  schemaId: string,
  lengthColumn?: string,
): HostStateSqliteSchemaEntry {
  const lengthClause =
    lengthColumn === undefined ? "" : `AND artifact.byte_length = NEW.${lengthColumn}`;
  const sql = `CREATE TRIGGER ${tableName}_require_exact_artifact
BEFORE INSERT ON ${tableName}
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
     WHERE artifact.protected_handle_id = NEW.${refColumn}
       AND artifact.kind = 'artifact'
       AND artifact.scope_kind = 'collaboration_server'
       AND artifact.scope_id = NEW.collaboration_server_id
       AND artifact.artifact_schema_id = '${schemaId}'
       AND artifact.artifact_digest = NEW.${digestColumn}
       ${lengthClause}
  ) THEN RAISE(ABORT, '${tableName} requires its exact scoped artifact') END;
END`;
  return schemaEntry("trigger", `${tableName}_require_exact_artifact`, tableName, sql);
}

function retainedTriggers(
  tableName: string,
  keyPredicate: string,
): readonly HostStateSqliteSchemaEntry[] {
  const deleteSql = `CREATE TRIGGER ${tableName}_no_delete
BEFORE DELETE ON ${tableName}
BEGIN
  SELECT RAISE(ABORT, '${tableName} is retained');
END`;
  const replaceSql = `CREATE TRIGGER ${tableName}_no_replace
BEFORE INSERT ON ${tableName}
WHEN EXISTS (SELECT 1 FROM ${tableName} WHERE ${keyPredicate})
BEGIN
  SELECT RAISE(ABORT, '${tableName} cannot be replaced');
END`;
  return Object.freeze([
    schemaEntry("trigger", `${tableName}_no_delete`, tableName, deleteSql),
    schemaEntry("trigger", `${tableName}_no_replace`, tableName, replaceSql),
  ]);
}

const CREATE_ACTORS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_route_actors_require_legal_update
BEFORE UPDATE ON broker_route_actors
BEGIN
  SELECT CASE WHEN
    NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind
    OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at_ms < OLD.updated_at_ms
    OR NEW.last_operation_id IS NULL
    OR (OLD.last_operation_id IS NOT NULL AND NEW.last_operation_id = OLD.last_operation_id)
  THEN RAISE(ABORT, 'broker route actor update is not a fresh revision') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM broker_routes AS route
      JOIN collaboration_servers AS server
        ON server.collaboration_server_id = route.collaboration_server_id
      JOIN coordinator_leases AS lease
        ON lease.coordinator_lease_id = COALESCE(NEW.coordinator_lease_id, OLD.coordinator_lease_id)
       AND lease.collaboration_server_id = route.collaboration_server_id
       AND lease.coordinator_epoch = COALESCE(NEW.coordinator_epoch, OLD.coordinator_epoch)
     WHERE route.broker_route_id = OLD.broker_route_id
       AND COALESCE(NEW.coordinator_lease_id, OLD.coordinator_lease_id) =
           server.current_coordinator_lease_id
       AND COALESCE(NEW.coordinator_epoch, OLD.coordinator_epoch) =
           server.current_coordinator_epoch
       AND lease.state = 'current' AND lease.released_at_ms IS NULL
       AND lease.acquired_at_ms <= NEW.updated_at_ms
       AND NEW.updated_at_ms < lease.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, 'broker route actor requires the current unexpired coordinator') END;
END`;

const CREATE_RUNTIME_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_route_runtime_status_require_legal_update
BEFORE UPDATE ON broker_route_runtime_status
BEGIN
  SELECT CASE WHEN
    NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind
    OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.machine_identity_id <> OLD.machine_identity_id
    OR NEW.current_channel_generation < OLD.current_channel_generation
    OR NEW.updated_at_ms < OLD.updated_at_ms
    OR OLD.state = 'closed' AND NEW.state <> 'closed'
    OR NEW.active_gap_count <> (
      SELECT count(*) FROM broker_route_gaps AS gap
       WHERE gap.broker_route_id = OLD.broker_route_id AND gap.state = 'open'
    )
    OR (NEW.active_gap_count > 0 AND NEW.state <> 'quarantined')
    OR (NEW.active_gap_count = 0 AND NEW.state = 'quarantined')
  THEN RAISE(ABORT, 'broker route runtime transition is not allowed') END;
END`;

const CREATE_GAPS_INCREMENT_RUNTIME_TRIGGER_SQL = `CREATE TRIGGER broker_route_gaps_increment_runtime
AFTER INSERT ON broker_route_gaps
BEGIN
  UPDATE broker_route_runtime_status
     SET active_gap_count = active_gap_count + 1,
         state = 'quarantined',
         updated_at_ms = max(updated_at_ms, NEW.opened_at_ms)
   WHERE broker_route_id = NEW.broker_route_id AND state <> 'closed';
END`;

const CREATE_GAPS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_route_gaps_require_legal_update
BEFORE UPDATE ON broker_route_gaps
BEGIN
  SELECT CASE WHEN
    NEW.gap_id <> OLD.gap_id OR NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.reason <> OLD.reason
    OR NEW.stable_semantic_result_id IS NOT OLD.stable_semantic_result_id
    OR NEW.channel_position_observation_id IS NOT OLD.channel_position_observation_id
    OR NEW.channel_generation IS NOT OLD.channel_generation
    OR NEW.manifest_equivocation_id IS NOT OLD.manifest_equivocation_id
    OR NEW.transport_key_collision_id IS NOT OLD.transport_key_collision_id
    OR NEW.evidence_ref <> OLD.evidence_ref OR NEW.evidence_digest <> OLD.evidence_digest
    OR NEW.opened_at_ms <> OLD.opened_at_ms OR OLD.state <> 'open' OR NEW.state <> 'resolved'
    OR NEW.resolved_at_ms IS NULL OR NEW.recovery_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM channel_position_recoveries AS recovery
       WHERE recovery.recovery_id = NEW.recovery_id AND recovery.gap_id = OLD.gap_id
         AND recovery.broker_route_id = OLD.broker_route_id
         AND recovery.collaboration_server_id = OLD.collaboration_server_id
         AND recovery.route_kind = OLD.route_kind
         AND recovery.logical_chat_id IS OLD.logical_chat_id
         AND recovery.reason = OLD.reason
         AND recovery.decided_at_ms = NEW.resolved_at_ms
    )
  THEN RAISE(ABORT, 'broker route gap transition is not allowed') END;
END`;

const CREATE_GAPS_DECREMENT_RUNTIME_TRIGGER_SQL = `CREATE TRIGGER broker_route_gaps_decrement_runtime
AFTER UPDATE OF state ON broker_route_gaps
WHEN OLD.state = 'open' AND NEW.state = 'resolved'
BEGIN
  UPDATE broker_route_runtime_status
     SET active_gap_count = active_gap_count - 1,
         state = CASE
           WHEN active_gap_count = 1 THEN 'current'
           ELSE 'quarantined'
         END,
         updated_at_ms = max(updated_at_ms, NEW.resolved_at_ms)
   WHERE broker_route_id = NEW.broker_route_id
     AND active_gap_count > 0 AND state <> 'closed';
END`;

const CREATE_GENERATIONS_REQUIRE_LEGAL_INSERT_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generation_observations_require_legal_insert
BEFORE INSERT ON broker_channel_generation_observations
BEGIN
  SELECT CASE WHEN NEW.channel_generation > 0 AND NOT EXISTS (
      SELECT 1 FROM broker_channel_generation_observations AS prior
       WHERE prior.broker_route_id = NEW.broker_route_id
         AND prior.channel_generation = NEW.channel_generation - 1
         AND prior.state = 'sealed' AND prior.next_generation = NEW.channel_generation
    )
  THEN RAISE(ABORT, 'generation observation requires its open chain position') END;
  SELECT CASE WHEN NEW.channel_generation <> 0 AND NOT EXISTS (
    SELECT 1 FROM broker_route_actors AS actor
    JOIN broker_routes AS route ON route.broker_route_id = actor.broker_route_id
    JOIN collaboration_servers AS server
      ON server.collaboration_server_id = route.collaboration_server_id
    JOIN coordinator_leases AS lease
      ON lease.coordinator_lease_id = actor.coordinator_lease_id
     AND lease.collaboration_server_id = route.collaboration_server_id
     AND lease.coordinator_epoch = actor.coordinator_epoch
     WHERE actor.broker_route_id = NEW.broker_route_id AND actor.claim_token IS NOT NULL
       AND actor.coordinator_lease_id = server.current_coordinator_lease_id
       AND actor.coordinator_epoch = server.current_coordinator_epoch
       AND lease.state = 'current' AND lease.released_at_ms IS NULL
  ) THEN RAISE(ABORT, 'successor generation requires a claimed route actor') END;
  SELECT CASE WHEN NEW.channel_generation = 0 AND NEW.state = 'sealed'
    AND NEW.observed_next_frame_index <> NEW.frame_count
  THEN RAISE(ABORT, 'sealed genesis observation must retain its exact frame count') END;
END`;

const CREATE_GENERATIONS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generation_observations_require_legal_update
BEFORE UPDATE ON broker_channel_generation_observations
BEGIN
  SELECT CASE WHEN
    NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.channel_generation <> OLD.channel_generation
    OR NEW.first_observed_at_ms <> OLD.first_observed_at_ms
    OR NEW.last_observed_at_ms < OLD.last_observed_at_ms
    OR NOT (
      (OLD.state = 'open' AND NEW.state = 'open'
        AND NEW.observed_next_frame_index >= OLD.observed_next_frame_index
        AND NEW.frame_count IS NULL AND NEW.next_generation IS NULL
        AND NEW.manifest_digest IS NULL)
      OR (OLD.state = 'open' AND NEW.state = 'sealed'
        AND NEW.observed_next_frame_index >= OLD.observed_next_frame_index
        AND NEW.frame_count = NEW.observed_next_frame_index
        AND NEW.next_generation = OLD.channel_generation + 1
        AND NEW.manifest_digest IS NOT NULL)
      OR (OLD.state = 'sealed' AND NEW.state = 'sealed'
        AND NEW.observed_next_frame_index = OLD.observed_next_frame_index
        AND NEW.frame_count = OLD.frame_count AND NEW.next_generation = OLD.next_generation
        AND NEW.manifest_digest = OLD.manifest_digest)
    )
  THEN RAISE(ABORT, 'generation observation transition is not allowed') END;
END`;

const CREATE_GENERATIONS_SEED_SUCCESSOR_TRIGGER_SQL = `CREATE TRIGGER broker_channel_generation_observations_seed_successor
AFTER UPDATE OF state ON broker_channel_generation_observations
WHEN OLD.state = 'open' AND NEW.state = 'sealed'
BEGIN
  INSERT INTO broker_channel_generation_observations (
    broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
    channel_generation, state, observed_next_frame_index, frame_count,
    next_generation, manifest_digest, first_observed_at_ms, last_observed_at_ms
  ) VALUES (
    NEW.broker_route_id, NEW.collaboration_server_id, NEW.route_kind, NEW.logical_chat_id,
    NEW.next_generation, 'open', 0, NULL, NULL, NULL,
    NEW.last_observed_at_ms, NEW.last_observed_at_ms
  );
  UPDATE broker_route_runtime_status
     SET current_channel_generation = NEW.next_generation,
         updated_at_ms = max(updated_at_ms, NEW.last_observed_at_ms)
   WHERE broker_route_id = NEW.broker_route_id;
END`;

const CREATE_FETCH_CURSOR_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_route_fetch_cursors_require_legal_update
BEFORE UPDATE ON broker_route_fetch_cursors
BEGIN
  SELECT CASE WHEN NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
    OR NEW.next_generation < OLD.next_generation
    OR (NEW.next_generation = OLD.next_generation AND NEW.next_frame_index < OLD.next_frame_index)
    OR NEW.next_generation > OLD.next_generation + 1
    OR (NEW.next_generation = OLD.next_generation + 1 AND NEW.next_frame_index <> 0)
    OR (NEW.next_generation = OLD.next_generation + 1 AND NOT EXISTS (
      SELECT 1 FROM broker_channel_generation_observations AS generation
       WHERE generation.broker_route_id = OLD.broker_route_id
         AND generation.channel_generation = OLD.next_generation
         AND generation.state = 'sealed'
         AND generation.next_generation = NEW.next_generation
         AND OLD.next_frame_index >= generation.frame_count
    ))
    OR NOT EXISTS (
      SELECT 1 FROM broker_read_page_observations AS page
       WHERE page.broker_route_id = OLD.broker_route_id
         AND page.requested_generation = OLD.next_generation
         AND page.requested_frame_index = OLD.next_frame_index
         AND page.next_generation = NEW.next_generation
         AND page.next_frame_index = NEW.next_frame_index
         AND (SELECT count(*) FROM broker_read_page_frame_evidence AS evidence
               WHERE evidence.read_page_observation_id = page.read_page_observation_id)
             = page.frame_count_in_page
         AND NOT EXISTS (
           SELECT 1 FROM broker_read_page_frame_evidence AS evidence
            WHERE evidence.read_page_observation_id = page.read_page_observation_id
              AND NOT EXISTS (
                SELECT 1 FROM authenticated_channel_positions AS position
                 WHERE position.broker_route_id = evidence.broker_route_id
                   AND position.channel_position_observation_id = evidence.channel_position_observation_id
                   AND position.channel_generation = evidence.channel_generation
                   AND position.frame_index = evidence.frame_index
                   AND position.claimed_delivery_attempt_id = evidence.claimed_delivery_attempt_id
                   AND position.claimed_part = evidence.claimed_part
                   AND position.claimed_transport_frame_digest = evidence.claimed_transport_frame_digest
                   AND position.received_frame_digest = evidence.received_frame_digest
                   AND position.received_frame_byte_length = evidence.received_frame_byte_length
              )
         )
    )
  THEN RAISE(ABORT, 'fetch cursor transition is not allowed') END;
END`;

const CREATE_SEMANTIC_CURSOR_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER broker_route_semantic_cursors_require_legal_update
BEFORE UPDATE ON broker_route_semantic_cursors
BEGIN
  SELECT CASE WHEN NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
    OR NOT (
      (NEW.next_generation = OLD.next_generation
        AND NEW.next_frame_index = OLD.next_frame_index + 1
        AND NEW.contiguous_through_generation = OLD.next_generation
        AND NEW.contiguous_through_frame_index = OLD.next_frame_index
        AND EXISTS (
          SELECT 1 FROM authenticated_channel_positions AS position
           WHERE position.broker_route_id = OLD.broker_route_id
             AND position.channel_generation = OLD.next_generation
             AND position.frame_index = OLD.next_frame_index
             AND position.cursor_disposition = 'advanceable'
        ))
      OR (NEW.next_generation = OLD.next_generation + 1 AND NEW.next_frame_index = 0
        AND NEW.contiguous_through_generation IS OLD.contiguous_through_generation
        AND NEW.contiguous_through_frame_index IS OLD.contiguous_through_frame_index
        AND EXISTS (
          SELECT 1 FROM broker_channel_generation_observations AS generation
           WHERE generation.broker_route_id = OLD.broker_route_id
             AND generation.channel_generation = OLD.next_generation
             AND generation.state = 'sealed'
             AND generation.next_generation = NEW.next_generation
             AND OLD.next_frame_index = generation.frame_count
        ))
    )
    OR NEW.next_generation > (
      SELECT next_generation FROM broker_route_fetch_cursors
       WHERE broker_route_id = OLD.broker_route_id
    )
    OR (NEW.next_generation = (
      SELECT next_generation FROM broker_route_fetch_cursors
       WHERE broker_route_id = OLD.broker_route_id
    ) AND NEW.next_frame_index > (
      SELECT next_frame_index FROM broker_route_fetch_cursors
       WHERE broker_route_id = OLD.broker_route_id
    ))
  THEN RAISE(ABORT, 'semantic cursor transition is not allowed') END;
END`;

const CREATE_GAPS_REQUIRE_EXACT_TARGET_TRIGGER_SQL = `CREATE TRIGGER broker_route_gaps_require_exact_target
BEFORE INSERT ON broker_route_gaps
BEGIN
  SELECT CASE WHEN
    (NEW.reason = 'semantic_collision' AND NOT EXISTS (
      SELECT 1 FROM authenticated_ingress_results AS result
       WHERE result.stable_semantic_result_id = NEW.stable_semantic_result_id
         AND result.broker_route_id = NEW.broker_route_id
         AND result.collaboration_server_id = NEW.collaboration_server_id
         AND result.route_kind = NEW.route_kind
         AND result.logical_chat_id IS NEW.logical_chat_id
    ))
    OR (NEW.reason = 'manifest_equivocation' AND NOT EXISTS (
      SELECT 1 FROM broker_channel_manifest_equivocations AS equivocation
       WHERE equivocation.manifest_equivocation_id = NEW.manifest_equivocation_id
         AND equivocation.broker_route_id = NEW.broker_route_id
         AND equivocation.collaboration_server_id = NEW.collaboration_server_id
         AND equivocation.route_kind = NEW.route_kind
         AND equivocation.logical_chat_id IS NEW.logical_chat_id
         AND equivocation.channel_generation = NEW.channel_generation
    ))
    OR (NEW.reason IN ('position_equivocation', 'unknown_outbound', 'invalid_frame')
      AND NOT EXISTS (
        SELECT 1 FROM authenticated_channel_positions AS position
         WHERE position.channel_position_observation_id = NEW.channel_position_observation_id
           AND position.broker_route_id = NEW.broker_route_id
           AND position.collaboration_server_id = NEW.collaboration_server_id
           AND position.route_kind = NEW.route_kind
           AND position.logical_chat_id IS NEW.logical_chat_id
      ))
    OR (NEW.reason = 'transport_collision' AND NOT EXISTS (
      SELECT 1 FROM broker_transport_key_collisions AS collision
       WHERE collision.transport_key_collision_id = NEW.transport_key_collision_id
         AND collision.broker_route_id = NEW.broker_route_id
         AND collision.collaboration_server_id = NEW.collaboration_server_id
         AND collision.route_kind = NEW.route_kind
         AND collision.logical_chat_id IS NEW.logical_chat_id
    ))
  THEN RAISE(ABORT, 'broker route gap target does not close over its route') END;
END`;

const CREATE_TRANSPORT_COLLISIONS_REQUIRE_EXACT_ORIGINAL_TRIGGER_SQL = `CREATE TRIGGER broker_transport_key_collisions_require_exact_original
BEFORE INSERT ON broker_transport_key_collisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_channel_positions AS position
     WHERE position.broker_route_id = NEW.broker_route_id
       AND position.collaboration_server_id = NEW.collaboration_server_id
       AND position.route_kind = NEW.route_kind
       AND position.logical_chat_id IS NEW.logical_chat_id
       AND position.channel_generation = NEW.original_channel_generation
       AND position.frame_index = NEW.original_frame_index
       AND position.delivery_attempt_id = NEW.delivery_attempt_id
       AND position.part = NEW.part
       AND position.normalized_transport_frame_digest = NEW.original_transport_frame_digest
  ) THEN RAISE(ABORT, 'transport collision requires its exact original attempt-part position') END;
END`;

const CREATE_RECOVERIES_REQUIRE_EXACT_GAP_TRIGGER_SQL = `CREATE TRIGGER channel_position_recoveries_require_exact_gap
BEFORE INSERT ON channel_position_recoveries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM broker_route_gaps AS gap
     WHERE gap.gap_id = NEW.gap_id AND gap.broker_route_id = NEW.broker_route_id
       AND gap.collaboration_server_id = NEW.collaboration_server_id
       AND gap.route_kind = NEW.route_kind AND gap.logical_chat_id IS NEW.logical_chat_id
       AND gap.reason = NEW.reason AND gap.state = 'open'
  ) THEN RAISE(ABORT, 'position recovery requires its exact open route gap') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM broker_route_actors AS actor
      JOIN collaboration_servers AS server
        ON server.collaboration_server_id = actor.collaboration_server_id
      JOIN coordinator_leases AS lease
        ON lease.coordinator_lease_id = NEW.coordinator_lease_id
       AND lease.collaboration_server_id = NEW.collaboration_server_id
       AND lease.coordinator_epoch = NEW.coordinator_epoch
     WHERE actor.broker_route_id = NEW.broker_route_id
       AND actor.coordinator_lease_id = NEW.coordinator_lease_id
       AND actor.coordinator_epoch = NEW.coordinator_epoch
       AND actor.claim_token IS NOT NULL
       AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
       AND server.current_coordinator_epoch = NEW.coordinator_epoch
       AND lease.state = 'current' AND lease.released_at_ms IS NULL
       AND lease.acquired_at_ms <= NEW.decided_at_ms
       AND NEW.decided_at_ms < lease.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, 'position recovery requires the claimed actor fence') END;
END`;

const CREATE_ATTEMPTS_REQUIRE_EXACT_RESULT_TRIGGER_SQL = `CREATE TRIGGER ingress_transport_attempts_require_exact_result
BEFORE INSERT ON ingress_transport_attempts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_ingress_results AS result
     WHERE result.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND result.broker_route_id = NEW.broker_route_id
       AND result.collaboration_server_id = NEW.collaboration_server_id
       AND result.route_kind = NEW.route_kind AND result.logical_chat_id IS NEW.logical_chat_id
  ) THEN RAISE(ABORT, 'transport attempt requires its route-scoped semantic result') END;
  SELECT CASE WHEN NEW.binding_disposition = 'exact' AND NOT EXISTS (
    SELECT 1 FROM authenticated_ingress_results AS result
     WHERE result.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND result.broker_route_id = NEW.broker_route_id
       AND result.source_event_namespace_id = NEW.source_event_namespace_id
       AND result.message_id = NEW.message_id AND result.record_kind = NEW.record_kind
       AND result.client_message_id IS NEW.client_message_id
       AND result.expected_parts = NEW.expected_parts
  ) THEN RAISE(ABORT, 'exact transport attempt conflicts with its semantic result') END;
  SELECT CASE WHEN NEW.binding_disposition = 'collision' AND (
    NOT EXISTS (
      SELECT 1 FROM authenticated_ingress_results AS result
       WHERE result.stable_semantic_result_id = NEW.stable_semantic_result_id
         AND result.broker_route_id = NEW.broker_route_id
         AND (result.source_event_namespace_id <> NEW.source_event_namespace_id
           OR result.message_id <> NEW.message_id
           OR result.record_kind <> NEW.record_kind
           OR result.client_message_id IS NOT NEW.client_message_id
           OR result.expected_parts <> NEW.expected_parts)
    )
    OR NOT EXISTS (
      SELECT 1 FROM broker_route_gaps AS gap
       WHERE gap.gap_id = NEW.collision_gap_id
         AND gap.broker_route_id = NEW.broker_route_id
         AND gap.collaboration_server_id = NEW.collaboration_server_id
         AND gap.route_kind = NEW.route_kind AND gap.logical_chat_id IS NEW.logical_chat_id
         AND gap.reason = 'semantic_collision'
         AND gap.stable_semantic_result_id = NEW.stable_semantic_result_id
         AND gap.state = 'open'
    )
  ) THEN RAISE(ABORT, 'collision transport attempt requires its exact open semantic gap') END;
END`;

const CREATE_CANDIDATES_REQUIRE_EXACT_ATTEMPT_TRIGGER_SQL = `CREATE TRIGGER ingress_delivery_candidates_require_exact_attempt
BEFORE INSERT ON ingress_delivery_candidates
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ingress_transport_attempts AS attempt
     WHERE attempt.broker_route_id = NEW.broker_route_id
       AND attempt.delivery_attempt_id = NEW.delivery_attempt_id
       AND attempt.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND attempt.collaboration_server_id = NEW.collaboration_server_id
       AND attempt.route_kind = NEW.route_kind AND attempt.logical_chat_id IS NEW.logical_chat_id
       AND ((attempt.binding_disposition = 'exact'
           AND attempt.expected_parts = NEW.expected_parts
           AND NEW.state = 'assembling' AND NEW.received_parts = 0
           AND NEW.plaintext_byte_count = 0)
         OR (attempt.binding_disposition = 'collision'
           AND NEW.state = 'collision' AND NEW.received_parts = 0
           AND NEW.plaintext_byte_count = 0))
  ) THEN RAISE(ABORT, 'delivery candidate requires its exact transport attempt') END;
  SELECT CASE WHEN (
    SELECT count(*) FROM ingress_delivery_candidates AS candidate
     WHERE candidate.stable_semantic_result_id = NEW.stable_semantic_result_id
  ) >= 4 THEN RAISE(ABORT, 'semantic result candidate limit exceeded') END;
END`;

const CREATE_RESULTS_REQUIRE_INITIAL_ASSEMBLING_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_results_require_initial_assembling
BEFORE INSERT ON authenticated_ingress_results
BEGIN
  SELECT CASE WHEN NEW.state <> 'assembling'
    OR NEW.source_payload_schema_id IS NOT NULL
    OR NEW.canonical_message_digest IS NOT NULL
    OR NEW.source_event_fingerprint_schema_id IS NOT NULL
    OR NEW.source_event_fingerprint IS NOT NULL
    OR NEW.accepted_delivery_attempt_id IS NOT NULL
    OR NEW.collision_at_ms IS NOT NULL OR NEW.terminal_at_ms IS NOT NULL
  THEN RAISE(ABORT, 'semantic result must begin as an empty assembling tombstone') END;
END`;

const CREATE_PARTS_REQUIRE_EXACT_CANDIDATE_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_parts_require_exact_candidate
BEFORE INSERT ON authenticated_ingress_parts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ingress_delivery_candidates AS candidate
     WHERE candidate.broker_route_id = NEW.broker_route_id
       AND candidate.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND candidate.delivery_attempt_id = NEW.delivery_attempt_id
       AND candidate.collaboration_server_id = NEW.collaboration_server_id
       AND candidate.route_kind = NEW.route_kind AND candidate.logical_chat_id IS NEW.logical_chat_id
       AND candidate.expected_parts = NEW.parts AND candidate.state = 'assembling'
  ) THEN RAISE(ABORT, 'ingress part requires its exact assembling candidate') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ingress_transport_attempts AS attempt
     WHERE attempt.broker_route_id = NEW.broker_route_id
       AND attempt.delivery_attempt_id = NEW.delivery_attempt_id
       AND attempt.binding_disposition = 'collision'
  ) THEN RAISE(ABORT, 'collision transport attempt cannot retain accepted parts') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM authenticated_ingress_parts AS prior
     WHERE prior.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND prior.delivery_attempt_id <> NEW.delivery_attempt_id
       AND prior.part = NEW.part
       AND (prior.parts <> NEW.parts
         OR prior.authenticated_part_digest <> NEW.authenticated_part_digest)
  ) THEN RAISE(ABORT, 'semantic part coordinate conflicts with first authenticated evidence') END;
  SELECT CASE WHEN (
    SELECT coalesce(sum(prior.plaintext_part_byte_length), 0)
      FROM authenticated_ingress_parts AS prior
     WHERE prior.stable_semantic_result_id = NEW.stable_semantic_result_id
  ) + NEW.plaintext_part_byte_length > 50331648
  THEN RAISE(ABORT, 'semantic result retained plaintext limit exceeded') END;
END`;

const CREATE_OBSERVATIONS_REQUIRE_EXACT_POSITION_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_observations_require_exact_position
BEFORE INSERT ON authenticated_ingress_observations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_channel_positions AS position
     WHERE position.channel_position_observation_id = NEW.channel_position_observation_id
       AND position.broker_route_id = NEW.broker_route_id
       AND position.collaboration_server_id = NEW.collaboration_server_id
       AND position.route_kind = NEW.route_kind AND position.logical_chat_id IS NEW.logical_chat_id
       AND position.channel_generation = NEW.channel_generation
       AND position.frame_index = NEW.frame_index
       AND position.classification = 'pending_validation'
  ) THEN RAISE(ABORT, 'ingress observation requires its exact staged position') END;
  SELECT CASE WHEN NEW.disposition NOT IN ('collision', 'late_after_tombstone') AND NOT EXISTS (
    SELECT 1 FROM ingress_delivery_candidates AS candidate
     WHERE candidate.broker_route_id = NEW.broker_route_id
       AND candidate.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND candidate.delivery_attempt_id = NEW.delivery_attempt_id
       AND candidate.collaboration_server_id = NEW.collaboration_server_id
       AND candidate.route_kind = NEW.route_kind AND candidate.logical_chat_id IS NEW.logical_chat_id
       AND (candidate.expected_parts = NEW.parts
         OR NEW.disposition IN ('collision', 'late_after_tombstone'))
  ) THEN RAISE(ABORT, 'ingress observation requires its exact delivery candidate') END;
  SELECT CASE WHEN NEW.disposition NOT IN ('collision', 'late_after_tombstone') AND NOT EXISTS (
    SELECT 1 FROM ingress_transport_attempts AS attempt
     WHERE attempt.broker_route_id = NEW.broker_route_id
       AND attempt.delivery_attempt_id = NEW.delivery_attempt_id
       AND attempt.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND attempt.collaboration_server_id = NEW.collaboration_server_id
       AND attempt.route_kind = NEW.route_kind AND attempt.logical_chat_id IS NEW.logical_chat_id
  ) THEN RAISE(ABORT, 'ingress observation requires its exact transport attempt') END;
  SELECT CASE WHEN NEW.disposition = 'late_after_tombstone' AND NOT EXISTS (
    SELECT 1 FROM authenticated_ingress_results AS result
     WHERE result.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND result.broker_route_id = NEW.broker_route_id
       AND result.collaboration_server_id = NEW.collaboration_server_id
       AND result.route_kind = NEW.route_kind AND result.logical_chat_id IS NEW.logical_chat_id
       AND result.state IN ('quarantined_incomplete', 'quarantined_collision')
  ) THEN RAISE(ABORT, 'late ingress observation requires its exact terminal semantic result') END;
  SELECT CASE WHEN NEW.disposition IN ('collision', 'late_after_tombstone') AND NEW.gap_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM broker_route_gaps AS gap
       WHERE gap.gap_id = NEW.gap_id
         AND gap.broker_route_id = NEW.broker_route_id
         AND gap.collaboration_server_id = NEW.collaboration_server_id
         AND gap.route_kind = NEW.route_kind AND gap.logical_chat_id IS NEW.logical_chat_id
         AND gap.state = 'open'
         AND ((gap.reason = 'semantic_collision'
             AND gap.stable_semantic_result_id = NEW.stable_semantic_result_id)
           OR (gap.reason = 'transport_collision' AND EXISTS (
             SELECT 1 FROM broker_transport_key_collisions AS collision
              WHERE collision.transport_key_collision_id = gap.transport_key_collision_id
                AND collision.broker_route_id = NEW.broker_route_id
                AND collision.delivery_attempt_id = NEW.delivery_attempt_id
                AND collision.part = NEW.part
           )))
    )
  THEN RAISE(ABORT, 'collision observation requires its exact open collision gap') END;
  SELECT CASE WHEN NEW.disposition = 'invalid_payload' AND NOT EXISTS (
    SELECT 1 FROM broker_route_gaps AS gap
     WHERE gap.gap_id = NEW.gap_id
       AND gap.broker_route_id = NEW.broker_route_id
       AND gap.collaboration_server_id = NEW.collaboration_server_id
       AND gap.route_kind = NEW.route_kind AND gap.logical_chat_id IS NEW.logical_chat_id
       AND gap.reason = 'invalid_frame'
       AND gap.channel_position_observation_id = NEW.channel_position_observation_id
       AND gap.state = 'open'
  ) THEN RAISE(ABORT, 'invalid payload observation requires its exact position gap') END;
  SELECT CASE WHEN NEW.disposition = 'late_after_tombstone' AND (
    EXISTS (
      SELECT 1 FROM authenticated_ingress_results AS result
       WHERE result.stable_semantic_result_id = NEW.stable_semantic_result_id
         AND result.state = 'quarantined_incomplete'
         AND (NEW.cursor_disposition <> 'advanceable' OR NEW.gap_id IS NOT NULL)
    )
    OR EXISTS (
      SELECT 1 FROM authenticated_ingress_results AS result
       WHERE result.stable_semantic_result_id = NEW.stable_semantic_result_id
         AND result.state = 'quarantined_collision'
         AND (NEW.cursor_disposition <> 'blocked' OR NEW.gap_id IS NULL)
    )
  ) THEN RAISE(ABORT, 'late ingress observation tombstone tuple is invalid') END;
  SELECT CASE WHEN NEW.disposition <> 'collision' AND EXISTS (
    SELECT 1 FROM ingress_transport_attempts AS attempt
     WHERE attempt.broker_route_id = NEW.broker_route_id
       AND attempt.delivery_attempt_id = NEW.delivery_attempt_id
       AND attempt.binding_disposition = 'collision'
  ) THEN RAISE(ABORT, 'collision transport attempt may retain only collision observations') END;
  SELECT CASE WHEN NEW.disposition IN (
    'new_part', 'exact_duplicate_part', 'exact_transport_retry', 'completed_exact_replay'
  ) AND NOT EXISTS (
    SELECT 1 FROM authenticated_ingress_parts AS part
     WHERE part.broker_route_id = NEW.broker_route_id
       AND part.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND part.delivery_attempt_id = NEW.delivery_attempt_id
       AND part.part = NEW.part AND part.parts = NEW.parts
       AND part.authenticated_part_digest = NEW.authenticated_part_digest
       AND part.plaintext_part_digest = NEW.plaintext_evidence_digest
       AND part.plaintext_part_byte_length = NEW.plaintext_evidence_byte_length
       AND (NEW.disposition <> 'new_part'
         OR part.plaintext_part_ref = NEW.plaintext_evidence_ref)
  ) THEN RAISE(ABORT, 'ingress observation disposition requires its exact retained plaintext part') END;
END`;

const CREATE_OBSERVATIONS_EXTEND_CURSOR_BOUNDS_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_observations_extend_cursor_bounds
AFTER INSERT ON authenticated_ingress_observations
BEGIN
  UPDATE authenticated_ingress_results
     SET first_ingress_generation = CASE
           WHEN NEW.channel_generation < first_ingress_generation
             OR (NEW.channel_generation = first_ingress_generation
               AND NEW.frame_index < first_ingress_frame_index)
           THEN NEW.channel_generation ELSE first_ingress_generation END,
         first_ingress_frame_index = CASE
           WHEN NEW.channel_generation < first_ingress_generation
             OR (NEW.channel_generation = first_ingress_generation
               AND NEW.frame_index < first_ingress_frame_index)
           THEN NEW.frame_index ELSE first_ingress_frame_index END,
         last_observed_ingress_generation = CASE
           WHEN NEW.channel_generation > last_observed_ingress_generation
             OR (NEW.channel_generation = last_observed_ingress_generation
               AND NEW.frame_index > last_observed_ingress_frame_index)
           THEN NEW.channel_generation ELSE last_observed_ingress_generation END,
         last_observed_ingress_frame_index = CASE
           WHEN NEW.channel_generation > last_observed_ingress_generation
             OR (NEW.channel_generation = last_observed_ingress_generation
               AND NEW.frame_index > last_observed_ingress_frame_index)
           THEN NEW.frame_index ELSE last_observed_ingress_frame_index END
   WHERE broker_route_id = NEW.broker_route_id
     AND stable_semantic_result_id = NEW.stable_semantic_result_id;
  UPDATE ingress_delivery_candidates
     SET first_ingress_generation = CASE
           WHEN NEW.channel_generation < first_ingress_generation
             OR (NEW.channel_generation = first_ingress_generation
               AND NEW.frame_index < first_ingress_frame_index)
           THEN NEW.channel_generation ELSE first_ingress_generation END,
         first_ingress_frame_index = CASE
           WHEN NEW.channel_generation < first_ingress_generation
             OR (NEW.channel_generation = first_ingress_generation
               AND NEW.frame_index < first_ingress_frame_index)
           THEN NEW.frame_index ELSE first_ingress_frame_index END,
         last_observed_ingress_generation = CASE
           WHEN NEW.channel_generation > last_observed_ingress_generation
             OR (NEW.channel_generation = last_observed_ingress_generation
               AND NEW.frame_index > last_observed_ingress_frame_index)
           THEN NEW.channel_generation ELSE last_observed_ingress_generation END,
         last_observed_ingress_frame_index = CASE
           WHEN NEW.channel_generation > last_observed_ingress_generation
             OR (NEW.channel_generation = last_observed_ingress_generation
               AND NEW.frame_index > last_observed_ingress_frame_index)
           THEN NEW.frame_index ELSE last_observed_ingress_frame_index END
   WHERE broker_route_id = NEW.broker_route_id
     AND stable_semantic_result_id = NEW.stable_semantic_result_id
     AND delivery_attempt_id = NEW.delivery_attempt_id;
END`;

const CREATE_POSITIONS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER authenticated_channel_positions_require_legal_update
BEFORE UPDATE ON authenticated_channel_positions
BEGIN
  SELECT CASE WHEN
    NEW.channel_position_observation_id <> OLD.channel_position_observation_id
    OR NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.channel_generation <> OLD.channel_generation OR NEW.frame_index <> OLD.frame_index
    OR NEW.claimed_delivery_attempt_id <> OLD.claimed_delivery_attempt_id
    OR NEW.claimed_part <> OLD.claimed_part
    OR NEW.claimed_transport_frame_digest <> OLD.claimed_transport_frame_digest
    OR NEW.received_frame_ref <> OLD.received_frame_ref
    OR NEW.received_frame_digest <> OLD.received_frame_digest
    OR NEW.received_frame_byte_length <> OLD.received_frame_byte_length
    OR NEW.observed_at_ms <> OLD.observed_at_ms
    OR (OLD.classification <> 'pending_validation' AND (
      NEW.normalized_transport_frame_digest IS NOT OLD.normalized_transport_frame_digest
      OR NEW.frame_identity_id IS NOT OLD.frame_identity_id
      OR NEW.frame_collaboration_server_id IS NOT OLD.frame_collaboration_server_id
      OR NEW.frame_logical_chat_id IS NOT OLD.frame_logical_chat_id
      OR NEW.direction IS NOT OLD.direction OR NEW.record_kind IS NOT OLD.record_kind
      OR NEW.sequence IS NOT OLD.sequence OR NEW.message_id IS NOT OLD.message_id
      OR NEW.delivery_attempt_id IS NOT OLD.delivery_attempt_id
      OR NEW.client_message_id IS NOT OLD.client_message_id OR NEW.key_epoch IS NOT OLD.key_epoch
      OR NEW.part IS NOT OLD.part OR NEW.parts IS NOT OLD.parts
      OR NEW.server_key_generation IS NOT OLD.server_key_generation
      OR NEW.host_signer_identity_key_id IS NOT OLD.host_signer_identity_key_id
      OR NEW.host_scope_certificate_id IS NOT OLD.host_scope_certificate_id
      OR NEW.host_signature_sequence IS NOT OLD.host_signature_sequence
      OR NEW.stable_logical_header_digest IS NOT OLD.stable_logical_header_digest
      OR NEW.validation_failure_code IS NOT OLD.validation_failure_code
      OR NEW.ingress_observation_id IS NOT OLD.ingress_observation_id
      OR NEW.classified_at_ms IS NOT OLD.classified_at_ms
    ))
    OR NOT (
      (OLD.classification = 'pending_validation' AND NEW.classification <> 'pending_validation')
      OR (OLD.classification = NEW.classification
        AND OLD.classification IN ('inbound_ingress', 'unknown_outbound', 'invalid')
        AND OLD.cursor_disposition = 'blocked' AND NEW.cursor_disposition = 'advanceable'
        AND OLD.recovery_id IS NULL AND NEW.recovery_id IS NOT NULL)
      OR (OLD.classification = NEW.classification AND OLD.classification = 'invalid'
        AND OLD.cursor_disposition = 'advanceable' AND NEW.cursor_disposition = 'advanceable'
        AND OLD.recovery_id IS NULL AND NEW.recovery_id IS NOT NULL)
      OR (OLD.classification = NEW.classification AND OLD.classification = 'inbound_ingress'
        AND OLD.cursor_disposition = 'blocked' AND NEW.cursor_disposition = 'advanceable'
        AND OLD.recovery_id IS NEW.recovery_id)
    )
  THEN RAISE(ABORT, 'authenticated channel position transition is not allowed') END;
  SELECT CASE WHEN NEW.classification = 'inbound_ingress' AND NOT EXISTS (
    SELECT 1 FROM authenticated_ingress_observations AS observation
     WHERE observation.ingress_observation_id = NEW.ingress_observation_id
       AND observation.channel_position_observation_id = OLD.channel_position_observation_id
       AND observation.broker_route_id = OLD.broker_route_id
       AND observation.delivery_attempt_id = NEW.delivery_attempt_id
       AND observation.part = NEW.part AND observation.parts = NEW.parts
  ) THEN RAISE(ABORT, 'inbound position requires its exact ingress observation') END;
  SELECT CASE WHEN NEW.classification = 'inbound_ingress' AND EXISTS (
    SELECT 1 FROM authenticated_ingress_observations AS observation
     WHERE observation.ingress_observation_id = NEW.ingress_observation_id
       AND (observation.gap_id IS NOT NEW.gap_id
         OR observation.cursor_disposition <> NEW.cursor_disposition
         OR observation.recovery_id IS NOT NEW.recovery_id)
  ) THEN RAISE(ABORT, 'inbound position must retain its exact observation cursor tuple') END;
  SELECT CASE WHEN NEW.gap_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM broker_route_gaps AS gap
     WHERE gap.gap_id = NEW.gap_id AND gap.broker_route_id = OLD.broker_route_id
  ) THEN RAISE(ABORT, 'position gap does not belong to its route') END;
  SELECT CASE WHEN NEW.recovery_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM channel_position_recoveries AS recovery
      JOIN broker_route_gaps AS gap
        ON gap.gap_id = recovery.gap_id
       AND gap.recovery_id = recovery.recovery_id
       AND gap.state = 'resolved'
     WHERE recovery.recovery_id = NEW.recovery_id
       AND recovery.broker_route_id = OLD.broker_route_id
       AND recovery.collaboration_server_id = OLD.collaboration_server_id
       AND recovery.route_kind = OLD.route_kind
       AND recovery.logical_chat_id IS OLD.logical_chat_id
       AND (recovery.gap_id = NEW.gap_id
         OR (NEW.gap_id IS NULL AND gap.reason = 'semantic_collision'
           AND EXISTS (
             SELECT 1 FROM authenticated_ingress_observations AS observation
              WHERE observation.ingress_observation_id = NEW.ingress_observation_id
                AND observation.stable_semantic_result_id = gap.stable_semantic_result_id
           )))
  ) THEN RAISE(ABORT, 'position recovery does not close its exact resolved gap') END;
END`;

const CREATE_RESULTS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_results_require_legal_update
BEFORE UPDATE ON authenticated_ingress_results
BEGIN
  SELECT CASE WHEN
    NEW.stable_semantic_result_id <> OLD.stable_semantic_result_id
    OR NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.source_event_namespace_id <> OLD.source_event_namespace_id
    OR NEW.message_id <> OLD.message_id OR NEW.record_kind <> OLD.record_kind
    OR NEW.client_message_id IS NOT OLD.client_message_id
    OR NEW.expected_parts <> OLD.expected_parts
    OR NOT (
      NEW.accepted_delivery_attempt_id IS OLD.accepted_delivery_attempt_id
      OR (OLD.state = 'assembling' AND NEW.state = 'awaiting_order'
        AND OLD.accepted_delivery_attempt_id IS NULL
        AND NEW.accepted_delivery_attempt_id IS NOT NULL)
    )
    OR NEW.first_ingress_generation > OLD.first_ingress_generation
    OR (NEW.first_ingress_generation = OLD.first_ingress_generation
      AND NEW.first_ingress_frame_index > OLD.first_ingress_frame_index)
    OR NEW.assembly_deadline_ms <> OLD.assembly_deadline_ms
    OR NEW.last_observed_ingress_generation < OLD.last_observed_ingress_generation
    OR (NEW.last_observed_ingress_generation = OLD.last_observed_ingress_generation
      AND NEW.last_observed_ingress_frame_index < OLD.last_observed_ingress_frame_index)
    OR NOT (
      (OLD.state = 'assembling' AND NEW.state IN ('assembling', 'awaiting_order', 'quarantined_incomplete', 'quarantined_collision'))
      OR (OLD.state = 'awaiting_order' AND NEW.state IN ('awaiting_order', 'quarantined_collision'))
      OR (OLD.state = NEW.state AND OLD.state IN ('quarantined_incomplete', 'quarantined_collision'))
    )
    OR (OLD.collision_at_ms IS NOT NULL AND NEW.collision_at_ms IS NOT OLD.collision_at_ms)
    OR (OLD.terminal_at_ms IS NOT NULL AND NEW.terminal_at_ms IS NOT OLD.terminal_at_ms)
    OR (OLD.collision_at_ms IS NULL AND NEW.collision_at_ms IS NOT NULL
      AND NEW.state <> 'quarantined_collision')
    OR (OLD.terminal_at_ms IS NULL AND NEW.terminal_at_ms IS NOT NULL
      AND NEW.state NOT IN ('quarantined_incomplete', 'quarantined_collision'))
    OR (OLD.canonical_message_digest IS NOT NULL AND (
      NEW.source_payload_schema_id IS NOT OLD.source_payload_schema_id
      OR NEW.canonical_message_digest IS NOT OLD.canonical_message_digest
      OR NEW.source_event_fingerprint_schema_id IS NOT OLD.source_event_fingerprint_schema_id
      OR NEW.source_event_fingerprint IS NOT OLD.source_event_fingerprint
      OR NEW.accepted_delivery_attempt_id IS NOT OLD.accepted_delivery_attempt_id
    ))
  THEN RAISE(ABORT, 'authenticated ingress result transition is not allowed') END;
END`;

const CREATE_CANDIDATES_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER ingress_delivery_candidates_require_legal_update
BEFORE UPDATE ON ingress_delivery_candidates
BEGIN
  SELECT CASE WHEN
    NEW.stable_semantic_result_id <> OLD.stable_semantic_result_id
    OR NEW.delivery_attempt_id <> OLD.delivery_attempt_id
    OR NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.expected_parts <> OLD.expected_parts
    OR NEW.first_ingress_generation > OLD.first_ingress_generation
    OR (NEW.first_ingress_generation = OLD.first_ingress_generation
      AND NEW.first_ingress_frame_index > OLD.first_ingress_frame_index)
    OR NEW.received_parts < OLD.received_parts
    OR NEW.plaintext_byte_count < OLD.plaintext_byte_count
    OR NEW.last_observed_ingress_generation < OLD.last_observed_ingress_generation
    OR (NEW.last_observed_ingress_generation = OLD.last_observed_ingress_generation
      AND NEW.last_observed_ingress_frame_index < OLD.last_observed_ingress_frame_index)
    OR NOT (
      (OLD.state = 'assembling' AND NEW.state IN ('assembling', 'complete', 'expired', 'collision'))
      OR (OLD.state = 'complete' AND NEW.state IN ('complete', 'collision'))
      OR OLD.state = NEW.state AND OLD.state IN ('expired', 'collision')
    )
  THEN RAISE(ABORT, 'ingress delivery candidate transition is not allowed') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM authenticated_ingress_results AS result
     WHERE result.broker_route_id = OLD.broker_route_id
       AND result.stable_semantic_result_id = OLD.stable_semantic_result_id
       AND result.accepted_delivery_attempt_id = OLD.delivery_attempt_id
  ) AND NOT (NEW.state = 'complete' AND NEW.received_parts = NEW.expected_parts)
  THEN RAISE(ABORT, 'accepted delivery candidate must remain complete') END;
  SELECT CASE WHEN NEW.state = 'complete' AND (
    (SELECT count(*) FROM authenticated_ingress_parts AS part
      WHERE part.broker_route_id = NEW.broker_route_id
        AND part.stable_semantic_result_id = NEW.stable_semantic_result_id
        AND part.delivery_attempt_id = NEW.delivery_attempt_id) <> NEW.expected_parts
    OR (SELECT coalesce(sum(part.plaintext_part_byte_length), 0)
          FROM authenticated_ingress_parts AS part
         WHERE part.broker_route_id = NEW.broker_route_id
           AND part.stable_semantic_result_id = NEW.stable_semantic_result_id
           AND part.delivery_attempt_id = NEW.delivery_attempt_id) <> NEW.plaintext_byte_count
    OR EXISTS (
      SELECT 1 FROM authenticated_ingress_parts AS part
       WHERE part.broker_route_id = NEW.broker_route_id
         AND part.stable_semantic_result_id = NEW.stable_semantic_result_id
         AND part.delivery_attempt_id = NEW.delivery_attempt_id
         AND (part.parts <> NEW.expected_parts OR part.part >= NEW.expected_parts)
    )
  ) THEN RAISE(ABORT, 'complete candidate requires its exact full retained part vector') END;
END`;

const CREATE_RESULTS_REQUIRE_ACCEPTED_CANDIDATE_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_results_require_accepted_candidate
BEFORE UPDATE ON authenticated_ingress_results
WHEN NEW.accepted_delivery_attempt_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM ingress_delivery_candidates AS candidate
      JOIN ingress_transport_attempts AS attempt
        ON attempt.broker_route_id = candidate.broker_route_id
       AND attempt.delivery_attempt_id = candidate.delivery_attempt_id
       AND attempt.stable_semantic_result_id = candidate.stable_semantic_result_id
     WHERE candidate.broker_route_id = NEW.broker_route_id
       AND candidate.stable_semantic_result_id = NEW.stable_semantic_result_id
       AND candidate.delivery_attempt_id = NEW.accepted_delivery_attempt_id
       AND candidate.state = 'complete'
       AND candidate.received_parts = candidate.expected_parts
       AND attempt.binding_disposition = 'exact'
  ) THEN RAISE(ABORT, 'ingress result requires its exact complete accepted candidate') END;
END`;

const CREATE_OBSERVATIONS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_observations_require_legal_update
BEFORE UPDATE ON authenticated_ingress_observations
BEGIN
  SELECT CASE WHEN
    NEW.ingress_observation_id <> OLD.ingress_observation_id
    OR NEW.channel_position_observation_id <> OLD.channel_position_observation_id
    OR NEW.stable_semantic_result_id <> OLD.stable_semantic_result_id
    OR NEW.delivery_attempt_id <> OLD.delivery_attempt_id
    OR NEW.broker_route_id <> OLD.broker_route_id
    OR NEW.collaboration_server_id <> OLD.collaboration_server_id
    OR NEW.route_kind <> OLD.route_kind OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
    OR NEW.channel_generation <> OLD.channel_generation OR NEW.frame_index <> OLD.frame_index
    OR NEW.part <> OLD.part OR NEW.parts <> OLD.parts
    OR NEW.authenticated_part_digest <> OLD.authenticated_part_digest
    OR NEW.plaintext_evidence_ref <> OLD.plaintext_evidence_ref
    OR NEW.plaintext_evidence_digest <> OLD.plaintext_evidence_digest
    OR NEW.plaintext_evidence_byte_length <> OLD.plaintext_evidence_byte_length
    OR NEW.disposition <> OLD.disposition
    OR NEW.gap_id IS NOT OLD.gap_id
    OR OLD.cursor_disposition <> 'blocked' OR NEW.cursor_disposition <> 'advanceable'
    OR NOT (NEW.recovery_id IS OLD.recovery_id OR (OLD.recovery_id IS NULL AND NEW.recovery_id IS NOT NULL))
  THEN RAISE(ABORT, 'authenticated ingress observation transition is not allowed') END;
  SELECT CASE WHEN NEW.recovery_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM channel_position_recoveries AS recovery
      JOIN broker_route_gaps AS gap
        ON gap.gap_id = recovery.gap_id
       AND gap.recovery_id = recovery.recovery_id
       AND gap.state = 'resolved'
     WHERE recovery.recovery_id = NEW.recovery_id
       AND recovery.broker_route_id = OLD.broker_route_id
       AND (recovery.gap_id = OLD.gap_id
         OR (OLD.gap_id IS NULL AND gap.reason = 'semantic_collision'
           AND gap.stable_semantic_result_id = OLD.stable_semantic_result_id))
  ) THEN RAISE(ABORT, 'ingress observation recovery does not close its position gap') END;
END`;

const CREATE_READ_PAGES_REQUIRE_EXACT_ARTIFACT_TRIGGER_SQL = `CREATE TRIGGER broker_read_page_observations_require_exact_artifact
BEFORE INSERT ON broker_read_page_observations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
     WHERE artifact.protected_handle_id = NEW.evidence_ref
       AND artifact.kind = 'artifact'
       AND artifact.scope_kind = 'collaboration_server'
       AND artifact.scope_id = NEW.collaboration_server_id
       AND artifact.artifact_schema_id = 'remote-claw/a1/read-page-evidence/v1'
       AND artifact.artifact_digest = NEW.evidence_digest
  ) THEN RAISE(ABORT, 'read page observation requires its exact read-page evidence') END;
END`;

const CREATE_READ_PAGE_FRAMES_REQUIRE_EXACT_EVIDENCE_TRIGGER_SQL = `CREATE TRIGGER broker_read_page_frame_evidence_require_exact_evidence
BEFORE INSERT ON broker_read_page_frame_evidence
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM broker_read_page_observations AS page
      JOIN protected_artifacts AS artifact
        ON artifact.protected_handle_id = NEW.received_frame_ref
     WHERE page.read_page_observation_id = NEW.read_page_observation_id
       AND page.broker_route_id = NEW.broker_route_id
       AND page.collaboration_server_id = NEW.collaboration_server_id
       AND page.route_kind = NEW.route_kind AND page.logical_chat_id IS NEW.logical_chat_id
       AND NEW.ordinal < page.frame_count_in_page
       AND NEW.channel_generation = page.requested_generation
       AND NEW.frame_index = page.requested_frame_index + NEW.ordinal
       AND artifact.kind = 'artifact'
       AND artifact.scope_kind = 'collaboration_server'
       AND artifact.scope_id = NEW.collaboration_server_id
       AND artifact.artifact_schema_id = 'remote-claw/a1/received-frame/v1'
       AND artifact.artifact_digest = NEW.received_frame_digest
       AND artifact.byte_length = NEW.received_frame_byte_length
  ) THEN RAISE(ABORT, 'read-page frame evidence requires its exact page and raw artifact') END;
END`;

const CREATE_OBSERVATIONS_REQUIRE_EXACT_ARTIFACT_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_observations_require_exact_artifact
BEFORE INSERT ON authenticated_ingress_observations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
     WHERE artifact.protected_handle_id = NEW.plaintext_evidence_ref
       AND artifact.kind = 'artifact'
       AND artifact.scope_kind = 'collaboration_server'
       AND artifact.scope_id = NEW.collaboration_server_id
       AND artifact.artifact_schema_id = 'remote-claw/a1/opened-plaintext-part/v1'
       AND artifact.artifact_digest = NEW.plaintext_evidence_digest
       AND artifact.byte_length = NEW.plaintext_evidence_byte_length
  ) THEN RAISE(ABORT, 'ingress observation requires its exact plaintext evidence') END;
END`;

export const VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    table("broker_route_runtime_status", CREATE_BROKER_ROUTE_RUNTIME_STATUS_SQL),
    table(
      "broker_channel_generation_observations",
      CREATE_BROKER_CHANNEL_GENERATION_OBSERVATIONS_SQL,
    ),
    table("broker_route_fetch_cursors", CREATE_BROKER_ROUTE_FETCH_CURSORS_SQL),
    table("broker_route_semantic_cursors", CREATE_BROKER_ROUTE_SEMANTIC_CURSORS_SQL),
    table("broker_route_gaps", CREATE_BROKER_ROUTE_GAPS_SQL),
    table("authenticated_channel_positions", CREATE_AUTHENTICATED_CHANNEL_POSITIONS_SQL),
    table("channel_position_equivocations", CREATE_CHANNEL_POSITION_EQUIVOCATIONS_SQL),
    table(
      "broker_channel_manifest_equivocations",
      CREATE_BROKER_CHANNEL_MANIFEST_EQUIVOCATIONS_SQL,
    ),
    table("broker_transport_key_collisions", CREATE_BROKER_TRANSPORT_KEY_COLLISIONS_SQL),
    table("channel_position_recoveries", CREATE_CHANNEL_POSITION_RECOVERIES_SQL),
    table("authenticated_ingress_results", CREATE_AUTHENTICATED_INGRESS_RESULTS_SQL),
    table("ingress_transport_attempts", CREATE_INGRESS_TRANSPORT_ATTEMPTS_SQL),
    table("ingress_delivery_candidates", CREATE_INGRESS_DELIVERY_CANDIDATES_SQL),
    table("authenticated_ingress_parts", CREATE_AUTHENTICATED_INGRESS_PARTS_SQL),
    table("authenticated_ingress_observations", CREATE_AUTHENTICATED_INGRESS_OBSERVATIONS_SQL),
    table("broker_route_actors", CREATE_BROKER_ROUTE_ACTORS_SQL),
    table("broker_read_page_observations", CREATE_BROKER_READ_PAGE_OBSERVATIONS_SQL),
    table("broker_read_page_frame_evidence", CREATE_BROKER_READ_PAGE_FRAME_EVIDENCE_SQL),
    schemaEntry(
      "index",
      "authenticated_channel_positions_cursor_unique",
      "authenticated_channel_positions",
      CREATE_POSITIONS_CURSOR_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_channel_positions_pending",
      "authenticated_channel_positions",
      CREATE_POSITIONS_PENDING_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_channel_positions_disposition",
      "authenticated_channel_positions",
      CREATE_POSITIONS_DISPOSITION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_route_gaps_state",
      "broker_route_gaps",
      CREATE_GAPS_STATE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_ingress_results_semantic_unique",
      "authenticated_ingress_results",
      CREATE_RESULTS_SEMANTIC_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_ingress_results_state_order",
      "authenticated_ingress_results",
      CREATE_RESULTS_ORDER_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "ingress_delivery_candidates_result_attempt_unique",
      "ingress_delivery_candidates",
      CREATE_CANDIDATES_RESULT_ATTEMPT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_ingress_parts_result_attempt",
      "authenticated_ingress_parts",
      CREATE_PARTS_RESULT_ATTEMPT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_ingress_observations_position_unique",
      "authenticated_ingress_observations",
      CREATE_OBSERVATIONS_POSITION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "authenticated_ingress_observations_candidate",
      "authenticated_ingress_observations",
      CREATE_OBSERVATIONS_CANDIDATE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_channel_manifest_equivocations_route_generation",
      "broker_channel_manifest_equivocations",
      CREATE_MANIFEST_EQUIVOCATIONS_ROUTE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_transport_key_collisions_key_unique",
      "broker_transport_key_collisions",
      CREATE_TRANSPORT_COLLISIONS_KEY_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "channel_position_recoveries_gap_unique",
      "channel_position_recoveries",
      CREATE_RECOVERIES_GAP_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "broker_read_page_observations_route_position",
      "broker_read_page_observations",
      CREATE_READ_PAGES_ROUTE_INDEX_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_routes_seed_durable_ingress",
      "broker_routes",
      CREATE_BROKER_ROUTES_SEED_INGRESS_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generations_seed_observation",
      "broker_channel_generations",
      CREATE_BROKER_GENERATIONS_SEED_OBSERVATION_TRIGGER_SQL,
    ),
    ...SCOPED_TABLES.flatMap((tableName) => [
      routeScopeTrigger(tableName, "INSERT"),
      routeScopeTrigger(tableName, "UPDATE"),
    ]),
    ...ACTOR_GUARDED_INSERT_TABLES.map((tableName) => currentActorTrigger(tableName, "INSERT")),
    ...ACTOR_GUARDED_UPDATE_TABLES.map((tableName) => currentActorTrigger(tableName, "UPDATE")),
    ...APPEND_ONLY_TABLE_KEYS.flatMap(([tableName, keyExpression]) =>
      appendOnlyTriggers(tableName, keyExpression),
    ),
    ...retainedTriggers("broker_route_runtime_status", "broker_route_id = NEW.broker_route_id"),
    ...retainedTriggers(
      "broker_channel_generation_observations",
      "broker_route_id = NEW.broker_route_id AND channel_generation = NEW.channel_generation",
    ),
    ...retainedTriggers("broker_route_fetch_cursors", "broker_route_id = NEW.broker_route_id"),
    ...retainedTriggers("broker_route_semantic_cursors", "broker_route_id = NEW.broker_route_id"),
    ...retainedTriggers("broker_route_gaps", "gap_id = NEW.gap_id"),
    ...retainedTriggers(
      "authenticated_channel_positions",
      "channel_position_observation_id = NEW.channel_position_observation_id",
    ),
    ...retainedTriggers(
      "authenticated_ingress_results",
      "stable_semantic_result_id = NEW.stable_semantic_result_id",
    ),
    ...retainedTriggers(
      "ingress_delivery_candidates",
      "broker_route_id = NEW.broker_route_id AND stable_semantic_result_id = NEW.stable_semantic_result_id AND delivery_attempt_id = NEW.delivery_attempt_id",
    ),
    ...retainedTriggers(
      "authenticated_ingress_observations",
      "ingress_observation_id = NEW.ingress_observation_id",
    ),
    ...retainedTriggers("broker_route_actors", "broker_route_id = NEW.broker_route_id"),
    schemaEntry(
      "trigger",
      "authenticated_channel_positions_require_exact_artifact",
      "authenticated_channel_positions",
      CREATE_POSITIONS_REQUIRE_ARTIFACT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_gaps_require_exact_artifact",
      "broker_route_gaps",
      CREATE_GAPS_REQUIRE_ARTIFACT_TRIGGER_SQL,
    ),
    exactArtifactTrigger(
      "channel_position_equivocations",
      "conflicting_frame_ref",
      "conflicting_frame_digest",
      "remote-claw/a1/received-frame/v1",
    ),
    exactArtifactTrigger(
      "broker_channel_manifest_equivocations",
      "evidence_ref",
      "evidence_digest",
      "remote-claw/a1/read-page-evidence/v1",
    ),
    exactArtifactTrigger(
      "broker_transport_key_collisions",
      "conflicting_frame_ref",
      "conflicting_frame_digest",
      "remote-claw/a1/received-frame/v1",
    ),
    exactArtifactTrigger(
      "channel_position_recoveries",
      "evidence_ref",
      "evidence_digest",
      "remote-claw/a1/ingress-gap-evidence/v1",
    ),
    exactArtifactTrigger(
      "authenticated_ingress_parts",
      "plaintext_part_ref",
      "plaintext_part_digest",
      "remote-claw/a1/opened-plaintext-part/v1",
      "plaintext_part_byte_length",
    ),
    schemaEntry(
      "trigger",
      "broker_route_actors_require_legal_update",
      "broker_route_actors",
      CREATE_ACTORS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_runtime_status_require_legal_update",
      "broker_route_runtime_status",
      CREATE_RUNTIME_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_gaps_increment_runtime",
      "broker_route_gaps",
      CREATE_GAPS_INCREMENT_RUNTIME_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_gaps_require_legal_update",
      "broker_route_gaps",
      CREATE_GAPS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_gaps_decrement_runtime",
      "broker_route_gaps",
      CREATE_GAPS_DECREMENT_RUNTIME_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generation_observations_require_legal_insert",
      "broker_channel_generation_observations",
      CREATE_GENERATIONS_REQUIRE_LEGAL_INSERT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generation_observations_require_legal_update",
      "broker_channel_generation_observations",
      CREATE_GENERATIONS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_channel_generation_observations_seed_successor",
      "broker_channel_generation_observations",
      CREATE_GENERATIONS_SEED_SUCCESSOR_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_fetch_cursors_require_legal_update",
      "broker_route_fetch_cursors",
      CREATE_FETCH_CURSOR_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_semantic_cursors_require_legal_update",
      "broker_route_semantic_cursors",
      CREATE_SEMANTIC_CURSOR_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_route_gaps_require_exact_target",
      "broker_route_gaps",
      CREATE_GAPS_REQUIRE_EXACT_TARGET_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_transport_key_collisions_require_exact_original",
      "broker_transport_key_collisions",
      CREATE_TRANSPORT_COLLISIONS_REQUIRE_EXACT_ORIGINAL_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "channel_position_recoveries_require_exact_gap",
      "channel_position_recoveries",
      CREATE_RECOVERIES_REQUIRE_EXACT_GAP_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_results_require_initial_assembling",
      "authenticated_ingress_results",
      CREATE_RESULTS_REQUIRE_INITIAL_ASSEMBLING_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "ingress_transport_attempts_require_exact_result",
      "ingress_transport_attempts",
      CREATE_ATTEMPTS_REQUIRE_EXACT_RESULT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "ingress_delivery_candidates_require_exact_attempt",
      "ingress_delivery_candidates",
      CREATE_CANDIDATES_REQUIRE_EXACT_ATTEMPT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_parts_require_exact_candidate",
      "authenticated_ingress_parts",
      CREATE_PARTS_REQUIRE_EXACT_CANDIDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_observations_require_exact_position",
      "authenticated_ingress_observations",
      CREATE_OBSERVATIONS_REQUIRE_EXACT_POSITION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_observations_extend_cursor_bounds",
      "authenticated_ingress_observations",
      CREATE_OBSERVATIONS_EXTEND_CURSOR_BOUNDS_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_channel_positions_require_legal_update",
      "authenticated_channel_positions",
      CREATE_POSITIONS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_results_require_legal_update",
      "authenticated_ingress_results",
      CREATE_RESULTS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_results_require_accepted_candidate",
      "authenticated_ingress_results",
      CREATE_RESULTS_REQUIRE_ACCEPTED_CANDIDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "ingress_delivery_candidates_require_legal_update",
      "ingress_delivery_candidates",
      CREATE_CANDIDATES_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_observations_require_legal_update",
      "authenticated_ingress_observations",
      CREATE_OBSERVATIONS_REQUIRE_LEGAL_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_read_page_observations_require_exact_artifact",
      "broker_read_page_observations",
      CREATE_READ_PAGES_REQUIRE_EXACT_ARTIFACT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "broker_read_page_frame_evidence_require_exact_evidence",
      "broker_read_page_frame_evidence",
      CREATE_READ_PAGE_FRAMES_REQUIRE_EXACT_EVIDENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "authenticated_ingress_observations_require_exact_artifact",
      "authenticated_ingress_observations",
      CREATE_OBSERVATIONS_REQUIRE_EXACT_ARTIFACT_TRIGGER_SQL,
    ),
  ]);

const BACKFILL_BROKER_ROUTE_RUNTIME_STATUS_SQL = `INSERT INTO broker_route_runtime_status (
  broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
  machine_identity_id, state, current_channel_generation, active_gap_count, updated_at_ms
)
SELECT broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
       machine_identity_id, 'current', genesis_generation, 0, created_at_ms
  FROM broker_routes`;

const BACKFILL_BROKER_GENERATION_OBSERVATIONS_SQL = `INSERT INTO broker_channel_generation_observations (
  broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
  channel_generation, state, observed_next_frame_index, frame_count,
  next_generation, manifest_digest, first_observed_at_ms, last_observed_at_ms
)
SELECT route.broker_route_id, route.collaboration_server_id, route.route_kind,
       route.logical_chat_id, generation.channel_generation, generation.state,
       COALESCE(generation.frame_count, 0), generation.frame_count,
       generation.next_generation, generation.manifest_digest,
       route.created_at_ms, route.created_at_ms
  FROM broker_channel_generations AS generation
  JOIN broker_routes AS route ON route.broker_route_id = generation.broker_route_id`;

const BACKFILL_BROKER_ROUTE_FETCH_CURSORS_SQL = `INSERT INTO broker_route_fetch_cursors (
  broker_route_id, next_generation, next_frame_index, revision, updated_at_ms
)
SELECT broker_route_id, genesis_generation, 0, 0, created_at_ms FROM broker_routes`;

const BACKFILL_BROKER_ROUTE_SEMANTIC_CURSORS_SQL = `INSERT INTO broker_route_semantic_cursors (
  broker_route_id, next_generation, next_frame_index,
  contiguous_through_generation, contiguous_through_frame_index, revision, updated_at_ms
)
SELECT broker_route_id, genesis_generation, 0, NULL, NULL, 0, created_at_ms FROM broker_routes`;

const BACKFILL_BROKER_ROUTE_ACTORS_SQL = `INSERT INTO broker_route_actors (
  broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
  revision, claim_token, coordinator_lease_id, coordinator_epoch, claimed_at_ms,
  last_operation_id, last_operation_kind, last_operation_digest, updated_at_ms
)
SELECT broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
       0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, created_at_ms
  FROM broker_routes`;

export const VERSION_EIGHT_DATA_STATEMENTS: readonly string[] = Object.freeze([
  BACKFILL_BROKER_ROUTE_RUNTIME_STATUS_SQL,
  BACKFILL_BROKER_GENERATION_OBSERVATIONS_SQL,
  BACKFILL_BROKER_ROUTE_FETCH_CURSORS_SQL,
  BACKFILL_BROKER_ROUTE_SEMANTIC_CURSORS_SQL,
  BACKFILL_BROKER_ROUTE_ACTORS_SQL,
]);
