import type { HostStateSqliteSchemaEntry } from "./migrations.js";

function schemaEntry(
  type: HostStateSqliteSchemaEntry["type"],
  name: string,
  tableName: string,
  sql: string,
): HostStateSqliteSchemaEntry {
  return Object.freeze({ type, name, tableName, sql });
}

const CREATE_NATIVE_REGISTRATION_INTENTS_LEASE_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX native_registration_intents_lease_scope_unique
ON native_registration_intents (
  registration_attempt_id,
  collaboration_server_id,
  native_binding_id
)`;

const CREATE_NATIVE_CONVERSATION_LEASES_SQL = `CREATE TABLE native_conversation_leases (
  native_conversation_lease_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(native_conversation_lease_id) = 28
    AND substr(native_conversation_lease_id, 1, 6) = 'rcncl_'
    AND native_conversation_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
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
  registration_attempt_id TEXT NOT NULL CHECK (
    length(registration_attempt_id) = 27
    AND substr(registration_attempt_id, 1, 5) = 'rcra_'
    AND registration_attempt_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  runtime_id TEXT NOT NULL CHECK (
    length(runtime_id) = 48
    AND substr(runtime_id, 1, 5) = 'rcrt_'
    AND runtime_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_incarnation INTEGER NOT NULL CHECK (
    native_incarnation BETWEEN 1 AND 9007199254740991
  ),
  native_binding_incarnation_id TEXT CHECK (
    native_binding_incarnation_id IS NULL OR (
      length(native_binding_incarnation_id) BETWEEN 1 AND 128
      AND native_binding_incarnation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  attachment_lease_id TEXT CHECK (
    attachment_lease_id IS NULL OR (
      length(attachment_lease_id) BETWEEN 1 AND 128
      AND attachment_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
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
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  protected_port_handle_id TEXT NOT NULL CHECK (
    length(protected_port_handle_id) = 27
    AND substr(protected_port_handle_id, 1, 5) = 'rcph_'
    AND protected_port_handle_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  lease_generation INTEGER NOT NULL CHECK (
    lease_generation BETWEEN 1 AND 9007199254740991
  ),
  supersedes_native_conversation_lease_id TEXT CHECK (
    supersedes_native_conversation_lease_id IS NULL OR (
      length(supersedes_native_conversation_lease_id) = 28
      AND substr(supersedes_native_conversation_lease_id, 1, 6) = 'rcncl_'
      AND supersedes_native_conversation_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  current_publication_id TEXT CHECK (
    current_publication_id IS NULL OR (
      length(current_publication_id) BETWEEN 1 AND 128
      AND current_publication_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  next_operation_sequence INTEGER NOT NULL CHECK (
    next_operation_sequence BETWEEN 1 AND 9007199254740991
  ),
  acquired_at_ms INTEGER NOT NULL CHECK (
    acquired_at_ms BETWEEN 0 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN 0 AND 9007199254740991
  ),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (
    state IN ('starting', 'recovering', 'ready', 'draining', 'closed')
  ),
  CHECK (
    (native_binding_incarnation_id IS NULL) = (attachment_lease_id IS NULL)
  ),
  CHECK (current_publication_id IS NULL OR native_binding_incarnation_id IS NOT NULL),
  CHECK (
    state <> 'ready' OR (
      native_binding_incarnation_id IS NOT NULL
      AND attachment_lease_id IS NOT NULL
      AND current_publication_id IS NOT NULL
    )
  ),
  CHECK ((state = 'closed') = (closed_at_ms IS NOT NULL)),
  CHECK (updated_at_ms >= acquired_at_ms),
  CHECK (closed_at_ms IS NULL OR closed_at_ms = updated_at_ms),
  CHECK (
    (lease_generation = 1) = (supersedes_native_conversation_lease_id IS NULL)
  ),
  CHECK (
    supersedes_native_conversation_lease_id IS NULL
    OR supersedes_native_conversation_lease_id <> native_conversation_lease_id
  ),
  FOREIGN KEY (collaboration_server_id, logical_chat_id, native_binding_id)
    REFERENCES native_bindings (
      collaboration_server_id,
      logical_chat_id,
      native_binding_id
    ),
  FOREIGN KEY (
    registration_attempt_id,
    collaboration_server_id,
    native_binding_id
  ) REFERENCES native_registration_intents (
    registration_attempt_id,
    collaboration_server_id,
    native_binding_id
  ),
  FOREIGN KEY (runtime_id, native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation),
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
  FOREIGN KEY (attachment_lease_id)
    REFERENCES native_transport_leases (attachment_lease_id),
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    ),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    ),
  FOREIGN KEY (supersedes_native_conversation_lease_id)
    REFERENCES native_conversation_leases (native_conversation_lease_id),
  FOREIGN KEY (current_publication_id)
    REFERENCES native_registration_publications (native_registration_publication_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_SQL = `CREATE TABLE native_registration_publications (
  native_registration_publication_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(native_registration_publication_id) BETWEEN 1 AND 128
    AND native_registration_publication_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  native_conversation_lease_id TEXT NOT NULL CHECK (
    length(native_conversation_lease_id) = 28
    AND substr(native_conversation_lease_id, 1, 6) = 'rcncl_'
    AND native_conversation_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
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
  native_binding_incarnation_id TEXT NOT NULL CHECK (
    length(native_binding_incarnation_id) BETWEEN 1 AND 128
    AND native_binding_incarnation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  attachment_lease_id TEXT NOT NULL CHECK (
    length(attachment_lease_id) BETWEEN 1 AND 128
    AND attachment_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  publication_generation INTEGER NOT NULL CHECK (
    publication_generation BETWEEN 1 AND 9007199254740991
  ),
  metadata_schema_id TEXT NOT NULL CHECK (length(metadata_schema_id) BETWEEN 1 AND 1024),
  metadata_ref TEXT NOT NULL CHECK (
    length(metadata_ref) = 27
    AND substr(metadata_ref, 1, 5) = 'rcph_'
    AND metadata_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  metadata_digest TEXT NOT NULL CHECK (
    length(metadata_digest) = 43
    AND metadata_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  capabilities_schema_id TEXT NOT NULL CHECK (
    capabilities_schema_id = 'remote-claw/native-conversation-capabilities/v1'
  ),
  capabilities_ref TEXT NOT NULL CHECK (
    length(capabilities_ref) = 27
    AND substr(capabilities_ref, 1, 5) = 'rcph_'
    AND capabilities_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  capabilities_digest TEXT NOT NULL CHECK (
    length(capabilities_digest) = 43
    AND capabilities_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  published_at_ms INTEGER NOT NULL CHECK (
    published_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'superseded')),
  FOREIGN KEY (native_conversation_lease_id)
    REFERENCES native_conversation_leases (native_conversation_lease_id),
  FOREIGN KEY (native_binding_id) REFERENCES native_bindings (native_binding_id),
  FOREIGN KEY (runtime_id, native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation),
  FOREIGN KEY (native_binding_incarnation_id, runtime_id, native_incarnation)
    REFERENCES native_binding_incarnations (
      native_binding_incarnation_id,
      runtime_id,
      native_incarnation
    ),
  FOREIGN KEY (attachment_lease_id)
    REFERENCES native_transport_leases (attachment_lease_id),
  FOREIGN KEY (metadata_ref) REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (capabilities_ref) REFERENCES protected_artifacts (protected_handle_id)
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_SQL = `CREATE TABLE native_registration_operations (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(operation_id) BETWEEN 1 AND 128
    AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  operation_sequence INTEGER NOT NULL CHECK (
    operation_sequence BETWEEN 1 AND 9007199254740991
  ),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'open',
      'bind',
      'publish',
      'ready',
      'recover',
      'drain',
      'close',
      'reattach'
    )
  ),
  operation_schema_id TEXT NOT NULL CHECK (length(operation_schema_id) BETWEEN 1 AND 1024),
  operation_digest TEXT NOT NULL CHECK (
    length(operation_digest) = 43
    AND operation_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_conversation_lease_id TEXT NOT NULL CHECK (
    length(native_conversation_lease_id) = 28
    AND substr(native_conversation_lease_id, 1, 6) = 'rcncl_'
    AND native_conversation_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_binding_id TEXT NOT NULL CHECK (
    length(native_binding_id) = 27
    AND substr(native_binding_id, 1, 5) = 'rcnb_'
    AND native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
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
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  committed_at_ms INTEGER NOT NULL CHECK (
    committed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (native_conversation_lease_id)
    REFERENCES native_conversation_leases (native_conversation_lease_id),
  FOREIGN KEY (native_binding_id) REFERENCES native_bindings (native_binding_id),
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    ),
  FOREIGN KEY (coordinator_lease_id, coordinator_epoch)
    REFERENCES coordinator_leases (coordinator_lease_id, coordinator_epoch)
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_CONVERSATION_LEASES_BINDING_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX native_conversation_leases_binding_generation_unique
ON native_conversation_leases (
  collaboration_server_id,
  native_binding_id,
  lease_generation
)`;

const CREATE_NATIVE_CONVERSATION_LEASES_ACTIVE_INDEX_SQL = `CREATE UNIQUE INDEX native_conversation_leases_active_binding_unique
ON native_conversation_leases (collaboration_server_id, native_binding_id)
WHERE state <> 'closed'`;

const CREATE_NATIVE_CONVERSATION_LEASES_PORT_INDEX_SQL = `CREATE UNIQUE INDEX native_conversation_leases_port_handle_unique
ON native_conversation_leases (protected_port_handle_id)`;

const CREATE_NATIVE_CONVERSATION_LEASES_PREDECESSOR_INDEX_SQL = `CREATE UNIQUE INDEX native_conversation_leases_predecessor_unique
ON native_conversation_leases (supersedes_native_conversation_lease_id)
WHERE supersedes_native_conversation_lease_id IS NOT NULL`;

const CREATE_NATIVE_CONVERSATION_LEASES_PUBLICATION_INDEX_SQL = `CREATE UNIQUE INDEX native_conversation_leases_current_publication_unique
ON native_conversation_leases (current_publication_id)
WHERE current_publication_id IS NOT NULL`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX native_registration_publications_generation_unique
ON native_registration_publications (
  native_conversation_lease_id,
  publication_generation
)`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX native_registration_publications_current_unique
ON native_registration_publications (native_conversation_lease_id)
WHERE state = 'current'`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_COMMIT_INDEX_SQL = `CREATE INDEX native_registration_operations_lease_commit_index
ON native_registration_operations (
  native_conversation_lease_id,
  committed_at_ms,
  operation_id
)`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_SEQUENCE_INDEX_SQL = `CREATE UNIQUE INDEX native_registration_operations_sequence_unique
ON native_registration_operations (
  native_conversation_lease_id,
  operation_sequence
)`;

const CREATE_NATIVE_CONVERSATION_LEASES_GRAPH_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_exact_graph
BEFORE INSERT ON native_conversation_leases
WHEN NOT EXISTS (
  SELECT 1
  FROM native_registration_intents AS intent
  JOIN native_bindings AS binding
    ON binding.collaboration_server_id = NEW.collaboration_server_id
    AND binding.logical_chat_id = NEW.logical_chat_id
    AND binding.native_binding_id = NEW.native_binding_id
  JOIN native_runtimes AS runtime
    ON runtime.runtime_id = NEW.runtime_id
    AND runtime.current_native_incarnation = NEW.native_incarnation
  JOIN runtime_owner_assignments AS assignment
    ON assignment.runtime_owner_assignment_id =
      runtime.current_runtime_owner_assignment_id
    AND assignment.runtime_id = runtime.runtime_id
    AND assignment.native_incarnation = runtime.current_native_incarnation
  JOIN native_runtime_incarnations AS incarnation
    ON incarnation.runtime_id = NEW.runtime_id
    AND incarnation.native_incarnation = NEW.native_incarnation
  WHERE intent.registration_attempt_id = NEW.registration_attempt_id
    AND intent.collaboration_server_id = NEW.collaboration_server_id
    AND intent.native_binding_id = NEW.native_binding_id
    AND (NEW.lease_generation > 1 OR NEW.state = intent.initial_phase)
    AND binding.descriptor_product = runtime.descriptor_product
    AND binding.descriptor_access = runtime.descriptor_access
    AND binding.state IN ('starting', 'current')
    AND runtime.state = 'current'
    AND assignment.runtime_owner_service_lease_id =
      NEW.runtime_owner_service_lease_id
    AND assignment.runtime_owner_service_epoch = NEW.runtime_owner_service_epoch
    AND incarnation.state IN ('starting', 'current', 'draining')
    AND (
      NEW.native_binding_incarnation_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM native_binding_incarnations AS binding_incarnation
        JOIN native_transport_leases AS attachment_lease
          ON attachment_lease.attachment_lease_id = NEW.attachment_lease_id
          AND attachment_lease.native_binding_incarnation_id =
            binding_incarnation.native_binding_incarnation_id
          AND attachment_lease.runtime_id = binding_incarnation.runtime_id
          AND attachment_lease.native_incarnation = binding_incarnation.native_incarnation
        JOIN native_transport_attachments AS attachment
          ON attachment.attachment_id = attachment_lease.attachment_id
        WHERE binding_incarnation.native_binding_incarnation_id =
            NEW.native_binding_incarnation_id
          AND binding_incarnation.collaboration_server_id = NEW.collaboration_server_id
          AND binding_incarnation.logical_chat_id = NEW.logical_chat_id
          AND binding_incarnation.native_binding_id = NEW.native_binding_id
          AND binding_incarnation.runtime_id = NEW.runtime_id
          AND binding_incarnation.native_incarnation = NEW.native_incarnation
          AND binding_incarnation.state = 'current'
          AND attachment_lease.state = 'current'
          AND attachment.native_binding_id = NEW.native_binding_id
          AND attachment.current_attachment_lease_id = NEW.attachment_lease_id
          AND attachment.state = 'current'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease requires its exact active graph');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_PREDECESSOR_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_exact_predecessor
BEFORE INSERT ON native_conversation_leases
WHEN NOT (
  (NEW.lease_generation = 1
    AND NEW.supersedes_native_conversation_lease_id IS NULL
    AND NEW.state IN ('starting', 'recovering'))
  OR (
    NEW.lease_generation > 1
    AND NEW.state = 'recovering'
    AND EXISTS (
      SELECT 1
      FROM native_conversation_leases AS predecessor
      WHERE predecessor.native_conversation_lease_id =
          NEW.supersedes_native_conversation_lease_id
        AND predecessor.collaboration_server_id = NEW.collaboration_server_id
        AND predecessor.logical_chat_id = NEW.logical_chat_id
        AND predecessor.native_binding_id = NEW.native_binding_id
        AND predecessor.lease_generation = NEW.lease_generation - 1
        AND predecessor.state = 'closed'
        AND predecessor.closed_at_ms IS NOT NULL
        AND predecessor.closed_at_ms <= NEW.acquired_at_ms
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease requires its exact predecessor');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_FENCE_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_current_fences
BEFORE INSERT ON native_conversation_leases
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM runtime_owner_state AS owner
    JOIN runtime_owner_service_leases AS owner_lease
      ON owner_lease.runtime_owner_service_lease_id =
        owner.current_runtime_owner_service_lease_id
      AND owner_lease.machine_identity_id = owner.machine_identity_id
      AND owner_lease.runtime_owner_service_epoch =
        owner.current_runtime_owner_service_epoch
    WHERE owner.singleton = 1
      AND NEW.runtime_owner_service_lease_id =
        owner.current_runtime_owner_service_lease_id
      AND NEW.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
      AND owner_lease.state = 'current'
      AND NEW.acquired_at_ms >= owner_lease.acquired_at_ms
      AND NEW.acquired_at_ms < owner_lease.heartbeat_deadline_ms
  )
  AND EXISTS (
    SELECT 1
    FROM collaboration_servers AS server
    JOIN coordinator_leases AS coordinator_lease
      ON coordinator_lease.coordinator_lease_id = server.current_coordinator_lease_id
      AND coordinator_lease.collaboration_server_id = server.collaboration_server_id
      AND coordinator_lease.coordinator_epoch = server.current_coordinator_epoch
    WHERE server.collaboration_server_id = NEW.collaboration_server_id
      AND NEW.coordinator_lease_id = server.current_coordinator_lease_id
      AND NEW.coordinator_epoch = server.current_coordinator_epoch
      AND coordinator_lease.state = 'current'
      AND NEW.acquired_at_ms >= coordinator_lease.acquired_at_ms
      AND NEW.acquired_at_ms < coordinator_lease.heartbeat_deadline_ms
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease requires unexpired current owner and coordinator fences');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_PORT_COLLISION_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_unallocated_port_handle
BEFORE INSERT ON native_conversation_leases
WHEN EXISTS (
  SELECT 1 FROM protected_artifacts
  WHERE protected_handle_id = NEW.protected_port_handle_id
  UNION ALL
  SELECT 1 FROM runtime_owner_private_keys
  WHERE protected_handle_id = NEW.protected_port_handle_id
  UNION ALL
  SELECT 1 FROM native_conversation_leases
  WHERE protected_port_handle_id = NEW.protected_port_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated and cannot be a callable port');
END`;

const CREATE_PROTECTED_ARTIFACTS_PORT_COLLISION_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_require_non_callable_port_handle
BEFORE INSERT ON protected_artifacts
WHEN EXISTS (
  SELECT 1 FROM native_conversation_leases
  WHERE protected_port_handle_id = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated to a callable port');
END`;

const CREATE_RUNTIME_OWNER_PRIVATE_KEYS_PORT_COLLISION_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_private_keys_require_non_callable_port_handle
BEFORE INSERT ON runtime_owner_private_keys
WHEN EXISTS (
  SELECT 1 FROM native_conversation_leases
  WHERE protected_port_handle_id = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated to a callable port');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_PUBLICATION_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_current_publication
BEFORE UPDATE OF current_publication_id, state ON native_conversation_leases
WHEN NEW.current_publication_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM native_registration_publications AS publication
    WHERE publication.native_registration_publication_id = NEW.current_publication_id
      AND publication.native_conversation_lease_id = NEW.native_conversation_lease_id
      AND publication.native_binding_id = NEW.native_binding_id
      AND publication.runtime_id = NEW.runtime_id
      AND publication.native_incarnation = NEW.native_incarnation
      AND publication.native_binding_incarnation_id =
        NEW.native_binding_incarnation_id
      AND publication.attachment_lease_id = NEW.attachment_lease_id
      AND publication.state = 'current'
  )
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease requires its exact current publication');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_ATTACHMENT_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_exact_attachment
BEFORE UPDATE OF native_binding_incarnation_id, attachment_lease_id
ON native_conversation_leases
WHEN NEW.native_binding_incarnation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM native_binding_incarnations AS binding_incarnation
    JOIN native_transport_leases AS attachment_lease
      ON attachment_lease.attachment_lease_id = NEW.attachment_lease_id
      AND attachment_lease.native_binding_incarnation_id =
        binding_incarnation.native_binding_incarnation_id
      AND attachment_lease.runtime_id = binding_incarnation.runtime_id
      AND attachment_lease.native_incarnation = binding_incarnation.native_incarnation
    JOIN native_transport_attachments AS attachment
      ON attachment.attachment_id = attachment_lease.attachment_id
    WHERE binding_incarnation.native_binding_incarnation_id =
        NEW.native_binding_incarnation_id
      AND binding_incarnation.collaboration_server_id = NEW.collaboration_server_id
      AND binding_incarnation.logical_chat_id = NEW.logical_chat_id
      AND binding_incarnation.native_binding_id = NEW.native_binding_id
      AND binding_incarnation.runtime_id = NEW.runtime_id
      AND binding_incarnation.native_incarnation = NEW.native_incarnation
      AND binding_incarnation.state = 'current'
      AND attachment_lease.state = 'current'
      AND attachment.native_binding_id = NEW.native_binding_id
      AND attachment.current_attachment_lease_id = NEW.attachment_lease_id
      AND attachment.state = 'current'
  )
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease requires its exact active attachment');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_OPERATION_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_correlated_operation
BEFORE UPDATE ON native_conversation_leases
WHEN (
  NEW.native_binding_incarnation_id IS NOT OLD.native_binding_incarnation_id
  OR NEW.attachment_lease_id IS NOT OLD.attachment_lease_id
  OR NEW.current_publication_id IS NOT OLD.current_publication_id
  OR NEW.updated_at_ms IS NOT OLD.updated_at_ms
  OR NEW.closed_at_ms IS NOT OLD.closed_at_ms
  OR NEW.state IS NOT OLD.state
)
AND NOT EXISTS (
  SELECT 1
  FROM native_registration_operations AS operation
  WHERE operation.native_conversation_lease_id = OLD.native_conversation_lease_id
    AND operation.native_binding_id = OLD.native_binding_id
    AND operation.operation_sequence = NEW.next_operation_sequence - 1
    AND operation.committed_at_ms = NEW.updated_at_ms
    AND (
      (
        operation.kind IN ('bind', 'reattach')
        AND OLD.native_binding_incarnation_id IS NULL
        AND NEW.native_binding_incarnation_id IS NOT NULL
        AND OLD.attachment_lease_id IS NULL
        AND NEW.attachment_lease_id IS NOT NULL
        AND NEW.current_publication_id IS OLD.current_publication_id
        AND NEW.state = OLD.state
        AND NEW.closed_at_ms IS OLD.closed_at_ms
      )
      OR (
        operation.kind = 'publish'
        AND NEW.native_binding_incarnation_id IS OLD.native_binding_incarnation_id
        AND NEW.attachment_lease_id IS OLD.attachment_lease_id
        AND NEW.current_publication_id IS NOT OLD.current_publication_id
        AND NEW.current_publication_id IS NOT NULL
        AND NEW.state = OLD.state
        AND NEW.closed_at_ms IS OLD.closed_at_ms
      )
      OR (
        operation.kind = 'ready'
        AND OLD.state <> 'ready'
        AND NEW.state = 'ready'
        AND NEW.native_binding_incarnation_id IS OLD.native_binding_incarnation_id
        AND NEW.attachment_lease_id IS OLD.attachment_lease_id
        AND NEW.current_publication_id IS OLD.current_publication_id
        AND NEW.closed_at_ms IS OLD.closed_at_ms
      )
      OR (
        operation.kind = 'recover'
        AND OLD.state <> 'recovering'
        AND NEW.state = 'recovering'
        AND NEW.native_binding_incarnation_id IS OLD.native_binding_incarnation_id
        AND NEW.attachment_lease_id IS OLD.attachment_lease_id
        AND NEW.current_publication_id IS OLD.current_publication_id
        AND NEW.closed_at_ms IS OLD.closed_at_ms
      )
      OR (
        operation.kind = 'drain'
        AND OLD.state <> 'draining'
        AND NEW.state = 'draining'
        AND NEW.native_binding_incarnation_id IS OLD.native_binding_incarnation_id
        AND NEW.attachment_lease_id IS OLD.attachment_lease_id
        AND NEW.current_publication_id IS OLD.current_publication_id
        AND NEW.closed_at_ms IS OLD.closed_at_ms
      )
      OR (
        operation.kind = 'close'
        AND OLD.state <> 'closed'
        AND NEW.state = 'closed'
        AND NEW.native_binding_incarnation_id IS OLD.native_binding_incarnation_id
        AND NEW.attachment_lease_id IS OLD.attachment_lease_id
        AND NEW.current_publication_id IS OLD.current_publication_id
        AND OLD.closed_at_ms IS NULL
        AND NEW.closed_at_ms = NEW.updated_at_ms
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease update requires its correlated operation');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_identity_immutable
BEFORE UPDATE ON native_conversation_leases
WHEN NEW.native_conversation_lease_id IS NOT OLD.native_conversation_lease_id
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.logical_chat_id IS NOT OLD.logical_chat_id
  OR NEW.native_binding_id IS NOT OLD.native_binding_id
  OR NEW.registration_attempt_id IS NOT OLD.registration_attempt_id
  OR NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.native_incarnation IS NOT OLD.native_incarnation
  OR NEW.runtime_owner_service_lease_id IS NOT OLD.runtime_owner_service_lease_id
  OR NEW.runtime_owner_service_epoch IS NOT OLD.runtime_owner_service_epoch
  OR NEW.coordinator_lease_id IS NOT OLD.coordinator_lease_id
  OR NEW.coordinator_epoch IS NOT OLD.coordinator_epoch
  OR NEW.protected_port_handle_id IS NOT OLD.protected_port_handle_id
  OR NEW.lease_generation IS NOT OLD.lease_generation
  OR NEW.supersedes_native_conversation_lease_id IS NOT
    OLD.supersedes_native_conversation_lease_id
  OR NEW.acquired_at_ms IS NOT OLD.acquired_at_ms
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease identity and fences are immutable');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_STATE_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_state_monotonic
BEFORE UPDATE ON native_conversation_leases
WHEN NOT (
  (
    NEW.next_operation_sequence = OLD.next_operation_sequence + 1
    AND NEW.native_binding_incarnation_id IS OLD.native_binding_incarnation_id
    AND NEW.attachment_lease_id IS OLD.attachment_lease_id
    AND NEW.current_publication_id IS OLD.current_publication_id
    AND NEW.updated_at_ms = OLD.updated_at_ms
    AND NEW.closed_at_ms IS OLD.closed_at_ms
    AND NEW.state = OLD.state
    AND EXISTS (
      SELECT 1
      FROM native_registration_operations AS operation
      WHERE operation.native_conversation_lease_id = OLD.native_conversation_lease_id
        AND operation.operation_sequence = OLD.next_operation_sequence
    )
  )
  OR (
    NEW.next_operation_sequence = OLD.next_operation_sequence
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND (
      NEW.native_binding_incarnation_id IS OLD.native_binding_incarnation_id
      OR (
        OLD.native_binding_incarnation_id IS NULL
        AND NEW.native_binding_incarnation_id IS NOT NULL
      )
    )
    AND (
      NEW.attachment_lease_id IS OLD.attachment_lease_id
      OR (OLD.attachment_lease_id IS NULL AND NEW.attachment_lease_id IS NOT NULL)
    )
    AND (
      NEW.current_publication_id IS OLD.current_publication_id
      OR NEW.current_publication_id IS NOT NULL
    )
    AND (
      NEW.state = OLD.state
      OR (OLD.state = 'starting'
        AND NEW.state IN ('recovering', 'ready', 'draining', 'closed'))
      OR (OLD.state = 'recovering'
        AND NEW.state IN ('ready', 'draining', 'closed'))
      OR (OLD.state = 'ready'
        AND NEW.state IN ('recovering', 'draining', 'closed'))
      OR (OLD.state = 'draining' AND NEW.state IN ('recovering', 'closed'))
    )
    AND (
      (NEW.state <> 'closed' AND NEW.closed_at_ms IS NULL)
      OR (
        NEW.state = 'closed'
        AND OLD.state <> 'closed'
        AND OLD.closed_at_ms IS NULL
        AND NEW.closed_at_ms = NEW.updated_at_ms
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease lifecycle is monotonic');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_no_delete
BEFORE DELETE ON native_conversation_leases
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease rows are retained');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_no_replace
BEFORE INSERT ON native_conversation_leases
WHEN EXISTS (
  SELECT 1 FROM native_conversation_leases
  WHERE native_conversation_lease_id = NEW.native_conversation_lease_id
    OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND native_binding_id = NEW.native_binding_id
      AND lease_generation = NEW.lease_generation
    )
    OR (
      NEW.state <> 'closed'
      AND state <> 'closed'
      AND collaboration_server_id = NEW.collaboration_server_id
      AND native_binding_id = NEW.native_binding_id
    )
    OR protected_port_handle_id = NEW.protected_port_handle_id
    OR (
      NEW.supersedes_native_conversation_lease_id IS NOT NULL
      AND supersedes_native_conversation_lease_id =
        NEW.supersedes_native_conversation_lease_id
    )
    OR (
      NEW.current_publication_id IS NOT NULL
      AND current_publication_id = NEW.current_publication_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native conversation lease rows cannot be replaced');
END`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_GRAPH_TRIGGER_SQL = `CREATE TRIGGER native_registration_publications_require_exact_graph
BEFORE INSERT ON native_registration_publications
WHEN NOT EXISTS (
  SELECT 1
  FROM native_conversation_leases AS lease
  JOIN native_transport_leases AS attachment_lease
    ON attachment_lease.attachment_lease_id = NEW.attachment_lease_id
  JOIN native_transport_attachments AS attachment
    ON attachment.attachment_id = attachment_lease.attachment_id
  JOIN protected_artifacts AS metadata
    ON metadata.protected_handle_id = NEW.metadata_ref
  JOIN protected_artifacts AS capabilities
    ON capabilities.protected_handle_id = NEW.capabilities_ref
  WHERE lease.native_conversation_lease_id = NEW.native_conversation_lease_id
    AND lease.native_binding_id = NEW.native_binding_id
    AND lease.runtime_id = NEW.runtime_id
    AND lease.native_incarnation = NEW.native_incarnation
    AND lease.native_binding_incarnation_id = NEW.native_binding_incarnation_id
    AND lease.attachment_lease_id = NEW.attachment_lease_id
    AND lease.state <> 'closed'
    AND attachment_lease.native_binding_incarnation_id =
      NEW.native_binding_incarnation_id
    AND attachment_lease.runtime_id = NEW.runtime_id
    AND attachment_lease.native_incarnation = NEW.native_incarnation
    AND attachment_lease.state = 'current'
    AND attachment.native_binding_id = NEW.native_binding_id
    AND attachment.current_attachment_lease_id = NEW.attachment_lease_id
    AND attachment.state = 'current'
    AND metadata.kind = 'artifact'
    AND metadata.scope_kind = 'native_binding'
    AND metadata.scope_id = NEW.native_binding_id
    AND metadata.artifact_schema_id =
      'remote-claw/native-registration-metadata-evidence/v1'
    AND metadata.artifact_digest = NEW.metadata_digest
    AND capabilities.kind = 'artifact'
    AND capabilities.scope_kind = 'native_binding'
    AND capabilities.scope_id = NEW.native_binding_id
    AND capabilities.artifact_schema_id = NEW.capabilities_schema_id
    AND capabilities.artifact_digest = NEW.capabilities_digest
    AND NEW.published_at_ms >= lease.acquired_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'native registration publication requires its exact lease and artifacts');
END`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER native_registration_publications_identity_immutable
BEFORE UPDATE ON native_registration_publications
WHEN NEW.native_registration_publication_id IS NOT
    OLD.native_registration_publication_id
  OR NEW.native_conversation_lease_id IS NOT OLD.native_conversation_lease_id
  OR NEW.native_binding_id IS NOT OLD.native_binding_id
  OR NEW.runtime_id IS NOT OLD.runtime_id
  OR NEW.native_incarnation IS NOT OLD.native_incarnation
  OR NEW.native_binding_incarnation_id IS NOT OLD.native_binding_incarnation_id
  OR NEW.attachment_lease_id IS NOT OLD.attachment_lease_id
  OR NEW.publication_generation IS NOT OLD.publication_generation
  OR NEW.metadata_schema_id IS NOT OLD.metadata_schema_id
  OR NEW.metadata_ref IS NOT OLD.metadata_ref
  OR NEW.metadata_digest IS NOT OLD.metadata_digest
  OR NEW.capabilities_schema_id IS NOT OLD.capabilities_schema_id
  OR NEW.capabilities_ref IS NOT OLD.capabilities_ref
  OR NEW.capabilities_digest IS NOT OLD.capabilities_digest
  OR NEW.published_at_ms IS NOT OLD.published_at_ms
BEGIN
  SELECT RAISE(ABORT, 'native registration publication evidence is immutable');
END`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_STATE_TRIGGER_SQL = `CREATE TRIGGER native_registration_publications_state_monotonic
BEFORE UPDATE OF state ON native_registration_publications
WHEN NOT (OLD.state = 'current' AND NEW.state = 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'native registration publication lifecycle is monotonic');
END`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_registration_publications_no_delete
BEFORE DELETE ON native_registration_publications
BEGIN
  SELECT RAISE(ABORT, 'native registration publication rows are retained');
END`;

const CREATE_NATIVE_REGISTRATION_PUBLICATIONS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_registration_publications_no_replace
BEFORE INSERT ON native_registration_publications
WHEN EXISTS (
  SELECT 1 FROM native_registration_publications
  WHERE native_registration_publication_id = NEW.native_registration_publication_id
    OR (
      native_conversation_lease_id = NEW.native_conversation_lease_id
      AND publication_generation = NEW.publication_generation
    )
    OR (
      NEW.state = 'current'
      AND state = 'current'
      AND native_conversation_lease_id = NEW.native_conversation_lease_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native registration publication rows cannot be replaced');
END`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_GRAPH_TRIGGER_SQL = `CREATE TRIGGER native_registration_operations_require_exact_lease
BEFORE INSERT ON native_registration_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM native_conversation_leases AS lease
  WHERE lease.native_conversation_lease_id = NEW.native_conversation_lease_id
    AND lease.native_binding_id = NEW.native_binding_id
    AND lease.state <> 'closed'
    AND NEW.committed_at_ms >= lease.acquired_at_ms
    AND (
      (
        NEW.operation_sequence = 1
        AND (
          (NEW.kind = 'open' AND lease.lease_generation = 1)
          OR (NEW.kind = 'reattach' AND lease.lease_generation > 1)
        )
        AND NEW.committed_at_ms = lease.acquired_at_ms
      )
      OR (
        NEW.operation_sequence > 1
        AND NEW.kind NOT IN ('open', 'reattach')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native registration operation requires its exact lease');
END`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER native_registration_operations_require_next_sequence
BEFORE INSERT ON native_registration_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM native_conversation_leases AS lease
  WHERE lease.native_conversation_lease_id = NEW.native_conversation_lease_id
    AND lease.next_operation_sequence = NEW.operation_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'native registration operation must consume the next lease sequence');
END`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_FENCE_TRIGGER_SQL = `CREATE TRIGGER native_registration_operations_require_current_fences
BEFORE INSERT ON native_registration_operations
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM runtime_owner_state AS owner
    JOIN runtime_owner_service_leases AS owner_lease
      ON owner_lease.runtime_owner_service_lease_id =
        owner.current_runtime_owner_service_lease_id
      AND owner_lease.machine_identity_id = owner.machine_identity_id
      AND owner_lease.runtime_owner_service_epoch =
        owner.current_runtime_owner_service_epoch
    WHERE owner.singleton = 1
      AND NEW.runtime_owner_service_lease_id =
        owner.current_runtime_owner_service_lease_id
      AND NEW.runtime_owner_service_epoch = owner.current_runtime_owner_service_epoch
      AND owner_lease.state = 'current'
      AND NEW.committed_at_ms >= owner_lease.acquired_at_ms
      AND NEW.committed_at_ms < owner_lease.heartbeat_deadline_ms
  )
  AND EXISTS (
    SELECT 1
    FROM native_conversation_leases AS lease
    JOIN collaboration_servers AS server
      ON server.collaboration_server_id = lease.collaboration_server_id
    JOIN coordinator_leases AS coordinator_lease
      ON coordinator_lease.coordinator_lease_id = server.current_coordinator_lease_id
      AND coordinator_lease.collaboration_server_id = server.collaboration_server_id
      AND coordinator_lease.coordinator_epoch = server.current_coordinator_epoch
    WHERE lease.native_conversation_lease_id = NEW.native_conversation_lease_id
      AND NEW.coordinator_lease_id = server.current_coordinator_lease_id
      AND NEW.coordinator_epoch = server.current_coordinator_epoch
      AND coordinator_lease.state = 'current'
      AND NEW.committed_at_ms >= coordinator_lease.acquired_at_ms
      AND NEW.committed_at_ms < coordinator_lease.heartbeat_deadline_ms
      AND (
        NEW.kind = 'close'
        OR (
          NEW.runtime_owner_service_lease_id =
            lease.runtime_owner_service_lease_id
          AND NEW.runtime_owner_service_epoch = lease.runtime_owner_service_epoch
          AND NEW.coordinator_lease_id = lease.coordinator_lease_id
          AND NEW.coordinator_epoch = lease.coordinator_epoch
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native registration operation requires current unexpired fences');
END`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_ADVANCE_TRIGGER_SQL = `CREATE TRIGGER native_registration_operations_advance_sequence
AFTER INSERT ON native_registration_operations
BEGIN
  UPDATE native_conversation_leases
  SET next_operation_sequence = next_operation_sequence + 1
  WHERE native_conversation_lease_id = NEW.native_conversation_lease_id
    AND next_operation_sequence = NEW.operation_sequence;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'native registration operation sequence advance lost its compare-and-swap')
  END;
END`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER native_registration_operations_no_update
BEFORE UPDATE ON native_registration_operations
BEGIN
  SELECT RAISE(ABORT, 'native registration operation ledger is append-only');
END`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_registration_operations_no_delete
BEFORE DELETE ON native_registration_operations
BEGIN
  SELECT RAISE(ABORT, 'native registration operation ledger is append-only');
END`;

const CREATE_NATIVE_REGISTRATION_OPERATIONS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_registration_operations_no_replace
BEFORE INSERT ON native_registration_operations
WHEN EXISTS (
  SELECT 1 FROM native_registration_operations
  WHERE operation_id = NEW.operation_id
    OR (
      native_conversation_lease_id = NEW.native_conversation_lease_id
      AND operation_sequence = NEW.operation_sequence
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native registration operation ledger is append-only');
END`;

export const VERSION_FIVE_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    schemaEntry(
      "index",
      "native_registration_intents_lease_scope_unique",
      "native_registration_intents",
      CREATE_NATIVE_REGISTRATION_INTENTS_LEASE_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "table",
      "native_conversation_leases",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_SQL,
    ),
    schemaEntry(
      "table",
      "native_registration_publications",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_SQL,
    ),
    schemaEntry(
      "table",
      "native_registration_operations",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_SQL,
    ),
    schemaEntry(
      "index",
      "native_conversation_leases_binding_generation_unique",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_BINDING_GENERATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_conversation_leases_active_binding_unique",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_ACTIVE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_conversation_leases_port_handle_unique",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_PORT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_conversation_leases_predecessor_unique",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_PREDECESSOR_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_conversation_leases_current_publication_unique",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_PUBLICATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_registration_publications_generation_unique",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_GENERATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_registration_publications_current_unique",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_CURRENT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_registration_operations_lease_commit_index",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_COMMIT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_registration_operations_sequence_unique",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_SEQUENCE_INDEX_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_require_exact_graph",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_GRAPH_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_require_exact_predecessor",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_PREDECESSOR_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_require_current_fences",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_FENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_require_unallocated_port_handle",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_PORT_COLLISION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "protected_artifacts_require_non_callable_port_handle",
      "protected_artifacts",
      CREATE_PROTECTED_ARTIFACTS_PORT_COLLISION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "runtime_owner_private_keys_require_non_callable_port_handle",
      "runtime_owner_private_keys",
      CREATE_RUNTIME_OWNER_PRIVATE_KEYS_PORT_COLLISION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_require_current_publication",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_PUBLICATION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_require_exact_attachment",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_ATTACHMENT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_identity_immutable",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_IDENTITY_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_state_monotonic",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_STATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_require_correlated_operation",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_OPERATION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_no_delete",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_conversation_leases_no_replace",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_NO_REPLACE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_publications_require_exact_graph",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_GRAPH_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_publications_identity_immutable",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_IDENTITY_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_publications_state_monotonic",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_STATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_publications_no_delete",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_publications_no_replace",
      "native_registration_publications",
      CREATE_NATIVE_REGISTRATION_PUBLICATIONS_NO_REPLACE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_operations_require_exact_lease",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_GRAPH_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_operations_require_next_sequence",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_SEQUENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_operations_require_current_fences",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_FENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_operations_advance_sequence",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_ADVANCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_operations_no_update",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_NO_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_operations_no_delete",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_registration_operations_no_replace",
      "native_registration_operations",
      CREATE_NATIVE_REGISTRATION_OPERATIONS_NO_REPLACE_TRIGGER_SQL,
    ),
  ]);
