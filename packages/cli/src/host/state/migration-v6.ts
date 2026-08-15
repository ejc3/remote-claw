import type { HostStateSqliteSchemaEntry } from "./migrations.js";

function schemaEntry(
  type: HostStateSqliteSchemaEntry["type"],
  name: string,
  tableName: string,
  sql: string,
): HostStateSqliteSchemaEntry {
  return Object.freeze({ type, name, tableName, sql });
}

const CREATE_NATIVE_ROOT_SIGNATURE_ACTIVATION_FENCES_SQL = `CREATE TABLE native_root_signature_activation_fences (
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
  first_eligible_signer_sequence INTEGER NOT NULL CHECK (
    first_eligible_signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation
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

const CREATE_NATIVE_ROOT_ACTIVATION_OPERATIONS_SQL = `CREATE TABLE native_root_activation_operations (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(operation_id) BETWEEN 1 AND 128
    AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  operation_schema_id TEXT NOT NULL CHECK (
    operation_schema_id = 'remote-claw/native-root-activation/v1'
  ),
  operation_digest TEXT NOT NULL CHECK (
    length(operation_digest) = 43
    AND operation_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('activate', 'renew')),
  root_path_certificate_id TEXT NOT NULL CHECK (
    length(root_path_certificate_id) BETWEEN 1 AND 128
    AND root_path_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  expected_prior_root_path_certificate_id TEXT CHECK (
    expected_prior_root_path_certificate_id IS NULL OR (
      length(expected_prior_root_path_certificate_id) BETWEEN 1 AND 128
      AND expected_prior_root_path_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
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
  inward_edge_id TEXT NOT NULL CHECK (
    length(inward_edge_id) = 27
    AND substr(inward_edge_id, 1, 5) = 'rcie_'
    AND inward_edge_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  terminal_topology_generation INTEGER NOT NULL CHECK (
    terminal_topology_generation BETWEEN 1 AND 9007199254740991
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
  attachment_id TEXT NOT NULL CHECK (
    length(attachment_id) BETWEEN 1 AND 128
    AND attachment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  attachment_lease_id TEXT NOT NULL CHECK (
    length(attachment_lease_id) BETWEEN 1 AND 128
    AND attachment_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  transport_epoch INTEGER NOT NULL CHECK (
    transport_epoch BETWEEN 1 AND 9007199254740991
  ),
  native_conversation_lease_id TEXT NOT NULL CHECK (
    length(native_conversation_lease_id) = 28
    AND substr(native_conversation_lease_id, 1, 6) = 'rcncl_'
    AND native_conversation_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_conversation_lease_generation INTEGER NOT NULL CHECK (
    native_conversation_lease_generation BETWEEN 1 AND 9007199254740991
  ),
  native_registration_publication_id TEXT NOT NULL CHECK (
    length(native_registration_publication_id) BETWEEN 1 AND 128
    AND native_registration_publication_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  publication_generation INTEGER NOT NULL CHECK (
    publication_generation BETWEEN 1 AND 9007199254740991
  ),
  binding_gate_generation INTEGER NOT NULL CHECK (
    binding_gate_generation BETWEEN 1 AND 9007199254740991
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
  runtime_owner_identity_key_id TEXT NOT NULL CHECK (
    length(runtime_owner_identity_key_id) BETWEEN 1 AND 128
    AND runtime_owner_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_key_generation INTEGER NOT NULL CHECK (
    runtime_owner_key_generation BETWEEN 1 AND 9007199254740991
  ),
  signer_sequence INTEGER NOT NULL CHECK (
    signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  native_binding_evidence_digest TEXT NOT NULL CHECK (
    length(native_binding_evidence_digest) = 43
    AND native_binding_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
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
  signed_record_digest TEXT CHECK (
    signed_record_digest IS NULL OR (
      length(signed_record_digest) = 43
      AND signed_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  prepared_at_ms INTEGER NOT NULL CHECK (
    prepared_at_ms BETWEEN 0 AND 9007199254740991
  ),
  issued_at_ms INTEGER NOT NULL CHECK (
    issued_at_ms BETWEEN 0 AND 9007199254740991
  ),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN 0 AND 9007199254740991
  ),
  committed_at_ms INTEGER CHECK (
    committed_at_ms IS NULL OR committed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'committed')),
  CHECK (
    (kind = 'activate' AND expected_prior_root_path_certificate_id IS NULL)
    OR (kind = 'renew'
      AND expected_prior_root_path_certificate_id IS NOT NULL
      AND expected_prior_root_path_certificate_id <> root_path_certificate_id)
  ),
  CHECK (prepared_at_ms <= issued_at_ms),
  CHECK (issued_at_ms < expires_at_ms),
  CHECK (expires_at_ms - issued_at_ms <= 300000),
  CHECK (
    (state = 'prepared'
      AND signed_record_digest IS NULL
      AND committed_at_ms IS NULL)
    OR (state = 'committed'
      AND signed_record_digest IS NOT NULL
      AND committed_at_ms IS NOT NULL
      AND issued_at_ms <= committed_at_ms
      AND committed_at_ms < expires_at_ms)
  ),
  FOREIGN KEY (collaboration_server_id, logical_chat_id, native_binding_id)
    REFERENCES native_bindings (
      collaboration_server_id,
      logical_chat_id,
      native_binding_id
    ),
  FOREIGN KEY (collaboration_server_id, logical_chat_id, inward_edge_id)
    REFERENCES inward_collaboration_edges (
      represented_server_id,
      represented_logical_chat_id,
      inward_edge_id
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
  FOREIGN KEY (attachment_lease_id, attachment_id)
    REFERENCES native_transport_leases (attachment_lease_id, attachment_id),
  FOREIGN KEY (native_conversation_lease_id)
    REFERENCES native_conversation_leases (native_conversation_lease_id),
  FOREIGN KEY (native_registration_publication_id)
    REFERENCES native_registration_publications (native_registration_publication_id),
  FOREIGN KEY (canonical_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id),
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
  FOREIGN KEY (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence
  ) REFERENCES runtime_owner_signature_reservations (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence
  ),
  FOREIGN KEY (expected_prior_root_path_certificate_id)
    REFERENCES native_root_certificates (root_path_certificate_id)
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_ROOT_CERTIFICATES_SQL = `CREATE TABLE native_root_certificates (
  root_path_certificate_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(root_path_certificate_id) BETWEEN 1 AND 128
    AND root_path_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  activation_operation_id TEXT NOT NULL CHECK (
    length(activation_operation_id) BETWEEN 1 AND 128
    AND activation_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  activation_operation_digest TEXT NOT NULL CHECK (
    length(activation_operation_digest) = 43
    AND activation_operation_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  expected_prior_root_path_certificate_id TEXT CHECK (
    expected_prior_root_path_certificate_id IS NULL OR (
      length(expected_prior_root_path_certificate_id) BETWEEN 1 AND 128
      AND expected_prior_root_path_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  canonical_payload_schema_id TEXT NOT NULL CHECK (
    canonical_payload_schema_id = 'remote-claw/native-root-certificate/v1'
  ),
  kind TEXT NOT NULL CHECK (kind = 'native-root'),
  terminal_native_binding_id TEXT NOT NULL CHECK (
    length(terminal_native_binding_id) = 27
    AND substr(terminal_native_binding_id, 1, 5) = 'rcnb_'
    AND terminal_native_binding_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  terminal_server_id TEXT NOT NULL CHECK (
    length(terminal_server_id) = 26
    AND substr(terminal_server_id, 1, 4) = 'rcs_'
    AND terminal_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  terminal_logical_chat_id TEXT NOT NULL CHECK (
    length(terminal_logical_chat_id) = 26
    AND substr(terminal_logical_chat_id, 1, 4) = 'rcl_'
    AND terminal_logical_chat_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  terminal_topology_generation INTEGER NOT NULL CHECK (
    terminal_topology_generation BETWEEN 1 AND 9007199254740991
  ),
  native_binding_evidence_digest TEXT NOT NULL CHECK (
    length(native_binding_evidence_digest) = 43
    AND native_binding_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
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
  attachment_lease_id TEXT NOT NULL CHECK (
    length(attachment_lease_id) BETWEEN 1 AND 128
    AND attachment_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  transport_epoch INTEGER NOT NULL CHECK (
    transport_epoch BETWEEN 1 AND 9007199254740991
  ),
  native_conversation_lease_id TEXT NOT NULL CHECK (
    length(native_conversation_lease_id) = 28
    AND substr(native_conversation_lease_id, 1, 6) = 'rcncl_'
    AND native_conversation_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  native_conversation_lease_generation INTEGER NOT NULL CHECK (
    native_conversation_lease_generation BETWEEN 1 AND 9007199254740991
  ),
  native_registration_publication_id TEXT NOT NULL CHECK (
    length(native_registration_publication_id) BETWEEN 1 AND 128
    AND native_registration_publication_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  publication_generation INTEGER NOT NULL CHECK (
    publication_generation BETWEEN 1 AND 9007199254740991
  ),
  binding_gate_generation INTEGER NOT NULL CHECK (
    binding_gate_generation BETWEEN 1 AND 9007199254740991
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
  runtime_owner_identity_key_id TEXT NOT NULL CHECK (
    length(runtime_owner_identity_key_id) BETWEEN 1 AND 128
    AND runtime_owner_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  runtime_owner_key_generation INTEGER NOT NULL CHECK (
    runtime_owner_key_generation BETWEEN 1 AND 9007199254740991
  ),
  signer_sequence INTEGER NOT NULL CHECK (
    signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms BETWEEN 0 AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'Ed25519'),
  canonical_payload_digest_algorithm TEXT NOT NULL CHECK (
    canonical_payload_digest_algorithm = 'SHA-256'
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
  signed_record_digest TEXT NOT NULL CHECK (
    length(signed_record_digest) = 43
    AND signed_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signature TEXT NOT NULL CHECK (
    length(signature) = 86
    AND signature NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  committed_at_ms INTEGER NOT NULL CHECK (
    committed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state = 'activated'),
  CHECK (issued_at_ms < expires_at_ms),
  CHECK (expires_at_ms - issued_at_ms <= 300000),
  CHECK (issued_at_ms <= committed_at_ms AND committed_at_ms < expires_at_ms),
  FOREIGN KEY (activation_operation_id)
    REFERENCES native_root_activation_operations (operation_id),
  FOREIGN KEY (expected_prior_root_path_certificate_id)
    REFERENCES native_root_certificates (root_path_certificate_id),
  FOREIGN KEY (terminal_server_id, terminal_logical_chat_id, terminal_native_binding_id)
    REFERENCES native_bindings (
      collaboration_server_id,
      logical_chat_id,
      native_binding_id
    ),
  FOREIGN KEY (runtime_id, native_incarnation)
    REFERENCES native_runtime_incarnations (runtime_id, native_incarnation),
  FOREIGN KEY (native_binding_incarnation_id, runtime_id, native_incarnation)
    REFERENCES native_binding_incarnations (
      native_binding_incarnation_id,
      runtime_id,
      native_incarnation
    ),
  FOREIGN KEY (attachment_lease_id, attachment_id)
    REFERENCES native_transport_leases (attachment_lease_id, attachment_id),
  FOREIGN KEY (native_conversation_lease_id)
    REFERENCES native_conversation_leases (native_conversation_lease_id),
  FOREIGN KEY (native_registration_publication_id)
    REFERENCES native_registration_publications (native_registration_publication_id),
  FOREIGN KEY (runtime_owner_service_lease_id, runtime_owner_service_epoch)
    REFERENCES runtime_owner_service_leases (
      runtime_owner_service_lease_id,
      runtime_owner_service_epoch
    ),
  FOREIGN KEY (coordinator_lease_id, terminal_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    ),
  FOREIGN KEY (canonical_payload_ref)
    REFERENCES protected_artifacts (protected_handle_id),
  FOREIGN KEY (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence
  ) REFERENCES runtime_owner_signed_record_acceptances (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    signer_sequence
  )
) STRICT, WITHOUT ROWID`;

const CREATE_NATIVE_ROOT_OPERATIONS_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX native_root_activation_operations_digest_unique
ON native_root_activation_operations (operation_digest)`;

const CREATE_NATIVE_ROOT_OPERATIONS_ROOT_INDEX_SQL = `CREATE UNIQUE INDEX native_root_activation_operations_root_unique
ON native_root_activation_operations (root_path_certificate_id)`;

const CREATE_NATIVE_ROOT_OPERATIONS_SIGNER_INDEX_SQL = `CREATE UNIQUE INDEX native_root_activation_operations_signer_unique
ON native_root_activation_operations (
  runtime_id,
  runtime_owner_identity_key_id,
  runtime_owner_key_generation,
  signer_sequence
)`;

const CREATE_NATIVE_ROOT_OPERATIONS_SIGNED_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX native_root_activation_operations_signed_digest_unique
ON native_root_activation_operations (signed_record_digest)
WHERE signed_record_digest IS NOT NULL`;

const CREATE_NATIVE_ROOT_CERTIFICATES_PRIOR_INDEX_SQL = `CREATE UNIQUE INDEX native_root_certificates_prior_unique
ON native_root_certificates (expected_prior_root_path_certificate_id)
WHERE expected_prior_root_path_certificate_id IS NOT NULL`;

const CREATE_NATIVE_ROOT_OPERATIONS_SCOPE_INDEX_SQL = `CREATE INDEX native_root_activation_operations_scope_commit_index
ON native_root_activation_operations (
  collaboration_server_id,
  logical_chat_id,
  inward_edge_id,
  committed_at_ms,
  operation_id
)`;

const CREATE_NATIVE_ROOT_CERTIFICATES_OPERATION_INDEX_SQL = `CREATE UNIQUE INDEX native_root_certificates_operation_unique
ON native_root_certificates (activation_operation_id)`;

const CREATE_NATIVE_ROOT_CERTIFICATES_SIGNER_INDEX_SQL = `CREATE UNIQUE INDEX native_root_certificates_signer_unique
ON native_root_certificates (
  runtime_id,
  runtime_owner_identity_key_id,
  runtime_owner_key_generation,
  signer_sequence
)`;

const CREATE_NATIVE_ROOT_CERTIFICATES_PAYLOAD_INDEX_SQL = `CREATE UNIQUE INDEX native_root_certificates_payload_unique
ON native_root_certificates (canonical_payload_ref)`;

const CREATE_NATIVE_ROOT_CERTIFICATES_SIGNED_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX native_root_certificates_signed_digest_unique
ON native_root_certificates (signed_record_digest)`;

const CREATE_NATIVE_ROOT_CERTIFICATES_SCOPE_INDEX_SQL = `CREATE INDEX native_root_certificates_scope_commit_index
ON native_root_certificates (
  terminal_server_id,
  terminal_logical_chat_id,
  committed_at_ms,
  root_path_certificate_id
)`;

const CREATE_NATIVE_ROOT_OPERATIONS_GRAPH_TRIGGER_SQL = `CREATE TRIGGER native_root_activation_operations_require_exact_graph
BEFORE INSERT ON native_root_activation_operations
WHEN NEW.state <> 'prepared' OR NOT EXISTS (
  SELECT 1
  FROM logical_chats AS chat
  JOIN inward_collaboration_edges AS edge
    ON edge.inward_edge_id = NEW.inward_edge_id
    AND edge.represented_server_id = chat.collaboration_server_id
    AND edge.represented_logical_chat_id = chat.logical_chat_id
  JOIN native_bindings AS binding
    ON binding.native_binding_id = NEW.native_binding_id
    AND binding.collaboration_server_id = chat.collaboration_server_id
    AND binding.logical_chat_id = chat.logical_chat_id
  JOIN native_binding_incarnations AS binding_incarnation
    ON binding_incarnation.native_binding_incarnation_id =
      NEW.native_binding_incarnation_id
    AND binding_incarnation.collaboration_server_id = chat.collaboration_server_id
    AND binding_incarnation.logical_chat_id = chat.logical_chat_id
    AND binding_incarnation.native_binding_id = binding.native_binding_id
    AND binding_incarnation.runtime_id = NEW.runtime_id
    AND binding_incarnation.native_incarnation = NEW.native_incarnation
  JOIN binding_lifecycle_gates AS binding_gate
    ON binding_gate.native_binding_id = binding.native_binding_id
  JOIN native_transport_leases AS attachment_lease
    ON attachment_lease.attachment_lease_id = NEW.attachment_lease_id
    AND attachment_lease.attachment_id = NEW.attachment_id
    AND attachment_lease.native_binding_incarnation_id =
      binding_incarnation.native_binding_incarnation_id
    AND attachment_lease.runtime_id = NEW.runtime_id
    AND attachment_lease.native_incarnation = NEW.native_incarnation
  JOIN native_transport_attachments AS attachment
    ON attachment.attachment_id = NEW.attachment_id
    AND attachment.native_binding_id = binding.native_binding_id
  JOIN native_conversation_leases AS process_lease
    ON process_lease.native_conversation_lease_id =
      NEW.native_conversation_lease_id
    AND process_lease.collaboration_server_id = chat.collaboration_server_id
    AND process_lease.logical_chat_id = chat.logical_chat_id
    AND process_lease.native_binding_id = binding.native_binding_id
    AND process_lease.runtime_id = NEW.runtime_id
    AND process_lease.native_incarnation = NEW.native_incarnation
    AND process_lease.native_binding_incarnation_id =
      binding_incarnation.native_binding_incarnation_id
    AND process_lease.attachment_lease_id = attachment_lease.attachment_lease_id
  JOIN native_registration_publications AS publication
    ON publication.native_registration_publication_id =
      NEW.native_registration_publication_id
    AND publication.native_conversation_lease_id =
      process_lease.native_conversation_lease_id
  JOIN native_runtimes AS runtime
    ON runtime.runtime_id = NEW.runtime_id
    AND runtime.current_native_incarnation = NEW.native_incarnation
  JOIN runtime_owner_assignments AS assignment
    ON assignment.runtime_owner_assignment_id =
      runtime.current_runtime_owner_assignment_id
    AND assignment.runtime_id = runtime.runtime_id
    AND assignment.native_incarnation = runtime.current_native_incarnation
  JOIN native_runtime_incarnations AS incarnation
    ON incarnation.runtime_id = runtime.runtime_id
    AND incarnation.native_incarnation = runtime.current_native_incarnation
  WHERE chat.collaboration_server_id = NEW.collaboration_server_id
    AND chat.logical_chat_id = NEW.logical_chat_id
    AND chat.current_inward_edge_id = NEW.inward_edge_id
    AND chat.current_native_binding_id = NEW.native_binding_id
    AND chat.topology_generation = NEW.terminal_topology_generation
    AND edge.target_kind = 'native-harness'
    AND edge.target_native_binding_id = NEW.native_binding_id
    AND binding.state = 'current'
    AND binding.current_binding_incarnation_id = NEW.native_binding_incarnation_id
    AND binding.semantic_conversation_id IS NOT NULL
    AND binding_incarnation.semantic_conversation_id = binding.semantic_conversation_id
    AND binding_incarnation.state = 'current'
    AND binding_gate.collaboration_server_id = NEW.collaboration_server_id
    AND binding_gate.logical_chat_id = NEW.logical_chat_id
    AND binding_gate.runtime_id = NEW.runtime_id
    AND binding_gate.native_incarnation = NEW.native_incarnation
    AND binding_gate.native_binding_incarnation_id = NEW.native_binding_incarnation_id
    AND binding_gate.attachment_id = NEW.attachment_id
    AND binding_gate.current_attachment_lease_id = NEW.attachment_lease_id
    AND binding_gate.gate_generation = NEW.binding_gate_generation
    AND binding_gate.phase = 'ready'
    AND attachment.state = 'current'
    AND attachment.current_attachment_lease_id = NEW.attachment_lease_id
    AND attachment_lease.transport_epoch = NEW.transport_epoch
    AND attachment_lease.runtime_owner_service_lease_id =
      NEW.runtime_owner_service_lease_id
    AND attachment_lease.runtime_owner_service_epoch =
      NEW.runtime_owner_service_epoch
    AND attachment_lease.coordinator_lease_id = NEW.coordinator_lease_id
    AND attachment_lease.coordinator_epoch = NEW.coordinator_epoch
    AND attachment_lease.state = 'current'
    AND process_lease.lease_generation = NEW.native_conversation_lease_generation
    AND process_lease.current_publication_id = NEW.native_registration_publication_id
    AND process_lease.runtime_owner_service_lease_id =
      NEW.runtime_owner_service_lease_id
    AND process_lease.runtime_owner_service_epoch = NEW.runtime_owner_service_epoch
    AND process_lease.coordinator_lease_id = NEW.coordinator_lease_id
    AND process_lease.coordinator_epoch = NEW.coordinator_epoch
    AND process_lease.state = 'ready'
    AND publication.native_binding_id = NEW.native_binding_id
    AND publication.runtime_id = NEW.runtime_id
    AND publication.native_incarnation = NEW.native_incarnation
    AND publication.native_binding_incarnation_id = NEW.native_binding_incarnation_id
    AND publication.attachment_lease_id = NEW.attachment_lease_id
    AND publication.publication_generation = NEW.publication_generation
    AND publication.state = 'current'
    AND runtime.state = 'current'
    AND incarnation.state = 'current'
    AND assignment.runtime_owner_service_lease_id =
      NEW.runtime_owner_service_lease_id
    AND assignment.runtime_owner_service_epoch = NEW.runtime_owner_service_epoch
    AND (
      (NEW.kind = 'activate'
        AND chat.state = 'recovering'
        AND edge.state = 'installing'
        AND edge.root_path_certificate_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM native_root_certificates AS history
          JOIN native_root_activation_operations AS history_operation
            ON history_operation.operation_id = history.activation_operation_id
          WHERE history.terminal_server_id = NEW.collaboration_server_id
            AND history.terminal_logical_chat_id = NEW.logical_chat_id
            AND history_operation.inward_edge_id = NEW.inward_edge_id
            AND history.state = 'activated'
        ))
      OR (NEW.kind = 'renew'
        AND EXISTS (
          SELECT 1
          FROM native_root_certificates AS prior
          JOIN native_root_activation_operations AS prior_operation
            ON prior_operation.operation_id = prior.activation_operation_id
          WHERE prior.root_path_certificate_id =
              NEW.expected_prior_root_path_certificate_id
            AND prior.terminal_server_id = NEW.collaboration_server_id
            AND prior.terminal_logical_chat_id = NEW.logical_chat_id
            AND prior.terminal_native_binding_id = NEW.native_binding_id
            AND prior_operation.inward_edge_id = NEW.inward_edge_id
            AND prior.state = 'activated'
            AND NOT EXISTS (
              SELECT 1 FROM native_root_certificates AS successor
              WHERE successor.expected_prior_root_path_certificate_id =
                prior.root_path_certificate_id
            )
        )
        AND (
          (chat.state = 'ready'
            AND edge.state = 'current'
            AND edge.root_path_certificate_id =
              NEW.expected_prior_root_path_certificate_id)
          OR (chat.state = 'recovering'
            AND edge.state = 'installing'
            AND edge.root_path_certificate_id IS NULL)
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native root preparation requires its exact ready A1.4 graph and root lineage');
END`;

const CREATE_NATIVE_ROOT_OPERATIONS_EVIDENCE_TRIGGER_SQL = `CREATE TRIGGER native_root_activation_operations_require_exact_evidence
BEFORE INSERT ON native_root_activation_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM protected_artifacts AS payload
  JOIN runtime_owner_signature_reservations AS reservation
    ON reservation.runtime_id = NEW.runtime_id
    AND reservation.runtime_owner_identity_key_id =
      NEW.runtime_owner_identity_key_id
    AND reservation.runtime_owner_key_generation =
      NEW.runtime_owner_key_generation
    AND reservation.signer_sequence = NEW.signer_sequence
  JOIN runtime_owner_identity_keys AS identity_key
    ON identity_key.runtime_id = reservation.runtime_id
    AND identity_key.runtime_owner_identity_key_id =
      reservation.runtime_owner_identity_key_id
    AND identity_key.key_generation = reservation.runtime_owner_key_generation
  WHERE payload.protected_handle_id = NEW.canonical_payload_ref
    AND payload.kind = 'artifact'
    AND payload.scope_kind = 'native_binding'
    AND payload.scope_id = NEW.native_binding_id
    AND payload.artifact_schema_id = 'remote-claw/native-root-certificate/v1'
    AND payload.artifact_digest = NEW.canonical_payload_digest
    AND reservation.purpose = 'native_root'
    AND reservation.canonical_payload_schema_id =
      'remote-claw/native-root-certificate/v1'
    AND reservation.canonical_payload_ref = NEW.canonical_payload_ref
    AND reservation.canonical_payload_digest = NEW.canonical_payload_digest
    AND reservation.state = 'bound'
    AND identity_key.state = 'current'
    AND EXISTS (
      SELECT 1 FROM native_root_signature_activation_fences AS fence
      WHERE fence.runtime_id = NEW.runtime_id
        AND fence.runtime_owner_identity_key_id =
          NEW.runtime_owner_identity_key_id
        AND fence.runtime_owner_key_generation =
          NEW.runtime_owner_key_generation
        AND NEW.signer_sequence >= fence.first_eligible_signer_sequence
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native root preparation requires its binding-scoped payload and exact signer reservation');
END`;

const CREATE_NATIVE_ROOT_SIGNATURE_FENCES_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER native_root_signature_activation_fences_no_update
BEFORE UPDATE ON native_root_signature_activation_fences
BEGIN
  SELECT RAISE(ABORT, 'native root legacy-signature fences are immutable');
END`;

const CREATE_NATIVE_ROOT_SIGNATURE_FENCES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_root_signature_activation_fences_no_delete
BEFORE DELETE ON native_root_signature_activation_fences
BEGIN
  SELECT RAISE(ABORT, 'native root legacy-signature fences are retained');
END`;

const CREATE_NATIVE_ROOT_SIGNATURE_FENCES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_root_signature_activation_fences_no_replace
BEFORE INSERT ON native_root_signature_activation_fences
WHEN EXISTS (
  SELECT 1 FROM native_root_signature_activation_fences
  WHERE runtime_id = NEW.runtime_id
    AND runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    AND runtime_owner_key_generation = NEW.runtime_owner_key_generation
)
BEGIN
  SELECT RAISE(ABORT, 'native root legacy-signature fences cannot be replaced');
END`;

const CREATE_RUNTIME_OWNER_IDENTITY_KEYS_NATIVE_ROOT_FENCE_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_identity_keys_create_native_root_signature_fence
AFTER INSERT ON runtime_owner_identity_keys
BEGIN
  INSERT INTO native_root_signature_activation_fences (
    runtime_id,
    runtime_owner_identity_key_id,
    runtime_owner_key_generation,
    first_eligible_signer_sequence
  ) VALUES (
    NEW.runtime_id,
    NEW.runtime_owner_identity_key_id,
    NEW.key_generation,
    NEW.next_signer_sequence
  );
END`;

const CREATE_NATIVE_ROOT_OPERATIONS_FENCE_TRIGGER_SQL = `CREATE TRIGGER native_root_activation_operations_require_current_fences
BEFORE INSERT ON native_root_activation_operations
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
      AND NEW.prepared_at_ms >= owner_lease.acquired_at_ms
      AND NEW.prepared_at_ms < owner_lease.heartbeat_deadline_ms
      AND owner_lease.released_at_ms IS NULL
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
      AND NEW.prepared_at_ms >= coordinator_lease.acquired_at_ms
      AND NEW.prepared_at_ms < coordinator_lease.heartbeat_deadline_ms
      AND coordinator_lease.released_at_ms IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native root preparation requires current unexpired owner and coordinator fences');
END`;

const CREATE_NATIVE_ROOT_OPERATIONS_UPDATE_TRIGGER_SQL = `CREATE TRIGGER native_root_activation_operations_finalize_only
BEFORE UPDATE ON native_root_activation_operations
WHEN NOT (
  OLD.state = 'prepared'
  AND NEW.state = 'committed'
  AND OLD.operation_id IS NEW.operation_id
  AND OLD.operation_schema_id IS NEW.operation_schema_id
  AND OLD.operation_digest IS NEW.operation_digest
  AND OLD.kind IS NEW.kind
  AND OLD.root_path_certificate_id IS NEW.root_path_certificate_id
  AND OLD.expected_prior_root_path_certificate_id IS
    NEW.expected_prior_root_path_certificate_id
  AND OLD.collaboration_server_id IS NEW.collaboration_server_id
  AND OLD.logical_chat_id IS NEW.logical_chat_id
  AND OLD.inward_edge_id IS NEW.inward_edge_id
  AND OLD.terminal_topology_generation IS NEW.terminal_topology_generation
  AND OLD.native_binding_id IS NEW.native_binding_id
  AND OLD.runtime_id IS NEW.runtime_id
  AND OLD.native_incarnation IS NEW.native_incarnation
  AND OLD.native_binding_incarnation_id IS NEW.native_binding_incarnation_id
  AND OLD.attachment_id IS NEW.attachment_id
  AND OLD.attachment_lease_id IS NEW.attachment_lease_id
  AND OLD.transport_epoch IS NEW.transport_epoch
  AND OLD.native_conversation_lease_id IS NEW.native_conversation_lease_id
  AND OLD.native_conversation_lease_generation IS
    NEW.native_conversation_lease_generation
  AND OLD.native_registration_publication_id IS
    NEW.native_registration_publication_id
  AND OLD.publication_generation IS NEW.publication_generation
  AND OLD.binding_gate_generation IS NEW.binding_gate_generation
  AND OLD.runtime_owner_service_lease_id IS NEW.runtime_owner_service_lease_id
  AND OLD.runtime_owner_service_epoch IS NEW.runtime_owner_service_epoch
  AND OLD.coordinator_lease_id IS NEW.coordinator_lease_id
  AND OLD.coordinator_epoch IS NEW.coordinator_epoch
  AND OLD.runtime_owner_identity_key_id IS NEW.runtime_owner_identity_key_id
  AND OLD.runtime_owner_key_generation IS NEW.runtime_owner_key_generation
  AND OLD.signer_sequence IS NEW.signer_sequence
  AND OLD.native_binding_evidence_digest IS NEW.native_binding_evidence_digest
  AND OLD.canonical_payload_ref IS NEW.canonical_payload_ref
  AND OLD.canonical_payload_digest IS NEW.canonical_payload_digest
  AND OLD.signed_record_digest IS NULL
  AND NEW.signed_record_digest IS NOT NULL
  AND OLD.prepared_at_ms IS NEW.prepared_at_ms
  AND OLD.issued_at_ms IS NEW.issued_at_ms
  AND OLD.expires_at_ms IS NEW.expires_at_ms
  AND OLD.committed_at_ms IS NULL
  AND NEW.committed_at_ms IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM native_root_certificates AS certificate
    WHERE certificate.activation_operation_id = OLD.operation_id
      AND certificate.root_path_certificate_id = OLD.root_path_certificate_id
      AND certificate.signed_record_digest = NEW.signed_record_digest
      AND certificate.committed_at_ms = NEW.committed_at_ms
      AND certificate.state = 'activated'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native root activation operation is immutable except for certificate finalization');
END`;

const CREATE_NATIVE_ROOT_OPERATIONS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_root_activation_operations_no_delete
BEFORE DELETE ON native_root_activation_operations
BEGIN
  SELECT RAISE(ABORT, 'native root activation operation ledger is retained');
END`;

const CREATE_NATIVE_ROOT_OPERATIONS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_root_activation_operations_no_replace
BEFORE INSERT ON native_root_activation_operations
WHEN EXISTS (
  SELECT 1 FROM native_root_activation_operations
  WHERE operation_id = NEW.operation_id
    OR operation_digest = NEW.operation_digest
    OR root_path_certificate_id = NEW.root_path_certificate_id
    OR (
      runtime_id = NEW.runtime_id
      AND runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
      AND runtime_owner_key_generation = NEW.runtime_owner_key_generation
      AND signer_sequence = NEW.signer_sequence
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native root activation operation ledger cannot be replaced');
END`;

const CREATE_NATIVE_ROOT_CERTIFICATES_OPERATION_TRIGGER_SQL = `CREATE TRIGGER native_root_certificates_require_prepared_operation
BEFORE INSERT ON native_root_certificates
WHEN NOT EXISTS (
  SELECT 1 FROM native_root_activation_operations AS operation
  WHERE operation.operation_id = NEW.activation_operation_id
    AND operation.operation_digest = NEW.activation_operation_digest
    AND operation.root_path_certificate_id = NEW.root_path_certificate_id
    AND operation.expected_prior_root_path_certificate_id IS
      NEW.expected_prior_root_path_certificate_id
    AND operation.collaboration_server_id = NEW.terminal_server_id
    AND operation.logical_chat_id = NEW.terminal_logical_chat_id
    AND operation.terminal_topology_generation = NEW.terminal_topology_generation
    AND operation.native_binding_id = NEW.terminal_native_binding_id
    AND operation.runtime_id = NEW.runtime_id
    AND operation.native_incarnation = NEW.native_incarnation
    AND operation.native_binding_incarnation_id = NEW.native_binding_incarnation_id
    AND operation.attachment_id = NEW.attachment_id
    AND operation.attachment_lease_id = NEW.attachment_lease_id
    AND operation.transport_epoch = NEW.transport_epoch
    AND operation.native_conversation_lease_id = NEW.native_conversation_lease_id
    AND operation.native_conversation_lease_generation =
      NEW.native_conversation_lease_generation
    AND operation.native_registration_publication_id =
      NEW.native_registration_publication_id
    AND operation.publication_generation = NEW.publication_generation
    AND operation.binding_gate_generation = NEW.binding_gate_generation
    AND operation.runtime_owner_service_lease_id =
      NEW.runtime_owner_service_lease_id
    AND operation.runtime_owner_service_epoch = NEW.runtime_owner_service_epoch
    AND operation.coordinator_lease_id = NEW.coordinator_lease_id
    AND operation.coordinator_epoch = NEW.coordinator_epoch
    AND operation.runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
    AND operation.runtime_owner_key_generation = NEW.runtime_owner_key_generation
    AND operation.signer_sequence = NEW.signer_sequence
    AND operation.native_binding_evidence_digest = NEW.native_binding_evidence_digest
    AND operation.canonical_payload_ref = NEW.canonical_payload_ref
    AND operation.canonical_payload_digest = NEW.canonical_payload_digest
    AND operation.issued_at_ms = NEW.issued_at_ms
    AND operation.expires_at_ms = NEW.expires_at_ms
    AND operation.signed_record_digest IS NULL
    AND operation.committed_at_ms IS NULL
    AND operation.state = 'prepared'
)
BEGIN
  SELECT RAISE(ABORT, 'native root certificate requires its exact prepared activation operation');
END`;

const CREATE_NATIVE_ROOT_CERTIFICATES_EVIDENCE_TRIGGER_SQL = `CREATE TRIGGER native_root_certificates_require_signed_evidence
BEFORE INSERT ON native_root_certificates
WHEN NOT EXISTS (
  SELECT 1
  FROM runtime_owner_signature_reservations AS reservation
  JOIN runtime_owner_signed_record_acceptances AS acceptance
    ON acceptance.runtime_id = reservation.runtime_id
    AND acceptance.runtime_owner_identity_key_id =
      reservation.runtime_owner_identity_key_id
    AND acceptance.runtime_owner_key_generation =
      reservation.runtime_owner_key_generation
    AND acceptance.signer_sequence = reservation.signer_sequence
    AND acceptance.signed_record_digest = reservation.signed_record_digest
  JOIN runtime_owner_identity_keys AS identity_key
    ON identity_key.runtime_id = reservation.runtime_id
    AND identity_key.runtime_owner_identity_key_id =
      reservation.runtime_owner_identity_key_id
    AND identity_key.key_generation = reservation.runtime_owner_key_generation
  JOIN protected_artifacts AS payload
    ON payload.protected_handle_id = NEW.canonical_payload_ref
  WHERE reservation.runtime_id = NEW.runtime_id
    AND reservation.runtime_owner_identity_key_id =
      NEW.runtime_owner_identity_key_id
    AND reservation.runtime_owner_key_generation = NEW.runtime_owner_key_generation
    AND reservation.signer_sequence = NEW.signer_sequence
    AND reservation.purpose = 'native_root'
    AND reservation.canonical_payload_schema_id = NEW.canonical_payload_schema_id
    AND reservation.canonical_payload_ref = NEW.canonical_payload_ref
    AND reservation.canonical_payload_digest = NEW.canonical_payload_digest
    AND reservation.signed_record_digest = NEW.signed_record_digest
    AND reservation.signature = NEW.signature
    AND reservation.signed_artifact_id = NEW.root_path_certificate_id
    AND reservation.state = 'signed'
    AND acceptance.accepted_at_ms >= NEW.issued_at_ms
    AND acceptance.accepted_at_ms <= NEW.committed_at_ms
    AND identity_key.state = 'current'
    AND payload.kind = 'artifact'
    AND payload.scope_kind = 'native_binding'
    AND payload.scope_id = NEW.terminal_native_binding_id
    AND payload.artifact_schema_id = NEW.canonical_payload_schema_id
    AND payload.artifact_digest = NEW.canonical_payload_digest
)
BEGIN
  SELECT RAISE(ABORT, 'native root certificate requires its exact accepted owner signature and protected payload');
END`;

const CREATE_NATIVE_ROOT_CERTIFICATES_FENCE_TRIGGER_SQL = `CREATE TRIGGER native_root_certificates_require_current_fences
BEFORE INSERT ON native_root_certificates
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
      AND owner_lease.released_at_ms IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM collaboration_servers AS server
    JOIN coordinator_leases AS coordinator_lease
      ON coordinator_lease.coordinator_lease_id = server.current_coordinator_lease_id
      AND coordinator_lease.collaboration_server_id = server.collaboration_server_id
      AND coordinator_lease.coordinator_epoch = server.current_coordinator_epoch
    WHERE server.collaboration_server_id = NEW.terminal_server_id
      AND NEW.coordinator_lease_id = server.current_coordinator_lease_id
      AND NEW.coordinator_epoch = server.current_coordinator_epoch
      AND coordinator_lease.state = 'current'
      AND NEW.committed_at_ms >= coordinator_lease.acquired_at_ms
      AND NEW.committed_at_ms < coordinator_lease.heartbeat_deadline_ms
      AND coordinator_lease.released_at_ms IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM native_root_activation_operations AS operation
    JOIN logical_chats AS chat
      ON chat.collaboration_server_id = operation.collaboration_server_id
      AND chat.logical_chat_id = operation.logical_chat_id
    JOIN inward_collaboration_edges AS edge
      ON edge.inward_edge_id = operation.inward_edge_id
      AND edge.represented_server_id = operation.collaboration_server_id
      AND edge.represented_logical_chat_id = operation.logical_chat_id
    JOIN native_bindings AS binding
      ON binding.native_binding_id = operation.native_binding_id
      AND binding.collaboration_server_id = operation.collaboration_server_id
      AND binding.logical_chat_id = operation.logical_chat_id
    JOIN native_binding_incarnations AS binding_incarnation
      ON binding_incarnation.native_binding_incarnation_id =
        operation.native_binding_incarnation_id
      AND binding_incarnation.collaboration_server_id = operation.collaboration_server_id
      AND binding_incarnation.logical_chat_id = operation.logical_chat_id
      AND binding_incarnation.native_binding_id = operation.native_binding_id
      AND binding_incarnation.runtime_id = operation.runtime_id
      AND binding_incarnation.native_incarnation = operation.native_incarnation
    JOIN binding_lifecycle_gates AS binding_gate
      ON binding_gate.native_binding_id = operation.native_binding_id
    JOIN native_transport_leases AS attachment_lease
      ON attachment_lease.attachment_lease_id = operation.attachment_lease_id
      AND attachment_lease.attachment_id = operation.attachment_id
      AND attachment_lease.native_binding_incarnation_id =
        operation.native_binding_incarnation_id
      AND attachment_lease.runtime_id = operation.runtime_id
      AND attachment_lease.native_incarnation = operation.native_incarnation
    JOIN native_transport_attachments AS attachment
      ON attachment.attachment_id = operation.attachment_id
      AND attachment.native_binding_id = operation.native_binding_id
    JOIN native_conversation_leases AS process_lease
      ON process_lease.native_conversation_lease_id =
        operation.native_conversation_lease_id
    JOIN native_registration_publications AS publication
      ON publication.native_registration_publication_id =
        operation.native_registration_publication_id
    JOIN native_runtimes AS runtime
      ON runtime.runtime_id = operation.runtime_id
      AND runtime.current_native_incarnation = operation.native_incarnation
    JOIN runtime_owner_assignments AS assignment
      ON assignment.runtime_owner_assignment_id =
        runtime.current_runtime_owner_assignment_id
      AND assignment.runtime_id = runtime.runtime_id
      AND assignment.native_incarnation = runtime.current_native_incarnation
    JOIN native_runtime_incarnations AS incarnation
      ON incarnation.runtime_id = runtime.runtime_id
      AND incarnation.native_incarnation = runtime.current_native_incarnation
    WHERE operation.operation_id = NEW.activation_operation_id
      AND chat.current_inward_edge_id = operation.inward_edge_id
      AND chat.current_native_binding_id = operation.native_binding_id
      AND chat.topology_generation = operation.terminal_topology_generation
      AND edge.target_kind = 'native-harness'
      AND edge.target_native_binding_id = operation.native_binding_id
      AND binding.state = 'current'
      AND binding.current_binding_incarnation_id =
        operation.native_binding_incarnation_id
      AND binding.semantic_conversation_id IS NOT NULL
      AND binding_incarnation.semantic_conversation_id = binding.semantic_conversation_id
      AND binding_incarnation.state = 'current'
      AND binding_gate.phase = 'ready'
      AND binding_gate.gate_generation = operation.binding_gate_generation
      AND binding_gate.collaboration_server_id = operation.collaboration_server_id
      AND binding_gate.logical_chat_id = operation.logical_chat_id
      AND binding_gate.runtime_id = operation.runtime_id
      AND binding_gate.native_incarnation = operation.native_incarnation
      AND binding_gate.native_binding_incarnation_id =
        operation.native_binding_incarnation_id
      AND binding_gate.attachment_id = operation.attachment_id
      AND binding_gate.current_attachment_lease_id = operation.attachment_lease_id
      AND attachment.state = 'current'
      AND attachment.current_attachment_lease_id = operation.attachment_lease_id
      AND attachment_lease.state = 'current'
      AND attachment_lease.transport_epoch = operation.transport_epoch
      AND attachment_lease.runtime_owner_service_lease_id =
        operation.runtime_owner_service_lease_id
      AND attachment_lease.runtime_owner_service_epoch =
        operation.runtime_owner_service_epoch
      AND attachment_lease.coordinator_lease_id = operation.coordinator_lease_id
      AND attachment_lease.coordinator_epoch = operation.coordinator_epoch
      AND process_lease.state = 'ready'
      AND process_lease.collaboration_server_id = operation.collaboration_server_id
      AND process_lease.logical_chat_id = operation.logical_chat_id
      AND process_lease.native_binding_id = operation.native_binding_id
      AND process_lease.runtime_id = operation.runtime_id
      AND process_lease.native_incarnation = operation.native_incarnation
      AND process_lease.native_binding_incarnation_id =
        operation.native_binding_incarnation_id
      AND process_lease.attachment_lease_id = operation.attachment_lease_id
      AND process_lease.lease_generation =
        operation.native_conversation_lease_generation
      AND process_lease.current_publication_id =
        operation.native_registration_publication_id
      AND process_lease.runtime_owner_service_lease_id =
        operation.runtime_owner_service_lease_id
      AND process_lease.runtime_owner_service_epoch =
        operation.runtime_owner_service_epoch
      AND process_lease.coordinator_lease_id = operation.coordinator_lease_id
      AND process_lease.coordinator_epoch = operation.coordinator_epoch
      AND publication.state = 'current'
      AND publication.native_conversation_lease_id =
        operation.native_conversation_lease_id
      AND publication.native_binding_id = operation.native_binding_id
      AND publication.runtime_id = operation.runtime_id
      AND publication.native_incarnation = operation.native_incarnation
      AND publication.native_binding_incarnation_id =
        operation.native_binding_incarnation_id
      AND publication.attachment_lease_id = operation.attachment_lease_id
      AND publication.publication_generation = operation.publication_generation
      AND runtime.state = 'current'
      AND incarnation.state = 'current'
      AND assignment.runtime_owner_service_lease_id =
        operation.runtime_owner_service_lease_id
      AND assignment.runtime_owner_service_epoch =
        operation.runtime_owner_service_epoch
      AND (
        (operation.kind = 'activate'
          AND chat.state = 'recovering'
          AND edge.state = 'installing'
          AND edge.root_path_certificate_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM native_root_certificates AS history
            JOIN native_root_activation_operations AS history_operation
              ON history_operation.operation_id = history.activation_operation_id
            WHERE history.terminal_server_id = operation.collaboration_server_id
              AND history.terminal_logical_chat_id = operation.logical_chat_id
              AND history_operation.inward_edge_id = operation.inward_edge_id
              AND history.state = 'activated'
          ))
        OR (operation.kind = 'renew'
          AND EXISTS (
            SELECT 1
            FROM native_root_certificates AS prior
            JOIN native_root_activation_operations AS prior_operation
              ON prior_operation.operation_id = prior.activation_operation_id
            WHERE prior.root_path_certificate_id =
                operation.expected_prior_root_path_certificate_id
              AND prior.terminal_server_id = operation.collaboration_server_id
              AND prior.terminal_logical_chat_id = operation.logical_chat_id
              AND prior.terminal_native_binding_id = operation.native_binding_id
              AND prior_operation.inward_edge_id = operation.inward_edge_id
              AND prior.state = 'activated'
              AND NOT EXISTS (
                SELECT 1 FROM native_root_certificates AS successor
                WHERE successor.expected_prior_root_path_certificate_id =
                  prior.root_path_certificate_id
              )
          )
          AND (
            (chat.state = 'ready'
              AND edge.state = 'current'
              AND edge.root_path_certificate_id =
                operation.expected_prior_root_path_certificate_id)
            OR (chat.state = 'recovering'
              AND edge.state = 'installing'
              AND edge.root_path_certificate_id IS NULL)
          ))
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'native root certificate finalization requires current graph and unexpired fences');
END`;

const CREATE_NATIVE_ROOT_CERTIFICATES_FINALIZE_TRIGGER_SQL = `CREATE TRIGGER native_root_certificates_finalize_activation
AFTER INSERT ON native_root_certificates
BEGIN
  UPDATE native_root_activation_operations
  SET signed_record_digest = NEW.signed_record_digest,
      committed_at_ms = NEW.committed_at_ms,
      state = 'committed'
  WHERE operation_id = NEW.activation_operation_id
    AND state = 'prepared';
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'native root activation operation finalization lost its compare-and-swap')
  END;

  UPDATE inward_collaboration_edges
  SET root_path_certificate_id = NEW.root_path_certificate_id,
      state = 'current'
  WHERE inward_edge_id = (
      SELECT inward_edge_id FROM native_root_activation_operations
      WHERE operation_id = NEW.activation_operation_id
    )
    AND target_kind = 'native-harness'
    AND target_native_binding_id = NEW.terminal_native_binding_id
    AND (
      (NEW.expected_prior_root_path_certificate_id IS NULL
        AND state = 'installing'
        AND root_path_certificate_id IS NULL)
      OR (NEW.expected_prior_root_path_certificate_id IS NOT NULL
        AND (
          (state = 'current'
            AND root_path_certificate_id = NEW.expected_prior_root_path_certificate_id)
          OR (state = 'installing' AND root_path_certificate_id IS NULL)
        ))
    );
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'native root activation lost its inward-edge compare-and-swap')
  END;

  UPDATE logical_chats
  SET state = 'ready'
  WHERE collaboration_server_id = NEW.terminal_server_id
    AND logical_chat_id = NEW.terminal_logical_chat_id
    AND current_inward_edge_id = (
      SELECT inward_edge_id FROM native_root_activation_operations
      WHERE operation_id = NEW.activation_operation_id
    )
    AND current_native_binding_id = NEW.terminal_native_binding_id
    AND topology_generation = NEW.terminal_topology_generation
    AND state IN ('recovering', 'ready');
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'native root activation lost its logical-chat compare-and-swap')
  END;
END`;

const CREATE_NATIVE_ROOT_CERTIFICATES_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER native_root_certificates_no_update
BEFORE UPDATE ON native_root_certificates
BEGIN
  SELECT RAISE(ABORT, 'native root certificates are immutable');
END`;

const CREATE_NATIVE_ROOT_CERTIFICATES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER native_root_certificates_no_delete
BEFORE DELETE ON native_root_certificates
BEGIN
  SELECT RAISE(ABORT, 'native root certificates are retained');
END`;

const CREATE_NATIVE_ROOT_CERTIFICATES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER native_root_certificates_no_replace
BEFORE INSERT ON native_root_certificates
WHEN EXISTS (
  SELECT 1 FROM native_root_certificates
  WHERE root_path_certificate_id = NEW.root_path_certificate_id
    OR activation_operation_id = NEW.activation_operation_id
    OR canonical_payload_ref = NEW.canonical_payload_ref
    OR signed_record_digest = NEW.signed_record_digest
    OR (NEW.expected_prior_root_path_certificate_id IS NOT NULL
      AND expected_prior_root_path_certificate_id =
        NEW.expected_prior_root_path_certificate_id)
    OR (
      runtime_id = NEW.runtime_id
      AND runtime_owner_identity_key_id = NEW.runtime_owner_identity_key_id
      AND runtime_owner_key_generation = NEW.runtime_owner_key_generation
      AND signer_sequence = NEW.signer_sequence
    )
)
BEGIN
  SELECT RAISE(ABORT, 'native root certificates cannot be replaced');
END`;

const CREATE_INWARD_EDGES_ROOT_ACTIVATION_TRIGGER_SQL = `CREATE TRIGGER inward_collaboration_edges_require_native_root_activation
BEFORE UPDATE OF root_path_certificate_id, state ON inward_collaboration_edges
WHEN NEW.target_kind = 'native-harness'
  AND NEW.root_path_certificate_id IS NOT NULL
  AND (
    NEW.root_path_certificate_id IS NOT OLD.root_path_certificate_id
    OR (OLD.state = 'installing' AND NEW.state = 'current')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM native_root_certificates AS certificate
    JOIN native_root_activation_operations AS operation
      ON operation.operation_id = certificate.activation_operation_id
    WHERE operation.inward_edge_id = OLD.inward_edge_id
      AND operation.collaboration_server_id = OLD.represented_server_id
      AND operation.logical_chat_id = OLD.represented_logical_chat_id
      AND operation.native_binding_id = OLD.target_native_binding_id
      AND certificate.root_path_certificate_id = NEW.root_path_certificate_id
      AND certificate.state = 'activated'
      AND operation.state = 'committed'
      AND (
        (operation.kind = 'activate'
          AND OLD.state = 'installing'
          AND OLD.root_path_certificate_id IS NULL)
        OR (operation.kind = 'renew'
          AND (
            (OLD.state = 'current'
              AND OLD.root_path_certificate_id =
                operation.expected_prior_root_path_certificate_id)
            OR (OLD.state = 'installing' AND OLD.root_path_certificate_id IS NULL)
          ))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'native inward-edge rooting requires its committed activation fact');
END`;

const CREATE_INWARD_EDGES_ROOT_INSERT_TRIGGER_SQL = `CREATE TRIGGER inward_collaboration_edges_require_unrooted_native_insert
BEFORE INSERT ON inward_collaboration_edges
WHEN NEW.target_kind = 'native-harness'
  AND (NEW.state <> 'installing' OR NEW.root_path_certificate_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'native inward edges must be inserted unrooted for later activation');
END`;

const CREATE_LOGICAL_CHATS_ROOT_READY_TRIGGER_SQL = `CREATE TRIGGER logical_chats_require_native_root_for_ready
BEFORE UPDATE OF state ON logical_chats
WHEN OLD.state <> 'ready'
  AND NEW.state = 'ready'
  AND NEW.current_native_binding_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM inward_collaboration_edges AS edge
    JOIN native_root_certificates AS certificate
      ON certificate.root_path_certificate_id = edge.root_path_certificate_id
    JOIN native_root_activation_operations AS operation
      ON operation.operation_id = certificate.activation_operation_id
    WHERE edge.inward_edge_id = NEW.current_inward_edge_id
      AND edge.represented_server_id = NEW.collaboration_server_id
      AND edge.represented_logical_chat_id = NEW.logical_chat_id
      AND edge.target_kind = 'native-harness'
      AND edge.target_native_binding_id = NEW.current_native_binding_id
      AND edge.state = 'current'
      AND certificate.terminal_topology_generation = NEW.topology_generation
      AND certificate.state = 'activated'
      AND operation.state = 'committed'
  )
BEGIN
  SELECT RAISE(ABORT, 'terminal logical chat readiness requires its committed native root');
END`;

const CREATE_LOGICAL_CHATS_ROOT_READY_INSERT_TRIGGER_SQL = `CREATE TRIGGER logical_chats_require_unready_native_insert
BEFORE INSERT ON logical_chats
WHEN NEW.current_native_binding_id IS NOT NULL AND NEW.state = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'terminal logical chats must be inserted recovering for later root activation');
END`;

export const VERSION_SIX_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    schemaEntry(
      "table",
      "native_root_signature_activation_fences",
      "native_root_signature_activation_fences",
      CREATE_NATIVE_ROOT_SIGNATURE_ACTIVATION_FENCES_SQL,
    ),
    schemaEntry(
      "table",
      "native_root_activation_operations",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_ACTIVATION_OPERATIONS_SQL,
    ),
    schemaEntry(
      "table",
      "native_root_certificates",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_activation_operations_digest_unique",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_DIGEST_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_activation_operations_root_unique",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_ROOT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_activation_operations_signer_unique",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_SIGNER_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_activation_operations_signed_digest_unique",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_SIGNED_DIGEST_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_certificates_prior_unique",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_PRIOR_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_activation_operations_scope_commit_index",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_certificates_operation_unique",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_OPERATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_certificates_signer_unique",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_SIGNER_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_certificates_payload_unique",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_PAYLOAD_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_certificates_signed_digest_unique",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_SIGNED_DIGEST_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "native_root_certificates_scope_commit_index",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_activation_operations_require_exact_graph",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_GRAPH_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_signature_activation_fences_no_update",
      "native_root_signature_activation_fences",
      CREATE_NATIVE_ROOT_SIGNATURE_FENCES_NO_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_signature_activation_fences_no_delete",
      "native_root_signature_activation_fences",
      CREATE_NATIVE_ROOT_SIGNATURE_FENCES_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_signature_activation_fences_no_replace",
      "native_root_signature_activation_fences",
      CREATE_NATIVE_ROOT_SIGNATURE_FENCES_NO_REPLACE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "runtime_owner_identity_keys_create_native_root_signature_fence",
      "runtime_owner_identity_keys",
      CREATE_RUNTIME_OWNER_IDENTITY_KEYS_NATIVE_ROOT_FENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_activation_operations_require_exact_evidence",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_EVIDENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_activation_operations_require_current_fences",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_FENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_activation_operations_finalize_only",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_activation_operations_no_delete",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_activation_operations_no_replace",
      "native_root_activation_operations",
      CREATE_NATIVE_ROOT_OPERATIONS_NO_REPLACE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_certificates_require_prepared_operation",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_OPERATION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_certificates_require_signed_evidence",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_EVIDENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_certificates_require_current_fences",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_FENCE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_certificates_finalize_activation",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_FINALIZE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_certificates_no_update",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_NO_UPDATE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_certificates_no_delete",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_NO_DELETE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "native_root_certificates_no_replace",
      "native_root_certificates",
      CREATE_NATIVE_ROOT_CERTIFICATES_NO_REPLACE_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "inward_collaboration_edges_require_native_root_activation",
      "inward_collaboration_edges",
      CREATE_INWARD_EDGES_ROOT_ACTIVATION_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "inward_collaboration_edges_require_unrooted_native_insert",
      "inward_collaboration_edges",
      CREATE_INWARD_EDGES_ROOT_INSERT_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "logical_chats_require_native_root_for_ready",
      "logical_chats",
      CREATE_LOGICAL_CHATS_ROOT_READY_TRIGGER_SQL,
    ),
    schemaEntry(
      "trigger",
      "logical_chats_require_unready_native_insert",
      "logical_chats",
      CREATE_LOGICAL_CHATS_ROOT_READY_INSERT_TRIGGER_SQL,
    ),
  ]);

export const VERSION_SIX_DATA_STATEMENTS: readonly string[] = Object.freeze([
  `INSERT INTO native_root_signature_activation_fences (
  runtime_id,
  runtime_owner_identity_key_id,
  runtime_owner_key_generation,
  first_eligible_signer_sequence
)
SELECT runtime_id, runtime_owner_identity_key_id, key_generation, next_signer_sequence
FROM runtime_owner_identity_keys`,
]);
