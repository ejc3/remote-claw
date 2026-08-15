import { generateKeyPairSync, type KeyObject, sign as signEd25519 } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandAdjudicationRepositoryOperations,
  createCommandAdjudicationRepositoryTransactionOperations,
  type FinalizeSignedRejectedCommandResultRequest,
  type ReserveRejectedCommandDecisionRequest,
} from "../state/command-adjudication-repository.js";
import { parseA1CanonicalId, parseA1SafeId } from "../state/ids.js";
import {
  VERSION_EIGHT_DATA_STATEMENTS,
  VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES,
} from "../state/migration-v8.js";
import {
  VERSION_NINE_DATA_STATEMENTS,
  VERSION_NINE_PRE_SCHEMA_STATEMENTS,
  VERSION_NINE_SQLITE_SCHEMA_ENTRIES,
} from "../state/migration-v9.js";
import {
  VERSION_TEN_DATA_STATEMENTS,
  VERSION_TEN_PRE_SCHEMA_STATEMENTS,
  VERSION_TEN_SQLITE_SCHEMA_ENTRIES,
} from "../state/migration-v10.js";
import {
  VERSION_ELEVEN_DATA_STATEMENTS,
  VERSION_ELEVEN_PRE_SCHEMA_STATEMENTS,
  VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES,
} from "../state/migration-v11.js";
import { expectedHostStateMigrationDigest, HOST_STATE_MIGRATIONS } from "../state/migrations.js";
import { ProtectedByteSnapshot } from "../state/protected.js";
import type { HostStateRepositorySqlTransaction } from "../state/repository.js";
import {
  createServerSigningRepositoryOperations,
  createServerSigningRepositoryTransactionOperations,
} from "../state/server-signing-repository.js";
import { HostStateCommitOutcomeUnknownError, type HostStateTransaction } from "../state/sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "../state/test-environment.js";
import {
  type DormantCommandResultFinalizationDatabase,
  type DormantCommandResultFinalizationError,
  type DormantCommandResultSigningDatabase,
  type DormantCommandResultSigningError,
  finalizeSignedRejectedCommandResult,
  signRejectedCommandResultPreparation,
} from "./command-result-orchestrator.js";
import type { ServerKeyCustodySigningCapability, WrappedServerPrivateKey } from "./service.js";

const MACHINE_IDENTITY_ID = "0".repeat(32);
const SERVER_ID = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const COORDINATOR_LEASE_ID = parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 2)}`);
const SIGNING_KEY_REF = `rcph_${encoded(16, 3)}`;
const TRUST_REF = `rcph_${encoded(16, 4)}`;
const RESULT_ID = parseA1SafeId(`rrs_${encoded(32, 5)}`);
const ROUTE_ID = `rcr_${encoded(32, 6)}`;
const SOURCE_NAMESPACE_ID = `wns_${encoded(32, 7)}`;
const MESSAGE_DIGEST = encoded(32, 8);
const EVENT_FINGERPRINT = encoded(32, 9);
const ACCEPTED_DELIVERY_ATTEMPT_ID = `rda_${encoded(16, 10)}`;
const COMPLETION_OBSERVATION_ID = `rio_${encoded(32, 17)}`;
const COMPLETION_POSITION_ID = `rcp_${encoded(32, 18)}`;
const BROKER_CAPABILITY_REF = `rbcp_${encoded(32, 21)}`;
const BROKER_CAPABILITY_ARTIFACT_REF = `rcph_${encoded(16, 22)}`;
const SERVER_IDENTITY_KEY_ID = "server-key-1";
const SCOPE_CERTIFICATE_ID = "server-cert-1";
const SIGNING_LEASE_ID = parseA1SafeId("server-signing-lease-1");
const NOW_MS = 100;
const temporaryRoots: string[] = [];
const openDatabases: DatabaseSync[] = [];
const describeLinux = describe.runIf(
  process.platform === "linux" &&
    typeof process.getuid === "function" &&
    HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
);

function encoded(byteLength: number, fill: number): string {
  return base64urlEncode(new Uint8Array(byteLength).fill(fill));
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

function sqlTransaction(database: DatabaseSync): HostStateRepositorySqlTransaction {
  return {
    get(sql, parameters) {
      return database.prepare(sql).get(...parameters);
    },
    all(sql, parameters) {
      return database.prepare(sql).all(...parameters);
    },
    run(sql, parameters) {
      return database.prepare(sql).run(...parameters);
    },
  };
}

function sqliteExecutor(database: DatabaseSync) {
  return {
    transaction<T>(operation: (transaction: HostStateRepositorySqlTransaction) => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(sqlTransaction(database));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function installFixture(database: DatabaseSync, publicKey: string): void {
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
       VALUES (?, ?, ?, 'server_control', NULL, ?, 'message-1', 'new_chat', 'client-1', 1,
               'remote-claw/a1-ingress-new-chat/v1', ?,
               'remote-claw/a1/source-event-fingerprint/v1', ?, ?, 0, 0, 0, 0,
               1000, 'awaiting_order', NULL, NULL)`,
    )
    .run(
      RESULT_ID,
      ROUTE_ID,
      SERVER_ID,
      SOURCE_NAMESPACE_ID,
      MESSAGE_DIGEST,
      EVENT_FINGERPRINT,
      ACCEPTED_DELIVERY_ATTEMPT_ID,
    );
  addAcceptedCompletionEvidence(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyEntries(database, VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES, "trigger");

  for (const statement of VERSION_NINE_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  applyEntries(
    database,
    VERSION_NINE_SQLITE_SCHEMA_ENTRIES.filter((entry) => entry.type !== "trigger"),
  );
  for (const statement of VERSION_NINE_DATA_STATEMENTS) database.exec(statement);
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
  database
    .prepare(
      `INSERT INTO protected_artifacts
         (protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
          artifact_digest, byte_length, artifact_bytes, created_at_ms)
       VALUES (?, 'artifact', 'collaboration_server', ?,
               'remote-claw/server-signer-bootstrap-intent/v1', ?, 1, ?, 3)`,
    )
    .run(TRUST_REF, SERVER_ID, MESSAGE_DIGEST, Buffer.of(1));
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
      publicKey,
      SIGNING_KEY_REF,
      SCOPE_CERTIFICATE_ID,
      TRUST_REF,
      MESSAGE_DIGEST,
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
      MESSAGE_DIGEST,
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
      publicKey,
      SERVER_IDENTITY_KEY_ID,
      MESSAGE_DIGEST,
      encoded(64, 11),
    );
  database
    .prepare(
      `INSERT INTO server_scope_certificate_statuses
         (collaboration_server_id, scope_certificate_id, state,
          accept_signatures_through_sequence, changed_at_ms,
          change_evidence_ref, change_evidence_digest)
       VALUES (?, ?, 'current', NULL, 6, ?, ?)`,
    )
    .run(SERVER_ID, SCOPE_CERTIFICATE_ID, TRUST_REF, MESSAGE_DIGEST);
  addBrokerRouteFixture(database);
  database.exec("COMMIT");
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
  applyEntries(database, VERSION_NINE_SQLITE_SCHEMA_ENTRIES, "trigger");
  for (const statement of VERSION_TEN_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  applyEntries(database, VERSION_TEN_SQLITE_SCHEMA_ENTRIES);
  for (const statement of VERSION_TEN_DATA_STATEMENTS) database.exec(statement);
  for (const statement of VERSION_ELEVEN_PRE_SCHEMA_STATEMENTS) database.exec(statement);
  applyEntries(database, VERSION_ELEVEN_SQLITE_SCHEMA_ENTRIES);
  for (const statement of VERSION_ELEVEN_DATA_STATEMENTS) database.exec(statement);
}

function addBrokerRouteFixture(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO protected_artifacts (
        protected_handle_id, kind, scope_kind, scope_id, artifact_schema_id,
        artifact_digest, byte_length, artifact_bytes, created_at_ms
      ) VALUES (?, 'artifact', 'host_profile', 'default',
                'remote-claw/broker-backend-capabilities/v1', ?, 1, ?, 3)`,
    )
    .run(BROKER_CAPABILITY_ARTIFACT_REF, MESSAGE_DIGEST, Buffer.of(2));
  database
    .prepare(
      `INSERT INTO broker_backend_capability_pins (
        broker_backend_capability_pin_id, machine_identity_id, broker_origin,
        broker_backend_selector, canonical_payload_schema_id,
        canonical_payload_ref, canonical_payload_digest, observed_at_ms
      ) VALUES (?, ?, 'https://broker.example', 'sqlite',
                'remote-claw/broker-backend-capabilities/v1', ?, ?, 3)`,
    )
    .run(
      BROKER_CAPABILITY_REF,
      MACHINE_IDENTITY_ID,
      BROKER_CAPABILITY_ARTIFACT_REF,
      MESSAGE_DIGEST,
    );
  database
    .prepare(
      `INSERT INTO broker_routes (
        broker_route_id, machine_identity_id, collaboration_server_id,
        route_kind, logical_chat_id, route_token, broker_origin,
        broker_backend_selector, broker_route_store_instance_id,
        genesis_generation, broker_backend_capabilities_ref,
        broker_backend_capabilities_digest, coordinator_lease_id,
        coordinator_epoch, created_at_ms, state
      ) VALUES (?, ?, ?, 'server_control', NULL, ?, 'https://broker.example', 'sqlite',
                ?, 0, ?, ?, ?, 1, 4, 'current')`,
    )
    .run(
      ROUTE_ID,
      MACHINE_IDENTITY_ID,
      SERVER_ID,
      `ctl:a1:${encoded(32, 19)}`,
      `rbsi_${encoded(16, 20)}`,
      BROKER_CAPABILITY_REF,
      MESSAGE_DIGEST,
      COORDINATOR_LEASE_ID,
    );
}

function addAcceptedCompletionEvidence(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO ingress_delivery_candidates (
        stable_semantic_result_id, delivery_attempt_id, broker_route_id,
        collaboration_server_id, route_kind, logical_chat_id, expected_parts,
        received_parts, plaintext_byte_count, first_ingress_generation,
        first_ingress_frame_index, last_observed_ingress_generation,
        last_observed_ingress_frame_index, state
      ) VALUES (?, ?, ?, ?, 'server_control', NULL, 1, 1, 1, 0, 0, 0, 0, 'complete')`,
    )
    .run(RESULT_ID, ACCEPTED_DELIVERY_ATTEMPT_ID, ROUTE_ID, SERVER_ID);
  database
    .prepare(
      `INSERT INTO authenticated_ingress_parts (
        stable_semantic_result_id, delivery_attempt_id, part, broker_route_id,
        collaboration_server_id, route_kind, logical_chat_id, parts,
        authenticated_part_digest, plaintext_part_ref, plaintext_part_digest,
        plaintext_part_byte_length, first_ingress_generation,
        first_ingress_frame_index
      ) VALUES (?, ?, 0, ?, ?, 'server_control', NULL, 1, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      RESULT_ID,
      ACCEPTED_DELIVERY_ATTEMPT_ID,
      ROUTE_ID,
      SERVER_ID,
      MESSAGE_DIGEST,
      TRUST_REF,
      MESSAGE_DIGEST,
    );
  database
    .prepare(
      `INSERT INTO authenticated_ingress_observations (
        ingress_observation_id, channel_position_observation_id,
        stable_semantic_result_id, delivery_attempt_id, broker_route_id,
        collaboration_server_id, route_kind, logical_chat_id,
        channel_generation, frame_index, part, parts, authenticated_part_digest,
        plaintext_evidence_ref, plaintext_evidence_digest,
        plaintext_evidence_byte_length, disposition, cursor_disposition,
        gap_id, recovery_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'server_control', NULL, 0, 0, 0, 1, ?, ?, ?, 1,
                'new_part', 'advanceable', NULL, NULL)`,
    )
    .run(
      COMPLETION_OBSERVATION_ID,
      COMPLETION_POSITION_ID,
      RESULT_ID,
      ACCEPTED_DELIVERY_ATTEMPT_ID,
      ROUTE_ID,
      SERVER_ID,
      MESSAGE_DIGEST,
      TRUST_REF,
      MESSAGE_DIGEST,
    );
}

interface OpenFixture {
  readonly database: DatabaseSync;
  readonly facade: DormantCommandResultSigningDatabase;
  readonly decision: ReserveRejectedCommandDecisionRequest;
  readonly privateKey: KeyObject;
  readonly databasePath: string;
}

function databaseFacade(database: DatabaseSync): DormantCommandResultSigningDatabase {
  const executor = sqliteExecutor(database);
  let entropy = 41;
  const commandOptions = {
    nowMs: () => NOW_MS,
    randomBytes: (length: number) => new Uint8Array(length).fill(entropy++),
  };
  return {
    machineIdentityId: MACHINE_IDENTITY_ID,
    commandAdjudication: createCommandAdjudicationRepositoryOperations(
      executor,
      MACHINE_IDENTITY_ID,
      commandOptions,
    ),
    serverSigning: createServerSigningRepositoryOperations(
      executor,
      MACHINE_IDENTITY_ID,
      () => NOW_MS,
    ),
    transaction<T>(operation: (transaction: HostStateTransaction) => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const activeSql = sqlTransaction(database);
        const transaction = {
          commandAdjudication: createCommandAdjudicationRepositoryTransactionOperations(
            activeSql,
            MACHINE_IDENTITY_ID,
            commandOptions,
          ),
          serverSigning: createServerSigningRepositoryTransactionOperations(
            activeSql,
            MACHINE_IDENTITY_ID,
            () => NOW_MS,
          ),
        } as HostStateTransaction;
        const result = operation(transaction);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close(): void {
      database.close();
    },
  };
}

function openPreparedFixture(): OpenFixture {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-command-result-signer-"),
  );
  temporaryRoots.push(root);
  const databasePath = join(root, "state.sqlite3");
  const database = new DatabaseSync(databasePath);
  openDatabases.push(database);
  database.exec("PRAGMA synchronous = OFF");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  installFixture(database, publicJwk.x as string);
  const facade = databaseFacade(database);
  const fence = {
    collaborationServerId: SERVER_ID,
    coordinatorLeaseId: COORDINATOR_LEASE_ID,
    coordinatorEpoch: 1,
  } as const;
  const ready = facade.commandAdjudication.materializeReadyIngressCommand({
    fence,
    stableSemanticResultId: RESULT_ID,
    expectedReadyAtJournalSeq: 0,
  });
  const decision = {
    fence,
    expectedCommandId: ready.command.commandId,
    expectedCommandSeq: 0,
    expectedSignerSequence: 1,
    expectedSigningLeaseId: SIGNING_LEASE_ID,
  } as const;
  const reserved = facade.commandAdjudication.reserveRejectedDecision(decision);
  reserved.canonicalPayload.destroy();
  return { database, facade, decision, privateKey, databasePath };
}

function reopen(databasePath: string): DormantCommandResultSigningDatabase {
  const database = new DatabaseSync(databasePath);
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  return databaseFacade(database);
}

function unknownCommitDatabase(
  database: DormantCommandResultSigningDatabase,
  targetTransaction: number,
  outcome: "landed" | "absent",
): DormantCommandResultSigningDatabase {
  let transactionCount = 0;
  return {
    machineIdentityId: database.machineIdentityId,
    commandAdjudication: database.commandAdjudication,
    serverSigning: database.serverSigning,
    transaction<T>(operation: (transaction: HostStateTransaction) => T): T {
      transactionCount += 1;
      if (transactionCount !== targetTransaction) return database.transaction(operation);
      if (outcome === "landed") {
        database.transaction(operation);
      } else {
        const rollbackMarker = Object.freeze({ rollbackMarker: true });
        try {
          database.transaction((transaction) => {
            operation(transaction);
            throw rollbackMarker;
          });
        } catch (error) {
          if (error !== rollbackMarker) throw error;
        }
      }
      throw new HostStateCommitOutcomeUnknownError(
        `simulated ${outcome} command-result COMMIT outcome`,
      );
    },
    close: () => database.close(),
  };
}

interface ObservedCustody {
  readonly custody: ServerKeyCustodySigningCapability;
  readonly sign: ReturnType<typeof vi.fn>;
  readonly payloads: ProtectedByteSnapshot[];
  readonly envelopes: WrappedServerPrivateKey[];
  readonly signatures: ProtectedByteSnapshot[];
}

function observedCustody(fixture: OpenFixture, duringSign?: () => void): ObservedCustody {
  const payloads: ProtectedByteSnapshot[] = [];
  const envelopes: WrappedServerPrivateKey[] = [];
  const signatures: ProtectedByteSnapshot[] = [];
  const sign = vi.fn((envelope: WrappedServerPrivateKey, payload: ProtectedByteSnapshot) => {
    duringSign?.();
    envelopes.push(envelope);
    payloads.push(payload);
    const payloadBytes = payload.copyBytes();
    let signatureBytes: Buffer | undefined;
    try {
      signatureBytes = signEd25519(null, payloadBytes, fixture.privateKey);
      const signature = ProtectedByteSnapshot.from(signatureBytes);
      signatures.push(signature);
      return signature;
    } finally {
      signatureBytes?.fill(0);
      payloadBytes.fill(0);
    }
  });
  return {
    custody: {
      generateIdentityKey() {
        throw new Error("command-result signer must not generate an identity key");
      },
      assertUsable(envelope) {
        if (
          envelope.binding.machineIdentityId !== MACHINE_IDENTITY_ID ||
          envelope.binding.identityKeyId !== SERVER_IDENTITY_KEY_ID
        ) {
          throw new Error("unexpected server-key envelope");
        }
      },
      sign,
    },
    sign,
    payloads,
    envelopes,
    signatures,
  };
}

interface SignedFinalizationFixture {
  readonly database: DormantCommandResultSigningDatabase;
  readonly request: FinalizeSignedRejectedCommandResultRequest;
  readonly custody: ObservedCustody;
}

function prepareSignedFinalization(fixture: OpenFixture): SignedFinalizationFixture {
  const custody = observedCustody(fixture);
  const signed = signRejectedCommandResultPreparation({
    database: fixture.facade,
    reopenDatabase: () => reopen(fixture.databasePath),
    custody: custody.custody,
    machineIdentityId: MACHINE_IDENTITY_ID,
    decision: fixture.decision,
  });
  const state = signed.database.commandAdjudication.readState(RESULT_ID);
  const signedRecordDigest = state?.signatureReservation?.signedRecordDigest;
  if (signedRecordDigest === null || signedRecordDigest === undefined) {
    throw new Error("signed finalization fixture has no signed-record digest");
  }
  return {
    database: signed.database,
    request: {
      fence: fixture.decision.fence,
      expectedCommandId: fixture.decision.expectedCommandId,
      expectedCommandResultId: signed.commandResultId,
      expectedCommandResultPreparationId: signed.commandResultPreparationId,
      expectedSignedRecordDigest: signedRecordDigest,
      expectedAcceptedAtJournalSeq: 0,
    },
    custody,
  };
}

function expectDestroyed(snapshot: ProtectedByteSnapshot): void {
  expect(() => snapshot.copyBytes()).toThrow(/destroyed/);
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try {
      if (database.isOpen) database.close();
    } catch {
      // A test assertion remains the primary failure.
    }
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("dormant command-result preparation signer", () => {
  it.each([
    ["bind", "landed", 1],
    ["bind", "absent", 1],
    ["store", "landed", 2],
    ["store", "absent", 2],
  ] as const)("reopens and reconciles an exact %s COMMIT proved %s without re-signing", (phase, outcome, targetTransaction) => {
    const fixture = openPreparedFixture();
    const custody = observedCustody(fixture);
    const result = signRejectedCommandResultPreparation({
      database: unknownCommitDatabase(fixture.facade, targetTransaction, outcome),
      reopenDatabase: () => reopen(fixture.databasePath),
      custody: custody.custody,
      machineIdentityId: MACHINE_IDENTITY_ID,
      decision: fixture.decision,
    });
    expect(result.reconciledUnknownCommitCount).toBe(1);
    expect(result.replayed).toBe(phase === "store" && outcome === "landed");
    expect(custody.sign).toHaveBeenCalledTimes(1);
    expect(Object.keys(result)).not.toContain("signature");
    expect(Object.keys(result)).not.toContain("canonicalPayload");
    const state = result.database.commandAdjudication.readState(RESULT_ID);
    expect(state?.preparation?.state).toBe("signed");
    expect(state?.signingGroup?.state).toBe("result_signed");
    for (const snapshot of custody.payloads) expectDestroyed(snapshot);
    for (const envelope of custody.envelopes) {
      expectDestroyed(envelope.wrapNonce);
      expectDestroyed(envelope.wrappedPkcs8);
      expectDestroyed(envelope.authTag);
    }
    for (const signature of custody.signatures) expectDestroyed(signature);
    result.database.close();
  });

  it("holds BEGIN IMMEDIATE across custody signing and the durable store", () => {
    const fixture = openPreparedFixture();
    let lockError: unknown;
    const custody = observedCustody(fixture, () => {
      const contender = new DatabaseSync(fixture.databasePath);
      try {
        contender.exec("PRAGMA busy_timeout = 0");
        try {
          contender.exec("BEGIN IMMEDIATE");
        } catch (error) {
          lockError = error;
        }
        if (lockError === undefined) contender.exec("ROLLBACK");
      } finally {
        contender.close();
      }
    });
    const result = signRejectedCommandResultPreparation({
      database: fixture.facade,
      reopenDatabase: () => reopen(fixture.databasePath),
      custody: custody.custody,
      machineIdentityId: MACHINE_IDENTITY_ID,
      decision: fixture.decision,
    });
    expect(String(lockError)).toMatch(/database is locked/i);
    expect(custody.sign).toHaveBeenCalledTimes(1);
    expect(result.replayed).toBe(false);
    result.database.close();
  });

  it("fails closed after two absent store COMMITs and still signs only once", () => {
    const fixture = openPreparedFixture();
    const custody = observedCustody(fixture);
    expect(() =>
      signRejectedCommandResultPreparation({
        database: unknownCommitDatabase(fixture.facade, 2, "absent"),
        reopenDatabase: () => unknownCommitDatabase(reopen(fixture.databasePath), 1, "absent"),
        custody: custody.custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        decision: fixture.decision,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DormantCommandResultSigningError>>({
        code: "UNKNOWN_COMMIT_NOT_SETTLED",
      }),
    );
    expect(custody.sign).toHaveBeenCalledTimes(1);
    for (const signature of custody.signatures) expectDestroyed(signature);
  });

  it("does not sign after the reserved signing lease loses current authority", () => {
    const fixture = openPreparedFixture();
    const reserved = fixture.facade.commandAdjudication.reconcileRejectedDecision(fixture.decision);
    if (reserved === null) throw new Error("fixture decision is absent");
    fixture.facade.commandAdjudication.bindRejectedResultPreparation({
      fence: fixture.decision.fence,
      commandResultPreparationId: reserved.preparation.commandResultPreparationId,
    });
    reserved.canonicalPayload.destroy();
    fixture.database
      .prepare(
        `UPDATE server_signing_leases
            SET state = 'superseded', superseded_at_ms = ?
          WHERE signing_lease_id = ?`,
      )
      .run(NOW_MS, SIGNING_LEASE_ID);
    const custody = observedCustody(fixture);
    expect(() =>
      signRejectedCommandResultPreparation({
        database: fixture.facade,
        reopenDatabase: () => reopen(fixture.databasePath),
        custody: custody.custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        decision: fixture.decision,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DormantCommandResultSigningError>>({
        code: "SIGNER_NON_WRITABLE",
      }),
    );
    expect(custody.sign).not.toHaveBeenCalled();
    fixture.facade.close();
  });

  it("replays an exact durable signature without custody after a later signer takeover", () => {
    const fixture = openPreparedFixture();
    const initialCustody = observedCustody(fixture);
    const initial = signRejectedCommandResultPreparation({
      database: fixture.facade,
      reopenDatabase: () => reopen(fixture.databasePath),
      custody: initialCustody.custody,
      machineIdentityId: MACHINE_IDENTITY_ID,
      decision: fixture.decision,
    });
    fixture.database
      .prepare(
        `UPDATE server_signing_leases
            SET state = 'superseded', superseded_at_ms = ?
          WHERE signing_lease_id = ?`,
      )
      .run(NOW_MS, SIGNING_LEASE_ID);
    const replayCustody = observedCustody(fixture);
    const replay = signRejectedCommandResultPreparation({
      database: initial.database,
      reopenDatabase: () => reopen(fixture.databasePath),
      custody: replayCustody.custody,
      machineIdentityId: MACHINE_IDENTITY_ID,
      decision: fixture.decision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.commandResultPreparationId).toBe(initial.commandResultPreparationId);
    expect(replayCustody.sign).not.toHaveBeenCalled();
    replay.database.close();
  });
});

describeLinux("dormant rejected command-result finalizer", () => {
  it.each([
    "landed",
    "absent",
  ] as const)("reopens and request-bound reconciles a finalization COMMIT proved %s", (outcome) => {
    const fixture = openPreparedFixture();
    const signed = prepareSignedFinalization(fixture);
    signed.custody.sign.mockClear();
    const result = finalizeSignedRejectedCommandResult({
      database: unknownCommitDatabase(signed.database, 1, outcome),
      reopenDatabase: () => reopen(fixture.databasePath),
      machineIdentityId: MACHINE_IDENTITY_ID,
      finalization: signed.request,
    });
    expect(result).toMatchObject({
      commandId: signed.request.expectedCommandId,
      commandResultId: signed.request.expectedCommandResultId,
      commandResultPreparationId: signed.request.expectedCommandResultPreparationId,
      stableSemanticResultId: RESULT_ID,
      acceptedIngressDeliveryAttemptId: ACCEPTED_DELIVERY_ATTEMPT_ID,
      triggerIngressObservationId: COMPLETION_OBSERVATION_ID,
      replayed: outcome === "landed",
      reconciledUnknownCommitCount: 1,
    });
    expect(result.resultDeliveryId).toMatch(/^rrd_/);
    expect(result.deliveryAttemptId).toMatch(/^rda_/);
    expect(signed.custody.sign).not.toHaveBeenCalled();
    expect(Object.keys(result)).not.toEqual(
      expect.arrayContaining([
        "canonicalPayload",
        "signature",
        "signedRecordDigest",
        "identityKeyId",
        "publicKey",
      ]),
    );
    const verification = new DatabaseSync(fixture.databasePath, { readOnly: true });
    openDatabases.push(verification);
    const row = verification
      .prepare(
        `SELECT delivery_attempt_id, state
             FROM a1_ingress_result_deliveries
            WHERE result_delivery_id = ?`,
      )
      .get(result.resultDeliveryId);
    expect(row).toEqual({ delivery_attempt_id: result.deliveryAttemptId, state: "pending_seal" });
    result.database.close();
  });

  it("replays the exact retained IDs and delivery attempt without reallocating", () => {
    const fixture = openPreparedFixture();
    const signed = prepareSignedFinalization(fixture);
    const first = finalizeSignedRejectedCommandResult({
      database: signed.database,
      reopenDatabase: () => reopen(fixture.databasePath),
      machineIdentityId: MACHINE_IDENTITY_ID,
      finalization: signed.request,
    });
    const replay = finalizeSignedRejectedCommandResult({
      database: first.database,
      reopenDatabase: () => reopen(fixture.databasePath),
      machineIdentityId: MACHINE_IDENTITY_ID,
      finalization: signed.request,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.reconciledUnknownCommitCount).toBe(0);
    expect(replay.resultDeliveryId).toBe(first.resultDeliveryId);
    expect(replay.deliveryAttemptId).toBe(first.deliveryAttemptId);
    expect(replay.triggerIngressObservationId).toBe(first.triggerIngressObservationId);
    replay.database.close();
  });

  it("fails closed after two finalization COMMITs are each proved absent", () => {
    const fixture = openPreparedFixture();
    const signed = prepareSignedFinalization(fixture);
    expect(() =>
      finalizeSignedRejectedCommandResult({
        database: unknownCommitDatabase(signed.database, 1, "absent"),
        reopenDatabase: () => unknownCommitDatabase(reopen(fixture.databasePath), 1, "absent"),
        machineIdentityId: MACHINE_IDENTITY_ID,
        finalization: signed.request,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DormantCommandResultFinalizationError>>({
        code: "UNKNOWN_COMMIT_NOT_SETTLED",
      }),
    );
    const verification = new DatabaseSync(fixture.databasePath, { readOnly: true });
    openDatabases.push(verification);
    expect(
      verification.prepare("SELECT count(*) AS count FROM collaboration_command_results").get(),
    ).toEqual({ count: 0 });
  });

  it("terminalizes after source collision and route close without route or custody capability use", () => {
    const fixture = openPreparedFixture();
    const signed = prepareSignedFinalization(fixture);
    fixture.database.exec(`
      DROP TRIGGER authenticated_ingress_results_require_accepted_candidate;
      DROP TRIGGER authenticated_ingress_results_require_current_actor_update;
      DROP TRIGGER broker_route_runtime_status_require_exact_route_scope_update;
      DROP TRIGGER broker_route_runtime_status_require_current_actor_update;
      DROP TRIGGER broker_route_runtime_status_require_legal_update;
    `);
    fixture.database
      .prepare(
        `UPDATE authenticated_ingress_results
            SET state = 'quarantined_collision', collision_at_ms = 101, terminal_at_ms = 101
          WHERE stable_semantic_result_id = ?`,
      )
      .run(RESULT_ID);
    fixture.database
      .prepare(
        `UPDATE broker_route_runtime_status
            SET state = 'closed', active_gap_count = 1, updated_at_ms = 101
          WHERE broker_route_id = ?`,
      )
      .run(ROUTE_ID);
    signed.custody.sign.mockClear();
    const forbiddenCapabilityAccess = vi.fn();
    const database: DormantCommandResultFinalizationDatabase = {
      machineIdentityId: signed.database.machineIdentityId,
      commandAdjudication: signed.database.commandAdjudication,
      transaction<T>(operation: (transaction: HostStateTransaction) => T): T {
        return signed.database.transaction((transaction) =>
          operation(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property === "brokerRoute" || property === "serverSigning") {
                  forbiddenCapabilityAccess(property);
                  throw new Error(`finalizer reached forbidden ${String(property)} capability`);
                }
                return Reflect.get(target, property, receiver);
              },
            }),
          ),
        );
      },
      close: () => signed.database.close(),
    };
    const result = finalizeSignedRejectedCommandResult({
      database,
      reopenDatabase: () => reopen(fixture.databasePath),
      machineIdentityId: MACHINE_IDENTITY_ID,
      finalization: signed.request,
    });
    expect(result.stableSemanticResultId).toBe(RESULT_ID);
    expect(forbiddenCapabilityAccess).not.toHaveBeenCalled();
    expect(signed.custody.sign).not.toHaveBeenCalled();
    expect(
      fixture.database
        .prepare(
          "SELECT state, collision_at_ms, terminal_at_ms FROM authenticated_ingress_results WHERE stable_semantic_result_id = ?",
        )
        .get(RESULT_ID),
    ).toEqual({ state: "quarantined_collision", collision_at_ms: 101, terminal_at_ms: 101 });
    result.database.close();
  });

  it("rejects a colliding result identity without landing any terminal row", () => {
    const fixture = openPreparedFixture();
    const signed = prepareSignedFinalization(fixture);
    const collision = {
      ...signed.request,
      expectedCommandResultId: parseA1SafeId(`ccr_${encoded(32, 99)}`),
    };
    expect(() =>
      finalizeSignedRejectedCommandResult({
        database: signed.database,
        reopenDatabase: () => reopen(fixture.databasePath),
        machineIdentityId: MACHINE_IDENTITY_ID,
        finalization: collision,
      }),
    ).toThrow(/result identity does not recompute/);
    for (const table of [
      "collaboration_command_results",
      "a1_ingress_terminal_results",
      "a1_ingress_result_deliveries",
      "server_signed_record_acceptances",
    ]) {
      expect(fixture.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    signed.database.close();
  });

  it("classifies a partial retained graph as corruption instead of retrying", () => {
    const fixture = openPreparedFixture();
    const signed = prepareSignedFinalization(fixture);
    const landed = finalizeSignedRejectedCommandResult({
      database: signed.database,
      reopenDatabase: () => reopen(fixture.databasePath),
      machineIdentityId: MACHINE_IDENTITY_ID,
      finalization: signed.request,
    });
    fixture.database.exec("DROP TRIGGER a1_ingress_result_deliveries_no_delete");
    fixture.database.exec("PRAGMA foreign_keys = OFF");
    fixture.database.prepare("DELETE FROM a1_ingress_result_deliveries").run();
    fixture.database.exec("PRAGMA foreign_keys = ON");
    expect(() =>
      finalizeSignedRejectedCommandResult({
        database: landed.database,
        reopenDatabase: () => reopen(fixture.databasePath),
        machineIdentityId: MACHINE_IDENTITY_ID,
        finalization: signed.request,
      }),
    ).toThrow(/delivery is absent/);
    landed.database.close();
  });
});
