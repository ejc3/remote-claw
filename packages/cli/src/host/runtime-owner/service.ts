import { createHash, randomBytes } from "node:crypto";
import { base64urlDecode, base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import {
  createRuntimeOwnerKeyCustodySigner,
  type RuntimeOwnerKeyCustodySigner,
  type RuntimeOwnerKeyCustodySigningCapability,
} from "./key-custody.js";
import type { RuntimeOwnerRpcDispatchRequest, RuntimeOwnerRpcJsonValue } from "./protocol.js";
import { RuntimeOwnerRpcError } from "./protocol.js";
import {
  type RuntimeOwnerRpcHandler,
  type RuntimeOwnerRpcRequestContext,
  type StartRuntimeOwnerRpcServerOptions,
  startRuntimeOwnerRpcServer,
} from "./server.js";

const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;
const OPERATION_NAME = /^[a-z][a-z0-9_.:-]{0,127}$/;
const DEFAULT_LEASE_DURATION_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export const RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID =
  "remote-claw/linux-process-start-identity/v1" as const;

type MaybePromise<T> = T | Promise<T>;

export interface RuntimeOwnerHostStateDatabase {
  close(): MaybePromise<void>;
}

export interface HostStateDatabaseFactory<Database extends RuntimeOwnerHostStateDatabase> {
  open(machineIdentityId: string): MaybePromise<Database>;
}

/** Trusted local gate receives only closed signing operations, never root or wrap-key bytes. */
export interface RuntimeOwnerKeyCustodyValidator<Database extends RuntimeOwnerHostStateDatabase> {
  validateBeforeWritable(
    database: Database,
    signer: RuntimeOwnerKeyCustodySigningCapability,
  ): MaybePromise<void>;
}

export interface RuntimeOwnerLease {
  readonly machineIdentityId: string;
  readonly runtimeOwnerServiceLeaseId: string;
  readonly runtimeOwnerServiceEpoch: number;
  readonly ownerInstanceId: string;
  readonly ownerStartIdentitySchemaId: typeof RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID;
  readonly ownerStartIdentityRef: string;
  readonly ownerStartIdentityDigest: string;
  readonly heartbeatDeadlineMs: number;
}

export interface RuntimeOwnerLeaseAcquireRequest {
  readonly machineIdentityId: string;
  readonly candidateLeaseId: string;
  readonly ownerInstanceId: string;
  readonly ownerStartIdentitySchemaId: typeof RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID;
  readonly ownerStartIdentityRef: string;
  readonly ownerStartIdentityDigest: string;
  readonly leaseDurationMs: number;
}

export interface RuntimeOwnerProcessStartIdentity {
  readonly schemaId: typeof RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID;
  readonly machineIdentityId: string;
  readonly bootId: string;
  readonly pid: number;
  readonly processStartTimeTicks: number;
  readonly canonicalDigest: string;
  readonly ownerInstanceId: string;
  readonly ownerStartIdentityRef: string;
}

export interface RuntimeOwnerLeaseHeartbeatRequest extends RuntimeOwnerLease {
  readonly expectedHeartbeatDeadlineMs: number;
  readonly leaseDurationMs: number;
}

export interface RuntimeOwnerLeaseReleaseRequest {
  readonly machineIdentityId: string;
  readonly runtimeOwnerServiceLeaseId: string;
  readonly runtimeOwnerServiceEpoch: number;
  readonly ownerInstanceId: string;
  readonly ownerStartIdentitySchemaId: typeof RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID;
  readonly ownerStartIdentityRef: string;
  readonly ownerStartIdentityDigest: string;
}

/**
 * The concrete repository must compare the exact lease ID and epoch in the same transaction as each
 * mutation. These methods also own lost-COMMIT reconciliation; callers never blindly retry a write.
 */
export interface RuntimeOwnerLeaseController<Database extends RuntimeOwnerHostStateDatabase> {
  acquireOrReconcile(
    database: Database,
    request: RuntimeOwnerLeaseAcquireRequest,
  ): MaybePromise<RuntimeOwnerLease>;
  heartbeatOrReconcile(
    database: Database,
    request: RuntimeOwnerLeaseHeartbeatRequest,
  ): MaybePromise<RuntimeOwnerLease>;
  releaseOrReconcile(
    database: Database,
    request: RuntimeOwnerLeaseReleaseRequest,
  ): MaybePromise<void>;
}

export interface RuntimeOwnerOperationContext {
  readonly lease: RuntimeOwnerLease;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly custodySigner: RuntimeOwnerKeyCustodySigningCapability;
  /** Recheck immediately before handing the exact fence to a repository mutation. */
  assertCurrent(): RuntimeOwnerLease;
}

export interface RuntimeOwnerOperationDefinition {
  readonly name: string;
  readonly execute: (
    payload: RuntimeOwnerRpcJsonValue,
    context: RuntimeOwnerOperationContext,
  ) => Promise<RuntimeOwnerRpcJsonValue>;
}

interface ActiveRuntimeOwnerOperation {
  readonly abortController: AbortController;
  readonly completed: Promise<void>;
  readonly complete: () => void;
}

export interface StartRuntimeOwnerServiceOptions<
  Database extends RuntimeOwnerHostStateDatabase = RuntimeOwnerHostStateDatabase,
> {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
  readonly databaseFactory: HostStateDatabaseFactory<Database>;
  readonly leaseController: RuntimeOwnerLeaseController<Database>;
  readonly keyCustodyValidator: RuntimeOwnerKeyCustodyValidator<Database>;
  readonly ownerIdentity: RuntimeOwnerProcessStartIdentity;
  readonly operations?: readonly RuntimeOwnerOperationDefinition[];
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly rpcHandshakeTimeoutMs?: number;
  readonly rpcRequestTimeoutMs?: number;
  readonly rpcMaxInFlight?: number;
  readonly startRpcServer?: (
    options: StartRuntimeOwnerRpcServerOptions,
  ) => Promise<RuntimeOwnerRpcServerHandle>;
  readonly createCustodySigner?: (rootSecret: Uint8Array) => RuntimeOwnerKeyCustodySigner;
  readonly now?: () => number;
}

export interface RuntimeOwnerRpcServerHandle {
  readonly listening: boolean;
  close(): Promise<void>;
}

export type RuntimeOwnerServiceState = "starting" | "running" | "stopping" | "poisoned" | "stopped";

export class RuntimeOwnerServiceLifecycleError extends Error {
  readonly code: "INVALID_CONFIGURATION" | "UNAVAILABLE" | "LEASE_LOST" | "SHUTDOWN_FAILED";

  constructor(code: "INVALID_CONFIGURATION" | "UNAVAILABLE" | "LEASE_LOST" | "SHUTDOWN_FAILED") {
    const messages = {
      INVALID_CONFIGURATION: "runtime owner configuration is invalid",
      UNAVAILABLE: "runtime owner service is unavailable",
      LEASE_LOST: "runtime owner lease was lost",
      SHUTDOWN_FAILED: "runtime owner shutdown did not complete cleanly",
    } as const;
    super(messages[code]);
    this.name = "RuntimeOwnerServiceLifecycleError";
    this.code = code;
  }
}

function safeInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
  }
  return selected;
}

function machineIdentity(value: string): string {
  if (!MACHINE_IDENTITY.test(value)) {
    throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
  }
  return value;
}

function safeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
  }
  return value as number;
}

function canonicalDigest(value: unknown): string {
  if (typeof value !== "string") throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
  try {
    const bytes = base64urlDecode(value);
    if (bytes.length !== 32 || base64urlEncode(bytes) !== value) {
      throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
    }
    return value;
  } catch (error) {
    if (error instanceof RuntimeOwnerServiceLifecycleError) throw error;
    throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
  }
}

function processStartIdentitySchema(
  value: unknown,
): typeof RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID {
  if (value !== RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID) {
    throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
  }
  return value;
}

function canonicalLease(value: RuntimeOwnerLease): RuntimeOwnerLease {
  return Object.freeze({
    machineIdentityId: machineIdentity(value.machineIdentityId),
    runtimeOwnerServiceLeaseId: safeId(value.runtimeOwnerServiceLeaseId),
    runtimeOwnerServiceEpoch: positiveInteger(value.runtimeOwnerServiceEpoch),
    ownerInstanceId: safeId(value.ownerInstanceId),
    ownerStartIdentitySchemaId: processStartIdentitySchema(value.ownerStartIdentitySchemaId),
    ownerStartIdentityRef: safeId(value.ownerStartIdentityRef),
    ownerStartIdentityDigest: canonicalDigest(value.ownerStartIdentityDigest),
    heartbeatDeadlineMs: positiveInteger(value.heartbeatDeadlineMs),
  });
}

function exactSameLease(
  expected: RuntimeOwnerLease,
  actualValue: RuntimeOwnerLease,
): RuntimeOwnerLease {
  const actual = canonicalLease(actualValue);
  if (
    actual.machineIdentityId !== expected.machineIdentityId ||
    actual.runtimeOwnerServiceLeaseId !== expected.runtimeOwnerServiceLeaseId ||
    actual.runtimeOwnerServiceEpoch !== expected.runtimeOwnerServiceEpoch ||
    actual.ownerInstanceId !== expected.ownerInstanceId ||
    actual.ownerStartIdentitySchemaId !== expected.ownerStartIdentitySchemaId ||
    actual.ownerStartIdentityRef !== expected.ownerStartIdentityRef ||
    actual.ownerStartIdentityDigest !== expected.ownerStartIdentityDigest
  ) {
    throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
  }
  return actual;
}

function operationMap(
  definitions: readonly RuntimeOwnerOperationDefinition[] | undefined,
): ReadonlyMap<string, RuntimeOwnerOperationDefinition["execute"]> {
  const result = new Map<string, RuntimeOwnerOperationDefinition["execute"]>();
  for (const definition of definitions ?? []) {
    if (
      typeof definition !== "object" ||
      definition === null ||
      typeof definition.name !== "string" ||
      !OPERATION_NAME.test(definition.name) ||
      typeof definition.execute !== "function" ||
      result.has(definition.name)
    ) {
      throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
    }
    result.set(definition.name, definition.execute);
  }
  return result;
}

function randomSafeId(prefix: string): string {
  return `${prefix}${base64urlEncode(randomBytes(16))}`;
}

function processIdentity(
  value: RuntimeOwnerProcessStartIdentity,
): RuntimeOwnerProcessStartIdentity {
  const identity = machineIdentity(value.machineIdentityId);
  if (
    value.schemaId !== RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.bootId) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isSafeInteger(value.processStartTimeTicks) ||
    value.processStartTimeTicks <= 0
  ) {
    throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
  }
  const writer = new CanonicalWriter();
  writer.str(RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID);
  writer.str(identity);
  writer.str(value.bootId);
  writer.uint(value.pid);
  writer.uint(value.processStartTimeTicks);
  const digest = base64urlEncode(createHash("sha256").update(writer.finish()).digest());
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value.canonicalDigest);
  } catch {
    throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
  }
  if (
    decoded.length !== 32 ||
    base64urlEncode(decoded) !== value.canonicalDigest ||
    value.canonicalDigest !== digest ||
    value.ownerInstanceId !== `roi_${digest}` ||
    value.ownerStartIdentityRef !== value.ownerInstanceId
  ) {
    throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
  }
  return Object.freeze({ ...value });
}

function nowMs(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeOwnerServiceLifecycleError("UNAVAILABLE");
  }
  return value;
}

function signingCapability(
  signer: RuntimeOwnerKeyCustodySigner,
): RuntimeOwnerKeyCustodySigningCapability {
  if (
    typeof signer !== "object" ||
    signer === null ||
    signer.closed ||
    typeof signer.sign !== "function" ||
    typeof signer.assertUsable !== "function" ||
    typeof signer.close !== "function"
  ) {
    throw new RuntimeOwnerServiceLifecycleError("UNAVAILABLE");
  }
  const capability: RuntimeOwnerKeyCustodySigningCapability = {
    sign: (envelope, payload) => signer.sign(envelope, payload),
    assertUsable: (envelope) => signer.assertUsable(envelope),
  };
  return Object.freeze(capability);
}

export class RuntimeOwnerService<
  Database extends RuntimeOwnerHostStateDatabase = RuntimeOwnerHostStateDatabase,
> {
  readonly completed: Promise<void>;
  readonly #machineIdentityId: string;
  readonly #database: Database;
  readonly #leaseController: RuntimeOwnerLeaseController<Database>;
  readonly #operations: ReadonlyMap<string, RuntimeOwnerOperationDefinition["execute"]>;
  readonly #leaseDurationMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #custodySigner: RuntimeOwnerKeyCustodySigner;
  readonly #custodySigningCapability: RuntimeOwnerKeyCustodySigningCapability;
  readonly #now: () => number;
  readonly #activeOperations = new Set<ActiveRuntimeOwnerOperation>();
  #lease: RuntimeOwnerLease;
  #rpcServer: RuntimeOwnerRpcServerHandle | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #leaseExpiryTimer: NodeJS.Timeout | undefined;
  #heartbeatPromise: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #leaseLost = false;
  #state: RuntimeOwnerServiceState = "starting";
  readonly #resolveCompleted: () => void;

  private constructor(
    options: StartRuntimeOwnerServiceOptions<Database>,
    database: Database,
    lease: RuntimeOwnerLease,
    operations: ReadonlyMap<string, RuntimeOwnerOperationDefinition["execute"]>,
    custodySigner: RuntimeOwnerKeyCustodySigner,
    custodySigningCapability: RuntimeOwnerKeyCustodySigningCapability,
    leaseDurationMs: number,
    heartbeatIntervalMs: number,
  ) {
    let resolveCompleted: (() => void) | undefined;
    this.completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    if (resolveCompleted === undefined) {
      throw new RuntimeOwnerServiceLifecycleError("UNAVAILABLE");
    }
    this.#resolveCompleted = resolveCompleted;
    this.#machineIdentityId = options.machineIdentityId;
    this.#database = database;
    this.#leaseController = options.leaseController;
    this.#operations = operations;
    this.#custodySigner = custodySigner;
    this.#custodySigningCapability = custodySigningCapability;
    this.#lease = lease;
    this.#leaseDurationMs = leaseDurationMs;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#now = options.now ?? Date.now;
  }

  static async start<Database extends RuntimeOwnerHostStateDatabase>(
    options: StartRuntimeOwnerServiceOptions<Database>,
  ): Promise<RuntimeOwnerService<Database>> {
    const identity = machineIdentity(options.machineIdentityId);
    const ownerIdentity = processIdentity(options.ownerIdentity);
    if (ownerIdentity.machineIdentityId !== identity) {
      throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
    }
    const leaseDurationMs = safeInteger(
      options.leaseDurationMs,
      DEFAULT_LEASE_DURATION_MS,
      300_000,
    );
    const heartbeatIntervalMs = safeInteger(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      300_000,
    );
    if (heartbeatIntervalMs >= leaseDurationMs) {
      throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
    }
    const operations = operationMap(options.operations);
    if (!(options.identitySecret instanceof Uint8Array) || options.identitySecret.length !== 32) {
      throw new RuntimeOwnerServiceLifecycleError("INVALID_CONFIGURATION");
    }
    const secret = Uint8Array.from(options.identitySecret);
    let database: Database | undefined;
    let lease: RuntimeOwnerLease | undefined;
    let service: RuntimeOwnerService<Database> | undefined;
    let custodySigner: RuntimeOwnerKeyCustodySigner | undefined;
    try {
      database = await options.databaseFactory.open(identity);
      const candidateLeaseId = randomSafeId("rosl_");
      const ownerInstanceId = ownerIdentity.ownerInstanceId;
      const acquired = canonicalLease(
        await options.leaseController.acquireOrReconcile(database, {
          machineIdentityId: identity,
          candidateLeaseId,
          ownerInstanceId,
          ownerStartIdentitySchemaId: ownerIdentity.schemaId,
          ownerStartIdentityRef: ownerIdentity.ownerStartIdentityRef,
          ownerStartIdentityDigest: ownerIdentity.canonicalDigest,
          leaseDurationMs,
        }),
      );
      if (
        acquired.machineIdentityId !== identity ||
        acquired.runtimeOwnerServiceLeaseId !== candidateLeaseId ||
        acquired.ownerInstanceId !== ownerInstanceId ||
        acquired.ownerStartIdentitySchemaId !== ownerIdentity.schemaId ||
        acquired.ownerStartIdentityRef !== ownerIdentity.ownerStartIdentityRef ||
        acquired.ownerStartIdentityDigest !== ownerIdentity.canonicalDigest
      ) {
        throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
      }
      // Only an exact candidate match is safe for startup cleanup. A mismatched result could be a
      // live incumbent and must never be released by this contender.
      lease = acquired;
      if (lease.heartbeatDeadlineMs <= nowMs(options.now ?? Date.now)) {
        throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
      }
      const createCustodySigner = options.createCustodySigner ?? createRuntimeOwnerKeyCustodySigner;
      custodySigner = createCustodySigner(secret);
      const custodySigningCapability = signingCapability(custodySigner);
      await options.keyCustodyValidator.validateBeforeWritable(database, custodySigningCapability);
      if (custodySigner.closed) throw new RuntimeOwnerServiceLifecycleError("UNAVAILABLE");
      service = new RuntimeOwnerService(
        options,
        database,
        lease,
        operations,
        custodySigner,
        custodySigningCapability,
        leaseDurationMs,
        heartbeatIntervalMs,
      );
      const rpcOptions = {
        machineIdentityId: identity,
        identitySecret: secret,
        handler: service.#rpcHandler(),
        ...(options.rpcHandshakeTimeoutMs === undefined
          ? {}
          : { handshakeTimeoutMs: options.rpcHandshakeTimeoutMs }),
        ...(options.rpcRequestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.rpcRequestTimeoutMs }),
        ...(options.rpcMaxInFlight === undefined ? {} : { maxInFlight: options.rpcMaxInFlight }),
      };
      const startRpcServer = options.startRpcServer ?? startRuntimeOwnerRpcServer;
      service.#rpcServer = await startRpcServer(rpcOptions);
      if (!service.#rpcServer.listening) {
        throw new RuntimeOwnerServiceLifecycleError("UNAVAILABLE");
      }
      // Arm lease expiry before making the handler writable. Authenticated clients that race the
      // bind see a closed service state until both the listener and watchdog are ready.
      service.#scheduleHeartbeat(true);
      service.#state = "running";
      return service;
    } catch {
      if (service !== undefined) {
        try {
          await service.#rpcServer?.close();
        } catch {
          // Startup still returns one fixed unavailable error.
        }
      }
      try {
        custodySigner?.close();
      } catch {
        // Startup still returns one fixed unavailable error.
      }
      if (database !== undefined) {
        if (lease !== undefined) {
          try {
            await options.leaseController.releaseOrReconcile(database, {
              machineIdentityId: lease.machineIdentityId,
              runtimeOwnerServiceLeaseId: lease.runtimeOwnerServiceLeaseId,
              runtimeOwnerServiceEpoch: lease.runtimeOwnerServiceEpoch,
              ownerInstanceId: lease.ownerInstanceId,
              ownerStartIdentitySchemaId: lease.ownerStartIdentitySchemaId,
              ownerStartIdentityRef: lease.ownerStartIdentityRef,
              ownerStartIdentityDigest: lease.ownerStartIdentityDigest,
            });
          } catch {
            // Cleanup never guesses another owner's lease or exposes its error text.
          }
        }
        try {
          await database.close();
        } catch {
          // The fixed unavailable result remains the only startup surface.
        }
      }
      throw new RuntimeOwnerServiceLifecycleError("UNAVAILABLE");
    } finally {
      secret.fill(0);
    }
  }

  get state(): RuntimeOwnerServiceState {
    return this.#state;
  }

  get lease(): RuntimeOwnerLease {
    return this.#lease;
  }

  stop(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    if (this.#state === "stopped") return Promise.resolve();
    this.#state = "stopping";
    this.#shutdownPromise = this.#shutdown(true);
    return this.#shutdownPromise;
  }

  #rpcHandler(): RuntimeOwnerRpcHandler {
    return {
      health: async (context) => this.#health(context),
      dispatch: async (request, context) => this.#dispatch(request, context),
      detach: () => {
        // Losing an RPC collaborator never terminates a runtime or releases the service lease.
      },
    };
  }

  async #health(_context: RuntimeOwnerRpcRequestContext): Promise<RuntimeOwnerRpcJsonValue> {
    const lease = this.#assertCurrent();
    return {
      status: "ok",
      machineIdentityId: this.#machineIdentityId,
      runtimeOwnerServiceLeaseId: lease.runtimeOwnerServiceLeaseId,
      runtimeOwnerServiceEpoch: lease.runtimeOwnerServiceEpoch,
      heartbeatDeadlineMs: lease.heartbeatDeadlineMs,
      ownerOperationsWritable: this.#operations.size > 0,
      nativeRegistrationEnabled: false,
    };
  }

  async #dispatch(
    request: RuntimeOwnerRpcDispatchRequest,
    rpcContext: RuntimeOwnerRpcRequestContext,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    const execute = this.#operations.get(request.operation);
    if (execute === undefined) throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
    const lease = this.#assertCurrent();
    const abortController = new AbortController();
    let complete: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    if (complete === undefined) throw new RuntimeOwnerRpcError("HANDLER_ERROR");
    const activeOperation: ActiveRuntimeOwnerOperation = Object.freeze({
      abortController,
      completed,
      complete,
    });
    const abort = (): void => abortController.abort(new RuntimeOwnerRpcError("CLOSED"));
    if (rpcContext.signal.aborted) abort();
    else rpcContext.signal.addEventListener("abort", abort, { once: true });
    this.#activeOperations.add(activeOperation);
    const context: RuntimeOwnerOperationContext = Object.freeze({
      lease,
      requestId: rpcContext.requestId,
      signal: abortController.signal,
      custodySigner: this.#custodySigningCapability,
      assertCurrent: () => this.#assertExactCurrent(lease),
    });
    try {
      return await execute(request.payload, context);
    } finally {
      rpcContext.signal.removeEventListener("abort", abort);
      this.#activeOperations.delete(activeOperation);
      activeOperation.complete();
    }
  }

  #assertCurrent(): RuntimeOwnerLease {
    if (this.#state !== "running" || this.#leaseLost) {
      throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
    }
    if (this.#custodySigner.closed) {
      this.#beginPoison();
      throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
    }
    let currentTime: number;
    try {
      currentTime = nowMs(this.#now);
    } catch {
      this.#beginPoison();
      throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
    }
    if (this.#lease.heartbeatDeadlineMs <= currentTime) {
      this.#beginPoison();
      throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
    }
    if (this.#rpcServer === undefined || !this.#rpcServer.listening) {
      this.#beginPoison();
      throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
    }
    return this.#lease;
  }

  #assertExactCurrent(expected: RuntimeOwnerLease): RuntimeOwnerLease {
    const current = this.#assertCurrent();
    if (
      current.runtimeOwnerServiceLeaseId !== expected.runtimeOwnerServiceLeaseId ||
      current.runtimeOwnerServiceEpoch !== expected.runtimeOwnerServiceEpoch
    ) {
      throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
    }
    return current;
  }

  #scheduleHeartbeat(allowStarting = false): void {
    if (this.#state !== "running" && !(allowStarting && this.#state === "starting")) return;
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    if (this.#leaseExpiryTimer !== undefined) clearTimeout(this.#leaseExpiryTimer);
    const remaining = this.#lease.heartbeatDeadlineMs - nowMs(this.#now);
    if (remaining <= 1) {
      if (this.#state === "starting") {
        throw new RuntimeOwnerServiceLifecycleError("UNAVAILABLE");
      }
      this.#beginPoison();
      return;
    }
    this.#leaseExpiryTimer = setTimeout(() => {
      this.#leaseExpiryTimer = undefined;
      this.#beginPoison();
    }, remaining);
    this.#leaseExpiryTimer.unref();
    const delay = Math.max(1, Math.min(this.#heartbeatIntervalMs, Math.floor(remaining / 2)));
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = undefined;
      this.#heartbeatPromise = this.#heartbeat();
      void this.#heartbeatPromise.finally(() => {
        this.#heartbeatPromise = undefined;
      });
    }, delay);
    this.#heartbeatTimer.unref();
  }

  async #heartbeat(): Promise<void> {
    if (this.#state !== "running") return;
    if (this.#custodySigner.closed || this.#rpcServer === undefined || !this.#rpcServer.listening) {
      this.#beginPoison();
      return;
    }
    const expected = this.#lease;
    try {
      const renewed = exactSameLease(
        expected,
        await this.#leaseController.heartbeatOrReconcile(this.#database, {
          ...expected,
          expectedHeartbeatDeadlineMs: expected.heartbeatDeadlineMs,
          leaseDurationMs: this.#leaseDurationMs,
        }),
      );
      if (renewed.heartbeatDeadlineMs <= expected.heartbeatDeadlineMs) {
        throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
      }
      if (nowMs(this.#now) >= expected.heartbeatDeadlineMs) {
        throw new RuntimeOwnerServiceLifecycleError("LEASE_LOST");
      }
      this.#lease = renewed;
      if (this.#state === "running") this.#scheduleHeartbeat();
    } catch {
      this.#beginPoison();
    }
  }

  #beginPoison(): void {
    if (this.#state === "stopped" || this.#leaseLost) return;
    this.#leaseLost = true;
    this.#state = "poisoned";
    if (this.#shutdownPromise === undefined) this.#shutdownPromise = this.#shutdown(false);
  }

  async #shutdown(releaseRequested: boolean): Promise<void> {
    if (this.#heartbeatTimer !== undefined) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    if (this.#leaseExpiryTimer !== undefined) {
      clearTimeout(this.#leaseExpiryTimer);
      this.#leaseExpiryTimer = undefined;
    }
    const activeOperations = [...this.#activeOperations];
    const errors: unknown[] = [];
    try {
      await this.#rpcServer?.close();
    } catch (error) {
      errors.push(error);
    }
    for (const operation of activeOperations) {
      operation.abortController.abort(new RuntimeOwnerServiceLifecycleError("LEASE_LOST"));
    }
    try {
      this.#custodySigner.close();
    } catch (error) {
      errors.push(error);
    }
    await Promise.all(activeOperations.map((operation) => operation.completed));
    try {
      await this.#heartbeatPromise;
    } catch (error) {
      errors.push(error);
      this.#leaseLost = true;
    }
    if (releaseRequested && !this.#leaseLost) {
      try {
        await this.#leaseController.releaseOrReconcile(this.#database, {
          machineIdentityId: this.#lease.machineIdentityId,
          runtimeOwnerServiceLeaseId: this.#lease.runtimeOwnerServiceLeaseId,
          runtimeOwnerServiceEpoch: this.#lease.runtimeOwnerServiceEpoch,
          ownerInstanceId: this.#lease.ownerInstanceId,
          ownerStartIdentitySchemaId: this.#lease.ownerStartIdentitySchemaId,
          ownerStartIdentityRef: this.#lease.ownerStartIdentityRef,
          ownerStartIdentityDigest: this.#lease.ownerStartIdentityDigest,
        });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.#database.close();
    } catch (error) {
      errors.push(error);
    }
    this.#state = this.#leaseLost ? "poisoned" : "stopped";
    this.#resolveCompleted();
    if (errors.length > 0) throw new RuntimeOwnerServiceLifecycleError("SHUTDOWN_FAILED");
  }
}

export async function startRuntimeOwnerService<Database extends RuntimeOwnerHostStateDatabase>(
  options: StartRuntimeOwnerServiceOptions<Database>,
): Promise<RuntimeOwnerService<Database>> {
  return RuntimeOwnerService.start(options);
}
