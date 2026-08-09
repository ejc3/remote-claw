import { base64urlDecode, base64urlEncode } from "@remote-claw/clawsec";

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;
const MAX_SAFE_ID_BYTES = 128;

declare const safeIdBrand: unique symbol;
declare const canonicalIdBrand: unique symbol;
declare const digestBrand: unique symbol;
declare const dispatchAuthorizationBrand: unique symbol;

function frozenCanonicalIdSpec<
  const T extends {
    readonly prefix: string;
    readonly bodyBytes: number;
    readonly allocation: "random" | "derived_sha256";
  },
>(spec: T): Readonly<T> {
  return Object.freeze(spec);
}

/** A selected-A1 identifier safe to place in canonical JSON and length-prefixed encodings. */
export type A1SafeId = string & { readonly [safeIdBrand]: true };

export const A1_CANONICAL_ID_SPECS = Object.freeze({
  collaborationServer: frozenCanonicalIdSpec({
    prefix: "rcs_",
    bodyBytes: 16,
    allocation: "random",
  }),
  project: frozenCanonicalIdSpec({
    prefix: "rcpj_",
    bodyBytes: 16,
    allocation: "random",
  }),
  logicalChat: frozenCanonicalIdSpec({
    prefix: "rcl_",
    bodyBytes: 16,
    allocation: "random",
  }),
  inwardEdge: frozenCanonicalIdSpec({
    prefix: "rcie_",
    bodyBytes: 16,
    allocation: "random",
  }),
  nativeBinding: frozenCanonicalIdSpec({
    prefix: "rcnb_",
    bodyBytes: 16,
    allocation: "random",
  }),
  nativeRuntime: frozenCanonicalIdSpec({
    prefix: "rcrt_",
    bodyBytes: 32,
    allocation: "derived_sha256",
  }),
  coordinatorLease: frozenCanonicalIdSpec({
    prefix: "rccl_",
    bodyBytes: 16,
    allocation: "random",
  }),
  registrationAttempt: frozenCanonicalIdSpec({
    prefix: "rcra_",
    bodyBytes: 16,
    allocation: "random",
  }),
  nativeConversationLease: frozenCanonicalIdSpec({
    prefix: "rcncl_",
    bodyBytes: 16,
    allocation: "random",
  }),
  protectedHandle: frozenCanonicalIdSpec({
    prefix: "rcph_",
    bodyBytes: 16,
    allocation: "random",
  }),
  projectTargetSelectorMapping: frozenCanonicalIdSpec({
    prefix: "ptm_",
    bodyBytes: 32,
    allocation: "derived_sha256",
  }),
  nativeDeliveryAttempt: frozenCanonicalIdSpec({
    prefix: "nat_",
    bodyBytes: 32,
    allocation: "derived_sha256",
  }),
} as const);

export type A1CanonicalIdKind = keyof typeof A1_CANONICAL_ID_SPECS;
export type A1CanonicalId<K extends A1CanonicalIdKind> = A1SafeId & {
  readonly [canonicalIdBrand]: K;
};

export type CollaborationServerId = A1CanonicalId<"collaborationServer">;
export type ProjectId = A1CanonicalId<"project">;
export type LogicalChatId = A1CanonicalId<"logicalChat">;
export type InwardEdgeId = A1CanonicalId<"inwardEdge">;
export type NativeBindingId = A1CanonicalId<"nativeBinding">;
export type NativeRuntimeId = A1CanonicalId<"nativeRuntime">;
export type CoordinatorLeaseId = A1CanonicalId<"coordinatorLease">;
export type RegistrationAttemptId = A1CanonicalId<"registrationAttempt">;
export type NativeConversationLeaseId = A1CanonicalId<"nativeConversationLease">;
export type ProtectedHandleId = A1CanonicalId<"protectedHandle">;
export type ProjectTargetSelectorMappingId = A1CanonicalId<"projectTargetSelectorMapping">;
export type NativeDeliveryAttemptId = A1CanonicalId<"nativeDeliveryAttempt">;

/** Canonical unpadded-base64url SHA-256. */
export type A1Digest = string & { readonly [digestBrand]: true };

/** A one-use 32-byte secret held only by the runtime owner's protected handle service. */
export type DispatchAuthorization = string & {
  readonly [dispatchAuthorizationBrand]: true;
};

export class HostStateContractError extends Error {
  constructor(message: string) {
    super(`host state contract rejected: ${message}`);
    this.name = "HostStateContractError";
  }
}

function reject(field: string, requirement: string): never {
  throw new HostStateContractError(`${field} ${requirement}`);
}

function canonicalBase64urlBytes(value: unknown, bytes: number, field: string): string {
  if (typeof value !== "string") reject(field, "must be a string");
  const encodedLength = Math.ceil((bytes * 4) / 3);
  if (value.length !== encodedLength) {
    reject(field, `must be canonical unpadded base64url of exactly ${bytes} bytes`);
  }
  let decoded: Uint8Array;
  try {
    decoded = base64urlDecode(value);
  } catch {
    reject(field, "must be canonical unpadded base64url");
  }
  if (decoded.length !== bytes || base64urlEncode(decoded) !== value) {
    reject(field, `must be canonical unpadded base64url of exactly ${bytes} bytes`);
  }
  return value;
}

export function parseA1SafeId(value: unknown, field = "id"): A1SafeId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SAFE_ID_BYTES ||
    !SAFE_ID.test(value)
  ) {
    reject(field, "must be 1-128 ASCII bytes matching [A-Za-z0-9._:-]+");
  }
  return value as A1SafeId;
}

export function parseA1CanonicalId<K extends A1CanonicalIdKind>(
  kind: K,
  value: unknown,
  field: string = kind,
): A1CanonicalId<K> {
  const safe = parseA1SafeId(value, field);
  const spec = A1_CANONICAL_ID_SPECS[kind];
  if (!safe.startsWith(spec.prefix)) {
    reject(field, `must use the ${spec.prefix} namespace`);
  }
  canonicalBase64urlBytes(safe.slice(spec.prefix.length), spec.bodyBytes, field);
  return safe as A1CanonicalId<K>;
}

export function parseMachineIdentityId(value: unknown, field = "machineIdentityId"): string {
  if (typeof value !== "string" || !MACHINE_IDENTITY.test(value)) {
    reject(field, "must be exactly 32 lowercase hexadecimal characters");
  }
  return value;
}

export function parseA1Digest(value: unknown, field = "digest"): A1Digest {
  return canonicalBase64urlBytes(value, 32, field) as A1Digest;
}

export function parseDispatchAuthorization(
  value: unknown,
  field = "dispatchAuthorization",
): DispatchAuthorization {
  return canonicalBase64urlBytes(value, 32, field) as DispatchAuthorization;
}

export function isA1SafeId(value: unknown): value is A1SafeId {
  try {
    parseA1SafeId(value);
    return true;
  } catch {
    return false;
  }
}

export function isA1CanonicalId<K extends A1CanonicalIdKind>(
  kind: K,
  value: unknown,
): value is A1CanonicalId<K> {
  try {
    parseA1CanonicalId(kind, value);
    return true;
  } catch {
    return false;
  }
}
