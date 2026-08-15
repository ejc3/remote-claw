import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  VERSION_NINE_DATA_STATEMENTS,
  VERSION_NINE_PRE_SCHEMA_STATEMENTS,
  VERSION_NINE_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v9.js";
import { expectedHostStateMigrationDigest, HOST_STATE_MIGRATIONS } from "./migrations.js";

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MACHINE_IDENTITY_ID = "0".repeat(32);
const SERVER_ID = `rcs_${encoded(16, 1)}`;
const COORDINATOR_LEASE_ID = `rccl_${encoded(16, 2)}`;
const SUCCESSOR_COORDINATOR_LEASE_ID = `rccl_${encoded(16, 3)}`;
const SIGNING_KEY_REF = `rcph_${encoded(16, 4)}`;
const OPERATOR_INTENT_REF = `rcph_${encoded(16, 9)}`;
const SCOPE_PAYLOAD_REF = `rcph_${encoded(16, 10)}`;
const PUBLIC_KEY = encoded(32, 5);
const DIGEST = encoded(32, 6);
const SIGNED_RECORD_DIGEST = encoded(32, 7);
const SIGNATURE = encoded(64, 8);
const IDENTITY_KEY_ID = "server-key-1";
const SCOPE_CERTIFICATE_ID = "server-cert-1";
const BOOTSTRAP_LEASE_ID = "bootstrap-signing-lease-1";
const SIGNING_LEASE_ID = "server-signing-lease-1";

function encoded(byteLength: number, fill: number): string {
  return base64urlEncode(new Uint8Array(byteLength).fill(fill));
}

function openPopulatedVersionEight(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of HOST_STATE_MIGRATIONS.slice(0, 8)) {
    for (const statement of migration.statements) database.exec(statement);
  }
  database
    .prepare(
      `INSERT INTO host_state_metadata
         (singleton, machine_identity_id, schema_version, migration_digest, created_at_ms)
       VALUES (1, ?, 8, ?, 1)`,
    )
    .run(MACHINE_IDENTITY_ID, expectedHostStateMigrationDigest(8));
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
  return database;
}

function applyVersionNine(database: DatabaseSync): void {
  for (const statement of VERSION_NINE_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  for (const entry of VERSION_NINE_SQLITE_SCHEMA_ENTRIES) database.exec(entry.sql);
  for (const statement of VERSION_NINE_DATA_STATEMENTS) database.exec(statement);
}

function installCoordinator(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO coordinator_leases
         (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
          owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
          heartbeat_deadline_ms, released_at_ms, state)
       VALUES (?, ?, 1, 'owner-1', 2, 1000, 1000, NULL, 'current')`,
    )
    .run(COORDINATOR_LEASE_ID, SERVER_ID);
  database
    .prepare(
      `UPDATE collaboration_servers
       SET current_coordinator_epoch = 1, current_coordinator_lease_id = ?
       WHERE collaboration_server_id = ?`,
    )
    .run(COORDINATOR_LEASE_ID, SERVER_ID);
}

function insertProposedKeyAndEnvelope(database: DatabaseSync): void {
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
      .run(OPERATOR_INTENT_REF, SERVER_ID, DIGEST, Buffer.of(1));
    database
      .prepare(
        `INSERT INTO server_identity_keys
           (collaboration_server_id, identity_key_id, key_generation, algorithm,
            public_key, signing_key_ref, introduced_by_scope_certificate_id,
            trust_evidence_ref, trust_evidence_digest, valid_from_ms, state)
         VALUES (?, ?, 1, 'Ed25519', ?, ?, NULL, ?, ?, 4, 'proposed')`,
      )
      .run(SERVER_ID, IDENTITY_KEY_ID, PUBLIC_KEY, SIGNING_KEY_REF, OPERATOR_INTENT_REF, DIGEST);
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
        IDENTITY_KEY_ID,
        Buffer.alloc(12, 1),
        Buffer.alloc(48, 2),
        Buffer.alloc(16, 3),
        DIGEST,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertBootstrapLease(database: DatabaseSync, fencingToken = 1): void {
  database
    .prepare(
      `INSERT INTO server_bootstrap_signing_leases
         (bootstrap_signing_lease_id, collaboration_server_id, purpose,
          operator_intent_evidence_ref, operator_intent_evidence_digest,
          expected_prior_scope_certificate_id, proposed_identity_key_id,
          proposed_key_generation, proposed_scope_certificate_id, signing_key_ref,
          coordinator_lease_id, coordinator_epoch, fencing_token, prepared_at_ms,
          signed_at_ms, installed_at_ms, closed_at_ms, state)
       VALUES (?, ?, 'initial_pair', ?, ?, NULL, ?, 1, ?, ?, ?, 1, ?, 4,
               NULL, NULL, NULL, 'prepared')`,
    )
    .run(
      BOOTSTRAP_LEASE_ID,
      SERVER_ID,
      OPERATOR_INTENT_REF,
      DIGEST,
      IDENTITY_KEY_ID,
      SCOPE_CERTIFICATE_ID,
      SIGNING_KEY_REF,
      COORDINATOR_LEASE_ID,
      fencingToken,
    );
}

function signInitialCertificate(database: DatabaseSync, issuedAtMs = 6): void {
  database
    .prepare(
      `INSERT INTO protected_artifacts
         (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
          artifact_digest, byte_length, artifact_bytes, created_at_ms)
       VALUES (?, 'artifact', 'collaboration_server', ?,
               'remote-claw/server-scope-certificate/v1', ?, 1, ?, 5)`,
    )
    .run(SCOPE_PAYLOAD_REF, SERVER_ID, DIGEST, Buffer.of(2));
  database
    .prepare(
      `INSERT INTO server_signature_reservations
         (collaboration_server_id, signer_sequence, signing_lease_id,
          signing_lease_kind, purpose, canonical_payload_schema_id,
          canonical_payload_ref, canonical_payload_digest, signed_record_digest,
          signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
          bound_at_ms, signed_at_ms, aborted_at_ms, state)
       VALUES (?, 0, ?, 'bootstrap', 'scope_certificate', NULL, NULL, NULL, NULL,
               NULL, NULL, NULL, 4, NULL, NULL, NULL, 'reserved')`,
    )
    .run(SERVER_ID, BOOTSTRAP_LEASE_ID);
  database
    .prepare(
      `UPDATE server_signature_reservations
       SET canonical_payload_schema_id = 'remote-claw/server-scope-certificate/v1',
           canonical_payload_ref = ?, canonical_payload_digest = ?,
           signed_artifact_type = 'server_scope_certificate', signed_artifact_id = ?,
           bound_at_ms = 6, state = 'bound'
       WHERE collaboration_server_id = ? AND signer_sequence = 0`,
    )
    .run(SCOPE_PAYLOAD_REF, DIGEST, SCOPE_CERTIFICATE_ID, SERVER_ID);
  database
    .prepare(
      `UPDATE server_signature_reservations
       SET signed_record_digest = ?, signature = ?, signed_at_ms = 7, state = 'signed'
       WHERE collaboration_server_id = ? AND signer_sequence = 0`,
    )
    .run(SIGNED_RECORD_DIGEST, SIGNATURE, SERVER_ID);
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
               ?, 1, ?, NULL, ?, 0, NULL, 'Ed25519', 'SHA-256', ?, ?)`,
    )
    .run(
      SCOPE_CERTIFICATE_ID,
      SERVER_ID,
      MACHINE_IDENTITY_ID,
      IDENTITY_KEY_ID,
      PUBLIC_KEY,
      issuedAtMs,
      IDENTITY_KEY_ID,
      DIGEST,
      SIGNATURE,
    );
  database
    .prepare(
      `UPDATE server_bootstrap_signing_leases
       SET signed_at_ms = 7, state = 'signed'
       WHERE bootstrap_signing_lease_id = ?`,
    )
    .run(BOOTSTRAP_LEASE_ID);
}

function activateInitialScope(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `UPDATE server_identity_keys
         SET introduced_by_scope_certificate_id = ?, state = 'current'
         WHERE collaboration_server_id = ? AND identity_key_id = ?`,
      )
      .run(SCOPE_CERTIFICATE_ID, SERVER_ID, IDENTITY_KEY_ID);
    database
      .prepare(
        `INSERT INTO server_scope_certificate_statuses
           (collaboration_server_id, scope_certificate_id, state,
            accept_signatures_through_sequence, changed_at_ms,
            change_evidence_ref, change_evidence_digest)
         VALUES (?, ?, 'current', NULL, 8, ?, ?)`,
      )
      .run(SERVER_ID, SCOPE_CERTIFICATE_ID, OPERATOR_INTENT_REF, DIGEST);
    database
      .prepare(
        `INSERT INTO server_signed_record_acceptances
           (collaboration_server_id, accepted_at_journal_seq, signed_record_digest,
            signer_identity_key_id, signer_key_generation, signer_scope_certificate_id,
            signer_sequence, accepted_at_ms, historical_reattestation_id)
         VALUES (?, 0, ?, ?, 1, ?, 0, 8, NULL)`,
      )
      .run(SERVER_ID, SIGNED_RECORD_DIGEST, IDENTITY_KEY_ID, SCOPE_CERTIFICATE_ID);
    database
      .prepare(
        `UPDATE server_bootstrap_signing_leases
         SET installed_at_ms = 9, state = 'installed'
         WHERE bootstrap_signing_lease_id = ?`,
      )
      .run(BOOTSTRAP_LEASE_ID);
    database
      .prepare(
        `UPDATE collaboration_servers
         SET current_key_generation = 1, current_identity_key_id = ?,
             current_scope_certificate_id = ?, state = 'current'
         WHERE collaboration_server_id = ?`,
      )
      .run(IDENTITY_KEY_ID, SCOPE_CERTIFICATE_ID, SERVER_ID);
    database
      .prepare(
        `INSERT INTO server_signing_leases
           (signing_lease_id, collaboration_server_id, identity_key_id, key_generation,
            scope_certificate_id, coordinator_lease_id, coordinator_epoch, fencing_token,
            acquired_at_ms, draining_at_ms, superseded_at_ms, closed_at_ms, state)
         VALUES (?, ?, ?, 1, ?, ?, 1, 2, 10, NULL, NULL, NULL, 'current')`,
      )
      .run(
        SIGNING_LEASE_ID,
        SERVER_ID,
        IDENTITY_KEY_ID,
        SCOPE_CERTIFICATE_ID,
        COORDINATOR_LEASE_ID,
      );
    database
      .prepare(
        `UPDATE server_bootstrap_signing_leases
         SET closed_at_ms = 10, state = 'closed'
         WHERE bootstrap_signing_lease_id = ? AND state = 'installed'`,
      )
      .run(BOOTSTRAP_LEASE_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("schema v9 server signing durability", () => {
  it("upgrades populated v8 state with only the eight bounded signing tables", () => {
    const database = openPopulatedVersionEight();
    try {
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("server_identity_keys"),
      ).toBeUndefined();

      applyVersionNine(database);

      const tableNames = VERSION_NINE_SQLITE_SCHEMA_ENTRIES.filter(
        (entry) => entry.type === "table",
      ).map((entry) => entry.name);
      expect(tableNames).toEqual([
        "server_identity_keys",
        "server_identity_private_key_envelopes",
        "server_scope_certificates",
        "server_scope_certificate_statuses",
        "server_bootstrap_signing_leases",
        "server_signing_leases",
        "server_signature_reservations",
        "server_signed_record_acceptances",
      ]);
      expect(tableNames.some((name) => /command|effect/i.test(name))).toBe(false);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM collaboration_servers").get() as {
          readonly count: number;
        },
      ).toEqual({ count: 1 });

      const routeTrigger = database
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get("broker_routes_require_current_authority") as { readonly sql: string };
      expect(routeTrigger.sql).toContain("server.state IN ('installing', 'current')");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("installs the initial fenced key and enforces dense sequences and immutability", () => {
    const database = openPopulatedVersionEight();
    try {
      applyVersionNine(database);
      installCoordinator(database);
      insertProposedKeyAndEnvelope(database);

      expect(() => insertBootstrapLease(database, 2)).toThrow(/next fence|current authority/);
      insertBootstrapLease(database);
      expect(() =>
        database
          .prepare(
            `UPDATE server_bootstrap_signing_leases
             SET closed_at_ms = 5, state = 'closed'
             WHERE bootstrap_signing_lease_id = ?`,
          )
          .run(BOOTSTRAP_LEASE_ID),
      ).toThrow(/lifecycle is monotonic/);
      expect(() =>
        database
          .prepare(
            `UPDATE server_identity_private_key_envelopes
             SET destroyed_at_ms = 5, state = 'destroyed'
             WHERE signing_key_ref = ?`,
          )
          .run(SIGNING_KEY_REF),
      ).toThrow(/lifecycle is monotonic/);
      signInitialCertificate(database);
      expect(
        database
          .prepare(
            "SELECT next_server_signature_seq FROM collaboration_servers WHERE collaboration_server_id = ?",
          )
          .get(SERVER_ID),
      ).toEqual({ next_server_signature_seq: 1 });

      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, canonical_payload_schema_id,
                canonical_payload_ref, canonical_payload_digest, signed_record_digest,
                signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
                bound_at_ms, signed_at_ms, aborted_at_ms, state)
             VALUES (?, 2, ?, 'bootstrap', 'scope_certificate', NULL, NULL, NULL, NULL,
                     NULL, NULL, NULL, 8, NULL, NULL, NULL, 'reserved')`,
          )
          .run(SERVER_ID, BOOTSTRAP_LEASE_ID),
      ).toThrow(/current signing authority/);
      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, reserved_at_ms, state)
             VALUES (?, ?, ?, 'bootstrap', 'scope_certificate', 8, 'reserved')`,
          )
          .run(SERVER_ID, MAX_SAFE_INTEGER + 1, BOOTSTRAP_LEASE_ID),
      ).toThrow();

      activateInitialScope(database);

      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, reserved_at_ms, state)
             VALUES (?, 1, ?, 'current', 'host_output', 12, 'reserved')`,
          )
          .run(SERVER_ID, SIGNING_LEASE_ID),
      ).toThrow(/current signing authority/);

      expect(() =>
        database
          .prepare(
            `UPDATE server_signature_reservations
             SET signed_artifact_id = 'different-artifact'
             WHERE collaboration_server_id = ? AND signer_sequence = 0`,
          )
          .run(SERVER_ID),
      ).toThrow(/lifecycle is monotonic/);
      expect(() =>
        database
          .prepare(
            `UPDATE server_scope_certificates SET issued_at_ms = 8
             WHERE scope_certificate_id = ?`,
          )
          .run(SCOPE_CERTIFICATE_ID),
      ).toThrow(/immutable/);
      expect(() =>
        database
          .prepare(
            `UPDATE server_signed_record_acceptances SET accepted_at_ms = 12
             WHERE collaboration_server_id = ? AND accepted_at_journal_seq = 0`,
          )
          .run(SERVER_ID),
      ).toThrow(/immutable/);

      database
        .prepare(
          `INSERT INTO protected_artifacts
             (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
              artifact_digest, byte_length, artifact_bytes, created_at_ms)
           VALUES (?, 'artifact', 'host_profile', 'default',
                   'remote-claw/broker-backend-capabilities/v1', ?, 1, ?, 1)`,
        )
        .run(`rcph_${encoded(16, 20)}`, DIGEST, Buffer.from([1]));
      database
        .prepare(
          `INSERT INTO broker_backend_capability_pins
             (broker_backend_capability_pin_id, machine_identity_id, broker_origin,
              broker_backend_selector, canonical_payload_schema_id, canonical_payload_ref,
              canonical_payload_digest, observed_at_ms)
           VALUES (?, ?, 'https://broker.example', 'sqlite',
                   'remote-claw/broker-backend-capabilities/v1', ?, ?, 1)`,
        )
        .run(`rbcp_${encoded(32, 21)}`, MACHINE_IDENTITY_ID, `rcph_${encoded(16, 20)}`, DIGEST);
      expect(() =>
        database
          .prepare(
            `INSERT INTO broker_routes
               (broker_route_id, machine_identity_id, collaboration_server_id, route_kind,
                logical_chat_id, route_token, broker_origin, broker_backend_selector,
                broker_route_store_instance_id, genesis_generation,
                broker_backend_capabilities_ref, broker_backend_capabilities_digest,
                coordinator_lease_id, coordinator_epoch, created_at_ms, state)
             VALUES (?, ?, ?, 'server_control', NULL, ?, 'https://broker.example', 'sqlite',
                     ?, 0, ?, ?, ?, 1, 12, 'current')`,
          )
          .run(
            `rcr_${encoded(32, 22)}`,
            MACHINE_IDENTITY_ID,
            SERVER_ID,
            `ctl:a1:${encoded(32, 23)}`,
            `rbsi_${encoded(16, 24)}`,
            `rbcp_${encoded(32, 21)}`,
            DIGEST,
            COORDINATOR_LEASE_ID,
          ),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("pins the initial anchor to sequence zero and monotonic reservation time", () => {
    const database = openPopulatedVersionEight();
    try {
      applyVersionNine(database);
      installCoordinator(database);
      insertProposedKeyAndEnvelope(database);
      insertBootstrapLease(database);
      database
        .prepare(
          `INSERT INTO protected_artifacts
             (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
              artifact_digest, byte_length, artifact_bytes, created_at_ms)
           VALUES (?, 'artifact', 'collaboration_server', ?,
                   'remote-claw/server-scope-certificate/v1', ?, 1, ?, 5)`,
        )
        .run(SCOPE_PAYLOAD_REF, SERVER_ID, DIGEST, Buffer.of(2));
      database
        .prepare(
          `INSERT INTO server_signature_reservations
             (collaboration_server_id, signer_sequence, signing_lease_id,
              signing_lease_kind, purpose, reserved_at_ms, state)
           VALUES (?, 0, ?, 'bootstrap', 'scope_certificate', 4, 'reserved')`,
        )
        .run(SERVER_ID, BOOTSTRAP_LEASE_ID);
      database
        .prepare(
          `UPDATE server_signature_reservations
           SET canonical_payload_schema_id = 'remote-claw/server-scope-certificate/v1',
               canonical_payload_ref = ?, canonical_payload_digest = ?,
               signed_artifact_type = 'server_scope_certificate', signed_artifact_id = ?,
               bound_at_ms = 10, state = 'bound'
           WHERE collaboration_server_id = ? AND signer_sequence = 0`,
        )
        .run(SCOPE_PAYLOAD_REF, DIGEST, SCOPE_CERTIFICATE_ID, SERVER_ID);

      expect(() =>
        database
          .prepare(
            `UPDATE server_signature_reservations
             SET signed_record_digest = ?, signature = ?, signed_at_ms = 9, state = 'signed'
             WHERE collaboration_server_id = ? AND signer_sequence = 0`,
          )
          .run(SIGNED_RECORD_DIGEST, SIGNATURE, SERVER_ID),
      ).toThrow();
      database
        .prepare(
          `UPDATE server_signature_reservations
           SET aborted_at_ms = 11, state = 'aborted'
           WHERE collaboration_server_id = ? AND signer_sequence = 0`,
        )
        .run(SERVER_ID);
      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, reserved_at_ms, state)
             VALUES (?, 1, ?, 'bootstrap', 'scope_certificate', 12, 'reserved')`,
          )
          .run(SERVER_ID, BOOTSTRAP_LEASE_ID),
      ).toThrow(/current signing authority/);
    } finally {
      database.close();
    }
  });

  it("rejects a scope certificate issued after its payload was bound", () => {
    const database = openPopulatedVersionEight();
    try {
      applyVersionNine(database);
      installCoordinator(database);
      insertProposedKeyAndEnvelope(database);
      insertBootstrapLease(database);
      expect(() => signInitialCertificate(database, 7)).toThrow(
        /exact fenced signature reservation/,
      );
      expect(
        database
          .prepare(
            `SELECT state, bound_at_ms, signed_at_ms
             FROM server_signature_reservations
             WHERE collaboration_server_id = ? AND signer_sequence = 0`,
          )
          .get(SERVER_ID),
      ).toEqual({ state: "signed", bound_at_ms: 6, signed_at_ms: 7 });
      expect(
        database.prepare("SELECT COUNT(*) AS value FROM server_scope_certificates").get(),
      ).toEqual({ value: 0 });
    } finally {
      database.close();
    }
  });

  it("supersedes the current signing lease when coordinator authority changes", () => {
    const database = openPopulatedVersionEight();
    try {
      applyVersionNine(database);
      installCoordinator(database);
      insertProposedKeyAndEnvelope(database);
      insertBootstrapLease(database);
      signInitialCertificate(database);
      activateInitialScope(database);

      database
        .prepare(
          `UPDATE coordinator_leases
           SET released_at_ms = 20, state = 'released'
           WHERE coordinator_lease_id = ?`,
        )
        .run(COORDINATOR_LEASE_ID);
      database
        .prepare(
          `UPDATE collaboration_servers SET current_coordinator_lease_id = NULL
           WHERE collaboration_server_id = ?`,
        )
        .run(SERVER_ID);

      expect(
        database
          .prepare(
            `SELECT state, superseded_at_ms FROM server_signing_leases
             WHERE signing_lease_id = ?`,
          )
          .get(SIGNING_LEASE_ID),
      ).toEqual({ state: "superseded", superseded_at_ms: 20 });

      database
        .prepare(
          `INSERT INTO coordinator_leases
             (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
              heartbeat_deadline_ms, released_at_ms, state)
           VALUES (?, ?, 2, 'owner-2', 21, 1000, 1000, NULL, 'current')`,
        )
        .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_servers
           SET current_coordinator_epoch = 2, current_coordinator_lease_id = ?
           WHERE collaboration_server_id = ?`,
        )
        .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);
      expect(() =>
        database
          .prepare(
            `INSERT INTO server_signature_reservations
               (collaboration_server_id, signer_sequence, signing_lease_id,
                signing_lease_kind, purpose, reserved_at_ms, state)
             VALUES (?, 1, ?, 'current', 'host_output', 22, 'reserved')`,
          )
          .run(SERVER_ID, SIGNING_LEASE_ID),
      ).toThrow(/current signing authority/);
    } finally {
      database.close();
    }
  });

  it("does not install a signed bootstrap after its coordinator fence is stale", () => {
    const database = openPopulatedVersionEight();
    try {
      applyVersionNine(database);
      installCoordinator(database);
      insertProposedKeyAndEnvelope(database);
      insertBootstrapLease(database);
      signInitialCertificate(database);

      database
        .prepare(
          `UPDATE coordinator_leases
           SET released_at_ms = 20, state = 'released'
           WHERE coordinator_lease_id = ?`,
        )
        .run(COORDINATOR_LEASE_ID);
      database
        .prepare(
          `UPDATE collaboration_servers SET current_coordinator_lease_id = NULL
           WHERE collaboration_server_id = ?`,
        )
        .run(SERVER_ID);
      database
        .prepare(
          `INSERT INTO coordinator_leases
             (coordinator_lease_id, collaboration_server_id, coordinator_epoch,
              owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
              heartbeat_deadline_ms, released_at_ms, state)
           VALUES (?, ?, 2, 'owner-2', 21, 1000, 1000, NULL, 'current')`,
        )
        .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);
      database
        .prepare(
          `UPDATE collaboration_servers
           SET current_coordinator_epoch = 2, current_coordinator_lease_id = ?
           WHERE collaboration_server_id = ?`,
        )
        .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);

      expect(() =>
        database
          .prepare(
            `UPDATE server_identity_keys
             SET introduced_by_scope_certificate_id = ?, state = 'current'
             WHERE collaboration_server_id = ? AND identity_key_id = ?`,
          )
          .run(SCOPE_CERTIFICATE_ID, SERVER_ID, IDENTITY_KEY_ID),
      ).toThrow(/lifecycle is monotonic/);
      expect(() =>
        database
          .prepare(
            `UPDATE server_bootstrap_signing_leases
             SET installed_at_ms = 22, state = 'installed'
             WHERE bootstrap_signing_lease_id = ?`,
          )
          .run(BOOTSTRAP_LEASE_ID),
      ).toThrow(/lifecycle is monotonic/);
      expect(() =>
        database
          .prepare(
            `UPDATE server_bootstrap_signing_leases
             SET closed_at_ms = 22, state = 'closed'
             WHERE bootstrap_signing_lease_id = ?`,
          )
          .run(BOOTSTRAP_LEASE_ID),
      ).toThrow(/lifecycle is monotonic/);
      expect(() =>
        database
          .prepare(
            `UPDATE collaboration_servers
             SET current_key_generation = 1, current_identity_key_id = ?,
                 current_scope_certificate_id = ?, state = 'current'
             WHERE collaboration_server_id = ?`,
          )
          .run(IDENTITY_KEY_ID, SCOPE_CERTIFICATE_ID, SERVER_ID),
      ).toThrow(/signing scope transition|current collaboration server requires/);
      expect(
        database
          .prepare(
            `SELECT state, current_key_generation, current_identity_key_id,
                    current_scope_certificate_id
             FROM collaboration_servers WHERE collaboration_server_id = ?`,
          )
          .get(SERVER_ID),
      ).toEqual({
        state: "installing",
        current_key_generation: 0,
        current_identity_key_id: null,
        current_scope_certificate_id: null,
      });
      expect(
        database
          .prepare(
            `SELECT state, installed_at_ms FROM server_bootstrap_signing_leases
             WHERE bootstrap_signing_lease_id = ?`,
          )
          .get(BOOTSTRAP_LEASE_ID),
      ).toEqual({ state: "signed", installed_at_ms: null });
    } finally {
      database.close();
    }
  });
});
