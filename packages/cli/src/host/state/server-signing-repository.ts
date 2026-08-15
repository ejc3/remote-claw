import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  canonicalServerScopeCertificatePayload,
  parseServerScopeCertificateCanonicalPayloadInput,
  parseServerScopeCertificateRecord,
  SERVER_SCOPE_CERTIFICATE_SIGNED_DOMAIN,
  type ServerScopeCertificateCanonicalPayloadInput,
  type ServerScopeCertificateRecord,
} from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type Ed25519PublicKey,
  HostStateContractError,
  type ProtectedHandleId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseMachineIdentityId,
} from "./ids.js";
import { ProtectedByteSnapshot } from "./protected.js";
import {
  type CollaborationServerRecord,
  type CoordinatorLeaseFence,
  type CoordinatorLeaseRecord,
  parseCollaborationServerRecord,
  parseCoordinatorLeaseFence,
  parseCoordinatorLeaseRecord,
} from "./records.js";
import type {
  HostStateRepositorySqlTransaction,
  HostStateRepositorySqlValue,
  HostStateRepositoryTransactionExecutor,
} from "./repository.js";
import {
  deriveServerIdentityKeyId,
  encodeServerSignerBootstrapIntentV1,
  parseServerBootstrapSigningLeaseRecord,
  parseServerIdentityKeyRecord,
  parseServerIdentityPrivateKeyEnvelopeRecord,
  parseServerScopeCertificateStatusRecord,
  parseServerSignatureReservationRecord,
  parseServerSignedRecordAcceptanceRecord,
  parseServerSignerBootstrapIntentV1,
  parseServerSigningLeaseRecord,
  SERVER_KEY_WRAP_SCHEMA_ID,
  SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
  SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
  type ServerBootstrapSigningLeaseRecord,
  type ServerIdentityKeyRecord,
  type ServerIdentityPrivateKeyEnvelopeRecord,
  type ServerScopeCertificateStatusRecord,
  type ServerSignatureReservationRecord,
  type ServerSignedRecordAcceptanceRecord,
  type ServerSignerBootstrapIntentV1,
  type ServerSigningInventory,
  type ServerSigningLeaseRecord,
  serverSignerBootstrapIntentDigest,
} from "./server-signing.js";
import {
  frozen,
  parseExactRecord,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
  type UnknownRecord,
} from "./validation.js";

export const SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE = "server_scope_certificate" as const;

export interface ServerIdentityKeyMaterialInput {
  readonly identityKeyId: A1SafeId;
  readonly publicKey: Ed25519PublicKey;
  readonly signingKeyRef: ProtectedHandleId;
  readonly wrappingSchemaId: typeof SERVER_KEY_WRAP_SCHEMA_ID;
  readonly wrapNonce: ProtectedByteSnapshot;
  readonly wrappedPkcs8: ProtectedByteSnapshot;
  readonly authTag: ProtectedByteSnapshot;
  readonly pkcs8Digest: A1Digest;
}

export interface PrepareInitialServerSignerRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly bootstrapIntent: ServerSignerBootstrapIntentV1;
  readonly bootstrapSigningLeaseId: A1SafeId;
  readonly operatorIntentEvidenceRef: ProtectedHandleId;
  readonly operatorIntentEvidenceDigest: A1Digest;
  readonly proposedScopeCertificateId: A1SafeId;
  readonly expectedServerSignatureSeq: number;
  readonly expectedFencingToken: number;
  readonly key: ServerIdentityKeyMaterialInput;
}

export interface PrepareInitialServerSignerResult {
  readonly identityKey: ServerIdentityKeyRecord;
  readonly privateKeyEnvelope: ServerIdentityPrivateKeyEnvelopeRecord;
  readonly bootstrapLease: ServerBootstrapSigningLeaseRecord;
  readonly reservation: ServerSignatureReservationRecord;
  readonly replayed: boolean;
}

export interface BindInitialServerScopeCertificateRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly bootstrapSigningLeaseId: A1SafeId;
  readonly fencingToken: number;
  readonly signerSequence: number;
  readonly canonicalPayloadRef: ProtectedHandleId;
  readonly certificatePayload: ServerScopeCertificateCanonicalPayloadInput;
}

export interface ServerSignatureMutationResult {
  readonly bootstrapLease: ServerBootstrapSigningLeaseRecord;
  readonly reservation: ServerSignatureReservationRecord;
  readonly replayed: boolean;
}

export interface StoreInitialServerScopeCertificateRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly bootstrapSigningLeaseId: A1SafeId;
  readonly fencingToken: number;
  readonly certificate: ServerScopeCertificateRecord;
}

export interface FinalizeInitialServerSignerRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly bootstrapSigningLeaseId: A1SafeId;
  readonly fencingToken: number;
  readonly signingLeaseId: A1SafeId;
  readonly certificate: ServerScopeCertificateRecord;
}

export interface FinalizeInitialServerSignerResult {
  readonly certificate: ServerScopeCertificateRecord;
  readonly identityKey: ServerIdentityKeyRecord;
  readonly certificateStatus: ServerScopeCertificateStatusRecord;
  readonly bootstrapLease: ServerBootstrapSigningLeaseRecord;
  readonly signingLease: ServerSigningLeaseRecord;
  readonly reservation: ServerSignatureReservationRecord;
  readonly acceptance: ServerSignedRecordAcceptanceRecord;
  readonly replayed: boolean;
}

export interface AcquireCurrentServerSigningLeaseRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly signingLeaseId: A1SafeId;
  readonly expectedCurrentSigningLeaseId: A1SafeId;
  readonly expectedFencingToken: number;
}

export interface AcquireCurrentServerSigningLeaseResult {
  readonly signingLease: ServerSigningLeaseRecord;
  readonly predecessor: ServerSigningLeaseRecord;
  readonly replayed: boolean;
}

/** Exact phase bundle retained by the caller across an unknown-commit restart. */
export interface ReconcileInitialServerSignerRequest {
  readonly prepare: PrepareInitialServerSignerRequest;
  readonly bind: BindInitialServerScopeCertificateRequest | null;
  readonly store: StoreInitialServerScopeCertificateRequest | null;
  readonly finalize: FinalizeInitialServerSignerRequest | null;
}

export interface ServerSignerBootstrapReconciliation {
  readonly attemptedPhase: "prepare" | "bind" | "store" | "finalize";
  readonly durablePhase: "prepare" | "bind" | "store" | "finalize";
  readonly landed: boolean;
  readonly authorityCurrent: boolean;
  readonly writable: boolean;
  readonly nonWritableReason:
    | "stale_bootstrap_fence"
    | "stale_signing_lease_fence"
    | "destroyed_key_custody"
    | "custody_unverified"
    | "unusable_key_custody"
    | null;
  readonly identityKey: ServerIdentityKeyRecord;
  readonly privateKeyEnvelope: ServerIdentityPrivateKeyEnvelopeRecord;
  readonly bootstrapLease: ServerBootstrapSigningLeaseRecord;
  readonly reservation: ServerSignatureReservationRecord;
  readonly certificate: ServerScopeCertificateRecord | null;
  readonly certificateStatus: ServerScopeCertificateStatusRecord | null;
  readonly signingLease: ServerSigningLeaseRecord | null;
  readonly acceptance: ServerSignedRecordAcceptanceRecord | null;
}

export interface ServerSigningRepositoryOperations {
  prepareInitialBootstrap(
    request: PrepareInitialServerSignerRequest,
  ): PrepareInitialServerSignerResult;
  bindInitialScopeCertificate(
    request: BindInitialServerScopeCertificateRequest,
  ): ServerSignatureMutationResult;
  storeInitialSignedScopeCertificate(
    request: StoreInitialServerScopeCertificateRequest,
  ): ServerSignatureMutationResult;
  finalizeInitialBootstrap(
    request: FinalizeInitialServerSignerRequest,
  ): FinalizeInitialServerSignerResult;
  reconcileInitialBootstrap(
    request: ReconcileInitialServerSignerRequest,
  ): ServerSignerBootstrapReconciliation | null;
  acquireCurrentSigningLease(
    request: AcquireCurrentServerSigningLeaseRequest,
  ): AcquireCurrentServerSigningLeaseResult;
  readInventory(collaborationServerId: CollaborationServerId): ServerSigningInventory;
}

export class ServerSigningRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`server signing repository conflict: ${message}`);
    this.name = "ServerSigningRepositoryConflictError";
  }
}

export class ServerSigningStaleCoordinatorError extends Error {
  constructor() {
    super("server signing repository stale coordinator: coordinator fence is not current");
    this.name = "ServerSigningStaleCoordinatorError";
  }
}

export class ServerSigningRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`server signing repository persistence failed: ${message}`, options);
    this.name = "ServerSigningRepositoryPersistenceError";
  }
}

function parseKeyMaterial(value: unknown): ServerIdentityKeyMaterialInput {
  const row = parseExactRecord(
    value,
    [
      "identityKeyId",
      "publicKey",
      "signingKeyRef",
      "wrappingSchemaId",
      "wrapNonce",
      "wrappedPkcs8",
      "authTag",
      "pkcs8Digest",
    ] as const,
    "serverIdentityKeyMaterial",
  );
  if (!(row.wrapNonce instanceof ProtectedByteSnapshot) || row.wrapNonce.byteLength !== 12) {
    throw new HostStateContractError("serverIdentityKeyMaterial.wrapNonce must contain 12 bytes");
  }
  if (
    !(row.wrappedPkcs8 instanceof ProtectedByteSnapshot) ||
    row.wrappedPkcs8.byteLength < 1 ||
    row.wrappedPkcs8.byteLength > 1_024
  ) {
    throw new HostStateContractError(
      "serverIdentityKeyMaterial.wrappedPkcs8 must contain 1-1024 bytes",
    );
  }
  if (!(row.authTag instanceof ProtectedByteSnapshot) || row.authTag.byteLength !== 16) {
    throw new HostStateContractError("serverIdentityKeyMaterial.authTag must contain 16 bytes");
  }
  if (row.wrappingSchemaId !== SERVER_KEY_WRAP_SCHEMA_ID) {
    throw new HostStateContractError("serverIdentityKeyMaterial.wrappingSchemaId is unsupported");
  }
  return frozen({
    identityKeyId: parseA1SafeId(row.identityKeyId, "serverIdentityKeyMaterial.identityKeyId"),
    publicKey: parseEd25519PublicKey(row.publicKey, "serverIdentityKeyMaterial.publicKey"),
    signingKeyRef: parseA1CanonicalId(
      "protectedHandle",
      row.signingKeyRef,
      "serverIdentityKeyMaterial.signingKeyRef",
    ),
    wrappingSchemaId: SERVER_KEY_WRAP_SCHEMA_ID,
    wrapNonce: row.wrapNonce,
    wrappedPkcs8: row.wrappedPkcs8,
    authTag: row.authTag,
    pkcs8Digest: parseA1Digest(row.pkcs8Digest, "serverIdentityKeyMaterial.pkcs8Digest"),
  });
}

function parsePrepareRequest(value: unknown): PrepareInitialServerSignerRequest {
  const row = parseExactRecord(
    value,
    [
      "fence",
      "bootstrapIntent",
      "bootstrapSigningLeaseId",
      "operatorIntentEvidenceRef",
      "operatorIntentEvidenceDigest",
      "proposedScopeCertificateId",
      "expectedServerSignatureSeq",
      "expectedFencingToken",
      "key",
    ] as const,
    "prepareInitialServerSigner",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    bootstrapIntent: parseServerSignerBootstrapIntentV1(row.bootstrapIntent),
    bootstrapSigningLeaseId: parseA1SafeId(
      row.bootstrapSigningLeaseId,
      "prepareInitialServerSigner.bootstrapSigningLeaseId",
    ),
    operatorIntentEvidenceRef: parseA1CanonicalId(
      "protectedHandle",
      row.operatorIntentEvidenceRef,
      "prepareInitialServerSigner.operatorIntentEvidenceRef",
    ),
    operatorIntentEvidenceDigest: parseA1Digest(
      row.operatorIntentEvidenceDigest,
      "prepareInitialServerSigner.operatorIntentEvidenceDigest",
    ),
    proposedScopeCertificateId: parseA1SafeId(
      row.proposedScopeCertificateId,
      "prepareInitialServerSigner.proposedScopeCertificateId",
    ),
    expectedServerSignatureSeq: parseNonNegativeSafeInteger(
      row.expectedServerSignatureSeq,
      "prepareInitialServerSigner.expectedServerSignatureSeq",
    ),
    expectedFencingToken: parseNonNegativeSafeInteger(
      row.expectedFencingToken,
      "prepareInitialServerSigner.expectedFencingToken",
    ),
    key: parseKeyMaterial(row.key),
  });
}

function parseBootstrapMutationScope(
  row: UnknownRecord,
  field: string,
): Readonly<{
  fence: CoordinatorLeaseFence;
  bootstrapSigningLeaseId: A1SafeId;
  fencingToken: number;
}> {
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    bootstrapSigningLeaseId: parseA1SafeId(
      row.bootstrapSigningLeaseId,
      `${field}.bootstrapSigningLeaseId`,
    ),
    fencingToken: parsePositiveSafeInteger(row.fencingToken, `${field}.fencingToken`),
  });
}

function parseBindRequest(value: unknown): BindInitialServerScopeCertificateRequest {
  const row = parseExactRecord(
    value,
    [
      "fence",
      "bootstrapSigningLeaseId",
      "fencingToken",
      "signerSequence",
      "canonicalPayloadRef",
      "certificatePayload",
    ] as const,
    "bindInitialServerScopeCertificate",
  );
  return frozen({
    ...parseBootstrapMutationScope(row, "bindInitialServerScopeCertificate"),
    signerSequence: parseNonNegativeSafeInteger(
      row.signerSequence,
      "bindInitialServerScopeCertificate.signerSequence",
    ),
    canonicalPayloadRef: parseA1CanonicalId(
      "protectedHandle",
      row.canonicalPayloadRef,
      "bindInitialServerScopeCertificate.canonicalPayloadRef",
    ),
    certificatePayload: parseServerScopeCertificateCanonicalPayloadInput(row.certificatePayload),
  });
}

function parseStoreRequest(value: unknown): StoreInitialServerScopeCertificateRequest {
  const row = parseExactRecord(
    value,
    ["fence", "bootstrapSigningLeaseId", "fencingToken", "certificate"] as const,
    "storeInitialServerScopeCertificate",
  );
  return frozen({
    ...parseBootstrapMutationScope(row, "storeInitialServerScopeCertificate"),
    certificate: parseServerScopeCertificateRecord(row.certificate),
  });
}

function parseFinalizeRequest(value: unknown): FinalizeInitialServerSignerRequest {
  const row = parseExactRecord(
    value,
    ["fence", "bootstrapSigningLeaseId", "fencingToken", "signingLeaseId", "certificate"] as const,
    "finalizeInitialServerSigner",
  );
  return frozen({
    ...parseBootstrapMutationScope(row, "finalizeInitialServerSigner"),
    signingLeaseId: parseA1SafeId(row.signingLeaseId, "finalizeInitialServerSigner.signingLeaseId"),
    certificate: parseServerScopeCertificateRecord(row.certificate),
  });
}

function sameFence(left: CoordinatorLeaseFence, right: CoordinatorLeaseFence): boolean {
  return (
    left.collaborationServerId === right.collaborationServerId &&
    left.coordinatorLeaseId === right.coordinatorLeaseId &&
    left.coordinatorEpoch === right.coordinatorEpoch
  );
}

function parseReconcileRequest(value: unknown): ReconcileInitialServerSignerRequest {
  const row = parseExactRecord(
    value,
    ["prepare", "bind", "store", "finalize"] as const,
    "reconcileInitialServerSigner",
  );
  const prepare = parsePrepareRequest(row.prepare);
  const bind = row.bind === null ? null : parseBindRequest(row.bind);
  const store = row.store === null ? null : parseStoreRequest(row.store);
  const finalize = row.finalize === null ? null : parseFinalizeRequest(row.finalize);
  if (
    (store !== null && bind === null) ||
    (finalize !== null && store === null) ||
    (bind !== null &&
      (!sameFence(bind.fence, prepare.fence) ||
        bind.bootstrapSigningLeaseId !== prepare.bootstrapSigningLeaseId ||
        bind.fencingToken !== prepare.expectedFencingToken + 1 ||
        bind.signerSequence !== prepare.expectedServerSignatureSeq)) ||
    (store !== null &&
      (!sameFence(store.fence, prepare.fence) ||
        store.bootstrapSigningLeaseId !== prepare.bootstrapSigningLeaseId ||
        store.fencingToken !== prepare.expectedFencingToken + 1 ||
        store.certificate.signerSequence !== prepare.expectedServerSignatureSeq)) ||
    (finalize !== null &&
      (!sameFence(finalize.fence, prepare.fence) ||
        finalize.bootstrapSigningLeaseId !== prepare.bootstrapSigningLeaseId ||
        finalize.fencingToken !== prepare.expectedFencingToken + 1)) ||
    (bind !== null &&
      store !== null &&
      JSON.stringify(bind.certificatePayload) !==
        JSON.stringify(certificatePayload(store.certificate))) ||
    (store !== null &&
      finalize !== null &&
      JSON.stringify(store.certificate) !== JSON.stringify(finalize.certificate))
  ) {
    throw new HostStateContractError(
      "reconcileInitialServerSigner phases must describe one exact bootstrap operation",
    );
  }
  return frozen({ prepare, bind, store, finalize });
}

function parseAcquireRequest(value: unknown): AcquireCurrentServerSigningLeaseRequest {
  const row = parseExactRecord(
    value,
    ["fence", "signingLeaseId", "expectedCurrentSigningLeaseId", "expectedFencingToken"] as const,
    "acquireCurrentServerSigningLease",
  );
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    signingLeaseId: parseA1SafeId(
      row.signingLeaseId,
      "acquireCurrentServerSigningLease.signingLeaseId",
    ),
    expectedCurrentSigningLeaseId: parseA1SafeId(
      row.expectedCurrentSigningLeaseId,
      "acquireCurrentServerSigningLease.expectedCurrentSigningLeaseId",
    ),
    expectedFencingToken: parsePositiveSafeInteger(
      row.expectedFencingToken,
      "acquireCurrentServerSigningLease.expectedFencingToken",
    ),
  });
}

function trustedNow(nowMs: () => number): number {
  return parseNonNegativeSafeInteger(nowMs(), "serverSigningRepository.nowMs");
}

function sqlGet(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): unknown {
  try {
    return transaction.get(sql, parameters);
  } catch (error) {
    if (
      error instanceof ServerSigningRepositoryConflictError ||
      error instanceof ServerSigningStaleCoordinatorError ||
      error instanceof ServerSigningRepositoryPersistenceError ||
      error instanceof HostStateContractError
    ) {
      throw error;
    }
    throw new ServerSigningRepositoryPersistenceError("read operation did not complete", {
      cause: error,
    });
  }
}

function finalizeInitialBootstrapOperation(
  executor: HostStateRepositoryTransactionExecutor,
  nowMs: () => number,
  request: FinalizeInitialServerSignerRequest,
): FinalizeInitialServerSignerResult {
  const parsed = parseFinalizeRequest(request);
  return executor.transaction((transaction) => {
    const current = assertCurrentCoordinator(transaction, parsed.fence, nowMs);
    const lease = findBootstrap(
      transaction,
      parsed.fence.collaborationServerId,
      parsed.bootstrapSigningLeaseId,
    );
    if (
      lease === null ||
      lease.coordinatorLeaseId !== parsed.fence.coordinatorLeaseId ||
      lease.coordinatorEpoch !== parsed.fence.coordinatorEpoch ||
      lease.fencingToken !== parsed.fencingToken ||
      lease.purpose !== "initial_pair"
    ) {
      throw new ServerSigningRepositoryConflictError(
        "bootstrap finalization lease fence does not match",
      );
    }
    const key = findIdentityKey(
      transaction,
      parsed.fence.collaborationServerId,
      lease.proposedIdentityKeyId,
    );
    const envelope = findEnvelopeMetadata(transaction, lease.signingKeyRef);
    const reservation = findReservation(
      transaction,
      parsed.fence.collaborationServerId,
      parsed.certificate.signerSequence,
    );
    if (key === null || envelope === null || reservation === null) {
      throw new ServerSigningRepositoryPersistenceError(
        "bootstrap finalization has incomplete key or signature evidence",
      );
    }
    const payload = certificatePayload(parsed.certificate);
    assertInitialCertificateCoordinates(
      current.server,
      lease,
      key,
      payload,
      reservation.signerSequence,
    );
    if (
      reservation.boundAtMs === null ||
      payload.issuedAtMs > reservation.boundAtMs ||
      payload.issuedAtMs > current.nowMs
    ) {
      throw new ServerSigningRepositoryConflictError(
        "signed certificate issue time is outside its bound bootstrap window",
      );
    }
    assertCertificateSignature(parsed.certificate, key);
    const signedRecordDigest = signedCertificateDigest(parsed.certificate);
    if (
      reservation.state !== "signed" ||
      reservation.signingLeaseId !== parsed.bootstrapSigningLeaseId ||
      reservation.signingLeaseKind !== "bootstrap" ||
      reservation.purpose !== "scope_certificate" ||
      reservation.canonicalPayloadDigest === null ||
      !sameDigest(reservation.canonicalPayloadDigest, parsed.certificate.canonicalPayloadDigest) ||
      reservation.signedRecordDigest === null ||
      !sameDigest(reservation.signedRecordDigest, signedRecordDigest) ||
      reservation.signature !== parsed.certificate.signature ||
      reservation.signedArtifactType !== SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE ||
      reservation.signedArtifactId !== parsed.certificate.scopeCertificateId
    ) {
      throw new ServerSigningRepositoryConflictError(
        "bootstrap finalization does not match the signed reservation",
      );
    }
    const existingCertificate = findCertificate(
      transaction,
      parsed.fence.collaborationServerId,
      parseA1SafeId(parsed.certificate.scopeCertificateId),
    );
    if (existingCertificate === null) {
      throw new ServerSigningRepositoryPersistenceError(
        "signed bootstrap is missing its immutable scope certificate",
      );
    }
    assertSameCertificate(existingCertificate, parsed.certificate, "signed bootstrap");
    if (lease.state === "closed") {
      const status = findStatus(
        transaction,
        parsed.fence.collaborationServerId,
        parseA1SafeId(parsed.certificate.scopeCertificateId),
      );
      const signingLease = findSigningLease(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.signingLeaseId,
      );
      const acceptance = findAcceptanceBySignerSequence(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.certificate.signerSequence,
      );
      const installedKey = findIdentityKey(
        transaction,
        parsed.fence.collaborationServerId,
        lease.proposedIdentityKeyId,
      );
      if (
        status === null ||
        status.state !== "current" ||
        signingLease === null ||
        acceptance === null ||
        installedKey === null ||
        signingLease.identityKeyId !== lease.proposedIdentityKeyId ||
        signingLease.scopeCertificateId !== lease.proposedScopeCertificateId ||
        signingLease.coordinatorLeaseId !== parsed.fence.coordinatorLeaseId ||
        signingLease.coordinatorEpoch !== parsed.fence.coordinatorEpoch ||
        !sameDigest(acceptance.signedRecordDigest, signedRecordDigest) ||
        current.server.currentIdentityKeyId !== lease.proposedIdentityKeyId ||
        current.server.currentScopeCertificateId !== lease.proposedScopeCertificateId ||
        current.server.currentKeyGeneration !== lease.proposedKeyGeneration ||
        current.server.state !== "current"
      ) {
        throw new ServerSigningRepositoryPersistenceError(
          "installed bootstrap graph is inconsistent",
        );
      }
      return frozen({
        certificate: existingCertificate,
        identityKey: installedKey,
        certificateStatus: status,
        bootstrapLease: lease,
        signingLease,
        reservation,
        acceptance,
        replayed: true,
      });
    }
    if (
      lease.state !== "signed" ||
      key.state !== "proposed" ||
      key.introducedByScopeCertificateId !== null ||
      envelope.state !== "current" ||
      envelope.destroyedAtMs !== null ||
      envelope.collaborationServerId !== parsed.fence.collaborationServerId ||
      envelope.identityKeyId !== key.identityKeyId ||
      envelope.keyGeneration !== key.keyGeneration ||
      current.server.state !== "installing" ||
      current.server.currentKeyGeneration !== 0 ||
      current.server.currentIdentityKeyId !== null ||
      current.server.currentScopeCertificateId !== null
    ) {
      throw new ServerSigningRepositoryConflictError("bootstrap graph is not installable");
    }
    if (
      findSigningLease(transaction, parsed.fence.collaborationServerId, parsed.signingLeaseId) !==
        null ||
      sqlGet(
        transaction,
        `SELECT signing_lease_id FROM server_signing_leases
           WHERE collaboration_server_id = ? AND state IN ('current', 'draining') LIMIT 1`,
        [parsed.fence.collaborationServerId],
      ) !== undefined
    ) {
      throw new ServerSigningRepositoryConflictError(
        "normal signing-lease ID or current slot is occupied",
      );
    }
    const acceptancePositionRow = sqlGet(
      transaction,
      `SELECT COUNT(*) AS acceptance_count,
                MAX(accepted_at_journal_seq) AS max_acceptance_seq
         FROM server_signed_record_acceptances WHERE collaboration_server_id = ?`,
      [parsed.fence.collaborationServerId],
    );
    const acceptancePosition = record(
      acceptancePositionRow,
      ["acceptance_count", "max_acceptance_seq"],
      "serverSigningAcceptancePosition",
    );
    const acceptanceCount = parseNonNegativeSafeInteger(
      acceptancePosition.acceptance_count,
      "serverSigningAcceptancePosition.acceptanceCount",
    );
    if (
      (acceptanceCount === 0 && acceptancePosition.max_acceptance_seq !== null) ||
      (acceptanceCount > 0 && acceptancePosition.max_acceptance_seq !== acceptanceCount - 1)
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "signed-record acceptance journal is not dense",
      );
    }
    runExactlyOne(
      transaction,
      `UPDATE server_identity_keys
         SET introduced_by_scope_certificate_id = ?, state = 'current'
         WHERE collaboration_server_id = ? AND identity_key_id = ?
           AND key_generation = 1 AND state = 'proposed'
           AND introduced_by_scope_certificate_id IS NULL`,
      [
        parsed.certificate.scopeCertificateId,
        parsed.fence.collaborationServerId,
        key.identityKeyId,
      ],
      "server identity-key activation",
    );
    const status = parseServerScopeCertificateStatusRecord({
      collaborationServerId: parsed.fence.collaborationServerId,
      scopeCertificateId: parsed.certificate.scopeCertificateId,
      state: "current",
      acceptSignaturesThroughSequence: null,
      changedAtMs: current.nowMs,
      changeEvidenceRef: lease.operatorIntentEvidenceRef,
      changeEvidenceDigest: lease.operatorIntentEvidenceDigest,
    });
    runExactlyOne(
      transaction,
      `INSERT INTO server_scope_certificate_statuses (
           collaboration_server_id, scope_certificate_id, state,
           accept_signatures_through_sequence, changed_at_ms,
           change_evidence_ref, change_evidence_digest
         ) VALUES (?, ?, 'current', NULL, ?, ?, ?)`,
      [
        status.collaborationServerId,
        status.scopeCertificateId,
        status.changedAtMs,
        status.changeEvidenceRef,
        status.changeEvidenceDigest,
      ],
      "server scope-certificate status insert",
    );
    const acceptance = parseServerSignedRecordAcceptanceRecord({
      collaborationServerId: parsed.fence.collaborationServerId,
      acceptedAtJournalSeq: acceptanceCount,
      signedRecordDigest,
      signerIdentityKeyId: key.identityKeyId,
      signerKeyGeneration: key.keyGeneration,
      signerScopeCertificateId: parsed.certificate.scopeCertificateId,
      signerSequence: parsed.certificate.signerSequence,
      acceptedAtMs: current.nowMs,
      historicalReattestationId: null,
    });
    runExactlyOne(
      transaction,
      `INSERT INTO server_signed_record_acceptances (
           collaboration_server_id, accepted_at_journal_seq, signed_record_digest,
           signer_identity_key_id, signer_key_generation, signer_scope_certificate_id,
           signer_sequence, accepted_at_ms, historical_reattestation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        acceptance.collaborationServerId,
        acceptance.acceptedAtJournalSeq,
        acceptance.signedRecordDigest,
        acceptance.signerIdentityKeyId,
        acceptance.signerKeyGeneration,
        acceptance.signerScopeCertificateId,
        acceptance.signerSequence,
        acceptance.acceptedAtMs,
      ],
      "server signed-record acceptance insert",
    );
    runExactlyOne(
      transaction,
      `UPDATE server_bootstrap_signing_leases
         SET installed_at_ms = ?, state = 'installed'
         WHERE collaboration_server_id = ? AND bootstrap_signing_lease_id = ?
           AND fencing_token = ? AND state = 'signed'`,
      [
        current.nowMs,
        parsed.fence.collaborationServerId,
        parsed.bootstrapSigningLeaseId,
        parsed.fencingToken,
      ],
      "bootstrap signing-lease installation",
    );
    runExactlyOne(
      transaction,
      `UPDATE collaboration_servers
         SET current_key_generation = 1, current_identity_key_id = ?,
             current_scope_certificate_id = ?, state = 'current'
         WHERE collaboration_server_id = ? AND current_key_generation = 0
           AND current_identity_key_id IS NULL AND current_scope_certificate_id IS NULL
           AND state = 'installing'`,
      [
        key.identityKeyId,
        parsed.certificate.scopeCertificateId,
        parsed.fence.collaborationServerId,
      ],
      "collaboration server signer activation",
    );
    const signingLease = parseServerSigningLeaseRecord({
      signingLeaseId: parsed.signingLeaseId,
      collaborationServerId: parsed.fence.collaborationServerId,
      identityKeyId: key.identityKeyId,
      keyGeneration: key.keyGeneration,
      scopeCertificateId: parsed.certificate.scopeCertificateId,
      coordinatorLeaseId: parsed.fence.coordinatorLeaseId,
      coordinatorEpoch: parsed.fence.coordinatorEpoch,
      fencingToken: nextFencingToken(lease.fencingToken),
      acquiredAtMs: current.nowMs,
      drainingAtMs: null,
      supersededAtMs: null,
      closedAtMs: null,
      state: "current",
    });
    runExactlyOne(
      transaction,
      `INSERT INTO server_signing_leases (
           signing_lease_id, collaboration_server_id, identity_key_id, key_generation,
           scope_certificate_id, coordinator_lease_id, coordinator_epoch, fencing_token,
           acquired_at_ms, draining_at_ms, superseded_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'current')`,
      [
        signingLease.signingLeaseId,
        signingLease.collaborationServerId,
        signingLease.identityKeyId,
        signingLease.keyGeneration,
        signingLease.scopeCertificateId,
        signingLease.coordinatorLeaseId,
        signingLease.coordinatorEpoch,
        signingLease.fencingToken,
        signingLease.acquiredAtMs,
      ],
      "current server signing-lease insert",
    );
    runExactlyOne(
      transaction,
      `UPDATE server_bootstrap_signing_leases
         SET closed_at_ms = ?, state = 'closed'
         WHERE collaboration_server_id = ? AND bootstrap_signing_lease_id = ?
           AND fencing_token = ? AND state = 'installed' AND installed_at_ms = ?`,
      [
        current.nowMs,
        parsed.fence.collaborationServerId,
        parsed.bootstrapSigningLeaseId,
        parsed.fencingToken,
        current.nowMs,
      ],
      "bootstrap signing-lease close",
    );
    const installedKey = parseServerIdentityKeyRecord({
      ...key,
      introducedByScopeCertificateId: parsed.certificate.scopeCertificateId,
      state: "current",
    });
    const closedBootstrap = parseServerBootstrapSigningLeaseRecord({
      ...lease,
      installedAtMs: current.nowMs,
      closedAtMs: current.nowMs,
      state: "closed",
    });
    return frozen({
      certificate: parsed.certificate,
      identityKey: installedKey,
      certificateStatus: status,
      bootstrapLease: closedBootstrap,
      signingLease,
      reservation,
      acceptance,
      replayed: false,
    });
  });
}

function bindInitialScopeCertificateOperation(
  executor: HostStateRepositoryTransactionExecutor,
  nowMs: () => number,
  request: BindInitialServerScopeCertificateRequest,
): ServerSignatureMutationResult {
  const parsed = parseBindRequest(request);
  return executor.transaction((transaction) => {
    const current = assertCurrentCoordinator(transaction, parsed.fence, nowMs);
    const lease = findBootstrap(
      transaction,
      parsed.fence.collaborationServerId,
      parsed.bootstrapSigningLeaseId,
    );
    if (
      lease === null ||
      lease.coordinatorLeaseId !== parsed.fence.coordinatorLeaseId ||
      lease.coordinatorEpoch !== parsed.fence.coordinatorEpoch ||
      lease.fencingToken !== parsed.fencingToken ||
      lease.purpose !== "initial_pair"
    ) {
      throw new ServerSigningRepositoryConflictError(
        "bootstrap signing-lease fence does not match",
      );
    }
    const key = findIdentityKey(
      transaction,
      parsed.fence.collaborationServerId,
      lease.proposedIdentityKeyId,
    );
    const reservation = findReservation(
      transaction,
      parsed.fence.collaborationServerId,
      parsed.signerSequence,
    );
    if (key === null || reservation === null) {
      throw new ServerSigningRepositoryPersistenceError(
        "bootstrap lease has no key or signature reservation",
      );
    }
    assertInitialCertificateCoordinates(
      current.server,
      lease,
      key,
      parsed.certificatePayload,
      parsed.signerSequence,
    );
    if (parsed.certificatePayload.issuedAtMs > current.nowMs) {
      throw new ServerSigningRepositoryConflictError(
        "initial certificate issue time is later than the bind observation",
      );
    }
    if (
      reservation.signerSequence !== parsed.signerSequence ||
      reservation.signingLeaseId !== lease.bootstrapSigningLeaseId ||
      reservation.signingLeaseKind !== "bootstrap" ||
      reservation.purpose !== "scope_certificate"
    ) {
      throw new ServerSigningRepositoryConflictError(
        "bootstrap signature reservation does not match",
      );
    }
    const canonicalBytes = canonicalServerScopeCertificatePayload(parsed.certificatePayload);
    try {
      const canonicalPayloadDigest = digestBytes(canonicalBytes);
      assertCanonicalArtifact(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.canonicalPayloadRef,
        canonicalPayloadDigest,
        canonicalBytes,
      );
      if (reservation.state === "bound" || reservation.state === "signed") {
        if (
          reservation.canonicalPayloadSchemaId !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
          reservation.canonicalPayloadRef !== parsed.canonicalPayloadRef ||
          reservation.canonicalPayloadDigest === null ||
          !sameDigest(reservation.canonicalPayloadDigest, canonicalPayloadDigest) ||
          reservation.signedArtifactType !== SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE ||
          reservation.signedArtifactId !== parsed.certificatePayload.scopeCertificateId
        ) {
          throw new ServerSigningRepositoryConflictError(
            "bound scope-certificate payload collided",
          );
        }
        return frozen({ bootstrapLease: lease, reservation, replayed: true });
      }
      if (reservation.state !== "reserved" || lease.state !== "prepared") {
        throw new ServerSigningRepositoryConflictError("bootstrap reservation is not bindable");
      }
      runExactlyOne(
        transaction,
        `UPDATE server_signature_reservations
           SET canonical_payload_schema_id = ?, canonical_payload_ref = ?,
               canonical_payload_digest = ?, signed_artifact_type = ?,
               signed_artifact_id = ?, bound_at_ms = ?, state = 'bound'
           WHERE collaboration_server_id = ? AND signer_sequence = ?
             AND signing_lease_id = ? AND signing_lease_kind = 'bootstrap'
             AND purpose = 'scope_certificate' AND state = 'reserved'`,
        [
          SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
          parsed.canonicalPayloadRef,
          canonicalPayloadDigest,
          SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE,
          parsed.certificatePayload.scopeCertificateId,
          current.nowMs,
          parsed.fence.collaborationServerId,
          parsed.signerSequence,
          parsed.bootstrapSigningLeaseId,
        ],
        "bootstrap certificate payload bind",
      );
      const bound = parseServerSignatureReservationRecord({
        ...reservation,
        canonicalPayloadSchemaId: SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
        canonicalPayloadRef: parsed.canonicalPayloadRef,
        canonicalPayloadDigest,
        signedArtifactType: SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE,
        signedArtifactId: parsed.certificatePayload.scopeCertificateId,
        boundAtMs: current.nowMs,
        state: "bound",
      });
      return frozen({ bootstrapLease: lease, reservation: bound, replayed: false });
    } finally {
      canonicalBytes.fill(0);
    }
  });
}

function storeInitialSignedScopeCertificateOperation(
  executor: HostStateRepositoryTransactionExecutor,
  nowMs: () => number,
  request: StoreInitialServerScopeCertificateRequest,
): ServerSignatureMutationResult {
  const parsed = parseStoreRequest(request);
  return executor.transaction((transaction) => {
    const current = assertCurrentCoordinator(transaction, parsed.fence, nowMs);
    const lease = findBootstrap(
      transaction,
      parsed.fence.collaborationServerId,
      parsed.bootstrapSigningLeaseId,
    );
    if (
      lease === null ||
      lease.coordinatorLeaseId !== parsed.fence.coordinatorLeaseId ||
      lease.coordinatorEpoch !== parsed.fence.coordinatorEpoch ||
      lease.fencingToken !== parsed.fencingToken ||
      lease.purpose !== "initial_pair"
    ) {
      throw new ServerSigningRepositoryConflictError(
        "bootstrap signing-lease fence does not match",
      );
    }
    const key = findIdentityKey(
      transaction,
      parsed.fence.collaborationServerId,
      lease.proposedIdentityKeyId,
    );
    const reservation = findReservation(
      transaction,
      parsed.fence.collaborationServerId,
      parsed.certificate.signerSequence,
    );
    if (key === null || reservation === null) {
      throw new ServerSigningRepositoryPersistenceError(
        "bootstrap signed store has no key or reservation",
      );
    }
    const payload = certificatePayload(parsed.certificate);
    assertInitialCertificateCoordinates(
      current.server,
      lease,
      key,
      payload,
      reservation.signerSequence,
    );
    if (
      reservation.boundAtMs === null ||
      payload.issuedAtMs > reservation.boundAtMs ||
      payload.issuedAtMs > current.nowMs
    ) {
      throw new ServerSigningRepositoryConflictError(
        "stored certificate issue time is outside its bound bootstrap window",
      );
    }
    const payloadDigest = certificatePayloadDigest(payload);
    if (
      reservation.signingLeaseId !== lease.bootstrapSigningLeaseId ||
      reservation.signingLeaseKind !== "bootstrap" ||
      reservation.purpose !== "scope_certificate" ||
      reservation.canonicalPayloadSchemaId !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
      reservation.canonicalPayloadDigest === null ||
      !sameDigest(reservation.canonicalPayloadDigest, payloadDigest) ||
      !sameDigest(parsed.certificate.canonicalPayloadDigest, payloadDigest) ||
      reservation.signedArtifactType !== SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE ||
      reservation.signedArtifactId !== parsed.certificate.scopeCertificateId
    ) {
      throw new ServerSigningRepositoryConflictError(
        "signed certificate does not match the bound reservation",
      );
    }
    assertCertificateSignature(parsed.certificate, key);
    const signedRecordDigest = signedCertificateDigest(parsed.certificate);
    if (reservation.state === "signed") {
      const storedCertificate = findCertificate(
        transaction,
        parsed.fence.collaborationServerId,
        parseA1SafeId(parsed.certificate.scopeCertificateId),
      );
      if (
        storedCertificate === null ||
        reservation.signedRecordDigest === null ||
        !sameDigest(reservation.signedRecordDigest, signedRecordDigest) ||
        reservation.signature !== parsed.certificate.signature ||
        (lease.state !== "signed" && lease.state !== "closed")
      ) {
        throw new ServerSigningRepositoryConflictError("signed certificate facts collided");
      }
      assertSameCertificate(storedCertificate, parsed.certificate, "stored bootstrap");
      return frozen({ bootstrapLease: lease, reservation, replayed: true });
    }
    if (reservation.state !== "bound" || lease.state !== "prepared") {
      throw new ServerSigningRepositoryConflictError(
        "bootstrap reservation is not ready for signed storage",
      );
    }
    if (
      sqlGet(
        transaction,
        `SELECT signer_sequence FROM server_signature_reservations
           WHERE signed_record_digest = ? LIMIT 1`,
        [signedRecordDigest],
      ) !== undefined
    ) {
      throw new ServerSigningRepositoryConflictError("signed certificate digest is already stored");
    }
    runExactlyOne(
      transaction,
      `UPDATE server_signature_reservations
         SET signed_record_digest = ?, signature = ?, signed_at_ms = ?, state = 'signed'
         WHERE collaboration_server_id = ? AND signer_sequence = ?
           AND signing_lease_id = ? AND state = 'bound'`,
      [
        signedRecordDigest,
        parsed.certificate.signature,
        current.nowMs,
        parsed.fence.collaborationServerId,
        parsed.certificate.signerSequence,
        parsed.bootstrapSigningLeaseId,
      ],
      "bootstrap signed-certificate store",
    );
    insertScopeCertificate(transaction, parsed.certificate);
    runExactlyOne(
      transaction,
      `UPDATE server_bootstrap_signing_leases
         SET signed_at_ms = ?, state = 'signed'
         WHERE collaboration_server_id = ? AND bootstrap_signing_lease_id = ?
           AND fencing_token = ? AND state = 'prepared'`,
      [
        current.nowMs,
        parsed.fence.collaborationServerId,
        parsed.bootstrapSigningLeaseId,
        parsed.fencingToken,
      ],
      "bootstrap signing-lease signed transition",
    );
    const signedReservation = parseServerSignatureReservationRecord({
      ...reservation,
      signedRecordDigest,
      signature: parsed.certificate.signature,
      signedAtMs: current.nowMs,
      state: "signed",
    });
    const signedLease = parseServerBootstrapSigningLeaseRecord({
      ...lease,
      signedAtMs: current.nowMs,
      state: "signed",
    });
    return frozen({
      bootstrapLease: signedLease,
      reservation: signedReservation,
      replayed: false,
    });
  });
}

function sqlAll(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): readonly unknown[] {
  if (transaction.all === undefined) {
    throw new ServerSigningRepositoryPersistenceError("multi-row SQL reads are unavailable");
  }
  try {
    return transaction.all(sql, parameters);
  } catch (error) {
    if (error instanceof ServerSigningRepositoryPersistenceError) throw error;
    throw new ServerSigningRepositoryPersistenceError("multi-row read did not complete", {
      cause: error,
    });
  }
}

function sqlRun(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
): number {
  try {
    const changes = transaction.run(sql, parameters).changes;
    const numeric = typeof changes === "bigint" ? Number(changes) : changes;
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      throw new ServerSigningRepositoryPersistenceError("write returned an invalid change count");
    }
    return numeric;
  } catch (error) {
    if (
      error instanceof ServerSigningRepositoryConflictError ||
      error instanceof ServerSigningStaleCoordinatorError ||
      error instanceof ServerSigningRepositoryPersistenceError ||
      error instanceof HostStateContractError
    ) {
      throw error;
    }
    throw new ServerSigningRepositoryPersistenceError("write operation did not complete", {
      cause: error,
    });
  }
}

function runExactlyOne(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
  operation: string,
): void {
  if (sqlRun(transaction, sql, parameters) !== 1) {
    throw new ServerSigningRepositoryPersistenceError(`${operation} did not change one row`);
  }
}

function record(value: unknown, keys: readonly string[], field: string): UnknownRecord {
  try {
    return parseExactRecord(value, keys, field);
  } catch (error) {
    throw new ServerSigningRepositoryPersistenceError(`${field} row is invalid`, {
      cause: error,
    });
  }
}

const SERVER_ROW_KEYS = [
  "collaboration_server_id",
  "machine_identity_id",
  "current_key_generation",
  "current_identity_key_id",
  "current_scope_certificate_id",
  "current_coordinator_epoch",
  "current_coordinator_lease_id",
  "next_journal_offset",
  "next_server_signature_seq",
  "next_command_seq",
  "created_at_ms",
  "state",
] as const;

function serverFromRow(value: unknown): CollaborationServerRecord {
  const row = record(value, SERVER_ROW_KEYS, "collaborationServer");
  return parseServerPersistence("collaboration server", () =>
    parseCollaborationServerRecord({
      collaborationServerId: row.collaboration_server_id,
      machineIdentityId: row.machine_identity_id,
      currentKeyGeneration: row.current_key_generation,
      currentIdentityKeyId: row.current_identity_key_id,
      currentScopeCertificateId: row.current_scope_certificate_id,
      currentCoordinatorEpoch: row.current_coordinator_epoch,
      currentCoordinatorLeaseId: row.current_coordinator_lease_id,
      nextJournalOffset: row.next_journal_offset,
      nextServerSignatureSeq: row.next_server_signature_seq,
      nextCommandSeq: row.next_command_seq,
      createdAtMs: row.created_at_ms,
      state: row.state,
    }),
  );
}

const COORDINATOR_ROW_KEYS = [
  "coordinator_lease_id",
  "collaboration_server_id",
  "coordinator_epoch",
  "owner_instance_id",
  "acquired_at_ms",
  "heartbeat_deadline_ms",
  "released_at_ms",
  "state",
] as const;

function coordinatorFromRow(value: unknown): CoordinatorLeaseRecord {
  const row = record(value, COORDINATOR_ROW_KEYS, "coordinatorLease");
  return parseServerPersistence("coordinator lease", () =>
    parseCoordinatorLeaseRecord({
      coordinatorLeaseId: row.coordinator_lease_id,
      collaborationServerId: row.collaboration_server_id,
      coordinatorEpoch: row.coordinator_epoch,
      ownerInstanceId: row.owner_instance_id,
      acquiredAtMs: row.acquired_at_ms,
      heartbeatDeadlineMs: row.heartbeat_deadline_ms,
      releasedAtMs: row.released_at_ms,
      state: row.state,
    }),
  );
}

const IDENTITY_KEY_ROW_KEYS = [
  "collaboration_server_id",
  "identity_key_id",
  "key_generation",
  "algorithm",
  "public_key",
  "signing_key_ref",
  "introduced_by_scope_certificate_id",
  "trust_evidence_ref",
  "trust_evidence_digest",
  "valid_from_ms",
  "state",
] as const;

function identityKeyFromRow(value: unknown): ServerIdentityKeyRecord {
  const row = record(value, IDENTITY_KEY_ROW_KEYS, "serverIdentityKey");
  return parseServerPersistence("server identity key", () =>
    parseServerIdentityKeyRecord({
      collaborationServerId: row.collaboration_server_id,
      identityKeyId: row.identity_key_id,
      keyGeneration: row.key_generation,
      algorithm: row.algorithm,
      publicKey: row.public_key,
      signingKeyRef: row.signing_key_ref,
      introducedByScopeCertificateId: row.introduced_by_scope_certificate_id,
      trustEvidenceRef: row.trust_evidence_ref,
      trustEvidenceDigest: row.trust_evidence_digest,
      validFromMs: row.valid_from_ms,
      state: row.state,
    }),
  );
}

const ENVELOPE_ROW_KEYS = [
  "signing_key_ref",
  "collaboration_server_id",
  "identity_key_id",
  "key_generation",
  "custody_backend",
  "wrapping_schema_id",
  "wrap_nonce",
  "wrapped_pkcs8",
  "auth_tag",
  "pkcs8_digest",
  "created_at_ms",
  "destroyed_at_ms",
  "state",
] as const;

function protectedBlob(value: unknown, field: string): ProtectedByteSnapshot {
  if (!(value instanceof Uint8Array)) {
    throw new ServerSigningRepositoryPersistenceError(`${field} must be a byte array`);
  }
  try {
    return ProtectedByteSnapshot.from(value);
  } finally {
    value.fill(0);
  }
}

function envelopeFromRow(value: unknown): ServerIdentityPrivateKeyEnvelopeRecord {
  const row = record(value, ENVELOPE_ROW_KEYS, "serverIdentityPrivateKeyEnvelope");
  const snapshots: ProtectedByteSnapshot[] = [];
  try {
    const wrapNonce = protectedBlob(row.wrap_nonce, "serverIdentityPrivateKeyEnvelope.wrapNonce");
    snapshots.push(wrapNonce);
    const wrappedPkcs8 = protectedBlob(
      row.wrapped_pkcs8,
      "serverIdentityPrivateKeyEnvelope.wrappedPkcs8",
    );
    snapshots.push(wrappedPkcs8);
    const authTag = protectedBlob(row.auth_tag, "serverIdentityPrivateKeyEnvelope.authTag");
    snapshots.push(authTag);
    return parseServerPersistence("server private-key envelope", () =>
      parseServerIdentityPrivateKeyEnvelopeRecord({
        signingKeyRef: row.signing_key_ref,
        collaborationServerId: row.collaboration_server_id,
        identityKeyId: row.identity_key_id,
        keyGeneration: row.key_generation,
        custodyBackend: row.custody_backend,
        wrappingSchemaId: row.wrapping_schema_id,
        wrapNonce,
        wrappedPkcs8,
        authTag,
        pkcs8Digest: row.pkcs8_digest,
        createdAtMs: row.created_at_ms,
        destroyedAtMs: row.destroyed_at_ms,
        state: row.state,
      }),
    );
  } catch (error) {
    for (const snapshot of snapshots) snapshot.destroy();
    throw error;
  }
}

const CERTIFICATE_ROW_KEYS = [
  "scope_certificate_id",
  "schema_version",
  "canonical_payload_schema_id",
  "collaboration_server_id",
  "machine_identity_id",
  "subject_identity_key_id",
  "subject_key_algorithm",
  "subject_public_key",
  "key_generation",
  "issued_at_ms",
  "supersedes_scope_certificate_id",
  "signer_identity_key_id",
  "signer_sequence",
  "superseded_signer_max_sequence",
  "signature_algorithm",
  "canonical_payload_digest_algorithm",
  "canonical_payload_digest",
  "signature",
] as const;

function certificateFromRow(value: unknown): ServerScopeCertificateRecord {
  const row = record(value, CERTIFICATE_ROW_KEYS, "serverScopeCertificate");
  return parseServerPersistence("server scope certificate", () =>
    parseServerScopeCertificateRecord({
      scopeCertificateId: row.scope_certificate_id,
      schemaVersion: row.schema_version,
      canonicalPayloadSchemaId: row.canonical_payload_schema_id,
      collaborationServerId: row.collaboration_server_id,
      machineIdentityId: row.machine_identity_id,
      subjectIdentityKeyId: row.subject_identity_key_id,
      subjectKeyAlgorithm: row.subject_key_algorithm,
      subjectPublicKey: row.subject_public_key,
      keyGeneration: row.key_generation,
      issuedAtMs: row.issued_at_ms,
      supersedesScopeCertificateId: row.supersedes_scope_certificate_id,
      signerIdentityKeyId: row.signer_identity_key_id,
      signerSequence: row.signer_sequence,
      supersededSignerMaxSequence: row.superseded_signer_max_sequence,
      signatureAlgorithm: row.signature_algorithm,
      canonicalPayloadDigestAlgorithm: row.canonical_payload_digest_algorithm,
      canonicalPayloadDigest: row.canonical_payload_digest,
      signature: row.signature,
    }),
  );
}

const STATUS_ROW_KEYS = [
  "collaboration_server_id",
  "scope_certificate_id",
  "state",
  "accept_signatures_through_sequence",
  "changed_at_ms",
  "change_evidence_ref",
  "change_evidence_digest",
] as const;

function statusFromRow(value: unknown): ServerScopeCertificateStatusRecord {
  const row = record(value, STATUS_ROW_KEYS, "serverScopeCertificateStatus");
  return parseServerPersistence("server certificate status", () =>
    parseServerScopeCertificateStatusRecord({
      collaborationServerId: row.collaboration_server_id,
      scopeCertificateId: row.scope_certificate_id,
      state: row.state,
      acceptSignaturesThroughSequence: row.accept_signatures_through_sequence,
      changedAtMs: row.changed_at_ms,
      changeEvidenceRef: row.change_evidence_ref,
      changeEvidenceDigest: row.change_evidence_digest,
    }),
  );
}

const BOOTSTRAP_ROW_KEYS = [
  "bootstrap_signing_lease_id",
  "collaboration_server_id",
  "purpose",
  "operator_intent_evidence_ref",
  "operator_intent_evidence_digest",
  "expected_prior_scope_certificate_id",
  "proposed_identity_key_id",
  "proposed_key_generation",
  "proposed_scope_certificate_id",
  "signing_key_ref",
  "coordinator_lease_id",
  "coordinator_epoch",
  "fencing_token",
  "prepared_at_ms",
  "signed_at_ms",
  "installed_at_ms",
  "closed_at_ms",
  "state",
] as const;

function bootstrapFromRow(value: unknown): ServerBootstrapSigningLeaseRecord {
  const row = record(value, BOOTSTRAP_ROW_KEYS, "serverBootstrapSigningLease");
  return parseServerPersistence("server bootstrap signing lease", () =>
    parseServerBootstrapSigningLeaseRecord({
      bootstrapSigningLeaseId: row.bootstrap_signing_lease_id,
      collaborationServerId: row.collaboration_server_id,
      purpose: row.purpose,
      operatorIntentEvidenceRef: row.operator_intent_evidence_ref,
      operatorIntentEvidenceDigest: row.operator_intent_evidence_digest,
      expectedPriorScopeCertificateId: row.expected_prior_scope_certificate_id,
      proposedIdentityKeyId: row.proposed_identity_key_id,
      proposedKeyGeneration: row.proposed_key_generation,
      proposedScopeCertificateId: row.proposed_scope_certificate_id,
      signingKeyRef: row.signing_key_ref,
      coordinatorLeaseId: row.coordinator_lease_id,
      coordinatorEpoch: row.coordinator_epoch,
      fencingToken: row.fencing_token,
      preparedAtMs: row.prepared_at_ms,
      signedAtMs: row.signed_at_ms,
      installedAtMs: row.installed_at_ms,
      closedAtMs: row.closed_at_ms,
      state: row.state,
    }),
  );
}

const SIGNING_LEASE_ROW_KEYS = [
  "signing_lease_id",
  "collaboration_server_id",
  "identity_key_id",
  "key_generation",
  "scope_certificate_id",
  "coordinator_lease_id",
  "coordinator_epoch",
  "fencing_token",
  "acquired_at_ms",
  "draining_at_ms",
  "superseded_at_ms",
  "closed_at_ms",
  "state",
] as const;

function signingLeaseFromRow(value: unknown): ServerSigningLeaseRecord {
  const row = record(value, SIGNING_LEASE_ROW_KEYS, "serverSigningLease");
  return parseServerPersistence("server signing lease", () =>
    parseServerSigningLeaseRecord({
      signingLeaseId: row.signing_lease_id,
      collaborationServerId: row.collaboration_server_id,
      identityKeyId: row.identity_key_id,
      keyGeneration: row.key_generation,
      scopeCertificateId: row.scope_certificate_id,
      coordinatorLeaseId: row.coordinator_lease_id,
      coordinatorEpoch: row.coordinator_epoch,
      fencingToken: row.fencing_token,
      acquiredAtMs: row.acquired_at_ms,
      drainingAtMs: row.draining_at_ms,
      supersededAtMs: row.superseded_at_ms,
      closedAtMs: row.closed_at_ms,
      state: row.state,
    }),
  );
}

const RESERVATION_ROW_KEYS = [
  "collaboration_server_id",
  "signer_sequence",
  "signing_lease_id",
  "signing_lease_kind",
  "purpose",
  "canonical_payload_schema_id",
  "canonical_payload_ref",
  "canonical_payload_digest",
  "signed_record_digest",
  "signature",
  "signed_artifact_type",
  "signed_artifact_id",
  "reserved_at_ms",
  "bound_at_ms",
  "signed_at_ms",
  "aborted_at_ms",
  "state",
] as const;

function reservationFromRow(value: unknown): ServerSignatureReservationRecord {
  const row = record(value, RESERVATION_ROW_KEYS, "serverSignatureReservation");
  return parseServerPersistence("server signature reservation", () =>
    parseServerSignatureReservationRecord({
      collaborationServerId: row.collaboration_server_id,
      signerSequence: row.signer_sequence,
      signingLeaseId: row.signing_lease_id,
      signingLeaseKind: row.signing_lease_kind,
      purpose: row.purpose,
      canonicalPayloadSchemaId: row.canonical_payload_schema_id,
      canonicalPayloadRef: row.canonical_payload_ref,
      canonicalPayloadDigest: row.canonical_payload_digest,
      signedRecordDigest: row.signed_record_digest,
      signature: row.signature,
      signedArtifactType: row.signed_artifact_type,
      signedArtifactId: row.signed_artifact_id,
      reservedAtMs: row.reserved_at_ms,
      boundAtMs: row.bound_at_ms,
      signedAtMs: row.signed_at_ms,
      abortedAtMs: row.aborted_at_ms,
      state: row.state,
    }),
  );
}

const ACCEPTANCE_ROW_KEYS = [
  "collaboration_server_id",
  "accepted_at_journal_seq",
  "signed_record_digest",
  "signer_identity_key_id",
  "signer_key_generation",
  "signer_scope_certificate_id",
  "signer_sequence",
  "accepted_at_ms",
  "historical_reattestation_id",
] as const;

function acceptanceFromRow(value: unknown): ServerSignedRecordAcceptanceRecord {
  const row = record(value, ACCEPTANCE_ROW_KEYS, "serverSignedRecordAcceptance");
  return parseServerPersistence("server signed-record acceptance", () =>
    parseServerSignedRecordAcceptanceRecord({
      collaborationServerId: row.collaboration_server_id,
      acceptedAtJournalSeq: row.accepted_at_journal_seq,
      signedRecordDigest: row.signed_record_digest,
      signerIdentityKeyId: row.signer_identity_key_id,
      signerKeyGeneration: row.signer_key_generation,
      signerScopeCertificateId: row.signer_scope_certificate_id,
      signerSequence: row.signer_sequence,
      acceptedAtMs: row.accepted_at_ms,
      historicalReattestationId: row.historical_reattestation_id,
    }),
  );
}

function parseServerPersistence<T>(context: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ServerSigningRepositoryPersistenceError) throw error;
    throw new ServerSigningRepositoryPersistenceError(`${context} is invalid`, { cause: error });
  }
}

const SELECT_SERVER = `SELECT ${SERVER_ROW_KEYS.join(", ")} FROM collaboration_servers
WHERE collaboration_server_id = ? LIMIT 1`;
const SELECT_COORDINATOR = `SELECT ${COORDINATOR_ROW_KEYS.join(", ")} FROM coordinator_leases
WHERE collaboration_server_id = ? AND coordinator_lease_id = ? LIMIT 1`;
const SELECT_IDENTITY_KEY = `SELECT ${IDENTITY_KEY_ROW_KEYS.join(", ")} FROM server_identity_keys
WHERE collaboration_server_id = ? AND identity_key_id = ? LIMIT 1`;
const SELECT_ENVELOPE = `SELECT ${ENVELOPE_ROW_KEYS.join(", ")} FROM server_identity_private_key_envelopes
WHERE signing_key_ref = ? LIMIT 1`;
const SELECT_CERTIFICATE = `SELECT ${CERTIFICATE_ROW_KEYS.join(", ")} FROM server_scope_certificates
WHERE collaboration_server_id = ? AND scope_certificate_id = ? LIMIT 1`;
const SELECT_STATUS = `SELECT ${STATUS_ROW_KEYS.join(", ")} FROM server_scope_certificate_statuses
WHERE collaboration_server_id = ? AND scope_certificate_id = ? LIMIT 1`;
const SELECT_BOOTSTRAP = `SELECT ${BOOTSTRAP_ROW_KEYS.join(", ")} FROM server_bootstrap_signing_leases
WHERE collaboration_server_id = ? AND bootstrap_signing_lease_id = ? LIMIT 1`;
const SELECT_SIGNING_LEASE = `SELECT ${SIGNING_LEASE_ROW_KEYS.join(", ")} FROM server_signing_leases
WHERE collaboration_server_id = ? AND signing_lease_id = ? LIMIT 1`;
const SELECT_RESERVATION = `SELECT ${RESERVATION_ROW_KEYS.join(", ")} FROM server_signature_reservations
WHERE collaboration_server_id = ? AND signer_sequence = ? LIMIT 1`;

function findServer(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
): CollaborationServerRecord | null {
  const row = sqlGet(transaction, SELECT_SERVER, [collaborationServerId]);
  return row === undefined ? null : serverFromRow(row);
}

function findIdentityKey(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  identityKeyId: A1SafeId,
): ServerIdentityKeyRecord | null {
  const row = sqlGet(transaction, SELECT_IDENTITY_KEY, [collaborationServerId, identityKeyId]);
  return row === undefined ? null : identityKeyFromRow(row);
}

function findEnvelope(
  transaction: HostStateRepositorySqlTransaction,
  signingKeyRef: ProtectedHandleId,
): ServerIdentityPrivateKeyEnvelopeRecord | null {
  const row = sqlGet(transaction, SELECT_ENVELOPE, [signingKeyRef]);
  return row === undefined ? null : envelopeFromRow(row);
}

function findEnvelopeMetadata(
  transaction: HostStateRepositorySqlTransaction,
  signingKeyRef: ProtectedHandleId,
): Readonly<{
  collaborationServerId: CollaborationServerId;
  identityKeyId: A1SafeId;
  keyGeneration: number;
  destroyedAtMs: number | null;
  state: "current" | "destroyed";
}> | null {
  const value = sqlGet(
    transaction,
    `SELECT collaboration_server_id, identity_key_id, key_generation,
            destroyed_at_ms, state
     FROM server_identity_private_key_envelopes WHERE signing_key_ref = ? LIMIT 1`,
    [signingKeyRef],
  );
  if (value === undefined) return null;
  const row = record(
    value,
    ["collaboration_server_id", "identity_key_id", "key_generation", "destroyed_at_ms", "state"],
    "serverIdentityPrivateKeyEnvelopeMetadata",
  );
  const state = row.state;
  if (state !== "current" && state !== "destroyed") {
    throw new ServerSigningRepositoryPersistenceError(
      "server private-key envelope metadata state is invalid",
    );
  }
  return frozen({
    collaborationServerId: parseA1CanonicalId("collaborationServer", row.collaboration_server_id),
    identityKeyId: parseA1SafeId(row.identity_key_id),
    keyGeneration: parsePositiveSafeInteger(
      row.key_generation,
      "serverIdentityPrivateKeyEnvelopeMetadata.keyGeneration",
    ),
    destroyedAtMs:
      row.destroyed_at_ms === null
        ? null
        : parseNonNegativeSafeInteger(
            row.destroyed_at_ms,
            "serverIdentityPrivateKeyEnvelopeMetadata.destroyedAtMs",
          ),
    state,
  });
}

function findCertificate(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  scopeCertificateId: A1SafeId,
): ServerScopeCertificateRecord | null {
  const row = sqlGet(transaction, SELECT_CERTIFICATE, [collaborationServerId, scopeCertificateId]);
  return row === undefined ? null : certificateFromRow(row);
}

function findStatus(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  scopeCertificateId: A1SafeId,
): ServerScopeCertificateStatusRecord | null {
  const row = sqlGet(transaction, SELECT_STATUS, [collaborationServerId, scopeCertificateId]);
  return row === undefined ? null : statusFromRow(row);
}

function findBootstrap(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  bootstrapSigningLeaseId: A1SafeId,
): ServerBootstrapSigningLeaseRecord | null {
  const row = sqlGet(transaction, SELECT_BOOTSTRAP, [
    collaborationServerId,
    bootstrapSigningLeaseId,
  ]);
  return row === undefined ? null : bootstrapFromRow(row);
}

function findSigningLease(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  signingLeaseId: A1SafeId,
): ServerSigningLeaseRecord | null {
  const row = sqlGet(transaction, SELECT_SIGNING_LEASE, [collaborationServerId, signingLeaseId]);
  return row === undefined ? null : signingLeaseFromRow(row);
}

function findReservation(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  signerSequence: number,
): ServerSignatureReservationRecord | null {
  const row = sqlGet(transaction, SELECT_RESERVATION, [collaborationServerId, signerSequence]);
  return row === undefined ? null : reservationFromRow(row);
}

function findAcceptanceBySignerSequence(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
  signerSequence: number,
): ServerSignedRecordAcceptanceRecord | null {
  const row = sqlGet(
    transaction,
    `SELECT ${ACCEPTANCE_ROW_KEYS.join(", ")} FROM server_signed_record_acceptances
     WHERE collaboration_server_id = ? AND signer_sequence = ? LIMIT 1`,
    [collaborationServerId, signerSequence],
  );
  return row === undefined ? null : acceptanceFromRow(row);
}

interface CurrentCoordinatorState {
  readonly server: CollaborationServerRecord;
  readonly lease: CoordinatorLeaseRecord;
  readonly nowMs: number;
}

function assertCurrentCoordinator(
  transaction: HostStateRepositorySqlTransaction,
  fence: CoordinatorLeaseFence,
  nowMs: () => number,
): CurrentCoordinatorState {
  const now = trustedNow(nowMs);
  const server = findServer(transaction, fence.collaborationServerId);
  const leaseRow = sqlGet(transaction, SELECT_COORDINATOR, [
    fence.collaborationServerId,
    fence.coordinatorLeaseId,
  ]);
  const lease = leaseRow === undefined ? null : coordinatorFromRow(leaseRow);
  if (
    server === null ||
    lease === null ||
    server.state === "closed" ||
    server.currentCoordinatorLeaseId !== fence.coordinatorLeaseId ||
    server.currentCoordinatorEpoch !== fence.coordinatorEpoch ||
    lease.coordinatorEpoch !== fence.coordinatorEpoch ||
    lease.state !== "current" ||
    lease.releasedAtMs !== null ||
    now < lease.acquiredAtMs ||
    now >= lease.heartbeatDeadlineMs
  ) {
    throw new ServerSigningStaleCoordinatorError();
  }
  return frozen({ server, lease, nowMs: now });
}

function sameDigest(left: string, right: string): boolean {
  let leftBytes: Uint8Array | undefined;
  let rightBytes: Uint8Array | undefined;
  try {
    leftBytes = base64urlDecode(left);
    rightBytes = base64urlDecode(right);
    return Buffer.from(leftBytes).equals(Buffer.from(rightBytes));
  } finally {
    leftBytes?.fill(0);
    rightBytes?.fill(0);
  }
}

function digestBytes(bytes: Uint8Array): A1Digest {
  return parseA1Digest(base64urlEncode(createHash("sha256").update(bytes).digest()));
}

function certificatePayloadDigest(payload: ServerScopeCertificateCanonicalPayloadInput): A1Digest {
  const bytes = canonicalServerScopeCertificatePayload(payload);
  try {
    return digestBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

function signedCertificateDigest(certificate: ServerScopeCertificateRecord): A1Digest {
  const signature = base64urlDecode(certificate.signature);
  const payloadDigest = base64urlDecode(certificate.canonicalPayloadDigest);
  let preimage: Uint8Array | undefined;
  try {
    const writer = new CanonicalWriter();
    writer.str(SERVER_SCOPE_CERTIFICATE_SIGNED_DOMAIN);
    writer.bytes(payloadDigest);
    writer.str(certificate.signerIdentityKeyId);
    writer.uint(certificate.keyGeneration);
    writer.uint(certificate.signerSequence);
    writer.bytes(signature);
    preimage = writer.finish();
    return digestBytes(preimage);
  } finally {
    preimage?.fill(0);
    signature.fill(0);
    payloadDigest.fill(0);
  }
}

function certificatePayload(certificate: ServerScopeCertificateRecord) {
  return parseServerScopeCertificateCanonicalPayloadInput({
    schemaVersion: certificate.schemaVersion,
    canonicalPayloadSchemaId: certificate.canonicalPayloadSchemaId,
    scopeCertificateId: certificate.scopeCertificateId,
    collaborationServerId: certificate.collaborationServerId,
    machineIdentityId: certificate.machineIdentityId,
    subjectIdentityKeyId: certificate.subjectIdentityKeyId,
    subjectKeyAlgorithm: certificate.subjectKeyAlgorithm,
    subjectPublicKey: certificate.subjectPublicKey,
    keyGeneration: certificate.keyGeneration,
    issuedAtMs: certificate.issuedAtMs,
    supersedesScopeCertificateId: certificate.supersedesScopeCertificateId,
    signerIdentityKeyId: certificate.signerIdentityKeyId,
    signerSequence: certificate.signerSequence,
    supersededSignerMaxSequence: certificate.supersededSignerMaxSequence,
    signatureAlgorithm: certificate.signatureAlgorithm,
    canonicalPayloadDigestAlgorithm: certificate.canonicalPayloadDigestAlgorithm,
  });
}

function assertSameCertificate(
  actual: ServerScopeCertificateRecord,
  expected: ServerScopeCertificateRecord,
  context: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ServerSigningRepositoryConflictError(`${context} certificate collided`);
  }
}

function insertScopeCertificate(
  transaction: HostStateRepositorySqlTransaction,
  certificate: ServerScopeCertificateRecord,
): void {
  runExactlyOne(
    transaction,
    `INSERT INTO server_scope_certificates (
       scope_certificate_id, schema_version, canonical_payload_schema_id,
       collaboration_server_id, machine_identity_id, subject_identity_key_id,
       subject_key_algorithm, subject_public_key, key_generation, issued_at_ms,
       supersedes_scope_certificate_id, signer_identity_key_id, signer_sequence,
       superseded_signer_max_sequence, signature_algorithm,
       canonical_payload_digest_algorithm, canonical_payload_digest, signature
     ) VALUES (?, 1, ?, ?, ?, ?, 'Ed25519', ?, 1, ?, NULL, ?, ?, NULL,
               'Ed25519', 'SHA-256', ?, ?)`,
    [
      certificate.scopeCertificateId,
      SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
      certificate.collaborationServerId,
      certificate.machineIdentityId,
      certificate.subjectIdentityKeyId,
      certificate.subjectPublicKey,
      certificate.issuedAtMs,
      certificate.signerIdentityKeyId,
      certificate.signerSequence,
      certificate.canonicalPayloadDigest,
      certificate.signature,
    ],
    "server scope-certificate signed-record insert",
  );
}

function assertInitialCertificateCoordinates(
  server: CollaborationServerRecord,
  lease: ServerBootstrapSigningLeaseRecord,
  key: ServerIdentityKeyRecord,
  payload: ServerScopeCertificateCanonicalPayloadInput,
  expectedSignerSequence: number,
): void {
  if (
    payload.schemaVersion !== 1 ||
    payload.canonicalPayloadSchemaId !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
    payload.scopeCertificateId !== lease.proposedScopeCertificateId ||
    payload.collaborationServerId !== server.collaborationServerId ||
    payload.machineIdentityId !== server.machineIdentityId ||
    payload.subjectIdentityKeyId !== lease.proposedIdentityKeyId ||
    payload.subjectIdentityKeyId !== key.identityKeyId ||
    payload.subjectPublicKey !== key.publicKey ||
    payload.subjectKeyAlgorithm !== "Ed25519" ||
    payload.keyGeneration !== lease.proposedKeyGeneration ||
    payload.keyGeneration !== key.keyGeneration ||
    payload.issuedAtMs < lease.preparedAtMs ||
    payload.supersedesScopeCertificateId !== null ||
    payload.signerIdentityKeyId !== key.identityKeyId ||
    payload.signerSequence !== expectedSignerSequence ||
    payload.supersededSignerMaxSequence !== null ||
    payload.signatureAlgorithm !== "Ed25519" ||
    payload.canonicalPayloadDigestAlgorithm !== "SHA-256"
  ) {
    throw new ServerSigningRepositoryConflictError(
      "initial certificate payload does not match its bootstrap lease",
    );
  }
}

function assertCertificateSignature(
  certificate: ServerScopeCertificateRecord,
  key: ServerIdentityKeyRecord,
): void {
  const payload = certificatePayload(certificate);
  const payloadBytes = canonicalServerScopeCertificatePayload(payload);
  const signatureBytes = base64urlDecode(certificate.signature);
  try {
    if (!sameDigest(certificate.canonicalPayloadDigest, digestBytes(payloadBytes))) {
      throw new ServerSigningRepositoryConflictError(
        "certificate canonical payload digest does not match",
      );
    }
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.publicKey },
      format: "jwk",
    });
    if (!verifySignature(null, payloadBytes, publicKey, signatureBytes)) {
      throw new ServerSigningRepositoryConflictError(
        "certificate signature does not verify under the proposed server key",
      );
    }
  } catch (error) {
    if (error instanceof ServerSigningRepositoryConflictError) throw error;
    throw new ServerSigningRepositoryConflictError("certificate signature verification failed");
  } finally {
    payloadBytes.fill(0);
    signatureBytes.fill(0);
  }
}

function assertStoredInitialCertificateEvidence(
  transaction: HostStateRepositorySqlTransaction,
  server: CollaborationServerRecord,
  lease: ServerBootstrapSigningLeaseRecord,
  key: ServerIdentityKeyRecord,
  reservation: ServerSignatureReservationRecord,
  certificate: ServerScopeCertificateRecord,
): void {
  try {
    assertInitialCertificateCoordinates(
      server,
      lease,
      key,
      certificatePayload(certificate),
      reservation.signerSequence,
    );
    assertCertificateSignature(certificate, key);
  } catch (error) {
    throw new ServerSigningRepositoryPersistenceError(
      "stored bootstrap certificate does not match its exact key and lease coordinates",
      { cause: error },
    );
  }
  const signedRecordDigest = signedCertificateDigest(certificate);
  if (
    reservation.state !== "signed" ||
    reservation.signingLeaseKind !== "bootstrap" ||
    reservation.signingLeaseId !== lease.bootstrapSigningLeaseId ||
    reservation.purpose !== "scope_certificate" ||
    reservation.canonicalPayloadSchemaId !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
    reservation.canonicalPayloadRef === null ||
    reservation.canonicalPayloadDigest === null ||
    reservation.boundAtMs === null ||
    certificate.issuedAtMs > reservation.boundAtMs ||
    reservation.signedAtMs === null ||
    lease.signedAtMs !== reservation.signedAtMs ||
    !sameDigest(reservation.canonicalPayloadDigest, certificate.canonicalPayloadDigest) ||
    reservation.signedRecordDigest === null ||
    !sameDigest(reservation.signedRecordDigest, signedRecordDigest) ||
    reservation.signature !== certificate.signature ||
    reservation.signedArtifactType !== SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE ||
    reservation.signedArtifactId !== certificate.scopeCertificateId
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "stored bootstrap certificate does not match its signed reservation",
    );
  }
  const certificateBytes = canonicalServerScopeCertificatePayload(certificatePayload(certificate));
  try {
    assertCanonicalArtifact(
      transaction,
      server.collaborationServerId,
      parseA1CanonicalId("protectedHandle", reservation.canonicalPayloadRef),
      reservation.canonicalPayloadDigest,
      certificateBytes,
    );
  } catch (error) {
    throw new ServerSigningRepositoryPersistenceError(
      "stored bootstrap certificate canonical artifact is invalid",
      { cause: error },
    );
  } finally {
    certificateBytes.fill(0);
  }
}

function assertCanonicalArtifact(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  artifactRef: ProtectedHandleId,
  expectedDigest: A1Digest,
  expectedBytes: Uint8Array,
): void {
  const row = sqlGet(
    transaction,
    `SELECT scope_kind, scope_id, artifact_schema_id, artifact_digest, artifact_bytes
     FROM protected_artifacts WHERE protected_handle_id = ? LIMIT 1`,
    [artifactRef],
  );
  const parsed = record(
    row,
    ["scope_kind", "scope_id", "artifact_schema_id", "artifact_digest", "artifact_bytes"],
    "serverScopeCertificateArtifact",
  );
  const actualBytes = parsed.artifact_bytes;
  if (!(actualBytes instanceof Uint8Array)) {
    throw new ServerSigningRepositoryPersistenceError(
      "server scope-certificate artifact bytes are invalid",
    );
  }
  try {
    if (
      parsed.scope_kind !== "collaboration_server" ||
      parsed.scope_id !== serverId ||
      parsed.artifact_schema_id !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
      parsed.artifact_digest !== expectedDigest ||
      !Buffer.from(actualBytes).equals(Buffer.from(expectedBytes))
    ) {
      throw new ServerSigningRepositoryConflictError(
        "scope-certificate payload artifact does not match the exact canonical payload",
      );
    }
  } finally {
    actualBytes.fill(0);
  }
}

class ServerScopePayloadReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  #remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  #rawByte(field: string): number {
    if (this.#remaining() < 1) {
      throw new ServerSigningRepositoryPersistenceError(`${field} is truncated`);
    }
    const value = this.#bytes[this.#offset];
    this.#offset++;
    if (value === undefined) {
      throw new ServerSigningRepositoryPersistenceError(`${field} is truncated`);
    }
    return value;
  }

  bytes(field: string, maximum: number, exact?: number): Uint8Array {
    if (this.#remaining() < 4) {
      throw new ServerSigningRepositoryPersistenceError(`${field} length is truncated`);
    }
    const length = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#offset,
      4,
    ).getUint32(0, false);
    this.#offset += 4;
    if (
      length > maximum ||
      (exact !== undefined && length !== exact) ||
      length > this.#remaining()
    ) {
      throw new ServerSigningRepositoryPersistenceError(`${field} has an invalid length`);
    }
    const value = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  str(field: string, maximum = 1_024): string {
    const bytes = this.bytes(field, maximum);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ServerSigningRepositoryPersistenceError(`${field} is not valid UTF-8`, {
        cause: error,
      });
    } finally {
      bytes.fill(0);
    }
  }

  uint(field: string): number {
    const bytes = this.bytes(field, 8, 8);
    try {
      const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ServerSigningRepositoryPersistenceError(`${field} exceeds safe integer range`);
      }
      return Number(value);
    } finally {
      bytes.fill(0);
    }
  }

  optionalStr(field: string): string | null {
    const presence = this.#rawByte(`${field}.presence`);
    if (presence === 0) return null;
    if (presence !== 1) {
      throw new ServerSigningRepositoryPersistenceError(`${field} presence is noncanonical`);
    }
    return this.str(field);
  }

  optionalUint(field: string): number | null {
    const presence = this.#rawByte(`${field}.presence`);
    if (presence === 0) return null;
    if (presence !== 1) {
      throw new ServerSigningRepositoryPersistenceError(`${field} presence is noncanonical`);
    }
    return this.uint(field);
  }

  finish(): void {
    if (this.#remaining() !== 0) {
      throw new ServerSigningRepositoryPersistenceError(
        "scope-certificate canonical payload contains trailing bytes",
      );
    }
  }
}

function decodeCanonicalServerScopeCertificatePayload(
  bytes: Uint8Array,
): ServerScopeCertificateCanonicalPayloadInput {
  const reader = new ServerScopePayloadReader(bytes);
  const canonicalPayloadSchemaId = reader.str("certificate.canonicalPayloadSchemaId");
  const schemaVersion = reader.uint("certificate.schemaVersion");
  const scopeCertificateId = reader.str("certificate.scopeCertificateId");
  const machineIdentityBytes = reader.bytes("certificate.machineIdentityId", 16, 16);
  const collaborationServerId = reader.str("certificate.collaborationServerId");
  const subjectIdentityKeyId = reader.str("certificate.subjectIdentityKeyId");
  const subjectKeyAlgorithm = reader.str("certificate.subjectKeyAlgorithm", 16);
  const publicKeyBytes = reader.bytes("certificate.subjectPublicKey", 32, 32);
  let parsed: ServerScopeCertificateCanonicalPayloadInput;
  try {
    parsed = parseServerScopeCertificateCanonicalPayloadInput({
      canonicalPayloadSchemaId,
      schemaVersion,
      scopeCertificateId,
      machineIdentityId: Buffer.from(machineIdentityBytes).toString("hex"),
      collaborationServerId,
      subjectIdentityKeyId,
      subjectKeyAlgorithm,
      subjectPublicKey: base64urlEncode(publicKeyBytes),
      keyGeneration: reader.uint("certificate.keyGeneration"),
      issuedAtMs: reader.uint("certificate.issuedAtMs"),
      supersedesScopeCertificateId: reader.optionalStr("certificate.supersedesScopeCertificateId"),
      signerIdentityKeyId: reader.str("certificate.signerIdentityKeyId"),
      signerSequence: reader.uint("certificate.signerSequence"),
      supersededSignerMaxSequence: reader.optionalUint("certificate.supersededSignerMaxSequence"),
      signatureAlgorithm: reader.str("certificate.signatureAlgorithm", 16),
      canonicalPayloadDigestAlgorithm: reader.str(
        "certificate.canonicalPayloadDigestAlgorithm",
        16,
      ),
    });
    reader.finish();
  } finally {
    machineIdentityBytes.fill(0);
    publicKeyBytes.fill(0);
  }
  const reencoded = canonicalServerScopeCertificatePayload(parsed);
  try {
    if (!Buffer.from(reencoded).equals(Buffer.from(bytes))) {
      throw new ServerSigningRepositoryPersistenceError(
        "scope-certificate payload is not canonically encoded",
      );
    }
  } finally {
    reencoded.fill(0);
  }
  return parsed;
}

function readBoundScopeCertificatePayload(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  artifactRef: ProtectedHandleId,
  expectedDigest: A1Digest,
): ServerScopeCertificateCanonicalPayloadInput {
  const row = sqlGet(
    transaction,
    `SELECT scope_kind, scope_id, artifact_schema_id, artifact_digest, artifact_bytes
     FROM protected_artifacts WHERE protected_handle_id = ? LIMIT 1`,
    [artifactRef],
  );
  const artifact = record(
    row,
    ["scope_kind", "scope_id", "artifact_schema_id", "artifact_digest", "artifact_bytes"],
    "boundServerScopeCertificateArtifact",
  );
  if (!(artifact.artifact_bytes instanceof Uint8Array)) {
    throw new ServerSigningRepositoryPersistenceError(
      "bound scope-certificate artifact bytes are invalid",
    );
  }
  const bytes = artifact.artifact_bytes;
  try {
    if (
      artifact.scope_kind !== "collaboration_server" ||
      artifact.scope_id !== serverId ||
      artifact.artifact_schema_id !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
      artifact.artifact_digest !== expectedDigest ||
      !sameDigest(digestBytes(bytes), expectedDigest)
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "bound scope-certificate artifact metadata or digest is invalid",
      );
    }
    return decodeCanonicalServerScopeCertificatePayload(bytes);
  } finally {
    bytes.fill(0);
  }
}

function assertBootstrapIntentArtifact(
  transaction: HostStateRepositorySqlTransaction,
  intent: ServerSignerBootstrapIntentV1,
  artifactRef: ProtectedHandleId,
  expectedDigest: A1Digest,
): void {
  const expectedBytes = encodeServerSignerBootstrapIntentV1(intent);
  const row = sqlGet(
    transaction,
    `SELECT scope_kind, scope_id, artifact_schema_id, artifact_digest, artifact_bytes
     FROM protected_artifacts WHERE protected_handle_id = ? LIMIT 1`,
    [artifactRef],
  );
  const parsed = record(
    row,
    ["scope_kind", "scope_id", "artifact_schema_id", "artifact_digest", "artifact_bytes"],
    "serverSignerBootstrapIntentArtifact",
  );
  const actualBytes = parsed.artifact_bytes;
  if (!(actualBytes instanceof Uint8Array)) {
    expectedBytes.fill(0);
    throw new ServerSigningRepositoryPersistenceError(
      "server signer bootstrap-intent artifact bytes are invalid",
    );
  }
  try {
    if (
      parsed.scope_kind !== "collaboration_server" ||
      parsed.scope_id !== intent.collaborationServerId ||
      parsed.artifact_schema_id !== SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID ||
      parsed.artifact_digest !== expectedDigest ||
      !Buffer.from(actualBytes).equals(Buffer.from(expectedBytes))
    ) {
      throw new ServerSigningRepositoryConflictError(
        "server signer bootstrap-intent artifact does not match the exact intent",
      );
    }
  } finally {
    actualBytes.fill(0);
    expectedBytes.fill(0);
  }
}

function sameSnapshot(left: ProtectedByteSnapshot, right: ProtectedByteSnapshot): boolean {
  const leftBytes = left.copyBytes();
  const rightBytes = right.copyBytes();
  try {
    return Buffer.from(leftBytes).equals(Buffer.from(rightBytes));
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function assertBootstrapPrepareReplay(
  request: PrepareInitialServerSignerRequest,
  key: ServerIdentityKeyRecord,
  envelope: ServerIdentityPrivateKeyEnvelopeRecord,
  lease: ServerBootstrapSigningLeaseRecord,
  reservation: ServerSignatureReservationRecord,
): void {
  if (
    lease.bootstrapSigningLeaseId !== request.bootstrapSigningLeaseId ||
    lease.collaborationServerId !== request.fence.collaborationServerId ||
    lease.purpose !== "initial_pair" ||
    lease.operatorIntentEvidenceRef !== request.operatorIntentEvidenceRef ||
    !sameDigest(lease.operatorIntentEvidenceDigest, request.operatorIntentEvidenceDigest) ||
    lease.expectedPriorScopeCertificateId !== null ||
    lease.proposedIdentityKeyId !== request.key.identityKeyId ||
    lease.proposedKeyGeneration !== 1 ||
    lease.proposedScopeCertificateId !== request.proposedScopeCertificateId ||
    lease.signingKeyRef !== request.key.signingKeyRef ||
    lease.coordinatorLeaseId !== request.fence.coordinatorLeaseId ||
    lease.coordinatorEpoch !== request.fence.coordinatorEpoch ||
    lease.fencingToken !== request.expectedFencingToken + 1 ||
    lease.preparedAtMs !== request.bootstrapIntent.preparedAtMs ||
    key.collaborationServerId !== request.fence.collaborationServerId ||
    key.identityKeyId !== request.key.identityKeyId ||
    key.keyGeneration !== 1 ||
    key.publicKey !== request.key.publicKey ||
    key.signingKeyRef !== request.key.signingKeyRef ||
    key.trustEvidenceRef !== request.operatorIntentEvidenceRef ||
    !sameDigest(key.trustEvidenceDigest, request.operatorIntentEvidenceDigest) ||
    key.validFromMs !== request.bootstrapIntent.preparedAtMs ||
    envelope.signingKeyRef !== request.key.signingKeyRef ||
    envelope.collaborationServerId !== request.fence.collaborationServerId ||
    envelope.identityKeyId !== request.key.identityKeyId ||
    envelope.keyGeneration !== 1 ||
    envelope.wrappingSchemaId !== request.key.wrappingSchemaId ||
    !sameSnapshot(envelope.wrapNonce, request.key.wrapNonce) ||
    !sameSnapshot(envelope.wrappedPkcs8, request.key.wrappedPkcs8) ||
    !sameSnapshot(envelope.authTag, request.key.authTag) ||
    !sameDigest(envelope.pkcs8Digest, request.key.pkcs8Digest) ||
    envelope.createdAtMs !== request.bootstrapIntent.preparedAtMs ||
    reservation.collaborationServerId !== request.fence.collaborationServerId ||
    reservation.signerSequence !== request.expectedServerSignatureSeq ||
    reservation.signingLeaseId !== request.bootstrapSigningLeaseId ||
    reservation.signingLeaseKind !== "bootstrap" ||
    reservation.purpose !== "scope_certificate" ||
    reservation.reservedAtMs !== request.bootstrapIntent.preparedAtMs
  ) {
    throw new ServerSigningRepositoryConflictError("initial bootstrap intent collided");
  }
}

function assertBootstrapBindReconciliation(
  transaction: HostStateRepositorySqlTransaction,
  server: CollaborationServerRecord,
  lease: ServerBootstrapSigningLeaseRecord,
  key: ServerIdentityKeyRecord,
  reservation: ServerSignatureReservationRecord,
  request: BindInitialServerScopeCertificateRequest,
): void {
  assertInitialCertificateCoordinates(
    server,
    lease,
    key,
    request.certificatePayload,
    request.signerSequence,
  );
  const canonicalBytes = canonicalServerScopeCertificatePayload(request.certificatePayload);
  try {
    const canonicalPayloadDigest = digestBytes(canonicalBytes);
    const retainedArtifact = sqlGet(
      transaction,
      `SELECT protected_handle_id FROM protected_artifacts
       WHERE protected_handle_id = ?`,
      [request.canonicalPayloadRef],
    );
    if (retainedArtifact === undefined && reservation.state === "reserved") return;
    assertCanonicalArtifact(
      transaction,
      server.collaborationServerId,
      request.canonicalPayloadRef,
      canonicalPayloadDigest,
      canonicalBytes,
    );
    if (
      reservation.state !== "reserved" &&
      (reservation.canonicalPayloadSchemaId !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
        reservation.canonicalPayloadRef !== request.canonicalPayloadRef ||
        reservation.canonicalPayloadDigest === null ||
        !sameDigest(reservation.canonicalPayloadDigest, canonicalPayloadDigest) ||
        reservation.signedArtifactType !== SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE ||
        reservation.signedArtifactId !== request.certificatePayload.scopeCertificateId)
    ) {
      throw new ServerSigningRepositoryConflictError("reconciled scope-certificate bind collided");
    }
  } finally {
    canonicalBytes.fill(0);
  }
}

function hasEffectiveCoordinatorLease(
  transaction: HostStateRepositorySqlTransaction,
  server: CollaborationServerRecord,
  coordinatorLeaseId: A1SafeId,
  coordinatorEpoch: number,
  nowMs: number,
): boolean {
  if (
    server.currentCoordinatorLeaseId !== coordinatorLeaseId ||
    server.currentCoordinatorEpoch !== coordinatorEpoch
  ) {
    return false;
  }
  const row = sqlGet(transaction, SELECT_COORDINATOR, [
    server.collaborationServerId,
    coordinatorLeaseId,
  ]);
  if (row === undefined) return false;
  const coordinator = coordinatorFromRow(row);
  return (
    coordinator.coordinatorEpoch === coordinatorEpoch &&
    coordinator.state === "current" &&
    coordinator.releasedAtMs === null &&
    nowMs >= coordinator.acquiredAtMs &&
    nowMs < coordinator.heartbeatDeadlineMs
  );
}

function assertBootstrapObservationWindow(
  transaction: HostStateRepositorySqlTransaction,
  lease: ServerBootstrapSigningLeaseRecord,
  reservation: ServerSignatureReservationRecord,
): CoordinatorLeaseRecord {
  const row = sqlGet(transaction, SELECT_COORDINATOR, [
    lease.collaborationServerId,
    lease.coordinatorLeaseId,
  ]);
  if (row === undefined) {
    throw new ServerSigningRepositoryPersistenceError(
      "bootstrap signing lease has no coordinator history",
    );
  }
  const coordinator = coordinatorFromRow(row);
  const observations = [
    lease.preparedAtMs,
    reservation.reservedAtMs,
    reservation.boundAtMs,
    reservation.signedAtMs,
  ].filter((value): value is number => value !== null);
  if (
    coordinator.collaborationServerId !== lease.collaborationServerId ||
    coordinator.coordinatorLeaseId !== lease.coordinatorLeaseId ||
    coordinator.coordinatorEpoch !== lease.coordinatorEpoch ||
    reservation.reservedAtMs !== lease.preparedAtMs ||
    observations.some(
      (observation) =>
        observation < coordinator.acquiredAtMs ||
        observation >= coordinator.heartbeatDeadlineMs ||
        (coordinator.releasedAtMs !== null && observation > coordinator.releasedAtMs),
    )
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "bootstrap observations fall outside their exact coordinator window",
    );
  }
  return coordinator;
}

function maxFencingToken(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
): number {
  const row = sqlGet(
    transaction,
    `SELECT MAX(fencing_token) AS max_fencing_token FROM (
       SELECT fencing_token FROM server_bootstrap_signing_leases
       WHERE collaboration_server_id = ?
       UNION ALL
       SELECT fencing_token FROM server_signing_leases
       WHERE collaboration_server_id = ?
     )`,
    [collaborationServerId, collaborationServerId],
  );
  const parsed = record(row, ["max_fencing_token"], "serverSigningFencingMaximum");
  return parsed.max_fencing_token === null
    ? 0
    : parsePositiveSafeInteger(
        parsed.max_fencing_token,
        "serverSigningFencingMaximum.maxFencingToken",
      );
}

function nextFencingToken(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new ServerSigningRepositoryConflictError("server signing fencing token is exhausted");
  }
  return value + 1;
}

function assertSigningKeyHandleAvailable(
  transaction: HostStateRepositorySqlTransaction,
  signingKeyRef: ProtectedHandleId,
): void {
  if (
    sqlGet(
      transaction,
      `SELECT protected_handle_id FROM protected_artifacts
       WHERE protected_handle_id = ? LIMIT 1`,
      [signingKeyRef],
    ) !== undefined ||
    sqlGet(
      transaction,
      `SELECT protected_handle_id FROM runtime_owner_private_keys
       WHERE protected_handle_id = ? LIMIT 1`,
      [signingKeyRef],
    ) !== undefined ||
    sqlGet(transaction, SELECT_ENVELOPE, [signingKeyRef]) !== undefined
  ) {
    throw new ServerSigningRepositoryConflictError("protected signing-key handle is occupied");
  }
}

function insertInitialKey(
  transaction: HostStateRepositorySqlTransaction,
  server: CollaborationServerRecord,
  request: PrepareInitialServerSignerRequest,
  nowMs: number,
): Readonly<{
  identityKey: ServerIdentityKeyRecord;
  envelope: ServerIdentityPrivateKeyEnvelopeRecord;
}> {
  const publicKeyBytes = base64urlDecode(request.key.publicKey);
  try {
    if (
      deriveServerIdentityKeyId(
        server.machineIdentityId,
        request.fence.collaborationServerId,
        1,
        publicKeyBytes,
      ) !== request.key.identityKeyId
    ) {
      throw new ServerSigningRepositoryConflictError(
        "server identity-key ID does not match its machine/server/public binding",
      );
    }
  } finally {
    publicKeyBytes.fill(0);
  }
  const identityKey = parseServerIdentityKeyRecord({
    collaborationServerId: request.fence.collaborationServerId,
    identityKeyId: request.key.identityKeyId,
    keyGeneration: 1,
    algorithm: "Ed25519",
    publicKey: request.key.publicKey,
    signingKeyRef: request.key.signingKeyRef,
    introducedByScopeCertificateId: null,
    trustEvidenceRef: request.operatorIntentEvidenceRef,
    trustEvidenceDigest: request.operatorIntentEvidenceDigest,
    validFromMs: nowMs,
    state: "proposed",
  });
  const envelope = parseServerIdentityPrivateKeyEnvelopeRecord({
    signingKeyRef: request.key.signingKeyRef,
    collaborationServerId: request.fence.collaborationServerId,
    identityKeyId: request.key.identityKeyId,
    keyGeneration: 1,
    custodyBackend: "owned-file",
    wrappingSchemaId: request.key.wrappingSchemaId,
    wrapNonce: request.key.wrapNonce,
    wrappedPkcs8: request.key.wrappedPkcs8,
    authTag: request.key.authTag,
    pkcs8Digest: request.key.pkcs8Digest,
    createdAtMs: nowMs,
    destroyedAtMs: null,
    state: "current",
  });
  runExactlyOne(
    transaction,
    `INSERT INTO server_identity_keys (
       collaboration_server_id, identity_key_id, key_generation, algorithm, public_key,
       signing_key_ref, introduced_by_scope_certificate_id, trust_evidence_ref,
       trust_evidence_digest, valid_from_ms, state
     ) VALUES (?, ?, 1, 'Ed25519', ?, ?, NULL, ?, ?, ?, 'proposed')`,
    [
      identityKey.collaborationServerId,
      identityKey.identityKeyId,
      identityKey.publicKey,
      identityKey.signingKeyRef,
      identityKey.trustEvidenceRef,
      identityKey.trustEvidenceDigest,
      identityKey.validFromMs,
    ],
    "server identity-key insert",
  );
  const wrapNonce = envelope.wrapNonce.copyBytes();
  const wrappedPkcs8 = envelope.wrappedPkcs8.copyBytes();
  const authTag = envelope.authTag.copyBytes();
  try {
    runExactlyOne(
      transaction,
      `INSERT INTO server_identity_private_key_envelopes (
         signing_key_ref, collaboration_server_id, identity_key_id, key_generation,
         custody_backend, wrapping_schema_id, wrap_nonce, wrapped_pkcs8, auth_tag,
         pkcs8_digest, created_at_ms, destroyed_at_ms, state
       ) VALUES (?, ?, ?, 1, 'owned-file', ?, ?, ?, ?, ?, ?, NULL, 'current')`,
      [
        envelope.signingKeyRef,
        envelope.collaborationServerId,
        envelope.identityKeyId,
        envelope.wrappingSchemaId,
        wrapNonce,
        wrappedPkcs8,
        authTag,
        envelope.pkcs8Digest,
        envelope.createdAtMs,
      ],
      "server private-key envelope insert",
    );
  } finally {
    wrapNonce.fill(0);
    wrappedPkcs8.fill(0);
    authTag.fill(0);
  }
  return frozen({ identityKey, envelope });
}

function readInventoryTransaction(
  transaction: HostStateRepositorySqlTransaction,
  collaborationServerId: CollaborationServerId,
): ServerSigningInventory {
  const privateKeyEnvelopes: ServerIdentityPrivateKeyEnvelopeRecord[] = [];
  try {
    const identityKeys = sqlAll(
      transaction,
      `SELECT ${IDENTITY_KEY_ROW_KEYS.join(", ")} FROM server_identity_keys
       WHERE collaboration_server_id = ? ORDER BY key_generation, identity_key_id`,
      [collaborationServerId],
    ).map(identityKeyFromRow);
    for (const row of sqlAll(
      transaction,
      `SELECT ${ENVELOPE_ROW_KEYS.join(", ")}
       FROM server_identity_private_key_envelopes
       WHERE collaboration_server_id = ? ORDER BY key_generation, identity_key_id`,
      [collaborationServerId],
    )) {
      privateKeyEnvelopes.push(envelopeFromRow(row));
    }
    const scopeCertificates = sqlAll(
      transaction,
      `SELECT ${CERTIFICATE_ROW_KEYS.join(", ")} FROM server_scope_certificates
       WHERE collaboration_server_id = ? ORDER BY key_generation, scope_certificate_id`,
      [collaborationServerId],
    ).map(certificateFromRow);
    const certificateStatuses = sqlAll(
      transaction,
      `SELECT ${STATUS_ROW_KEYS.join(", ")} FROM server_scope_certificate_statuses
       WHERE collaboration_server_id = ? ORDER BY scope_certificate_id`,
      [collaborationServerId],
    ).map(statusFromRow);
    const bootstrapLeases = sqlAll(
      transaction,
      `SELECT ${BOOTSTRAP_ROW_KEYS.join(", ")} FROM server_bootstrap_signing_leases
       WHERE collaboration_server_id = ? ORDER BY fencing_token, bootstrap_signing_lease_id`,
      [collaborationServerId],
    ).map(bootstrapFromRow);
    const signingLeases = sqlAll(
      transaction,
      `SELECT ${SIGNING_LEASE_ROW_KEYS.join(", ")} FROM server_signing_leases
       WHERE collaboration_server_id = ? ORDER BY fencing_token, signing_lease_id`,
      [collaborationServerId],
    ).map(signingLeaseFromRow);
    const reservations = sqlAll(
      transaction,
      `SELECT ${RESERVATION_ROW_KEYS.join(", ")} FROM server_signature_reservations
       WHERE collaboration_server_id = ? ORDER BY signer_sequence`,
      [collaborationServerId],
    ).map(reservationFromRow);
    const acceptances = sqlAll(
      transaction,
      `SELECT ${ACCEPTANCE_ROW_KEYS.join(", ")} FROM server_signed_record_acceptances
       WHERE collaboration_server_id = ? ORDER BY accepted_at_journal_seq`,
      [collaborationServerId],
    ).map(acceptanceFromRow);
    return frozen({
      identityKeys: Object.freeze(identityKeys),
      privateKeyEnvelopes: Object.freeze(privateKeyEnvelopes),
      scopeCertificates: Object.freeze(scopeCertificates),
      certificateStatuses: Object.freeze(certificateStatuses),
      bootstrapLeases: Object.freeze(bootstrapLeases),
      signingLeases: Object.freeze(signingLeases),
      reservations: Object.freeze(reservations),
      acceptances: Object.freeze(acceptances),
    });
  } catch (error) {
    for (const envelope of privateKeyEnvelopes) {
      envelope.wrapNonce.destroy();
      envelope.wrappedPkcs8.destroy();
      envelope.authTag.destroy();
    }
    throw error;
  }
}

function destroyInventoryEnvelopes(inventory: ServerSigningInventory): void {
  for (const envelope of inventory.privateKeyEnvelopes) {
    envelope.wrapNonce.destroy();
    envelope.wrappedPkcs8.destroy();
    envelope.authTag.destroy();
  }
}

class ServerSigningRepository implements ServerSigningRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #nowMs: () => number;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    nowMs: () => number,
  ) {
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#nowMs = nowMs;
  }

  prepareInitialBootstrap(
    request: PrepareInitialServerSignerRequest,
  ): PrepareInitialServerSignerResult {
    const parsed = parsePrepareRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentCoordinator(transaction, parsed.fence, this.#nowMs);
      if (current.server.machineIdentityId !== this.#machineIdentityId) {
        throw new ServerSigningRepositoryConflictError("server belongs to another machine");
      }
      const intentDigest = serverSignerBootstrapIntentDigest(parsed.bootstrapIntent);
      if (
        parsed.bootstrapIntent.machineIdentityId !== current.server.machineIdentityId ||
        parsed.bootstrapIntent.collaborationServerId !== parsed.fence.collaborationServerId ||
        parsed.bootstrapIntent.bootstrapSigningLeaseId !== parsed.bootstrapSigningLeaseId ||
        parsed.bootstrapIntent.proposedIdentityKeyId !== parsed.key.identityKeyId ||
        parsed.bootstrapIntent.proposedPublicKey !== parsed.key.publicKey ||
        parsed.bootstrapIntent.proposedScopeCertificateId !== parsed.proposedScopeCertificateId ||
        parsed.bootstrapIntent.signingKeyRef !== parsed.key.signingKeyRef ||
        parsed.bootstrapIntent.preparedAtMs > current.nowMs ||
        !sameDigest(intentDigest, parsed.operatorIntentEvidenceDigest)
      ) {
        throw new ServerSigningRepositoryConflictError(
          "bootstrap intent does not match the exact initial signer proposal",
        );
      }
      assertBootstrapIntentArtifact(
        transaction,
        parsed.bootstrapIntent,
        parsed.operatorIntentEvidenceRef,
        intentDigest,
      );
      const existingLease = findBootstrap(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.bootstrapSigningLeaseId,
      );
      if (existingLease !== null) {
        const identityKey = findIdentityKey(
          transaction,
          parsed.fence.collaborationServerId,
          existingLease.proposedIdentityKeyId,
        );
        const envelope = findEnvelope(transaction, existingLease.signingKeyRef);
        const reservation = findReservation(
          transaction,
          parsed.fence.collaborationServerId,
          parsed.expectedServerSignatureSeq,
        );
        if (identityKey === null || envelope === null || reservation === null) {
          envelope?.wrapNonce.destroy();
          envelope?.wrappedPkcs8.destroy();
          envelope?.authTag.destroy();
          throw new ServerSigningRepositoryPersistenceError(
            "bootstrap replay has incomplete key or reservation evidence",
          );
        }
        try {
          assertBootstrapPrepareReplay(parsed, identityKey, envelope, existingLease, reservation);
        } catch (error) {
          envelope.wrapNonce.destroy();
          envelope.wrappedPkcs8.destroy();
          envelope.authTag.destroy();
          throw error;
        }
        return frozen({
          identityKey,
          privateKeyEnvelope: envelope,
          bootstrapLease: existingLease,
          reservation,
          replayed: true,
        });
      }
      if (
        current.server.state !== "installing" ||
        current.server.currentKeyGeneration !== 0 ||
        current.server.currentIdentityKeyId !== null ||
        current.server.currentScopeCertificateId !== null
      ) {
        throw new ServerSigningRepositoryConflictError(
          "initial bootstrap requires an uninstalled server",
        );
      }
      if (
        current.server.nextServerSignatureSeq !== parsed.expectedServerSignatureSeq ||
        maxFencingToken(transaction, parsed.fence.collaborationServerId) !==
          parsed.expectedFencingToken
      ) {
        throw new ServerSigningRepositoryConflictError(
          "initial bootstrap sequence or fencing counter compare-and-swap failed",
        );
      }
      if (parsed.expectedServerSignatureSeq >= Number.MAX_SAFE_INTEGER) {
        throw new ServerSigningRepositoryConflictError("server signer sequence is exhausted");
      }
      if (
        sqlGet(
          transaction,
          `SELECT bootstrap_signing_lease_id FROM server_bootstrap_signing_leases
           WHERE collaboration_server_id = ? AND state IN ('prepared', 'signed', 'installed')
           LIMIT 1`,
          [parsed.fence.collaborationServerId],
        ) !== undefined ||
        sqlGet(
          transaction,
          `SELECT signing_lease_id FROM server_signing_leases
           WHERE collaboration_server_id = ? AND state IN ('current', 'draining') LIMIT 1`,
          [parsed.fence.collaborationServerId],
        ) !== undefined
      ) {
        throw new ServerSigningRepositoryConflictError(
          "server already has an active signing lease",
        );
      }
      assertSigningKeyHandleAvailable(transaction, parsed.key.signingKeyRef);
      if (
        findIdentityKey(
          transaction,
          parsed.fence.collaborationServerId,
          parsed.key.identityKeyId,
        ) !== null
      ) {
        throw new ServerSigningRepositoryConflictError("server identity-key ID is occupied");
      }
      const { identityKey, envelope } = insertInitialKey(
        transaction,
        current.server,
        parsed,
        parsed.bootstrapIntent.preparedAtMs,
      );
      const bootstrapLease = parseServerBootstrapSigningLeaseRecord({
        bootstrapSigningLeaseId: parsed.bootstrapSigningLeaseId,
        collaborationServerId: parsed.fence.collaborationServerId,
        purpose: "initial_pair",
        operatorIntentEvidenceRef: parsed.operatorIntentEvidenceRef,
        operatorIntentEvidenceDigest: parsed.operatorIntentEvidenceDigest,
        expectedPriorScopeCertificateId: null,
        proposedIdentityKeyId: parsed.key.identityKeyId,
        proposedKeyGeneration: 1,
        proposedScopeCertificateId: parsed.proposedScopeCertificateId,
        signingKeyRef: parsed.key.signingKeyRef,
        coordinatorLeaseId: parsed.fence.coordinatorLeaseId,
        coordinatorEpoch: parsed.fence.coordinatorEpoch,
        fencingToken: nextFencingToken(parsed.expectedFencingToken),
        preparedAtMs: parsed.bootstrapIntent.preparedAtMs,
        signedAtMs: null,
        installedAtMs: null,
        closedAtMs: null,
        state: "prepared",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO server_bootstrap_signing_leases (
           bootstrap_signing_lease_id, collaboration_server_id, purpose,
           operator_intent_evidence_ref, operator_intent_evidence_digest,
           expected_prior_scope_certificate_id, proposed_identity_key_id,
           proposed_key_generation, proposed_scope_certificate_id, signing_key_ref,
           coordinator_lease_id, coordinator_epoch, fencing_token, prepared_at_ms,
           signed_at_ms, installed_at_ms, closed_at_ms, state
         ) VALUES (?, ?, 'initial_pair', ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?,
                   NULL, NULL, NULL, 'prepared')`,
        [
          bootstrapLease.bootstrapSigningLeaseId,
          bootstrapLease.collaborationServerId,
          bootstrapLease.operatorIntentEvidenceRef,
          bootstrapLease.operatorIntentEvidenceDigest,
          bootstrapLease.proposedIdentityKeyId,
          bootstrapLease.proposedScopeCertificateId,
          bootstrapLease.signingKeyRef,
          bootstrapLease.coordinatorLeaseId,
          bootstrapLease.coordinatorEpoch,
          bootstrapLease.fencingToken,
          bootstrapLease.preparedAtMs,
        ],
        "server bootstrap signing-lease insert",
      );
      const reservation = parseServerSignatureReservationRecord({
        collaborationServerId: parsed.fence.collaborationServerId,
        signerSequence: parsed.expectedServerSignatureSeq,
        signingLeaseId: parsed.bootstrapSigningLeaseId,
        signingLeaseKind: "bootstrap",
        purpose: "scope_certificate",
        canonicalPayloadSchemaId: null,
        canonicalPayloadRef: null,
        canonicalPayloadDigest: null,
        signedRecordDigest: null,
        signature: null,
        signedArtifactType: null,
        signedArtifactId: null,
        reservedAtMs: parsed.bootstrapIntent.preparedAtMs,
        boundAtMs: null,
        signedAtMs: null,
        abortedAtMs: null,
        state: "reserved",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO server_signature_reservations (
           collaboration_server_id, signer_sequence, signing_lease_id,
           signing_lease_kind, purpose, canonical_payload_schema_id,
           canonical_payload_ref, canonical_payload_digest, signed_record_digest,
           signature, signed_artifact_type, signed_artifact_id, reserved_at_ms,
           bound_at_ms, signed_at_ms, aborted_at_ms, state
         ) VALUES (?, ?, ?, 'bootstrap', 'scope_certificate', NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, 'reserved')`,
        [
          reservation.collaborationServerId,
          reservation.signerSequence,
          reservation.signingLeaseId,
          reservation.reservedAtMs,
        ],
        "bootstrap signature reservation insert",
      );
      return frozen({
        identityKey,
        privateKeyEnvelope: envelope,
        bootstrapLease,
        reservation,
        replayed: false,
      });
    });
  }

  bindInitialScopeCertificate(
    request: BindInitialServerScopeCertificateRequest,
  ): ServerSignatureMutationResult {
    return bindInitialScopeCertificateOperation(this.#executor, this.#nowMs, request);
  }

  storeInitialSignedScopeCertificate(
    request: StoreInitialServerScopeCertificateRequest,
  ): ServerSignatureMutationResult {
    return storeInitialSignedScopeCertificateOperation(this.#executor, this.#nowMs, request);
  }

  finalizeInitialBootstrap(
    request: FinalizeInitialServerSignerRequest,
  ): FinalizeInitialServerSignerResult {
    return finalizeInitialBootstrapOperation(this.#executor, this.#nowMs, request);
  }

  reconcileInitialBootstrap(
    request: ReconcileInitialServerSignerRequest,
  ): ServerSignerBootstrapReconciliation | null {
    const parsed = parseReconcileRequest(request);
    const serverId = parsed.prepare.fence.collaborationServerId;
    const bootstrapId = parsed.prepare.bootstrapSigningLeaseId;
    return this.#executor.transaction((transaction) => {
      const server = findServer(transaction, serverId);
      if (server === null || server.machineIdentityId !== this.#machineIdentityId) return null;
      const bootstrapLease = findBootstrap(transaction, serverId, bootstrapId);
      if (bootstrapLease === null) return null;
      const identityKey = findIdentityKey(
        transaction,
        serverId,
        bootstrapLease.proposedIdentityKeyId,
      );
      const privateKeyEnvelope = findEnvelope(transaction, bootstrapLease.signingKeyRef);
      const reservationRows = sqlAll(
        transaction,
        `SELECT ${RESERVATION_ROW_KEYS.join(", ")} FROM server_signature_reservations
         WHERE collaboration_server_id = ? AND signing_lease_id = ?
           AND signing_lease_kind = 'bootstrap' ORDER BY signer_sequence`,
        [serverId, bootstrapId],
      );
      if (identityKey === null || privateKeyEnvelope === null || reservationRows.length !== 1) {
        privateKeyEnvelope?.wrapNonce.destroy();
        privateKeyEnvelope?.wrappedPkcs8.destroy();
        privateKeyEnvelope?.authTag.destroy();
        throw new ServerSigningRepositoryPersistenceError(
          "bootstrap reconciliation graph is incomplete",
        );
      }
      try {
        const reservation = reservationFromRow(reservationRows[0]);
        assertBootstrapPrepareReplay(
          parsed.prepare,
          identityKey,
          privateKeyEnvelope,
          bootstrapLease,
          reservation,
        );
        assertBootstrapObservationWindow(transaction, bootstrapLease, reservation);
        const intentDigest = serverSignerBootstrapIntentDigest(parsed.prepare.bootstrapIntent);
        assertBootstrapIntentArtifact(
          transaction,
          parsed.prepare.bootstrapIntent,
          parsed.prepare.operatorIntentEvidenceRef,
          intentDigest,
        );
        const certificate = findCertificate(
          transaction,
          serverId,
          bootstrapLease.proposedScopeCertificateId,
        );
        const certificateStatus =
          certificate === null
            ? null
            : findStatus(transaction, serverId, bootstrapLease.proposedScopeCertificateId);
        const signingLease =
          parsed.finalize === null
            ? null
            : findSigningLease(transaction, serverId, parsed.finalize.signingLeaseId);
        const acceptance =
          certificate === null
            ? null
            : findAcceptanceBySignerSequence(transaction, serverId, certificate.signerSequence);
        const isPrepared = bootstrapLease.state === "prepared";
        const isSigned = bootstrapLease.state === "signed";
        const isClosed = bootstrapLease.state === "closed";
        if (
          reservation.signingLeaseId !== bootstrapId ||
          reservation.signingLeaseKind !== "bootstrap" ||
          reservation.purpose !== "scope_certificate" ||
          (!isPrepared && !isSigned && !isClosed) ||
          (isPrepared &&
            (certificate !== null ||
              certificateStatus !== null ||
              signingLease !== null ||
              acceptance !== null ||
              (reservation.state !== "reserved" && reservation.state !== "bound"))) ||
          (isSigned &&
            (certificate === null ||
              certificateStatus !== null ||
              signingLease !== null ||
              acceptance !== null ||
              reservation.state !== "signed")) ||
          (isClosed &&
            (certificate === null ||
              certificateStatus === null ||
              signingLease === null ||
              acceptance === null ||
              reservation.state !== "signed"))
        ) {
          privateKeyEnvelope.wrapNonce.destroy();
          privateKeyEnvelope.wrappedPkcs8.destroy();
          privateKeyEnvelope.authTag.destroy();
          throw new ServerSigningRepositoryPersistenceError(
            "bootstrap reconciliation graph is inconsistent",
          );
        }
        if (certificate !== null) {
          assertStoredInitialCertificateEvidence(
            transaction,
            server,
            bootstrapLease,
            identityKey,
            reservation,
            certificate,
          );
        }
        if (parsed.bind === null) {
          if (reservation.state !== "reserved") {
            privateKeyEnvelope.wrapNonce.destroy();
            privateKeyEnvelope.wrappedPkcs8.destroy();
            privateKeyEnvelope.authTag.destroy();
            throw new ServerSigningRepositoryConflictError(
              "bootstrap progressed beyond the reconciled prepare operation",
            );
          }
        } else {
          assertBootstrapBindReconciliation(
            transaction,
            server,
            bootstrapLease,
            identityKey,
            reservation,
            parsed.bind,
          );
        }
        if (parsed.store === null) {
          if (certificate !== null || reservation.state === "signed" || !isPrepared) {
            privateKeyEnvelope.wrapNonce.destroy();
            privateKeyEnvelope.wrappedPkcs8.destroy();
            privateKeyEnvelope.authTag.destroy();
            throw new ServerSigningRepositoryConflictError(
              "bootstrap progressed beyond the reconciled bind operation",
            );
          }
        } else {
          try {
            assertInitialCertificateCoordinates(
              server,
              bootstrapLease,
              identityKey,
              certificatePayload(parsed.store.certificate),
              reservation.signerSequence,
            );
            assertCertificateSignature(parsed.store.certificate, identityKey);
          } catch (error) {
            privateKeyEnvelope.wrapNonce.destroy();
            privateKeyEnvelope.wrappedPkcs8.destroy();
            privateKeyEnvelope.authTag.destroy();
            throw new ServerSigningRepositoryConflictError(
              `reconciled signed-store request is invalid: ${error instanceof Error ? error.message : "error"}`,
            );
          }
        }
        if (parsed.store !== null && certificate !== null) {
          assertSameCertificate(
            certificate,
            parsed.store.certificate,
            "reconciled signed bootstrap",
          );
          assertStoredInitialCertificateEvidence(
            transaction,
            server,
            bootstrapLease,
            identityKey,
            reservation,
            certificate,
          );
        } else if (
          parsed.store !== null &&
          (reservation.state === "signed" || isSigned || isClosed)
        ) {
          privateKeyEnvelope.wrapNonce.destroy();
          privateKeyEnvelope.wrappedPkcs8.destroy();
          privateKeyEnvelope.authTag.destroy();
          throw new ServerSigningRepositoryPersistenceError(
            "reconciled signed bootstrap is missing its immutable certificate",
          );
        }
        if (parsed.finalize === null) {
          if (
            isClosed ||
            certificateStatus !== null ||
            signingLease !== null ||
            acceptance !== null
          ) {
            privateKeyEnvelope.wrapNonce.destroy();
            privateKeyEnvelope.wrappedPkcs8.destroy();
            privateKeyEnvelope.authTag.destroy();
            throw new ServerSigningRepositoryConflictError(
              "bootstrap progressed beyond the reconciled signed-store operation",
            );
          }
        } else if (isClosed) {
          if (
            certificate === null ||
            certificateStatus === null ||
            signingLease === null ||
            acceptance === null ||
            parsed.store === null ||
            JSON.stringify(parsed.finalize.certificate) !== JSON.stringify(certificate) ||
            identityKey.state !== "current" ||
            identityKey.introducedByScopeCertificateId !== certificate.scopeCertificateId ||
            certificateStatus.state !== "current" ||
            certificateStatus.changeEvidenceRef !== bootstrapLease.operatorIntentEvidenceRef ||
            !sameDigest(
              certificateStatus.changeEvidenceDigest,
              bootstrapLease.operatorIntentEvidenceDigest,
            ) ||
            signingLease.identityKeyId !== identityKey.identityKeyId ||
            signingLease.keyGeneration !== identityKey.keyGeneration ||
            signingLease.scopeCertificateId !== certificate.scopeCertificateId ||
            signingLease.coordinatorLeaseId !== parsed.finalize.fence.coordinatorLeaseId ||
            signingLease.coordinatorEpoch !== parsed.finalize.fence.coordinatorEpoch ||
            signingLease.fencingToken !== parsed.finalize.fencingToken + 1 ||
            acceptance.acceptedAtJournalSeq !== 0 ||
            acceptance.signerIdentityKeyId !== identityKey.identityKeyId ||
            acceptance.signerKeyGeneration !== identityKey.keyGeneration ||
            acceptance.signerScopeCertificateId !== certificate.scopeCertificateId ||
            acceptance.signerSequence !== certificate.signerSequence ||
            reservation.signedRecordDigest === null ||
            !sameDigest(acceptance.signedRecordDigest, reservation.signedRecordDigest) ||
            server.state !== "current" ||
            server.currentIdentityKeyId !== identityKey.identityKeyId ||
            server.currentKeyGeneration !== identityKey.keyGeneration ||
            server.currentScopeCertificateId !== certificate.scopeCertificateId
          ) {
            privateKeyEnvelope.wrapNonce.destroy();
            privateKeyEnvelope.wrappedPkcs8.destroy();
            privateKeyEnvelope.authTag.destroy();
            throw new ServerSigningRepositoryPersistenceError(
              "closed bootstrap reconciliation graph does not match exact finalization",
            );
          }
        }
        const custodyCurrent =
          privateKeyEnvelope.state === "current" && privateKeyEnvelope.destroyedAtMs === null;
        const now = trustedNow(this.#nowMs);
        const bootstrapAuthorityCurrent =
          !isClosed &&
          hasEffectiveCoordinatorLease(
            transaction,
            server,
            bootstrapLease.coordinatorLeaseId,
            bootstrapLease.coordinatorEpoch,
            now,
          );
        const signingAuthorityCurrent =
          isClosed &&
          signingLease !== null &&
          signingLease.state === "current" &&
          hasEffectiveCoordinatorLease(
            transaction,
            server,
            signingLease.coordinatorLeaseId,
            signingLease.coordinatorEpoch,
            now,
          );
        const authorityCurrent =
          custodyCurrent && (bootstrapAuthorityCurrent || signingAuthorityCurrent);
        const nonWritableReason = !custodyCurrent
          ? "destroyed_key_custody"
          : isClosed
            ? signingAuthorityCurrent
              ? null
              : "stale_signing_lease_fence"
            : bootstrapAuthorityCurrent
              ? null
              : "stale_bootstrap_fence";
        const attemptedPhase =
          parsed.finalize !== null
            ? "finalize"
            : parsed.store !== null
              ? "store"
              : parsed.bind !== null
                ? "bind"
                : "prepare";
        const durablePhase = isClosed
          ? "finalize"
          : isSigned
            ? "store"
            : reservation.state === "bound"
              ? "bind"
              : "prepare";
        const phasePosition = {
          prepare: 0,
          bind: 1,
          store: 2,
          finalize: 3,
        } as const;
        return frozen({
          attemptedPhase,
          durablePhase,
          landed: phasePosition[durablePhase] >= phasePosition[attemptedPhase],
          authorityCurrent,
          writable: false,
          nonWritableReason: authorityCurrent ? "custody_unverified" : nonWritableReason,
          identityKey,
          privateKeyEnvelope,
          bootstrapLease,
          reservation,
          certificate,
          certificateStatus,
          signingLease,
          acceptance,
        });
      } catch (error) {
        privateKeyEnvelope.wrapNonce.destroy();
        privateKeyEnvelope.wrappedPkcs8.destroy();
        privateKeyEnvelope.authTag.destroy();
        throw error;
      }
    });
  }

  acquireCurrentSigningLease(
    request: AcquireCurrentServerSigningLeaseRequest,
  ): AcquireCurrentServerSigningLeaseResult {
    const parsed = parseAcquireRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentCoordinator(transaction, parsed.fence, this.#nowMs);
      if (
        current.server.machineIdentityId !== this.#machineIdentityId ||
        current.server.state !== "current" ||
        current.server.currentIdentityKeyId === null ||
        current.server.currentScopeCertificateId === null
      ) {
        throw new ServerSigningRepositoryConflictError(
          "current server signer pointers are unavailable",
        );
      }
      const existing = findSigningLease(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.signingLeaseId,
      );
      const predecessor = findSigningLease(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.expectedCurrentSigningLeaseId,
      );
      if (existing !== null) {
        if (
          predecessor === null ||
          predecessor.state !== "superseded" ||
          existing.state !== "current" ||
          existing.identityKeyId !== current.server.currentIdentityKeyId ||
          existing.keyGeneration !== current.server.currentKeyGeneration ||
          existing.scopeCertificateId !== current.server.currentScopeCertificateId ||
          existing.coordinatorLeaseId !== parsed.fence.coordinatorLeaseId ||
          existing.coordinatorEpoch !== parsed.fence.coordinatorEpoch ||
          existing.fencingToken !== parsed.expectedFencingToken + 1 ||
          predecessor.fencingToken !== parsed.expectedFencingToken
        ) {
          throw new ServerSigningRepositoryConflictError(
            "current signing-lease acquisition intent collided",
          );
        }
        return frozen({ signingLease: existing, predecessor, replayed: true });
      }
      if (
        predecessor === null ||
        predecessor.state !== "superseded" ||
        predecessor.fencingToken !== parsed.expectedFencingToken ||
        predecessor.identityKeyId !== current.server.currentIdentityKeyId ||
        predecessor.keyGeneration !== current.server.currentKeyGeneration ||
        predecessor.scopeCertificateId !== current.server.currentScopeCertificateId ||
        predecessor.coordinatorEpoch >= parsed.fence.coordinatorEpoch ||
        maxFencingToken(transaction, parsed.fence.collaborationServerId) !==
          parsed.expectedFencingToken
      ) {
        throw new ServerSigningRepositoryConflictError(
          "current signing-lease predecessor does not match takeover",
        );
      }
      if (
        sqlGet(
          transaction,
          `SELECT signer_sequence FROM server_signature_reservations
           WHERE collaboration_server_id = ? AND signing_lease_id = ?
             AND (
               state IN ('reserved', 'bound')
               OR (state = 'signed' AND NOT EXISTS (
                 SELECT 1 FROM server_signed_record_acceptances AS acceptance
                 WHERE acceptance.collaboration_server_id =
                         server_signature_reservations.collaboration_server_id
                   AND acceptance.signer_sequence =
                         server_signature_reservations.signer_sequence
                   AND acceptance.signed_record_digest =
                         server_signature_reservations.signed_record_digest
               ))
             ) LIMIT 1`,
          [parsed.fence.collaborationServerId, predecessor.signingLeaseId],
        ) !== undefined
      ) {
        throw new ServerSigningRepositoryConflictError(
          "predecessor signing lease has unfinished reservations",
        );
      }
      const signingLease = parseServerSigningLeaseRecord({
        signingLeaseId: parsed.signingLeaseId,
        collaborationServerId: parsed.fence.collaborationServerId,
        identityKeyId: current.server.currentIdentityKeyId,
        keyGeneration: current.server.currentKeyGeneration,
        scopeCertificateId: current.server.currentScopeCertificateId,
        coordinatorLeaseId: parsed.fence.coordinatorLeaseId,
        coordinatorEpoch: parsed.fence.coordinatorEpoch,
        fencingToken: nextFencingToken(parsed.expectedFencingToken),
        acquiredAtMs: current.nowMs,
        drainingAtMs: null,
        supersededAtMs: null,
        closedAtMs: null,
        state: "current",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO server_signing_leases (
           signing_lease_id, collaboration_server_id, identity_key_id, key_generation,
           scope_certificate_id, coordinator_lease_id, coordinator_epoch, fencing_token,
           acquired_at_ms, draining_at_ms, superseded_at_ms, closed_at_ms, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'current')`,
        [
          signingLease.signingLeaseId,
          signingLease.collaborationServerId,
          signingLease.identityKeyId,
          signingLease.keyGeneration,
          signingLease.scopeCertificateId,
          signingLease.coordinatorLeaseId,
          signingLease.coordinatorEpoch,
          signingLease.fencingToken,
          signingLease.acquiredAtMs,
        ],
        "replacement current signing-lease insert",
      );
      return frozen({ signingLease, predecessor, replayed: false });
    });
  }

  readInventory(collaborationServerId: CollaborationServerId): ServerSigningInventory {
    const serverId = parseA1CanonicalId(
      "collaborationServer",
      collaborationServerId,
      "serverSigningRepository.readInventory.collaborationServerId",
    );
    return this.#executor.transaction((transaction) => {
      const server = findServer(transaction, serverId);
      if (server === null || server.machineIdentityId !== this.#machineIdentityId) {
        throw new ServerSigningRepositoryConflictError("collaboration server is unavailable");
      }
      return readInventoryTransaction(transaction, serverId);
    });
  }
}

function validateServerSigningInventory(
  transaction: HostStateRepositorySqlTransaction,
  server: CollaborationServerRecord,
  inventory: ServerSigningInventory,
): void {
  if (server.nextCommandSeq !== 0) {
    throw new ServerSigningRepositoryPersistenceError(
      "signer-only schema contains a command-sequence allocation",
    );
  }
  if (
    inventory.identityKeys.length > 1 ||
    inventory.privateKeyEnvelopes.length > 1 ||
    inventory.scopeCertificates.length > 1 ||
    inventory.certificateStatuses.length > 1 ||
    inventory.bootstrapLeases.length > 1 ||
    inventory.reservations.length > 1 ||
    inventory.acceptances.length > 1
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "signer-only schema contains unsupported rotation or repair history",
    );
  }
  for (const [index, acceptance] of inventory.acceptances.entries()) {
    if (acceptance.acceptedAtJournalSeq !== index) {
      throw new ServerSigningRepositoryPersistenceError(
        "signed-record acceptance journal is not dense",
      );
    }
  }
  for (const reservation of inventory.reservations) {
    if (
      reservation.purpose !== "scope_certificate" ||
      reservation.signingLeaseKind !== "bootstrap"
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "signer-only schema contains a future signing purpose",
      );
    }
  }
  const lastReservation = inventory.reservations.at(-1);
  const expectedNextSequence =
    lastReservation === undefined ? 0 : lastReservation.signerSequence + 1;
  if (
    server.nextServerSignatureSeq !== expectedNextSequence ||
    inventory.reservations.some((reservation, index) => reservation.signerSequence !== index)
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "server signature reservation ledger is not exact and contiguous",
    );
  }
  const fencingTokens = [
    ...inventory.bootstrapLeases.map((lease) => lease.fencingToken),
    ...inventory.signingLeases.map((lease) => lease.fencingToken),
  ].sort((left, right) => left - right);
  if (fencingTokens.some((token, index) => token !== index + 1)) {
    throw new ServerSigningRepositoryPersistenceError(
      "server signing fencing-token history is not contiguous",
    );
  }
  if (inventory.identityKeys.length === 0) {
    if (
      inventory.privateKeyEnvelopes.length !== 0 ||
      inventory.scopeCertificates.length !== 0 ||
      inventory.certificateStatuses.length !== 0 ||
      inventory.bootstrapLeases.length !== 0 ||
      inventory.signingLeases.length !== 0 ||
      inventory.reservations.length !== 0 ||
      inventory.acceptances.length !== 0 ||
      server.state !== "installing" ||
      server.currentKeyGeneration !== 0 ||
      server.currentIdentityKeyId !== null ||
      server.currentScopeCertificateId !== null
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "empty server signer inventory has non-empty signing state",
      );
    }
    return;
  }
  const key = inventory.identityKeys[0];
  const envelope = inventory.privateKeyEnvelopes[0];
  const bootstrap = inventory.bootstrapLeases[0];
  const reservation = inventory.reservations[0];
  if (
    key === undefined ||
    envelope === undefined ||
    bootstrap === undefined ||
    reservation === undefined ||
    key.collaborationServerId !== server.collaborationServerId ||
    key.keyGeneration !== 1 ||
    envelope.collaborationServerId !== server.collaborationServerId ||
    envelope.identityKeyId !== key.identityKeyId ||
    envelope.keyGeneration !== key.keyGeneration ||
    envelope.signingKeyRef !== key.signingKeyRef ||
    envelope.state !== "current" ||
    envelope.destroyedAtMs !== null ||
    bootstrap.collaborationServerId !== server.collaborationServerId ||
    bootstrap.purpose !== "initial_pair" ||
    bootstrap.proposedIdentityKeyId !== key.identityKeyId ||
    bootstrap.proposedKeyGeneration !== key.keyGeneration ||
    bootstrap.signingKeyRef !== key.signingKeyRef ||
    key.trustEvidenceRef !== bootstrap.operatorIntentEvidenceRef ||
    !sameDigest(key.trustEvidenceDigest, bootstrap.operatorIntentEvidenceDigest) ||
    key.validFromMs !== bootstrap.preparedAtMs ||
    envelope.createdAtMs !== bootstrap.preparedAtMs ||
    reservation.collaborationServerId !== server.collaborationServerId ||
    reservation.signerSequence !== 0 ||
    reservation.signingLeaseId !== bootstrap.bootstrapSigningLeaseId ||
    reservation.reservedAtMs !== bootstrap.preparedAtMs
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "initial server signer key/bootstrap graph is inconsistent",
    );
  }
  const bootstrapCoordinator = assertBootstrapObservationWindow(
    transaction,
    bootstrap,
    reservation,
  );
  if (
    bootstrap.state !== "closed" &&
    (server.currentCoordinatorLeaseId !== bootstrap.coordinatorLeaseId ||
      server.currentCoordinatorEpoch !== bootstrap.coordinatorEpoch) &&
    bootstrap.coordinatorEpoch >= server.currentCoordinatorEpoch &&
    !(
      server.currentCoordinatorLeaseId === null &&
      server.currentCoordinatorEpoch === bootstrap.coordinatorEpoch &&
      bootstrapCoordinator.state === "released" &&
      bootstrapCoordinator.releasedAtMs !== null
    )
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "initial bootstrap coordinator fence or preparation time is inconsistent",
    );
  }
  const publicKeyBytes = base64urlDecode(key.publicKey);
  try {
    if (
      deriveServerIdentityKeyId(
        server.machineIdentityId,
        server.collaborationServerId,
        key.keyGeneration,
        publicKeyBytes,
      ) !== key.identityKeyId
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "server identity-key ID does not match its canonical binding",
      );
    }
  } finally {
    publicKeyBytes.fill(0);
  }
  const bootstrapIntent = parseServerSignerBootstrapIntentV1({
    schemaVersion: 1,
    canonicalPayloadSchemaId: SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
    machineIdentityId: server.machineIdentityId,
    collaborationServerId: server.collaborationServerId,
    bootstrapSigningLeaseId: bootstrap.bootstrapSigningLeaseId,
    purpose: "initial_pair",
    expectedPriorScopeCertificateId: null,
    proposedIdentityKeyId: bootstrap.proposedIdentityKeyId,
    proposedKeyGeneration: 1,
    proposedKeyAlgorithm: "Ed25519",
    proposedPublicKey: key.publicKey,
    proposedScopeCertificateId: bootstrap.proposedScopeCertificateId,
    signingKeyRef: bootstrap.signingKeyRef,
    preparedAtMs: bootstrap.preparedAtMs,
  });
  const bootstrapIntentDigest = serverSignerBootstrapIntentDigest(bootstrapIntent);
  if (!sameDigest(bootstrap.operatorIntentEvidenceDigest, bootstrapIntentDigest)) {
    throw new ServerSigningRepositoryPersistenceError(
      "bootstrap operator-intent digest does not match its exact tuple",
    );
  }
  try {
    assertBootstrapIntentArtifact(
      transaction,
      bootstrapIntent,
      bootstrap.operatorIntentEvidenceRef,
      bootstrapIntentDigest,
    );
  } catch (error) {
    throw new ServerSigningRepositoryPersistenceError(
      "bootstrap operator-intent artifact is invalid",
      { cause: error },
    );
  }
  const certificate = inventory.scopeCertificates[0] ?? null;
  const status = inventory.certificateStatuses[0] ?? null;
  const acceptance = inventory.acceptances[0] ?? null;
  if (bootstrap.state === "prepared") {
    if (
      server.state !== "installing" ||
      server.currentKeyGeneration !== 0 ||
      server.currentIdentityKeyId !== null ||
      server.currentScopeCertificateId !== null ||
      key.state !== "proposed" ||
      key.introducedByScopeCertificateId !== null ||
      certificate !== null ||
      status !== null ||
      acceptance !== null ||
      inventory.signingLeases.length !== 0 ||
      (reservation.state !== "reserved" && reservation.state !== "bound")
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "prepared initial bootstrap graph is inconsistent",
      );
    }
    if (reservation.state === "bound") {
      if (
        reservation.canonicalPayloadSchemaId !== SERVER_SCOPE_CERTIFICATE_SCHEMA_ID ||
        reservation.canonicalPayloadRef === null ||
        reservation.canonicalPayloadDigest === null ||
        reservation.signedArtifactType !== SERVER_SCOPE_CERTIFICATE_ARTIFACT_TYPE ||
        reservation.signedArtifactId !== bootstrap.proposedScopeCertificateId
      ) {
        throw new ServerSigningRepositoryPersistenceError(
          "bound initial bootstrap reservation has incomplete canonical coordinates",
        );
      }
      const boundPayload = readBoundScopeCertificatePayload(
        transaction,
        server.collaborationServerId,
        reservation.canonicalPayloadRef,
        reservation.canonicalPayloadDigest,
      );
      try {
        if (reservation.boundAtMs === null || boundPayload.issuedAtMs > reservation.boundAtMs) {
          throw new ServerSigningRepositoryConflictError(
            "bound certificate issue time exceeds its bind observation",
          );
        }
        assertInitialCertificateCoordinates(
          server,
          bootstrap,
          key,
          boundPayload,
          reservation.signerSequence,
        );
      } catch (error) {
        throw new ServerSigningRepositoryPersistenceError(
          "bound initial bootstrap payload does not match its exact signer coordinates",
          { cause: error },
        );
      }
    }
    return;
  }
  if (bootstrap.state === "signed") {
    if (
      server.state !== "installing" ||
      server.currentKeyGeneration !== 0 ||
      server.currentIdentityKeyId !== null ||
      server.currentScopeCertificateId !== null ||
      key.state !== "proposed" ||
      key.introducedByScopeCertificateId !== null ||
      certificate === null ||
      status !== null ||
      acceptance !== null ||
      inventory.signingLeases.length !== 0 ||
      reservation.state !== "signed"
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "signed initial bootstrap graph is inconsistent",
      );
    }
    assertStoredInitialCertificateEvidence(
      transaction,
      server,
      bootstrap,
      key,
      reservation,
      certificate,
    );
    return;
  }
  if (bootstrap.state !== "closed" || bootstrap.installedAtMs === null) {
    throw new ServerSigningRepositoryPersistenceError(
      "committed bootstrap has an unsupported terminal state",
    );
  }
  if (
    certificate === null ||
    status === null ||
    acceptance === null ||
    key.state !== "current" ||
    key.introducedByScopeCertificateId !== certificate.scopeCertificateId ||
    certificate.scopeCertificateId !== bootstrap.proposedScopeCertificateId ||
    certificate.subjectIdentityKeyId !== key.identityKeyId ||
    certificate.subjectPublicKey !== key.publicKey ||
    certificate.keyGeneration !== key.keyGeneration ||
    certificate.signerIdentityKeyId !== key.identityKeyId ||
    certificate.signerSequence !== reservation.signerSequence ||
    status.scopeCertificateId !== certificate.scopeCertificateId ||
    status.state !== "current" ||
    status.changeEvidenceRef !== bootstrap.operatorIntentEvidenceRef ||
    !sameDigest(status.changeEvidenceDigest, bootstrap.operatorIntentEvidenceDigest) ||
    reservation.state !== "signed" ||
    reservation.signedRecordDigest === null ||
    reservation.signature !== certificate.signature ||
    acceptance.signerSequence !== reservation.signerSequence ||
    acceptance.signerIdentityKeyId !== key.identityKeyId ||
    acceptance.signerKeyGeneration !== key.keyGeneration ||
    acceptance.signerScopeCertificateId !== certificate.scopeCertificateId ||
    acceptance.historicalReattestationId !== null ||
    !sameDigest(acceptance.signedRecordDigest, reservation.signedRecordDigest) ||
    server.state !== "current" ||
    server.currentKeyGeneration !== key.keyGeneration ||
    server.currentIdentityKeyId !== key.identityKeyId ||
    server.currentScopeCertificateId !== certificate.scopeCertificateId
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "installed initial signer graph is inconsistent",
    );
  }
  assertStoredInitialCertificateEvidence(
    transaction,
    server,
    bootstrap,
    key,
    reservation,
    certificate,
  );
  if (!sameDigest(signedCertificateDigest(certificate), acceptance.signedRecordDigest)) {
    throw new ServerSigningRepositoryPersistenceError(
      "installed certificate signed-record digest is invalid",
    );
  }
  if (inventory.signingLeases.length === 0) {
    throw new ServerSigningRepositoryPersistenceError(
      "current server has no normal signing-lease history",
    );
  }
  const initialSigningLease = inventory.signingLeases[0];
  if (
    initialSigningLease === undefined ||
    bootstrap.installedAtMs === null ||
    bootstrap.closedAtMs === null ||
    bootstrap.installedAtMs !== bootstrap.closedAtMs ||
    bootstrap.installedAtMs !== status.changedAtMs ||
    bootstrap.installedAtMs !== acceptance.acceptedAtMs ||
    bootstrap.installedAtMs !== initialSigningLease.acquiredAtMs ||
    certificate.issuedAtMs > bootstrap.installedAtMs
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "initial signer finalization timestamps are not one exact atomic observation",
    );
  }
  for (const [index, signingLease] of inventory.signingLeases.entries()) {
    const coordinatorRow = sqlGet(transaction, SELECT_COORDINATOR, [
      server.collaborationServerId,
      signingLease.coordinatorLeaseId,
    ]);
    if (coordinatorRow === undefined) {
      throw new ServerSigningRepositoryPersistenceError(
        "normal signing lease has no coordinator history",
      );
    }
    const coordinator = coordinatorFromRow(coordinatorRow);
    const predecessor = inventory.signingLeases[index - 1];
    const successor = inventory.signingLeases[index + 1];
    const predecessorCoordinatorRow =
      predecessor === undefined
        ? undefined
        : sqlGet(transaction, SELECT_COORDINATOR, [
            server.collaborationServerId,
            predecessor.coordinatorLeaseId,
          ]);
    const predecessorCoordinator =
      predecessorCoordinatorRow === undefined
        ? null
        : coordinatorFromRow(predecessorCoordinatorRow);
    const expectedPredecessorSupersededAtMs =
      predecessor === undefined || predecessorCoordinator === null
        ? null
        : Math.max(
            predecessor.acquiredAtMs,
            predecessorCoordinator.releasedAtMs ?? coordinator.acquiredAtMs,
          );
    if (
      signingLease.collaborationServerId !== server.collaborationServerId ||
      signingLease.identityKeyId !== key.identityKeyId ||
      signingLease.keyGeneration !== key.keyGeneration ||
      signingLease.scopeCertificateId !== certificate.scopeCertificateId ||
      signingLease.fencingToken !== bootstrap.fencingToken + index + 1 ||
      coordinator.collaborationServerId !== server.collaborationServerId ||
      coordinator.coordinatorLeaseId !== signingLease.coordinatorLeaseId ||
      coordinator.coordinatorEpoch !== signingLease.coordinatorEpoch ||
      signingLease.acquiredAtMs < coordinator.acquiredAtMs ||
      signingLease.acquiredAtMs >= coordinator.heartbeatDeadlineMs ||
      (coordinator.releasedAtMs !== null && signingLease.acquiredAtMs > coordinator.releasedAtMs) ||
      (index === 0 && signingLease.coordinatorEpoch !== bootstrap.coordinatorEpoch) ||
      (predecessor !== undefined &&
        (predecessorCoordinator === null ||
          signingLease.coordinatorEpoch <= predecessor.coordinatorEpoch ||
          signingLease.acquiredAtMs < predecessor.acquiredAtMs ||
          predecessor.state !== "superseded" ||
          predecessor.supersededAtMs === null ||
          predecessor.supersededAtMs !== expectedPredecessorSupersededAtMs ||
          predecessor.supersededAtMs > signingLease.acquiredAtMs)) ||
      (successor !== undefined && signingLease.state !== "superseded") ||
      (signingLease.state !== "current" && signingLease.state !== "superseded")
    ) {
      throw new ServerSigningRepositoryPersistenceError(
        "normal signing-lease history is not an exact monotonic fence chain",
      );
    }
  }
  const latestSigningLease = inventory.signingLeases.at(-1);
  if (latestSigningLease === undefined) {
    throw new ServerSigningRepositoryPersistenceError(
      "current server has no latest normal signing lease",
    );
  }
  const latestCoordinatorRow = sqlGet(transaction, SELECT_COORDINATOR, [
    server.collaborationServerId,
    latestSigningLease.coordinatorLeaseId,
  ]);
  const latestCoordinator =
    latestCoordinatorRow === undefined ? null : coordinatorFromRow(latestCoordinatorRow);
  const replacementCoordinatorRow =
    server.currentCoordinatorLeaseId === null ||
    server.currentCoordinatorLeaseId === latestSigningLease.coordinatorLeaseId
      ? undefined
      : sqlGet(transaction, SELECT_COORDINATOR, [
          server.collaborationServerId,
          server.currentCoordinatorLeaseId,
        ]);
  const replacementCoordinator =
    replacementCoordinatorRow === undefined ? null : coordinatorFromRow(replacementCoordinatorRow);
  const releasedWithoutSuccessor =
    latestCoordinator !== null &&
    server.currentCoordinatorLeaseId === null &&
    server.currentCoordinatorEpoch === latestSigningLease.coordinatorEpoch &&
    latestCoordinator.state === "released" &&
    latestCoordinator.releasedAtMs !== null;
  const expectedLatestSupersededAtMs =
    latestCoordinator === null
      ? null
      : latestCoordinator.releasedAtMs !== null
        ? Math.max(latestSigningLease.acquiredAtMs, latestCoordinator.releasedAtMs)
        : replacementCoordinator === null
          ? null
          : Math.max(latestSigningLease.acquiredAtMs, replacementCoordinator.acquiredAtMs);
  if (
    (latestSigningLease.state === "current" &&
      (latestCoordinator === null ||
        latestCoordinator.state !== "current" ||
        latestCoordinator.releasedAtMs !== null ||
        latestSigningLease.coordinatorLeaseId !== server.currentCoordinatorLeaseId ||
        latestSigningLease.coordinatorEpoch !== server.currentCoordinatorEpoch)) ||
    (latestSigningLease.state === "superseded" &&
      (latestSigningLease.supersededAtMs !== expectedLatestSupersededAtMs ||
        (latestSigningLease.coordinatorEpoch >= server.currentCoordinatorEpoch &&
          !releasedWithoutSuccessor)))
  ) {
    throw new ServerSigningRepositoryPersistenceError(
      "latest normal signing lease does not match current or takeover-pending authority",
    );
  }
}

/** Validate the complete signer-only v9 graph during secure-open snapshot validation. */
export function validateServerSigningRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
): void {
  const machineId = parseMachineIdentityId(machineIdentityId);
  const serverRows = sqlAll(
    transaction,
    `SELECT ${SERVER_ROW_KEYS.join(", ")} FROM collaboration_servers
     ORDER BY collaboration_server_id`,
  );
  for (const row of serverRows) {
    const server = serverFromRow(row);
    if (server.machineIdentityId !== machineId) {
      throw new ServerSigningRepositoryPersistenceError(
        "collaboration server belongs to another machine identity",
      );
    }
    const inventory = readInventoryTransaction(transaction, server.collaborationServerId);
    try {
      validateServerSigningInventory(transaction, server, inventory);
    } finally {
      destroyInventoryEnvelopes(inventory);
    }
  }
}

export function createServerSigningRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  nowMs: () => number = Date.now,
): ServerSigningRepositoryOperations {
  return new ServerSigningRepository(
    {
      transaction: <T>(operation: (active: HostStateRepositorySqlTransaction) => T): T =>
        operation(transaction),
    },
    machineIdentityId,
    nowMs,
  );
}

export function createServerSigningRepositoryOperations(
  executor: HostStateRepositoryTransactionExecutor,
  machineIdentityId: string,
  nowMs: () => number = Date.now,
): ServerSigningRepositoryOperations {
  return new ServerSigningRepository(executor, machineIdentityId, nowMs);
}
