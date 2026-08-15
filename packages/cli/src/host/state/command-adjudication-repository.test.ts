import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandAdjudicationRepositoryOperations } from "./command-adjudication-repository.js";
import { parseA1CanonicalId, parseA1SafeId, parseEd25519Signature } from "./ids.js";
import {
  VERSION_EIGHT_DATA_STATEMENTS,
  VERSION_EIGHT_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v8.js";
import {
  VERSION_NINE_DATA_STATEMENTS,
  VERSION_NINE_PRE_SCHEMA_STATEMENTS,
  VERSION_NINE_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v9.js";
import {
  VERSION_TEN_DATA_STATEMENTS,
  VERSION_TEN_PRE_SCHEMA_STATEMENTS,
  VERSION_TEN_SQLITE_SCHEMA_ENTRIES,
} from "./migration-v10.js";
import { expectedHostStateMigrationDigest, HOST_STATE_MIGRATIONS } from "./migrations.js";
import { parseCoordinatorLeaseFence } from "./records.js";

const MACHINE_IDENTITY_ID = "0".repeat(32);
const SERVER_ID = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const COORDINATOR_LEASE_ID = parseA1CanonicalId("coordinatorLease", `rccl_${encoded(16, 2)}`);
const SUCCESSOR_COORDINATOR_LEASE_ID = parseA1CanonicalId(
  "coordinatorLease",
  `rccl_${encoded(16, 12)}`,
);
const SIGNING_KEY_REF = `rcph_${encoded(16, 3)}`;
const TRUST_REF = `rcph_${encoded(16, 4)}`;
const RESULT_ID = parseA1SafeId(`rrs_${encoded(32, 5)}`);
const SECOND_RESULT_ID = parseA1SafeId(`rrs_${encoded(32, 13)}`);
const THIRD_RESULT_ID = parseA1SafeId(`rrs_${encoded(32, 16)}`);
const ROUTE_ID = `rcr_${encoded(32, 6)}`;
const SECOND_ROUTE_ID = `rcr_${encoded(32, 14)}`;
const SOURCE_NAMESPACE_ID = `wns_${encoded(32, 7)}`;
const MESSAGE_DIGEST = encoded(32, 8);
const EVENT_FINGERPRINT = encoded(32, 9);
const SERVER_IDENTITY_KEY_ID = "server-key-1";
const SCOPE_CERTIFICATE_ID = "server-cert-1";
const SIGNING_LEASE_ID = parseA1SafeId("server-signing-lease-1");
const SUCCESSOR_SIGNING_LEASE_ID = parseA1SafeId("server-signing-lease-2");

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

function sqliteExecutor(database: DatabaseSync, observedSql: string[] = []) {
  return {
    transaction<T>(
      operation: (transaction: {
        get(sql: string, parameters: readonly (string | number | Uint8Array | null)[]): unknown;
        all(sql: string, parameters: readonly (string | number | Uint8Array | null)[]): unknown[];
        run(
          sql: string,
          parameters: readonly (string | number | Uint8Array | null)[],
        ): { changes: number | bigint };
      }) => T,
    ): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const transaction = {
          get(sql: string, parameters: readonly (string | number | Uint8Array | null)[]) {
            observedSql.push(sql);
            return database.prepare(sql).get(...parameters);
          },
          all(sql: string, parameters: readonly (string | number | Uint8Array | null)[]) {
            observedSql.push(sql);
            return database.prepare(sql).all(...parameters);
          },
          run(sql: string, parameters: readonly (string | number | Uint8Array | null)[]) {
            observedSql.push(sql);
            return database.prepare(sql).run(...parameters);
          },
        };
        const result = operation(transaction);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function openFixture(publicKey: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
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
      `rda_${encoded(16, 10)}`,
    );
  addAwaitingIngress(database, SECOND_RESULT_ID, SECOND_ROUTE_ID, 0);
  addAwaitingIngress(database, THIRD_RESULT_ID, ROUTE_ID, 1);
  database
    .prepare(
      `INSERT OR IGNORE INTO broker_route_runtime_status
         (broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
          machine_identity_id, state, current_channel_generation, active_gap_count,
          updated_at_ms)
       VALUES (?, ?, 'server_control', NULL, ?, 'current', 0, 0, 5)`,
    )
    .run(ROUTE_ID, SERVER_ID, MACHINE_IDENTITY_ID);
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
  return database;
}

function addAwaitingIngress(
  database: DatabaseSync,
  resultId: string,
  routeId: string,
  frameIndex: number,
): void {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
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
         VALUES (?, ?, ?, 'server_control', NULL, ?, ?, 'new_chat', ?, 1,
                 'remote-claw/a1-ingress-new-chat/v1', ?,
                 'remote-claw/a1/source-event-fingerprint/v1', ?, ?, 0, ?, 0, ?,
                 1000, 'awaiting_order', NULL, NULL)`,
      )
      .run(
        resultId,
        routeId,
        SERVER_ID,
        SOURCE_NAMESPACE_ID,
        `message-extra-${frameIndex}`,
        `client-extra-${frameIndex}`,
        MESSAGE_DIGEST,
        EVENT_FINGERPRINT,
        `rda_${encoded(16, 20 + frameIndex)}`,
        frameIndex,
        frameIndex,
      );
    if (
      database
        .prepare("SELECT 1 FROM broker_route_runtime_status WHERE broker_route_id = ?")
        .get(routeId) === undefined
    ) {
      database
        .prepare(
          `INSERT INTO broker_route_runtime_status
             (broker_route_id, collaboration_server_id, route_kind, logical_chat_id,
              machine_identity_id, state, current_channel_generation, active_gap_count,
              updated_at_ms)
           VALUES (?, ?, 'server_control', NULL, ?, 'current', 0, 0, 5)`,
        )
        .run(routeId, SERVER_ID, MACHINE_IDENTITY_ID);
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function takeOverCurrentSigner(database: DatabaseSync): void {
  database
    .prepare(
      `UPDATE coordinator_leases SET released_at_ms = 130, state = 'released'
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
       VALUES (?, ?, 2, 'owner-2', 131, 10000, 10000, NULL, 'current')`,
    )
    .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);
  database
    .prepare(
      `UPDATE collaboration_servers
          SET current_coordinator_epoch = 2, current_coordinator_lease_id = ?
        WHERE collaboration_server_id = ?`,
    )
    .run(SUCCESSOR_COORDINATOR_LEASE_ID, SERVER_ID);
  database
    .prepare(
      `INSERT INTO server_signing_leases
         (signing_lease_id, collaboration_server_id, identity_key_id, key_generation,
          scope_certificate_id, coordinator_lease_id, coordinator_epoch, fencing_token,
          acquired_at_ms, draining_at_ms, superseded_at_ms, closed_at_ms, state)
       VALUES (?, ?, ?, 1, ?, ?, 2, 2, 131, NULL, NULL, NULL, 'current')`,
    )
    .run(
      SUCCESSOR_SIGNING_LEASE_ID,
      SERVER_ID,
      SERVER_IDENTITY_KEY_ID,
      SCOPE_CERTIFICATE_ID,
      SUCCESSOR_COORDINATOR_LEASE_ID,
    );
}

describe("command adjudication repository", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("materializes, reserves, binds, and signs a small evidence-bound rejection", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" });
    const database = openFixture(publicJwk.x as string);
    databases.push(database);
    const observedSql: string[] = [];
    let clock = 100;
    let entropy = 40;
    const repository = createCommandAdjudicationRepositoryOperations(
      sqliteExecutor(database, observedSql),
      MACHINE_IDENTITY_ID,
      {
        nowMs: () => clock,
        randomBytes: (length) => new Uint8Array(length).fill(entropy++),
      },
    );
    const fence = parseCoordinatorLeaseFence({
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: COORDINATOR_LEASE_ID,
      coordinatorEpoch: 1,
    });

    const ready = repository.materializeReadyIngressCommand({
      fence,
      stableSemanticResultId: RESULT_ID,
      expectedReadyAtJournalSeq: 0,
    });
    expect(ready.command.canonicalCommandPayloadSchemaId).toBe(
      "remote-claw/command-payload/unsupported-recognized/v1",
    );
    const storedPayload = database
      .prepare("SELECT byte_length FROM protected_artifacts WHERE protected_handle_id = ?")
      .get(ready.command.canonicalCommandPayloadRef) as { byte_length: number };
    expect(storedPayload.byte_length).toBeLessThan(1024);

    clock = 99;
    const decision = repository.reserveRejectedDecision({
      fence,
      expectedCommandId: ready.command.commandId,
      expectedCommandSeq: 0,
      expectedSignerSequence: 1,
      expectedSigningLeaseId: SIGNING_LEASE_ID,
    });
    expect(decision.command.decidedAtMs).toBe(100);
    expect(decision.command.decisionCoordinatorEpoch).toBe(1);
    expect(decision.preparation.state).toBe("reserved");
    decision.canonicalPayload.destroy();

    expect(
      repository.reconcileRejectedResultPreparationBinding({
        fence,
        commandResultPreparationId: decision.preparation.commandResultPreparationId,
      }),
    ).toBeNull();
    expect(
      repository.reconcileSignedRejectedResultPreparation({
        fence,
        commandResultPreparationId: decision.preparation.commandResultPreparationId,
        signature: parseEd25519Signature(encoded(64, 15)),
      }),
    ).toBeNull();
    expect(
      repository.reconcileAbortedRejectedResultPreparation({
        fence,
        commandResultPreparationId: decision.preparation.commandResultPreparationId,
      }),
    ).toBeNull();

    const bound = repository.bindRejectedResultPreparation({
      fence,
      commandResultPreparationId: decision.preparation.commandResultPreparationId,
    });
    expect(bound.preparation.state).toBe("bound");
    expect(
      repository.reconcileSignedRejectedResultPreparation({
        fence,
        commandResultPreparationId: decision.preparation.commandResultPreparationId,
        signature: parseEd25519Signature(encoded(64, 15)),
      }),
    ).toBeNull();
    const payload = database
      .prepare("SELECT artifact_bytes FROM protected_artifacts WHERE protected_handle_id = ?")
      .get(decision.preparation.canonicalPayloadRef) as { artifact_bytes: Uint8Array };
    const signature = parseEd25519Signature(
      base64urlEncode(signEd25519(null, payload.artifact_bytes, privateKey)),
    );
    const signed = repository.storeSignedRejectedResultPreparation({
      fence,
      commandResultPreparationId: decision.preparation.commandResultPreparationId,
      signature,
    });
    expect(signed.preparation.state).toBe("signed");
    expect(signed.signingGroup.state).toBe("result_signed");
    expect(signed.signatureReservation.signedArtifactId).toBe(
      decision.preparation.commandResultPreparationId,
    );
    expect(observedSql.join("\n")).not.toContain("authenticated_ingress_parts");
  });

  it("retries aborted reservations through generation three without changing the decision", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const database = openFixture((publicKey.export({ format: "jwk" }) as JsonWebKey).x as string);
    databases.push(database);
    let entropy = 60;
    const repository = createCommandAdjudicationRepositoryOperations(
      sqliteExecutor(database),
      MACHINE_IDENTITY_ID,
      {
        nowMs: () => 200,
        randomBytes: (length) => new Uint8Array(length).fill(entropy++),
      },
    );
    const fence = parseCoordinatorLeaseFence({
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: COORDINATOR_LEASE_ID,
      coordinatorEpoch: 1,
    });
    const ready = repository.materializeReadyIngressCommand({
      fence,
      stableSemanticResultId: RESULT_ID,
      expectedReadyAtJournalSeq: 0,
    });
    const first = repository.reserveRejectedDecision({
      fence,
      expectedCommandId: ready.command.commandId,
      expectedCommandSeq: 0,
      expectedSignerSequence: 1,
      expectedSigningLeaseId: SIGNING_LEASE_ID,
    });
    first.canonicalPayload.destroy();
    repository.abortRejectedResultPreparation({
      fence,
      commandResultPreparationId: first.preparation.commandResultPreparationId,
    });
    const second = repository.reserveReplacementRejectedResultPreparation({
      fence,
      expectedPriorPreparationId: first.preparation.commandResultPreparationId,
      expectedSignerSequence: 2,
      expectedSigningLeaseId: SIGNING_LEASE_ID,
    });
    second.canonicalPayload.destroy();
    expect(second.preparation.preparationGeneration).toBe(2);
    expect(second.command.commandSeq).toBe(first.command.commandSeq);
    expect(second.command.canonicalCommandRecordDigest).toBe(
      first.command.canonicalCommandRecordDigest,
    );
    repository.abortRejectedResultPreparation({
      fence,
      commandResultPreparationId: second.preparation.commandResultPreparationId,
    });
    const third = repository.reserveReplacementRejectedResultPreparation({
      fence,
      expectedPriorPreparationId: second.preparation.commandResultPreparationId,
      expectedSignerSequence: 3,
      expectedSigningLeaseId: SIGNING_LEASE_ID,
    });
    third.canonicalPayload.destroy();
    expect(third.preparation.preparationGeneration).toBe(3);
    expect(third.preparation.supersedesPreparationRef).toBe(
      second.preparation.commandResultPreparationId,
    );
    expect(repository.readState(RESULT_ID)?.preparation?.commandResultPreparationId).toBe(
      third.preparation.commandResultPreparationId,
    );
  });

  it("sequences the server-wide ready head rather than caller-selected later work", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const database = openFixture((publicKey.export({ format: "jwk" }) as JsonWebKey).x as string);
    databases.push(database);
    let entropy = 80;
    const repository = createCommandAdjudicationRepositoryOperations(
      sqliteExecutor(database),
      MACHINE_IDENTITY_ID,
      {
        nowMs: () => 300,
        randomBytes: (length) => new Uint8Array(length).fill(entropy++),
      },
    );
    const fence = parseCoordinatorLeaseFence({
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: COORDINATOR_LEASE_ID,
      coordinatorEpoch: 1,
    });
    const first = repository.materializeReadyIngressCommand({
      fence,
      stableSemanticResultId: RESULT_ID,
      expectedReadyAtJournalSeq: 0,
    });
    const second = repository.materializeReadyIngressCommand({
      fence,
      stableSemanticResultId: SECOND_RESULT_ID,
      expectedReadyAtJournalSeq: 1,
    });
    expect(() =>
      repository.reserveRejectedDecision({
        fence,
        expectedCommandId: second.command.commandId,
        expectedCommandSeq: 0,
        expectedSignerSequence: 1,
        expectedSigningLeaseId: SIGNING_LEASE_ID,
      }),
    ).toThrow(/server-wide ready-order head/);
    const decision = repository.reserveRejectedDecision({
      fence,
      expectedCommandId: first.command.commandId,
      expectedCommandSeq: 0,
      expectedSignerSequence: 1,
      expectedSigningLeaseId: SIGNING_LEASE_ID,
    });
    decision.canonicalPayload.destroy();
    expect(decision.command.commandId).toBe(first.command.commandId);
  });

  it("advances to the next same-route result after materializing the first", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const database = openFixture((publicKey.export({ format: "jwk" }) as JsonWebKey).x as string);
    databases.push(database);
    let entropy = 100;
    const repository = createCommandAdjudicationRepositoryOperations(
      sqliteExecutor(database),
      MACHINE_IDENTITY_ID,
      {
        nowMs: () => 400,
        randomBytes: (length) => new Uint8Array(length).fill(entropy++),
      },
    );
    const fence = parseCoordinatorLeaseFence({
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: COORDINATOR_LEASE_ID,
      coordinatorEpoch: 1,
    });
    repository.materializeReadyIngressCommand({
      fence,
      stableSemanticResultId: RESULT_ID,
      expectedReadyAtJournalSeq: 0,
    });
    const second = repository.materializeReadyIngressCommand({
      fence,
      stableSemanticResultId: THIRD_RESULT_ID,
      expectedReadyAtJournalSeq: 1,
    });
    expect(second.command.sourceRef).toBe(THIRD_RESULT_ID);
  });

  it("keeps creation provenance while a successor coordinator reserves the decision", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const database = openFixture((publicKey.export({ format: "jwk" }) as JsonWebKey).x as string);
    databases.push(database);
    let clock = 100;
    let entropy = 120;
    const repository = createCommandAdjudicationRepositoryOperations(
      sqliteExecutor(database),
      MACHINE_IDENTITY_ID,
      {
        nowMs: () => clock,
        randomBytes: (length) => new Uint8Array(length).fill(entropy++),
      },
    );
    const firstFence = parseCoordinatorLeaseFence({
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: COORDINATOR_LEASE_ID,
      coordinatorEpoch: 1,
    });
    const ready = repository.materializeReadyIngressCommand({
      fence: firstFence,
      stableSemanticResultId: RESULT_ID,
      expectedReadyAtJournalSeq: 0,
    });
    takeOverCurrentSigner(database);
    clock = 120;
    const secondFence = parseCoordinatorLeaseFence({
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: SUCCESSOR_COORDINATOR_LEASE_ID,
      coordinatorEpoch: 2,
    });
    const decision = repository.reserveRejectedDecision({
      fence: secondFence,
      expectedCommandId: ready.command.commandId,
      expectedCommandSeq: 0,
      expectedSignerSequence: 1,
      expectedSigningLeaseId: SUCCESSOR_SIGNING_LEASE_ID,
    });
    decision.canonicalPayload.destroy();
    expect(decision.command.coordinatorEpoch).toBe(1);
    expect(decision.command.decisionCoordinatorEpoch).toBe(2);
    expect(decision.command.decidedAtMs).toBe(131);
  });

  it("clamps ready materialization to the durable route time after wall-clock rollback", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const database = openFixture((publicKey.export({ format: "jwk" }) as JsonWebKey).x as string);
    databases.push(database);
    database.exec(`
      DROP TRIGGER broker_route_runtime_status_require_exact_route_scope_update;
      DROP TRIGGER broker_route_runtime_status_require_current_actor_update;
      DROP TRIGGER broker_route_runtime_status_require_legal_update;
    `);
    database
      .prepare(
        `UPDATE broker_route_runtime_status
            SET updated_at_ms = 511
          WHERE broker_route_id = ?`,
      )
      .run(ROUTE_ID);
    let entropy = 130;
    const repository = createCommandAdjudicationRepositoryOperations(
      sqliteExecutor(database),
      MACHINE_IDENTITY_ID,
      {
        nowMs: () => 500,
        randomBytes: (length) => new Uint8Array(length).fill(entropy++),
      },
    );
    const ready = repository.materializeReadyIngressCommand({
      fence: parseCoordinatorLeaseFence({
        collaborationServerId: SERVER_ID,
        coordinatorLeaseId: COORDINATOR_LEASE_ID,
        coordinatorEpoch: 1,
      }),
      stableSemanticResultId: RESULT_ID,
      expectedReadyAtJournalSeq: 0,
    });
    expect(ready.command.createdAtMs).toBe(511);
    expect(ready.readyEntry.readyAtMs).toBe(511);
  });

  it("blocks a ready command on a later active route gap and resumes only after recovery", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const database = openFixture((publicKey.export({ format: "jwk" }) as JsonWebKey).x as string);
    databases.push(database);
    let entropy = 140;
    const repository = createCommandAdjudicationRepositoryOperations(
      sqliteExecutor(database),
      MACHINE_IDENTITY_ID,
      {
        nowMs: () => 500,
        randomBytes: (length) => new Uint8Array(length).fill(entropy++),
      },
    );
    const fence = parseCoordinatorLeaseFence({
      collaborationServerId: SERVER_ID,
      coordinatorLeaseId: COORDINATOR_LEASE_ID,
      coordinatorEpoch: 1,
    });
    const ready = repository.materializeReadyIngressCommand({
      fence,
      stableSemanticResultId: RESULT_ID,
      expectedReadyAtJournalSeq: 0,
    });
    // This focused fixture deliberately omits the v7 broker-route graph. Inject
    // the route runtime state that the v8 recovery ledger ordinarily maintains.
    database.exec(`
      DROP TRIGGER broker_route_runtime_status_require_exact_route_scope_update;
      DROP TRIGGER broker_route_runtime_status_require_current_actor_update;
      DROP TRIGGER broker_route_runtime_status_require_legal_update;
    `);
    database
      .prepare(
        `UPDATE broker_route_runtime_status
            SET state = 'quarantined', active_gap_count = 1, updated_at_ms = 510
          WHERE broker_route_id = ?`,
      )
      .run(ROUTE_ID);
    expect(() =>
      repository.reserveRejectedDecision({
        fence,
        expectedCommandId: ready.command.commandId,
        expectedCommandSeq: 0,
        expectedSignerSequence: 1,
        expectedSigningLeaseId: SIGNING_LEASE_ID,
      }),
    ).toThrow(/active gap/);

    database
      .prepare(
        `UPDATE broker_route_runtime_status
            SET state = 'current', active_gap_count = 0, updated_at_ms = 511
          WHERE broker_route_id = ?`,
      )
      .run(ROUTE_ID);
    const decision = repository.reserveRejectedDecision({
      fence,
      expectedCommandId: ready.command.commandId,
      expectedCommandSeq: 0,
      expectedSignerSequence: 1,
      expectedSigningLeaseId: SIGNING_LEASE_ID,
    });
    decision.canonicalPayload.destroy();
    expect(decision.command.decidedAtMs).toBe(511);
  });
});
