import { createHash, timingSafeEqual } from "node:crypto";
import { CanonicalWriter } from "@remote-claw/clawsec";

/** SQLite application_id for the ASCII tag `RCLW`. */
export const HOST_STATE_APPLICATION_ID = 0x52434c57;

export const HOST_STATE_SCHEMA_VERSION = 4;

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

// Schema v3 retains the future nested-server columns but deliberately narrows persisted targets to
// terminal_native. N1 must replace that narrowing in a later migration before using the dormant arm.
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

// Schema v3 likewise retains the future remote-server columns while permitting only native-harness
// edges. N1 must migrate and prove that currently unreachable arm before it may persist.
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

// Every immutable v3 journal kind is a server-control transition. The exhaustive SQL list below is
// part of the locked v3 migration; a future chat-scoped entry kind requires its own schema migration.
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

/*
 * Schema v4 is the runtime-owner durability boundary. It deliberately keeps
 * the v3 server/chat tables byte-for-byte intact: in particular, the existing
 * native_bindings current-incarnation pointer is enforced by a new trigger
 * instead of rebuilding that table during migration.
 */
const CREATE_RUNTIME_OWNER_STATE_SQL = `CREATE TABLE runtime_owner_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  current_runtime_owner_service_epoch INTEGER NOT NULL CHECK (
    current_runtime_owner_service_epoch BETWEEN 0 AND 9007199254740991
  ),
  current_runtime_owner_service_lease_id TEXT CHECK (
    current_runtime_owner_service_lease_id IS NULL OR (
      length(current_runtime_owner_service_lease_id) BETWEEN 1 AND 128
      AND current_runtime_owner_service_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  next_journal_offset INTEGER NOT NULL CHECK (
    next_journal_offset BETWEEN 0 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (
    current_runtime_owner_service_lease_id IS NULL
    OR current_runtime_owner_service_epoch > 0
  ),
  FOREIGN KEY (machine_identity_id)
    REFERENCES host_state_metadata (machine_identity_id),
  FOREIGN KEY (
    current_runtime_owner_service_lease_id,
    machine_identity_id,
    current_runtime_owner_service_epoch
  ) REFERENCES runtime_owner_service_leases (
    runtime_owner_service_lease_id,
    machine_identity_id,
    runtime_owner_service_epoch
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_SQL = `CREATE TABLE runtime_owner_service_leases (
  runtime_owner_service_lease_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(runtime_owner_service_lease_id) BETWEEN 1 AND 128
    AND runtime_owner_service_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  runtime_owner_service_epoch INTEGER NOT NULL CHECK (
    runtime_owner_service_epoch BETWEEN 1 AND 9007199254740991
  ),
  owner_instance_id TEXT NOT NULL CHECK (
    length(owner_instance_id) BETWEEN 1 AND 128
    AND owner_instance_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  owner_process_start_identity_schema_id TEXT NOT NULL CHECK (
    length(owner_process_start_identity_schema_id) BETWEEN 1 AND 1024
  ),
  owner_process_start_identity_ref TEXT NOT NULL CHECK (
    length(owner_process_start_identity_ref) BETWEEN 1 AND 128
    AND owner_process_start_identity_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  owner_process_start_identity_digest TEXT NOT NULL CHECK (
    length(owner_process_start_identity_digest) = 43
    AND owner_process_start_identity_digest NOT GLOB '*[^A-Za-z0-9_-]*'
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
  state TEXT NOT NULL CHECK (state IN ('current', 'expired', 'released', 'superseded')),
  CHECK (acquired_at_ms < initial_heartbeat_deadline_ms),
  CHECK (initial_heartbeat_deadline_ms <= heartbeat_deadline_ms),
  CHECK ((state = 'released') = (released_at_ms IS NOT NULL)),
  CHECK (
    released_at_ms IS NULL OR (
      acquired_at_ms <= released_at_ms
      AND released_at_ms < heartbeat_deadline_ms
    )
  ),
  FOREIGN KEY (machine_identity_id)
    REFERENCES host_state_metadata (machine_identity_id)
) STRICT, WITHOUT ROWID`;

const CREATE_RUNTIME_OWNER_JOURNAL_ENTRIES_SQL = `CREATE TABLE runtime_owner_journal_entries (
  journal_offset INTEGER PRIMARY KEY NOT NULL CHECK (
    journal_offset BETWEEN 0 AND 9007199254740991
  ),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN (
    'service_lease_acquired',
    'service_lease_released',
    'runtime_registered',
    'runtime_reassigned',
    'runtime_replaced',
    'runtime_terminated',
    'runtime_key_rotated',
    'local_conversation_transitioned',
    'binding_incarnation_prepared',
    'attachment_lease_acquired',
    'attachment_detached'
  )),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'service_lease',
    'native_runtime',
    'runtime_owner_identity_key',
    'local_native_transition',
    'native_binding_incarnation',
    'native_transport_lease'
  )),
  subject_id TEXT NOT NULL CHECK (
    length(subject_id) BETWEEN 1 AND 128
    AND subject_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  operation_id TEXT NOT NULL CHECK (
    length(operation_id) BETWEEN 1 AND 128
    AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  operation_schema_id TEXT NOT NULL CHECK (length(operation_schema_id) BETWEEN 1 AND 1024),
  operation_digest TEXT NOT NULL CHECK (
    length(operation_digest) = 43
    AND operation_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_owner_service_lease_id TEXT NOT NULL CHECK (
    length(runtime_owner_service_lease_id) BETWEEN 1 AND 128
    AND runtime_owner_service_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_service_epoch INTEGER NOT NULL CHECK (
    runtime_owner_service_epoch BETWEEN 1 AND 9007199254740991
  ),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    )
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_RUNTIMES_SQL = `CREATE TABLE native_runtimes (
  runtime_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  descriptor_product TEXT NOT NULL CHECK (
    descriptor_product IN ('claude-code', 'codex', 'opencode')
  ),
  descriptor_access TEXT NOT NULL CHECK (
    descriptor_access IN ('native-rc', 'app-server', 'server', 'tmux')
  ),
  warden_launch_nonce TEXT NOT NULL CHECK (
    length(warden_launch_nonce) = 43
    AND warden_launch_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  initial_start_identity_schema_id TEXT NOT NULL CHECK (
    length(initial_start_identity_schema_id) BETWEEN 1 AND 1024
  ),
  initial_start_identity_ref TEXT NOT NULL CHECK (
    length(initial_start_identity_ref) BETWEEN 1 AND 128
    AND initial_start_identity_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  initial_start_identity_digest TEXT NOT NULL CHECK (
    length(initial_start_identity_digest) = 43
    AND initial_start_identity_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  current_native_incarnation INTEGER CHECK (
    current_native_incarnation IS NULL OR current_native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  current_runtime_owner_assignment_id TEXT CHECK (
    current_runtime_owner_assignment_id IS NULL OR (
      length(current_runtime_owner_assignment_id) BETWEEN 1 AND 128
      AND current_runtime_owner_assignment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  next_local_transition_seq INTEGER NOT NULL CHECK (
    next_local_transition_seq BETWEEN 1 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'closed')),
  CHECK (
    (descriptor_product = 'claude-code' AND descriptor_access IN ('native-rc', 'tmux'))
    OR (descriptor_product = 'codex' AND descriptor_access = 'app-server')
    OR (descriptor_product = 'opencode' AND descriptor_access = 'server')
  ),
  CHECK ((current_native_incarnation IS NULL) = (current_runtime_owner_assignment_id IS NULL)),
  CHECK ((state = 'closed') = (closed_at_ms IS NOT NULL)),
  CHECK (state <> 'current' OR current_native_incarnation IS NOT NULL),
  CHECK (state <> 'closed' OR current_native_incarnation IS NULL),
  CHECK (closed_at_ms IS NULL OR closed_at_ms >= created_at_ms),
  FOREIGN KEY (runtime_id, current_native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    current_runtime_owner_assignment_id,
    runtime_id,
    current_native_incarnation
  ) REFERENCES runtime_owner_assignments (
    runtime_owner_assignment_id,
    runtime_id,
    native_incarnation
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_RUNTIME_INCARNATIONS_SQL = `CREATE TABLE native_runtime_incarnations (
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  descriptor_product TEXT NOT NULL CHECK (
    descriptor_product IN ('claude-code', 'codex', 'opencode')
  ),
  descriptor_access TEXT NOT NULL CHECK (
    descriptor_access IN ('native-rc', 'app-server', 'server', 'tmux')
  ),
  runtime_owner_service_lease_id TEXT NOT NULL CHECK (
    length(runtime_owner_service_lease_id) BETWEEN 1 AND 128
    AND runtime_owner_service_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_service_epoch INTEGER NOT NULL CHECK (
    runtime_owner_service_epoch BETWEEN 1 AND 9007199254740991
  ),
  start_identity_schema_id TEXT NOT NULL CHECK (length(start_identity_schema_id) BETWEEN 1 AND 1024),
  start_identity_ref TEXT NOT NULL CHECK (
    length(start_identity_ref) BETWEEN 1 AND 128
    AND start_identity_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  start_identity_digest TEXT NOT NULL CHECK (
    length(start_identity_digest) = 43
    AND start_identity_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms BETWEEN 0 AND 9007199254740991),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('starting', 'current', 'draining', 'closed')),
  PRIMARY KEY (runtime_id, native_incarnation),
  CHECK (
    (descriptor_product = 'claude-code' AND descriptor_access IN ('native-rc', 'tmux'))
    OR (descriptor_product = 'codex' AND descriptor_access = 'app-server')
    OR (descriptor_product = 'opencode' AND descriptor_access = 'server')
  ),
  CHECK ((state = 'closed') = (closed_at_ms IS NOT NULL)),
  CHECK (closed_at_ms IS NULL OR closed_at_ms >= started_at_ms),
  FOREIGN KEY (runtime_id, descriptor_product, descriptor_access)
    REFERENCES native_runtimes (runtime_id, descriptor_product, descriptor_access),
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    )
) STRICT, WITHOUT ROWID`;

const CREATE_RUNTIME_OWNER_ASSIGNMENTS_SQL = `CREATE TABLE runtime_owner_assignments (
  runtime_owner_assignment_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(runtime_owner_assignment_id) BETWEEN 1 AND 128
    AND runtime_owner_assignment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  assignment_generation INTEGER NOT NULL CHECK (
    assignment_generation BETWEEN 1 AND 9007199254740991
  ),
  runtime_owner_service_lease_id TEXT NOT NULL CHECK (
    length(runtime_owner_service_lease_id) BETWEEN 1 AND 128
    AND runtime_owner_service_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_service_epoch INTEGER NOT NULL CHECK (
    runtime_owner_service_epoch BETWEEN 1 AND 9007199254740991
  ),
  assigned_at_ms INTEGER NOT NULL CHECK (assigned_at_ms BETWEEN 0 AND 9007199254740991),
  assignment_evidence_schema_id TEXT NOT NULL CHECK (
    length(assignment_evidence_schema_id) BETWEEN 1 AND 1024
  ),
  assignment_evidence_ref TEXT NOT NULL CHECK (
    length(assignment_evidence_ref) BETWEEN 1 AND 128
    AND assignment_evidence_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  assignment_evidence_digest TEXT NOT NULL CHECK (
    length(assignment_evidence_digest) = 43
    AND assignment_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  supersedes_runtime_owner_assignment_id TEXT CHECK (
    supersedes_runtime_owner_assignment_id IS NULL OR (
      length(supersedes_runtime_owner_assignment_id) BETWEEN 1 AND 128
      AND supersedes_runtime_owner_assignment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  reason TEXT NOT NULL CHECK (reason IN ('creation', 'takeover')),
  CHECK (
    (
      assignment_generation = 1
      AND supersedes_runtime_owner_assignment_id IS NULL
      AND reason = 'creation'
    ) OR (
      assignment_generation > 1
      AND supersedes_runtime_owner_assignment_id IS NOT NULL
      AND supersedes_runtime_owner_assignment_id <> runtime_owner_assignment_id
      AND reason = 'takeover'
    )
  ),
  FOREIGN KEY (runtime_id, native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation),
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    ),
  FOREIGN KEY (
    supersedes_runtime_owner_assignment_id,
    runtime_id,
    native_incarnation
  ) REFERENCES runtime_owner_assignments (
    runtime_owner_assignment_id,
    runtime_id,
    native_incarnation
  )
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_RUNTIME_CONTAINMENTS_SQL = `CREATE TABLE native_runtime_containments (
  native_runtime_containment_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(native_runtime_containment_id) BETWEEN 1 AND 128
    AND native_runtime_containment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  predecessor_native_incarnation INTEGER NOT NULL CHECK (
    predecessor_native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  successor_native_incarnation INTEGER CHECK (
    successor_native_incarnation IS NULL
    OR successor_native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  kind TEXT NOT NULL CHECK (kind IN ('replacement', 'termination')),
  evidence_schema_id TEXT NOT NULL CHECK (
    length(evidence_schema_id) BETWEEN 1 AND 1024
  ),
  evidence_ref TEXT NOT NULL CHECK (
    length(evidence_ref) BETWEEN 1 AND 128
    AND evidence_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 43
    AND evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_owner_service_lease_id TEXT NOT NULL CHECK (
    length(runtime_owner_service_lease_id) BETWEEN 1 AND 128
    AND runtime_owner_service_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_service_epoch INTEGER NOT NULL CHECK (
    runtime_owner_service_epoch BETWEEN 1 AND 9007199254740991
  ),
  contained_at_ms INTEGER NOT NULL CHECK (contained_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (
    (kind = 'replacement'
      AND successor_native_incarnation = predecessor_native_incarnation + 1)
    OR (kind = 'termination' AND successor_native_incarnation IS NULL)
  ),
  FOREIGN KEY (runtime_id, predecessor_native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation),
  FOREIGN KEY (runtime_id, successor_native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    )
) STRICT, WITHOUT ROWID`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_SQL = `CREATE TABLE runtime_owner_identity_keys (
  runtime_owner_identity_key_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(runtime_owner_identity_key_id) BETWEEN 1 AND 128
    AND runtime_owner_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  key_generation INTEGER NOT NULL CHECK (key_generation BETWEEN 1 AND 9007199254740991),
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 43
    AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signing_key_protected_handle_id TEXT CHECK (
    signing_key_protected_handle_id IS NULL OR (
      length(signing_key_protected_handle_id) = 27
      AND substr(signing_key_protected_handle_id, 1, 5) = 'rcph_'
      AND signing_key_protected_handle_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  next_signer_sequence INTEGER NOT NULL CHECK (
    next_signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  local_trust_evidence_ref TEXT NOT NULL CHECK (
    length(local_trust_evidence_ref) BETWEEN 1 AND 128
    AND local_trust_evidence_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  local_trust_evidence_digest TEXT NOT NULL CHECK (
    length(local_trust_evidence_digest) = 43
    AND local_trust_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'retired', 'revoked')),
  CHECK ((state = 'current') = (signing_key_protected_handle_id IS NOT NULL)),
  FOREIGN KEY (runtime_id) REFERENCES native_runtimes (runtime_id),
  FOREIGN KEY (
    signing_key_protected_handle_id,
    runtime_id,
    runtime_owner_identity_key_id,
    key_generation
  ) REFERENCES runtime_owner_private_keys (
    protected_handle_id,
    runtime_id,
    runtime_owner_identity_key_id,
    key_generation
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_RUNTIME_OWNER_PRIVATE_KEYS_SQL = `CREATE TABLE runtime_owner_private_keys (
  protected_handle_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(protected_handle_id) = 27
    AND substr(protected_handle_id, 1, 5) = 'rcph_'
    AND protected_handle_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_owner_identity_key_id TEXT NOT NULL CHECK (
    length(runtime_owner_identity_key_id) BETWEEN 1 AND 128
    AND runtime_owner_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  key_generation INTEGER NOT NULL CHECK (key_generation BETWEEN 1 AND 9007199254740991),
  wrapping_schema_id TEXT NOT NULL CHECK (
    wrapping_schema_id = 'remote-claw/runtime-owner-key-wrap/aes-256-gcm/v1'
  ),
  wrap_nonce BLOB NOT NULL CHECK (length(wrap_nonce) = 12),
  wrapped_pkcs8 BLOB NOT NULL CHECK (length(wrapped_pkcs8) BETWEEN 1 AND 1024),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  pkcs8_digest TEXT NOT NULL CHECK (
    length(pkcs8_digest) = 43
    AND pkcs8_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  destroyed_at_ms INTEGER CHECK (
    destroyed_at_ms IS NULL OR destroyed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'destroyed')),
  CHECK ((state = 'destroyed') = (destroyed_at_ms IS NOT NULL)),
  CHECK (destroyed_at_ms IS NULL OR destroyed_at_ms >= created_at_ms),
  FOREIGN KEY (runtime_id, runtime_owner_identity_key_id, key_generation)
    REFERENCES runtime_owner_identity_keys (
      runtime_id,
      runtime_owner_identity_key_id,
      key_generation
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_SQL = `CREATE TABLE runtime_owner_signature_reservations (
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_owner_identity_key_id TEXT NOT NULL CHECK (
    length(runtime_owner_identity_key_id) BETWEEN 1 AND 128
    AND runtime_owner_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_key_generation INTEGER NOT NULL CHECK (
    runtime_owner_key_generation BETWEEN 1 AND 9007199254740991
  ),
  signer_sequence INTEGER NOT NULL CHECK (signer_sequence BETWEEN 0 AND 9007199254740991),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'native_root',
    'listener_registration_attestation',
    'runtime_isolation_attestation',
    'native_capability_snapshot',
    'native_tui_policy_snapshot',
    'opencode_native_store_attachment_attestation',
    'opencode_native_store_predecessor_stop_fence',
    'opencode_native_store_successor_exclusive_open'
  )),
  canonical_payload_schema_id TEXT,
  canonical_payload_ref TEXT CHECK (
    canonical_payload_ref IS NULL OR (
      length(canonical_payload_ref) BETWEEN 1 AND 128
      AND canonical_payload_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  canonical_payload_digest TEXT CHECK (
    canonical_payload_digest IS NULL OR (
      length(canonical_payload_digest) = 43
      AND canonical_payload_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  signed_record_digest TEXT CHECK (
    signed_record_digest IS NULL OR (
      length(signed_record_digest) = 43
      AND signed_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  signature TEXT CHECK (
    signature IS NULL OR (
      length(signature) = 86
      AND signature NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  signed_artifact_id TEXT CHECK (
    signed_artifact_id IS NULL OR (
      length(signed_artifact_id) BETWEEN 1 AND 128
      AND signed_artifact_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'bound', 'signed', 'aborted')),
  PRIMARY KEY (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence
  ),
  CHECK (
    (state IN ('reserved', 'aborted')
      AND canonical_payload_schema_id IS NULL
      AND canonical_payload_ref IS NULL
      AND canonical_payload_digest IS NULL
      AND signed_record_digest IS NULL
      AND signature IS NULL
      AND signed_artifact_id IS NULL)
    OR (state = 'bound'
      AND canonical_payload_schema_id IS NOT NULL
      AND canonical_payload_ref IS NOT NULL
      AND canonical_payload_digest IS NOT NULL
      AND signed_record_digest IS NULL
      AND signature IS NULL
      AND signed_artifact_id IS NULL)
    OR (state = 'signed'
      AND canonical_payload_schema_id IS NOT NULL
      AND canonical_payload_ref IS NOT NULL
      AND canonical_payload_digest IS NOT NULL
      AND signed_record_digest IS NOT NULL
      AND signature IS NOT NULL
      AND signed_artifact_id IS NOT NULL)
  ),
  CHECK (
    canonical_payload_schema_id IS NULL OR (
      (purpose = 'native_root'
        AND canonical_payload_schema_id = 'remote-claw/native-root-certificate/v1')
      OR (purpose = 'listener_registration_attestation'
        AND canonical_payload_schema_id = 'remote-claw/native-listener-registration-attestation/v1')
      OR (purpose = 'runtime_isolation_attestation'
        AND canonical_payload_schema_id = 'remote-claw/native-runtime-isolation-attestation/v1')
      OR (purpose = 'native_capability_snapshot'
        AND canonical_payload_schema_id = 'remote-claw/native-capability-snapshot-attestation/v1')
      OR (purpose = 'native_tui_policy_snapshot'
        AND canonical_payload_schema_id = 'remote-claw/native-tui-policy-snapshot-attestation/v1')
      OR (purpose = 'opencode_native_store_attachment_attestation'
        AND canonical_payload_schema_id = 'remote-claw/opencode-native-store-attachment-attestation/v1')
      OR (purpose = 'opencode_native_store_predecessor_stop_fence'
        AND canonical_payload_schema_id = 'remote-claw/opencode-native-store-predecessor-stop-fence/v1')
      OR (purpose = 'opencode_native_store_successor_exclusive_open'
        AND canonical_payload_schema_id = 'remote-claw/opencode-native-store-successor-exclusive-open/v1')
    )
  ),
  FOREIGN KEY (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation
  ) REFERENCES runtime_owner_identity_keys (
    runtime_id,
    runtime_owner_identity_key_id,
    key_generation
  )
) STRICT, WITHOUT ROWID`;

const CREATE_RUNTIME_OWNER_SIGNED_RECORD_ACCEPTANCES_SQL = `CREATE TABLE runtime_owner_signed_record_acceptances (
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_owner_identity_key_id TEXT NOT NULL CHECK (
    length(runtime_owner_identity_key_id) BETWEEN 1 AND 128
    AND runtime_owner_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_key_generation INTEGER NOT NULL CHECK (
    runtime_owner_key_generation BETWEEN 1 AND 9007199254740991
  ),
  signer_sequence INTEGER NOT NULL CHECK (signer_sequence BETWEEN 0 AND 9007199254740991),
  signed_record_digest TEXT NOT NULL CHECK (
    length(signed_record_digest) = 43
    AND signed_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence
  ),
  FOREIGN KEY (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence,
    signed_record_digest
  ) REFERENCES runtime_owner_signature_reservations (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence,
    signed_record_digest
  )
) STRICT, WITHOUT ROWID`;

const CREATE_LOCAL_NATIVE_CONVERSATIONS_SQL = `CREATE TABLE local_native_conversations (
  local_native_conversation_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(local_native_conversation_id) BETWEEN 1 AND 128
    AND local_native_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
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
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  semantic_conversation_id TEXT CHECK (
    semantic_conversation_id IS NULL OR (
      length(semantic_conversation_id) BETWEEN 1 AND 128
      AND semantic_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  parent_local_native_conversation_id TEXT CHECK (
    parent_local_native_conversation_id IS NULL OR (
      length(parent_local_native_conversation_id) BETWEEN 1 AND 128
      AND parent_local_native_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('unbound', 'open', 'closed')),
  CHECK (parent_local_native_conversation_id IS NULL
    OR parent_local_native_conversation_id <> local_native_conversation_id),
  CHECK (
    (descriptor_product = 'claude-code' AND descriptor_access IN ('native-rc', 'tmux'))
    OR (descriptor_product = 'codex' AND descriptor_access = 'app-server')
    OR (descriptor_product = 'opencode' AND descriptor_access = 'server')
  ),
  FOREIGN KEY (project_id) REFERENCES projects (project_id),
  FOREIGN KEY (runtime_id, native_incarnation, descriptor_product, descriptor_access)
    REFERENCES native_runtime_incarnations (
      runtime_id,
      native_incarnation,
      descriptor_product,
      descriptor_access
    ),
  FOREIGN KEY (
    parent_local_native_conversation_id,
    runtime_id,
    native_incarnation
  ) REFERENCES local_native_conversations (
    local_native_conversation_id,
    runtime_id,
    native_incarnation
  )
) STRICT, WITHOUT ROWID`;

const CREATE_LOCAL_NATIVE_CONVERSATION_TRANSITIONS_SQL = `CREATE TABLE local_native_conversation_transitions (
  local_transition_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(local_transition_id) BETWEEN 1 AND 128
    AND local_transition_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  local_transition_seq INTEGER NOT NULL CHECK (
    local_transition_seq BETWEEN 1 AND 9007199254740991
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('discover', 'new', 'clear', 'fork', 'switch', 'archive', 'unarchive')
  ),
  source_local_native_conversation_id TEXT CHECK (
    source_local_native_conversation_id IS NULL OR (
      length(source_local_native_conversation_id) BETWEEN 1 AND 128
      AND source_local_native_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  target_local_native_conversation_id TEXT NOT NULL CHECK (
    length(target_local_native_conversation_id) BETWEEN 1 AND 128
    AND target_local_native_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  observed_semantic_conversation_id TEXT CHECK (
    observed_semantic_conversation_id IS NULL OR (
      length(observed_semantic_conversation_id) BETWEEN 1 AND 128
      AND observed_semantic_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  native_evidence_ref TEXT NOT NULL CHECK (
    length(native_evidence_ref) BETWEEN 1 AND 128
    AND native_evidence_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  native_evidence_schema_id TEXT NOT NULL CHECK (
    length(native_evidence_schema_id) BETWEEN 1 AND 1024
  ),
  native_evidence_digest TEXT NOT NULL CHECK (
    length(native_evidence_digest) = 43
    AND native_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (
    (kind IN ('discover', 'new') AND source_local_native_conversation_id IS NULL)
    OR (kind IN ('clear', 'fork', 'switch')
      AND source_local_native_conversation_id IS NOT NULL
      AND source_local_native_conversation_id <> target_local_native_conversation_id)
    OR (kind IN ('archive', 'unarchive')
      AND source_local_native_conversation_id = target_local_native_conversation_id)
  ),
  FOREIGN KEY (runtime_id, native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation),
  FOREIGN KEY (
    source_local_native_conversation_id,
    runtime_id,
    native_incarnation
  ) REFERENCES local_native_conversations (
    local_native_conversation_id,
    runtime_id,
    native_incarnation
  ),
  FOREIGN KEY (
    target_local_native_conversation_id,
    runtime_id,
    native_incarnation
  ) REFERENCES local_native_conversations (
    local_native_conversation_id,
    runtime_id,
    native_incarnation
  )
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_BINDING_INCARNATIONS_SQL = `CREATE TABLE native_binding_incarnations (
  native_binding_incarnation_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(native_binding_incarnation_id) BETWEEN 1 AND 128
    AND native_binding_incarnation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
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
  native_binding_id TEXT NOT NULL CHECK (
    length(native_binding_id) = 27
    AND substr(native_binding_id, 1, 5) = 'rcnb_'
    AND native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  semantic_conversation_id TEXT NOT NULL CHECK (
    length(semantic_conversation_id) BETWEEN 1 AND 128
    AND semantic_conversation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'superseded', 'closed')),
  CHECK ((state = 'closed') = (closed_at_ms IS NOT NULL)),
  CHECK (closed_at_ms IS NULL OR closed_at_ms >= created_at_ms),
  FOREIGN KEY (collaboration_server_id, logical_chat_id, native_binding_id)
    REFERENCES native_bindings (
      collaboration_server_id,
      logical_chat_id,
      native_binding_id
    ),
  FOREIGN KEY (runtime_id, native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation)
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_SQL = `CREATE TABLE native_transport_attachments (
  attachment_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(attachment_id) BETWEEN 1 AND 128
    AND attachment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  native_binding_id TEXT NOT NULL CHECK (
    length(native_binding_id) = 27
    AND substr(native_binding_id, 1, 5) = 'rcnb_'
    AND native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('claude-inner-rc', 'app-server', 'server', 'tmux')),
  transport_id TEXT NOT NULL CHECK (
    length(transport_id) BETWEEN 1 AND 128
    AND transport_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  current_attachment_lease_id TEXT CHECK (
    current_attachment_lease_id IS NULL OR (
      length(current_attachment_lease_id) BETWEEN 1 AND 128
      AND current_attachment_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  resource_ownership TEXT NOT NULL CHECK (
    resource_ownership IN ('dedicated_runtime', 'shared_runtime')
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'superseded', 'closed')),
  CHECK (state = 'current' OR current_attachment_lease_id IS NULL),
  CHECK ((state = 'closed') = (closed_at_ms IS NOT NULL)),
  CHECK (closed_at_ms IS NULL OR closed_at_ms >= created_at_ms),
  FOREIGN KEY (native_binding_id) REFERENCES native_bindings (native_binding_id),
  FOREIGN KEY (current_attachment_lease_id, attachment_id)
    REFERENCES native_transport_leases (attachment_lease_id, attachment_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_TRANSPORT_LEASES_SQL = `CREATE TABLE native_transport_leases (
  attachment_lease_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(attachment_lease_id) BETWEEN 1 AND 128
    AND attachment_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  attachment_id TEXT NOT NULL CHECK (
    length(attachment_id) BETWEEN 1 AND 128
    AND attachment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  native_binding_incarnation_id TEXT NOT NULL CHECK (
    length(native_binding_incarnation_id) BETWEEN 1 AND 128
    AND native_binding_incarnation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  runtime_owner_service_lease_id TEXT NOT NULL CHECK (
    length(runtime_owner_service_lease_id) BETWEEN 1 AND 128
    AND runtime_owner_service_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_service_epoch INTEGER NOT NULL CHECK (
    runtime_owner_service_epoch BETWEEN 1 AND 9007199254740991
  ),
  coordinator_lease_id TEXT NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (coordinator_epoch BETWEEN 1 AND 9007199254740991),
  transport_epoch INTEGER NOT NULL CHECK (transport_epoch BETWEEN 1 AND 9007199254740991),
  current_capability_snapshot_id TEXT CHECK (
    current_capability_snapshot_id IS NULL OR (
      length(current_capability_snapshot_id) BETWEEN 1 AND 128
      AND current_capability_snapshot_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  current_native_client_ingress_lease_id TEXT CHECK (
    current_native_client_ingress_lease_id IS NULL OR (
      length(current_native_client_ingress_lease_id) BETWEEN 1 AND 128
      AND current_native_client_ingress_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms BETWEEN 0 AND 9007199254740991),
  released_at_ms INTEGER CHECK (
    released_at_ms IS NULL OR released_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'superseded', 'closed')),
  CHECK ((state = 'current') = (released_at_ms IS NULL)),
  CHECK (released_at_ms IS NULL OR released_at_ms >= acquired_at_ms),
  FOREIGN KEY (attachment_id) REFERENCES native_transport_attachments (attachment_id),
  FOREIGN KEY (native_binding_incarnation_id, runtime_id, native_incarnation)
    REFERENCES native_binding_incarnations (
      native_binding_incarnation_id,
      runtime_id,
      native_incarnation
    ),
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    ),
  FOREIGN KEY (coordinator_lease_id, coordinator_epoch)
    REFERENCES coordinator_leases (coordinator_lease_id, coordinator_epoch)
) STRICT, WITHOUT ROWID`;

const CREATE_BINDING_LIFECYCLE_GATES_SQL = `CREATE TABLE binding_lifecycle_gates (
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
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  native_binding_incarnation_id TEXT NOT NULL CHECK (
    length(native_binding_incarnation_id) BETWEEN 1 AND 128
    AND native_binding_incarnation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  attachment_id TEXT NOT NULL CHECK (
    length(attachment_id) BETWEEN 1 AND 128
    AND attachment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  current_attachment_lease_id TEXT CHECK (
    current_attachment_lease_id IS NULL OR (
      length(current_attachment_lease_id) BETWEEN 1 AND 128
      AND current_attachment_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  phase TEXT NOT NULL CHECK (phase IN ('starting', 'recovering', 'ready', 'draining', 'closed')),
  disconnect_policy TEXT NOT NULL CHECK (
    disconnect_policy IN ('detach', 'terminate_when_idle')
  ),
  gate_generation INTEGER NOT NULL CHECK (gate_generation BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (phase <> 'ready' OR current_attachment_lease_id IS NOT NULL),
  CHECK (phase <> 'closed' OR current_attachment_lease_id IS NULL),
  FOREIGN KEY (collaboration_server_id, logical_chat_id, native_binding_id)
    REFERENCES native_bindings (
      collaboration_server_id,
      logical_chat_id,
      native_binding_id
    ),
  FOREIGN KEY (
    native_binding_incarnation_id,
    collaboration_server_id,
    logical_chat_id,
    native_binding_id,
    runtime_id,
    native_incarnation
  ) REFERENCES native_binding_incarnations (
    native_binding_incarnation_id,
    collaboration_server_id,
    logical_chat_id,
    native_binding_id,
    runtime_id,
    native_incarnation
  ),
  FOREIGN KEY (attachment_id, native_binding_id)
    REFERENCES native_transport_attachments (attachment_id, native_binding_id),
  FOREIGN KEY (
    current_attachment_lease_id,
    attachment_id,
    native_binding_incarnation_id,
    runtime_id,
    native_incarnation
  ) REFERENCES native_transport_leases (
    attachment_lease_id,
    attachment_id,
    native_binding_incarnation_id,
    runtime_id,
    native_incarnation
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_service_leases_scope_unique
ON runtime_owner_service_leases (
  runtime_owner_service_lease_id,
  machine_identity_id,
  runtime_owner_service_epoch
)`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_ID_EPOCH_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_service_leases_id_epoch_unique
ON runtime_owner_service_leases (
  runtime_owner_service_lease_id,
  runtime_owner_service_epoch
)`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_MACHINE_EPOCH_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_service_leases_machine_epoch_unique
ON runtime_owner_service_leases (machine_identity_id, runtime_owner_service_epoch)`;

const CREATE_RUNTIME_OWNER_JOURNAL_OPERATION_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_journal_operation_unique
ON runtime_owner_journal_entries (operation_id)`;

const CREATE_NATIVE_RUNTIMES_DESCRIPTOR_INDEX_SQL = `CREATE UNIQUE INDEX native_runtimes_descriptor_scope_unique
ON native_runtimes (runtime_id, descriptor_product, descriptor_access)`;

const CREATE_NATIVE_RUNTIMES_LAUNCH_INDEX_SQL = `CREATE UNIQUE INDEX native_runtimes_launch_identity_unique
ON native_runtimes (
  warden_launch_nonce,
  initial_start_identity_schema_id,
  initial_start_identity_digest
)`;

const CREATE_NATIVE_RUNTIME_INCARNATIONS_DESCRIPTOR_INDEX_SQL = `CREATE UNIQUE INDEX native_runtime_incarnations_descriptor_scope_unique
ON native_runtime_incarnations (
  runtime_id,
  native_incarnation,
  descriptor_product,
  descriptor_access
)`;

const CREATE_RUNTIME_OWNER_ASSIGNMENTS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_assignments_scope_unique
ON runtime_owner_assignments (
  runtime_owner_assignment_id,
  runtime_id,
  native_incarnation
)`;

const CREATE_RUNTIME_OWNER_ASSIGNMENTS_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_assignments_generation_unique
ON runtime_owner_assignments (runtime_id, native_incarnation, assignment_generation)`;

const CREATE_NATIVE_RUNTIME_CONTAINMENTS_PREDECESSOR_INDEX_SQL = `CREATE UNIQUE INDEX native_runtime_containments_predecessor_unique
ON native_runtime_containments (runtime_id, predecessor_native_incarnation)`;

const CREATE_NATIVE_RUNTIME_CONTAINMENTS_SUCCESSOR_INDEX_SQL = `CREATE UNIQUE INDEX native_runtime_containments_successor_unique
ON native_runtime_containments (runtime_id, successor_native_incarnation)
WHERE successor_native_incarnation IS NOT NULL`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_identity_keys_scope_unique
ON runtime_owner_identity_keys (
  runtime_id,
  runtime_owner_identity_key_id,
  key_generation
)`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_identity_keys_generation_unique
ON runtime_owner_identity_keys (runtime_id, key_generation)`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_identity_keys_current_unique
ON runtime_owner_identity_keys (runtime_id)
WHERE state = 'current'`;

const CREATE_RUNTIME_OWNER_PRIVATE_KEYS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_private_keys_scope_unique
ON runtime_owner_private_keys (
  protected_handle_id,
  runtime_id,
  runtime_owner_identity_key_id,
  key_generation
)`;

const CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_signature_reservations_digest_unique
ON runtime_owner_signature_reservations (
  runtime_id,
  runtime_owner_identity_key_id,
  runtime_owner_key_generation,
  signer_sequence,
  signed_record_digest
)`;

const CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_SIGNED_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_signature_reservations_signed_digest_unique
ON runtime_owner_signature_reservations (signed_record_digest)
WHERE signed_record_digest IS NOT NULL`;

const CREATE_RUNTIME_OWNER_ACCEPTANCES_SIGNED_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX runtime_owner_signed_record_acceptances_signed_digest_unique
ON runtime_owner_signed_record_acceptances (signed_record_digest)`;

const CREATE_LOCAL_NATIVE_CONVERSATIONS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX local_native_conversations_scope_unique
ON local_native_conversations (
  local_native_conversation_id,
  runtime_id,
  native_incarnation
)`;

const CREATE_LOCAL_NATIVE_CONVERSATIONS_SEMANTIC_INDEX_SQL = `CREATE UNIQUE INDEX local_native_conversations_semantic_unique
ON local_native_conversations (
  runtime_id,
  native_incarnation,
  semantic_conversation_id
)
WHERE semantic_conversation_id IS NOT NULL`;

const CREATE_LOCAL_NATIVE_TRANSITIONS_SEQUENCE_INDEX_SQL = `CREATE UNIQUE INDEX local_native_conversation_transitions_sequence_unique
ON local_native_conversation_transitions (
  runtime_id,
  native_incarnation,
  local_transition_seq
)`;

const CREATE_NATIVE_BINDING_INCARNATIONS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX native_binding_incarnations_scope_unique
ON native_binding_incarnations (
  native_binding_incarnation_id,
  collaboration_server_id,
  logical_chat_id,
  native_binding_id,
  runtime_id,
  native_incarnation
)`;

const CREATE_NATIVE_BINDING_INCARNATIONS_RUNTIME_INDEX_SQL = `CREATE UNIQUE INDEX native_binding_incarnations_runtime_unique
ON native_binding_incarnations (
  native_binding_incarnation_id,
  runtime_id,
  native_incarnation
)`;

const CREATE_NATIVE_BINDING_INCARNATIONS_CURRENT_BINDING_INDEX_SQL = `CREATE UNIQUE INDEX native_binding_incarnations_current_binding_unique
ON native_binding_incarnations (native_binding_id)
WHERE state = 'current'`;

const CREATE_NATIVE_BINDING_INCARNATIONS_CURRENT_SEMANTIC_INDEX_SQL = `CREATE UNIQUE INDEX native_binding_incarnations_current_semantic_unique
ON native_binding_incarnations (
  runtime_id,
  native_incarnation,
  semantic_conversation_id
)
WHERE state = 'current'`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX native_transport_attachments_scope_unique
ON native_transport_attachments (attachment_id, native_binding_id)`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX native_transport_attachments_generation_unique
ON native_transport_attachments (native_binding_id, generation)`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX native_transport_attachments_current_unique
ON native_transport_attachments (native_binding_id)
WHERE state = 'current'`;

const CREATE_NATIVE_TRANSPORT_LEASES_ATTACHMENT_INDEX_SQL = `CREATE UNIQUE INDEX native_transport_leases_attachment_unique
ON native_transport_leases (attachment_lease_id, attachment_id)`;

const CREATE_NATIVE_TRANSPORT_LEASES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX native_transport_leases_scope_unique
ON native_transport_leases (
  attachment_lease_id,
  attachment_id,
  native_binding_incarnation_id,
  runtime_id,
  native_incarnation
)`;

const CREATE_NATIVE_TRANSPORT_LEASES_EPOCH_INDEX_SQL = `CREATE UNIQUE INDEX native_transport_leases_epoch_unique
ON native_transport_leases (attachment_id, transport_epoch)`;

const CREATE_NATIVE_TRANSPORT_LEASES_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX native_transport_leases_current_unique
ON native_transport_leases (attachment_id)
WHERE state = 'current'`;

const CREATE_COORDINATOR_LEASES_ID_EPOCH_INDEX_SQL = `CREATE UNIQUE INDEX coordinator_leases_id_epoch_unique
ON coordinator_leases (coordinator_lease_id, coordinator_epoch)`;

const CREATE_RUNTIME_OWNER_STATE_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_state_identity_immutable
BEFORE UPDATE ON runtime_owner_state
WHEN NEW.singleton IS NOT OLD.singleton
  OR NEW.machine_identity_id IS NOT OLD.machine_identity_id
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'runtime owner state identity is immutable');
END`;

const CREATE_RUNTIME_OWNER_STATE_LEASE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_state_lease_transition
BEFORE UPDATE ON runtime_owner_state
WHEN NOT (
  (
    NEW.current_runtime_owner_service_lease_id IS OLD.current_runtime_owner_service_lease_id
    AND NEW.current_runtime_owner_service_epoch = OLD.current_runtime_owner_service_epoch
  ) OR (
    OLD.current_runtime_owner_service_lease_id IS NOT NULL
    AND NEW.current_runtime_owner_service_lease_id IS NULL
    AND NEW.current_runtime_owner_service_epoch = OLD.current_runtime_owner_service_epoch
    AND EXISTS (
      SELECT 1 FROM runtime_owner_service_leases AS released_current
      WHERE released_current.runtime_owner_service_lease_id = OLD.current_runtime_owner_service_lease_id
        AND released_current.machine_identity_id = OLD.machine_identity_id
        AND released_current.runtime_owner_service_epoch = OLD.current_runtime_owner_service_epoch
        AND released_current.state = 'released'
        AND released_current.released_at_ms IS NOT NULL
    )
  ) OR (
    NEW.current_runtime_owner_service_lease_id IS NOT NULL
    AND NEW.current_runtime_owner_service_lease_id IS NOT OLD.current_runtime_owner_service_lease_id
    AND NEW.current_runtime_owner_service_epoch = OLD.current_runtime_owner_service_epoch + 1
    AND EXISTS (
      SELECT 1 FROM runtime_owner_service_leases AS successor
      WHERE successor.runtime_owner_service_lease_id = NEW.current_runtime_owner_service_lease_id
        AND successor.machine_identity_id = OLD.machine_identity_id
        AND successor.runtime_owner_service_epoch = NEW.current_runtime_owner_service_epoch
        AND successor.state = 'current'
        AND (
          (OLD.current_runtime_owner_service_lease_id IS NULL AND (
            OLD.current_runtime_owner_service_epoch = 0
            OR EXISTS (
              SELECT 1 FROM runtime_owner_service_leases AS released_predecessor
              WHERE released_predecessor.machine_identity_id = OLD.machine_identity_id
                AND released_predecessor.runtime_owner_service_epoch = OLD.current_runtime_owner_service_epoch
                AND released_predecessor.state = 'released'
                AND released_predecessor.released_at_ms IS NOT NULL
                AND successor.acquired_at_ms >= released_predecessor.released_at_ms
            )
          ))
          OR (OLD.current_runtime_owner_service_lease_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM runtime_owner_service_leases AS predecessor
            WHERE predecessor.runtime_owner_service_lease_id = OLD.current_runtime_owner_service_lease_id
              AND predecessor.machine_identity_id = OLD.machine_identity_id
              AND predecessor.runtime_owner_service_epoch = OLD.current_runtime_owner_service_epoch
              AND successor.acquired_at_ms >= predecessor.heartbeat_deadline_ms
          ))
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'runtime owner lease pointer transition is not fenced');
END`;

const CREATE_RUNTIME_OWNER_STATE_JOURNAL_OFFSET_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_state_journal_offset_transition
BEFORE UPDATE OF next_journal_offset ON runtime_owner_state
WHEN NEW.next_journal_offset <> OLD.next_journal_offset
  AND NOT (
    NEW.next_journal_offset = OLD.next_journal_offset + 1
    AND EXISTS (
      SELECT 1 FROM runtime_owner_journal_entries
      WHERE journal_offset = OLD.next_journal_offset
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime owner journal offset must follow its exact durable entry');
END`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_INSERT_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_service_leases_require_successor_epoch
BEFORE INSERT ON runtime_owner_service_leases
WHEN NEW.state = 'current'
  AND NOT EXISTS (
    SELECT 1 FROM runtime_owner_state AS owner
    WHERE owner.machine_identity_id = NEW.machine_identity_id
      AND NEW.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch + 1
      AND (
        (owner.current_runtime_owner_service_lease_id IS NULL AND (
          owner.current_runtime_owner_service_epoch = 0
          OR EXISTS (
            SELECT 1 FROM runtime_owner_service_leases AS released_predecessor
            WHERE released_predecessor.machine_identity_id = owner.machine_identity_id
              AND released_predecessor.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
              AND released_predecessor.state = 'released'
              AND released_predecessor.released_at_ms IS NOT NULL
              AND NEW.acquired_at_ms >= released_predecessor.released_at_ms
          )
        ))
        OR (owner.current_runtime_owner_service_lease_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM runtime_owner_service_leases AS predecessor
          WHERE predecessor.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
            AND predecessor.machine_identity_id = owner.machine_identity_id
            AND predecessor.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
            AND NEW.acquired_at_ms >= predecessor.heartbeat_deadline_ms
        ))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime owner service lease must be the next fenced epoch');
END`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_service_leases_identity_immutable
BEFORE UPDATE ON runtime_owner_service_leases
WHEN NEW.runtime_owner_service_lease_id IS NOT OLD.runtime_owner_service_lease_id
  OR NEW.machine_identity_id IS NOT OLD.machine_identity_id
  OR NEW.runtime_owner_service_epoch IS NOT OLD.runtime_owner_service_epoch
  OR NEW.owner_instance_id IS NOT OLD.owner_instance_id
  OR NEW.owner_process_start_identity_schema_id IS NOT OLD.owner_process_start_identity_schema_id
  OR NEW.owner_process_start_identity_ref IS NOT OLD.owner_process_start_identity_ref
  OR NEW.owner_process_start_identity_digest IS NOT OLD.owner_process_start_identity_digest
  OR NEW.acquired_at_ms IS NOT OLD.acquired_at_ms
  OR NEW.initial_heartbeat_deadline_ms IS NOT OLD.initial_heartbeat_deadline_ms
BEGIN
  SELECT RAISE(ABORT, 'runtime owner service lease identity is immutable');
END`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_HEARTBEAT_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_service_leases_heartbeat_monotonic
BEFORE UPDATE OF heartbeat_deadline_ms ON runtime_owner_service_leases
WHEN NEW.heartbeat_deadline_ms IS NOT OLD.heartbeat_deadline_ms
  AND NOT (
    OLD.state = 'current'
    AND NEW.state = 'current'
    AND NEW.heartbeat_deadline_ms > OLD.heartbeat_deadline_ms
    AND NEW.released_at_ms IS OLD.released_at_ms
    AND EXISTS (
      SELECT 1 FROM runtime_owner_state
      WHERE singleton = 1
        AND current_runtime_owner_service_lease_id = OLD.runtime_owner_service_lease_id
        AND current_runtime_owner_service_epoch = OLD.runtime_owner_service_epoch
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime owner service lease heartbeat must strictly extend the current fence');
END`;

const CREATE_RUNTIME_OWNER_SERVICE_LEASES_STATE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_service_leases_state_monotonic
BEFORE UPDATE ON runtime_owner_service_leases
WHEN NEW.state IS NOT OLD.state OR NEW.released_at_ms IS NOT OLD.released_at_ms
BEGIN
  SELECT CASE WHEN NOT (
    OLD.state = 'current'
    AND NEW.state = 'released'
    AND OLD.released_at_ms IS NULL
    AND NEW.released_at_ms IS NOT NULL
    AND NEW.heartbeat_deadline_ms = OLD.heartbeat_deadline_ms
    AND EXISTS (
      SELECT 1 FROM runtime_owner_state
      WHERE singleton = 1
        AND current_runtime_owner_service_lease_id = OLD.runtime_owner_service_lease_id
        AND current_runtime_owner_service_epoch = OLD.runtime_owner_service_epoch
    )
  ) THEN RAISE(ABORT, 'runtime owner service lease lifecycle is monotonic') END;
END`;

const CREATE_RUNTIME_OWNER_JOURNAL_OFFSET_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_journal_entries_require_next_offset
BEFORE INSERT ON runtime_owner_journal_entries
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_owner_state
  WHERE singleton = 1 AND next_journal_offset = NEW.journal_offset
)
BEGIN
  SELECT RAISE(ABORT, 'runtime owner journal entry does not use the next offset');
END`;

const CREATE_RUNTIME_OWNER_JOURNAL_INCREMENT_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_journal_entries_increment_offset
AFTER INSERT ON runtime_owner_journal_entries
BEGIN
  UPDATE runtime_owner_state
  SET next_journal_offset = next_journal_offset + 1
  WHERE singleton = 1 AND next_journal_offset = NEW.journal_offset;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'runtime owner journal offset advance lost its compare-and-swap') END;
END`;

const CREATE_RUNTIME_OWNER_JOURNAL_SUBJECT_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_journal_entries_require_subject
BEFORE INSERT ON runtime_owner_journal_entries
WHEN NOT (
  (NEW.entry_kind IN ('service_lease_acquired', 'service_lease_released')
    AND NEW.subject_kind = 'service_lease'
    AND EXISTS (
      SELECT 1 FROM runtime_owner_service_leases
      WHERE runtime_owner_service_lease_id = NEW.subject_id
        AND runtime_owner_service_lease_id = NEW.runtime_owner_service_lease_id
        AND runtime_owner_service_epoch = NEW.runtime_owner_service_epoch
    ))
  OR (NEW.entry_kind IN ('runtime_registered', 'runtime_reassigned', 'runtime_replaced', 'runtime_terminated')
    AND NEW.subject_kind = 'native_runtime'
    AND EXISTS (SELECT 1 FROM native_runtimes WHERE runtime_id = NEW.subject_id))
  OR (NEW.entry_kind = 'runtime_key_rotated'
    AND NEW.subject_kind = 'runtime_owner_identity_key'
    AND EXISTS (
      SELECT 1 FROM runtime_owner_identity_keys
      WHERE runtime_owner_identity_key_id = NEW.subject_id
    ))
  OR (NEW.entry_kind = 'local_conversation_transitioned'
    AND NEW.subject_kind = 'local_native_transition'
    AND EXISTS (
      SELECT 1 FROM local_native_conversation_transitions
      WHERE local_transition_id = NEW.subject_id
    ))
  OR (NEW.entry_kind = 'binding_incarnation_prepared'
    AND NEW.subject_kind = 'native_binding_incarnation'
    AND EXISTS (
      SELECT 1 FROM native_binding_incarnations
      WHERE native_binding_incarnation_id = NEW.subject_id
    ))
  OR (NEW.entry_kind IN ('attachment_lease_acquired', 'attachment_detached')
    AND NEW.subject_kind = 'native_transport_lease'
    AND EXISTS (
      SELECT 1 FROM native_transport_leases
      WHERE attachment_lease_id = NEW.subject_id
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'runtime owner journal subject is not present for its entry kind');
END`;

const CREATE_RUNTIME_OWNER_JOURNAL_FENCE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_journal_entries_require_current_owner
BEFORE INSERT ON runtime_owner_journal_entries
WHEN NOT EXISTS (
  SELECT 1
  FROM runtime_owner_state AS owner
  JOIN runtime_owner_service_leases AS lease
    ON lease.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND lease.machine_identity_id = owner.machine_identity_id
    AND lease.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
  WHERE owner.singleton = 1
    AND NEW.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND NEW.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
    AND NEW.committed_at_ms >= lease.acquired_at_ms
    AND NEW.committed_at_ms < lease.heartbeat_deadline_ms
    AND (
      lease.state = 'current'
      OR (NEW.entry_kind = 'service_lease_released' AND lease.state = 'released')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'runtime owner journal entry requires the unexpired current owner fence');
END`;

const CREATE_NATIVE_RUNTIMES_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_runtimes_identity_immutable
BEFORE UPDATE ON native_runtimes
WHEN NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.descriptor_product IS NOT OLD.descriptor_product
  OR NEW.descriptor_access IS NOT OLD.descriptor_access
  OR NEW.warden_launch_nonce IS NOT OLD.warden_launch_nonce
  OR NEW.initial_start_identity_schema_id IS NOT OLD.initial_start_identity_schema_id
  OR NEW.initial_start_identity_ref IS NOT OLD.initial_start_identity_ref
  OR NEW.initial_start_identity_digest IS NOT OLD.initial_start_identity_digest
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'native runtime identity and founding evidence are immutable');
END`;

const CREATE_NATIVE_RUNTIMES_POINTER_TRIGGER_SQL = `CREATE TRIGGER native_runtimes_pointer_transition
BEFORE UPDATE ON native_runtimes
WHEN NOT (
  (
    NEW.current_native_incarnation IS OLD.current_native_incarnation
    AND NEW.current_runtime_owner_assignment_id IS OLD.current_runtime_owner_assignment_id
  ) OR (
    OLD.state = 'current'
    AND NEW.state = 'current'
    AND NEW.current_native_incarnation = OLD.current_native_incarnation
    AND NEW.current_runtime_owner_assignment_id IS NOT OLD.current_runtime_owner_assignment_id
    AND EXISTS (
      SELECT 1
      FROM runtime_owner_assignments AS successor
      JOIN runtime_owner_assignments AS predecessor
        ON predecessor.runtime_owner_assignment_id = successor.supersedes_runtime_owner_assignment_id
        AND predecessor.runtime_id = successor.runtime_id
        AND predecessor.native_incarnation = successor.native_incarnation
      WHERE successor.runtime_owner_assignment_id = NEW.current_runtime_owner_assignment_id
        AND successor.runtime_id = OLD.runtime_id
        AND successor.native_incarnation = OLD.current_native_incarnation
        AND successor.assignment_generation = predecessor.assignment_generation + 1
        AND successor.reason = 'takeover'
        AND predecessor.runtime_owner_assignment_id = OLD.current_runtime_owner_assignment_id
    )
  ) OR (
    OLD.state = 'current'
    AND NEW.state = 'current'
    AND NEW.current_native_incarnation = OLD.current_native_incarnation + 1
    AND NEW.current_runtime_owner_assignment_id IS NOT OLD.current_runtime_owner_assignment_id
    AND EXISTS (
      SELECT 1 FROM native_runtime_containments
      WHERE runtime_id = OLD.runtime_id
        AND predecessor_native_incarnation = OLD.current_native_incarnation
        AND successor_native_incarnation = NEW.current_native_incarnation
        AND kind = 'replacement'
    )
    AND EXISTS (
      SELECT 1 FROM runtime_owner_assignments
      WHERE runtime_owner_assignment_id = NEW.current_runtime_owner_assignment_id
        AND runtime_id = OLD.runtime_id
        AND native_incarnation = NEW.current_native_incarnation
    )
  ) OR (
    OLD.state = 'current'
    AND NEW.state = 'closed'
    AND NEW.current_native_incarnation IS NULL
    AND NEW.current_runtime_owner_assignment_id IS NULL
    AND EXISTS (
      SELECT 1 FROM native_runtime_containments
      WHERE runtime_id = OLD.runtime_id
        AND predecessor_native_incarnation = OLD.current_native_incarnation
        AND successor_native_incarnation IS NULL
        AND kind = 'termination'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native runtime pointer transition lacks containment and owner assignment');
END`;

const CREATE_NATIVE_RUNTIMES_STATE_TRIGGER_SQL = `CREATE TRIGGER native_runtimes_state_monotonic
BEFORE UPDATE ON native_runtimes
WHEN NOT (
  (NEW.state = OLD.state AND NEW.closed_at_ms IS OLD.closed_at_ms)
  OR (OLD.state = 'current' AND NEW.state = 'closed'
    AND OLD.closed_at_ms IS NULL AND NEW.closed_at_ms IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'native runtime state transition is not allowed');
END`;

const CREATE_NATIVE_RUNTIMES_TRANSITION_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER native_runtimes_local_transition_sequence
BEFORE UPDATE OF next_local_transition_seq ON native_runtimes
WHEN NEW.next_local_transition_seq <> OLD.next_local_transition_seq
  AND NOT (
    NEW.next_local_transition_seq = OLD.next_local_transition_seq + 1
    AND EXISTS (
      SELECT 1 FROM local_native_conversation_transitions
      WHERE runtime_id = OLD.runtime_id
        AND local_transition_seq = OLD.next_local_transition_seq
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'local transition sequence must follow its exact durable transition');
END`;

const CREATE_NATIVE_RUNTIME_INCARNATIONS_PREDECESSOR_TRIGGER_SQL = `CREATE TRIGGER native_runtime_incarnations_require_predecessor
BEFORE INSERT ON native_runtime_incarnations
WHEN NOT (
  NEW.native_incarnation = 1
  OR EXISTS (
    SELECT 1
    FROM native_runtime_incarnations AS predecessor
    JOIN native_runtime_containments AS containment
      ON containment.runtime_id = predecessor.runtime_id
      AND containment.predecessor_native_incarnation = predecessor.native_incarnation
      AND containment.successor_native_incarnation = NEW.native_incarnation
      AND containment.kind = 'replacement'
    WHERE predecessor.runtime_id = NEW.runtime_id
      AND predecessor.native_incarnation = NEW.native_incarnation - 1
      AND predecessor.state = 'closed'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native runtime incarnation requires its contained predecessor');
END`;

const CREATE_NATIVE_RUNTIME_INCARNATIONS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_runtime_incarnations_identity_immutable
BEFORE UPDATE ON native_runtime_incarnations
WHEN NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.native_incarnation IS NOT OLD.native_incarnation
  OR NEW.descriptor_product IS NOT OLD.descriptor_product
  OR NEW.descriptor_access IS NOT OLD.descriptor_access
  OR NEW.runtime_owner_service_lease_id IS NOT OLD.runtime_owner_service_lease_id
  OR NEW.runtime_owner_service_epoch IS NOT OLD.runtime_owner_service_epoch
  OR NEW.start_identity_schema_id IS NOT OLD.start_identity_schema_id
  OR NEW.start_identity_ref IS NOT OLD.start_identity_ref
  OR NEW.start_identity_digest IS NOT OLD.start_identity_digest
  OR NEW.started_at_ms IS NOT OLD.started_at_ms
BEGIN
  SELECT RAISE(ABORT, 'native runtime incarnation identity and start evidence are immutable');
END`;

const CREATE_NATIVE_RUNTIME_INCARNATIONS_STATE_TRIGGER_SQL = `CREATE TRIGGER native_runtime_incarnations_state_monotonic
BEFORE UPDATE ON native_runtime_incarnations
WHEN NOT (
  (NEW.state = OLD.state AND NEW.closed_at_ms IS OLD.closed_at_ms)
  OR (OLD.state = 'starting' AND NEW.state IN ('current', 'draining')
    AND NEW.closed_at_ms IS NULL)
  OR (OLD.state = 'current' AND NEW.state = 'draining'
    AND NEW.closed_at_ms IS NULL)
  OR (OLD.state IN ('starting', 'current', 'draining') AND NEW.state = 'closed'
    AND OLD.closed_at_ms IS NULL AND NEW.closed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM native_runtime_containments
      WHERE runtime_id = OLD.runtime_id
        AND predecessor_native_incarnation = OLD.native_incarnation
        AND contained_at_ms <= NEW.closed_at_ms
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'native runtime incarnation lifecycle is monotonic');
END`;

const CREATE_RUNTIME_OWNER_ASSIGNMENTS_PREDECESSOR_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_assignments_require_predecessor
BEFORE INSERT ON runtime_owner_assignments
WHEN NOT (
  (NEW.assignment_generation = 1
    AND NEW.reason = 'creation'
    AND NEW.supersedes_runtime_owner_assignment_id IS NULL)
  OR (NEW.assignment_generation > 1
    AND NEW.reason = 'takeover'
    AND EXISTS (
      SELECT 1 FROM runtime_owner_assignments AS predecessor
      WHERE predecessor.runtime_owner_assignment_id = NEW.supersedes_runtime_owner_assignment_id
        AND predecessor.runtime_id = NEW.runtime_id
        AND predecessor.native_incarnation = NEW.native_incarnation
        AND predecessor.assignment_generation = NEW.assignment_generation - 1
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'runtime owner assignment requires its exact predecessor');
END`;

const CREATE_RUNTIME_OWNER_ASSIGNMENTS_FENCE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_assignments_require_current_owner
BEFORE INSERT ON runtime_owner_assignments
WHEN NOT EXISTS (
  SELECT 1
  FROM runtime_owner_state AS owner
  JOIN runtime_owner_service_leases AS lease
    ON lease.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND lease.machine_identity_id = owner.machine_identity_id
    AND lease.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
  WHERE owner.singleton = 1
    AND NEW.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND NEW.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
    AND lease.state = 'current'
    AND NEW.assigned_at_ms >= lease.acquired_at_ms
    AND NEW.assigned_at_ms < lease.heartbeat_deadline_ms
)
BEGIN
  SELECT RAISE(ABORT, 'runtime owner assignment requires the unexpired current owner fence');
END`;

const CREATE_NATIVE_RUNTIME_CONTAINMENTS_FENCE_TRIGGER_SQL = `CREATE TRIGGER native_runtime_containments_require_current_owner
BEFORE INSERT ON native_runtime_containments
WHEN NOT EXISTS (
  SELECT 1
  FROM runtime_owner_state AS owner
  JOIN runtime_owner_service_leases AS lease
    ON lease.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND lease.machine_identity_id = owner.machine_identity_id
    AND lease.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
  JOIN native_runtime_incarnations AS predecessor
    ON predecessor.runtime_id = NEW.runtime_id
    AND predecessor.native_incarnation = NEW.predecessor_native_incarnation
  WHERE owner.singleton = 1
    AND NEW.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND NEW.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
    AND lease.state = 'current'
    AND NEW.contained_at_ms >= lease.acquired_at_ms
    AND NEW.contained_at_ms < lease.heartbeat_deadline_ms
    AND predecessor.state IN ('starting', 'current', 'draining')
    AND predecessor.closed_at_ms IS NULL
    AND predecessor.started_at_ms <= NEW.contained_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'runtime containment requires a live predecessor and current owner');
END`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_PREDECESSOR_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_identity_keys_require_predecessor
BEFORE INSERT ON runtime_owner_identity_keys
WHEN NOT (
  NEW.key_generation = 1
  OR EXISTS (
    SELECT 1 FROM runtime_owner_identity_keys AS predecessor
    WHERE predecessor.runtime_id = NEW.runtime_id
      AND predecessor.key_generation = NEW.key_generation - 1
      AND predecessor.state IN ('retired', 'revoked')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'runtime owner key generation requires its retired predecessor');
END`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_identity_keys_identity_immutable
BEFORE UPDATE ON runtime_owner_identity_keys
WHEN NEW.runtime_owner_identity_key_id IS NOT OLD.runtime_owner_identity_key_id
  OR NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.key_generation IS NOT OLD.key_generation
  OR NEW.algorithm IS NOT OLD.algorithm
  OR NEW.public_key IS NOT OLD.public_key
  OR NEW.local_trust_evidence_ref IS NOT OLD.local_trust_evidence_ref
  OR NEW.local_trust_evidence_digest IS NOT OLD.local_trust_evidence_digest
BEGIN
  SELECT RAISE(ABORT, 'runtime owner identity key metadata is immutable');
END`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_identity_keys_sequence_monotonic
BEFORE UPDATE OF next_signer_sequence ON runtime_owner_identity_keys
WHEN NEW.next_signer_sequence <> OLD.next_signer_sequence
  AND NOT (
    OLD.state = 'current'
    AND NEW.state = 'current'
    AND NEW.next_signer_sequence = OLD.next_signer_sequence + 1
    AND EXISTS (
      SELECT 1 FROM runtime_owner_signature_reservations
      WHERE runtime_id = OLD.runtime_id
        AND runtime_owner_identity_key_id = OLD.runtime_owner_identity_key_id
        AND runtime_owner_key_generation = OLD.key_generation
        AND signer_sequence = OLD.next_signer_sequence
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime owner signer sequence must follow its reservation');
END`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_STATE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_identity_keys_state_monotonic
BEFORE UPDATE ON runtime_owner_identity_keys
WHEN NEW.state IS NOT OLD.state
  OR NEW.signing_key_protected_handle_id IS NOT OLD.signing_key_protected_handle_id
BEGIN
  SELECT CASE WHEN NOT (
    OLD.state = 'current'
    AND NEW.state IN ('retired', 'revoked')
    AND NEW.signing_key_protected_handle_id IS NULL
    AND OLD.signing_key_protected_handle_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM runtime_owner_private_keys
      WHERE protected_handle_id = OLD.signing_key_protected_handle_id
        AND runtime_id = OLD.runtime_id
        AND runtime_owner_identity_key_id = OLD.runtime_owner_identity_key_id
        AND key_generation = OLD.key_generation
        AND state = 'destroyed'
    )
  ) THEN RAISE(ABORT, 'runtime owner identity key lifecycle is monotonic') END;
END`;

const CREATE_RUNTIME_OWNER_PRIVATE_KEYS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_private_keys_identity_immutable
BEFORE UPDATE ON runtime_owner_private_keys
WHEN NEW.protected_handle_id IS NOT OLD.protected_handle_id
  OR NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.runtime_owner_identity_key_id IS NOT OLD.runtime_owner_identity_key_id
  OR NEW.key_generation IS NOT OLD.key_generation
  OR NEW.wrapping_schema_id IS NOT OLD.wrapping_schema_id
  OR NEW.wrap_nonce IS NOT OLD.wrap_nonce
  OR NEW.wrapped_pkcs8 IS NOT OLD.wrapped_pkcs8
  OR NEW.auth_tag IS NOT OLD.auth_tag
  OR NEW.pkcs8_digest IS NOT OLD.pkcs8_digest
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'wrapped runtime owner private key envelope is immutable');
END`;

const CREATE_RUNTIME_OWNER_PRIVATE_KEYS_STATE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_private_keys_state_monotonic
BEFORE UPDATE ON runtime_owner_private_keys
WHEN NOT (
  (NEW.state = OLD.state AND NEW.destroyed_at_ms IS OLD.destroyed_at_ms)
  OR (OLD.state = 'current'
    AND NEW.state = 'destroyed'
    AND OLD.destroyed_at_ms IS NULL
    AND NEW.destroyed_at_ms IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'wrapped runtime owner private key lifecycle is monotonic');
END`;

const CREATE_RUNTIME_OWNER_PRIVATE_KEYS_HANDLE_COLLISION_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_private_keys_require_unallocated_handle
BEFORE INSERT ON runtime_owner_private_keys
WHEN EXISTS (
  SELECT 1 FROM protected_artifacts
  WHERE protected_handle_id = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated to an artifact');
END`;

const CREATE_PROTECTED_ARTIFACTS_PRIVATE_KEY_COLLISION_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_require_non_key_handle
BEFORE INSERT ON protected_artifacts
WHEN EXISTS (
  SELECT 1 FROM runtime_owner_private_keys
  WHERE protected_handle_id = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated to a signing key');
END`;

const CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_INSERT_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_signature_reservations_require_current_key
BEFORE INSERT ON runtime_owner_signature_reservations
WHEN NOT EXISTS (
  SELECT 1
  FROM runtime_owner_identity_keys AS key
  JOIN native_runtimes AS runtime ON runtime.runtime_id = key.runtime_id
  JOIN runtime_owner_assignments AS assignment
    ON assignment.runtime_owner_assignment_id = runtime.current_runtime_owner_assignment_id
    AND assignment.runtime_id = runtime.runtime_id
    AND assignment.native_incarnation = runtime.current_native_incarnation
  JOIN runtime_owner_state AS owner
    ON owner.current_runtime_owner_service_lease_id = assignment.runtime_owner_service_lease_id
    AND owner.current_runtime_owner_service_epoch = assignment.runtime_owner_service_epoch
  JOIN runtime_owner_private_keys AS private_key
    ON private_key.protected_handle_id = key.signing_key_protected_handle_id
    AND private_key.runtime_id = key.runtime_id
    AND private_key.runtime_owner_identity_key_id = key.runtime_owner_identity_key_id
    AND private_key.key_generation = key.key_generation
  WHERE key.runtime_id = NEW.runtime_id
    AND key.runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    AND key.key_generation = NEW.runtime_owner_key_generation
    AND key.next_signer_sequence = NEW.signer_sequence
    AND key.state = 'current'
    AND private_key.state = 'current'
)
BEGIN
  SELECT RAISE(ABORT, 'signature reservation requires the current key and owner assignment');
END`;

const CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_INCREMENT_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_signature_reservations_increment_sequence
AFTER INSERT ON runtime_owner_signature_reservations
BEGIN
  UPDATE runtime_owner_identity_keys
  SET next_signer_sequence = next_signer_sequence + 1
  WHERE runtime_id = NEW.runtime_id
    AND runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    AND key_generation = NEW.runtime_owner_key_generation
    AND next_signer_sequence = NEW.signer_sequence
    AND state = 'current';
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'signature sequence advance lost its compare-and-swap') END;
END`;

const CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_signature_reservations_identity_immutable
BEFORE UPDATE ON runtime_owner_signature_reservations
WHEN NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.runtime_owner_identity_key_id IS NOT OLD.runtime_owner_identity_key_id
  OR NEW.runtime_owner_key_generation IS NOT OLD.runtime_owner_key_generation
  OR NEW.signer_sequence IS NOT OLD.signer_sequence
  OR NEW.purpose IS NOT OLD.purpose
BEGIN
  SELECT RAISE(ABORT, 'signature reservation identity and purpose are immutable');
END`;

const CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_STATE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_signature_reservations_state_monotonic
BEFORE UPDATE ON runtime_owner_signature_reservations
WHEN NOT (
  (NEW.state = OLD.state
    AND NEW.canonical_payload_schema_id IS OLD.canonical_payload_schema_id
    AND NEW.canonical_payload_ref IS OLD.canonical_payload_ref
    AND NEW.canonical_payload_digest IS OLD.canonical_payload_digest
    AND NEW.signed_record_digest IS OLD.signed_record_digest
    AND NEW.signature IS OLD.signature
    AND NEW.signed_artifact_id IS OLD.signed_artifact_id)
  OR (OLD.state = 'reserved' AND NEW.state IN ('bound', 'aborted'))
  OR (OLD.state = 'bound' AND NEW.state = 'signed'
    AND NEW.canonical_payload_schema_id IS OLD.canonical_payload_schema_id
    AND NEW.canonical_payload_ref IS OLD.canonical_payload_ref
    AND NEW.canonical_payload_digest IS OLD.canonical_payload_digest)
  OR (OLD.state = 'bound' AND NEW.state = 'aborted')
)
BEGIN
  SELECT RAISE(ABORT, 'signature reservation lifecycle is monotonic');
END`;

const CREATE_RUNTIME_OWNER_ACCEPTANCES_SIGNED_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_signed_record_acceptances_require_signed
BEFORE INSERT ON runtime_owner_signed_record_acceptances
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_owner_signature_reservations
  WHERE runtime_id = NEW.runtime_id
    AND runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    AND runtime_owner_key_generation = NEW.runtime_owner_key_generation
    AND signer_sequence = NEW.signer_sequence
    AND signed_record_digest = NEW.signed_record_digest
    AND state = 'signed'
)
BEGIN
  SELECT RAISE(ABORT, 'signed record acceptance requires an exact signed reservation');
END`;

const CREATE_LOCAL_NATIVE_CONVERSATIONS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER local_native_conversations_identity_immutable
BEFORE UPDATE ON local_native_conversations
WHEN NEW.local_native_conversation_id IS NOT OLD.local_native_conversation_id
  OR NEW.descriptor_product IS NOT OLD.descriptor_product
  OR NEW.descriptor_access IS NOT OLD.descriptor_access
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.native_incarnation IS NOT OLD.native_incarnation
  OR NEW.parent_local_native_conversation_id IS NOT OLD.parent_local_native_conversation_id
  OR (OLD.semantic_conversation_id IS NOT NULL
    AND NEW.semantic_conversation_id IS NOT OLD.semantic_conversation_id)
BEGIN
  SELECT RAISE(ABORT, 'local native conversation identity and lineage are immutable');
END`;

const CREATE_LOCAL_NATIVE_CONVERSATIONS_STATE_TRIGGER_SQL = `CREATE TRIGGER local_native_conversations_state_monotonic
BEFORE UPDATE OF state ON local_native_conversations
WHEN NOT (
  NEW.state = OLD.state
  OR (OLD.state = 'unbound' AND NEW.state IN ('open', 'closed'))
  OR (OLD.state = 'open' AND NEW.state = 'closed')
)
BEGIN
  SELECT RAISE(ABORT, 'local native conversation lifecycle is monotonic');
END`;

const CREATE_LOCAL_NATIVE_TRANSITIONS_OFFSET_TRIGGER_SQL = `CREATE TRIGGER local_native_conversation_transitions_require_next_sequence
BEFORE INSERT ON local_native_conversation_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM native_runtimes
  WHERE runtime_id = NEW.runtime_id
    AND next_local_transition_seq = NEW.local_transition_seq
)
BEGIN
  SELECT RAISE(ABORT, 'local native transition does not use the next runtime sequence');
END`;

const CREATE_LOCAL_NATIVE_TRANSITIONS_FENCE_TRIGGER_SQL = `CREATE TRIGGER local_native_conversation_transitions_require_current_owner
BEFORE INSERT ON local_native_conversation_transitions
WHEN NOT EXISTS (
  SELECT 1
  FROM native_runtimes AS runtime
  JOIN runtime_owner_assignments AS assignment
    ON assignment.runtime_owner_assignment_id = runtime.current_runtime_owner_assignment_id
    AND assignment.runtime_id = runtime.runtime_id
    AND assignment.native_incarnation = runtime.current_native_incarnation
  JOIN runtime_owner_state AS owner
    ON owner.current_runtime_owner_service_lease_id = assignment.runtime_owner_service_lease_id
    AND owner.current_runtime_owner_service_epoch = assignment.runtime_owner_service_epoch
  JOIN runtime_owner_service_leases AS lease
    ON lease.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND lease.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
    AND lease.machine_identity_id = owner.machine_identity_id
  WHERE runtime.runtime_id = NEW.runtime_id
    AND runtime.current_native_incarnation = NEW.native_incarnation
    AND lease.state = 'current'
    AND NEW.observed_at_ms >= lease.acquired_at_ms
    AND NEW.observed_at_ms < lease.heartbeat_deadline_ms
)
BEGIN
  SELECT RAISE(ABORT, 'local native transition requires the unexpired current owner fence');
END`;

const CREATE_LOCAL_NATIVE_TRANSITIONS_INCREMENT_TRIGGER_SQL = `CREATE TRIGGER local_native_conversation_transitions_increment_sequence
AFTER INSERT ON local_native_conversation_transitions
BEGIN
  UPDATE native_runtimes
  SET next_local_transition_seq = next_local_transition_seq + 1
  WHERE runtime_id = NEW.runtime_id
    AND next_local_transition_seq = NEW.local_transition_seq;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'local transition sequence advance lost its compare-and-swap') END;
END`;

const CREATE_NATIVE_BINDING_INCARNATIONS_INSERT_TRIGGER_SQL = `CREATE TRIGGER native_binding_incarnations_require_current_runtime
BEFORE INSERT ON native_binding_incarnations
WHEN NOT EXISTS (
  SELECT 1
  FROM native_bindings AS binding
  JOIN native_runtimes AS runtime ON runtime.runtime_id = NEW.runtime_id
  JOIN runtime_owner_assignments AS assignment
    ON assignment.runtime_owner_assignment_id = runtime.current_runtime_owner_assignment_id
    AND assignment.runtime_id = runtime.runtime_id
    AND assignment.native_incarnation = runtime.current_native_incarnation
  JOIN runtime_owner_state AS owner
    ON owner.current_runtime_owner_service_lease_id = assignment.runtime_owner_service_lease_id
    AND owner.current_runtime_owner_service_epoch = assignment.runtime_owner_service_epoch
  JOIN runtime_owner_service_leases AS lease
    ON lease.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND lease.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
    AND lease.machine_identity_id = owner.machine_identity_id
  WHERE binding.native_binding_id = NEW.native_binding_id
    AND binding.collaboration_server_id = NEW.collaboration_server_id
    AND binding.logical_chat_id = NEW.logical_chat_id
    AND binding.descriptor_product = runtime.descriptor_product
    AND binding.descriptor_access = runtime.descriptor_access
    AND runtime.current_native_incarnation = NEW.native_incarnation
    AND runtime.state = 'current'
    AND lease.state = 'current'
    AND NEW.created_at_ms >= lease.acquired_at_ms
    AND NEW.created_at_ms < lease.heartbeat_deadline_ms
)
BEGIN
  SELECT RAISE(ABORT, 'binding incarnation requires matching current runtime and owner fence');
END`;

const CREATE_NATIVE_BINDING_INCARNATIONS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_binding_incarnations_identity_immutable
BEFORE UPDATE ON native_binding_incarnations
WHEN NEW.native_binding_incarnation_id IS NOT OLD.native_binding_incarnation_id
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
  OR NEW.native_binding_id IS NOT OLD.native_binding_id
  OR NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.native_incarnation IS NOT OLD.native_incarnation
  OR NEW.semantic_conversation_id IS NOT OLD.semantic_conversation_id
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'native binding incarnation identity is immutable');
END`;

const CREATE_NATIVE_BINDING_INCARNATIONS_STATE_TRIGGER_SQL = `CREATE TRIGGER native_binding_incarnations_state_monotonic
BEFORE UPDATE ON native_binding_incarnations
WHEN NOT (
  (NEW.state = OLD.state AND NEW.closed_at_ms IS OLD.closed_at_ms)
  OR (OLD.state = 'current' AND NEW.state = 'superseded'
    AND NEW.closed_at_ms IS NULL)
  OR (OLD.state IN ('current', 'superseded') AND NEW.state = 'closed'
    AND OLD.closed_at_ms IS NULL AND NEW.closed_at_ms IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'native binding incarnation lifecycle is monotonic');
END`;

const CREATE_NATIVE_BINDINGS_INCARNATION_POINTER_TRIGGER_SQL = `CREATE TRIGGER native_bindings_require_exact_current_incarnation
BEFORE UPDATE ON native_bindings
WHEN NEW.current_binding_incarnation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM native_binding_incarnations
    WHERE native_binding_incarnation_id = NEW.current_binding_incarnation_id
      AND collaboration_server_id = NEW.collaboration_server_id
      AND logical_chat_id = NEW.logical_chat_id
      AND native_binding_id = NEW.native_binding_id
      AND semantic_conversation_id = NEW.semantic_conversation_id
      AND state = 'current'
  )
BEGIN
  SELECT RAISE(ABORT, 'native binding current pointer requires its exact current incarnation');
END`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_INSERT_TRIGGER_SQL = `CREATE TRIGGER native_transport_attachments_require_binding_and_predecessor
BEFORE INSERT ON native_transport_attachments
WHEN NOT EXISTS (
  SELECT 1 FROM native_bindings AS binding
  WHERE binding.native_binding_id = NEW.native_binding_id
    AND (
      (binding.descriptor_access = 'native-rc' AND NEW.kind = 'claude-inner-rc')
      OR binding.descriptor_access = NEW.kind
    )
    AND (
      NEW.generation = 1
      OR EXISTS (
        SELECT 1 FROM native_transport_attachments AS predecessor
        WHERE predecessor.native_binding_id = NEW.native_binding_id
          AND predecessor.generation = NEW.generation - 1
          AND predecessor.state IN ('superseded', 'closed')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'transport attachment requires matching binding and predecessor');
END`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_transport_attachments_identity_immutable
BEFORE UPDATE ON native_transport_attachments
WHEN NEW.attachment_id IS NOT OLD.attachment_id
  OR NEW.native_binding_id IS NOT OLD.native_binding_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.transport_id IS NOT OLD.transport_id
  OR NEW.generation IS NOT OLD.generation
  OR NEW.resource_ownership IS NOT OLD.resource_ownership
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'native transport attachment identity is immutable');
END`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_POINTER_TRIGGER_SQL = `CREATE TRIGGER native_transport_attachments_lease_transition
BEFORE UPDATE OF current_attachment_lease_id ON native_transport_attachments
WHEN NOT (
  NEW.current_attachment_lease_id IS OLD.current_attachment_lease_id
  OR (OLD.current_attachment_lease_id IS NULL
    AND NEW.current_attachment_lease_id IS NOT NULL
    AND OLD.state = 'current'
    AND NEW.state = 'current'
    AND EXISTS (
      SELECT 1 FROM native_transport_leases
      WHERE attachment_lease_id = NEW.current_attachment_lease_id
        AND attachment_id = OLD.attachment_id
        AND state = 'current'
    ))
  OR (OLD.current_attachment_lease_id IS NOT NULL
    AND NEW.current_attachment_lease_id IS NULL
    AND EXISTS (
      SELECT 1 FROM native_transport_leases
      WHERE attachment_lease_id = OLD.current_attachment_lease_id
        AND attachment_id = OLD.attachment_id
        AND state IN ('superseded', 'closed')
        AND released_at_ms IS NOT NULL
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'native transport attachment lease pointer is not fenced');
END`;

const CREATE_NATIVE_TRANSPORT_ATTACHMENTS_STATE_TRIGGER_SQL = `CREATE TRIGGER native_transport_attachments_state_monotonic
BEFORE UPDATE ON native_transport_attachments
WHEN NOT (
  (NEW.state = OLD.state AND NEW.closed_at_ms IS OLD.closed_at_ms)
  OR (OLD.state = 'current' AND NEW.state = 'superseded'
    AND NEW.current_attachment_lease_id IS NULL
    AND NEW.closed_at_ms IS NULL)
  OR (OLD.state IN ('current', 'superseded') AND NEW.state = 'closed'
    AND NEW.current_attachment_lease_id IS NULL
    AND OLD.closed_at_ms IS NULL AND NEW.closed_at_ms IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'native transport attachment lifecycle is monotonic');
END`;

const CREATE_NATIVE_TRANSPORT_LEASES_INSERT_TRIGGER_SQL = `CREATE TRIGGER native_transport_leases_require_fences
BEFORE INSERT ON native_transport_leases
WHEN NOT EXISTS (
  SELECT 1
  FROM native_transport_attachments AS attachment
  JOIN native_binding_incarnations AS binding_incarnation
    ON binding_incarnation.native_binding_incarnation_id = NEW.native_binding_incarnation_id
    AND binding_incarnation.runtime_id = NEW.runtime_id
    AND binding_incarnation.native_incarnation = NEW.native_incarnation
    AND binding_incarnation.native_binding_id = attachment.native_binding_id
  JOIN native_bindings AS binding
    ON binding.native_binding_id = binding_incarnation.native_binding_id
    AND binding.collaboration_server_id = binding_incarnation.collaboration_server_id
    AND binding.logical_chat_id = binding_incarnation.logical_chat_id
  JOIN collaboration_servers AS server
    ON server.collaboration_server_id = binding.collaboration_server_id
  JOIN coordinator_leases AS coordinator
    ON coordinator.coordinator_lease_id = server.current_coordinator_lease_id
    AND coordinator.collaboration_server_id = server.collaboration_server_id
    AND coordinator.coordinator_epoch = server.current_coordinator_epoch
  JOIN runtime_owner_state AS owner
    ON owner.current_runtime_owner_service_lease_id = NEW.runtime_owner_service_lease_id
    AND owner.current_runtime_owner_service_epoch = NEW.runtime_owner_service_epoch
  JOIN runtime_owner_service_leases AS owner_lease
    ON owner_lease.runtime_owner_service_lease_id = owner.current_runtime_owner_service_lease_id
    AND owner_lease.machine_identity_id = owner.machine_identity_id
    AND owner_lease.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
  WHERE attachment.attachment_id = NEW.attachment_id
    AND attachment.state = 'current'
    AND binding_incarnation.state = 'current'
    AND NEW.coordinator_lease_id = server.current_coordinator_lease_id
    AND NEW.coordinator_epoch = server.current_coordinator_epoch
    AND coordinator.state = 'current'
    AND NEW.acquired_at_ms >= coordinator.acquired_at_ms
    AND NEW.acquired_at_ms < coordinator.heartbeat_deadline_ms
    AND owner_lease.state = 'current'
    AND NEW.acquired_at_ms >= owner_lease.acquired_at_ms
    AND NEW.acquired_at_ms < owner_lease.heartbeat_deadline_ms
    AND (
      NEW.transport_epoch = 1
      OR EXISTS (
        SELECT 1 FROM native_transport_leases AS predecessor
        WHERE predecessor.attachment_id = NEW.attachment_id
          AND predecessor.transport_epoch = NEW.transport_epoch - 1
          AND predecessor.state IN ('superseded', 'closed')
          AND predecessor.released_at_ms IS NOT NULL
          AND NEW.acquired_at_ms >= predecessor.released_at_ms
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native transport lease requires exact owner and coordinator fences');
END`;

const CREATE_NATIVE_TRANSPORT_LEASES_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_transport_leases_identity_immutable
BEFORE UPDATE ON native_transport_leases
WHEN NEW.attachment_lease_id IS NOT OLD.attachment_lease_id
  OR NEW.attachment_id IS NOT OLD.attachment_id
  OR NEW.native_binding_incarnation_id IS NOT OLD.native_binding_incarnation_id
  OR NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.native_incarnation IS NOT OLD.native_incarnation
  OR NEW.runtime_owner_service_lease_id IS NOT OLD.runtime_owner_service_lease_id
  OR NEW.runtime_owner_service_epoch IS NOT OLD.runtime_owner_service_epoch
  OR NEW.coordinator_lease_id IS NOT OLD.coordinator_lease_id
  OR NEW.coordinator_epoch IS NOT OLD.coordinator_epoch
  OR NEW.transport_epoch IS NOT OLD.transport_epoch
  OR NEW.acquired_at_ms IS NOT OLD.acquired_at_ms
BEGIN
  SELECT RAISE(ABORT, 'native transport lease identity and fences are immutable');
END`;

const CREATE_NATIVE_TRANSPORT_LEASES_STATE_TRIGGER_SQL = `CREATE TRIGGER native_transport_leases_state_monotonic
BEFORE UPDATE ON native_transport_leases
WHEN NEW.state IS NOT OLD.state OR NEW.released_at_ms IS NOT OLD.released_at_ms
BEGIN
  SELECT CASE WHEN NOT (
    OLD.state = 'current'
    AND NEW.state IN ('superseded', 'closed')
    AND OLD.released_at_ms IS NULL
    AND NEW.released_at_ms IS NOT NULL
  ) THEN RAISE(ABORT, 'native transport lease lifecycle is monotonic') END;
END`;

const CREATE_BINDING_LIFECYCLE_GATES_UPDATE_TRIGGER_SQL = `CREATE TRIGGER binding_lifecycle_gates_transition_monotonic
BEFORE UPDATE ON binding_lifecycle_gates
WHEN NOT (
  NEW.native_binding_id IS OLD.native_binding_id
  AND NEW.collaboration_server_id IS OLD.collaboration_server_id
  AND NEW.logical_chat_id IS OLD.logical_chat_id
  AND NEW.gate_generation = OLD.gate_generation + 1
  AND NEW.updated_at_ms >= OLD.updated_at_ms
  AND (
    NEW.phase = OLD.phase
    OR (OLD.phase = 'starting' AND NEW.phase IN ('recovering', 'ready', 'draining', 'closed'))
    OR (OLD.phase = 'recovering' AND NEW.phase IN ('ready', 'draining', 'closed'))
    OR (OLD.phase = 'ready' AND NEW.phase IN ('recovering', 'draining', 'closed'))
    OR (OLD.phase = 'draining' AND NEW.phase IN ('recovering', 'closed'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'binding lifecycle gate transition is not monotonic');
END`;

function schemaEntry(
  type: HostStateSqliteSchemaEntry["type"],
  name: string,
  tableName: string,
  sql: string,
): HostStateSqliteSchemaEntry {
  return Object.freeze({ type, name, tableName, sql });
}

function retainedRowTriggerEntries(
  tableName: string,
  collisionPredicate: string,
): readonly HostStateSqliteSchemaEntry[] {
  const noDeleteName = `${tableName}_no_delete`;
  const noReplaceName = `${tableName}_no_replace`;
  return Object.freeze([
    schemaEntry(
      "trigger",
      noDeleteName,
      tableName,
      `CREATE TRIGGER ${noDeleteName}\nBEFORE DELETE ON ${tableName}\nBEGIN\n  SELECT RAISE(ABORT, '${tableName} rows are retained');\nEND`,
    ),
    schemaEntry(
      "trigger",
      noReplaceName,
      tableName,
      `CREATE TRIGGER ${noReplaceName}\nBEFORE INSERT ON ${tableName}\nWHEN EXISTS (\n  SELECT 1 FROM ${tableName}\n  WHERE ${collisionPredicate}\n)\nBEGIN\n  SELECT RAISE(ABORT, '${tableName} rows cannot be replaced');\nEND`,
    ),
  ]);
}

function appendOnlyUpdateEntry(tableName: string): HostStateSqliteSchemaEntry {
  const name = `${tableName}_no_update`;
  return schemaEntry(
    "trigger",
    name,
    tableName,
    `CREATE TRIGGER ${name}\nBEFORE UPDATE ON ${tableName}\nBEGIN\n  SELECT RAISE(ABORT, '${tableName} is append-only');\nEND`,
  );
}

const VERSION_FOUR_RETAINED_ROW_ENTRIES: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  ...retainedRowTriggerEntries("runtime_owner_state", "singleton = NEW.singleton"),
  ...retainedRowTriggerEntries(
    "runtime_owner_service_leases",
    `runtime_owner_service_lease_id = NEW.runtime_owner_service_lease_id
    OR (machine_identity_id = NEW.machine_identity_id
      AND runtime_owner_service_epoch = NEW.runtime_owner_service_epoch)`,
  ),
  ...retainedRowTriggerEntries(
    "runtime_owner_journal_entries",
    "journal_offset = NEW.journal_offset OR operation_id = NEW.operation_id",
  ),
  ...retainedRowTriggerEntries(
    "native_runtimes",
    `runtime_id = NEW.runtime_id
    OR (warden_launch_nonce = NEW.warden_launch_nonce
      AND initial_start_identity_schema_id = NEW.initial_start_identity_schema_id
      AND initial_start_identity_digest = NEW.initial_start_identity_digest)`,
  ),
  ...retainedRowTriggerEntries(
    "native_runtime_incarnations",
    "runtime_id = NEW.runtime_id AND native_incarnation = NEW.native_incarnation",
  ),
  ...retainedRowTriggerEntries(
    "runtime_owner_assignments",
    `runtime_owner_assignment_id = NEW.runtime_owner_assignment_id
    OR (runtime_id = NEW.runtime_id
      AND native_incarnation = NEW.native_incarnation
      AND assignment_generation = NEW.assignment_generation)`,
  ),
  ...retainedRowTriggerEntries(
    "native_runtime_containments",
    `native_runtime_containment_id = NEW.native_runtime_containment_id
    OR (runtime_id = NEW.runtime_id
      AND predecessor_native_incarnation = NEW.predecessor_native_incarnation)`,
  ),
  ...retainedRowTriggerEntries(
    "runtime_owner_identity_keys",
    `runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    OR (runtime_id = NEW.runtime_id AND key_generation = NEW.key_generation)`,
  ),
  ...retainedRowTriggerEntries(
    "runtime_owner_private_keys",
    "protected_handle_id = NEW.protected_handle_id",
  ),
  ...retainedRowTriggerEntries(
    "runtime_owner_signature_reservations",
    `runtime_id = NEW.runtime_id
    AND runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    AND runtime_owner_key_generation = NEW.runtime_owner_key_generation
    AND signer_sequence = NEW.signer_sequence`,
  ),
  ...retainedRowTriggerEntries(
    "runtime_owner_signed_record_acceptances",
    `runtime_id = NEW.runtime_id
    AND runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    AND runtime_owner_key_generation = NEW.runtime_owner_key_generation
    AND signer_sequence = NEW.signer_sequence`,
  ),
  ...retainedRowTriggerEntries(
    "local_native_conversations",
    "local_native_conversation_id = NEW.local_native_conversation_id",
  ),
  ...retainedRowTriggerEntries(
    "local_native_conversation_transitions",
    `local_transition_id = NEW.local_transition_id
    OR (runtime_id = NEW.runtime_id
      AND native_incarnation = NEW.native_incarnation
      AND local_transition_seq = NEW.local_transition_seq)`,
  ),
  ...retainedRowTriggerEntries(
    "native_binding_incarnations",
    "native_binding_incarnation_id = NEW.native_binding_incarnation_id",
  ),
  ...retainedRowTriggerEntries(
    "native_transport_attachments",
    `attachment_id = NEW.attachment_id
    OR (native_binding_id = NEW.native_binding_id AND generation = NEW.generation)`,
  ),
  ...retainedRowTriggerEntries(
    "native_transport_leases",
    `attachment_lease_id = NEW.attachment_lease_id
    OR (attachment_id = NEW.attachment_id AND transport_epoch = NEW.transport_epoch)`,
  ),
  ...retainedRowTriggerEntries(
    "binding_lifecycle_gates",
    "native_binding_id = NEW.native_binding_id",
  ),
]);

const VERSION_FOUR_APPEND_ONLY_UPDATE_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    appendOnlyUpdateEntry("runtime_owner_journal_entries"),
    appendOnlyUpdateEntry("runtime_owner_assignments"),
    appendOnlyUpdateEntry("native_runtime_containments"),
    appendOnlyUpdateEntry("runtime_owner_signed_record_acceptances"),
    appendOnlyUpdateEntry("local_native_conversation_transitions"),
  ]);

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

const VERSION_FOUR_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  schemaEntry(
    "table",
    "runtime_owner_state",
    "runtime_owner_state",
    CREATE_RUNTIME_OWNER_STATE_SQL,
  ),
  schemaEntry(
    "table",
    "runtime_owner_service_leases",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_SQL,
  ),
  schemaEntry(
    "table",
    "runtime_owner_journal_entries",
    "runtime_owner_journal_entries",
    CREATE_RUNTIME_OWNER_JOURNAL_ENTRIES_SQL,
  ),
  schemaEntry("table", "native_runtimes", "native_runtimes", CREATE_NATIVE_RUNTIMES_SQL),
  schemaEntry(
    "table",
    "native_runtime_incarnations",
    "native_runtime_incarnations",
    CREATE_NATIVE_RUNTIME_INCARNATIONS_SQL,
  ),
  schemaEntry(
    "table",
    "runtime_owner_assignments",
    "runtime_owner_assignments",
    CREATE_RUNTIME_OWNER_ASSIGNMENTS_SQL,
  ),
  schemaEntry(
    "table",
    "native_runtime_containments",
    "native_runtime_containments",
    CREATE_NATIVE_RUNTIME_CONTAINMENTS_SQL,
  ),
  schemaEntry(
    "table",
    "runtime_owner_identity_keys",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_SQL,
  ),
  schemaEntry(
    "table",
    "runtime_owner_private_keys",
    "runtime_owner_private_keys",
    CREATE_RUNTIME_OWNER_PRIVATE_KEYS_SQL,
  ),
  schemaEntry(
    "table",
    "runtime_owner_signature_reservations",
    "runtime_owner_signature_reservations",
    CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_SQL,
  ),
  schemaEntry(
    "table",
    "runtime_owner_signed_record_acceptances",
    "runtime_owner_signed_record_acceptances",
    CREATE_RUNTIME_OWNER_SIGNED_RECORD_ACCEPTANCES_SQL,
  ),
  schemaEntry(
    "table",
    "local_native_conversations",
    "local_native_conversations",
    CREATE_LOCAL_NATIVE_CONVERSATIONS_SQL,
  ),
  schemaEntry(
    "table",
    "local_native_conversation_transitions",
    "local_native_conversation_transitions",
    CREATE_LOCAL_NATIVE_CONVERSATION_TRANSITIONS_SQL,
  ),
  schemaEntry(
    "table",
    "native_binding_incarnations",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_SQL,
  ),
  schemaEntry(
    "table",
    "native_transport_attachments",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_SQL,
  ),
  schemaEntry(
    "table",
    "native_transport_leases",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_SQL,
  ),
  schemaEntry(
    "table",
    "binding_lifecycle_gates",
    "binding_lifecycle_gates",
    CREATE_BINDING_LIFECYCLE_GATES_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_service_leases_scope_unique",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_service_leases_id_epoch_unique",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_ID_EPOCH_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_service_leases_machine_epoch_unique",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_MACHINE_EPOCH_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_journal_operation_unique",
    "runtime_owner_journal_entries",
    CREATE_RUNTIME_OWNER_JOURNAL_OPERATION_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_runtimes_descriptor_scope_unique",
    "native_runtimes",
    CREATE_NATIVE_RUNTIMES_DESCRIPTOR_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_runtimes_launch_identity_unique",
    "native_runtimes",
    CREATE_NATIVE_RUNTIMES_LAUNCH_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_runtime_incarnations_descriptor_scope_unique",
    "native_runtime_incarnations",
    CREATE_NATIVE_RUNTIME_INCARNATIONS_DESCRIPTOR_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_assignments_scope_unique",
    "runtime_owner_assignments",
    CREATE_RUNTIME_OWNER_ASSIGNMENTS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_assignments_generation_unique",
    "runtime_owner_assignments",
    CREATE_RUNTIME_OWNER_ASSIGNMENTS_GENERATION_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_runtime_containments_predecessor_unique",
    "native_runtime_containments",
    CREATE_NATIVE_RUNTIME_CONTAINMENTS_PREDECESSOR_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_runtime_containments_successor_unique",
    "native_runtime_containments",
    CREATE_NATIVE_RUNTIME_CONTAINMENTS_SUCCESSOR_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_identity_keys_scope_unique",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_identity_keys_generation_unique",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_GENERATION_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_identity_keys_current_unique",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_CURRENT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_private_keys_scope_unique",
    "runtime_owner_private_keys",
    CREATE_RUNTIME_OWNER_PRIVATE_KEYS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_signature_reservations_digest_unique",
    "runtime_owner_signature_reservations",
    CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_DIGEST_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_signature_reservations_signed_digest_unique",
    "runtime_owner_signature_reservations",
    CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_SIGNED_DIGEST_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "runtime_owner_signed_record_acceptances_signed_digest_unique",
    "runtime_owner_signed_record_acceptances",
    CREATE_RUNTIME_OWNER_ACCEPTANCES_SIGNED_DIGEST_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "local_native_conversations_scope_unique",
    "local_native_conversations",
    CREATE_LOCAL_NATIVE_CONVERSATIONS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "local_native_conversations_semantic_unique",
    "local_native_conversations",
    CREATE_LOCAL_NATIVE_CONVERSATIONS_SEMANTIC_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "local_native_conversation_transitions_sequence_unique",
    "local_native_conversation_transitions",
    CREATE_LOCAL_NATIVE_TRANSITIONS_SEQUENCE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_binding_incarnations_scope_unique",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_binding_incarnations_runtime_unique",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_RUNTIME_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_binding_incarnations_current_binding_unique",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_CURRENT_BINDING_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_binding_incarnations_current_semantic_unique",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_CURRENT_SEMANTIC_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_transport_attachments_scope_unique",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_transport_attachments_generation_unique",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_GENERATION_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_transport_attachments_current_unique",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_CURRENT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_transport_leases_attachment_unique",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_ATTACHMENT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_transport_leases_scope_unique",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_SCOPE_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_transport_leases_epoch_unique",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_EPOCH_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "native_transport_leases_current_unique",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_CURRENT_INDEX_SQL,
  ),
  schemaEntry(
    "index",
    "coordinator_leases_id_epoch_unique",
    "coordinator_leases",
    CREATE_COORDINATOR_LEASES_ID_EPOCH_INDEX_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_state_identity_immutable",
    "runtime_owner_state",
    CREATE_RUNTIME_OWNER_STATE_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_state_lease_transition",
    "runtime_owner_state",
    CREATE_RUNTIME_OWNER_STATE_LEASE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_state_journal_offset_transition",
    "runtime_owner_state",
    CREATE_RUNTIME_OWNER_STATE_JOURNAL_OFFSET_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_service_leases_require_successor_epoch",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_INSERT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_service_leases_identity_immutable",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_service_leases_heartbeat_monotonic",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_HEARTBEAT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_service_leases_state_monotonic",
    "runtime_owner_service_leases",
    CREATE_RUNTIME_OWNER_SERVICE_LEASES_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_journal_entries_require_next_offset",
    "runtime_owner_journal_entries",
    CREATE_RUNTIME_OWNER_JOURNAL_OFFSET_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_journal_entries_increment_offset",
    "runtime_owner_journal_entries",
    CREATE_RUNTIME_OWNER_JOURNAL_INCREMENT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_journal_entries_require_subject",
    "runtime_owner_journal_entries",
    CREATE_RUNTIME_OWNER_JOURNAL_SUBJECT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_journal_entries_require_current_owner",
    "runtime_owner_journal_entries",
    CREATE_RUNTIME_OWNER_JOURNAL_FENCE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtimes_identity_immutable",
    "native_runtimes",
    CREATE_NATIVE_RUNTIMES_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtimes_pointer_transition",
    "native_runtimes",
    CREATE_NATIVE_RUNTIMES_POINTER_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtimes_state_monotonic",
    "native_runtimes",
    CREATE_NATIVE_RUNTIMES_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtimes_local_transition_sequence",
    "native_runtimes",
    CREATE_NATIVE_RUNTIMES_TRANSITION_SEQUENCE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtime_incarnations_require_predecessor",
    "native_runtime_incarnations",
    CREATE_NATIVE_RUNTIME_INCARNATIONS_PREDECESSOR_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtime_incarnations_identity_immutable",
    "native_runtime_incarnations",
    CREATE_NATIVE_RUNTIME_INCARNATIONS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtime_incarnations_state_monotonic",
    "native_runtime_incarnations",
    CREATE_NATIVE_RUNTIME_INCARNATIONS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_assignments_require_predecessor",
    "runtime_owner_assignments",
    CREATE_RUNTIME_OWNER_ASSIGNMENTS_PREDECESSOR_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_assignments_require_current_owner",
    "runtime_owner_assignments",
    CREATE_RUNTIME_OWNER_ASSIGNMENTS_FENCE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_runtime_containments_require_current_owner",
    "native_runtime_containments",
    CREATE_NATIVE_RUNTIME_CONTAINMENTS_FENCE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_identity_keys_require_predecessor",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_PREDECESSOR_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_identity_keys_identity_immutable",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_identity_keys_sequence_monotonic",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_SEQUENCE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_identity_keys_state_monotonic",
    "runtime_owner_identity_keys",
    CREATE_RUNTIME_OWNER_IDENTITY_KEYS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_private_keys_identity_immutable",
    "runtime_owner_private_keys",
    CREATE_RUNTIME_OWNER_PRIVATE_KEYS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_private_keys_state_monotonic",
    "runtime_owner_private_keys",
    CREATE_RUNTIME_OWNER_PRIVATE_KEYS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_private_keys_require_unallocated_handle",
    "runtime_owner_private_keys",
    CREATE_RUNTIME_OWNER_PRIVATE_KEYS_HANDLE_COLLISION_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "protected_artifacts_require_non_key_handle",
    "protected_artifacts",
    CREATE_PROTECTED_ARTIFACTS_PRIVATE_KEY_COLLISION_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_signature_reservations_require_current_key",
    "runtime_owner_signature_reservations",
    CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_INSERT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_signature_reservations_increment_sequence",
    "runtime_owner_signature_reservations",
    CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_INCREMENT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_signature_reservations_identity_immutable",
    "runtime_owner_signature_reservations",
    CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_signature_reservations_state_monotonic",
    "runtime_owner_signature_reservations",
    CREATE_RUNTIME_OWNER_SIGNATURE_RESERVATIONS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "runtime_owner_signed_record_acceptances_require_signed",
    "runtime_owner_signed_record_acceptances",
    CREATE_RUNTIME_OWNER_ACCEPTANCES_SIGNED_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "local_native_conversations_identity_immutable",
    "local_native_conversations",
    CREATE_LOCAL_NATIVE_CONVERSATIONS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "local_native_conversations_state_monotonic",
    "local_native_conversations",
    CREATE_LOCAL_NATIVE_CONVERSATIONS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "local_native_conversation_transitions_require_next_sequence",
    "local_native_conversation_transitions",
    CREATE_LOCAL_NATIVE_TRANSITIONS_OFFSET_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "local_native_conversation_transitions_require_current_owner",
    "local_native_conversation_transitions",
    CREATE_LOCAL_NATIVE_TRANSITIONS_FENCE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "local_native_conversation_transitions_increment_sequence",
    "local_native_conversation_transitions",
    CREATE_LOCAL_NATIVE_TRANSITIONS_INCREMENT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_binding_incarnations_require_current_runtime",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_INSERT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_binding_incarnations_identity_immutable",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_binding_incarnations_state_monotonic",
    "native_binding_incarnations",
    CREATE_NATIVE_BINDING_INCARNATIONS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_bindings_require_exact_current_incarnation",
    "native_bindings",
    CREATE_NATIVE_BINDINGS_INCARNATION_POINTER_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_transport_attachments_require_binding_and_predecessor",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_INSERT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_transport_attachments_identity_immutable",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_transport_attachments_lease_transition",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_POINTER_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_transport_attachments_state_monotonic",
    "native_transport_attachments",
    CREATE_NATIVE_TRANSPORT_ATTACHMENTS_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_transport_leases_require_fences",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_INSERT_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_transport_leases_identity_immutable",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_IDENTITY_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "native_transport_leases_state_monotonic",
    "native_transport_leases",
    CREATE_NATIVE_TRANSPORT_LEASES_STATE_TRIGGER_SQL,
  ),
  schemaEntry(
    "trigger",
    "binding_lifecycle_gates_transition_monotonic",
    "binding_lifecycle_gates",
    CREATE_BINDING_LIFECYCLE_GATES_UPDATE_TRIGGER_SQL,
  ),
  ...VERSION_FOUR_RETAINED_ROW_ENTRIES,
  ...VERSION_FOUR_APPEND_ONLY_UPDATE_ENTRIES,
]);

const INSERT_RUNTIME_OWNER_STATE_SQL = `INSERT INTO runtime_owner_state (
  singleton,
  machine_identity_id,
  current_runtime_owner_service_epoch,
  current_runtime_owner_service_lease_id,
  next_journal_offset,
  created_at_ms
)
SELECT singleton, machine_identity_id, 0, NULL, 0, created_at_ms
FROM host_state_metadata
WHERE singleton = 1`;

const VERSION_FOUR_STATEMENTS = Object.freeze([
  ...VERSION_FOUR_SQLITE_SCHEMA_ENTRIES.map((entry) => entry.sql),
  INSERT_RUNTIME_OWNER_STATE_SQL,
]);

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
  Object.freeze({
    version: 4,
    id: "004-runtime-owner-durability",
    statements: VERSION_FOUR_STATEMENTS,
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

const VERSION_FOUR_SQLITE_SCHEMA_MANIFEST: readonly HostStateSqliteSchemaEntry[] = Object.freeze([
  ...VERSION_THREE_SQLITE_SCHEMA_MANIFEST,
  ...VERSION_FOUR_SQLITE_SCHEMA_ENTRIES,
]);

export const HOST_STATE_SQLITE_SCHEMA_MANIFESTS: readonly (readonly HostStateSqliteSchemaEntry[])[] =
  Object.freeze([
    VERSION_ONE_SQLITE_SCHEMA_MANIFEST,
    VERSION_TWO_SQLITE_SCHEMA_MANIFEST,
    VERSION_THREE_SQLITE_SCHEMA_MANIFEST,
    VERSION_FOUR_SQLITE_SCHEMA_MANIFEST,
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
