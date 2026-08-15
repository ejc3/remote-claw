// Dormant A1.7b0 composition only. This module is intentionally absent from
// production barrels and run paths.

import { createHash } from "node:crypto";
import {
  base64urlEncode,
  canonicalServerScopeCertificatePayload,
  parseServerScopeCertificateCanonicalPayloadInput,
  parseServerScopeCertificateRecord,
  type ServerScopeCertificateCanonicalPayloadInput,
  type ServerScopeCertificateRecord,
} from "@remote-claw/clawsec";
import {
  type A1Digest,
  type CollaborationServerId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseMachineIdentityId,
} from "../state/ids.js";
import { ProtectedByteSnapshot } from "../state/protected.js";
import {
  encodeServerSignerBootstrapIntentV1,
  parseServerSignerBootstrapIntentV1,
  SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
  SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
  type ServerIdentityKeyRecord,
  type ServerIdentityPrivateKeyEnvelopeRecord,
  type ServerSignerBootstrapIntentV1,
  type ServerSigningInventory,
  type ServerSigningLeaseRecord,
  serverSignerBootstrapIntentDigest,
} from "../state/server-signing.js";
import type {
  AcquireCurrentServerSigningLeaseRequest,
  AcquireCurrentServerSigningLeaseResult,
  BindInitialServerScopeCertificateRequest,
  FinalizeInitialServerSignerRequest,
  FinalizeInitialServerSignerResult,
  PrepareInitialServerSignerRequest,
  ReconcileInitialServerSignerRequest,
  ServerSignerBootstrapReconciliation,
  StoreInitialServerScopeCertificateRequest,
} from "../state/server-signing-repository.js";
import {
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type HostStateTransaction,
} from "../state/sqlite.js";
import type {
  InitialServerSignerBootstrapRequest,
  ServerKeyCustodySigningCapability,
  WrappedServerPrivateKey,
} from "./service.js";

export const DORMANT_SERVER_SIGNER_PHASE_ATTEMPTS = 2 as const;

export type DormantServerSignerDatabase = Pick<
  HostStateDatabase,
  "machineIdentityId" | "serverSigning" | "transaction" | "close"
>;

export interface ResumeInitialServerSignerRequest extends InitialServerSignerBootstrapRequest {
  readonly database: DormantServerSignerDatabase;
  readonly reopenDatabase: () => DormantServerSignerDatabase;
  readonly custody: ServerKeyCustodySigningCapability;
}

export interface ResumeInitialServerSignerResult {
  readonly database: DormantServerSignerDatabase;
  readonly finalization: FinalizeInitialServerSignerResult;
  readonly signerWritable: boolean;
  readonly nonWritableReason: ServerSignerBootstrapReconciliation["nonWritableReason"];
  readonly resumedDurableBootstrap: boolean;
  readonly reconciledUnknownCommitCount: number;
}

export interface AcquireUsableServerSigningLeaseRequest {
  readonly database: DormantServerSignerDatabase;
  readonly reopenDatabase: () => DormantServerSignerDatabase;
  readonly custody: ServerKeyCustodySigningCapability;
  readonly machineIdentityId: string;
  readonly acquisition: AcquireCurrentServerSigningLeaseRequest;
}

export interface AcquireUsableServerSigningLeaseResult {
  readonly database: DormantServerSignerDatabase;
  readonly acquisition: AcquireCurrentServerSigningLeaseResult;
  readonly reconciledUnknownCommitCount: number;
}

export class DormantServerSignerRecoveryError extends Error {
  readonly code:
    | "DATABASE_CLOSE_FAILED"
    | "DATABASE_REOPEN_FAILED"
    | "UNKNOWN_COMMIT_NOT_SETTLED"
    | "DURABLE_GRAPH_MISMATCH"
    | "SIGNER_NON_WRITABLE";

  constructor(
    code:
      | "DATABASE_CLOSE_FAILED"
      | "DATABASE_REOPEN_FAILED"
      | "UNKNOWN_COMMIT_NOT_SETTLED"
      | "DURABLE_GRAPH_MISMATCH"
      | "SIGNER_NON_WRITABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`dormant server signer recovery failed: ${message}`, options);
    this.name = "DormantServerSignerRecoveryError";
    this.code = code;
  }
}

interface ParsedBootstrapRequest {
  readonly machineIdentityId: string;
  readonly collaborationServerId: CollaborationServerId;
  readonly coordinatorLeaseId: InitialServerSignerBootstrapRequest["coordinatorLeaseId"];
  readonly coordinatorEpoch: number;
  readonly bootstrapSigningLeaseId: InitialServerSignerBootstrapRequest["bootstrapSigningLeaseId"];
  readonly signingLeaseId: InitialServerSignerBootstrapRequest["signingLeaseId"];
  readonly signingKeyRef: InitialServerSignerBootstrapRequest["signingKeyRef"];
  readonly scopeCertificateId: InitialServerSignerBootstrapRequest["scopeCertificateId"];
  readonly preparedAtMs: number;
  readonly issuedAtMs: number;
  readonly expectedServerSignatureSeq: 0;
  readonly expectedFencingToken: 0;
}

interface MutableDatabaseState {
  database: DormantServerSignerDatabase;
  reconciledUnknownCommitCount: number;
}

function digestBytes(bytes: Uint8Array): A1Digest {
  return parseA1Digest(base64urlEncode(createHash("sha256").update(bytes).digest()));
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function parseBootstrapRequest(value: ResumeInitialServerSignerRequest): ParsedBootstrapRequest {
  const machineIdentityId = parseMachineIdentityId(value.machineIdentityId);
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    value.collaborationServerId,
    "serverSigner.collaborationServerId",
  );
  const coordinatorLeaseId = parseA1CanonicalId(
    "coordinatorLease",
    value.coordinatorLeaseId,
    "serverSigner.coordinatorLeaseId",
  );
  const coordinatorEpoch = positiveSafeInteger(
    value.coordinatorEpoch,
    "serverSigner.coordinatorEpoch",
  );
  const bootstrapSigningLeaseId = parseA1SafeId(
    value.bootstrapSigningLeaseId,
    "serverSigner.bootstrapSigningLeaseId",
  );
  const signingLeaseId = parseA1SafeId(value.signingLeaseId, "serverSigner.signingLeaseId");
  const signingKeyRef = parseA1CanonicalId(
    "protectedHandle",
    value.signingKeyRef,
    "serverSigner.signingKeyRef",
  );
  const scopeCertificateId = parseA1SafeId(
    value.scopeCertificateId,
    "serverSigner.scopeCertificateId",
  );
  const preparedAtMs = nonNegativeSafeInteger(value.preparedAtMs, "serverSigner.preparedAtMs");
  const issuedAtMs = nonNegativeSafeInteger(value.issuedAtMs, "serverSigner.issuedAtMs");
  if (
    issuedAtMs < preparedAtMs ||
    value.expectedServerSignatureSeq !== 0 ||
    value.expectedFencingToken !== 0
  ) {
    throw new TypeError("initial server signer bootstrap coordinates are invalid");
  }
  if (value.database.machineIdentityId !== machineIdentityId) {
    throw new TypeError("server signer database belongs to another machine identity");
  }
  return Object.freeze({
    machineIdentityId,
    collaborationServerId,
    coordinatorLeaseId,
    coordinatorEpoch,
    bootstrapSigningLeaseId,
    signingLeaseId,
    signingKeyRef,
    scopeCertificateId,
    preparedAtMs,
    issuedAtMs,
    expectedServerSignatureSeq: 0,
    expectedFencingToken: 0,
  });
}

function destroyEnvelope(value: {
  readonly wrapNonce: ProtectedByteSnapshot;
  readonly wrappedPkcs8: ProtectedByteSnapshot;
  readonly authTag: ProtectedByteSnapshot;
}): void {
  value.wrapNonce.destroy();
  value.wrappedPkcs8.destroy();
  value.authTag.destroy();
}

function destroyInventory(inventory: ServerSigningInventory): void {
  for (const envelope of inventory.privateKeyEnvelopes) destroyEnvelope(envelope);
}

function assertInventoryCustody(
  custody: ServerKeyCustodySigningCapability,
  machineIdentityId: string,
  inventory: ServerSigningInventory,
): void {
  const key = inventory.identityKeys[0];
  const envelope = inventory.privateKeyEnvelopes[0];
  if (key === undefined || envelope === undefined) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the current server signer has no retained key custody",
    );
  }
  try {
    custody.assertUsable(wrappedEnvelope(machineIdentityId, key, envelope));
  } catch (error) {
    throw new DormantServerSignerRecoveryError(
      "SIGNER_NON_WRITABLE",
      "the retained server private-key envelope is unusable under the current custody root",
      { cause: error },
    );
  }
}

function wrappedEnvelope(
  machineIdentityId: string,
  key: ServerIdentityKeyRecord,
  envelope: ServerIdentityPrivateKeyEnvelopeRecord,
): WrappedServerPrivateKey {
  return Object.freeze({
    wrappingSchemaId: envelope.wrappingSchemaId,
    binding: Object.freeze({
      machineIdentityId,
      collaborationServerId: key.collaborationServerId,
      identityKeyId: key.identityKeyId,
      keyGeneration: key.keyGeneration,
      algorithm: "Ed25519",
      publicKey: key.publicKey,
      signingKeyRef: key.signingKeyRef,
      custodyBackend: "owned-file",
    }),
    wrapNonce: envelope.wrapNonce,
    wrappedPkcs8: envelope.wrappedPkcs8,
    authTag: envelope.authTag,
    pkcs8Digest: envelope.pkcs8Digest,
  });
}

function bootstrapIntent(
  request: ParsedBootstrapRequest,
  key: Pick<WrappedServerPrivateKey["binding"], "identityKeyId" | "publicKey">,
): ServerSignerBootstrapIntentV1 {
  return parseServerSignerBootstrapIntentV1({
    schemaVersion: 1,
    canonicalPayloadSchemaId: SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
    machineIdentityId: request.machineIdentityId,
    collaborationServerId: request.collaborationServerId,
    bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
    purpose: "initial_pair",
    expectedPriorScopeCertificateId: null,
    proposedIdentityKeyId: key.identityKeyId,
    proposedKeyGeneration: 1,
    proposedKeyAlgorithm: "Ed25519",
    proposedPublicKey: key.publicKey,
    proposedScopeCertificateId: request.scopeCertificateId,
    signingKeyRef: request.signingKeyRef,
    preparedAtMs: request.preparedAtMs,
  });
}

function certificatePayload(
  request: ParsedBootstrapRequest,
  key: Pick<WrappedServerPrivateKey["binding"], "identityKeyId" | "publicKey">,
): ServerScopeCertificateCanonicalPayloadInput {
  return parseServerScopeCertificateCanonicalPayloadInput({
    schemaVersion: 1,
    canonicalPayloadSchemaId: SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
    scopeCertificateId: request.scopeCertificateId,
    collaborationServerId: request.collaborationServerId,
    machineIdentityId: request.machineIdentityId,
    subjectIdentityKeyId: key.identityKeyId,
    subjectKeyAlgorithm: "Ed25519",
    subjectPublicKey: key.publicKey,
    keyGeneration: 1,
    issuedAtMs: request.issuedAtMs,
    supersedesScopeCertificateId: null,
    signerIdentityKeyId: key.identityKeyId,
    signerSequence: 0,
    supersededSignerMaxSequence: null,
    signatureAlgorithm: "Ed25519",
    canonicalPayloadDigestAlgorithm: "SHA-256",
  });
}

function prepareRequest(
  request: ParsedBootstrapRequest,
  intent: ServerSignerBootstrapIntentV1,
  evidenceRef: PrepareInitialServerSignerRequest["operatorIntentEvidenceRef"],
  evidenceDigest: A1Digest,
  envelope: WrappedServerPrivateKey,
): PrepareInitialServerSignerRequest {
  return Object.freeze({
    fence: Object.freeze({
      collaborationServerId: request.collaborationServerId,
      coordinatorLeaseId: request.coordinatorLeaseId,
      coordinatorEpoch: request.coordinatorEpoch,
    }),
    bootstrapIntent: intent,
    bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
    operatorIntentEvidenceRef: evidenceRef,
    operatorIntentEvidenceDigest: evidenceDigest,
    proposedScopeCertificateId: request.scopeCertificateId,
    expectedServerSignatureSeq: 0,
    expectedFencingToken: 0,
    key: Object.freeze({
      identityKeyId: envelope.binding.identityKeyId,
      publicKey: parseEd25519PublicKey(envelope.binding.publicKey),
      signingKeyRef: request.signingKeyRef,
      wrappingSchemaId: envelope.wrappingSchemaId,
      wrapNonce: envelope.wrapNonce,
      wrappedPkcs8: envelope.wrappedPkcs8,
      authTag: envelope.authTag,
      pkcs8Digest: envelope.pkcs8Digest,
    }),
  });
}

function bundle(
  prepare: PrepareInitialServerSignerRequest,
  bind: BindInitialServerScopeCertificateRequest | null = null,
  store: StoreInitialServerScopeCertificateRequest | null = null,
  finalize: FinalizeInitialServerSignerRequest | null = null,
): ReconcileInitialServerSignerRequest {
  return Object.freeze({ prepare, bind, store, finalize });
}

function closeAndReopen(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantServerSignerDatabase,
): void {
  try {
    state.database.close();
  } catch (error) {
    throw new DormantServerSignerRecoveryError(
      "DATABASE_CLOSE_FAILED",
      "the poisoned database could not be closed",
      { cause: error },
    );
  }
  try {
    state.database = reopenDatabase();
  } catch (error) {
    throw new DormantServerSignerRecoveryError(
      "DATABASE_REOPEN_FAILED",
      "the database could not be securely reopened",
      { cause: error },
    );
  }
  state.reconciledUnknownCommitCount += 1;
}

function assertReconciledCustody(
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  reconciliation: ServerSignerBootstrapReconciliation,
): void {
  const wrapped = wrappedEnvelope(
    request.machineIdentityId,
    reconciliation.identityKey,
    reconciliation.privateKeyEnvelope,
  );
  try {
    custody.assertUsable(wrapped);
  } catch (error) {
    throw new DormantServerSignerRecoveryError(
      "SIGNER_NON_WRITABLE",
      "the retained server private-key envelope is unusable under the current custody root",
      { cause: error },
    );
  }
}

function reconcileAfterUnknownCommit(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantServerSignerDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  exact: ReconcileInitialServerSignerRequest,
): boolean {
  closeAndReopen(state, reopenDatabase);
  const reconciliation = state.database.serverSigning.reconcileInitialBootstrap(exact);
  if (reconciliation === null) return false;
  try {
    assertReconciledCustody(custody, request, reconciliation);
    if (!reconciliation.authorityCurrent && reconciliation.bootstrapLease.state !== "closed") {
      throw new DormantServerSignerRecoveryError(
        "SIGNER_NON_WRITABLE",
        reconciliation.nonWritableReason ?? "the bootstrap authority is no longer current",
      );
    }
    return reconciliation.landed;
  } finally {
    destroyEnvelope(reconciliation.privateKeyEnvelope);
  }
}

function applyPhase(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantServerSignerDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  operation: (
    database: DormantServerSignerDatabase,
    capture: (exact: ReconcileInitialServerSignerRequest) => void,
  ) => void,
): void {
  for (let attempt = 1; attempt <= DORMANT_SERVER_SIGNER_PHASE_ATTEMPTS; attempt++) {
    let exact: ReconcileInitialServerSignerRequest | null = null;
    try {
      operation(state.database, (captured) => {
        exact = captured;
      });
      return;
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      if (exact === null) {
        throw new DormantServerSignerRecoveryError(
          "DURABLE_GRAPH_MISMATCH",
          "a COMMIT became unknown before the exact phase request was captured",
          { cause: error },
        );
      }
      if (reconcileAfterUnknownCommit(state, reopenDatabase, custody, request, exact)) {
        return;
      }
      if (attempt === DORMANT_SERVER_SIGNER_PHASE_ATTEMPTS) {
        throw new DormantServerSignerRecoveryError(
          "UNKNOWN_COMMIT_NOT_SETTLED",
          "the exact signer phase was repeatedly proved absent",
          { cause: error },
        );
      }
    }
  }
}

function prepareEmptySigner(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantServerSignerDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
): void {
  const envelope = custody.generateIdentityKey(
    request.machineIdentityId,
    request.collaborationServerId,
    request.signingKeyRef,
    1,
  );
  try {
    custody.assertUsable(envelope);
    const intent = bootstrapIntent(request, envelope.binding);
    const intentDigest = serverSignerBootstrapIntentDigest(intent);
    const intentBytes = encodeServerSignerBootstrapIntentV1(intent);
    try {
      applyPhase(state, reopenDatabase, custody, request, (database, capture) => {
        const snapshot = ProtectedByteSnapshot.from(intentBytes);
        try {
          database.transaction((transaction: HostStateTransaction) => {
            const artifact = transaction.putArtifact({
              scopeKind: "collaboration_server",
              scopeId: request.collaborationServerId,
              artifactSchemaId: SERVER_SIGNER_BOOTSTRAP_INTENT_SCHEMA_ID,
              artifactDigest: intentDigest,
              artifactBytes: snapshot,
            });
            const prepare = prepareRequest(
              request,
              intent,
              artifact.artifactRef.protectedHandleId,
              artifact.artifactDigest,
              envelope,
            );
            capture(bundle(prepare));
            transaction.serverSigning.prepareInitialBootstrap(prepare);
          });
        } finally {
          snapshot.destroy();
        }
      });
    } finally {
      intentBytes.fill(0);
    }
  } finally {
    destroyEnvelope(envelope);
  }
}

function prepareFromInventory(
  request: ParsedBootstrapRequest,
  inventory: ServerSigningInventory,
): Readonly<{
  prepare: PrepareInitialServerSignerRequest;
  payload: ServerScopeCertificateCanonicalPayloadInput;
  wrapped: WrappedServerPrivateKey;
}> {
  const key = inventory.identityKeys[0];
  const envelope = inventory.privateKeyEnvelopes[0];
  const bootstrap = inventory.bootstrapLeases[0];
  const reservation = inventory.reservations[0];
  if (
    key === undefined ||
    envelope === undefined ||
    bootstrap === undefined ||
    reservation === undefined
  ) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the retained initial signer graph is incomplete",
    );
  }
  const wrapped = wrappedEnvelope(request.machineIdentityId, key, envelope);
  const intent = bootstrapIntent(request, wrapped.binding);
  const prepare = prepareRequest(
    request,
    intent,
    bootstrap.operatorIntentEvidenceRef,
    bootstrap.operatorIntentEvidenceDigest,
    wrapped,
  );
  if (
    bootstrap.bootstrapSigningLeaseId !== request.bootstrapSigningLeaseId ||
    bootstrap.coordinatorLeaseId !== request.coordinatorLeaseId ||
    bootstrap.coordinatorEpoch !== request.coordinatorEpoch ||
    bootstrap.proposedScopeCertificateId !== request.scopeCertificateId ||
    bootstrap.signingKeyRef !== request.signingKeyRef ||
    bootstrap.preparedAtMs !== request.preparedAtMs ||
    reservation.signerSequence !== 0
  ) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the stable bootstrap request does not match the retained signer graph",
    );
  }
  return Object.freeze({
    prepare,
    payload: certificatePayload(request, wrapped.binding),
    wrapped,
  });
}

function bindReservedPayload(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantServerSignerDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  prepare: PrepareInitialServerSignerRequest,
  payload: ServerScopeCertificateCanonicalPayloadInput,
): void {
  const bytes = canonicalServerScopeCertificatePayload(payload);
  const payloadDigest = digestBytes(bytes);
  try {
    applyPhase(state, reopenDatabase, custody, request, (database, capture) => {
      const snapshot = ProtectedByteSnapshot.from(bytes);
      try {
        database.transaction((transaction: HostStateTransaction) => {
          const artifact = transaction.putArtifact({
            scopeKind: "collaboration_server",
            scopeId: request.collaborationServerId,
            artifactSchemaId: SERVER_SCOPE_CERTIFICATE_SCHEMA_ID,
            artifactDigest: payloadDigest,
            artifactBytes: snapshot,
          });
          const bindRequest: BindInitialServerScopeCertificateRequest = Object.freeze({
            fence: prepare.fence,
            bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
            fencingToken: 1,
            signerSequence: 0,
            canonicalPayloadRef: artifact.artifactRef.protectedHandleId,
            certificatePayload: payload,
          });
          capture(bundle(prepare, bindRequest));
          transaction.serverSigning.bindInitialScopeCertificate(bindRequest);
        });
      } finally {
        snapshot.destroy();
      }
    });
  } finally {
    bytes.fill(0);
  }
}

function bindRequestFromInventory(
  request: ParsedBootstrapRequest,
  prepare: PrepareInitialServerSignerRequest,
  payload: ServerScopeCertificateCanonicalPayloadInput,
  inventory: ServerSigningInventory,
): BindInitialServerScopeCertificateRequest {
  const reservation = inventory.reservations[0];
  if (
    reservation === undefined ||
    reservation.canonicalPayloadRef === null ||
    reservation.signerSequence !== 0
  ) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the bound signer reservation has incomplete payload coordinates",
    );
  }
  return Object.freeze({
    fence: prepare.fence,
    bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
    fencingToken: 1,
    signerSequence: 0,
    canonicalPayloadRef: parseA1CanonicalId("protectedHandle", reservation.canonicalPayloadRef),
    certificatePayload: payload,
  });
}

function signedCertificate(
  custody: ServerKeyCustodySigningCapability,
  wrapped: WrappedServerPrivateKey,
  payload: ServerScopeCertificateCanonicalPayloadInput,
): ServerScopeCertificateRecord {
  const bytes = canonicalServerScopeCertificatePayload(payload);
  const snapshot = ProtectedByteSnapshot.from(bytes);
  let signatureSnapshot: ProtectedByteSnapshot | undefined;
  let signatureBytes: Uint8Array | undefined;
  try {
    signatureSnapshot = custody.sign(wrapped, snapshot);
    signatureBytes = signatureSnapshot.copyBytes();
    return parseServerScopeCertificateRecord({
      ...payload,
      canonicalPayloadDigest: digestBytes(bytes),
      signature: base64urlEncode(signatureBytes),
    });
  } finally {
    signatureBytes?.fill(0);
    signatureSnapshot?.destroy();
    snapshot.destroy();
    bytes.fill(0);
  }
}

function storeBoundCertificate(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantServerSignerDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  prepare: PrepareInitialServerSignerRequest,
  bindRequest: BindInitialServerScopeCertificateRequest,
  payload: ServerScopeCertificateCanonicalPayloadInput,
): void {
  let certificate: ServerScopeCertificateRecord | null = null;
  applyPhase(state, reopenDatabase, custody, request, (database, capture) => {
    database.transaction((transaction) => {
      const reconciliation = transaction.serverSigning.reconcileInitialBootstrap(
        bundle(prepare, bindRequest),
      );
      if (reconciliation === null || !reconciliation.landed) {
        throw new DormantServerSignerRecoveryError(
          "DURABLE_GRAPH_MISMATCH",
          "the bound bootstrap could not be reconciled before signing",
        );
      }
      try {
        if (!reconciliation.authorityCurrent) {
          throw new DormantServerSignerRecoveryError(
            "SIGNER_NON_WRITABLE",
            reconciliation.nonWritableReason ?? "stale_bootstrap_fence",
          );
        }
        assertReconciledCustody(custody, request, reconciliation);
        const retainedCertificate =
          certificate ??
          signedCertificate(
            custody,
            wrappedEnvelope(
              request.machineIdentityId,
              reconciliation.identityKey,
              reconciliation.privateKeyEnvelope,
            ),
            payload,
          );
        certificate = retainedCertificate;
        const storeRequest: StoreInitialServerScopeCertificateRequest = Object.freeze({
          fence: prepare.fence,
          bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
          fencingToken: 1,
          certificate: retainedCertificate,
        });
        capture(bundle(prepare, bindRequest, storeRequest));
        transaction.serverSigning.storeInitialSignedScopeCertificate(storeRequest);
      } finally {
        destroyEnvelope(reconciliation.privateKeyEnvelope);
      }
    });
  });
}

function finalizeSignedCertificate(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantServerSignerDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  prepare: PrepareInitialServerSignerRequest,
  bindRequest: BindInitialServerScopeCertificateRequest,
  certificate: ServerScopeCertificateRecord,
): void {
  const storeRequest: StoreInitialServerScopeCertificateRequest = Object.freeze({
    fence: prepare.fence,
    bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
    fencingToken: 1,
    certificate,
  });
  const finalizeRequest: FinalizeInitialServerSignerRequest = Object.freeze({
    fence: prepare.fence,
    bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
    fencingToken: 1,
    signingLeaseId: request.signingLeaseId,
    certificate,
  });
  applyPhase(state, reopenDatabase, custody, request, (database, capture) => {
    capture(bundle(prepare, bindRequest, storeRequest, finalizeRequest));
    database.transaction((transaction) => {
      transaction.serverSigning.finalizeInitialBootstrap(finalizeRequest);
    });
  });
}

function finalReconciliation(
  state: MutableDatabaseState,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  inventory: ServerSigningInventory,
  prepare: PrepareInitialServerSignerRequest,
  payload: ServerScopeCertificateCanonicalPayloadInput,
): ServerSignerBootstrapReconciliation {
  const certificate = inventory.scopeCertificates[0];
  if (certificate === undefined) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the closed bootstrap has no retained scope certificate",
    );
  }
  const bindRequest = bindRequestFromInventory(request, prepare, payload, inventory);
  const storeRequest: StoreInitialServerScopeCertificateRequest = Object.freeze({
    fence: prepare.fence,
    bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
    fencingToken: 1,
    certificate,
  });
  const finalizeRequest: FinalizeInitialServerSignerRequest = Object.freeze({
    fence: prepare.fence,
    bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
    fencingToken: 1,
    signingLeaseId: request.signingLeaseId,
    certificate,
  });
  const reconciliation = state.database.serverSigning.reconcileInitialBootstrap(
    bundle(prepare, bindRequest, storeRequest, finalizeRequest),
  );
  if (reconciliation === null || !reconciliation.landed) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the closed bootstrap could not be reconciled exactly",
    );
  }
  try {
    assertReconciledCustody(custody, request, reconciliation);
    return Object.freeze({
      ...reconciliation,
      writable: reconciliation.authorityCurrent,
      nonWritableReason: reconciliation.authorityCurrent ? null : reconciliation.nonWritableReason,
    });
  } catch (error) {
    destroyEnvelope(reconciliation.privateKeyEnvelope);
    throw error;
  }
}

function assertActiveBootstrapAuthority(
  state: MutableDatabaseState,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedBootstrapRequest,
  inventory: ServerSigningInventory,
  prepare: PrepareInitialServerSignerRequest,
  payload: ServerScopeCertificateCanonicalPayloadInput,
): void {
  const reservation = inventory.reservations[0];
  if (reservation === undefined) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the active bootstrap has no retained signature reservation",
    );
  }
  const bindRequest =
    reservation.state === "reserved"
      ? null
      : bindRequestFromInventory(request, prepare, payload, inventory);
  const certificate = inventory.scopeCertificates[0] ?? null;
  const storeRequest =
    reservation.state === "signed" && certificate !== null
      ? Object.freeze({
          fence: prepare.fence,
          bootstrapSigningLeaseId: request.bootstrapSigningLeaseId,
          fencingToken: 1,
          certificate,
        })
      : null;
  const reconciliation = state.database.serverSigning.reconcileInitialBootstrap(
    bundle(prepare, bindRequest, storeRequest),
  );
  if (reconciliation === null || !reconciliation.landed) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the active bootstrap could not be reconciled exactly",
    );
  }
  try {
    assertReconciledCustody(custody, request, reconciliation);
    if (!reconciliation.authorityCurrent) {
      throw new DormantServerSignerRecoveryError(
        "SIGNER_NON_WRITABLE",
        reconciliation.nonWritableReason ?? "stale_bootstrap_fence",
      );
    }
  } finally {
    destroyEnvelope(reconciliation.privateKeyEnvelope);
  }
}

/**
 * Install or resume the one initial server signer. Every artifact and its phase
 * mutation share one synchronous transaction. Unknown COMMIT outcomes are
 * closed/reopened and reconciled before any exact retry.
 */
export function resumeInitialServerSigner(
  value: ResumeInitialServerSignerRequest,
): ResumeInitialServerSignerResult {
  const request = parseBootstrapRequest(value);
  const state: MutableDatabaseState = {
    database: value.database,
    reconciledUnknownCommitCount: 0,
  };
  let resumedDurableBootstrap = false;
  let firstInventoryRead = true;
  for (;;) {
    const inventory = state.database.serverSigning.readInventory(request.collaborationServerId);
    try {
      if (inventory.identityKeys.length === 0) {
        firstInventoryRead = false;
        prepareEmptySigner(state, value.reopenDatabase, value.custody, request);
        continue;
      }
      if (firstInventoryRead) resumedDurableBootstrap = true;
      firstInventoryRead = false;
      const retained = prepareFromInventory(request, inventory);
      try {
        value.custody.assertUsable(retained.wrapped);
      } catch (error) {
        throw new DormantServerSignerRecoveryError(
          "SIGNER_NON_WRITABLE",
          "the retained server private-key envelope is unusable under the current custody root",
          { cause: error },
        );
      }
      const bootstrap = inventory.bootstrapLeases[0];
      const reservation = inventory.reservations[0];
      if (bootstrap === undefined || reservation === undefined) {
        throw new DormantServerSignerRecoveryError(
          "DURABLE_GRAPH_MISMATCH",
          "the retained initial signer graph has no bootstrap reservation",
        );
      }
      if (bootstrap.state === "closed") {
        const reconciliation = finalReconciliation(
          state,
          value.custody,
          request,
          inventory,
          retained.prepare,
          retained.payload,
        );
        try {
          if (
            reconciliation.certificate === null ||
            reconciliation.certificateStatus === null ||
            reconciliation.signingLease === null ||
            reconciliation.acceptance === null
          ) {
            throw new DormantServerSignerRecoveryError(
              "DURABLE_GRAPH_MISMATCH",
              "the closed bootstrap reconciliation is incomplete",
            );
          }
          return Object.freeze({
            database: state.database,
            finalization: Object.freeze({
              certificate: reconciliation.certificate,
              identityKey: reconciliation.identityKey,
              certificateStatus: reconciliation.certificateStatus,
              bootstrapLease: reconciliation.bootstrapLease,
              signingLease: reconciliation.signingLease,
              reservation: reconciliation.reservation,
              acceptance: reconciliation.acceptance,
              replayed: true,
            }),
            signerWritable: reconciliation.writable,
            nonWritableReason: reconciliation.nonWritableReason,
            resumedDurableBootstrap,
            reconciledUnknownCommitCount: state.reconciledUnknownCommitCount,
          });
        } finally {
          destroyEnvelope(reconciliation.privateKeyEnvelope);
        }
      }
      assertActiveBootstrapAuthority(
        state,
        value.custody,
        request,
        inventory,
        retained.prepare,
        retained.payload,
      );
      if (reservation.state === "reserved") {
        bindReservedPayload(
          state,
          value.reopenDatabase,
          value.custody,
          request,
          retained.prepare,
          retained.payload,
        );
        continue;
      }
      const bindRequest = bindRequestFromInventory(
        request,
        retained.prepare,
        retained.payload,
        inventory,
      );
      if (reservation.state === "bound") {
        storeBoundCertificate(
          state,
          value.reopenDatabase,
          value.custody,
          request,
          retained.prepare,
          bindRequest,
          retained.payload,
        );
        continue;
      }
      if (reservation.state === "signed" && bootstrap.state === "signed") {
        const certificate = inventory.scopeCertificates[0];
        if (certificate === undefined) {
          throw new DormantServerSignerRecoveryError(
            "DURABLE_GRAPH_MISMATCH",
            "the signed bootstrap has no immutable scope certificate",
          );
        }
        finalizeSignedCertificate(
          state,
          value.reopenDatabase,
          value.custody,
          request,
          retained.prepare,
          bindRequest,
          certificate,
        );
        continue;
      }
      throw new DormantServerSignerRecoveryError(
        "DURABLE_GRAPH_MISMATCH",
        "the initial signer has an unsupported durable phase",
      );
    } finally {
      destroyInventory(inventory);
    }
  }
}

function exactAcquiredLease(
  leases: readonly ServerSigningLeaseRecord[],
  request: AcquireCurrentServerSigningLeaseRequest,
): AcquireCurrentServerSigningLeaseResult | null {
  const candidate = leases.find((lease) => lease.signingLeaseId === request.signingLeaseId);
  if (candidate === undefined) return null;
  const predecessor = leases.find(
    (lease) => lease.signingLeaseId === request.expectedCurrentSigningLeaseId,
  );
  if (
    predecessor === undefined ||
    predecessor.fencingToken !== request.expectedFencingToken ||
    predecessor.state !== "superseded" ||
    candidate.collaborationServerId !== request.fence.collaborationServerId ||
    candidate.coordinatorLeaseId !== request.fence.coordinatorLeaseId ||
    candidate.coordinatorEpoch !== request.fence.coordinatorEpoch ||
    candidate.fencingToken !== request.expectedFencingToken + 1 ||
    candidate.state !== "current" ||
    candidate.identityKeyId !== predecessor.identityKeyId ||
    candidate.keyGeneration !== predecessor.keyGeneration ||
    candidate.scopeCertificateId !== predecessor.scopeCertificateId
  ) {
    throw new DormantServerSignerRecoveryError(
      "DURABLE_GRAPH_MISMATCH",
      "the retained successor signing lease collides with its exact takeover request",
    );
  }
  return Object.freeze({ signingLease: candidate, predecessor, replayed: true });
}

function readCustodyQualifiedAcquisition(
  database: DormantServerSignerDatabase,
  custody: ServerKeyCustodySigningCapability,
  machineIdentityId: string,
  request: AcquireCurrentServerSigningLeaseRequest,
): AcquireCurrentServerSigningLeaseResult | null {
  const inventory = database.serverSigning.readInventory(request.fence.collaborationServerId);
  try {
    assertInventoryCustody(custody, machineIdentityId, inventory);
    return exactAcquiredLease(inventory.signingLeases, request);
  } finally {
    destroyInventory(inventory);
  }
}

/**
 * Acquire or replay the exact next takeover lease only after the retained key
 * envelope self-tests under the process's current custody root.
 */
export function acquireUsableServerSigningLease(
  value: AcquireUsableServerSigningLeaseRequest,
): AcquireUsableServerSigningLeaseResult {
  const machineIdentityId = parseMachineIdentityId(value.machineIdentityId);
  const request: AcquireCurrentServerSigningLeaseRequest = Object.freeze({
    fence: Object.freeze({
      collaborationServerId: parseA1CanonicalId(
        "collaborationServer",
        value.acquisition.fence.collaborationServerId,
      ),
      coordinatorLeaseId: parseA1CanonicalId(
        "coordinatorLease",
        value.acquisition.fence.coordinatorLeaseId,
      ),
      coordinatorEpoch: positiveSafeInteger(
        value.acquisition.fence.coordinatorEpoch,
        "serverSigner.acquire.coordinatorEpoch",
      ),
    }),
    signingLeaseId: parseA1SafeId(value.acquisition.signingLeaseId),
    expectedCurrentSigningLeaseId: parseA1SafeId(value.acquisition.expectedCurrentSigningLeaseId),
    expectedFencingToken: positiveSafeInteger(
      value.acquisition.expectedFencingToken,
      "serverSigner.acquire.expectedFencingToken",
    ),
  });
  if (value.database.machineIdentityId !== machineIdentityId) {
    throw new TypeError("server signer database belongs to another machine identity");
  }
  const state: MutableDatabaseState = {
    database: value.database,
    reconciledUnknownCommitCount: 0,
  };
  const existing = readCustodyQualifiedAcquisition(
    state.database,
    value.custody,
    machineIdentityId,
    request,
  );
  if (existing !== null) {
    return Object.freeze({
      database: state.database,
      acquisition: existing,
      reconciledUnknownCommitCount: 0,
    });
  }
  for (let attempt = 1; attempt <= DORMANT_SERVER_SIGNER_PHASE_ATTEMPTS; attempt++) {
    try {
      const acquisition = state.database.transaction((transaction) =>
        transaction.serverSigning.acquireCurrentSigningLease(request),
      );
      return Object.freeze({
        database: state.database,
        acquisition,
        reconciledUnknownCommitCount: state.reconciledUnknownCommitCount,
      });
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      closeAndReopen(state, value.reopenDatabase);
      const reconciled = readCustodyQualifiedAcquisition(
        state.database,
        value.custody,
        machineIdentityId,
        request,
      );
      if (reconciled !== null) {
        return Object.freeze({
          database: state.database,
          acquisition: reconciled,
          reconciledUnknownCommitCount: state.reconciledUnknownCommitCount,
        });
      }
      if (attempt === DORMANT_SERVER_SIGNER_PHASE_ATTEMPTS) {
        throw new DormantServerSignerRecoveryError(
          "UNKNOWN_COMMIT_NOT_SETTLED",
          "the takeover signing-lease acquisition was repeatedly proved absent",
          { cause: error },
        );
      }
    }
  }
  throw new DormantServerSignerRecoveryError(
    "UNKNOWN_COMMIT_NOT_SETTLED",
    "the takeover signing-lease acquisition did not settle",
  );
}
