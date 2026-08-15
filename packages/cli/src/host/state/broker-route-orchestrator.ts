// Dormant A1.6 composition only. This module is intentionally not imported by
// the CLI run path: it closes the remote-open/local-COMMIT ambiguity before the
// runtime starts consuming broker data.

import type { A1BrokerEnsureRouteReceiptV1, A1BrokerRoute } from "@remote-claw/clawsec";
import {
  type A1BrokerNegotiatedClient,
  A1BrokerOutcomeUnknownError,
  type A1BrokerRouteHandle,
} from "../../broker/a1-client.js";
import {
  BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
  canonicalBrokerBackendCapabilitiesV1,
  REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
} from "./backend.js";
import type {
  BrokerBackendCapabilityPinRecord,
  BrokerRouteKind,
  InstallBrokerRouteRequest,
} from "./broker-route.js";
import {
  deriveBrokerRouteId,
  equalBrokerDigest,
  parseBrokerOrigin,
  parseConfirmedBrokerRouteOpenReceiptV1,
  syncBrokerBackendCapabilitiesDigestV1,
} from "./broker-route.js";
import {
  type BrokerRouteInstallationResult,
  BrokerRouteRepositoryPersistenceError,
} from "./broker-route-repository.js";
import {
  type A1Digest,
  HostStateContractError,
  type LogicalChatId,
  parseA1CanonicalId,
  parseA1Digest,
  parseMachineIdentityId,
} from "./ids.js";
import { ProtectedByteSnapshot } from "./protected.js";
import { type CoordinatorLeaseFence, parseCoordinatorLeaseFence } from "./records.js";
import {
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type HostStateTransaction,
} from "./sqlite.js";
import { parseNonNegativeSafeInteger } from "./validation.js";

export const DORMANT_BROKER_ROUTE_REMOTE_OPEN_ATTEMPTS = 2 as const;

export type DormantBrokerRouteDatabase = Pick<
  HostStateDatabase,
  "machineIdentityId" | "brokerRoute" | "transaction" | "close"
>;

type DormantBrokerRouteScope =
  | Readonly<{ routeKind: "chat"; logicalChatId: LogicalChatId }>
  | Readonly<{
      routeKind: Exclude<BrokerRouteKind, "chat">;
      logicalChatId: null;
    }>;

export type OpenAndInstallDormantBrokerRouteRequest = DormantBrokerRouteScope &
  Readonly<{
    database: DormantBrokerRouteDatabase;
    reopenDatabase: () => DormantBrokerRouteDatabase;
    client: A1BrokerNegotiatedClient;
    fence: CoordinatorLeaseFence;
    nowMs?: () => number;
  }>;

export interface OpenAndInstallDormantBrokerRouteResult {
  readonly database: DormantBrokerRouteDatabase;
  readonly routeHandle: A1BrokerRouteHandle;
  readonly installation: BrokerRouteInstallationResult;
  readonly remoteOpenAttempts: number;
  readonly reconciledAfterUnknownCommit: boolean;
}

export class DormantBrokerRouteCommitAbsentError extends Error {
  readonly retrySafe = false;

  constructor(options?: ErrorOptions) {
    super(
      "dormant broker-route local COMMIT reconciled as absent; the remote route may already exist",
      options,
    );
    this.name = "DormantBrokerRouteCommitAbsentError";
  }
}

function routeFor(
  machineIdentityId: string,
  collaborationServerId: CoordinatorLeaseFence["collaborationServerId"],
  scope: DormantBrokerRouteScope,
): A1BrokerRoute {
  const identityId = Uint8Array.from(Buffer.from(parseMachineIdentityId(machineIdentityId), "hex"));
  const serverId = parseA1CanonicalId(
    "collaborationServer",
    collaborationServerId,
    "dormantBrokerRoute.collaborationServerId",
  );
  if (scope.routeKind === "chat") {
    return Object.freeze({
      routeKind: "chat",
      identityId,
      collaborationServerId: serverId,
      logicalChatId: parseA1CanonicalId(
        "logicalChat",
        scope.logicalChatId,
        "dormantBrokerRoute.logicalChatId",
      ),
    });
  }
  return Object.freeze({
    routeKind: scope.routeKind,
    identityId,
    collaborationServerId: serverId,
    logicalChatId: null,
  });
}

async function openRemoteRoute(
  client: A1BrokerNegotiatedClient,
  route: A1BrokerRoute,
  expectedRouteStoreInstanceId: string | null,
): Promise<Readonly<{ handle: A1BrokerRouteHandle; attempts: number }>> {
  const options = Object.freeze({ expectedRouteStoreInstanceId });
  for (let attempt = 1; attempt <= DORMANT_BROKER_ROUTE_REMOTE_OPEN_ATTEMPTS; attempt++) {
    try {
      return Object.freeze({ handle: await client.openRoute(route, options), attempts: attempt });
    } catch (error) {
      if (
        !(error instanceof A1BrokerOutcomeUnknownError) ||
        attempt === DORMANT_BROKER_ROUTE_REMOTE_OPEN_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new A1BrokerOutcomeUnknownError();
}

function requestFromExisting(
  existing: BrokerRouteInstallationResult,
  receipt: A1BrokerEnsureRouteReceiptV1,
): InstallBrokerRouteRequest {
  return {
    fence: {
      collaborationServerId: existing.route.collaborationServerId,
      coordinatorLeaseId: existing.route.coordinatorLeaseId,
      coordinatorEpoch: existing.route.coordinatorEpoch,
    },
    routeKind: existing.route.routeKind,
    logicalChatId: existing.route.logicalChatId,
    brokerOrigin: existing.route.brokerOrigin,
    brokerBackendSelector: existing.route.brokerBackendSelector,
    capabilityArtifactRef: {
      protectedHandleId: existing.capabilityPin.canonicalPayloadRef,
      kind: "artifact",
    },
    capabilityObservedAtMs: existing.capabilityPin.observedAtMs,
    routeOpenedAtMs: existing.route.createdAtMs,
    receipt: parseConfirmedBrokerRouteOpenReceiptV1(receipt),
  };
}

function requestForNewRoute(
  fence: CoordinatorLeaseFence,
  scope: DormantBrokerRouteScope,
  brokerOrigin: string,
  capabilityPin: Pick<BrokerBackendCapabilityPinRecord, "canonicalPayloadRef" | "observedAtMs">,
  routeOpenedAtMs: number,
  receipt: A1BrokerEnsureRouteReceiptV1,
): InstallBrokerRouteRequest {
  return {
    fence,
    routeKind: scope.routeKind,
    logicalChatId: scope.logicalChatId,
    brokerOrigin,
    brokerBackendSelector: "sqlite",
    capabilityArtifactRef: {
      protectedHandleId: capabilityPin.canonicalPayloadRef,
      kind: "artifact",
    },
    capabilityObservedAtMs: capabilityPin.observedAtMs,
    routeOpenedAtMs,
    receipt: parseConfirmedBrokerRouteOpenReceiptV1(receipt),
  };
}

function matchingCapabilityPin(
  database: DormantBrokerRouteDatabase,
  brokerOrigin: string,
  capabilityDigest: A1Digest,
): BrokerBackendCapabilityPinRecord | null {
  const matches = database.brokerRoute
    .readInventory()
    .capabilityPins.filter(
      (pin) =>
        pin.brokerOrigin === brokerOrigin &&
        pin.brokerBackendSelector === "sqlite" &&
        equalBrokerDigest(pin.canonicalPayloadDigest, capabilityDigest),
    );
  if (matches.length > 1) {
    throw new BrokerRouteRepositoryPersistenceError(
      "more than one retained capability pin matches the negotiated broker",
    );
  }
  return matches[0] ?? null;
}

function reconcileUnknownCommit(
  database: DormantBrokerRouteDatabase,
  reopenDatabase: () => DormantBrokerRouteDatabase,
  request: InstallBrokerRouteRequest,
  error: HostStateCommitOutcomeUnknownError,
): Readonly<{
  database: DormantBrokerRouteDatabase;
  installation: BrokerRouteInstallationResult;
}> {
  database.close();
  const reopened = reopenDatabase();
  try {
    const installation = reopened.brokerRoute.reconcileInstall(request);
    if (installation === null) {
      reopened.close();
      throw new DormantBrokerRouteCommitAbsentError({ cause: error });
    }
    return Object.freeze({ database: reopened, installation });
  } catch (reconcileError) {
    if (!(reconcileError instanceof DormantBrokerRouteCommitAbsentError)) {
      try {
        reopened.close();
      } catch {
        // Preserve the exact reconciliation failure. Secure close retains its
        // own guardians and fails stop if it cannot complete.
      }
    }
    throw reconcileError;
  }
}

/**
 * Confirm one pristine remote route and install its local pin/route/genesis.
 * The only automatic network retry is one exact retry after an unknown open
 * outcome. An unknown local COMMIT is resolved by close/reopen + exact read;
 * the local mutation is never replayed blindly.
 */
export async function openAndInstallDormantBrokerRoute(
  value: OpenAndInstallDormantBrokerRouteRequest,
): Promise<OpenAndInstallDormantBrokerRouteResult> {
  const database = value.database;
  const machineIdentityId = parseMachineIdentityId(database.machineIdentityId);
  const fence = parseCoordinatorLeaseFence(value.fence);
  const scope: DormantBrokerRouteScope =
    value.routeKind === "chat"
      ? {
          routeKind: "chat",
          logicalChatId: parseA1CanonicalId(
            "logicalChat",
            value.logicalChatId,
            "dormantBrokerRoute.logicalChatId",
          ),
        }
      : { routeKind: value.routeKind, logicalChatId: null };
  const brokerOrigin = parseBrokerOrigin(value.client.brokerOrigin);
  const capabilityDigest = parseA1Digest(
    value.client.brokerBackendCapabilitiesDigest,
    "dormantBrokerRoute.brokerBackendCapabilitiesDigest",
  );
  const requiredDigest = syncBrokerBackendCapabilitiesDigestV1(
    REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
  );
  if (!equalBrokerDigest(capabilityDigest, requiredDigest)) {
    throw new HostStateContractError(
      "negotiated broker capabilities do not equal the selected A1 vector",
    );
  }
  const route = routeFor(machineIdentityId, fence.collaborationServerId, scope);
  const routeId = deriveBrokerRouteId(
    machineIdentityId,
    fence.collaborationServerId,
    scope.routeKind,
    scope.logicalChatId,
  );
  const existing = database.brokerRoute.readInstallation(routeId);
  const remote = await openRemoteRoute(
    value.client,
    route,
    existing?.route.brokerRouteStoreInstanceId ?? null,
  );

  let capturedRequest: InstallBrokerRouteRequest | null = null;
  let localOperation: () => BrokerRouteInstallationResult;
  if (existing !== null) {
    capturedRequest = requestFromExisting(existing, remote.handle.openReceipt);
    localOperation = () => {
      const reconciled = database.brokerRoute.reconcileInstall(
        capturedRequest as InstallBrokerRouteRequest,
      );
      if (reconciled === null) {
        throw new BrokerRouteRepositoryPersistenceError(
          "a retained route disappeared before exact reconciliation",
        );
      }
      return reconciled;
    };
  } else {
    const routeOpenedAtMs = parseNonNegativeSafeInteger(
      (value.nowMs ?? Date.now)(),
      "dormantBrokerRoute.routeOpenedAtMs",
    );
    const retainedPin = matchingCapabilityPin(database, brokerOrigin, capabilityDigest);
    if (retainedPin !== null) {
      capturedRequest = requestForNewRoute(
        fence,
        scope,
        brokerOrigin,
        retainedPin,
        routeOpenedAtMs,
        remote.handle.openReceipt,
      );
      localOperation = () =>
        database.transaction((transaction) =>
          transaction.brokerRoute.install(capturedRequest as InstallBrokerRouteRequest),
        );
    } else {
      const capabilityBytes = canonicalBrokerBackendCapabilitiesV1(
        REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
      );
      localOperation = () =>
        database.transaction((transaction: HostStateTransaction) => {
          const artifact = transaction.putArtifact({
            scopeKind: "host_profile",
            scopeId: "default",
            artifactSchemaId: BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
            artifactDigest: requiredDigest,
            artifactBytes: ProtectedByteSnapshot.from(capabilityBytes),
          });
          capturedRequest = requestForNewRoute(
            fence,
            scope,
            brokerOrigin,
            {
              canonicalPayloadRef: artifact.artifactRef.protectedHandleId,
              observedAtMs: routeOpenedAtMs,
            },
            routeOpenedAtMs,
            remote.handle.openReceipt,
          );
          return transaction.brokerRoute.install(capturedRequest);
        });
    }
  }

  try {
    const installation = localOperation();
    return Object.freeze({
      database,
      routeHandle: remote.handle,
      installation,
      remoteOpenAttempts: remote.attempts,
      reconciledAfterUnknownCommit: false,
    });
  } catch (error) {
    if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
    if (capturedRequest === null) {
      throw new BrokerRouteRepositoryPersistenceError(
        "local COMMIT became unknown before its exact route request was captured",
        { cause: error },
      );
    }
    const reconciled = reconcileUnknownCommit(
      database,
      value.reopenDatabase,
      capturedRequest,
      error,
    );
    return Object.freeze({
      database: reconciled.database,
      routeHandle: remote.handle,
      installation: reconciled.installation,
      remoteOpenAttempts: remote.attempts,
      reconciledAfterUnknownCommit: true,
    });
  }
}
