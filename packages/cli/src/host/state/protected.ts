import { canonicalByteSnapshot } from "@remote-claw/clawsec";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  type DispatchAuthorization,
  HostStateContractError,
  type NativeBindingId,
  type NativeDeliveryAttemptId,
  type NativeRuntimeId,
  type ProtectedHandleId,
  parseA1CanonicalId,
} from "./ids.js";
import { frozen, parseEnum, parseExactRecord } from "./validation.js";

export const PROTECTED_HANDLE_KINDS = Object.freeze([
  "artifact",
  "signing_key",
  "provider_credential",
  "callable_port",
  "dispatch_authorization",
] as const);

export type ProtectedHandleKind = (typeof PROTECTED_HANDLE_KINDS)[number];

/**
 * An opaque reference to protected owner state. The conditional form preserves
 * `kind` as a discriminant when the default union is used.
 */
export type ProtectedHandleRef<K extends ProtectedHandleKind = ProtectedHandleKind> =
  K extends ProtectedHandleKind
    ? Readonly<{
        protectedHandleId: ProtectedHandleId;
        kind: K;
      }>
    : never;

const PROTECTED_HANDLE_REF_KEYS = ["protectedHandleId", "kind"] as const;

export function parseProtectedHandleRef(value: unknown): ProtectedHandleRef {
  const ref = parseExactRecord(value, PROTECTED_HANDLE_REF_KEYS, "protectedHandleRef");
  return frozen({
    protectedHandleId: parseA1CanonicalId(
      "protectedHandle",
      ref.protectedHandleId,
      "protectedHandleRef.protectedHandleId",
    ),
    kind: parseEnum(ref.kind, PROTECTED_HANDLE_KINDS, "protectedHandleRef.kind"),
  }) as ProtectedHandleRef;
}

export const PROTECTED_SCOPE_KINDS = Object.freeze([
  "host_profile",
  "collaboration_server",
  "runtime",
  "native_binding",
  "native_attempt",
] as const);

export type ProtectedScopeKind = (typeof PROTECTED_SCOPE_KINDS)[number];

/**
 * A protected scope's identifier is selected by its discriminant. The
 * conditional form distributes when `K` is the default union, so narrowing
 * `scopeKind` also narrows `scopeId`.
 */
export type ProtectedOperationScope<K extends ProtectedScopeKind = ProtectedScopeKind> =
  K extends "host_profile"
    ? Readonly<{ scopeKind: K; scopeId: "default" }>
    : K extends "collaboration_server"
      ? Readonly<{ scopeKind: K; scopeId: CollaborationServerId }>
      : K extends "runtime"
        ? Readonly<{ scopeKind: K; scopeId: NativeRuntimeId }>
        : K extends "native_binding"
          ? Readonly<{ scopeKind: K; scopeId: NativeBindingId }>
          : K extends "native_attempt"
            ? Readonly<{ scopeKind: K; scopeId: NativeDeliveryAttemptId }>
            : never;

export function parseProtectedOperationScope(
  scopeKind: unknown,
  scopeId: unknown,
): ProtectedOperationScope {
  const kind = parseEnum(scopeKind, PROTECTED_SCOPE_KINDS, "protectedOperationScope.scopeKind");
  switch (kind) {
    case "host_profile":
      if (scopeId !== "default") {
        throw new HostStateContractError(
          'protectedOperationScope.scopeId must equal "default" for host_profile',
        );
      }
      return frozen({ scopeKind: kind, scopeId: "default" } as const);
    case "collaboration_server":
      return frozen({
        scopeKind: kind,
        scopeId: parseA1CanonicalId(
          "collaborationServer",
          scopeId,
          "protectedOperationScope.scopeId",
        ),
      });
    case "runtime":
      return frozen({
        scopeKind: kind,
        scopeId: parseA1CanonicalId("nativeRuntime", scopeId, "protectedOperationScope.scopeId"),
      });
    case "native_binding":
      return frozen({
        scopeKind: kind,
        scopeId: parseA1CanonicalId("nativeBinding", scopeId, "protectedOperationScope.scopeId"),
      });
    case "native_attempt":
      return frozen({
        scopeKind: kind,
        scopeId: parseA1CanonicalId(
          "nativeDeliveryAttempt",
          scopeId,
          "protectedOperationScope.scopeId",
        ),
      });
  }
}

/**
 * The coordinator authority checked by a protected operation. It is repeated
 * on the operation request rather than inferred from a current global lease.
 */
export interface ProtectedCoordinatorFence {
  readonly collaborationServerId: CollaborationServerId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
}

/**
 * An immutable byte value crossing the protected-operation boundary.
 *
 * Construction snapshots a genuine Uint8Array into fixed ArrayBuffer storage.
 * The retained bytes are never exposed; every read returns another fixed copy.
 */
export class ProtectedByteSnapshot {
  readonly #snapshot: Uint8Array<ArrayBuffer>;
  #destroyed = false;

  private constructor(value: Uint8Array) {
    this.#snapshot = canonicalByteSnapshot(value);
    Object.freeze(this);
  }

  static from(value: Uint8Array): ProtectedByteSnapshot {
    return new ProtectedByteSnapshot(value);
  }

  get byteLength(): number {
    if (this.#destroyed) throw new TypeError("protected byte snapshot was destroyed");
    return this.#snapshot.byteLength;
  }

  copyBytes(): Uint8Array<ArrayBuffer> {
    if (this.#destroyed) throw new TypeError("protected byte snapshot was destroyed");
    return canonicalByteSnapshot(this.#snapshot);
  }

  /** Erase this private snapshot without mutating the caller-owned source used at construction. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#snapshot.fill(0);
    this.#destroyed = true;
  }
}

export type PutArtifactRequest<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      artifactSchemaId: string;
      artifactDigest: A1Digest;
      artifactBytes: ProtectedByteSnapshot;
    }>;

export type PutArtifactResult<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      artifactRef: ProtectedHandleRef<"artifact">;
      artifactSchemaId: string;
      artifactDigest: A1Digest;
      byteLength: number;
    }>;

export type ReadVerifiedArtifactRequest<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      artifactRef: ProtectedHandleRef<"artifact">;
      artifactSchemaId: string;
      expectedArtifactDigest: A1Digest;
    }>;

export type ReadVerifiedArtifactResult<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      artifactRef: ProtectedHandleRef<"artifact">;
      artifactSchemaId: string;
      artifactDigest: A1Digest;
      artifactBytes: ProtectedByteSnapshot;
    }>;

export type SignReservedRequest<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      signingKeyRef: ProtectedHandleRef<"signing_key">;
      reservationId: A1SafeId;
      signaturePurpose: A1SafeId;
      reservedDigest: A1Digest;
    }>;

export type SignReservedResult<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      signingKeyRef: ProtectedHandleRef<"signing_key">;
      reservationId: A1SafeId;
      signaturePurpose: A1SafeId;
      reservedDigest: A1Digest;
      signature: ProtectedByteSnapshot;
      signatureDigest: A1Digest;
    }>;

/**
 * A credential can be applied only by its selected connector and purpose. The
 * credential value itself is never returned to the caller.
 */
export interface ProviderCredentialUse {
  readonly providerCredentialRef: ProtectedHandleRef<"provider_credential">;
  readonly connectorId: A1SafeId;
  readonly credentialPurpose: A1SafeId;
}

export type InvokePortRequest<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      callablePortRef: ProtectedHandleRef<"callable_port">;
      providerCredential: ProviderCredentialUse | null;
      nativeBindingId: NativeBindingId;
      runtimeId: NativeRuntimeId;
      fence: ProtectedCoordinatorFence;
      operationSchemaId: string;
      operationRef: A1SafeId;
      operationDigest: A1Digest;
    }>;

export type InvokePortResult<K extends ProtectedScopeKind = ProtectedScopeKind> =
  ProtectedOperationScope<K> &
    Readonly<{
      callablePortRef: ProtectedHandleRef<"callable_port">;
      providerCredential: ProviderCredentialUse | null;
      nativeBindingId: NativeBindingId;
      runtimeId: NativeRuntimeId;
      fence: ProtectedCoordinatorFence;
      operationSchemaId: string;
      operationRef: A1SafeId;
      operationDigest: A1Digest;
      resultSchemaId: string;
      resultRef: A1SafeId;
      resultDigest: A1Digest;
    }>;

/**
 * Stable inputs that identify a one-use authorization. The native-attempt
 * scope ID is the attempt ID, so there is no second identity field that can
 * disagree. The coordinator fence is deliberately not part of this immutable
 * identity: every operation supplies and validates the caller's current fence,
 * allowing an exact not-started authorization to survive coordinator failover.
 */
type DispatchAuthorizationIdentity = ProtectedOperationScope<"native_attempt"> &
  Readonly<{
    nativeClientIngressLeaseId: A1SafeId;
    nativeTargetPathDigest: A1Digest;
    canonicalRequestDigest: A1Digest;
    nativeRequestTranslationDigest: A1Digest;
  }>;

type DispatchAuthorizationCall = DispatchAuthorizationIdentity &
  Readonly<{ fence: ProtectedCoordinatorFence }>;

export type ArmDispatchRequest = DispatchAuthorizationCall;

export type ArmDispatchResult = DispatchAuthorizationCall &
  Readonly<{
    dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
    canonicalDispatchDigest: A1Digest;
    state: "armed";
  }>;

type ArmedDispatchAuthorizationIdentity = DispatchAuthorizationIdentity &
  Readonly<{
    dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
    canonicalDispatchDigest: A1Digest;
  }>;

export type ConsumeDispatchRequest = ArmedDispatchAuthorizationIdentity &
  Readonly<{ fence: ProtectedCoordinatorFence; expectedState: "armed" }>;

export type ConsumeDispatchResult = DispatchAuthorizationCall &
  Readonly<{
    dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
    dispatchAuthorizationHandle: DispatchAuthorization;
    canonicalDispatchDigest: A1Digest;
    state: "consumed";
  }>;

export type RevokeDispatchRequest = ArmedDispatchAuthorizationIdentity &
  Readonly<{ fence: ProtectedCoordinatorFence; expectedState: "armed" }>;

export type RevokeDispatchResult = DispatchAuthorizationCall &
  Readonly<{
    dispatchAuthorizationRef: ProtectedHandleRef<"dispatch_authorization">;
    canonicalDispatchDigest: A1Digest;
    state: "revoked";
  }>;

export interface ProtectedArtifactOperations {
  putArtifact(request: PutArtifactRequest): Promise<PutArtifactResult>;
  readVerifiedArtifact(request: ReadVerifiedArtifactRequest): Promise<ReadVerifiedArtifactResult>;
}

export interface ProtectedSigningOperations {
  signReserved(request: SignReservedRequest): Promise<SignReservedResult>;
}

export interface ProtectedPortOperations {
  invokePort(request: InvokePortRequest): Promise<InvokePortResult>;
}

export interface ProtectedDispatchOperations {
  armDispatch(request: ArmDispatchRequest): Promise<ArmDispatchResult>;
  consumeDispatch(request: ConsumeDispatchRequest): Promise<ConsumeDispatchResult>;
  revokeDispatch(request: RevokeDispatchRequest): Promise<RevokeDispatchResult>;
}

/**
 * The complete owner-facing protected surface. In particular it has no
 * resolve/get/read/list/export operation that could reveal opaque values.
 */
export type ProtectedHandleOperations = ProtectedArtifactOperations &
  ProtectedSigningOperations &
  ProtectedPortOperations &
  ProtectedDispatchOperations;
