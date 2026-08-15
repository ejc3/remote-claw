import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  base64urlEncode,
  canonicalServerScopeCertificatePayload,
  parseServerScopeCertificateCanonicalPayloadInput,
  parseServerScopeCertificateRecord,
} from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeInitialServerSigner } from "../server-signer/orchestrator.js";
import {
  createServerKeyCustodySigner,
  reconcileUsableInitialServerSigner,
} from "../server-signer/service.js";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId, parseEd25519PublicKey } from "./ids.js";
import { resolveHostStatePaths } from "./path.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  encodeServerSignerBootstrapIntentV1,
  parseServerSignerBootstrapIntentV1,
  SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
  SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
  serverSignerBootstrapIntentDigest,
} from "./server-signing.js";
import { SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE } from "./server-signing-repository.js";
import { openHostStateDatabase } from "./sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "./test-environment.js";

const MACHINE_IDENTITY_ID = "a7".repeat(16);
const NOW_MS = 700_000;
const temporaryRoots: string[] = [];
const describeLinux = describe.runIf(
  process.platform === "linux" &&
    typeof process.getuid === "function" &&
    HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
);

function digestBytes(bytes: Uint8Array) {
  return parseA1Digest(base64urlEncode(createHash("sha256").update(bytes).digest()));
}

function coordinatorId(fill: number) {
  return parseA1CanonicalId(
    "coordinatorLease",
    `rccl_${base64urlEncode(new Uint8Array(16).fill(fill))}`,
  );
}

function protectedHandleId(fill: number) {
  return parseA1CanonicalId(
    "protectedHandle",
    `rcph_${base64urlEncode(new Uint8Array(16).fill(fill))}`,
  );
}

function destroyEnvelope(envelope: {
  wrapNonce: ProtectedByteSnapshot;
  wrappedPkcs8: ProtectedByteSnapshot;
  authTag: ProtectedByteSnapshot;
}): void {
  envelope.wrapNonce.destroy();
  envelope.wrappedPkcs8.destroy();
  envelope.authTag.destroy();
}

function temporaryState() {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a17b-server-signing-"),
  );
  temporaryRoots.push(root);
  const environment = { xdgStateHome: join(root, "state"), homeDirectory: join(root, "home") };
  return { environment, paths: resolveHostStatePaths(MACHINE_IDENTITY_ID, environment) };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeLinux("A1.7b server signing SQLite integration", () => {
  it("atomically reserves, binds, stores, and installs the initial signer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    let database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const rootSecret = new Uint8Array(32).fill(17);
    const signer = createServerKeyCustodySigner(rootSecret);
    const signingKeyRef = protectedHandleId(18);
    let retainedEnvelope: ReturnType<typeof signer.generateIdentityKey> | undefined;
    try {
      const server = database.records.ensureDefaultCollaborationServer().server;
      const coordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: coordinatorId(19),
        ownerInstanceId: parseA1SafeId("server-signer-owner-1"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      const fence = {
        collaborationServerId: server.collaborationServerId,
        coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: coordinator.lease.coordinatorEpoch,
      };
      const envelope = signer.generateIdentityKey(
        MACHINE_IDENTITY_ID,
        server.collaborationServerId,
        signingKeyRef,
        1,
      );
      retainedEnvelope = envelope;
      const bootstrapSigningLeaseId = parseA1SafeId("server-bootstrap-lease-1");
      const scopeCertificateId = parseA1SafeId("server-scope-certificate-1");
      const intent = parseServerSignerBootstrapIntentV1({
        schemaVersion: 1,
        canonicalPayloadSchemaId: SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
        machineIdentityId: MACHINE_IDENTITY_ID,
        collaborationServerId: server.collaborationServerId,
        bootstrapSigningLeaseId,
        purpose: "initial_pair",
        expectedPriorScopeCertificateId: null,
        proposedIdentityKeyId: envelope.binding.identityKeyId,
        proposedKeyGeneration: 1,
        proposedKeyAlgorithm: "Ed25519",
        proposedPublicKey: envelope.binding.publicKey,
        proposedScopeCertificateId: scopeCertificateId,
        signingKeyRef,
        preparedAtMs: NOW_MS,
      });
      const intentBytes = encodeServerSignerBootstrapIntentV1(intent);
      const intentSnapshot = ProtectedByteSnapshot.from(intentBytes);
      const certificatePayload = parseServerScopeCertificateCanonicalPayloadInput({
        schemaVersion: 1,
        canonicalPayloadSchemaId: SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
        scopeCertificateId,
        collaborationServerId: server.collaborationServerId,
        machineIdentityId: MACHINE_IDENTITY_ID,
        subjectIdentityKeyId: envelope.binding.identityKeyId,
        subjectKeyAlgorithm: "Ed25519",
        subjectPublicKey: envelope.binding.publicKey,
        keyGeneration: 1,
        issuedAtMs: NOW_MS,
        supersedesScopeCertificateId: null,
        signerIdentityKeyId: envelope.binding.identityKeyId,
        signerSequence: 0,
        supersededSignerMaxSequence: null,
        signatureAlgorithm: "Ed25519",
        canonicalPayloadDigestAlgorithm: "SHA-256",
      });
      const canonicalPayloadBytes = canonicalServerScopeCertificatePayload(certificatePayload);
      const canonicalPayloadDigest = digestBytes(canonicalPayloadBytes);
      const canonicalPayloadSnapshot = ProtectedByteSnapshot.from(canonicalPayloadBytes);
      const signatureSnapshot = signer.sign(envelope, canonicalPayloadSnapshot);
      const signatureBytes = signatureSnapshot.copyBytes();
      const certificate = parseServerScopeCertificateRecord({
        ...certificatePayload,
        canonicalPayloadDigest,
        signature: base64urlEncode(signatureBytes),
      });
      try {
        const phase = database.transaction((transaction) => {
          const intentArtifact = transaction.putArtifact({
            scopeKind: "collaboration_server",
            scopeId: server.collaborationServerId,
            artifactSchemaId: SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
            artifactDigest: serverSignerBootstrapIntentDigest(intent),
            artifactBytes: intentSnapshot,
          });
          const payloadArtifact = transaction.putArtifact({
            scopeKind: "collaboration_server",
            scopeId: server.collaborationServerId,
            artifactSchemaId: SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
            artifactDigest: canonicalPayloadDigest,
            artifactBytes: canonicalPayloadSnapshot,
          });
          const prepareRequest = {
            fence,
            bootstrapIntent: intent,
            bootstrapSigningLeaseId,
            operatorIntentEvidenceRef: intentArtifact.artifactRef.protectedHandleId,
            operatorIntentEvidenceDigest: intentArtifact.artifactDigest,
            proposedScopeCertificateId: scopeCertificateId,
            expectedServerSignatureSeq: 0,
            expectedFencingToken: 0,
            key: {
              identityKeyId: envelope.binding.identityKeyId,
              publicKey: parseEd25519PublicKey(envelope.binding.publicKey),
              signingKeyRef,
              wrappingSchemaId: envelope.wrappingSchemaId,
              wrapNonce: envelope.wrapNonce,
              wrappedPkcs8: envelope.wrappedPkcs8,
              authTag: envelope.authTag,
              pkcs8Digest: envelope.pkcs8Digest,
            },
          };
          const prepared = transaction.serverSigning.prepareInitialBootstrap(prepareRequest);
          const bindRequest = {
            fence,
            bootstrapSigningLeaseId,
            fencingToken: 1,
            signerSequence: 0,
            canonicalPayloadRef: payloadArtifact.artifactRef.protectedHandleId,
            certificatePayload,
          };
          const bindAbsent = transaction.serverSigning.reconcileInitialBootstrap({
            prepare: prepareRequest,
            bind: bindRequest,
            store: null,
            finalize: null,
          });
          expect(bindAbsent).toMatchObject({
            attemptedPhase: "bind",
            durablePhase: "prepare",
            landed: false,
          });
          if (bindAbsent !== null) destroyEnvelope(bindAbsent.privateKeyEnvelope);
          expect(() =>
            transaction.serverSigning.bindInitialScopeCertificate({
              ...bindRequest,
              certificatePayload: parseServerScopeCertificateCanonicalPayloadInput({
                ...certificatePayload,
                signerSequence: 1,
              }),
            }),
          ).toThrow(/initial certificate payload/);
          expect(() =>
            transaction.serverSigning.bindInitialScopeCertificate({
              ...bindRequest,
              certificatePayload: parseServerScopeCertificateCanonicalPayloadInput({
                ...certificatePayload,
                issuedAtMs: NOW_MS - 1,
              }),
            }),
          ).toThrow(/initial certificate payload/);
          expect(() =>
            transaction.serverSigning.bindInitialScopeCertificate({
              ...bindRequest,
              certificatePayload: parseServerScopeCertificateCanonicalPayloadInput({
                ...certificatePayload,
                issuedAtMs: NOW_MS + 1,
              }),
            }),
          ).toThrow(/later than the bind observation/);
          const bound = transaction.serverSigning.bindInitialScopeCertificate(bindRequest);
          const storeRequest = {
            fence,
            bootstrapSigningLeaseId,
            fencingToken: 1,
            certificate,
          };
          const storeAbsent = transaction.serverSigning.reconcileInitialBootstrap({
            prepare: prepareRequest,
            bind: bindRequest,
            store: storeRequest,
            finalize: null,
          });
          expect(storeAbsent).toMatchObject({
            attemptedPhase: "store",
            durablePhase: "bind",
            landed: false,
          });
          if (storeAbsent !== null) destroyEnvelope(storeAbsent.privateKeyEnvelope);
          const finalizeRequest = {
            fence,
            bootstrapSigningLeaseId,
            fencingToken: 1,
            signingLeaseId: parseA1SafeId("server-signing-lease-1"),
            certificate,
          };
          return {
            prepared,
            bound,
            reconciliationRequest: {
              prepare: prepareRequest,
              bind: bindRequest,
              store: storeRequest,
              finalize: finalizeRequest,
            },
          };
        });
        expect(phase.prepared.reservation.state).toBe("reserved");
        expect(phase.bound.reservation.state).toBe("bound");
        const boundDatabasePath = `${database.databasePath}.bound`;
        database.close();
        copyFileSync(database.databasePath, boundDatabasePath);
        database = openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        });
        const stored = database.serverSigning.storeInitialSignedScopeCertificate(
          phase.reconciliationRequest.store,
        );
        const finalizeAbsent = database.serverSigning.reconcileInitialBootstrap(
          phase.reconciliationRequest,
        );
        expect(finalizeAbsent).toMatchObject({
          attemptedPhase: "finalize",
          durablePhase: "store",
          landed: false,
        });
        if (finalizeAbsent !== null) destroyEnvelope(finalizeAbsent.privateKeyEnvelope);
        const finalized = database.serverSigning.finalizeInitialBootstrap(
          phase.reconciliationRequest.finalize,
        );
        const landed = database.serverSigning.reconcileInitialBootstrap(
          phase.reconciliationRequest,
        );
        expect(landed).toMatchObject({
          attemptedPhase: "finalize",
          durablePhase: "finalize",
          landed: true,
        });
        if (landed !== null) destroyEnvelope(landed.privateKeyEnvelope);
        const result = { ...phase, stored, finalized };
        expect(result.stored.reservation.state).toBe("signed");
        expect(result.finalized.bootstrapLease.state).toBe("closed");
        expect(result.finalized.signingLease).toMatchObject({ state: "current", fencingToken: 2 });
        expect(result.finalized.acceptance.acceptedAtJournalSeq).toBe(0);
        const usable = reconcileUsableInitialServerSigner(
          signer,
          database.serverSigning,
          result.reconciliationRequest,
        );
        expect(usable).toMatchObject({ authorityCurrent: true, writable: true });
        if (usable !== null) destroyEnvelope(usable.privateKeyEnvelope);
        const wrongRootSecret = new Uint8Array(32).fill(99);
        const wrongRoot = createServerKeyCustodySigner(wrongRootSecret);
        try {
          const rejected = reconcileUsableInitialServerSigner(
            wrongRoot,
            database.serverSigning,
            result.reconciliationRequest,
          );
          expect(rejected).toMatchObject({
            authorityCurrent: true,
            writable: false,
            nonWritableReason: "unusable_key_custody",
          });
          if (rejected !== null) destroyEnvelope(rejected.privateKeyEnvelope);
        } finally {
          wrongRoot.close();
          wrongRootSecret.fill(0);
        }
        vi.setSystemTime(NOW_MS + 600_001);
        const successor = database.records.acquireCoordinatorLease({
          collaborationServerId: server.collaborationServerId,
          candidateLeaseId: coordinatorId(20),
          ownerInstanceId: parseA1SafeId("server-signer-owner-2"),
          expectedCurrentLeaseId: fence.coordinatorLeaseId,
          expectedCoordinatorEpoch: fence.coordinatorEpoch,
          leaseDurationMs: 600_000,
        });
        const staleReconciliation = database.serverSigning.reconcileInitialBootstrap(
          result.reconciliationRequest,
        );
        expect(staleReconciliation).toMatchObject({
          landed: true,
          writable: false,
          nonWritableReason: "stale_signing_lease_fence",
          signingLease: { state: "superseded", fencingToken: 2 },
        });
        if (staleReconciliation !== null) {
          destroyEnvelope(staleReconciliation.privateKeyEnvelope);
        }
        const successorFence = {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: successor.lease.coordinatorLeaseId,
          coordinatorEpoch: successor.lease.coordinatorEpoch,
        };
        const acquireRequest = {
          fence: successorFence,
          signingLeaseId: parseA1SafeId("server-signing-lease-2"),
          expectedCurrentSigningLeaseId: result.finalized.signingLease.signingLeaseId,
          expectedFencingToken: result.finalized.signingLease.fencingToken,
        };
        const acquired = database.serverSigning.acquireCurrentSigningLease(acquireRequest);
        expect(acquired).toMatchObject({
          replayed: false,
          predecessor: { state: "superseded", fencingToken: 2 },
          signingLease: { state: "current", fencingToken: 3 },
        });
        expect(database.serverSigning.acquireCurrentSigningLease(acquireRequest)).toMatchObject({
          replayed: true,
          signingLease: { state: "current", fencingToken: 3 },
        });
        const inventory = database.serverSigning.readInventory(server.collaborationServerId);
        try {
          expect(inventory.reservations).toHaveLength(1);
          expect(inventory.scopeCertificates).toHaveLength(1);
          expect(inventory.acceptances).toHaveLength(1);
          expect(inventory.signingLeases).toMatchObject([
            { state: "superseded", fencingToken: 2 },
            { state: "current", fencingToken: 3 },
          ]);
        } finally {
          for (const storedEnvelope of inventory.privateKeyEnvelopes)
            destroyEnvelope(storedEnvelope);
        }
        const reader = new DatabaseSync(database.databasePath, { readOnly: true });
        try {
          expect(
            reader
              .prepare(
                "SELECT next_server_signature_seq AS value FROM collaboration_servers WHERE collaboration_server_id = ?",
              )
              .get(server.collaborationServerId)?.value,
          ).toBe(1);
          expect(
            reader
              .prepare("SELECT signed_artifact_type AS value FROM server_signature_reservations")
              .get()?.value,
          ).toBe(SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE);
        } finally {
          reader.close();
        }
        destroyEnvelope(result.prepared.privateKeyEnvelope);
        database.close();
        database = openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        });
        const reopenedInventory = database.serverSigning.readInventory(
          server.collaborationServerId,
        );
        try {
          expect(reopenedInventory.signingLeases).toMatchObject([
            { state: "superseded", fencingToken: 2 },
            { state: "current", fencingToken: 3 },
          ]);
        } finally {
          for (const storedEnvelope of reopenedInventory.privateKeyEnvelopes) {
            destroyEnvelope(storedEnvelope);
          }
        }
        const pristineDatabasePath = `${database.databasePath}.pristine`;
        database.close();
        copyFileSync(database.databasePath, pristineDatabasePath);
        const acceptanceCorruption = new DatabaseSync(database.databasePath);
        try {
          const triggerSql = acceptanceCorruption
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'server_signed_record_acceptances_no_update'",
            )
            .get()?.sql;
          if (typeof triggerSql !== "string") throw new Error("acceptance trigger SQL is absent");
          acceptanceCorruption.exec("BEGIN IMMEDIATE");
          acceptanceCorruption.exec("DROP TRIGGER server_signed_record_acceptances_no_update");
          acceptanceCorruption
            .prepare("UPDATE server_signed_record_acceptances SET historical_reattestation_id = ?")
            .run("future-reattestation-is-forbidden");
          acceptanceCorruption.exec(triggerSql);
          acceptanceCorruption.exec("COMMIT");
        } finally {
          acceptanceCorruption.close();
        }
        expect(() =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
        ).toThrow();
        copyFileSync(boundDatabasePath, database.databasePath);
        const boundCorruption = new DatabaseSync(database.databasePath);
        try {
          const triggerSql = boundCorruption
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'server_signature_reservations_lifecycle_monotonic'",
            )
            .get()?.sql;
          if (typeof triggerSql !== "string")
            throw new Error("reservation lifecycle SQL is absent");
          boundCorruption.exec("BEGIN IMMEDIATE");
          boundCorruption.exec("DROP TRIGGER server_signature_reservations_lifecycle_monotonic");
          boundCorruption
            .prepare("UPDATE server_signature_reservations SET bound_at_ms = ?")
            .run(NOW_MS + 600_000);
          boundCorruption.exec(triggerSql);
          boundCorruption.exec("COMMIT");
        } finally {
          boundCorruption.close();
        }
        expect(() =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
        ).toThrow();
        copyFileSync(pristineDatabasePath, database.databasePath);
        const corruption = new DatabaseSync(database.databasePath);
        try {
          corruption
            .prepare(
              `UPDATE server_signing_leases
               SET state = 'closed', closed_at_ms = ?
               WHERE fencing_token = 3 AND state = 'current'`,
            )
            .run(NOW_MS + 600_002);
        } finally {
          corruption.close();
        }
        expect(() =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
        ).toThrow();
      } finally {
        signatureBytes.fill(0);
        signatureSnapshot.destroy();
        canonicalPayloadSnapshot.destroy();
        canonicalPayloadBytes.fill(0);
        intentSnapshot.destroy();
        intentBytes.fill(0);
      }
    } finally {
      if (retainedEnvelope !== undefined) destroyEnvelope(retainedEnvelope);
      signer.close();
      rootSecret.fill(0);
      database.close();
    }
  });

  it("runs the dormant custody-to-finalization orchestrator end to end", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const state = temporaryState();
    let database = openHostStateDatabase({
      machineIdentityId: MACHINE_IDENTITY_ID,
      pathEnvironment: state.environment,
    });
    const rootSecret = new Uint8Array(32).fill(23);
    const custody = createServerKeyCustodySigner(rootSecret);
    try {
      const server = database.records.ensureDefaultCollaborationServer().server;
      const coordinator = database.records.acquireCoordinatorLease({
        collaborationServerId: server.collaborationServerId,
        candidateLeaseId: coordinatorId(24),
        ownerInstanceId: parseA1SafeId("server-signer-orchestrator-owner"),
        expectedCurrentLeaseId: null,
        expectedCoordinatorEpoch: 0,
        leaseDurationMs: 600_000,
      });
      const resumed = resumeInitialServerSigner({
        database,
        reopenDatabase: () =>
          openHostStateDatabase({
            machineIdentityId: MACHINE_IDENTITY_ID,
            pathEnvironment: state.environment,
          }),
        custody,
        machineIdentityId: MACHINE_IDENTITY_ID,
        collaborationServerId: server.collaborationServerId,
        coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
        coordinatorEpoch: coordinator.lease.coordinatorEpoch,
        bootstrapSigningLeaseId: parseA1SafeId("orchestrated-bootstrap-lease"),
        signingLeaseId: parseA1SafeId("orchestrated-signing-lease"),
        signingKeyRef: protectedHandleId(25),
        scopeCertificateId: parseA1SafeId("orchestrated-scope-certificate"),
        preparedAtMs: NOW_MS,
        issuedAtMs: NOW_MS,
        expectedServerSignatureSeq: 0,
        expectedFencingToken: 0,
      });
      database = resumed.database as typeof database;
      expect(resumed).toMatchObject({
        signerWritable: true,
        nonWritableReason: null,
        resumedDurableBootstrap: false,
        reconciledUnknownCommitCount: 0,
        finalization: {
          replayed: true,
          bootstrapLease: { state: "closed" },
          signingLease: { state: "current", fencingToken: 2 },
          acceptance: { acceptedAtJournalSeq: 0 },
        },
      });
      database.records.releaseCoordinatorLease({
        fence: {
          collaborationServerId: server.collaborationServerId,
          coordinatorLeaseId: coordinator.lease.coordinatorLeaseId,
          coordinatorEpoch: coordinator.lease.coordinatorEpoch,
        },
      });
      database.close();
      const releasedReopen = openHostStateDatabase({
        machineIdentityId: MACHINE_IDENTITY_ID,
        pathEnvironment: state.environment,
      });
      const releasedInventory = releasedReopen.serverSigning.readInventory(
        server.collaborationServerId,
      );
      try {
        expect(releasedInventory.signingLeases).toMatchObject([
          { state: "superseded", fencingToken: 2 },
        ]);
      } finally {
        for (const storedEnvelope of releasedInventory.privateKeyEnvelopes) {
          destroyEnvelope(storedEnvelope);
        }
        releasedReopen.close();
      }
      const corruption = new DatabaseSync(database.databasePath);
      try {
        const triggerSql = corruption
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'server_signature_reservations_require_current_authority'",
          )
          .get()?.sql;
        if (typeof triggerSql !== "string") throw new Error("reservation trigger SQL is absent");
        corruption.exec("BEGIN IMMEDIATE");
        corruption.exec("DROP TRIGGER server_signature_reservations_require_current_authority");
        corruption
          .prepare(
            `INSERT INTO server_signature_reservations (
               collaboration_server_id, signer_sequence, signing_lease_id,
               signing_lease_kind, purpose, canonical_payload_schema_id,
               canonical_payload_ref, canonical_payload_digest, signed_record_digest,
               signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
               bound_at_ms, signed_at_ms, aborted_at_ms, state
             ) VALUES (?, 1, ?, 'bootstrap', 'scope_certificate', NULL, NULL, NULL,
                       NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, 'reserved')`,
          )
          .run(server.collaborationServerId, "orchestrated-bootstrap-lease", NOW_MS);
        corruption.exec(triggerSql);
        corruption.exec("COMMIT");
      } finally {
        corruption.close();
      }
      expect(() =>
        openHostStateDatabase({
          machineIdentityId: MACHINE_IDENTITY_ID,
          pathEnvironment: state.environment,
        }),
      ).toThrow();
    } finally {
      custody.close();
      rootSecret.fill(0);
      database.close();
    }
  });
});
