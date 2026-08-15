// Dormant A1.7b1 composition only. This module is intentionally absent from
// production barrels and run paths.

import { base64urlEncode } from "@remote-claw/clawsec";
import type {
  RejectedCommandDecisionResult,
  RejectedCommandPreparationMutationResult,
  ReserveRejectedCommandDecisionRequest,
} from "../state/command-adjudication-repository.js";
import {
  type A1SafeId,
  parseA1SafeId,
  parseEd25519Signature,
  parseMachineIdentityId,
} from "../state/ids.js";
import type { ProtectedByteSnapshot } from "../state/protected.js";
import { parseCoordinatorLeaseFence } from "../state/records.js";
import type {
  ServerIdentityKeyRecord,
  ServerIdentityPrivateKeyEnvelopeRecord,
  ServerSigningInventory,
  ServerSigningLeaseRecord,
} from "../state/server-signing.js";
import {
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type HostStateTransaction,
} from "../state/sqlite.js";
import type { ServerKeyCustodySigningCapability, WrappedServerPrivateKey } from "./service.js";

export const DORMANT_COMMAND_RESULT_SIGNING_PHASE_ATTEMPTS = 2 as const;

export type DormantCommandResultSigningDatabase = Pick<
  HostStateDatabase,
  "machineIdentityId" | "commandAdjudication" | "serverSigning" | "transaction" | "close"
>;

export interface SignRejectedCommandResultPreparationRequest {
  readonly database: DormantCommandResultSigningDatabase;
  readonly reopenDatabase: () => DormantCommandResultSigningDatabase;
  readonly custody: ServerKeyCustodySigningCapability;
  readonly machineIdentityId: string;
  readonly decision: ReserveRejectedCommandDecisionRequest;
}

/**
 * Deliberately omits the canonical payload, signature, and key envelope. The
 * dormant caller learns only that the exact durable preparation reached signed.
 */
export interface SignRejectedCommandResultPreparationResult {
  readonly database: DormantCommandResultSigningDatabase;
  readonly commandResultPreparationId: A1SafeId;
  readonly commandResultId: A1SafeId;
  readonly signerSequence: number;
  readonly signingLeaseId: A1SafeId;
  readonly preparationGeneration: number;
  readonly replayed: boolean;
  readonly reconciledUnknownCommitCount: number;
}

export class DormantCommandResultSigningError extends Error {
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
    super(`dormant command-result signing failed: ${message}`, options);
    this.name = "DormantCommandResultSigningError";
    this.code = code;
  }
}

interface ParsedSigningRequest {
  readonly machineIdentityId: string;
  readonly decision: ReserveRejectedCommandDecisionRequest;
}

interface MutableDatabaseState {
  database: DormantCommandResultSigningDatabase;
  reconciledUnknownCommitCount: number;
}

interface CurrentSigner {
  readonly lease: ServerSigningLeaseRecord;
  readonly key: ServerIdentityKeyRecord;
  readonly envelope: WrappedServerPrivateKey;
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

function parseRequest(value: SignRejectedCommandResultPreparationRequest): ParsedSigningRequest {
  const machineIdentityId = parseMachineIdentityId(
    value.machineIdentityId,
    "commandResultSigning.machineIdentityId",
  );
  if (value.database.machineIdentityId !== machineIdentityId) {
    throw new TypeError("command-result signing database belongs to another machine identity");
  }
  const fence = parseCoordinatorLeaseFence(value.decision.fence);
  const expectedCommandId = parseA1SafeId(
    value.decision.expectedCommandId,
    "commandResultSigning.expectedCommandId",
  );
  if (!expectedCommandId.startsWith("rcm_") || expectedCommandId.length !== 47) {
    throw new TypeError(
      "commandResultSigning.expectedCommandId must use the rcm_ SHA-256 namespace",
    );
  }
  return Object.freeze({
    machineIdentityId,
    decision: Object.freeze({
      fence,
      expectedCommandId,
      expectedCommandSeq: nonNegativeSafeInteger(
        value.decision.expectedCommandSeq,
        "commandResultSigning.expectedCommandSeq",
      ),
      expectedSignerSequence: nonNegativeSafeInteger(
        value.decision.expectedSignerSequence,
        "commandResultSigning.expectedSignerSequence",
      ),
      expectedSigningLeaseId: parseA1SafeId(
        value.decision.expectedSigningLeaseId,
        "commandResultSigning.expectedSigningLeaseId",
      ),
    }),
  });
}

function destroyInventory(inventory: ServerSigningInventory): void {
  for (const envelope of inventory.privateKeyEnvelopes) {
    envelope.wrapNonce.destroy();
    envelope.wrappedPkcs8.destroy();
    envelope.authTag.destroy();
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

function currentSignerFromInventory(
  inventory: ServerSigningInventory,
  machineIdentityId: string,
  decision: RejectedCommandDecisionResult,
  request: ReserveRejectedCommandDecisionRequest,
): CurrentSigner {
  const preparation = decision.preparation;
  const lease = inventory.signingLeases.find(
    (candidate) => candidate.signingLeaseId === preparation.signingLeaseId,
  );
  if (
    lease === undefined ||
    lease.state !== "current" ||
    lease.collaborationServerId !== preparation.collaborationServerId ||
    lease.signingLeaseId !== request.expectedSigningLeaseId ||
    lease.coordinatorLeaseId !== request.fence.coordinatorLeaseId ||
    lease.coordinatorEpoch !== request.fence.coordinatorEpoch
  ) {
    throw new DormantCommandResultSigningError(
      "SIGNER_NON_WRITABLE",
      "the reserved signing lease is no longer the current fenced server signer",
    );
  }
  const key = inventory.identityKeys.find(
    (candidate) =>
      candidate.identityKeyId === lease.identityKeyId &&
      candidate.keyGeneration === lease.keyGeneration,
  );
  const envelope = inventory.privateKeyEnvelopes.find(
    (candidate) =>
      candidate.signingKeyRef === key?.signingKeyRef &&
      candidate.identityKeyId === lease.identityKeyId &&
      candidate.keyGeneration === lease.keyGeneration,
  );
  const certificateStatus = inventory.certificateStatuses.find(
    (candidate) => candidate.scopeCertificateId === lease.scopeCertificateId,
  );
  if (
    key === undefined ||
    key.state !== "current" ||
    key.collaborationServerId !== preparation.collaborationServerId ||
    envelope === undefined ||
    envelope.state !== "current" ||
    envelope.destroyedAtMs !== null ||
    envelope.collaborationServerId !== preparation.collaborationServerId ||
    certificateStatus === undefined ||
    certificateStatus.state !== "current" ||
    certificateStatus.collaborationServerId !== preparation.collaborationServerId
  ) {
    throw new DormantCommandResultSigningError(
      "SIGNER_NON_WRITABLE",
      "the current server signer has no complete current key custody and certificate graph",
    );
  }
  return Object.freeze({
    lease,
    key,
    envelope: wrappedEnvelope(machineIdentityId, key, envelope),
  });
}

function reconcileExactDecision(
  operations:
    | HostStateTransaction["commandAdjudication"]
    | HostStateDatabase["commandAdjudication"],
  request: ReserveRejectedCommandDecisionRequest,
): RejectedCommandDecisionResult {
  const decision = operations.reconcileRejectedDecision(request);
  if (decision === null) {
    throw new DormantCommandResultSigningError(
      "DURABLE_GRAPH_MISMATCH",
      "the exact rejected command decision and result preparation are absent",
    );
  }
  return decision;
}

function closeAndReopen(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantCommandResultSigningDatabase,
  machineIdentityId: string,
): void {
  try {
    state.database.close();
  } catch (error) {
    throw new DormantCommandResultSigningError(
      "DATABASE_CLOSE_FAILED",
      "the poisoned database could not be closed",
      { cause: error },
    );
  }
  try {
    const reopened = reopenDatabase();
    if (reopened.machineIdentityId !== machineIdentityId) {
      try {
        reopened.close();
      } catch {
        // The identity mismatch remains the primary fail-stop condition.
      }
      throw new TypeError("reopened command-result signing database belongs to another machine");
    }
    state.database = reopened;
  } catch (error) {
    throw new DormantCommandResultSigningError(
      "DATABASE_REOPEN_FAILED",
      "the database could not be securely reopened",
      { cause: error },
    );
  }
  state.reconciledUnknownCommitCount += 1;
}

function exactBindingAfterReopen(
  state: MutableDatabaseState,
  request: ReserveRejectedCommandDecisionRequest,
  commandResultPreparationId: A1SafeId,
): RejectedCommandPreparationMutationResult | null {
  const decision = reconcileExactDecision(state.database.commandAdjudication, request);
  try {
    if (decision.preparation.commandResultPreparationId !== commandResultPreparationId) {
      throw new DormantCommandResultSigningError(
        "DURABLE_GRAPH_MISMATCH",
        "the deciding sidecar moved to another result preparation",
      );
    }
  } finally {
    decision.canonicalPayload.destroy();
  }
  return state.database.commandAdjudication.reconcileRejectedResultPreparationBinding({
    fence: request.fence,
    commandResultPreparationId,
  });
}

function ensureBound(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantCommandResultSigningDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedSigningRequest,
): RejectedCommandPreparationMutationResult {
  for (let attempt = 1; attempt <= DORMANT_COMMAND_RESULT_SIGNING_PHASE_ATTEMPTS; attempt++) {
    let preparationId: A1SafeId | null = null;
    try {
      return state.database.transaction((transaction) => {
        const decision = reconcileExactDecision(transaction.commandAdjudication, request.decision);
        try {
          preparationId = decision.preparation.commandResultPreparationId;
          if (decision.preparation.state === "signed") {
            const signature = decision.signatureReservation.signature;
            if (signature === null) {
              throw new DormantCommandResultSigningError(
                "DURABLE_GRAPH_MISMATCH",
                "the signed preparation has no durable signature",
              );
            }
            const signed = transaction.commandAdjudication.reconcileSignedRejectedResultPreparation(
              {
                fence: request.decision.fence,
                commandResultPreparationId: preparationId,
                signature,
              },
            );
            if (signed === null) {
              throw new DormantCommandResultSigningError(
                "DURABLE_GRAPH_MISMATCH",
                "the signed preparation could not be reconciled exactly",
              );
            }
            return signed;
          }
          const inventory = transaction.serverSigning.readInventory(
            decision.preparation.collaborationServerId,
          );
          try {
            const signer = currentSignerFromInventory(
              inventory,
              request.machineIdentityId,
              decision,
              request.decision,
            );
            try {
              custody.assertUsable(signer.envelope);
            } catch (error) {
              throw new DormantCommandResultSigningError(
                "SIGNER_NON_WRITABLE",
                "the current server private-key envelope is unusable under this custody root",
                { cause: error },
              );
            }
            return transaction.commandAdjudication.bindRejectedResultPreparation({
              fence: request.decision.fence,
              commandResultPreparationId: preparationId,
            });
          } finally {
            destroyInventory(inventory);
          }
        } finally {
          decision.canonicalPayload.destroy();
        }
      });
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      if (preparationId === null) {
        throw new DormantCommandResultSigningError(
          "DURABLE_GRAPH_MISMATCH",
          "a bind COMMIT became unknown before the exact preparation was captured",
          { cause: error },
        );
      }
      closeAndReopen(state, reopenDatabase, request.machineIdentityId);
      const reconciled = exactBindingAfterReopen(state, request.decision, preparationId);
      if (reconciled !== null) return reconciled;
      if (attempt === DORMANT_COMMAND_RESULT_SIGNING_PHASE_ATTEMPTS) {
        throw new DormantCommandResultSigningError(
          "UNKNOWN_COMMIT_NOT_SETTLED",
          "the exact result-preparation bind was repeatedly proved absent",
          { cause: error },
        );
      }
    }
  }
  throw new DormantCommandResultSigningError(
    "UNKNOWN_COMMIT_NOT_SETTLED",
    "the result-preparation bind did not settle",
  );
}

function signatureValue(snapshot: ProtectedByteSnapshot): ReturnType<typeof parseEd25519Signature> {
  const bytes = snapshot.copyBytes();
  try {
    return parseEd25519Signature(base64urlEncode(bytes), "commandResultSigning.signature");
  } finally {
    bytes.fill(0);
  }
}

function signedResult(
  state: MutableDatabaseState,
  mutation: RejectedCommandPreparationMutationResult,
  replayed: boolean,
): SignRejectedCommandResultPreparationResult {
  if (
    mutation.preparation.state !== "signed" ||
    mutation.signingGroup.state !== "result_signed" ||
    mutation.signatureReservation.state !== "signed"
  ) {
    throw new DormantCommandResultSigningError(
      "DURABLE_GRAPH_MISMATCH",
      "the result preparation did not reach the exact signed graph",
    );
  }
  return Object.freeze({
    database: state.database,
    commandResultPreparationId: mutation.preparation.commandResultPreparationId,
    commandResultId: mutation.preparation.commandResultId,
    signerSequence: mutation.preparation.signerSequence,
    signingLeaseId: mutation.preparation.signingLeaseId,
    preparationGeneration: positiveSafeInteger(
      mutation.preparation.preparationGeneration,
      "commandResultSigning.preparationGeneration",
    ),
    replayed,
    reconciledUnknownCommitCount: state.reconciledUnknownCommitCount,
  });
}

function reconcileSignedAfterUnknownCommit(
  state: MutableDatabaseState,
  request: ParsedSigningRequest,
  preparationId: A1SafeId,
  signature: ReturnType<typeof parseEd25519Signature> | null,
): RejectedCommandPreparationMutationResult | null {
  const decision = reconcileExactDecision(state.database.commandAdjudication, request.decision);
  try {
    if (decision.preparation.commandResultPreparationId !== preparationId) {
      throw new DormantCommandResultSigningError(
        "DURABLE_GRAPH_MISMATCH",
        "the deciding sidecar moved after the signature was prepared",
      );
    }
    const durableSignature = decision.signatureReservation.signature;
    if (decision.preparation.state === "signed") {
      if (durableSignature === null || (signature !== null && durableSignature !== signature)) {
        throw new DormantCommandResultSigningError(
          "DURABLE_GRAPH_MISMATCH",
          "the durable signed preparation does not contain the exact retained signature",
        );
      }
      const signed = state.database.commandAdjudication.reconcileSignedRejectedResultPreparation({
        fence: request.decision.fence,
        commandResultPreparationId: preparationId,
        signature: durableSignature,
      });
      if (signed === null) {
        throw new DormantCommandResultSigningError(
          "DURABLE_GRAPH_MISMATCH",
          "the durable signed preparation could not be reconciled exactly",
        );
      }
      return signed;
    }
  } finally {
    decision.canonicalPayload.destroy();
  }
  if (signature !== null) {
    const signed = state.database.commandAdjudication.reconcileSignedRejectedResultPreparation({
      fence: request.decision.fence,
      commandResultPreparationId: preparationId,
      signature,
    });
    if (signed !== null) return signed;
  }
  const bound = state.database.commandAdjudication.reconcileRejectedResultPreparationBinding({
    fence: request.decision.fence,
    commandResultPreparationId: preparationId,
  });
  if (bound === null || bound.preparation.state !== "bound") {
    throw new DormantCommandResultSigningError(
      "DURABLE_GRAPH_MISMATCH",
      "the unknown signing COMMIT left neither the exact signed nor bound preparation",
    );
  }
  return null;
}

function signBound(
  state: MutableDatabaseState,
  reopenDatabase: () => DormantCommandResultSigningDatabase,
  custody: ServerKeyCustodySigningCapability,
  request: ParsedSigningRequest,
  bound: RejectedCommandPreparationMutationResult,
): SignRejectedCommandResultPreparationResult {
  if (bound.preparation.state === "signed") return signedResult(state, bound, true);
  if (bound.preparation.state !== "bound") {
    throw new DormantCommandResultSigningError(
      "DURABLE_GRAPH_MISMATCH",
      "the result preparation is neither bound nor signed",
    );
  }
  const preparationId = bound.preparation.commandResultPreparationId;
  let retainedSignature: ProtectedByteSnapshot | undefined;
  try {
    for (let attempt = 1; attempt <= DORMANT_COMMAND_RESULT_SIGNING_PHASE_ATTEMPTS; attempt++) {
      let capturedSignature: ReturnType<typeof parseEd25519Signature> | null = null;
      try {
        const mutation = state.database.transaction((transaction) => {
          const decision = reconcileExactDecision(
            transaction.commandAdjudication,
            request.decision,
          );
          const inventory = transaction.serverSigning.readInventory(
            decision.preparation.collaborationServerId,
          );
          try {
            if (decision.preparation.commandResultPreparationId !== preparationId) {
              throw new DormantCommandResultSigningError(
                "DURABLE_GRAPH_MISMATCH",
                "the deciding sidecar moved before result signing",
              );
            }
            const rebound = transaction.commandAdjudication.bindRejectedResultPreparation({
              fence: request.decision.fence,
              commandResultPreparationId: preparationId,
            });
            if (rebound.preparation.state === "signed") return rebound;
            if (rebound.preparation.state !== "bound") {
              throw new DormantCommandResultSigningError(
                "DURABLE_GRAPH_MISMATCH",
                "the exact result preparation lost its bound state",
              );
            }
            const signer = currentSignerFromInventory(
              inventory,
              request.machineIdentityId,
              decision,
              request.decision,
            );
            try {
              custody.assertUsable(signer.envelope);
            } catch (error) {
              throw new DormantCommandResultSigningError(
                "SIGNER_NON_WRITABLE",
                "the current server private-key envelope is unusable under this custody root",
                { cause: error },
              );
            }
            if (retainedSignature === undefined) {
              retainedSignature = custody.sign(signer.envelope, decision.canonicalPayload);
            }
            capturedSignature = signatureValue(retainedSignature);
            return transaction.commandAdjudication.storeSignedRejectedResultPreparation({
              fence: request.decision.fence,
              commandResultPreparationId: preparationId,
              signature: capturedSignature,
            });
          } finally {
            destroyInventory(inventory);
            decision.canonicalPayload.destroy();
          }
        });
        return signedResult(state, mutation, mutation.replayed);
      } catch (error) {
        if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
        closeAndReopen(state, reopenDatabase, request.machineIdentityId);
        const reconciled = reconcileSignedAfterUnknownCommit(
          state,
          request,
          preparationId,
          capturedSignature,
        );
        if (reconciled !== null) return signedResult(state, reconciled, true);
        if (attempt === DORMANT_COMMAND_RESULT_SIGNING_PHASE_ATTEMPTS) {
          throw new DormantCommandResultSigningError(
            "UNKNOWN_COMMIT_NOT_SETTLED",
            "the exact signed preparation was repeatedly proved absent",
            { cause: error },
          );
        }
      }
    }
  } finally {
    retainedSignature?.destroy();
  }
  throw new DormantCommandResultSigningError(
    "UNKNOWN_COMMIT_NOT_SETTLED",
    "the signed result preparation did not settle",
  );
}

/**
 * Sign one exact rejected command-result preparation. The custody operation and
 * durable signature store share one outer host-state transaction, so a signer
 * takeover cannot land between authority reconciliation and signature storage.
 * Unknown COMMIT outcomes are closed/reopened and reconciled before the same
 * in-memory signature may be retried; custody.sign is never called twice.
 */
export function signRejectedCommandResultPreparation(
  value: SignRejectedCommandResultPreparationRequest,
): SignRejectedCommandResultPreparationResult {
  const request = parseRequest(value);
  const state: MutableDatabaseState = {
    database: value.database,
    reconciledUnknownCommitCount: 0,
  };
  const bound = ensureBound(state, value.reopenDatabase, value.custody, request);
  return signBound(state, value.reopenDatabase, value.custody, request, bound);
}
