import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { base64urlEncode, CanonicalWriter, deriveIdentity, toHex } from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
} from "../state/ids.js";
import type {
  AcquireRuntimeOwnerServiceLeaseRequest,
  AcquireRuntimeOwnerServiceLeaseResult,
  ReleaseRuntimeOwnerServiceLeaseRequest,
  ReleaseRuntimeOwnerServiceLeaseResult,
  RenewRuntimeOwnerServiceLeaseRequest,
  RenewRuntimeOwnerServiceLeaseResult,
  RuntimeOwnerInventory,
  RuntimeOwnerOperationEvidence,
} from "../state/runtime-repository.js";
import {
  HostStateCommitOutcomeUnknownError,
  type HostStateDatabase,
  type OpenHostStateDatabaseOptions,
  openHostStateDatabase,
} from "../state/sqlite.js";
import { bootstrapRuntimeOwner, type RuntimeOwnerDetachedSpawnRequest } from "./bootstrap.js";
import type { RuntimeOwnerRpcClient } from "./client.js";
import { type RuntimeOwnerDaemon, startRuntimeOwnerDaemon } from "./daemon.js";
import {
  RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
  type RuntimeOwnerKeyCustodySigningCapability,
  type WrappedRuntimeOwnerPrivateKey,
} from "./key-custody.js";
import {
  type HostStateDatabaseFactory,
  RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID,
  type RuntimeOwnerKeyCustodyValidator,
  type RuntimeOwnerLease,
  type RuntimeOwnerLeaseAcquireRequest,
  type RuntimeOwnerLeaseController,
  type RuntimeOwnerLeaseHeartbeatRequest,
  type RuntimeOwnerLeaseReleaseRequest,
} from "./service.js";

const RUNTIME_OWNER_SERVICE_LEASE_ACQUIRE_OPERATION_SCHEMA_ID =
  "remote-claw/runtime-owner-service-lease-acquire/v1" as const;
const RUNTIME_OWNER_SERVICE_LEASE_RELEASE_OPERATION_SCHEMA_ID =
  "remote-claw/runtime-owner-service-lease-release/v1" as const;

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_STATE_HOME",
] as const);

type OpenDatabase = (options: OpenHostStateDatabaseOptions) => HostStateDatabase;

interface ProductionRuntimeOwnerDatabaseFactoryOptions {
  readonly pathEnvironment?: OpenHostStateDatabaseOptions["pathEnvironment"];
  readonly openDatabase?: OpenDatabase;
}

/**
 * Service-lifetime state handle. An unknown COMMIT poisons the underlying SQLite handle, so the
 * adapter must close that exact handle before it may reopen and perform read-side reconciliation.
 */
class ProductionRuntimeOwnerDatabase {
  readonly machineIdentityId: string;
  readonly #openDatabase: OpenDatabase;
  readonly #pathEnvironment: OpenHostStateDatabaseOptions["pathEnvironment"] | undefined;
  #database: HostStateDatabase | undefined;
  #closed = false;
  #recoveryBlocked = false;

  constructor(
    machineIdentityId: string,
    options: ProductionRuntimeOwnerDatabaseFactoryOptions = {},
  ) {
    this.machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#openDatabase = options.openDatabase ?? openHostStateDatabase;
    this.#pathEnvironment = options.pathEnvironment;
    this.#database = this.#open();
  }

  use<T>(operation: (database: HostStateDatabase) => T): T {
    if (this.#closed || this.#recoveryBlocked || this.#database === undefined) {
      throw new RuntimeOwnerProductionRecoveryError("DATABASE_UNAVAILABLE");
    }
    return operation(this.#database);
  }

  /** Close the poisoned handle completely, then reopen the same identity namespace. */
  reopenAfterUnknownCommit(): void {
    if (this.#closed || this.#recoveryBlocked || this.#database === undefined) {
      throw new RuntimeOwnerProductionRecoveryError("DATABASE_UNAVAILABLE");
    }
    const poisoned = this.#database;
    try {
      poisoned.close();
    } catch (error) {
      this.#recoveryBlocked = true;
      throw new RuntimeOwnerProductionRecoveryError("DATABASE_CLOSE_FAILED", { cause: error });
    }
    this.#database = undefined;
    try {
      this.#database = this.#open();
    } catch (error) {
      this.#recoveryBlocked = true;
      throw new RuntimeOwnerProductionRecoveryError("DATABASE_REOPEN_FAILED", { cause: error });
    }
  }

  close(): void {
    if (this.#closed) return;
    const database = this.#database;
    if (database === undefined) {
      this.#closed = true;
      return;
    }
    database.close();
    this.#database = undefined;
    this.#closed = true;
  }

  #open(): HostStateDatabase {
    return this.#openDatabase({
      machineIdentityId: this.machineIdentityId,
      ...(this.#pathEnvironment === undefined ? {} : { pathEnvironment: this.#pathEnvironment }),
    });
  }
}

class RuntimeOwnerProductionRecoveryError extends Error {
  readonly code:
    | "DATABASE_UNAVAILABLE"
    | "DATABASE_CLOSE_FAILED"
    | "DATABASE_REOPEN_FAILED"
    | "COMMIT_NOT_RECONCILED"
    | "RESULT_MISMATCH";

  constructor(
    code:
      | "DATABASE_UNAVAILABLE"
      | "DATABASE_CLOSE_FAILED"
      | "DATABASE_REOPEN_FAILED"
      | "COMMIT_NOT_RECONCILED"
      | "RESULT_MISMATCH",
    options?: ErrorOptions,
  ) {
    super("runtime owner durable state could not be reconciled", options);
    this.name = "RuntimeOwnerProductionRecoveryError";
    this.code = code;
  }
}

function createProductionRuntimeOwnerDatabaseFactory(
  options: ProductionRuntimeOwnerDatabaseFactoryOptions = {},
): HostStateDatabaseFactory<ProductionRuntimeOwnerDatabase> {
  return Object.freeze({
    open: (machineIdentityId: string) =>
      new ProductionRuntimeOwnerDatabase(machineIdentityId, options),
  });
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result <= left) {
    throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
  }
  return result;
}

function canonicalDigest(writer: CanonicalWriter): A1Digest {
  return parseA1Digest(base64urlEncode(createHash("sha256").update(writer.finish()).digest()));
}

async function assertSecretMatchesMachineIdentity(
  machineIdentityId: string,
  secret: Uint8Array,
): Promise<void> {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) {
    throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
  }
  const expected = parseMachineIdentityId(machineIdentityId);
  const identity = await deriveIdentity(secret);
  try {
    if (toHex(identity.identityId) !== expected) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
  } finally {
    identity.authToken.fill(0);
    identity.identityId.fill(0);
    identity.contentRoot.fill(0);
    identity.controlKey.fill(0);
    identity.kMeta.fill(0);
  }
}

function acquireOperation(
  machineIdentityId: string,
  request: RuntimeOwnerLeaseAcquireRequest,
  expectedCurrentLeaseId: A1SafeId | null,
  expectedEpoch: number,
): RuntimeOwnerOperationEvidence {
  const operationId = parseA1SafeId(`roop_acquire:${request.candidateLeaseId}`);
  const writer = new CanonicalWriter();
  writer.str(RUNTIME_OWNER_SERVICE_LEASE_ACQUIRE_OPERATION_SCHEMA_ID);
  writer.str(machineIdentityId);
  writer.str(request.candidateLeaseId);
  writer.str(request.ownerInstanceId);
  writer.str(request.ownerStartIdentitySchemaId);
  writer.str(request.ownerStartIdentityRef);
  writer.str(request.ownerStartIdentityDigest);
  writer.str(expectedCurrentLeaseId ?? "");
  writer.uint(expectedEpoch);
  writer.uint(request.leaseDurationMs);
  return Object.freeze({
    operationId,
    operationSchemaId: RUNTIME_OWNER_SERVICE_LEASE_ACQUIRE_OPERATION_SCHEMA_ID,
    operationDigest: canonicalDigest(writer),
  });
}

function ownerFence(
  request: RuntimeOwnerLeaseHeartbeatRequest | RuntimeOwnerLeaseReleaseRequest,
): RenewRuntimeOwnerServiceLeaseRequest["fence"] {
  return Object.freeze({
    runtimeOwnerServiceLeaseId: parseA1SafeId(request.runtimeOwnerServiceLeaseId),
    runtimeOwnerServiceEpoch: request.runtimeOwnerServiceEpoch,
    ownerInstanceId: parseA1SafeId(request.ownerInstanceId),
    ownerProcessStartIdentitySchemaId: request.ownerStartIdentitySchemaId,
    ownerProcessStartIdentityRef: parseA1SafeId(request.ownerStartIdentityRef),
    ownerProcessStartIdentityDigest: parseA1Digest(request.ownerStartIdentityDigest),
  });
}

function releaseOperation(
  machineIdentityId: string,
  request: RuntimeOwnerLeaseReleaseRequest,
): RuntimeOwnerOperationEvidence {
  const operationId = parseA1SafeId(`roop_release:${request.runtimeOwnerServiceLeaseId}`);
  const writer = new CanonicalWriter();
  writer.str(RUNTIME_OWNER_SERVICE_LEASE_RELEASE_OPERATION_SCHEMA_ID);
  writer.str(machineIdentityId);
  writer.str(request.runtimeOwnerServiceLeaseId);
  writer.uint(request.runtimeOwnerServiceEpoch);
  writer.str(request.ownerInstanceId);
  writer.str(request.ownerStartIdentitySchemaId);
  writer.str(request.ownerStartIdentityRef);
  writer.str(request.ownerStartIdentityDigest);
  return Object.freeze({
    operationId,
    operationSchemaId: RUNTIME_OWNER_SERVICE_LEASE_RELEASE_OPERATION_SCHEMA_ID,
    operationDigest: canonicalDigest(writer),
  });
}

function serviceLease(lease: AcquireRuntimeOwnerServiceLeaseResult["lease"]): RuntimeOwnerLease {
  if (
    lease.ownerProcessStartIdentitySchemaId !== RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID
  ) {
    throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
  }
  return Object.freeze({
    machineIdentityId: lease.machineIdentityId,
    runtimeOwnerServiceLeaseId: lease.runtimeOwnerServiceLeaseId,
    runtimeOwnerServiceEpoch: lease.runtimeOwnerServiceEpoch,
    ownerInstanceId: lease.ownerInstanceId,
    ownerStartIdentitySchemaId: RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID,
    ownerStartIdentityRef: lease.ownerProcessStartIdentityRef,
    ownerStartIdentityDigest: lease.ownerProcessStartIdentityDigest,
    heartbeatDeadlineMs: lease.heartbeatDeadlineMs,
  });
}

function sameOperation(
  actual: RuntimeOwnerOperationEvidence,
  expected: RuntimeOwnerOperationEvidence,
): boolean {
  return (
    actual.operationId === expected.operationId &&
    actual.operationSchemaId === expected.operationSchemaId &&
    actual.operationDigest === expected.operationDigest
  );
}

function assertAcquireResult(
  machineIdentityId: string,
  request: AcquireRuntimeOwnerServiceLeaseRequest,
  result: AcquireRuntimeOwnerServiceLeaseResult,
): RuntimeOwnerLease {
  const lease = result.lease;
  if (
    !result.isCurrent ||
    !result.unexpired ||
    lease.state !== "current" ||
    lease.releasedAtMs !== null ||
    lease.machineIdentityId !== machineIdentityId ||
    lease.runtimeOwnerServiceLeaseId !== request.candidateLeaseId ||
    lease.runtimeOwnerServiceEpoch !== request.expectedRuntimeOwnerServiceEpoch + 1 ||
    lease.ownerInstanceId !== request.ownerInstanceId ||
    lease.ownerProcessStartIdentitySchemaId !== request.ownerProcessStartIdentitySchemaId ||
    lease.ownerProcessStartIdentityRef !== request.ownerProcessStartIdentityRef ||
    lease.ownerProcessStartIdentityDigest !== request.ownerProcessStartIdentityDigest ||
    lease.heartbeatDeadlineMs - lease.acquiredAtMs !== request.leaseDurationMs ||
    result.journalEntry.entryKind !== "service_lease_acquired" ||
    result.journalEntry.subjectKind !== "service_lease" ||
    result.journalEntry.subjectId !== lease.runtimeOwnerServiceLeaseId ||
    !sameOperation(result.journalEntry, request.operation) ||
    result.journalEntry.runtimeOwnerServiceLeaseId !== lease.runtimeOwnerServiceLeaseId ||
    result.journalEntry.runtimeOwnerServiceEpoch !== lease.runtimeOwnerServiceEpoch
  ) {
    throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
  }
  return serviceLease(lease);
}

function assertRenewResult(
  machineIdentityId: string,
  request: RenewRuntimeOwnerServiceLeaseRequest,
  result: RenewRuntimeOwnerServiceLeaseResult,
): RuntimeOwnerLease {
  const lease = result.lease;
  if (
    lease.machineIdentityId !== machineIdentityId ||
    lease.runtimeOwnerServiceLeaseId !== request.fence.runtimeOwnerServiceLeaseId ||
    lease.runtimeOwnerServiceEpoch !== request.fence.runtimeOwnerServiceEpoch ||
    lease.ownerInstanceId !== request.fence.ownerInstanceId ||
    lease.ownerProcessStartIdentitySchemaId !== request.fence.ownerProcessStartIdentitySchemaId ||
    lease.ownerProcessStartIdentityRef !== request.fence.ownerProcessStartIdentityRef ||
    lease.ownerProcessStartIdentityDigest !== request.fence.ownerProcessStartIdentityDigest ||
    lease.state !== "current" ||
    lease.releasedAtMs !== null ||
    lease.heartbeatDeadlineMs !== request.newHeartbeatDeadlineMs
  ) {
    throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
  }
  return serviceLease(lease);
}

function assertReleaseResult(
  machineIdentityId: string,
  request: ReleaseRuntimeOwnerServiceLeaseRequest,
  result: ReleaseRuntimeOwnerServiceLeaseResult,
): void {
  const lease = result.lease;
  if (
    lease.machineIdentityId !== machineIdentityId ||
    lease.runtimeOwnerServiceLeaseId !== request.fence.runtimeOwnerServiceLeaseId ||
    lease.runtimeOwnerServiceEpoch !== request.fence.runtimeOwnerServiceEpoch ||
    lease.ownerInstanceId !== request.fence.ownerInstanceId ||
    lease.ownerProcessStartIdentitySchemaId !== request.fence.ownerProcessStartIdentitySchemaId ||
    lease.ownerProcessStartIdentityRef !== request.fence.ownerProcessStartIdentityRef ||
    lease.ownerProcessStartIdentityDigest !== request.fence.ownerProcessStartIdentityDigest ||
    lease.state !== "released" ||
    lease.releasedAtMs === null ||
    result.journalEntry.entryKind !== "service_lease_released" ||
    result.journalEntry.subjectKind !== "service_lease" ||
    result.journalEntry.subjectId !== lease.runtimeOwnerServiceLeaseId ||
    !sameOperation(result.journalEntry, request.operation) ||
    result.journalEntry.runtimeOwnerServiceLeaseId !== lease.runtimeOwnerServiceLeaseId ||
    result.journalEntry.runtimeOwnerServiceEpoch !== lease.runtimeOwnerServiceEpoch
  ) {
    throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
  }
}

function inventoryCurrentLease(
  inventory: RuntimeOwnerInventory,
  request: RenewRuntimeOwnerServiceLeaseRequest,
): AcquireRuntimeOwnerServiceLeaseResult["lease"] | null {
  if (
    inventory.state.currentRuntimeOwnerServiceEpoch !== request.fence.runtimeOwnerServiceEpoch ||
    inventory.state.currentRuntimeOwnerServiceLeaseId !== request.fence.runtimeOwnerServiceLeaseId
  ) {
    return null;
  }
  return (
    inventory.serviceLeases.find(
      (lease) =>
        lease.runtimeOwnerServiceLeaseId === request.fence.runtimeOwnerServiceLeaseId &&
        lease.runtimeOwnerServiceEpoch === request.fence.runtimeOwnerServiceEpoch,
    ) ?? null
  );
}

class ProductionRuntimeOwnerLeaseController
  implements RuntimeOwnerLeaseController<ProductionRuntimeOwnerDatabase>
{
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  acquireOrReconcile(
    database: ProductionRuntimeOwnerDatabase,
    request: RuntimeOwnerLeaseAcquireRequest,
  ): RuntimeOwnerLease {
    const machineIdentityId = parseMachineIdentityId(request.machineIdentityId);
    if (machineIdentityId !== database.machineIdentityId) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
    const state = database.use((current) => current.runtimeOwner.readInventory().state);
    const operation = acquireOperation(
      machineIdentityId,
      request,
      state.currentRuntimeOwnerServiceLeaseId,
      state.currentRuntimeOwnerServiceEpoch,
    );
    const repositoryRequest: AcquireRuntimeOwnerServiceLeaseRequest = Object.freeze({
      candidateLeaseId: parseA1SafeId(request.candidateLeaseId),
      ownerInstanceId: parseA1SafeId(request.ownerInstanceId),
      ownerProcessStartIdentitySchemaId: request.ownerStartIdentitySchemaId,
      ownerProcessStartIdentityRef: parseA1SafeId(request.ownerStartIdentityRef),
      ownerProcessStartIdentityDigest: parseA1Digest(request.ownerStartIdentityDigest),
      expectedCurrentLeaseId: state.currentRuntimeOwnerServiceLeaseId,
      expectedRuntimeOwnerServiceEpoch: state.currentRuntimeOwnerServiceEpoch,
      leaseDurationMs: request.leaseDurationMs,
      operation,
    });
    try {
      return assertAcquireResult(
        machineIdentityId,
        repositoryRequest,
        database.use((current) => current.runtimeOwner.acquireServiceLease(repositoryRequest)),
      );
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      database.reopenAfterUnknownCommit();
      const reconciled = database.use((current) =>
        current.runtimeOwner.reconcileServiceLeaseAcquisition(repositoryRequest),
      );
      if (reconciled === null) {
        throw new RuntimeOwnerProductionRecoveryError("COMMIT_NOT_RECONCILED", { cause: error });
      }
      return assertAcquireResult(machineIdentityId, repositoryRequest, reconciled);
    }
  }

  heartbeatOrReconcile(
    database: ProductionRuntimeOwnerDatabase,
    request: RuntimeOwnerLeaseHeartbeatRequest,
  ): RuntimeOwnerLease {
    const machineIdentityId = parseMachineIdentityId(request.machineIdentityId);
    if (machineIdentityId !== database.machineIdentityId) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
    const repositoryRequest: RenewRuntimeOwnerServiceLeaseRequest = Object.freeze({
      fence: ownerFence(request),
      expectedHeartbeatDeadlineMs: request.expectedHeartbeatDeadlineMs,
      newHeartbeatDeadlineMs: checkedAdd(now, request.leaseDurationMs),
    });
    if (repositoryRequest.newHeartbeatDeadlineMs <= request.expectedHeartbeatDeadlineMs) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
    try {
      return assertRenewResult(
        machineIdentityId,
        repositoryRequest,
        database.use((current) => current.runtimeOwner.renewServiceLease(repositoryRequest)),
      );
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      database.reopenAfterUnknownCommit();
      const inventory = database.use((current) => current.runtimeOwner.readInventory());
      const reconciled = inventoryCurrentLease(inventory, repositoryRequest);
      if (
        reconciled === null ||
        reconciled.heartbeatDeadlineMs !== repositoryRequest.newHeartbeatDeadlineMs
      ) {
        throw new RuntimeOwnerProductionRecoveryError("COMMIT_NOT_RECONCILED", { cause: error });
      }
      return assertRenewResult(
        machineIdentityId,
        repositoryRequest,
        Object.freeze({ lease: reconciled, replayed: true }),
      );
    }
  }

  releaseOrReconcile(
    database: ProductionRuntimeOwnerDatabase,
    request: RuntimeOwnerLeaseReleaseRequest,
  ): void {
    const machineIdentityId = parseMachineIdentityId(request.machineIdentityId);
    if (machineIdentityId !== database.machineIdentityId) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
    const repositoryRequest: ReleaseRuntimeOwnerServiceLeaseRequest = Object.freeze({
      fence: ownerFence(request),
      operation: releaseOperation(machineIdentityId, request),
    });
    try {
      assertReleaseResult(
        machineIdentityId,
        repositoryRequest,
        database.use((current) => current.runtimeOwner.releaseServiceLease(repositoryRequest)),
      );
    } catch (error) {
      if (!(error instanceof HostStateCommitOutcomeUnknownError)) throw error;
      database.reopenAfterUnknownCommit();
      const reconciled = database.use((current) =>
        current.runtimeOwner.reconcileServiceLeaseRelease(repositoryRequest),
      );
      if (reconciled === null) {
        throw new RuntimeOwnerProductionRecoveryError("COMMIT_NOT_RECONCILED", { cause: error });
      }
      assertReleaseResult(machineIdentityId, repositoryRequest, reconciled);
    }
  }
}

interface ProductionRuntimeOwnerLeaseControllerOptions {
  readonly now?: () => number;
}

function createProductionRuntimeOwnerLeaseController(
  options: ProductionRuntimeOwnerLeaseControllerOptions = {},
): RuntimeOwnerLeaseController<ProductionRuntimeOwnerDatabase> {
  return new ProductionRuntimeOwnerLeaseController(options.now ?? Date.now);
}

class ProductionRuntimeOwnerKeyCustodyValidator
  implements RuntimeOwnerKeyCustodyValidator<ProductionRuntimeOwnerDatabase>
{
  validateBeforeWritable(
    database: ProductionRuntimeOwnerDatabase,
    signer: RuntimeOwnerKeyCustodySigningCapability,
  ): void {
    const inventory = database.use((current) => current.runtimeOwner.readInventory());
    const currentIdentityKeys = inventory.identityKeys.filter((key) => key.state === "current");
    const currentPrivateKeys = inventory.privateKeys.filter((key) => key.state === "current");
    if (currentIdentityKeys.length !== currentPrivateKeys.length) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
    const privateKeysByHandle = new Map(
      currentPrivateKeys.map((key) => [key.signingKeyRef.protectedHandleId, key] as const),
    );
    const visitedHandles = new Set<string>();
    for (const identityKey of currentIdentityKeys) {
      const signingKeyRef = identityKey.signingKeyRef;
      if (identityKey.algorithm !== "Ed25519" || signingKeyRef === null) {
        throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
      }
      const privateKey = privateKeysByHandle.get(signingKeyRef.protectedHandleId);
      if (
        privateKey === undefined ||
        privateKey.destroyedAtMs !== null ||
        privateKey.runtimeId !== identityKey.runtimeId ||
        privateKey.runtimeOwnerIdentityKeyId !== identityKey.runtimeOwnerIdentityKeyId ||
        privateKey.keyGeneration !== identityKey.keyGeneration ||
        privateKey.signingKeyRef.protectedHandleId !== signingKeyRef.protectedHandleId ||
        privateKey.signingKeyRef.kind !== "signing_key"
      ) {
        throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
      }
      const envelope: WrappedRuntimeOwnerPrivateKey = Object.freeze({
        wrappingSchemaId: RUNTIME_OWNER_KEY_WRAP_SCHEMA_ID,
        binding: Object.freeze({
          runtimeId: identityKey.runtimeId,
          runtimeOwnerIdentityKeyId: identityKey.runtimeOwnerIdentityKeyId,
          keyGeneration: identityKey.keyGeneration,
          publicKey: identityKey.publicKey,
        }),
        wrapNonce: privateKey.wrapNonce,
        wrappedPkcs8: privateKey.wrappedPkcs8,
        authTag: privateKey.authTag,
        pkcs8Digest: privateKey.pkcs8Digest,
      });
      signer.assertUsable(envelope);
      visitedHandles.add(signingKeyRef.protectedHandleId);
    }
    if (visitedHandles.size !== currentPrivateKeys.length) {
      throw new RuntimeOwnerProductionRecoveryError("RESULT_MISMATCH");
    }
  }
}

function createProductionRuntimeOwnerKeyCustodyValidator(): RuntimeOwnerKeyCustodyValidator<ProductionRuntimeOwnerDatabase> {
  return new ProductionRuntimeOwnerKeyCustodyValidator();
}

export interface StartProductionRuntimeOwnerDaemonOptions {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
}

export async function startProductionRuntimeOwnerDaemon(
  options: StartProductionRuntimeOwnerDaemonOptions,
): Promise<RuntimeOwnerDaemon> {
  const secret = Uint8Array.from(options.identitySecret);
  try {
    await assertSecretMatchesMachineIdentity(options.machineIdentityId, secret);
    return await startRuntimeOwnerDaemon({
      service: {
        machineIdentityId: parseMachineIdentityId(options.machineIdentityId),
        identitySecret: secret,
        databaseFactory: createProductionRuntimeOwnerDatabaseFactory(),
        leaseController: createProductionRuntimeOwnerLeaseController(),
        keyCustodyValidator: createProductionRuntimeOwnerKeyCustodyValidator(),
      },
    });
  } finally {
    secret.fill(0);
  }
}

/** Copy only non-secret process-location state into the independently supervised daemon. */
export function sanitizedRuntimeOwnerDaemonEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return Object.freeze(result);
}

interface DetachedChild {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "spawn", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "spawn", listener: () => void): this;
  unref(): void;
}

type SpawnDetachedProcess = (
  executable: string,
  argv: readonly string[],
  options: Readonly<{
    detached: true;
    stdio: "ignore";
    env: NodeJS.ProcessEnv;
    cwd: string;
  }>,
) => DetachedChild;

export interface CreateRuntimeOwnerDetachedSpawnerOptions {
  readonly secretFilePath: string;
  readonly executablePath?: string;
  readonly executableArgv?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly productionModuleUrl?: string;
  readonly spawnProcess?: SpawnDetachedProcess;
}

function runtimeOwnerCliEntry(moduleUrl: string): string {
  const extension = moduleUrl.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`../../runtime-owner-cli.${extension}`, moduleUrl));
}

function trustedTsxLoaderDirectory(option: "--import" | "--require", value: string): string | null {
  if (value.includes("\0")) return null;
  let path: string;
  try {
    path = value.startsWith("file:") ? fileURLToPath(value) : value;
  } catch {
    return null;
  }
  if (!isAbsolute(path) || !path.includes("/node_modules/")) return null;
  const basename = option === "--require" ? "preflight.cjs" : "loader.mjs";
  if (!path.endsWith(`/tsx/dist/${basename}`)) return null;
  return dirname(path);
}

/**
 * Node's exec argv can contain debug listeners, eval snippets, test runners, env files, and other
 * active behavior. A source checkout needs only tsx's already-loaded absolute loader pair; a built
 * JavaScript entry needs none of the parent's process flags.
 */
export function sanitizedRuntimeOwnerExecutableArgv(
  source: readonly string[],
  sourceEntry: boolean,
): readonly string[] {
  if (!sourceEntry) return Object.freeze([]);
  const preflights: Array<Readonly<{ value: string; directory: string }>> = [];
  const loaders: Array<Readonly<{ value: string; directory: string }>> = [];
  for (let index = 0; index < source.length; index++) {
    const option = source[index];
    if (option !== "--import" && option !== "--require") continue;
    const value = source[index + 1];
    if (value === undefined) continue;
    index += 1;
    const directory = trustedTsxLoaderDirectory(option, value);
    if (directory === null) continue;
    (option === "--require" ? preflights : loaders).push(Object.freeze({ value, directory }));
  }
  for (const preflight of preflights) {
    const loader = loaders.find((candidate) => candidate.directory === preflight.directory);
    if (loader !== undefined) {
      return Object.freeze(["--require", preflight.value, "--import", loader.value]);
    }
  }
  return Object.freeze([]);
}

/** Build a bootstrap callback without ever putting the root-secret bytes or token in child state. */
export function createRuntimeOwnerDetachedSpawner(
  options: CreateRuntimeOwnerDetachedSpawnerOptions,
): (request: RuntimeOwnerDetachedSpawnRequest) => Promise<void> {
  if (!isAbsolute(options.secretFilePath) || options.secretFilePath.includes("\0")) {
    throw new TypeError("runtime-owner secret file path must be absolute");
  }
  const executablePath = options.executablePath ?? process.execPath;
  const environment = sanitizedRuntimeOwnerDaemonEnvironment(options.environment ?? process.env);
  const productionModuleUrl = options.productionModuleUrl ?? import.meta.url;
  const entry = runtimeOwnerCliEntry(productionModuleUrl);
  const executableArgv = sanitizedRuntimeOwnerExecutableArgv(
    options.executableArgv ?? process.execArgv,
    productionModuleUrl.endsWith(".ts"),
  );
  const spawnProcess = options.spawnProcess ?? (nodeSpawn as unknown as SpawnDetachedProcess);
  return async (request: RuntimeOwnerDetachedSpawnRequest): Promise<void> => {
    const machineIdentityId = parseMachineIdentityId(request.machineIdentityId);
    if (request.detached !== true) throw new TypeError("runtime-owner child must be detached");
    const argv = Object.freeze([
      ...executableArgv,
      entry,
      "--machine-identity",
      machineIdentityId,
      "--secret-file",
      options.secretFilePath,
    ]);
    await new Promise<void>((resolve, reject) => {
      let child: DetachedChild;
      try {
        child = spawnProcess(executablePath, argv, {
          detached: true,
          stdio: "ignore",
          env: environment,
          // The daemon is machine-scoped. Never let a project-controlled cwd/tsconfig influence
          // tsx loader resolution before the daemon has authenticated or opened its secret file.
          cwd: dirname(entry),
        });
      } catch (error) {
        reject(error);
        return;
      }
      const onError = (error: Error): void => {
        child.removeListener("spawn", onSpawn);
        reject(error);
      };
      const onSpawn = (): void => {
        child.removeListener("error", onError);
        child.unref();
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
  };
}

export interface BootstrapProductionRuntimeOwnerOptions {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
  readonly secretPath: string;
}

/** Closed wrapper-facing seam: no database, lease, custody, or process handle escapes it. */
export async function bootstrapProductionRuntimeOwner(
  options: BootstrapProductionRuntimeOwnerOptions,
): Promise<RuntimeOwnerRpcClient | null> {
  const secret = Uint8Array.from(options.identitySecret);
  try {
    await assertSecretMatchesMachineIdentity(options.machineIdentityId, secret);
    const result = await bootstrapRuntimeOwner({
      machineIdentityId: parseMachineIdentityId(options.machineIdentityId),
      identitySecret: secret,
      spawnDetached: createRuntimeOwnerDetachedSpawner({
        secretFilePath: options.secretPath,
      }),
    });
    return result.status === "connected" ? result.client : null;
  } finally {
    secret.fill(0);
  }
}
