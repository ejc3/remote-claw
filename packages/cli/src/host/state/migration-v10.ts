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

const CREATE_COMMAND_READY_ENTRIES_SQL = `CREATE TABLE command_ready_entries (
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  ready_at_journal_seq INTEGER NOT NULL CHECK (
    ready_at_journal_seq BETWEEN 0 AND 9007199254740991
  ),
  command_id TEXT NOT NULL CHECK (
    length(command_id) = 47
    AND substr(command_id, 1, 4) = 'rcm_'
    AND command_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  stable_semantic_result_id TEXT NOT NULL CHECK (
    length(stable_semantic_result_id) = 47
    AND substr(stable_semantic_result_id, 1, 4) = 'rrs_'
    AND stable_semantic_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_lease_id TEXT NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  ready_at_ms INTEGER NOT NULL CHECK (
    ready_at_ms BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (collaboration_server_id, ready_at_journal_seq),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id),
  FOREIGN KEY (stable_semantic_result_id)
    REFERENCES authenticated_ingress_results (stable_semantic_result_id),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    ),
  FOREIGN KEY (collaboration_server_id, command_id)
    REFERENCES collaboration_commands (collaboration_server_id, command_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_A1_INGRESS_ADJUDICATIONS_SQL = `CREATE TABLE a1_ingress_adjudications (
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
  command_id TEXT NOT NULL CHECK (
    length(command_id) = 47
    AND substr(command_id, 1, 4) = 'rcm_'
    AND command_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  ready_at_journal_seq INTEGER NOT NULL CHECK (
    ready_at_journal_seq BETWEEN 0 AND 9007199254740991
  ),
  command_seq INTEGER CHECK (
    command_seq IS NULL OR command_seq BETWEEN 0 AND 9007199254740991
  ),
  disposition TEXT CHECK (
    disposition IS NULL OR disposition IN ('admitted', 'queued', 'rejected')
  ),
  command_result_id TEXT CHECK (
    command_result_id IS NULL OR (
      length(command_result_id) = 47
      AND substr(command_result_id, 1, 4) = 'ccr_'
      AND command_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  command_result_preparation_id TEXT CHECK (
    command_result_preparation_id IS NULL OR (
      length(command_result_preparation_id) = 47
      AND substr(command_result_preparation_id, 1, 4) = 'crp_'
      AND command_result_preparation_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  viewer_projection_seq INTEGER CHECK (
    viewer_projection_seq IS NULL
    OR viewer_projection_seq BETWEEN 0 AND 9007199254740991
  ),
  decided_at_ms INTEGER CHECK (
    decided_at_ms IS NULL OR decided_at_ms BETWEEN 0 AND 9007199254740991
  ),
  terminal_at_ms INTEGER CHECK (
    terminal_at_ms IS NULL OR terminal_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('awaiting_order', 'deciding', 'terminal')),
  CHECK (
    (state = 'awaiting_order'
      AND command_seq IS NULL
      AND disposition IS NULL
      AND command_result_id IS NULL
      AND command_result_preparation_id IS NULL
      AND viewer_projection_seq IS NULL
      AND decided_at_ms IS NULL
      AND terminal_at_ms IS NULL)
    OR (state = 'deciding'
      AND command_seq IS NOT NULL
      AND disposition IS NOT NULL
      AND command_result_id IS NOT NULL
      AND command_result_preparation_id IS NOT NULL
      AND viewer_projection_seq IS NULL
      AND decided_at_ms IS NOT NULL
      AND terminal_at_ms IS NULL)
    OR (state = 'terminal'
      AND command_seq IS NOT NULL
      AND disposition IS NOT NULL
      AND command_result_id IS NOT NULL
      AND command_result_preparation_id IS NOT NULL
      AND decided_at_ms IS NOT NULL
      AND terminal_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (stable_semantic_result_id)
    REFERENCES authenticated_ingress_results (stable_semantic_result_id),
  FOREIGN KEY (collaboration_server_id, command_id)
    REFERENCES collaboration_commands (collaboration_server_id, command_id),
  FOREIGN KEY (collaboration_server_id, ready_at_journal_seq, command_id)
    REFERENCES command_ready_entries (
      collaboration_server_id,
      ready_at_journal_seq,
      command_id
    ),
  FOREIGN KEY (command_result_preparation_id)
    REFERENCES collaboration_command_result_preparations (
      command_result_preparation_id
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_COLLABORATION_COMMANDS_SQL = `CREATE TABLE collaboration_commands (
  command_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(command_id) = 47
    AND substr(command_id, 1, 4) = 'rcm_'
    AND command_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
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
  source_kind TEXT NOT NULL CHECK (source_kind = 'a1_ingress'),
  source_ref TEXT NOT NULL CHECK (
    length(source_ref) = 47
    AND substr(source_ref, 1, 4) = 'rrs_'
    AND source_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_event_namespace_id TEXT NOT NULL CHECK (
    length(source_event_namespace_id) = 47
    AND substr(source_event_namespace_id, 1, 4) = 'wns_'
    AND source_event_namespace_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_event_id TEXT NOT NULL CHECK (
    length(source_event_id) BETWEEN 1 AND 128
    AND source_event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_command_identity_digest TEXT NOT NULL CHECK (
    length(source_command_identity_digest) = 43
    AND source_command_identity_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  canonical_source_event_digest TEXT CHECK (canonical_source_event_digest IS NULL),
  mutation_family TEXT NOT NULL CHECK (mutation_family IN (
    'user_text', 'steer_text', 'blank_submit', 'attachment', 'new_chat', 'clear',
    'interrupt', 'compact', 'permission_answer', 'question_answer', 'set_model',
    'set_mode', 'end', 'fork', 'archive', 'unarchive', 'revert', 'unrevert',
    'shell', 'session_command', 'message_mutation', 'part_mutation', 'share',
    'rename', 'delete'
  )),
  canonical_command_payload_schema_id TEXT NOT NULL CHECK (
    length(canonical_command_payload_schema_id) BETWEEN 1 AND 1024
  ),
  canonical_command_payload_ref TEXT NOT NULL CHECK (
    length(canonical_command_payload_ref) = 27
    AND substr(canonical_command_payload_ref, 1, 5) = 'rcph_'
    AND canonical_command_payload_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  canonical_command_payload_digest TEXT NOT NULL CHECK (
    length(canonical_command_payload_digest) = 43
    AND canonical_command_payload_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  pre_decision_normalization_evidence_schema_id TEXT CHECK (
    pre_decision_normalization_evidence_schema_id IS NULL
    OR pre_decision_normalization_evidence_schema_id =
      'remote-claw/opencode-pre-decision-normalization/v1'
  ),
  pre_decision_normalization_evidence_ref TEXT CHECK (
    pre_decision_normalization_evidence_ref IS NULL OR (
      length(pre_decision_normalization_evidence_ref) = 27
      AND substr(pre_decision_normalization_evidence_ref, 1, 5) = 'rcph_'
      AND pre_decision_normalization_evidence_ref NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  pre_decision_normalization_evidence_digest TEXT CHECK (
    pre_decision_normalization_evidence_digest IS NULL OR (
      length(pre_decision_normalization_evidence_digest) = 43
      AND pre_decision_normalization_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  ready_at_journal_seq INTEGER NOT NULL CHECK (
    ready_at_journal_seq BETWEEN 0 AND 9007199254740991
  ),
  command_seq INTEGER CHECK (
    command_seq IS NULL OR command_seq BETWEEN 0 AND 9007199254740991
  ),
  disposition TEXT CHECK (
    disposition IS NULL OR disposition IN ('admitted', 'queued', 'rejected')
  ),
  admitted_target_kind TEXT CHECK (
    admitted_target_kind IS NULL OR admitted_target_kind IN (
      'native_server', 'native_binding', 'nested_management', 'nested_chat_edge'
    )
  ),
  project_target_selector_mapping_id TEXT,
  project_target_selector_mapping_generation INTEGER CHECK (
    project_target_selector_mapping_generation IS NULL
    OR project_target_selector_mapping_generation BETWEEN 1 AND 9007199254740991
  ),
  project_target_digest TEXT CHECK (
    project_target_digest IS NULL OR (
      length(project_target_digest) = 43
      AND project_target_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  selected_executor_evidence_schema_id TEXT CHECK (
    selected_executor_evidence_schema_id IS NULL OR selected_executor_evidence_schema_id IN (
      'remote-claw/executor-evidence/native-server/v1',
      'remote-claw/executor-evidence/native-binding/v1',
      'remote-claw/executor-evidence/nested-management/v1',
      'remote-claw/executor-evidence/nested-chat-edge/v1'
    )
  ),
  selected_executor_evidence_ref TEXT CHECK (
    selected_executor_evidence_ref IS NULL OR (
      length(selected_executor_evidence_ref) = 27
      AND substr(selected_executor_evidence_ref, 1, 5) = 'rcph_'
      AND selected_executor_evidence_ref NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  selected_executor_evidence_digest TEXT CHECK (
    selected_executor_evidence_digest IS NULL OR (
      length(selected_executor_evidence_digest) = 43
      AND selected_executor_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  target_capability_snapshot_id TEXT,
  target_capability_family_digest TEXT CHECK (
    target_capability_family_digest IS NULL OR (
      length(target_capability_family_digest) = 43
      AND target_capability_family_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  current_command_result_id TEXT CHECK (
    current_command_result_id IS NULL OR (
      length(current_command_result_id) = 47
      AND substr(current_command_result_id, 1, 4) = 'ccr_'
      AND current_command_result_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  decision_evidence_schema_id TEXT CHECK (
    decision_evidence_schema_id IS NULL OR decision_evidence_schema_id =
      'remote-claw/collaboration-command-decision-evidence/v1'
  ),
  decision_evidence_ref TEXT CHECK (
    decision_evidence_ref IS NULL OR (
      length(decision_evidence_ref) = 27
      AND substr(decision_evidence_ref, 1, 5) = 'rcph_'
      AND decision_evidence_ref NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  decision_evidence_digest TEXT CHECK (
    decision_evidence_digest IS NULL OR (
      length(decision_evidence_digest) = 43
      AND decision_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  canonical_command_record_digest TEXT CHECK (
    canonical_command_record_digest IS NULL OR (
      length(canonical_command_record_digest) = 43
      AND canonical_command_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  coordinator_lease_id TEXT NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  decision_coordinator_lease_id TEXT CHECK (
    decision_coordinator_lease_id IS NULL OR (
      length(decision_coordinator_lease_id) = 27
      AND substr(decision_coordinator_lease_id, 1, 5) = 'rccl_'
      AND decision_coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  decision_coordinator_epoch INTEGER CHECK (
    decision_coordinator_epoch IS NULL
    OR decision_coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  decided_at_ms INTEGER CHECK (
    decided_at_ms IS NULL OR decided_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('awaiting_order', 'decision_reserved', 'decided')),
  CHECK (
    (scope_kind = 'server_control' AND logical_chat_id IS NULL)
    OR (scope_kind = 'chat' AND logical_chat_id IS NOT NULL)
  ),
  CHECK (
    (scope_kind = 'server_control' AND mutation_family = 'new_chat')
    OR (scope_kind = 'chat' AND mutation_family <> 'new_chat')
  ),
  CHECK (
    (scope_kind = 'server_control' AND (
      target_logical_chat_id IS NULL
      OR (disposition IS NOT NULL AND disposition = 'admitted')
    )) OR (scope_kind = 'chat'
      AND target_logical_chat_id IS NOT NULL
      AND target_logical_chat_id = logical_chat_id)
  ),
  CHECK (
    (project_target_selector_mapping_id IS NULL
      AND project_target_selector_mapping_generation IS NULL
      AND project_target_digest IS NULL)
    OR (project_target_selector_mapping_id IS NOT NULL
      AND project_target_selector_mapping_generation IS NOT NULL
      AND project_target_digest IS NOT NULL)
  ),
  CHECK (
    (selected_executor_evidence_schema_id IS NULL
      AND selected_executor_evidence_ref IS NULL
      AND selected_executor_evidence_digest IS NULL)
    OR (selected_executor_evidence_schema_id IS NOT NULL
      AND selected_executor_evidence_ref IS NOT NULL
      AND selected_executor_evidence_digest IS NOT NULL)
  ),
  CHECK (
    (pre_decision_normalization_evidence_schema_id IS NULL
      AND pre_decision_normalization_evidence_ref IS NULL
      AND pre_decision_normalization_evidence_digest IS NULL)
    OR (pre_decision_normalization_evidence_schema_id IS NOT NULL
      AND pre_decision_normalization_evidence_ref IS NOT NULL
      AND pre_decision_normalization_evidence_digest IS NOT NULL)
  ),
  CHECK (
    (decision_coordinator_lease_id IS NULL AND decision_coordinator_epoch IS NULL)
    OR (decision_coordinator_lease_id IS NOT NULL
      AND decision_coordinator_epoch IS NOT NULL)
  ),
  CHECK (
    (state = 'awaiting_order'
      AND command_seq IS NULL
      AND disposition IS NULL
      AND admitted_target_kind IS NULL
      AND project_target_selector_mapping_id IS NULL
      AND selected_executor_evidence_schema_id IS NULL
      AND target_capability_snapshot_id IS NULL
      AND target_capability_family_digest IS NULL
      AND current_command_result_id IS NULL
      AND decision_evidence_schema_id IS NULL
      AND decision_evidence_ref IS NULL
      AND decision_evidence_digest IS NULL
      AND canonical_command_record_digest IS NULL
      AND decision_coordinator_lease_id IS NULL
      AND decision_coordinator_epoch IS NULL
      AND decided_at_ms IS NULL)
    OR (state IN ('decision_reserved', 'decided')
      AND command_seq IS NOT NULL
      AND disposition IS NOT NULL
      AND decision_evidence_schema_id =
        'remote-claw/collaboration-command-decision-evidence/v1'
      AND decision_evidence_ref IS NOT NULL
      AND decision_evidence_digest IS NOT NULL
      AND canonical_command_record_digest IS NOT NULL
      AND decision_coordinator_lease_id IS NOT NULL
      AND decision_coordinator_epoch IS NOT NULL
      AND decided_at_ms IS NOT NULL
      AND ((disposition = 'admitted'
        AND admitted_target_kind IS NOT NULL
        AND selected_executor_evidence_schema_id IS NOT NULL
        AND target_capability_snapshot_id IS NOT NULL
        AND target_capability_family_digest IS NOT NULL)
      OR (disposition IN ('queued', 'rejected')
        AND admitted_target_kind IS NULL
        AND project_target_selector_mapping_id IS NULL
        AND project_target_selector_mapping_generation IS NULL
        AND project_target_digest IS NULL
        AND selected_executor_evidence_schema_id IS NULL
        AND target_capability_snapshot_id IS NULL
        AND target_capability_family_digest IS NULL))
      AND ((state = 'decision_reserved' AND current_command_result_id IS NULL)
        OR (state = 'decided' AND current_command_result_id IS NOT NULL)))
  ),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id),
  FOREIGN KEY (source_ref)
    REFERENCES authenticated_ingress_results (stable_semantic_result_id),
  FOREIGN KEY (canonical_command_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (pre_decision_normalization_evidence_ref)
    REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (decision_evidence_ref)
    REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    ),
  FOREIGN KEY (
    decision_coordinator_lease_id,
    collaboration_server_id,
    decision_coordinator_epoch
  ) REFERENCES coordinator_leases (
    coordinator_lease_id,
    collaboration_server_id,
    coordinator_epoch
  ),
  FOREIGN KEY (collaboration_server_id, ready_at_journal_seq, command_id)
    REFERENCES command_ready_entries (
      collaboration_server_id,
      ready_at_journal_seq,
      command_id
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_COMPOUND_SIGNING_GROUPS_SQL = `CREATE TABLE collaboration_command_compound_signing_groups (
  compound_signing_group_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(compound_signing_group_id) = 47
    AND substr(compound_signing_group_id, 1, 4) = 'csg_'
    AND compound_signing_group_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL,
  command_id TEXT NOT NULL CHECK (
    length(command_id) = 47 AND substr(command_id, 1, 4) = 'rcm_'
  ),
  command_result_id TEXT NOT NULL CHECK (
    length(command_result_id) = 47 AND substr(command_result_id, 1, 4) = 'ccr_'
  ),
  preparation_generation INTEGER NOT NULL CHECK (
    preparation_generation BETWEEN 1 AND 9007199254740991
  ),
  signing_lease_id TEXT NOT NULL CHECK (
    length(signing_lease_id) BETWEEN 1 AND 128
    AND signing_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  result_preparation_ref TEXT NOT NULL CHECK (
    length(result_preparation_ref) = 47
    AND substr(result_preparation_ref, 1, 4) = 'crp_'
    AND result_preparation_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  required_finalization_artifact_kind TEXT NOT NULL CHECK (
    required_finalization_artifact_kind = 'none'
  ),
  secondary_preparation_ref TEXT CHECK (secondary_preparation_ref IS NULL),
  reserved_at_ms INTEGER NOT NULL CHECK (
    reserved_at_ms BETWEEN 0 AND 9007199254740991
  ),
  result_signed_at_ms INTEGER CHECK (
    result_signed_at_ms IS NULL
    OR result_signed_at_ms BETWEEN reserved_at_ms AND 9007199254740991
  ),
  both_signed_at_ms INTEGER CHECK (both_signed_at_ms IS NULL),
  finalized_at_ms INTEGER CHECK (finalized_at_ms IS NULL),
  aborted_at_ms INTEGER CHECK (
    aborted_at_ms IS NULL OR aborted_at_ms BETWEEN reserved_at_ms AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (
    state IN ('reserved', 'result_signed', 'both_signed', 'finalized', 'aborted')
  ),
  CHECK (
    (state = 'reserved' AND result_signed_at_ms IS NULL AND aborted_at_ms IS NULL)
    OR (state = 'result_signed' AND result_signed_at_ms IS NOT NULL AND aborted_at_ms IS NULL)
    OR (state = 'aborted' AND aborted_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (collaboration_server_id, command_id)
    REFERENCES collaboration_commands (collaboration_server_id, command_id),
  FOREIGN KEY (signing_lease_id)
    REFERENCES server_signing_leases (signing_lease_id),
  FOREIGN KEY (result_preparation_ref)
    REFERENCES collaboration_command_result_preparations (
      command_result_preparation_id
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_RESULT_PREPARATIONS_SQL = `CREATE TABLE collaboration_command_result_preparations (
  command_result_preparation_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(command_result_preparation_id) = 47
    AND substr(command_result_preparation_id, 1, 4) = 'crp_'
    AND command_result_preparation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  command_result_id TEXT NOT NULL CHECK (
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
  preparation_generation INTEGER NOT NULL CHECK (
    preparation_generation BETWEEN 1 AND 9007199254740991
  ),
  supersedes_preparation_ref TEXT CHECK (
    supersedes_preparation_ref IS NULL OR (
      length(supersedes_preparation_ref) = 47
      AND substr(supersedes_preparation_ref, 1, 4) = 'crp_'
      AND supersedes_preparation_ref NOT GLOB '*[^A-Za-z0-9_-]*'
      AND supersedes_preparation_ref <> command_result_preparation_id
    )
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
  signer_sequence INTEGER NOT NULL CHECK (
    signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  signing_lease_id TEXT NOT NULL CHECK (
    length(signing_lease_id) BETWEEN 1 AND 128
    AND signing_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  compound_signing_group_id TEXT NOT NULL CHECK (
    length(compound_signing_group_id) = 47
    AND substr(compound_signing_group_id, 1, 4) = 'csg_'
    AND compound_signing_group_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  required_finalization_artifact_kind TEXT NOT NULL CHECK (
    required_finalization_artifact_kind = 'none'
  ),
  current_finalization_artifact_preparation_ref TEXT CHECK (
    current_finalization_artifact_preparation_ref IS NULL
  ),
  prepared_at_ms INTEGER NOT NULL CHECK (
    prepared_at_ms BETWEEN 0 AND 9007199254740991
  ),
  bound_at_ms INTEGER CHECK (
    bound_at_ms IS NULL OR bound_at_ms BETWEEN prepared_at_ms AND 9007199254740991
  ),
  signed_at_ms INTEGER CHECK (
    signed_at_ms IS NULL OR signed_at_ms BETWEEN COALESCE(bound_at_ms, prepared_at_ms)
      AND 9007199254740991
  ),
  aborted_at_ms INTEGER CHECK (
    aborted_at_ms IS NULL OR aborted_at_ms BETWEEN prepared_at_ms AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'bound', 'signed', 'aborted')),
  CHECK (
    (state = 'reserved' AND bound_at_ms IS NULL AND signed_at_ms IS NULL AND aborted_at_ms IS NULL)
    OR (state = 'bound' AND bound_at_ms IS NOT NULL AND signed_at_ms IS NULL AND aborted_at_ms IS NULL)
    OR (state = 'signed' AND bound_at_ms IS NOT NULL AND signed_at_ms IS NOT NULL AND aborted_at_ms IS NULL)
    OR (state = 'aborted' AND signed_at_ms IS NULL AND aborted_at_ms IS NOT NULL)
  ),
  CHECK (
    (preparation_generation = 1 AND supersedes_preparation_ref IS NULL)
    OR (preparation_generation > 1 AND supersedes_preparation_ref IS NOT NULL)
  ),
  FOREIGN KEY (collaboration_server_id, command_id)
    REFERENCES collaboration_commands (collaboration_server_id, command_id),
  FOREIGN KEY (canonical_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (collaboration_server_id, signer_sequence)
    REFERENCES server_signature_reservations (
      collaboration_server_id,
      signer_sequence
    ),
  FOREIGN KEY (signing_lease_id)
    REFERENCES server_signing_leases (signing_lease_id),
  FOREIGN KEY (compound_signing_group_id)
    REFERENCES collaboration_command_compound_signing_groups (
      compound_signing_group_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (supersedes_preparation_ref)
    REFERENCES collaboration_command_result_preparations (
      command_result_preparation_id
    )
) STRICT, WITHOUT ROWID`;

const CREATE_READY_COMMAND_INDEX_SQL = `CREATE UNIQUE INDEX command_ready_entries_command_unique
ON command_ready_entries (collaboration_server_id, command_id)`;

const CREATE_READY_COORDINATE_INDEX_SQL = `CREATE UNIQUE INDEX command_ready_entries_coordinate_unique
ON command_ready_entries (collaboration_server_id, ready_at_journal_seq, command_id)`;

const CREATE_READY_SOURCE_INDEX_SQL = `CREATE UNIQUE INDEX command_ready_entries_source_unique
ON command_ready_entries (stable_semantic_result_id)`;

const CREATE_COMMAND_SERVER_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_commands_server_unique
ON collaboration_commands (collaboration_server_id, command_id)`;

const CREATE_COMMAND_READY_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_commands_ready_unique
ON collaboration_commands (collaboration_server_id, ready_at_journal_seq, command_id)`;

const CREATE_COMMAND_SEQUENCE_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_commands_sequence_unique
ON collaboration_commands (collaboration_server_id, command_seq)
WHERE command_seq IS NOT NULL`;

const CREATE_COMMAND_READY_ORDER_INDEX_SQL = `CREATE INDEX collaboration_commands_ready_order
ON collaboration_commands (collaboration_server_id, state, ready_at_journal_seq, command_id)`;

const CREATE_GROUP_PREPARATION_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_groups_preparation_unique
ON collaboration_command_compound_signing_groups (
  collaboration_server_id,
  command_id,
  command_result_id,
  preparation_generation
)`;

const CREATE_PREPARATION_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_result_preparations_generation_unique
ON collaboration_command_result_preparations (
  collaboration_server_id,
  command_result_id,
  preparation_generation
)`;

const CREATE_PREPARATION_SIGNER_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_result_preparations_signer_unique
ON collaboration_command_result_preparations (collaboration_server_id, signer_sequence)`;

const CREATE_PREPARATION_GROUP_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_result_preparations_group_unique
ON collaboration_command_result_preparations (
  compound_signing_group_id,
  command_result_preparation_id
)`;

const CREATE_GROUP_ACTIVE_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_groups_one_active_unique
ON collaboration_command_compound_signing_groups (
  collaboration_server_id,
  command_result_id
)
WHERE state IN ('reserved', 'result_signed')`;

const CREATE_GROUP_SERVER_ACTIVE_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_groups_one_server_active_unique
ON collaboration_command_compound_signing_groups (collaboration_server_id)
WHERE state IN ('reserved', 'result_signed')`;

const CREATE_PREPARATION_ACTIVE_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_command_result_preparations_one_active_unique
ON collaboration_command_result_preparations (
  collaboration_server_id,
  command_result_id
)
WHERE state IN ('reserved', 'bound', 'signed')`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_require_current_authority
BEFORE INSERT ON server_signature_reservations
WHEN NEW.state <> 'reserved' OR NOT EXISTS (
  SELECT 1
  FROM collaboration_servers AS server
  WHERE server.collaboration_server_id = NEW.collaboration_server_id
    AND server.next_server_signature_seq = NEW.signer_sequence
    AND (
      (NEW.signing_lease_kind = 'bootstrap'
        AND NEW.purpose = 'scope_certificate'
        AND NEW.signer_sequence = 0
        AND EXISTS (
          SELECT 1
          FROM server_bootstrap_signing_leases AS bootstrap
          JOIN coordinator_leases AS coordinator
            ON coordinator.coordinator_lease_id = bootstrap.coordinator_lease_id
           AND coordinator.collaboration_server_id = bootstrap.collaboration_server_id
           AND coordinator.coordinator_epoch = bootstrap.coordinator_epoch
          JOIN server_identity_private_key_envelopes AS private_key
            ON private_key.signing_key_ref = bootstrap.signing_key_ref
           AND private_key.collaboration_server_id = bootstrap.collaboration_server_id
           AND private_key.identity_key_id = bootstrap.proposed_identity_key_id
           AND private_key.key_generation = bootstrap.proposed_key_generation
          WHERE bootstrap.bootstrap_signing_lease_id = NEW.signing_lease_id
            AND bootstrap.collaboration_server_id = NEW.collaboration_server_id
            AND bootstrap.purpose = 'initial_pair'
            AND bootstrap.state = 'prepared'
            AND bootstrap.prepared_at_ms = NEW.reserved_at_ms
            AND server.state = 'installing'
            AND server.current_coordinator_lease_id = bootstrap.coordinator_lease_id
            AND server.current_coordinator_epoch = bootstrap.coordinator_epoch
            AND coordinator.state = 'current'
            AND coordinator.released_at_ms IS NULL
            AND coordinator.acquired_at_ms <= NEW.reserved_at_ms
            AND NEW.reserved_at_ms < coordinator.heartbeat_deadline_ms
            AND private_key.state = 'current'
        ))
      OR (NEW.signing_lease_kind = 'current'
        AND NEW.purpose = 'collaboration_command_result'
        AND EXISTS (
          SELECT 1
          FROM server_signing_leases AS signing_lease
          JOIN coordinator_leases AS coordinator
            ON coordinator.coordinator_lease_id = signing_lease.coordinator_lease_id
           AND coordinator.collaboration_server_id = signing_lease.collaboration_server_id
           AND coordinator.coordinator_epoch = signing_lease.coordinator_epoch
          JOIN server_identity_keys AS identity_key
            ON identity_key.collaboration_server_id = signing_lease.collaboration_server_id
           AND identity_key.identity_key_id = signing_lease.identity_key_id
           AND identity_key.key_generation = signing_lease.key_generation
          JOIN server_identity_private_key_envelopes AS private_key
            ON private_key.signing_key_ref = identity_key.signing_key_ref
           AND private_key.collaboration_server_id = identity_key.collaboration_server_id
           AND private_key.identity_key_id = identity_key.identity_key_id
           AND private_key.key_generation = identity_key.key_generation
          JOIN server_scope_certificate_statuses AS certificate_status
            ON certificate_status.collaboration_server_id = signing_lease.collaboration_server_id
           AND certificate_status.scope_certificate_id = signing_lease.scope_certificate_id
          WHERE signing_lease.signing_lease_id = NEW.signing_lease_id
            AND signing_lease.collaboration_server_id = NEW.collaboration_server_id
            AND signing_lease.state = 'current'
            AND server.state = 'current'
            AND server.current_identity_key_id = signing_lease.identity_key_id
            AND server.current_key_generation = signing_lease.key_generation
            AND server.current_scope_certificate_id = signing_lease.scope_certificate_id
            AND server.current_coordinator_lease_id = signing_lease.coordinator_lease_id
            AND server.current_coordinator_epoch = signing_lease.coordinator_epoch
            AND coordinator.state = 'current'
            AND coordinator.released_at_ms IS NULL
            AND signing_lease.acquired_at_ms <= NEW.reserved_at_ms
            AND coordinator.acquired_at_ms <= NEW.reserved_at_ms
            AND NEW.reserved_at_ms < coordinator.heartbeat_deadline_ms
            AND identity_key.state = 'current'
            AND private_key.state = 'current'
            AND certificate_status.state = 'current'
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signature reservation requires the exact current signing authority');
END`;

const CREATE_READY_REQUIRE_EXACT_COMMAND_TRIGGER_SQL = `CREATE TRIGGER command_ready_entries_require_exact_command
BEFORE INSERT ON command_ready_entries
BEGIN
  SELECT CASE WHEN NEW.ready_at_journal_seq <> (
    SELECT next_journal_offset FROM collaboration_servers
    WHERE collaboration_server_id = NEW.collaboration_server_id
  ) OR NEW.ready_at_journal_seq >= 9007199254740991
  THEN RAISE(ABORT, 'command ready entry requires the next server journal sequence') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_servers AS server
    JOIN coordinator_leases AS coordinator
      ON coordinator.coordinator_lease_id = NEW.coordinator_lease_id
     AND coordinator.collaboration_server_id = NEW.collaboration_server_id
     AND coordinator.coordinator_epoch = NEW.coordinator_epoch
    WHERE server.collaboration_server_id = NEW.collaboration_server_id
      AND server.state = 'current'
      AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
      AND server.current_coordinator_epoch = NEW.coordinator_epoch
      AND coordinator.state = 'current'
      AND coordinator.released_at_ms IS NULL
      AND coordinator.acquired_at_ms <= NEW.ready_at_ms
      AND NEW.ready_at_ms < coordinator.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, 'command ready entry requires the unexpired current coordinator') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_commands AS command
    JOIN authenticated_ingress_results AS ingress
      ON ingress.stable_semantic_result_id = NEW.stable_semantic_result_id
     AND ingress.collaboration_server_id = NEW.collaboration_server_id
     AND ingress.state = 'awaiting_order'
     AND ingress.source_payload_schema_id IS NOT NULL
     AND ingress.canonical_message_digest IS NOT NULL
     AND ingress.source_event_fingerprint_schema_id =
       'remote-claw/a1/source-event-fingerprint/v1'
     AND ingress.source_event_fingerprint IS NOT NULL
     AND ingress.accepted_delivery_attempt_id IS NOT NULL
    WHERE command.command_id = NEW.command_id
      AND command.collaboration_server_id = NEW.collaboration_server_id
      AND command.ready_at_journal_seq = NEW.ready_at_journal_seq
      AND command.source_kind = 'a1_ingress'
      AND command.source_ref = NEW.stable_semantic_result_id
      AND command.source_event_namespace_id = ingress.source_event_namespace_id
      AND command.source_event_id = ingress.message_id
      AND command.coordinator_lease_id = NEW.coordinator_lease_id
      AND command.coordinator_epoch = NEW.coordinator_epoch
      AND command.created_at_ms = NEW.ready_at_ms
      AND command.state = 'awaiting_order'
  ) THEN RAISE(ABORT, 'command ready entry requires its exact complete A1 command') END;
END`;

const CREATE_READY_INCREMENT_JOURNAL_TRIGGER_SQL = `CREATE TRIGGER command_ready_entries_increment_journal
AFTER INSERT ON command_ready_entries
BEGIN
  UPDATE collaboration_servers
     SET next_journal_offset = next_journal_offset + 1
   WHERE collaboration_server_id = NEW.collaboration_server_id
     AND next_journal_offset = NEW.ready_at_journal_seq;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'command ready journal advance lost its compare-and-swap') END;
END`;

const CREATE_READY_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER command_ready_entries_no_update
BEFORE UPDATE ON command_ready_entries
BEGIN
  SELECT RAISE(ABORT, 'command ready entries are immutable');
END`;

const CREATE_READY_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER command_ready_entries_no_delete
BEFORE DELETE ON command_ready_entries
BEGIN
  SELECT RAISE(ABORT, 'command ready entries are retained');
END`;

const CREATE_READY_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER command_ready_entries_no_replace
BEFORE INSERT ON command_ready_entries
WHEN EXISTS (
  SELECT 1 FROM command_ready_entries
  WHERE stable_semantic_result_id = NEW.stable_semantic_result_id
     OR (collaboration_server_id = NEW.collaboration_server_id
       AND (ready_at_journal_seq = NEW.ready_at_journal_seq
         OR command_id = NEW.command_id))
)
BEGIN
  SELECT RAISE(ABORT, 'command ready entries are immutable');
END`;

const CREATE_COMMAND_REQUIRE_INITIAL_TRIGGER_SQL = `CREATE TRIGGER collaboration_commands_require_initial_awaiting_order
BEFORE INSERT ON collaboration_commands
BEGIN
  SELECT CASE WHEN NEW.state <> 'awaiting_order'
    OR NEW.command_seq IS NOT NULL
    OR NEW.disposition IS NOT NULL
    OR NEW.current_command_result_id IS NOT NULL
    OR NEW.decision_evidence_schema_id IS NOT NULL
    OR NEW.canonical_command_record_digest IS NOT NULL
    OR NEW.decision_coordinator_lease_id IS NOT NULL
    OR NEW.decision_coordinator_epoch IS NOT NULL
    OR NEW.decided_at_ms IS NOT NULL
    OR (NEW.scope_kind = 'server_control' AND NEW.target_logical_chat_id IS NOT NULL)
    OR (NEW.scope_kind = 'chat' AND (
      NEW.target_logical_chat_id IS NULL
      OR NEW.target_logical_chat_id <> NEW.logical_chat_id
    ))
    OR NEW.pre_decision_normalization_evidence_schema_id IS NOT NULL
    OR NEW.pre_decision_normalization_evidence_ref IS NOT NULL
    OR NEW.pre_decision_normalization_evidence_digest IS NOT NULL
  THEN RAISE(ABORT, 'collaboration command must begin awaiting order') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM authenticated_ingress_results AS ingress
    JOIN broker_route_runtime_status AS route_status
      ON route_status.broker_route_id = ingress.broker_route_id
     AND route_status.collaboration_server_id = ingress.collaboration_server_id
     AND route_status.route_kind = ingress.route_kind
     AND route_status.logical_chat_id IS ingress.logical_chat_id
    WHERE ingress.stable_semantic_result_id = NEW.source_ref
      AND ingress.collaboration_server_id = NEW.collaboration_server_id
      AND ingress.route_kind = NEW.scope_kind
      AND ingress.logical_chat_id IS NEW.logical_chat_id
      AND ingress.source_event_namespace_id = NEW.source_event_namespace_id
      AND ingress.message_id = NEW.source_event_id
      AND ingress.state = 'awaiting_order'
      AND ingress.source_payload_schema_id IS NOT NULL
      AND ingress.canonical_message_digest IS NOT NULL
      AND ingress.source_event_fingerprint_schema_id =
        'remote-claw/a1/source-event-fingerprint/v1'
      AND ingress.source_event_fingerprint IS NOT NULL
      AND ingress.accepted_delivery_attempt_id IS NOT NULL
      AND route_status.state = 'current'
      AND route_status.active_gap_count = 0
      AND route_status.updated_at_ms <= NEW.created_at_ms
      AND ((NEW.scope_kind = 'server_control' AND ingress.record_kind = 'new_chat')
        OR (NEW.scope_kind = 'chat' AND ingress.record_kind = 'user'))
      AND (
        (ingress.record_kind = 'user' AND (
          NEW.mutation_family = 'user_text'
          AND NEW.canonical_command_payload_schema_id =
            'remote-claw/command-payload/unsupported-recognized/v1'
        ))
        OR (ingress.record_kind = 'new_chat'
          AND NEW.mutation_family = 'new_chat'
          AND NEW.canonical_command_payload_schema_id =
            'remote-claw/command-payload/unsupported-recognized/v1')
      )
      AND NOT EXISTS (
        SELECT 1 FROM authenticated_ingress_results AS earlier
        WHERE earlier.broker_route_id = ingress.broker_route_id
          AND earlier.state IN ('assembling', 'awaiting_order')
          AND NOT EXISTS (
            SELECT 1 FROM a1_ingress_adjudications AS earlier_adjudication
            WHERE earlier_adjudication.stable_semantic_result_id =
              earlier.stable_semantic_result_id
          )
          AND (
            earlier.first_ingress_generation < ingress.first_ingress_generation
            OR (earlier.first_ingress_generation = ingress.first_ingress_generation
              AND earlier.first_ingress_frame_index < ingress.first_ingress_frame_index)
            OR (earlier.first_ingress_generation = ingress.first_ingress_generation
              AND earlier.first_ingress_frame_index = ingress.first_ingress_frame_index
              AND earlier.stable_semantic_result_id < ingress.stable_semantic_result_id)
          )
      )
  ) THEN RAISE(ABORT, 'collaboration command requires its exact complete A1 ingress source') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
    WHERE artifact.protected_handle_id = NEW.canonical_command_payload_ref
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'collaboration_server'
      AND artifact.scope_id = NEW.collaboration_server_id
      AND artifact.artifact_schema_id = NEW.canonical_command_payload_schema_id
      AND artifact.artifact_digest = NEW.canonical_command_payload_digest
  ) THEN RAISE(ABORT, 'collaboration command requires its exact canonical payload artifact') END;
  SELECT CASE WHEN NEW.pre_decision_normalization_evidence_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
    WHERE artifact.protected_handle_id = NEW.pre_decision_normalization_evidence_ref
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'collaboration_server'
      AND artifact.scope_id = NEW.collaboration_server_id
      AND artifact.artifact_schema_id = NEW.pre_decision_normalization_evidence_schema_id
      AND artifact.artifact_digest = NEW.pre_decision_normalization_evidence_digest
  ) THEN RAISE(ABORT, 'collaboration command requires its exact normalization artifact') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_servers AS server
    JOIN coordinator_leases AS coordinator
      ON coordinator.coordinator_lease_id = NEW.coordinator_lease_id
     AND coordinator.collaboration_server_id = NEW.collaboration_server_id
     AND coordinator.coordinator_epoch = NEW.coordinator_epoch
    WHERE server.collaboration_server_id = NEW.collaboration_server_id
      AND server.state = 'current'
      AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
      AND server.current_coordinator_epoch = NEW.coordinator_epoch
      AND coordinator.state = 'current'
      AND coordinator.released_at_ms IS NULL
      AND coordinator.acquired_at_ms <= NEW.created_at_ms
      AND NEW.created_at_ms < coordinator.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, 'collaboration command requires the unexpired current coordinator') END;
  SELECT CASE WHEN (
    SELECT count(*) FROM collaboration_commands AS unresolved
    WHERE unresolved.collaboration_server_id = NEW.collaboration_server_id
      AND unresolved.state IN ('awaiting_order', 'decision_reserved')
  ) >= 256
  THEN RAISE(ABORT, 'collaboration server unresolved command limit exceeded') END;
END`;

const CREATE_COMMAND_REQUIRE_DECISION_TRIGGER_SQL = `CREATE TRIGGER collaboration_commands_require_rejected_decision
BEFORE UPDATE ON collaboration_commands
BEGIN
  SELECT CASE WHEN NOT (
    OLD.state = 'awaiting_order'
    AND NEW.state = 'decision_reserved'
    AND NEW.command_id IS OLD.command_id
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
    AND NEW.canonical_command_payload_schema_id IS OLD.canonical_command_payload_schema_id
    AND NEW.canonical_command_payload_ref IS OLD.canonical_command_payload_ref
    AND NEW.canonical_command_payload_digest IS OLD.canonical_command_payload_digest
    AND NEW.pre_decision_normalization_evidence_schema_id IS
      OLD.pre_decision_normalization_evidence_schema_id
    AND NEW.pre_decision_normalization_evidence_ref IS
      OLD.pre_decision_normalization_evidence_ref
    AND NEW.pre_decision_normalization_evidence_digest IS
      OLD.pre_decision_normalization_evidence_digest
    AND NEW.ready_at_journal_seq IS OLD.ready_at_journal_seq
    AND NEW.coordinator_lease_id IS OLD.coordinator_lease_id
    AND NEW.coordinator_epoch IS OLD.coordinator_epoch
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.current_command_result_id IS NULL
    AND NEW.disposition = 'rejected'
    AND NEW.admitted_target_kind IS NULL
    AND NEW.project_target_selector_mapping_id IS NULL
    AND NEW.project_target_selector_mapping_generation IS NULL
    AND NEW.project_target_digest IS NULL
    AND NEW.selected_executor_evidence_schema_id IS NULL
    AND NEW.selected_executor_evidence_ref IS NULL
    AND NEW.selected_executor_evidence_digest IS NULL
    AND NEW.target_capability_snapshot_id IS NULL
    AND NEW.target_capability_family_digest IS NULL
    AND NEW.command_seq IS NOT NULL
    AND NEW.decision_evidence_schema_id =
      'remote-claw/collaboration-command-decision-evidence/v1'
    AND NEW.decision_evidence_ref IS NOT NULL
    AND NEW.decision_evidence_digest IS NOT NULL
    AND NEW.canonical_command_record_digest IS NOT NULL
    AND NEW.decision_coordinator_lease_id IS NOT NULL
    AND NEW.decision_coordinator_epoch IS NOT NULL
    AND NEW.decided_at_ms IS NOT NULL
  ) THEN RAISE(ABORT, 'v10 collaboration commands allow only one frozen rejected decision') END;
  SELECT CASE WHEN NEW.command_seq <> (
    SELECT next_command_seq FROM collaboration_servers
    WHERE collaboration_server_id = OLD.collaboration_server_id
  ) OR NEW.command_seq >= 9007199254740991
  THEN RAISE(ABORT, 'collaboration command requires the next server command sequence') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM collaboration_commands AS earlier
    WHERE earlier.collaboration_server_id = OLD.collaboration_server_id
      AND earlier.state = 'awaiting_order'
      AND earlier.command_id <> OLD.command_id
      AND (
        earlier.ready_at_journal_seq < OLD.ready_at_journal_seq
        OR (earlier.ready_at_journal_seq = OLD.ready_at_journal_seq
          AND earlier.command_id < OLD.command_id)
      )
  ) THEN RAISE(ABORT, 'collaboration command decision is not the next ready command') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM authenticated_ingress_results AS ingress
    JOIN broker_route_runtime_status AS route_status
      ON route_status.broker_route_id = ingress.broker_route_id
     AND route_status.collaboration_server_id = ingress.collaboration_server_id
     AND route_status.route_kind = ingress.route_kind
     AND route_status.logical_chat_id IS ingress.logical_chat_id
    WHERE ingress.stable_semantic_result_id = OLD.source_ref
      AND ingress.collaboration_server_id = OLD.collaboration_server_id
      AND ingress.state = 'awaiting_order'
      AND route_status.state = 'current'
      AND route_status.active_gap_count = 0
      AND route_status.updated_at_ms <= NEW.decided_at_ms
  ) THEN RAISE(ABORT, 'collaboration command decision requires its recovered source route') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_servers AS server
    JOIN coordinator_leases AS coordinator
      ON coordinator.coordinator_lease_id = NEW.decision_coordinator_lease_id
     AND coordinator.collaboration_server_id = NEW.collaboration_server_id
     AND coordinator.coordinator_epoch = NEW.decision_coordinator_epoch
    WHERE server.collaboration_server_id = NEW.collaboration_server_id
      AND server.state = 'current'
      AND server.current_coordinator_lease_id = NEW.decision_coordinator_lease_id
      AND server.current_coordinator_epoch = NEW.decision_coordinator_epoch
      AND coordinator.state = 'current'
      AND coordinator.released_at_ms IS NULL
      AND coordinator.acquired_at_ms <= NEW.decided_at_ms
      AND NEW.decided_at_ms < coordinator.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, 'collaboration command decision requires the unexpired current coordinator') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
    WHERE artifact.protected_handle_id = NEW.decision_evidence_ref
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'collaboration_server'
      AND artifact.scope_id = NEW.collaboration_server_id
      AND artifact.artifact_schema_id = NEW.decision_evidence_schema_id
      AND artifact.artifact_digest = NEW.decision_evidence_digest
  ) THEN RAISE(ABORT, 'collaboration command decision requires its exact evidence artifact') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_command_result_preparations AS preparation
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id = preparation.compound_signing_group_id
     AND signing_group.result_preparation_ref = preparation.command_result_preparation_id
     AND signing_group.collaboration_server_id = preparation.collaboration_server_id
     AND signing_group.command_id = preparation.command_id
     AND signing_group.command_result_id = preparation.command_result_id
     AND signing_group.preparation_generation = preparation.preparation_generation
     AND signing_group.signing_lease_id = preparation.signing_lease_id
    JOIN server_signature_reservations AS reservation
      ON reservation.collaboration_server_id = preparation.collaboration_server_id
     AND reservation.signer_sequence = preparation.signer_sequence
     AND reservation.signing_lease_id = preparation.signing_lease_id
    WHERE preparation.collaboration_server_id = NEW.collaboration_server_id
      AND preparation.command_id = NEW.command_id
      AND preparation.canonical_command_record_digest = NEW.canonical_command_record_digest
      AND preparation.prepared_at_ms = NEW.decided_at_ms
      AND preparation.required_finalization_artifact_kind = 'none'
      AND preparation.state IN ('reserved', 'bound', 'signed')
      AND signing_group.reserved_at_ms = NEW.decided_at_ms
      AND signing_group.required_finalization_artifact_kind = 'none'
      AND signing_group.secondary_preparation_ref IS NULL
      AND signing_group.state IN ('reserved', 'result_signed')
      AND reservation.purpose = 'collaboration_command_result'
      AND reservation.reserved_at_ms = NEW.decided_at_ms
      AND reservation.state IN ('reserved', 'bound', 'signed')
  ) THEN RAISE(ABORT, 'collaboration command decision requires its exact inert result preparation') END;
END`;

const CREATE_COMMAND_INCREMENT_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER collaboration_commands_increment_sequence
AFTER UPDATE OF state ON collaboration_commands
WHEN OLD.state = 'awaiting_order' AND NEW.state = 'decision_reserved'
BEGIN
  UPDATE collaboration_servers
     SET next_command_seq = next_command_seq + 1
   WHERE collaboration_server_id = NEW.collaboration_server_id
     AND next_command_seq = NEW.command_seq;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'command sequence advance lost its compare-and-swap') END;
END`;

const CREATE_COMMAND_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER collaboration_commands_no_delete
BEFORE DELETE ON collaboration_commands
BEGIN
  SELECT RAISE(ABORT, 'collaboration commands are retained');
END`;

const CREATE_COMMAND_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER collaboration_commands_no_replace
BEFORE INSERT ON collaboration_commands
WHEN EXISTS (
  SELECT 1 FROM collaboration_commands
  WHERE command_id = NEW.command_id
     OR (collaboration_server_id = NEW.collaboration_server_id
       AND source_kind = NEW.source_kind
       AND source_ref = NEW.source_ref)
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration commands are immutable');
END`;

const CREATE_ADJUDICATION_REQUIRE_READY_TRIGGER_SQL = `CREATE TRIGGER a1_ingress_adjudications_require_ready_source
BEFORE INSERT ON a1_ingress_adjudications
BEGIN
  SELECT CASE WHEN NEW.state <> 'awaiting_order'
  THEN RAISE(ABORT, 'A1 ingress adjudication must begin awaiting order') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM authenticated_ingress_results AS ingress
    JOIN command_ready_entries AS ready
      ON ready.stable_semantic_result_id = ingress.stable_semantic_result_id
     AND ready.collaboration_server_id = ingress.collaboration_server_id
    JOIN collaboration_commands AS command
      ON command.command_id = ready.command_id
     AND command.collaboration_server_id = ready.collaboration_server_id
     AND command.ready_at_journal_seq = ready.ready_at_journal_seq
    WHERE ingress.stable_semantic_result_id = NEW.stable_semantic_result_id
      AND ingress.collaboration_server_id = NEW.collaboration_server_id
      AND ingress.state = 'awaiting_order'
      AND ingress.source_payload_schema_id IS NOT NULL
      AND ingress.canonical_message_digest IS NOT NULL
      AND ingress.source_event_fingerprint_schema_id =
        'remote-claw/a1/source-event-fingerprint/v1'
      AND ingress.source_event_fingerprint IS NOT NULL
      AND ingress.accepted_delivery_attempt_id IS NOT NULL
      AND ready.command_id = NEW.command_id
      AND ready.ready_at_journal_seq = NEW.ready_at_journal_seq
      AND command.source_kind = 'a1_ingress'
      AND command.source_ref = NEW.stable_semantic_result_id
      AND command.state = 'awaiting_order'
  ) THEN RAISE(ABORT, 'A1 ingress adjudication requires its exact ready source and command') END;
END`;

const CREATE_ADJUDICATION_REQUIRE_DECIDING_TRIGGER_SQL = `CREATE TRIGGER a1_ingress_adjudications_require_deciding_transition
BEFORE UPDATE ON a1_ingress_adjudications
BEGIN
  SELECT CASE WHEN NOT (
    NEW.stable_semantic_result_id IS OLD.stable_semantic_result_id
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.command_id IS OLD.command_id
    AND NEW.ready_at_journal_seq IS OLD.ready_at_journal_seq
    AND (
      (OLD.state = 'awaiting_order'
        AND NEW.state = 'deciding'
        AND NEW.command_seq IS NOT NULL
        AND NEW.disposition = 'rejected'
        AND NEW.command_result_id IS NOT NULL
        AND NEW.command_result_preparation_id IS NOT NULL
        AND NEW.viewer_projection_seq IS NULL
        AND NEW.decided_at_ms IS NOT NULL
        AND NEW.terminal_at_ms IS NULL)
      OR (OLD.state = 'deciding'
        AND NEW.state = 'deciding'
        AND NEW.command_seq IS OLD.command_seq
        AND NEW.disposition IS OLD.disposition
        AND NEW.command_result_id IS OLD.command_result_id
        AND NEW.command_result_preparation_id IS NOT
          OLD.command_result_preparation_id
        AND NEW.viewer_projection_seq IS OLD.viewer_projection_seq
        AND NEW.decided_at_ms IS OLD.decided_at_ms
        AND NEW.terminal_at_ms IS OLD.terminal_at_ms)
    )
  ) THEN RAISE(ABORT, 'v10 A1 ingress adjudication may only enter rejected deciding') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_commands AS command
    JOIN collaboration_command_result_preparations AS preparation
      ON preparation.command_result_preparation_id = NEW.command_result_preparation_id
     AND preparation.collaboration_server_id = command.collaboration_server_id
     AND preparation.command_id = command.command_id
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id = preparation.compound_signing_group_id
     AND signing_group.result_preparation_ref = preparation.command_result_preparation_id
    JOIN server_signature_reservations AS reservation
      ON reservation.collaboration_server_id = preparation.collaboration_server_id
     AND reservation.signer_sequence = preparation.signer_sequence
     AND reservation.signing_lease_id = preparation.signing_lease_id
    WHERE command.command_id = NEW.command_id
      AND command.collaboration_server_id = NEW.collaboration_server_id
      AND command.command_seq = NEW.command_seq
      AND command.disposition = NEW.disposition
      AND command.state = 'decision_reserved'
      AND command.decided_at_ms = NEW.decided_at_ms
      AND preparation.command_result_id = NEW.command_result_id
      AND preparation.canonical_command_record_digest =
        command.canonical_command_record_digest
      AND preparation.state IN ('reserved', 'bound', 'signed')
      AND signing_group.state IN ('reserved', 'result_signed')
      AND signing_group.collaboration_server_id = preparation.collaboration_server_id
      AND signing_group.command_id = preparation.command_id
      AND signing_group.command_result_id = preparation.command_result_id
      AND signing_group.preparation_generation = preparation.preparation_generation
      AND signing_group.signing_lease_id = preparation.signing_lease_id
      AND reservation.purpose = 'collaboration_command_result'
      AND reservation.state IN ('reserved', 'bound', 'signed')
      AND (
        (OLD.state = 'awaiting_order'
          AND preparation.preparation_generation = 1
          AND preparation.supersedes_preparation_ref IS NULL
          AND preparation.prepared_at_ms = command.decided_at_ms
          AND signing_group.reserved_at_ms = command.decided_at_ms
          AND reservation.reserved_at_ms = command.decided_at_ms)
        OR (OLD.state = 'deciding'
          AND preparation.prepared_at_ms > command.decided_at_ms
          AND signing_group.reserved_at_ms = preparation.prepared_at_ms
          AND reservation.reserved_at_ms = preparation.prepared_at_ms
          AND EXISTS (
            SELECT 1
            FROM collaboration_command_result_preparations AS prior_preparation
            JOIN collaboration_command_compound_signing_groups AS prior_group
              ON prior_group.compound_signing_group_id =
                prior_preparation.compound_signing_group_id
             AND prior_group.result_preparation_ref =
                prior_preparation.command_result_preparation_id
            WHERE prior_preparation.command_result_preparation_id =
                OLD.command_result_preparation_id
              AND prior_preparation.collaboration_server_id =
                preparation.collaboration_server_id
              AND prior_preparation.command_id = preparation.command_id
              AND prior_preparation.command_result_id = preparation.command_result_id
              AND prior_preparation.result_version = preparation.result_version
              AND prior_preparation.preparation_generation + 1 =
                preparation.preparation_generation
              AND prior_preparation.canonical_command_record_digest =
                preparation.canonical_command_record_digest
              AND prior_preparation.state = 'aborted'
              AND prior_group.state = 'aborted'
              AND prior_group.aborted_at_ms = prior_preparation.aborted_at_ms
              AND preparation.supersedes_preparation_ref =
                prior_preparation.command_result_preparation_id
              AND preparation.prepared_at_ms > prior_preparation.aborted_at_ms
          ))
      )
  ) THEN RAISE(ABORT, 'A1 ingress deciding state requires its exact command preparation') END;
END`;

const CREATE_ADJUDICATION_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER a1_ingress_adjudications_no_delete
BEFORE DELETE ON a1_ingress_adjudications
BEGIN
  SELECT RAISE(ABORT, 'A1 ingress adjudications are retained');
END`;

const CREATE_ADJUDICATION_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER a1_ingress_adjudications_no_replace
BEFORE INSERT ON a1_ingress_adjudications
WHEN EXISTS (
  SELECT 1 FROM a1_ingress_adjudications
  WHERE stable_semantic_result_id = NEW.stable_semantic_result_id
     OR command_id = NEW.command_id
)
BEGIN
  SELECT RAISE(ABORT, 'A1 ingress adjudications are immutable');
END`;

const CREATE_INGRESS_RESULT_FREEZE_TRIGGER_SQL = `CREATE TRIGGER authenticated_ingress_results_freeze_adjudicated_source
BEFORE UPDATE ON authenticated_ingress_results
WHEN EXISTS (
  SELECT 1 FROM a1_ingress_adjudications
  WHERE stable_semantic_result_id = OLD.stable_semantic_result_id
) AND (
  NEW.state <> 'awaiting_order'
  OR NEW.source_payload_schema_id IS NOT OLD.source_payload_schema_id
  OR NEW.canonical_message_digest IS NOT OLD.canonical_message_digest
  OR NEW.source_event_fingerprint_schema_id IS NOT OLD.source_event_fingerprint_schema_id
  OR NEW.source_event_fingerprint IS NOT OLD.source_event_fingerprint
  OR NEW.accepted_delivery_attempt_id IS NOT OLD.accepted_delivery_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'adjudicated A1 ingress source tuple is frozen');
END`;

const CREATE_GROUP_REQUIRE_RESERVED_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_groups_require_reserved
BEFORE INSERT ON collaboration_command_compound_signing_groups
BEGIN
  SELECT CASE WHEN NEW.state <> 'reserved'
    OR NEW.required_finalization_artifact_kind <> 'none'
    OR NEW.secondary_preparation_ref IS NOT NULL
    OR NEW.result_signed_at_ms IS NOT NULL
    OR NEW.both_signed_at_ms IS NOT NULL
    OR NEW.finalized_at_ms IS NOT NULL
    OR NEW.aborted_at_ms IS NOT NULL
  THEN RAISE(ABORT, 'v10 command signing group must begin as inert none/reserved') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_commands AS command
    JOIN server_signing_leases AS signing_lease
      ON signing_lease.signing_lease_id = NEW.signing_lease_id
     AND signing_lease.collaboration_server_id = NEW.collaboration_server_id
    JOIN collaboration_servers AS server
      ON server.collaboration_server_id = NEW.collaboration_server_id
    JOIN coordinator_leases AS coordinator
      ON coordinator.coordinator_lease_id = signing_lease.coordinator_lease_id
     AND coordinator.collaboration_server_id = signing_lease.collaboration_server_id
     AND coordinator.coordinator_epoch = signing_lease.coordinator_epoch
    WHERE command.command_id = NEW.command_id
      AND command.collaboration_server_id = NEW.collaboration_server_id
      AND (
        (NEW.preparation_generation = 1 AND command.state = 'awaiting_order')
        OR (NEW.preparation_generation > 1
          AND command.state = 'decision_reserved'
          AND command.disposition = 'rejected'
          AND command.command_seq IS NOT NULL
          AND command.canonical_command_record_digest IS NOT NULL)
      )
      AND signing_lease.state = 'current'
      AND server.state = 'current'
      AND server.current_identity_key_id = signing_lease.identity_key_id
      AND server.current_key_generation = signing_lease.key_generation
      AND server.current_scope_certificate_id = signing_lease.scope_certificate_id
      AND server.current_coordinator_lease_id = signing_lease.coordinator_lease_id
      AND server.current_coordinator_epoch = signing_lease.coordinator_epoch
      AND coordinator.state = 'current'
      AND coordinator.released_at_ms IS NULL
      AND signing_lease.acquired_at_ms <= NEW.reserved_at_ms
      AND coordinator.acquired_at_ms <= NEW.reserved_at_ms
      AND NEW.reserved_at_ms < coordinator.heartbeat_deadline_ms
  ) THEN RAISE(ABORT, 'command signing group requires its exact current command signer') END;
  SELECT CASE WHEN NEW.preparation_generation > 1 AND NOT EXISTS (
    SELECT 1
    FROM collaboration_command_compound_signing_groups AS prior_group
    JOIN collaboration_command_result_preparations AS prior_preparation
      ON prior_preparation.command_result_preparation_id =
        prior_group.result_preparation_ref
    JOIN collaboration_commands AS command
      ON command.command_id = prior_group.command_id
     AND command.collaboration_server_id = prior_group.collaboration_server_id
    JOIN a1_ingress_adjudications AS adjudication
      ON adjudication.command_id = command.command_id
     AND adjudication.collaboration_server_id = command.collaboration_server_id
    WHERE prior_group.collaboration_server_id = NEW.collaboration_server_id
      AND prior_group.command_id = NEW.command_id
      AND prior_group.command_result_id = NEW.command_result_id
      AND prior_group.preparation_generation = NEW.preparation_generation - 1
      AND prior_group.state = 'aborted'
      AND prior_preparation.state = 'aborted'
      AND prior_preparation.aborted_at_ms = prior_group.aborted_at_ms
      AND prior_preparation.canonical_command_record_digest =
        command.canonical_command_record_digest
      AND command.state = 'decision_reserved'
      AND command.disposition = 'rejected'
      AND adjudication.state = 'deciding'
      AND adjudication.command_seq = command.command_seq
      AND adjudication.disposition = command.disposition
      AND adjudication.command_result_id = prior_group.command_result_id
      AND adjudication.command_result_preparation_id =
        prior_preparation.command_result_preparation_id
      AND adjudication.decided_at_ms = command.decided_at_ms
      AND NEW.reserved_at_ms > prior_group.aborted_at_ms
  ) THEN RAISE(ABORT, 'replacement signing group requires the prior aborted generation') END;
END`;

const CREATE_GROUP_LIFECYCLE_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_groups_lifecycle_monotonic
BEFORE UPDATE ON collaboration_command_compound_signing_groups
BEGIN
  SELECT CASE WHEN NOT (
    NEW.compound_signing_group_id IS OLD.compound_signing_group_id
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.command_id IS OLD.command_id
    AND NEW.command_result_id IS OLD.command_result_id
    AND NEW.preparation_generation IS OLD.preparation_generation
    AND NEW.signing_lease_id IS OLD.signing_lease_id
    AND NEW.result_preparation_ref IS OLD.result_preparation_ref
    AND NEW.required_finalization_artifact_kind IS OLD.required_finalization_artifact_kind
    AND NEW.secondary_preparation_ref IS OLD.secondary_preparation_ref
    AND NEW.reserved_at_ms IS OLD.reserved_at_ms
    AND NEW.both_signed_at_ms IS NULL
    AND NEW.finalized_at_ms IS NULL
    AND (
      (OLD.state = 'reserved' AND NEW.state = 'result_signed'
        AND OLD.result_signed_at_ms IS NULL
        AND NEW.result_signed_at_ms IS NOT NULL
        AND NEW.aborted_at_ms IS NULL
        AND EXISTS (
          SELECT 1 FROM collaboration_command_result_preparations AS preparation
          WHERE preparation.command_result_preparation_id = OLD.result_preparation_ref
            AND preparation.compound_signing_group_id = OLD.compound_signing_group_id
            AND preparation.command_result_id = OLD.command_result_id
            AND preparation.preparation_generation = OLD.preparation_generation
            AND preparation.state = 'signed'
            AND preparation.signed_at_ms = NEW.result_signed_at_ms
        ))
      OR (OLD.state = 'reserved' AND NEW.state = 'aborted'
        AND NEW.result_signed_at_ms IS NULL
        AND OLD.aborted_at_ms IS NULL
        AND NEW.aborted_at_ms IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM collaboration_command_result_preparations AS preparation
          WHERE preparation.command_result_preparation_id = OLD.result_preparation_ref
            AND preparation.state = 'aborted'
            AND preparation.aborted_at_ms = NEW.aborted_at_ms
        ))
    )
  ) THEN RAISE(ABORT, 'v10 command signing group lifecycle is monotonic and cannot finalize') END;
END`;

const CREATE_GROUP_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_groups_no_delete
BEFORE DELETE ON collaboration_command_compound_signing_groups
BEGIN
  SELECT RAISE(ABORT, 'command signing groups are retained');
END`;

const CREATE_GROUP_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_groups_no_replace
BEFORE INSERT ON collaboration_command_compound_signing_groups
WHEN EXISTS (
  SELECT 1 FROM collaboration_command_compound_signing_groups
  WHERE compound_signing_group_id = NEW.compound_signing_group_id
     OR (collaboration_server_id = NEW.collaboration_server_id
       AND command_id = NEW.command_id
       AND command_result_id = NEW.command_result_id
       AND preparation_generation = NEW.preparation_generation)
)
BEGIN
  SELECT RAISE(ABORT, 'command signing groups are immutable');
END`;

const CREATE_PREPARATION_REQUIRE_RESERVED_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_result_preparations_require_reserved
BEFORE INSERT ON collaboration_command_result_preparations
BEGIN
  SELECT CASE WHEN NEW.state <> 'reserved'
    OR NEW.bound_at_ms IS NOT NULL
    OR NEW.signed_at_ms IS NOT NULL
    OR NEW.aborted_at_ms IS NOT NULL
    OR NEW.required_finalization_artifact_kind <> 'none'
    OR NEW.current_finalization_artifact_preparation_ref IS NOT NULL
  THEN RAISE(ABORT, 'v10 command result preparation must begin as inert none/reserved') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM collaboration_commands AS command
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id = NEW.compound_signing_group_id
     AND signing_group.collaboration_server_id = NEW.collaboration_server_id
     AND signing_group.command_id = NEW.command_id
     AND signing_group.command_result_id = NEW.command_result_id
     AND signing_group.preparation_generation = NEW.preparation_generation
     AND signing_group.signing_lease_id = NEW.signing_lease_id
     AND signing_group.result_preparation_ref = NEW.command_result_preparation_id
    JOIN server_signature_reservations AS reservation
      ON reservation.collaboration_server_id = NEW.collaboration_server_id
     AND reservation.signer_sequence = NEW.signer_sequence
     AND reservation.signing_lease_id = NEW.signing_lease_id
    WHERE command.command_id = NEW.command_id
      AND command.collaboration_server_id = NEW.collaboration_server_id
      AND (
        (NEW.preparation_generation = 1 AND command.state = 'awaiting_order')
        OR (NEW.preparation_generation > 1
          AND command.state = 'decision_reserved'
          AND command.disposition = 'rejected'
          AND command.command_seq IS NOT NULL
          AND command.canonical_command_record_digest =
            NEW.canonical_command_record_digest)
      )
      AND signing_group.state = 'reserved'
      AND signing_group.reserved_at_ms = NEW.prepared_at_ms
      AND reservation.signing_lease_kind = 'current'
      AND reservation.purpose = 'collaboration_command_result'
      AND reservation.state = 'reserved'
      AND reservation.reserved_at_ms = NEW.prepared_at_ms
  ) THEN RAISE(ABORT, 'command result preparation requires its exact group and reservation') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
    WHERE artifact.protected_handle_id = NEW.canonical_payload_ref
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'collaboration_server'
      AND artifact.scope_id = NEW.collaboration_server_id
      AND artifact.artifact_schema_id = 'remote-claw/collaboration-command-result/v1'
      AND artifact.artifact_digest = NEW.canonical_payload_digest
  ) THEN RAISE(ABORT, 'command result preparation requires its exact canonical payload artifact') END;
  SELECT CASE WHEN NEW.preparation_generation > 1 AND NOT EXISTS (
    SELECT 1
    FROM collaboration_command_result_preparations AS prior
    JOIN collaboration_command_compound_signing_groups AS prior_group
      ON prior_group.compound_signing_group_id = prior.compound_signing_group_id
     AND prior_group.result_preparation_ref = prior.command_result_preparation_id
    JOIN collaboration_commands AS command
      ON command.command_id = prior.command_id
     AND command.collaboration_server_id = prior.collaboration_server_id
    JOIN a1_ingress_adjudications AS adjudication
      ON adjudication.command_id = command.command_id
     AND adjudication.collaboration_server_id = command.collaboration_server_id
    WHERE prior.command_result_preparation_id = NEW.supersedes_preparation_ref
      AND prior.collaboration_server_id = NEW.collaboration_server_id
      AND prior.command_id = NEW.command_id
      AND prior.command_result_id = NEW.command_result_id
      AND prior.result_version = NEW.result_version
      AND prior.preparation_generation = NEW.preparation_generation - 1
      AND prior.canonical_command_record_digest = NEW.canonical_command_record_digest
      AND prior.state = 'aborted'
      AND prior_group.state = 'aborted'
      AND prior_group.aborted_at_ms = prior.aborted_at_ms
      AND command.state = 'decision_reserved'
      AND command.disposition = 'rejected'
      AND command.canonical_command_record_digest =
        NEW.canonical_command_record_digest
      AND adjudication.state = 'deciding'
      AND adjudication.command_seq = command.command_seq
      AND adjudication.disposition = command.disposition
      AND adjudication.command_result_id = NEW.command_result_id
      AND adjudication.command_result_preparation_id =
        prior.command_result_preparation_id
      AND adjudication.decided_at_ms = command.decided_at_ms
      AND NEW.prepared_at_ms > prior.aborted_at_ms
  ) THEN RAISE(ABORT, 'replacement result preparation requires its prior aborted generation') END;
END`;

const CREATE_PREPARATION_LIFECYCLE_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_result_preparations_lifecycle_monotonic
BEFORE UPDATE ON collaboration_command_result_preparations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.command_result_preparation_id IS OLD.command_result_preparation_id
    AND NEW.command_result_id IS OLD.command_result_id
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.command_id IS OLD.command_id
    AND NEW.canonical_command_record_digest IS OLD.canonical_command_record_digest
    AND NEW.result_version IS OLD.result_version
    AND NEW.preparation_generation IS OLD.preparation_generation
    AND NEW.supersedes_preparation_ref IS OLD.supersedes_preparation_ref
    AND NEW.canonical_payload_ref IS OLD.canonical_payload_ref
    AND NEW.canonical_payload_digest IS OLD.canonical_payload_digest
    AND NEW.signer_sequence IS OLD.signer_sequence
    AND NEW.signing_lease_id IS OLD.signing_lease_id
    AND NEW.compound_signing_group_id IS OLD.compound_signing_group_id
    AND NEW.required_finalization_artifact_kind IS OLD.required_finalization_artifact_kind
    AND NEW.current_finalization_artifact_preparation_ref IS
      OLD.current_finalization_artifact_preparation_ref
    AND NEW.prepared_at_ms IS OLD.prepared_at_ms
    AND (
      (OLD.state = 'reserved' AND NEW.state = 'bound'
        AND OLD.bound_at_ms IS NULL AND NEW.bound_at_ms IS NOT NULL
        AND NEW.signed_at_ms IS NULL AND NEW.aborted_at_ms IS NULL
        AND EXISTS (
          SELECT 1 FROM server_signature_reservations AS reservation
          WHERE reservation.collaboration_server_id = OLD.collaboration_server_id
            AND reservation.signer_sequence = OLD.signer_sequence
            AND reservation.signing_lease_id = OLD.signing_lease_id
            AND reservation.purpose = 'collaboration_command_result'
            AND reservation.canonical_payload_schema_id =
              'remote-claw/collaboration-command-result/v1'
            AND reservation.canonical_payload_ref = OLD.canonical_payload_ref
            AND reservation.canonical_payload_digest = OLD.canonical_payload_digest
            AND reservation.signed_artifact_type =
              'collaboration_command_result_preparation'
            AND reservation.signed_artifact_id = OLD.command_result_preparation_id
            AND reservation.bound_at_ms = NEW.bound_at_ms
            AND reservation.state = 'bound'
        ))
      OR (OLD.state = 'bound' AND NEW.state = 'signed'
        AND NEW.bound_at_ms IS OLD.bound_at_ms
        AND OLD.signed_at_ms IS NULL AND NEW.signed_at_ms IS NOT NULL
        AND NEW.aborted_at_ms IS NULL
        AND EXISTS (
          SELECT 1 FROM server_signature_reservations AS reservation
          WHERE reservation.collaboration_server_id = OLD.collaboration_server_id
            AND reservation.signer_sequence = OLD.signer_sequence
            AND reservation.signing_lease_id = OLD.signing_lease_id
            AND reservation.signed_artifact_type =
              'collaboration_command_result_preparation'
            AND reservation.signed_artifact_id = OLD.command_result_preparation_id
            AND reservation.signed_at_ms = NEW.signed_at_ms
            AND reservation.state = 'signed'
        ))
      OR (OLD.state IN ('reserved', 'bound') AND NEW.state = 'aborted'
        AND NEW.bound_at_ms IS OLD.bound_at_ms
        AND NEW.signed_at_ms IS NULL
        AND OLD.aborted_at_ms IS NULL AND NEW.aborted_at_ms IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM server_signature_reservations AS reservation
          WHERE reservation.collaboration_server_id = OLD.collaboration_server_id
            AND reservation.signer_sequence = OLD.signer_sequence
            AND reservation.signing_lease_id = OLD.signing_lease_id
            AND reservation.aborted_at_ms = NEW.aborted_at_ms
            AND reservation.state = 'aborted'
        ))
    )
  ) THEN RAISE(ABORT, 'command result preparation lifecycle is monotonic') END;
END`;

const CREATE_PREPARATION_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_result_preparations_no_delete
BEFORE DELETE ON collaboration_command_result_preparations
BEGIN
  SELECT RAISE(ABORT, 'command result preparations are retained');
END`;

const CREATE_PREPARATION_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER collaboration_command_result_preparations_no_replace
BEFORE INSERT ON collaboration_command_result_preparations
WHEN EXISTS (
  SELECT 1 FROM collaboration_command_result_preparations
  WHERE command_result_preparation_id = NEW.command_result_preparation_id
     OR (collaboration_server_id = NEW.collaboration_server_id
       AND signer_sequence = NEW.signer_sequence)
     OR (collaboration_server_id = NEW.collaboration_server_id
       AND command_result_id = NEW.command_result_id
       AND preparation_generation = NEW.preparation_generation)
)
BEGIN
  SELECT RAISE(ABORT, 'command result preparations are immutable');
END`;

const CREATE_RESERVATION_REQUIRE_RESULT_PREPARATION_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_require_result_preparation
BEFORE UPDATE ON server_signature_reservations
WHEN OLD.purpose = 'collaboration_command_result'
  AND OLD.state = 'reserved'
  AND NEW.state = 'bound'
  AND NOT EXISTS (
    SELECT 1
    FROM collaboration_command_result_preparations AS preparation
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id = preparation.compound_signing_group_id
     AND signing_group.result_preparation_ref = preparation.command_result_preparation_id
    WHERE preparation.collaboration_server_id = OLD.collaboration_server_id
      AND preparation.signer_sequence = OLD.signer_sequence
      AND preparation.signing_lease_id = OLD.signing_lease_id
      AND preparation.canonical_payload_ref = NEW.canonical_payload_ref
      AND preparation.canonical_payload_digest = NEW.canonical_payload_digest
      AND preparation.command_result_preparation_id = NEW.signed_artifact_id
      AND preparation.state = 'reserved'
      AND signing_group.state = 'reserved'
      AND NEW.canonical_payload_schema_id =
        'remote-claw/collaboration-command-result/v1'
      AND NEW.signed_artifact_type =
        'collaboration_command_result_preparation'
  )
BEGIN
  SELECT RAISE(ABORT, 'command-result reservation requires its exact preparation generation');
END`;

const CREATE_RESERVATION_REQUIRE_RESULT_SIGNING_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_require_result_signing
BEFORE UPDATE ON server_signature_reservations
WHEN OLD.purpose = 'collaboration_command_result'
  AND OLD.state = 'bound'
  AND NEW.state = 'signed'
  AND NOT EXISTS (
    SELECT 1
    FROM collaboration_command_result_preparations AS preparation
    JOIN collaboration_command_compound_signing_groups AS signing_group
      ON signing_group.compound_signing_group_id = preparation.compound_signing_group_id
     AND signing_group.result_preparation_ref = preparation.command_result_preparation_id
    WHERE preparation.collaboration_server_id = OLD.collaboration_server_id
      AND preparation.signer_sequence = OLD.signer_sequence
      AND preparation.signing_lease_id = OLD.signing_lease_id
      AND preparation.command_result_preparation_id = OLD.signed_artifact_id
      AND preparation.canonical_payload_ref = OLD.canonical_payload_ref
      AND preparation.canonical_payload_digest = OLD.canonical_payload_digest
      AND preparation.state = 'bound'
      AND signing_group.state = 'reserved'
  )
BEGIN
  SELECT RAISE(ABORT, 'command-result signing requires its exact bound preparation');
END`;

const CREATE_RESERVATION_REQUIRE_ABORT_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_require_command_abort_authority
BEFORE UPDATE ON server_signature_reservations
WHEN OLD.purpose = 'collaboration_command_result'
  AND OLD.state IN ('reserved', 'bound')
  AND NEW.state = 'aborted'
  AND NOT EXISTS (
    SELECT 1 FROM coordinator_leases AS coordinator
    WHERE coordinator.collaboration_server_id = OLD.collaboration_server_id
      AND coordinator.acquired_at_ms <= NEW.aborted_at_ms
      AND NEW.aborted_at_ms < coordinator.heartbeat_deadline_ms
      AND (coordinator.released_at_ms IS NULL
        OR NEW.aborted_at_ms <= coordinator.released_at_ms)
  )
BEGIN
  SELECT RAISE(ABORT, 'command-result abort requires exact coordinator authority');
END`;

const CREATE_ACCEPTANCE_FORBID_COMMAND_RESULT_TRIGGER_SQL = `CREATE TRIGGER server_signed_record_acceptances_forbid_command_results_v10
BEFORE INSERT ON server_signed_record_acceptances
WHEN EXISTS (
  SELECT 1 FROM server_signature_reservations AS reservation
  WHERE reservation.collaboration_server_id = NEW.collaboration_server_id
    AND reservation.signer_sequence = NEW.signer_sequence
    AND reservation.purpose = 'collaboration_command_result'
)
BEGIN
  SELECT RAISE(ABORT, 'schema v10 command-result preparations cannot be accepted');
END`;

const CREATE_SERVER_JOURNAL_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_command_journal_sequence_monotonic
BEFORE UPDATE OF next_journal_offset ON collaboration_servers
WHEN NEW.next_journal_offset <> OLD.next_journal_offset AND NOT (
  NEW.next_journal_offset = OLD.next_journal_offset + 1
  AND (
    EXISTS (
      SELECT 1 FROM control_journal_entries AS entry
      WHERE entry.collaboration_server_id = OLD.collaboration_server_id
        AND entry.journal_offset = OLD.next_journal_offset
    )
    OR EXISTS (
      SELECT 1 FROM command_ready_entries AS entry
      WHERE entry.collaboration_server_id = OLD.collaboration_server_id
        AND entry.ready_at_journal_seq = OLD.next_journal_offset
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'server journal sequence must advance through one exact journal entry');
END`;

const CREATE_SERVER_COMMAND_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_command_sequence_monotonic
BEFORE UPDATE OF next_command_seq ON collaboration_servers
WHEN NEW.next_command_seq <> OLD.next_command_seq AND NOT (
  NEW.next_command_seq = OLD.next_command_seq + 1
  AND EXISTS (
    SELECT 1 FROM collaboration_commands AS command
    WHERE command.collaboration_server_id = OLD.collaboration_server_id
      AND command.command_seq = OLD.next_command_seq
      AND command.state = 'decision_reserved'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'server command sequence must advance through one exact decision');
END`;

/** Existing schema objects that v10 replaces before creating its final schema entries. */
export const VERSION_TEN_PRE_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  "DROP TRIGGER server_signature_reservations_require_current_authority",
]);

export const VERSION_TEN_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    table("command_ready_entries", CREATE_COMMAND_READY_ENTRIES_SQL),
    table("a1_ingress_adjudications", CREATE_A1_INGRESS_ADJUDICATIONS_SQL),
    table("collaboration_commands", CREATE_COLLABORATION_COMMANDS_SQL),
    table("collaboration_command_compound_signing_groups", CREATE_COMPOUND_SIGNING_GROUPS_SQL),
    table("collaboration_command_result_preparations", CREATE_RESULT_PREPARATIONS_SQL),
    schemaEntry(
      "index",
      "command_ready_entries_command_unique",
      "command_ready_entries",
      CREATE_READY_COMMAND_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "command_ready_entries_coordinate_unique",
      "command_ready_entries",
      CREATE_READY_COORDINATE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "command_ready_entries_source_unique",
      "command_ready_entries",
      CREATE_READY_SOURCE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_commands_server_unique",
      "collaboration_commands",
      CREATE_COMMAND_SERVER_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_commands_ready_unique",
      "collaboration_commands",
      CREATE_COMMAND_READY_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_commands_sequence_unique",
      "collaboration_commands",
      CREATE_COMMAND_SEQUENCE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_commands_ready_order",
      "collaboration_commands",
      CREATE_COMMAND_READY_ORDER_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_groups_preparation_unique",
      "collaboration_command_compound_signing_groups",
      CREATE_GROUP_PREPARATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_groups_one_active_unique",
      "collaboration_command_compound_signing_groups",
      CREATE_GROUP_ACTIVE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_groups_one_server_active_unique",
      "collaboration_command_compound_signing_groups",
      CREATE_GROUP_SERVER_ACTIVE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_result_preparations_generation_unique",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_GENERATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_result_preparations_signer_unique",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_SIGNER_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_result_preparations_group_unique",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_GROUP_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "collaboration_command_result_preparations_one_active_unique",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_ACTIVE_INDEX_SQL,
    ),
    trigger(
      "server_signature_reservations_require_current_authority",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_AUTHORITY_TRIGGER_SQL,
    ),
    trigger(
      "command_ready_entries_require_exact_command",
      "command_ready_entries",
      CREATE_READY_REQUIRE_EXACT_COMMAND_TRIGGER_SQL,
    ),
    trigger(
      "command_ready_entries_increment_journal",
      "command_ready_entries",
      CREATE_READY_INCREMENT_JOURNAL_TRIGGER_SQL,
    ),
    trigger(
      "command_ready_entries_no_update",
      "command_ready_entries",
      CREATE_READY_NO_UPDATE_TRIGGER_SQL,
    ),
    trigger(
      "command_ready_entries_no_delete",
      "command_ready_entries",
      CREATE_READY_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "command_ready_entries_no_replace",
      "command_ready_entries",
      CREATE_READY_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_commands_require_initial_awaiting_order",
      "collaboration_commands",
      CREATE_COMMAND_REQUIRE_INITIAL_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_commands_require_rejected_decision",
      "collaboration_commands",
      CREATE_COMMAND_REQUIRE_DECISION_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_commands_increment_sequence",
      "collaboration_commands",
      CREATE_COMMAND_INCREMENT_SEQUENCE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_commands_no_delete",
      "collaboration_commands",
      CREATE_COMMAND_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_commands_no_replace",
      "collaboration_commands",
      CREATE_COMMAND_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_adjudications_require_ready_source",
      "a1_ingress_adjudications",
      CREATE_ADJUDICATION_REQUIRE_READY_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_adjudications_require_deciding_transition",
      "a1_ingress_adjudications",
      CREATE_ADJUDICATION_REQUIRE_DECIDING_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_adjudications_no_delete",
      "a1_ingress_adjudications",
      CREATE_ADJUDICATION_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "a1_ingress_adjudications_no_replace",
      "a1_ingress_adjudications",
      CREATE_ADJUDICATION_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "authenticated_ingress_results_freeze_adjudicated_source",
      "authenticated_ingress_results",
      CREATE_INGRESS_RESULT_FREEZE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_groups_require_reserved",
      "collaboration_command_compound_signing_groups",
      CREATE_GROUP_REQUIRE_RESERVED_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_groups_lifecycle_monotonic",
      "collaboration_command_compound_signing_groups",
      CREATE_GROUP_LIFECYCLE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_groups_no_delete",
      "collaboration_command_compound_signing_groups",
      CREATE_GROUP_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_groups_no_replace",
      "collaboration_command_compound_signing_groups",
      CREATE_GROUP_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_result_preparations_require_reserved",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_REQUIRE_RESERVED_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_result_preparations_lifecycle_monotonic",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_LIFECYCLE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_result_preparations_no_delete",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_command_result_preparations_no_replace",
      "collaboration_command_result_preparations",
      CREATE_PREPARATION_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_require_result_preparation",
      "server_signature_reservations",
      CREATE_RESERVATION_REQUIRE_RESULT_PREPARATION_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_require_result_signing",
      "server_signature_reservations",
      CREATE_RESERVATION_REQUIRE_RESULT_SIGNING_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_require_command_abort_authority",
      "server_signature_reservations",
      CREATE_RESERVATION_REQUIRE_ABORT_AUTHORITY_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_forbid_command_results_v10",
      "server_signed_record_acceptances",
      CREATE_ACCEPTANCE_FORBID_COMMAND_RESULT_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_servers_command_journal_sequence_monotonic",
      "collaboration_servers",
      CREATE_SERVER_JOURNAL_SEQUENCE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_servers_command_sequence_monotonic",
      "collaboration_servers",
      CREATE_SERVER_COMMAND_SEQUENCE_TRIGGER_SQL,
    ),
  ]);

export const VERSION_TEN_DATA_STATEMENTS: readonly string[] = Object.freeze([]);
