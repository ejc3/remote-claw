import { createHash, timingSafeEqual } from "node:crypto";
import { CanonicalWriter } from "@remote-claw/clawsec";

/** SQLite application_id for the ASCII tag `RCLW`. */
export const HOST_STATE_APPLICATION_ID = 0x52434c57;

export const HOST_STATE_SCHEMA_VERSION = 3;

/** Domain for the length-framed, history-chained migration digest below. */
export const HOST_STATE_MIGRATION_DIGEST_DOMAIN = "remote-claw/host-state/migration-chain/v1";

export interface HostStateMigration {
  readonly version: number;
  readonly id: string;
  readonly statements: readonly string[];
}

export interface HostStateSqliteSchemaEntry {
  readonly type: "table" | "index" | "trigger" | "view";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

const CREATE_METADATA_SQL = `CREATE TABLE host_state_metadata (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  migration_digest TEXT NOT NULL CHECK (length(migration_digest) = 43),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT`;

const CREATE_MIGRATIONS_SQL = `CREATE TABLE host_state_migrations (
  schema_version INTEGER PRIMARY KEY NOT NULL CHECK (schema_version >= 1),
  migration_id TEXT NOT NULL,
  migration_digest TEXT NOT NULL CHECK (length(migration_digest) = 43),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT`;

const CREATE_MIGRATIONS_ID_INDEX_SQL = `CREATE UNIQUE INDEX host_state_migrations_id_unique
ON host_state_migrations (migration_id)`;

const CREATE_MIGRATIONS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER host_state_migrations_no_update
BEFORE UPDATE ON host_state_migrations
BEGIN
  SELECT RAISE(ABORT, 'host state migration history is append-only');
END`;

const CREATE_MIGRATIONS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER host_state_migrations_no_delete
BEFORE DELETE ON host_state_migrations
BEGIN
  SELECT RAISE(ABORT, 'host state migration history is append-only');
END`;

const CREATE_MIGRATIONS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER host_state_migrations_no_replace
BEFORE INSERT ON host_state_migrations
WHEN EXISTS (
  SELECT 1 FROM host_state_migrations
  WHERE schema_version = NEW.schema_version OR migration_id = NEW.migration_id
)
BEGIN
  SELECT RAISE(ABORT, 'host state migration history is append-only');
END`;

const CREATE_PROTECTED_ARTIFACTS_SQL = `CREATE TABLE protected_artifacts (
  protected_handle_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'artifact'),
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN (
      'host_profile',
      'collaboration_server',
      'runtime',
      'native_binding',
      'native_attempt'
    )
  ),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 128),
  artifact_schema_id TEXT NOT NULL CHECK (length(artifact_schema_id) BETWEEN 1 AND 1024),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 43),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 16777216),
  artifact_bytes BLOB NOT NULL CHECK (length(artifact_bytes) = byte_length),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT, WITHOUT ROWID`;

const CREATE_PROTECTED_ARTIFACTS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_no_update
BEFORE UPDATE ON protected_artifacts
BEGIN
  SELECT RAISE(ABORT, 'protected artifacts are immutable');
END`;

const CREATE_PROTECTED_ARTIFACTS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_no_delete
BEFORE DELETE ON protected_artifacts
BEGIN
  SELECT RAISE(ABORT, 'protected artifacts are immutable');
END`;

const CREATE_PROTECTED_ARTIFACTS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_no_replace
BEFORE INSERT ON protected_artifacts
WHEN EXISTS (
  SELECT 1 FROM protected_artifacts
  WHERE protected_handle_id = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected artifacts are immutable');
END`;

const CREATE_METADATA_MACHINE_IDENTITY_INDEX_SQL = `CREATE UNIQUE INDEX host_state_metadata_machine_identity_unique
ON host_state_metadata (machine_identity_id)`;

const CREATE_COLLABORATION_SERVERS_SQL = `CREATE TABLE collaboration_servers (
  collaboration_server_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  current_key_generation INTEGER NOT NULL CHECK (
    current_key_generation BETWEEN 0 AND 9007199254740991
  ),
  current_identity_key_id TEXT CHECK (
    current_identity_key_id IS NULL OR (
      length(current_identity_key_id) BETWEEN 1 AND 128
      AND current_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  current_scope_certificate_id TEXT CHECK (
    current_scope_certificate_id IS NULL OR (
      length(current_scope_certificate_id) BETWEEN 1 AND 128
      AND current_scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  current_coordinator_epoch INTEGER NOT NULL CHECK (
    current_coordinator_epoch BETWEEN 0 AND 9007199254740991
  ),
  current_coordinator_lease_id TEXT CHECK (
    current_coordinator_lease_id IS NULL OR (
      length(current_coordinator_lease_id) = 27
      AND substr(current_coordinator_lease_id, 1, 5) = 'rccl_'
      AND current_coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  next_journal_offset INTEGER NOT NULL CHECK (
    next_journal_offset BETWEEN 0 AND 9007199254740991
  ),
  next_server_signature_seq INTEGER NOT NULL CHECK (
    next_server_signature_seq BETWEEN 0 AND 9007199254740991
  ),
  next_command_seq INTEGER NOT NULL CHECK (
    next_command_seq BETWEEN 0 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('installing', 'current', 'repairing', 'closed')),
  CHECK (
    (
      current_key_generation = 0
      AND current_identity_key_id IS NULL
      AND current_scope_certificate_id IS NULL
    ) OR (
      current_key_generation > 0
      AND current_identity_key_id IS NOT NULL
      AND current_scope_certificate_id IS NOT NULL
    )
  ),
  CHECK (state <> 'installing' OR current_key_generation = 0),
  CHECK (state <> 'current' OR current_key_generation > 0),
  CHECK (
    current_coordinator_lease_id IS NULL OR current_coordinator_epoch > 0
  ),
  FOREIGN KEY (machine_identity_id)
    REFERENCES host_state_metadata (machine_identity_id),
  FOREIGN KEY (
    current_coordinator_lease_id,
    collaboration_server_id,
    current_coordinator_epoch
  ) REFERENCES coordinator_leases (
    coordinator_lease_id,
    collaboration_server_id,
    coordinator_epoch
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_HOST_STATE_PROFILES_SQL = `CREATE TABLE host_state_profiles (
  state_profile_id TEXT PRIMARY KEY NOT NULL CHECK (state_profile_id = 'default'),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  default_collaboration_server_id TEXT NOT NULL CHECK (
    length(default_collaboration_server_id) = 26
    AND substr(default_collaboration_server_id, 1, 4) = 'rcs_'
    AND default_collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (machine_identity_id)
    REFERENCES host_state_metadata (machine_identity_id),
  FOREIGN KEY (default_collaboration_server_id, machine_identity_id)
    REFERENCES collaboration_servers (collaboration_server_id, machine_identity_id)
) STRICT, WITHOUT ROWID`;

const CREATE_PROJECTS_SQL = `CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(project_id) = 27
    AND substr(project_id, 1, 5) = 'rcpj_'
    AND project_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  project_allocation_intent_id TEXT NOT NULL CHECK (
    length(project_allocation_intent_id) BETWEEN 1 AND 128
    AND project_allocation_intent_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_allocation_intent_schema_id TEXT NOT NULL CHECK (
    project_allocation_intent_schema_id = 'remote-claw/project-allocation-intent/v1'
  ),
  project_allocation_intent_digest TEXT NOT NULL CHECK (
    length(project_allocation_intent_digest) = 43
    AND project_allocation_intent_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  allocation_kind TEXT NOT NULL CHECK (
    allocation_kind IN ('first_bootstrap', 'explicit_new_project')
  ),
  initial_workspace_selector_id TEXT NOT NULL CHECK (
    length(initial_workspace_selector_id) BETWEEN 1 AND 128
    AND initial_workspace_selector_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  initial_target_digest TEXT NOT NULL CHECK (
    length(initial_target_digest) = 43
    AND initial_target_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  initial_project_target_selector_mapping_id TEXT NOT NULL CHECK (
    length(initial_project_target_selector_mapping_id) = 47
    AND substr(initial_project_target_selector_mapping_id, 1, 4) = 'ptm_'
    AND initial_project_target_selector_mapping_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  initial_mapping_generation INTEGER NOT NULL CHECK (initial_mapping_generation = 1),
  initial_target_kind TEXT NOT NULL CHECK (initial_target_kind = 'terminal_native'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('current', 'closed')),
  CHECK (
    allocation_kind <> 'first_bootstrap' OR (
      length(project_allocation_intent_id) = 27
      AND substr(project_allocation_intent_id, 1, 5) = 'rcra_'
      AND project_allocation_intent_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id),
  FOREIGN KEY (
    initial_project_target_selector_mapping_id,
    collaboration_server_id,
    project_id,
    initial_workspace_selector_id,
    initial_target_digest,
    initial_mapping_generation,
    initial_target_kind
  ) REFERENCES project_target_selector_mappings (
    project_target_selector_mapping_id,
    collaboration_server_id,
    project_id,
    workspace_selector_id,
    target_digest,
    mapping_generation,
    target_kind
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_SQL = `CREATE TABLE project_target_selector_mappings (
  project_target_selector_mapping_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(project_target_selector_mapping_id) = 47
    AND substr(project_target_selector_mapping_id, 1, 4) = 'ptm_'
    AND project_target_selector_mapping_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  project_id TEXT NOT NULL CHECK (
    length(project_id) = 27
    AND substr(project_id, 1, 5) = 'rcpj_'
    AND project_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  workspace_selector_id TEXT NOT NULL CHECK (
    length(workspace_selector_id) BETWEEN 1 AND 128
    AND workspace_selector_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('terminal_native', 'nested_server')),
  target_product TEXT CHECK (
    target_product IS NULL OR target_product IN ('claude-code', 'codex', 'opencode')
  ),
  target_access TEXT CHECK (
    target_access IS NULL OR target_access IN ('native-rc', 'app-server', 'server', 'tmux')
  ),
  terminal_project_ref TEXT CHECK (
    terminal_project_ref IS NULL OR (
      length(terminal_project_ref) BETWEEN 1 AND 128
      AND terminal_project_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  native_workspace_binding_id TEXT CHECK (
    native_workspace_binding_id IS NULL OR (
      length(native_workspace_binding_id) BETWEEN 1 AND 128
      AND native_workspace_binding_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  nested_server_management_binding_id TEXT CHECK (
    nested_server_management_binding_id IS NULL OR (
      length(nested_server_management_binding_id) BETWEEN 1 AND 128
      AND nested_server_management_binding_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  target_server_id TEXT CHECK (
    target_server_id IS NULL OR (
      length(target_server_id) = 26
      AND substr(target_server_id, 1, 4) = 'rcs_'
      AND target_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  target_project_id TEXT CHECK (
    target_project_id IS NULL OR (
      length(target_project_id) = 27
      AND substr(target_project_id, 1, 5) = 'rcpj_'
      AND target_project_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  target_workspace_selector_id TEXT CHECK (
    target_workspace_selector_id IS NULL OR (
      length(target_workspace_selector_id) BETWEEN 1 AND 128
      AND target_workspace_selector_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  target_digest TEXT NOT NULL CHECK (
    length(target_digest) = 43
    AND target_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  mapping_generation INTEGER NOT NULL CHECK (
    mapping_generation BETWEEN 1 AND 9007199254740991
  ),
  evidence_ref TEXT NOT NULL CHECK (
    length(evidence_ref) BETWEEN 1 AND 128
    AND evidence_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'superseded', 'closed')),
  CHECK (
    (
      target_kind = 'terminal_native'
      AND (
        (target_product = 'claude-code' AND target_access IN ('native-rc', 'tmux'))
        OR (target_product = 'codex' AND target_access = 'app-server')
        OR (target_product = 'opencode' AND target_access = 'server')
      )
      AND terminal_project_ref IS NOT NULL
      AND nested_server_management_binding_id IS NULL
      AND target_server_id IS NULL
      AND target_project_id IS NULL
      AND target_workspace_selector_id IS NULL
    ) OR (
      target_kind = 'nested_server'
      AND target_product IS NULL
      AND target_access IS NULL
      AND terminal_project_ref IS NULL
      AND native_workspace_binding_id IS NULL
      AND nested_server_management_binding_id IS NOT NULL
      AND target_server_id IS NOT NULL
      AND target_project_id IS NOT NULL
      AND target_workspace_selector_id IS NOT NULL
      AND target_server_id <> collaboration_server_id
    )
  ),
  CHECK (target_kind = 'terminal_native'),
  FOREIGN KEY (collaboration_server_id, project_id)
    REFERENCES projects (collaboration_server_id, project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_LOGICAL_CHATS_SQL = `CREATE TABLE logical_chats (
  logical_chat_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(logical_chat_id) = 26
    AND substr(logical_chat_id, 1, 4) = 'rcl_'
    AND logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  project_id TEXT NOT NULL CHECK (
    length(project_id) = 27
    AND substr(project_id, 1, 5) = 'rcpj_'
    AND project_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  project_target_selector_mapping_id TEXT NOT NULL CHECK (
    length(project_target_selector_mapping_id) = 47
    AND substr(project_target_selector_mapping_id, 1, 4) = 'ptm_'
    AND project_target_selector_mapping_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('recovering', 'ready', 'quarantined', 'closed')),
  topology_generation INTEGER NOT NULL CHECK (
    topology_generation BETWEEN 0 AND 9007199254740991
  ),
  current_inward_edge_id TEXT CHECK (
    current_inward_edge_id IS NULL OR (
      length(current_inward_edge_id) = 27
      AND substr(current_inward_edge_id, 1, 5) = 'rcie_'
      AND current_inward_edge_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  current_native_binding_id TEXT CHECK (
    current_native_binding_id IS NULL OR (
      length(current_native_binding_id) = 27
      AND substr(current_native_binding_id, 1, 5) = 'rcnb_'
      AND current_native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  parent_chat_id TEXT CHECK (
    parent_chat_id IS NULL OR (
      length(parent_chat_id) = 26
      AND substr(parent_chat_id, 1, 4) = 'rcl_'
      AND parent_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  next_viewer_projection_seq INTEGER NOT NULL CHECK (
    next_viewer_projection_seq BETWEEN 0 AND 9007199254740991
  ),
  CHECK (parent_chat_id IS NULL OR parent_chat_id <> logical_chat_id),
  CHECK ((topology_generation = 0) = (current_inward_edge_id IS NULL)),
  CHECK (state <> 'ready' OR current_inward_edge_id IS NOT NULL),
  CHECK (current_native_binding_id IS NULL OR current_inward_edge_id IS NOT NULL),
  FOREIGN KEY (collaboration_server_id, project_id)
    REFERENCES projects (collaboration_server_id, project_id),
  FOREIGN KEY (
    project_target_selector_mapping_id,
    collaboration_server_id,
    project_id
  ) REFERENCES project_target_selector_mappings (
    project_target_selector_mapping_id,
    collaboration_server_id,
    project_id
  ),
  FOREIGN KEY (collaboration_server_id, project_id, parent_chat_id)
    REFERENCES logical_chats (collaboration_server_id, project_id, logical_chat_id),
  FOREIGN KEY (
    collaboration_server_id,
    logical_chat_id,
    current_inward_edge_id
  ) REFERENCES inward_collaboration_edges (
    represented_server_id,
    represented_logical_chat_id,
    inward_edge_id
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    collaboration_server_id,
    logical_chat_id,
    current_inward_edge_id,
    current_native_binding_id
  ) REFERENCES inward_collaboration_edges (
    represented_server_id,
    represented_logical_chat_id,
    inward_edge_id,
    target_native_binding_id
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_BINDINGS_SQL = `CREATE TABLE native_bindings (
  native_binding_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(native_binding_id) = 27
    AND substr(native_binding_id, 1, 5) = 'rcnb_'
    AND native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  logical_chat_id TEXT NOT NULL CHECK (
    length(logical_chat_id) = 26
    AND substr(logical_chat_id, 1, 4) = 'rcl_'
    AND logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  descriptor_product TEXT NOT NULL CHECK (
    descriptor_product IN ('claude-code', 'codex', 'opencode')
  ),
  descriptor_access TEXT NOT NULL CHECK (
    descriptor_access IN ('native-rc', 'app-server', 'server', 'tmux')
  ),
  project_id TEXT NOT NULL CHECK (
    length(project_id) = 27
    AND substr(project_id, 1, 5) = 'rcpj_'
    AND project_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  semantic_conversation_id TEXT CHECK (
    semantic_conversation_id IS NULL OR (
      length(semantic_conversation_id) BETWEEN 1 AND 128
      AND semantic_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  current_binding_incarnation_id TEXT CHECK (
    current_binding_incarnation_id IS NULL OR (
      length(current_binding_incarnation_id) BETWEEN 1 AND 128
      AND current_binding_incarnation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('starting', 'current', 'superseded', 'closed')),
  CHECK (
    (descriptor_product = 'claude-code' AND descriptor_access IN ('native-rc', 'tmux'))
    OR (descriptor_product = 'codex' AND descriptor_access = 'app-server')
    OR (descriptor_product = 'opencode' AND descriptor_access = 'server')
  ),
  CHECK (
    (semantic_conversation_id IS NULL) = (current_binding_incarnation_id IS NULL)
  ),
  CHECK (state <> 'starting' OR semantic_conversation_id IS NULL),
  CHECK (state <> 'current' OR semantic_conversation_id IS NOT NULL),
  FOREIGN KEY (collaboration_server_id, project_id, logical_chat_id)
    REFERENCES logical_chats (collaboration_server_id, project_id, logical_chat_id)
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_REGISTRATION_INTENTS_SQL = `CREATE TABLE native_registration_intents (
  registration_attempt_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(registration_attempt_id) = 27
    AND substr(registration_attempt_id, 1, 5) = 'rcra_'
    AND registration_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_binding_id TEXT NOT NULL CHECK (
    length(native_binding_id) = 27
    AND substr(native_binding_id, 1, 5) = 'rcnb_'
    AND native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  canonical_intent_schema_id TEXT NOT NULL CHECK (
    canonical_intent_schema_id = 'remote-claw/native-registration-intent/v1'
  ),
  descriptor_ref TEXT NOT NULL CHECK (
    length(descriptor_ref) BETWEEN 1 AND 128
    AND descriptor_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  descriptor_digest TEXT NOT NULL CHECK (
    length(descriptor_digest) = 43
    AND descriptor_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  project_ref TEXT NOT NULL CHECK (
    length(project_ref) BETWEEN 1 AND 128
    AND project_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_digest TEXT NOT NULL CHECK (
    length(project_digest) = 43
    AND project_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  expected_native_ref_digest TEXT CHECK (
    expected_native_ref_digest IS NULL OR (
      length(expected_native_ref_digest) = 43
      AND expected_native_ref_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  initial_phase TEXT NOT NULL CHECK (initial_phase IN ('starting', 'recovering')),
  metadata_schema_id TEXT NOT NULL CHECK (length(metadata_schema_id) BETWEEN 1 AND 1024),
  metadata_ref TEXT NOT NULL CHECK (
    length(metadata_ref) BETWEEN 1 AND 128
    AND metadata_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  metadata_digest TEXT NOT NULL CHECK (
    length(metadata_digest) = 43
    AND metadata_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  capabilities_ref TEXT CHECK (
    capabilities_ref IS NULL OR (
      length(capabilities_ref) BETWEEN 1 AND 128
      AND capabilities_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  capabilities_digest TEXT CHECK (
    capabilities_digest IS NULL OR (
      length(capabilities_digest) = 43
      AND capabilities_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  canonical_intent_digest TEXT NOT NULL CHECK (
    length(canonical_intent_digest) = 43
    AND canonical_intent_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((capabilities_ref IS NULL) = (capabilities_digest IS NULL)),
  FOREIGN KEY (collaboration_server_id, native_binding_id)
    REFERENCES native_bindings (collaboration_server_id, native_binding_id)
) STRICT, WITHOUT ROWID`;

const CREATE_INWARD_COLLABORATION_EDGES_SQL = `CREATE TABLE inward_collaboration_edges (
  inward_edge_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(inward_edge_id) = 27
    AND substr(inward_edge_id, 1, 5) = 'rcie_'
    AND inward_edge_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  represented_server_id TEXT NOT NULL CHECK (
    length(represented_server_id) = 26
    AND substr(represented_server_id, 1, 4) = 'rcs_'
    AND represented_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  represented_logical_chat_id TEXT NOT NULL CHECK (
    length(represented_logical_chat_id) = 26
    AND substr(represented_logical_chat_id, 1, 4) = 'rcl_'
    AND represented_logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  target_kind TEXT NOT NULL CHECK (target_kind = 'native-harness'),
  target_server_id TEXT CHECK (
    target_server_id IS NULL OR (
      length(target_server_id) = 26
      AND substr(target_server_id, 1, 4) = 'rcs_'
      AND target_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  target_logical_chat_id TEXT CHECK (
    target_logical_chat_id IS NULL OR (
      length(target_logical_chat_id) = 26
      AND substr(target_logical_chat_id, 1, 4) = 'rcl_'
      AND target_logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  target_native_binding_id TEXT CHECK (
    target_native_binding_id IS NULL OR (
      length(target_native_binding_id) = 27
      AND substr(target_native_binding_id, 1, 5) = 'rcnb_'
      AND target_native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  root_path_certificate_id TEXT CHECK (
    root_path_certificate_id IS NULL OR (
      length(root_path_certificate_id) BETWEEN 1 AND 128
      AND root_path_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  current_connection_epoch INTEGER NOT NULL CHECK (
    current_connection_epoch BETWEEN 0 AND 9007199254740991
  ),
  current_live_lease_id TEXT CHECK (
    current_live_lease_id IS NULL OR (
      length(current_live_lease_id) BETWEEN 1 AND 128
      AND current_live_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  current_capability_snapshot_id TEXT CHECK (
    current_capability_snapshot_id IS NULL OR (
      length(current_capability_snapshot_id) BETWEEN 1 AND 128
      AND current_capability_snapshot_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('installing', 'installed', 'current', 'superseded', 'closed')),
  CHECK (
    (
      target_kind = 'native-harness'
      AND target_native_binding_id IS NOT NULL
      AND target_server_id IS NULL
      AND target_logical_chat_id IS NULL
    ) OR (
      target_kind = 'remote-claw-server'
      AND target_native_binding_id IS NULL
      AND target_server_id IS NOT NULL
      AND target_logical_chat_id IS NOT NULL
      AND target_server_id <> represented_server_id
    )
  ),
  CHECK ((state = 'installing') = (root_path_certificate_id IS NULL)),
  CHECK (
    state <> 'installing' OR (
      current_connection_epoch = 0
      AND current_live_lease_id IS NULL
      AND current_capability_snapshot_id IS NULL
    )
  ),
  CHECK (
    target_kind <> 'native-harness' OR (
      current_connection_epoch = 0
      AND current_live_lease_id IS NULL
      AND current_capability_snapshot_id IS NULL
    )
  ),
  CHECK (
    target_kind <> 'remote-claw-server'
    OR (current_live_lease_id IS NULL) = (current_capability_snapshot_id IS NULL)
  ),
  CHECK (
    target_kind <> 'remote-claw-server'
    OR current_live_lease_id IS NULL
    OR current_connection_epoch > 0
  ),
  CHECK (
    target_kind <> 'remote-claw-server'
    OR state <> 'current'
    OR current_live_lease_id IS NOT NULL
  ),
  FOREIGN KEY (represented_server_id, represented_logical_chat_id)
    REFERENCES logical_chats (collaboration_server_id, logical_chat_id),
  FOREIGN KEY (
    represented_server_id,
    represented_logical_chat_id,
    target_native_binding_id
  ) REFERENCES native_bindings (
    collaboration_server_id,
    logical_chat_id,
    native_binding_id
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_COORDINATOR_LEASES_SQL = `CREATE TABLE coordinator_leases (
  coordinator_lease_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  owner_instance_id TEXT NOT NULL CHECK (
    length(owner_instance_id) BETWEEN 1 AND 128
    AND owner_instance_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms BETWEEN 0 AND 9007199254740991),
  initial_heartbeat_deadline_ms INTEGER NOT NULL CHECK (
    initial_heartbeat_deadline_ms BETWEEN 0 AND 9007199254740991
  ),
  heartbeat_deadline_ms INTEGER NOT NULL CHECK (
    heartbeat_deadline_ms BETWEEN 0 AND 9007199254740991
  ),
  released_at_ms INTEGER CHECK (
    released_at_ms IS NULL OR released_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'released')),
  CHECK (initial_heartbeat_deadline_ms > acquired_at_ms),
  CHECK (heartbeat_deadline_ms >= initial_heartbeat_deadline_ms),
  CHECK (released_at_ms IS NULL OR released_at_ms >= acquired_at_ms),
  CHECK (released_at_ms IS NULL OR released_at_ms < heartbeat_deadline_ms),
  CHECK ((state = 'released') = (released_at_ms IS NOT NULL)),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id)
) STRICT, WITHOUT ROWID`;

const CREATE_CONTROL_JOURNAL_ENTRIES_SQL = `CREATE TABLE control_journal_entries (
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  journal_offset INTEGER NOT NULL CHECK (journal_offset BETWEEN 0 AND 9007199254740991),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('server_control', 'chat')),
  logical_chat_id TEXT CHECK (
    logical_chat_id IS NULL OR (
      length(logical_chat_id) = 26
      AND substr(logical_chat_id, 1, 4) = 'rcl_'
      AND logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN (
      'project_bootstrapped',
      'terminal_chat_reserved',
      'project_target_mapping_replaced',
      'coordinator_lease_acquired',
      'coordinator_lease_released'
    )
  ),
  subject_kind TEXT NOT NULL CHECK (
    subject_kind IN ('project', 'logical_chat', 'project_target_mapping', 'coordinator_lease')
  ),
  subject_id TEXT NOT NULL CHECK (
    length(subject_id) BETWEEN 1 AND 128
    AND subject_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  entry_schema_id TEXT NOT NULL CHECK (length(entry_schema_id) BETWEEN 1 AND 1024),
  entry_digest TEXT NOT NULL CHECK (
    length(entry_digest) = 43
    AND entry_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_lease_id TEXT NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (collaboration_server_id, journal_offset),
  CHECK (
    (scope_kind = 'server_control' AND logical_chat_id IS NULL)
    OR (scope_kind = 'chat' AND logical_chat_id IS NOT NULL)
  ),
  CHECK (
    (entry_kind = 'project_bootstrapped' AND subject_kind = 'project')
    OR (entry_kind = 'terminal_chat_reserved' AND subject_kind = 'logical_chat')
    OR (
      entry_kind = 'project_target_mapping_replaced'
      AND subject_kind = 'project_target_mapping'
    )
    OR (
      entry_kind IN ('coordinator_lease_acquired', 'coordinator_lease_released')
      AND subject_kind = 'coordinator_lease'
    )
  ),
  CHECK (
    (entry_kind = 'project_bootstrapped'
      AND entry_schema_id = 'remote-claw/project-bootstrap/v1')
    OR (entry_kind = 'terminal_chat_reserved'
      AND entry_schema_id = 'remote-claw/terminal-chat-reservation/v1')
    OR (entry_kind = 'project_target_mapping_replaced'
      AND entry_schema_id = 'remote-claw/project-target-mapping-replacement/v1')
    OR (entry_kind = 'coordinator_lease_acquired'
      AND entry_schema_id = 'remote-claw/coordinator-lease-acquisition/v1')
    OR (entry_kind = 'coordinator_lease_released'
      AND entry_schema_id = 'remote-claw/coordinator-lease-release/v1')
  ),
  CHECK (
    subject_kind <> 'project' OR (
      length(subject_id) = 27
      AND substr(subject_id, 1, 5) = 'rcpj_'
      AND subject_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  CHECK (
    subject_kind <> 'logical_chat' OR (
      length(subject_id) = 26
      AND substr(subject_id, 1, 4) = 'rcl_'
      AND subject_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  CHECK (
    subject_kind <> 'project_target_mapping' OR (
      length(subject_id) = 47
      AND substr(subject_id, 1, 4) = 'ptm_'
      AND subject_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  CHECK (
    subject_kind <> 'coordinator_lease' OR (
      length(subject_id) = 27
      AND substr(subject_id, 1, 5) = 'rccl_'
      AND subject_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND subject_id = coordinator_lease_id
    )
  ),
  CHECK (
    entry_kind NOT IN (
      'project_bootstrapped',
      'terminal_chat_reserved',
      'project_target_mapping_replaced',
      'coordinator_lease_acquired',
      'coordinator_lease_released'
    ) OR scope_kind = 'server_control'
  ),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id),
  FOREIGN KEY (collaboration_server_id, logical_chat_id)
    REFERENCES logical_chats (collaboration_server_id, logical_chat_id),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    )
) STRICT, WITHOUT ROWID`;

const CREATE_COLLABORATION_SERVERS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX collaboration_servers_scope_unique
ON collaboration_servers (collaboration_server_id, machine_identity_id)`;

const CREATE_PROJECTS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX projects_scope_unique
ON projects (collaboration_server_id, project_id)`;

const CREATE_PROJECTS_ALLOCATION_INTENT_INDEX_SQL = `CREATE UNIQUE INDEX projects_allocation_intent_unique
ON projects (collaboration_server_id, project_allocation_intent_id)`;

const CREATE_PROJECTS_FIRST_BOOTSTRAP_INDEX_SQL = `CREATE UNIQUE INDEX projects_first_bootstrap_unique
ON projects (collaboration_server_id)
WHERE allocation_kind = 'first_bootstrap'`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX project_target_selector_mappings_scope_unique
ON project_target_selector_mappings (
  project_target_selector_mapping_id,
  collaboration_server_id,
  project_id
)`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_INITIAL_INDEX_SQL = `CREATE UNIQUE INDEX project_target_selector_mappings_initial_unique
ON project_target_selector_mappings (
  project_target_selector_mapping_id,
  collaboration_server_id,
  project_id,
  workspace_selector_id,
  target_digest,
  mapping_generation,
  target_kind
)`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX project_target_selector_mappings_generation_unique
ON project_target_selector_mappings (
  collaboration_server_id,
  project_id,
  workspace_selector_id,
  mapping_generation
)`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX project_target_selector_mappings_current_unique
ON project_target_selector_mappings (
  collaboration_server_id,
  project_id,
  workspace_selector_id
)
WHERE state = 'current'`;

const CREATE_LOGICAL_CHATS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX logical_chats_scope_unique
ON logical_chats (collaboration_server_id, logical_chat_id)`;

const CREATE_LOGICAL_CHATS_PROJECT_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX logical_chats_project_scope_unique
ON logical_chats (collaboration_server_id, project_id, logical_chat_id)`;

const CREATE_NATIVE_BINDINGS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX native_bindings_scope_unique
ON native_bindings (collaboration_server_id, logical_chat_id, native_binding_id)`;

const CREATE_NATIVE_BINDINGS_SERVER_ID_INDEX_SQL = `CREATE UNIQUE INDEX native_bindings_server_id_unique
ON native_bindings (collaboration_server_id, native_binding_id)`;

const CREATE_NATIVE_BINDINGS_ACTIVE_CHAT_INDEX_SQL = `CREATE UNIQUE INDEX native_bindings_active_chat_unique
ON native_bindings (collaboration_server_id, logical_chat_id)
WHERE state IN ('starting', 'current')`;

const CREATE_NATIVE_REGISTRATION_INTENTS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX native_registration_intents_scope_unique
ON native_registration_intents (collaboration_server_id, registration_attempt_id)`;

const CREATE_NATIVE_REGISTRATION_INTENTS_BINDING_INDEX_SQL = `CREATE UNIQUE INDEX native_registration_intents_binding_unique
ON native_registration_intents (collaboration_server_id, native_binding_id)`;

const CREATE_INWARD_COLLABORATION_EDGES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX inward_collaboration_edges_scope_unique
ON inward_collaboration_edges (
  represented_server_id,
  represented_logical_chat_id,
  inward_edge_id
)`;

const CREATE_INWARD_COLLABORATION_EDGES_TARGET_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX inward_collaboration_edges_target_scope_unique
ON inward_collaboration_edges (
  represented_server_id,
  represented_logical_chat_id,
  inward_edge_id,
  target_native_binding_id
)`;

const CREATE_INWARD_COLLABORATION_EDGES_ACTIVE_CHAT_INDEX_SQL = `CREATE UNIQUE INDEX inward_collaboration_edges_active_chat_unique
ON inward_collaboration_edges (represented_server_id, represented_logical_chat_id)
WHERE state IN ('installing', 'installed', 'current')`;

const CREATE_INWARD_COLLABORATION_EDGES_ACTIVE_NATIVE_INDEX_SQL = `CREATE UNIQUE INDEX inward_collaboration_edges_active_native_binding_unique
ON inward_collaboration_edges (target_native_binding_id)
WHERE target_kind = 'native-harness' AND state IN ('installing', 'installed', 'current')`;

const CREATE_COORDINATOR_LEASES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX coordinator_leases_scope_unique
ON coordinator_leases (
  coordinator_lease_id,
  collaboration_server_id,
  coordinator_epoch
)`;

const CREATE_COORDINATOR_LEASES_SERVER_EPOCH_INDEX_SQL = `CREATE UNIQUE INDEX coordinator_leases_server_epoch_unique
ON coordinator_leases (collaboration_server_id, coordinator_epoch)`;

const CREATE_CONTROL_JOURNAL_ENTRIES_CORRELATION_INDEX_SQL = `CREATE UNIQUE INDEX control_journal_entries_correlation_unique
ON control_journal_entries (collaboration_server_id, entry_kind, subject_id)`;

const CREATE_COLLABORATION_SERVERS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_identity_immutable
BEFORE UPDATE ON collaboration_servers
WHEN NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.machine_identity_id IS NOT OLD.machine_identity_id
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'collaboration server identity is immutable');
END`;

const CREATE_COLLABORATION_SERVERS_STATE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_state_monotonic
BEFORE UPDATE OF state ON collaboration_servers
WHEN NOT (
  NEW.state = OLD.state
  OR (OLD.state = 'installing' AND NEW.state IN ('current', 'repairing', 'closed'))
  OR (OLD.state = 'current' AND NEW.state IN ('repairing', 'closed'))
  OR (OLD.state = 'repairing' AND NEW.state IN ('current', 'closed'))
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration server state transition is not allowed');
END`;

const CREATE_COLLABORATION_SERVERS_COORDINATOR_TRANSITION_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_coordinator_transition
BEFORE UPDATE ON collaboration_servers
WHEN NOT (
  (
    NEW.current_coordinator_lease_id IS OLD.current_coordinator_lease_id
    AND NEW.current_coordinator_epoch = OLD.current_coordinator_epoch
  ) OR (
    OLD.current_coordinator_lease_id IS NOT NULL
    AND NEW.current_coordinator_lease_id IS NULL
    AND NEW.current_coordinator_epoch = OLD.current_coordinator_epoch
    AND EXISTS (
      SELECT 1 FROM coordinator_leases AS released_current
      WHERE released_current.coordinator_lease_id = OLD.current_coordinator_lease_id
        AND released_current.collaboration_server_id = OLD.collaboration_server_id
        AND released_current.coordinator_epoch = OLD.current_coordinator_epoch
        AND released_current.state = 'released'
        AND released_current.released_at_ms IS NOT NULL
    )
  ) OR (
    NEW.current_coordinator_lease_id IS NOT NULL
    AND NEW.current_coordinator_lease_id IS NOT OLD.current_coordinator_lease_id
    AND OLD.current_coordinator_epoch < 9007199254740991
    AND NEW.current_coordinator_epoch = OLD.current_coordinator_epoch + 1
    AND EXISTS (
      SELECT 1
      FROM coordinator_leases AS successor
      WHERE successor.coordinator_lease_id = NEW.current_coordinator_lease_id
        AND successor.collaboration_server_id = NEW.collaboration_server_id
        AND successor.coordinator_epoch = NEW.current_coordinator_epoch
        AND successor.state = 'current'
        AND (
          (
            OLD.current_coordinator_lease_id IS NULL
            AND (
              OLD.current_coordinator_epoch = 0
              OR EXISTS (
                SELECT 1 FROM coordinator_leases AS released_predecessor
                WHERE released_predecessor.collaboration_server_id = OLD.collaboration_server_id
                  AND released_predecessor.coordinator_epoch = OLD.current_coordinator_epoch
                  AND released_predecessor.state = 'released'
                  AND released_predecessor.released_at_ms IS NOT NULL
                  AND successor.acquired_at_ms >= released_predecessor.released_at_ms
              )
            )
          ) OR (
            OLD.current_coordinator_lease_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM coordinator_leases AS predecessor
              WHERE predecessor.coordinator_lease_id = OLD.current_coordinator_lease_id
                AND predecessor.collaboration_server_id = OLD.collaboration_server_id
                AND predecessor.coordinator_epoch = OLD.current_coordinator_epoch
                AND predecessor.state = 'current'
                AND predecessor.released_at_ms IS NULL
                AND successor.acquired_at_ms >= predecessor.heartbeat_deadline_ms
            )
          )
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration server coordinator transition is not monotonic');
END`;

const CREATE_COLLABORATION_SERVERS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_no_delete
BEFORE DELETE ON collaboration_servers
BEGIN
  SELECT RAISE(ABORT, 'collaboration servers are retained');
END`;

const CREATE_COLLABORATION_SERVERS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_no_replace
BEFORE INSERT ON collaboration_servers
WHEN EXISTS (
  SELECT 1 FROM collaboration_servers
  WHERE collaboration_server_id = NEW.collaboration_server_id
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration server identity is immutable');
END`;

const CREATE_HOST_STATE_PROFILES_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER host_state_profiles_no_update
BEFORE UPDATE ON host_state_profiles
BEGIN
  SELECT RAISE(ABORT, 'host state profiles are immutable');
END`;

const CREATE_HOST_STATE_PROFILES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER host_state_profiles_no_delete
BEFORE DELETE ON host_state_profiles
BEGIN
  SELECT RAISE(ABORT, 'host state profiles are retained');
END`;

const CREATE_HOST_STATE_PROFILES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER host_state_profiles_no_replace
BEFORE INSERT ON host_state_profiles
WHEN EXISTS (
  SELECT 1 FROM host_state_profiles
  WHERE state_profile_id = NEW.state_profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'host state profiles are immutable');
END`;

const CREATE_PROJECTS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER projects_identity_immutable
BEFORE UPDATE ON projects
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.project_allocation_intent_id IS NOT OLD.project_allocation_intent_id
  OR NEW.project_allocation_intent_schema_id IS NOT OLD.project_allocation_intent_schema_id
  OR NEW.project_allocation_intent_digest IS NOT OLD.project_allocation_intent_digest
  OR NEW.allocation_kind IS NOT OLD.allocation_kind
  OR NEW.initial_workspace_selector_id IS NOT OLD.initial_workspace_selector_id
  OR NEW.initial_target_digest IS NOT OLD.initial_target_digest
  OR NEW.initial_project_target_selector_mapping_id IS NOT OLD.initial_project_target_selector_mapping_id
  OR NEW.initial_mapping_generation IS NOT OLD.initial_mapping_generation
  OR NEW.initial_target_kind IS NOT OLD.initial_target_kind
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'project identity and allocation intent are immutable');
END`;

const CREATE_PROJECTS_INITIAL_MAPPING_TRIGGER_SQL = `CREATE TRIGGER projects_require_current_initial_mapping
BEFORE INSERT ON projects
WHEN NOT EXISTS (
  SELECT 1 FROM project_target_selector_mappings
  WHERE project_target_selector_mapping_id = NEW.initial_project_target_selector_mapping_id
    AND collaboration_server_id = NEW.collaboration_server_id
    AND project_id = NEW.project_id
    AND workspace_selector_id = NEW.initial_workspace_selector_id
    AND target_digest = NEW.initial_target_digest
    AND mapping_generation = NEW.initial_mapping_generation
    AND target_kind = NEW.initial_target_kind
    AND state = 'current'
)
BEGIN
  SELECT RAISE(ABORT, 'project requires its exact current generation-one terminal mapping');
END`;

const CREATE_PROJECTS_STATE_TRIGGER_SQL = `CREATE TRIGGER projects_state_monotonic
BEFORE UPDATE OF state ON projects
WHEN OLD.state = 'closed' AND NEW.state <> 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed projects cannot be reopened');
END`;

const CREATE_PROJECTS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER projects_no_delete
BEFORE DELETE ON projects
BEGIN
  SELECT RAISE(ABORT, 'projects are retained');
END`;

const CREATE_PROJECTS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER projects_no_replace
BEFORE INSERT ON projects
WHEN EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = NEW.project_id
    OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND project_allocation_intent_id = NEW.project_allocation_intent_id
    )
    OR (
      NEW.allocation_kind = 'first_bootstrap'
      AND collaboration_server_id = NEW.collaboration_server_id
      AND allocation_kind = 'first_bootstrap'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'project allocation records cannot be replaced');
END`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER project_target_selector_mappings_identity_immutable
BEFORE UPDATE ON project_target_selector_mappings
WHEN NEW.project_target_selector_mapping_id IS NOT OLD.project_target_selector_mapping_id
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.workspace_selector_id IS NOT OLD.workspace_selector_id
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_product IS NOT OLD.target_product
  OR NEW.target_access IS NOT OLD.target_access
  OR NEW.terminal_project_ref IS NOT OLD.terminal_project_ref
  OR NEW.native_workspace_binding_id IS NOT OLD.native_workspace_binding_id
  OR NEW.nested_server_management_binding_id IS NOT OLD.nested_server_management_binding_id
  OR NEW.target_server_id IS NOT OLD.target_server_id
  OR NEW.target_project_id IS NOT OLD.target_project_id
  OR NEW.target_workspace_selector_id IS NOT OLD.target_workspace_selector_id
  OR NEW.target_digest IS NOT OLD.target_digest
  OR NEW.mapping_generation IS NOT OLD.mapping_generation
  OR NEW.evidence_ref IS NOT OLD.evidence_ref
BEGIN
  SELECT RAISE(ABORT, 'project target selector mapping identity is immutable');
END`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_STATE_TRIGGER_SQL = `CREATE TRIGGER project_target_selector_mappings_state_monotonic
BEFORE UPDATE OF state ON project_target_selector_mappings
WHEN (OLD.state = 'closed' AND NEW.state <> 'closed')
  OR (OLD.state = 'superseded' AND NEW.state = 'current')
BEGIN
  SELECT RAISE(ABORT, 'project target selector mapping state cannot be resurrected');
END`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_PREDECESSOR_TRIGGER_SQL = `CREATE TRIGGER project_target_selector_mappings_require_predecessor
BEFORE INSERT ON project_target_selector_mappings
WHEN NEW.mapping_generation > 1
  AND NOT EXISTS (
    SELECT 1 FROM project_target_selector_mappings
    WHERE collaboration_server_id = NEW.collaboration_server_id
      AND project_id = NEW.project_id
      AND workspace_selector_id = NEW.workspace_selector_id
      AND mapping_generation = NEW.mapping_generation - 1
      AND state = 'superseded'
  )
BEGIN
  SELECT RAISE(ABORT, 'replacement project target mapping requires its superseded predecessor');
END`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER project_target_selector_mappings_no_delete
BEFORE DELETE ON project_target_selector_mappings
BEGIN
  SELECT RAISE(ABORT, 'project target selector mappings are retained');
END`;

const CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER project_target_selector_mappings_no_replace
BEFORE INSERT ON project_target_selector_mappings
WHEN EXISTS (
  SELECT 1 FROM project_target_selector_mappings
  WHERE project_target_selector_mapping_id = NEW.project_target_selector_mapping_id
    OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND project_id = NEW.project_id
      AND workspace_selector_id = NEW.workspace_selector_id
      AND mapping_generation = NEW.mapping_generation
    )
    OR (
      NEW.state = 'current'
      AND collaboration_server_id = NEW.collaboration_server_id
      AND project_id = NEW.project_id
      AND workspace_selector_id = NEW.workspace_selector_id
      AND state = 'current'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'project target selector mappings cannot be replaced');
END`;

const CREATE_LOGICAL_CHATS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER logical_chats_identity_immutable
BEFORE UPDATE ON logical_chats
WHEN NEW.logical_chat_id IS NOT OLD.logical_chat_id
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.project_target_selector_mapping_id IS NOT OLD.project_target_selector_mapping_id
  OR NEW.parent_chat_id IS NOT OLD.parent_chat_id
BEGIN
  SELECT RAISE(ABORT, 'logical chat identity and lineage are immutable');
END`;

const CREATE_LOGICAL_CHATS_MAPPING_TRIGGER_SQL = `CREATE TRIGGER logical_chats_require_current_mapping
BEFORE INSERT ON logical_chats
WHEN NOT EXISTS (
  SELECT 1 FROM project_target_selector_mappings
  WHERE project_target_selector_mapping_id = NEW.project_target_selector_mapping_id
    AND collaboration_server_id = NEW.collaboration_server_id
    AND project_id = NEW.project_id
    AND state = 'current'
    AND (
      (target_kind = 'terminal_native' AND NEW.current_native_binding_id IS NOT NULL)
      OR (target_kind = 'nested_server' AND NEW.current_native_binding_id IS NULL)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'logical chat requires its exact current mapping and target-shaped binding');
END`;

const CREATE_LOGICAL_CHATS_STATE_TRIGGER_SQL = `CREATE TRIGGER logical_chats_state_monotonic
BEFORE UPDATE OF state ON logical_chats
WHEN OLD.state = 'closed' AND NEW.state <> 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed logical chats cannot be reopened');
END`;

const CREATE_LOGICAL_CHATS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER logical_chats_no_delete
BEFORE DELETE ON logical_chats
BEGIN
  SELECT RAISE(ABORT, 'logical chats are retained');
END`;

const CREATE_LOGICAL_CHATS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER logical_chats_no_replace
BEFORE INSERT ON logical_chats
WHEN EXISTS (
  SELECT 1 FROM logical_chats WHERE logical_chat_id = NEW.logical_chat_id
)
BEGIN
  SELECT RAISE(ABORT, 'logical chat identity is immutable');
END`;

const CREATE_NATIVE_BINDINGS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_bindings_identity_immutable
BEFORE UPDATE ON native_bindings
WHEN NEW.native_binding_id IS NOT OLD.native_binding_id
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
  OR NEW.descriptor_product IS NOT OLD.descriptor_product
  OR NEW.descriptor_access IS NOT OLD.descriptor_access
  OR NEW.project_id IS NOT OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'native binding identity and scope are immutable');
END`;

const CREATE_NATIVE_BINDINGS_SEMANTIC_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_bindings_semantic_identity_immutable
BEFORE UPDATE ON native_bindings
WHEN OLD.semantic_conversation_id IS NOT NULL
  AND NEW.semantic_conversation_id IS NOT OLD.semantic_conversation_id
BEGIN
  SELECT RAISE(ABORT, 'native semantic conversation identity is immutable once resolved');
END`;

const CREATE_NATIVE_BINDINGS_MAPPING_TRIGGER_SQL = `CREATE TRIGGER native_bindings_require_current_terminal_mapping
BEFORE INSERT ON native_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM logical_chats AS chat
  JOIN project_target_selector_mappings AS mapping
    ON mapping.project_target_selector_mapping_id = chat.project_target_selector_mapping_id
    AND mapping.collaboration_server_id = chat.collaboration_server_id
    AND mapping.project_id = chat.project_id
  WHERE chat.collaboration_server_id = NEW.collaboration_server_id
    AND chat.logical_chat_id = NEW.logical_chat_id
    AND chat.project_id = NEW.project_id
    AND mapping.state = 'current'
    AND mapping.target_kind = 'terminal_native'
    AND mapping.target_product = NEW.descriptor_product
    AND mapping.target_access = NEW.descriptor_access
)
BEGIN
  SELECT RAISE(ABORT, 'native binding requires its chat current terminal mapping and descriptor');
END`;

const CREATE_NATIVE_BINDINGS_STATE_TRIGGER_SQL = `CREATE TRIGGER native_bindings_state_monotonic
BEFORE UPDATE OF state ON native_bindings
WHEN (OLD.state = 'closed' AND NEW.state <> 'closed')
  OR (OLD.state = 'superseded' AND NEW.state IN ('starting', 'current'))
BEGIN
  SELECT RAISE(ABORT, 'native binding state cannot be resurrected');
END`;

const CREATE_NATIVE_BINDINGS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_bindings_no_delete
BEFORE DELETE ON native_bindings
BEGIN
  SELECT RAISE(ABORT, 'native bindings are retained');
END`;

const CREATE_NATIVE_BINDINGS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_bindings_no_replace
BEFORE INSERT ON native_bindings
WHEN EXISTS (
  SELECT 1 FROM native_bindings
  WHERE native_binding_id = NEW.native_binding_id
    OR (
      NEW.state IN ('starting', 'current')
      AND collaboration_server_id = NEW.collaboration_server_id
      AND logical_chat_id = NEW.logical_chat_id
      AND state IN ('starting', 'current')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native bindings cannot be replaced');
END`;

const CREATE_NATIVE_REGISTRATION_INTENTS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER native_registration_intents_no_update
BEFORE UPDATE ON native_registration_intents
BEGIN
  SELECT RAISE(ABORT, 'native registration intents are immutable');
END`;

const CREATE_NATIVE_REGISTRATION_INTENTS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_registration_intents_no_delete
BEFORE DELETE ON native_registration_intents
BEGIN
  SELECT RAISE(ABORT, 'native registration intents are retained');
END`;

const CREATE_NATIVE_REGISTRATION_INTENTS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_registration_intents_no_replace
BEFORE INSERT ON native_registration_intents
WHEN EXISTS (
  SELECT 1 FROM native_registration_intents
  WHERE registration_attempt_id = NEW.registration_attempt_id
    OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND native_binding_id = NEW.native_binding_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native registration intents cannot be replaced');
END`;

const CREATE_INWARD_COLLABORATION_EDGES_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER inward_collaboration_edges_identity_immutable
BEFORE UPDATE ON inward_collaboration_edges
WHEN NEW.inward_edge_id IS NOT OLD.inward_edge_id
  OR NEW.represented_server_id IS NOT OLD.represented_server_id
  OR NEW.represented_logical_chat_id IS NOT OLD.represented_logical_chat_id
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_server_id IS NOT OLD.target_server_id
  OR NEW.target_logical_chat_id IS NOT OLD.target_logical_chat_id
  OR NEW.target_native_binding_id IS NOT OLD.target_native_binding_id
BEGIN
  SELECT RAISE(ABORT, 'inward collaboration edge identity and target are immutable');
END`;

const CREATE_INWARD_COLLABORATION_EDGES_STATE_TRIGGER_SQL = `CREATE TRIGGER inward_collaboration_edges_state_monotonic
BEFORE UPDATE OF state ON inward_collaboration_edges
WHEN (OLD.state = 'closed' AND NEW.state <> 'closed')
  OR (OLD.state = 'superseded' AND NEW.state IN ('installing', 'installed', 'current'))
BEGIN
  SELECT RAISE(ABORT, 'inward collaboration edge state cannot be resurrected');
END`;

const CREATE_INWARD_COLLABORATION_EDGES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER inward_collaboration_edges_no_delete
BEFORE DELETE ON inward_collaboration_edges
BEGIN
  SELECT RAISE(ABORT, 'inward collaboration edges are retained');
END`;

const CREATE_INWARD_COLLABORATION_EDGES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER inward_collaboration_edges_no_replace
BEFORE INSERT ON inward_collaboration_edges
WHEN EXISTS (
  SELECT 1 FROM inward_collaboration_edges
  WHERE inward_edge_id = NEW.inward_edge_id
    OR (
      NEW.state IN ('installing', 'installed', 'current')
      AND represented_server_id = NEW.represented_server_id
      AND represented_logical_chat_id = NEW.represented_logical_chat_id
      AND state IN ('installing', 'installed', 'current')
    )
    OR (
      NEW.target_kind = 'native-harness'
      AND NEW.state IN ('installing', 'installed', 'current')
      AND target_native_binding_id = NEW.target_native_binding_id
      AND target_kind = 'native-harness'
      AND state IN ('installing', 'installed', 'current')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'inward collaboration edges cannot be replaced');
END`;

const CREATE_COORDINATOR_LEASES_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER coordinator_leases_identity_immutable
BEFORE UPDATE ON coordinator_leases
WHEN NEW.coordinator_lease_id IS NOT OLD.coordinator_lease_id
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.coordinator_epoch IS NOT OLD.coordinator_epoch
  OR NEW.owner_instance_id IS NOT OLD.owner_instance_id
  OR NEW.acquired_at_ms IS NOT OLD.acquired_at_ms
  OR NEW.initial_heartbeat_deadline_ms IS NOT OLD.initial_heartbeat_deadline_ms
BEGIN
  SELECT RAISE(ABORT, 'coordinator lease identity is immutable');
END`;

const CREATE_COORDINATOR_LEASES_HEARTBEAT_TRIGGER_SQL = `CREATE TRIGGER coordinator_leases_heartbeat_monotonic
BEFORE UPDATE OF heartbeat_deadline_ms ON coordinator_leases
WHEN NEW.heartbeat_deadline_ms <= OLD.heartbeat_deadline_ms
  OR OLD.state <> 'current'
  OR NEW.state <> 'current'
  OR NOT EXISTS (
    SELECT 1 FROM collaboration_servers
    WHERE collaboration_server_id = NEW.collaboration_server_id
      AND current_coordinator_lease_id = NEW.coordinator_lease_id
      AND current_coordinator_epoch = NEW.coordinator_epoch
  )
BEGIN
  SELECT RAISE(ABORT, 'only the current coordinator lease may strictly extend its heartbeat');
END`;

const CREATE_COORDINATOR_LEASES_STATE_TRIGGER_SQL = `CREATE TRIGGER coordinator_leases_state_monotonic
BEFORE UPDATE OF state ON coordinator_leases
WHEN NEW.state IS NOT OLD.state
  AND NOT (
    OLD.state = 'current'
    AND NEW.state = 'released'
    AND EXISTS (
      SELECT 1 FROM collaboration_servers
      WHERE collaboration_server_id = OLD.collaboration_server_id
        AND current_coordinator_lease_id = OLD.coordinator_lease_id
        AND current_coordinator_epoch = OLD.coordinator_epoch
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'coordinator lease state allows only current to released');
END`;

const CREATE_COORDINATOR_LEASES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER coordinator_leases_no_delete
BEFORE DELETE ON coordinator_leases
BEGIN
  SELECT RAISE(ABORT, 'coordinator leases are retained');
END`;

const CREATE_COORDINATOR_LEASES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER coordinator_leases_no_replace
BEFORE INSERT ON coordinator_leases
WHEN EXISTS (
  SELECT 1 FROM coordinator_leases
  WHERE coordinator_lease_id = NEW.coordinator_lease_id
    OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND coordinator_epoch = NEW.coordinator_epoch
    )
)
BEGIN
  SELECT RAISE(ABORT, 'coordinator leases cannot be replaced');
END`;

const CREATE_CONTROL_JOURNAL_ENTRIES_OFFSET_TRIGGER_SQL = `CREATE TRIGGER control_journal_entries_require_next_offset
BEFORE INSERT ON control_journal_entries
WHEN NEW.journal_offset IS NOT (
  SELECT next_journal_offset FROM collaboration_servers
  WHERE collaboration_server_id = NEW.collaboration_server_id
)
  OR NEW.journal_offset >= 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'control journal offset is not the next server offset');
END`;

const CREATE_CONTROL_JOURNAL_ENTRIES_INCREMENT_TRIGGER_SQL = `CREATE TRIGGER control_journal_entries_increment_offset
AFTER INSERT ON control_journal_entries
BEGIN
  UPDATE collaboration_servers
  SET next_journal_offset = next_journal_offset + 1
  WHERE collaboration_server_id = NEW.collaboration_server_id;
END`;

const CREATE_CONTROL_JOURNAL_ENTRIES_SUBJECT_TRIGGER_SQL = `CREATE TRIGGER control_journal_entries_require_subject
BEFORE INSERT ON control_journal_entries
WHEN (
    NEW.subject_kind = 'project'
    AND NOT EXISTS (
      SELECT 1 FROM projects
      WHERE collaboration_server_id = NEW.collaboration_server_id
        AND project_id = NEW.subject_id
    )
  ) OR (
    NEW.subject_kind = 'logical_chat'
    AND NOT EXISTS (
      SELECT 1 FROM logical_chats
      WHERE collaboration_server_id = NEW.collaboration_server_id
        AND logical_chat_id = NEW.subject_id
    )
  ) OR (
    NEW.subject_kind = 'project_target_mapping'
    AND NOT EXISTS (
      SELECT 1 FROM project_target_selector_mappings
      WHERE collaboration_server_id = NEW.collaboration_server_id
        AND project_target_selector_mapping_id = NEW.subject_id
        AND mapping_generation > 1
        AND state = 'current'
    )
  ) OR (
    NEW.subject_kind = 'coordinator_lease'
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_leases
      WHERE collaboration_server_id = NEW.collaboration_server_id
        AND coordinator_lease_id = NEW.subject_id
        AND coordinator_epoch = NEW.coordinator_epoch
        AND (
          (NEW.entry_kind = 'coordinator_lease_acquired' AND state = 'current')
          OR (NEW.entry_kind = 'coordinator_lease_released' AND state = 'released')
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'control journal subject is not present in its server scope');
END`;

const CREATE_CONTROL_JOURNAL_ENTRIES_COORDINATOR_TRIGGER_SQL = `CREATE TRIGGER control_journal_entries_require_current_coordinator
BEFORE INSERT ON control_journal_entries
WHEN NOT EXISTS (
  SELECT 1
  FROM collaboration_servers AS server
  JOIN coordinator_leases AS lease
    ON lease.coordinator_lease_id = server.current_coordinator_lease_id
    AND lease.collaboration_server_id = server.collaboration_server_id
    AND lease.coordinator_epoch = server.current_coordinator_epoch
  WHERE server.collaboration_server_id = NEW.collaboration_server_id
    AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
    AND server.current_coordinator_epoch = NEW.coordinator_epoch
    AND NEW.committed_at_ms >= lease.acquired_at_ms
    AND NEW.committed_at_ms < lease.heartbeat_deadline_ms
)
BEGIN
  SELECT RAISE(ABORT, 'control journal entry requires the unexpired current coordinator fence');
END`;

const CREATE_CONTROL_JOURNAL_ENTRIES_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER control_journal_entries_no_update
BEFORE UPDATE ON control_journal_entries
BEGIN
  SELECT RAISE(ABORT, 'control journal is append-only');
END`;

const CREATE_CONTROL_JOURNAL_ENTRIES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER control_journal_entries_no_delete
BEFORE DELETE ON control_journal_entries
BEGIN
  SELECT RAISE(ABORT, 'control journal is append-only');
END`;

const CREATE_CONTROL_JOURNAL_ENTRIES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER control_journal_entries_no_replace
BEFORE INSERT ON control_journal_entries
WHEN EXISTS (
  SELECT 1 FROM control_journal_entries
  WHERE (
      collaboration_server_id = NEW.collaboration_server_id
      AND journal_offset = NEW.journal_offset
    ) OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND entry_kind = NEW.entry_kind
      AND subject_id = NEW.subject_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'control journal is append-only');
END`;

const VERSION_ONE_STATEMENTS = Object.freeze([
  CREATE_METADATA_SQL,
  CREATE_MIGRATIONS_SQL,
  CREATE_MIGRATIONS_ID_INDEX_SQL,
  CREATE_MIGRATIONS_NO_UPDATE_TRIGGER_SQL,
  CREATE_MIGRATIONS_NO_DELETE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_SQL,
] as const);

const VERSION_TWO_STATEMENTS = Object.freeze([
  CREATE_MIGRATIONS_NO_REPLACE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_NO_UPDATE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_NO_DELETE_TRIGGER_SQL,
  CREATE_PROTECTED_ARTIFACTS_NO_REPLACE_TRIGGER_SQL,
] as const);

const VERSION_THREE_STATEMENTS = Object.freeze([
  CREATE_METADATA_MACHINE_IDENTITY_INDEX_SQL,
  CREATE_COLLABORATION_SERVERS_SQL,
  CREATE_HOST_STATE_PROFILES_SQL,
  CREATE_PROJECTS_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_SQL,
  CREATE_LOGICAL_CHATS_SQL,
  CREATE_NATIVE_BINDINGS_SQL,
  CREATE_NATIVE_REGISTRATION_INTENTS_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_SQL,
  CREATE_COORDINATOR_LEASES_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_SQL,
  CREATE_COLLABORATION_SERVERS_SCOPE_INDEX_SQL,
  CREATE_PROJECTS_SCOPE_INDEX_SQL,
  CREATE_PROJECTS_ALLOCATION_INTENT_INDEX_SQL,
  CREATE_PROJECTS_FIRST_BOOTSTRAP_INDEX_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_SCOPE_INDEX_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_INITIAL_INDEX_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_GENERATION_INDEX_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_CURRENT_INDEX_SQL,
  CREATE_LOGICAL_CHATS_SCOPE_INDEX_SQL,
  CREATE_LOGICAL_CHATS_PROJECT_SCOPE_INDEX_SQL,
  CREATE_NATIVE_BINDINGS_SCOPE_INDEX_SQL,
  CREATE_NATIVE_BINDINGS_SERVER_ID_INDEX_SQL,
  CREATE_NATIVE_BINDINGS_ACTIVE_CHAT_INDEX_SQL,
  CREATE_NATIVE_REGISTRATION_INTENTS_SCOPE_INDEX_SQL,
  CREATE_NATIVE_REGISTRATION_INTENTS_BINDING_INDEX_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_SCOPE_INDEX_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_TARGET_SCOPE_INDEX_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_ACTIVE_CHAT_INDEX_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_ACTIVE_NATIVE_INDEX_SQL,
  CREATE_COORDINATOR_LEASES_SCOPE_INDEX_SQL,
  CREATE_COORDINATOR_LEASES_SERVER_EPOCH_INDEX_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_CORRELATION_INDEX_SQL,
  CREATE_COLLABORATION_SERVERS_IDENTITY_TRIGGER_SQL,
  CREATE_COLLABORATION_SERVERS_STATE_TRIGGER_SQL,
  CREATE_COLLABORATION_SERVERS_COORDINATOR_TRANSITION_TRIGGER_SQL,
  CREATE_COLLABORATION_SERVERS_NO_DELETE_TRIGGER_SQL,
  CREATE_COLLABORATION_SERVERS_NO_REPLACE_TRIGGER_SQL,
  CREATE_HOST_STATE_PROFILES_NO_UPDATE_TRIGGER_SQL,
  CREATE_HOST_STATE_PROFILES_NO_DELETE_TRIGGER_SQL,
  CREATE_HOST_STATE_PROFILES_NO_REPLACE_TRIGGER_SQL,
  CREATE_PROJECTS_IDENTITY_TRIGGER_SQL,
  CREATE_PROJECTS_INITIAL_MAPPING_TRIGGER_SQL,
  CREATE_PROJECTS_STATE_TRIGGER_SQL,
  CREATE_PROJECTS_NO_DELETE_TRIGGER_SQL,
  CREATE_PROJECTS_NO_REPLACE_TRIGGER_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_IDENTITY_TRIGGER_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_STATE_TRIGGER_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_PREDECESSOR_TRIGGER_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_NO_DELETE_TRIGGER_SQL,
  CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_NO_REPLACE_TRIGGER_SQL,
  CREATE_LOGICAL_CHATS_IDENTITY_TRIGGER_SQL,
  CREATE_LOGICAL_CHATS_MAPPING_TRIGGER_SQL,
  CREATE_LOGICAL_CHATS_STATE_TRIGGER_SQL,
  CREATE_LOGICAL_CHATS_NO_DELETE_TRIGGER_SQL,
  CREATE_LOGICAL_CHATS_NO_REPLACE_TRIGGER_SQL,
  CREATE_NATIVE_BINDINGS_IDENTITY_TRIGGER_SQL,
  CREATE_NATIVE_BINDINGS_SEMANTIC_IDENTITY_TRIGGER_SQL,
  CREATE_NATIVE_BINDINGS_MAPPING_TRIGGER_SQL,
  CREATE_NATIVE_BINDINGS_STATE_TRIGGER_SQL,
  CREATE_NATIVE_BINDINGS_NO_DELETE_TRIGGER_SQL,
  CREATE_NATIVE_BINDINGS_NO_REPLACE_TRIGGER_SQL,
  CREATE_NATIVE_REGISTRATION_INTENTS_NO_UPDATE_TRIGGER_SQL,
  CREATE_NATIVE_REGISTRATION_INTENTS_NO_DELETE_TRIGGER_SQL,
  CREATE_NATIVE_REGISTRATION_INTENTS_NO_REPLACE_TRIGGER_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_IDENTITY_TRIGGER_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_STATE_TRIGGER_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_NO_DELETE_TRIGGER_SQL,
  CREATE_INWARD_COLLABORATION_EDGES_NO_REPLACE_TRIGGER_SQL,
  CREATE_COORDINATOR_LEASES_IDENTITY_TRIGGER_SQL,
  CREATE_COORDINATOR_LEASES_HEARTBEAT_TRIGGER_SQL,
  CREATE_COORDINATOR_LEASES_STATE_TRIGGER_SQL,
  CREATE_COORDINATOR_LEASES_NO_DELETE_TRIGGER_SQL,
  CREATE_COORDINATOR_LEASES_NO_REPLACE_TRIGGER_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_OFFSET_TRIGGER_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_INCREMENT_TRIGGER_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_SUBJECT_TRIGGER_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_COORDINATOR_TRIGGER_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_NO_UPDATE_TRIGGER_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_NO_DELETE_TRIGGER_SQL,
  CREATE_CONTROL_JOURNAL_ENTRIES_NO_REPLACE_TRIGGER_SQL,
] as const);

export const HOST_STATE_MIGRATIONS: readonly HostStateMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    id: "001-initial-host-state",
    statements: VERSION_ONE_STATEMENTS,
  }),
  Object.freeze({
    version: 2,
    id: "002-protected-artifact-immutability",
    statements: VERSION_TWO_STATEMENTS,
  }),
  Object.freeze({
    version: 3,
    id: "003-durable-host-records",
    statements: VERSION_THREE_STATEMENTS,
  }),
]);

/**
 * Exact sqlite_schema rows produced by HOST_STATE_MIGRATIONS.
 *
 * The secure opener compares all four fields for every sqlite_schema row. The
 * explicit unique index avoids an implicit sqlite_autoindex, so no unlisted
 * SQLite-owned object is accepted.
 */
const VERSION_ONE_SQLITE_SCHEMA_MANIFEST: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  Object.freeze({
    type: "table",
    name: "host_state_metadata",
    tableName: "host_state_metadata",
    sql: CREATE_METADATA_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "host_state_migrations",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_SQL,
  }),
  Object.freeze({
    type: "index",
    name: "host_state_migrations_id_unique",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_ID_INDEX_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "host_state_migrations_no_update",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_NO_UPDATE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "host_state_migrations_no_delete",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_NO_DELETE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "table",
    name: "protected_artifacts",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_SQL,
  }),
]);

const VERSION_TWO_SQLITE_SCHEMA_MANIFEST: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  ...VERSION_ONE_SQLITE_SCHEMA_MANIFEST,
  Object.freeze({
    type: "trigger",
    name: "host_state_migrations_no_replace",
    tableName: "host_state_migrations",
    sql: CREATE_MIGRATIONS_NO_REPLACE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "protected_artifacts_no_update",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_NO_UPDATE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "protected_artifacts_no_delete",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_NO_DELETE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger",
    name: "protected_artifacts_no_replace",
    tableName: "protected_artifacts",
    sql: CREATE_PROTECTED_ARTIFACTS_NO_REPLACE_TRIGGER_SQL,
  }),
]);

function schemaEntry(
  type: HostStateSqliteSchemaEntry["type"],
  name: string,
  tableName: string,
  sql: string,
): HostStateSqliteSchemaEntry {
  return Object.freeze({ type, name, tableName, sql });
}

const VERSION_THREE_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  schemaEntry(
    "index",
    "host_state_metadata_machine_identity_unique",
    "host_state_metadata",
    CREATE_METADATA_MACHINE_IDENTITY_INDEX_SQL,
  ),
  schemaEntry(
    "table",
    "collaboration_servers",
    "collaboration_servers",
    CREATE_COLLABORATION_SERVERS_SQL,
  ),
  schemaEntry(
    "table",
    "host_state_profiles",
    "host_state_profiles",
    CREATE_HOST_STATE_PROFILES_SQL,
  ),
  schemaEntry("table", "projects", "projects", CREATE_PROJECTS_SQL),
  schemaEntry(
    "table",
    "project_target_selector_mappings",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_SQL,
  ),
  schemaEntry("table", "logical_chats", "logical_chats", CREATE_LOGICAL_CHATS_SQL),
  schemaEntry("table", "native_bindings", "native_bindings", CREATE_NATIVE_BINDINGS_SQL),
  schemaEntry(
    "table",
    "native_registration_intents",
    "native_registration_intents",
    CREATE_NATIVE_REGISTRATION_INTENTS_SQL,
  ),
  schemaEntry(
    "table",
    "inward_collaboration_edges",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_SQL,
  ),
  schemaEntry("table", "coordinator_leases", "coordinator_leases", CREATE_COORDINATOR_LEASES_SQL),
  schemaEntry(
    "table",
    "control_journal_entries",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_SQL,
  ),
  schemaEntry(
    "index",
    "collaboration_servers_scope_unique",
    "collaboration_servers",
    CREATE_COLLABORATION_SERVERS_SCOPE_INDEX_SQL,
  ),
  schemaEntry("index", "projects_scope_unique", "projects", CREATE_PROJECTS_SCOPE_INDEX_SQL),
  schemaEntry(
    "index",
    "projects_allocation_intent_unique",
    "projects",
    CREATE_PROJECTS_ALLOCATION_INTENT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "projects_first_bootstrap_unique",
    "projects",
    CREATE_PROJECTS_FIRST_BOOTSTRAP_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "project_target_selector_mappings_scope_unique",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "project_target_selector_mappings_initial_unique",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_INITIAL_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "project_target_selector_mappings_generation_unique",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_GENERATION_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "project_target_selector_mappings_current_unique",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_CURRENT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "logical_chats_scope_unique",
    "logical_chats",
    CREATE_LOGICAL_CHATS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "logical_chats_project_scope_unique",
    "logical_chats",
    CREATE_LOGICAL_CHATS_PROJECT_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_bindings_scope_unique",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_bindings_server_id_unique",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_SERVER_ID_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_bindings_active_chat_unique",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_ACTIVE_CHAT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_registration_intents_scope_unique",
    "native_registration_intents",
    CREATE_NATIVE_REGISTRATION_INTENTS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_registration_intents_binding_unique",
    "native_registration_intents",
    CREATE_NATIVE_REGISTRATION_INTENTS_BINDING_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "inward_collaboration_edges_scope_unique",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "inward_collaboration_edges_target_scope_unique",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_TARGET_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "inward_collaboration_edges_active_chat_unique",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_ACTIVE_CHAT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "inward_collaboration_edges_active_native_binding_unique",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_ACTIVE_NATIVE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "coordinator_leases_scope_unique",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "coordinator_leases_server_epoch_unique",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_SERVER_EPOCH_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "control_journal_entries_correlation_unique",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_CORRELATION_INDEX_SQL,
  ),
  schemaEntry(
    "trigger",
    "collaboration_servers_identity_immutable",
    "collaboration_servers",
    CREATE_COLLABORATION_SERVERS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "collaboration_servers_state_monotonic",
    "collaboration_servers",
    CREATE_COLLABORATION_SERVERS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "collaboration_servers_coordinator_transition",
    "collaboration_servers",
    CREATE_COLLABORATION_SERVERS_COORDINATOR_TRANSITION_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "collaboration_servers_no_delete",
    "collaboration_servers",
    CREATE_COLLABORATION_SERVERS_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "collaboration_servers_no_replace",
    "collaboration_servers",
    CREATE_COLLABORATION_SERVERS_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "host_state_profiles_no_update",
    "host_state_profiles",
    CREATE_HOST_STATE_PROFILES_NO_UPDATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "host_state_profiles_no_delete",
    "host_state_profiles",
    CREATE_HOST_STATE_PROFILES_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "host_state_profiles_no_replace",
    "host_state_profiles",
    CREATE_HOST_STATE_PROFILES_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "projects_identity_immutable",
    "projects",
    CREATE_PROJECTS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "projects_require_current_initial_mapping",
    "projects",
    CREATE_PROJECTS_INITIAL_MAPPING_TRIGGER_SQL,
  ),
  schemaEntry("trigger", "projects_state_monotonic", "projects", CREATE_PROJECTS_STATE_TRIGGER_SQL),
  schemaEntry("trigger", "projects_no_delete", "projects", CREATE_PROJECTS_NO_DELETE_TRIGGER_SQL),
  schemaEntry("trigger", "projects_no_replace", "projects", CREATE_PROJECTS_NO_REPLACE_TRIGGER_SQL),
  schemaEntry(
    "trigger",
    "project_target_selector_mappings_identity_immutable",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "project_target_selector_mappings_state_monotonic",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "project_target_selector_mappings_require_predecessor",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_PREDECESSOR_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "project_target_selector_mappings_no_delete",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "project_target_selector_mappings_no_replace",
    "project_target_selector_mappings",
    CREATE_PROJECT_TARGET_SELECTOR_MAPPINGS_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "logical_chats_identity_immutable",
    "logical_chats",
    CREATE_LOGICAL_CHATS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "logical_chats_require_current_mapping",
    "logical_chats",
    CREATE_LOGICAL_CHATS_MAPPING_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "logical_chats_state_monotonic",
    "logical_chats",
    CREATE_LOGICAL_CHATS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "logical_chats_no_delete",
    "logical_chats",
    CREATE_LOGICAL_CHATS_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "logical_chats_no_replace",
    "logical_chats",
    CREATE_LOGICAL_CHATS_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_bindings_identity_immutable",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_bindings_semantic_identity_immutable",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_SEMANTIC_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_bindings_require_current_terminal_mapping",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_MAPPING_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_bindings_state_monotonic",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_bindings_no_delete",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_bindings_no_replace",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_registration_intents_no_update",
    "native_registration_intents",
    CREATE_NATIVE_REGISTRATION_INTENTS_NO_UPDATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_registration_intents_no_delete",
    "native_registration_intents",
    CREATE_NATIVE_REGISTRATION_INTENTS_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_registration_intents_no_replace",
    "native_registration_intents",
    CREATE_NATIVE_REGISTRATION_INTENTS_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "inward_collaboration_edges_identity_immutable",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "inward_collaboration_edges_state_monotonic",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "inward_collaboration_edges_no_delete",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "inward_collaboration_edges_no_replace",
    "inward_collaboration_edges",
    CREATE_INWARD_COLLABORATION_EDGES_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "coordinator_leases_identity_immutable",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "coordinator_leases_heartbeat_monotonic",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_HEARTBEAT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "coordinator_leases_state_monotonic",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "coordinator_leases_no_delete",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "coordinator_leases_no_replace",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_NO_REPLACE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "control_journal_entries_require_next_offset",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_OFFSET_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "control_journal_entries_increment_offset",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_INCREMENT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "control_journal_entries_require_subject",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_SUBJECT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "control_journal_entries_require_current_coordinator",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_COORDINATOR_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "control_journal_entries_no_update",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_NO_UPDATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "control_journal_entries_no_delete",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_NO_DELETE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "control_journal_entries_no_replace",
    "control_journal_entries",
    CREATE_CONTROL_JOURNAL_ENTRIES_NO_REPLACE_TRIGGER_SQL,
  ),
]);

const VERSION_THREE_SQLITE_SCHEMA_MANIFEST: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  ...VERSION_TWO_SQLITE_SCHEMA_MANIFEST,
  ...VERSION_THREE_SQLITE_SCHEMA_ENTRIES,
]);

export const HOST_STATE_SQLITE_SCHEMA_MANIFESTS: readonly (readonly HostStateSqliteSchemaEntry[])[] =
  Object.freeze([
    VERSION_ONE_SQLITE_SCHEMA_MANIFEST,
    VERSION_TWO_SQLITE_SCHEMA_MANIFEST,
    VERSION_THREE_SQLITE_SCHEMA_MANIFEST,
  ]);

export function expectedHostStateSqliteSchemaManifest(
  schemaVersion: number,
): readonly HostStateSqliteSchemaEntry[] {
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > HOST_STATE_SQLITE_SCHEMA_MANIFESTS.length
  ) {
    migrationError(`schema version ${String(schemaVersion)} is not supported`);
  }
  const manifest = HOST_STATE_SQLITE_SCHEMA_MANIFESTS[schemaVersion - 1];
  if (manifest === undefined) migrationError(`schema version ${schemaVersion} has no manifest`);
  return manifest;
}

export const HOST_STATE_SQLITE_SCHEMA_MANIFEST =
  expectedHostStateSqliteSchemaManifest(HOST_STATE_SCHEMA_VERSION);

function migrationError(requirement: string): never {
  throw new Error(`host state migration registry rejected: ${requirement}`);
}

export function assertHostStateMigrationRegistry(migrations: readonly HostStateMigration[]): void {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    migrationError("must contain at least one migration");
  }

  const ids = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (
      typeof migration !== "object" ||
      migration === null ||
      !Number.isSafeInteger(migration.version) ||
      migration.version !== expectedVersion
    ) {
      migrationError(`version ${expectedVersion} must be present exactly once and in order`);
    }
    if (typeof migration.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(migration.id)) {
      migrationError(`version ${expectedVersion} has an invalid migration id`);
    }
    if (ids.has(migration.id)) {
      migrationError(`migration id ${migration.id} is duplicated`);
    }
    ids.add(migration.id);

    if (!Array.isArray(migration.statements) || migration.statements.length === 0) {
      migrationError(`version ${expectedVersion} must contain at least one SQL statement`);
    }
    for (const statement of migration.statements) {
      if (typeof statement !== "string" || statement.length === 0 || statement.includes("\0")) {
        migrationError(`version ${expectedVersion} contains invalid SQL`);
      }
    }
  }
}

function digestWriter(writer: CanonicalWriter): Buffer {
  return createHash("sha256").update(writer.finish()).digest();
}

/**
 * Compute the digest after each migration.
 *
 * Each step commits the domain, the prior raw digest, version, migration id,
 * statement count, and the exact UTF-8 bytes of every SQL statement through
 * clawsec's selected canonical field writer.
 */
export function computeHostStateMigrationDigests(
  migrations: readonly HostStateMigration[],
): readonly string[] {
  assertHostStateMigrationRegistry(migrations);
  const genesis = new CanonicalWriter();
  genesis.str(HOST_STATE_MIGRATION_DIGEST_DOMAIN);
  genesis.str("genesis");
  let previous = digestWriter(genesis);
  const digests: string[] = [];

  for (const migration of migrations) {
    const writer = new CanonicalWriter();
    writer.str(HOST_STATE_MIGRATION_DIGEST_DOMAIN);
    writer.str("migration");
    writer.bytes(previous);
    writer.uint(migration.version);
    writer.str(migration.id);
    writer.uint(migration.statements.length);
    for (const statement of migration.statements) writer.str(statement);
    previous = digestWriter(writer);
    digests.push(previous.toString("base64url"));
  }

  return Object.freeze(digests);
}

if (HOST_STATE_MIGRATIONS.length !== HOST_STATE_SCHEMA_VERSION) {
  migrationError("declared schema version must equal the latest contiguous migration version");
}

export const HOST_STATE_MIGRATION_DIGESTS = computeHostStateMigrationDigests(HOST_STATE_MIGRATIONS);

export function expectedHostStateMigrationDigest(schemaVersion: number): string {
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > HOST_STATE_MIGRATION_DIGESTS.length
  ) {
    migrationError(`schema version ${String(schemaVersion)} is not supported`);
  }
  const digest = HOST_STATE_MIGRATION_DIGESTS[schemaVersion - 1];
  if (digest === undefined) migrationError(`schema version ${schemaVersion} has no digest`);
  return digest;
}

function canonicalDigestBytes(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) return null;
  return bytes;
}

export function isExpectedHostStateMigrationDigest(
  value: unknown,
  schemaVersion: number,
): value is string {
  const actual = canonicalDigestBytes(value);
  if (actual === null) return false;

  let expected: Buffer | null = null;
  try {
    expected = canonicalDigestBytes(expectedHostStateMigrationDigest(schemaVersion));
  } catch {
    return false;
  }
  return expected !== null && timingSafeEqual(actual, expected);
}

export const HOST_STATE_SCHEMA_MANIFEST = Object.freeze({
  applicationId: HOST_STATE_APPLICATION_ID,
  schemaVersion: HOST_STATE_SCHEMA_VERSION,
  migrationDigest: expectedHostStateMigrationDigest(HOST_STATE_SCHEMA_VERSION),
  sqliteSchema: HOST_STATE_SQLITE_SCHEMA_MANIFEST,
});
