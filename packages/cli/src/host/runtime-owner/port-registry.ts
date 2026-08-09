import { randomBytes as nodeRandomBytes } from "node:crypto";
import { base64urlDecode, base64urlEncode } from "@remote-claw/clawsec";
import {
  type A1SafeId,
  type CollaborationServerId,
  type NativeBindingId,
  type NativeRuntimeId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "../state/ids.js";
import {
  type ProtectedCoordinatorFence,
  type ProtectedHandleRef,
  parseProtectedHandleRef,
} from "../state/protected.js";
import { parseNonEmptyString, parsePositiveSafeInteger } from "../state/validation.js";
import {
  parseRuntimeOwnerRpcPortInvocation,
  RUNTIME_OWNER_RPC_MAX_CONNECTIONS,
  RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION,
  type RuntimeOwnerRpcOwnerFence,
  type RuntimeOwnerRpcPortInvocation,
} from "./protocol.js";

const CONNECTION_ID_BYTES = 16;
const HANDLE_BYTES = 16;
const MAX_HANDLE_ATTEMPTS = 8;
const DEFAULT_MAX_PORTS =
  RUNTIME_OWNER_RPC_MAX_CONNECTIONS * RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION;

type RandomBytes = (byteLength: number) => Uint8Array;

export interface RuntimeOwnerCallablePortRegistration {
  readonly connectionId: string;
  readonly collaborationServerId: CollaborationServerId;
  readonly nativeBindingId: NativeBindingId;
  readonly runtimeId: NativeRuntimeId;
  readonly nativeIncarnation: number;
  readonly attachmentLeaseId: A1SafeId;
  readonly ownerFence: RuntimeOwnerRpcOwnerFence;
  readonly coordinatorFence: ProtectedCoordinatorFence;
  readonly portGeneration: number;
}

export interface RuntimeOwnerCallablePortEntry extends RuntimeOwnerCallablePortRegistration {
  readonly callablePortRef: ProtectedHandleRef<"callable_port">;
}

export interface RuntimeOwnerCallablePortRegistryOptions {
  readonly maxPorts?: number;
  readonly maxPortsPerConnection?: number;
  readonly randomBytes?: RandomBytes;
}

export class RuntimeOwnerCallablePortRegistryError extends Error {
  readonly code: "CONFLICT" | "LIMIT" | "MISMATCH" | "NOT_FOUND" | "UNAVAILABLE";

  constructor(code: "CONFLICT" | "LIMIT" | "MISMATCH" | "NOT_FOUND" | "UNAVAILABLE") {
    super("runtime owner callable port is unavailable");
    this.name = "RuntimeOwnerCallablePortRegistryError";
    this.code = code;
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RuntimeOwnerCallablePortRegistryError("UNAVAILABLE");
  }
  return selected;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function connectionId(value: unknown): string {
  if (typeof value !== "string") throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  try {
    const bytes = base64urlDecode(value);
    if (bytes.byteLength !== CONNECTION_ID_BYTES || base64urlEncode(bytes) !== value) {
      throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
    }
  } catch (error) {
    if (error instanceof RuntimeOwnerCallablePortRegistryError) throw error;
    throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  }
  return value;
}

function ownerFence(value: unknown): RuntimeOwnerRpcOwnerFence {
  const row = exactRecord(value, [
    "ownerInstanceId",
    "ownerProcessStartIdentityDigest",
    "ownerProcessStartIdentityRef",
    "ownerProcessStartIdentitySchemaId",
    "runtimeOwnerServiceEpoch",
    "runtimeOwnerServiceLeaseId",
  ]);
  try {
    return Object.freeze({
      runtimeOwnerServiceLeaseId: parseA1SafeId(row.runtimeOwnerServiceLeaseId),
      runtimeOwnerServiceEpoch: parsePositiveSafeInteger(
        row.runtimeOwnerServiceEpoch,
        "callablePort.ownerFence.runtimeOwnerServiceEpoch",
      ),
      ownerInstanceId: parseA1SafeId(row.ownerInstanceId),
      ownerProcessStartIdentitySchemaId: parseNonEmptyString(
        row.ownerProcessStartIdentitySchemaId,
        "callablePort.ownerFence.ownerProcessStartIdentitySchemaId",
      ),
      ownerProcessStartIdentityRef: parseA1SafeId(row.ownerProcessStartIdentityRef),
      ownerProcessStartIdentityDigest: parseA1Digest(row.ownerProcessStartIdentityDigest),
    });
  } catch {
    throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  }
}

function coordinatorFence(value: unknown): ProtectedCoordinatorFence {
  const row = exactRecord(value, [
    "collaborationServerId",
    "coordinatorEpoch",
    "coordinatorLeaseId",
  ]);
  try {
    return Object.freeze({
      collaborationServerId: parseA1CanonicalId("collaborationServer", row.collaborationServerId),
      coordinatorLeaseId: parseA1CanonicalId("coordinatorLease", row.coordinatorLeaseId),
      coordinatorEpoch: parsePositiveSafeInteger(
        row.coordinatorEpoch,
        "callablePort.coordinatorFence.coordinatorEpoch",
      ),
    });
  } catch {
    throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  }
}

function registration(value: unknown): RuntimeOwnerCallablePortRegistration {
  const row = exactRecord(value, [
    "attachmentLeaseId",
    "collaborationServerId",
    "connectionId",
    "coordinatorFence",
    "nativeBindingId",
    "nativeIncarnation",
    "ownerFence",
    "portGeneration",
    "runtimeId",
  ]);
  try {
    const collaborationServerId = parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
    );
    const parsedCoordinatorFence = coordinatorFence(row.coordinatorFence);
    if (parsedCoordinatorFence.collaborationServerId !== collaborationServerId) {
      throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
    }
    return Object.freeze({
      connectionId: connectionId(row.connectionId),
      collaborationServerId,
      nativeBindingId: parseA1CanonicalId("nativeBinding", row.nativeBindingId),
      runtimeId: parseA1CanonicalId("nativeRuntime", row.runtimeId),
      nativeIncarnation: parsePositiveSafeInteger(
        row.nativeIncarnation,
        "callablePort.nativeIncarnation",
      ),
      attachmentLeaseId: parseA1SafeId(row.attachmentLeaseId),
      ownerFence: ownerFence(row.ownerFence),
      coordinatorFence: parsedCoordinatorFence,
      portGeneration: parsePositiveSafeInteger(row.portGeneration, "callablePort.portGeneration"),
    });
  } catch (error) {
    if (error instanceof RuntimeOwnerCallablePortRegistryError) throw error;
    throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  }
}

function sameOwnerFence(
  left: RuntimeOwnerRpcOwnerFence,
  right: RuntimeOwnerRpcOwnerFence,
): boolean {
  return (
    left.runtimeOwnerServiceLeaseId === right.runtimeOwnerServiceLeaseId &&
    left.runtimeOwnerServiceEpoch === right.runtimeOwnerServiceEpoch &&
    left.ownerInstanceId === right.ownerInstanceId &&
    left.ownerProcessStartIdentitySchemaId === right.ownerProcessStartIdentitySchemaId &&
    left.ownerProcessStartIdentityRef === right.ownerProcessStartIdentityRef &&
    left.ownerProcessStartIdentityDigest === right.ownerProcessStartIdentityDigest
  );
}

function sameCoordinatorFence(
  left: ProtectedCoordinatorFence,
  right: ProtectedCoordinatorFence,
): boolean {
  return (
    left.collaborationServerId === right.collaborationServerId &&
    left.coordinatorLeaseId === right.coordinatorLeaseId &&
    left.coordinatorEpoch === right.coordinatorEpoch
  );
}

function callablePortRef(value: unknown): ProtectedHandleRef<"callable_port"> {
  try {
    const parsed = parseProtectedHandleRef(value);
    if (parsed.kind !== "callable_port") {
      throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
    }
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeOwnerCallablePortRegistryError) throw error;
    throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
  }
}

/**
 * Process-memory authority map. It retains no callback, endpoint, credential, or raw port object.
 * The authenticated RPC server owns the actual reverse channel selected by `connectionId`.
 */
export class RuntimeOwnerCallablePortRegistry {
  readonly #maxPorts: number;
  readonly #maxPortsPerConnection: number;
  readonly #randomBytes: RandomBytes;
  readonly #entries = new Map<string, RuntimeOwnerCallablePortEntry>();
  readonly #handlesByConnection = new Map<string, Set<string>>();
  readonly #handleByBinding = new Map<string, string>();

  constructor(options: RuntimeOwnerCallablePortRegistryOptions = {}) {
    this.#maxPorts = boundedInteger(options.maxPorts, DEFAULT_MAX_PORTS, DEFAULT_MAX_PORTS);
    this.#maxPortsPerConnection = boundedInteger(
      options.maxPortsPerConnection,
      RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION,
      RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION,
    );
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  register(value: RuntimeOwnerCallablePortRegistration): RuntimeOwnerCallablePortEntry {
    const parsed = registration(value);
    if (this.#entries.size >= this.#maxPorts) {
      throw new RuntimeOwnerCallablePortRegistryError("LIMIT");
    }
    const connectionHandles = this.#handlesByConnection.get(parsed.connectionId);
    if ((connectionHandles?.size ?? 0) >= this.#maxPortsPerConnection) {
      throw new RuntimeOwnerCallablePortRegistryError("LIMIT");
    }
    if (this.#handleByBinding.has(parsed.nativeBindingId)) {
      throw new RuntimeOwnerCallablePortRegistryError("CONFLICT");
    }
    let handleId: string | undefined;
    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
      const bytes = this.#randomBytes(HANDLE_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== HANDLE_BYTES) {
        throw new RuntimeOwnerCallablePortRegistryError("UNAVAILABLE");
      }
      const candidate = `rcph_${base64urlEncode(bytes)}`;
      if (!this.#entries.has(candidate)) {
        handleId = candidate;
        break;
      }
    }
    if (handleId === undefined) throw new RuntimeOwnerCallablePortRegistryError("UNAVAILABLE");
    const callablePortRefValue = callablePortRef({
      protectedHandleId: handleId,
      kind: "callable_port",
    });
    const entry = Object.freeze({ ...parsed, callablePortRef: callablePortRefValue });
    this.#entries.set(handleId, entry);
    const handles = connectionHandles ?? new Set<string>();
    handles.add(handleId);
    this.#handlesByConnection.set(parsed.connectionId, handles);
    this.#handleByBinding.set(parsed.nativeBindingId, handleId);
    return entry;
  }

  unregister(connection: string, value: ProtectedHandleRef<"callable_port">): boolean {
    const parsedConnectionId = connectionId(connection);
    const ref = callablePortRef(value);
    const entry = this.#entries.get(ref.protectedHandleId);
    if (entry === undefined) return false;
    if (entry.connectionId !== parsedConnectionId) {
      throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
    }
    this.#drop(entry);
    return true;
  }

  authorize(value: RuntimeOwnerRpcPortInvocation): RuntimeOwnerCallablePortEntry {
    let invocation: RuntimeOwnerRpcPortInvocation;
    try {
      invocation = parseRuntimeOwnerRpcPortInvocation(value);
    } catch {
      throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
    }
    const entry = this.#entries.get(invocation.request.callablePortRef.protectedHandleId);
    if (entry === undefined) throw new RuntimeOwnerCallablePortRegistryError("NOT_FOUND");
    if (
      entry.connectionId !== invocation.connectionId ||
      entry.collaborationServerId !== invocation.request.fence.collaborationServerId ||
      entry.nativeBindingId !== invocation.request.nativeBindingId ||
      invocation.request.scopeKind !== "native_binding" ||
      entry.nativeBindingId !== invocation.request.scopeId ||
      entry.runtimeId !== invocation.request.runtimeId ||
      entry.nativeIncarnation !== invocation.nativeIncarnation ||
      entry.attachmentLeaseId !== invocation.attachmentLeaseId ||
      entry.portGeneration !== invocation.portGeneration ||
      !sameOwnerFence(entry.ownerFence, invocation.ownerFence) ||
      !sameCoordinatorFence(entry.coordinatorFence, invocation.request.fence)
    ) {
      throw new RuntimeOwnerCallablePortRegistryError("MISMATCH");
    }
    return entry;
  }

  dropConnection(connection: string): number {
    const parsedConnectionId = connectionId(connection);
    const handles = this.#handlesByConnection.get(parsedConnectionId);
    if (handles === undefined) return 0;
    const entries = [...handles]
      .map((handle) => this.#entries.get(handle))
      .filter((entry): entry is RuntimeOwnerCallablePortEntry => entry !== undefined);
    for (const entry of entries) this.#drop(entry);
    return entries.length;
  }

  #drop(entry: RuntimeOwnerCallablePortEntry): void {
    this.#entries.delete(entry.callablePortRef.protectedHandleId);
    this.#handleByBinding.delete(entry.nativeBindingId);
    const handles = this.#handlesByConnection.get(entry.connectionId);
    handles?.delete(entry.callablePortRef.protectedHandleId);
    if (handles?.size === 0) this.#handlesByConnection.delete(entry.connectionId);
  }
}
