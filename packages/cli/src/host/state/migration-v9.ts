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

const CREATE_SERVER_IDENTITY_KEYS_SQL = `CREATE TABLE server_identity_keys (
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  identity_key_id TEXT NOT NULL CHECK (
    length(identity_key_id) BETWEEN 1 AND 128
    AND identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  key_generation INTEGER NOT NULL CHECK (
    key_generation BETWEEN 1 AND 9007199254740991
  ),
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 43
    AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signing_key_ref TEXT NOT NULL CHECK (
    length(signing_key_ref) = 27
    AND substr(signing_key_ref, 1, 5) = 'rcph_'
    AND signing_key_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  introduced_by_scope_certificate_id TEXT CHECK (
    introduced_by_scope_certificate_id IS NULL OR (
      length(introduced_by_scope_certificate_id) BETWEEN 1 AND 128
      AND introduced_by_scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  trust_evidence_ref TEXT NOT NULL CHECK (
    length(trust_evidence_ref) = 27
    AND substr(trust_evidence_ref, 1, 5) = 'rcph_'
    AND trust_evidence_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  trust_evidence_digest TEXT NOT NULL CHECK (
    length(trust_evidence_digest) = 43
    AND trust_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  valid_from_ms INTEGER NOT NULL CHECK (
    valid_from_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'current', 'retired', 'revoked')),
  PRIMARY KEY (collaboration_server_id, identity_key_id),
  CHECK ((state = 'proposed') = (introduced_by_scope_certificate_id IS NULL)),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id),
  FOREIGN KEY (
    signing_key_ref,
    collaboration_server_id,
    identity_key_id,
    key_generation
  ) REFERENCES server_identity_private_key_envelopes (
    signing_key_ref,
    collaboration_server_id,
    identity_key_id,
    key_generation
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (collaboration_server_id, introduced_by_scope_certificate_id)
    REFERENCES server_scope_certificates (
      collaboration_server_id,
      scope_certificate_id
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_IDENTITY_PRIVATE_KEY_ENVELOPES_SQL = `CREATE TABLE server_identity_private_key_envelopes (
  signing_key_ref TEXT PRIMARY KEY NOT NULL CHECK (
    length(signing_key_ref) = 27
    AND substr(signing_key_ref, 1, 5) = 'rcph_'
    AND signing_key_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  identity_key_id TEXT NOT NULL CHECK (
    length(identity_key_id) BETWEEN 1 AND 128
    AND identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  key_generation INTEGER NOT NULL CHECK (
    key_generation BETWEEN 1 AND 9007199254740991
  ),
  custody_backend TEXT NOT NULL CHECK (custody_backend = 'owned-file'),
  wrapping_schema_id TEXT NOT NULL CHECK (
    wrapping_schema_id = 'remote-claw/server-identity-key-wrap/aes-256-gcm/v1'
  ),
  wrap_nonce BLOB NOT NULL CHECK (length(wrap_nonce) = 12),
  wrapped_pkcs8 BLOB NOT NULL CHECK (length(wrapped_pkcs8) BETWEEN 1 AND 1024),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  pkcs8_digest TEXT NOT NULL CHECK (
    length(pkcs8_digest) = 43
    AND pkcs8_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  destroyed_at_ms INTEGER CHECK (
    destroyed_at_ms IS NULL OR destroyed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'destroyed')),
  CHECK ((state = 'destroyed') = (destroyed_at_ms IS NOT NULL)),
  CHECK (destroyed_at_ms IS NULL OR destroyed_at_ms >= created_at_ms),
  FOREIGN KEY (collaboration_server_id, identity_key_id, key_generation)
    REFERENCES server_identity_keys (
      collaboration_server_id,
      identity_key_id,
      key_generation
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_SCOPE_CERTIFICATES_SQL = `CREATE TABLE server_scope_certificates (
  scope_certificate_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(scope_certificate_id) BETWEEN 1 AND 128
    AND scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  canonical_payload_schema_id TEXT NOT NULL CHECK (
    canonical_payload_schema_id = 'remote-claw/server-scope-certificate/v1'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  machine_identity_id TEXT NOT NULL CHECK (
    length(machine_identity_id) = 32
    AND machine_identity_id NOT GLOB '*[^0-9a-f]*'
  ),
  subject_identity_key_id TEXT NOT NULL CHECK (
    length(subject_identity_key_id) BETWEEN 1 AND 128
    AND subject_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  subject_key_algorithm TEXT NOT NULL CHECK (subject_key_algorithm = 'Ed25519'),
  subject_public_key TEXT NOT NULL CHECK (
    length(subject_public_key) = 43
    AND subject_public_key NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  key_generation INTEGER NOT NULL CHECK (
    key_generation BETWEEN 1 AND 9007199254740991
  ),
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms BETWEEN 0 AND 9007199254740991),
  supersedes_scope_certificate_id TEXT CHECK (
    supersedes_scope_certificate_id IS NULL OR (
      length(supersedes_scope_certificate_id) BETWEEN 1 AND 128
      AND supersedes_scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND supersedes_scope_certificate_id <> scope_certificate_id
    )
  ),
  signer_identity_key_id TEXT NOT NULL CHECK (
    length(signer_identity_key_id) BETWEEN 1 AND 128
    AND signer_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  signer_sequence INTEGER NOT NULL CHECK (
    signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  superseded_signer_max_sequence INTEGER CHECK (
    superseded_signer_max_sequence IS NULL
    OR superseded_signer_max_sequence BETWEEN 0 AND 9007199254740991
  ),
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'Ed25519'),
  canonical_payload_digest_algorithm TEXT NOT NULL CHECK (
    canonical_payload_digest_algorithm = 'SHA-256'
  ),
  canonical_payload_digest TEXT NOT NULL CHECK (
    length(canonical_payload_digest) = 43
    AND canonical_payload_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signature TEXT NOT NULL CHECK (
    length(signature) = 86
    AND signature NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  FOREIGN KEY (collaboration_server_id, machine_identity_id)
    REFERENCES collaboration_servers (collaboration_server_id, machine_identity_id),
  FOREIGN KEY (
    collaboration_server_id,
    subject_identity_key_id,
    key_generation
  ) REFERENCES server_identity_keys (
    collaboration_server_id,
    identity_key_id,
    key_generation
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (collaboration_server_id, signer_identity_key_id)
    REFERENCES server_identity_keys (collaboration_server_id, identity_key_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (collaboration_server_id, supersedes_scope_certificate_id)
    REFERENCES server_scope_certificates (
      collaboration_server_id,
      scope_certificate_id
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_SQL = `CREATE TABLE server_scope_certificate_statuses (
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  scope_certificate_id TEXT NOT NULL CHECK (
    length(scope_certificate_id) BETWEEN 1 AND 128
    AND scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'retired', 'revoked')),
  accept_signatures_through_sequence INTEGER CHECK (
    accept_signatures_through_sequence IS NULL
    OR accept_signatures_through_sequence BETWEEN 0 AND 9007199254740991
  ),
  changed_at_ms INTEGER NOT NULL CHECK (
    changed_at_ms BETWEEN 0 AND 9007199254740991
  ),
  change_evidence_ref TEXT NOT NULL CHECK (
    length(change_evidence_ref) BETWEEN 1 AND 128
    AND change_evidence_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  change_evidence_digest TEXT NOT NULL CHECK (
    length(change_evidence_digest) = 43
    AND change_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  PRIMARY KEY (collaboration_server_id, scope_certificate_id),
  CHECK ((state = 'retired') = (accept_signatures_through_sequence IS NOT NULL)),
  FOREIGN KEY (collaboration_server_id, scope_certificate_id)
    REFERENCES server_scope_certificates (
      collaboration_server_id,
      scope_certificate_id
    )
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_SQL = `CREATE TABLE server_bootstrap_signing_leases (
  bootstrap_signing_lease_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(bootstrap_signing_lease_id) BETWEEN 1 AND 128
    AND bootstrap_signing_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  purpose TEXT NOT NULL CHECK (purpose IN ('initial_pair', 'explicit_repair')),
  operator_intent_evidence_ref TEXT NOT NULL CHECK (
    length(operator_intent_evidence_ref) = 27
    AND substr(operator_intent_evidence_ref, 1, 5) = 'rcph_'
    AND operator_intent_evidence_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  operator_intent_evidence_digest TEXT NOT NULL CHECK (
    length(operator_intent_evidence_digest) = 43
    AND operator_intent_evidence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  expected_prior_scope_certificate_id TEXT CHECK (
    expected_prior_scope_certificate_id IS NULL OR (
      length(expected_prior_scope_certificate_id) BETWEEN 1 AND 128
      AND expected_prior_scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  proposed_identity_key_id TEXT NOT NULL CHECK (
    length(proposed_identity_key_id) BETWEEN 1 AND 128
    AND proposed_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  proposed_key_generation INTEGER NOT NULL CHECK (
    proposed_key_generation BETWEEN 1 AND 9007199254740991
  ),
  proposed_scope_certificate_id TEXT NOT NULL CHECK (
    length(proposed_scope_certificate_id) BETWEEN 1 AND 128
    AND proposed_scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  signing_key_ref TEXT NOT NULL CHECK (
    length(signing_key_ref) = 27
    AND substr(signing_key_ref, 1, 5) = 'rcph_'
    AND signing_key_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_lease_id TEXT NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  fencing_token INTEGER NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
  prepared_at_ms INTEGER NOT NULL CHECK (
    prepared_at_ms BETWEEN 0 AND 9007199254740991
  ),
  signed_at_ms INTEGER CHECK (
    signed_at_ms IS NULL OR signed_at_ms BETWEEN prepared_at_ms AND 9007199254740991
  ),
  installed_at_ms INTEGER CHECK (
    installed_at_ms IS NULL OR installed_at_ms BETWEEN COALESCE(signed_at_ms, prepared_at_ms) AND 9007199254740991
  ),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms BETWEEN COALESCE(installed_at_ms, signed_at_ms, prepared_at_ms) AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'signed', 'installed', 'closed')),
  CHECK (
    (purpose = 'initial_pair' AND expected_prior_scope_certificate_id IS NULL)
    OR (purpose = 'explicit_repair' AND expected_prior_scope_certificate_id IS NOT NULL)
  ),
  CHECK (installed_at_ms IS NULL OR signed_at_ms IS NOT NULL),
  CHECK (closed_at_ms IS NULL OR state = 'closed'),
  CHECK (
    (state = 'prepared' AND signed_at_ms IS NULL AND installed_at_ms IS NULL AND closed_at_ms IS NULL)
    OR (state = 'signed' AND signed_at_ms IS NOT NULL AND installed_at_ms IS NULL AND closed_at_ms IS NULL)
    OR (state = 'installed' AND signed_at_ms IS NOT NULL AND installed_at_ms IS NOT NULL AND closed_at_ms IS NULL)
    OR (state = 'closed' AND closed_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id),
  FOREIGN KEY (collaboration_server_id, proposed_identity_key_id, proposed_key_generation)
    REFERENCES server_identity_keys (
      collaboration_server_id,
      identity_key_id,
      key_generation
    ),
  FOREIGN KEY (
    signing_key_ref,
    collaboration_server_id,
    proposed_identity_key_id,
    proposed_key_generation
  ) REFERENCES server_identity_private_key_envelopes (
    signing_key_ref,
    collaboration_server_id,
    identity_key_id,
    key_generation
  ),
  FOREIGN KEY (collaboration_server_id, expected_prior_scope_certificate_id)
    REFERENCES server_scope_certificates (
      collaboration_server_id,
      scope_certificate_id
    ),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    )
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_SIGNING_LEASES_SQL = `CREATE TABLE server_signing_leases (
  signing_lease_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(signing_lease_id) BETWEEN 1 AND 128
    AND signing_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  identity_key_id TEXT NOT NULL CHECK (
    length(identity_key_id) BETWEEN 1 AND 128
    AND identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  key_generation INTEGER NOT NULL CHECK (
    key_generation BETWEEN 1 AND 9007199254740991
  ),
  scope_certificate_id TEXT NOT NULL CHECK (
    length(scope_certificate_id) BETWEEN 1 AND 128
    AND scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  coordinator_lease_id TEXT NOT NULL CHECK (
    length(coordinator_lease_id) = 27
    AND substr(coordinator_lease_id, 1, 5) = 'rccl_'
    AND coordinator_lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  coordinator_epoch INTEGER NOT NULL CHECK (
    coordinator_epoch BETWEEN 1 AND 9007199254740991
  ),
  fencing_token INTEGER NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
  acquired_at_ms INTEGER NOT NULL CHECK (
    acquired_at_ms BETWEEN 0 AND 9007199254740991
  ),
  draining_at_ms INTEGER CHECK (
    draining_at_ms IS NULL OR draining_at_ms BETWEEN acquired_at_ms AND 9007199254740991
  ),
  superseded_at_ms INTEGER CHECK (
    superseded_at_ms IS NULL OR superseded_at_ms BETWEEN COALESCE(draining_at_ms, acquired_at_ms) AND 9007199254740991
  ),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms BETWEEN COALESCE(superseded_at_ms, draining_at_ms, acquired_at_ms) AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('current', 'draining', 'superseded', 'closed')),
  CHECK (
    (state = 'current' AND draining_at_ms IS NULL AND superseded_at_ms IS NULL AND closed_at_ms IS NULL)
    OR (state = 'draining' AND draining_at_ms IS NOT NULL AND superseded_at_ms IS NULL AND closed_at_ms IS NULL)
    OR (state = 'superseded' AND superseded_at_ms IS NOT NULL AND closed_at_ms IS NULL)
    OR (state = 'closed' AND closed_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (collaboration_server_id, identity_key_id, key_generation)
    REFERENCES server_identity_keys (
      collaboration_server_id,
      identity_key_id,
      key_generation
    ),
  FOREIGN KEY (collaboration_server_id, scope_certificate_id)
    REFERENCES server_scope_certificates (
      collaboration_server_id,
      scope_certificate_id
    ),
  FOREIGN KEY (coordinator_lease_id, collaboration_server_id, coordinator_epoch)
    REFERENCES coordinator_leases (
      coordinator_lease_id,
      collaboration_server_id,
      coordinator_epoch
    )
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_SQL = `CREATE TABLE server_signature_reservations (
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signer_sequence INTEGER NOT NULL CHECK (
    signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  signing_lease_id TEXT NOT NULL CHECK (
    length(signing_lease_id) BETWEEN 1 AND 128
    AND signing_lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  signing_lease_kind TEXT NOT NULL CHECK (signing_lease_kind IN ('current', 'bootstrap')),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'scope_certificate',
    'onboarding_keys',
    'host_output',
    'scope_bus_checkpoint',
    'topology_path_hop',
    'server_rooted_topology',
    'edge_install_receipt',
    'edge_live_handshake',
    'event_lineage_hop',
    'collaboration_command_result',
    'nested_management_lineage_hop',
    'nested_management_live_handshake',
    'nested_management_transport_attestation',
    'nested_management_capability_continuation',
    'nested_positive_never_started_attestation',
    'nested_target_ready_attestation',
    'nested_chat_edge_capability_continuation',
    'historical_reattestation'
  )),
  canonical_payload_schema_id TEXT,
  canonical_payload_ref TEXT CHECK (
    canonical_payload_ref IS NULL OR (
      length(canonical_payload_ref) = 27
      AND substr(canonical_payload_ref, 1, 5) = 'rcph_'
      AND canonical_payload_ref NOT GLOB '*[^A-Za-z0-9_-]*'
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
  signed_artifact_type TEXT CHECK (
    signed_artifact_type IS NULL OR (
      length(signed_artifact_type) BETWEEN 1 AND 128
      AND signed_artifact_type NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  signed_artifact_id TEXT CHECK (
    signed_artifact_id IS NULL OR (
      length(signed_artifact_id) BETWEEN 1 AND 128
      AND signed_artifact_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  reserved_at_ms INTEGER NOT NULL CHECK (
    reserved_at_ms BETWEEN 0 AND 9007199254740991
  ),
  bound_at_ms INTEGER CHECK (
    bound_at_ms IS NULL OR bound_at_ms BETWEEN reserved_at_ms AND 9007199254740991
  ),
  signed_at_ms INTEGER CHECK (
    signed_at_ms IS NULL OR signed_at_ms BETWEEN COALESCE(bound_at_ms, reserved_at_ms) AND 9007199254740991
  ),
  aborted_at_ms INTEGER CHECK (
    aborted_at_ms IS NULL OR aborted_at_ms BETWEEN COALESCE(bound_at_ms, reserved_at_ms) AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'bound', 'signed', 'aborted')),
  PRIMARY KEY (collaboration_server_id, signer_sequence),
  CHECK (
    canonical_payload_schema_id IS NULL OR (
      (purpose = 'scope_certificate' AND canonical_payload_schema_id = 'remote-claw/server-scope-certificate/v1')
      OR (purpose = 'onboarding_keys' AND canonical_payload_schema_id = 'remote-claw/viewer-onboarding-keys/v1')
      OR (purpose = 'host_output' AND canonical_payload_schema_id = 'remote-claw/a1/host-output-signature/v1')
      OR (purpose = 'scope_bus_checkpoint' AND canonical_payload_schema_id = 'remote-claw/a1/scope-bus-checkpoint/v1')
      OR (purpose = 'topology_path_hop' AND canonical_payload_schema_id = 'remote-claw/topology-path-hop/v1')
      OR (purpose = 'server_rooted_topology' AND canonical_payload_schema_id = 'remote-claw/server-rooted-topology-certificate/v1')
      OR (purpose = 'edge_install_receipt' AND canonical_payload_schema_id = 'remote-claw/inward-edge-install-receipt/v1')
      OR (purpose = 'edge_live_handshake' AND canonical_payload_schema_id = 'remote-claw/inward-edge-live-handshake/v1')
      OR (purpose = 'event_lineage_hop' AND canonical_payload_schema_id = 'remote-claw/event-lineage-hop/v1')
      OR (purpose = 'collaboration_command_result' AND canonical_payload_schema_id = 'remote-claw/collaboration-command-result/v1')
      OR (purpose = 'nested_management_lineage_hop' AND canonical_payload_schema_id = 'remote-claw/nested-management-lineage-hop/v1')
      OR (purpose = 'nested_management_live_handshake' AND canonical_payload_schema_id = 'remote-claw/nested-management-live-handshake/v1')
      OR (purpose = 'nested_management_transport_attestation' AND canonical_payload_schema_id = 'remote-claw/nested-management-transport-attestation/v1')
      OR (purpose = 'nested_management_capability_continuation' AND canonical_payload_schema_id = 'remote-claw/nested-management-capability-continuation/v1')
      OR (purpose = 'nested_positive_never_started_attestation' AND canonical_payload_schema_id = 'remote-claw/nested-positive-never-started-attestation/v1')
      OR (purpose = 'nested_target_ready_attestation' AND canonical_payload_schema_id = 'remote-claw/nested-target-ready-attestation/v1')
      OR (purpose = 'nested_chat_edge_capability_continuation' AND canonical_payload_schema_id = 'remote-claw/nested-chat-edge-capability-continuation/v1')
      OR (purpose = 'historical_reattestation' AND canonical_payload_schema_id = 'remote-claw/historical-record-reattestation/v1')
    )
  ),
  CHECK (
    (state = 'reserved'
      AND canonical_payload_schema_id IS NULL
      AND canonical_payload_ref IS NULL
      AND canonical_payload_digest IS NULL
      AND signed_record_digest IS NULL
      AND signature IS NULL
      AND signed_artifact_type IS NULL
      AND signed_artifact_id IS NULL
      AND bound_at_ms IS NULL
      AND signed_at_ms IS NULL
      AND aborted_at_ms IS NULL)
    OR (state = 'bound'
      AND canonical_payload_schema_id IS NOT NULL
      AND canonical_payload_ref IS NOT NULL
      AND canonical_payload_digest IS NOT NULL
      AND signed_record_digest IS NULL
      AND signature IS NULL
      AND signed_artifact_type IS NOT NULL
      AND signed_artifact_id IS NOT NULL
      AND bound_at_ms IS NOT NULL
      AND signed_at_ms IS NULL
      AND aborted_at_ms IS NULL)
    OR (state = 'signed'
      AND canonical_payload_schema_id IS NOT NULL
      AND canonical_payload_ref IS NOT NULL
      AND canonical_payload_digest IS NOT NULL
      AND signed_record_digest IS NOT NULL
      AND signature IS NOT NULL
      AND signed_artifact_type IS NOT NULL
      AND signed_artifact_id IS NOT NULL
      AND bound_at_ms IS NOT NULL
      AND signed_at_ms IS NOT NULL
      AND aborted_at_ms IS NULL)
    OR (state = 'aborted'
      AND signed_record_digest IS NULL
      AND signature IS NULL
      AND signed_at_ms IS NULL
      AND aborted_at_ms IS NOT NULL
      AND (
        (canonical_payload_schema_id IS NULL
          AND canonical_payload_ref IS NULL
          AND canonical_payload_digest IS NULL
          AND signed_artifact_type IS NULL
          AND signed_artifact_id IS NULL
          AND bound_at_ms IS NULL)
        OR (canonical_payload_schema_id IS NOT NULL
          AND canonical_payload_ref IS NOT NULL
          AND canonical_payload_digest IS NOT NULL
          AND signed_artifact_type IS NOT NULL
          AND signed_artifact_id IS NOT NULL
          AND bound_at_ms IS NOT NULL)
      ))
  ),
  FOREIGN KEY (collaboration_server_id)
    REFERENCES collaboration_servers (collaboration_server_id)
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_SIGNED_RECORD_ACCEPTANCES_SQL = `CREATE TABLE server_signed_record_acceptances (
  collaboration_server_id TEXT NOT NULL CHECK (
    length(collaboration_server_id) = 26
    AND substr(collaboration_server_id, 1, 4) = 'rcs_'
    AND collaboration_server_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  accepted_at_journal_seq INTEGER NOT NULL CHECK (
    accepted_at_journal_seq BETWEEN 0 AND 9007199254740991
  ),
  signed_record_digest TEXT NOT NULL CHECK (
    length(signed_record_digest) = 43
    AND signed_record_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  signer_identity_key_id TEXT NOT NULL CHECK (
    length(signer_identity_key_id) BETWEEN 1 AND 128
    AND signer_identity_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  signer_key_generation INTEGER NOT NULL CHECK (
    signer_key_generation BETWEEN 1 AND 9007199254740991
  ),
  signer_scope_certificate_id TEXT NOT NULL CHECK (
    length(signer_scope_certificate_id) BETWEEN 1 AND 128
    AND signer_scope_certificate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  signer_sequence INTEGER NOT NULL CHECK (
    signer_sequence BETWEEN 0 AND 9007199254740991
  ),
  accepted_at_ms INTEGER NOT NULL CHECK (
    accepted_at_ms BETWEEN 0 AND 9007199254740991
  ),
  historical_reattestation_id TEXT CHECK (
    historical_reattestation_id IS NULL OR (
      length(historical_reattestation_id) BETWEEN 1 AND 128
      AND historical_reattestation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  PRIMARY KEY (collaboration_server_id, accepted_at_journal_seq),
  FOREIGN KEY (
    collaboration_server_id,
    signer_identity_key_id,
    signer_key_generation
  ) REFERENCES server_identity_keys (
    collaboration_server_id,
    identity_key_id,
    key_generation
  ),
  FOREIGN KEY (collaboration_server_id, signer_scope_certificate_id)
    REFERENCES server_scope_certificates (
      collaboration_server_id,
      scope_certificate_id
    ),
  FOREIGN KEY (
    collaboration_server_id,
    signer_sequence,
    signed_record_digest
  ) REFERENCES server_signature_reservations (
    collaboration_server_id,
    signer_sequence,
    signed_record_digest
    )
) STRICT, WITHOUT ROWID`;

const CREATE_SERVER_IDENTITY_KEYS_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX server_identity_keys_one_current_unique
ON server_identity_keys (collaboration_server_id)
WHERE state = 'current'`;

const CREATE_SERVER_IDENTITY_KEYS_PROPOSED_INDEX_SQL = `CREATE UNIQUE INDEX server_identity_keys_one_proposed_unique
ON server_identity_keys (collaboration_server_id)
WHERE state = 'proposed'`;

const CREATE_SERVER_IDENTITY_KEYS_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX server_identity_keys_generation_unique
ON server_identity_keys (collaboration_server_id, key_generation)`;

const CREATE_SERVER_IDENTITY_KEYS_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX server_identity_keys_scope_unique
ON server_identity_keys (collaboration_server_id, identity_key_id, key_generation)`;

const CREATE_SERVER_PRIVATE_KEY_ENVELOPES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX server_identity_private_key_envelopes_scope_unique
ON server_identity_private_key_envelopes (
  signing_key_ref,
  collaboration_server_id,
  identity_key_id,
  key_generation
)`;

const CREATE_SERVER_PRIVATE_KEY_ENVELOPES_NONCE_INDEX_SQL = `CREATE UNIQUE INDEX server_identity_private_key_envelopes_wrap_nonce_unique
ON server_identity_private_key_envelopes (wrap_nonce)`;

const CREATE_SERVER_SCOPE_CERTIFICATES_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX server_scope_certificates_digest_unique
ON server_scope_certificates (canonical_payload_digest)`;

const CREATE_SERVER_SCOPE_CERTIFICATES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX server_scope_certificates_scope_unique
ON server_scope_certificates (collaboration_server_id, scope_certificate_id)`;

const CREATE_SERVER_SCOPE_CERTIFICATES_GENERATION_INDEX_SQL = `CREATE UNIQUE INDEX server_scope_certificates_generation_unique
ON server_scope_certificates (collaboration_server_id, key_generation)`;

const CREATE_SERVER_SCOPE_CERTIFICATES_SUBJECT_INDEX_SQL = `CREATE UNIQUE INDEX server_scope_certificates_subject_unique
ON server_scope_certificates (collaboration_server_id, subject_identity_key_id)`;

const CREATE_SERVER_SCOPE_CERTIFICATES_SIGNER_SEQUENCE_INDEX_SQL = `CREATE UNIQUE INDEX server_scope_certificates_signer_sequence_unique
ON server_scope_certificates (collaboration_server_id, signer_sequence)`;

const CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX server_scope_certificate_statuses_one_current_unique
ON server_scope_certificate_statuses (collaboration_server_id)
WHERE state = 'current'`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_ACTIVE_INDEX_SQL = `CREATE UNIQUE INDEX server_bootstrap_signing_leases_one_active_unique
ON server_bootstrap_signing_leases (collaboration_server_id)
WHERE state <> 'closed'`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_FENCING_INDEX_SQL = `CREATE UNIQUE INDEX server_bootstrap_signing_leases_fencing_unique
ON server_bootstrap_signing_leases (collaboration_server_id, fencing_token)`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX server_bootstrap_signing_leases_scope_unique
ON server_bootstrap_signing_leases (
  bootstrap_signing_lease_id,
  collaboration_server_id
)`;

const CREATE_SERVER_SIGNING_LEASES_ACTIVE_INDEX_SQL = `CREATE UNIQUE INDEX server_signing_leases_one_active_unique
ON server_signing_leases (collaboration_server_id)
WHERE state IN ('current', 'draining')`;

const CREATE_SERVER_SIGNING_LEASES_FENCING_INDEX_SQL = `CREATE UNIQUE INDEX server_signing_leases_fencing_unique
ON server_signing_leases (collaboration_server_id, fencing_token)`;

const CREATE_SERVER_SIGNING_LEASES_SCOPE_INDEX_SQL = `CREATE UNIQUE INDEX server_signing_leases_scope_unique
ON server_signing_leases (signing_lease_id, collaboration_server_id)`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_REFERENCE_INDEX_SQL = `CREATE UNIQUE INDEX server_signature_reservations_reference_unique
ON server_signature_reservations (
  collaboration_server_id,
  signer_sequence,
  signed_record_digest
)`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX server_signature_reservations_signed_digest_unique
ON server_signature_reservations (signed_record_digest)
WHERE signed_record_digest IS NOT NULL`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_ARTIFACT_INDEX_SQL = `CREATE UNIQUE INDEX server_signature_reservations_signed_artifact_unique
ON server_signature_reservations (
  collaboration_server_id,
  signed_artifact_type,
  signed_artifact_id
)
WHERE signed_artifact_type IS NOT NULL AND signed_artifact_id IS NOT NULL`;

const CREATE_SERVER_IDENTITY_KEYS_REQUIRE_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER server_identity_keys_require_current_authority
BEFORE INSERT ON server_identity_keys
WHEN NEW.state <> 'proposed' OR NOT EXISTS (
  SELECT 1
  FROM collaboration_servers AS server
  JOIN coordinator_leases AS lease
    ON lease.coordinator_lease_id = server.current_coordinator_lease_id
   AND lease.collaboration_server_id = server.collaboration_server_id
   AND lease.coordinator_epoch = server.current_coordinator_epoch
  WHERE server.collaboration_server_id = NEW.collaboration_server_id
    AND lease.state = 'current'
    AND lease.released_at_ms IS NULL
    AND lease.acquired_at_ms <= NEW.valid_from_ms
    AND NEW.valid_from_ms < lease.heartbeat_deadline_ms
    AND server.state = 'installing'
    AND server.current_key_generation = 0
    AND NEW.key_generation = 1
)
BEGIN
  SELECT RAISE(ABORT, 'server identity proposal requires its current coordinator and next generation');
END`;

const CREATE_SERVER_IDENTITY_KEYS_REQUIRE_TRUST_EVIDENCE_TRIGGER_SQL = `CREATE TRIGGER server_identity_keys_require_exact_trust_evidence
BEFORE INSERT ON server_identity_keys
WHEN NOT EXISTS (
  SELECT 1 FROM protected_artifacts AS artifact
  WHERE artifact.protected_handle_id = NEW.trust_evidence_ref
    AND artifact.kind = 'artifact'
    AND artifact.scope_kind = 'collaboration_server'
    AND artifact.scope_id = NEW.collaboration_server_id
    AND artifact.artifact_schema_id = 'remote-claw/server-signer-bootstrap-intent/v1'
    AND artifact.artifact_digest = NEW.trust_evidence_digest
)
BEGIN
  SELECT RAISE(ABORT, 'server identity proposal requires its exact protected trust evidence');
END`;

const CREATE_SERVER_IDENTITY_KEYS_LIFECYCLE_TRIGGER_SQL = `CREATE TRIGGER server_identity_keys_lifecycle_monotonic
BEFORE UPDATE ON server_identity_keys
WHEN NOT (
  (NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.identity_key_id IS OLD.identity_key_id
    AND NEW.key_generation IS OLD.key_generation
    AND NEW.algorithm IS OLD.algorithm
    AND NEW.public_key IS OLD.public_key
    AND NEW.signing_key_ref IS OLD.signing_key_ref
    AND NEW.introduced_by_scope_certificate_id IS OLD.introduced_by_scope_certificate_id
    AND NEW.trust_evidence_ref IS OLD.trust_evidence_ref
    AND NEW.trust_evidence_digest IS OLD.trust_evidence_digest
    AND NEW.valid_from_ms IS OLD.valid_from_ms
    AND NEW.state IS OLD.state)
  OR (OLD.state = 'proposed'
    AND NEW.state = 'current'
    AND OLD.introduced_by_scope_certificate_id IS NULL
    AND NEW.introduced_by_scope_certificate_id IS NOT NULL
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.identity_key_id IS OLD.identity_key_id
    AND NEW.key_generation IS OLD.key_generation
    AND NEW.algorithm IS OLD.algorithm
    AND NEW.public_key IS OLD.public_key
    AND NEW.signing_key_ref IS OLD.signing_key_ref
    AND NEW.trust_evidence_ref IS OLD.trust_evidence_ref
    AND NEW.trust_evidence_digest IS OLD.trust_evidence_digest
    AND NEW.valid_from_ms IS OLD.valid_from_ms
    AND EXISTS (
      SELECT 1 FROM server_scope_certificates AS certificate
      WHERE certificate.collaboration_server_id = OLD.collaboration_server_id
        AND certificate.scope_certificate_id = NEW.introduced_by_scope_certificate_id
        AND certificate.subject_identity_key_id = OLD.identity_key_id
        AND certificate.subject_public_key = OLD.public_key
        AND certificate.key_generation = OLD.key_generation
    )
    AND EXISTS (
      SELECT 1
      FROM server_bootstrap_signing_leases AS bootstrap
      JOIN collaboration_servers AS server
        ON server.collaboration_server_id = bootstrap.collaboration_server_id
      JOIN coordinator_leases AS coordinator
        ON coordinator.coordinator_lease_id = bootstrap.coordinator_lease_id
       AND coordinator.collaboration_server_id = bootstrap.collaboration_server_id
       AND coordinator.coordinator_epoch = bootstrap.coordinator_epoch
      WHERE bootstrap.collaboration_server_id = OLD.collaboration_server_id
        AND bootstrap.purpose = 'initial_pair'
        AND bootstrap.proposed_identity_key_id = OLD.identity_key_id
        AND bootstrap.proposed_key_generation = OLD.key_generation
        AND bootstrap.proposed_scope_certificate_id =
          NEW.introduced_by_scope_certificate_id
        AND bootstrap.state = 'signed'
        AND server.state = 'installing'
        AND server.current_coordinator_lease_id = bootstrap.coordinator_lease_id
        AND server.current_coordinator_epoch = bootstrap.coordinator_epoch
        AND coordinator.state = 'current'
        AND coordinator.released_at_ms IS NULL
    ))
  OR (OLD.state = 'current'
    AND NEW.state IN ('retired', 'revoked')
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.identity_key_id IS OLD.identity_key_id
    AND NEW.key_generation IS OLD.key_generation
    AND NEW.algorithm IS OLD.algorithm
    AND NEW.public_key IS OLD.public_key
    AND NEW.signing_key_ref IS OLD.signing_key_ref
    AND NEW.introduced_by_scope_certificate_id IS OLD.introduced_by_scope_certificate_id
    AND NEW.trust_evidence_ref IS OLD.trust_evidence_ref
    AND NEW.trust_evidence_digest IS OLD.trust_evidence_digest
    AND NEW.valid_from_ms IS OLD.valid_from_ms)
  OR (OLD.state = 'retired'
    AND NEW.state = 'revoked'
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.identity_key_id IS OLD.identity_key_id
    AND NEW.key_generation IS OLD.key_generation
    AND NEW.algorithm IS OLD.algorithm
    AND NEW.public_key IS OLD.public_key
    AND NEW.signing_key_ref IS OLD.signing_key_ref
    AND NEW.introduced_by_scope_certificate_id IS OLD.introduced_by_scope_certificate_id
    AND NEW.trust_evidence_ref IS OLD.trust_evidence_ref
    AND NEW.trust_evidence_digest IS OLD.trust_evidence_digest
    AND NEW.valid_from_ms IS OLD.valid_from_ms)
)
BEGIN
  SELECT RAISE(ABORT, 'server identity key lifecycle is monotonic');
END`;

const CREATE_SERVER_IDENTITY_KEYS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_identity_keys_no_delete
BEFORE DELETE ON server_identity_keys
BEGIN
  SELECT RAISE(ABORT, 'server identity key history is retained');
END`;

const CREATE_SERVER_IDENTITY_KEYS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_identity_keys_no_replace
BEFORE INSERT ON server_identity_keys
WHEN EXISTS (
  SELECT 1 FROM server_identity_keys
  WHERE collaboration_server_id = NEW.collaboration_server_id
    AND identity_key_id = NEW.identity_key_id
)
BEGIN
  SELECT RAISE(ABORT, 'server identity key history is immutable');
END`;

const CREATE_SERVER_PRIVATE_KEY_ENVELOPES_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER server_identity_private_key_envelopes_identity_immutable
BEFORE UPDATE ON server_identity_private_key_envelopes
WHEN NEW.signing_key_ref IS NOT OLD.signing_key_ref
  OR NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.identity_key_id IS NOT OLD.identity_key_id
  OR NEW.key_generation IS NOT OLD.key_generation
  OR NEW.custody_backend IS NOT OLD.custody_backend
  OR NEW.wrapping_schema_id IS NOT OLD.wrapping_schema_id
  OR NEW.wrap_nonce IS NOT OLD.wrap_nonce
  OR NEW.wrapped_pkcs8 IS NOT OLD.wrapped_pkcs8
  OR NEW.auth_tag IS NOT OLD.auth_tag
  OR NEW.pkcs8_digest IS NOT OLD.pkcs8_digest
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'wrapped server private key envelope is immutable');
END`;

const CREATE_SERVER_PRIVATE_KEY_ENVELOPES_STATE_TRIGGER_SQL = `CREATE TRIGGER server_identity_private_key_envelopes_state_monotonic
BEFORE UPDATE ON server_identity_private_key_envelopes
WHEN NOT (
  (NEW.state = OLD.state AND NEW.destroyed_at_ms IS OLD.destroyed_at_ms)
  OR (OLD.state = 'current'
    AND NEW.state = 'destroyed'
    AND OLD.destroyed_at_ms IS NULL
    AND NEW.destroyed_at_ms IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM server_identity_keys AS identity_key
      WHERE identity_key.collaboration_server_id = OLD.collaboration_server_id
        AND identity_key.identity_key_id = OLD.identity_key_id
        AND identity_key.key_generation = OLD.key_generation
        AND identity_key.state = 'current'
    )
    AND NOT EXISTS (
      SELECT 1 FROM server_bootstrap_signing_leases AS bootstrap
      WHERE bootstrap.collaboration_server_id = OLD.collaboration_server_id
        AND bootstrap.proposed_identity_key_id = OLD.identity_key_id
        AND bootstrap.proposed_key_generation = OLD.key_generation
        AND bootstrap.signing_key_ref = OLD.signing_key_ref
        AND bootstrap.state IN ('prepared', 'signed', 'installed')
    )
    AND NOT EXISTS (
      SELECT 1 FROM server_signing_leases AS signing_lease
      WHERE signing_lease.collaboration_server_id = OLD.collaboration_server_id
        AND signing_lease.identity_key_id = OLD.identity_key_id
        AND signing_lease.key_generation = OLD.key_generation
        AND signing_lease.state IN ('current', 'draining')
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'wrapped server private key lifecycle is monotonic');
END`;

const CREATE_SERVER_PRIVATE_KEY_ENVELOPES_HANDLE_TRIGGER_SQL = `CREATE TRIGGER server_identity_private_key_envelopes_require_unallocated_handle
BEFORE INSERT ON server_identity_private_key_envelopes
WHEN EXISTS (
  SELECT 1 FROM protected_artifacts
  WHERE protected_handle_id = NEW.signing_key_ref
) OR EXISTS (
  SELECT 1 FROM runtime_owner_private_keys
  WHERE protected_handle_id = NEW.signing_key_ref
) OR EXISTS (
  SELECT 1 FROM native_conversation_leases
  WHERE protected_port_handle_id = NEW.signing_key_ref
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated outside server key custody');
END`;

const CREATE_PROTECTED_ARTIFACTS_SERVER_KEY_COLLISION_TRIGGER_SQL = `CREATE TRIGGER protected_artifacts_require_non_server_key_handle
BEFORE INSERT ON protected_artifacts
WHEN EXISTS (
  SELECT 1 FROM server_identity_private_key_envelopes
  WHERE signing_key_ref = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated to a server signing key');
END`;

const CREATE_RUNTIME_OWNER_PRIVATE_KEYS_SERVER_KEY_COLLISION_TRIGGER_SQL = `CREATE TRIGGER runtime_owner_private_keys_require_non_server_key_handle
BEFORE INSERT ON runtime_owner_private_keys
WHEN EXISTS (
  SELECT 1 FROM server_identity_private_key_envelopes
  WHERE signing_key_ref = NEW.protected_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated to a server signing key');
END`;

const CREATE_NATIVE_CONVERSATION_LEASES_SERVER_KEY_COLLISION_TRIGGER_SQL = `CREATE TRIGGER native_conversation_leases_require_non_server_key_handle
BEFORE INSERT ON native_conversation_leases
WHEN EXISTS (
  SELECT 1 FROM server_identity_private_key_envelopes
  WHERE signing_key_ref = NEW.protected_port_handle_id
)
BEGIN
  SELECT RAISE(ABORT, 'protected handle is already allocated to a server signing key');
END`;

const CREATE_SERVER_PRIVATE_KEY_ENVELOPES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_identity_private_key_envelopes_no_delete
BEFORE DELETE ON server_identity_private_key_envelopes
BEGIN
  SELECT RAISE(ABORT, 'wrapped server private key envelopes are retained');
END`;

const CREATE_SERVER_PRIVATE_KEY_ENVELOPES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_identity_private_key_envelopes_no_replace
BEFORE INSERT ON server_identity_private_key_envelopes
WHEN EXISTS (
  SELECT 1 FROM server_identity_private_key_envelopes
  WHERE signing_key_ref = NEW.signing_key_ref
)
BEGIN
  SELECT RAISE(ABORT, 'wrapped server private key envelopes are immutable');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATES_REQUIRE_SIGNATURE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificates_require_exact_signature
BEFORE INSERT ON server_scope_certificates
WHEN NOT EXISTS (
  SELECT 1
  FROM collaboration_servers AS server
  JOIN server_identity_keys AS subject_key
    ON subject_key.collaboration_server_id = NEW.collaboration_server_id
   AND subject_key.identity_key_id = NEW.subject_identity_key_id
   AND subject_key.key_generation = NEW.key_generation
   AND subject_key.algorithm = NEW.subject_key_algorithm
   AND subject_key.public_key = NEW.subject_public_key
  JOIN server_signature_reservations AS reservation
    ON reservation.collaboration_server_id = NEW.collaboration_server_id
   AND reservation.signer_sequence = NEW.signer_sequence
   AND reservation.purpose = 'scope_certificate'
   AND reservation.canonical_payload_schema_id = NEW.canonical_payload_schema_id
   AND reservation.canonical_payload_digest = NEW.canonical_payload_digest
   AND reservation.signature = NEW.signature
   AND reservation.signed_artifact_id = NEW.scope_certificate_id
   AND reservation.state = 'signed'
  WHERE server.collaboration_server_id = NEW.collaboration_server_id
    AND server.machine_identity_id = NEW.machine_identity_id
    AND subject_key.state = 'proposed'
    AND NEW.issued_at_ms >= reservation.reserved_at_ms
    AND NEW.issued_at_ms <= reservation.bound_at_ms
    AND (
      (reservation.signing_lease_kind = 'bootstrap'
        AND NEW.signer_identity_key_id = NEW.subject_identity_key_id
        AND NEW.supersedes_scope_certificate_id IS NULL
        AND NEW.superseded_signer_max_sequence IS NULL
        AND EXISTS (
          SELECT 1 FROM server_bootstrap_signing_leases AS bootstrap
          WHERE bootstrap.bootstrap_signing_lease_id = reservation.signing_lease_id
            AND bootstrap.collaboration_server_id = reservation.collaboration_server_id
            AND bootstrap.proposed_identity_key_id = NEW.subject_identity_key_id
            AND bootstrap.proposed_key_generation = NEW.key_generation
            AND bootstrap.proposed_scope_certificate_id = NEW.scope_certificate_id
            AND bootstrap.state IN ('prepared', 'signed')
        ))
      OR (reservation.signing_lease_kind = 'current'
        AND NEW.supersedes_scope_certificate_id IS NOT NULL
        AND NEW.superseded_signer_max_sequence = NEW.signer_sequence
        AND EXISTS (
          SELECT 1 FROM server_signing_leases AS signing_lease
          WHERE signing_lease.signing_lease_id = reservation.signing_lease_id
            AND signing_lease.collaboration_server_id = reservation.collaboration_server_id
            AND signing_lease.identity_key_id = NEW.signer_identity_key_id
            AND signing_lease.scope_certificate_id = NEW.supersedes_scope_certificate_id
            AND signing_lease.key_generation < 9007199254740991
            AND NEW.key_generation = signing_lease.key_generation + 1
            AND signing_lease.state = 'draining'
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'server scope certificate requires its exact fenced signature reservation');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATES_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificates_no_update
BEFORE UPDATE ON server_scope_certificates
BEGIN
  SELECT RAISE(ABORT, 'server scope certificates are immutable');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificates_no_delete
BEFORE DELETE ON server_scope_certificates
BEGIN
  SELECT RAISE(ABORT, 'server scope certificate history is retained');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificates_no_replace
BEFORE INSERT ON server_scope_certificates
WHEN EXISTS (
  SELECT 1 FROM server_scope_certificates
  WHERE scope_certificate_id = NEW.scope_certificate_id
)
BEGIN
  SELECT RAISE(ABORT, 'server scope certificates are immutable');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_REQUIRE_CERTIFICATE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificate_statuses_require_certificate
BEFORE INSERT ON server_scope_certificate_statuses
WHEN NOT EXISTS (
  SELECT 1
  FROM server_scope_certificates AS certificate
  JOIN server_identity_keys AS identity_key
    ON identity_key.collaboration_server_id = certificate.collaboration_server_id
   AND identity_key.identity_key_id = certificate.subject_identity_key_id
   AND identity_key.key_generation = certificate.key_generation
  WHERE certificate.collaboration_server_id = NEW.collaboration_server_id
    AND certificate.scope_certificate_id = NEW.scope_certificate_id
    AND certificate.issued_at_ms <= NEW.changed_at_ms
    AND (NEW.state <> 'current' OR identity_key.state = 'current')
    AND (NEW.state <> 'current' OR EXISTS (
      SELECT 1
      FROM server_bootstrap_signing_leases AS bootstrap
      JOIN collaboration_servers AS server
        ON server.collaboration_server_id = bootstrap.collaboration_server_id
      JOIN coordinator_leases AS coordinator
        ON coordinator.coordinator_lease_id = bootstrap.coordinator_lease_id
       AND coordinator.collaboration_server_id = bootstrap.collaboration_server_id
       AND coordinator.coordinator_epoch = bootstrap.coordinator_epoch
      WHERE bootstrap.collaboration_server_id = NEW.collaboration_server_id
        AND bootstrap.purpose = 'initial_pair'
        AND bootstrap.proposed_identity_key_id = identity_key.identity_key_id
        AND bootstrap.proposed_key_generation = identity_key.key_generation
        AND bootstrap.proposed_scope_certificate_id = NEW.scope_certificate_id
        AND bootstrap.state = 'signed'
        AND NEW.change_evidence_ref = bootstrap.operator_intent_evidence_ref
        AND NEW.change_evidence_digest = bootstrap.operator_intent_evidence_digest
        AND server.state = 'installing'
        AND server.current_coordinator_lease_id = bootstrap.coordinator_lease_id
        AND server.current_coordinator_epoch = bootstrap.coordinator_epoch
        AND coordinator.state = 'current'
        AND coordinator.released_at_ms IS NULL
        AND coordinator.acquired_at_ms <= NEW.changed_at_ms
        AND NEW.changed_at_ms < coordinator.heartbeat_deadline_ms
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'server scope certificate status requires its exact installed certificate');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_LIFECYCLE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificate_statuses_lifecycle_monotonic
BEFORE UPDATE ON server_scope_certificate_statuses
WHEN NOT (
  (NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.scope_certificate_id IS OLD.scope_certificate_id
    AND NEW.state IS OLD.state
    AND NEW.accept_signatures_through_sequence IS OLD.accept_signatures_through_sequence
    AND NEW.changed_at_ms IS OLD.changed_at_ms
    AND NEW.change_evidence_ref IS OLD.change_evidence_ref
    AND NEW.change_evidence_digest IS OLD.change_evidence_digest)
  OR (OLD.state = 'current'
    AND NEW.state = 'retired'
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.scope_certificate_id IS OLD.scope_certificate_id
    AND NEW.accept_signatures_through_sequence IS NOT NULL
    AND NEW.changed_at_ms >= OLD.changed_at_ms
    AND EXISTS (
      SELECT 1 FROM server_scope_certificates AS successor
      WHERE successor.collaboration_server_id = OLD.collaboration_server_id
        AND successor.supersedes_scope_certificate_id = OLD.scope_certificate_id
        AND successor.signer_identity_key_id = (
          SELECT subject_identity_key_id FROM server_scope_certificates
          WHERE collaboration_server_id = OLD.collaboration_server_id
            AND scope_certificate_id = OLD.scope_certificate_id
        )
        AND successor.superseded_signer_max_sequence =
          NEW.accept_signatures_through_sequence
        AND successor.issued_at_ms <= NEW.changed_at_ms
    )
    AND NOT EXISTS (
      SELECT 1 FROM server_signed_record_acceptances AS acceptance
      WHERE acceptance.collaboration_server_id = OLD.collaboration_server_id
        AND acceptance.signer_scope_certificate_id = OLD.scope_certificate_id
        AND acceptance.signer_sequence > NEW.accept_signatures_through_sequence
    ))
  OR (OLD.state = 'current'
    AND NEW.state = 'revoked'
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.scope_certificate_id IS OLD.scope_certificate_id
    AND NEW.accept_signatures_through_sequence IS NULL
    AND NEW.changed_at_ms >= OLD.changed_at_ms)
  OR (OLD.state = 'retired'
    AND NEW.state = 'revoked'
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.scope_certificate_id IS OLD.scope_certificate_id
    AND NEW.accept_signatures_through_sequence IS NULL
    AND NEW.changed_at_ms >= OLD.changed_at_ms)
)
BEGIN
  SELECT RAISE(ABORT, 'server scope certificate status lifecycle is monotonic');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificate_statuses_no_delete
BEFORE DELETE ON server_scope_certificate_statuses
BEGIN
  SELECT RAISE(ABORT, 'server scope certificate status history is retained');
END`;

const CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_scope_certificate_statuses_no_replace
BEFORE INSERT ON server_scope_certificate_statuses
WHEN EXISTS (
  SELECT 1 FROM server_scope_certificate_statuses
  WHERE collaboration_server_id = NEW.collaboration_server_id
    AND scope_certificate_id = NEW.scope_certificate_id
)
BEGIN
  SELECT RAISE(ABORT, 'server scope certificate status is monotonic');
END`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_REQUIRE_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER server_bootstrap_signing_leases_require_current_authority
BEFORE INSERT ON server_bootstrap_signing_leases
WHEN NEW.state <> 'prepared' OR NEW.purpose <> 'initial_pair' OR NOT EXISTS (
  SELECT 1
  FROM collaboration_servers AS server
  JOIN coordinator_leases AS coordinator
    ON coordinator.coordinator_lease_id = NEW.coordinator_lease_id
   AND coordinator.collaboration_server_id = NEW.collaboration_server_id
   AND coordinator.coordinator_epoch = NEW.coordinator_epoch
  JOIN server_identity_keys AS identity_key
    ON identity_key.collaboration_server_id = NEW.collaboration_server_id
   AND identity_key.identity_key_id = NEW.proposed_identity_key_id
   AND identity_key.key_generation = NEW.proposed_key_generation
  JOIN server_identity_private_key_envelopes AS private_key
    ON private_key.signing_key_ref = NEW.signing_key_ref
   AND private_key.collaboration_server_id = NEW.collaboration_server_id
   AND private_key.identity_key_id = NEW.proposed_identity_key_id
   AND private_key.key_generation = NEW.proposed_key_generation
  WHERE server.collaboration_server_id = NEW.collaboration_server_id
    AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
    AND server.current_coordinator_epoch = NEW.coordinator_epoch
    AND coordinator.state = 'current'
    AND coordinator.released_at_ms IS NULL
    AND coordinator.acquired_at_ms <= NEW.prepared_at_ms
    AND NEW.prepared_at_ms < coordinator.heartbeat_deadline_ms
    AND identity_key.state = 'proposed'
    AND identity_key.trust_evidence_ref = NEW.operator_intent_evidence_ref
    AND identity_key.trust_evidence_digest = NEW.operator_intent_evidence_digest
    AND identity_key.valid_from_ms = NEW.prepared_at_ms
    AND private_key.state = 'current'
    AND private_key.created_at_ms = NEW.prepared_at_ms
    AND NEW.fencing_token = MAX(
      COALESCE((
        SELECT MAX(fencing_token) FROM server_bootstrap_signing_leases
        WHERE collaboration_server_id = NEW.collaboration_server_id
      ), 0),
      COALESCE((
        SELECT MAX(fencing_token) FROM server_signing_leases
        WHERE collaboration_server_id = NEW.collaboration_server_id
      ), 0)
    ) + 1
    AND (
      (NEW.purpose = 'initial_pair'
        AND server.state = 'installing'
        AND server.current_key_generation = 0
        AND NEW.proposed_key_generation = 1)
      OR (NEW.purpose = 'explicit_repair'
        AND server.state = 'repairing'
        AND server.current_scope_certificate_id =
          NEW.expected_prior_scope_certificate_id
        AND server.current_key_generation < 9007199254740991
        AND NEW.proposed_key_generation = server.current_key_generation + 1)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'bootstrap signing lease requires exact operator intent and current authority');
END`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_REQUIRE_INTENT_TRIGGER_SQL = `CREATE TRIGGER server_bootstrap_signing_leases_require_exact_operator_intent
BEFORE INSERT ON server_bootstrap_signing_leases
WHEN NOT EXISTS (
  SELECT 1 FROM protected_artifacts AS artifact
  WHERE artifact.protected_handle_id = NEW.operator_intent_evidence_ref
    AND artifact.kind = 'artifact'
    AND artifact.scope_kind = 'collaboration_server'
    AND artifact.scope_id = NEW.collaboration_server_id
    AND artifact.artifact_schema_id = 'remote-claw/server-signer-bootstrap-intent/v1'
    AND artifact.artifact_digest = NEW.operator_intent_evidence_digest
)
BEGIN
  SELECT RAISE(ABORT, 'bootstrap signing lease requires its exact protected operator intent');
END`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_LIFECYCLE_TRIGGER_SQL = `CREATE TRIGGER server_bootstrap_signing_leases_lifecycle_monotonic
BEFORE UPDATE ON server_bootstrap_signing_leases
WHEN NOT (
  (NEW.bootstrap_signing_lease_id IS OLD.bootstrap_signing_lease_id
    AND NEW.collaboration_server_id IS OLD.collaboration_server_id
    AND NEW.purpose IS OLD.purpose
    AND NEW.operator_intent_evidence_ref IS OLD.operator_intent_evidence_ref
    AND NEW.operator_intent_evidence_digest IS OLD.operator_intent_evidence_digest
    AND NEW.expected_prior_scope_certificate_id IS OLD.expected_prior_scope_certificate_id
    AND NEW.proposed_identity_key_id IS OLD.proposed_identity_key_id
    AND NEW.proposed_key_generation IS OLD.proposed_key_generation
    AND NEW.proposed_scope_certificate_id IS OLD.proposed_scope_certificate_id
    AND NEW.signing_key_ref IS OLD.signing_key_ref
    AND NEW.coordinator_lease_id IS OLD.coordinator_lease_id
    AND NEW.coordinator_epoch IS OLD.coordinator_epoch
    AND NEW.fencing_token IS OLD.fencing_token
    AND NEW.prepared_at_ms IS OLD.prepared_at_ms
    AND (
      (NEW.state IS OLD.state
        AND NEW.signed_at_ms IS OLD.signed_at_ms
        AND NEW.installed_at_ms IS OLD.installed_at_ms
        AND NEW.closed_at_ms IS OLD.closed_at_ms)
      OR (OLD.state = 'prepared'
        AND NEW.state = 'signed'
        AND OLD.signed_at_ms IS NULL
        AND NEW.signed_at_ms IS NOT NULL
        AND NEW.installed_at_ms IS NULL
        AND NEW.closed_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM server_signature_reservations AS reservation
          JOIN server_scope_certificates AS certificate
            ON certificate.collaboration_server_id = reservation.collaboration_server_id
           AND certificate.scope_certificate_id = OLD.proposed_scope_certificate_id
           AND certificate.subject_identity_key_id = OLD.proposed_identity_key_id
           AND certificate.key_generation = OLD.proposed_key_generation
           AND certificate.signer_sequence = reservation.signer_sequence
           AND certificate.canonical_payload_schema_id =
             reservation.canonical_payload_schema_id
           AND certificate.canonical_payload_digest =
             reservation.canonical_payload_digest
           AND certificate.signature = reservation.signature
          WHERE reservation.collaboration_server_id = OLD.collaboration_server_id
            AND reservation.signing_lease_kind = 'bootstrap'
            AND reservation.signing_lease_id = OLD.bootstrap_signing_lease_id
            AND reservation.purpose = 'scope_certificate'
            AND reservation.signed_artifact_type = 'server_scope_certificate'
            AND reservation.signed_artifact_id = OLD.proposed_scope_certificate_id
            AND reservation.signed_at_ms = NEW.signed_at_ms
            AND reservation.state = 'signed'
        ))
      OR (OLD.state = 'signed'
        AND NEW.state = 'installed'
        AND NEW.signed_at_ms IS OLD.signed_at_ms
        AND OLD.installed_at_ms IS NULL
        AND NEW.installed_at_ms IS NOT NULL
        AND NEW.closed_at_ms IS NULL
        AND EXISTS (
          SELECT 1
          FROM server_identity_keys AS identity_key
          JOIN server_scope_certificate_statuses AS certificate_status
            ON certificate_status.collaboration_server_id = identity_key.collaboration_server_id
           AND certificate_status.scope_certificate_id =
             OLD.proposed_scope_certificate_id
          JOIN collaboration_servers AS server
            ON server.collaboration_server_id = identity_key.collaboration_server_id
          JOIN coordinator_leases AS coordinator
            ON coordinator.coordinator_lease_id = OLD.coordinator_lease_id
           AND coordinator.collaboration_server_id = OLD.collaboration_server_id
           AND coordinator.coordinator_epoch = OLD.coordinator_epoch
          JOIN server_signature_reservations AS reservation
            ON reservation.collaboration_server_id = OLD.collaboration_server_id
           AND reservation.signing_lease_kind = 'bootstrap'
           AND reservation.signing_lease_id = OLD.bootstrap_signing_lease_id
           AND reservation.purpose = 'scope_certificate'
           AND reservation.signed_artifact_type = 'server_scope_certificate'
           AND reservation.signed_artifact_id = OLD.proposed_scope_certificate_id
           AND reservation.state = 'signed'
          JOIN server_signed_record_acceptances AS acceptance
            ON acceptance.collaboration_server_id = reservation.collaboration_server_id
           AND acceptance.signer_sequence = reservation.signer_sequence
           AND acceptance.signed_record_digest = reservation.signed_record_digest
           AND acceptance.signer_identity_key_id = OLD.proposed_identity_key_id
           AND acceptance.signer_key_generation = OLD.proposed_key_generation
           AND acceptance.signer_scope_certificate_id =
             OLD.proposed_scope_certificate_id
          WHERE identity_key.collaboration_server_id = OLD.collaboration_server_id
            AND identity_key.identity_key_id = OLD.proposed_identity_key_id
            AND identity_key.key_generation = OLD.proposed_key_generation
            AND identity_key.introduced_by_scope_certificate_id =
              OLD.proposed_scope_certificate_id
            AND identity_key.state = 'current'
            AND certificate_status.state = 'current'
            AND certificate_status.change_evidence_ref =
              OLD.operator_intent_evidence_ref
            AND certificate_status.change_evidence_digest =
              OLD.operator_intent_evidence_digest
            AND server.state = 'installing'
            AND server.current_coordinator_lease_id = OLD.coordinator_lease_id
            AND server.current_coordinator_epoch = OLD.coordinator_epoch
            AND coordinator.state = 'current'
            AND coordinator.released_at_ms IS NULL
            AND coordinator.acquired_at_ms <= NEW.installed_at_ms
            AND NEW.installed_at_ms < coordinator.heartbeat_deadline_ms
        ))
      OR (OLD.state = 'installed'
        AND NEW.state = 'closed'
        AND NEW.signed_at_ms IS OLD.signed_at_ms
        AND NEW.installed_at_ms IS OLD.installed_at_ms
        AND OLD.closed_at_ms IS NULL
        AND NEW.closed_at_ms IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM collaboration_servers AS server
          JOIN server_signing_leases AS signing_lease
            ON signing_lease.collaboration_server_id = server.collaboration_server_id
           AND signing_lease.identity_key_id = server.current_identity_key_id
           AND signing_lease.key_generation = server.current_key_generation
           AND signing_lease.scope_certificate_id = server.current_scope_certificate_id
          WHERE server.collaboration_server_id = OLD.collaboration_server_id
            AND server.state = 'current'
            AND server.current_identity_key_id = OLD.proposed_identity_key_id
            AND server.current_key_generation = OLD.proposed_key_generation
            AND server.current_scope_certificate_id = OLD.proposed_scope_certificate_id
            AND signing_lease.coordinator_lease_id = OLD.coordinator_lease_id
            AND signing_lease.coordinator_epoch = OLD.coordinator_epoch
            AND signing_lease.state = 'current'
        ))
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'bootstrap signing lease lifecycle is monotonic');
END`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_bootstrap_signing_leases_no_delete
BEFORE DELETE ON server_bootstrap_signing_leases
BEGIN
  SELECT RAISE(ABORT, 'bootstrap signing lease history is retained');
END`;

const CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_bootstrap_signing_leases_no_replace
BEFORE INSERT ON server_bootstrap_signing_leases
WHEN EXISTS (
  SELECT 1 FROM server_bootstrap_signing_leases
  WHERE bootstrap_signing_lease_id = NEW.bootstrap_signing_lease_id
)
BEGIN
  SELECT RAISE(ABORT, 'bootstrap signing leases are immutable');
END`;

const CREATE_SERVER_SIGNING_LEASES_REQUIRE_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER server_signing_leases_require_current_authority
BEFORE INSERT ON server_signing_leases
WHEN NEW.state <> 'current' OR NOT EXISTS (
  SELECT 1
  FROM collaboration_servers AS server
  JOIN coordinator_leases AS coordinator
    ON coordinator.coordinator_lease_id = NEW.coordinator_lease_id
   AND coordinator.collaboration_server_id = NEW.collaboration_server_id
   AND coordinator.coordinator_epoch = NEW.coordinator_epoch
  JOIN server_identity_keys AS identity_key
    ON identity_key.collaboration_server_id = NEW.collaboration_server_id
   AND identity_key.identity_key_id = NEW.identity_key_id
   AND identity_key.key_generation = NEW.key_generation
  JOIN server_identity_private_key_envelopes AS private_key
    ON private_key.signing_key_ref = identity_key.signing_key_ref
   AND private_key.collaboration_server_id = identity_key.collaboration_server_id
   AND private_key.identity_key_id = identity_key.identity_key_id
   AND private_key.key_generation = identity_key.key_generation
  JOIN server_scope_certificates AS certificate
    ON certificate.collaboration_server_id = NEW.collaboration_server_id
   AND certificate.scope_certificate_id = NEW.scope_certificate_id
   AND certificate.subject_identity_key_id = NEW.identity_key_id
   AND certificate.key_generation = NEW.key_generation
  JOIN server_scope_certificate_statuses AS certificate_status
    ON certificate_status.collaboration_server_id = certificate.collaboration_server_id
   AND certificate_status.scope_certificate_id = certificate.scope_certificate_id
  WHERE server.collaboration_server_id = NEW.collaboration_server_id
    AND server.state = 'current'
    AND server.current_identity_key_id = NEW.identity_key_id
    AND server.current_key_generation = NEW.key_generation
    AND server.current_scope_certificate_id = NEW.scope_certificate_id
    AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
    AND server.current_coordinator_epoch = NEW.coordinator_epoch
    AND coordinator.state = 'current'
    AND coordinator.released_at_ms IS NULL
    AND coordinator.acquired_at_ms <= NEW.acquired_at_ms
    AND NEW.acquired_at_ms < coordinator.heartbeat_deadline_ms
    AND identity_key.state = 'current'
    AND private_key.state = 'current'
    AND certificate_status.state = 'current'
    AND NEW.fencing_token = MAX(
      COALESCE((
        SELECT MAX(fencing_token) FROM server_bootstrap_signing_leases
        WHERE collaboration_server_id = NEW.collaboration_server_id
      ), 0),
      COALESCE((
        SELECT MAX(fencing_token) FROM server_signing_leases
        WHERE collaboration_server_id = NEW.collaboration_server_id
      ), 0)
    ) + 1
)
BEGIN
  SELECT RAISE(ABORT, 'server signing lease requires its exact current authority and next fence');
END`;

const CREATE_SERVER_SIGNING_LEASES_LIFECYCLE_TRIGGER_SQL = `CREATE TRIGGER server_signing_leases_lifecycle_monotonic
BEFORE UPDATE ON server_signing_leases
WHEN NOT (
  NEW.signing_lease_id IS OLD.signing_lease_id
  AND NEW.collaboration_server_id IS OLD.collaboration_server_id
  AND NEW.identity_key_id IS OLD.identity_key_id
  AND NEW.key_generation IS OLD.key_generation
  AND NEW.scope_certificate_id IS OLD.scope_certificate_id
  AND NEW.coordinator_lease_id IS OLD.coordinator_lease_id
  AND NEW.coordinator_epoch IS OLD.coordinator_epoch
  AND NEW.fencing_token IS OLD.fencing_token
  AND NEW.acquired_at_ms IS OLD.acquired_at_ms
  AND (
    (NEW.state IS OLD.state
      AND NEW.draining_at_ms IS OLD.draining_at_ms
      AND NEW.superseded_at_ms IS OLD.superseded_at_ms
      AND NEW.closed_at_ms IS OLD.closed_at_ms)
    OR (OLD.state = 'current'
      AND NEW.state = 'draining'
      AND OLD.draining_at_ms IS NULL
      AND NEW.draining_at_ms IS NOT NULL
      AND NEW.superseded_at_ms IS NULL
      AND NEW.closed_at_ms IS NULL)
    OR (OLD.state IN ('current', 'draining')
      AND NEW.state = 'superseded'
      AND NEW.draining_at_ms IS OLD.draining_at_ms
      AND OLD.superseded_at_ms IS NULL
      AND NEW.superseded_at_ms IS NOT NULL
      AND NEW.closed_at_ms IS NULL)
    OR (OLD.state IN ('current', 'draining', 'superseded')
      AND NEW.state = 'closed'
      AND NEW.draining_at_ms IS OLD.draining_at_ms
      AND NEW.superseded_at_ms IS OLD.superseded_at_ms
      AND OLD.closed_at_ms IS NULL
      AND NEW.closed_at_ms IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'server signing lease lifecycle is monotonic');
END`;

const CREATE_SERVER_SIGNING_LEASES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_signing_leases_no_delete
BEFORE DELETE ON server_signing_leases
BEGIN
  SELECT RAISE(ABORT, 'server signing lease history is retained');
END`;

const CREATE_SERVER_SIGNING_LEASES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_signing_leases_no_replace
BEFORE INSERT ON server_signing_leases
WHEN EXISTS (
  SELECT 1 FROM server_signing_leases
  WHERE signing_lease_id = NEW.signing_lease_id
)
BEGIN
  SELECT RAISE(ABORT, 'server signing leases are immutable');
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_REQUIRE_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_require_current_authority
BEFORE INSERT ON server_signature_reservations
WHEN NEW.state <> 'reserved'
  OR NEW.signing_lease_kind <> 'bootstrap'
  OR NEW.purpose <> 'scope_certificate'
  OR NOT EXISTS (
  SELECT 1
  FROM collaboration_servers AS server
  WHERE server.collaboration_server_id = NEW.collaboration_server_id
    AND server.next_server_signature_seq = NEW.signer_sequence
    AND (
      (NEW.signing_lease_kind = 'bootstrap'
        AND NEW.purpose = 'scope_certificate'
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
            AND bootstrap.prepared_at_ms <= NEW.reserved_at_ms
            AND NEW.signer_sequence = 0
            AND NEW.reserved_at_ms = bootstrap.prepared_at_ms
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
            AND server.state = 'current'
            AND server.current_identity_key_id = signing_lease.identity_key_id
            AND server.current_key_generation = signing_lease.key_generation
            AND server.current_scope_certificate_id = signing_lease.scope_certificate_id
            AND server.current_coordinator_lease_id = signing_lease.coordinator_lease_id
            AND server.current_coordinator_epoch = signing_lease.coordinator_epoch
            AND coordinator.state = 'current'
            AND coordinator.released_at_ms IS NULL
            AND coordinator.acquired_at_ms <= NEW.reserved_at_ms
            AND NEW.reserved_at_ms < coordinator.heartbeat_deadline_ms
            AND identity_key.state = 'current'
            AND private_key.state = 'current'
            AND certificate_status.state = 'current'
            AND (
              (NEW.purpose = 'scope_certificate' AND signing_lease.state = 'draining')
              OR (NEW.purpose <> 'scope_certificate' AND signing_lease.state = 'current')
            )
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signature reservation requires the exact current signing authority');
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_INCREMENT_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_increment_sequence
AFTER INSERT ON server_signature_reservations
BEGIN
  UPDATE collaboration_servers
  SET next_server_signature_seq = next_server_signature_seq + 1
  WHERE collaboration_server_id = NEW.collaboration_server_id
    AND next_server_signature_seq = NEW.signer_sequence;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'server signature sequence advance lost its compare-and-swap') END;
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_IDENTITY_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_identity_immutable
BEFORE UPDATE ON server_signature_reservations
WHEN NEW.collaboration_server_id IS NOT OLD.collaboration_server_id
  OR NEW.signer_sequence IS NOT OLD.signer_sequence
  OR NEW.signing_lease_id IS NOT OLD.signing_lease_id
  OR NEW.signing_lease_kind IS NOT OLD.signing_lease_kind
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.reserved_at_ms IS NOT OLD.reserved_at_ms
BEGIN
  SELECT RAISE(ABORT, 'signature reservation identity and purpose are immutable');
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_LIFECYCLE_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_lifecycle_monotonic
BEFORE UPDATE ON server_signature_reservations
WHEN NOT (
  (NEW.state IS OLD.state
    AND NEW.canonical_payload_schema_id IS OLD.canonical_payload_schema_id
    AND NEW.canonical_payload_ref IS OLD.canonical_payload_ref
    AND NEW.canonical_payload_digest IS OLD.canonical_payload_digest
    AND NEW.signed_record_digest IS OLD.signed_record_digest
    AND NEW.signature IS OLD.signature
    AND NEW.signed_artifact_type IS OLD.signed_artifact_type
    AND NEW.signed_artifact_id IS OLD.signed_artifact_id
    AND NEW.bound_at_ms IS OLD.bound_at_ms
    AND NEW.signed_at_ms IS OLD.signed_at_ms
    AND NEW.aborted_at_ms IS OLD.aborted_at_ms)
  OR (OLD.state = 'reserved'
    AND NEW.state = 'bound'
    AND OLD.canonical_payload_schema_id IS NULL
    AND OLD.canonical_payload_ref IS NULL
    AND OLD.canonical_payload_digest IS NULL
    AND OLD.signed_artifact_type IS NULL
    AND OLD.signed_artifact_id IS NULL
    AND OLD.bound_at_ms IS NULL
    AND NEW.canonical_payload_schema_id IS NOT NULL
    AND NEW.canonical_payload_ref IS NOT NULL
    AND NEW.canonical_payload_digest IS NOT NULL
    AND NEW.signed_artifact_type IS NOT NULL
    AND NEW.signed_artifact_id IS NOT NULL
    AND NEW.bound_at_ms IS NOT NULL
    AND NEW.signed_record_digest IS NULL
    AND NEW.signature IS NULL
    AND NEW.signed_at_ms IS NULL
    AND NEW.aborted_at_ms IS NULL)
  OR (OLD.state = 'bound'
    AND NEW.state = 'signed'
    AND NEW.canonical_payload_schema_id IS OLD.canonical_payload_schema_id
    AND NEW.canonical_payload_ref IS OLD.canonical_payload_ref
    AND NEW.canonical_payload_digest IS OLD.canonical_payload_digest
    AND NEW.signed_artifact_type IS OLD.signed_artifact_type
    AND NEW.signed_artifact_id IS OLD.signed_artifact_id
    AND NEW.bound_at_ms IS OLD.bound_at_ms
    AND NEW.signed_record_digest IS NOT NULL
    AND NEW.signature IS NOT NULL
    AND NEW.signed_at_ms IS NOT NULL
    AND NEW.aborted_at_ms IS NULL)
  OR (OLD.state IN ('reserved', 'bound')
    AND NEW.state = 'aborted'
    AND NEW.canonical_payload_schema_id IS OLD.canonical_payload_schema_id
    AND NEW.canonical_payload_ref IS OLD.canonical_payload_ref
    AND NEW.canonical_payload_digest IS OLD.canonical_payload_digest
    AND NEW.signed_artifact_type IS OLD.signed_artifact_type
    AND NEW.signed_artifact_id IS OLD.signed_artifact_id
    AND NEW.bound_at_ms IS OLD.bound_at_ms
    AND NEW.signed_record_digest IS NULL
    AND NEW.signature IS NULL
    AND NEW.signed_at_ms IS NULL
    AND NEW.aborted_at_ms IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'signature reservation lifecycle is monotonic');
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_BIND_SIGN_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_require_live_lease_to_bind_or_sign
BEFORE UPDATE ON server_signature_reservations
WHEN NEW.state IN ('bound', 'signed') AND NEW.state <> OLD.state
  AND NOT EXISTS (
    SELECT 1 FROM collaboration_servers AS server
    WHERE server.collaboration_server_id = OLD.collaboration_server_id
      AND (
        (OLD.signing_lease_kind = 'bootstrap'
          AND OLD.purpose = 'scope_certificate'
          AND EXISTS (
            SELECT 1
            FROM server_bootstrap_signing_leases AS bootstrap
            JOIN coordinator_leases AS coordinator
              ON coordinator.coordinator_lease_id = bootstrap.coordinator_lease_id
             AND coordinator.collaboration_server_id = bootstrap.collaboration_server_id
             AND coordinator.coordinator_epoch = bootstrap.coordinator_epoch
            WHERE bootstrap.bootstrap_signing_lease_id = OLD.signing_lease_id
              AND bootstrap.collaboration_server_id = OLD.collaboration_server_id
              AND bootstrap.state = 'prepared'
              AND server.current_coordinator_lease_id = bootstrap.coordinator_lease_id
              AND server.current_coordinator_epoch = bootstrap.coordinator_epoch
              AND coordinator.state = 'current'
              AND coordinator.released_at_ms IS NULL
              AND coordinator.acquired_at_ms <= COALESCE(NEW.signed_at_ms, NEW.bound_at_ms)
              AND COALESCE(NEW.signed_at_ms, NEW.bound_at_ms) < coordinator.heartbeat_deadline_ms
          ))
        OR (OLD.signing_lease_kind = 'current'
          AND EXISTS (
            SELECT 1
            FROM server_signing_leases AS signing_lease
            JOIN coordinator_leases AS coordinator
              ON coordinator.coordinator_lease_id = signing_lease.coordinator_lease_id
             AND coordinator.collaboration_server_id = signing_lease.collaboration_server_id
             AND coordinator.coordinator_epoch = signing_lease.coordinator_epoch
            WHERE signing_lease.signing_lease_id = OLD.signing_lease_id
              AND signing_lease.collaboration_server_id = OLD.collaboration_server_id
              AND server.current_identity_key_id = signing_lease.identity_key_id
              AND server.current_key_generation = signing_lease.key_generation
              AND server.current_scope_certificate_id = signing_lease.scope_certificate_id
              AND server.current_coordinator_lease_id = signing_lease.coordinator_lease_id
              AND server.current_coordinator_epoch = signing_lease.coordinator_epoch
              AND coordinator.state = 'current'
              AND coordinator.released_at_ms IS NULL
              AND coordinator.acquired_at_ms <= COALESCE(NEW.signed_at_ms, NEW.bound_at_ms)
              AND COALESCE(NEW.signed_at_ms, NEW.bound_at_ms) < coordinator.heartbeat_deadline_ms
              AND (
                (OLD.purpose = 'scope_certificate' AND signing_lease.state = 'draining')
                OR (OLD.purpose <> 'scope_certificate' AND signing_lease.state = 'current')
              )
          ))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'signature binding and signing require the live reserved lease');
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_REQUIRE_PAYLOAD_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_require_exact_payload_artifact
BEFORE UPDATE ON server_signature_reservations
WHEN NEW.state = 'bound' AND OLD.state = 'reserved'
  AND NOT EXISTS (
    SELECT 1 FROM protected_artifacts AS artifact
    WHERE artifact.protected_handle_id = NEW.canonical_payload_ref
      AND artifact.kind = 'artifact'
      AND artifact.scope_kind = 'collaboration_server'
      AND artifact.scope_id = NEW.collaboration_server_id
      AND artifact.artifact_schema_id = NEW.canonical_payload_schema_id
      AND artifact.artifact_digest = NEW.canonical_payload_digest
  )
BEGIN
  SELECT RAISE(ABORT, 'signature binding requires its exact protected canonical payload');
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_no_delete
BEFORE DELETE ON server_signature_reservations
BEGIN
  SELECT RAISE(ABORT, 'signature reservation history is retained');
END`;

const CREATE_SERVER_SIGNATURE_RESERVATIONS_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_signature_reservations_no_replace
BEFORE INSERT ON server_signature_reservations
WHEN EXISTS (
  SELECT 1 FROM server_signature_reservations
  WHERE collaboration_server_id = NEW.collaboration_server_id
    AND signer_sequence = NEW.signer_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'signature reservations are immutable');
END`;

const CREATE_SERVER_ACCEPTANCES_HISTORICAL_INDEX_SQL = `CREATE UNIQUE INDEX server_signed_record_acceptances_historical_reattestation_unique
ON server_signed_record_acceptances (
  collaboration_server_id,
  historical_reattestation_id
)
WHERE historical_reattestation_id IS NOT NULL`;

const CREATE_SERVER_ACCEPTANCES_DIGEST_INDEX_SQL = `CREATE UNIQUE INDEX server_signed_record_acceptances_signed_digest_unique
ON server_signed_record_acceptances (signed_record_digest)`;

const CREATE_SERVER_ACCEPTANCES_SIGNER_SEQUENCE_INDEX_SQL = `CREATE UNIQUE INDEX server_signed_record_acceptances_signer_sequence_unique
ON server_signed_record_acceptances (collaboration_server_id, signer_sequence)`;

const CREATE_SERVER_ACCEPTANCES_REQUIRE_NEXT_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER server_signed_record_acceptances_require_next_sequence
BEFORE INSERT ON server_signed_record_acceptances
WHEN NEW.accepted_at_journal_seq <> COALESCE((
  SELECT MAX(accepted_at_journal_seq) + 1
  FROM server_signed_record_acceptances
  WHERE collaboration_server_id = NEW.collaboration_server_id
), 0)
BEGIN
  SELECT RAISE(ABORT, 'signed record acceptance must use the next dense journal sequence');
END`;

const CREATE_SERVER_ACCEPTANCES_REQUIRE_SIGNED_TRIGGER_SQL = `CREATE TRIGGER server_signed_record_acceptances_require_exact_signed_record
BEFORE INSERT ON server_signed_record_acceptances
WHEN NOT EXISTS (
  SELECT 1
  FROM server_signature_reservations AS reservation
  JOIN server_scope_certificates AS signer_certificate
    ON signer_certificate.collaboration_server_id = NEW.collaboration_server_id
   AND signer_certificate.scope_certificate_id = NEW.signer_scope_certificate_id
   AND signer_certificate.subject_identity_key_id = NEW.signer_identity_key_id
   AND signer_certificate.key_generation = NEW.signer_key_generation
  JOIN server_scope_certificate_statuses AS signer_status
    ON signer_status.collaboration_server_id = signer_certificate.collaboration_server_id
   AND signer_status.scope_certificate_id = signer_certificate.scope_certificate_id
  WHERE reservation.collaboration_server_id = NEW.collaboration_server_id
    AND reservation.signer_sequence = NEW.signer_sequence
    AND reservation.signed_record_digest = NEW.signed_record_digest
    AND reservation.state = 'signed'
    AND reservation.signed_at_ms <= NEW.accepted_at_ms
    AND (
      (reservation.signing_lease_kind = 'current'
        AND EXISTS (
          SELECT 1 FROM server_signing_leases AS signing_lease
          WHERE signing_lease.signing_lease_id = reservation.signing_lease_id
            AND signing_lease.collaboration_server_id = reservation.collaboration_server_id
            AND signing_lease.identity_key_id = NEW.signer_identity_key_id
            AND signing_lease.key_generation = NEW.signer_key_generation
            AND signing_lease.scope_certificate_id = NEW.signer_scope_certificate_id
            AND (
              NEW.historical_reattestation_id IS NOT NULL
              OR (signing_lease.state IN ('current', 'draining') AND EXISTS (
                SELECT 1
                FROM collaboration_servers AS server
                JOIN coordinator_leases AS coordinator
                  ON coordinator.coordinator_lease_id = signing_lease.coordinator_lease_id
                 AND coordinator.collaboration_server_id = signing_lease.collaboration_server_id
                 AND coordinator.coordinator_epoch = signing_lease.coordinator_epoch
                WHERE server.collaboration_server_id = signing_lease.collaboration_server_id
                  AND server.state = 'current'
                  AND server.current_identity_key_id = signing_lease.identity_key_id
                  AND server.current_key_generation = signing_lease.key_generation
                  AND server.current_scope_certificate_id = signing_lease.scope_certificate_id
                  AND server.current_coordinator_lease_id = signing_lease.coordinator_lease_id
                  AND server.current_coordinator_epoch = signing_lease.coordinator_epoch
                  AND coordinator.state = 'current'
                  AND coordinator.released_at_ms IS NULL
                  AND coordinator.acquired_at_ms <= NEW.accepted_at_ms
                  AND NEW.accepted_at_ms < coordinator.heartbeat_deadline_ms
              ))
            )
        ))
      OR (reservation.signing_lease_kind = 'bootstrap'
        AND reservation.purpose = 'scope_certificate'
        AND EXISTS (
          SELECT 1 FROM server_bootstrap_signing_leases AS bootstrap
          WHERE bootstrap.bootstrap_signing_lease_id = reservation.signing_lease_id
            AND bootstrap.collaboration_server_id = reservation.collaboration_server_id
            AND bootstrap.proposed_identity_key_id = NEW.signer_identity_key_id
            AND bootstrap.proposed_key_generation = NEW.signer_key_generation
            AND bootstrap.proposed_scope_certificate_id = NEW.signer_scope_certificate_id
            AND (
              NEW.historical_reattestation_id IS NOT NULL
              OR (bootstrap.state = 'signed' AND EXISTS (
                SELECT 1
                FROM collaboration_servers AS server
                JOIN coordinator_leases AS coordinator
                  ON coordinator.coordinator_lease_id = bootstrap.coordinator_lease_id
                 AND coordinator.collaboration_server_id = bootstrap.collaboration_server_id
                 AND coordinator.coordinator_epoch = bootstrap.coordinator_epoch
                WHERE server.collaboration_server_id = bootstrap.collaboration_server_id
                  AND server.state = 'installing'
                  AND server.current_coordinator_lease_id = bootstrap.coordinator_lease_id
                  AND server.current_coordinator_epoch = bootstrap.coordinator_epoch
                  AND coordinator.state = 'current'
                  AND coordinator.released_at_ms IS NULL
                  AND coordinator.acquired_at_ms <= NEW.accepted_at_ms
                  AND NEW.accepted_at_ms < coordinator.heartbeat_deadline_ms
              ))
            )
        ))
    )
    AND (
      (signer_status.state = 'current' AND NEW.historical_reattestation_id IS NULL)
      OR (signer_status.state = 'retired'
        AND signer_status.accept_signatures_through_sequence IS NOT NULL
        AND NEW.signer_sequence <= signer_status.accept_signatures_through_sequence
        AND NEW.historical_reattestation_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM server_signed_record_acceptances AS reattestation_acceptance
          JOIN server_signature_reservations AS reattestation_reservation
            ON reattestation_reservation.collaboration_server_id =
              reattestation_acceptance.collaboration_server_id
           AND reattestation_reservation.signer_sequence =
             reattestation_acceptance.signer_sequence
           AND reattestation_reservation.signed_record_digest =
             reattestation_acceptance.signed_record_digest
          JOIN server_scope_certificate_statuses AS reattester_status
            ON reattester_status.collaboration_server_id =
              reattestation_acceptance.collaboration_server_id
           AND reattester_status.scope_certificate_id =
             reattestation_acceptance.signer_scope_certificate_id
          WHERE reattestation_acceptance.collaboration_server_id =
              NEW.collaboration_server_id
            AND reattestation_reservation.purpose = 'historical_reattestation'
            AND reattestation_reservation.signed_artifact_id =
              NEW.historical_reattestation_id
            AND reattester_status.state = 'current'
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signed record acceptance requires its exact trusted signed reservation');
END`;

const CREATE_SERVER_ACCEPTANCES_NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER server_signed_record_acceptances_no_update
BEFORE UPDATE ON server_signed_record_acceptances
BEGIN
  SELECT RAISE(ABORT, 'signed record acceptances are immutable');
END`;

const CREATE_SERVER_ACCEPTANCES_NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER server_signed_record_acceptances_no_delete
BEFORE DELETE ON server_signed_record_acceptances
BEGIN
  SELECT RAISE(ABORT, 'signed record acceptance history is retained');
END`;

const CREATE_SERVER_ACCEPTANCES_NO_REPLACE_TRIGGER_SQL = `CREATE TRIGGER server_signed_record_acceptances_no_replace
BEFORE INSERT ON server_signed_record_acceptances
WHEN EXISTS (
  SELECT 1 FROM server_signed_record_acceptances
  WHERE signed_record_digest = NEW.signed_record_digest
    OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND signer_sequence = NEW.signer_sequence
    )
    OR (
      collaboration_server_id = NEW.collaboration_server_id
      AND accepted_at_journal_seq = NEW.accepted_at_journal_seq
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signed record acceptances are immutable');
END`;

const CREATE_COLLABORATION_SERVERS_SIGNATURE_SEQUENCE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_signature_sequence_monotonic
BEFORE UPDATE OF next_server_signature_seq ON collaboration_servers
WHEN NEW.next_server_signature_seq <> OLD.next_server_signature_seq
  AND NOT (
    OLD.next_server_signature_seq < 9007199254740991
    AND NEW.next_server_signature_seq = OLD.next_server_signature_seq + 1
    AND EXISTS (
      SELECT 1 FROM server_signature_reservations AS reservation
      WHERE reservation.collaboration_server_id = OLD.collaboration_server_id
        AND reservation.signer_sequence = OLD.next_server_signature_seq
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'server signature sequence must advance only after its reservation');
END`;

const CREATE_COLLABORATION_SERVERS_SIGNING_SCOPE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_signing_scope_transition
BEFORE UPDATE ON collaboration_servers
WHEN (
  NEW.current_key_generation IS NOT OLD.current_key_generation
  OR NEW.current_identity_key_id IS NOT OLD.current_identity_key_id
  OR NEW.current_scope_certificate_id IS NOT OLD.current_scope_certificate_id
) AND NOT (
  OLD.current_key_generation < 9007199254740991
  AND NEW.current_key_generation = OLD.current_key_generation + 1
  AND EXISTS (
    SELECT 1
    FROM server_identity_keys AS identity_key
    JOIN server_scope_certificates AS certificate
      ON certificate.collaboration_server_id = identity_key.collaboration_server_id
     AND certificate.subject_identity_key_id = identity_key.identity_key_id
     AND certificate.key_generation = identity_key.key_generation
    JOIN server_scope_certificate_statuses AS certificate_status
      ON certificate_status.collaboration_server_id = certificate.collaboration_server_id
     AND certificate_status.scope_certificate_id = certificate.scope_certificate_id
    JOIN server_identity_private_key_envelopes AS private_key
      ON private_key.signing_key_ref = identity_key.signing_key_ref
     AND private_key.collaboration_server_id = identity_key.collaboration_server_id
     AND private_key.identity_key_id = identity_key.identity_key_id
     AND private_key.key_generation = identity_key.key_generation
    WHERE identity_key.collaboration_server_id = OLD.collaboration_server_id
      AND identity_key.identity_key_id = NEW.current_identity_key_id
      AND identity_key.key_generation = NEW.current_key_generation
      AND identity_key.state = 'current'
      AND certificate.scope_certificate_id = NEW.current_scope_certificate_id
      AND certificate_status.state = 'current'
      AND private_key.state = 'current'
      AND (
        (OLD.current_key_generation = 0
          AND EXISTS (
            SELECT 1 FROM server_bootstrap_signing_leases AS bootstrap
            WHERE bootstrap.collaboration_server_id = OLD.collaboration_server_id
              AND bootstrap.purpose = 'initial_pair'
              AND bootstrap.proposed_identity_key_id = NEW.current_identity_key_id
              AND bootstrap.proposed_key_generation = NEW.current_key_generation
              AND bootstrap.proposed_scope_certificate_id =
                NEW.current_scope_certificate_id
              AND bootstrap.state = 'installed'
              AND bootstrap.coordinator_lease_id = OLD.current_coordinator_lease_id
              AND bootstrap.coordinator_epoch = OLD.current_coordinator_epoch
              AND EXISTS (
                SELECT 1
                FROM server_signature_reservations AS reservation
                JOIN server_signed_record_acceptances AS acceptance
                  ON acceptance.collaboration_server_id = reservation.collaboration_server_id
                 AND acceptance.signer_sequence = reservation.signer_sequence
                 AND acceptance.signed_record_digest = reservation.signed_record_digest
                WHERE reservation.collaboration_server_id = OLD.collaboration_server_id
                  AND reservation.signing_lease_kind = 'bootstrap'
                  AND reservation.signing_lease_id = bootstrap.bootstrap_signing_lease_id
                  AND reservation.purpose = 'scope_certificate'
                  AND reservation.signed_artifact_type = 'server_scope_certificate'
                  AND reservation.signed_artifact_id = NEW.current_scope_certificate_id
                  AND reservation.state = 'signed'
                  AND acceptance.signer_identity_key_id = NEW.current_identity_key_id
                  AND acceptance.signer_key_generation = NEW.current_key_generation
                  AND acceptance.signer_scope_certificate_id =
                    NEW.current_scope_certificate_id
              )
          ))
        OR (OLD.current_key_generation > 0
          AND (
            (certificate.supersedes_scope_certificate_id =
                OLD.current_scope_certificate_id
              AND EXISTS (
                SELECT 1 FROM server_scope_certificate_statuses AS predecessor_status
                JOIN server_identity_keys AS predecessor_key
                  ON predecessor_key.collaboration_server_id =
                    predecessor_status.collaboration_server_id
                 AND predecessor_key.introduced_by_scope_certificate_id =
                   predecessor_status.scope_certificate_id
                WHERE predecessor_status.collaboration_server_id =
                    OLD.collaboration_server_id
                  AND predecessor_status.scope_certificate_id =
                    OLD.current_scope_certificate_id
                  AND predecessor_status.state = 'retired'
                  AND predecessor_key.identity_key_id = OLD.current_identity_key_id
                  AND predecessor_key.key_generation = OLD.current_key_generation
                  AND predecessor_key.state = 'retired'
              ))
            OR EXISTS (
              SELECT 1 FROM server_bootstrap_signing_leases AS bootstrap
              WHERE bootstrap.collaboration_server_id = OLD.collaboration_server_id
                AND bootstrap.purpose = 'explicit_repair'
                AND bootstrap.expected_prior_scope_certificate_id =
                  OLD.current_scope_certificate_id
                AND bootstrap.proposed_identity_key_id = NEW.current_identity_key_id
                AND bootstrap.proposed_key_generation = NEW.current_key_generation
                AND bootstrap.proposed_scope_certificate_id =
                  NEW.current_scope_certificate_id
                AND bootstrap.state = 'installed'
            )
          ))
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration server signing scope transition is not certified');
END`;

const CREATE_COLLABORATION_SERVERS_CURRENT_SCOPE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_require_current_signing_scope
BEFORE UPDATE OF state ON collaboration_servers
WHEN NEW.state = 'current' AND NOT EXISTS (
  SELECT 1
  FROM server_identity_keys AS identity_key
  JOIN server_scope_certificates AS certificate
    ON certificate.collaboration_server_id = identity_key.collaboration_server_id
   AND certificate.subject_identity_key_id = identity_key.identity_key_id
   AND certificate.key_generation = identity_key.key_generation
  JOIN server_scope_certificate_statuses AS certificate_status
    ON certificate_status.collaboration_server_id = certificate.collaboration_server_id
   AND certificate_status.scope_certificate_id = certificate.scope_certificate_id
  JOIN server_identity_private_key_envelopes AS private_key
    ON private_key.signing_key_ref = identity_key.signing_key_ref
   AND private_key.collaboration_server_id = identity_key.collaboration_server_id
   AND private_key.identity_key_id = identity_key.identity_key_id
   AND private_key.key_generation = identity_key.key_generation
  WHERE identity_key.collaboration_server_id = NEW.collaboration_server_id
    AND identity_key.identity_key_id = NEW.current_identity_key_id
    AND identity_key.key_generation = NEW.current_key_generation
    AND identity_key.state = 'current'
    AND certificate.scope_certificate_id = NEW.current_scope_certificate_id
    AND certificate_status.state = 'current'
    AND private_key.state = 'current'
)
BEGIN
  SELECT RAISE(ABORT, 'current collaboration server requires its exact current signing scope');
END`;

const CREATE_COLLABORATION_SERVERS_COORDINATOR_SIGNING_FENCE_TRIGGER_SQL = `CREATE TRIGGER collaboration_servers_coordinator_change_supersedes_signing_lease
AFTER UPDATE ON collaboration_servers
WHEN NEW.current_coordinator_lease_id IS NOT OLD.current_coordinator_lease_id
  OR NEW.current_coordinator_epoch <> OLD.current_coordinator_epoch
BEGIN
  UPDATE server_signing_leases
  SET state = 'superseded',
      superseded_at_ms = MAX(
        acquired_at_ms,
        COALESCE(
          (SELECT acquired_at_ms FROM coordinator_leases
           WHERE coordinator_lease_id = NEW.current_coordinator_lease_id
             AND collaboration_server_id = NEW.collaboration_server_id
             AND coordinator_epoch = NEW.current_coordinator_epoch),
          (SELECT released_at_ms FROM coordinator_leases
           WHERE coordinator_lease_id = OLD.current_coordinator_lease_id
             AND collaboration_server_id = OLD.collaboration_server_id
             AND coordinator_epoch = OLD.current_coordinator_epoch),
          (SELECT heartbeat_deadline_ms FROM coordinator_leases
           WHERE coordinator_lease_id = OLD.current_coordinator_lease_id
             AND collaboration_server_id = OLD.collaboration_server_id
             AND coordinator_epoch = OLD.current_coordinator_epoch),
          acquired_at_ms
        )
      )
  WHERE collaboration_server_id = OLD.collaboration_server_id
    AND state IN ('current', 'draining');
END`;

const CREATE_BROKER_ROUTES_REQUIRE_CURRENT_AUTHORITY_TRIGGER_SQL = `CREATE TRIGGER broker_routes_require_current_authority
BEFORE INSERT ON broker_routes
BEGIN
  SELECT CASE WHEN NEW.state <> 'current' OR NOT EXISTS (
    SELECT 1
      FROM collaboration_servers AS server
      JOIN coordinator_leases AS lease
        ON lease.coordinator_lease_id = NEW.coordinator_lease_id
       AND lease.collaboration_server_id = NEW.collaboration_server_id
       AND lease.coordinator_epoch = NEW.coordinator_epoch
      JOIN broker_backend_capability_pins AS capability_pin
        ON capability_pin.broker_backend_capability_pin_id =
          NEW.broker_backend_capabilities_ref
       AND capability_pin.machine_identity_id = NEW.machine_identity_id
       AND capability_pin.broker_origin = NEW.broker_origin
       AND capability_pin.broker_backend_selector = NEW.broker_backend_selector
       AND capability_pin.canonical_payload_digest =
          NEW.broker_backend_capabilities_digest
     WHERE server.collaboration_server_id = NEW.collaboration_server_id
       AND server.machine_identity_id = NEW.machine_identity_id
       AND server.state IN ('installing', 'current')
       AND server.current_coordinator_lease_id = NEW.coordinator_lease_id
       AND server.current_coordinator_epoch = NEW.coordinator_epoch
       AND lease.state = 'current'
       AND lease.released_at_ms IS NULL
       AND lease.acquired_at_ms <= NEW.created_at_ms
       AND NEW.created_at_ms < lease.heartbeat_deadline_ms
       AND capability_pin.observed_at_ms <= NEW.created_at_ms
       AND (
         NEW.route_kind <> 'chat'
         OR EXISTS (
           SELECT 1 FROM logical_chats AS chat
            WHERE chat.collaboration_server_id = NEW.collaboration_server_id
              AND chat.logical_chat_id = NEW.logical_chat_id
              AND chat.state IN ('recovering', 'ready')
         )
       )
  ) THEN RAISE(ABORT, 'broker route requires its current coordinator and prior capability pin') END;
END`;

/** Existing schema objects that v9 replaces before creating its final schema entries. */
export const VERSION_NINE_PRE_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  "DROP TRIGGER broker_routes_require_current_authority",
]);

export const VERSION_NINE_SQLITE_SCHEMA_ENTRIES: readonly HostStateSqliteSchemaEntry[] =
  Object.freeze([
    table("server_identity_keys", CREATE_SERVER_IDENTITY_KEYS_SQL),
    table(
      "server_identity_private_key_envelopes",
      CREATE_SERVER_IDENTITY_PRIVATE_KEY_ENVELOPES_SQL,
    ),
    table("server_scope_certificates", CREATE_SERVER_SCOPE_CERTIFICATES_SQL),
    table("server_scope_certificate_statuses", CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_SQL),
    table("server_bootstrap_signing_leases", CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_SQL),
    table("server_signing_leases", CREATE_SERVER_SIGNING_LEASES_SQL),
    table("server_signature_reservations", CREATE_SERVER_SIGNATURE_RESERVATIONS_SQL),
    table("server_signed_record_acceptances", CREATE_SERVER_SIGNED_RECORD_ACCEPTANCES_SQL),
    schemaEntry(
      "index",
      "server_identity_keys_one_current_unique",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_CURRENT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_identity_keys_one_proposed_unique",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_PROPOSED_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_identity_keys_generation_unique",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_GENERATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_identity_keys_scope_unique",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_identity_private_key_envelopes_scope_unique",
      "server_identity_private_key_envelopes",
      CREATE_SERVER_PRIVATE_KEY_ENVELOPES_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_identity_private_key_envelopes_wrap_nonce_unique",
      "server_identity_private_key_envelopes",
      CREATE_SERVER_PRIVATE_KEY_ENVELOPES_NONCE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_scope_certificates_digest_unique",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_DIGEST_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_scope_certificates_scope_unique",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_scope_certificates_generation_unique",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_GENERATION_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_scope_certificates_subject_unique",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_SUBJECT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_scope_certificates_signer_sequence_unique",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_SIGNER_SEQUENCE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_scope_certificate_statuses_one_current_unique",
      "server_scope_certificate_statuses",
      CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_CURRENT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_bootstrap_signing_leases_one_active_unique",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_ACTIVE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_bootstrap_signing_leases_fencing_unique",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_FENCING_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_bootstrap_signing_leases_scope_unique",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signing_leases_one_active_unique",
      "server_signing_leases",
      CREATE_SERVER_SIGNING_LEASES_ACTIVE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signing_leases_fencing_unique",
      "server_signing_leases",
      CREATE_SERVER_SIGNING_LEASES_FENCING_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signing_leases_scope_unique",
      "server_signing_leases",
      CREATE_SERVER_SIGNING_LEASES_SCOPE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signature_reservations_reference_unique",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_REFERENCE_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signature_reservations_signed_digest_unique",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_DIGEST_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signature_reservations_signed_artifact_unique",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_ARTIFACT_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signed_record_acceptances_historical_reattestation_unique",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_HISTORICAL_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signed_record_acceptances_signed_digest_unique",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_DIGEST_INDEX_SQL,
    ),
    schemaEntry(
      "index",
      "server_signed_record_acceptances_signer_sequence_unique",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_SIGNER_SEQUENCE_INDEX_SQL,
    ),
    trigger(
      "server_identity_keys_require_current_authority",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_REQUIRE_AUTHORITY_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_keys_require_exact_trust_evidence",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_REQUIRE_TRUST_EVIDENCE_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_keys_lifecycle_monotonic",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_LIFECYCLE_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_keys_no_delete",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_keys_no_replace",
      "server_identity_keys",
      CREATE_SERVER_IDENTITY_KEYS_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_private_key_envelopes_identity_immutable",
      "server_identity_private_key_envelopes",
      CREATE_SERVER_PRIVATE_KEY_ENVELOPES_IDENTITY_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_private_key_envelopes_state_monotonic",
      "server_identity_private_key_envelopes",
      CREATE_SERVER_PRIVATE_KEY_ENVELOPES_STATE_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_private_key_envelopes_require_unallocated_handle",
      "server_identity_private_key_envelopes",
      CREATE_SERVER_PRIVATE_KEY_ENVELOPES_HANDLE_TRIGGER_SQL,
    ),
    trigger(
      "protected_artifacts_require_non_server_key_handle",
      "protected_artifacts",
      CREATE_PROTECTED_ARTIFACTS_SERVER_KEY_COLLISION_TRIGGER_SQL,
    ),
    trigger(
      "runtime_owner_private_keys_require_non_server_key_handle",
      "runtime_owner_private_keys",
      CREATE_RUNTIME_OWNER_PRIVATE_KEYS_SERVER_KEY_COLLISION_TRIGGER_SQL,
    ),
    trigger(
      "native_conversation_leases_require_non_server_key_handle",
      "native_conversation_leases",
      CREATE_NATIVE_CONVERSATION_LEASES_SERVER_KEY_COLLISION_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_private_key_envelopes_no_delete",
      "server_identity_private_key_envelopes",
      CREATE_SERVER_PRIVATE_KEY_ENVELOPES_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_identity_private_key_envelopes_no_replace",
      "server_identity_private_key_envelopes",
      CREATE_SERVER_PRIVATE_KEY_ENVELOPES_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificates_require_exact_signature",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_REQUIRE_SIGNATURE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificates_no_update",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_NO_UPDATE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificates_no_delete",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificates_no_replace",
      "server_scope_certificates",
      CREATE_SERVER_SCOPE_CERTIFICATES_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificate_statuses_require_certificate",
      "server_scope_certificate_statuses",
      CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_REQUIRE_CERTIFICATE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificate_statuses_lifecycle_monotonic",
      "server_scope_certificate_statuses",
      CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_LIFECYCLE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificate_statuses_no_delete",
      "server_scope_certificate_statuses",
      CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_scope_certificate_statuses_no_replace",
      "server_scope_certificate_statuses",
      CREATE_SERVER_SCOPE_CERTIFICATE_STATUSES_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_bootstrap_signing_leases_require_current_authority",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_REQUIRE_AUTHORITY_TRIGGER_SQL,
    ),
    trigger(
      "server_bootstrap_signing_leases_require_exact_operator_intent",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_REQUIRE_INTENT_TRIGGER_SQL,
    ),
    trigger(
      "server_bootstrap_signing_leases_lifecycle_monotonic",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_LIFECYCLE_TRIGGER_SQL,
    ),
    trigger(
      "server_bootstrap_signing_leases_no_delete",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_bootstrap_signing_leases_no_replace",
      "server_bootstrap_signing_leases",
      CREATE_SERVER_BOOTSTRAP_SIGNING_LEASES_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_signing_leases_require_current_authority",
      "server_signing_leases",
      CREATE_SERVER_SIGNING_LEASES_REQUIRE_AUTHORITY_TRIGGER_SQL,
    ),
    trigger(
      "server_signing_leases_lifecycle_monotonic",
      "server_signing_leases",
      CREATE_SERVER_SIGNING_LEASES_LIFECYCLE_TRIGGER_SQL,
    ),
    trigger(
      "server_signing_leases_no_delete",
      "server_signing_leases",
      CREATE_SERVER_SIGNING_LEASES_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_signing_leases_no_replace",
      "server_signing_leases",
      CREATE_SERVER_SIGNING_LEASES_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_require_current_authority",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_REQUIRE_AUTHORITY_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_increment_sequence",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_INCREMENT_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_identity_immutable",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_IDENTITY_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_lifecycle_monotonic",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_LIFECYCLE_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_require_live_lease_to_bind_or_sign",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_BIND_SIGN_AUTHORITY_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_require_exact_payload_artifact",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_REQUIRE_PAYLOAD_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_no_delete",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_signature_reservations_no_replace",
      "server_signature_reservations",
      CREATE_SERVER_SIGNATURE_RESERVATIONS_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_require_next_sequence",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_REQUIRE_NEXT_SEQUENCE_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_require_exact_signed_record",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_REQUIRE_SIGNED_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_no_update",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_NO_UPDATE_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_no_delete",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_NO_DELETE_TRIGGER_SQL,
    ),
    trigger(
      "server_signed_record_acceptances_no_replace",
      "server_signed_record_acceptances",
      CREATE_SERVER_ACCEPTANCES_NO_REPLACE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_servers_signature_sequence_monotonic",
      "collaboration_servers",
      CREATE_COLLABORATION_SERVERS_SIGNATURE_SEQUENCE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_servers_signing_scope_transition",
      "collaboration_servers",
      CREATE_COLLABORATION_SERVERS_SIGNING_SCOPE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_servers_require_current_signing_scope",
      "collaboration_servers",
      CREATE_COLLABORATION_SERVERS_CURRENT_SCOPE_TRIGGER_SQL,
    ),
    trigger(
      "collaboration_servers_coordinator_change_supersedes_signing_lease",
      "collaboration_servers",
      CREATE_COLLABORATION_SERVERS_COORDINATOR_SIGNING_FENCE_TRIGGER_SQL,
    ),
    trigger(
      "broker_routes_require_current_authority",
      "broker_routes",
      CREATE_BROKER_ROUTES_REQUIRE_CURRENT_AUTHORITY_TRIGGER_SQL,
    ),
  ]);

export const VERSION_NINE_DATA_STATEMENTS: readonly string[] = Object.freeze([]);
