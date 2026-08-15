import { createHash } from "node:crypto";
import {
  BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
  REQUIRED_BROKER_BACKEND_CAPABILITIES_V1,
} from "./backend.js";
import {
  type BrokerBackendCapabilityPinId,
  type BrokerBackendCapabilityPinRecord,
  type BrokerChannelGenerationRecord,
  type BrokerRouteId,
  type BrokerRouteRecord,
  deriveBrokerBackendCapabilityPinId,
  deriveBrokerRouteId,
  deriveBrokerRouteToken,
  equalBrokerDigest,
  type InstallBrokerRouteRequest,
  parseBrokerBackendCapabilityPinId,
  parseBrokerBackendCapabilityPinRecord,
  parseBrokerChannelGenerationRecord,
  parseBrokerRouteId,
  parseBrokerRouteRecord,
  parseInstallBrokerRouteRequest,
  parseRequiredBrokerCapabilitiesArtifact,
  syncBrokerBackendCapabilitiesDigestV1,
} from "./broker-route.js";
import { HostStateContractError, parseMachineIdentityId } from "./ids.js";
import type {
  HostStateRepositorySqlRunResult,
  HostStateRepositorySqlTransaction,
  HostStateRepositorySqlValue,
  HostStateRepositoryTransactionExecutor,
} from "./repository.js";
import { frozen, parseExactRecord, parseNonNegativeSafeInteger } from "./validation.js";

export interface BrokerRouteRepositoryOptions {
  readonly nowMs?: () => number;
}

export interface BrokerRouteInstallationResult {
  readonly capabilityPin: BrokerBackendCapabilityPinRecord;
  readonly route: BrokerRouteRecord;
  readonly genesis: BrokerChannelGenerationRecord;
  readonly replayed: boolean;
}

export interface BrokerRouteInventory {
  readonly capabilityPins: readonly BrokerBackendCapabilityPinRecord[];
  readonly routes: readonly BrokerRouteRecord[];
  readonly generations: readonly BrokerChannelGenerationRecord[];
}

export interface BrokerRouteRepositoryOperations {
  install(request: InstallBrokerRouteRequest): BrokerRouteInstallationResult;
  reconcileInstall(request: InstallBrokerRouteRequest): BrokerRouteInstallationResult | null;
  readInstallation(brokerRouteId: BrokerRouteId): BrokerRouteInstallationResult | null;
  readRoute(brokerRouteId: BrokerRouteId): BrokerRouteRecord | null;
  readCapabilityPin(
    brokerBackendCapabilityPinId: BrokerBackendCapabilityPinId,
  ): BrokerBackendCapabilityPinRecord | null;
  readInventory(): BrokerRouteInventory;
}

export class BrokerRouteRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`broker route repository conflict: ${message}`);
    this.name = "BrokerRouteRepositoryConflictError";
  }
}

export class BrokerRouteStaleCoordinatorError extends Error {
  constructor() {
    super("broker route repository stale coordinator: lease fence is not current and unexpired");
    this.name = "BrokerRouteStaleCoordinatorError";
  }
}

export class BrokerRouteRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`broker route repository persistence failed: ${message}`, options);
    this.name = "BrokerRouteRepositoryPersistenceError";
  }
}

const PIN_ROW_KEYS = [
  "broker_backend_capability_pin_id",
  "machine_identity_id",
  "broker_origin",
  "broker_backend_selector",
  "canonical_payload_schema_id",
  "canonical_payload_ref",
  "canonical_payload_digest",
  "observed_at_ms",
] as const;

const ROUTE_ROW_KEYS = [
  "broker_route_id",
  "machine_identity_id",
  "collaboration_server_id",
  "route_kind",
  "logical_chat_id",
  "route_token",
  "broker_origin",
  "broker_backend_selector",
  "broker_route_store_instance_id",
  "genesis_generation",
  "broker_backend_capabilities_ref",
  "broker_backend_capabilities_digest",
  "coordinator_lease_id",
  "coordinator_epoch",
  "created_at_ms",
  "state",
] as const;

const GENERATION_ROW_KEYS = [
  "broker_route_id",
  "channel_generation",
  "frame_count",
  "next_generation",
  "state",
  "manifest_digest",
] as const;

const ARTIFACT_ROW_KEYS = [
  "protected_handle_id",
  "kind",
  "scope_kind",
  "scope_id",
  "artifact_schema_id",
  "artifact_digest",
  "byte_length",
  "artifact_bytes",
  "created_at_ms",
] as const;

const AUTHORITY_ROW_KEYS = [
  "server_machine_identity_id",
  "server_state",
  "current_coordinator_lease_id",
  "current_coordinator_epoch",
  "lease_state",
  "acquired_at_ms",
  "heartbeat_deadline_ms",
  "released_at_ms",
] as const;

const SELECT_PIN = `SELECT ${PIN_ROW_KEYS.join(", ")}
FROM broker_backend_capability_pins
WHERE broker_backend_capability_pin_id = ?
LIMIT 1`;

const SELECT_ROUTE = `SELECT ${ROUTE_ROW_KEYS.join(", ")}
FROM broker_routes
WHERE broker_route_id = ?
LIMIT 1`;

const SELECT_ROUTE_BY_STORE = `SELECT ${ROUTE_ROW_KEYS.join(", ")}
FROM broker_routes
WHERE broker_route_store_instance_id = ?
LIMIT 1`;

const SELECT_GENERATIONS_FOR_ROUTE = `SELECT ${GENERATION_ROW_KEYS.join(", ")}
FROM broker_channel_generations
WHERE broker_route_id = ?
ORDER BY channel_generation`;

function sqlGet(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): unknown {
  try {
    return transaction.get(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof BrokerRouteRepositoryConflictError ||
      error instanceof BrokerRouteStaleCoordinatorError ||
      error instanceof BrokerRouteRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new BrokerRouteRepositoryPersistenceError("read operation did not complete", {
      cause: error,
    });
  }
}

function sqlAll(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): readonly unknown[] {
  try {
    if (transaction.all === undefined) {
      throw new BrokerRouteRepositoryPersistenceError(
        "inventory reads require a multi-row SQL transaction",
      );
    }
    const rows = transaction.all(sql, parameters);
    if (!Array.isArray(rows)) {
      throw new BrokerRouteRepositoryPersistenceError("multi-row read returned a non-array result");
    }
    return rows;
  } catch (error) {
    if (error instanceof BrokerRouteRepositoryPersistenceError) throw error;
    throw new BrokerRouteRepositoryPersistenceError("multi-row read did not complete", {
      cause: error,
    });
  }
}

function sqlRun(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
): HostStateRepositorySqlRunResult {
  try {
    return transaction.run(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof BrokerRouteRepositoryConflictError ||
      error instanceof BrokerRouteStaleCoordinatorError ||
      error instanceof BrokerRouteRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new BrokerRouteRepositoryPersistenceError("write operation did not complete", {
      cause: error,
    });
  }
}

function runExactlyOne(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
  field: string,
): void {
  if (sqlRun(transaction, sql, parameters).changes !== 1) {
    throw new BrokerRouteRepositoryPersistenceError(`${field} did not affect exactly one row`);
  }
}

function pinFromRow(value: unknown): BrokerBackendCapabilityPinRecord {
  try {
    const row = parseExactRecord(value, PIN_ROW_KEYS, "brokerCapabilityPinRow");
    return parseBrokerBackendCapabilityPinRecord({
      brokerBackendCapabilityPinId: row.broker_backend_capability_pin_id,
      machineIdentityId: row.machine_identity_id,
      brokerOrigin: row.broker_origin,
      brokerBackendSelector: row.broker_backend_selector,
      canonicalPayloadSchemaId: row.canonical_payload_schema_id,
      canonicalPayloadRef: row.canonical_payload_ref,
      canonicalPayloadDigest: row.canonical_payload_digest,
      observedAtMs: row.observed_at_ms,
    });
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError("capability pin row is invalid", {
      cause: error,
    });
  }
}

function routeFromRow(value: unknown): BrokerRouteRecord {
  try {
    const row = parseExactRecord(value, ROUTE_ROW_KEYS, "brokerRouteRow");
    return parseBrokerRouteRecord({
      brokerRouteId: row.broker_route_id,
      machineIdentityId: row.machine_identity_id,
      collaborationServerId: row.collaboration_server_id,
      routeKind: row.route_kind,
      logicalChatId: row.logical_chat_id,
      routeToken: row.route_token,
      brokerOrigin: row.broker_origin,
      brokerBackendSelector: row.broker_backend_selector,
      brokerRouteStoreInstanceId: row.broker_route_store_instance_id,
      genesisGeneration: row.genesis_generation,
      brokerBackendCapabilitiesRef: row.broker_backend_capabilities_ref,
      brokerBackendCapabilitiesDigest: row.broker_backend_capabilities_digest,
      coordinatorLeaseId: row.coordinator_lease_id,
      coordinatorEpoch: row.coordinator_epoch,
      createdAtMs: row.created_at_ms,
      state: row.state,
    });
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError("route row is invalid", { cause: error });
  }
}

function generationFromRow(value: unknown): BrokerChannelGenerationRecord {
  try {
    const row = parseExactRecord(value, GENERATION_ROW_KEYS, "brokerGenerationRow");
    return parseBrokerChannelGenerationRecord({
      brokerRouteId: row.broker_route_id,
      channelGeneration: row.channel_generation,
      frameCount: row.frame_count,
      nextGeneration: row.next_generation,
      state: row.state,
      manifestDigest: row.manifest_digest,
    });
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError("generation row is invalid", {
      cause: error,
    });
  }
}

function findPin(
  transaction: HostStateRepositorySqlTransaction,
  pinId: BrokerBackendCapabilityPinId,
): BrokerBackendCapabilityPinRecord | null {
  const value = sqlGet(transaction, SELECT_PIN, [pinId]);
  return value === undefined ? null : pinFromRow(value);
}

function findRoute(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
): BrokerRouteRecord | null {
  const value = sqlGet(transaction, SELECT_ROUTE, [routeId]);
  return value === undefined ? null : routeFromRow(value);
}

function findRouteByStore(
  transaction: HostStateRepositorySqlTransaction,
  storeInstanceId: BrokerRouteRecord["brokerRouteStoreInstanceId"],
): BrokerRouteRecord | null {
  const value = sqlGet(transaction, SELECT_ROUTE_BY_STORE, [storeInstanceId]);
  return value === undefined ? null : routeFromRow(value);
}

function readGenerations(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
): readonly BrokerChannelGenerationRecord[] {
  return Object.freeze(
    sqlAll(transaction, SELECT_GENERATIONS_FOR_ROUTE, [routeId]).map(generationFromRow),
  );
}

function trustedNow(nowMs: () => number): number {
  return parseNonNegativeSafeInteger(nowMs(), "brokerRoute.nowMs");
}

interface CurrentAuthority {
  readonly nowMs: number;
  readonly acquiredAtMs: number;
  readonly heartbeatDeadlineMs: number;
}

function assertCurrentAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  request: InstallBrokerRouteRequest,
  nowMs: () => number,
): CurrentAuthority {
  const now = trustedNow(nowMs);
  const value = sqlGet(
    transaction,
    `SELECT server.machine_identity_id AS server_machine_identity_id,
            server.state AS server_state,
            server.current_coordinator_lease_id,
            server.current_coordinator_epoch,
            lease.state AS lease_state,
            lease.acquired_at_ms,
            lease.heartbeat_deadline_ms,
            lease.released_at_ms
       FROM collaboration_servers AS server
       JOIN coordinator_leases AS lease
         ON lease.coordinator_lease_id = ?
        AND lease.collaboration_server_id = server.collaboration_server_id
        AND lease.coordinator_epoch = ?
      WHERE server.collaboration_server_id = ?
      LIMIT 1`,
    [
      request.fence.coordinatorLeaseId,
      request.fence.coordinatorEpoch,
      request.fence.collaborationServerId,
    ],
  );
  if (value === undefined) throw new BrokerRouteStaleCoordinatorError();
  let row: ReturnType<typeof parseExactRecord>;
  let acquiredAtMs: number;
  let heartbeatDeadlineMs: number;
  try {
    row = parseExactRecord(value, AUTHORITY_ROW_KEYS, "brokerRouteAuthorityRow");
    acquiredAtMs = parseNonNegativeSafeInteger(
      row.acquired_at_ms,
      "brokerRouteAuthority.acquiredAtMs",
    );
    heartbeatDeadlineMs = parseNonNegativeSafeInteger(
      row.heartbeat_deadline_ms,
      "brokerRouteAuthority.heartbeatDeadlineMs",
    );
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError("coordinator authority row is invalid", {
      cause: error,
    });
  }
  if (
    row.server_machine_identity_id !== machineIdentityId ||
    (row.server_state !== "installing" && row.server_state !== "current") ||
    row.current_coordinator_lease_id !== request.fence.coordinatorLeaseId ||
    row.current_coordinator_epoch !== request.fence.coordinatorEpoch ||
    row.lease_state !== "current" ||
    row.released_at_ms !== null ||
    now < acquiredAtMs ||
    now >= heartbeatDeadlineMs
  ) {
    throw new BrokerRouteStaleCoordinatorError();
  }
  if (
    request.routeOpenedAtMs < acquiredAtMs ||
    request.routeOpenedAtMs > now ||
    request.routeOpenedAtMs >= heartbeatDeadlineMs
  ) {
    throw new BrokerRouteStaleCoordinatorError();
  }
  return frozen({ nowMs: now, acquiredAtMs, heartbeatDeadlineMs });
}

function assertRouteScope(
  transaction: HostStateRepositorySqlTransaction,
  request: InstallBrokerRouteRequest,
): void {
  if (request.routeKind !== "chat") return;
  const value = sqlGet(
    transaction,
    `SELECT state FROM logical_chats
      WHERE collaboration_server_id = ? AND logical_chat_id = ?
      LIMIT 1`,
    [request.fence.collaborationServerId, request.logicalChatId],
  );
  if (value === undefined) {
    throw new BrokerRouteRepositoryConflictError("chat route does not belong to its server");
  }
  const row = parseExactRecord(value, ["state"] as const, "brokerRouteChatRow");
  if (row.state !== "recovering" && row.state !== "ready") {
    throw new BrokerRouteRepositoryConflictError("chat route is not writable");
  }
}

interface ExpectedInstallation {
  readonly pin: BrokerBackendCapabilityPinRecord;
  readonly route: BrokerRouteRecord;
  readonly genesis: BrokerChannelGenerationRecord;
}

function exactRequiredCapabilityDigest(): ReturnType<typeof syncBrokerBackendCapabilitiesDigestV1> {
  return syncBrokerBackendCapabilitiesDigestV1(REQUIRED_BROKER_BACKEND_CAPABILITIES_V1);
}

function readAndVerifyCapabilityArtifact(
  transaction: HostStateRepositorySqlTransaction,
  request: InstallBrokerRouteRequest,
  expectedDigest: ReturnType<typeof exactRequiredCapabilityDigest>,
): void {
  const value = sqlGet(
    transaction,
    `SELECT ${ARTIFACT_ROW_KEYS.join(", ")} FROM protected_artifacts
      WHERE protected_handle_id = ? LIMIT 1`,
    [request.capabilityArtifactRef.protectedHandleId],
  );
  if (value === undefined) {
    throw new HostStateContractError(
      "installBrokerRoute.capabilityArtifactRef could not be verified",
    );
  }
  let row: ReturnType<typeof parseExactRecord>;
  try {
    row = parseExactRecord(value, ARTIFACT_ROW_KEYS, "installBrokerRoute.capabilityArtifact");
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError("capability artifact row is invalid", {
      cause: error,
    });
  }
  if (
    !(row.artifact_bytes instanceof Uint8Array) ||
    row.byte_length !== row.artifact_bytes.byteLength ||
    typeof row.artifact_digest !== "string" ||
    artifactDigest(row.artifact_bytes) !== row.artifact_digest
  ) {
    throw new BrokerRouteRepositoryPersistenceError(
      "capability artifact row does not match its retained bytes",
    );
  }
  if (
    row.protected_handle_id !== request.capabilityArtifactRef.protectedHandleId ||
    row.kind !== "artifact" ||
    row.scope_kind !== "host_profile" ||
    row.scope_id !== "default" ||
    row.artifact_schema_id !== BROKER_BACKEND_CAPABILITIES_SCHEMA_ID ||
    row.artifact_digest !== expectedDigest
  ) {
    throw new HostStateContractError(
      "installBrokerRoute.capabilityArtifactRef could not be verified",
    );
  }
  try {
    parseRequiredBrokerCapabilitiesArtifact(row.artifact_bytes);
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError(
      "capability artifact bytes are not the exact selected vector",
      { cause: error },
    );
  }
}

function expectedInstallation(
  machineIdentityId: string,
  request: InstallBrokerRouteRequest,
): ExpectedInstallation {
  const digest = exactRequiredCapabilityDigest();
  const routeId = deriveBrokerRouteId(
    machineIdentityId,
    request.fence.collaborationServerId,
    request.routeKind,
    request.logicalChatId,
  );
  const routeToken = deriveBrokerRouteToken(
    machineIdentityId,
    request.fence.collaborationServerId,
    request.routeKind,
    request.logicalChatId,
  );
  const receipt = request.receipt;
  if (
    receipt.route.identityId !== machineIdentityId ||
    receipt.route.collaborationServerId !== request.fence.collaborationServerId ||
    receipt.route.routeKind !== request.routeKind ||
    receipt.route.logicalChatId !== request.logicalChatId ||
    receipt.route.brokerOrigin !== request.brokerOrigin ||
    receipt.route.backendSelector !== request.brokerBackendSelector ||
    receipt.route.brokerRouteId !== routeId ||
    receipt.route.routeToken !== routeToken ||
    !equalBrokerDigest(receipt.route.brokerBackendCapabilitiesDigest, digest) ||
    receipt.genesis.brokerRouteId !== routeId
  ) {
    throw new HostStateContractError(
      "installBrokerRoute.receipt must exactly confirm the selected route and capability pin",
    );
  }
  const pinId = deriveBrokerBackendCapabilityPinId(
    request.brokerOrigin,
    request.brokerBackendSelector,
    digest,
  );
  return frozen({
    pin: parseBrokerBackendCapabilityPinRecord({
      brokerBackendCapabilityPinId: pinId,
      machineIdentityId,
      brokerOrigin: request.brokerOrigin,
      brokerBackendSelector: request.brokerBackendSelector,
      canonicalPayloadSchemaId: BROKER_BACKEND_CAPABILITIES_SCHEMA_ID,
      canonicalPayloadRef: request.capabilityArtifactRef.protectedHandleId,
      canonicalPayloadDigest: digest,
      observedAtMs: request.capabilityObservedAtMs,
    }),
    route: parseBrokerRouteRecord({
      brokerRouteId: routeId,
      machineIdentityId,
      collaborationServerId: request.fence.collaborationServerId,
      routeKind: request.routeKind,
      logicalChatId: request.logicalChatId,
      routeToken,
      brokerOrigin: request.brokerOrigin,
      brokerBackendSelector: request.brokerBackendSelector,
      brokerRouteStoreInstanceId: receipt.route.routeStoreInstanceId,
      genesisGeneration: 0,
      brokerBackendCapabilitiesRef: pinId,
      brokerBackendCapabilitiesDigest: digest,
      coordinatorLeaseId: request.fence.coordinatorLeaseId,
      coordinatorEpoch: request.fence.coordinatorEpoch,
      createdAtMs: request.routeOpenedAtMs,
      state: "current",
    }),
    genesis: parseBrokerChannelGenerationRecord({
      brokerRouteId: routeId,
      channelGeneration: 0,
      frameCount: null,
      nextGeneration: null,
      state: "open",
      manifestDigest: null,
    }),
  });
}

function samePin(
  actual: BrokerBackendCapabilityPinRecord,
  expected: BrokerBackendCapabilityPinRecord,
): boolean {
  return (
    actual.brokerBackendCapabilityPinId === expected.brokerBackendCapabilityPinId &&
    actual.machineIdentityId === expected.machineIdentityId &&
    actual.brokerOrigin === expected.brokerOrigin &&
    actual.brokerBackendSelector === expected.brokerBackendSelector &&
    actual.canonicalPayloadSchemaId === expected.canonicalPayloadSchemaId &&
    actual.canonicalPayloadRef === expected.canonicalPayloadRef &&
    equalBrokerDigest(actual.canonicalPayloadDigest, expected.canonicalPayloadDigest) &&
    actual.observedAtMs === expected.observedAtMs
  );
}

function sameRoute(actual: BrokerRouteRecord, expected: BrokerRouteRecord): boolean {
  return (
    actual.brokerRouteId === expected.brokerRouteId &&
    actual.machineIdentityId === expected.machineIdentityId &&
    actual.collaborationServerId === expected.collaborationServerId &&
    actual.routeKind === expected.routeKind &&
    actual.logicalChatId === expected.logicalChatId &&
    actual.routeToken === expected.routeToken &&
    actual.brokerOrigin === expected.brokerOrigin &&
    actual.brokerBackendSelector === expected.brokerBackendSelector &&
    actual.brokerRouteStoreInstanceId === expected.brokerRouteStoreInstanceId &&
    actual.genesisGeneration === expected.genesisGeneration &&
    actual.brokerBackendCapabilitiesRef === expected.brokerBackendCapabilitiesRef &&
    equalBrokerDigest(
      actual.brokerBackendCapabilitiesDigest,
      expected.brokerBackendCapabilitiesDigest,
    ) &&
    actual.coordinatorLeaseId === expected.coordinatorLeaseId &&
    actual.coordinatorEpoch === expected.coordinatorEpoch &&
    actual.createdAtMs === expected.createdAtMs &&
    actual.state === expected.state
  );
}

function sameGeneration(
  actual: BrokerChannelGenerationRecord,
  expected: BrokerChannelGenerationRecord,
): boolean {
  return (
    actual.brokerRouteId === expected.brokerRouteId &&
    actual.channelGeneration === expected.channelGeneration &&
    actual.frameCount === expected.frameCount &&
    actual.nextGeneration === expected.nextGeneration &&
    actual.state === expected.state &&
    actual.manifestDigest === expected.manifestDigest
  );
}

function readExactInstallation(
  transaction: HostStateRepositorySqlTransaction,
  routeId: BrokerRouteId,
): BrokerRouteInstallationResult | null {
  const route = findRoute(transaction, routeId);
  if (route === null) return null;
  const pin = findPin(transaction, route.brokerBackendCapabilitiesRef);
  const generations = readGenerations(transaction, route.brokerRouteId);
  if (pin === null || generations.length !== 1 || generations[0] === undefined) {
    throw new BrokerRouteRepositoryPersistenceError(
      `route ${route.brokerRouteId} does not have its exact pin and genesis`,
    );
  }
  const genesis = generations[0];
  if (
    genesis.channelGeneration !== 0 ||
    genesis.state !== "open" ||
    genesis.frameCount !== null ||
    genesis.nextGeneration !== null ||
    genesis.manifestDigest !== null
  ) {
    throw new BrokerRouteRepositoryPersistenceError(
      `route ${route.brokerRouteId} does not have an empty open genesis`,
    );
  }
  validateCapabilityArtifact(transaction, pin);
  return frozen({ capabilityPin: pin, route, genesis, replayed: true });
}

function assertExactExisting(
  transaction: HostStateRepositorySqlTransaction,
  expected: ExpectedInstallation,
): BrokerRouteInstallationResult | null {
  const existing = readExactInstallation(transaction, expected.route.brokerRouteId);
  if (existing === null) return null;
  if (
    !samePin(existing.capabilityPin, expected.pin) ||
    !sameRoute(existing.route, expected.route) ||
    !sameGeneration(existing.genesis, expected.genesis)
  ) {
    throw new BrokerRouteRepositoryConflictError(
      "deterministic route identity already names different durable fields",
    );
  }
  return existing;
}

function insertPin(
  transaction: HostStateRepositorySqlTransaction,
  pin: BrokerBackendCapabilityPinRecord,
): void {
  runExactlyOne(
    transaction,
    `INSERT INTO broker_backend_capability_pins (
      broker_backend_capability_pin_id, machine_identity_id, broker_origin,
      broker_backend_selector, canonical_payload_schema_id, canonical_payload_ref,
      canonical_payload_digest, observed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pin.brokerBackendCapabilityPinId,
      pin.machineIdentityId,
      pin.brokerOrigin,
      pin.brokerBackendSelector,
      pin.canonicalPayloadSchemaId,
      pin.canonicalPayloadRef,
      pin.canonicalPayloadDigest,
      pin.observedAtMs,
    ],
    "capability pin insert",
  );
}

function insertRoute(
  transaction: HostStateRepositorySqlTransaction,
  route: BrokerRouteRecord,
): void {
  runExactlyOne(
    transaction,
    `INSERT INTO broker_routes (
      broker_route_id, machine_identity_id, collaboration_server_id, route_kind,
      logical_chat_id, route_token, broker_origin, broker_backend_selector,
      broker_route_store_instance_id, genesis_generation,
      broker_backend_capabilities_ref, broker_backend_capabilities_digest,
      coordinator_lease_id, coordinator_epoch, created_at_ms, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      route.brokerRouteId,
      route.machineIdentityId,
      route.collaborationServerId,
      route.routeKind,
      route.logicalChatId,
      route.routeToken,
      route.brokerOrigin,
      route.brokerBackendSelector,
      route.brokerRouteStoreInstanceId,
      route.genesisGeneration,
      route.brokerBackendCapabilitiesRef,
      route.brokerBackendCapabilitiesDigest,
      route.coordinatorLeaseId,
      route.coordinatorEpoch,
      route.createdAtMs,
      route.state,
    ],
    "route insert",
  );
}

function insertGenesis(
  transaction: HostStateRepositorySqlTransaction,
  genesis: BrokerChannelGenerationRecord,
): void {
  runExactlyOne(
    transaction,
    `INSERT INTO broker_channel_generations (
      broker_route_id, channel_generation, frame_count, next_generation, state, manifest_digest
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      genesis.brokerRouteId,
      genesis.channelGeneration,
      genesis.frameCount,
      genesis.nextGeneration,
      genesis.state,
      genesis.manifestDigest,
    ],
    "genesis insert",
  );
}

function readInventoryTransaction(
  transaction: HostStateRepositorySqlTransaction,
): BrokerRouteInventory {
  return frozen({
    capabilityPins: Object.freeze(
      sqlAll(
        transaction,
        `SELECT ${PIN_ROW_KEYS.join(", ")} FROM broker_backend_capability_pins
         ORDER BY broker_backend_capability_pin_id`,
      ).map(pinFromRow),
    ),
    routes: Object.freeze(
      sqlAll(
        transaction,
        `SELECT ${ROUTE_ROW_KEYS.join(", ")} FROM broker_routes ORDER BY broker_route_id`,
      ).map(routeFromRow),
    ),
    generations: Object.freeze(
      sqlAll(
        transaction,
        `SELECT ${GENERATION_ROW_KEYS.join(", ")} FROM broker_channel_generations
         ORDER BY broker_route_id, channel_generation`,
      ).map(generationFromRow),
    ),
  });
}

class BoundBrokerRouteRepository implements BrokerRouteRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #nowMs: () => number;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    options: BrokerRouteRepositoryOptions = {},
  ) {
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#nowMs = options.nowMs ?? Date.now;
    Object.freeze(this);
  }

  install(request: InstallBrokerRouteRequest): BrokerRouteInstallationResult {
    const parsed = parseInstallBrokerRouteRequest(request);
    const expected = expectedInstallation(this.#machineIdentityId, parsed);
    return this.#executor.transaction((transaction) => {
      assertCurrentAuthority(transaction, this.#machineIdentityId, parsed, this.#nowMs);
      assertRouteScope(transaction, parsed);
      readAndVerifyCapabilityArtifact(transaction, parsed, expected.pin.canonicalPayloadDigest);
      const existing = assertExactExisting(transaction, expected);
      if (existing !== null) return existing;
      const storeOwner = findRouteByStore(transaction, expected.route.brokerRouteStoreInstanceId);
      if (storeOwner !== null) {
        throw new BrokerRouteRepositoryConflictError(
          "broker route store instance is already retained by another route",
        );
      }
      const existingPin = findPin(transaction, expected.pin.brokerBackendCapabilityPinId);
      if (existingPin === null) {
        insertPin(transaction, expected.pin);
      } else if (!samePin(existingPin, expected.pin)) {
        throw new BrokerRouteRepositoryConflictError(
          "deterministic capability pin identity already names different durable fields",
        );
      }
      insertRoute(transaction, expected.route);
      insertGenesis(transaction, expected.genesis);
      return frozen({
        capabilityPin: expected.pin,
        route: expected.route,
        genesis: expected.genesis,
        replayed: false,
      });
    });
  }

  reconcileInstall(request: InstallBrokerRouteRequest): BrokerRouteInstallationResult | null {
    const parsed = parseInstallBrokerRouteRequest(request);
    const expected = expectedInstallation(this.#machineIdentityId, parsed);
    return this.#executor.transaction((transaction) => {
      const existing = assertExactExisting(transaction, expected);
      if (existing === null) return null;
      readAndVerifyCapabilityArtifact(transaction, parsed, expected.pin.canonicalPayloadDigest);
      return existing;
    });
  }

  readInstallation(brokerRouteId: BrokerRouteId): BrokerRouteInstallationResult | null {
    const routeId = parseBrokerRouteId(brokerRouteId, "brokerRoute.readInstallation.brokerRouteId");
    return this.#executor.transaction((transaction) => readExactInstallation(transaction, routeId));
  }

  readRoute(brokerRouteId: BrokerRouteId): BrokerRouteRecord | null {
    const routeId = parseBrokerRouteId(brokerRouteId, "brokerRoute.readRoute.brokerRouteId");
    return this.#executor.transaction((transaction) => findRoute(transaction, routeId));
  }

  readCapabilityPin(
    brokerBackendCapabilityPinId: BrokerBackendCapabilityPinId,
  ): BrokerBackendCapabilityPinRecord | null {
    const pinId = parseBrokerBackendCapabilityPinId(
      brokerBackendCapabilityPinId,
      "brokerRoute.readCapabilityPin.brokerBackendCapabilityPinId",
    );
    return this.#executor.transaction((transaction) => findPin(transaction, pinId));
  }

  readInventory(): BrokerRouteInventory {
    return this.#executor.transaction(readInventoryTransaction);
  }
}

export function createBrokerRouteRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  options: BrokerRouteRepositoryOptions = {},
): BrokerRouteRepositoryOperations {
  return new BoundBrokerRouteRepository(
    { transaction: (operation) => operation(transaction) },
    machineIdentityId,
    options,
  );
}

export function createBrokerRouteRepositoryOperations(
  executor: HostStateRepositoryTransactionExecutor,
  machineIdentityId: string,
  options: BrokerRouteRepositoryOptions = {},
): BrokerRouteRepositoryOperations {
  return new BoundBrokerRouteRepository(executor, machineIdentityId, options);
}

function snapshotAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BrokerRouteRepositoryPersistenceError(message);
}

function artifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function validateCapabilityArtifact(
  transaction: HostStateRepositorySqlTransaction,
  pin: BrokerBackendCapabilityPinRecord,
): void {
  const value = sqlGet(
    transaction,
    `SELECT ${ARTIFACT_ROW_KEYS.join(", ")} FROM protected_artifacts
      WHERE protected_handle_id = ? LIMIT 1`,
    [pin.canonicalPayloadRef],
  );
  snapshotAssert(
    value !== undefined,
    `capability pin ${pin.brokerBackendCapabilityPinId} is dangling`,
  );
  let row: ReturnType<typeof parseExactRecord>;
  try {
    row = parseExactRecord(value, ARTIFACT_ROW_KEYS, "brokerCapabilityArtifactRow");
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError("capability artifact row is invalid", {
      cause: error,
    });
  }
  snapshotAssert(
    row.protected_handle_id === pin.canonicalPayloadRef &&
      row.kind === "artifact" &&
      row.scope_kind === "host_profile" &&
      row.scope_id === "default" &&
      row.artifact_schema_id === pin.canonicalPayloadSchemaId &&
      row.artifact_digest === pin.canonicalPayloadDigest &&
      row.artifact_bytes instanceof Uint8Array &&
      row.byte_length === row.artifact_bytes.byteLength &&
      artifactDigest(row.artifact_bytes) === pin.canonicalPayloadDigest,
    `capability pin ${pin.brokerBackendCapabilityPinId} does not bind its exact artifact`,
  );
  try {
    parseRequiredBrokerCapabilitiesArtifact(row.artifact_bytes);
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError(
      `capability pin ${pin.brokerBackendCapabilityPinId} does not bind canonical capability bytes`,
      { cause: error },
    );
  }
}

function assertHistoricalAuthority(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  route: BrokerRouteRecord,
  allowCertifiedServer: boolean,
): void {
  const value = sqlGet(
    transaction,
    `SELECT server.machine_identity_id, server.state AS server_state, lease.acquired_at_ms,
            lease.heartbeat_deadline_ms, lease.released_at_ms
       FROM collaboration_servers AS server
       JOIN coordinator_leases AS lease
         ON lease.collaboration_server_id = server.collaboration_server_id
        AND lease.coordinator_lease_id = ?
        AND lease.coordinator_epoch = ?
      WHERE server.collaboration_server_id = ? LIMIT 1`,
    [route.coordinatorLeaseId, route.coordinatorEpoch, route.collaborationServerId],
  );
  snapshotAssert(value !== undefined, `route ${route.brokerRouteId} has no coordinator lifetime`);
  let row: ReturnType<typeof parseExactRecord>;
  let acquiredAtMs: number;
  let heartbeatDeadlineMs: number;
  let releasedAtMs: number | null;
  try {
    row = parseExactRecord(
      value,
      [
        "machine_identity_id",
        "server_state",
        "acquired_at_ms",
        "heartbeat_deadline_ms",
        "released_at_ms",
      ] as const,
      "brokerRouteHistoricalAuthorityRow",
    );
    acquiredAtMs = parseNonNegativeSafeInteger(
      row.acquired_at_ms,
      "brokerRouteHistoricalAuthority.acquiredAtMs",
    );
    heartbeatDeadlineMs = parseNonNegativeSafeInteger(
      row.heartbeat_deadline_ms,
      "brokerRouteHistoricalAuthority.heartbeatDeadlineMs",
    );
    releasedAtMs =
      row.released_at_ms === null
        ? null
        : parseNonNegativeSafeInteger(
            row.released_at_ms,
            "brokerRouteHistoricalAuthority.releasedAtMs",
          );
  } catch (error) {
    throw new BrokerRouteRepositoryPersistenceError(
      `route ${route.brokerRouteId} has an invalid coordinator lifetime`,
      { cause: error },
    );
  }
  snapshotAssert(
    row.machine_identity_id === machineIdentityId &&
      (row.server_state === "installing" ||
        (allowCertifiedServer && row.server_state === "current")) &&
      acquiredAtMs <= route.createdAtMs &&
      route.createdAtMs < heartbeatDeadlineMs &&
      (releasedAtMs === null || route.createdAtMs <= releasedAtMs),
    `route ${route.brokerRouteId} was not created within its coordinator lifetime`,
  );
}

/** Validate the complete dormant schema-v7 broker-route graph in one coherent snapshot. */
export function validateBrokerRouteRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  schemaVersion: number,
): void {
  const machineId = parseMachineIdentityId(machineIdentityId);
  if (schemaVersion < 7) {
    throw new BrokerRouteRepositoryPersistenceError(
      `schema version ${String(schemaVersion)} cannot contain schema-v7 broker routes`,
    );
  }
  const inventory = readInventoryTransaction(transaction);
  if (inventory.capabilityPins.length > 0) {
    const profile = sqlGet(
      transaction,
      `SELECT machine_identity_id FROM host_state_profiles
        WHERE state_profile_id = 'default' LIMIT 1`,
    );
    snapshotAssert(profile !== undefined, "the default host profile is missing");
    let profileRow: ReturnType<typeof parseExactRecord>;
    try {
      profileRow = parseExactRecord(
        profile,
        ["machine_identity_id"] as const,
        "brokerRouteHostProfileRow",
      );
    } catch (error) {
      throw new BrokerRouteRepositoryPersistenceError("the default host profile is invalid", {
        cause: error,
      });
    }
    snapshotAssert(
      profileRow.machine_identity_id === machineId,
      "the default host profile does not match host metadata",
    );
  }
  const pins = new Map(
    inventory.capabilityPins.map((pin) => [pin.brokerBackendCapabilityPinId, pin] as const),
  );
  const routes = new Map(inventory.routes.map((route) => [route.brokerRouteId, route] as const));
  snapshotAssert(
    pins.size === inventory.capabilityPins.length && routes.size === inventory.routes.length,
    "broker capability pin or route identities are duplicated",
  );
  const requiredDigest = exactRequiredCapabilityDigest();
  const referencedPins = new Set<string>();
  const routeTuples = new Set<string>();
  const routeTokens = new Set<string>();
  const storeIds = new Set<string>();
  for (const pin of inventory.capabilityPins) {
    snapshotAssert(
      pin.machineIdentityId === machineId &&
        pin.canonicalPayloadSchemaId === BROKER_BACKEND_CAPABILITIES_SCHEMA_ID &&
        equalBrokerDigest(pin.canonicalPayloadDigest, requiredDigest) &&
        pin.brokerBackendCapabilityPinId ===
          deriveBrokerBackendCapabilityPinId(
            pin.brokerOrigin,
            pin.brokerBackendSelector,
            pin.canonicalPayloadDigest,
          ),
      `capability pin ${pin.brokerBackendCapabilityPinId} is noncanonical`,
    );
    validateCapabilityArtifact(transaction, pin);
  }
  const generationsByRoute = new Map<string, BrokerChannelGenerationRecord[]>();
  for (const generation of inventory.generations) {
    const group = generationsByRoute.get(generation.brokerRouteId) ?? [];
    group.push(generation);
    generationsByRoute.set(generation.brokerRouteId, group);
    snapshotAssert(
      routes.has(generation.brokerRouteId),
      `generation for ${generation.brokerRouteId} is dangling`,
    );
  }
  for (const route of inventory.routes) {
    const pin = pins.get(route.brokerBackendCapabilitiesRef);
    snapshotAssert(pin !== undefined, `route ${route.brokerRouteId} has no capability pin`);
    referencedPins.add(pin.brokerBackendCapabilityPinId);
    snapshotAssert(
      route.machineIdentityId === machineId &&
        route.state === "current" &&
        route.genesisGeneration === 0 &&
        route.brokerRouteId ===
          deriveBrokerRouteId(
            machineId,
            route.collaborationServerId,
            route.routeKind,
            route.logicalChatId,
          ) &&
        route.routeToken ===
          deriveBrokerRouteToken(
            machineId,
            route.collaborationServerId,
            route.routeKind,
            route.logicalChatId,
          ) &&
        route.brokerOrigin === pin.brokerOrigin &&
        route.brokerBackendSelector === pin.brokerBackendSelector &&
        equalBrokerDigest(route.brokerBackendCapabilitiesDigest, pin.canonicalPayloadDigest) &&
        pin.observedAtMs <= route.createdAtMs,
      `route ${route.brokerRouteId} does not exactly bind its address and capability pin`,
    );
    const tuple = `${route.machineIdentityId}\u0000${route.collaborationServerId}\u0000${route.routeKind}\u0000${route.logicalChatId ?? ""}`;
    snapshotAssert(!routeTuples.has(tuple), `route tuple ${tuple} is duplicated`);
    snapshotAssert(
      !routeTokens.has(route.routeToken),
      `route token ${route.routeToken} is duplicated`,
    );
    snapshotAssert(
      !storeIds.has(route.brokerRouteStoreInstanceId),
      `route store ${route.brokerRouteStoreInstanceId} is duplicated`,
    );
    routeTuples.add(tuple);
    routeTokens.add(route.routeToken);
    storeIds.add(route.brokerRouteStoreInstanceId);
    const generations = generationsByRoute.get(route.brokerRouteId) ?? [];
    snapshotAssert(
      generations.length === 1 &&
        generations[0]?.channelGeneration === 0 &&
        generations[0].state === "open" &&
        generations[0].frameCount === null &&
        generations[0].nextGeneration === null &&
        generations[0].manifestDigest === null,
      `route ${route.brokerRouteId} must have exactly one empty open genesis`,
    );
    assertHistoricalAuthority(transaction, machineId, route, schemaVersion >= 9);
    const scope = sqlGet(
      transaction,
      route.routeKind === "chat"
        ? `SELECT state FROM logical_chats
            WHERE collaboration_server_id = ? AND logical_chat_id = ? LIMIT 1`
        : `SELECT state FROM collaboration_servers
            WHERE collaboration_server_id = ? AND machine_identity_id = ? LIMIT 1`,
      route.routeKind === "chat"
        ? [route.collaborationServerId, route.logicalChatId]
        : [route.collaborationServerId, machineId],
    );
    snapshotAssert(scope !== undefined, `route ${route.brokerRouteId} has a dangling scope`);
    const scopeRow = parseExactRecord(scope, ["state"] as const, "brokerRouteScopeRow");
    snapshotAssert(
      route.routeKind === "chat"
        ? scopeRow.state === "recovering" || scopeRow.state === "ready"
        : scopeRow.state === "installing" || (schemaVersion >= 9 && scopeRow.state === "current"),
      `route ${route.brokerRouteId} is attached to an invalid scope state`,
    );
  }
  snapshotAssert(
    referencedPins.size === inventory.capabilityPins.length,
    "broker capability pins must each be referenced by at least one route",
  );
  snapshotAssert(
    generationsByRoute.size === inventory.routes.length,
    "broker generations and routes must form an exact closed set",
  );
}
